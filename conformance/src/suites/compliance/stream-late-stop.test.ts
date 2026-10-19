import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { tapStream } from "../../utils/stream-tap.js";

/**
 * An event stream that opens once the stop has begun is answered with the
 * same closing frame as one that was open when it began
 * (`instance/stop-ends-late-stream`).
 *
 * Each case holds a request at the door of the stream, stops the server with
 * `SIGTERM` while the request waits, and so lets the request through only
 * after the stop has begun: the server releases its faults as the stop
 * starts. A server of its own for each, because the stop ends it.
 */
let plain: FreshServer;
let copy: FreshServer;

beforeAll(async () => {
  plain = await bootFreshServer("stream-late-stop");
  copy = await bootFreshServer("stream-late-stop-copy");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([plain.stop(), copy.stop()]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Holds a request at the door of the stream, stops the server, and reads the answer. */
async function answerAfterStop(
  server: FreshServer,
  query: Array<[string, string]>,
): Promise<void> {
  await server.setFault("hold:stream-open");
  const opening = tapStream(server.apiUrl, server.workingKey, { query });
  // The request is at the door of the stream and has not been answered.
  await server.waitForHold("hold:stream-open");

  server.signal("SIGTERM");
  const tap = await opening;
  await tap.untilClosed();
  expect(tap.status).toBe(200);

  const frames = tap.events.filter(
    (event) => event.event === "stream_incomplete",
  );
  expect(frames).toHaveLength(1);
  expect(frames[0]!.data).toEqual({
    event_type: "stream_incomplete",
    reason: "server_stopping",
    cursor: null,
  });
  expect(frames[0]!.id).toBeUndefined();
  expect(
    tap.events.some((event) => event.event === "stream_live"),
    "a stream opened after the stop began went live",
  ).toBe(false);
  expect(await server.exit()).toMatchObject({ code: 0, signal: null });
  await tap.close();
}

describe("an event stream opened after the stop has begun", () => {
  it(
    "is answered with stream_incomplete and server_stopping, and closed",
    () => answerAfterStop(plain, []),
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is answered the same way when it is a copy stream",
    () =>
      answerAfterStop(copy, [
        ["edges", "all"],
        ["copy", "1"],
      ]),
    FRESH_SERVER_TIMEOUT_MS,
  );
});
