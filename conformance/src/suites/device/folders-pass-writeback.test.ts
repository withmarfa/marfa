import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { folderHarness } from "./harness.js";
import type { FolderHarness } from "./harness.js";
import type { FolderDoor } from "../../device/folder-door.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import {
  EdgeDoor,
  idIn,
  put,
  read,
  scriptFolderWrites,
  sentCreates,
  sentUpdates,
} from "./folders.shared.js";

let harness: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The folder's files, its own state left out. */
function filesIn(harness: FolderHarness, dir = harness.dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".marfa")
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesIn(harness, join(dir, entry.name))
        : [relative(harness.dir, join(dir, entry.name))],
    )
    .sort();
}

function deletes(harness: FolderHarness): string[] {
  return harness.server.requests
    .filter((request) => request.method === "DELETE")
    .map((request) => request.pathname);
}

/**
 * A folder whose notes were scanned and sent as one pass does before its
 * pull, so the pull is the next thing to reach them, and the door that
 * stands in for another device.
 */
async function sentNotNamed(
  label: string,
  notes: Record<string, string>,
  settings?: FolderSettings,
): Promise<{ door: FolderDoor; edges: EdgeDoor; ids: Map<string, string> }> {
  const edges = new EdgeDoor();
  harness = await folderHarness(label, { events: [edges.stream()], settings });
  let door: FolderDoor | undefined;
  scriptFolderWrites(harness, {
    edges,
    door: (made) => {
      door = made;
    },
  });
  for (const [name, text] of Object.entries(notes)) put(harness, name, text);
  const scanned = await harness.folder.scan();
  expect(scanned.ok && scanned.value.created).toBe(Object.keys(notes).length);
  expect((await harness.folder.device().drain()).ok).toBe(true);
  const ids = new Map(
    sentCreates(harness).map((sent) => [
      String((sent.properties as Record<string, unknown>).title),
      String(sent.id),
    ]),
  );
  return { door: door!, edges, ids };
}

const note = (title: string, body: string) =>
  `---\ntitle: ${title}\n---\n${body}\n`;

describe("a file moved or deleted between a pass's scan and its pull", () => {
  it("does not write back a file moved after the scan, and the next scan follows the move", async () => {
    const { ids } = await sentNotNamed("folder-pass-moved", {
      "note.md": note("Note", "words"),
    });
    renameSync(join(harness!.dir, "note.md"), join(harness!.dir, "moved.md"));

    const pulled = await harness!.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      existsSync(join(harness!.dir, "note.md")),
      "the pull wrote a moved file back at its old path, so the note is in the folder twice",
    ).toBe(false);
    expect(pulled.value.unwritten).toBe(1);

    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect([
      pushed.value.scan.renamed,
      pushed.value.scan.created,
      pushed.value.scan.missing,
    ]).toEqual([1, 0, 0]);
    // The witness: left in place, the pull writes the id back into it.
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(filesIn(harness!)).toEqual(["moved.md"]);
    expect(idIn(harness!, "moved.md")).toBe(ids.get("Note"));
    expect(sentCreates(harness!)).toHaveLength(1);
    expect(deletes(harness!)).toEqual([]);
  });

  it("does not write back a file renamed with its title line after the scan, and keeps its item", async () => {
    const { ids } = await sentNotNamed("folder-pass-retitled", {
      "Note.md": note("Note", "words"),
    });
    renameSync(join(harness!.dir, "Note.md"), join(harness!.dir, "Renamed.md"));
    put(harness!, "Renamed.md", note("Renamed", "words"));

    const pulled = await harness!.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      existsSync(join(harness!.dir, "Note.md")),
      "the pull wrote a renamed file back under its old name",
    ).toBe(false);

    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect([
      pushed.value.scan.renamed,
      pushed.value.scan.created,
      pushed.value.scan.missing,
    ]).toEqual([1, 0, 0]);
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(filesIn(harness!)).toEqual(["Renamed.md"]);
    expect(idIn(harness!, "Renamed.md")).toBe(ids.get("Note"));
    expect(read(harness!, "Renamed.md")).toContain("title: Renamed");
    expect(
      sentUpdates(harness!).map((sent) => [
        sent.id,
        (sent.body.properties as Record<string, unknown> | undefined)?.title,
      ]),
    ).toContainEqual([ids.get("Note"), "Renamed"]);
    expect(sentCreates(harness!)).toHaveLength(1);
    expect(deletes(harness!)).toEqual([]);
  });

  it("does not write back a file deleted after the scan, and journals the delete", async () => {
    await sentNotNamed("folder-pass-deleted", {
      "note.md": note("Note", "words"),
      "kept.md": note("Kept", "words"),
    });
    rmSync(join(harness!.dir, "note.md"));

    const pulled = await harness!.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      existsSync(join(harness!.dir, "note.md")),
      "the pull wrote back a file the person deleted",
    ).toBe(false);
    expect(pulled.value.unwritten).toBe(1);
    // The witness: the file left in place took its id back.
    expect(idIn(harness!, "kept.md")).toBeDefined();

    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.missing).toBe(1);
    expect(pushed.value.pull?.revived).toBe(0);
    expect(filesIn(harness!)).toEqual(["kept.md"]);
  });

  it("does not write back a file with no title line deleted after the scan, and brings it back for a new title", async () => {
    const { door, edges, ids } = await sentNotNamed("folder-pass-untitled", {
      "gone.md": "words\n",
      "renamed.md": "words\n",
    });
    rmSync(join(harness!.dir, "gone.md"));
    rmSync(join(harness!.dir, "renamed.md"));
    edges.logItem(
      "item.updated",
      door.update(ids.get("renamed")!, {
        properties: { title: "Retitled" },
        version: 1,
      }),
    );
    const caught = await harness!.folder.device().catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect((await harness!.folder.pull()).ok).toBe(true);

    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.missing).toBe(2);
    // The witness: a title the file never showed is a change it shows, and
    // brings the file back.
    expect(
      pushed.value.pull?.revived,
      "the title the folder took from a file's name read as a change, and brought back a file the person deleted",
    ).toBe(1);
    expect(filesIn(harness!)).toEqual(["Retitled.md"]);
    expect(idIn(harness!, "Retitled.md")).toBe(ids.get("renamed"));
  });

  it.each([
    ["title", { title: "Default" }],
    ["title and another property", { title: "Default", mood: "calm" }],
  ])(
    "does not write back a file with no title line deleted after the scan whose %s its folder's defaults gave, and brings it back for a title that matches its name",
    async (label, properties) => {
      const { door, edges } = await sentNotNamed(
        `folder-pass-default-${label.replaceAll(" ", "-")}`,
        { "gone.md": "gone words\n", "note.md": "note words\n" },
        { defaults: { properties } },
      );
      const ids = new Map(
        sentCreates(harness!).map((sent) => [
          String((sent.properties as Record<string, unknown>).body),
          String(sent.id),
        ]),
      );
      expect(
        sentCreates(harness!).map(
          (sent) => (sent.properties as Record<string, unknown>).title,
        ),
      ).toEqual(["Default", "Default"]);
      rmSync(join(harness!.dir, "gone.md"));
      rmSync(join(harness!.dir, "note.md"));
      // Another device gives the note the title its file's name says, which is
      // not the title the folder gave it.
      const noted = ids.get("note words\n")!;
      edges.logItem(
        "item.updated",
        door.update(noted, { properties: { title: "note" }, version: 1 }),
      );
      const caught = await harness!.folder.device().catchUp();
      expect(caught.ok, JSON.stringify(caught)).toBe(true);
      expect((await harness!.folder.pull()).ok).toBe(true);

      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (!pushed.ok) return;
      expect(pushed.value.scan.missing).toBe(2);
      expect(
        filesIn(harness!),
        `the ${label} the folder's defaults gave read as a change, or a new title that matches the file's name read as none`,
      ).toEqual(["note.md"]);
      expect(pushed.value.pull?.revived).toBe(1);
      expect(idIn(harness!, "note.md")).toBe(noted);
    },
  );

  it("keeps the edit of a file moved and edited after the scan, and makes no second item", async () => {
    const { ids } = await sentNotNamed("folder-pass-moved-edited", {
      "note.md": note("Note", "words"),
    });
    renameSync(join(harness!.dir, "note.md"), join(harness!.dir, "moved.md"));
    put(harness!, "moved.md", note("Note", "words, and typed since"));

    const pulled = await harness!.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(existsSync(join(harness!.dir, "note.md"))).toBe(false);

    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect([
      pushed.value.scan.renamed,
      pushed.value.scan.created,
      pushed.value.scan.missing,
    ]).toEqual([1, 0, 0]);
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(filesIn(harness!)).toEqual(["moved.md"]);
    expect(read(harness!, "moved.md")).toContain("words, and typed since");
    expect(idIn(harness!, "moved.md")).toBe(ids.get("Note"));
    expect(
      sentUpdates(harness!).some(
        (sent) =>
          sent.id === ids.get("Note") &&
          JSON.stringify(sent.body).includes("words, and typed since"),
      ),
      "the edit made as the file moved was not sent",
    ).toBe(true);
    expect(sentCreates(harness!)).toHaveLength(1);
    expect(deletes(harness!)).toEqual([]);
  });

  it("writes back none of a burst of files moved and deleted after the scan", async () => {
    const { ids } = await sentNotNamed("folder-pass-burst", {
      "one.md": note("One", "1"),
      "two.md": note("Two", "2"),
      "three.md": note("Three", "3"),
      "four.md": note("Four", "4"),
      "five.md": note("Five", "5"),
    });
    const dir = harness!.dir;
    renameSync(join(dir, "one.md"), join(dir, "one moved.md"));
    mkdirSync(join(dir, "sub"));
    renameSync(join(dir, "two.md"), join(dir, "sub", "two.md"));
    rmSync(join(dir, "three.md"));
    rmSync(join(dir, "four.md"));

    const pulled = await harness!.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.unwritten).toBe(4);
    // The witness: the one file left in place took its id back.
    expect(idIn(harness!, "five.md")).toBe(ids.get("Five"));
    expect(filesIn(harness!)).toEqual([
      "five.md",
      "one moved.md",
      "sub/two.md",
    ]);

    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect([
      pushed.value.scan.renamed,
      pushed.value.scan.created,
      pushed.value.scan.missing,
    ]).toEqual([2, 0, 2]);
    expect(pushed.value.pull?.revived).toBe(0);
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(filesIn(harness!)).toEqual([
      "five.md",
      "one moved.md",
      "sub/two.md",
    ]);
    expect(idIn(harness!, "one moved.md")).toBe(ids.get("One"));
    expect(idIn(harness!, "sub/two.md")).toBe(ids.get("Two"));
    expect(sentCreates(harness!)).toHaveLength(5);
  });

  it("writes a remote change into a file in place, and brings back a file deleted after the scan once its delete is journaled", async () => {
    const { door, edges, ids } = await sentNotNamed("folder-pass-revived", {
      "gone.md": note("Gone", "words"),
      "here.md": note("Here", "words"),
    });
    // Both ids written back, so the next pass starts at rest.
    expect((await harness!.folder.pull()).ok).toBe(true);
    expect((await harness!.folder.scan()).ok).toBe(true);
    rmSync(join(harness!.dir, "gone.md"));
    for (const title of ["Gone", "Here"]) {
      edges.logItem(
        "item.updated",
        door.update(ids.get(title)!, {
          properties: { body: "their edit\n" },
          version: 1,
        }),
      );
    }
    const caught = await harness!.folder.device().catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    const pulled = await harness!.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    // The witness: a file in place takes the change.
    expect(read(harness!, "here.md")).toContain("their edit");
    expect(existsSync(join(harness!.dir, "gone.md"))).toBe(false);
    expect(pulled.value.unwritten).toBe(1);

    // Journaled, its item's change in content it shows brings it back.
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.missing).toBe(1);
    expect(pushed.value.pull?.revived).toBe(1);
    expect(read(harness!, "gone.md")).toContain("their edit");
    expect(idIn(harness!, "gone.md")).toBe(ids.get("Gone"));
    const again = await harness!.folder.push();
    expect(
      again.ok && [again.value.scan.created, again.value.scan.missing],
    ).toEqual([0, 0]);
    expect(filesIn(harness!)).toEqual(["gone.md", "here.md"]);
    expect(deletes(harness!)).toEqual([]);
    expect(sentUpdates(harness!)).toEqual([]);
  });

  it("counts a file the pull wrote itself and deleted after the scan as unwritten, not unchanged", async () => {
    const { door, edges, ids } = await sentNotNamed("folder-pass-own-gone", {
      "gone.md": note("Gone", "words"),
      "here.md": note("Here", "words"),
    });
    expect((await harness!.folder.pull()).ok).toBe(true);
    expect((await harness!.folder.scan()).ok).toBe(true);
    // Deleted and brought back, the file holds only what the pull rendered.
    rmSync(join(harness!.dir, "gone.md"));
    edges.logItem(
      "item.updated",
      door.update(ids.get("Gone")!, {
        properties: { body: "their edit\n" },
        version: 1,
      }),
    );
    expect((await harness!.folder.device().catchUp()).ok).toBe(true);
    expect((await harness!.folder.pull()).ok).toBe(true);
    const revived = await harness!.folder.push();
    expect(revived.ok && revived.value.pull?.revived).toBe(1);
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(read(harness!, "gone.md")).toContain("their edit");
    rmSync(join(harness!.dir, "gone.md"));

    const pulled = await harness!.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(existsSync(join(harness!.dir, "gone.md"))).toBe(false);
    // The witness: the file left in place is unchanged.
    expect([pulled.value.unwritten, pulled.value.unchanged]).toEqual([1, 1]);
    expect(
      pulled.value.flagged.map((flagged) => [flagged.path, flagged.flag]),
    ).toEqual([["gone.md", "unwritten"]]);
    expect(idIn(harness!, "here.md")).toBe(ids.get("Here"));
  });
});
