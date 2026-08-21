import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { TODOIST_MANIFEST } from "./manifest.js";

describe("Todoist manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(TODOIST_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares schedule + item-event triggers (no webhook)", () => {
    const types = TODOIST_MANIFEST.triggers.map((t) => t.type);
    expect(types).toContain("schedule");
    expect(types).toContain("item-event");
    expect(types).not.toContain("webhook");
  });

  it("declares full bidirectional handling block", () => {
    const bidi = TODOIST_MANIFEST.bidirectional_handling;
    expect(bidi.echo_ttl_seconds).toBe(120);
    expect(bidi.lag_window_seconds).toBe(600);
    expect(bidi.tombstone_mapping).toBe("state-trashed");
    expect(bidi.partial_write_mode).toBe("accept-partial");
  });

  it("declares token_requirements for the todoist capability and bumps manifest_schema_version to 1.1.0", () => {
    expect(TODOIST_MANIFEST.token_requirements).toEqual({
      todoist: "required",
    });
    expect(TODOIST_MANIFEST.manifest_schema_version).toMatch(/^2\./);
  });

  it("declares no OAuth requirements (this is a token-credential integration)", () => {
    expect(TODOIST_MANIFEST.oauth_requirements).toEqual({});
  });

  it("targets both core.task and todoist.task; direction is both", () => {
    expect(TODOIST_MANIFEST.target_types).toEqual([
      "core.task",
      "todoist.task",
    ]);
    expect(TODOIST_MANIFEST.direction).toBe("both");
  });
});
