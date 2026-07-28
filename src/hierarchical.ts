import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorktree, head } from "./git.js";
import { writeJson } from "./json.js";
import { safeName } from "./parse.js";
import type { CompiledWorkflow, ManagerPlan, ScaleDecision, WorkflowNode } from "./types.js";

export function managerSubworkflow(workflow: CompiledWorkflow, workstream: string): CompiledWorkflow {
  const selected = new Set(
    workflow.nodes
      .filter((node) => node.workstream === workstream || node.kind === "scout" || node.kind === "planner" || node.kind === "shared_contract")
      .map((node) => node.id)
  );
  const nodes = workflow.nodes
    .filter((node) => selected.has(node.id))
    .map((node) => ({ ...node, depends_on: node.depends_on.filter((dependency) => selected.has(dependency)) }));
  return { ...workflow, nodes };
}

export function buildManagerPlans(input: {
  repo: string;
  baseRef: string;
  runId: string;
  parentRunDir: string;
  worktreeRoot: string;
  cliPath: string;
  taskFile: string;
  workflow: CompiledWorkflow;
  decision: ScaleDecision;
  createWorktrees?: boolean;
  brokerLimits?: { maxReadonly: number; maxWrite: number; maxCalls: number; maxCostUsd: number; leaseSec: number };
}): ManagerPlan[] {
  if (input.decision.execution_mode !== "hierarchical") return [];
  mkdirSync(input.parentRunDir, { recursive: true });
  mkdirSync(input.worktreeRoot, { recursive: true });
  return input.decision.workstreams.map((workstream, index) => {
    const managerId = `manager-${String(index + 1).padStart(2, "0")}-${safeName(workstream)}`;
    const runDir = join(input.parentRunDir, "managers", managerId);
    const workflowFile = join(runDir, "compiled_workflow.json");
    mkdirSync(runDir, { recursive: true });
    const subworkflow = managerSubworkflow(input.workflow, workstream);
    writeJson(workflowFile, subworkflow);
    const expectedBranch = `hybrid-worker/${managerId}-${input.runId}`;
    const expectedWorktree = join(input.worktreeRoot, managerId);
    const created = input.createWorktrees === false
      ? { branch: expectedBranch, worktree: expectedWorktree }
      : createWorktree(input.repo, managerId, input.baseRef, input.runId, input.worktreeRoot);
    const command = [
      process.execPath,
      resolve(input.cliPath),
      "--repo",
      created.worktree,
      "--task-file",
      input.taskFile,
      "--compiled-workflow",
      workflowFile,
      "--manager-id",
      managerId,
      "--parent-run-dir",
      input.parentRunDir,
      "--broker-dir",
      join(input.parentRunDir, "broker"),
      "--run-id",
      `${input.runId}-${managerId}`,
      "--run-dir",
      runDir,
      "--worktree-root",
      join(input.worktreeRoot, `${managerId}-workers`),
      "--merge"
    ];
    if (input.brokerLimits) {
      command.push(
        "--broker-max-readonly",
        String(input.brokerLimits.maxReadonly),
        "--broker-max-write",
        String(input.brokerLimits.maxWrite),
        "--broker-max-calls",
        String(input.brokerLimits.maxCalls),
        "--broker-max-cost-usd",
        String(input.brokerLimits.maxCostUsd),
        "--broker-lease-sec",
        String(input.brokerLimits.leaseSec)
      );
    }
    return {
      manager_id: managerId,
      branch: created.branch,
      worktree: created.worktree,
      run_dir: runDir,
      workflow_file: workflowFile,
      command,
      node_ids: subworkflow.nodes.map((node) => node.id)
    };
  });
}

export function parentManifest(input: {
  repo: string;
  runId: string;
  decision: ScaleDecision;
  workflowFile: string;
  managers: ManagerPlan[];
}): Record<string, unknown> {
  return {
    version: 2,
    run_id: input.runId,
    repo: input.repo,
    base_commit: head(input.repo),
    execution_mode: input.decision.execution_mode,
    scale_decision: input.decision,
    compiled_workflow: input.workflowFile,
    managers: input.managers
  };
}

export function writeNodes(workflow: CompiledWorkflow): WorkflowNode[] {
  return workflow.nodes.filter((node) => node.kind === "shared_contract" || node.kind === "implementer" || node.kind === "repair");
}
