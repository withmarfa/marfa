import { describe, expect, it } from "vitest";
import {
  isAcceptedResource,
  mcpInsufficientScope,
  mcpUnauthorized,
} from "./mcp-resource.js";

const BASE = "https://marfa.example.test";

describe("isAcceptedResource", () => {
  it.each([
    BASE,
    `${BASE}/`,
    `${BASE}/mcp`,
    `${BASE}/mcp/schema`,
    `${BASE}/mcp/admin`,
    "HTTPS://MARFA.EXAMPLE.TEST",
    "https://Marfa.Example.Test/",
    "HTTPS://MARFA.EXAMPLE.TEST/mcp",
    "Https://marfa.EXAMPLE.test/mcp/admin",
  ])("accepts %s", (value) => {
    expect(isAcceptedResource(BASE, value)).toBe(true);
    expect(isAcceptedResource(`${BASE}/`, value)).toBe(true);
  });

  it.each([
    `${BASE}/mcp/`,
    `${BASE}/mcp/admin/`,
    `${BASE}/mcp/other`,
    `${BASE}/mcp?x=1`,
    `${BASE}/mcp#top`,
    `${BASE}/items`,
    `${BASE}/MCP`,
    `${BASE}/Mcp/schema`,
    `${BASE}/%6Dcp`,
    `${BASE}/mcp%2Fschema`,
    "HTTPS://MARFA.EXAMPLE.TEST/mcp?x=1",
    "HTTPS://MARFA.EXAMPLE.TEST/items",
    "https://user@marfa.example.test/mcp",
    "https://other.example.test/mcp",
    "https://marfa.example.test:8443/mcp",
    "http://marfa.example.test/mcp",
    "",
  ])("refuses %s", (value) => {
    expect(isAcceptedResource(BASE, value)).toBe(false);
  });
});

describe("the MCP challenges", () => {
  it("answers a request with no credential 401 and names the metadata", async () => {
    const response = mcpUnauthorized(BASE, "/mcp/schema");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/schema"`,
    );
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });

  it("answers too narrow a grant 403 with the scopes to ask for", async () => {
    const response = mcpInsufficientScope(`${BASE}/`, "/mcp", [
      "core.note:read",
      "core.task:write",
    ]);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="core.note:read core.task:write", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", error_description="access token is missing required scope: core.note:read core.task:write"`,
    );
    expect(await response.json()).toEqual({
      error: {
        code: "forbidden",
        message: "Insufficient scope",
        details: { required_scope: "core.note:read core.task:write" },
      },
    });
  });

  it.each(['core.note:read"', "core.note:read\r\nx: y", ""])(
    "refuses to name a scope a header cannot carry: %j",
    (scope) => {
      expect(() => mcpInsufficientScope(BASE, "/mcp", [scope])).toThrow();
    },
  );
});
