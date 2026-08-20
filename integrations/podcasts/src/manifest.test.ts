import { describe, expect, it } from "vitest";
import {
  IntegrationManifestSchema,
  validateWriteFamilies,
} from "@withmarfa/shared";
import {
  DEFAULT_WRITE_FAMILY,
  EPISODE_BATCH_SIZE,
  MAX_EPISODES_PER_TICK,
  MAX_FEEDS_PER_TICK,
  PODCASTS_MANIFEST,
  WRITE_FAMILIES,
} from "./manifest.js";

describe("podcasts manifest", () => {
  it("parses against the canonical schema", () => {
    expect(() =>
      IntegrationManifestSchema.parse(PODCASTS_MANIFEST),
    ).not.toThrow();
  });

  it("reads only, on a schedule, with no reactive trigger", () => {
    expect(PODCASTS_MANIFEST.direction).toBe("read");
    expect(PODCASTS_MANIFEST.triggers.map((t) => t.type)).toEqual(["schedule"]);
  });

  it("requires no upstream credential, so a public feed needs no account", () => {
    // rss-watcher is the precedent: install treats credential_ref as
    // optional and nothing cross-checks the manifest.
    expect(PODCASTS_MANIFEST.oauth_requirements).toEqual({});
    expect(PODCASTS_MANIFEST.token_requirements).toBeUndefined();
  });

  it("declares write permission on the containment edge", () => {
    expect(PODCASTS_MANIFEST.permissions?.edge).toEqual({
      "in-collection": "write",
    });
  });

  // Family coherence — pairs travel together, the chooser derives from
  // the declared families — is validated centrally now that the manifest
  // can say it. This asserts the manifest passes that validation, not the
  // pairing itself.
  it("declares coherent write families", () => {
    expect(validateWriteFamilies(PODCASTS_MANIFEST)).toEqual([]);
    expect(
      PODCASTS_MANIFEST.configuration_schema?.write_family?.from_write_families,
    ).toBe(true);
    expect(PODCASTS_MANIFEST.write_families?.default).toBe(
      DEFAULT_WRITE_FAMILY,
    );
  });

  it("defaults to its own types rather than the core ones", () => {
    expect(DEFAULT_WRITE_FAMILY).toBe("podcast");
    expect(WRITE_FAMILIES.podcast.show).toBe("withmarfa.podcast.show");
    expect(WRITE_FAMILIES.core.episode).toBe("core.media.episode");
  });

  it("keeps a tick's batch well under its episode budget", () => {
    expect(EPISODE_BATCH_SIZE).toBeLessThan(MAX_EPISODES_PER_TICK);
    expect(MAX_FEEDS_PER_TICK).toBeGreaterThan(0);
  });

  it("ignores a disappearance rather than treating it as a deletion", () => {
    // A feed that drops an item and a feed that publishes only a recent
    // window look identical from here.
    expect(PODCASTS_MANIFEST.bidirectional_handling.tombstone_mapping).toBe(
      "ignore",
    );
  });
});
