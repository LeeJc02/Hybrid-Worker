import { describe, expect, it } from "vitest";
import { validateAllowedPathPrefix, pathAllowed } from "../src/artifacts.js";
import { parseArgs } from "../src/cli.js";
import { shellEnv, npmPrefixesFromCommand } from "../src/env.js";
import { validateWorkerPlan } from "../src/plan.js";
import { implementerPrompt, sanitizeWorkerText } from "../src/prompt.js";
import { normalizeDecisionSchema, normalizeSummarySchema, validateSummarySchema } from "../src/schema.js";
import { loadFirstJsonObject, parseClaudeUsage, combineUsage, claudeResultText } from "../src/usage.js";

describe("core compatibility helpers", () => {
  it("keeps Python-compatible CLI defaults", () => {
    const args = parseArgs(["--task-file", "TASK.md", "--worker", "a:a.md"]);
    expect(args.claudeModel).toBe("deepseek-v4-flash");
    expect(args.permissionMode).toBe("bypassPermissions");
    expect(args.maxDiffLines).toBe(8000);
    expect(args.maxChangedFiles).toBe(80);
    expect(args.workerTimeoutSec).toBe(1500);
    expect(args.testTimeoutSec).toBe(1800);
  });

  it("rejects invalid numeric CLI options before execution", () => {
    expect(() => parseArgs(["--task-file", "TASK.md", "--worker", "a:a.md", "--parallelism", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--task-file", "TASK.md", "--worker", "a:a.md", "--max-diff-lines", "NaN"])).toThrow(/positive integer/);
  });

  it("parses automation-oriented CLI flags", () => {
    const args = parseArgs(["--task-file", "TASK.md", "--worker", "a:a.md", "--json", "--quiet", "--preflight-strict", "--repo-ignore-policy", "local"]);
    expect(args.json).toBe(true);
    expect(args.quiet).toBe(true);
    expect(args.preflightStrict).toBe(true);
    expect(args.repoIgnorePolicy).toBe("local");
    expect(() => parseArgs(["--task-file", "TASK.md", "--worker", "a:a.md", "--repo-ignore-policy", "none"])).toThrow(/tracked or local/);
  });

  it("validates worker_plan.json shape before execution", () => {
    expect(
      validateWorkerPlan({
        phases: [
          { name: "one", workers: [{ name: "api", ticket: "tickets/api.md", allowed_paths: ["src"], worker_tests: ["npm test"] }] }
        ]
      })
    ).toEqual([]);
    expect(
      validateWorkerPlan({
        phases: [
          { name: "one", workers: [{ name: "api", ticket: "tickets/api.md" }] },
          { name: "two", workers: [{ name: "api", ticket: "tickets/api2.md" }] }
        ]
      }).join("\n")
    ).toContain("duplicate worker name");
    expect(validateWorkerPlan({ phases: [{ name: "bad", workers: [{ name: "api", ticket: 7 }] }] }).join("\n")).toContain("ticket must be a non-empty string");
  });

  it("injects shared cache and CPW contract environment", () => {
    const env = shellEnv({
      base: {},
      pythonCommand: "/usr/bin/python3",
      worker: "api",
      runId: "run1",
      artifactsDir: "/tmp/run",
      allowedPaths: ["src"],
      workerTests: ["test -f src/app.ts"]
    });
    expect(env.PIP_CACHE_DIR).toContain(".codex/cache/hybrid-worker/pip");
    expect(env.npm_config_cache).toContain(".codex/cache/hybrid-worker/npm");
    expect(env.UV_CACHE_DIR).toContain(".codex/cache/hybrid-worker/uv");
    expect(env.CPW_ALLOWED_PATHS).toBe("[\"src\"]");
    expect(env.CPW_SUMMARY_FILE).toBe("/tmp/run/api.worker_summary.json");
  });

  it("matches allowed path validation gates", () => {
    expect(validateAllowedPathPrefix("src/app")).toBeNull();
    expect(validateAllowedPathPrefix(".")).toBeNull();
    expect(validateAllowedPathPrefix("/tmp/x")).toContain("absolute");
    expect(validateAllowedPathPrefix("../secrets")).toContain("parent");
    expect(validateAllowedPathPrefix("node_modules/pkg")).toContain("generated");
    expect(pathAllowed("backend/main.ts", ["."])).toBe(true);
    expect(pathAllowed("frontend/src/App.vue", ["*"])).toBe(true);
    expect(pathAllowed("frontend/src/App.vue", ["backend"])).toBe(false);
  });

  it("parses Claude structured JSON usage from result payload", () => {
    const payload = loadFirstJsonObject(
      '$ claude -p --output-format json\n' +
        '[{"type":"assistant","message":{"usage":{"input_tokens":99,"output_tokens":99}}},{"type":"result","result":"ok SELF_EVALUATION: PASS","usage":{"input_tokens":12,"output_tokens":5,"cache_read_input_tokens":7},"total_cost_usd":0.01}]\n'
    );
    const usage = parseClaudeUsage(payload);
    expect(usage.status).toBe("observed");
    expect(usage.input_tokens).toBe(12);
    expect(usage.output_tokens).toBe(5);
    expect(usage.cache_read_input_tokens).toBe(7);
    expect(usage.total_cost_usd).toBe(0.01);
    expect(claudeResultText(payload)).toContain("SELF_EVALUATION: PASS");
  });

  it("combines observed usage and ignores not_observed entries", () => {
    expect(
      combineUsage([
        { status: "observed", input_tokens: 10, output_tokens: 3 },
        { status: "not_observed", reason: "fake" },
        { status: "observed", input_tokens: 2, output_tokens: 1 }
      ])
    ).toMatchObject({ status: "observed", input_tokens: 12, output_tokens: 4 });
  });

  it("discovers npm package dirs from prefix, -C, and root npm commands", () => {
    expect(npmPrefixesFromCommand("npm --prefix frontend run test")).toEqual(["frontend"]);
    expect(npmPrefixesFromCommand("npm -C web run build")).toEqual(["web"]);
    expect(npmPrefixesFromCommand("npm test")).toEqual(["."]);
    expect(npmPrefixesFromCommand("npm --prefix ../outside test")).toEqual([]);
  });

  it("sanitizes base repo paths and points workers at prompt files", () => {
    expect(sanitizeWorkerText("edit /tmp/base/src/app.ts", "/tmp/base", "/tmp/worktree")).toBe("edit /tmp/worktree/src/app.ts");
    const prompt = implementerPrompt({
      taskPath: "/tmp/worktree/worker_artifacts/prompt/TASK.md",
      ticketPath: "/tmp/worktree/worker_artifacts/prompt/api.ticket.md",
      worker: { name: "api", ticket: "ticket-api.md", allowedPaths: ["backend/api"] },
      tests: ["$PYTHON -m pytest"],
      allowedPaths: ["backend/api"],
      worktree: "/tmp/worktree",
      baseRepo: "/tmp/base"
    });
    expect(prompt).toContain("/tmp/worktree/worker_artifacts/prompt/TASK.md");
    expect(prompt).toContain("backend/api");
    expect(prompt).toContain("worker_plan.json");
    expect(prompt).toContain("restore that path before closeout");
    expect(prompt).toContain("worker_summary.json");
  });

  it("normalizes common string-list JSON mistakes before schema validation", () => {
    const summary = normalizeSummarySchema({
      worker: "api",
      summary: "ok",
      changed_files: "src/app.ts",
      tests_run: "none",
      tests_passed: true,
      risks: "n/a",
      needs_codex_attention: false
    });
    expect(summary).toMatchObject({ changed_files: ["src/app.ts"], tests_run: [], risks: [] });
    expect(validateSummarySchema(summary)).toEqual([]);

    const decision = normalizeDecisionSchema({
      issues_found: "no issues",
      fixes_applied: "wrote tests",
      tests_run: null
    });
    expect(decision).toMatchObject({ issues_found: [], fixes_applied: ["wrote tests"], tests_run: [] });
  });
});
