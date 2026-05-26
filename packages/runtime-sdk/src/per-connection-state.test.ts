import { describe, it, expect } from "vitest";
import { PerConnectionStateCore } from "./per-connection-state.js";
import { createInMemoryStorage } from "./in-memory-storage.js";
import type { RuntimeCredential } from "./types.js";

function makeCore(): PerConnectionStateCore {
  return new PerConnectionStateCore({ storage: createInMemoryStorage() });
}

const CRED: RuntimeCredential = {
  api_key: "marfa_k1_test",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  connection_id: "conn_1",
};

describe("PerConnectionStateCore", () => {
  describe("runtime credential cache", () => {
    it("returns null when no credential is cached", async () => {
      const core = makeCore();
      expect(await core.getRuntimeCredential()).toBeNull();
    });

    it("round-trips a fresh credential", async () => {
      const core = makeCore();
      await core.setRuntimeCredential(CRED);
      expect(await core.getRuntimeCredential()).toEqual(CRED);
    });

    it("evicts an expired credential and returns null", async () => {
      const core = makeCore();
      const expired: RuntimeCredential = {
        ...CRED,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      };
      await core.setRuntimeCredential(expired);
      expect(await core.getRuntimeCredential()).toBeNull();
    });
  });

  describe("idempotency window", () => {
    it("returns false on first sight, true on repeat", async () => {
      const core = makeCore();
      expect(await core.checkAndRecordDelivery("d_1")).toBe(false);
      expect(await core.checkAndRecordDelivery("d_1")).toBe(true);
    });

    it("isolates delivery ids", async () => {
      const core = makeCore();
      expect(await core.checkAndRecordDelivery("d_a")).toBe(false);
      expect(await core.checkAndRecordDelivery("d_b")).toBe(false);
      expect(await core.checkAndRecordDelivery("d_a")).toBe(true);
      expect(await core.checkAndRecordDelivery("d_b")).toBe(true);
    });
  });

  describe("error tail", () => {
    it("records and lists in newest-first order", async () => {
      const core = makeCore();
      await core.recordError("first failure", 1);
      // 5ms separation defends the at-desc sort against sub-ms
      // timestamp collisions on fast machines (CI runners
      // occasionally produce the same Date.now() for two adjacent
      // synchronous calls).
      await new Promise((r) => setTimeout(r, 5));
      await core.recordError("second failure", 2);
      const errors = await core.listRecentErrors();
      expect(errors).toHaveLength(2);
      expect(errors[0]!.message).toBe("second failure");
      expect(errors[1]!.message).toBe("first failure");
    });
  });

  describe("alarm scheduling", () => {
    it("returns null when no run is scheduled", async () => {
      const core = makeCore();
      expect(await core.getNextRunAt()).toBeNull();
    });

    it("round-trips next_run_at_ms", async () => {
      const core = makeCore();
      await core.setNextRunAt(1_700_000_000_000);
      expect(await core.getNextRunAt()).toBe(1_700_000_000_000);
    });
  });
});
