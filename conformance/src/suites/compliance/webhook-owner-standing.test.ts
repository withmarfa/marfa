import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { HOUR_MS, movedClock } from "../../utils/moved-clock.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * A subscription belongs to the credential that registered it, so it ends
 * with that credential: a key that reaches its `expires_at`, an app whose
 * grant is revoked.
 *
 * A server of its own, because a key's expiry is reached by moving the
 * server's clock, and the case that needs an app's token, which also needs the
 * instance's one owner, comes first, so its token is made before the move ages
 * it.
 */
let server: FreshServer | undefined;
let clock: ReturnType<typeof movedClock>;
let receiver: Receiver;
/** Paths of the receiver that answer a delivery with a failure to retry. */
const failing = new Set<string>();

beforeAll(async () => {
  server = await bootFreshServer("webhook-owner-standing");
  clock = movedClock(server);
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

/** The private local socket, which reads every maker's subscriptions. */
async function local(path: string): Promise<number> {
  return (await controlRequest(server!.controlSocket, path)).status;
}

interface Row {
  id: string;
  status: string;
}

async function localDeliveries(
  webhookId: string,
): Promise<{ status: number; rows: Row[] }> {
  const read = await controlRequest(
    server!.controlSocket,
    `/webhooks/${webhookId}/deliveries`,
  );
  return { status: read.status, rows: (read.body.data ?? []) as Row[] };
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

const sentTo = (label: string) =>
  receiver.received.filter((r) => r.path === `/hook/${label}`);

describe("a subscription whose credential stops standing", () => {
  it("deletes an app's subscriptions when its grant is revoked", async () => {
    const app = await approvedApp(server!, [
      "core.note:read",
      "webhooks.manage",
    ]);
    const appClient = client(app.token);
    const id = await subscribe(appClient, "grant-app");
    // The witness: the subscription is the grant's, it is listed to the app,
    // and it delivers while the grant stands.
    expect((await appClient.listWebhooks()).data.data.map((w) => w.id)).toEqual(
      [id],
    );
    expect(await local(`/webhooks/${id}`)).toBe(200);
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

    expect(await local(`/webhooks/${id}`)).toBe(404);
    const listed = await controlRequest(server!.controlSocket, "/webhooks");
    expect(listed.status).toBe(200);
    expect(
      (listed.body.data as { id: string }[]).map((w) => w.id),
    ).not.toContain(id);
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

  it("delivers nothing more once the key that registered the subscription expires", async () => {
    const minted = await client(server!.workingKey).createKey({
      label: "expiring-owner",
      source: "webhook-owner-standing-expiring",
      permissions: ["webhooks.manage"],
      type_permissions: { "*": "read" },
      expires_at: new Date(clock.now() + HOUR_MS).toISOString(),
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    const owner = () => client(minted.data.key);

    // The key holds an expiry an hour off while it registers and is
    // delivered to, so what it stops doing later is what its expiry did.
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

    await clock.advance(2 * HOUR_MS);
    expect(
      (await owner().getCurrentKey()).status,
      "the key had not passed its expiry",
    ).toBe(401);
    const sentBefore = sentTo("expiry-retrying").length;

    const after = await note("expiry-after");
    await receiver.waitFor(
      (r) => r.path === "/hook/expiry-sentinel" && r.body.includes(after),
    );
    // The move made the waiting retry due: it is settled, or its subscription
    // is gone, rather than left waiting.
    await waitFor("the waiting retry to settle", async () => {
      const stored = await localDeliveries(retrying);
      return stored.status === 404 ||
        stored.rows.find((row) => row.id === pending.id)?.status !== "pending"
        ? true
        : undefined;
    });

    expect(
      sentTo("expiry-live").some((r) => r.body.includes(after)),
      "an event written after the key expired was delivered to its subscription",
    ).toBe(false);
    expect(
      sentTo("expiry-retrying").length,
      "a pending delivery of the expired key was attempted",
    ).toBe(sentBefore);
    // The local socket reads the subscription if it still stands; it is
    // gone, or its delivery was not made.
    const stored = await localDeliveries(retrying);
    if (stored.status !== 404) {
      expect(stored.status).toBe(200);
      expect(stored.rows.find((row) => row.id === pending.id)?.status).not.toBe(
        "success",
      );
    }
  });
});
