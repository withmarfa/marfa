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
    publisher: "acme",
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
  /**
   * The door's write, naming a type that is NOT the row's wherever it can.
   *
   * **The misdeclaration is load-bearing and was nearly lost.** The
   * claim-side gates run on the type the body names, and the row-side
   * gates on the type the row is; naming the row's own type fires the
   * claim-side one first and the write never reaches the gates these
   * tests are measuring. Every refusal below then passes for the wrong
   * reason, and this file stops speaking for the doors it names.
   *
   * That is not hypothetical. Changing these to `system.activity` — which
   * looked like the honest fix once a misdeclaration became refusable —
   * left `requireTypeAccess`, both `requireActivityAttribution` calls and
   * `requireMirrorProtection` deletable on two doors with the whole file
   * still green.
   */
  write(w: DoorWrite): Promise<Response>;
  /**
   * The same write naming the row's real type, for the success case.
   *
   * Separate from `write` because the success case is the one place a
   * misdeclaration can no longer be used: the gates pass, so nothing
   * refuses until the type-claim guard does. Identical to `write` on the
   * doors that never misdeclare.
   */
  writeTruthful(w: DoorWrite): Promise<Response>;
  /**
   * A write naming a type that is not the row's, for the type-claim test.
   *
   * Usually the same call as `write`, because the misdeclaration `write`
   * already makes IS the mismatch. `PATCH` is the exception: its gates
   * all run on the resolved row, so it needs no misdeclaration to isolate
   * them, and its type-claim guard runs ahead of them — so a misdeclaring
   * `write` there would refuse first and mask every gate below it.
   *
   * Required unless the door is named in `CANNOT_MISDECLARE`, and the
   * coverage check at the bottom enforces that rather than letting an
   * absent hook read as a deliberate exemption.
   */
  misdeclareType?: (w: DoorWrite) => Promise<Response>;
}

/**
 * Doors whose `write` names the row's own type, so they cannot express a
 * mismatch and are exempt from the type-claim test.
 *
 * Named rather than left to an absent field: an optional hook makes a
 * door added without one a silently skipped test, indistinguishable from
 * a deliberate exemption, which is the failure the coverage check at the
 * bottom of this file exists to prevent.
 */
const CANNOT_MISDECLARE: Record<string, string> = {
  "POST /items (create)":
    "resolves no row, so the type it names IS the row — nothing to disagree with",
  "POST /items/bulk-actions (update_properties)":
    "selects by filter, where a type is a selector: it cannot disagree with the rows it selected on",
};

/**
 * The door writes, parameterized by the type they declare.
 *
 * Written once each and called twice rather than spelled out per variant:
 * the misdeclaring write and the truthful one have to be the same request
 * in every respect but the type, or the pair stops isolating the type.
 */
/**
 * The rule that refused a write, or null if it was not refused.
 *
 * The refusal tests below assert this rather than a bare status, and the
 * reason is the whole point. Asserting "refused, and the row is
 * unchanged" is satisfied by ANY refusal, so the day a new guard is added
 * upstream of the gates this file measures, every test here keeps passing
 * while the gates underneath can be deleted one by one. That is not
 * hypothetical: adding the type-claim guard did exactly that, and
 * `requireTypeAccess`, both `requireActivityAttribution` calls and
 * `requireMirrorProtection` were all individually deletable with the
 * whole file green.
 *
 * Unwraps `bulk_atomic_rollback`, which is the envelope the bulk door
 * puts a per-entry refusal in rather than a reason of its own.
 */
async function refusalCode(res: Response): Promise<string | null> {
  if (res.status < 400) return null;
  const body = (await res.clone().json()) as {
    error?: { code?: string; details?: { code?: string } };
  };
  const code = body.error?.code ?? null;
  if (code === "bulk_atomic_rollback") {
    return body.error?.details?.code ?? code;
  }
  return code;
}

const bulkActionWrite = async ({
  key,
  properties,
}: DoorWrite): Promise<Response> => {
  // Filter-in rather than id-in, so one call reaches every activity row
  // in the space without knowing a single id — the widest of the doors.
  // `runBulkActionAsync` drains the worker, so the write really lands or
  // really does not rather than stopping at a queued job that nothing
  // in-process would ever pick up.
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
};

const createWrite = ({ key, properties }: DoorWrite): Promise<Response> =>
  request(ctx.app, "POST", "/items", {
    key,
    body: { type: "system.activity", properties },
  });

const naturalKeyWrite =
  (type: string) =>
  ({ key, target, properties }: DoorWrite): Promise<Response> =>
    request(ctx.app, "POST", "/items", {
      key,
      body: { type, source_id: target.source_id, properties },
    });

const patchWrite =
  (type: string | undefined) =>
  ({ key, target, properties }: DoorWrite): Promise<Response> =>
    request(ctx.app, "PATCH", `/items/${target.id}`, {
      key,
      body: type === undefined ? { properties } : { type, properties },
    });

const bulkByIdWrite =
  (type: string) =>
  ({ key, target, properties }: DoorWrite): Promise<Response> =>
    request(ctx.app, "POST", "/items/bulk", {
      key,
      body: { items: [{ id: target.id, type, properties }] },
    });

const bulkNaturalKeyWrite =
  (type: string) =>
  ({ key, target, properties }: DoorWrite): Promise<Response> =>
    request(ctx.app, "POST", "/items/bulk", {
      key,
      body: { items: [{ source_id: target.source_id, type, properties }] },
    });

const DOORS: Door[] = [
  {
    name: "POST /items (create)",
    route: "POST /items",
    refuses: "status",
    // No `target`: the row this lands on is the one the body describes,
    // which is also why there is no type here to misdeclare.
    write: createWrite,
    writeTruthful: createWrite,
  },
  {
    name: "POST /items (natural-key upsert)",
    route: "POST /items",
    refuses: "status",
    // `core.note` is a type this credential genuinely holds write on, so
    // the claim passes every gate that reads it — leaving only the gates
    // keyed on the resolved row able to refuse, which is the point.
    write: naturalKeyWrite("core.note"),
    writeTruthful: naturalKeyWrite("system.activity"),
    misdeclareType: naturalKeyWrite("core.note"),
  },
  {
    name: "PATCH /items/{id}",
    route: "PATCH /items/:id",
    refuses: "status",
    // Every gate on this door runs on the resolved row, so there is no
    // claim-side gate to keep out of the way and `write` carries no type
    // at all. It must not carry one: the type-claim guard here runs ahead
    // of the attribution gates, so a misdeclaring `write` would refuse
    // first and leave them untested.
    write: patchWrite(undefined),
    writeTruthful: patchWrite(undefined),
    misdeclareType: patchWrite("core.note"),
  },
  {
    name: "POST /items/bulk (by id)",
    route: "POST /items/bulk",
    refuses: "status",
    write: bulkByIdWrite("core.note"),
    writeTruthful: bulkByIdWrite("system.activity"),
    misdeclareType: bulkByIdWrite("core.note"),
  },
  {
    name: "POST /items/bulk (natural key)",
    route: "POST /items/bulk",
    refuses: "status",
    write: bulkNaturalKeyWrite("core.note"),
    writeTruthful: bulkNaturalKeyWrite("system.activity"),
    misdeclareType: bulkNaturalKeyWrite("core.note"),
  },
  {
    name: "POST /items/bulk-actions (update_properties)",
    route: "POST /items/bulk-actions",
    refuses: "narrowing",
    // The `type` here selects rather than claims, so this door is the one
    // place `write` and `writeTruthful` are the same call for a reason
    // other than "it carries no type".
    write: bulkActionWrite,
    writeTruthful: bulkActionWrite,
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
      // Not merely refused: refused by an attribution rule. Without this
      // the type-claim guard answers for every door and the gates below
      // could all be removed unnoticed.
      expect(await refusalCode(res)).not.toBe("type_mismatch");
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

    const res = await door.write({
      key: mine.key,
      target,
      properties: { severity: "action_required", summary: "hijacked" },
    });
    expect(await refusalCode(res)).not.toBe("type_mismatch");

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

    const res = await door.write({
      key: mine.key,
      target,
      properties: {
        connection_id: mine.connectionId,
        severity: "action_required",
        summary: "actually mine",
      },
    });
    expect(await refusalCode(res)).not.toBe("type_mismatch");

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

    // `writeTruthful`, not `write`: this is the one case where the gates
    // all pass, so a misdeclared type would be the only thing left to
    // refuse it and the test would be measuring the type-claim guard
    // instead of the gate it is named for.
    const res = await door.writeTruthful({
      key: mine.key,
      target,
      properties: {
        connection_id: mine.connectionId,
        severity: "info",
        summary,
      },
    });
    expect(res.status, await res.clone().text()).toBeLessThan(400);

    const landed = (await activityRows()).filter(
      (row) =>
        row.properties.summary === summary &&
        row.properties.connection_id === mine.connectionId,
    );
    expect(landed.length).toBeGreaterThan(0);
  });

  it.skipIf(door.name in CANNOT_MISDECLARE)(
    "refuses a write that names a type the row is not",
    async () => {
      // The ordinary `write`, which already names a type the row is not.
      // Nothing extra is needed to express the mismatch: the gates above
      // are measured with badly-attributed properties, and this is the
      // same request with good ones, so the declared type is the only
      // thing left that can refuse it.
      //
      // Everything here is the credential's own: its row, its
      // `connection_id`, and `core.note` is a type its manifest declares
      // and it genuinely holds write on. So every gate above passes and
      // the declared type is the only thing left that can refuse it.
      //
      // The test immediately above is the other half of the pair: the
      // same key, the same row and the same shape, declaring the type the
      // row really is, and it must succeed. One difference between them,
      // one difference in outcome.
      //
      // Worth a row of its own because moving the gates onto the resolved
      // row closed the escalation and left the claim merely meaningless
      // rather than refused — a body naming one type while resolving a
      // row of another was merged in, 200, nothing said. Reachable from
      // both directions the moment a person can map a source onto a type:
      // adding a mapping re-types on the way in, removing it re-types on
      // the way back. No integration reads the type of the row it writes,
      // and five hold no item id they could read it by, so the door is
      // the only place it can be caught.
      const target = await activityRow(mine, `type-${String(seq++)}`);

      const misdeclare = door.misdeclareType;
      /* v8 ignore next */
      if (!misdeclare) throw new Error("guarded by skipIf");
      const res = await misdeclare({
        key: mine.key,
        target,
        properties: {
          connection_id: mine.connectionId,
          severity: "action_required",
          summary: "re-typed",
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await refusalCode(res)).toBe("type_mismatch");

      // The status is not the property. A door that answered an error
      // after writing would satisfy the line above and still have
      // corrupted the row, which is the failure this whole file exists
      // to catch.
      const after = await ctx.storage.items.get(target.id, spaceId);
      expect(after?.type).toBe("system.activity");
      expect(after?.properties.severity).toBe("info");
      expect(after?.properties.summary).toBe("sync complete");
    },
  );
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

  it("states why a door cannot express a type mismatch, rather than skipping quietly", () => {
    // The type-claim test skips a door named in `CANNOT_MISDECLARE`. Left
    // to an optional field instead, a door added without one would skip
    // for no stated reason and read exactly like a deliberate exemption —
    // which is the shape this whole file exists to refuse.
    const names = new Set(DOORS.map((d) => d.name));
    for (const name of Object.keys(CANNOT_MISDECLARE)) {
      expect(names.has(name), `stale exemption: ${name}`).toBe(true);
    }

    // And the exemption has to be earned: every other door's `write` must
    // actually name a type that is not the row's, or its type-claim test
    // is passing on something else.
    for (const door of DOORS) {
      if (door.name in CANNOT_MISDECLARE) continue;
      expect(
        door.misdeclareType !== undefined,
        `${door.name}: needs a misdeclareType, or a stated reason in CANNOT_MISDECLARE`,
      ).toBe(true);
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
