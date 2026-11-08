import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { parseSse } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * A reader that takes nothing for a ping interval is closed, and the server
 * holds nothing for it in the meantime.
 *
 * The subscriber here is a raw socket that stops reading as soon as its
 * request is sent, which is what a sleeping laptop or a stuck proxy looks
 * like to the server: nothing a client library could buffer on its behalf
 * sits between the two. Enough is written to fill whatever the operating
 * system's socket buffers hold, the socket is left unread for longer than a
 * ping interval, and only then is it read.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "stream-stalled-reader",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Written while the socket is not read: more than the socket buffers hold. */
const WRITTEN = 16 * 1024 * 1024;
/** The ping interval `events.md` states, and room beyond it. */
const PING_MS = 30_000;
const BODY = "x".repeat(90_000);

/** Open `GET /events` on a socket of its own and stop reading at once. */
async function stalledSubscriber(): Promise<{
  socket: Socket;
  readAll: () => Promise<string>;
}> {
  const url = new URL(apiUrl);
  const tls = url.protocol === "https:";
  const port = Number(url.port || (tls ? 443 : 80));
  const socket: Socket = tls
    ? connectTls({ host: url.hostname, port, servername: url.hostname })
    : connect({ host: url.hostname, port });
  await new Promise<void>((resolve, reject) => {
    socket.once(tls ? "secureConnect" : "connect", () => resolve());
    socket.once("error", reject);
  });
  const chunks: Buffer[] = [];
  let ended: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    // The response ends with its last chunk; the connection may stay open.
    if (chunk.subarray(-5).toString("latin1") === "0\r\n\r\n") ended?.();
  });
  socket.pause();
  socket.write(
    `GET ${url.pathname.replace(/\/$/, "")}/events HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      `Authorization: Bearer ${apiKey}\r\n` +
      "Accept: text/event-stream\r\n\r\n",
  );
  const readAll = (): Promise<string> =>
    new Promise((resolve, reject) => {
      ended = () => {
        resolve(dechunk(Buffer.concat(chunks)));
      };
      socket.once("end", ended);
      socket.once("error", reject);
      socket.resume();
    });
  return { socket, readAll };
}

/** The body of an HTTP/1.1 response, chunked or not. */
function dechunk(raw: Buffer): string {
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, split).toString("latin1");
  let body = raw.subarray(split + 4);
  if (!/transfer-encoding:\s*chunked/i.test(head)) return body.toString("utf8");
  const parts: Buffer[] = [];
  for (;;) {
    const lineEnd = body.indexOf("\r\n");
    if (lineEnd < 0) break;
    const size = parseInt(body.subarray(0, lineEnd).toString("latin1"), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    body = body.subarray(lineEnd + 2 + size + 2);
  }
  return Buffer.concat(parts).toString("utf8");
}

describe("a reader that stops reading", () => {
  it("is closed once it has taken nothing for a ping interval, and resumes from the last id it took", async ({
    signal,
  }) => {
    const { socket, readAll } = await stalledSubscriber();
    try {
      // The subscription settles before the writes it has to fall behind on.
      await new Promise((r) => setTimeout(r, 300));
      const writtenIds: string[] = [];
      let last = "";
      for (let written = 0; written < WRITTEN; written += 10 * BODY.length) {
        const r = await client.bulkItems(
          Array.from({ length: 10 }, (_, i) =>
            createNote({
              source: ctx.source,
              properties: { body: `${String(written)}-${String(i)}${BODY}` },
            }),
          ),
        );
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
        for (const result of r.data.results) {
          if (result.id) {
            trackItem(ctx, result.id);
            writtenIds.push(result.id);
            last = result.id;
          }
        }
      }

      // The reader takes nothing for longer than a ping interval.
      await new Promise((r) => setTimeout(r, PING_MS + 5_000));

      // Reading now reaches the end of the stream: the server closed it, and
      // would otherwise hold it open for good.
      const text = await readAll();
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]!);
      // The witness: the stream delivered before the reader stopped.
      expect(ids.length).toBeGreaterThan(0);
      const lastId = ids.at(-1)!;
      // What the server held for the reader stayed bounded: everything
      // written did not reach it.
      expect(text).not.toContain(last);

      // Every write the reader did not receive is in the log behind that
      // cursor, and a resume from it sends each one, in order, and nothing at
      // or below the cursor.
      const itemOf = (e: { data: unknown }): string | undefined =>
        (e.data as { item?: { id?: string } }).item?.id;
      const received = new Set(
        parseSse(text)
          .filter((e) => e.event === "item.created")
          .map(itemOf),
      );
      const unsent = writtenIds.filter((id) => !received.has(id));
      // Both halves of the premise: the reader got some of what was written
      // and missed the rest.
      expect(unsent.length).toBeGreaterThan(0);
      expect(unsent.length).toBeLessThan(writtenIds.length);
      expect(unsent).toEqual(
        writtenIds.slice(writtenIds.length - unsent.length),
      );

      const resumed = await withStream(
        apiUrl,
        apiKey,
        { lastEventId: lastId },
        async (stream) => {
          const { events } = await collectUntil(
            stream,
            (evts) => evts.some((e) => itemOf(e) === last),
            `the last write ${last} on a resume from the cursor`,
            signal,
          );
          return events;
        },
      );
      const mine = new Set(writtenIds);
      const delivered = resumed
        .filter((e) => e.event === "item.created")
        .map(itemOf)
        .filter((id): id is string => id !== undefined && mine.has(id));
      expect(delivered).toEqual(unsent);
      const cursor = BigInt(lastId);
      for (const e of resumed.filter((frame) => frame.id !== undefined)) {
        expect(BigInt(e.id!) > cursor).toBe(true);
      }
    } finally {
      socket.destroy();
    }
  }, 180_000);
});
