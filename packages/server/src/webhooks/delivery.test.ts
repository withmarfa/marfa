import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import { createHmac } from "node:crypto";
import type { Edge, Item } from "@withmarfa/shared";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import type { StoredWebhook, WebhookOwner } from "../storage/interface.js";
import {
  __listenerCountForTests,
  publish,
  publishEdge,
  storedFrame,
  type PubsubEvent,
} from "../pubsub.js";
import {
  DELIVERY_CANCELLED,
  WEBHOOK_POLL_INTERVAL_MS,
  WebhookConsumer,
  WebhookPoller,
  buildSignatureHeader,
  parseRetryAfter,
} from "./delivery.js";
import {
  DELIVERY_FAILURE,
  type WebhookHttpClient,
  type WebhookPost,
  type WebhookPostOutcome,
} from "./outbound-http.js";

// ---------------------------------------------------------------------------
// parseRetryAfter — header parsing
// ---------------------------------------------------------------------------

describe("parseRetryAfter", () => {
  it("returns null for missing or blank values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
  });

  it("parses delta-seconds form to milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("1")).toBe(1_000);
  });

  it("clamps very large delta-seconds to the 5-minute ceiling", () => {
    // 99 999 999 seconds would be ~3 years — must clamp.
    expect(parseRetryAfter("99999999")).toBe(5 * 60 * 1000);
  });

  it("rejects zero and negative delta-seconds", () => {
    expect(parseRetryAfter("0")).toBeNull();
    expect(parseRetryAfter("-1")).toBeNull();
  });

  it("parses HTTP-date form to a future delta", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).not.toBeNull();
    // Should be roughly 45s, allow a small clock-tick tolerance.
    expect(result).toBeGreaterThan(40_000);
    expect(result).toBeLessThanOrEqual(45_000);
  });

  it("returns null for HTTP-date in the past", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBeNull();
  });

  it("returns null for completely unparseable garbage", () => {
    expect(parseRetryAfter("not-a-real-header")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Harness: a real store, a recording client in place of the network
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(async () => {
  for (const w of await ctx.storage.outboundWebhooks.list()) {
    await ctx.storage.outboundWebhooks.delete(w.id);
  }
});

const SECRET = "s".repeat(32);

interface Recorder extends WebhookHttpClient {
  posts: WebhookPost[];
}

function recorder(
  answer: (post: WebhookPost) => WebhookPostOutcome = () => ({
    kind: "answered",
    status: 200,
    retryAfter: null,
  }),
): Recorder {
  const posts: WebhookPost[] = [];
  return {
    posts,
    post(request) {
      posts.push(request);
      return Promise.resolve(answer(request));
    },
  };
}

function raw(): { all: (query: string) => Promise<unknown[]> } {
  const storage = ctx.storage as unknown as {
    __sqliteAll: (query: string) => Promise<unknown[]>;
  };
  return { all: storage.__sqliteAll };
}

async function row(id: string): Promise<Record<string, unknown>> {
  const [found] = await raw().all(
    `SELECT status, status_code, attempt, error, next_attempt_at FROM outbound_webhook_deliveries WHERE id = '${id}'`,
  );
  return found as Record<string, unknown>;
}

async function keyIdOf(rawKey: string): Promise<string> {
  const res = await request(ctx.app, "GET", "/keys/current", { key: rawKey });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** A key with `webhooks.manage` and the reach given, and its id. */
async function owner(
  reach: Parameters<typeof mintWorkingKey>[1] = {},
): Promise<{ raw: string; id: string }> {
  const rawKey = await mintWorkingKey(ctx, {
    permissions: ["webhooks.manage"],
    ...reach,
  });
  return { raw: rawKey, id: await keyIdOf(rawKey) };
}

async function subscription(
  owner: string | WebhookOwner,
  events: string[],
  url = "https://receiver.example/hook",
): Promise<StoredWebhook> {
  return ctx.storage.outboundWebhooks.create({
    url,
    events,
    secret: SECRET,
    owner: typeof owner === "string" ? { kind: "key", keyId: owner } : owner,
  });
}

/** A pending delivery of `event` to `webhook`, as dispatch stores one. */
async function pending(
  webhook: StoredWebhook,
  event: PubsubEvent,
  eventType: string,
): Promise<string> {
  return ctx.storage.outboundWebhookDeliveries.schedule({
    webhookId: webhook.id,
    eventType,
    payload: JSON.stringify(storedFrame(event)),
    webhookUrl: webhook.url,
    nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
  });
}

function item(id: string, type = "core.note"): Item {
  return {
    id,
    type,
    version: 1,
    state: "active",
    tier: "library",
    source: "test",
    properties: { title: id },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Item;
}

function edge(id: string, sourceId: string, edgeType = "references"): Edge {
  return {
    id,
    edge_type: edgeType,
    source_id: sourceId,
    target_id: "01HBBBBBBBBBBBBBBBBBBBBBBB",
    properties: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Start a consumer, publish, let its deliveries go, stop it. */
async function dispatch(
  http: Recorder,
  publishAll: () => Promise<void>,
): Promise<void> {
  const consumer = new WebhookConsumer({ storage: ctx.storage, http });
  consumer.start();
  await settle();
  try {
    await publishAll();
    await settle();
  } finally {
    consumer.stop();
  }
}

function sentBodies(http: Recorder): Record<string, unknown>[] {
  return http.posts.map((p) => JSON.parse(p.body) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// One attempt: what the receiver's answer does to the row
// ---------------------------------------------------------------------------

describe("an attempt's outcome", () => {
  async function attempt(outcome: WebhookPostOutcome) {
    const { id } = await owner();
    const webhook = await subscription(id, ["item.created"]);
    const deliveryId = await pending(
      webhook,
      { type: "created", item: item("01HOUTCOMEOUTCOMEOUTCOME00") },
      "item.created",
    );
    const http = recorder(() => outcome);
    await new WebhookPoller({ storage: ctx.storage, http }).runOnce();
    expect(http.posts).toHaveLength(1);
    return row(deliveryId);
  }

  it("settles a 2xx as delivered", async () => {
    expect(
      await attempt({ kind: "answered", status: 204, retryAfter: null }),
    ).toMatchObject({ status: "success", status_code: 204, attempt: 1 });
  });

  it("dead-letters a 4xx other than 408 and 429", async () => {
    expect(
      await attempt({ kind: "answered", status: 400, retryAfter: null }),
    ).toMatchObject({ status: "dead_letter" });
  });

  it("retries 408, 429 and 5xx, honoring Retry-After up to its ceiling", async () => {
    for (const status of [408, 429, 503]) {
      const t0 = Date.now();
      const settled = await attempt({
        kind: "answered",
        status,
        retryAfter: status === 503 ? "120" : null,
      });
      expect(settled).toMatchObject({ status: "pending", status_code: status });
      const delay = Date.parse(settled.next_attempt_at as string) - t0;
      if (status === 503) {
        expect(delay).toBeGreaterThanOrEqual(119_000);
        expect(delay).toBeLessThan(125_000);
      } else {
        expect(delay).toBeLessThan(5_000);
      }
    }
    const capped = await attempt({
      kind: "answered",
      status: 429,
      retryAfter: "999999",
    });
    expect(
      Date.parse(capped.next_attempt_at as string) - Date.now(),
    ).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("dead-letters a redirect, which is not followed", async () => {
    expect(await attempt({ kind: "redirected", status: 302 })).toMatchObject({
      status: "dead_letter",
      status_code: 302,
      error: DELIVERY_FAILURE.redirect,
    });
  });

  it("retries a delivery that reached no receiver, recording why in its own words", async () => {
    expect(
      await attempt({ kind: "failed", error: DELIVERY_FAILURE.notPublic }),
    ).toMatchObject({
      status: "pending",
      status_code: null,
      error: DELIVERY_FAILURE.notPublic,
    });
  });
});

// ---------------------------------------------------------------------------
// Signing and the two paths
// ---------------------------------------------------------------------------

describe("the signature and the direct path", () => {
  it("signs <t>.<body> under the subscription's secret on both paths, the direct one sooner and with the shorter timeout", async () => {
    const { id } = await owner();
    await subscription(id, ["item.created"]);
    const http = recorder();
    const t0 = Date.now();
    await dispatch(http, async () => {
      await publish({
        type: "created",
        item: item("01HSIGNEDSIGNEDSIGNEDSIGN0"),
      });
    });
    expect(http.posts).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(WEBHOOK_POLL_INTERVAL_MS / 2);
    const direct = http.posts[0];
    expect(direct?.timeoutMs).toBe(5_000);

    const webhook = (await ctx.storage.outboundWebhooks.list())[0];
    if (!webhook) throw new Error("no subscription");
    await pending(
      webhook,
      { type: "created", item: item("01HSIGNEDPOLLEDPOLLEDPOLL0") },
      "item.created",
    );
    await new WebhookPoller({ storage: ctx.storage, http }).runOnce();
    const polled = http.posts[1];
    expect(polled?.timeoutMs).toBe(10_000);

    for (const post of [direct, polled]) {
      if (!post) throw new Error("missing post");
      const header = post.headers["X-Marfa-Signature"] ?? "";
      const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
      expect(match).not.toBeNull();
      const [, t, v1] = match ?? [];
      expect(v1).toBe(
        createHmac("sha256", SECRET)
          .update(`${String(t)}.${post.body}`)
          .digest("hex"),
      );
      expect(header).toBe(buildSignatureHeader(String(t), post.body, SECRET));
      expect(post.headers["X-Marfa-Event-Type"]).toBe("item.created");
    }
  });
});

// ---------------------------------------------------------------------------
// Which subscriptions an event reaches
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  it("does not deliver an event that declined fan-out, but delivers one that did not, for items and edges", async () => {
    const { id } = await owner();
    await subscription(id, ["item.created", "edge.created"]);
    const http = recorder();
    await dispatch(http, async () => {
      await publish({
        type: "created",
        item: item("01HQUIETQUIETQUIETQUIETQU0"),
        enableFanout: false,
      });
      await publishEdge({
        type: "edge_created",
        edge: edge("edge_quiet", "01HAAAAAAAAAAAAAAAAAAAAAAA"),
        enableFanout: false,
      });
      await publish({
        type: "created",
        item: item("01HLOUDLOUDLOUDLOUDLOUD00"),
      });
      await publishEdge({
        type: "edge_created",
        edge: edge("edge_loud", "01HAAAAAAAAAAAAAAAAAAAAAAA"),
      });
    });
    const ids = sentBodies(http).map(
      (b) =>
        (b.item as { id?: string } | undefined)?.id ??
        (b.edge as { id?: string } | undefined)?.id,
    );
    expect(ids.sort()).toEqual(["01HLOUDLOUDLOUDLOUDLOUD00", "edge_loud"]);
  });

  it("schedules nothing for a retired name, and one delivery for a live subscription on the same event", async () => {
    // Retiring an event name does not rewrite the rows that subscribed to
    // it, so such a row's fate is this dispatch pass, which is what
    // `WebhookSchema.events` staying `z.array(z.string())` rests on.
    const { id } = await owner();
    const retired = await subscription(id, ["item.trashed"]);
    const named = await subscription(id, ["item.created"]);
    const http = recorder();
    await dispatch(http, async () => {
      await publish({
        type: "created",
        item: item("01HRETIREDRETIREDRETIRED0"),
      });
    });
    expect(
      (
        await ctx.storage.outboundWebhookDeliveries.list(retired.id, {
          limit: 5,
        })
      ).data,
    ).toHaveLength(0);
    expect(
      (await ctx.storage.outboundWebhookDeliveries.list(named.id, { limit: 5 }))
        .data,
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A delivery is a read made for the subscription's credential
// ---------------------------------------------------------------------------

describe("what a delivery carries", () => {
  it("carries every mark to a credential that may read the rows they name, and no stored type", async () => {
    const { id } = await owner();
    await subscription(id, ["item.restored", "item.deleted", "edge.deleted"]);
    const http = recorder();
    await dispatch(http, async () => {
      await publish({
        type: "restored",
        item: item("01HFFFFFFFFFFFFFFFFFFFFFFF"),
        restoredWith: { id: "01HGGGGGGGGGGGGGGGGGGGGGGG", type: "core.task" },
      });
      await publish({
        type: "deleted",
        item: item("01HHHHHHHHHHHHHHHHHHHHHHHH"),
        trashedWith: { id: "01HGGGGGGGGGGGGGGGGGGGGGGG", type: "core.task" },
      });
      await publishEdge({
        type: "edge_deleted",
        edge: edge("edge_purged", "01HAAAAAAAAAAAAAAAAAAAAAAA"),
        purgedWith: "01HAAAAAAAAAAAAAAAAAAAAAAA",
      });
    });
    const sent = (key: string) =>
      sentBodies(http).find(
        (b) =>
          (b.item as { id?: string } | undefined)?.id === key ||
          (b.edge as { id?: string } | undefined)?.id === key,
      );
    expect(sent("01HFFFFFFFFFFFFFFFFFFFFFFF")).toMatchObject({
      event_type: "item.restored",
      restored_with: "01HGGGGGGGGGGGGGGGGGGGGGGG",
    });
    expect(sent("01HFFFFFFFFFFFFFFFFFFFFFFF")).not.toHaveProperty(
      "restored_with_type",
    );
    expect(sent("01HFFFFFFFFFFFFFFFFFFFFFFF")).not.toHaveProperty("type");
    expect(sent("01HHHHHHHHHHHHHHHHHHHHHHHH")?.item).toMatchObject({
      trashed_by_cascade: true,
      trashed_with: "01HGGGGGGGGGGGGGGGGGGGGGGG",
    });
    expect(sent("01HHHHHHHHHHHHHHHHHHHHHHHH")).not.toHaveProperty(
      "trashed_with_type",
    );
    expect(sent("edge_purged")?.purged_with).toBe("01HAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("sends a narrow credential only the types it may read, and names a row in a mark only where it may read that row's type", async () => {
    const { id } = await owner({ type_permissions: { "core.note": "read" } });
    await subscription(id, ["item.created", "item.restored"]);
    const http = recorder();
    await dispatch(http, async () => {
      await publish({
        type: "created",
        item: item("01HTASKTASKTASKTASKTASKT0", "core.task"),
      });
      await publish({
        type: "created",
        item: item("01HNOTENOTENOTENOTENOTEN0"),
      });
      await publish({
        type: "restored",
        item: item("01HRESTOREDRESTOREDRESTO0"),
        restoredWith: { id: "01HTASKTASKTASKTASKTASKT0", type: "core.task" },
      });
    });
    const bodies = sentBodies(http);
    expect(bodies.map((b) => (b.item as { id: string }).id).sort()).toEqual([
      "01HNOTENOTENOTENOTENOTEN0",
      "01HRESTOREDRESTOREDRESTO0",
    ]);
    expect(
      bodies.find(
        (b) => (b.item as { id: string }).id === "01HRESTOREDRESTOREDRESTO0",
      ),
    ).not.toHaveProperty("restored_with");
  });

  it("sends a key only the extension namespaces its map reaches", async () => {
    const { id } = await owner({
      type_permissions: { "*": "read" },
      extension_permissions: { alpha: "read" },
    });
    await subscription(id, ["metadata.changed"]);
    const http = recorder();
    await dispatch(http, async () => {
      await publish({
        type: "metadata_changed",
        item: item("01HMETAMETAMETAMETAMETAME0"),
        metadata: {
          item_id: "01HMETAMETAMETAMETAMETAME0",
          tags: ["t"],
          extensions: { alpha: { a: 1 }, beta: { b: 2 } },
        },
      });
    });
    const [body] = sentBodies(http);
    expect(body?.metadata).toEqual({
      item_id: "01HMETAMETAMETAMETAMETAME0",
      tags: ["t"],
      extensions: { alpha: { a: 1 } },
    });
  });

  it("sends a signed-in app no extension namespace, whatever types it reads", async () => {
    const { token } = await seedOauthBearer(ctx.storage, [
      "content:read",
      "webhooks.manage",
    ]);
    const row = await ctx.storage.oauthProvider?.validateAccessToken(
      hashApiKey(token.slice("marfa_at_".length), TEST_API_KEY_SALT),
    );
    if (!row?.userId) throw new Error("the seeded token did not resolve");
    await ctx.storage.oauthProvider?.upsertConsent({
      clientId: row.clientId,
      authUserId: row.userId,
      scopes: ["content:read", "webhooks.manage"],
    });
    await subscription(
      { kind: "grant", clientId: row.clientId, authUserId: row.userId },
      ["metadata.changed"],
    );
    const http = recorder();
    await dispatch(http, async () => {
      await publish({
        type: "metadata_changed",
        item: item("01HAPPMETAAPPMETAAPPMETA0"),
        metadata: {
          item_id: "01HAPPMETAAPPMETAAPPMETA0",
          tags: [],
          extensions: { alpha: { a: 1 }, beta: { b: 2 } },
        },
      });
    });
    const [body] = sentBodies(http);
    expect(body?.metadata).toEqual({
      item_id: "01HAPPMETAAPPMETAAPPMETA0",
      tags: [],
      extensions: {},
    });
  });

  it("sends an edge only where its kind and its source's type are readable", async () => {
    const readable = await itemWrites(ctx.storage).create({
      type: "core.note",
      tier: "library",
      state: "active",
      properties: { body: "readable source" },
      source: "test/webhook-edges",
    });
    const hidden = await itemWrites(ctx.storage).create({
      type: "core.task",
      tier: "library",
      state: "active",
      properties: { title: "hidden source" },
      source: "test/webhook-edges",
    });
    const { id } = await owner({
      type_permissions: { "core.note": "read" },
      edge_permissions: { references: "read" },
    });
    await subscription(id, ["edge.created"]);
    const http = recorder();
    await dispatch(http, async () => {
      await publishEdge({
        type: "edge_created",
        edge: edge("edge_readable", readable.id),
      });
      await publishEdge({
        type: "edge_created",
        edge: edge("edge_kind_hidden", readable.id, "cites"),
      });
      await publishEdge({
        type: "edge_created",
        edge: edge("edge_source_hidden", hidden.id),
      });
    });
    expect(sentBodies(http).map((b) => (b.edge as { id: string }).id)).toEqual([
      "edge_readable",
    ]);
  });

  it("narrows a pending delivery to the credential as it stands at the attempt", async () => {
    const key = await owner({ type_permissions: { "core.note": "read" } });
    const webhook = await subscription(key.id, ["item.created"]);
    const deliveryId = await pending(
      webhook,
      { type: "created", item: item("01HNARROWEDNARROWEDNARROW0") },
      "item.created",
    );
    await ctx.storage.keys.update(key.id, {
      type_permissions: { "core.task": "read" },
    });
    const http = recorder();
    await new WebhookPoller({ storage: ctx.storage, http }).runOnce();
    expect(http.posts).toHaveLength(0);
    expect(await row(deliveryId)).toMatchObject({
      status: "cancelled",
      error: DELIVERY_CANCELLED.unreadable,
    });
  });
});

// ---------------------------------------------------------------------------
// A subscription stops with its credential and with itself
// ---------------------------------------------------------------------------

describe("when a delivery stops", () => {
  it("sends nothing, now or pending, once the credential is revoked", async () => {
    const key = await owner();
    const webhook = await subscription(key.id, ["item.created"]);
    const before = recorder();
    await dispatch(before, async () => {
      await publish({
        type: "created",
        item: item("01HBEFOREBEFOREBEFOREBEF0"),
      });
    });
    expect(before.posts).toHaveLength(1);

    const left = await pending(
      webhook,
      { type: "created", item: item("01HLEFTLEFTLEFTLEFTLEFTL0") },
      "item.created",
    );
    await ctx.storage.keys.revoke(key.id);
    const after = recorder();
    await dispatch(after, async () => {
      await publish({
        type: "created",
        item: item("01HAFTERAFTERAFTERAFTERA0"),
      });
    });
    await new WebhookPoller({ storage: ctx.storage, http: after }).runOnce();
    expect(after.posts).toHaveLength(0);
    expect(await row(left)).toMatchObject({
      status: "cancelled",
      error: DELIVERY_CANCELLED.removed,
    });
    // Deleted with the key, as a witnessed subscription.
    expect(await ctx.storage.outboundWebhooks.get(webhook.id)).toBeNull();
  });

  it("sends nothing once the credential no longer holds webhooks.manage", async () => {
    const key = await owner();
    const webhook = await subscription(key.id, ["item.created"]);
    const left = await pending(
      webhook,
      { type: "created", item: item("01HNOMANAGENOMANAGENOMAN0") },
      "item.created",
    );
    await ctx.storage.keys.update(key.id, { permissions: [] });
    const http = recorder();
    await new WebhookPoller({ storage: ctx.storage, http }).runOnce();
    expect(http.posts).toHaveLength(0);
    expect(await row(left)).toMatchObject({ status: "cancelled" });
  });

  it("sends no pending delivery of a subscription removed, turned off or pointed elsewhere", async () => {
    const key = await owner();
    const http = recorder();
    const cases: [string, (w: StoredWebhook) => Promise<unknown>][] = [
      [
        DELIVERY_CANCELLED.removed,
        (w) => ctx.storage.outboundWebhooks.delete(w.id),
      ],
      [
        DELIVERY_CANCELLED.inactive,
        (w) => ctx.storage.outboundWebhooks.update(w.id, { active: false }),
      ],
      [
        DELIVERY_CANCELLED.repointed,
        (w) =>
          ctx.storage.outboundWebhooks.update(w.id, {
            url: "https://elsewhere.example/hook",
          }),
      ],
    ];
    for (const [reason, change] of cases) {
      const webhook = await subscription(key.id, ["item.created"]);
      const left = await pending(
        webhook,
        { type: "created", item: item("01HCHANGEDCHANGEDCHANGED00") },
        "item.created",
      );
      await change(webhook);
      await new WebhookPoller({ storage: ctx.storage, http }).runOnce();
      expect(await row(left)).toMatchObject({
        status: "cancelled",
        error: reason,
      });
    }
    expect(http.posts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WebhookConsumer — stopping ends both subscriptions
// ---------------------------------------------------------------------------

describe("WebhookConsumer stop", () => {
  it("leaves no listener behind after several start and stop cycles on a quiet bus", async () => {
    const baseline = __listenerCountForTests();
    const c = new WebhookConsumer({ storage: ctx.storage, http: recorder() });
    for (let cycle = 0; cycle < 5; cycle++) {
      c.start();
      await settle();
      // The witness: a running consumer holds one listener per loop.
      expect(__listenerCountForTests()).toBe(baseline + 2);
      c.stop();
      await settle();
      expect(__listenerCountForTests()).toBe(baseline);
    }
  });

  it("starts again after a stop and delivers what follows", async () => {
    const { id } = await owner();
    await subscription(id, ["item.created"]);
    const http = recorder();
    const baseline = __listenerCountForTests();
    const c = new WebhookConsumer({ storage: ctx.storage, http });
    c.start();
    c.stop();
    c.start();
    await settle();
    expect(__listenerCountForTests()).toBe(baseline + 2);
    await publish({ type: "created", item: item("01HRESTARTRESTARTRESTART0") });
    await settle();
    c.stop();
    await settle();
    expect(http.posts).toHaveLength(1);
    expect(__listenerCountForTests()).toBe(baseline);
  });
});
