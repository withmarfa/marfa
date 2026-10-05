import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * An instance that is stopped ends the streams it has open with their
 * closing frame, and stops within the grace a container runtime gives it:
 * `instance.md` 17 and 18, and `events.md` 11.
 */

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("stream-shutdown");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

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
});
