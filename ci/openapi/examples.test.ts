/**
 * Every example in `openapi.json` is an answer, or a value, its own schema
 * accepts, and the times and IDs it shows are written the way Marfa writes
 * them. An example that drifts from its schema teaches the wrong shape to a
 * reader and to a code generator alike.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { document } from "./document.js";

type Json = Record<string, unknown>;

/** A UUIDv7 in lowercase, the form of every ID Marfa creates. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A time in UTC with milliseconds: `2026-10-03T09:30:00.000Z`. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A media type whose example is the raw text of the body, not a value of its
 * schema: a stream's schema describes one frame, and its example shows the
 * stream.
 */
const RAW_TEXT = new Set(["text/event-stream"]);

function resolve(ref: string, root: Json): unknown {
  const target = ref
    .replace(/^#\//, "")
    .split("/")
    .reduce<unknown>(
      (at, segment) =>
        at === null || typeof at !== "object"
          ? undefined
          : (at as Json)[segment.replace(/~1/g, "/").replace(/~0/g, "~")],
      root,
    );
  if (target === undefined) throw new Error(`no ${ref} to resolve`);
  return target;
}

/**
 * The schema with every reference replaced by what it names. A reference with
 * keywords beside it is both at once, so it becomes an `allOf` of the two.
 */
function inline(node: unknown, root: Json): unknown {
  if (Array.isArray(node)) return node.map((child) => inline(child, root));
  if (node === null || typeof node !== "object") return node;
  const { $ref: ref, ...rest } = node as Json;
  if (typeof ref === "string") {
    const target = inline(resolve(ref, root), root);
    return Object.keys(rest).length === 0
      ? target
      : { allOf: [target, inline(rest, root)] };
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(rest)) {
    out[key] = inline(value, root);
  }
  return out;
}

/**
 * Refuse a property the schema does not declare, so an example that names a
 * field the document never described fails. A property bag with no
 * `properties`, a declared record and each branch of an `allOf` stay as they
 * are: the `allOf` itself refuses what no branch declared.
 */
function closed(node: unknown, isAllOfBranch = false): unknown {
  if (Array.isArray(node)) return node.map((child) => closed(child));
  if (node === null || typeof node !== "object") return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    out[key] =
      key === "example" || key === "examples" || key === "default"
        ? value
        : key === "allOf" && Array.isArray(value)
          ? value.map((branch) => closed(branch, true))
          : closed(value);
  }
  if (isAllOfBranch || out.additionalProperties !== undefined) return out;
  if (Array.isArray(out.allOf)) {
    out.unevaluatedProperties ??= false;
  } else if (typeof out.properties === "object") {
    out.additionalProperties = false;
  }
  return out;
}

interface Example {
  where: string;
  value: unknown;
  schema: unknown;
}

/**
 * Every example in the document, with the schema it must satisfy: a media
 * type's `example` and each of its `examples` against its `schema`, a
 * parameter's against its `schema`, and any other `example` against the schema
 * it sits in.
 */
function examples(doc: Json): Example[] {
  const out: Example[] = [];
  const visit = (node: unknown, where: string) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        visit(child, `${where}/${String(index)}`);
      });
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Json;
    if (![...RAW_TEXT].some((type) => where.endsWith(`/${type}`))) {
      const schema = record.schema !== undefined ? record.schema : record;
      if (record.example !== undefined) {
        out.push({ where, value: record.example, schema });
      }
      if (typeof record.examples === "object" && record.examples !== null) {
        if (record.schema !== undefined) {
          for (const [name, entry] of Object.entries(record.examples as Json)) {
            out.push({
              where: `${where}/examples/${name}`,
              value: (entry as Json).value,
              schema: record.schema,
            });
          }
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "example" || key === "examples") continue;
      visit(child, `${where}/${key}`);
    }
  };
  visit(doc.paths, "paths");
  visit(doc.webhooks, "webhooks");
  visit(doc.components, "components");
  return out;
}

/** The examples that a schema of the same document does not accept. */
function mismatches(doc: Json): string[] {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateFormats: false,
  });
  const found: string[] = [];
  for (const { where, value, schema } of examples(doc)) {
    const validate = ajv.compile(
      closed(inline(schema, doc)) as Record<string, unknown>,
    );
    if (!validate(value)) {
      found.push(`${where}: ${ajv.errorsText(validate.errors)}`);
    }
  }
  return found;
}

/** Every `example` set on a field, with the schema of the field. */
function fieldExamples(
  doc: Json,
): { name: string; value: unknown; schema: Json }[] {
  const out: { name: string; value: unknown; schema: Json }[] = [];
  const visit = (node: unknown, where: string) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        visit(child, `${where}/${String(index)}`);
      });
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Json)) {
        if (["example", "examples", "default", "enum", "const"].includes(key)) {
          continue;
        }
        if (key === "properties" && typeof child === "object" && child) {
          for (const [field, schema] of Object.entries(child as Json)) {
            const example = (schema as Json).example;
            if (example !== undefined) {
              out.push({
                name: `${where}.${field}`,
                value: example,
                schema: schema as Json,
              });
            }
            visit(schema, `${where}.${field}`);
          }
        } else {
          visit(child, `${where}/${key}`);
        }
      }
    }
  };
  visit(doc, "");
  return out;
}

describe("the examples in the API description", () => {
  it("holds no example its own schema refuses", () => {
    expect(examples(document).length).toBeGreaterThan(0);
    expect(mismatches(document)).toEqual([]);
  });

  it("refuses an example with a wrong type, a missing field or an unknown one", () => {
    const schemas = {
      Thing: {
        type: "object",
        properties: { id: { type: "string" }, size: { type: "integer" } },
        required: ["id"],
      },
      Big: {
        allOf: [
          { $ref: "#/components/schemas/Thing" },
          { type: "object", properties: { note: { type: "string" } } },
        ],
      },
    };
    const broken = (example: unknown) =>
      mismatches({
        paths: {
          "/things": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Big" },
                      example,
                    },
                  },
                },
              },
            },
          },
        },
        components: { schemas },
      });
    expect(broken({ id: "a", size: 2, note: "b" })).toEqual([]);
    expect(broken({ id: "a", size: "2" })).toHaveLength(1);
    expect(broken({ size: 2 })).toHaveLength(1);
    expect(broken({ id: "a", colour: "red" })).toHaveLength(1);
  });

  it("writes every example for a field ending `_at` as a UTC time with milliseconds", () => {
    // A number is a time in seconds since the Unix epoch, as RFC 7591 defines
    // `client_id_issued_at`, so only a field that holds text is held to the
    // form.
    const times = fieldExamples(document).filter(
      ({ name, schema }) => name.endsWith("_at") && schema.type !== "number",
    );
    expect(times.length).toBeGreaterThan(0);
    expect(
      times
        .filter(({ value }) => !(typeof value === "string" && TIME.test(value)))
        .map(({ name }) => name),
    ).toEqual([]);
  });

  it("writes every example for a field that holds a UUID as a lowercase UUIDv7", () => {
    const holders = new Set(["id", "item_id", "from_id", "to_id"]);
    const ids = fieldExamples(document).filter(({ name }) =>
      holders.has(name.slice(name.lastIndexOf(".") + 1)),
    );
    expect(ids.length).toBeGreaterThan(0);
    // An `id` can name a type (`core.note`) or a sign-in (`local`), so only an
    // example that begins like a UUID is held to the whole form.
    const uuidLike = ids.filter(
      ({ value }) =>
        typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value),
    );
    expect(uuidLike.length).toBeGreaterThan(0);
    expect(
      uuidLike
        .filter(({ value }) => !UUID_V7.test(value as string))
        .map(({ name }) => name),
    ).toEqual([]);
  });
});
