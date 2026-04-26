import { describe, expect, it } from "vitest";
import {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  ReconnectCounter,
  nextReconnectDelay,
} from "../../src/sync/reconnect.js";

describe("nextReconnectDelay", () => {
  it("returns 0 when there are no recorded fast-failures", () => {
    expect(nextReconnectDelay(0, () => 0.5)).toBe(0);
  });

  it("first failure returns roughly base delay (with jitter)", () => {
    const noJitter = () => 0.5; // jitter of 0
    expect(nextReconnectDelay(1, noJitter)).toBe(BASE_DELAY_MS);
  });

  it("doubles each failure exponentially up to MAX_DELAY_MS", () => {
    const noJitter = () => 0.5;
    expect(nextReconnectDelay(1, noJitter)).toBe(1_000);
    expect(nextReconnectDelay(2, noJitter)).toBe(2_000);
    expect(nextReconnectDelay(3, noJitter)).toBe(4_000);
    expect(nextReconnectDelay(4, noJitter)).toBe(8_000);
    expect(nextReconnectDelay(5, noJitter)).toBe(16_000);
    expect(nextReconnectDelay(6, noJitter)).toBe(MAX_DELAY_MS);
    expect(nextReconnectDelay(10, noJitter)).toBe(MAX_DELAY_MS);
  });

  it("applies jitter within ±20%", () => {
    const lowJitter = () => 0; // returns -20%
    const highJitter = () => 1; // returns +20%
    expect(nextReconnectDelay(3, lowJitter)).toBe(Math.round(4_000 * 0.8));
    expect(nextReconnectDelay(3, highJitter)).toBe(Math.round(4_000 * 1.2));
  });
});

describe("ReconnectCounter", () => {
  it("increments on fast failure, resets on healthy", () => {
    const c = new ReconnectCounter();
    expect(c.count).toBe(0);
    c.recordFastFailure();
    c.recordFastFailure();
    expect(c.count).toBe(2);
    c.recordHealthy();
    expect(c.count).toBe(0);
  });
});
