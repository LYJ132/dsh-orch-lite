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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
 * The manual is the single source of truth for the contract text — the same
 * rule upstream follows (`session-init.py` extracts SKILL.md sections
 * verbatim; the hook holds no second copy). Nothing in this file restates a
 * contract section, so the injected text cannot drift from the manual.
 */
const MANUAL_PATH = new URL('../skills/orch-lite/SKILL.md', import.meta.url)

/**
 * Contract sections injected at session start, in injection order: the
 * routing audit opens, then the gate boundaries, then the dispatch package —
 * attention-critical content first, as upstream's hook does.
 */
const CONTRACT_SECTIONS = [
	['## Step 0: the routing audit', 'Routing audit'],
	['## Gate', 'Gate'],
	['## Feature package', 'Dispatch package'],
]

/** The manual's text, or '' when it cannot be read (fail-soft). */
function readManual() {
	try {
		return readFileSync(fileURLToPath(MANUAL_PATH), 'utf8')
	} catch {
		return ''
	}
}

/**
 * One section of the manual, verbatim: from its heading to the next `## `
 * heading or horizontal rule. '' when the heading is absent — the caller
 * renders a one-line marker instead, so a missing section can never become a
 * silently empty contract.
 *
 * @param {string} headingPrefix
 * @returns {string}
 */
function manualSection(headingPrefix) {
	const lines = readManual().split('\n')
	const start = lines.findIndex(line => line.trim().startsWith(headingPrefix))
	if (start === -1) return ''
	const section = [lines[start]]
	for (const line of lines.slice(start + 1)) {
		const stripped = line.trim()
		if (stripped === '---' || stripped.startsWith('## ')) break
		section.push(line)
	}
	return section.join('\n').trim()
}

/**
 * The session-start contract, injected as a durable user message for the
 * ORCHESTRATING session — the in-process equivalent of upstream's
 * SessionStart `additionalContext`.
 *
 * Why a message and not just the systemPrompt section: a section at order
 * 2850 sits in the middle of the system prompt and gets read as background
 * context, so the model answered without the `[routing]` line. A message
 * delivered at session start lands next to the user's first request, where
 * the model treats it as the instruction for that turn.
 *
 * @returns {string}
 */
function sessionContract() {
	const parts = [
		'[orch-lite] Session contract — a standing instruction, not a user request. Do not answer or acknowledge this message; follow it in every reply.',
	]
	for (const [heading, label] of CONTRACT_SECTIONS) {
		const text = manualSection(heading)
		parts.push(
			`--- ${label} (from the manual) ---\n${text || `(section "${heading}" is missing from skills/orch-lite/SKILL.md)`}`,
		)
	}
	return parts.join('\n\n')
}

/**
 * The always-visible systemPrompt section: the worker guard, the job
 * statement and a pointer to the injected contract. The contract text itself
 * lives in exactly one place (the manual, injected at session start), so
 * nothing is duplicated here.
 *
 * `interpolate: false` — the text carries JSON braces that must never be
 * treated as `{{variable}}` syntax. This row registers the section, so
 * mounting the `orch-lite` preset is what makes it appear; it is deliberately
 * NOT gated on tool visibility (the tool is registered by the host half and is
 * therefore global, so visibility cannot discriminate — and a guard that
 * silently renders `''` was a documented failure mode). See DEVLOG.md.
 */
const PROTOCOL_POINTER = `# Mode: orch-lite

**Dispatched child? Stop.** If your context begins with "[orch-lite] You are a dispatched worker", this section is not yours — your handbook is \`orch-lite-executor\`, and you never emit a \`[routing]\` line.

You coordinate; dispatched agents do the file changes. Your job is to dispatch and to decide — not to do the work, and not to double-check it. Your standing contract (routing audit, gate, dispatch package) was injected as the first message of this session and is the authority. If that message is absent, the same contract lives in the manual. Call the skill tool with name \`orch-lite\`.
`

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
		text: () => PROTOCOL_POINTER,
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

	// --- session-start context: durable conversation context before turn 1 ----
	// The orchestrating session gets the contract itself (routing audit, gate,
	// dispatch package — extracted from the manual), the way upstream's
	// SessionStart hook delivers `additionalContext`. A dispatched worker gets
	// only the reporting hint: its handbook is the contract.
	//
	// No audit trail here any more: every denial reaches the model as its own
	// reason, and the desktop build keeps no readable host log — the durable
	// file the gate used to write was a record nobody could read. See DEVLOG.md
	// § v1.1.0.
	ctx.on('agent/created', ({ agent }) => {
		try {
			const header = agent?.session?.header
			if (header === undefined || header === null) return
			const { known, child } = classifyAgent(header, livePreset(agent.session))
			if (!known) return
			agent.inject(userMessage(child ? CHILD_HINT : sessionContract()))
		} catch (error) {
			// A session that never got its contract still has the manual and the
			// protocol pointer; this must never be a reason to fail the start.
			ctx.logger?.warn?.(`orch-lite: session context could not be injected: ${String(error)}`)
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
