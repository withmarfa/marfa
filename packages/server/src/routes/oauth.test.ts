import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

const SALT = "test-salt";

function sha256base64url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/** Helper: register a client + run the full OAuth flow, returns tokens. */
async function performOAuthFlow(
  scopes: string[],
  options?: { denyScopes?: string[] },
) {
  // Register client
  const clientRes = await request(ctx.app, "POST", "/auth/clients", {
    key: ctx.adminKey,
    body: { name: "Test App", redirect_uris: ["https://example.com/callback"] },
  });
  const client = (await clientRes.json()) as { id: string };

  // PKCE
  const codeVerifier = "test-verifier-that-is-long-enough-for-pkce-validation";
  const codeChallenge = sha256base64url(codeVerifier);

  // Get consent screen
  const scopeStr = scopes.join(" ");
  const authorizeRes = await request(
    ctx.app,
    "GET",
    `/auth/authorize?client_id=${client.id}&response_type=code&scope=${encodeURIComponent(scopeStr)}&redirect_uri=${encodeURIComponent("https://example.com/callback")}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=test123`,
    { key: ctx.adminKey },
  );
  expect(authorizeRes.status).toBe(200);

  // Approve consent (POST form)
  const grantedScopes = options?.denyScopes
    ? scopes.filter((s) => !options.denyScopes!.includes(s))
    : scopes;

  const formBody = new URLSearchParams();
  formBody.set("action", "approve");
  formBody.set("client_id", client.id);
  formBody.set("redirect_uri", "https://example.com/callback");
  formBody.set("code_challenge", codeChallenge);
  formBody.set("code_challenge_method", "S256");
  formBody.set("state", "test123");
  for (const s of grantedScopes) {
    formBody.append("scopes", s);
  }

  const approveRes = await ctx.app.request("/auth/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${ctx.adminKey}`,
    },
    body: formBody.toString(),
  });

  expect(approveRes.status).toBe(302);
  const location = approveRes.headers.get("Location")!;
  const redirectUrl = new URL(location);
  const code = redirectUrl.searchParams.get("code")!;
  expect(redirectUrl.searchParams.get("state")).toBe("test123");

  // Exchange code for tokens
  const tokenRes = await request(ctx.app, "POST", "/auth/token", {
    body: {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: "https://example.com/callback",
    },
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };

  return { client, tokens, code };
}

describe("OAuth client registration", () => {
  it("creates a client", async () => {
    const res = await request(ctx.app, "POST", "/auth/clients", {
      key: ctx.adminKey,
      body: { name: "My App", redirect_uris: ["https://app.example.com/cb"] },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string; name: string };
    expect(data.name).toBe("My App");
    expect(data.id).toBeDefined();
  });

  it("rejects without admin key", async () => {
    const res = await request(ctx.app, "POST", "/auth/clients", {
      body: { name: "Bad App", redirect_uris: ["https://evil.com"] },
    });
    expect(res.status).toBe(401);
  });

  it("lists clients", async () => {
    const res = await request(ctx.app, "GET", "/auth/clients", { key: ctx.adminKey });
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("OAuth authorization flow", () => {
  it("completes full flow: authorize -> consent -> code -> tokens", async () => {
    const { tokens } = await performOAuthFlow(["core.note:read", "core.note:write"]);
    expect(tokens.access_token).toMatch(/^myme_at_/);
    expect(tokens.refresh_token).toMatch(/^myme_rt_/);
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.expires_in).toBe(3600);
  });

  it("returns consent screen HTML", async () => {
    const clientRes = await request(ctx.app, "POST", "/auth/clients", {
      key: ctx.adminKey,
      body: { name: "HTML Test", redirect_uris: ["https://example.com/cb"] },
    });
    const client = (await clientRes.json()) as { id: string };
    const codeChallenge = sha256base64url("verifier");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?client_id=${client.id}&response_type=code&scope=core.note:read&redirect_uri=https://example.com/cb&code_challenge=${codeChallenge}&code_challenge_method=S256`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("HTML Test");
    expect(html).toContain("core.note");
  });

  it("rejects unknown client_id", async () => {
    const codeChallenge = sha256base64url("verifier");
    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?client_id=nonexistent&response_type=code&scope=core.note:read&redirect_uri=https://x.com/cb&code_challenge=${codeChallenge}&code_challenge_method=S256`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
  });
});

describe("PKCE verification", () => {
  it("rejects wrong code_verifier", async () => {
    const clientRes = await request(ctx.app, "POST", "/auth/clients", {
      key: ctx.adminKey,
      body: { name: "PKCE Test", redirect_uris: ["https://example.com/cb"] },
    });
    const client = (await clientRes.json()) as { id: string };
    const correctVerifier = "correct-verifier-for-pkce-test-long-enough";
    const codeChallenge = sha256base64url(correctVerifier);

    // Get consent + approve
    const formBody = new URLSearchParams();
    formBody.set("action", "approve");
    formBody.set("client_id", client.id);
    formBody.set("redirect_uri", "https://example.com/cb");
    formBody.set("code_challenge", codeChallenge);
    formBody.set("code_challenge_method", "S256");
    formBody.append("scopes", "core.note:read");

    const approveRes = await ctx.app.request("/auth/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${ctx.adminKey}`,
      },
      body: formBody.toString(),
    });
    const location = approveRes.headers.get("Location")!;
    const code = new URL(location).searchParams.get("code")!;

    // Exchange with wrong verifier
    const tokenRes = await request(ctx.app, "POST", "/auth/token", {
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier-that-does-not-match",
        redirect_uri: "https://example.com/cb",
      },
    });
    expect(tokenRes.status).toBe(400);
    const data = (await tokenRes.json()) as { error: { code: string } };
    expect(data.error.code).toBe("invalid_grant");
  });
});

describe("OAuth token usage", () => {
  it("access token works for authorized types", async () => {
    const { tokens } = await performOAuthFlow(["core.note:read"]);

    // Create an item first (with admin key)
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "OAuth test" } },
    });
    expect(createRes.status).toBe(201);

    // List items with OAuth token
    const listRes = await request(ctx.app, "GET", "/items", {
      key: tokens.access_token,
    });
    expect(listRes.status).toBe(200);
  });

  it("access token is denied for unauthorized types", async () => {
    const { tokens } = await performOAuthFlow(["core.note:read"]);

    // Try to create a bookmark (not in scope)
    const res = await request(ctx.app, "POST", "/items", {
      key: tokens.access_token,
      body: { type: "core.bookmark", properties: { url: "https://example.com" } },
    });
    expect(res.status).toBe(403);
  });

  it("read-only scope prevents writes", async () => {
    const { tokens } = await performOAuthFlow(["core.note:read"]);

    const res = await request(ctx.app, "POST", "/items", {
      key: tokens.access_token,
      body: { type: "core.note", properties: { body: "Should fail" } },
    });
    expect(res.status).toBe(403);
  });
});

describe("refresh token rotation", () => {
  it("issues new tokens on refresh", async () => {
    const { tokens } = await performOAuthFlow(["core.note:write"]);

    const refreshRes = await request(ctx.app, "POST", "/auth/token", {
      body: {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      },
    });
    expect(refreshRes.status).toBe(200);
    const newTokens = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(newTokens.access_token).toMatch(/^myme_at_/);
    expect(newTokens.refresh_token).toMatch(/^myme_rt_/);
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);
  });

  it("rejects reused refresh token and revokes grant", async () => {
    const { tokens } = await performOAuthFlow(["core.note:read"]);

    // First refresh succeeds
    const firstRefresh = await request(ctx.app, "POST", "/auth/token", {
      body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    });
    expect(firstRefresh.status).toBe(200);
    const newTokens = (await firstRefresh.json()) as { access_token: string };

    // Second use of same refresh token — replay detected
    const secondRefresh = await request(ctx.app, "POST", "/auth/token", {
      body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    });
    expect(secondRefresh.status).toBe(400);
    const err = (await secondRefresh.json()) as { error: { code: string } };
    expect(err.error.code).toBe("token_reuse_detected");

    // New access token should also be revoked
    const listRes = await request(ctx.app, "GET", "/items", {
      key: newTokens.access_token,
    });
    expect(listRes.status).toBe(401);
  });
});

describe("token management", () => {
  it("lists active tokens", async () => {
    await performOAuthFlow(["core.note:read"]);
    const res = await request(ctx.app, "GET", "/auth/tokens", { key: ctx.adminKey });
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as unknown[];
    expect(tokens.length).toBeGreaterThanOrEqual(1);
  });

  it("revokes a specific token", async () => {
    const { tokens } = await performOAuthFlow(["core.note:read"]);

    // Find this token's ID by validating it through the store
    const tokenHash = hashApiKey(tokens.access_token, SALT);
    const tokenRecord = await ctx.storage.oauth.validateToken(tokenHash);
    expect(tokenRecord).not.toBeNull();

    // Revoke
    const revokeRes = await request(ctx.app, "DELETE", `/auth/tokens/${tokenRecord!.id}`, {
      key: ctx.adminKey,
    });
    expect(revokeRes.status).toBe(204);

    // Token should no longer work
    const itemsRes = await request(ctx.app, "GET", "/items", { key: tokens.access_token });
    expect(itemsRes.status).toBe(401);
  });
});

describe("coexistence with API keys", () => {
  it("API key auth still works", async () => {
    const res = await request(ctx.app, "GET", "/items", { key: ctx.adminKey });
    expect(res.status).toBe(200);
  });

  it("invalid token format is treated as unauthenticated", async () => {
    const res = await request(ctx.app, "GET", "/items", { key: "invalid_prefix_token" });
    expect(res.status).toBe(401);
  });
});
