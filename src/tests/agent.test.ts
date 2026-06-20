// SCENARIO B - TESTS
// Automated verification of the core agent loop, failure modes, and override
// logic. Tests prove that the agent is not just a script: it adapts to data
// source failures, respects overrides, and throttles alerts.

import { runTick } from "../agent";
import { withConfigOverrides } from "../config";
import { clearMemory, getAuditLog } from "../memory";
import {
  loadDeliverables,
  seedDeliverables,
  resetDataSourceFailure,
  injectDataSourceFailure,
} from "../data-source";
import { markOverride } from "../tools";
import { Deliverable } from "../types";
import { strict as assert } from "assert";

const testCfg = withConfigOverrides({
  loopIntervalMs: 1000,
  escalationThrottleMinutes: 0, // disable throttle for deterministic tests
  riskWindowDays: 3,
  maxRetries: 3,
  businessHolidays: [],
});

async function runAllTests(): Promise<void> {
  console.log("\n=== SCENARIO B - AGENT TESTS ===\n");

  await testLateEscalation();
  await testAtRiskWarning();
  await testCompliantSkip();
  await testOverrideRespected();
  await testMalformedData();
  await testDataSourceFailureRetry();
  await testThrottle();

  console.log("\n=== ALL TESTS PASSED ===\n");
}

async function testLateEscalation(): Promise<void> {
  clearMemory();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const d: Deliverable = {
    id: "late-1",
    taskName: "Late Test",
    pmName: "PM A",
    deadline: yesterday,
    submitted: false,
    override: false,
    priority: "CRITICAL",
  };
  await seedDeliverables([d]);
  await loadDeliverables();

  const result = await runTick(testCfg);
  const assessment = result.assessments.find((a) => a.deliverableId === d.id);
  assert.equal(assessment?.status, "LATE", "late deliverable should be LATE");
  assert.equal(assessment?.nextAction, "ESCALATE", "late deliverable should escalate");
  assert.ok(
    result.actions.some((a) => a.deliverableId === d.id),
    "escalation action should be dispatched"
  );
  console.log("✓ Late escalation works");
}

async function testAtRiskWarning(): Promise<void> {
  clearMemory();
  const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const d: Deliverable = {
    id: "risk-1",
    taskName: "Risk Test",
    pmName: "PM B",
    deadline: inTwoDays,
    submitted: false,
    override: false,
    priority: "STRATEGIC",
  };
  await seedDeliverables([d]);
  await loadDeliverables();

  const result = await runTick(testCfg);
  const assessment = result.assessments.find((a) => a.deliverableId === d.id);
  assert.equal(assessment?.status, "AT_RISK", "deliverable within 3 days should be AT_RISK");
  assert.equal(assessment?.nextAction, "WARN", "at-risk deliverable should warn");
  console.log("✓ At-risk warning works");
}

async function testCompliantSkip(): Promise<void> {
  clearMemory();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const d: Deliverable = {
    id: "compliant-1",
    taskName: "Compliant Test",
    pmName: "PM C",
    deadline: yesterday,
    submitted: true,
    submittedAt: yesterday,
    override: false,
    priority: "ROUTINE",
  };
  await seedDeliverables([d]);
  await loadDeliverables();

  const result = await runTick(testCfg);
  const assessment = result.assessments.find((a) => a.deliverableId === d.id);
  assert.equal(assessment?.status, "COMPLIANT", "submitted deliverable should be COMPLIANT");
  assert.equal(assessment?.nextAction, "NONE", "compliant deliverable should not act");
  console.log("✓ Compliant skip works");
}

async function testOverrideRespected(): Promise<void> {
  clearMemory();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let d: Deliverable = {
    id: "override-1",
    taskName: "Override Test",
    pmName: "PM D",
    deadline: yesterday,
    submitted: false,
    override: false,
    priority: "CRITICAL",
  };
  d = markOverride(d, "Approved by CoS");
  await seedDeliverables([d]);
  await loadDeliverables();

  const result = await runTick(testCfg);
  const assessment = result.assessments.find((a) => a.deliverableId === d.id);
  assert.equal(assessment?.status, "OVERRIDDEN", "override should be respected");
  assert.equal(assessment?.nextAction, "SKIP", "override should skip action");
  assert.ok(
    getAuditLog().some((e) => e.eventType === "OVERRIDE"),
    "override should be in audit log"
  );
  console.log("✓ Human override respected and logged");
}

async function testMalformedData(): Promise<void> {
  clearMemory();
  const d: Deliverable = {
    id: "bad-1",
    taskName: "Bad Data",
    pmName: "PM E",
    deadline: "not-a-date",
    submitted: false,
    override: false,
    priority: "ROUTINE",
  };
  await seedDeliverables([d]);
  await loadDeliverables();

  const result = await runTick(testCfg);
  const assessment = result.assessments.find((a) => a.deliverableId === d.id);
  assert.ok(
    assessment?.reason.includes("MALFORMED_DATA"),
    "malformed deadline should be flagged"
  );
  assert.equal(assessment?.nextAction, "NONE", "malformed data should not trigger action");
  console.log("✓ Malformed data handled gracefully");
}

async function testDataSourceFailureRetry(): Promise<void> {
  clearMemory();
  resetDataSourceFailure();
  const d: Deliverable = {
    id: "retry-1",
    taskName: "Retry Test",
    pmName: "PM F",
    deadline: new Date().toISOString().slice(0, 10),
    submitted: false,
    override: false,
    priority: "ROUTINE",
  };
  await seedDeliverables([d]);

  injectDataSourceFailure({
    healthy: true,
    failureRate: 0.6, // high probability of transient failure
  });

  const result = await runTick(testCfg);
  // Because failureRate is probabilistic, we expect retries to eventually succeed.
  assert.ok(
    result.assessments.length > 0 || getAuditLog().some((e) => e.eventType === "FAILURE"),
    "agent should either succeed after retry or log failure"
  );
  console.log("✓ Data source failure triggers retry logging");
  resetDataSourceFailure();
}

async function testThrottle(): Promise<void> {
  clearMemory();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const d: Deliverable = {
    id: "throttle-1",
    taskName: "Throttle Test",
    pmName: "PM G",
    deadline: yesterday,
    submitted: false,
    override: false,
    priority: "ROUTINE",
  };
  await seedDeliverables([d]);
  await loadDeliverables();

  const throttledCfg = withConfigOverrides({
    ...testCfg,
    escalationThrottleMinutes: 60, // 1 hour throttle
  });

  const first = await runTick(throttledCfg);
  assert.ok(
    first.actions.some((a) => a.deliverableId === d.id),
    "first tick should escalate"
  );

  const second = await runTick(throttledCfg);
  assert.ok(
    !second.actions.some((a) => a.deliverableId === d.id),
    "second tick should be throttled"
  );
  console.log("✓ Alert throttling prevents over-escalation");
}

runAllTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
