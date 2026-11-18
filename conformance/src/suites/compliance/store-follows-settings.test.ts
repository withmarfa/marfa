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
import { clientsFor, runJob } from "../../utils/own-blob-server.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * Which store beside the disk the server ends up with when the settings
 * change while it attaches the store an earlier write named, on a server of
 * the fixture's own with no object store, so `backup_path` can name each
 * folder in turn. `hold:stores-record` holds the attach after it has taken
 * the folder and before the stores record names it. A run of
 * `blob-replicate` begins by bringing the stores in use to the settings, so
 * the listing read after it is the one the settings leave.
 */
const parent = tempFolder("marfa-store-follows-");
let server: FreshServer | undefined;
let instance: string;

beforeAll(async () => {
  server = await bootFreshServer("store-follows-settings", {
    MARFA_OBJECT_STORE_BUCKET: "",
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
  const set = await clientsFor(server!).operator.patchConfig({
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
  await runJob(operator, "blob-replicate", "either");
  const settled = await stores();
  expect(settled.attached).toEqual([filesOf(first)]);
  expect(settled.recorded).not.toContain(filesOf(passed));

  // The witness that the passed folder can be attached: named alone, it is.
  await name(passed);
  await runJob(operator, "blob-replicate", "either");
  expect((await stores()).attached).toEqual([filesOf(passed)]);
});
