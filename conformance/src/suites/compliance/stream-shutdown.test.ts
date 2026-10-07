import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * An instance that is stopped ends the streams it has open with their
 * closing frame, and stops within the grace a container runtime gives it:
 * the instance chapter's `instance/stop-*` rules, and `events.md` 11.
 */

let server: FreshServer;
/** A second server, because stopping one is the test and it stays stopped. */
let served: FreshServer;
/** A third, for the copy stream. */
let copied: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("stream-shutdown");
  served = await bootFreshServer("stream-shutdown-sent");
  copied = await bootFreshServer("stream-shutdown-copy");
}, 3 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([server.stop(), served.stop(), copied.stop()]);
}, 3 * FRESH_SERVER_TIMEOUT_MS);

/** The grace a container runtime gives a stopped process, by default. */
const GRACE_MS = 10_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("stopping the instance with an event stream open", () => {
  it(
    "ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds",
    async () => {
      const state = dirname(server.sqlitePath);
      const group = Number(
        readFileSync(join(state, "server.pid"), "utf8").trim(),
      );
      const response = await fetch(`${server.apiUrl}/events`, {
        headers: { Authorization: `Bearer ${server.workingKey}` },
      });
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("event: stream_live")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        text += decoder.decode(chunk.value, { stream: true });
      }

      const stoppedAt = Date.now();
      process.kill(-group, "SIGTERM");
      let closed = false;
      while (!closed) {
        const chunk = await reader.read();
        if (chunk.done) closed = true;
        else text += decoder.decode(chunk.value, { stream: true });
      }

      expect(text).toContain("event: stream_incomplete");
      const frame = /event: stream_incomplete\ndata: (.*)\n/.exec(text)?.[1];
      expect(JSON.parse(frame ?? "{}")).toMatchObject({
        event_type: "stream_incomplete",
        reason: "server_stopping",
        // Nothing was sent on this stream, so there is no event to name.
        cursor: null,
      });
      expect(text).not.toMatch(/id: [^\n]*\nevent: stream_incomplete/);
      while (alive(group) && Date.now() - stoppedAt < GRACE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(alive(group)).toBe(false);
      expect(Date.now() - stoppedAt).toBeLessThan(GRACE_MS - 2_000);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names the last event the stream sent as the cursor of its closing frame",
    async () => {
      const group = Number(
        readFileSync(
          join(dirname(served.sqlitePath), "server.pid"),
          "utf8",
        ).trim(),
      );
      const response = await fetch(`${served.apiUrl}/events`, {
        headers: { Authorization: `Bearer ${served.workingKey}` },
      });
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      const readUntil = async (marker: string): Promise<void> => {
        while (!text.includes(marker)) {
          const chunk = await reader.read();
          expect(chunk.done, `the stream ended before ${marker}`).toBe(false);
          text += decoder.decode(chunk.value, { stream: true });
        }
      };
      await readUntil("event: stream_live");

      // Two events, so the cursor that closes the stream is the second's and
      // not the first's or the position the stream was opened at.
      const writer = new MarfaClient({
        baseUrl: served.apiUrl,
        apiKey: served.workingKey,
      });
      for (const body of ["first", "second"]) {
        const created = await writer.createItem({
          type: "core.note",
          properties: { body },
        });
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        await readUntil(created.data.item.id);
      }
      const sent = [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
      expect(sent.length, "the stream sent no event with an id").toBe(2);

      process.kill(-group, "SIGTERM");
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }

      const frame = /event: stream_incomplete\ndata: (.*)\n/.exec(text)?.[1];
      expect(JSON.parse(frame ?? "{}")).toMatchObject({
        event_type: "stream_incomplete",
        reason: "server_stopping",
        cursor: sent[1],
      });
      expect(sent[1]).not.toBe(sent[0]);
      expect(text).not.toMatch(/id: [^\n]*\nevent: stream_incomplete/);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "ends an open copy stream with stream_incomplete when the server is stopped, and exits with status 0",
    async () => {
      const response = await fetch(`${copied.apiUrl}/events?edges=all&copy=1`, {
        headers: { Authorization: `Bearer ${copied.workingKey}` },
      });
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      // The stream was live, so the stop had something to end.
      while (!text.includes("event: stream_live")) {
        const chunk = await reader.read();
        expect(chunk.done, "the copy stream ended before it was live").toBe(
          false,
        );
        text += decoder.decode(chunk.value, { stream: true });
      }

      copied.signal("SIGTERM");
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }

      const frame = /event: stream_incomplete\ndata: (.*)\n/.exec(text)?.[1];
      expect(JSON.parse(frame ?? "{}")).toMatchObject({
        event_type: "stream_incomplete",
        reason: "server_stopping",
        cursor: null,
      });
      expect(text).not.toMatch(/id: [^\n]*\nevent: stream_incomplete/);
      expect(await copied.exit()).toMatchObject({ code: 0, signal: null });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
