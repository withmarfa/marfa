import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { SYNC_MANIFEST } from "./manifest.js";

describe("the sync client manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(SYNC_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("keeps the name every installed connection resolves against", () => {
    // A catalog row is keyed on (name, version) and a connection resolves
    // the row it was installed against, so renaming the package must not
    // rename the manifest.
    expect(SYNC_MANIFEST.name).toBe("marfa/sync");
  });

  it("declares bidirectional direction", () => {
    expect(SYNC_MANIFEST.direction).toBe("both");
  });

  it("targets core.note and core.file with manual trigger", () => {
    expect(SYNC_MANIFEST.target_types).toEqual(["core.note", "core.file"]);
    expect(SYNC_MANIFEST.triggers).toEqual([{ type: "manual" }]);
  });

  it("declares no OAuth (uses local api_key credential via credential_ref)", () => {
    expect(SYNC_MANIFEST.oauth_requirements).toEqual({});
  });
});
