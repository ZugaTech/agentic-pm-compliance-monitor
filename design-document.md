# AGENTIC PM COMPLIANCE MONITOR — DESIGN DOCUMENT

## 1. Purpose

The Agentic PM Compliance Monitor autonomously tracks Portfolio Manager (PM) deliverables, detects missed or at-risk deadlines, and escalates proactively to the Chief of Staff (CoS). Its autonomy is bounded to **monitoring, assessment, and escalation** — it never rewrites contractual obligations or deadlines, and every decision is recorded in an immutable audit trail.

## 2. Technology Stack

- **Orchestration:** Custom agent loop (no heavy framework). A thin loop keeps architectural intent explicit and avoids vendor lock-in for a lean HoldCo.
- **Backend:** Node.js + TypeScript — strong typing, async I/O, and fast iteration for a partial/proof-of-concept build.
- **Data:** Simulated repository (`JSON` + in-memory cache). In production, this maps to PostgreSQL/SQLite with a `deliverables` table and a separate `audit_log` table.
- **Communication:** Email API abstraction (console-simulated). Production swaps to SendGrid/Outlook/Slack/Teams webhook without changing the agent loop.
- **Scheduling:** `node-cron` / `setInterval` for the proof-of-concept; production upgrades to AWS EventBridge or a Kubernetes CronJob.

## 3. Tools

- **Read:** `getPendingDeliverables()` — fetches active deliverables, respecting the agent's configured business timezone and data-source health.
- **Evaluate:** `assessDeliverableStatus()` — compares deadline vs. now, submission status, and override state; returns `LATE`, `AT_RISK`, `COMPLIANT`, or `OVERRIDDEN`.
- **Act:** `sendEscalation()` / `sendWarning()` / `updateDashboard()` — dispatches the appropriate communication and records the dashboard state.
- **Override:** `markOverride(id, reason)` — human-in-the-loop mechanism that excludes a deliverable from future alerts while preserving full audit context.

## 4. Trigger Mechanism

- **Schedule:** Runs every 6 hours (configurable). The agent wakes, checks the world state, then sleeps.
- **Event (optional):** Webhook on new deliverable creation or submission can force an immediate re-evaluation.
- **Wake decision:** The loop checks `agent_running` and pending task count; if no tasks are active, it still records a heartbeat and sleeps — never assuming silence means safety.

## 5. Failure Modes

- **False positives:** Weekend/holiday deadlines, partial submissions, or timezone skew can flag healthy work as late. Mitigated by timezone-aware date math, business-day checks, and human override.
- **False negatives:** Stale data, clock drift, or a missed cron can hide a real late deliverable. Mitigated by heartbeat logging, data-source health checks, and re-evaluation on submission events.
- **Over-escalation:** Repeated alerts desensitize the CoS. Mitigated by alert throttling — a deliverable is escalated once per escalation window, not every tick.
- **Under-escalation:** Critical strategic deliverables might be treated like routine tasks. Mitigated by severity/priority weighting in the escalation policy.
- **Dependency failure:** Database or email service outage. Mitigated by stale-data detection, retries with backoff, and graceful degradation (log + alert fallback channel).
- **Incorrect assessment:** Ambiguous deadlines (e.g., `2026-05` vs. `2026-05-15`) or malformed records. Mitigated by strict schema validation and explicit rejection of ambiguous dates.

## 6. Human Override

`markOverride` marks a deliverable as `excused` for a specific evaluation window. The agent skips all future alerts for that item while the override is active, but the override event itself — including the reason, the user, and the timestamp — is appended to the audit log. Overrides can be time-bound (e.g., 48 hours) and require a reason to prevent accidental suppression. The agent does not "learn" in the ML sense; it applies the override as a durable rule until revoked, which keeps the audit trail deterministic and legally defensible.

## 7. Agent vs. Scheduled Script

A scheduled script runs the same `if/else` block every hour and has no memory. This system is an agent because it **maintains state across runs** (alert history, override registry, audit log), **makes contextual decisions** (suppress duplicates, downgrade routine warnings, escalate strategic misses), **uses a discrete tool interface** (Read/Evaluate/Act/Override), and **adapts to failures** (stale data, malformed rows, service outages) rather than executing blindly. The loop is not just checking conditions — it is reasoning about _when_ and _whether_ to act, then justifying that decision in the log.
