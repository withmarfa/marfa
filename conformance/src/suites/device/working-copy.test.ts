import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  KEY,
  hydratedHarness,
  startHarness,
  scriptHydration,
  type Harness,
} from "./harness.js";
import { notWrittenYet, skipIfPending } from "./pending.js";
import {
  SCRIPTED_TYPES,
  connected,
  itemEvent,
  replay,
  streamCursor,
  wireItem,
  wireType,
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

  it("gives a second opener a reading handle that refuses writes", async () => {
    harness = await hydratedHarness("one-writer", {
      rows: { "core.note": [{ item: { id: "n1" } }] },
    });
    // A command that holds the store: a drain whose write the server accepts
    // and never answers. Every other command opens the store, does its work
    // and exits, so two of them never overlap and both are legitimately the
    // writer — the rule is about two at once, and nothing else here makes
    // that happen.
    const queued = await harness.device.create({
      type: "core.note",
      properties: { title: "held open", body: "held open" },
    });
    expect(queued.ok).toBe(true);
    harness.server.answer("POST", "/items", { kind: "stall" });
    const writer = harness.device.hold(["drain"]);

    try {
      await vi.waitFor(
        () => {
          expect(
            writer.running(),
            `the writer exited before it could hold anything: ${writer.stderr}`,
          ).toBe(true);
          expect(
            harness?.server.requests.some(
              (request) => request.method === "POST",
            ),
            "the held drain has not reached the server, so it may not have opened the store",
          ).toBe(true);
        },
        { timeout: 10_000, interval: 25 },
      );

      const second = harness.device.reopen();
      // It reads. A second opener is limited rather than refused, because a
      // file one process is writing is still a file another can read, and
      // refusing to open it would make a running watcher lock a person out
      // of their own copy.
      const listed = await second.list();
      expect(
        listed.ok,
        `a second opener could not read at all, so the store is locked rather than held by one writer: ${JSON.stringify(listed)}`,
      ).toBe(true);
      expect(listed.ok ? listed.value.length : 0).toBeGreaterThan(0);
      expect((await second.status()).ok).toBe(true);
      expect((await second.search("n1")).ok).toBe(true);

      // And it writes nothing.
      const wrote = await second.create({
        type: "core.note",
        properties: { title: "from the reader", body: "from the reader" },
      });
      expect(
        wrote.ok,
        "two processes both held the writer handle for one store, so both queue into one file and neither sees the other's rows",
      ).toBe(false);
      if (!wrote.ok) {
        expect(
          wrote.refusal.code,
          `the second opener was refused for some other reason, so nothing here shows it was given a reading handle: ${wrote.refusal.raw}`,
        ).toBe("reading_handle");
      }
      expect(
        writer.running(),
        "the process holding the writer handle exited while this ran, so the refusal above was a store with no writer rather than one with another",
      ).toBe(true);
    } finally {
      await writer.stop();
    }
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
      body: {
        data: [
          {
            id: "core.note",
            parent: null,
            label: "note",
            display_hints: {},
            fields: {},
          },
        ],
        next_cursor: null,
      },
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

  it("reports an interrupted re-hydration as in progress, not as a copy that aged out", async () => {
    // The state the other three words are defined against. A hydration
    // clears the cursor before it reads a page and leaves the previous
    // slice declared, so a re-hydration that dies partway leaves a store
    // that declares a slice and holds no cursor — which is the shape of a
    // copy whose cursor aged out. The two are told apart by the marker, and
    // which of them wins is a claim `device.md` 5 makes in words.
    harness = await startHarness("interrupted-rehydration");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "first" } }] },
    });
    // Queued behind the snapshot the first hydration takes: the server
    // hands out its answers in order, so the second hydration is the one
    // that dies partway.
    server.answer("GET", "/items", { kind: "drop" });

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const before = await device.status();
    expect(
      before.ok ? before.value.hydration : null,
      "the first hydration did not leave a complete copy, so what the second one leaves is not a statement about an interruption",
    ).toBe("complete");

    const second = await device.hydrate(["core.note"], "library");
    expect(
      second.ok,
      "the interrupted re-hydration reported success, so nothing below is a statement about an interrupted store",
    ).toBe(false);

    const after = await device.status();
    expect(
      after.ok,
      `the status door was refused after an interrupted re-hydration: ${JSON.stringify(after)}`,
    ).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.hydration,
      "an interrupted re-hydration reported itself as a copy that aged out, so a caller is told to wait for a log it will never catch rather than to run the hydration again",
    ).toBe("in_progress");
    // The witness that this store really is the shape `expired` describes:
    // the slice is still declared and the cursor is gone, so the two words
    // are separated by the marker and not by the store being different.
    expect(
      after.value.slice_types,
      "the interrupted re-hydration cleared the slice too, so this store is not the one the two words compete over",
    ).toContain("core.note");
    expect(
      after.value.event_cursor ?? null,
      "the interrupted re-hydration left a cursor, so the same",
    ).toBeNull();
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

describe("a local search narrows as a list does", () => {
  it("narrows a local search by type and tags as a list does", async () => {
    harness = await startHarness("search-narrowing");
    // A subtype by declared parent alone: its name shares no prefix with
    // `core.file`, so only the parent puts it in that subtree. Answered
    // before the hydration's own catalog, which it replaces for the one read
    // a hydration makes.
    harness.server.answer("GET", "/types", {
      kind: "json",
      status: 200,
      body: {
        data: [
          ...SCRIPTED_TYPES,
          wireType("user.photo", { parent: "core.file", titleField: "title" }),
        ],
        next_cursor: null,
      },
    });
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: { id: "note", properties: { title: "heron note" } },
            tags: ["garden", "birds"],
          },
        ],
        "core.file": [
          {
            item: {
              id: "image",
              type: "core.file.image",
              properties: { title: "heron image" },
            },
            tags: ["birds"],
          },
          {
            item: {
              id: "file",
              type: "core.file",
              properties: { title: "heron file" },
            },
          },
          {
            item: {
              id: "photo",
              type: "user.photo",
              properties: { title: "heron photo" },
            },
            tags: ["garden"],
          },
        ],
      },
    });
    expect(
      (await harness.device.hydrate(["core.note", "core.file"], "library")).ok,
    ).toBe(true);
    const ids = async (filters: {
      type?: string;
      tags?: string[];
    }): Promise<string[]> => {
      const hits = await harness!.device.search("heron", filters);
      expect(
        hits.ok,
        `a narrowed local search was refused: ${JSON.stringify(hits)}`,
      ).toBe(true);
      return hits.ok ? hits.value.map((hit) => hit.item.id).sort() : [];
    };
    // The control: unnarrowed, the search finds all four, so every absence
    // below is the narrowing.
    expect(await ids({})).toEqual(["file", "image", "note", "photo"]);
    expect(
      await ids({ type: "core.file" }),
      "a search narrowed to a type answered another type, or dropped a subtype a list would answer, by name or by declared parent",
    ).toEqual(["file", "image", "photo"]);
    expect(
      await ids({ tags: ["birds"] }),
      "a search narrowed to a tag answered a row without it",
    ).toEqual(["image", "note"]);
    expect(
      await ids({ tags: ["birds", "garden"] }),
      "a search narrowed by two tags answered a row carrying only one of them",
    ).toEqual(["note"]);
    expect(
      await ids({ type: "core.note", tags: ["birds", "garden"] }),
      "a search narrowed by a type and two tags answered a row lacking one of them",
    ).toEqual(["note"]);
  });
});

describe("a local list narrows on the item's own time", () => {
  /**
   * Both bounds are exclusive, which is one rule across the whole API
   * (`search-and-filters.md` 6). A device that read either of them
   * inclusively would answer a bounded list differently from the server it
   * copies, and the row that tells the two apart is the one sitting exactly
   * on the instant.
   */
  const ON_LOWER = "2026-03-01T00:00:00.000Z";
  const INSIDE = "2026-03-02T00:00:00.000Z";
  const ON_UPPER = "2026-03-03T00:00:00.000Z";
  const OUTSIDE = "2026-03-09T00:00:00.000Z";

  async function hydrateFourRows(label: string): Promise<void> {
    harness = await startHarness(label);
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          { item: { id: "on-lower", occurred_at: ON_LOWER } },
          { item: { id: "inside", occurred_at: INSIDE } },
          { item: { id: "on-upper", occurred_at: ON_UPPER } },
          { item: { id: "outside", occurred_at: OUTSIDE } },
        ],
      },
    });
    expect(
      (await harness.device.hydrate(["core.note"], "library")).ok,
      "the hydration failed, so nothing below is a statement about a bound",
    ).toBe(true);
  }

  it("excludes a row sitting exactly on either bound", async () => {
    await hydrateFourRows("bounds-exclusive");
    const listed = await harness!.device.list({
      occurredAfter: ON_LOWER,
      occurredBefore: ON_UPPER,
    });
    expect(
      listed.ok,
      `a bounded local list was refused: ${JSON.stringify(listed)}`,
    ).toBe(true);
    if (!listed.ok) return;
    const ids = listed.value.map((item) => item.id);

    // The witness. Without a row the query must return, both absences below
    // are satisfied by a bound that dropped its predicate and matched
    // nothing at all.
    expect(
      ids,
      "a bounded list answers nothing at all, so the exclusions below are free and say nothing about either bound",
    ).toContain("inside");
    expect(
      ids,
      "the lower bound is inclusive here and exclusive on the server, so a device and the server answer one query two ways",
    ).not.toContain("on-lower");
    expect(
      ids,
      "the upper bound is inclusive here and exclusive on the server, so the same query returns a different set on each side",
    ).not.toContain("on-upper");
    expect(
      ids,
      "a row outside the window came back, so the bounds narrow nothing",
    ).not.toContain("outside");
  });

  it("takes each bound on its own", async () => {
    await hydrateFourRows("bounds-single");
    const device = harness!.device;

    // One bound at a time, because a pair can agree by accident: a filter
    // that applied only the lower bound would pass the case above for the
    // upper one, since nothing there sits above the window and below it.
    const above = await device.list({ occurredAfter: ON_LOWER });
    expect(above.ok).toBe(true);
    if (above.ok) {
      const ids = above.value.map((item) => item.id);
      expect(
        ids,
        "a lower bound on its own drops rows above it, so it is narrowing something other than the item's own time",
      ).toEqual(expect.arrayContaining(["inside", "on-upper", "outside"]));
      expect(
        ids,
        "a lower bound on its own keeps the row sitting on it, so that bound alone is inclusive",
      ).not.toContain("on-lower");
    }

    const below = await device.list({ occurredBefore: ON_UPPER });
    expect(below.ok).toBe(true);
    if (below.ok) {
      const ids = below.value.map((item) => item.id);
      expect(
        ids,
        "an upper bound on its own drops rows below it, so it is narrowing something other than the item's own time",
      ).toEqual(expect.arrayContaining(["on-lower", "inside"]));
      expect(
        ids,
        "an upper bound on its own keeps the row sitting on it, so that bound alone is inclusive",
      ).not.toContain("on-upper");
    }
  });
});
