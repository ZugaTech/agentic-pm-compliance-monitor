import { strict as assert } from "assert";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { seedDeliverables, loadDeliverables, resetDataSourceFailure } from "../data-source";
import { Deliverable } from "../types";
import { clearMemory } from "../memory";

const execFileAsync = promisify(execFile);
const NODE = process.execPath;
const CLI_PATH = join(__dirname, "..", "..", "dist", "index.js");

async function runCli(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(NODE, [CLI_PATH, ...args], {
    windowsHide: true,
  });
  if (stderr) {
    process.stderr.write(stderr);
  }
  return stdout;
}

async function testSeedAndTick(): Promise<void> {
  clearMemory();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const d: Deliverable = {
    id: "e2e-risk-1",
    taskName: "E2E Risk Test",
    pmName: "PM E2E",
    deadline: tomorrow,
    submitted: false,
    override: false,
    priority: "STRATEGIC",
  };

  await seedDeliverables([d]);

  const output = await runCli(["tick"]);
  assert.ok(output.includes("Tick ID:"), "CLI tick should print a tick summary");
  assert.ok(output.includes("Assessments: 1"), "CLI tick should assess exactly one deliverable");
  assert.ok(output.includes("Action sets: 1"), "CLI tick should dispatch one action set for the deliverable");
  console.log("✓ CLI tick end-to-end works");
}

async function testOverrideCli(): Promise<void> {
  clearMemory();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const d: Deliverable = {
    id: "e2e-override-1",
    taskName: "E2E Override Test",
    pmName: "PM E2E",
    deadline: yesterday,
    submitted: false,
    override: false,
    priority: "CRITICAL",
  };

  await seedDeliverables([d]);

  const overrideOutput = await runCli(["override", d.id, "CoS-approved extension"]);
  assert.ok(overrideOutput.includes("Override applied to"), "CLI override should confirm the override");

  const store = await loadDeliverables();
  const updated = store.find((item) => item.id === d.id);
  assert.ok(updated, "Deliverable should exist after CLI override");
  assert.equal(updated?.override, true, "Deliverable override flag should be true");
  assert.equal(
    updated?.overrideReason,
    "CoS-approved extension",
    "CLI override reason should be persisted"
  );

  const tickOutput = await runCli(["tick"]);
  assert.ok(tickOutput.includes("Assessments: 1"), "CLI tick should still assess the overridden deliverable");
  assert.ok(tickOutput.includes("Action sets: 0"), "CLI tick should skip action for an overridden deliverable");
  console.log("✓ CLI override end-to-end works");
}

async function runAllE2ETests(): Promise<void> {
  console.log("\n=== SCENARIO B - FULL STACK E2E TESTS ===\n");
  resetDataSourceFailure();
  await testSeedAndTick();
  await testOverrideCli();
  console.log("\n=== ALL FULL STACK E2E TESTS PASSED ===\n");
}

runAllE2ETests().catch((err) => {
  console.error("E2E TEST FAILED:", err);
  process.exit(1);
});
