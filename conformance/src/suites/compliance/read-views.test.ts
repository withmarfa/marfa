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
  trackEdgeType,
  trackFolder,
  trackItem,
  trackKey,
  trackType,
} from "../../utils/setup.js";
import {
  openEventStream,
  type EventStream,
  type OpenEventStreamOptions,
  type SseEvent,
} from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { TEST_OWNER } from "../../utils/target.js";

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
  event_type: string;
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
let appToken: Promise<string> | undefined;
let client: MarfaClient;
let owner: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  server = await bootFreshServer("read-views");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
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
    provisioningClient: owner,
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

/** An instance has one owner, so the approved app is made once per server. */
function approvedApp(): Promise<string> {
  appToken ??= approvedAppToken(server);
  return appToken;
}

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
  const result = await owner.createKey({
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

async function expectClosed(stream: EventStream) {
  const reader = stream.response.body!.getReader();
  const deadline = AbortSignal.timeout(FRAME_BUDGET_MS);
  const onAbort = () => void reader.cancel();
  deadline.addEventListener("abort", onAbort, { once: true });
  try {
    const remaining = await reader.read();
    expect(deadline.aborted, "the terminal must close the stream").toBe(false);
    expect(remaining.done).toBe(true);
    expect(remaining.value).toBeUndefined();
  } finally {
    deadline.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

/** Whether the credential's own view still stands, and the view it moved to. */
async function holds(proof: Proof, key = server.workingKey) {
  certified(
    await request("/items?include=metadata", proof.read_view, key),
    proof.read_view,
  );
  expect((await bootstrap(key, proof)).read_view).toBe(proof.read_view);
}

async function moves(proof: Proof, key = server.workingKey) {
  await changed(await request("/items?include=metadata", proof.read_view, key));
  const next = await bootstrap(key);
  expect(next.read_view).not.toBe(proof.read_view);
  return next;
}

async function seedEdge(
  from: string,
  to: string,
  edgeType = "about",
  by = client,
) {
  const result = await by.createEdge({
    source_id: from,
    target_id: to,
    edge_type: edgeType,
  });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  trackEdge(ctx, result.data.edge.id);
  return result.data.edge;
}

function doors(item: string, edge: string) {
  return [
    "/items?include=metadata",
    `/items/${item}`,
    `/items/${item}/edges`,
    "/edges",
    `/edges/${edge}`,
    "/types",
    "/edge-types",
    "/keys/current",
  ];
}

function marker(event: SseEvent, name: string): Proof {
  expect(event.event).toBe(name);
  expect(event.id).toBeUndefined();
  const proof = event.data as Proof;
  expect(Object.keys(proof).sort()).toEqual([
    "cursor",
    "event_type",
    "instance_id",
    "read_view",
  ]);
  expect(proof.event_type).toBe(name);
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
    const widenedWrites = await owner.updateKey(key.id, {
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
    expect((await owner.updateKey(key.id, { type_permissions: {} })).ok).toBe(
      true,
    );
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
    const token = await approvedApp();
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
        {
          event: "read_view_changed",
          data: { event_type: "read_view_changed" },
        },
      ]);
      await expectClosed(stream);
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

describe("what a read view is bound to", () => {
  it("answers 409 to a read view minted for another credential, on every door and on resume", async () => {
    const row = await seed("credential witness");
    const target = await seed("credential witness target");
    const edge = await seedEdge(row.id, target.id);
    const reach = {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
      permissions: [],
    };
    const first = await mint("credential-first", reach);
    const second = await mint("credential-second", reach);
    const own = await bootstrap(first.key);
    const other = await bootstrap(second.key);
    expect(other.instance_id).toBe(own.instance_id);
    expect(other.read_view).not.toBe(own.read_view);
    for (const path of doors(row.id, edge.id)) {
      certified(await request(path, own.read_view, first.key), own.read_view);
      certified(
        await request(path, other.read_view, second.key),
        other.read_view,
      );
      await changed(await request(path, own.read_view, second.key));
      await changed(await request(path, other.read_view, first.key));
    }
    await withStream(
      server.apiUrl,
      second.key,
      {
        query: COPY_QUERY,
        lastEventId: own.cursor,
        readView: own.read_view,
      },
      async (stream) => {
        await changed(stream.response);
      },
    );
    await bootstrap(second.key, other);
  });

  it("changes the read view when a key's edge reads narrow or widen, and keeps it when only edge writes change", async () => {
    const key = await mint("edge-reach", {
      type_permissions: { "*": "read" },
      edge_permissions: { about: "read" },
      permissions: [],
    });
    const middle = await bootstrap(key.key);
    const update = async (edge_permissions: Record<string, string>) => {
      const result = await owner.updateKey(key.id, { edge_permissions });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
    };
    await update({});
    const narrowed = await moves(middle, key.key);
    await update({ about: "read", "parent-of": "read" });
    const widened = await moves(narrowed, key.key);
    expect(widened.read_view).not.toBe(middle.read_view);
    await update({ about: "write", "parent-of": "read" });
    await holds(widened, key.key);
    await update({ about: "read" });
    await holds(middle, key.key);
  });

  it("changes the read view when a key's metadata reads narrow or widen, and keeps it when only metadata writes change", async () => {
    const key = await mint("metadata-reach", {
      type_permissions: { "*": "read" },
      metadata_permissions: { tags: "read" },
      permissions: [],
    });
    const middle = await bootstrap(key.key);
    const update = async (metadata_permissions: Record<string, string>) => {
      const result = await owner.updateKey(key.id, { metadata_permissions });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
    };
    await update({});
    const narrowed = await moves(middle, key.key);
    await update({ "*": "read" });
    const widened = await moves(narrowed, key.key);
    expect(widened.read_view).not.toBe(middle.read_view);
    await update({ "*": "write" });
    await holds(widened, key.key);
    await update({ tags: "read" });
    await holds(middle, key.key);
  });

  it("changes the read view when a key's extension reads narrow or widen, and keeps it when only extension writes change", async () => {
    const key = await mint("extension-reach", {
      type_permissions: { "*": "read" },
      extension_permissions: { acme: "read" },
      permissions: [],
    });
    const middle = await bootstrap(key.key);
    const update = async (extension_permissions: Record<string, string>) => {
      const result = await owner.updateKey(key.id, {
        extension_permissions,
      });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
    };
    await update({});
    const narrowed = await moves(middle, key.key);
    await update({ "*": "read" });
    const widened = await moves(narrowed, key.key);
    expect(widened.read_view).not.toBe(middle.read_view);
    await update({ "*": "write" });
    await holds(widened, key.key);
    await update({ acme: "read" });
    await holds(middle, key.key);
  });

  it("changes the read view when a key's own source filter narrows, widens or clears", async () => {
    const writer = await mint("override-writer");
    const outside = await seed(
      "outside the override",
      new MarfaClient({ baseUrl: server.apiUrl, apiKey: writer.key }),
    );
    const key = await mint("override-reader", {
      type_permissions: { "*": "read" },
      permissions: [],
    });
    const open = await bootstrap(key.key);
    const listedUnder = async (proof: Proof) => {
      const response = await request(
        `/items/${outside.id}`,
        proof.read_view,
        key.key,
      );
      certified(response, proof.read_view);
      return ((await response.json()) as CopyItem).listed;
    };
    expect(await listedUnder(open)).toBe(true);
    const update = async (sources: string[]) => {
      const result = await owner.updateKey(key.id, {
        enforcement_override: {
          source_filter: { types: ["core.note"], sources },
        },
      });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
    };
    await update([ctx.source]);
    const narrowed = await moves(open, key.key);
    expect(await listedUnder(narrowed)).toBe(false);
    await update([ctx.source, writer.source!]);
    const widened = await moves(narrowed, key.key);
    expect(await listedUnder(widened)).toBe(true);
    expect(widened.read_view).not.toBe(open.read_view);
    const cleared = await owner.updateKey(key.id, {
      enforcement_override: null,
    });
    expect(cleared.ok, JSON.stringify(cleared.error)).toBe(true);
    await holds(open, key.key);
    await changed(
      await request("/items?include=metadata", widened.read_view, key.key),
    );
  });
});

describe("what moves a read view", () => {
  it("changes the read view when an edge moves to another source, and keeps it when only the target moves", async () => {
    const from = await seed("move source");
    const to = await seed("move target");
    const farther = await seed("move farther target");
    const elsewhere = await seed("move other source");
    const proof = await bootstrap();
    const edge = await seedEdge(from.id, to.id, "supersedes");
    const extra = await seedEdge(to.id, farther.id);
    expect((await client.deleteEdge(extra.id)).ok).toBe(true);
    await holds(proof);
    const retargeted = await client.updateEdge(edge.id, {
      target_id: farther.id,
      version: edge.version,
    });
    expect(retargeted.ok, JSON.stringify(retargeted.error)).toBe(true);
    expect(retargeted.data.edge.target_id).toBe(farther.id);
    await holds(proof);
    const resourced = await client.updateEdge(edge.id, {
      source_id: elsewhere.id,
      version: retargeted.data.edge.version,
    });
    expect(resourced.ok, JSON.stringify(resourced.error)).toBe(true);
    expect(resourced.data.edge.source_id).toBe(elsewhere.id);
    await moves(proof);
  });

  it("changes the read view when a custom type is created, re-parented or deleted, and keeps it when an update keeps the parent", async () => {
    const parent = `user.view-parent-${ctx.runId}`;
    const sibling = `user.view-sibling-${ctx.runId}`;
    const child = `${parent}.child`;
    const register = async (id: string, parentId?: string) => {
      const result = await client.registerType({
        id,
        ...(parentId === undefined ? {} : { parent: parentId }),
        fields: { name: { type: "string" } },
      });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      trackType(ctx, id, client, parentId);
    };
    let proof = await bootstrap();
    await register(parent);
    proof = await moves(proof);
    await register(sibling);
    proof = await moves(proof);
    await register(child, parent);
    proof = await moves(proof);
    const described = await client.replaceType(child, {
      id: child,
      parent,
      version: 1,
      description: "same parent",
      fields: { name: { type: "string" } },
    });
    expect(described.ok, JSON.stringify(described.error)).toBe(true);
    await holds(proof);
    const reparented = await client.replaceType(child, {
      id: child,
      parent: sibling,
      version: 2,
      fields: { name: { type: "string" } },
    });
    expect(reparented.ok, JSON.stringify(reparented.error)).toBe(true);
    proof = await moves(proof);
    const deleted = await client.deleteType(child);
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    await moves(proof);
  });

  it("changes the read view when a custom edge type is created or deleted", async () => {
    const id = `mock.view.${ctx.runId}`;
    const proof = await bootstrap();
    const registered = await client.registerEdgeType({
      id,
      cardinality: "many-to-many",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, id);
    const created = await moves(proof);
    const removed = await client.deleteEdgeType(id);
    expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
    await moves(created);
  });

  it("keeps the read view across a tier change, a state change, a trash and a restore", async () => {
    const row = await seed("ordinary lifecycle");
    const proof = await bootstrap();
    const tiered = await client.updateItem(row.id, {
      version: row.version,
      tier: "feed",
    });
    expect(tiered.ok, JSON.stringify(tiered.error)).toBe(true);
    expect(tiered.data.item.tier).toBe("feed");
    await holds(proof);
    const archived = await client.transitionItem(row.id, "archived");
    expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
    await holds(proof);
    expect((await client.deleteItem(row.id)).ok).toBe(true);
    await holds(proof);
    expect((await client.restoreItem(row.id)).ok).toBe(true);
    await holds(proof);
  });

  it("changes the read view when a bulk write retypes an item, and keeps it when the type is unchanged", async () => {
    const row = await seed("bulk retype witness");
    const proof = await bootstrap();
    const same = await client.bulkItems({
      retype: true,
      items: [
        { id: row.id, type: "core.note", properties: { body: "same type" } },
      ],
    });
    expect(same.ok, JSON.stringify(same.error)).toBe(true);
    expect(same.data.counts.updated).toBe(1);
    await holds(proof);
    const retyped = await client.bulkItems({
      retype: true,
      items: [
        {
          id: row.id,
          type: "core.bookmark",
          properties: { url: "https://example.com/bulk-retype" },
        },
      ],
    });
    expect(retyped.ok, JSON.stringify(retyped.error)).toBe(true);
    expect(retyped.data.counts.updated).toBe(1);
    await moves(proof);
  });
});

describe("what a read view certifies and what it outranks", () => {
  it("certifies type not permitted, edge permission denied and a hidden-type absence under the matching read view", async () => {
    const note = await seed("refusal note");
    const bookmark = await client.createItem({
      type: "core.bookmark",
      properties: { url: "https://example.com/refusal" },
    });
    expect(bookmark.ok, JSON.stringify(bookmark.error)).toBe(true);
    trackItem(ctx, bookmark.data.item.id);
    const seeAbout = await mint("refusal-about", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
      permissions: [],
    });
    const noEdges = await mint("refusal-no-edges", {
      type_permissions: { "core.note": "read" },
      edge_permissions: {},
      permissions: [],
    });
    const full = await bootstrap();
    const sees = await bootstrap(seeAbout.key);
    const blind = await bootstrap(noEdges.key);
    const refusal = async (
      path: string,
      proof: Proof,
      key: string,
      status: number,
      code: string,
    ) => {
      const response = await request(path, proof.read_view, key);
      certified(response, proof.read_view, status);
      expect(response.headers.get("X-Error-Code")).toBe(code);
      expect(await errorCode(response)).toBe(code);
    };

    const bookmarks = "/items?include=metadata&type=core.bookmark";
    certified(await request(bookmarks, full.read_view), full.read_view);
    certified(
      await request(
        "/items?include=metadata&type=core.note",
        sees.read_view,
        seeAbout.key,
      ),
      sees.read_view,
    );
    await refusal(bookmarks, sees, seeAbout.key, 403, "type_not_permitted");

    const filtered = `/items?include=metadata&edge[about]=${note.id}`;
    certified(
      await request(filtered, sees.read_view, seeAbout.key),
      sees.read_view,
    );
    await refusal(filtered, blind, noEdges.key, 403, "edge_permission_denied");

    certified(
      await request(`/items/${bookmark.data.item.id}`, full.read_view),
      full.read_view,
    );
    certified(
      await request(`/items/${note.id}`, sees.read_view, seeAbout.key),
      sees.read_view,
    );
    await refusal(
      `/items/${bookmark.data.item.id}`,
      sees,
      seeAbout.key,
      404,
      "item_not_found",
    );
  });

  it("answers 409 before a validation 400 and before a resource 403 under a stale read view", async () => {
    const target = await seed("precedence target");
    const bookmark = await client.createItem({
      type: "core.bookmark",
      properties: { url: "https://example.com/precedence" },
    });
    expect(bookmark.ok, JSON.stringify(bookmark.error)).toBe(true);
    trackItem(ctx, bookmark.data.item.id);
    const noEdges = await mint("precedence-no-edges", {
      type_permissions: { "core.note": "read" },
      edge_permissions: {},
      permissions: [],
    });
    const token = await approvedApp();
    const reader = await bootstrap(noEdges.key);
    const app = await bootstrap(token);
    const cases = [
      {
        path: "/items?include=metadata&limit=0",
        key: noEdges.key,
        proof: reader,
        fresh: { status: 400, code: "validation_error", certified: false },
      },
      {
        path: "/edges?limit=0",
        key: noEdges.key,
        proof: reader,
        fresh: { status: 400, code: "validation_error", certified: false },
      },
      {
        path: "/items?include=metadata&type=core.bookmark",
        key: noEdges.key,
        proof: reader,
        fresh: { status: 403, code: "type_not_permitted", certified: true },
      },
      {
        path: `/items?include=metadata&edge[about]=${target.id}`,
        key: noEdges.key,
        proof: reader,
        fresh: { status: 403, code: "edge_permission_denied", certified: true },
      },
      {
        path: `/items/${bookmark.data.item.id}`,
        key: noEdges.key,
        proof: reader,
        fresh: { status: 404, code: "item_not_found", certified: true },
      },
      {
        path: "/keys/current",
        key: token,
        proof: app,
        fresh: { status: 403, code: "forbidden", certified: true },
      },
    ];
    for (const { path, key, proof, fresh } of cases) {
      const response = await request(path, proof.read_view, key);
      expect(response.status, path).toBe(fresh.status);
      expect(response.headers.get("X-Marfa-Read-View") !== null, path).toBe(
        fresh.certified,
      );
      expect(await errorCode(response), path).toBe(fresh.code);
    }
    const type = `user.view-stale-${ctx.runId}`;
    const registered = await client.registerType({
      id: type,
      fields: { name: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackType(ctx, type, client);
    for (const { path, key, proof } of cases) {
      await changed(await request(path, proof.read_view, key));
    }
  });
});

describe("a copy stream resumed from a cursor and the frames it carries", () => {
  it("ends a copy stream resumed past the head with cursor_ahead and no live marker", async () => {
    await seed("cursor ahead witness");
    const live = await bootstrap();
    await bootstrap(server.workingKey, live);
    const flipped = `${live.read_view[0] === "0" ? "1" : "0"}${live.read_view.slice(1)}`;
    for (const requested of [
      String(BigInt(live.cursor) + 1n),
      "9223372036854775807",
    ]) {
      await withStream(
        server.apiUrl,
        server.workingKey,
        {
          query: COPY_QUERY,
          lastEventId: requested,
          readView: live.read_view,
        },
        async (stream) => {
          expect(stream.response.status).toBe(200);
          const { events } = await collectUntil(
            stream,
            (frames) => frames.some((frame) => frame.event === "cursor_ahead"),
            "the copy stream's cursor_ahead terminal",
            AbortSignal.timeout(FRAME_BUDGET_MS),
          );
          expect(events.map((frame) => frame.event)).toEqual([
            "stream_cursor",
            "cursor_ahead",
          ]);
          const announced = marker(events[0]!, "stream_cursor");
          expect(announced.cursor).toBe(live.cursor);
          expect(announced.read_view).toBe(live.read_view);
          expect(events[1]!.id).toBeUndefined();
          expect(events[1]!.data).toEqual({
            event_type: "cursor_ahead",
            requested,
            head: live.cursor,
          });
          await expectClosed(stream);
        },
      );
      await withStream(
        server.apiUrl,
        server.workingKey,
        { query: COPY_QUERY, lastEventId: requested, readView: flipped },
        async (stream) => {
          await changed(stream.response);
        },
      );
    }
  });

  it("sends listed on created, state changed and purged frames, live and replayed", async () => {
    const writerKey = await mint("listed-writer");
    const writer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: writerKey.key,
    });
    const configured = await client.updateConfig({
      enforcement: {
        source_filter: { types: ["core.note"], sources: [ctx.source] },
      },
    });
    expect(configured.ok, JSON.stringify(configured.error)).toBe(true);
    try {
      const before = await bootstrap();
      const live = await openEventStream(server.apiUrl, server.workingKey, {
        query: COPY_QUERY,
        connectTimeoutMs: FRAME_BUDGET_MS,
      });
      let liveFrames: SseEvent[];
      const written: Array<{ id: string; listed: boolean }> = [];
      try {
        await collectUntil(
          live,
          (frames) => frames.some((frame) => frame.event === "stream_live"),
          "the copy stream's live marker",
          AbortSignal.timeout(FRAME_BUDGET_MS),
        );
        for (const [by, listed] of [
          [client, true],
          [writer, false],
        ] as const) {
          const row = await seed(`listed ${String(listed)}`, by);
          written.push({ id: row.id, listed });
          expect((await by.transitionItem(row.id, "archived")).ok).toBe(true);
          expect((await by.deleteItem(row.id)).ok).toBe(true);
          expect((await by.purgeItem(row.id)).ok).toBe(true);
        }
        const purged = (frames: SseEvent[], id: string) =>
          frames.some(
            (frame) =>
              frame.event === "item.purged" &&
              (frame.data as CopyItem).item.id === id,
          );
        ({ events: liveFrames } = await collectUntil(
          live,
          (frames) => written.every(({ id }) => purged(frames, id)),
          "both purge frames on the live stream",
          AbortSignal.timeout(FRAME_BUDGET_MS),
        ));
      } finally {
        await live.close();
      }
      const replayed = await withStream(
        server.apiUrl,
        server.workingKey,
        {
          query: COPY_QUERY,
          lastEventId: before.cursor,
          readView: before.read_view,
        },
        async (stream) => {
          const { events } = await collectUntil(
            stream,
            (frames) =>
              written.every(({ id }) =>
                frames.some(
                  (frame) =>
                    frame.event === "item.purged" &&
                    (frame.data as CopyItem).item.id === id,
                ),
              ),
            "both purge frames on the replayed stream",
            AbortSignal.timeout(FRAME_BUDGET_MS),
          );
          return events;
        },
      );
      for (const [name, frames] of [
        ["live", liveFrames],
        ["replayed", replayed],
      ] as const) {
        for (const { id, listed } of written) {
          const carried = frames.filter(
            (frame) => (frame.data as Partial<CopyItem>).item?.id === id,
          );
          expect(
            carried.map((frame) => frame.event),
            `${name} frames for ${id}`,
          ).toEqual([
            "item.created",
            "item.state_changed",
            "item.deleted",
            "item.purged",
          ]);
          for (const frame of carried) {
            expect(frame.id, `${name} ${frame.event}`).toMatch(/^[1-9][0-9]*$/);
            expect(
              (frame.data as CopyItem).listed,
              `${name} ${frame.event}`,
            ).toBe(listed);
          }
        }
      }
    } finally {
      expect((await client.updateConfig({})).ok).toBe(true);
    }
  });

  it("sends edge frames on a copy stream in their ordinary shape, live and replayed", async () => {
    const from = await seed("edge frame source");
    const to = await seed("edge frame target");
    const farther = await seed("edge frame other target");
    const before = await bootstrap();
    const live = await openEventStream(server.apiUrl, server.workingKey, {
      query: COPY_QUERY,
      connectTimeoutMs: FRAME_BUDGET_MS,
    });
    let liveFrames: SseEvent[];
    let edgeId: string;
    try {
      await collectUntil(
        live,
        (frames) => frames.some((frame) => frame.event === "stream_live"),
        "the copy stream's live marker",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      );
      const edge = await seedEdge(from.id, to.id, "supersedes");
      edgeId = edge.id;
      const moved = await client.updateEdge(edge.id, {
        target_id: farther.id,
        version: edge.version,
      });
      expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
      expect((await client.deleteEdge(edge.id)).ok).toBe(true);
      const sentinel = await seed("edge frame sentinel");
      ({ events: liveFrames } = await collectUntil(
        live,
        (frames) =>
          frames.some(
            (frame) =>
              frame.event === "item.created" &&
              (frame.data as CopyItem).item.id === sentinel.id,
          ),
        "the sentinel after the edge frames",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      ));
    } finally {
      await live.close();
    }
    const replayed = await withStream(
      server.apiUrl,
      server.workingKey,
      {
        query: COPY_QUERY,
        lastEventId: before.cursor,
        readView: before.read_view,
      },
      async (stream) => {
        const { events } = await collectUntil(
          stream,
          (frames) => frames.some((frame) => frame.event === "edge.deleted"),
          "the edge's delete on the replayed stream",
          AbortSignal.timeout(FRAME_BUDGET_MS),
        );
        return events;
      },
    );
    const edgeFrames = (frames: SseEvent[]) =>
      frames.filter(
        (frame) =>
          (frame.data as { edge?: { id?: string } }).edge?.id === edgeId,
      );
    const liveEdge = edgeFrames(liveFrames);
    expect(liveEdge.map((frame) => frame.event)).toEqual([
      "edge.created",
      "edge.updated",
      "edge.deleted",
    ]);
    expect(edgeFrames(replayed)).toEqual(liveEdge);
    for (const frame of liveEdge) {
      expect(frame.id).toMatch(/^[1-9][0-9]*$/);
      expect(Object.keys(frame.data as object).sort()).toEqual([
        "edge",
        "event_type",
        "source_type",
      ]);
      expect((frame.data as { source_type: string }).source_type).toBe(
        "core.note",
      );
      expect(frame.data).not.toHaveProperty("listed");
      expect((frame.data as { edge: object }).edge).not.toHaveProperty(
        "listed",
      );
    }
  });
});

describe("conditional reads on doors that are not conditional", () => {
  it("answers 400 outside the supported doors before asking who is calling, and 401 first on an unsupported door inside them", async () => {
    const row = await seed("unsupported door witness");
    const proof = await bootstrap();
    const withProof = (path: string, key?: string) =>
      fetch(`${server.apiUrl}${path}`, {
        headers: {
          ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }),
          "X-Marfa-Read-View": proof.read_view,
        },
      });
    const without = (path: string, key?: string) =>
      fetch(`${server.apiUrl}${path}`, {
        ...(key === undefined
          ? {}
          : { headers: { Authorization: `Bearer ${key}` } }),
      });
    const outside = [
      "/",
      "/config",
      "/types/core.note",
      `/items/${row.id}/backrefs`,
      `/items/${row.id}/versions`,
      "/no-such-door",
    ];
    for (const path of outside) {
      const bare = await without(path);
      expect(bare.status, `${path} without the header`).not.toBe(400);
      for (const key of [undefined, "invalid", server.workingKey]) {
        const response = await withProof(path, key);
        expect(
          response.status,
          `${path} as ${key ? "a key" : "anonymous"}`,
        ).toBe(400);
        expect(await errorCode(response)).toBe("validation_error");
        expect(response.headers.get("X-Marfa-Read-View")).toBeNull();
      }
    }
    for (const path of ["/types/core.note", `/items/${row.id}/backrefs`]) {
      expect((await without(path, server.workingKey)).status, path).toBe(200);
    }
    for (const key of [undefined, "invalid"]) {
      const refused = await withProof("/items/stats", key);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("X-Marfa-Read-View")).toBeNull();
    }
    expect((await without("/items/stats", server.workingKey)).status).toBe(200);
    const unsupported = await withProof("/items/stats", server.workingKey);
    expect(unsupported.status).toBe(400);
    expect(await errorCode(unsupported)).toBe("validation_error");
  });
});
