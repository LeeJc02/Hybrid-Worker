# hybrid-worker-ts 架构说明

本项目是 Python `hybrid-worker` harness 的 TypeScript 重构。第一阶段目标不是改变 worker 协议，而是把原来集中在单个脚本里的链路拆成可测试模块，并保持 CLI、门禁和报告结构尽量兼容。

## 核心链路

1. `src/cli.ts` 解析 CLI 参数，准备 run/worktree 目录，读取 task 和 ticket，并把输入组织成 execution phases。
2. `src/git.ts` 确保目标目录是干净 git repo，并创建 worker worktree。
3. `src/env.ts` 注入共享缓存与 `CPW_*` worker 契约环境变量。
4. `src/prompt.ts` 生成 worker prompt，并把 task/ticket 写入 worker worktree 的 `worker_artifacts/prompt/`。
5. `src/worker.ts` 调用 Claude 或 fake executor，收集 `worker_summary.json`、`reviewer_decision.json`、diff、测试日志，并执行硬门禁。
6. `src/merge.ts` 创建 integration worktree，按 worker 名称稳定合并。多阶段计划会在每个 phase 后先合入 integration，再运行 phase-level tests，让后续 phase 基于前序变更继续工作；最终通过后才 fast-forward 回 base repo。
7. `src/report.ts` 输出与 Python 版接近的 `report.json`。

## 工程化增强

- `src/plan.ts` 支持读取 `worker_plan.json`，并在运行前校验 phases、worker、ticket、allowed paths、worker tests 等结构，避免坏计划启动 worker。
- `worker_plan.json` 的 phase 顺序现在有真实执行语义：`parallel:false` 强制串行，同一 phase 内仍可受 `--parallelism` 控制；`phase.final_tests` 在该 phase 合入 integration 后立即执行。
- `--dry-run` 会执行 preflight 并生成 report，但不创建 worker worktree、不调用 Claude、不跑测试，适合正式运行前节省成本。
- preflight 会提前发现 missing ticket、invalid allowed path、unknown worker test、重复 worker/accepted branch、allowed path overlap、过宽/缺失 allowed path、缺失 worker tests；`--preflight-strict` 会把 warning 升级为 error。
- `src/events.ts` 输出 `events.ndjson`，记录 run/preflight/worker/merge 生命周期事件，便于 UI 或长任务监控消费。
- `--json` 只向 stdout 输出机器可读 JSON；`--quiet` 抑制人类进度文本，适合 CI 和外部调度器。
- `--repo-ignore-policy tracked|local` 控制生成物忽略规则落点。默认 `tracked` 保持 Python 版兼容，会维护仓库 `.gitignore`；`local` 只写 `.git/info/exclude`，避免对业务仓库产生额外提交。
- `src/findings.ts` 为 gate failure 增加结构化 `finding_details`，保留旧 `findings: string[]` 兼容字段。
- CLI 数字参数现在要求 positive integer，避免 `NaN`、`0`、负数进入执行链路。
- 生成物清理使用一次性 `git clean -fdX` 处理忽略文件，减少大仓库中逐文件 git 子进程调用；tracked generated artifact 仍由 diff gate 拒绝。
- `src/platform.ts` 集中平台命令探测和 shell quote，避免 CLI/report 各自实现造成分歧。
- `schemas/` 固化 planner 输入、worker closeout 和 report 的 JSON Schema，方便 CI、UI 和外部工具做契约校验。
- `report.json` 增加 `execution_phases` 和 `resume_commands`。前者记录真实阶段调度，后者给出可复用的 `--accepted-branch` 参数，失败重跑时能跳过已接受 worker。
- `npm run verify` 串联 build、test、audit、doctor 和 `npm pack --dry-run`，作为发布前工程验收入口。
- `package.json` 使用 `files` 白名单，发布包只包含 `dist/src/`、`schemas/`、`docs/` 和 README，避免把测试、源码和 Python 参考副本误打进运行时包。

## TypeScript 重构收益

- 显式数据模型：`WorkerResult`、`StageResult`、`MergeResult`、`EnvironmentPolicy`、`CliOptions` 都在 `src/types.ts` 中集中定义。
- 结构化失败模型：`GateFinding` 用 `code/severity/message/path/stage` 表达失败原因，后续可以稳定统计、重试和生成建议。
- 模块边界清晰：git、环境、schema、usage、worker、merge、report 分离，便于逐项对照 Python 行为。
- 严格编译：开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`，减少缺字段和可选值误用。
- 可测试纯函数：路径门禁、schema normalize、Claude usage 解析、CLI defaults 不依赖真实 Claude。
- 异步并发控制：worker 并发由 `mapLimited` 控制，行为对应 Python `ThreadPoolExecutor`，但更适合 Node 进程 I/O。
- 阶段化调度：有依赖的 worker 不再被扁平并发执行，减少冲突、返工和无效 Claude 调用。
- 安全依赖基线：测试框架升级到 Vitest 4.1.9，`npm ci` 和 `npm audit` 当前均为 0 vulnerabilities。

## 保持不变的协议

- 默认模型：`deepseek-v4-flash`。
- 默认 workflow：`single_call_worker_self_review`。
- worker 仍需输出 `SELF_EVALUATION: PASS`。
- worker 仍需写入 summary 和 decision 两个 JSON。
- harness 继续负责路径、生成物、diff、测试、base repo 污染和 merge gate。
- 默认不启用 fallback 或 merge resolver，只有显式参数触发。

## 当前命令

```bash
npm ci
npm run check
node dist/src/cli.js --doctor --claude-bin node
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md --plan-file worker_plan.json --dry-run
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md --plan-file worker_plan.json --dry-run --preflight-strict
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md --plan-file worker_plan.json --repo-ignore-policy local
npm run verify
```
