import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
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
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
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
import { openBindingFolder } from "./binding-folders.shared.js";

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
    const readable = await a.folder.push();
    expect(readable.ok, JSON.stringify(readable)).toBe(true);
    expect(deletesOf(a.server, gone)).toBe(0);
    expect(await heldIn(a)).toEqual(["Gone.md"]);
    await trashHeldFiles(a, ["Gone.md"]);
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
    // The witness: the same sweep decides a file found nowhere, which it
    // holds, since the other folder may have let it go.
    expect(deletesOf(a.server, deleted)).toBe(0);
    expect(swept.value.scan.unsure.map((file) => file.path)).toEqual([
      "Deleted.md",
    ]);
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

  it("holds a missing note found in no folder on the Mac while another folder is on it, and says why", async () => {
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
    expect(swept.value.trashed).toEqual([]);
    expect(swept.value.moved_away).toBe(0);
    expect(swept.value.unsure.map((file) => file.path)).toEqual(["Gone.md"]);
    expect(swept.value.unsure[0]?.reason).toMatch(
      /^another folder is on this computer, at .+, so Marfa cannot tell its delete from a move into it$/,
    );
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, gone)).toBe(0);

    rmSync(join(a.dir, "Also gone.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const said = await a.folder.pushText();
    expect(said.ok, JSON.stringify(said)).toBe(true);
    expect(said.ok && said.value).toContain(
      "Deletion of Also gone.md is on hold because another folder is on this computer",
    );
    expect(deletesOf(a.server, alsoGone)).toBe(0);
    expect(await heldIn(a)).toEqual(["Also gone.md", "Gone.md"]);
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

      // Gone.md exercises the same deletion sweep, which holds it while
      // another folder is on the Mac.
      rmSync(join(a.dir, "Gone.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const swept = await a.folder.push();
      expect(swept.ok, JSON.stringify(swept)).toBe(true);
      if (!swept.ok) return;
      expect(swept.value.scan.unsure.map((file) => file.path)).toEqual([
        "Gone.md",
      ]);
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
    // Gone.md exercises the same deletion sweep, which holds it while
    // another folder is on the Mac.
    rmSync(join(a.dir, "Gone.md"));
    const kept = await b.folder.push();
    expect(kept.ok && kept.value.pull?.unmatched).toBe(1);
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(swept.value.scan.unsure.map((file) => file.path)).toEqual([
      "Gone.md",
    ]);
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
    await trashHeldFiles(a, ["Gone.md"]);
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
    "adopts the item's own bytes at its path, and holds a previous file's delete for the person, while another folder keeps its file ($mode, previous file $previous)",
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
      const deletes = async () => {
        const queued = await b.folder.device().queue();
        return (
          queued.ok &&
          queued.value
            .filter((row) => row.kind === "delete_item")
            .map((row) => row.item_id)
        );
      };
      expect(await deletes()).toEqual([]);
      // The replacement at this path belongs to a different item.
      expect(await heldIn(b)).toEqual(previous ? ["photo.png"] : []);
      if (previous) {
        const trashed = await b.folder.trashHeld(["photo.png"]);
        expect(trashed.ok && trashed.value.trashed).toEqual(["photo.png"]);
        expect(await deletes()).toEqual([gone.id]);
        expect(readFileSync(join(b.dir, "photo.png"))).toEqual(bytes);
      }
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
    // A text file carries no id line, so its delete waits for the person.
    expect(swept.value.scan.moved_away).toBe(0);
    expect(deletesOf(a.server, loose)).toBe(0);
    expect(await heldIn(a)).toEqual(["Loose.txt"]);
    const trashed = await a.folder.trashHeld(["Loose.txt"]);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    expect(
      trashed.ok && [trashed.value.trashed, trashed.value.moved],
      "a file with the same bytes that another folder holds as its own item was taken for the deleted one moved",
    ).toEqual([["Loose.txt"], []]);
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, loose)).toBe(1);
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

    // Adding a folder rebuilds the registry before the other folders list themselves.
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
      expect(swept.value.scan.trashed).toEqual([]);
      expect(deletesOf(a.server, gone)).toBe(0);
      expect(await heldIn(a)).toEqual(["Gone.md"]);
      await trashHeldFiles(a, ["Gone.md"]);
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

  it("holds files deleted while another folder could not be read, and writes back the items another device changed once the person keeps them", async () => {
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

    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.trashed).toEqual([]);
    expect(swept.value.pull?.revived).toBe(0);
    expect(await heldIn(a)).toEqual(names);
    for (const name of ["Changed.md", "photo.png"]) {
      expect(existsSync(join(a.dir, name))).toBe(false);
    }

    await trashHeldFiles(a, ["Plain.md"]);
    expect(deletesOf(a.server, plain.id)).toBe(1);
    const kept = await a.folder.keepHeld(["Changed.md", "photo.png"], {
      writeBack: true,
    });
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    expect(kept.ok && kept.value.written_back.sort()).toEqual([
      "Changed.md",
      "photo.png",
    ]);
    for (const id of [changed.id, photo]) {
      expect(
        deletesOf(a.server, id),
        "an item another device changed inside the grace went to the bin",
      ).toBe(0);
    }
    expect(read(a, "Changed.md")).toContain("their annotation");
    expect(idIn(a, "Changed.md")).toBe(changed.id);
    expect(readFileSync(join(a.dir, "photo.png"))).toEqual(after);

    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, changed.id)).toBe(0);
    expect(deletesOf(a.server, photo)).toBe(0);
    expect(read(a, "Changed.md")).toContain("their annotation");
  });

  it("writes back a note deleted past the grace whose item another device changed, where the Mac has no other folder", async () => {
    const changed = {
      id: "01a00000-0000-7000-8000-0000000043d4",
      properties: { title: "Changed", body: "the person's words\n" },
    };
    const plain = {
      id: "01a00000-0000-7000-8000-0000000043d5",
      properties: { title: "Plain", body: "p\n" },
    };
    const edges = new EdgeDoor();
    harness = await folderHarness("delete-past-grace-changed-alone", {
      settings: { query: { types: ["core.note"] } },
      items: { "core.note": [{ item: changed }, { item: plain }] },
      events: [edges.stream()],
    });
    const a = harness;
    let door: FolderDoor | undefined;
    scriptFolderWrites(a, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await a.folder.pull()).ok).toBe(true);
    rmSync(join(a.dir, "Changed.md"));
    rmSync(join(a.dir, "Plain.md"));
    const journaled = await a.folder.scan();
    expect(journaled.ok && journaled.value.missing).toBe(2);
    edges.logItem(
      "item.updated",
      door!.update(changed.id, {
        properties: { notes: "their annotation" },
        version: 1,
      }),
    );
    // Heard without a pull, so only the sweep can bring the file back.
    const heard = await a.folder.device().catchUp();
    expect(heard.ok && heard.value.applied).toBe(1);

    await pastTheGrace();
    const swept = await a.folder.scan();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    // The witness: the note nobody changed is trashed by the same sweep.
    expect(swept.value.trashed).toEqual(["Plain.md"]);
    expect(swept.value.unsure).toEqual([]);
    const pulled = await a.folder.push();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(deletesOf(a.server, plain.id)).toBe(1);
    expect(
      deletesOf(a.server, changed.id),
      "a sweep trashed an item another device changed since its file went",
    ).toBe(0);
    expect(pulled.value.pull?.revived).toBe(1);
    expect(read(a, "Changed.md")).toContain("their annotation");
    expect(idIn(a, "Changed.md")).toBe(changed.id);
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

  it("takes a file item at a document name moved to another folder as that item, and holds one found in no folder until the person trashes it", async () => {
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
    expect(swept.value.scan.trashed).toEqual([]);
    expect(deletesOf(a.server, files.gone[0])).toBe(0);
    expect(await heldIn(a)).toEqual([files.gone[1]]);
    await trashHeldFiles(a, [files.gone[1]]);
    expect(deletesOf(a.server, files.gone[0])).toBe(1);
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
        // The file found nowhere carries no id line, so it is held.
        expect(swept.value.scan.trashed).toEqual([]);
        expect(swept.value.scan.unsure.map((file) => file.path)).toEqual([
          files.gone[1],
        ]);
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
      // The witness that deletes are sent: the person trashes the held one.
      expect(await heldIn(a)).toEqual([files.gone[1]]);
      await trashHeldFiles(a, [files.gone[1]]);

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

  /** The paths `folders held` lists for a folder, in order. */
  async function heldIn(h: FolderHarness): Promise<string[]> {
    const held = await h.folder.held();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    return held.ok ? held.value.held.map((file) => file.path).sort() : [];
  }

  /**
   * The folder a file left scans, unless it has seen the file gone already,
   * waits out the grace and scans again. It sends no delete of the moved
   * file's item and holds the file for the person, across a later scan too.
   * `Gone.md`, deleted for real, is the witness that deletes are sent: the
   * same sweep holds it, since another folder is on the Mac, and its delete
   * is sent once the person trashes it.
   */
  async function heldAfterMove(
    a: FolderHarness,
    moved: { id: string; path: string },
    gone: string,
    options: { seen?: boolean } = {},
  ): Promise<void> {
    if (options.seen !== true) expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      deletesOf(a.server, moved.id),
      "a file moved to another folder was read as a delete once that folder let it go, and its item trashed",
    ).toBe(0);
    expect(swept.value.scan.unsure.map((file) => file.path)).toContain(
      moved.path,
    );
    expect(await heldIn(a)).toEqual(["Gone.md", moved.path].sort());
    // Unconfirmed, the trash is refused.
    const unasked = await a.folder
      .device()
      .root(["folders", "held", a.dir, "--trash", "Gone.md"]);
    expect(unasked.ok, JSON.stringify(unasked)).toBe(false);
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, gone)).toBe(0);
    await trashHeldFiles(a, ["Gone.md"]);
    expect(deletesOf(a.server, gone)).toBe(1);
    expect(await heldIn(a)).toEqual([moved.path]);

    const later = await a.folder.push();
    expect(later.ok, JSON.stringify(later)).toBe(true);
    expect(deletesOf(a.server, moved.id)).toBe(0);
    expect(await heldIn(a)).toEqual([moved.path]);
  }

  /** Trashes held files' items as the person would, and sends the deletes. */
  async function trashHeldFiles(
    h: FolderHarness,
    paths: string[],
  ): Promise<void> {
    const trashed = await h.folder.trashHeld(paths);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    expect(trashed.ok && trashed.value.trashed).toEqual(paths);
    expect((await h.folder.push()).ok).toBe(true);
  }

  /** Keeps a held file's item, and checks no later scan trashes it. */
  async function keptHeld(
    a: FolderHarness,
    moved: { id: string; path: string },
    writeBack = false,
  ): Promise<void> {
    const kept = await a.folder.keepHeld([moved.path], { writeBack });
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.kept).toEqual([moved.path]);
    expect(kept.value.written_back).toEqual(writeBack ? [moved.path] : []);
    expect(await heldIn(a)).toEqual([]);
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, moved.id)).toBe(0);
  }

  /** Archives `item` on the server and tells the folders. */
  function archive(
    door: FolderDoor,
    edges: EdgeDoor,
    item: WireItemOptions,
    tags: string[],
  ): void {
    door.transition(item.id, "archived");
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.updated",
        wireItem({ ...item, version: 2, state: "archived" }),
        { tags },
      ),
    );
  }

  it("trashes a deleted note's item where the Mac has no other folder, and says so", async () => {
    const gone = {
      id: "01a00000-0000-7000-8000-000000004603",
      properties: { title: "Gone", body: "deleted for real\n" },
    };
    const alsoGone = {
      id: "01a00000-0000-7000-8000-000000004604",
      properties: { title: "Also gone", body: "deleted too\n" },
    };
    harness = await folderHarness("alone-deleted", {
      settings: { query: { types: ["core.note"] } },
      items: { "core.note": [{ item: gone }, { item: alsoGone }] },
    });
    const a = harness;
    scriptFolderWrites(a);
    expect((await a.folder.pull()).ok).toBe(true);
    rmSync(join(a.dir, "Gone.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    expect(swept.ok && swept.value.scan.trashed).toEqual(["Gone.md"]);
    expect(deletesOf(a.server, gone.id)).toBe(1);
    expect(await heldIn(a)).toEqual([]);

    rmSync(join(a.dir, "Also gone.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const said = await a.folder.pushText();
    expect(said.ok, JSON.stringify(said)).toBe(true);
    expect(said.ok && said.value).toContain(
      "Also gone.md was found in no directory on this machine, so its item was trashed",
    );
    expect(deletesOf(a.server, alsoGone.id)).toBe(1);
  });

  it("holds a file moved to another folder that lets it go when its item is archived, until the person keeps its item", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000045a1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const gone = {
      id: "01a00000-0000-7000-8000-0000000045a2",
      properties: { title: "Gone", body: "deleted for real\n" },
    };
    const { a, b, door, edges } = await onOneMac(
      "moved-then-archived",
      { query: { types: ["core.note"] } },
      {
        query: {
          types: ["core.note"],
          filter: 'tags contains "b"',
          state: ["active"],
        },
      },
      { "core.note": [{ item: plan, tags: ["b"] }, { item: gone }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    rmSync(join(a.dir, "Gone.md"));
    expect((await b.folder.push()).ok).toBe(true);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
    expect(edges.placements(b.settings.id).get(plan.id)).toBe("Plan.md");
    // The source sweeps before its pull can see the archive.
    expect((await a.folder.push()).ok).toBe(true);

    archive(door, edges, plan, ["b"]);
    const dropped = await b.folder.push();
    expect(dropped.ok, JSON.stringify(dropped)).toBe(true);
    expect(dropped.ok && dropped.value.pull?.removed).toBe(1);
    expect(existsSync(join(b.dir, "Plan.md"))).toBe(false);

    await heldAfterMove(a, { id: plan.id, path: "Plan.md" }, gone.id, {
      seen: true,
    });
    await keptHeld(a, { id: plan.id, path: "Plan.md" });
    expect(door.rows.get(plan.id)?.state).toBe("archived");
  });

  it("holds a file moved to another folder whose unmatched files are then removed, until the person keeps its item and writes it back", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000045b1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const gone = {
      id: "01a00000-0000-7000-8000-0000000045b2",
      properties: { title: "Gone", body: "deleted for real\n" },
    };
    const { a, b, door } = await onOneMac(
      "moved-then-unmatched-removed",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: plan }, { item: gone }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    rmSync(join(a.dir, "Gone.md"));
    const kept = await b.folder.push();
    expect(kept.ok && kept.value.pull?.unmatched).toBe(1);
    const removed = await b.folder.removeUnmatched({ yes: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(existsSync(join(b.dir, "Plan.md"))).toBe(false);

    await heldAfterMove(a, { id: plan.id, path: "Plan.md" }, gone.id);
    expect(existsSync(join(a.dir, "Plan.md"))).toBe(false);
    await keptHeld(a, { id: plan.id, path: "Plan.md" }, true);
    expect(idIn(a, "Plan.md")).toBe(plan.id);
    expect(read(a, "Plan.md")).toContain("the plan\n");
    expect(door.rows.get(plan.id)?.properties.body).toBe("the plan\n");
  });

  it("holds a file moved to another folder that is then removed from the Mac, and trashes a file deleted for real only once the person says so", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000045c1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const gone = {
      id: "01a00000-0000-7000-8000-0000000045c2",
      properties: { title: "Gone", body: "deleted for real\n" },
    };
    const { a, b } = await onOneMac(
      "moved-then-folder-removed",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      {
        "core.note": [
          { item: plan, tags: ["a"] },
          { item: gone, tags: ["a"] },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    rmSync(join(a.dir, "Gone.md"));
    const kept = await b.folder.push();
    expect(kept.ok && kept.value.pull?.unmatched).toBe(1);
    // The folder it left sees it gone while the other folder is listed.
    expect((await a.folder.push()).ok).toBe(true);
    const removed = await b.folder.remove();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(idIn(b, "Plan.md")).toBe(plan.id);

    // A folder it remembers and can no longer open may hold either file.
    await heldAfterMove(a, { id: plan.id, path: "Plan.md" }, gone.id, {
      seen: true,
    });
    await keptHeld(a, { id: plan.id, path: "Plan.md" });
    expect(idIn(b, "Plan.md")).toBe(plan.id);
  });

  it("holds a file item moved to another folder that then saves new bytes over it, until the person keeps its item", async () => {
    const photo = "01a00000-0000-7000-8000-0000000045d1";
    const gone = "01a00000-0000-7000-8000-0000000045d2";
    const bytesOf = (name: string) => Buffer.from(`the bytes of ${name}\n`);
    const { a, b, edges } = await onOneMac(
      "moved-then-rewritten",
      { query: { types: ["core.file"] } },
      { query: { types: ["core.file"], filter: 'tags contains "b"' } },
      {
        "core.file": [
          [photo, "photo.bin"],
          [gone, "Gone.md"],
        ].map(([id, name]) => ({
          item: {
            id,
            type: "core.file",
            properties: { title: name, blob_ref: hashOf(bytesOf(name)) },
          },
        })),
      },
    );
    for (const name of ["photo.bin", "Gone.md"]) {
      scriptBlob(a.server, bytesOf(name));
    }
    acceptUploads(a.server);
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "photo.bin"), join(b.dir, "photo.bin"));
    rmSync(join(a.dir, "Gone.md"));
    expect((await b.folder.push()).ok).toBe(true);
    expect(edges.placements(b.settings.id).get(photo)).toBe("photo.bin");
    expect((await a.folder.push()).ok).toBe(true);
    // An editor there replaces it, and that folder sends the new bytes.
    saveAtomically(b, "photo.bin", Buffer.from("edited photo bytes\n"));
    const sent = await b.folder.push();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect(edges.placements(b.settings.id).get(photo)).toBe("photo.bin");

    await heldAfterMove(a, { id: photo, path: "photo.bin" }, gone, {
      seen: true,
    });
    await keptHeld(a, { id: photo, path: "photo.bin" });
    expect(edges.placements(b.settings.id).get(photo)).toBe("photo.bin");
  });

  it("holds a note moved to another folder by copy and delete when that folder's query comes to hold it, until the person keeps its item", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000045e1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const gone = {
      id: "01a00000-0000-7000-8000-0000000045e2",
      properties: { title: "Gone", body: "deleted for real\n" },
    };
    const { a, b, edges } = await onOneMac(
      "copied-then-widened",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: plan }, { item: gone }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    copyFileSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    rmSync(join(a.dir, "Plan.md"));
    rmSync(join(a.dir, "Gone.md"));
    const kept = await b.folder.push();
    expect(kept.ok && kept.value.pull?.unmatched).toBe(1);
    b.settings.settings = { query: { types: ["core.note"] } };
    b.settings.version += 1;
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.updated",
        folderItem(b.settings),
      ),
    );
    const widened = await b.folder.push();
    expect(widened.ok, JSON.stringify(widened)).toBe(true);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
    // The widened folder writes the other item's file too.
    expect(idIn(b, "Gone.md")).toBe(gone.id);

    await heldAfterMove(a, { id: plan.id, path: "Plan.md" }, gone.id);
    await keptHeld(a, { id: plan.id, path: "Plan.md" });
    expect(idIn(b, "Plan.md")).toBe(plan.id);
  });

  it("holds a file an earlier release took into another folder that then takes it away when its item is archived, until the person keeps its item", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000045f1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const gone = {
      id: "01a00000-0000-7000-8000-0000000045f2",
      properties: { title: "Gone", body: "deleted for real\n" },
    };
    const { a, b, door, edges } = await onOneMac(
      "taken-in-then-archived",
      { query: { types: ["core.note"], filter: 'tags contains "a"' } },
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
    // The earlier take-in preserved the inode and recorded a folder write.
    renameSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    rmSync(join(a.dir, "Gone.md"));
    expect((await b.folder.push()).ok).toBe(true);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
    const store = new DatabaseSync(join(b.dir, ".marfa", "core.sqlite"));
    try {
      store.exec("UPDATE folder_files SET written_hash = content_hash");
    } finally {
      store.close();
    }

    archive(door, edges, plan, ["b"]);
    const dropped = await b.folder.push();
    expect(dropped.ok, JSON.stringify(dropped)).toBe(true);
    expect(dropped.ok && dropped.value.pull?.removed).toBe(1);
    expect(existsSync(join(b.dir, "Plan.md"))).toBe(false);

    await heldAfterMove(a, { id: plan.id, path: "Plan.md" }, gone.id);
    await keptHeld(a, { id: plan.id, path: "Plan.md" });
    expect(door.rows.get(plan.id)?.state).toBe("archived");
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

  it("holds missing notes while two other folders are on the Mac, a note copied into both of them included, until the person trashes them", async () => {
    const gone = "01a00000-0000-7000-8000-0000000016f1";
    const copied = "01a00000-0000-7000-8000-0000000016f2";
    let third: FolderItem | undefined;
    const { a, b } = await onOneMac(
      "held-several",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
          {
            item: { id: copied, properties: { title: "Copied", body: "c\n" } },
          },
        ],
      },
      (server) => {
        third = scriptFolderItem(server, {
          query: { types: ["core.bookmark"] },
        });
      },
    );
    const c = await folderHarness("held-several-c", {
      sharing: { server: a.server, key: KEY },
      folder: third,
      registry: a.registry,
    });
    try {
      expect((await a.folder.pull()).ok).toBe(true);
      for (const to of [b, c]) {
        copyFileSync(join(a.dir, "Copied.md"), join(to.dir, "Copied.md"));
      }
      rmSync(join(a.dir, "Gone.md"));
      rmSync(join(a.dir, "Copied.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const swept = await a.folder.push();
      expect(swept.ok, JSON.stringify(swept)).toBe(true);
      if (!swept.ok) return;
      expect([swept.value.scan.trashed, swept.value.scan.moved_away]).toEqual([
        [],
        0,
      ]);
      const reasons = Object.fromEntries(
        swept.value.scan.unsure.map((file) => [file.path, file.reason]),
      );
      expect(reasons["Gone.md"]).toBe(
        "2 other folders are on this computer, so Marfa cannot tell its delete from a move into one of them",
      );
      expect(
        reasons["Copied.md"],
        "a note found in two other folders was taken for a move into one of them",
      ).toMatch(/^2 files in other folders carry its id/);
      expect([deletesOf(a.server, gone), deletesOf(a.server, copied)]).toEqual([
        0, 0,
      ]);
      // The witness: the person's trash sends both deletes.
      await trashHeldFiles(a, ["Copied.md", "Gone.md"]);
      expect([deletesOf(a.server, gone), deletesOf(a.server, copied)]).toEqual([
        1, 1,
      ]);
    } finally {
      await c.stop();
    }
  });

  it("holds a delete whose file another folder holds as its own through a hard link", async () => {
    const plan = "01a00000-0000-7000-8000-0000000016f3";
    const { a, b } = await onOneMac(
      "held-hard-link",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.note"] } },
      {
        "core.note": [
          { item: { id: plan, properties: { title: "Plan", body: "p\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    // The other folder's file of the item becomes another name of this one's.
    rmSync(join(b.dir, "Plan.md"));
    linkSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    expect((await b.folder.push()).ok).toBe(true);

    rmSync(join(a.dir, "Plan.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      swept.value.scan.moved_away,
      "the other folder's own file of the item, a hard link of this one, was taken for this file moved",
    ).toBe(0);
    expect(deletesOf(a.server, plan)).toBe(0);
    expect(await heldIn(a)).toEqual(["Plan.md"]);
    expect(existsSync(join(b.dir, "Plan.md"))).toBe(true);
  });

  it("holds both deletes of two files with the same bytes when another folder has one file with them", async () => {
    const { a, b } = await onOneMac(
      "held-two-sources",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    put(a, "One.txt", "twin words\n");
    put(a, "Two.txt", "twin words\n");
    expect((await a.folder.push()).ok).toBe(true);
    const ids = sentCreates(a).map((sent) => String(sent.id));
    expect(ids).toHaveLength(2);
    copyFileSync(join(a.dir, "One.txt"), join(b.dir, "Three.txt"));
    rmSync(join(a.dir, "One.txt"));
    rmSync(join(a.dir, "Two.txt"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(
      swept.value.scan.moved_away,
      "one file with the bytes two missing files had was taken for a move of one of them",
    ).toBe(0);
    expect(
      swept.value.scan.unsure.map((file) => [file.path, file.reason]),
    ).toEqual(
      ["One.txt", "Two.txt"].map((path) => [
        path,
        expect.stringMatching(/^2 files in this folder have its bytes/),
      ]),
    );
    for (const id of ids) expect(deletesOf(a.server, id)).toBe(0);
    // The witness: the person's trash sends the delete.
    await trashHeldFiles(a, ["One.txt"]);
    expect(ids.map((id) => deletesOf(a.server, id))).toEqual([1, 0]);
    expect(await heldIn(a)).toEqual(["Two.txt"]);
  });

  it("keeps a held delete through a scan that cannot read its directory", async () => {
    const { a } = await onOneMac(
      "held-unreadable-pass",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {},
    );
    const sub = join(a.dir, "sub");
    mkdirSync(sub);
    put(a, "sub/Gone.txt", "gone words\n");
    put(a, "sub/Stays.txt", "stays\n");
    expect((await a.folder.push()).ok).toBe(true);
    const gone = String(
      sentCreates(a).find((sent) => JSON.stringify(sent).includes("gone words"))
        ?.id,
    );
    rmSync(join(sub, "Gone.txt"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(await heldIn(a)).toEqual(["sub/Gone.txt"]);

    chmodSync(sub, 0o000);
    try {
      const sealed = await a.folder.push();
      expect(sealed.ok, JSON.stringify(sealed)).toBe(true);
    } finally {
      chmodSync(sub, 0o755);
    }
    expect(
      await heldIn(a),
      "a scan that could not read the held file's directory ended its hold",
    ).toEqual(["sub/Gone.txt"]);
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, gone)).toBe(0);
    await trashHeldFiles(a, ["sub/Gone.txt"]);
    expect(deletesOf(a.server, gone)).toBe(1);
  });

  it("answers moved for a held delete whose path another note's file took once another folder holds its file, and keeps that note's file", async () => {
    const gone = "01a00000-0000-7000-8000-0000000016f4";
    const { a, b } = await onOneMac(
      "held-trash-rebound",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const saved = readFileSync(join(a.dir, "Gone.md"));
    rmSync(join(a.dir, "Gone.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(await heldIn(a)).toEqual(["Gone.md"]);

    put(a, "Other.md", "other words\n");
    expect((await a.folder.push()).ok).toBe(true);
    const other = String(sentCreates(a)[0]?.id);
    renameSync(join(a.dir, "Other.md"), join(a.dir, "Gone.md"));
    const rebound = await a.folder.push();
    expect(rebound.ok, JSON.stringify(rebound)).toBe(true);
    expect(
      rebound.ok && rebound.value.pull?.written,
      "a pull wrote a held file's item again once another file took its path",
    ).toBe(0);
    writeFileSync(join(b.dir, "Recovered.md"), saved);

    const settled = await a.folder.trashHeld(["Gone.md"]);
    expect(settled.ok, JSON.stringify(settled)).toBe(true);
    if (!settled.ok) return;
    expect([settled.value.moved, settled.value.trashed]).toEqual([
      ["Gone.md"],
      [],
    ]);
    expect(await heldIn(a)).toEqual([]);
    expect((await a.folder.push()).ok).toBe(true);
    expect([deletesOf(a.server, gone), deletesOf(a.server, other)]).toEqual([
      0, 0,
    ]);
    const status = await a.folder.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    expect(
      status.ok &&
        status.value.files
          .filter((file) => file.path === "Gone.md")
          .map((file) => file.item_id),
      "trashing the held file let go of the other note's file at its path",
    ).toEqual([other]);
    expect(readFileSync(join(a.dir, "Gone.md"), "utf8")).toContain(
      "other words",
    );
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

  it("holds a file item deleted where both folders hold it, and trashes it once the person says so", async () => {
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
    expect(swept.value.scan.moved_away).toBe(0);
    expect(deletesOf(a.server, photo)).toBe(0);
    expect(await heldIn(a)).toEqual(["photo.png"]);
    const trashed = await a.folder.trashHeld(["photo.png"]);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    expect(
      trashed.ok && [trashed.value.trashed, trashed.value.moved],
      "the other folder's own file of an item both hold was taken for this one moved, by its bytes",
    ).toEqual([["photo.png"], []]);
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, photo)).toBe(1);
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

      // Gone.md exercises the same deletion sweep, which holds it while
      // another folder is on the Mac.
      rmSync(join(a.dir, "Gone.md"));
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const swept = await a.folder.push();
      expect(swept.ok, JSON.stringify(swept)).toBe(true);
      if (!swept.ok) return;
      expect(swept.value.scan.unsure.map((file) => file.path)).toEqual([
        "Gone.md",
      ]);
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

  it("holds a delete when the registry it was listed in is gone, lists itself again, and finds the file moved when the person settles it", async () => {
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

    expect((await a.folder.push()).ok).toBe(true);
    expect(await heldIn(a)).toEqual(["Moved.md"]);
    const settled = await a.folder.trashHeld(["Moved.md"]);
    expect(settled.ok, JSON.stringify(settled)).toBe(true);
    expect(settled.ok && [settled.value.moved, settled.value.trashed]).toEqual([
      ["Moved.md"],
      [],
    ]);
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, moved)).toBe(0);
    expect(await heldIn(a)).toEqual([]);
  });

  it("holds a delete while a listed folder is missing, and finds the file moved there when the person settles it once the folder lists itself again", async () => {
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
    expect(await heldIn(a)).toEqual(["Moved.md"]);
    const settled = await a.folder.trashHeld(["Moved.md"]);
    expect(settled.ok, JSON.stringify(settled)).toBe(true);
    expect(settled.ok && [settled.value.moved, settled.value.trashed]).toEqual([
      ["Moved.md"],
      [],
    ]);
    expect((await a.folder.push()).ok).toBe(true);
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
    const swept = await a.folder.push();
    expect(swept.ok && swept.value.scan.trashed).toEqual([]);
    expect(await heldIn(a)).toEqual(["Gone.md"]);
    await trashHeldFiles(a, ["Gone.md"]);
    expect(deletesOf(a.server, gone)).toBe(1);
  });

  /** `a` remembers `b`, which is removed, leaving its directory. */
  async function rememberingGone(
    label: string,
    ids: [string, string],
    before?: (server: ScriptedServer) => void,
  ): Promise<{ a: FolderHarness; b: FolderHarness }> {
    const { a, b } = await remembering(label, ids, before);
    expect((await b.folder.remove()).ok).toBe(true);
    return { a, b };
  }

  /** `a` remembers `b`, still listed. */
  async function remembering(
    label: string,
    ids: [string, string],
    before?: (server: ScriptedServer) => void,
  ): Promise<{ a: FolderHarness; b: FolderHarness }> {
    const [first, held] = ids;
    const { a, b } = await onOneMac(
      label,
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: first, properties: { title: "First", body: "f\n" } } },
          { item: { id: held, properties: { title: "Held", body: "h\n" } } },
        ],
      },
      before,
    );
    expect((await a.folder.pull()).ok).toBe(true);
    // Holding this delete for the other folder makes this one remember it.
    rmSync(join(a.dir, "First.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(await heldIn(a)).toEqual(["First.md"]);
    await trashHeldFiles(a, ["First.md"]);
    expect(deletesOf(a.server, first)).toBe(1);
    return { a, b };
  }

  /** Takes `b` off the registry it shares with `a`, leaving its state. */
  function unlist(b: FolderHarness): void {
    const listing = JSON.parse(readFileSync(b.registry, "utf8")) as {
      folders: Array<{ dir: string }>;
    };
    listing.folders = listing.folders.filter((entry) => entry.dir !== b.dir);
    writeFileSync(b.registry, JSON.stringify(listing));
  }

  async function deletedByHand(a: FolderHarness): Promise<void> {
    rmSync(join(a.dir, "Held.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
  }

  async function heldUnsure(a: FolderHarness): Promise<void> {
    const status = await a.folder.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    const file = status.value.files.find((entry) => entry.path === "Held.md");
    expect(
      [file?.status, file?.flag],
      "a held delete read as a write waiting to be sent",
    ).toEqual(["held", "unsure"]);
  }

  it("holds a delete as a held file while a folder no longer listed cannot be read or is gone", async () => {
    const held = "01a00000-0000-7000-8000-0000000035b2";
    const { a, b } = await rememberingGone("remembered-gone", [
      "01a00000-0000-7000-8000-0000000035b1",
      held,
    ]);
    const there = realpathSync(b.dir);
    chmodSync(b.dir, 0o000);
    try {
      await deletedByHand(a);
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
      expect(kept.value.scan.unsure[0]?.reason).toContain(
        `the folder ${there} cannot be reached, and the registry no longer lists it; if its volume is not mounted, mount it, and if it is gone, \`folders forget\` it`,
      );
      await heldUnsure(a);
      expect(lastReport(a).problems).toContainEqual({
        code: "held_file",
        count: 1,
      });
    } finally {
      chmodSync(b.dir, 0o755);
    }

    // Gone from a volume that is mounted reads as a volume that is not.
    rmSync(b.dir, { recursive: true });
    const missing = await a.folder.push();
    expect(
      missing.ok && missing.value.scan.trashed,
      "a delete was sent for a folder whose directory cannot be found",
    ).toEqual([]);
    expect(deletesOf(a.server, held)).toBe(0);
    await heldUnsure(a);
  });

  it("holds a delete for a folder no longer listed while another folder's state stands at its directory, and once its directory holds no state, until the person trashes it", async () => {
    let more: FolderItem | undefined;
    const held = "01a00000-0000-7000-8000-0000000035b4";
    const { a, b } = await rememberingGone(
      "remembered-replaced",
      ["01a00000-0000-7000-8000-0000000035b3", held],
      (server) => {
        more = scriptFolderItem(server, { query: { types: ["core.event"] } });
      },
    );
    const third = await folderHarness("remembered-replaced-c", {
      sharing: { server: a.server, key: KEY },
      folder: more,
      registry: a.registry,
    });
    try {
      rmSync(join(b.dir, ".marfa"), { recursive: true, force: true });
      cpSync(join(third.dir, ".marfa"), join(b.dir, ".marfa"), {
        recursive: true,
      });
      await deletedByHand(a);
      const replaced = await a.folder.push();
      expect(
        replaced.ok && replaced.value.scan.trashed,
        "a delete was sent for a folder whose directory holds another folder's state",
      ).toEqual([]);
      expect(deletesOf(a.server, held)).toBe(0);
      await heldUnsure(a);

      // The directory, now with no folder state, does not settle the hold.
      rmSync(join(b.dir, ".marfa"), { recursive: true, force: true });
      const swept = await a.folder.push();
      expect(swept.ok && swept.value.scan.trashed).toEqual([]);
      await heldUnsure(a);
      // The witness: the person's trash sends the delete the hold kept.
      await trashHeldFiles(a, ["Held.md"]);
      expect(deletesOf(a.server, held)).toBe(1);
    } finally {
      await third.stop();
    }
  });

  it("keeps a delete held for a folder no longer listed once its store is listed at another directory, until the person trashes it", async () => {
    const held = "01a00000-0000-7000-8000-0000000035b6";
    const { a, b } = await remembering("remembered-moved", [
      "01a00000-0000-7000-8000-0000000035b5",
      held,
    ]);
    unlist(b);
    const moved = `${realpathSync(b.dir)}-moved`;
    renameSync(b.dir, moved);
    await deletedByHand(a);
    const kept = await a.folder.push();
    expect(
      kept.ok && kept.value.scan.trashed,
      "a delete was sent for a folder no longer listed whose directory cannot be found",
    ).toEqual([]);
    expect(deletesOf(a.server, held)).toBe(0);
    await heldUnsure(a);

    // A command at its new directory lists the folder there.
    const there = new CliFolder(moved, {
      binary: requireBinary(),
      url: a.server.url,
      key: KEY,
      registry: a.registry,
    });
    expect((await there.push()).ok).toBe(true);
    const listed = await a.folder.list();
    expect(listed.ok && listed.value.map((entry) => entry.dir)).toContain(
      moved,
    );
    const swept = await a.folder.push();
    expect(
      swept.ok && swept.value.scan.trashed,
      "a scan settled a held delete",
    ).toEqual([]);
    await heldUnsure(a);
    // Read at its new directory, the folder holds no file of the item.
    await trashHeldFiles(a, ["Held.md"]);
    expect(deletesOf(a.server, held)).toBe(1);
  });

  /** `a` holds `Held.md` for `b`, a folder no longer listed whose directory is gone. */
  async function heldForGone(
    label: string,
    ids: [string, string],
    before?: (server: ScriptedServer) => void,
  ): Promise<{ a: FolderHarness; there: string }> {
    const { a, b } = await rememberingGone(label, ids, before);
    const there = realpathSync(b.dir);
    rmSync(b.dir, { recursive: true });
    await deletedByHand(a);
    const kept = await a.folder.push();
    expect(
      kept.ok && kept.value.scan.trashed,
      "a delete was sent for a folder no longer listed whose directory is gone",
    ).toEqual([]);
    expect(deletesOf(a.server, ids[1])).toBe(0);
    await heldUnsure(a);
    return { a, there };
  }

  it("holds a delete for a folder no longer listed whose directory is gone until the person forgets that exact directory, then sends it with no other folder on the Mac", async () => {
    const held = "01a00000-0000-7000-8000-0000000035e2";
    const { a, there } = await heldForGone("forget-gone", [
      "01a00000-0000-7000-8000-0000000035e1",
      held,
    ]);
    const self = realpathSync(a.dir);
    const reasons = await a.folder.held();
    expect(reasons.ok && reasons.value.held[0]?.reason).toContain(
      `the folder ${there} cannot be reached, and the registry no longer lists it; if its volume is not mounted, mount it, and if it is gone, \`folders forget\` it`,
    );

    // A path no folder remembers changes nothing and is said so.
    const never = await a.folder.forgetText(`${there}-never`, { yes: true });
    expect(never.ok, JSON.stringify(never)).toBe(true);
    expect(never.ok && never.value.exit).toBe(0);
    expect(never.ok && never.value.text).toContain(
      `no folder on this computer remembers ${there}-never`,
    );
    // Another case in the part that is gone is another path, only pointed out.
    const cased = join(dirname(there), basename(there).toUpperCase());
    const near = await a.folder.forget(cased, { yes: true });
    expect(near.ok, JSON.stringify(near)).toBe(true);
    if (!near.ok) return;
    expect(near.value).toMatchObject({
      folders: [],
      alike: [there],
      forgotten: [],
      declined: false,
      exit: 0,
    });

    // Without --yes and off a terminal, it shows what it would do and does
    // nothing, a trailing slash naming the same directory.
    const shown = await a.folder.forget(`${there}/`);
    expect(shown.ok, JSON.stringify(shown)).toBe(true);
    if (!shown.ok) return;
    expect(shown.value).toMatchObject({
      dir: there,
      listed: false,
      not_read: [],
      declined: true,
      forgotten: [],
      not_changed: [],
      exit: 0,
    });
    expect(
      shown.value.folders.map((folder) => [
        folder.dir,
        folder.held.map((file) => file.path),
      ]),
    ).toEqual([[self, ["Held.md"]]]);
    const said = await a.folder.forgetText(there);
    expect(said.ok && said.value.text).toContain(
      `Folders that remember ${there} or have a deletion on hold for it (1)`,
    );
    expect(said.ok && said.value.text).toContain("    Held.md");
    expect(said.ok && said.value.text).toContain("nothing was forgotten");
    const still = await a.folder.push();
    expect(still.ok && still.value.scan.trashed).toEqual([]);
    expect(deletesOf(a.server, held)).toBe(0);
    await heldUnsure(a);

    const forgotten = await a.folder.forgetText(there, { yes: true });
    expect(forgotten.ok, JSON.stringify(forgotten)).toBe(true);
    if (!forgotten.ok) return;
    expect(forgotten.value.exit).toBe(0);
    expect(forgotten.value.text).toContain(
      `Folders that remember ${there} or have a deletion on hold for it (1)`,
    );
    expect(forgotten.value.text).toContain(
      `${self} no longer remembers ${there}. Its next pass reconsiders these held deletions:\n  Held.md`,
    );
    expect(await heldIn(a)).toEqual([]);
    const queued = await a.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    expect(
      queued.ok && queued.value.filter((entry) => entry.kind === "delete_item"),
      "the forget queued a delete itself",
    ).toEqual([]);
    const again = await a.folder.forget(there, { yes: true });
    expect(again.ok && again.value.folders).toEqual([]);

    // The next pass decides the file as any missing file: no other folder is
    // on the Mac, so its delete is sent.
    const sent = await a.folder.push();
    expect(sent.ok && sent.value.scan.trashed).toEqual(["Held.md"]);
    expect(deletesOf(a.server, held)).toBe(1);
  });

  it("refuses to forget a directory where something stands that may still be the folder, and forgets it once it holds nothing but what the Mac writes by itself", async () => {
    const held = "01a00000-0000-7000-8000-0000000035ec";
    const { a, there } = await heldForGone("forget-occupied", [
      "01a00000-0000-7000-8000-0000000035eb",
      held,
    ]);
    mkdirSync(there);
    writeFileSync(join(there, "Held.md"), "h\n");
    const occupied = await a.folder.forget(there, { yes: true });
    expect(occupied.ok, JSON.stringify(occupied)).toBe(false);
    expect(!occupied.ok && occupied.refusal.raw).toContain("is not empty");
    expect(!occupied.ok && occupied.refusal.raw).toContain("unmount");
    expect(await heldIn(a)).toEqual(["Held.md"]);

    rmSync(join(there, "Held.md"));
    chmodSync(there, 0o000);
    let sealed: Awaited<ReturnType<typeof a.folder.forget>>;
    try {
      sealed = await a.folder.forget(there, { yes: true });
    } finally {
      chmodSync(there, 0o700);
    }
    expect(sealed.ok, JSON.stringify(sealed)).toBe(false);
    expect(!sealed.ok && sealed.refusal.raw).toContain("cannot be read");
    expect(await heldIn(a)).toEqual(["Held.md"]);
    const kept = await a.folder.push();
    expect(kept.ok && kept.value.scan.trashed).toEqual([]);
    expect(deletesOf(a.server, held)).toBe(0);

    // An empty directory, as an unmounted volume's mount point leaves, but
    // for what the Mac writes there by itself.
    writeFileSync(join(there, ".DS_Store"), "finder\n");
    mkdirSync(join(there, ".Spotlight-V100"));
    const forgotten = await a.folder.forget(there, { yes: true });
    expect(forgotten.ok, JSON.stringify(forgotten)).toBe(true);
    if (!forgotten.ok) return;
    expect(forgotten.value.forgotten.map((folder) => folder.released)).toEqual([
      ["Held.md"],
    ]);
    const sent = await a.folder.push();
    expect(sent.ok && sent.value.scan.trashed).toEqual(["Held.md"]);
    expect(deletesOf(a.server, held)).toBe(1);
  });

  it("keeps a folder remembered while a copy of its saved state is listed at another directory, and sends no delete for a file moved into it once the copy is removed and forgotten", async () => {
    const held = "01a00000-0000-7000-8000-0000000035ee";
    const { a, b } = await remembering("forget-copy", [
      "01a00000-0000-7000-8000-0000000035ed",
      held,
    ]);
    // Listed, the copy takes the place of the folder it was copied from.
    const copy = join(tempFolder("forget-copy-c"), "copy");
    mkdirSync(copy);
    cpSync(join(b.dir, ".marfa"), join(copy, ".marfa"), { recursive: true });
    const copied = new CliFolder(copy, {
      binary: requireBinary(),
      url: a.server.url,
      key: KEY,
      registry: a.registry,
    });
    expect((await copied.scan()).ok).toBe(true);
    const listed = await a.folder.list();
    expect(listed.ok && listed.value.map((entry) => entry.dir)).toContain(
      realpathSync(copy),
    );
    expect(listed.ok && listed.value.map((entry) => entry.dir)).not.toContain(
      realpathSync(b.dir),
    );

    renameSync(join(a.dir, "Held.md"), join(b.dir, "Held.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, held)).toBe(0);

    expect((await copied.remove()).ok).toBe(true);
    const gone = realpathSync(copy);
    rmSync(copy, { recursive: true });
    const forgotten = await a.folder.forget(gone, { yes: true });
    expect(forgotten.ok, JSON.stringify(forgotten)).toBe(true);
    const after = await a.folder.push();
    expect(after.ok && after.value.scan.trashed).toEqual([]);
    expect(
      deletesOf(a.server, held),
      "a delete was sent for a file moved into a folder whose copy was forgotten",
    ).toBe(0);
    expect(existsSync(join(b.dir, "Held.md"))).toBe(true);
  });

  it("forgets a gone folder in the folders it can read, names one it cannot read and exits 3, and holds the delete it released again while another folder is listed", async () => {
    let more: FolderItem | undefined;
    const held = "01a00000-0000-7000-8000-0000000035e4";
    const ids: [string, string] = [
      "01a00000-0000-7000-8000-0000000035e3",
      held,
    ];
    const { a, b } = await rememberingGone("forget-unread", ids, (server) => {
      more = scriptFolderItem(server, { query: { types: ["core.event"] } });
    });
    const third = await folderHarness("forget-unread-c", {
      sharing: { server: a.server, key: KEY },
      folder: more,
      registry: a.registry,
    });
    try {
      const there = realpathSync(b.dir);
      rmSync(b.dir, { recursive: true });
      await deletedByHand(a);
      expect((await a.folder.push()).ok).toBe(true);
      expect(deletesOf(a.server, held)).toBe(0);
      await heldUnsure(a);

      // Where no folder can be read, each is named and nothing is forgotten.
      const own = join(a.dir, ".marfa");
      const state = join(third.dir, ".marfa");
      chmodSync(own, 0o000);
      chmodSync(state, 0o000);
      let none: Awaited<ReturnType<typeof a.folder.forget>>;
      try {
        none = await a.folder.forget(there, { yes: true });
      } finally {
        chmodSync(own, 0o700);
        chmodSync(state, 0o700);
      }
      expect(none.ok, JSON.stringify(none)).toBe(true);
      if (!none.ok) return;
      expect(none.value.exit).toBe(3);
      expect(none.value.forgotten).toEqual([]);
      expect(none.value.not_changed.map((folder) => folder.dir).sort()).toEqual(
        [realpathSync(a.dir), realpathSync(third.dir)].sort(),
      );
      expect(await heldIn(a)).toEqual(["Held.md"]);

      chmodSync(state, 0o000);
      let forgotten: Awaited<ReturnType<typeof a.folder.forget>>;
      try {
        forgotten = await a.folder.forget(there, { yes: true });
      } finally {
        chmodSync(state, 0o700);
      }
      expect(forgotten.ok, JSON.stringify(forgotten)).toBe(true);
      if (!forgotten.ok) return;
      expect(forgotten.value.exit).toBe(3);
      expect(forgotten.value.not_changed.map((folder) => folder.dir)).toEqual([
        realpathSync(third.dir),
      ]);
      expect(forgotten.value.not_changed[0]?.reason).not.toBe("");
      expect(
        forgotten.value.forgotten.map((folder) => [
          folder.dir,
          folder.released,
        ]),
      ).toEqual([[realpathSync(a.dir), ["Held.md"]]]);

      // Decided again, the file is held while the third folder is listed.
      const again = await a.folder.push();
      expect(
        again.ok && again.value.scan.trashed,
        "a delete was sent while another folder is on the Mac",
      ).toEqual([]);
      expect(deletesOf(a.server, held)).toBe(0);
      expect(again.ok && again.value.scan.unsure[0]?.reason).toContain(
        realpathSync(third.dir),
      );
      await heldUnsure(a);
      await trashHeldFiles(a, ["Held.md"]);
      expect(deletesOf(a.server, held)).toBe(1);
    } finally {
      await third.stop();
    }
  });

  it("changes nothing when forgetting a directory the registry still lists and exits 3, then releases the held delete once the directory is removed and forgotten", async () => {
    const held = "01a00000-0000-7000-8000-0000000035e6";
    const { a, b } = await remembering("forget-listed", [
      "01a00000-0000-7000-8000-0000000035e5",
      held,
    ]);
    // Still listed, its volume is not mounted.
    const there = realpathSync(b.dir);
    rmSync(b.dir, { recursive: true });
    await deletedByHand(a);
    const kept = await a.folder.push();
    expect(kept.ok && kept.value.scan.trashed).toEqual([]);
    expect(kept.ok && kept.value.scan.unsure[0]?.reason).toContain(
      `the folder ${there} cannot be reached; if it is gone, \`folders remove\` it, then \`folders forget\` it`,
    );
    await heldUnsure(a);
    const forgotten = await a.folder.forget(there, { yes: true });
    expect(forgotten.ok, JSON.stringify(forgotten)).toBe(true);
    if (!forgotten.ok) return;
    expect(forgotten.value.listed).toBe(true);
    expect(forgotten.value.exit).toBe(3);
    expect(forgotten.value.forgotten).toEqual([]);
    expect(
      forgotten.value.not_changed.map((left) => [
        left.dir,
        left.reason.includes("`folders remove` it first"),
      ]),
    ).toEqual([[realpathSync(a.dir), true]]);
    expect(await heldIn(a)).toEqual(["Held.md"]);
    const listed = await a.folder.list();
    expect(listed.ok && listed.value.map((entry) => entry.dir)).toContain(
      there,
    );
    const swept = await a.folder.push();
    expect(swept.ok && swept.value.scan.trashed).toEqual([]);
    expect(deletesOf(a.server, held)).toBe(0);
    await heldUnsure(a);

    // As the hold and the refusal advise: remove it, then forget it.
    expect((await b.folder.remove()).ok).toBe(true);
    const again = await a.folder.forget(there, { yes: true });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(again.value.listed).toBe(false);
    expect(again.value.exit).toBe(0);
    expect(again.value.forgotten.map((folder) => folder.released)).toEqual([
      ["Held.md"],
    ]);
    const sent = await a.folder.push();
    expect(sent.ok && sent.value.scan.trashed).toEqual(["Held.md"]);
    expect(deletesOf(a.server, held)).toBe(1);
  });

  it("forgets through the binding only in a folder whose store is still the one it showed, and the next sync sends the delete it released", async () => {
    const held = "01a00000-0000-7000-8000-0000000035e8";
    const { a, there } = await heldForGone("forget-binding", [
      "01a00000-0000-7000-8000-0000000035e7",
      held,
    ]);
    const self = realpathSync(a.dir);
    const bound = await openBindingFolder(a);
    try {
      const shown = await bound.device.remembering(there);
      expect(shown.ok, JSON.stringify(shown)).toBe(true);
      if (!shown.ok) return;
      expect(
        shown.value.folders.map((folder) => [
          folder.dir,
          folder.held.map((file) => file.path),
        ]),
      ).toEqual([[self, ["Held.md"]]]);

      // The folder's store is replaced by a copy of it since it was shown.
      const state = join(a.dir, ".marfa");
      cpSync(state, `${state}-copy`, { recursive: true });
      rmSync(state, { recursive: true });
      renameSync(`${state}-copy`, state);
      const stale = await bound.device.forgetRemembered(shown.value);
      expect(stale.ok, JSON.stringify(stale)).toBe(true);
      if (!stale.ok) return;
      expect(stale.value.forgotten).toEqual([]);
      expect(stale.value.notChanged.map((folder) => folder.dir)).toEqual([
        self,
      ]);
      const kept = await a.folder.push();
      expect(kept.ok && kept.value.scan.trashed).toEqual([]);
      expect(deletesOf(a.server, held)).toBe(0);
      await heldUnsure(a);

      // The witness: read again, the folder forgets.
      const again = await bound.device.remembering(there);
      expect(again.ok, JSON.stringify(again)).toBe(true);
      if (!again.ok) return;
      const done = await bound.device.forgetRemembered(again.value);
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(
        done.ok &&
          done.value.forgotten.map((folder) => [folder.dir, folder.released]),
      ).toEqual([[self, ["Held.md"]]]);
    } finally {
      await bound.device.close();
    }
    const sent = await a.folder.push();
    expect(sent.ok && sent.value.scan.trashed).toEqual(["Held.md"]);
    expect(deletesOf(a.server, held)).toBe(1);
  });

  it("keeps through the binding a hold made after the record it was given was read, and releases none from it", async () => {
    const held = "01a00000-0000-7000-8000-0000000035f0";
    const { a, there } = await heldForGone("forget-stale", [
      "01a00000-0000-7000-8000-0000000035ef",
      held,
    ]);
    const self = realpathSync(a.dir);
    const bound = await openBindingFolder(a);
    try {
      const before = await bound.device.remembering(there);
      expect(before.ok, JSON.stringify(before)).toBe(true);
      if (!before.ok) return;
      expect(
        before.value.folders.map((folder) => folder.held.map((f) => f.path)),
      ).toEqual([["Held.md"]]);
      // Kept, written back and deleted again: held anew, since a later time.
      const written = await a.folder.keepHeld(["Held.md"], { writeBack: true });
      expect(written.ok, JSON.stringify(written)).toBe(true);
      await deletedByHand(a);
      expect((await a.folder.push()).ok).toBe(true);
      await heldUnsure(a);
      const later = await bound.device.forgetRemembered(before.value);
      expect(later.ok, JSON.stringify(later)).toBe(true);
      expect(
        later.ok &&
          later.value.forgotten.map((folder) => [folder.dir, folder.released]),
      ).toEqual([[self, []]]);
      expect(await heldIn(a)).toEqual(["Held.md"]);
    } finally {
      await bound.device.close();
    }
    const kept = await a.folder.push();
    expect(kept.ok && kept.value.scan.trashed).toEqual([]);
    expect(deletesOf(a.server, held)).toBe(0);
    await heldUnsure(a);
  });

  it("keeps a confirmed removal held as unsure while the file's own directory cannot be read", async () => {
    const ids = [0, 1, 2, 3, 4, 5].map(
      (n) => `01a00000-0000-7000-8000-0000000035d${String(n)}`,
    );
    const { a } = await onOneMac(
      "confirm-unread-parent",
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
    const sub = join(a.dir, "sub");
    mkdirSync(sub);
    for (const n of [4, 5]) {
      renameSync(
        join(a.dir, `Note ${String(n)}.md`),
        join(sub, `Note ${String(n)}.md`),
      );
    }
    expect((await a.folder.scan()).ok).toBe(true);
    const back = readFileSync(join(sub, "Note 5.md"));
    for (const path of ["Note 0.md", "Note 1.md", "sub/Note 4.md"]) {
      rmSync(join(a.dir, path));
    }
    rmSync(join(sub, "Note 5.md"));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(4);
    writeFileSync(join(sub, "Note 5.md"), back);
    await pastTheGrace();

    chmodSync(sub, 0o000);
    try {
      const confirmed = await a.folder.confirm();
      expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
      if (!confirmed.ok) return;
      // Read in part, the folder proves no file gone.
      expect(confirmed.value.deleted).toBe(0);
      expect(confirmed.value.unsure.map((file) => file.path)).toContain(
        "sub/Note 4.md",
      );
      const unsure = async (): Promise<void> => {
        const status = await a.folder.status();
        expect(status.ok, JSON.stringify(status)).toBe(true);
        if (!status.ok) return;
        const file = status.value.files.find(
          (entry) => entry.path === "sub/Note 4.md",
        );
        expect(
          [file?.status, file?.flag],
          "a confirmed removal held while its own directory could not be read was not shown held",
        ).toEqual(["held", "unsure"]);
      };
      await unsure();
      // A file whose own path can be read stays a removal to confirm again.
      const status = await a.folder.status();
      expect(
        status.ok &&
          status.value.files.find((entry) => entry.path === "Note 0.md")?.flag,
        "a removal the confirm could not decide dropped out of view",
      ).toBe("removal");
      expect((await a.folder.push()).ok).toBe(true);
      await unsure();
      expect(lastReport(a).problems).toContainEqual({
        code: "held_file",
        count: 2,
      });
      expect(
        ids.map((id) => deletesOf(a.server, id)),
        "a confirmed removal was trashed while the folder could not be read whole",
      ).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      chmodSync(sub, 0o755);
    }

    // Read whole, the file put back ends its hold. A held file is no part of
    // a removal, so the two files found nowhere stay under the threshold,
    // and past the grace they are held too, since another folder is on the Mac.
    const whole = await a.folder.push();
    expect(whole.ok && whole.value.scan.paused).toBe(0);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.trashed).toEqual([]);
    const held = ["Note 0.md", "Note 1.md", "sub/Note 4.md"];
    expect(await heldIn(a)).toEqual(held);
    // The witness: the person's trash sends the deletes the holds kept.
    await trashHeldFiles(a, held);
    expect(ids.map((id) => deletesOf(a.server, id))).toEqual([
      1, 1, 0, 0, 1, 0,
    ]);
  });

  it("keeps a confirmed removal paused inside the rename grace while the file's own directory cannot be read", async () => {
    const ids = [0, 1, 2, 3, 4, 5].map(
      (n) => `01a00000-0000-7000-8000-0000000035e${String(n)}`,
    );
    const { a } = await onOneMac(
      "confirm-unread-grace",
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
    const sub = join(a.dir, "sub");
    mkdirSync(sub);
    renameSync(join(a.dir, "Note 4.md"), join(sub, "Note 4.md"));
    expect((await a.folder.scan()).ok).toBe(true);
    const gone = ["Note 0.md", "Note 1.md", "sub/Note 4.md"];
    for (const path of gone) rmSync(join(a.dir, path));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(3);

    chmodSync(sub, 0o000);
    try {
      // The second confirm finds no row the first left for the unread path.
      for (const confirm of ["first", "second"]) {
        const confirmed = await a.folder.confirm();
        expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
        if (!confirmed.ok) return;
        expect(confirmed.value.deleted, confirm).toBe(0);
        expect(
          confirmed.value.unsure.find((file) => file.path === "sub/Note 4.md")
            ?.reason,
          `the ${confirm} confirm inside the rename grace decided a file whose path it could not read`,
        ).toMatch(/rename grace/);
        expect(await heldIn(a), confirm).toEqual([]);
        const status = await a.folder.status();
        expect(status.ok && status.value.paused.disk, confirm).toBe(3);
      }
      expect(ids.map((id) => deletesOf(a.server, id))).toEqual([
        0, 0, 0, 0, 0, 0,
      ]);
    } finally {
      chmodSync(sub, 0o755);
    }

    // The witness: read whole and past the grace, a confirm decides the
    // files, held since another folder is on the Mac.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    const decided = await a.folder.confirm();
    expect(decided.ok, JSON.stringify(decided)).toBe(true);
    expect(await heldIn(a)).toEqual(gone);
    await trashHeldFiles(a, gone);
    expect(ids.map((id) => deletesOf(a.server, id))).toEqual([
      1, 1, 0, 0, 1, 0,
    ]);
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
    expect(swept.ok && swept.value.scan.trashed).toEqual([]);
    expect(await heldIn(a)).toEqual(["Gone.md"]);
    await trashHeldFiles(a, ["Gone.md"]);
    expect(deletesOf(a.server, gone)).toBe(1);
  });

  it("holds a delete whose file moved to another folder beside a copy of it", async () => {
    const moved = "01a00000-0000-7000-8000-0000000040f5";
    const copied = "01a00000-0000-7000-8000-0000000040f6";
    const { a, b } = await onOneMac(
      "moved-beside-copy",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: moved, properties: { title: "Moved", body: "m\n" } } },
          {
            item: { id: copied, properties: { title: "Copied", body: "c\n" } },
          },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
    cpSync(join(a.dir, "Copied.md"), join(b.dir, "Copy.md"));
    renameSync(join(a.dir, "Copied.md"), join(b.dir, "Copied.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    // The witness: the same sweep finds the note moved alone.
    expect(swept.value.scan.moved_away).toBe(1);
    expect(
      swept.value.scan.unsure.map((file) => file.path),
      "a moved file was told from a copy of it in the same folder",
    ).toEqual(["Copied.md"]);
    expect(await heldIn(a)).toEqual(["Copied.md"]);
    expect([moved, copied].map((id) => deletesOf(a.server, id))).toEqual([
      0, 0,
    ]);
  });

  it("holds a delete whose file moved into another folder that cannot be read whole", async () => {
    const gone = "01a00000-0000-7000-8000-0000000040f7";
    const { a, b } = await onOneMac(
      "moved-partial-walk",
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
    renameSync(join(a.dir, "Gone.md"), join(b.dir, "Gone.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    chmodSync(shut, 0o000);
    try {
      const held = await a.folder.push();
      expect(held.ok, JSON.stringify(held)).toBe(true);
      if (!held.ok) return;
      expect(
        held.value.scan.moved_away,
        "a move was told from a folder read only in part, which may hold another file with its id",
      ).toBe(0);
      expect(held.value.scan.unsure.map((file) => file.path)).toEqual([
        "Gone.md",
      ]);
    } finally {
      chmodSync(shut, 0o755);
    }
    // The witness: read whole, the other folder shows the file moved.
    const settled = await a.folder.trashHeld(["Gone.md"]);
    expect(settled.ok && settled.value.moved).toEqual(["Gone.md"]);
    expect(deletesOf(a.server, gone)).toBe(0);
  });

  it("keeps a held delete whose file came back and went again while its directory could not be read, until the person trashes it", async () => {
    const gone = "01a00000-0000-7000-8000-0000000040f3";
    const { a, b } = await onOneMac(
      "unread-grace",
      { query: { types: ["core.note"] } },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const sub = join(a.dir, "sub");
    mkdirSync(sub);
    const file = join(sub, "Gone.md");
    renameSync(join(a.dir, "Gone.md"), file);
    expect((await a.folder.scan()).ok).toBe(true);
    const bytes = readFileSync(file);
    const shut = join(b.dir, "Shut");
    mkdirSync(shut);
    chmodSync(shut, 0o000);
    try {
      rmSync(file);
      expect((await a.folder.push()).ok).toBe(true);
      await pastTheGrace();
      const held = await a.folder.push();
      expect(held.ok && held.value.scan.unsure.map((it) => it.path)).toEqual([
        "sub/Gone.md",
      ]);
      // Back while its directory cannot be read, and the grace runs out.
      writeFileSync(file, bytes);
      chmodSync(sub, 0o000);
      try {
        const unread = await a.folder.push();
        expect(
          unread.ok && unread.value.scan.directories.map((dir) => dir.path),
        ).toEqual(["sub"]);
        await pastTheGrace();
      } finally {
        chmodSync(sub, 0o755);
      }
    } finally {
      chmodSync(shut, 0o755);
    }
    rmSync(file);
    const again = await a.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      deletesOf(a.server, gone),
      "a delete was sent at once for a file a pass could not see come back and go again",
    ).toBe(0);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok && swept.value.scan.trashed).toEqual([]);
    expect(await heldIn(a)).toEqual(["sub/Gone.md"]);
    // The witness: the person's trash sends the delete the hold kept.
    await trashHeldFiles(a, ["sub/Gone.md"]);
    expect(deletesOf(a.server, gone)).toBe(1);
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

    // Each folder owns its copy before either file disappears.
    rmSync(join(a.dir, "Shared.md"));
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(0);
    expect(deletesOf(a.server, shared.id)).toBe(0);
    expect(await heldIn(a)).toEqual(["Shared.md"]);
    const trashed = await a.folder.trashHeld(["Shared.md"]);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    expect(
      trashed.ok && [trashed.value.trashed, trashed.value.moved],
      "the other folder's file of one item two folders hold was taken for this one moved",
    ).toEqual([["Shared.md"], []]);
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, shared.id)).toBe(1);
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
    // The witness: the same sweep finds no move for the file deleted for real.
    expect(swept.value.scan.unsure.map((file) => file.path)).toEqual([
      "Deleted.md",
    ]);
    expect(deletesOf(a.server, deleted)).toBe(0);
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
    await pastTheGrace();

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    expect(
      [confirmed.value.moved, confirmed.value.deleted],
      "a confirmed removal trashed files another folder on the Mac now holds",
    ).toEqual([3, 0]);
    // The file found nowhere could still have gone where no folder reads.
    expect(confirmed.value.unsure.map((file) => file.path)).toEqual([
      "Note 3.md",
    ]);
    expect((await a.folder.push()).ok).toBe(true);
    expect(await heldIn(a)).toEqual(["Note 3.md"]);
    // The witness: the person's trash sends the delete the moves did not.
    await trashHeldFiles(a, ["Note 3.md"]);
    expect(deletesOf(a.server, ids[3]!)).toBe(1);
    for (const n of [0, 1, 2]) expect(deletesOf(a.server, ids[n]!)).toBe(0);
  });

  it("keeps a removal confirmed inside the rename grace paused, and lets it go once the grace is over", async () => {
    const ids = [0, 1, 2].map(
      (n) => `01a00000-0000-7000-8000-0000000017f${String(n)}`,
    );
    harness = await folderHarness("confirm-in-grace", {
      settings: {
        query: { types: ["core.note"] },
        removal_threshold: { files: 2, fraction: 0.25 },
      },
      items: {
        "core.note": ids.map((id, n) => ({
          item: { id, properties: { title: `Note ${String(n)}`, body: "b\n" } },
        })),
      },
    });
    const a = harness;
    scriptFolderWrites(a);
    expect((await a.folder.pull()).ok).toBe(true);
    for (const n of [0, 1, 2]) rmSync(join(a.dir, `Note ${String(n)}.md`));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(3);

    const early = await a.folder.confirm();
    expect(early.ok, JSON.stringify(early)).toBe(true);
    if (!early.ok) return;
    expect(
      early.value.deleted,
      "a confirm inside the rename grace sent deletes a move could still explain",
    ).toBe(0);
    expect(early.value.unsure.map((file) => file.reason)).toEqual(
      ids.map(() => expect.stringMatching(/less than the rename grace ago/)),
    );
    const still = await a.folder.status();
    expect(
      still.ok && still.value.paused.disk,
      "a confirm inside the rename grace ended the pause",
    ).toBe(3);
    expect((await a.folder.push()).ok).toBe(true);
    for (const id of ids) expect(deletesOf(a.server, id)).toBe(0);

    await pastTheGrace();
    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    expect(confirmed.ok && confirmed.value.deleted).toBe(3);
    expect((await a.folder.push()).ok).toBe(true);
    for (const id of ids) expect(deletesOf(a.server, id)).toBe(1);
  });

  it("trashes no item of a confirmed removal that another device changed since its file went, and writes the file back", async () => {
    const ids = [0, 1, 2, 3, 4, 5].map(
      (n) => `01a00000-0000-7000-8000-0000000043e${String(n)}`,
    );
    // Alone on the Mac, so a removal found nowhere is a delete.
    const edges = new EdgeDoor();
    harness = await folderHarness("confirm-changed-alone", {
      settings: {
        query: { types: ["core.note"] },
        removal_threshold: { files: 2, fraction: 0.25 },
      },
      items: {
        "core.note": ids.map((id, n) => ({
          item: { id, properties: { title: `Note ${String(n)}`, body: "b\n" } },
        })),
      },
      events: [edges.stream()],
    });
    const a = harness;
    let door: FolderDoor | undefined;
    scriptFolderWrites(a, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await a.folder.pull()).ok).toBe(true);
    for (const n of [0, 1, 2]) rmSync(join(a.dir, `Note ${String(n)}.md`));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(3);
    edges.logItem(
      "item.updated",
      door!.update(ids[0]!, {
        properties: { notes: "their annotation" },
        version: 1,
      }),
    );
    const heard = await a.folder.device().catchUp();
    expect(heard.ok && heard.value.applied).toBe(1);
    await pastTheGrace();

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

  it("holds the files of a confirmed removal it cannot tell from a move while another folder is paused, until the person trashes them", async () => {
    const ids = [0, 1, 2, 3].map(
      (n) => `01a00000-0000-7000-8000-0000000043f${String(n)}`,
    );
    const { a, b } = await onOneMac(
      "confirm-peer-paused",
      {
        query: { types: ["core.note"] },
        removal_threshold: { files: 1, fraction: 0.25 },
      },
      { query: { types: ["core.bookmark"] } },
      {
        "core.note": ids.map((id, n) => ({
          item: { id, properties: { title: `Note ${String(n)}`, body: "b\n" } },
        })),
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    const names = ["Note 0.md", "Note 1.md"];
    for (const name of names) rmSync(join(a.dir, name));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(2);
    await pastTheGrace();
    expect((await b.folder.pause()).ok).toBe(true);

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.deleted).toBe(0);
    expect(confirmed.value.unsure.map((file) => file.path).sort()).toEqual(
      names,
    );
    expect((await a.folder.push()).ok).toBe(true);
    for (const id of ids.slice(0, 2)) {
      expect(
        deletesOf(a.server, id),
        "a confirmed removal trashed a note that may have moved into a paused folder",
      ).toBe(0);
    }
    expect(await heldIn(a)).toEqual(names);

    // The witness: the person's trash sends both deletes.
    expect((await b.folder.resume()).ok).toBe(true);
    await trashHeldFiles(a, names);
    for (const id of ids.slice(0, 2)) expect(deletesOf(a.server, id)).toBe(1);
  });

  it("finds a confirmed removal's moved files while another folder holds files that are not text, and holds the rest", async () => {
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
    for (const n of [0, 1]) {
      renameSync(
        join(a.dir, `Note ${String(n)}.md`),
        join(b.dir, `Note ${String(n)}.md`),
      );
    }
    for (const n of [2, 3]) rmSync(join(a.dir, `Note ${String(n)}.md`));
    const paused = await a.folder.push();
    expect(paused.ok && paused.value.scan.paused).toBe(4);
    await pastTheGrace();

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    expect(
      [confirmed.value.moved, confirmed.value.deleted],
      "a file in another folder that is not text kept the moves from being found",
    ).toEqual([2, 0]);
    expect(confirmed.value.unsure.map((file) => file.path).sort()).toEqual([
      "Note 2.md",
      "Note 3.md",
    ]);
    for (const held of confirmed.value.unsure) {
      expect(
        held.reason,
        "a file in another folder that is not text was read as an unreadable folder",
      ).toMatch(/^another folder is on this computer, at /);
    }
    expect((await a.folder.push()).ok).toBe(true);
    for (const id of ids) expect(deletesOf(a.server, id)).toBe(0);
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
    harness = await folderHarness("scan-trashes-file-item", {
      settings: { query: { types: ["core.file.image"] } },
      items: {
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
    });
    const a = harness;
    scriptFolderWrites(a);
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

  it("trashes a deleted file item where the Mac has no other folder, though another file in its folder has its bytes", async () => {
    const kept = "01a00000-0000-7000-8000-0000000044b3";
    const gone = "01a00000-0000-7000-8000-0000000044b4";
    const bytes = Buffer.from("the same bytes\n");
    const rows = [
      [kept, "kept.png"],
      [gone, "photo.png"],
    ] as const;
    harness = await folderHarness("scan-trashes-duplicate-bytes", {
      settings: { query: { types: ["core.file.image"] } },
      items: {
        "core.file.image": rows.map(([id, name]) => ({
          item: {
            id,
            type: "core.file.image",
            properties: {
              title: name,
              blob_ref: hashOf(bytes),
              mime_type: "image/png",
            },
          },
        })),
      },
    });
    const a = harness;
    scriptFolderWrites(a);
    scriptBlob(a.server, bytes);
    expect((await a.folder.pull()).ok).toBe(true);
    expect(readFileSync(join(a.dir, "kept.png"))).toEqual(bytes);
    rmSync(join(a.dir, "photo.png"));
    const missing = await a.folder.scan();
    expect(missing.ok && missing.value.missing).toBe(1);
    await pastTheGrace();
    const scanned = await a.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.trashed,
      "a file in the same folder with the missing file's bytes was taken for where it went",
    ).toEqual(["photo.png"]);
    expect((await a.folder.push()).ok).toBe(true);
    expect([deletesOf(a.server, gone), deletesOf(a.server, kept)]).toEqual([
      1, 0,
    ]);
  });

  it("holds a confirmed removal of file items while another folder is on the Mac, and sends their deletes without pausing again once the person trashes them", async () => {
    const files = [0, 1, 2, 3].map(
      (n) =>
        [
          `01a00000-0000-7000-8000-0000000044c${String(n)}`,
          `photo ${String(n)}.png`,
        ] as const,
    );
    const bytesOf = (name: string) => Buffer.from(`the bytes of ${name}\n`);
    const { a, b } = await onOneMac(
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
    expect((await b.folder.pull()).ok).toBe(true);
    const removed = files.slice(0, 3);
    const names = removed.map(([, name]) => name);
    for (const name of names) rmSync(join(a.dir, name));
    // Paused by a scan, which fetches nothing, as `folders confirm` does not.
    const from = a.server.requests.length;
    const paused = await a.folder.scan();
    expect(paused.ok && paused.value.paused).toBe(3);
    await pastTheGrace();

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    expect(
      confirmed.value.deleted,
      "a confirmed removal of file items that may have moved to the other folder was deleted",
    ).toBe(0);
    expect(confirmed.value.unsure.map((held) => held.path).sort()).toEqual(
      names,
    );
    for (const held of confirmed.value.unsure) {
      expect(held.reason).toMatch(/^another folder is on this computer, at /);
    }
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
    expect(files.map(([id]) => deletesOf(a.server, id))).toEqual([0, 0, 0, 0]);
    expect(await heldIn(a)).toEqual(names);

    await trashHeldFiles(a, names);
    expect(files.map(([id]) => deletesOf(a.server, id))).toEqual([1, 1, 1, 0]);
    for (const name of names) {
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
    // Held only because another folder is on the Mac, not for a read error.
    expect(deletesOf(a.server, gone)).toBe(0);
    expect(
      swept.value.scan.unsure.map((file) => [file.path, file.reason]),
      "a file that is not text, in this folder or the other, was read as a folder that cannot be read",
    ).toEqual([
      [
        "Gone.md",
        `another folder is on this computer, at ${realpathSync(b.dir)}, so Marfa cannot tell its delete from a move into it`,
      ],
    ]);
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
    expect(
      [deletesOf(a.server, moved), swept.value.scan.moved_away],
      "a file moved and saved as UTF-16 was taken for deleted",
    ).toEqual([0, 1]);
    // The witness: the file lost for good is no move, and the person's
    // trash sends its delete.
    expect(swept.value.scan.unsure.map((file) => file.path)).toEqual([
      "Gone.md",
    ]);
    await trashHeldFiles(a, ["Gone.md"]);
    expect(deletesOf(a.server, gone)).toBe(1);
    expect(deletesOf(a.server, moved)).toBe(0);

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
