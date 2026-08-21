import { describe, expect, it } from "vitest";
import { validateManifest } from "./validate-manifest.js";

const VALID_MANIFEST = {
  name: "acme/calendar-sync",
  version: "1.2.3",
  publisher: "Acme",
  description: "Two-way Google Calendar sync",
  direction: "both",
  triggers: [
    { type: "schedule", config: { cron: "*/15 * * * *" } },
    { type: "webhook" },
  ],
  target_types: ["core.event"],
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
  manifest_schema_version: "2.0.0",
};

describe("validateManifest", () => {
  it("returns ok with the parsed manifest on the happy path", () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("acme/calendar-sync");
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
      manifest_schema_version: "3.0.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "manifest_schema_version",
          message:
            "manifest schema version not supported (expected major 2.x.x, got 3.0.0)",
        },
      ]);
    }
  });

  it("accepts any 1.x.x manifest_schema_version", () => {
    expect(
      validateManifest({
        ...VALID_MANIFEST,
        manifest_schema_version: "2.0.0",
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

/**
 * The stored-manifest contract after the tolerance came out.
 *
 * `validateManifest` runs on every resolution and a credential mint fails
 * closed, so what this function accepts is a statement about live data
 * rather than about registration. It accepted major 1 while catalog rows
 * written against the previous contract were migrated forward; that
 * migration has run everywhere, so no such row exists to accept.
 *
 * Getting this wrong once took out every connection on staging inside a
 * single deploy, with an error naming a schema version rather than
 * anything a user did. The assertions below are the closed state.
 */
describe("validateManifest — the stored-manifest contract", () => {
  it("accepts a current manifest", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      manifest_schema_version: "2.0.0",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a row from the previous contract", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      manifest_schema_version: "1.3.0",
      runtime_compatibility: ["hosted", "local"],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a major from a contract this build does not know", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      manifest_schema_version: "3.0.0",
    });
    expect(result.ok).toBe(false);
  });
});
