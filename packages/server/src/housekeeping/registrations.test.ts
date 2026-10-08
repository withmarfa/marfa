/**
 * The set of housekeeping jobs is a function of the configuration, and
 * each gate is asserted from both sides: the housekeeping job is there under
 * the setting that admits it, and gone under the one that switches it off.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { DiskBlobStore, type BlobStore } from "../storage/blob-store.js";
import type { Storage } from "../storage/interface.js";
import {
  createUnclaimedTestApp,
  type UnclaimedTestApp,
} from "../test-utils.js";
import { registerHousekeepingJobs } from "./registrations.js";
import { DEFAULT_RUN_DEADLINE_MS, Housekeeping } from "./scheduler.js";

const contexts: UnclaimedTestApp[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

/** The names registered under `overrides`, on a scheduler of their own,
 *  and each row's interval once the scheduler has written the table. */
async function namesUnder(
  overrides: Partial<AppConfig>,
  storageOf: (storage: Storage) => Storage = (storage) => storage,
): Promise<{ names: string[]; intervalOf: (name: string) => number }> {
  const ctx = await createUnclaimedTestApp(overrides);
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
  "webhook-schedule",
  "webhook-poll",
  "version-thinning",
  "trash-purge",
  "revoked-key-reap",
  "rate-limit-cleanup",
  "inbound-delivery-cleanup",
  "blob-replicate",
  "blob-integrity",
];

describe("the housekeeping registrations", () => {
  it("registers every housekeeping job the defaults admit, the heartbeat only with a receiver", async () => {
    const { names } = await namesUnder({});
    expect(names).toEqual([
      "event-log-cleanup",
      "audit-cleanup",
      "webhook-schedule",
      "webhook-poll",
      "version-thinning",
      "trash-purge",
      "revoked-grant-purge",
      "grant-inactivity-retirement",
      "revoked-key-reap",
      "auth-session-cleanup",
      "rate-limit-cleanup",
      "inbound-delivery-cleanup",
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

  it("runs replication and the integrity check on their configured cadences", async () => {
    const { intervalOf } = await namesUnder({
      blobReplicateIntervalMs: 120_000,
      blobIntegrityIntervalMs: 240_000,
    });
    expect(intervalOf("blob-replicate")).toBe(120_000);
    expect(intervalOf("blob-integrity")).toBe(240_000);
    const { intervalOf: defaults } = await namesUnder({});
    expect(defaults("blob-replicate")).toBe(60_000);
    expect(defaults("blob-integrity")).toBe(3_600_000);
  });

  it("holds the quick jobs to a short deadline, the byte-bound ones to a long one, and the rest to the default", async () => {
    const ctx = await createUnclaimedTestApp({
      heartbeatUrl: "https://example.test/ping",
    });
    contexts.push(ctx);
    const housekeeping = new Housekeeping(ctx.storage.housekeeping, {
      pollIntervalMs: 3_600_000,
    });
    registerHousekeepingJobs(housekeeping, ctx.storage, ctx.blobs, ctx.config);
    expect(
      Object.fromEntries(
        [
          "heartbeat",
          "webhook-schedule",
          "webhook-poll",
          "version-thinning",
          "blob-replicate",
          "blob-integrity",
          "trash-purge",
        ].map((name) => [name, housekeeping.deadlineMs(name)]),
      ),
    ).toEqual({
      heartbeat: 30_000,
      "webhook-schedule": 60_000,
      "webhook-poll": 120_000,
      "version-thinning": 21_600_000,
      "blob-replicate": 21_600_000,
      "blob-integrity": 21_600_000,
      "trash-purge": DEFAULT_RUN_DEADLINE_MS,
    });
  });

  it("runs the revoked-grant purge and the revoked-key reap hourly", async () => {
    const { intervalOf } = await namesUnder({});
    expect(intervalOf("revoked-grant-purge")).toBe(3_600_000);
    expect(intervalOf("revoked-key-reap")).toBe(3_600_000);
  });
});

describe("the copy rules' wakes", () => {
  const T0 = Date.parse("2026-09-20T12:00:00.000Z");

  /** The app's layer with a second disk store beside its disk, attached
   *  the way the layer attaches one, so the registrations copy between
   *  them. */
  async function twoStores(ctx: UnclaimedTestApp): Promise<BlobStore> {
    const second = new DiskBlobStore(join(ctx.tmpDir, "second-store"));
    await second.attach();
    await ctx.storage.blobs.attachStore({
      id: second.id,
      kind: second.kind,
      locator: second.locator,
    });
    const all = ctx.blobs.stores as BlobStore[];
    all.push(second);
    ctx.blobs.byId = (id) => all.find((store) => store.id === id);
    return second;
  }

  async function upload(ctx: UnclaimedTestApp, content: string) {
    const disk = ctx.blobs.disk;
    const hash = `sha256:${(await import("node:crypto"))
      .createHash("sha256")
      .update(content)
      .digest("hex")}`;
    const { Readable } = await import("node:stream");
    await disk.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.register(hash, "text/plain", content.length);
    await ctx.storage.blobs.recordLocation(hash, disk.id);
    return hash;
  }

  it("wakes replication again after a run that copied some of a backlog, and not after one that copied nothing", async () => {
    const ctx = await createUnclaimedTestApp({ blobReplicateBatch: 1 });
    contexts.push(ctx);
    const second = await twoStores(ctx);
    await upload(ctx, "backlog one");
    await upload(ctx, "backlog two");
    let now = T0;
    const housekeeping = new Housekeeping(ctx.storage.housekeeping, {
      pollIntervalMs: 3_600_000,
      nowFn: () => new Date(now),
    });
    registerHousekeepingJobs(housekeeping, ctx.storage, ctx.blobs, ctx.config);
    await housekeeping.start();
    const dueAt = async () =>
      (await ctx.storage.housekeeping.get("blob-replicate"))?.next_run_at;
    // Not due for its first-run delay.
    expect(await dueAt()).toBe(new Date(T0 + 15_000).toISOString());

    // One of two copied: due again now, not in a minute. A wake during a
    // run is recorded a millisecond after the run's start, so the finish
    // can tell it from the schedule.
    now = T0 + 20_000;
    const first = await housekeeping.runNow("blob-replicate");
    expect(first).toMatchObject({
      kind: "ran",
      run: { result: { copied: 1, remaining: 1 } },
    });
    expect(await dueAt()).toBe(new Date(now + 1).toISOString());

    // The rest copied: the next run is a cadence away.
    now = T0 + 21_000;
    expect(await housekeeping.runNow("blob-replicate")).toMatchObject({
      run: { result: { copied: 1, remaining: 0 } },
    });
    expect(await dueAt()).toBe(new Date(now + 60_000).toISOString());

    // A backlog nothing can be copied from: no wake, the cadence stands.
    const refused = await upload(ctx, "backlog three");
    const put = second.put.bind(second);
    second.put = () => Promise.reject(new Error("no room"));
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      now = T0 + 22_000;
      expect(await housekeeping.runNow("blob-replicate")).toMatchObject({
        run: { result: { copied: 0, remaining: 1 } },
      });
    } finally {
      process.stdout.write = write;
      second.put = put;
    }
    // A run ahead of schedule leaves the schedule where it was: the
    // cadence set by the run before, not a wake.
    expect(await dueAt()).toBe(new Date(T0 + 21_000 + 60_000).toISOString());
    expect(await second.has(refused)).toBeNull();
    await housekeeping.stop();
  });

  it("wakes replication after the integrity check strikes a copy", async () => {
    const ctx = await createUnclaimedTestApp();
    contexts.push(ctx);
    await twoStores(ctx);
    const hash = await upload(ctx, "struck, then put back");
    let now = T0;
    const housekeeping = new Housekeeping(ctx.storage.housekeeping, {
      pollIntervalMs: 3_600_000,
      nowFn: () => new Date(now),
    });
    registerHousekeepingJobs(housekeeping, ctx.storage, ctx.blobs, ctx.config);
    await housekeeping.start();
    now = T0 + 20_000;
    expect(await housekeeping.runNow("blob-replicate")).toMatchObject({
      run: { result: { copied: 1, remaining: 0 } },
    });
    const dueAt = async () =>
      (await ctx.storage.housekeeping.get("blob-replicate"))?.next_run_at;
    expect(await dueAt()).toBe(new Date(now + 60_000).toISOString());

    // A sound check wakes nothing.
    now = T0 + 30_000;
    expect(await housekeeping.runNow("blob-integrity")).toMatchObject({
      run: { result: { verified: 2, struck: 0 } },
    });
    expect(await dueAt()).toBe(new Date(T0 + 20_000 + 60_000).toISOString());

    // A strike wakes replication.
    const hex = hash.slice("sha256:".length);
    writeFileSync(
      join(ctx.blobs.disk.locator, hex.slice(0, 4), hex),
      "struck, THEN put back",
    );
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      now = T0 + 40_000;
      expect(await housekeeping.runNow("blob-integrity")).toMatchObject({
        run: { result: { verified: 1, struck: 1 } },
      });
    } finally {
      process.stdout.write = write;
    }
    // Woken from another run, so due at the wake's own instant.
    expect(await dueAt()).toBe(new Date(now).toISOString());
    await housekeeping.stop();
  });
});
