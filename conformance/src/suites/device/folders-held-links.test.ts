import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copyItemEvent,
  copyReplay,
  wireItem,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { SseFrame } from "../../device/scripted-server.js";
import { folderHarness, type FolderHarness } from "./harness.js";
import {
  EdgeDoor,
  scriptFolderWrites,
  sentCreates,
  sentEdgeWrites,
} from "./folders.shared.js";

// A document is created whatever its links name, and a link held because
// its name matched no item, or more than one, is resolved again once the
// working copy changes (`folders/create-before-links`,
// `folders/edge-held-retried`, `folders/edge-held-cleared`,
// `folders/edge-held-never-guessed`).

let folder: FolderHarness | undefined;
afterEach(async () => {
  await folder?.stop();
  folder = undefined;
});

const id = (n: number) =>
  `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number, title: string): WireItemOptions => ({
  id: id(n),
  properties: { title, body: `${title}\n` },
});
const put = (name: string, text: string) => {
  mkdirSync(join(folder!.dir, name, ".."), { recursive: true });
  writeFileSync(join(folder!.dir, name), text);
};

/** A folder of notes whose server holds `items`, takes the folder's writes
 *  as the real one does, and serves the event frames `elsewhere` adds. */
async function seed(items: WireItemOptions[] = []) {
  const rows: Record<string, { item: WireItemOptions }[]> = {
    "core.note": items.map((item) => ({ item })),
  };
  const frames: SseFrame[] = [];
  folder = await folderHarness("held-links", {
    rows,
    edges: { "parent-of": [], "attached-to": [] },
    events: [
      (request) =>
        copyReplay(
          String(frames.length + 1),
          frames.filter(
            (frame) =>
              Number(frame.id) > Number(request.headers["last-event-id"] ?? 0),
          ),
        ),
    ],
  });
  scriptFolderWrites(folder, { edges: new EdgeDoor() });
  /** As another device's change reaches the server and its event stream. */
  const elsewhere = (
    item: WireItemOptions,
    event: "item.created" | "item.deleted",
  ) => {
    if (event === "item.created") rows["core.note"]!.push({ item });
    frames.push(
      copyItemEvent(String(frames.length + 2), event, wireItem(item)),
    );
  };
  return { elsewhere };
}

/** A push, which scans the folder, sends what it queued and pulls. */
async function push() {
  const result = await folder!.folder.push();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value.scan;
}

async function fileAt(path: string) {
  const status = await folder!.folder.status();
  if (!status.ok) throw new Error(status.refusal.raw);
  const found = status.value.files.find((file) => file.path === path);
  expect(found, `${path} is not in the folder's status`).toBeDefined();
  return found!;
}

/** The id of the item the folder created with this title. */
function created(title: string): string {
  const sent = sentCreates(folder!).find(
    (create) => (create.properties as Record<string, unknown>).title === title,
  );
  expect(sent, `no item titled ${title} was created`).toBeDefined();
  return String(sent!.id);
}

/** The edges created, placements aside, as `create <source> <type>
 *  <target>`, sorted. A file leaving the folder deletes its placement. */
function edges(): string[] {
  return sentEdgeWrites(folder!)
    .filter((write) => write.startsWith("create "))
    .sort();
}

/** The name lookups the folder asked the server, for any name. */
function lookups(): number {
  return folder!.server.requests.filter(
    (request) =>
      request.pathname === "/items" &&
      (request.query.get("filter") ?? "").includes(" contains "),
  ).length;
}

describe("links held until their target exists", () => {
  it("resolves a body link once its target is created on this machine, and asks nothing while the folder is quiet", async () => {
    await seed();
    put("Ticket.md", "See [[Decision]].\n");
    const first = await push();
    expect(first.created).toBe(1);
    expect(first.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Ticket.md", "edges"],
    ]);
    expect(first.flagged[0]?.reason).toContain("matches no item");
    expect((await fileAt("Ticket.md")).status).toBe("held");

    // The witness: the first push asked the server for the name.
    const asked = lookups();
    expect(asked).toBeGreaterThan(0);
    // The push after the first takes in what the first sent; from then on
    // the folder is quiet.
    await push();
    const settled = lookups();
    for (let pass = 0; pass < 3; pass++) await push();
    expect(lookups(), "a quiet folder asked for the held name again").toBe(
      settled,
    );
    expect(edges()).toEqual([]);
    expect((await fileAt("Ticket.md")).reason).toContain("matches no item");

    put("Decision.md", "The decision.\n");
    const second = await push();
    expect(second.created).toBe(1);
    expect(second.flagged).toEqual([]);
    expect(edges()).toEqual([
      `create ${created("Ticket")} references ${created("Decision")}`,
    ]);
    const ticket = await fileAt("Ticket.md");
    expect(ticket.status).not.toBe("held");
    expect(ticket.flag).toBeUndefined();
  });

  it("resolves a link once its target, created on another device, is pulled in", async () => {
    const { elsewhere } = await seed();
    put("Ticket.md", '---\nabout: "[[Remote]]"\n---\nbody\n');
    const first = await push();
    expect(first.flagged.map((file) => file.flag)).toEqual(["edges"]);
    expect(first.flagged[0]?.reason).toContain("matches no item");

    elsewhere(note(1, "Remote"), "item.created");
    // The push that pulls it in, and the one after, which resolves the line.
    await push();
    const resolved = await push();
    expect(resolved.flagged).toEqual([]);
    expect(edges()).toEqual([`create ${created("Ticket")} about ${id(1)}`]);
    expect((await fileAt("Ticket.md")).status).not.toBe("held");
  });

  it("creates and links two new documents that link each other in one pass", async () => {
    await seed();
    put("A.md", "See [[B]].\n");
    put("B.md", '---\nchild-of: "[[A]]"\n---\nB\n');
    const report = await push();
    expect(report.created).toBe(2);
    expect(report.flagged).toEqual([]);
    const [a, b] = [created("A"), created("B")];
    expect(edges()).toEqual(
      [`create ${a} parent-of ${b}`, `create ${a} references ${b}`].sort(),
    );
  });

  for (const [first, then] of [
    ["A.md", "B.md"],
    ["B.md", "A.md"],
  ] as const) {
    it(`creates and links two documents that link each other, ${first} written a pass before ${then}`, async () => {
      await seed();
      const text: Record<string, string> = {
        "A.md": "See [[B]].\n",
        // A child naming a parent not yet created.
        "B.md": '---\nchild-of: "[[A]]"\n---\nB\n',
      };
      put(first, text[first]!);
      const held = await push();
      expect(held.created, "a document was held back for its link").toBe(1);
      expect(held.flagged.map((file) => [file.path, file.flag])).toEqual([
        [first, "edges"],
      ]);

      put(then, text[then]!);
      const resolved = await push();
      expect(resolved.created).toBe(1);
      expect(resolved.flagged).toEqual([]);
      const [a, b] = [created("A"), created("B")];
      expect(edges()).toEqual(
        [`create ${a} parent-of ${b}`, `create ${a} references ${b}`].sort(),
      );
      for (const path of ["A.md", "B.md"]) {
        expect((await fileAt(path)).status, path).not.toBe("held");
      }
    });
  }

  it("never guesses between two items of one name, and resolves once one goes to the bin", async () => {
    const one = note(1, "Same");
    const { elsewhere } = await seed([one, note(2, "Same")]);
    put("Ticket.md", "See [[Same]].\n");
    const first = await push();
    expect(first.flagged.map((file) => file.flag)).toEqual(["edges"]);
    expect(first.flagged[0]?.reason).toContain("more than one item");

    // Asked again after the copy changes, it is still not guessed.
    await push();
    const asked = lookups();
    put("Other.md", "other\n");
    await push();
    expect(lookups(), "the held name was not asked again").toBeGreaterThan(
      asked,
    );
    expect(edges()).toEqual([]);
    expect((await fileAt("Ticket.md")).reason).toContain("more than one item");

    one.state = "trashed";
    elsewhere({ ...one, version: 2 }, "item.deleted");
    await push();
    await push();
    expect(edges()).toEqual([
      `create ${created("Ticket")} references ${id(2)}`,
    ]);
    expect((await fileAt("Ticket.md")).status).not.toBe("held");
  });

  it("holds a link as waiting while the server is out of reach, and resolves it once it answers", async () => {
    await seed([note(1, "Target")]);
    await folder!.server.offline();
    put("Ticket.md", "See [[Target]].\n");
    const offline = await push();
    await folder!.server.online();
    expect(offline.flagged.map((file) => file.flag)).toEqual(["edges"]);
    expect(offline.flagged[0]?.reason).toContain(
      "once the server can be asked",
    );
    expect((await fileAt("Ticket.md")).reason).toContain(
      "once the server can be asked",
    );
    expect(edges()).toEqual([]);

    expect((await push()).flagged).toEqual([]);
    expect(edges()).toEqual([
      `create ${created("Ticket")} references ${id(1)}`,
    ]);
    expect((await fileAt("Ticket.md")).status).not.toBe("held");
  });
});
