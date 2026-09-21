import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { KEY, startHarness, scriptHydration, type Harness } from "./harness.js";
import { notWrittenYet, skipIfPending } from "./pending.js";
import {
  connected,
  itemEvent,
  replay,
  streamCursor,
  wireItem,
} from "../../device/marfa-answers.js";

/**
 * "A device holds a working copy": one slice of one server, and nothing else.
 *
 * The slice is what makes a small app small and what keeps a phone from
 * holding a library. A device that quietly held a row outside its slice would
 * be a device whose size nobody can predict from what it declared, and one
 * that quietly dropped a row inside it would be a device that answers a
 * question wrongly with no way for the caller to tell.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("the working copy holds one slice", () => {
  it("holds the declared types and their subtrees and nothing else", async () => {
    harness = await startHarness("slice-types");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      replay("13", [
        // The control. A row of a declared type has to land, or every
        // assertion below passes against a device that applied nothing at all.
        itemEvent(
          "11",
          "item.created",
          wireItem({ id: "note", type: "core.note" }),
        ),
        itemEvent(
          "12",
          "item.created",
          wireItem({ id: "image", type: "core.file.image" }),
        ),
        itemEvent(
          "13",
          "item.created",
          wireItem({ id: "bookmark", type: "core.bookmark" }),
        ),
      ]),
    );

    expect(
      (await device.hydrate(["core.note", "core.file"], "library")).ok,
    ).toBe(true);
    const caught = await device.catchUp();
    expect(
      caught.ok,
      `the catch-up was refused: ${JSON.stringify(caught)}`,
    ).toBe(true);

    const held = await device.list();
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id).sort() : [];
    expect(
      ids,
      "a declared type, or the subtype under it, is missing from the copy, so a caller reading the slice it asked for is short rows the server announced",
    ).toContain("note");
    expect(
      ids,
      "a subtype of a declared type was not held, so declaring a type does not declare its subtree and every app has to name every child",
    ).toContain("image");
    expect(
      ids,
      "a row of a type outside the slice was held, so the copy grows past what the device declared and no app can predict its own size",
    ).not.toContain("bookmark");
  });

  it("holds one tier and not the other", async () => {
    harness = await startHarness("slice-tier");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      replay("12", [
        // The control, again: without a library row landing, an empty copy
        // would satisfy the assertion about the feed row.
        itemEvent(
          "11",
          "item.created",
          wireItem({ id: "library-row", tier: "library" }),
        ),
        itemEvent(
          "12",
          "item.created",
          wireItem({ id: "feed-row", tier: "feed" }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    const held = await device.list();
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    expect(
      ids,
      "the tier the device declared was not held, so the assertion below passes against an empty copy rather than against a device that keeps its tier",
    ).toContain("library-row");
    expect(
      ids,
      "a row of the other tier was held, so a device that asked for the library is carrying the feed as well",
    ).not.toContain("feed-row");
  });

  it("keeps an item however old it is", async () => {
    harness = await startHarness("no-expiry");
    const { server, device } = harness;
    // Four years before the log's retention could reach, and older than any
    // window a sweeper would plausibly be given.
    const ancient = "2022-01-01T00:00:00.000Z";
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "ancient",
              occurred_at: ancient,
              created_at: ancient,
              updated_at: ancient,
            },
          },
          { item: { id: "recent" } },
        ],
      },
    });
    server.answer(
      "GET",
      "/events",
      replay("11", [
        itemEvent("11", "item.created", wireItem({ id: "newest" })),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    const held = await device.list({ allStates: true });
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id).sort() : [];
    // The control: the rows a sweeper would have kept are there, so a missing
    // old row is an expiry rather than a copy that never landed.
    expect(
      ids,
      "the recent rows are missing, so this says nothing about the old one",
    ).toEqual(expect.arrayContaining(["newest", "recent"]));
    expect(
      ids,
      "an item was dropped for being old, so a device removes rows the server still holds and goes on reporting the slice as complete",
    ).toContain("ancient");
  });

  it("holds the thumbnail an item carries", async (context) => {
    skipIfPending(context);
    notWrittenYet("a thumbnail traveling with its item");
  });

  it("says the bytes are absent rather than the item", async (context) => {
    skipIfPending(context);
    notWrittenYet("absent bytes reported as absent bytes");
  });

  it("holds an item whose bytes it has not fetched", async () => {
    harness = await startHarness("blob-ref");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.file": [
          {
            item: {
              id: "file-row",
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: `sha256:${"a".repeat(64)}`,
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });

    expect((await device.hydrate(["core.file"], "library")).ok).toBe(true);
    const row = await device.get("file-row");
    expect(
      row.ok,
      `the item carrying a blob reference was not held: ${JSON.stringify(row)}`,
    ).toBe(true);
    if (row.ok) {
      expect(
        row.value.properties.blob_ref,
        "the item was held without the reference to its bytes, so nothing can fetch them later",
      ).toBe(`sha256:${"a".repeat(64)}`);
    }
    expect(
      server.requests.filter((request) =>
        request.pathname.startsWith("/blobs"),
      ),
      "the device fetched the bytes while hydrating, so a slice of a library would pull the library",
    ).toEqual([]);
  });
});

describe("the working copy belongs to one server", () => {
  it("binds to one origin and refuses a store opened against another", async () => {
    harness = await startHarness("origin");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const elsewhere = await startHarness("origin-other");
    try {
      const wrong = device.reopen({ url: elsewhere.server.url });
      const refused = await wrong.hydrate(["core.note"], "library");
      expect(
        refused.ok,
        "a store bound to one server accepted a hydration from another, so one file would carry two datasets with nothing recording which row came from where",
      ).toBe(false);
      if (!refused.ok) {
        expect(
          refused.refusal.code,
          `the device refused for some other reason, so nothing here shows it noticed the store belongs elsewhere: ${refused.refusal.raw}`,
        ).toBe("wrong_server");
        expect(
          refused.refusal.raw,
          "the refusal did not name the server the store belongs to, so a caller cannot tell which of the two is wrong",
        ).toContain(server.url);
        expect(
          refused.refusal.raw,
          "the refusal did not name the server that was offered",
        ).toContain(elsewhere.server.url);
      }
    } finally {
      await elsewhere.stop();
    }
  });

  it("keeps the key out of the store", async () => {
    harness = await startHarness("key-secrecy");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const file = readFileSync(device.store).toString("latin1");
    // The control. Without it a store the search never reached, or one whose
    // bytes are unreadable here, would report the key absent from anything.
    expect(
      file,
      "the store does not carry the origin it is bound to, so this file is not the one the device wrote and the search below proves nothing",
    ).toContain(server.url.replace("http://", ""));
    expect(
      file.includes(KEY),
      "the key is written into the store, so a copied file carries the credential with it",
    ).toBe(false);
  });

  it("gives a second opener a reading handle that refuses writes", async (context) => {
    skipIfPending(context);
    notWrittenYet("a second opener getting a reading handle");
  });
});

describe("the working copy says what it is", () => {
  it("reports its slice, cursor and hydration state before it has hydrated", async () => {
    harness = await startHarness("status-fresh");
    const status = await harness.device.status();
    expect(
      status.ok,
      `a device that has not hydrated could not report its own state: ${JSON.stringify(status)}`,
    ).toBe(true);
    if (!status.ok) return;
    expect(
      status.value.hydration,
      "a device that has never hydrated did not say so, so a caller cannot tell a hydration is owed",
    ).toBe("never");
    expect(
      status.value.slice_types,
      "a device that has declared nothing reported a slice, so its report is not a reading of what it holds",
    ).toEqual([]);
    expect(
      status.value.event_cursor ?? null,
      "a device with nowhere to resume from named a cursor, so a catch-up would replay from a point nothing chose",
    ).toBeNull();
    expect(
      status.value.server_origin ?? null,
      "a device that has hydrated from nowhere named a server it is bound to",
    ).toBeNull();
    expect(
      [status.value.items, status.value.edges],
      "a device that holds nothing reported holding something, so the counts are not a reading of the copy",
    ).toEqual([0, 0]);
  });

  it("refuses a read before any hydration", async () => {
    harness = await startHarness("read-before-hydration");
    const { device } = harness;

    // Every read door, because a refusal on one and an empty page on
    // another is the same wrong answer with a smaller blast radius.
    const listed = await device.list();
    expect(
      listed.ok,
      "a store that has never hydrated answered a listing, so a caller cannot tell an empty slice from a copy that was never pulled",
    ).toBe(false);
    if (!listed.ok) {
      expect(
        listed.refusal.code,
        `the read was refused for some other reason, so a caller is told to fix the wrong thing and never learns a hydration is owed: ${listed.refusal.raw}`,
      ).toBe("hydration_incomplete");
    }

    const found = await device.search("anything");
    expect(
      found.ok,
      "a store that has never hydrated answered a search, so an empty result set reads as a corpus with nothing in it",
    ).toBe(false);

    const got = await device.get("whatever");
    expect(
      got.ok,
      "a store that has never hydrated answered a read by id, so an absent row and a copy that was never pulled read the same",
    ).toBe(false);

    // The control: the device answers about itself before it has hydrated,
    // which is how a caller learns a hydration is owed (`device.md` 5). A
    // device that refused everything would satisfy the three above for a
    // reason that has nothing to do with the slice.
    const status = await device.status();
    expect(
      status.ok,
      "a device that has not hydrated could not report its own state, so the refusals above are a broken binary rather than the rule",
    ).toBe(true);
  });

  it("refuses a read after an interrupted hydration", async () => {
    harness = await startHarness("interrupted");
    const { server, device } = harness;
    server.answer("GET", "/events", {
      kind: "sse",
      frames: [connected, streamCursor("10")],
    });
    server.answer("GET", "/types", {
      kind: "json",
      status: 200,
      body: [
        {
          id: "core.note",
          parent: null,
          label: "note",
          display_hints: {},
          fields: {},
        },
      ],
    });
    // The snapshot dies partway: the first page lands, the second never
    // answers, which is what a device meets when a hydration is interrupted.
    server.answer("GET", "/items", { kind: "drop" });

    const hydrated = await device.hydrate(["core.note"], "library");
    expect(
      hydrated.ok,
      "the interrupted hydration reported success, so a caller is told it holds a slice that was never finished",
    ).toBe(false);

    const listed = await device.list();
    expect(
      listed.ok,
      "a store left half-hydrated answered a listing, so a caller reads a partial copy as though it were the slice",
    ).toBe(false);
    if (!listed.ok) {
      expect(
        listed.refusal.code,
        `the refusal did not say the hydration is incomplete: ${listed.refusal.raw}`,
      ).toBe("hydration_incomplete");
    }
  });
});

describe("a local read answers the active state unless asked otherwise", () => {
  /**
   * Three rows, one per state, in one slice. Hydration asks the server for
   * every state (`device.md` 31), so what the copy holds is not in question
   * here and what a read answers is.
   */
  async function hydrateEveryState(label: string): Promise<void> {
    harness = await startHarness(label);
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          { item: { id: "live", properties: { title: "zqlocal live" } } },
          {
            item: {
              id: "filed",
              state: "archived",
              properties: { title: "zqlocal filed" },
            },
          },
          {
            item: {
              id: "binned",
              state: "trashed",
              properties: { title: "zqlocal binned" },
            },
          },
        ],
      },
    });
    expect(
      (await harness.device.hydrate(["core.note"], "library")).ok,
      "the hydration failed, so nothing below is a statement about a read",
    ).toBe(true);

    // The slice is a type list and a tier, never a state: a hydration that
    // asked for the default would land only active rows, and every read
    // below would then be answered by a copy that never held the others.
    // The scripted server honors the parameter, so this is what keeps the
    // widening under test rather than assumed.
    const itemReads = harness.server.requests.filter(
      (request) => request.pathname === "/items",
    );
    expect(
      itemReads.length,
      "the hydration read no items door at all, so the assertions below are about an empty copy",
    ).toBeGreaterThan(0);
    for (const read of itemReads) {
      expect(
        read.query.get("state"),
        "hydration stopped asking for every state, so a working copy holds only active rows and a caller can never reach the rest",
      ).toBe("any");
    }
  }

  /** Every id the copy holds, whatever state it is in. */
  async function heldIds(): Promise<string[]> {
    const everything = await harness!.device.list({ allStates: true });
    expect(
      everything.ok,
      `the widened local list was refused, so the control every absence below leans on says nothing: ${JSON.stringify(everything)}`,
    ).toBe(true);
    return everything.ok ? everything.value.map((item) => item.id).sort() : [];
  }

  it("answers the active state on a local list that names none", async () => {
    await hydrateEveryState("local-list-state-default");
    const device = harness!.device;

    const listed = await device.list();
    expect(
      listed.ok,
      `a plain local list was refused, so the ids below are an empty array and every assertion on them holds vacuously: ${JSON.stringify(listed)}`,
    ).toBe(true);
    const ids = listed.ok ? listed.value.map((item) => item.id).sort() : [];
    expect(
      ids,
      "a local list naming no state stopped answering live rows, so an unnarrowed read reports an empty copy",
    ).toContain("live");
    expect(
      ids,
      "a local list naming no state answers archived rows, so a device and the server it copies give different answers to one question",
    ).not.toContain("filed");
    expect(
      ids,
      "a local list naming no state answers the bin, so a deleted row still reads as present on the device",
    ).not.toContain("binned");

    // The copy holds all three, so the absences above are the read's doing
    // rather than a hydration that never landed them.
    expect(
      await heldIds(),
      "the widening flag does not widen, so the rows the default hides are unreachable and the case above proves nothing",
    ).toEqual(["binned", "filed", "live"]);

    const filed = await device.list({ state: "archived" });
    expect(
      filed.ok,
      `naming a state on the local list door was refused outright, so the door has no setting at all: ${JSON.stringify(filed)}`,
    ).toBe(true);
    expect(
      filed.ok ? filed.value.map((item) => item.id) : [],
      "naming a state no longer reaches it, so a caller cannot ask for the rows the default hides",
    ).toEqual(["filed"]);
  });

  it("answers the active state on a local search that names none", async () => {
    await hydrateEveryState("local-search-state-default");
    const device = harness!.device;

    // This case's own store, so the list case's control does not carry: a
    // hydration that stopped landing non-active rows would make both
    // absences below true for the wrong reason.
    expect(
      await heldIds(),
      "the copy does not hold the rows the search must not answer, so the absences below say nothing about the search",
    ).toEqual(["binned", "filed", "live"]);

    const hits = await device.search("zqlocal");
    expect(
      hits.ok,
      `a plain local search was refused, so the ids below are an empty array and every assertion on them holds vacuously: ${JSON.stringify(hits)}`,
    ).toBe(true);
    const ids = hits.ok ? hits.value.map((hit) => hit.item.id).sort() : [];
    expect(
      ids,
      "a local search stopped matching live rows, so the local index answers nothing and the absences below are vacuous",
    ).toContain("live");
    expect(
      ids,
      "a local search answers a row a local list hides, which is two answers to one question on one device",
    ).not.toContain("filed");
    expect(
      ids,
      "a local search answers the bin, so a deleted row is still findable on the device",
    ).not.toContain("binned");

    // A caller who names a state is answered it, which is what makes the
    // default a default rather than the only selection the door has.
    const filed = await device.search("zqlocal", { state: "archived" });
    expect(
      filed.ok,
      `naming a state on the local search door was refused outright, so the door has no setting at all: ${JSON.stringify(filed)}`,
    ).toBe(true);
    expect(
      filed.ok ? filed.value.map((hit) => hit.item.id) : [],
      "naming a state no longer reaches it on the local search door, so the rows the default hides are unreachable by any local read",
    ).toEqual(["filed"]);
  });

  it("keeps a row in the bin out of the index, whatever state a search names", async () => {
    await hydrateEveryState("local-search-bin");
    const device = harness!.device;

    // The copy holds it, so what follows is the index rather than the slice.
    expect(
      await heldIds(),
      "the copy does not hold the row in the bin, so a search that misses it proves nothing about the index",
    ).toContain("binned");

    for (const [named, filters] of [
      ["the widening", { allStates: true }],
      ["the bin by name", { state: "trashed" }],
    ] as const) {
      const hits = await device.search("zqlocal", filters);
      expect(
        hits.ok,
        `a local search naming ${named} was refused outright: ${JSON.stringify(hits)}`,
      ).toBe(true);
      if (!hits.ok) continue;
      const ids = hits.value.map((hit) => hit.item.id);
      expect(
        ids,
        `a local search naming ${named} answers a row in the bin, so a device matches text the server it copies answers nothing for`,
      ).not.toContain("binned");
    }

    // The control, and it is the whole point of the case: the widening does
    // reach the archive. Without it the two absences above would be
    // satisfied by a widening that reached nothing at all.
    const widened = await device.search("zqlocal", { allStates: true });
    expect(widened.ok).toBe(true);
    expect(
      widened.ok ? widened.value.map((hit) => hit.item.id).sort() : [],
      "the widening reaches neither the archive nor the bin, so it widens nothing and the absences above say nothing about the bin",
    ).toEqual(["filed", "live"]);
  });

  it("reads an archived row by id and reports a trashed one as absent", async () => {
    await hydrateEveryState("local-get-state");
    const device = harness!.device;

    const filed = await device.get("filed");
    expect(
      filed.ok,
      `a read by id was refused, so the assertion below is about a broken door rather than about the archive: ${JSON.stringify(filed)}`,
    ).toBe(true);
    expect(
      filed.ok ? filed.value.id : undefined,
      "an archived row is not readable by id, so a caller holding its id is told it does not exist while the server would hand it over",
    ).toBe("filed");

    const live = await device.get("live");
    expect(
      live.ok,
      "an ordinary read by id was refused, so the absence below is about a broken door rather than the bin",
    ).toBe(true);

    // The witness for the absence below, which the two cases above carry and
    // this one did not. Hydrating proves the request asked for every state;
    // it does not prove the row landed. Without this, a device that dropped
    // trashed rows on ingest would pass this case while having lost the row
    // from `--all-states` reads and from what a catch-up prunes against.
    expect(
      await heldIds(),
      "the copy does not hold the binned row at all, so the absence below is a row that never arrived rather than one the read refuses",
    ).toEqual(["binned", "filed", "live"]);

    const binned = await device.get("binned");
    expect(
      binned.ok && binned.value !== null,
      "a row in the bin is readable by id, so a device hands back a row the server it copies answers 404 for",
    ).toBe(false);
  });
});
