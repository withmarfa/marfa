/**
 * Confirms the template manifest constant validates against the canonical
 * Zod schema in @mymehq/shared. Belt-and-braces — TypeScript catches
 * shape drift at compile time, the runtime parse catches enum drift
 * and refinement drift the type system can't see (e.g. a tombstone
 * mapping enum that the schema later renames).
 *
 * The template is the file every contributor copy-pastes when scaffolding
 * a new Integration; keeping its manifest schema-valid prevents broken
 * scaffolding from propagating into real Integrations. (§2.3 was the
 * direct cause: four shape errors went undetected for a release because
 * the template was the only Integration without a manifest.test.ts.)
 */
import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@mymehq/shared";
import { TEMPLATE_MANIFEST } from "./manifest.js";

describe("Template manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(TEMPLATE_MANIFEST);
    if (!result.success) {
      // Surface the parse errors for fast debugging.
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares a single 5-minute schedule trigger", () => {
    expect(TEMPLATE_MANIFEST.triggers).toHaveLength(1);
    const trigger = TEMPLATE_MANIFEST.triggers[0];
    expect(trigger.type).toBe("schedule");
    expect(trigger.config.cron).toBe("*/5 * * * *");
  });

  it("targets core.note and runs on both hosted and local tiers", () => {
    expect(TEMPLATE_MANIFEST.target_types).toEqual(["core.note"]);
    expect(TEMPLATE_MANIFEST.runtime_compatibility).toEqual([
      "hosted",
      "local",
    ]);
  });

  it("declares no OAuth requirements", () => {
    expect(TEMPLATE_MANIFEST.oauth_requirements).toEqual({});
  });

  it("uses canonical bidirectional-handling enum values", () => {
    expect(TEMPLATE_MANIFEST.bidirectional_handling.tombstone_mapping).toBe(
      "state-trashed",
    );
    expect(TEMPLATE_MANIFEST.bidirectional_handling.partial_write_mode).toBe(
      "all-or-nothing",
    );
  });

  it("uses the discriminated webhook_verification method (not type)", () => {
    expect(TEMPLATE_MANIFEST.webhook_verification).toEqual({
      method: "hmac-sha256",
    });
  });
});
