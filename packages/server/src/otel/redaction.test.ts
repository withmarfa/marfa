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

describe("redactAttributes — a failed query", () => {
  const VALUE = "bound-value-3e9d51c0";
  const STATEMENT =
    'Failed query: insert into "items" ("properties") values (?)';
  const MESSAGE = `${STATEMENT}\nparams: ${VALUE}`;
  const FRAMES =
    "\n    at run (/srv/app.ts:1:1)\n    at tick (/srv/app.ts:2:2)";
  const FIXED = "Database operation failed";

  it("replaces the statement and values of an exception event's message and stack, and keeps the frames", () => {
    // The witness: the input does carry the value, so the absence below is the rule at work.
    const input = {
      "exception.type": "Error",
      "exception.message": MESSAGE,
      "exception.stacktrace": `Error: ${MESSAGE}${FRAMES}`,
    };
    expect(JSON.stringify(input)).toContain(VALUE);

    const out = redactAttributes(input);

    expect(out["exception.message"]).toBe(FIXED);
    expect(out["exception.stacktrace"]).toBe(`Error: ${FIXED}${FRAMES}`);
    expect(out["exception.type"]).toBe("Error");
    expect(JSON.stringify(out)).not.toContain(VALUE);
    expect(JSON.stringify(out)).not.toContain(STATEMENT);
  });

  it("reaches a value nested in a log record's serialized error, and one inside an array", () => {
    const input = {
      error_detail: {
        message: MESSAGE,
        cause: { message: "SQLITE_FULL", stack: `Error: ${MESSAGE}${FRAMES}` },
      },
      lines: [MESSAGE, 7, null],
    };
    expect(JSON.stringify(input)).toContain(VALUE);

    const out = redactAttributes(input);

    expect(JSON.stringify(out)).not.toContain(VALUE);
    expect(JSON.stringify(out)).not.toContain(STATEMENT);
    expect(out.lines).toEqual([FIXED, 7, null]);
  });

  it("leaves other values as they were, bytes and numbers included", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = redactAttributes({
      bytes,
      count: 3,
      flag: true,
      note: "plain",
    });
    expect(out).toEqual({ bytes, count: 3, flag: true, note: "plain" });
  });
});
