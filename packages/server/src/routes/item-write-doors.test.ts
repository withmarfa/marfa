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
 * extension layers reach the same row and are a different axis, excluded
 * below by name rather than by omission.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hashApiKey } from "../middleware/auth.js";
import {
  createTestContext,
  request,
  runBulkActionAsync,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Credential {
  key: string;
}

/** An ordinary credential, holding write on the two types the doors write. */
async function credentialFor(name: string): Promise<Credential> {
  const raw = `marfa_k1_doors_${Math.random().toString(36).slice(2, 14)}`;
  await ctx.storage.keys.create(
    {
      label: name,
      source: name,
      type_permissions: { "core.note": "write", "core.bookmark": "write" },
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return { key: raw };
}

/** A bookmark written by `owner`, addressable by id and by natural key. */
async function bookmarkRow(
  owner: Credential,
  sourceId: string,
): Promise<{ id: string; source_id: string; version: number }> {
  const res = await request(ctx.app, "POST", "/items", {
    key: owner.key,
    body: {
      type: "core.bookmark",
      source_id: sourceId,
      properties: { url: "https://example.com/original", title: "as synced" },
    },
  });
  expect(res.status).toBe(201);
  const { item } = (await res.json()) as {
    item: { id: string; version: number };
  };
  return { id: item.id, source_id: sourceId, version: item.version };
}

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

interface DoorWrite {
  key: string;
  target: { id: string; source_id: string; version: number };
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
   * **The misdeclaration is load-bearing.** The claim-side gates run on
   * the type the body names, and the row-side gates on the type the row
   * is; naming the row's own type fires the claim-side one first and the
   * write never reaches the gates these tests are measuring. Every refusal
   * below would then pass for the wrong reason, leaving `requireTypeAccess`
   * deletable with the whole file still green.
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

  /**
   * The code the misdeclaration is refused with, where it is not
   * `type_mismatch`.
   *
   * A door that resolved the row by an id the caller minted answers
   * `id_reused` instead: there the id is the thing that is wrong, and the
   * type is only how the caller finds out. A door that resolved it by the
   * natural key, or by the path, named no id and so the declaration is
   * the mistake. The distinction is the caller's, not the door's, which
   * is why it rides on the row here rather than being inferred from the
   * door's name.
   */
  misdeclareCode?: "id_reused";
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
    "carries no natural key, so it resolves no row and the type it names IS the row — nothing to disagree with. Supplying an `id` that already exists DOES resolve one, but that path writes nothing and returns the row, so it fits none of the write-shaped assertions here; its gates are covered in repeated-create-acknowledgment.test.ts",
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
 * while the gates underneath can be deleted one by one, `requireTypeAccess`
 * among them, with the whole file green.
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
  // without knowing a single id — the widest of the doors.
  // `runBulkActionAsync` drains the worker, so the write really lands or
  // really does not rather than stopping at a queued job that nothing
  // in-process would ever pick up.
  const { initialStatus } = await runBulkActionAsync(
    ctx,
    {
      action: "update_properties",
      filter: { type: "core.bookmark" },
      patch: properties,
    },
    key,
  );
  return new Response(null, { status: initialStatus });
};

const createWrite = ({ key, properties }: DoorWrite): Promise<Response> =>
  request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.bookmark", properties },
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
      body: {
        ...(type === undefined ? {} : { type }),
        properties,
        // Named because the door requires it: a version-less write is
        // refused ahead of every gate this file measures.
        version: target.version,
      },
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
    writeTruthful: naturalKeyWrite("core.bookmark"),
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
    writeTruthful: bulkByIdWrite("core.bookmark"),
    misdeclareType: bulkByIdWrite("core.note"),
    misdeclareCode: "id_reused",
  },
  {
    name: "POST /items/bulk (natural key)",
    route: "POST /items/bulk",
    refuses: "status",
    write: bulkNaturalKeyWrite("core.note"),
    writeTruthful: bulkNaturalKeyWrite("core.bookmark"),
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
  "POST /items/lookup": "read-only lookup by link, natural key or id",
  "POST /items/tombstones": "writes a purge's record, not an item's properties",
  "POST /items/:id/tags": "metadata layer, not the item's properties",
  "PUT /items/:id/metadata": "metadata layer, not the item's properties",
  "PATCH /items/:id/metadata": "metadata layer, not the item's properties",
  "PUT /items/:id/extensions/:namespace":
    "extension layer, gated by the row's type and extension_permissions",
  "POST /items/:id/transition":
    "lifecycle state axis, not the item's properties",
  "POST /items/:id/restore": "lifecycle state axis, not the item's properties",
};

// ---------------------------------------------------------------------------
// The agreement
// ---------------------------------------------------------------------------

describe.each(DOORS)("$name", (door) => {
  let mine: Credential;
  let seq = 0;

  beforeAll(async () => {
    const slug = door.name.replace(/[^a-z]+/gi, "-").toLowerCase();
    mine = await credentialFor(`acme/${slug}-mine`);
  });

  it("writes the row it names when it names the row's own type", async () => {
    // The permissive half of the pair below: the same key, the same row and
    // the same shape, declaring the type the row really is, and it must
    // succeed. One difference between them, one difference in outcome.
    const target = await bookmarkRow(mine, `own-${String(seq++)}`);
    const res = await door.writeTruthful({
      key: mine.key,
      target,
      properties: { title: "renamed" },
    });
    expect(res.status).toBeLessThan(400);
    if (door.name === "POST /items (create)") return;
    const after = await ctx.storage.items.get(target.id);
    expect(after?.properties.title).toBe("renamed");
  });

  it.skipIf(door.name in CANNOT_MISDECLARE)(
    "refuses a write that names a type the row is not",
    async () => {
      // Everything here is the credential's own: its row, and `core.note`
      // is a type it genuinely holds write on. So every gate passes and the
      // declared type is the only thing left that can refuse it.
      //
      // Worth a row of its own because moving the gates onto the resolved
      // row closed the escalation and left the claim merely meaningless
      // rather than refused — a body naming one type while resolving a
      // row of another was merged in, 200, nothing said. The door is the
      // only place it can be caught.
      const target = await bookmarkRow(mine, `type-${String(seq++)}`);

      const misdeclare = door.misdeclareType;
      /* v8 ignore next */
      if (!misdeclare) throw new Error("guarded by skipIf");
      const res = await misdeclare({
        key: mine.key,
        target,
        properties: { title: "re-typed" },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await refusalCode(res)).toBe(
        door.misdeclareCode ?? "type_mismatch",
      );

      // The status is not the property. A door that answered an error
      // after writing would satisfy the line above and still have
      // corrupted the row, which is the failure this whole file exists
      // to catch.
      const after = await ctx.storage.items.get(target.id);
      expect(after?.type).toBe("core.bookmark");
      expect(after?.properties.title).toBe("as synced");
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
    // else; other files reach the store from `/auth` and `/admin`.
    //
    // `idempotent-write-doors.test.ts` derives its scope from the tree
    // instead, and its header argues against exactly this walk. Bringing
    // this one onto that mechanism is unstarted follow-up work: the walk
    // is already generic, and the work is the twenty-three writers it makes
    // visible, each needing a row or a stated reason. Sized rather than
    // started, so this control is not mistaken for the fix.

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
