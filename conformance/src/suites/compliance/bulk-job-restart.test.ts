import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  HOLD,
  idsWith,
  jobOf,
  queue,
  rowsAndChunk,
  seed,
} from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";

// Versions expose repeated writes; replay exposes repeated announcements.
let server: FreshServer;
let learned: { rows: number; chunk: number };
let counter = 0;

beforeAll(async () => {
  server = await bootFreshServer("bulk-job-restart");
  learned = await rowsAndChunk(working());
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** The working key's client, at the address the server has now. */
function working(): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
}

/** Every `item.updated` frame a replay from `head` carries, by item id. */
async function announced(head: string): Promise<Map<string, number>> {
  const sentinel = await working().createItem({
    type: "core.note",
    properties: { body: "after the job" },
  });
  expect(sentinel.status).toBe(201);
  const counts = new Map<string, number>();
  await withStream(
    server.apiUrl,
    server.workingKey,
    { lastEventId: head },
    async (stream) => {
      const { events } = await collectUntil(
        stream,
        (frames) =>
          frames.some(
            (frame) =>
              (frame.data as { item?: { id?: string } }).item?.id ===
              sentinel.data.item.id,
          ),
        "the replay to reach the item written after the job",
        AbortSignal.timeout(60_000),
      );
      for (const frame of events) {
        const id = (frame.data as { item?: { id?: string } }).item?.id;
        if (frame.event === "item.updated" && id !== undefined) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
    },
  );
  return counts;
}

describe("a bulk-action job the server was killed on", () => {
  it.each([
    ["before it wrote an item", HOLD.claimed],
    ["with a chunk's items written and not committed", HOLD.inChunk],
    ["between two chunks", HOLD.betweenChunks],
  ] as const)(
    "is finished on the server's return without writing or announcing an item twice, killed %s",
    async (_where, point) => {
      const tag = `killed-${String((counter += 1))}`;
      const rows = learned.rows;
      await seed(working(), tag, rows);
      const head = await baselineEventId(
        server.apiUrl,
        server.workingKey,
        async () => {
          const marker = await working().createItem({
            type: "core.note",
            properties: { body: `before ${tag}` },
          });
          expect(marker.status).toBe(201);
          return marker.data.item.id;
        },
      );

      await server.setFault(point);
      const id = await queue(working(), {
        action: "update_properties",
        patch: { resumed: tag },
        filter: { tags: [tag] },
      });
      await server.waitForHold(point);
      expect((await jobOf(working(), id)).status).toBe("in_progress");

      await server.restart({ signal: "SIGKILL" });
      const ended = await working().pollBulkActionToTerminal(id, {
        timeoutMs: 60_000,
      });
      expect(ended).toMatchObject({
        status: "completed",
        matched: rows,
        processed: rows,
        succeeded: rows,
        errored: 0,
      });

      // Every item once: created at version 1, patched at version 2.
      const ids = await idsWith(working(), tag);
      expect(ids).toHaveLength(rows);
      let cursor: string | undefined;
      let seen = 0;
      do {
        const page = await working().listItems({
          tags: [tag],
          limit: 200,
          cursor,
        });
        for (const item of page.data.data) {
          expect(item.properties.resumed, item.id).toBe(tag);
          expect(item.version, item.id).toBe(2);
          seen += 1;
        }
        cursor = page.data.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toBe(rows);

      const counts = await announced(head.eventId);
      for (const item of ids) expect(counts.get(item), item).toBe(1);
    },
    5 * 60_000,
  );
});

it("clears a held job when a fixture times out and stops without hanging", async () => {
  const held = await bootFreshServer("bulk-job-timeout");
  try {
    const client = new MarfaClient({
      baseUrl: held.apiUrl,
      apiKey: held.workingKey,
    });
    await seed(client, "timeout", 1);
    await held.setFault(HOLD.inChunk);
    await queue(client, {
      action: "update_tags",
      add: ["done"],
      filter: { tags: ["timeout"] },
    });
    await held.waitForHold(HOLD.inChunk);
    await expect(held.waitForHold(HOLD.inChunk, 2, 1)).rejects.toThrow(
      "1 of 2 callers waited",
    );
    const started = performance.now();
    await held.stop();
    expect(performance.now() - started).toBeLessThan(8_000);
  } finally {
    await held.stop();
  }
}, 180_000);
