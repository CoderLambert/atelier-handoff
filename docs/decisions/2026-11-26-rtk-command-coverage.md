# RTK Bash 命令覆盖

此记录更新[内置 RTK Hook](2026-11-26-builtin-rtk-hook.md)的命令匹配范围。对应[桌面路线图](../../openspec/roadmaps/build-atelier-desktop/roadmap.md)的 P5。用户在本机信任模式下启用项目 RTK 后，可继续使用日常的文件、搜索、构建、测试、包管理、Git 和基础设施命令。执行轨迹沿用原始命令和实际命令两个字段。

## 问题与依据

- 当前实现精确匹配四条 Git 命令。实机的 `git fetch --all && git branch -a -vv && git remote` 和提交差距查询均走了原始 Bash。逐段检测应能压缩其中适合的输出，同时保留远程默认分支和左右两侧的完整提交证据。
- 锁定的 RTK OSS 1.2.1 提供 `rtk hook check -- <command>`。隔离运行随包二进制已验证它返回 `rg`、`ls`、`npm run build`、`npm run check`、`cargo test` 等真实映射，也识别复合 Git 命令。`npm test` 是作者推荐用法，同版二进制只自动匹配 `npm run test` 形式。作者强调优先保留显式请求的细节和数据格式。[作者范围与正确性约定](https://github.com/rtk-ai/rtk/blob/v1.2.1/CONTRIBUTING.md#what-belongs-in-rtk) · [覆盖指南](https://github.com/rtk-ai/rtk/blob/v1.2.1/docs/guide/resources/what-rtk-covers.md) · [命令注册表](https://github.com/rtk-ai/rtk/blob/v1.2.1/src/discover/rules.rs)
- RTK 的 `git log` 过滤会在无界 `--oneline` 查询中注入默认条数和 `--no-merges`。`git branch` 的列表摘要可省略远程 HEAD 引用。实际截图涉及合并提交和远程默认分支，保留这两类查询的原始输出。[Git 过滤实现](https://github.com/rtk-ai/rtk/blob/v1.2.1/src/cmds/git/git_cmd.rs)
- Pi / Oh My Pi 的上游插件将 argv 交给单一 RTK 注册表，超时或无映射时执行原命令。Claude 上游 Hook 还会解释 RTK 的权限结果。atelier 已用锁定 SDK 验证 `classic.PreToolUse` 可以在改写前检查原命令，并由 SDK 再检查实际命令。隔离探针还核对了运行时与 CLI 插件看到同一个 `tool_use_id`。[Pi 集成](https://github.com/rtk-ai/rtk/blob/v1.2.1/hooks/pi/rtk.ts) · [Claude 集成](https://github.com/rtk-ai/rtk/blob/v1.2.1/hooks/claude/rtk-rewrite.sh) · [atelier 权限证据](2026-11-26-builtin-rtk-hook.md#2026-11-26--采用-cli-插件的原生权限预检)

## 取舍

沿用四条允许表容易保留现有边界，但会持续漏掉作者维护的命令。安装上游 Hook 会把工作站配置和另一套权限裁决带进产品。采用随包 RTK 的只读 `hook check` 作为改写建议来源。版本、资源校验、统计目录与现有开关沿用当前集成。

运行时用私有配置和位于项目目录外的工作目录调用匹配器，以 argv 传命令，限制时间和输出大小。数据目录可能放在项目内，故候选匹配使用 Linux 根目录作为 cwd，避免查到项目祖先的 Claude 设置。只修改能对应到原 Bash 调用的顶层简单命令段，保留原有连接符、引号和其余命令。复合命令中保留 `git rev-list`、`git remote`、详细远程分支和比较日志，让 `fetch`、普通状态等适用段压缩。显式请求的机器可读格式、`cat -n` 行号、管道、重定向以及无法可靠对应的脚本语法按原始 Bash 执行。`npm test` 使用同一 npm 测试脚本的 `npm run test` 入口，显式 npm 脚本继续由 npm 执行。

宿主在工作区及设置检查后，以工具 ID 向本轮私有插件目录写入候选。插件通过 SDK 的 `$.fs.read` 读取固定目录中的候选，确认原始输入对应后走 SDK 原命令预检。SDK 继续裁决实际命令，回执匹配后才保存 RTK 轨迹。受控模式和子代理沿用既有行为。改写建议使用独立环境。实际工具子进程沿用调用方的 XDG 环境。对非 Git 自动调用，随包启动器使用内部执行参数来保留 XDG；正常的 `rtk config`、`rtk -v config`、`rtk telemetry` 等管理入口默认继续隔离。RTK 专属变量继续隔离统计及停用自定义 TOML、输出归档和遥测。[Claude 插件文件接口](https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network)

## 验证与回退

1. 使用固定摘要的 OSS 资源验证非 Git 代表命令与两条截图输入。对照复合命令分支、未命中、机器可读输出、`rtk bypass`、脚本参数与匹配失败行为。
2. 使用锁定 SDK 与回环模型验证设置变化、原命令和实际命令的批准/拒绝、后台与取消、非零退出和回执只确认一次。用 Git 分叉夹具对照左右提交与远程 HEAD。
3. 运行 `npm run check`、`npm test`、`npm run build` 及桌面构建，在隔离 Linux Electron 中确认中英文设置和非 Git 实际命令。用同一版本的运行时和 RTK 启动器切换桌面。

项目可从 Hooks 设为停用，单条指令可显式使用 `rtk bypass`。退回上个桌面版本需同时恢复运行时与 RTK 启动器。设置和轨迹沿用原存储格式。
