import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
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

  // The manifest schema has no way to say "these target types are chosen
  // together", so the pairing is asserted here instead. Without this a
  // family could name a type the credential is not permitted to write.
  it("every write family names types the manifest actually targets", () => {
    for (const [family, pair] of Object.entries(WRITE_FAMILIES)) {
      expect(PODCASTS_MANIFEST.target_types, `${family}.show`).toContain(
        pair.show,
      );
      expect(PODCASTS_MANIFEST.target_types, `${family}.episode`).toContain(
        pair.episode,
      );
    }
  });

  it("offers exactly the families the configuration lets a connection pick", () => {
    const values = PODCASTS_MANIFEST.configuration_schema?.write_family?.values;
    expect(new Set(values)).toEqual(new Set(Object.keys(WRITE_FAMILIES)));
    expect(PODCASTS_MANIFEST.configuration_schema?.write_family?.default).toBe(
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
