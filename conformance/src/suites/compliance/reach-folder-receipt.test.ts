import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * A folder write answers without a reach certificate (`reach/receipt-uncertified`).
 * It lives apart from `reach.test.ts` because the folder door is not served
 * by every target yet, and a target that does not serve it is judged on the
 * rest of the reach contract without it.
 */

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("reach-folder-receipt");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

it("returns a folder write receipt without a reach certificate", async ({
  signal,
}) => {
  const reach = await withStream(
    server.apiUrl,
    server.workingKey,
    {
      query: [
        ["edges", "all"],
        ["copy", "1"],
      ],
    },
    async (stream) => {
      const { events } = await collectUntil(
        stream,
        (seen) => seen.some((event) => event.event === "stream_live"),
        "the copy stream live",
        signal,
      );
      return (
        events.find((event) => event.event === "stream_live")!.data as {
          reach: string;
        }
      ).reach;
    },
  );

  const folder = await fetch(`${server.apiUrl}/folders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.workingKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Reach receipt" }),
  });
  expect(folder.status).toBe(201);
  expect(folder.headers.get("X-Marfa-Reach")).toBeNull();
  const body = (await folder.json()) as { item: { id: string } };
  expect(body).not.toHaveProperty("reach");

  // The witness: the same credential's conditional read does carry the reach.
  const read = await fetch(`${server.apiUrl}/items/${body.item.id}`, {
    headers: {
      Authorization: `Bearer ${server.workingKey}`,
      "X-Marfa-Reach": reach,
    },
  });
  expect(read.status).toBe(200);
  expect(read.headers.get("X-Marfa-Reach")).toBe(reach);
});
