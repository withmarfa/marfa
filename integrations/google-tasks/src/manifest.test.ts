import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { GOOGLE_TASKS_MANIFEST } from "./manifest.js";

describe("Google Tasks manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(GOOGLE_TASKS_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares schedule and item-event triggers but NO webhook (Tasks API has no push surface)", () => {
    const types = GOOGLE_TASKS_MANIFEST.triggers.map((t) => t.type);
    expect(types).toContain("schedule");
    expect(types).toContain("item-event");
    expect(types).not.toContain("webhook");
  });

  it("declares full bidirectional handling block matching Calendar's defaults", () => {
    const bidi = GOOGLE_TASKS_MANIFEST.bidirectional_handling;
    expect(bidi.echo_ttl_seconds).toBe(120);
    expect(bidi.lag_window_seconds).toBe(600);
    expect(bidi.tombstone_mapping).toBe("state-trashed");
    expect(bidi.partial_write_mode).toBe("accept-partial");
  });

  it("requires the tasks capability via OAuth proxy", () => {
    expect(GOOGLE_TASKS_MANIFEST.oauth_requirements).toEqual({
      tasks: "proxy",
    });
  });

  it("targets both core.task (cross-app shape) and google.tasks.task (upstream-fidelity shape); direction is both", () => {
    expect(GOOGLE_TASKS_MANIFEST.target_types).toEqual([
      "core.task",
      "google.tasks.task",
    ]);
    expect(GOOGLE_TASKS_MANIFEST.direction).toBe("both");
  });

  it("publisher namespace is shared with google.calendar so credential_ref reuse works", () => {
    expect(GOOGLE_TASKS_MANIFEST.publisher).toBe("google");
    expect(GOOGLE_TASKS_MANIFEST.name.startsWith("google.")).toBe(true);
  });
});
