import { readFileSync } from "node:fs";
import { writeJson } from "./json.js";

export function normalizeListField(value: unknown): unknown[] | unknown {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "string") {
    const stripped = value.trim();
    if (!stripped || ["none", "n/a", "no", "no fixes", "none needed", "no issues"].includes(stripped.toLowerCase())) return [];
    return [stripped];
  }
  return value;
}

export function normalizeSummarySchema(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const normalized = { ...data };
  for (const key of ["changed_files", "tests_run", "risks"]) normalized[key] = normalizeListField(normalized[key]);
  return normalized;
}

export function normalizeDecisionSchema(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const normalized = { ...data };
  for (const key of ["issues_found", "fixes_applied", "tests_run"]) normalized[key] = normalizeListField(normalized[key]);
  return normalized;
}

export function readNormalizedJson(path: string, normalizer: (data: unknown) => unknown): unknown {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const normalized = normalizer(data);
  if (JSON.stringify(normalized) !== JSON.stringify(data)) writeJson(path, normalized);
  return normalized;
}

export function validateSummarySchema(data: unknown): string[] {
  if (!isRecord(data)) return ["worker_summary.json must be a JSON object."];
  return validateRequired(data, "worker_summary.json", {
    worker: "string",
    summary: "string",
    changed_files: "array",
    tests_run: "array",
    tests_passed: "boolean",
    risks: "array",
    needs_codex_attention: "boolean"
  });
}

export function validateDecisionSchema(data: unknown): string[] {
  if (!isRecord(data)) return ["reviewer_decision.json must be a JSON object."];
  const findings = validateRequired(data, "reviewer_decision.json", {
    worker: "string",
    decision: "string",
    issues_found: "array",
    fixes_applied: "array",
    tests_run: "array",
    tests_passed: "boolean",
    merge_risk: "string"
  });
  if (data.decision !== "PASS") findings.push("reviewer_decision.json decision must be PASS.");
  return findings;
}

function validateRequired(data: Record<string, unknown>, label: string, schema: Record<string, "string" | "array" | "boolean">): string[] {
  const findings: string[] = [];
  for (const [key, type] of Object.entries(schema)) {
    if (!(key in data)) findings.push(`${label} missing key: ${key}`);
    else if (!matchesType(data[key], type)) findings.push(`${label} key ${key} must be ${type === "array" ? "list" : type}.`);
  }
  return findings;
}

function matchesType(value: unknown, type: "string" | "array" | "boolean"): boolean {
  if (type === "array") return Array.isArray(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
