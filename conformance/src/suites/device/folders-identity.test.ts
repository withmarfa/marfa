import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  copyHeadRead,
  copyItemEvent,
  copyLiveReplay,
  refusal,
  copyReplay,
  wireItem,
} from "../../device/marfa-answers.js";
import {
  acceptUploads,
  folderHarness,
  folderItem,
  hashOf,
  scriptBlob,
  scriptWrites,
} from "./harness.js";
import { FolderDoor, type DoorCreate } from "../../device/folder-door.js";
import type { FolderHarness } from "./harness.js";
import type { Answer } from "../../device/scripted-server.js";
import {
  EdgeDoor,
  idIn,
  itemVerdicts,
  put,
  read,
  saveAtomically,
  scriptFolderChanges,
  scriptFolderWrites,
  sentCreates,
  sentTitles,
  sentUpdates,
  settingsFile,
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

describe("identity", () => {
  it("creates a file under the device's id and writes the id back once it lands", async () => {
    harness = await folderHarness("folder-id-create");
    const rows = scriptFolderWrites(harness);
    const text = "---\ntitle: New\n---\nwritten here\n";
    put(harness, "new.md", text);
    expect((await harness.folder.scan()).ok).toBe(true);
    // Queued and not yet landed: a pull leaves the person's file as it is.
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      read(harness, "new.md"),
      "the id was written into the file before its create landed, so a create the server refuses leaves the file naming nothing",
    ).toBe(text);

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [sent] = sentCreates(harness);
    expect(
      typeof sent?.id,
      "the create carried no id of the device's own, so the file has nothing to name until the server answers",
    ).toBe("string");
    expect(
      [sent?.source, sent?.source_id, sent?.version],
      "the create carried a natural key or a version, which nothing the server holds can give a file",
    ).toEqual([undefined, undefined, undefined]);
    expect(rows.has(String(sent?.id))).toBe(true);
    expect(
      idIn(harness, "new.md"),
      "the id was not written back once the create landed, so nothing in the file names its item",
    ).toBe(sent?.id);
    expect(read(harness, "new.md")).toContain("written here");
    const settled = await harness.folder.scan();
    expect(
      settled.ok && [settled.value.created, settled.value.updated],
      "the folder read its own write-back as a change",
    ).toEqual([0, 0]);
  });

  it("keeps the item when a save drops the id line", async () => {
    harness = await folderHarness("folder-id-dropped");
    const rows = scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nfirst\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "note.md");
    expect(
      id,
      "no id was written back, so there is no line to drop",
    ).toBeDefined();

    // An editor that does not keep the line saves without it, as a new file
    // at the same path.
    saveAtomically(harness, "note.md", "---\ntitle: Note\n---\nsecond\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [pushed.value.scan.created, pushed.value.scan.updated],
      "a save that dropped the id line made the file a second item",
    ).toEqual([0, 1]);
    expect(sentUpdates(harness).map((update) => update.id)).toEqual([id]);
    expect(rows.get(id ?? "")?.properties.body).toBe("second\n");
    expect(idIn(harness, "note.md")).toBe(id);
  });

  it("does not write back into a file changed since its scan", async () => {
    harness = await folderHarness("folder-id-changed-since");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nscanned\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);
    // The person saves again after the scan read the file and before the
    // pull that would write the id back.
    const typed = "---\ntitle: Note\n---\nscanned, and typed since\n";
    put(harness, "note.md", typed);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      read(harness, "note.md"),
      "the id was written back over bytes the scan never read, and the person's latest words went with it",
    ).toBe(typed);
    expect(pulled.value.unwritten).toBe(1);

    // The next scan meets the change, and the binding keeps the item.
    const scanned = await harness.folder.scan();
    expect(
      scanned.ok && [scanned.value.created, scanned.value.updated],
    ).toEqual([0, 1]);
    // The witness: left alone, the file does take the id back.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(idIn(harness, "note.md")).toBe(sentCreates(harness)[0]?.id);
  });

  it("follows a rename by the id the file carries, and sends no edit of the item for it", async () => {
    harness = await folderHarness("folder-rename-by-id");
    scriptFolderWrites(harness);
    put(harness, "before.md", "---\ntitle: Before\n---\nsame bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "before.md");
    expect(id).toBeDefined();

    // Moved as some tools move a file, by a copy and a delete: a new inode,
    // so only the id says which item this is.
    writeFileSync(join(harness.dir, "after.md"), read(harness, "before.md"));
    rmSync(join(harness.dir, "before.md"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [
        pushed.value.scan.renamed,
        pushed.value.scan.created,
        pushed.value.scan.missing,
      ],
      "the moved file was not followed by its id, so the note is two items and the old one is about to be deleted",
    ).toEqual([1, 0, 0]);
    expect(
      sentUpdates(harness),
      "a move sent an edit of the item, though only its placement moved",
    ).toEqual([]);

    // And the file stays where the person put it, on this pull and the next.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "after.md"))).toBe(true);
    expect(
      existsSync(join(harness.dir, "before.md")),
      "the old name came back, so the folder now holds the note twice",
    ).toBe(false);
    expect(idIn(harness, "after.md")).toBe(id);
  });

  it("does not write a new file's body onto the item whose name it took", async () => {
    harness = await folderHarness("folder-name-handover");
    const held = scriptFolderWrites(harness);
    put(harness, "a-note.md", "---\ntitle: A\n---\nthe real note\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const incumbent = idIn(harness, "a-note.md") ?? "";
    expect(incumbent, "the file never became an item").not.toBe("");

    // The moved file frees `a-note.md`, and a brand new file takes it in the
    // same scan, where the binding still names the moved one.
    renameSync(join(harness.dir, "a-note.md"), join(harness.dir, "z-note.md"));
    put(harness, "a-note.md", "---\ntitle: A\n---\nbrand new\n");
    const handedOver = await harness.folder.push();
    expect(handedOver.ok, JSON.stringify(handedOver)).toBe(true);
    if (!handedOver.ok) return;
    expect([
      handedOver.value.scan.created,
      handedOver.value.scan.renamed,
    ]).toEqual([1, 1]);
    expect(
      held.get(incumbent)?.properties?.body,
      "the note the person moved was overwritten by an unrelated new file that took the name it was leaving",
    ).toBe("the real note\n");
    expect(idIn(harness, "z-note.md")).toBe(incumbent);
    const newcomer = idIn(harness, "a-note.md") ?? "";
    expect(newcomer).not.toBe(incumbent);
    expect(
      held.get(newcomer)?.properties?.body,
      "the new file never became an item of its own",
    ).toBe("brand new\n");
  });

  it("keeps a binding for every file after a swap that also edits both", async () => {
    harness = await folderHarness("folder-swap-and-edit");
    scriptFolderWrites(harness);
    put(harness, "one.md", "---\ntitle: One\n---\nfirst\n");
    put(harness, "two.md", "---\ntitle: Two\n---\nsecond\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // Swapped and edited, and the edits drop the id lines, so only the
    // binding's record of each file says which item it is.
    renameSync(join(harness.dir, "one.md"), join(harness.dir, ".swap"));
    renameSync(join(harness.dir, "two.md"), join(harness.dir, "one.md"));
    renameSync(join(harness.dir, ".swap"), join(harness.dir, "two.md"));
    writeFileSync(
      join(harness.dir, "one.md"),
      "---\ntitle: Two\n---\nsecond, and a word the person typed\n",
    );
    writeFileSync(
      join(harness.dir, "two.md"),
      "---\ntitle: One\n---\nfirst, and another\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    // After the scan, does the folder still know what each file is? A row
    // lost here is a file the next scan pushes as a second item.
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "a file came out of the swap with no binding, so the next scan made it a second item",
    ).toBe(0);
    expect(
      scanned.value.missing,
      "a path came out of the swap bound to nothing that is there, so the grace is now counting down on an item whose file is on the disk",
    ).toBe(0);
    expect(
      [scanned.value.updated, scanned.value.renamed],
      "the scan after the swap still had something to say about these files, so the swap did not come to rest",
    ).toEqual([0, 0]);
  });

  it("keeps its id line out of what it sends the server", async () => {
    harness = await folderHarness("folder-record-not-sent");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Recorded\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The folder wrote the id into the file, so this is what a person
    // opening the file and typing a line actually edits.
    const written = read(harness, "note.md");
    expect(
      written,
      "the folder wrote no id into the file, so the rest of this is about a file that carries nothing to leak",
    ).toMatch(/marfa_id:\s*\S+/);
    writeFileSync(join(harness.dir, "note.md"), `${written}and a line more\n`);
    expect((await harness.folder.push()).ok).toBe(true);
    const sent = sentUpdates(harness).map(
      (update) => update.body.properties as Record<string, unknown>,
    );
    expect(
      sent.length,
      "the edit never reached the server, so this asserts nothing about what it carried",
    ).toBeGreaterThan(0);
    expect(
      sent.filter((properties) => "marfa_id" in properties),
      "the folder sent the id as a property of the item, so every later render writes it out twice over",
    ).toEqual([]);

    // And a create: a copy carries the id of the item it was copied from.
    writeFileSync(join(harness.dir, "copy.md"), written);
    expect((await harness.folder.push()).ok).toBe(true);
    const creates = sentCreates(harness);
    expect(
      creates.length,
      "no create reached the server, so the assertion below is about an empty list",
    ).toBeGreaterThan(1);
    expect(
      creates.filter(
        (create) =>
          "marfa_id" in (create.properties as Record<string, unknown>),
      ),
      "a copied file carried the id of the item it was copied from onto a new item as a property",
    ).toEqual([]);
  });

  it("keeps an agent's whole-file rewrite the same item", async () => {
    harness = await folderHarness("folder-agent-rewrite");
    const rows = scriptFolderWrites(harness);
    put(harness, "plan.md", "---\ntitle: Plan\n---\nthe first draft\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "plan.md") ?? "";
    expect(id).not.toBe("");

    // An agent writes the whole file anew, as a new file renamed over the
    // old one, with nothing the folder wrote into it.
    saveAtomically(
      harness,
      "plan.md",
      "---\ntitle: Plan\nstatus: rewritten\n---\nan agent's whole new text\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [
        pushed.value.scan.created,
        pushed.value.scan.updated,
        pushed.value.scan.missing,
      ],
      "an agent's rewrite at the same path became a second item",
    ).toEqual([0, 1, 0]);
    expect(sentUpdates(harness).map((update) => update.id)).toEqual([id]);
    expect(rows.get(id)?.properties).toMatchObject({
      status: "rewritten",
      body: "an agent's whole new text\n",
    });
    expect(idIn(harness, "plan.md")).toBe(id);
  });

  it("keeps an unchanged rewrite the same item", async () => {
    harness = await folderHarness("folder-unchanged-rewrite");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nthe same words\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "note.md");
    expect(id).toBeDefined();

    // Saved again with the same bytes, as a new inode.
    saveAtomically(harness, "note.md", read(harness, "note.md"));
    const quiet = await harness.folder.push();
    expect(quiet.ok, JSON.stringify(quiet)).toBe(true);
    if (!quiet.ok) return;
    expect(
      [
        quiet.value.scan.unchanged,
        quiet.value.scan.created,
        quiet.value.scan.updated,
        quiet.value.scan.missing,
      ],
      "a save of the same bytes read as something other than the file the folder already holds",
    ).toEqual([1, 0, 0, 0]);
    expect(sentUpdates(harness)).toEqual([]);

    // Still that item wherever it goes next.
    renameSync(join(harness.dir, "note.md"), join(harness.dir, "moved.md"));
    const moved = await harness.folder.push();
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    expect(
      [moved.value.scan.renamed, moved.value.scan.created],
      "the file saved with the same bytes was not followed when it moved",
    ).toEqual([1, 0]);
    expect(idIn(harness, "moved.md")).toBe(id);
    expect(sentCreates(harness)).toHaveLength(1);
  });

  it("makes a copy a new item with a fresh id", async () => {
    harness = await folderHarness("folder-copy");
    const rows = scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "note.md") ?? "";
    expect(id).not.toBe("");

    // A copy carries the original's frontmatter, id and all.
    writeFileSync(join(harness.dir, "copy.md"), read(harness, "note.md"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect([pushed.value.scan.created, pushed.value.scan.updated]).toEqual([
      1, 0,
    ]);
    const copy = String(sentCreates(harness)[1]?.id);
    expect(
      copy,
      "the copy was created under the original's id, so two files claim one item",
    ).not.toBe(id);
    expect(
      idIn(harness, "copy.md"),
      "the copy still carries the original's id, so the next scan meets two files claiming one item",
    ).toBe(copy);
    expect(idIn(harness, "note.md")).toBe(id);
    expect(rows.get(id)?.properties.body).toBe("the original\n");

    // Edited apart, each goes to its own item.
    put(
      harness,
      "copy.md",
      read(harness, "copy.md").replace("the original", "the copy, edited"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentUpdates(harness).map((update) => update.id)).toEqual([copy]);
    expect(rows.get(copy)?.properties.body).toBe("the copy, edited\n");
    expect(rows.get(id)?.properties.body).toBe("the original\n");
  });

  it("keeps the id with the file its binding names", async () => {
    harness = await folderHarness("folder-copy-binding");
    scriptFolderWrites(harness);
    put(harness, "b.md", "---\ntitle: B\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "b.md");
    const bytes = read(harness, "b.md");

    // A copy that sorts first, then the original saved again with the same
    // bytes: the copy is now the older file and first in path order, so only
    // the binding says which of the two is the original.
    writeFileSync(join(harness.dir, "a.md"), bytes);
    await new Promise((resolve) => setTimeout(resolve, 20));
    saveAtomically(harness, "b.md", bytes);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.created).toBe(1);
    const copy = sentCreates(harness)[1]?.id;
    expect(
      idIn(harness, "b.md"),
      "the id left the file the binding names for a copy made from it",
    ).toBe(id);
    expect(idIn(harness, "a.md")).toBe(copy);
    expect(copy).not.toBe(id);
  });

  it("keeps the id with the older of two unbound files that carry it", async () => {
    const held = "01a00000-0000-7000-8000-00000000000b";
    harness = await folderHarness("folder-copy-unbound", {
      rows: {
        "core.note": [
          { item: { id: held, properties: { title: "Held", body: "held\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    // The row is held and no file is bound to it yet: neither file is the
    // binding's.
    const bytes = `---\nmarfa_id: ${held}\ntitle: Held\n---\nheld\n`;
    put(harness, "z-older.md", bytes);
    await new Promise((resolve) => setTimeout(resolve, 20));
    put(harness, "a-newer.md", bytes);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.created).toBe(1);
    const [copy] = sentCreates(harness);
    expect(copy?.id).not.toBe(held);
    expect(
      idIn(harness, "z-older.md"),
      "the id went to the newer file because it sorts first",
    ).toBe(held);
    expect(idIn(harness, "a-newer.md")).toBe(copy?.id);
  });

  it("keeps the id with the original an editor saved without its line, over a copy carrying it", async () => {
    harness = await folderHarness("folder-copy-original-dropped-line");
    const rows = scriptFolderWrites(harness);
    put(harness, "b.md", "---\ntitle: B\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "b.md") ?? "";
    // The witness: the copy carries the id and is the older file.
    writeFileSync(
      join(harness.dir, "z-copy.md"),
      read(harness, "b.md").replace("the original", "the copy"),
    );
    expect(idIn(harness, "z-copy.md")).toBe(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    saveAtomically(
      harness,
      "b.md",
      "---\ntitle: B\n---\nthe original, edited\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      idIn(harness, "b.md"),
      "the original lost its item to a copy because its editor dropped the line",
    ).toBe(id);
    expect(rows.get(id)?.properties.body).toBe("the original, edited\n");
    expect(idIn(harness, "z-copy.md")).not.toBe(id);
  });

  it("keeps a copy its own item once the original goes, before its id line is rewritten", async () => {
    harness = await folderHarness("folder-copy-original-gone");
    const rows = scriptFolderWrites(harness);
    put(harness, "n.md", "---\ntitle: Note\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "n.md") ?? "";
    writeFileSync(
      join(harness.dir, "copy.md"),
      read(harness, "n.md").replace("the original", "the copy"),
    );
    const copied = await harness.folder.scan();
    // The witness: the copy was made a new item while it still carries the id.
    expect(copied.ok && copied.value.created).toBe(1);
    expect(idIn(harness, "copy.md")).toBe(id);

    rmSync(join(harness.dir, "n.md"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).map((update) => update.id),
      "the copy took the original's item once the original went, and sent its words over it",
    ).toEqual([]);
    expect(rows.get(id)?.properties.body).toBe("the original\n");
    const copy = sentCreates(harness)[1]?.id;
    expect(copy).toBeDefined();
    expect(idIn(harness, "copy.md")).toBe(copy);
  });

  it("sends nothing for a save that only drops the id line", async () => {
    harness = await folderHarness("folder-id-dropped-only");
    scriptFolderWrites(harness);
    const text = "---\ntitle: Note\n---\nbody\n";
    put(harness, "note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "note.md");
    // The witness is `› keeps the item when a save drops the id line`: the
    // same save with a new body is sent.
    saveAtomically(harness, "note.md", text);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness),
      "a save that changed nothing but the id line sent an edit",
    ).toEqual([]);
    expect(idIn(harness, "note.md")).toBe(id);
  });

  it("sends a checked-out file's edits to the item its id names, and nothing for one in step", async () => {
    const [edited, same] = [
      "01a00000-0000-7000-8000-00000000000c",
      "01a00000-0000-7000-8000-00000000000d",
    ];
    harness = await folderHarness("folder-id-checked-out", {
      rows: {
        "core.note": [
          {
            item: {
              id: edited,
              properties: { title: "Edited", body: "server\n" },
            },
          },
          {
            item: { id: same, properties: { title: "Same", body: "server\n" } },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    // A fresh folder over files from a checkout: nothing is bound yet.
    put(
      harness,
      "edited.md",
      `---\nmarfa_id: ${edited}\ntitle: Edited\n---\nin a checkout\n`,
    );
    put(
      harness,
      "same.md",
      `---\nmarfa_id: ${same}\ntitle: Same\n---\nserver\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentCreates(harness)).toEqual([]);
    expect(
      sentUpdates(harness).map((update) => update.id),
      "a checked-out file's edit never reached its item, or one in step was sent",
    ).toEqual([edited]);
    expect(rows.get(edited)?.properties.body).toBe("in a checkout\n");
  });

  it("reads the id of a Markdown file whatever the case of its extension", async () => {
    harness = await folderHarness("folder-id-extensions");
    const rows = scriptFolderWrites(harness);
    put(harness, "UP.MD", "---\ntitle: Up\n---\nupper\n");
    put(harness, "long.Markdown", "---\ntitle: Long\n---\nlong\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const up = idIn(harness, "UP.MD");
    expect(up).toBeDefined();
    expect(idIn(harness, "long.Markdown")).toBeDefined();
    // Moved by copy and delete, so only the id can follow them.
    writeFileSync(join(harness.dir, "moved.MD"), read(harness, "UP.MD"));
    rmSync(join(harness.dir, "UP.MD"));
    writeFileSync(
      join(harness.dir, "moved.markdown"),
      read(harness, "long.Markdown"),
    );
    rmSync(join(harness.dir, "long.Markdown"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      pushed.ok && [pushed.value.scan.renamed, pushed.value.scan.created],
      "a moved file's id went unread for the case of its extension",
    ).toEqual([2, 0]);
    expect(idIn(harness, "moved.MD")).toBe(up);
    expect(rows.size).toBe(2);
  });

  it("reads no id from a .txt file or from a document naming a file item", async () => {
    const fileId = "01a00000-0000-7000-8000-0000000000f1";
    const bytes = Buffer.from("bytes\n");
    harness = await folderHarness("folder-id-not-read", {
      settings: {
        search: { types: ["core.note", "core.file"] },
        defaults: { type: "core.note" },
      },
      rows: {
        "core.file": [
          {
            item: {
              id: fileId,
              type: "core.file",
              properties: {
                title: "x.bin",
                blob_ref: hashOf(bytes),
                mime_type: "application/octet-stream",
              },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    acceptUploads(harness.server);
    scriptBlob(harness.server, bytes);
    put(harness, "n.md", "---\ntitle: N\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "n.md") ?? "";
    // Both files go, so the .txt and the document are each the only file
    // carrying their id.
    expect(existsSync(join(harness.dir, "x.bin"))).toBe(true);
    rmSync(join(harness.dir, "n.md"));
    rmSync(join(harness.dir, "x.bin"));
    put(harness, "t.txt", `---\nmarfa_id: ${id}\n---\ntext\n`);
    put(harness, "doc.md", `---\nmarfa_id: ${fileId}\ntitle: Doc\n---\nbody\n`);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness),
      "a .txt file or a document naming a file item was read as that item's file",
    ).toEqual([]);
    expect(pushed.ok && pushed.value.scan.created).toBe(2);
    expect(rows.get(id)?.properties.body).toBe("body\n");
  });

  it("reads a .txt file that opens with a --- block as a body", async () => {
    harness = await folderHarness("folder-txt-fence");
    scriptFolderWrites(harness);
    const text = "---\ntitle: Fenced\n---\nafter the fence\n";
    // The witness: the same bytes in a Markdown file are frontmatter.
    put(harness, "fenced.md", text);
    put(harness, "fenced.txt", text);
    expect((await harness.folder.push()).ok).toBe(true);
    const sent = sentCreates(harness).map(
      (create) => create.properties as Record<string, unknown>,
    );
    const md = sent.find((properties) => properties.title === "Fenced");
    expect(md?.body).toBe("after the fence\n");
    const txt = sent.find((properties) => properties !== md);
    expect(
      txt?.body,
      "a .txt file's opening block was read as frontmatter and left its body",
    ).toBe(text);
    expect(read(harness, "fenced.txt")).toBe(text);
  });

  it("reads a .txt file whatever the case of its extension", async () => {
    harness = await folderHarness("folder-txt-case", {
      settings: {
        search: { types: ["core.note", "core.file"] },
        defaults: { type: "core.note" },
      },
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    put(harness, "LOUD.TXT", "said loudly\n");
    // The control: the same text under a lowercase extension.
    put(harness, "quiet.txt", "said quietly\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const sent = sentCreates(harness);
    expect(
      sent.map((create) => create.type),
      "a .TXT file was sent as a file item's bytes rather than a document, so its edits never reach its text",
    ).toEqual(["core.note", "core.note"]);
    expect(
      sent.map((create) => (create.properties as Record<string, unknown>).body),
    ).toEqual(expect.arrayContaining(["said loudly\n", "said quietly\n"]));
  });

  it("reads no id from a file naming the folder's own settings", async () => {
    harness = await folderHarness("folder-id-of-settings");
    scriptFolderWrites(harness);
    const settings = harness.settings.id;
    put(
      harness,
      "taken.md",
      `---\nmarfa_id: ${settings}\ntitle: Taken\n---\nbody\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTitles(harness),
      "a file naming the folder's settings was taken as their file",
    ).toEqual(["Taken"]);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "PATCH" &&
          request.pathname === `/items/${settings}`,
      ),
    ).toEqual([]);
    expect(idIn(harness, "taken.md")).not.toBe(settings);
  });

  it("lets go of the pin of an item whose file's path another item takes", async () => {
    const x = "01a00000-0000-7000-8000-0000000002d1";
    const y = "01a00000-0000-7000-8000-0000000002d2";
    harness = await folderHarness("folder-path-taken", {
      rows: {
        "core.note": [
          { item: { id: x, properties: { title: "ex", body: "x\n" } } },
          { item: { id: y, properties: { title: "why", body: "y\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const pinned = await harness.folder.device().status();
    expect(pinned.ok && pinned.value.pinned).toContain(x);
    // y's file moves onto x's path, replacing it.
    const why = read(harness, "why.md");
    rmSync(join(harness.dir, "why.md"));
    saveAtomically(harness, "ex.md", why);
    expect((await harness.folder.scan()).ok).toBe(true);
    const status = await harness.folder.device().status();
    expect(status.ok && status.value.pinned).toContain(y);
    expect(
      status.ok && status.value.pinned,
      "an item whose path another item took stayed pinned with no file",
    ).not.toContain(x);
  });

  it("gives a fresh id to a file whose id names nothing", async () => {
    harness = await folderHarness("folder-id-names-nothing");
    const rows = scriptFolderWrites(harness);
    const nothing = "01a00000-0000-7000-8000-0000000000ff";
    put(
      harness,
      "invented.md",
      `---\nmarfa_id: ${nothing}\ntitle: Invented\n---\nbody\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [sent] = sentCreates(harness);
    expect(typeof sent?.id).toBe("string");
    expect(
      sent?.id,
      "a file was created under an id it carried and nothing held, so anybody can name an item by typing an id",
    ).not.toBe(nothing);
    expect(sent?.properties).not.toHaveProperty("marfa_id");
    expect(rows.has(nothing)).toBe(false);
    expect(idIn(harness, "invented.md")).toBe(sent?.id);
  });

  it("follows a rename by device, inode and birth time", async () => {
    harness = await folderHarness("folder-rename");
    scriptFolderWrites(harness);
    put(harness, "before.txt", "same bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      read(harness, "before.txt"),
      "the folder wrote frontmatter into a file that cannot carry it",
    ).toBe("same bytes\n");

    // A rename keeps the inode and the birth time, so it is the same file.
    renameSync(join(harness.dir, "before.txt"), join(harness.dir, "after.txt"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.renamed,
      "a renamed file was not followed, so the item is now two items and the old one is about to be deleted",
    ).toBe(1);
    expect(scanned.value.created).toBe(0);
    const after = await harness.folder.device().queue();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.filter((row) => row.kind === "create_item").length,
      "a second create was queued for a file that only moved",
    ).toBe(1);
    expect(
      after.value.some((row) => row.kind === "delete_item"),
      "the folder queued a delete for the path the file moved off",
    ).toBe(false);
  });

  it("treats a file with no usable identity as new rather than guessing", async () => {
    harness = await folderHarness("folder-no-identity");
    scriptFolderWrites(harness);
    put(harness, "first.txt", "one\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The control: a file the folder remembers, moved, is followed. Without
    // it the cases below hold as well against a folder that follows nothing.
    renameSync(join(harness.dir, "first.txt"), join(harness.dir, "moved.txt"));
    const followed = await harness.folder.scan();
    expect(followed.ok && followed.value.renamed).toBe(1);

    // A different file, where the folder last saw one. A filesystem that
    // reuses inodes may give it the old one, and the birth time is what
    // tells them apart.
    rmSync(join(harness.dir, "moved.txt"));
    put(harness, "second.txt", "two\n");
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "a file that is not the one the folder remembers was bound to its item",
    ).toBe(1);
    expect(scanned.value.renamed).toBe(0);

    // Two files that share an identity yield none for either: a hard link is
    // one inode, device and birth time on two paths.
    await harness.stop();
    harness = await folderHarness("folder-shared-identity");
    scriptFolderWrites(harness);
    put(harness, "original.txt", "linked\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    linkSync(join(harness.dir, "original.txt"), join(harness.dir, "hard.txt"));
    renameSync(
      join(harness.dir, "original.txt"),
      join(harness.dir, "renamed.txt"),
    );
    const shared = await harness.folder.scan();
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(
      shared.value.renamed,
      "a file whose identity two paths share was followed as a rename, and the folder cannot know which of the two it remembers",
    ).toBe(0);
    expect([shared.value.created, shared.value.missing]).toEqual([2, 1]);

    // Back at its own bound path, still with no identity, it keeps its item.
    renameSync(
      join(harness.dir, "renamed.txt"),
      join(harness.dir, "original.txt"),
    );
    const back = await harness.folder.scan();
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(
      back.value.created,
      "a file with no identity at the path its item is bound to became a new item",
    ).toBe(0);
    expect(back.value.missing).toBe(1);
  });

  it("resolves identity over the files it holds, not every file in the tree", async () => {
    harness = await folderHarness("folder-unheld-identity");
    scriptFolderWrites(harness);
    put(harness, "note.txt", "same bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // A hard link under a name the folder does not hold: one identity on two
    // paths, one of which the folder never touches.
    linkSync(join(harness.dir, "note.txt"), join(harness.dir, "clip.mov"));
    renameSync(join(harness.dir, "note.txt"), join(harness.dir, "moved.txt"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.skipped,
      "the walk never saw the unheld file, so nothing here could have taken the identity",
    ).toBeGreaterThan(0);
    expect(
      [scanned.value.renamed, scanned.value.created],
      "a file the folder does not hold took the identity of one it does, so renaming it made a second item",
    ).toEqual([1, 0]);
  });

  it("follows the rename of a file saved again with the same bytes", async () => {
    harness = await folderHarness("folder-stale-inode");
    scriptFolderWrites(harness);
    put(harness, "note.txt", "plain words\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // Saved again with the same bytes, as a new inode: nothing to send, and
    // the folder's record of the file has to move to the new inode.
    saveAtomically(harness, "note.txt", read(harness, "note.txt"));
    const quiet = await harness.folder.scan();
    expect(quiet.ok && [quiet.value.unchanged, quiet.value.created]).toEqual([
      1, 0,
    ]);
    renameSync(join(harness.dir, "note.txt"), join(harness.dir, "moved.txt"));
    const moved = await harness.folder.scan();
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(
      [moved.value.renamed, moved.value.created, moved.value.missing],
      "the folder kept the inode the file had before its save, so the rename after it made a second item and journaled the first for deletion",
    ).toEqual([1, 0, 0]);
  });

  it("binds the same file to the same item whether it was present at start or arrived while running", async () => {
    // One of these is a real watcher, and the other pushes a file that was
    // there before anything ran: two identity rules would make the same bytes
    // two different kinds of create depending on when they appeared.
    const text = "---\ntitle: Same bytes\n---\nidentical\n";
    harness = await folderHarness("folder-at-start");
    second = await folderHarness("folder-while-running");
    scriptFolderWrites(harness);
    scriptFolderWrites(second);

    put(harness, "note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);

    const watching = second.folder.watch();
    try {
      await vi.waitFor(
        () => {
          expect(
            watching.running(),
            `the watcher exited before it could see anything: ${watching.stderr}`,
          ).toBe(true);
          expect(
            second?.server.requests.some(
              (request) => request.pathname === "/types",
            ),
            "the watcher has not opened the folder yet",
          ).toBe(true);
        },
        { timeout: 15_000, interval: 100 },
      );
      put(second, "note.md", text);
      await vi.waitFor(
        () => {
          expect(
            sentCreates(second!),
            `the watcher never pushed the file that arrived while it was running: ${watching.stderr}`,
          ).toHaveLength(1);
        },
        { timeout: 20_000, interval: 250 },
      );
    } finally {
      await watching.stop();
    }

    // Each create carries an id its own device minted, so what must agree is
    // everything else it says.
    const shape = (folder: FolderHarness) =>
      sentCreates(folder).map(({ id, ...rest }) => ({
        minted: typeof id === "string",
        ...rest,
      }));
    expect(
      shape(harness),
      "the file present at start became a different create than the same file arriving to a running watcher",
    ).toEqual(shape(second));
    expect(shape(harness)).toHaveLength(1);
  });

  it("queues a file whose row the copy lost again once it changes, and says so", async () => {
    harness = await folderHarness("folder-lost-row");
    // The first create is refused and the drain forgets its row; everything
    // after answers by the server's rules.
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        refusal(400, "invalid_properties", "the body is not allowed"),
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      update: [
        (request) =>
          door.update(
            request.pathname.split("/").at(-1) ?? "",
            JSON.parse(request.body) as { version: number },
          ),
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "mine.md", "---\ntitle: Mine\n---\nnot allowed\n");
    const refused = await harness.folder.push();
    expect(refused.ok, JSON.stringify(refused)).toBe(true);
    if (!refused.ok) return;
    expect(refused.value.drain.verdicts[0]?.verdict).toBe("refused");

    // Unchanged: those are the bytes the server refused, so nothing is sent,
    // and the scan says why rather than counting the file unchanged.
    const unchanged = await harness.folder.scan();
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok) return;
    expect([
      unchanged.value.created,
      unchanged.value.requeued,
      unchanged.value.lost,
    ]).toEqual([0, 0, 1]);

    // Changed: the file is bound to nothing, so it is queued as a new item
    // and reported as queued again, rather than stopping the scan.
    writeFileSync(
      join(harness.dir, "mine.md"),
      "---\ntitle: Mine\n---\nallowed\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [pushed.value.scan.created, pushed.value.scan.requeued],
      "a file bound to a row the copy lost was not queued again once it changed",
    ).toEqual([1, 1]);
    expect(
      itemVerdicts(pushed.value.drain.verdicts).map((entry) => entry.verdict),
    ).toEqual(["accepted"]);
    const made = String(sentCreates(harness).at(-1)?.id);
    expect(door.rows.get(made)?.properties.body).toBe("allowed\n");
    expect(read(harness, "mine.md")).toContain(`marfa_id: ${made}`);

    // And the folder carries on as any other: the next edit is an edit.
    writeFileSync(
      join(harness.dir, "mine.md"),
      `${read(harness, "mine.md")}more\n`,
    );
    const edited = await harness.folder.push();
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    expect(edited.ok && edited.value.scan.updated).toBe(1);
  });

  it("keeps a live file's binding when it takes a lost file's old name", async () => {
    // A file bound to a row the copy lost moves off its name, and a live
    // file moves onto that name, in one scan. The walk meets the live file
    // first and binds it there; queuing the lost file again must not then
    // take that binding away as the lost file's old one, or the live item is
    // left with no file and the next scan makes a second item of it.
    harness = await folderHarness("folder-lost-swap");
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        refusal(400, "invalid_properties", "the body is not allowed"),
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      update: [
        (request) =>
          door.update(
            request.pathname.split("/").at(-1) ?? "",
            JSON.parse(request.body) as { version: number },
            { resolve: true },
          ),
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "a.md", "---\ntitle: Lost\n---\nnot allowed\n");
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "b.md", "---\ntitle: Live\n---\nlive\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const live = idIn(harness, "b.md") ?? "";
    expect(live, "the live file never became an item").not.toBe("");

    renameSync(join(harness.dir, "a.md"), join(harness.dir, "c.md"));
    writeFileSync(
      join(harness.dir, "c.md"),
      "---\ntitle: Lost\n---\nallowed now\n",
    );
    renameSync(join(harness.dir, "b.md"), join(harness.dir, "a.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    // The witnesses: the live file's move and the lost file's re-queue both
    // happened in this scan.
    expect([scanned.value.renamed, scanned.value.requeued]).toEqual([1, 1]);
    // Asked again before any pull, which would take the file back by its
    // bytes and hide a binding lost here.
    const again = await harness.folder.scan();
    expect(again.ok).toBe(true);
    expect(
      again.ok && again.value.created,
      "the live file lost its binding to the lost file queued from its new name, and became a second item",
    ).toBe(0);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.rows.get(live)?.properties.body).toBe("live\n");
    expect(idIn(harness, "a.md")).toBe(live);
  });

  it("keeps a live file's binding when it takes a lost file's old name, across a push", async () => {
    // As above, with a push in place of the scans: the pull must not find the
    // live item without a file and write it a second one.
    harness = await folderHarness("folder-lost-swap-pushed");
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        refusal(400, "invalid_properties", "the body is not allowed"),
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      update: [
        (request) =>
          door.update(
            request.pathname.split("/").at(-1) ?? "",
            JSON.parse(request.body) as { version: number },
            { resolve: true },
          ),
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "a.md", "---\ntitle: Lost\n---\nnot allowed\n");
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "b.md", "---\ntitle: Live\n---\nlive\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const live = idIn(harness, "b.md") ?? "";

    renameSync(join(harness.dir, "a.md"), join(harness.dir, "c.md"));
    writeFileSync(
      join(harness.dir, "c.md"),
      "---\ntitle: Found\n---\nallowed now\n",
    );
    renameSync(join(harness.dir, "b.md"), join(harness.dir, "a.md"));
    expect((await harness.folder.push()).ok).toBe(true);
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      readdirSync(harness.dir)
        .filter((name) => !name.startsWith("."))
        .sort(),
      "the live item lost its file's binding and was written a second file",
    ).toEqual(["a.md", "c.md"]);
    expect(idIn(harness, "a.md")).toBe(live);
    expect(again.ok && again.value.scan.created).toBe(0);
  });

  it("queues a file whose row the copy lost again once it moves", async () => {
    // A move is the person acting on the file, as an edit is, so a file
    // bound to a row the copy lost is queued again when it moves, bytes
    // unchanged; left where it was, it is only reported.
    harness = await folderHarness("folder-lost-moved");
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        refusal(400, "invalid_properties", "the body is not allowed"),
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "mine.md", "---\ntitle: Mine\n---\nnot allowed\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const stayed = await harness.folder.scan();
    expect(stayed.ok && [stayed.value.requeued, stayed.value.lost]).toEqual([
      0, 1,
    ]);

    renameSync(join(harness.dir, "mine.md"), join(harness.dir, "moved.md"));
    const moved = await harness.folder.scan();
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(
      [moved.value.created, moved.value.requeued, moved.value.lost],
      "a lost file that moved was left as lost, though the person acted on it",
    ).toEqual([1, 1, 0]);
  });

  it("says in words when a file is bound to an item that is gone, once while watching", async () => {
    harness = await folderHarness("folder-lost-words");
    // The one file's create is refused and its row read back as gone; any
    // other file's create is taken, so a file added later is a pass the
    // watcher is seen to run.
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as DoorCreate;
          return sent.properties.title === "Mine"
            ? refusal(400, "invalid_properties", "the body is not allowed")
            : door.create(sent).answer;
        },
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "mine.md", "---\ntitle: Mine\n---\nnot allowed\n");
    const lost = "bound to an item that is gone";
    const createsOf = (title: string) =>
      sentTitles(harness!).filter((sent) => sent === title).length;
    const watching = harness.folder.watchText();
    let quiet = "";
    try {
      await vi.waitFor(() => expect(watching.stdout).toContain(`1 ${lost}`), {
        timeout: 20_000,
        interval: 100,
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      quiet = watching.stdout;
      put(harness, "later.md", "---\ntitle: Later\n---\nallowed\n");
      await vi.waitFor(
        () => {
          expect(createsOf("Later")).toBe(1);
          expect(watching.stdout.length).toBeGreaterThan(quiet.length);
        },
        { timeout: 20_000, interval: 100 },
      );
      // Passes enough for a line printed one pass after the push to show.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      await watching.stop();
    }
    // The passes between the first report and the later file said nothing,
    // and the watcher was passing through them: it saw the later file.
    expect(
      quiet.split(lost).length - 1,
      `a watcher said the same lost file on every pass: ${quiet}`,
    ).toBe(1);
    // After it, one line: the push's summary, which carries the lost count
    // as every summary line does. That count is the only later mention of
    // the lost file, and no pass after the push printed anything.
    const later = watching.stdout.slice(quiet.length).trim().split("\n");
    expect(
      later,
      `a watcher printed a pass where nothing happened: ${watching.stdout}`,
    ).toHaveLength(1);
    // Sent 2: the later file's create and its placement.
    expect(later[0]).toMatch(
      /^1 created, 0 updated, 0 renamed, 0 deleted; answered 2; \d+ file\(s\) written, 1 bound to an item that is gone$/,
    );
  });
});

/** An edit of `going.md` goes to the item it is bound to, not a new one. */
async function editedReachesItsItem(
  harness: FolderHarness,
  item: string,
  id: string | undefined,
): Promise<void> {
  writeFileSync(
    join(harness.dir, "going.md"),
    read(harness, "going.md") + "an edit after it left\n",
  );
  const creates = sentCreates(harness).length;
  const pushed = await harness.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  expect(
    sentCreates(harness).length,
    "an edit of the file made a new item of it",
  ).toBe(creates);
  expect(sentUpdates(harness).map((sent) => sent.id)).toContain(item);
  expect(idIn(harness, "going.md")).toBe(id);
}

describe("what a pull does with a file whose item stops matching", () => {
  const departed = {
    id: "01a00000-0000-7000-8000-0000000000d1",
    properties: { title: "going", body: "body\n" },
  };

  /** A folder holding one item, and a stream that trashes it and then
   *  restores it. */
  async function departure(label: string): Promise<FolderHarness> {
    return folderHarness(label, {
      rows: { "core.note": [{ item: departed }] },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.deleted",
            wireItem({ ...departed, state: "trashed" }),
          ),
        ]),
        copyReplay("3", [
          copyItemEvent("3", "item.restored", wireItem(departed)),
        ]),
      ],
    });
  }

  it("removes a trashed item's file and brings it back on restore", async () => {
    harness = await departure("folder-trashed");
    scriptFolderWrites(harness);
    const first = await harness.folder.pull();
    expect(first.ok && first.value.written).toBe(1);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);
    const pinned = await harness.folder.device().status();
    expect(pinned.ok && pinned.value.pinned).toContain(departed.id);

    const caught = await harness.folder.device().catchUp();
    expect(
      caught.ok ? caught.value.applied : 0,
      `the trash event was not applied, so nothing below is about a departure: ${JSON.stringify(caught)}`,
    ).toBe(1);

    const second = await harness.folder.pull();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      second.value.removed,
      "the item was trashed and its file stayed, bound and unmaintained, for the next scan to push back as an edit to a row the person cannot see",
    ).toBe(1);
    expect(second.value.kept).toBe(0);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
    const unpinned = await harness.folder.device().status();
    expect(
      unpinned.ok && unpinned.value.pinned,
      "a file's row stayed pinned once its binding went",
    ).not.toContain(departed.id);

    // The journal was not involved and nothing was queued. A journaled
    // path becomes a delete once the grace runs out (`folders/delete-grace`), so
    // the absence is asserted after it: the grace is the folder's five
    // seconds, and nothing shorter can show a delete not being sent.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect([
      scanned.value.created,
      scanned.value.missing,
      scanned.value.deleted,
    ]).toEqual([0, 0, 0]);
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_item"),
      "the removed file was journaled, and the grace turned it into a delete of an item in the bin",
    ).toEqual([]);

    const restored = await harness.folder.device().catchUp();
    expect(restored.ok ? restored.value.applied : 0).toBe(1);
    const third = await harness.folder.pull();
    expect(third.ok && third.value.written).toBe(1);
    expect(
      read(harness, "going.md"),
      "a restored item did not come back as a file",
    ).toContain("body");
  });

  /** A folder whose stream is the edge door's, holding `departed` placed at
   *  `going.md` once its pull and push have run. */
  async function placedDeparture(
    label: string,
    options: {
      filter?: string;
      tags?: string[];
      state?: Array<"active" | "archived">;
    } = {},
  ): Promise<EdgeDoor> {
    const edges = new EdgeDoor();
    harness = await folderHarness(label, {
      settings: {
        search: {
          types: ["core.note"],
          ...(options.filter === undefined ? {} : { filter: options.filter }),
          ...(options.state === undefined ? {} : { state: options.state }),
        },
      },
      rows: { "core.note": [{ item: departed, tags: options.tags }] },
      events: [edges.stream()],
    });
    scriptFolderWrites(harness, { edges });
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      edges.placements(harness.settings.id),
      "the fixture's folder did not place the item it wrote a file for",
    ).toEqual(new Map([[departed.id, "going.md"]]));
    return edges;
  }

  function deletesOfItem(harness: FolderHarness, id: string): number {
    return harness.server.requests.filter(
      (request) =>
        request.method === "DELETE" && request.pathname === `/items/${id}`,
    ).length;
  }

  function trashedAt(edges: EdgeDoor): void {
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.deleted",
        wireItem({ ...departed, state: "trashed" }),
      ),
    );
  }

  it("ends a folder's placement of an item that is trashed, and places it again on restore", async () => {
    const edges = await placedDeparture("folder-trashed-placement");
    trashedAt(edges);
    const trashed = await harness!.folder.push();
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    if (!trashed.ok) return;
    expect(trashed.value.pull?.removed).toBe(1);
    expect(existsSync(join(harness!.dir, "going.md"))).toBe(false);
    expect(
      edges.placements(harness!.settings.id),
      "the folder went on placing an item in the bin, which it no longer shows",
    ).toEqual(new Map());
    expect(
      harness!.server.requests.filter(
        (request) =>
          request.method === "DELETE" && request.pathname.startsWith("/edges/"),
      ),
      "the placement was ended by more than one delete",
    ).toHaveLength(1);

    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.restored",
        wireItem(departed),
      ),
    );
    const restored = await harness!.folder.push();
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.pull?.written).toBe(1);
    expect(existsSync(join(harness!.dir, "going.md"))).toBe(true);
    expect(
      edges.placements(harness!.settings.id),
      "a restored item was not placed again",
    ).toEqual(new Map([[departed.id, "going.md"]]));
  });

  it("ends a folder's placement of an item whose file the person deleted", async () => {
    const edges = await placedDeparture("folder-deleted-placement");
    rmSync(join(harness!.dir, "going.md"));
    expect((await harness!.folder.push()).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const swept = await harness!.folder.push();
    expect(swept.ok, JSON.stringify(swept)).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.scan.deleted).toBe(1);
    expect(
      edges.placements(harness!.settings.id),
      "the item was trashed by the delete and the folder went on placing it",
    ).toEqual(new Map());
  });

  it("keeps a folder's placement of an item whose file stays where it is", async () => {
    const edges = await placedDeparture("folder-unmatched-placement", {
      filter: 'tags contains "a"',
      tags: ["a"],
    });
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "metadata.changed",
        wireItem(departed),
        { tags: [] },
      ),
    );
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.pull?.unmatched,
      "the witness: the item left the search and its file stayed",
    ).toBe(1);
    expect(existsSync(join(harness!.dir, "going.md"))).toBe(true);
    expect(
      edges.placements(harness!.settings.id),
      "a placement ended while its file still sat in the folder",
    ).toEqual(new Map([[departed.id, "going.md"]]));
  });

  it("takes the end of a placement another machine ended first as done", async () => {
    const edges = await placedDeparture("folder-ended-elsewhere");
    // Another machine's end, which this copy has not heard of yet.
    for (const [id, edge] of [...edges.edges]) {
      if (edge.edge_type === "in-folder") edges.edges.delete(id);
    }
    trashedAt(edges);
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.drain.verdicts.filter(
        (entry) => entry.kind === "delete_edge",
      ),
      "the server's answer to the end of a placement already gone was not the one the folder takes as done",
    ).toMatchObject([{ verdict: "refused", reason: "edge_not_found" }]);
    expect(pushed.value.pull?.flagged).toEqual([]);
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(
      harness!.server.requests.filter(
        (request) =>
          request.method === "DELETE" && request.pathname.startsWith("/edges/"),
      ),
      "the end of a placement already gone was sent again",
    ).toHaveLength(1);
  });

  it("asks once for the end of a placement the server refuses, and reports it", async () => {
    const edges = await placedDeparture("folder-refused-end");
    edges.deleting = () => answers.edgePermissionDenied("in-folder");
    trashedAt(edges);
    const reports = [];
    for (let push = 0; push < 2; push += 1) {
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (pushed.ok) reports.push(pushed.value);
    }
    expect(
      reports.map((report) =>
        report.drain.verdicts
          .filter((entry) => entry.kind === "delete_edge")
          .map((entry) => entry.verdict),
      ),
      "the refusal of the end of a placement was not reported once, or was reported again",
    ).toEqual([["refused"], []]);
    expect(reports[0]?.pull?.ended).toBe(1);
    const queued = await harness!.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_edge"),
      "a refused end was queued again at every push",
    ).toHaveLength(1);
    expect(edges.placements(harness!.settings.id).size).toBe(1);
  });

  it("ends a folder's placement of an item that leaves by state, and places it again when it returns", async () => {
    const edges = await placedDeparture("folder-state-placement", {
      state: ["active"],
    });
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.state_changed",
        wireItem({ ...departed, state: "archived" }),
      ),
    );
    const left = await harness!.folder.push();
    expect(left.ok, JSON.stringify(left)).toBe(true);
    if (!left.ok) return;
    expect(left.value.pull).toMatchObject({ removed: 1, ended: 1 });
    expect(edges.placements(harness!.settings.id)).toEqual(new Map());

    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.state_changed",
        wireItem(departed),
      ),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(existsSync(join(harness!.dir, "going.md"))).toBe(true);
    expect(edges.placements(harness!.settings.id)).toEqual(
      new Map([[departed.id, "going.md"]]),
    );
  });

  it("keeps the file and the placement where ending the placement fails, and ends it at the next push", async () => {
    const edges = await placedDeparture("folder-end-fails");
    trashedAt(edges);
    const failed = await withFault("end-placement-fails", () =>
      harness!.folder.push(),
    );
    expect(failed.ok, "the injected failure did not fail the push").toBe(false);
    expect(
      existsSync(join(harness!.dir, "going.md")),
      "the file went though its placement was not ended, so nothing would end it",
    ).toBe(true);
    expect(edges.placements(harness!.settings.id).size).toBe(1);

    const retried = await harness!.folder.push();
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.pull).toMatchObject({ removed: 1, ended: 1 });
    expect(existsSync(join(harness!.dir, "going.md"))).toBe(false);
    expect(edges.placements(harness!.settings.id)).toEqual(new Map());
  });

  it("keeps the binding of a deleted file where ending its placement fails, and ends it at the next push", async () => {
    const edges = await placedDeparture("folder-delete-end-fails");
    rmSync(join(harness!.dir, "going.md"));
    expect((await harness!.folder.push()).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const failed = await withFault("end-placement-fails", () =>
      harness!.folder.push(),
    );
    expect(failed.ok).toBe(false);
    expect(edges.placements(harness!.settings.id).size).toBe(1);
    const retried = await harness!.folder.push();
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(
      edges.placements(harness!.settings.id),
      "a placement whose end failed once was never ended",
    ).toEqual(new Map());
    expect(deletesOfItem(harness!, departed.id)).toBe(1);
  });

  it("removes the file of an item that leaves by state", async () => {
    harness = await folderHarness("folder-leaves-by-state", {
      settings: { search: { types: ["core.note"], state: ["active"] } },
      rows: { "core.note": [{ item: departed }] },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.state_changed",
            wireItem({ ...departed, state: "archived" }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.removed).toBe(1);
    expect(pulled.value.unmatched).toBe(0);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
  });

  it("sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere", async () => {
    const archived = {
      id: "01a00000-0000-7000-8000-0000000000d2",
      properties: { title: "archived", body: "body\n" },
    };
    const trashed = {
      id: "01a00000-0000-7000-8000-0000000000d3",
      properties: { title: "trashed", body: "body\n" },
    };
    harness = await folderHarness("folder-journaled-departure", {
      settings: { search: { types: ["core.note"], state: ["active"] } },
      rows: { "core.note": [{ item: archived }, { item: trashed }] },
      events: [
        copyReplay("3", [
          copyItemEvent(
            "2",
            "item.state_changed",
            wireItem({ ...archived, state: "archived" }),
          ),
          copyItemEvent(
            "3",
            "item.deleted",
            wireItem({ ...trashed, state: "trashed" }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    // The person deletes both files, and the scan journals them.
    rmSync(join(harness.dir, "archived.md"));
    rmSync(join(harness.dir, "trashed.md"));
    const journaled = await harness.folder.scan();
    expect(journaled.ok && journaled.value.missing).toBe(2);
    // Another device archives one and trashes the other inside the grace.
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(2);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.removed,
      "the pull counted as removed files the person had already deleted, and cleared their journaled deletes",
    ).toBe(0);
    expect(pulled.value.kept).toBe(0);
    const waiting = await harness.folder.status();
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    const waits = Object.fromEntries(
      waiting.value.files.map((file) => [file.path, file.waits]),
    );
    // The witness: the archived item's file does wait on its delete.
    expect(waits["archived.md"]).toEqual(["delete"]);
    expect(
      waits["trashed.md"],
      "the status said a delete waits for a file whose item is already in the bin, and none will be sent",
    ).not.toContain("delete");

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const swept = await harness.folder.scan();
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const deletes = queued.value
      .filter((row) => row.kind === "delete_item")
      .map((row) => row.item_id);
    // The archived item's delete witnesses that a delete is produced here,
    // so the trashed item's absence is not a sweep that sent nothing.
    expect(
      deletes,
      "the person's delete of a file whose item was only archived elsewhere was never sent, and the item they deleted stays on the server",
    ).toContain(archived.id);
    expect(
      deletes,
      "a delete was sent for an item already in the bin, which the server refuses item_not_found",
    ).toEqual([archived.id]);
    expect(swept.value.trashed).toEqual(["archived.md"]);
    const status = await harness.folder.status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(
      status.value.files.map((file) => file.path),
      "a journaled file whose item is already in the bin kept its binding",
    ).toEqual([]);
  });

  it("writes a deleted file back when another device changes its item inside the grace, and sends no delete", async () => {
    const item = {
      id: "01a00000-0000-7000-8000-0000000000d4",
      properties: { title: "changed", body: "body\n" },
    };
    harness = await folderHarness("folder-journaled-revived", {
      rows: { "core.note": [{ item }] },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              ...item,
              version: 2,
              properties: { ...item.properties, body: "their edit\n" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    rmSync(join(harness.dir, "changed.md"));
    const journaled = await harness.folder.scan();
    expect(journaled.ok && journaled.value.missing).toBe(1);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok && pulled.value.revived).toBe(1);
    expect(read(harness, "changed.md")).toContain("their edit");

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const swept = await harness.folder.scan();
    expect(swept.ok && swept.value.deleted).toBe(0);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok && queued.value.filter((row) => row.kind === "delete_item"),
      "a delete was sent for an item changed elsewhere after the person deleted its file",
    ).toEqual([]);
  });

  it("keeps a deleted raw-text file gone after a version step even when its body looks like YAML", async () => {
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-raw-agreement", {
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    const text =
      "---\r\ntitle: 'body text'\r\nnumber: 1.10\r\n---\r\nThe body.\r\n";
    put(harness, "raw.txt", text);
    expect((await harness.folder.push()).ok).toBe(true);
    const id = String(sentCreates(harness)[0]!.id);
    expect(read(harness, "raw.txt")).toBe(text);
    rmSync(join(harness.dir, "raw.txt"));
    const scan = await harness.folder.scan();
    expect(scan.ok && scan.value.missing).toBe(1);
    edges.logItem(
      "item.updated",
      door!.update(id, { properties: {}, version: 1 }),
    );
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok && caught.value.applied).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok && pulled.value.revived).toBe(0);
    expect(existsSync(join(harness.dir, "raw.txt"))).toBe(false);
  });

  it("sends a person's delete of a file whose item moved on elsewhere in nothing the file shows", async () => {
    const item = {
      id: "01a00000-0000-7000-8000-0000000000d5",
      properties: { title: "stepped", body: "body\n" },
    };
    harness = await folderHarness("folder-journaled-version-step", {
      rows: { "core.note": [{ item }] },
      events: [
        copyReplay("2", [
          copyItemEvent("2", "item.updated", wireItem({ ...item, version: 2 })),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const styled = read(harness, "stepped.md")
      .replace("title: stepped", "# keep this comment\ntitle: 'stepped'")
      .replaceAll("\n", "\r\n");
    put(harness, "stepped.md", styled);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect(read(harness, "stepped.md")).toBe(styled);
    rmSync(join(harness.dir, "stepped.md"));
    const journaled = await harness.folder.scan();
    expect(journaled.ok && journaled.value.missing).toBe(1);
    // The witness: the copy takes a version step no file shows.
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      [pulled.value.revived, existsSync(join(harness.dir, "stepped.md"))],
      "a version step the file cannot show wrote a deleted file back and dropped the person's delete",
    ).toEqual([0, false]);

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect((await harness.folder.scan()).ok).toBe(true);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok &&
        queued.value
          .filter((row) => row.kind === "delete_item")
          .map((row) => row.item_id),
    ).toEqual([item.id]);
  });

  it("takes away a file put back after its delete was journaled, once its item leaves by state, and sends no delete", async () => {
    harness = await folderHarness("folder-put-back-departed", {
      settings: { search: { types: ["core.note"], state: ["active"] } },
      rows: { "core.note": [{ item: departed }] },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.state_changed",
            wireItem({ ...departed, state: "archived" }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const bytes = read(harness, "going.md");
    rmSync(join(harness.dir, "going.md"));
    const journaled = await harness.folder.scan();
    expect(journaled.ok && journaled.value.missing).toBe(1);
    // The person puts the same bytes back, and the item is archived elsewhere.
    put(harness, "going.md", bytes);
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    const pulled = await harness.folder.pull();
    // The witness: the pull took the file away as the departed item's.
    expect(pulled.ok && pulled.value.removed).toBe(1);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect((await harness.folder.scan()).ok).toBe(true);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok && queued.value.filter((row) => row.kind === "delete_item"),
      "the journal row of a file the person had put back outlived the pull that took the file away, and became a delete",
    ).toEqual([]);
  });

  it("holds the file of an item that leaves by state where it cannot be read, and does not call it kept", async () => {
    harness = await folderHarness("folder-departed-unreadable", {
      settings: { search: { types: ["core.note"], state: ["active"] } },
      rows: { "core.note": [{ item: departed }] },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.state_changed",
            wireItem({ ...departed, state: "archived" }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const path = join(harness.dir, "going.md");
    chmodSync(path, 0o000);
    try {
      expect((await harness.folder.device().catchUp()).ok).toBe(true);
      const pulled = await harness.folder.pull();
      expect(pulled.ok).toBe(true);
      if (!pulled.ok) return;
      // The witness: the file is held, not taken away.
      expect(pulled.value.removed).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(
        [pulled.value.kept, pulled.value.unwritten],
        "a file the pull could not read was reported as kept with the person's changes",
      ).toEqual([0, 1]);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("keeps an unmatched file current, so its second edit keeps another device's change", async () => {
    const item = {
      id: "01a00000-0000-7000-8000-0000000000f1",
      properties: { title: "going", body: "body\n", status: "a" },
    };
    const theirs = {
      ...item,
      version: 2,
      properties: { ...item.properties, status: "b" },
    };
    harness = await folderHarness("folder-unmatched-current", {
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "keep"' },
      },
      rows: { "core.note": [{ item, tags: ["keep"] }] },
      events: [
        copyReplay("2", [
          copyItemEvent("2", "item.updated", wireItem(theirs), { tags: [] }),
        ]),
        copyLiveReplay("2", []),
      ],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    // Another device sets `status: b`, and the item leaves the search.
    door?.update(item.id, { properties: { status: "b" }, version: 1 });
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    const pulled = await harness.folder.pull();
    expect(pulled.ok && pulled.value.unmatched).toBe(1);
    expect(read(harness, "going.md")).toContain("status: b");

    for (const edit of ["first edit", "second edit"]) {
      writeFileSync(
        join(harness.dir, "going.md"),
        read(harness, "going.md") + `${edit}\n`,
      );
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    }
    expect(
      rows.get(item.id)?.properties.status,
      "a later edit of an unmatched file put back a value another device had changed",
    ).toBe("b");
  });

  it("keeps a file whose item no longer matches, flagged", async () => {
    harness = await folderHarness("folder-unmatched", {
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "keep"' },
      },
      rows: { "core.note": [{ item: departed, tags: ["keep"] }] },
      events: [
        copyReplay("2", [
          copyItemEvent("2", "metadata.changed", wireItem(departed), {
            tags: [],
          }),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.removed,
      "the pull took away the file of an item that only stopped matching, which says nothing of whether the file is wanted",
    ).toBe(0);
    expect(pulled.value.unmatched).toBe(1);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);
    // Still bound: an edit to it goes to its item.
    writeFileSync(
      join(harness.dir, "going.md"),
      read(harness, "going.md") + "still the same item\n",
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect([scanned.value.created, scanned.value.updated]).toEqual([0, 1]);
  });

  it("keeps the file of an item a narrowed search leaves out, flagged, and sends its edits to it", async () => {
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-narrowed-out", {
      rows: { "core.note": [{ item: departed }] },
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyHeadRead("3"),
        copyLiveReplay("3", []),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const id = idIn(harness, "going.md");
    harness.settings.settings = { search: { types: ["core.bookmark"] } };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.catch_up.hydrated).not.toBeNull();
    expect(
      pushed.value.pull?.unmatched,
      "the copy let go of a bound file's row when the search narrowed, so the file is bound to nothing",
    ).toBe(1);
    await editedReachesItsItem(harness, departed.id, id);
  });

  it("keeps the file of an item retyped out of its search elsewhere, flagged, and sends its edits to it", async () => {
    const retyped = { ...departed, type: "core.bookmark", version: 2 };
    harness = await folderHarness("folder-retyped-out", {
      rows: { "core.note": [{ item: departed }] },
      events: [
        copyReplay("2", [
          copyItemEvent("2", "item.updated", wireItem(retyped)),
        ]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness, {
      door: (door) => {
        door.rows.set(departed.id, {
          properties: departed.properties,
          type: "core.bookmark",
          source_id: null,
          version: 2,
        });
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const id = idIn(harness, "going.md");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      pushed.ok && pushed.value.pull?.unmatched,
      "the copy let go of a bound file's row retyped out of the search, so the file is bound to nothing",
    ).toBe(1);
    await editedReachesItsItem(harness, departed.id, id);
  });

  it("keeps a file the folder never wrote whose create was refused, inside one push", async () => {
    // The scan binds the person's own bytes and queues the create; the
    // server refuses it; the drain reads the row back, finds nothing and
    // forgets it; the pull that ends the same push then meets a bound file
    // whose item the copy no longer holds.
    harness = await folderHarness("folder-refused-create");
    scriptWrites(harness.server, {
      create: [refusal(400, "invalid_properties", "the body is not allowed")],
      read: [refusal(404, "item_not_found", "no such item")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "mine.md", "---\ntitle: Mine\n---\nthe person's own words\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.drain.verdicts[0]?.verdict).toBe("refused");
    expect(
      pushed.value.pull?.removed,
      "the pull took away a file the folder never wrote, and the person's words with it",
    ).toBe(0);
    expect(read(harness, "mine.md")).toContain("the person's own words");
    // Its placement was refused with the create, not by an answer of its own.
    expect(
      pushed.value.drain.verdicts.some((entry) => entry.kind === "create_edge"),
    ).toBe(true);
    expect(
      pushed.value.pull?.unplaced,
      "a placement refused with the create it waited on was held back as refused itself",
    ).toBe(0);

    // Still bound, so the next scan neither makes a second item of it nor
    // queues the refused create again, and it says so; the push's own report
    // is what said the create was refused, and an edit to the file queues it
    // again (`folders/lost-row-edit-retried`).
    const before = sentCreates(harness).length;
    expect(before, "the create was never sent, so nothing was refused").toBe(1);
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect([scanned.value.created, scanned.value.lost]).toEqual([0, 1]);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentCreates(harness).length).toBe(before);
  });

  it("keeps a file the person changed after its item left, and says so", async () => {
    harness = await departure("folder-departed-edited");
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "going.md"),
      read(harness, "going.md") + "an edit the person made\n",
    );
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);

    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.kept,
      "the pull took away a file the person had changed, and their edit with it",
    ).toBe(1);
    expect(pulled.value.removed).toBe(0);
    expect(read(harness, "going.md")).toContain("an edit the person made");
  });
});

describe("what a pull does with a file whose item is purged", () => {
  const purged = {
    id: "01a00000-0000-7000-8000-0000000000d2",
    properties: { title: "going", body: "body\n" },
  };

  /** A folder holding one item, and a stream that purges it. */
  async function purge(label: string): Promise<FolderHarness> {
    return folderHarness(label, {
      rows: { "core.note": [{ item: purged }] },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.purged",
            wireItem({ ...purged, state: "trashed" }),
          ),
        ]),
      ],
    });
  }

  it("sends nothing to end the placement of a purged item, which the purge took with it", async () => {
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-purged-placement", {
      rows: { "core.note": [{ item: purged }] },
      events: [edges.stream()],
    });
    scriptFolderWrites(harness, { edges });
    expect((await harness.folder.push()).ok).toBe(true);
    expect(edges.placements(harness.settings.id).size).toBe(1);
    // The server removes an item's edges with it (`items/purge-edges`).
    for (const [id, edge] of [...edges.edges]) {
      if (edge.source_id === purged.id) edges.edges.delete(id);
    }
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.purged",
        wireItem({ ...purged, state: "trashed" }),
      ),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.pull).toMatchObject({
      removed: 1,
      purged: 1,
      ended: 0,
    });
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "DELETE" && request.pathname.startsWith("/edges/"),
      ),
      "a delete was sent for a placement the purge had taken",
    ).toEqual([]);
  });

  it("removes a purged item's file where its bytes are the folder's own, and says so", async () => {
    harness = await purge("folder-purged");
    scriptFolderWrites(harness);
    const first = await harness.folder.pull();
    expect(first.ok && first.value.written).toBe(1);
    const caught = await harness.folder.device().catchUp();
    expect(
      caught.ok ? caught.value.applied : 0,
      `the purge was not applied, so nothing below is about a purge: ${JSON.stringify(caught)}`,
    ).toBe(1);

    const scanned = await harness.folder.scan();
    expect(scanned.ok && scanned.value.lost).toBe(0);
    const second = await harness.folder.pull();
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(
      [second.value.removed, second.value.purged],
      "the purged item's file stayed, bound to an item that is gone, for good",
    ).toEqual([1, 1]);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
    const status = await harness.folder.status();
    expect(status.ok && status.value.files).toEqual([]);
    // A scan after the take-away is what would journal the file's delete.
    expect((await harness.folder.scan()).ok).toBe(true);
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    expect(
      queued.ok && queued.value.filter((row) => row.kind === "delete_item"),
      "the purged item's removed file was sent as a delete",
    ).toEqual([]);
  });

  it("says in words that a purged item's file was removed", async () => {
    harness = await purge("folder-purged-words");
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    const text = await harness.folder.pullText();
    expect(text.ok, JSON.stringify(text)).toBe(true);
    expect(text.ok && text.value).toContain(
      "1 file(s) of items purged removed",
    );
    expect(text.ok && text.value).not.toContain("trashed or out of the search");
  });

  it("says while watching that a purged item's file was removed", async () => {
    harness = await purge("folder-purged-watch-words");
    scriptFolderWrites(harness);
    // Pulled without the catch-up, so the watch's stream brings the purge.
    expect((await harness.folder.pull()).ok).toBe(true);
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(
        () =>
          expect(watching.stdout, watching.stdout).toContain(
            "1 removed whose item was purged",
          ),
        { timeout: 30_000, interval: 100 },
      );
    } finally {
      await watching.stop();
    }
    expect(watching.stdout).not.toContain("trashed or left by state");
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
  });

  it("keeps a purged item's file the person changed since the folder wrote it, and says so", async () => {
    harness = await purge("folder-purged-edited");
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "going.md"),
      read(harness, "going.md") + "an edit the person made\n",
    );
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);

    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.kept,
      "the pull took away a file the person had changed, and their edit with it",
    ).toBe(1);
    expect([pulled.value.removed, pulled.value.purged]).toEqual([0, 0]);
    expect(read(harness, "going.md")).toContain("an edit the person made");
  });

  it("writes no file for a row purged while the pull writes it, and reads the copy again", async () => {
    harness = await purge("folder-purged-mid-pull");
    scriptFolderWrites(harness);
    const pulled = await withFault(`purge-during-pull=${purged.id}`, () =>
      harness!.folder.pull(),
    );
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(0);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
    const status = await harness.folder.status();
    expect(status.ok && status.value.files).toEqual([]);
    const pinned = await harness.folder.device().status();
    expect(pinned.ok && pinned.value.pinned).not.toContain(purged.id);
  });

  it("places nothing for a row purged before its placement is queued, and takes its file away at the next pull", async () => {
    harness = await purge("folder-purged-before-placement");
    scriptFolderWrites(harness);
    const pulled = await withFault(`purge-before-placement=${purged.id}`, () =>
      harness!.folder.pull(),
    );
    expect(
      pulled.ok,
      `a placement of a row gone from the copy ended the pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.placed).toBe(0);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok && queued.value.filter((row) => row.kind === "create_edge"),
      "a placement was queued from a row the copy no longer holds",
    ).toEqual([]);
    // The file landed before the purge, and goes once the pull is run again.
    const next = await harness.folder.pull();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
    const status = await harness.folder.status();
    expect(status.ok && status.value.files).toEqual([]);
  });

  it("lets go of a refused placement once its item is purged", async () => {
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      edge.edge_type === "in-folder"
        ? refusal(404, "item_not_found", "Item not found")
        : undefined;
    harness = await purge("folder-purged-refused-placement");
    scriptFolderWrites(harness, { edges });
    // Pulled without the catch-up, so the placement is refused before the
    // purge reaches the copy.
    expect((await harness.folder.pull()).ok).toBe(true);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.drain.verdicts.some(
        (verdict) => verdict.verdict === "refused",
      ),
      `the placement was not refused, so nothing below is about a refusal: ${JSON.stringify(pushed.value.drain)}`,
    ).toBe(true);
    expect(pushed.value.pull?.purged).toBe(1);
    expect(
      pushed.value.pull?.unplaced,
      "a refused placement of an item that is gone was reported for good",
    ).toBe(0);
  });

  it("pulls again where the copy changes under the pull", async () => {
    harness = await purge("folder-copy-changed-once");
    scriptFolderWrites(harness);
    // The witness: the same change at every attempt ends the pull.
    const ended = await withFault("copy-changes-during-pull=always", () =>
      harness!.folder.pull(),
    );
    expect(ended.ok).toBe(false);
    if (ended.ok) return;
    expect(ended.refusal.raw).toContain("local_copy_changed");
    const pulled = await withFault("copy-changes-during-pull=once", () =>
      harness!.folder.pull(),
    );
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(pulled.ok && pulled.value.written).toBe(1);
  });

  it("counts what an attempt wrote before the copy changed under it", async () => {
    harness = await folderHarness("folder-copy-changed-after-a-write", {
      rows: {
        "core.note": [
          { item: purged },
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000d3",
              properties: { title: "staying", body: "body\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    const pulled = await withFault("copy-changes-during-pull=second", () =>
      harness!.folder.pull(),
    );
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    // One unchanged file is the witness: the second attempt found the file
    // the first had written.
    expect(
      [pulled.value.written, pulled.value.unchanged],
      "the report counted the last attempt alone",
    ).toEqual([2, 1]);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);
    expect(existsSync(join(harness.dir, "staying.md"))).toBe(true);
  });

  it("goes on watching where the copy keeps changing under its pull, and says so once", async () => {
    // No purge in the stream: the pull has a file to write at every pass.
    harness = await folderHarness("folder-copy-changing-watch", {
      rows: { "core.note": [{ item: purged }] },
    });
    scriptFolderWrites(harness);
    // The witness: a one-off pull meeting the same change says so and fails.
    const pulled = await withFault("copy-changes-during-pull=always", () =>
      harness!.folder.pull(),
    );
    expect(pulled.ok).toBe(false);
    if (pulled.ok) return;
    expect(pulled.refusal.raw).toContain("local_copy_changed");

    process.env.MARFA_TEST_FAULT = "copy-changes-during-pull=always";
    const watch = harness.folder.watchText();
    delete process.env.MARFA_TEST_FAULT;
    try {
      await vi.waitFor(
        () => {
          expect(watch.stderr).toContain("the copy changed under the pull");
        },
        { timeout: 20_000, interval: 200 },
      );
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(watch.running(), watch.stderr).toBe(true);
      expect(
        watch.stderr.split("the copy changed under the pull").length - 1,
        watch.stderr,
      ).toBe(1);
    } finally {
      await watch.stop();
    }
  });
});

describe("what a folder never does to a person's text", () => {
  it("writes a file whole beside it and renames it over, so a failed write leaves the old one", async () => {
    const id = "01a00000-0000-7000-8000-00000000fa01";
    harness = await folderHarness("folder-write-whole", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Whole", body: "as it was\n" },
            },
          },
        ],
      },
      events: [
        copyLiveReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "Whole", body: "changed elsewhere\n" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const path = join(harness.dir, "Whole.md");
    expect(read(harness, "Whole.md")).toContain("as it was");
    const before = statSync(path).ino;
    // A Finder tag, say, which only macOS keeps as an attribute.
    const tags = process.platform === "darwin";
    if (tags) execFileSync("xattr", ["-w", "com.example.kept", "yes", path]);
    // The push's catch-up brings the change, and its pull writes it.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(read(harness, "Whole.md")).toContain("changed elsewhere");
    if (tags) {
      expect(
        execFileSync("xattr", ["-p", "com.example.kept", path], {
          encoding: "utf8",
        }).trim(),
        "a rewrite dropped the file's other attributes",
      ).toBe("yes");
    }
    expect(
      statSync(path).ino,
      "the pull wrote the file in place, so a write cut short by a full disk or a crash leaves it truncated, and the next scan sends what is left as the person's edit",
    ).not.toBe(before);
    expect(
      readdirSync(harness.dir).filter((name) => name.endsWith(".tmp")),
      "a write left its new file beside the old one",
    ).toEqual([]);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentUpdates(harness)).toEqual([]);
  });

  it("holds a document that is not UTF-8, and never sends or rewrites it", async () => {
    const id = "01a00000-0000-7000-8000-00000000fa11";
    harness = await folderHarness("folder-not-utf8", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Held", body: "as it was\n" },
            },
          },
        ],
      },
      events: [
        copyLiveReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "Held", body: "changed elsewhere\n" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    // Latin-1, as an older editor saves it: an accent is one byte, 0xE9 for
    // é, which is never a whole character in UTF-8.
    const latin1 = (text: string) => Buffer.from(text, "latin1");
    const held = latin1(
      read(harness, "Held.md").replace("as it was", "café, edited"),
    );
    saveAtomically(harness, "Held.md", held);
    const note = latin1("---\ntitle: Café\n---\nun café au lait\n");
    writeFileSync(join(harness.dir, "Cafe.md"), note);
    const text = latin1("naïve\n");
    writeFileSync(join(harness.dir, "naive.txt"), text);
    // UTF-16 with no byte-order mark: ASCII letters, each beside a NUL, which
    // decodes as UTF-8 but is no text.
    const wide = Buffer.from("wide\n", "utf16le");
    writeFileSync(join(harness.dir, "wide.txt"), wide);
    // The witness: a UTF-8 note with the same accent is sent.
    put(harness, "Plain.md", "---\ntitle: Plain\n---\nun café\n");

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [sentTitles(harness), sentUpdates(harness)],
      "a document that is not UTF-8 was sent with its accents replaced",
    ).toEqual([["Plain"], []]);
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]).sort(),
    ).toEqual([
      ["Cafe.md", "encoding"],
      ["Held.md", "encoding"],
      ["naive.txt", "encoding"],
      ["wide.txt", "encoding"],
    ]);
    expect(pushed.value.pull?.flagged).toEqual([
      expect.objectContaining({ path: "Held.md", flag: "encoding" }),
    ]);
    const reasons = new Map(
      pushed.value.scan.flagged.map((file) => [file.path, file.reason]),
    );
    expect(reasons.get("naive.txt")).toContain("not UTF-8");
    expect(
      reasons.get("wide.txt"),
      "a file holding a NUL byte was given the reason of one that is not UTF-8",
    ).toContain("NUL byte");
    expect(reasons.get("wide.txt")).not.toContain("not UTF-8");
    // The push's pull met the change made elsewhere and left the file.
    expect(
      [
        readFileSync(join(harness.dir, "Held.md")),
        readFileSync(join(harness.dir, "Cafe.md")),
        readFileSync(join(harness.dir, "naive.txt")),
        readFileSync(join(harness.dir, "wide.txt")),
      ],
      "a document that is not UTF-8 was written over, its accents lost on the disk too",
    ).toEqual([held, note, text, wide]);
    const status = await harness.folder.status();
    expect(
      status.ok &&
        status.value.files
          .filter((file) => file.flag === "encoding")
          .map((file) => [file.path, file.status]),
    ).toEqual([
      ["Cafe.md", "held"],
      ["Held.md", "held"],
      ["naive.txt", "held"],
      ["wide.txt", "held"],
    ]);

    // Saved as UTF-8, it is sent as any new file is.
    put(harness, "Cafe.md", "---\ntitle: Café\n---\nun café au lait\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentTitles(harness)).toEqual(["Plain", "Café"]);
  });

  it("trashes nothing while its directory is gone, and says so", async () => {
    const ids = [
      "01a00000-0000-7000-8000-00000000fa21",
      "01a00000-0000-7000-8000-00000000fa22",
      "01a00000-0000-7000-8000-00000000fa23",
    ];
    harness = await folderHarness("folder-root-gone", {
      rows: {
        "core.note": ids.map((id, at) => ({
          item: {
            id,
            version: 1,
            properties: { title: `Note ${String(at)}`, body: "body\n" },
          },
        })),
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const deleted = () =>
      harness!.server.requests
        .filter(
          (request) =>
            request.method === "DELETE" &&
            request.pathname.startsWith("/items/"),
        )
        .map((request) => request.pathname.split("/").at(-1));
    const dir = harness.dir;
    const away = `${dir}-away`;
    const watching = harness.folder.watch();
    try {
      // The witness: a file deleted while the watch runs is sent as a delete
      // once the grace has run.
      rmSync(join(dir, "Note 0.md"));
      await vi.waitFor(
        () => {
          expect(deleted()).toEqual([ids[0]]);
        },
        { timeout: 30_000, interval: 200 },
      );
      // The whole folder moves away, as a rename in the Finder or an
      // ejected volume takes it.
      renameSync(dir, away);
      await vi.waitFor(
        () => {
          expect(
            watching.stdout,
            "the watch did not say its directory is gone",
          ).toContain("cannot be found");
        },
        { timeout: 30_000, interval: 200 },
      );
      // Well past the rename grace, with a pass every second.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect(
        deleted(),
        "every file read as deleted when the folder's directory went away",
      ).toEqual([ids[0]]);
      expect(watching.running(), watching.stderr).toBe(true);
      expect(
        existsSync(dir),
        "the watch wrote the folder anew where it used to be",
      ).toBe(false);

      // Back, it goes on where it left off.
      renameSync(away, dir);
      rmSync(join(dir, "Note 1.md"));
      await vi.waitFor(
        () => {
          expect(deleted()).toEqual([ids[0], ids[1]]);
        },
        { timeout: 30_000, interval: 200 },
      );
      expect(read(harness, "Note 2.md")).toContain("body");
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      await watching.stop();
      if (existsSync(away)) renameSync(away, dir);
    }
  });

  it("gives each file a pull writes from the server's bytes the quarantine mark on macOS", async () => {
    const [tool, later, note] = [
      "01a00000-0000-7000-8000-00000000fa31",
      "01a00000-0000-7000-8000-00000000fa32",
      "01a00000-0000-7000-8000-00000000fa33",
    ];
    const fileItem = (
      id: string,
      title: string,
      bytes: Buffer,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      version: 1,
      type: "core.file",
      properties: {
        title,
        blob_ref: hashOf(bytes),
        mime_type: "application/octet-stream",
        ...extra,
      },
    });
    const [toolBytes, laterBytes] = [1, 2].map((n) => Buffer.from([n, n, n]));
    harness = await folderHarness("folder-quarantine", {
      settings: { search: { types: ["core.file", "core.note"] } },
      rows: {
        "core.file": [
          { item: fileItem(tool, "tool.bin", toolBytes, { executable: true }) },
          { item: fileItem(later, "later.bin", laterBytes) },
        ],
        "core.note": [
          {
            item: {
              id: note,
              version: 1,
              properties: { title: "Readme", body: "words\n" },
            },
          },
        ],
      },
      events: [
        copyLiveReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              ...fileItem(later, "later.bin", laterBytes, { executable: true }),
              version: 2,
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    for (const bytes of [toolBytes, laterBytes]) {
      scriptBlob(harness.server, bytes);
    }
    const runs = (name: string) =>
      (statSync(join(harness!.dir, name)).mode & 0o100) !== 0;
    // Only macOS keeps the mark Gatekeeper reads; elsewhere the files are
    // written as before.
    const marks = process.platform === "darwin";
    const marked = (name: string) => {
      try {
        execFileSync(
          "xattr",
          ["-p", "com.apple.quarantine", join(harness!.dir, name)],
          { stdio: "pipe" },
        );
        return true;
      } catch {
        return false;
      }
    };
    expect((await harness.folder.pull()).ok).toBe(true);
    expect([runs("tool.bin"), runs("later.bin")]).toEqual([true, false]);
    if (marks) {
      expect(
        [marked("tool.bin"), marked("later.bin")],
        "a file a pull wrote from the server's bytes carries no quarantine mark",
      ).toEqual([true, true]);
      // A note is text the folder renders, never bytes to run.
      expect(marked("Readme.md")).toBe(false);
      // Unmarked, as a file the person made is, before the server says it
      // runs; and a file the person cleared, which nothing changes.
      for (const name of ["later.bin", "tool.bin"]) {
        execFileSync("xattr", [
          "-d",
          "com.apple.quarantine",
          join(harness.dir, name),
        ]);
        expect(marked(name)).toBe(false);
      }
    }
    // The push's catch-up makes the file in place runnable, and marks it.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(runs("later.bin")).toBe(true);
    if (marks) {
      expect(
        marked("later.bin"),
        "a file a pull made runnable in place carries no quarantine mark",
      ).toBe(true);
      expect(
        marked("tool.bin"),
        "a push put back a quarantine mark the person took off a file it did not change",
      ).toBe(false);
    }
    expect(sentUpdates(harness)).toEqual([]);
  });

  it("restores a styled file's agreement after a pull crashes before landing", async () => {
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-styled-crash", {
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    const prefix =
      "---\r\n# Keep café\r\ntitle: 'Styled'\r\nnumber: 1.10\r\n---\r\n";
    put(harness, "styled.md", `${prefix}before\r\n`);
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "styled.md")!;
    const before = read(harness, "styled.md");
    expect(before).toContain("marfa_version: 1\r\n");
    edges.logItem(
      "item.updated",
      door!.update(id, { properties: { body: "after\r\n" }, version: 1 }),
    );
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok && caught.value.applied).toBe(1);
    await expect(
      withFault("crash-before-rename=styled.md", () => harness!.folder.pull()),
    ).rejects.toThrow(/could not be run/);
    expect(read(harness, "styled.md")).toBe(before);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentUpdates(harness)).toEqual([]);
    expect(read(harness, "styled.md")).toBe(
      before
        .replace("before\r\n", "after\r\n")
        .replace("marfa_version: 1", "marfa_version: 2"),
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    expect(sentUpdates(harness)).toEqual([]);
  });

  it("keeps a file a crash cut off writing as its own, and sends nothing for it", async () => {
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-write-cut-off", {
      events: [edges.stream()],
    });
    scriptFolderWrites(harness, { edges });
    // A text file, which carries no version line to base an edit on.
    put(harness, "whole.txt", "as it was\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = String(sentCreates(harness)[0]?.id);
    const before = readFileSync(join(harness.dir, "whole.txt"));
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.updated",
        wireItem({
          id,
          version: 2,
          properties: { title: "whole", body: "changed elsewhere\n" },
        }),
      ),
    );
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    await expect(
      withFault("crash-before-rename=whole.txt", () => harness!.folder.pull()),
    ).rejects.toThrow(/could not be run/);
    // The witness: the crash came after the pull chose to write, and before
    // the new file landed.
    expect(readFileSync(join(harness.dir, "whole.txt"))).toEqual(before);
    const status = await harness.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "whole.txt")?.status,
      "the status said the file a crash left waits to be sent",
    ).toBe("in_step");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness),
      "the old file a crash left was sent as the person's edit, over the newer version",
    ).toEqual([]);
    expect(read(harness, "whole.txt")).toBe("changed elsewhere\n");
    expect(
      readdirSync(harness.dir).filter((name) => name.endsWith(".tmp")),
      "the new file the crash left beside the old one was never cleared",
    ).toEqual([]);
  });

  it("journals no delete for a new file a crash cut off writing", async () => {
    const id = "01a00000-0000-7000-8000-00000000fa52";
    harness = await folderHarness("folder-new-cut-off", {
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.created",
            wireItem({
              id,
              version: 1,
              properties: { title: "Fresh", body: "made elsewhere\n" },
            }),
          ),
        ]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    await expect(
      withFault("crash-before-rename=Fresh.md", () => harness!.folder.pull()),
    ).rejects.toThrow(/could not be run/);
    expect(existsSync(join(harness.dir, "Fresh.md"))).toBe(false);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.missing,
      "a file a crash kept from landing was journaled as deleted",
    ).toBe(0);
    // The witness: the item is still the folder's, and its file is written.
    expect(idIn(harness, "Fresh.md")).toBe(id);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      harness.server.requests.filter((request) => request.method === "DELETE"),
    ).toEqual([]);
  });

  it("keeps its settings file its own when a crash cuts off writing it", async () => {
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-settings-cut-off", {
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    const before = readFileSync(settingsFile(harness), "utf8");
    harness.settings.settings = {
      ...harness.settings.settings,
      defaults: { tags: ["from elsewhere"] },
    };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    await expect(
      withFault("crash-before-rename=folder.yaml", () =>
        harness!.folder.pull(),
      ),
    ).rejects.toThrow(/could not be run/);
    expect(readFileSync(settingsFile(harness), "utf8")).toBe(before);
    const sent = scriptFolderChanges(harness);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sent,
      "the old settings file a crash left was sent as the person's edit",
    ).toEqual([]);
    expect(readFileSync(settingsFile(harness), "utf8")).toContain(
      "- from elsewhere",
    );
  });

  it("reports a settings file it cannot write, and goes on", async () => {
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-settings-unwritable", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000fa90",
              properties: { title: "Independent", body: "work continues\n" },
            },
          },
        ],
      },
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    harness.settings.settings = {
      ...harness.settings.settings,
      defaults: { tags: ["from elsewhere"] },
    };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    // A path no file can be written over, as a full disk refuses one.
    rmSync(settingsFile(harness));
    mkdirSync(settingsFile(harness));
    expect(existsSync(join(harness.dir, "Independent.md"))).toBe(false);
    const pulled = await harness.folder.pull();
    expect(
      pulled.ok,
      `a settings file that could not be written ended the pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.settings).toMatchObject({
      written: false,
      unwritten: expect.stringContaining("folder.yaml") as unknown,
    });
    expect(pulled.value.written).toBe(1);
    expect(readFileSync(join(harness.dir, "Independent.md"), "utf8")).toContain(
      "work continues\n",
    );
    // A push and a watch say so in words too.
    const said = await harness.folder.pushText();
    expect(said.ok && said.value).toContain(
      "the settings file was not written",
    );
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(
        () => {
          expect(watching.stdout).toContain(
            "the settings file was not written",
          );
        },
        { timeout: 30_000, interval: 200 },
      );
    } finally {
      await watching.stop();
    }
    // Writable again, the next pass writes it.
    rmSync(settingsFile(harness), { recursive: true });
    const again = await harness.folder.pull();
    expect(again.ok && again.value.settings.written).toBe(true);
    expect(readFileSync(settingsFile(harness), "utf8")).toContain(
      "- from elsewhere",
    );
  });

  it("keeps a file that appears after an absent landing target was checked", async () => {
    const id = "01a00000-0000-7000-8000-00000000fa91";
    harness = await folderHarness("landing-no-replace", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: { title: "Late", body: "from the server\n" },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000fa92",
              properties: { title: "Control", body: "control\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    const pulled = await withFault("create-before-rename=Late.md", () =>
      harness!.folder.pull(),
    );
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(read(harness, "Control.md")).toContain("control\n");
    expect(read(harness, "Late.md")).toBe("appeared meanwhile\n");
    expect([pulled.value.written, pulled.value.unwritten]).toEqual([1, 1]);
    const status = await harness.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Late.md")?.item_id,
    ).toBeUndefined();
    expect(
      readdirSync(harness.dir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    rmSync(join(harness.dir, "Late.md"));
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(idIn(harness, "Late.md")).toBe(id);
    const scan = await harness.folder.scan();
    expect(scan.ok && [scan.value.created, scan.value.updated]).toEqual([0, 0]);
  });

  it("does not make its directory anew when it goes away during a pull", async () => {
    const id = "01a00000-0000-7000-8000-00000000fa61";
    harness = await folderHarness("folder-gone-mid-pull", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Late", body: "body\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    const dir = harness.dir;
    const away = `${dir}-away`;
    try {
      // Moved away after the pull began and before its first write.
      const pulled = await withFault("move-folder-before-write", () =>
        harness!.folder.pull(),
      );
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      if (!pulled.ok) return;
      expect(
        existsSync(dir),
        "a pull made the folder's directory anew where it used to be",
      ).toBe(false);
      expect(pulled.value.unwritten).toBe(1);
      expect(existsSync(join(away, "Late.md"))).toBe(false);
    } finally {
      if (existsSync(away)) {
        rmSync(dir, { recursive: true, force: true });
        renameSync(away, dir);
      }
    }
    // The witness: back where it was, the next pull writes the file.
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(read(harness, "Late.md")).toContain("body");
  });

  it("reads, writes and trashes nothing in a copy put in its directory's place", async () => {
    const ids = [
      "01a00000-0000-7000-8000-00000000fa81",
      "01a00000-0000-7000-8000-00000000fa82",
    ];
    harness = await folderHarness("folder-root-replaced", {
      rows: {
        "core.note": ids.map((id, at) => ({
          item: {
            id,
            version: 1,
            properties: { title: `Note ${String(at)}`, body: "body\n" },
          },
        })),
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const deleted = () =>
      harness!.server.requests
        .filter(
          (request) =>
            request.method === "DELETE" &&
            request.pathname.startsWith("/items/"),
        )
        .map((request) => request.pathname.split("/").at(-1));
    const dir = harness.dir;
    const old = `${dir}-old`;
    const watching = harness.folder.watch();
    try {
      // The witness: a delete made while the watch runs is sent.
      rmSync(join(dir, "Note 0.md"));
      await vi.waitFor(
        () => {
          expect(deleted()).toEqual([ids[0]]);
        },
        { timeout: 30_000, interval: 200 },
      );
      // A copy of the folder, its own `.marfa/` with it, put in its place.
      cpSync(dir, `${dir}-copy`, { recursive: true });
      renameSync(dir, old);
      renameSync(`${dir}-copy`, dir);
      await vi.waitFor(
        () => {
          expect(
            watching.stdout,
            "the watch did not say its directory was replaced",
          ).toContain("no longer the directory");
        },
        { timeout: 30_000, interval: 200 },
      );
      rmSync(join(dir, "Note 1.md"));
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect(
        deleted(),
        "a file taken out of the copy was sent as a delete from the folder",
      ).toEqual([ids[0]]);
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      await watching.stop();
      if (existsSync(old)) {
        rmSync(dir, { recursive: true, force: true });
        renameSync(old, dir);
      }
    }
  });

  it("journals no missing file in a pass a directory went away from while it was walked", async () => {
    harness = await folderHarness("folder-vanished-mid-walk");
    scriptFolderWrites(harness);
    put(harness, "sub/inside.md", "---\ntitle: Inside\n---\nbody\n");
    put(harness, "other.md", "---\ntitle: Other\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    rmSync(join(harness.dir, "other.md"));
    const scanned = await withFault("vanish-while-walking=sub", () =>
      harness!.folder.scan(),
    );
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.directories.map((dir) => [dir.path, dir.flag]),
    ).toEqual([["sub", "gone"]]);
    expect(
      scanned.value.missing,
      "a pass a directory went away from journaled files as deleted",
    ).toBe(0);
    renameSync(join(harness.dir, "sub.vanished"), join(harness.dir, "sub"));
    // The witness: walked whole, the next pass journals the file deleted.
    const next = await harness.folder.scan();
    expect(next.ok && [next.value.missing, next.value.directories]).toEqual([
      1,
      [],
    ]);
  });

  it("holds the files of a directory whose entries cannot be read", async () => {
    harness = await folderHarness("folder-entries-unreadable");
    scriptFolderWrites(harness);
    put(harness, "locked/inside.md", "---\ntitle: Inside\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const locked = join(harness.dir, "locked");
    // Listed, but no entry's details can be read.
    chmodSync(locked, 0o444);
    try {
      const scanned = await harness.folder.scan();
      expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
      if (!scanned.ok) return;
      expect(
        [scanned.value.missing, scanned.value.unreached],
        "a file whose details could not be read was journaled as deleted",
      ).toEqual([0, 1]);
      expect(
        scanned.value.directories.map((dir) => [dir.path, dir.flag]),
      ).toEqual([["locked", "unreadable"]]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("leaves a file it would take away or rewrite where the person saved it meanwhile", async () => {
    const going = {
      id: "01a00000-0000-7000-8000-00000000fa91",
      version: 1,
      properties: { title: "Going", body: "body\n" },
    };
    const kept = "01a00000-0000-7000-8000-00000000fa92";
    harness = await folderHarness("folder-last-look", {
      settings: { search: { types: ["core.note"], state: ["active"] } },
      rows: {
        "core.note": [
          { item: going },
          {
            item: {
              id: kept,
              version: 1,
              properties: { title: "Kept", body: "as it was\n" },
            },
          },
        ],
      },
      events: [
        copyReplay("3", [
          copyItemEvent(
            "2",
            "item.state_changed",
            wireItem({ ...going, state: "archived" }),
          ),
          copyItemEvent(
            "3",
            "item.updated",
            wireItem({
              id: kept,
              version: 2,
              properties: { title: "Kept", body: "changed elsewhere\n" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(2);
    const pulled = await withFault("save-before-last-look", () =>
      harness!.folder.pull(),
    );
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      [pulled.value.removed, pulled.value.kept, pulled.value.unwritten],
      "a pull took away or wrote over a file the person saved after it chose to",
    ).toEqual([0, 1, 1]);
    expect(read(harness, "Going.md")).toContain("saved meanwhile");
    expect(read(harness, "Kept.md")).toContain("saved meanwhile");
    expect(read(harness, "Kept.md")).not.toContain("changed elsewhere");
  });
});
