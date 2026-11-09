import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  archiveLines,
  archiveManifest,
  listEntries,
} from "../../utils/archive.js";
import { bucketAt, ownerOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  DISK_ONLY,
  ownObjectStore,
  runJob,
} from "../../utils/own-blob-server.js";
import { TEST_OWNER } from "../../utils/target.js";
import { waitFor } from "../../utils/wait.js";

/**
 * Backups to the object store a server is given: one archive object per
 * backup under `<S3_PREFIX>/backups/`, with no file bytes, taken on a
 * schedule or when the owner asks, listed and restored by the owner alone.
 * Each server here has a prefix of its own, so its bucket holds only what it
 * wrote; the restore boots a second server on the first one's prefix.
 */
const YEAR_MS = "31536000000";
const AUTH_SECRET = `backups-${"s".repeat(40)}-${String(Date.now())}`;
const store = ownObjectStore();
const bucket = bucketAt(store.S3_PREFIX);
let origin: FreshServer;
let fresh: FreshServer | undefined;

beforeAll(async () => {
  origin = await bootFreshServer("backups-origin", {
    ...store,
    MARFA_BACKUP_INTERVAL_MS: "0",
    MARFA_AUTH_SECRET: AUTH_SECRET,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await fresh?.stop();
  await origin?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function health(server: FreshServer, client?: MarfaClient) {
  const answer = await (
    client ?? new MarfaClient({ baseUrl: server.apiUrl })
  ).rawRequest<Record<string, unknown>>("/health");
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  return answer.data as {
    status: string;
    backups: Record<string, unknown>;
  };
}

/** A note, a note in the trash, and a file whose bytes the bucket holds. */
async function contents(server: FreshServer) {
  const { operator, working } = clientsFor(server);
  const note = await working.createItem({
    type: "core.note",
    properties: { title: "kept in a backup", body: "kept" },
  });
  expect(note.status, JSON.stringify(note.error)).toBe(201);
  const trashed = await working.createItem({
    type: "core.note",
    properties: { title: "in the trash" },
  });
  expect(trashed.status, JSON.stringify(trashed.error)).toBe(201);
  expect((await working.deleteItem(trashed.data.item.id)).status).toBe(200);
  const bytes = bytesOf("a file in the bucket", 4096);
  const uploaded = await working.uploadBlob(bytes, "text/plain");
  expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
  const file = await working.createItem({
    type: "core.file",
    properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
  });
  expect(file.status, JSON.stringify(file.error)).toBe(201);
  for (let run = 0; run < 20; run++) {
    const { result } = await runJob<{ remaining: number }>(
      operator,
      "blob-replicate",
    );
    if (result.remaining === 0) break;
  }
  return {
    note: note.data.item.id,
    trashed: trashed.data.item.id,
    file: file.data.item.id,
    hash: uploaded.data.hash,
    bytes,
  };
}

let made: Awaited<ReturnType<typeof contents>>;
let firstName: string;

function sortedById<
  T extends { item?: { id: string }; edge?: { id: string } },
>(lines: T[]): T[] {
  const key = (line: T) =>
    line.item?.id ?? line.edge?.id ?? JSON.stringify(line);
  return [...lines].sort((a, b) => key(a).localeCompare(key(b)));
}

describe("a backup in the object store", () => {
  it("puts one object under the prefix's backups folder, named for its created_at, holding what an owner's archive export with state any and files false holds", async () => {
    made = await contents(origin);
    const owner = ownerOf(origin);
    const run = await owner.runBackup();
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    expect(run.data.outcome).toBe("put");
    const { name, created_at, size_bytes } = run.data.backup;
    expect(name).toBe(`${created_at}.tar`);
    firstName = name;

    expect(await bucket.backupKeys()).toEqual([
      `${store.S3_PREFIX}/backups/${name}`,
    ]);
    const backup = await bucket.get(`${store.S3_PREFIX}/backups/${name}`);
    expect(backup.length).toBe(size_bytes);
    const manifest = archiveManifest<{
      created_at: string;
      blobs: Record<string, unknown>;
      missing_blobs: Record<string, unknown>;
      bucket_blobs: string[];
      item_count: number;
    }>(backup);
    expect(manifest.created_at).toBe(created_at);
    expect(listEntries(backup).map((entry) => entry.name)).toEqual([
      "manifest.json",
      "instance.ndjson.gz",
      "items.ndjson.gz",
      "edges.ndjson.gz",
    ]);
    expect(manifest.blobs).toEqual({});
    expect(Object.keys(manifest.missing_blobs)).toContain(made.hash);
    expect(manifest.bucket_blobs).toContain(made.hash);
    for (const hash of manifest.bucket_blobs) {
      expect(Object.keys(manifest.missing_blobs)).toContain(hash);
    }

    const exported = await owner.exportArchive({
      state: "any",
      files: "false",
    });
    expect(exported.status).toBe(200);
    const asExported = archiveManifest<{ item_count: number }>(exported.data);
    expect(manifest.item_count).toBe(asExported.item_count);
    for (const file of ["instance", "items", "edges"] as const) {
      expect(sortedById(archiveLines(backup, file))).toEqual(
        sortedById(archiveLines(exported.data, file)),
      );
    }
    const ids = archiveLines<{ item: { id: string } }>(backup, "items").map(
      (line) => line.item.id,
    );
    expect(ids).toEqual(
      expect.arrayContaining([made.note, made.trashed, made.file]),
    );
  });

  it("holds no key, token, password, secret or object store credential", async () => {
    const { operator, working } = clientsFor(origin);
    // The witness: each credential is live, so a backup could have held it.
    expect((await working.getItem(made.note)).status).toBe(200);
    expect((await operator.listHousekeeping()).status).toBe(200);
    const backup = await bucket.get(`${store.S3_PREFIX}/backups/${firstName}`);
    const text = listEntries(backup)
      .map((entry) =>
        entry.name.endsWith(".gz")
          ? gunzipSync(entry.body).toString("utf8")
          : entry.body.toString("utf8"),
      )
      .join("\n");
    const secrets: string[] = [
      origin.workingKey,
      origin.managementKey,
      TEST_OWNER.password,
      AUTH_SECRET,
      process.env.S3_ACCESS_KEY_ID!,
      process.env.S3_SECRET_ACCESS_KEY!,
    ];
    // What `marfa.secrets` holds, where the environment did not give it.
    const secretsFile = join(dirname(origin.sqlitePath), "marfa.secrets");
    if (existsSync(secretsFile)) {
      for (const line of readFileSync(secretsFile, "utf8").split("\n")) {
        const value = line.split("=").slice(1).join("=").trim();
        if (value.length >= 16) secrets.push(value);
      }
    }
    for (const secret of secrets) {
      expect(text.includes(secret), "a backup holds a secret").toBe(false);
    }
  });

  it("lists the backups newest first to the owner, and refuses a key at all three doors", async () => {
    const owner = ownerOf(origin);
    const second = await owner.runBackup();
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    const listed = await owner.listBackups();
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.next_cursor).toBeNull();
    expect(listed.data.data.map((backup) => backup.name)).toEqual([
      second.data.backup.name,
      firstName,
    ]);
    expect(listed.data.data[0]).toEqual(second.data.backup);

    const { operator } = clientsFor(origin);
    for (const answer of [
      await operator.listBackups(),
      await operator.runBackup(),
      await operator.restoreBackup(firstName),
    ]) {
      expect(answer.status, JSON.stringify(answer.data)).toBe(403);
      expect(answer.error?.error.code).toBe("forbidden");
    }
    expect((await bucket.backupKeys()).length).toBe(2);
  });

  it("restores a named backup into a fresh server on the same bucket, files included", async () => {
    fresh = await bootFreshServer("backups-fresh", {
      ...store,
      MARFA_BACKUP_INTERVAL_MS: "0",
    });
    const { operator, working } = clientsFor(fresh);
    expect((await working.getItem(made.note)).status).toBe(404);
    const restored = await ownerOf(fresh).restoreBackup(firstName);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.backup).toBe(firstName);
    expect(restored.data.blobs_missing).toEqual([]);
    expect(typeof restored.data.set_up_again).toBe("string");
    expect((await working.getItem(made.note)).status).toBe(200);
    const read = await operator.downloadBlob(made.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(made.bytes);
  });

  it("answers 404 backup_not_found for a name the object store does not hold, or one that is not a backup's", async () => {
    await bucket.put(`${store.S3_PREFIX}/backups/notes.tar`, "not a backup");
    const owner = ownerOf(origin);
    for (const name of ["2020-01-01T00:00:00.000Z.tar", "notes.tar"]) {
      const answer = await owner.restoreBackup(name);
      expect(answer.status, JSON.stringify(answer.data)).toBe(404);
      expect(answer.error?.error.code).toBe("backup_not_found");
    }
    const listed = await owner.listBackups();
    expect(listed.data.data.map((backup) => backup.name)).not.toContain(
      "notes.tar",
    );
  });
});

describe("the backup schedule", () => {
  it("skips a scheduled run when nothing changed, counts a settings change as a change, and puts one when asked", async () => {
    const own = ownObjectStore();
    const mine = bucketAt(own.S3_PREFIX);
    const server = await bootFreshServer("backups-unchanged", {
      ...own,
      MARFA_BACKUP_INTERVAL_MS: YEAR_MS,
    });
    try {
      const { operator } = clientsFor(server);
      const owner = ownerOf(server);
      const first = await runJob<{ outcome: string }>(operator, "backup");
      expect(first.result.outcome).toBe("put");
      expect((await mine.backupKeys()).length).toBe(1);

      const again = await runJob<{ outcome: string }>(operator, "backup");
      expect(again.result.outcome).toBe("unchanged");
      expect((await mine.backupKeys()).length).toBe(1);

      const changed = await owner.patchConfig({
        blob_read_idle_timeout_ms: 45_000,
      });
      expect(changed.status, JSON.stringify(changed.error)).toBe(200);
      const after = await runJob<{ outcome: string }>(operator, "backup");
      expect(after.result.outcome).toBe("put");
      expect((await mine.backupKeys()).length).toBe(2);

      const asked = await owner.runBackup();
      expect(asked.status, JSON.stringify(asked.error)).toBe(200);
      expect(asked.data.outcome).toBe("put");
      expect((await mine.backupKeys()).length).toBe(3);
    } finally {
      await server.stop();
    }
  });

  it("backs up on its interval with no request", async () => {
    const own = ownObjectStore();
    const mine = bucketAt(own.S3_PREFIX);
    const server = await bootFreshServer("backups-interval", {
      ...own,
      MARFA_BACKUP_INTERVAL_MS: "1000",
    });
    try {
      const keys = await waitFor("a scheduled backup", async () => {
        const found = await mine.backupKeys();
        return found.length > 0 ? found : undefined;
      });
      expect(keys[0]).toMatch(/\/backups\/\d{4}-\d\d-\d\dT[\d:.]+Z\.tar$/);
      const answer = await health(server, clientsFor(server).operator);
      expect(answer.backups.status).toBe("ok");
      expect(answer.backups.last_backup).toBe(keys[0]!.split("/").pop());
    } finally {
      await server.stop();
    }
  });

  it("takes no scheduled backup while backup_interval_ms is 0, and leaves backup out of the housekeeping listing", async () => {
    const own = ownObjectStore();
    const mine = bucketAt(own.S3_PREFIX);
    const server = await bootFreshServer("backups-off", {
      ...own,
      MARFA_BACKUP_INTERVAL_MS: "0",
    });
    try {
      const { operator } = clientsFor(server);
      const jobs = await operator.listHousekeeping();
      expect(jobs.status).toBe(200);
      const names = jobs.data.data.map((job) => job.name);
      expect(names).toContain("blob-replicate");
      expect(names).not.toContain("backup");
      const run = await operator.runHousekeeping("backup");
      expect(run.status).toBe(404);
      expect(run.error?.error.code).toBe("housekeeping_job_not_found");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(await mine.backupKeys()).toEqual([]);
      const answer = await health(server);
      expect(answer.backups).toEqual({ status: "off", reason: "turned_off" });
    } finally {
      await server.stop();
    }
  });

  it("says in health that backups are off on an instance with no object store, and answers 409 no_bucket at each door", async () => {
    const server = await bootFreshServer("backups-no-bucket", DISK_ONLY);
    try {
      const answer = await health(server);
      expect(answer.status).toBe("ok");
      expect(answer.backups).toEqual({ status: "off", reason: "no_bucket" });
      const owner = ownerOf(server);
      for (const refused of [
        await owner.listBackups(),
        await owner.runBackup(),
        await owner.restoreBackup("2026-11-09T10:15:30.250Z.tar"),
      ]) {
        expect(refused.status, JSON.stringify(refused.data)).toBe(409);
        expect(refused.error?.error.code).toBe("no_bucket");
      }
    } finally {
      await server.stop();
    }
  });
});
