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

// No request can write an unreadable row, so a fault makes the server read one as damaged.

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

describe("a stream that reaches a row the server cannot read", () => {
  it(
    "ends with catchup_too_old at an event it cannot read, and does not send it",
    async ({ signal }) => {
      const fresh = server!;
      const before = await note("readable-before");
      // The three ways a row is unreadable: an item's payload that is not
      // JSON, an item's payload that is JSON and names no type, and an edge's
      // payload that is not JSON.
      const notJson = await note("payload-not-json");
      const noType = await note("item-without-type");
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

      const stream = async (
        lastEventId: string,
        until: (seen: SseEvent[]) => boolean,
        what: string,
      ): Promise<SseEvent[]> =>
        (
          await withStream(
            fresh.apiUrl,
            fresh.workingKey,
            { lastEventId },
            (opened) => collectUntil(opened, until, what, signal),
          )
        ).events;
      const endsTooOld = (lastEventId: string): Promise<SseEvent[]> =>
        stream(
          lastEventId,
          (seen) => seen.some((e) => e.event === "catchup_too_old"),
          `catchup_too_old on the replay from cursor ${lastEventId}`,
        );

      // The witness: with nothing damaged, the replay from the start sends
      // every row, the damaged ones included.
      const intact = (
        await stream(
          "0",
          (seen) => seen.some((e) => itemOf(e) === after),
          `the replay from cursor 0 to reach ${after}`,
        )
      ).filter((e) => e.id !== undefined);
      const oldest = intact[0]!.id!;
      const rowOf = (match: (e: SseEvent) => boolean): number => {
        const at = intact.findIndex(match);
        expect(at, "the event is not in the log").toBeGreaterThanOrEqual(0);
        return at + 1;
      };
      const damaged = [
        {
          name: "item without JSON",
          fault: "fail:stream-replay-row",
          row: rowOf((e) => itemOf(e) === notJson),
        },
        {
          name: "item without a type",
          fault: "fail:stream-replay-untyped",
          row: rowOf((e) => itemOf(e) === noType),
        },
        {
          name: "edge without JSON",
          fault: "fail:stream-replay-row",
          row: rowOf((e) => edgeOf(e) === edge),
        },
      ];

      const expectTooOld = (events: SseEvent[], requested: string): void => {
        const last = events.at(-1)!;
        expect(last.event).toBe("catchup_too_old");
        expect(last.id).toBeUndefined();
        expect(last.data).toEqual({
          event_type: "catchup_too_old",
          min_retained_id: oldest,
          requested,
        });
        expect(
          events.some((e) => e.event === "stream_live"),
          "the stream went live over a row it cannot read",
        ).toBe(false);
      };

      for (const { name, fault, row } of damaged) {
        const id = BigInt(intact[row - 1]!.id!);

        // From the start: the readable rows before the damage are sent, and
        // the stream then ends in place of the damaged row.
        await fresh.setFault(`${fault}=${String(row)}`);
        let ended: SseEvent[];
        try {
          ended = await endsTooOld("0");
        } finally {
          await fresh.clearFault(fault);
        }
        const sent = ended.filter((e) => e.id !== undefined);
        expect(
          sent.map((e) => e.id),
          `the replay did not send every row before the ${name} row`,
        ).toEqual(intact.slice(0, row - 1).map((e) => e.id));
        expect(
          sent.some((e) => itemOf(e) === before),
          `the replay did not send ${before}, a row it can read`,
        ).toBe(true);
        expectTooOld(ended, "0");

        // From just before it: nothing is sent, and the stream names the
        // cursor the client sent.
        const cursor = String(id - 1n);
        await fresh.setFault(`${fault}=1`);
        let reached: SseEvent[];
        try {
          reached = await endsTooOld(cursor);
        } finally {
          await fresh.clearFault(fault);
        }
        expect(
          reached.some((e) => e.id !== undefined),
          `the replay sent a frame at or past the ${name} row, which cannot be read`,
        ).toBe(false);
        expectTooOld(reached, cursor);
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
