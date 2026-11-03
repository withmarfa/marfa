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
  refusal,
  typeCatalog,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import type { DoorRow, FolderDoor } from "../../device/folder-door.js";
import type { Item, Outcome } from "../../device/protocol.js";
import type { SseFrame } from "../../device/scripted-server.js";
import {
  folderHarness,
  folderItem,
  type FilterReading,
  type FolderHarness,
} from "./harness.js";
import {
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
        for (const key of ["state", "filter", "tags", "tier"]) {
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
      rows: {
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

    // The witness: the rows the query leaves out are ones the server gives.
    value(await harness.folder.device().pin(id(2)));
    expect(await heldIds(harness)).toContain(id(2));
  });

  it("hydrates with the query's states alone a query that filters by an edge", async () => {
    harness = await folderHarness("copy-query-relational", {
      settings: {
        query: { types: ["core.note"], filter: "edge[references] exists" },
      },
      rows: {
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
      rows: {
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
  options: { pageSize?: number; drop?: (offset: number) => boolean } = {},
) {
  const log: SseFrame[] = [];
  const removal_threshold = { files: 1, fraction: 0.1 };
  const paused = [note(7, "paused one", ["b"]), note(8, "paused two", ["b"])];
  harness = await folderHarness(label, {
    settings: { query: { types: ["core.note"] }, removal_threshold },
    rows: {
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
  const [[copyId, copy]] = door!.conflictedCopies() as [[string, DoorRow]];
  harness.rows["core.note"]!.push({
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
  // The witness: a row the query does not take, held before the shrink.
  expect(held).toContain(id(6));

  moveSettings(
    harness,
    log,
    { query: { types: ["core.note"], filter: TAGGED_A }, removal_threshold },
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

describe("shrinking a copy that holds more than its query shows", () => {
  it("keeps every unsent write and changes no file when a changed query shrinks the copy", async () => {
    const before = await unsentWork("copy-shrink");
    const hydrated = value(await harness!.folder.hydrate());
    expect(hydrated.query).toEqual({
      states: ["active", "archived"],
      filter: TAGGED_A,
    });

    const held = await heldIds(harness!);
    expect(held, "the shrink kept a row its query does not take").not.toContain(
      id(6),
    );
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
  });

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
      rows: {
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
    // The hydration reads the folder's row before its first page.
    const again = value(await harness.folder.hydrate());
    expect([again.resumed, again.restarted]).toEqual([false, "slice_changed"]);
    expect(again.query?.filter).toBe('tags contains "b"');
  });
});

describe("a narrowed copy kept by catch-up", () => {
  /** A folder of the notes tagged `a`, with a held stream a fixture adds
   *  events to, not yet pulled: a row bound to a file is pinned, and stays
   *  whatever its query says. */
  async function narrowed(
    label: string,
    rows: ReturnType<typeof note>[],
    query: FolderSettings["query"] = { types: ["core.note"], filter: TAGGED_A },
  ): Promise<SseFrame[]> {
    const log: SseFrame[] = [];
    harness = await folderHarness(label, {
      settings: { query },
      rows: { "core.note": rows },
      events: [copyHeldLog(log)],
    });
    scriptFolderWrites(harness);
    return log;
  }

  it("lets a row go when an event takes it out of the query, and holds one an event brings into it", async () => {
    const log = await narrowed("copy-query-events", [
      note(1, "leaving", ["a"]),
      note(2, "entering", ["b"]),
    ]);
    expect(await heldIds(harness!)).toEqual([id(1)]);
    const leaving = note(1, "leaving", ["b"]);
    const entering = note(2, "entering", ["a"]);
    harness!.rows["core.note"] = [leaving, entering];
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
      "a row entering the query was held without a read of its edges",
    ).toBe(true);
  });

  it("keeps an item a file is bound to when an event takes it out of the query", async () => {
    const log = await narrowed("copy-query-bound", [
      note(1, "bound", ["a"]),
      note(3, "unbound", ["b"]),
    ]);
    value(await harness!.folder.pull());
    expect(existsSync(join(harness!.dir, "bound.md"))).toBe(true);
    // The witness: a row with no file, held by the query alone.
    const entering = note(3, "unbound", ["a"]);
    harness!.rows["core.note"] = [note(1, "bound", ["a"]), entering];
    log.push(
      copyItemEvent("2", "metadata.changed", wireItem(entering.item), {
        tags: ["a"],
      }),
    );
    value(await harness!.folder.device().catchUp());
    expect(await heldIds(harness!)).toEqual([id(1), id(3)]);

    const leaving = [note(1, "bound", ["b"]), note(3, "unbound", ["b"])];
    harness!.rows["core.note"] = leaving;
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

  it("keeps a row a waiting write names when an event takes it out of the query", async () => {
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
    // The witness: the same event lets go of a row no write names.
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

  /** Whether the device read the row by id, on either door. */
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

  it("reads by id a row an event without its tags names, and holds it with the tags it read", async () => {
    // Archived rows a copy of active notes leaves out, which a bin it holds
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
    harness!.rows["core.note"] = [note(1, "kept", ["a"]), entering, witness];
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
      "the row whose tags no frame carried was not read from the bin",
    ).toBe(true);
  });

  it("reads nothing for a row an event bins where the copy held every state it could leave", async () => {
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
    harness!.rows["core.note"] = [
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
      "a row the bin cannot bring in was read",
    ).toBe(false);
    expect(readById(harness!, 3)).toBe(false);
    // The rows the copy does not hold keep no mark; the witness is a held
    // row's.
    expect(listedMark(harness!, 1)).toBe("1");
    expect(listedMark(harness!, 2)).toBe("0");
    expect(listedMark(harness!, 3)).toBe("0");
  });

  it("holds a row a query of states alone takes from an event without its tags, with the tags its read answers", async () => {
    const log = await narrowed(
      "copy-query-states-tags",
      [note(1, "kept", ["x"]), note(2, "archived", ["x"], "archived")],
      { types: ["core.note"], state: ["active"] },
    );
    expect(await heldIds(harness!)).toEqual([id(1)]);
    const entering = note(2, "archived", ["x"], "trashed");
    harness!.rows["core.note"] = [note(1, "kept", ["x"]), entering];
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
    // The witness: the same event lets go of a row no write names.
    expect(held).not.toContain(id(3));
    expect(held).toContain(id(2));
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
      rows: {
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
      rows: {
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
      rows: {
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
      rows: {
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
});
