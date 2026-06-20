// SCENARIO B - DATA SOURCE
// Simulates a PM deliverables repository with JSON persistence. The interface
// is intentionally narrow so the production backend can swap JSON for PostgreSQL
// without touching the agent loop. Failure-injection hooks let us test the
// dependency-failure mode without depending on a real outage.

import { Deliverable, DataSourceState } from "./types";
import { promises as fs } from "fs";
import { join } from "path";

const DATA_PATH = join(__dirname, "..", "data", "deliverables.json");

let inMemoryStore: Deliverable[] = [];
let healthy = true;
let stale = false;
let failureRate = 0;
let lastUpdated = new Date().toISOString();

export function ensureSampleData(): Deliverable[] {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const inThreeDays = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const inFiveDays = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

  return [
    {
      id: "dlv-001",
      taskName: "Q2 Subsidiary Performance Review",
      pmName: "Ada Okafor",
      deadline: yesterday,
      submitted: false,
      override: false,
      priority: "CRITICAL",
    },
    {
      id: "dlv-002",
      taskName: "HoldCo Board Pack",
      pmName: "Emeka Nwosu",
      deadline: inThreeDays,
      submitted: false,
      override: false,
      priority: "STRATEGIC",
    },
    {
      id: "dlv-003",
      taskName: "Monthly Cash Flow Forecast",
      pmName: "Ngozi Eze",
      deadline: today,
      submitted: false,
      override: false,
      priority: "ROUTINE",
    },
    {
      id: "dlv-004",
      taskName: "Regulatory Filing - KYC Update",
      pmName: "Ada Okafor",
      deadline: yesterday,
      submitted: true,
      submittedAt: yesterday,
      override: false,
      priority: "CRITICAL",
    },
    {
      id: "dlv-005",
      taskName: "Subsidiary Audit Response",
      pmName: "Emeka Nwosu",
      deadline: yesterday,
      submitted: false,
      override: true,
      overrideReason: "Deadline extended by CoS via email on 2026-06-19",
      priority: "STRATEGIC",
    },
    {
      id: "dlv-006",
      taskName: " malformed record ", // intentionally malformed-ish name
      pmName: "Bad Data",
      deadline: "not-a-date",
      submitted: false,
      override: false,
      priority: "ROUTINE",
    },
    {
      id: "dlv-007",
      taskName: "Future Strategic Plan",
      pmName: "Ngozi Eze",
      deadline: inFiveDays,
      submitted: false,
      override: false,
      priority: "STRATEGIC",
    },
  ];
}

export async function loadDeliverables(): Promise<Deliverable[]> {
  if (!healthy) {
    throw new Error("DATA_SOURCE_UNAVAILABLE: simulated database outage");
  }
  if (Math.random() < failureRate) {
    throw new Error("DATA_SOURCE_TRANSIENT: simulated flaky read");
  }

  try {
    await fs.mkdir(join(__dirname, "..", "data"), { recursive: true });
    try {
      const raw = await fs.readFile(DATA_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Deliverable[];
      inMemoryStore = parsed;
      lastUpdated = new Date().toISOString();
    } catch (err) {
      // No persisted file yet; seed with sample data.
      inMemoryStore = ensureSampleData();
      await fs.writeFile(DATA_PATH, JSON.stringify(inMemoryStore, null, 2));
      lastUpdated = new Date().toISOString();
    }
  } catch (err) {
    throw new Error(
      `DATA_SOURCE_IO_ERROR: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Mark data as stale if it has not been refreshed in > 12 hours.
  const ageMs = Date.now() - new Date(lastUpdated).getTime();
  stale = ageMs > 12 * 60 * 60 * 1000;

  return inMemoryStore;
}

export function getDataSourceState(): DataSourceState {
  return { healthy, lastUpdated, stale };
}

export async function saveDeliverables(deliverables: Deliverable[]): Promise<void> {
  inMemoryStore = deliverables;
  await fs.writeFile(DATA_PATH, JSON.stringify(deliverables, null, 2));
  lastUpdated = new Date().toISOString();
}

export function injectDataSourceFailure(options?: {
  healthy?: boolean;
  failureRate?: number;
  stale?: boolean;
}): void {
  if (options?.healthy !== undefined) healthy = options.healthy;
  if (options?.failureRate !== undefined) failureRate = options.failureRate;
  if (options?.stale !== undefined) stale = options.stale;
}

export function resetDataSourceFailure(): void {
  healthy = true;
  failureRate = 0;
  stale = false;
}

export async function seedDeliverables(deliverables: Deliverable[]): Promise<void> {
  inMemoryStore = deliverables;
  await fs.mkdir(join(__dirname, "..", "data"), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(deliverables, null, 2));
  lastUpdated = new Date().toISOString();
}

export function getInMemoryStore(): Deliverable[] {
  return inMemoryStore;
}
