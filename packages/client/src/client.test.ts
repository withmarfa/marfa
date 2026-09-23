import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  ContractMismatchError,
  ContractUnreadableError,
  createClient,
  pages,
  type Page,
} from "./index.js";

/** A server that answers the root with `contract` and every other path
 *  with an empty page, recording what it was asked. */
function stubServer(
  contract: unknown,
  root?: (init?: RequestInit) => Response | Promise<Response>,
  rootPath = "/",
) {
  const seen: { url: string; authorization: string | null }[] = [];
  const redirects: Request["redirect"][] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    redirects.push(request.redirect);
    seen.push({
      url: new URL(request.url).pathname,
      authorization: request.headers.get("Authorization"),
    });
    if (new URL(request.url).pathname === rootPath && root) {
      return Promise.resolve(root(init));
    }
    const body =
      new URL(request.url).pathname === rootPath
        ? { name: "marfa", contract }
        : { data: [], next_cursor: null };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { seen, redirects, fetch };
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
    expect(server.seen).toEqual([{ url: "/", authorization: null }]);
  });

  it("reads the root without the credential, once for concurrent first requests", async () => {
    const server = stubServer(CONTRACT_VERSION);
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    await Promise.all([
      client.GET("/edge-types"),
      client.GET("/edge-types"),
      client.GET("/edge-types"),
    ]);
    expect(server.seen[0]).toEqual({ url: "/", authorization: null });
    expect(server.seen.filter((r) => r.url === "/")).toHaveLength(1);
  });

  it("asks again after a check that failed, rather than remembering it as a pass", async () => {
    let refusals = 1;
    const server = stubServer(CONTRACT_VERSION, () =>
      refusals-- > 0
        ? new Response("<html>bad gateway</html>", { status: 502 })
        : Response.json({ contract: CONTRACT_VERSION }),
    );
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    const refused = client.GET("/edge-types");
    await expect(refused).rejects.toBeInstanceOf(ContractUnreadableError);
    await expect(refused).rejects.toMatchObject({ status: 502 });
    const answered = await client.GET("/edge-types");
    expect(answered.response.ok).toBe(true);
    expect(server.seen.map((r) => r.url)).toEqual(["/", "/", "/edge-types"]);
  });

  it("reads a contract of another type as another contract", async () => {
    const server = stubServer(String(CONTRACT_VERSION));
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    await expect(client.GET("/edge-types")).rejects.toThrow(
      `serves contract "${String(CONTRACT_VERSION)}"`,
    );
  });

  it("sends nothing to a base URL other than its own", async () => {
    const server = stubServer(CONTRACT_VERSION);
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    await expect(
      client.GET("/edge-types", { baseUrl: "https://elsewhere.example" }),
    ).rejects.toThrow(/refuses to send/);
    expect(server.seen).toEqual([]);
  });

  it("holds every concurrent first request until the check refuses them", async () => {
    const server = stubServer(
      CONTRACT_VERSION + 1,
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve(Response.json({ contract: CONTRACT_VERSION + 1 }));
          }, 20),
        ),
    );
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    const answers = await Promise.allSettled([
      client.GET("/edge-types"),
      client.GET("/edge-types"),
      client.GET("/edge-types"),
    ]);
    expect(answers.every((a) => a.status === "rejected")).toBe(true);
    expect(server.seen).toEqual([{ url: "/", authorization: null }]);
  });

  it("sends the root no credential when it is called directly", async () => {
    const server = stubServer(CONTRACT_VERSION);
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    await client.GET("/");
    expect(server.seen.map((r) => r.authorization)).toEqual([null, null]);
  });

  it("follows no redirect, on the root read or on a call", async () => {
    const server = stubServer(CONTRACT_VERSION);
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    await client.GET("/edge-types");
    expect(server.redirects).toEqual(["error", "error"]);
  });

  it("lets a request's own abort release it from a root that never answers", async () => {
    const server = stubServer(
      CONTRACT_VERSION,
      () => new Promise<Response>(() => undefined),
    );
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    await expect(
      client.GET("/edge-types", { signal: AbortSignal.timeout(50) }),
    ).rejects.toThrow();
    expect(server.seen.map((r) => r.url)).toEqual(["/"]);
  });

  it("reads a root that answers something other than JSON as unreadable", async () => {
    const server = stubServer(
      CONTRACT_VERSION,
      () => new Response("<html>a page</html>", { status: 200 }),
    );
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    const refused = client.GET("/edge-types");
    await expect(refused).rejects.toBeInstanceOf(ContractUnreadableError);
    await expect(refused).rejects.toMatchObject({ status: undefined });
  });

  it("serves an instance under a path prefix, reading the root there", async () => {
    const server = stubServer(CONTRACT_VERSION, undefined, "/api/");
    const client = createClient({
      baseUrl: "https://marfa.example/api/",
      credential: "k",
      fetch: server.fetch,
    });
    await client.GET("/edge-types");
    expect(server.seen.map((r) => r.url)).toEqual(["/api/", "/api/edge-types"]);
    await expect(
      client.GET("/edge-types", { baseUrl: "https://marfa.example" }),
    ).rejects.toThrow(/refuses to send/);
  });

  it("refuses a base URL with a query, a fragment or another scheme", () => {
    const make = (baseUrl: string) => () =>
      createClient({ baseUrl, credential: "k", fetch: stubServer(1).fetch });
    expect(make("https://marfa.example/?x=1")).toThrow(TypeError);
    expect(make("https://marfa.example/#top")).toThrow(TypeError);
    expect(make("ftp://marfa.example")).toThrow(TypeError);
  });

  it("refuses a path parameter that would resolve to another route", async () => {
    const server = stubServer(CONTRACT_VERSION);
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: server.fetch,
    });
    await expect(
      client.GET("/items/{id}", { params: { path: { id: ".." } } }),
    ).rejects.toThrow(/names no resource/);
    expect(server.seen).toEqual([]);
  });

  it("types its calls from the document", () => {
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: stubServer(CONTRACT_VERSION).fetch,
    });
    // Checked by the compiler when the package typechecks.
    const typed = () => {
      // @ts-expect-error: no such path in the document
      void client.GET("/nowhere");
      // @ts-expect-error: the path parameter is required
      void client.GET("/items/{id}", {});
      void client.GET("/items/{id}", { params: { path: { id: "i" } } });
    };
    expect(typeof typed).toBe("function");
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

  it("refuses a cursor it already followed, however far back", async () => {
    const source = stub([
      { data: ["a"], next_cursor: "c1" },
      { data: ["b"], next_cursor: "c2" },
      { data: ["c"], next_cursor: "c1" },
    ]);
    const rows: string[] = [];
    const walk = async () => {
      for await (const row of pages(source.fetch)) rows.push(row);
    };
    await expect(walk()).rejects.toThrow(/would not end/);
    expect(rows).toEqual(["a", "b", "c"]);
  });

  it("refuses a page with no cursor to read, before handing on its rows", async () => {
    const source = stub([{ data: ["a"] } as unknown as Page<string>]);
    const rows: string[] = [];
    const walk = async () => {
      for await (const row of pages(source.fetch)) rows.push(row);
    };
    await expect(walk()).rejects.toThrow(/no next_cursor/);
    expect(rows).toEqual([]);
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
