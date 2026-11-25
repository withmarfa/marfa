import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  copyItemEvent,
  wireEdge,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import { tempFolder } from "../../utils/temp-folder.js";
import {
  KEY,
  acceptUploads,
  folderHarness,
  folderItem,
  hashOf,
  requireBinary,
  scriptBlob,
  scriptFolderItem,
  scriptWrites,
} from "./harness.js";
import { CliFolder, type FolderSettings } from "../../device/cli-adapter.js";
import type { FolderDoor } from "../../device/folder-door.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import type { FolderHarness, FolderItem } from "./harness.js";
import type {
  WireEdgeOptions,
  WireItemOptions,
} from "../../device/marfa-answers.js";
import {
  EdgeDoor,
  idIn,
  lastReport,
  put,
  read,
  saveAtomically,
  scriptFolderWrites,
  sentCreates,
  sentTitles,
  sentUpdates,
  withFault,
} from "./folders.shared.js";
import { ON_MACOS } from "../../utils/platform.js";

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;
const SAME_FOLDER = Symbol("the same folder");

afterEach(async () => {
  await harness?.stop();
  await second?.stop();
  harness = undefined;
  second = undefined;
});

describe("folders on one Mac", () => {
  describe(
    "unidentified cross-directory moves and older deletions",
    ON_MACOS,
    () => {
      it.each(["directory", "file", "unreadable file"])(
        "holds cross-directory moves and older deletions behind an unidentified %s",
        async (kind) => {
          const moved = "01a00000-0000-7000-8000-000000000ae1";
          const missing = "01a00000-0000-7000-8000-000000000ae2";
          harness = await folderHarness(`contract-unidentified-${kind}`, {
            items: {
              "core.note": [
                {
                  item: {
                    id: moved,
                    properties: { title: "Moved", body: "moved body\n" },
                  },
                },
                {
                  item: {
                    id: missing,
                    properties: { title: "Missing", body: "missing body\n" },
                  },
                },
                {
                  item: {
                    id: "01a00000-0000-7000-8000-000000000ae3",
                    properties: { title: "Stable", body: "stable body\n" },
                  },
                },
              ],
            },
          });
          expect((await harness.folder.pull()).ok).toBe(true);
          rmSync(join(harness.dir, "Missing.md"));
          const complete = await harness.folder.scan();
          expect(complete.ok && complete.value.missing).toBe(1);
          const child = join(harness.dir, "child");
          mkdirSync(child);
          const target = join(child, "Moved.md");
          renameSync(join(harness.dir, "Moved.md"), target);
          const bytes = readFileSync(target);
          const affected = kind === "directory" ? child : target;
          const originalBirth = statSync(affected, {
            bigint: true,
          }).birthtimeNs;
          const setBirth = (birth: bigint) =>
            execFileSync("python3", [
              "-c",
              `
import ctypes, os, sys
class AttrList(ctypes.Structure):
    _fields_ = [("count", ctypes.c_uint16), ("reserved", ctypes.c_uint16), ("common", ctypes.c_uint32), ("volume", ctypes.c_uint32), ("dir", ctypes.c_uint32), ("file", ctypes.c_uint32), ("fork", ctypes.c_uint32)]
class Timespec(ctypes.Structure):
    _fields_ = [("seconds", ctypes.c_long), ("nanos", ctypes.c_long)]
attrs = AttrList(5, 0, 0x200, 0, 0, 0, 0)
stamp = Timespec(*divmod(int(sys.argv[2]), 1000000000))
lib = ctypes.CDLL(None, use_errno=True)
if lib.setattrlist(os.fsencode(sys.argv[1]), ctypes.byref(attrs), ctypes.byref(stamp), ctypes.sizeof(stamp), 0) != 0:
    raise OSError(ctypes.get_errno(), "setattrlist creation time")
`,
              affected,
              birth.toString(),
            ]);
          setBirth(0n);
          expect(statSync(affected).birthtimeMs).toBe(0);
          expect(statSync(harness.dir).birthtimeMs).toBeGreaterThan(0);
          if (kind === "unreadable file") chmodSync(target, 0o000);
          const stable = join(harness.dir, "Stable.md");
          writeFileSync(
            stable,
            readFileSync(stable, "utf8").replace(
              "stable body",
              "edited stable body",
            ),
          );
          try {
            const first = await harness.folder.scan();
            expect(first.ok && first.value.updated).toBe(1);
            await new Promise((resolve) => setTimeout(resolve, 6000));
            const held = await harness.folder.scan();
            const queued = await harness.folder.device().queue();
            expect(held.ok, JSON.stringify(held)).toBe(true);
            expect(queued.ok, JSON.stringify(queued)).toBe(true);
            expect(held.ok && held.value.deleted, JSON.stringify(queued)).toBe(
              0,
            );
            expect(
              queued.ok &&
                queued.value.filter((entry) => entry.kind === "delete_item"),
            ).toEqual([]);
            expect(first.ok && first.value.missing).toBe(0);
          } finally {
            if (kind === "unreadable file") chmodSync(target, 0o600);
            setBirth(originalBirth);
          }
          expect(readFileSync(target)).toEqual(bytes);
          const resumed = await harness.folder.scan();
          expect(resumed.ok && resumed.value.deleted).toBe(1);
          const queued = await harness.folder.device().queue();
          expect(
            queued.ok &&
              queued.value
                .filter((entry) => entry.kind === "delete_item")
                .map((entry) => entry.item_id),
          ).toEqual([missing]);
        },
      );
    },
  );

  /** Past the grace a missing file is journaled for (`folder-files/delete-grace`). */
  async function pastTheGrace(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 6_000));
  }

  /** The creates the server was sent from the `from`th request on. */
  function createsSince(
    server: ScriptedServer,
    from: number,
  ): Array<Record<string, unknown>> {
    return server.requests
      .slice(from)
      .filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      )
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }

  /** The deletes the server was sent for an item. */
  function deletesOf(server: ScriptedServer, id: string): number {
    return server.requests.filter(
      (request) =>
        request.method === "DELETE" && request.pathname === `/items/${id}`,
    ).length;
  }

  /**
   * Two folders on one Mac: one server, one registry, each folder with its
   * own settings, directory and store. The first holds `items`; the item
   * doors and the stream are the shared server's. `attachments` are
   * `attached-to` edges the server holds already, drawn on their sources.
   * `SAME_FOLDER` makes the second a directory following the first's folder.
   */
  async function onOneMac(
    label: string,
    first: FolderSettings,
    other: FolderSettings | typeof SAME_FOLDER,
    rows: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>,
    before?: (server: ScriptedServer) => void,
    attachments: WireEdgeOptions[] = [],
  ): Promise<{
    edges: EdgeDoor;
    door: FolderDoor;
    a: FolderHarness;
    b: FolderHarness;
  }> {
    const edges = new EdgeDoor();
    for (const edge of attachments) edges.hold(edge);
    const drawn = (item: WireItemOptions): WireItemOptions => {
      const own = attachments.filter((edge) => edge.from_id === item.id);
      return own.length === 0
        ? item
        : {
            ...item,
            edges: {
              "attached-to": { data: own.map(wireEdge), next_cursor: null },
            },
          };
    };
    harness = await folderHarness(`${label}-a`, {
      settings: first,
      items: Object.fromEntries(
        Object.entries(rows).map(([type, held]) => [
          type,
          held.map((row) => ({ ...row, item: drawn(row.item) })),
        ]),
      ),
      ...(attachments.length > 0
        ? { edges: { "attached-to": attachments } }
        : {}),
      events: [edges.stream()],
    });
    // Before the item doors, whose read would answer for any id.
    const otherRow =
      other === SAME_FOLDER
        ? harness.settings
        : scriptFolderItem(harness.server, other);
    before?.(harness.server);
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    second = await folderHarness(`${label}-b`, {
      sharing: { server: harness.server, key: KEY },
      folder: otherRow,
      registry: harness.registry,
    });
    return { edges, door: door!, a: harness, b: second };
  }

  it("lists the folders on the Mac in one registry", async () => {
    harness = await folderHarness("registry-one");
    second = await folderHarness("registry-two", {
      registry: harness.registry,
    });
    const listed = await harness.folder.list();
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    const entry = (h: FolderHarness): string =>
      `${realpathSync(h.dir)} ${h.settings.id}`;
    expect(
      listed.value.map((folder) => `${folder.dir} ${folder.folder}`).sort(),
      "the registry does not list every folder added on this Mac, so a move between two of them reads as a delete",
    ).toEqual([entry(harness), entry(second)].sort());
    const fromTheOther = await second.folder.list();
    expect(fromTheOther.ok && fromTheOther.value.length).toBe(2);

    // Another registry is another Mac: a folder there is not listed here.
    const elsewhere = await folderHarness("registry-other-mac", {
      sharing: { server: harness.server, key: KEY },
    });
    try {
      const there = await elsewhere.folder.list();
      expect(there.ok && there.value.map((folder) => folder.folder)).toEqual([
        elsewhere.settings.id,
      ]);
      const here = await harness.folder.list();
      expect(here.ok && here.value.length).toBe(2);

      // A folder whose directory is missing stays listed, since it cannot
      // be told from one renamed or unmounted, until it is removed.
      const gone = await folderHarness("registry-gone", {
        sharing: { server: harness.server, key: KEY },
        registry: harness.registry,
      });
      const three = await harness.folder.list();
      expect(three.ok && three.value.length).toBe(3);
      rmSync(join(gone.dir, ".."), { recursive: true, force: true });
      const kept = await harness.folder.list();
      expect(kept.ok && kept.value.length).toBe(3);
      expect((await gone.folder.remove()).ok).toBe(true);
      const dropped = await harness.folder.list();
      expect(
        dropped.ok && dropped.value.map((folder) => folder.folder).sort(),
        "a folder removed while its directory is missing is still listed",
      ).toEqual([harness.settings.id, second.settings.id].sort());
      expect(readFileSync(harness.registry, "utf8")).not.toContain(
        gone.settings.id,
      );
      await gone.stop();
    } finally {
      await elsewhere.stop();
    }

    // Removing one takes it off the list and leaves its files, and is
    // refused while a write waits, which would be lost with it.
    scriptFolderWrites(second);
    put(second, "kept.md", "---\ntitle: Kept\n---\nstays\n");
    expect((await second.folder.scan()).ok).toBe(true);
    const refused = await second.folder.remove();
    expect(
      refused.ok,
      "a folder was removed with a write waiting in its queue, which is lost with it",
    ).toBe(false);
    expect((await second.folder.push()).ok).toBe(true);
    const removed = await second.folder.remove();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    const after = await harness.folder.list();
    expect(after.ok && after.value.map((folder) => folder.folder)).toEqual([
      harness.settings.id,
    ]);
    expect(existsSync(join(second.dir, "kept.md"))).toBe(true);
    expect(existsSync(join(second.dir, ".marfa", "core.sqlite"))).toBe(false);
  });

  it("tells a copy into another folder from a move", async () => {
    const kept = "01a00000-0000-7000-8000-0000000015c1";
    const moving = "01a00000-0000-7000-8000-0000000015c2";
    const { a, b, edges } = await onOneMac(
      "copy-or-move",
      { query: { types: ["core.note"] } },
      // Its copy holds every note, and its query none of these.
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      {
        "core.note": [
          { item: { id: kept, properties: { title: "Kept", body: "k\n" } } },
          {
            item: { id: moving, properties: { title: "Moving", body: "m\n" } },
          },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    // A file that cannot carry an id moves by its identity.
    put(a, "Loose.txt", "loose words\n");
    expect((await a.folder.push()).ok).toBe(true);
    const loose = String(sentCreates(a)[0]?.id);
    copyFileSync(join(a.dir, "Kept.md"), join(b.dir, "Kept copy.md"));
    renameSync(join(a.dir, "Moving.md"), join(b.dir, "Moving.md"));
    renameSync(join(a.dir, "Loose.txt"), join(b.dir, "Loose.txt"));

    const from = b.server.requests.length;
    const pushed = await b.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const creates = createsSince(b.server, from);
    expect(
      creates.map((sent) => (sent.properties as { title?: string }).title),
      "a file moved from another folder became a new item, or a copy did not",
    ).toEqual(["Kept"]);
    expect(creates[0]?.id).not.toBe(kept);
    expect(
      idIn(b, "Kept copy.md"),
      "the copy kept the id of the file it was copied from, so two files edit one item",
    ).toBe(creates[0]?.id);
    expect(idIn(b, "Moving.md")).toBe(moving);
    expect(
      edges.placements(b.settings.id).get(moving),
      "the moved file is not its item's file in the folder it moved to",
    ).toBe("Moving.md");
    expect(edges.placements(b.settings.id).get(loose)).toBe("Loose.txt");

    // The folder it left finds both moved, and trashes nothing.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(2);
    expect(deletesOf(a.server, moving)).toBe(0);
    expect(deletesOf(a.server, loose)).toBe(0);
    expect(deletesOf(a.server, kept)).toBe(0);
  });

  it("makes a new item of a text note moved to another folder as Markdown, and keeps its words", async () => {
    const { a, b } = await onOneMac(
      "move-text-as-markdown",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.note"] } },
      { "core.note": [] },
    );
    put(a, "Loose.txt", "loose words\n");
    put(a, "Copied.txt", "copied words\n");
    expect((await a.folder.push()).ok).toBe(true);
    const notes = sentCreates(a).map((sent) => String(sent.id));
    expect(notes).toHaveLength(2);
    // Moved, the file keeps its identity; copied and deleted, its bytes.
    renameSync(join(a.dir, "Loose.txt"), join(b.dir, "Loose.md"));
    copyFileSync(join(a.dir, "Copied.txt"), join(b.dir, "Copied.md"));
    rmSync(join(a.dir, "Copied.txt"));

    const from = b.server.requests.length;
    const pushed = await b.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const creates = createsSince(b.server, from).sort((x, y) =>
      String((x.properties as { title?: string }).title).localeCompare(
        String((y.properties as { title?: string }).title),
      ),
    );
    expect(
      creates.map((sent) => [
        (sent.properties as { title?: string }).title,
        (sent.properties as { body?: string }).body,
      ]),
      "a file at a document name was taken for the note of the folder it left",
    ).toEqual([
      ["Copied", "copied words\n"],
      ["Loose", "loose words\n"],
    ]);
    for (const sent of creates) expect(notes).not.toContain(sent.id);

    // The folder it left sweeps its missing files: the words live on in the
    // new items, and a new item is never the one trashed.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    for (const sent of creates) {
      expect(deletesOf(a.server, String(sent.id))).toBe(0);
    }
    expect(readFileSync(join(b.dir, "Loose.md"), "utf8")).toContain(
      "loose words\n",
    );
    expect(readFileSync(join(b.dir, "Copied.md"), "utf8")).toContain(
      "copied words\n",
    );
  });

  it("keeps an unreadable file moved to another folder before its next scan", async () => {
    const moved = "01a00000-0000-7000-8000-0000000016f1";
    const gone = "01a00000-0000-7000-8000-0000000016f2";
    const { a, b } = await onOneMac(
      "unreadable-move",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          {
            item: {
              id: moved,
              properties: { title: "Moved", body: "original\n" },
            },
          },
          {
            item: {
              id: gone,
              properties: { title: "Gone", body: "deleted\n" },
            },
          },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const target = join(b.dir, "Moved.md");
    renameSync(join(a.dir, "Moved.md"), target);
    const before = readFileSync(target);
    rmSync(join(a.dir, "Gone.md"));
    chmodSync(target, 0o000);
    try {
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const held = await a.folder.push();
      expect(held.ok, JSON.stringify(held)).toBe(true);
      if (!held.ok) return;
      expect(deletesOf(a.server, moved)).toBe(0);
      expect(held.value.scan.trashed).toEqual([]);
      expect(held.value.scan.moved_away).toBe(1);
      expect(deletesOf(a.server, gone)).toBe(0);
      expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
        "Gone.md",
      ]);
    } finally {
      chmodSync(target, 0o600);
    }
    expect(readFileSync(target)).toEqual(before);
    // With a complete peer inventory, the genuinely missing file is deleted.
    const readable = await a.folder.push();
    expect(readable.ok, JSON.stringify(readable)).toBe(true);
    expect(deletesOf(a.server, moved)).toBe(0);
    expect(deletesOf(a.server, gone)).toBe(1);
  });

  it("does not trash a file moved to another folder", async () => {
    const moved = "01a00000-0000-7000-8000-0000000016d1";
    const deleted = "01a00000-0000-7000-8000-0000000016d2";
    const { a, b } = await onOneMac(
      "move-not-trash",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: moved, properties: { title: "Moved", body: "m\n" } } },
          {
            item: {
              id: deleted,
              properties: { title: "Deleted", body: "d\n" },
            },
          },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
    rmSync(join(a.dir, "Deleted.md"));

    // With no server to read its item from, the moved file waits rather
    // than becoming a new item.
    const early = await b.folder.scan();
    expect(early.ok, JSON.stringify(early)).toBe(true);
    if (!early.ok) return;
    expect(early.value.created).toBe(0);
    expect(early.value.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Moved.md", "waiting"],
    ]);

    // The folder it left looks on the disk, and does not wait for the
    // folder it went to to scan it.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      deletesOf(a.server, moved),
      "a file moved to another folder on the Mac was read as a delete, and its item trashed",
    ).toBe(0);
    expect(swept.value.scan.moved_away).toBe(1);
    // The witness: the same sweep trashes a file found nowhere.
    expect(deletesOf(a.server, deleted)).toBe(1);
    expect(swept.value.scan.trashed).toEqual(["Deleted.md"]);
    // Written anew here before the other folder takes it, the moved file
    // would read there as a copy.
    expect(swept.value.pull?.elsewhere).toBe(1);
    expect(
      swept.value.pull?.flagged.filter((file) => file.item === moved),
      "an item whose file is on its way to another folder was flagged as held back",
    ).toEqual([]);
    expect(existsSync(join(a.dir, "Moved.md"))).toBe(false);

    // Where it went, it is the same item.
    const taken = await b.folder.push();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect(sentCreates(b)).toEqual([]);
    writeFileSync(
      join(b.dir, "Moved.md"),
      read(b, "Moved.md").replace("m\n", "moved and edited\n"),
    );
    expect((await b.folder.push()).ok).toBe(true);
    const edits = sentUpdates(b).filter((sent) => sent.id === moved);
    expect(
      edits.map((sent) => (sent.body.properties as { body?: string }).body),
      "an edit of the moved file did not reach its item",
    ).toEqual(["moved and edited\n"]);
  });

  it("does not write back a file moved to another folder between a pass's scan and its pull", async () => {
    const { a, b } = await onOneMac(
      "pass-moved-away",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    put(a, "Moved.md", "---\ntitle: Moved\n---\nwords\n");
    expect((await a.folder.scan()).ok).toBe(true);
    expect((await a.folder.device().drain()).ok).toBe(true);
    const id = String(sentCreates(a)[0]?.id);
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));

    const pulled = await a.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      existsSync(join(a.dir, "Moved.md")),
      "the pull wrote a file moved to another folder back where it was, so the note is on the Mac twice",
    ).toBe(false);
    expect(pulled.value.unwritten).toBe(1);

    // The next pass journals it and writes nothing back. The file never
    // carried its id, so the folder it went to makes it a new item, and the
    // grace sweep settles the old one (`folder-files/delete-grace`).
    const left = await a.folder.push();
    expect(left.ok, JSON.stringify(left)).toBe(true);
    if (!left.ok) return;
    expect(left.value.scan.missing).toBe(1);
    expect(left.value.pull?.revived).toBe(0);
    expect(existsSync(join(a.dir, "Moved.md"))).toBe(false);
    expect((await b.folder.push()).ok).toBe(true);
    expect((await a.folder.push()).ok).toBe(true);
    expect(readdirSync(a.dir).filter((name) => name !== ".marfa")).toEqual([]);
    expect(readdirSync(b.dir).filter((name) => name !== ".marfa")).toEqual([
      "Moved.md",
    ]);
    expect(deletesOf(a.server, id)).toBe(0);
  });

  it("trashes a missing file found in no folder on the Mac, and says so", async () => {
    const gone = "01a00000-0000-7000-8000-0000000016e1";
    const alsoGone = "01a00000-0000-7000-8000-0000000016e2";
    const namesake = "01a00000-0000-7000-8000-0000000016e3";
    const { a, b } = await onOneMac(
      "trash-found-nowhere",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
          {
            item: {
              id: alsoGone,
              properties: { title: "Also gone", body: "a\n" },
            },
          },
        ],
        // Another folder's file of the same name is not the missing one.
        "core.bookmark": [
          {
            item: {
              id: namesake,
              type: "core.bookmark",
              properties: { title: "Gone", body: "g\n" },
            },
          },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    expect(existsSync(join(b.dir, "Gone.md"))).toBe(true);

    rmSync(join(a.dir, "Gone.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.scan();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.trashed).toEqual(["Gone.md"]);
    expect(swept.value.moved_away).toBe(0);
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, gone)).toBe(1);

    rmSync(join(a.dir, "Also gone.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const said = await a.folder.pushText();
    expect(said.ok, JSON.stringify(said)).toBe(true);
    expect(said.ok && said.value).toContain(
      "Also gone.md was found in no directory on this machine, so its item was trashed",
    );
    expect(deletesOf(a.server, alsoGone)).toBe(1);
  });

  it.each(["the folder it left", "the folder that holds it"])(
    "writes its own file of an item another folder keeps unmatched, and leaves that folder's file where it is, %s hearing first",
    async (first) => {
      const plan = {
        id: "01a00000-0000-7000-8000-0000000023a1",
        properties: { title: "Plan", body: "the plan\n" },
      };
      const gone = {
        id: "01a00000-0000-7000-8000-0000000023a2",
        properties: { title: "Gone", body: "deleted for real\n" },
      };
      const { a, b, edges } = await onOneMac(
        `kept-where-it-is-${first.split(" ").at(-1)!}`,
        { query: { types: ["core.note"], filter: 'tags contains "a"' } },
        { query: { types: ["core.note"], filter: 'tags contains "b"' } },
        {
          "core.note": [
            { item: plan, tags: ["a"] },
            { item: gone, tags: ["a"] },
          ],
        },
      );
      expect((await a.folder.push()).ok).toBe(true);
      expect((await b.folder.push()).ok).toBe(true);
      expect(existsSync(join(b.dir, "Plan.md"))).toBe(false);

      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "metadata.changed",
          wireItem(plan),
          { tags: ["b"] },
        ),
      );
      const leftFirst = first === "the folder it left";
      if (leftFirst) {
        const left = await a.folder.push();
        expect(left.ok && left.value.pull?.unmatched).toBe(1);
      }
      const holds = await b.folder.push();
      expect(holds.ok, JSON.stringify(holds)).toBe(true);
      if (!holds.ok) return;
      expect(
        holds.value.pull?.written,
        "the folder that holds the item wrote no file of its own",
      ).toBe(1);
      expect(idIn(b, "Plan.md")).toBe(plan.id);
      expect(sentCreates(b)).toEqual([]);
      expect(
        read(a, "Plan.md"),
        "the file of the folder the item left was moved or changed",
      ).toContain("the plan\n");
      expect(idIn(a, "Plan.md")).toBe(plan.id);

      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "item.updated",
          wireItem({
            ...plan,
            version: 2,
            properties: { title: "Plan", body: "changed elsewhere\n" },
          }),
          { tags: ["b"] },
        ),
      );
      const current = await b.folder.push();
      expect(current.ok && current.value.pull?.rewritten).toBe(1);
      expect(read(b, "Plan.md")).toContain("changed elsewhere\n");
      expect(edges.placements(b.settings.id).get(plan.id)).toBe("Plan.md");

      // Gone.md exercises the same deletion sweep.
      rmSync(join(a.dir, "Gone.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const swept = await a.folder.push();
      expect(swept.ok, JSON.stringify(swept)).toBe(true);
      if (!swept.ok) return;
      expect(deletesOf(a.server, gone.id)).toBe(1);
      expect(
        deletesOf(a.server, plan.id),
        "the folder the item left sent a delete for it",
      ).toBe(0);
      expect(
        existsSync(join(a.dir, "Plan.md")),
        "the folder the item left lost its file",
      ).toBe(true);
      expect(idIn(a, "Plan.md")).toBe(plan.id);
      const unmatched = await a.folder.unmatched();
      expect(
        unmatched.ok && unmatched.value.unmatched.map((file) => file.path),
      ).toEqual(["Plan.md"]);
      expect(edges.placements(a.settings.id).get(plan.id)).toBe("Plan.md");
      expect(read(b, "Plan.md")).toContain("changed elsewhere\n");
    },
  );

  it.each(["the first folder", "the second folder"])(
    "keeps both folders' files as unmatched when one change drops the item from both, %s pulling first",
    async (first) => {
      const plan = {
        id: "01a00000-0000-7000-8000-0000000023a8",
        properties: { title: "Plan", body: "the plan\n" },
      };
      const both = { types: ["core.note"], filter: 'tags contains "x"' };
      const { a, b, edges } = await onOneMac(
        `dropped-by-both-${first.split(" ")[1]!}`,
        { query: both },
        { query: both },
        { "core.note": [{ item: plan, tags: ["x"] }] },
      );
      expect((await a.folder.push()).ok).toBe(true);
      expect((await b.folder.push()).ok).toBe(true);

      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "metadata.changed",
          wireItem(plan),
          { tags: [] },
        ),
      );
      const order = first === "the first folder" ? [a, b] : [b, a];
      for (const folder of order) {
        const pushed = await folder.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
        if (!pushed.ok) return;
        expect(pushed.value.pull?.unmatched).toBe(1);
      }
      for (const folder of [a, b]) {
        expect(
          existsSync(join(folder.dir, "Plan.md")),
          "a folder removed its file because the other folder's copy still held the item",
        ).toBe(true);
        expect(read(folder, "Plan.md")).toContain("the plan");
        expect(idIn(folder, "Plan.md")).toBe(plan.id);
        const listed = await folder.folder.unmatched();
        expect(
          listed.ok && listed.value.unmatched.map((file) => file.path),
        ).toEqual(["Plan.md"]);
      }
      expect(deletesOf(a.server, plan.id)).toBe(0);
    },
  );

  it("keeps a departing file as unmatched beside another folder's file of the item until the person removes it", async () => {
    const brief = {
      id: "01a00000-0000-7000-8000-0000000023a9",
      properties: { title: "Brief", body: "the brief\n" },
    };
    const { a, b, edges } = await onOneMac(
      "kept-beside-other",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: brief, tags: ["a"] }] },
    );
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(brief),
        { tags: ["b"] },
      ),
    );
    const held = await b.folder.push();
    expect(held.ok && held.value.pull?.written).toBe(1);
    for (const pass of ["first", "second"]) {
      const left = await a.folder.push();
      expect(left.ok, JSON.stringify(left)).toBe(true);
      if (!left.ok) return;
      expect(
        existsSync(join(a.dir, "Brief.md")),
        `the ${pass} push removed the file because another folder holds the item`,
      ).toBe(true);
      expect(left.value.pull?.unmatched).toBe(1);
    }
    expect(read(a, "Brief.md")).toContain("the brief");
    expect(idIn(a, "Brief.md")).toBe(brief.id);
    expect(edges.placements(a.settings.id).get(brief.id)).toBe("Brief.md");

    const removed = await a.folder.removeUnmatched({ yes: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removed.map((file) => file.path)).toEqual([
      "Brief.md",
    ]);
    expect(existsSync(join(a.dir, "Brief.md"))).toBe(false);
    expect(read(b, "Brief.md")).toContain("the brief");
    expect(deletesOf(a.server, brief.id)).toBe(0);
  });

  it("ends a folder's placement of an item whose file the person moved to the folder that holds it, and keeps it for a file it keeps", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000023e1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const brief = {
      id: "01a00000-0000-7000-8000-0000000023e2",
      properties: { title: "Brief", body: "the brief\n" },
    };
    const { a, b, edges } = await onOneMac(
      "placement-ends",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      {
        "core.note": [
          { item: plan, tags: ["a"] },
          { item: brief, tags: ["a"] },
        ],
      },
    );
    const retag = (item: typeof plan) =>
      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "metadata.changed",
          wireItem(item),
          { tags: ["b"] },
        ),
      );
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    expect(edges.placements(a.settings.id)).toEqual(
      new Map([
        [plan.id, "Plan.md"],
        [brief.id, "Brief.md"],
      ]),
    );

    retag(plan);
    expect((await a.folder.push()).ok).toBe(true);
    expect(
      edges.placements(a.settings.id).has(plan.id),
      "the placement ended while the file still sat in the folder",
    ).toBe(true);
    const heard = await b.folder.device().catchUp();
    expect(heard.ok, JSON.stringify(heard)).toBe(true);
    renameSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    const moved = await b.folder.push();
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    expect([moved.value.scan.created, moved.value.pull?.written]).toEqual([
      0, 0,
    ]);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(
      edges.placements(a.settings.id).has(plan.id),
      "a folder went on placing an item whose file was moved to another folder",
    ).toBe(false);
    expect(edges.placements(b.settings.id).get(plan.id)).toBe("Plan.md");

    // The other way round: the folder holding the item writes its own file
    // first, and the folder it left keeps its file, and so its placement.
    retag(brief);
    expect((await b.folder.push()).ok).toBe(true);
    const stayed = await a.folder.push();
    expect(stayed.ok, JSON.stringify(stayed)).toBe(true);
    if (!stayed.ok) return;
    expect(stayed.value.pull?.ended).toBe(0);
    expect(
      edges.placements(a.settings.id),
      "a folder ended its placement of an item whose file it keeps",
    ).toEqual(new Map([[brief.id, "Brief.md"]]));
    expect(edges.placements(b.settings.id)).toEqual(
      new Map([
        [plan.id, "Plan.md"],
        [brief.id, "Brief.md"],
      ]),
    );
    expect(deletesOf(a.server, plan.id) + deletesOf(a.server, brief.id)).toBe(
      0,
    );
  });

  /** Two directories of one folder on the Mac, each with a file of `kept`
   *  and of `left`, which a narrowing to `vkeep` leaves out. */
  async function sameFolderTwice(label: string) {
    const kept = {
      id: "01a00000-0000-7000-8000-0000000023c1",
      properties: { title: "VA", body: "Keep me.\n" },
    };
    const left = {
      id: "01a00000-0000-7000-8000-0000000023c2",
      properties: { title: "VB", body: "Other.\n" },
    };
    const held = await onOneMac(
      label,
      { query: { types: ["core.note"], filter: 'tags contains "v1"' } },
      SAME_FOLDER,
      {
        "core.note": [
          { item: kept, tags: ["v1", "vkeep"] },
          { item: left, tags: ["v1"] },
        ],
      },
    );
    const { a, b, edges } = held;
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    for (const dir of [a.dir, b.dir]) {
      expect(existsSync(join(dir, "VA.md"))).toBe(true);
      expect(existsSync(join(dir, "VB.md"))).toBe(true);
    }
    const query = (filter: string) => {
      a.settings.settings = { query: { types: ["core.note"], filter } };
      a.settings.version += 1;
      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "item.updated",
          folderItem(a.settings),
        ),
      );
    };
    return { ...held, kept, left, query };
  }

  /** Pushes `folder` and asserts it kept `VB.md` as unmatched. */
  async function keptUnmatched(folder: FolderHarness, why: string) {
    const before = read(folder, "VB.md");
    const pushed = await folder.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(existsSync(join(folder.dir, "VB.md")), why).toBe(true);
    expect(read(folder, "VB.md")).toBe(before);
    expect(pushed.value.pull?.unmatched).toBe(1);
    const listed = await folder.folder.unmatched();
    expect(
      listed.ok && listed.value.unmatched.map((file) => file.path),
    ).toEqual(["VB.md"]);
  }

  it("keeps a file as unmatched in both directories of one folder when its query narrows", async () => {
    const { a, b, left, edges, query } = await sameFolderTwice(
      "same-folder-narrowed",
    );
    query('tags contains "vkeep"');
    await keptUnmatched(
      a,
      "the first directory to push took the file away, as if the other directory of the same folder were another folder taking it",
    );
    await keptUnmatched(b, "the second directory took the file away");
    await keptUnmatched(a, "a later push took the file away");
    expect(edges.placements(a.settings.id).get(left.id)).toBe("VB.md");
    expect(deletesOf(a.server, left.id)).toBe(0);
  });

  it("keeps a file as unmatched when its query narrows while the other directory of the folder cannot be read, and once it can", async () => {
    const { a, b, left, query } = await sameFolderTwice(
      "same-folder-unreadable",
    );
    query('tags contains "vkeep"');
    chmodSync(a.dir, 0o000);
    try {
      await keptUnmatched(
        b,
        "a directory took the file away while the other directory of its folder could not be read",
      );
    } finally {
      chmodSync(a.dir, 0o755);
    }
    // Readable again, the other directory has not read the narrowing yet.
    await keptUnmatched(
      b,
      "a directory took the file away once the other directory of its folder, not yet narrowed, could be read",
    );
    await keptUnmatched(a, "the other directory took the file away");
    expect(deletesOf(a.server, left.id)).toBe(0);
  });

  it("writes its own file, and leaves the other directory of the folder its file, when a widened query brings an item back", async () => {
    const { a, b, left, query } = await sameFolderTwice("same-folder-widened");
    query('tags contains "vkeep"');
    chmodSync(a.dir, 0o000);
    try {
      await keptUnmatched(b, "the directory took the file away");
    } finally {
      chmodSync(a.dir, 0o755);
    }
    await keptUnmatched(a, "the other directory took the file away");
    const removed = await a.folder.removeUnmatched({ yes: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(existsSync(join(a.dir, "VB.md"))).toBe(false);
    const theirs = read(b, "VB.md");

    query('tags contains "v1"');
    const widened = await a.folder.push();
    expect(widened.ok, JSON.stringify(widened)).toBe(true);
    if (!widened.ok) return;
    expect(widened.value.pull?.written).toBe(1);
    expect(idIn(a, "VB.md")).toBe(left.id);
    expect(
      existsSync(join(b.dir, "VB.md")),
      "the other directory of the same folder lost its file",
    ).toBe(true);
    expect(read(b, "VB.md")).toBe(theirs);
    const after = await b.folder.push();
    expect(after.ok, JSON.stringify(after)).toBe(true);
    expect(after.ok && after.value.pull?.unmatched).toBe(0);
    expect(idIn(b, "VB.md")).toBe(left.id);
    expect(sentCreates(a)).toEqual([]);
  });

  it.each([
    ["the same folder", SAME_FOLDER],
    ["another folder", "another"],
  ] as const)(
    "reads a file returned to a narrowed directory while a directory of %s has the item's file",
    async (_, kind) => {
      const kept = {
        id: "01a00000-0000-7000-8000-0000000023f5",
        properties: { title: "VA", body: "Keep me.\n" },
      };
      const left = {
        id: "01a00000-0000-7000-8000-0000000023f6",
        properties: { title: "VB", body: "Other.\n" },
      };
      const wide = { types: ["core.note"], filter: 'tags contains "v1"' };
      const { a, b, edges } = await onOneMac(
        `returned-${kind === SAME_FOLDER ? "same" : "other"}`,
        { query: wide },
        kind === SAME_FOLDER ? SAME_FOLDER : { query: wide },
        {
          "core.note": [
            { item: kept, tags: ["v1", "vkeep"] },
            { item: left, tags: ["v1"] },
          ],
        },
      );
      expect((await a.folder.push()).ok).toBe(true);
      expect((await b.folder.push()).ok).toBe(true);
      a.settings.settings = {
        query: { types: ["core.note"], filter: 'tags contains "vkeep"' },
      };
      a.settings.version += 1;
      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "item.updated",
          folderItem(a.settings),
        ),
      );
      expect((await a.folder.push()).ok).toBe(true);
      if (existsSync(join(a.dir, "VB.md"))) {
        const removed = await a.folder.removeUnmatched({ yes: true });
        expect(removed.ok, JSON.stringify(removed)).toBe(true);
      }
      expect(existsSync(join(a.dir, "VB.md"))).toBe(false);
      expect(idIn(b, "VB.md")).toBe(left.id);

      put(a, "VB.md", read(b, "VB.md").replace("Other.", "Other, returned."));
      const returned = await a.folder.push();
      expect(returned.ok, JSON.stringify(returned)).toBe(true);
      const titles = sentCreates(a).map(
        (sent) => (sent.properties as Record<string, unknown>).title,
      );
      if (kind === SAME_FOLDER) {
        expect(
          titles,
          "a file returned to a directory was made a second item because another directory of its folder had the item's file",
        ).not.toContain("VB");
        expect(sentUpdates(a).map((sent) => sent.id)).toContain(left.id);
        expect(idIn(a, "VB.md")).toBe(left.id);
      } else {
        expect(titles).toContain("VB");
        expect(idIn(a, "VB.md")).not.toBe(left.id);
      }
      expect(idIn(b, "VB.md")).toBe(left.id);
    },
  );

  it("keeps a file moved to a folder that does not hold its item there, unmatched, and the folder it left writes its file again and keeps its placement", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000023f1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const gone = {
      id: "01a00000-0000-7000-8000-0000000023f2",
      properties: { title: "Gone", body: "deleted for real\n" },
    };
    const { a, b, door, edges } = await onOneMac(
      "placement-kept-on-move",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      {
        "core.note": [
          { item: plan, tags: ["a"] },
          { item: gone, tags: ["a"] },
        ],
      },
    );
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    const moved = read(a, "Plan.md");
    renameSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    // Gone.md exercises the same deletion sweep.
    rmSync(join(a.dir, "Gone.md"));
    const kept = await b.folder.push();
    expect(kept.ok && kept.value.pull?.unmatched).toBe(1);
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(deletesOf(a.server, gone.id)).toBe(1);
    expect(
      swept.value.pull?.written,
      "the folder the file left wrote no file of the item it holds",
    ).toBe(1);
    expect(idIn(a, "Plan.md")).toBe(plan.id);
    expect(read(a, "Plan.md")).toContain("the plan\n");
    expect(
      edges.placements(a.settings.id).get(plan.id),
      "a folder ended its placement of an item its own query still holds",
    ).toBe("Plan.md");

    // The file stays where the person put it, unmatched there.
    const again = await b.folder.push();
    expect(again.ok && again.value.pull?.unmatched).toBe(1);
    expect(
      read(b, "Plan.md"),
      "the file the person moved was moved back, changed or removed",
    ).toBe(moved);
    const unmatched = await b.folder.unmatched();
    expect(
      unmatched.ok && unmatched.value.unmatched.map((file) => file.path),
    ).toEqual(["Plan.md"]);
    expect(
      deletesOf(a.server, plan.id) + deletesOf(b.server, plan.id),
      "a folder sent a delete of the item whose file the person moved",
    ).toBe(0);
    // The scripted server drops an item it is sent a delete of.
    expect(door.rows.has(gone.id)).toBe(false);
    expect(door.rows.get(plan.id)?.properties.body).toBe("the plan\n");
  });

  it("takes no file back by its bytes for an item another folder on the Mac holds a file of", async () => {
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x23, 0xc1,
    ]);
    const photo = {
      id: "01a00000-0000-7000-8000-0000000023c1",
      type: "core.file.image",
      properties: {
        title: "photo.png",
        blob_ref: hashOf(bytes),
        mime_type: "image/png",
      },
    };
    const { a, b, edges } = await onOneMac(
      "bytes-moved",
      { query: { types: ["core.file.image"], filter: 'tags contains "a"' } },
      { query: { types: ["core.file.image"], filter: 'tags contains "b"' } },
      { "core.file.image": [{ item: photo, tags: ["a"] }] },
      (server) => {
        scriptBlob(server, bytes);
        acceptUploads(server);
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect(readFileSync(join(a.dir, "photo.png"))).toEqual(bytes);
    expect((await a.folder.push()).ok).toBe(true);
    expect(edges.placements(a.settings.id).get(photo.id)).toBe("photo.png");

    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(photo),
        { tags: ["b"] },
      ),
    );
    expect((await a.folder.push()).ok).toBe(true);
    const wrote = await b.folder.push();
    expect(wrote.ok && wrote.value.pull?.written, JSON.stringify(wrote)).toBe(
      1,
    );
    rmSync(join(a.dir, "photo.png"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok && swept.value.scan.moved_away).toBe(1);
    expect(
      edges.placements(a.settings.id).has(photo.id),
      "the first folder went on placing an item whose file it no longer has",
    ).toBe(false);
    const creates = sentCreates(a).length;

    copyFileSync(join(b.dir, "photo.png"), join(a.dir, "photo.png"));
    const copied = await a.folder.push();
    expect(copied.ok, JSON.stringify(copied)).toBe(true);
    if (!copied.ok) return;
    expect(
      sentCreates(a).length - creates,
      "a copy of another folder's file was taken as that item's file here",
    ).toBe(1);
  });

  it.each([
    { mode: "already-present", previous: false },
    { mode: "already-present", previous: true },
    { mode: "appearing", previous: false },
    { mode: "appearing", previous: true },
  ])(
    "adopts the item's own bytes at its path, and keeps a previous file's delete, while another folder keeps its file ($mode, previous file $previous)",
    async ({ mode, previous }) => {
      // The bytes the fault `create-before-rename` writes.
      const bytes = Buffer.from("appeared meanwhile\n");
      const photo = {
        id: "01a00000-0000-7000-8000-0000000023e1",
        type: "core.file.image",
        properties: {
          title: "photo.png",
          blob_ref: hashOf(bytes),
          mime_type: "image/png",
        },
      };
      const gone = { ...photo, id: "01a00000-0000-7000-8000-0000000023e2" };
      const { a, b, edges } = await onOneMac(
        "identical-destination",
        { query: { types: ["core.file.image"], filter: 'tags contains "a"' } },
        {
          query: {
            types: ["core.file.image"],
            filter: 'tags contains "b"',
            state: ["active"],
          },
        },
        {
          "core.file.image": [
            { item: photo, tags: ["a"] },
            ...(previous ? [{ item: gone, tags: ["b"] }] : []),
          ],
        },
        (server) => {
          scriptBlob(server, bytes);
          acceptUploads(server);
        },
      );
      expect((await a.folder.pull()).ok).toBe(true);
      expect((await b.folder.pull()).ok).toBe(true);
      if (previous) {
        expect(readFileSync(join(b.dir, "photo.png"))).toEqual(bytes);
        rmSync(join(b.dir, "photo.png"));
        const journaled = await b.folder.scan();
        expect(journaled.ok && journaled.value.missing).toBe(1);
        edges.events.push(
          copyItemEvent(
            String(edges.events.length + 2),
            "item.state_changed",
            wireItem({ ...gone, state: "archived" }),
            { tags: ["b"] },
          ),
        );
      }
      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "metadata.changed",
          wireItem(photo),
          { tags: ["b"] },
        ),
      );
      expect((await a.folder.push()).ok).toBe(true);
      expect((await b.folder.device().catchUp()).ok).toBe(true);
      if (mode === "already-present")
        writeFileSync(join(b.dir, "photo.png"), bytes);
      if (mode === "appearing") {
        const raced = await withFault("create-before-rename=photo.png", () =>
          b.folder.pull(),
        );
        expect(raced.ok, JSON.stringify(raced)).toBe(true);
        expect(
          raced.ok && [raced.value.unwritten, raced.value.unchanged],
        ).toEqual([1, 0]);
        const failed = await b.folder.status();
        expect(
          failed.ok &&
            failed.value.files.find((file) => file.path === "photo.png")
              ?.item_id,
        ).toBe(previous ? gone.id : undefined);
      }
      const pulled = await b.folder.pull();
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      expect(
        pulled.ok && [pulled.value.unwritten, pulled.value.unchanged],
      ).toEqual([0, 1]);
      expect(readFileSync(join(a.dir, "photo.png"))).toEqual(bytes);
      expect(readFileSync(join(b.dir, "photo.png"))).toEqual(bytes);
      const status = await b.folder.status();
      expect(
        status.ok &&
          status.value.files.find((file) => file.path === "photo.png")?.item_id,
      ).toBe(photo.id);
      await pastTheGrace();
      expect((await b.folder.scan()).ok).toBe(true);
      const queued = await b.folder.device().queue();
      expect(
        queued.ok &&
          queued.value
            .filter((row) => row.kind === "delete_item")
            .map((row) => row.item_id),
      ).toEqual(previous ? [gone.id] : []);
    },
  );

  it.each(["attached to", "embedded in"])(
    "keeps a file %s a note while another folder on the Mac holds the file, and writes nothing again",
    async (kind) => {
      const bytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x23, 0xd1,
      ]);
      const host = {
        id: "01a00000-0000-7000-8000-0000000023d1",
        properties: {
          title: "Host",
          body: kind === "embedded in" ? "![](scan.png)\n" : "no picture\n",
        },
      };
      const scan = {
        id: "01a00000-0000-7000-8000-0000000023d2",
        type: "core.file.image",
        properties: {
          title: "scan.png",
          blob_ref: hashOf(bytes),
          mime_type: "image/png",
        },
      };
      const { a, b } = await onOneMac(
        `attachment-held-elsewhere-${kind.split(" ")[0]!}`,
        { query: { types: ["core.note"] } },
        { query: { types: ["core.file"] } },
        { "core.note": [{ item: host }], "core.file": [{ item: scan }] },
        (server) => scriptBlob(server, bytes),
        [
          {
            id: "01a00000-0000-7000-8000-0000000023d3",
            from_id: scan.id,
            to_id: host.id,
            edge_type: "attached-to",
          },
        ],
      );
      expect((await a.folder.pull()).ok).toBe(true);
      const other = await b.folder.pull();
      expect(other.ok, JSON.stringify(other)).toBe(true);
      if (!other.ok) return;
      expect(other.value.written).toBe(1);
      for (const made of [a, b]) {
        expect(readFileSync(join(made.dir, "scan.png"))).toEqual(bytes);
      }
      for (const pass of ["second", "third"]) {
        const again = await a.folder.pull();
        expect(again.ok, JSON.stringify(again)).toBe(true);
        if (!again.ok) return;
        expect(
          [again.value.ended, again.value.written],
          `the ${pass} pull ended a placement or wrote a file again`,
        ).toEqual([0, 0]);
      }
      expect(readFileSync(join(a.dir, "scan.png"))).toEqual(bytes);
    },
  );

  it.each(["the folder it left", "the folder it moved to"])(
    "writes a note and its attachment of its own when the note moves to another notes folder, and the folder it left keeps both, %s hearing first",
    async (first) => {
      const bytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x23, 0xd4,
      ]);
      const plan = {
        id: "01a00000-0000-7000-8000-0000000023d4",
        properties: { title: "Plan", body: "the plan\n" },
      };
      const scan = {
        id: "01a00000-0000-7000-8000-0000000023d5",
        type: "core.file.image",
        properties: {
          title: "scan.png",
          blob_ref: hashOf(bytes),
          mime_type: "image/png",
        },
      };
      const { a, b, edges } = await onOneMac(
        `attachment-moves-with-note-${first.split(" ").at(-1)!}`,
        { query: { types: ["core.note"], filter: 'tags contains "a"' } },
        { query: { types: ["core.note"], filter: 'tags contains "b"' } },
        {
          "core.note": [{ item: plan, tags: ["a"] }],
          "core.file": [{ item: scan }],
        },
        (server) => scriptBlob(server, bytes),
        [
          {
            id: "01a00000-0000-7000-8000-0000000023d6",
            from_id: scan.id,
            to_id: plan.id,
            edge_type: "attached-to",
          },
        ],
      );
      expect((await a.folder.pull()).ok).toBe(true);
      expect((await b.folder.pull()).ok).toBe(true);
      expect(readFileSync(join(a.dir, "scan.png"))).toEqual(bytes);

      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "metadata.changed",
          wireItem(plan),
          { tags: ["b"] },
        ),
      );
      const leftFirst = first === "the folder it left";
      if (leftFirst) expect((await a.folder.push()).ok).toBe(true);
      const wrote = await b.folder.push();
      expect(wrote.ok, JSON.stringify(wrote)).toBe(true);
      if (!wrote.ok) return;
      expect(
        wrote.value.pull?.written,
        "the folder the note moved to wrote the note without its attachment",
      ).toBe(2);
      expect(readFileSync(join(b.dir, "scan.png"))).toEqual(bytes);
      expect(idIn(b, "Plan.md")).toBe(plan.id);
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      for (const pass of ["first", "second"]) {
        const left = await a.folder.push();
        expect(left.ok, JSON.stringify(left)).toBe(true);
        if (!left.ok) return;
        expect(
          [left.value.pull?.unmatched, left.value.pull?.written],
          `past the grace, the ${pass} pass of the folder the note left`,
        ).toEqual([1, 0]);
      }
      expect(readFileSync(join(a.dir, "scan.png"))).toEqual(bytes);
      expect(idIn(a, "Plan.md")).toBe(plan.id);
    },
  );

  it("keeps a file saved back where the person moved the item's file to another folder from as the item's while its binding lasts", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000023b1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const { a, b, edges } = await onOneMac(
      "saved-back",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: plan, tags: ["a"] }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const held = read(a, "Plan.md");
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(plan),
        { tags: ["b"] },
      ),
    );
    expect((await a.folder.push()).ok).toBe(true);
    const heard = await b.folder.device().catchUp();
    expect(heard.ok, JSON.stringify(heard)).toBe(true);
    renameSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    const moved = await b.folder.push();
    expect(moved.ok && moved.value.scan.created).toBe(0);
    expect(idIn(b, "Plan.md")).toBe(plan.id);

    // An editor that held the file saves it back, inside the grace: the
    // binding of that path still names the item.
    const scanned = await a.folder.scan();
    expect(scanned.ok && scanned.value.missing).toBe(1);
    writeFileSync(
      join(a.dir, "Plan.md"),
      held.replace("the plan\n", "saved back\n"),
    );
    const creates = sentCreates(a).length;
    const pushed = await a.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.created,
      "a file saved back while its binding lasted was read as a copy",
    ).toBe(0);
    expect(sentCreates(a)).toHaveLength(creates);
    expect(
      sentUpdates(a).map((sent) => sent.id),
      "the saved-back file's edit did not reach the item",
    ).toContain(plan.id);
  });

  it("does not take another folder's file with the same bytes for a moved one", async () => {
    const { a, b } = await onOneMac(
      "same-bytes",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    put(a, "Loose.txt", "shared words\n");
    expect((await a.folder.push()).ok).toBe(true);
    const loose = String(sentCreates(a)[0]?.id);
    // Its own item in the other folder, with the same bytes.
    put(b, "Unrelated.txt", "shared words\n");
    expect((await b.folder.push()).ok).toBe(true);
    expect(sentCreates(a)).toHaveLength(2);

    // And a copy of that one it has not scanned: bytes it knows as another item.
    put(b, "Unrelated copy.txt", "shared words\n");

    rmSync(join(a.dir, "Loose.txt"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      deletesOf(a.server, loose),
      "a file with the same bytes that another folder holds as its own item was taken for the deleted one moved",
    ).toBe(1);
    expect(swept.value.scan.trashed).toEqual(["Loose.txt"]);
    expect(existsSync(join(a.dir, "Loose.txt"))).toBe(false);
  });

  it("holds a delete while the registry cannot be read, and an add writes it afresh", async () => {
    const gone = "01a00000-0000-7000-8000-0000000038b1";
    let third: FolderItem | undefined;
    const { a } = await onOneMac(
      "unreadable-registry",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
        ],
      },
      (server) => {
        third = scriptFolderItem(server, { query: { types: ["core.note"] } });
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    writeFileSync(a.registry, "");

    const plain = await a.folder.push();
    expect(
      plain.ok,
      `a registry that cannot be read stopped the folder: ${JSON.stringify(plain)}`,
    ).toBe(true);
    if (!plain.ok) return;
    expect(plain.value.scan.registry).toMatch(/cannot be read/);
    rmSync(join(a.dir, "Gone.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const held = await a.folder.push();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect(
      deletesOf(a.server, gone),
      "with no other folder to look in, a missing file was trashed, where it may have moved to one",
    ).toBe(0);
    expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
      "Gone.md",
    ]);
    const said = await a.folder.pushText();
    expect(said.ok && said.value).toContain(
      "this directory stands alone, since the folder registry cannot be read",
    );

    // An add writes it afresh, the others list themselves again at their
    // next pass, and the held delete goes.
    const added = await folderHarness("unreadable-registry-c", {
      sharing: { server: a.server, key: KEY },
      folder: third,
      registry: a.registry,
    });
    try {
      const listed = await added.folder.list();
      expect(listed.ok && listed.value.map((entry) => entry.folder)).toEqual([
        added.settings.id,
      ]);
      const swept = await a.folder.push();
      expect(swept.ok, JSON.stringify(swept)).toBe(true);
      if (!swept.ok) return;
      expect(swept.value.scan.registry).toBeNull();
      expect(swept.value.scan.trashed).toEqual(["Gone.md"]);
      expect(deletesOf(a.server, gone)).toBe(1);
    } finally {
      await added.stop();
    }
  });

  it("writes no file back for a held delete when another device changes its item", async () => {
    const held = {
      id: "01a00000-0000-7000-8000-0000000038c1",
      properties: { title: "Held", body: "h\n" },
    };
    const graced = {
      id: "01a00000-0000-7000-8000-0000000038c2",
      properties: { title: "Graced", body: "g\n" },
    };
    const restored = {
      id: "01a00000-0000-7000-8000-0000000038c3",
      properties: { title: "Restored", body: "r\n" },
    };
    const { a, edges } = await onOneMac(
      "held-no-write",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      { "core.note": [{ item: held }, { item: graced }, { item: restored }] },
    );
    const changeElsewhere = (...items: Array<typeof held>): void => {
      for (const item of items) {
        edges.events.push(
          copyItemEvent(
            String(edges.events.length + 2),
            "item.updated",
            wireItem({
              ...item,
              version: 2,
              properties: { ...item.properties, body: "their edit\n" },
            }),
          ),
        );
      }
    };
    expect((await a.folder.pull()).ok).toBe(true);

    // The witness: where the move can be told, the same change writes a
    // file deleted inside the grace back (`folder-files/delete-remote-revives`).
    rmSync(join(a.dir, "Restored.md"));
    expect((await a.folder.push()).ok).toBe(true);
    changeElsewhere(restored);
    const told = await a.folder.device().catchUp();
    expect(told.ok && told.value.applied).toBe(1);
    expect((await a.folder.push()).ok).toBe(true);
    expect(read(a, "Restored.md")).toContain("their edit");

    writeFileSync(a.registry, "");
    expect((await a.folder.push()).ok).toBe(true);
    rmSync(join(a.dir, "Held.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const holding = await a.folder.push();
    expect(holding.ok, JSON.stringify(holding)).toBe(true);
    if (!holding.ok) return;
    expect(holding.value.scan.unsure.map((file) => file.path)).toEqual([
      "Held.md",
    ]);

    // Inside the grace, the move cannot be told either.
    rmSync(join(a.dir, "Graced.md"));
    expect((await a.folder.push()).ok).toBe(true);
    changeElsewhere(held, graced);
    const heard = await a.folder.device().catchUp();
    expect(heard.ok && heard.value.applied).toBe(2);
    const pulled = await a.folder.push();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.scan.unsure.map((file) => file.path)).toEqual([
      "Held.md",
    ]);
    for (const name of ["Held.md", "Graced.md"]) {
      expect(
        existsSync(join(a.dir, name)),
        `${name}, whose move cannot be told, was written back, so a folder it may have moved to reads it as a copy`,
      ).toBe(false);
    }
    expect(pulled.value.pull?.revived).toBe(0);
    expect(deletesOf(a.server, held.id)).toBe(0);
  });

  it("makes no second item when another device changes a moved file's item inside the grace", async () => {
    const moved = {
      id: "01a00000-0000-7000-8000-0000000043a1",
      properties: { title: "Moved", body: "the person's words\n" },
    };
    const { a, b, door, edges } = await onOneMac(
      "move-changed-elsewhere",
      { query: { types: ["core.note"] } },
      // Its copy holds the note, and its query does not.
      { query: { types: ["core.bookmark"] } },
      { "core.note": [{ item: moved }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
    const journaled = await a.folder.push();
    expect(journaled.ok, JSON.stringify(journaled)).toBe(true);
    if (!journaled.ok) return;
    expect(journaled.value.scan.missing).toBe(1);

    edges.logItem(
      "item.updated",
      door.update(moved.id, {
        properties: { notes: "their annotation" },
        version: 1,
      }),
    );
    const heard = await a.folder.device().catchUp();
    expect(heard.ok && heard.value.applied).toBe(1);
    const pulled = await a.folder.push();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      existsSync(join(a.dir, "Moved.md")),
      "the folder a file moved out of wrote it back from another device's change, so the moved file reads as a copy where it went",
    ).toBe(false);
    expect(pulled.value.pull?.revived).toBe(0);
    expect(pulled.value.pull?.elsewhere).toBe(1);

    writeFileSync(
      join(b.dir, "Moved.md"),
      read(b, "Moved.md").replace(
        "the person's words\n",
        "the person's words, edited where they went\n",
      ),
    );
    const from = b.server.requests.length;
    const taken = await b.folder.push();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect(
      createsSince(b.server, from),
      "the moved file became a second item",
    ).toEqual([]);
    expect(idIn(b, "Moved.md")).toBe(moved.id);
    expect(
      door.rows.get(moved.id)?.properties,
      "the item lost the person's edit or the other device's change",
    ).toMatchObject({
      body: "the person's words, edited where they went\n",
      notes: "their annotation",
    });

    // Past the grace, the folder it left finds it moved and trashes nothing,
    // and neither folder makes another item of it.
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(deletesOf(a.server, moved.id)).toBe(0);
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    expect(createsSince(a.server, from)).toEqual([]);
    expect(
      [...door.rows.values()].filter((row) => row.type === "core.note"),
    ).toHaveLength(1);
  });

  it("keeps one item, and every edit made before and after the move, of a bound file moved to another folder", async () => {
    const note = {
      id: "01a00000-0000-7000-8000-0000000043c1",
      properties: { title: "Moved", body: "the person's words\n" },
    };
    const { a, b, door } = await onOneMac(
      "move-keeps-edits",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      { "core.note": [{ item: note }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    // A note at a name that cannot carry an id follows by its identity.
    put(a, "Loose.txt", "loose words\n");
    expect((await a.folder.push()).ok).toBe(true);
    const loose = String(sentCreates(a)[0]?.id);

    // Edited, not yet scanned or sent, and then moved.
    writeFileSync(
      join(a.dir, "Moved.md"),
      read(a, "Moved.md").replace("words\n", "words, edited before the move\n"),
    );
    writeFileSync(join(a.dir, "Loose.txt"), "loose words, edited before\n");
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
    renameSync(join(a.dir, "Loose.txt"), join(b.dir, "Loose.txt"));

    const from = b.server.requests.length;
    const taken = await b.folder.push();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect(
      createsSince(b.server, from),
      "a bound file moved to another folder became a second item",
    ).toEqual([]);
    expect(idIn(b, "Moved.md")).toBe(note.id);
    expect(door.rows.get(note.id)?.properties.body).toBe(
      "the person's words, edited before the move\n",
    );
    expect(door.rows.get(loose)?.properties.body).toBe(
      "loose words, edited before\n",
    );

    // Edited again where it went.
    writeFileSync(
      join(b.dir, "Moved.md"),
      read(b, "Moved.md").replace(
        "before the move",
        "before the move and after",
      ),
    );
    writeFileSync(join(b.dir, "Loose.txt"), "loose words, edited after\n");
    expect((await b.folder.push()).ok).toBe(true);
    expect(door.rows.get(note.id)?.properties.body).toBe(
      "the person's words, edited before the move and after\n",
    );
    expect(door.rows.get(loose)?.properties.body).toBe(
      "loose words, edited after\n",
    );

    // Past the grace the folder it left trashes nothing and makes nothing.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(2);
    expect(deletesOf(a.server, note.id)).toBe(0);
    expect(deletesOf(a.server, loose)).toBe(0);
    expect((await b.folder.push()).ok).toBe(true);
    expect(createsSince(a.server, from)).toEqual([]);
    expect(
      [...door.rows.values()].filter((row) => row.type === "core.note"),
    ).toHaveLength(2);
  });

  it("keeps an edit already queued in the folder a bound file left, and makes no item for the move", async () => {
    const note = {
      id: "01a00000-0000-7000-8000-0000000043c2",
      properties: { title: "Queued", body: "the person's words\n" },
    };
    const { a, b, door } = await onOneMac(
      "move-keeps-queued-edit",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      { "core.note": [{ item: note }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    // The scan reads the edit and queues it; nothing sends it before the move.
    writeFileSync(
      join(a.dir, "Queued.md"),
      read(a, "Queued.md").replace("words\n", "words, edited and queued\n"),
    );
    expect((await a.folder.scan()).ok).toBe(true);
    renameSync(join(a.dir, "Queued.md"), join(b.dir, "Queued.md"));

    const from = b.server.requests.length;
    expect((await b.folder.push()).ok).toBe(true);
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    expect(
      createsSince(b.server, from),
      "a bound file moved to another folder became a second item",
    ).toEqual([]);
    expect(deletesOf(a.server, note.id)).toBe(0);
    expect(
      door.rows.get(note.id)?.properties.body,
      "the edit the folder had queued when the file moved was lost",
    ).toBe("the person's words, edited and queued\n");
    // The edit queued in the folder it left is sent beside the receiving
    // folder's own copy of it, from the same version, so the server keeps
    // the later of the two as a conflicted copy of the item. The move itself
    // makes no item.
    const others = [...door.rows.entries()].filter(
      ([id, row]) => row.type === "core.note" && id !== note.id,
    );
    for (const [, row] of others) {
      expect(row.tags).toEqual(["conflicted-copy"]);
      expect(row.derivedFrom?.target).toBe(note.id);
    }
  });

  it("makes a second item of a new note moved before its id line is written, and keeps its edits", async () => {
    const { a, b } = await onOneMac(
      "move-new-note",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    put(a, "Fresh.md", "---\ntitle: Fresh\n---\nfresh words\n");
    expect((await a.folder.scan()).ok).toBe(true);
    expect((await a.folder.device().drain()).ok).toBe(true);
    const original = String(sentCreates(a)[0]?.id);
    expect(
      /marfa_id/.test(read(a, "Fresh.md")),
      "the id line was written before the move, so the file is no longer new",
    ).toBe(false);
    renameSync(join(a.dir, "Fresh.md"), join(b.dir, "Fresh.md"));
    writeFileSync(
      join(b.dir, "Fresh.md"),
      "---\ntitle: Fresh\n---\nfresh words, edited after the move\n",
    );

    const from = b.server.requests.length;
    expect((await b.folder.push()).ok).toBe(true);
    const creates = createsSince(b.server, from);
    expect(
      creates.map((sent) => (sent.properties as { body?: string }).body),
      "the edit was not kept in the item the receiving folder made",
    ).toEqual(["fresh words, edited after the move\n"]);
    expect(creates[0]?.id).not.toBe(original);

    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(
      deletesOf(a.server, original),
      "the note the person moved was trashed with its edits",
    ).toBe(0);
    expect(
      createsSince(a.server, 0).map((sent) => sent.id),
      "the moved note did not end as two items",
    ).toEqual([original, creates[0]?.id]);
    expect(readFileSync(join(b.dir, "Fresh.md"), "utf8")).toContain(
      "fresh words, edited after the move\n",
    );
  });

  it("still writes back a file deleted where both folders hold its item when another device changes it", async () => {
    const shared = {
      id: "01a00000-0000-7000-8000-0000000043b1",
      properties: { title: "Shared", body: "both folders' words\n" },
    };
    const { a, b, door, edges } = await onOneMac(
      "two-files-changed-elsewhere",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.note"] } },
      { "core.note": [{ item: shared }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    expect(idIn(b, "Shared.md")).toBe(shared.id);
    rmSync(join(a.dir, "Shared.md"));
    const journaled = await a.folder.push();
    expect(journaled.ok && journaled.value.scan.missing).toBe(1);

    edges.logItem(
      "item.updated",
      door.update(shared.id, {
        properties: { notes: "their annotation" },
        version: 1,
      }),
    );
    const heard = await a.folder.device().catchUp();
    expect(heard.ok && heard.value.applied).toBe(1);
    const from = a.server.requests.length;
    const pulled = await a.folder.push();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    // The other folder's file of the item is its own, not this one moved.
    expect(
      pulled.value.pull?.revived,
      "a file deleted where both folders hold its item was not written back from another device's change",
    ).toBe(1);
    expect(read(a, "Shared.md")).toContain("their annotation");
    expect(idIn(a, "Shared.md")).toBe(shared.id);

    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, shared.id)).toBe(0);
    expect(createsSince(a.server, from)).toEqual([]);
  });

  it("writes back no file moved to a folder it cannot read when another device changes its item inside the grace", async () => {
    const moved = {
      id: "01a00000-0000-7000-8000-0000000043c1",
      properties: { title: "Moved", body: "the person's words\n" },
    };
    const { a, b, door, edges } = await onOneMac(
      "move-unreadable-changed-elsewhere",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      { "core.note": [{ item: moved }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
    chmodSync(b.dir, 0o000);
    try {
      const journaled = await a.folder.push();
      expect(journaled.ok && journaled.value.scan.missing).toBe(1);
      edges.logItem(
        "item.updated",
        door.update(moved.id, {
          properties: { notes: "their annotation" },
          version: 1,
        }),
      );
      const heard = await a.folder.device().catchUp();
      expect(heard.ok && heard.value.applied).toBe(1);
      const pulled = await a.folder.push();
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      if (!pulled.ok) return;
      expect(
        existsSync(join(a.dir, "Moved.md")),
        "a missing file was written back while the folder it may have moved to could not be read",
      ).toBe(false);
      expect(pulled.value.pull?.revived).toBe(0);
    } finally {
      chmodSync(b.dir, 0o755);
    }

    // Readable again, the folder it went to takes it as the item.
    const from = b.server.requests.length;
    expect((await a.folder.push()).ok).toBe(true);
    expect(existsSync(join(a.dir, "Moved.md"))).toBe(false);
    const taken = await b.folder.push();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect(createsSince(b.server, from)).toEqual([]);
    expect(idIn(b, "Moved.md")).toBe(moved.id);
    expect(door.rows.get(moved.id)?.properties).toMatchObject({
      body: "the person's words\n",
      notes: "their annotation",
    });
  });

  it("writes back a file deleted while another folder could not be read, once that folder holds no copy, when another device changed its item inside the grace", async () => {
    const changed = {
      id: "01a00000-0000-7000-8000-0000000043d1",
      properties: { title: "Changed", body: "the person's words\n" },
    };
    const plain = {
      id: "01a00000-0000-7000-8000-0000000043d2",
      properties: { title: "Plain", body: "p\n" },
    };
    const before = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3,
    ]);
    const after = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4,
    ]);
    const photo = "01a00000-0000-7000-8000-0000000043d3";
    const { a, b, door, edges } = await onOneMac(
      "delete-unreadable-changed-elsewhere",
      { query: { types: ["core.note", "core.file"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [{ item: changed }, { item: plain }],
        "core.file": [
          {
            item: {
              id: photo,
              type: "core.file.image",
              properties: {
                title: "photo.png",
                blob_ref: hashOf(before),
                mime_type: "image/png",
              },
            },
          },
        ],
      },
    );
    scriptBlob(a.server, before);
    scriptBlob(a.server, after);
    expect((await a.folder.pull()).ok).toBe(true);
    const names = ["Changed.md", "Plain.md", "photo.png"];
    for (const name of names) {
      rmSync(join(a.dir, name));
    }
    chmodSync(b.dir, 0o000);
    try {
      const journaled = await a.folder.push();
      expect(journaled.ok && journaled.value.scan.missing).toBe(3);
      edges.logItem(
        "item.updated",
        door.update(changed.id, {
          properties: { notes: "their annotation" },
          version: 1,
        }),
      );
      edges.logItem(
        "item.updated",
        door.update(photo, {
          properties: { blob_ref: hashOf(after) },
          version: 1,
        }),
      );
      const heard = await a.folder.device().catchUp();
      expect(heard.ok && heard.value.applied).toBe(2);
      const pulled = await a.folder.push();
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      if (!pulled.ok) return;
      expect(existsSync(join(a.dir, "Changed.md"))).toBe(false);
      expect(existsSync(join(a.dir, "photo.png"))).toBe(false);

      await pastTheGrace();
      const held = await a.folder.push();
      expect(held.ok, JSON.stringify(held)).toBe(true);
      if (!held.ok) return;
      expect(held.value.scan.unsure.map((file) => file.path).sort()).toEqual(
        names,
      );
    } finally {
      chmodSync(b.dir, 0o755);
    }

    // Readable again and holding none of the files, the folder trashes the
    // item nobody changed, the witness, and writes the changed ones back.
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.trashed).toEqual(["Plain.md"]);
    expect(deletesOf(a.server, plain.id)).toBe(1);
    for (const id of [changed.id, photo]) {
      expect(
        deletesOf(a.server, id),
        "an item another device changed inside the grace went to the bin",
      ).toBe(0);
    }
    expect(swept.value.pull?.revived).toBe(2);
    expect(read(a, "Changed.md")).toContain("their annotation");
    expect(idIn(a, "Changed.md")).toBe(changed.id);
    expect(readFileSync(join(a.dir, "photo.png"))).toEqual(after);

    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, changed.id)).toBe(0);
    expect(deletesOf(a.server, photo)).toBe(0);
    expect(read(a, "Changed.md")).toContain("their annotation");
  });

  it("refuses a folder inside another, and walks past a folder inside it", async () => {
    harness = await folderHarness("nested-outer", {
      settings: {
        query: { types: ["core.note"] },
        first_placement: { "core.note": "inner/" },
      },
      items: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000043a1",
              properties: { title: "Placed", body: "from elsewhere\n" },
            },
          },
        ],
      },
    });
    // Before the item doors, whose read would answer for any id.
    const innerRow = scriptFolderItem(harness.server, {
      query: { types: ["core.note"] },
    });
    scriptFolderWrites(harness);
    const inside = (dir: string): CliFolder =>
      new CliFolder(dir, {
        binary: requireBinary(),
        url: harness?.server.url ?? "",
        key: KEY,
        registry: harness?.registry,
      });
    mkdirSync(join(harness.dir, "inner"));
    const refused = await inside(join(harness.dir, "inner")).add(innerRow.id);
    expect(
      refused.ok,
      "a folder was added inside another, so the outer one's walk takes its files too",
    ).toBe(false);
    expect(refused.ok || refused.refusal.raw).toContain(
      "a folder cannot sit inside another",
    );
    expect(
      existsSync(join(harness.dir, "inner", ".marfa", "core.sqlite")),
    ).toBe(false);
    const holding = await inside(join(harness.dir, "..")).add(innerRow.id);
    expect(holding.ok || holding.refusal.raw).toContain(
      "a folder cannot sit inside another",
    );

    // A folder inside, on another machine's registry say, is its own.
    mkdirSync(join(harness.dir, "inner", ".marfa"), { recursive: true });
    copyFileSync(
      join(harness.dir, ".marfa", "core.sqlite"),
      join(harness.dir, "inner", ".marfa", "core.sqlite"),
    );
    put(harness, "inner/theirs.md", "---\ntitle: Theirs\n---\nnot ours\n");
    put(harness, "ours.md", "---\ntitle: Ours\n---\nours\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness),
      "the walk went into a folder inside this one",
    ).toEqual(["Ours"]);
    // Nor does a pull write where its walk never reads back.
    expect(
      existsSync(join(harness.dir, "inner", "Placed.md")),
      "a pull wrote into a folder inside this one",
    ).toBe(false);
    expect(pushed.value.pull?.outside).toBe(1);
    // The witness: with no folder there, the pull writes it.
    rmSync(join(harness.dir, "inner", ".marfa"), { recursive: true });
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "inner", "Placed.md"))).toBe(true);
  });

  it("holds a bound file whose directory becomes a folder inside this one, and trashes nothing", async () => {
    harness = await folderHarness("nested-later");
    scriptFolderWrites(harness);
    put(harness, "inner/kept.md", "---\ntitle: Kept\n---\nbound here\n");
    put(harness, "gone.md", "---\ntitle: Gone\n---\ndeleted outright\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = (title: string): string =>
      String(
        sentCreates(harness!).find(
          (sent) =>
            (sent.properties as Record<string, unknown>).title === title,
        )?.id,
      );

    // Another folder's state lands in the directory, and a file goes.
    mkdirSync(join(harness.dir, "inner", ".marfa"), { recursive: true });
    copyFileSync(
      join(harness.dir, ".marfa", "core.sqlite"),
      join(harness.dir, "inner", ".marfa", "core.sqlite"),
    );
    rmSync(join(harness.dir, "gone.md"));
    const first = await harness.folder.push();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect([first.value.scan.unreached, first.value.scan.missing]).toEqual([
      1, 1,
    ]);
    await pastTheGrace();
    const swept = await harness.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    // The witness: the file deleted outright in the same pass is trashed.
    expect(swept.value.scan.trashed).toEqual(["gone.md"]);
    expect(deletesOf(harness.server, id("Gone"))).toBe(1);
    expect(
      deletesOf(harness.server, id("Kept")),
      "a file bound under a directory that became a folder was trashed",
    ).toBe(0);
    expect(swept.value.scan.unreached).toBe(1);
  });

  it("admits parent components without skipping a preceding symlink", async () => {
    harness = await folderHarness("parent-components");
    mkdirSync(join(harness.dir, "child"));
    const at = (path: string) =>
      new CliFolder(path, {
        binary: requireBinary(),
        url: harness!.server.url,
        key: KEY,
      });
    // Keep the raw spelling: path.join would erase the component under test.
    const admitted = await at(`${harness.dir}/child/..`).add(
      harness.settings.id,
    );
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    symlinkSync(join(harness.dir, "child"), join(harness.dir, "link"));
    const refused = await at(`${harness.dir}/link/..`).add(harness.settings.id);
    expect(refused.ok, JSON.stringify(refused)).toBe(false);
    expect((await harness.folder.status()).ok).toBe(true);
  });

  it("refuses a folder reached through a symlink and preserves its registry identity", async () => {
    harness = await folderHarness("renamed-folder");
    const root = harness.dir;
    const away = `${root}-renamed`;
    renameSync(root, away);
    symlinkSync(away, root);
    try {
      expect((await harness.folder.push()).ok).toBe(false);
      const listed = await harness.folder.list();
      expect(listed.ok && listed.value.map((entry) => entry.dir)).toEqual([
        root,
      ]);
    } finally {
      rmSync(root);
      renameSync(away, root);
    }
    expect((await harness.folder.pull()).ok).toBe(true);
  });

  it("follows a move by copy and delete, by id and by bytes", async () => {
    const moved = "01a00000-0000-7000-8000-0000000040c1";
    const { a, b } = await onOneMac(
      "copy-and-delete",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: moved, properties: { title: "Moved", body: "m\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    put(a, "Loose.txt", "loose only here\n");
    expect((await a.folder.push()).ok).toBe(true);
    const loose = String(sentCreates(a)[0]?.id);
    // Copied and deleted, each is a new inode where it went.
    for (const name of ["Moved.md", "Loose.txt"]) {
      copyFileSync(join(a.dir, name), join(b.dir, name));
      rmSync(join(a.dir, name));
    }
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      [moved, loose].map((id) => deletesOf(a.server, id)),
      "a file moved by copy and delete was trashed: its id or its bytes were not looked for",
    ).toEqual([0, 0]);
    // The note's copy carries its id line. The text file's carries nothing,
    // so the other folder knows it only by the binding kept here.
    const from = b.server.requests.length;
    expect((await b.folder.push()).ok).toBe(true);
    expect(
      createsSince(b.server, from),
      "a file moved by copy and delete became a new item where it went",
    ).toEqual([]);
    expect(idIn(b, "Moved.md")).toBe(moved);
    expect(swept.value.scan.moved_away).toBe(1);
    expect(swept.value.pull?.elsewhere).toBe(2);
    const released = await a.folder.push();
    expect(released.ok, JSON.stringify(released)).toBe(true);
    if (!released.ok) return;
    expect(released.value.scan.moved_away).toBe(1);
    expect([moved, loose].map((id) => deletesOf(a.server, id))).toEqual([0, 0]);
  });

  it("takes a file moved in by copy and delete by the bytes the folder it left bound", async () => {
    const { a, b } = await onOneMac(
      "bytes-follow",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    put(a, "Early.txt", "scanned there first\n");
    expect((await a.folder.push()).ok).toBe(true);
    const early = String(sentCreates(a)[0]?.id);
    copyFileSync(join(a.dir, "Early.txt"), join(b.dir, "Early.txt"));
    rmSync(join(a.dir, "Early.txt"));
    const from = b.server.requests.length;
    const taken = await b.folder.push();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect(
      createsSince(b.server, from),
      "a file moved by copy and delete became a new item where it went",
    ).toEqual([]);
    const placed = b.server.requests
      .slice(from)
      .filter(
        (request) => request.method === "POST" && request.pathname === "/edges",
      )
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(placed.map((edge) => [edge.from_id, edge.properties])).toEqual([
      [early, { path: "Early.txt" }],
    ]);
  });

  it("takes a file item at a document name moved to another folder as that item, and trashes it only where no folder holds it", async () => {
    // Plain text a server holds as files, each at a document name.
    const files = {
      moved: ["01a00000-0000-7000-8000-0000000042a1", "notes.md"],
      copied: ["01a00000-0000-7000-8000-0000000042a2", "copied.markdown"],
      logged: ["01a00000-0000-7000-8000-0000000042a3", "log.txt"],
      gone: ["01a00000-0000-7000-8000-0000000042a4", "gone.md"],
    } as const;
    const bytesOf = (name: string) => Buffer.from(`the bytes of ${name}\n`);
    const { a, b, edges } = await onOneMac(
      "file-item-document-name",
      { query: { types: ["core.file"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.file": Object.values(files).map(([id, name]) => ({
          item: {
            id,
            type: "core.file",
            properties: {
              title: name,
              blob_ref: hashOf(bytesOf(name)),
            },
          },
        })),
      },
    );
    for (const [, name] of Object.values(files)) {
      scriptBlob(a.server, bytesOf(name));
    }
    expect((await a.folder.pull()).ok).toBe(true);
    for (const [, name] of Object.values(files)) {
      expect(readFileSync(join(a.dir, name))).toEqual(bytesOf(name));
    }
    renameSync(join(a.dir, files.moved[1]), join(b.dir, files.moved[1]));
    for (const [, name] of [files.copied, files.logged]) {
      copyFileSync(join(a.dir, name), join(b.dir, name));
      rmSync(join(a.dir, name));
    }
    rmSync(join(a.dir, files.gone[1]));

    const from = b.server.requests.length;
    const taken = await b.folder.push();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect(
      createsSince(b.server, from).map(
        (sent) => (sent.properties as { title?: string }).title,
      ),
      "a file item's file moved to another folder became a new item there",
    ).toEqual([]);
    const placements = edges.placements(b.settings.id);
    for (const [id, name] of [files.moved, files.copied, files.logged]) {
      expect(placements.get(id), `${name} is not its item's file`).toBe(name);
      expect(readFileSync(join(b.dir, name))).toEqual(bytesOf(name));
    }

    // The folder it left finds each moved, and trashes only the one found
    // in no folder: the witness that a missing file item is still trashed.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      [files.moved, files.copied, files.logged].map(([id]) =>
        deletesOf(a.server, id),
      ),
      "a file item moved to another folder was read as a delete, and trashed",
    ).toEqual([0, 0, 0]);
    expect(swept.value.scan.moved_away).toBe(3);
    expect(deletesOf(a.server, files.gone[0])).toBe(1);
    expect(swept.value.scan.trashed).toEqual([files.gone[1]]);
  });

  it.each(["leaving", "arriving"])(
    "keeps one item when a file item both folders hold moves between them and the %s folder scans first",
    async (first) => {
      // File items carry nothing that names their item, so only the
      // binding the folder they left keeps tells the other folder which
      // item each is. `skip.dat` goes where the other folder ignores it.
      const files = {
        photo: ["01a00000-0000-7000-8000-0000000043a1", "photo.bin"],
        notes: ["01a00000-0000-7000-8000-0000000043a2", "notes.md"],
        skipped: ["01a00000-0000-7000-8000-0000000043a3", "skip.dat"],
        gone: ["01a00000-0000-7000-8000-0000000043a4", "gone.bin"],
      } as const;
      const taken = [files.photo, files.notes];
      // A note carries its id line, so it is followed by that line.
      const plan = "01a00000-0000-7000-8000-0000000043a5";
      const bytesOf = (name: string) => Buffer.from(`the bytes of ${name}\n`);
      const both = { types: ["core.file", "core.note"] };
      const { a, b, edges } = await onOneMac(
        `both-hold-${first}`,
        { query: both },
        { query: both, ignore: ["*.dat"] },
        {
          "core.file": Object.values(files).map(([id, name]) => ({
            item: {
              id,
              type: "core.file",
              properties: { title: name, blob_ref: hashOf(bytesOf(name)) },
            },
          })),
          "core.note": [
            { item: { id: plan, properties: { title: "Plan", body: "p\n" } } },
          ],
        },
      );
      for (const [, name] of Object.values(files)) {
        scriptBlob(a.server, bytesOf(name));
      }
      acceptUploads(a.server);
      expect((await a.folder.pull()).ok).toBe(true);
      for (const name of ["photo.bin", "notes.md", "Plan.md", "skip.dat"]) {
        renameSync(join(a.dir, name), join(b.dir, name));
      }
      rmSync(join(a.dir, files.gone[1]));

      const leaving = async () => {
        expect((await a.folder.push()).ok).toBe(true);
        await pastTheGrace();
        const swept = await a.folder.push();
        expect(swept.ok, JSON.stringify(swept)).toBe(true);
        if (!swept.ok) return;
        // The witness that the sweep sends deletes: the file found nowhere.
        expect(swept.value.scan.trashed).toEqual([files.gone[1]]);
        if (first === "arriving") {
          expect(swept.value.scan.moved_away).toBe(4);
          return;
        }
        // Not yet taken there, the file items keep their bindings here, and
        // nothing is written over them; the note is followed by its id.
        expect(swept.value.scan.moved_away).toBe(2);
        expect(swept.value.pull?.elsewhere).toBe(3);
        for (const name of ["photo.bin", "notes.md", "Plan.md"]) {
          expect(
            existsSync(join(a.dir, name)),
            `${name} was written again before the other folder took it`,
          ).toBe(false);
        }
        // A file the other folder does not take is written again here.
        expect(readFileSync(join(a.dir, "skip.dat"))).toEqual(
          bytesOf("skip.dat"),
        );
      };
      const arriving = async () => {
        const pushed = await b.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      };
      if (first === "leaving") {
        await leaving();
        await arriving();
      } else {
        await arriving();
        await leaving();
      }
      // Once taken there, the folder it left lets the bindings go and, as
      // its query still holds the items, writes their files again.
      const settled = await a.folder.push();
      expect(settled.ok, JSON.stringify(settled)).toBe(true);
      expect((await b.folder.push()).ok).toBe(true);

      expect(
        sentCreates(a).map(
          (sent) => (sent.properties as { title?: string }).title,
        ),
        "a file item moved between two folders that both hold it became a new item",
      ).toEqual([]);
      expect(
        [files.photo, files.notes, files.skipped].map(([id]) =>
          deletesOf(a.server, id),
        ),
        "a file item moved between two folders that both hold it was trashed",
      ).toEqual([0, 0, 0]);
      expect(deletesOf(a.server, files.gone[0])).toBe(1);
      expect(deletesOf(a.server, plan)).toBe(0);
      const placements = edges.placements(b.settings.id);
      for (const [id, name] of taken) {
        expect(placements.get(id), `${name} is not its item's file`).toBe(name);
        expect(readFileSync(join(b.dir, name))).toEqual(bytesOf(name));
        expect(readFileSync(join(a.dir, name))).toEqual(bytesOf(name));
      }
      expect(placements.get(plan)).toBe("Plan.md");
      expect(idIn(b, "Plan.md")).toBe(plan);
      expect(idIn(a, "Plan.md")).toBe(plan);
      expect(
        readdirSync(b.dir).filter((name) => name.includes(" (2)")),
        "the item's file was written beside a new item's",
      ).toEqual([]);
    },
  );

  it("gives a fresh id to a moved file whose item the server will not show, and pins one it shows", async () => {
    const shown = "01a00000-0000-7000-8000-0000000039d1";
    // Trashed, or of a type this key cannot read: the server answers both alike.
    const unseen = "01a00000-0000-7000-8000-0000000039d2";
    const note = (id: string, title: string) => ({
      item: { id, properties: { title, body: `${title}\n` } },
    });
    const { a, b } = await onOneMac(
      "moved-unseen",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [note(shown, "Shown"), note(unseen, "Unseen")],
      },
      (server) => {
        server.copyAnswer("GET", `/items/${unseen}`, answers.itemNotFound());
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    for (const name of ["Shown.md", "Unseen.md"]) {
      renameSync(join(a.dir, name), join(b.dir, name));
    }
    const from = b.server.requests.length;
    expect((await b.folder.push()).ok).toBe(true);
    const creates = createsSince(b.server, from);
    expect(
      creates
        .map((sent) => (sent.properties as { title?: string }).title)
        .sort(),
      "a moved file whose item the server will not show kept an id this folder cannot write to",
    ).toEqual(["Unseen"]);
    expect(creates.map((sent) => sent.id)).not.toContain(unseen);
    expect(idIn(b, "Shown.md")).toBe(shown);
    const status = await b.folder.device().status();
    expect(status.ok && status.value.pinned).toContain(shown);
  });

  it("keeps its registry under the home by default", async () => {
    const home = tempFolder("marfa-home-");
    harness = await folderHarness("home-registry", { home });
    const registry =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Marfa", "folders.json")
        : join(home, ".local", "share", "marfa", "folders.json");
    expect(
      existsSync(registry),
      "with no registry named, the folder was not listed in the machine's own",
    ).toBe(true);
    expect(readFileSync(registry, "utf8")).toContain(harness.settings.id);
    expect(existsSync(harness.registry)).toBe(false);
  });

  it("lists a folder again where the registry lost it, a watch included", async () => {
    harness = await folderHarness("listed-again");
    scriptFolderWrites(harness);
    rmSync(harness.registry);
    expect((await harness.folder.push()).ok).toBe(true);
    const pushed = await harness.folder.list();
    expect(pushed.ok && pushed.value.map((entry) => entry.folder)).toEqual([
      harness.settings.id,
    ]);

    const watch = harness.folder.watch();
    try {
      await vi.waitFor(() => {
        expect(watch.stderr).toContain("watching");
      });
      rmSync(harness.registry);
      await vi.waitFor(
        () => {
          expect(
            existsSync(harness?.registry ?? "") &&
              readFileSync(harness?.registry ?? "", "utf8"),
            "a running watch never listed its folder again",
          ).toContain(harness?.settings.id);
        },
        { timeout: 10_000, interval: 500 },
      );
    } finally {
      await watch.stop();
    }
  });

  it("does not trash a file moved to another folder and saved there anew", async () => {
    const kept = "01a00000-0000-7000-8000-0000000040e1";
    const { a, b } = await onOneMac(
      "moved-then-saved",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: kept, properties: { title: "Kept", body: "k\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Kept.md"), join(b.dir, "Kept.md"));
    expect((await b.folder.push()).ok).toBe(true);
    // An editor there saves it atomically, unchanged: a new inode, bound to
    // the item, and nothing sent that would write the file back here.
    saveAtomically(b, "Kept.md", read(b, "Kept.md"));
    expect((await b.folder.push()).ok).toBe(true);

    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      deletesOf(a.server, kept),
      "a file moved to a folder that does not hold its item, and saved there, was read as another folder's own file and its item trashed",
    ).toBe(0);
    expect(swept.value.scan.moved_away).toBe(1);
  });

  it("does not trash an unmatched file moved by copy and delete into a folder that holds its item", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000041a1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const { a, b, edges } = await onOneMac(
      "unmatched-copied-across",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: plan, tags: ["a"] }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(plan),
        { tags: ["b"] },
      ),
    );
    // This folder hears first, and keeps the file it no longer holds.
    const left = await a.folder.push();
    expect(left.ok && left.value.pull?.unmatched).toBe(1);
    copyFileSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    rmSync(join(a.dir, "Plan.md"));
    expect((await b.folder.push()).ok).toBe(true);
    expect(sentCreates(b)).toEqual([]);

    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      deletesOf(a.server, plan.id),
      "a file of an item this folder no longer holds, moved to the folder that does, was read as that folder's own and trashed",
    ).toBe(0);
    expect(swept.value.scan.moved_away).toBe(1);
  });

  it("holds a delete where several files in another folder have its bytes", async () => {
    const { a, b } = await onOneMac(
      "bytes-many",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    put(a, "Loose.txt", "shared words\n");
    expect((await a.folder.push()).ok).toBe(true);
    const loose = String(sentCreates(a)[0]?.id);
    put(b, "One.txt", "shared words\n");
    put(b, "Two.txt", "shared words\n");
    rmSync(join(a.dir, "Loose.txt"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const held = await a.folder.push();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect(
      deletesOf(a.server, loose),
      "a missing file with two same-bytes candidates elsewhere was trashed, where it may be either",
    ).toBe(0);
    expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
      "Loose.txt",
    ]);
  });

  it("follows identical files moved by identity, and makes identical copies new items", async () => {
    const { a, b } = await onOneMac(
      "identical-files",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    for (const name of ["One.txt", "Two.txt"]) put(a, name, "twins\n");
    for (const name of ["Three.txt", "Four.txt"]) put(a, name, "copies\n");
    expect((await a.folder.push()).ok).toBe(true);
    for (const name of ["One.txt", "Two.txt"]) {
      renameSync(join(a.dir, name), join(b.dir, name));
    }
    for (const name of ["Three.txt", "Four.txt"]) {
      copyFileSync(join(a.dir, name), join(b.dir, name));
      rmSync(join(a.dir, name));
    }
    const from = b.server.requests.length;
    expect((await b.folder.push()).ok).toBe(true);
    expect(
      createsSince(b.server, from)
        .map((sent) => (sent.properties as { title?: string }).title)
        .sort(),
      "identical files moved kept their items by identity, and identical copies, which bytes cannot tell apart, became new items",
    ).toEqual(["Four", "Three"]);
  });

  it("trashes a file item deleted where both folders hold it", async () => {
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2,
    ]);
    const photo = "01a00000-0000-7000-8000-0000000041b1";
    const { a, b } = await onOneMac(
      "file-item-both",
      { query: { types: ["core.note", "core.file"] } },
      { query: { types: ["core.file"] } },
      {
        "core.file": [
          {
            item: {
              id: photo,
              type: "core.file.image",
              properties: {
                title: "photo.png",
                blob_ref: hashOf(bytes),
                mime_type: "image/png",
              },
            },
          },
        ],
      },
    );
    scriptBlob(a.server, bytes);
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    expect(existsSync(join(b.dir, "photo.png"))).toBe(true);

    rmSync(join(a.dir, "photo.png"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      deletesOf(a.server, photo),
      "the other folder's own file of an item both hold was taken for this one moved, by its bytes",
    ).toBe(1);
  });

  it("takes a copy into a folder that holds the item and has no file of it as the item's file", async () => {
    const shared = "01a00000-0000-7000-8000-0000000041c1";
    const { a, b } = await onOneMac(
      "copy-into-holder",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.note"] } },
      {
        "core.note": [
          {
            item: { id: shared, properties: { title: "Shared", body: "s\n" } },
          },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    copyFileSync(join(a.dir, "Shared.md"), join(b.dir, "Filed here.md"));
    const from = b.server.requests.length;
    expect((await b.folder.push()).ok).toBe(true);
    expect(
      createsSince(b.server, from),
      "a copy into a folder that holds its item, where that folder has no file of it, became a new item",
    ).toEqual([]);
    expect(idIn(b, "Filed here.md")).toBe(shared);
  });

  it.each(["its state", "a tag"])(
    "keeps a file in the folder an item left by a tag when the folder that wrote its own file drops the item by %s, and sends no delete",
    async (dropped) => {
      const plan = {
        id: "01a00000-0000-7000-8000-00000000035a",
        properties: { title: "Plan", body: "the plan\n" },
      };
      const gone = {
        id: "01a00000-0000-7000-8000-00000000035b",
        properties: { title: "Gone", body: "deleted for real\n" },
      };
      const byState = dropped === "its state";
      const { a, b, door, edges } = await onOneMac(
        `archived-elsewhere-${byState ? "state" : "tag"}`,
        {
          query: {
            types: ["core.note"],
            filter: 'tags contains "a"',
            state: ["active", "archived"],
          },
        },
        {
          query: {
            types: ["core.note"],
            filter: 'tags contains "b"',
            state: ["active"],
          },
        },
        {
          "core.note": [
            { item: plan, tags: ["a"] },
            { item: gone, tags: ["a"] },
          ],
        },
      );
      expect((await a.folder.push()).ok).toBe(true);
      expect((await b.folder.push()).ok).toBe(true);

      // The item leaves the first folder by a tag and enters the second.
      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "metadata.changed",
          wireItem(plan),
          { tags: ["b"] },
        ),
      );
      const left = await a.folder.push();
      expect(left.ok && left.value.pull?.unmatched).toBe(1);
      const wrote = await b.folder.push();
      expect(wrote.ok && wrote.value.pull?.written).toBe(1);
      expect(idIn(b, "Plan.md")).toBe(plan.id);

      if (byState) {
        door.transition(plan.id, "archived");
        edges.events.push(
          copyItemEvent(
            String(edges.events.length + 2),
            "item.updated",
            wireItem({ ...plan, version: 2, state: "archived" }),
            { tags: ["b"] },
          ),
        );
      } else {
        edges.events.push(
          copyItemEvent(
            String(edges.events.length + 2),
            "metadata.changed",
            wireItem(plan),
            { tags: [] },
          ),
        );
      }
      const caught = await b.folder.push();
      expect(caught.ok, JSON.stringify(caught)).toBe(true);
      if (!caught.ok) return;
      expect([
        caught.value.pull?.removed,
        caught.value.pull?.unmatched,
      ]).toEqual(byState ? [1, 0] : [0, 1]);

      // Gone.md exercises the same deletion sweep.
      rmSync(join(a.dir, "Gone.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const swept = await a.folder.push();
      expect(swept.ok, JSON.stringify(swept)).toBe(true);
      if (!swept.ok) return;
      expect(deletesOf(a.server, gone.id)).toBe(1);
      expect(
        deletesOf(a.server, plan.id),
        "the folder the item left sent a delete for it",
      ).toBe(0);
      expect(
        read(a, "Plan.md"),
        "the folder the item left lost or changed its file",
      ).toContain("the plan\n");
      expect(idIn(a, "Plan.md")).toBe(plan.id);
      expect(door.rows.get(plan.id)?.state).toBe(
        byState ? "archived" : undefined,
      );
      expect(door.rows.get(plan.id)?.properties.body).toBe("the plan\n");
    },
  );

  it("writes the server's bytes, and leaves an edit the folder an item left has not read in its file, when another folder comes to hold the item", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000041d1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const brief = {
      id: "01a00000-0000-7000-8000-0000000041d3",
      properties: { title: "Brief", body: "the brief\n" },
    };
    const picture = Buffer.from("a picture fetched in the brief's pull\n");
    // The creation time puts the blob fetch in the pull that writes Brief.md.
    const image = {
      id: "01a00000-0000-7000-8000-0000000041d4",
      type: "core.file.image",
      created_at: "2026-09-19T00:00:00.000Z",
      properties: {
        title: "picture.png",
        blob_ref: hashOf(picture),
        mime_type: "image/png",
      },
    };
    const { a, b, edges } = await onOneMac(
      "unsent-edit-elsewhere",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      {
        query: {
          types: ["core.note", "core.file"],
          filter: 'tags contains "b"',
        },
      },
      {
        "core.note": [
          { item: plan, tags: ["a"] },
          { item: brief, tags: ["a"] },
        ],
        "core.file": [{ item: image }],
      },
      (server) => {
        const hex = hashOf(picture).slice("sha256:".length);
        server.copyAnswer(
          "GET",
          `/blobs/${hashOf(picture)}/url`,
          writeAnswers.link(`${server.url}/links/${hex}`),
        );
        server.copyAnswer("GET", `/links/${hex}`, () => {
          const path = join(harness!.dir, "Brief.md");
          writeFileSync(
            path,
            readFileSync(path, "utf8").replace(
              "the brief\n",
              "edited mid-pull\n",
            ),
          );
          return { kind: "bytes", status: 200, body: picture };
        });
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(plan),
        { tags: ["b"] },
      ),
    );
    expect((await a.folder.push()).ok).toBe(true);
    writeFileSync(
      join(a.dir, "Plan.md"),
      read(a, "Plan.md").replace("the plan\n", "edited, not yet read\n"),
    );
    const wrote = await b.folder.push();
    expect(wrote.ok, JSON.stringify(wrote)).toBe(true);
    if (!wrote.ok) return;
    expect(wrote.value.pull?.written).toBe(1);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
    expect(
      read(b, "Plan.md"),
      "the receiving folder copied an edit the other folder had not read",
    ).not.toContain("edited, not yet read\n");
    expect(read(b, "Plan.md")).toContain("the plan\n");
    expect(read(a, "Plan.md")).toContain("edited, not yet read\n");

    for (const item of [brief, image]) {
      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "metadata.changed",
          wireItem(item),
          { tags: ["b"] },
        ),
      );
    }
    expect((await a.folder.push()).ok).toBe(true);
    expect(read(a, "Brief.md")).toContain("the brief\n");
    const racing = await b.folder.push();
    expect(racing.ok, JSON.stringify(racing)).toBe(true);
    if (!racing.ok) return;
    expect(
      existsSync(join(b.dir, "picture.png")),
      "the picture was not fetched, so nothing edited the brief mid-pull",
    ).toBe(true);
    expect(racing.value.pull?.written).toBe(2);
    expect(read(a, "Brief.md")).toContain("edited mid-pull\n");
    expect(
      read(b, "Brief.md"),
      "the receiving folder copied an edit made in the other folder during its pull",
    ).not.toContain("edited mid-pull\n");
    expect(read(b, "Brief.md")).toContain("the brief\n");
  });

  it("sends an edit queued in the folder an item left, and keeps it on disk, when the folder holding the item writes its own file", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-00000000035c",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const { a, b, door, edges } = await onOneMac(
      "queued-edit-kept",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: plan, tags: ["a"] }] },
    );
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(plan),
        { tags: ["b"] },
      ),
    );
    expect((await a.folder.device().catchUp()).ok).toBe(true);
    const left = await a.folder.pull();
    expect(left.ok && left.value.unmatched, JSON.stringify(left)).toBe(1);

    // The person's edit is read and queued, not sent.
    writeFileSync(
      join(a.dir, "Plan.md"),
      read(a, "Plan.md").replace("the plan\n", "the plan, edited\n"),
    );
    const queued = await a.folder.scan();
    expect(queued.ok && queued.value.updated, JSON.stringify(queued)).toBe(1);
    // Newer metadata rewrites the file, with the queued edit in it.
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(plan),
        { tags: ["b", "later"] },
      ),
    );
    expect((await a.folder.device().catchUp()).ok).toBe(true);
    const rewrote = await a.folder.pull();
    expect(rewrote.ok, JSON.stringify(rewrote)).toBe(true);
    expect(read(a, "Plan.md")).toContain("the plan, edited\n");
    expect(read(a, "Plan.md")).toContain("later");

    const wrote = await b.folder.push();
    expect(wrote.ok && wrote.value.pull?.written).toBe(1);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
    expect(
      read(a, "Plan.md"),
      "the file holding the queued edit left its folder",
    ).toContain("the plan, edited\n");

    const sent = await a.folder.push();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect(door.rows.get(plan.id)?.properties.body).toBe("the plan, edited\n");
    expect(read(a, "Plan.md")).toContain("the plan, edited\n");
    expect((await b.folder.push()).ok).toBe(true);
    expect(read(b, "Plan.md")).toContain("the plan, edited\n");
    expect(read(a, "Plan.md")).toContain("the plan, edited\n");
  });

  it("moves no file out of a paused directory when another folder comes to hold its item", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-00000000035d",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const { a, b, edges } = await onOneMac(
      "paused-source",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: plan, tags: ["a"] }] },
    );
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(plan),
        { tags: ["b"] },
      ),
    );
    const left = await a.folder.push();
    expect(left.ok && left.value.pull?.unmatched).toBe(1);
    const held = read(a, "Plan.md");
    const paused = await a.folder.pause();
    expect(paused.ok && paused.value.paused).toBe(true);

    expect((await b.folder.device().catchUp()).ok).toBe(true);
    const pulled = await b.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(1);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
    expect(
      read(a, "Plan.md"),
      "a file was moved or changed in a paused directory",
    ).toBe(held);
    expect(readdirSync(a.dir).filter((name) => name.endsWith(".md"))).toEqual([
      "Plan.md",
    ]);
  });

  it("refuses to remove a folder with a blocked write", async () => {
    harness = await folderHarness("remove-blocked");
    scriptWrites(harness.server, { create: [answers.unauthorized()] });
    put(harness, "note.md", "---\ntitle: Note\n---\nblocked\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    await harness.folder.device().drain();
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok && queued.value.map((row) => row.verdict),
      "the write was not blocked, so nothing here is about a blocked write",
    ).toContain("blocked");
    const refused = await harness.folder.remove();
    expect(
      refused.ok,
      "a folder was removed with a blocked write, which is lost with it",
    ).toBe(false);
    expect(existsSync(join(harness.dir, ".marfa"))).toBe(true);
  });

  it("lists a folder under the folder it follows now, once, and drops one whose state was removed", async () => {
    harness = await folderHarness("registry-entries");
    const other = scriptFolderItem(harness.server, {
      query: { types: ["core.note"] },
    });
    // Its state removed by hand and the directory added again under
    // another folder: listed under the one it follows now.
    rmSync(join(harness.dir, ".marfa"), { recursive: true, force: true });
    const again = await harness.folder.add(other.id);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const listed = await harness.folder.list();
    expect(
      listed.ok && listed.value.map((entry) => entry.folder),
      "the registry kept the folder the directory followed before",
    ).toEqual([other.id]);

    // A hand-written duplicate reads once, however its directory is spelled.
    const written = JSON.parse(readFileSync(harness.registry, "utf8")) as {
      folders: Array<{ dir: string; folder: string }>;
    };
    const [entry] = written.folders;
    if (entry === undefined) throw new Error("the registry lists nothing");
    written.folders.push(entry, { dir: harness.dir, folder: entry.folder });
    writeFileSync(harness.registry, JSON.stringify(written));
    const once = await harness.folder.list();
    expect(once.ok && once.value.length, "an entry was listed twice").toBe(1);

    // A directory that reads and holds no folder is no folder.
    rmSync(join(harness.dir, ".marfa"), { recursive: true, force: true });
    const dropped = await harness.folder.list();
    expect(
      dropped.ok && dropped.value,
      "a directory whose state was removed is still listed as a folder",
    ).toEqual([]);
  });

  it("holds a delete for a pass when the registry it was listed in is gone, and lists itself again", async () => {
    const moved = "01a00000-0000-7000-8000-0000000041e1";
    const { a, b } = await onOneMac(
      "registry-lost",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: moved, properties: { title: "Moved", body: "m\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    rmSync(a.registry);

    const held = await a.folder.push();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect(
      deletesOf(a.server, moved),
      "with its registry gone, the folder took the missing file for deleted, where it moved to a folder the registry had listed",
    ).toBe(0);
    expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
      "Moved.md",
    ]);
    expect(held.value.scan.registry).toMatch(/was gone/);
    const listed = await a.folder.list();
    expect(listed.ok && listed.value.map((entry) => entry.folder)).toEqual([
      a.settings.id,
    ]);

    // The next pass looks in the folders it found before, listed or not.
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(deletesOf(a.server, moved)).toBe(0);
  });

  it("holds a delete while a listed folder is missing, until it lists itself again", async () => {
    const moved = "01a00000-0000-7000-8000-0000000041f1";
    const { a, b } = await onOneMac(
      "folder-renamed",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: moved, properties: { title: "Moved", body: "m\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const renamed = `${realpathSync(b.dir)}-renamed`;
    renameSync(b.dir, renamed);
    renameSync(join(a.dir, "Moved.md"), join(renamed, "Moved.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const held = await a.folder.push();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect(
      deletesOf(a.server, moved),
      "a file moved into a folder renamed on disk was trashed, the folder's old entry read as gone",
    ).toBe(0);
    expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
      "Moved.md",
    ]);
    const listed = await a.folder.list();
    expect(listed.ok && listed.value.length).toBe(2);

    // The folder lists itself under its new name at its next pass.
    const there = new CliFolder(renamed, {
      binary: requireBinary(),
      url: a.server.url,
      key: KEY,
      registry: a.registry,
    });
    expect((await there.push()).ok).toBe(true);
    const relisted = await a.folder.list();
    expect(
      relisted.ok && relisted.value.map((entry) => entry.dir).sort(),
    ).toEqual([realpathSync(a.dir), renamed].sort());
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(deletesOf(a.server, moved)).toBe(0);
  });

  /** The registry's entries, as the file holds them. */
  function registryEntries(
    registry: string,
  ): Array<{ dir: string; folder: string; root?: string }> {
    return (
      JSON.parse(readFileSync(registry, "utf8")) as {
        folders: Array<{ dir: string; folder: string; root?: string }>;
      }
    ).folders;
  }

  /** Moves a folder's directory aside and puts an empty one in its place. */
  function replaceWithEmpty(h: FolderHarness): string {
    const away = `${realpathSync(h.dir)}-away`;
    renameSync(h.dir, away);
    mkdirSync(h.dir);
    return away;
  }

  /** Stands an empty directory where the second folder was added, then
   *  reads or writes the registry at `site` and checks the folder stays
   *  listed. */
  async function emptyStandsInPlace(
    site: "list" | "add" | "pass",
  ): Promise<void> {
    const moved = "01a00000-0000-7000-8000-0000000043a1";
    let more: FolderItem | undefined;
    const { a, b } = await onOneMac(
      `root-replaced-${site}`,
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          {
            item: { id: moved, properties: { title: "Moved", body: "m\n" } },
          },
        ],
      },
      (server) => {
        more = scriptFolderItem(server, {
          query: { types: ["core.event"] },
        });
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const away = replaceWithEmpty(b);
    const dirs = (): string[] =>
      registryEntries(a.registry)
        .map((entry) => entry.dir)
        .sort();
    const both = [realpathSync(a.dir), realpathSync(b.dir)].sort();

    if (site === "list") {
      const listed = await a.folder.list();
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      expect(
        listed.ok && listed.value.map((entry) => entry.dir).sort(),
        "an empty directory where a folder was added took it off the list",
      ).toEqual(both);
    } else if (site === "add") {
      const third = await folderHarness(`root-replaced-${site}-c`, {
        sharing: { server: a.server, key: KEY },
        folder: more,
        registry: a.registry,
      });
      try {
        expect(
          dirs(),
          "adding a folder took off the list one whose directory an empty one replaced",
        ).toEqual([...both, realpathSync(third.dir)].sort());
      } finally {
        await third.stop();
      }
    } else {
      renameSync(join(a.dir, "Moved.md"), join(away, "Moved.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const held = await a.folder.push();
      expect(held.ok, JSON.stringify(held)).toBe(true);
      if (!held.ok) return;
      expect(
        deletesOf(a.server, moved),
        "a file moved into a folder whose directory an empty one replaced was trashed",
      ).toBe(0);
      expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
        "Moved.md",
      ]);
      expect(dirs()).toEqual(both);
    }

    // The folder is where it was, and the listing never lost it.
    rmSync(b.dir, { recursive: true });
    renameSync(away, b.dir);
    const back = await b.folder.list();
    expect(back.ok && back.value.length).toBe(site === "add" ? 3 : 2);
  }

  it("keeps a folder listed in a listing when an empty directory stands where it was added", () =>
    emptyStandsInPlace("list"));

  it("keeps a folder listed when another folder is added and an empty directory stands where it was added", () =>
    emptyStandsInPlace("add"));

  it("keeps a folder listed, and a delete held, when an empty directory stands where it was added at a pass that looks for a moved file", () =>
    emptyStandsInPlace("pass"));

  it("keeps a folder listed when another folder's state stands where it was added", async () => {
    let more: FolderItem | undefined;
    const { a, b } = await onOneMac(
      "root-replaced-other",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
      (server) => {
        more = scriptFolderItem(server, { query: { types: ["core.event"] } });
      },
    );
    const third = await folderHarness("root-replaced-other-c", {
      sharing: { server: a.server, key: KEY },
      folder: more,
      registry: a.registry,
    });
    try {
      const here = realpathSync(b.dir);
      const away = `${here}-away`;
      const there = realpathSync(third.dir);
      renameSync(b.dir, away);
      renameSync(third.dir, b.dir);
      const listed = await a.folder.list();
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      expect(
        listed.ok && listed.value.map((entry) => entry.dir).sort(),
        "a directory holding another folder took the entry of the folder added there off the list",
      ).toEqual([realpathSync(a.dir), here, there].sort());
      expect(
        listed.ok && listed.value.find((entry) => entry.dir === here)?.folder,
        "the entry of the folder added at the path was given to the folder that stands there now",
      ).toBe(b.settings.id);
      renameSync(b.dir, there);
      renameSync(away, b.dir);
    } finally {
      await third.stop();
    }
  });

  it("lists each folder with the identity of the directory it opened, and drops one that records none once its state is removed", async () => {
    const { a, b } = await onOneMac(
      "root-recorded",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    const rootOf = new Map(
      registryEntries(a.registry).map((entry) => [entry.folder, entry.root]),
    );
    const roots = [...rootOf.values()];
    expect(
      roots.every((root) => typeof root === "string" && root !== ""),
      "an entry does not record the directory it opened",
    ).toBe(true);
    expect(new Set(roots).size, "two folders share one identity").toBe(2);

    // The identity is in `folders list --json`.
    const shown = await a.folder.list();
    expect(shown.ok, JSON.stringify(shown)).toBe(true);
    expect(
      shown.ok && shown.value.map((entry) => entry.root).sort(),
      "folders list does not show the identity of each directory",
    ).toEqual([...roots].sort());

    // An entry without one is judged by what its path holds: its folder
    // stays while the state is there and goes once the state is removed, so
    // it is not listed forever, and does not hold up the other folders.
    const written = JSON.parse(readFileSync(a.registry, "utf8")) as {
      folders: Array<{ dir: string; folder: string; root?: string }>;
    };
    for (const entry of written.folders) delete entry.root;
    writeFileSync(a.registry, JSON.stringify(written));
    const unidentified = await b.folder.list();
    expect(
      unidentified.ok && unidentified.value.map((entry) => entry.folder).sort(),
      "an entry that records no directory was taken off the list while its state was there",
    ).toEqual([a.settings.id, b.settings.id].sort());
    writeFileSync(a.registry, JSON.stringify(written));
    rmSync(join(a.dir, ".marfa"), { recursive: true, force: true });
    const dropped = await b.folder.list();
    expect(dropped.ok, JSON.stringify(dropped)).toBe(true);
    expect(
      dropped.ok && dropped.value.map((entry) => entry.folder),
      "an entry that records no directory stayed listed after its state was removed",
    ).toEqual([b.settings.id]);

    // A pass records the identity, and a directory that then replaces the
    // folder's is not taken for it.
    expect((await b.folder.push()).ok).toBe(true);
    expect(
      registryEntries(a.registry).find(
        (entry) => entry.folder === b.settings.id,
      )?.root,
      "a folder that passed did not list itself with the directory it opened",
    ).toBe(rootOf.get(b.settings.id));
    const away = replaceWithEmpty(b);
    const replaced = await b.folder.list();
    expect(
      replaced.ok && replaced.value.map((entry) => entry.folder),
      "a folder whose directory an empty one replaced was taken off the list",
    ).toEqual([b.settings.id]);
    rmSync(b.dir, { recursive: true });
    renameSync(away, b.dir);
    rmSync(join(b.dir, ".marfa"), { recursive: true, force: true });
    const last = await b.folder.list();
    expect(
      last.ok && last.value.map((entry) => entry.folder),
      "a folder whose state was removed stayed listed once it recorded the directory it opened",
    ).toEqual([]);
  });

  it("keeps a folder it cannot read listed, and holds a delete meanwhile", async () => {
    const gone = "01a00000-0000-7000-8000-0000000042a1";
    const { a, b } = await onOneMac(
      "unreadable-folder",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    chmodSync(b.dir, 0o000);
    try {
      rmSync(join(a.dir, "Gone.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const held = await a.folder.push();
      expect(held.ok, JSON.stringify(held)).toBe(true);
      if (!held.ok) return;
      expect(
        deletesOf(a.server, gone),
        "a folder that could not be read was dropped, and a missing file trashed",
      ).toBe(0);
      expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
        "Gone.md",
      ]);
      const listed = await a.folder.list();
      expect(listed.ok && listed.value.length).toBe(2);
    } finally {
      chmodSync(b.dir, 0o755);
    }
    // The witness: readable again, the folder holds no file, and the delete
    // goes.
    const swept = await a.folder.push();
    expect(swept.ok && swept.value.scan.trashed).toEqual(["Gone.md"]);
    expect(deletesOf(a.server, gone)).toBe(1);
  });

  it("holds a delete as a held file while a folder no longer listed cannot be read, and sends it once that folder's directory is gone", async () => {
    const first = "01a00000-0000-7000-8000-0000000035b1";
    const held = "01a00000-0000-7000-8000-0000000035b2";
    const { a, b } = await onOneMac(
      "remembered-gone",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: first, properties: { title: "First", body: "f\n" } } },
          { item: { id: held, properties: { title: "Held", body: "h\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    // Deciding this delete finds the other folder, so this one remembers it.
    rmSync(join(a.dir, "First.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, first)).toBe(1);
    expect((await b.folder.remove()).ok).toBe(true);

    chmodSync(b.dir, 0o000);
    try {
      rmSync(join(a.dir, "Held.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const kept = await a.folder.push();
      expect(kept.ok, JSON.stringify(kept)).toBe(true);
      if (!kept.ok) return;
      expect(
        deletesOf(a.server, held),
        "a missing file was trashed while a folder it may have moved to could not be read",
      ).toBe(0);
      expect(kept.value.scan.unsure.map((file) => file.path)).toEqual([
        "Held.md",
      ]);
      const status = await a.folder.status();
      expect(status.ok, JSON.stringify(status)).toBe(true);
      if (!status.ok) return;
      const file = status.value.files.find((entry) => entry.path === "Held.md");
      expect(
        [file?.status, file?.flag],
        "a held delete read as a write waiting to be sent",
      ).toEqual(["held", "unsure"]);
      expect(lastReport(a).problems).toContainEqual({
        code: "held_file",
        count: 1,
      });
    } finally {
      chmodSync(b.dir, 0o755);
    }
    rmSync(b.dir, { recursive: true });
    const swept = await a.folder.push();
    expect(
      swept.ok && swept.value.scan.trashed,
      "a delete stayed held for a folder gone from a volume that is mounted",
    ).toEqual(["Held.md"]);
    expect(deletesOf(a.server, held)).toBe(1);
  });

  it("holds a delete while another folder cannot be read whole", async () => {
    const gone = "01a00000-0000-7000-8000-0000000040f1";
    const { a, b } = await onOneMac(
      "partial-walk",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const shut = join(b.dir, "Shut");
    mkdirSync(shut);
    chmodSync(shut, 0o000);
    try {
      rmSync(join(a.dir, "Gone.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const held = await a.folder.push();
      expect(held.ok, JSON.stringify(held)).toBe(true);
      if (!held.ok) return;
      expect(
        deletesOf(a.server, gone),
        "a missing file was trashed while part of another folder could not be read, where it may sit",
      ).toBe(0);
      expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
        "Gone.md",
      ]);
    } finally {
      chmodSync(shut, 0o755);
    }
    const swept = await a.folder.push();
    expect(swept.ok && swept.value.scan.trashed).toEqual(["Gone.md"]);
  });

  it("keeps two folders' files for one item editable", async () => {
    const shared = {
      id: "01a00000-0000-7000-8000-0000000024a1",
      properties: { title: "Shared", body: "first\n" },
    };
    const { a, b } = await onOneMac(
      "two-files",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.note"] } },
      { "core.note": [{ item: shared }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    expect(idIn(a, "Shared.md")).toBe(shared.id);
    expect(idIn(b, "Shared.md")).toBe(shared.id);

    writeFileSync(
      join(a.dir, "Shared.md"),
      read(a, "Shared.md").replace("first\n", "from the first folder\n"),
    );
    expect((await a.folder.push()).ok).toBe(true);
    expect((await b.folder.push()).ok).toBe(true);
    expect(read(b, "Shared.md")).toContain("from the first folder\n");

    writeFileSync(
      join(b.dir, "Shared.md"),
      read(b, "Shared.md").replace(
        "from the first folder\n",
        "from the other folder\n",
      ),
    );
    expect((await b.folder.push()).ok).toBe(true);
    expect((await a.folder.push()).ok).toBe(true);
    expect(read(a, "Shared.md")).toContain("from the other folder\n");
    expect(
      sentUpdates(a)
        .filter((sent) => sent.id === shared.id)
        .map((sent) => (sent.body.properties as { body?: string }).body),
      "an edit in one of the two files did not reach the item",
    ).toEqual(["from the first folder\n", "from the other folder\n"]);

    // Deleting either file trashes the item: the other folder's own file of
    // it is not this one moved.
    rmSync(join(a.dir, "Shared.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      deletesOf(a.server, shared.id),
      "deleting one of two folders' files for one item did not trash it, so the other folder's file was taken for this one moved",
    ).toBe(1);
    expect(swept.value.scan.trashed).toEqual(["Shared.md"]);
  });

  it("finds a file moved into a dot-led directory the other folder includes", async () => {
    const moved = "01a00000-0000-7000-8000-0000000018b1";
    const deleted = "01a00000-0000-7000-8000-0000000018b2";
    const { a, b } = await onOneMac(
      "move-dot-led",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] }, include: [".notes/"] },
      {
        "core.note": [
          { item: { id: moved, properties: { title: "Moved", body: "m\n" } } },
          {
            item: {
              id: deleted,
              properties: { title: "Deleted", body: "d\n" },
            },
          },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    mkdirSync(join(b.dir, ".notes"), { recursive: true });
    renameSync(join(a.dir, "Moved.md"), join(b.dir, ".notes", "Moved.md"));
    rmSync(join(a.dir, "Deleted.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      deletesOf(a.server, moved),
      "a file moved into a dot-led directory the other folder includes was read as a delete",
    ).toBe(0);
    expect(swept.value.scan.moved_away).toBe(1);
    // The witness: the same sweep trashes a file found nowhere.
    expect(deletesOf(a.server, deleted)).toBe(1);
  });

  it("looks for a paused removal's files in the other folders before confirming it", async () => {
    const ids = [0, 1, 2, 3, 4, 5].map(
      (n) => `01a00000-0000-7000-8000-0000000017${String(n).padStart(2, "0")}`,
    );
    const { a, b } = await onOneMac(
      "confirm-looks",
      {
        query: { types: ["core.note"] },
        removal_threshold: { files: 2, fraction: 0.25 },
      },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": ids.map((id, n) => ({
          item: { id, properties: { title: `Note ${String(n)}`, body: "b\n" } },
        })),
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    // Three moved to the other folder and one deleted: a large removal.
    for (const n of [0, 1, 2]) {
      renameSync(
        join(a.dir, `Note ${String(n)}.md`),
        join(b.dir, `Note ${String(n)}.md`),
      );
    }
    rmSync(join(a.dir, "Note 3.md"));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(4);

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    expect(
      [confirmed.value.moved, confirmed.value.deleted],
      "a confirmed removal trashed files another folder on the Mac now holds",
    ).toEqual([3, 1]);
    expect((await a.folder.push()).ok).toBe(true);
    for (const n of [0, 1, 2]) expect(deletesOf(a.server, ids[n]!)).toBe(0);
    // The witness: the file found nowhere is trashed by the same confirm.
    expect(deletesOf(a.server, ids[3]!)).toBe(1);
  });

  it("trashes no item of a confirmed removal that another device changed since its file went, and writes the file back", async () => {
    const ids = [0, 1, 2, 3, 4, 5].map(
      (n) => `01a00000-0000-7000-8000-0000000043e${String(n)}`,
    );
    const { a, door, edges } = await onOneMac(
      "confirm-changed-elsewhere",
      {
        query: { types: ["core.note"] },
        removal_threshold: { files: 2, fraction: 0.25 },
      },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": ids.map((id, n) => ({
          item: { id, properties: { title: `Note ${String(n)}`, body: "b\n" } },
        })),
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    for (const n of [0, 1, 2]) rmSync(join(a.dir, `Note ${String(n)}.md`));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(3);
    edges.logItem(
      "item.updated",
      door.update(ids[0]!, {
        properties: { notes: "their annotation" },
        version: 1,
      }),
    );
    const heard = await a.folder.device().catchUp();
    expect(heard.ok && heard.value.applied).toBe(1);

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    // The witness: the two nobody changed are trashed by the same confirm.
    expect(confirmed.value.deleted).toBe(2);
    const pulled = await a.folder.push();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    for (const n of [1, 2]) expect(deletesOf(a.server, ids[n]!)).toBe(1);
    expect(
      deletesOf(a.server, ids[0]!),
      "a confirmed removal trashed an item another device changed since its file went",
    ).toBe(0);
    expect(pulled.value.pull?.revived).toBe(1);
    expect(read(a, "Note 0.md")).toContain("their annotation");
  });

  it("confirms a large removal while another folder holds files that are not text", async () => {
    const ids = [0, 1, 2, 3, 4, 5].map(
      (n) => `01a00000-0000-7000-8000-0000000018${String(n).padStart(2, "0")}`,
    );
    const { a, b } = await onOneMac(
      "confirm-not-text",
      {
        query: { types: ["core.note"] },
        removal_threshold: { files: 2, fraction: 0.25 },
      },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": ids.map((id, n) => ({
          item: { id, properties: { title: `Note ${String(n)}`, body: "b\n" } },
        })),
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    // Untidy files in the other folder: UTF-16 with and without a byte-order
    // mark, and Latin-1.
    const wide = "---\nmarfa_id: not-ours\n---\nwide\n";
    writeFileSync(
      join(b.dir, "utf16.md"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(wide, "utf16le")]),
    );
    writeFileSync(join(b.dir, "bare-utf16.md"), Buffer.from(wide, "utf16le"));
    writeFileSync(
      join(b.dir, "latin1.md"),
      Buffer.from("---\ntitle: Café\n---\nun café\n", "latin1"),
    );
    for (const n of [0, 1, 2, 3]) rmSync(join(a.dir, `Note ${String(n)}.md`));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(4);

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    expect(
      [confirmed.value.deleted, confirmed.value.unsure],
      "a file in another folder that is not text held the deletes of this one",
    ).toEqual([4, []]);
    expect((await a.folder.push()).ok).toBe(true);
    for (const n of [0, 1, 2, 3]) expect(deletesOf(a.server, ids[n]!)).toBe(1);
    for (const n of [4, 5]) expect(deletesOf(a.server, ids[n]!)).toBe(0);
  });

  it("trashes an unchanged file item's missing file from a scan with no server, whose bytes it no longer holds", async () => {
    // `folders scan` reaches no server, and a pull keeps no blob it wrote,
    // so only what the binding recorded tells whether the item changed.
    const kept = "01a00000-0000-7000-8000-0000000044b1";
    const gone = "01a00000-0000-7000-8000-0000000044b2";
    const bytesOf = (name: string) => Buffer.from(`the bytes of ${name}\n`);
    const rows = [
      [kept, "kept.png"],
      [gone, "photo.png"],
    ] as const;
    const { a } = await onOneMac(
      "scan-trashes-file-item",
      { query: { types: ["core.file.image"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.file.image": rows.map(([id, name]) => ({
          item: {
            id,
            type: "core.file.image",
            properties: {
              title: name,
              blob_ref: hashOf(bytesOf(name)),
              mime_type: "image/png",
            },
          },
        })),
      },
    );
    for (const [, name] of rows) scriptBlob(a.server, bytesOf(name));
    expect((await a.folder.pull()).ok).toBe(true);
    expect(readFileSync(join(a.dir, "photo.png"))).toEqual(
      bytesOf("photo.png"),
    );
    rmSync(join(a.dir, "photo.png"));
    // A push here would fetch the bytes again, so only scans see it go.
    const from = a.server.requests.length;
    const missing = await a.folder.scan();
    expect(missing.ok && missing.value.missing).toBe(1);
    await pastTheGrace();
    const scanned = await a.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    expect(
      a.server.requests.length,
      "a standalone scan reached the server",
    ).toBe(from);
    expect(
      scanned.value.trashed,
      "an unchanged file item's missing file was read as changed elsewhere",
    ).toEqual(["photo.png"]);
    expect((await a.folder.push()).ok).toBe(true);
    expect([deletesOf(a.server, gone), deletesOf(a.server, kept)]).toEqual([
      1, 0,
    ]);
    expect(existsSync(join(a.dir, "photo.png"))).toBe(false);
  });

  it("confirms a large removal of file items and sends their deletes without pausing again", async () => {
    const files = [0, 1, 2, 3].map(
      (n) =>
        [
          `01a00000-0000-7000-8000-0000000044c${String(n)}`,
          `photo ${String(n)}.png`,
        ] as const,
    );
    const bytesOf = (name: string) => Buffer.from(`the bytes of ${name}\n`);
    const { a } = await onOneMac(
      "confirm-file-items",
      {
        query: { types: ["core.file.image"] },
        removal_threshold: { files: 2, fraction: 0.25 },
      },
      { query: { types: ["core.bookmark"] } },
      {
        "core.file.image": files.map(([id, name]) => ({
          item: {
            id,
            type: "core.file.image",
            properties: {
              title: name,
              blob_ref: hashOf(bytesOf(name)),
              mime_type: "image/png",
            },
          },
        })),
      },
    );
    for (const [, name] of files) scriptBlob(a.server, bytesOf(name));
    expect((await a.folder.pull()).ok).toBe(true);
    const removed = files.slice(0, 3);
    for (const [, name] of removed) rmSync(join(a.dir, name));
    // Paused by a scan, which fetches nothing, as `folders confirm` does not.
    const from = a.server.requests.length;
    const paused = await a.folder.scan();
    expect(paused.ok && paused.value.paused).toBe(3);

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    expect(
      [confirmed.value.deleted, confirmed.value.unsure],
      "a confirmed removal of file items was read as changed elsewhere",
    ).toEqual([3, []]);
    expect(
      a.server.requests.length,
      "a scan or a confirm reached the server",
    ).toBe(from);
    const pushed = await a.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.paused, "the confirmed removal paused again").toBe(
      0,
    );
    expect(files.map(([id]) => deletesOf(a.server, id))).toEqual([1, 1, 1, 0]);
    for (const [, name] of removed) {
      expect(existsSync(join(a.dir, name)), `${name} was written back`).toBe(
        false,
      );
    }
  });

  it("holds a file that is not text on its own, and takes it in once it can be read", async () => {
    const gone = "01a00000-0000-7000-8000-000000001841";
    const kept = "01a00000-0000-7000-8000-000000001842";
    const { a, b } = await onOneMac(
      "not-text-alone",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
          { item: { id: kept, properties: { title: "Kept", body: "k\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const wide = Buffer.from("---\ntitle: Wide\n---\nwide\n", "utf16le");
    writeFileSync(join(b.dir, "wide.md"), wide);
    writeFileSync(join(a.dir, "wide.md"), wide);
    rmSync(join(a.dir, "Gone.md"));
    writeFileSync(
      join(a.dir, "Kept.md"),
      readFileSync(join(a.dir, "Kept.md"), "utf8").replace("k\n", "edited\n"),
    );
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      [deletesOf(a.server, gone), swept.value.scan.unsure],
      "a file that is not text, in this folder or the other, held a delete",
    ).toEqual([1, []]);
    expect(sentUpdates(a).map((sent) => sent.id)).toEqual([kept]);
    expect(
      swept.value.scan.flagged.filter((file) => file.path === "wide.md"),
      "the file that is not text is reported once",
    ).toHaveLength(1);
    expect(readFileSync(join(a.dir, "wide.md"))).toEqual(wide);
    expect(readFileSync(join(b.dir, "wide.md"))).toEqual(wide);

    // Saved as UTF-8, it is sent as any new file is.
    const before = sentTitles(a).length;
    put(a, "wide.md", "---\ntitle: Wide\n---\nwide\n");
    expect((await a.folder.push()).ok).toBe(true);
    expect(sentTitles(a).slice(before)).toEqual(["Wide"]);
  });

  it("keeps a file moved to another folder and saved again as UTF-16", async () => {
    const moved = "01a00000-0000-7000-8000-000000001851";
    const gone = "01a00000-0000-7000-8000-000000001852";
    const { a, b } = await onOneMac(
      "move-utf16",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: moved, properties: { title: "Moved", body: "m\n" } } },
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    // Saved again by an editor, so neither the file's identity nor its bytes
    // are the ones this folder knew; only its id says where it came from.
    const text = readFileSync(join(a.dir, "Moved.md"), "utf8");
    expect(text).toContain(`marfa_id: ${moved}`);
    rmSync(join(a.dir, "Moved.md"));
    rmSync(join(a.dir, "Gone.md"));
    const target = join(b.dir, "Moved.md");
    const wide = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(text, "utf16le"),
    ]);
    writeFileSync(target, wide);

    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    // The witness: the file this folder lost for good is deleted.
    expect(deletesOf(a.server, gone)).toBe(1);
    expect(
      [deletesOf(a.server, moved), swept.value.scan.moved_away],
      "a file moved and saved as UTF-16 was taken for deleted",
    ).toEqual([0, 1]);

    const held = await b.folder.push();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect(
      held.value.scan.flagged.filter((file) => file.path === "Moved.md"),
      "the other folder did not hold the file that is not text on its own",
    ).toHaveLength(1);
    expect(sentTitles(b)).toEqual([]);
    expect(readFileSync(target)).toEqual(wide);
  });
});
