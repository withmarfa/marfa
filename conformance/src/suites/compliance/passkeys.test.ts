import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  FRESH_SERVER_TIMEOUT_MS,
  keepStatusLog,
} from "../../utils/fresh-server.js";
import { testAuthenticator } from "../../utils/passkey-authenticator.js";

let state: string,
  server: { url: string; controlSocket: string },
  ownerCookie: string;
const owner = {
  email: "owner@example.test",
  password: "correct horse battery",
};
const first = testAuthenticator(),
  second = testAuthenticator();
let firstId: string;
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
    await register(second, "Second");
    const duplicateChallenge = await options("register");
    const duplicate = await post(
      "/auth/passkey/verify-registration",
      {
        response: first.registration(
          duplicateChallenge.body.challenge,
          server.url,
          new URL(server.url).hostname,
        ),
      },
      duplicateChallenge.cookie,
    );
    expect(duplicate.status).toBe(409);
    const list = await fetch(server.url + "/auth/passkey/list-user-passkeys", {
      headers: { origin: server.url, cookie: ownerCookie },
    });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { name: string }[]).map((row) => row.name).sort(),
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
  it("requires owner authority and the instance origin for passkey management", async () => {
    const absent = await fetch(
      server.url + "/auth/passkey/list-user-passkeys",
      { headers: { origin: server.url } },
    );
    expect(absent.status).toBe(401);
    const foreign = await fetch(server.url + "/auth/passkey/delete-passkey", {
      method: "POST",
      headers: {
        origin: "https://foreign.example",
        cookie: ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: firstId }),
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
          await post(
            "/auth/passkey/delete-passkey",
            { id: firstId },
            ownerCookie,
          )
        ).status,
      ).toBe(200);
      expect((await signIn(first, 3)).status).toBe(401);
      const port = Number(new URL(server.url).port);
      await stopServer({ state });
      server = await bootUnclaimedServer({ state, port });
      expect((await signIn(first, 3)).status).toBe(401);
      expect((await signIn(second, 2)).status).toBe(200);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
