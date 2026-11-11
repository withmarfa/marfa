import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
import { validatorFor, type OpenApiDocument } from "../../utils/openapi.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  FRESH_SERVER_TIMEOUT_MS,
  keepStatusLog,
} from "../../utils/fresh-server.js";
import { testAuthenticator } from "../../utils/passkey-authenticator.js";

let document: OpenApiDocument;
async function expectMatchesSchema(
  method: string,
  path: string,
  status: number,
  body: unknown,
) {
  const schema =
    document.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)]
      ?.content?.["application/json"]?.schema;
  expect(schema).toBeDefined();
  const validate = validatorFor(schema, document);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

// Passkeys need a host name, so the instance signs in at localhost.
const HOST = "localhost";
let state: string,
  server: { url: string; controlSocket: string },
  base: string,
  ownerCookie: string;
function onLocalhost(url: string): string {
  const own = new URL(url);
  own.hostname = HOST;
  return own.origin;
}
const owner = {
  email: "owner@example.test",
  password: "correct horse battery",
};
const first = testAuthenticator(),
  second = testAuthenticator();
let firstId: string, secondId: string;
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
function post(path: string, body: unknown, cookies = "") {
  return fetch(base + path, {
    method: "POST",
    headers: {
      origin: base,
      cookie: cookies,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
const OPTIONS = {
  register: "/auth/passkeys/registration/options",
  authenticate: "/auth/passkeys/sign-in/options",
};
async function options(
  kind: "register" | "authenticate",
  cookies = kind === "register" ? ownerCookie : "",
) {
  const response = await fetch(base + OPTIONS[kind], {
    method: "POST",
    headers: { origin: base, cookie: cookies },
  });
  expect(response.status).toBe(200);
  return {
    body: (await response.json()) as { challenge: string },
    cookie: [cookies, cookie(response)].filter(Boolean).join("; "),
  };
}
async function register(
  device: ReturnType<typeof testAuthenticator>,
  name: string,
) {
  const challenge = await options("register");
  const response = await post(
    "/auth/passkeys/registration",
    {
      name,
      response: device.registration(challenge.body.challenge, base, HOST),
    },
    challenge.cookie,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}
async function signIn(
  device: ReturnType<typeof testAuthenticator>,
  counter: number,
) {
  const challenge = await options("authenticate");
  return post(
    "/auth/passkeys/sign-in",
    {
      response: device.authentication(
        challenge.body.challenge,
        base,
        counter,
        HOST,
      ),
    },
    challenge.cookie,
  );
}
beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "marfa-passkey-conformance-"));
  server = await bootUnclaimedServer({ state });
  base = onLocalhost(server.url);
  const moved = await controlRequest(server.controlSocket, "/config", {
    method: "PATCH",
    body: { sign_in_address: base, confirm_sign_in_address_change: true },
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  document = (await (
    await fetch(base + "/openapi.json")
  ).json()) as OpenApiDocument;
  const setup = await controlRequest(
    server.controlSocket,
    "/_control/setup/code",
    { method: "POST", body: {} },
  );
  expect(
    (await post("/owner", { ...owner, code: setup.body.code })).status,
  ).toBe(201);
  const login = await post("/auth/sign-in", owner);
  expect(login.status).toBe(200);
  ownerCookie = cookie(login);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  if (state) {
    await stopServer({ state });
    keepStatusLog(state);
    await rm(state, { recursive: true, force: true });
  }
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("owner passkeys", () => {
  it("registers and lists independent owner credentials", async () => {
    firstId = (await register(first, "First")).id;
    secondId = (await register(second, "Second")).id;
    const duplicateChallenge = await options("register");
    const response = first.registration(
      duplicateChallenge.body.challenge,
      base,
      HOST,
    );
    response.id = response.rawId = Buffer.from(
      "alternate outer identity",
    ).toString("base64url");
    const duplicate = await post(
      "/auth/passkeys/registration",
      { response },
      duplicateChallenge.cookie,
    );
    expect(duplicate.status).toBe(409);
    const list = await fetch(base + "/owner/passkeys", {
      headers: { origin: base, cookie: ownerCookie },
    });
    expect(list.status).toBe(200);
    const listed = await list.json();
    await expectMatchesSchema("GET", "/owner/passkeys", 200, listed);
    expect(
      (listed as { data: { name: string }[] }).data
        .map((row) => row.name)
        .sort(),
    ).toEqual(["First", "Second"]);
    const page = await fetch(base + "/auth/owner/passkeys", {
      headers: { cookie: ownerCookie },
    });
    expect(await page.text()).toContain("HTTPS");
    const signed = await signIn(first, 1);
    expect(signed.status).toBe(200);
    expect(
      (
        await fetch(base + "/owner/passkeys", {
          headers: { cookie: cookie(signed) },
        })
      ).status,
    ).toBe(200);
  });
  it("gives passkey options only to a POST, answers a registration 201 with the passkey, and a passkey sign-in with only ok and its session cookie", async () => {
    for (const path of Object.values(OPTIONS)) {
      const asked = await fetch(base + path, {
        headers: { origin: base, cookie: ownerCookie },
      });
      expect(asked.status, path).toBe(404);
    }
    const device = testAuthenticator();
    const challenge = await options("register");
    const registered = await post(
      "/auth/passkeys/registration",
      {
        name: "Shapes",
        response: device.registration(challenge.body.challenge, base, HOST),
      },
      challenge.cookie,
    );
    expect(registered.status).toBe(201);
    const added = (await registered.json()) as Record<string, unknown>;
    expect(added).toEqual({
      id: expect.any(String),
      name: "Shapes",
      created_at: expect.any(String),
      last_used_at: null,
    });
    const signed = await signIn(device, 1);
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ ok: true });
    const line = signed.headers.getSetCookie().join("\n");
    expect(line).toMatch(/^marfa_session=[^;]+;/m);
    expect(line).toContain("HttpOnly");
    const removed = await controlRequest(
      server.controlSocket,
      "/owner/passkeys/" + String(added.id),
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
  });
  it("refuses a passkey sign-in that says neither Origin nor Referer, and opens no session", async () => {
    const device = testAuthenticator();
    const id = (await register(device, "Unsaid")).id;
    const unsaid = await options("authenticate");
    const refused = await fetch(base + "/auth/passkeys/sign-in", {
      method: "POST",
      headers: { cookie: unsaid.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        response: device.authentication(unsaid.body.challenge, base, 1, HOST),
      }),
    });
    expect(refused.status).toBe(403);
    expect(cookie(refused)).not.toContain("marfa_session");
    // The witness: the same passkey, with the page's Origin, signs in.
    const signed = await signIn(device, 2);
    expect(signed.status).toBe(200);
    expect(cookie(signed)).toContain("marfa_session");
    const removed = await controlRequest(
      server.controlSocket,
      "/owner/passkeys/" + id,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
  });
  it("renames safely through owner and private local authority", async () => {
    const renamed = await controlRequest(
      server.controlSocket,
      "/owner/passkeys/" + firstId,
      { method: "PATCH", body: { name: "  Renamed first  " } },
    );
    expect(renamed.status).toBe(200);
    await expectMatchesSchema(
      "PATCH",
      "/owner/passkeys/{id}",
      200,
      renamed.body,
    );
    expect(renamed.body).toMatchObject({
      id: firstId,
      name: "Renamed first",
      created_at: expect.any(String),
    });
    expect(Object.keys(renamed.body).sort()).toEqual([
      "created_at",
      "id",
      "last_used_at",
      "name",
    ]);
    for (const name of [
      " ",
      "x".repeat(201),
      "bad\u0000name",
      "bad\u202ename",
    ]) {
      const refused = await controlRequest(
        server.controlSocket,
        "/owner/passkeys/" + firstId,
        { method: "PATCH", body: { name } },
      );
      expect(refused.status).toBe(400);
    }
    const temporary = await register(testAuthenticator(), "Temporary");
    const removed = await controlRequest(
      server.controlSocket,
      "/owner/passkeys/" + temporary.id,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    await expectMatchesSchema(
      "DELETE",
      "/owner/passkeys/{id}",
      200,
      removed.body,
    );
    expect(
      (
        await controlRequest(
          server.controlSocket,
          "/owner/passkeys/" + temporary.id,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(404);
    const unknown = await controlRequest(
      server.controlSocket,
      "/owner/passkeys/missing",
      { method: "DELETE" },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({
      error: { code: "passkey_not_found" },
    });
    const missingRename = await fetch(base + "/owner/passkeys/missing", {
      method: "PATCH",
      headers: {
        origin: base,
        cookie: ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Missing passkey" }),
    });
    expect(missingRename.status).toBe(404);
    const missingRenameBody = await missingRename.json();
    expect(missingRenameBody).toMatchObject({
      error: { code: "passkey_not_found" },
    });
    await expectMatchesSchema(
      "PATCH",
      "/owner/passkeys/{id}",
      404,
      missingRenameBody,
    );
    const link = await controlRequest(
      server.controlSocket,
      "/_control/owner/passkeys/add-url",
    );
    expect(link.status).toBe(200);
    const url = new URL(String(link.body.url));
    expect(url.origin).toBe(base);
    expect(url.pathname).toBe("/auth/sign-in");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: "login",
      return_to: "/auth/owner/passkeys",
    });
    expect(
      (await fetch(base + "/_control/owner/passkeys/add-url")).status,
    ).toBe(404);
    const rename = await fetch(base + "/owner/passkeys/" + firstId, {
      method: "PATCH",
      headers: {
        origin: base,
        cookie: ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "First" }),
    });
    expect(rename.status).toBe(200);
  });
  it("refuses a passkey name at registration by the rename rule", async () => {
    const stored = async () =>
      (
        (await (
          await fetch(base + "/owner/passkeys", {
            headers: { origin: base, cookie: ownerCookie },
          })
        ).json()) as { data: unknown[] }
      ).data.length;
    const before = await stored();
    const challenge = await options("register");
    const response = testAuthenticator().registration(
      challenge.body.challenge,
      base,
      HOST,
    );
    for (const name of [
      " ",
      "x".repeat(509),
      "bad\u0000name",
      "\u001b[31mred",
      "bad\u202ename",
    ]) {
      const refused = await post(
        "/auth/passkeys/registration",
        { name, response },
        challenge.cookie,
      );
      expect(refused.status, JSON.stringify(name)).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: { code: "validation_error" },
      });
    }
    expect(await stored(), "nothing was stored").toBe(before);
    // The same registration with a name the rule allows is the witness that it was producible.
    const accepted = await post(
      "/auth/passkeys/registration",
      { name: "Accepted", response },
      challenge.cookie,
    );
    expect(accepted.status).toBe(201);
    expect(await stored()).toBe(before + 1);
    const id = ((await accepted.json()) as { id: string }).id;
    const removed = await fetch(base + "/owner/passkeys/" + id, {
      method: "DELETE",
      headers: { origin: base, cookie: ownerCookie },
    });
    expect(removed.status).toBe(200);
  });
  it("requires owner authority and the instance origin for passkey management", async () => {
    const absent = await fetch(base + "/owner/passkeys", {
      headers: { origin: base },
    });
    expect(absent.status).toBe(401);
    const foreign = await fetch(base + "/owner/passkeys/" + firstId, {
      method: "DELETE",
      headers: {
        origin: "https://foreign.example",
        cookie: ownerCookie,
        "content-type": "application/json",
      },
    });
    expect(foreign.status).toBe(403);
    expect((await signIn(first, 2)).status).toBe(200);
  });
  it("refuses wrong credentials and keeps password attempts independent", async () => {
    const challenge = await options("authenticate");
    const response = first.authentication(
      challenge.body.challenge,
      base,
      3,
      HOST,
    );
    const forged = testAuthenticator().authentication(
      challenge.body.challenge,
      base,
      3,
      HOST,
    );
    forged.id = first.id;
    forged.rawId = first.id;
    const refused = await post(
      "/auth/passkeys/sign-in",
      { response: forged },
      challenge.cookie,
    );
    expect(refused.status).toBe(401);
    expect(cookie(refused)).not.toContain("marfa_session");
    const replay = await post(
      "/auth/passkeys/sign-in",
      { response },
      challenge.cookie,
    );
    expect(replay.status).toBe(400);
    // More passkey attempts than the password-address limit do not spend it.
    for (let i = 0; i < 11; i++) {
      const attempt = await options("authenticate");
      const rejected = await post(
        "/auth/passkeys/sign-in",
        {
          response: testAuthenticator().authentication(
            attempt.body.challenge,
            base,
            1,
            HOST,
          ),
        },
        attempt.cookie,
      );
      expect(rejected.status).toBe(401);
    }
    expect((await post("/auth/sign-in", owner)).status).toBe(200);
    for (let i = 0; i < 11; i++)
      await post("/auth/sign-in", {
        ...owner,
        password: "incorrect password",
      });
    expect((await post("/auth/sign-in", owner)).status).toBe(429);
    expect((await signIn(first, 3)).status).toBe(200);
    expect((await post("/auth/sign-in", owner)).status).toBe(429);
  });
  it("records the last use of only the passkey that signed in, and only when it signed in", async () => {
    const used = testAuthenticator(),
      idle = testAuthenticator();
    const usedId = (await register(used, "Used")).id;
    const idleId = (await register(idle, "Idle")).id;
    const lastUsed = async () => {
      const list = await fetch(base + "/owner/passkeys", {
        headers: { origin: base, cookie: ownerCookie },
      });
      expect(list.status).toBe(200);
      const { data } = (await list.json()) as {
        data: { id: string; last_used_at: string | null }[];
      };
      return Object.fromEntries(
        data
          .filter((row) => row.id === usedId || row.id === idleId)
          .map((row) => [
            row.id === usedId ? "used" : "idle",
            row.last_used_at,
          ]),
      );
    };
    expect(await lastUsed()).toEqual({ used: null, idle: null });

    const challenge = await options("authenticate");
    const forged = testAuthenticator().authentication(
      challenge.body.challenge,
      base,
      1,
      HOST,
    );
    forged.id = forged.rawId = used.id;
    const refused = await post(
      "/auth/passkeys/sign-in",
      { response: forged },
      challenge.cookie,
    );
    expect(refused.status).toBe(401);
    expect(await lastUsed()).toEqual({ used: null, idle: null });

    const from = Math.floor(Date.now() / 1000) * 1000;
    expect((await signIn(used, 1)).status).toBe(200);
    const after = await lastUsed();
    expect(after.idle).toBeNull();
    const at = Date.parse(String(after.used));
    expect(at).toBeGreaterThanOrEqual(from);
    expect(at).toBeLessThanOrEqual(Date.now());

    for (const id of [usedId, idleId])
      expect(
        (
          await controlRequest(server.controlSocket, "/owner/passkeys/" + id, {
            method: "DELETE",
          })
        ).status,
      ).toBe(200);
  });
  it(
    "preserves individual removal and other passkeys across restart",
    async () => {
      expect((await signIn(second, 1)).status).toBe(200);
      expect(
        (
          await fetch(base + "/owner/passkeys/" + firstId, {
            method: "DELETE",
            headers: { origin: base, cookie: ownerCookie },
          })
        ).status,
      ).toBe(200);
      expect((await signIn(first, 3)).status).toBe(401);
      expect(
        (
          await controlRequest(
            server.controlSocket,
            "/owner/passkeys/" + secondId,
            { method: "PATCH", body: { name: "Persistent second" } },
          )
        ).status,
      ).toBe(200);
      const port = Number(new URL(base).port);
      await stopServer({ state });
      server = await bootUnclaimedServer({ state, port });
      base = onLocalhost(server.url);
      expect((await signIn(first, 3)).status).toBe(401);
      expect((await signIn(second, 2)).status).toBe(200);
      const inventory = await controlRequest(
        server.controlSocket,
        "/owner/passkeys",
      );
      expect(inventory.body).toEqual({
        data: [
          {
            id: secondId,
            name: "Persistent second",
            created_at: expect.any(String),
            last_used_at: expect.any(String),
          },
        ],
        next_cursor: null,
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
