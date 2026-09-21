/**
 * The set of housekeeping jobs is a function of the configuration, and
 * each gate is asserted from both sides: the job is there under the
 * setting that admits it, and gone under the one that switches it off.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import type { Storage } from "../storage/interface.js";
import {
  createUnbootstrappedTestApp,
  type UnbootstrappedTestApp,
} from "../test-utils.js";
import { Housekeeping } from "./scheduler.js";
import { registerHousekeepingJobs } from "./registrations.js";

const contexts: UnbootstrappedTestApp[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

/** The names registered under `overrides`, on a scheduler of their own,
 *  and each row's interval once the scheduler has written the table. */
async function namesUnder(
  overrides: Partial<AppConfig>,
  storageOf: (storage: Storage) => Storage = (storage) => storage,
): Promise<{ names: string[]; intervalOf: (name: string) => number }> {
  const ctx = await createUnbootstrappedTestApp(overrides);
  contexts.push(ctx);
  const housekeeping = new Housekeeping(ctx.storage.housekeeping, {
    pollIntervalMs: 3_600_000,
  });
  registerHousekeepingJobs(
    housekeeping,
    storageOf(ctx.storage),
    ctx.blobs,
    ctx.config,
  );
  await housekeeping.start();
  const rows = await housekeeping.list();
  await housekeeping.stop();
  return {
    names: housekeeping.names(),
    intervalOf: (name) => {
      const row = rows.find((candidate) => candidate.name === name);
      if (!row) throw new Error(`${name} has no row`);
      return row.interval_ms;
    },
  };
}

const ALWAYS = [
  "event-log-cleanup",
  "audit-cleanup",
  "webhook-poll",
  "version-thinning",
  "trash-purge",
  "revoked-key-reap",
  "rate-limit-cleanup",
  "blob-replicate",
  "blob-integrity",
];

describe("the housekeeping registrations", () => {
  it("registers every job the defaults admit, the heartbeat only with a receiver", async () => {
    const { names } = await namesUnder({});
    expect(names).toEqual([
      "event-log-cleanup",
      "audit-cleanup",
      "webhook-poll",
      "version-thinning",
      "trash-purge",
      "activity-purge",
      "revoked-grant-purge",
      "grant-inactivity-retirement",
      "revoked-key-reap",
      "auth-session-cleanup",
      "rate-limit-cleanup",
      "dcr-client-cleanup",
      "blob-replicate",
      "blob-integrity",
      "blob-orphans",
      "enrichment-sweep",
      "bulk-action-gc",
    ]);
    const { names: withReceiver } = await namesUnder({
      heartbeatUrl: "http://127.0.0.1:1/heartbeat",
    });
    expect(withReceiver).toContain("heartbeat");
    expect(withReceiver.filter((name) => name !== "heartbeat")).toEqual(names);
  });

  it.each<[string, Partial<AppConfig>, string[]]>([
    [
      "the activity purge interval",
      { activityPurgeIntervalMs: 0 },
      ["activity-purge", "revoked-grant-purge"],
    ],
    [
      "the revoked-grant retention",
      { revokedGrantRetentionDays: 0 },
      ["revoked-grant-purge"],
    ],
    [
      "the grant inactivity window",
      { grantInactivityDays: 0 },
      ["grant-inactivity-retirement"],
    ],
    [
      "the DCR client retention",
      { dcrClientRetentionDays: 0 },
      ["dcr-client-cleanup"],
    ],
    [
      "the blob cleanup interval",
      { blobCleanupIntervalMs: 0 },
      ["blob-orphans"],
    ],
    ["the enrichment flag", { enrichmentEnabled: false }, ["enrichment-sweep"]],
    [
      "the bulk-action job retention",
      { bulkActionJobRetentionMs: 0 },
      ["bulk-action-gc"],
    ],
  ])(
    "leaves out what %s switches off, and nothing else",
    async (_what, overrides, absent) => {
      const { names: admitted } = await namesUnder({});
      for (const name of absent) expect(admitted).toContain(name);
      const { names } = await namesUnder(overrides);
      for (const name of absent) expect(names).not.toContain(name);
      expect(names).toEqual(admitted.filter((name) => !absent.includes(name)));
      for (const name of ALWAYS) expect(names).toContain(name);
    },
  );

  it("leaves out the session cleanup and the DCR reaper when their stores are not wired", async () => {
    const { names: admitted } = await namesUnder({});
    expect(admitted).toContain("auth-session-cleanup");
    expect(admitted).toContain("dcr-client-cleanup");
    const { names } = await namesUnder({}, (storage) => ({
      ...storage,
      authSessions: undefined,
      oauthProvider: undefined,
    }));
    expect(names).not.toContain("auth-session-cleanup");
    expect(names).not.toContain("dcr-client-cleanup");
    expect(names).toEqual(
      admitted.filter(
        (name) =>
          name !== "auth-session-cleanup" && name !== "dcr-client-cleanup",
      ),
    );
  });

  it("runs the revoked-key reap on the activity purge's cadence, hourly when that purge is off", async () => {
    const { intervalOf } = await namesUnder({
      activityPurgeIntervalMs: 120_000,
    });
    expect(intervalOf("revoked-key-reap")).toBe(120_000);
    const { intervalOf: off } = await namesUnder({
      activityPurgeIntervalMs: 0,
    });
    expect(off("revoked-key-reap")).toBe(3_600_000);
  });
});
