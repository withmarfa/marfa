import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { WebhookDelivery } from "../../client/types.js";
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
 *
 * A name is checked twice: when the subscription is registered, so the
 * person is told then, and at every attempt, since a name can come to
 * resolve elsewhere. The second can only be reached here by registering
 * the subscription under a server that allows private addresses and then
 * starting the same data again under one that does not.
 */
const SETTING = "MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES";
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
      expect(refused.error?.error.message, url).toContain(SETTING);
    }
  });

  it("refuses a subscription naming a unique-local, carrier-grade NAT, unspecified or multicast address", async () => {
    for (const url of [
      "http://[fc00::1]/hook",
      "http://[fd12:3456:789a::1]/hook",
      "http://100.64.0.1/hook",
      "http://0.0.0.0/hook",
      "http://[::]/hook",
      "http://224.0.0.1/hook",
    ]) {
      const refused = await working.createWebhook({
        url,
        events: ["item.created"],
      });
      expect(refused.status, url).toBe(400);
      expect(refused.error?.error.code, url).toBe("validation_error");
    }
  });

  it("refuses a subscription whose host name resolves to an address that is not public, naming the setting", async () => {
    const port = new URL(receiver.url).port;
    for (const url of [
      `http://localhost:${port}/hook`,
      `https://localhost:${port}/hook`,
    ]) {
      const refused = await working.createWebhook({
        url,
        events: ["item.created"],
      });
      expect(refused.status, url).toBe(400);
      expect(refused.error?.error.code, url).toBe("validation_error");
      expect(refused.error?.error.message, url).toContain(SETTING);
    }
    expect((await working.listWebhooks()).data.data).toEqual([]);
  });

  it("accepts a name that does not resolve, which delivery looks up again", async () => {
    // The witness for the refusals above: the same door takes a name that
    // answers nothing.
    const created = await working.createWebhook({
      url: "http://receiver.invalid/hook/unresolved",
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    await working.deleteWebhook(created.data.id);
  });

  it("refuses an IPv6 address outside 2000::/3 and the documentation block, and accepts a global one", async () => {
    for (const url of [
      "http://[::10.0.0.1]/hook",
      "http://[::a00:1]/hook",
      "http://[fc00::1]/hook",
      "http://[fe80::1]/hook",
      "http://[ff02::1]/hook",
      "http://[2001:db8::1]/hook",
      "http://[4000::1]/hook",
    ]) {
      const refused = await working.createWebhook({
        url,
        events: ["item.created"],
      });
      expect(refused.status, url).toBe(400);
      expect(refused.error?.error.code, url).toBe("validation_error");
    }
    // The witness: a global address is accepted on the same door.
    const accepted = await working.createWebhook({
      url: "http://[2606:4700:4700::1111]/hook",
      events: ["item.created"],
    });
    expect(accepted.status).toBe(201);
    await working.deleteWebhook(accepted.data.id);
  });

  it("refuses to point a subscription at an address that is not public, leaving the stored url", async () => {
    // A name that does not resolve is accepted and never reached.
    const stored = "http://receiver.invalid/hook/stored";
    const created = await working.createWebhook({
      url: stored,
      events: ["item.deleted"],
    });
    expect(created.status).toBe(201);
    try {
      for (const url of [
        receiver.url,
        "http://10.0.0.1/hook",
        "http://[::ffff:127.0.0.1]/hook",
        `http://localhost:${new URL(receiver.url).port}/hook`,
      ]) {
        const refused = await working.updateWebhook(created.data.id, { url });
        expect(refused.status, url).toBe(400);
        expect(refused.error?.error.code, url).toBe("validation_error");
        expect((await working.getWebhook(created.data.id)).data.url).toBe(
          stored,
        );
      }
      // The witness: the same door accepts a name that does not resolve.
      const accepted = await working.updateWebhook(created.data.id, {
        url: "http://receiver.invalid/hook/moved",
      });
      expect(accepted.status).toBe(200);
    } finally {
      await working.deleteWebhook(created.data.id);
    }
  });

  it(
    "sends nothing to a name that resolves to loopback, records why, and gives up at once",
    async () => {
      const port = new URL(receiver.url).port;
      // Registered under a server that allows it, as a name that resolved
      // elsewhere would have been, and then met by one that does not.
      await server!.restart({ env: { [SETTING]: "true" } });
      working = new MarfaClient({
        baseUrl: server!.apiUrl,
        apiKey: server!.workingKey,
      });
      const created = await working.createWebhook({
        url: `http://localhost:${port}/hook/by-name`,
        events: ["item.created"],
      });
      expect(created.status).toBe(201);

      await server!.restart();
      working = new MarfaClient({
        baseUrl: server!.apiUrl,
        apiKey: server!.workingKey,
      });
      const note = await working.createItem(
        createNote({ properties: { body: "to a name on loopback" } }),
      );
      expect(note.ok).toBe(true);

      // A delivery is queued before it is attempted, and is settled once it
      // has been.
      const deadline = Date.now() + 30_000;
      let delivery: WebhookDelivery | undefined;
      while (Date.now() < deadline && delivery?.status !== "dead_letter") {
        const log = await working.listWebhookDeliveries(created.data.id);
        expect(log.ok).toBe(true);
        delivery = log.data.data[0];
        if (delivery?.status !== "dead_letter")
          await new Promise((r) => setTimeout(r, 100));
      }
      expect(delivery).toMatchObject({
        status: "dead_letter",
        error: "The receiver's address is not public.",
        attempt: 1,
      });
      expect(receiver.received).toHaveLength(0);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
