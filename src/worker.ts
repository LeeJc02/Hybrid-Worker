import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_MODEL, PASS_MARKER } from "./constants.js";
import { cleanupGeneratedNoise, diffLineCount, generatedArtifactFindings, pathAllowed, restoreUnownedScaffoldChanges } from "./artifacts.js";
import { commitIfNeeded, collectEvidence, createWorktree, baseWorktreeDirty } from "./git.js";
import { writeJson } from "./json.js";
import { implementerPrompt, prepareWorkerPromptFiles, repairPrompt, sanitizeWorkerText, verifierPrompt } from "./prompt.js";
import { run, runCommandSequence, runToLog, shellRun } from "./process.js";
import {
  normalizeDecisionSchema,
  normalizeSummarySchema,
  readNormalizedJson,
  validateDecisionSchema,
  validateSummarySchema
} from "./schema.js";
import { claudeResultText, combineUsage, parseClaudePayloadFromLog, parseClaudeUsage } from "./usage.js";
import { notObservedUsage, shellEnv, workerEnvironmentSetupCommands } from "./env.js";
import { addFinding, addSchemaFindings, finding, hasHardFindings } from "./findings.js";
import { ResourceBroker, type BrokerLease } from "./broker.js";
import type { CliOptions, EnvironmentPolicy, StageResult, Usage, WorkerResult, WorkerSpec } from "./types.js";

export function emptyWorkerResult(name: string): WorkerResult {
  return {
    name,
    branch: "",
    worktree: "",
    accepted: false,
    merged: false,
    reused: false,
    commit: null,
    changed_paths: [],
    findings: [],
    finding_details: [],
    implementer: null,
    verification: [],
    repair: null,
    verification_votes: null,
    pilot: false,
    batch: null,
    blocked: false,
    test_returncode: null,
    summary_file: "",
    decision_file: "",
    diff_file: "",
    diffstat_file: "",
    test_log_file: "",
    elapsed_sec: 0,
    usage: notObservedUsage("worker did not run live Claude stage"),
    codex_fallback_applied: false,
    codex_fallback_log_file: "",
    exception: ""
  };
}

export function claudeCmd(args: CliOptions, model = args.claudeModel): string[] {
  return [
    args.claudeBin,
    "-p",
    "--output-format",
    "json",
    "--disable-slash-commands",
    "--model",
    model,
    "--no-session-persistence",
    "--permission-mode",
    args.permissionMode
  ];
}

export async function runStage(
  stage: string,
  worker: WorkerSpec,
  prompt: string,
  worktree: string,
  runDir: string,
  env: NodeJS.ProcessEnv,
  args: CliOptions,
  modelOverride?: string,
  routeOverride?: "fast" | "balanced" | "deep"
): Promise<StageResult> {
  const logFile = join(runDir, `${worker.name}.${stage}.log`);
  const usageFile = join(runDir, `${worker.name}.${stage}.usage.json`);
  const resultFile = join(runDir, `${worker.name}.${stage}.result.txt`);
  let code: number;
  let elapsedSec: number;
  let usage: Usage;
  const broker = args.brokerDir
    ? new ResourceBroker(args.brokerDir, {
        maxReadonly: args.brokerMaxReadonly,
        maxWrite: args.brokerMaxWrite,
        maxCalls: args.brokerMaxCalls,
        maxCostUsd: args.brokerMaxCostUsd,
        leaseSec: args.brokerLeaseSec
      })
    : null;
  let lease: BrokerLease | null = null;
  let renewTimer: NodeJS.Timeout | null = null;
  try {
    if (broker) {
      lease = await broker.acquire(stage.startsWith("verifier") ? "readonly" : "write", `${args.runId}:${worker.name}:${stage}`, args.workerTimeoutSec);
      renewTimer = setInterval(() => broker.renew(lease!.id), Math.max(1000, (args.brokerLeaseSec * 1000) / 2));
    }
    if (args.executor === "fake-command") {
      const command = fakeStageCommand(args, worker.name, stage);
      if (!command) throw new Error(`Missing fake ${stage} command for worker ${worker.name}`);
      const result = await runToLog(["/bin/sh", "-lc", command], worktree, logFile, { env, timeoutSec: args.workerTimeoutSec });
      code = result.returncode;
      elapsedSec = result.elapsedSec;
      usage = notObservedUsage("fake executor");
      writeFileSync(resultFile, readFileSync(logFile, "utf8"), "utf8");
    } else {
      const result = await runToLog(claudeCmd(args, modelOverride ?? worker.model), worktree, logFile, { inputText: prompt, env, timeoutSec: args.workerTimeoutSec });
      code = result.returncode;
      elapsedSec = result.elapsedSec;
      const payload = parseClaudePayloadFromLog(logFile);
      usage = parseClaudeUsage(payload);
      writeFileSync(resultFile, claudeResultText(payload), "utf8");
    }
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (broker && lease) broker.release(lease.id, observedCost(usage!));
  }
  writeJson(usageFile, usage);
  const markerFound = readFileSync(resultFile, "utf8").includes(PASS_MARKER) || readFileSync(logFile, "utf8").includes(PASS_MARKER);
  return {
    stage,
    returncode: code,
    log_file: logFile,
    marker_found: markerFound,
    elapsed_sec: elapsedSec,
    usage,
    usage_file: usageFile,
    result_file: resultFile,
    ...(lease ? { broker_wait_sec: lease.wait_sec } : {}),
    ...(routeOverride ?? worker.route ? { model_route: routeOverride ?? worker.route } : {}),
    ...(modelOverride ?? worker.model ? { model: modelOverride ?? worker.model } : {})
  };
}

function fakeStageCommand(args: CliOptions, worker: string, stage: string): string | undefined {
  if (stage.startsWith("verifier")) return args.fakeVerifiers[worker];
  if (stage === "repair") return args.fakeRepairs[worker];
  return args.fakeImplementers[worker];
}

function observedCost(usage: Usage): number {
  return typeof usage.total_cost_usd === "number" ? usage.total_cost_usd : 0;
}

export async function runWorker(input: {
  worker: WorkerSpec;
  repo: string;
  baseBranch: string;
  taskText: string;
  workerTests: string[];
  allowedPaths: string[];
  runDir: string;
  args: CliOptions;
  pythonCommand: string;
  envPolicy: EnvironmentPolicy;
}): Promise<WorkerResult> {
  const started = performance.now();
  const result = emptyWorkerResult(input.worker.name);
  try {
    const created = createWorktree(input.repo, input.worker.name, input.baseBranch, input.args.runId!, input.args.worktreeRoot!);
    result.branch = created.branch;
    result.worktree = created.worktree;
    const dirtyBefore = baseWorktreeDirty(input.repo);
    if (dirtyBefore) throw new Error(`Base worktree became dirty before worker start:\n${dirtyBefore}`);
    const env = shellEnv({
      base: process.env,
      pythonCommand: input.pythonCommand,
      worker: input.worker.name,
      runId: input.args.runId!,
      artifactsDir: input.runDir,
      worktree: created.worktree,
      baseRepo: input.repo,
      allowedPaths: input.allowedPaths,
      workerTests: input.workerTests
    });
    const workerTaskText = sanitizeWorkerText(input.taskText, input.repo, created.worktree);
    const ticketText = sanitizeWorkerText(readFileSync(input.worker.ticket, "utf8"), input.repo, created.worktree);
    const promptFiles = prepareWorkerPromptFiles(created.worktree, input.worker, workerTaskText, ticketText);
    const prompt = implementerPrompt({
      taskPath: promptFiles.taskPath,
      ticketPath: promptFiles.ticketPath,
      worker: input.worker,
      tests: input.workerTests,
      allowedPaths: input.allowedPaths,
      worktree: created.worktree,
      baseRepo: input.repo,
      independentReview: input.worker.verification != null
    });
    result.implementer = await runStage("implementer", input.worker, prompt, created.worktree, input.runDir, env, input.args);
    result.usage = combineUsage([result.implementer.usage]);

    const dirtyAfter = baseWorktreeDirty(input.repo);
    if (dirtyAfter) addFinding(result, finding("base_repo_dirty", `Base worktree was modified during worker run; worker likely wrote outside its isolated worktree:\n${dirtyAfter}`));

    const summaryFile = join(input.runDir, `${input.worker.name}.worker_summary.json`);
    result.summary_file = summaryFile;
    const worktreeSummary = join(created.worktree, "worker_summary.json");
    if (!existsSync(summaryFile) && existsSync(worktreeSummary)) copyFileSync(worktreeSummary, summaryFile);
    cleanupGeneratedNoise(created.worktree);
    restoreUnownedScaffoldChanges(created.worktree, input.allowedPaths);
    if (result.implementer.returncode !== 0) addFinding(result, finding("implementer_failed", `Implementer exited ${result.implementer.returncode}.`, { stage: "implementer" }));
    if (!result.implementer.marker_found) addFinding(result, finding("missing_marker", `Missing ${PASS_MARKER}.`, { stage: "implementer" }));

    const testLog = join(input.runDir, `${input.worker.name}.tests.log`);
    result.test_log_file = testLog;
    const setupCommands = workerEnvironmentSetupCommands(input.envPolicy, input.worker.name, created.worktree, input.workerTests);
    result.test_returncode = await runCommandSequence(setupCommands, input.workerTests, created.worktree, testLog, env, input.args.testTimeoutSec);
    cleanupGeneratedNoise(created.worktree);
    if (result.test_returncode !== null && result.test_returncode !== 0) {
      addFinding(result, finding("tests_failed", `Worker environment setup/tests failed with exit code ${result.test_returncode}.`, { stage: "worker_tests" }));
    }

    const diffFile = join(input.runDir, `${input.worker.name}.diff`);
    const diffstatFile = join(input.runDir, `${input.worker.name}.diffstat`);
    result.diff_file = diffFile;
    result.diffstat_file = diffstatFile;
    let evidence = collectEvidence(created.worktree, input.baseBranch, diffFile, diffstatFile);
    result.changed_paths = evidence.changed;

    if (!existsSync(summaryFile)) addFinding(result, finding("missing_summary", "Missing worker_summary.json.", { stage: "summary" }));
    else {
      try {
        addSchemaFindings(result, "summary_schema_invalid", validateSummarySchema(readNormalizedJson(summaryFile, normalizeSummarySchema)), "summary");
      } catch (error) {
        addFinding(result, finding("summary_invalid_json", `Invalid worker_summary.json: ${error instanceof Error ? error.message : String(error)}`, { stage: "summary" }));
      }
    }

    if (input.worker.verification) {
      return await finishV2Worker({
        input,
        result,
        created,
        env,
        setupCommands,
        summaryFile,
        testLog,
        diffFile,
        diffstatFile,
        started
      });
    }

    if (hasHardFindings(result) && !input.args.codexFallbackCommand) return finishFailure(result, input.runDir, started);

    const decisionFile = join(input.runDir, `${input.worker.name}.reviewer_decision.json`);
    result.decision_file = decisionFile;
    const worktreeDecision = join(created.worktree, "reviewer_decision.json");
    if (!existsSync(decisionFile) && existsSync(worktreeDecision)) copyFileSync(worktreeDecision, decisionFile);
    cleanupGeneratedNoise(created.worktree);
    restoreUnownedScaffoldChanges(created.worktree, input.allowedPaths);

    evidence = collectEvidence(created.worktree, input.baseBranch, diffFile, diffstatFile);
    result.changed_paths = evidence.changed;
    gateDiff(result, evidence.diff, input.allowedPaths, input.args);
    if (!existsSync(decisionFile)) addFinding(result, finding("missing_decision", "Missing reviewer_decision.json.", { stage: "decision" }));
    else {
      try {
        addSchemaFindings(result, "decision_schema_invalid", validateDecisionSchema(readNormalizedJson(decisionFile, normalizeDecisionSchema)), "decision");
      } catch (error) {
        addFinding(result, finding("decision_invalid_json", `Invalid reviewer_decision.json: ${error instanceof Error ? error.message : String(error)}`, { stage: "decision" }));
      }
    }

    if (result.findings.length && input.args.codexFallbackCommand) {
      const ok = await runCodexFallback(input.worker, created.worktree, input.runDir, env, input.args, result.findings, result);
      if (ok) {
        result.findings = [];
        result.finding_details = [];
        const worktreeSummaryAfterFallback = join(created.worktree, "worker_summary.json");
        if (!existsSync(summaryFile) && existsSync(worktreeSummaryAfterFallback)) copyFileSync(worktreeSummaryAfterFallback, summaryFile);
        const worktreeDecisionAfterFallback = join(created.worktree, "reviewer_decision.json");
        if (!existsSync(decisionFile) && existsSync(worktreeDecisionAfterFallback)) copyFileSync(worktreeDecisionAfterFallback, decisionFile);
        result.test_returncode = await runCommandSequence(setupCommands, input.workerTests, created.worktree, testLog, env, input.args.testTimeoutSec);
        cleanupGeneratedNoise(created.worktree);
        restoreUnownedScaffoldChanges(created.worktree, input.allowedPaths);
        evidence = collectEvidence(created.worktree, input.baseBranch, diffFile, diffstatFile);
        result.changed_paths = evidence.changed;
        if (result.test_returncode !== null && result.test_returncode !== 0) addFinding(result, finding("tests_failed", `Codex fallback environment setup/tests failed with exit code ${result.test_returncode}.`, { stage: "fallback_tests" }));
        if (!evidence.diff.trim()) addFinding(result, finding("codex_fallback_no_diff", "Codex fallback produced no diff.", { stage: "fallback" }));
        if (!existsSync(summaryFile)) addFinding(result, finding("missing_summary", "Missing worker_summary.json after fallback.", { stage: "fallback_summary" }));
        else {
          try {
            addSchemaFindings(result, "summary_schema_invalid", validateSummarySchema(readNormalizedJson(summaryFile, normalizeSummarySchema)), "fallback_summary");
          } catch (error) {
            addFinding(result, finding("summary_invalid_json", `Invalid worker_summary.json after fallback: ${error instanceof Error ? error.message : String(error)}`, { stage: "fallback_summary" }));
          }
        }
        if (!existsSync(decisionFile)) addFinding(result, finding("missing_decision", "Missing reviewer_decision.json after fallback.", { stage: "fallback_decision" }));
        else {
          try {
            addSchemaFindings(result, "decision_schema_invalid", validateDecisionSchema(readNormalizedJson(decisionFile, normalizeDecisionSchema)), "fallback_decision");
          } catch (error) {
            addFinding(result, finding("decision_invalid_json", `Invalid reviewer_decision.json after fallback: ${error instanceof Error ? error.message : String(error)}`, { stage: "fallback_decision" }));
          }
        }
        gateDiff(result, evidence.diff, input.allowedPaths, input.args, " after fallback");
      }
    }

    if (result.findings.length === 0) {
      result.commit = commitIfNeeded(created.worktree, input.worker.name);
      result.accepted = true;
    } else {
      writeWorkerFailureJson(input.runDir, result);
    }
    result.elapsed_sec = (performance.now() - started) / 1000;
    return result;
  } catch (error) {
    addFinding(result, finding("worker_crashed", `Worker crashed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`));
    result.exception = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    result.elapsed_sec = (performance.now() - started) / 1000;
    writeWorkerFailureJson(input.runDir, result);
    return result;
  }
}

async function finishV2Worker(context: {
  input: {
    worker: WorkerSpec;
    repo: string;
    baseBranch: string;
    taskText: string;
    workerTests: string[];
    allowedPaths: string[];
    runDir: string;
    args: CliOptions;
    pythonCommand: string;
    envPolicy: EnvironmentPolicy;
  };
  result: WorkerResult;
  created: { branch: string; worktree: string };
  env: NodeJS.ProcessEnv;
  setupCommands: string[];
  summaryFile: string;
  testLog: string;
  diffFile: string;
  diffstatFile: string;
  started: number;
}): Promise<WorkerResult> {
  const { input, result, created } = context;
  refreshV2Evidence(context, false);
  let repaired = false;
  if (result.findings.length) {
    if (hasUnrepairableV2Finding(result) || !(await runV2Repair(context, result.findings))) return finishFailure(result, input.runDir, context.started);
    repaired = true;
    await rerunV2DeterministicGates(context);
  }
  if (result.findings.length === 0) {
    const verification = await runV2Verification(context, repaired ? 2 : 1);
    if (!verification.passed) {
      addFinding(result, finding("verifier_failed", `Independent verification failed: ${verification.issues.join("; ")}`, { stage: "verification" }));
      if (!repaired && (await runV2Repair(context, verification.issues))) {
        repaired = true;
        await rerunV2DeterministicGates(context);
        if (result.findings.length === 0) {
          const retry = await runV2Verification(context, 2);
          if (!retry.passed) addFinding(result, finding("verifier_failed", `Independent verification failed after repair: ${retry.issues.join("; ")}`, { stage: "verification" }));
        }
      }
    }
  }
  result.usage = combineUsage([
    ...(result.implementer ? [result.implementer.usage] : []),
    ...result.verification.map((stage) => stage.usage),
    ...(result.repair ? [result.repair.usage] : [])
  ]);
  if (result.findings.length === 0) {
    result.commit = commitIfNeeded(created.worktree, input.worker.name);
    result.accepted = true;
  } else {
    writeWorkerFailureJson(input.runDir, result);
  }
  result.elapsed_sec = (performance.now() - context.started) / 1000;
  return result;
}

async function rerunV2DeterministicGates(context: Parameters<typeof finishV2Worker>[0]): Promise<void> {
  const { input, result, created } = context;
  result.findings = [];
  result.finding_details = [];
  result.test_returncode = await runCommandSequence(
    context.setupCommands,
    input.workerTests,
    created.worktree,
    context.testLog,
    context.env,
    input.args.testTimeoutSec
  );
  cleanupGeneratedNoise(created.worktree);
  if (result.test_returncode !== null && result.test_returncode !== 0) {
    addFinding(result, finding("tests_failed", `Worker tests failed after repair with exit code ${result.test_returncode}.`, { stage: "repair_tests" }));
  }
  validateV2Summary(result, context.summaryFile, "repair_summary");
  refreshV2Evidence(context, false);
}

function refreshV2Evidence(context: Parameters<typeof finishV2Worker>[0], clear = false): void {
  const { input, result, created } = context;
  if (clear) {
    result.findings = [];
    result.finding_details = [];
  }
  cleanupGeneratedNoise(created.worktree);
  restoreUnownedScaffoldChanges(created.worktree, input.allowedPaths);
  const evidence = collectEvidence(created.worktree, input.baseBranch, context.diffFile, context.diffstatFile);
  result.changed_paths = evidence.changed;
  gateDiff(result, evidence.diff, input.allowedPaths, input.args);
}

function validateV2Summary(result: WorkerResult, summaryFile: string, stage: string): void {
  if (!existsSync(summaryFile)) {
    addFinding(result, finding("missing_summary", "Missing worker_summary.json.", { stage }));
    return;
  }
  try {
    addSchemaFindings(result, "summary_schema_invalid", validateSummarySchema(readNormalizedJson(summaryFile, normalizeSummarySchema)), stage);
  } catch (error) {
    addFinding(result, finding("summary_invalid_json", `Invalid worker_summary.json: ${error instanceof Error ? error.message : String(error)}`, { stage }));
  }
}

async function runV2Repair(context: Parameters<typeof finishV2Worker>[0], issues: string[]): Promise<boolean> {
  const { input, result, created } = context;
  if (input.args.executor === "fake-command" && !input.args.fakeRepairs[input.worker.name]) return false;
  try {
    const stage = await runStage(
      "repair",
      input.worker,
      repairPrompt({ worker: input.worker.name, worktree: created.worktree, issues }),
      created.worktree,
      input.runDir,
      { ...context.env, CPW_REPAIR_ISSUES: JSON.stringify(issues) },
      input.args,
      "opus",
      "deep"
    );
    result.repair = stage;
    if (stage.returncode !== 0 || !stage.marker_found) {
      addFinding(result, finding("repair_failed", `Deep repair failed for ${input.worker.name}.`, { stage: "repair" }));
      return false;
    }
    return true;
  } catch (error) {
    addFinding(result, finding("repair_failed", `Deep repair crashed: ${error instanceof Error ? error.message : String(error)}`, { stage: "repair" }));
    return false;
  }
}

async function runV2Verification(
  context: Parameters<typeof finishV2Worker>[0],
  round: number
): Promise<{ passed: boolean; issues: string[] }> {
  const { input, result, created } = context;
  const policy = input.worker.verification!;
  const decisionFile = join(input.runDir, `${input.worker.name}.reviewer_decision.json`);
  result.decision_file = decisionFile;
  if (policy.verifier_count === 0) {
    writeJson(decisionFile, harnessDecision(input.worker.name, "PASS", []));
    result.verification_votes = { passed: 0, required: 0, total: 0 };
    return { passed: true, issues: [] };
  }
  let passed = 0;
  const issues: string[] = [];
  for (let index = 0; index < policy.verifier_count; index += 1) {
    const verifierDecisionFile = join(input.runDir, `${input.worker.name}.verifier-${round}-${index + 1}.json`);
    const before = worktreeFingerprint(created.worktree);
    let stage: StageResult;
    try {
      stage = await runStage(
        `verifier-r${round}-${index + 1}`,
        input.worker,
        verifierPrompt({
          worker: input.worker.name,
          worktree: created.worktree,
          diffFile: context.diffFile,
          testLogFile: context.testLog,
          decisionFile: verifierDecisionFile
        }),
        created.worktree,
        input.runDir,
        { ...context.env, CPW_DECISION_FILE: verifierDecisionFile },
        input.args,
        policy.route === "deep" ? "opus" : "sonnet",
        policy.route
      );
      result.verification.push(stage);
    } catch (error) {
      issues.push(`verifier ${index + 1} crashed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const after = worktreeFingerprint(created.worktree);
    if (after !== before) {
      issues.push(`verifier ${index + 1} modified the worktree`);
      addFinding(result, finding("verifier_modified_worktree", `Verifier ${index + 1} modified the worker worktree.`, { stage: stage.stage }));
      continue;
    }
    if (stage.returncode !== 0 || !stage.marker_found || !existsSync(verifierDecisionFile)) {
      issues.push(`verifier ${index + 1} did not produce a passing decision`);
      continue;
    }
    try {
      const decision = readNormalizedJson(verifierDecisionFile, normalizeDecisionSchema);
      const errors = validateDecisionSchema(decision);
      if (errors.length === 0) passed += 1;
      else issues.push(...errors.map((message) => `verifier ${index + 1}: ${message}`));
    } catch (error) {
      issues.push(`verifier ${index + 1} decision is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const accepted = passed >= policy.required_passes && !result.finding_details.some((item) => item.code === "verifier_modified_worktree");
  result.verification_votes = { passed, required: policy.required_passes, total: policy.verifier_count };
  writeJson(decisionFile, harnessDecision(input.worker.name, accepted ? "PASS" : "FAIL", issues));
  return { passed: accepted, issues };
}

function harnessDecision(worker: string, decision: "PASS" | "FAIL", issues: string[]): Record<string, unknown> {
  return {
    worker,
    decision,
    issues_found: issues,
    fixes_applied: [],
    tests_run: [],
    tests_passed: decision === "PASS",
    merge_risk: decision === "PASS" ? "low" : "high",
    source: "hybrid-worker-v2-harness"
  };
}

function worktreeFingerprint(worktree: string): string {
  return `${run(["git", "status", "--porcelain"], worktree, { check: false }).stdout}\n${run(["git", "diff", "--binary"], worktree, { check: false }).stdout}`;
}

function hasUnrepairableV2Finding(result: WorkerResult): boolean {
  return result.finding_details.some((item) => item.code === "implementer_failed" || item.code === "missing_marker" || item.code === "base_repo_dirty");
}

export function reusedWorkerResult(
  name: string,
  branch: string,
  repo: string,
  baseBranch: string,
  runDir: string,
  allowedPaths: string[],
  args: CliOptions
): WorkerResult {
  const result = emptyWorkerResult(name);
  result.branch = branch;
  result.accepted = true;
  result.reused = true;
  if (run(["git", "rev-parse", "--verify", "--quiet", branch], repo, { check: false }).returncode !== 0) {
    result.accepted = false;
    addFinding(result, finding("accepted_branch_missing", `Accepted branch does not exist: ${branch}`));
    return result;
  }
  result.commit = run(["git", "rev-parse", branch], repo).stdout.trim();
  const diffFile = join(runDir, `${name}.reused.diff`);
  const diffstatFile = join(runDir, `${name}.reused.diffstat`);
  const diff = run(["git", "diff", "--binary", `${baseBranch}...${branch}`], repo, { check: false }).stdout;
  writeFileSync(diffFile, diff, "utf8");
  writeFileSync(diffstatFile, run(["git", "diff", "--stat", `${baseBranch}...${branch}`], repo, { check: false }).stdout, "utf8");
  result.changed_paths = run(["git", "diff", "--name-only", `${baseBranch}...${branch}`], repo, { check: false }).stdout.split(/\r?\n/).filter(Boolean).sort();
  result.diff_file = diffFile;
  result.diffstat_file = diffstatFile;
  gateDiff(result, diff, allowedPaths, args);
  result.accepted = result.findings.length === 0;
  return result;
}

function gateDiff(result: WorkerResult, diff: string, allowedPaths: string[], args: CliOptions, suffix = ""): void {
  if (!diff.trim()) addFinding(result, finding(suffix ? "codex_fallback_no_diff" : "no_diff", suffix ? `Codex fallback produced no diff.` : "Worker produced no diff."));
  if (result.changed_paths.length > args.maxChangedFiles) addFinding(result, finding("changed_file_count_exceeded", `Changed file count ${result.changed_paths.length} exceeds ${args.maxChangedFiles}.`));
  const lines = diffLineCount(diff);
  if (lines > args.maxDiffLines) addFinding(result, finding("diff_line_count_exceeded", `Diff line count ${lines} exceeds ${args.maxDiffLines}.`));
  for (const forbidden of args.forbidPath) {
    const prefix = `${forbidden.replace(/\/+$/, "")}/`;
    for (const path of result.changed_paths) {
      if (path === forbidden || path.startsWith(prefix)) addFinding(result, finding("forbidden_path_changed", `Forbidden path changed${suffix}: ${path}`, { path }));
    }
  }
  for (const message of generatedArtifactFindings(result.changed_paths)) {
    const path = message.slice("Generated/intermediate artifact changed: ".length);
    addFinding(result, finding("generated_artifact_changed", message, { path }));
  }
  for (const path of result.changed_paths) {
    if (!pathAllowed(path, allowedPaths)) addFinding(result, finding("out_of_scope_change", `Changed path outside allowed scope${suffix}: ${path}`, { path }));
  }
}

async function runCodexFallback(
  worker: WorkerSpec,
  worktree: string,
  runDir: string,
  env: NodeJS.ProcessEnv,
  args: CliOptions,
  findings: string[],
  result: WorkerResult
): Promise<boolean> {
  if (!args.codexFallbackCommand) return false;
  const logFile = join(runDir, `${worker.name}.codex-fallback.log`);
  const fallbackEnv = { ...env, CPW_FINDINGS: findings.join("\n") };
  const code = await shellRun(args.codexFallbackCommand, worktree, fallbackEnv, logFile, args.workerTimeoutSec);
  result.codex_fallback_applied = code === 0;
  result.codex_fallback_log_file = logFile;
  return code === 0;
}

function finishFailure(result: WorkerResult, runDir: string, started: number): WorkerResult {
  result.elapsed_sec = (performance.now() - started) / 1000;
  writeWorkerFailureJson(runDir, result);
  return result;
}

function writeWorkerFailureJson(runDir: string, result: WorkerResult): void {
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, `${result.name}.failure.json`), {
    worker: result.name,
    accepted: result.accepted,
    merged: result.merged,
    reused: result.reused,
    branch: result.branch,
    commit: result.commit,
    findings: result.findings,
    finding_details: result.finding_details,
    changed_paths: result.changed_paths,
    test_returncode: result.test_returncode,
    implementer: result.implementer,
    usage: result.usage,
    logs: {
      summary_file: result.summary_file,
      decision_file: result.decision_file,
      diff_file: result.diff_file,
      diffstat_file: result.diffstat_file,
      test_log_file: result.test_log_file,
      codex_fallback_log_file: result.codex_fallback_log_file
    },
    exception: result.exception
  });
}
