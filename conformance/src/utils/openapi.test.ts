import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closed,
  inline,
  pageDoors,
  validatorFor,
  type OpenApiDocument,
} from "./openapi.js";

const committed = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "openapi.json",
    ),
    "utf8",
  ),
) as OpenApiDocument & {
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<
          string,
          { content: Record<string, { schema: unknown }> }
        >;
      }
    >
  >;
};

const doc: OpenApiDocument = {
  paths: {},
  components: {
    schemas: {
      Named: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
};

describe("the closed validator", () => {
  it("refuses a field an object does not declare, and admits one it does", () => {
    const validate = validatorFor({ $ref: "#/components/schemas/Named" }, doc);
    expect(validate({ name: "a" })).toBe(true);
    expect(validate({ name: "a", extra: 1 })).toBe(false);
  });

  it("closes an allOf over the fields every branch declares", () => {
    const validate = validatorFor(
      {
        allOf: [
          { $ref: "#/components/schemas/Named" },
          { type: "object", properties: { note: { type: "string" } } },
        ],
      },
      doc,
    );
    expect(validate({ name: "a", note: "b" })).toBe(true);
    expect(validate({ name: "a", note: "b", extra: 1 })).toBe(false);
  });

  it("leaves a property bag and a declared record open", () => {
    const bag = validatorFor({ type: "object" }, doc);
    expect(bag({ anything: 1 })).toBe(true);
    const record = validatorFor(
      { type: "object", additionalProperties: { type: "number" } },
      doc,
    );
    expect(record({ a: 1, b: 2 })).toBe(true);
    expect(record({ a: "x" })).toBe(false);
  });

  it("closes an object nested inside an allOf branch", () => {
    const shaped = closed({
      allOf: [
        {
          type: "object",
          properties: {
            inner: { type: "object", properties: { x: { type: "number" } } },
          },
        },
      ],
    }) as { allOf: { properties: { inner: Record<string, unknown> } }[] };
    expect(shaped.allOf[0]?.properties.inner.additionalProperties).toBe(false);
  });

  it("closes the one allOf-rooted success in the committed document", () => {
    // The one `allOf`-rooted success. The `allOf` assertion keeps this from
    // passing against a document that stopped composing the response.
    const schema =
      committed.paths["/items/{id}"]?.patch?.responses["200"]?.content[
        "application/json"
      ]?.schema;
    expect(JSON.stringify(schema)).toContain("allOf");
    const validate = validatorFor(schema, committed);
    expect(validate({ undeclared: true })).toBe(false);
    const refused = (validate.errors ?? [])
      .filter((e) => e.keyword === "unevaluatedProperties")
      .map(
        (e) =>
          (e.params as { unevaluatedProperty: string }).unevaluatedProperty,
      );
    expect(refused).toEqual(["undeclared"]);
  });
});

describe("inline", () => {
  it("resolves a reference, including an escaped segment", () => {
    const withSlash: OpenApiDocument = {
      paths: {},
      components: { schemas: { "a/b": { type: "string" } } },
    };
    expect(inline({ $ref: "#/components/schemas/a~1b" }, withSlash)).toEqual({
      type: "string",
    });
  });

  it("throws on a reference that resolves to nothing", () => {
    expect(() => inline({ $ref: "#/components/schemas/Missing" }, doc)).toThrow(
      /no #\/components\/schemas\/Missing/,
    );
  });
});

describe("pageDoors", () => {
  const answering = (schema: unknown, status = "200") => ({
    responses: {
      [status]: { content: { "application/json": { schema } } },
    },
  });
  const object = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
  });
  const page = object({ data: {}, next_cursor: {} });

  it("names an operation whose success declares data and next_cursor, and nothing else", () => {
    expect(
      pageDoors({
        paths: {
          "/page": { get: answering(page) },
          "/data-only": { get: answering(object({ data: {} })) },
          "/refused": { get: answering(page, "400") },
        },
      }),
    ).toEqual(["GET /page"]);
  });

  it("names a page answered by a method other than GET", () => {
    expect(
      pageDoors({
        paths: { "/pages": { post: answering(page, "201") } },
      }),
    ).toEqual(["POST /pages"]);
  });

  it("names a page composed across an allOf, through a reference", () => {
    const composed: OpenApiDocument = {
      paths: {
        "/composed": {
          get: answering({
            allOf: [
              { $ref: "#/components/schemas/Page" },
              object({ min_copies: { type: "integer" } }),
            ],
          }),
        },
        "/half": {
          get: answering({
            allOf: [
              { $ref: "#/components/schemas/Rows" },
              object({ min_copies: { type: "integer" } }),
            ],
          }),
        },
      },
      components: {
        schemas: { Page: page, Rows: object({ data: {} }) },
      },
    };
    expect(pageDoors(composed)).toEqual(["GET /composed"]);
  });

  it("names exactly the twenty-one GET pages of the committed document", () => {
    const pages = pageDoors(committed);
    expect(pages).toHaveLength(21);
    expect(pages.every((door) => door.startsWith("GET "))).toBe(true);
    expect(pages).toContain("GET /items");
    // An extension read answers `data` without a cursor: published, and
    // not a page.
    expect(
      committed.paths["/items/{id}/extensions/{namespace}"]?.get,
    ).toBeDefined();
    expect(pages).not.toContain("GET /items/{id}/extensions/{namespace}");
  });
});
