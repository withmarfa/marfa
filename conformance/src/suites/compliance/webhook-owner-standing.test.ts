import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * A subscription belongs to the credential that registered it, so it ends
 * with that credential: a key that reaches its `expires_at`, an app whose
 * grant is revoked.
 *
 * A server of its own. A key's expiry is set only in the stored database, and
 * an app's grant needs the instance's one owner, who is created here.
 */
let server: FreshServer | undefined;
let receiver: Receiver;
/** Paths of the receiver that answer a delivery with a failure to retry. */
const failing = new Set<string>();

beforeAll(async () => {
  server = await bootFreshServer("webhook-owner-standing");
  receiver = await startReceiver({
    status: (received) => (failing.has(received.path) ? 503 : 200),
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function client(key: string): MarfaClient {
  return new MarfaClient({ baseUrl: server!.apiUrl, apiKey: key });
}

async function note(body: string): Promise<string> {
  const created = await client(server!.workingKey).createItem({
    type: "core.note",
    properties: { body },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

/** A subscription of `owner` to `item.created`, posting to a path of the
 *  receiver. */
async function subscribe(owner: MarfaClient, label: string): Promise<string> {
  const created = await owner.createWebhook({
    url: receiver.hookUrl(label),
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.id;
}

/** Runs a job, again while the server's own run holds its name. */
async function run(name: string): Promise<void> {
  await waitFor(
    `${name} to run`,
    async () => {
      const ran = await client(server!.operatorKey).runHousekeeping(name);
      if (ran.status === 409) return undefined;
      expect(ran.status, JSON.stringify(ran.error)).toBe(200);
      expect(ran.data.outcome, ran.data.error ?? "").toBe("ok");
      return true;
    },
    30_000,
  );
}

const sentTo = (label: string) =>
  receiver.received.filter((r) => r.path === `/hook/${label}`);

describe("a subscription whose credential stops standing", () => {
  it("delivers nothing more once the key that registered the subscription expires", async () => {
    const minted = await client(server!.workingKey).createKey({
      label: "expiring-owner",
      source: "webhook-owner-standing-expiring",
      permissions: ["webhooks.manage"],
      type_permissions: { "*": "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    // Asked of the server's address as it stands, which a restart changes.
    const owner = () => client(minted.data.key);

    // The key holds an expiry a long way off while it registers and is
    // delivered to, so what it stops doing later is what its expiry did.
    await server!.restart({
      whileStopped: () => {
        withInstanceDatabase(server!.sqlitePath, (db) => {
          db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(
            new Date(Date.now() + 600_000).toISOString(),
            minted.data.id,
          );
        });
      },
    });
    await subscribe(owner(), "expiry-live");
    const retrying = await subscribe(owner(), "expiry-retrying");
    // The sentinel: a subscription of a key that does not expire, which
    // says an event was dispatched.
    await subscribe(client(server!.workingKey), "expiry-sentinel");

    const before = await note("expiry-before");
    await receiver.waitFor(
      (r) => r.path === "/hook/expiry-live" && r.body.includes(before),
    );
    // A delivery of the expiring key that is waiting on a retry when the key
    // expires: the receiver fails it until the file says otherwise.
    failing.add("/hook/expiry-retrying");
    const waiting = await note("expiry-waiting");
    const pending = await waitFor("the retry to be waiting", async () => {
      const rows = await owner().listWebhookDeliveries(retrying);
      return rows.data.data.find(
        (row) =>
          row.status === "pending" &&
          row.attempt >= 1 &&
          sentTo("expiry-retrying").some((r) => r.body.includes(waiting)),
      );
    });
    failing.delete("/hook/expiry-retrying");

    await server!.restart({
      whileStopped: () => {
        withInstanceDatabase(server!.sqlitePath, (db) => {
          db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(
            new Date(Date.now() + 3000).toISOString(),
            minted.data.id,
          );
        });
      },
    });
    await waitFor("the key to pass its expiry", async () =>
      (await owner().getCurrentKey()).status === 401 ? true : undefined,
    );
    const sentBefore = sentTo("expiry-retrying").length;

    const after = await note("expiry-after");
    await receiver.waitFor(
      (r) => r.path === "/hook/expiry-sentinel" && r.body.includes(after),
    );
    await run("webhook-poll");
    await run("webhook-poll");

    expect(
      sentTo("expiry-live").some((r) => r.body.includes(after)),
      "an event written after the key expired was delivered to its subscription",
    ).toBe(false);
    expect(
      sentTo("expiry-retrying").length,
      "a pending delivery of the expired key was attempted",
    ).toBe(sentBefore);
    const stored = withInstanceDatabase(server!.sqlitePath, (db) =>
      db
        .prepare("SELECT status FROM outbound_webhook_deliveries WHERE id = ?")
        .get(pending.id),
    ) as { status: string };
    expect(stored.status).not.toBe("success");
  });

  it("deletes an app's subscriptions when its grant is revoked", async () => {
    const app = await approvedApp(server!, [
      "core.note:read",
      "webhooks.manage",
    ]);
    const appClient = client(app.token);
    const id = await subscribe(appClient, "grant-app");
    const subscriptionsOf = (clientId: string): number =>
      (
        withInstanceDatabase(server!.sqlitePath, (db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM outbound_webhooks WHERE grant_client_id = ?",
            )
            .get(clientId),
        ) as { n: number }
      ).n;

    // The witness: the subscription is the grant's, it is listed to the app,
    // and it delivers while the grant stands.
    expect(subscriptionsOf(app.clientId)).toBe(1);
    expect((await appClient.listWebhooks()).data.data.map((w) => w.id)).toEqual(
      [id],
    );
    const before = await note("grant-before");
    await receiver.waitFor(
      (r) => r.path === "/hook/grant-app" && r.body.includes(before),
    );

    const operator = client(server!.workingKey);
    const grants = await operator.rawRequest<{ data: { id: string }[] }>(
      "/auth/grants",
    );
    expect(grants.status).toBe(200);
    expect(grants.data.data).toHaveLength(1);
    const revoked = await operator.rawRequest(
      `/auth/grants/${grants.data.data[0]!.id}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(204);

    expect(subscriptionsOf(app.clientId)).toBe(0);
    await subscribe(operator, "grant-sentinel");
    const after = await note("grant-after");
    await receiver.waitFor(
      (r) => r.path === "/hook/grant-sentinel" && r.body.includes(after),
    );
    expect(
      sentTo("grant-app").some((r) => r.body.includes(after)),
      "an event written after the grant was revoked was delivered to its subscription",
    ).toBe(false);
  });
});
