/**
 * A write that is retried after a lost response learns what its first
 * attempt did, rather than being told the outcome of asking again.
 *
 * The three refusals this replaces are each correct answers to the
 * request as the server sees it and wrong answers to the question the
 * client is asking: a repeated create collides with itself, a repeated
 * update conflicts against its own change, and a repeated delete is not
 * found. The property under test is therefore not "the second response
 * looks right" — a door that wrote twice and returned the second write's
 * body would satisfy that. It is that the second request performs no
 * write at all, which is observable as the absence of an event and an
 * unchanged version, so that is what every case here asserts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import { initEventLog, __resetCycleDetectionForTests } from "../pubsub.js";
import type { TestContext } from "../test-utils.js";
import { Hono } from "hono";
import { idempotencyMiddleware } from "./idempotency.js";
import { createErrorHandler } from "./error-handler.js";
import type { AppEnv } from "./auth.js";
import type { IdempotencyClaim, Storage } from "../storage/interface.js";
import type { ApiKey } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // The event log is the probe every case here reads, and
  // `createTestContext` does not wire it: a suite that skipped this would
  // read zero after a real write and every "no second write" assertion in
  // this file would pass having measured nothing. The race case at the
  // bottom is the control — it asserts a write DID happen, so it fails
  // loudly if this line is ever removed.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetCycleDetectionForTests();
  await ctx.cleanup();
});

let seq = 0;
const key = (): string => `idem-${String(seq++)}-${Date.now().toString(36)}`;

/** The event-log high-water mark, so a later read can ask what was added. */
async function eventHighWater(): Promise<bigint> {
  const recent = await ctx.storage.eventLog.getAfter(0n, 100_000);
  return recent.reduce((max, e) => (e.id > max ? e.id : max), 0n);
}

async function eventsSince(mark: bigint): Promise<number> {
  return (await ctx.storage.eventLog.getAfter(mark, 1000)).length;
}

interface ItemBody {
  item: { id: string; version: number; properties: Record<string, unknown> };
}

describe("a repeat is answered from what the first attempt returned", () => {
  it("replays a create without writing a second time", async () => {
    const k = key();
    const body = {
      type: "core.note",
      properties: { body: "the only write" },
    };

    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body,
    });
    expect(first.status).toBe(201);
    const firstText = await first.text();
    const created = (JSON.parse(firstText) as ItemBody).item;

    const mark = await eventHighWater();

    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body,
    });
    expect(second.status).toBe(201);
    expect(await second.text()).toBe(firstText);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");

    // No second write: nothing was announced, and the row is untouched.
    expect(await eventsSince(mark)).toBe(0);
    const stored = await ctx.storage.items.get(created.id);
    expect(stored?.version).toBe(created.version);
  });

  it("replays an update without writing a second time", async () => {
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "before" } },
    });
    const id = ((await create.json()) as ItemBody).item.id;

    const k = key();
    const patch = { properties: { body: "after" } };
    const first = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: patch,
    });
    expect(first.status).toBe(200);
    const firstText = await first.text();
    const updated = (JSON.parse(firstText) as ItemBody).item;

    const mark = await eventHighWater();

    const second = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: patch,
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);

    expect(await eventsSince(mark)).toBe(0);
    const stored = await ctx.storage.items.get(id);
    expect(stored?.version).toBe(updated.version);
  });

  it("replays a delete without writing a second time", async () => {
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "to remove" } },
    });
    const id = ((await create.json()) as ItemBody).item.id;

    const k = key();
    const first = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
    });
    expect(first.status).toBe(200);
    const firstText = await first.text();

    const mark = await eventHighWater();

    const second = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
    });
    // Without the record this is a 404: the row is gone, so the door is
    // answering a question the client never asked.
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
    expect(await eventsSince(mark)).toBe(0);
  });

  it("replays a stored 409 rather than deriving a fresh one", async () => {
    // The case the record exists for most. A conflict is a real outcome,
    // and a retry has to be told it happened rather than left to work out
    // whether the conflict it now meets is its own doing.
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "versioned" } },
    });
    const item = ((await create.json()) as ItemBody).item;

    const k = key();
    const stale = { properties: { body: "from a stale read" }, version: 99 };
    const first = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: stale,
    });
    expect(first.status).toBe(409);
    const firstText = await first.text();

    const second = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: stale,
    });
    expect(second.status).toBe(409);
    expect(await second.text()).toBe(firstText);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("carries no replay marker on the first attempt", async () => {
    // The permissive direction. A middleware that stamped the header
    // unconditionally would satisfy every assertion above.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": key() },
      body: { type: "core.note", properties: { body: "first" } },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Idempotency-Replayed")).toBe(null);
  });

  it("leaves a write carrying no key alone", async () => {
    // Two identical creates with no key are two items, as they always
    // were. The record is opt-in and must not quietly dedupe.
    const body = { type: "core.note", properties: { body: "unkeyed" } };
    const a = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body,
    });
    const b = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body,
    });
    const idA = ((await a.json()) as ItemBody).item.id;
    const idB = ((await b.json()) as ItemBody).item.id;
    expect(idA).not.toBe(idB);
  });
});

describe("an unauthenticated caller claims nothing", () => {
  it("never reaches the store at all", async () => {
    // **Asserted on the store rather than on the aftermath**, and that
    // distinction is the whole test. Declining to record a 401 is a
    // second, independent hardening, and it releases the row — so a test
    // that claimed, was refused, and then checked the key was free would
    // pass with this guard deleted, measuring the other one. Counting the
    // claim isolates it: a request with no credential must not produce a
    // row even transiently, on a table with no quota, and must not be able
    // to occupy a key in the bucket every space-less caller shares.
    const store = ctx.storage.idempotency;
    const seam = store as unknown as {
      claim: (input: unknown) => Promise<unknown>;
    };
    const realClaim = seam.claim.bind(store);
    let claims = 0;
    seam.claim = (input) => {
      claims += 1;
      return realClaim(input);
    };

    try {
      const anon = await request(ctx.app, "POST", "/items", {
        headers: { "Idempotency-Key": key() },
        body: { type: "core.note", properties: { body: "no credential" } },
      });
      expect(anon.status).toBe(401);
      expect(claims).toBe(0);

      // The control. Without it a middleware that never claimed anything
      // would pass the assertion above, and the counter would be measuring
      // a seam that does not work.
      const authed = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
        headers: { "Idempotency-Key": key() },
        body: { type: "core.note", properties: { body: "with credential" } },
      });
      expect(authed.status).toBe(201);
      expect(claims).toBe(1);
    } finally {
      delete (seam as { claim?: unknown }).claim;
    }
  });

  it("leaves the key usable by a legitimate caller afterwards", async () => {
    // The consequence spelled out: the poisoning half. A stranger guessing
    // a key must not be able to make a tenant's own use of it a mismatch.
    const k = key();

    await request(ctx.app, "POST", "/items", {
      headers: { "Idempotency-Key": k },
      body: { type: "core.note", properties: { body: "stranger" } },
    });

    const mine = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: { type: "core.note", properties: { body: "the real write" } },
    });
    expect(mine.status).toBe(201);
  });
});

describe("the key names one request in every dimension, not just the body", () => {
  // The one mismatch case elsewhere in this file varies the body, so the
  // other four inputs to the digest could each be dropped without anything
  // reddening. Each case below varies exactly one of them.
  async function seedItem(): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "seed" } },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as ItemBody).item.id;
  }

  it("distinguishes two paths", async () => {
    const k = key();
    const first = await seedItem();
    const second = await seedItem();
    const patch = { properties: { body: "changed" } };

    const a = await request(ctx.app, "PATCH", `/items/${first}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: patch,
    });
    expect(a.status).toBe(200);

    // Same key, same method, same body, same credential — a different row.
    const b = await request(ctx.app, "PATCH", `/items/${second}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: patch,
    });
    expect(b.status).toBe(422);
  });

  it("distinguishes two query strings", async () => {
    const k = key();
    const id = await seedItem();

    const a = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
    });
    expect(a.status).toBe(200);

    // A delete whose query asks for something else entirely is a different
    // request, and the digest has to see the query to know that.
    const b = await request(ctx.app, "DELETE", `/items/${id}?permanent=true`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
    });
    expect(b.status).toBe(422);
  });

  it("distinguishes two methods on one path", async () => {
    const k = key();
    const id = await seedItem();

    // DELETE carries no body, so the follow-up differs from it in the
    // method alone — path, query, credential and body all identical.
    const a = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
    });
    expect(a.status).toBe(200);

    const b = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
    });
    expect(b.status).toBe(422);
  });
});

describe("a retried update never conflicts with itself", () => {
  it("replays the first attempt rather than refusing the version it already moved", async () => {
    // Rule 2's third clause, and the one the other update case here cannot
    // reach: that one sends a version-less patch, where the un-keyed
    // behaviour is a second success rather than a conflict, so it does not
    // discriminate. With `version` the un-keyed behaviour IS a 409 — the
    // first attempt moved the row past the version the retry names — which
    // is exactly the wrong answer to "did my write land?".
    //
    // Only reachable through the raw request path: the typed client
    // deliberately offers the key on create and delete but not update.
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "v1" } },
    });
    const { item } = (await created.json()) as ItemBody;
    const k = key();
    const patch = { version: item.version, properties: { body: "v2" } };

    const first = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: patch,
    });
    expect(first.status).toBe(200);
    const firstText = await first.text();

    const mark = await eventHighWater();
    const retry = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: patch,
    });

    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(firstText);
    expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await eventsSince(mark)).toBe(0);

    // The control: the same stale patch without the key is the 409 this
    // clause exists to remove. Without it the case above proves only that
    // a replay happened, not that it replaced a conflict.
    const unkeyed = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.adminKey,
      body: patch,
    });
    expect(unkeyed.status).toBe(409);
  });
});

describe("the key itself is bounded", () => {
  it("refuses an empty key and one past the length bound", async () => {
    // A header is caller-controlled and lands in a column, so the bound is
    // what stops it becoming a storage vector. Both ends, because a check
    // written with only an upper bound admits the empty string.
    for (const bad of ["", "x".repeat(256)]) {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
        headers: { "Idempotency-Key": bad },
        body: { type: "core.note", properties: { body: "bounded" } },
      });
      expect(res.status, `key length ${String(bad.length)}`).toBe(400);
    }

    // And the bound itself is admitted, so this measures the edge rather
    // than refusing everything.
    const ok = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": "x".repeat(255) },
      body: { type: "core.note", properties: { body: "at the bound" } },
    });
    expect(ok.status).toBe(201);
  });
});

describe("a key replayed with a different request is a client defect", () => {
  it("refuses rather than serving the stored result", async () => {
    const k = key();
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: { type: "core.note", properties: { body: "the first thing" } },
    });
    expect(first.status).toBe(201);

    const mark = await eventHighWater();
    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": k },
      body: { type: "core.note", properties: { body: "a second thing" } },
    });
    expect(second.status).toBe(422);
    expect(
      ((await second.json()) as { error: { code: string } }).error.code,
    ).toBe("idempotency_key_reused");
    // Refused, so nothing was written either.
    expect(await eventsSince(mark)).toBe(0);
  });
});

describe("edges carry the same property as items", () => {
  async function note(body: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body } },
    });
    return ((await res.json()) as ItemBody).item.id;
  }

  it("replays a create, an update and a delete", async () => {
    const source = await note("edge source");
    const target = await note("edge target");

    const createKey = key();
    const createBody = {
      source_id: source,
      target_id: target,
      edge_type: "references",
      properties: { note: "first" },
    };
    const created = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": createKey },
      body: createBody,
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    const edgeId = (JSON.parse(createdText) as { edge: { id: string } }).edge
      .id;

    let mark = await eventHighWater();
    const createdAgain = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": createKey },
      body: createBody,
    });
    expect(createdAgain.status).toBe(201);
    expect(await createdAgain.text()).toBe(createdText);
    expect(await eventsSince(mark)).toBe(0);

    const patchKey = key();
    const patchBody = { properties: { note: "second" } };
    const patched = await request(ctx.app, "PATCH", `/edges/${edgeId}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": patchKey },
      body: patchBody,
    });
    expect(patched.status).toBe(200);
    const patchedText = await patched.text();

    mark = await eventHighWater();
    const patchedAgain = await request(ctx.app, "PATCH", `/edges/${edgeId}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": patchKey },
      body: patchBody,
    });
    expect(patchedAgain.status).toBe(200);
    expect(await patchedAgain.text()).toBe(patchedText);
    expect(await eventsSince(mark)).toBe(0);
    const stillThere = await ctx.storage.edges.get(edgeId);
    expect(stillThere?.properties.note).toBe("second");

    const deleteKey = key();
    const deleted = await request(ctx.app, "DELETE", `/edges/${edgeId}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": deleteKey },
    });
    expect(deleted.status).toBe(200);
    const deletedText = await deleted.text();

    mark = await eventHighWater();
    const deletedAgain = await request(ctx.app, "DELETE", `/edges/${edgeId}`, {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": deleteKey },
    });
    expect(deletedAgain.status).toBe(200);
    expect(await deletedAgain.text()).toBe(deletedText);
    expect(await eventsSince(mark)).toBe(0);
  });
});

describe("two requests carrying one key", () => {
  it("admits exactly one write", async () => {
    // The serializer is the unique index: the claim is an INSERT, so one
    // of the two arrivals loses it at the database rather than at a
    // comparison either of them makes. Driven concurrently rather than
    // reasoned about, because a check-then-write would pass a sequential
    // version of this test unchanged.
    const k = key();
    const body = { type: "core.note", properties: { body: "raced" } };
    const mark = await eventHighWater();

    const [a, b] = await Promise.all([
      request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
        headers: { "Idempotency-Key": k },
        body,
      }),
      request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
        headers: { "Idempotency-Key": k },
        body,
      }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    // One performed the write. The other either found the finished record
    // and replayed it, or found the claim still held and was told so.
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);

    // Whatever the pair looks like from outside, one item exists and one
    // event was published.
    expect(await eventsSince(mark)).toBe(1);
  });
});

/**
 * A claim the store did not grant must never let the write through.
 *
 * `claim` has a third outcome — it lost the INSERT and the winner was gone
 * by the time it read — and it exists because folding that into
 * `claimed: true` produced the duplicate write this whole mechanism is for:
 * the caller ran the write against a record id no row carried, recorded
 * nothing, and the next repeat of the key wrote again.
 *
 * **Driven against the middleware with a stand-in store**, because that
 * outcome reaches a real database only inside a race that cannot be
 * arranged from outside a single `claim()` call. The middleware here is the
 * real one and so is the error handler; only the store is stood in for, and
 * what is asserted is the middleware's own decision about what it was told.
 * The store's half of the same window is measured against a real database
 * in `storage/idempotency-store.test.ts`.
 */
describe("a claim the store did not grant", () => {
  const VANISHED: IdempotencyClaim = { claimed: false, held: null };

  /**
   * The digest the middleware computes for the fixture request.
   *
   * Captured rather than reproduced: recomputing the hash here would
   * restate the implementation and agree with it however it changed, and
   * the cases below are about the lease rather than about the digest. The
   * first `claim` call carries it, so the fixture echoes it back on the
   * held row and the mismatch branch stays out of the way.
   */
  let fingerprintEcho = "";

  /** Every digest the middleware has computed, in order. */
  let seenFingerprints: string[] = [];

  function doorWith(
    outcomes: readonly IdempotencyClaim[],
    routeStatus = 201,
    credential: { id: string; source: string; oauth?: boolean } = {
      id: "cred-1",
      source: "fixture",
    },
  ) {
    const calls = {
      claim: 0,
      completed: 0,
      released: 0,
      tookOver: 0,
      route: 0,
    };
    const storage = {
      idempotency: {
        claim: (input: { fingerprint: string }) => {
          // The middleware's own digest, echoed onto whatever held row the
          // case supplied, so a case about the lease is not decided by the
          // fingerprint comparison ahead of it.
          fingerprintEcho = input.fingerprint;
          seenFingerprints.push(input.fingerprint);
          const next = outcomes[Math.min(calls.claim, outcomes.length - 1)];
          calls.claim += 1;
          if (next === undefined) throw new Error("fixture ran dry");
          if (!next.claimed && next.held !== null) {
            next.held.fingerprint = input.fingerprint;
          }
          return Promise.resolve(next);
        },
        takeOverExpiredClaim: () => {
          calls.tookOver += 1;
          return Promise.resolve(true);
        },
        complete: () => {
          calls.completed += 1;
          return Promise.resolve(true);
        },
        release: () => {
          calls.released += 1;
          return Promise.resolve();
        },
        cleanup: () => Promise.resolve(0),
      },
    } as unknown as Storage;

    const errorHandler = createErrorHandler({ errorWebhookUrl: "" });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    // A credential, because the middleware declines to claim without one —
    // an unauthenticated caller has no write to make idempotent. Set here
    // rather than by running the real `authMiddleware`, which would need a
    // database the rest of this fixture exists to avoid.
    app.use("/w", async (c, next) => {
      c.set("apiKey", {
        id: credential.id,
        space_id: undefined,
        label: "fixture",
        source: credential.source,
        role: "admin",
        default_tier: "library",
        is_platform: false,
        scope_enforced: false,
        type_permissions: {},
        extension_permissions: {},
        edge_permissions: {},
        metadata_permissions: {},
        profile_permissions: {},
        created_at: new Date().toISOString(),
        last_used_at: null,
      } as unknown as ApiKey);
      c.set("authType", credential.oauth === true ? "oauth" : "api_key");
      await next();
    });
    app.use("/w", idempotencyMiddleware({ storage, errorHandler }));
    app.post("/w", (c) => {
      calls.route += 1;
      // `as 201` only to satisfy Hono's literal-status typing; the value
      // is whatever the case asked for.
      return c.json({ ok: true }, routeStatus as 201);
    });

    const send = () =>
      app.request("/w", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "k",
        },
        body: JSON.stringify({ body: "one write" }),
      });

    return { send, calls };
  }

  it("gives up loudly rather than running the write unclaimed", async () => {
    // The assertion that matters is `route: 0`. A middleware that treated
    // the vanished outcome as a claim would answer 201 here having run the
    // write and recorded nothing — correct-looking from outside, and a
    // duplicate on the next repeat of the key.
    const { send, calls } = doorWith([VANISHED]);

    const res = await send();

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_key_in_flight",
    );
    expect(calls.route).toBe(0);
    expect(calls.completed).toBe(0);
    // Bounded, and the bound is the reason this test returns at all rather
    // than spinning against a store that never grants anything.
    expect(calls.claim).toBe(3);
  });

  /** A held, in-flight claim whose age the case chooses. */
  function heldFor(ageMs: number): IdempotencyClaim {
    return {
      claimed: false,
      held: {
        id: "held-row",
        space_id: null,
        idempotency_key: "k",
        // The fingerprint the middleware computes for the fixture request
        // is not knowable here, so the mismatch branch has to be kept out
        // of the way: these cases are about the lease, and a mismatch
        // would refuse before the expiry check is reached. The store hands
        // back whatever it holds, so the case sets it to the digest the
        // middleware will compute by echoing it — see `fingerprintEcho`.
        fingerprint: fingerprintEcho,
        state: "in_flight",
        response_status: null,
        response_content_type: null,
        response_body: null,
        created_at: new Date(Date.now() - ageMs).toISOString(),
        completed_at: null,
      },
    };
  }

  it("takes over a claim past its lease, and runs the write", async () => {
    // The expiry comparison has two sides and inverting it would refuse
    // exactly the claims that should be taken over while stealing exactly
    // the ones still live. The store-level takeover test calls the store
    // method directly and never reaches this branch, so without this pair
    // that inversion passes the suite.
    //
    // Ten minutes is well past the 60s lease.
    const { send, calls } = doorWith([heldFor(10 * 60_000)]);

    const res = await send();

    expect(calls.tookOver).toBe(1);
    expect(res.status).toBe(201);
    expect(calls.route).toBe(1);
    expect(calls.completed).toBe(1);
  });

  it("refuses a claim still inside its lease, and does not write", async () => {
    // The other side. A middleware that stole live claims would pass the
    // case above and duplicate every write racing a slow one.
    const { send, calls } = doorWith([heldFor(1_000)]);

    const res = await send();

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_key_in_flight",
    );
    expect(calls.tookOver).toBe(0);
    expect(calls.route).toBe(0);
    expect(calls.completed).toBe(0);
  });

  it("gives the key back on a 5xx instead of pinning the caller to it", async () => {
    // A server fault is not an outcome to pin a caller to: recording one
    // would turn a transient failure into a refusal for the whole
    // retention window. Deleting this branch pins every caller to a stale
    // 500 and nothing else here would redden.
    const { send, calls } = doorWith([{ claimed: true }], 500);

    const res = await send();

    expect(res.status).toBe(500);
    expect(calls.released).toBe(1);
    expect(calls.completed).toBe(0);
  });

  it("gives the key back on a refusal about the credential", async () => {
    // 401 and 403 describe the credential, not the request. A caller fixes
    // the credential and retries, and replaying the refusal would answer a
    // question it is no longer asking. 409 is the contrast and is recorded
    // — it says something about the request.
    for (const status of [401, 403]) {
      const { send, calls } = doorWith([{ claimed: true }], status);
      const res = await send();
      expect(res.status).toBe(status);
      expect(calls.released, `status ${String(status)}`).toBe(1);
      expect(calls.completed, `status ${String(status)}`).toBe(0);
    }
  });

  it("records a conflict, which is the case the key exists for", async () => {
    // The discriminator for the two cases above: a rule that released
    // every non-2xx would satisfy both and destroy the feature.
    const { send, calls } = doorWith([{ claimed: true }], 409);

    const res = await send();

    expect(res.status).toBe(409);
    expect(calls.completed).toBe(1);
    expect(calls.released).toBe(0);
  });

  it("names an OAuth principal by its grant, not by its access-token row", async () => {
    // The case the header exists for, arriving from the other side: the
    // write goes out, the response is lost, the token expires inside the
    // same partition, and the client refreshes and retries with the key it
    // already minted. The grant is the same and the request is identical;
    // only the access-token row behind it has been replaced.
    //
    // Keying the digest on that row makes the retry a reused key, so the
    // client is refused and can never learn whether its first attempt
    // landed — which is exactly the question the key was minted to answer.
    seenFingerprints = [];
    await doorWith([{ claimed: true }], 201, {
      id: "access-token-row-1",
      source: "oauth:client-a:user-b",
      oauth: true,
    }).send();

    await doorWith([{ claimed: true }], 201, {
      id: "access-token-row-2-after-refresh",
      source: "oauth:client-a:user-b",
      oauth: true,
    }).send();

    expect(seenFingerprints).toHaveLength(2);
    expect(seenFingerprints[0]).toBe(seenFingerprints[1]);

    // The control: a different grant is still a different digest, so this
    // did not simply drop the credential from the material.
    await doorWith([{ claimed: true }], 201, {
      id: "access-token-row-3",
      source: "oauth:client-a:someone-else",
      oauth: true,
    }).send();
    expect(seenFingerprints[2]).not.toBe(seenFingerprints[0]);
  });

  it("asks again when the holder vanished, and writes exactly once", async () => {
    // The other side: giving up is only correct because it follows a
    // retry. A middleware that refused on the first vanished outcome would
    // pass the case above and turn an ordinary release into a refusal.
    const { send, calls } = doorWith([VANISHED, { claimed: true }]);

    const res = await send();

    expect(res.status).toBe(201);
    expect(calls.claim).toBe(2);
    expect(calls.route).toBe(1);
    expect(calls.completed).toBe(1);
  });
});
