import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { archiveManifest } from "../../utils/archive.js";
import {
  afterFirstScheduledBackup,
  bucketAt,
  ownerOf,
} from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  blobFolder,
  clientsFor,
  ownObjectStore,
} from "../../utils/own-blob-server.js";

/**
 * A backup that cannot finish: an object store the server cannot reach, a
 * process killed while the store takes the backup, two asks at once, and a
 * store that takes a backup slowly. `hold:backup:put` stops a backup once the
 * put has some of its bytes in hand: more than one part of a large backup, so
 * its multipart upload has begun, or all of a small one. Each server has a
 * prefix of its own. The backup interval is a year, so `backup` is listed,
 * and once the first scheduled run has ended no other comes during a test.
 */
const YEAR_SECONDS = "31536000";
const UNREACHABLE = "http://127.0.0.1:9";
const PART_BYTES = 8 * 1024 * 1024;

async function health(server: FreshServer) {
  const answer = await clientsFor(server).operator.rawRequest<{
    status: string;
    backups: {
      status: string;
      destination?: string;
      failures?: number;
      last_error?: string | null;
      last_backup?: string | null;
    };
  }>("/health");
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  return answer.data;
}

describe("a backup the object store does not take", () => {
  const store = ownObjectStore();
  const bucket = bucketAt(store.S3_PREFIX);
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("backup-unreachable", {
      ...store,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
    });
    await afterFirstScheduledBackup(server);
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put", async () => {
    const before = await bucket.backupKeys();
    const created = await clientsFor(server).working.createItem({
      type: "core.note",
      properties: { title: "waiting for a backup" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    expect((await health(server)).backups.status).toBe("ok");

    await server.restart({ env: { S3_ENDPOINT: UNREACHABLE } });
    const refused = await ownerOf(server).runBackup();
    expect(refused.status, JSON.stringify(refused.data)).toBe(503);
    expect(refused.error?.error.code).toBe("blob_store_unavailable");
    let seen = await health(server);
    expect(seen.backups.status).toBe("failing");
    expect(seen.backups.destination).toBe("bucket");
    expect(seen.backups.failures).toBe(1);
    expect(seen.backups.last_error).toEqual(expect.any(String));
    expect(seen.status).toBe("degraded");
    const anonymous = await new MarfaClient({
      baseUrl: server.apiUrl,
    }).rawRequest<{ backups: Record<string, unknown> }>("/health");
    expect(anonymous.data.backups).toEqual({ status: "failing" });

    const scheduled =
      await clientsFor(server).operator.runHousekeeping("backup");
    expect(scheduled.status, JSON.stringify(scheduled.error)).toBe(200);
    expect(scheduled.data.outcome).toBe("error");
    seen = await health(server);
    expect(seen.backups.failures).toBe(2);
    expect(await bucket.backupKeys()).toEqual(before);

    await server.restart();
    const next = await clientsFor(server).operator.runHousekeeping("backup");
    expect(next.status, JSON.stringify(next.error)).toBe(200);
    expect(next.data.outcome, next.data.error ?? "").toBe("ok");
    expect((next.data.result as { outcome: string }).outcome).toBe("put");
    seen = await health(server);
    expect(seen.backups.status).toBe("ok");
    expect(seen.backups.failures).toBe(0);
    expect(seen.status).toBe("ok");
    expect(await bucket.backupKeys()).toHaveLength(before.length + 1);
  });

  it("runs the next scheduled backup after a failed one when nothing has changed since the last backup put", async () => {
    const before = await bucket.backupKeys();
    await server.restart({ env: { S3_ENDPOINT: UNREACHABLE } });
    const refused = await ownerOf(server).runBackup();
    expect(refused.status, JSON.stringify(refused.data)).toBe(503);
    expect((await health(server)).backups.status).toBe("failing");

    await server.restart();
    const next = await clientsFor(server).operator.runHousekeeping("backup");
    expect(next.status, JSON.stringify(next.error)).toBe(200);
    expect(next.data.outcome, next.data.error ?? "").toBe("ok");
    expect((next.data.result as { outcome: string }).outcome).toBe("put");
    const seen = await health(server);
    expect(seen.backups.status).toBe("ok");
    expect(seen.backups.failures).toBe(0);
    expect(await bucket.backupKeys()).toHaveLength(before.length + 1);
  });
});

describe("a backup cut short", () => {
  const store = ownObjectStore();
  const bucket = bucketAt(store.S3_PREFIX);
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("backup-cut-short", {
      ...store,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
      MARFA_TEST_TUNING: "blob_read_idle_ms=1000",
    });
    await afterFirstScheduledBackup(server);
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("runs one backup at a time, answering a second ask with 409 housekeeping_job_running", async () => {
    const owner = ownerOf(server);
    const before = await bucket.backupKeys();
    await server.setFault("hold:backup:put");
    const first = owner.runBackup();
    await server.waitForHold("hold:backup:put");
    const second = await owner.runBackup();
    expect(second.status, JSON.stringify(second.data)).toBe(409);
    expect(second.error?.error.code).toBe("housekeeping_job_running");
    const scheduled =
      await clientsFor(server).operator.runHousekeeping("backup");
    expect(scheduled.status, JSON.stringify(scheduled.error)).toBe(200);
    expect(scheduled.data.result).toEqual({ outcome: "running" });
    await server.clearFault();
    const done = await first;
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    const { instance_id, name } = done.data.backup;
    expect(await bucket.backupKeys()).toEqual(
      [...before, `${store.S3_PREFIX}/backups/${instance_id}/${name}`].sort(),
    );
  });

  it("leaves no object and no spool when killed while putting a backup larger than one part", async () => {
    const { working } = clientsFor(server);
    // Text that does not compress, so the archive takes more than two parts.
    for (let at = 0; at < 40; at++) {
      const body = randomBytes(540 * 1024).toString("base64");
      const created = await working.createItem({
        type: "core.note",
        properties: { title: `large ${String(at)}`, body },
      });
      expect(created.status, JSON.stringify(created.error)).toBe(201);
    }
    const before = await bucket.backupKeys();
    const owner = ownerOf(server);

    await server.setFault("hold:backup:put");
    void owner.runBackup();
    await server.waitForHold("hold:backup:put");
    expect(await bucket.unfinishedUploads()).toHaveLength(1);
    await server.restart({ signal: "SIGKILL" });

    expect(await bucket.backupKeys()).toEqual(before);
    expect(readdirSync(join(blobFolder(server), "tmp"))).toEqual([]);

    // The witness: the same backup, let through, is put whole.
    await server.setFault("hold:backup:put");
    const let_through = ownerOf(server).runBackup();
    await server.waitForHold("hold:backup:put");
    await server.clearFault();
    const done = await let_through;
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    expect(done.data.backup.size_bytes).toBeGreaterThan(2 * PART_BYTES);
    const keys = await bucket.backupKeys();
    expect(keys).toHaveLength(before.length + 1);
    expect(keys).toContain(
      `${store.S3_PREFIX}/backups/${done.data.backup.instance_id}/${done.data.backup.name}`,
    );
  });

  it("puts a backup whole when the object store takes it more slowly than a client download may stall", async () => {
    const owner = ownerOf(server);
    // The archive is the previous test's, more than two parts.
    const changed = await owner.patchConfig({
      mcp_fetch_max_bytes: 40_000_000,
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    const before = await bucket.backupKeys();
    const uploads = await bucket.unfinishedUploads();

    await server.setFault("hold:backup:put");
    const slow = owner.runBackup();
    await server.waitForHold("hold:backup:put");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await server.clearFault();
    const done = await slow;
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    expect(done.data.backup.size_bytes).toBeGreaterThan(2 * PART_BYTES);
    expect(await bucket.backupKeys()).toHaveLength(before.length + 1);
    expect(await bucket.unfinishedUploads()).toEqual(uploads);
  });
});

describe("a file no store can give, in a backup to the object store", () => {
  it("puts the backup, names the file in lost_blobs and in health, and clears health with the next backup that loses none", async () => {
    const store = ownObjectStore();
    const bucket = bucketAt(store.S3_PREFIX);
    const server = await bootFreshServer("backup-lost-file", {
      ...store,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
    });
    try {
      await afterFirstScheduledBackup(server);
      await server.setFault("hold:housekeeping:blob-replicate");
      const { working } = clientsFor(server);
      const uploaded = await working.uploadBlob(
        new TextEncoder().encode(
          `a file whose copy went ${randomBytes(8).toString("hex")}`,
        ),
        "text/plain",
      );
      expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
      const lost = uploaded.data.hash;
      const file = await working.createItem({
        type: "core.file",
        properties: { blob_ref: lost, mime_type: "text/plain" },
      });
      expect(file.status, JSON.stringify(file.error)).toBe(201);
      await server.setFault(`lose:blob=${lost}`);
      const owner = ownerOf(server);
      const run = await owner.runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect(run.data.blobs_lost).toEqual([lost]);
      const key = `${store.S3_PREFIX}/backups/${run.data.backup.instance_id}/${run.data.backup.name}`;
      const manifest = archiveManifest<{ lost_blobs: string[] }>(
        await bucket.get(key),
      );
      expect(manifest.lost_blobs).toEqual([lost]);
      const seen = await health(server);
      expect(seen.backups.status).toBe("failing");
      expect(seen.backups.last_error).toContain(lost);

      await server.clearFault();
      const next = await owner.runBackup();
      expect(next.status, JSON.stringify(next.error)).toBe(200);
      expect(next.data.blobs_lost).toEqual([]);
      expect((await health(server)).backups.status).toBe("ok");
    } finally {
      await server.stop();
    }
  });
});
