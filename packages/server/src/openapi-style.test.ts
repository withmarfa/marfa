/**
 * The API description follows `API-STYLE.md`.
 *
 * Two kinds of rule. The ones every operation already meets are asserted
 * outright. The ones the document is still being brought up to are held by a
 * ceiling per rule: a change may lower a count, never raise it, and a count
 * that falls below its ceiling must take the ceiling down with it, so the
 * ratchet only turns one way. A ceiling of zero is an outright rule.
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

function operations(): Operation[] {
  const out: Operation[] = [];
  const paths = (document.paths ?? {}) as Record<string, Json>;
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (METHODS.has(method)) {
        out.push({
          key: `${method.toUpperCase()} ${path}`,
          operation: operation as Json,
        });
      }
    }
  }
  return out;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Every property of every named schema, `allOf` branches included. */
function namedFields(): { name: string; field: Json }[] {
  const out: { name: string; field: Json }[] = [];
  const schemas = ((document.components as Json | undefined)?.schemas ??
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

/** The violations of each rule the document is still being brought up to. */
function violations(): Record<keyof typeof CEILINGS, string[]> {
  const found: Record<keyof typeof CEILINGS, string[]> = {
    summaryForm: [],
    descriptionLength: [],
    parameterUndescribed: [],
    parameterLength: [],
    schemaUndescribed: [],
    fieldUndescribed: [],
    fieldLength: [],
    responseLength: [],
  };
  for (const { key, operation } of operations()) {
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
  const schemas = ((document.components as Json | undefined)?.schemas ??
    {}) as Record<string, Json>;
  for (const [name, schema] of Object.entries(schemas)) {
    if (text(schema.description) === undefined)
      found.schemaUndescribed.push(name);
  }
  for (const { name, field } of namedFields()) {
    const description = text(field.description);
    if (description === undefined) found.fieldUndescribed.push(name);
    else if (description.length > 250) found.fieldLength.push(name);
  }
  return found;
}

/**
 * Lower a ceiling whenever its count falls. Each reaches zero as the areas
 * of the document are rewritten, and a rule at zero stays there.
 */
const CEILINGS = {
  summaryForm: 0,
  descriptionLength: 76,
  parameterUndescribed: 3,
  parameterLength: 26,
  schemaUndescribed: 97,
  fieldUndescribed: 362,
  fieldLength: 10,
  responseLength: 12,
};

describe("the API description follows API-STYLE.md", () => {
  const found = violations();

  for (const [rule, ceiling] of Object.entries(CEILINGS) as [
    keyof typeof CEILINGS,
    number,
  ][]) {
    it(`${rule}: at most ${String(ceiling)}`, () => {
      const count = found[rule].length;
      expect(
        count,
        `${rule} has ${String(count)}, over its ceiling. First: ${found[rule].slice(0, 5).join("; ")}`,
      ).toBeLessThanOrEqual(ceiling);
      expect(
        count,
        `${rule} fell to ${String(count)}. Lower its ceiling in this file to match.`,
      ).toBe(ceiling);
    });
  }

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
    ]);
    const texts = new Map<string, Set<string>>();
    for (const { operation } of operations()) {
      for (const [status, response] of Object.entries(
        (operation.responses ?? {}) as Record<string, Json>,
      )) {
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

  it("uses no em dashes", () => {
    expect(prose().filter((value) => value.includes("\u2014"))).toEqual([]);
  });
});
