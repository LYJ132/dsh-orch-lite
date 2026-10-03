# dsh-orch-lite

A **DeepSeek Harness agent preset** (`orch-lite`) that keeps the main session coordinating while
background agents do the file work. It is an additive bundle: it patches nothing, replaces nothing,
and imports nothing from the platform.

## What it enforces

| Guarantee | Mechanism |
|---|---|
| The main session never writes files | a `tools/pre-execute` gate denies `write` / `edit` and mutating shell commands with a routing reason |
| Dispatches carry a real contract | package validation: fenced JSON, `feature_id` / `objective` / `acceptance_criteria`, `description` verbatim equal to `feature_id`, handbook pointer, and — under concurrency — a `worktree` path that exists |
| One agent per feature branch | `feature_id` names the branch, the agent label and the package field; follow-up orders resume the same agent via `send_message` |
| Isolation only when it pays | lazy isolation: the first (only) worker runs in the primary working tree; every additional concurrent worker gets `.worktrees/<feature_id>/` |
| Wide reads never consume a feature agent | one-shot `explore` agents answer read-only sweeps and settle |
| Workers cannot fan out | executors are denied dispatch tools (depth budget 1) |
| Every decision is auditable | allow/deny lines and repo bootstraps are written to `$DSH_HOME/orch-lite/audit.log` |
| Knowledge and capability are shared, enforcement is not | a host row publishes the two manuals **and** the `orch_tool` work-area tool into the **global** layers, so every preset can load the manuals and call the tool; the protocol section, the boot injection and the gate stay scoped to the `orch-lite` preset |

The one tool it registers is `orch_tool`, with three actions: `create` (allocate `.worktrees/<feature_id>/`),
`merge` (integrate the feature branch) and `remove` (drop the write area; the branch always survives).
Next to it the bundle ships two runtime skills — `orch-lite` (coordinator manual) and
`orch-lite-executor` (worker handbook) — also registered **globally**. Only enforcement is
preset-scoped. A session outside the preset therefore gets the discipline and the tool but no
enforcement, which is why both manuals open with a scope note saying exactly that.

## Requirements

- A DSH installation whose base profile provides `tools`, `systemPrompt`, `skills`, `subprocess`,
  `fs` and the `subagent` tool family. Nothing else: **no npm dependencies, no Python, no hook
  bridge** (the v0.1 hook bridge was removed in v0.2 — see `DEVLOG.md`).
- Node built-ins only (`node:fs`, `node:path`, `node:os`, `node:url`, `node:crypto`).

## Install

The preset ships as one bundle patch (`presets/orch-lite.patch.yml`) that inserts a
`@deepseek-ai/dsh-agent-preset` declaration row. Register the bundle with the profile:

```text
plugin_manager install_bundle  target: <absolute path to this directory>   # directory / link install
plugin_manager install_bundle  target: file:<path to the .tgz>            # tarball install
```

Then **restart the host process and open a NEW session**, selecting the `Orch-lite` preset.
Two platform behaviours matter here:

- source edits to a linked plugin are not hot-reloaded (the base composition only enables config
  watching), so a restart is required for JS changes;
- sessions keep the preset revision they were created with, so an existing session will not pick up
  a new revision — always test in a fresh session.

## Verify after install

1. In a new preset session, the tools panel shows `orch_tool`, and `explore` is available as a dispatch tool.
2. Loading skill `orch-lite` returns the manual and a `Base directory for this skill: …` line.
3. Ask it to edit a file directly: it should emit a `[routing] …` line and dispatch; a direct
   `write`/`edit` attempt is rejected by the gate with an orch-lite reason.
4. Ask for a wide read-only audit: `[routing] explore …` and conclusions returned in the foreground.
5. A small write task in a scratch folder: no worktree (solo), the worker checks out
   `feature/<feature_id>` itself, commits, reports DONE; integration is
   `orch_tool({ action: "merge", feature_id })`.
6. While that worker runs, a second independent task: `orch_tool({ action: "create", feature_id })`
   first, package carries `"worktree"`.
7. In a folder that is not a git repository: a read-only request creates nothing; the first write
   task bootstraps a repository (`git init -b main` + a baseline commit staging only `.gitignore`).
8. `Get-Content "$env:DSH_HOME\orch-lite\audit.log" -Tail 20` shows the decisions above.
9. Open a session in any OTHER preset: skill `orch-lite` is listed and loads (with a
   `Base directory for this skill: …` line) **and `orch_tool` is present**, but no gate runs —
   knowledge and capability global, enforcement scoped.

The same checklist in longer form, with per-step expectations, is in `DEVLOG.md` (§ v0.6) and was
used for the 1.0.0 review.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | preset half: protocol section, gate wiring, boot injection |
| `lib/host.js` | host half: publishes the two manuals **and** `orch_tool` into the global layers (exported as `dsh-orch-lite/host`) |
| `lib/tool.js` | the one work-area tool (`create` / `merge` / `remove`) |
| `lib/workspace.js` | repository resolution, bootstrap, `.gitignore`, feature-id validation |
| `lib/audit.js` | the durable audit trail (`$DSH_HOME/orch-lite/audit.log`) |
| `lib/gate.js` | the enforcement rules as pure functions (package validation, shell mutation detection, agent classification) |
| `lib/git.js` | the plugin's only subprocess boundary (git, argv-based, bounded, deadline-guarded) |
| `lib/define-tool.js` | local `defineTool` (platform packages are not resolvable from a linked plugin) |
| `skills/*/SKILL.md` | the two manuals, loaded on demand, registered globally at runtime |
| `presets/orch-lite.patch.yml` | the bundle patch: the preset row (tools, gate, protocol) **and** the host skills row, plus the copied `standard` composition |
| `scripts/gen-preset.mjs` | regenerates the preset patch from the shipped `standard` preset, keeping the copied composition honest |
| `test/plugin.test.mjs` | the self-contained check suite (`npm test`, or `node test/plugin.test.mjs .`); excluded from the pack by the `files` list |
| `DEVLOG.md` | decision history and rationale — the "why" behind every rule |
| `CHANGELOG.md` | the short, user-visible change list; one section per released version |
| `memory.md` | per-session development journal — what this repository's git history cannot record (working branch, blockers, next steps) |
| `LICENSE` | MIT |

## Development loop

The profile installs a **copy** of this package (a `file:` tarball or a `git+…` checkout), not a live
link, so editing these sources does **not** reach the running application. Iterate like this:

```powershell
cd <this directory>
npm test                          # 109 checks, self-contained
npm pack --dry-run                # preview the pack: 13 files, LICENSE included
npm pack --pack-destination <dir> # produces dsh-orch-lite-<version>.tgz
# then, from a session:
plugin_manager install_bundle     target: file:<absolute path to the .tgz>
```

Then **restart the host and open a new session** — bundle changes are read at profile load, and a
session keeps the preset revision it started with. The install answers `restart-required` when the
host is already running; that is the expected signal, not a failure.

## Compatibility and limits

- **Nothing is patched.** The plugin adds a bundle layer and registers runtime contributions; the
  shipped packages, the profile's other rows and the `standard` preset are untouched.
- **The preset copies the shipped `standard` composition verbatim** (a preset is an authoritative
  composition, not an incremental layer). It therefore drifts when DSH updates `standard`:
  re-run `scripts/gen-preset.mjs <standard.patch.yml> presets/orch-lite.patch.yml` and re-verify. A
  renamed or removed platform package would make that row fail to resolve.
- **It depends on documented platform APIs** — `ctx.tools.register`, `ctx.systemPrompt.section`,
  `ctx.skills.register`, the `tools/pre-execute` / `tools/post-execute` / `agent/created` /
  `subagent/start` / `subagent/end` extension points, `ctx.subprocess`, `ctx.fs`, `agent.inject` and
  the session header fields (`cwd`, `id`, `parentSession`, `delegationDepth`, `agentPreset`). A
  breaking change there needs a plugin update, never a source patch.
- **Runtime writes are workspace-level, by design**: `.worktrees/` and a `.gitignore` entry, a
  repository bootstrap in a folder that has none, and the audit trail under `$DSH_HOME/orch-lite/`.
  Removing the bundle leaves those artifacts behind; delete them if unwanted.

## Uninstall

Remove the bundle row from the profile (and the `dsh-orch-lite` dependency/link), restart,
then optionally delete `.worktrees/`, the `feature/*` branches and
`$DSH_HOME/orch-lite/audit.log`. No platform file needs to be restored, because none was changed.

## License

MIT — see [`LICENSE`](./LICENSE). The source is published at
<https://github.com/LYJ132/dsh-orch-lite>. The manifest carries npm publishing metadata
(`repository`, `author`, no `"private"` flag), but nothing has been published to a registry —
installs run from a directory, a tarball or a `git+…` URL.
