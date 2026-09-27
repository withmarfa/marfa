import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  catchupTooOld,
  connected,
  headRead,
  itemEvent,
  liveReplay,
  streamCursor,
  refusal,
  replay,
  wireItem,
} from "../../device/marfa-answers.js";
import {
  acceptUploads,
  folderHarness,
  hashOf,
  scriptBlob,
  scriptWrites,
} from "./harness.js";
import {
  CONFLICTED_COPY_TAG,
  FolderDoor,
  type DoorCreate,
  type DoorRow,
} from "../../device/folder-door.js";
import type { FolderHarness } from "./harness.js";
import type { Answer, Responder } from "../../device/scripted-server.js";
/**
 * "A folder is a view on a slice."
 *
 * Most of the rules below exist because their absence is silent: a file bound
 * to the wrong item has one note written over another, and nothing anywhere
 * says so. So each is written as a rule the folder either keeps or refuses to
 * act on.
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

/** The `marfa_id` a file's frontmatter carries, if any. */
function idIn(harness: FolderHarness, name: string): string | undefined {
  return /marfa_id:\s*(\S+)/.exec(read(harness, name))?.[1];
}

/** Replaces a file as an editor's atomic save does: the bytes are written
 *  beside it and renamed over it, so the path holds a new inode with a new
 *  birth time. */
function saveAtomically(
  harness: FolderHarness,
  name: string,
  text: string | Buffer,
): void {
  const beside = join(harness.dir, `.saving-${name.replaceAll("/", "-")}`);
  writeFileSync(beside, text);
  renameSync(beside, join(harness.dir, name));
}

/**
 * Answers for every door a folder's drain can reach, the item doors deciding
 * as the real server does (`FolderDoor`, which `fidelity.test.ts` holds to the
 * server's decisions).
 *
 * Returns what the door holds for each item, so a fixture can ask what each
 * ended up holding rather than only what was sent.
 */
function scriptFolderWrites(
  harness: FolderHarness,
  options: {
    /** Handed the door, for a fixture that has another machine write. */
    door?: (door: FolderDoor) => void;
  } = {},
): Map<string, DoorRow> {
  // What the hydration served, so a write to one of those rows is answered
  // with what the real server keeps rather than a default.
  const door = new FolderDoor(
    Object.values(harness.rows)
      .flat()
      .map((row): [string, DoorRow] => {
        const item = wireItem(row.item);
        return [
          row.item.id,
          {
            properties: item.properties as Record<string, unknown>,
            type: String(item.type),
            source: String(item.source),
            source_id:
              typeof item.source_id === "string" ? item.source_id : null,
            version: Number(item.version),
          },
        ];
      }),
  );
  options.door?.(door);
  scriptWrites(harness.server, {
    create: [
      (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
    ],
    update: [
      (request) =>
        door.update(
          request.pathname.split("/").at(-1) ?? "unknown",
          JSON.parse(request.body) as {
            properties?: Record<string, unknown>;
            version: number;
          },
          { resolve: request.query.get("conflict") === "auto" },
        ),
    ],
    // A device reads a row by id to reconcile after a refusal.
    read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
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
  harness.server.answer("DELETE", /^\/edges\/[^/]+$/, {
    kind: "json",
    status: 204,
    body: {},
  });
  return door.rows;
}

/** What the folder sent to the items door, parsed. */
function sentCreates(harness: FolderHarness): Array<Record<string, unknown>> {
  return harness.server.requests
    .filter(
      (request) => request.method === "POST" && request.pathname === "/items",
    )
    .map((request) => JSON.parse(request.body) as Record<string, unknown>);
}

/** The titles the folder's creates carried, in the order sent. */
function sentTitles(harness: FolderHarness): string[] {
  return sentCreates(harness).map((sent) =>
    String((sent.properties as Record<string, unknown>).title),
  );
}

/** The item updates the folder sent, each with the id it went to. */
function sentUpdates(
  harness: FolderHarness,
): Array<{ id: string; body: Record<string, unknown> }> {
  return harness.server.requests
    .filter(
      (request) =>
        request.method === "PATCH" && /^\/items\/[^/]+$/.test(request.pathname),
    )
    .map((request) => ({
      id: request.pathname.split("/").at(-1) ?? "",
      body: JSON.parse(request.body) as Record<string, unknown>,
    }));
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
              properties: { title: "from-server", body: "pulled\n" },
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
      typeof sent?.id,
      "the create named no id, so the file has no item to name until the server answers",
    ).toBe("string");
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

  it("writes a person's frontmatter back in the order they wrote it", async () => {
    harness = await folderHarness("folder-frontmatter-order");
    scriptFolderWrites(harness);
    put(
      harness,
      "note.md",
      "---\nzebra: last in the alphabet\napple: first\nmango: in between\ntitle: Ordered\n---\nbody\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    // The file's own fields, and only those. A field the type declares is
    // ordered by the type: a real server answers `body` and `title` first
    // whatever order they were sent in, so asserting where `title` lands
    // would be asserting something only the scripted server does.
    const own = ["zebra", "apple", "mango"];
    const written = read(harness, "note.md");
    expect(
      written,
      "the folder never wrote the file back, so what is being read is what this fixture itself typed and the order below is its own",
    ).toMatch(/^marfa_id:/m);
    const fields = [...written.matchAll(/^([a-z_]+):/gm)]
      .map((found) => found[1])
      .filter((field) => own.includes(field));
    expect(
      fields.length,
      "none of the file's own fields came back at all, so the assertion below is about an empty list",
    ).toBe(own.length);
    expect(
      fields,
      "the folder rewrote the person's frontmatter in an order nobody asked for, which is a change to their file on the first pull and one no scan can tell from a change they made",
    ).toEqual(own);
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

  it("takes the edge with a link the body no longer names", async () => {
    harness = await folderHarness("folder-link-removed");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    // The person takes the line out. The edge is the folder's own kind and
    // its target is a file in the same folder, so it is the folder's to
    // remove.
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee nothing for more\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_edge").length,
      "the edge outlived the link, so the next pull writes the line back and the person deletes it again forever",
    ).toBe(1);

    expect((await harness.folder.push()).ok).toBe(true);
    const after = read(harness, "source.md");
    expect(
      after,
      "the pull left the file as the person saved it, so the absence below is their own typing rather than anything the folder decided",
    ).toMatch(/^marfa_id:/m);
    expect(
      after,
      "the folder put the link back into the file after the person took it out, which is a fight the person cannot win",
    ).not.toContain("[[target]]");
  });

  it("keeps an edge the file never carried, whoever made it", async () => {
    harness = await folderHarness("folder-edge-from-elsewhere");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    put(harness, "source.md", "---\ntitle: Source\n---\nno link at all\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const rows = await device.queue();
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    const ids = rows.value
      .filter((row) => row.kind === "create_item")
      .map((row) => row.item_id as string);
    expect(
      ids.length,
      "the two files never became items, so there is nothing for an edge to join",
    ).toBe(2);

    // An agent with its own key joins them. The folder holds the edge from
    // this moment on, and no file in the folder mentions it, because nothing
    // has rendered it yet — which is exactly what a link the person deleted
    // also looks like.
    const made = await device.createEdge({
      source: ids[0]!,
      target: ids[1]!,
      type: "references",
    });
    expect(made.ok, `the edge was refused: ${JSON.stringify(made)}`).toBe(true);

    // The person types one word into the file. A scan runs before any pull.
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nno link at all, and a word more\n",
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.updated,
      "the edit was not seen at all, so nothing below could have deleted anything",
    ).toBe(1);

    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_edge"),
      "one keystroke in a file destroyed an edge made somewhere else, because an edge nothing has rendered yet looks exactly like a link the person removed",
    ).toEqual([]);
  });

  it("removes no edge at all when a link in the body names nothing", async () => {
    harness = await folderHarness("folder-unresolved-link");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const before = await device.queue();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(
      before.value.filter((row) => row.kind === "create_edge").length,
      "the link never became an edge, so there is nothing here for a later scan to remove",
    ).toBe(1);

    // Tidying: the target is renamed and the source is edited in one window,
    // which is what people do. The link still says `target` and now resolves
    // to nothing — and a link that names nothing looks exactly like a link
    // that has gone.
    renameSync(join(harness.dir, "target.md"), join(harness.dir, "moved.md"));
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee [[target]] for more, and a word\n",
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      [scanned.value.renamed, scanned.value.updated],
      "the rename and the edit were not both seen, so nothing below is about the window they share",
    ).toEqual([1, 1]);

    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_edge"),
      "the folder destroyed the edge because the link stopped resolving, so renaming a file while editing another quietly cuts the connection between them and the line stays in the body saying otherwise",
    ).toEqual([]);
  });

  it("remembers a link it stood down over, so a later removal still lands", async () => {
    harness = await folderHarness("folder-stand-down-memory");
    scriptFolderWrites(harness);
    put(harness, "one.md", "---\ntitle: One\n---\nfirst\n");
    put(harness, "two.md", "---\ntitle: Two\n---\nsecond\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[one]] and [[two]]\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const first = await device.queue();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      first.value.filter((row) => row.kind === "create_edge").length,
      "the two links never became edges, so there is nothing for a later removal to land on",
    ).toBe(2);

    // `two` stops resolving, in the same window as an edit. The folder stands
    // the removal down — and must not forget that the file carried the link.
    renameSync(join(harness.dir, "two.md"), join(harness.dir, "moved.md"));
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee [[one]] and [[two]], plus a word\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);

    // The person takes the stale link out. Every link left resolves, so the
    // removal runs — and it can only reach the edge if the folder still
    // remembers the file used to carry it.
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee [[one]] only\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);

    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_edge").length,
      "the stand-down dropped the link out of the folder's memory for good, so removing it later does nothing and the next pull writes it back forever",
    ).toBe(1);
  });

  it("keeps an edge of a kind it could not have made", async () => {
    harness = await folderHarness("folder-foreign-edge");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const rows = await device.queue();
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    const edge = rows.value.find((row) => row.kind === "create_edge");
    expect(
      edge,
      "the link never became an edge, so there is nothing here of any kind to keep",
    ).toBeDefined();

    // A second edge between the same two, of a kind a folder never writes.
    const made = await device.createEdge({
      source: edge!.item_id as string,
      target: edge!.target_id as string,
      type: "mentions",
    });
    expect(made.ok, `the edge was refused: ${JSON.stringify(made)}`).toBe(true);

    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee nothing for more\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);

    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const deleted = queued.value.filter((row) => row.kind === "delete_edge");
    expect(
      deleted.length,
      "the link the person removed took no edge with it, so this fixture is not looking at a removal at all",
    ).toBeGreaterThan(0);
    expect(
      deleted.map((row) => row.edge_id),
      "the folder removed an edge of a kind it could not have made and cannot make again, on the strength of a line it never wrote",
    ).toEqual([edge!.edge_id]);
  });

  it("does not write back a link the person took out for an edge it could not have made", async () => {
    // Three items the folder did not create, so their ids are known and a
    // server-side edit to one of them can be scripted: the lift below is
    // only visible when the server rewrites the body without the line.
    const source = "01a00000-0000-7000-8000-0000000000a1";
    const target = "01a00000-0000-7000-8000-0000000000a2";
    const other = "01a00000-0000-7000-8000-0000000000a3";
    const body = (text: string) => ({ title: "source", body: text });
    harness = await folderHarness("folder-declined-link", {
      rows: {
        "core.note": [
          {
            item: {
              id: source,
              properties: body("see [[target]] for more\n"),
            },
          },
          {
            item: {
              id: target,
              properties: { title: "target", body: "the other end\n" },
            },
          },
          {
            item: {
              id: other,
              properties: { title: "other", body: "another end\n" },
            },
          },
        ],
      },
      // The server later rewrites the source's body without any link line,
      // which is the one way a lifted record shows: the pull then renders
      // the edge again where a record still standing would not.
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id: source,
              version: 9,
              properties: body("see [[target]] for more\n"),
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const device = harness.folder.device();

    // An edge of a kind the folder never writes, to a file the body does
    // not name, made elsewhere.
    const made = await device.createEdge({
      source,
      target: other,
      type: "mentions",
    });
    expect(made.ok, `the edge was refused: ${JSON.stringify(made)}`).toBe(true);

    // The witness: the pull renders it as a link, as 7 says it does.
    const rendered = await harness.folder.pull();
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(
      rendered.value.rewritten,
      "the edge was never rendered, so there is no link here for a person to take out",
    ).toBe(1);
    expect(read(harness, "source.md").split("[[other]]")).toHaveLength(2);

    // The person takes the line out, and nothing else: the frontmatter
    // the folder wrote stays, so the only difference is the link. Each edit
    // below is drained before the next, as a folder left watching drains
    // every pass: queued together, each would be based on the version the
    // copy read before the first, and the server would merge each against it.
    const takeOut = () => {
      writeFileSync(
        join(harness!.dir, "source.md"),
        read(harness!, "source.md").replace("[[other]]\n", ""),
      );
    };
    takeOut();
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await device.drain()).ok).toBe(true);

    // The edge stays (23), and the link does not come back.
    const again = await harness.folder.pull();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      again.value.rewritten,
      "the pull wrote the removed link back, so the person is in the loop 21 was meant to end",
    ).toBe(0);
    expect(read(harness, "source.md")).not.toContain("[[other]]");
    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "update_item").length,
      "the removal was never queued, so the queue below is not a queue this scan wrote to",
    ).toBeGreaterThan(0);
    expect(
      queued.value.filter((row) => row.kind === "delete_edge"),
      "the folder removed an edge of a kind it could not have made",
    ).toEqual([]);

    // The record survives a scan that stands down: a link naming nothing
    // in the same file stops the removal rule, and the declined target
    // has to stay declined through it.
    writeFileSync(
      join(harness.dir, "source.md"),
      read(harness, "source.md") + "and [[nowhere]]\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await device.drain()).ok).toBe(true);
    const stoodDown = await harness.folder.pull();
    expect(stoodDown.ok && stoodDown.value.rewritten).toBe(0);
    expect(
      read(harness, "source.md"),
      "a scan that stood down dropped the record, and the link came back",
    ).not.toContain("[[other]]");

    // A link of the folder's own kind taken out is not a declined target:
    // its edge goes (23), and an edge of another kind to the same item,
    // made afterwards, still renders.
    writeFileSync(
      join(harness.dir, "source.md"),
      read(harness, "source.md")
        .replace("see [[target]] for more\n", "see nothing for more\n")
        .replace("and [[nowhere]]\n", ""),
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await device.drain()).ok).toBe(true);
    const mentioned = await device.createEdge({
      source,
      target,
      type: "mentions",
    });
    expect(mentioned.ok).toBe(true);
    const foreign = await harness.folder.pull();
    expect(foreign.ok && foreign.value.rewritten).toBe(1);
    expect(
      read(harness, "source.md"),
      "a link of the folder's own kind taken out declined the target for edges of every kind",
    ).toContain("[[target]]");

    // Naming the declined link again by hand lifts the record. The body
    // now carries the line itself, so the lift shows only once the server
    // rewrites the body without it: the drain lands the person's edit, the
    // catch-up applies the server's later one over it, and the pull renders
    // the edge again. Without the drain the person's edit is still waiting,
    // and an event never erases a waiting write (`queue-and-verdicts.md` 35).
    writeFileSync(
      join(harness.dir, "source.md"),
      read(harness, "source.md") + "[[other]]\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await device.drain()).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok ? caught.value.applied : 0, JSON.stringify(caught)).toBe(
      1,
    );
    const lifted = await harness.folder.pull();
    expect(lifted.ok && lifted.value.rewritten).toBe(1);
    expect(
      read(harness, "source.md").split("[[other]]"),
      "the person named the link again and the record was not lifted, so the edge stays unrendered for good",
    ).toHaveLength(2);
  });

  it("takes another device's change at the next push, without a hydration", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c1";
    harness = await folderHarness("folder-push-catches-up", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "elsewhere", body: "as it was" },
            },
          },
        ],
      },
      events: [
        liveReplay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: {
                title: "elsewhere",
                body: "changed on another device",
              },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    // The witness: the file holds what the hydration brought.
    expect(read(harness, "elsewhere.md")).toContain("as it was");

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      read(harness, "elsewhere.md"),
      "a push wrote the folder out from a copy that never heard of the change another device made",
    ).toContain("changed on another device");
  });

  it("takes another device's change while watching, without a hydration", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c2";
    harness = await folderHarness("folder-watch-follows", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "watched", body: "as it was" },
            },
          },
        ],
      },
      events: [
        liveReplay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "watched", body: "changed while watching" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    const watching = harness.folder.watch();
    try {
      await vi.waitFor(
        () =>
          expect(read(harness!, "watched.md")).toContain(
            "changed while watching",
          ),
        { timeout: 20_000, interval: 100 },
      );
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      await watching.stop();
    }
  });

  describe("a copy that falls behind the log", () => {
    const id = "01a00000-0000-7000-8000-0000000000c3";
    const agedOut: Answer = {
      kind: "sse",
      frames: [connected, streamCursor("900"), catchupTooOld("500", "1")],
    };

    /** A folder with one note written out, whose later hydrations serve
     *  `later` in its place. */
    async function behind(
      label: string,
      events: Responder[],
    ): Promise<FolderHarness> {
      const made = await folderHarness(label, {
        rows: {
          "core.note": [
            {
              item: {
                id,
                version: 1,
                properties: { title: "aged", body: "as it was" },
              },
            },
          ],
        },
        events,
      });
      scriptFolderWrites(made);
      expect((await made.folder.pull()).ok).toBe(true);
      expect(read(made, "aged.md")).toContain("as it was");
      made.rows["core.note"]![0]!.item = {
        id,
        version: 2,
        properties: { title: "aged", body: "changed elsewhere" },
      };
      return made;
    }

    it("hydrates again at a push whose cursor the log has aged past", async () => {
      harness = await behind("folder-push-aged-out", [
        agedOut,
        headRead("900"),
      ]);
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (!pushed.ok) return;
      expect(pushed.value.catch_up.hydrated?.items).toBe(1);
      expect(
        read(harness, "aged.md"),
        "a push whose cursor aged out wrote the folder from the copy it could no longer keep current",
      ).toContain("changed elsewhere");
    });

    it("hydrates again while watching when the log ages past its cursor", async () => {
      harness = await behind("folder-watch-aged-out", [
        agedOut,
        headRead("900"),
        liveReplay("900", []),
      ]);
      const watching = harness.folder.watch();
      try {
        await vi.waitFor(
          () =>
            expect(read(harness!, "aged.md"), watching.stderr).toContain(
              "changed elsewhere",
            ),
          { timeout: 20_000, interval: 100 },
        );
        expect(watching.running(), watching.stderr).toBe(true);
      } finally {
        await watching.stop();
      }
    });

    it("keeps watching through a hydration that failed, and tries it again", async () => {
      harness = await behind("folder-watch-hydration-fails", [
        agedOut,
        answers.serverFault(),
        headRead("900"),
        liveReplay("900", []),
      ]);
      const watching = harness.folder.watch();
      try {
        await vi.waitFor(
          () =>
            expect(read(harness!, "aged.md"), watching.stderr).toContain(
              "changed elsewhere",
            ),
          { timeout: 20_000, interval: 100 },
        );
        expect(watching.running(), watching.stderr).toBe(true);
        // The witness: the first hydration did fail.
        expect(watching.stderr).toContain("could not hydrate");
      } finally {
        await watching.stop();
      }
    });

    it("waits out a rate limit's Retry-After before hydrating again while watching", async () => {
      const asked: number[] = [];
      const timed =
        (answer: Answer): Responder =>
        () => {
          asked.push(Date.now());
          return answer;
        };
      harness = await behind("folder-watch-hydration-limited", [
        agedOut,
        timed(answers.rateLimited()),
        timed(headRead("900")),
        liveReplay("900", []),
      ]);
      const watching = harness.folder.watch();
      try {
        await vi.waitFor(
          () =>
            expect(read(harness!, "aged.md"), watching.stderr).toContain(
              "changed elsewhere",
            ),
          { timeout: 20_000, interval: 100 },
        );
      } finally {
        await watching.stop();
      }
      // The first wait is a second; the rate limit names two.
      expect(asked).toHaveLength(2);
      expect(
        asked[1]! - asked[0]!,
        "the watch hydrated again before the wait the rate limit named",
      ).toBeGreaterThanOrEqual(1900);
    });

    it("ends the watch and says so when its hydration meets an answer no retry changes", async () => {
      harness = await behind("folder-watch-hydration-refused", [
        agedOut,
        answers.forbidden("forbidden"),
      ]);
      const watching = harness.folder.watch();
      try {
        // The witness is `› keeps watching through a hydration that failed,
        // and tries it again`: a 500 in the same place keeps it running.
        await vi.waitFor(
          () =>
            expect(
              watching.running(),
              `a watch went on after its hydration was refused, so nothing says the folder no longer keeps up: ${watching.stderr}`,
            ).toBe(false),
          { timeout: 20_000, interval: 100 },
        );
        expect(watching.stderr).toContain(
          "the server's changes stopped reaching this folder",
        );
        expect(watching.stderr).toContain("forbidden");
      } finally {
        await watching.stop();
      }
    });

    it("hydrates at the next push after one whose hydration failed", async () => {
      harness = await behind("folder-push-hydration-fails", [
        agedOut,
        answers.serverFault(),
        headRead("900"),
        liveReplay("900", []),
      ]);
      const failed = await harness.folder.push();
      expect(failed.ok, JSON.stringify(failed)).toBe(true);
      if (!failed.ok) return;
      expect(failed.value.catch_up.failed).toMatch(/500/);
      expect(
        failed.value.pull,
        "a push pulled from a copy it could not hydrate",
      ).toBeNull();
      expect(read(harness, "aged.md")).toContain("as it was");

      const next = await harness.folder.push();
      expect(
        next.ok,
        `the push after a failed hydration failed too: ${JSON.stringify(next)}`,
      ).toBe(true);
      if (!next.ok) return;
      expect(next.value.hydrated?.items).toBe(1);
      expect(read(harness, "aged.md")).toContain("changed elsewhere");
    });
  });

  it("pulls at a push that cannot reach the server, and says the catch-up failed", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c4";
    harness = await folderHarness("folder-push-offline", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "offline", body: "as it was" },
            },
          },
        ],
      },
      events: [
        liveReplay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "offline", body: "changed elsewhere" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect(existsSync(join(harness.dir, "offline.md"))).toBe(false);

    await harness.server.offline();
    const offline = await harness.folder.push();
    await harness.server.online();
    expect(
      offline.ok,
      `a push that could not reach the server failed rather than writing out what it holds: ${JSON.stringify(offline)}`,
    ).toBe(true);
    if (!offline.ok) return;
    expect(offline.value.catch_up.failed).toMatch(/network/);
    expect(offline.value.pull?.written).toBe(1);
    expect(read(harness, "offline.md")).toContain("as it was");

    // The witness: the same push online catches up.
    const online = await harness.folder.push();
    expect(online.ok, JSON.stringify(online)).toBe(true);
    if (!online.ok) return;
    expect(online.value.catch_up.caught_up?.applied).toBe(1);
    expect(read(harness, "offline.md")).toContain("changed elsewhere");
  });

  it("makes an edge between two files that arrive together", async () => {
    harness = await folderHarness("folder-links-same-scan");
    scriptFolderWrites(harness);
    // Both new in one scan, each naming the other. The walk returns them
    // sorted, so one is reached before the other is bound.
    put(harness, "alpha.md", "---\ntitle: Alpha\n---\nsee [[omega]]\n");
    put(harness, "omega.md", "---\ntitle: Omega\n---\nsee [[alpha]]\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const edges = queued.value.filter((row) => row.kind === "create_edge");
    const creates = sentCreates(harness);
    expect(
      creates.length,
      "the two files never became items, so there is nothing for an edge to join",
    ).toBe(2);
    expect(
      edges.length,
      "a link to a file that arrived in the same scan never became an edge, and no later scan retries it because both files are unchanged from then on",
    ).toBe(2);
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

    // And the other direction, with a witness that it ran. The body above
    // already carries its link, so writing it back proves only that nothing
    // was lost; an edge the file does not mention is what makes the folder
    // add one.
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      read(harness, "source.md"),
      "the link went from the file when the item was written back, so an edge a folder made disappears from the note that made it",
    ).toContain("[[target]]");

    // A second folder, hydrated on an item that carries an edge in its own
    // body-free form: the file has no link, and the edge is what has to put
    // one there.
    second = await folderHarness("folder-edges-to-links", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000a1",
              properties: { title: "from-server", body: "no link here\n" },
              edges: {
                references: {
                  data: [
                    {
                      id: "01a00000-0000-7000-8000-0000000000e1",
                      source_id: "01a00000-0000-7000-8000-0000000000a1",
                      target_id: "01a00000-0000-7000-8000-0000000000a2",
                      edge_type: "references",
                      properties: {},
                      version: 1,
                      created_at: "2026-09-18T00:00:00.000Z",
                      updated_at: "2026-09-18T00:00:00.000Z",
                    },
                  ],
                  next_cursor: null,
                },
              },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000a2",
              properties: { title: "the-target", body: "the other end\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(second);
    const pulled = await second.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.written,
      "the folder wrote no files at all, so the assertion below is about a file that is not there",
    ).toBe(2);
    expect(
      read(second, "from-server.md"),
      "an edge the item carries did not appear as a link in the file, so a connection made anywhere else is invisible in the folder",
    ).toContain("[[the-target]]");
  });
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

  it("follows a rename by the id the file carries, and sends nothing for it", async () => {
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
      "a move sent a write, though nothing the server holds names a file's path",
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
      slice: { types: ["core.note", "core.file"], defaultType: "core.note" },
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
    put(harness, "original.txt", "linked\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    linkSync(join(harness.dir, "original.txt"), join(harness.dir, "hard.txt"));
    renameSync(
      join(harness.dir, "original.txt"),
      join(harness.dir, "moved.txt"),
    );
    const shared = await harness.folder.scan();
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(
      shared.value.renamed,
      "a file whose identity two paths share was followed as a rename, and the folder cannot know which of the two it remembers",
    ).toBe(0);
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
    expect(pushed.value.drain.verdicts.map((entry) => entry.verdict)).toEqual([
      "accepted",
    ]);
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
    expect(later[0]).toMatch(
      /^1 created, 0 updated, 0 renamed, 0 deleted; sent 1; \d+ file\(s\) written, 1 bound to an item that is gone$/,
    );
  });
});

describe("writing", () => {
  it("does not read its own writes back as changes", async () => {
    harness = await folderHarness("folder-echo", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
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
      "the file the folder wrote was not recognized at all, so the absence above is the scan seeing nothing rather than seeing its own work",
    ).toBe(1);

    // The control: a change somebody else made is not suppressed.
    writeFileSync(
      join(harness.dir, "Written.md"),
      `${read(harness, "Written.md")}\nedited by a person\n`,
    );
    const edited = await harness.folder.scan();
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(
      edited.value.updated,
      "a change the folder did not make was suppressed too, so echo suppression is suppressing everything",
    ).toBe(1);
  });

  it("sends a file edited twice before a push as two edits, not a conflict with itself", async () => {
    const id = "01a00000-0000-7000-8000-00000000000a";
    harness = await folderHarness("folder-edit-twice", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: { title: "Twice", body: "as read\n" },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);

    // Two edits, each scanned before anything is sent: both are queued
    // against the version the copy holds, which the first does not move.
    for (const body of ["first edit", "second edit"]) {
      writeFileSync(
        join(harness.dir, "Twice.md"),
        `---\ntitle: Twice\n---\n${body}\n`,
      );
      const scanned = await harness.folder.scan();
      expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
      if (!scanned.ok) return;
      expect(scanned.value.updated).toBe(1);
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    expect(
      pushed.value.drain.verdicts
        .filter((entry) => entry.kind === "update_item")
        .map((entry) => entry.verdict),
      "the second edit of the file was not taken as sent: the server merged it against the folder's own first edit as though another machine had written it, and kept the first on the row with the second set aside in a copy",
    ).toEqual(["accepted", "accepted"]);
    expect(
      harness.server.requests
        .filter(
          (request) =>
            request.method === "PATCH" && request.pathname === `/items/${id}`,
        )
        .map(
          (request) =>
            (JSON.parse(request.body) as { version?: unknown }).version,
        ),
    ).toEqual([1, 2]);
    expect(String(rows.get(id)?.properties.body)).toContain("second edit");
  });

  it("sends a file saved twice as two edits where another machine retitled the note meanwhile", async () => {
    const noteId = "01a00000-0000-7000-8000-0000000000a1";
    const controlId = "01a00000-0000-7000-8000-0000000000a2";
    harness = await folderHarness("folder-save-twice-retitled", {
      rows: {
        "core.note": [
          {
            item: {
              id: noteId,
              properties: { title: "Note", body: "as read\n" },
            },
          },
          {
            item: {
              id: controlId,
              properties: { title: "Control", body: "as read\n" },
            },
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    // Two saves of each file, each scanned before anything is sent. A note
    // file carries its title, which the person leaves alone.
    for (const body of ["first save", "second save"]) {
      put(harness, "Note.md", `---\ntitle: Note\n---\n${body}\n`);
      put(harness, "Control.md", `---\ntitle: Control\n---\n${body}\n`);
      const scanned = await harness.folder.scan();
      expect(scanned.ok && scanned.value.updated).toBe(2);
    }
    // Another machine retitles the note, a property its file carries; and
    // sets notes on the control, a property its file does not.
    door?.update(noteId, { properties: { title: "Retitled" }, version: 1 });
    door?.update(controlId, { properties: { notes: "theirs" }, version: 1 });
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    const verdicts = (itemId: string) =>
      pushed.value.drain.verdicts
        .filter((entry) => entry.item_id === itemId)
        .map((entry) => entry.verdict);
    // The control: what the other machine changed is nothing the file
    // carries, so both saves land.
    expect(verdicts(controlId)).toEqual(["accepted", "accepted"]);
    expect(
      verdicts(noteId),
      "the second save came back conflicted with the folder's own first, because the title the file carries unchanged was checked against the other machine's",
    ).toEqual(["accepted", "accepted"]);
    expect(rows.get(noteId)?.properties).toEqual({
      title: "Retitled",
      body: "second save\n",
    });
    expect(rows.get(controlId)?.properties).toEqual({
      title: "Control",
      body: "second save\n",
      notes: "theirs",
    });
    // The file ends on the second save, under the other machine's title.
    expect(read(harness, "Note.md")).toContain("second save");
    expect(read(harness, "Note.md")).toContain("title: Retitled");
    const copiesIn = (held: Iterable<DoorRow>) =>
      [...held].filter((row) => (row.tags ?? []).includes(CONFLICTED_COPY_TAG));
    // The witness: the same two saves, each sent on the version the file
    // was read at, leave a conflicted copy on this door, tagged.
    const control = new FolderDoor([
      [
        noteId,
        {
          properties: { title: "Note", body: "as read\n" },
          source_id: null,
          type: "core.note",
          version: 1,
        },
      ],
    ]);
    control.update(noteId, { properties: { title: "Retitled" }, version: 1 });
    for (const body of ["first save", "second save"]) {
      control.update(
        noteId,
        { properties: { title: "Note", body: `${body}\n` }, version: 1 },
        { resolve: true },
      );
    }
    expect(copiesIn(control.rows.values())).toHaveLength(1);
    expect(
      copiesIn(rows.values()),
      "a save was set aside in a conflicted copy",
    ).toEqual([]);
  });

  it("keeps a file whose newest save conflicted with its own earlier one, and sends it again", async () => {
    const id = "01a00000-0000-7000-8000-0000000000a3";
    harness = await folderHarness("folder-save-against-its-own", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: { title: "Note", body: "as read\n" },
            },
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    // The first save changes the body; the second the body and the title,
    // which another machine retitles meanwhile. The second cannot go on the
    // first's answer without taking its title over the other machine's, so
    // it goes on the first's base and collides with the first's body.
    put(harness, "Note.md", "---\ntitle: Note\n---\nfirst save\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(harness, "Note.md", "---\ntitle: Mine\n---\nsecond save\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    door?.update(id, { properties: { title: "Retitled" }, version: 1 });
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witness: the second save was set aside in a copy, and the row
    // kept the first save's body.
    expect(
      pushed.value.drain.verdicts
        .filter((entry) => entry.item_id === id)
        .map((entry) => entry.verdict),
    ).toEqual(["accepted", "conflicted"]);
    expect(rows.get(id)?.properties.body).toBe("first save\n");
    expect(
      read(harness, "Note.md"),
      "the pull wrote the row's older save over the file holding the newest one",
    ).toContain("second save");

    // The next push sends what the file holds as an edit of the row.
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(
      again.value.drain.verdicts
        .filter((entry) => entry.item_id === id)
        .map((entry) => entry.verdict),
    ).toEqual(["accepted"]);
    expect(rows.get(id)?.properties).toEqual({
      title: "Mine",
      body: "second save\n",
    });
    expect(read(harness, "Note.md")).toContain("second save");
  });

  /**
   * A note an editor holds as the pull wrote it, at version 1, while another
   * machine retitles it and the next push writes that out at version 2.
   * Answers the door, what it holds, and the text the editor still holds.
   */
  async function heldWhileRetitled(label: string, id: string) {
    harness = await folderHarness(label, {
      rows: {
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
      events: [
        liveReplay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "Retitled", body: "as read\n" },
            }),
          ),
        ]),
      ],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Note.md");
    expect(held).toContain("marfa_version: 1");
    door?.update(id, { properties: { title: "Retitled" }, version: 1 });
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness that the file was stale: the pull wrote the retitle out.
    expect(read(harness, "Note.md")).toContain("title: Retitled");
    expect(read(harness, "Note.md")).toContain("marfa_version: 2");
    return { door: door!, rows, held };
  }

  it("bases a stale file's edit on the version written in it", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b1";
    const { rows, held } = await heldWhileRetitled("folder-version-base", id);
    // The editor saves what it held over the file, the body changed, and
    // saves again before anything is sent: the second is made against the
    // first, not against the version the line names.
    for (const body of ["my edit", "my edit, twice"]) {
      put(harness!, "Note.md", held.replace("as read", body));
      const scanned = await harness!.folder.scan();
      expect(scanned.ok && scanned.value.updated).toBe(1);
    }
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    expect(
      sentUpdates(harness!).map((update) => update.body.version),
      "an edit went on a version it was not made against: the first on the version the copy holds puts the title it read over the other machine's, and the second on the line the first went on is merged against the first",
    ).toEqual([1, 3]);
    expect(
      pushed.value.drain.verdicts.map((entry) => entry.verdict),
      "the second edit went on the line the first already went on, and was merged against the first as though another machine had written it",
    ).toEqual(["accepted", "accepted"]);
    expect(rows.get(id)?.properties).toEqual({
      title: "Retitled",
      body: "my edit, twice\n",
    });
    expect(
      [...rows.values()].filter((row) =>
        (row.tags ?? []).includes(CONFLICTED_COPY_TAG),
      ),
    ).toEqual([]);
    // The pull writes the file anyway, and the line with it.
    const now = read(harness!, "Note.md");
    expect(now).toContain("title: Retitled");
    expect(now).toContain("my edit, twice");
    expect(now).toContain("marfa_version: 4");
  });

  it("sends over a thinned version as a merge, and says so", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b2";
    const { door, rows, held } = await heldWhileRetitled(
      "folder-version-thinned",
      id,
    );
    door.thin(id, 1);
    // Saved twice from the old buffer before anything is sent, so the
    // second goes after the first rather than beside it.
    for (const body of ["my edit", "my edit, twice"]) {
      put(harness!, "Note.md", held.replace("as read", body));
      expect((await harness!.folder.scan()).ok).toBe(true);
    }
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    expect(
      sentUpdates(harness!).map((update) => update.body.version),
      "the edits were not sent again on the version the copy holds, one after the other, once the server said it no longer held the one the file names",
    ).toEqual([1, 1, 2, 3]);
    expect(
      pushed.value.drain.verdicts.map((entry) => [entry.verdict, entry.reason]),
    ).toEqual([
      ["blocked", "ancestor_unavailable"],
      ["blocked", "ancestor_unavailable"],
      ["accepted", null],
      ["accepted", null],
    ]);
    expect(
      pushed.value.drain.rebased,
      "the push did not say the edits went over whatever changed since their file was written",
    ).toBe(2);
    // Not merged against what the file was read from, so the title it
    // carries went over the other machine's.
    expect(rows.get(id)?.properties).toEqual({
      title: "Note",
      body: "my edit, twice\n",
    });
    expect(door.conflictedCopies()).toEqual([]);
    expect(read(harness!, "Note.md")).toContain("marfa_version: 4");

    // Said in words too, where the editor saves its old text once more.
    put(harness!, "Note.md", held.replace("as read", "my edit, again"));
    const said = await harness!.folder.pushText();
    expect(said.ok, JSON.stringify(said)).toBe(true);
    expect(said.ok && said.value).toContain(
      "1 edit(s) written from a version the server no longer holds, sent again on the version this copy holds",
    );
    expect(rows.get(id)?.properties.body).toBe("my edit, again\n");
  });

  it("does not rewrite a file for its version line alone", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b3";
    const row = (version: number, body: string, occurred_at?: string) =>
      itemEvent(
        String(version),
        "item.updated",
        wireItem({
          id,
          version,
          properties: { title: "Note", body },
          ...(occurred_at === undefined ? {} : { occurred_at }),
        }),
      );
    harness = await folderHarness("folder-version-line-alone", {
      rows: {
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
      events: [
        // Another machine moves the item's own time, which no file carries.
        liveReplay("2", [row(2, "as read\n", "2026-09-19T00:00:00.000Z")]),
        liveReplay("2", []),
        liveReplay("4", [row(4, "theirs\n", "2026-09-19T00:00:00.000Z")]),
      ],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Note.md");
    expect(written).toContain("marfa_version: 1");

    door?.update(id, { properties: {}, version: 1 });
    const moved = await harness.folder.push();
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    expect(
      moved.value.catch_up.caught_up?.applied,
      "the catch-up never moved the copy, so a file left alone proves nothing",
    ).toBe(1);
    expect(
      [read(harness, "Note.md"), moved.value.pull?.rewritten],
      "the pull wrote the file for its version line alone, which wakes every editor holding it for nothing",
    ).toEqual([written, 0]);

    // The file's own edit, not yet landed: the line stays.
    const mine = written.replace("as read", "mine");
    put(harness, "Note.md", mine);
    expect((await harness.folder.scan()).ok).toBe(true);
    const waiting = await harness.folder.pull();
    expect(
      [read(harness, "Note.md"), waiting.ok && waiting.value.rewritten],
      "the pull wrote the line before the file's own edit landed",
    ).toEqual([mine, 0]);

    // Landed, with the file unchanged since its scan.
    const landed = await harness.folder.push();
    expect(landed.ok, JSON.stringify(landed)).toBe(true);
    if (!landed.ok) return;
    expect(
      read(harness, "Note.md"),
      "the line was left behind the file's own edit, so the next edit is merged against this one as though another machine wrote it",
    ).toBe(
      written
        .replace("as read", "mine")
        .replace("marfa_version: 1", "marfa_version: 3"),
    );

    // And a pull that writes the file anyway writes the line with it.
    door?.update(id, { properties: { body: "theirs\n" }, version: 3 });
    const theirs = await harness.folder.push();
    expect(theirs.ok, JSON.stringify(theirs)).toBe(true);
    expect(read(harness, "Note.md")).toContain("theirs");
    expect(read(harness, "Note.md")).toContain("marfa_version: 4");
  });

  it("defers a delete past the rename grace", async () => {
    harness = await folderHarness("folder-delete-grace");
    scriptFolderWrites(harness);
    put(harness, "going.md", "---\ntitle: Going\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The first half of a rename looks exactly like a delete: the old path
    // stops existing. A folder that sent a delete here would delete the item
    // it was about to rename.
    const graceStarted = Date.now();
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

    // The other half arrives inside the grace. **A real rename**, so the
    // identity carries over and the folder can recognize it: an earlier
    // version of this case created a new file, which can never match the
    // remembered identity, so the rename path was never reached and the
    // assertion below rode entirely on the grace not having elapsed.
    rmSync(join(harness.dir, "going.md"), { force: true });
    writeFileSync(
      join(harness.dir, "going.md"),
      "---\ntitle: Going\n---\nbody\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    renameSync(join(harness.dir, "going.md"), join(harness.dir, "arrived.md"));
    const renamed = await harness.folder.scan();
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(
      renamed.value.renamed,
      "the file was not followed as a rename, so the assertion below is about the grace rather than about the folder noticing the other half arrived",
    ).toBe(1);
    const after = await harness.folder.device().queue();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.some((row) => row.kind === "delete_item"),
      "the rename completed and the delete went anyway, so the grace records the delete and sends it regardless",
    ).toBe(false);
    // **Past the grace**, which is what separates a journal row that was
    // cleared from one that is merely still waiting. The two look identical
    // until the grace runs out, so the scan above can only say that nothing
    // has been sent yet; this is the half that says nothing will be.
    await vi.waitFor(
      async () => {
        const swept = await harness?.folder.scan();
        expect(swept?.ok).toBe(true);
        const queue = await harness?.folder.device().queue();
        expect(queue?.ok).toBe(true);
        // The grace has run: any journal row left would have become a
        // delete by now.
        expect(
          (Date.now() - graceStarted) / 1000,
          "the grace has not run out yet, so a journal the rename failed to clear would not have become a delete",
        ).toBeGreaterThan(6);
        expect(
          queue?.ok === true &&
            queue.value.some((row) => row.kind === "delete_item"),
          "the rename completed and a delete went anyway once the grace ran out, so the journal the rename should have cleared survived it",
        ).toBe(false);
      },
      { timeout: 25_000, interval: 1_000 },
    );
  });

  it("takes the old path out of the journal when the file comes back under a new name", async () => {
    harness = await folderHarness("folder-rename-after-journal");
    scriptFolderWrites(harness);
    put(harness, "going.md", "---\ntitle: Going\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The case above reaches the rename arm with an empty journal, because
    // the file is back at its own name for one scan first and the
    // came-back clear has already run. This is the other order, and the
    // only one in which the clear inside the rename arm is the thing under
    // test: the file leaves the folder, the scan journals the path it left,
    // and the file then arrives under a different name with that journal
    // row still standing.
    //
    // It moves into a dot-led directory rather than being deleted and
    // rewritten, because the device, inode and birth time have to survive
    // for the arrival to be a rename rather than a new file
    // (`folders.md` 8), and the walk does not enter a dot-led directory.
    const graceStarted = Date.now();
    mkdirSync(join(harness.dir, ".stash"), { recursive: true });
    renameSync(
      join(harness.dir, "going.md"),
      join(harness.dir, ".stash", "going.md"),
    );
    const missing = await harness.folder.scan();
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(
      missing.value.missing,
      "the path the file left was not journaled, so there is no journal row for the rename to clear and the rest of this is about nothing",
    ).toBe(1);

    renameSync(
      join(harness.dir, ".stash", "going.md"),
      join(harness.dir, "arrived.md"),
    );
    const renamed = await harness.folder.scan();
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(
      renamed.value.renamed,
      "the arrival was not followed as a rename, so nothing reached the arm that clears the old path's journal",
    ).toBe(1);

    // Past the grace, which is the only thing that tells a journal row that
    // was cleared from one that is still waiting.
    await vi.waitFor(
      async () => {
        const swept = await harness?.folder.scan();
        expect(swept?.ok).toBe(true);
        expect(
          (Date.now() - graceStarted) / 1000,
          "the grace has not run out yet, so a journal row the rename failed to clear would not have become a delete",
        ).toBeGreaterThan(6);
        const queue = await harness?.folder.device().queue();
        expect(queue?.ok).toBe(true);
        expect(
          queue?.ok === true &&
            queue.value.some((row) => row.kind === "delete_item"),
          "the rename left the old path in the journal, so the grace turned a move into a delete of the item that had just moved",
        ).toBe(false);
      },
      { timeout: 25_000, interval: 1_000 },
    );
    expect(
      existsSync(join(harness.dir, "arrived.md")),
      "the file is not in the folder, so the assertion above is about a delete that was right",
    ).toBe(true);
  });

  it("takes a file out of the journal when it comes back under its own name", async () => {
    harness = await folderHarness("folder-journal-return");
    scriptFolderWrites(harness);
    const text = "---\ntitle: Restored\n---\nbody\n";
    put(harness, "note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);
    const bound = read(harness, "note.md");

    // Gone, then back at the same name inside the grace: an undo, a Put
    // Back, a cloud mount that dropped a listing for a second.
    const graceStarted = Date.now();
    rmSync(join(harness.dir, "note.md"));
    const missing = await harness.folder.scan();
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(
      missing.value.missing,
      "the file was not journaled at all, so the rest of this is about a journal row that was never written",
    ).toBe(1);

    writeFileSync(join(harness.dir, "note.md"), bound);
    expect((await harness.folder.scan()).ok).toBe(true);

    // Past the grace, and asserted rather than waited for: the scan that
    // sweeps is the one that would send the delete.
    await vi.waitFor(
      async () => {
        const swept = await harness!.folder.scan();
        expect(swept.ok).toBe(true);
        expect((Date.now() - graceStarted) / 1000).toBeGreaterThan(6);
      },
      { timeout: 20_000, interval: 500 },
    );

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_item"),
      "the folder deleted an item whose file is sitting on the disk, because nothing took the path out of the journal when it came back — and the next scan then makes the file a new item with none of its edges",
    ).toEqual([]);
    expect(
      existsSync(join(harness.dir, "note.md")),
      "the file is not there, so the assertion above is about a delete that was right",
    ).toBe(true);
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
      "a tracked file absent at startup was not journaled, so a delete made while the folder was off is never sent and the item stays forever",
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
      sentTitles(harness).sort(),
      "a dot-led directory was pushed, and at depth is where it matters: an editor's own state, a version control directory, a cache — none of them is the person's content",
    ).toEqual(["Deep kept", "Kept"]);
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
      sentTitles(harness),
      "the folder pushed its own state, so its mapping and its queue are items on the server",
    ).toEqual(["A note"]);
  });

  it("refuses to write a file outside the folder", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "marfa-folder-elsewhere-"));
    harness = await folderHarness("folder-outside", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000e",
              properties: { title: "note", body: "body\n" },
            },
          },
          // The control. A guard that refuses everything satisfies the
          // assertions below, and a pull that writes nothing at all is the
          // plausible way to write one.
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000f",
              properties: { title: "ordinary", body: "body\n" },
            },
          },
          // The link that points back in: a write through it lands on
          // another file and truncates it.
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000010",
              properties: { title: "alias", body: "written through a link\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    writeFileSync(
      join(harness.dir, "kept.md"),
      "---\ntitle: Kept\n---\nmine\n",
    );
    symlinkSync(join(harness.dir, "kept.md"), join(harness.dir, "alias.md"));
    const first = await harness.folder.pull();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(
      first.value.written,
      "the pull wrote nothing at all, so a guard that refuses every path would satisfy everything below",
    ).toBeGreaterThan(0);
    expect(
      read(harness, "kept.md"),
      "an item was written through a link pointing back into the folder, so it truncated a file that belonged to another item",
    ).toContain("mine");
    expect(first.value.outside).toBe(1);

    // The note moves into a directory, which is then replaced by a link out
    // of the folder. The walk never descends the link, and the pull must not
    // write through it.
    mkdirSync(join(harness.dir, "out"));
    renameSync(
      join(harness.dir, "note.md"),
      join(harness.dir, "out", "note.md"),
    );
    const moved = await harness.folder.scan();
    expect(moved.ok && moved.value.renamed).toBe(1);
    renameSync(join(harness.dir, "out"), join(harness.dir, "out-real"));
    symlinkSync(elsewhere, join(harness.dir, "out"));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      existsSync(join(elsewhere, "note.md")),
      "a file landed outside the folder, where nothing the folder does will ever find it again",
    ).toBe(false);
    expect(
      pulled.value.outside,
      "the folder declined to write out of itself and said nothing about it, so the item has no file and the report reads as though it does",
    ).toBe(2);
  });

  it("does not write over a file it never wrote", async () => {
    harness = await folderHarness("folder-unbound-file", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000011",
              properties: { title: "note", body: "the item\n" },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000012",
              properties: { title: "other", body: "the other item\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    // A note made and not yet scanned. `folders pull` runs no scan of its
    // own, so this is a person who typed something and then pulled.
    put(harness, "note.md", "---\ntitle: Mine\n---\nan afternoon of it\n");

    const pulled = await harness.folder.pull();
    expect(
      pulled.ok,
      `the folder could not pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.written,
      "the pull wrote nothing at all, so a folder that never writes would satisfy everything below",
    ).toBeGreaterThan(0);
    expect(
      read(harness, "note.md"),
      "the pull wrote an item over a file the folder had never written, so an afternoon's typing went with no queue row and no line in the report",
    ).toContain("an afternoon of it");
    expect(
      pulled.value.unwritten,
      "the folder left the file alone and said nothing about it, so the item it could not write reads as an ordinary quiet pull",
    ).toBeGreaterThan(0);
  });

  it("takes back a file of its own the mapping had lost", async () => {
    const rows = {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000013",
            properties: { title: "note", body: "the item\n" },
          },
        },
      ],
    };
    harness = await folderHarness("folder-recover-a", { rows });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    // The bytes this item renders to, which only this item can render: the
    // render carries its id. A second folder on the same item stands in for
    // the folder whose mapping lost the file — a write that made the file and
    // failed before the bytes landed unbinds exactly this way.
    const bytes = read(harness, "note.md");
    expect(bytes, "the first folder wrote nothing to copy").toContain(
      "01a00000-0000-7000-8000-000000000013",
    );

    second = await folderHarness("folder-recover-b", { rows });
    scriptFolderWrites(second);
    writeFileSync(join(second.dir, "note.md"), bytes);
    const pulled = await second.folder.pull();
    expect(
      pulled.ok,
      `the folder could not pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.unwritten,
      "the folder refused its own file because the mapping had lost it, so the item has no file and will never be given one",
    ).toBe(0);
    expect(
      pulled.value.unchanged,
      "the folder neither wrote the file nor took it back, so the assertion below is about a binding nothing made",
    ).toBe(1);

    // The binding is what this is for: without it the next scan makes the
    // file a second item.
    const scanned = await second.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "the file the folder had written became a second item, because nothing bound it back",
    ).toBe(0);
  });

  it("leaves a file outside the slice alone", async () => {
    harness = await folderHarness("folder-outside-slice", {
      slice: { types: ["core.note"], defaultType: "core.note" },
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              properties: { title: "served", body: "in the slice\n" },
            },
          },
          // An item of a type this folder does not hold, arriving through
          // the same page. Without one the pull's own slice rule is never
          // exercised, and the assertion below is about the push half only.
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000b",
              type: "core.bookmark",
              properties: { title: "outside", body: "not in the slice\n" },
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
      sentTitles(harness),
      "the file outside the slice reached the server",
    ).toEqual(["Inside"]);
    expect(
      readFileSync(join(harness.dir, "photo.png"), "utf8"),
      "the folder rewrote a file it does not carry",
    ).toBe("not text at all");

    // The pull half: an item outside the slice does not become a file.
    expect(
      existsSync(join(harness.dir, "outside.md")),
      "an item of a type this folder does not hold became a file in it, so a folder declaring one type writes every type it is sent",
    ).toBe(false);
    expect(
      pushed.value.pull?.skipped,
      "the pull reported skipping nothing, so the absence above is a pull that wrote nothing at all",
    ).toBeGreaterThan(0);
    expect(
      existsSync(join(harness.dir, "served.md")),
      "the item inside the slice did not become a file either, so the folder is writing nothing rather than choosing",
    ).toBe(true);
  });
});

describe("what a pull does with a file whose item left the slice", () => {
  const departed = {
    id: "01a00000-0000-7000-8000-0000000000d1",
    properties: { title: "going", body: "body\n" },
  };

  /** A folder holding one item, and a stream that archives it. */
  async function departure(label: string): Promise<FolderHarness> {
    return folderHarness(label, {
      rows: { "core.note": [{ item: departed }] },
      // The server archives it: the row leaves the state the pull writes
      // (`device.md` 31) while the copy still holds it (32).
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.state_changed",
            wireItem({ ...departed, version: 2, state: "archived" }),
          ),
        ]),
      ],
    });
  }

  it("takes away the file of an item that left the slice, and journals nothing", async () => {
    harness = await departure("folder-departed");
    scriptFolderWrites(harness);
    const first = await harness.folder.pull();
    expect(first.ok && first.value.written).toBe(1);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);

    const caught = await harness.folder.device().catchUp();
    expect(
      caught.ok ? caught.value.applied : 0,
      `the archive event was not applied, so nothing below is about a departure: ${JSON.stringify(caught)}`,
    ).toBe(1);

    const second = await harness.folder.pull();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      second.value.removed,
      "the item left the slice and its file stayed, bound and unmaintained, for the next scan to push back as an edit to a row the person cannot see",
    ).toBe(1);
    expect(second.value.kept).toBe(0);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);

    // The journal was not involved and nothing was queued. A journaled
    // path becomes a delete once the grace runs out (`folders.md` 15), so
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
      "the departed file was journaled, and the grace turned it into a delete of an item the person cannot see",
    ).toEqual([]);
  });

  it("keeps a file the folder never wrote whose create was refused, inside one push", async () => {
    // The scan binds the person's own bytes and queues the create; the
    // server refuses it; the drain reads the row back, finds nothing and
    // forgets it; the pull that ends the same push then meets a bound file
    // whose item the copy no longer holds. Its bytes match the mapping,
    // because the scan recorded them, and they are the person's.
    harness = await folderHarness("folder-refused-create");
    scriptWrites(harness.server, {
      create: [refusal(400, "invalid_properties", "the body is not allowed")],
      read: [refusal(404, "item_not_found", "no such item")],
    });
    put(harness, "mine.md", "---\ntitle: Mine\n---\nthe person's own words\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.drain.verdicts[0]?.verdict).toBe("refused");
    expect(
      pushed.value.pull?.removed,
      "the pull took away a file the folder never wrote, and the person's words with it",
    ).toBe(0);
    expect(pushed.value.pull?.kept).toBe(1);
    expect(read(harness, "mine.md")).toContain("the person's own words");

    // Still bound, so the next scan neither makes a second item of it nor
    // queues the refused create again, and it says so; the push's own report
    // is what said the create was refused, and an edit to the file queues it
    // again (`folders.md` 32).
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
    // Still bound: the next scan meets the edit as a change to the row the
    // copy holds, rather than making a second item from the file.
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.value.created).toBe(0);
    expect(scanned.value.updated).toBe(1);
  });
});

describe("a file that is not a document", () => {
  const photo = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
  ]);
  const slice = {
    types: ["core.note", "core.file"],
    defaultType: "core.note",
  };

  it("pushes a file that is not a document as a file item, its bytes uploaded first", async () => {
    harness = await folderHarness("folder-file-push", { slice });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "photo.png"), photo);
    put(harness, "note.md", "---\ntitle: A note\n---\nbeside a photo\n");
    // Empty, so no blob the server holds: left alone rather than pushed.
    writeFileSync(join(harness.dir, "blank.png"), Buffer.alloc(0));
    // A subtype the server does not register: a file all the same.
    writeFileSync(join(harness.dir, "song.mp3"), Buffer.from("ID3 a song"));
    const scanned = await harness.folder.scan();
    expect(
      scanned.ok,
      `the folder could not scan: ${JSON.stringify(scanned)}`,
    ).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "the photo was not pushed, so a file dropped beside the notes never leaves the machine",
    ).toBe(3);
    expect(
      scanned.value.skipped,
      "an empty file was pushed, and the server refuses an empty blob",
    ).toBe(1);
    const waiting = await harness.folder.device().queue();
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    const photoUpload = waiting.value.find(
      (row) => row.kind === "upload_blob" && row.blob === hashOf(photo),
    );
    expect(
      waiting.value.some(
        (row) =>
          row.kind === "create_item" &&
          row.depends_on.includes(photoUpload?.id ?? "none"),
      ),
      "the photo's file item does not wait on its upload, so it can reach the server naming bytes the server has not been sent",
    ).toBe(true);
    const pushed = await harness.folder.push();
    expect(
      pushed.ok,
      `the folder could not push: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    if (!pushed.ok) return;
    expect(sentTitles(harness)).not.toContain("blank.png");
    expect(
      sentCreates(harness).find(
        (create) =>
          (create.properties as Record<string, unknown>).title === "song.mp3",
      )?.type,
      "a file whose subtype the server does not register was not pushed as a file",
    ).toBe("core.file");

    const file = sentCreates(harness).find(
      (create) =>
        (create.properties as Record<string, unknown>).title === "photo.png",
    );
    expect(
      file,
      "no item was created for the photo under its path",
    ).toBeDefined();
    expect(file?.type).toBe("core.file.image");
    const fileId = String(file?.id);
    expect(
      [typeof file?.id, file?.source_id],
      "the file item's create carried no id of the device's own, or carried a natural key",
    ).toEqual(["string", undefined]);
    expect(file?.properties).toMatchObject({
      blob_ref: hashOf(photo),
      mime_type: "image/png",
      title: "photo.png",
    });
    const order = harness.server.requests
      .filter((request) => request.method === "POST")
      .map((request) =>
        request.pathname === "/items"
          ? `/items ${String((JSON.parse(request.body) as { properties: { title?: string } }).properties.title)}`
          : request.pathname,
      );
    expect(
      order.indexOf("/blobs"),
      "the file item went out before the bytes it names",
    ).toBeLessThan(order.indexOf("/items photo.png"));
    expect(
      harness.server.requests.find((request) => request.pathname === "/blobs")
        ?.raw,
    ).toEqual(photo);
    expect(
      readFileSync(join(harness.dir, "photo.png")),
      "the pull that ended the push rewrote the photo",
    ).toEqual(photo);

    // New bytes are a new upload and an update naming them, the update
    // waiting on the upload.
    const edited = Buffer.concat([photo, Buffer.from([2])]);
    writeFileSync(join(harness.dir, "photo.png"), edited);
    expect((await harness.folder.scan()).ok).toBe(true);
    const updating = await harness.folder.device().queue();
    expect(updating.ok).toBe(true);
    if (!updating.ok) return;
    const editUpload = updating.value.find(
      (row) => row.kind === "upload_blob" && row.blob === hashOf(edited),
    );
    expect(
      updating.value.find(
        (row) => row.kind === "update_item" && row.verdict === null,
      )?.depends_on,
      "the update naming new bytes does not wait on their upload",
    ).toContain(editUpload?.id);
    const again = await harness.folder.push();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      harness.server.requests.filter((request) => request.method === "PATCH")
        .length,
    ).toBeGreaterThan(0);
    const uploads = harness.server.requests.filter(
      (request) => request.pathname === "/blobs",
    );
    expect(uploads.at(-1)?.raw).toEqual(edited);
    const patch = harness.server.requests.find(
      (request) =>
        request.method === "PATCH" && request.pathname === `/items/${fileId}`,
    );
    expect(
      (JSON.parse(patch?.body ?? "{}") as { properties?: unknown }).properties,
      "the update did not name the new bytes, so the item still names the old file",
    ).toMatchObject({ blob_ref: hashOf(edited) });

    // A move alone: the title the folder gave it follows the new name, and
    // the bytes, unchanged, are not sent again.
    const uploadsBefore = harness.server.requests.filter(
      (request) => request.pathname === "/blobs",
    ).length;
    renameSync(join(harness.dir, "photo.png"), join(harness.dir, "moved.png"));
    const moved = await harness.folder.push();
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.scan.renamed).toBe(1);
    const rename = harness.server.requests
      .filter(
        (request) =>
          request.method === "PATCH" && request.pathname === `/items/${fileId}`,
      )
      .at(-1);
    const renamed = JSON.parse(rename?.body ?? "{}") as Record<string, unknown>;
    expect(
      renamed,
      "the move did not carry the title the folder gave the file",
    ).toMatchObject({ properties: { title: "moved.png" } });
    expect(renamed).not.toHaveProperty("source_id");
    expect(
      harness.server.requests.filter((request) => request.pathname === "/blobs")
        .length,
      "a move alone sent the unchanged bytes again",
    ).toBe(uploadsBefore);
  });

  it("writes a file item's bytes as its file, and reports them absent where it cannot fetch them", async () => {
    const bytes = photo;
    const hash = hashOf(bytes);
    const other = Buffer.from("the bytes another file item names\n");
    harness = await folderHarness("folder-file-pull", {
      slice,
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f1",
              type: "core.file.image",
              properties: {
                title: "photo.png",
                blob_ref: hash,
                mime_type: "image/png",
              },
            },
          },
          // Its link serves bytes that are not the ones it names, so its
          // file can never be written; the photo beside it still is.
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f2",
              type: "core.file",
              properties: {
                title: "broken.txt",
                blob_ref: hashOf(other),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, bytes);
    scriptBlob(harness.server, other, Buffer.from("not those bytes\n"));

    await harness.server.offline();
    const offline = await harness.folder.pull();
    expect(
      offline.ok,
      `a pull that could not fetch one file's bytes failed as a whole: ${JSON.stringify(offline)}`,
    ).toBe(true);
    if (!offline.ok) return;
    expect(
      offline.value.absent,
      "a file item whose bytes could not be had was not reported",
    ).toBe(2);
    expect(
      existsSync(join(harness.dir, "photo.png")),
      "the pull wrote a file for bytes it does not have",
    ).toBe(false);

    // The witness: the same pull with the server back writes the bytes, so
    // the absence above was the bytes and not a pull that writes no files.
    await harness.server.online();
    const pulled = await harness.folder.pull();
    expect(
      pulled.ok,
      `one file whose bytes could not be written failed the whole pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(1);
    expect(pulled.value.absent).toBe(1);
    expect(readFileSync(join(harness.dir, "photo.png"))).toEqual(bytes);
    expect(existsSync(join(harness.dir, "broken.txt"))).toBe(false);

    // Its own write is not read back as a change (`folders.md` 14).
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.unchanged,
      "the file the pull wrote was read back as a change to push",
    ).toBe(1);
    expect(scanned.value.created + scanned.value.updated).toBe(0);

    // A file the folder already holds the bytes of needs no server at all,
    // nor the copy of them beside the working copy.
    rmSync(
      join(
        harness.dir,
        ".marfa",
        "core.sqlite.blobs",
        hash.slice("sha256:".length),
      ),
    );
    await harness.server.offline();
    const again = await harness.folder.pull();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      again.value.unchanged,
      "a file already on the disk was fetched again, and reported absent with the server away",
    ).toBe(1);
    await harness.server.online();
  });

  it("ends a pull whose credential is refused, rather than counting each file absent", async () => {
    const hash = hashOf(photo);
    harness = await folderHarness("folder-file-credential", {
      slice,
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f3",
              type: "core.file.image",
              properties: {
                title: "photo.png",
                blob_ref: hash,
                mime_type: "image/png",
              },
            },
          },
        ],
      },
    });
    harness.server.answer(
      "GET",
      `/blobs/${hash}/url`,
      refusal(401, "unauthorized", "no credential"),
    );
    const refused = await harness.folder.pull();
    expect(
      refused.ok,
      "a refused credential was counted as one absent file, and every other file would be too",
    ).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("unauthorized");
  });

  it("writes an item carrying a blob_ref outside the file types as a document", async () => {
    const unfetched = hashOf(Buffer.from("not fetched"));
    const bytes = Buffer.from("the bytes a file item names\n");
    harness = await folderHarness("folder-file-not-a-file", {
      slice: {
        types: ["core.note", "core.bookmark", "core.file"],
        defaultType: "core.note",
      },
      rows: {
        "core.bookmark": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000b1",
              type: "core.bookmark",
              properties: { title: "Budget.xlsx", blob_ref: unfetched },
            },
          },
        ],
        // A file item beside it, whose bytes the same pull fetches.
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000b2",
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hashOf(bytes),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, bytes);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(2);
    expect(
      existsSync(join(harness.dir, "Budget.xlsx.md")),
      "an item of a type that is not a file was written under a file's name, so the next scan would not read it as the document it is",
    ).toBe(true);
    const fetched = (hash: string) =>
      harness!.server.requests.some((request) =>
        request.pathname.startsWith(`/blobs/${hash}`),
      );
    // The witness: the same pull fetched the file item's bytes.
    expect(
      fetched(hashOf(bytes)),
      "the pull fetched no bytes at all, so nothing here is about the bookmark",
    ).toBe(true);
    expect(readFileSync(join(harness.dir, "notes.txt"))).toEqual(bytes);
    expect(
      fetched(unfetched),
      "the pull fetched bytes for an item that is not a file",
    ).toBe(false);
  });

  it("keeps a title somebody set when the file moves", async () => {
    const id = "01a00000-0000-7000-8000-0000000000f4";
    const row = {
      id,
      type: "core.file.image",
      properties: {
        title: "photo.png",
        blob_ref: hashOf(photo),
        mime_type: "image/png",
      },
    };
    harness = await folderHarness("folder-file-titled", {
      slice,
      rows: { "core.file": [{ item: row }] },
      // Somebody retitles the item once its file is written.
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              ...row,
              version: 2,
              properties: { ...row.properties, title: "Holiday" },
            }),
          ),
        ]),
      ],
    });
    scriptBlob(harness.server, photo);
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    expect((await harness.folder.pull()).ok).toBe(true);
    // The file keeps its name, which is no longer the item's title.
    expect(readFileSync(join(harness.dir, "photo.png"))).toEqual(photo);
    renameSync(join(harness.dir, "photo.png"), join(harness.dir, "moved.png"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witness: the move was followed.
    expect(pushed.value.scan.renamed).toBe(1);
    expect(
      sentUpdates(harness),
      "a move wrote the file's name over a title somebody gave the item",
    ).toEqual([]);
  });

  it("keeps the file of an item whose new bytes cannot be had", async () => {
    const hash = hashOf(photo);
    const later = Buffer.concat([photo, Buffer.from("later")]);
    const row = {
      id: "01a00000-0000-7000-8000-0000000000f5",
      type: "core.file.image",
      properties: {
        title: "photo.png",
        blob_ref: hash,
        mime_type: "image/png",
      },
    };
    harness = await folderHarness("folder-file-kept", {
      slice,
      rows: { "core.file": [{ item: row }] },
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              ...row,
              version: 2,
              properties: { ...row.properties, blob_ref: hashOf(later) },
            }),
          ),
        ]),
      ],
    });
    scriptBlob(harness.server, photo);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect((await harness.folder.device().catchUp()).ok).toBe(true);

    await harness.server.offline();
    const pulled = await harness.folder.pull();
    await harness.server.online();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.absent).toBe(1);
    expect(
      readFileSync(join(harness.dir, "photo.png")),
      "the file of an item still held was taken away because its new bytes could not be fetched",
    ).toEqual(photo);
  });

  it("holds a file's move behind an edit of its bytes that waits on their upload", async () => {
    const id = "01a00000-0000-7000-8000-0000000000f7";
    const text = Buffer.from("plain text a server holds as a file\n");
    harness = await folderHarness("folder-file-move-behind-bytes", {
      slice,
      rows: {
        "core.file": [
          {
            item: {
              id,
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hashOf(text),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, text);
    const rows = scriptFolderWrites(harness);
    // The first upload fails the way a busy server does; the rest land.
    harness.server.answer("POST", "/blobs", answers.serverFault());
    acceptUploads(harness.server);
    expect((await harness.folder.pull()).ok).toBe(true);

    // New bytes, whose edit waits on their upload, then a move of the same
    // file, which is an edit of the same row waiting on nothing.
    const edited = Buffer.from("plain text, edited\n");
    writeFileSync(join(harness.dir, "notes.txt"), edited);
    expect((await harness.folder.scan()).ok).toBe(true);
    renameSync(join(harness.dir, "notes.txt"), join(harness.dir, "moved.txt"));
    expect((await harness.folder.scan()).ok).toBe(true);

    expect((await harness.folder.push()).ok).toBe(true);
    const held = await harness.folder.device().queue();
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(
      held.value
        .filter((row) => row.kind === "update_item")
        .map((row) => [row.verdict, row.reason]),
      "the move went out ahead of the edit of the bytes, which was waiting on their upload",
    ).toEqual([
      ["blocked", "awaiting_dependency"],
      ["blocked", "awaiting_dependency"],
    ]);

    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      harness.server.requests
        .filter(
          (request) =>
            request.method === "PATCH" && request.pathname === `/items/${id}`,
        )
        .map(
          (request) =>
            (JSON.parse(request.body) as { version?: unknown }).version,
        ),
    ).toEqual([1, 2]);
    expect([
      rows.get(id)?.properties.title,
      rows.get(id)?.properties.blob_ref,
    ]).toEqual(["moved.txt", hashOf(edited)]);
  });

  it("holds a file's second move behind its first, which had no answer, though the bytes between them are refused", async () => {
    const id = "01a00000-0000-7000-8000-0000000000f8";
    const text = Buffer.from("plain text a server holds as a file\n");
    harness = await folderHarness("folder-move-behind-refused-bytes", {
      slice,
      rows: {
        "core.file": [
          {
            item: {
              id,
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hashOf(text),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, text);
    // The first edit meets a busy server; the rest reach the door. The
    // server refuses the new bytes outright.
    harness.server.answer("PATCH", /^\/items\/[^/]+$/, answers.serverFault());
    const rows = scriptFolderWrites(harness);
    harness.server.answer(
      "POST",
      "/blobs",
      refusal(400, "validation_error", "not bytes this server takes"),
    );
    expect((await harness.folder.pull()).ok).toBe(true);

    // A move, new bytes, and a second move, each scanned before any drain.
    renameSync(join(harness.dir, "notes.txt"), join(harness.dir, "first.txt"));
    expect((await harness.folder.scan()).ok).toBe(true);
    writeFileSync(join(harness.dir, "first.txt"), "plain text, edited\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    renameSync(join(harness.dir, "first.txt"), join(harness.dir, "second.txt"));
    expect((await harness.folder.scan()).ok).toBe(true);

    const device = harness.folder.device();
    expect((await device.drain()).ok).toBe(true);
    const patches = (): unknown[] =>
      harness?.server.requests
        .filter(
          (request) =>
            request.method === "PATCH" && request.pathname === `/items/${id}`,
        )
        .map(
          (request) =>
            (JSON.parse(request.body) as { version?: unknown }).version,
        ) ?? [];
    const edits = async () => {
      const queued = await device.queue();
      expect(queued.ok).toBe(true);
      return queued.ok
        ? queued.value
            .filter((row) => row.kind === "update_item")
            .map((row) => [row.verdict, row.reason])
        : [];
    };
    expect(
      await edits(),
      "the second move went out beside the first, which had no answer, because the edit of the bytes between them was refused and stepped out of line",
    ).toEqual([
      [null, null],
      ["blocked", "awaiting_dependency"],
      ["blocked", "awaiting_dependency"],
    ]);
    expect(patches()).toEqual([1]);

    // With the first answered, the bytes' edit is refused with its upload
    // and the second move goes, on the first's answer.
    expect((await device.drain()).ok).toBe(true);
    expect((await edits()).map(([verdict]) => verdict)).toEqual([
      "accepted",
      "refused",
      "accepted",
    ]);
    expect(patches()).toEqual([1, 1, 2]);
    expect(rows.get(id)?.properties.title).toBe("second.txt");
  });

  it("holds a file's move behind an edit of its bytes that cannot be opened for now", async () => {
    const id = "01a00000-0000-7000-8000-0000000000f9";
    const text = Buffer.from("plain text a server holds as a file\n");
    harness = await folderHarness("folder-file-move-behind-locked-bytes", {
      slice,
      rows: {
        "core.file": [
          {
            item: {
              id,
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hashOf(text),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, text);
    const rows = scriptFolderWrites(harness);
    acceptUploads(harness.server);
    expect((await harness.folder.pull()).ok).toBe(true);

    // New bytes, whose edit waits on their upload, then a move of the file.
    const edited = Buffer.from("plain text, edited and locked\n");
    writeFileSync(join(harness.dir, "notes.txt"), edited);
    expect((await harness.folder.scan()).ok).toBe(true);
    renameSync(join(harness.dir, "notes.txt"), join(harness.dir, "moved.txt"));
    expect((await harness.folder.scan()).ok).toBe(true);

    // The bytes held beside the store cannot be opened for this drain.
    const device = harness.folder.device();
    const heldAt = `${device.store}.blobs/${hashOf(edited).slice("sha256:".length)}`;
    chmodSync(heldAt, 0o000);
    try {
      const drained = await device.drain();
      expect(drained.ok, JSON.stringify(drained)).toBe(true);
      if (!drained.ok) return;
      const held = await device.queue();
      expect(held.ok).toBe(true);
      if (!held.ok) return;
      // The witness: the upload was tried, met bytes it could not open, and
      // was left unanswered.
      expect(
        drained.value.verdicts.find((row) => row.kind === "upload_blob")
          ?.reason ?? "",
        "the upload was never tried, so nothing here waited on bytes that could not be opened",
      ).toContain(`the bytes of ${hashOf(edited)} could not be opened`);
      expect(
        held.value.find((row) => row.kind === "upload_blob")?.verdict,
      ).toBe(null);
      expect(
        held.value
          .filter((row) => row.kind === "update_item")
          .map((row) => [row.verdict, row.reason]),
        "the move went out ahead of the edit of the bytes, which waits on bytes that could not be opened",
      ).toEqual([
        ["blocked", "awaiting_dependency"],
        ["blocked", "awaiting_dependency"],
      ]);
    } finally {
      chmodSync(heldAt, 0o644);
    }

    expect((await device.drain()).ok).toBe(true);
    expect([
      rows.get(id)?.properties.title,
      rows.get(id)?.properties.blob_ref,
    ]).toEqual(["moved.txt", hashOf(edited)]);
  });

  it("sends an edited file item named like a document as bytes", async () => {
    const text = Buffer.from("plain text a server holds as a file\n");
    const hash = hashOf(text);
    harness = await folderHarness("folder-file-text", {
      slice,
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f6",
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hash,
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, text);
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(readFileSync(join(harness.dir, "notes.txt"))).toEqual(text);

    const edited = Buffer.from("plain text, edited\n");
    writeFileSync(join(harness.dir, "notes.txt"), edited);
    expect((await harness.folder.push()).ok).toBe(true);
    const upload = harness.server.requests.find(
      (request) => request.pathname === "/blobs",
    );
    expect(
      upload?.raw,
      "an edited file item named like a document was not sent as bytes",
    ).toEqual(edited);
    const patch = JSON.parse(
      harness.server.requests.find((request) => request.method === "PATCH")
        ?.body ?? "{}",
    ) as { properties?: Record<string, unknown> };
    expect(patch.properties).toMatchObject({ blob_ref: hashOf(edited) });
    expect(
      patch.properties?.body,
      "the file's text was sent as a document's body",
    ).toBeUndefined();
  });
});
