import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  GENERATED_ARTIFACT_DIRS,
  GENERATED_ARTIFACT_FILES,
  GENERATED_ARTIFACT_SUFFIXES,
  GIT_EXCLUDE_BLOCK
} from "./constants.js";
import { run } from "./process.js";

export function isGeneratedArtifactPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (parts.some((part) => GENERATED_ARTIFACT_DIRS.has(part))) return true;
  if (parts.length === 0) return false;
  const name = parts.at(-1)!;
  return GENERATED_ARTIFACT_FILES.has(name) || GENERATED_ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function generatedArtifactFindings(paths: string[]): string[] {
  return paths.filter(isGeneratedArtifactPath).map((path) => `Generated/intermediate artifact changed: ${path}`);
}

export function statusPath(line: string): string {
  let text = line.length > 3 ? line.slice(3).trim() : line.trim();
  if (text.includes(" -> ")) text = text.split(" -> ").at(-1)!;
  return text.replace(/^"|"$/g, "");
}

export function ensureArtifactGitignore(repo: string): boolean {
  const gitignore = join(repo, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (existing.includes("hybrid-worker generated artifacts")) return false;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignore, `${existing}${prefix}${GIT_EXCLUDE_BLOCK}`, "utf8");
  return true;
}

export function ensureWorktreeExcludes(worktree: string): void {
  const exclude = gitPath(worktree, "info/exclude");
  const excludeDir = dirname(exclude);
  if (!existsSync(excludeDir)) mkdirSync(excludeDir, { recursive: true });
  const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!existing.includes("hybrid-worker generated artifacts")) {
    const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(exclude, `${existing}${prefix}${GIT_EXCLUDE_BLOCK}`, "utf8");
  }
}

export function cleanupGeneratedNoise(worktree: string): void {
  ensureWorktreeExcludes(worktree);
  run(["git", "clean", "-fdX"], worktree, { check: false });
  for (const rel of ["worker_summary.json", "reviewer_decision.json", ".claudeignore"]) {
    const path = join(worktree, rel);
    if (!existsSync(path)) continue;
    const tracked = run(["git", "ls-files", "--error-unmatch", "--", rel], worktree, { check: false }).returncode === 0;
    if (!tracked) unlinkSync(path);
  }
}

export function restoreUnownedScaffoldChanges(worktree: string, allowedPaths: string[]): string[] {
  const restored = new Set<string>();
  const status = run(["git", "status", "--porcelain"], worktree, { check: false }).stdout;
  for (const line of status.split(/\r?\n/)) {
    if (!line) continue;
    const path = statusPath(line);
    if (!path || !isProtectedScaffoldPath(path) || pathAllowed(path, allowedPaths)) continue;
    run(["git", "restore", "--staged", "--worktree", "--", path], worktree, { check: false });
    if (line.startsWith("?? ")) {
      const candidate = join(worktree, path);
      if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
    }
    restored.add(path);
  }
  return [...restored].sort();
}

function gitPath(repo: string, path: string): string {
  const result = run(["git", "rev-parse", "--git-path", path], repo).stdout.trim();
  return isAbsolute(result) ? result : resolve(repo, result);
}


export function diffLineCount(diff: string): number {
  return diff.split(/\r?\n/).filter((line) => line.startsWith("+") || line.startsWith("-")).length;
}

export function validateAllowedPathPrefix(path: string): string | null {
  const cleaned = path.trim();
  if (cleaned === "." || cleaned === "*") return null;
  if (!cleaned) return "allowed path cannot be empty";
  if (cleaned.startsWith("/")) return "allowed path must be repo-relative, not absolute";
  if (cleaned.split(/[\\/]+/).includes("..")) return "allowed path must not contain parent traversal";
  if (isGeneratedArtifactPath(cleaned)) return "allowed path must not target generated/intermediate artifacts";
  return null;
}

export function pathAllowed(path: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const normalized = allowed.map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean);
  if (normalized.some((item) => item === "." || item === "*")) return true;
  return normalized.some((item) => path === item || path.startsWith(`${item}/`));
}

function isProtectedScaffoldPath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (["CLAUDE.md", "TASK.md", "worker_plan.json"].includes(normalized)) return true;
  return normalized === "tickets" || normalized.startsWith("tickets/");
}
