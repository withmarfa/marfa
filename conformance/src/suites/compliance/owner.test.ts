import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * The owner door is the instance's whole history, not a row a file can
 * isolate: the first file to create the owner decides what every later one
 * sees, and a re-run against the run's server sees the last run. So this
 * file boots a server of its own and tells the story from the beginning.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;
let anonymous: MarfaClient;

const OWNER = { email: "owner@example.com", password: "correct horse battery" };

beforeAll(async () => {
  server = await bootFreshServer("owner");
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  anonymous = new MarfaClient({ baseUrl: server.apiUrl, apiKey: "" });
});

afterAll(() => {
  server.stop();
});

/**
 * The sign-in surface takes a browser's request, so it refuses one carrying
 * no `Origin` and one carrying an origin it does not trust. The origin it
 * trusts is its own, which the discovery document names as the issuer.
 */
async function signInOrigin(): Promise<string> {
  const response = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  expect(response.status).toBe(200);
  const { issuer } = (await response.json()) as { issuer: string };
  return new URL(issuer).origin;
}

async function signIn(
  email: string,
  password: string,
  origin: string,
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify({ email, password }),
  });
}

describe("the owner", () => {
  it("does not exist on a fresh instance, and nobody can sign in", async () => {
    const none = await operator.getOwner();
    expect(none.status).toBe(404);
    expect(none.error?.error.code).toBe("owner_not_found");

    const refused = await signIn(
      OWNER.email,
      OWNER.password,
      await signInOrigin(),
    );
    expect(refused.status).toBe(401);
  });

  it("is the operator key's to read and to create", async () => {
    const bareRead = await anonymous.getOwner();
    expect(bareRead.status).toBe(401);
    expect(bareRead.error?.error.code).toBe("unauthorized");
    const bareCreate = await anonymous.createOwner(OWNER);
    expect(bareCreate.status).toBe(401);
    expect(bareCreate.error?.error.code).toBe("unauthorized");
    const read = await working.getOwner();
    expect(read.status).toBe(403);
    expect(read.error?.error.code).toBe("forbidden");
    const create = await working.createOwner(OWNER);
    expect(create.status).toBe(403);
    expect(create.error?.error.code).toBe("forbidden");
    // The refusals created nothing.
    expect((await operator.getOwner()).status).toBe(404);
  });

  it("refuses a password outside the sign-in surface's rule, naming the bound", async () => {
    const short = await operator.createOwner({
      email: OWNER.email,
      password: "short",
    });
    expect(short.status).toBe(400);
    expect(short.error?.error.code).toBe("validation_error");
    expect(short.error?.error.details?.errors).toEqual([
      {
        path: "password",
        message: expect.stringMatching(/^must be at least \d+ characters$/),
      },
    ]);
    const long = await operator.createOwner({
      email: OWNER.email,
      password: "x".repeat(1000),
    });
    expect(long.status).toBe(400);
    expect(long.error?.error.code).toBe("validation_error");
    expect(long.error?.error.details?.errors).toEqual([
      {
        path: "password",
        message: expect.stringMatching(/^must be at most \d+ characters$/),
      },
    ]);
    expect((await operator.getOwner()).status).toBe(404);
  });

  it("is created once, signs in with its password, and refuses a second", async () => {
    const created = await operator.createOwner({
      email: "Owner@Example.com",
      password: OWNER.password,
    });
    expect(created.status).toBe(201);
    await expectMatchesSchema("POST", "/owner", 201, created.data);
    // The address is stored lowercased; a name that was not given is the
    // address's local part.
    expect(created.data).toMatchObject({ email: OWNER.email, name: "owner" });
    expect(Number.isNaN(Date.parse(created.data.created_at))).toBe(false);

    const read = await operator.getOwner();
    expect(read.status).toBe(200);
    await expectMatchesSchema("GET", "/owner", 200, read.data);
    expect(read.data).toEqual(created.data);

    // The account is real: it passes the sign-in surface, and only with
    // its password.
    const origin = await signInOrigin();
    const signedIn = await signIn(OWNER.email, OWNER.password, origin);
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toMatch(/session_token=/);
    const wrong = await signIn(OWNER.email, "not the password", origin);
    expect(wrong.status).toBe(401);

    const second = await operator.createOwner({
      email: "second@example.com",
      password: OWNER.password,
    });
    expect(second.status).toBe(409);
    expect(second.error?.error.code).toBe("owner_exists");
    const same = await operator.createOwner(OWNER);
    expect(same.status).toBe(409);
    expect(same.error?.error.code).toBe("owner_exists");
    expect((await operator.getOwner()).data).toEqual(created.data);
  });
});
