/**
 * Enforcement rules for the orch-lite preset, as pure functions.
 *
 * `lib/index.js` wires these into a `tools/pre-execute` listener. Keeping the
 * decisions pure makes them unit-testable without a harness (see
 * `test/plugin.test.mjs`).
 *
 * The gate's core guarantee is asymmetric and deliberate:
 * - the MAIN session of an orch-lite scope may read, talk, integrate, and
 *   dispatch — every file mutation is denied with a routing reason;
 * - a dispatched EXECUTOR may write inside its scope but may never dispatch
 *   further (depth budget 1).
 *
 * Two dispatch lanes with different contracts:
 * - `subagent` / `subagent_fork` (continuable): a FEATURE agent — one live
 *   agent owns one branch and receives work orders for that feature,
 *   including follow-ups via send_message. Package: feature_id / objective /
 *   acceptance_criteria, an optional `worktree` (present whenever another
 *   worker is live — lazy isolation), description bound verbatim to
 *   feature_id, handbook pointer required.
 * - `explore` (one-shot): read-only sweep; returns conclusions as its final
 *   message. Package: objective only, no worktree, an explicit read-only
 *   statement required.
 */

/** Continuable dispatch tools — the feature-agent lane. */
export const DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork'])

/** One-shot read-only dispatch tool. */
export const EXPLORE_TOOL = 'explore'

/** Dispatch-like tools denied to executors. */
export const EXECUTOR_DENIED_TOOLS = new Set(['subagent', 'subagent_fork', 'explore', 'spawn_teammate', 'workflow'])

/** File-mutating fs tools. */
export const MAIN_WRITE_TOOLS = new Set(['write', 'edit'])

/** Shell tools; whether a command mutates is decided by `commandMutates`. */
export const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** Same slug as the worktree tools: a feature id is one lowercase kebab string. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const FEATURE_FIELDS = ['feature_id', 'objective', 'acceptance_criteria']
const EXPLORE_FIELDS = ['objective']

const HANDBOOK_POINTER = 'orch-lite-executor'
const READ_ONLY_MARKER = 'read-only'

// A fenced block: ```<lang>\n<content>``` (lang optional, non-greedy to the
// first closing fence). Inline ```spans``` without a newline never match.
const FENCE_RE = /```([A-Za-z0-9_-]*)[ \t]*\r?\n(.*?)```/gs

const SKILL_HINT = 'the orch-lite skill (load it with the skill tool)'

export const MAIN_WRITE_REASON =
	'orch-lite gate: the main session never writes files — this call was blocked, not failed. ' +
	'Compose a feature-agent dispatch: worktree_create({ feature_id }) first, then ' +
	'subagent({ description: "<feature_id>" }) with the fenced-JSON package (template in ' + SKILL_HINT + '). ' +
	'If a live agent already owns this feature, send_message it a new work order instead.'

export const MAIN_SHELL_REASON = (mutation) =>
	`orch-lite gate: mutating shell commands are dispatch-only in the main session (detected: ${mutation}). ` +
	'Read-only commands (ls, cat, rg, git status/log/diff, ...) pass. ' +
	'Feature work goes to that feature\'s agent; wide read sweeps go to `explore`. ' +
	'See ' + SKILL_HINT + ' if the package format is unfamiliar.'

export const EXECUTOR_DISPATCH_REASON =
	'orch-lite gate: an executor never dispatches further agents or teams — the depth budget is one. ' +
	'If the work needs another function, report DONE or STUCK to the main session with send_message and let it route.'

const NO_BLOCK_REASON =
	'orch-lite gate: dispatch rejected — the prompt carries no ```json fenced package. ' +
	'Include one (template in ' + SKILL_HINT + ') and re-send.'

const INVALID_JSON_REASON = 'orch-lite gate: dispatch rejected — the fenced block is not valid JSON.'

const MISSING_FIELD_REASON = (missing) =>
	`orch-lite gate: dispatch package missing required field(s): ${missing.join(', ')}. ` +
	`See the Dispatch Package template in ${SKILL_HINT}.`

const BAD_ID_REASON = (value) =>
	`orch-lite gate: dispatch id must be lowercase kebab-case (e.g. login or fix-login-500), got ${JSON.stringify(value)}.`

const BINDING_REASON = (description, featureId) =>
	`orch-lite gate: subagent description ${JSON.stringify(description)} does not match the package feature_id ` +
	`${JSON.stringify(featureId)}. The one string that names the agent, its branch, and its worktree must be ` +
	'verbatim identical everywhere.'

const HANDBOOK_REASON =
	'orch-lite gate: dispatch rejected — the prompt never points the child at its handbook. ' +
	`The first instruction must tell it to load skill ${HANDBOOK_POINTER}.`

/**
 * Deny reason when a dispatch omits `worktree` while other workers are live:
 * lazy isolation means the FIRST (only) worker runs in the primary tree, and
 * every additional concurrent worker needs its own worktree.
 *
 * @param {number} running live workers plus starting slots counted for THIS parent
 */
export const WORKTREE_REQUIRED_WHILE_BUSY = (running) =>
	`orch-lite gate: ${running} worker(s) are already running or just starting, so this dispatch needs its own write area — ` +
	'call worktree_create({ feature_id }) and put the returned path in the package "worktree" field. ' +
	'(A dispatch with no worktree field is the solo lane: primary working tree, allowed only when it is the ' +
	'only worker. If this order belongs to a feature that already has an agent, send_message it instead.)'

const WORKTREE_SHAPE_REASON = (value, featureId) =>
	`orch-lite gate: package "worktree" ${JSON.stringify(value)} does not follow the convention ` +
	`".worktrees/${featureId}". Call worktree_create({ feature_id: "${featureId}" }) and copy the returned path verbatim.`

export const WORKTREE_MISSING_REASON = (value) =>
	`orch-lite gate: package "worktree" ${JSON.stringify(value)} does not exist on disk yet. ` +
	'Create it with worktree_create before dispatching.'

const EXPLORE_READ_ONLY_REASON =
	'orch-lite gate: explore is the read-only lane — the prompt must state the read-only contract ' +
	'(include the phrase "read-only" and "do not change any file"). Writes belong to a feature agent.'

const EXPLORE_WORKTREE_REASON =
	'orch-lite gate: explore packages must not carry a "worktree" field — read-only sweeps never get a write area. ' +
	'If the task needs to write, dispatch a feature agent instead.'

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
 * Parse the fenced package; pkg:null with an error string when absent/invalid.
 *
 * @param {string} text
 * @returns {{pkg: object|null, error: string}}
 */
function parsePackage(text) {
	const block = findDispatchBlock(text)
	if (block === undefined) return { pkg: null, error: NO_BLOCK_REASON }
	try {
		const parsed = JSON.parse(block)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { pkg: {}, error: '' }
		return { pkg: parsed, error: '' }
	} catch {
		return { pkg: null, error: INVALID_JSON_REASON }
	}
}

/**
 * Validate a continuable feature-agent dispatch from the main session.
 *
 * @param {unknown} prompt the subagent tool's prompt text
 * @param {unknown} description the subagent tool's description (feature carrier)
 * @returns {{allowed: boolean, reason: string, worktree?: string}}
 *   when `worktree` is returned the caller must still verify the directory exists
 */
export function evaluateDispatch(prompt, description) {
	const text = typeof prompt === 'string' ? prompt : ''
	const { pkg, error } = parsePackage(text)
	if (pkg === null) return { allowed: false, reason: error }

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
	if (!text.includes(HANDBOOK_POINTER)) return { allowed: false, reason: HANDBOOK_REASON }

	// Isolation is gated on concurrency (lazy isolation): a solo worker runs in
	// the primary tree and omits `worktree`; once another worker is live, the
	// dispatch MUST carry one. The caller enforces the concurrency half — this
	// function only validates the field when it is present.
	if (typeof pkg.worktree !== 'string' || pkg.worktree === '') {
		return { allowed: true, reason: '' }
	}
	const normalized = pkg.worktree.replace(/\\/g, '/').replace(/\/+$/, '')
	if (!/\.worktrees\/[^/]+$/.test(normalized) || !normalized.endsWith(`/${pkg.feature_id}`)) {
		return { allowed: false, reason: WORKTREE_SHAPE_REASON(pkg.worktree, pkg.feature_id) }
	}
	return { allowed: true, reason: '', worktree: normalized }
}

/**
 * Validate a one-shot explore (read-only sweep) dispatch from the main session.
 *
 * @param {unknown} prompt the explore tool's prompt text
 * @returns {{allowed: boolean, reason: string}}
 */
export function evaluateExplore(prompt) {
	const text = typeof prompt === 'string' ? prompt : ''
	const { pkg, error } = parsePackage(text)
	if (pkg === null) return { allowed: false, reason: error }

	const missing = EXPLORE_FIELDS.filter(field => !(field in pkg))
	if (missing.length > 0) return { allowed: false, reason: MISSING_FIELD_REASON(missing) }
	if ('worktree' in pkg && pkg.worktree !== undefined && pkg.worktree !== null && pkg.worktree !== '') {
		return { allowed: false, reason: EXPLORE_WORKTREE_REASON }
	}
	if (!text.toLowerCase().includes(READ_ONLY_MARKER)) return { allowed: false, reason: EXPLORE_READ_ONLY_REASON }
	return { allowed: true, reason: '' }
}

// git global flags that may precede the verb: `-C <path>`, `-c k=v`, `--foo`.
const GIT_PREFIX = String.raw`\bgit\b(?:\s+(?:-C\s+\S+|-c\s+\S+(?:=\S+)?|--\S+(?:=\S+)?))*\s+`

// Verbs that always mutate state.
const GIT_ALWAYS_MUTATES = 'commit|push|pull|fetch|merge|rebase|reset|restore|stash|apply|cherry-pick|tag|rm|mv|init|clone|checkout|switch|am|gc'

// Verbs that mutate only with certain subcommands or arguments.
const GIT_BRANCH_MUTATES = new RegExp(String.raw`${GIT_PREFIX}branch\s+(?:-[dDm]|--|[^-=\s])`, 'i')
const GIT_WORKTREE_MUTATES = new RegExp(String.raw`${GIT_PREFIX}worktree\s+(?:add|remove|prune|move|lock|unlock|repair)\b`, 'i')
const GIT_REMOTE_MUTATES = new RegExp(String.raw`${GIT_PREFIX}remote\s+(?:add|remove|rename|set-url|set-head|set-sh|prune)\b`, 'i')
const GIT_CONFIG_ANY = new RegExp(String.raw`${GIT_PREFIX}config\b`, 'i')
const GIT_CONFIG_READ = new RegExp(String.raw`${GIT_PREFIX}config\s+(?:--get\b|--get-all\b|--list\b|-l\b|-e\b)`, 'i')

const SHELL_MUTATING_WORDS =
	/\b(?:Remove-Item|Rename-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Out-File|New-Item|Clear-Content|mkdir|rmdir|taskkill|Stop-Process|killall|tee|touch|chmod|chown)\b|(?:\b(?:rm|mv|del|erase|cp|kill)\s+\S)|(?:\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|update|ci|link|patch)\b)|(?:\bpip(?:3)?\s+install\b)|(?:\buv\s+pip\s+install\b)|(?:\bdocker\s+(?:rm|rmi|compose|kill|stop|restart)\b)/

/**
 * Whether a shell command looks like it mutates state. Deliberately a deny
 * list, not a whitelist: false negatives stay tolerated (the prompt discipline
 * still applies), while false positives on read-only commands would leave the
 * main session unable to inspect anything.
 *
 * @param {string} command
 * @returns {string|undefined} a short clause naming the detected mutation
 */
export function commandMutates(command) {
	const text = String(command || '')
	if (text.trim() === '') return undefined

	const git = text.match(new RegExp(String.raw`${GIT_PREFIX}(?:(${GIT_ALWAYS_MUTATES})\b)`, 'i'))
	if (git !== null) return `git ${git[1]}`
	if (GIT_BRANCH_MUTATES.test(text)) return 'git branch (create/delete)'
	if (GIT_WORKTREE_MUTATES.test(text)) return 'git worktree (mutate)'
	if (GIT_REMOTE_MUTATES.test(text)) return 'git remote (mutate)'
	if (GIT_CONFIG_ANY.test(text) && !GIT_CONFIG_READ.test(text)) return 'git config (write)'

	const words = text.match(SHELL_MUTATING_WORDS)
	if (words !== null) return words[0]

	// Redirection writes content to a file; /dev/null targets and fd dups
	// (`2>&1`, `>&2`) pass.
	if (/(?:^|[^0-9"'`$&\\])>{1,2}\s*(?!\/dev\/)(?!&)\S/.test(text)) return 'output redirection (>)'

	return undefined
}

/**
 * Classify the calling agent for the gate.
 *
 * @param {object|undefined} header `exec.agent.session.header`
 * @param {Set<string>} childIds session ids registered as executor children
 * @returns {{known: boolean, child: boolean}} `known:false` when the gate
 *   must not act (host-local call without an agent, or a session provably not
 *   bound to the orch-lite preset).
 */
export function classifyAgent(header, childIds) {
	if (header === undefined || header === null) return { known: false, child: false }
	if (typeof header.agentPreset === 'string' && header.agentPreset !== 'orch-lite') return { known: false, child: false }
	const child =
		childIds.has(header.id) ||
		(typeof header.delegationDepth === 'number' && header.delegationDepth >= 1) ||
		Boolean(header.parentSession)
	return { known: true, child }
}
