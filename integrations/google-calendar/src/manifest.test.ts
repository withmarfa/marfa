import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@mymehq/shared";
import { GOOGLE_CALENDAR_MANIFEST } from "./manifest.js";

describe("Google Calendar manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(
      GOOGLE_CALENDAR_MANIFEST,
    );
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares both schedule and item-event triggers", () => {
    const types = GOOGLE_CALENDAR_MANIFEST.triggers.map((t) => t.type);
    expect(types).toContain("schedule");
    expect(types).toContain("item-event");
  });

  it("declares full bidirectional handling block", () => {
    const bidi = GOOGLE_CALENDAR_MANIFEST.bidirectional_handling;
    expect(bidi.echo_ttl_seconds).toBe(120);
    expect(bidi.lag_window_seconds).toBe(600);
    expect(bidi.tombstone_mapping).toBe("state-trashed");
    expect(bidi.partial_write_mode).toBe("accept-partial");
  });

  it("requires the calendar capability via OAuth proxy", () => {
    expect(GOOGLE_CALENDAR_MANIFEST.oauth_requirements).toEqual({
      calendar: "proxy",
    });
  });

  it("targets both core.event (cross-app shape) and google.calendar.event (upstream-fidelity shape); direction is both", () => {
    // Both target types are declared so the install pipeline grants the
    // runtime credential permission to write either. The user picks
    // which is actually written via the install-time configure form
    // (default: google.calendar.event for full fidelity).
    expect(GOOGLE_CALENDAR_MANIFEST.target_types).toEqual([
      "core.event",
      "google.calendar.event",
    ]);
    expect(GOOGLE_CALENDAR_MANIFEST.direction).toBe("both");
  });
});
