/**
 * Cross-connection exclusion for the consent lock's Postgres backend.
 * Two separate clients against one database stand in for two server
 * processes — the property the in-process mutex alone cannot provide,
 * and the reason a revoked permission could silently come back on a
 * multi-process deployment.
 */
import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { cloneTemplate } from "./test-template.js";
import { createPgConsentLockBackend } from "./consent-lock-backend.js";
import type { PgClient } from "./connection.js";

const isPg = process.env.DB_DIALECT === "pg";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function client(url: string, max = 2): PgClient {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return postgres(url, { max, onnotice: () => {} });
}

describe.skipIf(!isPg)("pg consent lock backend", () => {
  it("excludes across two clients: peak holders is one", async () => {
    const clone = await cloneTemplate();
    const a = client(clone.url);
    const b = client(clone.url);
    try {
      const backendA = createPgConsentLockBackend(a);
      const backendB = createPgConsentLockBackend(b);
      let inFlight = 0;
      let peak = 0;
      const work = async (): Promise<void> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(300);
        inFlight -= 1;
      };
      await Promise.all([
        backendA("client-1:user-1", work),
        backendB("client-1:user-1", work),
      ]);
      expect(peak).toBe(1);
    } finally {
      await a.end();
      await b.end();
      await clone.drop();
    }
  }, 30_000);

  it("releases on both exit paths, so the next caller proceeds", async () => {
    const clone = await cloneTemplate();
    const a = client(clone.url);
    try {
      const backend = createPgConsentLockBackend(a);
      await expect(
        backend("client-2:user-2", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      // A stranded lock would block this acquire forever; the test
      // timeout is the failure detector.
      await backend("client-2:user-2", () => Promise.resolve());
    } finally {
      await a.end();
      await clone.drop();
    }
  }, 30_000);

  it("does not exclude different keys", async () => {
    const clone = await cloneTemplate();
    const a = client(clone.url);
    const b = client(clone.url);
    try {
      const backendA = createPgConsentLockBackend(a);
      const backendB = createPgConsentLockBackend(b);
      // A barrier, not a sleep: each holder waits until BOTH have
      // arrived inside their critical sections, so genuine overlap is
      // observed rather than assumed from timing. If the keys wrongly
      // excluded each other, the first holder would wait forever for an
      // arrival that cannot happen and the test timeout is the detector.
      let arrivals = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const work = async (): Promise<void> => {
        arrivals += 1;
        if (arrivals === 2) releaseBarrier();
        await barrier;
      };
      await Promise.all([
        backendA("client-3:user-3", work),
        backendB("client-4:user-4", work),
      ]);
      expect(arrivals).toBe(2);
    } finally {
      await a.end();
      await b.end();
      await clone.drop();
    }
  }, 30_000);

  it("answers a clean capacity refusal when every slot is held", async () => {
    const clone = await cloneTemplate();
    const a = client(clone.url, 1);
    try {
      const backend = createPgConsentLockBackend(a, {
        reserveTimeoutMs: 300,
      });
      let releaseHolder!: () => void;
      const holding = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      // Object wrapper so control-flow analysis doesn't narrow a flag
      // that flips inside an async closure.
      const state = { held: false };
      const holder = backend("client-5:user-5", async () => {
        state.held = true;
        await holding;
      });
      const deadline = Date.now() + 5_000;
      while (!state.held && Date.now() < deadline) await sleep(25);
      expect(state.held).toBe(true);

      // A different key, but the single-slot client is occupied: the
      // reservation times out and surfaces as a retryable refusal
      // instead of queueing forever.
      await expect(
        backend("client-6:user-6", () => Promise.resolve()),
      ).rejects.toThrow(/permission changes/i);

      releaseHolder();
      await holder;
    } finally {
      await a.end();
      await clone.drop();
    }
  }, 30_000);
});
