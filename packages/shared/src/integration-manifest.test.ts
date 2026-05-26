import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  IntegrationManifestSchema,
  parseManifestSchemaMajor,
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
  name: "acme.calendar-sync",
  version: "1.2.3",
  publisher: "Acme",
  description: "Two-way Google Calendar sync",
  direction: "both" as const,
  triggers: [
    { type: "schedule" as const, config: { cron: "*/15 * * * *" } },
    { type: "webhook" as const },
    { type: "manual" as const },
  ],
  target_types: ["core.event"],
  runtime_compatibility: ["hosted" as const, "self-hosted" as const],
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
  manifest_schema_version: "1.0.0",
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
      expect(result.data.bidirectional_handling.echo_ttl_seconds).toBe(60);
      expect(result.data.bidirectional_handling.lag_window_seconds).toBe(60);
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
    "triggers",
    "target_types",
    "runtime_compatibility",
    "bidirectional_handling",
    "oauth_requirements",
    "webhook_verification",
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

  it("rejects the dropped 'custom' verification method (T-011)", () => {
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

  it("rejects an empty runtime_compatibility array", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      runtime_compatibility: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown runtime_compatibility entry", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      runtime_compatibility: ["serverless"],
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
      manifest_schema_version: "1.1.0",
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
      manifest_schema_version: "1.1.0",
      token_requirements: { todoist: "optional" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty token_requirements key", () => {
    const result = IntegrationManifestSchema.safeParse({
      ...VALID_MANIFEST,
      manifest_schema_version: "1.1.0",
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

describe("Integration manifest JSON Schema artefact", () => {
  it("the committed JSON Schema matches the in-memory output of z.toJSONSchema (drift guard)", () => {
    // Regenerate in-memory and byte-compare against the committed file.
    // The codegen script invocation is identical to this — when this
    // assertion fails after a Zod bump or schema edit, run
    // `pnpm --filter @withmarfa/shared run generate:manifest-schema` and
    // commit the delta.
    const expected =
      JSON.stringify(z.toJSONSchema(IntegrationManifestSchema), null, 2) + "\n";
    const actual = readFileSync(COMMITTED_JSON_SCHEMA_PATH, "utf8");
    expect(actual).toBe(expected);
  });
});
