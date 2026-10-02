/**
 * A signed-in app's subscription belongs to its grant, not to the token that
 * registered it.
 *
 * A token goes while its grant stands more often than a grant goes: a refresh
 * mints the next one, a scope unticked on the consent screen drops every
 * live token, a replayed refresh token does the same, and the browser
 * session a token was issued under can end. None of those is the person
 * withdrawing the app, so none of them may stop its deliveries or hide its
 * subscriptions from its next token. Revoking the grant is, and narrowing it
 * narrows what is sent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Item } from "@withmarfa/shared";
import {
  createTestContext,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { publish } from "../pubsub.js";
import { WebhookConsumer } from "./delivery.js";
import type { WebhookHttpClient, WebhookPost } from "./outbound-http.js";

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

const SCOPES = ["content:read", "webhooks.manage"];

function provider() {
  const p = ctx.storage.oauthProvider;
  if (!p) throw new Error("no OAuth provider store");
  return p;
}

function rawRun(query: string, params: unknown[]): Promise<unknown> {
  return (
    ctx.storage as unknown as {
      __sqliteRun: (q: string, p: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun(query, params);
}

/** A consented grant and a first token under it. */
async function grant(scopes = SCOPES) {
  const seeded = await seedOauthBearer(ctx.storage, scopes);
  const row = await provider().validateAccessToken(
    hashApiKey(seeded.token.slice("marfa_at_".length), TEST_API_KEY_SALT),
  );
  if (!row?.userId) throw new Error("the seeded token did not resolve");
  await provider().upsertConsent({
    clientId: seeded.clientId,
    authUserId: row.userId,
    scopes,
  });
  return {
    clientId: seeded.clientId,
    userId: row.userId,
    first: seeded.token,
    firstId: row.id,
  };
}

/** Another token under the same grant, as a refresh mints one. */
async function nextToken(g: { clientId: string; userId: string }) {
  const raw = `marfa_at_next_${Math.random().toString(36).slice(2)}`;
  await provider().mintTokenPair({
    accessTokenHash: hashApiKey(
      raw.slice("marfa_at_".length),
      TEST_API_KEY_SALT,
    ),
    refreshTokenHash: hashApiKey(
      `refresh_${Math.random().toString(36).slice(2)}`,
      TEST_API_KEY_SALT,
    ),
    clientId: g.clientId,
    authUserId: g.userId,
    scopes: SCOPES,
    accessTtlMs: 3600_000,
  });
  return raw;
}

async function register(token: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/webhooks", {
    key: token,
    body: {
      url: "https://receiver.example/app",
      events: ["item.created"],
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function item(id: string, type = "core.note"): Item {
  return {
    id,
    type,
    version: 1,
    state: "active",
    tier: "library",
    source: "test",
    properties: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Item;
}

async function delivered(items: Item[]): Promise<string[]> {
  const posts: WebhookPost[] = [];
  const http: WebhookHttpClient = {
    post(post) {
      posts.push(post);
      return Promise.resolve({
        kind: "answered",
        status: 200,
        retryAfter: null,
      });
    },
  };
  const consumer = new WebhookConsumer({ storage: ctx.storage, http });
  consumer.start();
  await new Promise((r) => setTimeout(r, 20));
  try {
    for (const i of items) await publish({ type: "created", item: i });
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    consumer.stop();
  }
  return posts.map(
    (p) => (JSON.parse(p.body) as { item: { id: string } }).item.id,
  );
}

describe("a signed-in app's subscription", () => {
  it("belongs to every token of its grant, and keeps delivering when the registering token goes", async () => {
    const g = await grant();
    const id = await register(g.first);
    const next = await nextToken(g);

    // The registering token ends while the grant stands, as a sign-out or
    // an unticked scope ends it.
    await rawRun(
      "UPDATE auth_oauth_access_token SET revoked = ? WHERE id = ?",
      [Date.now(), g.firstId],
    );
    expect(
      (await request(ctx.app, "GET", "/webhooks", { key: g.first })).status,
    ).toBe(401);

    const viaNext = await request(ctx.app, "GET", `/webhooks/${id}`, {
      key: next,
    });
    expect(viaNext.status).toBe(200);
    const listed = (await (
      await request(ctx.app, "GET", "/webhooks", { key: next })
    ).json()) as { data: { id: string }[] };
    expect(listed.data.map((w) => w.id)).toEqual([id]);

    expect(await delivered([item("01HGRANTSTANDSGRANTSTAND0")])).toEqual([
      "01HGRANTSTANDSGRANTSTAND0",
    ]);
  });

  it("is deleted with its grant, and does not return when the same person reconnects the app", async () => {
    const g = await grant();
    const id = await register(g.first);
    // The witness: it exists and delivers while the grant stands.
    expect(await ctx.storage.outboundWebhooks.get(id)).not.toBeNull();
    expect(await delivered([item("01HBEFORERECONNECTBEFORE0")])).toHaveLength(
      1,
    );

    await provider().revokeTokensForGrant(g.clientId, g.userId);
    expect(await ctx.storage.outboundWebhooks.get(id)).toBeNull();

    // The same person consents to the same app again.
    await provider().upsertConsent({
      clientId: g.clientId,
      authUserId: g.userId,
      scopes: SCOPES,
    });
    const reconnected = await nextToken(g);
    expect(await delivered([item("01HAFTERRECONNECTAFTERR00")])).toEqual([]);
    const listed = (await (
      await request(ctx.app, "GET", "/webhooks", { key: reconnected })
    ).json()) as { data: unknown[] };
    expect(listed.data).toEqual([]);
    expect(
      (await request(ctx.app, "GET", `/webhooks/${id}`, { key: reconnected }))
        .status,
    ).toBe(404);
  });

  it("is deleted with every grant of an app when the app is removed", async () => {
    const g = await grant();
    const id = await register(g.first);
    expect(await ctx.storage.outboundWebhooks.get(id)).not.toBeNull();
    await provider().deleteClientRecords(g.clientId);
    expect(await ctx.storage.outboundWebhooks.get(id)).toBeNull();
  });

  it("is not another person's on the same app", async () => {
    const g = await grant();
    const id = await register(g.first);
    const other = await seedOauthBearer(ctx.storage, SCOPES);
    const otherRow = await provider().validateAccessToken(
      hashApiKey(other.token.slice("marfa_at_".length), TEST_API_KEY_SALT),
    );
    if (!otherRow?.userId) throw new Error("the second person did not resolve");
    // The same app, another person.
    const sameApp = await nextToken({
      clientId: g.clientId,
      userId: otherRow.userId,
    });
    // The witness: the owner reads it.
    expect(
      (await request(ctx.app, "GET", `/webhooks/${id}`, { key: g.first }))
        .status,
    ).toBe(200);
    expect(
      (await request(ctx.app, "GET", `/webhooks/${id}`, { key: sameApp }))
        .status,
    ).toBe(404);
    const listed = (await (
      await request(ctx.app, "GET", "/webhooks", { key: sameApp })
    ).json()) as { data: unknown[] };
    expect(listed.data).toEqual([]);
  });

  it("stops delivering once the grant is revoked", async () => {
    const g = await grant();
    await register(g.first);
    // The witness: it delivers while the grant stands.
    expect(await delivered([item("01HBEFOREREVOKEBEFOREREV0")])).toHaveLength(
      1,
    );
    await provider().revokeTokensForGrant(g.clientId, g.userId);
    expect(await delivered([item("01HAFTERREVOKEAFTERREVOK0")])).toEqual([]);
  });

  it("narrows its deliveries when the grant is narrowed", async () => {
    const g = await grant();
    await register(g.first);
    await provider().upsertConsent({
      clientId: g.clientId,
      authUserId: g.userId,
      scopes: ["core.note:read", "webhooks.manage"],
    });
    expect(
      await delivered([
        item("01HNARROWTASKNARROWTASK00", "core.task"),
        item("01HNARROWNOTENARROWNOTE00"),
      ]),
    ).toEqual(["01HNARROWNOTENARROWNOTE00"]);
  });
});
