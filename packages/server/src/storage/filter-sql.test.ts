import { describe, expect, it } from "vitest";
import { parseFilter } from "@withmarfa/shared";
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
      expect(result.clause).toBe("i.source LIKE ? ESCAPE '\\'");
      expect(result.params).toEqual(["%import%"]);
    });

    it("generates system field starts_with", () => {
      const expr = parseFilter('type starts_with "core.media"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe("i.type LIKE ? ESCAPE '\\'");
      expect(result.params).toEqual(["core.media%"]);
    });

    it("generates a source_id prefix clause against the real column", () => {
      const expr = parseFilter('source_id starts_with "Notes/"');
      const result = filterToRawSql(expr, "sqlite", "i");
      // The column name is interpolated rather than bound, so this asserts
      // the allowlist and the schema agree on the spelling.
      expect(result.clause).toBe("i.source_id LIKE ? ESCAPE '\\'");
      expect(result.params).toEqual(["Notes/%"]);
    });

    it("generates the same source_id prefix clause on pg", () => {
      const expr = parseFilter('source_id starts_with "Notes/"');
      const result = filterToRawSql(expr, "pg", "i");
      expect(result.clause).toBe("i.source_id LIKE $1 ESCAPE '\\'");
      expect(result.params).toEqual(["Notes/%"]);
    });

    it("escapes LIKE metacharacters in a source_id prefix", () => {
      // A path really can contain these; unescaped they would silently
      // widen the folder query into a wildcard.
      const expr = parseFilter('source_id starts_with "100%_real/"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.params).toEqual(["100\\%\\_real/%"]);
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
      expect(result.clause).toBe(
        "json_extract(i.properties, ?) LIKE ? ESCAPE '\\'",
      );
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
      const expr = parseFilter(
        'state eq "active" AND properties.author eq "Orwell"',
      );
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).toBe(
        "(i.state = ? AND json_extract(i.properties, ?) = ?)",
      );
      expect(result.params).toEqual(["active", "$.author", "Orwell"]);
    });

    it("generates OR conditions", () => {
      const expr = parseFilter(
        'properties.director eq "Kubrick" OR properties.director eq "Spielberg"',
      );
      const result = filterToRawSql(expr, "sqlite", "i");
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
      expect(result.clause).toBe("i.properties->>$1 = $2");
      expect(result.params).toEqual(["author", "Orwell"]);
      expect(result.nextParamIdx).toBe(3);
    });

    it("generates property numeric gt with cast", () => {
      const expr = parseFilter("properties.page_count gt 200");
      const result = filterToRawSql(expr, "pg", "i");
      expect(result.clause).toBe("(i.properties->>$1)::numeric > $2");
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
      const expr = parseFilter(
        'state eq "active" AND properties.author eq "Orwell"',
      );
      const result = filterToRawSql(expr, "pg", "i", 3);
      expect(result.clause).toBe("(i.state = $3 AND i.properties->>$4 = $5)");
      expect(result.params).toEqual(["active", "author", "Orwell"]);
      expect(result.nextParamIdx).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // Boolean and null values
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Edge subqueries — space scoping (defense-in-depth)
  // -------------------------------------------------------------------------

  describe("edge subqueries (space scoping)", () => {
    it("outbound eq scopes by space_id when provided (sqlite)", () => {
      const expr = parseFilter('edge[parent-of] eq "item_xyz"');
      const result = filterToRawSql(expr, "sqlite", "i", 1, "space_a");
      expect(result.clause).toContain("e.source_id = i.id");
      expect(result.clause).toContain("e.target_id = ?");
      expect(result.clause).toContain("e.space_id = ?");
      expect(result.params).toEqual(["parent-of", "item_xyz", "space_a"]);
    });

    it("backref eq scopes by space_id when provided (sqlite)", () => {
      const expr = parseFilter('backref[parent-of] eq "item_parent"');
      const result = filterToRawSql(expr, "sqlite", "i", 1, "space_a");
      expect(result.clause).toContain("e.target_id = i.id");
      expect(result.clause).toContain("e.source_id = ?");
      expect(result.clause).toContain("e.space_id = ?");
      expect(result.params).toEqual(["parent-of", "item_parent", "space_a"]);
    });

    it("outbound exists scopes by space_id (pg, positional params)", () => {
      const expr = parseFilter("edge[in-thread] exists");
      const result = filterToRawSql(expr, "pg", "i", 1, "space_a");
      expect(result.clause).toBe(
        "EXISTS (SELECT 1 FROM edges e WHERE e.source_id = i.id AND e.edge_type = $1 AND e.space_id = $2)",
      );
      expect(result.params).toEqual(["in-thread", "space_a"]);
      expect(result.nextParamIdx).toBe(3);
    });

    it("backref not_exists scopes by space_id (pg)", () => {
      const expr = parseFilter("backref[parent-of] not_exists");
      const result = filterToRawSql(expr, "pg", "i", 5, "space_a");
      expect(result.clause).toBe(
        "NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_id = i.id AND e.edge_type = $5 AND e.space_id = $6)",
      );
      expect(result.params).toEqual(["parent-of", "space_a"]);
      expect(result.nextParamIdx).toBe(7);
    });

    it("omits space_id constraint when spaceId is undefined (admin path)", () => {
      const expr = parseFilter('edge[parent-of] eq "item_xyz"');
      const result = filterToRawSql(expr, "sqlite", "i");
      expect(result.clause).not.toContain("e.space_id");
      expect(result.params).toEqual(["parent-of", "item_xyz"]);
    });

    it("preserves param ordering when space clause is added with other filters", () => {
      const expr = parseFilter(
        'state eq "active" AND edge[parent-of] eq "item_xyz"',
      );
      const result = filterToRawSql(expr, "pg", "i", 1, "space_a");
      // state takes $1; edge subquery takes $2 (type), $3 (target), $4 (space)
      expect(result.clause).toBe(
        "(i.state = $1 AND EXISTS (SELECT 1 FROM edges e WHERE e.source_id = i.id AND e.edge_type = $2 AND e.target_id = $3 AND e.space_id = $4))",
      );
      expect(result.params).toEqual([
        "active",
        "parent-of",
        "item_xyz",
        "space_a",
      ]);
    });
  });

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
