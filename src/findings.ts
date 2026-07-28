import type { FindingCode, FindingSeverity, GateFinding, WorkerResult } from "./types.js";

const HARD_CODES = new Set<FindingCode>([
  "implementer_failed",
  "missing_marker",
  "missing_summary",
  "summary_invalid_json",
  "worker_crashed"
]);

export function finding(code: FindingCode, message: string, options: { severity?: FindingSeverity; path?: string; stage?: string } = {}): GateFinding {
  return {
    code,
    severity: options.severity ?? (HARD_CODES.has(code) ? "hard" : "soft"),
    message,
    ...(options.path ? { path: options.path } : {}),
    ...(options.stage ? { stage: options.stage } : {})
  };
}

export function addFinding(result: WorkerResult, item: GateFinding): void {
  result.finding_details.push(item);
  result.findings.push(item.message);
}

export function hasHardFindings(result: WorkerResult): boolean {
  return result.finding_details.some((item) => item.severity === "hard");
}

export function addSchemaFindings(result: WorkerResult, code: FindingCode, messages: string[], stage: string): void {
  for (const message of messages) addFinding(result, finding(code, message, { stage }));
}
