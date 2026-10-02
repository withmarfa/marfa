/**
 * An open stream answers to its credential as it stands, not as it stood
 * when the stream connected.
 *
 * Every case first shows the stream delivering a frame of the reach under
 * test, then changes the credential, then writes the same kind of frame
 * and a sentinel after it. The sentinel arriving, or the stream ending, is
 * what makes the later frame's absence the credential's doing rather than
 * a stream that had gone quiet.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import {
  createTestContext,
  mintWorkingKey,
  readSse,
  readSseWriting,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import type { SseReadOptions, TestContext } from "../test-utils.js";
import { eventRoutes } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function write(type: string, marker: string): Promise<void> {
  const properties =
    type === "core.note" ? { body: marker } : { title: marker };
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type, properties },
  });
  expect(res.status).toBe(201);
}

async function keyId(raw: string): Promise<string> {
  const res = await request(ctx.app, "GET", "/keys/current", { key: raw });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

function rawSql(sql: string): Promise<unknown> {
  const s = ctx.storage as unknown as {
    __sqliteRun?: (query: string, params: unknown[]) => Promise<unknown>;
  };
  if (!s.__sqliteRun) throw new Error("test storage exposes no __sqliteRun");
  return s.__sqliteRun(sql, []);
}

async function open(key: string): Promise<Response> {
  const res = await request(ctx.app, "GET", "/events", { key });
  expect(res.status).toBe(200);
  return res;
}

/**
 * Write a frame of the reach under test and wait for it, then change the
 * credential and write `after`, reading on until `until` holds. Each step
 * is placed on an observed frame rather than on a pause.
 */
async function acrossAChange(
  res: Response,
  label: string,
  change: () => Promise<void>,
  after: () => Promise<void>,
  until: SseReadOptions,
): Promise<string> {
  const before = `ZZbefore-${label}ZZ`;
  let stage = 0;
  let step: Promise<void> = Promise.resolve();
  const { text } = await readSse(res, {
    ...until,
    onChunk: (seen) => {
      if (stage === 0 && seen.includes("event: stream_live")) {
        stage = 1;
        step = write("core.task", before);
      } else if (stage === 1 && seen.includes(before)) {
        stage = 2;
        step = change().then(after);
      }
      step.catch(() => undefined);
    },
  });
  await step;
  expect(
    text,
    "the witness: the reach was delivered before the change",
  ).toContain(before);
  return text;
}

describe("a stream narrows with its credential", () => {
  it("stops delivering a type the key is narrowed away from", async () => {
    const raw = await mintWorkingKey(ctx, {
      type_permissions: { "core.task": "read", "core.note": "read" },
      edge_permissions: {},
      extension_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      permissions: [],
    });
    const id = await keyId(raw);
    const res = await open(raw);
    const hidden = "ZZafter-narrow-taskZZ";
    const sentinel = "ZZafter-narrow-noteZZ";
    const text = await acrossAChange(
      res,
      "narrow",
      async () => {
        const patched = await request(ctx.app, "PATCH", `/keys/${id}`, {
          key: ctx.workingKey,
          body: { type_permissions: { "core.note": "read" } },
        });
        expect(patched.status).toBe(200);
      },
      async () => {
        await write("core.task", hidden);
        await write("core.note", sentinel);
      },
      { until: (seen) => seen.includes(sentinel) },
    );
    expect(
      text,
      "a task written after the key lost core.task reached the stream",
    ).not.toContain(hidden);
  });
});

describe("a stream ends when its credential stops standing", () => {
  const endsWithoutTheLaterFrame = (text: string, hidden: string): void => {
    expect(text).not.toContain(hidden);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"credential_ended"');
  };

  it("ends at the next frame when the key is revoked", async () => {
    const raw = await mintWorkingKey(ctx);
    const id = await keyId(raw);
    const res = await open(raw);
    const hidden = "ZZafter-revokeZZ";
    const text = await acrossAChange(
      res,
      "revoke",
      async () => {
        const revoked = await request(ctx.app, "DELETE", `/keys/${id}`, {
          key: ctx.workingKey,
        });
        expect(revoked.status).toBe(200);
      },
      () => write("core.task", hidden),
      { untilClosed: true },
    );
    endsWithoutTheLaterFrame(text, hidden);
  });

  it("ends at the next frame when the key passes its expiry", async () => {
    const raw = await mintWorkingKey(ctx);
    const id = await keyId(raw);
    const res = await open(raw);
    const hidden = "ZZafter-key-expiryZZ";
    const text = await acrossAChange(
      res,
      "key-expiry",
      () =>
        rawSql(
          `UPDATE api_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`,
        ).then(() => undefined),
      () => write("core.task", hidden),
      { untilClosed: true },
    );
    endsWithoutTheLaterFrame(text, hidden);
  });

  it("ends at the next frame when a sign-in's token passes its expiry", async () => {
    const { token, clientId } = await seedOauthBearer(ctx.storage, [
      "core.task:read",
    ]);
    const res = await open(token);
    const hidden = "ZZafter-token-expiryZZ";
    const text = await acrossAChange(
      res,
      "token-expiry",
      () =>
        rawSql(
          `UPDATE auth_oauth_access_token SET expires_at = 1 WHERE client_id = '${clientId}'`,
        ).then(() => undefined),
      () => write("core.task", hidden),
      { untilClosed: true },
    );
    endsWithoutTheLaterFrame(text, hidden);
  });

  it("ends at the next frame when the app is disconnected", async () => {
    const { token, grantId } = await seedOauthBearer(ctx.storage, [
      "core.task:read",
    ]);
    const res = await open(token);
    const hidden = "ZZafter-disconnectZZ";
    const text = await acrossAChange(
      res,
      "disconnect",
      async () => {
        const revoked = await request(
          ctx.app,
          "DELETE",
          `/auth/grants/${grantId}`,
          { key: ctx.workingKey },
        );
        expect(revoked.status).toBe(204);
      },
      () => write("core.task", hidden),
      { untilClosed: true },
    );
    endsWithoutTheLaterFrame(text, hidden);
  });

  it("ends a quiet stream at its heartbeat", async () => {
    const raw = await mintWorkingKey(ctx);
    const id = await keyId(raw);
    const app = new Hono<AppEnv>();
    // The real bearer check is the app's; here the stored key the test
    // revokes is presented directly, with a heartbeat the test can wait on.
    const viewer = await ctx.storage.keys.get(id);
    if (!viewer) throw new Error("the minted key does not read back");
    app.use("*", async (c, next) => {
      c.set("apiKey", viewer);
      await next();
    });
    app.route("/events", eventRoutes(ctx.storage, { keepAliveMs: 100 }));

    const res = await app.request("/events");
    expect(res.status).toBe(200);
    const { text } = await readSseWriting(
      res,
      "event: stream_live",
      async () => {
        // The witness: heartbeats arrive while the key stands.
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(
          (
            await request(ctx.app, "DELETE", `/keys/${id}`, {
              key: ctx.workingKey,
            })
          ).status,
        ).toBe(200);
      },
      { untilClosed: true },
    );
    expect(text).toContain(":ping");
    expect(text).toContain('"reason":"credential_ended"');
  });
});
