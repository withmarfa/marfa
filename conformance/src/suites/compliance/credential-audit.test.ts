import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { TEST_OWNER as OWNER } from "../../utils/target.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  authorize,
  authorizeQuery,
  codeFor,
  connect,
  issuerOrigin,
  pkce,
  registerApp,
  signIn,
  token,
} from "../../utils/signed-in.js";

/**
 * The audit record of a change to a credential, and of the security
 * observations the sign-in operations make, read the moment the answer
 * arrives: an answer that came before its record would leave a change no
 * one can account for. Sign-in and consent need the owner, so this file
 * boots a server of its own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;
let management: MarfaClient;

const NOTES = "core.note:read";

beforeAll(async () => {
  server = await bootFreshServer("credential-audit");
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** The audit entries of one action, optionally of one resource. */
async function logged(action: string, resourceId?: string): Promise<number> {
  const page = await management.listAudit({
    action,
    resource_id: resourceId,
    limit: 200,
  });
  expect(page.status, JSON.stringify(page.error)).toBe(200);
  return page.data.data.length;
}

describe("a credential change", () => {
  it("is in the audit log when the mint, the update and the revoke of a key answer", async () => {
    const minted = await management.createKey({
      label: "audited",
      source: "audited",
      permissions: ["audit.read"],
    });
    expect(minted.status).toBe(201);
    expect(await logged("key.create", minted.data.id)).toBe(1);
    expect(
      (await management.updateKey(minted.data.id, { label: "audited-2" }))
        .status,
    ).toBe(200);
    expect(await logged("key.update", minted.data.id)).toBe(1);
    expect((await management.revokeKey(minted.data.id)).status).toBe(200);
    expect(await logged("key.revoke", minted.data.id)).toBe(1);
  });

  it("is in the audit log when a consent, a token and a grant's revocation answer", async () => {
    const consents = await logged("auth.grant.created");
    const tokens = await logged("auth.token.issued");
    const app = await registerApp(server, NOTES);
    await connect(server, origin, cookie, app, NOTES);
    expect(await logged("auth.grant.created")).toBe(consents + 1);
    expect(await logged("auth.token.issued")).toBeGreaterThan(tokens);

    const listed = await fetch(`${server.apiUrl}/auth/grants`, {
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    const grant = (
      (await listed.json()) as { data: { id: string; client_id: string }[] }
    ).data.find((g) => g.client_id === app.clientId);
    expect(grant).toBeDefined();
    const revokes = await logged("auth.grant.revoked");
    const revoked = await fetch(`${server.apiUrl}/auth/grants/${grant!.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    expect(revoked.status).toBe(204);
    expect(await logged("auth.grant.revoked")).toBe(revokes + 1);
  });
});

describe("a sign-in credential", () => {
  it("is in the audit log when a client's registration answers", async () => {
    const before = await logged("auth.oauthClient.create");
    await registerApp(server, NOTES);
    expect(await logged("auth.oauthClient.create")).toBe(before + 1);
  });

  it("is in the audit log when an authorization answers with a code", async () => {
    const app = await registerApp(server, NOTES);
    await codeFor(server, origin, cookie, app, NOTES);
    const before = await logged("auth.verification.create");
    await codeFor(server, origin, cookie, app, NOTES);
    expect(await logged("auth.verification.create")).toBeGreaterThan(before);
  });

  it("is in the audit log when a password sign-in answers", async () => {
    const before = await logged("auth.sign_in.success");
    await signIn(server, origin);
    expect(await logged("auth.sign_in.success")).toBe(before + 1);
  });

  it("is in the audit log when a password change answers", async () => {
    const own = await signIn(server, origin);
    const change = async (from: string, to: string) => {
      const response = await fetch(`${server.apiUrl}/auth/change-password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: own },
        body: JSON.stringify({ currentPassword: from, newPassword: to }),
      });
      await response.body?.cancel();
      return response.status;
    };
    const before = await logged("owner.password.changed");
    const next = `${OWNER.password} changed`;
    expect(await change(OWNER.password, next)).toBe(200);
    expect(await logged("owner.password.changed")).toBe(before + 1);
    expect(await change(next, OWNER.password)).toBe(200);
    // A password change ends every other session, the file's own included.
    cookie = own;
  });

  it("is in the audit log when a profile change answers", async () => {
    const before = await logged("auth.user.update");
    const response = await fetch(`${server.apiUrl}/auth/update-user`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ name: "Audited Owner" }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await logged("auth.user.update")).toBe(before + 1);
  });
});

describe("a grant made or ended without the person asking", () => {
  it("is in the audit log when a device approval answers", async () => {
    const before = await logged("auth.grant.created");
    const flow = await startDeviceFlow(server, [NOTES]);
    await flow.approve();
    expect(await logged("auth.grant.created")).toBe(before + 1);
  });

  it("is in the audit log when the inactivity retirement retires a grant", async () => {
    const app = await registerApp(server, NOTES);
    const issued = await connect(server, origin, cookie, app, NOTES);
    // A year is a long wait, so the grant is aged in place.
    withInstanceDatabase(server.sqlitePath, (db) => {
      const aged = db
        .prepare(
          `UPDATE items SET properties = json_set(properties, '$.granted_at', '2001-01-01T00:00:00.000Z', '$.last_used_at', '2001-01-01T00:00:00.000Z')
           WHERE type = 'system.connection' AND json_extract(properties, '$.client_id') = ?`,
        )
        .run(app.clientId);
      expect(aged.changes).toBe(1);
    });
    const before = await logged("auth.grant.retired");
    const run = await fetch(
      `${server.apiUrl}/housekeeping/grant-inactivity-retirement/run`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${server.managementKey}` },
      },
    );
    expect(run.status, await run.clone().text()).toBe(200);
    expect(await logged("auth.grant.retired")).toBe(before + 1);
    const usable = await fetch(`${server.apiUrl}/items?limit=1`, {
      headers: { authorization: `Bearer ${issued.access_token!}` },
    });
    expect(usable.status, "the retired grant's token still worked").toBe(401);
  });
});

describe("a security observation", () => {
  it("is in the audit log when a request a standing consent covers answers with a code", async () => {
    const app = await registerApp(server, NOTES);
    await codeFor(server, origin, cookie, app, NOTES);
    const before = await logged("auth.grant.reused");
    expect((await codeFor(server, origin, cookie, app, NOTES)).silent).toBe(
      true,
    );
    expect(await logged("auth.grant.reused")).toBe(before + 1);
  });

  it("is in the audit log when the refusal of a failed sign-in answers", async () => {
    const before = await logged("auth.sign_in.failed");
    const failed = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: OWNER.email, password: "not it" }),
    });
    expect(failed.status).toBe(401);
    expect(await logged("auth.sign_in.failed")).toBe(before + 1);
  });

  it("is in the audit log when the refusal of a replayed refresh token answers", async () => {
    const scope = `${NOTES} offline_access`;
    const app = await registerApp(server, scope);
    const first = await connect(server, origin, cookie, app, scope);
    const form = {
      grant_type: "refresh_token",
      client_id: app.clientId,
      refresh_token: first.refresh_token!,
    };
    expect((await token(server, form)).status).toBe(200);
    const before = await logged("auth.refresh.replayed");
    const replayed = await token(server, form);
    expect(replayed.status).toBe(400);
    expect(await logged("auth.refresh.replayed")).toBe(before + 1);
  });

  it("is in the audit log when an authorization narrowed to what can be granted answers", async () => {
    const app = await registerApp(server, NOTES);
    const before = await logged("auth.scopes.narrowed", app.clientId);
    const response = await authorize(
      server,
      authorizeQuery(
        app.clientId,
        `${NOTES} user.nothing_registered_here:read`,
        pkce(),
      ),
      cookie,
    );
    expect([200, 302]).toContain(response.status);
    expect(await logged("auth.scopes.narrowed", app.clientId)).toBe(before + 1);
    // The witness: a request nothing narrows records no such entry.
    await codeFor(server, origin, cookie, app, NOTES);
    expect(await logged("auth.scopes.narrowed", app.clientId)).toBe(before + 1);
  });
});
