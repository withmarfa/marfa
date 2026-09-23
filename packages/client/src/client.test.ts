import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  ContractMismatchError,
  createClient,
  pages,
  type Page,
} from "./index.js";

/** A server that answers the root with `contract` and every other path
 *  with an empty page, recording what it was asked. */
function stubServer(contract: unknown) {
  const seen: { url: string; authorization: string | null }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({
      url: new URL(request.url).pathname,
      authorization: request.headers.get("Authorization"),
    });
    const body =
      new URL(request.url).pathname === "/"
        ? { name: "marfa", contract }
        : { data: [], next_cursor: null };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { seen, fetch: fetch as typeof globalThis.fetch };
}

describe("the contract gate", () => {
  it("refuses a server advertising another contract, and sends it nothing else", async () => {
    const server = stubServer(CONTRACT_VERSION + 1);
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    await expect(client.GET("/edge-types")).rejects.toBeInstanceOf(
      ContractMismatchError,
    );
    expect(server.seen.map((r) => r.url)).toEqual(["/"]);
  });

  it("proceeds against a server on its contract, reading the root once, with the bearer", async () => {
    // The witness: the same client against the contract it was generated for.
    const server = stubServer(CONTRACT_VERSION);
    const client = createClient({
      baseUrl: "https://marfa.example/",
      credential: "k",
      fetch: server.fetch,
    });
    const first = await client.GET("/edge-types");
    const second = await client.GET("/edge-types");
    expect(first.data).toEqual({ data: [], next_cursor: null });
    expect(second.response.ok).toBe(true);
    expect(server.seen.map((r) => r.url)).toEqual([
      "/",
      "/edge-types",
      "/edge-types",
    ]);
    expect(server.seen.slice(1).map((r) => r.authorization)).toEqual([
      "Bearer k",
      "Bearer k",
    ]);
  });
});

describe("pages", () => {
  const stub = (answers: Page<string>[]) => {
    const asked: (string | undefined)[] = [];
    return {
      asked,
      fetch: (cursor: string | undefined) => {
        asked.push(cursor);
        const page = answers[asked.length - 1];
        if (!page) throw new Error("asked past the end");
        return Promise.resolve(page);
      },
    };
  };

  it("walks past an empty page that carries a cursor, and stops on null", async () => {
    const source = stub([
      { data: ["a"], next_cursor: "c1" },
      { data: [], next_cursor: "c2" },
      { data: ["b"], next_cursor: null },
    ]);
    const rows: string[] = [];
    for await (const row of pages(source.fetch)) rows.push(row);
    expect(rows).toEqual(["a", "b"]);
    expect(source.asked).toEqual([undefined, "c1", "c2"]);
  });

  it("refuses a cursor answered back unchanged", async () => {
    const source = stub([
      { data: ["a"], next_cursor: "c1" },
      { data: ["a"], next_cursor: "c1" },
    ]);
    const walk = async () => {
      for await (const _ of pages(source.fetch)) void _;
    };
    await expect(walk()).rejects.toThrow(/would not end/);
  });
});
