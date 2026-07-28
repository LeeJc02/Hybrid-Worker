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
}): string {
  const allowed = input.allowedPaths.length
    ? input.allowedPaths.map((path) => `- ${path}`).join("\n")
    : "- No explicit allowed paths; infer the narrowest paths from the ticket.";
  const testLines = input.tests.length
    ? input.tests.map((test) => `- ${test}`).join("\n")
    : "- No worker tests configured; still run any focused test required by the ticket when practical.";
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

Write strict JSON to \`$CPW_SUMMARY_FILE\`:
{"worker":"${input.worker.name}","summary":"...","changed_files":["..."],"docs_written":["..."],"tests_run":["..."],"tests_passed":true,"risks":[],"needs_codex_attention":false}

Write strict JSON to \`$CPW_DECISION_FILE\`:
{"worker":"${input.worker.name}","decision":"PASS","issues_found":[],"fixes_applied":[],"tests_run":["..."],"tests_passed":true,"merge_risk":"low"}

Validate closeout:
\`$PYTHON -m json.tool "$CPW_SUMMARY_FILE" >/dev/null && $PYTHON -m json.tool "$CPW_DECISION_FILE" >/dev/null && test -s "$CPW_SUMMARY_FILE" && test -s "$CPW_DECISION_FILE"\`

After closeout passes, output exactly \`${PASS_MARKER}\` and stop. If any required check fails, output \`SELF_EVALUATION: FAIL\` with one short reason and stop.
`;
}
