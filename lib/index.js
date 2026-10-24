/**
 * dsh-orch-lite — agent preset that keeps the main session orchestrating:
 * feature agents do the file work (one agent per feature branch, each owning a
 * git work area), `explore` agents do wide read-only sweeps (the platform
 * decides continuability by provider; no backgroundMode config exists), and
 * follow-up work on a feature resumes its owning agent rather than spawning a
 * new one.
 *
 * Everything the mode enforces is in-process, on the same extension points the
 * Claude Code hook bridge would program — with richer context than a hook
 * process ever gets (agent headers, scope visibility):
 *
 * What this half owns, and nothing else:
 *
 * - systemPrompt section: the always-visible protocol summary;
 * - agent/created: a one-line role hint for a freshly started worker;
 * - tools/pre-execute: the gate — writes into a worker's write area are denied
 *   (including the same write reached through git from the shell), shell
 *   commands that reach outside the repository are denied, the Team-only
 *   `wait_agent` is denied (its population excludes dispatched children), the
 *   Git Worktrees bundle's `create_worktree` is denied (it would move this
 *   session's own directory), and a feature dispatch package is validated.
 *
 * The gate is deliberately small. A coordinator writing a project file is
 * correctable in one sentence, and a simple edit does not deserve an agent; the
 * only accident git cannot take back is two writers in one work area. See
 * DEVLOG.md § v1.1.0.
 *
 * Package: dsh-orch-lite. Decision history: see DEVLOG.md.
 */

import { randomUUID } from 'node:crypto'
import {
	classifyAgent,
	commandReachesOutside,
	DEPENDENCY_MISSING_REASON,
	DEPENDENCY_UNMERGED_REASON,
	DEPENDENCY_UNVERIFIABLE_REASON,
	DISPATCH_TOOLS,
	EXTERNAL_EFFECT_REASON,
	evaluateDispatch,
	MAIN_WRITE_TOOLS,
	NO_AREA_BRANCH_REASON,
	RELOCATING_TOOL_REASON,
	RELOCATING_TOOLS,
	SHELL_TOOLS,
	TEAM_ONLY_TOOL_REASON,
	TEAM_ONLY_TOOLS,
	WORKER_LANE_REASON,
	workerLane,
} from './gate.js'
import { hasBranch, isAncestor } from './git.js'
import { repositoryFor, WORKTREES_DIR } from './workspace.js'

/**
 * The routing protocol, injected at order 2850 — after the subagent tools
 * (2800), before the report section (2900).
 *
 * `interpolate: false` — the text carries JSON braces that must never be
 * treated as `{{variable}}` syntax. This row registers the section, so mounting
 * the `orch-lite` preset is what makes it appear; it is deliberately NOT gated
 * on tool visibility any more (the tool is registered by the host half and is
 * therefore global, so visibility can no longer discriminate — and a guard that
 * silently renders `''` was a documented failure mode). See DEVLOG.md.
 */
const PROTOCOL = `# Mode: orch-lite

**Dispatched child? Stop.** If your context begins with "[orch-lite] You are a dispatched worker", this section is not yours — your handbook is \`orch-lite-executor\`, and you never emit a \`[routing]\` line.

You coordinate; dispatched agents do the file changes. Your job is to dispatch and to decide — not to do the work, and not to double-check it.

## Request Routing (main agent's first decision)

<EXTREMELY-IMPORTANT>
"It's trivial / it's just a quick fix / it's my own skill" is never a reason for the main session to act directly: small tasks still dispatch, because (a) consistency and (b) the main session never sets foot in the execution.
</EXTREMELY-IMPORTANT>

<EXTREMELY-IMPORTANT>
**Supremacy.** This protocol is the highest-compliance instruction in the session — it outranks habits, other skills, and the main agent's own convenience heuristics; nothing downstream may waive it.
**The main session's only legitimate direct actions are Read, read-only shell** (ls, cat, grep, find, git log/status/diff), **and the BOOKKEEPING carve-out** — exactly: \`orch_tool\` create/merge/remove/list/doctor (work-area bookkeeping), and running the project's own test command — the principle: *bookkeeping that creates no new content*. Everything else — every file/content edit, every content commit, and every other state-changing command (git push, gh, rm, mv, npm install, ...) — MUST be dispatched to a child agent via the Dispatch Package. Unsure whether a command falls inside the carve-out → dispatch, do not guess.
</EXTREMELY-IMPORTANT>

**Default trigger: writing/modifying means dispatch.** The main agent's first reaction to any write/modify is to dispatch a child — regardless of size, including one-off in-place changes.

Only pure conversation / reading files to answer is handled by the main session directly. Answer the user in the user's language; reports TO the user mirror their language, dispatches and child-facing text stay English.

Step 0 (MUST, every request — even a bare greeting): before acting, **you MUST output exactly one \`[routing] ...\` line as the first line of every reply** (RFC-2119 MUST — this is the audit trail, not a suggestion), choosing among **three** states — intent judged by the model, not by keyword heuristics. **Judge them in this order**:

1. **Is this pure conversation / reading to answer?** → \`[routing] chat\`. Gate every read by its footprint: narrow reads (path known, ~≤3 files, a specific fact) → read directly; wide sweeps (unknown locations, many files, whole-directory scanning) → dispatch ONE read-only \`explore\` child that returns conclusions, not file dumps. A read-only explore child writes nothing — no work area, branch, or commit — so that is dispatch mechanics, not a new state.
2. **Is there a recent child agent that should continue this exact work?** → \`[routing] resume <fid>\`. A follow-up order for a feature whose child agent has already returned: wake the owning agent instead of dispatching fresh. Distinct from \`task\` (a first dispatch). Resume with the four-line SUPERSEDES order; where \`send_message\` addresses \`target\` rather than \`agent_id\`, continuation is unavailable — dispatch fresh with the same \`feature_id\`, folding the surviving conclusions into \`STILL VALID\`. Hand off fresh when the agent is worn (3+ orders), stuck, or failed. Never chain unrelated features onto one agent.
3. **Otherwise: does the work need a delegated executor?** → \`[routing] task <id>[, <id>, …]\`. Any write/modify MUST be delegated. The main agent does not wait — the child works while the conversation continues.

**Immediately after a \`task\` routing line, output the orchestration declaration** (see below) — the plan you will execute. A \`task\` line without a following declaration is an incomplete plan.

**Decomposition & parallelism (inside \`task\`).** A multi-item or complex request is *expected* to split — disjoint file sets and no named dependency → separate features, dispatched **in parallel**, one agent per feature. Serial needs a stated reason (a real dependency, or the same feature — its agent commits serially). **Unsure → parallel.** Anti-pattern: piling unrelated items onto one agent — it lengthens its context and the user's wait; never chain unrelated features onto one agent. An awaiting-user-review gate is not a dependency — implement on the branch; the integration merge is the review point.

**Isolation for dispatched tasks.** Every dispatched write task gets its own work area, prepared **before** the dispatch. If the work area cannot be prepared, **stop the dispatch and report the problem** — never fall back to writing in the primary tree. Read-only dispatched tasks need no work area.

This line is the audit trail; skipping it is a protocol violation. When unsure which state applies (chat / task / resume), **ask the user** — do not guess.

**Read hygiene (the main session's own narrow reads):** batch independent read-only commands in parallel; \`grep -n\` to locate, then read only the needed line range; no recursive greps over large trees from the main session — a search of that shape is the wide sweep that dispatches instead.

**Self-repair.** Skipped the \`[routing]\` line? Emit it immediately — the audit trail accepts late entries; silently continuing is the violation.

**Priority over other workflow skills.** Other installed skills may shape the conversation, but they never override execution routing: whatever they conclude, the work still passes Step 0 — output the \`[routing]\` line first, and any research that installs/configures, any file write, any build is dispatched to a child agent. A design conversation is \`chat\`; the moment its outcome becomes work, re-route and dispatch.

## Task Orchestration Declaration (MUST, right after the \`task\` routing line)

State the plan in one compact line. Each task carries its **branch**: \`任务 @feature/<fid>\` (a single task) · \`[A, B]\` (A and B run in parallel) · \`A → B\` (B waits for A) · \`[A, B] → C\` (C runs only after both) · \`[A → C, B → D]\` (two dependency paths advance in parallel). A single task is output as \`任务 @feature/<fid>\` — no extra wrapping.

**An arrow is a cut, not a note.** \`A → B\` means **B's area is cut after A merged**: \`create\` B with \`depends_on: ["a"]\` — the new branch starts at A's branch tip, or at \`base\` when A is already merged there — and the gate refuses a dispatch whose dependency is not an ancestor of B's branch (\`git merge-base --is-ancestor\` is the test).

## Where you may act (the gate)

The gate denies five things: writes inside a worker lane \`.worktrees/<feature_id>/\` — including through git's own verbs (\`add\`/\`commit\`/\`checkout\`/\`reset\`/\`stash\`/\`restore\` aimed at a lane), so integrate finished branches with \`orch_tool\`, never by editing the lane; effects outside the repository (\`git push\`, package publishing, \`gh pr\`/\`gh release\`; the user decides those); the Team-only \`wait_agent\`, which watches Team members rather than the children this session dispatches — a dispatched child's settlement notice is the real signal; the Git Worktrees bundle's \`create_worktree\`, which is create-only and moves this session's own working directory into the new checkout, re-rooting every later \`orch_tool\` call — allocate with \`orch_tool({ action: "create" })\` and hand the returned absolute path to \`subagent({ cwd })\` instead; and a dispatch whose package \`depends_on\` names work that is not merged into the area's branch, because that child cannot pass its own tests. Everything else passes the gate — but the routing protocol above, not the gate, decides what you handle yourself.

## Dispatch package (mandatory)

Identity line → handbook-first ("call the skill tool with name \`orch-lite-executor\`" — canonical, do not restate it) → fenced JSON { feature_id, objective, acceptance_criteria, worktree } plus optional \`depends_on: [feature ids]\` when this task needs another feature's merged work → at most 3 context lines. \`objective\` states the phenomenon, not the fix; criteria must be testable. The dispatch tool IS the role: a dispatch without a package means the child has no contract and no write area. \`explore\` carries no package — read-only.

## Your first action

Call the skill tool with name \`orch-lite\` and follow the manual — ownership, work-area lifecycle, the resume format, the explore lane and the integration flow are defined there.`

/**
 * One line stamped into a freshly started worker's context. The handbook is
 * the truth for feature agents; this only fixes the reporting channel, because
 * a worker that "reports" by calling a tool nobody told it about finishes
 * silent and the coordinator waits forever.
 */
const CHILD_HINT = `[orch-lite] You are a dispatched worker. Follow the contract in your dispatch prompt exactly. Report by ENDING YOUR TURN with the report text — your final message is delivered to the main session verbatim; use send_message only if the prompt named a target for you. Everything you write is English.`

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

export const inject = ['systemPrompt']

/**
 * Register the preset half: protocol, gate, worker hint.
 *
 * The tool (`orch_tool`) and the two manuals are registered by `lib/host.js`,
 * mounted as a HOST row, so every preset can use them. Enforcement is what this
 * row keeps to itself.
 *
 * @param {object} ctx
 */
export function apply(ctx) {
	// --- the always-visible protocol summary ---------------------------------
	ctx.systemPrompt.section({
		name: 'orch-lite:protocol',
		order: 2850,
		interpolate: false,
		text: () => PROTOCOL,
	})

	// --- capability and manuals live in the global layer, not here ------------
	// `lib/host.js` registers the two manuals (skills) and `orch_tool`; a host
	// row's registrations land in the global layer, which every session's
	// catalog merges. What stays preset-scoped is exactly this file: the
	// protocol section, the worker hint and the gate.

	// --- the live preset of a session ----------------------------------------
	// The platform tracks the preset a session RUNS under as the `agentPreset`
	// Session projection; the creation header only names what it STARTED with,
	// and a switch during the blank window outlives that window (see
	// dsh-agent-preset-registry/session). Fall back to the header when no
	// projection service is mounted.
	const livePreset = session => {
		try {
			const state = ctx.sessionProjections?.stateOf?.(session, 'agentPreset')
			return typeof state === 'string' ? state : session?.header?.agentPreset
		} catch {
			return session?.header?.agentPreset
		}
	}

	// --- worker hint: durable conversation context before the first turn -----
	// No audit trail here any more: every denial reaches the model as its own
	// reason, and the desktop build keeps no readable host log — the durable
	// file the gate used to write was a record nobody could read. See DEVLOG.md
	// § v1.1.0.
	ctx.on('agent/created', ({ agent }) => {
		try {
			const header = agent?.session?.header
			if (header === undefined || header === null) return
			const { child } = classifyAgent(header, livePreset(agent.session))
			if (!child) return
			agent.inject(userMessage(CHILD_HINT))
		} catch (error) {
			// A worker that never got the hint still has its dispatch prompt; this
			// must never be a reason to fail the session start.
			ctx.logger?.warn?.(`orch-lite: worker hint could not be injected: ${String(error)}`)
		}
	})

	// --- the gate ------------------------------------------------------------
	ctx.on('tools/pre-execute', async (exec, next) => {
		const header = exec.agent?.session?.header
		const who = classifyAgent(header, livePreset(exec.agent?.session))
		// Fail-open by design: no attributable orch-lite agent, or a dispatched
		// worker (which writes inside its own area and is not routed at all).
		if (!who.known || who.child) return next()

		// Team-only status tools, before the repository probe: the answer does
		// not depend on a working tree. `wait_agent` waits on Team members, and
		// this session's children are ordinary subagents — a disjoint
		// population, so its "nothing active" answer is true and useless. The
		// real signal is the asynchronous `subagent-settled` notice.
		if (TEAM_ONLY_TOOLS.has(exec.name)) {
			return { kind: 'deny', reason: TEAM_ONLY_TOOL_REASON(exec.name) }
		}

		// The Git Worktrees bundle's `create_worktree`, also before the probe:
		// the answer does not depend on a working tree, and the probe is exactly
		// what this call would invalidate — it moves the session into the new
		// checkout, after which every lane resolves against the wrong tree.
		if (RELOCATING_TOOLS.has(exec.name)) {
			return { kind: 'deny', reason: RELOCATING_TOOL_REASON(exec.name) }
		}

		// Resolve the repository for the worker-lane test and for the one
		// repository-state question the gate asks (a dispatch's `depends_on`).
		// Fail open if we cannot determine it (no repository, or bootstrap not
		// allowed here).
		let repo
		try {
			repo = await repositoryFor(ctx, exec, { create: false })
		} catch {
			return next()
		}
		const repoRoot = repo.root

		if (MAIN_WRITE_TOOLS.has(exec.name)) {
			const lane = workerLaneOf(repoRoot, exec.arguments)
			if (lane !== null) {
				return { kind: 'deny', reason: WORKER_LANE_REASON(lane) }
			}
			return next()
		}

		if (SHELL_TOOLS.has(exec.name)) {
			const effect = commandReachesOutside(exec.arguments?.command, WORKTREES_DIR)
			if (effect !== undefined) {
				// Two different accidents share this rule: leaving the repository,
				// and wrecking a lane inside it. Each needs its own correction.
				const reason = effect.includes('worker lane')
					? WORKER_LANE_REASON(`${WORKTREES_DIR}/`)
					: EXTERNAL_EFFECT_REASON(effect)
				return { kind: 'deny', reason }
			}
			return next()
		}

		if (DISPATCH_TOOLS.has(exec.name)) {
			const verdict = evaluateDispatch(exec.arguments?.prompt, exec.arguments?.description, repoRoot)
			if (!verdict.allowed) {
				return { kind: 'deny', reason: verdict.reason }
			}
			// `depends_on` is the one package field whose truth is repository
			// state, so it is the one field the gate looks up instead of parsing.
			const unmet = await unmetDependency(repo, verdict, exec)
			if (unmet !== '') {
				return { kind: 'deny', reason: unmet }
			}
			return next()
		}

		return next()
	})
}

/**
 * The `depends_on` edge, proved against git.
 *
 * A package field saying "this builds on feature a" is only true if `feature/a`
 * is already inside the area's branch — otherwise the area was cut before that
 * fix existed, and the child's acceptance criteria can never pass. That is the
 * whole question, and `git merge-base --is-ancestor` is the whole answer; it
 * counts a commit as its own ancestor, so an area cut straight from its
 * dependency's tip passes.
 *
 * A package with no `depends_on` is untouched: nothing is read from git, so
 * every pre-existing dispatch behaves exactly as before.
 *
 * @param {{git?: import('./git.js').GitRunner, root?: string}} repo the probe
 * @param {{feature_id?: string, depends_on?: string[]}} verdict a passing dispatch verdict
 * @param {object} exec tool execution context
 * @returns {Promise<string>} '' when every edge holds, else the deny reason
 */
async function unmetDependency(repo, verdict, exec) {
	const dependencies = verdict.depends_on ?? []
	if (dependencies.length === 0) return ''
	const featureId = verdict.feature_id
	if (repo.git === undefined || repo.root === undefined) return DEPENDENCY_UNVERIFIABLE_REASON(featureId)
	const branch = `feature/${featureId}`
	try {
		if (!(await hasBranch(repo.git, repo.root, branch, exec.signal))) return NO_AREA_BRANCH_REASON(featureId)
		for (const dependency of dependencies) {
			const dependencyBranch = `feature/${dependency}`
			if (!(await hasBranch(repo.git, repo.root, dependencyBranch, exec.signal))) {
				return DEPENDENCY_MISSING_REASON(featureId, dependency)
			}
			if (!(await isAncestor(repo.git, repo.root, dependencyBranch, branch, exec.signal))) {
				return DEPENDENCY_UNMERGED_REASON(featureId, dependency, branch)
			}
		}
	} catch (error) {
		// A git failure is not an allow: the edge was never proven, and an
		// unproven dependency is exactly the dispatch that burns a whole turn.
		return DEPENDENCY_UNVERIFIABLE_REASON(featureId, String(error?.message ?? error).slice(0, 160))
	}
	return ''
}

/**
 * Whether a write/edit targets a worker lane. Argument shapes differ per tool,
 * and a target the gate cannot read is never a reason to block work.
 *
 * @param {string} repoRoot the repository root (from git rev-parse --show-toplevel)
 * @param {object|undefined} args
 * @returns {string|null}
 */
function workerLaneOf(repoRoot, args) {
	const filePath = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : undefined
	if (filePath === undefined) return null
	try {
		return workerLane({ repoRoot, filePath, worktreesDir: WORKTREES_DIR })
	} catch {
		return null
	}
}
