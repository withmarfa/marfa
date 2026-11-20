import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { TEST_OWNER as OWNER } from "../../utils/target.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  HOUR_MS,
  movedClock,
  QUIET_SCHEDULE,
  runJob,
} from "../../utils/moved-clock.js";
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
  server = await bootFreshServer("credential-audit", QUIET_SCHEDULE);
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

    const listed = await fetch(`${server.apiUrl}/grants`, {
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    const grant = (
      (await listed.json()) as { data: { id: string; client_id: string }[] }
    ).data.find((g) => g.client_id === app.clientId);
    expect(grant).toBeDefined();
    const revokes = await logged("auth.grant.revoked");
    const revoked = await fetch(`${server.apiUrl}/grants/${grant!.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    expect(revoked.status).toBe(200);
    expect(await logged("auth.grant.revoked")).toBe(revokes + 1);
  });
});

describe("a sign-in credential", () => {
  it("is in the audit log when a client's registration answers", async () => {
    const before = await logged("auth.client.created");
    await registerApp(server, NOTES);
    expect(await logged("auth.client.created")).toBe(before + 1);
  });

  it("is in the audit log when an authorization answers with a code", async () => {
    const app = await registerApp(server, NOTES);
    await codeFor(server, origin, cookie, app, NOTES);
    const before = await logged("auth.code.issued");
    await codeFor(server, origin, cookie, app, NOTES);
    expect(await logged("auth.code.issued")).toBeGreaterThan(before);
  });

  it("is in the audit log when a password sign-in answers", async () => {
    const before = await logged("auth.sign_in.success");
    await signIn(server, origin);
    expect(await logged("auth.sign_in.success")).toBe(before + 1);
  });
});

describe("a grant made or ended without the person asking", () => {
  it("is in the audit log when a device approval answers", async () => {
    const before = await logged("auth.grant.created");
    const flow = await startDeviceFlow(server, [NOTES]);
    await flow.approve();
    expect(await logged("auth.grant.created")).toBe(before + 1);
  });
});

describe("a sign-in's audit entry", () => {
  it("names the owner as the resource of a sign-in and its refusal, and the sign-in as the resource of its end", async () => {
    const count = async (action: string, resourceType: string) => {
      const page = await management.listAudit({
        action,
        resource_type: resourceType,
        limit: 200,
      });
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      return page.data.data.length;
    };
    const failedBefore = await count("auth.sign_in.failed", "owner");
    const signedBefore = await count("auth.sign_in.success", "owner");
    const endedBefore = await count("auth.sign_in.ended", "sign_in");

    const failed = await fetch(`${server.apiUrl}/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ username: OWNER.username, password: "not it" }),
    });
    expect(failed.status).toBe(401);
    const session = await signIn(server, origin);
    const ended = await fetch(`${server.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: session },
      body: "{}",
    });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ ok: true });

    expect(await count("auth.sign_in.failed", "owner")).toBe(failedBefore + 1);
    expect(await count("auth.sign_in.success", "owner")).toBe(signedBefore + 1);
    expect(await count("auth.sign_in.ended", "sign_in")).toBe(endedBefore + 1);
    // The filter narrows: no sign-in entry is filed under another resource.
    expect(await count("auth.sign_in.ended", "owner")).toBe(0);
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
    const failed = await fetch(`${server.apiUrl}/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ username: OWNER.username, password: "not it" }),
    });
    expect(failed.status).toBe(401);
    expect(await logged("auth.sign_in.failed")).toBe(before + 1);
    const rows = await new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    }).listAudit({ action: "auth.sign_in.failed", limit: 1 });
    expect(rows.data.data[0]?.actor).toBeNull();
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

/**
 * Last in the file, because moving the server's clock a year ends every
 * sign-in token and owner session made before it.
 */
describe("a grant retired for inactivity", () => {
  it("is in the audit log when the inactivity retirement retires a grant", async () => {
    const app = await registerApp(server, NOTES);
    await connect(server, origin, cookie, app, NOTES);
    const grantsOf = async (): Promise<string[]> => {
      const listed = await fetch(`${server.apiUrl}/grants`, {
        headers: { authorization: `Bearer ${server.managementKey}` },
      });
      expect(listed.status).toBe(200);
      return (
        (await listed.json()) as { data: { client_id: string }[] }
      ).data.map((g) => g.client_id);
    };
    expect(await grantsOf()).toContain(app.clientId);
    expect(await logged("auth.grant.retired", app.clientId)).toBe(0);

    // Earlier grants are also idle after the move, so identify this client's
    // audit entry rather than counting every retirement.
    await movedClock(server).advance(366 * DAY_MS);
    // The scheduler finds the job due after the move and may be running it.
    expect((await runJob(server, "credential-cleanup")).outcome).toBe(
      "succeeded",
    );
    expect(await logged("auth.grant.retired", app.clientId)).toBe(1);
    expect(await grantsOf()).not.toContain(app.clientId);
  });
});

/**
 * After the retirement above, which moved the clock a year and ended every
 * owner session: each purge moves it on again from there, so a case signs in
 * afresh and counts only what its own run added.
 */
describe("a credential the clean-up removes", () => {
  it("is in the audit log as keys.purged when the clean-up removes a key revoked long ago", async () => {
    const minted = await management.createKey({
      label: "purged",
      source: "audit-keys-purged",
      permissions: ["audit.read"],
    });
    expect(minted.status).toBe(201);
    expect((await management.revokeKey(minted.data.id)).status).toBe(200);
    const before = await logged("keys.purged");

    // Inside the thirty days a revoked key is kept: the witness that the run is not
    // what writes the entry.
    await movedClock(server).advance(2 * DAY_MS);
    expect((await runJob(server, "credential-cleanup")).outcome).toBe(
      "succeeded",
    );
    expect(await logged("keys.purged")).toBe(before);

    await movedClock(server).advance(29 * DAY_MS);
    expect((await runJob(server, "credential-cleanup")).outcome).toBe(
      "succeeded",
    );
    expect(await logged("keys.purged")).toBe(before + 1);
  });

  it("is in the audit log as auth.clients.purged when the clean-up removes a client that holds no grant", async () => {
    await registerApp(server, NOTES);
    const before = await logged("auth.clients.purged");
    await movedClock(server).advance(2 * HOUR_MS);
    expect((await runJob(server, "credential-cleanup")).outcome).toBe(
      "succeeded",
    );
    expect(await logged("auth.clients.purged")).toBeGreaterThan(before);
  });

  it("is in the audit log as auth.grants.purged when the clean-up removes a grant revoked long ago", async () => {
    cookie = await signIn(server, origin);
    const app = await registerApp(server, NOTES);
    await connect(server, origin, cookie, app, NOTES);
    const listed = await fetch(`${server.apiUrl}/grants`, {
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    const grant = (
      (await listed.json()) as { data: { id: string; client_id: string }[] }
    ).data.find((g) => g.client_id === app.clientId);
    expect(grant).toBeDefined();
    const revoked = await fetch(`${server.apiUrl}/grants/${grant!.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    expect(revoked.status).toBe(200);
    const before = await logged("auth.grants.purged");

    // Inside the retention a revoked grant is kept.
    await movedClock(server).advance(30 * DAY_MS);
    expect((await runJob(server, "credential-cleanup")).outcome).toBe(
      "succeeded",
    );
    expect(await logged("auth.grants.purged")).toBe(before);

    await movedClock(server).advance(70 * DAY_MS);
    expect((await runJob(server, "credential-cleanup")).outcome).toBe(
      "succeeded",
    );
    expect(await logged("auth.grants.purged")).toBeGreaterThan(before);
  });
});
