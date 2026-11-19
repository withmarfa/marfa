import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { instanceIdOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { bytesOf, clientsFor, runJob } from "../../utils/own-blob-server.js";
import { tempFolder } from "../../utils/temp-folder.js";

// A separate server keeps object-store settings from overriding the backup folder.
const parent = tempFolder("marfa-store-follows-");
let server: FreshServer | undefined;
let instance: string;

beforeAll(async () => {
  server = await bootFreshServer("store-follows-settings", {
    MARFA_OBJECT_STORE_BUCKET: "",
    MARFA_BLOB_CLEANUP_GRACE_SECONDS: "0",
  });
  instance = await instanceIdOf(server);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function folder(name: string): string {
  const path = join(parent, `${name}-${randomUUID()}`);
  mkdirSync(path);
  return path;
}

/** The locator `GET /blobs/stores` gives the files area of a backup folder. */
function filesOf(path: string): string {
  return join(path, "files", instance);
}

/** The locators of the stores beside the disk, and of those attached. */
async function stores(): Promise<{ attached: string[]; recorded: string[] }> {
  const { operator } = clientsFor(server!);
  const listed = await operator.listBlobStores();
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  const beside = listed.data.data.filter((store) => store.kind !== "disk");
  return {
    attached: beside
      .filter((store) => store.detached_at === null)
      .map((store) => store.locator),
    recorded: beside.map((store) => store.locator),
  };
}

async function name(path: string): Promise<void> {
  const set = await clientsFor(server!).local.patchConfig({
    backup_path: path,
  });
  expect(set.status, JSON.stringify(set.error)).toBe(200);
}

it("lists only the folder the last write to /config names once blob-replicate runs, when the attach an earlier write started ends after it", async () => {
  const { operator } = clientsFor(server!);
  const first = folder("first");
  const passed = folder("passed");
  await name(first);
  await runJob(operator, "blob-replicate", "either");
  expect((await stores()).attached).toEqual([filesOf(first)]);

  await server!.setFault("hold:stores-record");
  try {
    await name(passed);
    await server!.waitForHold("hold:stores-record");
    await name(first);
  } finally {
    await server!.clearFault("hold:stores-record");
  }
  await runJob(operator, "blob-replicate");
  const settled = await stores();
  expect(settled.attached).toEqual([filesOf(first)]);
  expect(settled.recorded).not.toContain(filesOf(passed));

  // The witness that the passed folder can be attached: named alone, it is.
  await name(passed);
  await runJob(operator, "blob-replicate");
  expect((await stores()).attached).toEqual([filesOf(passed)]);
});

/** Returns once the fault has fired. */
async function firedOnce(fault: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const armed = (await server!.faults()).find((one) => one.name === fault);
    if ((armed?.fired ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${fault} did not fire`);
}

it("ends blob-replicate as failed while the record of the folder the last write to /config names cannot be written, and lists that folder once it can", async () => {
  const { operator } = clientsFor(server!);
  const first = folder("first");
  const named = folder("named");
  await name(first);
  await runJob(operator, "blob-replicate");
  expect((await stores()).attached).toEqual([filesOf(first)]);

  try {
    // Each follow needs its own fault because the fault fires only once.
    await server!.setFault("fail:stores-record");
    await name(named);
    await firedOnce("fail:stores-record");
    await server!.setFault("fail:stores-record");
    const failed = await runJob(operator, "blob-replicate", "failed");
    expect(failed.error).toEqual(expect.any(String));
    expect((await stores()).attached).toEqual([filesOf(first)]);
  } finally {
    await server!.clearFault("fail:stores-record");
  }

  // The witness that the run fails only while the record cannot be written.
  await runJob(operator, "blob-replicate");
  expect((await stores()).attached).toEqual([filesOf(named)]);
});

it("ends blob-replicate as failed while the settings cannot be read again after a write to /config of unknown outcome, and as succeeded once they can", async () => {
  const { operator } = clientsFor(server!);
  await name(folder("reloaded"));
  // The witness that a run succeeds before the write.
  await runJob(operator, "blob-replicate");

  try {
    await server!.setFault("fail:commit=config.update");
    await server!.setFault("fail:settings-reload");
    const unknown = await operator.patchConfig({
      backup_interval_seconds: 3600,
    });
    expect(unknown.status, JSON.stringify(unknown.error)).toBe(500);
    await firedOnce("fail:settings-reload");
    await server!.clearFault("fail:commit");
    // Each run's reload needs its own fault because the fault fires only once.
    await server!.setFault("fail:settings-reload");
    const failed = await runJob(operator, "blob-replicate", "failed");
    expect(failed.error).toEqual(expect.any(String));
  } finally {
    await server!.clearFault("fail:settings-reload");
    await server!.clearFault("fail:commit");
  }

  await runJob(operator, "blob-replicate");
});

/** Uploads a file nothing names and has `blob-orphans` report it, as the only one reported. */
async function reportedOrphan(): Promise<string> {
  const { operator, working } = clientsFor(server!);
  // A run purges only what an earlier run reported, so two clear what a failed try left.
  await runJob(operator, "blob-orphans");
  await runJob(operator, "blob-orphans");
  const upload = await working.uploadBlob(
    bytesOf(randomUUID(), 100),
    "text/plain",
  );
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  const reported = await runJob(operator, "blob-orphans");
  expect(reported.result).toMatchObject({ purged: 0 });
  return upload.data.hash;
}

it("purges nothing while the record of the folder in use cannot be written, and purges the same file once it can", async () => {
  const { operator } = clientsFor(server!);
  const first = folder("first");
  await name(first);
  await runJob(operator, "blob-replicate");
  const hash = await reportedOrphan();

  try {
    // The record then names another folder while the first stays named and in use.
    await server!.setFault("fail:stores-record-lost");
    await name(folder("passed"));
    await firedOnce("fail:stores-record-lost");
    await server!.setFault("fail:stores-record");
    await name(first);
    await firedOnce("fail:stores-record");
    // The fault fires only once, and the run tries the record again.
    await server!.setFault("fail:stores-record");
    const held = await runJob(operator, "blob-orphans");
    expect(held.result).toMatchObject({ purged: 0 });
    expect((await operator.downloadBlob(hash)).status).toBe(200);
  } finally {
    await server!.clearFault("fail:stores-record");
    await server!.clearFault("fail:stores-record-lost");
  }

  // The witness: the same run purges the file once the record can be written.
  const purged = await runJob(operator, "blob-orphans");
  expect(purged.result).toMatchObject({ purged: 1 });
  expect((await operator.downloadBlob(hash)).status).toBe(404);
  expect((await stores()).attached).toEqual([filesOf(first)]);
});

it("purges nothing while the settings cannot be read again after a write to /config of unknown outcome, and purges the same file once they can", async () => {
  const { operator } = clientsFor(server!);
  await name(folder("reloaded"));
  await runJob(operator, "blob-replicate");
  const hash = await reportedOrphan();

  try {
    await server!.setFault("fail:commit=config.update");
    await server!.setFault("fail:settings-reload");
    const unknown = await operator.patchConfig({
      backup_interval_seconds: 3600,
    });
    expect(unknown.status, JSON.stringify(unknown.error)).toBe(500);
    await firedOnce("fail:settings-reload");
    await server!.clearFault("fail:commit");
    // The fault fires only once, and the run reads the settings again.
    await server!.setFault("fail:settings-reload");
    const held = await runJob(operator, "blob-orphans");
    expect(held.result).toMatchObject({ purged: 0 });
    expect((await operator.downloadBlob(hash)).status).toBe(200);
  } finally {
    await server!.clearFault("fail:settings-reload");
    await server!.clearFault("fail:commit");
  }

  // The witness: the same run purges the file once the settings read.
  const purged = await runJob(operator, "blob-orphans");
  expect(purged.result).toMatchObject({ purged: 1 });
  expect((await operator.downloadBlob(hash)).status).toBe(404);
});
