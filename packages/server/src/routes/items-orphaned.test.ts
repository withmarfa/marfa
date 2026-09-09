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
 *     and the case that matters is an operator-key read, where one response
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
import { resolveOrphanScopeForOwnWrite, withOrphanState } from "./_orphaned.js";
import { initEventLog } from "../pubsub.js";
import type { ApiKey, IntegrationManifest, Item } from "@withmarfa/shared";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

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
let goneRestoreItemId: string;
let goneLiveFrameItemId: string;
let goneReplayFrameItemId: string;
let goneVouchItemId: string;
let pausedVouchItemId: string;
let goneForgedItemId: string;
let gonePromoteItemId: string;
let referrerItemId: string;
let liveRuntimeKey: string;
let liveReplaySourceId: string;

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
    publisher: "acme",
    description: "orphaned-state fixture",
    direction: "read",
    runs_on: "server" as const,
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
  const result = await performInstall(ctx.storage, {
    apiKeyId: adminKeyId,
    spaceId,
    integrationItemId,
    manifest: m,
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
      space_permissions: [...SPACE_PERMISSIONS],
      // The rank this fixture carried admitted it past all four maps, so
      // each one has to say what the rank granted silently.
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      default_tier: "library",
      is_operator: false,
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
  // The default bootstrap leaves the event log unwired, and the replay half
  // of the stream contract needs `publish()` to append something to replay.
  initEventLog(ctx.storage.eventLog);
  const admin = (await ctx.storage.keys.list()).find((k) => k.is_operator);
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

  // Rows for the destructive write-path cases, written while the
  // connection is still live because nothing can write them afterwards.
  goneRestoreItemId = await writeNote(
    goneRuntimeKey,
    "mirrored, later trashed",
  );
  gonePromoteItemId = await writeNote(
    goneRuntimeKey,
    "mirrored, later promoted",
  );
  // A row per stream test. Each transitions, and a transition into the state
  // a row is already in is refused — so sharing one row makes a failure in
  // the first surface as a confusing 400 in the second instead of as its own
  // assertion.
  goneLiveFrameItemId = await writeNote(goneRuntimeKey, "mirrored, live frame");
  goneReplayFrameItemId = await writeNote(
    goneRuntimeKey,
    "mirrored, replayed frame",
  );
  goneVouchItemId = await writeNote(
    goneRuntimeKey,
    "mirrored, later touched by another integration",
  );
  goneForgedItemId = await writeNote(
    goneRuntimeKey,
    "mirrored, later touched by a forged credential",
  );

  const liveConnection = await install(LIVE, liveCatalog, homeSpace);
  liveRuntimeKey = await mintRuntimeKey(LIVE, liveConnection, homeSpace);
  liveItemId = await writeNote(
    liveRuntimeKey,
    "mirrored by the integration that stays",
  );

  const pausedConnection = await install(PAUSED, pausedCatalog, homeSpace);
  const pausedRuntimeKey = await mintRuntimeKey(
    PAUSED,
    pausedConnection,
    homeSpace,
  );
  pausedItemId = await writeNote(
    pausedRuntimeKey,
    "mirrored by the integration that pauses",
  );
  pausedVouchItemId = await writeNote(
    pausedRuntimeKey,
    "mirrored, later touched by another integration",
  );

  liveReplaySourceId = `upstream-${Math.random().toString(36).slice(2, 12)}`;
  await writeItem(liveRuntimeKey, {
    type: "core.note",
    properties: { body: "mirrored with a natural key" },
    source_id: liveReplaySourceId,
  });

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

  it("keeps the spaces apart in one unfenced operator-key read", async () => {
    // The case a space-bound reader cannot reach. The operator key carries no
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

describe("two connections of one integration (D63)", () => {
  /**
   * The case `(space, manifest name)` could not see, and the reason the
   * column exists.
   *
   * Both connections stamp the same `integration:<name>` on their rows, so
   * the pre-D63 walk collected one string for the pair. Removing one left
   * every row it wrote reading `orphaned: false` on the strength of its
   * sibling — the field's stated contract answered correctly, and the
   * question a reader actually asks answered wrongly.
   */
  it("marks the removed connection's rows and leaves its sibling's alone", async () => {
    const spaceId = (await ctx.storage.spaces!.create("orphan-twins")).id;
    const readerKey = await mintSpaceKey(spaceId, "orphan-twins-reader");
    const twins = manifest("acme/orphan-twins");
    const catalogRow = await registerCatalogRow(twins);

    const first = await install(twins, catalogRow, spaceId);
    const second = await install(twins, catalogRow, spaceId);
    expect(first).not.toBe(second);

    const firstItem = await writeNote(
      await mintRuntimeKey(twins, first, spaceId),
      "written by the connection that will be removed",
    );
    const secondItem = await writeNote(
      await mintRuntimeKey(twins, second, spaceId),
      "written by the connection that stays",
    );

    // Precondition. Without it the assertion after the uninstall proves
    // nothing about the uninstall: a resolver that answered `true` for
    // everything would pass that one and fail this.
    const before = await listItems(readerKey);
    expect(need(before, firstItem, "the first item").orphaned).toBe(false);
    expect(need(before, secondItem, "the second item").orphaned).toBe(false);

    // And that the two really are one integration, which is the whole
    // premise: different manifests would not share a provenance string and
    // nothing here would be testing the case it names.
    const rows = await ctx.storage.items.getMany(
      [firstItem, secondItem],
      spaceId,
    );
    expect(rows.get(firstItem)?.source).toBe(rows.get(secondItem)?.source);

    await performUninstall(ctx.storage, {
      apiKeyId: adminKeyId,
      spaceId,
      connectionId: first,
      clientIp: null,
    });

    const after = await listItems(readerKey);
    expect(
      need(after, firstItem, "the removed connection's item").orphaned,
    ).toBe(true);
    // The positive beside it. A resolver that marks everything orphaned the
    // moment any connection dies passes the line above and fails this one.
    expect(need(after, secondItem, "the live connection's item").orphaned).toBe(
      false,
    );
  });

  it("falls back to the manifest answer for a row that records no writer", async () => {
    // Every row written before the column existed is in this state, and it
    // is why no backfill is needed. The pre-column rule was
    // `(space, manifest name)`, and that is exactly what it still gets.
    const spaceId = (await ctx.storage.spaces!.create("orphan-nullwriter")).id;
    const readerKey = await mintSpaceKey(spaceId, "orphan-nullwriter-reader");
    const live = manifest("acme/orphan-null-live");
    const gone = manifest("acme/orphan-null-gone");
    const liveConnection = await install(
      live,
      await registerCatalogRow(live),
      spaceId,
    );
    const goneConnection = await install(
      gone,
      await registerCatalogRow(gone),
      spaceId,
    );

    // Written through storage rather than the route, so the column stays
    // null the way a pre-column row's is.
    const liveRow = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "no writer recorded, integration still live" },
        source: runtimeCredentialItemSource(live) ?? undefined,
      },
      spaceId,
    );
    const goneRow = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "no writer recorded, integration removed" },
        source: runtimeCredentialItemSource(gone) ?? undefined,
      },
      spaceId,
    );
    const writers = await ctx.storage.items.writersOf([liveRow.id, goneRow.id]);
    expect(writers.get(liveRow.id)).toBeNull();
    expect(writers.get(goneRow.id)).toBeNull();

    await performUninstall(ctx.storage, {
      apiKeyId: adminKeyId,
      spaceId,
      connectionId: goneConnection,
      clientIp: null,
    });
    expect(liveConnection).toBeDefined();

    const items = await listItems(readerKey);
    expect(need(items, liveRow.id, "the null-writer live row").orphaned).toBe(
      false,
    );
    expect(
      need(items, goneRow.id, "the null-writer removed row").orphaned,
    ).toBe(true);
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

describe("the remaining write paths that echo an item back", () => {
  it("PATCH, from the integration that owns the row", async () => {
    // Mirror protection admits only the owning integration, so a PATCH can
    // never return an orphaned row: the owner's credential went with the
    // uninstall. `false` here is the whole reachable range, and it is worth
    // pinning because it is the branch the own-write shortcut answers
    // without a query.
    const res = await request(ctx.app, "PATCH", `/items/${liveItemId}`, {
      key: liveRuntimeKey,
      body: { properties: { body: "re-synced" } },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    expect(json.item.source).toBe("integration:acme/orphan-live");
    expect(json.item.orphaned).toBe(false);
  });

  it("PATCH, on a row no integration wrote", async () => {
    const res = await request(ctx.app, "PATCH", `/items/${handWrittenItemId}`, {
      key: homeKey,
      body: { properties: { body: "edited by hand" } },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    expect("orphaned" in json.item).toBe(false);
  });

  it("POST /items/:id/restore", async () => {
    const trashed = await request(
      ctx.app,
      "DELETE",
      `/items/${goneRestoreItemId}`,
      { key: homeKey },
    );
    expect(trashed.status).toBe(200);

    const res = await request(
      ctx.app,
      "POST",
      `/items/${goneRestoreItemId}/restore`,
      { key: homeKey },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    expect(json.item.state).toBe("active");
    // The caller is a person, not the integration, so the shortcut does not
    // apply and this is the real query answering.
    expect(json.item.orphaned).toBe(true);
  });

  it("POST /items/:id/promote", async () => {
    const res = await request(
      ctx.app,
      "POST",
      `/items/${gonePromoteItemId}/promote`,
      { key: homeKey },
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { item: Item };
    // The promoted copy is the caller's own row, stamped with the caller's
    // source. It is not a mirror of anything, so the question stops
    // applying to it the moment it is promoted — which is the point of
    // promotion, and would be hidden if the copy inherited the answer.
    expect(json.item.source.startsWith("integration:")).toBe(false);
    expect("orphaned" in json.item).toBe(false);
  });

  /**
   * The own-write shortcut answers from the calling credential instead of
   * querying, so it must only answer for rows that credential's own
   * `item_source` stamped. Two integrations declaring the same type in
   * `target_types` gives one write access to the other's rows, and lifecycle
   * gestures are exempt from mirror protection, so a caller touching a
   * stranger's mirror is reachable in both directions.
   *
   * The second of these is the one that pins the guard. Drop it and the
   * scope becomes the caller's own source, so the row is judged against a
   * set that never contains it — every stranger's row reads `true`,
   * including rows of perfectly healthy integrations. The first case reads
   * `true` either way, so on its own it proves nothing.
   */
  it("does not let one integration answer for a removed one's row", async () => {
    const res = await request(
      ctx.app,
      "POST",
      `/items/${goneVouchItemId}/transition`,
      { key: liveRuntimeKey, body: { state: "archived" } },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    // Caller and row really are different integrations, or this says nothing.
    expect(json.item.source).toBe("integration:acme/orphan-gone");
    expect(json.item.orphaned).toBe(true);
  });

  it("does not take a hand-minted credential's word for its own provenance", async () => {
    // `source` is free text on a hand-minted key, and one of the three mint
    // routes writes the caller's label into it with no reserved-prefix
    // check — so the string can claim to be an integration when nothing is
    // installed behind it. Minted through storage here rather than through
    // that route, so this pins the rule this module is responsible for
    // instead of the missing check, which is somebody else's fix.
    const suffix = Math.random().toString(36).slice(2, 12);
    const raw = `marfa_k1_orphan_forged_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: "integration:acme/orphan-gone",
        source: "integration:acme/orphan-gone",
        space_permissions: [...SPACE_PERMISSIONS],
        // The rank this fixture carried admitted it past its own map, so the
        // map has to say what the rank granted silently.
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      homeSpace,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/items/${goneForgedItemId}/transition`,
      { key: raw, body: { state: "archived" } },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    // The forged source matches the row exactly, which is what would make a
    // string comparison believe it. The credential is not a runtime one, so
    // the shortcut must not fire and the integration is still gone.
    expect(json.item.source).toBe("integration:acme/orphan-gone");
    expect(json.item.orphaned).toBe(true);
  });

  it("does not let one integration condemn a live one's row", async () => {
    const res = await request(
      ctx.app,
      "POST",
      `/items/${pausedVouchItemId}/transition`,
      { key: liveRuntimeKey, body: { state: "archived" } },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: Item };
    expect(json.item.source).toBe("integration:acme/orphan-paused");
    // `acme/orphan-paused` is installed, so the honest answer is `false`.
    // The shortcut cannot produce it — its set holds the caller's source
    // and nothing else — so this only passes when the fallback runs.
    expect(json.item.orphaned).toBe(false);
  });

  it("POST /items, replaying a natural key onto a trashed mirror", async () => {
    const existing = await request(
      ctx.app,
      "GET",
      `/items?source=integration:acme/orphan-live&limit=200`,
      { key: homeKey },
    );
    expect(existing.status).toBe(200);
    const rows = ((await existing.json()) as { data: Item[] }).data.filter(
      (i) => i.source_id === liveReplaySourceId,
    );
    // The filter has to have found the row, or the delete below is a no-op
    // and the replay branch is never reached.
    expect(rows).toHaveLength(1);
    const target = rows[0]!;

    expect(
      (
        await request(ctx.app, "DELETE", `/items/${target.id}`, {
          key: homeKey,
        })
      ).status,
    ).toBe(200);

    const replay = await request(ctx.app, "POST", "/items", {
      key: liveRuntimeKey,
      body: {
        type: "core.note",
        properties: { body: "re-synced onto a trashed mirror" },
        source_id: liveReplaySourceId,
      },
    });
    expect(replay.status).toBe(200);
    const json = (await replay.json()) as {
      item: Item;
      acknowledged?: boolean;
    };
    // The branch that writes nothing and returns the row as it stands still
    // answers, because absence would say no integration wrote it.
    expect(json.acknowledged).toBe(true);
    expect(json.item.orphaned).toBe(false);
  });
});

describe("the event stream deliberately does not carry it", () => {
  /**
   * Not an omission. Removing a connection publishes no item events, so the
   * change this field describes can never arrive on the stream; decorating
   * it only made unrelated events carry an incidentally-current value, and
   * a replayed payload is a snapshot that cannot be re-derived safely. The
   * contract is written down in `_schemas.ts`, and these are what stop it
   * being re-added without reading it.
   */
  function itemFrames(text: string): Item[] {
    return text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { item?: Item })
      .flatMap((payload) => (payload.item ? [payload.item] : []));
  }

  it("omits it on a live frame for a row a read answers about", async () => {
    // The read and the frame are about the same row in the same test, so
    // this is the difference itself rather than two separate claims.
    const read = await request(
      ctx.app,
      "GET",
      `/items/${goneLiveFrameItemId}`,
      { key: homeKey },
    );
    expect(((await read.json()) as { item: Item }).item.orphaned).toBe(true);

    const stream = await request(ctx.app, "GET", "/events", { key: homeKey });
    expect(stream.status).toBe(200);
    const transitioned = request(
      ctx.app,
      "POST",
      `/items/${goneLiveFrameItemId}/transition`,
      { key: homeKey, body: { state: "archived" } },
    );
    const { text } = await readSse(stream, {
      until: (t) => t.includes(goneLiveFrameItemId),
    });
    expect((await transitioned).status).toBe(200);

    const frame = itemFrames(text).find(
      (item) => item.id === goneLiveFrameItemId,
    );
    if (!frame) throw new Error(`no item frame for ${goneLiveFrameItemId}`);
    expect(frame.source).toBe("integration:acme/orphan-gone");
    expect("orphaned" in frame).toBe(false);
  });

  it("omits it on a replayed frame too", async () => {
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const cursor = before.reduce((a, e) => (e.id > a ? e.id : a), 0n);

    const changed = await request(
      ctx.app,
      "POST",
      `/items/${goneReplayFrameItemId}/transition`,
      { key: homeKey, body: { state: "archived" } },
    );
    expect(changed.status).toBe(200);

    const stream = await request(ctx.app, "GET", "/events", {
      key: homeKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(stream.status).toBe(200);
    const { text } = await readSse(stream, {
      until: (t) => t.includes(goneReplayFrameItemId),
    });

    const frames = itemFrames(text);
    // Replay has to have produced the frame, or "no field" is trivially
    // true of an empty stream.
    const frame = frames.find((item) => item.id === goneReplayFrameItemId);
    if (!frame)
      throw new Error(`replay produced no frame for ${goneReplayFrameItemId}`);
    // The stored payload is a snapshot; it must not be carrying a stale
    // answer, and it must not be re-derived on the way out either.
    expect("orphaned" in frame).toBe(false);
  });
});

describe("a derivation that cannot be made is not silently skipped", () => {
  it("fails the read rather than answering it wrong", async () => {
    // Absence means "no integration wrote this", so swallowing a storage
    // failure would turn an outage into a confident lie about provenance on
    // every mirrored row in the space. Loud is the only safe direction, and
    // this is the assertion that keeps it that way — the review found the
    // module by fixing a bad input rather than the mechanism, which is what
    // an untested failure path invites.
    const realList = ctx.storage.items.list.bind(ctx.storage.items);
    ctx.storage.items.list = async (filters) => {
      if (filters.type === "system.connection") {
        throw new Error("connection listing unavailable");
      }
      return realList(filters);
    };
    try {
      const res = await request(ctx.app, "GET", "/items?limit=200", {
        key: homeKey,
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      // And specifically not a 200 whose rows quietly lost the field.
      expect(res.status).not.toBe(200);
    } finally {
      ctx.storage.items.list = realList;
    }

    // The stub is gone and the read works again, so the assertion above was
    // about the stub rather than about a context this test broke.
    const after = await listItems(homeKey);
    expect(need(after, goneItemId, "gone").orphaned).toBe(true);
  });
});

describe("the own-write shortcut's space equality", () => {
  /**
   * Every write route fetches its row under the caller's own space fence, so
   * no route can currently hand the shortcut a row from another space — the
   * equality is safe today by the routes' behaviour rather than by anything
   * in this module. That is exactly why it is asserted here, against the
   * function, rather than through a route that cannot express the case: the
   * check has to survive a future caller that fetches differently.
   */
  function runtimeKey(itemSource: string, spaceId: string | undefined): ApiKey {
    return {
      id: "key_shortcut_probe",
      is_runtime_credential: true,
      item_source: itemSource,
      space_id: spaceId,
      type_permissions: {},
    } as unknown as ApiKey;
  }

  it("answers without a query when the row is the caller's own", async () => {
    const row = {
      // Not a stored row: `writersOf` finds nothing for it, which is the
      // no-recorded-writer path and the one these two cases are about.
      id: "01000000-0000-7000-8000-000000000001",
      source: "integration:acme/orphan-gone",
      space_id: homeSpace,
    };
    const scope = await resolveOrphanScopeForOwnWrite(
      ctx.storage,
      [row],
      runtimeKey(row.source, homeSpace),
    );
    // The shortcut fired: `acme/orphan-gone` is uninstalled in `homeSpace`,
    // so the real query would have said `true` and this says `false`.
    expect(withOrphanState(row, scope).orphaned).toBe(false);
  });

  it("falls back when the row is in a different space from the caller", async () => {
    const row = {
      // Not a stored row: `writersOf` finds nothing for it, which is the
      // no-recorded-writer path and the one these two cases are about.
      id: "01000000-0000-7000-8000-000000000001",
      source: "integration:acme/orphan-gone",
      space_id: homeSpace,
    };
    const scope = await resolveOrphanScopeForOwnWrite(
      ctx.storage,
      [row],
      // Same integration, same source string, a different space. The
      // credential proves a live connection where it lives, and nothing
      // about `homeSpace`.
      runtimeKey(row.source, elsewhereSpace),
    );
    expect(withOrphanState(row, scope).orphaned).toBe(true);
  });
});

describe("the single-space self-host shape", () => {
  /**
   * Every context above is hosted, with several spaces to tell apart. A
   * self-host has exactly one, and that is the difference worth covering:
   * the fence has nothing to exclude, so a scope resolver that quietly
   * matched everything would look identical to one that worked.
   *
   * This used to say a self-host carried no `space_id` at all and walked the
   * space-less bucket. Keys mode provisions a space at bootstrap and works
   * through a credential bound to it, so an ordinary row carries a real one
   * here as much as it does on a hosted deployment. What is left space-less
   * is the operator key, which holds no permissions and writes nothing.
   */
  let selfHost: TestContext;

  beforeAll(async () => {
    selfHost = await createTestContext();
  });

  afterAll(async () => {
    await selfHost.cleanup();
  });

  it("answers for space-less rows against space-less connections", async () => {
    const admin = (await selfHost.storage.keys.list()).find(
      (k) => k.is_operator,
    );
    if (!admin) throw new Error("admin key not found");

    const mk = async (m: IntegrationManifest): Promise<string> => {
      const suffix = Math.random().toString(36).slice(2, 12);
      const row = await selfHost.storage.items.create(
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
          source: `selfhost-catalog-${suffix}`,
          source_id: `selfhost-catalog-${suffix}`,
        },
        undefined,
      );
      const result = await performInstall(selfHost.storage, {
        apiKeyId: admin.id,
        spaceId: selfHost.spaceId,
        integrationItemId: row.id,
        manifest: m,
        clientIp: null,
      });
      return result.connection_id;
    };

    const runtimeKey = async (
      m: IntegrationManifest,
      connectionId: string,
    ): Promise<string> => {
      const suffix = Math.random().toString(36).slice(2, 12);
      const raw = `marfa_k1_selfhost_${suffix}`;
      await selfHost.storage.keys.createRuntimeCredential(
        {
          label: `selfhost-runtime-${suffix}`,
          source: `selfhost-runtime-${suffix}`,
          type_permissions: { "core.note": "write" },
          default_tier: "library",
          connection_id: connectionId,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          item_source: runtimeCredentialItemSource(m),
        },
        hashApiKey(raw, TEST_API_KEY_SALT),
        selfHost.spaceId,
      );
      return raw;
    };

    const goneManifest = manifest("acme/selfhost-gone");
    const liveManifest = manifest("acme/selfhost-live");
    const goneConnection = await mk(goneManifest);
    const liveConnection = await mk(liveManifest);

    const write = async (key: string, body: string): Promise<string> => {
      const res = await request(selfHost.app, "POST", "/items", {
        key,
        body: { type: "core.note", properties: { body } },
      });
      expect(res.status).toBe(201);
      const created = ((await res.json()) as { item: Item }).item;
      // The premise of the whole describe: one space, and everything is in
      // it. A row that landed outside would make the assertions below
      // meaningless rather than merely wrong.
      expect(created.space_id).toBe(selfHost.spaceId);
      return created.id;
    };

    const goneId = await write(
      await runtimeKey(goneManifest, goneConnection),
      "self-host mirror that loses its integration",
    );
    const liveId = await write(
      await runtimeKey(liveManifest, liveConnection),
      "self-host mirror that keeps it",
    );
    const handId = await write(selfHost.spaceKey, "self-host hand-written");

    await performUninstall(selfHost.storage, {
      apiKeyId: admin.id,
      spaceId: undefined,
      connectionId: goneConnection,
      clientIp: null,
    });

    const res = await request(selfHost.app, "GET", "/items?limit=200", {
      key: selfHost.spaceKey,
    });
    expect(res.status).toBe(200);
    const byId = new Map(
      ((await res.json()) as { data: Item[] }).data.map((i) => [i.id, i]),
    );
    expect(byId.size).toBeGreaterThan(0);

    // The same three answers as the hosted case, on the branch where "no
    // fence" and "the space-less bucket" are the same set.
    expect(need(byId, goneId, "self-host gone").orphaned).toBe(true);
    expect(need(byId, liveId, "self-host live").orphaned).toBe(false);
    expect("orphaned" in need(byId, handId, "self-host hand-written")).toBe(
      false,
    );
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
