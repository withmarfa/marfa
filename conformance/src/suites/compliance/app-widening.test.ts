import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  HOLD,
  jobOf,
  queue,
  rowsAndChunk,
  seed,
} from "../../utils/bulk-jobs.js";
import { asDrawn } from "../../utils/approval-form.js";
import { controlRequest } from "../../utils/control-request.js";
import { checkDeviceCode } from "../../utils/device-check.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { MINUTE_MS, movedClock } from "../../utils/moved-clock.js";
import {
  connect,
  issuerOrigin,
  itemsStatus,
  registerApp,
  signIn,
  token,
  type App,
} from "../../utils/signed-in.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * An app asks for more access by authorizing again with the client it holds,
 * and the person approves. The grant it already holds widens in place: it keeps
 * its id and what it made. A person's approval needs the instance's one owner,
 * so this file boots a server of its own, and it moves that server's clock
 * only in the last case that needs it.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;
let receiver: Receiver;
let origin: string;
let cookie: string;
let learned: { rows: number; chunk: number } | undefined;
/** Paths of the receiver that answer a delivery with a failure to retry. */
const failing = new Set<string>();
/** Every job a case queued, so `afterEach` leaves the worker free. */
const queued: string[] = [];
let counter = 0;
const fresh = (what: string): string => `${what}-${String((counter += 1))}`;

const NOTES = "core.note:read offline_access";
const NOTES_WRITE = "core.note:write offline_access";
const HOOKS = "core.note:read webhooks.manage offline_access";

beforeAll(async () => {
  server = await bootFreshServer("app-widening");
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  receiver = await startReceiver({
    status: (received) => (failing.has(received.path) ? 503 : 200),
  });
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
  for (const id of queued.splice(0)) {
    await operator.bulkActionCancel(id);
    await operator.pollBulkActionToTerminal(id);
  }
}, 120_000);

afterAll(async () => {
  await receiver?.close();
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Grant {
  id: string;
  client_id: string;
  scopes: string[];
  granted_at: string;
}

/** The grants `GET /grants` lists to the operator. */
async function grants(): Promise<Grant[]> {
  const listed = await operator.rawRequest<{ data: Grant[] }>("/grants");
  expect(listed.status).toBe(200);
  return listed.data.data;
}

/** The one grant listed for the app. */
async function grantOf(app: App): Promise<Grant> {
  const own = (await grants()).filter((g) => g.client_id === app.clientId);
  expect(own).toHaveLength(1);
  return own[0]!;
}

/** The grant as it was: its id, scopes and when it was granted. */
async function expectStanding(app: App, before: Grant): Promise<void> {
  const now = await grantOf(app);
  expect({
    id: now.id,
    scopes: now.scopes,
    granted_at: now.granted_at,
  }).toEqual({
    id: before.id,
    scopes: before.scopes,
    granted_at: before.granted_at,
  });
}

function over(accessToken: string): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: accessToken });
}

function refresh(app: App, refreshToken: string) {
  return token(server, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: app.clientId,
  });
}

async function revoke(
  form: Record<string, string>,
): Promise<{ status: number; error?: string }> {
  const response = await fetch(`${server.apiUrl}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const text = await response.text();
  const body = text === "" ? {} : (JSON.parse(text) as { error?: string });
  return { status: response.status, error: body.error };
}

async function note(body: string): Promise<string> {
  const created = await working.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

describe("approving an app again with more access", () => {
  it("keeps the grant's id and holds the scopes it held with those approved", async () => {
    const app = await registerApp(server, NOTES);
    await connect(server, origin, cookie, app, NOTES);
    const before = await grantOf(app);
    // The witness: the access the widening adds is not held yet.
    expect(before.scopes).toContain("core.note:read");
    expect(before.scopes).not.toContain("instance.read");
    expect(before.scopes).not.toContain("audit.read");

    await connect(server, origin, cookie, app, `${NOTES} instance.read`);
    const wider = await grantOf(app);
    expect(wider.id).toBe(before.id);
    expect(wider.scopes).toEqual(
      expect.arrayContaining(["core.note:read", "instance.read"]),
    );

    // A request that names only the new access holds what the grant held.
    await connect(server, origin, cookie, app, "audit.read");
    const widest = await grantOf(app);
    expect(widest.id).toBe(before.id);
    expect(widest.scopes).toEqual(
      expect.arrayContaining(["core.note:read", "instance.read", "audit.read"]),
    );
  });

  it("keeps the grant's id and holds the scopes it held with those approved on the device approval page", async () => {
    const registered = await fetch(`${server.apiUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "device-widening",
        application_type: "native",
        grant_types: [
          "urn:ietf:params:oauth:grant-type:device_code",
          "refresh_token",
        ],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const app = {
      clientId: ((await registered.json()) as { client_id: string }).client_id,
    };

    await approveOnDevicePage(app, NOTES);
    const before = await grantOf(app);
    expect(before.scopes).not.toContain("instance.read");
    await approveOnDevicePage(app, `${NOTES} instance.read`);
    const wider = await grantOf(app);
    expect(wider.id).toBe(before.id);
    expect(wider.scopes).toEqual(
      expect.arrayContaining(["core.note:read", "instance.read"]),
    );
  });

  it("keeps each refresh chain of the grant that has not ended", async () => {
    const app = await registerApp(server, NOTES);
    const first = await connect(server, origin, cookie, app, NOTES);
    const other = await connect(server, origin, cookie, app, NOTES);
    // A chain a replay ended is not one that has not ended.
    expect((await refresh(app, other.refresh_token!)).status).toBe(200);
    expect((await refresh(app, other.refresh_token!)).status).toBe(400);
    const before = await grantOf(app);

    const wider = await connect(
      server,
      origin,
      cookie,
      app,
      `${NOTES} instance.read`,
    );
    expect((await grantOf(app)).id).toBe(before.id);

    // The chain the widening left unused refreshes, and so does the new one.
    const kept = await refresh(app, first.refresh_token!);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(await itemsStatus(server, kept.body.access_token!)).toBe(200);
    const added = await refresh(app, wider.refresh_token!);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
  });

  it("keeps running a job the grant holds", async () => {
    const held = await heldJob();
    const before = await grantOf(held.app);

    await connect(
      server,
      origin,
      cookie,
      held.app,
      `${NOTES_WRITE} instance.read`,
    );
    expect((await grantOf(held.app)).id).toBe(before.id);
    await server.clearFault();

    const ended = await operator.pollBulkActionToTerminal(held.id);
    expect(ended).toMatchObject({
      status: "completed",
      matched: held.rows,
      processed: held.rows,
      errored: 0,
    });
  });

  it("fails a job the grant holds once the grant ends, which the widening above did not do", async () => {
    const held = await heldJob();
    const ended = await operator.rawRequest(
      `/grants/${(await grantOf(held.app)).id}`,
      { method: "DELETE" },
    );
    expect(ended.status).toBe(200);
    await server.clearFault();

    const failed = await operator.pollBulkActionToTerminal(held.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/no longer authenticates/);
  });

  it("keeps an app's subscription, its maker and its pending delivery", async () => {
    const app = await registerApp(server, HOOKS);
    const first = await connect(server, origin, cookie, app, HOOKS);
    const subscription = await over(first.access_token!).createWebhook({
      url: receiver.hookUrl("widen"),
      events: ["item.created"],
    });
    expect(subscription.status, JSON.stringify(subscription.error)).toBe(201);
    const id = subscription.data.id;

    // A delivery the receiver refuses waits for a retry while the grant widens.
    failing.add("/hook/widen");
    const waiting = await note(fresh("widen-waiting"));
    const pending = await waitFor(
      "the delivery to wait for a retry",
      async () => {
        const rows = await deliveriesOf(id);
        return rows.find(
          (row) =>
            row.status === "pending" &&
            row.attempt >= 1 &&
            receiver.received.some(
              (r) => r.path === "/hook/widen" && r.body.includes(waiting),
            ),
        );
      },
    );
    const before = await grantOf(app);

    const wider = await connect(
      server,
      origin,
      cookie,
      app,
      `${HOOKS} instance.read`,
    );
    expect((await grantOf(app)).id).toBe(before.id);
    const listed = await over(wider.access_token!).rawRequest<{
      data: { id: string; maker: { kind: string; id: string } }[];
    }>("/webhooks");
    expect(listed.status).toBe(200);
    expect(listed.data.data.map((hook) => hook.id)).toEqual([id]);
    expect(listed.data.data[0]!.maker).toMatchObject({
      kind: "app",
      id: app.clientId,
    });
    const stored = (await deliveriesOf(id)).find(
      (row) => row.id === pending.id,
    );
    expect(stored?.status).toBe("pending");

    // The receiver recovers, the delivery that waited is made, and an event
    // written after the widening is delivered too.
    failing.delete("/hook/widen");
    await movedClock(server).advance(15 * MINUTE_MS);
    // The moved clock has aged the owner's session, so later cases sign in again.
    cookie = await signIn(server, origin);
    await waitFor("the delivery that waited to be made", async () =>
      (await deliveriesOf(id)).find(
        (row) => row.id === pending.id && row.status === "succeeded",
      ),
    );
    const after = await note(fresh("widen-after"));
    await receiver.waitFor(
      (r) => r.path === "/hook/widen" && r.body.includes(after),
    );
  });

  it("ends an app's subscriptions when it revokes its refresh token, as a widening does not", async () => {
    const app = await registerApp(server, HOOKS);
    const issued = await connect(server, origin, cookie, app, HOOKS);
    const subscribed = await over(issued.access_token!).createWebhook({
      url: receiver.hookUrl("revoked"),
      events: ["item.created"],
    });
    expect(subscribed.status, JSON.stringify(subscribed.error)).toBe(201);
    const id = subscribed.data.id;
    // The witness: the subscription is the app's, it stands, and it delivers.
    expect(await local(`/webhooks/${id}`)).toBe(200);
    const before = await note(fresh("revoked-before"));
    await receiver.waitFor(
      (r) => r.path === "/hook/revoked" && r.body.includes(before),
    );

    const revoked = await revoke({
      token: issued.refresh_token!,
      token_type_hint: "refresh_token",
      client_id: app.clientId,
    });
    expect(revoked.status).toBe(200);

    expect(await local(`/webhooks/${id}`)).toBe(404);
    const sentinel = await working.createWebhook({
      url: receiver.hookUrl("revoked-sentinel"),
      events: ["item.created"],
    });
    expect(sentinel.status, JSON.stringify(sentinel.error)).toBe(201);
    const after = await note(fresh("revoked-after"));
    await receiver.waitFor(
      (r) => r.path === "/hook/revoked-sentinel" && r.body.includes(after),
    );
    expect(
      receiver.received.some(
        (r) => r.path === "/hook/revoked" && r.body.includes(after),
      ),
      "an event written after the app revoked its refresh token was delivered to its subscription",
    ).toBe(false);
  });
});

describe("a client the server does not hold", () => {
  it("is answered 401 invalid_client at a revocation, which ends and changes nothing", async () => {
    const app = await registerApp(server, NOTES);
    const issued = await connect(server, origin, cookie, app, NOTES);
    const before = await grantOf(app);
    const unknown = `unknown-${randomUUID()}`;

    for (const held of [issued.refresh_token!, issued.access_token!]) {
      const refused = await revoke({ token: held, client_id: unknown });
      expect(refused).toEqual({ status: 401, error: "invalid_client" });
    }
    await expectStanding(app, before);
    expect(await itemsStatus(server, issued.access_token!)).toBe(200);
    const renewed = await refresh(app, issued.refresh_token!);
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);

    // The client the server holds, naming a value that is no token, answers 200
    // and changes nothing either.
    const harmless = await revoke({
      token: "not a token",
      client_id: app.clientId,
    });
    expect(harmless.status).toBe(200);
    await expectStanding(app, before);
    expect(await itemsStatus(server, renewed.body.access_token!)).toBe(200);

    // The witness: the same refresh token under the client that holds it ends the grant.
    const ended = await revoke({
      token: renewed.body.refresh_token!,
      token_type_hint: "refresh_token",
      client_id: app.clientId,
    });
    expect(ended.status).toBe(200);
    expect(await itemsStatus(server, renewed.body.access_token!)).toBe(401);
    expect((await grants()).map((g) => g.client_id)).not.toContain(
      app.clientId,
    );
  });

  it("is answered 400 invalid_client at a device code request, where a registered client is issued a code", async () => {
    const registered = await fetch(`${server.apiUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "device-unknown-client",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const ask = (id: string) =>
      fetch(`${server.apiUrl}/oauth/device-authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: id, scope: "core.note:read" }),
      });

    expect((await ask(client_id)).status).toBe(200);
    const refused = await ask(`unknown-${randomUUID()}`);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error?: string }).error).toBe(
      "invalid_client",
    );
  });
});

/** The device code of `app` for `scope`, approved as the page draws it. */
async function approveOnDevicePage(app: App, scope: string): Promise<void> {
  const issued = await fetch(`${server.apiUrl}/oauth/device-authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.clientId, scope }),
  });
  expect(issued.status).toBe(200);
  const code = (await issued.json()) as {
    user_code: string;
    device_code: string;
  };
  await checkDeviceCode(server.apiUrl, origin, cookie, code.user_code);
  const page = await fetch(
    `${server.apiUrl}/auth/device/consent?user_code=${encodeURIComponent(code.user_code)}`,
    { headers: { cookie }, redirect: "manual" },
  );
  expect(page.status).toBe(200);
  const approved = await fetch(`${server.apiUrl}/auth/device/consent`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([
      ["user_code", code.user_code],
      ["decision", "approve"],
      ...asDrawn(await page.text()),
    ]),
  });
  expect(approved.status).toBe(200);
  const polled = await token(server, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: code.device_code,
    client_id: app.clientId,
  });
  expect(polled.status, JSON.stringify(polled.body)).toBe(200);
}

/** The private local socket, which reads every maker's subscriptions. */
async function local(path: string): Promise<number> {
  return (await controlRequest(server.controlSocket, path)).status;
}

interface Delivery {
  id: string;
  status: string;
  attempt: number;
}

async function deliveriesOf(webhookId: string): Promise<Delivery[]> {
  const read = await controlRequest(
    server.controlSocket,
    `/webhooks/${webhookId}/deliveries`,
  );
  expect(read.status).toBe(200);
  return (read.body.data ?? []) as Delivery[];
}

/**
 * An app's job over more items than one chunk, held after its first chunk, so
 * what a case does to the app's grant lands while the job has more to do.
 */
async function heldJob(): Promise<{
  app: App;
  id: string;
  rows: number;
}> {
  learned ??= await rowsAndChunk(working);
  const tag = fresh("widen-job");
  await seed(working, tag, learned.rows);
  const app = await registerApp(server, NOTES_WRITE);
  const issued = await connect(server, origin, cookie, app, NOTES_WRITE);
  const holder = over(issued.access_token!);
  await server.setFault(HOLD.betweenChunks);
  const id = await queue(holder, {
    action: "update_tags",
    add: [`${tag}-done`],
    filter: { tags: [tag] },
  });
  queued.push(id);
  await server.waitForHold(HOLD.betweenChunks);
  const job = await jobOf(holder, id);
  // The witness that a chunk was written and more are left to run.
  expect(job.status).toBe("in_progress");
  expect(job.processed).toBeGreaterThan(0);
  expect(job.processed).toBeLessThan(job.matched);
  return { app, id, rows: learned.rows };
}
