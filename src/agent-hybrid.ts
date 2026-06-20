// SCENARIO B - ENHANCED - HYBRID LOOP
// Wraps the deterministic compliance engine with an optional LLM reasoning
// layer for edge cases. Architecture principle: deterministic rules always
// run first and are always the fallback. LLM is invoked for ~5-10% of
// assessments where rules alone cannot resolve ambiguity confidently.

import { Deliverable, DeliverableStatus, Assessment, AgentConfig } from "./types";
import { config } from "./config";
import { assessDeliverableStatus } from "./tools";
import { recordAudit } from "./memory";
import {
  analyzePMCompliance,
  LLMComplianceContext,
  LLMComplianceAnalysis,
  LLMInvocationResult,
} from "./lib/llm-agent";

const LLM_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.LLM_CONFIDENCE_THRESHOLD ?? "0.75"
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HybridAssessmentResult {
  deliverableId: string;
  status: DeliverableStatus;
  reason: string;
  deterministicAssessment: Assessment;
  llmAnalysis?: {
    invoked: boolean;
    analysis?: LLMComplianceAnalysis;
    confidence?: number;
    tokensUsed?: { input: number; output: number };
    costUSD?: number;
    latencyMs?: number;
    failed?: boolean;
    lowConfidence?: boolean;
  };
  finalDecisionRationale: string;
  decisionSource: "deterministic" | "llm-enhanced" | "hybrid";
}

// Stub for historical submission lookup. In production this queries the
// `audit_log` table and returns the last N submission records for the PM.
export interface HistoricalSubmission {
  month: string;
  submittedAt: string;
  daysLate: number;
}

// ---------------------------------------------------------------------------
// SCENARIO B - ENHANCED - EDGE CASE — detection logic
// Returns true only for the narrow set of cases where LLM reasoning adds
// value over deterministic rules. Keeping this gate strict is what limits
// LLM invocations to ~5-10% of assessments.
// ---------------------------------------------------------------------------

export function detectEdgeCase(
  deliverable: Deliverable,
  assessment: Assessment
): boolean {
  const now = new Date();
  const deadline = new Date(`${deliverable.deadline}T00:00:00.000Z`);

  // Edge case 1: Borderline AT_RISK — within 24 hours of deadline.
  // Rules say AT_RISK for ≤3 days; LLM can assess whether urgency warrants
  // immediate escalation rather than a standard warning.
  if (assessment.status === "AT_RISK") {
    const hoursToDeadline =
      (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursToDeadline >= 0 && hoursToDeadline <= 24) return true;
  }

  // Edge case 2: Weekend or public holiday deadline.
  // A deadline falling on Saturday (6) or Sunday (0) may reflect a
  // calendar misconfiguration rather than genuine non-compliance.
  if (!deliverable.submitted) {
    const dayOfWeek = deadline.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return true;
  }

  // Edge case 3: Ambiguous / very-late-night submission timestamp.
  // Submissions timestamped between 23:00 and 00:30 UTC may straddle the
  // deadline boundary due to timezone offsets; LLM can reason about the
  // notes field for context.
  if (deliverable.submitted && deliverable.submittedAt) {
    const submittedHour = new Date(deliverable.submittedAt).getUTCHours();
    if (submittedHour >= 23 || submittedHour === 0) return true;
  }

  // Edge case 4: Historical pattern — PM has ≥3 months of prior late data.
  // The rules engine has no memory of past behaviour; LLM can factor in
  // pattern context if previousSubmissions are supplied.
  // (Actual history is injected by buildLLMContext via getHistoricalSubmissions.)

  return false;
}

// ---------------------------------------------------------------------------
// SCENARIO B - ENHANCED - HYBRID LOOP — context builder
// ---------------------------------------------------------------------------

export function getHistoricalSubmissions(
  _pmName: string
): HistoricalSubmission[] {
  // Stub — production implementation queries audit_log / deliverables table.
  // Returns empty array so the agent degrades gracefully without history.
  return [];
}

export function buildLLMContext(
  deliverable: Deliverable,
  assessment: Assessment
): LLMComplianceContext {
  const history = getHistoricalSubmissions(deliverable.pmName);
  const daysLate =
    assessment.status === "LATE"
      ? parseInt(
          assessment.reason.match(/(\d+) business day/)?.[1] ?? "0",
          10
        )
      : 0;

  return {
    deliverableId: deliverable.id,
    pmName: deliverable.pmName,
    deliverableName: deliverable.taskName,
    deadline: `${deliverable.deadline}T00:00:00.000Z`,
    submittedAt: deliverable.submittedAt
      ? `${deliverable.submittedAt}T00:00:00.000Z`
      : undefined,
    submissionStatus: deliverable.submitted
      ? "SUBMITTED"
      : deliverable.deadline === "not-a-date"
      ? "MALFORMED"
      : "NOT_SUBMITTED",
    daysLate: daysLate > 0 ? daysLate : undefined,
    previousSubmissions:
      history.length > 0
        ? history.map((h) => ({
            month: h.month,
            submittedAt: h.submittedAt,
            daysLate: h.daysLate,
          }))
        : undefined,
    notes: deliverable.overrideReason,
  };
}

export function mapLLMAssessmentToStatus(
  llmAssessment: LLMComplianceAnalysis["assessment"]
): DeliverableStatus {
  const map: Record<string, DeliverableStatus> = {
    COMPLIANT: "COMPLIANT",
    AT_RISK: "AT_RISK",
    LATE: "LATE",
    MALFORMED_DATA: "PENDING",
  };
  return map[llmAssessment] ?? "PENDING";
}

// ---------------------------------------------------------------------------
// SCENARIO B - ENHANCED - HYBRID LOOP — main assessment function
// ---------------------------------------------------------------------------

export async function assessDeliverableWithLLM(
  deliverable: Deliverable,
  cfg: AgentConfig = config
): Promise<HybridAssessmentResult> {
  // Step 1: Deterministic assessment — always runs, never skipped.
  const deterministicAssessment = assessDeliverableStatus(deliverable, cfg);

  // Step 2: Determine if this is an edge case worth sending to the LLM.
  const isEdgeCase = detectEdgeCase(deliverable, deterministicAssessment);

  // SCENARIO B - ENHANCED - AUDIT — log routing decision
  recordAudit({
    level: "INFO",
    eventType: "EVALUATE",
    deliverableId: deliverable.id,
    message: `Hybrid router: isEdgeCase=${isEdgeCase}, deterministicStatus=${deterministicAssessment.status}`,
  });

  // Step 3: Routine case — return deterministic result immediately.
  if (!isEdgeCase) {
    return {
      deliverableId: deliverable.id,
      status: deterministicAssessment.status,
      reason: deterministicAssessment.reason,
      deterministicAssessment,
      finalDecisionRationale: "Routine case — deterministic rules applied directly.",
      decisionSource: "deterministic",
    };
  }

  // Step 4: Invoke LLM for edge case.
  const llmContext = buildLLMContext(deliverable, deterministicAssessment);
  let llmResult: LLMInvocationResult;

  try {
    llmResult = await analyzePMCompliance(llmContext);
  } catch (err) {
    // SCENARIO B - ENHANCED - FALLBACK — unexpected throw from LLM client
    const msg = err instanceof Error ? err.message : String(err);
    recordAudit({
      level: "WARN",
      eventType: "FAILURE",
      deliverableId: deliverable.id,
      message: `LLM invocation threw unexpectedly: ${msg}. Falling back to deterministic.`,
    });
    return {
      deliverableId: deliverable.id,
      status: deterministicAssessment.status,
      reason: deterministicAssessment.reason,
      deterministicAssessment,
      llmAnalysis: { invoked: true, failed: true },
      finalDecisionRationale: `LLM threw: ${msg}. Deterministic fallback applied.`,
      decisionSource: "deterministic",
    };
  }

  // Step 5: LLM network/schema failure — fall back.
  if (!llmResult.success) {
    // SCENARIO B - ENHANCED - FALLBACK
    recordAudit({
      level: "WARN",
      eventType: "FAILURE",
      deliverableId: deliverable.id,
      message: `LLM failed (${llmResult.failureReason}). Falling back to deterministic.`,
    });
    return {
      deliverableId: deliverable.id,
      status: deterministicAssessment.status,
      reason: deterministicAssessment.reason,
      deterministicAssessment,
      llmAnalysis: {
        invoked: true,
        failed: true,
        latencyMs: llmResult.latencyMs,
        tokensUsed: llmResult.tokensUsed,
        costUSD: llmResult.costUSD,
      },
      finalDecisionRationale: `LLM failed: ${llmResult.failureReason}. Deterministic fallback applied.`,
      decisionSource: "deterministic",
    };
  }

  const analysis = llmResult.analysis!;

  // Step 6: Confidence threshold check — fall back if uncertain.
  if (analysis.confidence < LLM_CONFIDENCE_THRESHOLD) {
    // SCENARIO B - ENHANCED - FALLBACK
    recordAudit({
      level: "INFO",
      eventType: "EVALUATE",
      deliverableId: deliverable.id,
      message: `LLM confidence ${analysis.confidence} below threshold ${LLM_CONFIDENCE_THRESHOLD}. Falling back to deterministic.`,
      metadata: { uncertainties: analysis.uncertainties },
    });
    return {
      deliverableId: deliverable.id,
      status: deterministicAssessment.status,
      reason: deterministicAssessment.reason,
      deterministicAssessment,
      llmAnalysis: {
        invoked: true,
        lowConfidence: true,
        confidence: analysis.confidence,
        latencyMs: llmResult.latencyMs,
        tokensUsed: llmResult.tokensUsed,
        costUSD: llmResult.costUSD,
      },
      finalDecisionRationale: `LLM confidence too low (${analysis.confidence}). Deterministic fallback applied.`,
      decisionSource: "deterministic",
    };
  }

  // Step 7: LLM result accepted — use it, log the full decision context.
  // SCENARIO B - ENHANCED - AUDIT
  recordAudit({
    level: "INFO",
    eventType: "ACT",
    deliverableId: deliverable.id,
    message: `LLM-enhanced decision: ${analysis.assessment} (confidence=${analysis.confidence})`,
    metadata: {
      reasoning: analysis.reasoning,
      recommendedAction: analysis.recommendedAction,
      tokensUsed: llmResult.tokensUsed,
      costUSD: llmResult.costUSD?.toFixed(6),
    },
  });

  return {
    deliverableId: deliverable.id,
    status: mapLLMAssessmentToStatus(analysis.assessment),
    reason: analysis.reasoning,
    deterministicAssessment,
    llmAnalysis: {
      invoked: true,
      analysis,
      confidence: analysis.confidence,
      latencyMs: llmResult.latencyMs,
      tokensUsed: llmResult.tokensUsed,
      costUSD: llmResult.costUSD,
    },
    finalDecisionRationale: `LLM-enhanced: confidence=${analysis.confidence}. ${analysis.reasoning}`,
    decisionSource: "llm-enhanced",
  };
}
