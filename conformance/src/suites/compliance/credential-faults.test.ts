import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { issuerOrigin, signIn } from "../../utils/signed-in.js";

/**
 * A change to a credential the database cannot carry out or account for: a
 * browser sign-out and a key's mint, update and revoke. The fault is a table
 * moved aside in the database of a server of the fixture's own, and put back
 * before the change is asked again.
 */
let server: FreshServer;
let origin: string;

beforeAll(async () => {
  server = await bootFreshServer("credential-faults");
  origin = await issuerOrigin(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function signOut(cookie: string): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: "{}",
  });
}

async function signedIn(cookie: string): Promise<boolean> {
  const response = await fetch(`${server.apiUrl}/auth/get-session`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) !== null;
}

/** Whether an answer tells the browser to drop its session cookie. */
function clearsSession(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .some((c) => /session_token=;|session_token=.*max-age=0/i.test(c));
}

/** Runs `during` with `table` moved aside, and puts it back. */
async function without<T>(
  table: string,
  during: () => Promise<T>,
): Promise<T> {
  withInstanceDatabase(server.sqlitePath, (db) =>
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_aside`),
  );
  try {
    return await during();
  } finally {
    withInstanceDatabase(server.sqlitePath, (db) =>
      db.exec(`ALTER TABLE ${table}_aside RENAME TO ${table}`),
    );
  }
}

describe("a browser sign-out", () => {
  it("that cannot look its session up answers 500 and clears no cookie, and a retry signs out", async () => {
    const cookie = await signIn(server, origin);
    const refused = await without("auth_session", () => signOut(cookie));
    expect(refused.status).toBe(500);
    expect(clearsSession(refused)).toBe(false);
    expect(await signedIn(cookie)).toBe(true);

    const retried = await signOut(cookie);
    expect(retried.status).toBe(200);
    expect(clearsSession(retried)).toBe(true);
    expect(await signedIn(cookie)).toBe(false);
  });

  it("whose end cannot be audited answers 500 and leaves the session signed in, and a retry signs out", async () => {
    const cookie = await signIn(server, origin);
    const refused = await without("audit_log", () => signOut(cookie));
    expect(refused.status).toBe(500);
    expect(clearsSession(refused)).toBe(false);
    expect(await signedIn(cookie)).toBe(true);

    const retried = await signOut(cookie);
    expect(retried.status).toBe(200);
    expect(await signedIn(cookie)).toBe(false);
  });
});

describe("a key change", () => {
  it("refuses a key change whose audit record cannot be committed, and leaves the key as it was", async () => {
    const management = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    });
    const target = await management.createKey({
      label: "faulted",
      source: "faulted",
      permissions: ["audit.read"],
    });
    expect(target.status).toBe(201);

    const [minted, updated, revoked] = await without("audit_log", async () => [
      await management.createKey({
        label: "faulted-mint",
        source: "faulted-mint",
        permissions: ["audit.read"],
      }),
      await management.updateKey(target.data.id, { label: "faulted-renamed" }),
      await management.revokeKey(target.data.id),
    ]);
    for (const refused of [minted, updated, revoked]) {
      expect(refused.status).toBe(500);
    }
    const listed = (await management.listKeys()).data.data;
    expect(listed.some((k) => k.label === "faulted-mint")).toBe(false);
    expect(listed.find((k) => k.id === target.data.id)?.label).toBe("faulted");
    const bearer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: target.data.key,
    });
    expect((await bearer.getCurrentKey()).status).toBe(200);
    // The witness: with its log back, the same revoke takes effect.
    expect((await management.revokeKey(target.data.id)).status).toBe(200);
    expect((await bearer.getCurrentKey()).status).toBe(401);
  });
});
