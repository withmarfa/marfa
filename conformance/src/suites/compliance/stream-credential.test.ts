import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote, createTask } from "../../generators/items.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import {
  approvedApp,
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * An open stream answers to its credential as it stands.
 *
 * Each case shows a frame of the reach under test arriving first, then
 * changes the key and writes the same kind of frame again. A sentinel
 * written after it, or the stream ending, is what makes that frame's
 * absence the key's doing rather than a stream gone quiet.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
/** For the credentials the shared server cannot make: an app's grant, which
 *  needs the instance's owner, and a key with a lifetime. */
let own: FreshServer | undefined;
/** A second server, because an instance has one owner and so approves an app
 *  through the sign-in flow once: `own` spends that on the grant. */
let tokenServer: FreshServer | undefined;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "stream-credential",
  ));
  [own, tokenServer] = await Promise.all([
    bootFreshServer("stream-credential"),
    bootFreshServer("stream-credential-token"),
  ]);
}, FRESH_SERVER_TIMEOUT_MS + 60_000);

afterAll(async () => {
  await cleanup(ctx);
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function task(label: string): Promise<string> {
  const r = await client.createItem(
    createTask({ source: ctx.source, properties: { title: label } }),
  );
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function note(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: label } }),
  );
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

/** A key reading tasks and notes, and its id. */
async function viewer(label: string): Promise<{ id: string; key: string }> {
  const r = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    permissions: [],
    type_permissions: { "core.task": "read", "core.note": "read" },
  });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackKey(ctx, r.data.id);
  return { id: r.data.id, key: r.data.key };
}

const arrived = (events: SseEvent[], id: string): boolean =>
  events.some((e) => (e.data as { item?: { id?: string } }).item?.id === id);

describe("a stream answers to its credential as it stands", () => {
  it("stops delivering a type the key is narrowed away from", async ({
    signal,
  }) => {
    const { id, key } = await viewer("stream-narrowed");
    await withStream(apiUrl, key, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      const before = await task("narrow-before");
      await collectUntil(
        stream,
        (evts) => arrived(evts, before),
        `the task ${before} before the key is narrowed`,
        signal,
      );

      const narrowed = await client.updateKey(id, {
        type_permissions: { "core.note": "read" },
      });
      expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
      const after = await task("narrow-after");
      const sentinel = await note("narrow-sentinel");

      const { events } = await collectUntil(
        stream,
        (evts) => arrived(evts, sentinel),
        `the note ${sentinel} after the key is narrowed`,
        signal,
      );
      expect(
        arrived(events, after),
        "a task written after the key lost core.task reached the stream",
      ).toBe(false);
    });
  });

  it("ends with credential_ended when the key is revoked, and sends nothing after", async ({
    signal,
  }) => {
    const { id, key } = await viewer("stream-revoked");
    await withStream(apiUrl, key, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      const before = await task("revoke-before");
      await collectUntil(
        stream,
        (evts) => arrived(evts, before),
        `the task ${before} before the key is revoked`,
        signal,
      );

      expect((await client.revokeKey(id)).ok).toBe(true);
      const after = await task("revoke-after");

      const { events } = await collectUntil(
        stream,
        (evts) => evts.some((e) => e.event === "stream_incomplete"),
        "the stream to say it ended",
        signal,
      );
      const ended = events.find((e) => e.event === "stream_incomplete");
      expect((ended?.data as { reason?: string }).reason).toBe(
        "credential_ended",
      );
      expect(ended?.id).toBeUndefined();
      expect(arrived(events, after)).toBe(false);
      const reader = stream.response.body?.getReader();
      expect((await reader?.read())?.done).toBe(true);
    });
  });

  it("names the last event it sent in the cursor of credential_ended, and refuses a reconnect with the revoked key 401", async ({
    signal,
  }) => {
    const { id, key } = await viewer("stream-reconnect");
    const lastSent = await withStream(apiUrl, key, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      const sent = await task("reconnect-sent");
      const { events } = await collectUntil(
        stream,
        (evts) => arrived(evts, sent),
        `the task ${sent} before the key is revoked`,
        signal,
      );
      const frame = events.find(
        (e) => (e.data as { item?: { id?: string } }).item?.id === sent,
      );
      expect(frame?.id).toBeDefined();

      expect((await client.revokeKey(id)).ok).toBe(true);
      const ended = await collectUntil(
        stream,
        (evts) => evts.some((e) => e.event === "stream_incomplete"),
        "the stream to say it ended",
        signal,
      );
      const terminal = ended.events.find(
        (e) => e.event === "stream_incomplete",
      );
      expect((terminal?.data as { cursor?: string }).cursor).toBe(frame!.id);
      return frame!.id!;
    });

    const refused = await fetch(`${apiUrl}/events`, {
      headers: { Authorization: `Bearer ${key}`, "Last-Event-ID": lastSent },
    });
    expect(refused.status).toBe(401);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("unauthorized");

    // The witness: the refusal is the key's. A key that stands opens the
    // same request.
    const standing = await viewer("stream-reconnect-standing");
    await withStream(
      apiUrl,
      standing.key,
      { lastEventId: lastSent },
      async (stream) => {
        expect(stream.response.status).toBe(200);
      },
    );
  });
});

/** The interval the server pings a quiet stream at, and the slack the
 *  contract's "about" allows on each side. */
const PING_INTERVAL_MS = 30_000;
const PING_EARLY_MS = 500;
const PING_LATE_MS = 5_000;

describe("a quiet stream", () => {
  it(
    "sends a :ping comment on a quiet stream every 30 seconds",
    async ({ signal }) => {
      const { key } = await viewer("stream-ping");
      const opened = Date.now();
      await withStream(apiUrl, key, {}, async (stream) => {
        const reader = stream.response.body!.getReader();
        const onAbort = () => void reader.cancel().catch(() => undefined);
        signal.addEventListener("abort", onAbort, { once: true });
        const decoder = new TextDecoder();
        let seen = "";
        let pingAt: number | undefined;
        try {
          while (pingAt === undefined) {
            const { done, value } = await reader.read();
            if (done) {
              throw new Error(
                `the stream closed before a ping; read ${JSON.stringify(seen)}`,
              );
            }
            seen += decoder.decode(value, { stream: true });
            if (seen.includes("\n:ping\n\n")) pingAt = Date.now() - opened;
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          reader.releaseLock();
        }

        // The stream is live: it announced itself before it went quiet.
        expect(seen).toContain("event: stream_cursor");
        expect(pingAt).toBeGreaterThanOrEqual(PING_INTERVAL_MS - PING_EARLY_MS);
        expect(pingAt).toBeLessThanOrEqual(PING_INTERVAL_MS + PING_LATE_MS);
      });
    },
    PING_INTERVAL_MS + PING_LATE_MS + 15_000,
  );
});

const runSqlite = promisify(execFile);

/** Past the restart that sets a key's lifetime, so the key stands when the
 *  stream opens and lapses a while after. */
const LIFETIME_MS = 20_000;

describe("a stream answers to a credential only a server of its own can make", () => {
  const writerOf = (server: FreshServer): MarfaClient =>
    new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });

  const noteOn = async (server: FreshServer, body: string): Promise<string> => {
    const created = await writerOf(server).createItem({
      type: "core.note",
      properties: { body },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    return created.data.item.id;
  };

  it(
    "ends a stream with credential_ended once its key expires",
    async ({ signal }) => {
      const server = own!;
      // No door mints a key with a lifetime, so the stored key is given one
      // while the server is stopped.
      const minted = await writerOf(server).createKey({
        label: "stream-expires",
        source: "stream-expires",
        permissions: [],
        type_permissions: { "core.note": "read" },
      });
      expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
      const expiresAt = new Date(Date.now() + LIFETIME_MS);
      await server.restart({
        whileStopped: async () => {
          await runSqlite("sqlite3", [
            server.sqlitePath,
            `UPDATE api_keys SET expires_at = '${expiresAt.toISOString()}' WHERE id = '${minted.data.id}';`,
          ]);
        },
      });

      const last = await withStream(
        server.apiUrl,
        minted.data.key,
        {},
        async (stream) => {
          await collectUntil(
            stream,
            (events) => events.some((e) => e.event === "stream_cursor"),
            "the frame announcing the stream's position",
            signal,
          );
          // The witness: the key reads the stream while it stands.
          const before = await noteOn(server, "expires-before");
          const first = await collectUntil(
            stream,
            (events) => arrived(events, before),
            `the note ${before} before the key expires`,
            signal,
          );
          const frame = first.events.find(
            (e) => (e.data as { item?: { id?: string } }).item?.id === before,
          );
          expect(
            Date.now() < expiresAt.getTime(),
            "the key expired before the stream was shown to work",
          ).toBe(true);

          await new Promise((resolve) =>
            setTimeout(resolve, expiresAt.getTime() - Date.now() + 250),
          );
          // A write after the lifetime, so the stream reads its credential
          // again with a frame to deliver.
          const after = await noteOn(server, "expires-after");
          const { events } = await collectUntil(
            stream,
            (seen) => seen.some((e) => e.event === "stream_incomplete"),
            "the stream to say it ended",
            signal,
          );
          const ended = events.find((e) => e.event === "stream_incomplete");
          expect((ended?.data as { reason?: string }).reason).toBe(
            "credential_ended",
          );
          expect((ended?.data as { cursor?: string }).cursor).toBe(frame?.id);
          expect(ended?.id).toBeUndefined();
          expect(arrived(events, after)).toBe(false);
          return frame!.id!;
        },
      );

      const refused = await fetch(`${server.apiUrl}/events`, {
        headers: {
          Authorization: `Bearer ${minted.data.key}`,
          "Last-Event-ID": last,
        },
      });
      expect(refused.status).toBe(401);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "ends a stream with credential_ended when its app's grant is revoked",
    async ({ signal }) => {
      const server = own!;
      const token = await approvedAppToken(server);
      const authorization = { Authorization: `Bearer ${server.workingKey}` };
      const listed = await fetch(`${server.apiUrl}/auth/grants`, {
        headers: authorization,
      });
      expect(listed.status).toBe(200);
      const held = ((await listed.json()) as { data: { id: string }[] }).data;
      expect(held).toHaveLength(1);

      await withStream(server.apiUrl, token, {}, async (stream) => {
        await collectUntil(
          stream,
          (events) => events.some((e) => e.event === "stream_cursor"),
          "the frame announcing the stream's position",
          signal,
        );
        // The witness: the app reads the stream while its grant stands.
        const before = await noteOn(server, "grant-before");
        await collectUntil(
          stream,
          (events) => arrived(events, before),
          `the note ${before} before the grant is revoked`,
          signal,
        );

        const revoked = await fetch(
          `${server.apiUrl}/auth/grants/${held[0]!.id}`,
          { method: "DELETE", headers: authorization },
        );
        expect(revoked.status).toBe(204);
        const after = await noteOn(server, "grant-after");

        const { events } = await collectUntil(
          stream,
          (seen) => seen.some((e) => e.event === "stream_incomplete"),
          "the stream to say it ended",
          signal,
        );
        const ended = events.find((e) => e.event === "stream_incomplete");
        expect((ended?.data as { reason?: string }).reason).toBe(
          "credential_ended",
        );
        expect(ended?.id).toBeUndefined();
        expect(arrived(events, after)).toBe(false);
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "ends a stream with credential_ended when its access token is revoked",
    async ({ signal }) => {
      const server = tokenServer!;
      const app = await approvedApp(server);

      await withStream(server.apiUrl, app.token, {}, async (stream) => {
        await collectUntil(
          stream,
          (events) => events.some((e) => e.event === "stream_cursor"),
          "the frame announcing the stream's position",
          signal,
        );
        // The witness: the app reads the stream while its token stands.
        const before = await noteOn(server, "token-before");
        await collectUntil(
          stream,
          (events) => arrived(events, before),
          `the note ${before} before the token is revoked`,
          signal,
        );

        const revoked = await fetch(`${server.apiUrl}/auth/oauth2/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: app.token,
            token_type_hint: "access_token",
            client_id: app.clientId,
          }),
        });
        await revoked.body?.cancel();
        expect(revoked.status).toBe(200);
        const after = await noteOn(server, "token-after");

        const { events } = await collectUntil(
          stream,
          (seen) => seen.some((e) => e.event === "stream_incomplete"),
          "the stream to say it ended",
          signal,
        );
        const ended = events.find((e) => e.event === "stream_incomplete");
        expect((ended?.data as { reason?: string }).reason).toBe(
          "credential_ended",
        );
        expect(ended?.id).toBeUndefined();
        expect(arrived(events, after)).toBe(false);
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
