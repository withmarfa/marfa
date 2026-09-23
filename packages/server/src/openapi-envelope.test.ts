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

let schemas: Record<string, Schema>;
let pages: Map<string, string>;

beforeAll(async () => {
  const document = (await buildPublishedOpenAPISpec()) as {
    paths: Paths;
    components: { schemas: Record<string, Schema> };
  };
  schemas = document.components.schemas;
  pages = new Map();
  for (const [path, methods] of Object.entries(document.paths)) {
    const schema =
      methods.get?.responses?.["200"]?.content?.["application/json"]?.schema;
    const name = schema?.$ref?.split("/").pop();
    if (name && schemas[name]?.properties?.next_cursor !== undefined) {
      pages.set(`GET ${path}`, name);
    }
  }
}, 60_000);

describe("the page envelope in the document", () => {
  it("is answered by twenty-one doors", () => {
    expect(pages.size).toBe(21);
  });

  it("carries data and next_cursor, required, and only declared siblings", () => {
    const names = new Set(
      Object.entries(schemas)
        .filter(([, schema]) => schema.properties?.next_cursor !== undefined)
        .map(([name]) => name),
    );
    for (const name of pages.values()) expect(names).toContain(name);
    for (const name of names) {
      const schema = schemas[name]!;
      const siblings = SIBLINGS[name] ?? { required: [], optional: [] };
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
