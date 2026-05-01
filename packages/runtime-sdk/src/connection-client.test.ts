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

  it("readRuntimeExtension returns the value field unwrapped", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch(
        [
          () =>
            new Response(JSON.stringify({ value: { cursor: "abc" } }), {
              status: 200,
            }),
        ],
        captured,
      ),
    });
    const v = (await client.readRuntimeExtension(
      "conn_1",
      "github.cursor",
    )) as { cursor: string } | null;
    expect(v).toEqual({ cursor: "abc" });
    expect(captured[0]!.url).toBe(
      "https://api.example.com/items/conn_1/extensions/connection.runtime/github.cursor",
    );
  });

  it("writeRuntimeExtension wraps the value and PUTs", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch([() => new Response(null, { status: 204 })], captured),
    });
    await client.writeRuntimeExtension("conn_1", "github.cursor", {
      since: "2026-05-01",
    });
    expect(captured[0]!.method).toBe("PUT");
    expect(captured[0]!.url).toBe(
      "https://api.example.com/items/conn_1/extensions/connection.runtime/github.cursor",
    );
  });
});
