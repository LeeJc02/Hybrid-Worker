# 兼容行为矩阵

本矩阵记录 TypeScript 版当前已经验证的兼容点，以及下一步需要补齐的行为。

## 已实现并验证

- CLI 默认值：模型、权限模式、diff/file 限制、timeout。
- `--doctor` JSON 输出：Claude/Python/Git 状态、默认策略、共享缓存路径。
- 共享缓存环境：`PIP_CACHE_DIR`、`npm_config_cache`、`UV_CACHE_DIR`。
- `CPW_*` worker 环境：summary、decision、allowed paths、worker tests。
- fake executor：支持 `--executor fake-command` 和 `--fake-implementer NAME:COMMAND`。
- 独立 worktree：每个 worker 创建独立分支和工作树。
- worker summary/decision schema 校验。
- `SELF_EVALUATION: PASS` marker 校验。
- worker tests 和 final tests。
- allowed path 门禁。
- 生成物清理：未跟踪 `node_modules/`、`dist/` 等不进入 diff/merge。
- 事务性 integration merge 和 base repo fast-forward。
- `--accepted-branch` 复用已接受 worker 分支。
- `--codex-fallback-command` 可修复 worker closeout，且 TS 版会在 fallback 后重新校验 summary/decision JSON。
- tracked generated artifact 被修改时拒绝合并。
- `--merge-conflict-command` 冲突 resolver 路径。
- worker 写 base repo 而非 worktree 时拒绝。
- npm auto setup 对 `npm --prefix`、`npm -C`、root `npm` 的解析，以及 `npm --prefix` 端到端安装/测试。
- final tests 失败时 integration 不 fast-forward，base 保持在 merge 前 HEAD。
- 模型 override 会写入 report。
- missing self-evaluation、forbid path、missing ticket、invalid allowed path 等错误路径。
- unrecoverable bad summary schema 拒绝。
- worker command failure 会写 compact failure JSON。
- `worker_plan.json` 入口会校验 planner 产物，并生成真实 execution phases。
- 多阶段计划按 phase 顺序执行；每个 phase 合入 integration 后运行 `phase.final_tests`，后续 phase 从 integration 分支创建 worktree。
- `--dry-run` preflight 能在调用 worker 前发现配置错误并输出 report。
- `--preflight-strict` 能把 overlap、空测试、缺失/过宽 allowed path 等 warning 升级为 error。
- `--json` 能输出机器可读 JSON，`--quiet` 能抑制人类进度文本。
- `--repo-ignore-policy local` 能只写 `.git/info/exclude`，避免自动提交 `.gitignore`。
- `events.ndjson` 记录 run/preflight/worker/merge 生命周期事件。
- `report.json` 输出 `execution_phases` 和 `resume_commands`，支持失败后复用已接受 worker 分支。
- worker report 增加 `finding_details`，保留 Python 兼容的 `findings` 字符串数组。
- CLI 数字参数校验为 positive integer，避免无效 runtime 配置。
- 生成物清理批量化为 `git clean -fdX`，减少清理阶段进程开销。
- `schemas/` 提供 worker plan、summary、decision、report JSON Schema。
- `npm run verify` 提供工程级验收脚本：build、test、audit、doctor、pack dry-run；发布包通过 `files` 白名单排除源码测试和 Python 参考副本。
- `report.json` 输出 worker、merge、timing、usage、环境策略、生成物策略。
- v2 声明式 DAG：seed 命令授权、结构化引用、受限 `when`/`for_each`、环检测、风险下限和模型路由。
- v2 规模判定：少于 12 个 required 写节点不分层；路径重叠、跨域依赖、workstream 数量/规模不足时自动降级。
- v2 hierarchical plan-only：3 个唯一 manager branch/worktree/run dir/subplan，共享 parent-run manifest 与 broker 命令。
- v2 broker：跨进程锁、8 读/4 写默认槽位、64 次调用、10 美元可观测成本预算、等待统计和过期租约回收。
- v2 独立验证：implementer 不写 decision；medium/high/critical verifier 路由和 critical 2/3 quorum；失败最多一次 deep repair 并完整重跑。
- v2 pilot/批次/熔断：单 pilot、每批最多 4 个、低于 2/3 或无测试时 blocked。
- v2 parent finalize：manager 失败时基础分支不变，成功分支保留；恢复后按固定 manager ID 事务合并并最终验证。
- Vitest 同时覆盖 v1 回归与 v2 fake-agent 分层、repair、broker、budget、circuit、resume/finalize 场景。

验证命令：

```bash
npm run check
npm audit --json
npm run build && node dist/src/cli.js --doctor --claude-bin node
```

## 待补齐或需 live 环境验证

- Claude live executor 的真实 CLI 调用样本回归。当前已覆盖 Claude JSON parser 和 fake executor 的完整 harness 链路；live smoke test 仍建议只在显式接受模型成本时运行。
- seed-only plan-only 已内建只读 scouts 与 deep planner；自动化测试使用 fake planner/scout，live planner/scout smoke test 仍只应在显式接受模型费用时运行。
- `npm -C` 和 root `npm` 当前有解析测试；端到端测试覆盖 `npm --prefix`，因为它是原 Python 测试中的实际路径。
- `choosePython()` 的 mock 单元测试可进一步贴近 Python 测试形状；当前 `doctor` 和端到端测试覆盖真实环境路径。

## 后续优化方向

- 增加可选 live Claude smoke test，默认跳过，只有设置环境变量时运行。
- 为 `report.json` 增加更细的 phase/timing 聚合，帮助后续分析最慢 worker、最贵 worker 和高频 gate failure。
