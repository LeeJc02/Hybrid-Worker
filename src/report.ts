import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_MAX_PARALLELISM,
  DEFAULT_MODEL,
  DEFAULT_BROKER_LEASE_SEC,
  DEFAULT_BROKER_MAX_CALLS,
  DEFAULT_BROKER_MAX_COST_USD,
  DEFAULT_BROKER_MAX_READONLY,
  DEFAULT_BROKER_MAX_WRITE,
  DEFAULT_TEST_TIMEOUT_SEC,
  DEFAULT_WORKER_TIMEOUT_SEC,
  GENERATED_ARTIFACT_DIRS,
  GENERATED_ARTIFACT_FILES,
  GENERATED_ARTIFACT_SUFFIXES
} from "./constants.js";
import { sharedCachePolicy } from "./env.js";
import { commandExists } from "./platform.js";
import { combineUsage } from "./usage.js";
import { ResourceBroker } from "./broker.js";
import type {
  CliOptions,
  CompiledWorkflow,
  EnvironmentPolicy,
  ExecutionPhase,
  MergeResult,
  PreflightResult,
  PythonChoice,
  ScaleDecision,
  WorkerResult,
  WorkerSpec
} from "./types.js";

export function buildReport(input: {
  status: string;
  repo: string;
  baseBranch: string;
  args: CliOptions;
  workers: WorkerSpec[];
  results: WorkerResult[];
  merge: MergeResult;
  python: PythonChoice;
  elapsedSec: number;
  envPolicy: EnvironmentPolicy;
  preflight?: PreflightResult;
  phases?: ExecutionPhase[];
  workflow?: {
    compiled: CompiledWorkflow;
    decision: ScaleDecision;
    manager_id?: string;
    parent_run_dir?: string;
  };
}): Record<string, unknown> {
  const workerUsage = Object.fromEntries(input.results.map((result) => [result.name, result.usage]));
  return {
    status: input.status,
    repo: input.repo,
    base_branch: input.baseBranch,
    run_id: input.args.runId,
    model: input.args.claudeModel,
    model_overridden: input.args.claudeModel !== DEFAULT_MODEL,
    python: { command: input.python.command, fallback_used: input.python.fallbackUsed, source: input.python.source },
    workers_requested: input.workers.map((worker) => ({ name: worker.name, ticket: worker.ticket, allowed_paths: worker.allowedPaths })),
    execution_phases: input.phases?.map((phase) => ({
      name: phase.name,
      parallel: phase.parallel,
      workers: phase.workers.map((worker) => worker.name),
      final_tests: phase.finalTests
    })),
    workers: input.results,
    pilot: input.workflow ? input.results.find((result) => result.pilot)?.name ?? null : undefined,
    batches: input.workflow
      ? Object.values(
          input.results.reduce<Record<string, string[]>>((groups, result) => {
            if (result.batch == null) return groups;
            (groups[String(result.batch)] ??= []).push(result.name);
            return groups;
          }, {})
        )
      : undefined,
    blocked_nodes: input.workflow ? input.results.filter((result) => result.blocked).map((result) => result.name) : undefined,
    circuit_breakers: input.workflow
      ? input.results.filter((result) => result.finding_details.some((item) => item.code === "circuit_open")).map((result) => ({ node: result.name, findings: result.findings }))
      : undefined,
    merge: input.merge,
    timing: {
      elapsed_sec: input.elapsedSec,
      worker_elapsed_sec: input.results.reduce((sum, result) => sum + result.elapsed_sec, 0),
      merge_elapsed_sec: input.merge.elapsed_sec
    },
    usage: {
      status: "structured_json_best_effort",
      source: "claude --output-format json",
      workers: workerUsage,
      total: combineUsage(input.results.map((result) => result.usage))
    },
    resume_commands: buildResumeCommands(input.args, input.results),
    workflow_mode: input.workflow ? "declarative_dynamic_dag" : "single_call_worker_self_review",
    execution_mode: input.workflow?.decision.execution_mode ?? "single_layer",
    scale_decision: input.workflow?.decision,
    global_dag: input.workflow?.compiled.nodes,
    manager: input.workflow
      ? {
          id: input.workflow.manager_id,
          parent_run_dir: input.workflow.parent_run_dir,
          branch: input.baseBranch
        }
      : undefined,
    routing: input.workflow
      ? Object.fromEntries(
          input.workers.map((worker) => [
            worker.name,
            { risk: worker.risk, route: worker.route, model: worker.model, effort: worker.effort, fallback: worker.fallback, verification: worker.verification }
          ])
        )
      : undefined,
    global_limits: input.workflow
      ? {
          readonly_concurrency: input.args.brokerMaxReadonly,
          write_concurrency: input.args.brokerMaxWrite,
          claude_calls: input.args.brokerMaxCalls,
          observed_cost_usd: input.args.brokerMaxCostUsd,
          lease_sec: input.args.brokerLeaseSec,
          broker_dir: input.args.brokerDir
        }
      : undefined,
    broker: input.workflow && input.args.brokerDir ? brokerSnapshot(input.args) : undefined,
    events_file: input.args.eventsFile,
    preflight: input.preflight
      ? { ok: input.preflight.ok, errors: input.preflight.errors, warnings: input.preflight.warnings }
      : undefined,
    generated_artifact_policy: {
      git_exclude_injected: true,
      tracked_gitignore_injected: input.args.repoIgnorePolicy === "tracked",
      local_git_info_exclude_injected: true,
      clean_before_diff: true,
      rejected_if_changed: [...GENERATED_ARTIFACT_DIRS, ...GENERATED_ARTIFACT_FILES].sort(),
      rejected_suffixes: [...GENERATED_ARTIFACT_SUFFIXES].sort()
    },
    environment_policy: {
      repo_ignore_policy: input.args.repoIgnorePolicy,
      common_setup: input.envPolicy.commonSetup,
      final_setup: input.envPolicy.finalSetup,
      worker_setup: input.envPolicy.workerSetup,
      auto_setup_enabled: input.envPolicy.autoSetupEnabled,
      auto_setup: "npm package directories referenced by worker/final test commands are installed with npm ci when package-lock.json exists, otherwise npm install",
      shared_cache_env: sharedCachePolicy()
    }
  };
}

function brokerSnapshot(args: CliOptions): unknown {
  try {
    return new ResourceBroker(args.brokerDir!, {
      maxReadonly: args.brokerMaxReadonly,
      maxWrite: args.brokerMaxWrite,
      maxCalls: args.brokerMaxCalls,
      maxCostUsd: args.brokerMaxCostUsd,
      leaseSec: args.brokerLeaseSec
    }).snapshot();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function doctorReport(args: CliOptions, pythonProbe: () => PythonChoice): Record<string, unknown> {
  let python: Record<string, unknown>;
  try {
    const choice = pythonProbe();
    python = { ok: true, command: choice.command, fallback_used: choice.fallbackUsed, source: choice.source };
  } catch (error) {
    python = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const claudeFound = commandExists(args.claudeBin);
  const gitFound = commandExists("git");
  return {
    status: python.ok && claudeFound && gitFound ? "ok" : "failed",
    claude: { binary: args.claudeBin, found: claudeFound, model: args.claudeModel, permission_mode: args.permissionMode },
    python,
    git: { found: gitFound },
    defaults: {
      workflow_mode: "single_call_worker_self_review",
      claude_usage_monitoring: "structured_json_best_effort",
      environment_setup: "common setup + worker/final setup + automatic npm install/ci for package dirs referenced by tests",
      auto_env_setup: true,
      repo_ignore_policy: args.repoIgnorePolicy,
      shared_cache_env: sharedCachePolicy(),
      max_parallelism: DEFAULT_MAX_PARALLELISM,
      worker_timeout_sec: DEFAULT_WORKER_TIMEOUT_SEC,
      test_timeout_sec: DEFAULT_TEST_TIMEOUT_SEC,
      max_changed_files: DEFAULT_MAX_CHANGED_FILES,
      max_diff_lines: DEFAULT_MAX_DIFF_LINES,
      v2: {
        hierarchical_min_required_writes: 12,
        manager_count: 3,
        max_readonly_agents: DEFAULT_BROKER_MAX_READONLY,
        max_write_workers: DEFAULT_BROKER_MAX_WRITE,
        max_agent_calls: DEFAULT_BROKER_MAX_CALLS,
        max_observed_cost_usd: DEFAULT_BROKER_MAX_COST_USD,
        lease_sec: DEFAULT_BROKER_LEASE_SEC
      }
    }
  };
}

function buildResumeCommands(args: CliOptions, results: WorkerResult[]): Record<string, unknown> {
  const accepted = results
    .filter((result) => result.accepted && result.branch)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((result) => ({ worker: result.name, branch: result.branch, arg: `--accepted-branch ${result.name}:${result.branch}` }));
  return {
    accepted_branches: accepted,
    accepted_branch_args: accepted.map((item) => item.arg),
    note:
      accepted.length === 0
        ? "No accepted worker branches are available to reuse."
        : "Reuse these accepted branches on a retry to avoid rerunning completed workers.",
    merge_required: args.merge
  };
}
