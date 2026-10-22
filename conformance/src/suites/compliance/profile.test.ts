import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bootFreshServer,
  approvedApp,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { TEST_OWNER } from "../../utils/target.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
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
  return fetch(server.apiUrl + "/owner", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin: server.apiUrl,
      cookie: server.ownerCookie,
    },
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
    const app = await approvedApp(server, [
      "openid",
      "profile:write",
      "offline_access",
    ]);

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
    const identity = await fetch(server.apiUrl + "/auth/oauth2/userinfo", {
      headers: { authorization: `Bearer ${app.token}` },
    });
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({
      sub: previous.body.id,
      name: "New owner",
      email: "changed.owner@example.test",
      email_verified: false,
    });

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
        await fetch(server.apiUrl + "/owner", {
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
  it("requires a recent direct owner and refuses explicit email-write grants", async () => {
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
    expect(
      (
        await fetch(server.apiUrl + "/owner", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${server.workingKey}`,
            cookie: server.ownerCookie,
            origin: server.apiUrl,
          },
          body: JSON.stringify({ name: "No" }),
        })
      ).status,
    ).toBe(403);
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
    await server.advanceClock(300_001);
    expect((await owner({ name: "Too old" })).status).toBe(403);
    const local = await controlRequest(server.controlSocket, "/owner", {
      method: "PATCH",
      body: { name: "Local owner" },
    });
    expect(local.status).toBe(200);
    expect(local.body.name).toBe("Local owner");
  });

  it(
    "refuses owner and profile updates and picture uploads without recreating an unavailable persisted owner",
    async () => {
      const missing = await bootFreshServer("profile-missing-owner");
      try {
        const claimed = await controlRequest(
          missing.controlSocket,
          "/_control/setup/status",
        );
        expect(claimed.body.claimed).toBe(true);
        const changed = await controlRequest(missing.controlSocket, "/owner", {
          method: "PATCH",
          body: { name: "Existing owner" },
        });
        expect(changed.status).toBe(200);
        expect(changed.body.name).toBe("Existing owner");
        await expectMatchesSchema("PATCH", "/owner", 200, changed.body);
        const writeProfile = () =>
          fetch(missing.apiUrl + "/profile", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${missing.workingKey}`,
            },
            body: JSON.stringify({ name: "Existing profile" }),
          });
        const updated = await writeProfile();
        expect(updated.status).toBe(200);
        const updatedBody = await updated.json();
        expect(updatedBody).toEqual({ ok: true });
        await expectMatchesSchema("PATCH", "/profile", 200, updatedBody);
        expect(
          (await controlRequest(missing.controlSocket, "/owner")).body.name,
        ).toBe("Existing profile");

        // Witness: the same upload, through each door, succeeds while the
        // owner exists, so the refusals below are the missing owner's.
        const file = png(8, 8);
        const putOwnerPicture = () =>
          controlRequest(missing.controlSocket, "/owner/picture", {
            method: "PUT",
            body: file,
          });
        const putProfilePicture = () =>
          fetch(missing.apiUrl + "/profile/picture", {
            method: "PUT",
            headers: { authorization: `Bearer ${missing.workingKey}` },
            body: new Uint8Array(file),
          });
        expect((await putOwnerPicture()).status).toBe(200);
        expect((await putProfilePicture()).status).toBe(200);
        const cleared = await controlRequest(missing.controlSocket, "/owner", {
          method: "PATCH",
          body: { avatar: null },
        });
        expect(cleared.status).toBe(200);

        await stopServer({ state: missing.stateDir });
        withInstanceDatabase(missing.sqlitePath, (db) => {
          db.exec("PRAGMA foreign_keys = OFF");
          db.exec(
            "DELETE FROM auth_session; DELETE FROM auth_account; DELETE FROM auth_user",
          );
        });
        const restarted = await bootUnclaimedServer({
          state: missing.stateDir,
        });
        missing.apiUrl = restarted.url;
        missing.controlSocket = restarted.controlSocket;
        const current = await fetch(missing.apiUrl + "/keys/current", {
          headers: { authorization: `Bearer ${missing.workingKey}` },
        });
        expect(current.status).toBe(200);

        const assertOwnerRemainsUnavailable = async () => {
          expect(
            (await controlRequest(missing.controlSocket, "/owner")).status,
          ).toBe(404);
          expect(
            (
              await controlRequest(
                missing.controlSocket,
                "/_control/setup/status",
              )
            ).body,
          ).toEqual(claimed.body);
          withInstanceDatabase(missing.sqlitePath, (db) => {
            expect(
              db.prepare("SELECT count(*) AS count FROM auth_user").get()
                ?.count,
            ).toBe(0);
            expect(
              db.prepare("SELECT count(*) AS count FROM owner_picture").get()
                ?.count,
            ).toBe(0);
          });
        };
        const ownerRefused = await controlRequest(
          missing.controlSocket,
          "/owner",
          { method: "PATCH", body: { name: "Do not recreate owner" } },
        );
        expect(ownerRefused.status).toBe(404);
        expect(ownerRefused.body).toMatchObject({
          error: { code: "owner_not_found" },
        });
        await expectMatchesSchema("PATCH", "/owner", 404, ownerRefused.body);
        await assertOwnerRemainsUnavailable();

        const profileRefused = await writeProfile();
        expect(profileRefused.status).toBe(404);
        const profileBody = await profileRefused.json();
        expect(profileBody).toMatchObject({
          error: { code: "owner_not_found" },
        });
        await expectMatchesSchema("PATCH", "/profile", 404, profileBody);
        await assertOwnerRemainsUnavailable();

        const ownerPictureRefused = await putOwnerPicture();
        expect(ownerPictureRefused.status).toBe(404);
        expect(ownerPictureRefused.body).toMatchObject({
          error: { code: "owner_not_found" },
        });
        await expectMatchesSchema(
          "PUT",
          "/owner/picture",
          404,
          ownerPictureRefused.body,
        );
        await assertOwnerRemainsUnavailable();
        const profilePictureRefused = await putProfilePicture();
        expect(profilePictureRefused.status).toBe(404);
        const profilePictureBody = await profilePictureRefused.json();
        expect(profilePictureBody).toMatchObject({
          error: { code: "owner_not_found" },
        });
        await expectMatchesSchema(
          "PUT",
          "/profile/picture",
          404,
          profilePictureBody,
        );
        await assertOwnerRemainsUnavailable();
      } finally {
        await missing.stop();
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
