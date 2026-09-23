import { beforeAll, describe, expect, it } from "vitest";
import { buildPublishedOpenAPISpec } from "./openapi-published.js";

/**
 * Every list and search answers `{data, next_cursor}`, both required and
 * nothing else beside them but the siblings two doors declare about the
 * answer. The conformance suite holds the served bodies to this; this holds
 * the document to it, so a door that publishes a page shape of its own fails
 * here rather than in a generated client.
 */

interface Schema {
  $ref?: string;
  allOf?: Schema[];
  properties?: Record<string, unknown>;
  required?: string[];
}
type Paths = Record<
  string,
  Record<
    string,
    {
      responses?: Record<
        string,
        { content?: Record<string, { schema?: Schema }> }
      >;
    }
  >
>;

/** The keys a page may carry beside `data` and `next_cursor`, by component. */
const SIBLINGS: Record<string, { required: string[]; optional: string[] }> = {
  BlobStorePage: { required: ["min_copies"], optional: [] },
  OccurrencePage: {
    required: ["scan", "window"],
    optional: [
      "expansion_incomplete",
      "series_errors",
      "series_errors_truncated",
    ],
  },
};

interface Shape {
  properties: Set<string>;
  required: Set<string>;
  components: Set<string>;
}

/**
 * The object a response schema answers: its own properties and required
 * keys and every `allOf` branch's, through references, with the components
 * it reached on the way. A page is found however it is declared, so an
 * inline one or one composed across an `allOf` is counted and held to the
 * same shape as one named by reference.
 */
function shapeOf(schema: Schema | undefined, into: Shape): Shape {
  if (!schema) return into;
  const name = schema.$ref?.split("/").pop();
  if (name !== undefined) {
    into.components.add(name);
    return shapeOf(schemas[name], into);
  }
  for (const key of Object.keys(schema.properties ?? {})) {
    into.properties.add(key);
  }
  for (const key of schema.required ?? []) into.required.add(key);
  for (const branch of schema.allOf ?? []) shapeOf(branch, into);
  return into;
}

let schemas: Record<string, Schema>;
let pages: Map<string, Shape>;

beforeAll(async () => {
  const document = (await buildPublishedOpenAPISpec()) as {
    paths: Paths;
    components: { schemas: Record<string, Schema> };
  };
  schemas = document.components.schemas;
  pages = new Map();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const shape: Shape = {
        properties: new Set(),
        required: new Set(),
        components: new Set(),
      };
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if (!/^2\d\d$/.test(status)) continue;
        for (const [mediaType, media] of Object.entries(
          response.content ?? {},
        )) {
          if (/\bjson\b/.test(mediaType)) shapeOf(media.schema, shape);
        }
      }
      if (shape.properties.has("data") && shape.properties.has("next_cursor")) {
        pages.set(`${method.toUpperCase()} ${path}`, shape);
      }
    }
  }
}, 60_000);

function siblingsOf(components: Iterable<string>): {
  required: string[];
  optional: string[];
} {
  const out = { required: [] as string[], optional: [] as string[] };
  for (const name of components) {
    out.required.push(...(SIBLINGS[name]?.required ?? []));
    out.optional.push(...(SIBLINGS[name]?.optional ?? []));
  }
  return out;
}

describe("the page envelope in the document", () => {
  it("is answered by twenty-one doors", () => {
    expect(pages.size).toBe(21);
  });

  it("answers data and next_cursor, required, and only declared siblings, on every door", () => {
    for (const [door, shape] of pages) {
      const siblings = siblingsOf(shape.components);
      expect([...shape.properties].sort(), door).toEqual(
        [
          "data",
          "next_cursor",
          ...siblings.required,
          ...siblings.optional,
        ].sort(),
      );
      expect([...shape.required].sort(), door).toEqual(
        ["data", "next_cursor", ...siblings.required].sort(),
      );
    }
  });

  it("carries data and next_cursor, required, and only declared siblings", () => {
    const names = Object.entries(schemas)
      .filter(([, schema]) => schema.properties?.next_cursor !== undefined)
      .map(([name]) => name);
    for (const name of names) {
      const schema = schemas[name]!;
      const siblings = siblingsOf([name]);
      expect(Object.keys(schema.properties ?? {}).sort(), name).toEqual(
        [
          "data",
          "next_cursor",
          ...siblings.required,
          ...siblings.optional,
        ].sort(),
      );
      expect([...(schema.required ?? [])].sort(), name).toEqual(
        ["data", "next_cursor", ...siblings.required].sort(),
      );
    }
  });
});
