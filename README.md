# BNH Agentic PM Compliance Monitor — Scenario B

A production-styled, framework-agnostic implementation of the **Agentic PM Compliance Monitoring System** for Brendan Nicholas Holdings (BNH) System 5.

## What It Does

Autonomously monitors Portfolio Manager (PM) deliverables, detects missed or at-risk deadlines, and escalates proactively to the Chief of Staff (CoS) — while preserving a full audit trail and supporting human override.

## Files

| File                      | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `design-document.md`      | One-page institutional design document                    |
| `src/index.ts`            | Entry point with CLI (`seed`, `tick`, `override`)         |
| `src/agent.ts`            | Core agent loop: READ → EVALUATE → ACT → LOG → WAIT       |
| `src/tools.ts`            | Read, Evaluate, Act, Override tools                       |
| `src/data-source.ts`      | Simulated JSON deliverable repository + failure injection |
| `src/memory.ts`           | Audit trail and alert history (agent memory)              |
| `src/config.ts`           | Tunable agent configuration                               |
| `src/types.ts`            | Strict domain types                                       |
| `src/tests/agent.test.ts` | Automated tests covering core loop + failure modes        |

## Quick Start

```bash
npm install
npm run build
npm run test

# Re-seed sample data and run a single evaluation tick
npm run build
node dist/index.js seed
node dist/index.js tick

# Apply a human override via CLI
node dist/index.js override dlv-001 "Extension approved by CoS"
```

## Why This Is an Agent, Not a Script

- **Memory:** maintains audit log and alert history across ticks.
- **Reasoning:** decides whether to escalate, warn, or suppress based on priority, recency, and override state.
- **Tools:** discrete, swappable Read/Evaluate/Act/Override tools.
- **Adaptation:** retries on data-source failure, throttles alerts to avoid over-escalation, and handles malformed data gracefully.

## Failure Modes Addressed

- False positives / negatives — timezone-aware date math, strict deadline validation.
- Over-escalation — priority-aware alert throttling.
- Under-escalation — priority weighting (CRITICAL escalates faster than ROUTINE).
- Dependency failure — retry with backoff, stale-data logging.
- Incorrect assessment — explicit rejection of malformed/ambiguous deadlines.
- Human override — durable, auditable, reason-required.

## Note

This is a partial/proof-of-concept implementation focused on architectural clarity, not a full production deployment. The email and dashboard layers are simulated with `console.log` to keep the system runnable without external API keys.
