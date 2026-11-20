# 文档附件与实时补充消息

## 文档附件

会话和队列使用附件 ID 引用本机原件。原始字节流入本地临时文件，验证基本文件结构后登记。图片和 UTF-8 文本沿用已有上传能力。表格预览的 20 MiB 是渲染预算，超出时展示原件下载。本机保存受磁盘空间约束，读取受格式解析预算和单次 `Read` 输出约束。

SDK 原生 `Read` 使用本轮授权的具体文件路径。文本型 PDF 可以提供带页码的提取文本，避免依赖网关转换原生 PDF 消息。表格和 Word 通过本机解析生成带来源的文本视图供 `Read` 分段读取。解析使用固定依赖，独立工作线程负责取消、60 秒时限、512 MiB 堆、256 MiB 解析输入和 128 MiB 文本输出预算。原件下载沿用会话归属校验和规范化文件名。PDF 由 PDF.js 在本机提取带页码的文字，图像型 PDF 返回 OCR 提示。当前验收使用回环模型验证 SDK 文件读取，真实 Shunt 的原生 PDF 转换单独验证。

参考 [Claude Code Read](https://code.claude.com/docs/en/tools-reference#read-tool-behavior)、[SheetJS](https://docs.sheetjs.com/docs/api/parse-options/)、[Mammoth](https://github.com/mwilliamson/mammoth.js#raw-text-extraction) 和 [Open WebUI 格式加载](https://github.com/open-webui/open-webui/blob/0666e59d26a4d056e0bacee41742486badd71cf8/backend/open_webui/retrieval/loaders/main.py)。Open WebUI 的索引适合知识库检索。本机对话以文件路径和 SDK 分段读取为主。

## 实时补充消息

默认 Enter 保持会话 FIFO。点击指定待处理消息的立即插入时，同设置的纯文字通过活跃 SDK 输入流以 `priority: 'now'` 投递。记录稳定的 UUID，依据 SDK 回执确认消息。带附件或不同运行设置的队列项通过独立的优先执行保留原设置，等当前轮清理后启动。等待工作台工具或审批时显示当前等待状态。未确认投递保留记录供用户核对。

参考 [SDK 流式输入](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[Claude Code 队列](https://code.claude.com/docs/en/interactive-mode#when-claude-code-sends-what-you-queued) 以及 [Pi follow-up](https://github.com/badlogic/pi-mono/blob/e5d93ea0ab3747293dca5d12280361d04142eeb2/packages/agent/src/agent-loop.ts#L310)。

## 验证与回退

用隔离数据验证原件下载与大文件分流、真实文档读取、原生 Read 授权边界、立即输入回执与原队列顺序。Linux 安装态通过后备份并切换实际桌面。数据库发生升级时使用升级前的副本回退。
