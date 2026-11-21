import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem } from "../../client/types.js";
import { localFetch } from "../../utils/control-request.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * An `app.*` item is hidden from every read that leaves out `system.*`, and
 * its app still writes it through the item doors. Each absence is held beside
 * a `user.*` item written the same way, which the same read finds.
 */

const HIDDEN = "app.acme.setting";
const SHOWN = "user.hidden_witness";
const WORD = "zanzibar";

let server: FreshServer;
let owner: MarfaClient;
let app: MarfaClient;
const hiddenIds: string[] = [];
const shownIds: string[] = [];

async function write(
  as: MarfaClient,
  type: string,
  tier: "library" | "feed",
): Promise<string> {
  const made = await as.createItem({
    type,
    tier,
    properties: { name: `${WORD} ${tier}` },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

function idsOf(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id);
}

beforeAll(async () => {
  server = await bootFreshServer("hidden-types");
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  for (const id of [HIDDEN, SHOWN]) {
    const registered = await owner.registerType({
      id,
      fields: { name: { type: "string" } },
      display_hints: { title_field: "name" },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  }
  const approved = await approvedApp(server, [
    `${HIDDEN}:write`,
    `${HIDDEN}:read`,
  ]);
  app = new MarfaClient({ baseUrl: server.apiUrl, apiKey: approved.token });
  for (const tier of ["library", "feed"] as const) {
    hiddenIds.push(await write(app, HIDDEN, tier));
    shownIds.push(await write(owner, SHOWN, tier));
  }
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("hidden app types", () => {
  it("leaves an app item out of a listing, in either tier, unless the listing asks for hidden items", async () => {
    const plain = await owner.rawRequest<{ data: MarfaItem[] }>(
      "/items?tier=all&limit=200",
    );
    expect(plain.status, JSON.stringify(plain.error)).toBe(200);
    const shown = idsOf(plain.data.data);
    for (const id of shownIds)
      expect(shown, "the witness is listed").toContain(id);
    for (const id of hiddenIds) expect(shown).not.toContain(id);

    const asked = await owner.rawRequest<{ data: MarfaItem[] }>(
      "/items?tier=all&limit=200&include=hidden",
    );
    expect(asked.status, JSON.stringify(asked.error)).toBe(200);
    const all = idsOf(asked.data.data);
    for (const id of [...shownIds, ...hiddenIds]) expect(all).toContain(id);

    const named = await owner.rawRequest<{ data: MarfaItem[] }>(
      `/items?tier=all&limit=200&type=${HIDDEN}`,
    );
    expect(named.status, JSON.stringify(named.error)).toBe(200);
    const byType = idsOf(named.data.data);
    for (const id of hiddenIds) expect(byType).toContain(id);

    const feed = await owner.rawRequest<{ data: MarfaItem[] }>(
      "/items?tier=feed&limit=200",
    );
    expect(idsOf(feed.data.data)).toContain(shownIds[1]);
    expect(idsOf(feed.data.data)).not.toContain(hiddenIds[1]);
  });

  it("leaves an app item out of a search unless the search asks for hidden items", async () => {
    const plain = await owner.rawRequest<{ data: { item: MarfaItem }[] }>(
      `/search?q=${WORD}&tier=all`,
    );
    expect(plain.status, JSON.stringify(plain.error)).toBe(200);
    const found = plain.data.data.map((row) => row.item.id);
    for (const id of shownIds)
      expect(found, "the witness is found").toContain(id);
    for (const id of hiddenIds) expect(found).not.toContain(id);

    const asked = await owner.rawRequest<{ data: { item: MarfaItem }[] }>(
      `/search?q=${WORD}&tier=all&include=hidden`,
    );
    expect(asked.status, JSON.stringify(asked.error)).toBe(200);
    const all = asked.data.data.map((row) => row.item.id);
    for (const id of hiddenIds) expect(all).toContain(id);
  });

  it("leaves an app item out of the counts unless they ask for hidden items", async () => {
    const plain = await owner.rawRequest<Record<string, number>>(
      "/items/stats?by=type&tier=all",
    );
    expect(plain.status, JSON.stringify(plain.error)).toBe(200);
    expect(plain.data[SHOWN]).toBe(2);
    expect(plain.data).not.toHaveProperty(HIDDEN);

    const asked = await owner.rawRequest<Record<string, number>>(
      "/items/stats?by=type&tier=all&include=hidden",
    );
    expect(asked.data[HIDDEN]).toBe(2);
  });

  it("leaves an app item out of a view, and its type out of the overview", async () => {
    const view = await owner.createView({ title: "everything" });
    expect(view.status, JSON.stringify(view.error)).toBe(201);
    const listed = await owner.listViewItems(view.data.item.id, {
      limit: 200,
    });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    const inView = idsOf(listed.data.data);
    expect(inView, "the witness is in the view").toContain(shownIds[0]);
    for (const id of hiddenIds) expect(inView).not.toContain(id);

    const overview = await owner.rawRequest<{
      types?: { id: string }[];
    }>("/overview");
    expect(overview.status, JSON.stringify(overview.error)).toBe(200);
    const types = (overview.data.types ?? []).map((type) => type.id);
    expect(types, "the witness type is counted").toContain(SHOWN);
    expect(types).not.toContain(HIDDEN);
  });

  it("leaves an app item out of a bulk read, a lookup and a title search unless the read asks for hidden items", async () => {
    const ids = [...shownIds, ...hiddenIds];
    const plain = await owner.bulkGet(ids);
    expect(plain.status, JSON.stringify(plain.error)).toBe(200);
    const read = idsOf(plain.data.data);
    for (const id of shownIds)
      expect(read, "the witness is read").toContain(id);
    for (const id of hiddenIds) expect(read).not.toContain(id);

    const asked = await owner.bulkGet(ids, ["hidden"]);
    expect(idsOf(asked.data.data).sort()).toEqual([...ids].sort());

    const looked = await owner.lookupItems({
      type: SHOWN,
      ids: [shownIds[0]!],
    });
    expect(looked.status, JSON.stringify(looked.error)).toBe(200);
    expect(idsOf(looked.data.data), "the witness is looked up").toEqual([
      shownIds[0],
    ]);
    const hidden = await owner.lookupItems({
      type: HIDDEN,
      ids: [hiddenIds[0]!],
    });
    expect(hidden.status, JSON.stringify(hidden.error)).toBe(200);
    expect(hidden.data.data).toEqual([]);

    const titled = await owner.findItemsByTitle([`${WORD} library`]);
    expect(titled.status, JSON.stringify(titled.error)).toBe(200);
    const named = titled.data.data.flatMap((entry) => idsOf(entry.items));
    expect(named, "the witness is titled").toContain(shownIds[0]);
    expect(named).not.toContain(hiddenIds[0]);
  });

  it("refuses a folder or a view that names an app type, and takes one that names a user type", async () => {
    const folder = await owner.createFolder({
      title: "visible",
      query: { types: [SHOWN] },
    });
    expect(folder.status, JSON.stringify(folder.error)).toBe(201);
    const view = await owner.createView({
      title: "visible",
      query: { types: [SHOWN] },
    });
    expect(view.status, JSON.stringify(view.error)).toBe(201);

    const refusedFolder = await owner.createFolder({
      title: "hidden",
      query: { types: [HIDDEN] },
    });
    expect(refusedFolder.status).toBe(400);
    expect(refusedFolder.error?.error.code).toBe("validation_error");
    const refusedView = await owner.createView({
      title: "hidden",
      query: { types: [HIDDEN] },
    });
    expect(refusedView.status).toBe(400);
    expect(refusedView.error?.error.code).toBe("validation_error");
  });

  it("still lets the app write, read and change its own hidden item through the item doors", async () => {
    const id = await write(app, HIDDEN, "library");
    const read = await app.getItem(id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    const changed = await app.updateItem(id, {
      version: read.data.item.version,
      properties: { name: "changed" },
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    expect(changed.data.item.properties.name).toBe("changed");
    const gone = await app.deleteItem(id);
    expect(gone.status, JSON.stringify(gone.error)).toBe(200);
  });

  it("lists an app item in the bin, and restores and purges it, as it does any item the type map reaches", async () => {
    const made: string[] = [];
    for (const [as, type] of [
      [app, HIDDEN],
      [owner, SHOWN],
    ] as const) {
      const id = await write(as, type, "library");
      expect((await as.deleteItem(id)).status).toBe(200);
      made.push(id);
    }
    const [hiddenId, shownId] = made as [string, string];
    const owned = (path: string, init: RequestInit = {}) =>
      localFetch(server.controlSocket, `${server.apiUrl}${path}`, init);

    const listed = await owned("/trash?limit=100");
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as {
      data: { id: string; version: number; eligible_for_deletion_at: string }[];
    };
    const row = (id: string) => page.data.find((entry) => entry.id === id);
    expect(row(shownId), "the witness is in the bin").toBeDefined();
    expect(row(hiddenId), "the app item is in the bin").toBeDefined();
    expect(row(hiddenId)?.eligible_for_deletion_at).toBeTruthy();

    const restored = await owned(
      `/items/${hiddenId}/restore?version=${String(row(hiddenId)?.version)}`,
      { method: "POST" },
    );
    expect(restored.status).toBe(200);
    expect(
      (await owner.rawRequest(`/items?type=${HIDDEN}&tier=all`)).status,
    ).toBe(200);
    expect((await app.getItem(hiddenId)).data.item.state).toBe("active");

    expect((await app.deleteItem(hiddenId)).status).toBe(200);
    const purged = await owned(
      `/items/${hiddenId}/purge?version=${String(row(hiddenId)?.version)}`,
      {
        method: "POST",
      },
    );
    expect(purged.status).toBe(200);
    expect((await app.getItem(hiddenId)).status).toBe(404);
  });

  it("counts only visible items in the tag counts and the overview, and lists no tag only hidden items carry", async () => {
    const shared = "hiddentag-shared";
    const only = "hiddentag-only";
    for (const [as, type, tags] of [
      [owner, SHOWN, [shared]],
      [app, HIDDEN, [shared, only]],
      [app, HIDDEN, [shared, only]],
    ] as const) {
      const made = await as.createItem({
        type,
        properties: { name: "tagged" },
        tags: [...tags],
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
    }
    const tags = await owner.listTags();
    expect(tags.status, JSON.stringify(tags.error)).toBe(200);
    const counted = new Map(tags.data.data.map((row) => [row.tag, row.count]));
    expect(counted.get(shared), "the visible item's tag is counted").toBe(1);
    expect(counted.has(only)).toBe(false);

    const overview = await owner.rawRequest<{
      tags?: { tag: string; count: number }[];
    }>("/overview");
    expect(overview.status, JSON.stringify(overview.error)).toBe(200);
    const overviewed = new Map(
      (overview.data.tags ?? []).map((row) => [row.tag, row.count]),
    );
    expect(overviewed.get(shared)).toBe(1);
    expect(overviewed.has(only)).toBe(false);
  });

  it("opens a type filter to the hidden type it names and no other, though a visible type it names has that other as a subtype", async () => {
    const parent = "user.hidden_probe";
    const child = "app.other.setting";
    for (const [id, extra] of [
      [parent, {}],
      [child, { parent }],
    ] as const) {
      const registered = await owner.registerType({
        id,
        fields: { name: { type: "string" } },
        ...extra,
      });
      expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    }
    const probe = await write(owner, parent, "library");
    const nested = await write(owner, child, "library");

    const listed = async (type: string, more = "") => {
      const page = await owner.rawRequest<{ data: MarfaItem[] }>(
        `/items?tier=all&limit=200&type=${type}${more}`,
      );
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      return idsOf(page.data.data);
    };
    expect(await listed(child), "the hidden type, named").toContain(nested);
    expect(await listed(`${parent}&include=hidden`)).toEqual(
      expect.arrayContaining([probe, nested]),
    );
    const byParent = await listed(parent);
    expect(byParent, "the visible parent, named").toContain(probe);
    expect(byParent).not.toContain(nested);
    const beside = await listed(`${parent},${HIDDEN}`);
    expect(beside).toContain(probe);
    expect(beside, "the hidden type named beside it").toEqual(
      expect.arrayContaining(hiddenIds),
    );
    expect(beside, "the other hidden type, not named").not.toContain(nested);

    const counts = await owner.rawRequest<Record<string, number>>(
      `/items/stats?by=type&tier=all&type=${parent},${HIDDEN}`,
    );
    expect(counts.status, JSON.stringify(counts.error)).toBe(200);
    expect(counts.data[parent]).toBe(1);
    expect(counts.data[HIDDEN]).toBeGreaterThanOrEqual(2);
    expect(counts.data).not.toHaveProperty(child);

    const searched = await owner.rawRequest<{ data: { item: MarfaItem }[] }>(
      `/search?q=${WORD}&tier=all&type=${parent},${HIDDEN}`,
    );
    expect(searched.status, JSON.stringify(searched.error)).toBe(200);
    expect(searched.data.data.map((hit) => hit.item.id)).not.toContain(nested);
  });

  it("answers a search that names a hidden type with the items of that type, as a listing does", async () => {
    const found = async (more: string) => {
      const page = await owner.rawRequest<{ data: { item: MarfaItem }[] }>(
        `/search?q=${WORD}&tier=all${more}`,
      );
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      return page.data.data.map((hit) => hit.item.id);
    };
    const plain = await found("");
    expect(plain, "the witness is found").toContain(shownIds[0]);
    for (const id of hiddenIds) expect(plain).not.toContain(id);
    const named = await found(`&type=${HIDDEN}`);
    for (const id of hiddenIds) expect(named).toContain(id);
    for (const id of shownIds) expect(named).not.toContain(id);
  });
});
