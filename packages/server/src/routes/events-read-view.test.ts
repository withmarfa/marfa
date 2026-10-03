import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __listenerCountForTests, emitWake, initEventLog } from "../pubsub.js";
import { authMiddleware, hashApiKey, type AppEnv } from "../middleware/auth.js";
import { createErrorHandler } from "../middleware/error-handler.js";
import {
  createTestContext,
  readSse,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
import { eventRoutes, type EventRoutesOptions } from "./events.js";
import { deriveKey, SECRET_INFO } from "../crypto/derive-key.js";

let ctx: TestContext;
let instanceId: string;
beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  instanceId = (
    (await (await request(ctx.app, "GET", "/")).json()) as {
      instance_id: string;
    }
  ).instance_id;
});
afterAll(async () => {
  await ctx.cleanup();
});
function app(options: EventRoutesOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.use("*", async (c, next) => {
    c.set("config", ctx.config);
    await next();
  });
  app.use("*", authMiddleware(ctx.storage, "test-salt"));
  app.route(
    "/events",
    eventRoutes(ctx.storage, {
      readView: {
        instanceId,
        signingKey: deriveKey(ctx.config.authSecret, SECRET_INFO.readView),
      },
      ...options,
    }),
  );
  return app;
}
function gate(): {
  reached: Promise<void>;
  arrive: () => void;
  opened: Promise<void>;
  open: () => void;
} {
  let arrive: () => void = () => undefined;
  let open: () => void = () => undefined;
  return {
    reached: new Promise<void>((resolve) => {
      arrive = resolve;
    }),
    get arrive() {
      return arrive;
    },
    opened: new Promise<void>((resolve) => {
      open = resolve;
    }),
    get open() {
      return open;
    },
  };
}
function marker(text: string, type: string): Record<string, unknown> {
  const frame = text
    .split("\n\n")
    .find((part) => part.includes(`event: ${type}\n`));
  const line = frame?.split("\n").find((part) => part.startsWith("data: "));
  if (!line) throw new Error(`No ${type} marker`);
  return JSON.parse(line.slice(6)) as Record<string, unknown>;
}
async function fence(key = ctx.workingKey): Promise<string> {
  const res = await request(ctx.app, "GET", "/events?edges=all&copy=1", {
    key,
  });
  const { text } = await readSse(res, {
    until: (text) => text.includes("event: stream_live"),
  });
  return marker(text, "stream_live").read_view as string;
}
async function workingKey() {
  const stored = await ctx.storage.keys.validate(
    hashApiKey(ctx.workingKey, "test-salt"),
  );
  if (!stored) throw new Error("Working key missing");
  return stored;
}
async function note(body: string): Promise<void> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
}
describe("copy stream snapshot decisions", () => {
  it("retains an ordinary quiet stream and completes the copy tuple", async () => {
    const normal = await request(app(), "GET", "/events", {
      key: ctx.workingKey,
    });
    const { text: ordinary } = await readSse(normal, {
      until: (text) => text.includes("event: stream_live"),
    });
    expect(marker(ordinary, "stream_live")).not.toHaveProperty("read_view");
    expect(await fence()).toMatch(/^[a-f0-9]{64}$/);
  });
  it("emits only incomplete when the opening head times out, including a late completion", async () => {
    await fence();
    const store = ctx.storage.eventLog;
    const real = store.getMaxId.bind(store);
    const parked = gate();
    store.getMaxId = async () => {
      const head = await real();
      parked.arrive();
      await parked.opened;
      return head;
    };
    try {
      const opening = request(
        app({ headReadTimeoutMs: 25 }),
        "GET",
        "/events?edges=all&copy=1",
        { key: ctx.workingKey },
      );
      await parked.reached;
      const res = await opening;
      expect(res.status).toBe(200);
      const text = await res.text();
      parked.open();
      expect(text).toContain('"reason":"replay_failed"');
      expect(text).not.toContain("stream_cursor");
      expect(text).not.toContain("stream_live");
      expect(text).not.toContain(": connected");
    } finally {
      parked.open();
      store.getMaxId = real;
    }
  });
  it("checks quiet heartbeats and closes without disclosing a new tuple", async () => {
    const stored = await workingKey();
    const res = await request(
      app({ keepAliveMs: 20 }),
      "GET",
      "/events?edges=all&copy=1",
      { key: ctx.workingKey },
    );
    let change: Promise<unknown> | undefined;
    try {
      const { text } = await readSse(res, {
        until: (text) => text.includes("event: read_view_changed"),
        onChunk: (text) => {
          if (!change && text.includes("event: stream_live"))
            change = ctx.storage.keys.update(stored.id, {
              type_permissions: {},
            });
        },
      });
      await change;
      expect(marker(text, "read_view_changed")).toEqual({
        type: "read_view_changed",
      });
      expect(text.split("event: stream_live")).toHaveLength(2);
    } finally {
      await ctx.storage.keys.update(stored.id, {
        type_permissions: stored.type_permissions,
      });
    }
  });
  it("checks the fence while replay waits for the reader, and lets a writer finish", async () => {
    await note("paced replay witness");
    const proof = await fence();
    const stored = await workingKey();
    const res = await request(
      app({ maxUnsentBytes: 100, keepAliveMs: 20 }),
      "GET",
      "/events?edges=all&copy=1",
      {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": "0", "X-Marfa-Read-View": proof },
      },
    );
    try {
      await note("writer completes with replay queue blocked");
      await ctx.storage.keys.update(stored.id, { type_permissions: {} });
      const { text } = await readSse(res, {
        until: (text) => text.includes("event: read_view_changed"),
      });
      expect(marker(text, "read_view_changed")).toEqual({
        type: "read_view_changed",
      });
      expect(text).not.toContain("event: stream_live");
      expect(text).not.toContain("writer completes with replay queue blocked");
    } finally {
      await ctx.storage.keys.update(stored.id, {
        type_permissions: stored.type_permissions,
      });
    }
  });
  it("drains an arrival during the final capture before announcing live", async () => {
    const real = ctx.storage.keys.validate.bind(ctx.storage.keys);
    const parked = gate();
    let calls = 0;
    ctx.storage.keys.validate = async (hash) => {
      const value = await real(hash);
      if (++calls === 3) {
        parked.arrive();
        await parked.opened;
      }
      return value;
    };
    try {
      const res = await request(app(), "GET", "/events?edges=all&copy=1", {
        key: ctx.workingKey,
      });
      const reading = readSse(res, {
        until: (text) => text.includes("event: stream_live"),
      });
      await parked.reached;
      // Restore before the write's admission check, preserving the parked read.
      ctx.storage.keys.validate = real;
      await note("arrived during final capture");
      parked.open();
      const { text } = await reading;
      expect(text.indexOf("arrived during final capture")).toBeGreaterThan(-1);
      expect(text.indexOf("arrived during final capture")).toBeLessThan(
        text.indexOf("event: stream_live"),
      );
      const applied = [...text.matchAll(/^id: ([0-9]+)$/gm)].map((match) =>
        BigInt(match[1]!),
      );
      expect(
        BigInt(marker(text, "stream_live").cursor as string),
      ).toBeGreaterThanOrEqual(applied.at(-1)!);
    } finally {
      parked.open();
      ctx.storage.keys.validate = real;
    }
  });
  it("releases setup subscriptions on a mismatched resume with arrivals", async () => {
    const proof = await fence();
    const stored = await workingKey();
    await ctx.storage.keys.update(stored.id, {
      type_permissions: { "core.task": "read" },
    });
    const listeners = __listenerCountForTests();
    try {
      const res = await request(
        app({ maxViewers: 1 }),
        "GET",
        "/events?edges=all&copy=1",
        {
          key: ctx.workingKey,
          headers: { "Last-Event-ID": "0", "X-Marfa-Read-View": proof },
        },
      );
      expect(res.status).toBe(409);
      expect(__listenerCountForTests()).toBe(listeners);
    } finally {
      await ctx.storage.keys.update(stored.id, {
        type_permissions: stored.type_permissions,
      });
    }
  });
  it("releases setup arrivals and capacity after a pre-start mismatch", async () => {
    const proof = await fence();
    const stored = await workingKey();
    const real = ctx.storage.runInReadSnapshot.bind(ctx.storage);
    const parked = gate();
    let armed = true;
    ctx.storage.runInReadSnapshot = async (fn, options) => {
      if (armed) {
        armed = false;
        parked.arrive();
        await parked.opened;
      }
      return real(fn, options);
    };
    const viewer = app({ maxViewers: 1 });
    const listeners = __listenerCountForTests();
    try {
      const opening = request(viewer, "GET", "/events?edges=all&copy=1", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": "0", "X-Marfa-Read-View": proof },
      });
      await parked.reached;
      await note("arrived before capture");
      await ctx.storage.keys.update(stored.id, {
        type_permissions: { "core.task": "read" },
      });
      parked.open();
      const res = await opening;
      expect(res.status).toBe(409);
      expect(__listenerCountForTests()).toBe(listeners);
      await ctx.storage.keys.update(stored.id, {
        type_permissions: stored.type_permissions,
      });
      const fresh = await request(viewer, "GET", "/events?edges=all&copy=1", {
        key: ctx.workingKey,
      });
      expect(fresh.status).toBe(200);
      const { text } = await readSse(fresh, {
        until: (text) => text.includes("event: stream_live"),
      });
      expect(marker(text, "stream_live").read_view).toBe(proof);
    } finally {
      parked.open();
      ctx.storage.runInReadSnapshot = real;
      await ctx.storage.keys.update(stored.id, {
        type_permissions: stored.type_permissions,
      });
    }
  });
  it("checks a changed fence before even an empty replay result advances", async () => {
    const proof = await fence();
    const head = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    const stored = await workingKey();
    const real = ctx.storage.runInReadSnapshot.bind(ctx.storage);
    const parked = gate();
    let turns = 0;
    ctx.storage.runInReadSnapshot = async (fn, options) => {
      if (++turns === 2) {
        parked.arrive();
        await parked.opened;
      }
      return real(fn, options);
    };
    try {
      const res = await request(app(), "GET", "/events?edges=all&copy=1", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(head), "X-Marfa-Read-View": proof },
      });
      const reading = readSse(res, {
        until: (text) => text.includes("event: read_view_changed"),
      });
      await parked.reached;
      expect(await ctx.storage.eventLog.getAfter(head, 500)).toEqual([]);
      await ctx.storage.keys.update(stored.id, { type_permissions: {} });
      parked.open();
      const { text } = await reading;
      expect(marker(text, "read_view_changed")).toEqual({
        type: "read_view_changed",
      });
      expect(text).not.toContain("event: stream_live");
      expect(text).not.toMatch(/^id:/m);
    } finally {
      parked.open();
      ctx.storage.runInReadSnapshot = real;
      await ctx.storage.keys.update(stored.id, {
        type_permissions: stored.type_permissions,
      });
    }
  });
  it("rechecks held release after reader pacing", async () => {
    const realHead = ctx.storage.eventLog.getMaxId.bind(ctx.storage.eventLog);
    const parkedHead = gate();
    ctx.storage.eventLog.getMaxId = async () => {
      const head = await realHead();
      parkedHead.arrive();
      await parkedHead.opened;
      return head;
    };
    const realKey = ctx.storage.keys.validate.bind(ctx.storage.keys);
    const classified = gate();
    let calls = 0;
    ctx.storage.keys.validate = async (hash) => {
      const key = await realKey(hash);
      if (++calls === 3) {
        classified.arrive();
        await classified.opened;
      }
      return key;
    };
    const stored = await realKey(hashApiKey(ctx.workingKey, "test-salt"));
    if (!stored) throw new Error("Working key missing");
    try {
      const opening = request(
        app({ maxUnsentBytes: 100 }),
        "GET",
        "/events?edges=all&copy=1",
        { key: ctx.workingKey },
      );
      await parkedHead.reached;
      ctx.storage.keys.validate = realKey;
      await note("held release witness");
      ctx.storage.keys.validate = async (hash) => {
        const key = await realKey(hash);
        classified.arrive();
        await classified.opened;
        return key;
      };
      parkedHead.open();
      const res = await opening;
      await classified.reached;
      await ctx.storage.keys.update(stored.id, { type_permissions: {} });
      classified.open();
      ctx.storage.keys.validate = realKey;
      const { text } = await readSse(res, {
        until: (text) => text.includes("event: read_view_changed"),
      });
      expect(text).not.toContain("held release witness");
      expect(text).not.toContain("event: stream_live");
      expect(marker(text, "read_view_changed")).toEqual({
        type: "read_view_changed",
      });
    } finally {
      parkedHead.open();
      classified.open();
      ctx.storage.eventLog.getMaxId = realHead;
      ctx.storage.keys.validate = realKey;
      await ctx.storage.keys.update(stored.id, {
        type_permissions: stored.type_permissions,
      });
    }
  });
  it("cancels an in-flight final decision without late markers or retained subscriptions", async () => {
    const real = ctx.storage.keys.validate.bind(ctx.storage.keys);
    const parked = gate();
    let calls = 0;
    ctx.storage.keys.validate = async (hash) => {
      const key = await real(hash);
      if (++calls === 3) {
        parked.arrive();
        await parked.opened;
      }
      return key;
    };
    const listeners = __listenerCountForTests();
    try {
      const res = await request(app(), "GET", "/events?edges=all&copy=1", {
        key: ctx.workingKey,
      });
      const reader = res.body!.getReader();
      const first = await reader.read();
      const second = await reader.read();
      const witness =
        new TextDecoder().decode(first.value) +
        new TextDecoder().decode(second.value);
      expect(witness).toContain("event: stream_cursor");
      await parked.reached;
      await reader.cancel();
      parked.open();
      expect((await reader.read()).done).toBe(true);
      expect(__listenerCountForTests()).toBe(listeners);
    } finally {
      parked.open();
      ctx.storage.keys.validate = real;
    }
  });
  it("does not resend an early held carrier after more than one replay page", async () => {
    await note("replay item witness");
    const row = (await ctx.storage.eventLog.getAfter(0n, 10_000)).at(-1)!;
    const item = (
      JSON.parse(row.payload) as { item: import("@withmarfa/shared").Item }
    ).item;
    const after = row.id;
    let first = 0n;
    await ctx.storage.runInTransaction(async () => {
      for (let index = 0; index < 601; index++) {
        const id = await ctx.storage.eventLog.append({
          event_type: "updated",
          item_id: item.id,
          edge_id: null,
          payload: JSON.stringify({
            type: "item.updated",
            item: {
              ...item,
              properties: { body: `multi-page-${String(index)}` },
            },
          }),
        });
        if (index === 0) first = id;
      }
    });
    const proof = await fence();
    const real = ctx.storage.eventLog.getAfter.bind(ctx.storage.eventLog);
    const parked = gate();
    let armed = true;
    ctx.storage.eventLog.getAfter = async (cursor, limit) => {
      if (armed) {
        armed = false;
        parked.arrive();
        await parked.opened;
      }
      return real(cursor, limit);
    };
    try {
      const res = await request(app(), "GET", "/events?edges=all&copy=1", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(after), "X-Marfa-Read-View": proof },
      });
      const reading = readSse(res, {
        until: (text) => text.includes("event: stream_live"),
      });
      await parked.reached;
      emitWake({
        type: "updated",
        item: { ...item, properties: { body: "multi-page-0" } },
        eventId: first,
      });
      parked.open();
      const { text } = await reading;
      const ids = [...text.matchAll(/^id: ([0-9]+)$/gm)].map((match) =>
        BigInt(match[1]!),
      );
      expect(ids).toHaveLength(601);
      expect(ids.filter((id) => id === first)).toHaveLength(1);
      expect(
        ids.every((id, index) => index === 0 || id > ids[index - 1]!),
      ).toBe(true);
    } finally {
      parked.open();
      ctx.storage.eventLog.getAfter = real;
    }
  });
  it("bounds raw opening arrivals, terminates overflow, and releases capacity", async () => {
    await note("raw arrival witness");
    const row = (await ctx.storage.eventLog.getAfter(0n, 10_000)).at(-1)!;
    const item = (
      JSON.parse(row.payload) as { item: import("@withmarfa/shared").Item }
    ).item;
    const viewer = app({ maxViewers: 1 });
    const real = ctx.storage.eventLog.getMaxId.bind(ctx.storage.eventLog);
    const runOpening = async (count: number): Promise<string> => {
      const parked = gate();
      ctx.storage.eventLog.getMaxId = async () => {
        const value = await real();
        parked.arrive();
        await parked.opened;
        return value;
      };
      try {
        const opening = request(viewer, "GET", "/events?edges=all&copy=1", {
          key: ctx.workingKey,
        });
        await parked.reached;
        for (let index = 0; index < count; index++)
          emitWake({ type: "updated", item });
        if (count <= 500) parked.open();
        const res = await opening;
        expect(res.status).toBe(200);
        const { text } = await readSse(res, {
          until: (text) =>
            text.includes(
              count <= 500 ? "event: stream_live" : "event: stream_incomplete",
            ),
        });
        return text;
      } finally {
        parked.open();
        ctx.storage.eventLog.getMaxId = real;
      }
    };
    const listeners = __listenerCountForTests();
    const accepted = await runOpening(2);
    expect(accepted.match(/event: item.updated/g)).toHaveLength(2);
    expect(accepted).toContain("event: stream_live");
    const overflow = await runOpening(501);
    expect(marker(overflow, "stream_incomplete").reason).toBe(
      "backlog_overflow",
    );
    expect(overflow).not.toContain("event: stream_cursor");
    expect(overflow).not.toContain("event: stream_live");
    expect(overflow).not.toMatch(/^id:/m);
    expect(__listenerCountForTests()).toBe(listeners);
    const fresh = await request(viewer, "GET", "/events?edges=all&copy=1", {
      key: ctx.workingKey,
    });
    const { text } = await readSse(fresh, {
      until: (text) => text.includes("event: stream_live"),
    });
    expect(text).toContain("event: stream_live");
  });
  it("keeps the same fence across a real OAuth refresh without consulting the provider adapter", async () => {
    const scopes = ["content:read", "offline_access"];
    const seeded = await seedOauthBearer(ctx.storage, scopes);
    const row = await ctx.storage.oauthProvider!.validateAccessToken(
      hashApiKey(seeded.token.slice("marfa_at_".length), "test-salt"),
    );
    if (!row?.userId) throw new Error("Seeded bearer missing");
    const original = "marfa_at_read_view_original";
    const refresh = "marfa_rt_read_view_original";
    await ctx.storage.oauthProvider!.mintTokenPair({
      accessTokenHash: hashApiKey(
        original.slice("marfa_at_".length),
        "test-salt",
      ),
      refreshTokenHash: hashApiKey(
        refresh.slice("marfa_rt_".length),
        "test-salt",
      ),
      clientId: seeded.clientId,
      authUserId: row.userId,
      scopes,
      accessTtlMs: 60_000,
    });
    const escape = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, args: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    await escape(
      "UPDATE auth_oauth_client SET public = 1, token_endpoint_auth_method = 'none', grant_types = ?, scopes = NULL WHERE client_id = ?",
      [JSON.stringify(["refresh_token"]), seeded.clientId],
    );
    const proof = await fence(original);
    const refreshed = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: seeded.clientId,
      },
      headers: { origin: ctx.config.authBaseUrl },
    });
    const body = (await refreshed.json()) as { access_token?: string };
    expect(refreshed.status, JSON.stringify(body)).toBe(200);
    expect(body.access_token).not.toBe(original);
    const descriptor = Object.getOwnPropertyDescriptor(
      ctx.storage,
      "betterAuthDb",
    )!;
    let adapterReads = 0;
    Object.defineProperty(ctx.storage, "betterAuthDb", {
      configurable: true,
      get() {
        adapterReads += 1;
        throw new Error("Certified reads cannot use the provider adapter");
      },
    });
    try {
      const read = await request(ctx.app, "GET", "/types", {
        key: body.access_token!,
        headers: { "X-Marfa-Read-View": proof },
      });
      expect(read.status).toBe(200);
      expect(read.headers.get("X-Marfa-Read-View")).toBe(proof);
      expect(adapterReads).toBe(0);
    } finally {
      Object.defineProperty(ctx.storage, "betterAuthDb", descriptor);
    }
  });
});
