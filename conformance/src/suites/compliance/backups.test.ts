import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  archiveLines,
  archiveManifest,
  listEntries,
} from "../../utils/archive.js";
import {
  afterFirstScheduledBackup,
  backupConcerns,
  backupName,
  bucketAt,
  instanceIdOf,
  ownerOf,
} from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  everythingClient,
  DISK_ONLY,
  ownObjectStore,
  replicateUntilCaughtUp,
  runJob,
} from "../../utils/own-blob-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { TEST_OWNER } from "../../utils/target.js";
import { waitFor } from "../../utils/wait.js";

/**
 * Backups to the object store a server is given: one archive object per
 * backup under `<S3_PREFIX>/backups/<instance id>/`, with no file bytes,
 * taken on a schedule or when the owner asks, listed and restored by the
 * owner alone. Each server here has a prefix of its own, so its bucket holds
 * only what it wrote; the restore boots a second server on the first one's
 * prefix.
 */
const OTHER_INSTANCE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const YEAR_SECONDS = "31536000";
const AUTH_SECRET = `backups-${"s".repeat(40)}-${String(Date.now())}`;
const store = ownObjectStore();
const bucket = bucketAt(store.S3_PREFIX);
let origin: FreshServer;
let originId: string;
let fresh: FreshServer | undefined;

beforeAll(async () => {
  origin = await bootFreshServer("backups-origin", {
    ...store,
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
    MARFA_AUTH_SECRET: AUTH_SECRET,
  });
  originId = await instanceIdOf(origin);
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

/** A type with a table, and an item of it holding `count` rows. */
async function ledger(working: MarfaClient, label: string, count: number) {
  const type = `user.backup_ledger_${label}`;
  const registered = await working.registerType({
    id: type,
    fields: { title: { type: "string" } },
    tables: { lines: { columns: { amount: { type: "number" } } } },
  } as never);
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  const item = await working.createItem({
    type,
    properties: { title: "a ledger" },
  } as never);
  expect(item.status, JSON.stringify(item.error)).toBe(201);
  const written = await working.writeRows(item.data.item.id, "lines", {
    operations: Array.from({ length: count }, (_, at) => ({
      op: "put" as const,
      values: { amount: at },
    })),
  });
  expect(written.status, JSON.stringify(written.error)).toBe(200);
  return item.data.item.id;
}

/** A note, a note in the trash, a file whose bytes the bucket holds, and an item with rows. */
async function contents(server: FreshServer) {
  const { operator, working } = clientsFor(server);
  const withRows = await ledger(working, "contents", 3);
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
    withRows,
  };
}

let made: Awaited<ReturnType<typeof contents>>;
let firstName: string;

function sortedById<T extends { item?: { id: string }; edge?: { id: string } }>(
  lines: T[],
): T[] {
  const key = (line: T) =>
    line.item?.id ?? line.edge?.id ?? JSON.stringify(line);
  return [...lines].sort((a, b) => key(a).localeCompare(key(b)));
}

describe("a backup in the object store", () => {
  it("puts one object in the prefix's backups folder for its instance, named for its created_at, holding what an archive export with state any and files false holds for a key that reaches everything", async () => {
    made = await contents(origin);
    const owner = ownerOf(origin);
    const run = await owner.runBackup();
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    await expectMatchesSchema("POST", "/backups", 200, run.data);
    expect(run.data.outcome).toBe("put");
    const { name, instance_id, created_at, size_bytes } = run.data.backup;
    expect(name).toBe(backupName(new Date(created_at)));
    expect(name).toMatch(/^\d{8}T\d{6}\.\d{3}Z\.tar$/);
    expect(instance_id).toBe(originId);
    firstName = name;

    expect(await bucket.backupKeys()).toEqual([
      `${store.S3_PREFIX}/backups/${originId}/${name}`,
    ]);
    const backup = await bucket.get(
      `${store.S3_PREFIX}/backups/${originId}/${name}`,
    );
    expect(backup.length).toBe(size_bytes);
    const manifest = archiveManifest<{
      created_at: string;
      blobs: Record<string, unknown>;
      missing_blobs: Record<string, unknown>;
      item_count: number;
    }>(backup);
    expect(manifest.created_at).toBe(created_at);
    expect(listEntries(backup).map((entry) => entry.name)).toEqual([
      "manifest.json",
      "instance.ndjson.gz",
      "items.ndjson.gz",
      "edges.ndjson.gz",
      "rows.ndjson.gz",
    ]);
    expect(manifest.blobs).toEqual({});
    expect(Object.keys(manifest.missing_blobs)).toContain(made.hash);

    const exported = await (
      await everythingClient(origin)
    ).exportArchive({
      state: "any",
      files: "false",
    });
    expect(exported.status).toBe(200);
    const asExported = archiveManifest<{ item_count: number }>(exported.data);
    expect(manifest.item_count).toBe(asExported.item_count);
    expect(
      archiveLines<{ item_id: string }>(backup, "rows").filter(
        (line) => line.item_id === made.withRows,
      ),
    ).toHaveLength(3);
    for (const file of ["instance", "items", "edges", "rows"] as const) {
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
    const backup = await bucket.get(
      `${store.S3_PREFIX}/backups/${originId}/${firstName}`,
    );
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
    // What a sign-in is found by: the digest the instance keeps of its token.
    const signIns = withInstanceDatabase(origin.sqlitePath, (db) =>
      db.prepare("SELECT token FROM sign_ins").all(),
    ).map((row) => String(row.token));
    expect(signIns.length, "the owner's sign-in is stored").toBeGreaterThan(0);
    secrets.push(...signIns);
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

  it("lists the backups newest first to the owner, and refuses a key at each door", async () => {
    const owner = ownerOf(origin);
    const second = await owner.runBackup();
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    const listed = await owner.listBackups();
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    await expectMatchesSchema("GET", "/backups", 200, listed.data);
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
      await operator.restoreBackup(originId, firstName),
      await operator.adoptBackupFolder(),
    ]) {
      expect(answer.status, JSON.stringify(answer.data)).toBe(403);
      expect(answer.error?.error.code).toBe("forbidden");
      expect(answer.error?.error.details).toEqual({ needs: "local" });
    }
    expect((await bucket.backupKeys()).length).toBe(2);
  });

  it("refuses to adopt a backup folder on an instance that backs up to an object store", async () => {
    const refused = await ownerOf(origin).adoptBackupFolder();
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
  });

  it("restores a named backup into a fresh server on the same bucket, files included", async () => {
    fresh = await bootFreshServer("backups-fresh", {
      ...store,
      MARFA_BACKUP_INTERVAL_SECONDS: "0",
    });
    expect(await instanceIdOf(fresh)).not.toBe(originId);
    const { operator, working } = clientsFor(fresh);
    expect((await working.getItem(made.note)).status).toBe(404);
    const listed = await ownerOf(fresh).listBackups();
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.data).toContainEqual(
      expect.objectContaining({ name: firstName, instance_id: originId }),
    );
    const restored = await ownerOf(fresh).restoreBackup(originId, firstName);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/backups/{instance_id}/{name}/restore",
      200,
      restored.data,
    );
    expect(restored.data.backup).toEqual({
      name: firstName,
      instance_id: originId,
    });
    expect(restored.data.blobs_missing).toEqual([]);
    expect(typeof restored.data.set_up_again).toBe("string");
    expect((await working.getItem(made.note)).status).toBe(200);
    const read = await operator.downloadBlob(made.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(made.bytes);
    const rows = await working.listRows(made.withRows, "lines", {});
    expect(rows.status, JSON.stringify(rows.error)).toBe(200);
    expect(rows.data.data.map((row) => row.values.amount).sort()).toEqual([
      0, 1, 2,
    ]);
  });

  it("answers 404 backup_not_found for a name the object store does not hold, or one that is not a backup's", async () => {
    await bucket.put(
      `${store.S3_PREFIX}/backups/${originId}/notes.tar`,
      "not a backup",
    );
    await bucket.put(
      `${store.S3_PREFIX}/backups/deeper/${firstName}`,
      "not a backup",
    );
    const owner = ownerOf(origin);
    for (const [instance, name] of [
      [originId, backupName(new Date("2020-01-01T00:00:00.000Z"))],
      [originId, "2020-01-01T00:00:00.000Z.tar"],
      [originId, "notes.tar"],
      [OTHER_INSTANCE, firstName],
      ["deeper", firstName],
    ] as const) {
      const answer = await owner.restoreBackup(instance, name);
      expect(answer.status, JSON.stringify(answer.data)).toBe(404);
      expect(answer.error?.error.code).toBe("backup_not_found");
    }
    const listed = await owner.listBackups();
    expect(listed.data.data.map((backup) => backup.name)).not.toContain(
      "notes.tar",
    );
  });
});

describe("a backup taken while replication is held", () => {
  it("calls the newest backup incomplete in its answer, health and attention while the object store lacks files it names, refuses a restore from it, and clears once replication copies them", async () => {
    const own = ownObjectStore();
    const server = await bootFreshServer("backups-incomplete", {
      ...own,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
    });
    let restorer: FreshServer | undefined;
    try {
      await afterFirstScheduledBackup(server);
      const { operator, working } = clientsFor(server);
      const id = await instanceIdOf(server);
      await server.setFault("hold:housekeeping:blob-replicate");
      const hashes: string[] = [];
      const items: string[] = [];
      for (const label of ["first", "second"]) {
        const bytes = bytesOf(`a file waiting for its copy, ${label}`, 4096);
        const uploaded = await working.uploadBlob(bytes, "text/plain");
        expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
        const file = await working.createItem({
          type: "core.file",
          properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
        });
        expect(file.status, JSON.stringify(file.error)).toBe(201);
        hashes.push(uploaded.data.hash);
        items.push(file.data.item.id);
      }

      const run = await ownerOf(server).runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      await expectMatchesSchema("POST", "/backups", 200, run.data);
      expect(run.data.blobs_lost).toEqual([]);
      expect(run.data.blobs_waiting).toBe(2);
      const name = run.data.backup.name;
      const waiting = await health(server, operator);
      expect(waiting.status).toBe("ok");
      expect(waiting.backups).toMatchObject({
        status: "incomplete",
        last_backup: name,
        last_backup_files_waiting: 2,
      });
      const told = await backupConcerns(server);
      expect(told.map((concern) => concern.reference)).toEqual(["incomplete"]);
      expect(told[0]!.description).toContain("2 files it names wait");

      restorer = await bootFreshServer("backups-incomplete-restore", {
        ...own,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      const refused = await ownerOf(restorer).restoreBackup(id, name);
      expect(refused.status, JSON.stringify(refused.data)).toBe(409);
      expect(refused.error?.error.code).toBe("backup_files_missing");
      expect(
        (refused.error?.error.details as { missing_blobs: string[] })
          .missing_blobs,
      ).toEqual([...hashes].sort());
      for (const item of items) {
        const absent = await clientsFor(restorer).working.getItem(item);
        expect(absent.status).toBe(404);
      }

      await server.clearFault();
      await replicateUntilCaughtUp(operator, "the files' copies in the bucket");
      const whole = await health(server, operator);
      expect(whole.backups).toMatchObject({
        status: "ok",
        last_backup: name,
        last_backup_files_waiting: 0,
      });
      expect(await backupConcerns(server)).toEqual([]);
      const restored = await ownerOf(restorer).restoreBackup(id, name);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.blobs_missing).toEqual([]);
      for (const item of items) {
        const present = await clientsFor(restorer).working.getItem(item);
        expect(present.status).toBe(200);
      }
      for (const hash of hashes) {
        const read = await clientsFor(restorer).operator.downloadBlob(hash);
        expect(read.status).toBe(200);
      }
    } finally {
      await restorer?.stop();
      await server.stop();
    }
  });

  it("calls the newest backup incomplete again once blob-integrity finds a copy of a file it names gone from the object store, until replication copies the file again", async () => {
    const own = ownObjectStore();
    const mine = bucketAt(own.S3_PREFIX);
    const server = await bootFreshServer("backups-integrity-struck", {
      ...own,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
    });
    try {
      await afterFirstScheduledBackup(server);
      const { operator, working } = clientsFor(server);
      const bytes = bytesOf("a file whose copy goes missing", 4096);
      const uploaded = await working.uploadBlob(bytes, "text/plain");
      expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
      const hash = uploaded.data.hash;
      const file = await working.createItem({
        type: "core.file",
        properties: { blob_ref: hash, mime_type: "text/plain" },
      });
      expect(file.status, JSON.stringify(file.error)).toBe(201);
      await replicateUntilCaughtUp(operator, "the file's copy in the bucket");

      const whole = await ownerOf(server).runBackup();
      expect(whole.status, JSON.stringify(whole.error)).toBe(200);
      expect(whole.data.blobs_waiting).toBe(0);
      const name = whole.data.backup.name;
      expect((await health(server, operator)).backups).toMatchObject({
        status: "ok",
        last_backup_files_waiting: 0,
      });

      const object = (await mine.keys()).find(
        (key) => !key.includes("/backups/") && key.includes(hash.slice(7)),
      );
      expect(object, "the file's object in the bucket").toBeTruthy();
      await server.setFault("hold:housekeeping:blob-replicate");
      await mine.delete(object!);
      const checked = await runJob<{ struck: number }>(
        operator,
        "blob-integrity",
      );
      expect(checked.result.struck).toBe(1);
      expect((await health(server, operator)).backups).toMatchObject({
        status: "incomplete",
        last_backup: name,
        last_backup_files_waiting: 1,
      });
      const told = await backupConcerns(server);
      expect(told.map((concern) => concern.reference)).toEqual(["incomplete"]);
      const next = await ownerOf(server).runBackup();
      expect(next.status, JSON.stringify(next.error)).toBe(200);
      expect(next.data.blobs_waiting).toBe(1);

      await server.clearFault();
      await replicateUntilCaughtUp(operator, "the file's copy again");
      const copied = (await mine.keys()).filter(
        (key) => !key.includes("/backups/") && key.includes(hash.slice(7)),
      );
      expect(copied).toHaveLength(1);
      expect((await health(server, operator)).backups).toMatchObject({
        status: "ok",
        last_backup: next.data.backup.name,
        last_backup_files_waiting: 0,
      });
      expect(await backupConcerns(server)).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

describe("the backup schedule", () => {
  it("skips a scheduled run when nothing changed, counts a settings change as a change, and puts one when asked", async () => {
    const own = ownObjectStore();
    const mine = bucketAt(own.S3_PREFIX);
    const server = await bootFreshServer("backups-unchanged", {
      ...own,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
    });
    try {
      const { operator } = clientsFor(server);
      const owner = ownerOf(server);
      await afterFirstScheduledBackup(server);
      expect((await mine.backupKeys()).length).toBe(1);

      const again = await runJob<{ outcome: string }>(operator, "backup");
      expect(again.result.outcome).toBe("unchanged");
      expect((await mine.backupKeys()).length).toBe(1);

      const changed = await owner.patchConfig({
        mcp_fetch_max_bytes: 40_000_000,
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

  it("takes a scheduled backup after a batch changes rows, and skips one when nothing changed", async () => {
    const own = ownObjectStore();
    const mine = bucketAt(own.S3_PREFIX);
    const server = await bootFreshServer("backups-rows", {
      ...own,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
    });
    try {
      const { operator, working } = clientsFor(server);
      const id = await ledger(working, "schedule", 1);
      await afterFirstScheduledBackup(server);
      const before = (await mine.backupKeys()).length;

      // The witness: with nothing changed, the run puts nothing.
      const idle = await runJob<{ outcome: string }>(operator, "backup");
      expect(idle.result.outcome).toBe("unchanged");

      const written = await working.writeRows(id, "lines", {
        operations: [{ op: "put", values: { amount: 7 } }],
      });
      expect(written.status, JSON.stringify(written.error)).toBe(200);
      const after = await runJob<{ outcome: string }>(operator, "backup");
      expect(after.result.outcome).toBe("put");
      expect((await mine.backupKeys()).length).toBe(before + 1);
    } finally {
      await server.stop();
    }
  });

  it("backs up on its interval with no request", async () => {
    const own = ownObjectStore();
    const mine = bucketAt(own.S3_PREFIX);
    const server = await bootFreshServer("backups-interval", {
      ...own,
      MARFA_BACKUP_INTERVAL_SECONDS: "1",
    });
    try {
      // The object is listed before the server records it, so wait on the record.
      const answer = await waitFor("a scheduled backup", async () => {
        const read = await health(server, clientsFor(server).operator);
        return read.backups.last_backup ? read : undefined;
      });
      expect(answer.backups.status).toBe("ok");
      const keys = await mine.backupKeys();
      expect(keys[0]).toMatch(
        /\/backups\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/\d{8}T\d{6}\.\d{3}Z\.tar$/,
      );
      expect(answer.backups.last_backup).toBe(keys[0]!.split("/").pop());
    } finally {
      await server.stop();
    }
  });

  it("takes no scheduled backup while backup_interval_seconds is 0, and leaves backup out of the housekeeping listing", async () => {
    const own = ownObjectStore();
    const mine = bucketAt(own.S3_PREFIX);
    const server = await bootFreshServer("backups-off", {
      ...own,
      MARFA_BACKUP_INTERVAL_SECONDS: "0",
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

  it("says in health that backups are off on an instance with nowhere to put them, and answers 409 no_backup_destination at each door", async () => {
    const server = await bootFreshServer("backups-no-destination", DISK_ONLY);
    try {
      const answer = await health(server);
      expect(answer.status).toBe("ok");
      expect(answer.backups).toEqual({
        status: "off",
        reason: "no_backup_destination",
      });
      const owner = ownerOf(server);
      for (const refused of [
        await owner.listBackups(),
        await owner.runBackup(),
        await owner.restoreBackup(
          OTHER_INSTANCE,
          backupName(new Date("2026-11-09T10:15:30.250Z")),
        ),
        await owner.adoptBackupFolder(),
      ]) {
        expect(refused.status, JSON.stringify(refused.data)).toBe(409);
        expect(refused.error?.error.code).toBe("no_backup_destination");
      }
    } finally {
      await server.stop();
    }
  });
  it("says in attention that no backups are kept and how to set one, and says an interval of 0 differently", async () => {
    const none = await bootFreshServer("backups-said-none", DISK_ONLY);
    try {
      const concerns = await backupConcerns(none);
      expect(concerns).toEqual([
        expect.objectContaining({
          reference: "no_backup_destination",
          title: "No backups are kept",
        }),
      ]);
      for (const part of [
        "MARFA_BACKUP_PATH",
        "S3_BUCKET",
        "marfa server restart",
      ]) {
        expect(concerns[0]!.description).toContain(part);
      }
    } finally {
      await none.stop();
    }

    const off = await bootFreshServer("backups-said-off", {
      ...ownObjectStore(),
      MARFA_BACKUP_INTERVAL_SECONDS: "0",
    });
    try {
      const concerns = await backupConcerns(off);
      expect(concerns.map((concern) => concern.reference)).toEqual([
        "turned_off",
      ]);
      expect(concerns[0]!.title).toBe("Scheduled backups are turned off");
      expect(concerns[0]!.description).not.toContain("MARFA_BACKUP_PATH");
    } finally {
      await off.stop();
    }
  });
});
