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
