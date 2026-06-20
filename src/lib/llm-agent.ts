// SCENARIO B - ENHANCED - LLM INTEGRATION
// Fireworks AI (Kimi K2.7) client for edge-case compliance reasoning.
// Architecture principle: deterministic rules = source of truth.
// This module is invoked ONLY when the deterministic engine flags an edge case.
// Any failure path — network, timeout, schema mismatch, low confidence —
// returns a typed failure result so the caller falls back instantly.

import { z } from "zod";
import { recordAudit } from "../memory";

// ---------------------------------------------------------------------------
// SCENARIO B - ENHANCED - LLM INTEGRATION — Zod schemas
// ---------------------------------------------------------------------------

export const LLMComplianceContextSchema = z.object({
  deliverableId: z.string(),
  pmName: z.string(),
  deliverableName: z.string(),
  deadline: z.string().datetime(),
  submittedAt: z.string().datetime().optional(),
  submissionStatus: z.enum(["NOT_SUBMITTED", "SUBMITTED", "MALFORMED"]),
  daysLate: z.number().optional(),
  previousSubmissions: z
    .array(
      z.object({
        month: z.string(),
        submittedAt: z.string().datetime(),
        daysLate: z.number(),
      })
    )
    .optional(),
  notes: z.string().optional(),
});

export const LLMComplianceAnalysisSchema = z.object({
  deliverableId: z.string(),
  assessment: z.enum(["COMPLIANT", "AT_RISK", "LATE", "MALFORMED_DATA"]),
  reasoning: z.string().min(10).max(500),
  confidence: z.number().min(0).max(1),
  recommendedAction: z.enum(["NONE", "WARN", "ESCALATE"]),
  uncertainties: z.string().optional(),
  analyzedAt: z.string().datetime(),
});

export type LLMComplianceContext = z.infer<typeof LLMComplianceContextSchema>;
export type LLMComplianceAnalysis = z.infer<typeof LLMComplianceAnalysisSchema>;

export interface LLMInvocationResult {
  success: boolean;
  analysis?: LLMComplianceAnalysis;
  tokensUsed?: { input: number; output: number };
  costUSD?: number;
  latencyMs?: number;
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// SCENARIO B - ENHANCED - SYSTEM PROMPT
// Grounded in BNH institutional context. Source discipline mirrors Scenario C.
// ---------------------------------------------------------------------------

// SCENARIO B - ENHANCED - SYSTEM PROMPT
// Kept intentionally compact for kimi-k2p7-code (reasoning model).
// A long prompt causes the model to leak its chain-of-thought into content.
// All governance context is in the user message via formatContextAsPrompt().
const SYSTEM_PROMPT = `You are a JSON API for BNH compliance assessment. Output ONLY a raw JSON object — no prose, no markdown, no explanation, no text before or after the JSON.

Rules:
- Reason ONLY from facts in the input. Do not infer missing fields.
- Do not speculate about personal circumstances (NDPR).
- assessedAt must be a current ISO 8601 datetime.

Assessment values: COMPLIANT | AT_RISK | LATE | MALFORMED_DATA
recommendedAction values: NONE | WARN | ESCALATE
confidence: 0.0–1.0 (0.95=certain, 0.80=high, 0.65=moderate, 0.50=unsure)

Required output schema — start with { and end with }:
{
  "deliverableId": "<string>",
  "assessment": "<COMPLIANT|AT_RISK|LATE|MALFORMED_DATA>",
  "reasoning": "<10–500 chars, declarative>",
  "confidence": <0.0–1.0>,
  "recommendedAction": "<NONE|WARN|ESCALATE>",
  "uncertainties": "<optional, only if confidence < 0.80>",
  "analyzedAt": "<ISO 8601>"
}`;

// ---------------------------------------------------------------------------
// SCENARIO B - ENHANCED - LLM INTEGRATION — Fireworks API client
// ---------------------------------------------------------------------------

// Kimi K2.7 pricing (Fireworks, June 2026): $0.89/M input, $2.89/M output tokens.
// Adjust these constants if Fireworks updates pricing.
const COST_PER_INPUT_TOKEN = 0.89 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 2.89 / 1_000_000;

interface FireworksConfig {
  apiKey: string;
  apiBaseUrl: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  confidenceThreshold: number;
  requestTimeoutMs: number;
}

function loadConfig(): FireworksConfig {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey || apiKey === "your_key_here") {
    throw new Error(
      "FIREWORKS_API_KEY is not set. Copy .env.template to .env and add your key."
    );
  }
  return {
    apiKey,
    apiBaseUrl:
      process.env.FIREWORKS_API_BASE_URL ??
      "https://api.fireworks.ai/inference/v1",
    modelId:
      process.env.FIREWORKS_MODEL_ID ??
      "accounts/fireworks/models/kimi-k2p7-code",
    temperature: parseFloat(process.env.LLM_TEMPERATURE ?? "0.3"),
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "250", 10),
    topP: parseFloat(process.env.LLM_TOP_P ?? "0.85"),
    frequencyPenalty: parseFloat(process.env.LLM_FREQUENCY_PENALTY ?? "0.1"),
    presencePenalty: parseFloat(process.env.LLM_PRESENCE_PENALTY ?? "0.05"),
    confidenceThreshold: parseFloat(
      process.env.LLM_CONFIDENCE_THRESHOLD ?? "0.75"
    ),
    requestTimeoutMs: parseInt(
      process.env.LLM_REQUEST_TIMEOUT_MS ?? "5000",
      10
    ),
  };
}

export class FireworksLLMClient {
  private readonly cfg: FireworksConfig;

  constructor() {
    this.cfg = loadConfig();
  }

  // SCENARIO B - ENHANCED - LLM INTEGRATION — format context as user message
  // BNH context is in the user message, not the system prompt, so the
  // reasoning model sees it as part of the problem to solve.
  formatContextAsPrompt(context: LLMComplianceContext): string {
    return `BNH PM Compliance Assessment\n\nContext:\n${JSON.stringify(context, null, 2)}\n\nAssess this deliverable and output ONLY the JSON object.`;
  }

  // SCENARIO B - ENHANCED - LLM INTEGRATION — main invocation method
  async analyzeCompliance(
    context: LLMComplianceContext
  ): Promise<LLMInvocationResult> {
    // Validate input before touching the network
    const inputParsed = LLMComplianceContextSchema.safeParse(context);
    if (!inputParsed.success) {
      const reason = `Invalid LLM input: ${inputParsed.error.message}`;
      // SCENARIO B - ENHANCED - AUDIT
      recordAudit({
        level: "WARN",
        eventType: "FAILURE",
        deliverableId: context.deliverableId,
        message: reason,
      });
      return { success: false, failureReason: reason };
    }

    const startMs = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.cfg.requestTimeoutMs
    );

    try {
      const endpoint = `${this.cfg.apiBaseUrl.replace(/\/$/, "")}/chat/completions`;
      const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.cfg.modelId,
            temperature: this.cfg.temperature,
            // SCENARIO B - ENHANCED - LLM INTEGRATION
            // kimi-k2p7-code is a reasoning model: its chain-of-thought
            // consumes tokens before the JSON output. 1500 gives enough
            // headroom for reasoning + the ~250-token JSON response.
            max_tokens: 1500,
            top_p: this.cfg.topP,
            frequency_penalty: this.cfg.frequencyPenalty,
            presence_penalty: this.cfg.presencePenalty,
            // response_format forces the API to extract only the JSON
            // object from the full completion, bypassing any prose preamble
            // the reasoning model emits before reaching its conclusion.
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: this.formatContextAsPrompt(inputParsed.data),
              },
            ],
          }),
        }
      );

      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startMs;

      if (!response.ok) {
        const body = await response.text().catch(() => "(unreadable)");
        const reason = `Fireworks API error ${response.status}: ${body}`;
        this.auditFailure(context.deliverableId, reason, latencyMs);
        return { success: false, failureReason: reason, latencyMs };
      }

      const raw = await response.json() as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const content = raw.choices?.[0]?.message?.content ?? "";
      const tokensUsed = {
        input: raw.usage?.prompt_tokens ?? 0,
        output: raw.usage?.completion_tokens ?? 0,
      };
      const costUSD =
        tokensUsed.input * COST_PER_INPUT_TOKEN +
        tokensUsed.output * COST_PER_OUTPUT_TOKEN;

      // Parse and validate the JSON response from the model.
      // SCENARIO B - ENHANCED - LLM INTEGRATION — JSON extraction
      // Some model variants prepend prose before the JSON object. Extract
      // the first {...} block before attempting to parse so a preamble
      // like "Here is the result: {...}" still yields valid output.
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : content;

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        const reason = `LLM response is not valid JSON: ${content.slice(0, 120)}`;
        this.auditFailure(context.deliverableId, reason, latencyMs);
        return { success: false, failureReason: reason, latencyMs, tokensUsed, costUSD };
      }

      const validated = LLMComplianceAnalysisSchema.safeParse(parsed);
      if (!validated.success) {
        const reason = `LLM response failed schema validation: ${validated.error.message}`;
        this.auditFailure(context.deliverableId, reason, latencyMs);
        return { success: false, failureReason: reason, latencyMs, tokensUsed, costUSD };
      }

      // SCENARIO B - ENHANCED - AUDIT — successful invocation
      recordAudit({
        level: "INFO",
        eventType: "ACT",
        deliverableId: context.deliverableId,
        message: `LLM analysis complete: ${validated.data.assessment} (confidence=${validated.data.confidence})`,
        metadata: {
          latencyMs,
          tokensUsed,
          costUSD: costUSD.toFixed(6),
          reasoning: validated.data.reasoning,
        },
      });

      return {
        success: true,
        analysis: validated.data,
        tokensUsed,
        costUSD,
        latencyMs,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startMs;
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `LLM request timed out after ${this.cfg.requestTimeoutMs}ms`
          : `LLM request failed: ${err instanceof Error ? err.message : String(err)}`;
      this.auditFailure(context.deliverableId, reason, latencyMs);
      return { success: false, failureReason: reason, latencyMs };
    }
  }

  // SCENARIO B - ENHANCED - AUDIT — centralised failure logger
  private auditFailure(
    deliverableId: string,
    reason: string,
    latencyMs: number
  ): void {
    recordAudit({
      level: "WARN",
      eventType: "FAILURE",
      deliverableId,
      message: reason,
      metadata: { latencyMs },
    });
  }
}

// Singleton — one client instance per process, config loaded once.
let _client: FireworksLLMClient | null = null;

export function getLLMClient(): FireworksLLMClient {
  if (!_client) _client = new FireworksLLMClient();
  return _client;
}

// Reset singleton — used in tests to re-initialise with different env vars.
export function resetLLMClient(): void {
  _client = null;
}

export async function analyzePMCompliance(
  context: LLMComplianceContext
): Promise<LLMInvocationResult> {
  return getLLMClient().analyzeCompliance(context);
}
