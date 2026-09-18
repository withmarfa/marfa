import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";
import { publishedOperations } from "../../utils/openapi.js";
import { coverageRows } from "../../utils/coverage-table.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "instance"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the instance", () => {
  it("answers /health without a credential and names its components", async () => {
    const r = await fetch(`${apiUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      status: string;
      components: Record<string, { status: string }>;
    };
    expect(body.status).toBe("ok");
    expect(body.components.database.status).toBe("ok");
    expect(body.components.blob_storage.status).toBe("ok");
  });

  it("describes itself at the root", async () => {
    const r = await client.root();
    expect(r.ok).toBe(true);
    expect(r.data.name).toBe("marfa");
    expect(typeof r.data.version).toBe("string");
    // The whole array, not a subset: `findings.md` 7 is about a feature the
    // root advertises and does not serve, which a subset could never catch.
    expect([...(r.data.features as string[])].sort()).toEqual(
      [
        "admin_archive",
        "audit",
        "blobs",
        "bulk",
        "edges",
        "events",
        "export",
        "extensions",
        "inbound-webhooks",
        "items",
        "keys",
        "metrics",
        "oauth",
        "search",
        "type_crud",
        "types",
        "webhooks",
      ].sort(),
    );
  });

  it("advertises inbound-webhooks at the root while serving no inbound door", async () => {
    // Recorded in spec/findings.md: the feature list is the one claim at the
    // root no other fixture checks, so the contradiction is asserted here.
    const r = await client.root();
    expect(r.ok).toBe(true);
    expect(r.data.features).toContain("inbound-webhooks");
    const door = await client.rawRequest(
      "/webhooks/inbound/00000000-0000-7000-8000-000000000000",
      { method: "POST", body: {} },
    );
    expect(door.status).toBe(404);
    expect(door.error?.error.code).toBe("not_found");
  });

  it("serves its OpenAPI document, with and without a credential", async () => {
    const r = await client.openApiDocument();
    expect(r.ok).toBe(true);
    expect(r.data.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(r.data.paths).length).toBeGreaterThan(0);

    const bare = await fetch(`${apiUrl}/openapi.json`);
    expect(bare.status).toBe(200);
    const doc = (await bare.json()) as unknown;
    expect(doc).toEqual(r.data);
  });

  it("answers 404 not_found in the standard envelope for a path it does not serve", async () => {
    const r = await client.rawRequest("/no-such-door");
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("not_found");
    expect(typeof r.error?.error.message).toBe("string");
    expect(r.error?.error).not.toHaveProperty("status");
  });

  it("publishes exactly the operations the coverage table knows", async () => {
    // spec/coverage.md is the referee's inventory. A published operation
    // missing from it is coverage nobody has decided about; a row the
    // document no longer publishes is a decision about nothing, unless the
    // table says the door is served unpublished.
    const rows = coverageRows();
    const known = new Set(rows.map((row) => `${row.method} ${row.path}`));
    const published = new Set(
      (await publishedOperations()).map((op) => `${op.method} ${op.path}`),
    );
    const missing = [...published].filter((key) => !known.has(key));
    expect(missing).toEqual([]);
    const stale = rows
      .filter((row) => row.status !== "unpublished")
      .map((row) => `${row.method} ${row.path}`)
      .filter((key) => !published.has(key));
    expect(stale).toEqual([]);
  });
});
