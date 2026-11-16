import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { archiveLines, LINE_FILES } from "../../utils/archive.js";
import {
  backupConcerns,
  backupInBucket,
  backupInFolder,
  backupName,
  bucketAt,
  healthDetail,
  instanceIdOf,
  ownerOf,
  partName,
  sha256Of,
  type BackupManifest,
  type StoredBackup,
} from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  ownObjectStore,
  replicateUntilCaughtUp,
} from "../../utils/own-blob-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { controlRequest } from "../../utils/control-request.js";

/**
 * Backups in parts: each backup is a manifest naming parts stored under
 * `backup-parts/<instance id>/` by the SHA-256 of their bytes, so a part a
 * later backup holds unchanged is stored once. The same tests run against an
 * object store and a backup folder. Each origin server has a destination of
 * its own; the servers a backup is restored into share it, as a new instance
 * replacing an old one does.
 */
const TABLE_PART = 4 * 1024 * 1024;
const LARGE_ROWS = 1200;
const TYPE = "user.backup_parts_ledger";

/** A backup destination the fixture reads and changes directly. */
interface Place {
  env: Record<string, string>;
  /** The names of the parts stored for `instance`, sorted, leaving out any being written. */
  parts(instance: string): Promise<string[]>;
  readPart(instance: string, name: string): Promise<Uint8Array>;
  writePart(instance: string, name: string, body: Uint8Array): Promise<void>;
  deletePart(instance: string, name: string): Promise<void>;
  readManifest(instance: string, backup: string): Promise<Uint8Array>;
  writeManifest(
    instance: string,
    backup: string,
    body: Uint8Array | string,
  ): Promise<void>;
  deleteManifest(instance: string, backup: string): Promise<void>;
  backup(instance: string, backup: string): Promise<StoredBackup>;
  remove(): void;
}

function bucketPlace(): Place {
  const store = ownObjectStore();
  const bucket = bucketAt(store.S3_PREFIX);
  const part = (instance: string, name: string) =>
    `${store.S3_PREFIX}/backup-parts/${instance}/${name}`;
  const manifest = (instance: string, backup: string) =>
    `${store.S3_PREFIX}/backups/${instance}/${backup}`;
  return {
    env: store,
    async parts(instance) {
      return (await bucket.partKeys(instance)).map((key) =>
        key.split("/").pop()!,
      );
    },
    readPart: (instance, name) => bucket.get(part(instance, name)),
    writePart: (instance, name, body) => bucket.put(part(instance, name), body),
    deletePart: (instance, name) => bucket.delete(part(instance, name)),
    readManifest: (instance, backup) => bucket.get(manifest(instance, backup)),
    writeManifest: (instance, backup, body) =>
      bucket.put(manifest(instance, backup), body),
    deleteManifest: (instance, backup) =>
      bucket.delete(manifest(instance, backup)),
    backup: (instance, backup) => backupInBucket(bucket, instance, backup),
    remove() {},
  };
}

function folderPlace(): Place {
  const root = mkdtempSync(join(tmpdir(), "marfa-backup-parts-"));
  const parts = (instance: string) => join(root, "backup-parts", instance);
  const backups = (instance: string) => join(root, "backups", instance);
  return {
    env: { S3_BUCKET: "", MARFA_BACKUP_PATH: root },
    parts(instance) {
      const dir = parts(instance);
      return Promise.resolve(
        existsSync(dir)
          ? readdirSync(dir)
              .filter((name) => !name.startsWith("."))
              .sort()
          : [],
      );
    },
    readPart: (instance, name) =>
      Promise.resolve(
        new Uint8Array(readFileSync(join(parts(instance), name))),
      ),
    writePart(instance, name, body) {
      mkdirSync(parts(instance), { recursive: true });
      writeFileSync(join(parts(instance), name), body);
      return Promise.resolve();
    },
    deletePart(instance, name) {
      unlinkSync(join(parts(instance), name));
      return Promise.resolve();
    },
    readManifest: (instance, backup) =>
      Promise.resolve(
        new Uint8Array(readFileSync(join(backups(instance), backup))),
      ),
    writeManifest(instance, backup, body) {
      writeFileSync(join(backups(instance), backup), body);
      return Promise.resolve();
    },
    deleteManifest(instance, backup) {
      unlinkSync(join(backups(instance), backup));
      return Promise.resolve();
    },
    backup: (instance, backup) => backupInFolder(root, instance, backup),
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A value with every object's keys in order, since JSON gives key order no meaning. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/** Every line an archive of everything carries, sorted, by line file. */
async function linesOf(server: FreshServer) {
  const minted = await ownerOf(server).createKey({
    label: "everything",
    source: `backup-parts-${randomBytes(6).toString("hex")}`,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  const everything = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  const archive = await everything.exportArchive({
    state: "any",
    files: "false",
  });
  expect(archive.status).toBe(200);
  return Object.fromEntries(
    LINE_FILES.map((name) => [
      name,
      archiveLines(archive.data, name)
        .map((line) => JSON.stringify(canonical(line)))
        .sort(),
    ]),
  );
}

/** The sizes of the parts a manifest names, by name. */
function sizesOf(manifest: BackupManifest): Map<string, number> {
  return new Map(
    manifest.parts.map((part) => [partName(part), part.size_bytes]),
  );
}

/** `body` with one byte in the middle changed, so its size stays the same. */
function altered(body: Uint8Array): Uint8Array {
  const changed = new Uint8Array(body);
  changed[Math.floor(changed.length / 2)]! ^= 0x01;
  return changed;
}

/** Bytes that are a part's in name only: stored under the SHA-256 they have. */
function stray(): { name: string; body: Uint8Array } {
  const body = new Uint8Array(randomBytes(512));
  return { name: `${sha256Of(body)}.ndjson.gz`, body };
}

function partsSuite(make: () => Place, folder: boolean) {
  let place: Place;
  let origin: FreshServer;
  let originId: string;
  let restorer: FreshServer | undefined;
  let refuser: FreshServer | undefined;
  const made = {
    large: "",
    small: [] as string[],
  };
  const names: string[] = [];
  let atFirst: Record<string, string[]>;
  let large: { name: string; size: number };

  beforeAll(async () => {
    place = make();
    origin = await bootFreshServer("backup-parts-origin", {
      ...place.env,
      MARFA_BACKUP_INTERVAL_SECONDS: "0",
    });
    originId = await instanceIdOf(origin);
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await refuser?.stop();
    await restorer?.stop();
    await origin?.stop();
    place?.remove();
  }, FRESH_SERVER_TIMEOUT_MS);

  async function smallRow(at: number, amount: number) {
    const written = await clientsFor(origin).working.writeRows(
      made.small[at]!,
      "small",
      { operations: [{ op: "put", values: { amount } }] },
    );
    expect(written.status, JSON.stringify(written.error)).toBe(200);
  }

  async function backUp() {
    const run = await ownerOf(origin).runBackup();
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    expect(run.data.outcome).toBe("put");
    names.push(run.data.backup.name);
    return run.data;
  }

  async function fresh(label: string): Promise<FreshServer> {
    const server = await bootFreshServer(label, {
      ...place.env,
      MARFA_BACKUP_INTERVAL_SECONDS: "0",
    });
    expect(await instanceIdOf(server)).not.toBe(originId);
    return server;
  }

  it("stores none of the parts of a backup that holds what the last one held, and not the rows of a large table that did not change, and answers what it sent", async () => {
    const { operator, working } = clientsFor(origin);
    const registered = await working.registerType({
      id: TYPE,
      fields: { title: { type: "string" } },
      tables: {
        large: { columns: { text: { type: "string" } } },
        small: { columns: { amount: { type: "number" } } },
      },
    } as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const item = async (title: string) => {
      const created = await working.createItem({
        type: TYPE,
        properties: { title },
      } as never);
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      return created.data.item.id;
    };
    made.large = await item("a large ledger");
    for (let at = 0; at < LARGE_ROWS; at += 100) {
      const written = await working.writeRows(made.large, "large", {
        operations: Array.from({ length: 100 }, () => ({
          op: "put" as const,
          values: { text: randomBytes(2048).toString("hex") },
        })),
      });
      expect(written.status, JSON.stringify(written.error)).toBe(200);
    }
    const tables = await working.listTables(made.large);
    expect(tables.status, JSON.stringify(tables.error)).toBe(200);
    expect(
      tables.data.data.find((table) => table.name === "large")?.bytes,
    ).toBeGreaterThanOrEqual(TABLE_PART);
    for (let at = 0; at < 3; at++) {
      made.small.push(await item(`a small ledger ${String(at)}`));
      await smallRow(at, at);
    }
    const note = await working.createItem({
      type: "core.note",
      properties: { title: "kept in parts", body: "kept" },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    const uploaded = await working.uploadBlob(
      bytesOf("a file a backup in parts names", 4096),
      "text/plain",
    );
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const file = await working.createItem({
      type: "core.file",
      properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
    });
    expect(file.status, JSON.stringify(file.error)).toBe(201);
    if (!folder) await replicateUntilCaughtUp(operator, "the file's copy");

    // The witness: the first backup stores every part, and says so.
    expect(await place.parts(originId)).toEqual([]);
    const first = await backUp();
    await expectMatchesSchema("POST", "/backups", 200, first);
    const one = await place.backup(originId, first.backup.name);
    const stored = await place.parts(originId);
    expect(stored).toEqual([...sizesOf(one.manifest).keys()].sort());
    expect(first.sent_bytes).toBe(
      [...sizesOf(one.manifest).values()].reduce((sum, size) => sum + size, 0),
    );
    const largeParts = one.manifest.parts.filter(
      (part) => part.entry === "rows.ndjson.gz" && part.lines >= LARGE_ROWS,
    );
    expect(largeParts).toHaveLength(1);
    large = { name: partName(largeParts[0]!), size: largeParts[0]!.size_bytes };

    const second = await backUp();
    expect(second.sent_bytes).toBe(0);
    const two = await place.backup(originId, second.backup.name);
    expect(two.manifest.parts).toEqual(one.manifest.parts);
    expect(await place.parts(originId)).toEqual(stored);
    atFirst = await linesOf(origin);

    await smallRow(0, 10);
    const third = await backUp();
    const three = await place.backup(originId, third.backup.name);
    const after = await place.parts(originId);
    const added = after.filter((name) => !stored.includes(name));
    expect(added.length).toBeGreaterThan(0);
    expect(after.filter((name) => !added.includes(name))).toEqual(stored);
    const sizes = sizesOf(three.manifest);
    expect(third.sent_bytes).toBe(
      added.reduce((sum, name) => sum + sizes.get(name)!, 0),
    );
    expect(sizes.get(large.name)).toBe(large.size);
    expect(added).not.toContain(large.name);
    expect(third.sent_bytes).toBeLessThan(large.size);
  });

  it("refuses a restore with 409 backup_parts_missing naming each part missing from its instance's parts folder or altered there, and changes nothing", async () => {
    // The witness: the first backup, whole, restores every line into a fresh server.
    restorer = await fresh("backup-parts-restorer");
    const restored = await ownerOf(restorer).restoreBackup(originId, names[0]!);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
    const lines = await linesOf(restorer);
    for (const file of LINE_FILES) {
      expect(lines[file], file).toEqual(atFirst[file]);
    }

    const one = await place.backup(originId, names[0]!);
    const three = await place.backup(originId, names[2]!);
    const named = sizesOf(one.manifest);
    const onlyThird = [...sizesOf(three.manifest).keys()].find(
      (name) => !named.has(name),
    )!;
    expect(onlyThird).toBeTruthy();
    refuser = await fresh("backup-parts-refuser");
    const before = await linesOf(refuser);
    const refusedFor = async (part: string) => {
      const refused = await ownerOf(refuser!).restoreBackup(
        originId,
        names[2]!,
      );
      expect(refused.status, JSON.stringify(refused.data)).toBe(409);
      await expectMatchesSchema(
        "POST",
        "/backups/{instance_id}/{name}/restore",
        409,
        refused.error,
      );
      expect(refused.error?.error.code).toBe("backup_parts_missing");
      expect(refused.error?.error.details).toEqual({ missing_parts: [part] });
      expect(await linesOf(refuser!)).toEqual(before);
    };

    const missing = await place.readPart(originId, onlyThird);
    await place.deletePart(originId, onlyThird);
    try {
      await refusedFor(onlyThird);
    } finally {
      await place.writePart(originId, onlyThird, missing);
    }

    const whole = await place.readPart(originId, large.name);
    const altered = new Uint8Array(whole);
    altered[Math.floor(altered.length / 2)]! ^= 0x01;
    await place.writePart(originId, large.name, altered);
    try {
      await refusedFor(large.name);
    } finally {
      await place.writePart(originId, large.name, whole);
    }
  });

  it("refuses a restore whose manifest does not read, naming the backup, and changes nothing", async () => {
    const before = await linesOf(refuser!);
    const written = await place.readManifest(originId, names[1]!);
    const later = JSON.parse(Buffer.from(written).toString("utf8")) as Record<
      string,
      unknown
    >;
    for (const body of [
      JSON.stringify({ ...later, version: 2 }),
      "not a manifest",
    ]) {
      await place.writeManifest(originId, names[1]!, body);
      try {
        const refused = await ownerOf(refuser!).restoreBackup(
          originId,
          names[1]!,
        );
        expect(refused.status, JSON.stringify(refused.data)).toBe(400);
        expect(refused.error?.error.code).toBe("validation_error");
        expect(refused.error?.error.message).toContain(names[1]!);
        expect(refused.error?.error.message).toContain(originId);
        expect(await linesOf(refuser!)).toEqual(before);
      } finally {
        await place.writeManifest(originId, names[1]!, written);
      }
    }

    const restored = await ownerOf(refuser!).restoreBackup(originId, names[2]!);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const [now, after] = [await linesOf(origin), await linesOf(refuser!)];
    for (const file of ["items", "versions", "rows"] as const) {
      expect(after[file], file).toEqual(now[file]);
    }
  });

  it("deletes the parts no listed backup names once it has read every manifest, and none while one does not read", async () => {
    const owner = ownerOf(origin);
    const listedNames = async () =>
      (await owner.listBackups()).data.data
        .filter((backup) => backup.instance_id === originId)
        .map((backup) => backup.name);
    const kept = async () => {
      const held = await place.parts(originId);
      for (const name of await listedNames()) {
        if (name === unread) continue;
        const backup = await place.backup(originId, name);
        for (const part of backup.manifest.parts) {
          expect(held).toContain(partName(part));
        }
      }
    };
    const unread = backupName(new Date("2020-01-01T00:00:00.000Z"));

    // The witness: a part no backup names is deleted by the next backup.
    const first = stray();
    await place.writePart(originId, first.name, first.body);
    expect(await place.parts(originId)).toContain(first.name);
    await smallRow(1, 11);
    await backUp();
    expect(await place.parts(originId)).not.toContain(first.name);
    await kept();

    const second = stray();
    await place.writePart(originId, second.name, second.body);
    await place.writeManifest(originId, unread, "not a manifest");
    await smallRow(1, 12);
    await backUp();
    expect(await listedNames()).toContain(unread);
    expect(await place.parts(originId)).toContain(second.name);
    await kept();

    await place.deleteManifest(originId, unread);
    await smallRow(1, 13);
    await backUp();
    expect(await place.parts(originId)).not.toContain(second.name);
    await kept();
  });

  it("keeps the parts a backup it found in its folder names once the folder stops listing that backup, while it deletes a part no backup names", async () => {
    const found = backupName(new Date("2020-01-02T00:00:00.000Z"));
    const manifest = JSON.parse(
      Buffer.from(await place.readManifest(originId, names.at(-1)!)).toString(
        "utf8",
      ),
    ) as BackupManifest;
    const held = stray();
    await place.writePart(originId, held.name, held.body);
    manifest.parts.push({
      entry: "rows.ndjson.gz",
      sha256: held.name.replace(/\.ndjson\.gz$/, ""),
      size_bytes: held.body.length,
      lines: 0,
    });
    await place.writeManifest(originId, found, JSON.stringify(manifest));
    await smallRow(1, 14);
    await backUp();
    expect(await place.parts(originId)).toContain(held.name);

    await place.deleteManifest(originId, found);
    // The witness: in the same run, a part no backup names is deleted.
    const loose = stray();
    await place.writePart(originId, loose.name, loose.body);
    await smallRow(1, 15);
    await backUp();
    const after = await place.parts(originId);
    expect(after).not.toContain(loose.name);
    expect(after).toContain(held.name);
  });

  it("stores again a part missing from its instance's parts folder or altered there, sends only those parts, and both backups then restore", async () => {
    const before = names.at(-1)!;
    const last = await place.backup(originId, before);
    const sizes = sizesOf(last.manifest);
    expect(sizes.get(large.name)).toBe(large.size);
    const lost = last.manifest.parts.find(
      (part) => part.entry === "items.ndjson.gz",
    )!;
    const lostBody = await place.readPart(originId, partName(lost));
    await place.deletePart(originId, partName(lost));
    await place.writePart(
      originId,
      large.name,
      altered(await place.readPart(originId, large.name)),
    );

    // The witness: the backup as it stands no longer restores.
    const refused = await ownerOf(refuser!).restoreBackup(originId, before);
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(refused.error?.error.code).toBe("backup_parts_missing");

    const run = await backUp();
    const again = await place.backup(originId, run.backup.name);
    expect(again.manifest.parts).toEqual(last.manifest.parts);
    expect(run.sent_bytes).toBe(lost.size_bytes + large.size);
    expect(
      `${sha256Of(await place.readPart(originId, large.name))}.ndjson.gz`,
    ).toBe(large.name);
    expect(await place.readPart(originId, partName(lost))).toEqual(lostBody);
    for (const name of [before, run.backup.name]) {
      const restored = await ownerOf(refuser!).restoreBackup(originId, name);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    }
  });

  it("says in health and attention that a part is damaged once a restore of its own backup finds it altered, until a backup stores the part again", async () => {
    const name = names.at(-1)!;
    const backup = await place.backup(originId, name);
    const target = backup.manifest.parts.find(
      (part) => part.entry === "items.ndjson.gz",
    )!;
    const references = async () =>
      (await backupConcerns(origin)).map((concern) => concern.reference);
    const quiet = await healthDetail(origin);
    expect(quiet.backups.damaged_parts).toBe(0);
    expect(quiet.backups.status).not.toBe("failing");
    expect(await references()).not.toContain("parts_damaged");

    const whole = await place.readPart(originId, partName(target));
    await place.writePart(originId, partName(target), altered(whole));
    const refused = await ownerOf(origin).restoreBackup(originId, name);
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(refused.error?.error.details).toEqual({
      missing_parts: [partName(target)],
    });
    const damaged = await healthDetail(origin);
    expect(damaged.backups).toMatchObject({
      status: "failing",
      damaged_parts: 1,
    });
    expect(damaged.status).not.toBe("ok");
    const concern = (await backupConcerns(origin)).find(
      (entry) => entry.reference === "parts_damaged",
    );
    expect(concern?.description).toContain("1 part");

    const run = await backUp();
    expect(run.sent_bytes).toBe(target.size_bytes);
    const cleared = await healthDetail(origin);
    expect(cleared.backups.damaged_parts).toBe(0);
    expect(cleared.backups.status).not.toBe("failing");
    expect(await references()).not.toContain("parts_damaged");
  });

  it("refuses allow_missing_files given as anything but true or false with 400 validation_error, and restores nothing", async () => {
    const name = names.at(-1)!;
    const path = `/backups/${originId}/${name}/restore`;
    const before = await linesOf(refuser!);
    for (const spelling of ["1", "yes", "TRUE", ""]) {
      const refused = await controlRequest(
        refuser!.controlSocket,
        `${path}?allow_missing_files=${spelling}`,
        { method: "POST" },
      );
      expect(refused.status, spelling).toBe(400);
      expect(
        (refused.body as { error: { code: string } }).error.code,
        spelling,
      ).toBe("validation_error");
    }
    expect(await linesOf(refuser!)).toEqual(before);

    // The witness: spelled false, the same restore goes ahead.
    const restored = await controlRequest(
      refuser!.controlSocket,
      `${path}?allow_missing_files=false`,
      { method: "POST" },
    );
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  });

  if (!folder) return;

  it("lists no backup whose manifest was not written, deletes no part while that manifest may still land, and the next run stores only the parts it lacks", async () => {
    const owner = ownerOf(origin);
    const listed = async () =>
      (await owner.listBackups()).data.data.map((backup) => backup.name);
    const backupsBefore = await listed();
    const partsBefore = await place.parts(originId);
    await smallRow(2, 20);

    await origin.setFault("hold:backup:put");
    const failing = owner.runBackup();
    await origin.waitForHold("hold:backup:put");
    await origin.setFault("fail:backup-folder-write");
    await origin.clearFault("hold:backup:put");
    const failed = await failing;
    await origin.clearFault();
    expect(failed.status, JSON.stringify(failed.data)).toBe(503);
    expect(failed.error?.error.message).toMatch(/manifest/);
    expect(await listed()).toEqual(backupsBefore);
    const onlyFailed = (await place.parts(originId)).filter(
      (name) => !partsBefore.includes(name),
    );
    expect(onlyFailed.length).toBeGreaterThan(0);

    await smallRow(2, 21);
    const before = await place.parts(originId);
    const next = await backUp();
    const backup = await place.backup(originId, next.backup.name);
    const sizes = sizesOf(backup.manifest);
    const after = await place.parts(originId);
    const added = after.filter((name) => !before.includes(name));
    expect(next.sent_bytes).toBe(
      added.reduce((sum, name) => sum + sizes.get(name)!, 0),
    );
    expect(
      onlyFailed.filter((name) => !sizes.has(name)).length,
    ).toBeGreaterThan(0);
    for (const name of onlyFailed) expect(after).toContain(name);
  });

  it("restores a backup without the files no store holds when asked to, naming them in blobs_missing", async () => {
    const { working } = clientsFor(origin);
    const uploaded = await working.uploadBlob(
      bytesOf("a file whose copy goes", 4096),
      "text/plain",
    );
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const file = await working.createItem({
      type: "core.file",
      properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
    });
    expect(file.status, JSON.stringify(file.error)).toBe(201);
    const run = await backUp();
    const hex = uploaded.data.hash.replace(/^sha256:/, "");
    unlinkSync(
      join(
        place.env.MARFA_BACKUP_PATH!,
        "files",
        originId,
        hex.slice(0, 4),
        hex,
      ),
    );

    // The witness: asked for whole, the restore refuses for the file.
    const owner = ownerOf(refuser!);
    const refused = await owner.restoreBackup(originId, run.backup.name);
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(refused.error?.error.code).toBe("backup_files_missing");
    expect(refused.error?.error.details).toEqual({
      missing_blobs: [uploaded.data.hash],
    });
    expect(
      (await clientsFor(refuser!).working.getItem(file.data.item.id)).status,
    ).toBe(404);

    const restored = await owner.restoreBackup(originId, run.backup.name, {
      allow_missing_files: true,
    });
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([uploaded.data.hash]);
    expect(
      (await clientsFor(refuser!).working.getItem(file.data.item.id)).status,
    ).toBe(200);
  });
}

describe("backups in parts to an object store", () => {
  partsSuite(bucketPlace, false);
});

describe("backups in parts to a folder", () => {
  partsSuite(folderPlace, true);
});
