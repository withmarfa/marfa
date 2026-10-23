import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  copyItemEvent,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import {
  KEY,
  acceptUploads,
  folderHarness,
  hashOf,
  requireBinary,
  scriptBlob,
  scriptFolderRow,
  scriptWrites,
} from "./harness.js";
import { CliFolder, type FolderSettings } from "../../device/cli-adapter.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import type { FolderHarness, FolderRow } from "./harness.js";
import type { WireItemOptions } from "../../device/marfa-answers.js";
import {
  EdgeDoor,
  idIn,
  put,
  read,
  saveAtomically,
  scriptFolderWrites,
  sentCreates,
  sentTitles,
  sentUpdates,
  withFault,
} from "./folders.shared.js";

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await second?.stop();
  harness = undefined;
  second = undefined;
});

describe("folders on one Mac", () => {
  describe.runIf(process.platform === "darwin")(
    "unidentified cross-directory moves and older deletions",
    () => {
      it.each(["directory", "file", "unreadable file"])(
        "holds cross-directory moves and older deletions behind an unidentified %s",
        async (kind) => {
          const moved = "01a00000-0000-7000-8000-000000000ae1";
          const missing = "01a00000-0000-7000-8000-000000000ae2";
          harness = await folderHarness(`contract-unidentified-${kind}`, {
            rows: {
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

  /** Past the grace a missing file is journaled for (`folders/delete-grace`). */
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
   * own settings, directory and store. The first holds `rows`; the item
   * doors and the stream are the shared server's.
   */
  async function onOneMac(
    label: string,
    first: FolderSettings,
    other: FolderSettings,
    rows: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>,
    before?: (server: ScriptedServer) => void,
  ): Promise<{ edges: EdgeDoor; a: FolderHarness; b: FolderHarness }> {
    const edges = new EdgeDoor();
    harness = await folderHarness(`${label}-a`, {
      settings: first,
      rows,
      events: [edges.stream()],
    });
    // Before the item doors, whose read would answer for any id.
    const otherRow = scriptFolderRow(harness.server, other);
    before?.(harness.server);
    scriptFolderWrites(harness, { edges });
    second = await folderHarness(`${label}-b`, {
      sharing: { server: harness.server, key: KEY },
      folder: otherRow,
      registry: harness.registry,
    });
    return { edges, a: harness, b: second };
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
      { search: { types: ["core.note"] } },
      // Its copy holds every note, and its search none of these.
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
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

  it("keeps the note of a text note moved to another folder as Markdown, makes a copy a new item, and keeps its words", async () => {
    const { a, b } = await onOneMac(
      "move-text-as-markdown",
      { search: { types: ["core.note"] } },
      { search: { types: ["core.note"] } },
      { "core.note": [] },
    );
    put(a, "Loose.txt", "loose words\n");
    put(a, "Copied.txt", "copied words\n");
    expect((await a.folder.push()).ok).toBe(true);
    const notes = new Map(
      sentCreates(a).map((sent) => [
        (sent.properties as { title?: string }).title,
        String(sent.id),
      ]),
    );
    expect([...notes.keys()].sort()).toEqual(["Copied", "Loose"]);
    // Moved, the file keeps its identity; copied and deleted, only its bytes,
    // which a template's copies share.
    renameSync(join(a.dir, "Loose.txt"), join(b.dir, "Loose.md"));
    copyFileSync(join(a.dir, "Copied.txt"), join(b.dir, "Copied.md"));
    rmSync(join(a.dir, "Copied.txt"));

    const from = b.server.requests.length;
    const pushed = await b.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const creates = createsSince(b.server, from);
    expect(
      creates.map((sent) => [
        (sent.properties as { title?: string }).title,
        (sent.properties as { body?: string }).body,
      ]),
      "a text note moved as Markdown became a second item, or a copy was taken by its bytes for the note it was copied from",
    ).toEqual([["Copied", "copied words\n"]]);
    expect([...notes.values()]).not.toContain(creates[0]?.id);
    expect(idIn(b, "Loose.md")).toBe(notes.get("Loose"));

    // The folder it left sweeps its missing files: the words live on, and
    // neither the moved note nor the new item is trashed.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, String(notes.get("Loose")))).toBe(0);
    expect(deletesOf(a.server, String(creates[0]?.id))).toBe(0);
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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

    // The next pass journals it and writes nothing back, and the folder it
    // went to takes it as the same item by its identity.
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

  const holdsNotes: FolderSettings = { search: { types: ["core.note"] } };
  const holdsBookmarks: FolderSettings = {
    search: { types: ["core.bookmark"] },
  };

  it.each([
    ["holds notes", holdsNotes],
    ["holds no notes", holdsBookmarks],
  ])(
    "keeps one item when a new note moves before its id line is written to another folder whose search %s",
    async (label, other) => {
      const { a, b } = await onOneMac(
        `new-note-moved-${label.replaceAll(" ", "-")}`,
        holdsNotes,
        other,
        {},
      );
      put(a, "Moved.md", "words\n");
      put(a, "Copied.md", "copied words\n");
      expect((await a.folder.scan()).ok).toBe(true);
      expect((await a.folder.device().drain()).ok).toBe(true);
      const ids = new Map(
        sentCreates(a).map((sent) => [
          (sent.properties as { title?: string }).title,
          String(sent.id),
        ]),
      );
      const id = String(ids.get("Moved"));
      // Between the scan and the pull that writes the id line, one is moved
      // and the other copied and deleted.
      renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
      copyFileSync(join(a.dir, "Copied.md"), join(b.dir, "Copied.md"));
      rmSync(join(a.dir, "Copied.md"));
      const pulled = await a.folder.pull();
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      expect(existsSync(join(a.dir, "Moved.md"))).toBe(false);

      // Within the grace the folder it left journals both and writes neither
      // back; past it, it keeps its binding for the folder it went to, which
      // knows the file by that binding alone, and still writes nothing.
      const journaled = await a.folder.push();
      expect(journaled.ok, JSON.stringify(journaled)).toBe(true);
      if (!journaled.ok) return;
      expect(journaled.value.scan.missing).toBe(2);
      expect(
        journaled.value.pull?.revived,
        "the folder it left wrote the moved note back, so the move reads as a copy",
      ).toBe(0);
      expect(readdirSync(a.dir).filter((name) => name !== ".marfa")).toEqual(
        [],
      );
      await pastTheGrace();
      const kept = await a.folder.push();
      expect(kept.ok, JSON.stringify(kept)).toBe(true);
      if (!kept.ok) return;
      expect(kept.value.pull?.elsewhere).toBe(1);
      expect(kept.value.scan.trashed).toEqual(["Copied.md"]);
      expect(deletesOf(a.server, id)).toBe(0);
      expect(readdirSync(a.dir).filter((name) => name !== ".marfa")).toEqual(
        [],
      );

      const from = b.server.requests.length;
      const taken = await b.folder.push();
      expect(taken.ok, JSON.stringify(taken)).toBe(true);
      // The witness: a copy, known only by its bytes, is a new item.
      expect(
        createsSince(b.server, from).map(
          (sent) => (sent.properties as { title?: string }).title,
        ),
        "a new note moved before its id line was written became a second item",
      ).toEqual(["Copied"]);
      expect(idIn(b, "Moved.md")).toBe(id);
      expect(read(b, "Moved.md")).toContain("words\n");

      // Edits made where it went reach the same item.
      writeFileSync(
        join(b.dir, "Moved.md"),
        read(b, "Moved.md").replace("words\n", "words, edited\n"),
      );
      expect((await b.folder.push()).ok).toBe(true);
      expect(
        sentUpdates(b)
          .filter((sent) => sent.id === id)
          .map((sent) => (sent.body.properties as { body?: string }).body),
        "an edit of the moved note did not reach its item",
      ).toEqual(["words, edited\n"]);

      // Its next full pass releases the binding, though the pull there wrote
      // the file anew, and trashes nothing.
      const released = await a.folder.push();
      expect(released.ok, JSON.stringify(released)).toBe(true);
      if (!released.ok) return;
      expect(released.value.scan.moved_away).toBe(1);
      expect(
        deletesOf(a.server, id),
        "the item of a new note moved to another folder was trashed",
      ).toBe(0);
      // Its own search holds the note, so it writes its own file of it
      // again; a folder whose search does not hold it hands its file over.
      expect(idIn(a, "Moved.md")).toBe(id);
      expect(read(a, "Moved.md")).toContain("words, edited\n");
      if (other === holdsNotes) {
        expect(idIn(b, "Moved.md")).toBe(id);
      } else {
        expect(released.value.pull?.taken).toBe(1);
        expect(existsSync(join(b.dir, "Moved.md"))).toBe(false);
      }
    },
  );

  it("keeps one item when a new note moves to another folder while its create waits offline", async () => {
    const { a, b } = await onOneMac(
      "new-note-moved-offline",
      holdsNotes,
      holdsNotes,
      {},
    );
    await a.server.offline();
    put(a, "Moved.md", "words\n");
    const queued = await a.folder.push();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.scan.created).toBe(1);
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
    // Edited where it went, still offline.
    writeFileSync(join(b.dir, "Moved.md"), "words\nmore words\n");

    const offline = await b.folder.scan();
    expect(offline.ok, JSON.stringify(offline)).toBe(true);
    if (!offline.ok) return;
    expect(offline.value.created).toBe(0);
    expect(offline.value.flagged.map((file) => [file.path, file.flag])).toEqual(
      [["Moved.md", "waiting"]],
    );

    await a.server.online();
    // Until the create lands the server does not show the item, and the
    // file still waits rather than becoming a second one.
    const early = await b.folder.push();
    expect(early.ok, JSON.stringify(early)).toBe(true);
    if (!early.ok) return;
    expect(early.value.scan.created).toBe(0);
    expect(
      early.value.scan.flagged.map((file) => [file.path, file.flag]),
      "the file of a note whose create had not landed became a new item",
    ).toEqual([["Moved.md", "waiting"]]);
    expect(createsSince(b.server, 0)).toEqual([]);

    expect((await a.folder.push()).ok).toBe(true);
    const creates = createsSince(a.server, 0);
    expect(creates).toHaveLength(1);
    const id = String(creates[0]?.id);
    expect((creates[0]?.properties as { body?: string }).body).toBe("words\n");
    await pastTheGrace();
    const kept = await a.folder.push();
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.pull?.elsewhere).toBe(1);
    expect(readdirSync(a.dir).filter((name) => name !== ".marfa")).toEqual([]);

    expect((await b.folder.push()).ok).toBe(true);
    expect(idIn(b, "Moved.md")).toBe(id);
    expect(read(b, "Moved.md")).toContain("words\nmore words\n");
    expect(
      sentUpdates(b)
        .filter((sent) => sent.id === id)
        .map((sent) => (sent.body.properties as { body?: string }).body),
      "the edit made after the move did not reach the item",
    ).toEqual(["words\nmore words\n"]);

    const released = await a.folder.push();
    expect(released.ok, JSON.stringify(released)).toBe(true);
    if (!released.ok) return;
    expect(released.value.scan.moved_away).toBe(1);
    expect((await b.folder.push()).ok).toBe(true);
    expect(
      createsSince(a.server, 0).map((sent) => sent.id),
      "the queued create reached the server more than once, or a second item was made",
    ).toEqual([id]);
    expect(deletesOf(a.server, id)).toBe(0);
    // Its own search holds the note, so it writes its own file of it again.
    expect(idIn(a, "Moved.md")).toBe(id);
    expect(read(a, "Moved.md")).toContain("words\nmore words\n");
  });

  it("makes separate items of identical new notes moved to another folder", async () => {
    const { a, b } = await onOneMac(
      "identical-new-notes",
      holdsNotes,
      holdsNotes,
      {},
    );
    for (const name of ["One.md", "Two.md", "Three.md", "Four.md"]) {
      put(a, name, "template\n");
    }
    expect((await a.folder.scan()).ok).toBe(true);
    expect((await a.folder.device().drain()).ok).toBe(true);
    const ids = new Map(
      sentCreates(a).map((sent) => [
        (sent.properties as { title?: string }).title,
        String(sent.id),
      ]),
    );
    expect(ids.size).toBe(4);
    for (const name of ["One.md", "Two.md"]) {
      renameSync(join(a.dir, name), join(b.dir, name));
    }
    for (const name of ["Three.md", "Four.md"]) {
      copyFileSync(join(a.dir, name), join(b.dir, name));
      rmSync(join(a.dir, name));
    }
    const from = b.server.requests.length;
    expect((await b.folder.push()).ok).toBe(true);
    const creates = createsSince(b.server, from);
    expect(
      creates
        .map((sent) => (sent.properties as { title?: string }).title)
        .sort(),
      "identical new notes moved kept their items by identity, and identical copies, which bytes cannot tell apart, became new items",
    ).toEqual(["Four", "Three"]);
    expect(idIn(b, "One.md")).toBe(ids.get("One"));
    expect(idIn(b, "Two.md")).toBe(ids.get("Two"));
    for (const name of ["Three.md", "Four.md"]) {
      expect([...ids.values()]).not.toContain(idIn(b, name));
    }
  });

  it("makes a new item of a new note moved to another folder and saved there anew before that folder scans, and keeps its words", async () => {
    const { a, b } = await onOneMac(
      "new-note-moved-resaved",
      holdsNotes,
      holdsNotes,
      {},
    );
    put(a, "Moved.md", "words\n");
    expect((await a.folder.scan()).ok).toBe(true);
    expect((await a.folder.device().drain()).ok).toBe(true);
    const id = String(sentCreates(a)[0]?.id);
    renameSync(join(a.dir, "Moved.md"), join(b.dir, "Moved.md"));
    expect((await a.folder.pull()).ok).toBe(true);
    // An editor's replace-save, or a move across volumes: a new identity
    // and new bytes, so nothing ties the file to the note it was.
    saveAtomically(b, "Moved.md", "words\nsaved anew\n");

    const from = b.server.requests.length;
    expect((await b.folder.push()).ok).toBe(true);
    const creates = createsSince(b.server, from);
    expect(
      creates.map((sent) => (sent.properties as { body?: string }).body),
    ).toEqual(["words\nsaved anew\n"]);
    const made = String(creates[0]?.id);
    expect(made).not.toBe(id);
    expect(idIn(b, "Moved.md")).toBe(made);

    // The folder it left finds it nowhere, and the grace sweep trashes the
    // note it was: one live item, holding every word.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    expect((await a.folder.push()).ok).toBe(true);
    expect(deletesOf(a.server, id)).toBe(1);
    expect(deletesOf(a.server, made)).toBe(0);
    expect(read(b, "Moved.md")).toContain("words\nsaved anew\n");
    // Its own search holds the new item, so it writes that item's file.
    const left = readdirSync(a.dir).filter((name) => name !== ".marfa");
    expect(left.map((name) => idIn(a, name))).toEqual([made]);
  });

  it("trashes a missing file found in no folder on the Mac, and says so", async () => {
    const gone = "01a00000-0000-7000-8000-0000000016e1";
    const alsoGone = "01a00000-0000-7000-8000-0000000016e2";
    const namesake = "01a00000-0000-7000-8000-0000000016e3";
    const { a, b } = await onOneMac(
      "trash-found-nowhere",
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      "Also gone.md was found in no folder on this machine, so its item was trashed",
    );
    expect(deletesOf(a.server, alsoGone)).toBe(1);
  });

  function denySourceRemoval(source: string, immutable: boolean): () => void {
    if (immutable) {
      execFileSync("chflags", ["uchg", source]);
      expect(() =>
        renameSync(source, join(source, "..", "refused-move")),
      ).toThrow();
      return () => {
        if (existsSync(source)) execFileSync("chflags", ["nouchg", source]);
      };
    }
    const parent = join(source, "..");
    chmodSync(parent, 0o555);
    expect(() => renameSync(source, join(parent, "refused-move"))).toThrow();
    return () => chmodSync(parent, 0o755);
  }

  it("refuses an ordinary source removal denial instead of copying", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000029c1",
      properties: { title: "Plan", body: "permission refusal\n" },
    };
    const control = {
      id: "01a00000-0000-7000-8000-0000000029c2",
      properties: { title: "Control", body: "ordinary move\n" },
    };
    const { a, b, edges } = await onOneMac(
      "ordinary-source-denial",
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
      {
        "core.note": [
          { item: plan, tags: ["a"] },
          { item: control, tags: ["a"] },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    expect((await a.folder.push()).ok).toBe(true);
    edges.relocate(plan.id, a.settings.id, "Retained/Plan.md");
    const source = join(a.dir, "Retained/Plan.md");
    expect((await a.folder.push()).ok).toBe(true);
    const before = readFileSync(source);
    const allowRemoval = denySourceRemoval(source, false);
    try {
      for (const item of [plan, control]) {
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
      const refused = await b.folder.push();
      expect(
        refused.ok && [
          refused.value.pull?.taken,
          refused.value.pull?.unwritten,
        ],
      ).toEqual([1, 1]);
      expect(readFileSync(source)).toEqual(before);
      expect(existsSync(join(b.dir, "Plan.md"))).toBe(false);
      expect(existsSync(join(a.dir, "Control.md"))).toBe(false);
      expect(read(b, "Control.md")).toContain("ordinary move");
      const status = await a.folder.status();
      expect(
        status.ok &&
          status.value.files.find((file) => file.path === "Retained/Plan.md")
            ?.item_id,
      ).toBe(plan.id);
      allowRemoval();
      const retried = await b.folder.pull();
      expect(retried.ok && retried.value.taken).toBe(1);
      expect(readFileSync(join(b.dir, "Plan.md"))).toEqual(before);
      expect(existsSync(source)).toBe(false);
      const quiet = await b.folder.scan();
      expect(quiet.ok && [quiet.value.created, quiet.value.updated]).toEqual([
        0, 0,
      ]);
    } finally {
      allowRemoval();
    }
  });

  it.each([
    { mode: "protected", later: "remove" },
    { mode: "cross-volume-control", later: "remove" },
    { mode: "protected", later: "edit" },
    { mode: "directory-control", later: "remove" },
    { mode: "directory-control", later: "edit" },
  ])(
    "takes in a readable source and preserves denied-removal ownership ($mode, $later)",
    async ({ mode, later }) => {
      const locked = {
        id: "01a00000-0000-7000-8000-0000000029a1",
        properties: { title: "Locked", body: "kept source bytes\n" },
      };
      const control = {
        id: "01a00000-0000-7000-8000-0000000029a2",
        properties: { title: "Control", body: "ordinary move\n" },
      };
      const stay = {
        id: "01a00000-0000-7000-8000-0000000029a3",
        properties: { title: "Stay", body: "continuation before\n" },
      };
      const { a, b, edges } = await onOneMac(
        "protected-source",
        { search: { types: ["core.note"], filter: 'tags contains "a"' } },
        { search: { types: ["core.note"], filter: 'tags contains "b"' } },
        {
          "core.note": [
            { item: locked, tags: ["a"] },
            { item: control, tags: ["a"] },
            { item: stay, tags: ["a"] },
          ],
        },
      );
      expect((await a.folder.pull()).ok).toBe(true);
      expect((await b.folder.pull()).ok).toBe(true);
      const sourceKey = "Retained/Locked.md";
      expect((await a.folder.push()).ok).toBe(true);
      edges.relocate(locked.id, a.settings.id, sourceKey);
      const source = join(a.dir, sourceKey);
      expect((await a.folder.push()).ok).toBe(true);
      const before = read(a, sourceKey);
      // Immutable flags are macOS-specific; directory denial exercises retained
      // ownership through the existing cross-volume copy path on every platform.
      const immutable =
        process.platform === "darwin" && mode !== "directory-control";
      chmodSync(source, 0o750);
      if (process.platform === "darwin") {
        const tag = Buffer.from(
          '<?xml version="1.0"?><plist version="1.0"><array><string>Fixture\n6</string></array></plist>',
        );
        execFileSync("xattr", [
          "-wx",
          "com.apple.metadata:_kMDItemUserTags",
          tag.toString("hex"),
          source,
        ]);
        execFileSync("xattr", [
          "-w",
          "com.apple.quarantine",
          "0081;fixture;Marfa;",
          source,
        ]);
      }
      const sourceIdentity = statSync(source).ino;
      const allowRemoval = denySourceRemoval(source, immutable);
      try {
        expect(read(a, sourceKey)).toBe(before);
        for (const item of [locked, control]) {
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
        const sourceState = () =>
          execFileSync(
            "sqlite3",
            [
              "-json",
              join(a.dir, ".marfa", "core.sqlite"),
              "SELECT item_id,identity,content_hash,written_hash,writes,own FROM folder_files WHERE path='Retained/Locked.md'",
            ],
            { encoding: "utf8" },
          );
        const owned = sourceState();
        const moved = await withFault(
          mode === "cross-volume-control" || !immutable
            ? "cross-volume-move"
            : "",
          () => b.folder.push(),
        );
        expect(moved.ok, JSON.stringify(moved)).toBe(true);
        if (!moved.ok) return;

        expect(existsSync(join(b.dir, "Control.md"))).toBe(true);
        expect(existsSync(join(a.dir, "Control.md"))).toBe(false);
        expect(read(a, sourceKey)).toBe(before);
        if (immutable) {
          expect(
            execFileSync("ls", ["-lO", source], { encoding: "utf8" }),
          ).toContain("uchg");
        } else {
          expect(statSync(join(source, "..")).mode & 0o222).toBe(0);
        }
        expect(moved.value.pull?.taken, owned).toBe(2);
        expect(moved.value.pull?.unwritten).toBe(0);
        expect(read(b, "Locked.md")).toBe(before);
        expect(idIn(b, "Locked.md")).toBe(locked.id);
        const destination = join(b.dir, "Locked.md");
        expect(statSync(source).ino).toBe(sourceIdentity);
        expect(statSync(destination).ino).not.toBe(sourceIdentity);
        expect(statSync(destination).mode & 0o777).toBe(0o750);
        if (process.platform === "darwin") {
          expect(
            execFileSync("ls", ["-lO", destination], { encoding: "utf8" }),
          ).not.toContain("uchg");
          for (const attribute of [
            "com.apple.metadata:_kMDItemUserTags",
            "com.apple.quarantine",
          ]) {
            expect(
              execFileSync("xattr", ["-px", attribute, destination]),
            ).toEqual(execFileSync("xattr", ["-px", attribute, source]));
          }
        }
        execFileSync("sqlite3", [
          join(a.dir, ".marfa", "core.sqlite"),
          `INSERT INTO folder_journal(path,item_id,missing_since) VALUES('Retained/Locked.md','${locked.id}','2026-01-01T00:00:00Z')`,
        ]);
        const sourceJournal = () =>
          execFileSync(
            "sqlite3",
            [
              "-json",
              join(a.dir, ".marfa", "core.sqlite"),
              "SELECT path,item_id,missing_since FROM folder_journal WHERE path='Retained/Locked.md'",
            ],
            { encoding: "utf8" },
          );
        const journal = sourceJournal();
        expect(journal).toContain(locked.id);
        edges.events.push(
          copyItemEvent(
            String(edges.events.length + 2),
            "item.updated",
            wireItem({
              ...stay,
              version: 2,
              properties: { title: "Stay", body: "continuation after\n" },
            }),
            { tags: ["a"] },
          ),
        );
        expect((await a.folder.device().catchUp()).ok).toBe(true);
        for (let pass = 0; pass < 2; pass++) {
          const retained = await a.folder.pull();
          expect(retained.ok, JSON.stringify(retained)).toBe(true);
          if (!retained.ok) return;
          expect(retained.value.unwritten).toBe(1);
          expect(retained.value.unmatched).toBeGreaterThanOrEqual(1);
          expect(retained.value.let_go).toBe(0);
          expect(
            retained.value.flagged.find((file) => file.path === sourceKey)
              ?.flag,
          ).toBe("retained");
          expect(read(a, "Stay.md")).toContain("continuation after");
          expect(read(a, sourceKey)).toBe(before);
          expect(statSync(source).ino).toBe(sourceIdentity);
          expect(sourceState()).toBe(owned);
          expect(sourceJournal()).toBe(journal);
          const status = await a.folder.status();
          expect(
            status.ok &&
              status.value.files.find((file) => file.path === sourceKey)
                ?.item_id,
          ).toBe(locked.id);
          expect(
            status.ok &&
              status.value.files.find((file) => file.path === sourceKey)
                ?.status,
          ).toBe("unmatched");
          const repeated = await b.folder.pull();
          expect(repeated.ok && repeated.value.taken).toBe(0);
        }
        const visible = await a.folder.pullText();
        expect(visible.ok && visible.value).toContain(
          "cannot let it go to another folder",
        );
        expect(sourceState()).toBe(owned);
        expect(sourceJournal()).toBe(journal);
        allowRemoval();
        if (later === "edit") {
          appendFileSync(source, "owner edit\n");
          const kept = await a.folder.pull();
          expect(kept.ok && kept.value.let_go).toBe(0);
          expect(read(a, sourceKey)).toBe(before + "owner edit\n");
          const scanned = await a.folder.scan();
          expect(scanned.ok && scanned.value.updated).toBe(1);
          const queued = await a.folder.device().queue();
          expect(
            queued.ok &&
              queued.value.some(
                (row) =>
                  row.item_id === locked.id && row.kind === "update_item",
              ),
          ).toBe(true);
        } else {
          const released = await a.folder.pull();
          expect(released.ok && released.value.let_go).toBe(1);
          expect(existsSync(source)).toBe(false);
          expect(sourceState().trim()).toBe("");
          expect(sourceJournal().trim()).toBe("");
          expect((await a.folder.scan()).ok).toBe(true);
          const queued = await a.folder.device().queue();
          expect(
            queued.ok &&
              queued.value.filter((row) => row.kind === "delete_item"),
          ).toEqual([]);
        }
        expect(deletesOf(a.server, locked.id)).toBe(0);
        const quiet = await b.folder.scan();
        expect(quiet.ok && [quiet.value.created, quiet.value.updated]).toEqual([
          0, 0,
        ]);
      } finally {
        allowRemoval();
      }
    },
  );

  it.each([
    "copy-failure",
    "attribute-failure",
    "sync-failure",
    "create-before-rename",
    "symlink-before-rename",
    "crash-before-copy-publish",
    "crash-after-copy-publish",
  ])(
    "preserves a source across copy publication failures (%s)",
    async (fault) => {
      const item = {
        id: "01a00000-0000-7000-8000-0000000029b1",
        properties: { title: "Locked", body: "complete copy\n" },
      };
      const { a, b, edges } = await onOneMac(
        "protected-copy-failure",
        { search: { types: ["core.note"], filter: 'tags contains "a"' } },
        { search: { types: ["core.note"], filter: 'tags contains "b"' } },
        { "core.note": [{ item, tags: ["a"] }] },
      );
      expect((await a.folder.pull()).ok).toBe(true);
      expect((await b.folder.pull()).ok).toBe(true);
      const sourceKey = "Retained/Locked.md";
      expect((await a.folder.push()).ok).toBe(true);
      edges.relocate(item.id, a.settings.id, sourceKey);
      const source = join(a.dir, sourceKey);
      expect((await a.folder.push()).ok).toBe(true);
      // macOS confirms immutable protection. Other platforms use cross-volume
      // refusal plus a real directory permission denial to reach the copy path.
      const immutable = process.platform === "darwin";
      const target = join(b.dir, "Locked.md");
      const before = read(a, sourceKey);
      const allowRemoval = denySourceRemoval(source, immutable);
      try {
        edges.events.push(
          copyItemEvent(
            String(edges.events.length + 2),
            "metadata.changed",
            wireItem(item),
            {
              tags: ["b"],
            },
          ),
        );
        expect((await a.folder.push()).ok).toBe(true);
        const crashed = fault.startsWith("crash-");
        if (crashed) {
          await expect(
            withFault(
              `${immutable ? "" : "cross-volume-move,"}${fault}=Locked.md`,
              () => b.folder.push(),
            ),
          ).rejects.toThrow(/could not be run/);
        } else {
          const refused = await withFault(
            `${immutable ? "" : "cross-volume-move,"}${fault}=Locked.md`,
            () => b.folder.push(),
          );
          expect(
            refused.ok && [
              refused.value.pull?.taken,
              refused.value.pull?.unwritten,
            ],
          ).toEqual([0, 1]);
        }
        expect(read(a, sourceKey)).toBe(before);
        if (immutable) {
          expect(
            execFileSync("ls", ["-lO", source], { encoding: "utf8" }),
          ).toContain("uchg");
        } else {
          expect(statSync(join(source, "..")).mode & 0o222).toBe(0);
        }
        if (fault === "create-before-rename") {
          expect(read(b, "Locked.md")).toBe("appeared meanwhile\n");
          rmSync(target);
        } else if (fault === "symlink-before-rename") {
          expect(lstatSync(target).isSymbolicLink()).toBe(true);
          expect(readlinkSync(target)).toBe("absent-fixture-target");
          rmSync(target);
        } else if (fault === "crash-after-copy-publish") {
          expect(read(b, "Locked.md")).toBe(before);
        } else {
          expect(existsSync(target)).toBe(false);
        }
        const restarted = await b.folder.scan();
        expect(
          restarted.ok && [
            restarted.value.created,
            restarted.value.updated,
            restarted.value.missing,
          ],
        ).toEqual([0, 0, 0]);
        expect(
          readdirSync(b.dir).filter(
            (name) => name.startsWith(".marfa-") && name.endsWith(".tmp"),
          ),
        ).toEqual([]);
        const retry = await withFault(
          immutable ? "" : "cross-volume-move",
          () => b.folder.pull(),
        );
        expect(retry.ok && retry.value.taken).toBe(
          fault === "crash-after-copy-publish" ? 0 : 1,
        );
        expect(read(b, "Locked.md")).toContain("complete copy\n");
        expect(read(a, sourceKey)).toBe(before);
        expect(idIn(b, "Locked.md")).toBe(item.id);
        const quiet = await b.folder.scan();
        expect(quiet.ok && [quiet.value.created, quiet.value.updated]).toEqual([
          0, 0,
        ]);
        const queue = await b.folder.device().queue();
        expect(
          queue.ok && queue.value.filter((row) => row.kind === "delete_item"),
        ).toEqual([]);
        expect(deletesOf(a.server, item.id)).toBe(0);
      } finally {
        allowRemoval();
      }
    },
  );

  it("takes in a file another folder let go", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000023a1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const brief = {
      id: "01a00000-0000-7000-8000-0000000023a2",
      properties: { title: "Brief", body: "the brief\n" },
    };
    const { a, b, edges } = await onOneMac(
      "take-in",
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
      {
        "core.note": [
          { item: plan, tags: ["a"] },
          { item: brief, tags: ["a"] },
        ],
      },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    expect(existsSync(join(a.dir, "Plan.md"))).toBe(true);
    expect(existsSync(join(b.dir, "Plan.md"))).toBe(false);

    // Retagged elsewhere: the first folder's search lets it go, the
    // other's takes it.
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(plan),
        { tags: ["b"] },
      ),
    );
    const left = await a.folder.push();
    expect(left.ok, JSON.stringify(left)).toBe(true);
    const took = await b.folder.push();
    expect(took.ok, JSON.stringify(took)).toBe(true);
    if (!took.ok) return;
    expect(
      took.value.pull?.taken,
      "the folder holding the item wrote a file of its own, where the one another folder let go was there to take in",
    ).toBe(1);
    expect(took.value.pull?.written).toBe(0);
    expect(existsSync(join(b.dir, "Plan.md"))).toBe(true);
    expect(
      existsSync(join(a.dir, "Plan.md")),
      "the file stayed in the folder that let it go as well, so one item has a file in a folder that no longer holds it",
    ).toBe(false);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
    expect(sentCreates(b)).toEqual([]);

    // Changed elsewhere meanwhile, it is not written back where it was.
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

    // The folder that took it reads no change in it.
    const quiet = await b.folder.scan();
    expect(quiet.ok && [quiet.value.created, quiet.value.updated]).toEqual([
      0, 0,
    ]);
    expect((await b.folder.push()).ok).toBe(true);
    expect(edges.placements(b.settings.id).get(plan.id)).toBe("Plan.md");

    // The other way round: the folder that holds it now hears first and
    // writes a file of its own, and the folder it left lets its file go.
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(brief),
        { tags: ["b"] },
      ),
    );
    const first = await b.folder.push();
    expect(first.ok && first.value.pull?.written).toBe(1);
    const letGo = await a.folder.push();
    expect(letGo.ok, JSON.stringify(letGo)).toBe(true);
    if (!letGo.ok) return;
    expect(
      existsSync(join(a.dir, "Plan.md")),
      "a file another folder took in was written back where it was taken from",
    ).toBe(false);
    expect(
      letGo.value.pull?.let_go,
      "the folder that no longer holds the item kept its file beside the other folder's",
    ).toBe(1);
    expect(existsSync(join(a.dir, "Brief.md"))).toBe(false);
    expect(existsSync(join(b.dir, "Brief.md"))).toBe(true);

    // The folder it left trashes nothing.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(deletesOf(a.server, plan.id)).toBe(0);
    expect(deletesOf(a.server, brief.id)).toBe(0);

    // Past the grace, a file at the path it was taken from is a copy,
    // whatever it carries: the item's file is the one the other folder holds.
    writeFileSync(join(a.dir, "Plan.md"), read(b, "Plan.md"));
    const later = await a.folder.push();
    expect(later.ok, JSON.stringify(later)).toBe(true);
    if (!later.ok) return;
    expect(
      later.value.scan.created,
      "a later copy at the path the item was taken from took the item over",
    ).toBe(1);
  });

  it("ends a folder's placement of an item whose file another folder took in or let go", async () => {
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
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
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

    // The folder holding the item takes the file in: the folder it left
    // still has the file until then, and so its placement.
    retag(plan);
    expect((await a.folder.push()).ok).toBe(true);
    expect(
      edges.placements(a.settings.id).has(plan.id),
      "the placement ended while the file still sat in the folder",
    ).toBe(true);
    const took = await b.folder.push();
    expect(took.ok && took.value.pull?.taken).toBe(1);
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(
      edges.placements(a.settings.id).has(plan.id),
      "a folder went on placing an item whose file another folder took in",
    ).toBe(false);
    expect(edges.placements(b.settings.id).get(plan.id)).toBe("Plan.md");

    // The other way round: the folder holding the item writes its own file
    // first, and the folder it left lets its file go.
    retag(brief);
    expect((await b.folder.push()).ok).toBe(true);
    const letGo = await a.folder.push();
    expect(letGo.ok, JSON.stringify(letGo)).toBe(true);
    if (!letGo.ok) return;
    expect(letGo.value.pull?.let_go).toBe(1);
    expect(
      edges.placements(a.settings.id),
      "a folder went on placing an item whose file it let go",
    ).toEqual(new Map());
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

  it("leaves the binding of a file it let go where ending the placement fails, and the scan ends it past the grace", async () => {
    const brief = {
      id: "01a00000-0000-7000-8000-0000000023e3",
      properties: { title: "Brief", body: "the brief\n" },
    };
    const { a, b, edges } = await onOneMac(
      "placement-let-go-fails",
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
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
    expect((await b.folder.push()).ok).toBe(true);

    // The file is let go, and ending the placement fails after it.
    const failed = await withFault("end-placement-fails", () =>
      a.folder.push(),
    );
    expect(failed.ok, "the injected failure did not fail the push").toBe(false);
    expect(existsSync(join(a.dir, "Brief.md"))).toBe(false);
    expect(edges.placements(a.settings.id).has(brief.id)).toBe(true);

    // Inside the grace the scan finds the file missing and sends nothing.
    const writes = () =>
      a.server.requests.filter(
        (request) =>
          request.method !== "GET" &&
          (request.pathname.startsWith("/edges/") ||
            request.pathname === `/items/${brief.id}`),
      ).length;
    const before = writes();
    const early = await a.folder.push();
    expect(early.ok, JSON.stringify(early)).toBe(true);
    if (!early.ok) return;
    expect([early.value.scan.missing, early.value.scan.moved_away]).toEqual([
      1, 0,
    ]);
    expect(writes(), "a write went out inside the grace").toBe(before);
    expect(edges.placements(a.settings.id).has(brief.id)).toBe(true);

    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(
      swept.value.drain.verdicts.filter(
        (entry) => entry.kind === "delete_edge",
      ),
    ).toMatchObject([{ verdict: "accepted" }]);
    expect(edges.placements(a.settings.id).has(brief.id)).toBe(false);
    expect(existsSync(join(a.dir, "Brief.md"))).toBe(false);
    expect(deletesOf(a.server, brief.id)).toBe(0);
    expect(edges.placements(b.settings.id).get(brief.id)).toBe("Brief.md");
  });

  it("keeps a folder's placement of an item it holds when its file is moved to a folder that does not", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000023f1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const { a, b, edges } = await onOneMac(
      "placement-kept-on-move",
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: plan, tags: ["a"] }] },
    );
    expect((await a.folder.push()).ok).toBe(true);
    renameSync(join(a.dir, "Plan.md"), join(b.dir, "Plan.md"));
    expect((await b.folder.push()).ok).toBe(true);
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.moved_away).toBe(1);
    expect(
      edges.placements(a.settings.id).get(plan.id),
      "a folder ended its placement of an item its own search still holds",
    ).toBe("Plan.md");
    expect(deletesOf(a.server, plan.id)).toBe(0);
  });

  it.each(["same-volume", "cross-volume"])(
    "keeps both files when a destination appears just before a move-in (%s)",
    async (mode) => {
      const plan = {
        id: "01a00000-0000-7000-8000-0000000023d1",
        properties: { title: "Plan", body: "the plan\n" },
      };
      const control = {
        id: "01a00000-0000-7000-8000-0000000023d2",
        properties: { title: "Control", body: "the control\n" },
      };
      const { a, b, edges } = await onOneMac(
        "take-in-no-replace",
        { search: { types: ["core.note"], filter: 'tags contains "a"' } },
        { search: { types: ["core.note"], filter: 'tags contains "b"' } },
        {
          "core.note": [
            { item: plan, tags: ["a"] },
            { item: control, tags: ["a"] },
          ],
        },
      );
      expect((await a.folder.pull()).ok).toBe(true);
      expect((await b.folder.pull()).ok).toBe(true);
      for (const item of [plan, control]) {
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
      const before = read(a, "Plan.md");
      const controlBytes = read(a, "Control.md");
      const fault =
        mode === "same-volume"
          ? "create-before-move=Plan.md"
          : "cross-volume-move,create-before-rename=Plan.md";
      const moved = await withFault(fault, () => b.folder.push());
      expect(moved.ok, JSON.stringify(moved)).toBe(true);
      if (!moved.ok) return;
      expect(read(b, "Control.md")).toBe(controlBytes);
      expect(existsSync(join(a.dir, "Control.md"))).toBe(false);
      expect(read(b, "Plan.md")).toBe("appeared meanwhile\n");
      expect(read(a, "Plan.md")).toBe(before);
      expect(moved.value.pull?.taken).toBe(1);
      expect(moved.value.pull?.unwritten).toBe(1);
      const source = await a.folder.status();
      const destination = await b.folder.status();
      expect(
        source.ok &&
          source.value.files.find((file) => file.path === "Plan.md")?.item_id,
      ).toBe(plan.id);
      expect(
        destination.ok &&
          destination.value.files.find((file) => file.path === "Plan.md")
            ?.item_id,
      ).toBeUndefined();
      rmSync(join(b.dir, "Plan.md"));
      const retry = await b.folder.pull();
      expect(retry.ok && retry.value.taken, JSON.stringify(retry)).toBe(1);
      expect(read(b, "Plan.md")).toBe(before);
      expect(existsSync(join(a.dir, "Plan.md"))).toBe(false);
      const scan = await b.folder.scan();
      expect(scan.ok && [scan.value.created, scan.value.updated]).toEqual([
        0, 0,
      ]);
    },
  );

  it.each([
    { mode: "same-volume", previous: false },
    { mode: "cross-volume", previous: false },
    { mode: "same-volume", previous: true },
    { mode: "cross-volume", previous: true },
    { mode: "already-present", previous: false },
    { mode: "unopposed-move", previous: true },
    { mode: "unopposed-copy", previous: true },
    { mode: "protected", previous: false },
    { mode: "protected", previous: true },
    { mode: "unopposed-protected", previous: true },
    { mode: "directory-control", previous: false },
    { mode: "directory-control", previous: true },
    { mode: "unopposed-directory-control", previous: true },
  ])(
    "preserves ownership for an identical move destination ($mode, previous binding $previous)",
    async ({ mode, previous }) => {
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
        "identical-move-destination",
        { search: { types: ["core.file.image"], filter: 'tags contains "a"' } },
        {
          search: {
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
      const retained =
        mode.includes("protected") || mode.includes("directory-control");
      const immutable =
        process.platform === "darwin" && mode.includes("protected");
      const sourceKey =
        retained && !immutable ? "Retained/photo.png" : "photo.png";
      const source = join(a.dir, sourceKey);
      if (sourceKey !== "photo.png") {
        expect((await a.folder.push()).ok).toBe(true);
        edges.relocate(photo.id, a.settings.id, sourceKey);
        expect((await a.folder.push()).ok).toBe(true);
      }
      edges.events.push(
        copyItemEvent(
          String(edges.events.length + 2),
          "metadata.changed",
          wireItem(photo),
          { tags: ["b"] },
        ),
      );
      const allowRemoval = retained
        ? denySourceRemoval(source, immutable)
        : undefined;
      const pulled = await (async () => {
        try {
          expect((await a.folder.push()).ok).toBe(true);
          expect((await b.folder.device().catchUp()).ok).toBe(true);
          if (mode === "already-present")
            writeFileSync(join(b.dir, "photo.png"), bytes);
          const fault =
            mode === "same-volume"
              ? "create-before-move=photo.png"
              : mode === "cross-volume" ||
                  mode === "protected" ||
                  mode === "directory-control"
                ? `${mode === "cross-volume" ? "cross-volume-move," : ""}create-before-rename=photo.png`
                : mode === "unopposed-copy"
                  ? "cross-volume-move"
                  : "";
          const copied = retained && !immutable;
          return await withFault(
            `${copied ? "cross-volume-move," : ""}${fault}`,
            () => b.folder.pull(),
          );
        } finally {
          allowRemoval?.();
        }
      })();
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      const unopposed = mode.startsWith("unopposed-");
      if (unopposed && !retained) expect(existsSync(source)).toBe(false);
      else expect(readFileSync(source)).toEqual(bytes);
      expect(readFileSync(join(b.dir, "photo.png"))).toEqual(bytes);
      const status = await b.folder.status();
      if (unopposed) {
        expect(
          pulled.ok && [pulled.value.unwritten, pulled.value.taken],
        ).toEqual([0, 1]);
        expect(
          status.ok &&
            status.value.files.find((file) => file.path === "photo.png")
              ?.item_id,
        ).toBe(photo.id);
      } else if (mode === "already-present") {
        expect(
          pulled.ok && [pulled.value.unwritten, pulled.value.unchanged],
        ).toEqual([0, 1]);
        expect(
          status.ok &&
            status.value.files.find((file) => file.path === "photo.png")
              ?.item_id,
        ).toBe(photo.id);
      } else {
        expect(
          pulled.ok && [
            pulled.value.unwritten,
            pulled.value.unchanged,
            pulled.value.taken,
          ],
        ).toEqual([1, 0, 0]);
        expect(
          status.ok &&
            status.value.files.find((file) => file.path === "photo.png")
              ?.item_id,
        ).toBe(previous ? gone.id : undefined);
        const reconsidered = await b.folder.pull();
        expect(
          reconsidered.ok && [
            reconsidered.value.unwritten,
            reconsidered.value.unchanged,
          ],
        ).toEqual([0, 1]);
        expect(readFileSync(source)).toEqual(bytes);
        expect(readFileSync(join(b.dir, "photo.png"))).toEqual(bytes);
        const rebound = await b.folder.status();
        expect(
          rebound.ok &&
            rebound.value.files.find((file) => file.path === "photo.png")
              ?.item_id,
        ).toBe(photo.id);
      }
      if (previous) {
        await pastTheGrace();
        expect((await b.folder.scan()).ok).toBe(true);
        const queued = await b.folder.device().queue();
        expect(
          queued.ok &&
            queued.value
              .filter((row) => row.kind === "delete_item")
              .map((row) => row.item_id),
        ).toEqual([gone.id]);
      }
    },
  );

  it("takes no file back by its bytes for an item another folder on the Mac took in", async () => {
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
      { search: { types: ["core.file.image"], filter: 'tags contains "a"' } },
      { search: { types: ["core.file.image"], filter: 'tags contains "b"' } },
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

    // Retagged elsewhere: the other folder takes the file in.
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(photo),
        { tags: ["b"] },
      ),
    );
    expect((await a.folder.push()).ok).toBe(true);
    const took = await b.folder.push();
    expect(took.ok && took.value.pull?.taken, JSON.stringify(took)).toBe(1);
    expect(existsSync(join(a.dir, "photo.png"))).toBe(false);
    // The first folder finds its file moved, past the grace, and lets its
    // binding go.
    expect((await a.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await a.folder.push();
    expect(swept.ok && swept.value.scan.moved_away).toBe(1);
    expect(
      edges.placements(a.settings.id).has(photo.id),
      "the first folder went on placing an item whose file another folder took in",
    ).toBe(false);
    const creates = sentCreates(a).length;

    // A copy put back where the file sat in the first folder is a new item:
    // one item is never edited from two places.
    copyFileSync(join(b.dir, "photo.png"), join(a.dir, "photo.png"));
    const copied = await a.folder.push();
    expect(copied.ok, JSON.stringify(copied)).toBe(true);
    if (!copied.ok) return;
    expect(
      sentCreates(a).length - creates,
      "a copy of another folder's file was taken as that item's file here",
    ).toBe(1);
  });

  it("keeps a file saved back where another folder took the item's file from as the item's while its binding lasts", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000023b1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const { a, b, edges } = await onOneMac(
      "saved-back",
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
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
    const took = await b.folder.push();
    expect(took.ok && took.value.pull?.taken).toBe(1);

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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
    let third: FolderRow | undefined;
    const { a } = await onOneMac(
      "unreadable-registry",
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
      {
        "core.note": [
          { item: { id: gone, properties: { title: "Gone", body: "g\n" } } },
        ],
      },
      (server) => {
        third = scriptFolderRow(server, { search: { types: ["core.note"] } });
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
      "this folder stands alone, since the folder registry cannot be read",
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
    const { a, edges } = await onOneMac(
      "held-no-write",
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
      { "core.note": [{ item: held }, { item: graced }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
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

    // Inside the grace, the same change writes its file back
    // (`folders/delete-remote-revives`).
    rmSync(join(a.dir, "Graced.md"));
    expect((await a.folder.push()).ok).toBe(true);
    for (const item of [held, graced]) {
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
    const heard = await a.folder.device().catchUp();
    expect(heard.ok && heard.value.applied).toBe(2);
    const pulled = await a.folder.push();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(read(a, "Graced.md")).toContain("their edit");
    expect(pulled.value.scan.unsure.map((file) => file.path)).toEqual([
      "Held.md",
    ]);
    expect(
      existsSync(join(a.dir, "Held.md")),
      "a file whose delete is held was written back, so a folder it may have moved to reads it as a copy",
    ).toBe(false);
    expect(deletesOf(a.server, held.id)).toBe(0);
  });

  it("refuses a folder inside another, and walks past a folder inside it", async () => {
    harness = await folderHarness("nested-outer", {
      settings: {
        search: { types: ["core.note"] },
        first_placement: { "core.note": "inner/" },
      },
      rows: {
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
    const innerRow = scriptFolderRow(harness.server, {
      search: { types: ["core.note"] },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
    expect(placed.map((edge) => [edge.source_id, edge.properties])).toEqual([
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
      { search: { types: ["core.file"] } },
      { search: { types: ["core.bookmark"] } },
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
        { search: both },
        { search: both, ignore: ["*.dat"] },
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
      // its search still holds the items, writes their files again.
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
      {
        "core.note": [note(shown, "Shown"), note(unseen, "Unseen")],
      },
      (server) => {
        server.copyAnswer(
          "GET",
          `/items/${unseen}`,
          answers.itemNotFound(unseen),
        );
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
    const home = mkdtempSync(join(realpathSync(tmpdir()), "marfa-home-"));
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note", "core.file"] } },
      { search: { types: ["core.file"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.note"] } },
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

  it("does not take in a let-go file edited since its folder last read it", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000041d1",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const brief = {
      id: "01a00000-0000-7000-8000-0000000041d3",
      properties: { title: "Brief", body: "the brief\n" },
    };
    const picture = Buffer.from(
      "a picture fetched before the brief is taken\n",
    );
    // Made later than the brief, so the pull that takes the brief in
    // fetches it first.
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
      "let-go-edited",
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      {
        search: {
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
        // The brief is edited while the pull that would take it in fetches
        // this picture, after it read the brief and before it moves it.
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
    const took = await b.folder.push();
    expect(took.ok, JSON.stringify(took)).toBe(true);
    if (!took.ok) return;
    expect(
      took.value.pull?.taken,
      "a let-go file was taken in with an edit its folder had not read, so the edit is never sent",
    ).toBe(0);
    expect(read(a, "Plan.md")).toContain("edited, not yet read\n");

    // Edited after the pull that takes it in read it, it is read again just
    // before it is taken.
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
    expect(
      racing.value.pull?.taken,
      "a let-go file edited after the pull read it was taken in, its edit with it",
    ).toBe(0);
    expect(read(a, "Brief.md")).toContain("edited mid-pull\n");
    expect(read(b, "Brief.md")).toContain("the brief\n");
  });

  it("does not take in the file of an item that left its folder by state", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-0000000041d2",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const { a, b, edges } = await onOneMac(
      "left-by-state",
      { search: { types: ["core.note"], state: ["active"] } },
      { search: { types: ["core.note"], state: ["archived"] } },
      { "core.note": [{ item: plan }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    expect(existsSync(join(b.dir, "Plan.md"))).toBe(false);
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.updated",
        wireItem({ ...plan, version: 2, state: "archived" }),
      ),
    );
    // The folder it left has heard, and not pulled yet: its file is still
    // there, its own bytes, for a pull to take away (35).
    const heard = await a.folder.device().catchUp();
    expect(heard.ok && heard.value.applied).toBe(1);
    const pulled = await b.folder.push();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.pull?.taken,
      "a file its folder was taking away by state was taken in, as though it had been let go",
    ).toBe(0);
    expect(pulled.value.pull?.written).toBe(1);
    expect(read(b, "Plan.md")).toContain("state: archived");
    expect(existsSync(join(a.dir, "Plan.md"))).toBe(true);
    const left = await a.folder.pull();
    expect(left.ok && left.value.removed).toBe(1);
    expect(existsSync(join(a.dir, "Plan.md"))).toBe(false);
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
    const other = scriptFolderRow(harness.server, {
      search: { types: ["core.note"] },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
    let more: FolderRow | undefined;
    const { a, b } = await onOneMac(
      `root-replaced-${site}`,
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
      {
        "core.note": [
          {
            item: { id: moved, properties: { title: "Moved", body: "m\n" } },
          },
        ],
      },
      (server) => {
        more = scriptFolderRow(server, {
          search: { types: ["core.event"] },
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
    let more: FolderRow | undefined;
    const { a, b } = await onOneMac(
      "root-replaced-other",
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
      {},
      (server) => {
        more = scriptFolderRow(server, { search: { types: ["core.event"] } });
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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

  it("holds a delete while another folder cannot be read whole", async () => {
    const gone = "01a00000-0000-7000-8000-0000000040f1";
    const { a, b } = await onOneMac(
      "partial-walk",
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.note"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] }, include: [".notes/"] },
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
        search: { types: ["core.note"] },
        removal_threshold: { files: 2, fraction: 0.25 },
      },
      { search: { types: ["core.bookmark"] } },
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

  it("confirms a large removal while another folder holds files that are not text", async () => {
    const ids = [0, 1, 2, 3, 4, 5].map(
      (n) => `01a00000-0000-7000-8000-0000000018${String(n).padStart(2, "0")}`,
    );
    const { a, b } = await onOneMac(
      "confirm-not-text",
      {
        search: { types: ["core.note"] },
        removal_threshold: { files: 2, fraction: 0.25 },
      },
      { search: { types: ["core.bookmark"] } },
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

  it("holds a file that is not text on its own, and takes it in once it can be read", async () => {
    const gone = "01a00000-0000-7000-8000-000000001841";
    const kept = "01a00000-0000-7000-8000-000000001842";
    const { a, b } = await onOneMac(
      "not-text-alone",
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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
      { search: { types: ["core.note"] } },
      { search: { types: ["core.bookmark"] } },
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

  it("keeps a file a crash cut off taking in where it was, and journals no delete", async () => {
    const plan = {
      id: "01a00000-0000-7000-8000-00000000fa45",
      properties: { title: "Plan", body: "the plan\n" },
    };
    const { a, b, edges } = await onOneMac(
      "take-in-cut-off",
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: plan, tags: ["a"] }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    edges.events.push(
      copyItemEvent("2", "metadata.changed", wireItem(plan), { tags: ["b"] }),
    );
    expect((await a.folder.push()).ok).toBe(true);
    await expect(
      withFault("crash-before-rename=Plan.md", () => b.folder.push()),
    ).rejects.toThrow(/could not be run/);
    // The witness: the crash came before the file moved.
    expect([
      existsSync(join(a.dir, "Plan.md")),
      existsSync(join(b.dir, "Plan.md")),
    ]).toEqual([true, false]);
    const after = await b.folder.scan();
    expect(after.ok, JSON.stringify(after)).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.missing,
      "a file a crash kept from being taken in was journaled as deleted",
    ).toBe(0);
    // And the next push takes it in.
    const took = await b.folder.push();
    expect(took.ok && took.value.pull?.taken).toBe(1);
    expect(idIn(b, "Plan.md")).toBe(plan.id);
  });

  it("leaves a file it let go where the person saved it meanwhile", async () => {
    const brief = {
      id: "01a00000-0000-7000-8000-00000000fa41",
      properties: { title: "Brief", body: "the brief\n" },
    };
    const { a, b, edges } = await onOneMac(
      "let-go-last-look",
      { search: { types: ["core.note"], filter: 'tags contains "a"' } },
      { search: { types: ["core.note"], filter: 'tags contains "b"' } },
      { "core.note": [{ item: brief, tags: ["a"] }] },
    );
    expect((await a.folder.pull()).ok).toBe(true);
    expect((await b.folder.pull()).ok).toBe(true);
    edges.events.push(
      copyItemEvent("2", "metadata.changed", wireItem(brief), { tags: ["b"] }),
    );
    const first = await b.folder.push();
    expect(first.ok && first.value.pull?.written).toBe(1);
    // The person saves the file in the folder it leaves just as the pull
    // takes it away.
    const letGo = await withFault("save-before-last-look", () =>
      a.folder.push(),
    );
    expect(letGo.ok, JSON.stringify(letGo)).toBe(true);
    if (!letGo.ok) return;
    expect(
      [letGo.value.pull?.let_go, read(a, "Brief.md")],
      "a file let go to another folder was removed with the person's save in it",
    ).toEqual([0, expect.stringContaining("saved meanwhile")]);
    // The save landed after the pull chose to let the file go, which
    // `› takes in a file another folder let go` shows it does unsaved.
  });
});
