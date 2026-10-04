# dsh-orch-lite

> 每次开发会话结束时追加新记录。记录无法从 Git 获取的信息。

---

## 会话记录

### 2026-10-02 - 历史重建与开源发布（open-source release）

**当前分支**：main

**已完成**：
- 将旧历史完整打包备份到 `temp/history-backup-20261002.bundle`（`git bundle create --all`，已 verify），该文件不入库（temp/ 已忽略）
- 删除 `.git` 并重新 `git init -b main`，全新历史不再包含错误的 1.1.0 提交（真实版本线为 1.0.0 → 1.0.1 → 1.0.2，package.json 版本 1.0.2）
- `.gitignore` 追加忽略 `temp/` 与 `.orch-lite/`
- 新增 `LICENSE`（MIT，Copyright (c) 2026 LYJ132，与 orch-lite 参考插件措辞一致）
- `README.md` License 章节补充 GitHub 仓库地址与 LICENSE 链接
- `DEVLOG.md` 中"interim numbering 留在旧提交里不改"的说明已更新为历史重建后的实际情况
- 在 GitHub 创建公开仓库 LYJ132/dsh-orch-lite 并推送 main（`git push -u origin main`）

**遇到的问题及解决方案**：
- 旧的首次提交信息含 "orch-lite 1.1.0"（错误版本号），无法通过普通 rebase 干净移除 → 按用户要求整体重建历史，旧历史保留在 temp/ bundle 备份中

**注意事项**：
- 仓库发布在 https://github.com/LYJ132/dsh-orch-lite （public，MIT）
- package.json 保持 `"private": true`，仅阻止 npm 误发布，不影响 GitHub 开源
- temp/ 内的 bundle 备份是旧历史唯一去处，需要追溯时用 `git clone temp/history-backup-20261002.bundle`

**下一步计划**：
- 如后续需要 npm 发布，再评估移除 `"private": true`
- DSH 更新 standard preset 后记得重跑 `scripts/gen-preset.mjs` 同步 composition

---

### 2026-10-02 - 文档漂移修正、版本 tag 与仓库清理

**当前分支**：main

**已完成**：
- 把 README / DEVLOG / CHANGELOG 与已发布代码逐条对照，修掉三处陈旧描述：
  - DEVLOG 移植附录的 "Always-worktree for write tasks"（v0.2/v0.3 的旧策略）→ 改为 v0.4 起的 lazy isolation，并补上并发半场由门禁强制、solo 通道的 pending 槽 / 脏树保护 / `into` 参数
  - 测试数量 62 → 109（并列出新增覆盖：host skills row、打包不变量、仓库 bootstrap、审计链）
  - "安装会物化为 `link:`" → 目录安装是链接；本 profile 实际用的是 tarball 安装（真实目录，无符号链接）
- README 布局表补 `CHANGELOG.md` / `memory.md` / `LICENSE` 三行；开发循环的打包命令改为实际产物名 `dsh-orch-lite-<version>.tgz`（原文的 `local-` 前缀是 `@local/` 时代残留）
- README License 段更新：`package.json` 已去掉 `"private": true` 并补齐 npm 元数据（repository / author / bugs / homepage），但尚未发布到任何 registry
- 删除 `.orch-lite/` 残留（原版 CLI 留下的空 `index.json` / `memory.json`，已被 `.gitignore` 忽略）
- 建立版本 tag：`v1.0.2` → `bf01dcb`（打包 1.0.2 产物所对应的树）；`v1.0.0` / `v1.0.1` 因历史重建后无对应提交，故意不打 tag

**遇到的问题及解决方案**：
- 发现打包产物与仓库不一致：`dist/dsh-orch-lite-1.0.2.tgz`（13:09 打包）早于 LICENSE（13:36）与去掉 private 的提交（e004f88），因此它只有 12 个文件且仍是 `"private": true`。按"已发布版本不被静默重切"的既有纪律，不在原地重打包，留给下一次版本号变更解决。

**注意事项**：
- 本次只改文档与仓库卫生，运行时代码零改动；`npm test` 仍为 109/109
- 版本号仍是 1.0.2，HEAD 相对 `v1.0.2` tag 只多出 package.json 的 npm 元数据与文档修正

**下一步计划**：
- 若要消除"产物与仓库不一致"的缺口，建议切 **1.0.3**：版本号 +1、重新 `npm pack`、`install_bundle` 覆盖安装，然后重启宿主
- 讨论过的 P0-A（commit trailer 规范 / `worktree_merge` 用 `--no-ff` / base 记录）与 P1（append-only ledger + `orch_index` 投影工具）待选定后实施

---

### 2026-10-02 - v1.0.3：能力全局、强制按预设、单工具 orch_tool

**当前分支**：main

**已完成**：
- 新需求落地：插件在**所有预设**可用。host 行（`lib/host.js`）现在同时注册两份手册**和** `orch_tool`（进 global layer，每个会话可见）；预设行（`lib/index.js`）只保留 protocol 段、boot 注入与门禁。
- 三个工具合并为一个 `orch_tool({ action: create|merge|remove, feature_id, base?, into? })`；模块拆分：`lib/tool.js`（工具）、`lib/workspace.js`（仓库/工作区管道）、`lib/audit.js`（审计），原 `lib/skills.js` 删除并改名 `lib/host.js`，导出 `./host` 取代 `./skills`。
- protocol 段的"工具不可见就渲染空串"守卫删除（工具已全局，守卫的唯一致命模式就是静默空段）。
- 复用按 B 方案：分支是硬规则；唤醒 agent 只在会话的 `send_message` 收 `agent_id` 时可用，收 `target`（Teams 版）则视为不可续用、新派并把结论放进 `STILL VALID`。两份手册 + 协议段都写明了这条。
- 新增 freshness 守卫测试：任何出厂文件不得再出现旧工具名；两份手册都在 8192 修剪线以内。
- 测试 109 → **116/116 通过**；`presets/orch-lite.patch.yml` 与 `scripts/gen-preset.mjs` 同步（host 行 id `orch-lite-host`）。

**遇到的问题及解决方案**：
- 重跑生成器时发现 **DSH 的 standard preset 已经漂移**（新增 `tool-cordis`、`skill-filesystem.customSkillDirs`、persona 改成块标量等）。为了让本次提交的 diff 干净，先把补丁回退、只手工改我们自己的行；平台漂移的同步留作**单独一次提交**（下一步计划）。
- 手册一度涨到 8489 字符，超过工具结果修剪线（8192）→ 压缩文案到 8178 以下。

**注意事项**：
- 工具在非 orch-lite 预设里**没有门禁**：纪律只是文档，这是本轮明确的取舍。
- Teams 组合下 `send_message` 是 Team 版 → 续用不可用，属平台级同名工具遮蔽，本插件只做优雅降级，不做补救机制。

**下一步计划**：
- 单独提交一次"standard 组合刷新"（`node scripts/gen-preset.mjs <web-app 的 presets/cordis.patch.yml> presets/orch-lite.patch.yml`），并复核新增行是否影响我们。
- 打包 1.0.3 → 安装到 profile → 重启宿主，然后按 README 的 9 步清单验收（重点第 9 步：别的预设里 `orch_tool` 是否真的可见）。

---

### 2026-10-03 - v1.1.0：门禁瘦身（S2 一律 worktree）

**当前分支**：main（改动尚未提交）

**已完成**：
- 对 v1.0.3 做逐条机制审计，判据固定为"只为不可逆且严重的事故加机制"，据此改代码：
  - 主会话 `write`/`edit` 与变更型 shell 不再一律拒绝，改为**只在 worker 通道（`.worktrees/<fid>/`）内拒绝**；shell 只保留两类：效应离开仓库（`git push` / publish / `gh pr`）与破坏通道内容
  - 派发包校验改 **opt-in**：prompt 出现 `feature_id` 或指向 `orch-lite-executor` 才校验，其他 skill 的派发原样放行
  - 删：执行器禁派发（`EXECUTOR_DENIED_TOOLS`）、`evaluateExplore`、活体注册表（`children`/`runToChild`/父级归组）、`pending` 槽位、`tools/post-execute` 释放器、worktree 形状/存在校验、`audit.log` 落盘
  - 保留（明确否决了"顺手删 orch_tool"的方案）：`orch_tool` 三动作 + 懒建仓库 bootstrap + `assertSlug`。理由是"少让模型记东西"：工具 schema 被动常驻无需回忆；写进手册的 git 配方要模型主动加载并正确复述（尤其 merge 冲突要先读 `--diff-filter=U` 再 `--abort`，漏了会留 `MERGE_HEAD` 污染后续所有 worker）
- **S2 决策**：写任务一律开 worktree，取消 solo/concurrent 二选一。本轮最大简化——"这里能不能写"从状态问题变成路径问题，因此活体计数彻底不需要
- bootstrap 通知从日志改到 `orch_tool` create 结果的 `note` 字段；执行手册里重复的 `git init` 配方删除（两处真相源归一）
- 平台取证（grep `app.asar`，已记进 DEVLOG）：`subagent.maxDepth` 是 Host 设置（默认 1、用户可改、到上限时工具仍可见并返回出错结果）；`spawn_teammate`/`interrupt_agent` 由执行层限 Lead；`subagent/start|end` 平台强制成对；`ctx.agents.list()/isOwnedBy()/status` 是查活体 agent 的官方 API（本轮没用上，未来需要时的正确入口，不要再自建 Map）
- 文档同步：README 重写（新增"What the gate deliberately does not do"）、DEVLOG 新开 § v1.1.0（判决台账）、CHANGELOG 1.1.0、两份手册与协议段改写、`gen-preset.mjs` 与 `orch-lite.patch.yml` 同步
- `package.json` → 1.1.0；删 `git.js` 死代码 `lastCommitFiles`/`displayPath`

**遇到的问题及解决方案**：
- YAML：preset `description` 含 `": "` 会破坏 plain scalar，改用破折号，并加了守卫测试
- 沙箱默认无法起 PowerShell（`SetNamedSecurityInfoW failed (Win32 5)`，命令执行前就失败）；经一次 `danger-full-access` 授权后 node 可跑，用户随后把审批策略改为 never。验证结果：**`node --check` 全通过，测试 121/121**（第一版有 1 条 FAIL，是我测试里断言字符串写错，不是代码问题）
- `lib/audit.js` 已删除（沙箱放开后可直接 `Remove-Item`），pack 从 16 → 15 个文件
- 手册修剪线：协调手册正文 7087 字符（余量 1105），执行手册 4744（余量 3448），均在 8192 以内并有守卫测试

**注意事项**：
- 产品保证的降级是**主动接受**的：主会话空闲时可自己动手，上下文卫生（P2）从此只靠协议段与手册，不再由门禁保证
- 防"两个写者互踩"这个 A 类事故的手段现在是：通道路径拒绝（主会话侧）+ 一分支一 worktree（git 自身拒绝同分支二次 checkout，worker 侧）
- 发布纪律照旧：1.1.0 需 `npm pack` + `install_bundle` + 重启宿主 + 新会话验收（README 十步，第 3、5、6 步是本次行为回归点）

**下一步计划**：
- `npm test` 已跑：121/121 通过（`node --check` 亦全通过）
- 重跑 `node scripts/gen-preset.mjs <web-app 的 presets/cordis.patch.yml> presets/orch-lite.patch.yml` 同步 standard 漂移（1.0.3 遗留：standard 新增 `tool-cordis`、`skill-filesystem.customSkillDirs` 等）
- 打包 1.1.0 安装验收；`.orch-lite/`（空壳）与 `temp/` bundle 待清理
- 观察 DEVLOG § v1.1.0 "What to watch" 三条：该后台化的活是否仍被派发、通道规则误伤、纯文本里出现 `feature_id` 会不会误拦

---
