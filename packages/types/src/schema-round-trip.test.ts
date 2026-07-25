import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TypeSchema } from "./schema-types.js";
import { validateTypeSchema } from "./schema-validation.js";
import {
  ALL_TYPES,
  ALL_CONNECTOR_TYPES,
  ALL_SYSTEM_TYPES,
} from "../generated/type-registry.js";

// -----------------------------------------------------------------------------
// The guarantee: an in-tree JSON schema is a valid runtime submission, verbatim.
//
// There are two ways to author a type — commit a JSON file here, or POST it to
// a running server — and they used to be judged by different code. The in-tree
// files were the natural thing to copy when learning the format, and copying
// one produced a schema the runtime silently reshaped or outright rejected.
//
// These tests pin the two paths together. `validateTypeSchema` below is the
// same function `POST /types` calls.
// -----------------------------------------------------------------------------

const typesRoot = resolve(import.meta.dirname, "..");

const FAMILIES = [
  { name: "core", dir: join(typesRoot, "core") },
  { name: "connector", dir: join(typesRoot, "connectors") },
  { name: "system", dir: join(typesRoot, "core", "system") },
] as const;

interface Loaded {
  family: string;
  file: string;
  data: Record<string, unknown>;
}

function load(): Loaded[] {
  const out: Loaded[] = [];
  for (const family of FAMILIES) {
    for (const file of readdirSync(family.dir)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const data = JSON.parse(
        readFileSync(join(family.dir, file), "utf-8"),
      ) as Record<string, unknown>;
      if (data._deferred === true) continue;
      out.push({ family: family.name, file, data });
    }
  }
  return out;
}

const inTree = load();

// The emitted registry is the resolved view of the same schemas, and it is what
// the inheritance and compatible_with checks resolve against.
const emitted = new Map<string, TypeSchema>(
  [...ALL_TYPES, ...ALL_CONNECTOR_TYPES, ...ALL_SYSTEM_TYPES].map((s) => [
    s.id,
    s,
  ]),
);

const validate = (data: unknown) =>
  validateTypeSchema(data, { resolveSchema: (id) => emitted.get(id) });

describe("in-tree schemas pass the runtime validator verbatim", () => {
  it("finds every shipped schema on disk", () => {
    expect(inTree.length).toBe(emitted.size);
  });

  for (const { family, file, data } of inTree) {
    it(`${family}/${file}`, () => {
      const result = validate(data);
      if (!result.success) {
        throw new Error(
          `${family}/${file} would be rejected by POST /types:\n` +
            result.errors.map((e) => `  ${e.field}: ${e.message}`).join("\n"),
        );
      }
    });
  }
});

describe("in-tree schemas normalize to what the registry ships", () => {
  for (const { family, file, data } of inTree) {
    it(`${family}/${file}`, () => {
      const result = validate(data);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const shipped = emitted.get(result.data.id);
      expect(shipped, `${result.data.id} is not in the registry`).toBeDefined();
      if (!shipped) return;

      // Every attribute the author declared survives into the registry with
      // the same value. Codegen used to drop searchable / maxLength /
      // maxItems / format on the floor, so a JSON file could say one thing and
      // the shipped registry another.
      for (const [name, declared] of Object.entries(result.data.fields)) {
        const inRegistry = shipped.fields[name];
        expect(inRegistry, `${result.data.id}.${name} missing`).toBeDefined();
        if (!inRegistry) continue;
        expect(inRegistry.type).toBe(declared.type);
        expect(inRegistry.format).toBe(declared.format);
        expect(inRegistry.searchable).toBe(declared.searchable);
        expect(inRegistry.maxLength).toBe(declared.maxLength);
        expect(inRegistry.maxItems).toBe(declared.maxItems);
        expect(inRegistry.items_type).toBe(declared.items_type);
        expect(inRegistry.enum_values).toEqual(declared.enum_values);
        // Required-ness may only be gained on the way down the chain.
        if (declared.required) expect(inRegistry.required).toBe(true);
      }

      expect(shipped.compatible_with).toEqual(result.data.compatible_with);
      expect(shipped.version).toBe(result.data.version);
      expect(shipped.parent).toBe(result.data.parent);
    });
  }
});

describe("compatible_with", () => {
  it("is carried into the registry, not dropped by codegen", () => {
    const raindrop = emitted.get("raindrop.raindrop");
    expect(raindrop?.compatible_with).toEqual(["core.bookmark"]);
  });

  it("accepts the array form", () => {
    const result = validate({
      id: "acme.deal_note",
      version: 1,
      compatible_with: ["core.note"],
      fields: { body: { type: "string" }, amount: { type: "number" } },
      required: ["body"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.compatible_with).toEqual(["core.note"]);
    }
  });

  it("normalizes the single-target string shorthand to an array", () => {
    const result = validate({
      id: "acme.deal_note",
      version: 1,
      compatible_with: "core.note",
      fields: { body: { type: "string", required: true } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.compatible_with).toEqual(["core.note"]);
    }
  });

  it("accepts several targets at once", () => {
    const result = validate({
      id: "acme.everything",
      version: 1,
      compatible_with: ["core.note", "core.bookmark"],
      fields: {
        body: { type: "string", required: true },
        url: { type: "url", required: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a claim whose target requires a field this type lacks", () => {
    const result = validate({
      id: "acme.bodyless",
      version: 1,
      compatible_with: ["core.note"],
      fields: { headline: { type: "string" } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const violation = result.errors.find(
      (e) => e.code === "compatible_with_violation",
    );
    expect(violation).toBeDefined();
    expect(violation?.field).toBe("compatible_with.core.note.body");
  });

  it("rejects a claim whose target field has a different type", () => {
    const result = validate({
      id: "acme.numeric_body",
      version: 1,
      compatible_with: ["core.note"],
      fields: { body: { type: "number", required: true } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some((e) => e.code === "compatible_with_violation"),
    ).toBe(true);
  });

  it("rejects a claim against an unregistered target", () => {
    const result = validate({
      id: "acme.orphan_claim",
      version: 1,
      compatible_with: ["nope.nothing"],
      fields: { body: { type: "string" } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some((e) => e.code === "compatible_with_violation"),
    ).toBe(true);
  });
});

describe("field attributes survive normalization", () => {
  it("carries searchable, maxLength, maxItems and annotation formats", () => {
    const result = validate({
      id: "acme.kitchen_sink",
      version: 1,
      fields: {
        secret: { type: "string", searchable: false },
        blurb: { type: "string", maxLength: 280 },
        tags: { type: "array", items_type: "string", maxItems: 20 },
        language: { type: "string", format: "bcp47" },
        country: { type: "string", format: "iso3166" },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.fields.secret?.searchable).toBe(false);
    expect(result.data.fields.blurb?.maxLength).toBe(280);
    expect(result.data.fields.tags?.maxItems).toBe(20);
    expect(result.data.fields.language?.format).toBe("bcp47");
    expect(result.data.fields.country?.format).toBe("iso3166");
  });

  it("collapses a format that has a first-class field type", () => {
    const result = validate({
      id: "acme.linky",
      version: 1,
      fields: {
        href: { type: "string", format: "url" },
        seen_at: { type: "string", format: "datetime" },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.fields.href?.type).toBe("url");
    expect(result.data.fields.href?.format).toBeUndefined();
    expect(result.data.fields.seen_at?.type).toBe("datetime");
  });

  it("reads required-ness from either the top-level array or the field", () => {
    const viaArray = validate({
      id: "acme.via_array",
      version: 1,
      fields: { title: { type: "string" } },
      required: ["title"],
    });
    const viaField = validate({
      id: "acme.via_field",
      version: 1,
      fields: { title: { type: "string", required: true } },
    });
    expect(viaArray.success && viaArray.data.fields.title?.required).toBe(true);
    expect(viaField.success && viaField.data.fields.title?.required).toBe(true);
  });

  it("rejects a required name that matches no field", () => {
    const result = validate({
      id: "acme.ghost_required",
      version: 1,
      fields: { title: { type: "string" } },
      required: ["subtitle"],
    });
    expect(result.success).toBe(false);
  });
});
