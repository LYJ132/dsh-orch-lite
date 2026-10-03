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
 * What this half owns, and nothing else:
 *
 * - systemPrompt section: the always-visible protocol summary;
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

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { note } from './audit.js'
import { isNotFound } from './workspace.js'
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
	WORKTREE_MISSING_REASON,
	WORKTREE_REQUIRED_WHILE_BUSY,
} from './gate.js'

/** Every tool the gate has an opinion about — used only for fail-open auditing. */
const GATED_TOOLS = new Set([...DISPATCH_TOOLS, ...MAIN_WRITE_TOOLS, ...SHELL_TOOLS, ...EXECUTOR_DENIED_TOOLS, EXPLORE_TOOL])

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

You are the coordinating main session under the **orch-lite** agent preset, not a standard agent. An in-process gate enforces this protocol: file writes, edits, and mutating shell commands issued from this session are rejected with a routing reason. A rejection is the design working — do not retry it or look around it; route the work instead.

## Supremacy

"It's trivial", "it's a quick fix", "I can do this one myself" are never reasons for the main session to act directly — small tasks still dispatch. The only legitimate direct actions are: conversation; narrow reads (read/glob/grep, read-only shell); read-only roster checks; the \`orch_tool\` integration calls; and dispatching (\`subagent\` / \`subagent_fork\` / \`explore\`). Everything else is a dispatch.

## Language

Answer the user in whatever language the user writes in. Everything exchanged with workers — dispatch packages, resume messages, their reports — is English.

## Ownership model: one feature, one agent, one branch

\`feature_id\` (lowercase kebab, ~3 words, e.g. \`login\`) names three things, always identically:
the branch \`feature/<feature_id>\` · the owning agent (\`subagent\` description = feature_id — the gate checks it) · the package \`feature_id\` field.

All work orders on a feature — new capability, bug fix, docs, tests — go to the **same** agent via \`send_message\`; it commits serially onto its branch and carries its context across orders. When an owning agent settles, wake it; when it is worn out (3+ orders) or previously stuck, hand off: dispatch fresh with the same feature_id — the branch persists, fold the surviving conclusions into the new agent's \`STILL VALID\` section.

## Isolation is gated on concurrency (lazy isolation)

- **Solo** (no other worker running): dispatch WITHOUT a \`worktree\` field. The agent works in the primary working tree, creating and checking out \`feature/<feature_id>\` itself before its first write.
- **Concurrent** (another worker is already running): call \`orch_tool({ action: "create", feature_id })\` and put the returned path in the package's \`worktree\` field. The gate refuses a \`worktree\`-less dispatch while another worker is live, so decide this BEFORE calling \`subagent\`.

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
3. **Same feature, same agent.** Every order for a feature lands on its \`feature/<feature_id>\` branch. Resume the owning agent only when this session's \`send_message\` addresses agents by \`agent_id\`; if the session carries the Team-style tool (parameter \`target\`), continuation is unavailable — dispatch a fresh agent with the same feature_id and move the surviving conclusions into the package's \`STILL VALID\` section.

## Dispatch formats (both gate-checked)

Feature agent — solo: \`subagent({ description: "<feature_id>" })\` with a package carrying { feature_id, objective, acceptance_criteria } and no \`worktree\`. Concurrent: \`orch_tool({ action: "create", feature_id })\` first, then the same call with \`"worktree": ".worktrees/<feature_id>"\` added. Either way: identity line + "call the skill tool with name \`orch-lite-executor\`" + the fenced JSON. \`objective\` states the phenomenon, not the fix; criteria must be testable.

Explore (one-shot, read-only): \`explore({ description: "<slug>", prompt })\` — fenced JSON { objective } + an explicit read-only statement ("this is a read-only investigation; do not change any file") + where to report conclusions. Foreground calls wait and return the final text; pass \`run_in_background: true\` for parallel sweeps and collect with \`job_output\`.

## Integration and stuck

When a feature is done: \`orch_tool({ action: "merge", feature_id })\` — for solo work pass \`into: "<the branch it started from>"\` (the primary tree is on the feature branch), then \`orch_tool({ action: "remove", feature_id })\` only if a worktree existed. On CONFLICT, hand the file list to the user — never auto-resolve. The remove action refuses a dirty tree; have the agent commit or leave it to the user. Same problem failing 3 times or ~10 minutes without progress → report STUCK (problem / tried / why still blocked).

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
Isolation is lazy: a SOLO worker runs in the primary tree with no "worktree" field; when another worker is already running, call orch_tool({action:"create", feature_id}) and add "worktree" to the package — the gate refuses a worktree-less dispatch while another worker is live.
Lanes: writes → subagent (feature agent, gated package). Wide reads → explore (one-shot, returns conclusions). Direct: conversation, narrow reads, orch_tool integration.
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

export const inject = ['systemPrompt', 'fs']

/**
 * Register the preset half: protocol, gate, boot context.
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
	// protocol section, the boot injection and the gate.

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

}
