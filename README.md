# dsh-orch-lite

A **DeepSeek Harness agent preset** (`orch-lite`) that keeps the main session orchestrating while
background agents do the file work. It is an additive bundle: it patches nothing, replaces nothing,
and imports nothing from the platform.

## What it enforces

| Guarantee | Mechanism |
|---|---|
| A worker's work area stays its own | a `tools/pre-execute` gate denies main-session `write` / `edit`, lane-destroying shell (including `git worktree remove`) and git's write verbs (`add` / `commit` / `checkout` / `reset` / `stash` / `restore`) aimed at `.worktrees/<feature_id>/` of the **repository root** — two writers in one area is the accident git cannot undo |
| A busy child is never mistaken for idle | the Team-only `wait_agent` is denied to coordinators: it waits on Team members, and the `subagent` children this preset dispatches are invisible to that roster, so its "no active peer" answer describes a different population; the denial names the asynchronous `subagent-settled` notice as the real signal |
| Nothing leaves the repository unasked | `git push`, package publishing and `gh pr` / `gh release` are denied; those are the user's decisions |
| Every write task owns a work area | `orch_tool({ action: "create", feature_id })` before the dispatch; the package's `worktree` must be that feature's own area — `"."`, a sibling lane and paths outside the repository are refused — and the dispatch carries it as the child's `cwd`, so the worker starts inside it |
| Feature dispatches carry a real contract | package validation — fenced JSON, `feature_id` / `objective` / `acceptance_criteria` / `worktree`, handbook pointer — applied to a dispatch that carries such a package; prose that merely mentions `feature_id` passes |
| One agent per feature branch | `feature_id` names the branch, the work area and the package field; follow-up orders resume the same agent where the session can address it |
| Wide reads never consume a feature agent | `explore` agents answer read-only sweeps; the platform decides continuability by provider (spawn defines `prepareContinuable`); no `backgroundMode` config or `run_in_background` parameter exists |
| A fresh empty folder can still take work | lazy repository bootstrap on the first `create` **whenever the folder has no enclosing repository**: `git init -b main`, a secret safety net written to `.gitignore`, a baseline commit of **all existing files** (so work areas check out the user's code); the notice rides back in the tool result |
| Enforcement tracks the live session | the gate reads the current preset from the `agentPreset` Session projection, not just the creation header, so a mid-session preset switch cannot leave a session silently ungated |
| Knowledge and capability are shared, enforcement is not | a host row publishes the two manuals **and** the `orch_tool` work-area tool into the **global** layers, so every preset can load the manuals and call the tool; the protocol section, the worker hint and the gate stay scoped to the `orch-lite` preset (mounted from the `/preset` subpath) |
| The two profile conflicts are visible | the browser half registers a composer banner (below) that names the Team and Git Worktrees conflicts and offers the one action that stops each; the global host row uses the **bare** package specifier because that is the row `dsh-client-modules` attaches a `dsh.client` bundle to |

## What the gate deliberately does not do

The v1.0 line enforced a coordinator that could not touch a file. That was one mechanism too many:
it locked out every other skill with its own "write this file" convention, and it blocked ordinary
work (`pnpm install`, `git checkout`) that a `git` command or a sentence reverses. Since v1.1:

- **the main session writes its own project files freely** — `write`, `edit`, commits, branch work,
  installs; only the guarantees above stop it;
- **no depth ban on workers** — the Host's `subagent.maxDepth` setting (default `1`, user-tunable)
  already rejects a child's delegation attempt, and a plugin cannot know better than the operator;
- **no concurrency bookkeeping** — no live-worker registry, no pending slots, no ack parsing: with every
  worker in its own area, "may the coordinator write here?" is a path question, not a state question;
- **no audit file** — every denial already arrives in the model's context as its own reason.

Rationale and the risk ledger behind each cut: `DEVLOG.md` § v1.1.0.

The one tool it registers is `orch_tool`, with five actions: `create` (allocate `.worktrees/<feature_id>/`),
`merge` (integrate the feature branch), `remove` (retire the work area; the branch always survives),
`list` (read-only: every work area and every feature branch without one) and `doctor` (read-only: work-area
hygiene — dirty areas, areas whose branch is already merged, and feature-id commits that landed directly
on the integration branch).
Next to it the bundle ships two runtime skills — `orch-lite` (coordinator manual) and
`orch-lite-executor` (worker handbook) — also registered **globally**. Only enforcement is
preset-scoped. A session outside the preset therefore gets the discipline and the tool but no
enforcement, which is why both manuals open with a scope note saying exactly that.

## The profile-conflict banner (client half)

Two bundles a desktop profile commonly mounts fight this preset silently, and the Node half cannot
see either fight — it reads a session, not the profile's bundle selection:

| Bundle | What it does to an orch-lite session |
|---|---|
| `@deepseek-ai/dsh-experimental-agent-team-profile` | its layer disables `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent` and `tool-subagent-fork`, so a running dispatched child reads as idle and cannot be continued |
| `@deepseek-ai/dsh-experimental-tool-worktree` | adds a create-only `create_worktree` whose create path moves the session's own working directory into `.agents/worktrees/<branch>`, so later children inherit that cwd |

The bundle therefore ships a browser half (`lib/client.js`, declared through `dsh.client` with
`platform: web`, `immediately: true` and `inject: ["@deepseek-ai/dsh-client-ui-conversation"]`). It
is attached to the **bare** `dsh-orch-lite` Loader row — the global host row — because
`dsh-client-modules` serves a `dsh.client` bundle only for the row whose specifier is the bare
package name, and a preset's rows live in a detached tree it never scans; that is why the
preset-scoped enforcement mounts from the `dsh-orch-lite/preset` subpath instead. The browser half
registers **one** entry in the session-scoped `conversation.input.dock` list slot — the strip above
the composer — and reads `pluginManager.listBundles()` on mount. When neither bundle is enabled it
renders nothing. When one is, it prints that one line of conflict, the effect of switching it off,
and a **Turn Team off** / **Turn Git Worktrees off** button; the click calls
`pluginManager.setBundleEnabled(bundle, false)` and renders the Host's own application state
(`applied` / `restart-required` / `overridden` / `failed` / `cancelled`) instead of claiming success.
The list refreshes on `plugin-manager/changed`.

Turning Team off removes that bundle's `disabled: true` overrides, which is what restores the four
child-control tools child listing and continuation need. Nothing is ever re-enabled from the banner:
enabling a bundle appends it to the end of the profile's bundle list and changes patch precedence, so
that stays a deliberate act in **Plugins**. Colours use only `--dsw-alias-*` tokens and the browser
half requires only the platform's `react` — no Harness client package, no stylesheet.

## Requirements

- A DSH installation whose base profile provides `tools`, `systemPrompt`, `skills`, `subprocess`,
  `fs` and the `subagent` tool family. Nothing else: **no npm dependencies, no Python, no hook
  bridge** (the v0.1 hook bridge was removed in v0.2 — see `DEVLOG.md`).
- Node built-ins only (`node:fs`, `node:path`, `node:os`, `node:url`, `node:crypto`).
- For the browser half: a Web GUI release that serves `dsh.client` bundles (`dsh-client-modules`) and
  mounts `conversation.input.dock`. `react` comes from the platform module table.

## Install

The preset ships as one bundle patch (`presets/orch-lite.patch.yml`) that inserts two rows: the
`@deepseek-ai/dsh-agent-preset` declaration, and the global host row under the **bare** package
specifier (the row that also carries the browser half; enforcement mounts from `/preset` inside the
declaration). Register the bundle with the profile:

```text
plugin_manager install_bundle  target: <absolute path to this directory>   # directory / link install
plugin_manager install_bundle  target: file:<path to the .tgz>            # tarball install
```

Then **restart the host process and open a NEW session**, selecting the `Orch-lite` preset.
Three platform behaviours matter here:

- source edits to a linked plugin are not hot-reloaded (the base composition only enables config
  watching), so a restart is required for JS changes;
- sessions keep the preset revision they were created with, so an existing session will not pick up
  a new revision — always test in a fresh session;
- the browser half is served over `/plugins`, so after the restart **reload the page**. A build that
  removes `lib/client.js` from the pack breaks the banner loudly (the module fails activation).

## Verify after install

1. In a new preset session, the tools panel shows `orch_tool`, and `explore` is available as a
   dispatch tool.
2. Loading skill `orch-lite` returns the manual and a `Base directory for this skill: …` line.
3. Ask for a small edit: it should make the edit itself with `[routing] chat` — **no denial**. This is
   the regression v1.0 existed to fix.
4. Ask for a write task worth backgrounding: `[routing] task <fid>` → `orch_tool create` → a dispatch
   whose package carries `"worktree"`. A package without it is refused with an actionable reason.
5. Ask it to write a file **inside** `.worktrees/<fid>/`: denied, with the worker-lane reason.
   Same for `rm -rf .worktrees/<fid>`, for `git add` / `commit` / `checkout` / `reset` / `stash` /
   `restore` aimed at a lane, and for `git push`.
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
11. Call `orch_tool({ action: "list" })` and `orch_tool({ action: "doctor" })`: both are read-only, both
    report the work areas without touching the repository, and `doctor` names the dirty, stale and
    bypassed cases. Neither needs a `feature_id`.
12. Call `wait_agent` (Team composition): denied for the coordinator, with the Team-only semantics and
    the `subagent-settled` notice named; a dispatched worker calling it is not blocked by this gate.
13. Call `create_worktree` (Git Worktrees bundle): denied for the coordinator, naming the bundle, its
    create-only relocating behaviour and the preset's own route; a worker is not blocked.
14. Profile-conflict banner: with **Agent Team** and/or **Git Worktrees** enabled in the profile, the
    strip above the composer names the conflict and offers **Turn … off**. Clicking it reports the
    Host's own state (`applied` / `restart-required` / `overridden` / `failed`) and the row disappears
    once the bundle is off. With neither bundle enabled the banner is absent entirely.
15. Turn Team off, then re-open **Plugins**: the four child-control tools are listed again and a
    dispatched child can be listed and continued. Re-enabling Team stays manual, by design.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | preset half: protocol section, gate wiring, worker hint (mounted by the preset's `orch` row from the `dsh-orch-lite/preset` subpath) |
| `lib/host.js` | host half: publishes the two manuals **and** `orch_tool` into the global layers; the package root (bare specifier `dsh-orch-lite`, and `./host`), which is also the row `dsh.client` attaches the browser half to |
| `lib/client.js` | browser half: the `conversation.input.dock` banner naming the Team and Git Worktrees conflicts, with the one action that stops each (exported as `dsh-orch-lite/client` through `dsh.client`) |
| `lib/tool.js` | the one work-area tool (`create` / `merge` / `remove` / `list` / `doctor`) |
| `lib/workspace.js` | repository resolution, lazy bootstrap, the `.worktrees` pool and its self-ignoring `.gitignore`, feature-id validation |
| `lib/gate.js` | the enforcement rules as pure functions (worker-lane path test, external-effect shell, opt-in package validation, agent classification) |
| `lib/git.js` | the plugin's only subprocess boundary (git, argv-based, bounded, deadline-guarded, inherited-environment scrubbed, hooks and filter drivers neutralised) |
| `lib/define-tool.js` | local `defineTool` (platform packages are not resolvable from a linked plugin) |
| `skills/*/SKILL.md` | the two manuals, loaded on demand, registered globally at runtime |
| `presets/orch-lite.patch.yml` | the bundle patch: the preset row (gate, protocol, `explore` lane) **and** the bare-named host row, plus the copied `standard` composition |
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
npm pack --dry-run                # preview the pack: 16 files (no lib/audit.js), LICENSE included
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
- **Runtime writes are workspace-level, by design**: `.worktrees/` plus its own self-ignoring
  `.gitignore` (the repository's tracked `.gitignore` is only touched by a bootstrap's secret safety
  net), plus the lazy repository bootstrap in a folder that has none. Removing the bundle leaves
  those artifacts behind; delete them if unwanted.

## Uninstall

Remove the bundle row from the profile (and the `dsh-orch-lite` dependency/link), restart,
then optionally delete `.worktrees/` and the `feature/*` branches. No platform file needs to be
restored, because none was changed.

## License

MIT — see [`LICENSE`](./LICENSE). The source is published at
<https://github.com/LYJ132/dsh-orch-lite>. The manifest carries npm publishing metadata
(`repository`, `author`, no `"private"` flag), but nothing has been published to a registry —
installs run from a directory, a tarball or a `git+…` URL.
