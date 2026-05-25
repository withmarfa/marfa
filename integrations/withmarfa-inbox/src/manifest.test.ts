import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { MYMEHQ_INBOX_MANIFEST } from "./manifest.js";

describe("withmarfa.inbox manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(MYMEHQ_INBOX_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares webhook trigger + cloudflare-email verification", () => {
    expect(MYMEHQ_INBOX_MANIFEST.triggers).toEqual([{ type: "webhook" }]);
    expect(MYMEHQ_INBOX_MANIFEST.webhook_verification.method).toBe(
      "cloudflare-email",
    );
  });

  it("targets withmarfa.captured_email, read-only, no OAuth, no token", () => {
    expect(MYMEHQ_INBOX_MANIFEST.target_types).toEqual([
      "withmarfa.captured_email",
    ]);
    expect(MYMEHQ_INBOX_MANIFEST.direction).toBe("read");
    expect(MYMEHQ_INBOX_MANIFEST.oauth_requirements).toEqual({});
    expect(MYMEHQ_INBOX_MANIFEST.token_requirements).toBeUndefined();
  });
});
