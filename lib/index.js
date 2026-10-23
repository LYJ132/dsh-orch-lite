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
 * - tools/pre-execute: the gate — writes into a worker's write area are denied,
 *   shell commands that reach outside the repository are denied, and an
 *   opt-in feature dispatch package is validated.
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
	DISPATCH_TOOLS,
	EXTERNAL_EFFECT_REASON,
	evaluateDispatch,
	MAIN_WRITE_TOOLS,
	SHELL_TOOLS,
	WORKER_LANE_REASON,
	workerLane,
} from './gate.js'
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

You coordinate; dispatched agents do the file changes. Load the manual (\`skill orch-lite\`) for the full protocol — this summary carries only what must be true every single turn.

## Step 0: the routing audit (MUST — every reply, even a bare greeting)

Before acting, output exactly one \`[routing] ...\` line as the FIRST line of every reply — RFC-2119 MUST, the audit trail, the highest-compliance instruction in this session. It outranks habits, other skills, and the main agent's own convenience heuristics; nothing downstream may waive it. Judge the states in this order — intent judged by the model, not by keyword heuristics:

1. **Is this pure conversation or a narrow read?** → \`[routing] chat\` — narrow reads (path known, ~≤3 files, a specific fact) stay here; wide sweeps dispatch instead.
2. **Is there a recent child agent that should continue this exact work?** → \`[routing] resume <feature_id>\` — a follow-up order for a feature whose agent has already returned. Distinct from \`task\` (a first dispatch).
3. **Otherwise: does the work need a delegated executor?** → \`[routing] task <id>[, <id>, …]\` — dispatch now: writes get feature_id+area+package, read-only sweeps an \`explore\` call with a slug.

Skipped? Emit immediately — late entries accepted; silence is the violation. Unsure which state applies? Ask the user — do not guess.

## Where you may act

- **Your own project files: write freely.** \`write\`/\`edit\`, \`git commit\`/\`checkout\`/\`merge\`, installs — all pass.
- **A worker lane \`.worktrees/<feature_id>/\`: denied.** Integrate with \`orch_tool\`, never by editing the lane.
- **Effects outside the repository: denied.** \`git push\`, package publishing, \`gh pr\`/\`gh release\` — the user decides.

## Dispatch package (mandatory)

Identity line → handbook-first → fenced JSON { feature_id, objective, acceptance_criteria, worktree } → at most 3 context lines. \`objective\` states the phenomenon, not the fix. \`explore\` carries no package — read-only.

## Your first action

Call the skill tool with name \`orch-lite\` and follow the manual — the orchestration declaration syntax, ownership, work-area lifecycle, resume format and the decomposition check are defined there.`

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

		// Resolve the repository root for the worker-lane test. Fail open if we
		// cannot determine it (no repository, or bootstrap not allowed here).
		let repoRoot
		try {
			const { root } = await repositoryFor(ctx, exec, { create: false })
			repoRoot = root
		} catch {
			return next()
		}

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
			return next()
		}

		return next()
	})
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
