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
import { uploadReferenced } from "../../utils/blobs.js";

/** The shape `generateId` mints, which is what the identity is. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "instance",
  ));
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
    // The contract version is an integer, and the case that names it holds
    // it to the document; here it is only that the root carries one.
    expect(Number.isInteger(r.data.contract)).toBe(true);
    // Every entry held against a door, by the case below.
    expect([...(r.data.features as string[])].sort()).toEqual(
      FEATURE_DOORS.map((door) => door.feature).sort(),
    );
  });

  it("advertises its features as an array of strings, each named once", async () => {
    const r = await client.root();
    expect(r.ok).toBe(true);
    const features: unknown = r.data.features;
    expect(Array.isArray(features)).toBe(true);
    const named = features as unknown[];
    expect(named.length).toBeGreaterThan(0);
    for (const feature of named) {
      expect(typeof feature, String(feature)).toBe("string");
    }
    expect(new Set(named).size).toBe(named.length);
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

  it("answers a page when text/html comes before application/json, and the description when it comes after or when the request names neither", async () => {
    const answer = (accept: string) =>
      fetch(`${apiUrl}/`, { headers: { accept } });

    // Both named, html first: a page. The witness for the order below, which
    // asks for the same two types the other way round.
    const page = await answer("text/html, application/json");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    const description = (await client.root()).data;
    for (const accept of [
      "application/json, text/html",
      "text/plain",
      "application/xml",
      "image/png, */*;q=0.1",
    ]) {
      const program = await answer(accept);
      expect(program.status, accept).toBe(200);
      expect(program.headers.get("content-type"), accept).toContain(
        "application/json",
      );
      // The description of statements 1, 3 and 4, whole: the identity, the
      // features and the contract version.
      expect(await program.json(), accept).toEqual(description);
    }
  });

  it("sends Vary: Accept on a refusal at the root as on the answers it varies", async () => {
    // A query key the root does not take is refused before its handler runs,
    // so a cache that was handed the refusal would be handed it for a
    // browser and for a program alike.
    for (const accept of [undefined, "application/json", "text/html"]) {
      const refused = await fetch(`${apiUrl}/?not_a_key=1`, {
        headers: accept === undefined ? {} : { accept },
      });
      expect(refused.status, String(accept)).toBe(400);
      expect(refused.headers.get("vary"), String(accept)).toContain("Accept");
    }

    // The witness: the same address without the key is answered, and says it
    // varies as well, so the refusals are the ones the header was added to.
    const served = await fetch(`${apiUrl}/`);
    expect(served.status).toBe(200);
    expect(served.headers.get("vary")).toContain("Accept");

    const head = await fetch(`${apiUrl}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("vary")).toContain("Accept");
  });

  it("sends the page policy on the page a refusal renders, and none on the refusal a program is sent", async () => {
    // Refused by a middleware before any door ran, by the credential gate,
    // and by the root's own query check.
    const refusals: [string, string, Record<string, string>, number][] = [
      ["a request with no credential", "/items", {}, 401],
      [
        "a read view the sign-in page refuses",
        "/auth/sign-in",
        { "X-Marfa-Read-View": "x" },
        400,
      ],
      ["a query key the root does not take", "/?not_a_key=1", {}, 400],
    ];
    const nonces = new Set<string>();
    for (const [label, path, extra, status] of refusals) {
      const asPage = await fetch(`${apiUrl}${path}`, {
        headers: { accept: "text/html", ...extra },
      });
      expect(asPage.status, label).toBe(status);
      expect(asPage.headers.get("content-type"), label).toContain("text/html");
      const policy = asPage.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
      expect(nonce, label).toBeTruthy();
      expect(policy, label).toContain(`style-src 'nonce-${nonce ?? ""}'`);
      nonces.add(nonce ?? "");

      // The witness: the same refusal, asked as a program, is not a page and
      // carries no page policy.
      const asProgram = await fetch(`${apiUrl}${path}`, { headers: extra });
      expect(asProgram.status, `${label}, as a program`).toBe(status);
      expect(asProgram.headers.get("content-type"), label).toContain(
        "application/json",
      );
      expect(
        asProgram.headers.get("content-security-policy"),
        label,
      ).toBeNull();
    }
    expect(nonces.size).toBe(refusals.length);
  });

  it("names in its policy the one nonce its page carries, a new one on each answer at one address", async () => {
    const asBrowser = { accept: "text/html" };
    const nonces = new Set<string>();
    const asked = 20;
    for (let call = 0; call < asked; call++) {
      const res = await fetch(`${apiUrl}/`, { headers: asBrowser });
      const policy = res.headers.get("content-security-policy") ?? "";
      // A script and a style are allowed by that nonce alone.
      const scripts = /script-src ([^;]*)/.exec(policy)?.[1];
      const styles = /style-src ([^;]*)/.exec(policy)?.[1];
      const nonce = /^'nonce-([^']+)'$/.exec(scripts ?? "")?.[1];
      expect(nonce, `call ${String(call)}`).toBeTruthy();
      expect(styles).toBe(`'nonce-${nonce ?? ""}'`);
      nonces.add(nonce ?? "");

      // What the page carries is the nonce its own policy names, so it is the
      // page that works under the policy and not a nonce nothing uses.
      const carried = [...(await res.text()).matchAll(/nonce="([^"]+)"/g)].map(
        (match) => match[1],
      );
      if (call === 0) expect(carried.length).toBeGreaterThan(0);
      expect(new Set(carried), `call ${String(call)}`).toEqual(
        new Set([nonce]),
      );
    }
    expect(nonces.size).toBe(asked);
  });

  it("sends a content security policy with every HTML page and a nonce of its own with each", async () => {
    const asBrowser = { accept: "text/html" };
    const nonces = new Set<string>();
    // The root, a page, and the page a path nothing serves answers.
    for (const path of [
      "/",
      "/auth/sign-in",
      "/auth/device",
      "/no-such-page",
    ]) {
      const res = await fetch(`${apiUrl}${path}`, { headers: asBrowser });
      expect(res.headers.get("content-type"), path).toContain("text/html");
      const policy = res.headers.get("content-security-policy") ?? "";
      expect(policy, path).toContain("default-src 'none'");
      expect(policy, path).toMatch(/style-src 'nonce-[^']+'/);
      expect(policy, path).not.toContain("'self'");
      expect(policy, path).not.toContain("unsafe-inline");
      const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
      expect(nonce, path).toBeTruthy();
      nonces.add(nonce ?? "");
    }
    expect(nonces.size).toBe(4);

    // The witness: the same root asked the way a program asks is JSON, and
    // sends no page policy.
    const data = await fetch(`${apiUrl}/`);
    expect(data.headers.get("content-type")).toContain("application/json");
    expect(data.headers.get("content-security-policy")).toBeNull();
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

  it("sends its contract version on every kind of answer, not only a JSON body", async () => {
    // The statement says every answer, and the header is set by the layer
    // ahead of the credential, the body cap and the sign-in library, so the
    // answers below come from places that layer does not own: a page, a
    // stream, a file, a body-less answer, a refusal made before a handler
    // runs, and the sign-in library's own.
    const root = await client.root();
    const contract = String(root.data.contract);
    const bytes = new TextEncoder().encode(
      `a blob for the header ${Date.now()}`,
    );
    const uploaded = await uploadReferenced(client, ctx, bytes, "text/plain");
    expect(uploaded.ok, JSON.stringify(uploaded.error)).toBe(true);
    const auth = { Authorization: `Bearer ${apiKey}` };
    const asBrowser = { accept: "text/html" };

    const stream = await fetch(`${apiUrl}/events`, { headers: auth });
    await stream.body?.cancel();
    const tooLarge = await fetch(`${apiUrl}/items`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_048_576) }),
    });
    const answers: [string, number, Response][] = [
      ["a page", 200, await fetch(`${apiUrl}/`, { headers: asBrowser })],
      [
        "a sign-in page",
        200,
        await fetch(`${apiUrl}/auth/sign-in`, { headers: asBrowser }),
      ],
      [
        "the sign-in library's own answer",
        200,
        await fetch(`${apiUrl}/auth/get-session`),
      ],
      ["an event stream", 200, stream],
      ["a body past the cap", 413, tooLarge],
      [
        "a HEAD at the root",
        200,
        await fetch(`${apiUrl}/`, { method: "HEAD" }),
      ],
      [
        "a HEAD of a read",
        200,
        await fetch(`${apiUrl}/items?limit=1`, {
          method: "HEAD",
          headers: auth,
        }),
      ],
      [
        "a blob download",
        200,
        await fetch(`${apiUrl}/blobs/${uploaded.data.hash}`, { headers: auth }),
      ],
      ["a request to /health", 200, await fetch(`${apiUrl}/health`)],
    ];
    for (const [label, status, response] of answers) {
      expect(response.status, label).toBe(status);
      expect(response.headers.get("X-Marfa-Contract"), label).toBe(contract);
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
    // The same value is a UUIDv7 at the other two doors, whether or not the
    // equality above holds the shape.
    expect((config.data as { instance_id: string }).instance_id).toMatch(
      UUID_V7,
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
    expect(manifest.instance_id).toMatch(UUID_V7);
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
