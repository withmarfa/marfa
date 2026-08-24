import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { INBOX_MANIFEST } from "./manifest.js";

describe("marfa/inbox manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(INBOX_MANIFEST);
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares webhook trigger + cloudflare-email verification", () => {
    expect(INBOX_MANIFEST.triggers).toEqual([{ type: "webhook" }]);
    expect(INBOX_MANIFEST.webhook_verification.method).toBe("cloudflare-email");
  });

  it("targets marfa.captured_email, read-only, no OAuth, no token", () => {
    expect(INBOX_MANIFEST.target_types).toEqual(["marfa.captured_email"]);
    expect(INBOX_MANIFEST.direction).toBe("read");
    expect(INBOX_MANIFEST.oauth_requirements).toEqual({});
    expect(INBOX_MANIFEST.token_requirements).toBeUndefined();
  });
});
