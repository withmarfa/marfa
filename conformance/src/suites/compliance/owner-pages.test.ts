import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";
import { sessionCookieOf as sessionCookie } from "../../client/owner-session.js";

/**
 * What a signed-in owner's browser can do: see who is signed in at the root,
 * and change the password from the passkeys page. Each case that signs in or
 * sends a password takes an address of its own, so the per-address sign-in
 * limit never holds another case back. A case that changes the password
 * changes it back before it ends.
 */
let server: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";
const NEW_PASSWORD = "a different long password";
let addresses = 0;

beforeAll(async () => {
  server = await bootFreshServer("owner-pages", {
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

function passwordSignIn(
  password: string,
  address = nextAddress(),
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: address,
    },
    body: JSON.stringify({ email: TEST_OWNER.email, password }),
  });
}

async function signIn(password = TEST_OWNER.password): Promise<string> {
  const response = await passwordSignIn(password);
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return cookie!;
}

function change(
  body: Record<string, unknown>,
  cookie: string | undefined,
  options: {
    address?: string;
    headers?: Record<string, string>;
    form?: boolean;
  } = {},
): Promise<Response> {
  const form = options.form ?? false;
  return fetch(`${server.apiUrl}/auth/owner/password`, {
    method: "POST",
    headers: {
      "content-type": form
        ? "application/x-www-form-urlencoded"
        : "application/json",
      origin,
      [CLIENT_HEADER]: options.address ?? nextAddress(),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
    body: form
      ? new URLSearchParams(body as Record<string, string>)
      : JSON.stringify(body),
  });
}

/** The passkey page's list is a door a session counts on, so it says whether the session lives. */
async function lives(cookie: string): Promise<boolean> {
  const response = await fetch(`${server.apiUrl}/owner/passkeys`, {
    headers: { cookie, [CLIENT_HEADER]: nextAddress() },
  });
  await response.body?.cancel();
  return response.status === 200;
}

/** Whether `password` signs in now. */
async function signsIn(password: string): Promise<boolean> {
  const response = await passwordSignIn(password);
  await response.body?.cancel();
  expect([200, 401]).toContain(response.status);
  return response.status === 200;
}

async function code(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

interface AuditEntry {
  resource_type: string;
  details: Record<string, unknown> | null;
}

/** The audit log's entries of one action, newest first. */
async function audited(action: string): Promise<AuditEntry[]> {
  const response = await fetch(
    `${server.apiUrl}/audit?${new URLSearchParams({ action, limit: "200" })}`,
    { headers: { authorization: `Bearer ${server.managementKey}` } },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: AuditEntry[] }).data;
}

function rootPage(cookie?: string): Promise<Response> {
  return fetch(`${server.apiUrl}/`, {
    headers: {
      accept: "text/html",
      [CLIENT_HEADER]: nextAddress(),
      ...(cookie ? { cookie } : {}),
    },
  });
}

describe("the root in a browser", () => {
  it("names the signed-in owner at the root, with the passkeys page and sign-out, and asks anyone else to sign in", async () => {
    const signedOut = await rootPage();
    expect(signedOut.status).toBe(200);
    const nobody = await signedOut.text();
    expect(nobody).toContain('href="/auth/sign-in"');
    expect(nobody).not.toContain(TEST_OWNER.email);

    const cookie = await signIn();
    const signedIn = await rootPage(cookie);
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("content-type")).toContain("text/html");
    const owner = await signedIn.text();
    expect(owner).toContain(TEST_OWNER.email);
    expect(owner).toContain('href="/auth/owner/passkeys"');
    expect(owner).toMatch(/<form[^>]*action="\/auth\/sign-out"/);
    expect(owner).not.toContain('href="/auth/sign-in"');

    // A program asking with the same cookie is still handed the description.
    const described = await fetch(`${server.apiUrl}/`, {
      headers: { cookie, [CLIENT_HEADER]: nextAddress() },
    });
    expect(described.status).toBe(200);
    const description = (await described.json()) as Record<string, unknown>;
    expect(description.name).toBeTypeOf("string");
    expect(JSON.stringify(description)).not.toContain(TEST_OWNER.email);

    const out = await fetch(`${server.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin, [CLIENT_HEADER]: nextAddress() },
    });
    expect(out.status).toBe(200);
    const ended = await (await rootPage(cookie)).text();
    expect(ended).toContain('href="/auth/sign-in"');
    expect(ended).not.toContain(TEST_OWNER.email);
  });

  it("sends a signed-in browser no cookie from the root", async () => {
    const cookie = await signIn();
    // Past the minute after which a counted use of the session sends its cookie again.
    await server.advanceClock(2 * 60 * 1000);
    const page = await rootPage(cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(TEST_OWNER.email);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await lives(cookie)).toBe(true);
  });
});

describe("changing the password", () => {
  it("changes the password, so the new one signs in and the old one does not", async () => {
    const here = await signIn();
    const elsewhere = await signIn();
    const changed = await change(
      { current_password: TEST_OWNER.password, new_password: NEW_PASSWORD },
      here,
    );
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await changed.json()).toEqual({ ok: true });
    const sent = sessionCookie(changed);
    expect(sent === undefined || sent === here).toBe(true);

    expect(await lives(here)).toBe(true);
    expect(await lives(elsewhere)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(false);
    expect(await signsIn(NEW_PASSWORD)).toBe(true);

    // The page's form changes it back.
    const back = await change(
      { current_password: NEW_PASSWORD, new_password: TEST_OWNER.password },
      here,
      { form: true },
    );
    expect(back.status, await back.clone().text()).toBe(200);
    expect(await lives(here)).toBe(true);
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("answers a wrong current password 401 and changes nothing", async () => {
    const here = await signIn();
    const elsewhere = await signIn();
    const wrong = await change(
      { current_password: "not the password", new_password: NEW_PASSWORD },
      here,
    );
    expect(wrong.status).toBe(401);
    expect(await code(wrong)).toBe("unauthorized");
    expect(await lives(here)).toBe(true);
    expect(await lives(elsewhere)).toBe(true);
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("counts a wrong current password where a password sign-in counts, and refuses a locked owner with the wait", async () => {
    const here = await signIn();
    const address = nextAddress();
    // Ten attempts from one address spend the window, whichever door they came by.
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await change(
        { current_password: "wrong one", new_password: NEW_PASSWORD },
        here,
        { address },
      );
      expect(wrong.status).toBe(401);
      const direct = await passwordSignIn("wrong two", address);
      expect(direct.status).toBe(401);
    }
    const locked = await change(
      { current_password: TEST_OWNER.password, new_password: NEW_PASSWORD },
      here,
      { address },
    );
    expect(locked.status).toBe(429);
    expect(await code(locked)).toBe("rate_limited");
    const wait = Number(locked.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);

    // The sign-in door is held by the same lane, with no longer a wait.
    const held = await passwordSignIn(TEST_OWNER.password, address);
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeLessThanOrEqual(wait);

    // Nothing changed, and another address is not held by it.
    expect(await lives(here)).toBe(true);
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("refuses a new password the claim would refuse, and one with no current password, and keeps the password", async () => {
    const here = await signIn();
    const refusals: [Record<string, string>, string | undefined][] = [
      [
        { current_password: TEST_OWNER.password, new_password: "short" },
        "new_password",
      ],
      [
        {
          current_password: TEST_OWNER.password,
          new_password: "x".repeat(129),
        },
        "new_password",
      ],
      [{ current_password: "", new_password: NEW_PASSWORD }, undefined],
      [{ new_password: NEW_PASSWORD }, undefined],
      [{ current_password: TEST_OWNER.password }, undefined],
    ];
    for (const [body, path] of refusals) {
      const refused = await change(body, here);
      expect(refused.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      const error = (
        (await refused.json()) as {
          error: { code: string; details?: { errors?: { path: string }[] } };
        }
      ).error;
      expect(error.code).toBe("validation_error");
      if (path) {
        expect(error.details?.errors?.map((e) => e.path)).toEqual([path]);
      }
    }
    expect(await lives(here)).toBe(true);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("refuses a change with no session, an ended session and a key, 401", async () => {
    const body = {
      current_password: TEST_OWNER.password,
      new_password: NEW_PASSWORD,
    };
    const none = await change(body, undefined);
    expect(none.status).toBe(401);
    expect(await code(none)).toBe("unauthorized");

    const ended = await signIn();
    const out = await fetch(`${server.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: { cookie: ended, origin, [CLIENT_HEADER]: nextAddress() },
    });
    expect(out.status).toBe(200);
    const gone = await change(body, ended);
    expect(gone.status).toBe(401);

    const here = await signIn();
    const keyed = await change(body, here, {
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    expect(keyed.status).toBe(401);
    expect(await code(keyed)).toBe("unauthorized");
    expect(await lives(here)).toBe(true);

    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("refuses a change from another origin and from none, 403", async () => {
    const here = await signIn();
    const body = {
      current_password: TEST_OWNER.password,
      new_password: NEW_PASSWORD,
    };
    const away = await change(body, here, {
      headers: { origin: "https://elsewhere.example" },
    });
    expect(away.status).toBe(403);
    expect(await code(away)).toBe("forbidden");

    const unnamed = await fetch(`${server.apiUrl}/auth/owner/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: here,
        [CLIENT_HEADER]: nextAddress(),
      },
      body: JSON.stringify(body),
    });
    expect(unnamed.status).toBe(403);

    expect(await lives(here)).toBe(true);
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("records a change in the audit log", async () => {
    const here = await signIn();
    const before = await audited("owner.password.changed");
    const changed = await change(
      { current_password: TEST_OWNER.password, new_password: NEW_PASSWORD },
      here,
    );
    expect(changed.status).toBe(200);
    const after = await audited("owner.password.changed");
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.resource_type).toBe("owner");

    const back = await change(
      { current_password: NEW_PASSWORD, new_password: TEST_OWNER.password },
      here,
    );
    expect(back.status).toBe(200);
    expect(await audited("owner.password.changed")).toHaveLength(
      before.length + 2,
    );
  });

  it("records a refused change in the audit log as a refused password sign-in, with its reason", async () => {
    const here = await signIn();
    const failed = "auth.sign_in.failed";
    const before = (await audited(failed)).length;
    const wrong = await change(
      { current_password: "not the password", new_password: NEW_PASSWORD },
      here,
    );
    expect(wrong.status).toBe(401);
    const refused = await audited(failed);
    expect(refused).toHaveLength(before + 1);
    expect(refused[0]?.resource_type).toBe("owner");
    expect(refused[0]?.details).toMatchObject({
      method: "password",
      reason: "invalid_credentials",
    });

    const address = nextAddress();
    for (let attempt = 0; attempt < 10; attempt++) {
      const spent = await change(
        { current_password: "wrong again", new_password: NEW_PASSWORD },
        here,
        { address },
      );
      expect(spent.status).toBe(401);
    }
    const locked = await change(
      { current_password: TEST_OWNER.password, new_password: NEW_PASSWORD },
      here,
      { address },
    );
    expect(locked.status).toBe(429);
    const held = await audited(failed);
    expect(held).toHaveLength(before + 12);
    expect(held[0]?.resource_type).toBe("owner");
    expect(held[0]?.details).toMatchObject({
      method: "password",
      reason: "too_many_attempts",
    });
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });
});
