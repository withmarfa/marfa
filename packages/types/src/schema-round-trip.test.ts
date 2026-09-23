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
// There are two ways to author a type: commit a JSON file here, or POST it to
// a running server. The in-tree files are the natural thing to copy when
// learning the format, so one the runtime would reshape or reject teaches the
// wrong format. `validateTypeSchema` below is the same function `POST /types`
// calls, which holds the two paths to one judgment.
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
      // the same value, so a JSON file cannot say one thing and the shipped
      // registry another.
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

  it("compares object fields as opaque, whatever they contain", () => {
    // A field declaration has no vocabulary for nested shape, so two object
    // fields compare compatible regardless of contents. The docs state this
    // as the mechanism's honest limit; pinning it makes a future deep
    // comparison a deliberate widening rather than silent drift.
    const target = validateTypeSchema(
      {
        id: "acme.box",
        version: 1,
        fields: { payload: { type: "object", required: true } },
      },
      { resolveSchema: () => undefined },
    );
    expect(target.success).toBe(true);
    if (!target.success) return;

    const result = validateTypeSchema(
      {
        id: "acme.crate",
        version: 1,
        compatible_with: ["acme.box"],
        fields: { payload: { type: "object", required: true } },
      },
      {
        resolveSchema: (id) =>
          id === "acme.box" ? target.data : emitted.get(id),
      },
    );
    expect(result.success).toBe(true);
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

  it("rejects a claim whose matching field remains optional", () => {
    const result = validate({
      id: "acme.optional_note",
      version: 1,
      compatible_with: ["core.note"],
      fields: { body: { type: "string" } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some(
        (error) =>
          error.field === "compatible_with.core.note.body.required" &&
          error.code === "compatible_with_violation",
      ),
    ).toBe(true);
  });

  it("enforces required fields inherited by the compatibility target", () => {
    const result = validate({
      id: "acme.partial_audio",
      version: 1,
      compatible_with: ["core.file.audio"],
      fields: { duration: { type: "number", required: true } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some(
        (error) =>
          error.field === "compatible_with.core.file.audio.blob_ref" &&
          error.code === "compatible_with_violation",
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (error) =>
          error.field === "compatible_with.core.file.audio.mime_type" &&
          error.code === "compatible_with_violation",
      ),
    ).toBe(true);
  });

  it("accepts required compatible fields inherited by the candidate", () => {
    const result = validate({
      id: "acme.annotated_note",
      parent: "core.note",
      version: 1,
      compatible_with: ["core.note"],
      fields: { sentiment: { type: "string" } },
    });
    expect(result.success).toBe(true);
  });

  it("preserves a required refinement of an inherited optional field", () => {
    const result = validate({
      id: "acme.titled_note",
      parent: "core.note",
      version: 1,
      fields: { sentiment: { type: "string" } },
      required: ["title"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.fields.title).toMatchObject({
      type: "string",
      required: true,
    });
  });

  it("rejects incompatible array elements and enum values", () => {
    const customTargets = new Map<string, TypeSchema>([
      [
        "acme.collection",
        {
          id: "acme.collection",
          version: 1,
          fields: {
            tags: { type: "array", items_type: "string", required: true },
            workflow_stage: {
              type: "enum",
              enum_values: ["open", "closed"],
              required: true,
            },
          },
        },
      ],
    ]);
    const result = validateTypeSchema(
      {
        id: "acme.unsafe_collection",
        version: 1,
        compatible_with: ["acme.collection"],
        fields: {
          tags: { type: "array", items_type: "number", required: true },
          workflow_stage: {
            type: "enum",
            enum_values: ["open", "closed", "deleted"],
            required: true,
          },
        },
      },
      {
        resolveSchema: (id) => customTargets.get(id) ?? emitted.get(id),
      },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some(
        (error) =>
          error.field === "compatible_with.acme.collection.tags.items_type",
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (error) =>
          error.field ===
          "compatible_with.acme.collection.workflow_stage.enum_values",
      ),
    ).toBe(true);
  });

  it("accepts an enum that narrows the target's allowed values", () => {
    const customTargets = new Map<string, TypeSchema>([
      [
        "acme.workflow",
        {
          id: "acme.workflow",
          version: 1,
          fields: {
            workflow_stage: {
              type: "enum",
              enum_values: ["open", "closed"],
              required: true,
            },
          },
        },
      ],
    ]);
    const result = validateTypeSchema(
      {
        id: "acme.open_workflow",
        version: 1,
        compatible_with: ["acme.workflow"],
        fields: {
          workflow_stage: {
            type: "enum",
            enum_values: ["open"],
            required: true,
          },
        },
      },
      {
        resolveSchema: (id) => customTargets.get(id) ?? emitted.get(id),
      },
    );
    expect(result.success).toBe(true);
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

// A reader that understands the target reads its optional fields too, so a
// same-named field with a different shape is a mis-parse waiting to happen —
// the promise `compatible_with` makes is about reading, not about which
// fields happen to be mandatory.
describe("compatible_with — optional fields on the target", () => {
  it("rejects a same-named optional field with a conflicting type", () => {
    const result = validate({
      id: "acme.numeric_priority_task",
      version: 1,
      compatible_with: ["core.task"],
      fields: {
        title: { type: "string", required: true },
        // `core.task.priority` is an optional low|medium|high|urgent enum.
        priority: { type: "integer" },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some(
        (error) =>
          error.field === "compatible_with.core.task.priority.type" &&
          error.code === "compatible_with_violation",
      ),
    ).toBe(true);
  });

  it("rejects a same-named optional field with conflicting enum values", () => {
    const result = validate({
      id: "acme.extra_precision_task",
      version: 1,
      compatible_with: ["core.task"],
      fields: {
        title: { type: "string", required: true },
        precision: { type: "enum", enum_values: ["day", "century"] },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some(
        (error) =>
          error.field === "compatible_with.core.task.precision.enum_values",
      ),
    ).toBe(true);
  });

  it("still allows the target's optional field to be absent entirely", () => {
    const result = validate({
      id: "acme.bare_task",
      version: 1,
      compatible_with: ["core.task"],
      fields: { title: { type: "string", required: true } },
    });
    expect(result.success).toBe(true);
  });

  it("allows narrowing an optional string to an enum", () => {
    // Two shipped connectors do exactly this: `core.task.status` and
    // `core.event.status` are free-text, and the connector knows the closed
    // set the upstream service actually emits. An enum only ever holds a
    // string, so a reader expecting `string` is never surprised.
    const result = validate({
      id: "acme.staged_task",
      version: 1,
      compatible_with: ["core.task"],
      fields: {
        title: { type: "string", required: true },
        status: { type: "enum", enum_values: ["pending", "completed"] },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects widening the target's required enum to a plain string", () => {
    const customTargets = new Map<string, TypeSchema>([
      [
        "acme.staged",
        {
          id: "acme.staged",
          version: 1,
          fields: {
            stage: {
              type: "enum",
              enum_values: ["open", "closed"],
              required: true,
            },
          },
        },
      ],
    ]);
    const result = validateTypeSchema(
      {
        id: "acme.freeform_staged",
        version: 1,
        compatible_with: ["acme.staged"],
        fields: { stage: { type: "string", required: true } },
      },
      { resolveSchema: (id) => customTargets.get(id) ?? emitted.get(id) },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some(
        (error) => error.field === "compatible_with.acme.staged.stage.type",
      ),
    ).toBe(true);
  });
});

// The compatibility rule is about values: a claim holds when a reader of the
// target cannot be handed something it would mis-parse. Anything that does not
// change the value set a field admits must not gate the claim, or the check
// rejects schemas that are in fact readable.
describe("compatible_with — what changes the value set and what does not", () => {
  it("accepts a plain string against a target field annotated bcp47", () => {
    // `core.note.language` is `{ type: "string", format: "bcp47" }`, and
    // nothing validates a language tag at write time. A plain string and a
    // bcp47-annotated string therefore hold exactly the same values, so an
    // omitted annotation cannot surprise a reader.
    const result = validate({
      id: "acme.plain_language_note",
      version: 1,
      compatible_with: ["core.note"],
      fields: {
        body: { type: "string", required: true },
        language: { type: "string" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an annotation that contradicts the target's", () => {
    // Neither annotation is enforced, but declaring country codes where the
    // target declares language tags is the author stating a contradiction.
    const result = validate({
      id: "acme.miscoded_note",
      version: 1,
      compatible_with: ["core.note"],
      fields: {
        body: { type: "string", required: true },
        language: { type: "string", format: "iso3166" },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some(
        (error) =>
          error.field === "compatible_with.core.note.language.format" &&
          error.code === "compatible_with_violation",
      ),
    ).toBe(true);
  });

  it("accepts field types whose values are a subset of the target's", () => {
    const customTargets = new Map<string, TypeSchema>([
      [
        "acme.loose",
        {
          id: "acme.loose",
          version: 1,
          fields: {
            href: { type: "string" },
            contact: { type: "string" },
            seen_at: { type: "string" },
            born_on: { type: "string" },
            score: { type: "number" },
          },
        },
      ],
    ]);
    const result = validateTypeSchema(
      {
        id: "acme.tight",
        version: 1,
        compatible_with: ["acme.loose"],
        fields: {
          href: { type: "url" },
          contact: { type: "email" },
          seen_at: { type: "datetime" },
          born_on: { type: "date" },
          score: { type: "integer" },
        },
      },
      { resolveSchema: (id) => customTargets.get(id) ?? emitted.get(id) },
    );
    expect(result.success).toBe(true);
  });

  it("rejects the same pairs in the widening direction", () => {
    const customTargets = new Map<string, TypeSchema>([
      [
        "acme.tight_target",
        {
          id: "acme.tight_target",
          version: 1,
          fields: { href: { type: "url" }, score: { type: "integer" } },
        },
      ],
    ]);
    const result = validateTypeSchema(
      {
        id: "acme.loose_candidate",
        version: 1,
        compatible_with: ["acme.tight_target"],
        fields: { href: { type: "string" }, score: { type: "number" } },
      },
      { resolveSchema: (id) => customTargets.get(id) ?? emitted.get(id) },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    for (const field of ["href", "score"]) {
      expect(
        result.errors.some(
          (error) =>
            error.field === `compatible_with.acme.tight_target.${field}.type`,
        ),
      ).toBe(true);
    }
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
