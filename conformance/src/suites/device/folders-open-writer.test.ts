import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  closeSync,
  openSync,
  readdirSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { copyLiveReplay } from "../../device/marfa-answers.js";
import type { PushReport } from "../../device/cli-adapter.js";
import type { FolderDoor } from "../../device/folder-door.js";
import { openBindingFolder } from "./binding-folders.shared.js";
import { folderHarness, type FolderHarness } from "./harness.js";
import {
  EdgeDoor,
  idIn,
  put,
  read,
  scriptFolderWrites,
  sentCreates,
  sentUpdates,
  withFault,
} from "./folders.shared.js";

let harness: FolderHarness | undefined;
let program: number | undefined;
afterEach(async () => {
  if (program !== undefined) closeSync(program);
  program = undefined;
  delete process.env.MARFA_TEST_FAULT;
  await harness?.stop();
  harness = undefined;
});

const id = "01a00000-0000-7000-8000-0000000000c1";

/** A folder holding `Note.md`, written by a pull at version 1. */
async function noteFolder(name: string): Promise<FolderHarness> {
  harness = await folderHarness(name, {
    items: {
      "core.note": [
        {
          item: {
            id,
            version: 1,
            properties: { title: "Note", body: "as read\n" },
          },
        },
      ],
    },
    events: [copyLiveReplay("1", [])],
  });
  scriptFolderWrites(harness);
  expect((await harness.folder.pull()).ok).toBe(true);
  expect(read(harness, "Note.md")).toContain("marfa_version: 1\n");
  return harness;
}

/** `noteFolder`, with the door another machine edits the note through. */
async function noteFolderEditedElsewhere(name: string): Promise<{
  harness: FolderHarness;
  door: () => FolderDoor;
  editElsewhere: (body: string) => void;
}> {
  const edges = new EdgeDoor();
  harness = await folderHarness(name, {
    items: {
      "core.note": [
        {
          item: {
            id,
            version: 1,
            properties: { title: "Note", body: "as read\n" },
          },
        },
      ],
    },
    events: [edges.stream()],
  });
  let door: FolderDoor | undefined;
  scriptFolderWrites(harness, { edges, door: (made) => (door = made) });
  expect((await harness.folder.pull()).ok).toBe(true);
  expect(read(harness, "Note.md")).toContain("marfa_version: 1\n");
  const editElsewhere = (body: string) => {
    const version = door!.rows.get(id)!.version;
    edges.logItem(
      "item.updated",
      door!.update(id, { properties: { body }, version }),
    );
  };
  return { harness, door: () => door!, editElsewhere };
}

/** A program that holds `Note.md` open for writing, as a log or an editor
 *  that writes in place does. */
function holdOpen(harness: FolderHarness): void {
  program = openSync(join(harness.dir, "Note.md"), "a");
}

function write(text: string): void {
  writeSync(program!, text);
}

function close(): void {
  closeSync(program!);
  program = undefined;
}

async function push(harness: FolderHarness): Promise<PushReport> {
  const pushed = await harness.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  if (!pushed.ok) throw new Error(pushed.refusal.raw);
  return pushed.value;
}

/** A push whose edit lands, so its pull would write the version line,
 *  where the device cannot tell whether a program writes the file. */
async function setAsideUnknown(harness: FolderHarness): Promise<PushReport> {
  return withFault("writers-unknown", () => push(harness));
}

/** Makes the folder's kept-file records ones it cannot read. */
function unreadRecord(harness: FolderHarness): void {
  const db = new DatabaseSync(harness.folder.store);
  try {
    db.prepare(
      "UPDATE meta SET value = json_set(value, '$.retained.since', 'soon') WHERE key LIKE 'folder_retained:%'",
    ).run();
  } finally {
    db.close();
  }
}

const keptNames = (harness: FolderHarness) =>
  readdirSync(harness.dir).filter((name) => name.startsWith(".marfa-kept-"));

const lastSentBody = (harness: FolderHarness) =>
  JSON.stringify(sentUpdates(harness).at(-1)?.body ?? {});

describe("a file a program holds open for writing", () => {
  it("leaves the file while the program holds it, and sends what the program wrote after the push", async () => {
    const harness = await noteFolder("folder-open-writer");
    holdOpen(harness);
    write("first half\n");
    const first = await push(harness);
    expect(lastSentBody(harness)).toContain("first half");
    expect(
      first.pull?.busy,
      "a pull rewrote the version line of a file a program held open",
    ).toBe(1);
    expect(first.pull?.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Note.md", "busy"],
    ]);
    expect(read(harness, "Note.md")).toContain("marfa_version: 1\n");

    write("second half\n");
    close();
    const second = await push(harness);
    expect(second.pull?.busy).toBe(0);
    const text = read(harness, "Note.md");
    expect(
      text,
      "what a program wrote through a descriptor it held across a push was lost",
    ).toContain("as read\nfirst half\nsecond half\n");
    expect(lastSentBody(harness)).toContain("second half");
    // The witness: once the program closed the file, the pull rewrote its
    // version line.
    expect(text).toContain("marfa_version: 3\n");
    expect(keptNames(harness)).toEqual([]);
  });

  it("writes the id into a new file once the program writing it closes it", async () => {
    harness = await folderHarness("folder-open-writer-id");
    scriptFolderWrites(harness);
    const text = "---\ntitle: New\n---\nwritten here\n";
    put(harness, "New.md", text);
    program = openSync(join(harness.dir, "New.md"), "a");
    const first = await push(harness);
    const [sent] = sentCreates(harness);
    expect(typeof sent?.id).toBe("string");
    expect(
      read(harness, "New.md"),
      "a pull wrote the id into a file a program held open",
    ).toBe(text);
    expect(first.pull?.busy).toBe(1);

    write("more\n");
    close();
    const second = await push(harness);
    expect(second.pull?.busy).toBe(0);
    // The witness: once the program closed the file, the pull wrote the id.
    expect(idIn(harness, "New.md")).toBe(sent?.id);
    expect(read(harness, "New.md")).toContain("written here\nmore\n");
    expect(lastSentBody(harness)).toContain("more");
  });

  it("keeps a file it set aside where it cannot tell whether a program writes to it, and puts back what the program wrote", async () => {
    const harness = await noteFolder("folder-open-writer-unknown");
    holdOpen(harness);
    write("first half\n");
    const first = await setAsideUnknown(harness);
    // The witness: where it cannot tell, the pull writes the file.
    expect(first.pull?.busy).toBe(0);
    expect(read(harness, "Note.md")).toContain("marfa_version: 2\n");
    expect(
      keptNames(harness),
      "a file a program might still write to was not kept",
    ).toHaveLength(1);

    write("second half\n");
    close();
    await push(harness);
    expect(
      read(harness, "Note.md"),
      "what a program wrote to a file set aside was not put back",
    ).toContain("first half\nsecond half\n");
    expect(lastSentBody(harness)).toContain("second half");
    // The pull moved only the version line past the device's own edit, so
    // what the program wrote goes on that edit's version.
    expect(sentUpdates(harness).at(-1)?.body.version).toBe(2);
    expect(keptNames(harness)).toEqual([]);
  });

  it("sends what a program wrote to a file it set aside as an edit of the version the file held, so another machine's edit meanwhile is kept", async () => {
    const { harness, door, editElsewhere } = await noteFolderEditedElsewhere(
      "folder-open-writer-elsewhere",
    );
    holdOpen(harness);
    editElsewhere("their edit\n");
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    const pulled = await withFault("writers-unknown", () =>
      harness.folder.pull(),
    );
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(read(harness, "Note.md")).toContain("their edit\n");
    expect(keptNames(harness)).toHaveLength(1);

    write("the program's line\n");
    close();
    await push(harness);
    expect(lastSentBody(harness)).toContain("the program's line");
    expect(
      sentUpdates(harness).at(-1)?.body.version,
      "what a program wrote over version 1 was sent as an edit of version 2, replacing the other machine's edit",
    ).toBe(1);
    const bodies = [
      door().rows.get(id)?.properties.body,
      ...door()
        .conflictedCopies()
        .map(([, copy]) => copy.properties.body),
    ];
    expect(bodies, "the two edits were not kept apart").toEqual(
      expect.arrayContaining(["their edit\n", "as read\nthe program's line\n"]),
    );
    expect(bodies).toHaveLength(2);
    expect(keptNames(harness)).toEqual([]);
  });

  it("keeps what a program wrote to a file it set aside beside the path, where a person saved over the path meanwhile", async () => {
    const harness = await noteFolder("folder-open-writer-beside");
    holdOpen(harness);
    write("first half\n");
    await setAsideUnknown(harness);
    expect(keptNames(harness)).toHaveLength(1);

    write("second half\n");
    close();
    const saved = read(harness, "Note.md").replace(
      "first half\n",
      "first half\nsaved by the person\n",
    );
    put(harness, "Note.md", saved);
    await push(harness);
    expect(
      read(harness, "Note.md"),
      "the person's save at the path was replaced by the kept file",
    ).toContain("saved by the person\n");
    expect(
      read(harness, "Note (2).md"),
      "what a program wrote to a file set aside was not kept beside the path",
    ).toContain("first half\nsecond half\n");
    expect(keptNames(harness)).toEqual([]);
  });

  it("keeps a file it set aside while a program holds it open, and deletes it once the program closes it unchanged", async () => {
    const harness = await noteFolder("folder-open-writer-held");
    holdOpen(harness);
    write("first half\n");
    await setAsideUnknown(harness);
    expect(keptNames(harness)).toHaveLength(1);

    await push(harness);
    expect(
      keptNames(harness),
      "a file set aside was deleted while a program held it open",
    ).toHaveLength(1);
    const kept = await harness.folder.kept();
    expect(kept.ok && kept.value.kept.map((file) => file.writers)).toEqual([
      "open",
    ]);

    close();
    await push(harness);
    expect(
      keptNames(harness),
      "a file set aside was kept after the program closed it unchanged",
    ).toEqual([]);
    expect(read(harness, "Note.md")).toContain("as read\nfirst half\n");
  });

  it("keeps a file it set aside whose mode and times alone changed as unchanged, and deletes it once no program holds it", async () => {
    const harness = await noteFolder("folder-open-writer-metadata");
    holdOpen(harness);
    write("first half\n");
    close();
    await setAsideUnknown(harness);
    const [name] = keptNames(harness);
    expect(name).toBeDefined();
    const kept = join(harness.dir, name!);
    chmodSync(kept, 0o640);
    utimesSync(kept, new Date(1000), new Date(1000));
    const sent = sentUpdates(harness).length;

    await setAsideUnknown(harness);
    expect(
      keptNames(harness),
      "a kept file whose metadata alone changed was put back as a write",
    ).toEqual([name]);
    expect(sentUpdates(harness)).toHaveLength(sent);
    expect(read(harness, "Note.md")).toContain("marfa_version: 2\n");

    await push(harness);
    expect(keptNames(harness)).toEqual([]);
    expect(
      readdirSync(harness.dir).filter((file) => file.endsWith(".md")),
    ).toEqual(["Note.md"]);
    expect(read(harness, "Note.md")).toContain("marfa_version: 2\n");
  });

  it("deletes a file it set aside unchanged a week after it could not tell whether a program writes to it", async () => {
    const harness = await noteFolder("folder-open-writer-week");
    holdOpen(harness);
    write("first half\n");
    close();
    await setAsideUnknown(harness);
    expect(keptNames(harness)).toHaveLength(1);
    // The witness: a pass that still cannot tell keeps it.
    await setAsideUnknown(harness);
    expect(keptNames(harness)).toHaveLength(1);

    const db = new DatabaseSync(harness.folder.store);
    try {
      const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60 - 60;
      db.prepare(
        "UPDATE meta SET value = json_set(value, '$.retained.since', CAST(? AS INTEGER)) WHERE key LIKE 'folder_retained:%'",
      ).run(weekAgo);
    } finally {
      db.close();
    }
    await setAsideUnknown(harness);
    expect(
      keptNames(harness),
      "a file set aside unchanged was kept past a week",
    ).toEqual([]);
  });

  it("lists a file it keeps for a program that might still write to it, and deletes it when the owner discards it", async () => {
    const harness = await noteFolder("folder-open-writer-discard");
    holdOpen(harness);
    write("first half\n");
    await setAsideUnknown(harness);
    const [name] = keptNames(harness);
    expect(name).toBeDefined();

    const kept = await harness.folder.kept();
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.kept).toEqual([
      expect.objectContaining({
        path: name,
        from: "Note.md",
        writers: "unknown",
        until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    ]);
    const status = await harness.folder.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    const listed = status.value.files.filter((file) => file.path === name);
    expect(listed.map((file) => [file.status, file.flag])).toEqual([
      ["held", "kept"],
    ]);
    expect(listed[0]?.reason).toContain("cannot tell whether a program");

    const discarded = await harness.folder.discardKept();
    expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
    if (!discarded.ok) return;
    expect(discarded.value.discarded).toEqual([name]);
    expect(discarded.value.kept).toEqual([]);
    expect(keptNames(harness)).toEqual([]);
    expect(read(harness, "Note.md")).toContain("marfa_version: 2\n");
  });

  it("lists a file it keeps under a record it cannot read, and deletes it when the owner discards it", async () => {
    const harness = await noteFolder("folder-open-writer-unread");
    holdOpen(harness);
    write("first half\n");
    close();
    await setAsideUnknown(harness);
    const [name] = keptNames(harness);
    expect(name).toBeDefined();
    const db = new DatabaseSync(harness.folder.store);
    try {
      db.prepare(
        "UPDATE meta SET value = json_set(value, '$.retained.since', 'soon') WHERE key LIKE 'folder_retained:%'",
      ).run();
    } finally {
      db.close();
    }

    await push(harness);
    expect(keptNames(harness)).toEqual([name]);
    const kept = await harness.folder.kept();
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    if (!kept.ok) return;
    expect(
      kept.value.kept,
      "a kept file whose record does not read was not listed",
    ).toEqual([
      expect.objectContaining({
        path: name,
        from: "Note.md",
        reason: "Marfa could not read its record",
      }),
    ]);

    const discarded = await harness.folder.discardKept();
    expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
    if (!discarded.ok) return;
    expect(discarded.value.discarded).toEqual([name]);
    expect(discarded.value.kept).toEqual([]);
    expect(keptNames(harness)).toEqual([]);
    expect(read(harness, "Note.md")).toContain("marfa_version: 2\n");
  });

  it("keeps a file it keeps under a record it cannot read when a program wrote to it, though the owner discards", async () => {
    const harness = await noteFolder("folder-open-writer-unread-written");
    holdOpen(harness);
    write("first half\n");
    await setAsideUnknown(harness);
    const [name] = keptNames(harness);
    expect(name).toBeDefined();
    write("second half\n");
    close();
    const db = new DatabaseSync(harness.folder.store);
    try {
      db.prepare(
        "UPDATE meta SET value = json_set(value, '$.retained.since', 'soon') WHERE key LIKE 'folder_retained:%'",
      ).run();
    } finally {
      db.close();
    }

    const discarded = await harness.folder.discardKept();
    expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
    if (!discarded.ok) return;
    expect(
      discarded.value.discarded,
      "a discard deleted a kept file a program wrote to, whose record does not read",
    ).toEqual([]);
    expect(keptNames(harness)).toEqual([name]);
    const kept = await harness.folder.kept();
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.kept).toEqual([
      expect.objectContaining({
        path: name,
        reason: "Marfa could not read its record",
      }),
    ]);
  });

  it("puts back a file it kept that a program wrote to, when the owner discards the files it keeps", async () => {
    const harness = await noteFolder("folder-open-writer-discard-changed");
    holdOpen(harness);
    write("first half\n");
    await setAsideUnknown(harness);
    expect(keptNames(harness)).toHaveLength(1);
    write("second half\n");

    const discarded = await harness.folder.discardKept();
    expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
    if (!discarded.ok) return;
    expect(
      [discarded.value.discarded, discarded.value.put_back.length],
      "a discard deleted a kept file a program wrote to",
    ).toEqual([[], 1]);
    expect(keptNames(harness)).toEqual([]);
    expect(read(harness, "Note.md")).toContain("first half\nsecond half\n");
  });

  it.each(["reads", "does not read"] as const)(
    "never deletes a kept file a program writes to as the owner discards it, where its record %s",
    async (record) => {
      const harness = await noteFolder(
        `folder-open-writer-discard-meanwhile-${record === "reads" ? "read" : "unread"}`,
      );
      holdOpen(harness);
      write("first half\n");
      close();
      await setAsideUnknown(harness);
      const [name] = keptNames(harness);
      expect(name).toBeDefined();
      if (record === "does not read") unreadRecord(harness);
      const before = read(harness, name!);

      const discarded = await withFault(`write-before-discard=${name!}`, () =>
        harness.folder.discardKept(),
      );
      expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
      if (!discarded.ok) return;
      expect(
        discarded.value.discarded,
        "the discard deleted what a program wrote once the discard had looked",
      ).toEqual([]);
      const written = `${before}written before the discard\n`;
      if (record === "reads") {
        expect(discarded.value.put_back).toEqual(["Note.md"]);
        expect(keptNames(harness)).toEqual([]);
        expect(read(harness, "Note.md")).toBe(written);
      } else {
        expect(keptNames(harness)).toEqual([name]);
        expect(read(harness, name!)).toBe(written);
        expect(discarded.value.kept.map((file) => file.path)).toEqual([name]);
      }
    },
  );

  it.each(["unchanged", "written to"] as const)(
    "lists through a binding a file a folder keeps, and discards it %s as folders kept does",
    async (state) => {
      const harness = await noteFolder(
        `binding-kept-${state === "unchanged" ? "unchanged" : "written"}`,
      );
      holdOpen(harness);
      write("first half\n");
      await setAsideUnknown(harness);
      const [name] = keptNames(harness);
      expect(name).toBeDefined();
      if (state === "written to") write("second half\n");
      const bound = await openBindingFolder(harness);
      try {
        const kept = await bound.bound.kept();
        expect(kept.ok, JSON.stringify(kept)).toBe(true);
        if (!kept.ok) return;
        expect(kept.value).toEqual([
          expect.objectContaining({
            path: name,
            from: "Note.md",
            writers: "unknown",
            until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          }),
        ]);

        const discarded = await bound.bound.discardKept();
        expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
        if (!discarded.ok) return;
        expect(discarded.value.kept).toEqual([]);
        expect(keptNames(harness)).toEqual([]);
        if (state === "unchanged") {
          expect(discarded.value.discarded).toEqual([name]);
          expect(discarded.value.putBack).toEqual([]);
          expect(read(harness, "Note.md")).toContain("marfa_version: 2\n");
        } else {
          expect(
            discarded.value.discarded,
            "a discard through a binding deleted a kept file a program wrote to",
          ).toEqual([]);
          expect(discarded.value.putBack).toEqual(["Note.md"]);
          expect(read(harness, "Note.md")).toContain(
            "first half\nsecond half\n",
          );
        }
      } finally {
        await bound.device.close();
      }
    },
  );

  it.each(["unchanged", "written to"] as const)(
    "lists through a binding a file kept under a record it cannot read, and discards it only %s as set aside",
    async (state) => {
      const harness = await noteFolder(
        `binding-kept-unread-${state === "unchanged" ? "unchanged" : "written"}`,
      );
      holdOpen(harness);
      write("first half\n");
      await setAsideUnknown(harness);
      const [name] = keptNames(harness);
      expect(name).toBeDefined();
      if (state === "written to") write("second half\n");
      close();
      unreadRecord(harness);
      const bound = await openBindingFolder(harness);
      try {
        const kept = await bound.bound.kept();
        expect(kept.ok, JSON.stringify(kept)).toBe(true);
        if (!kept.ok) return;
        expect(kept.value).toEqual([
          expect.objectContaining({
            path: name,
            from: "Note.md",
            reason: "Marfa could not read its record",
          }),
        ]);

        const discarded = await bound.bound.discardKept();
        expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
        if (!discarded.ok) return;
        if (state === "unchanged") {
          expect(discarded.value.discarded).toEqual([name]);
          expect(discarded.value.kept).toEqual([]);
          expect(keptNames(harness)).toEqual([]);
        } else {
          expect(
            discarded.value.discarded,
            "a discard through a binding deleted a kept file a program wrote to, whose record does not read",
          ).toEqual([]);
          expect(discarded.value.kept.map((file) => file.path)).toEqual([name]);
          expect(keptNames(harness)).toEqual([name]);
        }
      } finally {
        await bound.device.close();
      }
    },
  );
});
