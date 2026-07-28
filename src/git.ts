import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanupGeneratedNoise, ensureArtifactGitignore, ensureWorktreeExcludes, statusPath } from "./artifacts.js";
import { run } from "./process.js";
import type { RepoIgnorePolicy } from "./types.js";

export function gitRoot(path: string): string | null {
  const result = run(["git", "rev-parse", "--show-toplevel"], path, { check: false });
  return result.returncode === 0 ? resolve(result.stdout.trim()) : null;
}

export function gitHasHead(repo: string): boolean {
  return run(["git", "rev-parse", "--verify", "HEAD"], repo, { check: false }).returncode === 0;
}

export function ensureGitIdentity(repo: string): void {
  if (run(["git", "config", "user.email"], repo, { check: false }).returncode !== 0) {
    run(["git", "config", "user.email", "codex@example.invalid"], repo);
  }
  if (run(["git", "config", "user.name"], repo, { check: false }).returncode !== 0) {
    run(["git", "config", "user.name", "Codex Claude Workers"], repo);
  }
}

export function ensureGitRepo(path: string, ignorePolicy: RepoIgnorePolicy = "tracked"): string {
  mkdirSync(path, { recursive: true });
  const existing = gitRoot(path);
  if (existing == null) {
    run(["git", "init", "-b", "main"], path);
    const repo = resolve(path);
    ensureGitIdentity(repo);
    applyRepoIgnorePolicy(repo, ignorePolicy);
    cleanupGeneratedNoise(repo);
    run(["git", "add", "-A"], repo);
    const commit = run(["git", "commit", "-m", "codex base snapshot"], repo, { check: false });
    if (commit.returncode !== 0) run(["git", "commit", "--allow-empty", "-m", "codex base snapshot"], repo);
    return repo;
  }

  const repo = existing;
  ensureGitIdentity(repo);
  if (!gitHasHead(repo)) {
    applyRepoIgnorePolicy(repo, ignorePolicy);
    cleanupGeneratedNoise(repo);
    run(["git", "add", "-A"], repo);
    const commit = run(["git", "commit", "-m", "codex base snapshot"], repo, { check: false });
    if (commit.returncode !== 0) run(["git", "commit", "--allow-empty", "-m", "codex base snapshot"], repo);
    return repo;
  }

  const gitignoreChanged = ignorePolicy === "tracked" ? ensureArtifactGitignore(repo) : false;
  if (ignorePolicy === "local") ensureWorktreeExcludes(repo);
  if (gitignoreChanged) {
    run(["git", "add", "--", ".gitignore"], repo);
    const commit = run(["git", "commit", "-m", "codex generated artifact ignore policy"], repo, { check: false });
    if (commit.returncode !== 0) run(["git", "checkout", "--", ".gitignore"], repo, { check: false });
  }
  cleanupGeneratedNoise(repo);
  const dirty = run(["git", "status", "--porcelain"], repo).stdout.trim();
  if (dirty) {
    throw new Error(`Base worktree must be clean before running hybrid-worker.\n${dirty}`);
  }
  return repo;
}

function applyRepoIgnorePolicy(repo: string, ignorePolicy: RepoIgnorePolicy): void {
  if (ignorePolicy === "tracked") ensureArtifactGitignore(repo);
  else ensureWorktreeExcludes(repo);
}

export function head(repo: string): string {
  return run(["git", "rev-parse", "HEAD"], repo).stdout.trim();
}

export function currentBranch(repo: string): string {
  return run(["git", "branch", "--show-current"], repo).stdout.trim() || "HEAD";
}

export function branchExists(repo: string, branch: string): boolean {
  return run(["git", "rev-parse", "--verify", "--quiet", branch], repo, { check: false }).returncode === 0;
}

export function cleanupExistingWorktree(repo: string, worktree: string, branch: string): void {
  run(["git", "worktree", "remove", "--force", worktree], repo, { check: false });
  run(["git", "branch", "-D", branch], repo, { check: false });
}

export function createWorktree(repo: string, workerName: string, baseBranch: string, runId: string, root: string): { branch: string; worktree: string } {
  const branch = `hybrid-worker/${workerName}-${runId}`;
  const worktree = `${root}/${workerName}`;
  if (existsSync(worktree) || branchExists(repo, branch)) cleanupExistingWorktree(repo, worktree, branch);
  run(["git", "worktree", "add", "-b", branch, worktree, baseBranch], repo);
  ensureWorktreeExcludes(worktree);
  cleanupGeneratedNoise(worktree);
  return { branch, worktree };
}

export function commitIfNeeded(worktree: string, worker: string): string | null {
  cleanupGeneratedNoise(worktree);
  if (run(["git", "status", "--short"], worktree).stdout.trim()) {
    run(["git", "add", "-A"], worktree);
    const commit = run(["git", "commit", "-m", `claude worker ${worker}`], worktree, { check: false });
    if (commit.returncode !== 0) throw new Error(`${commit.stdout}${commit.stderr}`.trim());
  }
  return head(worktree);
}

export function gitHasUnmergedPaths(repo: string): boolean {
  return Boolean(run(["git", "diff", "--name-only", "--diff-filter=U"], repo, { check: false }).stdout.trim());
}

export function baseWorktreeDirty(repo: string): string {
  cleanupGeneratedNoise(repo);
  return run(["git", "status", "--porcelain"], repo, { check: false }).stdout.trim();
}

export function collectEvidence(
  worktree: string,
  baseRef: string,
  diffFile: string,
  diffstatFile: string
): { changed: string[]; diff: string } {
  cleanupGeneratedNoise(worktree);
  const status = run(["git", "status", "--short"], worktree).stdout;
  const untracked = status
    .split(/\r?\n/)
    .filter((line) => line.startsWith("?? "))
    .map(statusPath);
  if (untracked.length > 0) run(["git", "add", "-N", "--", ...untracked], worktree, { check: false });

  const committed = run(["git", "diff", "--binary", `${baseRef}...HEAD`], worktree, { check: false }).stdout;
  const staged = run(["git", "diff", "--cached", "--binary"], worktree, { check: false }).stdout;
  const unstaged = run(["git", "diff", "--binary"], worktree, { check: false }).stdout;
  const diff = [committed, staged, unstaged].filter(Boolean).join("\n");
  writeFileSync(diffFile, diff, "utf8");
  let stat = run(["git", "diff", "--stat", `${baseRef}...HEAD`], worktree, { check: false }).stdout;
  if (!stat.trim()) stat = run(["git", "diff", "--stat"], worktree, { check: false }).stdout;
  writeFileSync(diffstatFile, stat, "utf8");

  const names = new Set<string>();
  for (const command of [
    ["git", "diff", "--name-only", `${baseRef}...HEAD`],
    ["git", "diff", "--cached", "--name-only"],
    ["git", "diff", "--name-only"]
  ]) {
    for (const line of run(command, worktree, { check: false }).stdout.split(/\r?\n/)) {
      if (line) names.add(line);
    }
  }
  for (const line of run(["git", "status", "--short"], worktree).stdout.split(/\r?\n/)) {
    if (line) names.add(statusPath(line));
  }
  return { changed: [...names].sort(), diff };
}
