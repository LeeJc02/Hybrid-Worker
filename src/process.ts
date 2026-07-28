import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

export interface CommandResult {
  command: string[];
  returncode: number;
  stdout: string;
  stderr: string;
}

export function run(
  command: string[],
  cwd: string,
  options: { check?: boolean; inputText?: string; env?: NodeJS.ProcessEnv } = {}
): CommandResult {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    input: options.inputText,
    env: options.env,
    encoding: "utf8",
    shell: false
  });
  const returncode = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if ((options.check ?? true) && returncode !== 0) {
    throw new Error(`Command failed (${returncode}): ${command.join(" ")}\n${stdout}${stderr}`);
  }
  return { command, returncode, stdout, stderr };
}

export async function runToLog(
  command: string[],
  cwd: string,
  logFile: string,
  options: { inputText?: string; env?: NodeJS.ProcessEnv; timeoutSec?: number | null; append?: boolean; logCommand?: boolean } = {}
): Promise<{ returncode: number; elapsedSec: number }> {
  const started = performance.now();
  const writer = options.append ? appendFileSync : writeFileSync;
  if (options.logCommand ?? true) writer(logFile, `$ ${command.join(" ")}\n`);
  else if (!options.append) writeFileSync(logFile, "");
  return await new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let settled = false;
    const timeout =
      options.timeoutSec == null
        ? null
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGTERM");
            appendFileSync(logFile, `\nTIMEOUT after ${options.timeoutSec} seconds\n`);
            resolve({ returncode: 124, elapsedSec: (performance.now() - started) / 1000 });
          }, options.timeoutSec * 1000);

    child.stdout.on("data", (chunk) => appendFileSync(logFile, chunk));
    child.stderr.on("data", (chunk) => appendFileSync(logFile, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      appendFileSync(logFile, `\n${String(error)}\n`);
      resolve({ returncode: 1, elapsedSec: (performance.now() - started) / 1000 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ returncode: code ?? 1, elapsedSec: (performance.now() - started) / 1000 });
    });
    if (options.inputText != null) {
      child.stdin.write(options.inputText);
    }
    child.stdin.end();
  });
}

export async function runCommandSequence(
  setupCommands: string[],
  testCommands: string[],
  cwd: string,
  logFile: string,
  env: NodeJS.ProcessEnv,
  timeoutSec: number | null
): Promise<number | null> {
  const commands = [
    ...setupCommands.map((command) => ({ section: "environment setup", command })),
    ...testCommands.map((command) => ({ section: "tests", command }))
  ];
  if (commands.length === 0) {
    writeFileSync(logFile, "No environment setup or tests configured.\n", "utf8");
    return null;
  }
  writeFileSync(logFile, "");
  let currentSection = "";
  for (const item of commands) {
    if (item.section !== currentSection) {
      appendFileSync(logFile, `\n# ${item.section}\n`);
      currentSection = item.section;
    }
    const result = await runShellToLog(item.command, cwd, logFile, env, timeoutSec);
    if (result !== 0) return result;
  }
  return 0;
}

async function runShellToLog(
  command: string,
  cwd: string,
  logFile: string,
  env: NodeJS.ProcessEnv,
  timeoutSec: number | null
): Promise<number> {
  appendFileSync(logFile, `\n$ ${command}\n`);
  const result = await runToLog(["/bin/sh", "-lc", command], cwd, logFile, { env, timeoutSec, append: true, logCommand: false });
  return result.returncode;
}

export function shellRun(command: string, cwd: string, env: NodeJS.ProcessEnv, logFile: string, timeoutSec: number | null): Promise<number> {
  return runShellToLog(command, cwd, logFile, env, timeoutSec);
}
