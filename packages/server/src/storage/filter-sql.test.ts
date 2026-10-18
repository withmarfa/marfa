import { describe, expect, it } from "vitest";
import { alias, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { parseFilter, type FilterExpression } from "@withmarfa/shared";
import { filterToSqlConditions } from "./filter-sql.js";
import { items } from "./sqlite/schema.js";

const dialect = new SQLiteSyncDialect();
const i = alias(items, "i");

/** One rendered statement per condition, as the stores join them. */
function render(expr: FilterExpression): {
  clause: string;
  params: unknown[];
} {
  const rendered = filterToSqlConditions(expr, i).map((condition) =>
    dialect.sqlToQuery(condition),
  );
  const clause = rendered.map(({ sql }) => sql).join(` ${expr.logical} `);
  return {
    clause: rendered.length === 1 ? clause : `(${clause})`,
    params: rendered.flatMap(({ params }) => params),
  };
}

describe("filterToSqlConditions", () => {
  describe("clauses and parameters", () => {
    it("generates system field equality", () => {
      const expr = parseFilter('state eq "active"');
      const result = render(expr);
      expect(result.clause).toBe('"i"."state" = ?');
      expect(result.params).toEqual(["active"]);
    });

    it("generates system field neq", () => {
      const expr = parseFilter('state neq "trashed"');
      const result = render(expr);
      expect(result.clause).toBe('"i"."state" != ?');
      expect(result.params).toEqual(["trashed"]);
    });

    it("generates system field gt for occurred_at", () => {
      const expr = parseFilter('occurred_at gt "2026-01-01"');
      const result = render(expr);
      expect(result.clause).toBe('"i"."occurred_at" > ?');
      expect(result.params).toEqual(["2026-01-01T00:00:00.000Z"]);
    });

    it("generates system field contains", () => {
      const expr = parseFilter('source contains "import"');
      const result = render(expr);
      expect(result.clause).toBe(
        `COALESCE("i"."source", ?) LIKE ? ESCAPE '\\'`,
      );
      expect(result.params).toEqual(["unknown", "%import%"]);
    });

    it("generates system field starts_with", () => {
      const expr = parseFilter('type starts_with "core.media"');
      const result = render(expr);
      expect(result.clause).toBe(`"i"."type" LIKE ? ESCAPE '\\'`);
      expect(result.params).toEqual(["core.media%"]);
    });

    it("generates a source_id prefix clause against the real column", () => {
      const expr = parseFilter('source_id starts_with "Notes/"');
      const result = render(expr);
      // The column name is interpolated rather than bound, so this asserts
      // the allowlist and the schema agree on the spelling.
      expect(result.clause).toBe(`"i"."source_id" LIKE ? ESCAPE '\\'`);
      expect(result.params).toEqual(["Notes/%"]);
    });

    it("escapes LIKE metacharacters in a source_id prefix", () => {
      // A path really can contain these; unescaped they would silently
      // widen the folder query into a wildcard.
      const expr = parseFilter('source_id starts_with "100%_real/"');
      const result = render(expr);
      expect(result.params).toEqual(["100\\%\\_real/%"]);
    });

    it("generates property string equality", () => {
      const expr = parseFilter('properties.author eq "Orwell"');
      const result = render(expr);
      expect(result.clause).toBe('json_extract("i"."properties", ?) = ?');
      expect(result.params).toEqual(["$.author", "Orwell"]);
    });

    it("generates property numeric gt with CAST", () => {
      const expr = parseFilter("properties.page_count gt 200");
      const result = render(expr);
      expect(result.clause).toBe(
        'CAST(json_extract("i"."properties", ?) AS REAL) > ?',
      );
      expect(result.params).toEqual(["$.page_count", 200]);
    });

    it("generates property exists", () => {
      const expr = parseFilter("properties.subtitle exists");
      const result = render(expr);
      expect(result.clause).toBe(
        'json_extract("i"."properties", ?) IS NOT NULL',
      );
      expect(result.params).toEqual(["$.subtitle"]);
    });

    it("generates property not_exists", () => {
      const expr = parseFilter("properties.subtitle not_exists");
      const result = render(expr);
      expect(result.clause).toBe('json_extract("i"."properties", ?) IS NULL');
      expect(result.params).toEqual(["$.subtitle"]);
    });

    it("generates property contains (substring)", () => {
      const expr = parseFilter('properties.title contains "adventure"');
      const result = render(expr);
      expect(result.clause).toBe(
        `json_extract("i"."properties", ?) LIKE ? ESCAPE '\\'`,
      );
      expect(result.params).toEqual(["$.title", "%adventure%"]);
    });

    it("generates tags contains", () => {
      const expr = parseFilter('tags contains "fiction"');
      const result = render(expr);
      expect(result.clause).toContain("EXISTS");
      expect(result.clause).toContain("json_each(m.tags)");
      expect(result.clause).toContain("je.value = ?");
      expect(result.params).toEqual(["fiction"]);
    });

    it("generates tags exists", () => {
      const expr = parseFilter("tags exists");
      const result = render(expr);
      expect(result.clause).toContain("EXISTS");
      expect(result.params).toEqual([]);
    });

    it("generates tags not_exists", () => {
      const expr = parseFilter("tags not_exists");
      const result = render(expr);
      expect(result.clause).toContain("NOT EXISTS");
      expect(result.params).toEqual([]);
    });

    it("generates AND conditions", () => {
      const expr = parseFilter(
        'state eq "active" AND properties.author eq "Orwell"',
      );
      const result = render(expr);
      expect(result.clause).toBe(
        '("i"."state" = ? AND json_extract("i"."properties", ?) = ?)',
      );
      expect(result.params).toEqual(["active", "$.author", "Orwell"]);
    });

    it("generates OR conditions", () => {
      const expr = parseFilter(
        'properties.director eq "Kubrick" OR properties.director eq "Spielberg"',
      );
      const result = render(expr);
      expect(result.clause).toBe(
        '(json_extract("i"."properties", ?) = ? OR json_extract("i"."properties", ?) = ?)',
      );
      expect(result.params).toEqual([
        "$.director",
        "Kubrick",
        "$.director",
        "Spielberg",
      ]);
    });

    it("single condition has no extra parentheses", () => {
      const expr = parseFilter('state eq "active"');
      const result = render(expr);
      expect(result.clause).toBe('"i"."state" = ?');
      expect(result.clause).not.toContain("(");
    });
  });

  describe("edge subqueries", () => {
    it("binds the edge type and the endpoint, and nothing else", () => {
      const expr = parseFilter('edge[parent-of] eq "item_xyz"');
      const result = render(expr);
      expect(result.params).toEqual(["parent-of", "item_xyz"]);
    });
  });

  describe("a ? inside a value", () => {
    /** Placeholders in the statement text, outside quoted literals. */
    const placeholders = (clause: string): number =>
      clause.replace(/'(?:[^']|'')*'/g, "").split("?").length - 1;

    it.each([
      ['properties.title eq "a?b"', ["$.title", "a?b"]],
      ['properties.title contains "?"', ["$.title", "%?%"]],
      ['properties.title starts_with "??"', ["$.title", "??%"]],
      ['tags contains "why?"', ["why?"]],
      ['source eq "src?x=1"', ["unknown", "src?x=1"]],
      ['properties.q eq "say \\"what?\\""', ["$.q", 'say "what?"']],
      ['backref[about] eq "a?b"', ["about", "a?b"]],
      ['edge[about] neq "?"', ["about", "?"]],
    ])(
      "binds %s as a parameter and never as statement text",
      (filter, params) => {
        const result = render(parseFilter(filter));
        expect(result.params).toEqual(params);
        expect(placeholders(result.clause)).toBe(result.params.length);
      },
    );
  });

  describe("special values", () => {
    it("handles boolean true", () => {
      const expr = parseFilter("properties.is_published eq true");
      const result = render(expr);
      expect(result.params).toEqual(["$.is_published", true]);
    });

    it("handles boolean false", () => {
      const expr = parseFilter("properties.is_draft eq false");
      const result = render(expr);
      expect(result.params).toEqual(["$.is_draft", false]);
    });

    it("compiles not_exists to a null test that takes no parameter value", () => {
      const expr = parseFilter("properties.subtitle not_exists");
      const result = render(expr);
      expect(result.clause).toContain("IS NULL");
      expect(result.params).toEqual(["$.subtitle"]);
    });
  });
});
