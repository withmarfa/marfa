import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { TestContext } from "../../client/types.js";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  createTestContext,
  cleanup,
  trackFolder,
  trackItem,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * A working copy reads a folder's settings, answers its search, and writes
 * its settings through the folder door (`device/folder-system-tier` to `device/folder-write-accepted`), against the
 * real server and the real binary.
 */

const FOLDER_TYPE = "system.folder";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let typeId: string;
let device: CliDevice;
const stores: string[] = [];
const ids = new Map<string, string>();
let tagged: string;

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

function refused<T>(result: Outcome<T>): { code: string; raw: string } {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) throw new Error("answered");
  return result.refusal;
}

function id(key: string): string {
  const found = ids.get(key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}

function copy(name: string, url = apiUrl): CliDevice {
  const store = newStore(`folder-settings-${name}`);
  stores.push(store);
  return new CliDevice({ binary: requireBinary(), store, url, key: apiKey });
}

async function serverFolder(settings: Record<string, unknown>) {
  const created = await client.createFolder(settings);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  trackFolder(ctx, created.data.item.id);
  return created.data.item.id;
}

beforeAll(async () => {
  const context = await createTestContext("device", "folder-settings-live");
  ({ client, ctx, apiUrl, apiKey } = context);
  typeId = `user.shelf-${ctx.runId}`;
  tagged = `shelved-${ctx.runId}`;
  const registered = await client.registerType({
    id: typeId,
    fields: { title: { type: "string" } },
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  for (const [key, tier, tags, archived] of [
    ["active", "library", [tagged], false],
    ["archived", "library", [tagged], true],
    ["untagged", "library", [], false],
    ["feed", "feed", [tagged], false],
  ] as const) {
    const created = await client.createItem({
      type: typeId,
      source: ctx.source,
      tier,
      properties: { title: `${key} marmalade` },
      tags: [...tags],
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    trackItem(ctx, created.data.item.id);
    ids.set(key, created.data.item.id);
    if (archived) {
      const moved = await client.transitionItem(
        created.data.item.id,
        "archived",
      );
      expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    }
  }
  ids.set(
    "shelf",
    await serverFolder({
      title: `Shelf ${ctx.runId}`,
      search: { types: [typeId], filter: `tags contains "${tagged}"` },
    }),
  );
  device = copy("library");
  value(await device.hydrate([typeId, FOLDER_TYPE], "library"));
});

afterAll(async () => {
  for (const store of stores)
    rmSync(dirname(store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

describe("a copy reads a folder's settings and answers its search", () => {
  it("holds the folders a slice names, at either tier", async () => {
    const held = value(await device.folder(id("shelf")));
    expect(held.state).toBe("active");
    expect(held.settings.title).toBe(`Shelf ${ctx.runId}`);
    expect(held.settings).toMatchObject({ search: { types: [typeId] } });

    const feed = copy("feed");
    value(await feed.hydrate([typeId, FOLDER_TYPE], "feed"));
    expect(value(await feed.folder(id("shelf"))).id).toBe(id("shelf"));
    // The witness: the feed copy holds the type's feed row and not its
    // library rows, so the tier still narrows every other type.
    const rows = value(await feed.list({ type: typeId, allStates: true }));
    expect(rows.map((row) => row.id)).toEqual([id("feed")]);
  });

  it("lists and searches in a folder what the folder's search holds", async () => {
    const listed = value(await device.listInFolder(id("shelf")));
    expect(listed.map((row) => row.id).sort()).toEqual(
      [id("active"), id("archived")].sort(),
    );
    const served = await client.listItems({
      type: typeId,
      state: "any",
      filter: `tags contains "${tagged}"`,
      tier: "library",
    });
    expect(served.ok, JSON.stringify(served.error)).toBe(true);
    expect(
      served.data.data
        .filter((row) => ["active", "archived"].includes(row.state))
        .map((row) => row.id)
        .sort(),
    ).toEqual(listed.map((row) => row.id).sort());
    const hits = value(await device.searchInFolder("marmalade", id("shelf")));
    expect(hits.map((hit) => hit.item.id).sort()).toEqual(
      [id("active"), id("archived")].sort(),
    );
    const page = value(await device.listInFolder(id("shelf"), { limit: 1 }));
    expect(page).toHaveLength(1);
  });

  it("refuses a folder search its slice cannot answer whole, and a folder it does not hold", async () => {
    const wide = await serverFolder({
      title: `Wide ${ctx.runId}`,
      search: { types: [typeId, "core.task"] },
    });
    const feedTier = await serverFolder({
      title: `Feed ${ctx.runId}`,
      search: { types: [typeId], tier: "feed" },
    });
    const beneath = await serverFolder({
      title: `Beneath ${ctx.runId}`,
      search: { types: [typeId], beneath: id("active") },
    });
    value(await device.catchUp());
    for (const [folder, names] of [
      [wide, "core.task"],
      [feedTier, "feed"],
      [beneath, "parent-of"],
    ] as const) {
      const listed = refused(await device.listInFolder(folder));
      expect(listed.code, listed.raw).toBe("invalid");
      expect(listed.raw).toContain(names);
      const searched = refused(
        await device.searchInFolder("marmalade", folder),
      );
      expect(searched.code, searched.raw).toBe("invalid");
    }
    const absent = refused(await device.listInFolder(id("active")));
    expect(absent.code, absent.raw).toBe("invalid");
    expect(absent.raw).toContain(FOLDER_TYPE);

    const unheld = copy("unheld");
    value(await unheld.hydrate([typeId], "library"));
    const notHeld = refused(await unheld.listInFolder(id("shelf")));
    expect(notHeld.code, notHeld.raw).toBe("not_found");
    expect(notHeld.raw).toContain("not_held");
    const notHeldSearch = refused(
      await unheld.searchInFolder("marmalade", id("shelf")),
    );
    expect(notHeldSearch.code, notHeldSearch.raw).toBe("not_found");
    expect(notHeldSearch.raw).toContain("not_held");

    const parents = copy("parents");
    value(
      await parents.hydrate([typeId, FOLDER_TYPE], "library", {
        edgeTypes: ["parent-of"],
      }),
    );
    expect(
      value(await parents.listInFolder(beneath)).map((row) => row.id),
    ).toEqual([id("active")]);
  });
});

describe("a copy writes a folder's settings through the folder door", () => {
  it("creates, changes and revokes at once, holding the answer and queueing nothing", async () => {
    const created = value(
      await device.createFolder({
        title: `Made ${ctx.runId}`,
        search: { types: [typeId], filter: `tags contains "${tagged}"` },
      }),
    );
    trackFolder(ctx, created.id);
    expect([created.version, created.state]).toEqual([1, "active"]);
    expect(value(await device.folder(created.id)).version).toBe(1);
    expect(value(await device.listInFolder(created.id))).toHaveLength(2);

    const changed = value(
      await device.changeFolder(
        created.id,
        { title: `Renamed ${ctx.runId}` },
        1,
      ),
    );
    expect(changed.version).toBe(2);
    expect(value(await device.folder(created.id)).settings.title).toBe(
      `Renamed ${ctx.runId}`,
    );

    const revoked = value(await device.revokeFolder(created.id));
    expect(revoked.state).toBe("revoked");
    expect(value(await device.folder(created.id)).state).toBe("revoked");
    const after = refused(
      await device.changeFolder(created.id, { title: "Again" }, 2),
    );
    expect(after.code, after.raw).toBe("validation");
    expect(after.raw).toContain("invalid_transition");
    const gone = refused(await device.listInFolder(created.id));
    expect(gone.code, gone.raw).toBe("invalid");
    expect(gone.raw).toContain("revoked");
    const goneSearch = refused(
      await device.searchInFolder("marmalade", created.id),
    );
    expect(goneSearch.code, goneSearch.raw).toBe("invalid");

    expect(value(await device.queue())).toEqual([]);
    const read = await client.getItem(created.id);
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    expect(read.data.item.state).toBe("revoked");
  });

  it("refuses settings no folder follows before anything is sent, and fails offline with nothing kept", async () => {
    const title = `Backref ${ctx.runId}`;
    const backref = refused(
      await device.createFolder({
        title,
        search: { filter: "backref[parent-of] exists" },
      }),
    );
    expect(backref.code, backref.raw).toBe("invalid");
    const listed = await client.listItems({
      type: FOLDER_TYPE,
      filter: `properties.title eq "${title}"`,
    });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.data.data).toEqual([]);
    // The witness: the server takes the same settings from its own door,
    // and the copy reads, and revokes, a folder it could not have made.
    const served = await serverFolder({
      title,
      search: { filter: "backref[parent-of] exists" },
    });
    value(await device.catchUp());
    expect(value(await device.folder(served)).settings.title).toBe(title);
    const unanswered = refused(await device.listInFolder(served));
    expect(unanswered.code, unanswered.raw).toBe("invalid");
    expect(unanswered.raw).toContain("backref");
    expect(value(await device.revokeFolder(served)).state).toBe("revoked");

    const offline = copy("offline", "http://127.0.0.1:9");
    value(await offline.status());
    const unsent = refused(
      await offline.createFolder({ title: `Offline ${ctx.runId}` }),
    );
    expect(unsent.code, unsent.raw).toBe("network");
    expect(value(await offline.queue())).toEqual([]);
  });

  it("refuses settings the server would refuse, or defaults its search would not hold, before anything is sent", async () => {
    const title = `Refused ${ctx.runId}`;
    for (const [settings, code] of [
      [
        { title, search: { types: [typeId], filter: "title eq" } },
        "validation",
      ],
      [
        { title, search: { types: [typeId] }, defaults: { tags: [""] } },
        "validation",
      ],
      [
        { title, search: { types: [typeId] }, defaults: { type: "core.task" } },
        "invalid",
      ],
      [
        { title, search: { types: [typeId] }, defaults: { tier: "feed" } },
        "invalid",
      ],
    ] as const) {
      const outcome = refused(await device.createFolder(settings));
      expect(outcome.code, `${JSON.stringify(settings)}: ${outcome.raw}`).toBe(
        code,
      );
    }
    const listed = await client.listItems({
      type: FOLDER_TYPE,
      filter: `properties.title eq "${title}"`,
    });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.data.data, "a refused folder reached the server").toEqual([]);

    // A change is held to the settings it leaves: alone, a default type
    // is held by a search of every type, and the shelf searches one other.
    const before = await client.getItem(id("shelf"));
    expect(before.ok, JSON.stringify(before.error)).toBe(true);
    const change = refused(
      await device.changeFolder(
        id("shelf"),
        { defaults: { type: "core.task" } },
        before.data.item.version,
      ),
    );
    expect(change.code, change.raw).toBe("invalid");
    const after = await client.getItem(id("shelf"));
    expect(after.ok && after.data.item.version).toBe(before.data.item.version);
  });
});
