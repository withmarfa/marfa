import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { ADAPTERS, isVerificationMethod } from "./index.js";

const SECRET = "topsecret-shared-key";

describe("verification adapter dispatch", () => {
  it("isVerificationMethod accepts the four known methods", () => {
    for (const m of ["hmac-sha256", "slack", "stripe", "github"]) {
      expect(isVerificationMethod(m)).toBe(true);
    }
  });

  it("isVerificationMethod rejects unknown methods (incl. dropped 'custom')", () => {
    expect(isVerificationMethod("custom")).toBe(false);
    expect(isVerificationMethod("rot13")).toBe(false);
    expect(isVerificationMethod("")).toBe(false);
  });

  it("ADAPTERS table has an entry for every method", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([
      "github",
      "hmac-sha256",
      "slack",
      "stripe",
    ]);
  });
});

describe("hmac-sha256 adapter", () => {
  const adapter = ADAPTERS["hmac-sha256"];
  const body = Buffer.from('{"hello":"world"}');

  it("verifies a correctly signed payload", () => {
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const headers = new Headers({ "X-Myme-Signature": `sha256=${sig}` });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(true);
  });

  it("accepts a bare hex signature without the sha256= prefix", () => {
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const headers = new Headers({ "X-Myme-Signature": sig });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const headers = new Headers({ "X-Myme-Signature": `sha256=${sig}` });
    const tamperedBody = Buffer.from('{"hello":"WORLD"}');
    const result = adapter(tamperedBody, headers, SECRET);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("mismatch");
  });

  it("rejects when the signature header is missing", () => {
    const result = adapter(body, new Headers(), SECRET);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("missing");
  });

  it("rejects the legacy X-Signature header (canonical is X-Myme-Signature)", () => {
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const headers = new Headers({ "X-Signature": `sha256=${sig}` });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("missing");
  });

  it("rejects a malformed (non-hex) signature", () => {
    const headers = new Headers({ "X-Myme-Signature": "sha256=NOTHEX!" });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(false);
  });

  it("surfaces X-Myme-Delivery-Id when present", () => {
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const headers = new Headers({
      "X-Myme-Signature": `sha256=${sig}`,
      "X-Myme-Delivery-Id": "d-12345",
    });
    const result = adapter(body, headers, SECRET);
    expect(result.external_delivery_id).toBe("d-12345");
  });
});

describe("slack adapter", () => {
  const adapter = ADAPTERS.slack;
  const body = Buffer.from("token=abc&team_id=T123");

  function buildSlackHeaders(timestamp: string, sig: string): Headers {
    return new Headers({
      "X-Slack-Signature": sig,
      "X-Slack-Request-Timestamp": timestamp,
    });
  }

  function expectedSlackSig(ts: string, b: Buffer): string {
    return (
      "v0=" +
      createHmac("sha256", SECRET)
        .update(`v0:${ts}:${b.toString("utf8")}`)
        .digest("hex")
    );
  }

  it("verifies a fresh, correctly signed request", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = expectedSlackSig(ts, body);
    const result = adapter(body, buildSlackHeaders(ts, sig), SECRET);
    expect(result.verified).toBe(true);
  });

  it("rejects a request whose timestamp is outside the 5-min replay window", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 30); // 30 min old
    const sig = expectedSlackSig(ts, body);
    const result = adapter(body, buildSlackHeaders(ts, sig), SECRET);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("replay");
  });

  it("rejects a request with a tampered body", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = expectedSlackSig(ts, body);
    const result = adapter(
      Buffer.from("tampered"),
      buildSlackHeaders(ts, sig),
      SECRET,
    );
    expect(result.verified).toBe(false);
  });

  it("rejects when X-Slack-Signature is missing", () => {
    const result = adapter(body, new Headers(), SECRET);
    expect(result.verified).toBe(false);
  });

  it("rejects when X-Slack-Request-Timestamp is missing", () => {
    const result = adapter(
      body,
      new Headers({ "X-Slack-Signature": "v0=00" }),
      SECRET,
    );
    expect(result.verified).toBe(false);
  });
});

describe("stripe adapter", () => {
  const adapter = ADAPTERS.stripe;
  const body = Buffer.from('{"id":"evt_123","type":"charge.succeeded"}');

  function buildStripeHeader(ts: string, body: Buffer): string {
    const sig = createHmac("sha256", SECRET)
      .update(`${ts}.${body.toString("utf8")}`)
      .digest("hex");
    return `t=${ts},v1=${sig}`;
  }

  it("verifies a correctly-signed payload", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = new Headers({
      "Stripe-Signature": buildStripeHeader(ts, body),
    });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(true);
    expect(result.external_delivery_id).toBeDefined();
  });

  it("rejects when the timestamp is outside the replay window", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 30);
    const headers = new Headers({
      "Stripe-Signature": buildStripeHeader(ts, body),
    });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("replay");
  });

  it("rejects a malformed Stripe-Signature", () => {
    const headers = new Headers({ "Stripe-Signature": "garbage" });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(false);
  });

  it("rejects a missing Stripe-Signature header", () => {
    const result = adapter(body, new Headers(), SECRET);
    expect(result.verified).toBe(false);
  });
});

describe("github adapter", () => {
  const adapter = ADAPTERS.github;
  const body = Buffer.from('{"action":"opened","number":1}');

  it("verifies a correctly-signed payload", () => {
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const headers = new Headers({
      "X-Hub-Signature-256": `sha256=${sig}`,
      "X-GitHub-Delivery": "abc-def-123",
    });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(true);
    expect(result.external_delivery_id).toBe("abc-def-123");
  });

  it("rejects a payload signed with the wrong secret", () => {
    const sig = createHmac("sha256", "wrong-secret").update(body).digest("hex");
    const headers = new Headers({
      "X-Hub-Signature-256": `sha256=${sig}`,
    });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const headers = new Headers({ "X-Hub-Signature-256": sig });
    const result = adapter(body, headers, SECRET);
    expect(result.verified).toBe(false);
  });

  it("rejects when the header is absent", () => {
    const result = adapter(body, new Headers(), SECRET);
    expect(result.verified).toBe(false);
  });
});
