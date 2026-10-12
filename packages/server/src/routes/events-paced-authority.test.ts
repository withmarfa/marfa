import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AppEnv } from "../middleware/auth.js";
import {
  createTestContext,
  storedViewerKey,
  request,
  readSse,
} from "../test-utils.js";
import { eventRoutes } from "./events.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

const observed = vi.hoisted(() => ({ notify: (): void => undefined }));
vi.mock("../auth/live-credential.js", async (original) => {
  const actual = await original<typeof import("../auth/live-credential.js")>();
  return {
    ...actual,
    resolveLiveCredential: async (
      ...args: Parameters<typeof actual.resolveLiveCredential>
    ) => {
      const result = await actual.resolveLiveCredential(...args);
      observed.notify();
      return result;
    },
  };
});

it.each([
  ["drain", "widen"],
  ["drain", "narrow"],
  ["drain", "revoke"],
  ["replay", "widen"],
  ["replay", "narrow"],
  ["replay", "revoke"],
] as const)(
  "uses current authority after %s pacing during %s",
  async (path, change) => {
    const ctx = await createTestContext();
    initEventLog(ctx.storage.eventLog);
    const abort = new AbortController();
    let release!: () => void;
    let arrive!: () => void;
    const headGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedHead = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const originalHead = ctx.storage.eventLog.getMaxId.bind(
      ctx.storage.eventLog,
    );
    ctx.storage.eventLog.getMaxId = async () => {
      arrive();
      await headGate;
      return originalHead();
    };
    let keyId = "";
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      storedViewerKey(ctx, {
        type_permissions:
          change === "widen"
            ? { "core.note": "read" }
            : { "core.note": "read", "core.task": "read" },
      }),
    );
    app.use("*", async (c, next) => {
      const key = c.get("apiKey");
      if (!key) throw new Error("stored viewer key is missing");
      keyId = key.id;
      await next();
    });
    app.route(
      "/events",
      eventRoutes(ctx.storage, { maxUnsentBytes: 1, keepAliveMs: 60_000 }),
    );

    let notify!: () => void;
    const authorityRead = new Promise<void>((resolve) => {
      notify = resolve;
    });
    observed.notify = notify;
    try {
      const res = await app.request("/events", {
        signal: abort.signal,
        headers: path === "replay" ? { "Last-Event-ID": "0" } : {},
      });
      expect(res.status).toBe(200);
      await reachedHead;
      if (path === "replay") {
        const note = await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: { type: "core.note", properties: { body: "paced-anchor" } },
        });
        expect(note.status).toBe(201);
      }
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.task", properties: { title: "paced-candidate" } },
      });
      expect(created.status).toBe(201);
      const candidate = ((await created.json()) as { item: { id: string } })
        .item.id;
      const id = await originalHead();
      release();

      let opening = "";
      if (path === "replay") {
        // The opening queue is full before replay can read a page. Consume
        // only its two prologue chunks, leaving the note to fill the queue.
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        for (let i = 0; i < 2; i += 1) {
          const chunk = await reader.read();
          expect(chunk.done).toBe(false);
          opening += decoder.decode(chunk.value);
        }
        reader.releaseLock();
        expect(opening).toContain(": connected");
        expect(opening).toContain("event: stream_cursor");
      }
      // Observed completion of the real credential read, followed by a
      // scheduling turn: the queue stays full with no reader outstanding,
      // so the next candidate is now waiting for room, before a heartbeat.
      await authorityRead;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const changed = await request(
        ctx.app,
        change === "revoke" ? "DELETE" : "PATCH",
        `/keys/${keyId}`,
        {
          key: ctx.workingKey,
          ...(change === "revoke"
            ? {}
            : {
                body: {
                  type_permissions:
                    change === "widen"
                      ? { "core.note": "read", "core.task": "read" }
                      : { "core.note": "read" },
                },
              }),
        },
      );
      expect(changed.status).toBe(200);
      const result = await readSse(
        res,
        change === "revoke"
          ? { untilClosed: true }
          : { until: (text) => text.includes("event: stream_live") },
      );
      const text = opening + result.text;
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) =>
        BigInt(match[1]!),
      );
      if (change === "widen") {
        expect(text).toContain(candidate);
        expect(ids.filter((seen) => seen === id)).toHaveLength(1);
        expect(text.indexOf(candidate)).toBeLessThan(
          text.indexOf("event: stream_live"),
        );
      } else {
        expect(text).not.toContain(candidate);
        expect(ids).not.toContain(id);
      }
      if (path === "replay") expect(text).toContain("paced-anchor");
      if (change === "revoke") {
        expect(result.closed).toBe(true);
        expect(text).toContain('"reason":"credential_ended"');
        expect(text).not.toContain("event: stream_live");
      } else {
        expect(text.slice(text.indexOf("event: stream_live"))).toContain(
          `"cursor":"${String(id)}"`,
        );
      }
    } finally {
      release();
      observed.notify = (): void => undefined;
      ctx.storage.eventLog.getMaxId = originalHead;
      abort.abort();
      __resetEventLogForTests();
      await ctx.cleanup();
    }
  },
);
