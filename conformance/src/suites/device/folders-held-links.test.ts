import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  copyItemEvent,
  copyReplay,
  edgeEvent,
  refusal,
  wireEdge,
  wireItem,
  type WireEdgeOptions,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { FolderDoor } from "../../device/folder-door.js";
import type { Answer, SseFrame } from "../../device/scripted-server.js";
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
// `folders/edge-held-retried`, `folders/edge-held-quiet`,
// `folders/edge-held-cleared`, `folders/edge-held-never-guessed`), and the
// names of its line that resolve are written meanwhile
// (`folders/edge-held-partly-written`). A name
// the server refused to look up on its own is not asked again
// (`folders/edge-lookup-no-repeat`), while the names of a lookup it refused
// as a whole wait and are asked again at the next scan
// (`folders/edge-lookup-call-retried`). A held file the person deletes, or one
// whose edit the server refused, goes to the bin unless another device
// changed its item (`folders/missing-held-line-unchanged`,
// `folders/missing-refused-edit-unchanged`).

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
 *  as the real one does, answers a title lookup that carries a name `lookup`
 *  answers with that answer, and serves the event frames `elsewhere` and
 *  `edgeElsewhere` add. */
async function seed(
  items: WireItemOptions[] = [],
  lookup?: (name: string) => Answer | undefined,
) {
  const rows: Record<string, { item: WireItemOptions }[]> = {
    "core.note": items.map((item) => ({ item })),
  };
  const frames: SseFrame[] = [];
  folder = await folderHarness("held-links", {
    rows,
    edges: { "parent-of": [], "attached-to": [] },
    lookup,
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
  const door = new EdgeDoor();
  let itemDoor: FolderDoor | undefined;
  scriptFolderWrites(folder, {
    edges: door,
    door: (made) => {
      itemDoor = made;
    },
  });
  /** As another device's change reaches the server and its event stream. */
  const elsewhere = (
    item: WireItemOptions,
    event:
      "item.created" | "item.updated" | "item.state_changed" | "item.deleted",
  ) => {
    if (event === "item.created") rows["core.note"]!.push({ item });
    frames.push(
      copyItemEvent(String(frames.length + 2), event, wireItem(item)),
    );
  };
  /** As another device's create or delete of an edge reaches the server
   *  and its event stream. */
  const edgeElsewhere = (
    event: "edge.created" | "edge.deleted",
    edge: WireEdgeOptions,
  ) => {
    if (event === "edge.created") door.hold(edge);
    else door.edges.delete(edge.id);
    frames.push(edgeEvent(String(frames.length + 2), event, wireEdge(edge)));
  };
  return { elsewhere, edgeElsewhere, door, itemDoor: itemDoor! };
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

/** The title lookups the folder sent the server, each for up to 200 names. */
function lookups(): number {
  return titleCalls().length;
}

/** The names each title lookup carried, in the order sent. */
function titleCalls(): string[][] {
  return folder!.server.requests
    .filter((request) => request.pathname === "/items/titles")
    .map((request) => (JSON.parse(request.body) as { names: string[] }).names);
}

/** Writes `first`, pushes, then writes `then` and pushes again: A.md
 *  links B.md in its body, and B.md names A.md as its parent. */
async function twoPasses(first: "A.md" | "B.md", then: "A.md" | "B.md") {
  await seed();
  const text = {
    "A.md": "See [[B]].\n",
    // A child naming a parent not yet created.
    "B.md": '---\nchild-of: "[[A]]"\n---\nB\n',
  };
  put(first, text[first]);
  const held = await push();
  expect(held.created, "a document was held back for its link").toBe(1);
  expect(held.flagged.map((file) => [file.path, file.flag])).toEqual([
    [first, "edges"],
  ]);

  put(then, text[then]);
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

  it("writes the edge of each name on a line that resolves while it holds one that matches no item, and adds the other once it exists", async () => {
    await seed([note(1, "Marfa")]);
    const text = '---\nabout:\n  - "[[Marfa]]"\n  - "[[Plans]]"\n---\nbody\n';
    put("Ticket.md", text);
    const first = await push();
    expect(first.created).toBe(1);
    expect(first.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Ticket.md", "edges"],
    ]);
    const reason = first.flagged[0]?.reason ?? "";
    expect(reason).toContain("[[Plans]]");
    expect(reason).toContain("matches no item");
    expect(reason, "the name that resolved was held too").not.toContain(
      "[[Marfa]]",
    );
    const ticket = created("Ticket");
    expect(edges()).toEqual([`create ${ticket} about ${id(1)}`]);
    expect((await fileAt("Ticket.md")).status).toBe("held");
    expect(readFileSync(join(folder!.dir, "Ticket.md"), "utf8")).toBe(text);

    // Held while it is unchanged, the line writes nothing more.
    await push();
    await push();
    expect(edges()).toEqual([`create ${ticket} about ${id(1)}`]);

    put("Plans.md", "The plans.\n");
    const second = await push();
    expect(second.created).toBe(1);
    expect(second.flagged).toEqual([]);
    expect(
      edges(),
      "the first edge was written again, or the other not written",
    ).toEqual(
      [
        `create ${ticket} about ${id(1)}`,
        `create ${ticket} about ${created("Plans")}`,
      ].sort(),
    );
    const settled = await fileAt("Ticket.md");
    expect(settled.status).not.toBe("held");
    expect(settled.flag).toBeUndefined();
  });

  it("writes the edge of each name on a line that resolves while it holds one matching two items, and never guesses the other", async () => {
    await seed([note(1, "Marfa"), note(2, "Same"), note(3, "Same")]);
    put(
      "Ticket.md",
      '---\nabout:\n  - "[[Marfa]]"\n  - "[[Same]]"\n---\nbody\n',
    );
    const first = await push();
    expect(first.flagged.map((file) => file.flag)).toEqual(["edges"]);
    expect(first.flagged[0]?.reason).toContain("more than one item");
    await push();
    expect(edges()).toEqual([`create ${created("Ticket")} about ${id(1)}`]);
  });

  it("keeps the edge of a name that matches no item because its item is in the bin, and takes out the edge of a name removed from the line", async () => {
    const plans = note(2, "Plans");
    const { elsewhere } = await seed([
      note(1, "Marfa"),
      plans,
      note(3, "Notes"),
    ]);
    put(
      "Ticket.md",
      '---\nabout:\n  - "[[Marfa]]"\n  - "[[Plans]]"\n  - "[[Notes]]"\n---\nbody\n',
    );
    await push();
    await push();
    const ticket = created("Ticket");
    expect(edges()).toEqual(
      [1, 2, 3].map((n) => `create ${ticket} about ${id(n)}`),
    );

    // Plans goes to the bin elsewhere, so its name matches no item though
    // the line names it; Notes is taken out of the line, beside a new name
    // that matches no item.
    plans.state = "trashed";
    elsewhere({ ...plans, version: 2 }, "item.deleted");
    await push();
    await push();
    // The file of the item in the bin leaves the folder, taking its
    // placement with it.
    const deletes = () =>
      sentEdgeWrites(folder!).filter((write) => write.startsWith("delete "))
        .length;
    const leaving = deletes();
    put(
      "Ticket.md",
      '---\nabout:\n  - "[[Marfa]]"\n  - "[[Plans]]"\n  - "[[Ghost]]"\n---\nbody\n',
    );
    const held = await push();
    expect(held.flagged.map((file) => file.flag)).toEqual(["edges"]);
    await push();
    expect(
      deletes() - leaving,
      "the edge of the name taken out stayed, or the edge of an item in the bin went",
    ).toBe(1);
  });

  it("writes none of a line that has room for one item and holds a name", async () => {
    await seed([note(1, "Marfa")]);
    put(
      "Ticket.md",
      '---\nchild-of:\n  - "[[Marfa]]"\n  - "[[Plans]]"\n---\nbody\n',
    );
    const first = await push();
    expect(first.flagged.map((file) => file.flag)).toEqual(["edges"]);
    await push();
    expect(
      edges(),
      "a child was given a parent while its line held a name",
    ).toEqual([]);

    // The witness: the same line, naming one item, makes its edge.
    put("Ticket.md", '---\nchild-of: "[[Marfa]]"\n---\nbody\n');
    await push();
    await push();
    expect(edges()).toEqual([`create ${id(1)} parent-of ${created("Ticket")}`]);
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

  it("creates and links two documents that link each other, A.md written a pass before B.md", async () => {
    await twoPasses("A.md", "B.md");
  });

  it("creates and links two documents that link each other, B.md written a pass before A.md", async () => {
    await twoPasses("B.md", "A.md");
  });

  it("never guesses between two items of one name, and resolves once one goes to the bin", async () => {
    const one = note(1, "Same");
    const { elsewhere } = await seed([one, note(2, "Same")]);
    put("Ticket.md", "See [[Same]].\n");
    const first = await push();
    expect(first.flagged.map((file) => file.flag)).toEqual(["edges"]);
    expect(first.flagged[0]?.reason).toContain("more than one item");

    // Judged again after the copy changes, it is still not guessed, and the
    // server is not asked: no answer of its could make a name the copy holds
    // twice into one.
    await push();
    const asked = lookups();
    put("Other.md", "other\n");
    await push();
    expect(
      lookups(),
      "a name the copy holds twice was asked of the server",
    ).toBe(asked);
    expect(titleCalls().flat()).not.toContain("Same");
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
    expect(
      titleCalls().flat(),
      "the name was not asked once the copy held it once",
    ).toContain("Same");
  });

  it("asks the server for the names of a scan in calls of 200, each distinct name once", async () => {
    await seed();
    const names = Array.from(
      { length: 450 },
      (_, n) => `Absent ${String(n).padStart(3, "0")}`,
    );
    const links = (from: number, to: number) =>
      `${names
        .slice(from, to)
        .map((name) => `[[${name}]]`)
        .join(" ")}\n`;
    // 150 names are linked from both files.
    put("A.md", links(0, 300));
    put("B.md", links(150, 450));
    const first = await push();
    expect(first.created).toBe(2);
    const calls = titleCalls();
    expect(calls.map((call) => call.length)).toEqual([200, 200, 50]);
    expect([...calls.flat()].sort()).toEqual([...names].sort());
    expect(
      folder!.server.requests.filter(
        (request) =>
          request.pathname === "/items" &&
          (request.query.get("filter") ?? "").includes(" contains "),
      ),
      "a name was looked up with a listing, one request for each",
    ).toEqual([]);
  });

  it("leaves a name the copy holds under two items out of the lookup, and asks the rest", async () => {
    await seed([note(1, "Twin"), note(2, "Twin")]);
    put("Ticket.md", "See [[Twin]] and [[Absent]].\n");
    const first = await push();
    expect(first.flagged[0]?.reason).toContain("more than one item");
    expect(titleCalls().flat()).toEqual(["Absent"]);
  });

  it("does not ask again for a name a lookup of it alone was refused, and the file stays flagged with the refusal", async () => {
    await seed([], (name) =>
      name === "Denied"
        ? refusal(403, "forbidden", "This key may not list here")
        : undefined,
    );
    put("Ticket.md", "See [[Denied]].\n");
    const first = await push();
    expect(titleCalls()).toEqual([["Denied"]]);
    expect(first.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Ticket.md", "edges"],
    ]);
    expect(first.flagged[0]?.reason).toContain(
      "[[Denied]] in its body could not be looked up (forbidden",
    );
    expect(first.lookup_refused).toBeNull();

    // The witness that the copy changed: a new note is made, and its name
    // is no lookup the held file makes.
    put("Decision.md", "The decision.\n");
    const second = await push();
    expect(second.created).toBe(1);
    const ticket = await fileAt("Ticket.md");
    expect(ticket.status).toBe("held");
    expect(ticket.reason).toContain(
      "[[Denied]] in its body could not be looked up",
    );
    expect(titleCalls(), "the refused name was asked again").toEqual([
      ["Denied"],
    ]);
  });

  it("holds the links a server without the title lookup left waiting, says so once, and resolves them once it has one, the files unedited", async () => {
    // A server older than `POST /items/titles` answers it as no route.
    let upgraded = false;
    await seed([note(1, "Target")], () =>
      upgraded ? undefined : refusal(404, "not_found", "Not found"),
    );
    put("Ticket.md", "See [[Target]] and [[Decision]].\n");
    put("Decision.md", "The decision.\n");
    const old = await push();
    expect(old.created).toBe(2);
    expect(lookups(), "the old server was asked more than once").toBe(1);
    expect(old.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Ticket.md", "edges"],
    ]);
    const reason = old.flagged[0]?.reason ?? "";
    expect(reason).toContain(
      "[[Target]] in its body is looked up once the server can be asked",
    );
    expect(reason).toContain(
      "[[Decision]] in its body is looked up once the server can be asked",
    );
    expect(reason, "each file was told the server's refusal").not.toContain(
      "not_found",
    );
    expect(old.lookup_refused).toContain("no title lookup");
    expect(edges()).toEqual([]);

    upgraded = true;
    const now = await push();
    expect(now.flagged).toEqual([]);
    expect(now.lookup_refused).toBeNull();
    expect(edges()).toEqual(
      [
        `create ${created("Ticket")} references ${id(1)}`,
        `create ${created("Ticket")} references ${created("Decision")}`,
      ].sort(),
    );
    expect((await fileAt("Ticket.md")).status).not.toBe("held");
  });

  it("holds the one link a server without the title lookup refused, as the call's refusal and not the name's", async () => {
    // The refusal of a route the server does not have is the same for a call
    // of one name as for a call of many.
    let upgraded = false;
    await seed([note(1, "Target")], () =>
      upgraded ? undefined : refusal(404, "not_found", "Not found"),
    );
    put("Ticket.md", "See [[Target]].\n");
    const old = await push();
    expect(titleCalls()).toEqual([["Target"]]);
    expect(old.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Ticket.md", "edges"],
    ]);
    const reason = old.flagged[0]?.reason ?? "";
    expect(reason).toContain(
      "[[Target]] in its body is looked up once the server can be asked",
    );
    expect(
      reason,
      "the name was flagged with the server's refusal",
    ).not.toContain("could not be looked up");
    expect(old.lookup_refused).toContain("no title lookup");

    // Unlike a name refused on its own, it is asked again with the file
    // unedited.
    upgraded = true;
    const now = await push();
    expect(now.flagged).toEqual([]);
    expect(now.lookup_refused).toBeNull();
    expect(edges()).toEqual([
      `create ${created("Ticket")} references ${id(1)}`,
    ]);
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

describe("a held file the person deletes", () => {
  const ticket = note(10, "Ticket");
  const parent = note(12, "Parent");
  const path = () => join(folder!.dir, "Ticket.md");

  /** Ticket.md as the folder wrote it, given a parent no item is named for
   *  and then deleted, and scanned once since. */
  async function deletedHeldTicket() {
    const seeded = await seed([ticket]);
    await push();
    const text = readFileSync(path(), "utf8");
    expect(text.startsWith("---\n"), text).toBe(true);
    writeFileSync(
      path(),
      text.replace(/^---\n/, '---\nchild-of: "[[Missing]]"\n'),
    );
    const held = await push();
    expect(held.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Ticket.md", "edges"],
    ]);
    expect(held.flagged[0]?.reason).toContain("matches no item");
    rmSync(path());
    const scanned = await folder!.folder.scan();
    expect(scanned.ok && scanned.value.missing).toBe(1);
    return seeded;
  }

  /** The items the folder queued a delete for. */
  async function deletesQueued(): Promise<string[]> {
    const queued = await folder!.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return [];
    return queued.value
      .filter((row) => row.kind === "delete_item")
      .map((row) => String(row.item_id));
  }

  /** A pull that leaves Ticket.md deleted, and a sweep once the grace has
   *  run out. */
  async function sweptUnwritten() {
    const pulled = await folder!.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.revived,
      "the person's delete was written back as a change made elsewhere",
    ).toBe(0);
    expect(existsSync(path())).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const swept = await folder!.folder.scan();
    expect(swept.ok && swept.value.deleted).toBe(1);
  }

  it("trashes the item of a deleted file held for a parent no item is named for", async () => {
    await deletedHeldTicket();
    await sweptUnwritten();
    expect(
      await deletesQueued(),
      "the person's delete was never sent, and the file's absence stands on every pass",
    ).toEqual([ticket.id]);
  });

  it("trashes the item of a deleted held file once an item of the held name appears", async () => {
    const { elsewhere } = await deletedHeldTicket();
    elsewhere(note(11, "Missing"), "item.created");
    const caught = await folder!.folder.device().catchUp();
    expect(caught.ok && caught.value.applied).toBe(1);
    await sweptUnwritten();
    // The witness that the pull took the new item in.
    expect(existsSync(join(folder!.dir, "Missing.md"))).toBe(true);
    expect(await deletesQueued()).toEqual([ticket.id]);
  });

  it("writes back a deleted held file when another device changes its item inside the grace", async () => {
    const { elsewhere } = await deletedHeldTicket();
    elsewhere(
      {
        ...ticket,
        version: 5,
        properties: { title: "Ticket", body: "Their edit\n" },
      },
      "item.updated",
    );
    const caught = await folder!.folder.device().catchUp();
    expect(caught.ok && caught.value.applied).toBe(1);
    const pulled = await folder!.folder.pull();
    expect(pulled.ok && pulled.value.revived).toBe(1);
    expect(readFileSync(path(), "utf8")).toContain("Their edit");

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const swept = await folder!.folder.scan();
    expect(swept.ok && swept.value.deleted).toBe(0);
    expect(
      await deletesQueued(),
      "a delete was sent for an item changed elsewhere after the person deleted its file",
    ).toEqual([]);
  });

  /** Ticket.md with a `line` line naming Parent, which the server took,
   *  then naming Missing too, so held, and deleted and scanned once since. */
  async function deletedHeldLine(line: "child-of" | "about") {
    const seeded = await seed([ticket, parent]);
    await push();
    const text = readFileSync(path(), "utf8");
    writeFileSync(
      path(),
      text.replace(/^---\n/, `---\n${line}: "[[Parent]]"\n`),
    );
    expect((await push()).flagged).toEqual([]);
    expect(edges()).toHaveLength(1);
    const shown = new RegExp(`^${line}: .*\n`, "m");
    const linked = readFileSync(path(), "utf8");
    expect(linked).toMatch(shown);
    writeFileSync(
      path(),
      linked.replace(shown, `${line}: ["[[Parent]]", "[[Missing]]"]\n`),
    );
    const held = await push();
    expect(held.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Ticket.md", "edges"],
    ]);
    expect(held.flagged[0]?.reason).toContain("matches no item");
    rmSync(path());
    const scanned = await folder!.folder.scan();
    expect(scanned.ok && scanned.value.missing).toBe(1);
    return seeded;
  }

  /** A catch-up that takes in one change, a pull inside the grace that
   *  writes Ticket.md back, and a sweep after it that sends no delete. */
  async function writtenBack(): Promise<string> {
    const caught = await folder!.folder.device().catchUp();
    expect(caught.ok && caught.value.applied).toBe(1);
    const pulled = await folder!.folder.pull();
    expect(
      pulled.ok && pulled.value.revived,
      "the change another device made did not bring the file back",
    ).toBe(1);
    const text = readFileSync(path(), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const swept = await folder!.folder.scan();
    expect(swept.ok && swept.value.deleted).toBe(0);
    expect(await deletesQueued()).toEqual([]);
    return text;
  }

  it("trashes the item of a deleted file held beside names its line wrote as edges", async () => {
    await seed([ticket, parent, note(13, "Other")]);
    await push();
    const text = readFileSync(path(), "utf8");
    writeFileSync(
      path(),
      text.replace(
        /^---\n/,
        '---\nabout: ["[[Parent]]", "[[Other]]", "[[Missing]]"]\n',
      ),
    );
    const held = await push();
    expect(held.flagged.map((file) => [file.path, file.flag])).toEqual([
      ["Ticket.md", "edges"],
    ]);
    expect(
      edges(),
      "the witness: the line wrote the edges of the names that resolved",
    ).toEqual(
      [
        `create ${ticket.id} about ${id(12)}`,
        `create ${ticket.id} about ${id(13)}`,
      ].sort(),
    );
    rmSync(path());
    const scanned = await folder!.folder.scan();
    expect(scanned.ok && scanned.value.missing).toBe(1);
    await sweptUnwritten();
    expect(await deletesQueued()).toEqual([ticket.id]);
  });

  it("writes back a deleted held file when another device removes an edge its held line made", async () => {
    const { edgeElsewhere, door } = await deletedHeldLine("child-of");
    const edge = [...door.edges.values()].find(
      (held) => held.edge_type === "parent-of" && held.target_id === ticket.id,
    );
    expect(edge, "the server holds the line's edge").toBeDefined();
    edgeElsewhere("edge.deleted", edge!);
    expect(await writtenBack()).not.toContain("[[Parent]]");
  });

  it("writes back a deleted held file when another device adds an edge to its held line", async () => {
    const { elsewhere, edgeElsewhere } = await deletedHeldLine("about");
    elsewhere(note(13, "Other"), "item.created");
    const caught = await folder!.folder.device().catchUp();
    expect(caught.ok && caught.value.applied).toBe(1);
    edgeElsewhere("edge.created", {
      id: id(14),
      source_id: ticket.id,
      target_id: id(13),
      edge_type: "about",
    });
    expect(await writtenBack()).toContain("[[Other]]");
  });

  /** Ticket.md given an edit the server refused, then deleted, and scanned
   *  once since. Answers the version line the file showed. */
  async function deletedRefusedTicket() {
    const seeded = await seed([ticket]);
    await push();
    const own = seeded.itemDoor.update.bind(seeded.itemDoor);
    seeded.itemDoor.update = (item, sent, options) =>
      item === ticket.id
        ? refusal(422, "validation_error", "Not a body this server takes")
        : own(item, sent, options);
    writeFileSync(path(), `${readFileSync(path(), "utf8")}Their own edit.\n`);
    await push();
    const refused = await fileAt("Ticket.md");
    expect(refused.flag, JSON.stringify(refused)).toBe("refused");
    const text = readFileSync(path(), "utf8");
    expect(text).toContain("Their own edit.");
    const version = Number(/^marfa_version: (\d+)$/m.exec(text)?.[1]);
    expect(version, text).toBeGreaterThan(0);
    rmSync(path());
    const scanned = await folder!.folder.scan();
    expect(scanned.ok && scanned.value.missing).toBe(1);
    return { ...seeded, version };
  }

  it("trashes the item of a deleted file whose edit the server refused", async () => {
    await deletedRefusedTicket();
    await sweptUnwritten();
    expect(await deletesQueued()).toEqual([ticket.id]);
  });

  it("writes back a deleted file whose edit the server refused when another device archives its item", async () => {
    const { elsewhere, version } = await deletedRefusedTicket();
    // The server changes an item's state without a version step.
    elsewhere({ ...ticket, version, state: "archived" }, "item.state_changed");
    const caught = await folder!.folder.device().catchUp();
    expect(caught.ok && caught.value.applied).toBe(1);
    const pulled = await folder!.folder.pull();
    expect(pulled.ok && pulled.value.revived).toBe(1);
    const text = readFileSync(path(), "utf8");
    expect(text).toContain("state: archived");
    expect(text).toMatch(new RegExp(`^marfa_version: ${version}$`, "m"));
    expect(await deletesQueued()).toEqual([]);
  });
});
