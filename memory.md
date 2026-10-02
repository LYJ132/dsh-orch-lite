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
