// SCENARIO B - ENHANCED - HYBRID LOOP — Integration tests
// Tests cover the five routing paths through assessDeliverableWithLLM:
// 1. Routine case  → deterministic only, LLM never invoked
// 2. Edge case     → LLM success, confidence above threshold
// 3. Edge case     → LLM failure, deterministic fallback
// 4. Edge case     → LLM low confidence, deterministic fallback
// 5. Weekend deadline edge case detection

import { strict as assert } from "assert";
import {
  assessDeliverableWithLLM,
  detectEdgeCase,
  buildLLMContext,
  mapLLMAssessmentToStatus,
} from "./agent-hybrid";
import { assessDeliverableStatus } from "./tools";
import { clearMemory, getAuditLog } from "./memory";
import { resetLLMClient } from "./lib/llm-agent";
import { Deliverable } from "./types";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Fetch mock helpers (mirrors llm-agent.test.ts pattern)
// ---------------------------------------------------------------------------

type FetchMock = (_url: string, _opts: RequestInit) => Promise<Response>;

function mockFetch(mock: FetchMock): void {
  (global as unknown as Record<string, unknown>).fetch = mock;
}

function fireworksOK(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 90, completion_tokens: 70 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function validLLMResponse(deliverableId: string, confidence = 0.88): string {
  return JSON.stringify({
    deliverableId,
    assessment: "AT_RISK",
    reasoning:
      "Deadline falls within 24 hours and no submission has been recorded. Immediate warning is appropriate.",
    confidence,
    recommendedAction: "WARN",
    analyzedAt: new Date().toISOString(),
  });
}

function setEnv(): void {
  process.env.FIREWORKS_API_KEY = "test-key";
  process.env.LLM_CONFIDENCE_THRESHOLD = "0.75";
  process.env.LLM_REQUEST_TIMEOUT_MS = "5000";
}

// ---------------------------------------------------------------------------
// Deliverable factories
// ---------------------------------------------------------------------------

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: "dlv-hybrid-test",
    taskName: "Test Task",
    pmName: "Ada Okafor",
    deadline: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10), // 10 days out
    submitted: false,
    override: false,
    priority: "STRATEGIC",
    ...overrides,
  };
}

// Returns a deliverable whose deadline is < 24 hours away (edge case 1)
function makeWithin24hDeliverable(): Deliverable {
  const in20h = new Date(Date.now() + 20 * 3_600_000);
  return makeDeliverable({ deadline: in20h.toISOString().slice(0, 10) });
}

// Returns a deliverable whose deadline is on the next Sunday
function makeWeekendDeliverable(): Deliverable {
  const now = new Date();
  const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7;
  const sunday = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntilSunday
    )
  );
  return makeDeliverable({ deadline: sunday.toISOString().slice(0, 10) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testRoutineCase(): Promise<void> {
  clearMemory();
  resetLLMClient();
  setEnv();

  let fetchCalled = false;
  mockFetch(async () => {
    fetchCalled = true;
    return new Response("", { status: 200 });
  });

  const d = makeDeliverable(); // 10 days out — not an edge case
  const result = await assessDeliverableWithLLM(d, config);

  assert.equal(result.decisionSource, "deterministic", "routine case should be deterministic");
  assert.ok(!result.llmAnalysis, "LLM should not be invoked for routine cases");
  assert.ok(!fetchCalled, "fetch should not be called for routine cases");
  console.log("✓ Routine case: deterministic only, LLM not invoked");
}

async function testEdgeCaseLLMSuccess(): Promise<void> {
  clearMemory();
  resetLLMClient();
  setEnv();

  const d = makeWithin24hDeliverable();
  mockFetch(async () => fireworksOK(validLLMResponse(d.id, 0.88)));

  const result = await assessDeliverableWithLLM(d, config);

  assert.equal(result.decisionSource, "llm-enhanced");
  assert.ok(result.llmAnalysis?.invoked, "LLM should be invoked");
  assert.ok(!result.llmAnalysis?.failed, "LLM should not report failure");
  assert.equal(result.llmAnalysis?.confidence, 0.88);
  assert.ok(
    getAuditLog().some((e) => e.eventType === "ACT" && e.deliverableId === d.id),
    "ACT audit event should be recorded"
  );
  console.log("✓ Edge case: LLM invoked, confidence above threshold, result accepted");
}

async function testEdgeCaseLLMFailureFallback(): Promise<void> {
  clearMemory();
  resetLLMClient();
  setEnv();

  const d = makeWithin24hDeliverable();
  mockFetch(async () => new Response("Service Unavailable", { status: 503 }));

  const result = await assessDeliverableWithLLM(d, config);

  assert.equal(result.decisionSource, "deterministic", "should fall back on LLM failure");
  assert.ok(result.llmAnalysis?.invoked, "LLM invocation should be recorded");
  assert.ok(result.llmAnalysis?.failed, "failure flag should be set");
  assert.ok(
    getAuditLog().some((e) => e.eventType === "FAILURE"),
    "FAILURE audit event should be recorded"
  );
  console.log("✓ Edge case: LLM failure → deterministic fallback");
}

async function testEdgeCaseLowConfidenceFallback(): Promise<void> {
  clearMemory();
  resetLLMClient();
  setEnv();

  const d = makeWithin24hDeliverable();
  // Confidence 0.60 < threshold 0.75
  mockFetch(async () => fireworksOK(validLLMResponse(d.id, 0.60)));

  const result = await assessDeliverableWithLLM(d, config);

  assert.equal(result.decisionSource, "deterministic", "low confidence should fall back");
  assert.ok(result.llmAnalysis?.lowConfidence, "lowConfidence flag should be set");
  assert.equal(result.llmAnalysis?.confidence, 0.60);
  console.log("✓ Edge case: LLM low confidence → deterministic fallback");
}

async function testWeekendEdgeCaseDetected(): Promise<void> {
  clearMemory();

  const d = makeWeekendDeliverable();
  const assessment = assessDeliverableStatus(d, config);
  const isEdge = detectEdgeCase(d, assessment);

  assert.ok(isEdge, "weekend deadline should be detected as edge case");
  console.log("✓ Weekend deadline correctly identified as edge case");
}

async function testBuildLLMContextShape(): Promise<void> {
  const d: Deliverable = {
    id: "dlv-ctx",
    taskName: "Board Pack",
    pmName: "Emeka Nwosu",
    deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    submitted: false,
    override: false,
    priority: "CRITICAL",
  };
  const assessment = assessDeliverableStatus(d, config);
  const ctx = buildLLMContext(d, assessment);

  assert.equal(ctx.deliverableId, "dlv-ctx");
  assert.equal(ctx.pmName, "Emeka Nwosu");
  assert.equal(ctx.submissionStatus, "NOT_SUBMITTED");
  assert.ok(ctx.deadline.endsWith("Z"), "deadline should be ISO datetime");
  console.log("✓ buildLLMContext produces correct shape");
}

async function testMapLLMAssessmentToStatus(): Promise<void> {
  assert.equal(mapLLMAssessmentToStatus("COMPLIANT"), "COMPLIANT");
  assert.equal(mapLLMAssessmentToStatus("AT_RISK"), "AT_RISK");
  assert.equal(mapLLMAssessmentToStatus("LATE"), "LATE");
  assert.equal(mapLLMAssessmentToStatus("MALFORMED_DATA"), "PENDING");
  console.log("✓ mapLLMAssessmentToStatus covers all branches");
}

async function runAllTests(): Promise<void> {
  console.log("\n=== SCENARIO B - ENHANCED - HYBRID INTEGRATION TESTS ===\n");
  await testRoutineCase();
  await testEdgeCaseLLMSuccess();
  await testEdgeCaseLLMFailureFallback();
  await testEdgeCaseLowConfidenceFallback();
  await testWeekendEdgeCaseDetected();
  await testBuildLLMContextShape();
  await testMapLLMAssessmentToStatus();
  console.log("\n=== ALL HYBRID TESTS PASSED ===\n");
}

runAllTests().catch((err) => {
  console.error("HYBRID TEST FAILED:", err);
  process.exit(1);
});
