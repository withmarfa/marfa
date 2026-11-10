import { describe, expect, it } from "vitest";
import { Tasks } from "./tasks.js";

describe("Tasks", () => {
  it("stops every task still running, and each once", async () => {
    const tasks = new Tasks();
    const calls: string[] = [];
    const first = tasks.own(async () => {
      calls.push("first");
      return 1;
    });
    tasks.own(async () => {
      calls.push("second");
    });
    expect(await first()).toBe(1);
    await tasks.stopAll();
    expect(calls).toEqual(["first", "second"]);
  });

  it("stops the rest when one fails to stop, and says which failed", async () => {
    const tasks = new Tasks();
    let stopped = false;
    tasks.own(async () => {
      throw new Error("would not stop");
    });
    tasks.own(async () => {
      stopped = true;
    });
    const failures = await tasks.stopAll();
    expect(stopped).toBe(true);
    expect(failures).toEqual([expect.stringContaining("would not stop")]);
  });
});
