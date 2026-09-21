// SCENARIO B - TOOLS
// The agent uses a discrete tool interface: Read, Evaluate, Act, Override.
// Each tool is a pure function that can be unit-tested and replaced (e.g., a
// real SMTP service or Slack webhook) without changing the agent loop.

import {
  Deliverable,
  DeliverableStatus,
  Assessment,
  Priority,
  NotificationResult,
  AgentConfig,
} from "./types";
import { config } from "./config";
import {
  recordAudit,
  recordAlert,
  getLastAlertTime,
  recordAssessment,
} from "./memory";
import { loadDeliverables, getDataSourceState } from "./data-source";

// ---------- Read Tool ----------
// SCENARIO B - READ TOOL
// Fetches pending deliverables. The agent checks source health and logs stale
// data so it never makes a silent assessment on bad inputs.
export async function getPendingDeliverables(): Promise<{
  deliverables: Deliverable[];
  sourceState: ReturnType<typeof getDataSourceState>;
}> {
  recordAudit({
    level: "INFO",
    eventType: "READ",
    message: "Agent waking: querying data source for pending deliverables",
  });

  const deliverables = await loadDeliverables();
  const sourceState = getDataSourceState();

  if (sourceState.stale) {
    recordAudit({
      level: "WARN",
      eventType: "FAILURE",
      message: "Data source is stale; agent will continue but marks assessment as tentative",
      metadata: { sourceState },
    });
  }

  return { deliverables, sourceState };
}

// ---------- Evaluate Tool ----------
// SCENARIO B - EVALUATION
// The core reasoning: compare deadline vs. now, submission status, override
// state, and business rules. The function returns a decision object, not just
// a boolean, because the agent needs to explain *why* it acted.
export function assessDeliverableStatus(
  d: Deliverable,
  cfg: AgentConfig = config
): Assessment {
  const now = new Date();
  const deadlineIso = parseDeadline(d.deadline);

  // SCENARIO B - FAILURE MODE: malformed data
  // Reject ambiguous/missing deadlines rather than guessing. This is a critical
  // guard against the "incorrect assessment" failure mode.
  if (!deadlineIso) {
    return {
      deliverableId: d.id,
      status: "PENDING",
      reason: `MALFORMED_DATA: deadline "${d.deadline}" is not a valid YYYY-MM-DD date`,
      evaluatedAt: now.toISOString(),
      nextAction: "NONE",
      suppressed: false,
      suppressionReason: "requires data correction",
    };
  }

  // SCENARIO B - OVERRIDE
  // Human override is respected before any other evaluation. The reason is
  // recorded in the audit trail so the decision is never opaque.
  if (d.override) {
    const expired = d.overrideUntil ? new Date() > new Date(d.overrideUntil) : false;
    if (!expired) {
      return {
        deliverableId: d.id,
        status: "OVERRIDDEN",
        reason: `Override active: ${d.overrideReason || "no reason provided"}`,
        evaluatedAt: now.toISOString(),
        nextAction: "SKIP",
        suppressed: true,
        suppressionReason: "human override",
      };
    }
  }

  if (d.submitted) {
    return {
      deliverableId: d.id,
      status: "COMPLIANT",
      reason: `Deliverable submitted${d.submittedAt ? ` on ${d.submittedAt}` : ""}`,
      evaluatedAt: now.toISOString(),
      nextAction: "NONE",
      suppressed: false,
    };
  }

  const daysToDeadline = daysBetween(now, deadlineIso);

  if (daysToDeadline < 0) {
    return {
      deliverableId: d.id,
      status: "LATE",
      reason: `Deadline ${d.deadline} has passed by ${Math.abs(daysToDeadline)} business day(s)`,
      evaluatedAt: now.toISOString(),
      nextAction: "ESCALATE",
      suppressed: false,
    };
  }

  if (daysToDeadline <= cfg.riskWindowDays) {
    return {
      deliverableId: d.id,
      status: "AT_RISK",
      reason: `Deadline ${d.deadline} is ${daysToDeadline} day(s) away (within ${cfg.riskWindowDays}-day risk window)`,
      evaluatedAt: now.toISOString(),
      nextAction: "WARN",
      suppressed: false,
    };
  }

  return {
    deliverableId: d.id,
    status: "PENDING",
    reason: `Deadline ${d.deadline} is ${daysToDeadline} day(s) away; no action needed`,
    evaluatedAt: now.toISOString(),
    nextAction: "NONE",
    suppressed: false,
  };
}

// ---------- Act Tools ----------
// SCENARIO B - ACTION
// The agent decides whether to act, then dispatches. The throttle prevents the
// over-escalation failure mode; the priority multiplier prevents under-escalation.

function throttleExpired(deliverableId: string, action: string, minutes: number): boolean {
  const last = getLastAlertTime(deliverableId, action);
  if (!last) return true;
  const elapsedMs = Date.now() - last.getTime();
  return elapsedMs > minutes * 60 * 1000;
}

function priorityMultiplier(priority: Priority): number {
  switch (priority) {
    case "CRITICAL":
      return 1;
    case "STRATEGIC":
      return 2;
    case "ROUTINE":
      return 4;
  }
}

export async function executeAction(
  d: Deliverable,
  assessment: Assessment,
  cfg: AgentConfig = config
): Promise<NotificationResult[]> {
  if (assessment.suppressed || assessment.nextAction === "NONE") {
    return [];
  }

  const action = assessment.nextAction;
  const throttleMins = cfg.escalationThrottleMinutes * priorityMultiplier(d.priority);
  const shouldSend = throttleExpired(d.id, action, throttleMins);

  if (!shouldSend) {
    recordAudit({
      level: "INFO",
      eventType: "ACT",
      deliverableId: d.id,
      message: `Alert suppressed by throttle for ${action} (priority=${d.priority})`,
      metadata: { assessment },
    });
    return [];
  }

  const results: NotificationResult[] = [];

  if (action === "ESCALATE") {
    results.push(await sendEscalation(d, assessment));
    results.push(await updateDashboard(d, "LATE"));
  } else if (action === "WARN") {
    results.push(await sendWarning(d, assessment));
    results.push(await updateDashboard(d, "AT_RISK"));
  }

  return results;
}

export async function sendEscalation(
  d: Deliverable,
  assessment: Assessment
): Promise<NotificationResult> {
  // SCENARIO B - ACTION (escalation)
  // In production this calls an email provider or Slack webhook. The console
  // output preserves the exact message that would be dispatched, so the CoS can
  // review the simulated audit trail.
  const subject = `LATE DELIVERABLE: ${d.taskName} (${d.pmName})`;
  const body = [
    `Deliverable: ${d.taskName}`,
    `PM: ${d.pmName}`,
    `Deadline: ${d.deadline}`,
    `Status: ${assessment.status}`,
    `Reason: ${assessment.reason}`,
    `Evaluated at: ${assessment.evaluatedAt}`,
  ].join("\n");

  console.log(`[ESCALATION] To: CoS <cos@nbh.com>`);
  console.log(`[ESCALATION] Subject: ${subject}`);
  console.log(`[ESCALATION] Body:\n${body}`);

  recordAlert(d.id, "ESCALATE");
  return { channel: "EMAIL", success: true };
}

export async function sendWarning(
  d: Deliverable,
  assessment: Assessment
): Promise<NotificationResult> {
  console.log(`[WARNING] To: ${d.pmName} <${d.pmName.toLowerCase().replace(/\s/g, ".")}@nbh.com>`);
  console.log(`[WARNING] Subject: AT_RISK DELIVERABLE: ${d.taskName}`);
  console.log(`[WARNING] Body: ${assessment.reason}`);

  recordAlert(d.id, "WARN");
  return { channel: "EMAIL", success: true };
}

export async function updateDashboard(
  d: Deliverable,
  status: string
): Promise<NotificationResult> {
  console.log(`[DASHBOARD] Updating status for ${d.id} to ${status}`);
  recordAudit({
    level: "INFO",
    eventType: "ACT",
    deliverableId: d.id,
    message: `Dashboard updated to ${status}`,
  });
  return { channel: "DASHBOARD", success: true };
}

// ---------- Override Tool ----------
// SCENARIO B - OVERRIDE
// Human-in-the-loop command. The agent must honor it, log it, and skip the
// deliverable until the override expires or is revoked.
export function markOverride(
  d: Deliverable,
  reason: string,
  until?: string
): Deliverable {
  const updated: Deliverable = {
    ...d,
    override: true,
    overrideReason: reason,
    overrideUntil: until,
  };

  recordAudit({
    level: "INFO",
    eventType: "OVERRIDE",
    deliverableId: d.id,
    message: `Override applied: ${reason}`,
    metadata: { until },
  });

  return updated;
}

// ---------- Helpers ----------

function parseDeadline(deadline: string): Date | null {
  if (!deadline || typeof deadline !== "string") return null;
  const match = deadline.match(/^\d{4}-\d{2}-\d{2}$/);
  if (!match) return null;
  const date = new Date(`${deadline}T00:00:00.000Z`);
  if (isNaN(date.getTime())) return null;
  return date;
}

function daysBetween(now: Date, deadline: Date): number {
  // Normalize both dates to midnight UTC to avoid timezone false positives.
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const end = new Date(
    Date.UTC(deadline.getFullYear(), deadline.getMonth(), deadline.getDate())
  );
  const diffMs = end.getTime() - start.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export { recordAssessment };
