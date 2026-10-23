import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * A retention sweep purges rows without a request, so no write answers the
 * change it makes to the reach. The age that makes a binned item due is a
 * clock the fixture moves through the target interface, and the sweep is run
 * with the operator's key.
 */

let server: FreshServer;
let writer: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("reach-sweep", QUIET_SCHEDULE);
  writer = writerOf(server);
  await quiet(server, ["trash-purge"]);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** The reach the working key holds now, from the copy stream's opening. */
async function reach(): Promise<string> {
  return withStream(
    server.apiUrl,
    server.workingKey,
    {
      query: [
        ["edges", "all"],
        ["copy", "1"],
      ],
    },
    async (stream) => {
      const { events } = await collectUntil(
        stream,
        (frames) => frames.some((frame) => frame.event === "stream_live"),
        "the copy stream's live marker",
        AbortSignal.timeout(15_000),
      );
      const head = events.find((frame) => frame.event === "stream_cursor");
      return (head?.data as { reach: string }).reach;
    },
  );
}

/** What a read that names `proof` answers: the reach it holds, or the change. */
async function answer(
  proof: string,
): Promise<{ status: number; code?: string }> {
  const response = await fetch(`${server.apiUrl}/items?include=metadata`, {
    headers: {
      Authorization: `Bearer ${server.workingKey}`,
      "X-Marfa-Reach": proof,
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  return { status: response.status, code: body.error?.code };
}

describe("a retention sweep that purges an item", () => {
  it("changes the reach, and a sweep that purges nothing does not", async () => {
    const config = (await writer.getConfig()).data as Record<string, unknown>;
    const set = await writer.updateConfig({
      ...config,
      trash_retention_days: 1,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);

    const note = await writer.createItem({
      type: "core.note",
      properties: { body: "a note that is binned and then swept" },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    const id = note.data.item.id;
    expect((await writer.deleteItem(id)).status).toBe(200);

    const proof = await reach();
    expect(await answer(proof)).toEqual({ status: 200, code: undefined });

    // The witness: a sweep before the item is due purges nothing and leaves
    // the reach where it was, so the change below is the purge's.
    const early = await runJob(server, "trash-purge");
    expect(early.outcome).toBe("ok");
    expect(early.result).toMatchObject({ deleted: 0 });
    expect(await answer(proof)).toEqual({ status: 200, code: undefined });

    await movedClock(server).advance(2 * DAY_MS);
    const swept = await runJob(server, "trash-purge");
    expect(swept.outcome).toBe("ok");
    expect(
      (swept.result as { deleted: number }).deleted,
    ).toBeGreaterThanOrEqual(1);
    expect((await writer.getItem(id)).status).toBe(404);

    expect(await answer(proof)).toEqual({
      status: 409,
      code: "reach_changed",
    });
    expect(await reach()).not.toBe(proof);
  });
});
