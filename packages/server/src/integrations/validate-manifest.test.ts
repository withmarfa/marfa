import { describe, expect, it } from "vitest";
import { validateManifest } from "./validate-manifest.js";

const VALID_MANIFEST = {
  name: "acme.calendar-sync",
  version: "1.2.3",
  publisher: "Acme",
  description: "Two-way Google Calendar sync",
  direction: "both",
  triggers: [
    { type: "schedule", config: { cron: "*/15 * * * *" } },
    { type: "webhook" },
  ],
  target_types: ["core.event"],
  runtime_compatibility: ["hosted"],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "prompt-user",
    partial_write_mode: "all-or-nothing",
  },
  oauth_requirements: {
    "calendar.read": "proxy",
  },
  webhook_verification: { method: "hmac-sha256" },
  manifest_schema_version: "1.0.0",
};

describe("validateManifest", () => {
  it("returns ok with the parsed manifest on the happy path", () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("acme.calendar-sync");
      expect(result.manifest.triggers).toHaveLength(2);
    }
  });

  it("rejects unknown trigger types with a structured error", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      triggers: [{ type: "lunar-eclipse" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.path.startsWith("triggers")).toBe(true);
    }
  });

  it("rejects an invalid scope/type-identifier in target_types", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      target_types: ["NOT VALID"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.startsWith("target_types"))).toBe(
        true,
      );
    }
  });

  it("rejects an invalid version semver", () => {
    const result = validateManifest({ ...VALID_MANIFEST, version: "1.2" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "version")).toBe(true);
    }
  });

  it("rejects unknown verification method", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      webhook_verification: { method: "rot13" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects the 'custom' verification method (removed from the schema)", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      webhook_verification: { method: "custom", adapter_id: "x" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown bidi tombstone_mapping", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      bidirectional_handling: {
        ...VALID_MANIFEST.bidirectional_handling,
        tombstone_mapping: "burn-it-all",
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing required field", () => {
    const broken = { ...VALID_MANIFEST } as Record<string, unknown>;
    delete broken.publisher;
    const result = validateManifest(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "publisher")).toBe(true);
    }
  });

  it("rejects a manifest_schema_version with unsupported major", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      manifest_schema_version: "2.0.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "manifest_schema_version",
          message:
            "manifest schema version not supported (expected major 1.x.x, got 2.0.0)",
        },
      ]);
    }
  });

  it("accepts any 1.x.x manifest_schema_version", () => {
    expect(
      validateManifest({
        ...VALID_MANIFEST,
        manifest_schema_version: "1.99.99",
      }).ok,
    ).toBe(true);
  });

  it("returns _root path on a non-object input", () => {
    const result = validateManifest("not a manifest");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("_root");
    }
  });
});
