/**
 * The derived `orphaned` answer on the item read paths.
 *
 * An uninstall keeps the items its connection mirrored, which is the
 * decision; what these pin is that a reader can tell. The interesting half
 * is not that a disconnected item reads orphaned — almost any implementation
 * manages that, including one that marks everything — but that it reads
 * orphaned *because its source names no live connection in this space*. So
 * every assertion below sits beside the near miss that would satisfy a
 * blunter rule:
 *
 *   - a different integration, live in the same space, must not rescue it
 *     (a rule keyed on "does this space have any integration" passes the
 *     positive case and fails here);
 *   - the same integration, live in a different space, must not rescue it
 *     (a rule that forgot the space fence passes the positive case and
 *     fails here);
 *   - a connection that is `revoked` rather than absent must not rescue it,
 *     and the same item must have read `orphaned: false` while that
 *     connection was active — the only thing that changed between the two
 *     reads is the connection's lifecycle state;
 *   - a paused connection must rescue it, because pause is expressed on
 *     `runtime_status` and the connection is still installed;
 *   - an item no integration wrote must carry no answer at all, which is
 *     distinct from carrying `false`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
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

/**
 * The serialized item as a read path returns it. `Item` is the stored row and
 * deliberately does not carry `orphaned` — that is the thing under test: the
 * field exists on the wire and nowhere in the database.
 */
type ReadItem = Item & { orphaned?: boolean };

let ctx: TestContext;
let homeSpace: string;
let elsewhereSpace: string;
/** Reader in the home space. Space-bound, so every read below is fenced the
 *  way an ordinary caller's is. */
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

const GONE = manifest("acme/orphan-gone");
const LIVE = manifest("acme/orphan-live");
const PAUSED = manifest("acme/orphan-paused");

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "orphaned-state fixture",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
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
      type_permissions: { "core.note": "write" },
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

async function writeNote(key: string, body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { item: ReadItem };
  return json.item.id;
}

/** Every item the caller can list, keyed by id. */
async function listItems(key: string): Promise<Map<string, ReadItem>> {
  const res = await request(ctx.app, "GET", "/items?limit=200", { key });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: ReadItem[] };
  // The whole point of the assertions below is what a row says, so an empty
  // page would pass every one of them by vacuous truth.
  expect(json.data.length).toBeGreaterThan(0);
  return new Map(json.data.map((item) => [item.id, item]));
}

function need(
  items: Map<string, ReadItem>,
  id: string,
  what: string,
): ReadItem {
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
  goneItemId = await writeNote(
    await mintRuntimeKey(GONE, goneConnection, homeSpace),
    "mirrored by the integration that leaves",
  );

  const liveConnection = await install(LIVE, liveCatalog, homeSpace);
  liveItemId = await writeNote(
    await mintRuntimeKey(LIVE, liveConnection, homeSpace),
    "mirrored by the integration that stays",
  );

  const pausedConnection = await install(PAUSED, pausedCatalog, homeSpace);
  pausedItemId = await writeNote(
    await mintRuntimeKey(PAUSED, pausedConnection, homeSpace),
    "mirrored by the integration that pauses",
  );

  handWrittenItemId = await writeNote(homeKey, "written by a person");

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

describe("every item read path carries it", () => {
  it("GET /items/:id", async () => {
    const res = await request(ctx.app, "GET", `/items/${goneItemId}`, {
      key: homeKey,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: ReadItem };
    expect(json.item.source).toBe("integration:acme/orphan-gone");
    expect(json.item.orphaned).toBe(true);
  });

  it("GET /items/:id for a live integration's item", async () => {
    const res = await request(ctx.app, "GET", `/items/${liveItemId}`, {
      key: homeKey,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: ReadItem };
    expect(json.item.orphaned).toBe(false);
  });

  it("POST /items/bulk-get", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: homeKey,
      body: { ids: [goneItemId, liveItemId, handWrittenItemId] },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: ReadItem[] };
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
    const json = (await res.json()) as { results: { item: ReadItem }[] };
    const byId = new Map(json.results.map((r) => [r.item.id, r.item]));
    expect(byId.size).toBeGreaterThan(0);
    expect(need(byId, goneItemId, "gone").orphaned).toBe(true);
    expect(need(byId, liveItemId, "live").orphaned).toBe(false);
  });

  it("GET /export", async () => {
    const res = await request(ctx.app, "GET", "/export", { key: homeKey });
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { item?: ReadItem });
    const byId = new Map(
      lines
        .flatMap((line) => (line.item ? [line.item] : []))
        .map((item) => [item.id, item]),
    );
    expect(byId.size).toBeGreaterThan(0);
    expect(need(byId, goneItemId, "gone").orphaned).toBe(true);
    expect(need(byId, liveItemId, "live").orphaned).toBe(false);
    expect("orphaned" in need(byId, handWrittenItemId, "hand-written")).toBe(
      false,
    );
  });
});
