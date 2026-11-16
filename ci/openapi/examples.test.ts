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

interface Leaf {
  /** The field the value sits in, or empty for a value in a list or at the top. */
  name: string;
  value: unknown;
  where: string;
}

/**
 * Every value an example shows, with the name of the field that holds it: an
 * example set on a field, a parameter, a named schema, a media type (`example`
 * and each of `examples`), and the JSON frames of a stream's raw text. A
 * property that is itself called `example` is a field, not the keyword.
 */
function leaves(doc: Json): Leaf[] {
  const out: Leaf[] = [];
  const value = (node: unknown, where: string, name: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        value(child, `${where}/${String(index)}`, name);
      });
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Json)) {
        value(child, `${where}/${key}`, key);
      }
    } else {
      out.push({ name, value: node, where });
    }
  };
  const stream = (text: string, where: string): void => {
    text.split("\n").forEach((line, index) => {
      if (!line.startsWith("data: ")) return;
      value(
        JSON.parse(line.slice("data: ".length)),
        `${where}/${String(index)}`,
        "",
      );
    });
  };
  const schema = (node: unknown, where: string, field: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        schema(child, `${where}/${String(index)}`, field);
      });
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Json;
    const raw = where.endsWith("/text/event-stream");
    const own =
      typeof record.in === "string" && typeof record.name === "string"
        ? record.name
        : field;
    for (const [key, child] of Object.entries(record)) {
      const at = `${where}/${key}`;
      if (key === "properties" && child !== null && typeof child === "object") {
        for (const [name, property] of Object.entries(child as Json)) {
          schema(property, `${at}/${name}`, name);
        }
      } else if (key === "example") {
        if (raw && typeof child === "string") stream(child, at);
        else value(child, at, own);
      } else if (key === "examples") {
        if (Array.isArray(child)) value(child, at, own);
        else if (child !== null && typeof child === "object") {
          for (const [name, entry] of Object.entries(child as Json)) {
            const shown = (entry as Json).value;
            if (raw && typeof shown === "string")
              stream(shown, `${at}/${name}`);
            else value(shown, `${at}/${name}/value`, "");
          }
        }
      } else if (["default", "enum", "const"].includes(key)) {
        continue;
      } else {
        const carries = ["items", "allOf", "anyOf", "oneOf", "schema"];
        schema(child, at, carries.includes(key) ? own : "");
      }
    }
  };
  schema(doc.paths, "paths", "");
  schema(doc.webhooks, "webhooks", "");
  schema(doc.components, "components", "");
  return out;
}

/** The name of a type or an edge type, which an `id` shows instead of a UUID. */
const TYPE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/**
 * A field called `id` or ending `_id` shows a lowercase UUIDv7 unless it is
 * listed here, each with where it holds something else and why.
 */
const NOT_A_UUID: {
  field: RegExp;
  at?: RegExp;
  value?: RegExp;
  reason: string;
}[] = [
  {
    field: /^id$/,
    at: /^(paths\/\/(types|edge-types|overview)\/|components\/schemas\/(EdgeType|TypeDefinition|Overview)\w*\/)/,
    value: TYPE_NAME,
    reason: "A type or an edge type is named, as in `acme.deal`, not numbered.",
  },
  {
    field: /^(source_id|software_id)$/,
    reason: "A source or an app names its own software, in its own words.",
  },
  {
    field: /^(event_id|min_retained_id)$/,
    value: /^\d+$/,
    reason: "An event's ID is its place in the event log, a number as text.",
  },
  {
    field: /^id$/,
    at: /\/actor\/(anyOf\/\d+\/)?(properties\/)?id(\/example)?$/,
    value: /^(local|server)$/,
    reason:
      "The actor of a local command or of Marfa itself is named, not numbered.",
  },
  {
    field: /^key_id$/,
    value: /^local:process$/,
    reason: "The key of the command line's private socket is `local:process`.",
  },
];

/**
 * How many `id` and `*_id` examples the document shows, the ones that are not
 * a lowercase UUIDv7, and the allowances nothing used.
 */
function idExamples(doc: Json): {
  checked: number;
  offenders: string[];
  unused: string[];
} {
  const used = new Set<number>();
  const offenders: string[] = [];
  let checked = 0;
  for (const { name, value, where } of leaves(doc)) {
    if (!/^(id|.+_id)$/.test(name)) continue;
    checked += 1;
    if (value === null) continue;
    if (typeof value === "string" && UUID_V7.test(value)) continue;
    const allowed = NOT_A_UUID.findIndex(
      (entry) =>
        typeof value === "string" &&
        entry.field.test(name) &&
        (entry.at?.test(where) ?? true) &&
        (entry.value?.test(value) ?? true),
    );
    if (allowed >= 0) used.add(allowed);
    else offenders.push(`${where}: ${JSON.stringify(value)}`);
  }
  return {
    checked,
    offenders,
    unused: NOT_A_UUID.filter((_, index) => !used.has(index)).map(
      ({ reason }) => reason,
    ),
  };
}

/**
 * The times that are not written the way Marfa writes them: UTC text with
 * milliseconds, or `null` for a time that has not happened. Only
 * `client_id_issued_at` is a number, seconds since the Unix epoch as RFC 7591
 * defines it.
 */
function badTimes(doc: Json): { checked: number; offenders: string[] } {
  const times = leaves(doc).filter(({ name }) => name.endsWith("_at"));
  return {
    checked: times.length,
    offenders: times
      .filter(({ name, value }) =>
        name === "client_id_issued_at"
          ? !Number.isInteger(value)
          : value !== null && !(typeof value === "string" && TIME.test(value)),
      )
      .map(({ where, value }) => `${where}: ${JSON.stringify(value)}`),
  };
}

/**
 * The success responses whose example answers a list with nothing in it: an
 * empty `data`, or an empty `tombstones`, `failures` or `skipped`. An empty
 * list shows no entry, so it teaches no shape.
 */
function emptyLists(doc: Json): string[] {
  const found: string[] = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Json>>;
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const responses = (operation.responses ?? {}) as Record<string, Json>;
      for (const [status, response] of Object.entries(responses)) {
        if (!status.startsWith("2")) continue;
        const media = (response.content ?? {}) as Record<string, Json>;
        const body = media["application/json"]?.example as Json | undefined;
        if (body === undefined) continue;
        for (const key of ["data", "tombstones", "failures", "skipped"]) {
          const list = body[key];
          if (Array.isArray(list) && list.length === 0) {
            found.push(`${method.toUpperCase()} ${path} ${status} ${key}`);
          }
        }
      }
    }
  }
  return found;
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

  it("shows an entry in every list a success response answers", () => {
    expect(emptyLists(document)).toEqual([]);

    // The witness: the same walk finds a list left empty.
    const doc = structuredClone(document) as Json;
    const response = (
      (doc.paths as Record<string, Record<string, Json>>)["/occurrences"]?.get
        ?.responses as Record<string, Json>
    )["200"] as { content: Record<string, { example: Json }> };
    const body = response.content["application/json"]!.example;
    body.data = [];
    expect(emptyLists(doc)).toEqual(["GET /occurrences 200 data"]);
  });

  it("writes every example for a field ending `_at` as a UTC time with milliseconds", () => {
    const { checked, offenders } = badTimes(document);
    expect(checked).toBeGreaterThan(100);
    expect(offenders).toEqual([]);

    // The witness: a time in any other form, in a field or a response, and
    // the one number there is, written as text.
    const planted = (example: unknown, name = "created_at") =>
      badTimes({
        components: {
          schemas: { Probe: { properties: { [name]: { example } } } },
        },
        paths: {
          "/probe": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": { example: { [name]: example } },
                  },
                },
              },
            },
          },
        },
      }).offenders;
    expect(planted("2026-10-03T09:30:00.000Z")).toEqual([]);
    expect(planted(null)).toEqual([]);
    expect(planted("2026-10-03T09:30:00Z")).toHaveLength(2);
    expect(planted("2026-10-03")).toHaveLength(2);
    expect(planted(1_790_000_000)).toHaveLength(2);
    expect(planted(1_790_000_000, "client_id_issued_at")).toEqual([]);
    expect(
      planted("2026-10-03T09:30:00.000Z", "client_id_issued_at"),
    ).toHaveLength(2);
    expect(planted(1_790_000_000.5, "client_id_issued_at")).toHaveLength(2);
  });

  it("writes every example for an `id` or `*_id` as a lowercase UUIDv7", () => {
    const { checked, offenders, unused } = idExamples(document);
    expect(checked).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
    expect(unused, "Remove an allowance nothing uses.").toEqual([]);
  });

  it("holds an `id` example in a field, a response, a request and a stream to the form", () => {
    // The witness: the same walk, over examples in each position it reads,
    // finds the opaque ID a passkey would be shown with.
    const opaque = "dGVzdC1wYXNza2V5LWNyZWRlbnRpYWw";
    const at = (doc: Json) => idExamples(doc).offenders;
    const media = (example: unknown) =>
      ({
        paths: {
          "/passkeys": {
            post: {
              requestBody: { content: { "application/json": { example } } },
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      example,
                      examples: { one: { value: example } },
                    },
                    "text/event-stream": {
                      example: `id: 7\ndata: ${JSON.stringify(example)}\n\n`,
                    },
                  },
                },
              },
            },
          },
        },
        webhooks: {
          sent: {
            post: {
              requestBody: { content: { "application/json": { example } } },
            },
          },
        },
      }) as Json;
    const good = "0199a9c4-7c1e-7d3a-9f2b-3c4d5e6f7a8b";
    expect(at(media({ data: [{ id: good, item_id: good }] }))).toEqual([]);
    // Every position the example can sit in reports its own place.
    expect(at(media({ data: [{ id: opaque }] }))).toHaveLength(5);
    expect(at(media({ credential_id: opaque }))).toHaveLength(5);
    expect(at(media({ id: good.toUpperCase() }))).toHaveLength(5);
    expect(at(media({ id: good.replace("-7d3a", "-4d3a") }))).toHaveLength(5);
    expect(at(media({ id: 7 }))).toHaveLength(5);

    const field = (example: unknown, name = "id") =>
      at({
        components: {
          schemas: {
            Passkey: { properties: { [name]: { type: "string", example } } },
          },
        },
      });
    expect(field(good)).toEqual([]);
    expect(field(opaque)).toHaveLength(1);
    expect(field(opaque, "device_id")).toHaveLength(1);
    expect(
      at({
        paths: {
          "/passkeys/{id}": {
            get: {
              parameters: [
                { name: "id", in: "path", schema: {}, example: opaque },
              ],
            },
          },
        },
      }),
    ).toHaveLength(1);
    // A field literally named `example` holds no ID, and a name that only
    // contains `id` is not one.
    expect(
      at({
        components: {
          schemas: {
            Probe: {
              properties: {
                example: { type: "string", example: "x" },
                valid: { type: "string", example: "yes" },
                grid: { type: "string", example: "a1" },
              },
            },
          },
        },
      }),
    ).toEqual([]);
    // An allowance holds only where it names, and only for a name.
    expect(
      at({
        paths: {
          "/types": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": { example: { id: "acme.deal" } },
                  },
                },
              },
            },
          },
          "/owner/passkeys": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": { example: { id: "acme.deal" } },
                  },
                },
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
  });
});
