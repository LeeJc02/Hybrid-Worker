import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { validateAllowedPathPrefix } from "./artifacts.js";
import { parseNamedValue } from "./parse.js";
import type { CliOptions, ExecutionPhase, PlanPhase, PreflightResult, WorkerPlan, WorkerSpec } from "./types.js";

export function loadWorkerPlan(path: string): WorkerPlan {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const errors = validateWorkerPlan(data);
  if (errors.length) throw new Error(`worker_plan.json schema errors:\n${errors.join("\n")}`);
  return data as unknown as WorkerPlan;
}

export function applyPlanToArgs(args: CliOptions, repo: string): WorkerPlan | null {
  if (!args.planFile) return null;
  const planPath = isAbsolute(args.planFile) ? args.planFile : join(repo, args.planFile);
  const plan = loadWorkerPlan(planPath);
  if (args.runId == null && plan.run_id != null) args.runId = plan.run_id;
  if (plan.model && args.claudeModel === "deepseek-v4-flash") args.claudeModel = plan.model;
  if (plan.shared_setup) args.envSetup.push(...plan.shared_setup);
  for (const phase of plan.phases) {
    appendPhase(args, phase);
  }
  if (plan.final_verification) args.test.push(...plan.final_verification);
  return plan;
}

export function preflight(args: CliOptions, repo: string): PreflightResult {
  const allowedByWorker: Record<string, string[]> = {};
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const item of args.allowedPath) {
    try {
      const [name, path] = parseNamedValue(item, "--allowed-path");
      const error = validateAllowedPathPrefix(path);
      if (error) errors.push(`invalid --allowed-path ${name}:${path}: ${error}`);
      allowedByWorker[name] ??= [];
      allowedByWorker[name]!.push(path.trim());
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const workers: WorkerSpec[] = [];
  for (const item of args.worker) {
    try {
      const [name, rawPath] = parseNamedValue(item, "--worker");
      const ticket = resolve(isAbsolute(rawPath) ? rawPath : join(repo, rawPath));
      workers.push({ name, ticket, allowedPaths: allowedByWorker[name] ?? [] });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const acceptedBranches = Object.fromEntries(args.acceptedBranch.map((item) => parseNamedValue(item, "--accepted-branch")));
  const workerNames = new Set(workers.map((worker) => worker.name));
  const allWorkerNames = new Set([...workerNames, ...Object.keys(acceptedBranches)]);
  const duplicateNames = [...workerNames].filter((name) => name in acceptedBranches).sort();
  if (duplicateNames.length) errors.push(`worker cannot be both --worker and --accepted-branch: ${duplicateNames.join(", ")}`);

  const missingTickets = workers.filter((worker) => !existsSync(worker.ticket)).map((worker) => `${worker.name}:${worker.ticket}`);
  if (missingTickets.length) errors.push(`missing worker ticket file(s): ${missingTickets.join(", ")}`);

  const workerTests: Record<string, string[]> = Object.fromEntries(workers.map((worker) => [worker.name, []]));
  for (const item of args.workerTest) {
    try {
      const [name, command] = parseNamedValue(item, "--worker-test");
      workerTests[name] ??= [];
      workerTests[name]!.push(command);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const unknownTests = Object.keys(workerTests).filter((name) => !workerNames.has(name)).sort();
  if (unknownTests.length) errors.push(`unknown --worker-test worker(s): ${unknownTests.join(", ")}`);
  const unknownAllowed = Object.keys(allowedByWorker).filter((name) => !allWorkerNames.has(name)).sort();
  if (unknownAllowed.length) errors.push(`unknown --allowed-path worker(s): ${unknownAllowed.join(", ")}`);

  warnWorkerRisk(workers, workerTests, warnings);
  if (args.preflightStrict && warnings.length) {
    errors.push(...warnings.map((warning) => `strict preflight: ${warning}`));
  }
  return { ok: errors.length === 0, errors, warnings, workers, workerTests, allowedByWorker };
}

export function buildExecutionPhases(plan: WorkerPlan | null, preflightResult: PreflightResult): ExecutionPhase[] {
  const byName = new Map(preflightResult.workers.map((worker) => [worker.name, worker]));
  if (!plan) {
    return [{ name: "implementation", parallel: true, workers: preflightResult.workers, finalTests: [] }];
  }
  return plan.phases.map((phase) => ({
    name: phase.name,
    parallel: phase.parallel ?? true,
    workers: phase.workers.map((worker) => byName.get(worker.name)).filter((worker): worker is WorkerSpec => worker != null),
    finalTests: [...(phase.final_tests ?? [])]
  }));
}

export function validateWorkerPlan(data: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(data)) return ["worker_plan.json must be a JSON object."];
  if ("run_id" in data && typeof data.run_id !== "string") errors.push("run_id must be a string.");
  if ("model" in data && typeof data.model !== "string") errors.push("model must be a string.");
  validateStringArray(data.shared_setup, "shared_setup", errors, true);
  validateStringArray(data.final_verification, "final_verification", errors, true);
  validateStringArray(data.split_rationale, "split_rationale", errors, true);
  if (!Array.isArray(data.phases) || data.phases.length === 0) {
    errors.push("phases must be a non-empty array.");
    return errors;
  }

  const seenWorkers = new Set<string>();
  data.phases.forEach((phase, phaseIndex) => {
    const phaseLabel = `phases[${phaseIndex}]`;
    if (!isRecord(phase)) {
      errors.push(`${phaseLabel} must be an object.`);
      return;
    }
    if (typeof phase.name !== "string" || !phase.name.trim()) errors.push(`${phaseLabel}.name must be a non-empty string.`);
    if ("parallel" in phase && typeof phase.parallel !== "boolean") errors.push(`${phaseLabel}.parallel must be a boolean.`);
    validateStringArray(phase.final_tests, `${phaseLabel}.final_tests`, errors, true);
    if (!Array.isArray(phase.workers) || phase.workers.length === 0) {
      errors.push(`${phaseLabel}.workers must be a non-empty array.`);
      return;
    }
    phase.workers.forEach((worker, workerIndex) => {
      const workerLabel = `${phaseLabel}.workers[${workerIndex}]`;
      if (!isRecord(worker)) {
        errors.push(`${workerLabel} must be an object.`);
        return;
      }
      if (typeof worker.name !== "string" || !worker.name.trim()) {
        errors.push(`${workerLabel}.name must be a non-empty string.`);
      } else if (seenWorkers.has(worker.name)) {
        errors.push(`duplicate worker name in plan: ${worker.name}`);
      } else {
        seenWorkers.add(worker.name);
      }
      if (typeof worker.ticket !== "string" || !worker.ticket.trim()) errors.push(`${workerLabel}.ticket must be a non-empty string.`);
      validateStringArray(worker.allowed_paths, `${workerLabel}.allowed_paths`, errors, true);
      validateStringArray(worker.worker_tests, `${workerLabel}.worker_tests`, errors, true);
    });
  });
  return errors;
}

function appendPhase(args: CliOptions, phase: PlanPhase): void {
  for (const worker of phase.workers) {
    args.worker.push(`${worker.name}:${worker.ticket}`);
    for (const path of worker.allowed_paths ?? []) args.allowedPath.push(`${worker.name}:${path}`);
    for (const test of worker.worker_tests ?? []) args.workerTest.push(`${worker.name}:${test}`);
  }
}

function warnWorkerRisk(workers: WorkerSpec[], workerTests: Record<string, string[]>, warnings: string[]): void {
  for (const worker of workers) {
    if (worker.allowedPaths.length === 0) warnings.push(`worker ${worker.name} has no explicit allowed paths`);
    if (worker.allowedPaths.some((path) => normalizeScope(path) === "." || normalizeScope(path) === "*")) warnings.push(`worker ${worker.name} uses broad allowed path`);
    if ((workerTests[worker.name] ?? []).length === 0) warnings.push(`worker ${worker.name} has no focused worker tests`);
  }
  for (let leftIndex = 0; leftIndex < workers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < workers.length; rightIndex += 1) {
      const left = workers[leftIndex]!;
      const right = workers[rightIndex]!;
      for (const leftPath of left.allowedPaths) {
        for (const rightPath of right.allowedPaths) {
          if (pathsOverlap(leftPath, rightPath)) warnings.push(`allowed path overlap: ${left.name}:${leftPath} overlaps ${right.name}:${rightPath}`);
        }
      }
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  return a === "." || a === "*" || b === "." || b === "*" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizeScope(path: string): string {
  return path.trim().replace(/\/+$/, "") || ".";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStringArray(value: unknown, label: string, errors: string[], optional = false): void {
  if (value == null && optional) return;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings.`);
    return;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") errors.push(`${label}[${index}] must be a string.`);
  }
}
