import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";
import { sessionCookieOf as sessionCookie } from "../../client/owner-session.js";

/**
 * Replacing the owner's password with a key, an app's token or the private
 * local command, none of which has a browser session. The owner's whole state
 * is the subject, so the file boots a server of its own, and each case that
 * replaces the password replaces it back before it ends. Each case that sends
 * a password takes an address of its own, so the per-address limit never holds
 * another case back.
 */
let server: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";
const NEW_PASSWORD = "a different long password";
let addresses = 0;
let minted = 0;

beforeAll(async () => {
  server = await bootFreshServer("owner-password", {
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
  });
  origin = await issuerOrigin(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function nextAddress(): string {
  addresses += 1;
  return `203.0.113.${String(addresses)}`;
}

async function mint(permissions: string[]): Promise<string> {
  minted += 1;
  const answer = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: `owner password ${String(minted)}`,
      source: `owner-password-${String(minted)}`,
      permissions,
    },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return (answer.body as { key: string }).key;
}

/** `PUT /owner/password` with a credential, from an address of its own. */
function replace(
  credential: string,
  body: unknown,
  address = nextAddress(),
): Promise<Response> {
  return fetch(`${server.apiUrl}/owner/password`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      [CLIENT_HEADER]: address,
    },
    body: JSON.stringify(body),
  });
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

async function signIn(): Promise<string> {
  const response = await passwordSignIn(TEST_OWNER.password);
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return cookie!;
}

/** Whether `password` signs in now. */
async function signsIn(password: string): Promise<boolean> {
  const response = await passwordSignIn(password);
  await response.body?.cancel();
  expect([200, 401]).toContain(response.status);
  return response.status === 200;
}

/** The passkey page's list is a door a session counts on, so it says whether the session lives. */
async function lives(cookie: string): Promise<boolean> {
  const response = await fetch(`${server.apiUrl}/owner/passkeys`, {
    headers: { cookie, [CLIENT_HEADER]: nextAddress() },
  });
  await response.body?.cancel();
  return response.status === 200;
}

async function code(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

async function status(credential: string, path: string): Promise<number> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    headers: {
      authorization: `Bearer ${credential}`,
      [CLIENT_HEADER]: nextAddress(),
    },
  });
  await response.body?.cancel();
  return response.status;
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

const FORWARD = {
  current_password: TEST_OWNER.password,
  new_password: NEW_PASSWORD,
};
const BACK = {
  current_password: NEW_PASSWORD,
  new_password: TEST_OWNER.password,
};

describe("replacing the password with a credential", () => {
  it("replaces the password through a key holding sign_ins.manage, so the new one signs in and the old one does not", async () => {
    const key = await mint(["sign_ins.manage"]);
    const replaced = await replace(key, FORWARD);
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    const body: unknown = await replaced.json();
    expect(body).toEqual({ ok: true });
    await expectMatchesSchema("PUT", "/owner/password", 200, body);
    expect(await signsIn(TEST_OWNER.password)).toBe(false);
    expect(await signsIn(NEW_PASSWORD)).toBe(true);

    const back = await replace(key, BACK);
    expect(back.status, await back.clone().text()).toBe(200);
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("replaces the password through the private local command with the current password", async () => {
    const replaced = await controlRequest(
      server.controlSocket,
      "/owner/password",
      { method: "PUT", body: FORWARD },
    );
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body).toEqual({ ok: true });
    expect(await signsIn(TEST_OWNER.password)).toBe(false);
    expect(await signsIn(NEW_PASSWORD)).toBe(true);

    // The witness: the socket is held to the current password too.
    const wrong = await controlRequest(
      server.controlSocket,
      "/owner/password",
      { method: "PUT", body: FORWARD },
    );
    expect(wrong.status).toBe(401);
    expect(await signsIn(NEW_PASSWORD)).toBe(true);

    const back = await controlRequest(server.controlSocket, "/owner/password", {
      method: "PUT",
      body: BACK,
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("ends every browser session when a key replaces the password, and keeps keys and apps", async () => {
    const key = await mint(["sign_ins.manage"]);
    const app = await approvedApp(server, ["sign_ins.manage"]);
    const here = await signIn();
    const elsewhere = await signIn();
    expect(await lives(here)).toBe(true);
    expect(await lives(elsewhere)).toBe(true);
    expect(await status(key, "/owner/sign-ins")).toBe(200);
    expect(await status(app.token, "/owner/sign-ins")).toBe(200);

    const replaced = await replace(key, FORWARD);
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    expect(await lives(here)).toBe(false);
    expect(await lives(elsewhere)).toBe(false);
    expect(await status(key, "/owner/sign-ins")).toBe(200);
    expect(await status(app.token, "/owner/sign-ins")).toBe(200);

    const back = await replace(key, BACK);
    expect(back.status, await back.clone().text()).toBe(200);
  });

  it("refuses a new password the claim would refuse, and a body without both passwords, and keeps the password", async () => {
    const key = await mint(["sign_ins.manage"]);
    const refusals: [Record<string, string>, string, string | undefined][] = [
      [
        { current_password: TEST_OWNER.password, new_password: "short" },
        "validation_error",
        "new_password",
      ],
      [
        {
          current_password: TEST_OWNER.password,
          new_password: "x".repeat(129),
        },
        "validation_error",
        "new_password",
      ],
      [
        { current_password: "", new_password: NEW_PASSWORD },
        "validation_error",
        undefined,
      ],
      [{ new_password: NEW_PASSWORD }, "missing_required_field", undefined],
      [
        { current_password: TEST_OWNER.password },
        "missing_required_field",
        undefined,
      ],
    ];
    for (const [body, expected, path] of refusals) {
      const refused = await replace(key, body);
      expect(refused.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      const error = (
        (await refused.json()) as {
          error: { code: string; details?: { errors?: { path: string }[] } };
        }
      ).error;
      expect(error.code).toBe(expected);
      if (path) {
        expect(error.details?.errors?.map((e) => e.path)).toEqual([path]);
      }
    }
    const extra = await replace(key, { ...FORWARD, email: "a@example.test" });
    expect(extra.status).toBe(400);
    expect(await code(extra)).toBe("validation_error");
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("answers a wrong current password 401, records it as a refused password sign-in and changes nothing", async () => {
    // Past any lockout an earlier case recorded.
    await server.advanceClock(15 * 60 * 1000);
    const key = await mint(["sign_ins.manage"]);
    const here = await signIn();
    const failed = "auth.sign_in.failed";
    const before = (await audited(failed)).length;
    const wrong = await replace(key, {
      current_password: "not the password",
      new_password: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(401);
    expect(await code(wrong)).toBe("unauthorized");
    const refused = await audited(failed);
    expect(refused).toHaveLength(before + 1);
    expect(refused[0]?.resource_type).toBe("owner");
    expect(refused[0]?.details).toMatchObject({
      method: "password",
      reason: "invalid_credentials",
    });
    expect(await lives(here)).toBe(true);
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("counts a wrong current password where a password sign-in counts, and refuses a locked owner with the wait", async () => {
    await server.advanceClock(15 * 60 * 1000);
    const key = await mint(["sign_ins.manage"]);
    const address = nextAddress();
    // Ten attempts from one address spend the window, whichever door they came by.
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await replace(
        key,
        { current_password: "wrong one", new_password: NEW_PASSWORD },
        address,
      );
      expect(wrong.status).toBe(401);
      const direct = await passwordSignIn("wrong two", address);
      expect(direct.status).toBe(401);
    }
    const locked = await replace(key, FORWARD, address);
    expect(locked.status).toBe(429);
    expect(await code(locked)).toBe("rate_limited");
    const wait = Number(locked.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);

    // The sign-in door is held by the same lane, with no longer a wait.
    const held = await passwordSignIn(TEST_OWNER.password, address);
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeLessThanOrEqual(wait);

    // Nothing changed, and another address is not held by it.
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });

  it("records a replacement in the audit log", async () => {
    const key = await mint(["sign_ins.manage"]);
    const before = await audited("owner.password.changed");
    const replaced = await replace(key, FORWARD);
    expect(replaced.status).toBe(200);
    const after = await audited("owner.password.changed");
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.resource_type).toBe("owner");
    const back = await replace(key, BACK);
    expect(back.status).toBe(200);
  });

  it("refuses a key without sign_ins.manage, naming the permission, and keeps the password", async () => {
    // The witness: a key that holds the permission is not refused.
    const holder = await mint(["sign_ins.manage"]);
    expect(await status(holder, "/owner/sign-ins")).toBe(200);
    const others = await mint(["audit.read", "instance.read"]);
    const refused = await replace(others, FORWARD);
    expect(refused.status).toBe(403);
    const error = (
      (await refused.json()) as {
        error: { code: string; details?: { required_scope?: string } };
      }
    ).error;
    expect(error.code).toBe("forbidden");
    expect(error.details?.required_scope).toBe("sign_ins.manage");
    const none = await fetch(`${server.apiUrl}/owner/password`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [CLIENT_HEADER]: nextAddress(),
      },
      body: JSON.stringify(FORWARD),
    });
    expect(none.status).toBe(401);
    expect(await signsIn(NEW_PASSWORD)).toBe(false);
    expect(await signsIn(TEST_OWNER.password)).toBe(true);
  });
});
