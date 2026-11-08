import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
 * A stream is built from what the log stores, and a stored row the server can
 * no longer read ends the stream with catchup_too_old rather than being
 * skipped or guessed at.
 *
 * No request can write such a row, so the fixture damages it in the stored
 * file while the server is stopped.
 */

const runSqlite = promisify(execFile);

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
      // The three ways a row is unreadable: a payload that is not JSON, an
      // item whose stored row names no type, and an edge whose payload is
      // not JSON.
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

      const endsAt = async (
        client: FreshServer,
        lastEventId: string,
      ): Promise<{ events: SseEvent[] }> => {
        const { events } = await withStream(
          client.apiUrl,
          client.workingKey,
          { lastEventId },
          (stream) =>
            collectUntil(
              stream,
              (seen) => seen.some((e) => e.event === "catchup_too_old"),
              `catchup_too_old on the replay from cursor ${lastEventId}`,
              signal,
            ),
        );
        return { events };
      };

      const expectTooOld = (events: SseEvent[], id: bigint): void => {
        const last = events.at(-1)!;
        expect(last.event).toBe("catchup_too_old");
        expect(last.id).toBeUndefined();
        expect(last.data).toEqual({
          event_type: "catchup_too_old",
          min_retained_id: String(id + 1n),
          requested: String(id - 1n),
        });
        expect(
          events.some((e) => e.event === "stream_live"),
          "the stream went live over a row it cannot read",
        ).toBe(false);
      };

      const intact = await idsOf(fresh);
      const eventId = (match: (e: SseEvent) => boolean): bigint => {
        const frame = intact.events.find(match);
        expect(frame?.id, "the event is not in the log").toBeDefined();
        return intact.of(frame!);
      };
      const damaged = {
        notJson: eventId((e) => itemOf(e) === notJson),
        noType: eventId((e) => itemOf(e) === noType),
        edge: eventId((e) => edgeOf(e) === edge),
      };

      await fresh.restart({
        whileStopped: async () => {
          await runSqlite("sqlite3", [
            fresh.sqlitePath,
            [
              `UPDATE event_log SET payload = 'not json' WHERE id IN (${String(damaged.notJson)}, ${String(damaged.edge)});`,
              `UPDATE event_log SET payload = json_remove(payload, '$.item.type') WHERE id = ${String(damaged.noType)};`,
            ].join(" "),
          ]);
        },
      });

      // From the start: the readable rows before the damage are sent, and the
      // stream then ends with catchup_too_old, naming the damaged row as the
      // last one it cannot go past.
      const first = damaged.notJson;
      const ended = await endsAt(fresh, "0");
      const sent = ended.events.filter((e) => e.id !== undefined);
      for (const item of [before]) {
        expect(
          sent.some((e) => itemOf(e) === item),
          `the replay did not send ${item}, a row it can read`,
        ).toBe(true);
      }
      expect(sent.every((e) => BigInt(e.id!) < first)).toBe(true);
      expect(
        sent.some((e) => itemOf(e) === notJson || itemOf(e) === after),
        "the replay went past the row it cannot read",
      ).toBe(false);
      expectTooOld(ended.events, first);

      // Each kind of damage ends a stream that reaches it the same way, and
      // never sends the row.
      for (const [name, id] of Object.entries(damaged)) {
        const cursor = String(id - 1n);
        const reached = await endsAt(fresh, cursor);
        expect(
          reached.events.some((e) => e.id !== undefined),
          `the replay sent a frame at or past the ${name} row, which cannot be read`,
        ).toBe(false);
        expectTooOld(reached.events, id);
      }

      // A replay that starts past the damage is not affected by it.
      const past = await withStream(
        fresh.apiUrl,
        fresh.workingKey,
        { lastEventId: String(damaged.edge) },
        (stream) =>
          collectUntil(
            stream,
            (seen) => seen.some((e) => itemOf(e) === after),
            `the replay from past the damage to reach ${after}`,
            signal,
          ),
      );
      expect(past.events.some((e) => e.event === "catchup_too_old")).toBe(
        false,
      );
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
