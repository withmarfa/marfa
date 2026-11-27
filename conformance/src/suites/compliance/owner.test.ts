import { postSignInForm, signInOutcome } from "../../client/owner-session.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  FRESH_SERVER_TIMEOUT_MS,
  keepStatusLog,
  serverOutput,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { describedWords, markedInvalid } from "../../utils/page-html.js";
import { tempFolder } from "../../utils/temp-folder.js";

let state: string;
let server: { url: string; controlSocket: string };
let code: string;
let ownerId: string;
let cookie: string;
let managementKey: string;
const OWNER = {
  username: "owner",
  password: "correct horse battery",
};

beforeAll(async () => {
  state = tempFolder("marfa-owner-conformance-");
  vi.stubEnv("MARFA_TRUSTED_PROXY_HEADER", "x-conformance-client");
  vi.stubEnv("MARFA_TRUSTED_PROXY_CIDRS", "127.0.0.0/8");
  server = await bootUnclaimedServer({ state });
  vi.stubEnv("MARFA_API_URL", server.url);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  vi.unstubAllEnvs();
  if (state) {
    await stopServer({ state });
    keepStatusLog(state);
    await rm(state, { recursive: true, force: true });
  }
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function signInAs(
  credentials: { username: string; password: string },
  headers: Record<string, string> = {},
) {
  return postSignInForm(server.url, server.url, credentials, headers);
}
async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
function local(path: string, body?: unknown) {
  return controlRequest(
    server.controlSocket,
    path,
    body === undefined ? {} : { method: "POST", body },
  );
}

describe("claiming the one owner", () => {
  it("starts unclaimed with local authority and no public claim authority", async () => {
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
    const unclaimed = await local("/profile");
    expect(unclaimed.status).toBe(404);
    expect(unclaimed.body).toMatchObject({
      error: { code: "owner_not_found" },
    });
    expect((await fetch(`${server.url}/profile`)).status).toBe(401);
    const noProofClaim = await post("/setup/claim", OWNER);
    expect(noProofClaim.status).toBe(401);
    expect(await errorCode(noProofClaim)).toBe("setup_proof_invalid");
    const noProofOwner = await post("/owner", OWNER);
    expect(noProofOwner.status).toBe(401);
    expect(await errorCode(noProofOwner)).toBe("setup_proof_invalid");
    expect(signInOutcome(await signInAs(OWNER))).toBe("invalid_credentials");
    expect((await fetch(`${server.url}/_control/setup/status`)).status).toBe(
      404,
    );
  });

  it("replaces setup proof and rejects the earlier code", async () => {
    const first = await local("/_control/setup/code", {});
    expect(first.status).toBe(200);
    const second = await local("/_control/setup/code", {});
    expect(second.status).toBe(200);
    code = second.body.code as string;
    expect(code).not.toBe(first.body.code);
    expect(
      (
        await post(
          "/owner",
          { ...OWNER, code },
          { origin: "https://elsewhere.example" },
        )
      ).status,
    ).toBe(403);
    const replaced = await post("/setup/claim", {
      ...OWNER,
      code: first.body.code,
    });
    expect(replaced.status).toBe(401);
    expect(await errorCode(replaced)).toBe("setup_proof_invalid");
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it("limits code guesses per address without an instance-wide cap and accepts handoffs past the limit", async () => {
    for (let address = 1; address <= 12; address++) {
      const headers = {
        origin: server.url,
        "x-conformance-client": `192.0.2.${address}`,
      };
      for (let attempt = 0; attempt < 10; attempt++) {
        const wrong = await post(
          "/setup/exchange",
          { code: "invalid-code" },
          headers,
        );
        expect(wrong.status).toBe(401);
        expect(await errorCode(wrong)).toBe("setup_proof_invalid");
      }
      expect((await post("/setup/exchange", { code }, headers)).status).toBe(
        429,
      );
    }
    const ticket = await local("/_control/setup/ticket", {});
    expect(ticket.status).toBe(200);
    expect(ticket.body.url).toBe(
      `${server.url}/setup#handoff=${ticket.body.ticket}`,
    );
    const headers = { origin: server.url, "x-conformance-client": "192.0.2.1" };
    const exchanged = await post(
      "/setup/exchange",
      { ticket: ticket.body.ticket },
      headers,
    );
    expect(exchanged.status).toBe(200);
    const setCookie = exchanged.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=900");
    const setupCookie = exchanged.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const spent = await post(
      "/setup/exchange",
      { ticket: ticket.body.ticket },
      headers,
    );
    expect(spent.status).toBe(401);
    expect(await errorCode(spent)).toBe("setup_proof_invalid");
    expect(
      (
        await fetch(`${server.url}/owner/passkeys`, {
          headers: { cookie: setupCookie },
        })
      ).status,
    ).toBe(401);
    for (let refresh = 0; refresh < 2; refresh++) {
      const page = await fetch(`${server.url}/setup`, {
        headers: { cookie: setupCookie },
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toContain("no-store");
      expect(await page.text()).toContain('id="owner-form"');
    }
    const pending = await local("/_control/setup/ticket", {});
    code = (await local("/_control/setup/code", {})).body.code as string;
    expect(
      (
        await post("/setup/claim", OWNER, {
          cookie: setupCookie,
          origin: server.url,
        })
      ).status,
    ).toBe(401);
    expect(
      (await post("/setup/exchange", { ticket: pending.body.ticket }, headers))
        .status,
    ).toBe(401);
    const fresh = await post(
      "/setup/exchange",
      { code },
      { origin: server.url, "x-conformance-client": "192.0.2.200" },
    );
    expect(fresh.status).toBe(200);
    const log = serverOutput(state);
    expect(log).toContain("/setup/exchange");
    for (const secret of [
      code,
      ticket.body.ticket,
      pending.body.ticket,
      OWNER.password,
    ])
      expect(log).not.toContain(secret);
  });

  it("refuses cross-origin exchange without consuming a handoff", async () => {
    const issued = await local("/_control/setup/ticket", {});
    const body = { ticket: issued.body.ticket };
    for (const origin of ["https://elsewhere.example", "null"]) {
      expect((await post("/setup/exchange", body, { origin })).status).toBe(
        403,
      );
    }
    expect((await post("/setup/exchange", body)).status).toBe(403);
    expect(
      (await post("/setup/exchange", body, { origin: server.url })).status,
    ).toBe(200);
  });

  it("answers an exchange sent as JSON with only ok, and the setup cookie", async () => {
    const issued = await local("/_control/setup/ticket", {});
    const exchanged = await post(
      "/setup/exchange",
      { ticket: issued.body.ticket },
      { origin: server.url },
    );
    expect(exchanged.status).toBe(200);
    expect(await exchanged.json()).toEqual({ ok: true });
    expect(exchanged.headers.get("set-cookie")).toMatch(/^marfa_setup=[^;]+;/);
  });

  it("expires a handoff after five minutes while its exchanged setup session remains usable", async () => {
    const start = Date.now();
    const expired = await local("/_control/setup/ticket", {});
    const live = await local("/_control/setup/ticket", {});
    expect(typeof expired.body.expires_at).toBe("string");
    const deadline = Date.parse(expired.body.expires_at as string);
    expect(Number.isNaN(deadline)).toBe(false);
    expect(deadline - start).toBeGreaterThanOrEqual(300_000);
    expect(deadline - start).toBeLessThan(301_000);
    const exchanged = await post(
      "/setup/exchange",
      { ticket: live.body.ticket },
      { origin: server.url },
    );
    expect(exchanged.status).toBe(200);
    const setupCookie = exchanged.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, deadline - Date.now() + 100)),
    );
    expect(
      (
        await post(
          "/setup/exchange",
          { ticket: expired.body.ticket },
          { origin: server.url },
        )
      ).status,
    ).toBe(401);
    const page = await fetch(`${server.url}/setup`, {
      headers: { cookie: setupCookie },
    });
    expect(await page.text()).toContain('id="owner-form"');
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  }, 330_000);

  it("replaces unclaimed setup proof on restart", async () => {
    const earlier = code;
    await stopServer({ state });
    server = await bootUnclaimedServer({ state });
    vi.stubEnv("MARFA_API_URL", server.url);
    expect(
      (
        await post(
          "/setup/exchange",
          { code: earlier },
          { origin: server.url, "x-conformance-client": "192.0.2.201" },
        )
      ).status,
    ).toBe(401);
    const recorded = async (action: string): Promise<number> =>
      ((await local(`/audit?action=${action}`)).body.data as unknown[]).length;
    const issuedBefore = await recorded("instance.setup_code.issued");
    code = (await local("/_control/setup/code", {})).body.code as string;
    expect(
      await recorded("instance.setup_code.issued"),
      "the code was answered before its issue was recorded",
    ).toBe(issuedBefore + 1);
    const exchangedBefore = await recorded("instance.setup_code.exchanged");
    expect(
      (
        await post(
          "/setup/exchange",
          { code },
          { origin: server.url, "x-conformance-client": "192.0.2.201" },
        )
      ).status,
    ).toBe(200);
    expect(
      await recorded("instance.setup_code.exchanged"),
      "the exchange was answered before it was recorded",
    ).toBe(exchangedBefore + 1);
  });

  it("validates the password without consuming valid setup proof", async () => {
    for (const password of ["short", "x".repeat(1000)]) {
      const refused = await post("/owner", { ...OWNER, password, code });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error.code).toBe("validation_error");
    }
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it("refuses a username that is not 1 to 64 letters, numbers, dots, dashes and underscores without consuming valid setup proof", async () => {
    for (const username of [
      "owner@example.test",
      "two words",
      "hidden\u200bcharacter",
      "émile",
      "",
      "   ",
      "o".repeat(65),
    ]) {
      const refused = await post("/owner", { ...OWNER, username, code });
      expect(refused.status, JSON.stringify(username)).toBe(400);
      const { error } = await refused.json();
      expect(error.code).toBe("validation_error");
      expect(error.details.errors[0].path).toBe("username");
    }
    const noUsername = await post("/owner", {
      password: OWNER.password,
      code,
    });
    expect(noUsername.status).toBe(400);
    const badEmail = await post("/owner", {
      ...OWNER,
      email: "not an email",
      code,
    });
    expect(badEmail.status).toBe(400);
    expect((await badEmail.json()).error.details.errors[0].path).toBe("email");
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it("refuses an empty email, and an email that is not a string or null, naming email on every claim route without consuming valid setup proof", async () => {
    const refusals: [unknown, string][] = [
      ["", "Enter a valid email address."],
      [42, "Must be a string or null."],
      [true, "Must be a string or null."],
      [["owner@example.test"], "Must be a string or null."],
      [{}, "Must be a string or null."],
    ];
    for (const [email, message] of refusals) {
      const claims: [string, Response][] = [
        ["POST /owner", await post("/owner", { ...OWNER, email, code })],
        [
          "POST /setup/claim",
          await post("/setup/claim", { ...OWNER, email, code }),
        ],
      ];
      for (const [route, refused] of claims) {
        const where = `${route} with email ${JSON.stringify(email)}`;
        expect(refused.status, where).toBe(400);
        const { error } = await refused.json();
        expect(error.code, where).toBe("validation_error");
        expect(error.details.errors, where).toEqual([
          { path: "email", message },
        ]);
      }
      const socket = await local("/_control/setup/claim", { ...OWNER, email });
      const where = `the socket with email ${JSON.stringify(email)}`;
      expect(socket.status, where).toBe(400);
      const refusal = socket.body as {
        error: { code: string; details: { errors: unknown[] } };
      };
      expect(refusal.error.code, where).toBe("validation_error");
      expect(refusal.error.details.errors, where).toEqual([
        { path: "email", message },
      ]);
    }
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it(
    "claims with a null email as it does with none, on every claim route",
    async () => {
      const routes: [
        string,
        (instance: FreshInstance) => Promise<{ status: number; body: unknown }>,
      ][] = [
        [
          "POST /owner",
          async (instance) => {
            const response = await fetch(`${instance.url}/owner`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ...OWNER,
                email: null,
                code: await instance.code(),
              }),
            });
            return { status: response.status, body: await response.json() };
          },
        ],
        [
          "POST /setup/claim",
          async (instance) => {
            const response = await fetch(`${instance.url}/setup/claim`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ...OWNER,
                email: null,
                code: await instance.code(),
              }),
            });
            return { status: response.status, body: await response.json() };
          },
        ],
        [
          "the socket",
          (instance) =>
            controlRequest(instance.controlSocket, "/_control/setup/claim", {
              method: "POST",
              body: { ...OWNER, email: null },
            }),
        ],
      ];
      for (const [route, claim] of routes) {
        await withFreshInstance(async (instance) => {
          const claimed = await claim(instance);
          expect(claimed.status, route).toBe(201);
          expect(claimed.body, route).toMatchObject({
            username: OWNER.username,
            email: null,
          });
          const profile = await controlRequest(
            instance.controlSocket,
            "/profile",
          );
          expect(profile.body, route).toMatchObject({ email: null });
        });
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it("refuses a key the claim does not declare without consuming valid setup proof", async () => {
    for (const key of ["bogus", "_trace"]) {
      const refused = await post("/owner", { ...OWNER, code, [key]: 1 });
      expect(refused.status).toBe(400);
      const { error } = await refused.json();
      expect(error.code).toBe("validation_error");
      expect(error.details.unknown_body_fields).toEqual([key]);
    }
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it("refuses a key the setup doors do not declare, in a JSON or a form body, without consuming valid setup proof", async () => {
    const origin = new URL(server.url).origin;
    for (const [path, fields] of [
      ["/setup/exchange", { code }],
      ["/setup/claim", { ...OWNER, code }],
    ] as const) {
      const refused = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        body: new URLSearchParams({
          ...fields,
          // Typed twice and not alike, so the key the page does not declare is judged first.
          ...("password" in fields
            ? { confirm_password: `${fields.password}!` }
            : {}),
          bogus: "1",
        }),
      });
      expect(refused.status, `${path} as a form`).toBe(400);
      const { error } = await refused.json();
      expect(error.code).toBe("validation_error");
      expect(error.details.unknown_body_fields).toEqual(["bogus"]);
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
    for (const [path, body] of [
      ["/setup/exchange", { code }],
      ["/setup/claim", { ...OWNER, code }],
    ] as const) {
      for (const key of ["bogus", "_trace"]) {
        const refused = await post(path, { ...body, [key]: 1 }, { origin });
        expect(refused.status, `${path} ${key}`).toBe(400);
        const { error } = await refused.json();
        expect(error.code).toBe("validation_error");
        expect(error.details.unknown_body_fields).toEqual([key]);
        expect(refused.headers.get("set-cookie")).toBeNull();
      }
    }
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it("creates exactly one owner and reads it through the local command", async () => {
    const attempts = await Promise.all(
      [0, 1].map(() =>
        post("/owner", {
          ...OWNER,
          username: " Owner ",
          email: "Owner@Example.test",
          code,
        }),
      ),
    );
    expect(attempts.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const claim = attempts.find((response) => response.status === 201)!;
    const owner = await claim.json();
    await expectMatchesSchema("POST", "/owner", 201, owner);
    expect(owner).toMatchObject({
      username: OWNER.username,
      email: "owner@example.test",
      name: OWNER.username,
    });
    ownerId = owner.id;
    const audit = await local("/audit?action=owner.claimed");
    expect(audit.status).toBe(200);
    expect(audit.body.data).toEqual([
      expect.objectContaining({
        action: "owner.claimed",
        resource_id: ownerId,
      }),
    ]);
    expect((await local("/_control/setup/status")).body).toMatchObject({
      claimed: true,
      owner_id: ownerId,
    });
    expect(Number.isNaN(Date.parse(owner.created_at))).toBe(false);
    const login = await signInAs(OWNER);
    expect(signInOutcome(login)).toBe("signed_in");
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(
      (await fetch(`${server.url}/owner/passkeys`, { headers: { cookie } }))
        .status,
    ).toBe(200);
    const read = await local("/profile");
    expect(read.status).toBe(200);
    await expectMatchesSchema("GET", "/profile", 200, read.body);
    expect(read.body).toEqual({
      name: owner.name,
      username: owner.username,
      email: owner.email,
      avatar: owner.avatar,
    });
    expect((await local("/_control/setup/status")).body.owner_id).toBe(
      owner.id,
    );
    expect((await post("/setup/claim", { ...OWNER, code })).status).toBe(409);
    expect((await local("/_control/setup/code", {})).status).toBe(409);
  });

  it("ordinary full management access cannot claim the instance", async () => {
    const minted = await local("/keys", {
      label: "Instance management",
      source: "owner-test",
      permissions: [
        "schema.write",
        "keys.mint",
        "items.purge",
        "webhooks.manage",
        "config.manage",
        "audit.read",
        "grants.manage",
        "keys.manage",
        "connectors.manage",
        "instance.read",
        "blobs.manage",
        "instance.maintain",
        "backups.manage",
        "sign_ins.manage",
      ],
      type_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
    });
    expect(minted.status).toBe(201);
    const key = minted.body.key as string;
    managementKey = key;
    expect(typeof key).toBe("string");
    // The witness: the same claim with no credential, as a stranger sends it.
    const stranger = await post("/owner", { ...OWNER, code });
    expect(stranger.status).toBeGreaterThanOrEqual(400);
    const claim = await post(
      "/owner",
      { ...OWNER, code },
      { authorization: `Bearer ${key}` },
    );
    expect(claim.status).toBe(stranger.status);
    expect(await errorCode(claim)).toBe(await errorCode(stranger));
  });

  it("recovers the existing owner and ends the old browser session", async () => {
    const password = "replacement owner password";
    const other = await signInAs(OWNER);
    expect(signInOutcome(other)).toBe("signed_in");
    const otherCookie = other.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const lockedAddress = {
      origin: server.url,
      "x-conformance-client": "192.0.2.220",
    };
    for (let i = 0; i < 10; i++)
      expect(
        signInOutcome(
          await signInAs(
            { ...OWNER, password: "incorrect owner password" },
            lockedAddress,
          ),
        ),
      ).toBe("invalid_credentials");
    // Then the address's own limit across every username, so that no username
    // signs in from it.
    for (let i = 0; i < 20; i++)
      expect(
        signInOutcome(
          await signInAs(
            { username: `stranger-${String(i)}`, password },
            lockedAddress,
          ),
        ),
      ).not.toBe("signed_in");
    expect(signInOutcome(await signInAs(OWNER, lockedAddress))).toBe(
      "too_many_attempts",
    );
    expect(
      signInOutcome(
        await signInAs({ username: "stranger-new", password }, lockedAddress),
      ),
    ).toBe("too_many_attempts");
    expect((await local("/_control/owner/recover", { password })).status).toBe(
      200,
    );
    expect(
      (await fetch(`${server.url}/owner/passkeys`, { headers: { cookie } }))
        .status,
    ).toBe(401);
    expect(signInOutcome(await signInAs(OWNER))).toBe("invalid_credentials");
    expect(signInOutcome(await signInAs({ ...OWNER, password }))).toBe(
      "signed_in",
    );
    expect(
      (
        await fetch(`${server.url}/owner/passkeys`, {
          headers: { cookie: otherCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      signInOutcome(await signInAs({ ...OWNER, password }, lockedAddress)),
    ).toBe("signed_in");
    expect(
      (
        await fetch(`${server.url}/keys/current`, {
          headers: { authorization: `Bearer ${managementKey}` },
        })
      ).status,
    ).toBe(200);
    expect((await local("/_control/setup/status")).body.owner_id).toBe(ownerId);
    expect((await post("/setup/claim", { ...OWNER, code })).status).toBe(409);
  });
  it("keeps a completed claim and recovered password through restart", async () => {
    await stopServer({ state });
    server = await bootUnclaimedServer({ state });
    vi.stubEnv("MARFA_API_URL", server.url);
    expect((await local("/_control/setup/status")).body).toMatchObject({
      claimed: true,
      owner_id: ownerId,
    });
    expect((await local("/_control/setup/code", {})).status).toBe(409);
    expect((await post("/setup/claim", { ...OWNER, code })).status).toBe(409);
    expect(
      signInOutcome(
        await signInAs({ ...OWNER, password: "replacement owner password" }),
      ),
    ).toBe("signed_in");
    expect(
      (
        await fetch(`${server.url}/keys/current`, {
          headers: { authorization: `Bearer ${managementKey}` },
        })
      ).status,
    ).toBe(200);
  });
});

/**
 * A fresh unclaimed server on its own state folder, for a test that claims it.
 * The claim happens once, so each way of claiming needs an instance of its own.
 */
type FreshInstance = {
  url: string;
  controlSocket: string;
  code: () => Promise<string>;
  ticket: () => Promise<string>;
};
async function withFreshInstance(
  run: (instance: FreshInstance) => Promise<void>,
): Promise<void> {
  const freshState = tempFolder("marfa-owner-session-");
  let booted = false;
  try {
    const fresh = await bootUnclaimedServer({ state: freshState });
    booted = true;
    const control = (path: string) =>
      controlRequest(fresh.controlSocket, path, { method: "POST", body: {} });
    await run({
      url: fresh.url,
      controlSocket: fresh.controlSocket,
      code: async () =>
        (await control("/_control/setup/code")).body.code as string,
      ticket: async () =>
        (await control("/_control/setup/ticket")).body.ticket as string,
    });
  } finally {
    if (booted) await stopServer({ state: freshState });
    await rm(freshState, { recursive: true, force: true });
  }
}
const sessionCookies = (response: Response): string[] =>
  response.headers
    .getSetCookie()
    .filter((value) => value.includes("marfa_session="));
const cookieHeader = (cookies: string[]): string =>
  cookies.map((value) => value.split(";")[0]).join("; ");
/** What a cookie's attributes say, apart from its value and its clock-dependent expiry. */
const cookieShape = (cookie: string): string[] =>
  cookie
    .split(";")
    .slice(1)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => !part.startsWith("expires="))
    .sort();

describe("signing the owner in at the claim", () => {
  it(
    "signs the owner in when a claim comes from the instance's own origin and refuses a session to a claim that fails",
    async () => {
      await withFreshInstance(async (instance) => {
        const origin = instance.url;
        const code = await instance.code();
        const claim = (body: unknown, headers: Record<string, string>) =>
          fetch(`${instance.url}/owner`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          });
        const refusals: [string, Response][] = [
          [
            "a wrong code",
            await claim({ ...OWNER, code: "WRONG-CODE" }, { origin }),
          ],
          ["no proof at all", await claim(OWNER, { origin })],
          [
            "a password that is too short",
            await claim({ ...OWNER, password: "short", code }, { origin }),
          ],
          [
            "another origin",
            await claim(
              { ...OWNER, code },
              { origin: "https://elsewhere.example" },
            ),
          ],
        ];
        expect(refusals.map(([, r]) => r.status)).toEqual([401, 401, 400, 403]);
        for (const [what, refused] of refusals)
          expect(sessionCookies(refused), what).toEqual([]);

        const claimed = await claim({ ...OWNER, code }, { origin });
        expect(claimed.status).toBe(201);
        const owner = await claimed.json();
        // The witness for the refusals above: the same request, valid, does set one.
        const session = sessionCookies(claimed);
        expect(session).toHaveLength(1);
        const read = await fetch(`${instance.url}/owner/passkeys`, {
          headers: { cookie: cookieHeader(session) },
        });
        expect(read.status).toBe(200);
        expect(
          (await controlRequest(instance.controlSocket, "/profile")).body,
        ).toEqual({
          name: owner.name,
          username: owner.username,
          email: owner.email,
          avatar: owner.avatar,
        });

        const login = await postSignInForm(instance.url, origin, OWNER);
        expect(signInOutcome(login)).toBe("signed_in");
        expect(cookieShape(session[0]!)).toEqual(
          cookieShape(sessionCookies(login)[0]!),
        );
        expect(session[0]!.split("=")[0]).toBe(
          sessionCookies(login)[0]!.split("=")[0],
        );

        // The claim's session is a sign-in within the last fifteen minutes, which
        // removing a passkey needs. No passkey has this ID.
        const removed = await fetch(`${instance.url}/owner/passkeys/absent`, {
          method: "DELETE",
          headers: { origin, cookie: cookieHeader(session) },
        });
        expect(removed.status, await removed.clone().text()).toBe(404);

        const repeated = await claim({ ...OWNER, code }, { origin });
        expect(repeated.status).toBe(409);
        expect(sessionCookies(repeated)).toEqual([]);
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "creates the owner from the setup page's form, and shows a refused username on the page again",
    async () => {
      await withFreshInstance(async (instance) => {
        const origin = instance.url;
        const exchanged = await fetch(`${instance.url}/setup/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ ticket: await instance.ticket() }),
        });
        expect(exchanged.status).toBe(200);
        const cookie = cookieHeader(exchanged.headers.getSetCookie());
        const form = (fields: Record<string, string>) =>
          fetch(`${instance.url}/setup/claim`, {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "text/html",
              origin,
              cookie,
            },
            body: new URLSearchParams(fields),
          });
        const refused = await form({
          name: "",
          username: "not a username",
          password: OWNER.password,
          confirm_password: OWNER.password,
        });
        expect(refused.status).toBe(400);
        const page = await refused.text();
        expect(markedInvalid(page, "username")).toBe(true);
        expect(describedWords(page, "username")).toHaveLength(1);
        expect(describedWords(page, "username")[0]).not.toBe("");
        expect(markedInvalid(page, "password")).toBe(false);
        expect(page).toContain('value="not a username"');
        expect(page).not.toContain(OWNER.password);
        const claimed = await form({
          name: "",
          username: "Form.Owner",
          password: OWNER.password,
          confirm_password: OWNER.password,
        });
        expect(claimed.status).toBe(303);
        expect(claimed.headers.get("location")).toBe("/auth/sign-in");
        const profile = await controlRequest(
          instance.controlSocket,
          "/profile",
        );
        expect(profile.body).toMatchObject({
          username: "form.owner",
          email: null,
          name: "form.owner",
        });
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "signs the owner in when the setup page claims through its setup session",
    async () => {
      await withFreshInstance(async (instance) => {
        const origin = instance.url;
        const post = (path: string, body: unknown, cookie?: string) =>
          fetch(`${instance.url}${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin,
              ...(cookie ? { cookie } : {}),
            },
            body: JSON.stringify(body),
          });
        const exchanged = await post("/setup/exchange", {
          ticket: await instance.ticket(),
        });
        expect(exchanged.status).toBe(200);
        const setupCookie = cookieHeader(exchanged.headers.getSetCookie());
        expect(sessionCookies(exchanged)).toEqual([]);
        const claimed = await post("/setup/claim", OWNER, setupCookie);
        expect(claimed.status).toBe(201);
        const session = sessionCookies(claimed);
        expect(session).toHaveLength(1);
        expect(
          claimed.headers
            .getSetCookie()
            .some((value) => /^marfa_setup=;.*Max-Age=0/i.test(value)),
        ).toBe(true);
        const read = await fetch(`${instance.url}/owner/passkeys`, {
          headers: { cookie: cookieHeader(session) },
        });
        expect(read.status).toBe(200);
        // The spent setup session signs in nothing.
        const again = await post("/setup/claim", OWNER, setupCookie);
        expect(again.status).toBe(409);
        expect(sessionCookies(again)).toEqual([]);
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "leaves a script that claims with a setup code without a session",
    async () => {
      await withFreshInstance(async (instance) => {
        const claimed = await fetch(`${instance.url}/owner`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...OWNER, code: await instance.code() }),
        });
        expect(claimed.status).toBe(201);
        expect(sessionCookies(claimed)).toEqual([]);
        // The owner exists, so the missing cookie is the rule and not a failed claim.
        const login = await postSignInForm(instance.url, instance.url, OWNER);
        expect(signInOutcome(login)).toBe("signed_in");
        expect(sessionCookies(login)).toHaveLength(1);
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a claim whose sign-in fails", () => {
  it(
    "keeps the owner and sets no session when the sign-in that follows the claim is refused",
    async () => {
      await withFreshInstance(async (instance) => {
        const origin = instance.url;
        const address = { "x-conformance-client": "192.0.2.230" };
        const signIn = (password: string, headers: Record<string, string>) =>
          postSignInForm(
            instance.url,
            origin,
            { ...OWNER, password },
            { ...headers },
          );
        // An address that has spent its password attempts is refused its next sign-in.
        for (let i = 0; i < 10; i++)
          expect(
            signInOutcome(await signIn("incorrect owner password", address)),
          ).toBe("invalid_credentials");
        expect(signInOutcome(await signIn(OWNER.password, address))).toBe(
          "too_many_attempts",
        );

        const claimed = await fetch(`${instance.url}/owner`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            ...address,
          },
          body: JSON.stringify({ ...OWNER, code: await instance.code() }),
        });
        expect(claimed.status).toBe(201);
        expect(sessionCookies(claimed)).toEqual([]);

        // The witness: the owner exists and the same password signs in from an address that is not locked.
        const elsewhere = await signIn(OWNER.password, {
          "x-conformance-client": "192.0.2.231",
        });
        expect(signInOutcome(elsewhere)).toBe("signed_in");
        expect(sessionCookies(elsewhere)).toHaveLength(1);
      });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("claiming through the private socket", () => {
  it(
    "answers the setup routes in snake_case and the claim as the public claim does",
    async () => {
      const socketState = tempFolder("marfa-owner-socket-conformance-");
      let booted = false;
      try {
        const socketServer = await bootUnclaimedServer({ state: socketState });
        booted = true;
        const control = (path: string, body?: unknown) =>
          controlRequest(
            socketServer.controlSocket,
            path,
            body === undefined ? {} : { method: "POST", body },
          );
        const before = await control("/_control/setup/status");
        expect(before.status).toBe(200);
        expect(Object.keys(before.body).sort()).toEqual([
          "claimed",
          "generation",
          "owner_id",
        ]);
        expect(before.body.owner_id).toBeNull();
        expect(typeof before.body.generation).toBe("string");
        const ticket = await control("/_control/setup/ticket", {});
        expect(ticket.status).toBe(200);
        expect(Object.keys(ticket.body).sort()).toEqual([
          "expires_at",
          "ticket",
          "url",
        ]);
        expect(ticket.body.expires_at).toBe(
          new Date(Date.parse(ticket.body.expires_at as string)).toISOString(),
        );
        const longest = `Socket.${"o".repeat(57)}`;
        const claim = await control("/_control/setup/claim", {
          username: longest,
          password: "correct horse battery",
          name: "socket owner",
        });
        expect(claim.status).toBe(201);
        expect(Object.keys(claim.body).sort()).toEqual([
          "avatar",
          "created_at",
          "email",
          "id",
          "name",
          "username",
        ]);
        expect(claim.body).toMatchObject({
          avatar: null,
          username: longest.toLowerCase(),
          email: null,
          name: "socket owner",
        });
        expect(typeof claim.body.id).toBe("string");
        expect(typeof claim.body.created_at).toBe("string");
        expect(Number.isNaN(Date.parse(claim.body.created_at as string))).toBe(
          false,
        );
        await expectMatchesSchema("POST", "/owner", 201, claim.body);
        const profile = await control("/profile");
        expect(profile.status).toBe(200);
        expect(profile.body).toMatchObject({
          username: longest.toLowerCase(),
          email: null,
        });
        const after = await control("/_control/setup/status");
        expect(after.body).toMatchObject({
          claimed: true,
          owner_id: claim.body.id,
        });
        expect(after.body.generation).toBeNull();
      } finally {
        if (booted) await stopServer({ state: socketState });
        await rm(socketState, { recursive: true, force: true });
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
