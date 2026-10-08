import { describe, it, expect, afterEach } from "vitest";
import {
  startHarness,
  scriptHydration,
  scriptKey,
  type Harness,
} from "./harness.js";
import {
  answers,
  edgesPage,
  copyHeadRead,
  copyItemEvent,
  itemsPage,
  refusal,
  copyReplay,
  copyIncompleteReplay,
  edgeTypeCatalog,
  typeCatalog,
  wireEdge,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";
import type { DeviceUnderTest } from "../../device/protocol.js";

/**
 * "Hydration subscribes first, then reads."
 *
 * The ordering is the whole rule. A device that reads the rows and then asks
 * where the log has reached names a resume point past every write that landed
 * during the read, and those writes are then in neither the snapshot nor the
 * replay. Nothing reports them missing: the copy is simply wrong, by exactly
 * the writes somebody made while it was being built.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function edgeIds(device: DeviceUnderTest, id: string): Promise<string[]> {
  const read = await device.edgesFrom(id);
  expect(read.ok, JSON.stringify(read)).toBe(true);
  return read.ok ? read.value.map((edge) => edge.id) : [];
}

describe("what a hydration declares", () => {
  it("refuses an empty type list and a bare wildcard before reading anything", async () => {
    harness = await startHarness("declare");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });

    for (const types of [[], ["*"]]) {
      const refused = await device.hydrate(types, "library");
      expect(
        refused.ok,
        `hydrating ${JSON.stringify(types)} was accepted, so a device can ask for everything or for nothing and get a copy whose contents nobody declared`,
      ).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe("invalid");
    }
    expect(
      server.requests.map((request) => request.pathname),
      "the device went to the server before deciding it had nothing to ask for, so a refusal costs a round trip and a log line on every one",
    ).toEqual([]);

    // The control. The same device with a real type list has to hydrate, or
    // the refusals above are a device that cannot hydrate at all.
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  });

  it("refuses a type the key cannot read, naming it, before anything is cleared", async () => {
    harness = await startHarness("unreadable-type");
    const { server, device } = harness;
    const narrow = answers.currentKey(
      "fixture-key",
      { "*": "write" },
      { "*": "write", "core.bookmark": "none" },
    );
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "n1" } }] },
      key: [
        answers.currentKey("fixture-key", { "*": "write" }),
        narrow,
        narrow,
        refusal(
          403,
          "forbidden",
          "This credential is a signed-in app's token, not a key; its reach is its grant.",
        ),
      ],
    });
    const first = await device.hydrate(["core.note"], "library");
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const listed = () =>
      server.requests.filter((request) => request.pathname === "/items").length;
    expect(
      listed(),
      "the first hydration read no page, so the count below says nothing about a refused one",
    ).toBeGreaterThan(0);
    const before = listed();
    expect(
      (
        await device.update("n1", {
          properties: { notes: "waiting" },
          version: 1,
        })
      ).ok,
    ).toBe(true);
    const queued = await device.queue();

    const refused = await device.hydrate(
      ["core.note", "core.bookmark"],
      "library",
    );
    expect(
      refused.ok,
      "a slice naming a type the key cannot read hydrated, so the copy holds none of that type and reports the slice as complete",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("forbidden");
      expect(
        refused.refusal.raw,
        "the refusal did not name the type the key cannot read, so a caller cannot tell which to leave out",
      ).toContain("core.bookmark");
    }
    expect(
      listed(),
      "the refused hydration read pages before refusing, so it cleared the copy it had for a slice it was never going to hold",
    ).toBe(before);
    const kept = await device.list();
    expect(
      kept.ok ? kept.value.map((item) => item.id) : kept,
      "the refused hydration cleared the copy it had",
    ).toEqual(["n1"]);
    const status = await device.status();
    expect(status.ok ? status.value.slice_types : status).toEqual([
      "core.note",
    ]);
    expect(
      await device.queue(),
      "the refused hydration changed the queue",
    ).toEqual(queued);

    // A type the key reads hydrates under the same key, so the refusal
    // above is the unreadable type's and not the key's.
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    // A credential that is not a key cannot read its own map, so the device
    // asks the listing for the first page of each named type, and the
    // listing's refusal is taken before anything is cleared.
    server.copyAnswer("GET", "/items", (request) =>
      request.query.get("type") === "core.bookmark"
        ? refusal(
            403,
            "type_not_permitted",
            'No access to type "core.bookmark"',
          )
        : itemsPage([{ item: wireItem({ id: "n1" }) }]),
    );
    const signedIn = await device.hydrate(
      ["core.note", "core.bookmark"],
      "library",
    );
    expect(
      signedIn.ok,
      "a signed-in app's slice naming a type its grant does not reach hydrated, so the copy holds none of that type and reports the slice as complete",
    ).toBe(false);
    if (!signedIn.ok) {
      expect(signedIn.refusal.code).toBe("forbidden");
      expect(
        signedIn.refusal.raw,
        "the refusal did not name the type the grant does not reach",
      ).toContain("core.bookmark");
    }
    const keptAfter = await device.list();
    expect(
      keptAfter.ok ? keptAfter.value.map((item) => item.id) : keptAfter,
      "the refused hydration cleared the copy a signed-in app had",
    ).toEqual(["n1"]);
    const statusAfter = await device.status();
    expect(
      statusAfter.ok ? statusAfter.value.slice_types : statusAfter,
    ).toEqual(["core.note"]);
  });

  it("refuses a type name outside the grammar, or one the server does not hold, keeping the copy it had", async () => {
    harness = await startHarness("grammar");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "n1" } }] },
    });
    server.copyAnswer("GET", "/items", (request) => {
      const type = request.query.get("type");
      if (type === "bookmark") {
        return refusal(
          400,
          "validation_error",
          "Type identifier must have at least two segments",
        );
      }
      if (type === "acme.bookmark") {
        return refusal(400, "unknown_type", "Unknown type: acme.bookmark");
      }
      return itemsPage([{ item: wireItem({ id: "n1" }) }]);
    });
    const first = await device.hydrate(["core.note"], "library");
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const asked = () => server.requests.length;

    for (const [declared, refused] of [
      ["bookmark", "a name that is not a type identifier"],
      ["app.notes", "an app name without exactly three segments"],
      ["keys.thing", "a name under a reserved root"],
      ["acme.bookmark", "a well-formed type the server does not hold"],
    ] as const) {
      const before = asked();
      const listed = server.requests.filter(
        (request) => request.pathname === "/items",
      ).length;
      const hydrated = await device.hydrate(["core.note", declared], "library");
      expect(
        hydrated.ok,
        `${refused} hydrated, so the device holds a slice of a type that does not exist and reports it as complete`,
      ).toBe(false);
      if (declared !== "acme.bookmark") {
        expect(
          asked(),
          "the device went to the server for a name it could refuse on its own",
        ).toBe(before);
      }
      expect(
        server.requests.filter((request) => request.pathname === "/items")
          .length,
        `the device read pages for ${refused}, so it cleared the copy it had before the server refused it`,
      ).toBe(listed);
      const kept = await device.list();
      expect(
        kept.ok ? kept.value.map((item) => item.id) : kept,
        `the hydration naming ${refused} cleared the copy it had`,
      ).toEqual(["n1"]);
      const status = await device.status();
      expect(
        status.ok ? [status.value.hydration, status.value.slice_types] : status,
      ).toEqual(["complete", ["core.note"]]);
      if (!hydrated.ok) {
        expect(
          hydrated.refusal.raw,
          "the refusal did not name the type, so a caller cannot tell which to correct",
        ).toContain(declared);
        expect(hydrated.refusal.code).toBe(
          declared === "acme.bookmark" ? "unknown_type" : "invalid",
        );
      }
    }

    // An edge type to hold whole that the server does not hold is refused
    // the same way, before the copy is cleared.
    const listedEdges = () =>
      server.requests.filter((request) => request.pathname === "/edges").length;
    const edgesBefore = listedEdges();
    const unheldEdge = await device.hydrate(["core.note"], "library", {
      edgeTypes: ["acme.link"],
    });
    expect(
      unheldEdge.ok,
      "a slice holding whole an edge type the server does not hold hydrated",
    ).toBe(false);
    expect(listedEdges()).toBe(edgesBefore);
    const keptEdges = await device.list();
    expect(
      keptEdges.ok ? keptEdges.value.map((item) => item.id) : keptEdges,
      "the hydration naming an edge type the server does not hold cleared the copy it had",
    ).toEqual(["n1"]);
    if (!unheldEdge.ok) {
      expect(unheldEdge.refusal.raw).toContain("acme.link");
      expect(unheldEdge.refusal.code).toBe("unknown_type");
    }

    // The control, on the same server: a well-formed name it holds
    // hydrates, so the refusals above are about the names rather than the
    // door.
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  });
});

describe("the order a hydration reads in", () => {
  it("takes the cursor before the snapshot, so a write during the snapshot replays", async () => {
    harness = await startHarness("ordering");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "already-there" } }] },
    });
    // The whole sequence is scripted before the device runs: answers for a
    // door are consumed in order, so a second subscription is the replay the
    // catch-up below makes, carrying a write that landed at id 11 while the
    // snapshot at cursor 10 was being read.
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.created",
          wireItem({ id: "written-during-the-snapshot" }),
        ),
      ]),
    );

    const hydrated = await device.hydrate(["core.note"], "library");
    expect(hydrated.ok).toBe(true);

    const doors = server.requests.map((request) => request.pathname);
    const cursorRead = doors.indexOf("/events");
    const firstRow = doors.indexOf("/items");
    expect(
      cursorRead,
      "the device never asked where the log had reached, so it has no resume point and the ordering below is about nothing",
    ).toBeGreaterThanOrEqual(0);
    expect(
      cursorRead,
      "the snapshot was taken before the cursor, so every write that lands while the snapshot is being read falls between the two and reaches the copy through neither",
    ).toBeLessThan(firstRow);

    // And the consequence, rather than only the ordering: a write that landed
    // while the snapshot was being read reaches the copy on the first replay.
    expect((await device.catchUp()).ok).toBe(true);
    const held = await device.list();
    expect(held.ok).toBe(true);
    expect(
      held.ok ? held.value.map((item) => item.id) : [],
      "a row written while the snapshot was being read never reached the copy, which is the loss the ordering exists to prevent",
    ).toContain("written-during-the-snapshot");
  });
});

describe("what a hydration leaves behind", () => {
  it("replaces what the store held", async () => {
    harness = await startHarness("replace");
    const { server, device } = harness;
    server.copyAnswer("GET", "/events", copyHeadRead("10"));
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    server.copyAnswer("GET", "/items", (request) =>
      request.query.get("type") === "core.note"
        ? itemsPage([{ item: wireItem({ id: "from-the-first-slice" }) }])
        : itemsPage([
            {
              item: wireItem({
                id: "from-the-second-slice",
                type: "core.bookmark",
              }),
            },
          ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.hydrate(["core.bookmark"], "library")).ok).toBe(true);

    const held = await device.list();
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    expect(
      ids,
      "the new slice did not land, so the assertion below passes against a hydration that pulled nothing",
    ).toContain("from-the-second-slice");
    expect(
      ids,
      "the previous slice survived the hydration, so a device that narrows what it declares keeps carrying rows it no longer asks the server about and never learns they changed",
    ).not.toContain("from-the-first-slice");

    const status = await device.status();
    expect(status.ok).toBe(true);
    expect(
      status.ok ? status.value.slice_types : [],
      "the device reports a slice it no longer holds, so a catch-up would ask for types the copy has no rows of",
    ).toEqual(["core.bookmark"]);
  });

  it("leaves an interrupted hydration to be run again, never resumed", async () => {
    harness = await startHarness("interrupted-hydration");
    const { server, device } = harness;
    server.copyAnswer("GET", "/events", copyHeadRead("10"));
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    // The first attempt lands a page and then dies partway through the walk,
    // so there is something a resuming device could resume from. With nothing
    // landed, the second attempt reports the whole slice either way and the
    // assertion below would be about nothing.
    const firstPage = itemsPage([{ item: wireItem({ id: "a" }) }], {
      nextCursor: "p2",
    });
    server.copyAnswer(
      "GET",
      "/items",
      firstPage,
      { kind: "drop" },
      firstPage,
      itemsPage([{ item: wireItem({ id: "b" }) }]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(false);
    expect(
      (await device.list()).ok,
      "a half-hydrated store answered a read, so a caller sees part of a slice as though it were the whole one",
    ).toBe(false);

    const again = await device.hydrate(["core.note"], "library");
    expect(
      again.ok,
      `the second hydration was refused: ${JSON.stringify(again)}`,
    ).toBe(true);
    expect(
      again.ok ? [again.value.items, again.value.pages] : undefined,
      "the second hydration walked less than the whole slice, so it resumed the interrupted one rather than replacing it and the copy is short whatever the first attempt missed",
    ).toEqual([2, 2]);
    expect((await device.list()).ok).toBe(true);
  });

  it("walks past an empty page that still carries a cursor", async () => {
    // A page the server thinned to nothing for this credential can arrive
    // empty with more to follow; a walk that stopped there would leave the
    // copy short and call it complete.
    harness = await startHarness("empty-page");
    const { server, device } = harness;
    server.copyAnswer("GET", "/events", copyHeadRead("7"));
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    server.copyAnswer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "before" }) }], { nextCursor: "p2" }),
      itemsPage([], { nextCursor: "p3" }),
      itemsPage([{ item: wireItem({ id: "after" }) }]),
    );

    const hydrated = await device.hydrate(["core.note"], "library");
    expect(
      hydrated.ok ? [hydrated.value.items, hydrated.value.pages] : hydrated,
      "the hydration stopped on the empty page rather than on the null cursor",
    ).toEqual([2, 3]);
  });

  it("walks every page of an edge type held whole", async () => {
    harness = await startHarness("edge-pages");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "7",
      rows: { "core.note": [{ item: { id: "ticket" } }] },
    });
    server.copyAnswer(
      "GET",
      "/edges",
      edgesPage(
        [
          wireEdge({
            id: "first",
            source_id: "outer",
            target_id: "inner",
            edge_type: "parent-of",
          }),
        ],
        { nextCursor: "e2" },
      ),
      edgesPage([
        wireEdge({
          id: "second",
          source_id: "inner",
          target_id: "ticket",
          edge_type: "parent-of",
        }),
      ]),
    );

    const hydrated = await device.hydrate(["core.note"], "library", {
      edgeTypes: ["parent-of"],
    });
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    expect(
      server.requests
        .filter((request) => request.pathname === "/edges")
        .map((request) => request.query.get("cursor")),
      "the hydration did not follow the edge listing's cursor",
    ).toEqual([null, "e2"]);
    expect(
      [await edgeIds(device, "outer"), await edgeIds(device, "inner")],
      "an edge on a page after the first was left out",
    ).toEqual([["first"], ["second"]]);
    expect(
      hydrated.ok && [hydrated.value.edges, hydrated.value.pages],
      "the report did not count the edge pages the hydration walked",
    ).toEqual([2, 3]);
  });

  it("walks past an empty edge page that still carries a cursor", async () => {
    harness = await startHarness("edge-empty-page");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "7",
      rows: { "core.note": [{ item: { id: "ticket" } }] },
    });
    server.copyAnswer(
      "GET",
      "/edges",
      edgesPage(
        [
          wireEdge({
            id: "before",
            source_id: "outer",
            target_id: "inner",
            edge_type: "parent-of",
          }),
        ],
        { nextCursor: "e2" },
      ),
      edgesPage([], { nextCursor: "e3" }),
      edgesPage([
        wireEdge({
          id: "after",
          source_id: "inner",
          target_id: "ticket",
          edge_type: "parent-of",
        }),
      ]),
    );

    const hydrated = await device.hydrate(["core.note"], "library", {
      edgeTypes: ["parent-of"],
    });
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    // The witness: the edge before the empty page is held.
    expect(await edgeIds(device, "outer")).toEqual(["before"]);
    expect(
      await edgeIds(device, "inner"),
      "the hydration stopped on the empty edge page rather than on the null cursor",
    ).toEqual(["after"]);
  });

  it("reports the counts, the pages and the cursor it stored", async () => {
    harness = await startHarness("report");
    const { server, device } = harness;
    server.copyAnswer("GET", "/events", copyHeadRead("42"));
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    server.copyAnswer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "page-one" }) }], {
        nextCursor: "p2",
      }),
      itemsPage([{ item: wireItem({ id: "page-two" }) }]),
    );

    const hydrated = await device.hydrate(["core.note"], "library");
    expect(
      hydrated.ok,
      `the hydration was refused: ${JSON.stringify(hydrated)}`,
    ).toBe(true);
    if (!hydrated.ok) return;
    expect(
      hydrated.value.items,
      "the report did not count every row it pulled",
    ).toBe(2);
    expect(
      [hydrated.value.types, hydrated.value.tier],
      "the report did not name the slice it pulled, so a caller holding two devices cannot tell which one answered",
    ).toEqual([["core.note"], "library"]);
    expect(
      hydrated.value.pages,
      "the report counted one page for a walk that took two, so a caller cannot tell a complete walk from a truncated one",
    ).toBe(2);
    expect(
      hydrated.value.cursor,
      "the report named a cursor other than the one it took before the snapshot",
    ).toBe("42");

    const status = await device.status();
    expect(
      status.ok ? status.value.event_cursor : null,
      "the cursor the hydration reported is not the cursor the store kept, so a catch-up resumes from somewhere the caller was never told about",
    ).toBe("42");
  });
});

describe("what a hydration asks for", () => {
  it("asks the item listing for each declared type at the slice's tier, every state", async () => {
    harness = await startHarness("listing-asked");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [{ item: { id: "note", tier: "feed" } }],
        "core.file": [
          {
            item: {
              id: "trashed-image",
              type: "core.file.image",
              tier: "feed",
              state: "trashed",
              properties: { title: "image" },
            },
          },
        ],
      },
    });
    const hydrated = await device.hydrate(["core.note", "core.file"], "feed");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    expect(
      server.requests
        .filter((request) => request.pathname === "/items")
        .map((request) => [
          request.query.get("type"),
          request.query.get("tier"),
          request.query.get("state"),
          request.query.get("include"),
        ]),
    ).toEqual([
      ["core.note", "feed", "any", "edges,metadata"],
      ["core.file", "feed", "any", "edges,metadata"],
    ]);
    const held = await device.list({ allStates: true });
    expect(held.ok ? held.value.map((row) => row.id).sort() : held).toEqual([
      "note",
      "trashed-image",
    ]);
  });

  it("refuses a wildcard whose root breaks the grammar before reading anything, and takes one that names nothing", async () => {
    harness = await startHarness("wildcards");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    for (const wildcard of ["Bad.*", ".*", "core..*"]) {
      const refused = await device.hydrate([wildcard], "library");
      expect(refused.ok, `${wildcard} was taken`).toBe(false);
      if (!refused.ok) {
        expect(refused.refusal.code).toBe("invalid");
        expect(refused.refusal.raw).toContain(wildcard);
      }
    }
    expect(server.requests, "a refused wildcard was sent").toEqual([]);
    const nothing = await device.hydrate(["acme.*"], "library");
    expect(
      nothing.ok,
      `a wildcard naming no type the catalog holds was refused: ${JSON.stringify(nothing)}`,
    ).toBe(true);
    const status = await device.status();
    expect(
      status.ok && [status.value.hydration, status.value.slice_types],
    ).toEqual(["complete", ["acme.*"]]);
  });

  it("hydrates a type whose descendant alone the key reads, by name or by declared parent", async () => {
    harness = await startHarness("descendant-readable");
    const { server, device } = harness;
    const reads = (grant: Record<string, "read" | "none">) =>
      answers.currentKey("fixture-key", {}, { "*": "none", ...grant });
    scriptHydration(server, {
      head: "10",
      catalog: typeCatalog([wireType("acme.photo", { parent: "core.file" })]),
      key: [
        reads({ "core.note": "read" }),
        reads({ "core.file.image": "read" }),
        reads({ "acme.photo": "read" }),
      ],
    });
    // The witness: a key that reads nothing under the type is refused it.
    const refused = await device.hydrate(["core.file"], "library");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("forbidden");
    for (const how of ["by name", "by declared parent"]) {
      const hydrated = await device.hydrate(["core.file"], "library");
      expect(
        hydrated.ok,
        `a type whose descendant the key reads ${how} was refused: ${JSON.stringify(hydrated)}`,
      ).toBe(true);
    }
  });
});

describe("how a hydration completes", () => {
  it("applies a write made during the snapshot before the hydration returns", async () => {
    harness = await startHarness("own-replay");
    const { server, device } = harness;
    server.copyAnswer(
      "GET",
      "/events",
      copyHeadRead("10"),
      copyReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "during" })),
      ]),
    );
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    server.copyAnswer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "before" }) }]),
    );
    const hydrated = await device.hydrate(["core.note"], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    expect(
      hydrated.ok && hydrated.value.cursor,
      "the hydration reported the head it read rather than the cursor its replay reached",
    ).toBe("11");
    const held = await device.list();
    expect(
      held.ok ? held.value.map((row) => row.id).sort() : held,
      "a write made while the pages were read was missing when the hydration returned",
    ).toEqual(["before", "during"]);
  });

  it("does not complete a hydration whose replay sends no live marker", async () => {
    harness = await startHarness("no-marker");
    const { server, device } = harness;
    server.copyAnswer(
      "GET",
      "/events",
      copyHeadRead("10"),
      copyIncompleteReplay("10", []),
    );
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    server.copyAnswer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "n1" }) }]),
    );
    const hydrated = await device.hydrate(["core.note"], "library");
    expect(
      hydrated.ok,
      "a replay with no live marker completed a hydration",
    ).toBe(false);
    if (!hydrated.ok) expect(hydrated.refusal.code).toBe("stream_incomplete");
    const status = await device.status();
    expect(status.ok && status.value.hydration).not.toBe("complete");
    expect((await device.list()).ok).toBe(false);
  });

  it("expires the copy when a listing hands back a cursor it already read", async () => {
    harness = await startHarness("repeated-cursor");
    const { server, device } = harness;
    server.copyAnswer("GET", "/events", copyHeadRead("10"));
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    server.copyAnswer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "a" }) }], { nextCursor: "p2" }),
      itemsPage([{ item: wireItem({ id: "b" }) }], { nextCursor: "p2" }),
    );
    const hydrated = await device.hydrate(["core.note"], "library");
    expect(hydrated.ok, "a listing that loops was walked to an end").toBe(
      false,
    );
    if (!hydrated.ok) {
      expect(hydrated.refusal.code).toBe("copy_expired");
      expect(hydrated.refusal.raw).toContain("read_view_invalid");
    }
    expect(
      server.requests.filter((request) => request.pathname === "/items").length,
    ).toBe(2);
  });
});
