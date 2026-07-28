export type ExecutorKind = "claude" | "fake-command";
export type RepoIgnorePolicy = "tracked" | "local";
export type ExecutionMode = "single_layer" | "single_layer_dynamic_dag" | "hierarchical";
export type AgentAccess = "readonly" | "write";
export type ModelRoute = "fast" | "balanced" | "deep";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type WorkflowNodeKind = "scout" | "planner" | "shared_contract" | "implementer" | "verifier" | "repair";

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
  | "verifier_failed"
  | "verifier_modified_worktree"
  | "repair_failed"
  | "circuit_open"
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
  risk?: RiskLevel;
  route?: ModelRoute;
  model?: "haiku" | "sonnet" | "opus";
  effort?: "low" | "medium" | "high";
  fallback?: ModelRoute;
  verification?: VerificationPolicy;
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
  broker_wait_sec?: number;
  model_route?: ModelRoute;
  model?: string;
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
  verification: StageResult[];
  repair: StageResult | null;
  verification_votes: { passed: number; required: number; total: number } | null;
  pilot: boolean;
  batch: number | null;
  blocked: boolean;
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
  | "pilot_started"
  | "batch_finished"
  | "circuit_open"
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
  fakeVerifier: string[];
  fakeVerifiers: Record<string, string>;
  fakeRepair: string[];
  fakeRepairs: Record<string, string>;
  fakePlanner?: string;
  fakeScout: string[];
  fakeScouts: Record<string, string>;
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
  workflowSeed?: string;
  compiledWorkflow?: string;
  workflowPlanOnly: boolean;
  finalizeParentRun?: string;
  managerId?: string;
  parentRunDir?: string;
  brokerDir?: string;
  brokerMaxReadonly: number;
  brokerMaxWrite: number;
  brokerMaxCalls: number;
  brokerMaxCostUsd: number;
  brokerLeaseSec: number;
  workflowNodes: Record<string, Omit<WorkerSpec, "name" | "ticket" | "allowedPaths">>;
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

export interface CommandSpec {
  argv: string[];
  cwd?: string;
}

export interface WorkflowSeedNode {
  id: string;
  kind: WorkflowNodeKind;
  required?: boolean;
  risk_floor?: RiskLevel;
  paths?: string[];
}

export interface WorkflowSeed {
  version: 2;
  run_id?: string;
  objective: string;
  command_catalog: Record<string, CommandSpec>;
  nodes?: WorkflowSeedNode[];
  final_verification: string[];
}

export interface WorkflowReference {
  node: string;
  output: string;
}

export interface WorkflowForEach {
  ref: WorkflowReference;
  item_name?: string;
}

export interface WorkflowCondition {
  ref: WorkflowReference;
  exists?: boolean;
  equals?: string | number | boolean | null;
  in?: Array<string | number | boolean | null>;
}

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  required: boolean;
  workstream?: string;
  owner?: string;
  depends_on: string[];
  paths: string[];
  ticket?: string;
  ticket_text?: string;
  command_refs: string[];
  risk: RiskLevel;
  route?: ModelRoute;
  effort?: "low" | "medium" | "high";
  fallback?: ModelRoute;
  for_each?: WorkflowForEach;
  when?: WorkflowCondition;
  inputs?: Record<string, WorkflowReference>;
  outputs?: Record<string, unknown>;
  item?: unknown;
  template_id?: string;
}

export interface CompiledWorkflow {
  version: 2;
  run_id?: string;
  base_commit?: string;
  objective: string;
  command_catalog: Record<string, CommandSpec>;
  nodes: WorkflowNode[];
  final_verification: string[];
  shared_contract_frozen?: boolean;
}

export interface ScaleDecision {
  execution_mode: ExecutionMode;
  required_write_nodes: number;
  workstreams: string[];
  reasons: string[];
}

export interface ModelSelection {
  route: ModelRoute;
  model: "haiku" | "sonnet" | "opus";
  effort: "low" | "medium" | "high";
  fallback?: ModelRoute;
}

export interface VerificationPolicy {
  route: ModelRoute;
  verifier_count: number;
  required_passes: number;
  repair_route: "deep";
  max_repairs: 1;
}

export interface ManagerPlan {
  manager_id: string;
  branch: string;
  worktree: string;
  run_dir: string;
  workflow_file: string;
  command: string[];
  node_ids: string[];
}
