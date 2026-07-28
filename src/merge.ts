import { join } from "node:path";
import { cleanupGeneratedNoise } from "./artifacts.js";
import { applySharedCacheEnv, finalEnvironmentSetupCommands } from "./env.js";
import { branchExists, cleanupExistingWorktree, gitHasUnmergedPaths, head } from "./git.js";
import { run, runCommandSequence, runToLog } from "./process.js";
import type { CliOptions, EnvironmentPolicy, MergeResult, WorkerResult } from "./types.js";

export interface IntegrationSession {
  repo: string;
  baseBranch: string;
  runDir: string;
  started: number;
  worktree: string;
  result: MergeResult;
}

export async function finalTests(
  repo: string,
  tests: string[],
  logFile: string,
  pythonCommand: string,
  timeoutSec: number | null,
  envPolicy: EnvironmentPolicy
): Promise<number> {
  const env = applySharedCacheEnv({ ...process.env, PYTHON: pythonCommand });
  const setupCommands = finalEnvironmentSetupCommands(envPolicy, repo, tests);
  const code = await runCommandSequence(setupCommands, tests, repo, logFile, env, timeoutSec);
  cleanupGeneratedNoise(repo);
  return code ?? 0;
}

export async function transactionalMerge(
  repo: string,
  baseBranch: string,
  results: WorkerResult[],
  args: CliOptions,
  pythonCommand: string,
  envPolicy: EnvironmentPolicy
): Promise<MergeResult> {
  const session = beginIntegration(repo, baseBranch, args);
  try {
    await mergeResultsIntoIntegration(session, results, args, pythonCommand, "merge-conflict-codex.log");
    await runIntegrationTests(session, args.test, "final.tests.log", pythonCommand, args.testTimeoutSec, envPolicy, "Final verification failed");
    fastForwardIntegration(session, results);
  } catch (error) {
    markIntegrationError(session, error);
  } finally {
    finishIntegration(session);
  }
  return session.result;
}

export function beginIntegration(repo: string, baseBranch: string, args: CliOptions): IntegrationSession {
  const started = performance.now();
  const result: MergeResult = {
    attempted: true,
    merged: false,
    integration_branch: `hybrid-worker/integration-${args.runId}`,
    base_before: head(repo),
    base_after: "",
    base_unchanged_on_failure: true,
    error: "",
    conflict_resolution_attempted: false,
    conflict_resolution_log_file: "",
    elapsed_sec: 0
  };
  const worktree = join(args.worktreeRoot!, "_integration");
  if (branchExists(repo, result.integration_branch)) cleanupExistingWorktree(repo, worktree, result.integration_branch);
  run(["git", "worktree", "add", "-b", result.integration_branch, worktree, baseBranch], repo);
  return { repo, baseBranch, runDir: args.runDir!, started, worktree, result };
}

export async function mergeResultsIntoIntegration(
  session: IntegrationSession,
  results: WorkerResult[],
  args: CliOptions,
  pythonCommand: string,
  conflictLogName: string
): Promise<void> {
  for (const result of [...results].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!result.accepted) continue;
    if (!run(["git", "log", "--oneline", `${session.baseBranch}..${result.branch}`], session.worktree, { check: false }).stdout.trim()) continue;
    const mergeResult = run(["git", "merge", "--no-ff", "--no-edit", result.branch], session.worktree, { check: false });
    if (mergeResult.returncode === 0) continue;
    const error = `${mergeResult.stdout}${mergeResult.stderr}`.trim();
    if (!args.mergeConflictCommand) throw new Error(error);
    session.result.conflict_resolution_attempted = true;
    const logFile = join(args.runDir!, conflictLogName);
    session.result.conflict_resolution_log_file = logFile;
    const env = applySharedCacheEnv({ ...process.env, PYTHON: pythonCommand, CPW_MERGE_ERROR: error, CPW_CONFLICT_BRANCH: result.branch });
    const code = await runToLog(["/bin/sh", "-lc", args.mergeConflictCommand], session.worktree, logFile, { env, timeoutSec: args.workerTimeoutSec });
    cleanupGeneratedNoise(session.worktree);
    if (code.returncode !== 0) throw new Error(`Merge conflict resolver failed with exit code ${code.returncode}.\n${error}`);
    if (gitHasUnmergedPaths(session.worktree)) throw new Error(`Merge conflict resolver left unmerged paths.\n${error}`);
    run(["git", "add", "-A"], session.worktree);
    const commit = run(["git", "commit", "--no-edit"], session.worktree, { check: false });
    if (commit.returncode !== 0) throw new Error(`${commit.stdout}${commit.stderr}`.trim() + `\n${error}`);
  }
}

export async function runIntegrationTests(
  session: IntegrationSession,
  tests: string[],
  logName: string,
  pythonCommand: string,
  timeoutSec: number | null,
  envPolicy: EnvironmentPolicy,
  failurePrefix: string
): Promise<void> {
  const code = await finalTests(session.worktree, tests, join(session.runDir, logName), pythonCommand, timeoutSec, envPolicy);
  if (code !== 0) throw new Error(`${failurePrefix} with exit code ${code}.`);
}

export function fastForwardIntegration(session: IntegrationSession, results: WorkerResult[]): void {
  const ff = run(["git", "merge", "--ff-only", session.result.integration_branch], session.repo, { check: false });
  if (ff.returncode !== 0) throw new Error(`${ff.stdout}${ff.stderr}`.trim());
  for (const result of results) {
    if (result.accepted) result.merged = true;
  }
  session.result.merged = true;
}

export function markIntegrationError(session: IntegrationSession, error: unknown): void {
  run(["git", "merge", "--abort"], session.worktree, { check: false });
  session.result.error = error instanceof Error ? error.message : String(error);
}

export function finishIntegration(session: IntegrationSession): void {
  run(["git", "worktree", "remove", "--force", session.worktree], session.repo, { check: false });
  session.result.base_after = head(session.repo);
  session.result.base_unchanged_on_failure = session.result.merged || session.result.base_after === session.result.base_before;
  session.result.elapsed_sec = (performance.now() - session.started) / 1000;
}
