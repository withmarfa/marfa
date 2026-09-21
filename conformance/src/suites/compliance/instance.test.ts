import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
} from "../../utils/setup.js";
import { publishedOperations } from "../../utils/openapi.js";
import { coverageRows } from "../../utils/coverage-table.js";
import { readTarGzEntry } from "../../utils/archive.js";

/** The shape `generateId` mints, which is what the identity is. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    expect(r.data.instance_id).toMatch(UUID_V7);
    // The whole array, not a subset: the root once advertised a feature it
    // did not serve, and a subset could never catch an entry that should
    // not be there.
    expect([...(r.data.features as string[])].sort()).toEqual(
      [
        "admin_archive",
        "audit",
        "blobs",
        "bulk",
        "connectors",
        "edges",
        "events",
        "export",
        "extensions",
        "items",
        "keys",
        "metrics",
        "oauth",
        "owner",
        "search",
        "type_crud",
        "types",
        "webhooks",
      ].sort(),
    );
  });

  it("advertises no inbound webhook feature, and serves no inbound door", async () => {
    // The root named `inbound-webhooks` after the door left with the
    // connector runtime. Both halves are asserted, because re-adding the
    // advertisement and re-adding the door are separate regressions and
    // either alone puts the root back into contradiction.
    const r = await client.root();
    expect(r.ok).toBe(true);
    expect(r.data.features).not.toContain("inbound-webhooks");
    const door = await client.rawRequest(
      "/webhooks/inbound/00000000-0000-7000-8000-000000000000",
      { method: "POST", body: {} },
    );
    expect(door.status).toBe(404);
    expect(door.error?.error.code).toBe("not_found");
  });

  it("names every advertised feature in one convention", async () => {
    // The hyphen in `inbound-webhooks` was the only one in the array, so
    // nothing distinguished a second convention from a typo. Pinning the
    // spelling is what stops the next multi-word entry arriving in the
    // spelling of the entry that was wrong.
    //
    // Digits are inside the convention, not outside it. The first pattern
    // here was `^[a-z]+(_[a-z]+)*$`, which would have reddened on `oauth2`
    // or `s3` — names that break no rule this asserts — and the fixture
    // would have been read as the authority rather than the typo.
    const r = await client.root();
    expect(r.ok).toBe(true);
    const odd = (r.data.features as string[]).filter(
      (name) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name),
    );
    expect(odd).toEqual([]);
  });

  it("names itself the same way at the root, at /config and in an archive", async () => {
    // One identity, three doors, and the third is the one the first two
    // cannot stand in for: the manifest is written into a file nothing
    // echoes back, so an export that recorded a different name — or none —
    // would go unnoticed by every assertion made over HTTP.
    //
    // A credential-less read of the root is deliberate. The identity is how
    // a caller pointed at an address tells this deployment from another one
    // answering the same shape, which is a question asked before any key
    // exists.
    const bare = await fetch(`${apiUrl}/`);
    expect(bare.status).toBe(200);
    const root = (await bare.json()) as { instance_id: string };
    expect(root.instance_id).toMatch(UUID_V7);

    const config = await client.getConfig();
    expect(config.ok).toBe(true);
    expect((config.data as { instance_id: string }).instance_id).toBe(
      root.instance_id,
    );

    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.ok).toBe(true);
    const raw = readTarGzEntry(archive.data, "manifest.json");
    expect(raw).not.toBeNull();
    const manifest = JSON.parse(raw as string) as {
      version: number;
      instance_id: string;
    };
    // The witness. Without it a reader that silently returned the wrong
    // member, or an empty one, would satisfy the identity assertion below
    // for the wrong reason.
    expect(manifest.version).toBe(2);
    expect(manifest.instance_id).toBe(root.instance_id);
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

  it("declares no tag that no operation carries, and no operation without one", async () => {
    // A tag is a heading in the published reference. One with nothing under
    // it describes a surface the document says exists, and the two that were
    // here outlived the operations they grouped.
    //
    // Three arms, and the third is the one the first two could never reach.
    // `carried` is built from `op.tags ?? []`, so an operation carrying no
    // tag at all contributes nothing to it and sails through both of the
    // others — which is exactly what the two `/admin/platform-types`
    // operations did, filed under no heading and absent from the reference's
    // structure entirely. An untagged operation is asserted directly.
    const doc = (await client.openApiDocument()).data as unknown as {
      tags: { name: string }[];
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const methodNames = ["get", "post", "put", "patch", "delete"];
    const carried = new Set<string>();
    const untagged: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!methodNames.includes(method)) continue;
        const tags = op.tags ?? [];
        if (tags.length === 0) untagged.push(`${method.toUpperCase()} ${path}`);
        for (const tag of tags) carried.add(tag);
      }
    }
    const declared = doc.tags.map((tag) => tag.name);
    expect(declared.filter((name) => !carried.has(name))).toEqual([]);
    expect([...carried].filter((name) => !declared.includes(name))).toEqual([]);
    expect(untagged).toEqual([]);
  });

  it("answers 404 not_found in the standard envelope for a path it does not serve", async () => {
    const r = await client.rawRequest("/no-such-door");
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("not_found");
    expect(typeof r.error?.error.message).toBe("string");
    expect(r.error?.error).not.toHaveProperty("status");
  });

  it("reports its instance-wide counters to the operator key, unpublished", async () => {
    // `GET /metrics` is served and deliberately absent from the document
    // (`INTERNAL_OPERATION_IDS`), so nothing in the published reference
    // describes its body and `expectMatchesSchema` has nothing to check it
    // against. A key inside it was renamed twice with nothing anywhere going
    // red. The shape is asserted here instead, and `coverage.md` carries the
    // unpublished row that records the absence as a decision.
    const operator = getOperatorClient();
    const r = await operator.rawRequest<{
      items: { total: number; by_state: Record<string, number> };
      blobs: { count: number; total_bytes: number };
      types: { core: number; connector: number; registered: number };
      keys: { total: number };
      webhooks: { total: number };
      uptime_seconds: number;
      cached_at: string;
    }>("/metrics");
    expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(
      [
        "blobs",
        "cached_at",
        "items",
        "keys",
        "types",
        "uptime_seconds",
        "webhooks",
      ].sort(),
    );
    expect(Object.keys(r.data.types).sort()).toEqual(
      ["connector", "core", "registered"].sort(),
    );
    expect(Object.keys(r.data.items).sort()).toEqual(["by_state", "total"]);
    expect(Object.keys(r.data.blobs).sort()).toEqual(["count", "total_bytes"]);
    expect(typeof r.data.types.registered).toBe("number");
    expect(typeof r.data.uptime_seconds).toBe("number");
    expect(typeof r.data.cached_at).toBe("string");

    // Operator only, which is why no working credential covers it.
    const refused = await client.rawRequest("/metrics");
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
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
