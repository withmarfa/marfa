import { describe, expect, it } from "vitest";
import {
  PODCAST_INDEX_USER_AGENT,
  enrichmentAvailable,
  readCredentials,
  signRequest,
} from "./podcast-index.js";

describe("podcast index signing", () => {
  // sha1("keysecret1700000000"), computed independently with shasum and
  // with Python rather than by running this code. The scheme is key +
  // secret + seconds concatenated, with no delimiters between them.
  it("signs with a digest over key, secret and timestamp", async () => {
    const headers = await signRequest(
      { key: "key", secret: "secret" },
      1_700_000_000_000,
    );
    expect(headers.Authorization).toBe(
      "abaf71c02050c31e4d4e6b08c1625173af0445ba",
    );
  });

  it("stamps seconds, not milliseconds", async () => {
    // A millisecond stamp reads upstream as a moment fifty thousand years
    // away and fails as an expiry rather than as a format error, which is
    // unusually hard to recognize from the response.
    const headers = await signRequest(
      { key: "k", secret: "s" },
      1_700_000_000_123,
    );
    expect(headers["X-Auth-Date"]).toBe("1700000000");
  });

  it("puts the same timestamp in the header as in the digest", async () => {
    const a = await signRequest({ key: "k", secret: "s" }, 1_700_000_000_000);
    const b = await signRequest({ key: "k", secret: "s" }, 1_700_000_000_999);
    expect(a["X-Auth-Date"]).toBe(b["X-Auth-Date"]);
    expect(a.Authorization).toBe(b.Authorization);
  });

  it("identifies itself, because generic agents are refused upstream", async () => {
    const headers = await signRequest({ key: "k", secret: "s" }, 0);
    expect(headers["User-Agent"]).toBe(PODCAST_INDEX_USER_AGENT);
    expect(headers["User-Agent"]).not.toMatch(/^(curl|python|node)/i);
  });

  it("sends the key alongside the digest", async () => {
    const headers = await signRequest({ key: "the-key", secret: "s" }, 0);
    expect(headers["X-Auth-Key"]).toBe("the-key");
  });
});

describe("enrichment gate", () => {
  it("needs both halves, because a key alone cannot sign anything", () => {
    expect(readCredentials({ PODCASTINDEX_API_KEY: "k" })).toBeNull();
    expect(readCredentials({ PODCASTINDEX_API_SECRET: "s" })).toBeNull();
    expect(readCredentials({})).toBeNull();
    expect(
      readCredentials({
        PODCASTINDEX_API_KEY: "  ",
        PODCASTINDEX_API_SECRET: "s",
      }),
    ).toBeNull();
  });

  it("is available only with both", () => {
    const creds = readCredentials({
      PODCASTINDEX_API_KEY: "k",
      PODCASTINDEX_API_SECRET: "s",
    });
    expect(creds).toEqual({ key: "k", secret: "s" });
    expect(enrichmentAvailable(creds)).toBe(true);
    expect(enrichmentAvailable(null)).toBe(false);
  });
});
