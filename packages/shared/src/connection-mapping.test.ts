import { describe, expect, it } from "vitest";
import {
  evaluateConnectionMapping,
  validateConnectionMapping,
  type ConnectionMapping,
} from "./connection-mapping.js";
import { registerTypeSchema } from "./type-registry.js";

const SPACE = "space-mapping-test";

// A space-scoped custom type for the registry-aware validation cases. The
// registry is module-singleton state, so the space id scopes these to this
// file.
registerTypeSchema(
  {
    id: "user.podcast_log",
    version: 1,
    fields: {
      title: { type: "string", required: true },
      url: { type: "url" },
      listened: { type: "boolean" },
    },
  },
  SPACE,
);

function mapping(overrides: Partial<ConnectionMapping> = {}): unknown {
  return {
    version: 1,
    rules: [
      {
        when: { path: "kind", op: "equals", value: "episode" },
        target_type: "user.podcast_log",
        assign: {
          title: { path: "episode.title" },
          url: { path: "enclosure.url" },
          listened: { const: false },
        },
      },
    ],
    otherwise: "family",
    ...overrides,
  };
}

describe("validateConnectionMapping", () => {
  it("accepts a well-formed mapping against the space registry", () => {
    const result = validateConnectionMapping(mapping(), SPACE);
    expect(result.ok).toBe(true);
  });

  it("refuses a target type the space has not registered, naming the field", () => {
    const result = validateConnectionMapping(
      mapping({
        rules: [
          {
            when: { path: "kind", op: "exists" },
            target_type: "user.never_registered",
            assign: { title: { const: "x" } },
          },
        ],
      }),
      SPACE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.field).toBe("rules.0.target_type");
    }
  });

  it("refuses reserved-namespace targets before resolution", () => {
    for (const target of ["system.activity", "marfa.anything"]) {
      const result = validateConnectionMapping(
        mapping({
          rules: [
            {
              when: { path: "kind", op: "exists" },
              target_type: target,
              assign: {},
            },
          ],
        }),
        SPACE,
      );
      expect(result.ok, target).toBe(false);
    }
  });

  it("refuses an assignment to a field the target does not declare", () => {
    const result = validateConnectionMapping(
      mapping({
        rules: [
          {
            when: { path: "kind", op: "exists" },
            target_type: "user.podcast_log",
            assign: {
              title: { const: "x" },
              no_such_field: { const: "y" },
            },
          },
        ],
      }),
      SPACE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.field === "rules.0.assign.no_such_field"),
      ).toBe(true);
    }
  });

  it("refuses a rule that never assigns a required target field", () => {
    const result = validateConnectionMapping(
      mapping({
        rules: [
          {
            when: { path: "kind", op: "exists" },
            target_type: "user.podcast_log",
            assign: { url: { path: "enclosure.url" } },
          },
        ],
      }),
      SPACE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.field === "rules.0.assign.title"),
      ).toBe(true);
    }
  });

  it("refuses operator and value mismatches structurally", () => {
    const missingValue = validateConnectionMapping(
      mapping({
        rules: [
          {
            when: { path: "kind", op: "equals" },
            target_type: "user.podcast_log",
            assign: { title: { const: "x" } },
          },
        ],
      }),
      SPACE,
    );
    expect(missingValue.ok).toBe(false);
    const strayValue = validateConnectionMapping(
      mapping({
        rules: [
          {
            when: { path: "kind", op: "exists", value: "y" },
            target_type: "user.podcast_log",
            assign: { title: { const: "x" } },
          },
        ],
      }),
      SPACE,
    );
    expect(strayValue.ok).toBe(false);
  });
});

describe("evaluateConnectionMapping", () => {
  const valid = (): ConnectionMapping => {
    const result = validateConnectionMapping(mapping(), SPACE);
    if (!result.ok) throw new Error("fixture failed validation");
    return result.mapping;
  };

  it("routes a matching record with assigned fields and constants", () => {
    const outcome = evaluateConnectionMapping(valid(), {
      kind: "episode",
      episode: { title: "Pilot" },
      enclosure: { url: "https://example.com/1.mp3" },
    });
    expect(outcome).toEqual({
      kind: "user",
      target_type: "user.podcast_log",
      properties: {
        title: "Pilot",
        url: "https://example.com/1.mp3",
        listened: false,
      },
    });
  });

  it("omits a property whose source path is absent, leaving refusal to write-time validation", () => {
    const outcome = evaluateConnectionMapping(valid(), {
      kind: "episode",
      enclosure: {},
    });
    expect(outcome.kind).toBe("user");
    if (outcome.kind === "user") {
      expect("title" in outcome.properties).toBe(false);
      expect(outcome.properties.listened).toBe(false);
    }
  });

  it("falls through to the family for an unmatched record", () => {
    expect(evaluateConnectionMapping(valid(), { kind: "show" })).toEqual({
      kind: "family",
    });
  });

  it("skips when the mapping says so", () => {
    const result = validateConnectionMapping(
      mapping({ otherwise: "skip" }),
      SPACE,
    );
    if (!result.ok) throw new Error("fixture failed validation");
    expect(evaluateConnectionMapping(result.mapping, { kind: "show" })).toEqual(
      { kind: "skip" },
    );
  });

  it("takes the first matching rule and honors all-conjunctions", () => {
    const doc = validateConnectionMapping(
      mapping({
        rules: [
          {
            when: {
              all: [
                { path: "kind", op: "equals", value: "episode" },
                { path: "flags", op: "contains", value: "keep" },
              ],
            },
            target_type: "user.podcast_log",
            assign: { title: { const: "kept" } },
          },
          {
            when: { path: "kind", op: "equals", value: "episode" },
            target_type: "user.podcast_log",
            assign: { title: { const: "fallthrough" } },
          },
        ],
      }),
      SPACE,
    );
    if (!doc.ok) throw new Error("fixture failed validation");
    const kept = evaluateConnectionMapping(doc.mapping, {
      kind: "episode",
      flags: ["keep", "other"],
    });
    expect(kept.kind === "user" && kept.properties.title).toBe("kept");
    const fell = evaluateConnectionMapping(doc.mapping, { kind: "episode" });
    expect(fell.kind === "user" && fell.properties.title).toBe("fallthrough");
  });
});
