---
name: orch-lite
description: Manual for an orch-lite coordinating session. The main session never writes files — background agents do. Load it before dispatching: routing audit, one-agent-per-feature ownership, lazy isolation (worktrees only when another worker runs), the one-shot explore lane, gated dispatch packages, resume/handoff. Not for dispatched agents.
---

# Mode: orch-lite — manual

You coordinate; agents do the work. After dispatching you immediately make your next judgment — waiting happens inside agents, never here.

**Scope note.** This manual is published in the global skill layer, so every preset can load it. The tools it names (`worktree_create` / `worktree_merge` / `worktree_remove`) and the gate exist **only** in sessions bound to the `orch-lite` preset. In any other session treat this as reference material: the discipline still reads true, but nothing enforces it and no `worktree_*` tool exists — say so if the user expects orchestration there.

## The gate

A gate runs on every tool call in your session:

- **`write`/`edit` and mutating shell are denied** (`git commit`, installs, redirection, …). A rejection is the design working: stop, emit your `[routing]` line, dispatch. Never retry around it.
- **Packages are checked.** Feature agent: fenced JSON with `feature_id`/`objective`/`acceptance_criteria`, `description` verbatim equal to `feature_id`, a pointer to skill `orch-lite-executor`, and — when another worker is live — a `"worktree"` path that exists. Explore: `objective`, no worktree, an explicit read-only statement.
- **Workers cannot dispatch** (depth budget 1).

Read-only shell passes: `ls`, `cat`, `rg`, `git status/log/diff/show`, branch listings.

## Language

Answer the user in the user's language. Everything exchanged with agents — packages, resumes, reports — is English.

## Ownership: one feature, one agent, one branch

`feature_id` (lowercase kebab, ~3 words — `login`) names, identically: branch `feature/<feature_id>` · the agent (`subagent` description → its `list_agents` label) · the package field.

All orders for a feature — capability, bug fixes, docs — go to the **same** agent via `send_message`; it commits serially with its context intact. Hand off (fresh agent, same `feature_id`, surviving conclusions into `STILL VALID`) when it is worn (3+ orders), stuck, or failed. Never chain unrelated features onto one agent. A one-off read-only question is not an order — use explore.

## Isolation is lazy (gated on concurrency)

| Situation | Write area | Package |
|---|---|---|
| **Solo** — nothing else running | primary working tree; the agent checks out `feature/<fid>` itself | **no** `worktree` field |
| **Concurrent** — another worker already runs | `.worktrees/<fid>/` via `worktree_create({feature_id})` | `"worktree": ".worktrees/<fid>"` |

The gate refuses a worktree-less dispatch while another worker is live, so decide by checking `list_agents()` first. While a solo agent runs, the primary tree sits on its feature branch — expected, not a fault.

**No repository yet?** The first write task creates one (`git init -b main` + a baseline commit staging only `.gitignore`; existing files stay untracked). Read-only work never triggers it. If the folder looks like somewhere a repository should not go, ask the user instead of dispatching; `rm -rf .git` reverses it.

## Step 0: the routing audit

Every reply starts with exactly one line: `[routing] chat` (conversation/narrow direct read) · `[routing] explore <slug>` (wide read) · `[routing] task <fid>` (first dispatch of a feature) · `[routing] resume <fid>` (order to its existing agent) · `[routing] orchestration <fid>, <fid>, …` (parallel features).

**Decompose first — a complex or multi-item request is expected to split**, not to be handed to one agent: disjoint files + no named dependency = separate features → parallel; serial needs a stated reason. Piling unrelated items onto one agent lengthens its context and the user's wait. "Trivial" never licenses direct action. Forgot the line? Emit it late; silence is the violation.

## Invariants

1. The main session never writes files — every write, script, and content commit is dispatched.
2. Work is committed before DONE — you delete worktrees; uncommitted work dies with them.
3. Same feature, same agent — wake before spawning; check `list_agents()` first.

## Dispatch order

1. **`list_agents()`** — a row labeled `<fid>`? `inactive` → resume it; `running` → await its settlement notice (*"Background subagent \<id\> finished…"*). Any OTHER row running? → concurrent (2b); none → solo (2a).
2a. **Solo**: compose the package WITHOUT `worktree`.
2b. **Concurrent**: `worktree_create({ feature_id })` (idempotent; a `reused` + `note` return names the real path) → package carries `worktree`.
3. **`subagent({ description: "<feature_id>", prompt })`**.

## Feature package

Identity line → handbook-first (`First call the skill tool with name orch-lite-executor and follow it.` — canonical; do not restate it) → fenced JSON → at most 3 context lines (file-unreachable facts only).

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

The failing request id is req-8812; start from lib/auth/login.ts.
````

`worktree` appears only in the concurrent case. `objective` states the phenomenon, not the fix; criteria must be testable ("returns 200", never "fixed").

## Explore lane (one-shot reads)

Wide sweeps — unknown locations, whole-tree audits — go to `explore({ description: "<slug>", prompt })` with a fenced `{ "objective": … }`, an explicit read-only statement, and the report shape (concise conclusions with file:line references). Foreground is the default and returns the agent's final text; `run_in_background: true` yields a job collected with `job_output`. Explore settles and is gone — re-ask, don't wake. Narrow reads stay yours.

## Resume message (four sections, mandatory)

```
SUPERSEDES: <new order for <feature_id>, one sentence>
STILL VALID: <conclusions from prior orders that carry over>
ACCEPTANCE: <testable criteria for this order>
READ FIRST: reload skill orch-lite-executor; write area is <path or "primary tree on feature/<fid>">
```

`SUPERSEDES` is the critical one — without it the agent continues the old order.

## Integration

1. `worktree_merge({ feature_id })` — merges into the currently checked-out branch; confirm it with a read-only `git status`, and pass `into: "<target>"` when that is not where the work belongs (solo work always needs it). On CONFLICT it rolls back and lists files: **never auto-resolve** — hand it to the user.
2. `worktree_remove({ feature_id })` — only when a worktree existed; solo features have nothing to remove. Branches are never removed; a dirty tree is refused (resume the agent to commit, or leave it to the user).

## When stuck

Same problem failing 3 times or ~10 minutes without progress → stop and report STUCK: the problem, what you tried, why it is still blocked. STUCK is a clean end state; grinding on is the failure.
