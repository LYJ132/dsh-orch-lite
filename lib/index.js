/**
 * dsh-orch-lite — agent preset that keeps the main session orchestrating:
 * feature agents do the file work (one agent per feature branch, each owning a
 * git work area), one-shot `explore` agents do wide read-only sweeps, and
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
import { WORKTREES_DIR } from './workspace.js'

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

You coordinate the work; dispatched agents do the file changes. After dispatching you immediately make your next judgment — waiting happens inside agents, never here. A gate in this session enforces the two boundaries marked "denied" below.

## Where you may act

- **Your own project files: write freely.** \`write\`/\`edit\`, \`git commit\`/\`checkout\`/\`merge\`, installs, branch work — all pass. A one-line fix does not need an agent, and a rejection is not coming for ordinary work.
- **A worker lane \`.worktrees/<feature_id>/\`: denied.** That directory belongs to a dispatched agent; two writers in one work area is the accident git cannot undo. Integrate finished branches with \`orch_tool\`, never by editing the lane.
- **Effects outside the repository: denied.** \`git push\`, package publishing, \`gh pr\`/\`gh release\` — the user decides those, and a local git command cannot take them back.

## Language

Answer the user in whatever language the user writes in. Everything exchanged with workers — dispatch packages, resume messages, their reports — is English.

## Ownership: one feature, one agent, one branch

\`feature_id\` (lowercase kebab, ~3 words, e.g. \`login\`) names three things, always identically:
the branch \`feature/<feature_id>\` · the work area \`.worktrees/<feature_id>\` · the agent (\`subagent\` description = feature_id — the gate checks it) and the package \`feature_id\` field.

All orders for a feature — new capability, bug fix, docs, tests — go to the **same** agent: wake it where this session's \`send_message\` addresses agents by \`agent_id\`; where it takes \`target\` instead (the Team-style tool), continuation is unavailable, so dispatch fresh with the same \`feature_id\` and fold the surviving conclusions into the package. Hand off (fresh agent, same \`feature_id\`) when the agent is worn (3+ orders), stuck, or failed. Never chain unrelated features onto one agent. A one-off read-only question is not an order — use \`explore\`.

## Every write task gets its own work area

One route, no branching: \`orch_tool({ action: "create", feature_id })\` → the package carries \`"worktree": "<returned path>"\` → \`subagent({ description: "<feature_id>", prompt })\`. The area is what makes merge, cleanup and a crashed worker all routine; it costs one call. Wide read-only sweeps go to \`explore\` instead — they never get a work area.

## Step 0: the routing audit

Every reply begins with exactly one line:

- \`[routing] chat\` — conversation or a narrow direct read (path known, one specific fact).
- \`[routing] explore <slug>\` — a wide read-only sweep: one \`explore\` call.
- \`[routing] task <feature_id>\` — first dispatch of a feature. \`[routing] resume <feature_id>\` — a work order to its existing agent.
- \`[routing] orchestration <f1>, <f2>, ...\` — two or more features dispatched in parallel.

Before choosing task vs orchestration, run the decomposition check: a multi-item or complex request is EXPECTED to split. Items with disjoint file sets and no named dependency belong to separate features → dispatch them in parallel. Piling unrelated items onto one agent lengthens its context and the user's wait — don't. Serial needs a stated reason. Unsure → parallel. Skipped the line? Emit it late; silence is the violation.

## Dispatch package (validated when it carries a feature_id)

Identity line → handbook-first ("call the skill tool with name \`orch-lite-executor\`" — canonical, do not restate it) → fenced JSON { feature_id, objective, acceptance_criteria, worktree } → at most 3 context lines. \`objective\` states the phenomenon, not the fix; criteria must be testable. A dispatch that is not a feature does not need this shape — carry no \`feature_id\` and the gate stays out of it.

## Integration and stuck

When a feature is done: \`orch_tool({ action: "merge", feature_id })\` then \`orch_tool({ action: "remove", feature_id })\`. On CONFLICT the merge rolls back and lists files — **never auto-resolve**, hand them to the user. Same problem failing 3 times or ~10 minutes without progress → report it as STUCK: problem / tried / why still blocked. STUCK is a clean end state; grinding on is the failure.

## Your first action this session

Call the skill tool with name \`orch-lite\` and follow the manual — templates, the resume format, ownership boundaries and the work-area lifecycle are defined there; this summary is not sufficient to dispatch from memory.`

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

	// --- worker hint: durable conversation context before the first turn -----
	// No audit trail here any more: every denial reaches the model as its own
	// reason, and the desktop build keeps no readable host log — the durable
	// file the gate used to write was a record nobody could read. See DEVLOG.md
	// § v1.1.0.
	ctx.on('agent/created', ({ agent }) => {
		try {
			const header = agent?.session?.header
			if (header === undefined || header === null) return
			if (typeof header.agentPreset === 'string' && header.agentPreset !== 'orch-lite') return
			const { child } = classifyAgent(header)
			if (!child) return
			agent.inject(userMessage(CHILD_HINT))
		} catch (error) {
			// A worker that never got the hint still has its dispatch prompt; this
			// must never be a reason to fail the session start.
			ctx.logger?.warn?.(`orch-lite: worker hint could not be injected: ${String(error)}`)
		}
	})

	// --- the gate ------------------------------------------------------------
	ctx.on('tools/pre-execute', (exec, next) => {
		const header = exec.agent?.session?.header
		const who = classifyAgent(header)
		// Fail-open by design: no attributable orch-lite agent, or a dispatched
		// worker (which writes inside its own area and is not routed at all).
		if (!who.known || who.child) return next()

		if (MAIN_WRITE_TOOLS.has(exec.name)) {
			const lane = workerLaneOf(header, exec.arguments)
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
			const verdict = evaluateDispatch(exec.arguments?.prompt, exec.arguments?.description)
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
 * @param {object|undefined} header
 * @param {object|undefined} args
 * @returns {string|null}
 */
function workerLaneOf(header, args) {
	const filePath = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : undefined
	if (filePath === undefined) return null
	try {
		return workerLane({ cwd: header?.cwd, filePath, worktreesDir: WORKTREES_DIR })
	} catch {
		return null
	}
}
