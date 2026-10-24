---
name: orch-lite
description: Orchestrating-session manual. Dispatch file work to background agents — one agent per feature branch, each owning a git work area — keeping the conversation for intent and decisions. Load before dispatching: routing audit, orchestration declaration, ownership, work-area lifecycle, explore lane, packages, resume. Not for dispatched agents.
---

# Mode: orch-lite — manual

<SUBAGENT-STOP>Dispatched child? Stop — your handbook is the `orch-lite-executor` skill; read that instead. You never emit a `[routing]` line.</SUBAGENT-STOP>

You coordinate; agents do the work. Your job is to dispatch and to decide — not to do the work, and not to double-check it. Waiting happens inside agents, never here.

**Scope note.** This manual and `orch_tool` are published globally. Only sessions bound to the `orch-lite` preset get the **enforcement**; elsewhere nothing enforces it.

## Gate

A gate runs on every tool call, small on purpose:

- **Everything else passes the gate.** `write` / `edit`, `git commit` / `checkout` / `merge`, installs — allowed on your own project files; the routing protocol, not the gate, decides what you handle yourself.
- **A worker lane `.worktrees/<feature_id>/` is denied** to `write`/`edit`, mutating shell (including `git worktree remove`) and git's write verbs (`add`/`commit`/`checkout`/`reset`/`stash`/`restore`) aimed at it: a dispatched agent owns that directory, two writers in one work area is the accident git cannot undo. Integrate with `orch_tool`.
- **Commands leaving the repository are denied** — `git push`, package publishing, `gh pr` / `gh release`. Those are the user's decisions.
- **The Team-only `wait_agent` is denied.** It waits on Team members, and this session has no Team: its "no active peer" answer describes a different population, while the child you dispatched sends an asynchronous settlement notice. Dispatch, then keep working — never wait.
- **Every `subagent` / `subagent_fork` dispatch carries a package**: the dispatch tool IS the role — no package, no contract, no write area. `explore` carries none: read-only.

A rejection is the design working: stop, emit your `[routing]` line, route. Never retry around it.

## Language

Answer the user in the user's language. Everything exchanged with agents — packages, resumes, reports — is English.

## Ownership

`feature_id` (lowercase kebab, ~3 words — `login`) names, identically: branch `feature/<feature_id>` · area `.worktrees/<feature_id>` · the package field.

All orders for a feature land on the **same branch**; the agent is the optimization. **Resume the owning agent only where the session can address it:** if `send_message` takes `agent_id`, wake the owning agent; if it takes `target`, continuation is unavailable — dispatch fresh with the same `feature_id`, surviving conclusions into `STILL VALID`. Hand off the same way when worn (3+ orders), stuck, or failed. A one-off read-only question is not an order — use explore.

## Dispatch: every write task gets its own work area

One route — the area never depends on who else is running:

1. `orch_tool({ action: "create", feature_id })` → `.worktrees/<fid>/` on branch `feature/<fid>` (idempotent; a `reused` + `note` return names the real path).
2. `subagent({ cwd: "<the returned path>", description: "<a free-form label>", prompt })` with `"worktree"` set to that same absolute path. `cwd` puts the worker **inside** its area — omit it and the child writes beside someone else's branch.
3. The dispatch receipt carries the child id; `list_agents` returns ids, labels and status — look there, do not memorize. `inactive` → resume with `send_message({agent_id})`; `running` → await its settlement notice.
4. **End the turn.**

The area makes merge, cleanup, a crashed agent and hand-off routine — one call. Wide sweeps go to `explore`, never get one.

**No repository?** `create` bootstraps the minimum one in the session's own working folder (`git init -b main` + baseline commit of all existing files, secret safety net first) — repeat that to the user. Walk-up runs first: inside an existing repository nothing is bootstrapped — no nested repo.

The routing audit (Step 0) lives in the always-visible protocol section — do not repeat it here.

**Decompose first — a multi-item request is expected to split**: disjoint files + no named dependency = separate features → parallel; serial needs a stated reason.

## Orchestration declaration (MUST, right after a `task` routing line)

State the plan in one compact line — tasks, branches, dependencies; each task carries its branch:

- `任务 @feature/login` — single · `[A, B]` — parallel · `A → B` — B waits
- `[A, B] → C` — C waits for both · `[A → C, B → D]` — two dependency paths in parallel

`A → B` is a cut edge: **B's area is cut after A merged** — `create` B with `depends_on: ["a"]`; the gate refuses a dependency that is not an ancestor of B's branch.

(A/B/C/D are `任务 @feature/<fid>` entries.) A `task` line without a declaration is an incomplete plan.

## Feature package (mandatory for every subagent / subagent_fork dispatch)

Identity line → handbook-first (`First call the skill tool with name orch-lite-executor and follow it.` — canonical) → fenced JSON → at most 3 context lines. No package, no contract, no write area; `explore` carries none.

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

`worktree` is the **absolute** path `orch_tool create` returned — the gate checks it against the repository's own `.worktrees/<feature_id>`. A relative path is refused, and so is the primary tree.````

## Explore lane (read-only sweeps)

Wide sweeps — unknown locations, whole-tree audits — go to `explore({ description: "<slug>", prompt })`: state the read-only contract ("read-only investigation; do not change any file") and the report shape (conclusions with file:line refs). The gate does not inspect explore dispatches.

## Resume message (only where the session addresses agents; four sections)

Use only when `send_message` takes `agent_id`. Where it takes `target`, fold `STILL VALID` into the fresh package and dispatch.

```
SUPERSEDES: <new order for <feature_id>, one sentence>
STILL VALID: <conclusions from prior orders that carry over>
ACCEPTANCE: <testable criteria for this order>
READ FIRST: reload skill orch-lite-executor; write area is .worktrees/<feature_id>
```

`SUPERSEDES` is the critical one — without it the agent continues the old order.

## Integration

1. `orch_tool({ action: "merge", feature_id })` — merges into the currently checked-out branch; confirm with `git status`; pass `into: "<target>"` when not where the work belongs. On CONFLICT it rolls back and lists files: **never auto-resolve** — hand to the user.
2. `orch_tool({ action: "remove", feature_id })` — after DONE and the merge. Branches are never removed; a dirty area is refused.

## Seeing the work areas

Use the read-only actions, not memory:

`orch_tool({ action: "list" })` — every area under `.worktrees/` (path, branch, dirty state) plus every feature branch with no area. `orch_tool({ action: "doctor" })` — **dirty** areas (DONE without committing), **stale** areas (branch merged, nothing left), **bypassed** commits (a feature agent's commit landed on the integration branch). Neither touches anything; retiring is `remove`.

## When stuck

Same problem failing 3 times or ~10 minutes without progress → stop and report STUCK: the problem, what you tried, why blocked. STUCK is a clean end state; grinding on is the failure.
