import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * Two refusals of the doors that serve signed-in apps and are not in the
 * published document: revoking a grant nobody holds, and approving a device
 * code for a client that is gone.
 *
 * Each needs the instance's owner, who is created once per instance, so each
 * has a server of its own.
 */
let grants: FreshServer | undefined;
let clients: FreshServer | undefined;

const OWNER = { email: "owner@example.com", password: "correct horse battery" };
const FORM = { "content-type": "application/x-www-form-urlencoded" };

beforeAll(async () => {
  grants = await bootFreshServer("oauth-refusals-grants");
  clients = await bootFreshServer("oauth-refusals-clients");
}, 4 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.allSettled([grants?.stop(), clients?.stop()]);
}, 4 * FRESH_SERVER_TIMEOUT_MS);

describe("DELETE /auth/grants/{id}", () => {
  it("answers 404 oauth_grant_not_found for an id that is no app's grant, and revokes one that is", async () => {
    const server = grants!;
    await approvedAppToken(server, ["openid"]);
    const authorization = { Authorization: `Bearer ${server.workingKey}` };
    const listed = await fetch(`${server.apiUrl}/auth/grants`, {
      headers: authorization,
    });
    expect(listed.status).toBe(200);
    const held = ((await listed.json()) as { data: { id: string }[] }).data;
    expect(held).toHaveLength(1);

    // An id nothing holds, and the id of an item that is not a grant.
    const note = await fetch(`${server.apiUrl}/items`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "core.note",
        properties: { body: "not a grant" },
      }),
    });
    expect(note.status).toBe(201);
    const noteId = ((await note.json()) as { item: { id: string } }).item.id;
    for (const id of ["019537a0-7b80-7000-8000-000000000000", noteId]) {
      const refused = await fetch(`${server.apiUrl}/auth/grants/${id}`, {
        method: "DELETE",
        headers: authorization,
      });
      expect(refused.status).toBe(404);
      expect(refused.headers.get("X-Error-Code")).toBe("oauth_grant_not_found");
      expect(
        ((await refused.json()) as { error: { code: string } }).error.code,
      ).toBe("oauth_grant_not_found");
    }

    // The witness: the same door and credential revoke the grant that exists,
    // so the refusals above were about the ids.
    const revoked = await fetch(`${server.apiUrl}/auth/grants/${held[0]!.id}`, {
      method: "DELETE",
      headers: authorization,
    });
    expect(revoked.status).toBe(204);
  });
});

describe("GET /auth/device/consent", () => {
  async function signedInOrigin(
    server: FreshServer,
    verificationUri: string,
  ): Promise<{ origin: string; cookie: string }> {
    const origin = new URL(verificationUri).origin;
    const signIn = await fetch(`${origin}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(OWNER),
    });
    expect(signIn.status, `sign-in at ${server.apiUrl}`).toBe(200);
    const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
      signIn.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(cookie, "the sign-in set no session cookie").toBeDefined();
    return { origin, cookie: cookie! };
  }

  it("answers 400 invalid_client for a pending code whose client is no longer registered", async () => {
    const server = clients!;
    const operator = { Authorization: `Bearer ${server.operatorKey}` };
    const created = await fetch(`${server.apiUrl}/owner`, {
      method: "POST",
      headers: { ...operator, "Content-Type": "application/json" },
      body: JSON.stringify(OWNER),
    });
    expect(created.status).toBe(201);

    const discovery = (await (
      await fetch(
        `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
      )
    ).json()) as {
      registration_endpoint: string;
      device_authorization_endpoint: string;
    };
    const registered = (await (
      await fetch(discovery.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "conformance",
          application_type: "native",
          grant_types: [
            "urn:ietf:params:oauth:grant-type:device_code",
            "refresh_token",
          ],
          response_types: [],
          token_endpoint_auth_method: "none",
        }),
      })
    ).json()) as { client_id: string };
    const code = (await (
      await fetch(discovery.device_authorization_endpoint, {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({
          client_id: registered.client_id,
          scope: "openid",
        }),
      })
    ).json()) as { user_code: string; verification_uri_complete: string };
    const { origin, cookie } = await signedInOrigin(
      server,
      code.verification_uri_complete,
    );
    const consentUrl = `${origin}/auth/device/consent?user_code=${encodeURIComponent(code.user_code)}`;

    // The control: while the client is registered the owner is shown the
    // consent screen for the code.
    const shown = await fetch(consentUrl, { headers: { cookie } });
    expect(shown.status).toBe(200);
    expect(shown.headers.get("Content-Type")).toContain("text/html");

    // A registration nobody authorized is removed once it is older than the
    // retention window, however recently a code was asked for it. The window
    // is days, so the client's age is written rather than waited for.
    const aged = withInstanceDatabase(server.sqlitePath, (db) =>
      db
        .prepare(
          "UPDATE auth_oauth_client SET created_at = 0 WHERE client_id = ?",
        )
        .run(registered.client_id),
    );
    expect(Number(aged.changes)).toBe(1);
    const swept = await fetch(
      `${server.apiUrl}/background-jobs/dcr-client-cleanup/run`,
      { method: "POST", headers: operator },
    );
    expect(swept.status).toBe(200);
    expect(await swept.json()).toMatchObject({
      outcome: "ok",
      result: { deleted: 1 },
    });

    const refused = await fetch(consentUrl, { headers: { cookie } });
    expect(refused.status).toBe(400);
    expect(refused.headers.get("X-Error-Code")).toBe("invalid_client");
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_client");
  });
});
