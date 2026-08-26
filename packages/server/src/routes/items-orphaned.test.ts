/**
 * The derived `orphaned` answer, wherever an item goes out.
 *
 * An uninstall keeps the items its connection mirrored, which is the
 * decision; what these pin is that a reader can tell. The interesting half
 * is not that a disconnected item reads orphaned — almost any implementation
 * manages that, including one that marks everything — but that it reads
 * orphaned *because its source names no live connection in its own space*.
 * So every positive sits beside the near miss that would satisfy a blunter
 * rule:
 *
 *   - a different integration, live in the same space, must not rescue it
 *     (a rule keyed on "does this space have any integration" passes the
 *     positive case and fails here);
 *   - the same integration, live in a *different* space, must not rescue it,
 *     and the case that matters is a platform-admin read, where one response
 *     carries both spaces' rows and the query is unfenced — `spaceId`
 *     `undefined` means no fence in this codebase, so a scope keyed on the
 *     caller reported another tenant's install as this tenant's;
 *   - a connection that is `revoked` rather than absent must not rescue it,
 *     and the same item must have read `orphaned: false` while that
 *     connection was active — the only thing that changed between the two
 *     reads is the connection's lifecycle state;
 *   - a paused connection must rescue it, because pause is expressed on
 *     `runtime_status` and the connection is still installed;
 *   - an item no integration wrote must carry no answer at all, which is
 *     distinct from carrying `false`.
 *
 * The last block is the contract the whole thing rests on: absence means
 * "no integration wrote this", so every surface handing an item to a client
 * has to answer. A read path, a write path that echoes the item back, and
 * the event stream are each represented.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import * as tar from "tar-stream";
import {
  createTestContext,
  readSse,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { performInstall } from "../connections/install-pipeline.js";
import { performUninstall } from "../connections/uninstall-pipeline.js";
import { performPause } from "../connections/pause-pipeline.js";
import { runtimeCredentialItemSource } from "../connections/lifecycle-lock.js";
import type { IntegrationManifest, Item } from "@withmarfa/shared";

let ctx: TestContext;
let homeSpace: string;
let elsewhereSpace: string;
/** Readers bound to one space each, so an ordinary read is fenced the way an
 *  ordinary caller's is. */
let homeKey: string;
let elsewhereKey: string;
let adminKeyId: string;

/** Item ids, so an assertion names the row it means rather than a position
 *  in a list. */
let goneItemId: string;
let liveItemId: string;
let pausedItemId: string;
let handWrittenItemId: string;
let elsewhereItemId: string;
let goneEventItemId: string;
let referrerItemId: string;
let liveRuntimeKey: string;

const GONE = manifest("acme/orphan-gone");
const LIVE = manifest("acme/orphan-live");
const PAUSED = manifest("acme/orphan-paused");

const WINDOW_FROM = "2031-04-01T00:00:00.000Z";
const WINDOW_TO = "2031-04-08T00:00:00.000Z";
const EVENT_STARTS_AT = "2031-04-03T09:00:00.000Z";

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "orphaned-state fixture",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note", "core.event"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "ignore",
      partial_write_mode: "accept-partial",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
  };
}

/** Register a manifest in the platform-scoped catalog. One row per manifest;
 *  both spaces install from the same one, which is what makes the
 *  cross-space case a real near miss rather than two unrelated setups. */
async function registerCatalogRow(m: IntegrationManifest): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const row = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: m.name,
        manifest_version: m.version,
        publisher: m.publisher,
        direction: m.direction,
        manifest: m,
        registered_at: new Date().toISOString(),
      },
      source: `orphan-catalog-${suffix}`,
      source_id: `orphan-catalog-${suffix}`,
    },
    undefined,
  );
  return row.id;
}

async function install(
  m: IntegrationManifest,
  integrationItemId: string,
  spaceId: string,
): Promise<string> {
  const result = await performInstall(ctx.storage, TEST_API_KEY_SALT, {
    apiKeyId: adminKeyId,
    spaceId,
    authMode: "hosted",
    integrationItemId,
    manifest: m,
    label: m.name,
    clientIp: null,
  });
  return result.connection_id;
}

/**
 * A bearer that writes the way the integration's runtime does: `item_source`
 * is what `itemProvenanceSource` stamps onto the row, and it is built from
 * the manifest by the same function the mint path uses.
 */
async function mintRuntimeKey(
  m: IntegrationManifest,
  connectionId: string,
  spaceId: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_orphan_rt_${suffix}`;
  await ctx.storage.keys.createRuntimeCredential(
    {
      label: `orphan-runtime-${suffix}`,
      source: `orphan-runtime-${suffix}`,
      role: "member",
      type_permissions: { "core.note": "write", "core.event": "write" },
      default_tier: "library",
      connection_id: connectionId,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      item_source: runtimeCredentialItemSource(m),
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

async function mintSpaceKey(spaceId: string, label: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_orphan_sp_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `orphan-space-${suffix}`,
      role: "admin",
      type_permissions: {},
      default_tier: "library",
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

async function writeItem(
  key: string,
  body: Record<string, unknown>,
): Promise<Item> {
  const res = await request(ctx.app, "POST", "/items", { key, body });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: Item }).item;
}

async function writeNote(key: string, text: string): Promise<string> {
  return (
    await writeItem(key, { type: "core.note", properties: { body: text } })
  ).id;
}

/** Every item the caller can list, keyed by id. */
async function listItems(key: string): Promise<Map<string, Item>> {
  const res = await request(ctx.app, "GET", "/items?limit=200", { key });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: Item[] };
  // The whole point of the assertions below is what a row says, so an empty
  // page would pass every one of them by vacuous truth.
  expect(json.data.length).toBeGreaterThan(0);
  return new Map(json.data.map((item) => [item.id, item]));
}

function need(items: Map<string, Item>, id: string, what: string): Item {
  const item = items.get(id);
  if (!item) throw new Error(`${what} (${id}) missing from the read`);
  return item;
}

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
  const admin = (await ctx.storage.keys.list()).find((k) => k.role === "admin");
  if (!admin) throw new Error("admin key not found in test ctx");
  adminKeyId = admin.id;

  homeSpace = (await ctx.storage.spaces!.create("orphan-home")).id;
  elsewhereSpace = (await ctx.storage.spaces!.create("orphan-elsewhere")).id;
  homeKey = await mintSpaceKey(homeSpace, "orphan-home-reader");
  elsewhereKey = await mintSpaceKey(elsewhereSpace, "orphan-elsewhere-reader");

  const goneCatalog = await registerCatalogRow(GONE);
  const liveCatalog = await registerCatalogRow(LIVE);
  const pausedCatalog = await registerCatalogRow(PAUSED);

  // Home space: one integration that will be uninstalled, one that stays
  // live, one that gets paused.
  const goneConnection = await install(GONE, goneCatalog, homeSpace);
  const goneRuntimeKey = await mintRuntimeKey(GONE, goneConnection, homeSpace);
  goneItemId = await writeNote(
    goneRuntimeKey,
    "mirrored by the integration that leaves",
  );
  goneEventItemId = (
    await writeItem(goneRuntimeKey, {
      type: "core.event",
      properties: { title: "standup", starts_at: EVENT_STARTS_AT },
    })
  ).id;

  const liveConnection = await install(LIVE, liveCatalog, homeSpace);
  liveRuntimeKey = await mintRuntimeKey(LIVE, liveConnection, homeSpace);
  liveItemId = await writeNote(
    liveRuntimeKey,
    "mirrored by the integration that stays",
  );

  const pausedConnection = await install(PAUSED, pausedCatalog, homeSpace);
  pausedItemId = await writeNote(
    await mintRuntimeKey(PAUSED, pausedConnection, homeSpace),
    "mirrored by the integration that pauses",
  );

  handWrittenItemId = await writeNote(homeKey, "written by a person");
  // Points at the mirrored row, so the neighbor hydration on the detail read
  // has an integration-written item to answer for.
  referrerItemId = (
    await writeItem(homeKey, {
      type: "core.note",
      properties: { body: "refers to the mirrored note" },
      edges: { references: [goneItemId] },
    })
  ).id;

  // Elsewhere: the SAME manifest, installed and left alone. Its connection
  // must not answer for the home space's items, and the home space's
  // uninstall must not answer for its own.
  const elsewhereConnection = await install(GONE, goneCatalog, elsewhereSpace);
  elsewhereItemId = await writeNote(
    await mintRuntimeKey(GONE, elsewhereConnection, elsewhereSpace),
    "same integration, different space",
  );

  await performUninstall(ctx.storage, {
    apiKeyId: adminKeyId,
    spaceId: homeSpace,
    connectionId: goneConnection,
    clientIp: null,
  });
  await performPause(ctx.storage, {
    apiKeyId: adminKeyId,
    spaceId: homeSpace,
    connectionId: pausedConnection,
    clientIp: null,
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /items", () => {
  it("marks an item whose integration has no live connection here", async () => {
    const items = await listItems(homeKey);

    const gone = need(items, goneItemId, "the uninstalled integration's item");
    // Named rather than implied: the answer is a function of this string,
    // and an assertion that skipped it would pass for an item marked
    // orphaned by any other rule.
    expect(gone.source).toBe("integration:acme/orphan-gone");
    expect(gone.orphaned).toBe(true);

    // The near miss for "does this space have any integration at all":
    // `acme/orphan-live` is installed and active in the same space, and it
    // does not answer for a row it did not write.
    const live = need(items, liveItemId, "the live integration's item");
    expect(live.source).toBe("integration:acme/orphan-live");
    expect(live.orphaned).toBe(false);
  });

  it("does not answer for an item no integration wrote", async () => {
    const items = await listItems(homeKey);
    const handWritten = need(items, handWrittenItemId, "the hand-written note");

    expect(handWritten.source.startsWith("integration:")).toBe(false);
    // Absent, not false. A hand-written note has no upstream to be cut off
    // from and can never acquire one, so `false` would be an answer to a
    // question that does not apply to it.
    expect("orphaned" in handWritten).toBe(false);
  });

  it("keys the answer on the space, not on the manifest name alone", async () => {
    const home = await listItems(homeKey);
    const elsewhere = await listItems(elsewhereKey);

    const here = need(home, goneItemId, "the home space's item");
    const there = need(
      elsewhere,
      elsewhereItemId,
      "the other space's item from the same integration",
    );

    // One manifest name, one catalog row, opposite answers — so the live
    // connection in `elsewhere` cannot be what either read consulted.
    expect(here.source).toBe(there.source);
    expect(here.orphaned).toBe(true);
    expect(there.orphaned).toBe(false);
  });

  it("keeps the spaces apart in one unfenced platform-admin read", async () => {
    // The case a space-bound reader cannot reach. A platform key carries no
    // `space_id`, and an absent space means *no fence* here, so this one
    // response holds both spaces' rows and any scope resolved from the
    // caller would have walked every space's connections at once — finding
    // `elsewhere`'s live `acme/orphan-gone` and reporting the home space's
    // orphaned rows as healthy.
    const items = await listItems(ctx.adminKey);

    const here = need(items, goneItemId, "the home space's orphaned item");
    const there = need(items, elsewhereItemId, "the other space's item");

    // Both really are in the one response, and they really are in different
    // spaces — otherwise this asserts nothing about cross-space keying.
    expect(here.space_id).toBe(homeSpace);
    expect(there.space_id).toBe(elsewhereSpace);
    expect(here.source).toBe(there.source);

    expect(here.orphaned).toBe(true);
    expect(there.orphaned).toBe(false);
  });

  it("lets no space's connection answer for a row in the space-less bucket", async () => {
    // `ItemFilters` cannot express "the rows with no space" — an absent
    // `spaceId` means no fence — so the space-less bucket is narrowed in
    // application code instead, and this is the assertion that makes that
    // line load-bearing rather than decorative. Written straight to storage
    // because no ordinary path produces a space-less integration row on a
    // hosted instance; the invariant is what is under test, not the route
    // that would create one.
    const stray = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "space-less, integration-written" },
        source: "integration:acme/orphan-gone",
        source_id: `stray-${Math.random().toString(36).slice(2, 12)}`,
      },
      undefined,
    );
    expect(stray.space_id).toBeNull();

    const items = await listItems(ctx.adminKey);
    const found = need(items, stray.id, "the space-less row");

    // `acme/orphan-gone` is live in `elsewhere` and revoked in `home`.
    // Neither is this row's space, so neither may answer for it, and the
    // honest answer is that nothing here keeps it current.
    expect(found.space_id).toBeNull();
    expect(found.orphaned).toBe(true);
  });

  it("treats a paused connection as still installed", async () => {
    const items = await listItems(homeKey);
    const paused = need(items, pausedItemId, "the paused integration's item");

    // Pause lives on `runtime_status`; the connection has not left `active`
    // and nothing was removed, so its items are not orphaned.
    expect(paused.orphaned).toBe(false);
  });
});

describe("the connection's lifecycle state is what moves the answer", () => {
  it("reads false while the connection is active and true once it is revoked", async () => {
    const spaceId = (await ctx.storage.spaces!.create("orphan-flip")).id;
    const readerKey = await mintSpaceKey(spaceId, "orphan-flip-reader");
    const flip = manifest("acme/orphan-flip");
    const connectionId = await install(
      flip,
      await registerCatalogRow(flip),
      spaceId,
    );
    const itemId = await writeNote(
      await mintRuntimeKey(flip, connectionId, spaceId),
      "written while the connection was live",
    );

    const before = need(
      await listItems(readerKey),
      itemId,
      "the item before uninstall",
    );
    expect(before.orphaned).toBe(false);

    await performUninstall(ctx.storage, {
      apiKeyId: adminKeyId,
      spaceId,
      connectionId,
      clientIp: null,
    });

    // The row itself was not touched — the uninstall pipeline never reads or
    // writes a mirrored item — so a changed answer can only have come from
    // the connection leaving `active`.
    const connection = await ctx.storage.items.get(connectionId, spaceId);
    expect(connection?.state).toBe("revoked");

    const after = need(
      await listItems(readerKey),
      itemId,
      "the item after uninstall",
    );
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.orphaned).toBe(true);
  });
});

describe("every read path carries it", () => {
  it("GET /items/:id", async () => {
    const res = await request(ctx.app, "GET", `/items/${goneItemId}`, {
      key: homeKey,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    expect(json.item.source).toBe("integration:acme/orphan-gone");
    expect(json.item.orphaned).toBe(true);
  });

  it("GET /items/:id for a live integration's item", async () => {
    const res = await request(ctx.app, "GET", `/items/${liveItemId}`, {
      key: homeKey,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    expect(json.item.orphaned).toBe(false);
  });

  it("GET /items/:id?include=neighbors", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items/${referrerItemId}?include=neighbors`,
      { key: homeKey },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      item: Item;
      neighbors?: { item: Item }[];
    };
    const neighbors = json.neighbors ?? [];
    // The hydration has to have found the mirrored row, or the assertion
    // below is about an empty list.
    expect(neighbors.map((n) => n.item.id)).toContain(goneItemId);
    const neighbor = neighbors.find((n) => n.item.id === goneItemId);
    expect(neighbor?.item.orphaned).toBe(true);
    // The referrer itself is hand-written, so it gets no answer — the same
    // response carrying both is what shows the two are decided per item.
    expect("orphaned" in json.item).toBe(false);
  });

  it("POST /items/bulk-get", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: homeKey,
      body: { ids: [goneItemId, liveItemId, handWrittenItemId] },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: Item[] };
    const byId = new Map(json.items.map((i) => [i.id, i]));
    expect(byId.size).toBe(3);
    expect(need(byId, goneItemId, "gone").orphaned).toBe(true);
    expect(need(byId, liveItemId, "live").orphaned).toBe(false);
    expect("orphaned" in need(byId, handWrittenItemId, "hand-written")).toBe(
      false,
    );
  });

  it("GET /search", async () => {
    const res = await request(ctx.app, "GET", "/search?q=mirrored&limit=50", {
      key: homeKey,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: { item: Item }[] };
    const byId = new Map(json.results.map((r) => [r.item.id, r.item]));
    expect(byId.size).toBeGreaterThan(0);
    expect(need(byId, goneItemId, "gone").orphaned).toBe(true);
    expect(need(byId, liveItemId, "live").orphaned).toBe(false);
  });

  it("GET /occurrences", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/occurrences?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}`,
      { key: homeKey },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { item: Item }[] };
    const byId = new Map(json.data.map((o) => [o.item.id, o.item]));
    // A calendar that expanded nothing would satisfy any assertion below.
    expect(byId.size).toBeGreaterThan(0);
    expect(need(byId, goneEventItemId, "the mirrored event").orphaned).toBe(
      true,
    );
  });

  it("GET /export", async () => {
    const res = await request(ctx.app, "GET", "/export", { key: homeKey });
    expect(res.status).toBe(200);
    const byId = itemsFromNdjson(await res.text());
    expect(byId.size).toBeGreaterThan(0);
    expect(need(byId, goneItemId, "gone").orphaned).toBe(true);
    expect(need(byId, liveItemId, "live").orphaned).toBe(false);
    expect("orphaned" in need(byId, handWrittenItemId, "hand-written")).toBe(
      false,
    );
  });

  it("GET /export?format=archive", async () => {
    const res = await request(ctx.app, "GET", "/export?format=archive", {
      key: homeKey,
    });
    expect(res.status).toBe(200);
    const entries = await extractArchive(Buffer.from(await res.arrayBuffer()));
    const itemsNdjson = entries.get("items.ndjson");
    if (!itemsNdjson) throw new Error("archive carried no items.ndjson");
    const byId = itemsFromNdjson(itemsNdjson.toString("utf-8"));
    expect(byId.size).toBeGreaterThan(0);
    expect(need(byId, goneItemId, "gone").orphaned).toBe(true);
    expect(need(byId, liveItemId, "live").orphaned).toBe(false);
  });
});

describe("a write that echoes the item back carries it too", () => {
  it("POST /items/:id/transition", async () => {
    // The case the contract most has to survive, and the one that proves
    // orphaned is a second axis rather than a fourth state: the row ends up
    // archived AND orphaned, and a response that dropped the field would
    // tell a client following the documented rule that no integration wrote
    // it. A lifecycle change is also the only write reachable on an orphaned
    // row — mirror protection admits the owning integration alone, and its
    // credential went with the uninstall.
    const res = await request(
      ctx.app,
      "POST",
      `/items/${goneItemId}/transition`,
      { key: homeKey, body: { state: "archived" } },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    expect(json.item.state).toBe("archived");
    expect(json.item.orphaned).toBe(true);
  });

  it("POST /items, from a live integration", async () => {
    const created = await writeItem(liveRuntimeKey, {
      type: "core.note",
      properties: { body: "freshly mirrored" },
    });
    expect(created.source).toBe("integration:acme/orphan-live");
    expect(created.orphaned).toBe(false);
  });
});

describe("the event stream carries it", () => {
  it("an item event names the orphaned state rather than dropping it", async () => {
    const stream = await request(ctx.app, "GET", "/events", { key: homeKey });
    expect(stream.status).toBe(200);

    // Restoring the row archived by the transition test above: any lifecycle
    // change publishes, and this leaves the fixture as it found it.
    const transitioned = request(
      ctx.app,
      "POST",
      `/items/${goneItemId}/transition`,
      { key: homeKey, body: { state: "active" } },
    );

    const { text } = await readSse(stream, {
      until: (t) => t.includes(goneItemId),
    });
    expect((await transitioned).status).toBe(200);

    const frame = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { item?: Item })
      .find((payload) => payload.item?.id === goneItemId);
    if (!frame?.item) throw new Error(`no item frame for ${goneItemId}`);

    // Without this the client applying the stream over a `GET /items` page
    // would watch `orphaned: true` disappear on the first unrelated edit.
    expect(frame.item.source).toBe("integration:acme/orphan-gone");
    expect(frame.item.orphaned).toBe(true);
  });
});

/** `{item, metadata}` NDJSON lines, keyed by item id. */
function itemsFromNdjson(text: string): Map<string, Item> {
  const items = text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { item?: Item })
    .flatMap((line) => (line.item ? [line.item] : []));
  return new Map(items.map((item) => [item.id, item]));
}

async function extractArchive(data: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    Readable.from(data).pipe(gunzip).pipe(extract);
  });
  return entries;
}
