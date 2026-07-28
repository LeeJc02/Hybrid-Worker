import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PASS_MARKER } from "./constants.js";
import type { WorkerSpec } from "./types.js";

export function sanitizeWorkerText(text: string, repo: string, worktree: string): string {
  return text.split(repo).join(worktree);
}

export function prepareWorkerPromptFiles(worktree: string, worker: WorkerSpec, taskText: string, ticketText: string): { taskPath: string; ticketPath: string } {
  const promptDir = join(worktree, "worker_artifacts", "prompt");
  mkdirSync(promptDir, { recursive: true });
  const taskPath = join(promptDir, "TASK.md");
  const ticketPath = join(promptDir, `${worker.name}.ticket.md`);
  writeFileSync(taskPath, taskText, "utf8");
  writeFileSync(ticketPath, ticketText, "utf8");
  return { taskPath, ticketPath };
}

export function implementerPrompt(input: {
  taskPath: string;
  ticketPath: string;
  worker: WorkerSpec;
  tests: string[];
  allowedPaths: string[];
  worktree: string;
  baseRepo: string;
  independentReview?: boolean;
}): string {
  const allowed = input.allowedPaths.length
    ? input.allowedPaths.map((path) => `- ${path}`).join("\n")
    : "- No explicit allowed paths; infer the narrowest paths from the ticket.";
  const testLines = input.tests.length
    ? input.tests.map((test) => `- ${test}`).join("\n")
    : "- No worker tests configured; still run any focused test required by the ticket when practical.";
  const closeout = input.independentReview
    ? `Write strict JSON to \`$CPW_SUMMARY_FILE\`:
{"worker":"${input.worker.name}","summary":"...","changed_files":["..."],"docs_written":["..."],"tests_run":["..."],"tests_passed":true,"risks":[],"needs_codex_attention":false}

Do not write or self-sign a reviewer decision. The harness will run independent verification.

Validate closeout:
\`$PYTHON -m json.tool "$CPW_SUMMARY_FILE" >/dev/null && test -s "$CPW_SUMMARY_FILE"\``
    : `Write strict JSON to \`$CPW_SUMMARY_FILE\`:
{"worker":"${input.worker.name}","summary":"...","changed_files":["..."],"docs_written":["..."],"tests_run":["..."],"tests_passed":true,"risks":[],"needs_codex_attention":false}

Write strict JSON to \`$CPW_DECISION_FILE\`:
{"worker":"${input.worker.name}","decision":"PASS","issues_found":[],"fixes_applied":[],"tests_run":["..."],"tests_passed":true,"merge_risk":"low"}

Validate closeout:
\`$PYTHON -m json.tool "$CPW_SUMMARY_FILE" >/dev/null && $PYTHON -m json.tool "$CPW_DECISION_FILE" >/dev/null && test -s "$CPW_SUMMARY_FILE" && test -s "$CPW_DECISION_FILE"\``;
  return `You are Claude worker \`${input.worker.name}\` in a Codex-supervised hybrid run.

Read these files before editing:
- Repo-local shared rules: \`CLAUDE.md\` if present.
- Global task file: ${input.taskPath}
- Your ticket file: ${input.ticketPath}

Actual worker worktree: ${input.worktree}
Protected base repo, never write here: ${input.baseRepo}

Non-negotiable harness contract:
- Work only inside \`$CPW_WORKTREE\`; verify \`pwd\` and \`git rev-parse --show-toplevel\` before editing.
- Never write to \`$CPW_BASE_REPO\`, benchmark roots, old report folders, skill/harness files, or outside \`$CPW_WORKTREE\`.
- Do not run \`git commit\`.
- \`$CPW_ALLOWED_PATHS\` and \`$CPW_WORKER_TESTS\` are the machine-readable source of truth.
- Treat planner/scaffold files as read-only unless explicitly listed in allowed paths: \`worker_plan.json\`, \`TASK.md\`, \`CLAUDE.md\`, \`tickets/\`, \`worker_artifacts/\`.
- Allowed paths:
${allowed}
- Worker tests:
${testLines}
- Keep the loop bounded: run tests once, do one focused repair pass if needed, rerun once, then close out or fail.
- Write or update this worker's own documentation as directed by the ticket: API/behavior notes, screen/workflow notes, data/setup/test commands, risks, and limitations for the code you changed. Keep it consistent with the actual implementation.
- Remove generated artifacts before closeout: \`__pycache__/\`, \`*.pyc\`, \`node_modules/\`, \`.venv/\`, \`dist/\`, \`build/\`, \`coverage/\`, logs, caches, local env files, \`.claudeignore\`, \`worker_artifacts/\`, \`worker_summary.json\`, \`reviewer_decision.json\`.
- If \`git status --short\` shows any changed path outside allowed paths, restore that path before closeout instead of reporting PASS.
- Inspect \`git status --short\`, \`git diff --stat\`, and \`git diff --name-only\`; every changed path must be intentional and allowed.

${closeout}

After closeout passes, output exactly \`${PASS_MARKER}\` and stop. If any required check fails, output \`SELF_EVALUATION: FAIL\` with one short reason and stop.
`;
}

export function verifierPrompt(input: { worker: string; worktree: string; diffFile: string; testLogFile: string; decisionFile: string }): string {
  return `You are an independent read-only verifier for worker ${input.worker}.

Inspect the repository only at ${input.worktree}, the diff at ${input.diffFile}, and test log at ${input.testLogFile}.
Do not edit repository files, run setup commands, or invent new shell commands.
Check correctness, scope, tests, regressions, and risk. Write strict JSON to ${input.decisionFile}:
{"worker":"${input.worker}","decision":"PASS or FAIL","issues_found":[],"fixes_applied":[],"tests_run":[],"tests_passed":true,"merge_risk":"low"}
Output SELF_EVALUATION: PASS only when the decision is PASS; otherwise output SELF_EVALUATION: FAIL.`;
}

export function repairPrompt(input: { worker: string; worktree: string; issues: string[] }): string {
  return `You are the single allowed deep repair agent for worker ${input.worker}.
Work only in ${input.worktree}. Fix only these verified issues:
${input.issues.map((issue) => `- ${issue}`).join("\n") || "- Deterministic gates failed; inspect the existing logs and diff."}
Do not broaden scope. Do not commit. Update worker_summary.json through $CPW_SUMMARY_FILE, clean generated files, and output SELF_EVALUATION: PASS when the focused repair is complete.`;
}
