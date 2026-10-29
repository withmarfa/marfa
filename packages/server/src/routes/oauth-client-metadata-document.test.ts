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
import { createApp } from "../app.js";
import {
  FIRST_FETCH_BUDGET,
  METADATA_FETCH_POLICY,
} from "../auth/client-metadata-discovery.js";
import { ensureInstanceId } from "../storage/instance-id.js";
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
  peer?: string,
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
    { headers: { cookie: c.owner.cookie }, ...(peer ? { peer } : {}) },
  );
}

/** The same database behind a server started again with `fetch`. */
async function restart(c: TestContext, fetch: Fetch): Promise<TestContext> {
  return {
    ...c,
    app: createApp(
      c.storage,
      c.blobs,
      c.housekeeping,
      c.config,
      await ensureInstanceId(c.storage.settings),
      { fetchClientMetadataResource: fetch },
    ),
  };
}

function reachedConsent(response: Response): boolean {
  return (
    response.status === 302 &&
    (response.headers.get("location") ?? "").includes("/auth/authorize?")
  );
}

/** Whether an authorization of a client that holds consent went through. */
function authorized(response: Response): boolean {
  if (reachedConsent(response)) return true;
  const location = new URL(response.headers.get("location") ?? "", BASE);
  return (
    response.status === 302 &&
    location.searchParams.get("error") === null &&
    location.searchParams.get("code") !== null
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

/**
 * Connects the client at {@link CLIENT_ID} the whole way: authorization,
 * approval and the code exchange. Returns its refresh token.
 */
async function connect(c: TestContext): Promise<string> {
  const { verifier, challenge } = pkce();
  const consent = await authorize(c, {
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    scope: `${SCOPE} offline_access`,
  });
  expect(reachedConsent(consent), consent.headers.get("location") ?? "").toBe(
    true,
  );
  const location = consent.headers.get("location") ?? "";
  const decision = await request(c.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: location.slice(location.indexOf("?") + 1),
      scopes: [SCOPE, "offline_access"],
    },
    headers: { cookie: c.owner.cookie, origin: BASE },
  });
  const code = new URL(decision.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const token = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: CALLBACK,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    },
  });
  const body = (await token.json()) as Record<string, unknown>;
  expect(token.status, JSON.stringify(body)).toBe(200);
  expect(typeof body.refresh_token).toBe("string");
  return String(body.refresh_token);
}

function refresh(c: TestContext, refreshToken: string): Promise<Response> {
  return request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    },
  });
}

/** A document the server must fetch again every time it resolves the client. */
function uncached(body: unknown): Response {
  return Response.json(body, { headers: { "cache-control": "no-cache" } });
}

describe("a stored metadata document client", () => {
  it("keeps authorizing and refreshing after many unknown clients ask to be discovered", async () => {
    const fetched: string[] = [];
    const fetch: Fetch = (input, init) => {
      const url = new Request(input, init).url;
      fetched.push(url);
      return uncached(metadata({ client_id: url }));
    };
    const c = await contextServing(fetch);
    const refreshToken = await connect(c);

    for (let i = 0; i < 150; i++) {
      await authorize(c, {
        client_id: `https://n${String(i)}.example.test/client.json`,
        redirect_uri: CALLBACK,
      });
    }
    const fetchedBefore = fetched.length;
    const again = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
    });
    const answer = new URL(again.headers.get("location") ?? "", BASE);
    expect(again.status).toBe(302);
    expect(answer.searchParams.get("error"), answer.href).toBeNull();
    expect(
      reachedConsent(again) || answer.searchParams.get("code") !== null,
    ).toBe(true);
    const refreshed = await refresh(c, refreshToken);
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);

    // The stored client's document was fetched again, and the unknown
    // clients reached the transport only within their own budget.
    expect(fetched.slice(fetchedBefore)).toContain(CLIENT_ID);
    const unknown = new Set(fetched.filter((url) => url !== CLIENT_ID)).size;
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeLessThanOrEqual(FIRST_FETCH_BUDGET.perMinute);
  });

  it.each([
    [
      "the host cannot be reached",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    [
      "the host answers 503",
      () => new Response("unavailable", { status: 503 }),
    ],
    [
      "the document breaks off partway",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"client_id":'));
              controller.error(new Error("connection reset"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ],
  ])("keeps refreshing while %s", async (_, unreachable) => {
    let reachable = true;
    const server = documentServer(() =>
      reachable ? uncached(metadata()) : unreachable(),
    );
    const c = await contextServing(server.fetch);
    const refreshToken = await connect(c);

    reachable = false;
    const calls = server.calls.length;
    const refreshed = await refresh(c, refreshToken);
    // The witness: the refresh did try the document.
    expect(server.calls.length).toBeGreaterThan(calls);
    const body = (await refreshed.json()) as Record<string, unknown>;
    expect(refreshed.status, JSON.stringify(body)).toBe(200);
    expect(String(body.access_token).startsWith("marfa_at_")).toBe(true);
  });

  it("keeps authorizing and refreshing once unknown clients on its own host spend the host's fetches", async () => {
    const fetched: string[] = [];
    const fetch: Fetch = (input, init) => {
      const url = new Request(input, init).url;
      fetched.push(url);
      return uncached(metadata({ client_id: url }));
    };
    const c = await contextServing(fetch);
    const refreshToken = await connect(c);

    const refusals: string[] = [];
    for (let i = 0; i < 30; i++) {
      const response = await authorize(
        c,
        {
          client_id: `https://app.example.test/unknown/${String(i)}.json`,
          redirect_uri: CALLBACK,
        },
        `203.0.113.${String(1 + (i % 4))}`,
      );
      if (!reachedConsent(response)) refusals.push(await response.text());
    }
    // The witness: the host's fetches for this minute are spent.
    expect(refusals.join("\n")).toContain("temporarily_unavailable");

    const fetchedBefore = fetched.length;
    const again = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
    });
    expect(fetched.slice(fetchedBefore)).toEqual([]);
    expect(authorized(again), await again.clone().text()).toBe(true);
    const refreshed = await refresh(c, refreshToken);
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  });

  it("stays refused within a second of its document answering 404", async () => {
    let status = 200;
    const server = documentServer(() =>
      status === 200 ? uncached(metadata()) : new Response("gone", { status }),
    );
    const c = await contextServing(server.fetch);
    const refreshToken = await connect(c);

    status = 404;
    const calls = server.calls.length;
    const first = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
    });
    expect(server.calls.length).toBe(calls + 1);
    expect(authorized(first)).toBe(false);

    const second = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
    });
    // The witness: the second request did not fetch the document.
    expect(server.calls.length).toBe(calls + 1);
    expect(authorized(second)).toBe(false);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error?: string }).error).toBe(
      "invalid_client",
    );
    const refused = await refresh(c, refreshToken);
    expect(refused.status).toBe(400);
  });

  it("stays refused after a restart while its host cannot be reached", async () => {
    let status = 200;
    const server = documentServer(() =>
      status === 200 ? uncached(metadata()) : new Response("gone", { status }),
    );
    const c = await contextServing(server.fetch);
    const refreshToken = await connect(c);

    status = 404;
    expect(
      authorized(
        await authorize(c, { client_id: CLIENT_ID, redirect_uri: CALLBACK }),
      ),
    ).toBe(false);

    const unreachable = documentServer(() => {
      throw new TypeError("fetch failed");
    });
    const restarted = await restart(c, unreachable.fetch);
    const refused = await refresh(restarted, refreshToken);
    // The witness: the restarted server did try the document.
    expect(unreachable.calls).toEqual([CLIENT_ID]);
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect(
      authorized(
        await authorize(restarted, {
          client_id: CLIENT_ID,
          redirect_uri: CALLBACK,
        }),
      ),
    ).toBe(false);
  });

  it("is accepted again once its document answers 200 after a 404", async () => {
    let status = 200;
    const server = documentServer(() =>
      status === 200 ? uncached(metadata()) : new Response("gone", { status }),
    );
    const c = await contextServing(server.fetch);
    const refreshToken = await connect(c);

    status = 404;
    expect(
      authorized(
        await authorize(c, { client_id: CLIENT_ID, redirect_uri: CALLBACK }),
      ),
    ).toBe(false);

    status = 200;
    // Past the library's least interval between fetches of one client.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const consent = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
    });
    expect(authorized(consent), await consent.clone().text()).toBe(true);
    const refreshed = await refresh(c, refreshToken);
    const body = (await refreshed.json()) as Record<string, unknown>;
    expect(refreshed.status, JSON.stringify(body)).toBe(200);

    // The acceptance is stored: after a restart the client is usable while
    // its host cannot be reached.
    const unreachable = documentServer(() => {
      throw new TypeError("fetch failed");
    });
    const restarted = await restart(c, unreachable.fetch);
    const again = await refresh(restarted, String(body.refresh_token));
    expect(unreachable.calls).toEqual([CLIENT_ID]);
    expect(again.status, await again.clone().text()).toBe(200);
  });

  it.each([
    [
      "breaks off",
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("not fo"));
            controller.error(new Error("connection reset"));
          },
        }),
    ],
    [
      "stalls",
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("not fo"));
          },
        }),
    ],
  ])(
    "is refused when its document answers 404 with a body that %s",
    async (_, body) => {
      let gone = false;
      const server = documentServer(() =>
        gone ? new Response(body(), { status: 404 }) : uncached(metadata()),
      );
      const c = await contextServing(server.fetch);
      const refreshToken = await connect(c);

      gone = true;
      const calls = server.calls.length;
      const refused = await refresh(c, refreshToken);
      expect(server.calls.length).toBeGreaterThan(calls);
      expect(refused.status, await refused.clone().text()).toBe(400);
    },
  );

  it("is refused once its document no longer validates", async () => {
    let valid = true;
    const server = documentServer(() =>
      uncached(
        valid
          ? metadata()
          : metadata({ client_id: "https://app.example.test/other.json" }),
      ),
    );
    const c = await contextServing(server.fetch);
    const refreshToken = await connect(c);

    valid = false;
    const refused = await refresh(c, refreshToken);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error?: string }).error).toBe(
      "invalid_client",
    );
  });
});

/**
 * A transport that serves {@link CLIENT_ID} until `retire` is called and 404
 * after, and passes every other URL to `other`. `storedCalls` records each
 * fetch of {@link CLIENT_ID}.
 */
function retiringServer(other: Fetch): {
  fetch: Fetch;
  storedCalls: string[];
  retire: () => void;
} {
  let retired = false;
  const storedCalls: string[] = [];
  const fetch: Fetch = (input, init) => {
    const url = new Request(input, init).url;
    if (url !== CLIENT_ID) return other(input, init);
    storedCalls.push(url);
    return retired
      ? new Response("gone", { status: 404 })
      : uncached(metadata());
  };
  return {
    fetch,
    storedCalls,
    retire: () => {
      retired = true;
    },
  };
}

/** A transport for other URLs that holds each fetch open until released. */
function heldDocuments(): { fetch: Fetch; held: (() => void)[] } {
  const held: (() => void)[] = [];
  const fetch: Fetch = (input, init) => {
    const url = new Request(input, init).url;
    return new Promise<Response>((resolve) => {
      held.push(() => {
        resolve(Response.json(metadata({ client_id: url })));
      });
    });
  };
  return { fetch, held };
}

/** `host` with the letters at the set bits of `variant` in upper case. */
function caseVariant(host: string, variant: number): string {
  let letter = 0;
  return host.replace(/[a-z]/g, (c) =>
    (variant >> letter++) & 1 ? c.toUpperCase() : c,
  );
}

async function expectFetchedAndRefused(
  c: TestContext,
  storedCalls: string[],
): Promise<void> {
  const before = storedCalls.length;
  const answer = await authorize(c, {
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
  });
  expect(storedCalls.length).toBe(before + 1);
  expect(authorized(answer), await answer.clone().text()).toBe(false);
}

describe("a stored metadata document client whose document answers 404", () => {
  it("is fetched and refused after one address sends many client IDs that are not valid", async () => {
    const server = retiringServer((input, init) => {
      throw new TypeError(
        `unexpected fetch of ${new Request(input, init).url}`,
      );
    });
    const c = await contextServing(server.fetch);
    await connect(c);

    const answers: string[] = [];
    for (let i = 0; i < METADATA_FETCH_POLICY.maximumFetchesPerMinute; i++) {
      const answer = await authorize(
        c,
        {
          client_id: `https://n${String(i)}.example.test`,
          redirect_uri: CALLBACK,
        },
        "203.0.113.7",
      );
      answers.push(await answer.text());
    }
    // The witness: a client ID with no path is refused as invalid.
    expect(answers[0]).toContain("explicit path component");

    server.retire();
    await expectFetchedAndRefused(c, server.storedCalls);
  });

  it("is fetched and refused while new clients wait on first fetches held open", async () => {
    const slow = heldDocuments();
    const server = retiringServer(slow.fetch);
    const c = await contextServing(server.fetch);
    await connect(c);

    const pending = Array.from(
      { length: FIRST_FETCH_BUDGET.concurrent },
      (_, i) =>
        authorize(
          c,
          {
            client_id: `https://slow${String(i)}.example.test/client.json`,
            redirect_uri: CALLBACK,
          },
          `203.0.113.${String(i + 1)}`,
        ),
    );
    try {
      await vi.waitFor(() => {
        expect(slow.held).toHaveLength(FIRST_FETCH_BUDGET.concurrent);
      });
      for (let i = 0; i < METADATA_FETCH_POLICY.maximumFetchesPerMinute; i++) {
        const answer = await authorize(
          c,
          {
            client_id: `https://more${String(i)}.example.test/client.json`,
            redirect_uri: CALLBACK,
          },
          "198.51.100.7",
        );
        expect(await answer.text()).toContain("temporarily_unavailable");
      }
      expect(slow.held).toHaveLength(FIRST_FETCH_BUDGET.concurrent);

      server.retire();
      await expectFetchedAndRefused(c, server.storedCalls);
    } finally {
      for (const release of slow.held) release();
      await Promise.all(pending);
    }
  });

  it("is fetched and refused after one address sends case variants of a client ID being fetched", async () => {
    const slowUrl = "https://app.example.test/slow.json";
    const slow = heldDocuments();
    const server = retiringServer((input, init) =>
      new Request(input, init).url === slowUrl
        ? slow.fetch(input, init)
        : Response.json(metadata({ client_id: new Request(input, init).url })),
    );
    const c = await contextServing(server.fetch);
    await connect(c);

    const peer = "203.0.113.9";
    const pending = authorize(
      c,
      { client_id: slowUrl, redirect_uri: CALLBACK },
      peer,
    );
    try {
      await vi.waitFor(() => {
        expect(slow.held).toHaveLength(1);
      });
      for (let i = 1; i < FIRST_FETCH_BUDGET.perAddressPerMinute; i++) {
        const consent = await authorize(
          c,
          {
            client_id: `https://n${String(i)}.example.test/client.json`,
            redirect_uri: CALLBACK,
          },
          peer,
        );
        expect(reachedConsent(consent), await consent.clone().text()).toBe(
          true,
        );
      }
      for (
        let i = 1;
        i <= METADATA_FETCH_POLICY.maximumFetchesPerOriginPerMinute;
        i++
      ) {
        const answer = await authorize(
          c,
          {
            client_id: slowUrl.replace(
              "app.example.test",
              caseVariant("app.example.test", i),
            ),
            redirect_uri: CALLBACK,
          },
          peer,
        );
        expect(await answer.text()).toContain("temporarily_unavailable");
      }

      server.retire();
      await expectFetchedAndRefused(c, server.storedCalls);
    } finally {
      for (const release of slow.held) release();
      await pending;
    }
  });
});

describe("the first fetches of metadata document clients", () => {
  it("count an IPv6 /64 as one address", async () => {
    const fetch: Fetch = (input, init) =>
      Response.json(metadata({ client_id: new Request(input, init).url }));
    const c = await contextServing(fetch);
    const first = (i: number, peer: string) =>
      authorize(
        c,
        {
          client_id: `https://app.example.test/clients/${String(i)}.json`,
          redirect_uri: CALLBACK,
        },
        peer,
      );

    for (let i = 0; i < FIRST_FETCH_BUDGET.perAddressPerMinute; i++) {
      const consent = await first(i, `2001:db8:1:2::${(i + 1).toString(16)}`);
      expect(reachedConsent(consent), await consent.clone().text()).toBe(true);
    }
    const sameNetwork = await first(100, "2001:db8:1:2:ffff:ffff:ffff:ffff");
    expect(reachedConsent(sameNetwork)).toBe(false);
    expect(await sameNetwork.text()).toContain("temporarily_unavailable");
    // The witness: another /64 is still served.
    const otherNetwork = await first(101, "2001:db8:1:3::1");
    expect(
      reachedConsent(otherNetwork),
      await otherNetwork.clone().text(),
    ).toBe(true);
  });

  it("are spent once by parallel first authorizations of one client", async () => {
    let fetches = 0;
    const server = documentServer(() => {
      fetches += 1;
      return Response.json(metadata());
    });
    const c = await contextServing(server.fetch);
    const answers = await Promise.all(
      Array.from({ length: 6 }, () =>
        authorize(c, { client_id: CLIENT_ID, redirect_uri: CALLBACK }),
      ),
    );
    for (const answer of answers)
      expect(reachedConsent(answer), await answer.clone().text()).toBe(true);
    expect(fetches).toBe(1);
  });
});

describe("the first authorization of a metadata document client", () => {
  it("drops a scope the instance cannot grant and authorizes the rest", async () => {
    const server = documentServer(() => Response.json(metadata()));
    const c = await contextServing(server.fetch);
    const consent = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      scope: `${SCOPE} user.nothing_registered_here:read`,
    });
    expect(reachedConsent(consent), consent.headers.get("location") ?? "").toBe(
      true,
    );
    const location = new URL(consent.headers.get("location") ?? "", BASE);
    expect(location.searchParams.get("scope")).toBe(SCOPE);
  });

  it("sends a resource it refuses to a callback the document lists", async () => {
    const server = documentServer(() => Response.json(metadata()));
    const c = await contextServing(server.fetch);
    const refused = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      resource: "https://elsewhere.example.test",
    });
    expect(refused.status).toBe(302);
    const sent = new URL(refused.headers.get("location") ?? "");
    expect(`${sent.origin}${sent.pathname}`).toBe(CALLBACK);
    expect(sent.searchParams.get("error")).toBe("invalid_target");
    expect(sent.searchParams.get("state")).toBe("cimd-state");
    expect(sent.searchParams.get("iss")).toBe(`${BASE}/auth`);
    expect(sent.searchParams.get("code")).toBeNull();
  });

  it("answers a resource it refuses 400 when the callback is not in the document", async () => {
    const server = documentServer(() => Response.json(metadata()));
    const c = await contextServing(server.fetch);
    const refused = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: "https://app.example.test/elsewhere",
      resource: "https://elsewhere.example.test",
    });
    expect(refused.status).toBe(400);
    expect(refused.headers.get("location")).toBeNull();
    expect(((await refused.json()) as { error?: string }).error).toBe(
      "invalid_target",
    );
  });

  it("names the document's host on the approval page", async () => {
    const server = documentServer(() => Response.json(metadata()));
    const c = await contextServing(server.fetch);
    const consent = await authorize(c, {
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
    });
    const page = await request(
      c.app,
      "GET",
      consent.headers.get("location") ?? "",
      { headers: { cookie: c.owner.cookie } },
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Example MCP App");
    expect(html).toContain("From app.example.test");
  });
});
