import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@mymehq/shared";
import { GITHUB_WEBHOOKS_MANIFEST } from "./manifest.js";

describe("GitHub Webhooks manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(
      GITHUB_WEBHOOKS_MANIFEST,
    );
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares webhook trigger and github verification adapter", () => {
    expect(GITHUB_WEBHOOKS_MANIFEST.triggers).toEqual([{ type: "webhook" }]);
    expect(GITHUB_WEBHOOKS_MANIFEST.webhook_verification.method).toBe("github");
  });

  it("targets core.bookmark, read-only, no OAuth", () => {
    expect(GITHUB_WEBHOOKS_MANIFEST.target_types).toEqual(["core.bookmark"]);
    expect(GITHUB_WEBHOOKS_MANIFEST.direction).toBe("read");
    expect(GITHUB_WEBHOOKS_MANIFEST.oauth_requirements).toEqual({});
  });
});
