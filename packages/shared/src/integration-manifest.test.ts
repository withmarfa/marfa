import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  applyConfigurationDefaults,
  declaredConfigurationDefault,
  IntegrationManifestSchema,
  parseManifestSchemaMajor,
  resolveWriteFamily,
  validateWriteFamilies,
} from "./integration-manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMMITTED_JSON_SCHEMA_PATH = resolve(
  __dirname,
  "..",
  "..",
  "types",
  "integration-manifest-schema.json",
);

const VALID_MANIFEST = {
  name: "acme/calendar-sync",
  version: "1.2.3",
  publisher: "acme",
  description: "Two-way Google Calendar sync",
  direction: "both" as const,
  triggers: [
    { type: "schedule" as const, config: { cron: "*/15 * * * *" } },
    { type: "webhook" as const },
    { type: "manual" as const },
  ],
  target_types: ["core.event"],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "prompt-user" as const,
    partial_write_mode: "all-or-nothing" as const,
  },
  oauth_requirements: {
    "calendar.read": "proxy" as const,
    "drive.upload": "leased" as const,
  },
  webhook_verification: { method: "hmac-sha256" as const },
  manifest_schema_version: "2.0.0",
};

describe("IntegrationManifestSchema — happy path", () => {
  it("accepts a fully populated valid manifest", () => {
    const result = IntegrationManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
  });

  it("supplies defaults for echo_ttl_seconds and lag_window_seconds", () => {
    const minimal = {
      ...VALID_MANIFEST,
      bidirectional_handling: {
        tombstone_mapping: "prompt-user" as const,
        partial_write_mode: "all-or-nothing" as const,
      },
    };
    const result = IntegrationManifestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bidirectional_handling?.echo_ttl_seconds).toBe(60);
      expect(result.data.bidirectional_handling?.lag_window_seconds).toBe(60);
    }
  });
});

describe("IntegrationManifestSchema — required-field rejects", () => {
  const requiredFields = [
    "name",
    "version",
    "publisher",
    "description",
    "direction",
    "target_types",
    "manifest_schema_version",
  ] as const;

  for (const field of requiredFields) {
    it(`rejects missing ${field}`, () => {
      // Build a copy without the named field via rest-destructuring to keep
      // ESLint's no-dynamic-delete rule happy (the field is computed at
      // iteration time).
      const { [field]: _omitted, ...broken } = VALID_MANIFEST as Record<
        string,
        unknown
      >;
      void _omitted;
      const result = IntegrationManifestSchema.safeParse(broken);
      expect(result.success).toBe(false);
    });
  }
});

describe("IntegrationManifestSchema — invalid values", () => {
  it("rejects an invalid version semver", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      version: "1.2",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid manifest_schema_version semver", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      manifest_schema_version: "v1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a name that doesn't match publisher-namespaced grammar", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      name: "Just A Name",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown trigger type", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      triggers: [{ type: "lunar-eclipse" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a schedule trigger missing the cron string", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      triggers: [{ type: "schedule", config: {} }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown webhook_verification method", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      webhook_verification: { method: "rot13" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects the dropped 'custom' verification method", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      webhook_verification: { method: "custom", adapter_id: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown bidi tombstone_mapping", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      bidirectional_handling: {
        ...VALID_MANIFEST.bidirectional_handling,
        tombstone_mapping: "burn-it-all",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown bidi partial_write_mode", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      bidirectional_handling: {
        ...VALID_MANIFEST.bidirectional_handling,
        partial_write_mode: "best-effort",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a target_types entry that fails type-identifier grammar", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      target_types: ["Not A Type"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty target_types array", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      target_types: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid direction value", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      direction: "diagonal",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown oauth_requirements value", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      oauth_requirements: { "drive.upload": "trust-me-bro" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level fields (.strict())", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      surprise_field: "uninvited",
    });
    expect(result.success).toBe(false);
  });
});

describe("IntegrationManifestSchema — token_requirements (1.1.0 additive)", () => {
  it("accepts manifests that declare token_requirements", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      manifest_schema_version: "2.0.0",
      token_requirements: { todoist: "required" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token_requirements).toEqual({ todoist: "required" });
    }
  });

  it("accepts manifests omitting token_requirements (backward compatible)", () => {
    const result = IntegrationManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token_requirements).toBeUndefined();
    }
  });

  it("rejects an unknown token_requirements value", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      manifest_schema_version: "2.0.0",
      token_requirements: { todoist: "optional" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty token_requirements key", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      manifest_schema_version: "2.0.0",
      token_requirements: { "": "required" },
    });
    expect(result.success).toBe(false);
  });
});

describe("parseManifestSchemaMajor", () => {
  it("returns the major component for a valid semver", () => {
    expect(parseManifestSchemaMajor("1.0.0")).toBe(1);
    expect(parseManifestSchemaMajor("2.5.99")).toBe(2);
    expect(parseManifestSchemaMajor("13.0.0")).toBe(13);
  });

  it("returns null for malformed versions", () => {
    expect(parseManifestSchemaMajor("v1.0.0")).toBeNull();
    expect(parseManifestSchemaMajor("1.0")).toBeNull();
    expect(parseManifestSchemaMajor("not.a.version")).toBeNull();
  });
});

describe("Integration manifest JSON Schema artifact", () => {
  it("the committed JSON Schema matches the in-memory output of z.toJSONSchema (drift guard)", () => {
    // When this fails after a schema edit, run:
    //   pnpm --filter @withmarfa/shared run generate:manifest-schema
    const expected =
      JSON.stringify(z.toJSONSchema(IntegrationManifestSchema), null, 2) + "\n";
    const actual = readFileSync(COMMITTED_JSON_SCHEMA_PATH, "utf8");
    expect(actual).toBe(expected);
  });
});

describe("applyConfigurationDefaults", () => {
  const manifest = {
    configuration_schema: {
      target_type: {
        type: "string" as const,
        description: "Item type synced events land as.",
        default: "google.calendar.event",
      },
      page_size: {
        type: "number" as const,
        description: "Items per page.",
        default: 50,
      },
      label: { type: "string" as const, description: "No default declared." },
    },
  };

  it("fills in a declared default the caller left out", () => {
    expect(applyConfigurationDefaults(manifest, {})).toEqual({
      target_type: "google.calendar.event",
      page_size: 50,
    });
  });

  it("never overrides a value the caller supplied", () => {
    expect(
      applyConfigurationDefaults(manifest, { target_type: "core.event" }),
    ).toMatchObject({ target_type: "core.event" });
  });

  it("leaves a key with no declared default absent", () => {
    expect(applyConfigurationDefaults(manifest, {})).not.toHaveProperty(
      "label",
    );
  });

  it("keeps keys the manifest does not declare, so validation can refuse them", () => {
    // Filling defaults is not the enforcement point. Dropping an undeclared
    // key here would hide it from the validator that exists to reject it.
    expect(applyConfigurationDefaults(manifest, { stray: 1 })).toMatchObject({
      stray: 1,
    });
  });

  it("is a no-op for a manifest that declares no configuration", () => {
    expect(applyConfigurationDefaults({}, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("declaredConfigurationDefault", () => {
  it("reads a string default", () => {
    expect(
      declaredConfigurationDefault(
        {
          configuration_schema: {
            target_type: {
              type: "string",
              description: "d",
              default: "core.event",
            },
          },
        },
        "target_type",
      ),
    ).toBe("core.event");
  });

  it("is undefined for a key with no default, and for a non-string one", () => {
    const manifest = {
      configuration_schema: {
        label: { type: "string" as const, description: "d" },
        page_size: {
          type: "number" as const,
          description: "d",
          default: 50,
        },
      },
    };
    expect(declaredConfigurationDefault(manifest, "label")).toBeUndefined();
    expect(declaredConfigurationDefault(manifest, "page_size")).toBeUndefined();
    expect(declaredConfigurationDefault(manifest, "absent")).toBeUndefined();
  });
});

describe("validateWriteFamilies — every refusal branch", () => {
  // The validator is the central replacement for the per-integration
  // pair-membership tests, so its refusals are load-bearing platform
  // behavior: a manifest error any of these misses ships as a silently
  // wrong family resolution. Each branch gets a negative case; the happy
  // path is the positive control.
  const valid = {
    target_types: [
      "acme.show",
      "acme.episode",
      "core.media.series",
      "core.media.episode",
    ],
    configuration_schema: {
      write_family: {
        type: "string" as const,
        description: "d",
        from_write_families: true,
      },
    },
    write_families: {
      families: {
        acme: {
          description: "d",
          types: { show: "acme.show", episode: "acme.episode" },
        },
        core: {
          description: "d",
          types: { show: "core.media.series", episode: "core.media.episode" },
        },
      },
      default: "acme",
    },
  };

  it("accepts a coherent manifest (positive control)", () => {
    expect(validateWriteFamilies(valid)).toEqual([]);
  });

  it("accepts a manifest with no families and no selector", () => {
    expect(
      validateWriteFamilies({
        target_types: ["acme.show"],
        configuration_schema: {
          label: { type: "string" as const, description: "d" },
        },
      }),
    ).toEqual([]);
  });

  it("refuses a from_write_families selector with no families declared", () => {
    const issues = validateWriteFamilies({
      target_types: valid.target_types,
      configuration_schema: valid.configuration_schema,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("from_write_families");
    expect(issues[0]).toContain("declares no write_families");
  });

  it("refuses an empty families record", () => {
    const issues = validateWriteFamilies({
      ...valid,
      write_families: { families: {}, default: "acme" },
    });
    expect(issues).toEqual([
      "write_families.families must declare at least one family",
    ]);
  });

  it("refuses a default naming an undeclared family", () => {
    const issues = validateWriteFamilies({
      ...valid,
      write_families: { ...valid.write_families, default: "vinyl" },
    });
    expect(issues).toEqual([
      'write_families.default "vinyl" is not a declared family',
    ]);
  });

  it("refuses a family whose member is not a target type", () => {
    const issues = validateWriteFamilies({
      ...valid,
      target_types: ["acme.show", "core.media.series", "core.media.episode"],
    });
    expect(issues).toEqual([
      'write family "acme" names "acme.episode", which is not in target_types',
    ]);
  });

  it("refuses a family that declares no types", () => {
    const issues = validateWriteFamilies({
      target_types: ["acme.show"],
      write_families: {
        families: {
          acme: { description: "d", types: { show: "acme.show" } },
          empty: { description: "d", types: {} },
        },
        default: "acme",
      },
    });
    expect(issues).toEqual(['write family "empty" declares no types']);
  });

  it("refuses a target type no family covers", () => {
    const issues = validateWriteFamilies({
      ...valid,
      target_types: [...valid.target_types, "acme.transcript"],
    });
    expect(issues).toEqual([
      'target type "acme.transcript" belongs to no write family; every target travels in one',
    ]);
  });
});

describe("resolveWriteFamily — precedence and fallthroughs", () => {
  const manifest = {
    write_families: {
      families: {
        acme: {
          description: "d",
          types: { show: "acme.show", episode: "acme.episode" },
        },
        core: {
          description: "d",
          types: { show: "core.media.series", episode: "core.media.episode" },
        },
      },
      default: "acme",
    },
  };

  it("resolves a configured family by name", () => {
    expect(resolveWriteFamily(manifest, { write_family: "core" })).toEqual({
      name: "core",
      types: { show: "core.media.series", episode: "core.media.episode" },
    });
  });

  it("falls through to the default when the configured name is undeclared", () => {
    expect(resolveWriteFamily(manifest, { write_family: "vinyl" })?.name).toBe(
      "acme",
    );
  });

  it("ignores a target_type left in stored configuration", () => {
    // The pre-families shape wrote `target_type`, and it was read for one
    // release so installed connections kept resolving. No connection carries
    // it any more, and a value nothing writes must not steer a write.
    expect(
      resolveWriteFamily(manifest, { target_type: "core.media.series" })?.name,
    ).toBe("acme");
  });

  it("resolves the default with no configuration at all", () => {
    expect(resolveWriteFamily(manifest, undefined)?.name).toBe("acme");
    expect(resolveWriteFamily(manifest, {})?.name).toBe("acme");
  });

  it("returns null for a manifest that declares no families", () => {
    expect(resolveWriteFamily({}, { write_family: "acme" })).toBeNull();
  });
});

/**
 * The contract after the tolerance came out.
 *
 * `IntegrationManifestSchema` is strict AND runs against every stored
 * manifest on every resolution, not only against one being registered, and
 * a credential mint that cannot resolve its manifest fails closed. That is
 * what made removing a field a live-data change rather than a schema edit,
 * and it is why the field left in three steps with a tolerance in the
 * middle.
 *
 * The tolerance is gone because the migration that rewrote every stored row
 * has run on every deployment. These assertions are the closed state: the
 * retired key is now an unknown key like any other, and nothing anywhere
 * still produces it.
 */
describe("the retired manifest key", () => {
  it("is refused, the same as any other unknown key", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      runtime_compatibility: ["hosted", "local"],
    });
    expect(result.success).toBe(false);
  });

  it("refuses a typo of it too, which is the point of strictness", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      runtime_compatibilty: ["local"],
    });
    expect(result.success).toBe(false);
  });
});

describe("IntegrationManifestSchema — display_name", () => {
  it("accepts a manifest declaring a display_name", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      display_name: "Calendar Sync",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.display_name).toBe("Calendar Sync");
  });

  it("accepts a manifest omitting display_name, leaving it undefined", () => {
    const result = IntegrationManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
    expect(result.success && result.data.display_name).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("refuses a %s display_name", (_label, value) => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      display_name: value,
    });
    expect(result.success).toBe(false);
    expect(
      !result.success &&
        result.error.issues.some((i) => i.path.join(".") === "display_name"),
    ).toBe(true);
  });

  it("trims a declared display_name", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      display_name: "  Calendar Sync  ",
    });
    expect(result.success && result.data.display_name).toBe("Calendar Sync");
  });

  // The length check reaches whitespace and stops there. Pinned so nobody
  // reads the refusals above as a guarantee that a declared label always
  // renders as something, which is why surfaces keep the identifier.
  it("admits a zero-width display_name, which the length check cannot catch", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      display_name: "\u200b",
    });
    expect(result.success).toBe(true);
  });
});

describe("IntegrationManifestSchema — publisher", () => {
  const withPublisher = (publisher: unknown): unknown => ({
    ...VALID_MANIFEST,
    publisher,
  });

  it("accepts the platform's own reserved name", () => {
    // `marfa` is a reserved root, so `isValidHandle` refuses it and every
    // first-party manifest declares it. A validator carrying the
    // reserved-root check would refuse the whole shipped set, which is
    // the reason this field is checked against the grammar alone.
    expect(
      IntegrationManifestSchema.safeParse(withPublisher("marfa")).success,
    ).toBe(true);
  });

  it("refuses a display name wearing the field's clothes", () => {
    // What the field held before anything checked it: the organisation
    // name, title-cased, which is not a handle in any namespace.
    expect(
      IntegrationManifestSchema.safeParse(withPublisher("Acme")).success,
    ).toBe(false);
  });

  it.each([
    ["a leading hyphen", "-acme"],
    ["a trailing hyphen", "acme-"],
    ["consecutive hyphens", "ac--me"],
    ["under three characters", "ac"],
    ["a space", "acme corp"],
    ["a slash, which is an identifier rather than a handle", "acme/notebook"],
  ])("refuses %s", (_label, publisher) => {
    expect(
      IntegrationManifestSchema.safeParse(withPublisher(publisher)).success,
    ).toBe(false);
  });

  it("still refuses an absent one", () => {
    const without: Record<string, unknown> = { ...VALID_MANIFEST };
    delete without.publisher;
    expect(IntegrationManifestSchema.safeParse(without).success).toBe(false);
  });
});

describe("IntegrationManifestSchema — a manifest declares only what is true of it", () => {
  // The three fields every manifest had to supply a value for, and which
  // most had no honest value for. A field with nothing to say is absent.
  const {
    webhook_verification: _wv,
    bidirectional_handling: _bh,
    oauth_requirements: _oa,
    ...SPARSE
  } = { ...VALID_MANIFEST, direction: "read" as const };
  void _wv;
  void _bh;
  void _oa;

  it("accepts a manifest declaring none of the three optional fields", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...SPARSE,
      triggers: [{ type: "schedule" as const, config: { cron: "0 * * * *" } }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a manifest that omits triggers when it runs on the client", () => {
    const { triggers: _t, ...noTriggers } = SPARSE;
    void _t;
    const result = IntegrationManifestSchema.safeParse({
      ...noTriggers,
      runs_on: "client",
    });
    expect(result.success).toBe(true);
  });

  it("defaults runs_on to server when the manifest does not declare it", () => {
    const result = IntegrationManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.runs_on).toBe("server");
  });

  it("carries a declared runs_on through the parse", () => {
    const { triggers: _t, ...noTriggers } = SPARSE;
    void _t;
    const result = IntegrationManifestSchema.safeParse({
      ...noTriggers,
      runs_on: "client",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.runs_on).toBe("client");
  });

  it("refuses a runs_on value outside the pair", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      runs_on: "worker",
    });
    expect(result.success).toBe(false);
  });
});
