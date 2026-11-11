import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorize,
  authorizeQuery,
  CALLBACK,
  codeFor,
  issuerOrigin,
  pkce,
  registerApp,
  sentTo,
  token,
  type App,
} from "../../utils/signed-in.js";
import { readControls } from "../../utils/approval-form.js";
import { visibleText } from "../../utils/page-html.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * What a browser session that signed in more than five minutes ago may and
 * may not approve on either consent screen. A session's age is the server's clock
 * moved forward, and the clock only goes forward, so each case signs the stale
 * session in first, lets six minutes pass, and signs the fresh one in after.
 * Each sign-in comes from an address of its own, so the per-address sign-in
 * limit never holds this file back.
 */
let server: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";
const MINUTE = 60 * 1000;
let addresses = 0;

beforeAll(async () => {
  server = await bootFreshServer("recent-sign-in-consent", {
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
  });
  origin = await issuerOrigin(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function nextAddress(): string {
  addresses += 1;
  return `198.51.100.${String(addresses)}`;
}

async function signIn(): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: nextAddress(),
    },
    body: JSON.stringify(TEST_OWNER),
  });
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*marfa_session=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return cookie!;
}

async function pass(ms: number): Promise<void> {
  await server.advanceClock(ms);
}

/**
 * A browser session more than five minutes old, and one made just now. The
 * time passed is longer than the fifteen minutes the device code lookups of
 * one owner are counted over, so a case never spends the lookups of the one
 * before it.
 */
async function staleAndFresh(): Promise<{ stale: string; fresh: string }> {
  const stale = await signIn();
  await pass(16 * MINUTE);
  return { stale, fresh: await signIn() };
}

function ownerPost(
  path: string,
  cookie: string,
  form: URLSearchParams,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...headers,
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
      [CLIENT_HEADER]: nextAddress(),
    },
    body: form,
  });
}

function ownerGet(path: string, cookie: string): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    redirect: "manual",
    headers: { cookie, [CLIENT_HEADER]: nextAddress() },
  });
}

async function refused(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(response.headers.get("x-error-code")).toBe("forbidden");
  await response.body?.cancel();
}

/** What a browser sends with a form it submits. */
const BROWSER = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ---------------------------------------------------------------------------
// The device screen
// ---------------------------------------------------------------------------

interface Device {
  clientId: string;
  userCode: string;
  deviceCode: string;
}

async function registerDeviceClient(): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "recent-sign-in device",
      application_type: "native",
      grant_types: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      response_types: [],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function deviceCode(scope: string, clientId?: string): Promise<Device> {
  const id = clientId ?? (await registerDeviceClient());
  const response = await fetch(`${server.apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, scope }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    user_code: string;
    device_code: string;
  };
  return {
    clientId: id,
    userCode: body.user_code,
    deviceCode: body.device_code,
  };
}

function deviceScreen(device: Device, cookie: string): Promise<Response> {
  return ownerGet(
    `/auth/device/consent?user_code=${encodeURIComponent(device.userCode)}`,
    cookie,
  );
}

function deviceApproval(
  device: Device,
  cookie: string,
  scopes: readonly string[],
  headers: Record<string, string> = {},
): Promise<Response> {
  return ownerPost(
    "/auth/device/consent",
    cookie,
    new URLSearchParams([
      ["user_code", device.userCode],
      ["decision", "approve"],
      ...scopes.map((scope): [string, string] => ["scopes", scope]),
    ]),
    headers,
  );
}

async function devicePoll(
  device: Device,
): Promise<{ status: number; scope?: string; accessToken?: string }> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
      client_id: device.clientId,
    }),
  });
  const body = (await response.json()) as {
    scope?: string;
    access_token?: string;
  };
  return {
    status: response.status,
    scope: body.scope,
    accessToken: body.access_token,
  };
}

function scopesOf(scope: string | undefined): string[] {
  return (scope ?? "").split(" ").filter(Boolean).sort();
}

describe("approving a device", () => {
  it("refuses a session that signed in more than five minutes ago 403 for a permission, and a fresh session approves the same code", async () => {
    const { stale, fresh } = await staleAndFresh();
    const device = await deviceCode("core.note:read keys.manage");
    await refused(
      await deviceApproval(device, stale, ["core.note:read", "keys.manage"]),
    );
    // The witness: the refusal left the code pending, so a fresh session
    // approves the very request, and the token carries the permission.
    const approved = await deviceApproval(device, fresh, [
      "core.note:read",
      "keys.manage",
    ]);
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    const polled = await devicePoll(device);
    expect(polled.status).toBe(200);
    expect(scopesOf(polled.scope)).toEqual(["core.note:read", "keys.manage"]);
  });

  it("refuses a session that signed in more than five minutes ago 403 for a write, and a fresh session approves the same code", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const write of ["core.note:write", "*:write", "content:write"]) {
      const device = await deviceCode(`core.note:read ${write}`);
      await refused(
        await deviceApproval(device, stale, ["core.note:read", write]),
      );
      const approved = await deviceApproval(device, fresh, [
        "core.note:read",
        write,
      ]);
      expect(approved.status, write).toBe(200);
      await approved.body?.cancel();
      const polled = await devicePoll(device);
      expect(polled.status, write).toBe(200);
      expect(scopesOf(polled.scope), write).toEqual(
        ["core.note:read", write].sort(),
      );
    }
  });

  it("approves from a session that signed in more than five minutes ago the scopes that only read, and not the ones left off", async () => {
    const { stale } = await staleAndFresh();
    const device = await deviceCode(
      "core.note:read edge.parent-of:read metadata:read profile.name:read keys.manage core.note:write",
    );
    const approved = await deviceApproval(device, stale, [
      "core.note:read",
      "edge.parent-of:read",
      "metadata:read",
      "profile.name:read",
    ]);
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    const polled = await devicePoll(device);
    expect(polled.status).toBe(200);
    expect(scopesOf(polled.scope)).toEqual(
      [
        "core.note:read",
        "edge.parent-of:read",
        "metadata:read",
        "profile.name:read",
      ].sort(),
    );
  });

  it("approves from a session that signed in more than five minutes ago a permission the app was approved for before", async () => {
    const stale = await signIn();
    const client = await registerDeviceClient();
    const first = await deviceCode("core.note:read keys.manage", client);
    const approvedFirst = await deviceApproval(first, stale, [
      "core.note:read",
      "keys.manage",
    ]);
    expect(approvedFirst.status).toBe(200);
    await approvedFirst.body?.cancel();
    expect((await devicePoll(first)).status).toBe(200);
    await pass(6 * MINUTE);
    const again = await deviceCode("core.note:read keys.manage", client);
    const approved = await deviceApproval(again, stale, [
      "core.note:read",
      "keys.manage",
    ]);
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    // The permission it held is not the only one: a second one is refused.
    const widened = await deviceCode(
      "core.note:read keys.manage blobs.manage",
      client,
    );
    await refused(
      await deviceApproval(widened, stale, [
        "core.note:read",
        "keys.manage",
        "blobs.manage",
      ]),
    );
  });

  it("refuses a browser that approves a device code for a permission or a write on a screen left open past five minutes 403, whatever it asks for, and leaves the code pending", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const scope of ["keys.manage", "core.note:write"]) {
      const device = await deviceCode(`core.note:read ${scope}`);
      const scopes = ["core.note:read", scope];
      for (const headers of [BROWSER, { accept: "application/json" }, {}]) {
        await refused(await deviceApproval(device, stale, scopes, headers));
      }
      // The witness: the refusals left the code pending, so a fresh session
      // approves the very same code.
      const approved = await deviceApproval(device, fresh, scopes, BROWSER);
      expect(approved.status, scope).toBe(200);
      await approved.body?.cancel();
      expect(scopesOf((await devicePoll(device)).scope), scope).toEqual(
        [...scopes].sort(),
      );
    }
  });
});

describe("the device screen", () => {
  it("shows a session that signed in more than five minutes ago the request for a permission or a write, with the way to confirm it's them", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const scope of ["core.note:read keys.manage", "core.note:write"]) {
      const device = await deviceCode(scope);
      const screen = await deviceScreen(device, stale);
      expect(screen.status, scope).toBe(200);
      const text = visibleText(await screen.text());
      expect(text, scope).toContain("Confirm it's you");
      expect(text, scope).toContain(
        "Changes like this need a sign-in from the last 5 minutes.",
      );
      // The same request is shown to a session that signed in just now, so a
      // screen left open can ask when its five minutes run out.
      const shown = await deviceScreen(device, fresh);
      expect(shown.status, scope).toBe(200);
      expect(visibleText(await shown.text()), scope).toContain(
        "Confirm it's you",
      );
    }
  });

  it("shows a session that signed in more than five minutes ago a request that only reads, with no question", async () => {
    const { stale } = await staleAndFresh();
    const reading = await deviceCode("core.note:read profile.name:read");
    const shown = await deviceScreen(reading, stale);
    expect(shown.status).toBe(200);
    expect(visibleText(await shown.text())).not.toContain("Confirm it's you");
  });
});

// ---------------------------------------------------------------------------
// The authorization screen
// ---------------------------------------------------------------------------

/** The consent screen's address for a request, reached as `cookie`. */
async function consentFor(
  app: App,
  scope: string,
  cookie: string,
  extra: Record<string, string> = {},
): Promise<{ url: URL; verifier: string }> {
  const proof = pkce();
  const landed = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(app.clientId, scope, proof, extra),
      cookie,
    ),
  );
  expect(landed?.pathname).toBe("/auth/authorize");
  return { url: landed!, verifier: proof.verifier };
}

function decision(
  consent: URL,
  cookie: string,
  scopes: readonly string[],
  headers: Record<string, string> = {},
): Promise<Response> {
  return ownerPost(
    "/auth/authorize/decision",
    cookie,
    new URLSearchParams([
      ["accept", "true"],
      ["oauth_query", consent.search.slice(1)],
      ...scopes.map((scope): [string, string] => ["scopes", scope]),
    ]),
    headers,
  );
}

async function codeOf(response: Response): Promise<string | null | undefined> {
  const landed = await sentTo(server, response);
  expect(landed?.href.startsWith(CALLBACK)).toBe(true);
  return landed?.searchParams.get("code");
}

describe("approving an app", () => {
  it("refuses a session that signed in more than five minutes ago 403 for a permission or a write, and a fresh session approves the same request", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const gated of ["keys.manage", "core.note:write", "content:write"]) {
      const scope = `core.note:read ${gated}`;
      const app = await registerApp(server, scope);
      const { url } = await consentFor(app, scope, stale);
      await refused(await decision(url, stale, scope.split(" ")));
      const code = await codeOf(await decision(url, fresh, scope.split(" ")));
      expect(code, gated).toBeTruthy();
    }
  });

  it("approves from a session that signed in more than five minutes ago the scopes that only read, and the scopes left off", async () => {
    const { stale } = await staleAndFresh();
    const reads = [
      "core.note:read",
      "edge.parent-of:read",
      "metadata:read",
      "profile:read",
      "offline_access",
    ];
    const scope = [...reads, "keys.manage", "core.note:write"].join(" ");
    const app = await registerApp(server, scope);
    const { url, verifier } = await consentFor(app, scope, stale);
    const code = await codeOf(await decision(url, stale, reads));
    expect(code).toBeTruthy();
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status).toBe(200);
    expect(scopesOf(exchanged.body.scope)).toEqual([...reads].sort());
  });

  it("approves from a session that signed in more than five minutes ago a permission the app was approved for before, and refuses a second one", async () => {
    const first = await signIn();
    const scope = "core.note:read keys.manage";
    const app = await registerApp(server, `${scope} blobs.manage`);
    await codeFor(server, origin, first, app, scope);
    await pass(6 * MINUTE);
    // The witness: the same session is refused a permission the app does not
    // hold, in the same request.
    const wider = `${scope} blobs.manage`;
    const asked = await consentFor(app, wider, first, { prompt: "consent" });
    await refused(await decision(asked.url, first, wider.split(" ")));
    const held = await consentFor(app, scope, first, { prompt: "consent" });
    expect(
      await codeOf(await decision(held.url, first, scope.split(" "))),
    ).toBeTruthy();
  });

  it("refuses a browser that approves a request for a permission or a write on a screen left open past five minutes 403, whatever it asks for, and issues no code", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const gated of ["keys.manage", "core.note:write"]) {
      const scope = `core.note:read ${gated}`;
      const app = await registerApp(server, scope);
      const { url } = await consentFor(app, scope, stale);
      for (const headers of [BROWSER, { accept: "application/json" }, {}])
        await refused(await decision(url, stale, scope.split(" "), headers));
      // The witness: a fresh session approves the very same request.
      expect(
        await codeOf(await decision(url, fresh, scope.split(" "), BROWSER)),
        gated,
      ).toBeTruthy();
    }
  });
});

describe("the authorization screen", () => {
  it("shows a session that signed in more than five minutes ago the request for a permission or a write, with the way to confirm it's them", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const scope of ["core.note:read keys.manage", "core.note:write"]) {
      const app = await registerApp(server, scope);
      const { url } = await consentFor(app, scope, stale);
      const screen = await ownerGet(`${url.pathname}${url.search}`, stale);
      expect(screen.status, scope).toBe(200);
      const text = visibleText(await screen.text());
      expect(text, scope).toContain("Confirm it's you");
      expect(text, scope).toContain(
        "Changes like this need a sign-in from the last 5 minutes.",
      );
      // The same request is shown to a session that signed in just now, so a
      // screen left open can ask when its five minutes run out.
      const shown = await ownerGet(`${url.pathname}${url.search}`, fresh);
      expect(shown.status, scope).toBe(200);
      expect(visibleText(await shown.text()), scope).toContain(
        "Confirm it's you",
      );
    }
  });

  it("shows a session that signed in more than five minutes ago a request that only reads, with no question", async () => {
    const { stale } = await staleAndFresh();
    const scope = "core.note:read edge.parent-of:read profile:read";
    const app = await registerApp(server, scope);
    const { url } = await consentFor(app, scope, stale);
    const shown = await ownerGet(`${url.pathname}${url.search}`, stale);
    expect(shown.status).toBe(200);
    expect(visibleText(await shown.text())).not.toContain("Confirm it's you");
  });

  it("answers a request a standing consent covers with a code, whatever the age of the session", async () => {
    const first = await signIn();
    const scope = "core.note:read keys.manage";
    const app = await registerApp(server, scope);
    await codeFor(server, origin, first, app, scope);
    await pass(6 * MINUTE);
    const { silent } = await codeFor(server, origin, first, app, scope);
    expect(silent).toBe(true);
  });

  it("shows the sign-in form to a browser that holds a session and opens the sign-in page with prompt=login", async () => {
    const { stale } = await staleAndFresh();
    const page = await ownerGet(
      `/auth/sign-in?prompt=login&return_to=${encodeURIComponent("/auth/forgot-password")}`,
      stale,
    );
    expect(page.status).toBe(200);
    expect(
      readControls(await page.text()).some((c) => c.type === "password"),
    ).toBe(true);
  });
});
