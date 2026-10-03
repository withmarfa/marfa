import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiKeyRequest, TestContext } from "../../client/types.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  cleanup,
  newRunId,
  trackEdge,
  trackFolder,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import {
  openEventStream,
  type OpenEventStreamOptions,
  type SseEvent,
} from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "1"],
];
const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";
const FRAME_BUDGET_MS = 15_000;
const CHANGED = {
  error: {
    code: "read_view_changed",
    message: "The read view changed. Rebuild the working copy.",
  },
};

interface Proof {
  type: string;
  cursor: string;
  instance_id: string;
  read_view: string;
}

interface CopyItem {
  item: { id: string; version: number; source: string };
  metadata: unknown;
  listed: boolean;
  neighbors?: CopyItem[];
}

let server: FreshServer;
let client: MarfaClient;
let operator: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  server = await bootFreshServer("read-views");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
  ctx = {
    runId: newRunId(),
    source: "read-views",
    trackedItems: [],
    trackedKeys: [],
    trackedEdges: [],
    trackedEdgeTypes: [],
    trackedFolders: [],
    trackedWebhooks: [],
    trackedTypes: [],
    client,
    provisioningClient: operator,
  };
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (ctx) {
      try {
        const reset = await client.updateConfig({});
        expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
      } finally {
        await cleanup(ctx);
      }
    }
  } finally {
    await server?.stop();
  }
}, FRESH_SERVER_TIMEOUT_MS);

function request(path: string, proof?: string, key = server.workingKey) {
  return fetch(`${server.apiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      ...(proof === undefined ? {} : { "X-Marfa-Read-View": proof }),
    },
  });
}

function certified(response: Response, proof: string, status = 200) {
  expect(response.status, response.url).toBe(status);
  expect(response.headers.get("X-Marfa-Read-View")).toBe(proof);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Marfa-Contract")).toBeTruthy();
}

async function changed(response: Response) {
  expect(response.status, response.url).toBe(409);
  expect(await response.json()).toEqual(CHANGED);
  expect(response.headers.get("X-Error-Code")).toBe("read_view_changed");
  expect(response.headers.get("X-Marfa-Read-View")).toBeNull();
  expect(response.headers.get("Content-Type")).toContain("application/json");
}

async function mint(label: string, body: Partial<ApiKeyRequest> = {}) {
  const result = await operator.createKey({
    label,
    source: `${ctx.source}-${label}-${ctx.runId}`,
    ...body,
  });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  trackKey(ctx, result.data.id);
  return result.data;
}

async function seed(body: string, by = client) {
  const result = await by.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  trackItem(ctx, result.data.item.id);
  return result.data.item;
}

function marker(event: SseEvent, name: string): Proof {
  expect(event.event).toBe(name);
  expect(event.id).toBeUndefined();
  const proof = event.data as Proof;
  expect(Object.keys(proof).sort()).toEqual([
    "cursor",
    "instance_id",
    "read_view",
    "type",
  ]);
  expect(proof.type).toBe(name);
  expect(proof.cursor).toMatch(/^(0|[1-9][0-9]*)$/);
  expect(BigInt(proof.cursor)).toBeLessThanOrEqual(9223372036854775807n);
  expect(typeof proof.instance_id).toBe("string");
  expect(proof.instance_id.length).toBeGreaterThan(0);
  expect(proof.read_view).toMatch(/^[0-9a-f]{64}$/);
  return proof;
}

async function bootstrap(
  key = server.workingKey,
  resume?: Proof,
): Promise<Proof> {
  return withStream(
    server.apiUrl,
    key,
    {
      query: COPY_QUERY,
      ...(resume
        ? { lastEventId: resume.cursor, readView: resume.read_view }
        : {}),
    },
    async (stream) => {
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get("Content-Type")).toContain(
        "text/event-stream",
      );
      expect(stream.response.headers.get("X-Marfa-Read-View")).toBeNull();
      const { events } = await collectUntil(
        stream,
        (frames) => frames.some((frame) => frame.event === "stream_live"),
        "the copy stream's validated live marker",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      );
      const head = marker(events[0]!, "stream_cursor");
      const live = marker(
        events.find((frame) => frame.event === "stream_live")!,
        "stream_live",
      );
      expect(live.instance_id).toBe(head.instance_id);
      expect(live.read_view).toBe(head.read_view);
      expect(BigInt(live.cursor)).toBeGreaterThanOrEqual(BigInt(head.cursor));
      for (const event of events.filter((event) => event.id !== undefined)) {
        expect(BigInt(live.cursor)).toBeGreaterThanOrEqual(BigInt(event.id!));
      }
      if (resume) {
        expect(head.instance_id).toBe(resume.instance_id);
        expect(head.read_view).toBe(resume.read_view);
        expect(BigInt(live.cursor)).toBeGreaterThanOrEqual(
          BigInt(resume.cursor),
        );
      }
      return live;
    },
  );
}

describe("conditional working-copy read views", () => {
  it("bootstraps and resumes with one instance, cursor and opaque read view", async () => {
    const initial = await bootstrap();
    const root = await request("/");
    expect(root.status).toBe(200);
    expect(((await root.json()) as { instance_id: string }).instance_id).toBe(
      initial.instance_id,
    );
    await seed("a replayable copy row");
    await bootstrap(server.workingKey, initial);
  });

  it("rejects every alternate copy grammar before starting a stream", async () => {
    const proof = await bootstrap();
    const cases: OpenEventStreamOptions[] = [
      { query: [["copy", "1"]] },
      {
        query: [
          ["edges", "none"],
          ["copy", "1"],
        ],
      },
      {
        query: [
          ["edges", "all"],
          ["copy", "0"],
        ],
      },
      { query: [...COPY_QUERY, ["type", "core.note"]] },
      { query: [...COPY_QUERY, ["unknown", "1"]] },
      { query: [...COPY_QUERY, ["copy", "1"]] },
      { query: [...COPY_QUERY, ["edges", "all"]] },
      { query: COPY_QUERY, lastEventId: proof.cursor },
      { query: COPY_QUERY, readView: proof.read_view },
      { query: COPY_QUERY, lastEventId: "", readView: proof.read_view },
      { query: COPY_QUERY, lastEventId: "01", readView: proof.read_view },
      {
        query: COPY_QUERY,
        lastEventId: "9223372036854775808",
        readView: proof.read_view,
      },
      { query: COPY_QUERY, lastEventId: proof.cursor, readView: "" },
      {
        query: COPY_QUERY,
        lastEventId: proof.cursor,
        readView: "A".repeat(64),
      },
      {
        query: COPY_QUERY,
        lastEventId: proof.cursor,
        readView: "g".repeat(64),
      },
      {
        query: COPY_QUERY,
        lastEventId: proof.cursor,
        readView: proof.read_view,
        headers: [["X-Marfa-Read-View", proof.read_view]],
      },
      {
        query: COPY_QUERY,
        lastEventId: proof.cursor,
        readView: proof.read_view,
        headers: [["Last-Event-ID", proof.cursor]],
      },
      { query: [["edges", "all"]], readView: proof.read_view },
    ];
    for (const options of cases) {
      await withStream(
        server.apiUrl,
        server.workingKey,
        options,
        async (stream) => {
          expect(stream.response.status, JSON.stringify(options)).toBe(400);
          expect(
            ((await stream.response.json()) as { error: { code: string } })
              .error.code,
          ).toBe("validation_error");
          expect(stream.response.headers.get("X-Marfa-Read-View")).toBeNull();
        },
      );
    }
    const wrong = `${proof.read_view[0] === "0" ? "1" : "0"}${proof.read_view.slice(1)}`;
    await changed(await request("/items?include=metadata", wrong));
    await withStream(
      server.apiUrl,
      server.workingKey,
      {
        query: COPY_QUERY,
        lastEventId: proof.cursor,
        readView: wrong,
      },
      async (stream) => {
        await changed(stream.response);
      },
    );
    await bootstrap(server.workingKey, proof);
    await withStream(
      server.apiUrl,
      server.workingKey,
      { lastEventId: "" },
      async (stream) => {
        expect(stream.response.status).toBe(200);
      },
    );
  });

  it("walks conditional metadata pages to explicit null and certifies every supported read door", async () => {
    const rows = [
      await seed("page one"),
      await seed("page two"),
      await seed("page three"),
    ];
    const edge = await client.createEdge({
      source_id: rows[0]!.id,
      target_id: rows[1]!.id,
      edge_type: "about",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
    const proof = await bootstrap();
    const seen: string[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 30; page++) {
      const query = new URLSearchParams({
        source: ctx.source,
        include: "metadata,edges",
        limit: "1",
      });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await request(
        `/items?${query.toString()}`,
        proof.read_view,
      );
      certified(response, proof.read_view);
      const body = (await response.json()) as {
        data: CopyItem[];
        next_cursor: string | null;
        read_view?: unknown;
      };
      expect(body).not.toHaveProperty("read_view");
      expect(body).toHaveProperty("next_cursor");
      for (const row of body.data) {
        expect(row.listed).toBe(true);
        expect(row).toHaveProperty("metadata");
        seen.push(row.item.id);
      }
      cursor = body.next_cursor;
      if (cursor === null) break;
      expect(typeof cursor).toBe("string");
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    for (const row of rows) expect(seen).toContain(row.id);
    for (const path of [
      `/items/${rows[0]!.id}`,
      `/items/${rows[0]!.id}/edges`,
      "/edges?edge_type=about",
      `/edges/${edge.data.edge.id}`,
      "/types",
      "/edge-types",
      "/keys/current",
    ]) {
      const response = await request(path, proof.read_view);
      certified(response, proof.read_view);
      const body = (await response.json()) as {
        edge?: unknown;
        data?: unknown[];
      };
      expect(body).not.toHaveProperty("read_view");
      if (path.startsWith("/edges") || path.endsWith("/edges")) {
        if (body.edge) expect(body.edge).not.toHaveProperty("listed");
        for (const edge of body.data ?? [])
          expect(edge).not.toHaveProperty("listed");
      }
    }
    const empty = await request(
      `/items?source=${ctx.source}-empty&include=metadata`,
      proof.read_view,
    );
    certified(empty, proof.read_view);
    expect(await empty.json()).toEqual({ data: [], next_cursor: null });
    for (const path of ["/items?include=metadata", `/items/${rows[0]!.id}`]) {
      const ordinary = await request(path);
      expect(ordinary.status).toBe(200);
      expect(ordinary.headers.get("X-Marfa-Read-View")).toBeNull();
    }
  });

  it("rejects unsupported conditional doors, malformed proofs and metadata-free item pages", async () => {
    const proof = await bootstrap();
    for (const path of [
      "/",
      "/items/stats",
      "/items",
      "/items?include=edges",
      "/config",
      `/items/${UNKNOWN_ID}/versions`,
    ]) {
      const ordinary = await request(path);
      expect([200, 404]).toContain(ordinary.status);
      const response = await request(path, proof.read_view);
      expect(response.status, path).toBe(400);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("validation_error");
      expect(response.headers.get("X-Marfa-Read-View")).toBeNull();
    }
    for (const value of [
      "",
      "a".repeat(63),
      "A".repeat(64),
      "g".repeat(64),
      `${proof.read_view}, ${proof.read_view}`,
    ]) {
      const response = await request("/items?include=metadata", value);
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("validation_error");
      expect(response.headers.get("X-Marfa-Read-View")).toBeNull();
    }
    const anonymous = await fetch(`${server.apiUrl}/items?include=metadata`, {
      headers: { "X-Marfa-Read-View": proof.read_view },
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("X-Marfa-Read-View")).toBeNull();
    certified(
      await request("/items?include=metadata", proof.read_view),
      proof.read_view,
    );
  });

  it("classifies source-excluded direct items and neighbors without admitting them to a listed page", async () => {
    const other = await mint("source-excluded");
    const excluded = await seed(
      "directly readable excluded source",
      new MarfaClient({ baseUrl: server.apiUrl, apiKey: other.key }),
    );
    const included = await seed("listed source control");
    const edge = await client.createEdge({
      source_id: included.id,
      target_id: excluded.id,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
    const before = await bootstrap();
    const beforeRead = await request(`/items/${excluded.id}`, before.read_view);
    certified(beforeRead, before.read_view);
    expect(((await beforeRead.json()) as CopyItem).listed).toBe(true);
    const configured = await client.updateConfig({
      enforcement: {
        source_filter: { types: ["core.note"], sources: [ctx.source] },
      },
    });
    expect(configured.ok, JSON.stringify(configured.error)).toBe(true);
    await changed(await request(`/items/${excluded.id}`, before.read_view));
    const proof = await bootstrap();
    const direct = await request(`/items/${excluded.id}`, proof.read_view);
    certified(direct, proof.read_view);
    expect(((await direct.json()) as CopyItem).listed).toBe(false);
    const neighborhood = await request(
      `/items/${included.id}?include=neighbors`,
      proof.read_view,
    );
    certified(neighborhood, proof.read_view);
    const neighbors = (await neighborhood.json()) as CopyItem;
    expect(neighbors.listed).toBe(true);
    expect(
      neighbors.neighbors?.find((row) => row.item.id === excluded.id)?.listed,
    ).toBe(false);
    const page = await request(
      "/items?type=core.note&include=metadata&limit=200",
      proof.read_view,
    );
    certified(page, proof.read_view);
    const listed = (await page.json()) as { data: CopyItem[] };
    expect(
      listed.data.some((row) => row.item.id === included.id && row.listed),
    ).toBe(true);
    expect(listed.data.some((row) => row.item.id === excluded.id)).toBe(false);
    expect((await client.updateConfig({})).ok).toBe(true);
  });

  it("keeps the read view across content, metadata and write-only authority changes", async () => {
    const key = await mint("stable", {
      type_permissions: { "core.note": "read" },
      permissions: [],
    });
    const proof = await bootstrap(key.key);
    const row = await seed("ordinary content control");
    expect(
      (
        await client.updateItem(row.id, {
          version: row.version,
          properties: { body: "updated content" },
        })
      ).ok,
    ).toBe(true);
    expect((await client.addTags(row.id, ["changed-metadata"])).ok).toBe(true);
    const widenedWrites = await operator.updateKey(key.id, {
      type_permissions: { "core.note": "write" },
      permissions: ["keys.mint"],
      sources: [ctx.source],
    });
    expect(widenedWrites.ok, JSON.stringify(widenedWrites.error)).toBe(true);
    const read = await request(`/items/${row.id}`, proof.read_view, key.key);
    certified(read, proof.read_view);
    const next = await bootstrap(key.key, proof);
    expect(next.read_view).toBe(proof.read_view);
  });

  it("delivers source-excluded update, metadata, delete and restore carriers with listed false", async () => {
    const key = await mint("excluded-events");
    const writer = new MarfaClient({ baseUrl: server.apiUrl, apiKey: key.key });
    const row = await seed("source-excluded event witness", writer);
    const before = await bootstrap();
    const visible = await request(`/items/${row.id}`, before.read_view);
    certified(visible, before.read_view);
    expect(((await visible.json()) as CopyItem).listed).toBe(true);
    const configured = await client.updateConfig({
      enforcement: {
        source_filter: { types: ["core.note"], sources: [ctx.source] },
      },
    });
    expect(configured.ok).toBe(true);
    try {
      await withStream(
        server.apiUrl,
        server.workingKey,
        { query: COPY_QUERY },
        async (stream) => {
          expect(stream.response.status).toBe(200);
          await collectUntil(
            stream,
            (events) => events.some((event) => event.event === "stream_live"),
            "source-excluded stream live marker",
            AbortSignal.timeout(FRAME_BUDGET_MS),
          );
          const receive = async (
            name: string,
            write: () => Promise<{ ok: boolean }>,
          ) => {
            expect((await write()).ok).toBe(true);
            const received = await collectUntil(
              stream,
              (events) =>
                events.some(
                  (event) =>
                    event.event === name &&
                    (event.data as CopyItem).item?.id === row.id,
                ),
              `source-excluded ${name}`,
              AbortSignal.timeout(FRAME_BUDGET_MS),
            );
            const event = received.events.find(
              (event) =>
                event.event === name &&
                (event.data as CopyItem).item?.id === row.id,
            )!;
            expect(event.id).toMatch(/^[1-9][0-9]*$/);
            expect((event.data as CopyItem).listed).toBe(false);
            if (name === "metadata.changed")
              expect(event.data).toHaveProperty("metadata");
          };
          await receive("item.updated", () =>
            writer.updateItem(row.id, {
              version: row.version,
              properties: { body: "excluded update" },
            }),
          );
          await receive("metadata.changed", () =>
            writer.addTags(row.id, ["excluded-metadata"]),
          );
          await receive("item.deleted", () => writer.deleteItem(row.id));
          await receive("item.restored", () => writer.restoreItem(row.id));
        },
      );
    } finally {
      expect((await client.updateConfig({})).ok).toBe(true);
    }
  });

  it("refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing", async () => {
    const row = await seed("retype witness");
    const target = await seed("retype edge target");
    const edge = await client.createEdge({
      source_id: row.id,
      target_id: target.id,
      edge_type: "about",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
    const proof = await bootstrap();
    const paths = [
      "/items?include=metadata",
      `/items/${row.id}`,
      `/items/${row.id}/edges`,
      "/edges",
      `/edges/${edge.data.edge.id}`,
      "/types",
      "/edge-types",
      "/keys/current",
    ];
    for (const path of paths) {
      const response = await request(path, proof.read_view);
      certified(response, proof.read_view);
      await response.json();
    }
    const retyped = await client.updateItem(row.id, {
      version: row.version,
      type: "core.bookmark",
      retype: true,
      properties: { url: "https://example.com/read-view" },
    });
    expect(retyped.ok, JSON.stringify(retyped.error)).toBe(true);
    for (const path of paths) {
      await changed(await request(path, proof.read_view));
    }
    await changed(await request(`/items/${UNKNOWN_ID}`, proof.read_view));
    await withStream(
      server.apiUrl,
      server.workingKey,
      {
        query: COPY_QUERY,
        lastEventId: proof.cursor,
        readView: proof.read_view,
      },
      async (stream) => {
        await changed(stream.response);
      },
    );
    const rebuilt = await bootstrap();
    expect(rebuilt.read_view).not.toBe(proof.read_view);
    certified(
      await request(`/items/${row.id}`, rebuilt.read_view),
      rebuilt.read_view,
    );
    const key = await mint("narrowed", {
      type_permissions: { "core.note": "read" },
      permissions: [],
    });
    const before = await bootstrap(key.key);
    const note = await seed("narrowing witness");
    certified(
      await request(`/items/${note.id}`, before.read_view, key.key),
      before.read_view,
    );
    expect(
      (await operator.updateKey(key.id, { type_permissions: {} })).ok,
    ).toBe(true);
    await changed(
      await request("/items?include=metadata", before.read_view, key.key),
    );
    await changed(
      await request(`/items/${note.id}`, before.read_view, key.key),
    );
    await withStream(
      server.apiUrl,
      key.key,
      {
        query: COPY_QUERY,
        lastEventId: before.cursor,
        readView: before.read_view,
      },
      async (stream) => {
        await changed(stream.response);
      },
    );
    expect(
      (await request(`/items/${note.id}`, undefined, key.key)).status,
    ).toBe(403);
  });

  it("certifies matching resource absence without certifying generic validation or authentication failures", async () => {
    const row = await seed("absence witness");
    const key = await mint("absence-reader", {
      type_permissions: { "core.note": "read" },
      permissions: [],
    });
    const proof = await bootstrap(key.key);
    certified(
      await request(`/items/${row.id}`, proof.read_view, key.key),
      proof.read_view,
    );
    expect((await client.deleteItem(row.id)).ok).toBe(true);
    for (const path of [
      `/items/${row.id}`,
      `/items/${UNKNOWN_ID}`,
      `/edges/${UNKNOWN_ID}`,
    ]) {
      const response = await request(path, proof.read_view, key.key);
      certified(response, proof.read_view, 404);
      expect(await response.json()).not.toHaveProperty("read_view");
    }
    const malformed = await request(
      "/items/not-an-id",
      proof.read_view,
      key.key,
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("X-Marfa-Read-View")).toBeNull();
    const invalidCredential = await request(
      `/items/${UNKNOWN_ID}`,
      proof.read_view,
      "invalid",
    );
    expect(invalidCredential.status).toBe(401);
    expect(invalidCredential.headers.get("X-Marfa-Read-View")).toBeNull();
  });

  it("certifies an approved app's current-key refusal under its matching read view", async () => {
    const token = await approvedAppToken(server);
    const proof = await bootstrap(token);
    certified(
      await request("/items?include=metadata", proof.read_view, token),
      proof.read_view,
    );
    const ordinary = await request("/keys/current", undefined, token);
    expect(ordinary.status).toBe(403);
    expect(ordinary.headers.get("X-Marfa-Read-View")).toBeNull();
    const refused = await request("/keys/current", proof.read_view, token);
    certified(refused, proof.read_view, 403);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("forbidden");
  });

  it("ends an open copy stream with a no-id detail-free terminal after a structural change", async () => {
    const row = await seed("live structural witness");
    const stream = await openEventStream(server.apiUrl, server.workingKey, {
      query: COPY_QUERY,
      connectTimeoutMs: FRAME_BUDGET_MS,
    });
    try {
      expect(stream.response.status).toBe(200);
      const opened = await collectUntil(
        stream,
        (events) => events.some((event) => event.event === "stream_live"),
        "initial copy live marker",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      );
      marker(opened.events[0]!, "stream_cursor");
      const content = await client.updateItem(row.id, {
        version: row.version,
        properties: { body: "same-view live mutation" },
      });
      expect(content.ok).toBe(true);
      const witness = await collectUntil(
        stream,
        (events) => events.some((event) => event.event === "item.updated"),
        "ordinary live mutation before invalidation",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      );
      const frame = witness.events.find(
        (event) => event.event === "item.updated",
      )!;
      expect(frame.id).toMatch(/^[1-9][0-9]*$/);
      expect((frame.data as CopyItem).listed).toBe(true);
      expect(
        (
          await client.updateItem(row.id, {
            version: content.data.item.version,
            type: "core.bookmark",
            retype: true,
            properties: { url: "https://example.com/terminal" },
          })
        ).ok,
      ).toBe(true);
      const ended = await collectUntil(
        stream,
        (events) => events.some((event) => event.event === "read_view_changed"),
        "read-view invalidation terminal",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      );
      expect(ended.events).toEqual([
        { event: "read_view_changed", data: { type: "read_view_changed" } },
      ]);
      const reader = stream.response.body!.getReader();
      const deadline = AbortSignal.timeout(FRAME_BUDGET_MS);
      const onAbort = () => void reader.cancel();
      deadline.addEventListener("abort", onAbort, { once: true });
      try {
        const remaining = await reader.read();
        expect(deadline.aborted, "the terminal must close the stream").toBe(
          false,
        );
        expect(remaining.done).toBe(true);
        expect(remaining.value).toBeUndefined();
      } finally {
        deadline.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
    } finally {
      await stream.close();
    }
  });

  it("returns item, edge and folder write receipts without a read-view certificate", async () => {
    const proof = await bootstrap();
    const write = async (path: string, body: unknown) =>
      fetch(`${server.apiUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server.workingKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const item = await write("/items", {
      type: "core.note",
      properties: { body: "uncertified receipt" },
    });
    expect(item.status).toBe(201);
    expect(item.headers.get("X-Marfa-Read-View")).toBeNull();
    const body = (await item.json()) as CopyItem;
    expect(body).not.toHaveProperty("read_view");
    trackItem(ctx, body.item.id);
    const target = await seed("receipt edge target");
    const edge = await write("/edges", {
      source_id: body.item.id,
      target_id: target.id,
      edge_type: "about",
    });
    expect(edge.status).toBe(201);
    expect(edge.headers.get("X-Marfa-Read-View")).toBeNull();
    const edgeBody = (await edge.json()) as { edge: { id: string } };
    expect(edgeBody).not.toHaveProperty("read_view");
    trackEdge(ctx, edgeBody.edge.id);
    const folder = await write("/folders", { title: "Read-view receipt" });
    expect(folder.status).toBe(201);
    expect(folder.headers.get("X-Marfa-Read-View")).toBeNull();
    const folderBody = (await folder.json()) as { item: { id: string } };
    expect(folderBody).not.toHaveProperty("read_view");
    trackFolder(ctx, folderBody.item.id);
    certified(
      await request(`/items/${body.item.id}`, proof.read_view),
      proof.read_view,
    );
  });
});
