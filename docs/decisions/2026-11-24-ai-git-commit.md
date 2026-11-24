# AI 提交草稿与本机暂存提交

## 问题与范围

Git 文件视图需要清楚显示文件名、目录和变动状态。用户从所选工作树的暂存区生成一份提交说明，核对文件、编辑文字并明确确认。工作台配置的默认模型负责起草。Node 运行时通过本机 Git 提交同一份内容，成功后刷新状态、分支和历史。

## 方案与依据

- [VS Code 的提交说明生成](https://code.visualstudio.com/docs/sourcecontrol/staging-commits#_generate-commit-messages-with-ai) 将生成与可编辑的提交操作分开。阅读其 extensions/git/src/git.ts 的 Repository.commit，用参数和标准输入传递文字。[GitHub Desktop 的 createCommit](https://github.com/desktop/desktop/blob/7abdff678e47ebc5b1c3cb60615f79b1bd6a8738/app/src/lib/git/commit.ts) 会重建索引，以便按其独立文件选择提交。Atelier 的选择来自现有 Git 暂存区，直接读取同一索引可以保留外部暂存和部分暂存。
- [Git write-tree](https://git-scm.com/docs/git-write-tree)、[commit-tree](https://git-scm.com/docs/git-commit-tree) 和 [update-ref](https://git-scm.com/docs/git-update-ref) 分别确定树、写入提交对象并按预期旧值更新引用。核对了 git/git 的 cache-tree.c 和 builtin/commit.c。直接执行普通 commit 会自行重新读取索引。确认操作持有检出的 index.lock，向临时索引副本写树，核对暂存树、HEAD、分支与工作树身份，再原子更新已核对的引用。用 Git 2.56 实测分离索引、首次提交和 intent-to-add，原索引字节保持一致。
- 沿用现有 Git 目录租约、配对 API 与受限 Git 环境。仅作者身份及签名偏好的读取和提交对象写入使用用户 Git 配置。提交参数固定，签名要求明确提示使用本机 Git。应用的钩子、过滤器和隐式访网限制沿用[Git 工作树决策](2026-11-24-git-development-sessions.md)。冲突、Git 正在操作、目录被运行占用或暂存版本变化时保留草稿和原暂存区。
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create) 与当前网关兼容。起草接口发送限长的暂存差异和文件统计，请求纯文本结果。模型没有工具或步骤控制权，生成失败可编辑手写草稿。确认接口只接收已审核的版本、标题和正文，直接交给本机 Git。暂存有变化时可重读文件清单并保留文字。

## 验收与回退

以真实系统 Git 和隔离项目核对生成仅使用暂存内容、确认传递编辑结果、并发重复确认和暂存改动拒绝。模型用本地回环夹具验证消息协议。用隔离 Electron 检查可编辑流程、失败提示、中英文与明暗主题。回退移除两个提交接口和视图入口，已生成的提交继续由 Git 管理。
