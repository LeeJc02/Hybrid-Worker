import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResourceBroker } from "./broker.js";
import { baseWorktreeDirty } from "./git.js";
import { writeJson } from "./json.js";
import { runToLog } from "./process.js";
import { claudeResultText, loadFirstJsonObject, parseClaudePayloadFromLog, parseClaudeUsage } from "./usage.js";
import { materializeDeclarativeWorkflow, validateCompiledWorkflow } from "./workflow.js";
import type { CliOptions, CompiledWorkflow, Usage, WorkflowSeed } from "./types.js";

export interface PlanningResult {
  workflow: CompiledWorkflow;
  workflow_file: string;
  scout_outputs: Record<string, unknown>;
  usage: Record<string, Usage>;
}

export async function compileWorkflowFromSeed(input: {
  repo: string;
  seed: WorkflowSeed;
  prework: Record<string, unknown>;
  runDir: string;
  args: CliOptions;
}): Promise<PlanningResult> {
  const requiredScouts = Array.isArray(input.prework.required_scouts)
    ? input.prework.required_scouts.filter((item): item is string => typeof item === "string")
    : [];
  const scoutOutputs: Record<string, unknown> = {};
  const usage: Record<string, Usage> = {};
  await Promise.all(
    requiredScouts.map(async (scout) => {
      const result = await runReadOnlyAgent({
        name: scout,
        route: "fast",
        model: "haiku",
        prompt: scoutPrompt(scout, input.seed, input.prework),
        repo: input.repo,
        runDir: input.runDir,
        args: input.args,
        ...(input.args.fakeScouts[scout] ? { fakeCommand: input.args.fakeScouts[scout] } : {})
      });
      scoutOutputs[scout] = result.output;
      usage[scout] = result.usage;
    })
  );
  const planner = await runReadOnlyAgent({
    name: "planner",
    route: "deep",
    model: "opus",
    prompt: plannerPrompt(input.seed, input.prework, scoutOutputs),
    repo: input.repo,
    runDir: input.runDir,
    args: input.args,
    ...(input.args.fakePlanner ? { fakeCommand: input.args.fakePlanner } : {})
  });
  usage.planner = planner.usage;
  const candidate = unwrapWorkflow(planner.output);
  const errors = validateCompiledWorkflow(candidate, input.seed);
  if (errors.length) throw new Error(`planner compiled_workflow.json schema errors:\n${errors.join("\n")}`);
  const workflow = materializeTickets(materializeDeclarativeWorkflow(candidate as CompiledWorkflow), input.runDir);
  const workflowFile = join(input.runDir, "compiled_workflow.json");
  writeJson(workflowFile, workflow);
  return { workflow, workflow_file: workflowFile, scout_outputs: scoutOutputs, usage };
}

async function runReadOnlyAgent(input: {
  name: string;
  route: "fast" | "deep";
  model: "haiku" | "opus";
  prompt: string;
  repo: string;
  runDir: string;
  args: CliOptions;
  fakeCommand?: string;
}): Promise<{ output: unknown; usage: Usage }> {
  const brokerRoot = input.args.brokerDir ?? join(input.runDir, "broker");
  input.args.brokerDir = brokerRoot;
  const broker = new ResourceBroker(brokerRoot, {
    maxReadonly: input.args.brokerMaxReadonly,
    maxWrite: input.args.brokerMaxWrite,
    maxCalls: input.args.brokerMaxCalls,
    maxCostUsd: input.args.brokerMaxCostUsd,
    leaseSec: input.args.brokerLeaseSec
  });
  const lease = await broker.acquire("readonly", `${input.args.runId}:${input.name}`, input.args.workerTimeoutSec);
  const logFile = join(input.runDir, `${input.name}.log`);
  const outputFile = join(input.runDir, `${input.name}.output.json`);
  let usage: Usage = { status: "not_observed", reason: "planning agent did not expose usage" };
  try {
    const dirtyBefore = baseWorktreeDirty(input.repo);
    if (dirtyBefore) throw new Error(`base repo is dirty before ${input.name}:\n${dirtyBefore}`);
    if (input.args.executor === "fake-command") {
      if (!input.fakeCommand) throw new Error(`missing fake ${input.name} command`);
      const result = await runToLog(["/bin/sh", "-lc", input.fakeCommand], input.repo, logFile, {
        env: { ...process.env, CPW_AGENT_OUTPUT_FILE: outputFile },
        timeoutSec: input.args.workerTimeoutSec
      });
      if (result.returncode !== 0) throw new Error(`${input.name} exited ${result.returncode}`);
    } else {
      const result = await runToLog(
        [
          input.args.claudeBin,
          "-p",
          "--output-format",
          "json",
          "--disable-slash-commands",
          "--model",
          input.model,
          "--no-session-persistence",
          "--permission-mode",
          "plan"
        ],
        input.repo,
        logFile,
        { inputText: input.prompt, timeoutSec: input.args.workerTimeoutSec }
      );
      if (result.returncode !== 0) throw new Error(`${input.name} exited ${result.returncode}`);
      const payload = parseClaudePayloadFromLog(logFile);
      usage = parseClaudeUsage(payload);
      const output = loadFirstJsonObject(stripFences(claudeResultText(payload)));
      if (output == null) throw new Error(`${input.name} did not return JSON`);
      writeJson(outputFile, output);
    }
    const dirtyAfter = baseWorktreeDirty(input.repo);
    if (dirtyAfter) throw new Error(`${input.name} modified the read-only base repo:\n${dirtyAfter}`);
    const output = existsSync(outputFile)
      ? (JSON.parse(readFileSync(outputFile, "utf8")) as unknown)
      : loadFirstJsonObject(readFileSync(logFile, "utf8"));
    if (output == null) throw new Error(`${input.name} did not produce parseable JSON`);
    writeJson(join(input.runDir, `${input.name}.usage.json`), usage);
    return { output, usage };
  } finally {
    broker.release(lease.id, typeof usage.total_cost_usd === "number" ? usage.total_cost_usd : 0);
  }
}

function materializeTickets(workflow: CompiledWorkflow, runDir: string): CompiledWorkflow {
  const ticketsDir = join(runDir, "tickets");
  mkdirSync(ticketsDir, { recursive: true });
  const nodes = workflow.nodes.map((node) => {
    if (node.kind !== "implementer" || node.ticket) return node;
    if (!node.ticket_text) throw new Error(`planner implementer node ${node.id} must provide ticket or ticket_text`);
    const ticket = join(ticketsDir, `${node.id}.md`);
    writeFileSync(ticket, `${node.ticket_text.trim()}\n`, "utf8");
    return { ...node, ticket };
  });
  return { ...workflow, nodes };
}

function unwrapWorkflow(output: unknown): unknown {
  if (isRecord(output) && isRecord(output.compiled_workflow)) return output.compiled_workflow;
  return output;
}

function scoutPrompt(name: string, seed: WorkflowSeed, prework: Record<string, unknown>): string {
  return `You are the read-only ${name} scout for hybrid-worker v2. Do not edit files or run setup. Return one compact JSON object with findings, risks, paths, and recommended node boundaries.\nSeed:\n${JSON.stringify(seed)}\nPrework:\n${JSON.stringify(prework)}`;
}

function plannerPrompt(seed: WorkflowSeed, prework: Record<string, unknown>, scouts: Record<string, unknown>): string {
  return `You are the deep read-only planner for hybrid-worker v2. Return only a compiled workflow JSON object. Do not edit files and do not emit shell commands or JavaScript. Preserve objective and command_catalog exactly. Tests/setup may reference only command_catalog IDs. Use depends_on, structured inputs, restricted when/for_each, workstream, paths, risk, route, effort, and fallback. Never lower seed risk floors. Every implementer must include ticket or ticket_text. Shared paths need one owner.\nSeed:\n${JSON.stringify(seed)}\nPrework:\n${JSON.stringify(prework)}\nScout outputs:\n${JSON.stringify(scouts)}`;
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
