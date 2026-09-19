import { describe, expect, it } from "vitest";
import { parseFilter } from "./query-parser.js";
import type { FilterExpression } from "./query-parser.js";
import { ErrorCode, MarfaError } from "./errors.js";

describe("parseFilter", () => {
  // ---------------------------------------------------------------------------
  // Valid single conditions
  // ---------------------------------------------------------------------------

  describe("single conditions", () => {
    it("parses system field equality", () => {
      const result = parseFilter('state eq "active"');
      expect(result).toEqual<FilterExpression>({
        conditions: [
          {
            field: { kind: "system", column: "state" },
            op: "eq",
            value: "active",
          },
        ],
        logical: "AND",
      });
    });

    it("parses property field equality", () => {
      const result = parseFilter('properties.author eq "Orwell"');
      expect(result).toEqual<FilterExpression>({
        conditions: [
          {
            field: { kind: "property", path: "author" },
            op: "eq",
            value: "Orwell",
          },
        ],
        logical: "AND",
      });
    });

    it("parses numeric comparison", () => {
      const result = parseFilter("properties.page_count gt 200");
      expect(result).toEqual<FilterExpression>({
        conditions: [
          {
            field: { kind: "property", path: "page_count" },
            op: "gt",
            value: 200,
          },
        ],
        logical: "AND",
      });
    });

    it("parses negative number", () => {
      const result = parseFilter("properties.temperature lt -5");
      expect(result.conditions[0]!.value).toBe(-5);
    });

    it("parses decimal number", () => {
      const result = parseFilter("properties.rating gte 4.5");
      expect(result.conditions[0]!.value).toBe(4.5);
    });

    it("parses boolean value", () => {
      const result = parseFilter("properties.is_published eq true");
      expect(result.conditions[0]!.value).toBe(true);
    });

    it("parses false boolean value", () => {
      const result = parseFilter("properties.is_draft eq false");
      expect(result.conditions[0]!.value).toBe(false);
    });

    it("parses null value", () => {
      const result = parseFilter("properties.subtitle eq null");
      expect(result.conditions[0]!.value).toBeNull();
    });

    it("parses neq operator", () => {
      const result = parseFilter('state neq "trashed"');
      expect(result.conditions[0]!.op).toBe("neq");
    });

    it("parses gte operator", () => {
      const result = parseFilter('created_at gte "2026-01-01"');
      expect(result.conditions[0]!.op).toBe("gte");
    });

    it("parses lte operator", () => {
      const result = parseFilter('occurred_at lte "2026-12-31"');
      expect(result.conditions[0]!.op).toBe("lte");
    });

    it("parses lt operator", () => {
      const result = parseFilter("properties.count lt 10");
      expect(result.conditions[0]!.op).toBe("lt");
    });

    it("parses contains on system field", () => {
      const result = parseFilter('source contains "import"');
      expect(result.conditions[0]!).toEqual({
        field: { kind: "system", column: "source" },
        op: "contains",
        value: "import",
      });
    });

    it("parses contains on property field", () => {
      const result = parseFilter('properties.description contains "adventure"');
      expect(result.conditions[0]!.op).toBe("contains");
    });

    it("parses starts_with on property field", () => {
      const result = parseFilter('properties.title starts_with "The"');
      expect(result.conditions[0]!.op).toBe("starts_with");
    });

    it("parses starts_with on system field", () => {
      const result = parseFilter('type starts_with "core.media"');
      expect(result.conditions[0]!.op).toBe("starts_with");
    });

    it("parses tags contains", () => {
      const result = parseFilter('tags contains "fiction"');
      expect(result).toEqual<FilterExpression>({
        conditions: [
          { field: { kind: "tags" }, op: "contains", value: "fiction" },
        ],
        logical: "AND",
      });
    });

    it("parses property exists (unary)", () => {
      const result = parseFilter("properties.subtitle exists");
      expect(result.conditions[0]!).toEqual({
        field: { kind: "property", path: "subtitle" },
        op: "exists",
        value: null,
      });
    });

    it("parses property not_exists (unary)", () => {
      const result = parseFilter("properties.subtitle not_exists");
      expect(result.conditions[0]!).toEqual({
        field: { kind: "property", path: "subtitle" },
        op: "not_exists",
        value: null,
      });
    });

    it("parses tags exists (unary)", () => {
      const result = parseFilter("tags exists");
      expect(result.conditions[0]!).toEqual({
        field: { kind: "tags" },
        op: "exists",
        value: null,
      });
    });

    it("parses tags not_exists (unary)", () => {
      const result = parseFilter("tags not_exists");
      expect(result.conditions[0]!.op).toBe("not_exists");
    });

    it("handles escaped quotes in strings", () => {
      const result = parseFilter(
        'properties.title eq "The \\"Great\\" Gatsby"',
      );
      expect(result.conditions[0]!.value).toBe('The "Great" Gatsby');
    });

    it("parses all system fields", () => {
      const fields = [
        "state",
        "type",
        "source",
        "occurred_at",
        "created_at",
        "updated_at",
      ];
      for (const field of fields) {
        const result = parseFilter(`${field} eq "test"`);
        expect(result.conditions[0]!.field).toEqual({
          kind: "system",
          column: field,
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple conditions with AND
  // ---------------------------------------------------------------------------

  describe("AND conditions", () => {
    it("parses two AND conditions", () => {
      const result = parseFilter(
        'state eq "active" AND properties.language eq "en"',
      );
      expect(result.conditions).toHaveLength(2);
      expect(result.logical).toBe("AND");
      expect(result.conditions[0]!.field).toEqual({
        kind: "system",
        column: "state",
      });
      expect(result.conditions[1]!.field).toEqual({
        kind: "property",
        path: "language",
      });
    });

    it("parses three AND conditions", () => {
      const result = parseFilter(
        'type eq "core.media.book" AND properties.author eq "Orwell" AND properties.year gt 1940',
      );
      expect(result.conditions).toHaveLength(3);
      expect(result.logical).toBe("AND");
    });

    it("parses AND with mixed field types", () => {
      const result = parseFilter(
        'state eq "active" AND properties.author eq "Orwell" AND tags contains "classic"',
      );
      expect(result.conditions).toHaveLength(3);
      expect(result.conditions[0]!.field.kind).toBe("system");
      expect(result.conditions[1]!.field.kind).toBe("property");
      expect(result.conditions[2]!.field.kind).toBe("tags");
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple conditions with OR
  // ---------------------------------------------------------------------------

  describe("OR conditions", () => {
    it("parses two OR conditions", () => {
      const result = parseFilter(
        'properties.director eq "Kubrick" OR properties.director eq "Spielberg"',
      );
      expect(result.conditions).toHaveLength(2);
      expect(result.logical).toBe("OR");
    });

    it("parses three OR conditions", () => {
      const result = parseFilter(
        'state eq "new" OR state eq "active" OR state eq "archived"',
      );
      expect(result.conditions).toHaveLength(3);
      expect(result.logical).toBe("OR");
    });
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("rejects empty string", () => {
      expect(() => parseFilter("")).toThrow("cannot be empty");
    });

    it("rejects whitespace-only string", () => {
      expect(() => parseFilter("   ")).toThrow("cannot be empty");
    });

    it("rejects mixed AND/OR", () => {
      expect(() =>
        parseFilter(
          'state eq "active" AND type eq "core.note" OR source eq "import"',
        ),
      ).toThrow("Cannot mix AND and OR");
    });

    it("rejects unknown field name", () => {
      expect(() => parseFilter('invalid_field eq "test"')).toThrow(
        "Unknown field",
      );
    });

    it("rejects unknown operator", () => {
      expect(() => parseFilter('state like "test"')).toThrow(
        "Unknown operator",
      );
    });

    it("rejects nested property paths", () => {
      expect(() => parseFilter('properties.author.name eq "test"')).toThrow(
        "Nested property paths are not supported",
      );
    });

    it("rejects invalid property name characters", () => {
      expect(() =>
        parseFilter('properties.author eq "test" AND properties.fo;bar eq "x"'),
      ).toThrow();
    });

    it("rejects missing value after operator", () => {
      expect(() => parseFilter("state eq")).toThrow("expected value");
    });

    it("rejects missing operator after field", () => {
      expect(() => parseFilter("state")).toThrow("expected operator");
    });

    it("rejects trailing AND", () => {
      expect(() => parseFilter('state eq "active" AND')).toThrow(
        "expected another condition",
      );
    });

    it("rejects trailing OR", () => {
      expect(() => parseFilter('state eq "active" OR')).toThrow(
        "expected another condition",
      );
    });

    it("rejects unterminated string", () => {
      expect(() => parseFilter('state eq "unterminated')).toThrow(
        "Unterminated string",
      );
    });

    it("rejects exists on system field", () => {
      expect(() => parseFilter("state exists")).toThrow(
        "not valid for system field",
      );
    });

    it("rejects not_exists on system field", () => {
      expect(() => parseFilter("type not_exists")).toThrow(
        "not valid for system field",
      );
    });

    it("rejects eq on tags", () => {
      expect(() => parseFilter('tags eq "fiction"')).toThrow(
        'not valid for "tags"',
      );
    });

    it("rejects gt on tags", () => {
      expect(() => parseFilter('tags gt "fiction"')).toThrow(
        'not valid for "tags"',
      );
    });

    it("rejects starts_with on tags", () => {
      expect(() => parseFilter('tags starts_with "fic"')).toThrow(
        'not valid for "tags"',
      );
    });

    it("rejects expression exceeding max length", () => {
      const long = `properties.x eq "${"a".repeat(2048)}"`;
      expect(() => parseFilter(long)).toThrow("too long");
    });

    it("rejects more than 10 conditions", () => {
      const conditions = Array.from(
        { length: 11 },
        (_, i) => `properties.f${String(i)} eq "v"`,
      );
      expect(() => parseFilter(conditions.join(" AND "))).toThrow(
        "Too many conditions",
      );
    });

    it("rejects unexpected character", () => {
      expect(() => parseFilter('state eq @"test"')).toThrow(
        "Unexpected character",
      );
    });

    it("rejects missing property name after properties.", () => {
      expect(() => parseFilter('properties. eq "test"')).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // SQL injection prevention
  // ---------------------------------------------------------------------------

  describe("SQL injection prevention", () => {
    it("rejects property name with semicolon", () => {
      expect(() => parseFilter('properties.foo;DROP eq "test"')).toThrow();
    });

    it("rejects property name with parentheses", () => {
      expect(() => parseFilter('properties.foo() eq "test"')).toThrow();
    });

    it("rejects property name with single quote", () => {
      expect(() => parseFilter('properties.foo\' eq "test"')).toThrow();
    });

    it("rejects property name with double dash", () => {
      expect(() => parseFilter('properties.foo-- eq "test"')).toThrow();
    });

    it("safely handles SQL in string values", () => {
      // String values are parameterized, so they should parse fine
      const result = parseFilter(
        'properties.name eq "Robert\'; DROP TABLE items;--"',
      );
      expect(result.conditions[0]!.value).toBe("Robert'; DROP TABLE items;--");
    });

    it("safely handles SQL keywords as string values", () => {
      const result = parseFilter('properties.name eq "SELECT * FROM items"');
      expect(result.conditions[0]!.value).toBe("SELECT * FROM items");
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles extra whitespace", () => {
      const result = parseFilter('  state   eq   "active"  ');
      expect(result.conditions).toHaveLength(1);
      expect(result.conditions[0]!.value).toBe("active");
    });

    it("handles tab characters as whitespace", () => {
      const result = parseFilter('state\teq\t"active"');
      expect(result.conditions).toHaveLength(1);
    });

    it("handles empty string value", () => {
      const result = parseFilter('properties.name eq ""');
      expect(result.conditions[0]!.value).toBe("");
    });

    it("handles zero as numeric value", () => {
      const result = parseFilter("properties.count eq 0");
      expect(result.conditions[0]!.value).toBe(0);
    });

    it("handles property names with underscores", () => {
      const result = parseFilter('properties.my_long_field_name eq "test"');
      expect(result.conditions[0]!.field).toEqual({
        kind: "property",
        path: "my_long_field_name",
      });
    });

    it("handles property names starting with underscore", () => {
      const result = parseFilter('properties._internal eq "test"');
      expect(result.conditions[0]!.field).toEqual({
        kind: "property",
        path: "_internal",
      });
    });

    it("handles property names with numbers", () => {
      const result = parseFilter('properties.field2 eq "test"');
      expect(result.conditions[0]!.field).toEqual({
        kind: "property",
        path: "field2",
      });
    });

    it("handles unary operator followed by AND", () => {
      const result = parseFilter(
        'properties.subtitle exists AND state eq "active"',
      );
      expect(result.conditions).toHaveLength(2);
      expect(result.conditions[0]!.op).toBe("exists");
      expect(result.conditions[1]!.op).toBe("eq");
    });

    it("exactly 10 conditions is allowed", () => {
      const conditions = Array.from(
        { length: 10 },
        (_, i) => `properties.f${String(i)} eq "v"`,
      );
      const result = parseFilter(conditions.join(" AND "));
      expect(result.conditions).toHaveLength(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Adversarial input — defense-in-depth tripwires. None of these are known
  // bugs; the assertions lock in the current parser contract so that a future
  // change weakening the parsers fails loudly. Assertions target the stable
  // MarfaError.code, never message text.
  // ---------------------------------------------------------------------------

  describe("adversarial input", () => {
    function expectValidationError(input: string): void {
      let caught: unknown;
      try {
        parseFilter(input);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MarfaError);
      expect((caught as MarfaError).code).toBe(ErrorCode.VALIDATION_ERROR);
    }

    it("rejects unterminated string literal with VALIDATION_ERROR", () => {
      expectValidationError('properties.foo eq "unterminated');
    });

    it("rejects malformed edge bracket — empty type", () => {
      expectValidationError("edge[]=foo");
    });

    it("rejects malformed edge bracket — missing closing bracket", () => {
      expectValidationError("edge[parent-of=");
    });

    it("rejects malformed backref bracket — missing closing bracket", () => {
      expectValidationError("backref[in-thread");
    });

    it("rejects parenthesized expression (parens are not part of the grammar)", () => {
      expectValidationError('(state eq "active")');
    });

    it("rejects two-level nested parens", () => {
      expectValidationError('((state eq "active"))');
    });

    it("rejects three-level nested parens", () => {
      expectValidationError('(((state eq "active")))');
    });

    it("rejects four-level nested parens", () => {
      expectValidationError('((((state eq "active"))))');
    });
  });

  describe("system fields beyond the original six", () => {
    it('parses tier eq "library" (tier is a system field)', () => {
      const result = parseFilter('tier eq "library"');
      expect(result.conditions[0]?.field).toEqual({
        kind: "system",
        column: "tier",
      });
      expect(result.conditions[0]?.value).toBe("library");
    });

    it("parses combined tier + tags filter", () => {
      const result = parseFilter(
        'tags contains "to-read" AND tier eq "library"',
      );
      expect(result.conditions).toHaveLength(2);
      expect(result.conditions[0]?.field).toEqual({ kind: "tags" });
      expect(result.conditions[1]?.field).toEqual({
        kind: "system",
        column: "tier",
      });
    });

    it("parses device, version, id as system fields", () => {
      expect(parseFilter('device eq "MacBook"').conditions[0]?.field).toEqual({
        kind: "system",
        column: "device",
      });
      expect(parseFilter("version eq 3").conditions[0]?.field).toEqual({
        kind: "system",
        column: "version",
      });
      expect(parseFilter('id eq "abc"').conditions[0]?.field).toEqual({
        kind: "system",
        column: "id",
      });
    });

    it("parses source_id as a system field, so a folder is queryable", () => {
      expect(
        parseFilter('source_id eq "Notes/first.md"').conditions[0]?.field,
      ).toEqual({ kind: "system", column: "source_id" });
    });

    it("parses the prefix form a folder query is expressed as", () => {
      const parsed = parseFilter('source_id starts_with "Notes/"');
      expect(parsed.conditions[0]).toEqual({
        field: { kind: "system", column: "source_id" },
        op: "starts_with",
        value: "Notes/",
      });
    });

    it("keeps source_id distinct from source", () => {
      // Two different columns whose names differ by three characters, one of
      // which is the credential's provenance and the other the path within
      // it. Reading the wrong one returns a plausible, wrong answer.
      expect(parseFilter('source eq "sync"').conditions[0]?.field).toEqual({
        kind: "system",
        column: "source",
      });
      expect(parseFilter('source_id eq "sync"').conditions[0]?.field).toEqual({
        kind: "system",
        column: "source_id",
      });
    });
  });
});
