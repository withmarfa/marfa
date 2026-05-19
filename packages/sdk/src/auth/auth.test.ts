import { beforeEach, describe, it, expect } from "vitest";
import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce.js";
import { InMemoryTokenStorage } from "./storage.js";
import { MymeAuth } from "./auth.js";
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

describe("MymeAuth", () => {
  beforeEach(() => {
    __resetDiscoveryCache();
  });

  it("buildAuthorizeUrl persists verifier+state and produces a valid URL", async () => {
    const storage = new InMemoryTokenStorage();
    const auth = new MymeAuth({
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
      "myme.auth.pending:http://localhost:8602:test-client",
    );
    expect(pending).toBeTruthy();
    const obj = JSON.parse(pending!) as {
      verifier: string;
      state: string;
    };
    expect(obj.verifier.length).toBeGreaterThanOrEqual(43);
    expect(obj.state).toBe(parsed.searchParams.get("state"));
  });

  it("restore() returns null when no session exists", async () => {
    const storage = new InMemoryTokenStorage();
    const auth = new MymeAuth({
      issuer: "http://localhost:8602",
      clientId: "test-client",
      redirectUri: "http://localhost:5173/callback",
      scopes: [],
      storage,
    });
    const provider = await auth.restore();
    expect(provider).toBeNull();
  });
});
