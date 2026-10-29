/**
 * Clients that name themselves by a client ID metadata document: an HTTPS
 * URL as the `client_id`, whose JSON the server fetches to learn the client's
 * name and callbacks. The documents are served by an in-process handler
 * through the injected transport, so no case reaches the network; the one
 * case that runs the default transport answers its DNS lookup in-process.
 */

import { createHash, randomBytes } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transactionControl } from "../storage/sqlite/transaction-control.js";
import type { TestAppOptions, TestContext } from "../test-utils.js";
import { createTestContext, request, TEST_OWNER } from "../test-utils.js";

vi.setConfig({ testTimeout: 45_000 });

const BASE = "http://localhost:0";
const CLIENT_ID = "https://app.example.test/oauth/client.json";
const CALLBACK = "https://app.example.test/oauth/callback";
const SCOPE = "core.note:read";

type Fetch = NonNullable<TestAppOptions["fetchClientMetadataResource"]>;

let ctx: TestContext | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
});

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT_ID,
    client_name: "Example MCP App",
    redirect_uris: [CALLBACK],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...overrides,
  };
}

/**
 * A transport that answers only for `app.example.test`, records every URL it
 * is asked for, and checks that no database transaction is open while the
 * server waits on it.
 */
function documentServer(answer: () => Response): {
  fetch: Fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: Fetch = (input, init) => {
    const url = new Request(input, init).url;
    calls.push(url);
    expect(transactionControl.getStore()).toBeUndefined();
    if (new URL(url).host !== "app.example.test") {
      throw new TypeError(`unexpected fetch of ${url}`);
    }
    return answer();
  };
  return { fetch, calls };
}

async function contextServing(fetch?: Fetch): Promise<TestContext> {
  ctx = await createTestContext(
    { authBaseUrl: BASE },
    TEST_OWNER,
    fetch ? { fetchClientMetadataResource: fetch } : {},
  );
  return ctx;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

function authorize(
  c: TestContext,
  params: Record<string, string>,
): Promise<Response> {
  return request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      scope: SCOPE,
      state: "cimd-state",
      code_challenge_method: "S256",
      code_challenge: pkce().challenge,
      ...params,
    }).toString()}`,
    { headers: { cookie: c.owner.cookie } },
  );
}

function reachedConsent(response: Response): boolean {
  return (
    response.status === 302 &&
    (response.headers.get("location") ?? "").includes("/auth/authorize?")
  );
}

describe("a client named by its metadata document", () => {
  it("completes authorization as a public client with an MCP resource", async () => {
    const server = documentServer(() => Response.json(metadata()));
    const c = await contextServing(server.fetch);
    const { verifier, challenge } = pkce();
    const resource = `${BASE}/mcp`;

    const consent = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      resource,
    });
    expect(reachedConsent(consent), consent.headers.get("location") ?? "").toBe(
      true,
    );
    expect(server.calls).toEqual([CLIENT_ID]);

    const location = consent.headers.get("location") ?? "";
    const decision = await request(c.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: location.slice(location.indexOf("?") + 1),
        scopes: [SCOPE],
      },
      headers: { cookie: c.owner.cookie, origin: BASE },
    });
    expect(decision.status).toBe(302);
    const callback = new URL(decision.headers.get("location") ?? "");
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await request(c.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: CALLBACK,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource,
      },
    });
    const body = (await token.json()) as Record<string, unknown>;
    expect(token.status, JSON.stringify(body)).toBe(200);
    expect(String(body.access_token).startsWith("marfa_at_")).toBe(true);
    expect(body.scope).toBe(SCOPE);

    const read = await request(c.app, "GET", "/items", {
      key: String(body.access_token),
    });
    expect(read.status).toBe(200);

    const stored = await c.storage.oauthProvider?.getClient(CLIENT_ID);
    expect(stored?.name).toBe("Example MCP App");
    expect(stored?.redirectUris).toEqual([CALLBACK]);
  });

  it("accepts a loopback callback on any port", async () => {
    const server = documentServer(() =>
      Response.json(metadata({ redirect_uris: ["http://127.0.0.1/callback"] })),
    );
    const c = await contextServing(server.fetch);
    const consent = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: "http://127.0.0.1:53124/callback",
    });
    expect(reachedConsent(consent), consent.headers.get("location") ?? "").toBe(
      true,
    );
  });

  it.each([
    [
      "redirects",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.test/client.json" },
        }),
    ],
    [
      "is too large",
      () =>
        Response.json(
          metadata({
            client_uri: `https://app.example.test/${"a".repeat(6000)}`,
          }),
        ),
    ],
    [
      "names a different client_id",
      () =>
        Response.json(
          metadata({ client_id: "https://app.example.test/other.json" }),
        ),
    ],
    [
      "asks for private_key_jwt",
      () =>
        Response.json(
          metadata({
            token_endpoint_auth_method: "private_key_jwt",
            jwks: {
              keys: [
                {
                  kty: "EC",
                  crv: "P-256",
                  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
                  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
                },
              ],
            },
          }),
        ),
    ],
  ])("refuses a document that %s", async (_, answer) => {
    const server = documentServer(answer);
    const c = await contextServing(server.fetch);
    const refused = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
    });
    expect(server.calls).toEqual([CLIENT_ID]);
    expect(reachedConsent(refused)).toBe(false);
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error?: string };
    expect(body.error).toMatch(/^invalid_client(_metadata)?$/);
    expect(await c.storage.oauthProvider?.getClient(CLIENT_ID)).toBeNull();
  });

  it.each([
    "https://127.0.0.1/client.json",
    "https://10.0.0.1/client.json",
    "https://169.254.169.254/client.json",
    "https://[::1]/client.json",
    "https://localhost/client.json",
  ])("never fetches a document at %s", async (clientId) => {
    const server = documentServer(() =>
      Response.json(metadata({ client_id: clientId })),
    );
    const c = await contextServing(server.fetch);
    const refused = await authorize(c, {
      client_id: clientId,
      redirect_uri: CALLBACK,
    });
    expect(reachedConsent(refused)).toBe(false);
    expect(server.calls).toEqual([]);
  });

  it("does not treat an http client_id as a metadata document", async () => {
    const server = documentServer(() => Response.json(metadata()));
    const c = await contextServing(server.fetch);
    const refused = await authorize(c, {
      client_id: "http://app.example.test/oauth/client.json",
      redirect_uri: CALLBACK,
    });
    expect(reachedConsent(refused)).toBe(false);
    expect(server.calls).toEqual([]);
  });

  it("refuses a host that resolves to a private address before connecting", async () => {
    const dns = createRequire(import.meta.url)(
      "node:dns/promises",
    ) as typeof import("node:dns/promises");
    const lookups: string[] = [];
    const original = dns.lookup;
    dns.lookup = ((hostname: string) => {
      lookups.push(hostname);
      return Promise.resolve([{ address: "10.0.0.5", family: 4 }]);
    }) as unknown as typeof dns.lookup;
    syncBuiltinESMExports();
    try {
      const c = await contextServing();
      const refused = await authorize(c, {
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK,
      });
      expect(lookups).toEqual(["app.example.test"]);
      expect(reachedConsent(refused)).toBe(false);
      expect(await c.storage.oauthProvider?.getClient(CLIENT_ID)).toBeNull();
    } finally {
      dns.lookup = original;
      syncBuiltinESMExports();
    }
  });
});

describe("discovery for metadata document clients", () => {
  it.each([
    "/.well-known/oauth-authorization-server/auth",
    "/.well-known/openid-configuration/auth",
    "/auth/.well-known/openid-configuration",
    "/auth/.well-known/oauth-authorization-server",
  ])("%s advertises metadata documents and public clients", async (path) => {
    const c = await contextServing();
    const res = await request(c.app, "GET", path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      client_id_metadata_document_supported?: unknown;
      token_endpoint_auth_methods_supported?: unknown;
    };
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
  });
});
