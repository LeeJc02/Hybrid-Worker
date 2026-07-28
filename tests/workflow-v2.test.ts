import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResourceBroker } from "../src/broker.js";
import { managerSubworkflow } from "../src/hierarchical.js";
import { circuitDecision, pilotBatches, topologicalLayers } from "../src/scheduler.js";
import {
  conditionMatches,
  decideExecutionMode,
  expandForEachNode,
  materializeDeclarativeWorkflow,
  modelSelection,
  validateCompiledWorkflow,
  verificationPolicy
} from "../src/workflow.js";
import type { CompiledWorkflow, WorkflowNode, WorkflowSeed } from "../src/types.js";

describe("hybrid worker v2 workflow", () => {
  it("never selects hierarchical mode below 12 required write nodes", () => {
    const workflow = makeWorkflow([4, 4, 3]);
    const decision = decideExecutionMode(workflow);
    expect(decision.required_write_nodes).toBe(11);
    expect(decision.execution_mode).toBe("single_layer");
  });

  it("selects hierarchical mode only for three isolated workstreams", () => {
    const workflow = makeWorkflow([4, 4, 4]);
    expect(decideExecutionMode(workflow)).toMatchObject({ execution_mode: "hierarchical", required_write_nodes: 12 });

    workflow.nodes.at(-1)!.paths = ["domain-a/1"];
    const overlap = decideExecutionMode(workflow);
    expect(overlap.execution_mode).toBe("single_layer_dynamic_dag");
    expect(overlap.reasons.join("\n")).toContain("write path overlap");

    const dependencyWorkflow = makeWorkflow([4, 4, 4]);
    dependencyWorkflow.nodes.find((node) => node.id === "b-1")!.depends_on = ["a-1"];
    const dependency = decideExecutionMode(dependencyWorkflow);
    expect(dependency.execution_mode).toBe("single_layer_dynamic_dag");
    expect(dependency.reasons.join("\n")).toContain("cross-workstream implementation dependency");
  });

  it("validates command authority, risk floors, references, and cycles", () => {
    const seed: WorkflowSeed = {
      version: 2,
      objective: "build",
      command_catalog: { test: { argv: ["npm", "test"] } },
      nodes: [{ id: "a", kind: "implementer", risk_floor: "high" }],
      final_verification: ["test"]
    };
    const workflow: CompiledWorkflow = {
      version: 2,
      objective: "build",
      command_catalog: { test: { argv: ["npm", "test"] }, injected: { argv: ["sh", "-c", "bad"] } },
      final_verification: ["test"],
      nodes: [
        node("a", "a", 1, { risk: "medium", depends_on: ["b"], command_refs: ["injected"] }),
        node("b", "a", 2, { depends_on: ["a"] })
      ]
    };
    const errors = validateCompiledWorkflow(workflow, seed).join("\n");
    expect(errors).toContain("unauthorized command injected");
    expect(errors).toContain("below seed risk floor high");
    expect(errors).toContain("dependency cycle");
  });

  it("expands fan-out, evaluates restricted conditions, and layers the DAG", () => {
    const template = node("verify", "a", 3, {
      kind: "verifier",
      depends_on: ["discover"],
      for_each: { ref: { node: "discover", output: "files" }, item_name: "file" },
      when: { ref: { node: "discover", output: "enabled" }, equals: true }
    });
    const outputs = { discover: { files: ["a.ts", "b.ts"], enabled: true } };
    expect(expandForEachNode(template, outputs).map((item) => [item.id, item.item])).toEqual([
      ["verify[0]", "a.ts"],
      ["verify[1]", "b.ts"]
    ]);
    expect(conditionMatches(template.when, outputs)).toBe(true);
    expect(conditionMatches({ ref: { node: "discover", output: "enabled" }, in: [false] }, outputs)).toBe(false);
    const layers = topologicalLayers([node("discover", "a", 1), { ...template, for_each: undefined }]);
    expect(layers.map((layer) => layer.map((item) => item.id))).toEqual([["discover"], ["verify"]]);
    const materialized = materializeDeclarativeWorkflow({
      version: 2,
      objective: "fan out",
      command_catalog: {},
      final_verification: [],
      nodes: [
        node("discover", "a", 1, { kind: "scout", outputs: { files: ["a.ts", "b.ts"], enabled: true } }),
        template,
        node("skipped", "a", 4, { when: { ref: { node: "discover", output: "enabled" }, equals: false } })
      ]
    });
    expect(materialized.nodes.map((item) => item.id)).toEqual(["discover", "verify[0]", "verify[1]"]);
    expect(materialized.nodes.find((item) => item.id === "verify[0]")?.depends_on).toEqual(["discover"]);
  });

  it("routes models and verifier quorum without lowering seed risk", () => {
    const implementation = node("api", "a", 1, { route: "fast", risk: "medium" });
    const seed: WorkflowSeed = {
      version: 2,
      objective: "build",
      command_catalog: {},
      nodes: [{ id: "api", kind: "implementer", risk_floor: "high" }],
      final_verification: []
    };
    expect(modelSelection(implementation, seed)).toMatchObject({ route: "deep", model: "opus", effort: "high" });
    expect(modelSelection(node("scan", "a", 1, { kind: "scout", risk: "low" }))).toMatchObject({ route: "fast", model: "haiku" });
    expect(verificationPolicy("critical")).toEqual({ route: "deep", verifier_count: 3, required_passes: 2, repair_route: "deep", max_repairs: 1 });
    expect(verificationPolicy("low").verifier_count).toBe(0);
  });

  it("creates manager subgraphs without cross-domain implementation nodes", () => {
    const workflow = makeWorkflow([4, 4, 4]);
    workflow.nodes.unshift(node("map", "", 0, { kind: "scout", paths: [], required: false }));
    const subgraph = managerSubworkflow(workflow, "a");
    expect(subgraph.nodes.some((item) => item.id === "map")).toBe(true);
    expect(subgraph.nodes.filter((item) => item.kind === "implementer").every((item) => item.workstream === "a")).toBe(true);
  });

  it("enforces global read/write slots, call budgets, and lease reclamation", async () => {
    const root = mkdtempSync(join(tmpdir(), "hybrid-worker-broker-"));
    const limits = { maxReadonly: 8, maxWrite: 4, maxCalls: 12, maxCostUsd: 10, leaseSec: 0.2 };
    const brokers = [new ResourceBroker(root, limits), new ResourceBroker(root, limits), new ResourceBroker(root, limits)];
    const reads = await Promise.all(Array.from({ length: 8 }, (_, index) => brokers[index % 3]!.acquire("readonly", `r${index}`, 1)));
    const writes = await Promise.all(Array.from({ length: 4 }, (_, index) => brokers[index % 3]!.acquire("write", `w${index}`, 1)));
    const snapshot = brokers[0]!.snapshot();
    expect(snapshot.leases.filter((lease) => lease.access === "readonly")).toHaveLength(8);
    expect(snapshot.leases.filter((lease) => lease.access === "write")).toHaveLength(4);
    await expect(brokers[0]!.acquire("write", "over-budget", 0.1)).rejects.toThrow(/call budget exhausted/);
    const costRoot = mkdtempSync(join(tmpdir(), "hybrid-worker-cost-broker-"));
    const costBroker = new ResourceBroker(costRoot, { ...limits, maxCalls: 20 });
    const costLease = await costBroker.acquire("readonly", "cost", 1);
    costBroker.release(costLease.id, 10);
    await expect(costBroker.acquire("readonly", "cost-budget", 0.1)).rejects.toThrow(/cost budget exhausted/);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const reclaimed = brokers[2]!.snapshot();
    expect(reclaimed.leases).toHaveLength(0);
    expect(reclaimed.reclaimed_leases).toBeGreaterThan(0);
    expect(writes).toHaveLength(4);
  });

  it("shares broker caps across three real manager processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "hybrid-worker-process-broker-"));
    const script = join(root, "manager.mjs");
    const brokerModule = join(process.cwd(), "src", "broker.ts");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        script,
        `
        import { ResourceBroker } from ${JSON.stringify(brokerModule)};
        const [root, owner] = process.argv.slice(2);
        const limits = { maxReadonly: 8, maxWrite: 4, maxCalls: 64, maxCostUsd: 10, leaseSec: 3 };
        const broker = new ResourceBroker(root, limits);
        const leases = [];
        for (let i = 0; i < 4; i++) leases.push(await broker.acquire("readonly", owner + "-r" + i, 3));
        for (let i = 0; i < 2; i++) leases.push(await broker.acquire("write", owner + "-w" + i, 3));
        await new Promise((resolve) => setTimeout(resolve, 400));
        for (const lease of leases) broker.release(lease.id);
        `,
        "utf8"
      )
    );
    const limits = { maxReadonly: 8, maxWrite: 4, maxCalls: 64, maxCostUsd: 10, leaseSec: 3 };
    const broker = new ResourceBroker(root, limits);
    const children = ["a", "b", "c"].map((owner) => spawn(process.execPath, ["--import", "tsx", script, root, owner], { stdio: "ignore" }));
    const deadline = Date.now() + 2000;
    let snapshot = broker.snapshot();
    while (snapshot.calls_started < 8 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      snapshot = broker.snapshot();
    }
    expect(snapshot.leases.filter((lease) => lease.access === "readonly").length).toBeLessThanOrEqual(8);
    expect(snapshot.leases.filter((lease) => lease.access === "write").length).toBeLessThanOrEqual(4);
    expect(snapshot.leases.length).toBeGreaterThan(0);
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.on("error", reject);
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`manager process exited ${code}`))));
          })
      )
    );
    expect(broker.snapshot().calls_started).toBe(18);
  }, 10_000);

  it("uses one pilot, batches of four, and a 2/3 circuit breaker", () => {
    const nodes = Array.from({ length: 10 }, (_, index) => node(`n${index}`, "a", index));
    expect(pilotBatches(nodes)).toEqual({ pilot: "n0", batches: [["n1", "n2", "n3", "n4"], ["n5", "n6", "n7", "n8"], ["n9"]] });
    expect(circuitDecision([{ passed: true, testsRunnable: true }, { passed: false, testsRunnable: true }, { passed: false, testsRunnable: true }]).open).toBe(true);
    expect(circuitDecision([{ passed: true, testsRunnable: false }])).toMatchObject({ open: true, reason: "batch could not run any tests" });
  });
});

function makeWorkflow(counts: [number, number, number]): CompiledWorkflow {
  const workstreams = ["a", "b", "c"];
  const nodes = counts.flatMap((count, workstreamIndex) =>
    Array.from({ length: count }, (_, index) => node(`${workstreams[workstreamIndex]}-${index + 1}`, workstreams[workstreamIndex]!, index + 1))
  );
  return {
    version: 2,
    objective: "large build",
    command_catalog: { test: { argv: ["npm", "test"] } },
    nodes,
    final_verification: ["test"],
    shared_contract_frozen: true
  };
}

function node(id: string, workstream: string, index: number, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    kind: "implementer",
    required: true,
    workstream,
    depends_on: [],
    paths: [`domain-${workstream}/${index}`],
    ticket: `tickets/${id}.md`,
    command_refs: ["test"],
    risk: "low",
    ...overrides
  };
}
