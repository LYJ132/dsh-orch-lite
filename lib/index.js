/**
 * dsh-orch-lite — agent preset that keeps the main session coordinating
 * instead of editing: feature agents do all file writes (one agent per
 * feature branch, isolated in a git worktree), one-shot `explore` agents do
 * wide read-only sweeps, and follow-up work on a feature resumes its owning
 * agent rather than spawning a new one.
 *
 * Everything the mode enforces is in-process, on the same extension points the
 * Claude Code hook bridge would program — with richer context than a hook
 * process ever gets (agent headers, scope visibility, session registries):
 *
 * - systemPrompt section: the always-visible protocol summary;
 * - skills: `orch-lite` and `orch-lite-executor` registered as runtime skills
 *   in the preset's layer — they appear in the catalog of orch-lite sessions
 *   only, and load straight from this package (no copies to scan);
 * - agent/created: a compact boot contract injected as durable conversation
 *   context before the first turn;
 * - tools/pre-execute: the hard gate — main-session file writes and mutating
 *   shell calls are denied with routing reasons; feature dispatches are
 *   validated (package shape, verbatim feature-id binding, worktree
 *   existence, handbook pointer); explore dispatches must declare the
 *   read-only contract; executors cannot dispatch further.
 *
 * Package: dsh-orch-lite. Decision history: see DEVLOG.md.
 */

// Local copy of defineTool — @deepseek-ai packages live inside app.asar and are
// not resolvable from a profile `link:` plugin. See DEVLOG.md and define-tool.js.
import { defineTool } from './define-tool.js'
import { join, dirname } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
	classifyAgent,
	commandMutates,
	DISPATCH_TOOLS,
	evaluateDispatch,
	evaluateExplore,
	EXECUTOR_DENIED_TOOLS,
	EXECUTOR_DISPATCH_REASON,
	EXPLORE_TOOL,
	MAIN_SHELL_REASON,
	MAIN_WRITE_REASON,
	MAIN_WRITE_TOOLS,
	SHELL_TOOLS,
	SLUG,
	WORKTREE_MISSING_REASON,
	WORKTREE_REQUIRED_WHILE_BUSY,
} from './gate.js'
import {
	createGitRunner,
	repoRoot,
	listWorktrees,
	hasBranch,
	dirtyFiles,
	unmergedFiles,
	normalizeGitPath,
} from './git.js'

/** Worktrees live under this directory in the repository root. */
const WORKTREES_DIR = '.worktrees'

/** Worktree add and merge are the slow calls; give them room on a cold disk. */
const SLOW_GIT_TIMEOUT_MS = 120_000

/** Cheapest proof that a scope is an orch-lite scope: our own tool is visible in it. */
const MARKER_TOOL = 'worktree_create'

/** Every tool the gate has an opinion about — used only for fail-open auditing. */
const GATED_TOOLS = new Set([...DISPATCH_TOOLS, ...MAIN_WRITE_TOOLS, ...SHELL_TOOLS, ...EXECUTOR_DENIED_TOOLS, EXPLORE_TOOL])

/**
 * Durable audit trail. `ctx.logger` alone is not enough in the desktop build —
 * its `logs` directory stays empty and session logs are zstd-compressed, so a
 * decision would leave no readable trace. Mirrors the harness-home precedence
 * (explicit env, else `~/.dsh`) the same way dsh-home-paths resolves it.
 */
const AUDIT_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'orch-lite', 'audit.log')

/**
 * Append one line to the durable trail. Best-effort: auditing is observability,
 * never enforcement, so every failure is swallowed.
 *
 * @param {string} line
 */
function appendAudit(line) {
	try {
		mkdirSync(dirname(AUDIT_FILE), { recursive: true })
		appendFileSync(AUDIT_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
	} catch {
		// ignored on purpose
	}
}

/**
 * Log one line to the host logger AND the durable trail.
 *
 * @param {object} ctx
 * @param {string} line
 */
function note(ctx, line) {
	try {
		ctx.logger.info(line)
	} catch {
		// a strict logger stub must never break a decision
	}
	appendAudit(line)
}

/**
 * The routing protocol, injected at order 2850 — after the subagent tools
 * (2800), before the report section (2900).
 *
 * `text` is a function of `{ scope }` so the section only reaches scopes that
 * actually have the orch-lite tools; a plain string would register globally
 * and leak into standard sessions. `interpolate: false` — the text carries
 * JSON braces that must never be treated as `{{variable}}` syntax. See
 * DEVLOG.md for the silent-`''` failure modes to verify after edits.
 */
const PROTOCOL = `# Mode: orch-lite

You are the coordinating main session under the **orch-lite** agent preset, not a standard agent. An in-process gate enforces this protocol: file writes, edits, and mutating shell commands issued from this session are rejected with a routing reason. A rejection is the design working — do not retry it or look around it; route the work instead.

## Supremacy

"It's trivial", "it's a quick fix", "I can do this one myself" are never reasons for the main session to act directly — small tasks still dispatch. The only legitimate direct actions are: conversation; narrow reads (read/glob/grep, read-only shell); \`list_agents\`; the \`worktree_*\` integration trio; and dispatching (\`subagent\` / \`subagent_fork\` / \`explore\`). Everything else is a dispatch.

## Language

Answer the user in whatever language the user writes in. Everything exchanged with workers — dispatch packages, resume messages, their reports — is English.

## Ownership model: one feature, one agent, one branch

\`feature_id\` (lowercase kebab, ~3 words, e.g. \`login\`) names three things, always identically:
the branch \`feature/<feature_id>\` · the owning agent (\`subagent\` description = feature_id — the gate checks it) · the package \`feature_id\` field.

All work orders on a feature — new capability, bug fix, docs, tests — go to the **same** agent via \`send_message\`; it commits serially onto its branch and carries its context across orders. When an owning agent settles, wake it; when it is worn out (3+ orders) or previously stuck, hand off: dispatch fresh with the same feature_id — the branch persists, fold the surviving conclusions into the new agent's \`STILL VALID\` section.

## Isolation is gated on concurrency (lazy isolation)

- **Solo** (no other worker running): dispatch WITHOUT a \`worktree\` field. The agent works in the primary working tree, creating and checking out \`feature/<feature_id>\` itself before its first write.
- **Concurrent** (another worker is already running): call \`worktree_create({ feature_id })\` and put the returned path in the package's \`worktree\` field. The gate refuses a \`worktree\`-less dispatch while another worker is live, so decide this BEFORE calling \`subagent\`.

While a solo agent runs, the primary tree sits on its feature branch — that is expected. Read-only work (yours, or \`explore\`) is unaffected.

## Step 0: the routing audit

Every reply begins with exactly one line:

- \`[routing] chat\` — conversation or a narrow direct read (path known, one specific fact).
- \`[routing] explore <slug>\` — a wide read-only sweep: one \`explore\` call (see below).
- \`[routing] task <feature_id>\` — first dispatch of a feature. \`[routing] resume <feature_id>\` — a work order to its existing agent.
- \`[routing] orchestration <f1>, <f2>, ...\` — two or more features dispatched in parallel.

Before choosing task vs orchestration, run the decomposition check: a multi-item or complex request is EXPECTED to split. Items with disjoint file sets and no named dependency belong to separate features → dispatch them in parallel (concurrency is normal here: the first worker takes the primary tree, each additional one gets its own worktree). Piling unrelated items onto one agent lengthens its context and the user's wait — don't. Serial needs a stated reason. Unsure → parallel. Skipped the line? Emit it late; silence is the violation.

## Three invariants

1. **The main session never writes files.** write / edit / scripts / git commits all go to workers.
2. **Committed before reported.** You delete worktrees; uncommitted work vanishes with the directory.
3. **Same feature, same agent.** Before dispatching a feature agent, \`list_agents()\` for a row labeled \`<feature_id>\`: idle → resume it; none → create the worktree, then dispatch.

## Dispatch formats (both gate-checked)

Feature agent — solo: \`subagent({ description: "<feature_id>" })\` with a package carrying { feature_id, objective, acceptance_criteria } and no \`worktree\`. Concurrent: \`worktree_create({ feature_id })\` first, then the same call with \`"worktree": ".worktrees/<feature_id>"\` added. Either way: identity line + "call the skill tool with name \`orch-lite-executor\`" + the fenced JSON. \`objective\` states the phenomenon, not the fix; criteria must be testable.

Explore (one-shot, read-only): \`explore({ description: "<slug>", prompt })\` — fenced JSON { objective } + an explicit read-only statement ("this is a read-only investigation; do not change any file") + where to report conclusions. Foreground calls wait and return the final text; pass \`run_in_background: true\` for parallel sweeps and collect with \`job_output\`.

## Integration and stuck

When a feature is done: \`worktree_merge({ feature_id })\` — for solo work pass \`into: "<the branch it started from>"\` (the primary tree is on the feature branch), then \`worktree_remove({ feature_id })\` only if a worktree existed. On CONFLICT, hand the file list to the user — never auto-resolve. \`worktree_remove\` refuses a dirty tree; have the agent commit or leave it to the user. Same problem failing 3 times or ~10 minutes without progress → report STUCK (problem / tried / why still blocked).

## Your first action this session

Call the skill tool with name \`orch-lite\` and follow the manual — templates, resume format, ownership boundaries, and worktree lifecycle are defined there; this summary is not sufficient to dispatch from memory.`

/**
 * The boot contract injected once into the main session's conversation before
 * its first turn (durable history — survives where prompt skimming fails).
 */
const BOOT_CONTRACT = `[orch-lite] Session mode: ORCHESTRATION. You coordinate; workers do the work.
The plugin gate physically rejects write/edit and mutating shell calls from this session — a rejection means "route it", not "try harder".
Answer the user in the user's language; all worker traffic (dispatches, resumes, reports) is English.
Every reply starts with one audit line: [routing] chat | [routing] explore <slug> | [routing] task|resume <feature_id> | [routing] orchestration <ids>. "Trivial" is never a reason to act directly.
Ownership: one feature_id = one agent = one branch (feature/<feature_id>). New capability, bug fix, docs on the same feature all go to its agent via send_message; wake before spawning.
Isolation is lazy: a SOLO worker runs in the primary tree with no "worktree" field; when another worker is already running, call worktree_create({feature_id}) and add "worktree" to the package — the gate refuses a worktree-less dispatch while another worker is live.
Lanes: writes → subagent (feature agent, gated package). Wide reads → explore (one-shot, returns conclusions). Direct: conversation, narrow reads, worktree_* / merge integration.
Before your first dispatch this session: load the skill \`orch-lite\` — the gate rejects packages that deviate from its templates.`

/** One-liner stamped into a freshly created worker's context (both lanes). */
const CHILD_HINT = `[orch-lite] You are a dispatched worker. Follow the contract in your dispatch prompt exactly, and report by ENDING YOUR TURN with the report text — your final message is delivered to the main session verbatim; only use send_message if the prompt gave you an explicit target. Never dispatch further agents. If your prompt loads skill orch-lite-executor, you are a feature agent: work only inside your named write area. If your prompt declares read-only/explore, change nothing and make the final message the full answer with file:line references. Everything you write is English.`

/**
 * Build the durable user-role message for `agent.inject` — same shape
 * `createUserMessage` produces (identified, plain data; we queue it unfrozen,
 * which the inbox accepts).
 *
 * @param {string} text
 * @returns {object}
 */
function userMessage(text) {
	return { role: 'user', content: [{ type: 'text', text }], id: randomUUID(), source: { kind: 'orch-lite' } }
}

/**
 * Reject a value that cannot safely become a branch name or path segment.
 *
 * @param {string} value
 * @param {string} field parameter name for the message
 */
function assertSlug(value, field) {
	if (!SLUG.test(value)) {
		throw new Error(
			`${field} must be lowercase kebab-case (letters, digits, single hyphens; 1-63 chars), got ${JSON.stringify(value)}. ` +
				'Use something like login or fix-login. The same string is the agent description, the branch, and the worktree directory.',
		)
	}
}

/**
 * The calling session's working directory.
 *
 * @param {object} exec tool execution context
 * @returns {string|undefined}
 */
function sessionCwd(exec) {
	return exec.agent?.session?.header?.cwd
}

/** Synthetic identity for the baseline commit — a fresh machine has no git user. */
const BOOTSTRAP_IDENTITY = ['-c', 'user.name=orch-lite-init', '-c', 'user.email=orch-lite@local']

/**
 * Create the minimum repository a worktree needs, mirroring the original
 * orch-lite bootstrap (`git init -b main`, ignore entries, a baseline commit).
 * It stages ONLY `.gitignore` and commits with `--allow-empty`, so the user's
 * existing files stay untracked — the bootstrap never claims user content.
 * Failures are warnings; the caller still reports the missing repository.
 *
 * @param {object} ctx
 * @param {import('./git.js').GitRunner} git
 * @param {string} cwd session working directory
 * @param {object} exec
 */
async function bootstrapRepository(ctx, git, cwd, exec) {
	const options = { cwd, signal: exec.signal }
	const attempt = await git.run(['init', '-b', 'main'], options)
	if (attempt.exitCode !== 0) {
		// Older git without `-b`: init, then rename the unborn branch.
		const plain = await git.run(['init'], options)
		if (plain.exitCode !== 0) {
			ctx.logger.warn(`orch-lite: git bootstrap failed at ${cwd}: ${(plain.stderr || attempt.stderr).trim()}`)
			return
		}
		await git.run(['branch', '-m', 'main'], options)
	}
	const root = await repoRoot(git, cwd, exec.signal)
	if (root === undefined) return
	await ensureGitignore(ctx, root, exec)
	await git.run(['add', '.gitignore'], options)
	const commit = await git.run([...BOOTSTRAP_IDENTITY, 'commit', '--allow-empty', '-m', 'chore: orch-lite baseline'], options)
	if (commit.exitCode !== 0) ctx.logger.warn(`orch-lite: baseline commit failed at ${root}: ${commit.stderr.trim()}`)
	note(
		ctx,
		`orch-lite: bootstrapped a git repository at ${root} (init -b main + baseline commit; existing files stay untracked) — a write task needed isolation`,
	)
}

/**
 * Resolve the git runner and the repository root for the calling session.
 *
 * `create: true` (worktree_create only) lazily bootstraps the minimum
 * repository when the workspace has none. The original ran that bootstrap at
 * every session start; here it fires only when a write task actually needs
 * isolation, so chat/read-only sessions and directories that should not be
 * repositories stay untouched. merge/remove never bootstrap.
 *
 * @param {object} ctx
 * @param {object} exec
 * @param {{create?: boolean}} [options]
 * @returns {Promise<{git: import('./git.js').GitRunner, root: string}>}
 */
async function repositoryFor(ctx, exec, options = {}) {
	const cwd = sessionCwd(exec)
	if (cwd === undefined) throw new Error('no session working directory on this agent; the worktree tools need a real session.')
	const git = await createGitRunner(ctx)
	let root = await repoRoot(git, cwd, exec.signal)
	if (root === undefined && options.create === true) {
		await bootstrapRepository(ctx, git, cwd, exec)
		root = await repoRoot(git, cwd, exec.signal)
	}
	if (root === undefined) {
		throw new Error(
			`${cwd} is not inside a git repository, so there is nothing to isolate with a worktree. ` +
				'Dispatch read-only work with explore instead — write work needs a repository.',
		)
	}
	return { git, root }
}

/**
 * Whether an error is a missing-path error from the filesystem service.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
	return typeof error === 'object' && error !== null && (error.code === 'FS_NOT_FOUND' || error.code === 'ENOENT')
}

/**
 * Whether `.gitignore` already carries an entry for a directory.
 *
 * @param {string} content
 * @param {string} entry slash form, e.g. `.worktrees/`
 * @returns {boolean}
 */
function hasIgnoreEntry(content, entry) {
	const bare = entry.replace(/\/$/, '')
	return content.split(/\r?\n/).some(line => {
		const trimmed = line.trim()
		return trimmed === entry || trimmed === bare || trimmed === `/${entry}` || trimmed === `/${bare}`
	})
}

/**
 * Add `.worktrees/` to `.gitignore` so concurrent worktrees never show up as
 * untracked noise in the main tree. Idempotent; a failure here must not fail
 * the worktree creation.
 *
 * @param {object} ctx
 * @param {string} root repository top level
 * @param {object} exec
 */
async function ensureGitignore(ctx, root, exec) {
	const entries = [`/${WORKTREES_DIR}/`, `.worktrees/`]
	const path = join(root, '.gitignore')
	const resolveOptions = { cwd: root, signal: exec.signal }
	try {
		const target = await ctx.fs.resolve(path, resolveOptions)
		const current = await ctx.fs.readText(target, exec.signal)
		const missing = entries.filter(entry => !hasIgnoreEntry(current, entry))
		if (missing.length === 0) return
		const head = current === '' || current.endsWith('\n') ? current : `${current}\n`
		await ctx.fs.writeText(target, head + missing.map(entry => `${entry}\n`).join(''), undefined, exec.signal)
	} catch (error) {
		if (!isNotFound(error)) return
		try {
			const target = await ctx.fs.resolve(path, resolveOptions)
			await ctx.fs.writeText(target, entries.map(entry => `${entry}\n`).join(''), undefined, exec.signal)
		} catch {
			// A repository that cannot hold a .gitignore is not this tool's problem.
		}
	}
}

export const inject = ['subprocess', 'tools', 'systemPrompt', 'fs']

/**
 * Register the preset half: protocol, skills, gate, boot context, worktree tools.
 *
 * @param {object} ctx
 */
export function apply(ctx) {
	// --- the always-visible protocol summary ---------------------------------
	ctx.systemPrompt.section({
		name: 'orch-lite:protocol',
		order: 2850,
		interpolate: false,
		text: ({ scope }) => (ctx.tools.get(MARKER_TOOL, scope) === undefined ? '' : PROTOCOL),
	})

	// --- skills live in the global layer, not here ----------------------------
	// The two manuals are registered by `lib/skills.js`, mounted as a HOST row,
	// so every preset can load them (knowledge is shared, capability is not:
	// this row's tools and gate stay scoped to the orch-lite preset).

	// --- live-worker registry, parent-grouped ---------------------------------
	// `children` maps childSessionId -> parentId and is fed ONLY by the
	// start/end pair (end fires at settlement), so an entry always means "live
	// worker". Counting is grouped by parent: another orch-lite session's
	// workers never close this session's solo lane.
	// `pending` counts solo dispatches the gate just allowed whose child has
	// registered not yet — `subagent/start` lands asynchronously relative to the
	// tool ack, so two solo dispatches composed in ONE assistant message would
	// otherwise both pass a zero-live check and double-book the primary tree.
	// The increment happens synchronously inside the gate decision (before any
	// await), which closes that window; slots are released at start, and at
	// post-execute when the dispatch failed to start anything. Any residual
	// leak blocks toward over-isolation, never toward two writers.
	const children = new Map()
	const runToChild = new Map()
	const pending = new Map()
	const agentOf = (info) => ctx.get('agents')?.get(info.id)
	const bumpPending = (parentId, delta) => {
		if (typeof parentId !== 'string') return
		pending.set(parentId, Math.max(0, (pending.get(parentId) ?? 0) + delta))
	}
	const liveWorkers = (parentId) => {
		let n = pending.get(parentId) ?? 0
		for (const parent of children.values()) if (parent === parentId) n += 1
		return n
	}
	ctx.on('subagent/start', (info) => {
		const child = agentOf(info)
		const childId = child?.session?.header?.id
		const parentId = child?.session?.header?.parentSession
		if (typeof childId === 'string') {
			children.set(childId, typeof parentId === 'string' ? parentId : null)
			if (info.runId !== undefined) runToChild.set(info.runId, childId)
		}
		bumpPending(parentId, -1)
	})
	ctx.on('subagent/end', (info) => {
		const key = info.runId ?? info.id
		const childId = runToChild.get(key) ?? agentOf(info)?.session?.header?.id
		if (typeof childId === 'string') children.delete(childId)
		runToChild.delete(key)
	})

	// --- audit -----------------------------------------------------------------
	// A denial reason lives and dies in the model context, and the desktop build
	// keeps no readable host log — so every decision goes to the durable trail
	// (`$DSH_HOME/orch-lite/audit.log`) as well as the logger.
	const audit = (line) => note(ctx, `orch-lite gate: ${line}`)

	// --- boot context: durable conversation injection before the first turn --
	ctx.on('agent/created', ({ agent }) => {
		try {
			const header = agent?.session?.header
			if (header === undefined || header === null) return
			if (typeof header.agentPreset === 'string' && header.agentPreset !== 'orch-lite') return
			const child =
				(typeof header.delegationDepth === 'number' && header.delegationDepth >= 1) || Boolean(header.parentSession)
			const text = child ? CHILD_HINT : BOOT_CONTRACT
			agent.inject(userMessage(text))
		} catch (error) {
			ctx.logger.warn(`orch-lite: boot context could not be injected: ${String(error)}`)
		}
	})

	// --- the hard gate -------------------------------------------------------
	ctx.on('tools/pre-execute', async (exec, next) => {
		const header = exec.agent?.session?.header
		const who = classifyAgent(header, children)
		if (!who.known) {
			// Fail-open by design; but a mutating/dispatch call that arrives
			// without an attributable orch-lite agent is worth a log line, so
			// "why did the gate say yes" is answerable after the fact.
			if (GATED_TOOLS.has(exec.name)) audit(`fail-open (no attributable orch-lite agent): tool=${exec.name}`)
			return next()
		}
		if (who.child) {
			if (EXECUTOR_DENIED_TOOLS.has(exec.name)) {
				audit(`deny (executor dispatch) tool=${exec.name} child=${header.id}`)
				return { kind: 'deny', reason: EXECUTOR_DISPATCH_REASON }
			}
			return next()
		}
		if (MAIN_WRITE_TOOLS.has(exec.name)) {
			audit(`deny (main write) tool=${exec.name}`)
			return { kind: 'deny', reason: MAIN_WRITE_REASON }
		}
		if (SHELL_TOOLS.has(exec.name)) {
			const mutation = commandMutates(exec.arguments?.command)
			if (mutation !== undefined) {
				audit(`deny (main shell mutation: ${mutation})`)
				return { kind: 'deny', reason: MAIN_SHELL_REASON(mutation) }
			}
			return next()
		}
		if (DISPATCH_TOOLS.has(exec.name)) {
			const verdict = evaluateDispatch(exec.arguments?.prompt, exec.arguments?.description)
			if (!verdict.allowed) {
				audit(`deny (dispatch package): ${verdict.reason.slice(0, 160)}`)
				return { kind: 'deny', reason: verdict.reason }
			}
			// Lazy isolation, decided synchronously so two solo dispatches sent
			// in one message cannot both slip past the zero-live check.
			if (verdict.worktree === undefined) {
				if (liveWorkers(header.id) > 0) {
					audit(`deny (worktree-less dispatch while ${liveWorkers(header.id)} live) feature=${exec.arguments?.description}`)
					return { kind: 'deny', reason: WORKTREE_REQUIRED_WHILE_BUSY(liveWorkers(header.id)) }
				}
				bumpPending(header.id, +1)
				audit(`allow (solo lane, primary tree) feature=${exec.arguments?.description}`)
				return next()
			}
			// Concurrent lane: the work area must actually exist. Anything but a
			// clean missing-directory answer passes (never block on plugin error).
			if (typeof header.cwd === 'string') {
				try {
					const target = await ctx.fs.resolve(join(header.cwd, ...verdict.worktree.split('/')), {
						cwd: header.cwd,
						signal: exec.signal,
					})
					await ctx.fs.stat(target, exec.signal)
				} catch (error) {
					if (isNotFound(error)) {
						audit(`deny (worktree missing) path=${verdict.worktree}`)
						return { kind: 'deny', reason: WORKTREE_MISSING_REASON(verdict.worktree) }
					}
				}
			}
			audit(`allow (worktree lane) path=${verdict.worktree}`)
			return next()
		}
		if (exec.name === EXPLORE_TOOL) {
			const verdict = evaluateExplore(exec.arguments?.prompt)
			if (!verdict.allowed) {
				audit(`deny (explore package): ${verdict.reason.slice(0, 160)}`)
				return { kind: 'deny', reason: verdict.reason }
			}
			audit('allow (explore, read-only)')
			return next()
		}
		return next()
	})

	// --- solo-slot release on failed dispatch ----------------------------------
	// A solo allowance reserved a pending slot; the slot frees at start. If the
	// tool call came back WITHOUT a "started …" ack (provider error, rejected
	// prompt after this listener), no child will ever start, so release here.
	// Success acks are left to the start listener, which already fired.
	ctx.on('tools/post-execute', async (exec, result, next) => {
		const parentId = exec.agent?.session?.header?.id
		if (typeof parentId === 'string' && DISPATCH_TOOLS.has(exec.name) && (pending.get(parentId) ?? 0) > 0) {
			const text = (result?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
			if (!/started (subagent|background subagent)/.test(text)) {
				bumpPending(parentId, -1)
				audit(`solo slot released (dispatch did not start a child) parent=${parentId}`)
			}
		}
		return next()
	})

	// --- the worktree tools --------------------------------------------------
	ctx.tools.register(
		defineTool({
			name: 'worktree_create',
			description:
				'Allocate an isolated write area: .worktrees/<feature_id>/ on branch feature/<feature_id> (created on demand, reused across work orders). ' +
				'Call it ONLY when another worker is already running — isolation is gated on concurrency (lazy isolation); a solo worker runs in the primary working tree and creates its own feature branch. ' +
				'Idempotent: an existing feature worktree is returned as-is, which is also how a handed-off agent\'s area is re-claimed. ' +
				'Do NOT call it for read-only sweeps — those go to explore. ' +
				'feature_id must be verbatim identical to the owning subagent\'s description and the package field.',
			parameters: {
				feature_id: {
					type: 'string',
					required: true,
					description: 'Feature id, lowercase kebab-case; verbatim identical to the owning agent description and the package feature_id.',
				},
				base: { type: 'string', description: 'Base ref for a new branch, defaults to current HEAD. Ignored when the branch exists.' },
			},
			output: {
				schema: { type: 'json' },
				render: (_args, value) => {
					const verb = value.reused ? 'reusing write area' : 'created write area'
					return [
						{
							type: 'text',
							text:
								`${verb} for feature ${value.feature_id}: ${value.worktree_path} (branch ${value.branch}).\n` +
								(value.note === undefined ? '' : `${value.note}\n`) +
								`Dispatch or resume with subagent({ description: "${value.feature_id}" }) and set the package "worktree" to this path.\n` +
								`Optionally register on the shared task board: team_task_create({ subject, description, write_scopes: ["${value.worktree_path}"] })`,
						},
					]
				},
			},
			async execute(args, exec) {
				assertSlug(args.feature_id, 'feature_id')
				// The only call site allowed to bootstrap a missing repository.
				const { git, root } = await repositoryFor(ctx, exec, { create: true })
				const branch = `feature/${args.feature_id}`
				const path = normalizeGitPath(join(root, WORKTREES_DIR, args.feature_id))
				const worktrees = await listWorktrees(git, root, exec.signal)

				const existing = worktrees.find(entry => entry.path === path)
				if (existing !== undefined) {
					return {
						feature_id: args.feature_id,
						worktree_path: existing.path,
						branch: existing.branch ?? branch,
						created: false,
						reused: true,
					}
				}

				// Git allows one worktree per branch: if the branch lives elsewhere
				// (legacy layout, manual checkout), hand that path back rather than
				// failing — it still IS this feature's write area. See DEVLOG.md.
				const branchHolder = worktrees.find(entry => entry.branch === branch)
				if (branchHolder !== undefined) {
					return {
						feature_id: args.feature_id,
						worktree_path: branchHolder.path,
						branch,
						created: false,
						reused: true,
						note:
							`${branch} is already checked out at ${branchHolder.path} — git keeps one worktree per branch, so that directory is this feature's write area. ` +
							'Dispatch there; the package "worktree" must name this exact path.',
					}
				}

				if (await hasBranch(git, root, branch, exec.signal)) {
					await git.ok(['worktree', 'add', path, branch], { cwd: root, signal: exec.signal, timeoutMs: SLOW_GIT_TIMEOUT_MS }, 'git worktree add')
				} else {
					const argv = ['worktree', 'add', path, '-b', branch]
					if (args.base !== undefined) argv.push(args.base)
					await git.ok(argv, { cwd: root, signal: exec.signal, timeoutMs: SLOW_GIT_TIMEOUT_MS }, 'git worktree add')
				}
				await ensureGitignore(ctx, root, exec)
				return {
					feature_id: args.feature_id,
					worktree_path: path,
					branch,
					created: true,
					reused: false,
				}
			},
		}),
	)

	ctx.tools.register(
		defineTool({
			name: 'worktree_merge',
			description:
				'Merge a feature branch into the CURRENTLY CHECKED-OUT branch of the primary tree — so first confirm that branch with read-only `git status`/`git branch`; if it is not where the work belongs, pass into: "<target>". ' +
				'On conflict the merge aborts, the conflicted file list is returned, and the tree is rolled back — never auto-resolve; hand it to the user. ' +
				'Main session only, at integration time; agents never call this.',
			parameters: {
				feature_id: { type: 'string', required: true, description: 'Feature id to merge.' },
				into: {
					type: 'string',
					description:
						'Branch to merge into. Defaults to the currently checked-out branch, which is right for worktree work. ' +
						'Required when the primary tree is already on feature/<feature_id> (solo lane) — pass the branch that work started from.',
				},
			},
			output: {
				schema: { type: 'json' },
				render: (_args, value) => {
					if (value.conflict) {
						return [
							{
								type: 'text',
								text:
									`CONFLICT feature_id=${value.feature_id} files=${JSON.stringify(value.files)}: needs a human decision. ` +
									`Rolled back; the working tree stays on ${value.into} and is otherwise untouched.` +
									(value.reason === '' ? '' : ` git: ${value.reason}`),
							},
						]
					}
					return [
						{
							type: 'text',
							text: `Merged ${value.branch} into ${value.into} (${value.files.length} files): ${value.files.join(', ')}`,
						},
					]
				},
			},
			async execute(args, exec) {
				assertSlug(args.feature_id, 'feature_id')
				if (args.into !== undefined) assertSlug(args.into, 'into')
				const { git, root } = await repositoryFor(ctx, exec)
				const branch = `feature/${args.feature_id}`
				if (!(await hasBranch(git, root, branch, exec.signal))) {
					throw new Error(`no local branch ${branch}; nothing to merge.`)
				}
				const current = (await git.ok(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal: exec.signal })).stdout.trim()
				let target = current
				if (current === branch) {
					// Solo lane: the worker's commits live on the primary tree, which is
					// checked out on the feature branch — integration must return to the
					// base branch first, and only the caller knows its name.
					if (args.into === undefined) {
						throw new Error(
							`already on ${branch}: this feature worked in the primary tree (solo lane), so pass ` +
								'into: "<the branch this work started from>" to merge it back.',
						)
					}
					target = args.into
				} else if (args.into !== undefined && args.into !== current) {
					target = args.into
				}
				if (target !== current) {
					if (!(await hasBranch(git, root, target, exec.signal))) throw new Error(`no local branch ${target}.`)
					await git.ok(['checkout', target], { cwd: root, signal: exec.signal }, `git checkout ${target}`)
				}
				const before = (await git.ok(['rev-parse', 'HEAD'], { cwd: root, signal: exec.signal })).stdout.trim()

				const merge = await git.run(['merge', '--no-edit', branch], {
					cwd: root,
					signal: exec.signal,
					timeoutMs: SLOW_GIT_TIMEOUT_MS,
				})
				if (merge.exitCode !== 0) {
					// Read the conflicted paths before aborting, or they are gone.
					const files = await unmergedFiles(git, root, exec.signal).catch(() => [])
					await git.run(['merge', '--abort'], { cwd: root, signal: exec.signal }).catch(() => {})
					return { feature_id: args.feature_id, branch, merged: false, conflict: true, files, into: target, reason: merge.stderr.trim() }
				}

				const diff = await git.ok(['diff', '--name-only', before, 'HEAD'], { cwd: root, signal: exec.signal })
				const files = diff.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
				return { feature_id: args.feature_id, branch, merged: true, conflict: false, files, into: target, reason: '' }
			},
		}),
	)

	ctx.tools.register(
		defineTool({
			name: 'worktree_remove',
			description:
				"Remove a feature's worktree directory; the branch is always kept. Call only after the feature agent reported DONE and committed — uncommitted work is lost with the directory. " +
				'A dirty worktree is refused outright; there is no force flag: have the agent commit or leave the decision to the user.',
			parameters: {
				feature_id: { type: 'string', required: true, description: 'Feature id whose worktree to remove.' },
			},
			output: {
				schema: { type: 'json' },
				render: (_args, value) => {
					if (value.skipped === true) {
						return [
							{
								type: 'text',
								text:
									`No worktree for feature ${value.feature_id}: solo-lane work lives in the primary working tree, ` +
									'so there is nothing to remove. Its branch (if any) is untouched.',
							},
						]
					}
					if (!value.removed) {
						return [
							{
								type: 'text',
								text:
									`Worktree is dirty (uncommitted changes): ${value.dirty.join(', ')}; kept ${value.worktree_path}, branch ${value.branch ?? '(detached)'} untouched. ` +
									'Have the agent commit first, or leave the decision to the user.',
							},
						]
					}
					return [
						{
							type: 'text',
							text: `Removed ${value.worktree_path}; branch ${value.branch ?? '(detached)'} kept.`,
						},
					]
				},
			},
			async execute(args, exec) {
				assertSlug(args.feature_id, 'feature_id')
				const { git, root } = await repositoryFor(ctx, exec)
				const path = normalizeGitPath(join(root, WORKTREES_DIR, args.feature_id))
				const target = (await listWorktrees(git, root, exec.signal)).find(entry => entry.path === path)
				if (target === undefined) {
					return { feature_id: args.feature_id, removed: false, skipped: true, dirty: [], worktree_path: null, branch: null }
				}

				const dirty = await dirtyFiles(git, target.path, exec.signal)
				if (dirty.length > 0) {
					return {
						feature_id: args.feature_id,
						removed: false,
						dirty,
						worktree_path: target.path,
						branch: target.branch ?? null,
					}
				}

				await git.ok(['worktree', 'remove', target.path], { cwd: root, signal: exec.signal, timeoutMs: SLOW_GIT_TIMEOUT_MS }, 'git worktree remove')
				await git.run(['worktree', 'prune'], { cwd: root, signal: exec.signal })
				return {
					feature_id: args.feature_id,
					removed: true,
					dirty: [],
					worktree_path: target.path,
					branch: target.branch ?? null,
				}
			},
		}),
	)
}
