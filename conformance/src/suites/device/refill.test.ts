import { afterEach, describe, expect, it } from "vitest";
import {
  catchupTooOld,
  connected,
  copyHeadRead,
  copyReplay,
  copyStreamCursor,
  cursorAhead,
  edgesPage,
  wireItem,
  withMetadata,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { ScriptedServer } from "../../device/scripted-server.js";
import { scriptHydration, startHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

type Rows = Record<string, Array<{ item: WireItemOptions }>>;

/**
 * A hydrated copy whose next catch-up is told its cursor aged out of the
 * event log. The server's rows are `rows`, read live, so a fixture changes
 * what the refill finds by changing them; `head` is the log's head as every
 * read of it answers.
 */
async function agedOut(
  label: string,
  rows: Rows,
  options: {
    pageSize?: number;
    drop?: (offset: number) => boolean;
    /** What happens to the hydrated copy before its cursor ages out. */
    before?: (h: Harness) => Promise<void>;
  } = {},
): Promise<{
  h: Harness;
  head: { now: string };
}> {
  harness = await startHarness(label);
  const h = harness;
  const head = { now: "10" };
  let aging = false;
  scriptHydration(h.server, {
    head: () => head.now,
    rows,
    pageSize: options.pageSize,
    drop: options.drop,
  });
  h.server.copyAnswer("GET", "/events", (request) => {
    const cursor = request.headers["last-event-id"];
    if (cursor === undefined) return copyHeadRead(head.now);
    if (aging) {
      aging = false;
      head.now = "900";
      return {
        kind: "sse",
        frames: [
          connected,
          copyStreamCursor("900"),
          catchupTooOld("500", cursor),
        ],
      };
    }
    return copyReplay(head.now, []);
  });
  expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
  const whole = await h.device.listAnswer();
  expect(
    whole.ok && whole.value.completeness,
    "the first hydration did not leave a whole copy, so nothing below is about an aged-out one",
  ).toBe("complete");
  await options.before?.(h);
  aging = true;
  const caught = await h.device.catchUp();
  expect(
    caught.ok ? "caught up" : caught.refusal.code,
    "the catch-up was not told its cursor aged out",
  ).toBe("copy_expired");
  return { h, head };
}

async function ids(
  h: Harness,
): Promise<{ ids: string[]; completeness: string }> {
  const listed = await h.device.listAnswer();
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  if (!listed.ok) throw new Error("unreachable: the assertion above threw");
  return {
    ids: listed.value.items.map((item) => item.id).sort(),
    completeness: listed.value.completeness,
  };
}

function scriptPin(server: ScriptedServer, item: WireItemOptions): void {
  server.copyAnswer("GET", `/items/${item.id}`, {
    kind: "json",
    status: 200,
    body: withMetadata(wireItem(item)),
  });
  server.copyAnswer("GET", `/items/${item.id}/edges`, edgesPage([]));
}

describe("a copy whose cursor aged out", () => {
  it("fills again in place, changing, adding and sweeping rows", async () => {
    const rows: Rows = {
      "core.note": [
        { item: { id: "changed", properties: { title: "before" } } },
        { item: { id: "gone" } },
      ],
    };
    const { h } = await agedOut("refill-in-place", rows);

    rows["core.note"] = [
      { item: { id: "changed", version: 2, properties: { title: "after" } } },
      { item: { id: "added" } },
    ];
    // Meanwhile the copy answers what it held, marked stale.
    expect(await ids(h)).toEqual({
      ids: ["changed", "gone"],
      completeness: "stale",
    });
    // An edge read joins rows the refill may change, and its answer could
    // not say which, so it waits for the refill.
    const edges = await h.device.edgesFrom("changed");
    expect(
      edges.ok ? "answered" : edges.refusal.code,
      "an aged-out copy answered an edge read it cannot mark stale",
    ).toBe("hydration_incomplete");

    const refilled = await h.device.hydrate(["core.note"], "library");
    expect(refilled.ok, JSON.stringify(refilled)).toBe(true);
    expect(
      refilled.ok && refilled.value.in_place,
      "the hydration cleared the aged-out copy first, so its rows vanished while it ran",
    ).toBe(true);
    expect(refilled.ok && refilled.value.cursor).toBe("900");
    expect(
      await ids(h),
      "the refill left the copy unlike the server: a row it no longer holds stayed, or one it holds now is missing",
    ).toEqual({ ids: ["added", "changed"], completeness: "complete" });
    const changed = await h.device.get("changed");
    expect(changed.ok && changed.value.properties.title).toBe("after");
    expect(changed.ok && changed.value.version).toBe(2);
    // The witness: the whole copy answers the same edge read.
    expect((await h.device.edgesFrom("changed")).ok).toBe(true);
  });

  it("answers stale through an interrupted refill, sweeping nothing, and carries on in place", async () => {
    const rows: Rows = {
      "core.note": [
        { item: { id: "a" } },
        { item: { id: "b" } },
        { item: { id: "c" } },
      ],
    };
    let dropping = false;
    const { h } = await agedOut("refill-interrupted", rows, {
      pageSize: 1,
      drop: () => {
        if (!dropping) return false;
        dropping = false;
        return true;
      },
    });

    rows["core.note"] = [
      { item: { id: "a" } },
      { item: { id: "b", version: 2 } },
    ];
    dropping = true;
    const interrupted = await h.device.hydrate(["core.note"], "library");
    expect(
      interrupted.ok,
      "the refill was not interrupted, so nothing below is about one that was",
    ).toBe(false);
    // The walk had not reached every page, so the copy cannot know `c` is
    // gone: it keeps it, and says the answer may be out of date.
    expect(await ids(h)).toEqual({
      ids: ["a", "b", "c"],
      completeness: "stale",
    });

    const carried = await h.device.hydrate(["core.note"], "library");
    expect(carried.ok, JSON.stringify(carried)).toBe(true);
    expect(carried.ok && carried.value.resumed).toBe(true);
    expect(
      carried.ok && carried.value.in_place,
      "the hydration after an interrupted refill cleared the copy, so the rows it kept in reach vanished",
    ).toBe(true);
    expect(await ids(h)).toEqual({ ids: ["a", "b"], completeness: "complete" });
  });

  it("keeps a pinned row and a row a queued write names through the sweep", async () => {
    const rows: Rows = {
      "core.note": [
        { item: { id: "swept" } },
        { item: { id: "written" } },
        { item: { id: "stays" } },
      ],
    };
    const { h } = await agedOut("refill-keeps", rows, {
      // A row outside the slice, held only by its pin.
      before: async (held) => {
        scriptPin(held.server, { id: "pinned", tier: "feed" });
        expect((await held.device.pin("pinned")).ok).toBe(true);
      },
    });
    const edit = await h.device.update("written", {
      version: 1,
      properties: { title: "waiting" },
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    const queued = await h.device.queue();

    rows["core.note"] = [{ item: { id: "stays" } }];
    const refilled = await h.device.hydrate(["core.note"], "library");
    expect(refilled.ok, JSON.stringify(refilled)).toBe(true);
    expect(refilled.ok && refilled.value.in_place).toBe(true);

    // The witness: a row the walk did not bring went.
    const swept = await h.device.get("swept");
    expect(swept.ok, "the sweep kept a row the server no longer lists").toBe(
      false,
    );
    const pinned = await h.device.get("pinned");
    expect(pinned.ok, "the sweep took a pinned row").toBe(true);
    const written = await h.device.get("written");
    expect(
      written.ok,
      "the sweep took a row a queued write names, so the person's edit has nothing to show against",
    ).toBe(true);
    expect(written.ok && written.value.properties.title).toBe("waiting");
    expect(await h.device.queue()).toEqual(queued);
  });

  it("queues writes while it refills, sends none, and lays a newer page under them", async () => {
    const rows: Rows = {
      "core.note": [
        { item: { id: "held", properties: { title: "server", body: "old" } } },
      ],
    };
    const { h } = await agedOut("refill-writes", rows);

    const edit = await h.device.update("held", {
      version: 1,
      properties: { title: "mine" },
    });
    expect(
      edit.ok,
      `a copy whose cursor aged out refused an edit of a row it holds: ${JSON.stringify(edit)}`,
    ).toBe(true);
    const created = await h.device.create({
      type: "core.note",
      properties: { title: "new", body: "new" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const queued = await h.device.queue();
    expect(queued.ok && queued.value).toHaveLength(2);
    expect(
      queued.ok && queued.value.find((write) => write.item_id === "held"),
    ).toMatchObject({ base_version: 1 });

    const sentBefore = h.server.requests.length;
    const drained = await h.device.drain();
    expect(
      drained.ok,
      "a copy whose cursor aged out sent its queue, writing against a server it cannot follow",
    ).toBe(false);
    expect(h.server.requests.length, "the refused drain asked the server").toBe(
      sentBefore,
    );

    rows["core.note"] = [
      {
        item: {
          id: "held",
          version: 2,
          properties: { title: "server", body: "new" },
        },
      },
    ];
    const refilled = await h.device.hydrate(["core.note"], "library");
    expect(refilled.ok, JSON.stringify(refilled)).toBe(true);
    expect(refilled.ok && refilled.value.in_place).toBe(true);
    const shown = await h.device.get("held");
    expect(shown.ok, JSON.stringify(shown)).toBe(true);
    if (shown.ok) {
      expect(
        shown.value.properties.title,
        "the newer page replaced the person's waiting edit",
      ).toBe("mine");
      expect(
        shown.value.properties.body,
        "the newer page was not laid under the waiting edit",
      ).toBe("new");
    }
    // The write keeps the version it was made against, so the server
    // judges it against the change it never saw.
    expect(await h.device.queue()).toEqual(queued);
  });
});

describe("a copy that expired for another reason", () => {
  it("refuses reads and clears before it fills again", async () => {
    harness = await startHarness("refill-not-aged");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "first" } }] },
    });
    server.copyAnswer(
      "GET",
      "/events",
      {
        kind: "sse",
        frames: [connected, copyStreamCursor("7"), cursorAhead("10", "7")],
      },
      copyHeadRead("7"),
      copyReplay("7", []),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(false);

    // The log behind the copy's cursor is not the one it followed, so what
    // it holds may describe rows the server never had.
    const read = await device.list();
    expect(read.ok, "a copy that follows another log answered reads").toBe(
      false,
    );
    if (!read.ok) expect(read.refusal.code).toBe("hydration_incomplete");
    const write = await device.create({
      type: "core.note",
      properties: { title: "refused", body: "refused" },
    });
    expect(write.ok, "a copy that follows another log took a write").toBe(
      false,
    );

    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      again.ok && again.value.in_place,
      "a copy that followed another log was filled over what it held",
    ).toBe(false);
    const listed = await device.listAnswer();
    expect(listed.ok && listed.value.completeness).toBe("complete");
  });
});

describe("a copy a first hydration is filling", () => {
  it("takes writes to the rows it holds and new ones, sending none until it is whole", async () => {
    harness = await startHarness("first-fill-writes");
    const { server, device } = harness;
    let dropping = true;
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      rows: {
        "core.note": [
          {
            item: { id: "held", properties: { title: "server", body: "old" } },
          },
          { item: { id: "later" } },
        ],
      },
      drop: () => {
        if (!dropping) return false;
        dropping = false;
        return true;
      },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(false);
    const filling = await device.listAnswer();
    expect(filling.ok && filling.value.completeness).toBe("partial");
    expect(filling.ok && filling.value.items.map((item) => item.id)).toEqual([
      "held",
    ]);

    const edit = await device.update("held", {
      version: 1,
      properties: { title: "mine" },
    });
    expect(
      edit.ok,
      `a copy part way through its first fill refused an edit of a row it holds: ${JSON.stringify(edit)}`,
    ).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "new", body: "new" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const unheld = await device.update("later", {
      version: 1,
      properties: { title: "refused" },
    });
    expect(
      unheld.ok,
      "a copy took an edit of a row it has not read, writing from a version it never saw",
    ).toBe(false);
    if (!unheld.ok) expect(unheld.refusal.code).toBe("hydration_incomplete");
    const queued = await device.queue();
    expect(queued.ok && queued.value).toHaveLength(2);

    const sentBefore = server.requests.length;
    const drained = await device.drain();
    expect(drained.ok ? "drained" : drained.refusal.code).toBe(
      "hydration_incomplete",
    );
    expect(server.requests.length, "the refused drain asked the server").toBe(
      sentBefore,
    );

    const whole = await device.hydrate(["core.note"], "library");
    expect(whole.ok, JSON.stringify(whole)).toBe(true);
    expect(whole.ok && whole.value.in_place).toBe(false);
    const shown = await device.get("held");
    expect(shown.ok && shown.value.properties.title).toBe("mine");
    expect(await device.queue()).toEqual(queued);
  });
});
