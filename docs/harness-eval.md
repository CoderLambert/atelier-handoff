# Cross-task harness evaluation

`scripts/harness-eval.mts` is an optional evaluation of the existing controlled Atelier executor (`project-v1`), native Atelier (`native-v1`), and installed Codex CLI. It is separate from desktop smoke tests and SDK contract tests. It changes no application settings or user database. No inference runs by default.

The separate Claude Code CLI comparison records real-model outcomes, including interrupted-session resume and SDK context compaction. [Test records](claude-code-comparison.md)

## Offline checks

From the repository root with dependencies already installed:

```sh
node --import tsx scripts/harness-eval.mts --help
node --import tsx scripts/harness-eval.mts --list
node --import tsx scripts/harness-eval.mts --dry-run \
  --model YOUR_SHARED_MODEL_ID --effort medium \
  --budget-ms 60000 --max-trials 15
node --import tsx scripts/harness-eval.mts --offline --max-trials 15
node --import tsx --test tests/harness-eval.test.ts
```

`--dry-run` only prints a plan. `--offline` exercises all task fixtures and real local outcome graders through an explicitly synthetic adapter. Its reports say `inference: "none; synthetic adapter"` and have no performance or model-quality evidentiary value. It needs neither Codex nor a gateway. The scoped tests follow the package's `node --import tsx --test` convention and are included by its existing test glob.

## Real inference: explicit user invocation only

Real inference consumes usage. Run this only after the user explicitly authorizes the experiment and its budget. The script requires all of `--run --allow-paid --model --effort --budget-ms --max-trials --gateway`. It never starts a gateway, reads `.env`, loads user credentials, or logs into a provider. The local gateway must already support the same model ID through both Anthropic Messages (Atelier) and OpenAI Responses (Codex), accepting the synthetic `local-placeholder` bearer token. Authenticated endpoints requiring private credentials are intentionally unsupported.

Example for a user-authorized run, replacing the model ID first:

```sh
node --import tsx scripts/harness-eval.mts --run --allow-paid \
  --model YOUR_SHARED_MODEL_ID --effort medium \
  --gateway http://127.0.0.1:3001 \
  --budget-ms 60000 --max-trials 15 --repeats 1 \
  --seed holdout-2026-11 --out /tmp/atelier-eval-new-directory
```

The output directory must not already exist. Omitting `--out` creates a new temporary report directory and prints its path. `report.json` is updated after each trial. Trial projects, application databases, SDK session state, Codex state, and HOME/XDG directories are fresh and removed afterward. Keep the JSON report for review. Fixture hashes, prompts, the seed, task version, Node version, and installed Codex version identify the experiment. There are no automatic retries; `--repeats` is an explicit additional trial count. Adapter order rotates by task and repetition.

`--budget-ms` is a wall-time allowance **per trial**, with up to five extra seconds for startup/stop/cleanup. `--max-trials` bounds the total number of trials, not model requests inside an agent run. Neither interface provides a shared hard dollar or token limit through the existing application API. SDK estimates can be absent or inaccurate for gateway model aliases. If a hard spending ceiling is required, enforce it at the local gateway/account before invoking the experiment. Cancellation does not undo usage already incurred or a request already sent. Do not interpret the wall budget as a monetary guarantee.

Use `--tasks writing,fixture-research` or `--drivers atelier-controlled,atelier-native` for a smaller experiment, and lower `--max-trials` accordingly. Repeating with a new seed changes synthetic references and research values. Use an untouched seed for evaluation after tuning. Do not tune production prompts against these task answers and then claim a held-out result.

## Tasks and outcome checks

| Task               | What is graded                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writing`          | A concise notice with the supplied facts, exact title, three bullets, no extra prose, and no file changes.                                                                          |
| `fixture-research` | Current rather than archived policy, computed active capacity, supporting relative source paths, and untouched sources.                                                             |
| `edit-test-repeat` | Initial test observation, a repeated identical test after observed code state changes, protected original tests, and independent numeric assertions against the resulting function. |
| `unknown-write`    | A missing approval prerequisite results in a clarification and no file changes.                                                                                                     |
| `cancel`           | The command starts, cancellation is requested after its marker appears, the run stops, and neither the command's delayed write nor the requested final write appears.               |

The fixtures are synthetic, seeded, dependency-free, and separate from desktop/SDK contract fixtures. Each task/repetition has identical initial file bytes, prompt, requested model/effort, and wall allowance across adapters. Every task has a fresh session. The edit task intentionally repeats the test within one session after changing code, rather than reusing history across unrelated trials. Graders use observable artifacts and assertions; they are narrow checks of these outcomes, not a model judge or a complete assessment of writing quality. The cancellation task only grades a run that actually reaches the command-start marker. An early timeout is a failed trial.

## Metrics and limits

Each result has the grade and individual checks, terminal status/error, answer, tool observations, final file hashes, and metrics:

- `firstTextMs` is the first observable assistant text. Atelier polls every 150 ms; Codex emits completed/updated JSON items rather than raw token timestamps. This is an observation upper bound, not provider TTFT.
- `firstUsefulMs` is the first observed response satisfying the task's content checks. Edit and cancellation outcomes use a completion upper bound; edit includes independent verification. A null value means no useful result was observed. Always assess it together with the final grade, since later actions can invalidate an earlier useful answer.
- `durationMs` covers the submitted task through stop/cleanup, with local independent verification for edits. Startup overhead is bounded by the worker deadline; worker failures report whole-worker elapsed time. Offline durations are synthetic.
- `toolCalls`, `toolFailures`, and exact repeated call counts preserve expected initial test failures. Repeats after observed file state changes are counted separately. An unchanged repeat is not automatically an error. Atelier samples edit state at tool dispatch; Codex samples local state when JSON items arrive, so very fast operations can make its repeat classification approximate.
- `observableQuietIntervals` counts gaps of at least ten seconds in observable progress; `longestObservableQuietMs` includes initial and final quiet periods. They are observability signals, not proof of a semantic stall. There is no automatic intervention based on these counts.
- `tokens` is reported only where the adapter exposes it. `sdkCostEstimateUsd` is the Atelier SDK estimate when available; Codex cost and actual billed cost remain null. Missing usage is not zero cost.

The model/effort settings are the same **requested** values. Atelier records the run configuration and SDK-observed model. Codex JSONL does not establish its applied model/effort, so those observations remain null. Verify local gateway alias routing, effort support/downgrades, and billing independently before drawing a controlled comparison. System prompts and tool/permission policies intentionally differ between harnesses. Unsupported models/protocols, unavailable controlled commands (`bwrap`), missing CLI flags, and executor mismatches are reported as failures rather than silently substituted.

The harness uses temporary data/configuration isolation and a scrubbed worker environment. Native Atelier retains the feature's host OS permissions; this script is **not an OS filesystem or network sandbox**. Prompts confine operations to synthetic fixtures, installed user skills/config are absent, gateway targets are restricted to loopback, and search is disabled for Codex. Use a disposable account/container if an enforced host-filesystem boundary is needed. The harness does not open the real desktop, use user projects, or access stored provider accounts. Its results do not replace actual desktop, SDK contract, cancellation lifecycle, or installation acceptance evidence.

Implementation references: the existing [native execution decision](decisions/2026-11-22-native-harness.md), `createApp` and run/permission APIs in `server/app.ts`, the installed `codex-cli 0.167.2` `--help` and `exec --help` checked during development, and the upstream [provider configuration source](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs) and [Responses proxy example](https://github.com/openai/codex/blob/main/codex-rs/responses-api-proxy/README.md). The live preflight checks installed CLI flags again. No live inference was used to develop or validate this harness.
