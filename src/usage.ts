import { readFileSync } from "node:fs";
import { notObservedUsage } from "./env.js";
import type { Usage } from "./types.js";

export function loadFirstJsonObject(text: string): unknown | null {
  let stripped = text.trim();
  if (!stripped) return null;
  if (stripped.startsWith("$ ")) stripped = stripped.split(/\r?\n/).slice(1).join("\n").trim();
  for (const prefix of ["[", "{"]) {
    if (stripped.startsWith(prefix)) {
      try {
        return JSON.parse(stripped) as unknown;
      } catch {
        // Continue with more permissive parsing.
      }
    }
  }
  const starts = [stripped.indexOf("["), stripped.indexOf("{")].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start >= 0) {
    try {
      return JSON.parse(stripped.slice(start)) as unknown;
    } catch {
      // Continue line-by-line.
    }
  }
  for (const line of stripped.split(/\r?\n/)) {
    if (line.trim().startsWith("{")) {
      try {
        return JSON.parse(line.trim()) as unknown;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function parseClaudePayloadFromLog(logFile: string): unknown | null {
  return loadFirstJsonObject(readFileSync(logFile, "utf8"));
}

export function claudeResultText(data: unknown): string {
  const payload = finalResultPayload(data);
  if (payload && typeof payload.result === "string") return payload.result;
  if (isRecord(data) && typeof data.result === "string") return data.result;
  if (Array.isArray(data)) {
    const texts: string[] = [];
    for (const item of data) {
      if (!isRecord(item) || !isRecord(item.message) || !Array.isArray(item.message.content)) continue;
      for (const part of item.message.content) {
        if (isRecord(part) && part.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
    }
    if (texts.length) return texts.join("\n");
  }
  return "";
}

export function parseClaudeUsage(data: unknown): Usage {
  if (data == null) return notObservedUsage("claude output was not parseable JSON");
  const resultPayload = finalResultPayload(data);
  const totals: Record<string, number> = {};
  let modelUsage: unknown;
  if (resultPayload) {
    collectUsageNumbers(resultPayload.usage, totals);
    if (typeof resultPayload.total_cost_usd === "number") totals.total_cost_usd = resultPayload.total_cost_usd;
    modelUsage = resultPayload.modelUsage;
  } else {
    collectUsageNumbers(data, totals);
  }
  if (Object.keys(totals).length === 0) return notObservedUsage("claude JSON did not expose usage fields");
  const usage: Usage = { status: "observed" };
  for (const [key, value] of Object.entries(totals).sort()) usage[key] = Number.isInteger(value) ? value : value;
  if (modelUsage !== undefined) usage.modelUsage = modelUsage;
  return usage;
}

export function parseClaudeUsageFromLog(logFile: string): Usage {
  return parseClaudeUsage(parseClaudePayloadFromLog(logFile));
}

export function combineUsage(items: Usage[]): Usage {
  const observed = items.filter((item) => item.status === "observed");
  if (observed.length === 0) return notObservedUsage("no observed Claude usage");
  const totals: Record<string, number> = {};
  for (const item of observed) {
    for (const [key, value] of Object.entries(item)) {
      if (key === "status") continue;
      if (typeof value === "number" && !Number.isNaN(value)) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  const combined: Usage = { status: "observed" };
  for (const [key, value] of Object.entries(totals).sort()) combined[key] = Number.isInteger(value) ? value : value;
  return combined;
}

function collectUsageNumbers(value: unknown, totals: Record<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUsageNumbers(item, totals);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (typeof item === "number" && !Number.isNaN(item)) {
      if (lowered.includes("token") || lowered.endsWith("_cost_usd") || lowered === "total_cost_usd" || lowered === "cost_usd") {
        totals[key] = (totals[key] ?? 0) + item;
      }
    }
    collectUsageNumbers(item, totals);
  }
}

function finalResultPayload(data: unknown): Record<string, unknown> | null {
  if (isRecord(data)) return data;
  if (Array.isArray(data)) {
    for (const item of [...data].reverse()) {
      if (isRecord(item) && item.type === "result") return item;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
