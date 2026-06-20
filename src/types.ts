// SCENARIO B - DOMAIN TYPES
// Strict typing prevents the "ambiguous deadline" failure mode and makes every
// architectural boundary explicit. In production these types map to DB tables.

export type DeliverableStatus =
  | "PENDING"
  | "AT_RISK"
  | "LATE"
  | "COMPLIANT"
  | "OVERRIDDEN";

export type Priority = "ROUTINE" | "STRATEGIC" | "CRITICAL";

export interface Deliverable {
  id: string;
  taskName: string;
  pmName: string;
  deadline: string; // YYYY-MM-DD, always interpreted in business timezone
  submitted: boolean;
  submittedAt?: string;
  override: boolean;
  overrideReason?: string;
  overrideUntil?: string; // ISO timestamp, optional
  priority: Priority;
}

export interface Assessment {
  deliverableId: string;
  status: DeliverableStatus;
  reason: string;
  evaluatedAt: string;
  nextAction: "ESCALATE" | "WARN" | "SKIP" | "NONE";
  suppressed: boolean; // true if throttled or overridden
  suppressionReason?: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR";
  eventType:
    | "READ"
    | "EVALUATE"
    | "ACT"
    | "OVERRIDE"
    | "HEARTBEAT"
    | "FAILURE";
  deliverableId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AgentConfig {
  timezone: string;
  riskWindowDays: number;
  escalationThrottleMinutes: number;
  loopIntervalMs: number;
  maxRetries: number;
  businessHolidays: string[]; // YYYY-MM-DD
}

export interface NotificationResult {
  channel: "EMAIL" | "DASHBOARD";
  success: boolean;
  error?: string;
}

export interface DataSourceState {
  healthy: boolean;
  lastUpdated: string;
  stale: boolean;
}
