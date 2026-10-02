import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * A reader that stops reading is ended, not buffered for.
 *
 * The subscriber here is a raw socket that stops reading as soon as its
 * request is sent, which is what a sleeping laptop or a stuck proxy looks
 * like to the server: nothing a client library could buffer on its behalf
 * sits between the two. Several times the stated bound is then written,
 * enough to pass it and whatever the operating system's socket buffers
 * hold, and only then is the socket read.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "stream-reader-behind",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** The bound `events.md` states, in bytes. */
const BOUND = 4 * 1024 * 1024;
/** Written while the socket is not read: the bound, and room for buffers. */
const WRITTEN = 4 * BOUND;
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
  it("is ended with reader_behind once it falls past the bound, and resumes from its cursor", async ({
    signal,
  }) => {
    const { socket, readAll } = await stalledSubscriber();
    try {
      // The subscription settles before the writes it has to fall behind on.
      await new Promise((r) => setTimeout(r, 300));
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
            last = result.id;
          }
        }
      }

      const text = await readAll();
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]!);
      // The witness: the stream delivered before it fell behind.
      expect(ids.length).toBeGreaterThan(0);
      const terminal = text.slice(text.indexOf("event: stream_incomplete"));
      expect(terminal.startsWith("event: stream_incomplete")).toBe(true);
      const data = JSON.parse(/^data: (.*)$/m.exec(terminal)?.[1] ?? "{}") as {
        reason?: string;
        cursor?: string | null;
      };
      expect(data.reason).toBe("reader_behind");
      expect(data.cursor).toBe(ids.at(-1));
      expect(terminal).not.toMatch(/^id:/m);
      // What the server held for the reader stayed bounded: everything
      // written did not reach it.
      expect(text).not.toContain(last);

      // Everything unsent is in the log behind that cursor.
      await withStream(
        apiUrl,
        apiKey,
        { lastEventId: data.cursor! },
        async (stream) => {
          await collectUntil(
            stream,
            (evts) =>
              evts.some(
                (e) => (e.data as { item?: { id?: string } }).item?.id === last,
              ),
            `the last write ${last} on a resume from the cursor`,
            signal,
          );
        },
      );
    } finally {
      socket.destroy();
    }
  });
});
