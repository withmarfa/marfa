import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_HEADER,
  CONTRACT_VERSION,
  ContractMismatchError,
  createClient,
  pages,
  type Page,
} from "./index.js";

interface Answer {
  status?: number;
  body?: string | null;
  /** The contract header's value, or `null` to send none. */
  contract?: string | null;
}

/** A server that answers every request with an empty page, stamped with
 *  this client's contract unless told otherwise, recording what it was
 *  asked. */
function stubServer(answer: (path: string) => Answer = () => ({})) {
  const seen: { url: string; authorization: string | null }[] = [];
  const redirects: Request["redirect"][] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    redirects.push(request.redirect);
    seen.push({
      url: path,
      authorization: request.headers.get("Authorization"),
    });
    const {
      status = 200,
      body = JSON.stringify({ data: [], next_cursor: null }),
      contract = String(CONTRACT_VERSION),
    } = answer(path);
    const headers = new Headers({ "Content-Type": "application/json" });
    if (contract !== null) headers.set(CONTRACT_HEADER, contract);
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return { seen, redirects, fetch };
}

const make = (
  server: ReturnType<typeof stubServer>,
  baseUrl = "https://marfa.example",
) => createClient({ baseUrl, credential: "k", fetch: server.fetch });

describe("the contract check", () => {
  it("refuses an answer on another contract rather than reading it", async () => {
    const server = stubServer(() => ({
      contract: String(CONTRACT_VERSION + 1),
    }));
    const refused = make(server).GET("/edge-types");
    await expect(refused).rejects.toBeInstanceOf(ContractMismatchError);
    await expect(refused).rejects.toMatchObject({
      served: String(CONTRACT_VERSION + 1),
      status: 200,
    });
  });

  it("refuses a success that names no contract", async () => {
    // A page from something that is not the server, answered 200: a
    // captive portal, a misrouted proxy.
    const server = stubServer(() => ({
      contract: null,
      body: "<html>sign in to the network</html>",
    }));
    await expect(make(server).GET("/edge-types")).rejects.toMatchObject({
      name: "ContractMismatchError",
      served: null,
      status: 200,
    });
  });

  it("refuses an error answer on another contract", async () => {
    const server = stubServer(() => ({
      status: 404,
      contract: String(CONTRACT_VERSION + 1),
      body: JSON.stringify({ error: { code: "not_found" } }),
    }));
    await expect(make(server).GET("/edge-types")).rejects.toBeInstanceOf(
      ContractMismatchError,
    );
  });

  it("hands on an error answer that names no contract, status intact", async () => {
    const server = stubServer(() => ({
      status: 502,
      contract: null,
      body: "<html>bad gateway</html>",
    }));
    const answered = await make(server).GET("/edge-types");
    expect(answered.response.status).toBe(502);
    expect(answered.error).toBe("<html>bad gateway</html>");
  });

  it("hands on a refusal on its own contract as the server's envelope", async () => {
    const envelope = { error: { code: "item_not_found", message: "gone" } };
    const server = stubServer(() => ({
      status: 404,
      body: JSON.stringify(envelope),
    }));
    const answered = await make(server).GET("/items/{id}", {
      params: { path: { id: "i" } },
    });
    expect(answered.response.status).toBe(404);
    expect(answered.error).toEqual(envelope);
  });

  it("reads a bodiless answer on its own contract, and refuses one on another", async () => {
    const empty = stubServer(() => ({ status: 204, body: null }));
    const deleted = await make(empty).DELETE("/items/{id}", {
      params: { path: { id: "i" } },
    });
    expect(deleted.response.status).toBe(204);
    const other = stubServer(() => ({
      status: 204,
      body: null,
      contract: String(CONTRACT_VERSION + 1),
    }));
    await expect(
      make(other).DELETE("/items/{id}", { params: { path: { id: "i" } } }),
    ).rejects.toBeInstanceOf(ContractMismatchError);
  });

  it("names the header the document declares", async () => {
    const document = JSON.parse(
      await readFile(new URL("../../../openapi.json", import.meta.url), "utf8"),
    ) as { components: { headers: Record<string, unknown> } };
    expect(Object.keys(document.components.headers)).toContain(CONTRACT_HEADER);
  });

  it("reads a contract spelled any other way as another contract", async () => {
    const server = stubServer(() => ({
      contract: `0${String(CONTRACT_VERSION)}`,
    }));
    await expect(make(server).GET("/edge-types")).rejects.toThrow(
      `contract "0${String(CONTRACT_VERSION)}"`,
    );
  });

  it("reads an answer on its own contract, sending only the call, with the bearer", async () => {
    // The witness: the same client against the contract it was generated for.
    const server = stubServer();
    const client = make(server, "https://marfa.example/");
    const first = await client.GET("/edge-types");
    const second = await client.GET("/edge-types");
    expect(first.data).toEqual({ data: [], next_cursor: null });
    expect(second.response.ok).toBe(true);
    expect(server.seen).toEqual([
      { url: "/edge-types", authorization: "Bearer k" },
      { url: "/edge-types", authorization: "Bearer k" },
    ]);
  });
});

describe("what a caller's own code sees", () => {
  it("hands middleware a request without the credential and an answer already checked", async () => {
    const server = stubServer(() => ({
      contract: String(CONTRACT_VERSION + 1),
    }));
    const client = make(server);
    const seen: { authorization: string | null; read: boolean }[] = [];
    client.use({
      onRequest({ request }) {
        seen.push({
          authorization: request.headers.get("Authorization"),
          read: false,
        });
        return undefined;
      },
      onResponse() {
        seen.push({ authorization: null, read: true });
        return undefined;
      },
    });
    await expect(client.GET("/edge-types")).rejects.toBeInstanceOf(
      ContractMismatchError,
    );
    // The request was seen without the bearer, which the server did get;
    // the answer on another contract never reached the middleware.
    expect(seen).toEqual([{ authorization: null, read: false }]);
    expect(server.seen[0]?.authorization).toBe("Bearer k");
  });

  it("releases the body of an answer it refuses", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const client = createClient({
      baseUrl: "https://marfa.example",
      credential: "k",
      fetch: () =>
        Promise.resolve(
          new Response(body, {
            headers: { [CONTRACT_HEADER]: String(CONTRACT_VERSION + 1) },
          }),
        ),
    });
    await expect(client.GET("/edge-types")).rejects.toBeInstanceOf(
      ContractMismatchError,
    );
    expect(cancelled).toBe(true);
  });

  it("holds an answer from a request's own fetch too", async () => {
    const own = stubServer(() => ({ contract: String(CONTRACT_VERSION + 1) }));
    const client = make(stubServer());
    await expect(
      client.GET("/edge-types", { fetch: own.fetch }),
    ).rejects.toBeInstanceOf(ContractMismatchError);
  });
});

describe("where the credential goes", () => {
  it("sends nothing to a base URL other than its own", async () => {
    const server = stubServer();
    const client = make(server);
    for (const elsewhere of [
      "https://elsewhere.example",
      // A host that begins with this one's name is another host.
      "https://marfa.example.elsewhere.example",
    ]) {
      await expect(
        client.GET("/edge-types", { baseUrl: elsewhere }),
      ).rejects.toThrow(/refuses to send/);
    }
    expect(server.seen).toEqual([]);
    // The witness: the same client does send under its own base URL.
    await client.GET("/edge-types");
    expect(server.seen.map((r) => r.url)).toEqual(["/edge-types"]);
  });

  it("follows no redirect", async () => {
    const server = stubServer();
    await make(server).GET("/edge-types");
    expect(server.redirects).toEqual(["error"]);
  });

  it("serves an instance under a path prefix, and nothing outside it", async () => {
    const server = stubServer();
    const client = make(server, "https://marfa.example/api/");
    await client.GET("/edge-types");
    expect(server.seen.map((r) => r.url)).toEqual(["/api/edge-types"]);
    await expect(
      client.GET("/edge-types", { baseUrl: "https://marfa.example" }),
    ).rejects.toThrow(/refuses to send/);
  });

  it("refuses a base URL with a query, a fragment or another scheme", () => {
    const server = stubServer();
    expect(() => make(server, "https://marfa.example/?x=1")).toThrow(TypeError);
    expect(() => make(server, "https://marfa.example/#top")).toThrow(TypeError);
    // An empty query or fragment parses to none, and would still end the
    // path every call is appended to.
    expect(() => make(server, "https://marfa.example/?")).toThrow(TypeError);
    expect(() => make(server, "https://marfa.example/#")).toThrow(TypeError);
    expect(() => make(server, "ftp://marfa.example")).toThrow(TypeError);
  });

  it("refuses a path parameter that would resolve to another route", async () => {
    const server = stubServer();
    const client = make(server);
    for (const id of [".", ".."]) {
      await expect(
        client.GET("/items/{id}", { params: { path: { id } } }),
      ).rejects.toThrow(/names no resource/);
    }
    expect(server.seen).toEqual([]);
    // The witness: an ordinary identifier on the same door is sent.
    await client.GET("/items/{id}", { params: { path: { id: "i" } } });
    expect(server.seen.map((r) => r.url)).toEqual(["/items/i"]);
  });

  it("types its calls from the document", () => {
    const client = make(stubServer());
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
