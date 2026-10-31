import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MarfaError,
  parseFilter,
  type FilterCondition,
  type FilterExpression,
} from "@withmarfa/shared";
import { filterToSqlConditions } from "./filter-sql.js";
import { items } from "./sqlite/schema.js";

type ModelField =
  | { kind: "system"; name: string }
  | { kind: "property"; name: string }
  | { kind: "member"; field: string; member: string }
  | { kind: "tags" }
  | { kind: "status_group" }
  | { kind: "edge"; edge_type: string; direction: "outbound" | "backref" };

interface Model {
  join: "all" | "any";
  conditions: {
    field: ModelField;
    operator: FilterCondition["op"];
    value?: string | number | boolean;
  }[];
}

interface Shared {
  canonical: { description: string; text: string; expression: Model }[];
  variants: { description: string; text: string; canonical: string }[];
  refused: {
    description: string;
    text: string;
    code: string;
    message: string;
    at?: "listing";
  }[];
}

// The cases the core's filter model encodes and decodes in
// `core/marfa-core/src/filter/model_tests.rs`, so the two cannot drift.
const SHARED = JSON.parse(
  readFileSync(
    new URL(
      "../../../../conformance/fixtures/filter-expressions.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Shared;

function field(model: ModelField): FilterCondition["field"] {
  switch (model.kind) {
    case "system":
      return { kind: "system", column: model.name };
    case "property":
      return { kind: "property", path: model.name };
    case "member":
      return { kind: "entry", path: model.field, member: model.member };
    case "edge":
      return {
        kind: "edge",
        edge_type: model.edge_type,
        direction: model.direction,
      };
    default:
      return model;
  }
}

/** The parser's reading of a text the core's model encodes to. */
function expected(model: Model): FilterExpression {
  return {
    logical: model.join === "any" ? "OR" : "AND",
    conditions: model.conditions.map((condition) => ({
      field: field(condition.field),
      op: condition.operator,
      value: condition.value ?? null,
    })),
  };
}

/** Parsed and built into SQL, as a listing reads a filter. */
function listed(text: string): FilterExpression {
  const expression = parseFilter(text);
  filterToSqlConditions(expression, items);
  return expression;
}

describe("the filter expressions the core's model is held to", () => {
  it.each(SHARED.canonical)(
    "reads $description as the core's model holds it",
    ({ text, expression }) => {
      expect(listed(text)).toEqual(expected(expression));
    },
  );

  it.each(SHARED.variants)(
    "reads $description as its canonical form",
    ({ text, canonical }) => {
      expect(listed(text)).toEqual(listed(canonical));
    },
  );

  it.each(SHARED.refused)(
    "refuses $description with the message the core gives",
    ({ text, code, message, at }) => {
      // Witness for a refusal the SQL builder makes: the parser takes it.
      if (at === "listing") expect(() => parseFilter(text)).not.toThrow();
      let thrown: unknown;
      try {
        listed(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MarfaError);
      expect(thrown).toMatchObject({ code, message });
    },
  );

  it("takes a filter of 2,048 UTF-16 code units and refuses one of 2,049", () => {
    const filter = (emoji: number, extra: string): string =>
      `properties.a eq "${"\u{1F389}".repeat(emoji)}${extra}"`;
    expect(filter(1015, "")).toHaveLength(2048);
    expect(() => listed(filter(1015, ""))).not.toThrow();
    expect(() => listed(filter(1015, "x"))).toThrow(
      "Filter expression too long (2049 characters). Maximum is 2048",
    );
  });
});
