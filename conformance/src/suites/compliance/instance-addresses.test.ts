import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * The instance's addresses and the list of its settings (the instance
 * chapter's `instance/addresses-*`, `instance/sign-in-address-*`,
 * `instance/address-check-*` and `instance/settings-listed-*` rules).
 *
 * **On a server of the fixture's own.** An address is the instance's, and
 * moving the sign-in address ends the sessions every other file on the run's
 * server relies on.
 */
let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("instance-addresses");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

interface Answer {
  status: number;
  body: any;
}

type Authority = "key" | "owner" | "socket";

async function call(
  authority: Authority,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  if (authority === "socket") {
    return controlRequest(server.controlSocket, path, { method, body });
  }
  const headers: Record<string, string> = {};
  if (authority === "owner") {
    headers.Cookie = server.ownerCookie;
    headers.Origin = new URL(server.apiUrl).origin;
  } else {
    headers.Authorization = `Bearer ${server.managementKey}`;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function config(): Promise<Record<string, any>> {
  const read = await call("key", "GET", "/config");
  expect(read.status).toBe(200);
  return read.body;
}

const SIGN_IN = "https://marfa.example";

describe("an address", () => {
  it("is an origin: one with a path, a query, a fragment, a user name or another scheme is refused", async () => {
    for (const wrong of [
      "https://a.example/path",
      "https://a.example/?q=1",
      "https://a.example/#top",
      "https://user:pass@a.example",
      "ftp://a.example",
      "a.example",
    ]) {
      const answer = await call("key", "PATCH", "/config", {
        addresses: [wrong],
      });
      expect(answer.status, wrong).toBe(400);
      expect(answer.body.error.code, wrong).toBe("validation_error");
    }
    expect(await config()).not.toHaveProperty("addresses");
  });

  it("is stored in its plainest spelling, with a lowercase host, no default port and no trailing slash", async () => {
    // The list must include the fallback sign-in address.
    const own = new URL(server.apiUrl).origin;
    // The witness: the same origin spelled plainly is stored as written.
    const answer = await call("key", "PATCH", "/config", {
      addresses: [
        own,
        "HTTPS://A.Example:443/",
        "https://a.example",
        "http://b.example:8080",
      ],
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((await config()).addresses).toEqual([
      own,
      "https://a.example",
      "http://b.example:8080",
    ]);
    expect(
      (await call("key", "PATCH", "/config", { addresses: null })).status,
    ).toBe(200);
  });
});

describe("the addresses and the sign-in address in force", () => {
  it("are refused together when the list leaves out the instance's own address, though no sign-in address is stored", async () => {
    expect(await config()).not.toHaveProperty("sign_in_address");
    const own = new URL(server.apiUrl).origin;
    const answer = await call("key", "PATCH", "/config", {
      addresses: ["https://elsewhere.example"],
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(400);
    expect(answer.body.error.code).toBe("validation_error");
    expect(JSON.stringify(answer.body.error.details)).toContain("addresses");
    expect(JSON.stringify(answer.body.error.details)).toContain(own);
    expect(await config()).not.toHaveProperty("addresses");
    // The witness: the same list with the address in force is stored.
    const kept = await call("key", "PATCH", "/config", {
      addresses: [own, "https://elsewhere.example"],
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(
      (await call("key", "PATCH", "/config", { addresses: null })).status,
    ).toBe(200);
  });
});

describe("the sign-in address", () => {
  it("is always among the addresses, whether or not the list names it", async () => {
    const session = await call("owner", "PATCH", "/config", {
      sign_in_address: SIGN_IN,
      confirm_sign_in_address_change: true,
    });
    expect(session.status).toBe(401);
    expect(session.body.error.code).toBe("unauthorized");
    expect(await config()).not.toHaveProperty("sign_in_address");
    // The witness: the private socket moves the same address.
    const moved = await call("socket", "PATCH", "/config", {
      sign_in_address: SIGN_IN,
      confirm_sign_in_address_change: true,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const read = await config();
    expect(read.sign_in_address).toBe(SIGN_IN);
    expect(read.addresses).toContain(SIGN_IN);
  });

  it("is refused to a key, which holds config.manage but not direct authority", async () => {
    const answer = await call("key", "PATCH", "/config", {
      sign_in_address: "https://other.example",
      confirm_sign_in_address_change: true,
    });
    expect(answer.status).toBe(403);
    expect(answer.body.error.code).toBe("forbidden");
    expect((await config()).sign_in_address).toBe(SIGN_IN);
    const origins = await call("key", "PATCH", "/config", {
      cors_origins: ["https://app.example"],
    });
    expect(origins.status).toBe(403);
    expect(origins.body.error.code).toBe("forbidden");
    expect(await config()).not.toHaveProperty("cors_origins");
    // The witness: the private socket may change the same setting.
    const socket = await call("socket", "PATCH", "/config", {
      cors_origins: ["https://app.example"],
    });
    expect(socket.status, JSON.stringify(socket.body)).toBe(200);
    const unchanged = await call("key", "PATCH", "/config", {
      sign_in_address: SIGN_IN,
      cors_origins: ["https://app.example"],
    });
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
    const moved = await call("key", "PATCH", "/config", {
      sign_in_address: SIGN_IN,
      cors_origins: ["https://app.example", "https://more.example"],
    });
    expect(moved.status).toBe(403);
    expect(moved.body.error.code).toBe("forbidden");
    expect((await config()).cors_origins).toEqual(["https://app.example"]);
    expect(
      (await call("socket", "PATCH", "/config", { cors_origins: null })).status,
    ).toBe(200);
  });

  it("is not moved, and the answer names the consequences, until a write confirms it", async () => {
    const unconfirmed = await call("socket", "PATCH", "/config", {
      sign_in_address: "https://moved.example",
    });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error.code).toBe(
      "sign_in_address_change_unconfirmed",
    );
    const codes = unconfirmed.body.error.details.consequences.map(
      (consequence: { code: string }) => consequence.code,
    );
    expect(codes).toContain("browser_sessions_end");
    expect((await config()).sign_in_address).toBe(SIGN_IN);

    const confirmed = await call("socket", "PATCH", "/config", {
      sign_in_address: "https://moved.example",
      confirm_sign_in_address_change: true,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect((await config()).sign_in_address).toBe("https://moved.example");
  });
});

describe("an address check", () => {
  it("writes nothing, and answers the addresses after the change, whether it needs confirming and what it does", async () => {
    const before = await config();
    const answer = await call("key", "POST", "/config/address-check", {
      sign_in_address: "https://checked.example",
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({
      sign_in_address: "https://checked.example",
      requires_confirmation: true,
    });
    await expectMatchesSchema(
      "POST",
      "/config/address-check",
      200,
      answer.body,
    );
    expect(answer.body.addresses).toContain("https://checked.example");
    for (const consequence of answer.body.consequences) {
      expect(consequence).toEqual({
        code: expect.any(String),
        sentence: expect.any(String),
        count: expect.anything(),
      });
    }
    expect(await config()).toEqual(before);
  });

  it("names a dropped address as address_removed with no count, and needs no confirming for it", async () => {
    const current = (await config()).sign_in_address as string;
    const listed = await call("key", "PATCH", "/config", {
      addresses: [current, "https://dropped.example"],
    });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const answer = await call("key", "POST", "/config/address-check", {
      sign_in_address: current,
      addresses: [current],
    });
    expect(answer.status).toBe(200);
    expect(answer.body.requires_confirmation).toBe(false);
    expect(answer.body.consequences).toEqual([
      {
        code: "address_removed",
        sentence: expect.stringContaining("https://dropped.example"),
        count: null,
      },
    ]);
  });

  it("does not ask for confirming when the sign-in address is only spelled another way", async () => {
    const current = (await config()).sign_in_address as string;
    const spelled = `${current.toUpperCase()}:443/`;
    const answer = await call("key", "POST", "/config/address-check", {
      sign_in_address: spelled,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.requires_confirmation).toBe(false);
    expect(
      answer.body.consequences.map((c: { code: string }) => c.code),
    ).not.toContain("browser_sessions_end");
  });

  it("is refused for an address that is not an origin", async () => {
    const answer = await call("key", "POST", "/config/address-check", {
      sign_in_address: "https://a.example/path",
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe("validation_error");
  });
});

describe("the addresses and the sign-in address", () => {
  it("are refused together when the list leaves out the sign-in address", async () => {
    const current = (await config()).sign_in_address as string;
    const answer = await call("key", "PATCH", "/config", {
      addresses: ["https://elsewhere.example"],
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe("validation_error");
    expect(JSON.stringify(answer.body.error.details)).toContain(current);
  });
});

describe("the list of settings", () => {
  it("names every stored setting with its value, default and rule, and every start-only setting by environment name", async () => {
    const answer = await call("key", "GET", "/config/settings");
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    await expectMatchesSchema("GET", "/config/settings", 200, answer.body);
    const stored = new Map<string, any>(
      answer.body.data.map((entry: { key: string }) => [entry.key, entry]),
    );
    expect(stored.get("trash_retention_days")).toMatchObject({
      key: "trash_retention_days",
      value: 60,
      default: 60,
      rule: expect.any(String),
      description: expect.any(String),
      together: expect.any(Array),
    });
    expect(stored.get("sign_in_address").value).toBe("https://moved.example");
    expect(Array.isArray(answer.body.rules)).toBe(true);
    const startOnly = new Map<string, any>(
      answer.body.start_only.map((entry: { name: string }) => [
        entry.name,
        entry,
      ]),
    );
    expect(startOnly.get("MARFA_PORT")).toMatchObject({
      secret: false,
      set: true,
      description: expect.any(String),
    });
    expect(startOnly.get("MARFA_KEY_SALT")?.secret).toBe(true);
  });

  it("shows no value of a start-only setting", async () => {
    const answer = await call("key", "GET", "/config/settings");
    for (const entry of answer.body.start_only) {
      expect(Object.keys(entry).sort()).toEqual([
        "description",
        "name",
        "secret",
        "set",
      ]);
    }
  });

  it("is refused to a key that holds neither config.manage nor instance.read", async () => {
    const minted = await call("key", "POST", "/keys", {
      label: "settings-narrow",
      source: "settings-narrow",
      permissions: ["audit.read"],
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const answer = await fetch(`${server.apiUrl}/config/settings`, {
      headers: { Authorization: `Bearer ${minted.body.key as string}` },
    });
    expect(answer.status).toBe(403);
    expect(((await answer.json()) as any).error.code).toBe("forbidden");
  });

  it("is read through a private socket as it is through a key", async () => {
    const answer = await call("socket", "GET", "/config/settings");
    expect(answer.status).toBe(200);
    expect(answer.body.data.length).toBeGreaterThan(0);
  });
});
