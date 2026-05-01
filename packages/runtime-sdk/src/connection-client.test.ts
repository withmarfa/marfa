import { describe, it, expect } from "vitest";
import { ConnectionClient, MymeApiError } from "./connection-client.js";
import type { RuntimeCredential } from "./types.js";

const CRED: RuntimeCredential = {
  api_key: "myme_k1_initial",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  connection_id: "conn_1",
};

const REFRESHED: RuntimeCredential = {
  api_key: "myme_k1_refreshed",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  connection_id: "conn_1",
};

interface Captured {
  url: string;
  method: string;
  authorization?: string;
  body?: string;
}

function makeFetch(
  responses: ((req: Request) => Response)[],
  captured: Captured[],
): typeof fetch {
  let i = 0;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    captured.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.get("Authorization") ?? undefined,
    });
    const responder = responses[i++];
    if (!responder) {
      return Promise.resolve(new Response("no responder", { status: 500 }));
    }
    return Promise.resolve(responder(req));
  }) as typeof fetch;
}

describe("ConnectionClient", () => {
  it("attaches the bearer credential and POSTs an item", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch(
        [
          () =>
            new Response(JSON.stringify({ id: "item_1", type: "core.note" }), {
              status: 201,
            }),
        ],
        captured,
      ),
    });
    const item = await client.createItem({
      type: "core.note",
      properties: { title: "hi" },
    });
    expect(item.id).toBe("item_1");
    expect(captured[0]!.url).toBe("https://api.example.com/items");
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.authorization).toBe("Bearer myme_k1_initial");
  });

  it("refreshes the credential on 401 and retries once", async () => {
    const captured: Captured[] = [];
    let refreshes = 0;
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => {
        refreshes++;
        return Promise.resolve(REFRESHED);
      },
      fetch: makeFetch(
        [
          () => new Response("", { status: 401 }),
          () =>
            new Response(JSON.stringify({ id: "item_2", type: "core.note" }), {
              status: 201,
            }),
        ],
        captured,
      ),
    });
    const item = await client.createItem({ type: "core.note" });
    expect(item.id).toBe("item_2");
    expect(refreshes).toBe(1);
    expect(captured[0]!.authorization).toBe("Bearer myme_k1_initial");
    expect(captured[1]!.authorization).toBe("Bearer myme_k1_refreshed");
  });

  it("surfaces persistent 401 as MymeApiError after one refresh", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch(
        [
          () => new Response("", { status: 401 }),
          () => new Response("denied", { status: 401 }),
        ],
        captured,
      ),
    });
    await expect(
      client.createItem({ type: "core.note" }),
    ).rejects.toBeInstanceOf(MymeApiError);
  });

  it("getItem returns null on 404 instead of throwing", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch([() => new Response("", { status: 404 })], captured),
    });
    expect(await client.getItem("missing_id")).toBeNull();
  });

  it("readRuntimeExtension returns the namespace blob from the server response", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch(
        [
          () =>
            new Response(
              JSON.stringify({
                namespace: "connection.runtime",
                data: { cursor: "abc" },
              }),
              { status: 200 },
            ),
        ],
        captured,
      ),
    });
    const v = await client.readRuntimeExtension("conn_1");
    expect(v).toEqual({ cursor: "abc" });
    expect(captured[0]!.url).toBe(
      "https://api.example.com/items/conn_1/extensions/connection.runtime",
    );
  });

  it("writeRuntimeExtension PUTs the blob directly as the body", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch([() => new Response(null, { status: 204 })], captured),
    });
    await client.writeRuntimeExtension("conn_1", {
      cursor: { since: "2026-05-01" },
    });
    expect(captured[0]!.method).toBe("PUT");
    expect(captured[0]!.url).toBe(
      "https://api.example.com/items/conn_1/extensions/connection.runtime",
    );
  });

  it("listItems builds a query string from the supplied filters", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch(
        [
          () =>
            new Response(
              JSON.stringify({ data: [], cursor: null, has_more: false }),
              { status: 200 },
            ),
        ],
        captured,
      ),
    });
    await client.listItems({
      type: "core.task",
      state: "active",
      sort: "created_at",
      direction: "asc",
      limit: 100,
    });
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.url).toBe(
      "https://api.example.com/items?type=core.task&state=active&sort=created_at&direction=asc&limit=100",
    );
  });

  it("listItems with no query targets /items with no params", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch(
        [
          () =>
            new Response(
              JSON.stringify({ data: [], cursor: null, has_more: false }),
              { status: 200 },
            ),
        ],
        captured,
      ),
    });
    await client.listItems();
    expect(captured[0]!.url).toBe("https://api.example.com/items");
  });

  it("transitionItem POSTs the new state and returns the unwrapped item", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch(
        [
          // The route returns { item, metadata } per items-lifecycle.ts;
          // ConnectionClient.transitionItem unwraps so the connector sees
          // a plain ItemResource.
          () =>
            new Response(
              JSON.stringify({
                item: { id: "task_1", type: "core.task", state: "archived" },
              }),
              { status: 200 },
            ),
        ],
        captured,
      ),
    });
    const item = await client.transitionItem("task_1", "archived");
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.url).toBe(
      "https://api.example.com/items/task_1/transition",
    );
    expect(item.state).toBe("archived");
  });
});
