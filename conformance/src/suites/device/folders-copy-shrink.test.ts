import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyHeldLog,
  copyItemEvent,
  edgeEvent,
  refusal,
  typeCatalog,
  wireEdge,
  wireItem,
  wireType,
  type WireEdgeOptions,
} from "../../device/marfa-answers.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import type { DoorItem, FolderDoor } from "../../device/folder-door.js";
import type { Item, Outcome } from "../../device/protocol.js";
import type { SseFrame } from "../../device/scripted-server.js";
import {
  folderHarness,
  folderItem,
  readsOf,
  type FilterReading,
  type FolderHarness,
} from "./harness.js";
import {
  EdgeDoor,
  put,
  scriptFolderWrites,
  sentCreates,
  sentUpdates,
} from "./folders.shared.js";

/**
 * "A folder's working copy holds only the items its folder shows."
 *
 * A folder whose query names a filter hydrates its copy narrowed on the
 * server, keeps it narrowed through catch-up by judging each event on the
 * device, and shrinks a copy that held more without touching anything the
 * person has not yet sent.
 */

let harness: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const id = (n: number): string =>
  `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const TAGGED_A = 'tags contains "a"';

const edgeId = (n: number): string =>
  `01a00000-0000-7000-8000-00000000e${String(n).padStart(3, "0")}`;

function note(
  n: number,
  title: string,
  tags: string[],
  state = "active",
): {
  item: { id: string; state: string; properties: Record<string, unknown> };
  tags: string[];
} {
  return {
    item: { id: id(n), state, properties: { title, body: `${title}\n` } },
    tags,
  };
}

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

async function heldIds(folder: FolderHarness): Promise<string[]> {
  const held = value(
    await folder.folder.device().list({ type: "core.note", allStates: true }),
  ) as Item[];
  return held.map((item) => item.id).sort();
}

/** The listings of `core.note` the device asked for, by their keys. */
function noteListings(
  folder: FolderHarness,
  pathname = "/items",
): Array<Record<string, string>> {
  return (
    folder.server.requests
      .filter(
        (request) =>
          request.method === "GET" &&
          request.pathname === pathname &&
          // The count names no type: it answers every type at once.
          (pathname === "/items/stats" ||
            request.query.get("type") === "core.note") &&
          !/^id eq /.test(request.query.get("filter") ?? ""),
      )
      .map((request) => {
        const keys: Record<string, string> = {};
        for (const key of ["state", "filter", "beneath", "tags", "tier"]) {
          const named = request.query.get(key);
          if (named !== null) keys[key] = named;
        }
        return JSON.stringify(keys);
      })
      // A one-row probe of a listing carries the same keys as its pages.
      .filter((keys, index, all) => all.indexOf(keys) === index)
      .map((keys) => JSON.parse(keys) as Record<string, string>)
  );
}

/** Every file of the folder outside `.marfa`, by path, with its bytes and
 *  modification time. */
function filesOf(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      if (name === ".marfa") continue;
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else
        files[relative(dir, path)] =
          `${stat.mtimeMs} ${readFileSync(path).toString("base64")}`;
    }
  };
  walk(dir);
  return files;
}

/** The tables a hydration never touches, dumped whole. */
function keptTables(dir: string): Record<string, string> {
  const store = join(dir, ".marfa", "core.sqlite");
  const dump: Record<string, string> = {};
  for (const table of ["queue", "folder_files", "folder_journal", "pins"]) {
    dump[table] = execFileSync("sqlite3", [store, `SELECT * FROM ${table}`])
      .toString()
      .split("\n")
      .sort()
      .join("\n");
  }
  dump["folder meta"] = execFileSync("sqlite3", [
    store,
    "SELECT * FROM meta WHERE key LIKE 'folder%' ORDER BY key",
  ]).toString();
  return dump;
}

describe("a folder's copy narrowed by its query", () => {
  it("hydrates only the items its query shows, with those in the bin and its conflicted copies", async () => {
    harness = await folderHarness("copy-query-holds", {
      settings: { query: { types: ["core.note"], filter: TAGGED_A } },
      items: {
        "core.note": [
          note(1, "member", ["a"]),
          note(2, "outside", ["b"]),
          note(3, "binned", ["a"], "trashed"),
          note(4, "binned outside", ["b"], "trashed"),
          note(5, "conflicted", ["conflicted-copy"]),
        ],
      },
    });
    scriptFolderWrites(harness);

    expect(await heldIds(harness)).toEqual([id(1), id(3), id(5)]);
    expect(noteListings(harness)).toEqual([
      { state: "active,archived,trashed", filter: TAGGED_A, tier: "library" },
      {
        state: "active,archived,trashed",
        tags: "conflicted-copy",
        tier: "library",
      },
    ]);
    expect(noteListings(harness, "/items/stats")).toEqual([
      { state: "active,archived,trashed", filter: TAGGED_A, tier: "library" },
    ]);
    const status = value(await harness.folder.device().status());
    expect(status.slice_query).toEqual({
      states: ["active", "archived"],
      filter: TAGGED_A,
    });

    // The witness: the items the query leaves out are ones the server gives.
    value(await harness.folder.device().pin(id(2)));
    expect(await heldIds(harness)).toContain(id(2));
  });

  it("hydrates with the query's states alone a query that filters by an edge", async () => {
    harness = await folderHarness("copy-query-relational", {
      settings: {
        query: { types: ["core.note"], filter: "edge[references] exists" },
      },
      items: {
        "core.note": [note(1, "one", ["a"]), note(2, "two", ["b"])],
      },
    });
    scriptFolderWrites(harness);

    expect(await heldIds(harness)).toEqual([id(1), id(2)]);
    expect(noteListings(harness)).toEqual([{ state: "any", tier: "library" }]);
    const status = value(await harness.folder.device().status());
    expect(status.slice_query).toBeUndefined();
  });

  it("keeps the copy it had when the server refuses the query's listing", async () => {
    let settings: FolderSettings = { query: { types: ["core.note"] } };
    const log: SseFrame[] = [];
    harness = await folderHarness("copy-query-refused", {
      settings,
      items: {
        "core.note": [note(1, "one", ["a"]), note(2, "two", ["b"])],
      },
      events: [copyHeldLog(log)],
    });
    scriptFolderWrites(harness);
    value(await harness.folder.pull());
    put(harness, "one.md", "---\ntitle: one\n---\nchanged\n");
    value(await harness.folder.scan());
    const before = keptTables(harness.dir);
    const held = await heldIds(harness);
    expect(held).toEqual([id(1), id(2)]);

    // A filter the scripted server cannot read, so it refuses the listing.
    settings = {
      query: { types: ["core.note"], filter: 'occurred_at gt "2026-01-01"' },
    };
    moveSettings(harness, log, settings, "2");
    value(await harness.folder.device().catchUp());
    const hydrated = await harness.folder.hydrate();
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(false);

    expect(await heldIds(harness)).toEqual(held);
    expect(keptTables(harness.dir)).toEqual(before);
    const status = value(await harness.folder.device().status());
    expect(status.event_cursor).toBe("2");
  });
});

/** Stands for another device changing the folder's settings: the server
 *  holds them and the copy stream carries the change. */
function moveSettings(
  folder: FolderHarness,
  log: SseFrame[],
  settings: FolderSettings,
  at: string,
): void {
  folder.settings.settings = settings;
  folder.settings.version += 1;
  log.push(copyItemEvent(at, "item.updated", folderItem(folder.settings)));
}

/**
 * An un-narrowed folder of notes, some tagged `a`, holding unsent
 * work: an edit of a note the coming query shows and of one it does not, a
 * new file, a file deleted and journalled, a refused tag write, a write
 * that left a conflicted copy, a file whose front matter it cannot read and
 * two files whose removal a pull paused. Its settings then move to a query of
 * the notes tagged `a`, which the copy has caught up with but not yet
 * hydrated.
 */
async function unsentWork(
  label: string,
  options: {
    pageSize?: number;
    drop?: (offset: number) => boolean;
    /** The query the settings move to, the notes tagged `a` unless named. */
    to?: FolderSettings["query"];
    edges?: Record<string, WireEdgeOptions[]>;
  } = {},
) {
  const log: SseFrame[] = [];
  const removal_threshold = { files: 1, fraction: 0.1 };
  const paused = [note(7, "paused one", ["b"]), note(8, "paused two", ["b"])];
  harness = await folderHarness(label, {
    settings: { query: { types: ["core.note"] }, removal_threshold },
    items: {
      "core.note": [
        note(1, "kept", ["a"]),
        note(2, "leaving", ["b"]),
        note(3, "deleted", ["b"]),
        note(4, "flagged", ["a"]),
        note(5, "also kept", ["a"]),
        note(6, "binned elsewhere", ["b"], "trashed"),
        ...paused,
        note(9, "conflicting", ["b"]),
      ],
    },
    events: [copyHeldLog(log)],
    pageSize: options.pageSize,
    drop: options.drop,
    edges: options.edges,
  });
  let door: FolderDoor | undefined;
  scriptFolderWrites(harness, {
    door: (made) => {
      door = made;
    },
    tagging: (request) =>
      request.body.includes("refused")
        ? refusal(422, "validation_error", "Not a tag this fixture takes")
        : undefined,
  });
  value(await harness.folder.pull());
  const device = harness.folder.device();

  // Two items put in the bin elsewhere, whose files a pull leaves in place
  // past the folder's removal threshold.
  for (const [index, row] of paused.entries()) {
    row.item.state = "trashed";
    log.push(
      copyItemEvent(String(2 + index), "item.deleted", wireItem(row.item), {
        tags: row.tags,
      }),
    );
  }
  value(await device.catchUp());
  expect(value(await harness.folder.pull()).paused).toBe(2);

  // A refused write, which stays in the queue with its verdict, and a write
  // another device's edit conflicts with, which leaves a conflicted copy.
  value(await device.addTag(id(5), "refused"));
  door!.update(id(9), { properties: { body: "theirs\n" }, version: 1 });
  value(
    await device.update(id(9), { properties: { body: "mine\n" }, version: 1 }),
  );
  value(await device.drain());
  const [[copyId, copy]] = door!.conflictedCopies() as [[string, DoorItem]];
  harness.items["core.note"]!.push({
    item: { id: copyId, properties: copy.properties },
    tags: copy.tags,
  });

  put(harness, "kept.md", "---\ntitle: kept\n---\nedited\n");
  put(harness, "leaving.md", "---\ntitle: leaving\n---\nedited\n");
  put(harness, "new.md", "---\ntitle: new\n---\nbody\n");
  put(harness, "flagged.md", "---\ntitle: [unclosed\n---\nbody\n");
  rmSync(join(harness.dir, "deleted.md"));
  value(await harness.folder.scan());
  const queued = value(await device.queue());
  expect(queued.some((row) => row.verdict === "refused")).toBe(true);
  expect(queued.filter((row) => row.verdict === null).length).toBeGreaterThan(
    2,
  );

  const held = await heldIds(harness);
  // The witness: an item the query does not take, held before the shrink.
  expect(held).toContain(id(6));

  moveSettings(
    harness,
    log,
    {
      query: options.to ?? { types: ["core.note"], filter: TAGGED_A },
      removal_threshold,
    },
    "4",
  );
  value(await device.catchUp());
  const waiting = await waits(harness);
  expect(waiting["deleted.md"]).toEqual(["delete"]);
  expect(waiting.paused).toEqual({
    disk: 0,
    pull: 2,
    additions: 0,
    outside_query: 0,
  });
  return {
    copyId,
    waits: waiting,
    files: filesOf(harness.dir),
    kept: keptTables(harness.dir),
    queued,
  };
}

/** What each file of the folder waits on, by path, and the removals it
 *  holds paused. */
async function waits(folder: FolderHarness): Promise<Record<string, unknown>> {
  const status = value(await folder.folder.status());
  return {
    ...Object.fromEntries(status.files.map((file) => [file.path, file.waits])),
    paused: status.paused,
  };
}

/** A push after the shrink, once the rename grace has passed, sends every
 *  write the scan queued and the deletion it journaled. */
async function sendsEverything(folder: FolderHarness): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const pushed = value(await folder.folder.push());
  expect(pushed.drain.undelivered).toBe(0);
  const updated = sentUpdates(folder).map((sent) => sent.id);
  expect(updated).toEqual(expect.arrayContaining([id(1), id(2)]));
  expect(
    sentCreates(folder).map(
      (sent) => (sent.properties as Record<string, unknown>).title,
    ),
  ).toContain("new");
  expect(
    folder.server.requests.some(
      (request) =>
        request.pathname.includes(id(3)) && request.method === "DELETE",
    ),
    "the deleted file's item was not put in the bin",
  ).toBe(true);
  expect(
    folder.server.requests.some(
      (request) =>
        request.pathname.includes(id(4)) && request.method === "PATCH",
    ),
    "a file left as the person wrote it was sent",
  ).toBe(false);
}

const shrinks: Array<
  [string, string, Parameters<typeof unsentWork>[1], Record<string, string>]
> = [
  ["by a filter", "copy-shrink", undefined, { filter: TAGGED_A }],
  [
    "beneath an item",
    "copy-shrink-beneath",
    {
      to: { types: ["core.note"], beneath: id(1) },
      edges: {
        "parent-of": [4, 5].map((n) => ({
          id: edgeId(n),
          source_id: id(1),
          target_id: id(n),
        })),
      },
    },
    { beneath: id(1) },
  ],
];

describe("shrinking a copy that holds more than its query shows", () => {
  it.each(shrinks)(
    "keeps every unsent write and changes no file when a changed query %s shrinks the copy",
    async (_, label, options, narrowed) => {
      const before = await unsentWork(label, options);
      const hydrated = value(await harness!.folder.hydrate());
      expect(hydrated.query).toEqual({
        states: ["active", "archived"],
        ...narrowed,
      });

      const held = await heldIds(harness!);
      expect(
        held,
        "the shrink kept an item its query does not take",
      ).not.toContain(id(6));
      expect(held).toEqual(
        expect.arrayContaining([id(1), id(2), id(4), id(5), before.copyId]),
      );
      expect(keptTables(harness!.dir)).toEqual(before.kept);
      expect(filesOf(harness!.dir)).toEqual(before.files);
      expect(value(await harness!.folder.device().queue())).toEqual(
        before.queued,
      );
      expect(await waits(harness!)).toEqual(before.waits);

      await sendsEverything(harness!);
    },
  );

  it("keeps every unsent write when a shrink stopped midway is resumed", async () => {
    let armed = false;
    const before = await unsentWork("copy-shrink-resumed", {
      pageSize: 1,
      drop: (offset) => {
        if (!armed || offset !== 2) return false;
        armed = false;
        return true;
      },
    });
    armed = true;
    const stopped = await harness!.folder.hydrate();
    expect(stopped.ok, JSON.stringify(stopped)).toBe(false);
    expect(armed, "the shrink was not stopped midway").toBe(false);
    expect(keptTables(harness!.dir)).toEqual(before.kept);
    expect(filesOf(harness!.dir)).toEqual(before.files);

    const resumed = value(await harness!.folder.hydrate());
    expect(resumed.resumed).toBe(true);
    expect(await heldIds(harness!)).not.toContain(id(6));
    expect(keptTables(harness!.dir)).toEqual(before.kept);
    expect(filesOf(harness!.dir)).toEqual(before.files);
    expect(value(await harness!.folder.device().queue())).toEqual(
      before.queued,
    );
    expect(await waits(harness!)).toEqual(before.waits);

    await sendsEverything(harness!);
  });

  it("starts a stopped shrink again from the first page when the query changes", async () => {
    let armed = false;
    const log: SseFrame[] = [];
    harness = await folderHarness("copy-shrink-restarted", {
      settings: { query: { types: ["core.note"] } },
      items: {
        "core.note": [
          note(1, "one", ["a", "b"]),
          note(2, "two", ["a", "b"]),
          note(3, "three", ["a", "b"]),
        ],
      },
      events: [copyHeldLog(log)],
      pageSize: 1,
      drop: (offset) => {
        if (!armed || offset !== 2) return false;
        armed = false;
        return true;
      },
    });
    scriptFolderWrites(harness);
    const device = harness.folder.device();
    moveSettings(
      harness,
      log,
      { query: { types: ["core.note"], filter: TAGGED_A } },
      "2",
    );
    value(await device.catchUp());
    armed = true;
    expect((await harness.folder.hydrate()).ok).toBe(false);

    moveSettings(
      harness,
      log,
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      "3",
    );
    // The hydration reads the folder's item before its first page.
    const again = value(await harness.folder.hydrate());
    expect([again.resumed, again.restarted]).toEqual([false, "slice_changed"]);
    expect(again.query?.filter).toBe('tags contains "b"');
  });
});

describe("a narrowed copy kept by catch-up", () => {
  /** A folder of the notes tagged `a`, with a held stream a fixture adds
   *  events to, not yet pulled: an item bound to a file is pinned, and stays
   *  whatever its query says. */
  async function narrowed(
    label: string,
    rows: ReturnType<typeof note>[],
    query: FolderSettings["query"] = { types: ["core.note"], filter: TAGGED_A },
    edges?: EdgeDoor,
  ): Promise<SseFrame[]> {
    const log: SseFrame[] = [];
    harness = await folderHarness(label, {
      settings: { query },
      items: { "core.note": rows },
      events: [copyHeldLog(log)],
    });
    scriptFolderWrites(harness, edges === undefined ? {} : { edges });
    return log;
  }

  it("lets an item go when an event takes it out of the query, and holds one an event brings into it", async () => {
    const log = await narrowed("copy-query-events", [
      note(1, "leaving", ["a"]),
      note(2, "entering", ["b"]),
    ]);
    expect(await heldIds(harness!)).toEqual([id(1)]);
    const leaving = note(1, "leaving", ["b"]);
    const entering = note(2, "entering", ["a"]);
    harness!.items["core.note"] = [leaving, entering];
    log.push(
      copyItemEvent("2", "metadata.changed", wireItem(leaving.item), {
        tags: ["b"],
      }),
      copyItemEvent("3", "metadata.changed", wireItem(entering.item), {
        tags: ["a"],
      }),
    );

    value(await harness!.folder.device().catchUp());
    expect(await heldIds(harness!)).toEqual([id(2)]);
    expect(
      harness!.server.requests.some(
        (request) => request.pathname === `/items/${id(2)}`,
      ),
      "an item entering the query was held without a read of its edges",
    ).toBe(true);
  });

  it("keeps an item a file is bound to when an event takes it out of the query", async () => {
    const log = await narrowed("copy-query-bound", [
      note(1, "bound", ["a"]),
      note(3, "unbound", ["b"]),
    ]);
    value(await harness!.folder.pull());
    expect(existsSync(join(harness!.dir, "bound.md"))).toBe(true);
    // The witness: an item with no file, held by the query alone.
    const entering = note(3, "unbound", ["a"]);
    harness!.items["core.note"] = [note(1, "bound", ["a"]), entering];
    log.push(
      copyItemEvent("2", "metadata.changed", wireItem(entering.item), {
        tags: ["a"],
      }),
    );
    value(await harness!.folder.device().catchUp());
    expect(await heldIds(harness!)).toEqual([id(1), id(3)]);

    const leaving = [note(1, "bound", ["b"]), note(3, "unbound", ["b"])];
    harness!.items["core.note"] = leaving;
    for (const [index, row] of leaving.entries()) {
      log.push(
        copyItemEvent(
          String(index + 3),
          "metadata.changed",
          wireItem(row.item),
          { tags: ["b"] },
        ),
      );
    }
    value(await harness!.folder.device().catchUp());
    expect(
      await heldIds(harness!),
      "the copy let go of an item its folder still has a file for",
    ).toEqual([id(1)]);
  });

  it("keeps an item a waiting write names when an event takes it out of the query", async () => {
    const log = await narrowed("copy-query-waiting", [
      note(1, "waiting", ["a"]),
      note(2, "witness", ["a"]),
    ]);
    const device = harness!.folder.device();
    const waiting = value(
      await device.update(id(1), {
        properties: { body: "mine\n" },
        version: 1,
      }),
    );
    expect(waiting.verdict).toBeNull();
    log.push(
      copyItemEvent(
        "2",
        "metadata.changed",
        wireItem(note(1, "waiting", ["b"]).item),
        { tags: ["b"] },
      ),
      copyItemEvent(
        "3",
        "metadata.changed",
        wireItem(note(2, "witness", ["b"]).item),
        { tags: ["b"] },
      ),
    );
    value(await device.catchUp());

    const held = await heldIds(harness!);
    // The witness: the same event lets go of an item no write names.
    expect(held).not.toContain(id(2));
    expect(held).toContain(id(1));
  });

  /** An `item.deleted` frame, which carries no metadata. */
  function binned(at: string, row: ReturnType<typeof note>): SseFrame {
    return {
      id: at,
      event: "item.deleted",
      data: {
        event_type: "item.deleted",
        item: wireItem({ ...row.item, state: "trashed" }),
        listed: true,
      },
    };
  }

  /** Whether the device read the item by id, on either door. */
  function readById(folder: FolderHarness, n: number): boolean {
    return folder.server.requests.some(
      (request) =>
        request.pathname === `/items/${id(n)}` ||
        request.query.get("filter") === `id eq "${id(n)}"`,
    );
  }

  function listedMark(folder: FolderHarness, n: number): string {
    return execFileSync("sqlite3", [
      join(folder.dir, ".marfa", "core.sqlite"),
      `SELECT count(*) FROM meta WHERE key = 'item_listed/${id(n)}'`,
    ])
      .toString()
      .trim();
  }

  it("reads by id an item an event without its tags names, and holds it with the tags it read", async () => {
    // Archived items a copy of active notes leaves out, which a bin it holds
    // can bring in.
    const log = await narrowed(
      "copy-query-unknown-tags",
      [
        note(1, "kept", ["a"]),
        note(2, "binned", ["a"], "archived"),
        note(3, "binned outside", ["b"], "archived"),
      ],
      { types: ["core.note"], state: ["active"], filter: TAGGED_A },
    );
    expect(await heldIds(harness!)).toEqual([id(1)]);
    const entering = note(2, "binned", ["a"], "trashed");
    const witness = note(3, "binned outside", ["b"], "trashed");
    harness!.items["core.note"] = [note(1, "kept", ["a"]), entering, witness];
    log.push(binned("2", entering), binned("3", witness));
    value(await harness!.folder.device().catchUp());

    const held = await heldIds(harness!);
    expect(held).toContain(id(2));
    expect(held).not.toContain(id(3));
    const read = (
      value(
        await harness!.folder
          .device()
          .list({ type: "core.note", allStates: true }),
      ) as Item[]
    ).find((item) => item.id === id(2));
    expect(read?.tags).toEqual(["a"]);
    expect(
      harness!.server.requests.some(
        (request) =>
          request.query.get("filter") === `id eq "${id(3)}"` &&
          request.query.get("state") === "trashed",
      ),
      "the item whose tags no frame carried was not read from the bin",
    ).toBe(true);
  });

  it("reads nothing for an item an event bins where the copy held every state it could leave", async () => {
    const log = await narrowed("copy-query-unknown-tags-unread", [
      note(1, "kept", ["a"]),
      note(2, "outside", ["b"]),
      note(3, "archived outside", ["b"], "archived"),
    ]);
    expect(await heldIds(harness!)).toEqual([id(1)]);
    const rows = [
      note(2, "outside", ["b"]),
      note(3, "archived outside", ["b"]),
    ];
    harness!.items["core.note"] = [
      note(1, "kept", ["a"]),
      ...rows.map((row) => ({
        ...row,
        item: { ...row.item, state: "trashed" },
      })),
    ];
    log.push(binned("2", rows[0]!), binned("3", rows[1]!));
    value(await harness!.folder.device().catchUp());

    expect(await heldIds(harness!)).toEqual([id(1)]);
    expect(
      readById(harness!, 2),
      "an item the bin cannot bring in was read",
    ).toBe(false);
    expect(readById(harness!, 3)).toBe(false);
    // The items the copy does not hold keep no mark; the witness is a held
    // item's.
    expect(listedMark(harness!, 1)).toBe("1");
    expect(listedMark(harness!, 2)).toBe("0");
    expect(listedMark(harness!, 3)).toBe("0");
  });

  it("holds an item a query of states alone takes from an event without its tags, with the tags its read answers", async () => {
    const log = await narrowed(
      "copy-query-states-tags",
      [note(1, "kept", ["x"]), note(2, "archived", ["x"], "archived")],
      { types: ["core.note"], state: ["active"] },
    );
    expect(await heldIds(harness!)).toEqual([id(1)]);
    const entering = note(2, "archived", ["x"], "trashed");
    harness!.items["core.note"] = [note(1, "kept", ["x"]), entering];
    log.push(binned("2", entering));
    value(await harness!.folder.device().catchUp());

    const held = (
      value(
        await harness!.folder
          .device()
          .list({ type: "core.note", allStates: true }),
      ) as Item[]
    ).find((item) => item.id === id(2));
    expect(held?.state).toBe("trashed");
    expect(held?.tags).toEqual(["x"]);
  });

  it("keeps the target of a waiting edge write when an event takes it out of the query", async () => {
    const log = await narrowed("copy-query-edge-target", [
      note(1, "source", ["a"]),
      note(2, "target", ["a"]),
      note(3, "witness", ["a"]),
    ]);
    const device = harness!.folder.device();
    const drawn = value(
      await device.createEdge({
        source: id(1),
        target: id(2),
        type: "references",
      }),
    );
    expect(drawn.verdict).toBeNull();
    for (const [at, n, title] of [
      ["2", 2, "target"],
      ["3", 3, "witness"],
    ] as const) {
      log.push(
        copyItemEvent(
          at,
          "metadata.changed",
          wireItem(note(n, title, ["b"]).item),
          {
            tags: ["b"],
          },
        ),
      );
    }
    value(await device.catchUp());

    const held = await heldIds(harness!);
    // The witness: the same event lets go of an item no write names.
    expect(held).not.toContain(id(3));
    expect(held).toContain(id(2));

    // Answered, the write names the target no more.
    value(await device.drain());
    expect(await heldIds(harness!)).toEqual([id(1)]);
  });

  it("keeps the target of an answered edge write that another waiting write still names", async () => {
    const edges = new EdgeDoor();
    // The edge to the second note meets a server failing now, so its write
    // still waits once the drain is done.
    edges.placing = (edge) =>
      edge.target_id === id(2)
        ? refusal(503, "service_unavailable", "Unavailable")
        : edge.target_id === id(4)
          ? refusal(400, "validation_error", "Not an edge this server takes")
          : undefined;
    const log = await narrowed(
      "copy-query-edge-target-named",
      [
        note(1, "source", ["a"]),
        note(2, "still named", ["a"]),
        note(3, "accepted", ["a"]),
        note(4, "refused", ["a"]),
      ],
      undefined,
      edges,
    );
    const device = harness!.folder.device();
    // The failing write last, so the pass sends the others before it.
    for (const n of [3, 4, 2]) {
      const drawn = value(
        await device.createEdge({
          source: id(1),
          target: id(n),
          type: "references",
        }),
      );
      expect(drawn.verdict).toBeNull();
    }
    for (const [at, n, title] of [
      ["2", 2, "still named"],
      ["3", 3, "accepted"],
      ["4", 4, "refused"],
    ] as const) {
      log.push(
        copyItemEvent(
          at,
          "metadata.changed",
          wireItem(note(n, title, ["b"]).item),
          { tags: ["b"] },
        ),
      );
    }
    value(await device.catchUp());
    expect(await heldIds(harness!)).toEqual([id(1), id(2), id(3), id(4)]);

    await device.drain();
    const verdicts = Object.fromEntries(
      value(await device.queue())
        .filter((write) => write.kind === "create_edge")
        .map((write) => [String(write.target_id), write.verdict]),
    );
    expect(verdicts).toEqual({
      [id(2)]: null,
      [id(3)]: "accepted",
      [id(4)]: "refused",
    });
    // The witnesses: the same drain lets go of the targets of the accepted
    // write and the refused one.
    expect(await heldIds(harness!)).toEqual([id(1), id(2)]);
  });

  it("lets go of the target of an edge write withdrawn after an event took it out of the query", async () => {
    const edges = new EdgeDoor();
    // A blocked write, which only a withdraw takes out of the queue.
    edges.placing = () => refusal(409, "version_conflict", "The edge moved on");
    const log = await narrowed(
      "copy-query-edge-withdrawn",
      [note(1, "source", ["a"]), note(2, "target", ["a"])],
      undefined,
      edges,
    );
    const device = harness!.folder.device();
    const drawn = value(
      await device.createEdge({
        source: id(1),
        target: id(2),
        type: "references",
      }),
    );
    log.push(
      copyItemEvent(
        "2",
        "metadata.changed",
        wireItem(note(2, "target", ["b"]).item),
        { tags: ["b"] },
      ),
    );
    value(await device.catchUp());
    await device.drain();
    expect(
      value(await device.queue()).find((write) => write.id === drawn.id)
        ?.verdict,
    ).toBe("blocked");
    // The witness: while it waits, blocked, the write keeps the target.
    expect(await heldIds(harness!)).toEqual([id(1), id(2)]);

    expect(value(await device.withdraw(String(drawn.id)))).toEqual([
      String(drawn.id),
    ]);
    expect(await heldIds(harness!)).toEqual([id(1)]);
  });

  it("pins a create the query does not show, and holds it past its echo", async () => {
    const log = await narrowed("copy-query-create", [note(1, "kept", ["a"])]);
    const device = harness!.folder.device();
    const created = value(
      await device.create({
        type: "core.note",
        properties: { title: "outside", body: "outside\n" },
      }),
    );
    const createdId = String(created.item_id);
    value(await device.drain());
    log.push(
      copyItemEvent(
        "2",
        "item.created",
        wireItem({
          id: createdId,
          properties: { title: "outside", body: "outside\n" },
        }),
        { tags: [] },
      ),
    );
    value(await device.catchUp());

    const status = value(await device.status());
    expect(status.pinned).toContain(createdId);
    expect(await heldIds(harness!)).toContain(createdId);
  });
});

describe("a folder's copy narrowed beneath an item", () => {
  const parentOf = (n: number, source: number, target: number) => ({
    id: edgeId(n),
    source_id: id(source),
    target_id: id(target),
  });

  /** A folder of the notes beneath `id(1)`, with a held stream a fixture
   *  adds events to and the `parent-of` edges the server holds, which a
   *  fixture changes as it moves a branch. */
  async function beneath(
    label: string,
    rows: ReturnType<typeof note>[],
    edges: WireEdgeOptions[],
  ): Promise<{ log: SseFrame[]; edges: WireEdgeOptions[] }> {
    const log: SseFrame[] = [];
    harness = await folderHarness(label, {
      settings: { query: { types: ["core.note"], beneath: id(1) } },
      items: { "core.note": rows },
      edges: { "parent-of": edges },
      events: [copyHeldLog(log)],
    });
    scriptFolderWrites(harness);
    return { log, edges };
  }

  const parentEvent = (
    at: string,
    kind: string,
    edge: WireEdgeOptions,
  ): SseFrame =>
    edgeEvent(at, kind, wireEdge({ ...edge, edge_type: "parent-of" }));

  it("hydrates only the item and everything beneath it, with its parent-of edges whole", async () => {
    await beneath(
      "copy-beneath-holds",
      [
        note(1, "root", []),
        note(2, "child", []),
        note(3, "grandchild", [], "trashed"),
        note(4, "outside", []),
        note(7, "outside child", []),
        note(9, "conflicted", ["conflicted-copy"]),
      ],
      [parentOf(1, 1, 2), parentOf(2, 2, 3), parentOf(3, 4, 7)],
    );

    expect(await heldIds(harness!)).toEqual([id(1), id(2), id(3), id(9)]);
    expect(noteListings(harness!)).toEqual([
      {
        state: "active,archived,trashed",
        beneath: id(1),
        tier: "library",
      },
      {
        state: "active,archived,trashed",
        tags: "conflicted-copy",
        tier: "library",
      },
    ]);
    expect(noteListings(harness!, "/items/stats")).toEqual([
      {
        state: "active,archived,trashed",
        beneath: id(1),
        tier: "library",
      },
    ]);
    const status = value(await harness!.folder.device().status());
    expect(status.slice_query).toEqual({
      states: ["active", "archived"],
      beneath: id(1),
    });
    // An edge between two items the copy does not hold is held all the same.
    expect(
      value(await harness!.folder.device().edgesFrom(id(4))).map(
        (edge) => edge.target_id,
      ),
    ).toEqual([id(7)]);

    // The witness: the items left out are ones the server gives.
    value(await harness!.folder.device().pin(id(4)));
    expect(await heldIds(harness!)).toContain(id(4));
  });

  it("holds a branch moved beneath the item, and writes its files", async () => {
    const { log, edges } = await beneath(
      "copy-beneath-enters",
      [
        note(1, "root", []),
        note(2, "child", []),
        note(5, "branch", []),
        note(6, "leaf", []),
      ],
      [parentOf(1, 1, 2), parentOf(2, 5, 6)],
    );
    value(await harness!.folder.pull());
    expect(await heldIds(harness!)).toEqual([id(1), id(2)]);
    expect(existsSync(join(harness!.dir, "leaf.md"))).toBe(false);

    const moved = parentOf(3, 2, 5);
    edges.push(moved);
    log.push(parentEvent("2", "edge.created", moved));
    value(await harness!.folder.device().catchUp());
    value(await harness!.folder.pull());

    expect(await heldIds(harness!)).toEqual([id(1), id(2), id(5), id(6)]);
    expect(
      [readsOf(harness!.server, id(5)), readsOf(harness!.server, id(6))],
      "the branch was not read by id, once",
    ).toEqual([1, 1]);
    expect(readsOf(harness!.server, id(2)), "an item held was read").toBe(0);
    expect(readFileSync(join(harness!.dir, "branch.md"), "utf8")).toContain(
      "branch",
    );
    expect(readFileSync(join(harness!.dir, "leaf.md"), "utf8")).toContain(
      "leaf",
    );
  });

  it("lets go of a branch moved out from beneath the item, but an item a waiting write names", async () => {
    const { log } = await beneath(
      "copy-beneath-leaves",
      [
        note(1, "root", []),
        note(2, "branch", []),
        note(3, "waiting", []),
        note(4, "leaf", []),
      ],
      [parentOf(1, 1, 2), parentOf(2, 2, 3), parentOf(3, 2, 4)],
    );
    const device = harness!.folder.device();
    expect(await heldIds(harness!)).toEqual([id(1), id(2), id(3), id(4)]);
    const waiting = value(
      await device.update(id(3), {
        properties: { body: "mine\n" },
        version: 1,
      }),
    );
    expect(waiting.verdict).toBeNull();

    log.push(parentEvent("2", "edge.deleted", parentOf(1, 1, 2)));
    value(await device.catchUp());

    const held = await heldIds(harness!);
    // The witness: the same move lets go of items no write names.
    expect(held).not.toContain(id(2));
    expect(held).not.toContain(id(4));
    expect(held).toEqual([id(1), id(3)]);
  });

  it("keeps the branch while the item is in the bin, and lets it go once the item is purged", async () => {
    const { log } = await beneath(
      "copy-beneath-root-binned",
      [note(1, "root", []), note(2, "child", []), note(3, "grandchild", [])],
      [parentOf(1, 1, 2), parentOf(2, 2, 3)],
    );
    expect(await heldIds(harness!)).toEqual([id(1), id(2), id(3)]);

    const binned = note(1, "root", [], "trashed");
    harness!.items["core.note"]![0] = binned;
    log.push(
      copyItemEvent("2", "item.deleted", wireItem(binned.item), { tags: [] }),
    );
    value(await harness!.folder.device().catchUp());
    expect(await heldIds(harness!)).toEqual([id(1), id(2), id(3)]);

    harness!.items["core.note"]!.shift();
    log.push(
      copyItemEvent("3", "item.purged", wireItem(binned.item), { tags: [] }),
    );
    value(await harness!.folder.device().catchUp());
    expect(await heldIds(harness!)).toEqual([]);
  });
});

describe("a narrowed copy and its catalog", () => {
  it("expires the copy when the catalog changes the status field its query reads", async () => {
    const ticket = (stage: Array<{ value: string; group: string }>) =>
      wireType("app.test.ticket", {
        bodyField: "body",
        fields: {
          title: { type: "string" },
          body: { type: "string" },
          stage: { type: "status", status_values: stage },
        },
      });
    const before = ticket([
      { value: "doing", group: "in_progress" },
      { value: "done", group: "completed" },
    ]);
    const after = ticket([
      { value: "doing", group: "completed" },
      { value: "done", group: "completed" },
    ]);
    let catalog = typeCatalog([before]);
    const doing = (row: { item: { properties?: Record<string, unknown> } }) =>
      row.item.properties?.stage === "doing";
    const reading: FilterReading = (filter) =>
      filter === 'status_group eq "in_progress"' ? doing : undefined;
    const log: SseFrame[] = [];
    harness = await folderHarness("copy-query-catalog", {
      settings: {
        query: {
          types: ["app.test.ticket"],
          filter: 'status_group eq "in_progress"',
        },
      },
      items: {
        "app.test.ticket": [
          {
            item: {
              id: id(1),
              type: "app.test.ticket",
              properties: { title: "doing", body: "", stage: "doing" },
            },
          },
          {
            item: {
              id: id(2),
              type: "app.test.ticket",
              properties: { title: "done", body: "", stage: "done" },
            },
          },
        ],
      },
      catalog: () => catalog,
      events: [copyHeldLog(log)],
      reading,
    });
    scriptFolderWrites(harness);
    const device = harness.folder.device();
    // The witness: a catch-up under the same catalog carries on.
    value(await device.catchUp());

    catalog = typeCatalog([after]);
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(false);
    if (caught.ok) return;
    expect(caught.refusal.code).toBe("copy_expired");
    expect(caught.refusal.raw).toContain("catalog_changed");
  });
});

describe("a saved view read from a narrowed copy", () => {
  it("refuses a view the copy's query does not cover, and answers one it does", async () => {
    const view = (n: number, filter: string) => ({
      item: {
        id: id(n),
        type: "system.view",
        properties: {
          title: `view ${n}`,
          query: { types: ["core.note"], tier: "library", filter },
        },
      },
    });
    harness = await folderHarness("copy-query-view", {
      settings: { query: { types: ["core.note"], filter: TAGGED_A } },
      items: {
        "core.note": [note(1, "member", ["a"]), note(2, "outside", ["b"])],
        "system.view": [view(10, TAGGED_A), view(11, 'tags contains "b"')],
      },
      catalog: typeCatalog([{ id: "system.view", version: 0, fields: {} }]),
    });
    scriptFolderWrites(harness);
    const device = harness.folder.device();
    value(await device.pin(id(10)));
    value(await device.pin(id(11)));

    const covered = value(
      await device.attempt(["items", "list", "--view", id(10)]),
    ) as { items: Item[] };
    expect(covered.items.map((item) => item.id)).toEqual([id(1)]);

    const other = await device.attempt(["items", "list", "--view", id(11)]);
    expect(other.ok, JSON.stringify(other)).toBe(false);
    if (other.ok) return;
    expect(other.refusal.code).toBe("invalid");
  });

  it("answers from a copy narrowed by states alone a view of those states with any filter, and refuses one of another state", async () => {
    const view = (n: number, state: string[], filter?: string) => ({
      item: {
        id: id(n),
        type: "system.view",
        properties: {
          title: `view ${n}`,
          query: {
            types: ["core.note"],
            tier: "library",
            state,
            ...(filter && { filter }),
          },
        },
      },
    });
    harness = await folderHarness("copy-query-view-states", {
      settings: { query: { types: ["core.note"], state: ["active"] } },
      items: {
        "core.note": [
          note(1, "member", ["a"]),
          note(2, "other member", ["b"]),
          note(3, "archived", ["b"], "archived"),
        ],
        "system.view": [
          view(10, ["active"], 'tags contains "b"'),
          view(11, ["archived"]),
        ],
      },
      catalog: typeCatalog([{ id: "system.view", version: 0, fields: {} }]),
    });
    scriptFolderWrites(harness);
    const device = harness.folder.device();
    value(await device.pin(id(10)));
    value(await device.pin(id(11)));

    const covered = value(
      await device.attempt(["items", "list", "--view", id(10)]),
    ) as { items: Item[] };
    expect(covered.items.map((item) => item.id)).toEqual([id(2)]);

    const other = await device.attempt(["items", "list", "--view", id(11)]);
    expect(other.ok, JSON.stringify(other)).toBe(false);
    if (other.ok) return;
    expect(other.refusal.code).toBe("invalid");
  });
});

describe("a file naming an item a narrowed copy leaves out", () => {
  /** A file carrying the id of note 3, which the server holds tagged `b`,
   *  as a file restored from a backup or copied from another Mac carries
   *  it, pushed by a folder of notes narrowed by `filter`. */
  async function pushedOutside(label: string, filter?: string) {
    harness = await folderHarness(label, {
      settings: {
        query: { types: ["core.note"], ...(filter && { filter }) },
      },
      items: {
        "core.note": [note(1, "member", ["a"]), note(3, "outside", ["b"])],
      },
    });
    scriptFolderWrites(harness);
    value(await harness.folder.pull());
    // Under the filter the pull wrote no such file, so this one is new; the
    // witness's pull wrote it, and this is an edit of it.
    expect(existsSync(join(harness.dir, "outside.md"))).toBe(!filter);
    put(
      harness,
      "outside.md",
      `---\nmarfa_id: ${id(3)}\ntitle: outside\n---\nedited on another Mac\n`,
    );
    return value(await harness.folder.push());
  }

  it("sends the file as an edit of the item its id names, not as a new item", async () => {
    await pushedOutside("copy-query-arrival", TAGGED_A);
    expect(sentUpdates(harness!).map((sent) => sent.id)).toContain(id(3));
    expect(
      sentCreates(harness!).map(
        (sent) => (sent.properties as Record<string, unknown>).title,
      ),
      "the file was sent as a new item carrying another item's id",
    ).not.toContain("outside");
  });

  it("sends the same file as an edit from a copy that is not narrowed", async () => {
    await pushedOutside("copy-query-arrival-witness");
    expect(sentUpdates(harness!).map((sent) => sent.id)).toContain(id(3));
    expect(
      sentCreates(harness!).map(
        (sent) => (sent.properties as Record<string, unknown>).title,
      ),
    ).not.toContain("outside");
  });

  it("reads the ids a pass names together and asks again only once a file changes", async () => {
    harness = await folderHarness("copy-query-arrival-batched", {
      settings: {
        query: { types: ["core.note"], filter: TAGGED_A },
        // Holds the new files back unbound, so every pass meets them again.
        addition_threshold: { files: 2, fraction: 0.25 },
      },
      items: { "core.note": [note(1, "member", ["a"])] },
    });
    scriptFolderWrites(harness);
    value(await harness.folder.pull());
    const unknown = (at: number) => id(1000 + at);
    for (let at = 0; at < 250; at++) {
      put(
        harness,
        `restored-${String(at)}.md`,
        `---\nmarfa_id: ${unknown(at)}\ntitle: restored ${String(at)}\n---\nfrom a backup\n`,
      );
    }
    const reads = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "POST" && request.pathname === "/items/bulk-get",
      );
    const singles = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "GET" && /^\/items\/[^/]+$/.test(request.pathname),
      );
    const [bulkBefore, singleBefore] = [reads().length, singles().length];

    value(await harness.folder.push());
    const first = reads().slice(bulkBefore);
    expect(first).toHaveLength(3);
    expect(singles().length - singleBefore).toBe(0);
    const asked = first.flatMap(
      (request) => (JSON.parse(request.body) as { ids: string[] }).ids,
    );
    expect(new Set(asked)).toEqual(
      new Set(Array.from({ length: 250 }, (_, at) => unknown(at))),
    );

    value(await harness.folder.push());
    expect(reads().length - bulkBefore).toBe(3);
    expect(singles().length - singleBefore).toBe(0);

    put(
      harness,
      "restored-7.md",
      `---\nmarfa_id: ${unknown(7)}\ntitle: restored 7\n---\nedited since\n`,
    );
    value(await harness.folder.push());
    const again = reads().slice(bulkBefore + 3);
    expect(again).toHaveLength(1);
    expect((JSON.parse(again[0]!.body) as { ids: string[] }).ids).toEqual([
      unknown(7),
    ]);
  });
});

describe("giving a shrunk copy's freed pages back to the disk", () => {
  /** The store's pages, the free ones among them, and the bytes of its file
   *  and of its log, as the disk holds them. */
  function pagesOf(dir: string): {
    pages: number;
    free: number;
    file: number;
    log: number;
  } {
    const store = join(dir, ".marfa", "core.sqlite");
    const [pages = 0, free = 0] = execFileSync("sqlite3", [
      store,
      "PRAGMA page_count; PRAGMA freelist_count;",
    ])
      .toString()
      .trim()
      .split("\n")
      .map(Number);
    const size = (path: string): number =>
      existsSync(path) ? statSync(path).size : 0;
    return {
      pages,
      free,
      file: size(store),
      log: size(`${store}-wal`),
    };
  }

  it("rewrites a copy whose items left without losing a pin, and its search still answers", async () => {
    const log: SseFrame[] = [];
    const bulk = "lorem ipsum dolor sit amet ".repeat(500);
    const leaving = Array.from({ length: 400 }, (_, at) =>
      note(100 + at, `leaving ${at} needle${at}`, ["b"]),
    );
    for (const row of leaving) row.item.properties.body = bulk;
    harness = await folderHarness("copy-reclaim", {
      settings: { query: { types: ["core.note"] } },
      items: {
        "core.note": [
          note(1, "kept one", ["a"]),
          note(2, "kept two", ["a"]),
          ...leaving,
        ],
      },
      events: [copyHeldLog(log)],
      pageSize: 200,
    });
    scriptFolderWrites(harness);
    const device = harness.folder.device();
    // No pull: a file bound to an item would keep the item past the shrink.
    value(await device.pin(id(100)));
    expect(await heldIds(harness)).toHaveLength(402);

    moveSettings(
      harness,
      log,
      { query: { types: ["core.note"], filter: TAGGED_A } },
      "2",
    );
    value(await device.catchUp());
    value(await harness.folder.hydrate());
    expect(await heldIds(harness)).toEqual([id(1), id(2), id(100)]);
    const shrunk = pagesOf(harness.dir);
    const pinnedBefore = value(await device.status()).pinned;
    expect(pinnedBefore).toContain(id(100));
    // The witness: the items left and the disk did not get them back.
    expect(shrunk.free).toBeGreaterThanOrEqual(1024);
    expect(shrunk.free * 2).toBeGreaterThanOrEqual(shrunk.pages);

    value(await harness.folder.push());

    const reclaimed = pagesOf(harness.dir);
    expect(reclaimed.free).toBe(0);
    expect(reclaimed.file * 4).toBeLessThan(shrunk.pages * 4096);
    expect(reclaimed.log * 4).toBeLessThan(shrunk.pages * 4096);
    expect(await heldIds(harness)).toEqual([id(1), id(2), id(100)]);
    const status = value(await device.status());
    for (const kept of pinnedBefore) expect(status.pinned).toContain(kept);
    const found = value(await device.search("needle0"));
    expect(found.map((hit) => hit.item.id)).toEqual([id(100)]);
    expect(
      value(await device.search("kept"))
        .map((hit) => hit.item.id)
        .sort(),
    ).toEqual([id(1), id(2)]);
  });

  it("leaves a copy with little to free as it is", async () => {
    harness = await folderHarness("copy-reclaim-small", {
      settings: { query: { types: ["core.note"] } },
      items: { "core.note": [note(1, "one", ["a"]), note(2, "two", ["b"])] },
    });
    scriptFolderWrites(harness);
    value(await harness.folder.push());
    const before = pagesOf(harness.dir);
    value(await harness.folder.push());
    expect(pagesOf(harness.dir).pages).toBe(before.pages);
  });
});
