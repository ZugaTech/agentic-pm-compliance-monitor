# BNH Agentic PM Compliance Monitor — Scenario B

A production-styled, framework-agnostic implementation of the **Agentic PM Compliance Monitoring System** for Brendan Nicholas Holdings (BNH) System 5.

## What It Does

This system autonomously monitors Portfolio Manager (PM) deliverables, detects missed or at-risk deadlines, and escalates proactively to the Chief of Staff (CoS). It preserves a full audit trail and supports durable human override.

The core deterministic rules engine is always the source of truth. An optional Fireworks AI LLM enhancement layers in only for genuine edge cases, providing calibrated second opinions without replacing the deterministic fallback.

## Architecture

```
Every deliverable
       │
       ▼
┌─────────────────────┐
│  Deterministic      │  ← always runs, always the fallback
│  assessDeliverable  │
│  Status()           │
└────────┬────────────┘
         │
    Edge case?
    (detectEdgeCase)
         │
   No ───┴─── Yes
   │             │
   ▼             ▼
return      ┌──────────────┐
determin-   │  Fireworks   │
istic       │  Kimi K2.7   │
result      │  analyzeComp │
            │  liance()    │
            └──────┬───────┘
                   │
         ┌─────────┴──────────┐
         │                    │
      success             failure /
      + conf ≥ 0.75       low confidence
         │                    │
         ▼                    ▼
   llm-enhanced          deterministic
   result                fallback
```

Decision source is logged for every assessment as `deterministic`, `llm-enhanced`, or `hybrid`.

## Files

| File                        | Purpose                                      |
| --------------------------- | -------------------------------------------- |
| `design-document.md`        | One-page institutional design document       |
| `.env.template`             | Environment variable template                |
| `src/index.ts`              | Entry point with CLI (`seed`, `tick`, `override`)
| `src/agent.ts`              | Core deterministic agent loop                 |
| `src/tools.ts`              | Read, Evaluate, Act, Override tools           |
| `src/data-source.ts`        | Simulated JSON deliverable repository + failure injection |
| `src/memory.ts`             | Audit trail and alert history                 |
| `src/config.ts`             | Tunable agent configuration                   |
| `src/types.ts`              | Strict domain types                           |
| `src/lib/llm-agent.ts`      | Fireworks API client, Zod schemas, singleton  |
| `src/agent-hybrid.ts`       | Hybrid assessment loop                        |
| `src/tests/agent.test.ts`   | Deterministic unit tests                      |
| `src/lib/llm-agent.test.ts` | Fireworks client unit tests (mocked fetch)    |
| `src/agent-hybrid.test.ts`  | Hybrid integration tests                      |

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

## Fireworks LLM Enhancement Setup

```bash
cp .env.template .env
# Add your Fireworks API key and optional override values
# FIREWORKS_API_KEY=fw_...
# FIREWORKS_API_BASE_URL=https://api.fireworks.ai/inference/v1
# FIREWORKS_MODEL_ID=accounts/fireworks/models/kimi-k2-7
```

## Environment Variables

| Variable                   | Default                                 | Description                                       |
| -------------------------- | --------------------------------------- | ------------------------------------------------- |
| `FIREWORKS_API_KEY`        | —                                       | Required                                          |
| `FIREWORKS_API_BASE_URL`   | `https://api.fireworks.ai/inference/v1` | Fireworks inference API base URL                  |
| `FIREWORKS_MODEL_ID`       | `accounts/fireworks/models/kimi-k2-7`   | Model identifier                                  |
| `LLM_TEMPERATURE`          | `0.3`                                   | Low temperature for deterministic-leaning outputs |
| `LLM_MAX_TOKENS`           | `250`                                   | Capped to keep responses concise and cost-bounded |
| `LLM_TOP_P`                | `0.85`                                  | Nucleus sampling                                  |
| `LLM_FREQUENCY_PENALTY`    | `0.1`                                   | Reduces repetition                                |
| `LLM_PRESENCE_PENALTY`     | `0.05`                                  | Mild topic novelty encouragement                  |
| `LLM_CONFIDENCE_THRESHOLD` | `0.75`                                  | Below this, fall back to deterministic            |
| `LLM_REQUEST_TIMEOUT_MS`   | `5000`                                  | Hard timeout per LLM call                         |
| `LLM_LOG_LEVEL`            | `info`                                  | Logging verbosity                                 |

## Guardrails

| Guardrail            | Implementation                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| Source discipline    | System prompt: "Only reason about facts in the input context"                      |
| Structured output    | Zod schema validation — unstructured responses fail and trigger fallback           |
| Confidence threshold | LLM result accepted only if confidence ≥ `LLM_CONFIDENCE_THRESHOLD` (default 0.75) |
| Timeout              | AbortController at `LLM_REQUEST_TIMEOUT_MS` (default 5000 ms)                      |
| Fallback             | Any failure path returns the deterministic result instantly                        |

## Edge Cases Detected

| #   | Condition                                   | Why LLM Adds Value                                                       |
| --- | ------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Deadline within 24 hours, not submitted     | Rules say WARN; LLM assesses whether ESCALATE is warranted given urgency |
| 2   | Deadline falls on weekend or public holiday | May be a calendar misconfiguration, not genuine non-compliance           |
| 3   | Submission timestamped 23:00–00:30 UTC      | Straddles deadline boundary due to timezone offset                       |
| 4   | PM has 3+ months of late submission history | Pattern context not available to the stateless rules engine              |

## Why This Is an Agent, Not a Script

- **Memory:** preserves audit log and alert history across ticks.
- **Reasoning:** decides escalation, warning, or suppression based on priority, recency, and override state.
- **Tools:** discrete Read/Evaluate/Act/Override components make behavior transparent.
- **Adaptation:** handles malformed data gracefully, retries dependency failures, and avoids over-escalation.

## NDPR Awareness

- PM names are included in LLM context for coherent reasoning.
- The system prompt forbids speculation about personal circumstances.
- Audit log entries containing PM names should be treated as personal data under Nigeria's NDPR.
- In production, consider pseudonymizing PM names in LLM context and resolving them only in trusted audit workflows.

## Notes

This implementation is a proof of concept focused on architectural clarity, not a full production deployment. The LLM layer is additive and never replaces the deterministic fallback. The email and dashboard layers are simulated with `console.log` to keep the system runnable without external API keys.
