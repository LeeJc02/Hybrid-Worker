import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentAccess } from "./types.js";

export interface BrokerLimits {
  maxReadonly: number;
  maxWrite: number;
  maxCalls: number;
  maxCostUsd: number;
  leaseSec: number;
}

export interface BrokerLease {
  id: string;
  access: AgentAccess;
  owner: string;
  acquired_at: string;
  expires_at: string;
  wait_sec: number;
}

export interface BrokerSnapshot {
  limits: BrokerLimits;
  leases: BrokerLease[];
  calls_started: number;
  observed_cost_usd: number;
  total_wait_sec: number;
  reclaimed_leases: number;
}

const DEFAULT_LOCK_STALE_MS = 30_000;

export class ResourceBroker {
  private readonly stateFile: string;
  private readonly lockDir: string;

  constructor(private readonly root: string, private readonly limits: BrokerLimits) {
    this.stateFile = join(root, "state.json");
    this.lockDir = join(root, "state.lock");
    mkdirSync(root, { recursive: true });
  }

  async acquire(access: AgentAccess, owner: string, timeoutSec: number): Promise<BrokerLease> {
    const started = performance.now();
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() <= deadline) {
      const lease = this.withLock((state) => {
        reclaimExpired(state);
        const active = state.leases.filter((item) => item.access === access).length;
        const capacity = access === "readonly" ? state.limits.maxReadonly : state.limits.maxWrite;
        if (state.calls_started >= state.limits.maxCalls) throw new Error(`global Claude call budget exhausted (${state.limits.maxCalls})`);
        if (state.observed_cost_usd >= state.limits.maxCostUsd) throw new Error(`global observed cost budget exhausted ($${state.limits.maxCostUsd})`);
        if (active >= capacity) return null;
        const waitSec = (performance.now() - started) / 1000;
        const acquiredAt = new Date();
        const lease: BrokerLease = {
          id: randomUUID(),
          access,
          owner,
          acquired_at: acquiredAt.toISOString(),
          expires_at: new Date(acquiredAt.getTime() + state.limits.leaseSec * 1000).toISOString(),
          wait_sec: waitSec
        };
        state.calls_started += 1;
        state.total_wait_sec += waitSec;
        state.leases.push(lease);
        return lease;
      });
      if (lease) return lease;
      await delay(25);
    }
    throw new Error(`timed out waiting for global ${access} broker slot after ${timeoutSec}s`);
  }

  release(leaseId: string, observedCostUsd = 0): void {
    this.withLock((state) => {
      reclaimExpired(state);
      state.leases = state.leases.filter((lease) => lease.id !== leaseId);
      if (Number.isFinite(observedCostUsd) && observedCostUsd > 0) state.observed_cost_usd += observedCostUsd;
    });
  }

  renew(leaseId: string): boolean {
    return this.withLock((state) => {
      reclaimExpired(state);
      const lease = state.leases.find((item) => item.id === leaseId);
      if (!lease) return false;
      lease.expires_at = new Date(Date.now() + state.limits.leaseSec * 1000).toISOString();
      return true;
    });
  }

  snapshot(): BrokerSnapshot {
    return this.withLock((state) => {
      reclaimExpired(state);
      return structuredClone(state);
    });
  }

  private withLock<T>(fn: (state: BrokerSnapshot) => T): T {
    const lockDeadline = Date.now() + 10_000;
    while (true) {
      try {
        mkdirSync(this.lockDir);
        break;
      } catch (error) {
        if (!existsSync(this.lockDir)) continue;
        const age = Date.now() - statSync(this.lockDir).mtimeMs;
        if (age > DEFAULT_LOCK_STALE_MS) {
          rmSync(this.lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > lockDeadline) throw new Error(`timed out acquiring broker state lock: ${String(error)}`);
        sleepSync(5);
      }
    }
    try {
      const state = this.readState();
      const result = fn(state);
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      renameSync(temporary, this.stateFile);
      return result;
    } finally {
      rmSync(this.lockDir, { recursive: true, force: true });
    }
  }

  private readState(): BrokerSnapshot {
    if (!existsSync(this.stateFile)) {
      return {
        limits: this.limits,
        leases: [],
        calls_started: 0,
        observed_cost_usd: 0,
        total_wait_sec: 0,
        reclaimed_leases: 0
      };
    }
    const state = JSON.parse(readFileSync(this.stateFile, "utf8")) as BrokerSnapshot;
    if (JSON.stringify(state.limits) !== JSON.stringify(this.limits)) throw new Error("broker limits do not match existing parent-run state");
    return state;
  }
}

function reclaimExpired(state: BrokerSnapshot): void {
  const now = Date.now();
  const active = state.leases.filter((lease) => Date.parse(lease.expires_at) > now);
  state.reclaimed_leases += state.leases.length - active.length;
  state.leases = active;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
