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

let state: string,
  server: { url: string; controlSocket: string },
  ownerCookie: string;
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
  return fetch(server.url + path, {
    method: "POST",
    headers: {
      origin: server.url,
      cookie: cookies,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function options(
  kind: "register" | "authenticate",
  cookies = kind === "register" ? ownerCookie : "",
) {
  const response = await fetch(
    server.url + "/auth/passkey/generate-" + kind + "-options",
    { headers: { origin: server.url, cookie: cookies } },
  );
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
    "/auth/passkey/verify-registration",
    {
      name,
      response: device.registration(
        challenge.body.challenge,
        server.url,
        new URL(server.url).hostname,
      ),
    },
    challenge.cookie,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}
async function signIn(
  device: ReturnType<typeof testAuthenticator>,
  counter: number,
) {
  const challenge = await options("authenticate");
  return post(
    "/auth/passkey/verify-authentication",
    {
      response: device.authentication(
        challenge.body.challenge,
        server.url,
        counter,
        new URL(server.url).hostname,
      ),
    },
    challenge.cookie,
  );
}
beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "marfa-passkey-conformance-"));
  server = await bootUnclaimedServer({ state });
  document = (await (
    await fetch(server.url + "/openapi.json")
  ).json()) as OpenApiDocument;
  const setup = await controlRequest(
    server.controlSocket,
    "/_control/setup/code",
    { method: "POST", body: {} },
  );
  expect(
    (await post("/owner", { ...owner, code: setup.body.code })).status,
  ).toBe(201);
  const login = await post("/auth/sign-in/email", owner);
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
      server.url,
      new URL(server.url).hostname,
    );
    response.id = response.rawId = Buffer.from(
      "alternate outer identity",
    ).toString("base64url");
    const duplicate = await post(
      "/auth/passkey/verify-registration",
      { response },
      duplicateChallenge.cookie,
    );
    expect(duplicate.status).toBe(409);
    const list = await fetch(server.url + "/owner/passkeys", {
      headers: { origin: server.url, cookie: ownerCookie },
    });
    expect(list.status).toBe(200);
    const listed = await list.json();
    await expectMatchesSchema("GET", "/owner/passkeys", 200, listed);
    expect(
      (listed as { data: { name: string }[] }).data
        .map((row) => row.name)
        .sort(),
    ).toEqual(["First", "Second"]);
    const page = await fetch(server.url + "/auth/owner/passkeys", {
      headers: { cookie: ownerCookie },
    });
    expect(await page.text()).toContain("HTTPS");
    const signed = await signIn(first, 1);
    expect(signed.status).toBe(200);
    expect(
      (
        await fetch(server.url + "/owner", {
          headers: { cookie: cookie(signed) },
        })
      ).status,
    ).toBe(200);
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
    const missingRename = await fetch(server.url + "/owner/passkeys/missing", {
      method: "PATCH",
      headers: {
        origin: server.url,
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
    expect(url.origin).toBe(server.url);
    expect(url.pathname).toBe("/auth/sign-in");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: "login",
      return_to: "/auth/owner/passkeys",
    });
    expect(
      (await fetch(server.url + "/_control/owner/passkeys/add-url")).status,
    ).toBe(404);
    const rename = await fetch(server.url + "/owner/passkeys/" + firstId, {
      method: "PATCH",
      headers: {
        origin: server.url,
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
          await fetch(server.url + "/owner/passkeys", {
            headers: { origin: server.url, cookie: ownerCookie },
          })
        ).json()) as { data: unknown[] }
      ).data.length;
    const before = await stored();
    const challenge = await options("register");
    const response = testAuthenticator().registration(
      challenge.body.challenge,
      server.url,
      new URL(server.url).hostname,
    );
    for (const name of [
      " ",
      "x".repeat(509),
      "bad\u0000name",
      "\u001b[31mred",
      "bad\u202ename",
    ]) {
      const refused = await post(
        "/auth/passkey/verify-registration",
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
      "/auth/passkey/verify-registration",
      { name: "Accepted", response },
      challenge.cookie,
    );
    expect(accepted.status).toBe(200);
    expect(await stored()).toBe(before + 1);
    const id = ((await accepted.json()) as { id: string }).id;
    const removed = await fetch(server.url + "/owner/passkeys/" + id, {
      method: "DELETE",
      headers: { origin: server.url, cookie: ownerCookie },
    });
    expect(removed.status).toBe(200);
  });
  it("requires owner authority and the instance origin for passkey management", async () => {
    const absent = await fetch(server.url + "/owner/passkeys", {
      headers: { origin: server.url },
    });
    expect(absent.status).toBe(401);
    const foreign = await fetch(server.url + "/owner/passkeys/" + firstId, {
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
      server.url,
      3,
      new URL(server.url).hostname,
    );
    const forged = testAuthenticator().authentication(
      challenge.body.challenge,
      server.url,
      3,
      new URL(server.url).hostname,
    );
    forged.id = first.id;
    forged.rawId = first.id;
    const refused = await post(
      "/auth/passkey/verify-authentication",
      { response: forged },
      challenge.cookie,
    );
    expect(refused.status).toBe(401);
    expect(cookie(refused)).not.toContain("session_token");
    const replay = await post(
      "/auth/passkey/verify-authentication",
      { response },
      challenge.cookie,
    );
    expect(replay.status).toBe(400);
    // More passkey attempts than the password-address limit do not spend it.
    for (let i = 0; i < 11; i++) {
      const attempt = await options("authenticate");
      const rejected = await post(
        "/auth/passkey/verify-authentication",
        {
          response: testAuthenticator().authentication(
            attempt.body.challenge,
            server.url,
            1,
            new URL(server.url).hostname,
          ),
        },
        attempt.cookie,
      );
      expect(rejected.status).toBe(401);
    }
    expect((await post("/auth/sign-in/email", owner)).status).toBe(200);
    for (let i = 0; i < 11; i++)
      await post("/auth/sign-in/email", {
        ...owner,
        password: "incorrect password",
      });
    expect((await post("/auth/sign-in/email", owner)).status).toBe(429);
    expect((await signIn(first, 3)).status).toBe(200);
    expect((await post("/auth/sign-in/email", owner)).status).toBe(429);
  });
  it(
    "preserves individual removal and other passkeys across restart",
    async () => {
      expect((await signIn(second, 1)).status).toBe(200);
      expect(
        (
          await fetch(server.url + "/owner/passkeys/" + firstId, {
            method: "DELETE",
            headers: { origin: server.url, cookie: ownerCookie },
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
      const port = Number(new URL(server.url).port);
      await stopServer({ state });
      server = await bootUnclaimedServer({ state, port });
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
          },
        ],
        next_cursor: null,
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
