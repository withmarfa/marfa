import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@mymehq/shared";
import { RAINDROP_MANIFEST } from "./manifest.js";

describe("Raindrop manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(RAINDROP_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares only a schedule trigger", () => {
    expect(RAINDROP_MANIFEST.triggers.map((t) => t.type)).toEqual(["schedule"]);
  });

  it("is inbound-only (direction: read)", () => {
    expect(RAINDROP_MANIFEST.direction).toBe("read");
  });

  it("declares token_requirements for the raindrop capability + 1.1.0 schema version", () => {
    expect(RAINDROP_MANIFEST.token_requirements).toEqual({
      raindrop: "required",
    });
    expect(RAINDROP_MANIFEST.manifest_schema_version).toBe("1.1.0");
  });

  it("targets raindrop.raindrop + raindrop.collection", () => {
    expect(RAINDROP_MANIFEST.target_types).toEqual([
      "raindrop.raindrop",
      "raindrop.collection",
    ]);
  });

  it("grants parent-of edge write to the runtime credential", () => {
    expect(RAINDROP_MANIFEST.permissions?.edge).toEqual({
      "parent-of": "write",
    });
  });

  it("declares tombstone_mapping: ignore (non-destructive on existing data)", () => {
    expect(RAINDROP_MANIFEST.bidirectional_handling.tombstone_mapping).toBe(
      "ignore",
    );
  });
});
