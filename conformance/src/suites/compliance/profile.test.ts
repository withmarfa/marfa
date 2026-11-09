import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bootFreshServer,
  approvedApp,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest, localFetch } from "../../utils/control-request.js";
import { TEST_OWNER } from "../../utils/target.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { png } from "../../utils/pictures.js";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
let server: FreshServer;
beforeAll(async () => {
  server = await bootFreshServer("profile");
  vi.stubEnv("MARFA_API_URL", server.apiUrl);
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  vi.unstubAllEnvs();
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);
function owner(body: unknown) {
  return localFetch(server.controlSocket, server.apiUrl + "/owner", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function profile(body: unknown, key = server.workingKey) {
  return fetch(server.apiUrl + "/profile", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
}
describe("owner and delegated profile changes", () => {
  it("updates the existing owner and preserves credentials and sessions", async () => {
    const previous = await controlRequest(server.controlSocket, "/owner");
    const app = await approvedApp(server, ["profile:write", "offline_access"]);

    const updated = await owner({
      email: "Changed.Owner@Example.test",
      name: "  New owner  ",
    });
    expect(updated.status).toBe(200);
    const value = (await updated.json()) as Record<string, unknown>;
    expect(value).toMatchObject({
      id: previous.body.id,
      email: "changed.owner@example.test",
      name: "New owner",
      created_at: previous.body.created_at,
    });
    await expectMatchesSchema("PATCH", "/owner", 200, value);
    const identity = await fetch(server.apiUrl + "/profile", {
      headers: { authorization: `Bearer ${app.token}` },
    });
    expect(identity.status).toBe(200);
    const read = await identity.json();
    expect(read).toEqual({
      name: "New owner",
      email: "changed.owner@example.test",
      avatar: null,
    });
    await expectMatchesSchema("GET", "/profile", 200, read);

    const signin = (email: string) =>
      fetch(server.apiUrl + "/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.apiUrl },
        body: JSON.stringify({ email, password: TEST_OWNER.password }),
      });
    expect((await signin(TEST_OWNER.email)).status).toBe(401);
    expect((await signin("changed.owner@example.test")).status).toBe(200);
    expect(
      (
        await fetch(server.apiUrl + "/owner/passkeys", {
          headers: { cookie: server.ownerCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(server.apiUrl + "/keys/current", {
          headers: { authorization: `Bearer ${server.workingKey}` },
        })
      ).status,
    ).toBe(200);
  });
  it("validates fields and limits credential writes to approved name and avatar", async () => {
    for (const body of [
      {},
      { name: "\tInvalid" },
      { name: "\u200fInvalid" },
      { name: " " },
      { email: "invalid" },
      { avatar: "file:///picture" },
      { avatar: "https://example.test/portrait.png" },
    ])
      expect((await owner(body)).status).toBe(400);
    const invalid = await owner({ name: "a".repeat(201) });
    expect(invalid.status).toBe(400);
    expect((await owner({ name: "😀".repeat(200) })).status).toBe(200);
    const made = await controlRequest(server.controlSocket, "/keys", {
      method: "POST",
      body: {
        label: "Profile name",
        source: "profile-name",
        profile_permissions: { name: "write" },
      },
    });
    expect(made.status).toBe(201);
    const before = await controlRequest(server.controlSocket, "/owner");
    expect(
      (await profile({ name: "No", avatar: null }, made.body.key as string))
        .status,
    ).toBe(403);
    expect((await controlRequest(server.controlSocket, "/owner")).body).toEqual(
      before.body,
    );
    expect(
      (await profile({ name: "Delegated" }, made.body.key as string)).status,
    ).toBe(200);
    expect(
      (
        await profile({
          name: "Wildcard",
          avatar: null,
        })
      ).status,
    ).toBe(200);
    expect((await profile({ avatar: null })).status).toBe(200);
    for (const body of [
      {},
      { email: "app@example.test" },
      { name: "No", email: "app@example.test" },
      { avatar: "file:///picture" },
      { avatar: "https://example.test/portrait.png" },
    ])
      expect((await profile(body)).status).toBe(400);
    const response = await profile({ name: "Final" });
    const result = await response.json();
    expect(result).toEqual({ ok: true });
    await expectMatchesSchema("PATCH", "/profile", 200, result);
  });
  it("requires the private local command and refuses explicit email-write grants", async () => {
    for (const path of ["/owner", "/profile"]) {
      const unauthenticated = await fetch(server.apiUrl + path, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: server.apiUrl },
        body: JSON.stringify({ name: "No credential" }),
      });
      expect(unauthenticated.status, path).toBe(401);
      const body = await unauthenticated.json();
      expect(body).toMatchObject({ error: { code: "unauthorized" } });
      await expectMatchesSchema("PATCH", path, 401, body);
    }
    // The owner's browser session counts here as no credential, and a key is
    // refused.
    for (const [headers, status] of [
      [{ cookie: server.ownerCookie, origin: server.apiUrl }, 401],
      [{ authorization: `Bearer ${server.workingKey}` }, 403],
    ] as const) {
      const refused = await fetch(server.apiUrl + "/owner", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ name: "No" }),
      });
      expect(refused.status).toBe(status);
    }
    for (const profile_permissions of [
      { email: "write" },
      { unknown: "read" },
    ]) {
      const refused = await controlRequest(server.controlSocket, "/keys", {
        method: "POST",
        body: {
          label: "Invalid",
          source: "invalid-profile",
          profile_permissions,
        },
      });
      expect(refused.status).toBe(400);
    }
    const local = await controlRequest(server.controlSocket, "/owner", {
      method: "PATCH",
      body: { name: "Local owner" },
    });
    expect(local.status).toBe(200);
    expect(local.body.name).toBe("Local owner");
  });

  it(
    "refuses an owner update and a picture upload from the local command while the instance is unclaimed",
    async () => {
      const state = await mkdtemp(join(tmpdir(), "marfa-profile-unclaimed-"));
      try {
        const unclaimed = await bootUnclaimedServer({ state });
        const local = (
          path: string,
          init?: Parameters<typeof controlRequest>[2],
        ) => controlRequest(unclaimed.controlSocket, path, init);
        const assertStillUnclaimed = async () => {
          expect((await local("/_control/setup/status")).body.claimed).toBe(
            false,
          );
          expect((await local("/owner")).status).toBe(404);
        };

        const ownerRefused = await local("/owner", {
          method: "PATCH",
          body: { name: "Do not create owner" },
        });
        expect(ownerRefused.status).toBe(404);
        expect(ownerRefused.body).toMatchObject({
          error: { code: "owner_not_found" },
        });
        await expectMatchesSchema("PATCH", "/owner", 404, ownerRefused.body);
        await assertStillUnclaimed();

        const pictureRefused = await local("/owner/picture", {
          method: "PUT",
          body: png(8, 8),
        });
        expect(pictureRefused.status).toBe(404);
        expect(pictureRefused.body).toMatchObject({
          error: { code: "owner_not_found" },
        });
        await expectMatchesSchema(
          "PUT",
          "/owner/picture",
          404,
          pictureRefused.body,
        );
        await assertStillUnclaimed();
      } finally {
        await stopServer({ state });
        await rm(state, { recursive: true, force: true });
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

it("refuses explicit email-write OAuth scopes", async () => {
  const registration = {
    client_name: "Profile scope",
    application_type: "native",
    redirect_uris: ["http://localhost:5173/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
  const good = await fetch(server.apiUrl + "/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  expect(good.status).toBe(201);
  const client = (await good.json()) as { client_id: string };
  const refused = await fetch(server.apiUrl + "/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...registration,
      scope: "profile.name:read profile.email:write",
    }),
  });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: "invalid_scope" });
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: registration.redirect_uris[0]!,
    response_type: "code",
    scope: "profile.name:read profile.email:write",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  });
  const authorized = await fetch(
    server.apiUrl + "/auth/oauth2/authorize?" + query.toString(),
    { redirect: "manual" },
  );
  expect(authorized.status).toBe(400);
  expect(await authorized.json()).toMatchObject({ error: "invalid_scope" });
});
