import { describe, it, expect } from "vitest";
import {
  IntegrationManifestSchema,
  validateManifestAuthoring,
} from "@withmarfa/shared";
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

  // The authoring door. The runtime validator deliberately holds a stored
  // manifest to less than this, because it runs against rows registered
  // before the rules existed; a manifest written here has no such excuse.
  it("declares nothing it has nothing to say about", () => {
    const parsed = IntegrationManifestSchema.parse(SYNC_MANIFEST);
    expect(validateManifestAuthoring(parsed)).toEqual([]);
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

  it("says its code runs on the client, which is what the run route reads", () => {
    // The refusal used to be inferred from the absence of a local-runtime
    // registration, which was true of sync and would have been true of any
    // integration this deployment simply did not install. The manifest
    // says it now, so the two cases can be told apart.
    expect(SYNC_MANIFEST.runs_on).toBe("client");
  });

  it("declares no triggers, because nothing on this side fires one", () => {
    expect(SYNC_MANIFEST.triggers).toBeUndefined();
  });

  it("declares no webhook verification and no OAuth requirements", () => {
    // Both were required of every manifest once, so this one carried
    // hmac-sha256 by convention and an empty OAuth record. It receives no
    // webhooks and holds a local api_key credential through credential_ref.
    expect(SYNC_MANIFEST.webhook_verification).toBeUndefined();
    expect(SYNC_MANIFEST.oauth_requirements).toBeUndefined();
  });

  it("targets core.note and core.file", () => {
    expect(SYNC_MANIFEST.target_types).toEqual(["core.note", "core.file"]);
  });
});
