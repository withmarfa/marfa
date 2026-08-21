/**
 * The doors that write an item's properties agree on who may write what.
 *
 * There are four such routes and six ways through them, and four of the
 * six have been found disagreeing — each time by someone asking what
 * else has this shape rather than by a test. Testing a door on its own
 * cannot catch that: every one of those defects was a gate that existed
 * somewhere else and was missing here, so the property worth asserting
 * is agreement, not per-door behavior.
 *
 * Hence the table. One credential, one write it must not be able to
 * make, and every door refuses it. A door that regresses fails here, and
 * a route nobody added a row for fails the coverage check at the bottom
 * rather than going unnoticed until the next review.
 *
 * Each door expresses the intent as natively as it can, including the
 * type it claims the row is, because the claim is the escalation vector:
 * naming a type the credential holds write on skips every gate keyed on
 * the type the row actually is. `POST /items` create is the one door
 * with nothing to misdeclare — there the claim IS the row — which is
 * why it was never the door that broke.
 *
 * Scope is an item's `properties`. The lifecycle axis
 * (`POST /items/{id}/transition`, `/restore`) and the metadata and
 * extension layers also reach a `system.activity` row and also gate on
 * type alone; they are a different axis needing a different fix, and are
 * excluded below by name rather than by omission.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";
import {
  createTestContext,
  request,
  runBulkActionAsync,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  // `hosted`: the attribution rule only has anything to bind to on a
  // deployment where Connections carry a space.
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Credential {
  key: string;
  connectionId: string;
  /** Item provenance, derived from the Connection and fixed for its life. */
  itemSource: string;
}

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "Write-door agreement fixture",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
    permissions: { extension: { "acme.probe": "write" } },
  };
}

async function credentialFor(
  spaceId: string,
  name: string,
): Promise<Credential> {
  const m = manifest(name);
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: m.name,
        manifest_version: m.version,
        publisher: m.publisher,
        manifest: m,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integration.id,
      },
    },
    spaceId,
  );
  const cred = await mintLocalRuntimeCredential(
    ctx.storage,
    TEST_API_KEY_SALT,
    connection.id,
    "hosted",
  );
  return {
    key: cred.api_key,
    connectionId: connection.id,
    // The provenance stamp every item write carries — keyed on the
    // manifest name, stable across mints (`runtimeCredentialItemSource`).
    itemSource: `integration:${name}`,
  };
}

/** An activity row owned by `owner`, addressable by id and by natural key. */
async function activityRow(
  owner: Credential,
  sourceId: string,
): Promise<{ id: string; source_id: string }> {
  const res = await request(ctx.app, "POST", "/items", {
    key: owner.key,
    body: {
      type: "system.activity",
      source_id: sourceId,
      properties: {
        connection_id: owner.connectionId,
        severity: "info",
        summary: "sync complete",
      },
    },
  });
  expect(res.status).toBe(201);
  return {
    id: ((await res.json()) as { item: { id: string } }).item.id,
    source_id: sourceId,
  };
}

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

interface DoorWrite {
  key: string;
  target: { id: string; source_id: string };
  properties: Record<string, unknown>;
}

interface Door {
  name: string;
  /** `${METHOD} ${path}` exactly as Hono registers it. Keys the coverage check. */
  route: string;
  /**
   * How the door says no. Doors that address a named row refuse it
   * outright. `bulk-actions` takes a filter, and its established answer
   * to "the caller may not touch that row" is to drop it from the match
   * set — the same answer `getTypeFilter` already gives on the type
   * axis, and the only sane one when the alternative is failing an
   * action over thousands of rows the caller legitimately can write.
   */
  refuses: "status" | "narrowing";
  write(w: DoorWrite): Promise<Response>;
}

const DOORS: Door[] = [
  {
    name: "POST /items (create)",
    route: "POST /items",
    refuses: "status",
    // No `target`: the row this lands on is the one the body describes,
    // which is also why there is no type here to misdeclare.
    write: ({ key, properties }) =>
      request(ctx.app, "POST", "/items", {
        key,
        body: { type: "system.activity", properties },
      }),
  },
  {
    name: "POST /items (natural-key upsert)",
    route: "POST /items",
    refuses: "status",
    // `core.note` is a type this credential genuinely holds write on, so
    // the claim passes every gate that reads it — and the update ignores
    // it, landing on whatever type the resolved row already is.
    write: ({ key, target, properties }) =>
      request(ctx.app, "POST", "/items", {
        key,
        body: { type: "core.note", source_id: target.source_id, properties },
      }),
  },
  {
    name: "PATCH /items/{id}",
    route: "PATCH /items/:id",
    refuses: "status",
    // The body carries no type at all, which is why this door has never
    // been the one that broke.
    write: ({ key, target, properties }) =>
      request(ctx.app, "PATCH", `/items/${target.id}`, {
        key,
        body: { properties },
      }),
  },
  {
    name: "POST /items/bulk (by id)",
    route: "POST /items/bulk",
    refuses: "status",
    write: ({ key, target, properties }) =>
      request(ctx.app, "POST", "/items/bulk", {
        key,
        body: { items: [{ id: target.id, type: "core.note", properties }] },
      }),
  },
  {
    name: "POST /items/bulk (natural key)",
    route: "POST /items/bulk",
    refuses: "status",
    write: ({ key, target, properties }) =>
      request(ctx.app, "POST", "/items/bulk", {
        key,
        body: {
          items: [
            { source_id: target.source_id, type: "core.note", properties },
          ],
        },
      }),
  },
  {
    name: "POST /items/bulk-actions (update_properties)",
    route: "POST /items/bulk-actions",
    refuses: "narrowing",
    write: async ({ key, properties }) => {
      // Filter-in rather than id-in, so one call reaches every activity
      // row in the space without knowing a single id — the widest of
      // the doors. `runBulkActionAsync` drains the worker, so the write
      // really lands or really does not rather than stopping at a
      // queued job that nothing in-process would ever pick up.
      const { initialStatus } = await runBulkActionAsync(
        ctx,
        {
          action: "update_properties",
          filter: { type: "system.activity" },
          patch: properties,
        },
        key,
      );
      return new Response(null, { status: initialStatus });
    },
  },
];

/**
 * Routes under `/items` that mutate something but cannot write an item's
 * properties, so they are not doors this file speaks for. Listed rather
 * than omitted: the coverage check fails on anything in neither table,
 * which is how a new door earns a row instead of being found by the next
 * reviewer.
 */
const NOT_A_PROPERTIES_DOOR: Record<string, string> = {
  "POST /items/bulk-get": "read-only batch fetch",
  "POST /items/:id/tags": "metadata layer, not the item's properties",
  "PUT /items/:id/metadata": "metadata layer, not the item's properties",
  "PATCH /items/:id/metadata": "metadata layer, not the item's properties",
  "PUT /items/:id/extensions/:namespace":
    "extension layer, gated by extension_permissions",
  "POST /items/:id/transition":
    "lifecycle state axis, not the item's properties",
  "POST /items/:id/restore": "lifecycle state axis, not the item's properties",
  "POST /items/:id/promote":
    "creates a fresh item from a mirror it only reads; never writes an existing row's properties, and the create it performs runs the create-door gates",
};

// ---------------------------------------------------------------------------
// The agreement
// ---------------------------------------------------------------------------

describe.each(DOORS)("$name", (door) => {
  let spaceId: string;
  let mine: Credential;
  let sibling: Credential;
  let seq = 0;

  beforeAll(async () => {
    const slug = door.name.replace(/[^a-z]+/gi, "-").toLowerCase();
    const space = await ctx.storage.spaces!.create(slug);
    spaceId = space.id;
    mine = await credentialFor(spaceId, `acme/${slug}-mine`);
    sibling = await credentialFor(spaceId, `acme/${slug}-sibling`);
  });

  async function activityRows(): Promise<Item[]> {
    const page = await ctx.storage.items.list({
      type: "system.activity",
      spaceId,
    });
    return page.data;
  }

  it("refuses to attribute activity to a sibling Connection", async () => {
    const target = await activityRow(mine, `own-${String(seq++)}`);

    const res = await door.write({
      key: mine.key,
      target,
      properties: {
        connection_id: sibling.connectionId,
        severity: "action_required",
        summary: "hijacked",
      },
    });

    if (door.refuses === "status") {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    // The outcome every door has to agree on, whatever it returns: no row
    // written under this credential's provenance speaks for a Connection
    // that is not its own. Keyed on `source` rather than on the row set,
    // so a sibling's own legitimate rows never look like a breach.
    const stolen = (await activityRows()).filter(
      (row) =>
        row.source === mine.itemSource &&
        row.properties.connection_id === sibling.connectionId,
    );
    expect(stolen).toHaveLength(0);

    const after = await ctx.storage.items.get(target.id, spaceId);
    expect(after?.properties.connection_id).toBe(mine.connectionId);
    expect(after?.properties.severity).toBe("info");
    expect(after?.properties.summary).toBe("sync complete");
  });

  it("leaves a sibling's activity row alone", async () => {
    // No `connection_id` in the write at all. The row is not this
    // credential's to touch whatever the request says, so a door judging
    // only the properties it was handed would let this through.
    const target = await activityRow(sibling, `sib-${String(seq++)}`);

    await door.write({
      key: mine.key,
      target,
      properties: { severity: "action_required", summary: "hijacked" },
    });

    const after = await ctx.storage.items.get(target.id, spaceId);
    expect(after?.properties.connection_id).toBe(sibling.connectionId);
    expect(after?.properties.severity).toBe("info");
    expect(after?.properties.summary).toBe("sync complete");
  });

  it("refuses to claim a sibling's activity row", async () => {
    // The case judging the merged result cannot catch: the row belongs
    // to a sibling and the write names this credential's own connection,
    // so afterwards it reads as a credential writing its own activity.
    // Only the row as it stands says otherwise. No status assertion —
    // the create door has no row to claim and legitimately writes a new
    // one, and it is the sibling's row being untouched that every door
    // has to agree on.
    const target = await activityRow(sibling, `claim-${String(seq++)}`);

    await door.write({
      key: mine.key,
      target,
      properties: {
        connection_id: mine.connectionId,
        severity: "action_required",
        summary: "actually mine",
      },
    });

    const after = await ctx.storage.items.get(target.id, spaceId);
    expect(after?.properties.connection_id).toBe(sibling.connectionId);
    expect(after?.properties.severity).toBe("info");
    expect(after?.properties.summary).toBe("sync complete");
  });

  it("still writes the credential's own activity", async () => {
    // The gate has to admit the only thing an integration legitimately does
    // with this type, or the runtime SDK's activity sink stops reporting
    // on every run and nothing says so.
    const target = await activityRow(mine, `ok-${String(seq++)}`);
    const summary = `sync complete (${String(seq)} items)`;

    const res = await door.write({
      key: mine.key,
      target,
      properties: {
        connection_id: mine.connectionId,
        severity: "info",
        summary,
      },
    });
    expect(res.status).toBeLessThan(400);

    const landed = (await activityRows()).filter(
      (row) =>
        row.properties.summary === summary &&
        row.properties.connection_id === mine.connectionId,
    );
    expect(landed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe("every route that can write an item is accounted for", () => {
  it("has a door row or a stated reason it is not one", () => {
    const registered = new Set(
      ctx.app.routes.map((r) => `${r.method} ${r.path}`),
    );
    const covered = new Set(DOORS.map((d) => d.route));

    const unclassified = new Set<string>();
    for (const route of registered) {
      const [method, path] = route.split(" ");
      if (!path?.startsWith("/items")) continue;
      if (!["POST", "PUT", "PATCH"].includes(method ?? "")) continue;
      if (covered.has(route)) continue;
      if (route in NOT_A_PROPERTIES_DOOR) continue;
      unclassified.add(route);
    }

    // A new route that mutates items lands here. Give it a row in
    // `DOORS` if it can write properties, or an entry in
    // `NOT_A_PROPERTIES_DOOR` saying why it cannot — deciding which is
    // the whole point.
    expect([...unclassified]).toEqual([]);

    // The other direction: an entry left behind after its route was
    // renamed or removed stops excluding anything, silently, and the
    // next route to take that name inherits the excuse.
    for (const route of Object.keys(NOT_A_PROPERTIES_DOOR)) {
      expect(registered.has(route), `stale exclusion: ${route}`).toBe(true);
    }
    for (const route of covered) {
      expect(registered.has(route), `stale door: ${route}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The other axes: lifecycle, metadata, extensions
// ---------------------------------------------------------------------------

/**
 * The doors above write an item's `properties`. These reach the same row
 * by id and change something else about it: its lifecycle state, its tags
 * and metadata, its extension namespaces.
 *
 * They were open to a credential the properties doors refuse. Same space,
 * same type filter, different axis, and `system.activity` sits in every
 * runtime credential's type filter because that grant is what lets a
 * integration report its own progress. So a type check alone admits every
 * sibling integration's rows, and a type check alone was all these had.
 *
 * They share one row-level gate rather than each carrying a call, and this
 * table is the reason that shape was chosen: five doors have now been
 * found reaching state their caller had no permission for, four of them
 * because a person thought to ask. Enumeration was never the reliable
 * part.
 */
interface RowDoor {
  name: string;
  /** Act on a row owned by someone else. Refusal is the property. */
  act(key: string, targetId: string): Promise<Response>;
}

const ROW_DOORS: RowDoor[] = [
  {
    name: "POST /items/{id}/transition",
    act: (key, id) =>
      request(ctx.app, "POST", `/items/${id}/transition`, {
        key,
        body: { state: "archived" },
      }),
  },
  {
    name: "POST /items/{id}/tags",
    act: (key, id) =>
      request(ctx.app, "POST", `/items/${id}/tags`, {
        key,
        body: { tags: ["intruded"] },
      }),
  },
  {
    name: "PUT /items/{id}/metadata",
    act: (key, id) =>
      request(ctx.app, "PUT", `/items/${id}/metadata`, {
        key,
        body: { tags: ["intruded"] },
      }),
  },
  {
    name: "PATCH /items/{id}/metadata",
    act: (key, id) =>
      request(ctx.app, "PATCH", `/items/${id}/metadata`, {
        key,
        body: { tags: ["intruded"] },
      }),
  },
  {
    name: "PUT /items/{id}/extensions/{namespace}",
    act: (key, id) =>
      request(ctx.app, "PUT", `/items/${id}/extensions/acme.probe`, {
        key,
        body: { data: { intruded: true } },
      }),
  },
];

describe.each(ROW_DOORS)("$name", (door) => {
  let spaceId: string;
  let mine: Credential;
  let sibling: Credential;

  beforeAll(async () => {
    const slug = door.name.replace(/[^a-z]+/gi, "-").toLowerCase();
    const space = await ctx.storage.spaces!.create(slug);
    spaceId = space.id;
    mine = await credentialFor(spaceId, `acme/${slug}-mine`);
    sibling = await credentialFor(spaceId, `acme/${slug}-sib`);
  });

  it("refuses to reach a sibling Connection's row", async () => {
    const target = await activityRow(sibling, `row-${String(Math.random())}`);
    const res = await door.act(mine.key, target.id);
    expect(res.status).toBe(403);
  });

  it("still reaches the credential's own row", async () => {
    // A gate that refuses everyone passes the case above and breaks every
    // legitimate integration, so the permissive direction is asserted too.
    const own = await activityRow(mine, `own-${String(Math.random())}`);
    const res = await door.act(mine.key, own.id);
    // Not "succeeds" — some of these then fail downstream for reasons
    // unrelated to authorization, such as a system.activity row having no
    // valid target in the universal three-state lifecycle. The property
    // under test is that the gate did not refuse it, and 403 is what a
    // blanket refuse returns.
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// `tier` is server-owned on system.* rows, on every door
// ---------------------------------------------------------------------------

/**
 * Create refused a caller-supplied `tier` on a `system.*` type and the
 * update doors accepted one. Fixing it on a single door would have made a
 * fresh disagreement of exactly the kind the table above exists to close,
 * so it is one rule reached from all of them.
 */
describe("tier on a system.* row", () => {
  let spaceId: string;
  let mine: Credential;

  beforeAll(async () => {
    const space = await ctx.storage.spaces!.create("tier-rules");
    spaceId = space.id;
    mine = await credentialFor(spaceId, "acme/tier-rules");
  });

  it("is refused on create, and on every door that updates", async () => {
    const create = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "system.activity",
        tier: "library",
        properties: {
          connection_id: mine.connectionId,
          severity: "info",
          summary: "tier probe",
        },
      },
    });
    expect(create.status).toBe(400);

    const row = await activityRow(mine, `tier-${String(Math.random())}`);

    const patch = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: mine.key,
      body: { tier: "library" },
    });
    expect(patch.status).toBe(400);

    const bulkById = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        atomic: true,
        items: [{ id: row.id, type: "system.activity", tier: "library" }],
      },
    });
    expect(bulkById.status).toBeGreaterThanOrEqual(400);
  });
});
