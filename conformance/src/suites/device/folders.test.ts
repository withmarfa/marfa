import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  itemEvent,
  refusal,
  replay,
  wireItem,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import {
  FOLDER_SOURCE,
  KEY,
  acceptUploads,
  folderHarness,
  hashOf,
  requireBinary,
  scriptBlob,
  scriptWrites,
} from "./harness.js";
import { CliFolder } from "../../device/cli-adapter.js";
import {
  FolderDoor,
  type DoorCreate,
  type DoorRow,
} from "../../device/folder-door.js";
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

/** What each folder's scripted server answered its creates with, in order. */
const answeredCreates = new WeakMap<
  FolderHarness["server"],
  Array<{ id: string; source_id: string | null }>
>();

/**
 * Answers for every door a folder's drain can reach, the item doors deciding
 * as the real server does (`FolderDoor`, which `fidelity.test.ts` holds to the
 * server's decisions): a create naming a pair a row holds lands on that row
 * and answers `200` with it, unless its version is not the row's; one whose
 * `id` is not that row is refused; one naming no `id` is given one the server
 * mints; one naming a source the key does not claim is refused for it.
 *
 * Returns what the door holds for each item, so a fixture can ask what each
 * ended up holding. Asserting on the natural keys alone cannot tell a swap
 * that moved two names from one that moved two names and crossed the bodies
 * over.
 */
function scriptFolderWrites(
  harness: FolderHarness,
  options: {
    claims?: (source: string) => boolean;
    reads?: (type: string) => boolean;
  } = {},
): Map<string, DoorRow> {
  // The type, source, natural key and version of each row the hydration
  // served, so a write to one is answered with what the real server keeps
  // rather than a default: a PATCH moves none of the first three unless it
  // names the key, and a create naming a served row's pair lands on it.
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
    options.claims,
    options.reads,
  );
  const created: Array<{ id: string; source_id: string | null }> = [];
  answeredCreates.set(harness.server, created);
  scriptWrites(harness.server, {
    create: [
      (request) => {
        const decided = door.create(JSON.parse(request.body) as DoorCreate);
        if (decided.minted !== undefined) {
          created.push({
            id: decided.minted,
            source_id: door.rows.get(decided.minted)?.source_id ?? null,
          });
        }
        return decided.answer;
      },
    ],
    update: [
      (request) =>
        door.update(
          request.pathname.split("/").at(-1) ?? "unknown",
          JSON.parse(request.body) as {
            properties?: Record<string, unknown>;
            source_id?: string;
            version: number;
          },
          { resolve: request.query.get("conflict") === "auto" },
        ),
    ],
    // A device reads a row by id to hold one a refusal named, and to
    // reconcile after a refusal.
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

/**
 * Which item the server made for each natural key the folder created under,
 * by the id it answered with: a create carrying a natural key names no id of
 * its own (`queue-and-verdicts.md` 38).
 */
function keysByItem(harness: FolderHarness): Map<string, string> {
  return new Map(
    (answeredCreates.get(harness.server) ?? []).map((row) => [
      row.id,
      row.source_id ?? "",
    ]),
  );
}

function itemFor(started: Map<string, string>, key: string): string {
  const found = [...started].find(([, held]) => held === key);
  return found?.[0] ?? `no item was created under ${key}`;
}

/**
 * Every natural key the folder sent, replayed against who held what.
 *
 * A key another item still holds is one the server refuses, so the folder
 * has to free it first (`folders.md` 24). The scripted server cannot refuse
 * one, which is exactly why this reads the requests rather than the answers.
 */
function replayKeys(
  harness: FolderHarness,
  started: Map<string, string>,
): { collisions: string[]; ended: Map<string, string> } {
  const ended = new Map(started);
  const collisions: string[] = [];
  for (const request of harness.server.requests) {
    if (request.method !== "PATCH") continue;
    if (!/^\/items\/[^/]+$/.test(request.pathname)) continue;
    const id = request.pathname.split("/").at(-1) ?? "";
    const body = JSON.parse(request.body) as { source_id?: string };
    if (body.source_id === undefined) continue;
    const taken = [...ended].find(
      ([other, key]) => other !== id && key === body.source_id,
    );
    if (taken)
      collisions.push(`${id} -> ${body.source_id} (held by ${taken[0]})`);
    ended.set(id, body.source_id);
  }
  return { collisions, ended };
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
    const body = (text: string) => ({ title: "Source", body: text });
    harness = await folderHarness("folder-declined-link", {
      rows: {
        "core.note": [
          {
            item: {
              id: source,
              source_id: "source.md",
              properties: body("see [[target]] for more\n"),
            },
          },
          {
            item: {
              id: target,
              source_id: "target.md",
              properties: { title: "Target", body: "the other end\n" },
            },
          },
          {
            item: {
              id: other,
              source_id: "other.md",
              properties: { title: "Other", body: "another end\n" },
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
              source_id: "source.md",
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

    // The edge stays (21), and the link does not come back.
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
    // its edge goes (21), and an edge of another kind to the same item,
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
              source_id: "from-server.md",
              properties: { title: "From the server", body: "no link here\n" },
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
              source_id: "the-target.md",
              properties: { title: "The target", body: "the other end\n" },
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
    // The control first, and it is what makes the case below mean anything:
    // a file the folder *does* remember, moved, is followed. Without it the
    // assertion that a different file is not followed would hold just as
    // well against a folder that follows nothing at all.
    renameSync(join(harness.dir, "first.md"), join(harness.dir, "moved.md"));
    const followed = await harness.folder.scan();
    expect(followed.ok).toBe(true);
    if (!followed.ok) return;
    expect(
      followed.value.renamed,
      "the folder followed no rename at all, so the case below says nothing about identity",
    ).toBe(1);

    // Now a different file, in the place the folder last saw one. On this
    // filesystem it gets a fresh inode; on one that reuses inodes it may
    // get the old one, and the birth time is the only thing that tells
    // them apart.
    rmSync(join(harness.dir, "moved.md"));
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

  it("resolves identity over the files it holds, not every file in the tree", async () => {
    harness = await folderHarness("folder-unheld-identity");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nsame bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // A hard link is the same inode under a second name, so the two paths
    // have one identity. The folder does not hold a `.mov`, and a file it
    // never touches should not be able to take the identity of one it does.
    linkSync(join(harness.dir, "note.md"), join(harness.dir, "clip.mov"));
    renameSync(join(harness.dir, "note.md"), join(harness.dir, "moved.md"));

    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.skipped,
      "the walk never saw the unheld file, so nothing here could have taken the note's identity and the assertions below are about nothing",
    ).toBeGreaterThan(0);
    expect(
      scanned.value.renamed,
      "a file the folder does not hold took the identity of one it does, so renaming the note lost it",
    ).toBe(1);
    expect(
      scanned.value.created,
      "the renamed note became a second item because an unheld file shared its identity, which is a duplicate anybody with a backup tool can make",
    ).toBe(0);
  });

  it("binds the same file to the same item whether it was present at start or arrived while running", async () => {
    // **One of these is a real watcher.** The other pushes a file that was
    // there before anything ran. Two identity rules — one on the startup
    // path and one on the live path — would make the same bytes at the same
    // path two different items depending on when they appeared, and a
    // fixture that drove both through `scan` would never find out.
    const text = "---\ntitle: Same bytes\n---\nidentical\n";
    harness = await folderHarness("folder-at-start");
    second = await folderHarness("folder-while-running");
    scriptFolderWrites(harness);
    scriptFolderWrites(second);

    put(harness, "note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);

    const watching = second.folder.watch();
    try {
      // It starts on an empty directory, which is the state a watcher
      // begins in, and the file arrives while it is running.
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
            sentKeys(second!),
            `the watcher never pushed the file that arrived while it was running: ${watching.stderr}`,
          ).toEqual(["note.md"]);
        },
        { timeout: 20_000, interval: 250 },
      );
    } finally {
      await watching.stop();
    }

    const atStart = sentKeys(harness);
    const whileRunning = sentKeys(second);
    expect(
      atStart,
      "the file present at start reached a different natural key than the same file arriving to a running watcher, so one file is two items depending on when it appeared",
    ).toEqual(whileRunning);
    expect(atStart.length).toBe(1);
  });

  it("binds one file to one item across two separately enrolled devices", async () => {
    // The same file in the same place on two machines, each with its own
    // credential and both folders naming one source. The natural key is that
    // source and the path, nothing about the machine, so both name one item.
    const text = "---\ntitle: Shared\n---\nthe same file\n";
    const slice = { types: ["core.note"], defaultType: "core.note" };
    // What the server serves a hydration, added to as the first machine's
    // create lands, so the second machine's copy holds it.
    const served: Record<string, Array<{ item: WireItemOptions }>> = {};
    harness = await folderHarness("folder-machine-one", {
      slice: { ...slice, source: "notes" },
      rows: served,
    });
    const held = scriptFolderWrites(harness);
    put(harness, "shared/note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);
    const [first, row] = [...held][0] ?? [];
    expect(
      first,
      "the first machine's create never reached the server",
    ).toBeDefined();
    served["core.note"] = [
      {
        item: {
          id: first,
          version: 1,
          source: "notes",
          source_id: "shared/note.md",
          properties: row?.properties ?? {},
        },
      },
    ];

    second = await folderHarness("folder-machine-two", {
      slice: { ...slice, source: "notes" },
      sharing: { server: harness.server, key: "mk_second_machine" },
    });
    put(second, "shared/note.md", text);
    expect((await second.folder.push()).ok).toBe(true);

    const creates = harness.server.requests
      .filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      )
      .map((request) => ({
        key: request.headers.authorization,
        sent: JSON.parse(request.body) as {
          source?: string;
          source_id?: string;
          version?: number;
        },
      }));
    // The witness: two machines, two credentials.
    expect(new Set(creates.map((create) => create.key)).size).toBe(2);
    expect(
      creates.map(({ sent }) => [sent.source, sent.source_id]),
      "the two machines named different natural keys for the same file, so it is two items and neither machine can say why",
    ).toEqual([
      ["notes", "shared/note.md"],
      ["notes", "shared/note.md"],
    ]);
    expect(
      creates[1]?.sent.version,
      "the second machine's create was not conditional on the row its copy holds under that key",
    ).toBe(1);
    const idIn = (folder: FolderHarness) =>
      /marfa_id:\s*(\S+)/.exec(read(folder, "shared/note.md"))?.[1];
    expect(idIn(harness)).toBe(first);
    expect(
      idIn(second),
      "the second machine's file was not bound to the item the first made, so one file is two items",
    ).toBe(first);

    // A folder naming another source keeps an item of its own for the same
    // path, though its copy holds this one's row: the pair decides, not the
    // path.
    const other = await folderHarness("folder-other-source", {
      slice: { ...slice, source: "elsewhere" },
      sharing: { server: harness.server, key: "mk_third_machine" },
    });
    try {
      put(other, "shared/note.md", text);
      expect((await other.folder.push()).ok).toBe(true);
      // The scripted door keys on the pair, so the item below would be the
      // third folder's own even if its create had been based on the other
      // source's row. The version is where a lookup by path alone shows.
      const third = harness.server.requests
        .filter(
          (request) =>
            request.method === "POST" &&
            request.pathname === "/items" &&
            request.headers.authorization === "Bearer mk_third_machine",
        )
        .map(
          (request) =>
            JSON.parse(request.body) as { source?: string; version?: number },
        );
      expect(third.map((sent) => sent.source)).toEqual(["elsewhere"]);
      expect(
        third[0]?.version,
        "the create was based on the row another source holds at this path, so a folder reads another source's row as its own",
      ).toBe(0);
      expect(idIn(other)).toBeDefined();
      expect(
        idIn(other),
        "a folder naming another source was bound to this one's item, so the path alone is the key and every source's notes collide",
      ).not.toBe(first);
    } finally {
      await other.stop();
    }
  });

  it("binds one file to one item when two folders hold it before either pushes", async () => {
    // Two machines, two credentials, one source, and the same note on both
    // before either has pushed: neither copy holds a row under the key, so
    // both creates are conditional on nothing being there (13), and the
    // second is refused because the first landed.
    const slice = { types: ["core.note"], defaultType: "core.note" };
    const mine = "---\ntitle: Shared\n---\nthe same file\n";
    for (const [label, theirs] of [
      ["same", mine],
      ["different", "---\ntitle: Shared\n---\nwritten on the second machine\n"],
    ] as const) {
      const first = await folderHarness(`folder-race-one-${label}`, {
        slice: { ...slice, source: "notes" },
      });
      const other = await folderHarness(`folder-race-two-${label}`, {
        slice: { ...slice, source: "notes" },
        sharing: { server: first.server, key: "mk_second_machine" },
      });
      try {
        const rows = scriptFolderWrites(first);
        put(first, "note.md", mine);
        put(other, "note.md", theirs);
        expect((await first.folder.push()).ok).toBe(true);
        const landed = itemFor(keysByItem(first), "note.md");

        const pushed = await other.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
        if (!pushed.ok) return;
        const create = pushed.value.drain.verdicts.find(
          (entry) => entry.kind === "create_item",
        );
        expect(
          [create?.verdict, create?.reason, create?.item_id],
          "the second machine's create, refused because the first machine's row holds the key, was not settled onto that row",
        ).toEqual(["refused", "ancestor_unavailable", landed]);
        // The file holds bytes the server has not taken, so the pull left it.
        expect(pushed.value.pull.unwritten).toBe(1);
        expect(read(other, "note.md")).toBe(theirs);

        const before = first.server.requests.length;
        const again = await other.folder.push();
        expect(again.ok, JSON.stringify(again)).toBe(true);
        if (!again.ok) return;
        const writes = first.server.requests
          .slice(before)
          .filter((request) => request.method !== "GET")
          .map((request) => ({
            door: `${request.method} ${request.pathname}`,
            sent: JSON.parse(request.body || "{}") as {
              version?: number;
              properties?: Record<string, unknown>;
            },
          }));
        expect(
          again.value.scan.updated,
          "the scan counted a file the server already holds as an edit",
        ).toBe(label === "same" ? 0 : 1);
        // The second push wins, and the report says so: the edit replaces
        // what the other machine wrote, which this one never read.
        expect(
          again.value.scan.overwrote,
          "the scan did not say the edit went over content this machine never read",
        ).toBe(label === "same" ? 0 : 1);
        if (label === "same") {
          expect(
            writes,
            "the second machine sent a file the server already holds, which moves a version for nothing",
          ).toEqual([]);
        } else {
          expect(
            writes.map((write) => write.door),
            "what the second machine's file holds never reached the server, or went as a create again",
          ).toEqual([`PATCH /items/${landed}`]);
          expect(
            writes[0]?.sent.version,
            "the edit was not based on the version the server answered with",
          ).toBe(1);
          expect(rows.get(landed)?.properties.body).toBe(
            "written on the second machine\n",
          );
        }
        // One item on the server and one in each copy, bound to it.
        expect(
          [...rows.values()].filter(
            (row) => row.source === "notes" && row.source_id === "note.md",
          ),
          "the two machines made two items of one file",
        ).toHaveLength(1);
        expect(
          /marfa_id:\s*(\S+)/.exec(read(other, "note.md"))?.[1],
          "the second machine's file is not bound to the item the first made",
        ).toBe(landed);
        const held = await other.folder.device().list();
        expect(held.ok && held.value.map((item) => item.id)).toEqual([landed]);

        // And neither folder is jammed: an edit on each goes out as an edit.
        writeFileSync(
          join(other.dir, "note.md"),
          `${read(other, "note.md")}an edit afterwards\n`,
        );
        const edited = await other.folder.push();
        expect(edited.ok, JSON.stringify(edited)).toBe(true);
        expect(edited.ok && edited.value.scan.updated).toBe(1);
        expect(
          edited.ok &&
            edited.value.drain.verdicts.map((entry) => entry.verdict),
        ).toEqual(["accepted"]);
      } finally {
        await other.stop();
        await first.stop();
      }
    }
  });

  it("tells a folder whose key does not claim its source, and sends its files once it does", async () => {
    harness = await folderHarness("folder-unclaimed", {
      slice: {
        types: ["core.note"],
        defaultType: "core.note",
        source: "notes",
      },
    });
    let claimed = false;
    const rows = scriptFolderWrites(harness, { claims: () => claimed });
    put(harness, "a.md", "---\ntitle: A\n---\na\n");
    put(harness, "b.md", "---\ntitle: B\n---\nb\n");
    const creates = () =>
      harness!.server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ).length;

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.drain.verdicts.map((entry) => [entry.verdict, entry.reason]),
      "a create refused for a claim the key does not hold was refused as a write, so the grant would send nothing",
    ).toEqual([
      ["blocked", "credential_refused"],
      ["blocked", "credential_refused"],
    ]);
    expect(
      pushed.value.drain.unclaimed_sources,
      "the folder did not say which source its key does not claim",
    ).toEqual(["notes"]);
    expect(creates(), "each file asked the same question").toBe(1);

    // Meanwhile nothing is jammed: the files stay bound to what they were
    // queued as, and an edit waits for its create.
    writeFileSync(join(harness.dir, "a.md"), "---\ntitle: A\n---\na, edited\n");
    const edited = await harness.folder.push();
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    if (!edited.ok) return;
    expect([edited.value.scan.created, edited.value.scan.updated]).toEqual([
      0, 1,
    ]);
    expect(edited.value.drain.held).toBe(1);
    expect(creates()).toBe(2);
    expect(rows.size, "the server holds a row it refused").toBe(0);

    // The key claims the source: the next push sends both files, and the
    // edit on the version the create was answered with, with no release.
    claimed = true;
    const granted = await harness.folder.push();
    expect(granted.ok, JSON.stringify(granted)).toBe(true);
    if (!granted.ok) return;
    expect(granted.value.drain.unclaimed_sources).toEqual([]);
    expect(
      granted.value.drain.verdicts.map((entry) => entry.verdict),
      "the files were not sent once the key claimed the source",
    ).toEqual(["accepted", "accepted", "accepted"]);
    const keyed = (key: string) =>
      [...rows.values()].find((row) => row.source_id === key);
    expect(keyed("a.md")?.properties.body).toBe("a, edited\n");
    expect(keyed("b.md")?.properties.body).toBe("b\n");
    expect(read(harness, "a.md")).toMatch(/marfa_id:/);
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
    const made = door.keyed(FOLDER_SOURCE, "mine.md") ?? "";
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

  it("keeps a file whose key names a row it may not read to itself, and says so", async () => {
    // Another key wrote a bookmark under this folder's source at the path a
    // file here takes. This key holds notes alone, so the server tells it
    // the key is taken and nothing of the row (`items.md` 5), and the
    // folder holds the file as bound to a row it lost (`folders.md` 30).
    const hidden = "01a00000-0000-7000-8000-0000000000bd";
    harness = await folderHarness("folder-unreadable-row", {
      rows: {
        "core.bookmark": [
          {
            item: {
              id: hidden,
              type: "core.bookmark",
              source_id: "note.md",
              properties: { url: "https://example.com/b", title: "Hidden" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness, { reads: (type) => type === "core.note" });
    put(harness, "note.md", "---\ntitle: Mine\n---\nmine\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.drain.verdicts.map((entry) => [entry.verdict, entry.reason]),
    ).toEqual([["refused", "type_not_permitted"]]);
    expect(
      JSON.stringify(pushed.value),
      "the folder learned of a row its key may not read",
    ).not.toContain(hidden);
    // The refusal is kept whole in the queue, so what it did not say is
    // asserted there: the witness is the code it did carry.
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    const kept = queued.ok
      ? (queued.value.find((row) => row.kind === "create_item")?.answer ?? "")
      : "";
    expect(kept).toContain("type_not_permitted");
    expect(kept, "the refusal named the row's id").not.toContain(hidden);
    expect(kept, "the refusal named the row's type").not.toContain(
      "core.bookmark",
    );
    expect(read(harness, "note.md")).toContain("mine");

    // Not jammed: the file is reported and not sent again, and another file
    // goes as any file does.
    put(harness, "other.md", "---\ntitle: Other\n---\nother\n");
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect([again.value.scan.created, again.value.scan.lost]).toEqual([1, 1]);
    expect(sentCreates(harness).map((create) => create.source_id)).toEqual([
      "note.md",
      "other.md",
    ]);
    expect(again.value.drain.verdicts.map((entry) => entry.verdict)).toEqual([
      "accepted",
    ]);
  });

  it("binds one file item to one item when two folders hold it before either pushes", async () => {
    // The file item's half of the race: its bytes are compared by their
    // name, not its fields, so the same bytes are in step and other bytes
    // go as an upload and an edit of the row the other machine made.
    const slice = {
      types: ["core.note", "core.file"],
      defaultType: "core.note",
    };
    const mine = Buffer.from("the same bytes\n");
    for (const [label, theirs] of [
      ["same", mine],
      ["different", Buffer.from("other bytes, from the second machine\n")],
    ] as const) {
      const first = await folderHarness(`folder-race-file-one-${label}`, {
        slice: { ...slice, source: "notes" },
      });
      const other = await folderHarness(`folder-race-file-two-${label}`, {
        slice: { ...slice, source: "notes" },
        sharing: { server: first.server, key: "mk_second_machine" },
      });
      try {
        const rows = scriptFolderWrites(first);
        acceptUploads(first.server);
        scriptBlob(first.server, mine);
        writeFileSync(join(first.dir, "photo.bin"), mine);
        writeFileSync(join(other.dir, "photo.bin"), theirs);
        expect((await first.folder.push()).ok).toBe(true);
        const landed = itemFor(keysByItem(first), "photo.bin");

        const pushed = await other.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
        if (!pushed.ok) return;
        expect(
          pushed.value.drain.verdicts
            .filter((entry) => entry.kind === "create_item")
            .map((entry) => [entry.verdict, entry.item_id]),
        ).toEqual([["refused", landed]]);

        const before = first.server.requests.length;
        const again = await other.folder.push();
        expect(again.ok, JSON.stringify(again)).toBe(true);
        if (!again.ok) return;
        const writes = first.server.requests
          .slice(before)
          .filter((request) => request.method !== "GET")
          .map((request) => `${request.method} ${request.pathname}`);
        if (label === "same") {
          expect(
            writes,
            "the second machine sent bytes the server already holds",
          ).toEqual([]);
          expect(again.value.scan.overwrote).toBe(0);
        } else {
          expect(writes).toEqual(["POST /blobs", `PATCH /items/${landed}`]);
          expect(rows.get(landed)?.properties.blob_ref).toBe(hashOf(theirs));
          expect(again.value.scan.overwrote).toBe(1);
        }
        expect(readFileSync(join(other.dir, "photo.bin"))).toEqual(theirs);
      } finally {
        await other.stop();
        await first.stop();
      }
    }
  });

  it("refuses a create onto a row somebody trashed, and keeps the file as lost", async () => {
    // A file the folder made, whose item another device deleted: the edit
    // after it goes to a row in the bin and is refused, and the copy loses
    // the row. The next edit makes the file a create again, which the
    // server acknowledges and does not write, because the natural key names
    // the row in the bin (`versions.md` 10).
    harness = await folderHarness("folder-trashed-key");
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
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
    put(harness, "note.md", "---\ntitle: Note\n---\nfirst\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const made = door.keyed(FOLDER_SOURCE, "note.md") ?? "";
    door.trash(made);

    writeFileSync(
      join(harness.dir, "note.md"),
      "---\ntitle: Note\n---\nsecond\n",
    );
    const edited = await harness.folder.push();
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    expect(
      edited.ok && edited.value.drain.verdicts.map((entry) => entry.verdict),
    ).toEqual(["refused"]);

    // The witness: this edit is queued again as a create, and it reaches
    // the server, so the refusal below is the answer to it.
    writeFileSync(
      join(harness.dir, "note.md"),
      "---\ntitle: Note\n---\nthird\n",
    );
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(again.value.scan.requeued).toBe(1);
    expect(sentCreates(harness).map((sent) => sent.source_id)).toEqual([
      "note.md",
      "note.md",
    ]);
    expect(
      again.value.drain.verdicts.map((entry) => [entry.verdict, entry.reason]),
      "a create the server acknowledged and did not write was taken as accepted, so the edit is dropped with nothing saying so",
    ).toEqual([["refused", "trashed"]]);
    // The queue keeps the same reason, which is what a caller reads later
    // (`queue-and-verdicts.md` 12).
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    expect(
      queued.ok &&
        queued.value
          .filter((row) => row.kind === "create_item")
          .map((row) => [row.verdict, row.reason])
          .at(-1),
    ).toEqual(["refused", "trashed"]);
    expect(door.rows.get(made)?.properties.body).toBe("first\n");
    expect(read(harness, "note.md")).toContain("third");

    // The file stays with what it holds, reported as bound to a row that is
    // gone, and nothing more is sent for it.
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect([scanned.value.created, scanned.value.lost]).toEqual([0, 1]);
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
            JSON.parse(request.body) as {
              version: number;
              source_id?: string;
            },
            { resolve: true },
          ),
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    put(harness, "a.md", "---\ntitle: Lost\n---\nnot allowed\n");
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "b.md", "---\ntitle: Live\n---\nlive\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const live = door.keyed(FOLDER_SOURCE, "b.md") ?? "";
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
    expect(door.rows.get(live)?.source_id).toBe("a.md");
    expect(read(harness, "a.md")).toContain(`marfa_id: ${live}`);
  });

  it("asks about an unclaimed source again only now and then while watching", async () => {
    harness = await folderHarness("folder-unclaimed-watch", {
      slice: {
        types: ["core.note"],
        defaultType: "core.note",
        source: "notes",
      },
    });
    scriptFolderWrites(harness, { claims: () => false });
    put(harness, "a.md", "---\ntitle: A\n---\na\n");
    const creates = () =>
      harness!.server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ).length;

    const watching = harness.folder.watch();
    try {
      await vi.waitFor(() => expect(creates()).toBe(1), {
        timeout: 20_000,
        interval: 100,
      });
      // A watcher drains every second. Asking every second would be a
      // refused request a second for as long as nobody grants the claim.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(
        creates(),
        "a folder left watching asked about an unclaimed source on every pass",
      ).toBe(1);
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      await watching.stop();
    }
    // It said so once, and printed nothing on the passes after, where
    // nothing changed.
    const reports = watching.stdout.split('"unclaimed_sources"').length - 1;
    expect(
      reports,
      `a watcher printed a pass where nothing happened: ${watching.stdout}`,
    ).toBe(1);
    expect(watching.stdout).toContain('"notes"');

    // A push is asked for, and asks at once.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(creates(), "a push did not ask again").toBe(2);
  });

  it("counts an edit over unread content when the file moved before it went", async () => {
    // The file's create landed on a row another machine made, and the
    // person moved the file before its next push: the move carries the edit,
    // and where the file differs from the row it replaces content this
    // machine never read, which the scan says wherever the file now is. The
    // same bytes still move the key, since a new name is a move to send.
    const slice = {
      types: ["core.note"],
      defaultType: "core.note",
      source: "notes",
    };
    const mine = "---\ntitle: Shared\n---\nthe first machine's\n";
    for (const [label, theirs] of [
      ["same", mine],
      ["different", "---\ntitle: Shared\n---\nwritten on the second machine\n"],
    ] as const) {
      const first = await folderHarness(`folder-moved-landed-one-${label}`, {
        slice,
      });
      const other = await folderHarness(`folder-moved-landed-two-${label}`, {
        slice,
        sharing: { server: first.server, key: "mk_second_machine" },
      });
      try {
        const rows = scriptFolderWrites(first);
        put(first, "note.md", mine);
        put(other, "note.md", theirs);
        expect((await first.folder.push()).ok).toBe(true);
        const landed = itemFor(keysByItem(first), "note.md");
        const pushed = await other.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
        if (!pushed.ok) return;
        expect(
          pushed.value.drain.verdicts
            .filter((entry) => entry.kind === "create_item")
            .map((entry) => [entry.verdict, entry.item_id]),
        ).toEqual([["refused", landed]]);

        renameSync(join(other.dir, "note.md"), join(other.dir, "moved.md"));
        const before = first.server.requests.length;
        const again = await other.folder.push();
        expect(again.ok, JSON.stringify(again)).toBe(true);
        if (!again.ok) return;
        const patches = first.server.requests
          .slice(before)
          .filter((request) => request.method === "PATCH");
        expect(
          patches.map((request) => request.pathname),
          `${label}: the move sent nothing to the row the create landed on`,
        ).toEqual([`/items/${landed}`]);
        expect(
          rows.get(landed)?.source_id,
          `${label}: the file moved and its key did not, so the next pull moves it back`,
        ).toBe("moved.md");
        expect(again.value.scan.renamed).toBe(1);
        if (label === "same") {
          expect(again.value.scan.overwrote).toBe(0);
        } else {
          expect(rows.get(landed)?.properties.body).toBe(
            "written on the second machine\n",
          );
          expect(
            again.value.scan.overwrote,
            "the move replaced content this machine never read and the scan did not say so",
          ).toBe(1);
        }
      } finally {
        await other.stop();
        await first.stop();
      }
    }
  });

  it("merges a stale folder's edit against what it read, though its copy caught up since", async () => {
    // The copy read the row at 1; the server holds 9. The create, based on
    // 1, is refused and the copy moves onto the row as it read it. A
    // catch-up then brings 9 into the copy, and the file's edit must still be
    // based on 1, or the server takes it as newer and the other machine's
    // content is replaced with nothing saying so.
    const id = "01a00000-0000-7000-8000-00000000000a";
    const newerProperties = { title: "Newer", body: "what the server holds\n" };
    harness = await folderHarness("folder-stale-caught-up", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              source_id: "stale.md",
              properties: { title: "Read", body: "what the folder read\n" },
            },
          },
        ],
      },
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 9,
              source_id: "stale.md",
              properties: newerProperties,
            }),
          ),
        ]),
      ],
    });
    const newer = {
      id,
      version: 9,
      properties: newerProperties,
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "stale.md",
    };
    scriptWrites(harness.server, {
      create: [
        answers.versionConflict(
          newer,
          {
            ...newer,
            version: 1,
            properties: { title: "Read", body: "what the folder read\n" },
          },
          ["body", "title"],
          {
            fields: { body: "keep_both_copies", notes: "keep_both_copies" },
            default: "last_writer_wins",
          },
        ),
      ],
      update: [
        answers.resolved(
          wireItem({
            id,
            version: 10,
            source_id: "stale.md",
            properties: newerProperties,
          }),
          { body: "keep_both_copies", title: "last_writer_wins" },
          "01a00000-0000-7000-8000-0000000000cd",
        ),
      ],
    });
    put(
      harness,
      "stale.md",
      "---\ntitle: Stale\n---\nthe stale machine's copy\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.drain.verdicts
        .filter((entry) => entry.item_id === id)
        .map((entry) => [entry.verdict, entry.reason]),
    ).toEqual([["refused", "version_conflict"]]);

    // The witness that the copy did move on: the catch-up applied version 9.
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok && caught.value.applied, JSON.stringify(caught)).toBe(1);
    const holding = await harness.folder.device().get(id);
    expect(holding.ok && holding.value.version).toBe(9);

    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    const patch = harness.server.requests.find(
      (request) => request.method === "PATCH",
    );
    expect(patch?.pathname).toBe(`/items/${id}`);
    expect(
      (JSON.parse(patch?.body ?? "{}") as { version?: number }).version,
      "the stale edit went on the version the catch-up brought in, so the server takes it as newer and replaces what it never merged",
    ).toBe(1);
    expect(again.value.scan.overwrote).toBe(0);
    expect(again.value.drain.verdicts[0]?.verdict).toBe("conflicted");
  });

  it("sends a stale folder's edit over a row whose read version is thinned, and says so", async () => {
    // The copy read the row at 1, and the server no longer holds a snapshot
    // of 1: a version it no longer holds is as good as never read. Kept as
    // the base, every edit of the file would be refused the same way.
    const id = "01a00000-0000-7000-8000-00000000000b";
    harness = await folderHarness("folder-stale-thinned", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              source_id: "thin.md",
              properties: { title: "Read", body: "what the folder read\n" },
            },
          },
        ],
      },
    });
    const newer = {
      id,
      version: 9,
      properties: { title: "Newer", body: "what the server holds\n" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "thin.md",
    };
    scriptWrites(harness.server, {
      create: [answers.ancestorUnavailable(newer, 1)],
      update: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            version: number;
            properties: Record<string, unknown>;
          };
          return sent.version === 9
            ? answers.updated(
                wireItem({
                  id,
                  version: 10,
                  source_id: "thin.md",
                  properties: sent.properties,
                }),
              )
            : answers.ancestorUnavailable(newer, sent.version);
        },
      ],
      read: [
        answers.updated(
          wireItem({
            id,
            version: 9,
            source_id: "thin.md",
            properties: newer.properties,
          }),
        ),
      ],
    });
    put(
      harness,
      "thin.md",
      "---\ntitle: Stale\n---\nthe stale machine's copy\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.drain.verdicts
        .filter((entry) => entry.item_id === id)
        .map((entry) => [entry.verdict, entry.reason]),
    ).toEqual([["refused", "ancestor_unavailable"]]);

    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(
      harness.server.requests
        .filter((request) => request.method === "PATCH")
        .map(
          (request) =>
            (JSON.parse(request.body) as { version?: number }).version,
        ),
      "the edit was based on a version the server no longer holds, so none of the person's writing can land",
    ).toEqual([9]);
    expect(again.value.drain.verdicts.map((entry) => entry.verdict)).toEqual([
      "accepted",
    ]);
    expect(
      again.value.scan.overwrote,
      "the edit replaced content this machine never read and the scan did not say so",
    ).toBe(1);
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

  it("refuses a folder that names no source, or one it may never name", async () => {
    harness = await folderHarness("folder-source-refused", { hydrate: false });
    const slice = { types: ["core.note"], defaultType: "core.note" };
    const refused = [
      "",
      "   ",
      "connector:gmail",
      "oauth:someapp",
      // The server reads a source trimmed and in any case.
      "Connector:Gmail",
      " oauth:someapp",
      // Longer than any key may claim, so every create would be refused.
      "a".repeat(201),
      // Measured in UTF-16 code units, as the server measures a claim: a
      // hundred and one astral characters are two hundred and two.
      "\u{1F4DD}".repeat(101),
    ];
    for (const [index, source] of refused.entries()) {
      const folder = new CliFolder(`${harness.dir}-${String(index)}`, {
        binary: requireBinary(),
        url: harness.server.url,
        key: KEY,
      });
      const added = await folder.add({ ...slice, source });
      expect(
        added.ok,
        `a folder naming the source ${JSON.stringify(source)} was made, so its creates are keyed by a source it cannot hold`,
      ).toBe(false);
    }
    // The witness: the same slice naming a source of its own is made.
    const named = new CliFolder(`${harness.dir}-named`, {
      binary: requireBinary(),
      url: harness.server.url,
      key: KEY,
    });
    expect((await named.add({ ...slice, source: "notes" })).ok).toBe(true);

    // A source is read trimmed, as the server reads it, and kept that way.
    // Kept with its spaces it names a source no key claims, so every create
    // the folder queued would be refused.
    const keptAs = (added: Awaited<ReturnType<CliFolder["add"]>>) =>
      added.ok ? (added.value as { source?: string }).source : undefined;
    const spaced = new CliFolder(`${harness.dir}-spaced`, {
      binary: requireBinary(),
      url: harness.server.url,
      key: KEY,
    });
    const kept = await spaced.add({ ...slice, source: " notes " });
    expect(
      keptAs(kept),
      `a folder naming " notes " kept a source no key claims: ${JSON.stringify(kept)}`,
    ).toBe("notes");
    scriptFolderWrites(harness);
    expect((await spaced.hydrate()).ok).toBe(true);
    writeFileSync(join(spaced.dir, "note.md"), "---\ntitle: Spaced\n---\nb\n");
    expect((await spaced.push()).ok).toBe(true);
    expect(
      sentCreates(harness).map((create) => create.source),
      "the create did not name the source as the folder keeps it",
    ).toEqual(["notes"]);
    // And measured after the trim, as the server measures a claim: two
    // hundred characters inside the spaces is a source a key may hold.
    const longest = "a".repeat(200);
    const atBound = await new CliFolder(`${harness.dir}-longest`, {
      binary: requireBinary(),
      url: harness.server.url,
      key: KEY,
    }).add({ ...slice, source: ` ${longest} ` });
    expect(
      keptAs(atBound),
      `a source of two hundred characters was refused: ${JSON.stringify(atBound)}`,
    ).toBe(longest);
    // The witness for the astral case: a hundred of them are two hundred
    // units, which a key may claim.
    const astral = "\u{1F4DD}".repeat(100);
    const astralAtBound = await new CliFolder(`${harness.dir}-astral`, {
      binary: requireBinary(),
      url: harness.server.url,
      key: KEY,
    }).add({ ...slice, source: astral });
    expect(
      keptAs(astralAtBound),
      `a source of two hundred UTF-16 units was refused: ${JSON.stringify(astralAtBound)}`,
    ).toBe(astral);
    // Trimmed as JavaScript trims, which is how the server reads a claim: a
    // byte order mark goes, and U+0085 stays, where Rust's own trim does the
    // opposite with both.
    for (const [named, trimmed] of [
      ["\uFEFFnotes", "notes"],
      ["notes\u0085", "notes\u0085"],
    ]) {
      const added = await new CliFolder(
        `${harness.dir}-trim-${String(trimmed.length)}`,
        { binary: requireBinary(), url: harness.server.url, key: KEY },
      ).add({ ...slice, source: named });
      expect(
        keptAs(added),
        `the folder kept ${JSON.stringify(named)} as a source the server would not read it as: ${JSON.stringify(added)}`,
      ).toBe(trimmed);
    }
  });

  it("resolves a path to its own source's row, never another source's under the same key", async () => {
    // One path-shaped key under two sources is two rows, and a folder
    // naming either source holds both. Its file at that path is its own
    // source's row, and the other is an item from elsewhere, placed by its
    // title like any other.
    const ours = "01a00000-0000-7000-8000-0000000000b1";
    const theirs = "01a00000-0000-7000-8000-0000000000b2";
    const slice = { types: ["core.note"], defaultType: "core.note" };
    harness = await folderHarness("folder-two-sources-notes", {
      slice: { ...slice, source: "notes" },
      rows: {
        "core.note": [
          {
            item: {
              id: theirs,
              source: "elsewhere",
              source_id: "shared/note.md",
              properties: { title: "Theirs", body: "theirs\n" },
            },
          },
          {
            item: {
              id: ours,
              source: "notes",
              source_id: "shared/note.md",
              properties: { title: "Ours", body: "ours\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    second = await folderHarness("folder-two-sources-elsewhere", {
      slice: { ...slice, source: "elsewhere" },
      sharing: { server: harness.server, key: "mk_elsewhere" },
    });
    const idIn = (folder: FolderHarness, name: string) =>
      existsSync(join(folder.dir, name))
        ? /marfa_id:\s*(\S+)/.exec(read(folder, name))?.[1]
        : undefined;
    const folders = [
      { folder: harness, key: KEY, own: ours, other: theirs, title: "Theirs" },
      {
        folder: second,
        key: "mk_elsewhere",
        own: theirs,
        other: ours,
        title: "Ours",
      },
    ];
    for (const { folder, own, other, title } of folders) {
      expect((await folder.folder.pull()).ok).toBe(true);
      expect(
        idIn(folder, "shared/note.md"),
        "the file at the shared path is another source's row, so this folder's edits there go to a row it does not key",
      ).toBe(own);
      expect(
        idIn(folder, `${title}.md`),
        "the other source's row was not placed as an item from elsewhere",
      ).toBe(other);
    }

    for (const { folder } of folders) {
      put(
        folder,
        "shared/note.md",
        read(folder, "shared/note.md").replace(/\n$/, " edited\n"),
      );
      expect((await folder.folder.push()).ok).toBe(true);
    }
    for (const { key, own } of folders) {
      const patched = harness.server.requests
        .filter(
          (request) =>
            request.method === "PATCH" &&
            request.headers.authorization === `Bearer ${key}`,
        )
        .map((request) => request.pathname);
      // The witness: the folder did write, so the list is about which row.
      expect(patched.length).toBeGreaterThan(0);
      expect(
        patched,
        "a folder's edit to its file at the shared path went to another source's row",
      ).toEqual(patched.map(() => `/items/${own}`));
    }
  });

  it("never parks, renames or re-keys another source's row", async () => {
    // Rows under another source: two at the path their title gives them,
    // which is also their own key, and one another folder left parked. None
    // of them holds a name of this folder's, since the server keys a row by
    // the pair, so nothing this folder does to its own names reaches them.
    const mine = "01a00000-0000-7000-8000-0000000000c1";
    const named = "01a00000-0000-7000-8000-0000000000c2";
    const moving = "01a00000-0000-7000-8000-0000000000c3";
    const parked = "01a00000-0000-7000-8000-0000000000c4";
    const bytes = "01a00000-0000-7000-8000-0000000000c5";
    const before = Buffer.from("another source's bytes\n");
    const theirs = (id: string, source_id: string, title: string) => ({
      item: {
        id,
        source: "elsewhere",
        source_id,
        properties: { title, body: `${title}\n` },
      },
    });
    harness = await folderHarness("folder-foreign-names", {
      slice: {
        types: ["core.note", "core.file"],
        defaultType: "core.note",
        source: "notes",
      },
      rows: {
        "core.file": [
          {
            item: {
              id: bytes,
              type: "core.file",
              source: "elsewhere",
              source_id: "Photo.bin",
              properties: {
                title: "Photo.bin",
                blob_ref: hashOf(before),
                mime_type: "application/octet-stream",
              },
            },
          },
        ],
        "core.note": [
          {
            item: {
              id: mine,
              source: "notes",
              source_id: "mine.md",
              properties: { title: "Mine", body: "mine\n" },
            },
          },
          theirs(named, "note.md", "note"),
          theirs(moving, "Moving.md", "Moving"),
          theirs(parked, `../parked/${parked}`, "Parked"),
        ],
      },
    });
    scriptFolderWrites(harness);
    scriptBlob(harness.server, before);
    acceptUploads(harness.server);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(readFileSync(join(harness.dir, "Photo.bin"))).toEqual(before);
    for (const [name, id] of [
      ["mine.md", mine],
      ["note.md", named],
      ["Moving.md", moving],
      ["Parked.md", parked],
    ]) {
      expect(read(harness, name), `${name} was not written`).toContain(id);
    }
    const keysSentTo = (id: string) =>
      harness!.server.requests
        .filter(
          (request) =>
            request.method === "PATCH" && request.pathname === `/items/${id}`,
        )
        .map((request) => JSON.parse(request.body) as { source_id?: string })
        .filter((body) => body.source_id !== undefined)
        .map((body) => body.source_id);
    const writesTo = (id: string) =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "PATCH" && request.pathname === `/items/${id}`,
      );

    // Another source's file moves, and its row keeps its key: the path is
    // this folder's name for it, not the other source's.
    renameSync(join(harness.dir, "Moving.md"), join(harness.dir, "Moved.md"));
    // And this folder's own file takes a name another source's row sits at.
    rmSync(join(harness.dir, "note.md"));
    renameSync(join(harness.dir, "mine.md"), join(harness.dir, "note.md"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witnesses: both moves were seen, and this folder's own row did
    // take the name it moved to.
    expect(pushed.value.scan.renamed).toBe(2);
    expect(keysSentTo(mine)).toEqual(["note.md"]);
    expect(
      keysSentTo(named),
      "another source's row was parked to free a name it never held under this folder's source",
    ).toEqual([]);
    expect(pushed.value.scan.parked).toBe(0);
    // A move of another source's file with its bytes unchanged carries
    // nothing that changes the row: no key, and the fields the row holds.
    // Sending it anyway would move the row's version for nothing.
    expect(
      writesTo(moving),
      "a move of another source's file was sent as a write, though nothing it carried changes that row",
    ).toEqual([]);
    expect(
      existsSync(join(harness.dir, "Moved.md")),
      "the pull put the moved file back, so the folder keeps undoing the move",
    ).toBe(true);
    expect(
      keysSentTo(parked),
      "a row another source parked was given this folder's path as its key",
    ).toEqual([]);

    // The witness: an edit to that file is a write to its row, still with
    // no key, so the silence above is about the move and not the row.
    put(
      harness,
      "Moved.md",
      read(harness, "Moved.md").replace(/\n$/, " edited\n"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(writesTo(moving)).toHaveLength(1);
    expect(keysSentTo(moving)).toEqual([]);

    // Moved and edited in one scan: the edit is a write to the row, and the
    // move still carries no key.
    renameSync(join(harness.dir, "Moved.md"), join(harness.dir, "Again.md"));
    put(
      harness,
      "Again.md",
      read(harness, "Again.md").replace(/\n$/, " and again\n"),
    );
    const both = await harness.folder.push();
    expect(both.ok, JSON.stringify(both)).toBe(true);
    expect(both.ok && both.value.scan.renamed).toBe(1);
    expect(writesTo(moving)).toHaveLength(2);
    expect(
      keysSentTo(moving),
      "a move and an edit of another source's file in one scan re-keyed its row under this folder's path",
    ).toEqual([]);

    // Another source's file item, moved with new bytes: an upload and a
    // write naming them, and no key.
    const after = Buffer.from("new bytes for another source's file\n");
    renameSync(
      join(harness.dir, "Photo.bin"),
      join(harness.dir, "Renamed.bin"),
    );
    writeFileSync(join(harness.dir, "Renamed.bin"), after);
    const moved = await harness.folder.push();
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    const sentToBytes = writesTo(bytes).map(
      (request) =>
        JSON.parse(request.body) as {
          source_id?: string;
          properties?: Record<string, unknown>;
        },
    );
    // The witness: the new bytes did go, so the missing key is about the
    // key and not a write never made.
    expect(sentToBytes.map((body) => body.properties?.blob_ref)).toEqual([
      hashOf(after),
    ]);
    expect(
      sentToBytes.map((body) => body.source_id),
      "a move of another source's file item with new bytes re-keyed its row under this folder's path",
    ).toEqual([undefined]);
  });

  it("treats a row under a source that differs only in case as a row from elsewhere", async () => {
    // A key's claims and a row's source are compared as written, so `Notes`
    // and `notes` are two sources, and a folder naming one holds the other's
    // rows as it holds any row from elsewhere.
    const lower = "01a00000-0000-7000-8000-0000000000d1";
    harness = await folderHarness("folder-source-case", {
      slice: {
        types: ["core.note"],
        defaultType: "core.note",
        source: "Notes",
      },
      rows: {
        "core.note": [
          {
            item: {
              id: lower,
              source: "notes",
              source_id: "note.md",
              properties: { title: "Lower", body: "under notes\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      existsSync(join(harness.dir, "note.md")),
      "the row under `notes` was written at its key, as though it were this folder's own",
    ).toBe(false);
    expect(read(harness, "Lower.md")).toContain(lower);

    // A file of this folder's own at that path is a create under `Notes`,
    // conditional on nothing being there, and a row of its own.
    put(harness, "note.md", "---\ntitle: Upper\n---\nunder Notes\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [sent] = sentCreates(harness);
    expect(
      [sent?.source, sent?.source_id, sent?.version],
      "the create was based on another source's row, which a folder only reads as its own by case",
    ).toEqual(["Notes", "note.md", 0]);
    // The witness: the file is bound, to the row its own create made.
    expect(/marfa_id:\s*(\S+)/.exec(read(harness, "note.md"))?.[1]).toBe(
      itemFor(keysByItem(harness), "note.md"),
    );
    expect(
      /marfa_id:\s*(\S+)/.exec(read(harness, "note.md"))?.[1],
      "this folder's file was bound to the row under `notes`",
    ).not.toBe(lower);
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

  it("keeps its own identity record out of what it sends the server", async () => {
    harness = await folderHarness("folder-record-not-sent");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Recorded\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The folder wrote its record into the file, so this is what a person
    // opening the file and typing a line actually edits.
    const written = read(harness, "note.md");
    expect(
      written,
      "the folder wrote no record into the file, so the rest of this is about a file that carries nothing to leak",
    ).toMatch(/marfa_id:\s*\S+/);
    writeFileSync(join(harness.dir, "note.md"), `${written}and a line more\n`);
    expect((await harness.folder.push()).ok).toBe(true);

    // Only the item door. The folder's drain also sends `PATCH /items/:id/
    // metadata` and `PATCH /edges/:id`, whose bodies carry no properties at
    // all, and reading one of those would throw rather than fail.
    const sent = harness.server.requests
      .filter(
        (request) =>
          request.method === "PATCH" &&
          /^\/items\/[^/]+$/.test(request.pathname),
      )
      .map(
        (request) =>
          (JSON.parse(request.body) as { properties: Record<string, unknown> })
            .properties,
      );
    expect(
      sent.length,
      "the edit never reached the server, so this asserts nothing about what it carried",
    ).toBeGreaterThan(0);
    expect(
      sent.filter((properties) => "marfa_id" in properties),
      "the folder sent its own identity record as a property of the item, so its bookkeeping is now stored on the server and every later render writes it out again",
    ).toEqual([]);

    // And a create, which is the case that matters most: a copy of somebody
    // else's file is a new natural key carrying their item's id.
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
      "a copied file carried the id of the item it was copied from onto a new item, so the folder's record is now a property naming somebody else's row",
    ).toEqual([]);
  });

  it("sends the new natural key when the person renames a file", async () => {
    harness = await folderHarness("folder-rename-sends-key");
    scriptFolderWrites(harness);
    put(harness, "before.md", "---\ntitle: Before\n---\nsame bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);

    renameSync(join(harness.dir, "before.md"), join(harness.dir, "after.md"));
    // A push, because a scan only queues: what a rename *sends* is the
    // subject, and nothing reaches the server until the drain.
    const pushed = await harness.folder.push();
    expect(
      pushed.ok,
      `the folder could not push: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.renamed,
      "the rename was not followed at all, so nothing below is about what a rename sends",
    ).toBe(1);

    const sent = harness.server.requests
      .filter(
        (request) =>
          request.method === "PATCH" &&
          /^\/items\/[^/]+$/.test(request.pathname),
      )
      .map(
        (request) =>
          JSON.parse(request.body) as { source_id?: string; version?: number },
      );
    expect(
      sent.length,
      "the rename queued nothing to send, so the server is never told the file moved",
    ).toBeGreaterThan(0);
    expect(
      sent.map((body) => body.source_id),
      "the rename did not carry the new natural key, so the item keeps the old one and the next pull writes the old name back",
    ).toContain("after.md");
    expect(
      sent.every((body) => typeof body.version === "number"),
      "a write carrying a natural key went without the version it is based on, which is a blind overwrite of whatever name arrived since",
    ).toBe(true);

    // And the file stays where the person put it, on this pull and the next.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      existsSync(join(harness.dir, "after.md")),
      "the folder put the file back under its old name, undoing the rename inside the command that reported it",
    ).toBe(true);
    expect(
      existsSync(join(harness.dir, "before.md")),
      "the old name came back, so the folder now holds the note twice",
    ).toBe(false);
  });

  it("follows a swap without giving either item the other's name", async () => {
    harness = await folderHarness("folder-swap");
    const held = scriptFolderWrites(harness);
    put(harness, "one.md", "---\ntitle: One\n---\nfirst\n");
    put(harness, "two.md", "---\ntitle: Two\n---\nsecond\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const before = keysByItem(harness);
    expect(
      before.size,
      "the two files never became items, so there is nothing to swap",
    ).toBe(2);
    const one = itemFor(before, "one.md");
    const two = itemFor(before, "two.md");
    expect(
      [one, two].every((id) => before.has(id)),
      "one of the two items could not be resolved from what the server answered, so every assertion below compares an id nothing holds against another and holds for nothing",
    ).toBe(true);

    renameSync(join(harness.dir, "one.md"), join(harness.dir, ".swap"));
    renameSync(join(harness.dir, "two.md"), join(harness.dir, "one.md"));
    renameSync(join(harness.dir, ".swap"), join(harness.dir, "two.md"));
    expect((await harness.folder.push()).ok).toBe(true);

    // Every natural key the folder sent, in order, against what each item
    // held at the time. A key another item holds is one the server refuses,
    // and the folder has to park one of the two to get out of the cycle.
    const keys = new Map<string, string>([
      [one, "one.md"],
      [two, "two.md"],
    ]);
    const collisions: string[] = [];
    for (const request of harness.server.requests) {
      if (request.method !== "PATCH") continue;
      if (!/^\/items\/[^/]+$/.test(request.pathname)) continue;
      const id = request.pathname.split("/").at(-1) ?? "";
      const body = JSON.parse(request.body) as { source_id?: string };
      if (body.source_id === undefined) continue;
      const taken = [...keys].find(
        ([other, key]) => other !== id && key === body.source_id,
      );
      if (taken) collisions.push(`${id} -> ${body.source_id}`);
      keys.set(id, body.source_id);
    }
    expect(
      collisions,
      "the folder asked for a name another item still held, which the server refuses — leaving one item under the wrong name and the other under none",
    ).toEqual([]);
    expect(
      [keys.get(one), keys.get(two)],
      "the two items did not end up under each other's names, so the swap did not reach the server",
    ).toEqual(["two.md", "one.md"]);

    // **What each item ended up holding**, not only what it is called. Names
    // alone cannot tell a swap that moved two names from one that moved two
    // names and crossed the bodies over, and the second is the failure a
    // person would actually notice.
    expect(
      [held.get(one)?.properties?.body, held.get(two)?.properties?.body],
      "the two items swapped bodies as well as names, so each note now holds the other's contents and the keys look right",
    ).toEqual(["first\n", "second\n"]);
  });

  it("does not write a new file's body onto the item whose name it took", async () => {
    harness = await folderHarness("folder-name-handover");
    const held = scriptFolderWrites(harness);
    put(harness, "a-note.md", "---\ntitle: A\n---\nthe real note\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const first = keysByItem(harness);
    expect(
      first.size,
      "the file never became an item, so there is no name for a second file to take",
    ).toBe(1);
    const incumbent = itemFor(first, "a-note.md");

    // The moved file frees `a-note.md`; a brand new file takes it in the same
    // scan. The walk is sorted, so the newcomer is reached first and the
    // incumbent still holds the name at that moment.
    renameSync(join(harness.dir, "a-note.md"), join(harness.dir, "z-note.md"));
    put(harness, "a-note.md", "---\ntitle: A\n---\nbrand new\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const survivor = held.get(incumbent);
    expect(
      survivor?.properties?.body,
      "the note the person moved was overwritten by an unrelated new file that took the name it was leaving, and the only trace is a version bump",
    ).toBe("the real note\n");
    expect(
      survivor?.source_id,
      "the moved note did not end up under its new name, so the rename never reached the server",
    ).toBe("z-note.md");

    const newcomer = [...held].find(
      ([id, row]) => id !== incumbent && row.source_id === "a-note.md",
    );
    expect(
      newcomer?.[1]?.properties?.body,
      "the new file never became an item of its own, so its contents live nowhere on the server",
    ).toBe("brand new\n");
  });

  it("keeps a binding for every file after a swap that also edits both", async () => {
    harness = await folderHarness("folder-swap-and-edit");
    scriptFolderWrites(harness);
    put(harness, "one.md", "---\ntitle: One\n---\nfirst\n");
    put(harness, "two.md", "---\ntitle: Two\n---\nsecond\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // Swapped **and** edited. With only the swap, a pull re-adopts each file
    // by comparing bytes and quietly rebuilds a mapping row the scan
    // destroyed — so the mapping looks right for a reason that has nothing
    // to do with the scan. An edit puts the bytes beyond that rescue.
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

    // The witness the sent-keys assertions could not give: after the scan,
    // does the folder still know what each file is? A row lost here is a
    // file the next scan pushes as a second item, taking the first one's
    // edges and leaving it to be deleted after the grace.
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

  it("follows a three-way rotation without a name landing on a held one", async () => {
    harness = await folderHarness("folder-rotate");
    scriptFolderWrites(harness);
    put(harness, "a.md", "---\ntitle: Alpha\n---\nalpha\n");
    put(harness, "b.md", "---\ntitle: Beta\n---\nbeta\n");
    put(harness, "c.md", "---\ntitle: Gamma\n---\ngamma\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const started = keysByItem(harness);
    expect(
      started.size,
      "the three files never became items, so there is nothing to rotate",
    ).toBe(3);

    // a -> b -> c -> a. A cycle of three, which a swap's two-step park does
    // not obviously generalize to.
    renameSync(join(harness.dir, "a.md"), join(harness.dir, ".hold"));
    renameSync(join(harness.dir, "c.md"), join(harness.dir, "a.md"));
    renameSync(join(harness.dir, "b.md"), join(harness.dir, "c.md"));
    renameSync(join(harness.dir, ".hold"), join(harness.dir, "b.md"));
    expect((await harness.folder.push()).ok).toBe(true);

    const { collisions, ended } = replayKeys(harness, started);
    expect(
      collisions,
      "the folder asked for a name another item still held, which a server refuses — so one item lands under the wrong name and another under none",
    ).toEqual([]);
    expect(
      [...ended.entries()].sort(),
      "the three items did not come to rest under the names their files now have",
    ).toEqual(
      [
        [itemFor(started, "a.md"), "b.md"],
        [itemFor(started, "b.md"), "c.md"],
        [itemFor(started, "c.md"), "a.md"],
      ].sort(),
    );
  });

  it("follows a chain of renames that frees its own last name", async () => {
    harness = await folderHarness("folder-chain");
    scriptFolderWrites(harness);
    put(harness, "a.md", "---\ntitle: Alpha\n---\nalpha\n");
    put(harness, "b.md", "---\ntitle: Beta\n---\nbeta\n");
    put(harness, "c.md", "---\ntitle: Gamma\n---\ngamma\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const started = keysByItem(harness);
    expect(
      started.size,
      "the three files never became three items, so there is no chain to follow and the assertions below pass against a shorter one",
    ).toBe(3);

    // c -> d, b -> c, a -> b. Not a cycle: the last name is free, and every
    // other is held by something that is itself about to move.
    renameSync(join(harness.dir, "c.md"), join(harness.dir, "d.md"));
    renameSync(join(harness.dir, "b.md"), join(harness.dir, "c.md"));
    renameSync(join(harness.dir, "a.md"), join(harness.dir, "b.md"));
    expect((await harness.folder.push()).ok).toBe(true);

    const { collisions, ended } = replayKeys(harness, started);
    expect(
      collisions,
      "the folder asked for a name another item still held part-way along the chain, which the server refuses — leaving one item under the wrong name and the next with none",
    ).toEqual([]);
    expect(
      [...ended.entries()].sort(),
      "the chain did not come to rest where the files did",
    ).toEqual(
      [
        [itemFor(started, "a.md"), "b.md"],
        [itemFor(started, "b.md"), "c.md"],
        [itemFor(started, "c.md"), "d.md"],
      ].sort(),
    );
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
  it("always carries a version on a create, zero where it holds no row", async () => {
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
    // The copy read the row at version 1, and the server has since moved it
    // to 9. The file under its key was never bound, so the folder sends a
    // create, conditional on the version it read (13).
    const id = "01a00000-0000-7000-8000-00000000000a";
    harness = await folderHarness("folder-stale", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              source_id: "stale.md",
              properties: { title: "Read", body: "what the folder read\n" },
            },
          },
        ],
      },
    });
    const newer = {
      id,
      version: 9,
      properties: { title: "Newer", body: "what the server holds\n" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "stale.md",
    };
    // Beside it, a file whose key another device's row holds, which this
    // copy never read: the witness that a device does read the row a refusal
    // names where it does not hold it.
    const unread = "01a00000-0000-7000-8000-0000000000f0";
    const theirs = { title: "Fresh", body: "from elsewhere\n" };
    scriptWrites(harness.server, {
      create: [
        (request) =>
          (JSON.parse(request.body) as { source_id?: string }).source_id ===
          "fresh.md"
            ? answers.ancestorUnavailable(
                {
                  ...newer,
                  id: unread,
                  version: 1,
                  properties: theirs,
                  source_id: "fresh.md",
                },
                0,
              )
            : answers.versionConflict(
                newer,
                {
                  ...newer,
                  version: 1,
                  properties: { title: "Read", body: "what the folder read\n" },
                },
                ["body", "title"],
                {
                  fields: {
                    body: "keep_both_copies",
                    notes: "keep_both_copies",
                  },
                  default: "last_writer_wins",
                },
              ),
      ],
      // The rows as the server holds them now, for a device that reads
      // them: this one holds the stale row already and must not read it.
      read: [
        (request) =>
          answers.updated(
            request.pathname === `/items/${unread}`
              ? wireItem({
                  id: unread,
                  version: 1,
                  source_id: "fresh.md",
                  properties: theirs,
                })
              : wireItem({
                  id,
                  version: 9,
                  source_id: "stale.md",
                  properties: newer.properties,
                }),
          ),
      ],
      // The server merges an edit based on what the folder read, keeping
      // both bodies (`versions.md` 13).
      update: [
        answers.resolved(
          wireItem({
            id,
            version: 10,
            source_id: "stale.md",
            properties: newer.properties,
          }),
          { body: "keep_both_copies", title: "last_writer_wins" },
          "01a00000-0000-7000-8000-0000000000cc",
        ),
      ],
    });
    put(
      harness,
      "stale.md",
      "---\ntitle: Stale\n---\nthe stale machine's copy\n",
    );
    put(harness, "fresh.md", "---\ntitle: Fresh\n---\nfrom elsewhere\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const sentCreate = sentCreates(harness).find(
      (sent) => sent.source_id === "stale.md",
    );
    expect(
      sentCreate?.version,
      "the stale folder's create was not conditional on the version it read",
    ).toBe(1);
    const staleVerdict = pushed.value.drain.verdicts.find(
      (entry) => entry.item_id === id,
    );
    expect(
      [staleVerdict?.verdict, staleVerdict?.reason],
      "a conditional create the server refused was taken as something the folder could send again",
    ).toEqual(["refused", "version_conflict"]);
    // The witness: the row it did not hold, it read.
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === `/items/${unread}`,
      ),
    ).toHaveLength(1);
    // Nothing of the stale copy reached the row, and the copy still holds
    // the row as it read it rather than as the server now holds it.
    const holding = await harness.folder.device().get(id);
    expect(
      holding.ok && holding.value.version,
      "the copy replaced the row it read with the server's newer one, so the next edit is based on content it never saw",
    ).toBe(1);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === `/items/${id}`,
      ),
    ).toEqual([]);
    expect(read(harness, "stale.md")).toContain("the stale machine's copy");

    // The next push sends the file as an edit based on the version it read,
    // so the server merges it rather than taking it as newer, and the create
    // is never sent again.
    const before = sentCreates(harness).length;
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(
      sentCreates(harness).length,
      "the stale create went a second time, so a folder left running keeps trying to overwrite newer content",
    ).toBe(before);
    const patch = harness.server.requests.find(
      (request) => request.method === "PATCH",
    );
    expect(patch?.pathname).toBe(`/items/${id}`);
    expect(
      (JSON.parse(patch?.body ?? "{}") as { version?: number }).version,
      "the stale edit was based on the server's newest version, which takes it as newer and overwrites what the other machine wrote",
    ).toBe(1);
    expect(patch?.query.get("conflict")).toBe("auto");
    expect(again.value.drain.verdicts[0]?.verdict).toBe("conflicted");
    // Merged against what it read, so not an overwrite; and the file whose
    // row it never read holds what that row holds, so nothing went for it.
    expect(again.value.scan.overwrote).toBe(0);
    expect(
      harness.server.requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(1);
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
      "the file the folder wrote was not recognized at all, so the absence above is the scan seeing nothing rather than seeing its own work",
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

  it("refuses to write a file outside the folder", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "marfa-folder-elsewhere-"));
    harness = await folderHarness("folder-outside", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000e",
              source_id: "out/note.md",
              properties: { title: "Out", body: "body\n" },
            },
          },
          // The control. A guard that refuses everything satisfies both
          // assertions below, and a pull that writes nothing at all is the
          // plausible way to write one.
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000f",
              source_id: "ordinary.md",
              properties: { title: "Ordinary", body: "body\n" },
            },
          },
          // The link that points back in, which the resolved form of this
          // guard allowed: the write lands on this file and truncates it.
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000010",
              source_id: "alias.md",
              properties: { title: "Alias", body: "written through a link\n" },
            },
          },
        ],
      },
    });
    // A directory inside the folder that is really somewhere else. The key
    // carries no `..` and no leading separator, so the path rule allows it;
    // what makes it leave the folder is the link, which `create_dir_all` and
    // the write both follow and the walk never descends.
    symlinkSync(elsewhere, join(harness.dir, "out"));
    // And one pointing back into the folder, at a file that is somebody's.
    writeFileSync(
      join(harness.dir, "kept.md"),
      "---\ntitle: Kept\n---\nmine\n",
    );
    symlinkSync(join(harness.dir, "kept.md"), join(harness.dir, "alias.md"));

    const pulled = await harness.folder.pull();
    expect(
      pulled.ok,
      `the folder could not pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.written,
      "the pull wrote nothing at all, so a guard that refuses every path would satisfy everything below",
    ).toBeGreaterThan(0);
    expect(
      existsSync(join(elsewhere, "note.md")),
      "a file landed outside the folder, where nothing the folder does will ever find it again",
    ).toBe(false);
    expect(
      read(harness, "kept.md"),
      "an item was written through a link pointing back into the folder, so it truncated a file that belonged to another item and the next scan pushes the wrong bytes to the server",
    ).toContain("mine");
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
              source_id: "note.md",
              properties: { title: "From the server", body: "the item\n" },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000012",
              source_id: "other.md",
              properties: { title: "Other", body: "the other item\n" },
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
            source_id: "note.md",
            properties: { title: "Recovered", body: "the item\n" },
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

  it("does not move an item on top of a file nobody has scanned", async () => {
    harness = await folderHarness("folder-move-onto-file", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000001a",
              source_id: "from.md",
              properties: { title: "From", body: "the item\n" },
            },
          },
        ],
      },
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id: "01a00000-0000-7000-8000-00000000001a",
              version: 2,
              source_id: "onto.md",
              properties: { title: "Onto", body: "the item\n" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(read(harness, "from.md")).toContain("the item");

    // A note the person made and has not scanned. `folders pull` runs no
    // scan of its own, so nothing has queued a word of it.
    put(harness, "onto.md", "---\ntitle: Mine\n---\nan afternoon of it\n");

    const caught = await harness.folder.device().catchUp();
    expect(
      caught.ok ? caught.value.applied : 0,
      `the rename event was not applied, so nothing below is about a move: ${JSON.stringify(caught)}`,
    ).toBe(1);

    const pulled = await harness.folder.pull();
    expect(
      pulled.ok,
      `the folder could not pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(
      read(harness, "onto.md"),
      "a server-side rename wrote an item over a file the folder had never written, so an afternoon's typing went with no queue row and a report line that says the item moved",
    ).toContain("an afternoon of it");
    expect(
      pulled.value.moved,
      "the folder reported a move it did not make",
    ).toBe(0);
    expect(
      pulled.value.unwritten,
      "the folder declined the move and said nothing about it",
    ).toBeGreaterThan(0);
    expect(
      existsSync(join(harness.dir, "from.md")),
      "the item's own file was removed for a move that never happened, so it now has no file at all",
    ).toBe(true);
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
          // An item of a type this folder does not hold, arriving through
          // the same page. Without one the pull's own slice rule is never
          // exercised, and the assertion below is about the push half only.
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000b",
              type: "core.bookmark",
              source_id: "outside.md",
              properties: { title: "Outside", body: "not in the slice\n" },
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

    // The pull half: an item outside the slice does not become a file.
    expect(
      existsSync(join(harness.dir, "outside.md")),
      "an item of a type this folder does not hold became a file in it, so a folder declaring one type writes every type it is sent",
    ).toBe(false);
    expect(
      pushed.value.pull.skipped,
      "the pull reported skipping nothing, so the absence above is a pull that wrote nothing at all",
    ).toBeGreaterThan(0);
    expect(
      existsSync(join(harness.dir, "inside.md")),
      "the item inside the slice did not become a file either, so the folder is writing nothing rather than choosing",
    ).toBe(true);
  });
});

describe("what a pull does with a file whose item left the slice", () => {
  const departed = {
    id: "01a00000-0000-7000-8000-0000000000d1",
    source_id: "going.md",
    properties: { title: "Going", body: "body\n" },
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

  it("keeps the file of an item whose key moved outside the folder", async () => {
    // The item is still in the slice, so its file is not a departed one:
    // the pull reports that it wants a path it will not write (20), and
    // the file it has stays where it is.
    const id = "01a00000-0000-7000-8000-0000000000e1";
    const elsewhere = mkdtempSync(join(tmpdir(), "marfa-folder-moved-"));
    harness = await folderHarness("folder-moved-outside", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              source_id: "inside.md",
              properties: { title: "Inside", body: "body\n" },
            },
          },
        ],
      },
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              source_id: "out/escape.md",
              properties: { title: "Inside", body: "body\n" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "inside.md"))).toBe(true);
    // The new key leads through a link out of the folder.
    symlinkSync(elsewhere, join(harness.dir, "out"));
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);

    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.outside).toBe(1);
    expect(
      pulled.value.removed,
      "an item still in the slice had its file taken away because its key moved outside the folder",
    ).toBe(0);
    expect(existsSync(join(harness.dir, "inside.md"))).toBe(true);
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
      pushed.value.pull.removed,
      "the pull took away a file the folder never wrote, and the person's words with it",
    ).toBe(0);
    expect(pushed.value.pull.kept).toBe(1);
    expect(read(harness, "mine.md")).toContain("the person's own words");

    // Still bound, so the next scan neither makes a second item of it nor
    // queues the refused create again, and it says so; the push's own report
    // is what said the create was refused, and an edit to the file queues it
    // again (`folders.md` 30).
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
    expect(sentKeys(harness)).not.toContain("blank.png");
    expect(
      sentCreates(harness).find((create) => create.source_id === "song.mp3")
        ?.type,
      "a file whose subtype the server does not register was not pushed as a file",
    ).toBe("core.file");

    const file = sentCreates(harness).find(
      (create) => create.source_id === "photo.png",
    );
    expect(
      file,
      "no item was created for the photo under its path",
    ).toBeDefined();
    expect(file?.type).toBe("core.file.image");
    // The id the server answered with, since a create carrying a natural
    // key names none of its own.
    const fileId = itemFor(keysByItem(harness), "photo.png");
    expect(
      file?.source,
      "the file item's create named no source, so it is keyed by whatever credential sent it",
    ).toBe(FOLDER_SOURCE);
    expect(file?.properties).toMatchObject({
      blob_ref: hashOf(photo),
      mime_type: "image/png",
      title: "photo.png",
    });
    const order = harness.server.requests
      .filter((request) => request.method === "POST")
      .map((request) =>
        request.pathname === "/items"
          ? `/items ${String((JSON.parse(request.body) as { source_id?: string }).source_id)}`
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

    // A move alone: the new name and the title the folder gave it follow,
    // and the bytes, unchanged, are not sent again.
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
    expect(
      JSON.parse(rename?.body ?? "{}") as Record<string, unknown>,
      "the move did not carry the new name, so the next pull puts the file back where it was",
    ).toMatchObject({
      source_id: "moved.png",
      properties: { title: "moved.png", blob_ref: hashOf(edited) },
    });
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
    harness = await folderHarness("folder-file-not-a-file", {
      slice: {
        types: ["core.note", "core.bookmark"],
        defaultType: "core.note",
      },
      rows: {
        "core.bookmark": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000b1",
              type: "core.bookmark",
              properties: {
                title: "Budget.xlsx",
                blob_ref: hashOf(Buffer.from("not fetched")),
              },
            },
          },
        ],
      },
    });
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(1);
    expect(
      existsSync(join(harness.dir, "Budget.xlsx.md")),
      "an item of a type that is not a file was written under a file's name, so the next scan would not read it as the document it is",
    ).toBe(true);
    expect(
      harness.server.requests.some((request) =>
        request.pathname.startsWith("/blobs/"),
      ),
      "the pull fetched bytes for an item that is not a file",
    ).toBe(false);
  });

  it("keeps a title somebody set when the file moves", async () => {
    const hash = hashOf(photo);
    harness = await folderHarness("folder-file-titled", {
      slice,
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f4",
              type: "core.file.image",
              source_id: "photo.png",
              properties: {
                title: "Holiday",
                blob_ref: hash,
                mime_type: "image/png",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, photo);
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    renameSync(join(harness.dir, "photo.png"), join(harness.dir, "moved.png"));
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    const patch = harness.server.requests.find(
      (request) => request.method === "PATCH",
    );
    const body = JSON.parse(patch?.body ?? "{}") as {
      source_id?: string;
      properties?: Record<string, unknown>;
    };
    // The witness: the move went.
    expect(body.source_id).toBe("moved.png");
    expect(
      body.properties?.title,
      "a move wrote the file's name over a title somebody gave the item",
    ).toBeUndefined();
  });

  it("keeps the file of an item whose new bytes cannot be had", async () => {
    const hash = hashOf(photo);
    const later = Buffer.concat([photo, Buffer.from("later")]);
    const row = {
      id: "01a00000-0000-7000-8000-0000000000f5",
      type: "core.file.image",
      source_id: "photo.png",
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
              source_id: "notes.txt",
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
