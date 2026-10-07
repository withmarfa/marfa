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

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "stream-credential",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

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
