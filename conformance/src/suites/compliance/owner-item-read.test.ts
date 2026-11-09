import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";

let server: FreshServer;
beforeAll(async () => {
  server = await bootFreshServer("owner-item-read");
  const result = await fetch(`${server.apiUrl}/items`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "core.note", properties: { body: "kept" } }),
  });
  expect(result.status).toBe(201);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

it("keeps counts and exports closed to the private local command, which a credential reads", async () => {
  for (const path of ["/items/stats", "/export"]) {
    const witness = await fetch(`${server.apiUrl}${path}`, {
      headers: { authorization: `Bearer ${server.workingKey}` },
    });
    expect(witness.status, path).toBe(200);
    await witness.arrayBuffer();
    expect((await controlRequest(server.controlSocket, path)).status).toBe(401);
  }
});
