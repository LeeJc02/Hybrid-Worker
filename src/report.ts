import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_MAX_PARALLELISM,
  DEFAULT_MODEL,
  DEFAULT_TEST_TIMEOUT_SEC,
  DEFAULT_WORKER_TIMEOUT_SEC,
  GENERATED_ARTIFACT_DIRS,
  GENERATED_ARTIFACT_FILES,
  GENERATED_ARTIFACT_SUFFIXES
} from "./constants.js";
import { sharedCachePolicy } from "./env.js";
import { commandExists } from "./platform.js";
import { combineUsage } from "./usage.js";
import type { CliOptions, EnvironmentPolicy, ExecutionPhase, MergeResult, PreflightResult, PythonChoice, WorkerResult, WorkerSpec } from "./types.js";

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
    workflow_mode: "single_call_worker_self_review",
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
      max_diff_lines: DEFAULT_MAX_DIFF_LINES
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
