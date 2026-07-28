---
name: hybrid-worker
description: "Use only when the user explicitly wants hybrid mode: Codex should reduce its own token usage by planning/splitting work, launching multiple parallel Claude Code workers in isolated git worktrees, then applying deterministic merge/test gates. Best for implementation tasks that can be split into independently testable worker tickets with low file overlap."
---

# Hybrid Worker

## Overview

Use this skill for explicit hybrid execution: Codex plans and integrates; Claude workers do implementation, focused tests, self-review, fixes, and status artifacts in one run each. Do not use it for ordinary single-agent coding unless the user asks for Claude workers, hybrid mode, parallel workers, or Codex-token reduction.

Primary harness (TypeScript implementation):

```bash
node ~/.codex/skills/hybrid-worker/dist/src/cli.js --doctor
```

Default model is `deepseek-v4-flash`. The harness is implemented in TypeScript and still resolves the worker/test Python command to `conda run -n base python`, then `python3`, then `python`.

## v2 Dynamic And Hierarchical Mode

Hierarchical mode is only for large tasks. Root Codex must not create manager agents merely because hybrid mode was requested. First run the v2 plan-only command and inspect `execution_mode`:

```bash
node ~/.codex/skills/hybrid-worker/dist/src/cli.js \
  --repo /path/to/repo \
  --task-file TASK.md \
  --workflow-seed workflow_seed.json \
  --workflow-plan-only
```

With seed only, the harness runs the required read-only cartographer/test-mapper/risk-scout stages, then one deep planner and validates its output. Pass `--compiled-workflow` as well only when reusing an already generated planner artifact; the harness still enforces seed command authority and risk floors.

- `single_layer`: fewer than 12 required write nodes. Root Codex runs one hybrid-worker process.
- `single_layer_dynamic_dag`: at least 12 write nodes, but the graph cannot safely form exactly 3 independent domains. Root Codex still runs one process.
- `hierarchical`: and only this value authorizes Root Codex to create exactly 3 Codex managers using the generated commands in `report.json`.

Hierarchical eligibility is deterministic: at least 12 required write nodes; exactly 3 workstreams; at least 3 implementers in every workstream; no cross-workstream write-path overlap; no cross-domain implementation dependency; complete final verification; and any shared contract is frozen with one owner. If a shared contract cannot be frozen first, use single-layer mode.

Each manager must:

- use only its generated branch, worktree, run directory, and compiled subplan;
- read the shared parent prework but never repeat whole-repo prework;
- call hybrid-worker itself instead of creating more Codex subagents;
- pass the shared `--broker-dir` and generated broker limits unchanged;
- return only compact status, branch, verification, risk, usage, and recovery data to Root Codex.

All managers may finish their current batch after one manager fails, but Root Codex must not merge anything. After all three succeed, Root Codex runs:

```bash
node ~/.codex/skills/hybrid-worker/dist/src/cli.js --finalize-parent-run /path/to/parent-run
```

This checks the common base commit, merges manager branches in stable manager-ID order into a temporary integration branch, runs final verification, and fast-forwards the original branch only on total success. Successful manager branches and checkpoints remain reusable after failure.

The v2 seed is the command authority. `compiled_workflow.json` may reference only seed-defined `command_catalog` entries (`argv` plus optional safe repo-relative `cwd`); it must never contain model-generated JavaScript or new bare shell commands. Implementers do not self-sign review in v2. The harness owns deterministic gates and independent verifier quorum, with at most one deep repair followed by a full verification rerun.

## Default Workflow

1. Codex planner reads the task/spec lightly and writes `worker_plan.json`, shared `CLAUDE.md`, and `tickets/*.md`.
2. Planner creates no default `phase0` and no default `phase2`. Use only implementation phases. If workers are independent, put them in one parallel phase; if business dependencies exist, create ordered implementation phases.
3. Planner handles only shared, lightweight prerequisites needed by multiple workers: `.gitignore`, shared contracts, common setup commands, path ownership, and cache policy. It does not write business implementation.
4. Each ticket gives one worker a complete task contract: target behavior, expected directory/file shape, allowed paths, forbidden paths, unique owner files, worker-local setup, focused tests, local documentation duties, self-review checklist, and done criteria.
5. Claude workers run in isolated git worktrees. Each worker reads repo-local `CLAUDE.md` and its own ticket, implements, tests, self-reviews, fixes, cleans artifacts, and writes strict JSON status files.
6. Codex/harness performs deterministic gates only by default: status JSON, schema, marker, tests, path scope, generated artifacts, diff size, base repo cleanliness, merge, and final verification.
7. Do not run a default standalone docs/audit worker for implementation documentation. Each implementation worker documents its own behavior, commands, API/screen/data changes, setup notes, risks, and limitations in files it owns. Codex may later concatenate, de-duplicate, and lightly polish those local docs; it should not reread the whole codebase to rewrite documentation from scratch.
8. Trigger rescue only after worker rejection, merge conflict, final test failure, evaluator failure, or documentation assembly failure, and only through explicit fallback/resolver commands.

## Compact Planner Template

Use this planner contract when generating prompts or report plans:

```text
You are Codex planner. Split work only; do not implement.

Write:
- worker_plan.json
- CLAUDE.md
- tickets/<worker>.md

Rules:
- No default phase0. No default phase2.
- Prefer 2-4 workers, max 5 unless the task is large.
- Use one parallel implementation phase when worker scopes have low overlap.
- Use ordered implementation phases only when business dependencies require it.
- Put shared worker rules in CLAUDE.md.
- Put worker-specific environment setup in that worker's ticket.
- Put shared setup in worker_plan.json only when multiple workers need it.
- Every implementation worker needs allowed_paths, focused worker_tests, owner files, non-goals, documentation responsibilities, and done criteria. Non-code/scoping workers may have empty worker_tests only when final_verification covers them.
- Assign documentation to the worker that owns the related code or behavior. Avoid a parallel docs-only worker that must guess final implementation details from stale contracts.
- If final README/API/audit docs are required, have workers write owned fragments or owned sections first, then let Codex or a later integration step only assemble and polish them.
- Avoid shared files in parallel workers. If unavoidable, assign exactly one owner.
- If no safe split exists, use one worker and record why.
```

Minimum `worker_plan.json` shape:

```json
{
  "run_id": "run-id",
  "model": "deepseek-v4-flash",
  "shared_setup": ["optional commands needed by multiple workers"],
  "phases": [
    {
      "name": "implementation",
      "parallel": true,
      "workers": [
        {
          "name": "worker-name",
          "ticket": "prompts/report/tickets/worker-name.md",
          "allowed_paths": ["repo-relative/path"],
          "worker_tests": ["command or empty only for non-code/scoping workers"]
        }
      ],
      "final_tests": ["optional phase-level commands"]
    }
  ],
  "final_verification": ["full final commands"],
  "split_rationale": ["short reasons"]
}
```

## Shared CLAUDE.md Contract

`CLAUDE.md` is global worker law, not a task ticket. It must cover these hard rules clearly:

- Work only inside `$CPW_WORKTREE`; verify `pwd` and `git rev-parse --show-toplevel` before editing.
- Never write to `$CPW_BASE_REPO`, benchmark roots, old `runs/`, `reports/`, `prompts/`, skill files, harness files, or paths outside `$CPW_WORKTREE`.
- Treat `$CPW_ALLOWED_PATHS` and `$CPW_WORKER_TESTS` as the machine-readable source of truth.
- Do not modify files outside allowed paths. If required work is out of scope, stop and report failure.
- Do not commit; the harness owns commits and merges.
- Do not leave generated or local-only artifacts in the diff: `__pycache__/`, `*.pyc`, `*.pyo`, `node_modules/`, `.venv/`, `venv/`, `dist/`, `build/`, `coverage/`, logs, caches, local env files, editor files, worker artifacts, or package-manager debug logs.
- Implement, run focused tests once, apply one focused repair pass if needed, rerun the same tests once, inspect `git status --short`, `git diff --stat`, and `git diff --name-only`, then clean artifacts and close out. Do not run open-ended review loops.
- Document only what this worker owns: changed APIs, screens, data files, setup/test commands, validation rules, risks, and limitations. Keep docs consistent with the code just written; do not invent behavior from the global spec if the implementation differs.
- Prefer worker-owned docs/fragments such as `docs/backend.md`, `docs/frontend.md`, `docs/<worker>.audit.md`, or explicitly owned README/API sections. Codex will assemble and polish these; do not rely on Codex to rediscover implementation details later.
- Write strict JSON to `$CPW_SUMMARY_FILE` and `$CPW_DECISION_FILE`; validate both with `$PYTHON -m json.tool`.
- Output only `SELF_EVALUATION: PASS` after implementation, tests, cleanup, scope check, JSON validation, and internal review all pass. Otherwise output `SELF_EVALUATION: FAIL` with one short reason.

Required summary JSON:

```json
{
  "worker": "string",
  "summary": "string",
  "changed_files": ["path"],
  "docs_written": ["optional path"],
  "tests_run": ["command"],
  "tests_passed": true,
  "risks": [],
  "needs_codex_attention": false,
  "token_usage_note": "optional note; harness usage is authoritative when observed"
}
```

Required decision JSON:

```json
{
  "worker": "string",
  "decision": "PASS",
  "issues_found": [],
  "fixes_applied": [],
  "tests_run": ["command"],
  "tests_passed": true,
  "merge_risk": "low"
}
```

## Worker Ticket Contract

Each `tickets/<worker>.md` should be complete enough for the worker to act without Codex chat. Do not make tickets tiny. Do not duplicate the global `CLAUDE.md` rules except where the task needs emphasis.

Recommended sections:

```markdown
# Worker: name

## Goal
Concrete behavior to implement.

## Business Scope
Spec sections, user flows, APIs, screens, data rules, or docs this worker owns.

## Expected Structure
Directories/files this worker should create or modify.

## Documentation Duties
Worker-owned docs or sections this worker must update, such as API notes for backend changes, screen/workflow notes for frontend changes, data/setup notes, test commands, risks, and limitations. These docs must reflect the worker's actual implementation.

## Allowed Paths
- path/**

## Forbidden Paths
- paths owned by other workers
- benchmark/runs/reports/prompts/skill/harness paths
- generated artifacts

## Shared Contracts To Read
- CLAUDE.md
- spec or contract files

## Environment
Worker-local setup commands only, such as `$PYTHON -m pip install -r backend/requirements.txt` or `npm --prefix frontend install`.

## Tests
Focused worker test commands. Avoid full-suite repetition unless this worker owns integration.

## Self-Review Checklist
Diff is in scope, tests pass, generated artifacts removed, JSON files valid.

## Done Criteria
Observable acceptance criteria and PASS conditions.
```

## Harness Rules

- The harness ensures the target is a git repo, injects a broad `.gitignore`/exclude policy, creates isolated worktrees, runs worker commands, collects compact artifacts, and merges accepted workers transactionally.
- Hard gates remain mandatory even when `CLAUDE.md` is strict: exit code, `SELF_EVALUATION: PASS`, JSON schema, `decision: PASS`, worker tests when configured, allowed paths, generated artifacts, diff limits, base repo dirtiness, merge, and final tests.
- Use `--allowed-path NAME:PATH_PREFIX` for every worker. Prefer narrow repo-relative paths; `.` or `*` is only for explicit integration ownership.
- Use `--env-setup CMD` only for setup needed by multiple workers and final verification. Use `--worker-env-setup NAME:CMD` or ticket environment instructions for worker-local setup. Use `--final-env-setup CMD` only for final integration.
- JavaScript package dirs referenced by `npm --prefix DIR ...`, `npm -C DIR ...`, or root `npm ...` are auto-prepared unless `--no-auto-env-setup` is passed.
- Shared download caches are allowed and injected by the harness: pip, npm, and uv caches under `~/.codex/cache/hybrid-worker/`. Dependency/build directories are never shared as repo state and are forbidden in diffs.
- Defaults are non-interactive and bounded: worker timeout 1500 seconds, test timeout 1800 seconds, parallelism capped at 3 unless explicitly set.
- Retry failed phases with `--accepted-branch NAME:BRANCH` to reuse already accepted worker branches.
- `--codex-fallback-command` and `--merge-conflict-command` are explicit rescue paths. They are off by default.

## Usage And Reporting

- Claude calls use `claude -p --output-format json --disable-slash-commands --model deepseek-v4-flash --no-session-persistence` by default.
- The harness best-effort parses Claude CLI structured output for token/cost usage. Missing usage is recorded as `not_observed`; do not ask Claude to estimate token counts.
- Codex token usage comes from Codex JSONL logs outside this harness. Claude worker usage comes from per-worker structured Claude output when available.
- Reports include worker timing, merge timing, generated artifact policy, environment policy, compact result/usage artifacts, and usage observations. Raw Claude JSON logs remain available for forensic debugging but should not be read by default report writers.

## Example

```bash
node ~/.codex/skills/hybrid-worker/dist/src/cli.js \
  --repo /path/to/repo \
  --task-file TASK.md \
  --worker backend:tickets/backend.md \
  --worker frontend:tickets/frontend.md \
  --allowed-path backend:backend \
  --allowed-path backend:tests/backend \
  --allowed-path frontend:frontend \
  --worker-test backend:"$PYTHON -m pytest tests/backend -q" \
  --worker-test frontend:"npm --prefix frontend test -- --run" \
  --test "$PYTHON -m pytest" \
  --test "npm --prefix frontend run build" \
  --merge
```

Run unit and fake-worker tests after changing the harness before using live Claude workers.
