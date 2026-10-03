import { describe, expect, it } from "vitest";
import { parseFilter } from "@withmarfa/shared";
import { filterToRawSql } from "./filter-sql.js";

describe("filterToRawSql", () => {
  describe("clauses and parameters", () => {
    it("generates system field equality", () => {
      const expr = parseFilter('state eq "active"');
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("i.state = ?");
      expect(result.params).toEqual(["active"]);
    });

    it("generates system field neq", () => {
      const expr = parseFilter('state neq "trashed"');
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("i.state != ?");
      expect(result.params).toEqual(["trashed"]);
    });

    it("generates system field gt for occurred_at", () => {
      const expr = parseFilter('occurred_at gt "2026-01-01"');
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("i.occurred_at > ?");
      expect(result.params).toEqual(["2026-01-01T00:00:00.000Z"]);
    });

    it("generates system field contains", () => {
      const expr = parseFilter('source contains "import"');
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("i.source LIKE ? ESCAPE '\\'");
      expect(result.params).toEqual(["%import%"]);
    });

    it("generates system field starts_with", () => {
      const expr = parseFilter('type starts_with "core.media"');
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("i.type LIKE ? ESCAPE '\\'");
      expect(result.params).toEqual(["core.media%"]);
    });

    it("generates a source_id prefix clause against the real column", () => {
      const expr = parseFilter('source_id starts_with "Notes/"');
      const result = filterToRawSql(expr, "i");
      // The column name is interpolated rather than bound, so this asserts
      // the allowlist and the schema agree on the spelling.
      expect(result.clause).toBe("i.source_id LIKE ? ESCAPE '\\'");
      expect(result.params).toEqual(["Notes/%"]);
    });

    it("escapes LIKE metacharacters in a source_id prefix", () => {
      // A path really can contain these; unescaped they would silently
      // widen the folder query into a wildcard.
      const expr = parseFilter('source_id starts_with "100%_real/"');
      const result = filterToRawSql(expr, "i");
      expect(result.params).toEqual(["100\\%\\_real/%"]);
    });

    it("generates property string equality", () => {
      const expr = parseFilter('properties.author eq "Orwell"');
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("json_extract(i.properties, ?) = ?");
      expect(result.params).toEqual(["$.author", "Orwell"]);
    });

    it("generates property numeric gt with CAST", () => {
      const expr = parseFilter("properties.page_count gt 200");
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe(
        "CAST(json_extract(i.properties, ?) AS REAL) > ?",
      );
      expect(result.params).toEqual(["$.page_count", 200]);
    });

    it("generates property exists", () => {
      const expr = parseFilter("properties.subtitle exists");
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("json_extract(i.properties, ?) IS NOT NULL");
      expect(result.params).toEqual(["$.subtitle"]);
    });

    it("generates property not_exists", () => {
      const expr = parseFilter("properties.subtitle not_exists");
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("json_extract(i.properties, ?) IS NULL");
      expect(result.params).toEqual(["$.subtitle"]);
    });

    it("generates property contains (substring)", () => {
      const expr = parseFilter('properties.title contains "adventure"');
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe(
        "json_extract(i.properties, ?) LIKE ? ESCAPE '\\'",
      );
      expect(result.params).toEqual(["$.title", "%adventure%"]);
    });

    it("generates tags contains", () => {
      const expr = parseFilter('tags contains "fiction"');
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toContain("EXISTS");
      expect(result.clause).toContain("json_each(m.tags)");
      expect(result.clause).toContain("je.value = ?");
      expect(result.params).toEqual(["fiction"]);
    });

    it("generates tags exists", () => {
      const expr = parseFilter("tags exists");
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toContain("EXISTS");
      expect(result.params).toEqual([]);
    });

    it("generates tags not_exists", () => {
      const expr = parseFilter("tags not_exists");
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toContain("NOT EXISTS");
      expect(result.params).toEqual([]);
    });

    it("generates AND conditions", () => {
      const expr = parseFilter(
        'state eq "active" AND properties.author eq "Orwell"',
      );
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe(
        "(i.state = ? AND json_extract(i.properties, ?) = ?)",
      );
      expect(result.params).toEqual(["active", "$.author", "Orwell"]);
    });

    it("generates OR conditions", () => {
      const expr = parseFilter(
        'properties.director eq "Kubrick" OR properties.director eq "Spielberg"',
      );
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe(
        "(json_extract(i.properties, ?) = ? OR json_extract(i.properties, ?) = ?)",
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
      const result = filterToRawSql(expr, "i");
      expect(result.clause).toBe("i.state = ?");
      expect(result.clause).not.toContain("(");
    });
  });

  describe("edge subqueries", () => {
    it("binds the edge type and the endpoint, and nothing else", () => {
      const expr = parseFilter('edge[parent-of] eq "item_xyz"');
      const result = filterToRawSql(expr, "i");
      expect(result.params).toEqual(["parent-of", "item_xyz"]);
    });
  });

  describe("special values", () => {
    it("handles boolean true", () => {
      const expr = parseFilter("properties.is_published eq true");
      const result = filterToRawSql(expr, "i");
      expect(result.params).toEqual(["$.is_published", true]);
    });

    it("handles boolean false", () => {
      const expr = parseFilter("properties.is_draft eq false");
      const result = filterToRawSql(expr, "i");
      expect(result.params).toEqual(["$.is_draft", false]);
    });

    it("handles null", () => {
      const expr = parseFilter("properties.subtitle eq null");
      const result = filterToRawSql(expr, "i");
      expect(result.params).toEqual(["$.subtitle", null]);
    });
  });
});
