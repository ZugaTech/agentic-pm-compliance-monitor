// SCENARIO B - AGENT MEMORY / AUDIT TRAIL
// An agent without memory is just a script. This module persists context across
// ticks: every READ, EVALUATE, ACT, OVERRIDE, and FAILURE is recorded. The audit
// trail is immutable, which makes the system institutionally defensible.

import { AuditEvent, Assessment } from "./types";

const auditLog: AuditEvent[] = [];
const alertHistory: Map<string, string> = new Map(); // deliverableId -> last alert ISO

function generateId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function recordAudit(
  event: Omit<AuditEvent, "id" | "timestamp">
): AuditEvent {
  const entry: AuditEvent = {
    ...event,
    id: generateId(),
    timestamp: new Date().toISOString(),
  };
  auditLog.push(entry);
  return entry;
}

export function recordAlert(deliverableId: string, action: string): void {
  alertHistory.set(`${deliverableId}:${action}`, new Date().toISOString());
}

export function getLastAlertTime(
  deliverableId: string,
  action: string
): Date | null {
  const key = `${deliverableId}:${action}`;
  const iso = alertHistory.get(key);
  return iso ? new Date(iso) : null;
}

export function getAuditLog(): AuditEvent[] {
  return [...auditLog];
}

export function getAlertHistory(): ReadonlyMap<string, string> {
  return alertHistory;
}

export function clearMemory(): void {
  auditLog.length = 0;
  alertHistory.clear();
}

export function summarizeMemory(): string {
  const counts = auditLog.reduce(
    (acc, e) => {
      acc[e.eventType] = (acc[e.eventType] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  return JSON.stringify({ totalEvents: auditLog.length, counts });
}

export function recordAssessment(a: Assessment): void {
  recordAudit({
    level: a.status === "LATE" ? "ERROR" : a.status === "AT_RISK" ? "WARN" : "INFO",
    eventType: "EVALUATE",
    deliverableId: a.deliverableId,
    message: a.reason,
    metadata: { status: a.status, nextAction: a.nextAction, suppressed: a.suppressed },
  });
}
