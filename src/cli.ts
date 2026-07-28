#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_MAX_PARALLELISM,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TEST_TIMEOUT_SEC,
  DEFAULT_WORKER_TIMEOUT_SEC
} from "./constants.js";
import { choosePython, parseEnvironmentPolicy } from "./env.js";
import { currentBranch, ensureGitRepo } from "./git.js";
import { writeJson, printJson } from "./json.js";
import {
  beginIntegration,
  fastForwardIntegration,
  finishIntegration,
  markIntegrationError,
  mergeResultsIntoIntegration,
  runIntegrationTests,
  transactionalMerge,
  type IntegrationSession
} from "./merge.js";
import { parseNamedValue, safeName } from "./parse.js";
import { buildReport, doctorReport } from "./report.js";
import { reusedWorkerResult, runWorker } from "./worker.js";
import { applyPlanToArgs, buildExecutionPhases, preflight } from "./plan.js";
import { EventLogger } from "./events.js";
import { commandExists } from "./platform.js";
import type { CliOptions, EnvironmentPolicy, ExecutionPhase, MergeResult, WorkerResult } from "./types.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const started = performance.now();
  const args = parseArgs(argv);
  if (args.doctor) {
    const report = doctorReport(args, choosePython);
    printJson(report);
    return report.status === "ok" ? 0 : 1;
  }
  if (!args.taskFile) throw new CliError("--task-file is required unless --doctor is used");
  const repo = ensureGitRepo(resolve(args.repo), args.repoIgnorePolicy);
  const loadedPlan = applyPlanToArgs(args, repo);
  if (args.worker.length === 0 && args.acceptedBranch.length === 0) throw new CliError("at least one --worker or --accepted-branch is required");
  if (args.executor === "claude" && !commandExists(args.claudeBin)) throw new CliError(`Claude binary not found: ${args.claudeBin}`);

  args.runId ??= `${timestamp()}-${Math.random().toString(16).slice(2, 8)}`;
  args.runDir = resolve(args.runDir ?? join(repo, ".git", "hybrid-worker", "runs", args.runId));
  args.worktreeRoot = resolve(args.worktreeRoot ?? join(homedir(), ".codex", "worktrees", "hybrid-worker", args.runId));
  args.eventsFile = resolve(args.eventsFile ?? join(args.runDir, "events.ndjson"));
  mkdirSync(args.runDir, { recursive: true });
  mkdirSync(args.worktreeRoot, { recursive: true });
  const events = new EventLogger(args.eventsFile, args.runId);
  events.emit("run_started", { status: args.dryRun ? "dry_run" : "running", data: { repo, model: args.claudeModel } });

  const taskFile = isAbsolute(args.taskFile) ? args.taskFile : join(repo, args.taskFile);
  const taskText = readFileSync(taskFile, "utf8");

  const preflightResult = preflight(args, repo);
  events.emit("preflight_completed", { status: preflightResult.ok ? "ok" : "failed", data: { errors: preflightResult.errors, warnings: preflightResult.warnings } });
  if (!preflightResult.ok) throw new CliError(preflightResult.errors.join("\n"));
  const allowedByWorker = preflightResult.allowedByWorker;
  const workers = preflightResult.workers;
  const phases = buildExecutionPhases(loadedPlan, preflightResult);
  const acceptedBranches = Object.fromEntries(args.acceptedBranch.map((item) => parseNamedValue(item, "--accepted-branch")));
  const workerNames = new Set(workers.map((worker) => worker.name));
  const allWorkerNames = new Set([...workerNames, ...Object.keys(acceptedBranches)]);
  const testsByWorker = preflightResult.workerTests;

  args.fakeImplementers = Object.fromEntries(args.fakeImplementer.map((item) => parseNamedValue(item, "--fake-implementer")));
  if (args.executor === "fake-command") {
    const missingImpl = [...workerNames].filter((name) => !(name in args.fakeImplementers)).sort();
    if (missingImpl.length) throw new CliError(`missing fake commands implementer=${JSON.stringify(missingImpl)}`);
  }

  const envPolicy = parseEnvironmentPolicy(args);
  const unknownWorkerSetup = Object.keys(envPolicy.workerSetup).filter((name) => !allWorkerNames.has(name)).sort();
  if (unknownWorkerSetup.length) throw new CliError(`unknown --worker-env-setup worker(s): ${unknownWorkerSetup.join(", ")}`);

  const python = choosePython();
  const baseBranch = currentBranch(repo);
  writeHuman(args, `Hybrid worker
- Repo: ${repo}
- Run ID: ${args.runId}
- Model: ${args.claudeModel}
- Python: ${python.command}
- Auto env setup: ${envPolicy.autoSetupEnabled ? "on" : "off"}
- Workers: ${[...workerNames].sort().join(", ") || "(none)"}
`);
  if (Object.keys(acceptedBranches).length) {
    writeHuman(args, `- Reused accepted branches: ${Object.entries(acceptedBranches).map(([name, branch]) => `${name}=${branch}`).sort().join(", ")}\n`);
  }
  if (preflightResult.warnings.length) writeHuman(args, `- Preflight warnings: ${preflightResult.warnings.length}\n`);

  if (args.dryRun) {
    const merge = emptyMergeResult();
    const report = buildReport({
      status: "preflight_ok",
      repo,
      baseBranch,
      args,
      workers,
      results: [],
      merge,
      python,
      elapsedSec: (performance.now() - started) / 1000,
      envPolicy,
      preflight: preflightResult,
      phases
    });
    const reportPath = resolve(args.jsonReport ?? join(args.runDir, "report.json"));
    writeJson(reportPath, report);
    events.emit("run_finished", { status: "preflight_ok", data: { report: reportPath } });
    finishOutput(args, report, reportPath);
    return 0;
  }

  const results: WorkerResult[] = [];
  for (const [name, branch] of Object.entries(acceptedBranches).sort()) {
    results.push(reusedWorkerResult(name, branch, repo, baseBranch, args.runDir, allowedByWorker[name] ?? [], args));
    events.emit("worker_reused", { worker: name, status: results.at(-1)?.accepted ? "accepted" : "rejected", data: { branch } });
  }
  const needsIntegrationDuringRun = args.merge || phases.length > 1 || phases.some((phase) => phase.finalTests.length > 0);
  let merge = emptyMergeResult();
  let integration: IntegrationSession | null = null;
  let status = results.some((result) => !result.accepted) ? "rejected" : "accepted";
  if (needsIntegrationDuringRun && status === "accepted") {
    events.emit("merge_started", { status: "running", data: { phased: phases.length > 1 } });
    integration = beginIntegration(repo, baseBranch, args);
    if (results.length) {
      try {
        await mergeResultsIntoIntegration(integration, results, args, python.command, "merge-conflict-accepted.log");
      } catch (error) {
        markIntegrationError(integration, error);
        status = "merge_failed";
      }
    }
  }

  if (status === "accepted") {
    for (const phase of phases) {
      if (phase.workers.length === 0) continue;
      events.emit("phase_started", { status: "running", data: { phase: phase.name, parallel: phase.parallel, workers: phase.workers.map((worker) => worker.name) } });
      const baseRef = integration ? integration.result.integration_branch : baseBranch;
      const phaseResults = await runPhase({
        phase,
        repo,
        baseRef,
        taskText,
        testsByWorker,
        runDir: args.runDir!,
        args,
        pythonCommand: python.command,
        envPolicy,
        events
      });
      results.push(...phaseResults);
      const phaseRejected = phaseResults.filter((result) => !result.accepted);
      if (phaseRejected.length) {
        status = "rejected";
        events.emit("phase_finished", { status, data: { phase: phase.name, rejected: phaseRejected.map((result) => result.name) } });
        break;
      }
      if (integration) {
        try {
          await mergeResultsIntoIntegration(integration, phaseResults, args, python.command, `merge-conflict-${safeName(phase.name)}.log`);
          await runIntegrationTests(integration, phase.finalTests, `phase-${safeName(phase.name)}.tests.log`, python.command, args.testTimeoutSec, envPolicy, `Phase ${phase.name} verification failed`);
        } catch (error) {
          markIntegrationError(integration, error);
          status = integration.result.error.includes("verification failed") ? "phase_verification_failed" : "merge_failed";
          events.emit("phase_finished", { status, data: { phase: phase.name, error: integration.result.error } });
          break;
        }
      }
      events.emit("phase_finished", { status: "accepted", data: { phase: phase.name } });
    }
  }

  const rejected = results.filter((result) => !result.accepted);
  if (rejected.length) status = "rejected";
  if (integration) {
    if (status === "accepted") {
      try {
        await runIntegrationTests(integration, args.test, "final.tests.log", python.command, args.testTimeoutSec, envPolicy, "Final verification failed");
        if (args.merge) {
          fastForwardIntegration(integration, results);
          status = "merged";
        }
      } catch (error) {
        markIntegrationError(integration, error);
        status = integration.result.error.includes("Final verification failed") ? "final_verification_failed" : "merge_failed";
      }
    }
    finishIntegration(integration);
    merge = integration.result;
    events.emit("merge_finished", { status: merge.merged ? "merged" : status === "accepted" ? "accepted" : "failed", data: { error: merge.error } });
  } else if (rejected.length === 0 && args.merge) {
    events.emit("merge_started", { status: "running" });
    merge = await transactionalMerge(repo, baseBranch, results, args, python.command, envPolicy);
    events.emit("merge_finished", { status: merge.merged ? "merged" : "failed", data: { error: merge.error } });
    status = merge.merged ? "merged" : merge.error.includes("Final verification failed") ? "final_verification_failed" : "merge_failed";
  }
  const report = buildReport({
    status,
    repo,
    baseBranch,
    args,
    workers,
    results: [...results].sort((a, b) => a.name.localeCompare(b.name)),
    merge,
    python,
    elapsedSec: (performance.now() - started) / 1000,
    envPolicy,
    preflight: preflightResult,
    phases
  });
  const reportPath = resolve(args.jsonReport ?? join(args.runDir, "report.json"));
  writeJson(reportPath, report);
  finishOutput(args, report, reportPath);
  if (status !== "merged" && args.merge) {
    writeHuman(args, `Status: ${status}\n`);
    if (merge.error) writeHuman(args, `${merge.error}\n`);
  }
  events.emit("run_finished", { status, data: { report: reportPath } });
  return status === "accepted" || status === "merged" ? 0 : 1;
}

async function runPhase(input: {
  phase: ExecutionPhase;
  repo: string;
  baseRef: string;
  taskText: string;
  testsByWorker: Record<string, string[]>;
  runDir: string;
  args: CliOptions;
  pythonCommand: string;
  envPolicy: EnvironmentPolicy;
  events: Pick<EventLogger, "emit">;
}): Promise<WorkerResult[]> {
  const defaultParallelism = Math.min(input.phase.workers.length, DEFAULT_MAX_PARALLELISM);
  const requestedParallelism = input.phase.parallel ? (input.args.parallelism ?? defaultParallelism) : 1;
  return await mapLimited(input.phase.workers, Math.max(1, requestedParallelism), async (worker) => {
    input.events.emit("worker_started", { worker: worker.name, status: "running", data: { phase: input.phase.name } });
    const result = await runWorker({
      worker,
      repo: input.repo,
      baseBranch: input.baseRef,
      taskText: input.taskText,
      workerTests: input.testsByWorker[worker.name] ?? [],
      allowedPaths: worker.allowedPaths,
      runDir: input.runDir,
      args: input.args,
      pythonCommand: input.pythonCommand,
      envPolicy: input.envPolicy
    });
    input.events.emit("worker_finished", {
      worker: worker.name,
      status: result.accepted ? "accepted" : "rejected",
      data: { phase: input.phase.name, findings: result.findings, changed_paths: result.changed_paths }
    });
    return result;
  });
}

function writeHuman(args: CliOptions, text: string): void {
  if (args.quiet || args.json) return;
  process.stdout.write(text);
}

function finishOutput(args: CliOptions, report: Record<string, unknown>, reportPath: string): void {
  if (args.json) {
    printJson({ report_path: reportPath, ...report });
    return;
  }
  writeHuman(args, `Report: ${reportPath}\n`);
}

export function parseArgs(argv: string[]): CliOptions {
  const args: CliOptions = {
    doctor: false,
    dryRun: false,
    json: false,
    quiet: false,
    preflightStrict: false,
    repo: process.cwd(),
    repoIgnorePolicy: "tracked",
    worker: [],
    acceptedBranch: [],
    allowedPath: [],
    workerTest: [],
    test: [],
    envSetup: [],
    workerEnvSetup: [],
    finalEnvSetup: [],
    noAutoEnvSetup: false,
    executor: "claude",
    fakeImplementer: [],
    fakeImplementers: {},
    claudeBin: process.env.CLAUDE_BIN ?? "claude",
    claudeModel: DEFAULT_MODEL,
    permissionMode: DEFAULT_PERMISSION_MODE,
    merge: false,
    forbidPath: [],
    maxChangedFiles: DEFAULT_MAX_CHANGED_FILES,
    maxDiffLines: DEFAULT_MAX_DIFF_LINES,
    workerTimeoutSec: DEFAULT_WORKER_TIMEOUT_SEC,
    testTimeoutSec: DEFAULT_TEST_TIMEOUT_SEC
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next == null) throw new CliError(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--doctor":
        args.doctor = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--preflight-strict":
        args.preflightStrict = true;
        break;
      case "--repo":
        args.repo = value();
        break;
      case "--repo-ignore-policy": {
        const policy = value();
        if (policy !== "tracked" && policy !== "local") throw new CliError("--repo-ignore-policy must be tracked or local");
        args.repoIgnorePolicy = policy;
        break;
      }
      case "--task-file":
        args.taskFile = value();
        break;
      case "--plan-file":
        args.planFile = value();
        break;
      case "--worker":
        args.worker.push(value());
        break;
      case "--accepted-branch":
        args.acceptedBranch.push(value());
        break;
      case "--allowed-path":
        args.allowedPath.push(value());
        break;
      case "--worker-test":
        args.workerTest.push(value());
        break;
      case "--test":
        args.test.push(value());
        break;
      case "--env-setup":
        args.envSetup.push(value());
        break;
      case "--worker-env-setup":
        args.workerEnvSetup.push(value());
        break;
      case "--final-env-setup":
        args.finalEnvSetup.push(value());
        break;
      case "--no-auto-env-setup":
        args.noAutoEnvSetup = true;
        break;
      case "--executor": {
        const executor = value();
        if (executor !== "claude" && executor !== "fake-command") throw new CliError("--executor must be claude or fake-command");
        args.executor = executor;
        break;
      }
      case "--fake-implementer":
        args.fakeImplementer.push(value());
        break;
      case "--claude-bin":
        args.claudeBin = value();
        break;
      case "--claude-model":
        args.claudeModel = value();
        break;
      case "--permission-mode":
        args.permissionMode = value();
        break;
      case "--run-id":
        args.runId = safeName(value());
        break;
      case "--run-dir":
        args.runDir = value();
        break;
      case "--worktree-root":
        args.worktreeRoot = value();
        break;
      case "--json-report":
        args.jsonReport = value();
        break;
      case "--events-file":
        args.eventsFile = value();
        break;
      case "--merge":
        args.merge = true;
        break;
      case "--codex-fallback-command":
        args.codexFallbackCommand = value();
        break;
      case "--merge-conflict-command":
        args.mergeConflictCommand = value();
        break;
      case "--forbid-path":
        args.forbidPath.push(value());
        break;
      case "--max-changed-files":
        args.maxChangedFiles = parsePositiveInt(value(), flag);
        break;
      case "--max-diff-lines":
        args.maxDiffLines = parsePositiveInt(value(), flag);
        break;
      case "--parallelism":
        args.parallelism = parsePositiveInt(value(), flag);
        break;
      case "--worker-timeout-sec":
        args.workerTimeoutSec = parsePositiveInt(value(), flag);
        break;
      case "--test-timeout-sec":
        args.testTimeoutSec = parsePositiveInt(value(), flag);
        break;
      default:
        throw new CliError(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw) throw new CliError(`${flag} must be a positive integer`);
  return value;
}

class CliError extends Error {}

function emptyMergeResult(): MergeResult {
  return {
    attempted: false,
    merged: false,
    integration_branch: "",
    base_before: "",
    base_after: "",
    base_unchanged_on_failure: true,
    error: "",
    conflict_resolution_attempted: false,
    conflict_resolution_log_file: "",
    elapsed_sec: 0
  };
}

async function mapLimited<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
