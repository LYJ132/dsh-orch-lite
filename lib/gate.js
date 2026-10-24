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
 * Five rules, in order:
 * - `write`/`edit` into a worker lane is denied; everything else passes — and
 *   so is the same write reached through git's own verbs (`add`, `commit`,
 *   `checkout`, `reset`, `stash`, `restore`) aimed at a lane;
 * - shell commands with effects outside the repository (push, publish, `gh`)
 *   are denied — those are the user's decisions, and they cannot be undone
 *   locally;
 * - `wait_agent` is denied: it is a Team-only status tool, and the children
 *   this session dispatches are not Team members, so its "no active peer"
 *   answer is about a different population; their settlement notice is the
 *   real signal.
 * - `create_worktree` is denied: the Git Worktrees bundle's one operation is
 *   create, and its create path moves this session's own directory into the
 *   new checkout, which re-roots every later `orch_tool` call.
 * - every `subagent` / `subagent_fork` dispatch carries a fenced-JSON package
 *   (feature_id / objective / acceptance_criteria / worktree + handbook
 *   pointer). The dispatch tool IS the role: a dispatch without a package
 *   means the child has no contract and no write area. `explore` carries no
 *   package — it is read-only, writes nothing, and needs no isolation
 *   workspace.
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

/**
 * Team-composition-only status tools.
 *
 * The desktop profile mounts the Agent Team bundle, which shadows the
 * subagent-control roster with its own and adds `wait_agent`. That tool waits
 * on **Team members**: it is a socket into a different population than the
 * `subagent` / `subagent_fork` children this preset dispatches, so its
 * "no active peer" / "noProgress" answer is true and useless at once — a child
 * that is still working is invisible to it, reads as idle, and gets
 * re-dispatched.
 */
export const TEAM_ONLY_TOOLS = new Set(['wait_agent'])

/**
 * Tools from another bundle that would re-root this session.
 *
 * The desktop profile can mount the optional Git Worktrees bundle
 * (`@deepseek-ai/dsh-experimental-tool-worktree`), which contributes exactly
 * one tool, `create_worktree`. It is create-only — no merge, remove, list or
 * dirty check — and its create path ends with an unconditional change of the
 * session's own working directory into `<root>/.agents/worktrees/<branch>`.
 * A dispatched child inherits the coordinator's directory, so a single call
 * re-roots the whole orchestration: every later `orch_tool` operation resolves
 * the repository from that new checkout, and the preset's lanes silently
 * belong to a tree the session no longer sits in.
 */
export const RELOCATING_TOOLS = new Set(['create_worktree'])

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

export const TEAM_ONLY_TOOL_REASON = (tool) =>
	'orch-lite gate: `' + tool + '` is a Team-composition tool — it waits on Team members, and this session has no ' +
	'Team. Its "no active peer" / "noProgress" answer is true but describes a disjoint population: the children this ' +
	'session dispatches are ordinary subagents, invisible to that roster, so a child that is still working reads as ' +
	'idle and the wait returns at once. The real signal is the platform\'s asynchronous `subagent-settled` notice: ' +
	'dispatch, keep working while the child runs, and let that notice wake you when it lands. ' +
	'(A rejection here is a routing hint, not a failure — see ' + SKILL_HINT + '.)'

export const RELOCATING_TOOL_REASON = (tool) =>
	'orch-lite gate: `' + tool + '` is the Git Worktrees bundle\'s tool ' +
	'(@deepseek-ai/dsh-experimental-tool-worktree), and using it re-roots this session. It is create-only — no ' +
	'merge, remove, list or dirty check — and its create path ends by moving this session\'s own working directory ' +
	'into <root>/.agents/worktrees/<branch>, unconditionally. A dispatched child inherits that directory, so one ' +
	'call and every later orch_tool action resolves the repository from the new checkout: the .worktrees/ areas ' +
	'belong to the coordinator\'s tree, which is no longer where this session sits. ' +
	'Use the preset\'s own route instead — orch_tool({ action: "create", feature_id }) allocates the area ' +
	'without moving the session and returns the absolute path to pass as subagent({ cwd }). ' +
	'(A rejection here is a routing hint, not a failure — see ' + SKILL_HINT + '.)'

export const NO_BLOCK_REASON =
	'orch-lite gate: this dispatch claims the orch-lite contract (it names the executor handbook) but carries no ' +
	'machine-readable package. Include the ```json fenced package with feature_id / objective / ' +
	'acceptance_criteria / worktree (template in ' + SKILL_HINT + '), or drop the handbook pointer if this is not a feature dispatch.'

const INVALID_JSON_REASON = 'orch-lite gate: dispatch rejected — the fenced block is not valid JSON.'

const MISSING_FIELD_REASON = (missing) =>
	`orch-lite gate: dispatch package missing required field(s): ${missing.join(', ')}. ` +
	`See the Dispatch Package template in ${SKILL_HINT}.`

const BAD_ID_REASON = (value) =>
	`orch-lite gate: dispatch id must be lowercase kebab-case (e.g. login or fix-login-500), got ${JSON.stringify(value)}.`

const HANDBOOK_REASON =
	'orch-lite gate: dispatch rejected — the prompt never points the child at its handbook. ' +
	`The first instruction must tell it to load skill ${HANDBOOK_POINTER}.`

const WORKTREE_REQUIRED_REASON = (featureId) =>
	`orch-lite gate: an orch-lite feature package needs a "worktree" field — every write task gets its own work area. ` +
	`Call orch_tool({ action: "create", feature_id: "${featureId}" }) and put the returned path in the package. ` +
	'(Read-only sweeps use the `explore` tool instead, and carry no work area.)'

/**
 * Is this path inside a worker lane, i.e. inside `<repoRoot>/<worktreesDir>/`?
 *
 * Pure path arithmetic — no filesystem call, so it cannot fail on a sandboxed
 * or unreadable workspace, and no state to consult: under always-worktree the
 * lane directory is worker territory whether or not a worker is currently
 * running.
 *
 * Path comparison folds `.` and `..` first, so a lane spelled `./.worktrees/x`
 * or reached through `../.worktrees/x` still lands on the same directory.
 *
 * @param {object} input
 * @param {string|undefined} repoRoot the repository root (from git rev-parse --show-toplevel)
 * @param {string|undefined} filePath the write/edit target, absolute or relative
 * @param {string} worktreesDir the lane directory name (`.worktrees`)
 * @returns {string|null} the matched lane prefix for the deny message, null when allowed
 */
export function workerLane({ repoRoot, filePath, worktreesDir }) {
	if (typeof filePath !== 'string' || filePath.trim() === '' || typeof repoRoot !== 'string' || repoRoot === '') return null
	const base = normalizePath(repoRoot)
	const target = normalizePath(filePath)
	// Absolute under the root: strip the prefix. Otherwise treat it as relative
	// to the root; a `..` that climbs out of the root escapes the lane.
	const relativeToBase = target.startsWith(base + '/') ? target.slice(base.length + 1) : target
	if (relativeToBase === '..' || relativeToBase.startsWith('../')) return null
	const dir = normalizePath(worktreesDir)
	if (relativeToBase !== dir && !relativeToBase.startsWith(`${dir}/`)) return null
	return `${base}/${dir}/`
}

/**
 * Fold a path into one comparable form: forward slashes, no trailing
 * separator, and no `.` or `..` segments. `path.resolve` needs a base for a
 * relative path, so the segments are folded by hand — the same result without
 * touching the filesystem.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizePath(value) {
	const parts = String(value).replace(/[\\/]+/g, '/').split('/')
	const out = []
	for (const part of parts) {
		if (part === '' || part === '.') continue
		if (part === '..') {
			if (out.length > 0) out.pop()
			continue
		}
		out.push(part)
	}
	return out.join('/')
}

/**
 * Whether a shell command reaches outside the repository, or writes into a
 * worker lane. Deliberately tiny: the things left here are the ones git and a
 * retry cannot take back. Everything else a coordinator shell can do — commit,
 * checkout, merge, install, delete a project file — is recoverable, and is
 * therefore prompt discipline instead of a gate. The lane half stays because a
 * work area is the one place where "recoverable" stops being true: an
 * uncommitted worker change has no other copy. That is why the lane half also
 * covers git's write verbs (`add`, `commit`, `checkout`, `reset`, `stash`,
 * `restore`) aimed at a lane — the shell form of the `write` the gate already
 * refuses.
 *
 * @param {string} command
 * @param {string} worktreesDir the lane directory name, for the destruction test
 * @returns {string|undefined} a short clause naming the detected effect
 */
export function commandReachesOutside(command, worktreesDir) {
	const text = String(command || '')
	if (text.trim() === '') return undefined

	// `git push` in any flag arrangement; `--force` pushes are the sharp case.
	// `git stash push` is a local stash and must not read as a remote push, so
	// a `stash` subcommand earlier in the same command is excluded.
	if (/\bgit\b(?![^|;&]*?\bstash\b)[^|;&]*?\bpush\b/i.test(text)) return 'git push'
	if (/\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b/i.test(text)) return 'package publish'
	if (/\btwine\s+upload\b/i.test(text)) return 'twine upload'
	if (/\bdocker\s+push\b/i.test(text)) return 'docker push'
	// gh reads (issue list, run view) pass; these three open the repo to others.
	if (new RegExp(String.raw`\bgh\s+(?:pr|release|api)\b`, 'i').test(text)) return 'github write (gh)'

	// The lane may stand alone (the whole `.worktrees` tree) or be followed by
	// a separator, so the tail is a negative lookahead rather than a required
	// slash — otherwise `rm -rf .worktrees` (the tree itself) reads as a
	// different name and slips through. The prefix class includes `\` so an
	// absolute Windows lane path (`D:\repo\.worktrees\login`) is matched too;
	// without it the natural spelling of a lane escapes every lane rule.
	const lane = worktreesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const lanePath = new RegExp(String.raw`(^|[\s'"=/\\])${lane}(?![A-Za-z0-9_-])`, 'i')

	// A commit message is prose, not a mutation target. Quoted `-m` /
	// `--message` values are dropped before the lane tests, so a commit that
	// *documents* the lane layout (`git commit -m "explain .worktrees"`) is not
	// a commit *into* it. Bare and `--`-separated path arguments stay, because
	// those are what git writes to. The short form may be bundled with other
	// flags (`-qm`, `-am`), which is how this project commits.
	const laneScan = text.replace(/(?:^|\s)(?:--message|-[A-Za-z]*m)\s+(?:"[^"]*"|'[^']*')/gi, ' ')

	// `git worktree remove` and `git worktree prune` aimed at a lane: these
	// mutate the work area from the shell, bypassing the tool's safety checks.
	// `orch_tool remove` uses the same commands and checks for uncommitted work
	// first; reaching them through the shell skips that check — which is the
	// one accident git cannot undo.
	//
	// `prune` names no lane at all (it reaps every stale worktree), so it is
	// refused outright rather than matched against a path.
	if (/\bgit\b[^|;&]*?\bworktree\s+prune\b/i.test(text)) {
		return 'git worktree prune (it reaps work areas without the dirty check)'
	}
	if (lanePath.test(laneScan) && /\bgit\b[^|;&]*?\bworktree\s+remove\b/i.test(text)) {
		return 'git worktree remove inside the worker lane'
	}

	// The same lane, reached around the `write`/`edit` rule with git's own
	// write verbs: `git add`, `commit`, `checkout`, `reset`, `stash` and
	// `restore` rewrite a work area's index or working tree. Run against the
	// coordinator's own project files they are ordinary work and pass; aimed at
	// `.worktrees/<feature_id>/` — named by path, or reached by running from
	// inside the lane with `git -C` — they are the lane write again, through
	// the shell. `git stash list` / `git stash show` only read and pass.
	// `git worktree add` is a different command (it creates an area) and is
	// deliberately not matched here.
	const laneGitWrite =
		/\bgit\b(?![^|;&]*?\bworktree\b)[^|;&]*?\b(?:add|commit|checkout|reset|restore)\b|\bgit\b(?![^|;&]*?\bworktree\b)[^|;&]*?\bstash\b(?!\s+(?:list|show)\b)/i
	if (lanePath.test(laneScan) && laneGitWrite.test(text)) return 'git write inside the worker lane'

	// Deleting or rewriting inside a worker lane loses uncommitted work — the
	// one accident `git worktree remove` refuses and `rm -rf` does not. Reads of
	// the same directory pass.
	const destructive = /\b(?:rm|rmdir|del|erase|mv|move|cp|copy|tee|touch|chmod|chown)\b|Remove-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Clear-Content|Out-File|New-Item/i
	if (lanePath.test(laneScan) && destructive.test(text)) return 'mutation inside the worker lane'
	// Output redirected into a lane file: the shell form of the `write` the
	// gate already refuses. `2>&1` and redirects into project files pass.
	if (new RegExp(String.raw`>{1,2}\s*['"]?[^|;&\s]*${lane}[/\\]`, 'i').test(laneScan)) return 'redirection into the worker lane'

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
 * Validate a feature-agent dispatch from the main session.
 *
 * In a session bound to the `orch-lite` preset every `subagent` / `subagent_fork`
 * dispatch carries a fenced-JSON package: the dispatch tool IS the role, so
 * there is no separate opt-in signal, and a dispatch without a package means
 * the child has no contract and no write area. `explore` carries no package —
 * it is read-only, writes nothing, and needs no isolation workspace.
 *
 * @param {unknown} prompt the subagent tool's prompt text
 * @param {unknown} description the subagent tool's description (display label, not validated)
 * @param {string} [repoRoot] optional repository root to validate the worktree path
 * @returns {{allowed: boolean, reason: string}}
 */
export function evaluateDispatch(prompt, description, repoRoot) {
	const text = typeof prompt === 'string' ? prompt : ''
	const claimsHandbook = text.includes(HANDBOOK_POINTER)

	const parsed = parsePackage(text)
	if (parsed === undefined) return { allowed: false, reason: NO_BLOCK_REASON }
	if (parsed.pkg === null) return { allowed: false, reason: parsed.error }
	const pkg = parsed.pkg

	const missing = FEATURE_FIELDS.filter(field => !(field in pkg))
	if (missing.length > 0) return { allowed: false, reason: MISSING_FIELD_REASON(missing) }

	if (typeof pkg.feature_id !== 'string' || !SLUG.test(pkg.feature_id)) {
		return { allowed: false, reason: BAD_ID_REASON(String(pkg.feature_id)) }
	}
	// The feature_id names the branch, the work area and the tool arguments.
	// The child's display label is deliberately NOT bound to it: continuation
	// is addressed by the platform's durable child id (send_message takes
	// agent_id), and the label never participated in addressing — so the old
	// equality bought nothing for resume while forbidding the label from
	// saying what the agent does. A label that describes its feature is the
	// whole point (list_agents shows it); a slug is not.
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
	// Validate that worktree is the absolute path of the repository's .worktrees/<feature_id> directory.
	if (typeof repoRoot === 'string' && repoRoot !== '') {
		const normalized = (value) => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
		const expected = normalized(`${repoRoot}/.worktrees/${pkg.feature_id}`)
		const provided = normalized(pkg.worktree)
		if (provided !== expected) {
			return { allowed: false, reason: `orch-lite gate: dispatch package "worktree" must be the absolute path of the repository's .worktrees/${pkg.feature_id} directory (expected ${expected}), got ${JSON.stringify(pkg.worktree)}.` }
		}
	}
	return { allowed: true, reason: '' }
}

/**
 * Classify the calling agent for the gate.
 *
 * @param {object|undefined} header `exec.agent.session.header`
 * @param {string|null|undefined} [presetId] the session's CURRENT preset. The
 *   platform says the creation header names the preset a session STARTED with
 *   and a switch during the blank window outlives it, so the `agentPreset`
 *   Session projection is the live answer; the header is the fallback when no
 *   projection service exists.
 * @returns {{known: boolean, child: boolean}} `known:false` when the gate
 *   must not act (host-local call without an agent, or a session provably not
 *   bound to the orch-lite preset).
 */
export function classifyAgent(header, presetId = header?.agentPreset) {
	if (header === undefined || header === null) return { known: false, child: false }
	if (typeof presetId === 'string' && presetId !== 'orch-lite') return { known: false, child: false }
	// `delegationDepth` is the primary signal: the platform stamps it as a
	// number on every agent — 0 for the main session, >= 1 for dispatched
	// workers. `parentSession` is a weaker signal that also matches a Team
	// lead's own header (the Team platform stamps it on the lead too), so it
	// must NOT override a numeric delegationDepth of 0 — otherwise the hint
	// ("you are a dispatched worker") leaks into the coordinator session and
	// the gate silently fail-opens there. Only consult parentSession when
	// delegationDepth is absent at all.
	const depth = header.delegationDepth
	const child =
		(typeof depth === 'number' && depth >= 1) ||
		(depth === undefined && Boolean(header.parentSession))
	return { known: true, child }
}
