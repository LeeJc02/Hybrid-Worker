import type { WorkflowNode } from "./types.js";

export interface BatchDecision {
  pilot: string | null;
  batches: string[][];
}

export interface CircuitDecision {
  open: boolean;
  reason: string;
  pass_rate: number;
}

export function topologicalLayers(nodes: WorkflowNode[]): WorkflowNode[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const remaining = new Set(nodes.map((node) => node.id));
  const completed = new Set<string>();
  const layers: WorkflowNode[][] = [];
  while (remaining.size) {
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((node) => node.depends_on.every((dependency) => completed.has(dependency) || !byId.has(dependency)))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error("workflow contains a dependency cycle");
    layers.push(ready);
    for (const node of ready) {
      remaining.delete(node.id);
      completed.add(node.id);
    }
  }
  return layers;
}

export function pilotBatches(nodes: WorkflowNode[], maxBatchSize = 4): BatchDecision {
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  if (ordered.length === 0) return { pilot: null, batches: [] };
  const batches: string[][] = [];
  for (let index = 1; index < ordered.length; index += maxBatchSize) {
    batches.push(ordered.slice(index, index + maxBatchSize).map((node) => node.id));
  }
  return { pilot: ordered[0]!.id, batches };
}

export function circuitDecision(results: Array<{ passed: boolean; testsRunnable: boolean }>): CircuitDecision {
  if (results.length === 0) return { open: true, reason: "batch produced no results", pass_rate: 0 };
  if (!results.some((result) => result.testsRunnable)) return { open: true, reason: "batch could not run any tests", pass_rate: 0 };
  const passed = results.filter((result) => result.passed).length;
  const passRate = passed / results.length;
  return {
    open: passRate < 2 / 3,
    reason: passRate < 2 / 3 ? `batch pass rate ${passed}/${results.length} is below 2/3` : "batch passed",
    pass_rate: passRate
  };
}
