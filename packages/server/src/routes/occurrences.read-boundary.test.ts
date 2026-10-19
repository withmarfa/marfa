import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
let reader: string;
const windowPath =
  "/occurrences?from=2028-03-01T00:00:00Z&to=2028-03-03T00:00:00Z";

beforeAll(async () => {
  ctx = await createTestContext();
  reader = await mintWorkingKey(ctx, {
    type_permissions: { "core.event": "read" },
    edge_permissions: { "parent-of": "read" },
  });
  expect(
    (
      await request(ctx.app, "POST", "/types", {
        key: ctx.workingKey,
        body: {
          id: "fixture.private_event",
          parent: "core.event",
          version: 1,
          fields: {},
        },
      })
    ).status,
  ).toBe(201);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => ctx.cleanup());

async function event(properties: Record<string, unknown>) {
  const response = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.event", properties },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { item: { id: string; version: number } })
    .item;
}

async function retype(item: { id: string; version: number }, type: string) {
  const response = await request(ctx.app, "PATCH", `/items/${item.id}`, {
    key: ctx.workingKey,
    body: { version: item.version, type, retype: true },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { item: { id: string; version: number } })
    .item;
}

async function rows(response: Response) {
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      data: { item: { id: string }; series_id?: string; replaces?: string }[];
    }
  ).data;
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "authorizes a parent relationship and its source in one read (restore after edge read: %s)",
  async (restoreAfterEdgeRead) => {
    const series = await event({
      title: "series",
      starts_at: "2028-03-01T10:00:00Z",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
    });
    const exception = await event({
      title: "readable exception",
      starts_at: "2028-03-02T12:00:00Z",
      original_starts_at: "2028-03-02T10:00:00Z",
    });
    const read = (key = reader) => request(ctx.app, "GET", windowPath, { key });
    expect(
      (await rows(await read())).some((row) => row.item.id === series.id),
    ).toBe(true);

    const scanned = barrier();
    const resumeScan = barrier();
    const edgeRead = barrier();
    const resumeEdge = barrier();
    const list = ctx.storage.items.list.bind(ctx.storage.items);
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      if (filters.hasProperty === "original_starts_at") {
        scanned.resolve();
        await resumeScan.promise;
      }
      return list(filters);
    });
    const edges = ctx.storage.edges.listToTargetsBatched.bind(
      ctx.storage.edges,
    );
    vi.spyOn(ctx.storage.edges, "listToTargetsBatched").mockImplementation(
      async (...args) => {
        const result = await edges(...args);
        if (restoreAfterEdgeRead) {
          edgeRead.resolve();
          await resumeEdge.promise;
        }
        return result;
      },
    );

    const pending = read();
    try {
      await scanned.promise;
      const hidden = await retype(series, "fixture.private_event");
      const created = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: series.id,
          target_id: exception.id,
          edge_type: "parent-of",
        },
      });
      expect(created.status).toBe(201);
      const edgeId = ((await created.json()) as { edge: { id: string } }).edge
        .id;
      expect(
        (await request(ctx.app, "GET", `/edges/${edgeId}`, { key: reader }))
          .status,
      ).toBe(404);
      resumeScan.resolve();
      if (restoreAfterEdgeRead) {
        await edgeRead.promise;
        await retype(hidden, "core.event");
      }
    } finally {
      resumeScan.resolve();
      resumeEdge.resolve();
    }
    const result = await rows(await pending);
    vi.restoreAllMocks();
    const shown = result.filter((row) => row.item.id === exception.id);
    expect(shown).toHaveLength(1);
    expect(shown[0]).not.toHaveProperty("series_id");
    expect(shown[0]).not.toHaveProperty("replaces");

    const later = (await rows(await read())).find(
      (row) => row.item.id === exception.id,
    );
    expect(later).toBeDefined();
    if (!restoreAfterEdgeRead) {
      expect(later).not.toHaveProperty("series_id");
      expect(later).not.toHaveProperty("replaces");
    }
    const witness = (await rows(await read(ctx.workingKey))).find(
      (row) => row.item.id === exception.id,
    );
    expect(witness).toMatchObject({
      series_id: series.id,
      replaces: "2028-03-02T10:00:00.000Z",
    });
  },
);

it("does not derive occurrence fields from an unreadable edge type", async () => {
  const series = await event({
    title: "series with a private relationship",
    starts_at: "2028-03-01T10:00:00Z",
    recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
  });
  const exception = await event({
    title: "exception with a private relationship",
    starts_at: "2028-03-02T12:00:00Z",
    original_starts_at: "2028-03-02T10:00:00Z",
  });
  const edge = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: {
      source_id: series.id,
      target_id: exception.id,
      edge_type: "parent-of",
    },
  });
  expect(edge.status).toBe(201);
  const noEdges = await mintWorkingKey(ctx, {
    type_permissions: { "core.event": "read" },
    edge_permissions: {},
  });
  const read = async (key: string) =>
    rows(await request(ctx.app, "GET", windowPath, { key }));
  const witness = (await read(reader)).find(
    (row) => row.item.id === exception.id,
  );
  expect(witness).toMatchObject({
    series_id: series.id,
    replaces: "2028-03-02T10:00:00.000Z",
  });
  const shown = (await read(noEdges)).find(
    (row) => row.item.id === exception.id,
  );
  expect(shown).toBeDefined();
  expect(shown).not.toHaveProperty("series_id");
  expect(shown).not.toHaveProperty("replaces");
});
