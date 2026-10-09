import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * The caution the pages a person approves an app on show beside its name.
 * Registration takes no credential, so every app names itself, whichever way
 * it authenticates at the token endpoint. Each case registers one app of each
 * kind over HTTP and reads the page for both: the app that sends no secret is
 * the witness that the page shows the caution at all.
 *
 * Approving needs the owner signed in, and an instance has one owner, so this
 * file boots a server of its own and claims its owner through the production local command.
 */
let server: FreshServer | undefined;
let origin: string;
let cookie: string;

const CALLBACK = "http://127.0.0.1:9/callback";
const CAUTION = "hasn't verified this app";
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

type AuthMethod = "none" | "client_secret_basic";

interface Registered {
  clientId: string;
  clientSecret?: string;
}

/** Registers an app the way any program can: no credential. */
async function register(
  name: string,
  method: AuthMethod,
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
      token_endpoint_auth_method: method,
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    client_id: string;
    client_secret?: string;
    token_endpoint_auth_method: string;
  };
  expect(body.token_endpoint_auth_method).toBe(method);
  if (method === "client_secret_basic") {
    expect(body.client_secret, "registration answered no secret").toBeTruthy();
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
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
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  const form = new URLSearchParams({ scope });
  if (app.clientSecret === undefined) {
    form.set("client_id", app.clientId);
  } else {
    headers.authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`,
    ).toString("base64")}`;
  }
  const code = await fetch(`${server!.apiUrl}/auth/device/code`, {
    method: "POST",
    headers,
    body: form,
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
  it("is shown with the caution on the consent page, whether or not it authenticates with a secret", async () => {
    const grants = ["authorization_code"];
    const open = await register("Open Consent App", "none", grants);
    const secret = await register(
      "Secret Consent App",
      "client_secret_basic",
      grants,
    );
    const openPage = await consentPage(open.clientId);
    expect(openPage).toContain("Open Consent App");
    expect(openPage).toContain(CAUTION);
    const secretPage = await consentPage(secret.clientId);
    expect(secretPage).toContain("Secret Consent App");
    expect(secretPage).toContain(CAUTION);
  });

  it("is shown with the caution on the sign-in page, whether or not it authenticates with a secret", async () => {
    const grants = ["authorization_code"];
    const open = await register("Open Sign-In App", "none", grants);
    const secret = await register(
      "Secret Sign-In App",
      "client_secret_basic",
      grants,
    );
    const openPage = await signInPage(open.clientId);
    expect(openPage).toContain("Open Sign-In App");
    expect(openPage).toContain(CAUTION);
    const secretPage = await signInPage(secret.clientId);
    expect(secretPage).toContain("Secret Sign-In App");
    expect(secretPage).toContain(CAUTION);
  });

  it("is shown with the caution on the device approval page, whether or not it authenticates with a secret", async () => {
    const grants = [DEVICE_GRANT];
    const open = await register("Open Device App", "none", grants);
    const secret = await register(
      "Secret Device App",
      "client_secret_basic",
      grants,
    );
    const openPage = await deviceApprovalPage(open);
    expect(openPage).toContain("Open Device App");
    expect(openPage).toContain(CAUTION);
    const secretPage = await deviceApprovalPage(secret);
    expect(secretPage).toContain("Secret Device App");
    expect(secretPage).toContain(CAUTION);
  });
});

/**
 * The line each toggle row on a page says, by the literal its checkbox
 * submits: the row's label and, where it has one, how far it reaches.
 */
function rowLines(html: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const m of html.matchAll(
    /<div class="subrow"><span>(.*?)<\/span><label class="sw"><input type="checkbox" name="scopes" value="([^"]+)"/g,
  )) {
    rows.set(
      m[2]!,
      m[1]!
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
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
    const browser = await register("Same Words App", "none", [
      "authorization_code",
    ]);
    const device = await register("Same Words Device", "none", [DEVICE_GRANT]);
    const consent = rowLines(await consentPage(browser.clientId, scope));
    const approval = rowLines(await deviceApprovalPage(device, scope));
    expect([...consent.keys()].sort()).toEqual(scope.split(" ").sort());
    expect(Object.fromEntries(approval)).toEqual(Object.fromEntries(consent));
    // The read and the write of one type are told apart.
    expect(consent.get("core.note:read")).not.toBe(
      consent.get("core.note:write"),
    );
    // A wildcard names the types it covers today and says it grows; a
    // grant of one type says no reach beyond it.
    expect(consent.get("user.*:read")).toContain("Conformance recipe");
    expect(consent.get("user.*:read")).toMatch(/later|add/i);
    expect(consent.get("core.note:read")).not.toMatch(/later|today/i);
  });
});
