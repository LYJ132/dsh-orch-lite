---
name: orch-lite
description: Manual for an orch-lite coordinating session. Dispatch file work to background agents — one agent per feature branch, each owning a git work area — and keep the conversation for intent and decisions. Load it before dispatching: routing audit, ownership, work-area lifecycle, explore lane, feature packages, resume/handoff. Not for dispatched agents.
---

# Mode: orch-lite — manual

You coordinate; agents do the work. After dispatching you immediately make your next judgment — waiting happens inside agents, never here.

**Scope note.** This manual and the work-area tool `orch_tool` are published globally: every preset can load the manual and call the tool. Only sessions bound to the `orch-lite` preset get the **enforcement** (worker hint, protocol section, gate). Elsewhere the discipline reads true and the tool works, but nothing enforces it — say so if the user expects enforcement.

## The gate

A gate runs on every tool call, and it is small on purpose:

- **Your project files are yours.** `write` / `edit`, `git commit` / `checkout` / `merge`, installs — all pass. A one-line fix does not need an agent.
- **A worker lane `.worktrees/<feature_id>/` is denied** to `write`/`edit` and to mutating shell: a dispatched agent owns that directory, and two writers in one work area is the accident git cannot undo. Integration goes through `orch_tool`.
- **Commands leaving the repository are denied** — `git push`, package publishing, `gh pr` / `gh release`. Those are the user's decisions.
- **A package carrying `feature_id` is checked** against the Feature package shape (`worktree` is required). Any other dispatch is not the gate's business.

A rejection is the design working: stop, emit your `[routing]` line, route. Never retry around it. Read-only shell always passes.

## Language

Answer the user in the user's language. Everything exchanged with agents — packages, resumes, reports — is English.

## Ownership: one feature, one agent, one branch

`feature_id` (lowercase kebab, ~3 words — `login`) names, identically: branch `feature/<feature_id>` · work area `.worktrees/<feature_id>` · the package field.

All orders for a feature — capability, bug fixes, docs — land on the **same branch**; the agent is the optimization. **Resume the owning agent only where the session can address it:** if `send_message` takes `agent_id`, wake the agent that owns the feature (it commits serially with its context intact); if it takes `target` (the Team-style tool), continuation is unavailable — dispatch a fresh agent with the same `feature_id` and carry the surviving conclusions into `STILL VALID`. Hand off the same way when the agent is worn (3+ orders), stuck, or failed. Never chain unrelated features onto one agent. A one-off read-only question is not an order — use explore.

Two invariants carry the rest: work is **committed before DONE** (you retire work areas; uncommitted work dies with them), and a **lane belongs to its agent** until `orch_tool({ action: "remove" })` retires it.

## Dispatch: every write task gets its own work area

One route — the work area never depends on who else is running:

1. `orch_tool({ action: "create", feature_id })` → `.worktrees/<fid>/` on branch `feature/<fid>` (idempotent; a `reused` + `note` return names the real path).
2. `subagent({ description: "<a free-form label saying what the agent does>", prompt })` with `"worktree"` set to that exact path. The description is free-form and is not bound to `feature_id` — the package's `feature_id` is what names the branch and the work area.
3. If the feature already has an agent, check the roster where one exists: `inactive` → resume it; `running` → await its settlement notice.

The area makes merge, cleanup, a crashed agent and a hand-off routine — it costs one call. Wide read-only sweeps go to `explore` and never get one.

**No repository yet?** `create` establishes the minimum one (`git init -b main` + a baseline commit staging only `.gitignore`; existing files stay untracked) and the result says so — repeat that to the user. It refuses a folder that holds user files: a scattered `.git` is not reversible.

## Step 0: the routing audit

Every reply starts with exactly one line: `[routing] chat` (conversation/narrow direct read) · `[routing] explore <slug>` (wide read) · `[routing] task <fid>` (first dispatch) · `[routing] resume <fid>` (order to existing agent) · `[routing] orchestration <fid>, <fid>, …` (parallel features).

**Decompose first — a multi-item request is expected to split**: disjoint files + no named dependency = separate features → parallel (each its own area); serial needs a stated reason. Piling unrelated items onto one agent lengthens its context and the user's wait. Forgot the line? Emit it late; silence is the violation.

## Feature package

Identity line → handbook-first (`First call the skill tool with name orch-lite-executor and follow it.` — canonical) → fenced JSON → at most 3 context lines (file-unreachable facts only).

````
You are the login feature agent.
First call the skill tool with name orch-lite-executor and follow it.

```json
{
  "feature_id": "login",
  "objective": "login API returns 500 when the password contains a colon",
  "acceptance_criteria": [
    "POST /api/login returns 200 for a colon-bearing password",
    "the existing 401 path still returns 401"
  ],
  "worktree": ".worktrees/login"
}
```
````

`objective` states the phenomenon, not the fix; criteria must be testable ("returns 200", never "fixed").

## Explore lane (read-only sweeps)

Wide sweeps — unknown locations, whole-tree audits — go to `explore({ description: "<slug>", prompt })`: state the read-only contract ("this is a read-only investigation; do not change any file") and the report shape (conclusions with file:line references). The platform decides continuability by provider (`spawn` defines `prepareContinuable`, so the explore agent is continuable); there is no `backgroundMode` config and no `run_in_background` parameter. The gate does not inspect explore dispatches — they carry no work area and no package contract. Narrow reads stay yours.

## Resume message (only where the session addresses agents; four sections)

Use this shape only when `send_message` takes `agent_id`. Where it takes `target` (the Team-style tool), fold `STILL VALID` into the fresh package's context lines instead and dispatch.

```
SUPERSEDES: <new order for <feature_id>, one sentence>
STILL VALID: <conclusions from prior orders that carry over>
ACCEPTANCE: <testable criteria for this order>
READ FIRST: reload skill orch-lite-executor; write area is .worktrees/<feature_id>
```

`SUPERSEDES` is the critical one — without it the agent continues the old order.

## Integration

1. `orch_tool({ action: "merge", feature_id })` — merges into the currently checked-out branch; confirm with read-only `git status`, pass `into: "<target>"` when that is not where the work belongs. On CONFLICT it rolls back and lists files: **never auto-resolve** — hand it to the user.
2. `orch_tool({ action: "remove", feature_id })` — after DONE and after the merge. Branches are never removed; a dirty area is refused (resume the agent to commit first).

## Seeing the work areas

Use the read-only actions instead of remembering the state.

- `orch_tool({ action: "list" })` — every area under `.worktrees/` (path, branch, dirty state) plus every feature branch with no area.
- `orch_tool({ action: "doctor" })` — **dirty** areas (DONE without committing), **stale** areas (branch merged, nothing left), **bypassed** commits (a feature agent's commit landed on the integration branch).

Neither takes a `feature_id` or touches anything; `doctor` never removes — retiring is `remove`, your call.

## When stuck

Same problem failing 3 times or ~10 minutes without progress → stop and report STUCK: the problem, what you tried, why it is still blocked. STUCK is a clean end state; grinding on is the failure.
