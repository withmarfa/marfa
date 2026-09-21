import { describe, expect, it } from "vitest";
import { MarfaClient } from "./client.js";
import { path } from "./path.js";

describe("the path tag", () => {
  it("escapes every character that would change which route is addressed", () => {
    // `/` opens a segment, `?` a query string, `#` truncates the path into a
    // fragment. Each is the difference between the route the caller named and
    // one they did not.
    expect(path`/items/${"a/b"}`).toBe("/items/a%2Fb");
    expect(path`/items/${"a?b"}`).toBe("/items/a%3Fb");
    expect(path`/items/${"a#b"}`).toBe("/items/a%23b");
    expect(path`/items/${"a b"}`).toBe("/items/a%20b");
    expect(path`/items/${"a%b"}`).toBe("/items/a%25b");
  });

  it("leaves a UUIDv7 untouched, which is why no stored key changes shape", () => {
    // The ids this package actually carries encode to themselves, so a queued
    // write's path is byte-identical before and after this change and the
    // server's request fingerprint is unmoved.
    const id = "01a074bb-2676-7e7d-8ed0-b22cf41772f7";
    expect(path`/items/${id}`).toBe(`/items/${id}`);
  });

  it("escapes every interpolation, not only the first", () => {
    expect(path`/items/${"a/b"}/tags/${"c/d"}`).toBe("/items/a%2Fb/tags/c%2Fd");
  });
});

describe("an identifier cannot smuggle a query onto a real route", () => {
  /** Records the URL of every request the client makes. */
  function recordingClient(): { client: MarfaClient; urls: string[] } {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ item: { id: "x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    return {
      client: new MarfaClient({ url: "http://localhost", apiKey: "k", fetch }),
      urls,
    };
  }

  /** Runs a call for its request alone; what it answers is not the subject. */
  async function ignoringResult(work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch {
      // The stub answers a shape the client may reject. The assertion is about
      // the URL that left, which has already been recorded by then.
    }
  }

  it("puts a caller's question mark in the path, never in the query", async () => {
    // The sharp case. A `?` in an identifier used to split the path, and the
    // remainder became a query string on a route that is otherwise exactly the
    // one asked for -- so the request succeeded, carrying parameters the caller
    // never passed. Nothing threw, and the id is the kind of value that arrives
    // from outside.
    const { client, urls } = recordingClient();
    await ignoringResult(client.items.get("real-id?include=system&limit=500"));

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.search, "an identifier opened a query string").toBe("");
    expect(url.pathname).toContain("%3F");
    expect(url.pathname).toContain("real-id");
  });

  it("escapes the hash when it asks the server for a blob's link", async () => {
    // `blobs.url` asks `GET /blobs/{hash}/url` for a link, so an unescaped
    // separator in the caller's hash would address a different door.
    const { client, urls } = recordingClient();
    await ignoringResult(client.blobs.url("sha256:abc/../../admin/keys", 60));

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe(
      "/blobs/sha256%3Aabc%2F..%2F..%2Fadmin%2Fkeys/url",
    );
    expect(url.search).toBe("?ttl=60");
  });

  it("puts a caller's slash in the segment, never in the route", async () => {
    const { client, urls } = recordingClient();
    await ignoringResult(client.items.get("a/b"));

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/items/a%2Fb");
  });
});
