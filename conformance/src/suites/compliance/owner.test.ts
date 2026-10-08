import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { FRESH_SERVER_TIMEOUT_MS } from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let state: string;
let server: { url: string; controlSocket: string };
let code: string;
let ownerId: string;
let cookie: string;
let managementKey: string;
const OWNER = {
  email: "owner@example.test",
  password: "correct horse battery",
};

beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "marfa-owner-conformance-"));
  vi.stubEnv("TRUSTED_PROXY_HEADER", "x-conformance-client");
  server = await bootUnclaimedServer({ state });
  vi.stubEnv("MARFA_API_URL", server.url);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  vi.unstubAllEnvs();
  if (state) {
    await stopServer({ state });
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
    expect((await local("/owner")).status).toBe(404);
    expect((await fetch(`${server.url}/owner`)).status).toBe(401);
    expect((await post("/setup/claim", OWNER)).status).toBe(401);
    expect(
      (await post("/auth/sign-in/email", OWNER, { origin: server.url })).status,
    ).toBe(401);
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
      (await post("/setup/claim", { ...OWNER, code: first.body.code })).status,
    ).toBe(401);
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it("limits code guesses per address without an instance-wide cap and accepts handoffs past the limit", async () => {
    for (let address = 1; address <= 12; address++) {
      const headers = {
        origin: server.url,
        "x-conformance-client": `192.0.2.${address}`,
      };
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(
          (await post("/setup/exchange", { code: "invalid-code" }, headers))
            .status,
        ).toBe(401);
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
    expect(
      (await post("/setup/exchange", { ticket: ticket.body.ticket }, headers))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`${server.url}/owner`, { headers: { cookie: setupCookie } }))
        .status,
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
    const log = await readFile(join(state, "server.log"), "utf8");
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

  it("expires a handoff after five minutes while its exchanged setup session remains usable", async () => {
    const start = Date.now();
    const expired = await local("/_control/setup/ticket", {});
    const live = await local("/_control/setup/ticket", {});
    const deadline = expired.body.expiresAt as number;
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

  it("keeps code-attempt counters through restart and replaces unclaimed setup proof", async () => {
    const earlier = code;
    await stopServer({ state });
    server = await bootUnclaimedServer({ state });
    vi.stubEnv("MARFA_API_URL", server.url);
    expect(
      (
        await post(
          "/setup/exchange",
          { code: earlier },
          { origin: server.url, "x-conformance-client": "192.0.2.1" },
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await post(
          "/setup/exchange",
          { code: earlier },
          { origin: server.url, "x-conformance-client": "192.0.2.201" },
        )
      ).status,
    ).toBe(401);
    code = (await local("/_control/setup/code", {})).body.code as string;
    expect(
      (
        await post(
          "/setup/exchange",
          { code },
          { origin: server.url, "x-conformance-client": "192.0.2.201" },
        )
      ).status,
    ).toBe(200);
  });

  it("validates the password without consuming valid setup proof", async () => {
    for (const password of ["short", "x".repeat(1000)]) {
      const refused = await post("/owner", { ...OWNER, password, code });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error.code).toBe("validation_error");
    }
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it("creates exactly one owner and requires owner sign-in to read it", async () => {
    const attempts = await Promise.all(
      [0, 1].map(() =>
        post("/owner", {
          ...OWNER,
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
    expect(owner).toMatchObject({ email: OWNER.email, name: "owner" });
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
      ownerId,
    });
    expect(Number.isNaN(Date.parse(owner.created_at))).toBe(false);
    const login = await post("/auth/sign-in/email", OWNER, {
      origin: server.url,
    });
    expect(login.status).toBe(200);
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const read = await fetch(`${server.url}/owner`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(owner);
    expect((await post("/setup/claim", { ...OWNER, code })).status).toBe(409);
    expect((await local("/_control/setup/code", {})).status).toBe(409);
  });

  it("ordinary full management access cannot become the owner", async () => {
    const minted = await post(
      "/keys",
      {
        label: "Instance management",
        source: "owner-test",
        permissions: [
          "keys.manage",
          "connectors.manage",
          "instance.read",
          "blobs.manage",
          "instance.maintain",
        ],
        type_permissions: {},
        edge_permissions: {},
        metadata_permissions: {},
        profile_permissions: {},
      },
      { cookie, origin: server.url },
    );
    expect(minted.status).toBe(201);
    const key = (await minted.json()).key;
    managementKey = key;
    expect(typeof key).toBe("string");
    const read = await fetch(`${server.url}/owner`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(read.status).toBe(403);
    const mixed = await fetch(`${server.url}/owner`, {
      headers: { cookie, authorization: `Bearer ${key}` },
    });
    expect(mixed.status).toBe(403);
  });

  it("recovers the existing owner and ends the old browser session", async () => {
    const password = "replacement owner password";
    const other = await post("/auth/sign-in/email", OWNER, {
      origin: server.url,
    });
    expect(other.status).toBe(200);
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
        (
          await post(
            "/auth/sign-in/email",
            { ...OWNER, password: "incorrect owner password" },
            lockedAddress,
          )
        ).status,
      ).toBe(401);
    expect(
      (await post("/auth/sign-in/email", OWNER, lockedAddress)).status,
    ).toBe(429);
    expect((await local("/_control/owner/recover", { password })).status).toBe(
      200,
    );
    expect(
      (await fetch(`${server.url}/owner`, { headers: { cookie } })).status,
    ).toBe(401);
    expect(
      (await post("/auth/sign-in/email", OWNER, { origin: server.url })).status,
    ).toBe(401);
    expect(
      (
        await post(
          "/auth/sign-in/email",
          { ...OWNER, password },
          { origin: server.url },
        )
      ).status,
    ).toBe(200);
    expect(
      (await fetch(`${server.url}/owner`, { headers: { cookie: otherCookie } }))
        .status,
    ).toBe(401);
    expect(
      (await post("/auth/sign-in/email", { ...OWNER, password }, lockedAddress))
        .status,
    ).toBe(200);
    expect(
      (
        await fetch(`${server.url}/keys/current`, {
          headers: { authorization: `Bearer ${managementKey}` },
        })
      ).status,
    ).toBe(200);
    expect((await local("/owner")).body.id).toBe(ownerId);
    expect((await post("/setup/claim", { ...OWNER, code })).status).toBe(409);
  });
  it("keeps a completed claim and recovered password through restart", async () => {
    await stopServer({ state });
    server = await bootUnclaimedServer({ state });
    vi.stubEnv("MARFA_API_URL", server.url);
    expect((await local("/_control/setup/status")).body).toMatchObject({
      claimed: true,
      ownerId,
    });
    expect((await local("/_control/setup/code", {})).status).toBe(409);
    expect((await post("/setup/claim", { ...OWNER, code })).status).toBe(409);
    expect(
      (
        await post(
          "/auth/sign-in/email",
          { ...OWNER, password: "replacement owner password" },
          { origin: server.url },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${server.url}/keys/current`, {
          headers: { authorization: `Bearer ${managementKey}` },
        })
      ).status,
    ).toBe(200);
  });
});
