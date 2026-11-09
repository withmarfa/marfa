import {
  readControls,
  readRows,
  visibleText,
} from "../../utils/approval-form.js";
import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * The caution the pages a person approves an app on show beside its name.
 * Registration takes no credential, so every app names itself.
 *
 * Approving needs the owner signed in, and an instance has one owner, so this
 * file boots a server of its own and claims its owner through the production local command.
 */
let server: FreshServer | undefined;
let origin: string;
let cookie: string;

const CALLBACK = "http://127.0.0.1:9/callback";
const CAUTION = "can't confirm who made this app";
const SIGN_IN_CAUTION = "hasn't verified this app";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

beforeAll(async () => {
  server = await bootFreshServer("unverified-apps");
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  const { issuer } = (await discovery.json()) as { issuer: string };
  origin = new URL(issuer).origin;
  const signedIn = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(OWNER),
  });
  expect(signedIn.status).toBe(200);
  const session = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    signedIn.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(session, "sign-in set no session cookie").toBeTruthy();
  cookie = session!;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Registered {
  clientId: string;
}

/** Registers an app the way any program can: no credential. */
async function register(
  name: string,
  grantTypes: string[],
): Promise<Registered> {
  const response = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: grantTypes,
      response_types: grantTypes.includes("authorization_code") ? ["code"] : [],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return { clientId: body.client_id };
}

function authorizeUrl(clientId: string, scope = "core.note:read"): string {
  return `${server!.apiUrl}/auth/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope,
    state: "unverified-apps",
    code_challenge: "0123456789012345678901234567890123456789012",
    code_challenge_method: "S256",
  }).toString()}`;
}

/** Where the provider sends the caller: a `302`, or `{ url }` to a program. */
async function sentTo(response: Response): Promise<URL> {
  const where =
    response.status === 302
      ? response.headers.get("location")
      : ((await response.json()) as { url?: string }).url;
  expect(where, `authorize answered ${String(response.status)}`).toBeTruthy();
  return new URL(where ?? "", server!.apiUrl);
}

/** The page a person signed in reads before approving the app. */
async function consentPage(clientId: string, scope?: string): Promise<string> {
  const authorize = await fetch(authorizeUrl(clientId, scope), {
    redirect: "manual",
    headers: { cookie },
  });
  const consent = await sentTo(authorize);
  expect(consent.pathname).toBe("/auth/authorize");
  const page = await fetch(consent, { headers: { cookie } });
  expect(page.status).toBe(200);
  return page.text();
}

/** The sign-in page a person nobody has signed in is sent to by the app. */
async function signInPage(clientId: string): Promise<string> {
  const authorize = await fetch(authorizeUrl(clientId), { redirect: "manual" });
  const signIn = await sentTo(authorize);
  expect(signIn.pathname).toBe("/auth/sign-in");
  const page = await fetch(signIn);
  expect(page.status).toBe(200);
  return page.text();
}

/** The approval page for a code the app asked for on a device. */
async function deviceApprovalPage(
  app: Registered,
  scope = "core.note:read",
): Promise<string> {
  const code = await fetch(`${server!.apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ scope, client_id: app.clientId }),
  });
  expect(code.status).toBe(200);
  const { user_code: userCode } = (await code.json()) as { user_code: string };
  const page = await fetch(
    `${server!.apiUrl}/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
    { headers: { cookie } },
  );
  expect(page.status).toBe(200);
  return page.text();
}

describe("an app a person approves", () => {
  it("is shown with the caution on the consent page", async () => {
    const app = await register("Consent App", ["authorization_code"]);
    const page = visibleText(await consentPage(app.clientId));
    expect(page).toContain("Consent App");
    expect(page).toContain(CAUTION);
  });

  it("is shown with the caution on the sign-in page", async () => {
    const app = await register("Sign-In App", ["authorization_code"]);
    const page = visibleText(await signInPage(app.clientId));
    expect(page).toContain("Sign-In App");
    expect(page).toContain(SIGN_IN_CAUTION);
  });

  it("is shown with the caution on the device approval page", async () => {
    const app = await register("Device App", [DEVICE_GRANT]);
    const page = visibleText(await deviceApprovalPage(app));
    expect(page).toContain("Device App");
    expect(page).toContain(CAUTION);
  });
});

/**
 * What each choice on a page says, by the literal it submits: for a level
 * control, the text after its name, for each level it offers.
 */
function rowLines(html: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const { control, text } of readRows(html)) {
    // Full access or Choose access is how a person answers, not a grant.
    if (control.name === "access") continue;
    const name = control.label ?? "";
    const after = text.slice(text.lastIndexOf(name) + name.length).trim();
    for (const literal of control.tag === "select"
      ? control.options.map((o) => o.value).filter((v) => v !== "")
      : [control.value])
      rows.set(literal, `${name} | ${after}`);
  }
  return rows;
}

describe("a grant a person reads", () => {
  it("is named in the same words on the consent page and the device approval page, reach included", async () => {
    // A type of the person's own, so the wildcard below names one today.
    const registered = await fetch(`${server!.apiUrl}/types`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server!.workingKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "user.conformance_recipe",
        label: "Conformance recipe",
        fields: { title: { type: "string" } },
      }),
    });
    expect(registered.status, await registered.clone().text()).toBe(201);
    const scope = "core.note:read core.note:write user.*:read audit.read";
    const browser = await register("Same Words App", ["authorization_code"]);
    const device = await register("Same Words Device", [DEVICE_GRANT]);
    const consentPageHtml = await consentPage(browser.clientId, scope);
    const consent = rowLines(consentPageHtml);
    const approval = rowLines(await deviceApprovalPage(device, scope));
    expect([...consent.keys()].sort()).toEqual(scope.split(" ").sort());
    expect(Object.fromEntries(approval)).toEqual(Object.fromEntries(consent));
    // The read and the write of one type are one control, with the levels
    // told apart.
    const notes = readControls(consentPageHtml).find(
      (c) => c.tag === "select" && c.label === "Note",
    );
    expect(notes?.options.map((o) => [o.value, o.label])).toEqual([
      ["", "No access"],
      ["core.note:read", "Read only"],
      ["core.note:write", "Read and edit"],
    ]);
    // A wildcard names the types it covers today and says it grows; a
    // grant of one type says no reach beyond it.
    expect(consent.get("user.*:read")).toContain("Conformance recipe");
    expect(consent.get("user.*:read")).toMatch(/later|add/i);
    expect(consent.get("core.note:read")).not.toMatch(/later|today/i);
  });
});
