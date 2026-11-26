# GitHub Skill 完整包导入

## 问题与范围

公开来源导入目前从 GitHub 读取单个 Markdown。脚本和参考文件不会随正文进入项目，检查更新也无法识别附属文件变化。批准方案要求沿用项目扩展入口、现有技能包记录和会话权限。覆盖公开 GitHub 仓库、目录和 SKILL.md。已有 SkillHub ZIP、命令和 MCP 继续使用各自的来源流程。

## 查阅来源与取舍

- [Vercel Skills 的发现](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/skills.ts#L235-L324) 同时支持常用目录和递归发现。[版本记录](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/skill-lock.ts#L11-L35) 独立保存 ref、commit、路径和目录哈希。Atelier 采用同样的版本分工，并在同名时保留路径供用户选取。
- [Codex 安装器](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.system/skill-installer/scripts/install-skill-from-github.py#L80-L205) 使用 ZIP 或 sparse checkout，并在复制前检查路径及目标冲突。Atelier 已有数据库包记录，可用 GitHub 树限定文件范围，在内存中验证字节后原子提交，无需安装时创建 checkout。
- [GitHub Commit API](https://docs.github.com/en/rest/commits/commits#get-a-commit) 解析 ref，[Trees API](https://docs.github.com/en/rest/git/trees#get-a-tree) 返回目录、模式、大小和 blob ID。下载时使用固定提交的 raw 文件并按 [Git blob 规则](https://docs.github.com/en/rest/git/blobs#get-a-blob) 校验字节。树截断时要求缩小目录范围。
- [OpenCode Skill 加载](https://opencode.ai/docs/skills/#loading) 由会话带入正文和资源目录。Atelier 沿用安装项的手动与自动作用域。受控模式提供包内文本读取和原有隔离 Python。Linux 本机信任通过临时包目录和现有原生工具执行，保留文件执行位，随运行清理。SDK 仍使用应用生成的 frontmatter。

## 版本与持久化

项目扩展的 JSON 增加可选的 GitHub 版本来源和文件执行位。以排序后的相对路径、文件模式、长度和 blob ID 计算 SHA-256 目录摘要。更新用当前跟踪 ref 生成新预览，提交时用预览提交与目录摘要核对完整下载。版本冲突、同名来源和本地编辑由现有项目记录的事务校验。已有正文导入按来源位置匹配，沿用 ID、启用状态和已有设置。

## 验证与回退

用可控 GitHub 响应覆盖 ref 移动、截断、路径与文件类型、安装中断、重复安装、附件变更、并发和旧记录升级。用真实公开来源验证目录与字节，再从隔离 Electron 和锁定 SDK 走安装、会话读资源和脚本运行。运行仓库检查、全量测试和两种构建。

回退可撤下 GitHub 发现和安装入口。新增可选的 JSON 字段无需数据库降级，现有应用可继续读扩展正文和既有技能包。切换旧版前保留数据副本。
