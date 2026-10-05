/**
 * A live stream delivers frames in the order the log numbered them, item
 * and edge frames alike.
 *
 * An edge frame waits on a source read before it is written and an item
 * frame does not, so two delivery paths that do not wait on each other let
 * a frame with a higher id reach the client before one with a lower id
 * published just before it. A client that keeps the last id it received as
 * its cursor, which is what `events.md` 3 tells it to do, then resumes past
 * the lower one, and nothing ever replays it. A purge is the ordinary way
 * to produce the shape: it announces every edge of the row first and the
 * row last.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, readSseWriting, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Frames carry an `id:` only when the log records them.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

async function note(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/** The `id:` of every frame in the text, in the order they were written. */
function frameIds(text: string): bigint[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => BigInt(match[1]!));
}

describe("a live stream", () => {
  it("delivers item and edge frames in id order, across a purge that announces the edges first", async () => {
    const targets: string[] = [];
    for (const name of ["one", "two", "three"]) {
      targets.push(await note(`live-order-target-${name}`));
    }

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);

    // The writes are issued from inside the read, once the probe's frame
    // has arrived. Frames published before the prologue has read the log
    // head are held and drained in order, which is not the path under
    // test; a frame delivered means the hold has been released, since the
    // release flips its flag with no await after the last frame it sends,
    // so everything published after it takes the live path. Observed
    // rather than waited for.
    const probe = await note("live-order-probe");
    const write = async (): Promise<void> => {
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: { body: "live-order-source" },
          edges: { references: targets },
        },
      });
      expect(created.status).toBe(201);
      const id = ((await created.json()) as { item: { id: string } }).item.id;
      const trashed = await request(ctx.app, "DELETE", `/items/${id}`, {
        key: ctx.workingKey,
      });
      expect(trashed.status).toBe(200);
      const purged = await request(ctx.app, "POST", `/items/${id}/purge`, {
        key: ctx.workingKey,
      });
      expect(purged.status).toBe(200);
    };

    // Read until every frame the writes produce has arrived, whatever
    // order it arrived in: one created, three edges created, one deleted,
    // three edges deleted, one purged. A read that stopped at the purge
    // would judge the order of what happened to be there.
    const count = (seen: string, needle: string): number =>
      seen.split(needle).length - 1;
    const { text } = await readSseWriting(
      res,
      probe,
      write,
      (seen) =>
        seen.includes('"item.purged"') &&
        count(seen, '"edge.created"') === 3 &&
        count(seen, '"edge.deleted"') === 3,
    );

    // From the probe's frame on: what was published after the hold was
    // seen to be released.
    const live = text.slice(text.lastIndexOf("\nid: ", text.indexOf(probe)));
    const ids = frameIds(live);
    expect(ids).toHaveLength(10);
    for (let i = 1; i < ids.length; i += 1) {
      expect(
        ids[i]! > ids[i - 1]!,
        `frames arrived out of id order: ${ids.join(", ")}`,
      ).toBe(true);
    }
  });
});
