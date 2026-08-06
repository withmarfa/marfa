import { describe, it, expect } from "vitest";
import {
  IntegrationManifestSchema,
  validateConnectionConfiguration,
} from "@withmarfa/shared";
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

  // The handler reads `archive_after_days`, and the configuration contract
  // refuses any key the manifest does not declare. An integration that reads
  // a key it never declares therefore cannot be configured at all — the one
  // knob it has is refused at install.
  it("declares the only configuration key the handler reads", () => {
    const declared = TASK_AUTO_ARCHIVE_MANIFEST.configuration_schema ?? {};
    expect(Object.keys(declared)).toContain("archive_after_days");
    expect(declared.archive_after_days?.type).toBe("number");
    expect(declared.archive_after_days?.default).toBe(
      DEFAULT_ARCHIVE_AFTER_DAYS,
    );
  });

  it("accepts a supplied archive_after_days through the configuration contract", () => {
    const issues = validateConnectionConfiguration(
      TASK_AUTO_ARCHIVE_MANIFEST,
      { archive_after_days: 7 },
      { requireRequired: true },
    );
    expect(issues).toEqual([]);
  });

  it("still refuses a key the integration does not read", () => {
    const issues = validateConnectionConfiguration(TASK_AUTO_ARCHIVE_MANIFEST, {
      archive_after_hours: 7,
    });
    expect(issues.map((i) => i.key)).toEqual(["archive_after_hours"]);
  });
});
