import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  authorize,
  authorizeQuery,
  connect,
  issuerOrigin,
  itemsStatus,
  pkce,
  registerApp,
  sentTo,
  signIn,
} from "../../utils/signed-in.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import type { SseEvent } from "../../utils/sse.js";

/**
 * A change to a credential the database cannot carry out or account for: a
 * browser sign-out, a key's mint, update and revoke, a consent and a grant's
 * withdrawal. The fault is a table moved aside, or a trigger that refuses a
 * delete, in the database of a server of the fixture's own, removed before
 * the change is asked again.
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
async function without<T>(table: string, during: () => Promise<T>): Promise<T> {
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

  it("that cannot delete its session answers 500 and clears no cookie, and a retry signs out", async () => {
    const cookie = await signIn(server, origin);
    withInstanceDatabase(server.sqlitePath, (db) =>
      db.exec(
        "CREATE TRIGGER keep_sessions BEFORE DELETE ON auth_session BEGIN SELECT RAISE(ABORT, 'kept'); END",
      ),
    );
    let refused: Response;
    try {
      refused = await signOut(cookie);
    } finally {
      withInstanceDatabase(server.sqlitePath, (db) =>
        db.exec("DROP TRIGGER keep_sessions"),
      );
    }
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

const NOTES = "core.note:read";

/** The grants `GET /auth/grants` lists, by client. */
async function grantFor(clientId: string): Promise<string | undefined> {
  const response = await fetch(`${server.apiUrl}/auth/grants`, {
    headers: { authorization: `Bearer ${server.managementKey}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { id: string; client_id: string }[];
  };
  return body.data.find((g) => g.client_id === clientId)?.id;
}

/** A person's decision on the consent screen, answered as it came. */
function accept(cookie: string, consent: URL): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/authorize/decision`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([
      ["accept", "true"],
      ["oauth_query", consent.search.slice(1)],
      ["scopes", NOTES],
    ]),
  });
}

/** Whether a frame announces a grant's projection for `clientId`. */
function announcesGrant(event: SseEvent, clientId: string): boolean {
  const item = (
    event.data as {
      item?: { type?: string; properties?: { client_id?: string } };
    }
  )?.item;
  return (
    item?.type === "system.connection" &&
    item.properties?.client_id === clientId
  );
}

/** A note written as the stream's sentinel, and its id. */
async function sentinel(): Promise<string> {
  const response = await fetch(`${server.apiUrl}/items`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "core.note",
      properties: { body: "sentinel" },
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { item: { id: string } }).item.id;
}

describe("a consent", () => {
  it("whose audit record cannot be committed grants nothing and publishes no event", async () => {
    const cookie = await signIn(server, origin);
    await withStream(server.apiUrl, server.workingKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      // The witness: an accepted consent announces its grant on this stream.
      const shown = await registerApp(server, NOTES);
      const shownConsent = await sentTo(
        server,
        await authorize(
          server,
          authorizeQuery(shown.clientId, NOTES, pkce()),
          cookie,
        ),
      );
      expect((await accept(cookie, shownConsent!)).status).toBe(302);
      await collectUntil(
        stream,
        (events) => events.some((e) => announcesGrant(e, shown.clientId)),
        "the accepted consent's grant",
      );

      const app = await registerApp(server, NOTES);
      const consent = await sentTo(
        server,
        await authorize(
          server,
          authorizeQuery(app.clientId, NOTES, pkce()),
          cookie,
        ),
      );
      expect(consent?.pathname).toBe("/auth/authorize");
      const refused = await without("audit_log", () =>
        accept(cookie, consent!),
      );
      expect(refused.status).toBe(500);
      const marker = await sentinel();
      const { events } = await collectUntil(
        stream,
        (seen) =>
          seen.some(
            (e) => (e.data as { item?: { id?: string } })?.item?.id === marker,
          ),
        "the sentinel note",
      );
      expect(events.some((e) => announcesGrant(e, app.clientId))).toBe(false);
      expect(await grantFor(app.clientId)).toBeUndefined();
      const again = await sentTo(
        server,
        await authorize(
          server,
          authorizeQuery(app.clientId, NOTES, pkce()),
          cookie,
        ),
      );
      expect(again?.pathname, "a refused consent stood").toBe(
        "/auth/authorize",
      );
    });
  });
});

describe("a grant's withdrawal", () => {
  it("whose audit record cannot be committed answers 500 and leaves the grant and its tokens", async () => {
    const cookie = await signIn(server, origin);
    const app = await registerApp(server, NOTES);
    const issued = await connect(server, origin, cookie, app, NOTES);
    const grant = await grantFor(app.clientId);
    expect(grant).toBeDefined();
    const withdraw = () =>
      fetch(`${server.apiUrl}/auth/grants/${grant!}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${server.managementKey}` },
      });
    const refused = await without("audit_log", withdraw);
    expect(refused.status).toBe(500);
    expect(await grantFor(app.clientId)).toBe(grant);
    expect(await itemsStatus(server, issued.access_token!)).toBe(200);
    // The witness: with its log back, the same withdrawal takes effect.
    expect((await withdraw()).status).toBe(204);
    expect(await itemsStatus(server, issued.access_token!)).toBe(401);
  });
});
