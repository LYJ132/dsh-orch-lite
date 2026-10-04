# dsh-orch-lite

A **DeepSeek Harness agent preset** (`orch-lite`) that keeps the main session orchestrating while
background agents do the file work. It is an additive bundle: it patches nothing, replaces nothing,
and imports nothing from the platform.

## What it enforces

| Guarantee | Mechanism |
|---|---|
| A worker's work area stays its own | a `tools/pre-execute` gate denies main-session `write` / `edit` and lane-destroying shell inside `.worktrees/<feature_id>/` — two writers in one area is the accident git cannot undo |
| Nothing leaves the repository unasked | `git push`, package publishing and `gh pr` / `gh release` are denied; those are the user's decisions |
| Every write task owns a work area | `orch_tool({ action: "create", feature_id })` before the dispatch; a feature package without a `worktree` field is refused |
| Feature dispatches carry a real contract | package validation — fenced JSON, `feature_id` / `objective` / `acceptance_criteria` / `worktree`, `description` verbatim equal to `feature_id`, handbook pointer — applied **only** to a dispatch that declares a `feature_id` |
| One agent per feature branch | `feature_id` names the branch, the work area, the agent label and the package field; follow-up orders resume the same agent where the session can address it |
| Wide reads never consume a feature agent | one-shot `explore` agents answer read-only sweeps and settle |
| A fresh folder can still take work | lazy repository bootstrap on the first `create`: `git init -b main`, `.gitignore`, a baseline commit staging only `.gitignore`; the notice rides back in the tool result |
| Knowledge and capability are shared, enforcement is not | a host row publishes the two manuals **and** the `orch_tool` work-area tool into the **global** layers, so every preset can load the manuals and call the tool; the protocol section, the worker hint and the gate stay scoped to the `orch-lite` preset |

## What the gate deliberately does not do

The v1.0 line enforced a coordinator that could not touch a file. That was one mechanism too many:
it locked out every other skill with its own "write this file" convention, and it blocked ordinary
work (`pnpm install`, `git checkout`) that a `git` command or a sentence reverses. Since v1.1:

- **the main session writes its own project files freely** — `write`, `edit`, commits, branch work,
  installs; only the two rows above stop it;
- **no depth ban on workers** — the Host's `subagent.maxDepth` setting (default `1`, user-tunable)
  already rejects a child's delegation attempt, and a plugin cannot know better than the operator;
- **no concurrency bookkeeping** — no live-worker registry, no pending slots, no ack parsing: with every
  worker in its own area, "may the coordinator write here?" is a path question, not a state question;
- **no audit file** — every denial already arrives in the model's context as its own reason.

Rationale and the risk ledger behind each cut: `DEVLOG.md` § v1.1.0.

The one tool it registers is `orch_tool`, with three actions: `create` (allocate `.worktrees/<feature_id>/`),
`merge` (integrate the feature branch) and `remove` (retire the work area; the branch always survives).
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

1. In a new preset session, the tools panel shows `orch_tool`, and `explore` is available as a
   dispatch tool.
2. Loading skill `orch-lite` returns the manual and a `Base directory for this skill: …` line.
3. Ask for a small edit: it should make the edit itself with `[routing] chat` — **no denial**. This is
   the regression v1.0 existed to fix.
4. Ask for a write task worth backgrounding: `[routing] task <fid>` → `orch_tool create` → a dispatch
   whose package carries `"worktree"`. A package without it is refused with an actionable reason.
5. Ask it to write a file **inside** `.worktrees/<fid>/`: denied, with the worker-lane reason.
   Same for `rm -rf .worktrees/<fid>` and for `git push`.
6. Run another skill's own subagent dispatch (no `feature_id` in its prompt): it passes untouched —
   the package contract is opt-in.
7. A feature agent's report arrives as its closing message; integration is
   `orch_tool({ action: "merge", feature_id })`, then `remove`.
8. In a folder that is not a git repository: a read-only request creates nothing; the first `create`
   bootstraps a repository and says so **in the tool result**, which the coordinator must repeat.
9. Open a session in any OTHER preset: skill `orch-lite` is listed and loads (with a
   `Base directory for this skill: …` line) **and `orch_tool` is present**, but no gate runs —
   knowledge and capability global, enforcement scoped.
10. From a worker session, try delegating: the platform answers with the depth error (Host
    `subagent.maxDepth`, default `1`) — not with an orch-lite reason.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | preset half: protocol section, gate wiring, worker hint |
| `lib/host.js` | host half: publishes the two manuals **and** `orch_tool` into the global layers (exported as `dsh-orch-lite/host`) |
| `lib/tool.js` | the one work-area tool (`create` / `merge` / `remove`) |
| `lib/workspace.js` | repository resolution, lazy bootstrap, `.gitignore`, feature-id validation |
| `lib/gate.js` | the enforcement rules as pure functions (worker-lane path test, external-effect shell, opt-in package validation, agent classification) |
| `lib/git.js` | the plugin's only subprocess boundary (git, argv-based, bounded, deadline-guarded) |
| `lib/define-tool.js` | local `defineTool` (platform packages are not resolvable from a linked plugin) |
| `skills/*/SKILL.md` | the two manuals, loaded on demand, registered globally at runtime |
| `presets/orch-lite.patch.yml` | the bundle patch: the preset row (gate, protocol, `explore` lane) **and** the host row, plus the copied `standard` composition |
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
npm test                          # self-contained, needs a real git on PATH
npm pack --dry-run                # preview the pack: 15 files (no lib/audit.js), LICENSE included
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
  `ctx.skills.register`, the `tools/pre-execute` and `agent/created` extension points,
  `ctx.subprocess`, `ctx.fs`, `agent.inject` and the session header fields (`cwd`, `id`,
  `parentSession`, `delegationDepth`, `agentPreset`). A breaking change there needs a plugin update,
  never a source patch.
- **Runtime writes are workspace-level, by design**: `.worktrees/` and a `.gitignore` entry, plus the
  lazy repository bootstrap in a folder that has none. Removing the bundle leaves those artifacts
  behind; delete them if unwanted.

## Uninstall

Remove the bundle row from the profile (and the `dsh-orch-lite` dependency/link), restart,
then optionally delete `.worktrees/` and the `feature/*` branches. No platform file needs to be
restored, because none was changed.

## License

MIT — see [`LICENSE`](./LICENSE). The source is published at
<https://github.com/LYJ132/dsh-orch-lite>. The manifest carries npm publishing metadata
(`repository`, `author`, no `"private"` flag), but nothing has been published to a registry —
installs run from a directory, a tarball or a `git+…` URL.
