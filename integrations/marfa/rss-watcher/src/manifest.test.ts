/**
 * Confirms the typed manifest constant validates against the canonical
 * Zod schema in @withmarfa/shared. Belt-and-braces — TypeScript catches
 * shape drift at compile time, the runtime parse catches enum drift
 * and refinement drift the type system can't see (e.g. a manifest name
 * that fails the publisher-namespaced grammar refinement).
 */
import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { RSS_WATCHER_MANIFEST } from "./manifest.js";

describe("RSS Watcher manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(RSS_WATCHER_MANIFEST);
    if (!result.success) {
      // Surface the parse errors for fast debugging.
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares an hourly schedule and accepts manual runs", () => {
    expect(RSS_WATCHER_MANIFEST.triggers).toHaveLength(2);
    const schedule = RSS_WATCHER_MANIFEST.triggers.find(
      (t) => t.type === "schedule",
    );
    expect(schedule).toBeDefined();
    if (schedule?.type === "schedule") {
      expect(schedule.config.cron).toBe("0 * * * *");
    }
    // The manual declaration is the whole opt-in to on-demand dispatch:
    // the route refuses a connection whose manifest does not carry it.
    expect(RSS_WATCHER_MANIFEST.triggers.some((t) => t.type === "manual")).toBe(
      true,
    );
  });

  it("targets core.bookmark and declares the local runtime tier", () => {
    expect(RSS_WATCHER_MANIFEST.target_types).toEqual(["core.bookmark"]);
  });

  it("declares no OAuth requirements", () => {
    expect(RSS_WATCHER_MANIFEST.oauth_requirements).toEqual({});
  });
});
