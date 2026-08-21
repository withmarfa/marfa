import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { READWISE_MANIFEST } from "./manifest.js";

describe("Readwise manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(READWISE_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares only a schedule trigger (inbound-only)", () => {
    const types = READWISE_MANIFEST.triggers.map((t) => t.type);
    expect(types).toEqual(["schedule"]);
  });

  it("is inbound-only (direction: read)", () => {
    expect(READWISE_MANIFEST.direction).toBe("read");
  });

  it("declares token_requirements for the readwise capability", () => {
    expect(READWISE_MANIFEST.token_requirements).toEqual({
      readwise: "required",
    });
    expect(READWISE_MANIFEST.manifest_schema_version).toMatch(/^2\./);
  });

  it("declares no OAuth requirements", () => {
    expect(READWISE_MANIFEST.oauth_requirements).toEqual({});
  });

  it("targets readwise.highlight + readwise.book", () => {
    expect(READWISE_MANIFEST.target_types).toEqual([
      "readwise.highlight",
      "readwise.book",
    ]);
  });

  it("grants parent-of edge write permission to the runtime credential", () => {
    expect(READWISE_MANIFEST.permissions?.edge).toEqual({
      "parent-of": "write",
    });
  });

  it("declares tombstone_mapping: ignore (read-only — never propagate deletes)", () => {
    expect(READWISE_MANIFEST.bidirectional_handling.tombstone_mapping).toBe(
      "ignore",
    );
  });
});
