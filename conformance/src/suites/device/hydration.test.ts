import { describe, it, expect, afterEach, vi } from "vitest";
import {
  startHarness,
  readsOf,
  scriptHydration,
  scriptKey,
  scriptStats,
  type Harness,
} from "./harness.js";
import {
  answers,
  catchupTooOld,
  connected,
  copyFrame,
  copyStreamCursor,
  cursorAhead,
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
  withMetadata,
  SCRIPTED_INSTANCE,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { DeviceUnderTest } from "../../device/protocol.js";
import {
  BUILT_FOR,
  type Answer,
  type Responder,
  type SseFrame,
} from "../../device/scripted-server.js";

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

function atCursor(cursor: string | undefined, answer: Answer): Responder {
  return (request) =>
    request.headers["last-event-id"] === cursor
      ? answer
      : refusal(400, "validation_error", "unexpected replay cursor");
}

describe("what a hydration declares", () => {
  it("refuses an empty type list before reading anything", async () => {
    harness = await startHarness("declare");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });

    for (const types of [[]]) {
      const refused = await device.hydrate(types, "library");
      expect(
        refused.ok,
        `hydrating ${JSON.stringify(types)} was accepted, so a device can ask for nothing and get a copy whose contents nobody declared`,
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
    server.copyAnswer(
      "GET",
      "/events",
      atCursor(undefined, copyHeadRead("10")),
      atCursor(
        "10",
        copyReplay("11", [
          copyItemEvent(
            "11",
            "item.created",
            wireItem({ id: "written-during-the-snapshot" }),
          ),
        ]),
      ),
      atCursor("11", copyReplay("11", [])),
    );
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    scriptStats(server);
    server.copyAnswer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "already-there" }) }]),
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
    // while the snapshot was being read reaches the copy, and the next replay
    // starts where hydration finished.
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
    scriptStats(server);
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
    scriptStats(server);
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
    scriptStats(server);
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
      atCursor(undefined, copyHeadRead("10")),
      atCursor(
        "10",
        copyReplay("11", [
          copyItemEvent("11", "item.created", wireItem({ id: "during" })),
        ]),
      ),
      atCursor(
        "11",
        copyReplay("12", [
          copyItemEvent("12", "item.created", wireItem({ id: "after" })),
        ]),
      ),
    );
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    scriptStats(server);
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
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    const after = await device.list();
    expect(after.ok ? after.value.map((row) => row.id).sort() : after).toEqual([
      "after",
      "before",
      "during",
    ]);
    const status = await device.status();
    expect(status.ok && status.value.event_cursor).toBe("12");
    expect(
      server.requests
        .filter((request) => request.pathname === "/events")
        .map((request) => request.headers["last-event-id"]),
    ).toEqual([undefined, "10", "11"]);
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
    scriptStats(server);
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
    const listed = await device.listAnswer();
    expect(
      listed.ok && listed.value.completeness,
      "a copy whose replay never went live said it was whole",
    ).toBe("partial");
  });

  it("ends a hydration decoding, and does not expire the copy, where the reader cannot decode an answer", async () => {
    harness = await startHarness("undecodable-page");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "held" } }] },
    });
    // The first hydration takes the scripted listing; the next two take a
    // page cut short and then a whole one.
    server.copyAnswer(
      "GET",
      "/items",
      { kind: "json", status: 200, body: null, raw: '{"data":[' },
      itemsPage([{ item: wireItem({ id: "n2" }) }]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const refused = await device.hydrate(["core.note"], "library");
    expect(
      refused.ok,
      "a page the reader could not decode was taken as a page",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code, JSON.stringify(refused)).toBe("decoding");
      expect(refused.refusal.raw).toContain("/items");
    }
    const status = await device.status();
    // Under way, as after any hydration that ends other than expired: the
    // caller asks again, and the copy is not owed a hydration it cannot have.
    expect(status.ok && status.value.hydration).toBe("in_progress");

    // The witness: the same door answered whole is taken.
    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect((await device.get("n2")).ok).toBe(true);
  });

  it("expires the copy when a listing hands back a cursor it already read", async () => {
    harness = await startHarness("repeated-cursor");
    const { server, device } = harness;
    server.copyAnswer("GET", "/events", copyHeadRead("10"));
    server.copyAnswer("GET", "/types", typeCatalog());
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(server);
    scriptStats(server);
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
      expect(hydrated.refusal.raw).toContain("reach_invalid");
    }
    expect(
      server.requests.filter((request) => request.pathname === "/items").length,
    ).toBe(2);
  });
});

/**
 * "An interrupted hydration resumes from the page it reached."
 *
 * A large slice is read a page at a time, and a phone that sleeps, loses its
 * network or is killed partway through would otherwise read every page again
 * from the first. The pages it took are kept with where the walk had reached
 * and the head it started from, so the next hydration of the same slice
 * reads only the rest and replays what changed meanwhile. Where that would
 * give a copy other than a whole hydration's, it starts again and says why.
 */
describe("an interrupted hydration", () => {
  const NOTES = ["a", "b", "c"];

  function rows(): Record<string, Array<{ item: WireItemOptions }>> {
    return { "core.note": NOTES.map((id) => ({ item: { id } })) };
  }

  /** The cursors each listing request carried, the first page's as null. */
  function listed(server: Harness["server"]): Array<string | null> {
    return server.requests
      .filter((request) => request.pathname === "/items")
      .map((request) => request.query.get("cursor"));
  }

  async function copyOf(device: Harness["device"]): Promise<unknown> {
    const read = await device.listAnswer();
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (!read.ok) return read;
    return {
      completeness: read.value.completeness,
      items: read.value.items
        .map(({ id, version, properties, state, tags }) => ({
          id,
          version,
          properties,
          state,
          tags,
        }))
        .sort((one, other) => one.id.localeCompare(other.id)),
    };
  }

  /**
   * A device whose hydration of three notes, a page each, took the first two
   * and died asking for the third. `options` script the server beyond that,
   * read as the fixture changes them.
   */
  async function interrupted(
    label: string,
    options: Partial<Parameters<typeof scriptHydration>[1]> & {
      third?: () => boolean | Answer;
    } = {},
  ): Promise<Harness> {
    harness = await startHarness(label);
    const { server, device } = harness;
    let cut = true;
    scriptHydration(server, {
      head: "10",
      rows: rows(),
      pageSize: 1,
      ...options,
      drop: (offset) => {
        if (offset !== 2) return false;
        if (cut) {
          cut = false;
          return true;
        }
        return options.third?.() ?? false;
      },
    });
    const first = await device.hydrate(["core.note"], "library");
    expect(first.ok, "the interrupted hydration completed").toBe(false);
    expect(listed(server)).toEqual([null, "1", "2"]);
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("in_progress");
    expect(
      status.ok && [status.value.items_listed, status.value.items_expected],
      "an interrupted hydration lost the count of rows its listings had brought, so a resumed one reports a fill that starts again from nothing",
    ).toEqual([2, 3]);
    return harness;
  }

  it("reads only the pages it had not reached, and holds the copy a whole hydration does", async () => {
    const { server, device } = await interrupted("resume-pages");
    const partial = await device.listAnswer();
    expect(
      partial.ok && partial.value.completeness,
      "a copy partway through a hydration answered as though whole",
    ).toBe("partial");
    expect(
      partial.ok ? partial.value.items.map((item) => item.id).sort() : partial,
      "a copy partway through a hydration did not answer from the pages it took",
    ).toEqual(["a", "b"]);

    const resumed = await device.hydrate(["core.note"], "library");
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.resumed).toBe(true);
    expect(resumed.value.restarted).toBeUndefined();
    expect([resumed.value.pages, resumed.value.pages_total]).toEqual([1, 3]);
    expect(
      listed(server),
      "the resumed hydration read again a page it already held, so an interruption costs the pages it had taken",
    ).toEqual([null, "1", "2", "2"]);
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("complete");
    const resumedCopy = await copyOf(device);

    // The witness: the same slice hydrated whole, by a device nothing
    // interrupted, holds the same copy.
    const whole = await startHarness("resume-pages-whole");
    try {
      scriptHydration(whole.server, { head: "10", rows: rows(), pageSize: 1 });
      expect((await whole.device.hydrate(["core.note"], "library")).ok).toBe(
        true,
      );
      expect(
        resumedCopy,
        "the resumed copy differs from one hydrated in a single run",
      ).toEqual(await copyOf(whole.device));
    } finally {
      await whole.stop();
    }
  });

  it("replays a row changed and a row deleted on the server while it was stopped", async () => {
    const changed = wireItem({
      id: "a",
      version: 2,
      properties: { title: "changed while stopped", body: "changed" },
    });
    const gone = wireItem({ id: "b", version: 2, state: "trashed" });
    let log: SseFrame[] = [];
    const { server, device } = await interrupted("resume-changed", {
      replay: (cursor) =>
        cursor === "10" && log.length > 0
          ? copyReplay("12", log)
          : copyReplay(cursor, []),
    });
    // Rows the walk already took change after it took them; the third page
    // is read after the changes, as a server answers it.
    log = [
      copyItemEvent("11", "item.updated", changed),
      copyItemEvent("12", "item.deleted", gone),
    ];

    const resumed = await device.hydrate(["core.note"], "library");
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.resumed).toBe(true);
    expect(resumed.value.cursor).toBe("12");
    const held = await device.list();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    const byId = new Map(
      held.ok ? held.value.map((item) => [item.id, item]) : [],
    );
    expect(
      byId.get("a")?.properties.title,
      "a row changed while the hydration was stopped kept the version its page brought",
    ).toBe("changed while stopped");
    expect(
      byId.has("b"),
      "a row deleted while the hydration was stopped is still listed",
    ).toBe(false);
    expect([...byId.keys()].sort()).toEqual(["a", "c"]);
    expect(listed(server)).toEqual([null, "1", "2", "2"]);
  });

  it("keeps the queue and the pinned rows across a resume", async () => {
    harness = await startHarness("resume-queue");
    const { server, device } = harness;
    // Read by id before the listings: the pinned row, and the row a queued
    // create made, which the server does not hold yet.
    server.copyAnswer("GET", "/items/pinned", {
      kind: "json",
      status: 200,
      body: withMetadata(wireItem({ id: "pinned", type: "core.bookmark" })),
    });
    server.copyAnswer("GET", /^\/items\/[^/]+\/edges$/, edgesPage([]));
    server.copyAnswer(
      "GET",
      /^\/items\/[^/]+$/,
      refusal(404, "item_not_found", "none"),
    );
    let cut = false;
    scriptHydration(server, {
      head: "10",
      rows: rows(),
      pageSize: 1,
      drop: (offset) => {
        const dropped = offset === 2 && cut;
        if (dropped) cut = false;
        return dropped;
      },
    });
    // A pin is taken on a whole copy, so the hydration interrupted is the
    // copy's second.
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "saved first", body: "saved first" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const pinned = await device.pin("pinned");
    expect(pinned.ok, JSON.stringify(pinned)).toBe(true);
    const queued = await device.queue();

    cut = true;
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(false);
    const resumed = await device.hydrate(["core.note"], "library");
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    expect(resumed.ok && resumed.value.resumed).toBe(true);
    expect(listed(server)).toEqual([null, "1", "2", null, "1", "2", "2"]);

    expect(await device.queue(), "the resume touched the queue").toEqual(
      queued,
    );
    const held = await device.list();
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    expect(
      created.ok && ids.includes(created.value.item_id ?? ""),
      "a create still waiting is missing from the resumed copy",
    ).toBe(true);
    const status = await device.status();
    expect(status.ok && status.value.pinned).toEqual(["pinned"]);
    expect(
      (await device.get("pinned")).ok,
      "the pinned row is missing from the resumed copy",
    ).toBe(true);
  });

  it("resumes after the process running it was killed", async () => {
    harness = await startHarness("resume-killed");
    const { server, device } = harness;
    // The third page never answers the first process.
    server.copyAnswer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "a" }) }], { nextCursor: "1" }),
      itemsPage([{ item: wireItem({ id: "b" }) }], { nextCursor: "2" }),
      {
        kind: "gated",
        until: new Promise<void>(() => {}),
        then: itemsPage([]),
      },
    );
    scriptHydration(server, { head: "10", rows: rows(), pageSize: 1 });
    expect((await device.status()).ok).toBe(true);

    const hydrating = device.hold([
      "hydrate",
      "--types",
      "core.note",
      "--tier",
      "library",
    ]);
    try {
      await vi.waitFor(
        () => {
          expect(listed(server), hydrating.stderr).toEqual([null, "1", "2"]);
        },
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      await hydrating.stop();
    }
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("in_progress");

    const resumed = await device.hydrate(["core.note"], "library");
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.resumed).toBe(true);
    expect([resumed.value.pages, resumed.value.pages_total]).toEqual([1, 3]);
    expect(listed(server)).toEqual([null, "1", "2", "2"]);
    expect(
      (
        (await device.list()) as { ok: true; value: Array<{ id: string }> }
      ).value
        .map((item) => item.id)
        .sort(),
    ).toEqual(NOTES);
  });

  it("resumes a replay the process running it was killed in from the last event it applied", async () => {
    const changed = wireItem({
      id: "a",
      version: 2,
      properties: { title: "changed during the replay", body: "changed" },
    });
    // A row of a type the catalog does not name sends the replay to read
    // the catalog again, which tells the fixture the event before it landed.
    const unnamed = wireItem({ id: "late", type: "user.late" });
    const log = [
      copyItemEvent("11", "item.updated", changed),
      copyItemEvent("12", "item.created", unnamed),
    ];

    /** A device with a whole copy and a pin, and a fixture to replay `log`. */
    async function pinned(label: string, gate: () => boolean) {
      const started = await startHarness(label);
      const { server, device } = started;
      // The pinned row is gone from the server once pinned, so a hydration
      // holds no row for it and reads it again each time it walks its pins
      // (`device/pin-gone-kept`).
      const replay = { log: false, held: false };
      server.copyAnswer("GET", "/items/pinned", () =>
        replay.log
          ? refusal(404, "item_not_found", "none")
          : {
              kind: "json",
              status: 200,
              body: withMetadata(
                wireItem({ id: "pinned", type: "core.bookmark" }),
              ),
            },
      );
      server.copyAnswer("GET", /^\/items\/[^/]+\/edges$/, edgesPage([]));
      scriptHydration(server, {
        head: "10",
        rows: rows(),
        pageSize: 1,
        catalog: () =>
          replay.held && gate()
            ? {
                kind: "gated",
                until: new Promise<void>(() => {}),
                then: typeCatalog(),
              }
            : typeCatalog(),
        replay: (cursor) => {
          if (!replay.log) return copyReplay(cursor, []);
          if (cursor === "11") return copyReplay("12", log.slice(1));
          if (!gate()) return copyReplay("12", log);
          replay.held = true;
          return {
            kind: "sse",
            hold: true,
            frames: [connected, copyStreamCursor("12"), ...log.map(copyFrame)],
          };
        },
      });
      expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
      const pin = await device.pin("pinned");
      expect(pin.ok, JSON.stringify(pin)).toBe(true);
      replay.log = true;
      return started;
    }

    let gated = true;
    harness = await pinned("resume-killed-replay", () => gated);
    const { server, device } = harness;
    const pinReads = (): number => readsOf(server, "pinned");
    const pinsBefore = pinReads();
    const requestsBefore = server.requests.length;
    const hydrating = device.hold([
      "hydrate",
      "--types",
      "core.note",
      "--tier",
      "library",
    ]);
    try {
      await vi.waitFor(
        () => {
          const requests = server.requests.slice(requestsBefore);
          const replayed = requests.findIndex(
            (request) =>
              request.pathname === "/events" &&
              request.headers["last-event-id"] === "10",
          );
          expect(replayed, hydrating.stderr).toBeGreaterThan(-1);
          expect(
            requests
              .slice(replayed)
              .some((request) => request.pathname === "/types"),
            hydrating.stderr,
          ).toBe(true);
        },
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      await hydrating.stop();
    }
    gated = false;
    const killed = await device.status();
    expect(killed.ok && killed.value.hydration).toBe("in_progress");
    expect(
      killed.ok && killed.value.event_cursor,
      "the killed replay kept no event it applied",
    ).toBe("11");
    // The witness: the walk the process was killed in read the pin.
    const pinsKilled = pinReads();
    expect(pinsKilled).toBeGreaterThan(pinsBefore);
    const sent = server.requests.length;

    const resumed = await device.hydrate(["core.note"], "library");
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.resumed).toBe(true);
    expect([resumed.value.pages, resumed.value.pages_total]).toEqual([0, 3]);
    expect(resumed.value.cursor).toBe("12");
    const after = server.requests.slice(sent);
    expect(
      after.filter((request) => request.pathname === "/items"),
      "a resume in the replay read a listing page again",
    ).toEqual([]);
    expect(
      pinReads(),
      "a resume in the replay read the pinned rows again",
    ).toBe(pinsKilled);
    expect(
      after
        .filter((request) => request.pathname === "/events")
        .map((request) => request.headers["last-event-id"]),
      "the replay did not carry on from the last event the killed one applied",
    ).toContain("11");
    expect(
      after.some(
        (request) =>
          request.pathname === "/events" &&
          request.headers["last-event-id"] === "10",
      ),
      "the replay started again from the head the hydration started from",
    ).toBe(false);
    const resumedCopy = await copyOf(device);

    // The witness: the same steps, with nothing killed, hold the same copy.
    const whole = await pinned("resume-killed-replay-whole", () => false);
    try {
      expect((await whole.device.hydrate(["core.note"], "library")).ok).toBe(
        true,
      );
      expect(
        resumedCopy,
        "the copy resumed in its replay differs from one hydrated in a single run",
      ).toEqual(await copyOf(whole.device));
    } finally {
      await whole.stop();
    }
  });

  it("resumes with no page to read when it was stopped as its last page arrived", async () => {
    harness = await startHarness("resume-last-page");
    const { server, device } = harness;
    let release = (): void => {};
    const until = new Promise<void>((resolve) => (release = resolve));
    server.copyAnswer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "a" }) }], { nextCursor: "1" }),
      itemsPage([{ item: wireItem({ id: "b" }) }], { nextCursor: "2" }),
      {
        kind: "gated",
        until,
        then: itemsPage([{ item: wireItem({ id: "c" }) }]),
      },
    );
    scriptHydration(server, { head: "10", rows: rows(), pageSize: 1 });
    expect((await device.status()).ok).toBe(true);

    const hydrating = device.hold([
      "hydrate",
      "--types",
      "core.note",
      "--tier",
      "library",
    ]);
    try {
      await vi.waitFor(
        () => {
          expect(listed(server), hydrating.stderr).toEqual([null, "1", "2"]);
        },
        { timeout: 10_000, interval: 25 },
      );
      hydrating.interrupt();
      await hydrating.stopRaised();
      release();
      await hydrating.exited();
    } finally {
      release();
      await hydrating.stop();
    }
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("in_progress");

    const resumed = await device.hydrate(["core.note"], "library");
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.resumed).toBe(true);
    // Whether the last page landed before the stop was seen decides whether
    // the resume reads it; either way it reads nothing before it.
    expect(listed(server).slice(3)).toEqual(
      resumed.value.pages === 0 ? [] : ["2"],
    );
    expect(resumed.value.pages_total).toBe(3);
    const whole = await device.listAnswer();
    expect(whole.ok && whole.value.completeness).toBe("complete");
    expect(
      whole.ok ? whole.value.items.map((item) => item.id).sort() : whole,
    ).toEqual(NOTES);
  });

  it("reads every page again once a hydration has completed", async () => {
    const { server, device } = await interrupted("resume-then-whole");
    const resumed = await device.hydrate(["core.note"], "library");
    expect(resumed.ok && resumed.value.resumed).toBe(true);

    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(
      [again.value.resumed, again.value.restarted],
      "a hydration after a complete one was taken for a resume",
    ).toEqual([false, undefined]);
    expect([again.value.pages, again.value.pages_total]).toEqual([3, 3]);
    expect(listed(server)).toEqual([null, "1", "2", "2", null, "1", "2"]);
  });

  it("starts again from the first page for another slice", async () => {
    const { server, device } = await interrupted("restart-slice");
    const again = await device.hydrate(["core.note"], "all");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect([again.value.resumed, again.value.restarted]).toEqual([
      false,
      "slice_changed",
    ]);
    expect(listed(server)).toEqual([null, "1", "2", null, "1", "2"]);
  });

  it("starts again from the first page when the catalog changed", async () => {
    let catalog = typeCatalog();
    const { server, device } = await interrupted("restart-catalog", {
      catalog: () => catalog,
    });
    catalog = typeCatalog([wireType("user.late", { parent: "core.note" })]);
    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect([again.value.resumed, again.value.restarted]).toEqual([
      false,
      "catalog_changed",
    ]);
    expect(listed(server)).toEqual([null, "1", "2", null, "1", "2"]);
  });

  it("starts again from the first page when another instance answers", async () => {
    const replaced = "00000000-0000-7000-8000-0000000000ff";
    let instance = SCRIPTED_INSTANCE;
    const { server, device } = await interrupted("restart-instance", {
      instance: () => instance,
    });
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    instance = replaced;
    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect([again.value.resumed, again.value.restarted]).toEqual([
      false,
      "instance_changed",
    ]);
    expect(listed(server)).toEqual([null, "1", "2", null, "1", "2"]);
    const status = await device.status();
    expect(status.ok && status.value.instance_id).toBe(replaced);
  });

  it("starts again from the first page when the key's reach changed", async () => {
    let refused = true;
    const { server, device } = await interrupted("restart-reach", {
      // The server refuses a stream resumed under a reach that is no longer
      // the key's (`reach/copy-reach-refused`).
      replay: (cursor) => {
        if (cursor !== "10" || !refused) return copyReplay(cursor, []);
        refused = false;
        return refusal(409, "reach_changed", "The reach has changed");
      },
    });
    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect([again.value.resumed, again.value.restarted]).toEqual([
      false,
      "reach_changed",
    ]);
    expect(listed(server)).toEqual([null, "1", "2", null, "1", "2"]);
    // The head and the catalog read before the refusal are of the reach
    // that went, so the walk from the first page waits for both again.
    const requests = server.requests;
    const refusedAt = requests.findIndex(
      (request) =>
        request.pathname === "/events" &&
        request.headers["last-event-id"] === "10",
    );
    const walkAt = requests.findIndex(
      (request, index) => index > refusedAt && request.pathname === "/items",
    );
    const between = requests.slice(refusedAt + 1, walkAt);
    expect(
      [
        between.some(
          (request) =>
            request.pathname === "/events" &&
            request.headers["last-event-id"] === undefined,
        ),
        between.some((request) => request.pathname === "/types"),
      ],
      "the walk from the first page used the head and the catalog of the reach the server had refused",
    ).toEqual([true, true]);
  });

  async function startsAgainOnGap(
    reason: "head_aged_out" | "head_past_log",
    gap: SseFrame,
    head: string,
  ): Promise<void> {
    let now = "10";
    const { server, device } = await interrupted(`restart-${reason}`, {
      head: () => now,
      replay: (cursor) =>
        cursor === "10"
          ? { kind: "sse", frames: [connected, copyStreamCursor(now), gap] }
          : copyReplay(now, []),
    });
    now = head;
    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect([again.value.resumed, again.value.restarted]).toEqual([
      false,
      reason,
    ]);
    expect(
      again.value.cursor,
      "the copy kept the head the interrupted hydration started from, which the log does not continue from",
    ).toBe(head);
    expect(listed(server)).toEqual([null, "1", "2", null, "1", "2"]);
  }

  it("starts again from the first page when the log no longer holds the head it started from", async () => {
    await startsAgainOnGap("head_aged_out", catchupTooOld("50", "10"), "60");
  });

  it("starts again from the first page when the log ends before the head it started from", async () => {
    await startsAgainOnGap("head_past_log", cursorAhead("10", "5"), "5");
  });

  it("starts again from the first page, once, when the server refuses the cursor it kept", async () => {
    let refusals = 1;
    const { server, device } = await interrupted("restart-cursor", {
      third: () =>
        refusals-- > 0
          ? refusal(400, "validation_error", "cursor not recognized")
          : false,
    });
    const again = await device.hydrate(["core.note"], "library");
    expect(
      again.ok,
      `a refused page cursor ended the hydration, so a server that stopped taking it leaves the copy partial until something clears it: ${JSON.stringify(again)}`,
    ).toBe(true);
    if (!again.ok) return;
    expect([again.value.resumed, again.value.restarted]).toEqual([
      false,
      "cursor_refused",
    ]);
    expect(listed(server)).toEqual([null, "1", "2", "2", null, "1", "2"]);
    expect(
      (
        (await device.list()) as { ok: true; value: Array<{ id: string }> }
      ).value
        .map((item) => item.id)
        .sort(),
    ).toEqual(NOTES);
  });

  it("ends a hydration whose first page from the start is refused too, rather than start again twice", async () => {
    // Every later read of the third page is refused, whatever its cursor.
    const { server, device } = await interrupted("restart-cursor-once", {
      third: () => refusal(400, "validation_error", "cursor not recognized"),
    });
    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok).toBe(false);
    // Refused on resuming and again on the walk from the first page: a
    // device that started again for every refusal would never end.
    expect(listed(server)).toEqual([null, "1", "2", "2", null, "1", "2"]);
  });
});
