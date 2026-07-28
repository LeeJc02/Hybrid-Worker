export type ExecutorKind = "claude" | "fake-command";
export type RepoIgnorePolicy = "tracked" | "local";

export type FindingSeverity = "hard" | "soft";

export type FindingCode =
  | "accepted_branch_missing"
  | "base_repo_dirty"
  | "changed_file_count_exceeded"
  | "codex_fallback_no_diff"
  | "decision_invalid_json"
  | "decision_schema_invalid"
  | "diff_line_count_exceeded"
  | "forbidden_path_changed"
  | "generated_artifact_changed"
  | "implementer_failed"
  | "missing_decision"
  | "missing_marker"
  | "missing_summary"
  | "no_diff"
  | "out_of_scope_change"
  | "summary_invalid_json"
  | "summary_schema_invalid"
  | "tests_failed"
  | "worker_crashed";

export interface GateFinding {
  code: FindingCode;
  severity: FindingSeverity;
  message: string;
  path?: string;
  stage?: string;
}

export interface WorkerSpec {
  name: string;
  ticket: string;
  allowedPaths: string[];
}

export interface StageResult {
  stage: string;
  returncode: number;
  log_file: string;
  marker_found: boolean;
  elapsed_sec: number;
  usage: Usage;
  usage_file: string;
  result_file: string;
}

export interface WorkerResult {
  name: string;
  branch: string;
  worktree: string;
  accepted: boolean;
  merged: boolean;
  reused: boolean;
  commit: string | null;
  changed_paths: string[];
  findings: string[];
  finding_details: GateFinding[];
  implementer: StageResult | null;
  test_returncode: number | null;
  summary_file: string;
  decision_file: string;
  diff_file: string;
  diffstat_file: string;
  test_log_file: string;
  elapsed_sec: number;
  usage: Usage;
  codex_fallback_applied: boolean;
  codex_fallback_log_file: string;
  exception: string;
}

export interface MergeResult {
  attempted: boolean;
  merged: boolean;
  integration_branch: string;
  base_before: string;
  base_after: string;
  base_unchanged_on_failure: boolean;
  error: string;
  conflict_resolution_attempted: boolean;
  conflict_resolution_log_file: string;
  elapsed_sec: number;
}

export type RunEventType =
  | "run_started"
  | "preflight_completed"
  | "phase_started"
  | "phase_finished"
  | "worker_started"
  | "worker_finished"
  | "worker_reused"
  | "merge_started"
  | "merge_finished"
  | "run_finished";

export interface RunEvent {
  type: RunEventType;
  timestamp: string;
  run_id?: string;
  worker?: string;
  status?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface EnvironmentPolicy {
  commonSetup: string[];
  finalSetup: string[];
  workerSetup: Record<string, string[]>;
  autoSetupEnabled: boolean;
}

export interface Usage {
  status: "observed" | "not_observed";
  reason?: string;
  [key: string]: unknown;
}

export interface CliOptions {
  doctor: boolean;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  preflightStrict: boolean;
  repo: string;
  repoIgnorePolicy: RepoIgnorePolicy;
  taskFile?: string;
  planFile?: string;
  worker: string[];
  acceptedBranch: string[];
  allowedPath: string[];
  workerTest: string[];
  test: string[];
  envSetup: string[];
  workerEnvSetup: string[];
  finalEnvSetup: string[];
  noAutoEnvSetup: boolean;
  executor: ExecutorKind;
  fakeImplementer: string[];
  fakeImplementers: Record<string, string>;
  claudeBin: string;
  claudeModel: string;
  permissionMode: string;
  runId?: string;
  runDir?: string;
  worktreeRoot?: string;
  jsonReport?: string;
  merge: boolean;
  codexFallbackCommand?: string;
  mergeConflictCommand?: string;
  forbidPath: string[];
  maxChangedFiles: number;
  maxDiffLines: number;
  parallelism?: number;
  workerTimeoutSec: number;
  testTimeoutSec: number;
  eventsFile?: string;
}

export interface PythonChoice {
  command: string;
  fallbackUsed: boolean;
  source: string;
}

export interface PlanWorker {
  name: string;
  ticket: string;
  allowed_paths?: string[];
  worker_tests?: string[];
}

export interface PlanPhase {
  name: string;
  parallel?: boolean;
  workers: PlanWorker[];
  final_tests?: string[];
}

export interface WorkerPlan {
  run_id?: string;
  model?: string;
  shared_setup?: string[];
  phases: PlanPhase[];
  final_verification?: string[];
  split_rationale?: string[];
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  workers: WorkerSpec[];
  workerTests: Record<string, string[]>;
  allowedByWorker: Record<string, string[]>;
}

export interface ExecutionPhase {
  name: string;
  parallel: boolean;
  workers: WorkerSpec[];
  finalTests: string[];
}
