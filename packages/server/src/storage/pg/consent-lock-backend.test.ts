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

function client(url: string): PgClient {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return postgres(url, { max: 2, onnotice: () => {} });
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
      let inFlight = 0;
      let peak = 0;
      const work = async (): Promise<void> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(300);
        inFlight -= 1;
      };
      await Promise.all([
        backendA("client-3:user-3", work),
        backendB("client-4:user-4", work),
      ]);
      expect(peak).toBe(2);
    } finally {
      await a.end();
      await b.end();
      await clone.drop();
    }
  }, 30_000);
});
