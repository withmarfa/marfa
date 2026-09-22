import { beforeAll, describe, expect, it } from "vitest";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { buildPublishedOpenAPISpec } from "./openapi-published.js";
import { EXTRA_PATHS, CHAIN_REFUSALS } from "./openapi-finalize.js";
import { makeErrorResponseSchema } from "./openapi.js";
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

/**
 * Every refusal the document declares whose code is not a closed set.
 *
 * A refusal names its code under `error.code`, or, in the RFC shapes the
 * OAuth doors answer, as a top-level `error`. Either position has to carry an
 * `enum` or a `const`: an open string admits every code, so a generated client
 * has nothing to branch on and no check can tell a new code from a declared
 * one. A refusal with no code position at all is reported too.
 */
function openRefusals(document: Record<string, unknown>): string[] {
  const out: string[] = [];
  const closedCode = (schema: unknown): boolean => {
    const record = (schema ?? {}) as { enum?: unknown[]; const?: unknown };
    return Array.isArray(record.enum) || record.const !== undefined;
  };
  // Every schema a response admits, through the unions and compositions.
  const branches = (schema: unknown): Record<string, unknown>[] => {
    const record = (schema ?? {}) as Record<string, unknown>;
    const nested = ["anyOf", "oneOf", "allOf"].flatMap((key) =>
      Array.isArray(record[key])
        ? (record[key] as unknown[]).flatMap(branches)
        : [],
    );
    return [record, ...nested];
  };
  for (const [key, operation] of operationKeys(document)) {
    const responses = (operation.responses ?? {}) as Record<
      string,
      { content?: Record<string, { schema?: unknown }> }
    >;
    for (const [status, response] of Object.entries(responses)) {
      if (Number(status) < 400) continue;
      for (const media of Object.values(response.content ?? {})) {
        const schema = inlineOpenApiRefs(media.schema, document);
        let positions = 0;
        for (const branch of branches(schema)) {
          const properties = (branch.properties ?? {}) as Record<
            string,
            { properties?: Record<string, unknown> }
          >;
          const error = properties.error;
          if (error === undefined) continue;
          const code = error.properties?.code ?? error;
          positions += 1;
          if (!closedCode(code)) out.push(`${key} ${status}`);
        }
        if (positions === 0) out.push(`${key} ${status} (no code)`);
      }
    }
  }
  return [...new Set(out)].sort();
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
    // hand, and a typed path is one nothing else checks: the document can
    // publish an operation at a path no router serves. Anything other than
    // the router's 404 says the path is served: an unauthenticated stream
    // request is refused as 401 and a bodyless registration as 400.
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
    // A client resolves a sibling type's read-as relationship from this
    // field, and a generated client sees only what the document declares,
    // so a field the runtime bodies carry and the document omits is a
    // relationship no generated client can resolve.
    //
    // Scoped to `responses`, deliberately: the type-authoring bodies carry
    // the field too, and a check over the whole operation would be
    // satisfied by what a client sends when it is about what it receives.
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

  /**
   * Every object shape the document writes out, and where.
   *
   * Keyed by the shape itself, so two positions carrying the same fields
   * are one entry whatever they are called. Schemas with no `properties`
   * are left out: a bare string or an integer is a shape that repeats for
   * the good reason that many fields are strings.
   *
   * Handed the operations and the components together, because a shape
   * written out inside two components is the same defect as one written out
   * on two doors and reaches a client the same way. A component's own top
   * level is skipped by the caller below, since a registered shape is
   * supposed to appear there once.
   */
  function inlineShapes(paths: unknown): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => {
          walk(child, `${where}/${String(index)}`);
        });
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (
        record.properties !== null &&
        typeof record.properties === "object" &&
        Object.keys(record.properties).length > 0
      ) {
        const key = JSON.stringify(record);
        found.set(key, [...(found.get(key) ?? []), where]);
      }
      for (const [field, value] of Object.entries(record)) {
        walk(value, `${where}/${field}`);
      }
    };
    walk(paths, "");
    return found;
  }

  it("declares the chain's own refusals as a reflected one would", () => {
    // The credential gate, the body-size cap and the limiter are each
    // middleware across a set of routes, so the operations that answer them
    // are decided by where the middleware sits and the refusals are written
    // out by hand in the finalizer. What a reflected refusal looks like is
    // not a matter of opinion: it is whatever `makeErrorResponseSchema`
    // produces, so one is built here and the two are compared. Reflected
    // through its own app rather than read out of the document, because the
    // point is the shape a route would have registered.
    for (const refusal of Object.values(CHAIN_REFUSALS)) {
      const probe = new OpenAPIHono();
      probe.openapi(
        createRoute({
          operationId: `probe${refusal.name}`,
          method: "get",
          path: "/probe",
          responses: {
            400: {
              content: {
                "application/json": {
                  schema: makeErrorResponseSchema(
                    refusal.codes as unknown as [string, ...string[]],
                  ),
                },
              },
              description: "Refused by the chain.",
            },
          },
        }),
        (c) => c.json({ error: { code: refusal.codes[0], message: "" } }, 400),
      );
      const reflected = (
        probe.getOpenAPI31Document({
          openapi: "3.1.0",
          info: { title: "probe", version: "1" },
        }).components as { schemas: Record<string, unknown> }
      ).schemas[refusal.name];

      expect(
        reflected,
        `${refusal.name} was not registered by the probe`,
      ).toBeDefined();
      expect(refusal.schema, refusal.name).toEqual(reflected);
      expect(
        (document.components as { schemas: Record<string, unknown> }).schemas[
          refusal.name
        ],
        refusal.name,
      ).toEqual(reflected);
    }
  });

  it("registers no component that admits a null it cannot answer", () => {
    // `.nullable()` on a registered shape does not wrap the reference: it
    // folds the null into the component, so one door that answers `null`
    // makes every door referencing that shape declare a null it never
    // sends. `nullableRef` in `routes/_schemas.ts` is what carries a null
    // at the one position that has one.
    const components = (
      document.components as { schemas: Record<string, unknown> }
    ).schemas;
    const admitsNull = (schema: unknown): boolean => {
      const declared = (schema as { type?: unknown }).type;
      const values = (schema as { enum?: unknown[] }).enum;
      return (
        (Array.isArray(declared) && declared.includes("null")) ||
        declared === "null" ||
        (Array.isArray(values) && values.includes(null))
      );
    };
    const admitting = Object.entries(components)
      .filter(([, schema]) => admitsNull(schema))
      .map(([name]) => name);
    expect(Object.keys(components).length).toBeGreaterThan(20);
    expect(
      admitting.sort(),
      "Carry the null at the position that has one, with `nullableRef`.",
    ).toEqual([]);

    // The witness: the same shape, made nullable at one use, is what the
    // predicate above has to catch.
    const outcome = z.enum(["ok", "error"]).openapi("ProbeOutcome");
    const probe = new OpenAPIHono();
    probe.openapi(
      createRoute({
        operationId: "probeNullable",
        method: "get",
        path: "/probe",
        responses: {
          200: {
            content: {
              "application/json": {
                schema: z.object({ last: outcome.nullable(), now: outcome }),
              },
            },
            description: "ok",
          },
        },
      }),
      (c) => c.json({ last: null, now: "ok" as const }, 200),
    );
    const polluted = (
      probe.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "probe", version: "1" },
      }).components as { schemas: Record<string, { enum?: unknown[] }> }
    ).schemas.ProbeOutcome;
    expect(admitsNull(polluted), JSON.stringify(polluted)).toBe(true);
    expect(admitsNull(components.ItemState)).toBe(false);
  });

  it("finds a shape written out twice", () => {
    // The control for the two checks below, which both assert an absence.
    // A walk that reads nothing, or a key that stops matching equal
    // shapes, reports no repeats and no inlined components — which reads
    // exactly like a clean document.
    const copy = structuredClone(document.paths) as Record<string, unknown>;
    const item = (document.components as { schemas: Record<string, unknown> })
      .schemas.Item;
    (copy["/items"] as Record<string, unknown>).__probe = { schema: item };
    (copy["/items"] as Record<string, unknown>).__probe_again = {
      schema: structuredClone(item),
    };
    const repeats = [...inlineShapes(copy).values()].filter(
      (places) => places.length > 1,
    );
    expect(repeats.flat()).toContain("//items/__probe/schema");
    expect(repeats.flat()).toContain("//items/__probe_again/schema");
  });

  /**
   * The operations, plus what each component carries below its own top
   * level.
   */
  function shapeSources(): Record<string, unknown> {
    const components = (
      document.components as { schemas?: Record<string, unknown> }
    ).schemas;
    const inner: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(components ?? {})) {
      const { properties, items, anyOf, allOf, oneOf, additionalProperties } =
        schema as Record<string, unknown>;
      inner[name] = {
        properties,
        items,
        anyOf,
        allOf,
        oneOf,
        additionalProperties,
      };
    }
    return { paths: document.paths, components: inner };
  }

  it("writes a shape once, as a component, wherever it appears twice", () => {
    // A shape written out twice is two types in every generated client,
    // and they drift the moment one door's schema is edited and the other
    // is not. The document is generated, so this is never a matter of
    // care: it is a shape declared somewhere other than where a component
    // would have come from.
    const repeated = [...inlineShapes(shapeSources()).entries()]
      .filter(([, places]) => places.length > 1)
      .map(([shape, places]) => {
        const properties = Object.keys(
          (JSON.parse(shape) as { properties: object }).properties,
        ).join(",");
        return `${properties} at ${places.join(" and ")}`;
      });
    expect(
      repeated.sort(),
      'Declare the shape once and register it with `.openapi("Name")`.',
    ).toEqual([]);
  });

  it("registers each shape under one name, and writes none of them out", () => {
    const components = (
      (document.components ?? {}) as { schemas?: Record<string, unknown> }
    ).schemas;
    expect(components, "the document registers no components").toBeDefined();

    // Two names for one shape is the same defect as one shape written out
    // twice, a level up: the client gets both types, and a door referencing
    // one of them reads as though it answered something else.
    const namesByShape = new Map<string, string[]>();
    for (const [name, schema] of Object.entries(components ?? {})) {
      const key = JSON.stringify(schema);
      namesByShape.set(key, [...(namesByShape.get(key) ?? []), name]);
    }
    expect(namesByShape.size).toBeGreaterThan(20);
    expect(
      [...namesByShape.values()]
        .filter((names) => names.length > 1)
        .map((names) => names.join(" = "))
        .sort(),
    ).toEqual([]);

    // And a component written out on an operation rather than referenced.
    const byShape = new Map(
      Object.entries(components ?? {}).map(([name, schema]) => [
        JSON.stringify(schema),
        name,
      ]),
    );
    const inlined: string[] = [];
    for (const [shape, places] of inlineShapes(shapeSources())) {
      const named = byShape.get(shape);
      if (named !== undefined) {
        inlined.push(...places.map((place) => `${place} is ${named}`));
      }
    }
    expect(
      inlined.sort(),
      "Reference the component instead of writing the shape out again.",
    ).toEqual([]);
  });

  it("declares every refusal code as a closed set", () => {
    expect(
      openRefusals(document),
      "Declare the codes this status answers with `makeErrorResponseSchema`.",
    ).toEqual([]);

    // The witness: one refusal component opened to any string, and a
    // refusal declared with no code at all.
    const opened = structuredClone(document) as {
      components: { schemas: Record<string, Record<string, unknown>> };
      paths: Record<string, Record<string, Operation>>;
    };
    const unauthorized = opened.components.schemas.UnauthorizedRefusal as {
      properties: { error: { properties: { code: unknown } } };
    };
    unauthorized.properties.error.properties.code = { type: "string" };
    const flagged = openRefusals(opened as unknown as Record<string, unknown>);
    expect(flagged).toContain("GET /items 401");
    expect(flagged.length).toBeGreaterThan(50);

    const bare = structuredClone(document) as typeof opened;
    (
      bare.paths["/items"]?.get?.responses as Record<string, unknown>
    )["401"] = {
      description: "no code",
      content: { "application/json": { schema: { type: "object" } } },
    };
    expect(openRefusals(bare as unknown as Record<string, unknown>)).toEqual([
      "GET /items 401 (no code)",
    ]);
  });
});
