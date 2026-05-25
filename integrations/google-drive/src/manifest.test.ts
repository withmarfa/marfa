import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { GOOGLE_DRIVE_MANIFEST } from "./manifest.js";

describe("Google Drive manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(GOOGLE_DRIVE_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares schedule + item-event + webhook triggers (changes.watch push lives here)", () => {
    const types = GOOGLE_DRIVE_MANIFEST.triggers.map((t) => t.type);
    expect(types).toContain("schedule");
    expect(types).toContain("item-event");
    expect(types).toContain("webhook");
  });

  it("declares full bidirectional handling block matching Calendar's defaults", () => {
    const bidi = GOOGLE_DRIVE_MANIFEST.bidirectional_handling;
    expect(bidi.echo_ttl_seconds).toBe(120);
    expect(bidi.lag_window_seconds).toBe(600);
    expect(bidi.tombstone_mapping).toBe("state-trashed");
    expect(bidi.partial_write_mode).toBe("accept-partial");
  });

  it("requires the drive capability via OAuth proxy and uses google-channel webhook verification", () => {
    expect(GOOGLE_DRIVE_MANIFEST.oauth_requirements).toEqual({
      drive: "proxy",
    });
    expect(GOOGLE_DRIVE_MANIFEST.webhook_verification).toEqual({
      method: "google-channel",
    });
  });

  it("targets both core.file and google.drive.file; direction is read (inbound-only; outbound deferred)", () => {
    expect(GOOGLE_DRIVE_MANIFEST.target_types).toEqual([
      "core.file",
      "google.drive.file",
    ]);
    expect(GOOGLE_DRIVE_MANIFEST.direction).toBe("read");
  });

  it("publisher namespace is shared with the other google.* integrations", () => {
    expect(GOOGLE_DRIVE_MANIFEST.publisher).toBe("google");
    expect(GOOGLE_DRIVE_MANIFEST.name.startsWith("google.")).toBe(true);
  });
});
