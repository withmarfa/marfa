/**
 * What the committed `openapi.json` says about itself, beyond the style
 * guide: every operation is identifiable, the refusals are closed sets, no
 * shape is written out twice and no component admits a null it cannot
 * answer.
 */
import { describe, expect, it } from "vitest";
import { document, inlineRefs } from "./document.js";

type Operation = Record<string, unknown>;
type Paths = Record<string, Record<string, Operation>>;

/** `GET /items/{id}` as the document keys an operation. */
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
  // What a body this schema admits can fail to say: every branch of a union
  // is a body of its own, and the branches of an `allOf` are one body.
  const problem = (schema: unknown): string | undefined => {
    const record = (schema ?? {}) as Record<string, unknown>;
    for (const key of ["anyOf", "oneOf"]) {
      const branches = record[key];
      if (Array.isArray(branches)) {
        return branches.map(problem).find((p) => p !== undefined);
      }
    }
    if (Array.isArray(record.allOf)) {
      const found = (record.allOf as unknown[]).map(problem);
      return found.some((p) => p === undefined) ? undefined : found[0];
    }
    const properties = (record.properties ?? {}) as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    // A described reference reaches here as `allOf`, the error block in one
    // branch and the field's own text in the other.
    const error =
      properties.error === undefined
        ? undefined
        : ((
            (properties.error as { allOf?: (typeof properties)[string][] })
              .allOf ?? [properties.error]
          ).find((branch) => branch.properties !== undefined) ??
          properties.error);
    if (error === undefined) {
      // The registration's `415` is the sign-in library's own shape, which
      // names its code beside the message rather than under `error`.
      if (properties.code !== undefined) {
        return closedCode(properties.code) ? undefined : "open";
      }
      return "no code";
    }
    return closedCode(error.properties?.code ?? error) ? undefined : "open";
  };
  for (const [key, operation] of operationKeys(document)) {
    const responses = (operation.responses ?? {}) as Record<
      string,
      { content?: Record<string, { schema?: unknown }> }
    >;
    for (const [status, response] of Object.entries(responses)) {
      if (Number(status) < 400) continue;
      // A down instance answers its health check with the health itself.
      if (key === "GET /health" && status === "503") continue;
      const media = Object.values(response.content ?? {});
      if (media.length === 0) out.push(`${key} ${status} (no content)`);
      for (const { schema } of media) {
        const found = problem(inlineRefs(schema, document));
        if (found === "open") out.push(`${key} ${status}`);
        else if (found !== undefined) out.push(`${key} ${status} (${found})`);
      }
    }
  }
  return [...new Set(out)].sort();
}

describe("the committed OpenAPI document", () => {
  const published = operationKeys(document);

  it("gives every published operation an operationId", () => {
    // Reference renderers otherwise generate an unstable anchor.
    const anonymous = [...published.entries()]
      .filter(([, operation]) => typeof operation.operationId !== "string")
      .map(([key]) => key)
      .sort();
    expect(anonymous).toEqual([]);
  });

  it("declares 500 internal_error on every operation the error handler answers for", () => {
    // The handler answers a fault nothing named alike on every door, so a
    // door that left the status out would send a client branching on the
    // document to a status it never declared. Registration answers in the
    // sign-in library's own envelope, so it declares none.
    const ref = "#/components/schemas/InternalErrorRefusal";
    const declares = (operation: Operation): boolean => {
      const responses = (operation.responses ?? {}) as Record<
        string,
        { content?: Record<string, { schema?: { $ref?: string } }> }
      >;
      return (
        responses["500"]?.content?.["application/json"]?.schema?.$ref === ref
      );
    };
    const without = [...published.entries()]
      .filter(([, operation]) => !declares(operation))
      .map(([key]) => key);
    expect(without).toEqual(["POST /auth/oauth2/register"]);
    // The witness: the check is about an operation that declares it.
    expect(declares(published.get("GET /items/{id}")!)).toBe(true);
    expect(declares({ responses: {} })).toBe(false);
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
    // A move answers a job or a plan, not a type.
    const typeOperations = [...published.entries()].filter(
      ([key]) => /^(GET|POST|PUT) \/types/.test(key) && !key.endsWith("/move"),
    );
    expect(typeOperations.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [key, operation] of typeOperations) {
      const responses = (operation as { responses?: unknown }).responses;
      expect(responses, `${key} has no responses object`).toBeDefined();
      // Followed through the registered components, because the type shape
      // is one, so the field this pins is a reference away.
      const text = JSON.stringify(inlineRefs(responses, document));
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

  it("registers no component that admits a null it cannot answer", () => {
    // `.nullable()` on a registered shape does not wrap the reference: it
    // folds the null into the component, so one door that answers `null`
    // makes every door referencing that shape declare a null it never
    // sends. A null belongs at the one position that has it, beside the
    // reference.
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
      "Carry the null at the position that has one, beside the reference.",
    ).toEqual([]);

    // The witness: a shape that admits a null is what the predicate has to
    // catch.
    expect(admitsNull({ type: ["string", "null"] })).toBe(true);
    expect(admitsNull({ type: "null" })).toBe(true);
    expect(admitsNull({ enum: ["ok", null] })).toBe(true);
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
    // is not.
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
      "Declare the shape once under components and reference it.",
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
      "Declare the codes this status answers as an enum.",
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
    const flagged = openRefusals(opened);
    expect(flagged).toContain("GET /items 401");
    expect(flagged.length).toBeGreaterThan(50);

    const bare = structuredClone(document) as typeof opened;
    (bare.paths["/items"]?.get?.responses as Record<string, unknown>)["401"] = {
      description: "no code",
      content: { "application/json": { schema: { type: "object" } } },
    };
    expect(openRefusals(bare as unknown as Record<string, unknown>)).toEqual([
      "GET /items 401 (no code)",
    ]);

    // A union whose one branch says nothing about its code, and a refusal
    // with no content at all.
    const union = structuredClone(document) as typeof opened;
    const itemsGet = union.paths["/items"]?.get?.responses as Record<
      string,
      unknown
    >;
    itemsGet["401"] = {
      description: "one branch open",
      content: {
        "application/json": {
          schema: {
            anyOf: [
              { $ref: "#/components/schemas/UnauthorizedRefusal" },
              { type: "object", properties: { message: { type: "string" } } },
            ],
          },
        },
      },
    };
    itemsGet["400"] = { description: "no content" };
    expect(openRefusals(union as unknown as Record<string, unknown>)).toEqual([
      "GET /items 400 (no content)",
      "GET /items 401 (no code)",
    ]);
  });

  it("declares a credential on every operation but the public ones", () => {
    // A door with no `security` is reachable without a credential, so each is
    // named here with why. A door only the private socket answers is marked
    // instead, since no security scheme describes the socket.
    const PUBLIC = new Set([
      "GET /",
      "GET /health",
      "POST /owner",
      "POST /auth/oauth2/register",
    ]);
    const open = [...published]
      .filter(
        ([, operation]) =>
          operation.security === undefined &&
          operation["x-marfa-local-command"] !== true,
      )
      .map(([key]) => key)
      .sort();
    expect(open).toEqual([...PUBLIC].sort());

    // The witnesses: the check reads declarations and marks that exist.
    expect(published.get("GET /items")?.security).toEqual([{ bearerAuth: [] }]);
    expect(published.get("GET /owner")?.security).toBeUndefined();
    expect(published.get("GET /owner")?.["x-marfa-local-command"]).toBe(true);
  });

  it("names no security scheme the server does not accept", () => {
    const schemes = Object.keys(
      (document.components as { securitySchemes: Record<string, unknown> })
        .securitySchemes,
    ).sort();
    expect(schemes).toEqual(["bearerAuth", "ownerSession"]);
    const named = new Set(
      [...published.values()].flatMap((operation) =>
        (
          (operation.security as Record<string, unknown>[] | undefined) ?? []
        ).flatMap((requirement) => Object.keys(requirement)),
      ),
    );
    expect([...named].sort()).toEqual(schemes);
  });
});
