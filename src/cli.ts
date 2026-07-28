#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_MAX_PARALLELISM,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_BROKER_LEASE_SEC,
  DEFAULT_BROKER_MAX_CALLS,
  DEFAULT_BROKER_MAX_COST_USD,
  DEFAULT_BROKER_MAX_READONLY,
  DEFAULT_BROKER_MAX_WRITE,
  DEFAULT_TEST_TIMEOUT_SEC,
  DEFAULT_WORKER_TIMEOUT_SEC
} from "./constants.js";
import { choosePython, parseEnvironmentPolicy } from "./env.js";
import { currentBranch, ensureGitRepo, head } from "./git.js";
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
import { emptyWorkerResult, reusedWorkerResult, runWorker } from "./worker.js";
import { applyCompiledWorkflowToArgs, applyPlanToArgs, buildExecutionPhases, commandText, preflight } from "./plan.js";
import { EventLogger } from "./events.js";
import { commandExists } from "./platform.js";
import { collectPrework, collectSeedPrework } from "./prework.js";
import { buildManagerPlans, parentManifest } from "./hierarchical.js";
import { decideExecutionMode, loadCompiledWorkflow, loadWorkflowSeed, materializeDeclarativeWorkflow, resolveWorkflowPath } from "./workflow.js";
import { circuitDecision } from "./scheduler.js";
import { run } from "./process.js";
import { compileWorkflowFromSeed, type PlanningResult } from "./planning.js";
import type { CliOptions, CompiledWorkflow, EnvironmentPolicy, ExecutionPhase, MergeResult, ScaleDecision, WorkerResult } from "./types.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const started = performance.now();
  const args = parseArgs(argv);
  args.fakeScouts = Object.fromEntries(args.fakeScout.map((item) => parseNamedValue(item, "--fake-scout")));
  if (args.doctor) {
    const report = doctorReport(args, choosePython);
    printJson(report);
    return report.status === "ok" ? 0 : 1;
  }
  if (args.finalizeParentRun) return await finalizeParentRun(args);
  if (!args.taskFile) throw new CliError("--task-file is required unless --doctor is used");
  const repo = ensureGitRepo(resolve(args.repo), args.workflowPlanOnly ? "local" : args.repoIgnorePolicy);
  const workflowSeed = args.workflowSeed ? loadWorkflowSeed(resolveWorkflowPath(repo, args.workflowSeed)) : undefined;
  let compiledWorkflow = args.compiledWorkflow
    ? loadCompiledWorkflow(resolveWorkflowPath(repo, args.compiledWorkflow), workflowSeed)
    : undefined;
  if (compiledWorkflow) compiledWorkflow = materializeDeclarativeWorkflow(compiledWorkflow);
  if (args.workflowPlanOnly) {
    if (!compiledWorkflow && !workflowSeed) throw new CliError("--workflow-plan-only requires --workflow-seed or --compiled-workflow");
    let prework: Record<string, unknown>;
    let planning: PlanningResult | undefined;
    if (!compiledWorkflow) {
      if (args.executor === "claude" && !commandExists(args.claudeBin)) throw new CliError(`Claude binary not found: ${args.claudeBin}`);
      prepareRunPaths(args, repo);
      args.brokerDir ??= join(args.runDir!, "broker");
      prework = collectSeedPrework(repo, workflowSeed!);
      planning = await compileWorkflowFromSeed({ repo, seed: workflowSeed!, prework, runDir: args.runDir!, args });
      compiledWorkflow = planning.workflow;
      args.compiledWorkflow = planning.workflow_file;
    } else {
      prework = collectPrework(repo, compiledWorkflow);
    }
    return workflowPlanOnly(args, repo, compiledWorkflow, prework, planning);
  }
  const workflowDecision = compiledWorkflow ? decideExecutionMode(compiledWorkflow) : undefined;
  const loadedPlan = compiledWorkflow ? applyCompiledWorkflowToArgs(args, compiledWorkflow) : applyPlanToArgs(args, repo);
  if (args.worker.length === 0 && args.acceptedBranch.length === 0) throw new CliError("at least one --worker or --accepted-branch is required");
  if (args.executor === "claude" && !commandExists(args.claudeBin)) throw new CliError(`Claude binary not found: ${args.claudeBin}`);

  prepareRunPaths(args, repo);
  if (compiledWorkflow) args.brokerDir ??= resolve(args.parentRunDir ?? join(args.runDir!, "broker"));
  const events = new EventLogger(args.eventsFile!, args.runId!);
  events.emit("run_started", { status: args.dryRun ? "dry_run" : "running", data: { repo, model: args.claudeModel } });

  const taskFile = isAbsolute(args.taskFile!) ? args.taskFile! : join(repo, args.taskFile!);
  let taskText = readFileSync(taskFile, "utf8");
  if (args.managerId && args.parentRunDir) {
    const sharedPrework = join(args.parentRunDir, "prework.json");
    if (existsSync(sharedPrework)) taskText += `\n\n# Shared read-only prework\n${readFileSync(sharedPrework, "utf8")}`;
  }

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
  args.fakeVerifiers = Object.fromEntries(args.fakeVerifier.map((item) => parseNamedValue(item, "--fake-verifier")));
  args.fakeRepairs = Object.fromEntries(args.fakeRepair.map((item) => parseNamedValue(item, "--fake-repair")));
  if (args.executor === "fake-command") {
    const missingImpl = [...workerNames].filter((name) => !(name in args.fakeImplementers)).sort();
    if (missingImpl.length) throw new CliError(`missing fake commands implementer=${JSON.stringify(missingImpl)}`);
    const missingVerifier = workers
      .filter((worker) => (worker.verification?.verifier_count ?? 0) > 0 && !(worker.name in args.fakeVerifiers))
      .map((worker) => worker.name)
      .sort();
    if (missingVerifier.length) throw new CliError(`missing fake commands verifier=${JSON.stringify(missingVerifier)}`);
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
      phases,
      ...(compiledWorkflow ? { workflow: workflowReportContext(compiledWorkflow, workflowDecision!, args) } : {})
    });
    const reportPath = resolve(args.jsonReport ?? join(args.runDir!, "report.json"));
    writeJson(reportPath, report);
    events.emit("run_finished", { status: "preflight_ok", data: { report: reportPath } });
    finishOutput(args, report, reportPath);
    return 0;
  }

  const results: WorkerResult[] = [];
  for (const [name, branch] of Object.entries(acceptedBranches).sort()) {
    results.push(reusedWorkerResult(name, branch, repo, baseBranch, args.runDir!, allowedByWorker[name] ?? [], args));
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
    phases,
    ...(compiledWorkflow ? { workflow: workflowReportContext(compiledWorkflow, workflowDecision!, args) } : {})
  });
  const reportPath = resolve(args.jsonReport ?? join(args.runDir!, "report.json"));
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
  const runOne = async (worker: ExecutionPhase["workers"][number], pilot: boolean, batch: number | null): Promise<WorkerResult> => {
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
    result.pilot = pilot;
    result.batch = batch;
    input.events.emit("worker_finished", {
      worker: worker.name,
      status: result.accepted ? "accepted" : "rejected",
      data: { phase: input.phase.name, findings: result.findings, changed_paths: result.changed_paths }
    });
    return result;
  };
  const isDynamicV2 = input.phase.workers.some((worker) => worker.verification != null);
  if (!isDynamicV2) {
    return await mapLimited(input.phase.workers, Math.max(1, requestedParallelism), (worker) => runOne(worker, false, null));
  }
  const ordered = [...input.phase.workers].sort((left, right) => left.name.localeCompare(right.name));
  const results: WorkerResult[] = [];
  const pilot = ordered.shift();
  if (!pilot) return results;
  input.events.emit("pilot_started", { worker: pilot.name, status: "running", data: { phase: input.phase.name } });
  const pilotResult = await runOne(pilot, true, 0);
  results.push(pilotResult);
  if (!pilotResult.accepted) {
    input.events.emit("circuit_open", { status: "open", data: { phase: input.phase.name, reason: "pilot failed" } });
    results.push(...blockedResults(ordered, "pilot failed; remaining homogeneous tasks were not started"));
    return results;
  }
  for (let index = 0, batch = 1; index < ordered.length; index += 4, batch += 1) {
    const workers = ordered.slice(index, index + 4);
    if (!workers.some((worker) => (input.testsByWorker[worker.name] ?? []).length > 0)) {
      const remaining = ordered.slice(index);
      input.events.emit("circuit_open", { status: "open", data: { phase: input.phase.name, batch, reason: "batch could not run any tests" } });
      results.push(...blockedResults(remaining, "circuit opened because the batch could not run any tests", batch));
      break;
    }
    const batchResults = await mapLimited(workers, Math.min(4, Math.max(1, requestedParallelism)), (worker) => runOne(worker, false, batch));
    results.push(...batchResults);
    const decision = circuitDecision(
      batchResults.map((result) => ({ passed: result.accepted, testsRunnable: (input.testsByWorker[result.name] ?? []).length > 0 }))
    );
    input.events.emit("batch_finished", { status: decision.open ? "failed" : "accepted", data: { phase: input.phase.name, batch, ...decision } });
    if (decision.open) {
      input.events.emit("circuit_open", { status: "open", data: { phase: input.phase.name, batch, reason: decision.reason } });
      results.push(...blockedResults(ordered.slice(index + workers.length), decision.reason, batch + 1));
      break;
    }
  }
  return results;
}

function blockedResults(workers: ExecutionPhase["workers"], reason: string, batch: number | null = null): WorkerResult[] {
  return workers.map((worker) => {
    const result = emptyWorkerResultForCircuit(worker.name, reason);
    result.batch = batch;
    return result;
  });
}

function emptyWorkerResultForCircuit(name: string, reason: string): WorkerResult {
  const result: WorkerResult = {
    name,
    branch: "",
    worktree: "",
    accepted: false,
    merged: false,
    reused: false,
    commit: null,
    changed_paths: [],
    findings: [reason],
    finding_details: [{ code: "circuit_open", severity: "hard", message: reason, stage: "scheduler" }],
    implementer: null,
    verification: [],
    repair: null,
    verification_votes: null,
    pilot: false,
    batch: null,
    blocked: true,
    test_returncode: null,
    summary_file: "",
    decision_file: "",
    diff_file: "",
    diffstat_file: "",
    test_log_file: "",
    elapsed_sec: 0,
    usage: { status: "not_observed", reason: "blocked before agent call" },
    codex_fallback_applied: false,
    codex_fallback_log_file: "",
    exception: ""
  };
  return result;
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

async function finalizeParentRun(args: CliOptions): Promise<number> {
  const parentPath = resolve(args.finalizeParentRun!);
  const manifestFile = parentPath.endsWith(".json") ? parentPath : join(parentPath, "parent-run.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  const parentRunDir = parentPath.endsWith(".json") ? dirname(parentPath) : parentPath;
  const repoValue = typeof manifest.repo === "string" ? manifest.repo : args.repo;
  const repo = ensureGitRepo(resolve(repoValue), "local");
  const baseCommit = typeof manifest.base_commit === "string" ? manifest.base_commit : "";
  const runId = typeof manifest.run_id === "string" ? manifest.run_id : `finalize-${timestamp()}`;
  const workflowFile = typeof manifest.compiled_workflow === "string" ? manifest.compiled_workflow : "";
  if (!baseCommit || !workflowFile || !Array.isArray(manifest.managers)) throw new CliError("invalid parent-run manifest");
  const workflow = loadCompiledWorkflow(workflowFile);
  const decision = decideExecutionMode(workflow);
  args.runId = runId;
  args.runDir ??= join(parentRunDir, "finalize");
  args.worktreeRoot ??= join(parentRunDir, "finalize-worktrees");
  args.parentRunDir = parentRunDir;
  args.merge = true;
  args.test = workflow.final_verification.map((ref) => commandText(workflow.command_catalog[ref]!));
  prepareRunPaths(args, repo);
  const events = new EventLogger(args.eventsFile!, args.runId!);
  events.emit("run_started", { status: "finalizing", data: { repo, parent_run_dir: parentRunDir } });
  const managerRecords = manifest.managers
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .sort((left, right) => String(left.manager_id).localeCompare(String(right.manager_id)));
  const managerReports = managerRecords.map((manager) => {
    const reportFile = join(String(manager.run_dir), "report.json");
    try {
      return { manager, report_file: reportFile, report: JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown> };
    } catch (error) {
      return { manager, report_file: reportFile, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const failures: string[] = [];
  if (head(repo) !== baseCommit) failures.push("base branch no longer points at the parent-run base commit");
  for (const entry of managerReports) {
    const managerId = String(entry.manager.manager_id);
    const branch = String(entry.manager.branch);
    if ("error" in entry) {
      failures.push(`${managerId} report missing or invalid: ${entry.error}`);
      continue;
    }
    if (!entry.report || !["accepted", "merged"].includes(String(entry.report.status))) failures.push(`${managerId} did not complete successfully`);
    const mergeBase = run(["git", "merge-base", baseCommit, branch], repo, { check: false });
    if (mergeBase.returncode !== 0 || mergeBase.stdout.trim() !== baseCommit) failures.push(`${managerId} branch is not based on ${baseCommit}`);
  }
  if (failures.length) {
    const report: Record<string, unknown> = {
      status: "manager_failed",
      execution_mode: "hierarchical",
      repo,
      run_id: runId,
      base_commit: baseCommit,
      base_unchanged: head(repo) === baseCommit,
      failures,
      managers: managerReports,
      final_transaction: emptyMergeResult(),
      recovery_commands: managerRecords.map((manager) => manager.command)
    };
    const reportPath = resolve(args.jsonReport ?? join(args.runDir!, "report.json"));
    writeJson(reportPath, report);
    events.emit("run_finished", { status: "manager_failed", data: { failures, report: reportPath } });
    finishOutput(args, report, reportPath);
    return 1;
  }
  const results = managerRecords.map((manager) => {
    const result = emptyWorkerResult(String(manager.manager_id));
    result.accepted = true;
    result.reused = true;
    result.branch = String(manager.branch);
    result.worktree = String(manager.worktree);
    result.commit = run(["git", "rev-parse", result.branch], repo).stdout.trim();
    return result;
  });
  const python = choosePython();
  const envPolicy = parseEnvironmentPolicy(args);
  const baseBranch = currentBranch(repo);
  const merge = await transactionalMerge(repo, baseBranch, results, args, python.command, envPolicy);
  const status = merge.merged ? "merged" : merge.error.includes("Final verification failed") ? "final_verification_failed" : "merge_failed";
  const report = {
    ...buildReport({
      status,
      repo,
      baseBranch,
      args,
      workers: [],
      results,
      merge,
      python,
      elapsedSec: merge.elapsed_sec,
      envPolicy,
      workflow: workflowReportContext(workflow, decision, args)
    }),
    managers: managerReports,
    parent_manifest: manifestFile,
    final_transaction: merge,
    recovery_commands: managerRecords.map((manager) => manager.command)
  };
  const reportPath = resolve(args.jsonReport ?? join(args.runDir!, "report.json"));
  writeJson(reportPath, report);
  events.emit("run_finished", { status, data: { report: reportPath, merged: merge.merged } });
  finishOutput(args, report, reportPath);
  return merge.merged ? 0 : 1;
}

function workflowPlanOnly(
  args: CliOptions,
  repo: string,
  workflow: CompiledWorkflow,
  collectedPrework?: Record<string, unknown>,
  planning?: PlanningResult
): number {
  prepareRunPaths(args, repo);
  const decision: ScaleDecision = decideExecutionMode(workflow);
  const events = new EventLogger(args.eventsFile!, args.runId!);
  events.emit("run_started", { status: "planning", data: { repo, execution_mode: decision.execution_mode } });
  const prework = collectedPrework ?? collectPrework(repo, workflow);
  const parentRunDir = resolve(args.parentRunDir ?? args.runDir!);
  mkdirSync(parentRunDir, { recursive: true });
  const preworkFile = join(parentRunDir, "prework.json");
  writeJson(preworkFile, prework);
  const workflowFile = resolveWorkflowPath(repo, args.compiledWorkflow!);
  const managers = buildManagerPlans({
    repo,
    baseRef: currentBranch(repo),
    runId: args.runId!,
    parentRunDir,
    worktreeRoot: join(args.worktreeRoot!, "managers"),
    cliPath: process.argv[1] ?? join(repo, "dist", "src", "cli.js"),
    taskFile: args.taskFile!,
    workflow,
    decision,
    brokerLimits: {
      maxReadonly: args.brokerMaxReadonly,
      maxWrite: args.brokerMaxWrite,
      maxCalls: args.brokerMaxCalls,
      maxCostUsd: args.brokerMaxCostUsd,
      leaseSec: args.brokerLeaseSec
    }
  });
  const manifest = parentManifest({ repo, runId: args.runId!, decision, workflowFile, managers });
  const manifestFile = join(parentRunDir, "parent-run.json");
  writeJson(manifestFile, manifest);
  const report: Record<string, unknown> = {
    status: "planned",
    version: 2,
    repo,
    run_id: args.runId,
    execution_mode: decision.execution_mode,
    scale_decision: decision,
    prework_file: preworkFile,
    planning: planning
      ? { workflow_file: planning.workflow_file, scout_outputs: planning.scout_outputs, usage: planning.usage }
      : { workflow_file: workflowFile, source: "provided_compiled_workflow" },
    parent_manifest: manifestFile,
    global_dag: workflow.nodes,
    manager_subgraphs: managers.map((manager) => ({ manager_id: manager.manager_id, node_ids: manager.node_ids })),
    managers,
    global_limits: {
      readonly_concurrency: args.brokerMaxReadonly,
      write_concurrency: args.brokerMaxWrite,
      claude_calls: args.brokerMaxCalls,
      observed_cost_usd: args.brokerMaxCostUsd,
      lease_sec: args.brokerLeaseSec
    },
    relationships: workflow.nodes.map((node) => ({
      node: node.id,
      kind: node.kind,
      workstream: node.workstream ?? null,
      route: args.workflowNodes[node.id]?.route ?? null,
      verification: args.workflowNodes[node.id]?.verification ?? null
    })),
    recovery_commands: managers.map((manager) => manager.command)
  };
  const reportPath = resolve(args.jsonReport ?? join(args.runDir!, "report.json"));
  writeJson(reportPath, report);
  events.emit("run_finished", { status: "planned", data: { report: reportPath, managers: managers.length } });
  finishOutput(args, report, reportPath);
  return 0;
}

function prepareRunPaths(args: CliOptions, repo: string): void {
  args.runId ??= `${timestamp()}-${Math.random().toString(16).slice(2, 8)}`;
  args.runDir = resolve(args.runDir ?? join(repo, ".git", "hybrid-worker", "runs", args.runId));
  args.worktreeRoot = resolve(args.worktreeRoot ?? join(homedir(), ".codex", "worktrees", "hybrid-worker", args.runId));
  args.eventsFile = resolve(args.eventsFile ?? join(args.runDir, "events.ndjson"));
  mkdirSync(args.runDir, { recursive: true });
  mkdirSync(args.worktreeRoot, { recursive: true });
}

function workflowReportContext(compiled: CompiledWorkflow, decision: ScaleDecision, args: CliOptions): {
  compiled: CompiledWorkflow;
  decision: ScaleDecision;
  manager_id?: string;
  parent_run_dir?: string;
} {
  return {
    compiled,
    decision,
    ...(args.managerId ? { manager_id: args.managerId } : {}),
    ...(args.parentRunDir ? { parent_run_dir: args.parentRunDir } : {})
  };
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
    fakeVerifier: [],
    fakeVerifiers: {},
    fakeRepair: [],
    fakeRepairs: {},
    fakeScout: [],
    fakeScouts: {},
    claudeBin: process.env.CLAUDE_BIN ?? "claude",
    claudeModel: DEFAULT_MODEL,
    permissionMode: DEFAULT_PERMISSION_MODE,
    merge: false,
    forbidPath: [],
    maxChangedFiles: DEFAULT_MAX_CHANGED_FILES,
    maxDiffLines: DEFAULT_MAX_DIFF_LINES,
    workerTimeoutSec: DEFAULT_WORKER_TIMEOUT_SEC,
    testTimeoutSec: DEFAULT_TEST_TIMEOUT_SEC,
    workflowPlanOnly: false,
    brokerMaxReadonly: DEFAULT_BROKER_MAX_READONLY,
    brokerMaxWrite: DEFAULT_BROKER_MAX_WRITE,
    brokerMaxCalls: DEFAULT_BROKER_MAX_CALLS,
    brokerMaxCostUsd: DEFAULT_BROKER_MAX_COST_USD,
    brokerLeaseSec: DEFAULT_BROKER_LEASE_SEC,
    workflowNodes: {}
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
      case "--fake-verifier":
        args.fakeVerifier.push(value());
        break;
      case "--fake-repair":
        args.fakeRepair.push(value());
        break;
      case "--fake-planner":
        args.fakePlanner = value();
        break;
      case "--fake-scout":
        args.fakeScout.push(value());
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
      case "--workflow-seed":
        args.workflowSeed = value();
        break;
      case "--compiled-workflow":
        args.compiledWorkflow = value();
        break;
      case "--workflow-plan-only":
        args.workflowPlanOnly = true;
        break;
      case "--finalize-parent-run":
        args.finalizeParentRun = value();
        break;
      case "--manager-id":
        args.managerId = safeName(value());
        break;
      case "--parent-run-dir":
        args.parentRunDir = value();
        break;
      case "--broker-dir":
        args.brokerDir = value();
        break;
      case "--broker-max-readonly":
        args.brokerMaxReadonly = parsePositiveInt(value(), flag);
        break;
      case "--broker-max-write":
        args.brokerMaxWrite = parsePositiveInt(value(), flag);
        break;
      case "--broker-max-calls":
        args.brokerMaxCalls = parsePositiveInt(value(), flag);
        break;
      case "--broker-max-cost-usd":
        args.brokerMaxCostUsd = parsePositiveNumber(value(), flag);
        break;
      case "--broker-lease-sec":
        args.brokerLeaseSec = parsePositiveNumber(value(), flag);
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

function parsePositiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new CliError(`${flag} must be a positive number`);
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
