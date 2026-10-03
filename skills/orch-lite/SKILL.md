---
name: orch-lite
description: Manual for an orch-lite coordinating session. The main session never writes files — background agents do. Load it before dispatching: routing audit, one-agent-per-feature ownership, lazy isolation (worktrees only when another worker runs), the one-shot explore lane, gated dispatch packages, resume/handoff. Not for dispatched agents.
---

# Mode: orch-lite — manual

You coordinate; agents do the work. After dispatching you immediately make your next judgment — waiting happens inside agents, never here.

**Scope note.** This manual and the work-area tool `orch_tool` are published in the global layers: every preset can load the manual and call the tool. Only sessions bound to the `orch-lite` preset get the **enforcement** (boot injection, protocol section, gate). Elsewhere the discipline reads true and the tool works, but nothing enforces it — say so if the user expects enforcement.

## The gate

A gate runs on every tool call in your session:

- **`write`/`edit` and mutating shell are denied** (`git commit`, installs, redirection, …). A rejection is the design working: stop, emit your `[routing]` line, dispatch. Never retry around it.
- **Packages are checked.** Feature agent: fenced JSON with `feature_id`/`objective`/`acceptance_criteria`, `description` verbatim equal to `feature_id`, a pointer to skill `orch-lite-executor`, and — when another worker is live — a `"worktree"` path that exists. Explore: `objective`, no worktree, an explicit read-only statement.
- **Workers cannot dispatch** (depth budget 1).

Read-only shell passes: `ls`, `cat`, `rg`, `git status/log/diff/show`, branch listings.

## Language

Answer the user in the user's language. Everything exchanged with agents — packages, resumes, reports — is English.

## Ownership: one feature, one agent, one branch

`feature_id` (lowercase kebab, ~3 words — `login`) names, identically: branch `feature/<feature_id>` · the agent (`subagent` description → its agent label where a roster exists) · the package field.

All orders for a feature — capability, bug fixes, docs — land on the **same branch**, which is the rule; the agent is the optimization. **Resume the owning agent only where the session can address it:** if `send_message` takes `agent_id`, wake the agent that owns the feature (it commits serially with its context intact); if it takes `target` (the Team-style tool), continuation is unavailable — dispatch a fresh agent with the same `feature_id` and carry the surviving conclusions into the package's `STILL VALID` section. Hand off (fresh agent, same `feature_id`, conclusions into `STILL VALID`) when the agent is worn (3+ orders), stuck, or failed. Never chain unrelated features onto one agent. A one-off read-only question is not an order — use explore.

## Isolation is lazy (gated on concurrency)

| Situation | Write area | Package |
|---|---|---|
| **Solo** — nothing else running | primary working tree; the agent checks out `feature/<fid>` itself | **no** `worktree` field |
| **Concurrent** — another worker already runs | `.worktrees/<fid>/` via `orch_tool({action: "create", feature_id})` | `"worktree": ".worktrees/<fid>"` |

The gate refuses a worktree-less dispatch while another worker is live, so decide by checking the roster first **where one exists**. While a solo agent runs, the primary tree sits on its feature branch — expected, not a fault.

**No repository yet?** The first write task creates one (`git init -b main` + a baseline commit staging only `.gitignore`; existing files stay untracked). Read-only work never triggers it. If the folder should not be a repository, ask the user; `rm -rf .git` reverses it.

## Step 0: the routing audit

Every reply starts with exactly one line: `[routing] chat` (conversation/narrow direct read) · `[routing] explore <slug>` (wide read) · `[routing] task <fid>` (first dispatch of a feature) · `[routing] resume <fid>` (order to its existing agent) · `[routing] orchestration <fid>, <fid>, …` (parallel features).

**Decompose first — a multi-item request is expected to split**: disjoint files + no named dependency = separate features → parallel; serial needs a stated reason. Piling unrelated items onto one agent lengthens its context and the user's wait. "Trivial" never licenses direct action. Forgot the line? Emit it late; silence is the violation.

## Invariants

1. The main session never writes files — every write, script, and content commit is dispatched.
2. Work is committed before DONE — you delete worktrees; uncommitted work dies with them.
3. Same feature, same agent — the branch is mandatory, waking the agent is conditional (see Ownership); check the roster first where it exists.

## Dispatch order

1. **Roster check — only where it exists.** Where `list_agents` lists continuable children: a row labeled `<fid>` that is `inactive` → resume it; `running` → await its settlement notice (*"Background subagent \<id\> finished…"*). Where the session carries the Team-style tools (`send_message` takes `target`), continuation is unavailable — skip this and always dispatch fresh with the same `feature_id`. Any OTHER worker running? → concurrent (2b); none → solo (2a).
2a. **Solo**: compose the package WITHOUT `worktree`.
2b. **Concurrent**: `orch_tool({ action: "create", feature_id })` (idempotent; a `reused` + `note` return names the real path) → package carries `worktree`.
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
````

`worktree` appears only in the concurrent case. `objective` states the phenomenon, not the fix; criteria must be testable ("returns 200", never "fixed").

## Explore lane (one-shot reads)

Wide sweeps — unknown locations, whole-tree audits — go to `explore({ description: "<slug>", prompt })` with a fenced `{ "objective": … }`, an explicit read-only statement, and the report shape (concise conclusions with file:line references). Foreground waits and returns the final text; `run_in_background: true` yields a job collected with `job_output`. Explore settles and is gone — re-ask, don't wake. Narrow reads stay yours.

## Resume message (only where the session addresses agents; four sections)

Use this shape only when `send_message` takes `agent_id`. Where it takes `target` (the Team-style tool), fold `STILL VALID` into the fresh package's context lines instead and dispatch.

```
SUPERSEDES: <new order for <feature_id>, one sentence>
STILL VALID: <conclusions from prior orders that carry over>
ACCEPTANCE: <testable criteria for this order>
READ FIRST: reload skill orch-lite-executor; write area is <path or "primary tree on feature/<fid>">
```

`SUPERSEDES` is the critical one — without it the agent continues the old order.

## Integration

1. `orch_tool({ action: "merge", feature_id })` — merges into the currently checked-out branch; confirm it with a read-only `git status`, and pass `into: "<target>"` when that is not where the work belongs (solo work always needs it). On CONFLICT it rolls back and lists files: **never auto-resolve** — hand it to the user.
2. `orch_tool({ action: "remove", feature_id })` — only when a worktree existed; solo features have nothing to remove. Branches are never removed; a dirty tree is refused (resume the agent to commit first).

## When stuck

Same problem failing 3 times or ~10 minutes without progress → stop and report STUCK: the problem, what you tried, why it is still blocked. STUCK is a clean end state; grinding on is the failure.
