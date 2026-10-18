import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * A write that wrote a conflicted copy, sent again after the record of its
 * answer is gone. The record rides the event log's retention, so the fixture
 * shortens the retention, moves the server's clock past it and runs the
 * sweep; the repeat is then executed, not answered.
 */

const HOUR_MS = 60 * 60 * 1000;

let server: FreshServer;
let writer: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("copy-once-repeat", QUIET_SCHEDULE);
  writer = writerOf(server);
  await quiet(server, ["event-log-cleanup"]);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("a conflicted copy written once", () => {
  it("is not written again, nor is a second edge to the original, when the repeat is executed because its record is gone", async () => {
    const config = (await writer.getConfig()).data as Record<string, unknown>;
    const set = await writer.updateConfig({
      ...config,
      event_log_retention_hours: 1,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);

    const made = await writer.createItem({
      type: "core.note",
      properties: { title: "original", body: "original body" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const { id, version } = made.data.item;
    const winner = await writer.updateItem(id, {
      properties: { body: "body from the winner" },
      version,
    });
    expect(winner.ok, JSON.stringify(winner.error)).toBe(true);

    const send = () =>
      writer.rawRequest<{
        conflict_resolution?: { conflicted_copy_id?: string };
      }>(`/items/${id}?conflict=auto`, {
        method: "PATCH",
        headers: { "Idempotency-Key": "copy-once-after-the-record" },
        body: { properties: { body: "body from the loser" }, version },
      });
    const copiesOf = async () => {
      const back = await writer.listItemBackrefs(id, {
        edge_type: "derived-from",
      });
      expect(back.ok, JSON.stringify(back.error)).toBe(true);
      return back.data.data.map((edge) => edge.source_id);
    };

    const first = await send();
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    const copy = first.data.conflict_resolution?.conflicted_copy_id;
    expect(copy, "no conflicted copy was written").toBeTruthy();
    expect(await copiesOf()).toEqual([copy]);

    // The witness for the sweep below: while the record stands, the key is
    // answered from it.
    const answered = await send();
    expect(answered.headers.get("Idempotency-Replayed")).toBe("true");

    await movedClock(server).advance(2 * HOUR_MS);
    const swept = await runJob(server, "event-log-cleanup");
    expect(swept.outcome).toBe("ok");
    expect(
      (swept.result as { purged_records: number }).purged_records,
    ).toBeGreaterThanOrEqual(1);

    const again = await send();
    expect(
      again.headers.get("Idempotency-Replayed"),
      "the record was still there, so the repeat was answered, not executed",
    ).toBeNull();
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.conflict_resolution?.conflicted_copy_id).toBe(copy);
    expect(await copiesOf()).toEqual([copy]);
    const edges = await writer.listItemEdges(copy!, {
      edge_type: "derived-from",
    });
    expect(edges.data.data.map((edge) => edge.target_id)).toEqual([id]);
  });
});
