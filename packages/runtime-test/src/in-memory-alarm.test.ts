import { describe, it, expect } from "vitest";
import { createInMemoryAlarm } from "./in-memory-alarm.js";

describe("createInMemoryAlarm", () => {
  it("captures the scheduled time", () => {
    const a = createInMemoryAlarm();
    a.setAlarm(1_700_000_000_000);
    expect(a.getAlarm()).toBe(1_700_000_000_000);
  });

  it("cancelAlarm clears it", () => {
    const a = createInMemoryAlarm();
    a.setAlarm(1000);
    a.cancelAlarm();
    expect(a.getAlarm()).toBeNull();
  });

  it("tick fires the handler when now >= scheduled and resets", async () => {
    const a = createInMemoryAlarm();
    let calls = 0;
    a.setHandler(() => {
      calls++;
      return Promise.resolve();
    });
    a.setAlarm(100);
    expect(await a.tick(50)).toBe(false);
    expect(calls).toBe(0);
    expect(await a.tick(150)).toBe(true);
    expect(calls).toBe(1);
    expect(a.getAlarm()).toBeNull();
  });

  it("tick is a no-op when no alarm is set", async () => {
    const a = createInMemoryAlarm();
    expect(await a.tick(Date.now())).toBe(false);
  });
});
