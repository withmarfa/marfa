/**
 * A create the server has already performed, arriving again.
 *
 * A synced client mints an id before the server has seen the row, so it
 * is the only party that can name a write it is unsure landed. When the
 * response to its create is lost it retries with the same id, and the
 * server answered 409. The client reads a conflict as transient — which
 * it is, for an update — so it retried forever, and the queue's ordering
 * meant every later edit to that item waited behind it.
 *
 * **Why this lives at the server rather than in each client.** A second
 * arrival of an id the server already holds is that client's own write.
 * Every sync engine would otherwise have to implement the same lookup —
 * catch the conflict, fetch the row, decide whether it is mine — and
 * each would get the edge cases differently. The contract answers
 * success and returns the row instead.
 *
 * The negative half is the load-bearing one and is asserted separately:
 * an acknowledgement must write nothing and emit nothing, or it is an
 * idempotent-looking write that still bumps a version and wakes every
 * other device.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  generateId,
  MarfaError,
  ErrorCode,
  SPACE_PERMISSIONS,
} from "@withmarfa/shared";
import type { TypePermission } from "@withmarfa/shared";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  collectItemEvents,
  collectEdgeEvents,
  settle,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ItemBody {
  item: {
    id: string;
    type: string;
    version: number;
    updated_at: string;
    state: string;
    properties: Record<string, unknown>;
  };
  metadata: { tags: string[] };
  acknowledged?: boolean;
}
interface EdgeBody {
  edge: {
    id: string;
    source_id: string;
    target_id: string;
    edge_type: string;
    properties: Record<string, unknown>;
  };
  acknowledged?: boolean;
}
interface ErrorBody {
  error: { code: string; details?: { existing_id?: string } };
}

/** A note created under an id the caller chose. */
async function createNote(
  id: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type: "core.note", id, properties: { body: "first" }, ...body },
  });
}

describe("a repeated item create", () => {
  it("writes nothing and emits nothing", async () => {
    const id = generateId();
    const first = await createNote(id, { tags: ["kept"] });
    expect(first.status).toBe(201);
    const before = (await first.json()) as ItemBody;

    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    // A repeat carrying different properties. Nothing about it may land:
    // an acknowledgement that quietly merged would be an update wearing
    // a create's name.
    const repeat = await createNote(id, {
      properties: { body: "second" },
      tags: ["added"],
    });
    expect(repeat.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const after = (await repeat.json()) as ItemBody;
    expect(after.acknowledged).toBe(true);
    expect(after.item.id).toBe(id);
    expect(after.item.version).toBe(before.item.version);
    expect(after.item.updated_at).toBe(before.item.updated_at);
    expect(after.metadata.tags).toEqual(["kept"]);

    // And no second device is woken. A subscriber attached before the
    // repeat sees nothing for this item at all — not a create, not an
    // update.
    expect(events.filter((e) => e.item.id === id)).toHaveLength(0);

    // Read back independently of the response, so the assertion is about
    // the row rather than about what the route chose to echo.
    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    expect(((await read.json()) as ItemBody).item.properties).toEqual({
      body: "first",
    });
  });

  it("is refused when the repeat declares a different type", async () => {
    const id = generateId();
    expect((await createNote(id)).status).toBe(201);

    const repeat = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.task", id, properties: { title: "different" } },
    });
    expect(repeat.status).toBe(409);
    expect(((await repeat.json()) as ErrorBody).error.code).toBe(
      "type_mismatch",
    );
  });

  it("stays a conflict when the id belongs to a space the caller cannot see", async () => {
    const spaces = ctx.storage.spaces;
    if (!spaces) throw new Error("this test needs a space store");
    const other = await spaces.create("ack-other-space");
    const hidden = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "not yours" } },
      other.id,
    );

    const suffix = Math.random().toString(36).slice(2, 10);
    const mineKey = `marfa_k1_ack_${suffix}`;
    const mine = await spaces.create("ack-my-space");
    await ctx.storage.keys.create(
      {
        label: `ack-${suffix}`,
        source: `ack-${suffix}`,
        space_permissions: [...SPACE_PERMISSIONS],
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(mineKey, TEST_API_KEY_SALT),
      mine.id,
    );

    // The id is taken, but not by anything this caller may be told about.
    // Acknowledging would confirm the existence of another space's row.
    const res = await request(ctx.app, "POST", "/items", {
      key: mineKey,
      body: { type: "core.note", id: hidden.id, properties: { body: "mine" } },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("conflict");
  });
});

describe("a repeated edge create", () => {
  async function seedItem(label: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: label } },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  }

  it("writes nothing and emits nothing", async () => {
    const source = await seedItem("edge-quiet-source");
    const target = await seedItem("edge-quiet-target");
    const id = generateId();
    const body = {
      id,
      source_id: source,
      target_id: target,
      edge_type: "about",
      properties: { note: "first" },
    };
    expect(
      (await request(ctx.app, "POST", "/edges", { key: ctx.adminKey, body }))
        .status,
    ).toBe(201);

    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    const repeat = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { ...body, properties: { note: "second" } },
    });
    expect(repeat.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const parsed = (await repeat.json()) as EdgeBody;
    expect(parsed.acknowledged).toBe(true);
    expect(parsed.edge.id).toBe(id);
    // The stored properties are the first write's.
    expect(parsed.edge.properties).toEqual({ note: "first" });
    expect(events.filter((e) => e.edge.id === id)).toHaveLength(0);
  });
});

describe("the gates an acknowledgement still runs", () => {
  /**
   * A space, and a key inside it that may write items.
   *
   * No space permission is named because none of these doors asks for one:
   * `POST /items` is decided by the type map alone, and the quota the case
   * below sets is written by the operator key.
   */
  async function spaceWithKey(
    label: string,
    permissions: Record<string, TypePermission> = { "*": "write" },
  ): Promise<{ spaceId: string; key: string }> {
    const spaces = ctx.storage.spaces;
    if (!spaces) throw new Error("this test needs a space store");
    const space = await spaces.create(label);
    const suffix = Math.random().toString(36).slice(2, 10);
    const key = `marfa_k1_${label.replace(/[^a-z]/g, "")}_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `${label}-${suffix}`,
        source: `${label}-${suffix}`,
        type_permissions: permissions,
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(key, TEST_API_KEY_SALT),
      space.id,
    );
    return { spaceId: space.id, key };
  }

  it("is reached even when the space is at its item ceiling", async () => {
    // The acknowledgement used to sit behind the write transaction, whose
    // first statement reserves quota — so a full space answered a repeat
    // with `quota_exceeded` for a row it already held. That is the same
    // permanent refusal the whole change exists to remove, wearing a
    // different code.
    const { spaceId, key } = await spaceWithKey("quotaspace");
    const id = generateId();
    const first = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", id, properties: { body: "at-ceiling" } },
    });
    expect(first.status).toBe(201);

    // Ceiling set to exactly what the space now holds, so any genuine
    // create is refused and only the acknowledgement can answer 200.
    const quota = await request(ctx.app, "PUT", `/spaces/${spaceId}/quotas`, {
      key: ctx.adminKey,
      body: { items_limit: 1 },
    });
    expect(quota.status).toBe(200);

    const blocked = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: "a genuine create" } },
    });
    expect(blocked.status).toBe(429);

    const repeat = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", id, properties: { body: "repeat" } },
    });
    expect(repeat.status).toBe(200);
    expect((await repeat.json()) as ItemBody).toMatchObject({
      acknowledged: true,
    });
  });

  it("refuses a repeat landing on another connection's row", async () => {
    // D63. The guard engages only where the row is integration-sourced,
    // the caller's `item_source` matches it, and a *different live*
    // connection is recorded as the writer. "Live" means the connection
    // resolves a catalog row, so the fixture has to register a
    // `system.integration` and point both connections at it — without
    // that both writers read as dead, adoption applies, and the test
    // passes while proving nothing.
    //
    // Two connections on ONE integration is the load-bearing part:
    // `item_source` is keyed on the manifest name, so both share it, and
    // sharing it is the only way this door resolves a row the credential
    // did not write.
    const name = `acme.ackfixture${Math.random().toString(36).slice(2, 8)}`;
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: name,
          manifest_version: "1.0.0",
          publisher: "acme",
          manifest: {
            name,
            version: "1.0.0",
            publisher: "acme",
            description: "Repeat-create acknowledgement fixture",
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
            permissions: {},
          },
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );

    // Sequential, not `Promise.all`: the test database is one in-memory
    // SQLite, and two write transactions at once deadlock it.
    const connection = async () =>
      ctx.storage.items.create(
        {
          type: "system.connection",
          properties: {
            kind: "integration",
            status: "active",
            granted_at: new Date().toISOString(),
            integration_ref: integration.id,
          },
        },
        undefined,
      );
    const mine = await connection();
    const theirs = await connection();

    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      mine.id,
      "keys",
    );

    // The twin's row: the source this credential writes under, written by
    // the other connection.
    const foreign = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "the twin's record" },
        source: `integration:${name}`,
        source_id: `twin-${Math.random().toString(36).slice(2, 8)}`,
        written_by_connection_id: theirs.id,
      },
      undefined,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: cred.api_key,
      body: {
        type: "core.note",
        id: foreign.id,
        properties: { body: "claiming it" },
      },
    });
    // Not an acknowledgement: answering 200 would read as "your record is
    // already stored" when the record is a twin's.
    expect(res.status).not.toBe(200);
  });

  it("acknowledges a trashed row, in the state it holds", async () => {
    // The retry is not asking to revive it. Hiding the row instead would
    // send the create down the insert path and refuse it forever, which
    // is the natural-key branch's original bug in the id path.
    const id = generateId();
    expect((await createNote(id)).status).toBe(201);
    expect(
      (await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.adminKey }))
        .status,
    ).toBe(200);

    const repeat = await createNote(id);
    expect(repeat.status).toBe(200);
    const body = (await repeat.json()) as ItemBody;
    expect(body.acknowledged).toBe(true);
    // The deletion stands and is visible, rather than being papered over
    // with an active-looking row.
    expect(body.item.state).toBe("trashed");
  });

  it("writes no audit row", async () => {
    // An acknowledgement writes nothing, and audit rows record writes.
    // Matching the trashed natural-key branch it sits beside.
    //
    // Scoped to this item's own id rather than counting the whole table.
    // Audit writes are fire-and-forget and genuinely async on Postgres,
    // so a global count races every other test's pending inserts — which
    // is exactly how this first failed, on the Postgres dialect only.
    const id = generateId();
    expect((await createNote(id)).status).toBe(201);
    // Wait for the create's own row, so the comparison below is against a
    // settled state rather than a half-written one. It also proves the
    // read works at all: an assertion that nothing was added is vacuous
    // if the query can never see anything.
    const before = await waitForAudit(
      () => ctx.storage.audit.list({ resource_id: id, limit: 50 }),
      (rows) => rows.data.length === 1,
    );
    expect(before.data[0]?.action).toBe("item.create");

    const repeat = await createNote(id);
    expect(repeat.status).toBe(200);
    await settle();
    const after = await ctx.storage.audit.list({ resource_id: id, limit: 50 });
    expect(after.data).toHaveLength(1);
  });
});

describe("a repeated edge create under concurrency", () => {
  it("is acknowledged when the row appears after the pre-check", async () => {
    // The pre-check cannot see a row that does not exist yet, so two sends
    // of one id can both miss it and the loser of the insert reaches the
    // trap. That is what the catch behind the pre-check is for.
    //
    // Driven by blinding the pre-check once rather than by firing two real
    // requests: the test database is a single in-memory SQLite, where two
    // concurrent write transactions produce `SQLITE_BUSY` rather than the
    // collision under test. A race the harness cannot hold still is not
    // evidence about this code — the deterministic version is.
    const source = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "race-source" } },
    });
    const target = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "race-target" } },
    });
    const sourceId = ((await source.json()) as { item: { id: string } }).item
      .id;
    const targetId = ((await target.json()) as { item: { id: string } }).item
      .id;
    const id = generateId();
    const body = {
      id,
      source_id: sourceId,
      target_id: targetId,
      edge_type: "about",
    };

    expect(
      (await request(ctx.app, "POST", "/edges", { key: ctx.adminKey, body }))
        .status,
    ).toBe(201);

    // Two guards sit between the pre-check and the insert, and a real race
    // can slip past either. Blind both for one request so the insert is
    // reached against a row that is already there — which is exactly the
    // state a lost race leaves.
    //
    // `existsExactBatch` is the second one: it is what refuses an exact
    // duplicate triple with 400 before any insert, and with only the
    // pre-check blinded that 400 is what comes back rather than the
    // collision. Worth naming because it means the window this catch
    // covers is narrower than "the pre-check missed".
    const store = ctx.storage.edges;
    const realGet = store.get.bind(store);
    const realExists = store.existsExactBatch.bind(store);
    let blindedGet = false;
    let blindedExists = false;
    store.get = async (edgeId: string) => {
      if (!blindedGet) {
        blindedGet = true;
        return null;
      }
      return realGet(edgeId);
    };
    store.existsExactBatch = async (proposals, space) => {
      if (!blindedExists) {
        blindedExists = true;
        return new Set<string>();
      }
      return realExists(proposals, space);
    };
    let res: Response;
    try {
      res = await request(ctx.app, "POST", "/edges", {
        key: ctx.adminKey,
        body,
      });
    } finally {
      store.get = realGet;
      store.existsExactBatch = realExists;
    }

    // Both blinds were used. Without this the test passes when the stubs
    // are never reached, which is the state a refactor that moves the
    // pre-check would leave — green, and measuring nothing.
    expect(blindedGet).toBe(true);
    expect(blindedExists).toBe(true);

    expect(res.status).toBe(200);
    const parsed = (await res.json()) as EdgeBody;
    expect(parsed.acknowledged).toBe(true);
    expect(parsed.edge.id).toBe(id);

    const listed = await request(ctx.app, "GET", `/items/${sourceId}/edges`, {
      key: ctx.adminKey,
    });
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("keeps a cross-space id a conflict rather than an acknowledgement", async () => {
    const spaces = ctx.storage.spaces;
    if (!spaces) throw new Error("this test needs a space store");
    const theirs = await spaces.create("edge-other-space");
    const theirSource = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "their source" } },
      theirs.id,
    );
    const theirTarget = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "their target" } },
      theirs.id,
    );
    const theirEdge = await ctx.storage.edges.createRaw(
      {
        source_id: theirSource.id,
        target_id: theirTarget.id,
        edge_type: "about",
      },
      theirs.id,
    );

    const mine = await spaces.create("edge-my-space");
    const suffix = Math.random().toString(36).slice(2, 10);
    const myKey = `marfa_k1_edgeack_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `edgeack-${suffix}`,
        source: `edgeack-${suffix}`,
        space_permissions: [...SPACE_PERMISSIONS],
        type_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(myKey, TEST_API_KEY_SALT),
      mine.id,
    );
    const mySource = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "my source" } },
      mine.id,
    );
    const myTarget = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "my target" } },
      mine.id,
    );

    const res = await request(ctx.app, "POST", "/edges", {
      key: myKey,
      body: {
        id: theirEdge.id,
        source_id: mySource.id,
        target_id: myTarget.id,
        edge_type: "about",
      },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("conflict");
  });
});

describe("the item door's concurrency backstop", () => {
  it("acknowledges when the row appears after the pre-check", async () => {
    // The pre-check cannot see a row that does not exist yet, so two sends
    // of one id can both miss it and the loser of the insert reaches the
    // store's trap. Nothing else in this file exercises that path: every
    // other repeat resolves at the pre-check and returns before the
    // transaction opens.
    //
    // Blinded rather than raced, for the reason the edge twin gives: two
    // concurrent writes against one in-memory SQLite deadlock rather than
    // colliding.
    const id = generateId();
    expect((await createNote(id)).status).toBe(201);

    const store = ctx.storage.items;
    const realGet = store.getIncludingTrashed.bind(store);
    let blinded = false;
    store.getIncludingTrashed = async (itemId: string, spaceId?: string) => {
      if (!blinded) {
        blinded = true;
        return null;
      }
      return realGet(itemId, spaceId);
    };
    let res: Response;
    try {
      res = await createNote(id, { properties: { body: "the racer" } });
    } finally {
      store.getIncludingTrashed = realGet;
    }

    expect(blinded).toBe(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemBody;
    expect(body.acknowledged).toBe(true);
    expect(body.item.id).toBe(id);
    // The first write's properties: the backstop acknowledged rather than
    // writing the racer's body.
    expect(body.item.properties).toEqual({ body: "first" });
  });

  it("does not acknowledge a conflict raised about a different id", async () => {
    // The catch is pinned to `existing_id` matching the id this request
    // sent. Without that equality any CONFLICT surfacing from inside the
    // transaction would be answered with whatever row the lookup happened
    // to find — a 200 for a write that did not happen.
    const id = generateId();
    const store = ctx.storage.items;
    const realCreate = store.create.bind(store);
    store.create = () =>
      Promise.reject(
        new MarfaError(
          ErrorCode.CONFLICT,
          "Item with id=someone-else already exists",
          { existing_id: generateId() },
        ),
      );
    let res: Response;
    try {
      res = await createNote(id);
    } finally {
      store.create = realCreate;
    }
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("conflict");
  });
});

describe("attribution on the two acknowledged doors", () => {
  /**
   * Both doors hand a stored row back, and a sibling Connection's
   * `system.activity` row is not this credential's to be shown. They ran
   * different gates, so a refused caller got a different answer depending
   * on which key resolved the row.
   */
  async function runtimeCredentialAndForeignActivity(): Promise<{
    key: string;
    activityId: string;
  }> {
    const connection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connection.id,
      "keys",
    );
    // An activity row attributed to a connection that is not this
    // credential's. `permitsActivityAttribution` compares the row's
    // `connection_id` against the credential's, so that field is the
    // whole fixture.
    const other = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const activity = await ctx.storage.items.create(
      {
        type: "system.activity",
        properties: {
          connection_id: other.id,
          severity: "info",
          summary: "a sibling's activity",
        },
      },
      undefined,
    );
    return { key: cred.api_key, activityId: activity.id };
  }

  it("refuses on the repeated-id door", async () => {
    const { key, activityId } = await runtimeCredentialAndForeignActivity();
    const res = await request(ctx.app, "POST", "/items", {
      key,
      body: {
        type: "system.activity",
        id: activityId,
        properties: {
          connection_id: "someone",
          severity: "info",
          summary: "claiming it",
        },
      },
    });
    expect(res.status).not.toBe(200);
  });

  it("refuses a type mismatch on the trashed natural-key door", async () => {
    // The gate this arm was actually missing. Attribution is not it:
    // `permitsActivityAttribution` constrains only `system.activity`, and
    // `system.*` lifecycles have no `trashed` state, so no row this arm
    // resolves is one attribution would look at.
    //
    // A declared type that is not the row's is reachable here, and until
    // now this arm accepted it — which is what made the route's own 409
    // description untrue of the trashed answer.
    const sourceId = `mismatch-${Math.random().toString(36).slice(2, 8)}`;
    const seeded = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        source_id: sourceId,
        properties: { body: "will be trashed" },
      },
    });
    expect(seeded.status).toBe(201);
    const id = ((await seeded.json()) as ItemBody).item.id;
    expect(
      (await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.adminKey }))
        .status,
    ).toBe(200);

    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.task",
        source_id: sourceId,
        properties: { title: "a different type" },
      },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("type_mismatch");
  });
});
