/**
 * Protected Resource Metadata and authorization-server discovery, at the
 * URLs a spec-following client actually forms.
 *
 * An MCP client starts from a 401 challenge naming the PRM URL, reads the
 * document, extracts the authorization server, and then tries the
 * discovery mechanisms in priority order — RFC 8414 path insertion first,
 * then OIDC issuer-suffix. The issuer here is `<base>/auth`, so those
 * formed URLs carry the `/auth` path segment; serving only the bare-root
 * documents left every formed URL a 404 and made the server undiscoverable
 * to a strict client.
 */

import { describe, expect, it, afterEach } from "vitest";
import { expandBundlesToScopes } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { getPermissionBundles } from "../config.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

interface PrmDoc {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

describe("protected resource metadata (RFC 9728)", () => {
  it("serves the origin-level document", async () => {
    const base = "https://example.test";
    ctx = await createTestContext({
      authAllowSignup: false,
      authBaseUrl: base,
    });
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-protected-resource",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PrmDoc;
    expect(body.resource).toBe(base);
    expect(body.authorization_servers).toEqual([`${base}/auth`]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(body.scopes_supported).toEqual(
      expandBundlesToScopes(getPermissionBundles()),
    );
  });

  it("serves the path-aware document for the MCP endpoint", async () => {
    const base = "https://example.test";
    ctx = await createTestContext({
      authAllowSignup: false,
      authBaseUrl: base,
    });
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PrmDoc;
    expect(body.resource).toBe(`${base}/mcp`);
    expect(body.authorization_servers).toEqual([`${base}/auth`]);
  });
});

describe("authorization-server discovery at spec-formed URLs", () => {
  const FORMED_PATHS = [
    // RFC 8414 §3.1: well-known segment inserted between host and issuer path.
    "/.well-known/oauth-authorization-server/auth",
    "/.well-known/openid-configuration/auth",
    // OIDC Discovery: issuer + suffix.
    "/auth/.well-known/openid-configuration",
  ];

  for (const path of FORMED_PATHS) {
    it(`serves the augmented discovery document at ${path}`, async () => {
      ctx = await createTestContext({ authAllowSignup: false });
      const res = await request(ctx.app, "GET", path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        issuer?: string;
        token_endpoint?: string;
        grant_types_supported?: string[];
      };
      // One augmented document at every URL a client can derive: issuer,
      // endpoints, and the device-code augmentation all present.
      expect(body.issuer).toMatch(/\/auth$/);
      expect(body.token_endpoint).toMatch(/\/auth\/oauth2\/token$/);
      expect(body.grant_types_supported).toContain(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
    });
  }
});
