import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  afterFirstScheduledBackup,
  instanceIdOf,
  ownerOf,
} from "../../utils/backups.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";
import {
  bytesOf,
  clientsFor,
  everythingClient,
  ownObjectStore,
  replicateUntilCaughtUp,
  replicationIdle,
  runJob,
} from "../../utils/own-blob-server.js";
import { diskHolds, inspectStores } from "../../utils/store-faults.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { waitFor } from "../../utils/wait.js";

/**
 * `marfa_remove_file_copy` and `marfa_adopt_backup_folder` on servers of
 * their own, so the clock, the stores' faults and the backup folder can be
 * scripted. One server keeps its files on a disk and in an object store,
 * one restored from its export finds its files in that object store without
 * having written them, and one backs up to a folder whose disk a case swaps
 * for an empty one at the same path.
 */
const CONFIRMATION_LIFE_MS = 5 * 60 * 1000;
const REMOVE = "marfa_remove_file_copy";
const ADOPT = "marfa_adopt_backup_folder";
const SIZE = 2048;
const JOBS = ["blob-integrity", "blob-replicate", "blob-orphans"];
const REPLICATION_HELD = "hold:housekeeping:blob-replicate";

type Answer = Record<string, unknown>;

const copiesStore = ownObjectStore();
let copies: FreshServer;
let diskId: string;
let s3Id: string;
let filesAdmin: McpConnection;
let otherFilesAdmin: McpConnection;
let copiesBoth: McpConnection;

const parent = tempFolder("marfa-mcp-file-acts-");
const root = join(parent, "disk");
let folder: FreshServer;
let instanceId: string;
let backupsAdmin: McpConnection;
let backupsAdminKeyId: string;
let otherBackupsAdmin: McpConnection;
let folderBoth: McpConnection;
let backupsRest: MarfaClient;
let backupsRestKeyId: string;
let swaps = 0;

let found: FreshServer | undefined;

const connections: McpConnection[] = [];

async function mint(
  server: FreshServer,
  label: string,
  permissions: string[],
): Promise<{ id: string; key: string }> {
  const minted = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: `mcp-file-acts-${label}`,
      source: `mcp-file-acts-${label}`,
      type_permissions: {},
      permissions,
    },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body as unknown as { id: string; key: string };
}

async function admin(
  server: FreshServer,
  label: string,
  permissions: string[],
): Promise<{ connection: McpConnection; keyId: string }> {
  const { id, key } = await mint(server, label, permissions);
  const connection = await connectMcp(
    server.apiUrl,
    key,
    "2026-07-28",
    "/mcp/admin",
  );
  connections.push(connection);
  return { connection, keyId: id };
}

/** Waits until no blob job runs, and the next run of each is far off. */
async function jobsIdle(server: FreshServer): Promise<void> {
  const { operator } = clientsFor(server);
  await waitFor(
    "the first scheduled run of each blob job",
    async () => {
      const jobs = (await operator.listHousekeeping()).data.data;
      return JOBS.every((name) => {
        const job = jobs.find((row) => row.name === name);
        return (
          job !== undefined &&
          job.running_since === null &&
          Date.parse(job.next_run_at) - Date.now() > job.interval_seconds * 500
        );
      })
        ? true
        : undefined;
    },
    90_000,
  );
}

async function bootCopies(): Promise<void> {
  copies = await bootFreshServer("mcp-file-acts-copies", copiesStore);
  await jobsIdle(copies);
  const stores = (await clientsFor(copies).operator.listBlobStores()).data.data;
  diskId = stores.find((store) => store.kind === "disk")!.id;
  s3Id = stores.find((store) => store.kind === "s3")!.id;
  filesAdmin = (await admin(copies, "files", ["blobs.manage"])).connection;
  otherFilesAdmin = (await admin(copies, "other-files", ["blobs.manage"]))
    .connection;
  copiesBoth = (
    await admin(copies, "copies-both", ["blobs.manage", "backups.manage"])
  ).connection;
}

async function bootFolder(): Promise<void> {
  mkdirSync(root);
  folder = await bootFreshServer("mcp-file-acts-folder", {
    MARFA_OBJECT_STORE_BUCKET: "",
    MARFA_BACKUP_PATH: root,
    MARFA_BACKUP_INTERVAL_SECONDS: "31536000",
    MARFA_BLOB_CLEANUP_GRACE_SECONDS: "0",
  });
  await afterFirstScheduledBackup(folder);
  await jobsIdle(folder);
  instanceId = await instanceIdOf(folder);
  const made = await admin(folder, "backups", ["backups.manage"]);
  backupsAdmin = made.connection;
  backupsAdminKeyId = made.keyId;
  otherBackupsAdmin = (await admin(folder, "other-backups", ["backups.manage"]))
    .connection;
  folderBoth = (
    await admin(folder, "folder-both", ["blobs.manage", "backups.manage"])
  ).connection;
  const rest = await mint(folder, "backups-rest", ["backups.manage"]);
  backupsRest = new MarfaClient({ baseUrl: folder.apiUrl, apiKey: rest.key });
  backupsRestKeyId = rest.id;
  await fileItem(folder, "a file a backup names");
  const backup = await ownerOf(folder).runBackup();
  expect(backup.status, JSON.stringify(backup.error)).toBe(200);
}

beforeAll(async () => {
  await Promise.all([bootCopies(), bootFolder()]);
}, FRESH_SERVER_TIMEOUT_MS + 120_000);

// The server restored from an export keeps its replication held until its own case clears it.
afterEach(async () => {
  await copies?.clearFault();
  await folder?.clearFault();
});

afterAll(async () => {
  for (const connection of connections) await connection.close();
  await found?.stop();
  await copies?.stop();
  await folder?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function call(
  connection: McpConnection,
  tool: string,
  args: Answer,
): Promise<Answer> {
  return toolResult(await callTool(connection, tool, args));
}

async function stale(
  connection: McpConnection,
  tool: string,
  args: Answer,
): Promise<Answer> {
  const refused = toolError(await callTool(connection, tool, args));
  expect(refused.code, JSON.stringify(refused)).toBe("confirmation_stale");
  return refused;
}

async function waiting(server: FreshServer, name: string): Promise<number> {
  return (
    (await server.faults()).find((fault) => fault.name === name)?.waiting ?? 0
  );
}

async function fired(server: FreshServer, name: string): Promise<number> {
  return (
    (await server.faults()).find((fault) => fault.name === name)?.fired ?? 0
  );
}

/** A file named by an item, so nothing purges it. */
async function fileItem(
  server: FreshServer,
  words: string,
): Promise<{ hash: string; bytes: Uint8Array; id: string }> {
  const { working } = clientsFor(server);
  const bytes = bytesOf(words, SIZE);
  const uploaded = await working.uploadBlob(bytes, "text/plain");
  expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
  const item = await working.createItem({
    type: "core.file",
    properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
  });
  expect(item.status, JSON.stringify(item.error)).toBe(201);
  return { hash: uploaded.data.hash, bytes, id: item.data.item.id };
}

async function kinds(server: FreshServer, hash: string): Promise<string[]> {
  const listed = await clientsFor(server).operator.listBlobCopies(hash);
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data.map((copy) => copy.kind).sort();
}

/** A file in the disk and the object store, once replication is idle again. */
async function replicated(
  words: string,
): Promise<{ hash: string; bytes: Uint8Array }> {
  const file = await fileItem(copies, words);
  await waitFor(`the object store's copy of ${file.hash}`, async () =>
    (await kinds(copies, file.hash)).length === 2 ? true : undefined,
  );
  await replicationIdle(clientsFor(copies).operator);
  expect(await diskHolds(copies.controlSocket, file.hash)).toBe(true);
  return file;
}

/** Uploads the bytes again, which records the disk's copy again. */
async function placeAgain(
  server: FreshServer,
  bytes: Uint8Array,
): Promise<void> {
  const again = await clientsFor(server).working.uploadBlob(
    bytes,
    "text/plain",
  );
  expect([200, 201], JSON.stringify(again.error)).toContain(again.status);
}

function area(): string {
  return join(root, "files", instanceId);
}

function markerPath(): string {
  return join(area(), ".marfa-store");
}

function markerNow(): string | undefined {
  return existsSync(markerPath())
    ? readFileSync(markerPath(), "utf8").trim()
    : undefined;
}

async function folderStore(): Promise<{ id: string; locator: string }> {
  const stores = (await clientsFor(folder).operator.listBlobStores()).data.data;
  const attached = stores.find(
    (store) => store.kind === "folder" && store.detached_at === null,
  );
  expect(attached, JSON.stringify(stores)).toBeDefined();
  return attached!;
}

async function lastBackup(): Promise<unknown> {
  const answer = await clientsFor(folder).operator.rawRequest<{
    backups: { last_backup?: string | null };
  }>("/health");
  expect(answer.status).toBe(200);
  return answer.data.backups.last_backup ?? null;
}

/** Another empty folder takes the backup folder's path, as a replaced disk does. */
function swapFolder(): void {
  swaps += 1;
  renameSync(root, join(parent, `old disk ${String(swaps)}`));
  mkdirSync(root);
}

/** The disk is replaced once replication, which an adopt wakes, has settled. */
async function loseTheDisk(): Promise<void> {
  await replicationIdle(clientsFor(folder).operator);
  swapFolder();
}

/** Makes sure the folder holds the store recorded there, adopting it if not. */
async function marked(): Promise<void> {
  const looked = await callTool(backupsAdmin, ADOPT, {});
  if (looked.isError && toolError(looked).code === "conflict") return;
  const shown = toolResult(looked);
  const adopted = await call(backupsAdmin, ADOPT, { confirm: shown.confirm });
  expect(adopted.marked, JSON.stringify(adopted)).toBe(true);
}

describe("marfa_remove_file_copy removes a copy of a file", () => {
  it("removes nothing without a confirmation, and previews the copy, the copies that stay and what becomes of its bytes", async () => {
    const { hash } = await replicated("previewed");
    const shown = await call(filesAdmin, REMOVE, { hash, store_id: diskId });
    expect(shown).toMatchObject({
      file: { hash, size_bytes: SIZE },
      copy: {
        store_id: diskId,
        kind: "disk",
        written: true,
        recorded_at: expect.any(String),
      },
      other_copies: [
        {
          store_id: s3Id,
          kind: "s3",
          written: true,
          recorded_at: expect.any(String),
        },
      ],
      min_copies: 1,
      bytes: "deleted",
      confirm: expect.any(String),
      expires_at: expect.any(String),
    });
    expect(shown.copy).toHaveProperty("verified_at");
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);
    expect(await diskHolds(copies.controlSocket, hash)).toBe(true);
  });

  it("refuses a preview that would leave fewer copies than the instance keeps", async () => {
    const { hash } = await replicated("the last copy");
    const dropped = await clientsFor(copies).operator.deleteBlobCopy(
      hash,
      s3Id,
    );
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    const refused = toolError(
      await callTool(filesAdmin, REMOVE, { hash, store_id: diskId }),
    );
    expect(refused.code).toBe("copies_below_minimum");
    expect(refused.confirm).toBeUndefined();
    expect(await kinds(copies, hash)).toEqual(["disk"]);
  });

  it("removes the copy and deletes its bytes with the confirmation the preview gave", async () => {
    const { hash } = await replicated("removed");
    const args = { hash, store_id: diskId };
    const shown = await call(filesAdmin, REMOVE, args);
    const removed = await call(filesAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(removed).toMatchObject({ removed: true, bytes: "deleted" });
    expect(removed.already_done).toBeUndefined();
    expect(await kinds(copies, hash)).toEqual(["s3"]);
    expect(await diskHolds(copies.controlSocket, hash)).toBe(false);
  });

  it("says the bytes are queued when the store cannot delete them yet, and deleted once a later run has", async () => {
    const { hash } = await replicated("queued");
    const args = { hash, store_id: diskId };
    const shown = await call(filesAdmin, REMOVE, args);
    await copies.setFault("fail:blob-delete");
    const removed = await call(filesAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(removed).toMatchObject({ removed: true, bytes: "queued" });
    expect(await fired(copies, "fail:blob-delete")).toBe(1);
    await copies.clearFault();
    expect(await diskHolds(copies.controlSocket, hash)).toBe(true);
    expect(
      await call(filesAdmin, REMOVE, { ...args, confirm: shown.confirm }),
    ).toMatchObject({
      removed: true,
      already_done: true,
      recorded: false,
      bytes: "queued",
    });

    await runJob(clientsFor(copies).operator, "blob-integrity");
    expect(await diskHolds(copies.controlSocket, hash)).toBe(false);
    expect(
      await call(filesAdmin, REMOVE, { ...args, confirm: shown.confirm }),
    ).toMatchObject({
      removed: true,
      already_done: true,
      recorded: false,
      bytes: "deleted",
    });
  });

  it("refuses a confirmation once the copy was removed since the preview, without a new preview", async () => {
    const { hash, bytes } = await replicated("removed and placed again");
    const args = { hash, store_id: diskId };
    const shown = await call(filesAdmin, REMOVE, args);
    const dropped = await clientsFor(copies).operator.deleteBlobCopy(
      hash,
      diskId,
    );
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    const refused = await stale(filesAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(refused.confirm).toBeUndefined();
    expect(await kinds(copies, hash)).toEqual(["s3"]);

    // The disk keeps a file's copy under its hash, so the copy placed again is the one previewed.
    await placeAgain(copies, bytes);
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);
    const removed = await call(filesAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(removed).toMatchObject({ removed: true, bytes: "deleted" });
    expect(await kinds(copies, hash)).toEqual(["s3"]);
  });

  it("refuses a confirmation once the object store holds the copy in another object since the preview, with a new preview", async () => {
    const { hash } = await replicated("written again");
    const args = { hash, store_id: s3Id };
    const shown = await call(filesAdmin, REMOVE, args);
    expect(shown.bytes).toBe("deleted");
    const dropped = await clientsFor(copies).operator.deleteBlobCopy(
      hash,
      s3Id,
    );
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    await replicateUntilCaughtUp(
      clientsFor(copies).operator,
      `the object store's copy of ${hash} again`,
    );
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);

    const refused = await stale(filesAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(refused).toMatchObject({
      copy: { store_id: s3Id, written: true },
      bytes: "deleted",
      confirm: expect.any(String),
    });
    expect(refused.confirm).not.toBe(shown.confirm);
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);
    expect(
      await call(filesAdmin, REMOVE, { ...args, confirm: refused.confirm }),
    ).toMatchObject({ removed: true, bytes: "deleted" });
    expect(await kinds(copies, hash)).toEqual(["disk"]);
  });

  it("refuses a confirmation once the copy changed and removing it would leave fewer copies than the instance keeps, without a new preview", async () => {
    const { hash } = await replicated("changed and alone");
    const args = { hash, store_id: s3Id };
    const shown = await call(filesAdmin, REMOVE, args);
    const { operator } = clientsFor(copies);
    const dropped = await operator.deleteBlobCopy(hash, s3Id);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    await replicateUntilCaughtUp(
      operator,
      `the object store's copy of ${hash} again`,
    );
    await copies.setFault(REPLICATION_HELD);
    const alone = await operator.deleteBlobCopy(hash, diskId);
    expect(alone.status, JSON.stringify(alone.error)).toBe(200);
    expect(await kinds(copies, hash)).toEqual(["s3"]);

    const refused = await stale(filesAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(refused.confirm).toBeUndefined();
    expect(await kinds(copies, hash)).toEqual(["s3"]);
    // The witness: a preview of the same copy is refused for the copies it would leave.
    const previewed = toolError(await callTool(filesAdmin, REMOVE, args));
    expect(previewed.code).toBe("copies_below_minimum");
  });

  it("changes nothing more on a confirmation an earlier call used, and says what the copy is now", async () => {
    const { hash, bytes } = await replicated("repeated");
    const args = { hash, store_id: diskId };
    const shown = await call(filesAdmin, REMOVE, args);
    const confirmed = { ...args, confirm: shown.confirm };
    expect(await call(filesAdmin, REMOVE, confirmed)).toMatchObject({
      removed: true,
      bytes: "deleted",
    });
    expect(await call(filesAdmin, REMOVE, confirmed)).toMatchObject({
      removed: true,
      already_done: true,
      recorded: false,
      bytes: "deleted",
    });

    await placeAgain(copies, bytes);
    const again = await call(filesAdmin, REMOVE, confirmed);
    expect(again).toMatchObject({
      removed: true,
      already_done: true,
      recorded: true,
    });
    expect(again.bytes).toBeUndefined();
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);
    expect(await diskHolds(copies.controlSocket, hash)).toBe(true);
  });

  it("answers a confirmation that does not hold while the stores do not answer, and waits on them for one that holds", async () => {
    const { hash } = await replicated("asked of the stores");
    const other = await replicated("another file");
    const args = { hash, store_id: diskId };
    const mine = await call(filesAdmin, REMOVE, args);
    const theirs = await call(otherFilesAdmin, REMOVE, args);
    const otherFile = await call(filesAdmin, REMOVE, {
      hash: other.hash,
      store_id: diskId,
    });
    const otherStore = await call(filesAdmin, REMOVE, {
      hash,
      store_id: s3Id,
    });

    await copies.setFault("hold:blob-has");
    for (const confirm of [
      theirs.confirm,
      otherFile.confirm,
      otherStore.confirm,
    ]) {
      const refused = await stale(filesAdmin, REMOVE, { ...args, confirm });
      expect(refused.confirm).toBeUndefined();
    }
    expect(await waiting(copies, "hold:blob-has")).toBe(0);
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);

    // The witness: a confirmation that holds asks the stores, and waits on them.
    const removing = callTool(filesAdmin, REMOVE, {
      ...args,
      confirm: mine.confirm,
    });
    await copies.waitForHold("hold:blob-has");
    await copies.clearFault("hold:blob-has");
    expect(toolResult(await removing)).toMatchObject({
      removed: true,
      bytes: "deleted",
    });
  });
});

describe("marfa_remove_file_copy on a copy the server did not write", () => {
  let kept: { hash: string; bytes: Uint8Array };
  let rewritten: { hash: string; bytes: Uint8Array };
  let foundAdmin: McpConnection;

  beforeAll(async () => {
    kept = await replicated("found and kept");
    rewritten = await replicated("found and written");
    const archive = await (
      await everythingClient(copies)
    ).exportArchive({ files: "false" });
    expect(archive.status).toBe(200);

    // Replication would write over each copy it found, so it waits until the case says.
    found = await bootFreshServer("mcp-file-acts-found", copiesStore);
    await jobsIdle(found);
    await found.setFault(REPLICATION_HELD);
    const restored = await ownerOf(found).restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
    await found.waitForHold(REPLICATION_HELD);
    for (const file of [kept, rewritten]) {
      expect(await kinds(found, file.hash)).toEqual(["s3"]);
      await placeAgain(found, file.bytes);
      expect(await kinds(found, file.hash)).toEqual(["disk", "s3"]);
    }
    ({ connection: foundAdmin } = await admin(found, "found-files", [
      "blobs.manage",
    ]));
  }, FRESH_SERVER_TIMEOUT_MS + 120_000);

  it("removes a copy the server did not write and keeps its bytes in the store", async () => {
    const args = { hash: kept.hash, store_id: s3Id };
    const shown = await call(foundAdmin, REMOVE, args);
    expect(shown).toMatchObject({
      copy: { store_id: s3Id, kind: "s3", written: false },
      other_copies: [{ kind: "disk", written: true }],
      bytes: "kept",
    });
    const removed = await call(foundAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(removed).toMatchObject({ removed: true, bytes: "kept" });
    expect(await kinds(found!, kept.hash)).toEqual(["disk"]);
    expect(
      await call(foundAdmin, REMOVE, { ...args, confirm: shown.confirm }),
    ).toMatchObject({
      removed: true,
      already_done: true,
      recorded: false,
      bytes: "kept",
    });
    // The object stays where the server that wrote it reads it.
    const held = (await inspectStores(copies.controlSocket, kept.hash)).stores;
    expect(held.find((store) => store.kind === "s3")).toMatchObject({
      holds: true,
      intact: true,
    });
  });

  it("refuses a confirmation once the server wrote the copy it did not write at the preview, with a new preview", async () => {
    const args = { hash: rewritten.hash, store_id: s3Id };
    const shown = await call(foundAdmin, REMOVE, args);
    expect(shown).toMatchObject({ copy: { written: false }, bytes: "kept" });

    await found!.clearFault();
    await replicateUntilCaughtUp(
      clientsFor(found!).operator,
      `the server's own copy of ${rewritten.hash}`,
    );
    const refused = await stale(foundAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(refused).toMatchObject({
      copy: { store_id: s3Id, written: true },
      bytes: "deleted",
      confirm: expect.any(String),
    });
    expect(await kinds(found!, rewritten.hash)).toEqual(["disk", "s3"]);
  });
});

describe("marfa_adopt_backup_folder adopts the backup folder", () => {
  it("refuses a preview while the folder holds the store recorded there", async () => {
    await marked();
    const store = await folderStore();
    const refused = toolError(await callTool(backupsAdmin, ADOPT, {}));
    expect(refused.code).toBe("conflict");
    expect(refused.confirm).toBeUndefined();
    expect(markerNow()).toBe(store.id);
  });

  it("adopts nothing without a confirmation, and previews what adopting forgets and clears", async () => {
    await marked();
    const backup = await ownerOf(folder).runBackup();
    expect(backup.status, JSON.stringify(backup.error)).toBe(200);
    const old = await folderStore();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    expect(shown).toMatchObject({
      folder: root,
      files_folder: area(),
      replaces_store_id: old.id,
      forgets: {
        found_backups: [],
        file_copies: expect.any(Number),
        pending_deletions: 0,
        copy_failures: 0,
      },
      last_backup: { name: backup.data.backup.name, at: expect.any(String) },
      clears: expect.any(String),
      files_to_purge: 0,
      leaves: expect.any(String),
      confirm: expect.any(String),
      expires_at: expect.any(String),
    });
    const forgets = shown.forgets as { backups: string[]; file_copies: number };
    expect(forgets.backups).toContain(backup.data.backup.name);
    expect(forgets.file_copies).toBeGreaterThan(0);
    expect(markerNow()).toBeUndefined();
    expect((await folderStore()).id).toBe(old.id);
    expect(await lastBackup()).toBe(backup.data.backup.name);
  });

  it("adopts the folder with the confirmation the preview gave, writes its marker and clears the last backup", async () => {
    await marked();
    const backup = await ownerOf(folder).runBackup();
    expect(backup.status, JSON.stringify(backup.error)).toBe(200);
    const old = await folderStore();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    const forgets = shown.forgets as { backups: string[]; file_copies: number };
    const adopted = await call(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });
    expect(adopted).toMatchObject({
      adopted: true,
      store_id: expect.any(String),
      replaced_store_id: old.id,
      backups_forgotten: forgets.backups.length,
      copies_forgotten: forgets.file_copies,
      folder: root,
      files_folder: area(),
      marked: true,
      folder_changed: false,
    });
    expect(adopted.already_done).toBeUndefined();
    expect(adopted.store_id).not.toBe(old.id);
    expect(markerNow()).toBe(adopted.store_id);
    expect(await folderStore()).toMatchObject({
      id: adopted.store_id,
      locator: area(),
    });
    expect(await lastBackup()).toBeNull();
  });

  it("says the marker was not written when the files folder refuses it, with the error, and marked once it is writable", async () => {
    await marked();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    await folder.setFault("hold:stores-swap");
    const adopting = callTool(backupsAdmin, ADOPT, { confirm: shown.confirm });
    await folder.waitForHold("hold:stores-swap");
    chmodSync(area(), 0o555);
    let adopted: Record<string, unknown>;
    try {
      await folder.clearFault("hold:stores-swap");
      adopted = toolResult(await adopting);
      expect(adopted).toMatchObject({
        adopted: true,
        marked: false,
        marker_error: expect.any(String),
      });
      expect(markerNow()).toBeUndefined();
      expect((await folderStore()).id).toBe(adopted.store_id);
    } finally {
      chmodSync(area(), 0o755);
    }

    const backup = await ownerOf(folder).runBackup();
    expect(backup.status, JSON.stringify(backup.error)).toBe(200);
    const now = await call(backupsAdmin, ADOPT, { confirm: shown.confirm });
    expect(now).toMatchObject({
      already_done: true,
      store_id: adopted.store_id,
      marked: true,
    });
    expect(markerNow()).toBe(adopted.store_id);
  });

  it("says the marker is unknown when the folder does not answer in time, and marked once it has", async () => {
    await marked();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    // The short deadline reaches only the marker: the claim before it may be slow on a busy disk.
    await folder.setFault("hold:stores-swap");
    const adopting = callTool(backupsAdmin, ADOPT, { confirm: shown.confirm });
    await folder.waitForHold("hold:stores-swap");
    await folder.setFault("store-check-deadline=500");
    await folder.setFault("hold:folder-marker");
    await folder.clearFault("hold:stores-swap");
    const adopted = toolResult(await adopting);
    expect(adopted).toMatchObject({ adopted: true, marked: null });
    expect(adopted.folder_changed).toBeUndefined();
    expect(markerNow()).toBeUndefined();

    await folder.clearFault();
    const now = await waitFor("the marker the adopt wrote", async () => {
      const again = await call(backupsAdmin, ADOPT, {
        confirm: shown.confirm,
      });
      return again.marked === true ? again : undefined;
    });
    expect(now).toMatchObject({
      adopted: true,
      already_done: true,
      store_id: adopted.store_id,
    });
    expect(markerNow()).toBe(adopted.store_id);
  });

  it("says the folder changed when an entry appeared in it while the marker was written", async () => {
    await marked();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    await folder.setFault("hold:stores-swap");
    const adopting = callTool(backupsAdmin, ADOPT, { confirm: shown.confirm });
    await folder.waitForHold("hold:stores-swap");
    writeFileSync(join(root, "arrived while adopting.txt"), "a person's file");
    await folder.clearFault("hold:stores-swap");
    const adopted = toolResult(await adopting);
    expect(adopted).toMatchObject({
      adopted: true,
      marked: true,
      folder_changed: true,
    });
    expect(markerNow()).toBe(adopted.store_id);
  });

  it("refuses a confirmation once another folder took the backup folder's path since the preview, with a new preview", async () => {
    await marked();
    const old = await folderStore();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    swapFolder();
    const refused = await stale(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });
    expect(refused).toMatchObject({
      replaces_store_id: old.id,
      confirm: expect.any(String),
    });
    expect(refused.confirm).not.toBe(shown.confirm);
    expect(readdirSync(root)).toEqual([]);
    expect((await folderStore()).id).toBe(old.id);
  });

  it("refuses a confirmation once an entry was added to the folder since the preview", async () => {
    await marked();
    const old = await folderStore();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    writeFileSync(join(root, "notes.txt"), "a person's file");
    const refused = await stale(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });
    expect(refused.confirm).toEqual(expect.any(String));

    mkdirSync(area(), { recursive: true });
    writeFileSync(join(area(), "stray"), "a file in the files folder");
    const again = await stale(backupsAdmin, ADOPT, {
      confirm: refused.confirm,
    });
    expect(again.confirm).toEqual(expect.any(String));

    // A files folder that links to an empty folder elsewhere, which may be another volume.
    rmSync(join(root, "files"), { recursive: true });
    const shownWithout = await call(backupsAdmin, ADOPT, {});
    const elsewhere = join(parent, `elsewhere ${String(swaps)}`);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "files"));
    try {
      const linked = await stale(backupsAdmin, ADOPT, {
        confirm: shownWithout.confirm,
      });
      expect(linked.confirm).toEqual(expect.any(String));
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(join(root, "files"));
    }
    expect(markerNow()).toBeUndefined();
    expect((await folderStore()).id).toBe(old.id);
  });

  it("adopts on a confirmation after the operating system added its own entries to the folder", async () => {
    await marked();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    writeFileSync(join(root, ".DS_Store"), "");
    writeFileSync(join(root, "._notes.txt"), "");
    mkdirSync(join(root, ".Spotlight-V100"));
    mkdirSync(area(), { recursive: true });
    writeFileSync(join(area(), ".DS_Store"), "");
    const adopted = await call(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });
    expect(adopted).toMatchObject({ adopted: true, marked: true });
    expect(markerNow()).toBe(adopted.store_id);
  });

  it("refuses a confirmation once a copy the replaced store records was removed since the preview", async () => {
    await marked();
    // A file no backup names and no item holds, copied to the folder's store.
    const { working, operator } = clientsFor(folder);
    const uploaded = await working.uploadBlob(
      bytesOf("a copy the adopt would forget", SIZE),
      "text/plain",
    );
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const hash = uploaded.data.hash;
    await replicateUntilCaughtUp(operator, `the folder's copy of ${hash}`);
    expect(await kinds(folder, hash)).toEqual(["disk", "folder"]);
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    const forgets = shown.forgets as { file_copies: number };

    // A purge needs the folder it surveys, so the old disk is back for it, then gone again.
    const old = join(parent, `old disk ${String(swaps)}`);
    const replacement = join(parent, `replacement disk ${String(swaps)}`);
    renameSync(root, replacement);
    renameSync(old, root);
    try {
      await runJob(operator, "blob-orphans");
      await runJob(operator, "blob-orphans");
      expect((await operator.listBlobCopies(hash)).status).toBe(404);
    } finally {
      renameSync(root, old);
      renameSync(replacement, root);
    }
    const refused = await stale(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });
    expect(refused).toMatchObject({
      forgets: { file_copies: forgets.file_copies - 1 },
      confirm: expect.any(String),
    });
    expect(markerNow()).toBeUndefined();
  });

  it("counts the files only the forgotten backups keep, and refuses a confirmation once another one is left to them since the preview", async () => {
    await marked();
    const first = await fileItem(folder, `left to a backup ${randomUUID()}`);
    const second = await fileItem(folder, `left later ${randomUUID()}`);
    const backup = await ownerOf(folder).runBackup();
    expect(backup.status, JSON.stringify(backup.error)).toBe(200);
    const everything = await everythingClient(folder);
    const purge = async (id: string): Promise<void> => {
      const trashed = await everything.deleteItem(id);
      expect(trashed.status, JSON.stringify(trashed.error)).toBe(200);
      const purged = await everything.purgeItem(id);
      expect(purged.status, JSON.stringify(purged.error)).toBe(200);
    };
    await purge(first.id);
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    expect(shown.files_to_purge).toBe(1);

    await purge(second.id);
    const refused = await stale(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });
    expect(refused).toMatchObject({
      files_to_purge: 2,
      confirm: expect.any(String),
    });
    expect(markerNow()).toBeUndefined();
  });

  it("counts the deletions queued in the replaced store and the files that failed to copy to it, and refuses a confirmation once a deletion ran since the preview", async () => {
    await marked();
    const store = await folderStore();
    const { operator } = clientsFor(folder);
    const queued = await fileItem(folder, `queued ${randomUUID()}`);
    const failed = await fileItem(folder, `not copied ${randomUUID()}`);
    await replicateUntilCaughtUp(operator, `the folder's copies of both`);
    // The folder's copy of one is removed, then fails to be made again.
    const removed = await operator.deleteBlobCopy(failed.hash, store.id);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    await folder.setFault("fail:backup-folder-write");
    await runJob(operator, "blob-replicate", "either");
    expect(await fired(folder, "fail:backup-folder-write")).toBeGreaterThan(0);
    await folder.clearFault("fail:backup-folder-write");
    expect(await kinds(folder, failed.hash)).toEqual(["disk"]);
    // Last, since a replication run first retries the deletions queued.
    await folder.setFault("fail:blob-delete");
    const dropped = await operator.deleteBlobCopy(queued.hash, store.id);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    expect(await fired(folder, "fail:blob-delete")).toBe(1);
    await folder.clearFault("fail:blob-delete");

    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    expect(shown.forgets, JSON.stringify(shown.forgets)).toMatchObject({
      pending_deletions: 1,
      copy_failures: 1,
    });

    // The deletion needs the folder it was queued in, so the old disk is back for it, then gone again.
    const old = join(parent, `old disk ${String(swaps)}`);
    const replacement = join(parent, `replacement disk ${String(swaps)}`);
    await folder.setFault(REPLICATION_HELD);
    renameSync(root, replacement);
    renameSync(old, root);
    try {
      await runJob(operator, "blob-integrity");
    } finally {
      renameSync(root, old);
      renameSync(replacement, root);
    }
    const refused = await stale(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });
    expect(refused).toMatchObject({
      forgets: { pending_deletions: 0, copy_failures: 1 },
      confirm: expect.any(String),
    });
    expect(markerNow()).toBeUndefined();
  });

  it("refuses a confirmation once another store's marker appeared in the files folder since the preview, without a new preview", async () => {
    await marked();
    const old = await folderStore();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    const foreign = randomUUID();
    mkdirSync(area(), { recursive: true });
    writeFileSync(markerPath(), foreign);
    try {
      const refused = await stale(backupsAdmin, ADOPT, {
        confirm: shown.confirm,
      });
      expect(refused.confirm).toBeUndefined();
      expect(String(refused.message)).toContain(foreign);
      expect(markerNow()).toBe(foreign);
      expect((await folderStore()).id).toBe(old.id);
    } finally {
      rmSync(markerPath());
    }
    // The witness: without the marker, the same confirmation adopts.
    const adopted = await call(backupsAdmin, ADOPT, { confirm: shown.confirm });
    expect(adopted).toMatchObject({ adopted: true, marked: true });
  });

  it("answers the refusal, not a stale confirmation, when a confirmation that no longer holds leaves its claim in the folder", async () => {
    await marked();
    const file = await fileItem(folder, `left by a claim ${randomUUID()}`);
    const backup = await ownerOf(folder).runBackup();
    expect(backup.status, JSON.stringify(backup.error)).toBe(200);
    const old = await folderStore();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    await folder.setFault("hold:stores-record");
    const adopting = callTool(backupsAdmin, ADOPT, { confirm: shown.confirm });
    await folder.waitForHold("hold:stores-record");
    // What the preview showed changes, and the claim cannot be taken out of the folder.
    const everything = await everythingClient(folder);
    const trashed = await everything.deleteItem(file.id);
    expect(trashed.status, JSON.stringify(trashed.error)).toBe(200);
    const purged = await everything.purgeItem(file.id);
    expect(purged.status, JSON.stringify(purged.error)).toBe(200);
    const pending = join(area(), ".marfa-store.pending");
    expect(existsSync(pending)).toBe(true);
    chmodSync(area(), 0o555);
    let refused: Record<string, unknown>;
    try {
      await folder.clearFault("hold:stores-record");
      refused = toolError(await adopting);
    } finally {
      chmodSync(area(), 0o755);
    }
    expect(refused.code).not.toBe("confirmation_stale");
    expect(String(refused.message)).toContain("keeps this adopt's claim");
    expect((await folderStore()).id).toBe(old.id);

    // The witness: once the folder takes the claim back, a new preview adopts.
    const again = await waitFor(
      "a preview once the claim is gone",
      async () => {
        const looked = await callTool(backupsAdmin, ADOPT, {});
        return looked.isError ? undefined : toolResult(looked);
      },
    );
    expect(existsSync(pending)).toBe(false);
    const adopted = await call(backupsAdmin, ADOPT, { confirm: again.confirm });
    expect(adopted).toMatchObject({ adopted: true, marked: true });
  });

  it("answers already done to a call with a confirmation that another call spent while it waited", async () => {
    await marked();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    await folder.setFault("hold:stores-record");
    const first = callTool(backupsAdmin, ADOPT, { confirm: shown.confirm });
    await folder.waitForHold("hold:stores-record");
    await folder.setFault("hold:adopt-confirmed");
    const second = callTool(backupsAdmin, ADOPT, { confirm: shown.confirm });
    await folder.waitForHold("hold:adopt-confirmed");
    await folder.clearFault("hold:stores-record");
    const adopted = toolResult(await first);
    expect(adopted).toMatchObject({ adopted: true, marked: true });
    expect(adopted.already_done).toBeUndefined();

    await folder.clearFault("hold:adopt-confirmed");
    expect(toolResult(await second)).toMatchObject({
      adopted: true,
      already_done: true,
      store_id: adopted.store_id,
      marked: true,
    });
    expect(markerNow()).toBe(adopted.store_id);
  });

  it("changes nothing more on an adopt's confirmation an earlier call used, and reads the folder now", async () => {
    await marked();
    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    const adopted = await call(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });
    expect(adopted.marked).toBe(true);
    const again = () => call(backupsAdmin, ADOPT, { confirm: shown.confirm });
    expect(await again()).toMatchObject({
      adopted: true,
      already_done: true,
      store_id: adopted.store_id,
      marked: true,
    });

    writeFileSync(markerPath(), randomUUID());
    try {
      expect(await again()).toMatchObject({
        store_id: adopted.store_id,
        marked: false,
      });
    } finally {
      writeFileSync(markerPath(), String(adopted.store_id));
    }

    chmodSync(area(), 0o000);
    try {
      expect(await again()).toMatchObject({
        store_id: adopted.store_id,
        marked: null,
      });
    } finally {
      chmodSync(area(), 0o755);
    }
    expect((await folderStore()).id).toBe(adopted.store_id);
  });

  it("records an adopt from the API and from the tool as backup_folder.adopt, of kind settings", async () => {
    await marked();
    await loseTheDisk();
    const fromApi = await backupsRest.adoptBackupFolder();
    expect(fromApi.status, JSON.stringify(fromApi.error)).toBe(200);

    await loseTheDisk();
    const shown = await call(backupsAdmin, ADOPT, {});
    const fromTool = await call(backupsAdmin, ADOPT, {
      confirm: shown.confirm,
    });

    const listed = await clientsFor(folder).operator.listAudit({
      action: "backup_folder.adopt",
      kind: "settings",
    });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    const entries = listed.data.data;
    expect(
      entries.find((entry) => entry.resource_id === fromApi.data.store_id),
    ).toMatchObject({
      resource_type: "store",
      key_id: backupsRestKeyId,
      details: { replaced_store_id: fromApi.data.replaced_store_id },
    });
    expect(
      entries.find((entry) => entry.resource_id === fromTool.store_id),
    ).toMatchObject({
      resource_type: "store",
      key_id: backupsAdminKeyId,
      details: { replaced_store_id: fromApi.data.store_id },
    });
  });
});

describe("a confirmation of a removal or an adopt", () => {
  it("refuses a confirmation another credential got", async () => {
    const { hash } = await replicated("another credential's");
    const args = { hash, store_id: diskId };
    const theirs = await call(otherFilesAdmin, REMOVE, args);
    const refused = await stale(filesAdmin, REMOVE, {
      ...args,
      confirm: theirs.confirm,
    });
    expect(refused.confirm).toBeUndefined();
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);

    await marked();
    const old = await folderStore();
    await loseTheDisk();
    const theirsAdopt = await call(otherBackupsAdmin, ADOPT, {});
    const refusedAdopt = await stale(backupsAdmin, ADOPT, {
      confirm: theirsAdopt.confirm,
    });
    expect(refusedAdopt.confirm).toBeUndefined();
    expect(markerNow()).toBeUndefined();
    expect((await folderStore()).id).toBe(old.id);
  });

  it("refuses a confirmation sent for another file, store or tool", async () => {
    const { hash } = await replicated("named");
    const other = await replicated("not named");
    const shown = await call(copiesBoth, REMOVE, { hash, store_id: diskId });
    for (const args of [
      { hash: other.hash, store_id: diskId },
      { hash, store_id: s3Id },
    ]) {
      const refused = await stale(copiesBoth, REMOVE, {
        ...args,
        confirm: shown.confirm,
      });
      expect(refused.confirm, JSON.stringify(args)).toBeUndefined();
    }
    const crossed = await stale(copiesBoth, ADOPT, { confirm: shown.confirm });
    expect(crossed.confirm).toBeUndefined();
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);
    expect(await kinds(copies, other.hash)).toEqual(["disk", "s3"]);

    await marked();
    const old = await folderStore();
    const named = await fileItem(folder, "a file the adopt does not name");
    await replicateUntilCaughtUp(
      clientsFor(folder).operator,
      `the folder's copy of ${named.hash}`,
    );
    await loseTheDisk();
    const adopting = await call(folderBoth, ADOPT, {});
    const refused = await stale(folderBoth, REMOVE, {
      hash: named.hash,
      store_id: (await folderStore()).id,
      confirm: adopting.confirm,
    });
    expect(refused.confirm).toBeUndefined();
    expect(await kinds(folder, named.hash)).toEqual(["disk", "folder"]);
    expect(markerNow()).toBeUndefined();
    expect((await folderStore()).id).toBe(old.id);
  });

  it("leaves the copy, the folder and the confirmation as they were when the confirmed change fails, and changes them without the fault", async () => {
    const { hash } = await replicated("fails partway");
    const args = { hash, store_id: diskId };
    const shown = await call(filesAdmin, REMOVE, args);
    await copies.setFault("fail:audit=blob.copy_dropped");
    const failed = await callTool(filesAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    // The witness that the fault acted inside the change, before it committed.
    expect(await fired(copies, "fail:audit")).toBe(1);
    expect(failed.isError).toBe(true);
    expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);
    expect(await diskHolds(copies.controlSocket, hash)).toBe(true);
    await copies.clearFault();
    const removed = await call(filesAdmin, REMOVE, {
      ...args,
      confirm: shown.confirm,
    });
    expect(removed).toMatchObject({ removed: true, bytes: "deleted" });
    expect(removed.already_done).toBeUndefined();

    await marked();
    const backup = await ownerOf(folder).runBackup();
    expect(backup.status, JSON.stringify(backup.error)).toBe(200);
    const old = await folderStore();
    await loseTheDisk();
    const adopting = await call(backupsAdmin, ADOPT, {});
    expect((adopting.forgets as { backups: string[] }).backups).toContain(
      backup.data.backup.name,
    );
    await folder.setFault("fail:audit=backup_folder.adopt");
    const failedAdopt = await callTool(backupsAdmin, ADOPT, {
      confirm: adopting.confirm,
    });
    expect(await fired(folder, "fail:audit")).toBe(1);
    expect(failedAdopt.isError).toBe(true);
    expect((await folderStore()).id).toBe(old.id);
    expect(markerNow()).toBeUndefined();
    // The backups and copies it would forget are all still recorded.
    expect((await call(backupsAdmin, ADOPT, {})).forgets).toEqual(
      adopting.forgets,
    );
    expect(await lastBackup()).toBe(backup.data.backup.name);
    await folder.clearFault();
    const adopted = await call(backupsAdmin, ADOPT, {
      confirm: adopting.confirm,
    });
    expect(adopted).toMatchObject({
      adopted: true,
      replaced_store_id: old.id,
      marked: true,
    });
    expect(adopted.already_done).toBeUndefined();
  });

  // The clock moved forward stays moved, which a retry would start from.
  it(
    "refuses a confirmation once five minutes have passed since the preview",
    { retry: 0 },
    async () => {
      const { hash } = await replicated("expired");
      const args = { hash, store_id: diskId };
      const removing = await call(filesAdmin, REMOVE, args);
      await marked();
      const old = await folderStore();
      await loseTheDisk();
      const adopting = await call(backupsAdmin, ADOPT, {});

      await copies.setFault("hold:blob-has");
      await copies.advanceClock(CONFIRMATION_LIFE_MS + 1_000);
      await folder.advanceClock(CONFIRMATION_LIFE_MS + 1_000);
      const refused = await stale(filesAdmin, REMOVE, {
        ...args,
        confirm: removing.confirm,
      });
      expect(refused.confirm).toBeUndefined();
      expect(await waiting(copies, "hold:blob-has")).toBe(0);
      const refusedAdopt = await stale(backupsAdmin, ADOPT, {
        confirm: adopting.confirm,
      });
      expect(refusedAdopt.confirm).toBeUndefined();

      expect(await kinds(copies, hash)).toEqual(["disk", "s3"]);
      expect(markerNow()).toBeUndefined();
      expect((await folderStore()).id).toBe(old.id);
    },
  );
});
