import { readFileSync } from "node:fs";
import {
  sessionCookieOf,
  signInOwnerWithPassword,
} from "../../client/owner-session.js";
import { visibleText } from "../../utils/approval-form.js";
import { postDeviceCheck } from "../../utils/device-check.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  type DeviceFlow,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { TEST_OWNER } from "../../utils/target.js";

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
    await expectMatchesSchema("POST", "/oauth/token", 400, pending.body);
  });

  it("answers the first poll after the approval, an interval after the last, with an access token for the approved scopes", async () => {
    await flow.approve();
    await waitOut(flow.interval);
    const approved = await flow.poll();
    expect(approved.status).toBe(200);
    expect(approved.body.access_token).toBeTruthy();
    expect(approved.body.token_type?.toLowerCase()).toBe("bearer");
    expect(approved.body.scope).toBe("core.note:read");
    await expectMatchesSchema("POST", "/oauth/token", 200, approved.body);
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
  async function ask(scope?: string): Promise<Response> {
    const registered = await fetch(`${server!.apiUrl}/oauth/register`, {
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
    return fetch(`${server!.apiUrl}/oauth/device-authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        ...(scope === undefined ? {} : { scope }),
      }),
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
    await expectMatchesSchema("POST", "/oauth/device-authorization", 200, body);
  });

  it("is refused 400 invalid_scope when no scopes are named", async () => {
    expect((await ask("core.note:read")).status).toBe(200);
    for (const scope of [undefined, "", "   "]) {
      const refused = await ask(scope);
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_scope");
      expect(body.error_description).toMatch(/name.*scope/i);
      expect(body.device_code).toBeUndefined();
    }
  });

  it("is refused 400 invalid_scope for a scope the instance does not publish", async () => {
    const refused = await ask("user.nothing_registered_here:read");
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_scope");
    expect(body.device_code).toBeUndefined();
  });

  it("is refused 400 invalid_scope for a scope under a permission root that is not a permission, and issued for each permission", async () => {
    const registered = await fetch(`${server!.apiUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "device-grant-permission-scopes",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const code = (scope: string): Promise<Response> =>
      fetch(`${server!.apiUrl}/oauth/device-authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id, scope }),
      });

    // The witness: each permission is issued a code.
    for (const permission of [
      "audit.read",
      "blobs.manage",
      "config.manage",
      "connectors.manage",
      "grants.manage",
      "instance.maintain",
      "instance.read",
      "items.purge",
      "keys.manage",
      "keys.mint",
      "schema.write",
      "webhooks.manage",
    ]) {
      const issued = await code(permission);
      expect(issued.status, permission).toBe(200);
      await issued.body?.cancel();
    }
    for (const scope of [
      "items.write",
      "items.bogus",
      "keys.x",
      "schema.read",
      "items.*:read",
      "schema.*:write",
      "items.purge:read",
      "connectors.host",
    ]) {
      const refused = await code(scope);
      expect(refused.status, scope).toBe(400);
      const body = (await refused.json()) as Record<string, unknown>;
      expect(body.error, scope).toBe("invalid_scope");
      expect(body.device_code, scope).toBeUndefined();
    }
  });

  it("is refused 400 invalid_scope for offline_access when its client may not refresh", async () => {
    // The witness: the same scope without `offline_access` is issued a code.
    expect((await ask("core.note:read")).status).toBe(200);
    const refused = await ask("core.note:read offline_access");
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

  it("is held by the server as something other than the code it issued, and still polls", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    // The server has written the flow's client and code by now, so the
    // search covers the database file and the log beside it, wherever the
    // bytes are. The witness: the same search finds the client's ID, which
    // the server does store as it is.
    const held = ["", "-wal"].map((suffix) => {
      try {
        return readFileSync(`${server!.sqlitePath}${suffix}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return Buffer.alloc(0);
        }
        throw error;
      }
    });
    const found = (text: string) =>
      held.some((bytes) => bytes.includes(Buffer.from(text)));
    expect(found(flow.clientId), "the search cannot see a stored value").toBe(
      true,
    );
    expect(found(flow.deviceCode)).toBe(false);
    expect((await flow.poll()).body.error).toBe("authorization_pending");
  });

  it("answers expired_token to a poll of a code past its expiry", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    // The witness: the code is answered on its state before it ages.
    expect((await flow.poll()).body.error).toBe("authorization_pending");
    // Past the ten minutes the code lives.
    await server!.advanceClock(11 * 60_000);
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
    const listed = await fetch(`${server!.apiUrl}/grants`, {
      headers: authorization,
    });
    const grant = (
      (await listed.json()) as { data: { id: string; client_id: string }[] }
    ).data.find((g) => g.client_id === flow.clientId);
    // The witness: the approval made a grant to revoke.
    expect(grant, "the approval made no grant").toBeDefined();
    const revoked = await fetch(`${server!.apiUrl}/grants/${grant!.id}`, {
      method: "DELETE",
      headers: authorization,
    });
    expect(revoked.status).toBe(200);
    const polled = await flow.poll();
    expect(polled.status).toBe(400);
    expect(polled.body.error).toBe("invalid_grant");
    expect(polled.body.access_token).toBeUndefined();
  });
});

describe("the device check step", () => {
  function signIn(flow: DeviceFlow): Promise<string> {
    return signInOwnerWithPassword(flow.origin, flow.origin, TEST_OWNER);
  }

  function open(
    flow: DeviceFlow,
    path: string,
    cookie?: string,
  ): Promise<Response> {
    return fetch(
      `${flow.origin}${path}?user_code=${encodeURIComponent(flow.userCode)}`,
      { redirect: "manual", headers: cookie ? { cookie } : {} },
    );
  }

  function decide(flow: DeviceFlow, cookie: string): Promise<Response> {
    return fetch(`${flow.origin}/auth/device/consent`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: flow.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        user_code: flow.userCode,
        decision: "approve",
        scopes: "core.note:read",
      }),
    });
  }

  /** Where a redirect sends the browser, read on the sign-in surface. */
  async function sentTo(answer: Response, flow: DeviceFlow): Promise<URL> {
    await answer.body?.cancel();
    expect(answer.status).toBe(302);
    return new URL(answer.headers.get("location") ?? "", flow.origin);
  }

  async function expectSentToCheck(
    answer: Response,
    flow: DeviceFlow,
  ): Promise<void> {
    const to = await sentTo(answer, flow);
    expect(to.pathname, String(to)).toBe("/auth/device/check");
    expect([...to.searchParams], String(to)).toEqual([
      ["user_code", flow.userCode],
    ]);
  }

  async function expectEntryError(
    answer: Response,
    flow: DeviceFlow,
    error: string,
  ): Promise<void> {
    const to = await sentTo(answer, flow);
    expect(to.pathname, String(to)).toBe("/auth/device");
    expect(to.searchParams.get("error"), String(to)).toBe(error);
  }

  it("sends a link carrying the code to the check step, which shows the code to compare", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    const cookie = await signIn(flow);
    const followed = await fetch(flow.link, {
      redirect: "manual",
      headers: { cookie },
    });
    await expectSentToCheck(followed, flow);

    const page = await open(flow, "/auth/device/check", cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    const text = visibleText(html);
    expect(text).toContain(
      `${flow.userCode.slice(0, 4)}-${flow.userCode.slice(4)}`,
    );
    expect(text).toContain("It should match the code on your device.");
    expect(html).toMatch(/<form method="post" action="\/auth\/device\/check">/);
    // Following the link decided nothing.
    expect((await flow.poll()).body.error).toBe("authorization_pending");
  });

  it("sends a typed code to the check step", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    const entered = await fetch(`${flow.origin}/auth/device`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: flow.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ user_code: flow.userCode }),
    });
    await expectSentToCheck(entered, flow);
  });

  it("sends a browser with no session to sign in, and back to the check step", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    const back = `/auth/device/check?user_code=${encodeURIComponent(flow.userCode)}`;
    for (const answer of [
      await open(flow, "/auth/device/check"),
      await postDeviceCheck(flow.origin, flow.origin, "", flow.userCode),
    ]) {
      const to = await sentTo(answer, flow);
      expect(to.pathname, String(to)).toBe("/auth/sign-in");
      expect(to.searchParams.get("return_to"), String(to)).toBe(back);
    }
    const signedIn = await fetch(`${flow.origin}${back}`, {
      redirect: "manual",
      headers: { cookie: await signIn(flow) },
    });
    await signedIn.body?.cancel();
    expect(signedIn.status).toBe(200);
  });

  it("opens the approval page only for the code the owner confirmed, in the browser that confirmed it", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    const other = await startDeviceFlow(server!, ["core.note:read"]);
    const here = await signIn(flow);
    const elsewhere = await signIn(flow);

    // Nothing is confirmed: the page and a decision both go to the check step.
    await expectSentToCheck(
      await open(flow, "/auth/device/consent", here),
      flow,
    );
    await expectSentToCheck(await decide(flow, here), flow);

    const confirmed = await sentTo(
      await postDeviceCheck(flow.origin, flow.origin, here, flow.userCode),
      flow,
    );
    expect(confirmed.pathname).toBe("/auth/device/consent");
    expect([...confirmed.searchParams]).toEqual([["user_code", flow.userCode]]);

    // The confirmation admits no other code, and no other browser session of
    // the same owner.
    await expectSentToCheck(
      await open(other, "/auth/device/consent", here),
      other,
    );
    await expectSentToCheck(await decide(other, here), other);
    await expectSentToCheck(
      await open(flow, "/auth/device/consent", elsewhere),
      flow,
    );
    await expectSentToCheck(await decide(flow, elsewhere), flow);
    expect((await flow.poll()).body.error).toBe("authorization_pending");
    expect((await other.poll()).body.error).toBe("authorization_pending");

    // The witness: the browser that confirmed the code opens the page and
    // approves.
    const page = await open(flow, "/auth/device/consent", here);
    await page.body?.cancel();
    expect(page.status).toBe(200);
    const approved = await decide(flow, here);
    await approved.body?.cancel();
    expect(approved.status).toBe(200);
    await waitOut(flow.interval);
    expect((await flow.poll()).status).toBe(200);
  });

  it("keeps a confirmed code when the owner confirms it's them", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    const before = await signIn(flow);
    const checked = await sentTo(
      await postDeviceCheck(flow.origin, flow.origin, before, flow.userCode),
      flow,
    );
    expect(checked.pathname).toBe("/auth/device/consent");
    const confirmed = await fetch(`${flow.origin}/auth/confirm`, {
      method: "POST",
      headers: {
        cookie: before,
        origin: flow.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: TEST_OWNER.password }),
    });
    expect(confirmed.status).toBe(200);
    const after = sessionCookieOf(confirmed);
    expect(after, "the confirmation set no session cookie").toBeDefined();
    expect(after).not.toBe(before);

    // The witness: a session that did not confirm the code is sent to check it.
    await expectSentToCheck(
      await open(flow, "/auth/device/consent", await signIn(flow)),
      flow,
    );
    const page = await open(flow, "/auth/device/consent", after);
    await page.body?.cancel();
    expect(page.status, page.headers.get("location") ?? "").toBe(200);
    const approved = await decide(flow, after!);
    await approved.body?.cancel();
    expect(approved.status).toBe(200);
  });

  it("sends a code it does not know back to the entry page as wrong, and a code it holds as expired as expired", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);
    const cookie = await signIn(flow);
    const unknown = { ...flow, userCode: "BCDFGHJK" };
    await expectEntryError(
      await open(unknown, "/auth/device/check", cookie),
      flow,
      "invalid_code",
    );
    await expectEntryError(
      await postDeviceCheck(flow.origin, flow.origin, cookie, "BCDFGHJK"),
      flow,
      "invalid_code",
    );

    // The witness: before it expires, the code opens the check page.
    const shown = await open(flow, "/auth/device/check", cookie);
    await shown.body?.cancel();
    expect(shown.status).toBe(200);
    // Past the ten minutes the code lives.
    await server!.advanceClock(11 * 60_000);
    await expectEntryError(
      await open(flow, "/auth/device/check", cookie),
      flow,
      "expired_code",
    );
    await expectEntryError(
      await postDeviceCheck(flow.origin, flow.origin, cookie, flow.userCode),
      flow,
      "expired_code",
    );
  });
});
