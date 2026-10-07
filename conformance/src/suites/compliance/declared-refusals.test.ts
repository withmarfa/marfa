import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getOperatorClient,
  trackEdge,
  trackItem,
  trackKey,
  trackType,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { tarGz } from "../../utils/archive.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import {
  expectMatchesSchema,
  publishedOperations,
  servedDocument,
  validatorFor,
} from "../../utils/openapi.js";

/**
 * Refusals a door declares that no chapter's fixture otherwise draws.
 *
 * `check:statuses --complete` holds every declared status to a request that
 * drew it, so a declaration no code path answers shows up as a status no run
 * ever sees. These are the ones a request can draw; the ones it cannot are
 * listed with why in `utils/status-declarations.ts`.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "declared-refusals",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function call(
  method: string,
  path: string,
  options: {
    body?: unknown;
    key?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${options.key ?? apiKey}`,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : JSON.parse(text),
  };
}

/** Assert the status and code, and hold the body to the declaration. */
async function expectRefusal(
  method: string,
  template: string,
  answer: { status: number; body: unknown },
  status: number,
  code: string,
): Promise<void> {
  expect(answer.status, JSON.stringify(answer.body)).toBe(status);
  expect((answer.body as { error?: { code?: string } }).error?.code).toBe(code);
  await expectMatchesSchema(method, template, status, answer.body);
}

async function seedItem(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `dr-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function seedEdge(): Promise<{ id: string; version: number }> {
  const r = await client.createEdge({
    source_id: await seedItem("edge-source"),
    target_id: await seedItem("edge-target"),
    edge_type: "about",
  });
  expect(r.ok).toBe(true);
  trackEdge(ctx, r.data.edge.id);
  return { id: r.data.edge.id, version: r.data.edge.version };
}

const MALFORMED = "not-an-id";
const UNKNOWN = uuidv7();

describe("a key names one request", () => {
  // The same key sent on a second, different request is a caller bug, not a
  // retry: every door that honors the header refuses it rather than serving
  // the first request's answer to a request nobody made.
  it("is refused 422 on every idempotent write door when sent with another request", async () => {
    const edgeA = await seedEdge();
    const edgeB = await seedEdge();
    const doors: {
      method: string;
      template: string;
      first: () => Promise<{ path: string; body?: unknown }>;
      second: () => Promise<{ path: string; body?: unknown }>;
    }[] = [
      {
        method: "POST",
        template: "/items",
        first: async () => ({
          path: "/items",
          body: createNote({ source: ctx.source, properties: { body: "a" } }),
        }),
        second: async () => ({
          path: "/items",
          body: createNote({ source: ctx.source, properties: { body: "b" } }),
        }),
      },
      {
        method: "POST",
        template: "/edges",
        first: async () => ({
          path: "/edges",
          body: {
            source_id: await seedItem("post-a"),
            target_id: await seedItem("post-b"),
            edge_type: "about",
          },
        }),
        second: async () => ({
          path: "/edges",
          body: {
            source_id: await seedItem("post-c"),
            target_id: await seedItem("post-d"),
            edge_type: "about",
          },
        }),
      },
      {
        method: "PATCH",
        template: "/edges/{id}",
        first: async () => ({
          path: `/edges/${edgeA.id}`,
          body: { version: edgeA.version, properties: {} },
        }),
        second: async () => ({
          path: `/edges/${edgeB.id}`,
          body: { version: edgeB.version, properties: {} },
        }),
      },
      {
        method: "DELETE",
        template: "/edges/{id}",
        first: async () => ({ path: `/edges/${edgeA.id}` }),
        second: async () => ({ path: `/edges/${edgeB.id}` }),
      },
      {
        method: "PATCH",
        template: "/items/{id}",
        first: async () => ({
          path: `/items/${await seedItem("patch-a")}`,
          body: { version: 1, properties: { title: "a" } },
        }),
        second: async () => ({
          path: `/items/${await seedItem("patch-b")}`,
          body: { version: 1, properties: { title: "b" } },
        }),
      },
      {
        method: "POST",
        template: "/items/{id}/transition",
        first: async () => ({
          path: `/items/${await seedItem("transition-a")}/transition`,
          body: { state: "archived" },
        }),
        second: async () => ({
          path: `/items/${await seedItem("transition-b")}/transition`,
          body: { state: "archived" },
        }),
      },
      {
        method: "DELETE",
        template: "/items/{id}",
        first: async () => ({ path: `/items/${await seedItem("delete-a")}` }),
        second: async () => ({ path: `/items/${await seedItem("delete-b")}` }),
      },
      {
        method: "POST",
        template: "/items/{id}/restore",
        first: async () => ({
          path: `/items/${await trashed("restore-a")}/restore`,
        }),
        second: async () => ({
          path: `/items/${await trashed("restore-b")}/restore`,
        }),
      },
      {
        method: "POST",
        template: "/items/{id}/purge",
        first: async () => ({
          path: `/items/${await trashed("purge-a")}/purge`,
        }),
        second: async () => ({
          path: `/items/${await trashed("purge-b")}/purge`,
        }),
      },
    ];

    for (const door of doors) {
      const key = `dr-${ctx.runId}-${randomUUID()}`;
      const headers = { "Idempotency-Key": key };
      const first = await door.first();
      const accepted = await call(door.method, first.path, {
        body: first.body,
        headers,
      });
      expect(accepted.status, `${door.method} ${door.template}`).toBeLessThan(
        300,
      );
      const made = accepted.body as {
        item?: { id?: string };
        edge?: { id?: string };
      };
      if (door.template === "/items" && made.item?.id)
        trackItem(ctx, made.item.id);
      if (door.template === "/edges" && made.edge?.id)
        trackEdge(ctx, made.edge.id);
      const second = await door.second();
      const refused = await call(door.method, second.path, {
        body: second.body,
        headers,
      });
      await expectRefusal(
        door.method,
        door.template,
        refused,
        422,
        "idempotency_key_reused",
      );
    }
  });

  it("refuses an empty key 400 rather than treating it as absent", async () => {
    const edge = await seedEdge();
    const refused = await call("DELETE", `/edges/${edge.id}`, {
      headers: { "Idempotency-Key": "" },
    });
    await expectRefusal(
      "DELETE",
      "/edges/{id}",
      refused,
      400,
      "validation_error",
    );
  });
});

async function trashed(label: string): Promise<string> {
  const id = await seedItem(label);
  const r = await client.transitionItem(id, "trashed");
  expect(r.ok).toBe(true);
  return id;
}

describe("a malformed identifier", () => {
  it("is refused 400 on the item's extension and metadata doors", async () => {
    await expectRefusal(
      "GET",
      "/items/{id}/extensions/{namespace}",
      await call("GET", `/items/${MALFORMED}/extensions/conformance`),
      400,
      "invalid_id",
    );
    await expectRefusal(
      "PUT",
      "/items/{id}/extensions/{namespace}",
      await call("PUT", `/items/${MALFORMED}/extensions/conformance`, {
        body: { note: "x" },
      }),
      400,
      "invalid_id",
    );
    await expectRefusal(
      "DELETE",
      "/items/{id}/extensions/{namespace}",
      await call("DELETE", `/items/${MALFORMED}/extensions/conformance`),
      400,
      "invalid_id",
    );
    await expectRefusal(
      "PUT",
      "/items/{id}/metadata",
      await call("PUT", `/items/${MALFORMED}/metadata`, { body: { tags: [] } }),
      400,
      "invalid_id",
    );
  });

  it("is refused 400 on the key and blob-location doors", async () => {
    await expectRefusal(
      "DELETE",
      "/keys/{id}",
      await call("DELETE", `/keys/${MALFORMED}`),
      400,
      "validation_error",
    );
    await expectRefusal(
      "DELETE",
      "/blobs/{hash}/locations/{store}",
      await call("DELETE", `/blobs/${MALFORMED}/locations/disk`, {
        key: process.env.MARFA_OPERATOR_KEY,
      }),
      400,
      "validation_error",
    );
  });
});

describe("an identifier nothing carries", () => {
  it("is refused 404 on the write doors that name one", async () => {
    await expectRefusal(
      "PATCH",
      "/items/{id}",
      await call("PATCH", `/items/${UNKNOWN}`, {
        body: { version: 1, properties: { title: "x" } },
      }),
      404,
      "item_not_found",
    );
    await expectRefusal(
      "POST",
      "/items/{id}/transition",
      await call("POST", `/items/${UNKNOWN}/transition`, {
        body: { state: "archived" },
      }),
      404,
      "item_not_found",
    );
    await expectRefusal(
      "PATCH",
      "/edges/{id}",
      await call("PATCH", `/edges/${UNKNOWN}`, {
        body: { version: 1, properties: {} },
      }),
      404,
      "edge_not_found",
    );
    await expectRefusal(
      "POST",
      "/edges",
      await call("POST", "/edges", {
        body: {
          source_id: UNKNOWN,
          target_id: await seedItem("unknown-source"),
          edge_type: "about",
        },
      }),
      404,
      "item_not_found",
    );
    await expectRefusal(
      "PUT",
      "/types/{id}",
      await call("PUT", `/types/conformance.${ctx.runId}.missing`, {
        body: { fields: {} },
      }),
      404,
      "type_not_found",
    );
  });
});

describe("a core edge type", () => {
  it("cannot be deleted, and cannot be redefined by an archive", async () => {
    await expectRefusal(
      "DELETE",
      "/edge-types/{id}",
      await call("DELETE", "/edge-types/about"),
      400,
      "validation_error",
    );

    const archive = tarGz([
      {
        name: "manifest.json",
        body: JSON.stringify({
          version: 0,
          format: "marfa-archive-v0",
          created_at: new Date().toISOString(),
          item_count: 0,
          edge_count: 0,
          blob_count: 0,
          type_count: 0,
          edge_type_count: 1,
          blobs: {},
        }),
      },
      { name: "items.ndjson", body: "" },
      { name: "edges.ndjson", body: "" },
      {
        name: "types.ndjson",
        body: `${JSON.stringify({ edge_type: { id: "about", label: "About" } })}\n`,
      },
    ]);
    const restored = await getOperatorClient().restoreArchive(archive);
    expect(restored.status).toBe(409);
    expect(restored.error?.error.code).toBe("conflict");
    await expectMatchesSchema("POST", "/restore", 409, restored.error);
  });
});

describe("a credential without write on the type", () => {
  it("is refused 403 on an update", async () => {
    const id = await seedItem("read-only");
    const minted = await client.createKey({
      label: `${ctx.source}-read-only`,
      source: `${ctx.source}-read-only`,
      permissions: [],
      type_permissions: { "*": "read" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    await expectRefusal(
      "PATCH",
      "/items/{id}",
      await call("PATCH", `/items/${id}`, {
        key: minted.data.key,
        body: { version: 1, properties: { title: "x" } },
      }),
      403,
      "type_not_permitted",
    );
  });

  it("is refused on every metadata, tag and version door by what it holds on the type, and on an inline edge it does not hold", async () => {
    const id = await seedItem("type-blind");
    const mint = async (
      label: string,
      types: Record<string, string>,
    ): Promise<string> => {
      const minted = await client.createKey({
        label: `${ctx.source}-${label}`,
        source: `${ctx.source}-${label}`,
        permissions: [],
        type_permissions: types,
      });
      expect(minted.ok).toBe(true);
      trackKey(ctx, minted.data.id);
      return minted.data.key;
    };
    const reads: [string, string, string, unknown][] = [
      ["GET", "/items/{id}/metadata", `/items/${id}/metadata`, undefined],
      ["GET", "/items/{id}/versions", `/items/${id}/versions`, undefined],
    ];
    const writes: [string, string, string, unknown][] = [
      ["PUT", "/items/{id}/metadata", `/items/${id}/metadata`, { tags: [] }],
      ["PATCH", "/items/{id}/metadata", `/items/${id}/metadata`, { tags: [] }],
      ["POST", "/items/{id}/tags", `/items/${id}/tags`, { tags: ["x"] }],
      ["DELETE", "/items/{id}/tags/{tag}", `/items/${id}/tags/x`, undefined],
    ];
    // Blind to the type: the item answers as missing, on reads and writes.
    const blind = await mint("type-blind", { "core.bookmark": "read" });
    for (const [method, template, path, body] of [...reads, ...writes]) {
      await expectRefusal(
        method,
        template,
        await call(method, path, { key: blind, body }),
        404,
        "item_not_found",
      );
    }
    // Reading the type and not writing it: the writes are refused.
    const reader = await mint("type-reader", { "core.note": "read" });
    for (const [method, template, path, body] of writes) {
      await expectRefusal(
        method,
        template,
        await call(method, path, { key: reader, body }),
        403,
        "type_not_permitted",
      );
    }
    // Reaching no type: refused before the item is looked up.
    const nowhere = await mint("type-nowhere", { "*": "none" });
    for (const [method, template, path, body] of reads) {
      await expectRefusal(
        method,
        template,
        await call(method, path, { key: nowhere, body }),
        403,
        "type_not_permitted",
      );
    }

    // Write on the note, nothing on any edge type.
    const edgeless = await client.createKey({
      label: `${ctx.source}-edgeless`,
      source: `${ctx.source}-edgeless`,
      permissions: [],
      type_permissions: { "core.note": "write" },
    });
    expect(edgeless.ok).toBe(true);
    trackKey(ctx, edgeless.data.id);
    await expectRefusal(
      "PATCH",
      "/items/{id}",
      await call("PATCH", `/items/${id}`, {
        key: edgeless.data.key,
        body: { version: 1, edges: { about: [await seedItem("edgeless")] } },
      }),
      403,
      "edge_permission_denied",
    );
  });
});

describe("an item door given a malformed id", () => {
  it("is refused 400 invalid_id on the metadata, tag, lifecycle and edge doors", async () => {
    const doors: [string, string, string, unknown][] = [
      ["GET", "/items/{id}/metadata", "/metadata", undefined],
      ["DELETE", "/items/{id}/tags/{tag}", "/tags/x", undefined],
      ["DELETE", "/items/{id}", "", undefined],
      ["POST", "/items/{id}/purge", "/purge", undefined],
      ["POST", "/items/{id}/restore", "/restore", undefined],
      ["GET", "/items/{id}/edges", "/edges", undefined],
      ["GET", "/items/{id}/backrefs", "/backrefs", undefined],
    ];
    for (const [method, template, suffix, body] of doors) {
      await expectRefusal(
        method,
        template,
        await call(method, `/items/${MALFORMED}${suffix}`, { body }),
        400,
        "invalid_id",
      );
    }
  });
});

describe("a body without a field the door requires", () => {
  it("is refused 400 missing_required_field, naming the field", async () => {
    const doors: [string, string, string][] = [
      ["POST", "/keys", "/keys"],
      ["POST", "/connectors", "/connectors"],
      ["POST", "/connectors/{id}/runs", `/connectors/${UNKNOWN}/runs`],
      [
        "POST",
        "/connectors/{id}/deliveries/handled",
        `/connectors/${UNKNOWN}/deliveries/handled`,
      ],
      ["POST", "/items/bulk-get", "/items/bulk-get"],
    ];
    for (const [method, template, path] of doors) {
      const answer = await call(method, path, { body: {} });
      await expectRefusal(
        method,
        template,
        answer,
        400,
        "missing_required_field",
      );
      expect(
        (answer.body as { error: { details?: { field?: string } } }).error
          .details?.field,
      ).toBeTruthy();
    }
  });
});

describe("client registration given a key", () => {
  it("is refused 401 invalid_token in the RFC's shape, and registers with no credential", async () => {
    const registration = {
      redirect_uris: ["https://example.com/callback"],
      client_name: `${ctx.source}-registration`,
    };
    const refused = await fetch(`${apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(registration),
    });
    const refusedBody = (await refused.json()) as { error?: string };
    expect(refused.status, JSON.stringify(refusedBody)).toBe(401);
    expect(refusedBody.error).toBe("invalid_token");
    await expectMatchesSchema(
      "POST",
      "/auth/oauth2/register",
      401,
      refusedBody,
    );

    // The witness: the same body with no credential registers.
    const accepted = await fetch(`${apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    });
    expect(accepted.status).toBe(201);
  });

  it("is refused 415 in the shape the document declares for a body that is not JSON", async () => {
    const refused = await fetch(`${apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        redirect_uris: "https://example.com/callback",
        client_name: `${ctx.source}-form-registration`,
      }).toString(),
    });
    const refusedBody = (await refused.json()) as { code?: string };
    expect(refused.status, JSON.stringify(refusedBody)).toBe(415);
    expect(refusedBody.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    await expectMatchesSchema(
      "POST",
      "/auth/oauth2/register",
      415,
      refusedBody,
    );
  });
});

describe("a deployment that caps live viewers", () => {
  // The cap is a setting, so it is asserted on a server of this file's own
  // rather than on the run's, where every other file's streams would count.
  it(
    "refuses a viewer past the cap 503",
    async () => {
      const server = await bootFreshServer("viewer-cap", {
        MARFA_SSE_MAX_VIEWERS: "1",
      });
      const held = new AbortController();
      try {
        const open = (signal?: AbortSignal) =>
          fetch(`${server.apiUrl}/events`, {
            headers: {
              Authorization: `Bearer ${server.workingKey}`,
              Accept: "text/event-stream",
            },
            signal,
          });
        const first = await open(held.signal);
        expect(first.status).toBe(200);

        const second = await open();
        expect(second.status).toBe(503);
        const body = (await second.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("stream_capacity_exhausted");
        await expectMatchesSchema("GET", "/events", 503, body);
      } finally {
        held.abort();
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});

describe("a session token", () => {
  // A registration keyed to a session token would be orphaned by its next
  // refresh, so the door refuses one. A session token is what the device
  // flow hands an app once a signed-in person approves it, so the flow runs
  // here over HTTP on a server of this file's own, which has an owner.
  it(
    "cannot register a connector",
    async () => {
      const server = await bootFreshServer("session-connector");
      try {
        const token = await approvedAppToken(server);
        expect(token).toMatch(/^marfa_at_/);

        const refused = await fetch(`${server.apiUrl}/connectors`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "session" }),
        });
        expect(refused.status).toBe(403);
        const body = (await refused.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("forbidden");
        await expectMatchesSchema("POST", "/connectors", 403, body);

        // Nor is it a key, so it does not read itself as one.
        const self = await fetch(`${server.apiUrl}/keys/current`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(self.status).toBe(403);
        const selfBody = (await self.json()) as { error?: { code?: string } };
        expect(selfBody.error?.code).toBe("forbidden");
        await expectMatchesSchema("GET", "/keys/current", 403, selfBody);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});

describe("a query key no door declares", () => {
  const STRAY = "definitely-not-a-filter";

  /** One request to a published door, carrying the stray key. */
  async function stray(
    method: string,
    template: string,
    key: string,
    id: string = UNKNOWN,
  ): Promise<{ status: number; unknown: unknown }> {
    const path = template.replace(/\{[^}]+\}/g, id);
    const response = await fetch(`${apiUrl}${path}?${STRAY}=1`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    // A door that fails to refuse may answer a stream that never ends, so
    // only a JSON body is read.
    if (!(response.headers.get("content-type") ?? "").includes("json")) {
      await response.body?.cancel();
      return { status: response.status, unknown: undefined };
    }
    const unknown = (
      (await response.json()) as {
        error?: { details?: { unknown_parameters?: unknown } };
      }
    ).error?.details?.unknown_parameters;
    return { status: response.status, unknown };
  }

  it("is refused 400 and named on every published door, the event stream included", async () => {
    const operatorKey = process.env.MARFA_OPERATOR_KEY;
    expect(operatorKey, "MARFA_OPERATOR_KEY is required").toBeTruthy();

    // The witness that the doors can be served at all: the same requests
    // without the stray key answer, so what follows is the key's refusal and
    // not a door that was never reachable.
    for (const path of ["/items", "/types", "/keys", "/events?edges=none"]) {
      const served = await fetch(`${apiUrl}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(served.status, path).toBe(200);
      await served.body?.cancel();
    }
    // And a key of the caller's own, which is ignored by contract.
    const own = await fetch(`${apiUrl}/items?_cache=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(own.status).toBe(200);

    // The replace door reads its path first: a type the key may not write is
    // refused before anything else, so it is asked about one the key owns.
    const ownType = `user.refusal_sweep_${ctx.runId.replaceAll("-", "_")}`;
    const registered = await client.registerType({
      id: ownType,
      label: "Refusal sweep",
      version: 0,
      fields: {},
    });
    expect(registered.ok).toBe(true);
    trackType(ctx, ownType, client);

    const doors = await publishedOperations();
    expect(doors.length).toBeGreaterThan(90);
    expect(doors.map((d) => `${d.method} ${d.path}`)).toContain("GET /events");

    const unrefused: string[] = [];
    for (const door of doors) {
      // The credential that may use the door: the per-test key holds every
      // permission, and the operator key holds the instance routes it does not.
      let refused = false;
      for (const key of [apiKey, operatorKey ?? ""]) {
        const { status, unknown } = await stray(
          door.method,
          door.path,
          key,
          door.method === "PUT" && door.path === "/types/{id}"
            ? ownType
            : UNKNOWN,
        );
        if (
          status === 400 &&
          Array.isArray(unknown) &&
          unknown.includes(STRAY)
        ) {
          refused = true;
          break;
        }
      }
      if (!refused) unrefused.push(`${door.method} ${door.path}`);
    }
    expect(unrefused.sort()).toEqual([]);
  }, 120_000);

  it("is refused after the credential, so a bare request still answers 401", async () => {
    for (const path of ["/items", "/types", "/keys", "/events"]) {
      const bare = await fetch(`${apiUrl}${path}?${STRAY}=1`);
      expect(bare.status, path).toBe(401);
      await bare.body?.cancel();
    }
  });

  it("names a misspelled key on the event stream rather than opening it unfiltered", async () => {
    const response = await fetch(`${apiUrl}/events?typ=core.note`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // A stream that opened is an answer that never ends: close it before
    // judging it.
    if (response.status !== 400) await response.body?.cancel();
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { details?: { unknown_parameters?: string[] } };
    };
    await expectRefusal(
      "GET",
      "/events",
      { status: response.status, body },
      400,
      "validation_error",
    );
    expect(body.error.details?.unknown_parameters).toEqual(["typ"]);
  });

  it("answers a copy stream request with a stray key 401, then 403 for a key that reads no type", async () => {
    const path = "/events?copy=1&edges=all&x=1";
    const bare = await fetch(`${apiUrl}${path}`);
    expect(bare.status).toBe(401);
    const operator = await fetch(`${apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${process.env.MARFA_OPERATOR_KEY}` },
    });
    expect(operator.status).toBe(403);
    const reader = await fetch(`${apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (reader.status !== 400) await reader.body?.cancel();
    expect(reader.status).toBe(400);
  });
});

describe("the write contention a door can meet", () => {
  it("is declared 503 write_contention on every operation that takes a credential, and on registration", async () => {
    const document = await servedDocument();
    const contention = {
      error: {
        code: "write_contention",
        message: "The database was busy.",
        details: { budget_ms: 5000 },
      },
    };
    const notContention = {
      error: { code: "item_not_found", message: "Not found." },
    };

    const takingACredential: string[] = [];
    const missing: string[] = [];
    const wrongShape: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) {
          continue;
        }
        const takes = (operation as { security?: unknown[] }).security;
        const door = `${method.toUpperCase()} ${path}`;
        if (
          (takes === undefined || takes.length === 0) &&
          path !== "/auth/oauth2/register"
        ) {
          continue;
        }
        takingACredential.push(door);
        const declared = operation.responses?.["503"];
        const schema = declared?.content?.["application/json"]?.schema;
        if (schema === undefined) {
          missing.push(door);
          continue;
        }
        const validate = validatorFor(schema, document);
        if (!validate(contention) || validate(notContention)) {
          wrongShape.push(door);
        }
      }
    }
    expect(takingACredential.length).toBeGreaterThan(90);
    expect(takingACredential).toContain("POST /auth/oauth2/register");
    expect(missing).toEqual([]);
    expect(wrongShape).toEqual([]);
  });
});

describe("the full volume a door can meet", () => {
  it("is declared 507 insufficient_storage on every operation that takes a credential", async () => {
    const document = await servedDocument();
    const full = {
      error: {
        code: "insufficient_storage",
        message: "The disk is full.",
      },
    };
    const notFull = {
      error: { code: "item_not_found", message: "Not found." },
    };

    const takingACredential: string[] = [];
    const missing: string[] = [];
    const wrongShape: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) {
          continue;
        }
        const takes = (operation as { security?: unknown[] }).security;
        if (takes === undefined || takes.length === 0) continue;
        const door = `${method.toUpperCase()} ${path}`;
        takingACredential.push(door);
        const declared = operation.responses?.["507"];
        const schema = declared?.content?.["application/json"]?.schema;
        if (schema === undefined) {
          missing.push(door);
          continue;
        }
        const validate = validatorFor(schema, document);
        if (!validate(full) || validate(notFull)) wrongShape.push(door);
      }
    }
    expect(takingACredential.length).toBeGreaterThan(90);
    expect(missing).toEqual([]);
    expect(wrongShape).toEqual([]);
  });
});
