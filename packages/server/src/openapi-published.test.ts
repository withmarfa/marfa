import { beforeAll, describe, expect, it } from "vitest";
import { buildPublishedOpenAPISpec } from "./openapi-published.js";
import { EXTRA_PATHS } from "./openapi-finalize.js";
import { createTestContext, inlineOpenApiRefs, request } from "./test-utils.js";

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
  let document: Record<string, unknown>;

  beforeAll(async () => {
    document = await buildPublishedOpenAPISpec();
    published = operationKeys(document);
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

  it("does not send a reader to a documentation site to learn what a door does", () => {
    // `AGENTS.md`: the server's behavior is the specification and the docs
    // site is not a source of truth. A description that sends the reader
    // somewhere else to find out what a door does is therefore a
    // description that does not say, and the somewhere else is a page
    // nothing in this repository can hold to the code.
    //
    // This replaces a check that the links pointed at sections that exist.
    // Every such link has since gone, so that check was asserting a
    // property of an empty set — green whatever the descriptions said.
    //
    // A floor rather than a proof. It catches the shapes that leave the
    // document — root-relative, protocol-relative, and anything carrying a
    // scheme — and lets a relative target or a bare anchor through, because
    // those resolve wherever the description is rendered.
    const offenders: string[] = [];
    for (const [key, operation] of published.entries()) {
      const text = JSON.stringify(operation);
      for (const match of text.matchAll(
        /\]\((\/\/?[^)]*|[A-Za-z][A-Za-z0-9+.-]*:[^)]*)\)/g,
      )) {
        offenders.push(`${key} -> ${match[1] ?? ""}`);
      }
    }
    // The positive control. Both this and the walk above read `published`,
    // so an empty document would satisfy the assertion having examined
    // nothing.
    expect(published.size).toBeGreaterThan(50);
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
      // Followed through the registered components: the type shape is one
      // of them now, so the field this pins is a reference away rather than
      // written out on each operation.
      const text = JSON.stringify(inlineOpenApiRefs(responses, document));
      if (!text.includes('"compatible_with"')) missing.push(key);
    }
    expect(missing.sort()).toEqual([]);
  });

  it("writes a registered shape as a reference wherever it appears", () => {
    // A component exists so one shape is described once. A copy of it
    // written out on an operation is a second description of the same
    // thing: it generates a second type in every client, and the two drift
    // the moment one door's schema is edited and the other is not. The
    // document is generated, so this cannot be a matter of care — it is a
    // shape that was declared somewhere other than where the component
    // came from.
    const components = (
      (document.components ?? {}) as {
        schemas?: Record<string, unknown>;
      }
    ).schemas;
    expect(components, "the document registers no components").toBeDefined();
    const byShape = new Map<string, string>();
    for (const [name, schema] of Object.entries(components ?? {})) {
      byShape.set(JSON.stringify(schema), name);
    }
    expect(byShape.size).toBeGreaterThan(20);

    const inlined: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => {
          walk(child, `${where}/${String(index)}`);
        });
        return;
      }
      if (node === null || typeof node !== "object") return;
      const named = byShape.get(JSON.stringify(node));
      if (named !== undefined) inlined.push(`${where} is ${named}`);
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
        walk(value, `${where}/${key}`);
      }
    };
    walk(document.paths, "");

    expect(
      inlined.sort(),
      'Register the shape once with `.openapi("Name")` where it is ' +
        "declared, and let every door reference it.",
    ).toEqual([]);
  });
});
