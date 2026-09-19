import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  itemEvent,
  replay,
  wireItem,
} from "../../device/marfa-answers.js";
import { folderHarness, scriptWrites } from "./harness.js";
import type { FolderHarness } from "./harness.js";
/**
 * "A folder is a view on a slice."
 *
 * Three of the rules below are refusals and the rest are identities, and each
 * exists because its absence is silent. A create that carries no version
 * replaces newer server content and reports success. Two identity rules on
 * the two push paths turn one file into two items depending on when it
 * appeared. A natural key that differs per credential does the same across two
 * machines. None of the three raises anything anywhere, which is why each is
 * written as a rule the folder either keeps or refuses to act.
 */

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await second?.stop();
  harness = undefined;
  second = undefined;
});

/** A file in the folder. */
function put(harness: FolderHarness, name: string, text: string): string {
  const path = join(harness.dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function read(harness: FolderHarness, name: string): string {
  return readFileSync(join(harness.dir, name), "utf8");
}

/** Answers for every door a folder's drain can reach. */
function scriptFolderWrites(
  harness: FolderHarness,
  rows: Array<Record<string, unknown>> = [],
): void {
  let next = 0;
  scriptWrites(harness.server, {
    create: [
      (request) => {
        const sent = JSON.parse(request.body) as {
          id: string;
          properties: Record<string, unknown>;
          source_id?: string;
        };
        const canned = rows[next];
        next += 1;
        return answers.created(
          wireItem({
            id: sent.id,
            version: 1,
            properties: sent.properties,
            source_id: sent.source_id ?? null,
            ...(canned ?? {}),
          }),
        );
      },
    ],
    update: [
      (request) => {
        const sent = JSON.parse(request.body) as {
          properties: Record<string, unknown>;
          version: number;
        };
        const id = request.pathname.split("/").at(-1) ?? "unknown";
        return answers.updated(
          wireItem({
            id,
            version: sent.version + 1,
            properties: sent.properties,
          }),
        );
      },
    ],
    // A delete, a tag and an edge all answer plainly: what a folder does with
    // those verdicts is the queue's business and is asserted there.
    tags: [{ kind: "json", status: 200, body: {} }],
    extensions: [{ kind: "json", status: 200, body: {} }],
    edges: [{ kind: "json", status: 201, body: {} }],
  });
  harness.server.answer("DELETE", /^\/items\/[^/]+$/, {
    kind: "json",
    status: 204,
    body: {},
  });
}

/** What the folder sent to the items door, parsed. */
function sentCreates(harness: FolderHarness): Array<Record<string, unknown>> {
  return harness.server.requests
    .filter(
      (request) => request.method === "POST" && request.pathname === "/items",
    )
    .map((request) => JSON.parse(request.body) as Record<string, unknown>);
}

/** The natural keys the folder sent, in order. */
function sentKeys(harness: FolderHarness): string[] {
  return sentCreates(harness).map((sent) => String(sent.source_id ?? ""));
}

describe("what a folder is", () => {
  it("is a view on a slice with defaults for a new file", async () => {
    harness = await folderHarness("folder-slice", {
      slice: {
        types: ["core.note", "core.bookmark"],
        tier: "library",
        defaultType: "core.bookmark",
        defaults: { language: "en" },
        tags: ["inbox"],
      },
    });
    scriptFolderWrites(harness);
    put(harness, "new.md", "---\ntitle: A new file\n---\nbody\n");
    const pushed = await harness.folder.push();
    expect(
      pushed.ok,
      `the folder could not push: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    if (!pushed.ok) return;

    const [sent] = sentCreates(harness);
    expect(
      sent?.type,
      "a new file did not become the type the folder says a new file becomes, so every file it makes falls outside its own slice",
    ).toBe("core.bookmark");
    expect(
      (sent?.properties as Record<string, unknown>).language,
      "the folder's defaults did not reach the item, so a type that requires a property a file cannot carry can never be created from a folder",
    ).toBe("en");
    expect(
      sent?.tier,
      "the item went at a tier other than the folder's, so a folder on a phone would pull a library",
    ).toBe("library");

    // The tags are their own writes, so they are not in the create's body.
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value
        .filter((row) => row.kind === "add_tag")
        .map((row) => row.tag),
      "the folder's tag did not reach the item, so the slice this folder is a view on is narrower than what it writes into it",
    ).toEqual(["inbox"]);
  });

  it("keeps each folder's state and queue to itself", async () => {
    harness = await folderHarness("folder-one", {
      slice: { types: ["core.note"], defaultType: "core.note" },
    });
    second = await folderHarness("folder-two", {
      slice: { types: ["core.bookmark"], defaultType: "core.bookmark" },
    });
    scriptFolderWrites(harness);
    scriptFolderWrites(second);

    put(harness, "first.md", "---\ntitle: First\n---\nin folder one\n");
    put(second, "second.md", "---\ntitle: Second\n---\nin folder two\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect((await second.folder.push()).ok).toBe(true);

    const one = await harness.folder.device().queue();
    const two = await second.folder.device().queue();
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(
      one.value.length,
      "one folder's queue holds the other's writes, so a push in one sends what was written in the other",
    ).toBe(1);
    expect(two.value.length).toBe(1);
    expect(
      one.value[0]?.id === two.value[0]?.id,
      "the two folders share a queue row, so they are one device with two faces rather than two devices",
    ).toBe(false);

    // And each folder's slice is its own: the types differ, so the item each
    // created is of the type its own folder declares.
    const [firstSent] = sentCreates(harness);
    const [secondSent] = sentCreates(second);
    expect(firstSent?.type).toBe("core.note");
    expect(
      secondSent?.type,
      "the second folder wrote the first folder's type, so a machine's folders share a slice rather than each being a view on its own",
    ).toBe("core.bookmark");
  });

  it("hydrates into an empty directory and pushes without holding anything else", async () => {
    // A folder in a container: nothing about it depends on the directory
    // outliving the work, so it starts empty and everything it needs is made.
    harness = await folderHarness("folder-container", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              properties: { title: "From the server", body: "pulled\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);

    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.written,
      "the folder hydrated into an empty directory and wrote nothing, so the container has the slice and no files",
    ).toBe(1);

    put(
      harness,
      "made-here.md",
      "---\ntitle: Made here\n---\nwritten in the container\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.drain.sent,
      "the folder queued the work and sent none of it, so discarding the container would lose it",
    ).toBeGreaterThan(0);

    // Discarded. Nothing outside the directory held anything.
    rmSync(harness.dir, { recursive: true, force: true });
    expect(
      (await harness.folder.scan()).ok,
      "the folder still answers after its directory was discarded, so something about it lives outside the directory",
    ).toBe(false);
  });
});

describe("files and items", () => {
  it("makes a file an item and an item a file", async () => {
    harness = await folderHarness("folder-both-ways", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              source_id: "from-server.md",
              properties: { title: "From the server", body: "pulled\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);

    // An item in the slice is a file in the folder.
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      read(harness, "from-server.md"),
      "an item in the slice did not become a file, so half the folder is a one-way street",
    ).toContain("pulled");

    // A file in the folder is an item on the server.
    put(harness, "from-here.md", "---\ntitle: From here\n---\npushed\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    const [sent] = sentCreates(harness);
    expect(
      (sent?.properties as Record<string, string>).body,
      "a file in the folder did not become an item, so nothing written on this machine reaches the server",
    ).toBe("pushed\n");
    expect(
      sent?.source_id,
      "the item carries no natural key, so the same file on a second machine is a second item",
    ).toBe("from-here.md");
  });

  it("carries frontmatter to properties and the body to the body", async () => {
    harness = await folderHarness("folder-frontmatter");
    scriptFolderWrites(harness);
    put(
      harness,
      "note.md",
      "---\ntitle: A note\ncount: 3\nundeclared_field: kept\nnested:\n  deep: true\n---\nThe body.\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const [sent] = sentCreates(harness);
    const properties = sent?.properties as Record<string, unknown>;
    expect(properties.title).toBe("A note");
    expect(properties.count).toBe(3);
    expect(
      properties.undeclared_field,
      "a property the type does not declare was dropped on the way in, so a file's fields survive only if the type happened to name them",
    ).toBe("kept");
    expect(
      properties.nested,
      "a nested field was flattened or dropped, and a file's fields travel whole or not at all",
    ).toEqual({ deep: true });
    expect(
      properties.body,
      "the body did not arrive as the body, so the text of every note is somewhere other than where a reader looks for it",
    ).toBe("The body.\n");
  });

  it("treats a body opening with a horizontal rule as a body", async () => {
    harness = await folderHarness("folder-rule");
    scriptFolderWrites(harness);
    // Two horizontal rules, which look exactly like a fence pair. Read as
    // frontmatter, the first paragraph is gone and the loss is written back.
    const text = "---\n\nA paragraph after a rule.\n\n---\n\nAnother.\n";
    put(harness, "rule.md", text);
    expect((await harness.folder.push()).ok).toBe(true);

    const [sent] = sentCreates(harness);
    const properties = sent?.properties as Record<string, unknown>;
    expect(
      properties.body,
      "a body opening with a horizontal rule was read as frontmatter, so its first paragraph is gone and the loss has been written to the server",
    ).toBe(text);
    expect(
      Object.keys(properties).filter(
        (key) => key !== "body" && key !== "title",
      ),
      "the rule yielded properties, which means part of the body became fields",
    ).toEqual([]);

    // And it comes back out as itself, so the next scan does not push a
    // change nobody made.
    expect((await harness.folder.pull()).ok).toBe(true);
    const again = await harness.folder.scan();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      again.value.updated,
      "the file changed under the folder's own hand, so every pass pushes a change nobody made",
    ).toBe(0);
  });

  it("carries links to edges and edges to links", async () => {
    harness = await folderHarness("folder-links");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    // Scanned first, so the link below names a file the folder already holds.
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const edges = queued.value.filter((row) => row.kind === "create_edge");
    expect(
      edges.length,
      "a link in the body did not become an edge, so the connections a folder's notes carry exist only as text",
    ).toBe(1);

    const bound = queued.value.find(
      (row) =>
        row.kind === "create_item" && row.item_id === edges[0]?.target_id,
    );
    expect(
      bound,
      "the edge points at something this folder did not create, so the link resolved to the wrong item",
    ).toBeDefined();

    // And the other direction: an edge on an item appears as a link in the
    // file. The body already carries this one, so what is asserted is that
    // writing back does not lose it.
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      read(harness, "source.md"),
      "the link went from the file when the item was written back, so an edge a folder made disappears from the note that made it",
    ).toContain("[[target]]");
  });
});

describe("identity", () => {
  it("follows a rename by device, inode and birth time", async () => {
    harness = await folderHarness("folder-rename");
    scriptFolderWrites(harness);
    put(harness, "before.md", "---\ntitle: Before\n---\nsame bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const before = await harness.folder.device().queue();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const item = before.value.find(
      (row) => row.kind === "create_item",
    )?.item_id;
    expect(item).toBeDefined();

    // A rename keeps the inode and the birth time, so it is the same file.
    renameSync(join(harness.dir, "before.md"), join(harness.dir, "after.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.renamed,
      "a renamed file was not followed, so the note is now two items and the old one is about to be deleted",
    ).toBe(1);
    expect(
      scanned.value.created,
      "the renamed file became a second item, which is the duplication this rule exists to stop",
    ).toBe(0);

    const after = await harness.folder.device().queue();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.filter((row) => row.kind === "create_item").length,
      "a second create was queued for a file that only moved",
    ).toBe(1);
    // And the delete the old path would have journaled is not a delete.
    expect(
      after.value.some((row) => row.kind === "delete_item"),
      "the folder queued a delete for the path the file moved off, so a rename removes the item it renamed",
    ).toBe(false);
  });

  it("treats a file with no usable identity as new rather than guessing", async () => {
    harness = await folderHarness("folder-no-identity");
    scriptFolderWrites(harness);
    put(harness, "first.md", "---\ntitle: First\n---\none\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The first file is gone and a different file takes its place. The
    // filesystem may hand the new one the old one's inode, and the birth
    // time is the only thing that says they are not the same file.
    rmSync(join(harness.dir, "first.md"));
    put(harness, "second.md", "---\ntitle: Second\n---\ntwo\n");
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "a file that is not the one the folder remembers was bound to its item, so one note's contents were written over another's and nothing reports it",
    ).toBe(1);
    expect(scanned.value.renamed).toBe(0);

    // Two files that share an identity yield none for either. A hard link
    // is the same inode, the same device and the same birth time on two
    // paths, so neither can be said to be the file the folder remembers.
    put(harness, "original.md", "---\ntitle: Original\n---\nlinked\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    const before = (await harness.folder.device().queue()).ok
      ? ((await harness.folder.device().queue()) as { value: unknown[] }).value
          .length
      : 0;
    linkSync(join(harness.dir, "original.md"), join(harness.dir, "hard.md"));
    renameSync(join(harness.dir, "original.md"), join(harness.dir, "moved.md"));
    const shared = await harness.folder.scan();
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(
      shared.value.renamed,
      "a file whose identity two paths share was followed as a rename, and the folder cannot know which of the two is the one it remembers",
    ).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it("binds the same file to the same item whether it was present at start or arrived while running", async () => {
    // Two folders, the same bytes at the same path. One has the file before
    // it ever scans; the other gets it after a scan that found nothing. Two
    // identity rules would make these two different items.
    const text = "---\ntitle: Same bytes\n---\nidentical\n";
    harness = await folderHarness("folder-at-start");
    second = await folderHarness("folder-while-running");
    scriptFolderWrites(harness);
    scriptFolderWrites(second);

    put(harness, "note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);

    // The other folder scans an empty directory first, which is the state a
    // watcher starts in, and the file arrives after.
    const empty = await second.folder.scan();
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value.created).toBe(0);
    put(second, "note.md", text);
    expect((await second.folder.push()).ok).toBe(true);

    const atStart = sentKeys(harness);
    const whileRunning = sentKeys(second);
    expect(
      atStart,
      "the file present at start reached a different natural key than the same file arriving later, so one file is two items depending on when it appeared",
    ).toEqual(whileRunning);
    expect(atStart.length).toBe(1);
  });

  it("binds one file to one item across two separately enrolled devices", async () => {
    // The same file in the same place on two machines, each with its own
    // credential. The natural key is the path and nothing about the machine,
    // so both name one item.
    const text = "---\ntitle: Shared\n---\nthe same file\n";
    harness = await folderHarness("folder-machine-one");
    second = await folderHarness("folder-machine-two");
    scriptFolderWrites(harness);
    scriptFolderWrites(second);
    put(harness, "shared/note.md", text);
    put(second, "shared/note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);
    expect((await second.folder.push()).ok).toBe(true);

    expect(
      sentKeys(harness),
      "the two machines gave the same file two different natural keys, so it is two items and neither machine can say why",
    ).toEqual(sentKeys(second));
    expect(
      sentKeys(harness)[0],
      "the natural key carries something about the machine, which is what makes every file two items",
    ).toBe("shared/note.md");
  });

  it("keeps the item id in the file as a record, and does not depend on it for identity", async () => {
    harness = await folderHarness("folder-id-record");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Recorded\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const written = read(harness, "note.md");
    expect(
      written,
      "the folder did not write the item's id into the file, so nothing in the file says which item it is",
    ).toMatch(/marfa_id:\s*\S+/);

    // A file that has lost the record is still the same item, because the
    // natural key matches. The record is the folder's, not the key.
    writeFileSync(
      join(harness.dir, "note.md"),
      "---\ntitle: Recorded\n---\nedited without the record\n",
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "a file that lost the id record became a second item, so the record is standing in for the natural key and a person deleting a line creates a duplicate",
    ).toBe(0);
    expect(scanned.value.updated).toBe(1);

    // And one naming an item the server does not hold is treated as having
    // none: the key still decides.
    put(
      harness,
      "invented.md",
      "---\nmarfa_id: 01a00000-0000-7000-8000-0000000000ff\ntitle: Invented\n---\nbody\n",
    );
    const invented = await harness.folder.scan();
    expect(invented.ok).toBe(true);
    if (!invented.ok) return;
    expect(
      invented.value.created,
      "a file carrying an id the server does not hold was bound to it, so anybody can bind a file to an item by typing its id",
    ).toBe(1);
  });

  it("moves the file when the item is renamed on the server", async () => {
    harness = await folderHarness("folder-server-rename", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              source_id: "old-name.md",
              properties: { title: "Old name", body: "body\n" },
            },
          },
        ],
      },
      // The server moves it: the natural key is the path, so a key that
      // changed is a rename. Scripted before the hydration, because an
      // answer appended after it queues behind the head read.
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id: "01a00000-0000-7000-8000-00000000000a",
              version: 2,
              source_id: "new-name.md",
              properties: { title: "New name", body: "body\n" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(read(harness, "old-name.md")).toContain("body");

    const caught = await harness.folder.device().catchUp();
    expect(caught.ok, `catch-up: ${JSON.stringify(caught)}`).toBe(true);
    // The control: the event reached the copy. Without it, a pull that moved
    // nothing would be read as a folder that ignores a rename when it is a
    // catch-up that applied nothing.
    expect(
      caught.ok ? caught.value.applied : 0,
      `the rename event was not applied, so nothing below is about the folder: ${JSON.stringify(caught)}`,
    ).toBe(1);
    const held = await harness.folder
      .device()
      .get("01a00000-0000-7000-8000-00000000000a");
    expect(
      held.ok ? held.value.source_id : null,
      `the copy did not take the new natural key: ${JSON.stringify(held)}`,
    ).toBe("new-name.md");
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.moved,
      "the item was renamed on the server and the file did not move, so the folder holds it under a name nothing agrees with",
    ).toBe(1);
    expect(read(harness, "new-name.md")).toContain("body");
    expect(
      existsSync(join(harness.dir, "old-name.md")),
      "the file is under both names, so the next scan makes a second item from the one left behind",
    ).toBe(false);

    // And the next scan does not re-assert the old name.
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      [scanned.value.created, scanned.value.updated, scanned.value.missing],
      "the scan after a server rename pushed something, so the folder and the server disagree and each keeps correcting the other",
    ).toEqual([0, 0, 0]);
  });
});

describe("writing", () => {
  it("refuses a create that carries no version", async () => {
    harness = await folderHarness("folder-create-version");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Conditional\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const [sent] = sentCreates(harness);
    expect(
      "version" in (sent ?? {}),
      "the folder's create carried no version, so a create landing on an existing row is an update that read nothing — which is how a stale second machine overwrites newer content with nothing reporting it",
    ).toBe(true);
    expect(
      sent?.version,
      "the create carries a version this folder never read, which is a version the device minted",
    ).toBe(0);
  });

  it("does not overwrite newer server content from a stale folder", async () => {
    harness = await folderHarness("folder-stale");
    // The create is conditional, so the server refuses it where the natural
    // key names a row that has moved on. A folder that sent no version would
    // have been taken, and the newer content replaced.
    scriptWrites(harness.server, {
      create: [
        {
          kind: "json",
          status: 409,
          body: {
            error: {
              code: "version_conflict",
              status: 409,
              message: "the row moved under this write",
            },
          },
        },
      ],
      read: [
        answers.updated(
          wireItem({
            id: "01a00000-0000-7000-8000-00000000000a",
            version: 9,
            properties: { title: "Newer", body: "what the server holds\n" },
          }),
        ),
      ],
    });
    put(
      harness,
      "stale.md",
      "---\ntitle: Stale\n---\nthe stale machine's copy\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;

    expect(
      pushed.value.drain.verdicts[0]?.verdict,
      "a conditional create the server refused was taken as something the folder could act on, and the only safe answer is to stop",
    ).toBe("blocked");
    expect(
      pushed.value.drain.verdicts[0]?.reason,
      "the folder did not say why the stale write stopped",
    ).toBe("conflict_unresolved");
    // It is not sent again, and nothing of the stale copy reached the server.
    const before = sentCreates(harness).length;
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      sentCreates(harness).length,
      "the stale create went a second time, so a folder left running keeps trying to overwrite newer content",
    ).toBe(before);
  });

  it("does not read its own writes back as changes", async () => {
    harness = await folderHarness("folder-echo", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              source_id: "written.md",
              properties: { title: "Written", body: "by the folder\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);

    // The folder writes the file. The scan that follows must not read it
    // back as a change: a write the folder made never returns as one.
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(1);

    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      [scanned.value.created, scanned.value.updated],
      "the folder read its own write back as a change, so every pull queues a push and the two never settle",
    ).toEqual([0, 0]);
    expect(
      scanned.value.unchanged,
      "the file the folder wrote was not recognised at all, so the absence above is the scan seeing nothing rather than seeing its own work",
    ).toBe(1);

    // The control: a change somebody else made is not suppressed.
    writeFileSync(
      join(harness.dir, "written.md"),
      `${read(harness, "written.md")}\nedited by a person\n`,
    );
    const edited = await harness.folder.scan();
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(
      edited.value.updated,
      "a change the folder did not make was suppressed too, so echo suppression is suppressing everything",
    ).toBe(1);
  });

  it("defers a delete past the rename grace", async () => {
    harness = await folderHarness("folder-delete-grace");
    scriptFolderWrites(harness);
    put(harness, "going.md", "---\ntitle: Going\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The first half of a rename looks exactly like a delete: the old path
    // stops existing. A folder that sent a delete here would delete the item
    // it was about to rename.
    rmSync(join(harness.dir, "going.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.missing,
      "the missing file was not journaled, so nothing is watching for the other half of the rename",
    ).toBe(1);
    expect(
      scanned.value.deleted,
      "the delete went at once, so every rename removes the item it renamed",
    ).toBe(0);
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.some((row) => row.kind === "delete_item"),
      "a delete was queued inside the grace, so the queue holds it whether or not the rename completes",
    ).toBe(false);

    // The other half arrives inside the grace: it was a rename.
    put(harness, "arrived.md", "---\ntitle: Going\n---\nbody\n");
    const renamed = await harness.folder.scan();
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const after = await harness.folder.device().queue();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.some((row) => row.kind === "delete_item"),
      "the rename completed and the delete went anyway, so the grace records the delete and sends it regardless",
    ).toBe(false);
  });

  it("journals a delete that happened while it was not running", async () => {
    harness = await folderHarness("folder-delete-offline");
    scriptFolderWrites(harness);
    put(harness, "gone.md", "---\ntitle: Gone\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The file goes while nothing is watching, which for a folder that runs
    // a scan at a time is simply between two scans. It is journaled by the
    // same pass that would journal one that vanished while watching: a scan
    // does not know which it is looking at.
    rmSync(join(harness.dir, "gone.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.missing,
      "a tracked file absent at startup was not journaled, so a delete made while the folder was off is never sent and the item stays for ever",
    ).toBe(1);

    // And it becomes a delete once the grace has run. Waited for rather
    // than slept through: the grace is the folder's and a fixture that
    // guessed at it would pass on the guess.
    await vi.waitFor(
      async () => {
        const swept = await harness?.folder.scan();
        expect(swept?.ok).toBe(true);
        const queued = await harness?.folder.device().queue();
        expect(queued?.ok).toBe(true);
        expect(
          queued?.ok === true &&
            queued.value.some((row) => row.kind === "delete_item"),
          "the grace ran out and the journaled delete was never sent",
        ).toBe(true);
      },
      { timeout: 20_000, interval: 500 },
    );
  });
});

describe("what a folder does not watch", () => {
  it("excludes a dot-led directory at any depth", async () => {
    harness = await folderHarness("folder-dot-led");
    scriptFolderWrites(harness);
    put(harness, "kept.md", "---\ntitle: Kept\n---\nbody\n");
    put(harness, ".hidden/note.md", "---\ntitle: Hidden\n---\nbody\n");
    put(harness, "deep/.hidden/note.md", "---\ntitle: Deeper\n---\nbody\n");
    put(harness, "deep/kept.md", "---\ntitle: Deep kept\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    expect(
      sentKeys(harness).sort(),
      "a dot-led directory was pushed, and at depth is where it matters: an editor's own state, a version control directory, a cache — none of them is the person's content",
    ).toEqual(["deep/kept.md", "kept.md"]);
  });

  it("keeps its own state in .marfa and never pushes it", async () => {
    harness = await folderHarness("folder-state");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: A note\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    expect(
      existsSync(join(harness.dir, ".marfa", "folder.json")),
      "the folder keeps its slice somewhere other than its own directory, so the directory is not the whole of it",
    ).toBe(true);
    expect(
      existsSync(join(harness.dir, ".marfa", "core.sqlite")),
      "the folder keeps its working copy and queue somewhere other than its own directory",
    ).toBe(true);
    expect(
      sentKeys(harness),
      "the folder pushed its own state, so its mapping and its queue are items on the server",
    ).toEqual(["note.md"]);
  });

  it("leaves a file outside the slice alone", async () => {
    harness = await folderHarness("folder-outside-slice", {
      slice: { types: ["core.note"], defaultType: "core.note" },
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              source_id: "inside.md",
              properties: { title: "Inside", body: "in the slice\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    // A file the folder does not carry: not a document, so not a note.
    put(harness, "photo.png", "not text at all");
    put(harness, "inside.md", "---\ntitle: Inside\n---\nin the slice\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.skipped,
      "a file outside the folder's slice was pushed as a note, so anything dropped in the directory becomes an item of whatever type the folder defaults to",
    ).toBe(1);
    expect(
      sentKeys(harness),
      "the file outside the slice reached the server",
    ).toEqual(["inside.md"]);
    expect(
      readFileSync(join(harness.dir, "photo.png"), "utf8"),
      "the folder rewrote a file it does not carry",
    ).toBe("not text at all");
  });
});
