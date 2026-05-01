import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@mymehq/shared";
import { SYNC_AGENT_MANIFEST } from "./manifest.js";

describe("Sync Agent manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(SYNC_AGENT_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares local runtime and bidirectional direction", () => {
    expect(SYNC_AGENT_MANIFEST.runtime_compatibility).toEqual(["local"]);
    expect(SYNC_AGENT_MANIFEST.direction).toBe("both");
  });

  it("targets core.note and core.file with manual trigger", () => {
    expect(SYNC_AGENT_MANIFEST.target_types).toEqual([
      "core.note",
      "core.file",
    ]);
    expect(SYNC_AGENT_MANIFEST.triggers).toEqual([{ type: "manual" }]);
  });

  it("declares no OAuth (uses local api_key credential via credential_ref)", () => {
    expect(SYNC_AGENT_MANIFEST.oauth_requirements).toEqual({});
  });
});
