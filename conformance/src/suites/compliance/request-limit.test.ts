import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/** Below the 1 MiB default, so the root's answer can only be this setting. */
const REQUEST_CAP_BYTES = 200_000;

const DEFAULT_CAP_BYTES = 1_048_576;
const RAISED_CAP_BYTES = 4 * DEFAULT_CAP_BYTES;

let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("request-limit", {
    MARFA_MAX_REQUEST_BYTES: String(REQUEST_CAP_BYTES),
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function named(): Promise<number> {
  const root = await fetch(`${server!.apiUrl}/`, {
    headers: { accept: "application/json" },
  });
  expect(root.status).toBe(200);
  return ((await root.json()) as { max_request_bytes: number })
    .max_request_bytes;
}

/** Sends a body of more than `bytes`, which only the cap can refuse first. */
function sendPast(bytes: number): Promise<Response> {
  return fetch(`${server!.apiUrl}/items`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server!.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ padding: "x".repeat(bytes) }),
  });
}

describe("the request cap at the root", () => {
  it("names at the root a lowered request cap and refuses a body past it", async () => {
    expect(await named()).toBe(REQUEST_CAP_BYTES);
    expect((await sendPast(REQUEST_CAP_BYTES)).status).toBe(413);
  });

  it(
    "names at the root a raised request cap and reads a body past the default",
    async () => {
      await server!.restart({
        env: { MARFA_MAX_REQUEST_BYTES: String(RAISED_CAP_BYTES) },
      });
      expect(await named()).toBe(RAISED_CAP_BYTES);
      // Read whole and judged on its fields: no longer refused for its size.
      const read = await sendPast(DEFAULT_CAP_BYTES);
      expect(read.status).not.toBe(413);
      expect(read.status).toBeLessThan(500);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
