import { describe, it, expect } from "vitest";
import {
  checkSenderDomain,
  SenderDomainMismatchError,
} from "./sender-domain-check.js";

describe("checkSenderDomain", () => {
  it("passes when Resend backend uses a verified mail.myme.so address", () => {
    expect(() => {
      checkSenderDomain({
        backend: "resend",
        from: "Myme <hello@mail.myme.so>",
        skip: false,
      });
    }).not.toThrow();
  });

  it("passes for a bare-address form ending in mail.myme.so", () => {
    expect(() => {
      checkSenderDomain({
        backend: "resend",
        from: "noreply@mail.myme.so",
        skip: false,
      });
    }).not.toThrow();
  });

  it("throws SenderDomainMismatchError on apex myme.so for Resend", () => {
    expect(() => {
      checkSenderDomain({
        backend: "resend",
        from: "Myme <hello@myme.so>",
        skip: false,
      });
    }).toThrow(SenderDomainMismatchError);
  });

  it("throws on an unrelated domain for Resend", () => {
    expect(() => {
      checkSenderDomain({
        backend: "resend",
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
        backend: "resend",
        from: "test@bad-domain.com",
        skip: true,
      });
    }).not.toThrow();
  });
});
