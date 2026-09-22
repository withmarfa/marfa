import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRefId } from "@asteasolutions/zod-to-openapi";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createTestContext, type TestContext } from "./test-utils.js";

type ZodType = z.ZodType;

/**
 * The generator binds a component name to the first shape it meets under that
 * name and answers every later one with a reference to it, so a second,
 * different shape registered under a name already taken is published as the
 * first and nothing errors. This walks every schema the routes reach, groups
 * the named ones by name, and generates each distinct instance on its own to
 * see whether they are one shape.
 */

type Definitions = OpenAPIHono["openAPIRegistry"]["definitions"];

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "nonoptional",
]);

function namedInstances(definitions: Definitions): Map<string, Set<ZodType>> {
  const byName = new Map<string, Set<ZodType>>();
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const internals = (node as { _zod?: { def: Record<string, unknown> } })
      ._zod;
    if (internals === undefined) {
      // A plain container inside a definition, such as an object's shape.
      Object.values(node).forEach(walk);
      return;
    }
    seen.add(node);
    const def = internals.def;
    // A wrapper carries its inner schema's name without being a second shape.
    if (WRAPPERS.has(def.type as string)) {
      walk(def.innerType);
      return;
    }
    if (typeof (node as { meta?: unknown }).meta === "function") {
      const name = getRefId(node as ZodType);
      if (name !== undefined) {
        const instances = byName.get(name) ?? new Set<ZodType>();
        instances.add(node as ZodType);
        byName.set(name, instances);
      }
    }
    for (const value of Object.values(def)) walk(value);
    if (def.type === "lazy" && typeof def.getter === "function") {
      walk((def.getter as () => unknown)());
    }
  };
  for (const definition of definitions) {
    if (definition.type === "route") {
      const route = definition.route;
      walk(route.request);
      for (const response of Object.values(route.responses)) walk(response);
    } else if ("schema" in definition) {
      walk(definition.schema);
    }
  }
  return byName;
}

/** The shape one instance publishes when it is the only one under its name. */
function publishedAlone(name: string, schema: ZodType): string {
  const probe = new OpenAPIHono();
  probe.openAPIRegistry.register(name, schema);
  const components = probe.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "probe", version: "1" },
  }).components?.schemas as Record<string, Record<string, unknown>>;
  // A description added at one use is metadata over the same shape, which
  // the generator publishes as a sibling of the reference, not a collision.
  const shape = { ...components[name] };
  delete shape.description;
  return JSON.stringify(shape);
}

function collisions(definitions: Definitions): string[] {
  const out: string[] = [];
  for (const [name, instances] of namedInstances(definitions)) {
    if (instances.size < 2) continue;
    const shapes = new Set(
      [...instances].map((schema) => publishedAlone(name, schema)),
    );
    if (shapes.size > 1) out.push(name);
  }
  return out.sort();
}

describe("component names", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("binds each name to one shape", () => {
    const definitions = ctx.app.openAPIRegistry.definitions;
    // The positive control: the walk reached the named shapes at all.
    expect(namedInstances(definitions).size).toBeGreaterThan(100);
    expect(
      collisions(definitions),
      "Two different shapes carry one component name; the document publishes whichever the generator met first.",
    ).toEqual([]);
  });

  it("finds a name bound to two shapes", () => {
    const first = z.object({ id: z.string() }).openapi("ProbeShape");
    const second = z.object({ id: z.number() }).openapi("ProbeShape");
    const probe = new OpenAPIHono();
    probe.openapi(
      createRoute({
        operationId: "probeCollision",
        method: "get",
        path: "/probe",
        responses: {
          200: {
            content: {
              "application/json": {
                schema: z.object({ a: first, b: second }),
              },
            },
            description: "ok",
          },
        },
      }),
      (c) => c.json({ a: { id: "x" }, b: { id: 1 } }, 200),
    );
    expect(collisions(probe.openAPIRegistry.definitions)).toEqual([
      "ProbeShape",
    ]);
  });
});
