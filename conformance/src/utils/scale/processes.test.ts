import { afterEach, describe, expect, it } from "vitest";
import { runBounded } from "../../../scripts/scale/processes.js";

describe("runBounded", () => {
  const was = process.env.MARFA_DEVICE_BIN;
  afterEach(() => {
    if (was === undefined) delete process.env.MARFA_DEVICE_BIN;
    else process.env.MARFA_DEVICE_BIN = was;
  });

  it("fails at once for a binary that cannot start, and leaves no timer for its limit", async () => {
    process.env.MARFA_DEVICE_BIN = "/nonexistent/marfa-binary";
    const timers = () =>
      process.getActiveResourcesInfo().filter((name) => name === "Timeout")
        .length;
    const before = timers();
    await expect(runBounded(["x"], {}, 600_000)).rejects.toThrow(/ENOENT/);
    // A timer still waiting out the limit would hold the step open.
    expect(timers()).toBe(before);
  });
});
