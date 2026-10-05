import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
} from "../../utils/setup.js";
import {
  expectMatchesSchema,
  publishedOperations,
} from "../../utils/openapi.js";
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

/**
 * Every advertised feature and a request that reaches the door it names.
 *
 * A list of feature names asserted against another list of feature names
 * cannot tell an advertised feature from a served one: the two agree by
 * being the same list, and an entry the server does not serve sits in both.
 * So the case below drives the loop from what the root answers and asks
 * each entry's door for itself.
 *
 * What each probe asks is only whether the route exists. The bodies are
 * deliberately refusable — an empty body, a malformed id, a query the
 * contract rejects — so nothing here writes, and what is asserted is that
 * the answer is not `404 not_found`, which is what the server gives a path
 * it does not serve.
 *
 * **That predicate is a property of these paths, not of the server.** A
 * served route mostly answers a 404 of its own (`item_not_found`,
 * `blob_not_found`), but two do not: the OAuth plugin fence under
 * `/auth/oauth2/*` and `DELETE /platform-types/{id}` both answer
 * `404 not_found` from a route that exists. Every path below is chosen to
 * avoid them, and a new probe has to be too.
 */
const FEATURE_DOORS: {
  feature: string;
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}[] = [
  { feature: "items", path: "/items?limit=1" },
  { feature: "search", path: "/search" },
  { feature: "blobs", path: "/blobs/not-a-hash" },
  { feature: "types", path: "/types" },
  { feature: "type_crud", path: "/types", method: "POST", body: {} },
  { feature: "keys", path: "/keys" },
  { feature: "bulk", path: "/items/bulk", method: "POST", body: {} },
  { feature: "export", path: "/export?state=not-a-state" },
  // Outside `/auth/*` deliberately: the better-auth catch-all at `/auth/*`
  // answers the metadata paths under it, so a probe there stays green with
  // Marfa's own handler deleted.
  {
    feature: "oauth",
    path: "/.well-known/oauth-authorization-server/auth",
  },
  { feature: "owner", path: "/owner", method: "POST", body: {} },
  { feature: "extensions", path: "/items/not-an-id/extensions" },
  { feature: "events", path: "/events?edges=bogus" },
  { feature: "webhooks", path: "/webhooks" },
  { feature: "audit", path: "/audit" },
  { feature: "metrics", path: "/metrics" },
  { feature: "edges", path: "/edges", method: "POST", body: {} },
  {
    feature: "restore",
    path: "/restore",
    method: "POST",
    body: {},
  },
  { feature: "connectors", path: "/connectors" },
  // The address door answers an unknown address exactly as an unserved
  // path, so the feature is probed at the doors that make addresses.
  {
    feature: "inbound_webhooks",
    path: "/connectors/00000000-0000-7000-8000-000000000000/endpoints",
  },
];

describe("the instance", () => {
  it("answers /health without a credential and names its components", async () => {
    const r = await fetch(`${apiUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      status: string;
      components: Record<string, { status: string; error?: string }>;
    };
    expect(body.status).toBe("ok");
    expect(Object.keys(body.components).sort()).toEqual([
      "blob_storage",
      "database",
      "database_write",
      "disk",
    ]);
    for (const component of Object.values(body.components)) {
      expect(component.status).toBe("ok");
      // Error text goes to the operator key alone, so a healthy answer to a
      // caller with no credential holds none to begin with.
      expect(component).not.toHaveProperty("error");
    }
  });

  it("answers /health to a request that names a key the instance does not hold as it does to one that names none", async () => {
    const r = await fetch(`${apiUrl}/health`, {
      headers: { Authorization: "Bearer marfa_a-key-no-instance-holds" },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe("ok");
  });

  it("describes itself at the root", async () => {
    const r = await client.root();
    expect(r.ok).toBe(true);
    expect(r.data.name).toBe("marfa");
    expect(typeof r.data.version).toBe("string");
    expect(r.data.instance_id).toMatch(UUID_V7);
    await expectMatchesSchema("GET", "/", 200, r.data);
    // Every entry held against a door, by the case below.
    expect([...(r.data.features as string[])].sort()).toEqual(
      FEATURE_DOORS.map((door) => door.feature).sort(),
    );
  });

  it("answers a browser at the root with a page and a program with the JSON", async () => {
    const browser = await fetch(`${apiUrl}/`, {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    expect(browser.status).toBe(200);
    expect(browser.headers.get("content-type")).toContain("text/html");
    expect(browser.headers.get("vary")).toContain("Accept");

    // The witness: the same address, asked the way a program asks, is the
    // description.
    for (const accept of [undefined, "*/*", "application/json"]) {
      const program = await fetch(`${apiUrl}/`, {
        headers: accept === undefined ? {} : { accept },
      });
      expect(program.headers.get("content-type")).toContain("application/json");
      expect(program.headers.get("vary")).toContain("Accept");
      expect(((await program.json()) as { name: string }).name).toBe("marfa");
    }
  });

  it("serves a route for every feature it advertises", async () => {
    // The witness first, so the assertions after it are about something. A
    // path nothing serves answers `404 not_found`, which is exactly what
    // every probe below asserts it did not get.
    const absent = await client.rawRequest("/no-such-door-at-all");
    expect(absent.status).toBe(404);
    expect(absent.error?.error.code).toBe("not_found");

    // Driven from what the root actually advertises, not from the table. A
    // loop over the table proves the table's own entries are served and
    // says nothing about a feature advertised without one.
    const r = await client.root();
    expect(r.ok).toBe(true);
    for (const feature of r.data.features as string[]) {
      const door = FEATURE_DOORS.find((entry) => entry.feature === feature);
      expect(
        door,
        `${feature} is advertised with no door to probe`,
      ).toBeDefined();
      if (!door) continue;
      const res = await client.rawRequest(door.path, {
        ...(door.method !== undefined && { method: door.method }),
        ...(door.body !== undefined && { body: door.body }),
      });
      const unmatched =
        res.status === 404 && res.error?.error.code === "not_found";
      expect(unmatched, `${door.feature} (${door.path})`).toBe(false);
    }
  });

  it("names every advertised feature in one convention", async () => {
    // One convention, pinned, so a multi-word entry cannot arrive in a
    // second spelling that nothing distinguishes from a typo. Digits are
    // inside the convention: `oauth2` or `s3` break no rule this asserts.
    const r = await client.root();
    expect(r.ok).toBe(true);
    const features = r.data.features as string[];
    expect(features.length).toBeGreaterThan(0);
    const odd = features.filter(
      (name) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name),
    );
    expect(odd).toEqual([]);
  });

  it("carries one contract version at the root and in its document", async () => {
    const root = await client.root();
    expect(root.ok).toBe(true);
    expect(Number.isInteger(root.data.contract)).toBe(true);
    expect(root.data.contract).toBe(0);
    const document = (await (await fetch(`${apiUrl}/openapi.json`)).json()) as {
      info: { version: string };
    };
    expect(document.info.version).toBe(String(root.data.contract));
    // The build is a different number and moves on a deploy; the two are
    // not the same field under two names.
    expect(root.data.version).not.toBe(String(root.data.contract));
  });

  it("sends its contract version on every answer, a refusal included", async () => {
    // Read against the root rather than a literal, so the fixture holds the
    // header to the number the deployment states and not to today's value.
    const root = await client.root();
    const contract = String(root.data.contract);
    const answers = [
      ["the root", root],
      ["a read", await client.rawRequest("/items?limit=1")],
      ["a validation refusal", await client.rawRequest("/items?limit=banana")],
      [
        "a door with no credential",
        await client.rawRequest("/items", { headers: { Authorization: "" } }),
      ],
      ["an unmatched route", await client.rawRequest("/no-such-door")],
    ] as const;
    const statuses = answers.map(([, answer]) => answer.status);
    expect(statuses).toEqual([200, 200, 400, 401, 404]);
    for (const [label, answer] of answers) {
      expect(answer.headers.get("X-Marfa-Contract"), label).toBe(contract);
    }
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
    expect(manifest.version).toBe(0);
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
    // it describes a surface the document says exists.
    //
    // Three arms, and the third is the one the first two could never reach.
    // `carried` is built from `op.tags ?? []`, so an operation carrying no
    // tag at all contributes nothing to it and sails through both of the
    // others, filed under no heading and absent from the reference's
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
    // The witness: there are tags to compare, on both sides.
    expect(declared.length).toBeGreaterThan(0);
    expect(carried.size).toBeGreaterThan(0);
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
    // against. Every other route in this file is held to the document; this
    // one is held to the keys written out below, which is the only place a
    // black-box caller's view of the body is pinned. `coverage.md` carries
    // the unpublished row that records the absence as a decision.
    const operator = getOperatorClient();
    const r = await operator.rawRequest<{
      items: { total: number; by_state: Record<string, number> };
      blobs: { count: number; total_bytes: number };
      types: { core: number; registered: number };
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
    expect(Object.keys(r.data.types).sort()).toEqual(["core", "registered"]);
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
    // The witness: both inventories have entries to reconcile.
    expect(known.size).toBeGreaterThan(0);
    expect(published.size).toBeGreaterThan(0);
    const missing = [...published].filter((key) => !known.has(key));
    expect(missing).toEqual([]);
    const stale = rows
      .filter((row) => row.status !== "unpublished")
      .map((row) => `${row.method} ${row.path}`)
      .filter((key) => !published.has(key));
    expect(stale).toEqual([]);
    // And the exemption cannot be borrowed: a row that says unpublished
    // about a door the document publishes would wave that door out of
    // both checks above and out of the body validation with one word.
    const wavedOut = rows
      .filter((row) => row.status === "unpublished")
      .map((row) => `${row.method} ${row.path}`)
      .filter((key) => published.has(key));
    expect(wavedOut).toEqual([]);
  });
});
