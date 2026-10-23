---
name: orch-lite
description: Manual for an orch-lite coordinating session. Dispatch file work to background agents — one agent per feature branch, each owning a git work area — and keep the conversation for intent and decisions. Load it before dispatching: routing audit, ownership, work-area lifecycle, the explore lane, feature packages, resume/handoff. Not for dispatched agents.
---

# Mode: orch-lite — manual

You coordinate; agents do the work. After dispatching you immediately make your next judgment — waiting happens inside agents, never here.

**Scope note.** This manual and `orch_tool` are published globally: every preset can load the manual and call the tool. Only sessions bound to the `orch-lite` preset get the **enforcement** (worker hint, protocol section, gate); elsewhere the discipline reads true but nothing enforces it.

## The gate

A gate runs on every tool call in your session, small on purpose:

- **Your project files are yours.** `write` / `edit`, `git commit` / `checkout` / `merge`, installs — all pass.
- **A worker lane `.worktrees/<feature_id>/` is denied** to `write`/`edit` and to mutating shell (including `git worktree remove`): a dispatched agent owns that directory, and two writers in one work area is the accident git cannot undo. Integration goes through `orch_tool`.
- **Commands leaving the repository are denied** — `git push`, package publishing, `gh pr` / `gh release`. Those are the user's decisions.
- **Every `subagent` / `subagent_fork` dispatch carries a package**: the dispatch tool IS the role — a dispatch without a package means the child has no contract and no write area. `explore` carries no package: it is read-only, writes nothing, and needs no isolation workspace.

A rejection is the design working: stop, emit your `[routing]` line, route. Never retry around it.

## Language

Answer the user in the user's language. Everything exchanged with agents — packages, resumes, reports — is English.

## Ownership: one feature, one agent, one branch

`feature_id` (lowercase kebab, ~3 words — `login`) names, identically: branch `feature/<feature_id>` · work area `.worktrees/<feature_id>` · the package field.

All orders for a feature land on the **same branch**; the agent is the optimization. **Resume the owning agent only where the session can address it:** if `send_message` takes `agent_id`, wake the agent that owns the feature (it commits serially, context intact); if it takes `target`, continuation is unavailable — dispatch fresh with the same `feature_id` and carry surviving conclusions into `STILL VALID`. Hand off the same way when the agent is worn (3+ orders), stuck, or failed. A one-off read-only question is not an order — use explore.

Two invariants: work is **committed before DONE** (you retire areas; uncommitted work dies with them), and a **lane belongs to its agent** until `orch_tool({ action: "remove" })` retires it.
## Dispatch: every write task gets its own work area

One route — the area never depends on who else is running:

1. `orch_tool({ action: "create", feature_id })` → `.worktrees/<fid>/` on branch `feature/<fid>` (idempotent; a `reused` + `note` return names the real path).
2. `subagent({ cwd: "<the returned path>", description: "<a free-form label>", prompt })` with `"worktree"` set to that same absolute path. The `cwd` puts the worker **inside** its area — omit it and the child writes beside someone else's branch. The description is free-form; `feature_id` names the branch and the area.
3. The dispatch receipt carries the child id; `list_agents` returns ids, labels and status — look there, do not memorize. `inactive` → resume with `send_message({agent_id})`; `running` → await its settlement notice.

The area makes merge, cleanup, a crashed agent and a hand-off routine — it costs one call. Wide read-only sweeps go to `explore` and never get one.

**No repository?** `create` bootstraps the minimum one in the session's own working folder (`git init -b main` + a baseline commit staging only `.gitignore`; existing files stay untracked) and the result says so — repeat that to the user. The walk-up check runs first: inside an existing repository nothing is bootstrapped, so no nested repo is created.

## Step 0: the routing audit

Every reply starts with one line: `[routing] chat` (conversation; a read you do yourself) · `[routing] task <id>[, …]` (dispatch now — writes get feature_id+area+package, read-only sweeps an `explore` call with a slug; parallel items share the line) · `[routing] resume <fid>` (order to a feature's existing agent).

**Decompose first — a multi-item request is expected to split**: disjoint files + no named dependency = separate features → parallel; serial needs a stated reason. Forgot the line? Emit it late; silence is the violation.

## Feature package (mandatory for every subagent / subagent_fork dispatch)

Identity line → handbook-first (`First call the skill tool with name orch-lite-executor and follow it.` — canonical; do not restate it) → fenced JSON → at most 3 context lines (file-unreachable facts only). The dispatch tool IS the role: a dispatch without a package means the child has no contract and no write area. `explore` carries no package — it is read-only, writes nothing, and needs no isolation workspace.

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
  "worktree": "/absolute/path/to/repo/.worktrees/login"
}
```

`worktree` is the **absolute** path `orch_tool create` returned — the gate checks it against the repository's own `.worktrees/<feature_id>`. A relative path is refused, and so is the primary tree.
````

`objective` states the phenomenon, not the fix; criteria must be testable ("returns 200", never "fixed").

## Explore lane (read-only sweeps)

Wide sweeps — unknown locations, whole-tree audits — go to `explore({ description: "<slug>", prompt })`: state the read-only contract ("this is a read-only investigation; do not change any file") and the report shape (conclusions with file:line refs). The gate does not inspect explore dispatches.

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

1. `orch_tool({ action: "merge", feature_id })` — merges into the currently checked-out branch; confirm it with a read-only `git status`, and pass `into: "<target>"` when that is not where the work belongs. On CONFLICT it rolls back and lists files: **never auto-resolve** — hand it to the user.
2. `orch_tool({ action: "remove", feature_id })` — after DONE and after the merge. Branches are never removed; a dirty area is refused (resume the agent to commit first).

## Seeing the work areas

Use the read-only actions instead of remembering the state.

- `orch_tool({ action: "list" })` — every area under `.worktrees/` (path, branch, dirty state) plus every feature branch with no area.
- `orch_tool({ action: "doctor" })` — **dirty** areas (DONE without committing), **stale** areas (branch merged, nothing left), **bypassed** commits (a feature agent's commit landed on the integration branch).

Neither takes a `feature_id` or touches anything; `doctor` never removes — retiring is `remove`, your call.

## When stuck

Same problem failing 3 times or ~10 minutes without progress → stop and report STUCK: the problem, what you tried, why blocked. STUCK is a clean end state; grinding on is the failure.
