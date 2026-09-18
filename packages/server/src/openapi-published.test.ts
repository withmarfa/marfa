import { beforeAll, describe, expect, it } from "vitest";
import { buildPublishedOpenAPISpec } from "./openapi-published.js";
import { EXTRA_PATHS } from "./openapi-finalize.js";
import { createTestContext, request } from "./test-utils.js";

type Operation = Record<string, unknown>;
type Paths = Record<string, Record<string, Operation>>;

/** `GET /items/{id}` — the identity used to compare operations across specs. */
function operationKeys(spec: Record<string, unknown>): Map<string, Operation> {
  const paths = (spec.paths ?? {}) as Paths;
  const out = new Map<string, Operation>();
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      out.set(`${method.toUpperCase()} ${path}`, operation);
    }
  }
  return out;
}

describe("published OpenAPI spec", () => {
  let published: Map<string, Operation>;

  beforeAll(async () => {
    published = operationKeys(await buildPublishedOpenAPISpec());
  }, 60_000);

  it("is the document the server itself serves at /openapi.json", async () => {
    const ctx = await createTestContext();
    try {
      const res = await request(ctx.app, "GET", "/openapi.json");
      expect(res.status).toBe(200);
      const served = operationKeys(
        (await res.json()) as Record<string, unknown>,
      );
      expect([...served.keys()].sort()).toEqual([...published.keys()].sort());
    } finally {
      await ctx.cleanup();
    }
  });

  it("serves every hand-declared path at the path it is published under", async () => {
    // The reflection cannot see these routes, so their paths are typed by
    // hand, and a typed path is one nothing checks. The registration
    // operation was published at `/oauth2/register` for months while the
    // route lived under `/auth`, and a carve-out excused the phantom from
    // the header declarations rather than correcting it. Anything other
    // than the router's 404 says the path is served: an unauthenticated
    // stream request is refused as 401 and a bodyless registration as 400.
    const ctx = await createTestContext();
    try {
      for (const [path, methods] of Object.entries(EXTRA_PATHS)) {
        for (const method of Object.keys(methods)) {
          const res = await request(
            ctx.app,
            method.toUpperCase(),
            path.replace(/\{[^}]+\}/g, "x"),
            { headers: { origin: "http://localhost:0" } },
          );
          expect(res.status, `${method.toUpperCase()} ${path}`).not.toBe(404);
        }
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("gives every published operation an operationId", () => {
    // The internal-operation exclusion in `openapi-finalize.ts` keys on
    // operationId, so an operation without one can never be filtered out, and
    // reference renderers fall back to generating an unstable anchor for it.
    const anonymous = [...published.entries()]
      .filter(([, operation]) => typeof operation.operationId !== "string")
      .map(([key]) => key)
      .sort();
    expect(anonymous).toEqual([]);
  });

  it("links only into documentation sections that exist", () => {
    // Route descriptions carry markdown links into the docs site, and the docs
    // build prerenders by crawling them, so a link to a section that does not
    // exist fails that build rather than degrading quietly. These are the
    // top-level sections the site actually publishes; a link outside them is a
    // typo or a section that was renamed without updating the routes.
    const sections = [
      "/guides/",
      "/api-reference/",
      "/sdks/",
      "/self-hosting/",
      "/introduction",
    ];

    const offenders: string[] = [];
    for (const [key, operation] of published.entries()) {
      const text = JSON.stringify(operation);
      for (const match of text.matchAll(/\]\((\/[a-z0-9\-/#]*)\)/g)) {
        const href = match[1];
        if (href && !sections.some((section) => href.startsWith(section))) {
          offenders.push(`${key} -> ${href}`);
        }
      }
    }

    expect(offenders.sort()).toEqual([]);
  });

  it("serves compatible_with on every type-resource response", () => {
    // Clients resolve a sibling type's read-as relationship from this field,
    // and generated clients only see what the spec declares — it went missing
    // once and every generated client silently lost type-compatibility
    // resolution while the runtime bodies kept carrying it. This pins the
    // generated surface so the field cannot rot off the wire again.
    //
    // Scoped to `responses`, deliberately: stringifying the whole operation
    // also matches a request body, so a field present only in what clients
    // SEND would satisfy a check about what they RECEIVE. It held before
    // only because the type-route request bodies happened to be untyped.
    const typeOperations = [...published.entries()].filter(([key]) =>
      /^(GET|POST|PUT) \/types/.test(key),
    );
    expect(typeOperations.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [key, operation] of typeOperations) {
      const responses = (operation as { responses?: unknown }).responses;
      expect(responses, `${key} has no responses object`).toBeDefined();
      const text = JSON.stringify(responses);
      if (!text.includes('"compatible_with"')) missing.push(key);
    }
    expect(missing.sort()).toEqual([]);
  });
});
