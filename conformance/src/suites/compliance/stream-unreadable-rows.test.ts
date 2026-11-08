import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * A replay is built from what the log stores, and a stored row the server
 * can no longer read is withheld rather than guessed at.
 *
 * No request can write such a row, so the server is told to read one stored
 * row as damaged.
 */

let server: FreshServer | undefined;
let writer: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("stream-unreadable-rows");
  writer = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

async function note(body: string): Promise<string> {
  const created = await writer.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

const itemOf = (e: SseEvent): string | undefined =>
  (e.data as { item?: { id?: string } }).item?.id;
const edgeOf = (e: SseEvent): string | undefined =>
  (e.data as { edge?: { id?: string } }).edge?.id;

describe("a replay over a row the server cannot read", () => {
  it(
    "does not replay an event it cannot read",
    async ({ signal }) => {
      const fresh = server!;
      const before = await note("readable-before");
      // The two kinds of row a replay reads: an item's and an edge's.
      const damagedItem = await note("payload-not-json");
      const from = await note("edge-source");
      const to = await note("edge-target");
      const created = await writer.createEdge({
        source_id: from,
        target_id: to,
        edge_type: "about",
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const edge = created.data.edge.id;
      const after = await note("readable-after");

      const idsOf = async (
        client: FreshServer,
      ): Promise<{ events: SseEvent[]; of: (e: SseEvent) => bigint }> => {
        const { events } = await withStream(
          client.apiUrl,
          client.workingKey,
          { lastEventId: "0" },
          (stream) =>
            collectUntil(
              stream,
              (seen) => seen.some((e) => itemOf(e) === after),
              `the replay from cursor 0 to reach ${after}`,
              signal,
            ),
        );
        return { events, of: (e) => BigInt(e.id!) };
      };

      const intact = await idsOf(fresh);
      const rows = intact.events.filter((e) => e.id !== undefined);
      const rowOf = (match: (e: SseEvent) => boolean): number => {
        const at = rows.findIndex(match);
        expect(at, "the event is not in the log").toBeGreaterThanOrEqual(0);
        return at + 1;
      };
      const damaged = {
        item: rowOf((e) => itemOf(e) === damagedItem),
        edge: rowOf((e) => edgeOf(e) === edge),
      };

      for (const [name, row] of Object.entries(damaged)) {
        await fresh.setFault(`fail:stream-replay-row=${String(row)}`);
        let replayed: Awaited<ReturnType<typeof idsOf>>;
        try {
          replayed = await idsOf(fresh);
        } finally {
          await fresh.clearFault("fail:stream-replay-row");
        }
        const sent = replayed.events.filter((e) => e.id !== undefined);
        const sentIds = sent.map((e) => replayed.of(e));

        // The witness: the replay ran across the damaged row. The rows on
        // either side of it, and the edge's two items, are sent.
        for (const item of [before, from, to, after]) {
          expect(
            sent.some((e) => itemOf(e) === item),
            `the replay did not send ${item}, a row it can read`,
          ).toBe(true);
        }
        expect(sentIds).toEqual([...sentIds].sort((a, b) => (a < b ? -1 : 1)));
        expect(
          sentIds.includes(intact.of(rows[row - 1]!)),
          `the replay sent event ${String(row)}, whose stored ${name} row cannot be read`,
        ).toBe(false);
        expect(
          replayed.events.some(
            (e) =>
              e.event === "stream_incomplete" || e.event === "catchup_too_old",
          ),
          "the replay ended instead of passing the row it cannot read",
        ).toBe(false);
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
