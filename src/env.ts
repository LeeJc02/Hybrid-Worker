import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CACHE_ROOT } from "./constants.js";
import type { CliOptions, EnvironmentPolicy, PythonChoice } from "./types.js";
import { parseNamedValue } from "./parse.js";
import { run } from "./process.js";

export function notObservedUsage(reason = "") {
  return reason ? { status: "not_observed" as const, reason } : { status: "not_observed" as const };
}

export function sharedCachePolicy(): Record<string, string> {
  return {
    PIP_CACHE_DIR: join(CACHE_ROOT, "pip"),
    npm_config_cache: join(CACHE_ROOT, "npm"),
    UV_CACHE_DIR: join(CACHE_ROOT, "uv")
  };
}

export function applySharedCacheEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const updated: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(sharedCachePolicy())) {
    mkdirSync(value, { recursive: true });
    updated[key] ??= value;
  }
  updated.PIP_DISABLE_PIP_VERSION_CHECK ??= "1";
  updated.PIP_NO_INPUT ??= "1";
  updated.NPM_CONFIG_AUDIT ??= "false";
  updated.NPM_CONFIG_FUND ??= "false";
  return updated;
}

export function shellEnv(input: {
  base: NodeJS.ProcessEnv;
  pythonCommand: string;
  worker: string;
  runId: string;
  artifactsDir: string;
  worktree?: string;
  baseRepo?: string;
  allowedPaths?: string[];
  workerTests?: string[];
}): NodeJS.ProcessEnv {
  const env = applySharedCacheEnv({ ...input.base });
  env.PYTHON = input.pythonCommand;
  env.CPW_WORKER = input.worker;
  env.CPW_RUN_ID = input.runId;
  env.CPW_ARTIFACTS_DIR = input.artifactsDir;
  env.CPW_SUMMARY_FILE = join(input.artifactsDir, `${input.worker}.worker_summary.json`);
  env.CPW_DECISION_FILE = join(input.artifactsDir, `${input.worker}.reviewer_decision.json`);
  if (input.worktree != null) {
    env.CPW_WORKTREE = input.worktree;
    env.CPW_EXPECTED_GIT_ROOT = input.worktree;
  }
  if (input.baseRepo != null) env.CPW_BASE_REPO = input.baseRepo;
  if (input.allowedPaths != null) env.CPW_ALLOWED_PATHS = JSON.stringify(input.allowedPaths);
  if (input.workerTests != null) env.CPW_WORKER_TESTS = JSON.stringify(input.workerTests);
  return env;
}

export function choosePython(): PythonChoice {
  const conda = which("conda");
  if (conda) {
    const probe = run([conda, "run", "-n", "base", "python", "--version"], process.cwd(), { check: false });
    if (probe.returncode === 0) return { command: `${conda} run -n base python`, fallbackUsed: false, source: "conda-base" };
  }
  const python3 = which("python3");
  if (python3) return { command: python3, fallbackUsed: true, source: "python3" };
  const python = which("python");
  if (python) return { command: python, fallbackUsed: true, source: "python" };
  throw new Error("No Python interpreter found via conda base, python3, or python.");
}

export function parseEnvironmentPolicy(args: CliOptions): EnvironmentPolicy {
  const workerSetup: Record<string, string[]> = {};
  for (const item of args.workerEnvSetup) {
    const [name, command] = parseNamedValue(item, "--worker-env-setup");
    workerSetup[name] ??= [];
    workerSetup[name]!.push(command);
  }
  return {
    commonSetup: [...args.envSetup],
    finalSetup: [...args.finalEnvSetup],
    workerSetup,
    autoSetupEnabled: !args.noAutoEnvSetup
  };
}

export function workerEnvironmentSetupCommands(policy: EnvironmentPolicy, worker: string, cwd: string, tests: string[]): string[] {
  return [
    ...policy.commonSetup,
    ...(policy.workerSetup[worker] ?? []),
    ...(policy.autoSetupEnabled ? autoEnvironmentSetupCommands(cwd, tests) : [])
  ];
}

export function finalEnvironmentSetupCommands(policy: EnvironmentPolicy, cwd: string, tests: string[]): string[] {
  return [
    ...policy.commonSetup,
    ...policy.finalSetup,
    ...(policy.autoSetupEnabled ? autoEnvironmentSetupCommands(cwd, tests) : [])
  ];
}

export function npmPrefixesFromCommand(command: string): string[] {
  const parts = shellSplit(command);
  const prefixes = new Set<string>();
  let sawNpm = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === "npm") sawNpm = true;
    if (part === "--prefix" && parts[index + 1]) prefixes.add(parts[index + 1]!);
    else if (part.startsWith("--prefix=")) prefixes.add(part.slice("--prefix=".length));
    else if (part === "-C" && parts[index + 1]) prefixes.add(parts[index + 1]!);
  }
  if (sawNpm && prefixes.size === 0) prefixes.add(".");
  return [...prefixes].filter((prefix) => !prefix.startsWith("/") && !prefix.split(/[\\/]+/).includes(".."));
}

export function autoEnvironmentSetupCommands(cwd: string, tests: string[]): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  for (const command of tests) {
    for (const prefix of npmPrefixesFromCommand(command).sort()) {
      if (!existsSync(join(cwd, prefix, "package.json"))) continue;
      const prefixArg = shellQuotePath(prefix);
      const install = existsSync(join(cwd, prefix, "package-lock.json"))
        ? `npm --prefix ${prefixArg} ci --no-audit --no-fund`
        : `npm --prefix ${prefixArg} install --no-audit --no-fund`;
      if (!seen.has(install)) {
        seen.add(install);
        commands.push(install);
      }
    }
  }
  return commands;
}

function which(name: string): string | null {
  const result = run(["/bin/sh", "-lc", `command -v ${shellQuote(name)}`], process.cwd(), { check: false });
  return result.returncode === 0 ? result.stdout.trim() : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellQuotePath(value: string): string {
  return value === "." ? "." : shellQuote(value);
}

function shellSplit(command: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    result.push((match[1] ?? match[2] ?? match[3] ?? "").replaceAll("\\ ", " "));
  }
  return result;
}
