import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
const OWNER = {
  email: "owner@example.test",
  password: "correct horse battery",
};

beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "marfa-owner-conformance-"));
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

  it("validates the password without consuming valid setup proof", async () => {
    for (const password of ["short", "x".repeat(1000)]) {
      const refused = await post("/owner", { ...OWNER, password, code });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error.code).toBe("validation_error");
    }
    expect((await local("/_control/setup/status")).body.claimed).toBe(false);
  });

  it("creates exactly one owner and requires owner sign-in to read it", async () => {
    const claim = await post("/owner", {
      ...OWNER,
      email: "Owner@Example.test",
      code,
    });
    expect(claim.status).toBe(201);
    const owner = await claim.json();
    await expectMatchesSchema("POST", "/owner", 201, owner);
    expect(owner).toMatchObject({ email: OWNER.email, name: "owner" });
    ownerId = owner.id;
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
    expect((await local("/owner")).body.id).toBe(ownerId);
    expect((await post("/setup/claim", { ...OWNER, code })).status).toBe(409);
  });
});
