import { postSignInForm, signInOutcome } from "../../client/owner-session.js";
import { rm } from "node:fs/promises";
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
import { tempFolder } from "../../utils/temp-folder.js";
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
      username: "  Changed.Owner ",
      email: "Changed.Owner@Example.test",
      name: "  New owner  ",
    });
    expect(updated.status).toBe(200);
    const value = (await updated.json()) as Record<string, unknown>;
    expect(value).toEqual({
      username: "changed.owner",
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

    const signin = (username: string) =>
      postSignInForm(server.apiUrl, server.apiUrl, {
        username,
        password: TEST_OWNER.password,
      });
    expect(signInOutcome(await signin(TEST_OWNER.username))).toBe(
      "invalid_credentials",
    );
    expect(signInOutcome(await signin("changed.owner@example.test"))).toBe(
      "invalid_credentials",
    );
    expect(signInOutcome(await signin("changed.owner"))).toBe("signed_in");
    expect(signInOutcome(await signin(" Changed.OWNER "))).toBe("signed_in");
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
    expect((await owner({ username: TEST_OWNER.username })).status).toBe(200);
  });
  it("validates fields and limits credential writes to the fields each may write", async () => {
    for (const body of [
      {},
      { name: "\tInvalid" },
      { name: "\u200fInvalid" },
      { name: " " },
      { email: "invalid" },
      { email: "" },
      { email: 5 },
      { username: 5 },
      { avatar: "file:///avatar" },
      { avatar: "https://example.test/portrait.png" },
    ])
      expect((await owner(body)).status).toBe(400);
    const unchanged = await read();
    for (const username of [
      "has@sign",
      "inner space",
      "hidden\u200bcharacter",
      "émile",
      "",
      "u".repeat(65),
    ]) {
      const refused = await owner({ username });
      expect(refused.status, JSON.stringify(username)).toBe(400);
      const { error } = (await refused.json()) as {
        error: { code: string; details: { errors: { path: string }[] } };
      };
      expect(error.code).toBe("validation_error");
      expect(error.details.errors[0]?.path).toBe("username");
    }
    expect(await read()).toEqual(unchanged);
    const longest = "u".repeat(64);
    expect((await owner({ username: longest })).status).toBe(200);
    expect((await read()).username).toBe(longest);
    expect((await owner({ username: TEST_OWNER.username })).status).toBe(200);
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
    const cleared = await profile({ email: null }, mailer.key);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ email: null });
    expect((await read()).email).toBeNull();
    expect((await profile({ email: "" }, mailer.key)).status).toBe(400);
    expect((await owner({ email })).status).toBe(200);
    const response = await profile({ name: "Final" });
    const result = await response.json();
    expect(result).toMatchObject({ name: "Final" });
    expect(result).not.toHaveProperty("ok");
    await expectMatchesSchema("PATCH", "/profile", 200, result);
  });
  it("refuses a password sign-in whose username changed while its password was being checked", async () => {
    const { username } = (await read()) as { username: string };
    const signin = () =>
      postSignInForm(server.apiUrl, server.apiUrl, {
        username,
        password: TEST_OWNER.password,
      });
    // The witness: held the same way and left alone, the sign-in lands.
    await server.setFault("hold:write=auth.sign_in.success@1");
    const left = signin();
    await server.waitForHold("hold:write");
    await server.clearFault("hold:write");
    expect(signInOutcome(await left)).toBe("signed_in");

    await server.setFault("hold:write=auth.sign_in.success@1");
    const pending = signin();
    await server.waitForHold("hold:write");
    expect((await owner({ username: "moved.during" })).status).toBe(200);
    await server.clearFault("hold:write");
    const late = await pending;
    try {
      expect(signInOutcome(late)).toBe("invalid_credentials");
      expect(late.headers.getSetCookie()).toEqual([]);
    } finally {
      expect((await owner({ username })).status).toBe(200);
    }
  });
  it("changes the username only for a credential that names username write, never through the profile wildcard", async () => {
    const wildcard = await mint("profile-wildcard-write", { "*": "write" });
    // The witness: the wildcard writes the name and the email, and reads the username.
    expect(
      (await profile({ name: "Wildcard writer" }, wildcard.key)).status,
    ).toBe(200);
    const { username, email } = (await read()) as {
      username: string;
      email: string;
    };
    const shown = await fetch(server.apiUrl + "/profile", {
      headers: { authorization: `Bearer ${wildcard.key}` },
    });
    expect(((await shown.json()) as { username: string }).username).toBe(
      username,
    );
    try {
      expect(
        (await profile({ email: "wildcard@example.test" }, wildcard.key))
          .status,
      ).toBe(200);
      expect((await read()).email).toBe("wildcard@example.test");
      const refused = await profile(
        { username: "wildcard-writer" },
        wildcard.key,
      );
      expect(refused.status).toBe(403);
      expect(
        ((await refused.json()) as { error: { details: unknown } }).error
          .details,
      ).toMatchObject({ profile_field: "username", required: "write" });
      expect((await read()).username).toBe(username);

      const named = await mint("profile-username-named", {
        "*": "write",
        username: "write",
      });
      const moved = await profile({ username: "Named.Owner" }, named.key);
      expect(moved.status).toBe(200);
      expect((await read()).username).toBe("named.owner");
    } finally {
      expect((await owner({ username, email })).status).toBe(200);
    }
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
  it("requires a credential, takes a username-write grant and refuses an unknown field", async () => {
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
    await mint("profile-username-grant", { username: "write" });
    const local = await owner({ name: "Local owner" });
    expect(local.status).toBe(200);
    expect(((await local.json()) as { name: string }).name).toBe("Local owner");
  });

  it(
    "refuses a profile update and an avatar upload from the local command while the instance is unclaimed",
    async () => {
      const state = tempFolder("marfa-profile-unclaimed-");
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

it("takes a username-write OAuth scope", async () => {
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
      scope: "profile.name:read profile.username:write",
    }),
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { scope: string };
  expect(client.scope.split(" ")).toContain("profile.username:write");
  const app = await approvedApp(server, ["profile.username:write"]);
  const username = (await read()).username as string;
  const changed = await profile({ username: "app.moved" }, app.token);
  expect(changed.status).toBe(200);
  expect((await read()).username).toBe("app.moved");
  expect((await owner({ username })).status).toBe(200);
  const wide = await approvedApp(server, ["profile:write"]);
  expect((await profile({ username: "wide.moved" }, wide.token)).status).toBe(
    403,
  );
  expect((await read()).username).toBe(username);
  const email = (await read()).email as string;
  expect(
    (await profile({ email: "app.moved@example.test" }, wide.token)).status,
  ).toBe(200);
  expect((await owner({ email })).status).toBe(200);
});
