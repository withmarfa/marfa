import { describe, it, expect } from "vitest";
import {
  checkSenderDomain,
  SenderDomainMismatchError,
} from "./sender-domain-check.js";

describe("checkSenderDomain", () => {
  it("passes when Cloudflare backend uses a verified mail.marfa.so address", () => {
    expect(() => {
      checkSenderDomain({
        backend: "cloudflare",
        from: "Marfa <hello@mail.marfa.so>",
        skip: false,
      });
    }).not.toThrow();
  });

  it("passes for a bare-address form ending in mail.marfa.so", () => {
    expect(() => {
      checkSenderDomain({
        backend: "cloudflare",
        from: "noreply@mail.marfa.so",
        skip: false,
      });
    }).not.toThrow();
  });

  it("throws SenderDomainMismatchError on apex marfa.so for Cloudflare", () => {
    expect(() => {
      checkSenderDomain({
        backend: "cloudflare",
        from: "Marfa <hello@marfa.so>",
        skip: false,
      });
    }).toThrow(SenderDomainMismatchError);
  });

  it("throws on an unrelated domain for Cloudflare", () => {
    expect(() => {
      checkSenderDomain({
        backend: "cloudflare",
        from: "test@example.com",
        skip: false,
      });
    }).toThrow(SenderDomainMismatchError);
  });

  it("does not check SMTP backend (operator owns the domain)", () => {
    expect(() => {
      checkSenderDomain({
        backend: "smtp",
        from: "test@example.com",
        skip: false,
      });
    }).not.toThrow();
  });

  it("does not check the none backend", () => {
    expect(() => {
      checkSenderDomain({
        backend: "none",
        from: "anything@anywhere",
        skip: false,
      });
    }).not.toThrow();
  });

  it("respects skip=true", () => {
    expect(() => {
      checkSenderDomain({
        backend: "cloudflare",
        from: "test@bad-domain.com",
        skip: true,
      });
    }).not.toThrow();
  });
});
