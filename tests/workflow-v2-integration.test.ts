import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { run } from "../src/process.js";
import type { CompiledWorkflow, WorkflowNode, WorkflowSeed } from "../src/types.js";

describe("hybrid worker v2 integration", () => {
  it("runs read-only scouts and a fake planner from workflow_seed alone", async () => {
    const { root, repo } = initRepo();
    const seed: WorkflowSeed = {
      version: 2,
      objective: "plan from seed",
      command_catalog: { final: { argv: ["true"] } },
      final_verification: ["final"]
    };
    write(join(repo, "workflow_seed.json"), JSON.stringify(seed));
    commit(repo, "add seed");
    const scout = executable(
      join(root, "scout.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(process.env.CPW_AGENT_OUTPUT_FILE, JSON.stringify({findings: [], recommended_nodes: []}));`
    );
    const planner = executable(
      join(root, "planner.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.CPW_AGENT_OUTPUT_FILE, JSON.stringify({
        version: 2,
        objective: "plan from seed",
        command_catalog: { final: { argv: ["true"] } },
        nodes: [{
          id: "only", kind: "implementer", required: true, workstream: "core", depends_on: [], paths: ["only.txt"],
          ticket_text: "Create only.txt.", command_refs: [], risk: "low"
        }],
        final_verification: ["final"]
      }));
      `
    );
    const reportPath = join(root, "seed-plan-report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--workflow-seed",
      "workflow_seed.json",
      "--workflow-plan-only",
      "--executor",
      "fake-command",
      "--fake-scout",
      `test_mapper:node ${scout}`,
      "--fake-planner",
      `node ${planner}`,
      "--run-dir",
      join(root, "seed-plan"),
      "--worktree-root",
      join(root, "seed-plan-worktrees"),
      "--json-report",
      reportPath
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const compiled = JSON.parse(readFileSync(report.planning.workflow_file, "utf8"));
    expect(code).toBe(0);
    expect(report.execution_mode).toBe("single_layer");
    expect(report.planning.scout_outputs.test_mapper).toMatchObject({ findings: [] });
    expect(report.planning.usage).toHaveProperty("planner");
    expect(compiled.nodes[0].ticket).toContain("tickets/only.md");
    expect(readFileSync(compiled.nodes[0].ticket, "utf8")).toContain("Create only.txt");
  });

  it("plans exactly three manager worktrees only for a safe large workflow", async () => {
    const { root, repo } = initRepo();
    const workflow = largeWorkflow();
    const seed: WorkflowSeed = {
      version: 2,
      objective: workflow.objective,
      command_catalog: workflow.command_catalog,
      final_verification: workflow.final_verification
    };
    write(join(repo, "workflow_seed.json"), JSON.stringify(seed));
    write(join(repo, "compiled_workflow.json"), JSON.stringify(workflow));
    for (const node of workflow.nodes) write(join(repo, node.ticket!), `Implement ${node.id}.`);
    commit(repo, "add workflow");
    const base = run(["git", "rev-parse", "HEAD"], repo).stdout.trim();
    const reportPath = join(root, "planned-report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--workflow-seed",
      "workflow_seed.json",
      "--compiled-workflow",
      "compiled_workflow.json",
      "--workflow-plan-only",
      "--run-id",
      "hierarchy",
      "--run-dir",
      join(root, "parent"),
      "--worktree-root",
      join(root, "worktrees"),
      "--json-report",
      reportPath
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(code).toBe(0);
    expect(report.execution_mode).toBe("hierarchical");
    expect(report.managers).toHaveLength(3);
    expect(new Set(report.managers.map((manager: any) => manager.branch)).size).toBe(3);
    expect(new Set(report.managers.map((manager: any) => manager.worktree)).size).toBe(3);
    expect(new Set(report.managers.map((manager: any) => manager.run_dir)).size).toBe(3);
    expect(report.managers.every((manager: any) => manager.command.includes("--manager-id") && manager.command.includes("--broker-dir"))).toBe(true);
    expect(run(["git", "rev-parse", "HEAD"], repo).stdout.trim()).toBe(base);
    expect(run(["git", "status", "--porcelain"], repo).stdout.trim()).toBe("");
  });

  it("runs independent verification and one deep repair before merge", async () => {
    const { root, repo } = initRepo();
    write(
      join(repo, "check.mjs"),
      `import { readFileSync } from "node:fs"; process.exit(readFileSync("add.txt", "utf8").trim() === "good" ? 0 : 1);`
    );
    write(join(repo, "ticket.md"), "Create add.txt containing good.");
    const workflow: CompiledWorkflow = {
      version: 2,
      objective: "repair one implementation",
      command_catalog: { focused: { argv: ["node", "check.mjs"] } },
      nodes: [workflowNode("add", "ticket.md", "medium", ["add.txt"], ["focused"])],
      final_verification: ["focused"],
      shared_contract_frozen: true
    };
    write(join(repo, "compiled_workflow.json"), JSON.stringify(workflow));
    commit(repo, "add v2 repair fixture");
    const implementer = executable(
      join(root, "implementer.mjs"),
      closeoutScript("bad", false)
    );
    const repair = executable(join(root, "repair.mjs"), closeoutScript("good", false));
    const verifier = executable(
      join(root, "verifier.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "add", decision: "PASS", issues_found: [], fixes_applied: [], tests_run: [], tests_passed: true, merge_risk: "low"
      }));
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--compiled-workflow",
      "compiled_workflow.json",
      "--executor",
      "fake-command",
      "--fake-implementer",
      `add:node ${implementer}`,
      "--fake-repair",
      `add:node ${repair}`,
      "--fake-verifier",
      `add:node ${verifier}`,
      "--run-dir",
      join(root, "run"),
      "--worktree-root",
      join(root, "worktrees"),
      "--json-report",
      reportPath,
      "--merge"
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(code).toBe(0);
    expect(report.status).toBe("merged");
    expect(report.workers[0].repair.stage).toBe("repair");
    expect(report.workers[0].verification_votes).toEqual({ passed: 1, required: 1, total: 1 });
    expect(report.workers[0].verification).toHaveLength(1);
    expect(report.routing.add).toMatchObject({ route: "balanced", model: "sonnet" });
    expect(report.broker.calls_started).toBe(3);
    expect(readFileSync(join(repo, "add.txt"), "utf8")).toBe("good\n");
  });

  it("keeps the base unchanged on manager failure and later reuses successful branches", async () => {
    const { root, repo } = initRepo();
    const workflow = largeWorkflow();
    write(join(repo, "compiled_workflow.json"), JSON.stringify(workflow));
    for (const node of workflow.nodes) write(join(repo, node.ticket!), `Implement ${node.id}.`);
    commit(repo, "add hierarchy fixture");
    const base = run(["git", "rev-parse", "HEAD"], repo).stdout.trim();
    const plannedReport = join(root, "planned.json");
    await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--compiled-workflow",
      "compiled_workflow.json",
      "--workflow-plan-only",
      "--run-id",
      "resume-run",
      "--run-dir",
      join(root, "parent"),
      "--worktree-root",
      join(root, "worktrees"),
      "--json-report",
      plannedReport
    ]);
    const planned = JSON.parse(readFileSync(plannedReport, "utf8"));
    for (const [index, manager] of planned.managers.entries()) {
      write(join(manager.worktree, `${manager.manager_id}.txt`), `${manager.manager_id}\n`);
      commit(manager.worktree, `manager ${manager.manager_id}`);
      write(join(manager.run_dir, "report.json"), JSON.stringify({ status: index === 1 ? "rejected" : "merged", manager: { id: manager.manager_id } }));
    }
    const failedReport = join(root, "failed-finalize.json");
    const failed = await main(["--finalize-parent-run", join(root, "parent"), "--json-report", failedReport]);
    expect(failed).toBe(1);
    expect(JSON.parse(readFileSync(failedReport, "utf8")).status).toBe("manager_failed");
    expect(run(["git", "rev-parse", "HEAD"], repo).stdout.trim()).toBe(base);
    expect(planned.managers.every((manager: any) => run(["git", "rev-parse", "--verify", manager.branch], repo, { check: false }).returncode === 0)).toBe(true);

    for (const manager of planned.managers) {
      write(join(manager.run_dir, "report.json"), JSON.stringify({ status: "merged", manager: { id: manager.manager_id } }));
    }
    const successReport = join(root, "successful-finalize.json");
    const succeeded = await main(["--finalize-parent-run", join(root, "parent"), "--json-report", successReport]);
    const finalReport = JSON.parse(readFileSync(successReport, "utf8"));
    expect(succeeded).toBe(0);
    expect(finalReport.status).toBe("merged");
    expect(finalReport.final_transaction.merged).toBe(true);
    expect(run(["git", "rev-parse", "HEAD"], repo).stdout.trim()).not.toBe(base);
    for (const manager of planned.managers) expect(readFileSync(join(repo, `${manager.manager_id}.txt`), "utf8")).toContain(manager.manager_id);
  });

  it("opens the circuit after a pilot when the next batch has no runnable tests", async () => {
    const { root, repo } = initRepo();
    const nodes = ["a", "b", "c"].map((id) => workflowNode(id, `${id}.md`, "low", [`${id}.txt`], []));
    for (const node of nodes) write(join(repo, node.ticket!), `Create ${node.id}.txt.`);
    const workflow: CompiledWorkflow = {
      version: 2,
      objective: "circuit fixture",
      command_catalog: { final: { argv: ["true"] } },
      nodes,
      final_verification: ["final"]
    };
    write(join(repo, "compiled_workflow.json"), JSON.stringify(workflow));
    commit(repo, "add circuit fixture");
    const commands = Object.fromEntries(
      nodes.map((node) => [node.id, executable(join(root, `${node.id}.mjs`), closeoutScript(node.id, false, `${node.id}.txt`))])
    );
    const reportPath = join(root, "circuit-report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--compiled-workflow",
      "compiled_workflow.json",
      "--executor",
      "fake-command",
      ...nodes.flatMap((node) => ["--fake-implementer", `${node.id}:node ${commands[node.id]}`]),
      "--run-dir",
      join(root, "circuit-run"),
      "--worktree-root",
      join(root, "circuit-worktrees"),
      "--json-report",
      reportPath
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(code).toBe(1);
    expect(report.pilot).toBe("a");
    expect(report.blocked_nodes).toEqual(["b", "c"]);
    expect(report.workers.find((worker: any) => worker.name === "a").accepted).toBe(true);
    expect(report.workers.filter((worker: any) => worker.blocked)).toHaveLength(2);
    expect(report.broker.calls_started).toBe(1);
  });
});

function initRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "hybrid-worker-v2-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  run(["git", "init", "-b", "main"], repo);
  run(["git", "config", "user.email", "test@example.invalid"], repo);
  run(["git", "config", "user.name", "Test User"], repo);
  write(join(repo, "TASK.md"), "Execute the compiled workflow.");
  commit(repo, "base");
  return { root, repo };
}

function largeWorkflow(): CompiledWorkflow {
  const nodes = ["a", "b", "c"].flatMap((workstream) =>
    Array.from({ length: 4 }, (_, index) => workflowNode(`${workstream}-${index + 1}`, `${workstream}-${index + 1}.md`, "low", [`domain-${workstream}/${index + 1}`], ["test"]))
  );
  return {
    version: 2,
    objective: "large safe workflow",
    command_catalog: { test: { argv: ["true"] } },
    nodes,
    final_verification: ["test"],
    shared_contract_frozen: true
  };
}

function workflowNode(id: string, ticket: string, risk: "low" | "medium", paths: string[], commandRefs: string[]): WorkflowNode {
  return {
    id,
    kind: "implementer",
    required: true,
    workstream: id.split("-")[0]!,
    depends_on: [],
    paths,
    ticket,
    command_refs: commandRefs,
    risk
  };
}

function closeoutScript(content: string, withDecision: boolean, output = "add.txt"): string {
  return `
    import { writeFileSync } from "node:fs";
    writeFileSync("${output}", "${content}\\n");
    writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
      worker: process.env.CPW_WORKER, summary: "wrote ${output}", changed_files: ["${output}"], tests_run: [], tests_passed: true, risks: [], needs_codex_attention: false
    }));
    ${withDecision ? "writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({worker: process.env.CPW_WORKER, decision: 'PASS', issues_found: [], fixes_applied: [], tests_run: [], tests_passed: true, merge_risk: 'low'}));" : ""}
    console.log("SELF_EVALUATION: PASS");
  `;
}

function executable(path: string, text: string): string {
  write(path, text);
  chmodSync(path, 0o755);
  return path;
}

function write(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
}

function commit(repo: string, message: string): void {
  run(["git", "add", "-A"], repo);
  run(["git", "commit", "-m", message], repo);
}
