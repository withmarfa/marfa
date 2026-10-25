import { afterEach, describe, expect, it } from "vitest";
import {
  catchupTooOld,
  connected,
  copyHeadRead,
  copyReplay,
  copyStreamCursor,
  cursorAhead,
  edgesPage,
  answers,
  SCRIPTED_INSTANCE,
  SCRIPTED_REACH,
  writeAnswers,
  refusal,
  typeCatalog,
  wireEdge,
  wireItem,
  withMetadata,
  type WireEdgeOptions,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import {
  BUILT_FOR,
  type Answer,
  type ScriptedServer,
} from "../../device/scripted-server.js";
import {
  fileOf,
  scriptHydration,
  scriptWrites,
  startHarness,
  type Harness,
} from "./harness.js";

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
    /** The instance every read of the log names, the scripted one unless
     *  named. */
    instance?: () => string;
    /** The reach every read of the log's head names, the scripted one
     *  unless named. */
    reach?: () => string;
  } = {},
): Promise<{
  h: Harness;
  head: { now: string };
  /** What a read of the log's head, or of the type catalog, answers in
   *  place of its answer while set. */
  refuse: { head?: Answer; types?: Answer };
}> {
  harness = await startHarness(label);
  const h = harness;
  const head = { now: "10" };
  const refuse: { head?: Answer; types?: Answer } = {};
  let aging = false;
  scriptHydration(h.server, {
    head: () => head.now,
    catalog: () => refuse.types ?? typeCatalog(),
    rows,
    pageSize: options.pageSize,
    drop: options.drop,
    instance: options.instance,
  });
  const named = (answer: Answer): Answer =>
    (options.instance === undefined && options.reach === undefined) ||
    answer.kind !== "sse"
      ? answer
      : {
          ...answer,
          frames: answer.frames.map((frame) => {
            if (
              frame.event !== "stream_cursor" &&
              frame.event !== "stream_live"
            )
              return frame;
            const data = { ...(frame.data as Record<string, unknown>) };
            if (options.instance !== undefined)
              data.instance_id = options.instance();
            if (options.reach !== undefined) data.reach = options.reach();
            return { ...frame, data };
          }),
        };
  h.server.copyAnswer("GET", "/events", (request) => {
    const cursor = request.headers["last-event-id"];
    if (cursor === undefined)
      return refuse.head ?? named(copyHeadRead(head.now));
    if (aging) {
      aging = false;
      head.now = "900";
      return named({
        kind: "sse",
        frames: [
          connected,
          copyStreamCursor("900"),
          catchupTooOld("500", cursor),
        ],
      });
    }
    return named(copyReplay(head.now, []));
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
  return { h, head, refuse };
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

async function hydration(h: Harness): Promise<string | undefined> {
  const status = await h.device.status();
  expect(status.ok, JSON.stringify(status)).toBe(true);
  return status.ok ? status.value.hydration : undefined;
}

/** That `call` was refused as a copy whose cursor aged out, sending nothing. */
async function refusedAgedOut(
  h: Harness,
  call: string,
  run: () => Promise<{ ok: boolean; refusal?: { code: string; raw: string } }>,
): Promise<void> {
  const asked = h.server.requests.length;
  const answer = await run();
  expect(
    answer.ok ? "answered" : answer.refusal?.code,
    `${call} of a stale copy was not refused copy_expired`,
  ).toBe("copy_expired");
  expect(
    answer.refusal?.raw,
    `${call} of a stale copy did not say its cursor aged out`,
  ).toContain("catchup_too_old");
  expect(
    h.server.requests.length,
    `${call} of a stale copy asked the server`,
  ).toBe(asked);
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

    expect(await hydration(h)).toBe("stale");
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
    expect(
      await hydration(h),
      "a refill broken off reported a first fill, not a stale copy",
    ).toBe("stale");
    await refusedAgedOut(h, "a drain part way through a refill", () =>
      h.device.drain(),
    );
    await refusedAgedOut(h, "a catch-up part way through a refill", () =>
      h.device.catchUp(),
    );

    const carried = await h.device.hydrate(["core.note"], "library");
    expect(carried.ok, JSON.stringify(carried)).toBe(true);
    expect(carried.ok && carried.value.resumed).toBe(true);
    expect(
      carried.ok && carried.value.in_place,
      "the hydration after an interrupted refill cleared the copy, so the rows it kept in reach vanished",
    ).toBe(true);
    expect(await ids(h)).toEqual({ ids: ["a", "b"], completeness: "complete" });
    expect(await hydration(h)).toBe("complete");
  });

  it("clears rather than fill again where the log ends before the head its refill started from", async () => {
    const rows: Rows = {
      "core.note": [{ item: { id: "a" } }, { item: { id: "b" } }],
    };
    let dropping = false;
    const { h, head } = await agedOut("refill-restored", rows, {
      pageSize: 1,
      drop: () => {
        if (!dropping) return false;
        dropping = false;
        return true;
      },
    });
    rows["core.note"] = [
      { item: { id: "a", version: 5 } },
      { item: { id: "b" } },
    ];
    dropping = true;
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(false);
    const taken = await h.device.get("a");
    expect(
      taken.ok && taken.value.version,
      "the broken-off refill did not take the newer row, so nothing below shows it going",
    ).toBe(5);

    // The server is restored from a backup whose log ends at 2, before the
    // head the refill started from, holding `a` at an earlier version.
    head.now = "2";
    rows["core.note"] = [
      { item: { id: "a", version: 2 } },
      { item: { id: "c" } },
    ];
    const again = await h.device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.ok && again.value.restarted).toBe("head_past_log");
    expect(
      again.ok && again.value.in_place,
      "a refill of a restored server filled over rows it may never have held",
    ).toBe(false);
    expect(await ids(h)).toEqual({ ids: ["a", "c"], completeness: "complete" });
    const restored = await h.device.get("a");
    expect(
      restored.ok && restored.value.version,
      "the copy kept a version the restored server never had",
    ).toBe(2);
  });

  it("ends the stale copy when its refill reads another instance", async () => {
    const rows: Rows = {
      "core.note": [{ item: { id: "a" } }, { item: { id: "b" } }],
    };
    let instance = "01900000-0000-7000-8000-00000000aaaa";
    let dropping = false;
    const { h } = await agedOut("refill-other-instance", rows, {
      pageSize: 1,
      instance: () => instance,
      drop: () => {
        if (!dropping) return false;
        dropping = false;
        return true;
      },
    });
    expect(await hydration(h)).toBe("stale");

    instance = "01900000-0000-7000-8000-00000000bbbb";
    dropping = true;
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(false);
    expect(
      await hydration(h),
      "a copy built under another instance stayed stale",
    ).toBe("in_progress");
    const listed = await h.device.listAnswer();
    expect(listed.ok && listed.value.completeness).toBe("partial");
    expect(
      listed.ok && listed.value.items.map((item) => item.id),
      "rows read from the other instance were answered beside the ones it never held",
    ).toEqual(["a"]);
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

    await refusedAgedOut(h, "a drain", () => h.device.drain());
    await refusedAgedOut(h, "a catch-up", () => h.device.catchUp());

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

describe("a stale copy and its follow", () => {
  it("refuses a follow before a refill begins, and waits out one broken off, sending nothing", async () => {
    const rows: Rows = {
      "core.note": [{ item: { id: "a" } }, { item: { id: "b" } }],
    };
    let dropping = false;
    const { h } = await agedOut("refill-follow", rows, {
      pageSize: 1,
      drop: () => {
        if (!dropping) return false;
        dropping = false;
        return true;
      },
    });
    const asked = h.server.requests.length;
    const started = Date.now();
    const refused = await h.device.follow(5);
    expect(
      refused.ok ? "waited" : refused.refusal.code,
      "a follow on a stale copy no refill has begun waited for a hydration nobody asked for",
    ).toBe("copy_expired");
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(
      h.server.requests.length,
      "the refused follow asked the server",
    ).toBe(asked);

    dropping = true;
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(false);
    const broken = h.server.requests.length;
    const waited = await h.device.follow(1);
    expect(
      waited.ok,
      `a follow on a copy part way through a refill was refused: ${JSON.stringify(waited)}`,
    ).toBe(true);
    expect(waited.ok && waited.value.changes).toEqual([]);
    expect(
      h.server.requests.slice(broken),
      "a follow waiting for a refill asked the server",
    ).toEqual([]);

    // The witness: once the refill completes, the same follow asks for its
    // stream.
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
    const whole = h.server.requests.length;
    expect((await h.device.follow(1)).ok).toBe(true);
    expect(
      h.server.requests
        .slice(whole)
        .filter((request) => request.pathname === "/events").length,
    ).toBeGreaterThan(0);
  });
});

describe("a refill's sweep", () => {
  it("keeps the rows a queued edge write names and the edge itself", async () => {
    const rows: Rows = {
      "core.note": [
        { item: { id: "from" } },
        { item: { id: "aimed" } },
        { item: { id: "swept" } },
      ],
    };
    // The edge write is made while the copy is whole, since a copy that
    // is not whole refuses one (`device/write-edge-refused-incomplete`).
    const { h } = await agedOut("refill-keeps-edge-ends", rows, {
      before: async (whole) => {
        const linked = await whole.device.createEdge({
          source: "from",
          target: "aimed",
          type: "core.related",
        });
        expect(linked.ok, JSON.stringify(linked)).toBe(true);
      },
    });
    const queued = await h.device.queue();
    expect(queued.ok && queued.value).toHaveLength(1);

    // The server lists neither end now.
    rows["core.note"] = [];
    const refilled = await h.device.hydrate(["core.note"], "library");
    expect(refilled.ok, JSON.stringify(refilled)).toBe(true);
    expect(refilled.ok && refilled.value.in_place).toBe(true);

    // The witness: a row nothing names went.
    expect(
      (await h.device.get("swept")).ok,
      "the sweep kept a row the server no longer lists",
    ).toBe(false);
    for (const end of ["from", "aimed"]) {
      expect(
        (await h.device.get(end)).ok,
        `the sweep took ${end}, an end of an edge the person is still waiting to send`,
      ).toBe(true);
    }
    const edges = await h.device.edgesFrom("from");
    expect(edges.ok, JSON.stringify(edges)).toBe(true);
    expect(
      edges.ok && edges.value.map((edge) => edge.target_id),
      "the sweep took the edge a queued write names",
    ).toEqual(["aimed"]);
    expect(await h.device.queue()).toEqual(queued);
  });
});

describe("a stale copy before its refill reads a page", () => {
  it("clears rather than fill again where the server was restored before its refill began", async () => {
    const rows: Rows = { "core.note": [{ item: { id: "a", version: 5 } }] };
    const { h, head } = await agedOut("refill-restored-first", rows);
    const held = await h.device.get("a");
    expect(held.ok && held.value.version).toBe(5);

    // The server is restored from a backup whose log ends at 2, before the
    // cursor 10 the copy held, holding `a` at an earlier version.
    head.now = "2";
    rows["core.note"] = [
      { item: { id: "a", version: 2 } },
      { item: { id: "c" } },
    ];
    const again = await h.device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      again.ok && again.value.in_place,
      "a refill of a restored server filled over rows it may never have held",
    ).toBe(false);
    expect(await ids(h)).toEqual({ ids: ["a", "c"], completeness: "complete" });
    const restored = await h.device.get("a");
    expect(
      restored.ok && restored.value.version,
      "the copy kept a version the restored server never had",
    ).toBe(2);
  });

  it("fills in place from a head level with the cursor the copy held", async () => {
    const rows: Rows = { "core.note": [{ item: { id: "a" } }] };
    const { h, head } = await agedOut("refill-level-head", rows);
    head.now = "10";
    const again = await h.device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.ok && again.value.in_place).toBe(true);
  });

  it("ends the stale copy when the server refuses the credential or the reach before the refill reads a page", async () => {
    const rows: Rows = { "core.note": [{ item: { id: "a" } }] };
    // The witness: a refusal that says nothing of the credential or the
    // reach leaves the copy stale.
    {
      const { h, refuse } = await agedOut("refill-unavailable", rows);
      refuse.head = refusal(503, "unavailable", "try again later");
      expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(false);
      expect(await hydration(h)).toBe("stale");
      await h.stop();
      harness = undefined;
    }
    for (const [door, answer, reason] of [
      [
        "head",
        refusal(401, "unauthorized", "Invalid or missing credential"),
        "credential_ended",
      ],
      [
        "types",
        refusal(409, "reach_changed", "the reach has changed"),
        "reach_changed",
      ],
    ] as const) {
      const { h, refuse } = await agedOut(`refill-${reason}`, rows);
      refuse[door] = answer;
      const refused = await h.device.hydrate(["core.note"], "library");
      expect(
        refused.ok ? "hydrated" : refused.refusal.code,
        `${reason}: the refill was not refused copy_expired`,
      ).toBe("copy_expired");
      expect(refused.ok ? "" : refused.refusal.raw).toContain(reason);
      expect(
        await hydration(h),
        `${reason}: the copy stayed stale, answering rows the server may no longer let the credential read`,
      ).toBe("expired");
      const read = await h.device.list();
      expect(
        read.ok ? "answered" : read.refusal.code,
        `${reason}: the copy still answered reads`,
      ).toBe("hydration_incomplete");
      const write = await h.device.update("a", {
        version: 1,
        properties: { title: "refused" },
      });
      expect(
        write.ok ? "queued" : write.refusal.code,
        `${reason}: the copy still took a write`,
      ).toBe("hydration_incomplete");
      await h.stop();
      harness = undefined;
    }
  });
});

describe("an edge write to a copy that is not whole", () => {
  const link = {
    id: "link",
    source_id: "from",
    target_id: "to",
    edge_type: "references",
  };
  const linked: Rows = {
    "core.note": [
      {
        item: {
          id: "from",
          edges: {
            references: { data: [wireEdge(link)], next_cursor: null },
          },
        },
      },
      { item: { id: "to" } },
      { item: { id: "other" } },
    ],
  };

  it("refuses an edge write while the copy is stale, queueing nothing, and takes it once the copy is whole", async () => {
    const { h } = await agedOut("refill-edge-writes", linked);
    const writes: Array<
      [string, () => Promise<{ ok: boolean; refusal?: { code: string } }>]
    > = [
      [
        "a create",
        () =>
          h.device.createEdge({
            source: "from",
            target: "other",
            type: "references",
          }),
      ],
      [
        "an edit",
        () =>
          h.device.updateEdge("link", {
            properties: { weight: 2 },
            version: 1,
          }),
      ],
      [
        "a move",
        () =>
          h.device.updateEdge("link", {
            properties: {},
            version: 1,
            target_id: "other",
          }),
      ],
      ["a delete", () => h.device.deleteEdge("link")],
    ];
    for (const [write, run] of writes) {
      const answer = await run();
      expect(
        answer.ok ? "queued" : answer.refusal?.code,
        `${write} of an edge was queued while a page still to arrive could bring the server's edge beneath it`,
      ).toBe("hydration_incomplete");
    }
    const queued = await h.device.queue();
    expect(queued.ok && queued.value).toEqual([]);
    // An item write is still taken.
    expect(
      (
        await h.device.update("from", {
          version: 1,
          properties: { title: "mine" },
        })
      ).ok,
    ).toBe(true);

    const refilled = await h.device.hydrate(["core.note"], "library");
    expect(refilled.ok, JSON.stringify(refilled)).toBe(true);
    // The witness: the whole copy takes the same writes.
    for (const [write, run] of writes.slice(0, 2)) {
      const answer = await run();
      expect(answer.ok, `${write}: ${JSON.stringify(answer)}`).toBe(true);
    }
  });

  it("refuses an edge write part way through a first fill", async () => {
    harness = await startHarness("first-fill-edge-writes");
    const { device } = harness;
    let dropping = true;
    scriptHydration(harness.server, {
      head: "10",
      pageSize: 1,
      rows: linked,
      drop: () => {
        if (!dropping) return false;
        dropping = false;
        return true;
      },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(false);
    const created = await device.create({
      type: "core.note",
      properties: { title: "new", body: "new" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const edge = await device.createEdge({
      source: created.value.item_id ?? "",
      target: "from",
      type: "references",
    });
    expect(
      edge.ok ? "queued" : edge.refusal.code,
      "an edge write was queued part way through a first fill",
    ).toBe("hydration_incomplete");
    const queued = await device.queue();
    expect(queued.ok && queued.value).toHaveLength(1);
  });

  it("queues a body edit with links while the copy is stale, and reads its links once the server answers it", async () => {
    const rows: Rows = {
      "core.note": [
        { item: { id: "host", properties: { title: "host", body: "none" } } },
        { item: { id: "other" } },
      ],
    };
    const { h } = await agedOut("refill-body-links", rows);
    const edit = await h.device.update("host", {
      version: 1,
      properties: { body: "see [[other]]" },
    });
    expect(
      edit.ok,
      `a stale copy refused a body edit of a row it holds: ${JSON.stringify(edit)}`,
    ).toBe(true);
    const queued = await h.device.queue();
    expect(
      queued.ok && queued.value.map((write) => write.kind),
      "the body edit queued an edge write while the copy was not whole",
    ).toEqual(["update_item"]);

    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
    const answered = wireItem({
      id: "host",
      version: 2,
      properties: { title: "host", body: "see [[other]]" },
    });
    scriptWrites(h.server, {
      update: [answers.updated(answered)],
      read: [answers.updated(answered)],
    });
    expect((await h.device.drain()).ok).toBe(true);
    // The edit's answer queues the link's edge, which the next drain sends.
    const made: Record<string, WireEdgeOptions> = {};
    scriptWrites(h.server, {
      edges: [
        (request) => {
          const sent = JSON.parse(request.body) as WireEdgeOptions;
          made[sent.id] = sent;
          return writeAnswers.edge(sent);
        },
      ],
    });
    h.server.copyAnswer("GET", /^\/edges\/[^/]+$/, (request) => ({
      kind: "json",
      status: 200,
      body: {
        edge: wireEdge(made[request.pathname.slice("/edges/".length)]),
      },
    }));
    const asked = h.server.requests.length;
    expect((await h.device.drain()).ok).toBe(true);
    expect(
      h.server.requests
        .slice(asked)
        .filter(
          (request) =>
            request.method === "POST" && request.pathname === "/edges",
        )
        .map((request) => {
          const sent = JSON.parse(request.body) as {
            source_id: string;
            target_id: string;
          };
          return [sent.source_id, sent.target_id];
        }),
      "the body's link was not read once the server answered the edit",
    ).toEqual([["host", "other"]]);
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

  it("takes files added alone or attached to a row it holds, sending none until it is whole", async () => {
    harness = await startHarness("first-fill-files");
    const h = harness;
    const { server, device } = h;
    let dropping = true;
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      rows: {
        "core.note": [{ item: { id: "held" } }, { item: { id: "later" } }],
      },
      drop: () => {
        if (!dropping) return false;
        dropping = false;
        return true;
      },
    });
    expect(
      (await device.hydrate(["core.note", "core.file"], "library")).ok,
    ).toBe(false);
    expect(await hydration(h)).toBe("in_progress");

    const added = await device.addFile(fileOf("alone.bin", "twelve bytes"));
    expect(
      added.ok,
      `a copy part way through its first fill refused a new file: ${JSON.stringify(added)}`,
    ).toBe(true);
    const attached = await device.attach(
      "held",
      fileOf("photo.bin", "fifteen bytes!!"),
    );
    expect(
      attached.ok,
      `a copy part way through its first fill refused a file attached to a row it holds: ${JSON.stringify(attached)}`,
    ).toBe(true);
    const unheld = await device.attach(
      "later",
      fileOf("other.bin", "nine byt"),
    );
    expect(
      unheld.ok ? "attached" : unheld.refusal.code,
      "a copy attached a file to a row it has not read",
    ).toBe("hydration_incomplete");
    const queued = await device.queue();
    expect(queued.ok && queued.value).toHaveLength(5);
    expect(
      server.requests.filter((request) =>
        request.pathname.startsWith("/blobs"),
      ),
      "a copy part way through its first fill sent an upload",
    ).toEqual([]);

    const whole = await device.hydrate(["core.note", "core.file"], "library");
    expect(whole.ok, JSON.stringify(whole)).toBe(true);
    expect(await device.queue()).toEqual(queued);
  });
});

describe("a fill asked to happen only in place", () => {
  /** What a refused fill must leave exactly as it was. */
  async function kept(h: Harness): Promise<unknown> {
    const status = await h.device.status();
    const listed = await h.device.listAnswer();
    return {
      status,
      listed,
      queue: await h.device.queue(),
    };
  }

  /** That an in-place fill was refused `copy_expired` with `reason`,
   *  leaving the copy, its state and its queue as they were. */
  async function refusedInPlace(
    h: Harness,
    reason: string,
    types: string[] = ["core.note"],
    tier: "library" | "feed" | "all" = "library",
  ): Promise<void> {
    const before = await kept(h);
    const refused = await h.device.hydrate(types, tier, { inPlaceOnly: true });
    expect(
      refused.ok ? "filled" : refused.refusal.code,
      `an in-place fill went ahead where it could not be in place: ${JSON.stringify(refused)}`,
    ).toBe("copy_expired");
    expect(refused.ok ? "" : refused.refusal.raw).toContain(reason);
    expect(
      await kept(h),
      "a refused in-place fill changed the copy, its state or its queue",
    ).toEqual(before);
  }

  /** A stale copy holding `a` and `b`, with an edit and a create queued. */
  async function staleWithWrites(
    label: string,
    options: Parameters<typeof agedOut>[2] = {},
  ): Promise<Awaited<ReturnType<typeof agedOut>> & { rows: Rows }> {
    const rows: Rows = {
      "core.note": [
        { item: { id: "a", properties: { title: "server", body: "a" } } },
        { item: { id: "b" } },
      ],
    };
    const aged = await agedOut(label, rows, options);
    const edit = await aged.h.device.update("a", {
      version: 1,
      properties: { title: "mine" },
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    const created = await aged.h.device.create({
      type: "core.note",
      properties: { title: "new", body: "new" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(await hydration(aged.h)).toBe("stale");
    return { ...aged, rows };
  }

  it("fills a stale copy in place, keeping its queue and its files", async () => {
    const { h, rows } = await staleWithWrites("in-place-only-fills");
    const attached = await h.device.attach(
      "b",
      fileOf("kept.bin", "kept bytes"),
    );
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    const queued = await h.device.queue();
    expect(queued.ok && queued.value).toHaveLength(5);
    const upload = queued.ok
      ? queued.value.find((write) => write.kind === "upload_blob")
      : undefined;
    expect(upload?.blob, "no upload was queued with the file").toBeTruthy();
    // The file's row is the copy's own create, held pinned outside the
    // slice, which the server does not hold yet.
    h.server.copyAnswer(
      "GET",
      /^\/items\/[^/]+$/,
      refusal(404, "not_found", "No such item"),
    );

    rows["core.note"] = [
      {
        item: {
          id: "a",
          version: 2,
          properties: { title: "server", body: "newer" },
        },
      },
      { item: { id: "b" } },
    ];
    const filled = await h.device.hydrate(["core.note"], "library", {
      inPlaceOnly: true,
    });
    expect(filled.ok, JSON.stringify(filled)).toBe(true);
    expect(filled.ok && filled.value.in_place).toBe(true);
    expect(await h.device.queue()).toEqual(queued);
    const shown = await h.device.get("a");
    expect(shown.ok && shown.value.properties.title).toBe("mine");
    expect(shown.ok && shown.value.properties.body).toBe("newer");
    const bytes = await h.device.blob(upload?.blob ?? "");
    expect(
      bytes.ok,
      `the file's bytes were not kept: ${JSON.stringify(bytes)}`,
    ).toBe(true);
    expect(
      h.server.requests.filter((request) =>
        request.pathname.startsWith("/blobs"),
      ),
      "the in-place fill sent the queued upload",
    ).toEqual([]);
  });

  it("carries on an interrupted in-place fill in place", async () => {
    let dropping = false;
    const { h, rows } = await staleWithWrites("in-place-only-resumed", {
      pageSize: 1,
      drop: () => {
        if (!dropping) return false;
        dropping = false;
        return true;
      },
    });
    const queued = await h.device.queue();
    rows["core.note"] = [
      { item: { id: "a", version: 2 } },
      { item: { id: "b" } },
    ];
    dropping = true;
    const interrupted = await h.device.hydrate(["core.note"], "library", {
      inPlaceOnly: true,
    });
    expect(
      interrupted.ok ? "filled" : interrupted.refusal.code,
      "the in-place fill was not interrupted, so nothing below is about one that was",
    ).not.toBe("filled");
    expect(interrupted.ok ? "" : interrupted.refusal.code).not.toBe(
      "copy_expired",
    );
    expect(await hydration(h)).toBe("stale");
    expect((await ids(h)).ids).toContain("b");

    const carried = await h.device.hydrate(["core.note"], "library", {
      inPlaceOnly: true,
    });
    expect(carried.ok, JSON.stringify(carried)).toBe(true);
    expect(carried.ok && carried.value.resumed).toBe(true);
    expect(carried.ok && carried.value.in_place).toBe(true);
    expect(await h.device.queue()).toEqual(queued);
    expect(await hydration(h)).toBe("complete");
  });

  it("refuses to fill from another instance, leaving the copy as it was", async () => {
    let instance = "01900000-0000-7000-8000-00000000aaaa";
    const { h } = await staleWithWrites("in-place-only-instance", {
      instance: () => instance,
    });
    instance = "01900000-0000-7000-8000-00000000bbbb";
    await refusedInPlace(h, "instance_changed");

    // The witness: asked for any fill, the same hydration replaces the copy.
    const replaced = await h.device.hydrate(["core.note"], "library");
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(replaced.ok && replaced.value.in_place).toBe(false);
  });

  it("refuses to fill under another reach, leaving the copy as it was", async () => {
    let reach = SCRIPTED_REACH;
    const { h } = await staleWithWrites("in-place-only-reach", {
      reach: () => reach,
    });
    reach = "b".repeat(64);
    await refusedInPlace(h, "reach_changed");

    // The witness: asked for any fill, the same hydration ends the stale
    // copy before it reads a page.
    await h.device.hydrate(["core.note"], "library");
    expect(await hydration(h)).not.toBe("stale");
  });

  it("refuses to fill another slice, leaving the copy as it was", async () => {
    const { h } = await staleWithWrites("in-place-only-slice");
    await refusedInPlace(h, "slice_changed", ["core.note"], "all");

    // The witness: asked for any fill, the same slice replaces the copy.
    const replaced = await h.device.hydrate(["core.note"], "all");
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(replaced.ok && replaced.value.in_place).toBe(false);
  });

  it("refuses to fill a copy whose server was restored, leaving the copy as it was", async () => {
    const { h, head } = await staleWithWrites("in-place-only-restored");
    head.now = "2";
    await refusedInPlace(h, "head_past_log");

    const replaced = await h.device.hydrate(["core.note"], "library");
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(replaced.ok && replaced.value.in_place).toBe(false);
  });

  it("refuses to fill a copy a drain expired for another instance, naming the instance", async () => {
    harness = await startHarness("in-place-only-drain-instance");
    const h = harness;
    let instance = SCRIPTED_INSTANCE;
    h.server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    scriptHydration(h.server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "a" } }] },
      instance: () => instance,
    });
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await h.device.create({
      type: "core.note",
      properties: { title: "new", body: "new" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    instance = "00000000-0000-7000-8000-0000000000ff";
    const drained = await h.device.drain();
    expect(drained.ok ? "drained" : drained.refusal.code).toBe("copy_expired");
    await refusedInPlace(h, "instance_changed");

    // The witness: asked for any fill, the same hydration replaces the copy.
    const replaced = await h.device.hydrate(["core.note"], "library");
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(replaced.ok && replaced.value.in_place).toBe(false);
  });

  it("refuses to fill a copy that is not stale, leaving it as it was", async () => {
    harness = await startHarness("in-place-only-whole");
    const h = harness;
    scriptHydration(h.server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "a" } }] },
    });
    await refusedInPlace(h, "not_stale");
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await h.device.create({
      type: "core.note",
      properties: { title: "new", body: "new" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await refusedInPlace(h, "not_stale");

    // The witness: asked for any fill, the same hydration replaces the copy.
    const replaced = await h.device.hydrate(["core.note"], "library");
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(replaced.ok && replaced.value.in_place).toBe(false);
  });
});
