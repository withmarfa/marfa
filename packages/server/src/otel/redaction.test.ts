import { describe, it, expect } from "vitest";
import {
  redactAttributes,
  DENYLIST_EXACT,
  REDACT_SUBSTRINGS,
} from "./redaction.js";

/**
 * PII discipline for OpenTelemetry. `redactAttributes` is the gating
 * surface: if a denied key ever survives, this test fails loudly.
 * Keep-safe attributes must pass through untouched so traces/logs
 * stay useful.
 */
describe("redactAttributes — PII denylist", () => {
  it.each([...DENYLIST_EXACT])("drops exact-denied key %s", (key) => {
    const out = redactAttributes({ [key]: "sensitive", safe: "ok" });
    expect(out).not.toHaveProperty(key);
    expect(out.safe).toBe("ok");
  });

  it.each(REDACT_SUBSTRINGS)(
    "redacts the value of a key containing %s",
    (sub) => {
      const key = `marfa.${sub}.field`;
      const out = redactAttributes({ [key]: "leaked-value" });
      expect(out[key]).toBe("[REDACTED]");
    },
  );

  it("is case-insensitive on key matching", () => {
    const out = redactAttributes({
      "HTTP.Request.Header.Authorization": "Bearer x",
      "X-Custom-TOKEN": "abc",
    });
    expect(out).not.toHaveProperty("HTTP.Request.Header.Authorization");
    expect(out["X-Custom-TOKEN"]).toBe("[REDACTED]");
  });

  it("strips query strings on URL-valued attributes", () => {
    const out = redactAttributes({
      "url.full": "https://api.marfa.so/auth/magic?token=secret123",
      "http.url": "https://api.marfa.so/items?cursor=abc",
      "http.target": "/oauth/callback?code=xyz&state=q",
    });
    expect(out["url.full"]).toBe("https://api.marfa.so/auth/magic?[REDACTED]");
    expect(out["http.url"]).toBe("https://api.marfa.so/items?[REDACTED]");
    expect(out["http.target"]).toBe("/oauth/callback?[REDACTED]");
  });

  it("leaves query-less URLs intact", () => {
    const out = redactAttributes({ "http.url": "https://api.marfa.so/health" });
    expect(out["http.url"]).toBe("https://api.marfa.so/health");
  });

  it("keeps an inbound address to its last four characters", () => {
    const token = "Abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE";
    const out = redactAttributes({
      "url.full": `https://example.test/inbound/${token}?x=1`,
      "url.path": `/inbound/${token}`,
      "http.target": `/inbound/${token}`,
      "http.route": "/inbound/:token",
    });
    expect(out["url.full"]).toBe(
      "https://example.test/inbound/****BCDE?[REDACTED]",
    );
    expect(out["url.path"]).toBe("/inbound/****BCDE");
    expect(out["http.target"]).toBe("/inbound/****BCDE");
    expect(out["http.route"]).toBe("/inbound/:token");
    expect(
      redactAttributes({ "url.path": `/Inbound/${token}` })["url.path"],
    ).toBe("/inbound/****BCDE");
    // Escapes the router decodes before it matches are an address too.
    for (const spelled of [`/%69nbound/${token}`, `/inbound%2F${token}`]) {
      const out = redactAttributes({ "url.path": spelled })["url.path"];
      expect(out, spelled).toBe("/inbound/****BCDE");
    }
    expect(redactAttributes({ "url.path": "/items/a%20b" })["url.path"]).toBe(
      "/items/a%20b",
    );
  });

  it("redacts url.query entirely", () => {
    const out = redactAttributes({ "url.query": "token=secret&a=b" });
    expect(out["url.query"]).toBe("[REDACTED]");
  });

  it("keeps correlation + routing attributes untouched", () => {
    const safe = {
      "marfa.request_id": "req_123",
      "marfa.key_id": "key_789",
      "http.request.method": "POST",
      "http.route": "/items/:id",
      "http.response.status_code": 201,
      "error.code": "validation_error",
    };
    expect(redactAttributes(safe)).toEqual(safe);
  });

  it("keeps the OTel exception trio (error tracking needs them)", () => {
    const ex = {
      "exception.type": "TypeError",
      "exception.message": "cannot read x of undefined",
      "exception.stacktrace": "TypeError: ...\n  at foo",
    };
    expect(redactAttributes(ex)).toEqual(ex);
  });

  it("does not mutate the input", () => {
    const input = { "user.email": "a@b.com", keep: 1 };
    redactAttributes(input);
    expect(input).toEqual({ "user.email": "a@b.com", keep: 1 });
  });
});
