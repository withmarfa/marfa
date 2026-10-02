import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { createNote } from "../../generators/items.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * A webhook reaches only public addresses unless the operator allows private
 * ones. The run's own server allows them, because every other webhook
 * fixture delivers to a receiver on loopback, so this file boots a server
 * with the setting at its default.
 */
let server: FreshServer | undefined;
let working: MarfaClient;
let receiver: Receiver;

beforeAll(async () => {
  server = await bootFreshServer("webhook-addresses", {
    MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES: "false",
  });
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  receiver = await startReceiver();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver.close();
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("webhook addresses", () => {
  it("refuses a subscription naming a loopback, private or link-local address", async () => {
    const port = new URL(receiver.url).port;
    for (const url of [
      receiver.url,
      `http://[::1]:${port}/hook`,
      `http://[::ffff:127.0.0.1]:${port}/hook`,
      "http://10.0.0.1/hook",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      const refused = await working.createWebhook({
        url,
        events: ["item.created"],
      });
      expect(refused.status, url).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
  });

  it("sends nothing to a name that resolves to loopback, and records why", async () => {
    const port = new URL(receiver.url).port;
    const created = await working.createWebhook({
      url: `http://localhost:${port}/hook/by-name`,
      events: ["item.created"],
    });
    expect(created.status).toBe(201);

    const note = await working.createItem(
      createNote({ properties: { body: "to a name on loopback" } }),
    );
    expect(note.ok).toBe(true);

    // The attempt is recorded, which is what says the event was dispatched.
    const deadline = Date.now() + 30_000;
    let error: string | null = null;
    while (Date.now() < deadline && error === null) {
      const log = await working.listWebhookDeliveries(created.data.id);
      expect(log.ok).toBe(true);
      error = log.data.data[0]?.error ?? null;
      if (error === null) await new Promise((r) => setTimeout(r, 100));
    }
    expect(error).toBe("The receiver's address is not public.");
    expect(receiver.received).toHaveLength(0);
  });
});
