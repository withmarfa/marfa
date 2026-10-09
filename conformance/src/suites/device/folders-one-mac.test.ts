import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
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
    expect(existsSync(join(second.dir, ".marfa"))).toBe(false);
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
    expect(existsSync(join(harness.dir, "inner", ".marfa"))).toBe(false);
    const holding = await inside(join(harness.dir, "..")).add(innerRow.id);
    expect(holding.ok || holding.refusal.raw).toContain(
      "a folder cannot sit inside another",
    );

    // A folder inside, on another machine's registry say, is its own.
    mkdirSync(join(harness.dir, "inner", ".marfa"));
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
    mkdirSync(join(harness.dir, "inner", ".marfa"));
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

  it("refuses to remove a folder a watch holds", async () => {
    harness = await folderHarness("remove-watched");
    scriptFolderWrites(harness);
    const watch = harness.folder.watch();
    try {
      await vi.waitFor(() => {
        expect(watch.stderr).toContain("watching");
      });
      const refused = await harness.folder.remove();
      expect(
        refused.ok,
        "a folder was removed from under its running watch",
      ).toBe(false);
      if (refused.ok) return;
      expect(refused.refusal.code).toBe("reading_handle");
      expect(refused.refusal.raw).toContain("folders watch");
      expect(existsSync(join(harness.dir, ".marfa"))).toBe(true);
    } finally {
      await watch.stop();
    }
    const removed = await harness.folder.remove();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
  });

  it("lets one process work a folder at a time, and answers its status beside it", async () => {
    harness = await folderHarness("one-worker", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000f0a1",
              properties: { title: "Kept", body: "as it was\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    const watch = harness.folder.watch();
    try {
      await vi.waitFor(
        () => {
          expect(existsSync(join(harness!.dir, "Kept.md"))).toBe(true);
        },
        { timeout: 30_000, interval: 100 },
      );
      for (const [name, run] of [
        ["pull", () => harness!.folder.pull()],
        ["scan", () => harness!.folder.scan()],
        ["push", () => harness!.folder.push()],
        ["confirm", () => harness!.folder.confirm()],
      ] as const) {
        const refused = await run();
        expect(
          refused.ok,
          `a ${name} worked the folder beside its running watch`,
        ).toBe(false);
        if (refused.ok) continue;
        expect(refused.refusal.code, refused.refusal.raw).toBe(
          "reading_handle",
        );
      }
      const another = harness.folder.watch();
      await vi.waitFor(() => {
        expect(another.running(), "a second watch ran beside the first").toBe(
          false,
        );
      });
      expect(another.stderr).toContain("folders watch");
      // Status writes nothing, so it answers beside the watch.
      const status = await harness.folder.status();
      expect(status.ok, JSON.stringify(status)).toBe(true);
      expect(watch.running(), watch.stderr).toBe(true);
    } finally {
      await watch.stop();
    }
    // The witness: alone, the same pull works the folder.
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
  });

  it("lists a folder reached through a symlink once, and never as another", async () => {
    harness = await folderHarness("renamed-folder");
    scriptFolderWrites(harness);
    put(harness, "One.txt", "same\n");
    put(harness, "Two.txt", "same\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const [one] = sentCreates(harness).map((sent) => String(sent.id));
    const real = realpathSync(harness.dir);
    renameSync(real, `${real}-renamed`);
    symlinkSync(`${real}-renamed`, real);
    expect((await harness.folder.push()).ok).toBe(true);
    const listed = await harness.folder.list();
    expect(
      listed.ok && listed.value.map((entry) => entry.dir),
      "a folder reached through a symlink was listed under both names",
    ).toEqual([`${real}-renamed`]);

    rmSync(join(harness.dir, "One.txt"));
    expect((await harness.folder.push()).ok).toBe(true);
    await pastTheGrace();
    const swept = await harness.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.trashed).toEqual(["One.txt"]);
    expect(deletesOf(harness.server, String(one))).toBe(1);
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
    expect(swept.value.scan.moved_away).toBe(2);
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
    const home = mkdtempSync(join(tmpdir(), "marfa-home-"));
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
