import { describe, expect, it } from "vitest";
import { parseFilter } from "@myme/shared";
import { filterToRawSql } from "./filter-sql.js";

describe("filterToRawSql", () => {
  // -------------------------------------------------------------------------
  // SQLite dialect
  // -------------------------------------------------------------------------

  describe("sqlite", () => {
    it("generates system field equality", () => {
      const expr = parseFilter('state eq "active"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("i.state = ?");
      expect(result.params).toEqual(["active"]);
    });

    it("generates system field neq", () => {
      const expr = parseFilter('state neq "trashed"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("i.state != ?");
      expect(result.params).toEqual(["trashed"]);
    });

    it("generates system field gt for timestamp", () => {
      const expr = parseFilter('timestamp gt "2026-01-01"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("i.timestamp > ?");
      expect(result.params).toEqual(["2026-01-01"]);
    });

    it("generates system field contains", () => {
      const expr = parseFilter('source contains "import"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("i.source LIKE ?");
      expect(result.params).toEqual(["%import%"]);
    });

    it("generates system field starts_with", () => {
      const expr = parseFilter('type starts_with "core.work"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("i.type LIKE ?");
      expect(result.params).toEqual(["core.work%"]);
    });

    it("generates property string equality", () => {
      const expr = parseFilter('properties.author eq "Orwell"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("json_extract(i.properties, ?) = ?");
      expect(result.params).toEqual(["$.author", "Orwell"]);
    });

    it("generates property numeric gt with CAST", () => {
      const expr = parseFilter("properties.page_count gt 200");
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe(
        "CAST(json_extract(i.properties, ?) AS REAL) > ?",
      );
      expect(result.params).toEqual(["$.page_count", 200]);
    });

    it("generates property exists", () => {
      const expr = parseFilter("properties.subtitle exists");
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("json_extract(i.properties, ?) IS NOT NULL");
      expect(result.params).toEqual(["$.subtitle"]);
    });

    it("generates property not_exists", () => {
      const expr = parseFilter("properties.subtitle not_exists");
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("json_extract(i.properties, ?) IS NULL");
      expect(result.params).toEqual(["$.subtitle"]);
    });

    it("generates property contains (substring)", () => {
      const expr = parseFilter('properties.title contains "adventure"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("json_extract(i.properties, ?) LIKE ?");
      expect(result.params).toEqual(["$.title", "%adventure%"]);
    });

    it("generates tags contains", () => {
      const expr = parseFilter('tags contains "fiction"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toContain("EXISTS");
      expect(result.clause).toContain("json_each(m.tags)");
      expect(result.clause).toContain("je.value = ?");
      expect(result.params).toEqual(["fiction"]);
    });

    it("generates tags exists", () => {
      const expr = parseFilter("tags exists");
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toContain("EXISTS");
      expect(result.params).toEqual([]);
    });

    it("generates tags not_exists", () => {
      const expr = parseFilter("tags not_exists");
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toContain("NOT EXISTS");
      expect(result.params).toEqual([]);
    });

    it("generates AND conditions", () => {
      const expr = parseFilter('state eq "active" AND properties.author eq "Orwell"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe(
        "(i.state = ? AND json_extract(i.properties, ?) = ?)",
      );
      expect(result.params).toEqual(["active", "$.author", "Orwell"]);
    });

    it("generates OR conditions", () => {
      const expr = parseFilter('properties.director eq "Kubrick" OR properties.director eq "Spielberg"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe(
        "(json_extract(i.properties, ?) = ? OR json_extract(i.properties, ?) = ?)",
      );
      expect(result.params).toEqual(["$.director", "Kubrick", "$.director", "Spielberg"]);
    });

    it("single condition has no extra parentheses", () => {
      const expr = parseFilter('state eq "active"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("i.state = ?");
      expect(result.clause).not.toContain("(");
    });
  });

  // -------------------------------------------------------------------------
  // Postgres dialect
  // -------------------------------------------------------------------------

  describe("pg", () => {
    it("generates system field equality with positional params", () => {
      const expr = parseFilter('state eq "active"');
      const result = filterToRawSql(expr, "pg", "i");
      expect(result.clause).toBe("i.state = $1");
      expect(result.params).toEqual(["active"]);
      expect(result.nextParamIdx).toBe(2);
    });

    it("uses custom startParamIdx", () => {
      const expr = parseFilter('state eq "active"');
      const result = filterToRawSql(expr, "pg", "i", 5);
      expect(result.clause).toBe("i.state = $5");
      expect(result.params).toEqual(["active"]);
      expect(result.nextParamIdx).toBe(6);
    });

    it("generates property equality with json accessor", () => {
      const expr = parseFilter('properties.author eq "Orwell"');
      const result = filterToRawSql(expr, "pg", "i");
      expect(result.clause).toBe("i.properties::json->>$1 = $2");
      expect(result.params).toEqual(["author", "Orwell"]);
      expect(result.nextParamIdx).toBe(3);
    });

    it("generates property numeric gt with cast", () => {
      const expr = parseFilter("properties.page_count gt 200");
      const result = filterToRawSql(expr, "pg", "i");
      expect(result.clause).toBe(
        "(i.properties::json->>$1)::numeric > $2",
      );
      expect(result.params).toEqual(["page_count", 200]);
    });

    it("generates tags contains with jsonb", () => {
      const expr = parseFilter('tags contains "fiction"');
      const result = filterToRawSql(expr, "pg", "i");
      expect(result.clause).toContain("@>");
      expect(result.clause).toContain("::jsonb");
      expect(result.params).toEqual(['["fiction"]']);
    });

    it("tracks parameter indices across multiple conditions", () => {
      const expr = parseFilter('state eq "active" AND properties.author eq "Orwell"');
      const result = filterToRawSql(expr, "pg", "i", 3);
      expect(result.clause).toBe(
        "(i.state = $3 AND i.properties::json->>$4 = $5)",
      );
      expect(result.params).toEqual(["active", "author", "Orwell"]);
      expect(result.nextParamIdx).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // Boolean and null values
  // -------------------------------------------------------------------------

  describe("special values", () => {
    it("handles boolean true", () => {
      const expr = parseFilter("properties.is_published eq true");
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.params).toEqual(["$.is_published", true]);
    });

    it("handles boolean false", () => {
      const expr = parseFilter("properties.is_draft eq false");
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.params).toEqual(["$.is_draft", false]);
    });

    it("handles null", () => {
      const expr = parseFilter("properties.subtitle eq null");
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.params).toEqual(["$.subtitle", null]);
    });
  });
});
