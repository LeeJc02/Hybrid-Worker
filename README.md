# hybrid-worker-ts

`hybrid-worker-ts` 是 `hybrid-worker` skill harness 的 TypeScript 实现。

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
```

运行报告会包含 `preflight`、`events_file`、`execution_phases`、worker `finding_details`、`resume_commands` 等机器可读字段。`worker_plan.json` 会在运行前做结构校验；`phase.final_tests` 在对应阶段合入 integration 后执行，`final_verification` 只在所有阶段通过后执行。

更多说明：

- `docs/ARCHITECTURE.md`：模块拆分、核心链路和 TypeScript 优化点。
- `docs/PARITY.md`：兼容行为的已覆盖矩阵和后续补齐项。
- `schemas/`：worker plan、worker summary、reviewer decision 和 report 的 JSON Schema 契约。
