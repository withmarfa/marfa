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
import { png } from "../../utils/avatars.js";
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
  return localFetch(server.controlSocket, server.apiUrl + "/profile", {
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
async function read(): Promise<Record<string, unknown>> {
  const answer = await controlRequest(server.controlSocket, "/profile");
  expect(answer.status).toBe(200);
  return answer.body;
}
async function mint(
  source: string,
  profile_permissions: Record<string, string>,
): Promise<{ id: string; key: string }> {
  const made = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: { label: source, source, profile_permissions },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body as unknown as { id: string; key: string };
}
describe("owner and delegated profile changes", () => {
  it("updates the existing owner and preserves credentials and sessions", async () => {
    const app = await approvedApp(server, ["profile:write", "offline_access"]);

    const updated = await owner({
      email: "Changed.Owner@Example.test",
      name: "  New owner  ",
    });
    expect(updated.status).toBe(200);
    const value = (await updated.json()) as Record<string, unknown>;
    expect(value).toEqual({
      email: "changed.owner@example.test",
      name: "New owner",
      avatar: null,
    });
    await expectMatchesSchema("PATCH", "/profile", 200, value);
    const identity = await fetch(server.apiUrl + "/profile", {
      headers: { authorization: `Bearer ${app.token}` },
    });
    expect(identity.status).toBe(200);
    const shown = await identity.json();
    expect(shown).toEqual(value);
    await expectMatchesSchema("GET", "/profile", 200, shown);

    const signin = (email: string) =>
      fetch(server.apiUrl + "/auth/sign-in", {
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
    expect((await owner({ email: TEST_OWNER.email })).status).toBe(200);
  });
  it("validates fields and limits credential writes to the fields each may write", async () => {
    for (const body of [
      {},
      { name: "\tInvalid" },
      { name: "\u200fInvalid" },
      { name: " " },
      { email: "invalid" },
      { avatar: "file:///avatar" },
      { avatar: "https://example.test/portrait.png" },
    ])
      expect((await owner(body)).status).toBe(400);
    const invalid = await owner({ name: "a".repeat(201) });
    expect(invalid.status).toBe(400);
    expect((await owner({ name: "😀".repeat(200) })).status).toBe(200);
    const named = await mint("profile-name", { name: "write" });
    const before = await read();
    for (const body of [
      { name: "No", avatar: null },
      { name: "No", email: "named@example.test" },
    ])
      expect((await profile(body, named.key)).status).toBe(403);
    expect(await read()).toEqual(before);
    expect((await profile({ name: "Delegated" }, named.key)).status).toBe(200);
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
      { email: "invalid" },
      { avatar: "file:///avatar" },
      { avatar: "https://example.test/portrait.png" },
    ])
      expect((await profile(body)).status).toBe(400);
    const email = (await read()).email as string;
    const mailer = await mint("profile-email", { email: "write" });
    const changed = await profile({ email: "Moved@Example.test" }, mailer.key);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ email: "moved@example.test" });
    expect((await owner({ email })).status).toBe(200);
    const response = await profile({ name: "Final" });
    const result = await response.json();
    expect(result).toMatchObject({ name: "Final" });
    expect(result).not.toHaveProperty("ok");
    await expectMatchesSchema("PATCH", "/profile", 200, result);
  });
  it("refuses a name change when the key loses its permission after the request was admitted, and makes it when the key does not", async () => {
    const made = await mint("profile-name-lost", { name: "write" });
    const key = made.key;
    const name = async () => (await read()).name;

    // The request waits after it was admitted, while `change` is made.
    const held = async (target: string, change: boolean) => {
      await server.setFault("hold:write=profile.update@1");
      const pending = profile({ name: target }, key);
      await server.waitForHold("hold:write");
      if (change) {
        const narrowed = await controlRequest(
          server.controlSocket,
          `/keys/${made.id}`,
          { method: "PATCH", body: { profile_permissions: {} } },
        );
        expect(narrowed.status).toBe(200);
      }
      await server.clearFault("hold:write");
      return pending;
    };

    // The witness: held the same way and left alone, the change lands.
    expect((await held("Kept while held", false)).status).toBe(200);
    expect(await name()).toBe("Kept while held");

    const before = await name();
    expect((await held("Lost while held", true)).status).toBe(403);
    expect(await name()).toBe(before);
  });
  it("requires a credential, takes an email-write grant and refuses an unknown field", async () => {
    const unauthenticated = await fetch(server.apiUrl + "/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: server.apiUrl },
      body: JSON.stringify({ name: "No credential" }),
    });
    expect(unauthenticated.status).toBe(401);
    const body = await unauthenticated.json();
    expect(body).toMatchObject({ error: { code: "unauthorized" } });
    await expectMatchesSchema("PATCH", "/profile", 401, body);
    // The owner's browser session counts here as no credential.
    const session = await fetch(server.apiUrl + "/profile", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: server.ownerCookie,
        origin: server.apiUrl,
      },
      body: JSON.stringify({ name: "No" }),
    });
    expect(session.status).toBe(401);
    const refused = await controlRequest(server.controlSocket, "/keys", {
      method: "POST",
      body: {
        label: "Invalid",
        source: "invalid-profile",
        profile_permissions: { unknown: "read" },
      },
    });
    expect(refused.status).toBe(400);
    await mint("profile-email-grant", { email: "write" });
    const local = await owner({ name: "Local owner" });
    expect(local.status).toBe(200);
    expect(((await local.json()) as { name: string }).name).toBe("Local owner");
  });

  it(
    "refuses a profile update and an avatar upload from the local command while the instance is unclaimed",
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
          expect((await local("/profile")).status).toBe(404);
        };

        const ownerRefused = await local("/profile", {
          method: "PATCH",
          body: { name: "Do not create owner" },
        });
        expect(ownerRefused.status).toBe(404);
        expect(ownerRefused.body).toMatchObject({
          error: { code: "owner_not_found" },
        });
        await expectMatchesSchema("PATCH", "/profile", 404, ownerRefused.body);
        await assertStillUnclaimed();

        const avatarRefused = await local("/profile/avatar", {
          method: "PUT",
          body: png(8, 8),
        });
        expect(avatarRefused.status).toBe(404);
        expect(avatarRefused.body).toMatchObject({
          error: { code: "owner_not_found" },
        });
        await expectMatchesSchema(
          "PUT",
          "/profile/avatar",
          404,
          avatarRefused.body,
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

it("takes an email-write OAuth scope", async () => {
  const registered = await fetch(server.apiUrl + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Profile scope",
      application_type: "native",
      redirect_uris: ["http://localhost:5173/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "profile.name:read profile.email:write",
    }),
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { scope: string };
  expect(client.scope.split(" ")).toContain("profile.email:write");
  const app = await approvedApp(server, ["profile.email:write"]);
  const email = (await read()).email as string;
  const changed = await profile({ email: "app.moved@example.test" }, app.token);
  expect(changed.status).toBe(200);
  expect((await owner({ email })).status).toBe(200);
});
