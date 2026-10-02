# dsh-orch-lite — development log

Decision history and rationale for this plugin. Plugin code, skills, prompts,
and tool messages carry only current rules and runtime facts; the "why we did
it this way" lives here.

## v1.0.2 — the package name loses its `@local/` scope

Owner question: "why do I still see `@local/`?" The answer is that it was an identity artefact, not
an install result. `name` in `package.json` **is** the package identity; neither a tarball install
nor a git install rewrites it. `@local/` dated from v0.1, when the bundle was hand-linked into the
profile as a local package, and from there it propagated into the profile's dependency key, the
bundle list, and the two `name:` module specifiers in the preset patch (the preset row and the global
skills row).

Renamed to **`dsh-orch-lite`** — unscoped, matching the sibling plugin this profile already installs
(`dsh-bi-dashboards`) and the repository name it will be pushed to. Every reference moved in one
pass: the manifest name, the patch's two module specifiers, the runtime skills' `source` stamp, the
generator, the docs, and the test assertions (15 references, all checked to be gone afterwards).

Profile migration order is not arbitrary: **remove the old bundle first, then install the new one.**
Both bundles' patches insert a row with the id `preset-orch-lite`, and duplicate preset ids fail
declaration loading — a side-by-side window is a broken composition, not a harmless overlap.

The rename changes no behaviour: tools, gate, manuals and audit trail are identical, and the version
bump exists only so the identity change is explicit rather than a silent re-cut.

Numbering note: the shipped line is 1.0.0 (released baseline) → **1.0.1** (manuals global, tools
scoped) → **1.0.2** (rename to `dsh-orch-lite`). During development an interim 1.1.0 commit was
mistakenly created; on 2026-10-02 the repository history was rebuilt from the current tree (old
history preserved in `temp/history-backup-20261002.bundle`, not distributed) so no published
history references the interim numbering.

## v1.0.1 — manuals global, tools scoped

Owner requirement, stated late: every preset should be able to use the orch-lite skill; only the
tools are restricted. That is a layering question, and the platform answers it directly: a runtime
skill registration is filed into the layer of its calling context — "host rows and repository
plugins land in the global layer" — and every catalogue read merges the global layer with the
viewing scope's chain. So the split is:

- **`lib/skills.js`** (new, exported as `dsh-orch-lite/skills`) is a **host row**: it reads
  the two manuals from the package and registers them, so they appear in every session of every
  preset. It carries `resourceBase: { kind: 'directory', path: PKG_DIR }` so a loaded manual also
  tells the model where the package lives.
- **`lib/index.js`** keeps everything else — the protocol section, the gate, the boot injection and
  the three worktree tools — and no longer registers skills. Its `inject` list lost `skills`
  accordingly; the two halves now declare different service sets, which the test suite pins.
- The preset patch therefore ships **two rows**: the preset declaration (capability) and the host
  skills row (knowledge). The generator emits both, so regeneration keeps the pair together.

Consequences accepted and documented rather than hidden:

- **A foreign session can read a manual it cannot execute.** The tools it names do not exist there,
  and nothing enforces the discipline. Both manuals now open with a *scope note* that says so, which
  is the cheap fix: the document tells the truth about its own availability instead of leaving the
  model to discover missing tools by failing.
- **Two extra catalogue entries in every session.** The catalogue is name + capped description
  (500 chars) per skill; both descriptions were already trimmed under that cap in v0.6.1, so the cost
  is bounded and deliberate.
- The global layer wins nothing over the preset layer (nearest-layer precedence) — removing the
  preset-scoped registration is safe because the global registration is visible in preset sessions
  too. Two registrations of the same name would have been redundant, not harmful.

Verification for this release:

- the subpath export resolves the way the loader resolves it — `import('dsh-orch-lite/skills')`
  from the profile directory returns the module (checked from `$DSH_HOME/profiles/desktop`, not just
  from the workspace);
- the preset patch is now **reproducible**: regenerating it from the shipped `standard` preset
  reproduces the shipped file byte-for-byte apart from one comment block, with the standard
  composition contributing 19 rows unchanged. The generator had been emitting a stale non-English
  description (caught here and fixed), which would have reintroduced it on the next platform update;
- 103/103 checks pass, including new ones for the split (different service sets, the host row in the
  patch, the manifest subpath export, the pack file list); the packaging block also pins the patch's
  indentation structure (insert-list rows at 4 spaces, preset plugin rows at 10, the delegation
  group's children at 14), so a hand-edit that nests the host row inside the preset is caught;
- **observed platform behaviour**: editing a bundle patch does NOT re-compose a running host — after
  the patch gained the host row, the live profile still listed 191 entries with only
  `preset-orch-lite`. Bundle patches are read at profile load, so the new row appears at the next
  start; `plugin_manager install_bundle` is not a way to force it (it answers `ambiguous-install` for
  an already-linked directory, `changed: false`). Restart, then verify.

1.0.0's tarball is superseded by 1.0.1; the version bump is deliberate so a distributed 1.0.0 is
never silently re-cut with different content.

Packaging for external installation and a remote repository (same release, before anything was
distributed):

- **The dev assets moved into the package**: `scripts/gen-preset.mjs` (was `.probe/gen-preset.mjs`)
  and `test/plugin.test.mjs` (was `.probe/tools.test.mjs`), with `npm test` as the entry point. The
  repository is now self-contained — cloning it gives you the code, the generator and the suite —
  while the `files` whitelist keeps both out of the published tarball.
- **Repo root = package root, deliberately.** A DSH bundle is installed from a package root
  (`package.json` carrying `dsh.bundle.patch`), and a `git+…` install takes the repository root as
  that package; a plugin kept in a subtree of a larger repository could not be installed from git at
  all. That is why this directory became its own repository instead of staying a folder inside the
  workspace repository (which has no remote and does not track it — checked before the split).
- `.gitignore` covers `node_modules/`, `*.tgz` and `.worktrees/`; the workspace's own `.gitignore`
  is untouched.

## v1.0.0 — first stable release (additive-only, verified)

Release question asked and answered with checks, not assertions: is this bundle
purely additive, so platform updates cannot break it?

- The package contains nine files of its own (2 skills, 1 preset patch, 4 lib
  modules, `package.json`, this log) plus `README.md` / `CHANGELOG.md`.
- `lib/*` imports only Node built-ins (`node:fs`, `node:path`, `node:os`,
  `node:url`, `node:crypto`) and its own relative modules — there is **no import
  of any `@deepseek-ai/*` package**. That is deliberate, and it is why
  `define-tool.js` exists as a local copy.
- `package.json` declares **zero dependencies and zero peer dependencies**.
- The install-time artefact is one bundle patch that *inserts* a preset
  declaration row; no platform package, profile row or shipped preset is edited.
- Verified externally: `app.asar` keeps its pre-existing timestamp, and the
  extracted platform tree used for research shows zero modified files.

Two honest couplings, both documented in `README.md`:

1. **The preset copies the shipped `standard` composition verbatim.** A preset is
   an authoritative composition, not an incremental layer, so this is the only
   correct shape — but it drifts when DSH updates `standard`. Re-run
   `scripts/gen-preset.mjs` after a platform update (a renamed or removed package
   would make that row fail to resolve, which rejects the preset mount).
2. **Documented platform APIs are the contract**: `ctx.tools.register`,
   `ctx.systemPrompt.section`, `ctx.skills.register`, the `tools/pre-execute` /
   `tools/post-execute` / `agent/created` / `subagent/start` / `subagent/end`
   extension points, `ctx.subprocess`, `ctx.fs`, `agent.inject`, and the session
   header fields (`cwd`, `id`, `parentSession`, `delegationDepth`,
   `agentPreset`). A breaking change there needs a bundle update — never a source
   patch.

Runtime writes remain workspace-level and intentional: `.worktrees/` plus a
`.gitignore` entry, a repository bootstrap in a folder that has none, and the
audit trail at `$DSH_HOME/orch-lite/audit.log`. Uninstalling the bundle leaves
those behind; nothing platform-side needs restoring, because nothing was changed.

Frozen surface (see `CHANGELOG.md` for the exact list): the three tools and their
parameters, the dispatch contract, the two skill names, the routing states, and
the preset id. Release verification: 98/98 in `test/plugin.test.mjs`,
`node --check` clean, no non-English content. Runtime acceptance (restart + a
fresh preset session) is the operator's step and is spelled out in `README.md`;
a finding there ships as 1.0.1 rather than an edit to a released version.

## v0.6 — lazy git-repository bootstrap (parity with the original, on demand)

The original orch-lite auto-created a repository. Verified in the ZCode cache
(`…/1.2.0`): `scripts/multi-agent` `init_command()` calls `ensure_git_repo()`,
which on a non-repository workspace runs `git init -b main` (older git:
`init` then `branch -m main`), appends its runtime ignores
(`GITIGNORE_LINES = ["multi-agent/", ".orch-lite/", ".worktrees/"]`), then
stages ONLY `.gitignore` and commits `--allow-empty -m
"chore: orchestrator baseline"` with the inline identity
`orchestrator-init <orchestrator@local>` (mandatory: fresh machines often have
no git user). The SessionStart hook (`hooks/session-init.py:286`) ran
`multi-agent init` on EVERY session start — i.e. unconditionally.

v0.1–v0.5 of this port never bootstrapped anything: `worktree_create` refused
outside a repository, and a solo worker died at `git checkout -b`. A fresh
folder could chat and explore but could not take write work — a real
capability gap, since "open a folder and ask for work" is the plugin's whole
point.

Decision after auditing the side effects (the ledger that produced it):

- the original's bootstrap is far less invasive than it looks — it never
  stages user files, so no user content is claimed and no secrets land in a
  commit;
- the real costs are (a) `.git` appearing, plus one synthetic root commit on
  `main`; (b) DSH's own project-root semantics changing, because
  `<projectRoot>` is the nearest `.git` ancestor — skill discovery
  (`<projectRoot>/.dsh/skills`), the `AGENTS.md`/`CLAUDE.md` instruction chain
  and the workspace-changes view all start treating that directory as a
  project; (c) if run unconditionally, chat-only sessions in directories that
  should not be repositories (`~`, drive roots, downloads, network shares)
  would get one, and a stray high-level repository silently changes
  project-root resolution for every session beneath it; (d) a nested `.git`
  blocks later inclusion in a larger repository (gitlink instead of files).

Chosen shape — same bootstrap, lazy trigger:

- `repositoryFor(ctx, exec, { create: true })` is the only call site allowed
  to bootstrap, used by `worktree_create` (the concurrent lane). `worktree_merge`
  and `worktree_remove` never bootstrap; a non-repository workspace still gets
  the explicit "nothing to isolate" error, and the tests pin that a merge
  attempt leaves no `.git` behind.
- The solo lane bootstraps in the worker, before it creates its branch: the
  executor handbook carries the exact commands (same shape and identity),
  forbids `git add -A`, and requires the report to state
  `Bootstrap: initialized a git repository at <path>` so the user learns their
  directory became a repository.
- Everything is fail-soft and logged: `orch-lite: bootstrapped a git
  repository at <root> (… ; existing files stay untracked)`.
- Consequence of the trigger choice: the cost is paid when work is actually
  requested (hundreds of milliseconds at dispatch), never at session start,
  never in a directory that only saw chat or reads. Documented for the
  coordinator as guidance: if the folder looks like somewhere a repository
  should not go, raise it with the user instead of dispatching; `rm -rf .git`
  reverses it.

Addendum 1 (same release, found while writing the acceptance checklist): the
v0.5 audit trail had no readable destination in the desktop build —
`%APPDATA%\@deepseek-ai\dsh-desktop\logs` stays empty (so `ctx.logger` output
is console-only there) and session logs are `session.v4.jsonl.zstd`, i.e.
compressed and not greppable. R12's stated purpose (diagnose after the fact) was
therefore unmet. The gate now mirrors every decision and the bootstrap notice
into `$DSH_HOME/orch-lite/audit.log` (harness-home precedence: explicit env,
else `~/.dsh`), append-only, ISO timestamp per line, best-effort — a failed
write can never change a decision, and the tests point `DSH_HOME` at a temp
directory and assert the trail content. No rotation yet: gate lines are a few
per dispatch, and the file can be deleted at any time.

Addendum 2 (same release): runtime-registered skills carried no
`resourceBase`, so the rendered `<skill_resources>` said only "managed by
provider …" — the model was told nothing about where this package lives, and
a "read references/x.md" instruction would have been unresolvable. Both skills
now register `resourceBase: { kind: 'directory', path: PKG_DIR }`, which
renders `Base directory for this skill: <path>` plus the resolve-relative-paths
guidance. That is the precondition for any future reference split, and it is
immediately useful for debugging reads (DEVLOG, preset, sources) by relative
path.

Addendum 3 (same release): the two manuals were measured against the pruner,
and the main one sat at 7,706 of 8,192 chars — 486 chars of headroom before the
MIDDLE of the body would start disappearing (head 4096 + tail 1024 are kept),
which is worse than truncation because the loss is silent. Trimmed to 6,544 by
moving facts to their owners instead of duplicating them: integration mechanics
already live in the tool descriptions (present in every request as schemas),
the bootstrap commands live in the executor handbook (only workers load it),
denial semantics are taught just-in-time by the deny reasons, and the explore
example became one line plus its tool call. The package template, the routing
audit, ownership, lazy isolation, and the invariants stayed in full — they are
needed on every dispatch. The executor handbook's frontmatter description was
673 chars, past the skill catalog's 500-char render cap, which cut exactly its
"not for the main session, not for explore agents" clause; trimmed to 431 so
the whole routing sentence survives. No reference files were added: with the
body back under the threshold and no rare-situation content to house, a
`references/` layer would only add a lookup the model must decide to perform —
the fork is real only when (a) a body again approaches 8192 (middle-drop
failure), or (b) content exists that is needed only in rare situations. The
`resourceBase` from Addendum 2 keeps that door open for when it is needed.

## v0.5 — risk-ledger resolutions (user adjudicated each item)

Audit of v0.4 produced a ledger; the owner accepted R1/R2, specified R3, asked
R4/R5/R6 mechanics, waived R10, approved R12/R15. Resolutions:

- **R1 (fixed): handbook exceeded the tool-result pruner.** The preset's
  standard composition mounts `dsh-compaction-tool-result-pruner`
  (threshold 8192, head 4096 + tail 1024): a loaded SKILL.md larger than
  8192 chars gets trimmed to its head+tail in later history — the
  coordinator would silently lose the middle of its manual mid-session.
  The English rewrite had grown the main handbook to 11,746 chars. Slimmed
  to 7,086 (executor: 4,755); the ZCode original had the same <8K discipline
  documented for the same pruner. The gate tests measure the body after
  frontmatter-stripping exactly as `readSkill` does.
- **R2 (fixed): executor report channel was fictional.** The handbook
  mandated `send_message(target: "<main session id>")`, but nothing in the
  dispatch template or boot hint ever conveys the main session id, and the
  child cannot list its parent. DSH's native channel already delivers a
  settled child's FINAL message to the parent verbatim ("Its closing
  message:" in the settlement notice). Reports are now defined as the turn's
  final message; send_message is mentioned only when a prompt explicitly
  supplies a target. CHILD_HINT updated to match. (Field-name drift noted:
  package docs say `agent_id`, this GUI's schema says `target` — another
  reason not to depend on it.)
- **R3 (fixed as specified): concurrency counting is parent-grouped.**
  Registry is now `childSessionId -> parentId` fed ONLY by the paired
  start/end events; the solo-lane check counts children whose parent is the
  calling session. Another orch-lite session's workers (and their explores)
  can no longer close this session's solo lane. The one-shot children that
  `list_agents` hides remain a possible local over-count (a running explore
  can briefly block a solo write in the SAME session) — conservative
  direction, observe in practice (R4: no lab test, per owner).
- **R5 (fixed): the dispatch→registration race was real and is closed with
  synchronous pending slots.** Two solo dispatches composed in one assistant
  message used to both pass the zero-live check (start fires asynchronously,
  after the gate decides). The gate now RESERVES a slot synchronously, in
  the same non-yielding JS stretch that decides a solo allow — so the second
  dispatch in the same burst sees live-workers ≥ 1 and is refused. Slots
  release when the child actually starts (`subagent/start`) and, if the
  dispatch failed to start anything, at `tools/post-execute` when the ack
  text lacks the platform's "started subagent…"/"started background
  subagent job…" marker. A successful ack must not release (start owns it).
  Residual leaks (crashed dispatch with an odd ack format) block toward
  over-isolation — the model is pushed into the worktree lane, never toward
  two writers — and are cleared by host restart. Not a stub: it is
  integrated into the decision path itself, per the owner's instruction.
- **R6 (answered, guarded in docs — not changed):** yes, by design
  `worktree_merge` without `into` lands on whatever branch the primary tree
  is checked out on — plain git semantics; if the user's tree sits on some
  WIP branch, integration lands there. Forcing `into` always would fight
  that same git convention for the common case (tree on trunk). The guard is
  a check-before-merge instruction (read-only `git status` / `git branch` —
  both gate-passing) added to the tool description and the skill's
  Integration step 1; a wrong base also shows up immediately as CONFLICT,
  which routes to the human anyway.
- **R10 (waived, agreed):** read-only explores need no worktree defense;
  their invisibility in `list_agents` stays. Only interaction with the gate
  is the R3 conservative over-count above.
- **R12/R15 (fixed): every gate decision is audited to the host log.**
  Allow/deny lines carry tool, lane, and feature; the worktree-less refusal
  logs the live count; unattributable calls on gated tools log their
  fail-open pass. A denial reason lives in model context and can be
  compacted away; the decision itself now survives the session in
  `orch-lite gate: …` log lines, so "why did it say no/yes" is answerable
  after the fact without adding any new user-facing machinery (lite kept).

## v0.4 — lazy isolation (isolation gated on concurrency)

Explicit user correction: "worktree only when another subagent task is already
running; a single subagent does not need one." This restores the ZCode
original's Invariant 2, which v0.2/v0.3 had deliberately replaced with
always-isolate. The reversal is the owner's call; what follows is how it was
made safe and machine-enforced.

- **The package's `worktree` field became optional**, and the gate now
  enforces the *concurrency half* instead of always requiring isolation:
  a `worktree`-less dispatch is refused while any worker is live, allowed
  when the dispatch would be the only worker. The solo lane is therefore not
  a convention the model can drift away from — it is a decision the gate
  makes falsifiable at dispatch time.
- **The live-worker registry must be start/end-paired.** First implementation
  also added children seen at `agent/created` (for the boot hint), which has no
  matching removal — the suite caught it: one stray entry left the solo lane
  permanently closed. Identity no longer depends on that registry at all:
  `delegationDepth` / `parentSession` on the session header classify
  main-vs-child, and `subagent/start`…`subagent/end` (which fire in pairs, the
  end at settlement) count what is actually running. This is exactly the
  "another subagent task is already running" condition the user described.
- **Solo mechanics.** The solo agent creates and checks out
  `feature/<feature_id>` in the primary working tree itself (ZCode executor
  handbook behaviour), guarded by a dirty-tree check: pre-existing
  modifications it did not make → report STUCK rather than drag someone
  else's work onto its branch. While it runs, the primary tree sits on the
  feature branch — accepted trade-off of the solo lane, and the reason the
  handbook states it explicitly.
- **Integration had to grow.** With the primary tree parked on the feature
  branch, `worktree_merge` can no longer assume the target branch is "whatever
  is checked out": it gained an `into` parameter, required in the solo case
  and refused with an actionable message when omitted. Conflict rollback
  reports which branch the tree was left on. `worktree_remove` became a soft
  no-op for solo features (`skipped: true`, "nothing to remove") instead of
  throwing over a worktree that was never created.
- **Costs, recorded honestly:** a solo worker writes in the same tree the main
  session reads from, so the coordinator observes the feature branch mid-flight
  (the alternative — always-isolate — was rejected for the overhead the user
  called out); and the concurrency decision is made from the *live* worker
  registry, so a dispatch that starts while another settles can still take the
  solo lane. Both are acceptable: the branch is per feature, and the gate
  refuses a second worktree-less dispatch only when it can prove a live worker.

## v0.3 — feature ownership + the one-shot explore lane

Requested shape: one-shot dispatches for search-style work; for continuable
dispatches, one agent per branch (a feature accumulates different
responsibilities — capability work, bug fixes, docs — over its life).
Verified against the platform first: `dsh-tool-subagent` instances configure
`backgroundMode: one-shot|continuable` independently of provider; one-shot
calls wait in the foreground and return the child's final text (or, with
`run_in_background: true`, yield a job collected via `job_output`/`job_kill`);
continuable defaults to background with settlement notices and `send_message`
wake. Both fit the requested policy exactly, so it became the core model.

What changed and why:

- **`feature_id` replaces `task_id` everywhere.** One string now names four
  things identically: branch `feature/<fid>`, worktree `.worktrees/<fid>`,
  the owning agent (subagent `description` → `list_agents` label, gate-
  enforced binding), and the package field. The per-task string was adding a
  mapping layer without adding information once agents are branch-bound —
  "which agent owns this feature" became a label lookup, and follow-up work
  (the resume path) became the default instead of the exception.
- **Worktree directories are per feature, not per task.** The agent keeps
  its write area across orders and across handoffs: retirement of a worn-out
  agent never touches the branch or the directory, and a fresh dispatch with
  the same feature_id re-claims the area (idempotent `worktree_create`).
  The old per-task holder note survives as the "branch checked out
  elsewhere" fallback.
- **`worktree` is a required package field for feature agents.** Consistent
  with v0.2's always-isolate policy, now made structural: a work order that
  might write cannot be dispatched without a verified-on-disk area.
- **`explore`: a third subagent row** (`provider: spawn`,
  `backgroundMode: one-shot`) added to the preset's OWN section (NOT inside
  the copied-standard delegation group — regeneration slices standard verbatim
  and would drop edits there). Its gate contract is minimal: fenced package
  with `objective`, no `worktree`, explicit read-only statement; no handbook
  load — wide reads have no commit discipline to teach, and waking nothing
  means nothing to resume. Settled explore is gone by design; the
  continuable lane stays reserved for feature agents so the
  one-agent-one-branch invariant cannot be diluted.
- **Handoff replaces "3 tasks then fresh".** The retirement boundary used to
  count tasks per agent; now it counts ORDERS per feature agent, and
  retirement no longer costs the accumulated branch state — the new agent
  inherits worktree + git history + a STILL VALID carry-over list.
- **Executors are denied `explore` too** (depth budget covers both lanes).
- **Main-session integration commits need no gate carve-out**: the merge
  commit is produced by `worktree_merge` calling git through the subprocess
  SERVICE, not through a gated tool call — the gate intercepts tool
  executions, and the plugin's own service calls are integration mechanics,
  not content creation. Raw `git commit|merge|checkout` from main's shell
  stays denied; integration goes through the tools, which rollback conflicts
  instead of leaving a half-merged tree.
- Known limitation (accepted): the gate does not check "is a feature agent
  already alive" before a duplicate fresh dispatch — labels collide in
  `list_agents` and the one-worktree-per-branch git constraint serializes
  actual writes, but two live agents on one branch would interleave commits.
  The skill rule "wake before spawning" plus the settlement notices are the
  current control; a registry-backed duplicate check is a candidate if
  practice shows slips.

## v0.2 postmortem — why v0.1 never routed

The preset appeared mounted (row `preset-orch-lite` active, tools registered)
but enforcement and skill discovery were both silently dead:

1. **The dispatch gate never ran.** v0.1 mounted `dsh-hooks-claude-code` with
   `configPath: !!js 'process.env.DSH_HOME + "/orch-lite/hooks.json"'`.
   `DSH_HOME` is NOT set in the host process — it is a shell-env built-in
   exported only into model shell calls (`dsh-shell-env`); the launcher treats
   it as bootstrap-only. The expression evaluated to the literal
   `undefined/orch-lite/hooks.json`, `readFileSync` failed, and the bridge
   logged a warning and registered ZERO hooks. Smoking gun: the profile folder
   contains a literal `undefined\` directory (the same bug pattern left by
   another bundle). So no dispatch was ever validated, and nothing stopped the
   main session from doing the work itself.
2. **Bundled skills were invisible.** `dsh-skill-filesystem` scans fixed roots
   (project `.dsh/skills`, `.agents/skills`, `customSkillDirs`,
   `<DSH_HOME>/skills`, …) — it never scans a plugin's own `skills/` folder.
   The only `orch-lite` skill entries were stale manual copies in
   `<DSH_HOME>/skills/`, which (a) polluted every STANDARD session's catalog
   too, and (b) drifted out of sync with the package (old-language bodies).
3. **Prompt-only discipline lost to habit.** The protocol section did render
   (the `text({ scope })` + `ctx.tools.get(name, scope)` pattern is the
   documented first-party idiom — verified against the system-prompt package
   docs), but the port had diluted the ZCode original's enforcement clauses.
   The model read the summary, treated it as sufficient, skipped loading the
   skill, and kept editing directly — exactly the observed symptom. A rule the
   harness does not enforce will erode; enforcement must be structural.
   Also: the summary section had default interpolation — safe while `{{…}}`
   groups are absent, but the template now sets `interpolate: false` so JSON
   braces can never be parsed as variables.

## v0.2 architecture — everything in the host plugin

v0.2 deletes the hooks bridge, the Python gate, `hooks.json`, and the
DSH_HOME file copies entirely, and implements the same guarantees natively in
the preset-scoped plugin through the extension points the bridge itself
programs (dsh-hooks-claude-code is just a compatibility adapter; the package
README explicitly recommends "a native plugin for behavior that has no Claude
Code equivalent"). A JS listener sees context a hook process never can:

- `tools/pre-execute` receives `exec.agent` — so the gate distinguishes the
  MAIN session from EXECUTOR children via `session.header`
  (`delegationDepth`/`parentSession`, plus a live registry fed by
  `subagent/start`/`subagent/end` as a belt-and-braces OR), and from sessions
  of other presets via `header.agentPreset`. Python hooks only get
  `session_id`/`cwd` — indistinguishable, since children inherit the cwd.
- Gate decisions live in `lib/gate.js` as pure functions; `dsh deny` maps to
  `{ kind: 'deny', reason }` and the reason is model-visible verbatim, so
  every rejection doubles as the correction nudge ("blocked, not failed —
  dispatch"). The deny is deliberately asymmetric: main never writes;
  executors may write but never dispatch further (depth budget 1 made real).
- Skill delivery switched to the runtime registry: `ctx.skills.register(...)`
  from the plugin body lands in the PRESET's layer only (registry docs:
  "a plugin mounted by an agent preset's standing composition lands in that
  preset's layer"; nearest layer wins on name collision), so standard
  sessions never see `orch-lite`/`orch-lite-executor`, and the bodies load
  straight from the installed package — no copies to sync, no drift.
  Stale `<DSH_HOME>/skills/orch-lite*` copies were deleted.
- Boot context is injected through `agent/created` + `agent.inject()` (the
  same seam SessionStart hooks use, but synchronously before the first turn):
  a compact orchestration contract for the main session, a one-line executor
  hint for children. This mirrors the ZCode design where the SessionStart
  hook injected the contract sections verbatim so the iron rules were durable
  conversation context, not just a prompt section the model could skim.
  Message shape replicates `createUserMessage` locally (`{role:'user',
  content:[{type:'text',text}], id: randomUUID(), source}`) because
  `@deepseek-ai/dsh-llm` is unresolvable from a link plugin — same reason
  `define-tool.js` exists.
- `subagent/start`-fed child registry note: start events fire before any tool
  executes, so membership is guaranteed by first write; the header-depth
  check covers the race anyway.

## What was kept from the ZCode original (and what was dropped)

The original lived at `~/.zcode/cli/plugins/cache/orch-lite/…/1.2.0`
(Claude Code / ZCode / Codex dialect, with the CLI `scripts/multi-agent` and
`.orch-lite/index.json` state files). Ported clauses that DSH's port had
diluted — all now present in the PROTOCOL section and the orch-lite skill:

- **Step-0 `[routing]` audit line**, first line of EVERY reply, three states
  (chat / task / orchestration) + "emitting it late is allowed, silence is
  the violation" + decomposition check (disjoint files + no named dependency
  → parallel; unsure → parallel).
- **Supremacy + anti-excuses**: "trivial / quick fix" never licenses direct
  action; the protocol outranks other skills and convenience heuristics.
- **Explicit direct-action whitelist** for the main session (conversation,
  narrow reads, read-only shell, list_agents, worktree tools, dispatching) —
  replacing vague "you only do review" phrasing the model could rationalize.
- **Language rule** (the original already had it): user-facing replies mirror
  the user's language; all dispatch/executor traffic is English. Now enforced
  in every prompt layer AND in the executor report templates.
- **Handbook-first dispatch**: the child loads its own handbook through the
  skill tool (DSH has no injected SubagentStart context for the prompt text —
  v0.2 supplies the hint via `agent.inject` instead), and the package IS the
  agent's definition (objective states the phenomenon, acceptance criteria
  testable, ≤3 context lines, no re-pasted boilerplate).

Deliberate DSH-specific deviations from the original:

- `.orch-lite/index.json`, memory.json, the `multi-agent` CLI, roles, and the
  `doctor` pass were NOT ported: DSH's `list_agents()` + the shared task board
  already carry the live-agent state the index duplicated ("one string, three
  places" replaces index lookups). Lite stays lite.
- **Always-worktree for write tasks** (v0.1 policy kept): the original used
  lazy isolation (solo child works in the primary tree on a `feature/<fid>`
  branch it checks out itself). In DSH every agent shares one session cwd and
  the main session keeps reading the primary tree while children run — a
  child's mid-task branch switch would blind the coordinator. Isolation per
  write task is one `worktree add` call and makes the invariant absolute.
- `run_in_background` gating was dropped: DSH subagents default to
  `backgroundMode: continuable`; a gate over a redundant flag can only
  misfire.
- The original's `worktree merge` carve-out (main may run `git merge --ff-only`
  directly) was replaced by the `worktree_merge`/`worktree_remove` tools, so
  the raw-git shell gate stays strict — `git checkout`/`merge` from the main
  session's shell is denied, integration goes through the tools.
- `spawn_teammate` is NOT package-gated for the main session (teammates are a
  user-explicit path; blocking them would fight an intentional request);
  executors ARE denied it (plus `workflow`).
- Shell gating is a deny list (git mutating verbs, PS/POSIX mutation
  cmdlets, installs, redirection to files) rather than a full read-only
  whitelist — false positives on reads would cripple the coordinator; a
  missed mutating command is still a prompt-level violation the audit trail
  catches.

## Preset composition mechanics (kept from v0.1, re-verified)

- A DSH preset is an authoritative composition, not a layer: the PresetTree is
  built from the preset's own `plugins` list; a preset listing only the orch
  row yields an agent with no fs, no subagent, no skill tool. Hence everything
  below `plugins:` is `standard` verbatim, generated by
  `scripts/gen-preset.mjs <standard.patch.yml>`; re-run after DSH updates
  `standard` (it drifts silently otherwise). Row edits saved in the Web editor
  target `preset-standard` and do NOT apply to this preset.
- Preset rows bind per agent (`agentPresets.mount(agentCtx, id)` in session
  setup); sessions select `header.agentPreset`. Listeners registered by
  preset-mounted plugins only see events from agents bound to that revision
  (scoped listener inheritance) — the same property v0.1 tried to get from
  the hooks bridge and lost to the configPath failure.
- Reload semantics: edits to linked-plugin JS are not live — the base profile
  mounts `dsh-hmr` with `root: []` (config watch only). After changing this
  bundle: restart the host process, then open a NEW session; existing sessions
  keep the preset revision they started with.
- `dsh.bundle.patch` in package.json points at
  `presets/orch-lite.patch.yml`; installation materializes the package as a
  `link:` in the profile's node_modules (verified
  `profiles/desktop/node_modules/dsh-orch-lite → workspace`).

## Known silent-failure modes to check first if "nothing happens"

(from the dsh-tools/dsh-system-prompt contracts; diagnostics when tripped)

- Protocol section renders `''` when `worktree_create` is not visible in the
  session's scope view: name mismatch, the `orch` row failed or is stuck
  PENDING on a host service while other rows mounted, or the tool was
  restricted by a permission preset. Check `plugin_manager list_plugins` row
  states and start a fresh preset-bound session.
- A section `text` callback must be SYNC (an async return breaks interpolation
  / silently drops) and must not contain `{{ }}` groups unless interpolated —
  both guarded here (`interpolate: false`).
- `ctx.tools.register` throws at activation without
  `output: { schema, render }`; a bad plugin row rejects the whole preset
  mount audit, taking the standard tools with it.
- Skill registration warnings are non-fatal but leave the catalog entry
  absent — check host logs for `orch-lite: skill ... could not be registered`.

## Test harness

`test/plugin.test.mjs` (workspace, dev-only) drives the real plugin against
a stubbed ctx (subprocess over execFile, fs over node:fs, registries + event
bus mirroring scoped dispatch): 62 checks covering tool behavior, skill
registration from bundled SKILL.md, boot injection, and all gate
allow/deny paths. Run: `node test/plugin.test.mjs .`.

## Language policy

- Everything inside the plugin is written in English: skills, protocol,
  injection texts, tool descriptions/renders, code comments, deny reasons.
- The one runtime rule kept in the skills/protocol/injections: the main
  session answers the user in the user's own language, while all
  main↔executor traffic (dispatch packages, resume messages, reports) is
  English. Rationale: the gate parses package shape and enforces verbatim
  `task_id` equality — a fixed wire language keeps both stable.
