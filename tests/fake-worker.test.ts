import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { run } from "../src/process.js";

function write(path: string, text: string): string {
  writeFileSync(path, text.trimStart(), "utf8");
  return path;
}

function executable(path: string, text: string): string {
  write(path, text);
  chmodSync(path, 0o755);
  return path;
}

describe("fake worker integration", () => {
  it("runs two isolated fake workers and merges accepted branches", async () => {
    const { root, repo } = initRepo();

    const worker = executable(
      join(root, "worker.mjs"),
      `
      import { writeFileSync } from "node:fs";
      const [name, output] = process.argv.slice(2);
      writeFileSync(output, name + "\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: name,
        summary: "created " + output,
        changed_files: [output],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: name,
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );

    const reportPath = join(root, "report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--worker",
      "add:ticket-add.md",
      "--worker",
      "mul:ticket-mul.md",
      "--worker-test",
      "add:test -f add.txt",
      "--worker-test",
      "mul:test -f mul.txt",
      "--test",
      "test -f add.txt && test -f mul.txt",
      "--executor",
      "fake-command",
      "--fake-implementer",
      `add:node ${worker} add add.txt`,
      "--fake-implementer",
      `mul:node ${worker} mul mul.txt`,
      "--run-dir",
      join(root, "run"),
      "--worktree-root",
      join(root, "worktrees"),
      "--json-report",
      reportPath,
      "--merge"
    ]);

    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.status).toBe("merged");
    expect(report.workers).toHaveLength(2);
    expect(report.workers.every((workerResult: any) => workerResult.accepted && workerResult.merged)).toBe(true);
    expect(readFileSync(join(repo, "add.txt"), "utf8")).toBe("add\n");
    expect(readFileSync(join(repo, "mul.txt"), "utf8")).toBe("mul\n");
    expect(readFileSync(join(root, "run", "add.tests.log"), "utf8")).toContain("$ test -f add.txt");
  });

  it("rejects a worker that omits reviewer_decision.json", async () => {
    const { root, repo } = initRepo();
    const worker = executable(
      join(root, "missing-decision.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync("add.txt", "add\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "add",
        summary: "created add.txt",
        changed_files: ["add.txt"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main(baseArgs(root, repo, reportPath, [`add:node ${worker}`]));
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(1);
    expect(report.status).toBe("rejected");
    expect(report.workers[0].accepted).toBe(false);
    expect(report.workers[0].findings.join("\n")).toContain("Missing reviewer_decision.json.");
  });

  it("rejects out-of-scope changes even when worker self-evaluates PASS", async () => {
    const { root, repo } = initRepo();
    const worker = executable(join(root, "out-of-scope.mjs"), passWorkerScript("add", "add.txt"));
    const reportPath = join(root, "report.json");
    const code = await main([...baseArgs(root, repo, reportPath, [`add:node ${worker}`]), "--allowed-path", "add:src"]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(1);
    expect(report.status).toBe("rejected");
    expect(report.workers[0].findings.join("\n")).toContain("Changed path outside allowed scope: add.txt");
    expect(report.workers[0].finding_details).toContainEqual(expect.objectContaining({ code: "out_of_scope_change", path: "add.txt" }));
  });

  it("dry-runs preflight without starting workers and records events", async () => {
    const { root, repo } = initRepo();
    const reportPath = join(root, "dry-run-report.json");
    const eventsPath = join(root, "dry-run-events.ndjson");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--worker",
      "add:ticket-add.md",
      "--allowed-path",
      "add:src",
      "--dry-run",
      "--json-report",
      reportPath,
      "--events-file",
      eventsPath
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(code).toBe(0);
    expect(report.status).toBe("preflight_ok");
    expect(report.workers).toEqual([]);
    expect(report.preflight.ok).toBe(true);
    expect(report.events_file).toBe(eventsPath);
    expect(events.map((event) => event.type)).toEqual(["run_started", "preflight_completed", "run_finished"]);
  });

  it("loads workers, tests, setup, and final verification from worker_plan.json", async () => {
    const { root, repo } = initRepo();
    write(
      join(repo, "worker_plan.json"),
      JSON.stringify({
        run_id: "plan-run",
        model: "plan-model",
        shared_setup: ["echo shared setup"],
        phases: [
          {
            name: "implementation",
            parallel: true,
            workers: [
              {
                name: "add",
                ticket: "ticket-add.md",
                allowed_paths: ["add.txt"],
                worker_tests: ["test -f add.txt"]
              }
            ],
            final_tests: ["test -f add.txt"]
          }
        ],
        final_verification: ["test -f add.txt"]
      })
    );
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "add worker plan"], repo);
    const worker = executable(join(root, "plan-worker.mjs"), passWorkerScript("add", "add.txt"));
    const reportPath = join(root, "plan-report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--plan-file",
      "worker_plan.json",
      "--executor",
      "fake-command",
      "--fake-implementer",
      `add:node ${worker}`,
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
    expect(report.run_id).toBe("plan-run");
    expect(report.model).toBe("plan-model");
    expect(report.environment_policy.common_setup).toEqual(["echo shared setup"]);
  });

  it("executes ordered plan phases on top of the integration branch", async () => {
    const { root, repo } = initRepo();
    write(
      join(repo, "worker_plan.json"),
      JSON.stringify({
        run_id: "ordered-phases",
        phases: [
          {
            name: "schema",
            parallel: false,
            workers: [
              {
                name: "schema",
                ticket: "ticket-add.md",
                allowed_paths: ["schema.txt"],
                worker_tests: ["test -f schema.txt"]
              }
            ],
            final_tests: ["test -f schema.txt"]
          },
          {
            name: "app",
            parallel: false,
            workers: [
              {
                name: "app",
                ticket: "ticket-mul.md",
                allowed_paths: ["app.txt"],
                worker_tests: ["test -f app.txt"]
              }
            ]
          }
        ],
        final_verification: ["test -f schema.txt && test -f app.txt"]
      })
    );
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "add ordered plan"], repo);
    const schemaWorker = executable(join(root, "schema-worker.mjs"), passWorkerScript("schema", "schema.txt"));
    const appWorker = executable(
      join(root, "app-worker.mjs"),
      `
      import { readFileSync, writeFileSync } from "node:fs";
      const schema = readFileSync("schema.txt", "utf8").trim();
      writeFileSync("app.txt", "uses " + schema + "\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "app",
        summary: "created app from schema",
        changed_files: ["app.txt"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "app",
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "ordered-report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--plan-file",
      "worker_plan.json",
      "--executor",
      "fake-command",
      "--fake-implementer",
      `schema:node ${schemaWorker}`,
      "--fake-implementer",
      `app:node ${appWorker}`,
      "--run-dir",
      join(root, "run"),
      "--worktree-root",
      join(root, "worktrees"),
      "--json-report",
      reportPath,
      "--merge"
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const events = readFileSync(join(root, "run", "events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(code).toBe(0);
    expect(report.status).toBe("merged");
    expect(report.execution_phases.map((phase: any) => phase.name)).toEqual(["schema", "app"]);
    expect(report.workers.map((worker: any) => worker.name).sort()).toEqual(["app", "schema"]);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("uses schema\n");
    expect(readFileSync(join(root, "run", "phase-schema.tests.log"), "utf8")).toContain("test -f schema.txt");
    expect(events.filter((event: any) => event.type === "phase_started").map((event: any) => event.data.phase)).toEqual(["schema", "app"]);
  });

  it("can emit machine-readable JSON without human progress lines", async () => {
    const { root, repo } = initRepo();
    const worker = executable(join(root, "json-worker.mjs"), passWorkerScript("add", "add.txt"));
    const reportPath = join(root, "json-report.json");
    let output = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      output += String(chunk);
      return true;
    });
    const code = await main([...baseArgs(root, repo, reportPath, [`add:node ${worker}`]), "--json"]);
    spy.mockRestore();
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const stdoutJson = JSON.parse(output);

    expect(code).toBe(0);
    expect(report.status).toBe("accepted");
    expect(stdoutJson.status).toBe("accepted");
    expect(stdoutJson.report_path).toBe(reportPath);
  });

  it("can keep generated artifact ignore policy local to git metadata", async () => {
    const { root, repo } = initRepo();
    const worker = executable(join(root, "local-ignore-worker.mjs"), passWorkerScript("add", "add.txt"));
    const reportPath = join(root, "local-ignore-report.json");
    const code = await main([...baseArgs(root, repo, reportPath, [`add:node ${worker}`]), "--repo-ignore-policy", "local"]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(0);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain("hybrid-worker generated artifacts");
    expect(report.environment_policy.repo_ignore_policy).toBe("local");
    expect(report.resume_commands.accepted_branch_args).toEqual([expect.stringContaining("--accepted-branch add:hybrid-worker/add-")]);
  });

  it("cleans untracked generated artifacts before diff and merge", async () => {
    const { root, repo } = initRepo();
    const worker = executable(
      join(root, "generated-artifacts.mjs"),
      `
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync("src", { recursive: true });
      mkdirSync("node_modules/pkg", { recursive: true });
      mkdirSync("dist", { recursive: true });
      writeFileSync("src/App.vue", "<template />\\n", "utf8");
      writeFileSync("node_modules/pkg/cache.js", "cache\\n", "utf8");
      writeFileSync("dist/bundle.js", "bundle\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "add",
        summary: "created source and generated artifacts",
        changed_files: ["src/App.vue"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "add",
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main([
      ...baseArgs(root, repo, reportPath, [`add:node ${worker}`]),
      "--allowed-path",
      "add:src",
      "--worker-test",
      "add:test -f src/App.vue",
      "--test",
      "test -f src/App.vue",
      "--merge"
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(0);
    expect(report.status).toBe("merged");
    expect(report.workers[0].changed_paths).toEqual(["src/App.vue"]);
    expect(() => readFileSync(join(repo, "node_modules/pkg/cache.js"), "utf8")).toThrow();
    expect(() => readFileSync(join(repo, "dist/bundle.js"), "utf8")).toThrow();
  });

  it("restores unowned scaffold changes before gating worker diffs", async () => {
    const { root, repo } = initRepo();
    write(join(repo, "worker_plan.json"), JSON.stringify({ run_id: "base-plan" }));
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "add scaffold plan"], repo);
    const worker = executable(
      join(root, "scaffold-polluter.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync("add.txt", "add\\n", "utf8");
      writeFileSync("worker_plan.json", JSON.stringify({ run_id: "mutated-by-worker" }), "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "add",
        summary: "created add.txt but touched scaffold",
        changed_files: ["add.txt"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "add",
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main([
      ...baseArgs(root, repo, reportPath, [`add:node ${worker}`]),
      "--allowed-path",
      "add:add.txt",
      "--worker-test",
      "add:test -f add.txt",
      "--test",
      "test -f add.txt",
      "--merge"
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(0);
    expect(report.status).toBe("merged");
    expect(report.workers[0].changed_paths).toEqual(["add.txt"]);
    expect(readFileSync(join(repo, "worker_plan.json"), "utf8")).toBe(JSON.stringify({ run_id: "base-plan" }));
  });

  it("reuses an accepted branch without rerunning a worker", async () => {
    const { root, repo } = initRepo();
    run(["git", "checkout", "-b", "accepted/add"], repo);
    write(join(repo, "add.txt"), "add\n");
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "accepted add"], repo);
    run(["git", "checkout", "main"], repo);

    const reportPath = join(root, "report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--accepted-branch",
      "add:accepted/add",
      "--allowed-path",
      "add:add.txt",
      "--test",
      "test -f add.txt",
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
    expect(report.workers[0].reused).toBe(true);
    expect(report.workers[0].merged).toBe(true);
    expect(readFileSync(join(repo, "add.txt"), "utf8")).toBe("add\n");
  });

  it("rejects tracked generated artifact changes even when broad paths are allowed", async () => {
    const { root, repo } = initRepo();
    mkdirSync(join(repo, "dist"), { recursive: true });
    write(join(repo, "dist", "tracked.js"), "old\n");
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "tracked generated artifact"], repo);
    const worker = executable(
      join(root, "tracked-artifact.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync("dist/tracked.js", "new\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "add",
        summary: "changed tracked generated artifact",
        changed_files: ["dist/tracked.js"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "add",
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main([...baseArgs(root, repo, reportPath, [`add:node ${worker}`]), "--allowed-path", "add:."]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(1);
    expect(report.status).toBe("rejected");
    expect(report.workers[0].findings.join("\n")).toContain("Generated/intermediate artifact changed: dist/tracked.js");
  });

  it("allows explicit fallback to repair missing decision JSON", async () => {
    const { root, repo } = initRepo();
    const worker = executable(
      join(root, "fallback-needed.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync("add.txt", "add\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "add",
        summary: "created add.txt",
        changed_files: ["add.txt"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const fallback = executable(
      join(root, "fallback.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "add",
        decision: "PASS",
        issues_found: [],
        fixes_applied: ["wrote missing decision"],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main([
      ...baseArgs(root, repo, reportPath, [`add:node ${worker}`]),
      "--worker-test",
      "add:test -f add.txt",
      "--test",
      "test -f add.txt",
      "--codex-fallback-command",
      `node ${fallback}`,
      "--merge"
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(0);
    expect(report.status).toBe("merged");
    expect(report.workers[0].codex_fallback_applied).toBe(true);
    expect(report.workers[0].accepted).toBe(true);
  });

  it("rejects a worker that writes to the protected base repo", async () => {
    const { root, repo } = initRepo();
    const worker = executable(
      join(root, "base-polluter.mjs"),
      `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      writeFileSync("add.txt", "add\\n", "utf8");
      writeFileSync(join(process.env.CPW_BASE_REPO, "polluted.txt"), "bad\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "add",
        summary: "created add.txt but polluted base",
        changed_files: ["add.txt"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "add",
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main(baseArgs(root, repo, reportPath, [`add:node ${worker}`]));
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(1);
    expect(report.status).toBe("rejected");
    expect(report.workers[0].findings.join("\n")).toContain("Base worktree was modified during worker run");
  });

  it("runs automatic npm setup before worker and final tests", async () => {
    const { root, repo } = initRepo();
    const worker = executable(
      join(root, "frontend-worker.mjs"),
      `
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync("frontend", { recursive: true });
      writeFileSync("frontend/package.json", JSON.stringify({
        scripts: {
          test: "node -e \\"require('fs').writeFileSync('test-ran.txt','ok\\\\n')\\""
        }
      }), "utf8");
      writeFileSync("frontend/app.js", "console.log('ok')\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "frontend",
        summary: "created frontend package",
        changed_files: ["frontend/package.json", "frontend/app.js"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "frontend",
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--worker",
      "frontend:ticket-add.md",
      "--allowed-path",
      "frontend:frontend",
      "--worker-test",
      "frontend:npm --prefix frontend run test",
      "--test",
      "npm --prefix frontend run test",
      "--executor",
      "fake-command",
      "--fake-implementer",
      `frontend:node ${worker}`,
      "--run-dir",
      join(root, "run"),
      "--worktree-root",
      join(root, "worktrees"),
      "--json-report",
      reportPath,
      "--merge"
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const workerLog = readFileSync(join(root, "run", "frontend.tests.log"), "utf8");
    const finalLog = readFileSync(join(root, "run", "final.tests.log"), "utf8");

    expect(code).toBe(0);
    expect(report.status).toBe("merged");
    expect(workerLog).toMatch(/npm --prefix 'frontend' (install|ci) --no-audit --no-fund/);
    expect(finalLog).toMatch(/npm --prefix 'frontend' (install|ci) --no-audit --no-fund/);
    expect(readFileSync(join(repo, "frontend", "test-ran.txt"), "utf8")).toBe("ok\n");
  });

  it("uses an explicit merge conflict command to resolve integration conflicts", async () => {
    const { root, repo } = initRepo();
    write(join(repo, "shared.txt"), "base\n");
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "shared base"], repo);

    const worker = executable(
      join(root, "conflict-worker.mjs"),
      `
      import { writeFileSync } from "node:fs";
      const value = process.argv[2];
      writeFileSync("shared.txt", value + "\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: value,
        summary: "changed shared file",
        changed_files: ["shared.txt"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: value,
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "medium"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const resolver = executable(
      join(root, "resolver.mjs"),
      `
      import { execFileSync } from "node:child_process";
      import { writeFileSync } from "node:fs";
      writeFileSync("shared.txt", "resolved\\n", "utf8");
      execFileSync("git", ["add", "shared.txt"]);
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main([
      "--repo",
      repo,
      "--task-file",
      "TASK.md",
      "--worker",
      "left:ticket-add.md",
      "--worker",
      "right:ticket-mul.md",
      "--allowed-path",
      "left:shared.txt",
      "--allowed-path",
      "right:shared.txt",
      "--test",
      "test \"$(cat shared.txt)\" = resolved",
      "--executor",
      "fake-command",
      "--fake-implementer",
      `left:node ${worker} left`,
      "--fake-implementer",
      `right:node ${worker} right`,
      "--merge-conflict-command",
      `node ${resolver}`,
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
    expect(report.merge.conflict_resolution_attempted).toBe(true);
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("resolved\n");
  });

  it("reports model overrides in the JSON report", async () => {
    const { root, repo } = initRepo();
    const worker = executable(join(root, "model-worker.mjs"), passWorkerScript("add", "add.txt"));
    const reportPath = join(root, "report.json");
    const code = await main([...baseArgs(root, repo, reportPath, [`add:node ${worker}`]), "--claude-model", "custom-model"]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(0);
    expect(report.model).toBe("custom-model");
    expect(report.model_overridden).toBe(true);
  });

  it("rejects missing self evaluation marker", async () => {
    const { root, repo } = initRepo();
    const worker = executable(
      join(root, "missing-marker.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync("add.txt", "add\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "add",
        summary: "created add.txt",
        changed_files: ["add.txt"],
        tests_run: [],
        tests_passed: true,
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "add",
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("done without marker");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main(baseArgs(root, repo, reportPath, [`add:node ${worker}`]));
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(1);
    expect(report.workers[0].findings.join("\n")).toContain("Missing SELF_EVALUATION: PASS.");
  });

  it("rejects explicitly forbidden paths", async () => {
    const { root, repo } = initRepo();
    const worker = executable(join(root, "forbidden-worker.mjs"), passWorkerScript("add", "secret.txt"));
    const reportPath = join(root, "report.json");
    const code = await main([...baseArgs(root, repo, reportPath, [`add:node ${worker}`]), "--forbid-path", "secret.txt"]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(1);
    expect(report.workers[0].findings.join("\n")).toContain("Forbidden path changed: secret.txt");
  });

  it("fails before worker start for missing tickets and invalid allowed paths", async () => {
    const { root, repo } = initRepo();
    await expect(main([...baseArgs(root, repo, join(root, "missing-ticket.json"), ["add:true"]).map((value) => value === "add:ticket-add.md" ? "add:missing.md" : value)])).rejects.toThrow(
      /missing worker ticket/
    );
    await expect(main([...baseArgs(root, repo, join(root, "invalid-path.json"), ["add:true"]), "--allowed-path", "add:node_modules/pkg"])).rejects.toThrow(
      /invalid --allowed-path/
    );
    await expect(main([...baseArgs(root, repo, join(root, "strict.json"), ["add:true"]), "--preflight-strict"])).rejects.toThrow(/strict preflight/);
  });

  it("leaves base unchanged when final tests fail", async () => {
    const { root, repo } = initRepo();
    const worker = executable(join(root, "final-fail-worker.mjs"), passWorkerScript("add", "add.txt"));
    const reportPath = join(root, "report.json");
    const code = await main([...baseArgs(root, repo, reportPath, [`add:node ${worker}`]), "--test", "false", "--merge"]);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(1);
    expect(report.status).toBe("final_verification_failed");
    expect(report.merge.base_unchanged_on_failure).toBe(true);
    expect(report.merge.base_after).toBe(report.merge.base_before);
    expect(() => readFileSync(join(repo, "add.txt"), "utf8")).toThrow();
  });

  it("rejects unrecoverable bad summary schema", async () => {
    const { root, repo } = initRepo();
    const worker = executable(
      join(root, "bad-summary.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync("add.txt", "add\\n", "utf8");
      writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
        worker: "add",
        summary: "bad summary",
        changed_files: ["add.txt"],
        tests_run: [],
        tests_passed: "yes",
        risks: [],
        needs_codex_attention: false
      }), "utf8");
      writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
        worker: "add",
        decision: "PASS",
        issues_found: [],
        fixes_applied: [],
        tests_run: [],
        tests_passed: true,
        merge_risk: "low"
      }), "utf8");
      console.log("SELF_EVALUATION: PASS");
      `
    );
    const reportPath = join(root, "report.json");
    const code = await main(baseArgs(root, repo, reportPath, [`add:node ${worker}`]));
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(code).toBe(1);
    expect(report.workers[0].findings.join("\n")).toContain("worker_summary.json key tests_passed must be boolean.");
  });

  it("writes compact failure JSON when the worker command fails", async () => {
    const { root, repo } = initRepo();
    const worker = executable(join(root, "failing-worker.mjs"), `process.exit(7);`);
    const reportPath = join(root, "report.json");
    const code = await main(baseArgs(root, repo, reportPath, [`add:node ${worker}`]));
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const failure = JSON.parse(readFileSync(join(root, "run", "add.failure.json"), "utf8"));

    expect(code).toBe(1);
    expect(report.status).toBe("rejected");
    expect(failure.worker).toBe("add");
    expect(failure.findings.join("\n")).toContain("Implementer exited 7.");
    expect(failure.findings.join("\n")).toContain("Missing SELF_EVALUATION: PASS.");
  });
});

function initRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "hybrid-worker-ts-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  run(["git", "init", "-b", "main"], repo);
  run(["git", "config", "user.email", "test@example.invalid"], repo);
  run(["git", "config", "user.name", "Test User"], repo);
  write(join(repo, "TASK.md"), "Implement two independent tiny files.\n");
  write(join(repo, "ticket-add.md"), "Create add.txt.\n");
  write(join(repo, "ticket-mul.md"), "Create mul.txt.\n");
  run(["git", "add", "-A"], repo);
  run(["git", "commit", "-m", "base"], repo);
  return { root, repo };
}

function baseArgs(root: string, repo: string, reportPath: string, fakeImplementers: string[]): string[] {
  return [
    "--repo",
    repo,
    "--task-file",
    "TASK.md",
    "--worker",
    "add:ticket-add.md",
    "--executor",
    "fake-command",
    ...fakeImplementers.flatMap((item) => ["--fake-implementer", item]),
    "--run-dir",
    join(root, "run"),
    "--worktree-root",
    join(root, "worktrees"),
    "--json-report",
    reportPath
  ];
}

function passWorkerScript(worker: string, output: string): string {
  return `
    import { writeFileSync } from "node:fs";
    writeFileSync("${output}", "${worker}\\n", "utf8");
    writeFileSync(process.env.CPW_SUMMARY_FILE, JSON.stringify({
      worker: "${worker}",
      summary: "created ${output}",
      changed_files: ["${output}"],
      tests_run: [],
      tests_passed: true,
      risks: [],
      needs_codex_attention: false
    }), "utf8");
    writeFileSync(process.env.CPW_DECISION_FILE, JSON.stringify({
      worker: "${worker}",
      decision: "PASS",
      issues_found: [],
      fixes_applied: [],
      tests_run: [],
      tests_passed: true,
      merge_risk: "low"
    }), "utf8");
    console.log("SELF_EVALUATION: PASS");
  `;
}
