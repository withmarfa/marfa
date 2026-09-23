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
} from "../../device/marfa-answers.js";
import {
  acceptUploads,
  folderHarness,
  hashOf,
  scriptBlob,
  scriptWrites,
} from "./harness.js";
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
): Map<
  string,
  { properties: Record<string, unknown>; source_id: string | null }
> {
  let next = 0;
  // What the scripted server holds for each item, so an update that carries
  // only a natural key does not answer with the properties cleared.
  //
  // Returned, so a fixture can ask what each item ended up holding. Asserting
  // on the natural keys alone cannot tell a swap that moved two names from one
  // that moved two names and crossed the bodies over.
  const held = new Map<
    string,
    {
      properties: Record<string, unknown>;
      source_id: string | null;
      type?: string;
    }
  >();
  scriptWrites(harness.server, {
    create: [
      (request) => {
        const sent = JSON.parse(request.body) as {
          id: string;
          type?: string;
          properties: Record<string, unknown>;
          source_id?: string;
        };
        const canned = rows[next];
        next += 1;
        // **A create onto a natural key something already holds is an upsert
        // onto that row**, not a second item (`items.md` 5). Scripted here
        // because the real server does it, and a door that always minted a
        // fresh row could not show what a create aimed at a live key costs:
        // the folder would look correct while overwriting somebody's note.
        const incumbent =
          sent.source_id === undefined
            ? undefined
            : [...held].find(([, row]) => row.source_id === sent.source_id);
        if (incumbent) {
          const [id] = incumbent;
          held.set(id, {
            properties: sent.properties,
            source_id: sent.source_id ?? null,
            type: sent.type,
          });
          return answers.created(
            wireItem({
              id,
              version: 2,
              type: sent.type,
              properties: sent.properties,
              source_id: sent.source_id ?? null,
              ...(canned ?? {}),
            }),
          );
        }
        held.set(sent.id, {
          properties: sent.properties,
          source_id: sent.source_id ?? null,
          type: sent.type,
        });
        return answers.created(
          wireItem({
            id: sent.id,
            version: 1,
            type: sent.type,
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
          properties?: Record<string, unknown>;
          source_id?: string;
          version: number;
        };
        const id = request.pathname.split("/").at(-1) ?? "unknown";
        // The natural key is echoed when the write carries one, because a
        // rename is a write to it and the copy has to learn the new one —
        // a scripted door that dropped it would leave the folder computing
        // the old path forever, which is the defect statement 23 is for.
        held.set(id, {
          properties: {
            ...held.get(id)?.properties,
            ...sent.properties,
          },
          source_id: sent.source_id ?? held.get(id)?.source_id ?? null,
          type: held.get(id)?.type,
        });
        const now = held.get(id)!;
        return answers.updated(
          wireItem({
            id,
            version: sent.version + 1,
            type: now.type,
            properties: now.properties,
            source_id: now.source_id,
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
  harness.server.answer("DELETE", /^\/edges\/[^/]+$/, {
    kind: "json",
    status: 204,
    body: {},
  });
  return held;
}

/** What the folder sent to the items door, parsed. */
function sentCreates(harness: FolderHarness): Array<Record<string, unknown>> {
  return harness.server.requests
    .filter(
      (request) => request.method === "POST" && request.pathname === "/items",
    )
    .map((request) => JSON.parse(request.body) as Record<string, unknown>);
}

/** Which item the folder created under each natural key. */
function keysByItem(harness: FolderHarness): Map<string, string> {
  return new Map(
    sentCreates(harness).map((create) => [
      String(create.id),
      String(create.source_id ?? ""),
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
    // the folder wrote stays, so the only difference is the link.
    const takeOut = () => {
      writeFileSync(
        join(harness!.dir, "source.md"),
        read(harness!, "source.md").replace("[[other]]\n", ""),
      );
    };
    takeOut();
    expect((await harness.folder.scan()).ok).toBe(true);

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

    const before = sentCreates(harness);
    expect(
      before.length,
      "the two files never became items, so there is nothing to swap",
    ).toBe(2);
    const idOf = (key: string): string =>
      String(before.find((create) => create.source_id === key)?.id ?? "");
    const one = idOf("one.md");
    const two = idOf("two.md");
    expect(
      [one, two].every(Boolean),
      "one of the two items could not be resolved from what the folder sent, so every assertion below compares an empty id against another and holds for nothing",
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

    const first = sentCreates(harness);
    expect(
      first.length,
      "the file never became an item, so there is no name for a second file to take",
    ).toBe(1);
    const incumbent = String(first[0]?.id ?? "");
    expect(
      incumbent,
      "the create carried no id, so there is nothing to follow the note by",
    ).not.toBe("");

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
    // queues the refused create again; the push's own report is what said
    // the create was refused, and an edit to the file meets the loud
    // refusal of a binding the copy no longer answers for.
    const before = sentCreates(harness).length;
    expect(before, "the create was never sent, so nothing was refused").toBe(1);
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect([scanned.value.created, scanned.value.unchanged]).toEqual([0, 1]);
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
    const pushed = await harness.folder.push();
    expect(
      pushed.ok,
      `the folder could not push: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.created,
      "the photo was not pushed, so a file dropped beside the notes never leaves the machine",
    ).toBe(2);
    expect(pushed.value.scan.skipped).toBe(0);

    const file = sentCreates(harness).find(
      (create) => create.source_id === "photo.png",
    );
    expect(
      file,
      "no item was created for the photo under its path",
    ).toBeDefined();
    expect(file?.type).toBe("core.file.image");
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

    // New bytes are a new upload and an update naming them.
    const edited = Buffer.concat([photo, Buffer.from([2])]);
    writeFileSync(join(harness.dir, "photo.png"), edited);
    const again = await harness.folder.push();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.scan.updated).toBe(1);
    const uploads = harness.server.requests.filter(
      (request) => request.pathname === "/blobs",
    );
    expect(uploads.at(-1)?.raw).toEqual(edited);
    const patch = harness.server.requests.find(
      (request) =>
        request.method === "PATCH" &&
        request.pathname === `/items/${String(file?.id)}`,
    );
    expect(
      (JSON.parse(patch?.body ?? "{}") as { properties?: unknown }).properties,
      "the update did not name the new bytes, so the item still names the old file",
    ).toMatchObject({ blob_ref: hashOf(edited) });
  });

  it("writes a file item's bytes as its file, and reports them absent where it cannot fetch them", async () => {
    const bytes = photo;
    const hash = hashOf(bytes);
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
        ],
      },
    });
    scriptBlob(harness.server, bytes);

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
    ).toBe(1);
    expect(
      existsSync(join(harness.dir, "photo.png")),
      "the pull wrote a file for bytes it does not have",
    ).toBe(false);

    // The witness: the same pull with the server back writes the bytes, so
    // the absence above was the bytes and not a pull that writes no files.
    await harness.server.online();
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(1);
    expect(pulled.value.absent).toBe(0);
    expect(readFileSync(join(harness.dir, "photo.png"))).toEqual(bytes);

    // Its own write is not read back as a change (`folders.md` 14).
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.unchanged,
      "the file the pull wrote was read back as a change to push",
    ).toBe(1);
    expect(scanned.value.created + scanned.value.updated).toBe(0);
  });
});
