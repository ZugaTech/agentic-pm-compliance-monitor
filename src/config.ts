// SCENARIO B - CONFIGURATION
// Centralizing config lets the CoS tune the agent without touching code, and
// makes the agent's reasoning transparent (e.g., why 3 days is the risk window).

import { AgentConfig } from "./types";

export { AgentConfig };
export const config: AgentConfig = {
  timezone: "Africa/Lagos", // BNH operational timezone for this scenario
  riskWindowDays: 3, // deadline within 3 days => AT_RISK
  escalationThrottleMinutes: 60, // do not re-escalate the same item within 1 hour
  loopIntervalMs: 6 * 60 * 60 * 1000, // 6 hours in production; overridden in tests
  maxRetries: 3,
  businessHolidays: [
    // Sample holidays; in production loaded from a calendar service
    "2026-12-25",
    "2026-12-26",
    "2027-01-01",
  ],
};

export function withConfigOverrides(overrides: Partial<AgentConfig>): AgentConfig {
  return { ...config, ...overrides };
}
