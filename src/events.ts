import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEvent, RunEventType } from "./types.js";

export class EventLogger {
  constructor(
    private readonly file: string,
    private readonly runId?: string
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  emit(type: RunEventType, event: Omit<RunEvent, "type" | "timestamp" | "run_id"> = {}): void {
    const payload: RunEvent = {
      type,
      timestamp: new Date().toISOString(),
      ...event
    };
    if (this.runId != null) payload.run_id = this.runId;
    appendFileSync(this.file, `${JSON.stringify(payload)}\n`, "utf8");
  }
}

export function createNoopEventLogger(): Pick<EventLogger, "emit"> {
  return { emit: () => undefined };
}
