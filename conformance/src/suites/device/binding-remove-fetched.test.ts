import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BindingDevice } from "../../device/binding-adapter.js";
import { wireEdge, type WireItemOptions } from "../../device/marfa-answers.js";
import {
  KEY,
  hashOf,
  requireModule,
  scriptBlob,
  scriptHydration,
  startBindingHarness,
  type BindingHarness,
} from "./harness.js";

/**
 * "An app can remove downloaded files without changing the file budget."
 *
 * Removing fetched files through the Node module: every file a trim to a
 * budget of nothing would take goes, and the setting the person chose stays,
 * whatever else happens to the handle while it runs.
 */

let harness: BindingHarness | undefined;
const reopened: BindingDevice[] = [];

afterEach(async () => {
  for (const device of reopened.splice(0)) await device.close();
  await harness?.stop();
  harness = undefined;
});

interface Budget {
  kind: string;
  bytes?: number;
}

interface Cache {
  setting: Budget;
  held?: number;
}

const ATTACHED = Buffer.from("the bytes of a file attached to a note");
const FETCHED = Buffer.from("the bytes of a file fetched once");
const UNSENT = Buffer.from("the bytes of an upload the server has not taken");

function heldAt(store: string, bytes: Buffer): string {
  return `${store}.blobs/${hashOf(bytes).slice("sha256:".length)}`;
}

/**
 * A device holding the bytes of an attachment, of a file it fetched and of
 * an upload it has queued, under the budget to keep every file.
 */
async function holdingThree(label: string): Promise<BindingHarness> {
  const started = await startBindingHarness(label);
  harness = started;
  const { server, device } = started;
  const photo: WireItemOptions = {
    id: "photo",
    type: "core.file",
    properties: {
      title: "photo.bin",
      blob_ref: hashOf(ATTACHED),
      mime_type: "application/octet-stream",
      size_bytes: ATTACHED.length,
    },
    edges: {
      "attached-to": {
        data: [
          wireEdge({
            id: "photo-on-note",
            source_id: "photo",
            target_id: "note",
            edge_type: "attached-to",
          }),
        ],
        next_cursor: null,
      },
    },
  };
  scriptHydration(server, {
    head: "10",
    rows: {
      "core.note": [
        {
          item: {
            id: "note",
            type: "core.note",
            properties: { title: "note" },
          },
        },
      ],
      "core.file": [{ item: photo }],
    },
  });
  scriptBlob(server, ATTACHED);
  scriptBlob(server, FETCHED);
  const hydrated = await device.hydrate(["core.note", "core.file"], "library");
  expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
  const kept = await device.call("setFileBudget", { kind: "keep_all" });
  expect(kept.ok, JSON.stringify(kept)).toBe(true);
  const fetchedKept = await device.call("fetchKept");
  expect(fetchedKept.ok, JSON.stringify(fetchedKept)).toBe(true);
  const fetched = await device.call("blob", hashOf(FETCHED));
  expect(fetched.ok, JSON.stringify(fetched)).toBe(true);
  const source = join(mkdtempSync(join(tmpdir(), "marfa-remove-")), "unsent");
  writeFileSync(source, UNSENT);
  const queued = await device.call("putBlob", source, "text/plain");
  expect(queued.ok, JSON.stringify(queued)).toBe(true);
  // The witness: the cache holds all three before the removal.
  for (const bytes of [ATTACHED, FETCHED, UNSENT]) {
    expect(existsSync(heldAt(device.store, bytes))).toBe(true);
  }
  return started;
}

async function cacheOf(device: BindingDevice): Promise<Cache> {
  const cache = await device.call<Cache>("fileCache");
  if (!cache.ok) throw new Error(JSON.stringify(cache));
  return cache.value;
}

describe("removing fetched files", () => {
  it("takes the files a trim to nothing would take, answers their bytes and leaves the budget", async () => {
    const { device } = await holdingThree("remove-fetched");

    const removed = await device.call<number>("removeFetchedFiles");
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(removed.ok && removed.value).toBe(FETCHED.length);
    expect(existsSync(heldAt(device.store, FETCHED))).toBe(false);
    expect(
      existsSync(heldAt(device.store, ATTACHED)),
      "the bytes of an attachment were removed",
    ).toBe(true);
    expect(
      existsSync(heldAt(device.store, UNSENT)),
      "the only copy of an unsent upload was removed",
    ).toBe(true);
    expect((await cacheOf(device)).setting).toEqual({ kind: "keep_all" });
  });

  it("leaves the budget and the store sound when the handle closes as it runs", async () => {
    const { server, device } = await holdingThree("remove-fetched-close");

    const removing = device.call<number>("removeFetchedFiles");
    await device.close();
    // The close may come before the removal answers or after it; either
    // way, the store opened again is the same.
    await removing.then(
      () => undefined,
      () => undefined,
    );
    const again = await BindingDevice.start({
      module: requireModule(),
      store: device.store,
      url: server.url,
      key: KEY,
    });
    reopened.push(again);
    const cache = await cacheOf(again);
    expect(
      cache.setting,
      "the budget was changed by a removal the close interrupted",
    ).toEqual({ kind: "keep_all" });
    expect(existsSync(heldAt(again.store, ATTACHED))).toBe(true);
    expect(existsSync(heldAt(again.store, UNSENT))).toBe(true);
    const queue = await again.queue();
    expect(queue.ok && queue.value.length).toBe(1);
    const removed = await again.call<number>("removeFetchedFiles");
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(existsSync(heldAt(again.store, FETCHED))).toBe(false);
    expect((await cacheOf(again)).held).toBe(ATTACHED.length + UNSENT.length);
  });

  it("takes nothing from a cache it cannot read", async () => {
    const { device } = await holdingThree("remove-fetched-unreadable");
    const folder = `${device.store}.blobs`;
    chmodSync(folder, 0o000);
    let removed;
    try {
      removed = await device.call<number>("removeFetchedFiles");
    } finally {
      chmodSync(folder, 0o755);
    }
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(removed.ok && removed.value).toBe(0);
    expect(
      existsSync(heldAt(device.store, FETCHED)),
      "a removal took bytes from a cache it could not read",
    ).toBe(true);
    // The witness: once the folder can be read, the same call takes them.
    const again = await device.call<number>("removeFetchedFiles");
    expect(again.ok && again.value).toBe(FETCHED.length);
  });
});
