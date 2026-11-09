import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * The webhook sender woken by a write, after the key that made the write is
 * revoked (`instance/background-request-authority`). The subscription's own
 * key decides what is sent; the writer's standing does not.
 */
let server: FreshServer;
let receiver: Receiver;

beforeAll(async () => {
  server = await bootFreshServer("background-authority-webhooks");
  receiver = await startReceiver({ status: 200 });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function client(key: string): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: key });
}

describe("background work after the requesting key is revoked", () => {
  it("sends the delivery a write woke after the key that made the write is revoked", async () => {
    const admin = client(server.workingKey);
    const hook = await admin.createWebhook({
      url: receiver.hookUrl("woken"),
      events: ["item.created"],
    });
    expect(hook.status).toBe(201);
    const minted = await admin.createKey({
      label: "background-writer",
      source: "background-writer",
      type_permissions: { "core.note": "write" },
    });
    expect(minted.status).toBe(201);

    await server.setFault("hold:webhook-schedule");
    try {
      const created = await client(minted.data.key).createItem({
        type: "core.note",
        properties: { body: "woken by a key that is then revoked" },
      });
      expect(created.status).toBe(201);
      await server.waitForHold("hold:webhook-schedule");
      expect((await admin.revokeKey(minted.data.id)).ok).toBe(true);
      expect((await client(minted.data.key).getCurrentKey()).status).toBe(401);
      expect(receiver.received.filter((r) => r.path === "/hook/woken")).toEqual(
        [],
      );

      await server.clearFault("hold:webhook-schedule");
      const sent = await receiver.waitFor(
        (r) =>
          r.path === "/hook/woken" && r.body.includes(created.data.item.id),
      );
      expect(sent.body).toContain(created.data.item.id);
    } finally {
      await server.clearFault();
    }
  });
});
