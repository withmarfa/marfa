import { describe, expect, it } from "vitest";
import { runScript } from "./fresh-server.js";

describe("the fixture server's script runner", () => {
  it("keeps the worker's timers ticking while a script runs", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const ran = await runScript(
        process.execPath,
        ["-e", "setTimeout(() => console.log('slept'), 500)"],
        process.env,
      );
      expect(ran).toEqual({ status: 0, output: "slept\n" });
      // Half a second of script leaves room for dozens of ticks; a runner
      // that held the worker would let it pass with none.
      expect(ticks).toBeGreaterThanOrEqual(10);
    } finally {
      clearInterval(timer);
    }
  });
});
