import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@mymehq/shared";
import {
  TASK_AUTO_ARCHIVE_MANIFEST,
  DEFAULT_ARCHIVE_AFTER_DAYS,
} from "./manifest.js";

describe("Task Auto-Archive manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(
      TASK_AUTO_ARCHIVE_MANIFEST,
    );
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares both item-event and schedule triggers", () => {
    const types = TASK_AUTO_ARCHIVE_MANIFEST.triggers.map((t) => t.type);
    expect(types).toContain("item-event");
    expect(types).toContain("schedule");
  });

  it("targets core.task and writes (no OAuth)", () => {
    expect(TASK_AUTO_ARCHIVE_MANIFEST.target_types).toEqual(["core.task"]);
    expect(TASK_AUTO_ARCHIVE_MANIFEST.direction).toBe("write");
    expect(TASK_AUTO_ARCHIVE_MANIFEST.oauth_requirements).toEqual({});
  });

  it("default archive_after_days is 30", () => {
    expect(DEFAULT_ARCHIVE_AFTER_DAYS).toBe(30);
  });
});
