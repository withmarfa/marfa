/**
 * The API description follows `API-STYLE.md`.
 *
 * Every rule the guide marks **(checked)** is asserted here outright, against
 * the committed `openapi.json`. A failure lists each operation, parameter,
 * response, schema or field that breaks the rule, by name.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const COMMITTED = new URL("../../../openapi.json", import.meta.url);

type Json = Record<string, unknown>;

const document = JSON.parse(readFileSync(COMMITTED, "utf8")) as Json;

const METHODS = new Set(["get", "put", "post", "patch", "delete"]);

interface Operation {
  key: string;
  operation: Json;
}

/**
 * Every operation, and every request Marfa sends to a webhook, which
 * `API-STYLE.md` holds to the same rules.
 */
function operations(doc: Json = document): Operation[] {
  const out: Operation[] = [];
  const sources: [string, unknown][] = [
    ["", doc.paths],
    ["webhook ", doc.webhooks],
  ];
  for (const [prefix, entries] of sources) {
    for (const [name, methods] of Object.entries(
      (entries ?? {}) as Record<string, Json>,
    )) {
      for (const [method, operation] of Object.entries(methods)) {
        if (METHODS.has(method)) {
          out.push({
            key: `${prefix}${method.toUpperCase()} ${name}`,
            operation: operation as Json,
          });
        }
      }
    }
  }
  return out;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Every property of every named schema, `allOf` branches included. */
function namedFields(doc: Json): { name: string; field: Json }[] {
  const out: { name: string; field: Json }[] = [];
  const schemas = ((doc.components as Json | undefined)?.schemas ??
    {}) as Record<string, Json>;
  const visit = (owner: string, schema: Json) => {
    for (const [field, value] of Object.entries(
      (schema.properties ?? {}) as Record<string, Json>,
    )) {
      out.push({ name: `${owner}.${field}`, field: value });
    }
    for (const branch of (schema.allOf ?? []) as Json[]) visit(owner, branch);
  };
  for (const [name, schema] of Object.entries(schemas)) visit(name, schema);
  return out;
}

/**
 * A field's description. A field that refers to a named schema carries its
 * own text in an `allOf` branch beside the reference.
 */
function fieldDescription(field: Json): string | undefined {
  if (text(field.description) !== undefined) return text(field.description);
  for (const branch of (field.allOf ?? []) as Json[]) {
    if (branch.$ref === undefined && text(branch.description) !== undefined) {
      return text(branch.description);
    }
  }
  return undefined;
}

/**
 * The rules checked against every operation, parameter, response, schema and
 * field, each with the sentence a failure reports. The limits are the ones
 * `API-STYLE.md` sets.
 */
const RULES = {
  summaryForm:
    "every summary starts with a capital letter, is at most 32 characters and has no final period",
  descriptionLength: "every operation description is at most 250 characters",
  parameterUndescribed: "every parameter has a description",
  parameterLength: "every parameter description is at most 250 characters",
  responseLength: "every response description is at most 400 characters",
  schemaUndescribed: "every named schema has a description",
  fieldUndescribed: "every field of a named schema has a description",
  fieldLength: "every field description is at most 250 characters",
} as const;

/** What breaks each rule, named so a failure says where to look. */
function violations(doc: Json): Record<keyof typeof RULES, string[]> {
  const found: Record<keyof typeof RULES, string[]> = {
    summaryForm: [],
    descriptionLength: [],
    parameterUndescribed: [],
    parameterLength: [],
    responseLength: [],
    schemaUndescribed: [],
    fieldUndescribed: [],
    fieldLength: [],
  };
  for (const { key, operation } of operations(doc)) {
    const summary = text(operation.summary) ?? "";
    if (
      summary.length > 32 ||
      summary.endsWith(".") ||
      !/^[A-Z]/.test(summary)
    ) {
      found.summaryForm.push(key);
    }
    if ((text(operation.description) ?? "").length > 250) {
      found.descriptionLength.push(key);
    }
    for (const parameter of (operation.parameters ?? []) as Json[]) {
      const description = text(parameter.description);
      if (description === undefined) {
        found.parameterUndescribed.push(`${key} ${String(parameter.name)}`);
      } else if (description.length > 250) {
        found.parameterLength.push(`${key} ${String(parameter.name)}`);
      }
    }
    for (const [status, response] of Object.entries(
      (operation.responses ?? {}) as Record<string, Json>,
    )) {
      if ((text(response.description) ?? "").length > 400) {
        found.responseLength.push(`${key} ${status}`);
      }
    }
  }
  const schemas = ((doc.components as Json | undefined)?.schemas ??
    {}) as Record<string, Json>;
  for (const [name, schema] of Object.entries(schemas)) {
    if (text(schema.description) === undefined)
      found.schemaUndescribed.push(name);
  }
  for (const { name, field } of namedFields(doc)) {
    const description = fieldDescription(field);
    if (description === undefined) found.fieldUndescribed.push(name);
    else if (description.length > 250) found.fieldLength.push(name);
  }
  return found;
}

describe("the API description follows API-STYLE.md", () => {
  const found = violations(document);

  for (const [rule, says] of Object.entries(RULES) as [
    keyof typeof RULES,
    string,
  ][]) {
    it(says, () => {
      expect(found[rule], `These break the rule that ${says}`).toEqual([]);
    });
  }

  it("names what breaks each rule in a document that breaks them all", () => {
    const long = "x".repeat(251);
    const broken = {
      paths: {
        "/things": {
          get: {
            summary: "list things.",
            description: long,
            parameters: [{ name: "q" }, { name: "limit", description: long }],
            responses: { "200": { description: "x".repeat(401) } },
          },
        },
      },
      components: {
        schemas: {
          Thing: {
            properties: {
              id: {},
              note: { description: long },
              owner: { allOf: [{ $ref: "#/components/schemas/Owner" }] },
            },
          },
          Owner: {
            description: "Who owns a thing.",
            properties: {
              id: {
                allOf: [
                  { $ref: "#/components/schemas/Id" },
                  { description: "The ID of the owner." },
                ],
              },
            },
          },
        },
      },
    };
    expect(violations(broken)).toEqual({
      summaryForm: ["GET /things"],
      descriptionLength: ["GET /things"],
      parameterUndescribed: ["GET /things q"],
      parameterLength: ["GET /things limit"],
      responseLength: ["GET /things 200"],
      schemaUndescribed: ["Thing"],
      fieldUndescribed: ["Thing.id", "Thing.owner"],
      fieldLength: ["Thing.note"],
    });
  });

  it("holds the requests Marfa sends to a webhook to the same rules", () => {
    expect(
      operations().filter(({ key }) => key.startsWith("webhook ")),
    ).not.toEqual([]);
  });

  it("gives each shared parameter one text everywhere", () => {
    // On the stream the read view resumes a copy rather than certifying one
    // read, so it carries its own text, as API-STYLE.md allows.
    const ownMeaning = new Set(["GET /events X-Marfa-Read-View"]);
    const texts = new Map<string, Set<string>>();
    for (const { key, operation } of operations()) {
      for (const parameter of (operation.parameters ?? []) as Json[]) {
        const name = String(parameter.name);
        if (
          !["limit", "cursor", "Idempotency-Key", "X-Marfa-Read-View"].includes(
            name,
          )
        )
          continue;
        if (ownMeaning.has(`${key} ${name}`)) continue;
        const set = texts.get(name) ?? new Set<string>();
        set.add(String(parameter.description));
        texts.set(name, set);
      }
    }
    for (const [name, set] of texts) {
      expect([...set], `${name} has more than one description`).toHaveLength(1);
    }
  });

  it("gives each shared refusal one text everywhere", () => {
    // Keyed by the status and the refusal component a response points at, so
    // a door declaring the shared refusal in its own words is caught too.
    const shared = new Map([
      ["401", "UnauthorizedRefusal"],
      ["413", "RequestTooLargeRefusal"],
      ["429", "RateLimitedRefusal"],
      ["503", "WriteContentionRefusal"],
      ["500", "InternalErrorRefusal"],
    ]);
    // A restore takes no body cap, so its 413 is a row larger than a write
    // takes, and it carries its own text, as API-STYLE.md allows.
    const ownMeaning = new Set(["POST /restore 413"]);
    const texts = new Map<string, Set<string>>();
    for (const { key, operation } of operations()) {
      for (const [status, response] of Object.entries(
        (operation.responses ?? {}) as Record<string, Json>,
      )) {
        if (ownMeaning.has(`${key} ${status}`)) continue;
        const component = shared.get(status);
        const content = (response.content ?? {}) as Record<string, Json>;
        const schema = (content["application/json"]?.schema ?? {}) as Json;
        if (schema.$ref !== `#/components/schemas/${String(component)}`) {
          continue;
        }
        const set = texts.get(status) ?? new Set<string>();
        set.add(String(response.description));
        texts.set(status, set);
      }
    }
    for (const status of shared.keys()) {
      expect(
        [...(texts.get(status) ?? [])],
        `${status} has more than one description`,
      ).toHaveLength(1);
    }
  });

  /** Every summary and description in the document, general sections included. */
  function prose(): string[] {
    const out: string[] = [];
    const visit = (value: unknown, key?: string) => {
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry);
      } else if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) visit(v, k);
      } else if (
        typeof value === "string" &&
        (key === "description" || key === "summary")
      ) {
        out.push(value);
      }
    };
    visit(document);
    return out;
  }

  it("uses none of the glossary's banned words", () => {
    const banned =
      /\b(integrations?|substrates?|hosted mode|cancell(ed|ing))\b/i;
    expect(prose().length).toBeGreaterThan(0);
    expect(prose().filter((value) => banned.test(value))).toEqual([]);
  });

  it("uses no em dashes anywhere", () => {
    expect(JSON.stringify(document).includes("\u2014")).toBe(false);
  });

  it("leaves refusals to the responses", () => {
    const refusal =
      /\brefus|`[45]\d\d\b|\b[45]\d\d `?[a-z]+_[a-z_]+|\b(answers?|returns?) `?[45]\d\d\b/i;
    expect(
      operations()
        .filter(({ operation }) =>
          refusal.test(text(operation.description) ?? ""),
        )
        .map(({ key }) => key),
    ).toEqual([]);
  });

  it("links nowhere outside the document", () => {
    const outbound = /https?:\/\//;
    expect(prose().filter((value) => outbound.test(value))).toEqual([]);
  });
});
