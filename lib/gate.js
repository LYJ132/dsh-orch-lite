/**
 * Enforcement rules for the orch-lite preset, as pure functions.
 *
 * `lib/index.js` wires these into a `tools/pre-execute` listener. Keeping the
 * decisions pure makes them unit-testable without a harness (see
 * `test/plugin.test.mjs`).
 *
 * The gate defends exactly one thing: a dispatched worker's write area. Under
 * lazy-isolation-off ("S2": every write task owns a work area) every worker
 * lives in `.worktrees/<feature_id>/`, so that path test replaces the whole
 * former state machine — no live-worker registry, no pending slots, no
 * lifecycle listeners, nothing to leak. The coordinator is free to write
 * anywhere else in its own project; that is the point of the preset, not a
 * violation of it.
 *
 * Three rules, in order:
 * - `write`/`edit` into a worker lane is denied; everything else passes;
 * - shell commands with effects outside the repository (push, publish, `gh`)
 *   are denied — those are the user's decisions, and they cannot be undone
 *   locally;
 * - a dispatch package that claims to be an orch-lite feature dispatch (it
 *   carries `feature_id`, or points at the executor handbook) is validated.
 *   Every other dispatch — another skill's subagent call, an ad-hoc child —
 *   passes untouched. The contract is opt-in.
 *
 * Nothing here applies to child agents (they write inside their own area), and
 * nothing here limits delegation depth: that is the Host's `subagent.maxDepth`
 * setting, user-tunable, enforced by the platform at each start attempt.
 */

/** Continuable dispatch tools — the feature-agent lane. */
export const DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork'])

/** File-mutating fs tools. */
export const MAIN_WRITE_TOOLS = new Set(['write', 'edit'])

/** Shell tools. */
export const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** Same slug as the worktree tools: a feature id is one lowercase kebab string. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const FEATURE_FIELDS = ['feature_id', 'objective', 'acceptance_criteria']

const HANDBOOK_POINTER = 'orch-lite-executor'

// A fenced block: ```<lang>\n<content>``` (lang optional, non-greedy to the
// first closing fence). Inline ```spans``` without a newline never match.
const FENCE_RE = /```([A-Za-z0-9_-]*)[ \t]*\r?\n(.*?)```/gs

const SKILL_HINT = 'the orch-lite skill (load it with the skill tool)'

export const WORKER_LANE_REASON = (lane) =>
	'orch-lite gate: ' + lane + ' is a worker lane — a dispatched feature agent owns that directory, and two ' +
	'writers in one work area is the one accident git cannot undo for you. Write anywhere else in the project, or ' +
	'integrate the finished branch with orch_tool({ action: "merge", feature_id }). ' +
	'(A rejection here is a routing hint, not a failure — see ' + SKILL_HINT + '.)'

export const EXTERNAL_EFFECT_REASON = (effect) =>
	`orch-lite gate: this command changes something outside the repository (detected: ${effect}), so it is the ` +
	'user\'s decision and it is not reversible by a local git command. Read-only and in-repo commands pass — ' +
	'including git checkout/merge/commit/branch, which this session may run itself. ' +
	'Hand the push to the user, or dispatch a worker if it is part of a feature. ' +
	'See ' + SKILL_HINT + ' if the lanes are unfamiliar.'

export const LANE_DESTRUCTION_REASON = (lane) =>
	'orch-lite gate: this command mutates a worker lane (' + lane + ') from the shell. ' +
	'A work area belongs to its feature agent until orch_tool({ action: "remove", feature_id }) retires it — ' +
	'that path checks for uncommitted work first, which `rm -rf` does not.'

export const NO_BLOCK_REASON =
	'orch-lite gate: this dispatch carries a feature_id, so it is an orch-lite package and must be machine-readable. ' +
	'Include the ```json fenced package (template in ' + SKILL_HINT + ') and re-send — or drop the feature_id field ' +
	'if this is not a feature dispatch.'

const INVALID_JSON_REASON = 'orch-lite gate: dispatch rejected — the fenced block is not valid JSON.'

const MISSING_FIELD_REASON = (missing) =>
	`orch-lite gate: dispatch package missing required field(s): ${missing.join(', ')}. ` +
	`See the Dispatch Package template in ${SKILL_HINT}.`

const BAD_ID_REASON = (value) =>
	`orch-lite gate: dispatch id must be lowercase kebab-case (e.g. login or fix-login-500), got ${JSON.stringify(value)}.`

const BINDING_REASON = (description, featureId) =>
	`orch-lite gate: subagent description ${JSON.stringify(description)} does not match the package feature_id ` +
	`${JSON.stringify(featureId)}. The one string that names the agent, its branch, and its work area must be ` +
	'verbatim identical everywhere.'

const HANDBOOK_REASON =
	'orch-lite gate: dispatch rejected — the prompt never points the child at its handbook. ' +
	`The first instruction must tell it to load skill ${HANDBOOK_POINTER}.`

const WORKTREE_REQUIRED_REASON = (featureId) =>
	`orch-lite gate: an orch-lite feature package needs a "worktree" field — every write task gets its own work area. ` +
	`Call orch_tool({ action: "create", feature_id: "${featureId}" }) and put the returned path in the package. ` +
	'(Read-only sweeps use the `explore` tool instead, and carry no work area.)'

/**
 * Is this path inside a worker lane, i.e. inside `<cwd>/<worktreesDir>/`?
 *
 * Pure path arithmetic — no filesystem call, so it cannot fail on a sandboxed
 * or unreadable workspace, and no state to consult: under always-worktree the
 * lane directory is worker territory whether or not a worker is currently
 * running.
 *
 * @param {object} input
 * @param {string|undefined} cwd the calling session's working directory
 * @param {string|undefined} filePath the write/edit target, absolute or relative to `cwd`
 * @param {string} worktreesDir the lane directory name (`.worktrees`)
 * @returns {string|null} the matched lane prefix for the deny message, null when allowed
 */
export function workerLane({ cwd, filePath, worktreesDir }) {
	if (typeof filePath !== 'string' || filePath.trim() === '' || typeof cwd !== 'string' || cwd === '') return null
	const normalized = (value) => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
	const base = normalized(cwd)
	const target = normalized(filePath)
	// Absolute outside the session root: not our lane. Relative: resolve against it.
	const relativeToBase = target.startsWith(base + '/') ? target.slice(base.length + 1) : target
	if (relativeToBase.startsWith('..')) return null
	const dir = normalized(worktreesDir)
	if (relativeToBase !== dir && !relativeToBase.startsWith(`${dir}/`)) return null
	return `${base}/${dir}/`
}

/**
 * Whether a shell command reaches outside the repository, or destroys a worker
 * lane. Deliberately tiny: the two things left here are the ones git and a
 * retry cannot take back. Everything else a coordinator shell can do — commit,
 * checkout, merge, install, delete a project file — is recoverable, and is
 * therefore prompt discipline instead of a gate.
 *
 * @param {string} command
 * @param {string} worktreesDir the lane directory name, for the destruction test
 * @returns {string|undefined} a short clause naming the detected effect
 */
export function commandReachesOutside(command, worktreesDir) {
	const text = String(command || '')
	if (text.trim() === '') return undefined

	// `git push` in any flag arrangement; `--force` pushes are the sharp case.
	if (/\bgit\b[^|;&]*?\bpush\b/i.test(text)) return 'git push'
	if (/\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b/i.test(text)) return 'package publish'
	if (/\btwine\s+upload\b/i.test(text)) return 'twine upload'
	if (/\bdocker\s+push\b/i.test(text)) return 'docker push'
	// gh reads (issue list, run view) pass; these three open the repo to others.
	if (new RegExp(String.raw`\bgh\s+(?:pr|release|api)\b`, 'i').test(text)) return 'github write (gh)'

	// Deleting or rewriting inside a worker lane loses uncommitted work — the
	// one accident `git worktree remove` refuses and `rm -rf` does not. Reads of
	// the same directory pass.
	const lane = worktreesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const lanePath = new RegExp(String.raw`(^|[\s'"=/])${lane}[/\\]`, 'i')
	const destructive = /\b(?:rm|rmdir|del|erase|mv|move|cp|copy|tee|touch|chmod|chown)\b|Remove-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Clear-Content|Out-File|New-Item/i
	if (lanePath.test(text) && destructive.test(text)) return 'mutation inside the worker lane'
	// Output redirected into a lane file: the shell form of the `write` the
	// gate already refuses. `2>&1` and redirects into project files pass.
	if (new RegExp(String.raw`>{1,2}\s*['"]?[^|;&\s]*${lane}[/\\]`, 'i').test(text)) return 'redirection into the worker lane'

	return undefined
}

/**
 * Find the dispatch package: the first ```json block, else the first fenced
 * block mentioning feature_id / objective.
 *
 * @param {string} text
 * @returns {string|undefined}
 */
function findDispatchBlock(text) {
	const blocks = [...(text || '').matchAll(FENCE_RE)]
	for (const [, lang, content] of blocks) if (lang.toLowerCase() === 'json') return content
	for (const [, , content] of blocks) if (content.includes('feature_id') || content.includes('objective')) return content
	return undefined
}

/**
 * Parse the fenced package, or `undefined` when the prompt carries none.
 *
 * @param {string} text
 * @returns {{pkg: object|null, error: string}|undefined}
 */
function parsePackage(text) {
	const block = findDispatchBlock(text)
	if (block === undefined) return undefined
	try {
		const parsed = JSON.parse(block)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { pkg: {}, error: '' }
		return { pkg: parsed, error: '' }
	} catch {
		return { pkg: null, error: INVALID_JSON_REASON }
	}
}

/**
 * Validate a feature-agent dispatch from the main session — only when the
 * dispatch opts in by naming a `feature_id` or the executor handbook.
 *
 * @param {unknown} prompt the subagent tool's prompt text
 * @param {unknown} description the subagent tool's description (feature carrier)
 * @returns {{allowed: boolean, reason: string}}
 */
export function evaluateDispatch(prompt, description) {
	const text = typeof prompt === 'string' ? prompt : ''
	const claimsFeature = text.includes('feature_id')
	const claimsHandbook = text.includes(HANDBOOK_POINTER)
	// Not an orch-lite dispatch: another skill's subagent call, an ad-hoc child.
	// The package contract is ours alone, so it constrains nothing here.
	if (!claimsFeature && !claimsHandbook) return { allowed: true, reason: '' }

	const parsed = parsePackage(text)
	if (parsed === undefined) return { allowed: false, reason: NO_BLOCK_REASON }
	if (parsed.pkg === null) return { allowed: false, reason: parsed.error }
	const pkg = parsed.pkg

	const missing = FEATURE_FIELDS.filter(field => !(field in pkg))
	if (missing.length > 0) return { allowed: false, reason: MISSING_FIELD_REASON(missing) }

	if (typeof pkg.feature_id !== 'string' || !SLUG.test(pkg.feature_id)) {
		return { allowed: false, reason: BAD_ID_REASON(String(pkg.feature_id)) }
	}
	// The naming rule the prompt alone cannot enforce: one string, every place.
	if (typeof description === 'string' && description !== '' && description !== pkg.feature_id) {
		return { allowed: false, reason: BINDING_REASON(description, pkg.feature_id) }
	}
	// The child loads its handbook through the skill tool, so the prompt must
	// name the skill.
	if (!claimsHandbook) return { allowed: false, reason: HANDBOOK_REASON }
	// Every write task owns a work area: the field is the contract, and its
	// absence means the agent would write in the primary tree beside someone
	// else's branch. Presence is all this checks — a wrong or missing directory
	// surfaces loudly in the worker's own report.
	if (typeof pkg.worktree !== 'string' || pkg.worktree === '') {
		return { allowed: false, reason: WORKTREE_REQUIRED_REASON(pkg.feature_id) }
	}
	return { allowed: true, reason: '' }
}

/**
 * Classify the calling agent for the gate.
 *
 * @param {object|undefined} header `exec.agent.session.header`
 * @returns {{known: boolean, child: boolean}} `known:false` when the gate
 *   must not act (host-local call without an agent, or a session provably not
 *   bound to the orch-lite preset).
 */
export function classifyAgent(header) {
	if (header === undefined || header === null) return { known: false, child: false }
	if (typeof header.agentPreset === 'string' && header.agentPreset !== 'orch-lite') return { known: false, child: false }
	const child =
		(typeof header.delegationDepth === 'number' && header.delegationDepth >= 1) || Boolean(header.parentSession)
	return { known: true, child }
}
