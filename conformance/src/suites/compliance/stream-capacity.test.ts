import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { openEventStream } from "../../utils/sse.js";

/**
 * An instance that caps its live viewers refuses the one past the cap.
 *
 * A server of its own, because the cap is a setting the run's server leaves
 * off: with it on there, every file that opens a stream would meet it.
 * The cap is one, so the file holds one stream open and asks for the second.
 */
let server: FreshServer | undefined;

const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "1"],
];

beforeAll(async () => {
  server = await bootFreshServer("stream-capacity", {
    MARFA_SSE_MAX_VIEWERS: "1",
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function refusedStream(
  query: Array<[string, string]>,
): Promise<{ response: Response; body: unknown }> {
  const stream = await openEventStream(server!.apiUrl, server!.workingKey, {
    query,
    connectTimeoutMs: 30_000,
  });
  const body: unknown = await stream.response.json();
  await stream.close();
  return { response: stream.response, body };
}

describe("GET /events on an instance that caps its live viewers", () => {
  it("answers 503 stream_capacity_exhausted to the viewer past the cap, on either stream, and admits one again once a viewer leaves", async () => {
    const first = await openEventStream(server!.apiUrl, server!.workingKey, {
      connectTimeoutMs: 30_000,
    });
    try {
      expect(first.response.status).toBe(200);
      expect(first.response.headers.get("Content-Type")).toContain(
        "text/event-stream",
      );

      for (const query of [[], COPY_QUERY]) {
        const { response, body } = await refusedStream(query);
        expect(response.status).toBe(503);
        expect(response.headers.get("X-Error-Code")).toBe(
          "stream_capacity_exhausted",
        );
        expect(body).toMatchObject({
          error: {
            code: "stream_capacity_exhausted",
            details: { reason: "viewer_cap" },
          },
        });
      }
    } finally {
      await first.close();
    }

    // The witness: the refusal was the cap and not the credential or the
    // door, because the same request is admitted when the viewer has left.
    // The slot frees when the server sees the connection close, so ask until
    // it does.
    let admitted: Awaited<ReturnType<typeof openEventStream>> | undefined;
    for (let attempt = 0; attempt < 100 && admitted === undefined; attempt++) {
      const stream = await openEventStream(server!.apiUrl, server!.workingKey, {
        connectTimeoutMs: 30_000,
      });
      if (stream.response.status === 200) admitted = stream;
      else {
        await stream.close();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(admitted?.response.status).toBe(200);
    await admitted?.close();
  });
});
