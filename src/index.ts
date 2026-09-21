// SCENARIO B - ENTRY POINT
// Production-style bootstrap: start the agent, wire up graceful shutdown,
// and expose a simple CLI override interface. This proves the system is a
// runnable application, not just a snippet.

import { runLoop, stopAgent, runTick } from "./agent";
import { config } from "./config";
import { clearMemory, getAuditLog } from "./memory";
import { loadDeliverables, saveDeliverables } from "./data-source";
import { ensureSampleData } from "./data-source";
import { markOverride } from "./tools";

async function main(): Promise<void> {
  clearMemory();

  // Optional: process a CLI override request, e.g.:
  //   node dist/index.js override dlv-001 "Extension approved by CoS"
  const [cmd, id, ...reasonParts] = process.argv.slice(2);
  if (cmd === "override" && id && reasonParts.length > 0) {
    const reason = reasonParts.join(" ");
    const store = await loadDeliverables();
    const idx = store.findIndex((d) => d.id === id);
    if (idx === -1) {
      console.error(`Unknown deliverable id: ${id}`);
      process.exit(1);
    }
    const updated = markOverride(store[idx], reason);
    store[idx] = updated;
    await saveDeliverables(store);
    console.log(`Override applied to ${id}: ${reason}`);
    return;
  }

  if (cmd === "seed") {
    // Reset sample data to the shipped scenario dataset.
    const sample = ensureSampleData();
    await saveDeliverables(sample);
    console.log(`Sample data re-seeded with ${sample.length} deliverables.`);
    return;
  }

  if (cmd === "tick") {
    // Single evaluation run; useful for demos and health checks.
    await loadDeliverables();
    const result = await runTick(config);
    console.log("\n=== TICK SUMMARY ===");
    console.log(`Tick ID: ${result.tickId}`);
    console.log(`Assessments: ${result.assessments.length}`);
    console.log(`Action sets: ${result.actions.length}`);
    console.log("\n=== AUDIT TRAIL ===");
    getAuditLog().forEach((e) => {
      console.log(`[${e.timestamp}] ${e.level} ${e.eventType}: ${e.message}`);
    });
    return;
  }

  // Default: run the continuous agent loop.
  console.log("Starting NBH Agentic PM Compliance Monitor...");
  await loadDeliverables();

  // Graceful shutdown on Ctrl+C.
  process.on("SIGINT", () => {
    console.log("\nShutting down agent...");
    stopAgent();
  });

  await runLoop(config);

  console.log("\n=== FINAL AUDIT TRAIL ===");
  getAuditLog().forEach((e) => {
    console.log(`[${e.timestamp}] ${e.level} ${e.eventType}: ${e.message}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
