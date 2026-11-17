# 本机首版接口约定

本文件用于主会话与一个前端子代理并行实现。目标为功能优先的个人本机版本，保留现有浅色三栏布局。前端只调用本地 API，不包含 SDK、密钥或演示结果。服务端默认 http://127.0.0.1:4317。

## 通用

JSON 请求/响应；错误 HTTP 非 2xx，`{error:{code,message,retryable}}`。所有修改请求带 `Content-Type: application/json` 与 `X-Atelier-Token`（bootstrap 返回 csrfToken，内存保存）。fetch 同源。GET 无需 token。分页用 `limit`（默认50）和数字 `offset`，列表响应 `{items,total,nextOffset}`。

`GET /api/bootstrap` 返回 `{csrfToken,cursor,projects:Project[],sessions:Session[],runs:Run[],artifacts:Artifact[],config:{gateway,model,maxTurns,timeoutMs},capabilities:{commands:boolean},connection:{available:boolean,message:string}}`。

`GET /api/events?after=<cursor>` 是全局 SSE（默认 message 事件），id 为全局整数，data 为 `{id,runId,sessionId,seq,type,at,payload}`。事件表保留所有本机记录，自动重连接受 Last-Event-ID。前端可对事件去重后节流重新取当前会话快照、列表，而不用自己合并 SDK 帧。bootstrap.cursor 与会话快照.cursor 给出快照边界。运行状态与 SSE 连接状态分别展示。没有事件时只有 keepalive 注释。

## 对象

- Project: `{id,name,path,branch,available,createdAt}`
- Session: `{id,projectId,title,status:'active'|'archived',sdkSessionId:null|string,createdAt,updatedAt,draft:{text,contextPaths:string[],attachmentIds:string[],mode:'readonly'|'edit'}}`
- Run: `{id,sessionId,projectId,prompt,status:'queued'|'running'|'awaiting_permission'|'stopping'|'completed'|'stopped'|'failed'|'interrupted',mode,createdAt,startedAt,endedAt,reason,error,retryOf,contextPaths,attachmentIds,plan:Step[],usage:null|Usage}`
- Message: `{id,sessionId,runId,role:'user'|'assistant',text,createdAt}`（文本在执行中持续更新）
- ToolCall: `{id,runId,sessionId,name,inputSummary,status:'running'|'awaiting_permission'|'succeeded'|'failed'|'denied'|'canceled',output,outputLength?,outputTruncated?,startedAt,endedAt,permissionId?}`；output 为短预览，截断时完整内容另有分页/下载入口
- Permission: `{id,runId,sessionId,toolCallId,kind:'write'|'edit'|'delete'|'command',path:null|string,command:null|string,before:null|string,after:null|string,diff:string,baseFingerprint:null|string,version:string,status:'pending'|'allowed'|'denied'|'expired'|'canceled',createdAt,expiresAt,reason}`
- Artifact: `{id,runId,sessionId,projectId,name,mime,size,fingerprint,availability:'available'|'unavailable',createdAt}`
- Attachment: `{id,sessionId,name,mime,size,status:'ready'|'used',createdAt}`
- Step: `{content,status:'pending'|'in_progress'|'completed'}`；仅模型实际调用工作台 update_plan（或可用的 SDK TodoWrite）时存在
- Usage: `{model,inputTokens:null|number,outputTokens:null|number,cacheReadTokens:null|number,cacheCreationTokens:null|number,sdkEstimateUsd:null|number,costEstimateUsd:null,pricingBasis:'unknown',complete:boolean}`；actual cost 默认未知，SDK estimate 明确标为非账单

所有时间为 ISO string，可为空的时间/原因/错误用 null。相对路径是项目内路径，禁止前端拼接任意绝对下载地址。

## 项目/会话

- GET `/api/projects` → 列表
- POST `/api/projects` `{path}` → `{project}`；用户输入本机绝对目录，服务端验证。首次使用弹窗绑定目录即可，无桌面壳
- GET `/api/projects/:id/files?path=<relative dir>` → `{items:[{name,path,isDirectory,size}],path}`；目录逐级选择，后端过滤敏感/链接条目
- GET `/api/projects/:id/file?path=<relative file>` → `{path,text}`（文本预览）
- GET `/api/sessions?query=&projectId=&includeArchived=true` → 列表，最近活动排序
- POST `/api/sessions` `{projectId}` → `{session}`
- GET `/api/sessions/:id` → `{session,project,messages:Message[],runs:Run[],tools:ToolCall[],permissions:Permission[],artifacts:Artifact[],attachments:Attachment[],events:Event[],cursor}`；首版返回当前会话完整快照，消息也提供分页端点
- GET `/api/sessions/:id/messages?limit=&offset=` → 列表
- PATCH `/api/sessions/:id` `{title?,status?,draft?}` → `{session}`；草稿按会话保存，输入防抖；用户选 readonly/edit 是每次发送权限范围，edit 仍需逐操作批准
- DELETE `/api/sessions/:id` → `{ok:true}`；活动运行时409，界面明确删除历史不会删除项目源文件
- POST `/api/sessions/:id/messages` `{text,mode,contextPaths,attachmentIds,idempotencyKey}` → 202 `{run}`。idempotencyKey 为 UUID，网络重试重用。会话/项目已有活动运行409。readonly 不提供写入或命令工具

## 运行/审批

- GET `/api/runs?sessionId=&projectId=&status=` → 列表
- GET `/api/runs/:id` → `{run,tools,permissions,artifacts,events}`
- POST `/api/runs/:id/stop` `{}` → `{run}`；先 stopping，退出确认后 stopped
- POST `/api/runs/:id/retry` `{idempotencyKey}` → 202 `{run}`；安全重试为只读恢复分析，明确不会自动重复上次写入
- GET `/api/tools/:id/output?offset=0&limit=16000` → `{text,offset,total,nextOffset}`；`download=1` 下载完整文本
- GET `/api/permissions/:id` → `{permission}`
- POST `/api/permissions/:id/decision` `{decision:'allow'|'deny',version}` → `{permission}`；同决定重发幂等，相反/过期/取消409；基线变化返回 OPERATION_CHANGED 并拒绝
- GET `/api/permissions/:id/diff` → `{diff,before,after,path,kind,version}`

## 附件/成果/配置

- POST `/api/sessions/:id/attachments` `{name,mime,contentBase64}` → `{attachment}`；首版仅 UTF-8 文本：txt/md/json/csv/js/ts/jsx/tsx/css/html/yaml/yml/log/py，单个<=1MiB，单轮附件+上下文文本总量<=128KiB。前端文件选择后显示读取/上传状态及失败提示。用户发送时冻结引用
- DELETE `/api/sessions/:id/attachments/:attachmentId` → `{ok:true}`；取消附加不改原文件，已用于历史的内容保留
- GET `/api/artifacts?sessionId=&projectId=` → 列表
- GET `/api/artifacts/:id/content` → `{artifact,text,previewable}`；只将文本放 textContent/pre，不执行 HTML
- GET `/api/artifacts/:id/download` → 文件下载（immutable snapshot）
- GET `/api/config` → `{config,capabilities,connection}`
- PATCH `/api/config` `{gateway?,model?,maxTurns?,timeoutMs?}` → 同 GET；只配置非敏感本机网关参数，不在浏览器收集密钥

## 前端行为

空态先绑定项目再新建会话；主对话真实文本，轨迹真实工具/事件，右侧列出每个 pending permission，详情显示准确 diff/命令。切换会话保留各自草稿与附件；活动会话不能重命名删除导致丢运行（重命名可允许，删除需先停）；全局运行每轮独立，成果明确来源；用量暂无不能显示0；无计划隐藏计划区域。停止、重试、归档/恢复/删除都有实际接口和错误处理。

保持原设计，补齐小屏菜单/详情抽屉焦点及背景隔离、dialog 关闭恢复、tab 方向键、IME Enter、接近底部才跟随及新消息提示。暂时无需框架迁移。
