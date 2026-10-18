import { afterEach, describe, expect, it } from "vitest";
import { activeFaults, clearFaults, setFault } from "../control/faults.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { Housekeeping } from "./scheduler.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  clearFaults();
  await ctx?.cleanup();
  ctx = undefined;
});

async function started(runs: { count: number }) {
  ctx = await createTestContext();
  const hk = new Housekeeping(ctx.storage.housekeeping, {
    pollIntervalMs: 3_600_000,
  });
  hk.register({
    name: "probe",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => {
      runs.count += 1;
      return Promise.resolve({ ran: runs.count });
    },
  });
  await hk.start();
  return hk;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the scheduler's fault points", () => {
  it("runs the job at once when nothing holds it", async () => {
    // The witness for the held runs below.
    const runs = { count: 0 };
    const hk = await started(runs);
    expect(await hk.runNow("probe")).toMatchObject({
      kind: "ran",
      run: { outcome: "ok", result: { ran: 1 } },
    });
    await hk.stop();
  });

  it("holds a run at its start until the fault is cleared, then runs it", async () => {
    const runs = { count: 0 };
    const hk = await started(runs);
    setFault("hold:housekeeping:probe", null);
    const run = hk.runNow("probe");
    await pause(100);
    expect(runs.count).toBe(0);
    expect(activeFaults()).toEqual([
      { name: "hold:housekeeping:probe", arg: null, waiting: 1, fired: 0 },
    ]);
    clearFaults("hold:housekeeping:probe");
    expect(await run).toMatchObject({
      kind: "ran",
      run: { outcome: "ok", result: { ran: 1 } },
    });
    await hk.stop();
  });

  it("does not start a held run that a shutdown let go", async () => {
    const runs = { count: 0 };
    const hk = await started(runs);
    setFault("hold:housekeeping:probe", null);
    const run = hk.runNow("probe");
    await pause(50);
    const stopping = hk.stop();
    // What the server does first when it is told to stop.
    clearFaults();
    expect(await run).toMatchObject({
      kind: "ran",
      run: { outcome: "error", result: null },
    });
    await stopping;
    expect(runs.count).toBe(0);
    // Nothing is recorded for a run that never began: the claim stays for the
    // next boot to clear, and the schedule is as it was.
    const [row] = await ctx!.storage.housekeeping.list();
    expect(row).toMatchObject({ name: "probe", last_finished_at: null });
    expect(row?.running_since).not.toBeNull();
  });

  it("gives up on a held run at the shortened deadline, then discards what it finishes with", async () => {
    const runs = { count: 0 };
    const hk = await started(runs);
    setFault("hold:housekeeping:probe", null);
    setFault("deadline:probe", "50");
    const first = await hk.runNow("probe");
    expect(first).toMatchObject({
      kind: "ran",
      run: { outcome: "error", result: null },
    });
    expect(first.kind === "ran" && first.run.error).toContain(
      "did not finish within 50 ms",
    );
    // The name is free while the abandoned run is still held.
    expect(await hk.runNow("probe")).toMatchObject({ kind: "ran" });
    expect(runs.count).toBe(0);
    clearFaults();
    await pause(100);
    // Both abandoned runs finished their work, and neither wrote a record.
    expect(runs.count).toBe(2);
    expect(await ctx!.storage.housekeeping.get("probe")).toMatchObject({
      last_outcome: "error",
      last_result: null,
    });
    await hk.stop();
  });
});
