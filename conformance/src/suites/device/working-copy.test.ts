import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { KEY, startHarness, scriptHydration, type Harness } from "./harness.js";
import {
  notWrittenYet,
  pendingUntilItPasses,
  skipIfPending,
} from "./pending.js";
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
              timestamp: ancient,
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

    const held = await device.list({ includeTrashed: true });
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

  it("refuses a read before any hydration", async (context) => {
    harness = await startHarness("read-before-hydration");
    const started = harness;
    await pendingUntilItPasses(context, async () => {
      const listed = await started.device.list();
      expect(
        listed.ok,
        "a store that has never hydrated answered a listing, so a caller cannot tell an empty slice from a copy that was never pulled",
      ).toBe(false);
    });
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
