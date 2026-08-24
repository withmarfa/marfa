import { describe, it, expect } from "vitest";
import {
  IntegrationManifestSchema,
  validateWriteFamilies,
} from "@withmarfa/shared";
import {
  DEFAULT_WRITE_FAMILY,
  GOOGLE_YOUTUBE_MANIFEST,
  FAMILY_DEFINITIONS,
} from "./manifest.js";

describe("Google YouTube manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(GOOGLE_YOUTUBE_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares only a schedule trigger — no item-event, no webhook", () => {
    const types = GOOGLE_YOUTUBE_MANIFEST.triggers.map((t) => t.type);
    expect(types).toEqual(["schedule"]);
  });

  it("schedule trigger runs hourly", () => {
    const sched = GOOGLE_YOUTUBE_MANIFEST.triggers.find(
      (t) => t.type === "schedule",
    );
    expect(sched).toBeDefined();
    if (sched?.type === "schedule") {
      expect(sched.config.cron).toBe("0 * * * *");
    }
  });

  it("requires the youtube capability via OAuth proxy", () => {
    expect(GOOGLE_YOUTUBE_MANIFEST.oauth_requirements).toEqual({
      youtube: "proxy",
    });
  });

  it("targets the three google.youtube.* types; direction is read (inbound only)", () => {
    expect(GOOGLE_YOUTUBE_MANIFEST.target_types).toEqual([
      "google.youtube.video",
      "google.youtube.playlist",
      "google.youtube.channel",
    ]);
    expect(GOOGLE_YOUTUBE_MANIFEST.direction).toBe("read");
  });

  it("declares one coherent write family and no chooser", () => {
    expect(validateWriteFamilies(GOOGLE_YOUTUBE_MANIFEST)).toEqual([]);
    expect(GOOGLE_YOUTUBE_MANIFEST.write_families?.default).toBe(
      DEFAULT_WRITE_FAMILY,
    );
    // One family needs no `write_family` key: there is nothing to choose.
    expect(
      GOOGLE_YOUTUBE_MANIFEST.configuration_schema?.write_family,
    ).toBeUndefined();
    expect(
      Object.keys(GOOGLE_YOUTUBE_MANIFEST.write_families?.families ?? {}),
    ).toEqual(["google"]);
    expect(FAMILY_DEFINITIONS.google.types.video).toBe("google.youtube.video");
    expect(FAMILY_DEFINITIONS.google.types.playlist).toBe(
      "google.youtube.playlist",
    );
    expect(FAMILY_DEFINITIONS.google.types.channel).toBe(
      "google.youtube.channel",
    );
  });

  it("handle is shared with google/calendar, google/tasks and google/contacts", () => {
    expect(GOOGLE_YOUTUBE_MANIFEST.publisher).toBe("google");
    expect(GOOGLE_YOUTUBE_MANIFEST.name.startsWith("google/")).toBe(true);
  });

  it("grants parent-of edge write permission for channel/playlist hierarchies", () => {
    expect(GOOGLE_YOUTUBE_MANIFEST.permissions?.edge).toEqual({
      "parent-of": "write",
    });
  });
});
