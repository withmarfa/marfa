import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { WebhookDelivery } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * Which address a delivery connects to when the receiver is named, not
 * numbered.
 *
 * The target answers a name lookup as the case scripts it, with the fault
 * `resolve:<hostname>=<answers>`: one answer for each lookup of that name,
 * the last repeating, and `<checked>><connected>` for an address that the
 * check judges and the socket reaches elsewhere. The first answer is a public
 * address reached on loopback and the second is one nothing listens on, so a
 * target that resolves again after its check connects to the second and
 * misses the receiver, and its fault shows more than one lookup.
 */
const PUBLIC_ADDRESS = "93.184.216.34";

let server: FreshServer;
let receiver: Receiver;

beforeAll(async () => {
  server = await bootFreshServer("webhook-resolution");
  receiver = await startReceiver();
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function owner(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}

/** A subscription whose URL names `host` and the receiver's port. */
async function subscribe(host: string, label: string): Promise<string> {
  const port = new URL(receiver.url).port;
  const created = await owner().createWebhook({
    url: `http://${host}:${port}/hook/${label}`,
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.id;
}

async function write(body: string): Promise<void> {
  const note = await owner().createItem({
    type: "core.note",
    properties: { body },
  });
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
}

async function deliveryAt(
  webhookId: string,
  attempt: number,
): Promise<WebhookDelivery> {
  return waitFor(
    `attempt ${String(attempt)} of ${webhookId} to be recorded`,
    async () => {
      const rows = await owner().listWebhookDeliveries(webhookId);
      expect(rows.ok).toBe(true);
      const row = rows.data.data[0];
      return row !== undefined && row.attempt >= attempt ? row : undefined;
    },
    60_000,
  );
}

describe("webhook address resolution", () => {
  it("reaches the receiver by a name the target resolves to loopback, where private addresses are allowed", async () => {
    // The witness for the case below: this name does reach the receiver.
    await server.setFault("resolve:moved.test=127.0.0.1");
    const id = await subscribe("moved.test", "witness");
    try {
      await write("witness");
      await receiver.waitFor((r) => r.path === "/hook/witness");
    } finally {
      await owner().deleteWebhook(id);
      await server.clearFault();
    }
  });

  it("connects to the address it checked and does not resolve the name again", async () => {
    // The target boots again with private addresses refused, as a production
    // instance runs, and stays so until the file ends.
    await server.restart({
      env: { MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES: "false" },
    });
    // The first lookup answers a public address that the socket reaches on
    // loopback, where the receiver listens, so no packet leaves the machine.
    // A second lookup answers ::1, where nothing listens: a target that
    // resolves again after its check connects there and misses the receiver.
    await server.setFault(
      `resolve:rebind.test=${PUBLIC_ADDRESS}>127.0.0.1;::1`,
    );
    const id = await subscribe("rebind.test", "rebind");
    try {
      await write("rebind");
      await receiver.waitFor((r) => r.path === "/hook/rebind");
      const sent = await deliveryAt(id, 1);
      expect(sent.status).toBe("success");
      expect(
        receiver.received.filter((r) => r.path === "/hook/rebind"),
        "one attempt, one delivery",
      ).toHaveLength(1);
      const lookups = (await server.faults()).find(
        (fault) => fault.name === "resolve:rebind.test",
      );
      expect(lookups?.fired, "the name was resolved once for the attempt").toBe(
        1,
      );
    } finally {
      await owner().deleteWebhook(id);
      await server.clearFault();
    }
  }, 120_000);
});
