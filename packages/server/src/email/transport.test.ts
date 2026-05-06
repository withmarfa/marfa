import { describe, it, expect } from "vitest";
import { createEmailTransport } from "./index.js";
import { NoneTransport } from "./none-backend.js";
import { SenderDomainMismatchError } from "./sender-domain-check.js";

describe("createEmailTransport", () => {
  it("returns a NoneTransport when backend=none", async () => {
    const transport = await createEmailTransport({
      backend: "none",
      from: "Myme <hello@mail.myme.so>",
    });
    expect(transport.backend).toBe("none");
    expect(transport).toBeInstanceOf(NoneTransport);
  });

  it("NoneTransport.send always fails with email_transport_not_configured", async () => {
    const transport = await createEmailTransport({
      backend: "none",
      from: "Myme <hello@mail.myme.so>",
    });
    const result = await transport.send({
      to: "delivered@resend.dev",
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

  it("throws when backend=resend but apiKey missing", async () => {
    await expect(
      createEmailTransport({
        backend: "resend",
        from: "Myme <hello@mail.myme.so>",
      }),
    ).rejects.toThrow("RESEND_API_KEY_MYME");
  });

  it("throws when backend=smtp but host missing", async () => {
    await expect(
      createEmailTransport({
        backend: "smtp",
        from: "Myme <hello@mail.myme.so>",
      }),
    ).rejects.toThrow("MYME_SMTP_HOST");
  });

  // Note: sender-domain check skips when NODE_ENV is "test", so the
  // SenderDomainMismatchError path is covered in
  // sender-domain-check.test.ts directly.
  it("skips sender-domain check in NODE_ENV=test", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    // Resend backend with a non-mail.myme.so from would otherwise
    // throw SenderDomainMismatchError. In test env it just throws on
    // the missing apiKey, not on the domain.
    await expect(
      createEmailTransport({
        backend: "resend",
        from: "test@example.com",
        resend: { apiKey: "" },
      }),
    ).rejects.toThrow("RESEND_API_KEY_MYME");
  });

  // Sanity check: SenderDomainMismatchError is exported for callers
  // who want to catch + prompt config-fix.
  it("exposes SenderDomainMismatchError", () => {
    expect(SenderDomainMismatchError).toBeDefined();
  });
});
