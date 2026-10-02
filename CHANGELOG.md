# Changelog

All notable changes to this bundle. Rationale for each decision lives in `DEVLOG.md`; this file is
the short form. Dates are omitted on purpose — the project is developed in a single continuous line
and `DEVLOG.md` carries the ordering.

## 1.0.2 — renamed to `dsh-orch-lite`

- **The package name lost its `@local/` scope.** `@local/` was a leftover from the ad-hoc local
  bundle of v0.1: a package name is manifest identity, not an install artifact, so installing from a
  tarball or a git URL never changed it — it kept showing up in the profile dependency, the bundle
  list and the preset patch's two `name:` references. Now it follows the sibling plugin's convention:
  `dsh-orch-lite`, with the exported subpath `dsh-orch-lite/skills`.
- **Migration is remove-then-install, not side-by-side**: the old and the new package would each
  insert a row with the id `preset-orch-lite`, and duplicate preset ids fail declaration loading.
  Remove the old bundle first, install the new one second, then restart.
- No behaviour changed; the tools, the gate, the manuals and the audit trail are identical.

## 1.0.1 — manuals are global, tools stay scoped

- **The two manuals are published in the global skill layer**, so every preset can load `orch-lite`
  and `orch-lite-executor`. The registration moved out of the preset row into a new host row
  (`lib/skills.js`, exported as `dsh-orch-lite/skills`); a host row's registrations land in
  the global layer, which every session's catalogue merges in, while the tools and the gate remain
  scoped to the `orch-lite` preset.
- Both manuals now open with a **scope note** stating that the tools and the gate exist only in
  preset-bound sessions, so a foreign session does not try to call tools it does not have.
- The preset patch is now **reproducible**: it was regenerated from the shipped `standard` preset and
  the generator was corrected (it had been emitting a stale non-English description). Verified: the
  standard composition contributes 19 rows unchanged and regeneration reproduces the file exactly.

## 1.0.0 — first stable release

The enforced model is now considered complete: a coordinating main session that physically cannot
write, packages that must carry a real contract, one agent per feature branch, isolation only when
concurrency exists, a read-only lane that never consumes a feature agent, and an audit trail for
every decision. No code changed in this release beyond metadata; 1.0.0 marks the point where the
surface is frozen for review and reuse.

**Stable surface**
- The three tools (`worktree_create`, `worktree_merge`, `worktree_remove`) and their parameters,
  including `worktree_merge({ feature_id, into })` and the solo-lane no-op of `worktree_remove`.
- The dispatch contract: fenced JSON with `feature_id` / `objective` / `acceptance_criteria`
  (+ `worktree` under concurrency), `description` verbatim equal to `feature_id`, handbook pointer;
  `explore` with `objective`, no worktree, and an explicit read-only statement.
- The two runtime skills and their names (`orch-lite`, `orch-lite-executor`); the routing states
  (`chat` / `explore` / `task` / `resume` / `orchestration`); the four-section resume message.
- The preset id `orch-lite` and its declaration row `preset-orch-lite`.

**Known couplings** (documented in `README.md` and `DEVLOG.md`)
- The preset copies the shipped `standard` composition verbatim; re-run `scripts/gen-preset.mjs` when
  DSH updates `standard`.
- The plugin depends on documented platform APIs; a breaking platform change requires a bundle
  update, never a source patch.

**Verification at release**: 98/98 checks in `test/plugin.test.mjs`, `node --check` clean, no
non-English content in the bundle. Runtime acceptance (host restart + fresh preset session) is the
operator's step — see the checklist in `README.md`.

## 0.6.1

- **Audit trail now has a durable destination.** `ctx.logger` alone was invisible in the desktop
  build (its `logs` directory stays empty and session logs are zstd-compressed), so gate decisions
  and repository bootstraps are mirrored to `$DSH_HOME/orch-lite/audit.log`, append-only and
  best-effort.
- **Skills carry `resourceBase`**, so a loaded skill tells the model where the package lives
  (`Base directory for this skill: …`) instead of “resources are managed by provider …”.
- **Manuals trimmed**: the coordinator manual went 7,706 → 6,544 characters, restoring headroom
  under the 8,192-character tool-result pruner whose failure mode is the middle of a body
  disappearing silently; the executor description dropped to 431 characters so it survives the
  catalogue's 500-character render cap.

## 0.6.0

- **Lazy git-repository bootstrap** (parity with the original orch-lite, on demand): a write task in
  a folder without a repository creates the minimum one — `git init -b main`, a `.gitignore` entry,
  and a baseline commit that stages only `.gitignore` with a synthetic identity. User files are
  never claimed. `worktree_merge` / `worktree_remove` never bootstrap; chat and read-only sessions
  never touch the folder.

## 0.5.0

- Coordinator and worker handbooks trimmed under the pruner threshold.
- **Executor reports are the turn's final message** (delivered verbatim by the settlement notice);
  the previous instruction to `send_message` an unknown session id was fiction.
- **Worker counting is parent-grouped**, so another session's workers no longer close this
  session's solo lane.
- **Synchronous pending slots** close the dispatch→registration race: two solo dispatches composed in
  one message can no longer both book the primary tree; slots release at start, and at
  post-execute when a dispatch failed to start a child.
- **Gate decisions are audited** (allow / deny / fail-open).

## 0.4.0

- **Lazy isolation**: worktree isolation only when another worker is already running; a solo worker
  uses the primary working tree and checks out its own feature branch. `worktree_merge` gained
  `into` (required for solo work); `worktree_remove` became a no-op for solo features.

## 0.3.0

- **Feature ownership replaces per-task identity**: `feature_id` names the branch, the worktree, the
  agent label and the package field; follow-up orders resume the same agent; worn agents are handed
  off without losing the branch.
- **One-shot `explore` lane** added to the preset for read-only sweeps (foreground by default).

## 0.2.0

- **The Claude Code hook bridge was removed entirely** — its `configPath` resolved against an unset
  `DSH_HOME`, so the gate had never run once. Enforcement moved in-process: a `tools/pre-execute`
  listener with access to agent headers (main vs worker), plus `tools/post-execute`.
- **Skills are registered at runtime** in the preset's layer (the filesystem provider does not scan
  plugin directories), ending the stale-copy drift.
- **Boot contract injected** before the first turn, and a one-line hint for workers.
- **Protocol rewritten** to restore the original's compliance machinery: the `[routing]` audit line,
  supremacy, and the explicit direct-action whitelist.
- All bundle content is English; user-facing replies follow the user's language while
  main↔worker traffic stays English.

## 0.1.0

- First DeepSeek Harness port of the ZCode orch-lite plugin: the `orch-lite` preset, three worktree
  tools, a `standard`-derived composition, and a Claude Code style `PreToolUse` dispatch validator
  plus skill copies. Superseded by 0.2.0.
