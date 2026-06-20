# BNH Agentic PM Compliance Monitor — LLM Enhancement (Scenario B Enhanced)

Additive enhancement to Scenario B. The deterministic rules engine is
unchanged. This layer adds Kimi K2.7 (via Fireworks AI) reasoning for the
~5–10% of assessments that fall into genuine edge cases.

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

**Decision source is logged for every assessment:**
`deterministic` | `llm-enhanced` | `hybrid`

## New Files

| File | Purpose |
|------|---------|
| `.env.template` | Environment variable template |
| `src/lib/llm-agent.ts` | Fireworks API client, Zod schemas, singleton |
| `src/lib/llm-agent.test.ts` | LLM client unit tests (mocked fetch) |
| `src/agent-hybrid.ts` | Hybrid assessment loop |
| `src/agent-hybrid.test.ts` | Hybrid integration tests |

## Setup

```bash
# 1. Install zod (new dependency)
npm install

# 2. Create .env from template
cp .env.template .env

# 3. Add your Fireworks API key to .env
#    FIREWORKS_API_KEY=fw_...

# 4. Build
npm run build

# 5. Run all tests (deterministic + LLM unit + hybrid integration)
npm run test
```

## Edge Cases Detected

| # | Condition | Why LLM Adds Value |
|---|-----------|-------------------|
| 1 | Deadline within 24 hours, not submitted | Rules say WARN; LLM assesses whether ESCALATE is warranted given urgency |
| 2 | Deadline falls on weekend or public holiday | May be a calendar misconfiguration, not genuine non-compliance |
| 3 | Submission timestamped 23:00–00:30 UTC | Straddles deadline boundary due to timezone offset |
| 4 | PM has 3+ months of late submission history | Pattern context not available to the stateless rules engine |

## Guardrails

| Guardrail | Implementation |
|-----------|---------------|
| Source discipline | System prompt: "Only reason about facts in the input context" |
| Structured output | Zod schema validation — unstructured response fails and triggers fallback |
| Confidence threshold | LLM result accepted only if confidence ≥ `LLM_CONFIDENCE_THRESHOLD` (default 0.75) |
| Timeout | AbortController at `LLM_REQUEST_TIMEOUT_MS` (default 5 000 ms) |
| Fallback | Any failure path returns the deterministic result instantly |

## Cost Model

- Model: Kimi K2.7 via Fireworks AI
- Pricing (June 2026): $0.89 / 1M input tokens · $2.89 / 1M output tokens
- Typical invocation: ~90 input tokens + ~70 output tokens ≈ $0.000282
- At 5% edge-case rate across 100 daily assessments: ~5 LLM calls/day
- Estimated monthly cost: **< $0.05 / month**

Cost per invocation is logged to the audit trail. Add a cost accumulator to
`memory.ts` and an alert threshold to `config.ts` if you want hard budget caps.

## NDPR Awareness

- PM names are included in LLM context (required for coherent reasoning).
- The system prompt instructs the model: *"Do not speculate about personal
  circumstances."* Reasoning is constrained to observable facts.
- Audit log entries containing PM names should be treated as personal data
  under Nigeria's NDPR. Access to the audit log should be restricted to the
  CoS and Head of AI & Digital Systems.
- In production, consider pseudonymising PM names in LLM context and
  resolving them back in the audit layer.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FIREWORKS_API_KEY` | — | Required |
| `FIREWORKS_MODEL_ID` | `accounts/fireworks/models/kimi-k2-7` | Model identifier |
| `LLM_TEMPERATURE` | `0.3` | Low temperature for deterministic-leaning outputs |
| `LLM_MAX_TOKENS` | `250` | Capped to keep responses concise and cost-bounded |
| `LLM_TOP_P` | `0.85` | Nucleus sampling |
| `LLM_FREQUENCY_PENALTY` | `0.1` | Reduces repetition |
| `LLM_PRESENCE_PENALTY` | `0.05` | Mild topic novelty encouragement |
| `LLM_CONFIDENCE_THRESHOLD` | `0.75` | Below this, fall back to deterministic |
| `LLM_REQUEST_TIMEOUT_MS` | `5000` | Hard timeout per LLM call |
| `LLM_LOG_LEVEL` | `info` | Logging verbosity |
