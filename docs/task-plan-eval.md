# 任务清单与交付质量评测

这是一个可重跑的本地评测。每个样例用同一个本地模型运行两次。一次用 `ed2ba2f` 的任务清单提示和工具说明，一次用工作区当前版本。规划结束后，同一个模型根据候选清单和原始任务生成实际回复或文件。[取舍与边界](decisions/2026-11-28-task-plan-evaluation.md)

## 运行

```sh
node --import tsx scripts/task-plan-eval.mts --list
node --import tsx scripts/task-plan-eval.mts --run \
  --seed 126 --out .local/task-plan-evaluation/my-run
```

`--out` 需要一个新目录及已有父目录。省略时使用系统临时目录。默认模型是 `qwen3.5:9b`，从 `127.0.0.1:11434` 已安装的 Ollama 模型读取。可用 `--model` 指定另一已安装模型，`--tasks html,readonly` 缩小范围，`--repeats 2` 使用相邻的采样种子复跑。HTML 样例需要 Chromium、`pdfinfo` 和 `pdftotext`，可用 `--chromium` 指定二进制位置。其他样例只需要 Ollama。默认入口、帮助和 `--list` 都不发起推理。

| 样例 | 清单和交付检查 |
| --- | --- |
| `html` | 使用真实来源和指定文件名，按要求安排离线文件、两档尺寸和 A4 验收。实际交付物在 375px 和 1440px 下检查横向溢出，打印检查单页 A4 及关键内容。 |
| `calculation` | 使用当前口径和源表，写出在售筛选及分子分母。验收总价 54、数量 3、均价 18 和两条来源路径。 |
| `readonly` | 按两个精确路径只读查因并引用证据。验收实际答复中的原因、编号 `RFX-731` 和来源。 |
| `missing` | 缺逐字稿时追问所需材料，避免编造决议、负责人或提前生成文件。 |
| `revision` | 取消 PDF，逐一核对两条路径，只交付可编辑 Markdown。验收已通过和待核实状态。 |
| `simple` | 直接计算与回复 `22`，无需任务清单或文件。 |

每项的布尔值、模型原始输出、失败原因和模型摘要写入 `report.json`。实际交付写入各试验目录的 `project/`。HTML 的独立验收 PDF 保存为同级的 `verification.pdf`。所有必检项通过时，该项记为通过。可直接核对全文及产物，判断文本规则是否漏识别了合理表述。

这里测量固定规划提示产生的候选清单和它对后续输出的影响。材料正文由评测器提供，评测器独立渲染 HTML 和检查结果。工作台中的文件发现、权限审批、真实工具选择与动态重规划有独立测试。单个模型和样例集的结果只适用于该次配对试验。

## 首轮实测

使用本机 `qwen3.5:9b`、Ollama `0.40.7` 和采样种子 `126`。六个样例各跑一组新旧配对，共 12 次试验。评分器修正了 A4 预览措辞、日志证据和 Markdown 分节的识别，用相同代码重新判定两组保留的回复与产物，浏览器实测值直接沿用。原始记录为 `.local/task-plan-evaluation/verified-126/report.json`，最终判分为同目录的 `report-regraded.json`。

| 样例 | 清单通过（旧 → 新） | 交付通过（旧 → 新） | 实际观察 |
| --- | --- | --- | --- |
| HTML | 未通过 → 未通过 | 未通过 → 未通过 | 旧清单追问是否交两份 HTML。新清单写了三档实际验证，但漏掉离线要求。旧文件在 375px 下溢出，新文件通过两档宽度但打印成 Letter。 |
| 计算 | 未通过 → 未通过 | 未通过 → 未通过 | 两组都答对 54 ÷ 3 = 18，也引用了有效来源。执行响应都把源文件列进交付清单，评测器拒绝写入这些文件。 |
| 只读 | 未通过 → 未通过 | 通过 → 通过 | 两组都给出了正确原因和证据。旧版直接作答，新版选了澄清但回复中已经解释原因，均未出清单。 |
| 材料缺失 | 通过 → 通过 | 通过 → 通过 | 两组都只要求补充逐字稿。 |
| 要求修正 | 未通过 → 通过 | 未通过 → 通过 | 新清单移除了 PDF，Markdown 在各路径下写明正确状态。两组只交付一个 Markdown；旧版附上了原记录没有的日期。 |
| 简单任务 | 通过 → 通过 | 通过 → 通过 | 两组都直接回复 `22`。 |
| **严格通过** | **2/6 → 3/6** | **3/6 → 4/6** | 每项必检条件都通过才计入。 |

HTML 两个实物暴露了不同遗漏。新规则改善了计划对验证场景的覆盖，当前样例的最终交付仍需要逐项实测。两组都拿到预读材料，因此只读任务直接答复也可能合理，表中的清单结果按本次预先选定的多步场景要求计算。

## 一次修正能否改善交付

用同一份已经打印成 Letter 的 `1-html-current/project/handout.html` 做对照。三组均使用本机 `qwen3.5:9b`、种子 128、相同的源材料与首版 HTML，每组只允许修正一次。保持提示模板、采样设置和输出格式相同，仅替换反馈。最后独立渲染两档宽度、打印 PDF，并提取打印正文核对标题、时间和三个工位编号。

| 模型收到的反馈 | 修正后实际打印 | 两档宽度、已知正文和交付文件数 |
| --- | --- | --- |
| 笼统地要求再检查 | 1 页 Letter，612 × 792 pt | 均通过 |
| 指出原 PDF 尺寸与 A4 不符 | 1 页 Letter，612 × 792 pt | 均通过 |
| 使用正式验收器的反馈，给出错误页的实测尺寸，并说明如何用 CSS 设置实体纸张 | 1 页 A4，594.96 × 841.92 pt | 均通过 |

三份产物、PDF、原始模型响应和实测结果保存在 `.local/acceptance-stop/` 下的 `trial-repeat`、`trial-feedback`、`trial-diagnostic` 和同名原始记录中。这是一个既有失败样例上的受控修正实验；没有对六个任务重新做模型成功率估计。

正式识别器对六条原始用户请求中的 HTML 与简单回复两条启用自动检查。简单计算只检查是否有文字回复及是否发布文件；数字是否算对由该样例独立判分。只读查因、材料缺失、要求变更和复杂计算的原始表述沿用 SDK 正常收尾。对普通文档可明确给出文件名和必含原文，文件内容遗漏的生产链路另有真实 SDK 回归用例。

可运行 `node --import tsx --test tests/acceptance-{criteria,stop}.test.ts tests/html-acceptance.test.ts tests/artifacts.test.ts` 检查这些边界。构建桌面后，运行 `node --import tsx scripts/smoke-run-acceptance.mts`，在独立 Electron 窗口验证「错误纸张 → 修正 → A4」、同名版本标识、刷新恢复及两次错误答复后的失败状态。可追加从 Linux 安装件解出的可执行文件路径。桌面冒烟使用真实 SDK 和脚本化回环模型，模型对照通过本地 Ollama 单独执行。

## 通过运行时复跑六类任务

在已安装仓库依赖的基线工作树和候选工作树上，用真实 SDK 和同一 Ollama 实例运行六个任务。候选脚本以实际工作台运行入口读取项目、调用工具并交付，再把 HTML 独立渲染和打印。准备独立的本地 Ollama，使用至少 16,384 token 的上下文并加载 `qwen3.5:9b`。较短的上下文会截断实际工具集或请求内容。

```sh
ATELIER_TASK_PLAN_OLLAMA_PORT=21437 node --import tsx scripts/task-planning-runtime-eval.mts \
  /path/to/baseline-worktree .local/task-planning/my-run
```

每个样例保存清单、模型请求数、实际 token、端到端耗时、交付验收回执与原件。默认连接本机 Ollama。请求来自实际执行过程，简单题的请求计数用于验证没有专用规划请求。运行时间包括执行、工具和工作台交付验收，外部评分在计时结束后执行。每个配对交替执行顺序，时间仍受模型缓存与本机负载影响。


如需通过已认证的回环网关使用指定模型，用 `ATELIER_TASK_PLAN_GATEWAY` 指定地址，`ATELIER_TASK_PLAN_MODEL` 指定模型 ID，`ATELIER_TASK_PLAN_EFFORT` 指定推理档位。网关凭据如有需要通过 `ATELIER_TASK_PLAN_GATEWAY_TOKEN` 传入。发往网关的输入只含合成夹具。评测逐次核对 SDK 请求中的模型和档位，以及流式回执的模型，然后按同一评分器检查两版。

```sh
ATELIER_TASK_PLAN_GATEWAY=http://127.0.0.1:PORT \
ATELIER_TASK_PLAN_MODEL=gpt-6.1-terra ATELIER_TASK_PLAN_EFFORT=high \
  node --import tsx scripts/task-planning-runtime-eval.mts /path/to/baseline-worktree .local/task-planning/terra-result
```
