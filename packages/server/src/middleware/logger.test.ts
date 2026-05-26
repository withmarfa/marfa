import { describe, expect, it } from "vitest";
import { resolveRequestId } from "./logger.js";
import { isValidId } from "@withmarfa/shared";

// ---------------------------------------------------------------------------
// resolveRequestId — client passthrough with validation
// ---------------------------------------------------------------------------

describe("resolveRequestId", () => {
  it("generates a UUIDv7 when the client sends no header", () => {
    const id = resolveRequestId(undefined);
    expect(isValidId(id)).toBe(true);
  });

  it("generates a UUIDv7 when the client sends an empty string", () => {
    const id = resolveRequestId("");
    expect(isValidId(id)).toBe(true);
  });

  it("passes through a client-provided UUIDv7 verbatim", () => {
    // Matches the shape stamped by the Swift SDK's URLSessionTransport
    // (UUIDv7.generateString()).
    const clientId = "019d1234-5678-7abc-8def-1234567890ab";
    expect(resolveRequestId(clientId)).toBe(clientId);
  });

  it("passes through alphanumeric correlation IDs from third-party tooling", () => {
    // Datadog-style trace ID — pure digits, within the length cap.
    expect(resolveRequestId("1234567890123456")).toBe("1234567890123456");
    // GitHub-style action run ID with dashes.
    expect(resolveRequestId("run-abc123_xyz")).toBe("run-abc123_xyz");
  });

  it("rejects headers with unsafe characters (newlines, spaces, slashes)", () => {
    // Newlines would log-inject; spaces would break log grep patterns.
    for (const bad of [
      "abc\ndef",
      "abc def",
      "abc/def",
      "abc;def",
      'abc"def',
      "<script>alert(1)</script>",
    ]) {
      const resolved = resolveRequestId(bad);
      expect(resolved).not.toBe(bad);
      expect(isValidId(resolved)).toBe(true);
    }
  });

  it("rejects headers longer than 128 characters", () => {
    const longId = "a".repeat(129);
    const resolved = resolveRequestId(longId);
    expect(resolved).not.toBe(longId);
    expect(isValidId(resolved)).toBe(true);
  });

  it("accepts a header exactly at the 128-character cap", () => {
    const capId = "a".repeat(128);
    expect(resolveRequestId(capId)).toBe(capId);
  });
});
