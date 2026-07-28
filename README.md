# hybrid-worker-ts

`hybrid-worker-ts` 是 `hybrid-worker` skill harness 的 TypeScript 实现。

v2 在兼容原有 `worker_plan.json` 的基础上新增声明式动态 DAG 与大型任务专属的三级执行面：Root Codex 只负责计划和最终事务合并，3 个 Codex manager 各自在唯一 worktree 中调用本 harness，所有 Claude stages 共享一个跨进程资源 broker。

目标：

- 保持 Python 版 CLI、worker 契约、门禁、事务性合并和 `report.json` 结构的兼容基线。
- 利用 TypeScript 的静态类型、模块边界、可测试纯函数和更明确的数据模型降低 harness 维护成本。
- 在兼容基线之上增强 planner 输入、阶段调度、预检、诊断、错误类型和报告质量，让正式调用前尽量失败前置。

常用命令：

```bash
npm install
npm run build
npm test
npm run check
npm run verify
node dist/src/cli.js --doctor --claude-bin node
npm audit --json
```

新增工程化入口：

```bash
# 只做预检，不启动 worker，适合在正式调用前省成本
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md --plan-file worker_plan.json --dry-run

# 直接消费 planner 产物；多 phase 会按顺序在 integration 分支上推进
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md --plan-file worker_plan.json --merge

# 自动化调用：只输出 JSON，避免解析人类进度文本
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md --plan-file worker_plan.json --json

# 正式跑前启用严格预检，把 overlap、空测试、过宽 allowed path 等 warning 升级为 error
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md --plan-file worker_plan.json --dry-run --preflight-strict

# 不把生成物 ignore 规则提交到业务仓库，只写本地 .git/info/exclude
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md --plan-file worker_plan.json --repo-ignore-policy local

# v2：从 seed 启动只读 scouts + deep planner，生成/校验 compiled DAG 并判定规模
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md \
  --workflow-seed workflow_seed.json \
  --workflow-plan-only

# 也可显式传入已有 planner 产物，跳过 planner 调用但保留全部确定性校验
node dist/src/cli.js --repo /path/to/repo --task-file TASK.md \
  --workflow-seed workflow_seed.json --compiled-workflow compiled_workflow.json --workflow-plan-only

# v2 manager：只执行自己的 compiled subgraph；plan-only 报告已生成三条完整 manager 命令
node dist/src/cli.js --repo /manager/worktree --task-file TASK.md \
  --compiled-workflow /parent/managers/manager-01/compiled_workflow.json \
  --manager-id manager-01 --parent-run-dir /parent --broker-dir /parent/broker --merge

# 三个 manager 全部成功后，由 Root Codex 执行唯一的最终事务合并
node dist/src/cli.js --finalize-parent-run /parent/run
```

v2 报告还包含 `execution_mode`、规模判定、全局 DAG、manager 子图、模型路由、验证票数、broker 并发/调用/成本/等待、pilot、批次、熔断、blocked 节点和恢复命令。少于 12 个 required 写节点永不进入分层模式；只有恰好 3 个无写路径重叠、无跨域实现依赖且各有至少 3 个 implementer 的 workstream 才会生成 3 个 manager。

`workflow_seed.json` 是授权边界：测试和 setup 只能引用 seed 的 `command_catalog`，每条命令使用 `argv` 数组，可选安全的 repo-relative `cwd`。`compiled_workflow.json` 不能引入或修改命令，也不能降低 seed 的风险下限。运行时不执行模型生成的 JavaScript 或裸 shell。

更多说明：

- `docs/ARCHITECTURE.md`：模块拆分、核心链路和 TypeScript 优化点。
- `docs/PARITY.md`：兼容行为的已覆盖矩阵和后续补齐项。
- `schemas/`：worker plan、worker summary、reviewer decision 和 report 的 JSON Schema 契约。
