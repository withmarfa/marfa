import { describe, it, expect } from "vitest";
import { createEmailTransport } from "./index.js";
import { NoneTransport } from "./none-backend.js";
import { SenderDomainMismatchError } from "./sender-domain-check.js";

describe("createEmailTransport", () => {
  it("returns a NoneTransport when backend=none", async () => {
    const transport = await createEmailTransport({
      backend: "none",
      from: "Marfa <hello@mail.marfa.so>",
    });
    expect(transport.backend).toBe("none");
    expect(transport).toBeInstanceOf(NoneTransport);
  });

  it("NoneTransport.send always fails with email_transport_not_configured", async () => {
    const transport = await createEmailTransport({
      backend: "none",
      from: "Marfa <hello@mail.marfa.so>",
    });
    const result = await transport.send({
      to: "test@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
      idempotencyKey: "test/1",
    });
    expect(result).toEqual({
      ok: false,
      error: "email_transport_not_configured",
      retryable: false,
    });
  });

  it("throws when backend=cloudflare but accountId missing", async () => {
    await expect(
      createEmailTransport({
        backend: "cloudflare",
        from: "Marfa <hello@mail.marfa.so>",
        cloudflare: { accountId: "", apiToken: "tok" },
      }),
    ).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN");
  });

  it("throws when backend=cloudflare but apiToken missing", async () => {
    await expect(
      createEmailTransport({
        backend: "cloudflare",
        from: "Marfa <hello@mail.marfa.so>",
        cloudflare: { accountId: "acct", apiToken: "" },
      }),
    ).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN");
  });

  it("builds a CloudflareTransport when both creds present", async () => {
    const transport = await createEmailTransport({
      backend: "cloudflare",
      from: "Marfa <hello@mail.marfa.so>",
      cloudflare: { accountId: "acct_123", apiToken: "tok_456" },
    });
    expect(transport.backend).toBe("cloudflare");
  });

  it("throws when backend=smtp but host missing", async () => {
    await expect(
      createEmailTransport({
        backend: "smtp",
        from: "Marfa <hello@mail.marfa.so>",
      }),
    ).rejects.toThrow("MARFA_SMTP_HOST");
  });

  // Note: sender-domain check skips when NODE_ENV is "test", so the
  // SenderDomainMismatchError path is covered in
  // sender-domain-check.test.ts directly.
  it("skips sender-domain check in NODE_ENV=test", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    // Cloudflare backend with a non-mail.marfa.so from would otherwise
    // throw SenderDomainMismatchError. In test env it just throws on
    // the missing creds, not on the domain.
    await expect(
      createEmailTransport({
        backend: "cloudflare",
        from: "test@example.com",
        cloudflare: { accountId: "", apiToken: "" },
      }),
    ).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN");
  });

  // Sanity check: SenderDomainMismatchError is exported for callers
  // who want to catch + prompt config-fix.
  it("exposes SenderDomainMismatchError", () => {
    expect(SenderDomainMismatchError).toBeDefined();
  });
});
