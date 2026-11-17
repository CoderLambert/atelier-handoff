# T01 · Claude Agent SDK 验证程序

独立验证 atelier 的运行载体与 SDK 能力。产品页面仍为静态设计基线，本程序没有给页面接线，也不提供 HTTP 服务或数据库。

本轮连接为：官方 `@anthropic-ai/claude-agent-sdk@0.3.326` → 本机 Shunt `http://127.0.0.1:3001` → `chatgpt-plan` / `gpt-6.1-sol`。OpenAI OAuth 凭据由 Shunt 管理；本程序只使用本机网关的占位认证，不读取或复制 OAuth 文件。当前 Claude Code 会话的全局代理配置不传给实验。

## 环境与命令

固定验证环境为 Node **24.21.0**；SDK 配套原生 CLI **2.1.326**，通过平台 optional dependency 安装。不要用 `--omit=optional`。TypeScript、tsx 和类型依赖锁定在 package-lock.json。

在本目录执行；本机可用以下方式选择已安装的 Node，不改变全局版本：

```sh
export PATH=/home/lambert/.local/share/mise/installs/node/24.21.0/bin:$PATH
npm ci
npm run check
npm run offline
npm run preflight
```

- `check`：只做 TypeScript 类型检查。
- `offline`：只操作自己创建的临时夹具，不加载 SDK 运行时或发起模型请求。
- `preflight`：检查 Node/SDK 版本及 Shunt `/health`，没有模型推理。
- `live -- --suite core`：执行真实模型实验，会消耗 Shunt 上游套餐额度；需先取得调用范围授权。

本轮用户已授权最多 8 次 query/续接、8 个输入动作，每次最多 6 轮和 120 秒；设置单次 $0.50、整批 $4 的 SDK 估算软限额。该美元估算不代表 ChatGPT 套餐账单。SDK 内部工具循环/重试可能产生多次 HTTP 请求。

```sh
npm run live -- --suite core
```

`.authorization-ledger.json` 保存已消耗/预留的输入和查询数量，重新运行不会重置；`.live-lock` 防止多个验证器同时运行。额度耗尽后须另行获得授权并审阅新批次安排，不能删除台账以重复本批。异常退出留下锁时先确认原验证进程已结束，再处理锁文件。本轮不需要重启已在运行的 Shunt。

## 程序与场景

| 文件 | 职责 |
| --- | --- |
| run.ts | 环境预检、调用计数、临时项目、SDK 进程、场景断言和汇总 |
| policy.ts | Read/Edit/Write 边界、真实操作快照、异步允许/拒绝及取消 |
| events.ts | SDK 事件关联、内容摘要、脱敏 JSONL 与消息输入队列 |
| offline.test.ts | 路径、链接、基线变化、审批竞争和事件证据的确定性测试 |
| evidence/ | 本轮留下的可复核结果；真实状态以结果文件为准 |

真实场景按顺序覆盖：只读随机标记、跨进程 resume、拒绝 Edit、允许 Edit/Write、等待审批时取消与迟到允许、interrupt 后同进程继续、生成期间 abort。首个只读场景失败就停止后续模型实验。

审批决定由测试器按场景控制；SDK 回调、等待和文件变化是真实的。这里验证底层能力，不等同于产品的人工审批界面或权限服务已经完成。模型未调用目标工具、响应提前结束或断言缺失均不能记为通过。

## 隔离与证据

每批在系统临时目录建立 `atelier-t01-*`，workspace、SDK 状态、外侧哨兵和私有日志分开。模型仅获得 workspace 的 Read，写入场景才开放 Edit/Write；Bash、MCP、子代理和网络工具不开放。`settingSources: []` 与独立 SDK 状态目录隔离普通用户/项目配置，managed policy 仍可能影响实验。

路径守卫拒绝越界、链接和不支持的文件；文件基线在允许前复核。它是应用层保护，不能保证检查与文件打开之间原子，也不是 OS 强沙箱。

`evidence/<批次>/environment.json` 记录环境，逐场景 JSONL 记录工具 ID、决策、真实文本预览、内容指纹及进程事件，`results.json` 给出每项断言结论。完整 SDK transcript/原始 stderr 留在权限受限的临时目录，不作为可分享材料。报告不保留提供商密钥或 OAuth 凭据。

只读和拒绝等场景比较整份目录清单及文件指纹，避免漏掉新建/删除。停止以观察到所属 SDK 子进程退出为证据，不保证撤销已发生写入。`content_block_stop` 不是工具执行成功；需要关联真实 tool_result。

第三方模型不在 Anthropic 官方支持范围。本轮实测结论只适用于记录的具体版本与配置。SDK 的 usage/成本字段按原样保存；实际费用未知时保留 null，不套用 Claude 价格；没有计划数据不生成进度百分比。

完整结果与下一步见 [T01 验证报告](../../docs/t01-sdk-validation.md)。
