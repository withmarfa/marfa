import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { openEventStream, type SseEvent } from "../../utils/sse.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let edgeType: string;

let shownSource: string;
let hiddenSource: string;

let shownWriter: MarfaClient;
let hiddenWriter: MarfaClient;

/** A reader the filter narrows, and its witness: the same maps and no filter. */
let filteredKey: string;
let witnessKey: string;

const FILTER = (): { types: string[]; sources: string[] } => ({
  types: ["core.note"],
  sources: [shownSource],
});

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "stream-source-filter",
  ));
  shownSource = `${ctx.source}-shown`;
  hiddenSource = `${ctx.source}-hidden`;

  edgeType = `mock.streamsourcefilter.${ctx.runId}`;
  const registered = await client.registerEdgeType({
    id: edgeType,
    cardinality: "many-to-many",
  });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  trackEdgeType(ctx, edgeType);

  shownWriter = (await mintKey("shown-writer", shownSource)).client;
  hiddenWriter = (await mintKey("hidden-writer", hiddenSource)).client;
  filteredKey = (await mintKey("filtered", `${ctx.source}-filtered`, FILTER()))
    .key;
  witnessKey = (await mintKey("witness", `${ctx.source}-witness`)).key;
});

afterAll(async () => {
  await cleanup(ctx);
});

async function mintKey(
  label: string,
  source: string,
  filter?: { types: string[]; sources: string[] },
): Promise<{ id: string; key: string; client: MarfaClient }> {
  const minted = await client.createKey({
    label: `stream-source-filter-${label}`,
    source,
    permissions: [],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    ...(filter ? { enforcement_override: { source_filter: filter } } : {}),
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  trackKey(ctx, minted.data.id);
  return {
    id: minted.data.id,
    key: minted.data.key,
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
  };
}

async function item(
  writer: MarfaClient,
  type: "core.note" | "core.task",
): Promise<string> {
  const r = await writer.createItem(
    type === "core.note"
      ? { type, properties: { body: `stream-source-filter ${ctx.runId}` } }
      : { type, properties: { title: `stream-source-filter ${ctx.runId}` } },
  );
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function edge(
  writer: MarfaClient,
  source: string,
  target: string,
): Promise<string> {
  const r = await writer.createEdge({
    source_id: source,
    target_id: target,
    edge_type: edgeType,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge.id;
}

/** The ids of the items and edges a stream's frames carry. */
function idsOf(events: SseEvent[]): string[] {
  return events.flatMap((e) => {
    const data = e.data as { item?: { id?: string }; edge?: { id?: string } };
    const id = data.item?.id ?? data.edge?.id;
    return id === undefined ? [] : [id];
  });
}

const carries =
  (id: string) =>
  (events: SseEvent[]): boolean =>
    idsOf(events).includes(id);

/** What each case writes, in order, and the sentinel written after it all. */
interface Written {
  shownNote: string;
  hiddenNote: string;
  hiddenTask: string;
  /** Its source item the filter hides, its target it shows. */
  hiddenToShown: string;
  /** Its source item the filter shows, its target it hides. */
  shownToHidden: string;
  sentinel: string;
}

async function writeCase(): Promise<Written> {
  const shownNote = await item(shownWriter, "core.note");
  const hiddenNote = await item(hiddenWriter, "core.note");
  const hiddenTask = await item(hiddenWriter, "core.task");
  const hiddenToShown = await edge(hiddenWriter, hiddenNote, shownNote);
  const shownToHidden = await edge(shownWriter, shownNote, hiddenNote);
  const sentinel = await item(shownWriter, "core.note");
  return {
    shownNote,
    hiddenNote,
    hiddenTask,
    hiddenToShown,
    shownToHidden,
    sentinel,
  };
}

function expectNarrowed(filtered: string[], witness: string[], w: Written) {
  // The witness: every row and edge was producible on this stream.
  expect(witness).toEqual(
    expect.arrayContaining([
      w.shownNote,
      w.hiddenNote,
      w.hiddenTask,
      w.hiddenToShown,
      w.shownToHidden,
      w.sentinel,
    ]),
  );
  expect(filtered).toEqual(
    expect.arrayContaining([
      w.shownNote,
      w.hiddenTask,
      w.shownToHidden,
      w.sentinel,
    ]),
  );
  expect(filtered).not.toContain(w.hiddenNote);
  expect(filtered).not.toContain(w.hiddenToShown);
}

describe("the source filter on the event stream", () => {
  it("leaves out of a live stream the items and edges whose source item the filter hides, and nothing else", async ({
    signal,
  }) => {
    const filtered = await openEventStream(apiUrl, filteredKey, {
      connectTimeoutMs: 30_000,
    });
    const witness = await openEventStream(apiUrl, witnessKey, {
      connectTimeoutMs: 30_000,
    });
    try {
      // Let both subscriptions settle before the writes they observe.
      await new Promise((r) => setTimeout(r, 250));
      const written = await writeCase();
      const [seen, whole] = await Promise.all(
        [filtered, witness].map(async (stream) =>
          idsOf(
            (
              await collectUntil(
                stream,
                carries(written.sentinel),
                `the sentinel ${written.sentinel}`,
                signal,
              )
            ).events,
          ),
        ),
      );
      expectNarrowed(seen!, whole!, written);
    } finally {
      await filtered.close();
      await witness.close();
    }
  });

  it("leaves the same frames out of a replay from a cursor", async ({
    signal,
  }) => {
    const { eventId, markerId } = await baselineEventId(
      apiUrl,
      witnessKey,
      () => item(shownWriter, "core.note"),
      signal,
    );
    expect(markerId).toBeTruthy();
    const written = await writeCase();
    const replayed = async (key: string): Promise<string[]> =>
      withStream(apiUrl, key, { lastEventId: eventId }, async (stream) =>
        idsOf(
          (
            await collectUntil(
              stream,
              carries(written.sentinel),
              `the replayed sentinel ${written.sentinel}`,
              signal,
            )
          ).events,
        ),
      );
    expectNarrowed(
      await replayed(filteredKey),
      await replayed(witnessKey),
      written,
    );
  });

  it("narrows an open stream when the key's own source filter changes", async ({
    signal,
  }) => {
    const narrowed = await mintKey("narrowed", `${ctx.source}-narrowed`);
    await withStream(apiUrl, narrowed.key, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      // The witness: before the change the stream carries a hidden source.
      const before = await item(hiddenWriter, "core.note");
      const firstSentinel = await item(shownWriter, "core.note");
      const first = await collectUntil(
        stream,
        carries(firstSentinel),
        `the sentinel ${firstSentinel}`,
        signal,
      );
      expect(idsOf(first.events)).toContain(before);

      const changed = await client.updateKey(narrowed.id, {
        enforcement_override: { source_filter: FILTER() },
      });
      expect(changed.status, JSON.stringify(changed.error)).toBe(200);

      const after = await item(hiddenWriter, "core.note");
      const shownAfter = await item(shownWriter, "core.note");
      const secondSentinel = await item(shownWriter, "core.note");
      const second = await collectUntil(
        stream,
        carries(secondSentinel),
        `the sentinel ${secondSentinel}`,
        signal,
      );
      expect(idsOf(second.events)).toContain(shownAfter);
      expect(idsOf(second.events)).not.toContain(after);
    });
  });

  it("still sends a row the filter hides on a copy stream, with listed false", async ({
    signal,
  }) => {
    await withStream(
      apiUrl,
      filteredKey,
      {
        query: [
          ["edges", "all"],
          ["copy", "1"],
        ],
      },
      async (stream) => {
        await collectUntil(
          stream,
          (events) => events.some((e) => e.event === "stream_live"),
          "the copy stream's live marker",
          signal,
        );
        const hidden = await item(hiddenWriter, "core.note");
        const sentinel = await item(shownWriter, "core.note");
        const { events } = await collectUntil(
          stream,
          carries(sentinel),
          `the sentinel ${sentinel}`,
          signal,
        );
        const listedOf = (id: string): unknown =>
          (
            events.find(
              (e) => (e.data as { item?: { id?: string } }).item?.id === id,
            )?.data as { listed?: boolean } | undefined
          )?.listed;
        expect(listedOf(hidden)).toBe(false);
        expect(listedOf(sentinel)).toBe(true);
      },
    );
  });
});
