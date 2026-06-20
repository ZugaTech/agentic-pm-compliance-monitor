// SCENARIO B - CORE AGENT LOOP
// The agent is an autonomous loop that continuously: READ the world state,
// EVALUATE each deliverable, ACT on the evaluation, LOG the decision, and WAIT
// for the next trigger. This is not a cron job because the loop adapts:
// it retries on failures, throttles alerts, respects human overrides, and
// maintains an audit trail across ticks.

import {
  Deliverable,
  Assessment,
  AgentConfig,
  NotificationResult,
} from "./types";
import { config } from "./config";
import { getPendingDeliverables } from "./tools";
import { assessDeliverableStatus, executeAction } from "./tools";
import { recordAudit, recordAssessment, summarizeMemory } from "./memory";

let agent_running = true;

export function stopAgent(): void {
  agent_running = false;
  recordAudit({
    level: "INFO",
    eventType: "HEARTBEAT",
    message: "Agent received stop signal",
  });
}

export function isAgentRunning(): boolean {
  return agent_running;
}

// SCENARIO B - AGENT REASONING
// This is the main orchestration. Each tick is a structured decision cycle:
// 1. READ  -> fetch data (with retries)
// 2. EVALUATE -> decide status for each deliverable
// 3. ACT -> dispatch only if throttling/override rules allow
// 4. LOG -> append every assessment to the audit trail
// 5. WAIT -> sleep until next scheduled wake
export async function runTick(cfg: AgentConfig = config): Promise<{
  tickId: string;
  assessments: Assessment[];
  actions: { deliverableId: string; results: NotificationResult[] }[];
}> {
  const tickId = `tick-${Date.now()}`;
  recordAudit({
    level: "INFO",
    eventType: "HEARTBEAT",
    message: `Agent tick ${tickId} started`,
  });

  let deliverables: Deliverable[] = [];

  // SCENARIO B - FAILURE MODE: dependency failure
  // If the data source is down, the agent retries with exponential backoff.
  // It does NOT silently continue with stale data; it logs the failure and,
  // after exhausting retries, returns an empty assessment so the CoS can see
  // the system is impaired rather than being falsely reassured.
  try {
    const readResult = await readWithRetry(cfg);
    deliverables = readResult.deliverables;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordAudit({
      level: "ERROR",
      eventType: "FAILURE",
      message: `READ failed after ${cfg.maxRetries} retries: ${msg}`,
    });
    return { tickId, assessments: [], actions: [] };
  }

  const assessments: Assessment[] = [];
  const actions: { deliverableId: string; results: NotificationResult[] }[] = [];

  for (const d of deliverables) {
    // SCENARIO B - EVALUATION
    // Each deliverable is evaluated independently. The result is a decision
    // object with a status, reason, and next action.
    const assessment = assessDeliverableStatus(d, cfg);
    assessments.push(assessment);
    recordAssessment(assessment);

    // SCENARIO B - ACTION
    // The agent executes the action only if the evaluation says so and the
    // throttling/override rules permit it. The result is recorded.
    try {
      const results = await executeAction(d, assessment, cfg);
      if (results.length > 0) {
        actions.push({ deliverableId: d.id, results });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordAudit({
        level: "ERROR",
        eventType: "FAILURE",
        deliverableId: d.id,
        message: `ACT failed: ${msg}`,
      });
    }
  }

  recordAudit({
    level: "INFO",
    eventType: "HEARTBEAT",
    message: `Agent tick ${tickId} completed. ${assessments.length} assessed, ${actions.length} action sets executed.`,
    metadata: { summary: summarizeMemory() },
  });

  return { tickId, assessments, actions };
}

async function readWithRetry(
  cfg: AgentConfig
): ReturnType<typeof getPendingDeliverables> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
    try {
      return await getPendingDeliverables();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const backoff = Math.pow(2, attempt) * 100;
      recordAudit({
        level: "WARN",
        eventType: "FAILURE",
        message: `READ attempt ${attempt + 1}/${cfg.maxRetries} failed; retrying in ${backoff}ms`,
        metadata: { error: lastErr.message },
      });
      await sleep(backoff);
    }
  }
  throw lastErr ?? new Error("Unknown read failure");
}

export async function runLoop(cfg: AgentConfig = config): Promise<void> {
  agent_running = true;
  while (agent_running) {
    await runTick(cfg);

    // SCENARIO B - WAIT
    // The agent sleeps, but remains interruptible. In production this is
    // replaced by a scheduler (EventBridge/CronJob) or event-driven trigger.
    recordAudit({
      level: "INFO",
      eventType: "HEARTBEAT",
      message: `Agent sleeping for ${cfg.loopIntervalMs}ms`,
    });
    await sleep(cfg.loopIntervalMs);
  }
  recordAudit({
    level: "INFO",
    eventType: "HEARTBEAT",
    message: "Agent loop exited cleanly",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sleep };
