# Git 看板与开发会话目录

## 问题与范围

现有会话在运行入口、SDK、上下文文件、审批和 MCP 中使用项目原目录。并发保护也只看项目目录。用户需要查看真实 Git 状态，在同一项目下同时开发不同分支，并在归档时保留可恢复的改动。Electron 保留窗口与宿主职责。Node 运行时通过配对 API 提供 Git 操作，SQLite 保存目录绑定与操作回执。

## 查阅依据与取舍

- [Git porcelain v2](https://git-scm.com/docs/git-status) 和 [Git worktree](https://git-scm.com/docs/git-worktree) 提供稳定的 NUL 分隔输出。采用本机 Git 的只读状态、提交及差异。新增名称经过 ref 校验，基线使用 Git 返回的完整提交 ID。创建、切换和移动交给 Git 的引用与工作树锁。
- [Claude Code 工作树](https://code.claude.com/docs/en/worktrees) 使用命名分支、独立目录和恢复前元数据校验。Atelier 采用这些机制，基线依照获准方案默认取本机 HEAD。应用提供独立的开发会话入口，SDK 与原生工具协议继续沿用锁定版本。
- [GitHub Desktop 工作树实现](https://github.com/desktop/desktop/blob/7abdff678e47ebc5b1c3cb60615f79b1bd6a8738/app/src/lib/git/worktree.ts) 的 list、add、move、remove 直接调用 Git。采用 CLI 与机器输出的边界。Atelier 通过项目身份区分原目录、受管工作树和其他检出。外部检出显示分支占用，文件内容须从已授权项目的入口查看。
- [Codex 工作树](https://learn.chatgpt.com/docs/environments/git-worktrees) 提供归档快照与再次打开后的恢复。[Codex git-utils](https://github.com/openai/codex/blob/ded559680df03ebf944d01d8fd19be1debb51d04/codex-rs/git-utils/src/ghost_commits.rs) 的 `create_ghost_commit_with_report` 用临时索引保存工作树内容。Atelier 需要逐项重建暂存边界，按 [git apply](https://git-scm.com/docs/git-apply) 用 staged patch 更新索引及工作目录，然后用第二份 patch 更新工作文件。未跟踪文件原样保存。

## 执行与持久化

每次调用使用固定参数列表、本机引用和拥有者校验。系统与用户 Git 配置、仓库钩子、外部 diff、文件转换进程、自动维护与隐式远端获取在应用 Git 调用中关闭。用户仍可在其 Git 工具和显式选择的本机信任会话中操作。Linux 受控命令按 .git 的实际文件类型遮蔽元数据。

通过项目 ID、SQLite 工作树 ID、共同 Git 目录的文件系统身份、预期分支和受管根定位执行目录。旧记录无绑定时继续使用项目原目录。取得执行席位与 Git 目录修改互斥。同一个规范化目录的不同会话可同时执行，同一会话串行。父子目录分别绑定为项目时，运行席位继续检查目录重叠。收尾与回退见 [Claude CLI 的 Bash 生命周期和同目录会话](2026-11-25-claude-bash-and-parallel-sessions.md)。归档只考虑当前项目的数据根内，且由 Atelier 创建的独立目录。Git 工作树记录和会话归属保存在具名表里，跨文件系统操作有持久请求 ID 与可核对的结果。

快照放在应用数据根，包含基线 SHA、原分支、两份二进制安全的 patch、未跟踪内容以及校验清单。在私有临时检出验证后，再读取原目录核对，并移到同一数据根的暂存位置复核后回收。常规关闭无回收副作用。忽略文件要求逐路径标记可重建。锁定、冲突、未能验证的索引或文件、磁盘写入失败和目录身份变化会保留目录或可恢复的暂存路径。恢复先在临时检出重建并核对，再移到原路径。分支已移动或被占用时使用经用户确认的新分支。只有与快照核对一致的目录允许恢复后发送。

## 验证与回退

用真实本地 Git 分别验证分支、工作树、索引和文件字节。用锁定 SDK 与回环消息接口验证 cwd、两个工作树中的同名文件及逐次授权。安装态用隔离的 Linux x64 数据根和 Electron profile 分别走中英文界面。v7 SQLite 升级到 v8 时保留既有会话；发行包需包含迁移 SQL。切换前备份数据库与工作树快照。旧运行时打开升级前副本；通过系统 Git 检查仍在的目录与保留的分支，已回收工作使用新版从快照恢复。

2026-11-24 审查补记。恢复验证同时核对实际 tracked 文件的字节、文件类型和权限位，以覆盖 Git 文本归一化隐藏的差异。快照文件与两份 patch 合计上限为 64 MiB，完整文件核对上限为 1 GiB 和 75,000 条路径。超出限制或不能重建的目录留在原处。源码分支位置可以变化，因此快照基线用本机 `refs/atelier/snapshots/` 保持可达。跨数据根迁入支持已验证的归档快照。当原数据根下仍有独立检出、操作在途或回收暂存目录待核对时，迁入入口保留来源并要求先处理工作树，防止把本机 Git 注册路径带到错误的数据根。
