import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  type DeviceFlow,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * A device asking for a code and polling for its token, with a person
 * approving in between. The device holds no credential at any step; the
 * approval needs the owner signed in, and an instance has one owner, which
 * the run's shared server does not have, so this file boots a server of its
 * own and creates the owner there.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("device-grant");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A poller leaves the interval between polls; a sooner one is told to slow
 *  down rather than answered on the code's state. */
function waitOut(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));
}

describe("the device authorization grant", () => {
  // One code, taken through its states in order: each test leaves it where
  // the next one starts.
  let flow: DeviceFlow;

  it("answers authorization_pending to a poll of a code nobody has decided", async () => {
    flow = await startDeviceFlow(server!, ["core.note:read"]);
    const pending = await flow.poll();
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe("authorization_pending");
    expect(pending.body.access_token).toBeUndefined();
  });

  it("answers the first poll after the approval, an interval after the last, with an access token for the approved scopes", async () => {
    await flow.approve();
    await waitOut(flow.interval);
    const approved = await flow.poll();
    expect(approved.status).toBe(200);
    expect(approved.body.access_token).toBeTruthy();
    expect(approved.body.token_type?.toLowerCase()).toBe("bearer");
    expect(approved.body.scope).toBe("core.note:read");
  });

  it("answers invalid_grant to a poll of a code a token was already issued for", async () => {
    // The witness: the previous test had this code answered with a token, so
    // it is that exchange that spent it. No wait: a spent code is refused
    // whatever the time since the last poll.
    const reused = await flow.poll();
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe("invalid_grant");
    expect(reused.body.access_token).toBeUndefined();
  });
});

describe("a device code", () => {
  async function ask(scope: string): Promise<Response> {
    const registered = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "device-grant",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    return fetch(`${server!.apiUrl}/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id, scope }),
    });
  }

  it("is issued with its codes, where to enter it, ten minutes to live and a five-second interval", async () => {
    const issued = await ask("core.note:read");
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as Record<string, unknown>;
    expect(body.device_code).toEqual(expect.any(String));
    expect(body.user_code).toEqual(expect.any(String));
    const entry = new URL(String(body.verification_uri));
    expect(entry.pathname).toBe("/auth/device");
    const complete = new URL(String(body.verification_uri_complete));
    expect(complete.pathname).toBe("/auth/device");
    expect(complete.searchParams.get("user_code")).toBe(body.user_code);
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });

  it("is refused 400 invalid_scope for a scope the instance does not publish", async () => {
    const refused = await ask("user.nothing_registered_here:read");
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_scope");
    expect(body.device_code).toBeUndefined();
  });

  it("answers slow_down to a poll sooner than the interval after the previous one", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    // The witness: the code's first poll is answered on its state.
    expect((await flow.poll()).body.error).toBe("authorization_pending");
    const hurried = await flow.poll();
    expect(hurried.status).toBe(400);
    expect(hurried.body.error).toBe("slow_down");
    expect(hurried.body.access_token).toBeUndefined();
  });

  it("answers access_denied to a poll of a code the person denied", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    await flow.deny();
    const denied = await flow.poll();
    expect(denied.status).toBe(400);
    expect(denied.body.error).toBe("access_denied");
    expect(denied.body.access_token).toBeUndefined();
  });

  it("answers expired_token to a poll of a code past its expiry", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    // The witness: the code is answered on its state before it ages.
    expect((await flow.poll()).body.error).toBe("authorization_pending");
    // Ten minutes is a long wait, so the code is aged in place.
    withInstanceDatabase(server!.sqlitePath, (db) => {
      const aged = db
        .prepare(
          "UPDATE auth_oauth_device_code SET expires_at = 1 WHERE device_code = ?",
        )
        .run(flow.deviceCode);
      expect(aged.changes).toBe(1);
    });
    await waitOut(flow.interval);
    const expired = await flow.poll();
    expect(expired.status).toBe(400);
    expect(expired.body.error).toBe("expired_token");
    expect(expired.body.access_token).toBeUndefined();
  });
});

describe("a device code whose grant is revoked", () => {
  it("answers invalid_grant to a poll after the person's grant was revoked between the approval and the poll", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    await flow.approve();
    const authorization = { authorization: `Bearer ${server!.workingKey}` };
    const listed = await fetch(`${server!.apiUrl}/auth/grants`, {
      headers: authorization,
    });
    const grant = (
      (await listed.json()) as { data: { id: string; client_id: string }[] }
    ).data.find((g) => g.client_id === flow.clientId);
    // The witness: the approval made a grant to revoke.
    expect(grant, "the approval made no grant").toBeDefined();
    const revoked = await fetch(`${server!.apiUrl}/auth/grants/${grant!.id}`, {
      method: "DELETE",
      headers: authorization,
    });
    expect(revoked.status).toBe(204);
    const polled = await flow.poll();
    expect(polled.status).toBe(400);
    expect(polled.body.error).toBe("invalid_grant");
    expect(polled.body.access_token).toBeUndefined();
  });
});
