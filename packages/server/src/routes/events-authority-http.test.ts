import { Server } from "node:http";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import type { Item } from "@withmarfa/shared";
import { createTestContext, readSse } from "../test-utils.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";

describe("held authority over real HTTP", () => {
  it.each(["head", "replay"] as const)(
    "delivers widened candidates exactly once in order behind the %s gate",
    async (mode) => {
      const ctx = await createTestContext();
      initEventLog(ctx.storage.eventLog);
      const server = serve({
        fetch: ctx.app.fetch,
        hostname: "127.0.0.1",
        port: 0,
      });
      if (!(server instanceof Server))
        throw new Error("expected the HTTP adapter");
      if (!server.listening)
        await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("server has no TCP address");
      const url = `http://127.0.0.1:${String(address.port)}`;
      const abort = new AbortController();
      const store = ctx.storage.eventLog;
      const realHead = store.getMaxId.bind(store);
      const realPage = store.getAfter.bind(store);
      let release!: () => void;
      let arrive!: () => void;
      const opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      let first = true;
      const wait = async () => {
        if (!first) return;
        first = false;
        arrive();
        await opened;
      };
      const call = (
        method: string,
        path: string,
        body?: unknown,
        key = ctx.workingKey,
      ) =>
        fetch(url + path, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      try {
        const minted = await fetch(url + "/keys", {
          method: "POST",
          headers: {
            cookie: ctx.owner.cookie,
            origin: new URL(ctx.config.authBaseUrl).origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            label: "HTTP event viewer",
            source: "http-event-viewer",
            type_permissions: { "core.note": "read" },
            edge_permissions: {},
            extension_permissions: {},
            metadata_permissions: {},
            profile_permissions: {},
            permissions: [],
          }),
        });
        expect(minted.status).toBe(201);
        const viewer = (await minted.json()) as { key: string; id: string };
        const cursor = (await realHead()) ?? 0n;
        if (mode === "head")
          store.getMaxId = async () => {
            await wait();
            return realHead();
          };
        else
          store.getAfter = async (after, limit) => {
            await wait();
            return realPage(after, limit);
          };
        const res = await fetch(url + "/events", {
          headers: {
            Authorization: `Bearer ${viewer.key}`,
            ...(mode === "replay" ? { "Last-Event-ID": String(cursor) } : {}),
          },
          signal: abort.signal,
        });
        expect(res.status).toBe(200);
        await reached;
        const task = await call("POST", "/items", {
          type: "core.task",
          properties: { title: "http-held-task" },
        });
        expect(task.status).toBe(201);
        const item = ((await task.json()) as { item: Item }).item;
        const taskId = await realHead();
        const patched = await call("PATCH", `/keys/${viewer.id}`, {
          type_permissions: { "core.note": "read", "core.task": "read" },
        });
        expect(patched.status).toBe(200);
        const note = await call("POST", "/items", {
          type: "core.note",
          properties: { body: "http-held-note" },
        });
        expect(note.status).toBe(201);
        const anchor = ((await note.json()) as { item: Item }).item;
        const noteId = await realHead();
        release();
        const { text } = await readSse(res, {
          until: (seen) => seen.includes("event: stream_live"),
        });
        const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) =>
          BigInt(match[1]!),
        );
        expect(ids).toEqual([taskId, noteId]);
        const liveAt = text.indexOf("event: stream_live");
        expect(text.indexOf(item.id)).toBeLessThan(text.indexOf(anchor.id));
        expect(text.indexOf(anchor.id)).toBeLessThan(liveAt);
        expect(text.slice(liveAt)).toContain(`"cursor":"${String(noteId)}"`);
      } finally {
        release();
        store.getMaxId = realHead;
        store.getAfter = realPage;
        abort.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          }),
        );
        __resetEventLogForTests();
        await ctx.cleanup();
      }
    },
  );
});
