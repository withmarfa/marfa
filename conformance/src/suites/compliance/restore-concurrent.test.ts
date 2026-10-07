import { describe, it, expect, beforeAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse } from "../../client/types.js";
import { itemsArchive } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * What a write meets while a restore runs. A restore holds the write lock
 * from its first row to its commit, so a write issued meanwhile waits behind
 * it, and the only question is what the write is answered and where its event
 * lands among the restore's. Each test boots a server of its own: the restore
 * is large enough to be in flight for a while, and the run's server must not
 * carry its rows or its settings.
 *
 * The writes are fired while the restore is in flight and not at an arranged
 * instant, so which of them land before, behind or past the restore is for the
 * server to decide. Every assertion holds for each of those outcomes.
 */

const RESTORED = 4_000;

let ordered: FreshServer;
let impatient: FreshServer;
/** The busy budget the impatient server is booted with. */
const BUDGET_MS = 50;

beforeAll(async () => {
  ordered = await bootFreshServer("restore-order");
  impatient = await bootFreshServer("restore-writers", {
    SQLITE_BUSY_BUDGET_MS: String(BUDGET_MS),
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function archiveOf(count: number): { ids: string[]; bytes: Uint8Array } {
  const ids = Array.from({ length: count }, () => uuidv7());
  return {
    ids,
    bytes: itemsArchive(
      ids.map((id, i) => ({
        id,
        type: "core.note",
        source: "restore-concurrent",
        properties: { body: `restored ${String(i)}` },
      })),
    ),
  };
}

function operatorOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
}

/**
 * Fires `write` until `running` settles, keeping at most `IN_FLIGHT` of them
 * waiting at once, and answers what each got. A write that waits holds a
 * connection, and a server whose accept queue is full resets the ones past it,
 * which says nothing about what a write is answered.
 */
const IN_FLIGHT = 16;

async function writesWhile<T>(
  running: Promise<unknown>,
  write: () => Promise<T>,
): Promise<T[]> {
  let settled = false;
  let waiting = 0;
  const watched = running.finally(() => {
    settled = true;
  });
  const answers: Promise<T>[] = [];
  while (!settled) {
    if (waiting < IN_FLIGHT) {
      waiting += 1;
      answers.push(
        write().finally(() => {
          waiting -= 1;
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await watched;
  return Promise.all(answers);
}

describe("a restore that commits", () => {
  it("tells subscribers about its events in log order, ahead of the events of any write committed after it", async () => {
    const worker = new MarfaClient({
      baseUrl: ordered.apiUrl,
      apiKey: ordered.workingKey,
    });
    const restore = archiveOf(RESTORED);
    const restored = new Set(restore.ids);
    const idOf = (data: unknown): string | undefined =>
      (data as { item?: { id?: string } } | undefined)?.item?.id;

    await withStream(ordered.apiUrl, ordered.workingKey, {}, async (stream) => {
      // The witness that the subscription is live: a write made now reaches
      // it, so the events below are not missing for want of a listener.
      const marker = await worker.createItem({
        type: "core.note",
        properties: { body: "marker" },
      });
      expect(marker.status, JSON.stringify(marker.error)).toBe(201);
      await collectUntil(
        stream,
        (seen) => seen.some((e) => idOf(e.data) === marker.data.item.id),
        "the marker write to reach the stream",
      );

      const restoring = operatorOf(ordered).restoreArchive(restore.bytes);
      // A write the restore holds past the busy budget is refused
      // `write_contention` and writes nothing (`search-and-filters/restore-writers-wait`);
      // only the writes that committed have events to order.
      const answers = await writesWhile(restoring, async () => {
        const r = await worker.createItem({
          type: "core.note",
          properties: { body: "written during the restore" },
        });
        if (r.status === 503) {
          expect(r.error?.error.code).toBe("write_contention");
          return null;
        }
        expect(r.status, JSON.stringify(r.error)).toBe(201);
        return r.data.item.id;
      });
      const written = answers.filter((id): id is string => id !== null);
      const answer = await restoring;
      expect(answer.status, JSON.stringify(answer.error)).toBe(200);

      // A write after the restore answers settles the stream: its event
      // arriving means every event published before it has arrived.
      const sentinel = await worker.createItem({
        type: "core.note",
        properties: { body: "sentinel" },
      });
      expect(sentinel.status).toBe(201);
      const { events } = await collectUntil(
        stream,
        (seen) => seen.some((e) => idOf(e.data) === sentinel.data.item.id),
        "the sentinel write to reach the stream",
      );

      const wanted = new Set([...restored, ...written, sentinel.data.item.id]);
      const seen = events.filter((e) => wanted.has(idOf(e.data) ?? ""));
      const ids = seen.map((e) => BigInt(e.id ?? "-1"));
      expect(ids.every((id) => id >= 0n)).toBe(true);
      // Ascending, so the restore's events come in log order and none of a
      // write committed behind it comes ahead of them.
      for (let i = 1; i < ids.length; i += 1) {
        expect(
          ids[i]! > ids[i - 1]!,
          `event ${String(ids[i])} followed ${String(ids[i - 1])}`,
        ).toBe(true);
      }
      expect(seen.filter((e) => restored.has(idOf(e.data) ?? ""))).toHaveLength(
        RESTORED,
      );
      expect(seen).toHaveLength(wanted.size);
    });
  }, 300_000);
});

describe("a write that meets a restore", () => {
  it("is answered 201, or 503 write_contention carrying the busy budget, and nothing else", async () => {
    const worker = new MarfaClient({
      baseUrl: impatient.apiUrl,
      apiKey: impatient.workingKey,
    });
    const restoring = operatorOf(impatient).restoreArchive(
      archiveOf(RESTORED).bytes,
    );
    const answers = await writesWhile(restoring, () =>
      worker.createItem({
        type: "core.note",
        properties: { body: "written during the restore" },
      }),
    );
    const restored = await restoring;
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);

    const refused = answers.filter((a) => a.status === 503);
    expect(
      refused.length,
      "no write was refused, so the restore was not holding the lock for longer than the budget",
    ).toBeGreaterThan(0);
    for (const answer of answers as ApiResponse<unknown>[]) {
      expect([201, 503], JSON.stringify(answer.error)).toContain(answer.status);
      if (answer.status === 503) {
        expect(answer.error?.error.code).toBe("write_contention");
        expect(
          (answer.error?.error as { details?: { budget_ms?: number } }).details
            ?.budget_ms,
        ).toBe(BUDGET_MS);
      }
    }
  }, 300_000);
});
