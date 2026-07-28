import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { head } from "./git.js";
import type { CompiledWorkflow, WorkflowSeed } from "./types.js";

const MANIFESTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle"
];

export function collectPrework(repo: string, workflow: CompiledWorkflow): Record<string, unknown> {
  const files = walk(repo, 3, 4000);
  const manifests = files.filter((path) => MANIFESTS.includes(basename(path))).sort();
  const tests = files.filter((path) => /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(path)).sort();
  const topLevel = readdirSync(repo, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const pathOwners = Object.fromEntries(
    workflow.nodes
      .filter((node) => node.paths.length)
      .map((node) => [node.id, { workstream: node.workstream ?? null, owner: node.owner ?? null, paths: node.paths }])
  );
  const requiredScouts: string[] = [];
  if (files.length >= 500 || topLevel.filter((entry) => entry.type === "directory").length >= 12) requiredScouts.push("cartographer");
  if (tests.length === 0) requiredScouts.push("test_mapper");
  if (workflow.nodes.some((node) => node.risk === "high" || node.risk === "critical")) requiredScouts.push("risk_scout");
  return {
    generated_at: new Date().toISOString(),
    base_commit: head(repo),
    directory_entries: topLevel,
    file_count_sampled: files.length,
    manifests,
    tests,
    dependencies: manifests.map((path) => ({ path, summary: manifestSummary(join(repo, path)) })),
    path_ownership: pathOwners,
    required_scouts: requiredScouts,
    read_only: true
  };
}

export function collectSeedPrework(repo: string, seed: WorkflowSeed): Record<string, unknown> {
  const workflow: CompiledWorkflow = {
    version: 2,
    objective: seed.objective,
    command_catalog: seed.command_catalog,
    nodes: (seed.nodes ?? []).map((node) => ({
      id: node.id,
      kind: node.kind,
      required: node.required ?? true,
      depends_on: [],
      paths: node.paths ?? [],
      command_refs: [],
      risk: node.risk_floor ?? "low"
    })),
    final_verification: seed.final_verification
  };
  return collectPrework(repo, workflow);
}

function walk(root: string, maxDepth: number, maxFiles: number): string[] {
  const output: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth || output.length >= maxFiles) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".codex")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) output.push(relative(root, path));
      if (output.length >= maxFiles) return;
    }
  };
  visit(root, 0);
  return output;
}

function manifestSummary(path: string): Record<string, unknown> {
  if (!existsSync(path) || statSync(path).size > 1_000_000) return {};
  if (basename(path) !== "package.json") return { bytes: statSync(path).size };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      name: data.name,
      scripts: isRecord(data.scripts) ? Object.keys(data.scripts).sort() : [],
      dependencies: isRecord(data.dependencies) ? Object.keys(data.dependencies).sort() : [],
      dev_dependencies: isRecord(data.devDependencies) ? Object.keys(data.devDependencies).sort() : []
    };
  } catch {
    return { invalid_json: true };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
