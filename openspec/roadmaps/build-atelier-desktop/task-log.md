# atelier 桌面版执行日志

以[路线图](roadmap.md)为阶段索引，以[设计](design.md)为范围和决策依据。每项完成记录填写阶段、变更、验收命令、工件或证据路径、已知限制和回退步骤。状态使用待实施、进行中、已验证、阻塞。

## 2026-11-20 · 阶段 0 / 规划与开发规则

- 判定点①选择直接生成。个人已有产品，已有原生 Electron、独立运行时与 Web 入口的实测和权衡，用户已确认 Linux 先交付、其他平台各自验收。无商业化信号。新建 `build-atelier-desktop` 包。
- 本轮基线 `1639970`。历史 release 文档与 `.local` 里的测试记录供追溯。P1–P9 均为待实施，后续从 P1 的安装态样包开始。
- 仓库开发指导位于 `CLAUDE.md` 和 `.claude/skills/atelier-electron/SKILL.md`。验证和评审结果在本节追加。

## Review 处置

本轮 `20261119T165520Z-j95yqR`。strategy 和 plan-eng 两镜均以独立上下文按 Sonnet / medium 只读复核三件套，2026-11-20 收齐两份结构化意见。用户选定仅会话内复核，外部复核记作 `runner=none reason_code=user-waived-external`。

| 来源 | 问题 | 处置与证据 |
|---|---|---|
| strategy | P1 的规则与 Skill 应先实际就位 | 采纳。`CLAUDE.md`、`.claude/skills/atelier-electron/SKILL.md` 和 `.claude/agents/atelier-desktop-reviewer.md` 已落地。Skill 结构校验通过。以新的临时配置目录启动 SDK，仅做本地发现，`supportedCommands()` 和 `supportedAgents()` 找到二者，模型请求数为 0。 |
| strategy | 成功升级后新产生的数据如何回退 | 采纳。[设计决策 4](design.md)规定保全新版副本、列出新增记录和导出，用户确认后旧版打开升级前数据。P7 使用新增成果的场景验收。 |
| plan-eng | 各控制入口要核对调用者身份 | 采纳。[设计决策 3](design.md)定义 renderer、API、私有 sidecar 信道的不同信任依据。[P2](roadmap.md)增加未授权客户端和过期连接验收。 |
| plan-eng | 人工接管时在途动作可能无法确认 | 采纳。[设计决策 3](design.md)补充交接中、执行代次撤销、结果待确认和重建目标的恢复流程，P4 注入迟到动作。 |
| plan-eng | 性能和恢复基线应形成发布门槛 | 采纳。[P1 与 P2](roadmap.md)分别冻结安装件预算和恢复时限，由 P7 在相同条件下复测。 |

## 阶段 0 验证

- Electron Skill 来源选择已查阅社区候选和锁定源码。`mindrally/skills` 的 `electron-development` 在目录查询时约 1,493 次安装，仓库约 310 stars。核对版本 `7682ca77710e0971eab4e0ae5dddfa281aea0ba5` 后，采用以 Electron 官方文档为源的项目专用指导，覆盖原生视图、接管和发行验收。
- `quick_validate.py .claude/skills/atelier-electron` 输出 `Skill is valid!`。默认 Python 缺 `yaml`，最终使用带有 PyYAML 的解释器完成校验。SDK 隔离发现输出 `skill=true, reviewer=true, modelRequests=0`。此证据覆盖配置加载；行为效果在 P1 按真实变更复核。
- 判定点②：两镜五项已逐条处置，近期阶段均回指设计，正式文档未引用历史存档。直接生成路径无备忘对账事项。P1 至 P9 为待实施。


## 2026-11-20 · P1 / 可运行的 Linux 发行样包 · 已验证

- Arch/Omarchy x86_64 包 `dist/linux/atelier-0.2.0-1-x86_64.pkg.tar.zst`，SHA-256 `94fea6119c96535163ad86143aecb7a4cd7fd1c19a8784b1b83e5e9bd76f5d40`。另附便携归档、资源清单、许可证清单和 `SHA256SUMS`。取舍见[发行决策](../../../docs/decisions/2026-11-20-linux-release.md)。本机样包包含 7 项待补上游许可文本，正式对外分发在 P7 核对。
- 使用安装包解出的启动器在独立 PID、网络、挂载、XDG 和显示环境启动。实物工件来自经 typecheck/test/build 验证的代码快照，打包器记录了实际编译输入哈希；后续文件头说明集中维护。已有开发工作区数据不参与测试。
- 五次空库就绪 718、701、693、703、694 ms；离线重开 486 ms。每 150 ms 采样的进程树 RSS 最高 995.4 MiB，最慢退出 112 ms。六次均正常退出，残留进程数为 0。机器与夹具见[验收记录](../../../docs/evidence/desktop-p1-linux-x64/acceptance.json)。当前同机预算：五次启动最大 5 s、退出最大 3 s、RSS 最大 1536 MiB、归档最大 300 MiB、残留进程 0。
- 本机 SDK CLI 经回环模型传输替身完成两次请求和一次工具调用，付费模型请求为 0。真实原生网页和页面输入通过；交付物的 FileVista/PDF.js 用安装包本地 worker 渲染样例 PDF。在测试中，直接导航 PDF 的 Chromium 内置查看器只显示空壳，P1 产品内 PDF 阅读使用已验证的交付物预览。[PDF 预览](../../../docs/evidence/desktop-p1-linux-x64/installed-pdf-preview.png)
- `npm run check`、`npm test`（89 项）、生产前端与桌面构建通过。P1 用户试用和重跑入口见仓库根 README。下一阶段 P2 处理宿主与运行时恢复。
