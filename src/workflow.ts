import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  CommandSpec,
  CompiledWorkflow,
  ModelRoute,
  ModelSelection,
  RiskLevel,
  ScaleDecision,
  VerificationPolicy,
  WorkflowCondition,
  WorkflowNode,
  WorkflowReference,
  WorkflowSeed
} from "./types.js";
import { topologicalLayers } from "./scheduler.js";

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];
const WRITE_KINDS = new Set(["shared_contract", "implementer", "repair"]);

export function loadWorkflowSeed(path: string): WorkflowSeed {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const errors = validateWorkflowSeed(data);
  if (errors.length) throw new Error(`workflow_seed.json schema errors:\n${errors.join("\n")}`);
  return data as WorkflowSeed;
}

export function loadCompiledWorkflow(path: string, seed?: WorkflowSeed): CompiledWorkflow {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const errors = validateCompiledWorkflow(data, seed);
  if (errors.length) throw new Error(`compiled_workflow.json schema errors:\n${errors.join("\n")}`);
  return data as CompiledWorkflow;
}

export function resolveWorkflowPath(repo: string, path: string): string {
  return isAbsolute(path) ? path : join(repo, path);
}

export function validateWorkflowSeed(data: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(data)) return ["workflow seed must be a JSON object."];
  if (data.version !== 2) errors.push("version must be 2.");
  if (typeof data.objective !== "string" || !data.objective.trim()) errors.push("objective must be a non-empty string.");
  validateCommandCatalog(data.command_catalog, errors);
  validateStringArray(data.final_verification, "final_verification", errors);
  if (Array.isArray(data.nodes)) {
    const seen = new Set<string>();
    data.nodes.forEach((node, index) => {
      const label = `nodes[${index}]`;
      if (!isRecord(node)) {
        errors.push(`${label} must be an object.`);
        return;
      }
      validateId(node.id, `${label}.id`, seen, errors);
      if (!isNodeKind(node.kind)) errors.push(`${label}.kind is invalid.`);
      if (node.risk_floor != null && !isRisk(node.risk_floor)) errors.push(`${label}.risk_floor is invalid.`);
      validateStringArray(node.paths, `${label}.paths`, errors, true);
    });
  } else if (data.nodes != null) {
    errors.push("nodes must be an array when provided.");
  }
  return errors;
}

export function validateCompiledWorkflow(data: unknown, seed?: WorkflowSeed): string[] {
  const errors: string[] = [];
  if (!isRecord(data)) return ["compiled workflow must be a JSON object."];
  if (data.version !== 2) errors.push("version must be 2.");
  if (typeof data.objective !== "string" || !data.objective.trim()) errors.push("objective must be a non-empty string.");
  validateCommandCatalog(data.command_catalog, errors);
  validateStringArray(data.final_verification, "final_verification", errors);
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
    errors.push("nodes must be a non-empty array.");
    return errors;
  }
  const seen = new Set<string>();
  data.nodes.forEach((node, index) => validateWorkflowNode(node, index, seen, errors));
  const ids = new Set(
    data.nodes.filter(isRecord).map((node) => node.id).filter((id): id is string => typeof id === "string")
  );
  data.nodes.forEach((node, index) => {
    if (!isRecord(node)) return;
    for (const dependency of stringArray(node.depends_on)) {
      if (!ids.has(dependency)) errors.push(`nodes[${index}].depends_on references unknown node ${dependency}.`);
      if (dependency === node.id) errors.push(`nodes[${index}] cannot depend on itself.`);
    }
    validateReference(node.for_each, `nodes[${index}].for_each`, ids, errors, true);
    validateCondition(node.when, `nodes[${index}].when`, ids, errors);
    if (isRecord(node.inputs)) {
      for (const [name, reference] of Object.entries(node.inputs)) validateReference(reference, `nodes[${index}].inputs.${name}`, ids, errors);
    } else if (node.inputs != null) {
      errors.push(`nodes[${index}].inputs must be an object.`);
    }
  });
  errors.push(...cycleErrors(data.nodes.filter(isWorkflowNodeLike) as WorkflowNode[]));
  if (seed) validateSeedAuthority(data, seed, errors);
  return errors;
}

export function decideExecutionMode(workflow: CompiledWorkflow): ScaleDecision {
  const requiredWrites = workflow.nodes.filter((node) => node.required && WRITE_KINDS.has(node.kind));
  const implementationWrites = requiredWrites.filter((node) => node.kind !== "shared_contract");
  const workstreams = [...new Set(implementationWrites.map((node) => node.workstream).filter((value): value is string => Boolean(value)))].sort();
  const reasons: string[] = [];
  if (requiredWrites.length < 12) {
    reasons.push(`required write node count ${requiredWrites.length} is below 12`);
    return { execution_mode: "single_layer", required_write_nodes: requiredWrites.length, workstreams, reasons };
  }
  if (workstreams.length !== 3) reasons.push(`expected exactly 3 workstreams, found ${workstreams.length}`);
  for (const workstream of workstreams) {
    const implementations = requiredWrites.filter((node) => node.workstream === workstream && node.kind === "implementer");
    if (implementations.length < 3) reasons.push(`workstream ${workstream} has fewer than 3 implementers`);
  }
  const ownership = pathOwnershipErrors(implementationWrites);
  reasons.push(...ownership);
  reasons.push(...crossWorkstreamDependencyErrors(implementationWrites));
  if (workflow.final_verification.length === 0) reasons.push("final verification is empty");
  const sharedNodes = requiredWrites.filter((node) => node.kind === "shared_contract");
  if (sharedNodes.length && workflow.shared_contract_frozen !== true) reasons.push("shared contract is not frozen");
  for (const node of sharedNodes) {
    if (!node.owner) reasons.push(`shared contract node ${node.id} has no unique owner`);
  }
  return {
    execution_mode: reasons.length === 0 ? "hierarchical" : "single_layer_dynamic_dag",
    required_write_nodes: requiredWrites.length,
    workstreams,
    reasons: reasons.length ? reasons : ["three independent workstreams satisfy hierarchical thresholds"]
  };
}

export function modelSelection(node: WorkflowNode, seed?: WorkflowSeed): ModelSelection {
  const floor = seed?.nodes?.find((item) => item.id === node.id)?.risk_floor;
  const risk = floor && riskRank(floor) > riskRank(node.risk) ? floor : node.risk;
  const minimum = risk === "critical" || risk === "high" || node.kind === "repair" ? "deep" : node.kind === "scout" ? "fast" : "balanced";
  const route = maxRoute(node.route ?? minimum, minimum);
  const effort = node.effort ?? (route === "deep" ? "high" : route === "fast" ? "low" : "medium");
  const selection: ModelSelection = { route, model: route === "fast" ? "haiku" : route === "balanced" ? "sonnet" : "opus", effort };
  if (node.fallback) selection.fallback = maxRoute(node.fallback, minimum);
  return selection;
}

export function verificationPolicy(risk: RiskLevel): VerificationPolicy {
  if (risk === "critical") return { route: "deep", verifier_count: 3, required_passes: 2, repair_route: "deep", max_repairs: 1 };
  if (risk === "high") return { route: "deep", verifier_count: 1, required_passes: 1, repair_route: "deep", max_repairs: 1 };
  if (risk === "medium") return { route: "balanced", verifier_count: 1, required_passes: 1, repair_route: "deep", max_repairs: 1 };
  return { route: "balanced", verifier_count: 0, required_passes: 0, repair_route: "deep", max_repairs: 1 };
}

export function expandForEachNode(node: WorkflowNode, outputs: Record<string, Record<string, unknown>>): WorkflowNode[] {
  if (!node.for_each) return [node];
  const items = outputs[node.for_each.ref.node]?.[node.for_each.ref.output];
  if (!Array.isArray(items)) throw new Error(`for_each source ${node.for_each.ref.node}.${node.for_each.ref.output} must be an array`);
  const { for_each: _forEach, ...base } = node;
  return items.map((item, index) => ({ ...base, id: `${node.id}[${index}]`, item, template_id: node.id }));
}

export function conditionMatches(condition: WorkflowCondition | undefined, outputs: Record<string, Record<string, unknown>>): boolean {
  if (!condition) return true;
  const value = outputs[condition.ref.node]?.[condition.ref.output];
  if (condition.exists != null && condition.exists !== (value !== undefined)) return false;
  if ("equals" in condition && value !== condition.equals) return false;
  if (condition.in && !condition.in.some((item) => item === value)) return false;
  return true;
}

export function commandSpecs(workflow: CompiledWorkflow, refs: string[]): CommandSpec[] {
  return refs.map((ref) => {
    const command = workflow.command_catalog[ref];
    if (!command) throw new Error(`unknown command reference: ${ref}`);
    return command;
  });
}

export function materializeDeclarativeWorkflow(workflow: CompiledWorkflow): CompiledWorkflow {
  const outputs: Record<string, Record<string, unknown>> = {};
  const expandedIds = new Map<string, string[]>();
  const nodes: WorkflowNode[] = [];
  for (const layer of topologicalLayers(workflow.nodes)) {
    for (const node of layer) {
      outputs[node.id] = node.outputs ?? {};
      if (!conditionMatches(node.when, outputs)) {
        expandedIds.set(node.id, []);
        continue;
      }
      const dependencies = node.depends_on.flatMap((dependency) => expandedIds.get(dependency) ?? [dependency]);
      const expanded = expandForEachNode(node, outputs).map((item) => ({ ...item, depends_on: dependencies }));
      expandedIds.set(node.id, expanded.map((item) => item.id));
      nodes.push(...expanded);
    }
  }
  return { ...workflow, nodes };
}

function validateWorkflowNode(node: unknown, index: number, seen: Set<string>, errors: string[]): void {
  const label = `nodes[${index}]`;
  if (!isRecord(node)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  validateId(node.id, `${label}.id`, seen, errors);
  if (!isNodeKind(node.kind)) errors.push(`${label}.kind is invalid.`);
  if (typeof node.required !== "boolean") errors.push(`${label}.required must be a boolean.`);
  if (node.workstream != null && (typeof node.workstream !== "string" || !node.workstream.trim())) errors.push(`${label}.workstream must be a non-empty string.`);
  if (node.owner != null && (typeof node.owner !== "string" || !node.owner.trim())) errors.push(`${label}.owner must be a non-empty string.`);
  validateStringArray(node.depends_on, `${label}.depends_on`, errors);
  validateStringArray(node.paths, `${label}.paths`, errors);
  validateStringArray(node.command_refs, `${label}.command_refs`, errors);
  if (!isRisk(node.risk)) errors.push(`${label}.risk is invalid.`);
  if (node.route != null && !isRoute(node.route)) errors.push(`${label}.route is invalid.`);
  if (node.fallback != null && !isRoute(node.fallback)) errors.push(`${label}.fallback is invalid.`);
  if (node.effort != null && !["low", "medium", "high"].includes(String(node.effort))) errors.push(`${label}.effort is invalid.`);
  if (node.ticket != null && (typeof node.ticket !== "string" || !node.ticket.trim())) errors.push(`${label}.ticket must be a non-empty string.`);
  if (node.outputs != null && !isRecord(node.outputs)) errors.push(`${label}.outputs must be an object.`);
}

function validateSeedAuthority(data: Record<string, unknown>, seed: WorkflowSeed, errors: string[]): void {
  if (data.objective !== seed.objective) errors.push("compiled objective must match seed objective.");
  if (!isRecord(data.command_catalog)) return;
  for (const [id, command] of Object.entries(data.command_catalog)) {
    if (!seed.command_catalog[id]) errors.push(`compiled workflow introduced unauthorized command ${id}.`);
    else if (JSON.stringify(command) !== JSON.stringify(seed.command_catalog[id])) errors.push(`compiled workflow changed authorized command ${id}.`);
  }
  for (const ref of stringArray(data.final_verification)) if (!seed.final_verification.includes(ref)) errors.push(`final verification command ${ref} was not authorized by seed.`);
  if (!Array.isArray(data.nodes)) return;
  for (const [index, node] of data.nodes.entries()) {
    if (!isRecord(node)) continue;
    for (const ref of stringArray(node.command_refs)) if (!(ref in seed.command_catalog)) errors.push(`nodes[${index}] references unauthorized command ${ref}.`);
    const floor = seed.nodes?.find((item) => item.id === node.id)?.risk_floor;
    if (floor && isRisk(node.risk) && riskRank(node.risk) < riskRank(floor)) errors.push(`nodes[${index}].risk is below seed risk floor ${floor}.`);
  }
}

function validateCommandCatalog(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("command_catalog must be an object.");
    return;
  }
  for (const [id, command] of Object.entries(value)) {
    if (!id.trim()) errors.push("command_catalog keys must be non-empty.");
    if (!isRecord(command) || !Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((part) => typeof part !== "string" || !part)) {
      errors.push(`command_catalog.${id}.argv must be a non-empty string array.`);
    }
    if (isRecord(command) && command.cwd != null && (typeof command.cwd !== "string" || isAbsolute(command.cwd) || command.cwd.split("/").includes(".."))) {
      errors.push(`command_catalog.${id}.cwd must be a safe repo-relative path.`);
    }
  }
}

function validateReference(value: unknown, label: string, ids: Set<string>, errors: string[], forEach = false): void {
  if (value == null && forEach) return;
  const reference = forEach && isRecord(value) ? value.ref : value;
  if (!isRecord(reference) || typeof reference.node !== "string" || typeof reference.output !== "string") {
    errors.push(`${label}${forEach ? ".ref" : ""} must contain string node and output fields.`);
    return;
  }
  if (!ids.has(reference.node)) errors.push(`${label} references unknown node ${reference.node}.`);
}

function validateCondition(value: unknown, label: string, ids: Set<string>, errors: string[]): void {
  if (value == null) return;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  validateReference(value.ref, `${label}.ref`, ids, errors);
  const operators = ["exists", "equals", "in"].filter((key) => key in value);
  if (operators.length !== 1) errors.push(`${label} must use exactly one of exists, equals, or in.`);
  if ("exists" in value && typeof value.exists !== "boolean") errors.push(`${label}.exists must be a boolean.`);
  if ("in" in value && !Array.isArray(value.in)) errors.push(`${label}.in must be an array.`);
}

function pathOwnershipErrors(nodes: WorkflowNode[]): string[] {
  const errors: string[] = [];
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex]!;
      const right = nodes[rightIndex]!;
      if (left.workstream === right.workstream) continue;
      for (const leftPath of left.paths) {
        for (const rightPath of right.paths) {
          if (pathsOverlap(leftPath, rightPath)) errors.push(`write path overlap: ${left.id}:${leftPath} overlaps ${right.id}:${rightPath}`);
        }
      }
    }
  }
  return [...new Set(errors)].sort();
}

function crossWorkstreamDependencyErrors(nodes: WorkflowNode[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const errors: string[] = [];
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      const upstream = byId.get(dependency);
      if (upstream && upstream.workstream !== node.workstream && upstream.kind !== "shared_contract") {
        errors.push(`cross-workstream implementation dependency: ${node.id} depends on ${dependency}`);
      }
    }
  }
  return errors.sort();
}

function cycleErrors(nodes: WorkflowNode[]): string[] {
  const dependencies = new Map(nodes.map((node) => [node.id, node.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const errors: string[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      errors.push(`workflow dependency cycle includes ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
  return [...new Set(errors)];
}

function maxRoute(left: ModelRoute, right: ModelRoute): ModelRoute {
  const order: ModelRoute[] = ["fast", "balanced", "deep"];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

function riskRank(risk: RiskLevel): number {
  return RISK_ORDER.indexOf(risk);
}

function pathsOverlap(left: string, right: string): boolean {
  const a = left.replace(/\/+$/, "") || ".";
  const b = right.replace(/\/+$/, "") || ".";
  return a === "." || b === "." || a === "*" || b === "*" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function validateId(value: unknown, label: string, seen: Set<string>, errors: string[]): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) errors.push(`${label} is invalid.`);
  else if (seen.has(value)) errors.push(`duplicate node id: ${value}`);
  else seen.add(value);
}

function validateStringArray(value: unknown, label: string, errors: string[], optional = false): void {
  if (value == null && optional) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) errors.push(`${label} must be an array of strings.`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRisk(value: unknown): value is RiskLevel {
  return RISK_ORDER.includes(value as RiskLevel);
}

function isRoute(value: unknown): value is ModelRoute {
  return value === "fast" || value === "balanced" || value === "deep";
}

function isNodeKind(value: unknown): boolean {
  return ["scout", "planner", "shared_contract", "implementer", "verifier", "repair"].includes(String(value));
}

function isWorkflowNodeLike(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.depends_on);
}
