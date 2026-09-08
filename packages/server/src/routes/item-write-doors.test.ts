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
    runs_on: "server" as const,
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

async function integrationFor(name: string): Promise<string> {
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
  return integration.id;
}

/**
 * A Connection of `name`, and a runtime credential for it.
 *
 * `integrationId` is a parameter so two Connections can be built on ONE
 * integration. That is not a convenience: `item_source` is keyed on the
 * manifest name, so two Connections of the same integration share it, and
 * sharing it is the only way a natural-key door resolves a row this
 * credential did not write. Without a second Connection built this way the
 * row-side gates on those doors have nothing to refuse and are deletable
 * with this whole file green.
 */
async function credentialFor(
  spaceId: string,
  name: string,
  integrationId?: string,
): Promise<Credential> {
  const integration = { id: integrationId ?? (await integrationFor(name)) };
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
    "carries no natural key, so it resolves no row and the type it names IS the row — nothing to disagree with. Supplying an `id` that already exists DOES resolve one, but that path writes nothing and returns the row, so it fits none of the write-shaped assertions here; its gates are covered in repeated-create-acknowledgement.test.ts",
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
 * Mirror protection, on the doors where it can actually refuse.
 *
 * `permitsMirrorWrite` admits a row whose `source` is not an integration's,
 * or whose source is the caller's own `item_source`. Two consequences decide
 * where it can be tested at all:
 *
 *  - **Not on the natural-key doors.** `stampedSource` is `item_source ??
 *    source` and the lookup keys on it, so a row resolved by natural key
 *    always carries the caller's own source and the predicate compares a
 *    value with itself. Deleting the call from that branch leaves this file
 *    and `mirror-rule.test.ts` green, and that is unreachability rather than
 *    a coverage gap — there is no fixture that would redden it.
 *  - **Not through `system.activity` anywhere.** The attribution gate runs
 *    immediately before it and refuses first, which is what shadowed this on
 *    every door that resolves a foreign row.
 *
 * So the row here is a `core.note` — in the manifest's `target_types`, so
 * both credentials genuinely hold write on it, and outside the attribution
 * rule entirely. Addressed by id, which is the only way to reach a row whose
 * source is not the caller's. `mirror-rule.test.ts` asserts this rule through
 * `PATCH /items/{id}` alone; these are the sibling doors it does not reach.
 */
describe("mirror protection on the by-id doors", () => {
  let spaceId: string;
  let mine: Credential;
  let sibling: Credential;

  beforeAll(async () => {
    const space = await ctx.storage.spaces!.create("mirror-by-id");
    spaceId = space.id;
    mine = await credentialFor(spaceId, "acme/mirror-mine");
    sibling = await credentialFor(spaceId, "acme/mirror-sibling");
  });

  /** A note owned by `owner`, carrying that integration's provenance. */
  async function noteOwnedBy(owner: Credential): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: owner.key,
      body: {
        type: "core.note",
        source_id: `note-${Math.random().toString(36).slice(2, 10)}`,
        properties: { body: "the owning integration's copy" },
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  }

  it("refuses PATCH /items/{id} on another integration's mirror", async () => {
    const id = await noteOwnedBy(sibling);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: mine.key,
      body: { properties: { body: "overwritten" } },
    });
    // The rule that refused, not merely that something did.
    expect(await refusalCode(res)).toBe("integration_owned");
    const after = await ctx.storage.items.get(id, spaceId);
    expect(after?.properties.body).toBe("the owning integration's copy");
  });

  it("refuses POST /items/bulk (by id) on another integration's mirror", async () => {
    const id = await noteOwnedBy(sibling);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: { items: [{ id, type: "core.note", properties: { body: "x" } }] },
    });
    expect(await refusalCode(res)).toBe("integration_owned");
    const after = await ctx.storage.items.get(id, spaceId);
    expect(after?.properties.body).toBe("the owning integration's copy");
  });

  it("still writes the owning integration's own mirror", async () => {
    // The permissive direction. Without it a guard that refuses everything
    // satisfies both assertions above and this file would not notice.
    const id = await noteOwnedBy(mine);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: mine.key,
      body: { properties: { body: "its own update" } },
    });
    expect(res.status).toBe(200);
    const after = await ctx.storage.items.get(id, spaceId);
    expect(after?.properties.body).toBe("its own update");
  });
});

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

/**
 * Two Connections of ONE integration, which is the case `source` cannot see.
 *
 * `runtimeCredentialItemSource` stamps `integration:<manifest name>` for every
 * Connection of an integration in a space, deliberately, so a reinstall adopts
 * the corpus it created (D34). The cost is that two live Connections share a
 * natural-key namespace and `permitsMirrorWrite` — which compares that same
 * shared string — treats them as one writer by construction. The row's
 * recorded writer is the axis that tells them apart (D63).
 *
 * On `core.note` rather than `system.activity`, for the reason the mirror
 * block above gives: attribution is a different gate with its own refusal, and
 * a note is outside it, so nothing shadows the one being measured here.
 */
describe("two connections of one integration (D63)", () => {
  let spaceId: string;
  let mine: Credential;
  let twin: Credential;
  let seq = 0;

  beforeAll(async () => {
    const space = await ctx.storage.spaces!.create("provenance-collision");
    spaceId = space.id;
    const shared = await integrationFor("acme/collide");
    mine = await credentialFor(spaceId, "acme/collide", shared);
    twin = await credentialFor(spaceId, "acme/collide", shared);
  });

  const key = (): string => `rec-${String(seq++)}`;

  async function noteBy(
    owner: Credential,
    sourceId: string,
    body = "the owner's copy",
  ): Promise<Response> {
    return request(ctx.app, "POST", "/items", {
      key: owner.key,
      body: { type: "core.note", source_id: sourceId, properties: { body } },
    });
  }

  it("the two credentials really do share one provenance stamp", () => {
    // The precondition, asserted rather than assumed. Without this equality
    // `mine`'s natural key never resolves `twin`'s row at all: the write
    // falls through to create, every case below passes, and none of them is
    // testing what its name says. This file records that exact failure
    // having happened once already.
    expect(mine.itemSource).toBe(twin.itemSource);
    expect(mine.connectionId).not.toBe(twin.connectionId);
  });

  it("refuses a write that resolves a live twin's row, and names the owner", async () => {
    const sourceId = key();
    expect((await noteBy(twin, sourceId)).status).toBe(201);

    const res = await noteBy(mine, sourceId, "overwritten");
    expect(await refusalCode(res)).toBe("provenance_collision");

    const body = (await res.json()) as {
      error?: { details?: { owning_connection_id?: string } };
    };
    expect(body.error?.details?.owning_connection_id).toBe(twin.connectionId);

    // Refused, not merged: the row is byte-for-byte the twin's.
    const page = await ctx.storage.items.list({ spaceId, type: "core.note" });
    const row = page.data.find((i) => i.source_id === sourceId);
    expect(row?.properties.body).toBe("the owner's copy");
  });

  it("each connection keeps its own row", async () => {
    // The acceptance criterion, and the positive case that stops the
    // refusal above meaning "this guard refuses everything". A guard that
    // refused unconditionally passes the previous test and fails this one.
    const mineKey = key();
    const twinKey = key();
    expect((await noteBy(twin, twinKey, "twin's")).status).toBe(201);
    expect((await noteBy(mine, mineKey, "mine")).status).toBe(201);

    const page = await ctx.storage.items.list({ spaceId, type: "core.note" });
    const twinRow = page.data.find((i) => i.source_id === twinKey);
    const mineRow = page.data.find((i) => i.source_id === mineKey);
    expect(twinRow).toBeDefined();
    expect(mineRow).toBeDefined();
    expect(twinRow!.id).not.toBe(mineRow!.id);

    const writers = await ctx.storage.items.writersOf([
      twinRow!.id,
      mineRow!.id,
    ]);
    expect(writers.get(twinRow!.id)).toBe(twin.connectionId);
    expect(writers.get(mineRow!.id)).toBe(mine.connectionId);
  });

  it("does not refuse the owner re-syncing its own row", async () => {
    const sourceId = key();
    const first = await noteBy(twin, sourceId, "v1");
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { item: { id: string } }).item.id;

    const second = await noteBy(twin, sourceId, "v2");
    expect(second.status).toBe(200);
    expect(((await second.json()) as { item: { id: string } }).item.id).toBe(
      firstId,
    );
  });

  it("refuses on the trashed arm rather than acknowledging the twin's row", async () => {
    // The single highest-value case here. The trashed branch answers 200
    // with the row AND its metadata before the update arm is reached, so a
    // guard placed only in the update arm hands a sibling its twin's row
    // and calls it an acknowledgement. Deleting the hoisted call reddens
    // this case and nothing else.
    const sourceId = key();
    const created = await noteBy(twin, sourceId, "then trashed");
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { item: { id: string } }).item.id;
    await ctx.storage.items.delete(id, spaceId);

    const res = await noteBy(mine, sourceId, "claiming it");
    expect(await refusalCode(res)).toBe("provenance_collision");
  });

  it("refuses create_only rather than reporting the twin's row as a duplicate", async () => {
    // `skipped / duplicate_source` reads as "already stored" and sends the
    // handler on believing its own record is present. It is not: the row
    // belongs to somebody else.
    const sourceId = key();
    expect((await noteBy(twin, sourceId)).status).toBe(201);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: mine.key,
      body: {
        mode: "create_only",
        atomic: false,
        items: [
          { type: "core.note", source_id: sourceId, properties: { body: "x" } },
        ],
      },
    });
    const body = (await res.json()) as {
      results?: { outcome?: string; error?: { code?: string } }[];
    };
    expect(body.results?.[0]?.outcome).toBe("errored");
    expect(body.results?.[0]?.error?.code).toBe("provenance_collision");
  });

  it("refuses PATCH by id on a live twin's row", async () => {
    const sourceId = key();
    const created = await noteBy(twin, sourceId);
    const id = ((await created.json()) as { item: { id: string } }).item.id;

    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: mine.key,
      body: { properties: { body: "overwritten" } },
    });
    expect(await refusalCode(res)).toBe("provenance_collision");
  });

  it("adopts a row that records no writer, and stamps itself", async () => {
    // Every row written before this column existed is in this state, which
    // is why there is no backfill. Proved in the code rather than asserted
    // in a comment.
    const sourceId = key();
    const row = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "pre-column" },
        source: mine.itemSource,
        source_id: sourceId,
      },
      spaceId,
    );
    expect(
      (await ctx.storage.items.writersOf([row.id])).get(row.id),
    ).toBeNull();

    const res = await noteBy(mine, sourceId, "adopted");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: { id: string } }).item.id).toBe(
      row.id,
    );
    expect((await ctx.storage.items.writersOf([row.id])).get(row.id)).toBe(
      mine.connectionId,
    );
  });
});

// ---------------------------------------------------------------------------
// The agreement
// ---------------------------------------------------------------------------

describe.each(DOORS)("$name", (door) => {
  let spaceId: string;
  let mine: Credential;
  let sibling: Credential;
  let twin: Credential;
  let seq = 0;

  beforeAll(async () => {
    const slug = door.name.replace(/[^a-z]+/gi, "-").toLowerCase();
    const space = await ctx.storage.spaces!.create(slug);
    spaceId = space.id;
    const ownIntegration = await integrationFor(`acme/${slug}-mine`);
    mine = await credentialFor(spaceId, `acme/${slug}-mine`, ownIntegration);
    // A second Connection of the SAME integration, so it shares `mine`'s
    // `item_source` and its rows are reachable by `mine`'s natural key.
    // A different manifest name would put them beyond `findBySourceId`,
    // which is what left the row-side gates unreachable on those doors.
    twin = await credentialFor(spaceId, `acme/${slug}-mine`, ownIntegration);
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

  it("refuses to claim a row its own source resolves but a twin owns", async () => {
    // The scenario the row-side attribution gate is the ONLY thing that can
    // refuse, and the one this file could not express until `twin` existed.
    //
    // `twin` is a second Connection of the same integration, so it shares
    // `mine`'s `item_source` and this row IS resolvable by `mine`'s natural
    // key — where a `sibling`'s row is not, and the write falls through to
    // create without ever touching a row. The claim-side check passes
    // because the write names `mine`'s own connection; only the row as it
    // stands says the row is not `mine`'s to speak for.
    const target = await activityRow(twin, `twin-${String(seq++)}`);

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
    expect(after?.properties.connection_id).toBe(twin.connectionId);
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
    const considered = new Set<string>();
    for (const route of registered) {
      const [method, path] = route.split(" ");
      if (!path?.startsWith("/items")) continue;
      if (!["POST", "PUT", "PATCH"].includes(method ?? "")) continue;
      considered.add(route);
      if (covered.has(route)) continue;
      if (route in NOT_A_PROPERTIES_DOOR) continue;
      unclassified.add(route);
    }

    // The control, and the boundary this filter draws.
    //
    // A prefix walk that matched nothing would pass both assertions above
    // having measured nothing — the shape a renamed mount or a moved route
    // produces. So assert it found the doors it is looking for.
    expect(registered.size).toBeGreaterThan(50);
    expect(considered.size).toBeGreaterThan(3);
    expect(considered.has("POST /items")).toBe(true);

    // **And what it cannot see, stated rather than implied.** The scope is a
    // URL prefix, so it covers routes mounted under `/items` and nothing
    // else. Twenty-eight files call an item write; two of them are route
    // files under `/items`. The rest reach the store from `/credentials`,
    // `/auth`, `/admin` and `/connections`, and from the connections
    // pipeline, which serves no route at all.
    //
    // `idempotent-write-doors.test.ts` derives its scope from the tree
    // instead, and its header argues against exactly this walk. Bringing
    // this one onto that mechanism is T-1302: the walk is already
    // generic, and the work is the twenty-three writers it makes visible,
    // each needing a row or a stated reason. Sized rather than started, so
    // this control is not mistaken for the fix.

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

/**
 * D64 — an integration may only destroy what it wrote.
 *
 * The other half of the block above, and the same predicate: if connection B
 * may not overwrite connection A's row, it cannot be right that B may destroy
 * it, because there is no coherent position in which the stronger harm is the
 * less protected one.
 *
 * **In this file rather than one of its own, deliberately.** These cases need
 * exactly the fixture above — two live connections of one integration in one
 * space, sharing a provenance stamp — and a second copy of that fixture is
 * the drift this file already argues against. The two rules are one model.
 *
 * The doors are enumerated because enumerating them was never the reliable
 * part: `DELETE /items/{id}` — including every row its cascade reaches —
 * `POST /items/{id}/transition`, `POST /items/{id}/restore`, and the bulk
 * route's `transition` arm. Each has its own named case, so deleting one
 * door's guard reddens that door rather than merely the suite.
 *
 * **Both purge doors are absent from that list on purpose**, and one case
 * says so: a runtime credential is refused at each door's own gate, so there
 * is nothing here for provenance to decide. The bulk route's `update_tags`,
 * `update_tier` and `update_timestamp` arms are outside D64 and still reach
 * a sibling's rows; that is recorded as its own finding rather than being
 * quietly widened here.
 */
describe("destroying a sibling's row (D64)", () => {
  let spaceId: string;
  let mine: Credential;
  let twin: Credential;
  let seq = 0;

  beforeAll(async () => {
    const space = await ctx.storage.spaces!.create("provenance-destroy");
    spaceId = space.id;
    const shared = await integrationFor("acme/destroy");
    mine = await credentialFor(spaceId, "acme/destroy", shared);
    twin = await credentialFor(spaceId, "acme/destroy", shared);
  });

  const key = (): string => `del-${String(seq++)}`;

  /** A row the twin wrote, returned by id. */
  async function twinRow(): Promise<string> {
    const sourceId = key();
    const res = await request(ctx.app, "POST", "/items", {
      key: twin.key,
      body: {
        type: "core.note",
        source_id: sourceId,
        properties: { body: "the twin's" },
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  }

  it("the fixture really is two live connections sharing one stamp", () => {
    // The precondition. Without the shared stamp the guard short-circuits
    // before it reads anything, every case below passes, and none of them
    // tests what its name says.
    expect(mine.itemSource).toBe(twin.itemSource);
    expect(mine.connectionId).not.toBe(twin.connectionId);
  });

  it("refuses DELETE /items/{id} on a live twin's row", async () => {
    const id = await twinRow();
    const res = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: mine.key,
    });
    expect(await refusalCode(res)).toBe("provenance_collision");

    // Refused, not half-applied.
    const row = await ctx.storage.items.get(id, spaceId);
    expect(row?.state).toBe("active");
  });

  it("closes both purge doors to an integration at their own gates, before provenance", async () => {
    // Not a provenance refusal, and worth a case saying so. Both doors ask
    // for `space.item_purge` — the same act on one row or on many — and a
    // runtime credential holds no space permission at all, so an integration
    // never reaches the point where D64 would have an opinion. A guard there
    // would be unreachable code no test could pin.
    //
    // This is the case that reddens if either door ever widens, which is
    // what makes leaving the guard out safe rather than merely tidy.
    const id = await twinRow();
    const single = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: mine.key,
    });
    expect(await refusalCode(single)).toBe("forbidden");
    expect(await ctx.storage.items.get(id, spaceId)).not.toBeNull();

    const bulk = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: { type: "core.note", source: mine.itemSource },
      },
      mine.key,
    );
    expect(bulk.initialStatus).toBe(403);
    expect(await ctx.storage.items.get(id, spaceId)).not.toBeNull();
  });

  it("refuses POST /items/{id}/transition on a live twin's row", async () => {
    // The door the bulk route's filter reaches one row at a time, and the
    // one the old exemption was written for.
    const id = await twinRow();
    const res = await request(ctx.app, "POST", `/items/${id}/transition`, {
      key: mine.key,
      body: { state: "trashed" },
    });
    expect(await refusalCode(res)).toBe("provenance_collision");
    const row = await ctx.storage.items.get(id, spaceId);
    expect(row?.state).toBe("active");
  });

  it("refuses POST /items/{id}/restore on a live twin's row", async () => {
    // Not destructive, and guarded anyway: the rule follows the actor, and
    // a connection with no claim to trash a sibling's row has none to
    // un-trash one either.
    const id = await twinRow();
    await ctx.storage.items.transition(id, "trashed", spaceId);
    const res = await request(ctx.app, "POST", `/items/${id}/restore`, {
      key: mine.key,
    });
    expect(await refusalCode(res)).toBe("provenance_collision");
  });

  it("narrows a bulk transition to rows the caller wrote", async () => {
    // The call the ticket was filed on: `filter.source` names the stamp both
    // connections share, so one request reached every row the sibling wrote.
    // Narrowed rather than refused, which is this route's answer on every
    // other axis — one unreachable row must not fail an action over
    // thousands.
    const theirs = await twinRow();
    const mineRes = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "core.note",
        source_id: key(),
        properties: { body: "mine" },
      },
    });
    expect(mineRes.status).toBe(201);
    const ours = ((await mineRes.json()) as { item: { id: string } }).item.id;

    const run = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "trashed",
        filter: { type: "core.note", source: mine.itemSource },
      },
      mine.key,
    );
    expect(run.initialStatus).toBeLessThan(300);

    // Mine went; theirs stayed. `items.get` answers null for a trashed row,
    // so absence is how "it was trashed" reads here — which is also why the
    // surviving row is asserted positively rather than by its absence.
    expect(await ctx.storage.items.get(ours, spaceId)).toBeNull();
    expect((await ctx.storage.items.get(theirs, spaceId))?.state).toBe(
      "active",
    );
  });

  it("refuses a cascade that would reach a live twin's row", async () => {
    // The rule was one edge away from being void. `parent-of` ships with
    // `cascade_on_delete: "cascade"` and admits any type at either end, so a
    // connection deleting a row it wrote took every child with it — including
    // a live sibling's, unguarded, publishing a `deleted` event on the way.
    // The direct delete of that same row is refused, which is what made the
    // gap worth closing rather than documenting.
    const theirs = await twinRow();
    const mineRes = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "core.note",
        source_id: key(),
        properties: { body: "the parent" },
      },
    });
    expect(mineRes.status).toBe(201);
    const ours = ((await mineRes.json()) as { item: { id: string } }).item.id;

    // Through a credential bound to this space, not the platform admin: the
    // platform credential holds no space, so the edge would land space-less
    // and the cascade — which is scoped to the caller's space — would never
    // find it. The case would then pass by not cascading at all.
    const edgeKeyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${spaceId}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: `edger-${String(seq)}`,
          source: `edger-${String(seq++)}`,
          // Both maps are named because nothing is implied any more: an edge
          // write is gated on write over the source item's type and over the
          // edge type, and this key exists only to make that one edge.
          type_permissions: { "core.note": "write" },
          edge_permissions: { "parent-of": "write" },
        },
      },
    );
    expect(edgeKeyRes.status).toBe(201);
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ((await edgeKeyRes.json()) as { key: string }).key,
      body: { edge_type: "parent-of", source_id: ours, target_id: theirs },
    });
    expect(edge.status).toBe(201);

    const res = await request(ctx.app, "DELETE", `/items/${ours}`, {
      key: mine.key,
    });
    expect(await refusalCode(res)).toBe("provenance_collision");

    // Neither row moved: the refusal rolls the whole plan back rather than
    // leaving a half-applied cascade.
    expect((await ctx.storage.items.get(ours, spaceId))?.state).toBe("active");
    expect((await ctx.storage.items.get(theirs, spaceId))?.state).toBe(
      "active",
    );
  });

  it("leaves a row another integration wrote alone, deliberately", async () => {
    // The boundary of D64, asserted so that widening it is a decision rather
    // than a drift. `marfa/task-auto-archive` lists `core.task` with no
    // source filter and archives everything past a cutoff, including tasks
    // other integrations wrote — so refusing a cross-integration lifecycle
    // gesture stops a shipped integration doing its job. That is the
    // counter-example D64's precondition asked for, and the ruling says to
    // revisit rather than work around it.
    //
    // The write is still refused, by mirror protection, which is why the two
    // gestures differ here and why that asymmetry is worth a case of its own.
    const stranger = await credentialFor(spaceId, "acme/stranger");
    const strangerRes = await request(ctx.app, "POST", "/items", {
      key: stranger.key,
      body: {
        type: "core.note",
        source_id: key(),
        properties: { body: "another integration's" },
      },
    });
    expect(strangerRes.status).toBe(201);
    const theirs = ((await strangerRes.json()) as { item: { id: string } }).item
      .id;
    expect(stranger.itemSource).not.toBe(mine.itemSource);

    const transitioned = await request(
      ctx.app,
      "POST",
      `/items/${theirs}/transition`,
      { key: mine.key, body: { state: "archived" } },
    );
    expect(transitioned.status).toBe(200);
  });

  it("lets a connection destroy its own row", async () => {
    // The positive beside the refusal, per D56. A guard that refused
    // everything would pass every case above.
    const res = await request(ctx.app, "POST", "/items", {
      key: mine.key,
      body: {
        type: "core.note",
        source_id: key(),
        properties: { body: "mine to remove" },
      },
    });
    const id = ((await res.json()) as { item: { id: string } }).item.id;

    const deleted = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: mine.key,
    });
    expect(deleted.status).toBe(200);
  });

  it("leaves a person acting through their own credential alone", async () => {
    // Nothing here narrows what a human can do in their own space, which is
    // the half of D64 that is a promise rather than a restriction. The twin
    // wrote the row; an ordinary space credential removes it regardless.
    const id = await twinRow();
    const spaceKeyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${spaceId}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: `person-${String(seq++)}`,
          source: `person-${String(seq)}`,
          type_permissions: { "core.note": "write" },
        },
      },
    );
    expect(spaceKeyRes.status).toBe(201);
    const personKey = ((await spaceKeyRes.json()) as { key: string }).key;

    const deleted = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: personKey,
    });
    expect(deleted.status).toBe(200);
  });

  it("still lets a row whose writer is gone be destroyed", async () => {
    // The D34-shaped non-regression. Uninstall leaves the items, so a row
    // whose writer is no longer installed must stay reachable — otherwise
    // the guard strands a corpus nobody can clean up, which is worse than
    // what it prevents.
    const id = await twinRow();
    // The lifecycle axis, which is what liveness reads — deliberately not
    // `runtime_status`, since a paused connection is still installed and its
    // rows are not orphaned. Setting `properties.status` alone leaves the
    // connection live and this case green for the wrong reason; it did.
    await ctx.storage.items.transition(twin.connectionId, "revoked", spaceId);
    const res = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: mine.key,
    });
    expect(res.status).toBe(200);
  });
});
