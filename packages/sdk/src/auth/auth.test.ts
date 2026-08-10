import { beforeEach, describe, it, expect } from "vitest";
import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce.js";
import { InMemoryTokenStorage } from "./storage.js";
import { MarfaAuth } from "./auth.js";
import { __resetDiscoveryCache } from "./discovery.js";

describe("PKCE primitives", () => {
  it("generates a verifier within RFC 7636 length bounds", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it("rejects out-of-range verifier lengths", () => {
    expect(() => generateCodeVerifier(20)).toThrow();
    expect(() => generateCodeVerifier(200)).toThrow();
  });

  it("computes a deterministic S256 challenge from a verifier", async () => {
    // Vector from RFC 7636 §4.2.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await computeCodeChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("state values are non-empty and reasonably random", () => {
    const a = generateState();
    const b = generateState();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("InMemoryTokenStorage", () => {
  it("round-trips set / get / delete", async () => {
    const s = new InMemoryTokenStorage();
    await s.set("k", "v");
    expect(await s.get("k")).toBe("v");
    await s.delete("k");
    expect(await s.get("k")).toBeNull();
  });
});

function discoveryFetch(issuer: string): typeof globalThis.fetch {
  const doc = JSON.stringify({
    issuer: `${issuer}/auth`,
    authorization_endpoint: `${issuer}/auth/oauth2/authorize`,
    token_endpoint: `${issuer}/auth/oauth2/token`,
    device_authorization_endpoint: `${issuer}/auth/device`,
  });
  return () =>
    Promise.resolve(
      new Response(doc, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

describe("MarfaAuth", () => {
  beforeEach(() => {
    __resetDiscoveryCache();
  });

  it("buildAuthorizeUrl persists verifier+state and produces a valid URL", async () => {
    const storage = new InMemoryTokenStorage();
    const auth = new MarfaAuth({
      issuer: "http://localhost:8602",
      clientId: "test-client",
      redirectUri: "http://localhost:5173/callback",
      scopes: ["core.note:read"],
      storage,
      fetch: discoveryFetch("http://localhost:8602"),
    });

    const url = await auth.buildAuthorizeUrl();
    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://localhost:8602");
    expect(parsed.pathname).toBe("/auth/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://localhost:5173/callback",
    );
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBeTruthy();
    expect(parsed.searchParams.get("state")).toBeTruthy();

    // Pending state should be persisted.
    const pending = await storage.get(
      "marfa.auth.pending:http://localhost:8602:test-client",
    );
    expect(pending).toBeTruthy();
    const obj = JSON.parse(pending!) as {
      verifier: string;
      state: string;
    };
    expect(obj.verifier.length).toBeGreaterThanOrEqual(43);
    expect(obj.state).toBe(parsed.searchParams.get("state"));
  });

  it("handleCallback exchanges the code and persists a session", async () => {
    // Nothing drove this path before, which is how it came to be broken: the
    // library brands the parameters its own validator returns and refuses any
    // other object, so the exchange threw a TypeError on every real callback
    // while every test still passed.
    const issuer = "http://localhost:8602";
    const storage = new InMemoryTokenStorage();
    const tokenRequests: URLSearchParams[] = [];

    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const target = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (target.pathname.startsWith("/.well-known")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: `${issuer}/auth`,
              authorization_endpoint: `${issuer}/auth/oauth2/authorize`,
              token_endpoint: `${issuer}/auth/oauth2/token`,
              device_authorization_endpoint: `${issuer}/auth/device`,
              authorization_response_iss_parameter_supported: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      // The library hands fetch a URLSearchParams body rather than a
      // pre-encoded string, so read it as one.
      const body = init?.body;
      tokenRequests.push(
        body instanceof URLSearchParams
          ? body
          : new URLSearchParams(typeof body === "string" ? body : ""),
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "at-1",
            refresh_token: "rt-1",
            token_type: "bearer",
            expires_in: 3600,
            scope: "core.note:read",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };

    const auth = new MarfaAuth({
      issuer,
      clientId: "test-client",
      redirectUri: "http://localhost:5173/auth/callback",
      scopes: ["core.note:read"],
      storage,
      fetch: fetchImpl,
    });

    const authorizeUrl = new URL(await auth.buildAuthorizeUrl());
    const state = authorizeUrl.searchParams.get("state") ?? "";
    const provider = await auth.handleCallback(
      `http://localhost:5173/auth/callback?code=the-code&state=${state}&iss=${encodeURIComponent(`${issuer}/auth`)}`,
    );

    // The exchange actually happened, carrying the code and the verifier.
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.get("code")).toBe("the-code");
    expect(tokenRequests[0]?.get("code_verifier")).toBeTruthy();
    expect(await provider.getAccessToken()).toBe("at-1");
    // The pending record is spent, so a replayed callback cannot reuse it.
    expect(
      await storage.get("marfa.auth.pending:http://localhost:8602:test-client"),
    ).toBeNull();
  });

  it("refuses a callback whose issuer is not the one discovered", async () => {
    // The mix-up defense the library's validator provides and a hand-built
    // parameter bag omits: a code minted by a different authorization server
    // must not be exchanged against this one's token endpoint.
    const issuer = "http://localhost:8602";
    const storage = new InMemoryTokenStorage();
    let exchanged = false;

    const fetchImpl: typeof globalThis.fetch = (input) => {
      const target = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (target.pathname.startsWith("/.well-known")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: `${issuer}/auth`,
              authorization_endpoint: `${issuer}/auth/oauth2/authorize`,
              token_endpoint: `${issuer}/auth/oauth2/token`,
              device_authorization_endpoint: `${issuer}/auth/device`,
              authorization_response_iss_parameter_supported: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      exchanged = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const auth = new MarfaAuth({
      issuer,
      clientId: "test-client",
      redirectUri: "http://localhost:5173/auth/callback",
      scopes: ["core.note:read"],
      storage,
      fetch: fetchImpl,
    });

    const authorizeUrl = new URL(await auth.buildAuthorizeUrl());
    const state = authorizeUrl.searchParams.get("state") ?? "";

    await expect(
      auth.handleCallback(
        `http://localhost:5173/auth/callback?code=the-code&state=${state}&iss=${encodeURIComponent("https://attacker.example/auth")}`,
      ),
    ).rejects.toMatchObject({ name: "OAuthError" });
    expect(exchanged).toBe(false);
  });

  it("restore() returns null when no session exists", async () => {
    const storage = new InMemoryTokenStorage();
    const auth = new MarfaAuth({
      issuer: "http://localhost:8602",
      clientId: "test-client",
      redirectUri: "http://localhost:5173/callback",
      scopes: [],
      storage,
    });
    const provider = await auth.restore();
    expect(provider).toBeNull();
  });

  it("buildBrowserSignOutUrl uses the persisted ID token and return URI", async () => {
    const storage = new InMemoryTokenStorage();
    await storage.set(
      "marfa.auth.tokens:http://localhost:8602:test-client",
      JSON.stringify({ id_token: "signed-id-token" }),
    );
    const auth = new MarfaAuth({
      issuer: "http://localhost:8602",
      clientId: "test-client",
      redirectUri: "http://localhost:5173/auth/callback",
      scopes: ["openid"],
      storage,
    });

    const url = new URL(
      await auth.buildBrowserSignOutUrl("http://localhost:5173/"),
    );
    expect(url.pathname).toBe("/auth/oauth2/end-session");
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("id_token_hint")).toBe("signed-id-token");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(
      "http://localhost:5173/",
    );
  });

  it("refuses to construct browser logout without an ID token", async () => {
    const auth = new MarfaAuth({
      issuer: "http://localhost:8602",
      clientId: "test-client",
      redirectUri: "http://localhost:5173/auth/callback",
      scopes: ["openid"],
      storage: new InMemoryTokenStorage(),
    });

    await expect(
      auth.buildBrowserSignOutUrl("http://localhost:5173/"),
    ).rejects.toThrow("No ID token");
  });
});
