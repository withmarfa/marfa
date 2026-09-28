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
  oneOf?: Schema[];
  anyOf?: Schema[];
  properties?: Record<string, unknown>;
  required?: string[];
}
interface Document {
  paths: Record<
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
  components?: { schemas?: Record<string, Schema> };
}

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

const COMPONENT_REF = "#/components/schemas/";

function joined(left: Shape, right: Shape): Shape {
  return {
    properties: new Set([...left.properties, ...right.properties]),
    required: new Set([...left.required, ...right.required]),
    components: new Set([...left.components, ...right.components]),
  };
}

/**
 * Each object a response schema may answer: its own properties and required
 * keys, and the components it reached on the way. Every keyword at one level
 * applies at once, so a `$ref`, its siblings and each `allOf` branch add to
 * the same object, while each `oneOf` or `anyOf` branch is an object of its
 * own. A page is found however it is declared, so an inline one or one
 * composed across an `allOf` is held to the same shape as one named by
 * reference.
 *
 * `refs` holds the references being expanded on the way down rather than
 * every one seen, because the same component named twice side by side is
 * not a cycle.
 */
function shapesOf(
  schema: Schema | undefined,
  document: Document,
  refs: ReadonlySet<string> = new Set(),
): Shape[] {
  const own: Shape = {
    properties: new Set(Object.keys(schema?.properties ?? {})),
    required: new Set(schema?.required ?? []),
    components: new Set(),
  };
  if (!schema) return [own];
  const parts: Shape[][] = [[own]];
  const ref = schema.$ref;
  if (ref !== undefined) {
    if (refs.has(ref)) {
      throw new Error(`the document's ${ref} refers back to itself`);
    }
    const name = ref.startsWith(COMPONENT_REF)
      ? ref.slice(COMPONENT_REF.length)
      : undefined;
    const target =
      name === undefined ? undefined : document.components?.schemas?.[name];
    if (name === undefined || target === undefined) {
      throw new Error(`the document has no ${ref} to resolve`);
    }
    parts.push(
      shapesOf(target, document, new Set([...refs, ref])).map((shape) =>
        joined(shape, {
          properties: new Set(),
          required: new Set(),
          components: new Set([name]),
        }),
      ),
    );
  }
  for (const branch of schema.allOf ?? []) {
    parts.push(shapesOf(branch, document, refs));
  }
  for (const union of [schema.oneOf, schema.anyOf]) {
    if (union) {
      parts.push(union.flatMap((branch) => shapesOf(branch, document, refs)));
    }
  }
  return parts.reduce<Shape[]>(
    (sofar, part) =>
      sofar.flatMap((left) => part.map((right) => joined(left, right))),
    [
      {
        properties: new Set<string>(),
        required: new Set<string>(),
        components: new Set<string>(),
      },
    ],
  );
}

const isPage = (shape: Shape) =>
  shape.properties.has("data") && shape.properties.has("next_cursor");

/**
 * Every door that answers a success with a JSON page, and each page shape
 * it answers. Each status and media type is judged on its own, so keys two
 * different answers declare are never added together into a page neither
 * is.
 *
 * **A union counts only when every branch is a page, and one whose branches
 * disagree throws, naming the door.** Such a door answers a page on some
 * calls and not others: left out of the count, the only sign would be a
 * number one short, with nothing saying which door fell away.
 */
function pagesIn(document: Document): Map<string, Shape[]> {
  const out = new Map<string, Shape[]>();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const door = `${method.toUpperCase()} ${path}`;
      const found: Shape[] = [];
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if (!/^2(?:\d\d|XX)$/.test(status)) continue;
        for (const [mediaType, media] of Object.entries(
          response.content ?? {},
        )) {
          if (!/\bjson\b/.test(mediaType)) continue;
          const shapes = shapesOf(media.schema, document);
          const pages = shapes.filter(isPage);
          if (pages.length > 0 && pages.length < shapes.length) {
            throw new Error(
              `${door} answers ${status} ${mediaType} with a union of which ${String(pages.length)} of ${String(shapes.length)} branches are a page`,
            );
          }
          found.push(...pages);
        }
      }
      if (found.length > 0) out.set(door, found);
    }
  }
  return out;
}

let schemas: Record<string, Schema>;
let pages: Map<string, Shape[]>;

beforeAll(async () => {
  const document = (await buildPublishedOpenAPISpec()) as {
    paths: Document["paths"];
    components: { schemas: Record<string, Schema> };
  };
  schemas = document.components.schemas;
  pages = pagesIn(document);
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
  it("is answered by twenty-three doors", () => {
    expect(pages.size).toBe(23);
  });

  it("answers data and next_cursor, required, and only declared siblings, on every door", () => {
    for (const [door, shapes] of pages) {
      for (const shape of shapes) {
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

describe("finding the pages in a document", () => {
  const page: Schema = {
    properties: { data: {}, next_cursor: {} },
    required: ["data", "next_cursor"],
  };
  const answering = (
    schema: Schema,
    status = "200",
    mediaType = "application/json",
  ) => ({
    responses: { [status]: { content: { [mediaType]: { schema } } } },
  });
  const doorsOf = (document: Document) => [...pagesIn(document).keys()];

  it("finds a page answered under a 2XX range", () => {
    expect(
      doorsOf({ paths: { "/ranged": { get: answering(page, "2XX") } } }),
    ).toEqual(["GET /ranged"]);
  });

  it("judges each status and each media type on its own", () => {
    const rows: Schema = { properties: { data: {} } };
    const cursor: Schema = { properties: { next_cursor: {} } };
    expect(
      doorsOf({
        paths: {
          "/statuses": {
            get: {
              responses: {
                ...answering(rows, "200").responses,
                ...answering(cursor, "201").responses,
              },
            },
          },
          "/media": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": { schema: rows },
                    "application/problem+json": { schema: cursor },
                  },
                },
              },
            },
          },
        },
      }),
    ).toEqual([]);
    // The witness: a whole page on either answer is found.
    expect(
      doorsOf({
        paths: {
          "/statuses": {
            get: {
              responses: {
                ...answering(rows, "200").responses,
                ...answering(page, "201").responses,
              },
            },
          },
        },
      }),
    ).toEqual(["GET /statuses"]);
  });

  it("reads a reference's sibling keywords into the same page", () => {
    const found = pagesIn({
      paths: {
        "/sibling": {
          get: answering({
            $ref: "#/components/schemas/Rows",
            properties: { next_cursor: {} },
            required: ["next_cursor"],
          }),
        },
        "/bare": { get: answering({ $ref: "#/components/schemas/Rows" }) },
      },
      components: {
        schemas: { Rows: { properties: { data: {} }, required: ["data"] } },
      },
    });
    expect([...found.keys()]).toEqual(["GET /sibling"]);
    const [shape] = found.get("GET /sibling") ?? [];
    expect([...(shape?.required ?? [])].sort()).toEqual([
      "data",
      "next_cursor",
    ]);
    expect([...(shape?.components ?? [])]).toEqual(["Rows"]);
  });

  it("finds a union only when every branch is a page, holding each branch", () => {
    for (const keyword of ["oneOf", "anyOf"] as const) {
      const found = pagesIn({
        paths: {
          "/either": {
            get: answering({
              [keyword]: [page, { $ref: "#/components/schemas/BlobStorePage" }],
            }),
          },
          "/neither": {
            get: answering({
              [keyword]: [
                { properties: { data: {} } },
                { properties: { items: {} } },
              ],
            }),
          },
        },
        components: {
          schemas: {
            BlobStorePage: {
              properties: { data: {}, next_cursor: {}, min_copies: {} },
            },
          },
        },
      });
      expect([...found.keys()], keyword).toEqual(["GET /either"]);
      expect(
        found.get("GET /either")?.map((shape) => [...shape.components]),
        keyword,
      ).toEqual([[], ["BlobStorePage"]]);
    }
  });

  it("throws on a union that is a page on some branches, naming the door", () => {
    for (const keyword of ["oneOf", "anyOf"] as const) {
      expect(() =>
        pagesIn({
          paths: { "/mixed": { get: answering({ [keyword]: [page, {}] }) } },
        }),
      ).toThrow("GET /mixed answers 200 application/json with a union");
    }
  });

  it("throws on a reference that reaches itself, naming it", () => {
    expect(() =>
      pagesIn({
        paths: {
          "/loop": { get: answering({ $ref: "#/components/schemas/Loop" }) },
        },
        components: {
          schemas: {
            Loop: { allOf: [page, { $ref: "#/components/schemas/Loop" }] },
          },
        },
      }),
    ).toThrow("#/components/schemas/Loop refers back to itself");
  });

  it("expands one component named twice side by side", () => {
    // The witness for the cycle guard: a repeat that is not a cycle passes.
    expect(
      doorsOf({
        paths: {
          "/twice": {
            get: answering({
              allOf: [
                { $ref: "#/components/schemas/Page" },
                { $ref: "#/components/schemas/Page" },
              ],
            }),
          },
        },
        components: { schemas: { Page: page } },
      }),
    ).toEqual(["GET /twice"]);
  });
});
