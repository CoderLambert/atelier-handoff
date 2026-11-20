# 桌面任务自动化与浏览器布局

用户需要更多网页空间，并在选定任务中取消逐次工具审批。浏览器常态采用标签栏和地址栏两行。长期项目授权说明放入设置对话框，复用原生视图临时隐藏机制。[Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)

全工具自动化是桌面端本轮受控修改的审批策略。项目、智能体和已选择扩展决定可用工具。运行时写入本轮授权后，通过 `PermissionService` 自动记录每个决定，并沿用执行端的沙箱、文件基线、取消和当前授权校验。Codex CLI 将审批策略与执行沙箱分别配置。Agent SDK 的权限模式会改变 SDK 自己的工具授权，Atelier 的桌面自动化由应用内服务裁决。[Codex CLI 参考](https://developers.openai.com/codex/cli/reference) · [Agent SDK 权限](https://code.claude.com/docs/en/agent-sdk/permissions)

已知计费的 Skill 搜索在原有报价、请求 ID 与费用上限之外，使用用户提交时选择的单笔上限。默认额度为零。模型请求的额度可进一步收窄。工具结果和自动批准各有记录，重试不会继承自动化决定。

验收使用隔离项目、回环模型和本地网页，检查默认审批、全工具自动化实际结果、停用与撤销、浏览器尺寸和无重放。发布候选保留原数据格式，旧版忽略新增字段。发生异常时使用普通受控修改模式或重新打开现有 Linux 候选。
