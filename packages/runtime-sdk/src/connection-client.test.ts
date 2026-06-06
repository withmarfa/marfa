import { describe, it, expect } from "vitest";
import { ConnectionClient, MarfaApiError } from "./connection-client.js";
import type { RuntimeCredential } from "./types.js";

const CRED: RuntimeCredential = {
  api_key: "marfa_k1_initial",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  connection_id: "conn_1",
};

const REFRESHED: RuntimeCredential = {
  api_key: "marfa_k1_refreshed",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  connection_id: "conn_1",
};

interface Captured {
  url: string;
  method: string;
  authorization?: string;
  body?: string;
  cycleOrigin?: string;
  cycleHop?: string;
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
      cycleOrigin: req.headers.get("X-Marfa-Cycle-Origin") ?? undefined,
      cycleHop: req.headers.get("X-Marfa-Cycle-Hop") ?? undefined,
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
            new Response(
              JSON.stringify({ item: { id: "item_1", type: "core.note" } }),
              { status: 201 },
            ),
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
    expect(captured[0]!.authorization).toBe("Bearer marfa_k1_initial");
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
            new Response(
              JSON.stringify({ item: { id: "item_2", type: "core.note" } }),
              { status: 201 },
            ),
        ],
        captured,
      ),
    });
    const item = await client.createItem({ type: "core.note" });
    expect(item.id).toBe("item_2");
    expect(refreshes).toBe(1);
    expect(captured[0]!.authorization).toBe("Bearer marfa_k1_initial");
    expect(captured[1]!.authorization).toBe("Bearer marfa_k1_refreshed");
  });

  it("surfaces persistent 401 as MarfaApiError after one refresh", async () => {
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
    ).rejects.toBeInstanceOf(MarfaApiError);
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

describe("ConnectionClient cycle headers", () => {
  it("stamps X-Marfa-Cycle-Origin / X-Marfa-Cycle-Hop on createItem when cycleParent is the parent", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      cycleParent: {
        originating_connection_id: "conn-upstream",
        hop_count: 2,
      },
      fetch: makeFetch(
        [
          () =>
            new Response(
              JSON.stringify({ item: { id: "item_1", type: "core.note" } }),
              { status: 201 },
            ),
        ],
        captured,
      ),
    });
    await client.createItem({ type: "core.note", properties: { body: "x" } });
    // nextHopMetadata({ origin: A, hop: 2 }, conn_1) → { origin: A, hop: 3 }
    expect(captured[0]!.cycleOrigin).toBe("conn-upstream");
    expect(captured[0]!.cycleHop).toBe("3");
  });

  it("stamps the connector as the chain head when cycleParent is null", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      cycleParent: null,
      fetch: makeFetch(
        [
          () =>
            new Response(
              JSON.stringify({ item: { id: "item_1", type: "core.note" } }),
              { status: 201 },
            ),
        ],
        captured,
      ),
    });
    await client.createItem({ type: "core.note", properties: { body: "x" } });
    // Schedule / webhook trigger: cycleParent: null → connector is the head.
    // nextHopMetadata(null, conn_1) → { origin: conn_1, hop: 1 }
    expect(captured[0]!.cycleOrigin).toBe("conn_1");
    expect(captured[0]!.cycleHop).toBe("1");
  });

  it("does not stamp cycle headers on GET requests", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      cycleParent: {
        originating_connection_id: "conn-upstream",
        hop_count: 2,
      },
      fetch: makeFetch(
        [
          () =>
            new Response(JSON.stringify({ id: "item_1", type: "core.note" }), {
              status: 200,
            }),
        ],
        captured,
      ),
    });
    await client.getItem("item_1");
    // GET is read-only — won't trigger a publish — so no cycle headers
    // are emitted. Keeps the wire shape minimal.
    expect(captured[0]!.cycleOrigin).toBeUndefined();
    expect(captured[0]!.cycleHop).toBeUndefined();
  });

  it("multiple mutating calls within the same run all derive from the same parent (one logical hop)", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      cycleParent: {
        originating_connection_id: "conn-upstream",
        hop_count: 2,
      },
      fetch: makeFetch(
        [
          () =>
            new Response(
              JSON.stringify({ item: { id: "item_1", type: "core.note" } }),
              { status: 201 },
            ),
          () =>
            new Response(
              JSON.stringify({ item: { id: "item_2", type: "core.note" } }),
              { status: 201 },
            ),
          () =>
            new Response(
              JSON.stringify({ item: { id: "item_3", type: "core.note" } }),
              {
                status: 201,
              },
            ),
        ],
        captured,
      ),
    });
    await client.createItem({ type: "core.note", properties: {} });
    await client.createItem({ type: "core.note", properties: {} });
    await client.createItem({ type: "core.note", properties: {} });
    // Three mutating calls in the same run — every one stamps hop = 3
    // (parent + 1). The connector's "run is one logical hop" contract:
    // per-request increments would conflate an N-call handler with an
    // N-deep chain.
    for (const c of captured) {
      expect(c.cycleOrigin).toBe("conn-upstream");
      expect(c.cycleHop).toBe("3");
    }
  });
});

describe("ConnectionClient — server-response unwrap", () => {
  it("getItem unwraps the { item, metadata } server envelope", async () => {
    const captured: Captured[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeFetch(
        [
          // `GET /items/:id` returns `{ item, metadata }` from the server;
          // the client unwraps to the bare ItemResource.
          () =>
            new Response(
              JSON.stringify({
                item: {
                  id: "task_1",
                  type: "core.task",
                  state: "active",
                  properties: { title: "Buy milk" },
                },
                metadata: {
                  item_id: "task_1",
                  tags: [],
                  extensions: {},
                },
              }),
              { status: 200 },
            ),
        ],
        captured,
      ),
    });
    const item = await client.getItem("task_1");
    expect(item).not.toBeNull();
    expect(item?.id).toBe("task_1");
    expect((item?.properties as { title?: string }).title).toBe("Buy milk");
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.url).toBe("https://api.example.com/items/task_1");
  });

  it("updateItem unwraps the { item, metadata } server envelope", async () => {
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
                item: {
                  id: "task_1",
                  type: "core.task",
                  state: "active",
                  properties: { title: "Buy oat milk" },
                },
                metadata: { item_id: "task_1", tags: [], extensions: {} },
              }),
              { status: 200 },
            ),
        ],
        captured,
      ),
    });
    const item = await client.updateItem("task_1", {
      type: "core.task",
      properties: { title: "Buy oat milk" },
    });
    expect(item.id).toBe("task_1");
    expect((item.properties as { title?: string }).title).toBe("Buy oat milk");
    expect(captured[0]!.method).toBe("PATCH");
  });
});

// ---------------------------------------------------------------------------
// ConnectionClient.uploadBlob
//
// The SDK forwards raw bytes to the server's `POST /blobs` route using the
// connection's runtime credential. Server-side concerns (tenant scoping, R2
// keying, dedup, quota enforcement) are covered in @withmarfa/server's blob
// tests. These cover the SDK contract: input shapes, headers + body bytes,
// 401-refresh single-flight, error surfacing, boundary rejection.
// ---------------------------------------------------------------------------

interface CapturedUpload {
  url: string;
  method: string;
  authorization?: string;
  contentType?: string;
  cycleOrigin?: string;
  cycleHop?: string;
  bodyBytes: Uint8Array;
}

function makeUploadFetch(
  responses: (() => Response)[],
  captured: CapturedUpload[],
): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const bodyBytes = init?.body
      ? new Uint8Array(await new Response(init.body).arrayBuffer())
      : new Uint8Array(0);
    captured.push({
      url,
      method,
      authorization: headers.get("Authorization") ?? undefined,
      contentType: headers.get("Content-Type") ?? undefined,
      cycleOrigin: headers.get("X-Marfa-Cycle-Origin") ?? undefined,
      cycleHop: headers.get("X-Marfa-Cycle-Hop") ?? undefined,
      bodyBytes,
    });
    const responder = responses[i++];
    if (!responder) return new Response("no responder", { status: 500 });
    return responder();
  }) as typeof fetch;
}

describe("ConnectionClient.uploadBlob", () => {
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]);
  const okResponse = () =>
    new Response(
      JSON.stringify({
        hash: "sha256:abc",
        mime_type: "application/pdf",
        size: PDF_BYTES.length,
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );

  it("POSTs raw bytes to /blobs with Content-Type matching the input mime", async () => {
    const captured: CapturedUpload[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeUploadFetch([okResponse], captured),
    });

    const result = await client.uploadBlob({
      content: PDF_BYTES,
      mime_type: "application/pdf",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.example.com/blobs");
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.authorization).toBe("Bearer marfa_k1_initial");
    expect(captured[0]!.contentType).toBe("application/pdf");
    // No cycle headers on /blobs — it doesn't publish events.
    expect(captured[0]!.cycleOrigin).toBeUndefined();
    expect(captured[0]!.cycleHop).toBeUndefined();
    expect(Array.from(captured[0]!.bodyBytes)).toEqual(Array.from(PDF_BYTES));
    expect(result).toEqual({
      hash: "sha256:abc",
      mime_type: "application/pdf",
      size: PDF_BYTES.length,
    });
  });

  it("accepts an ArrayBuffer and forwards the bytes exactly", async () => {
    const captured: CapturedUpload[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeUploadFetch([okResponse], captured),
    });

    // Construct an ArrayBuffer that doesn't share storage with the Uint8Array.
    const ab = new ArrayBuffer(PDF_BYTES.length);
    new Uint8Array(ab).set(PDF_BYTES);

    await client.uploadBlob({ content: ab, mime_type: "application/pdf" });

    expect(Array.from(captured[0]!.bodyBytes)).toEqual(Array.from(PDF_BYTES));
  });

  it("accepts a Uint8Array view over a larger buffer (subarray)", async () => {
    // Buffer.from(...) in the Node test path returns a Uint8Array view;
    // covering the subarray case verifies we don't accidentally send the
    // full backing ArrayBuffer.
    const captured: CapturedUpload[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeUploadFetch([okResponse], captured),
    });

    const backing = new Uint8Array(64);
    backing.set(PDF_BYTES, 16);
    const view = backing.subarray(16, 16 + PDF_BYTES.length);

    await client.uploadBlob({ content: view, mime_type: "application/pdf" });

    expect(Array.from(captured[0]!.bodyBytes)).toEqual(Array.from(PDF_BYTES));
  });

  it("refreshes the credential on 401 and retries the upload once", async () => {
    const captured: CapturedUpload[] = [];
    let refreshes = 0;
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => {
        refreshes++;
        return Promise.resolve(REFRESHED);
      },
      fetch: makeUploadFetch(
        [() => new Response("", { status: 401 }), okResponse],
        captured,
      ),
    });

    const result = await client.uploadBlob({
      content: PDF_BYTES,
      mime_type: "application/pdf",
    });

    expect(refreshes).toBe(1);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.authorization).toBe("Bearer marfa_k1_initial");
    expect(captured[1]!.authorization).toBe("Bearer marfa_k1_refreshed");
    // Body bytes are re-sent on the retry (full content, not a stream that
    // would have drained).
    expect(Array.from(captured[1]!.bodyBytes)).toEqual(Array.from(PDF_BYTES));
    expect(result.hash).toBe("sha256:abc");
  });

  it("surfaces persistent 401 as MarfaApiError after one refresh attempt", async () => {
    const captured: CapturedUpload[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeUploadFetch(
        [
          () => new Response("", { status: 401 }),
          () => new Response("still denied", { status: 401 }),
        ],
        captured,
      ),
    });

    const err = await client
      .uploadBlob({ content: PDF_BYTES, mime_type: "application/pdf" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarfaApiError);
    expect((err as MarfaApiError).status).toBe(401);
  });

  it("surfaces 413 blob_too_large with the server body in the message", async () => {
    const captured: CapturedUpload[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeUploadFetch(
        [
          () =>
            new Response(
              JSON.stringify({
                error: { code: "blob_too_large", message: "exceeds 50 MB" },
              }),
              { status: 413 },
            ),
        ],
        captured,
      ),
    });

    const err = await client
      .uploadBlob({ content: PDF_BYTES, mime_type: "application/pdf" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarfaApiError);
    expect((err as MarfaApiError).status).toBe(413);
    expect((err as Error).message).toContain("blob_too_large");
  });

  it("rejects string input at the SDK boundary before issuing the request", async () => {
    const captured: CapturedUpload[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeUploadFetch([okResponse], captured),
    });

    const err = await client
      .uploadBlob({
        content: "raw text" as unknown as Uint8Array,
        mime_type: "text/plain",
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarfaApiError);
    expect((err as Error).message).toContain("uploadBlob");
    expect(captured).toHaveLength(0);
  });

  it("rejects null input at the SDK boundary", async () => {
    const captured: CapturedUpload[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeUploadFetch([okResponse], captured),
    });

    await expect(
      client.uploadBlob({
        content: null as unknown as Uint8Array,
        mime_type: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(MarfaApiError);
    expect(captured).toHaveLength(0);
  });

  it("rejects a ReadableStream input at the SDK boundary (bytes-only in v1)", async () => {
    const captured: CapturedUpload[] = [];
    const client = new ConnectionClient({
      apiUrl: "https://api.example.com",
      credential: CRED,
      refreshCredential: () => Promise.resolve(REFRESHED),
      fetch: makeUploadFetch([okResponse], captured),
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF_BYTES);
        controller.close();
      },
    });

    await expect(
      client.uploadBlob({
        content: stream as unknown as Uint8Array,
        mime_type: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(MarfaApiError);
    expect(captured).toHaveLength(0);
  });
});
