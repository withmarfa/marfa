/**
 * The remote agent surface at /mcp: door, protocol eras, and the in-process
 * dispatch path.
 *
 * These drive the mounted endpoint the way an MCP client does — modern
 * per-request envelopes and the legacy handshake — and prove a tool call
 * writes through the real API enforcement, not a parallel path.
 */

import { describe, expect, it, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const MODERN_VERSION = "2026-07-28";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": {
    name: "conformance",
    version: "0.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernPost(
  method: string,
  params: Record<string, unknown> = {},
  key?: string,
  extra: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MODERN_VERSION,
      "Mcp-Method": method,
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extra,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: MODERN_META },
    }),
  });
}

/** Read a response body as JSON, tolerating SSE framing. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return text.length > 0 ? JSON.parse(text) : null;
}

describe("the door", () => {
  it("refuses an anonymous request with a bearer challenge", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(modernPost("tools/list"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("refuses an invalid bearer", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      modernPost("tools/list", {}, "marfa_k1_not_a_real_key"),
    );
    expect(res.status).toBe(401);
  });

  it("names the resource metadata document in the hosted-mode challenge", async () => {
    const base = "https://example.test";
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: false,
      authBaseUrl: base,
    });
    const res = await ctx.app.fetch(modernPost("tools/list"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe("the modern era over HTTP", () => {
  it("serves server/discover naming the current revision", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      modernPost("server/discover", {}, ctx.spaceKey),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      result?: { supportedVersions?: string[] };
    };
    expect(body.result?.supportedVersions).toContain(MODERN_VERSION);
  });

  it("lists the standard toolset with required result fields", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(modernPost("tools/list", {}, ctx.spaceKey));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      result?: {
        tools?: { name: string }[];
        resultType?: string;
        ttlMs?: number;
        cacheScope?: string;
      };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("create_item");
    expect(names).toContain("list_items");
    // Standard toolset only: admin tools stay off the remote surface
    // unless the operator widens the configured toolsets.
    expect(names).not.toContain("bulk_items");
    expect(body.result?.resultType).toBe("complete");
    expect(typeof body.result?.ttlMs).toBe("number");
    expect(["public", "private"]).toContain(body.result?.cacheScope);
  });

  it("writes through the real API on tools/call and the item is readable", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      modernPost(
        "tools/call",
        {
          name: "create_item",
          arguments: {
            type: "core.note",
            properties: { title: "via mcp", body: "written over the wire" },
          },
        },
        ctx.spaceKey,
        { "Mcp-Name": "create_item" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: { text: string }[] };
    };
    expect(body.result?.isError).not.toBe(true);
    const created = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as {
      id?: string;
    };
    const createdId = created.id;
    if (!createdId) throw new Error("tools/call returned no item id");

    const read = await request(ctx.app, "GET", `/items/${createdId}`, {
      key: ctx.spaceKey,
    });
    expect(read.status).toBe(200);
  });
});

describe("the legacy era over HTTP", () => {
  it("negotiates the requested handshake revision statelessly", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${ctx.spaceKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "conformance", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      result?: { protocolVersion?: string };
    };
    expect(body.result?.protocolVersion).toBe("2025-06-18");
  });
});
