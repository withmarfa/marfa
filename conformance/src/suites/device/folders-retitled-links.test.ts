import { afterEach, describe, expect, it } from "vitest";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { refusal } from "../../device/marfa-answers.js";
import type { FolderDoor } from "../../device/folder-door.js";
import type { DoorRow } from "../../device/folder-door.js";
import {
  KEY,
  folderHarness,
  scriptFolderRow,
  type FolderHarness,
  type FolderRow,
} from "./harness.js";
import {
  EdgeDoor,
  bodyOf,
  frontOf,
  heldEdges,
  idIn,
  isContentWrite,
  put,
  read,
  scriptFolderWrites,
  sentEdgeWrites,
  sentUpdates,
} from "./folders.shared.js";

// A wiki link to an item retitled since it was written is rewritten in the
// folder's file to name the item by its new title, as Obsidian does
// (`folders/body-link-retitled`), once the server took the title
// (`folders/body-link-retitled-waits`), never over bytes the person changed
// (`folders/body-link-retitled-edit`), by id where the title names another
// item too (`folders/body-link-retitled-id`), and unflagged while it waits
// (`folders/body-link-retitled-unflagged`).

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  await second?.stop();
  harness = undefined;
  second = undefined;
});

const HOST = [
  "---",
  'about: "[[Old]]"',
  "---",
  "See [[Old]], [[Old|the plan]] and [[Old#Steps]].",
  "",
  "`[[Old]]` stays, as does ![[Old]].",
  "",
].join("\n");
const BODY = HOST.slice(HOST.indexOf("See"));
const REWRITTEN = BODY.replace(
  "See [[Old]], [[Old|the plan]] and [[Old#Steps]].",
  "See [[New]], [[New|the plan]] and [[New#Steps]].",
);

interface Linked {
  door: FolderDoor;
  edges: EdgeDoor;
  held: Map<string, DoorRow>;
  old: string;
  host: string;
}

/** A folder whose push made `Old.md` and `Host.md`, which links to it
 *  three ways in its body and once in a frontmatter line. `joining` runs
 *  before the push, so another folder can join and hear the creates; it is
 *  given a second folder row, scripted before the item doors, whose read
 *  would answer for any id. */
async function linked(
  label: string,
  update?: (
    id: string,
    sent: Parameters<FolderDoor["update"]>[1],
  ) => ReturnType<FolderDoor["update"]> | undefined,
  joining?: (owner: FolderHarness, other: FolderRow) => Promise<void>,
): Promise<Linked> {
  const edges = new EdgeDoor();
  harness = await folderHarness(label, {
    rows: { "core.note": [] },
    events: [edges.stream()],
  });
  const other = scriptFolderRow(harness.server, {
    query: { types: ["core.note"] },
  });
  let door: FolderDoor | undefined;
  const held = scriptFolderWrites(harness, {
    edges,
    door: (made) => {
      door = made;
      if (update === undefined) return;
      const own = made.update.bind(made);
      made.update = (id, sent, options) =>
        update(id, sent) ?? own(id, sent, options);
    },
  });
  await joining?.(harness, other);
  put(harness, "Old.md", "---\ntitle: Old\n---\nThe plan.\n\n## Steps\n");
  put(harness, "Host.md", HOST);
  const pushed = await harness.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  const old = idIn(harness, "Old.md")!;
  const host = idIn(harness, "Host.md")!;
  expect(heldEdges(edges)).toEqual(
    [`${host} about ${old}`, `${host} references ${old}`].sort(),
  );
  expect(bodyOf(harness, "Host.md")).toBe(BODY);
  return { door: door!, edges, held, old, host };
}

/** Another machine retitles `id`, and the event stream carries it. */
function retitleElsewhere(
  { door, edges, held }: Linked,
  id: string,
  title: string,
): void {
  const answer = door.update(id, {
    properties: { title },
    version: held.get(id)!.version,
  });
  expect(answer.kind === "json" && answer.status).toBe(200);
  edges.logItem("item.updated", answer);
}

/** The rewrites of `id`'s body sent, as each was conditioned. */
function rewrites(
  mac: FolderHarness,
  id: string,
): Array<{ body: unknown; version_match: unknown }> {
  return sentUpdates(mac)
    .filter((sent) => sent.id === id && sent.body.version_match !== undefined)
    .map((sent) => ({
      body: (sent.body.properties as Record<string, unknown>).body,
      version_match: sent.body.version_match,
    }));
}

/** Hears the server's log, then brings the directory to the copy, sending
 *  nothing. */
async function caughtUp(mac: FolderHarness) {
  const heard = await mac.folder.device().catchUp();
  expect(heard.ok, JSON.stringify(heard)).toBe(true);
  return mac.folder.pull();
}

/** Pushes, and expects it to send and write nothing more. */
async function settled(mac: FolderHarness): Promise<void> {
  const host = read(mac, "Host.md");
  const before = mac.server.requests.filter(isContentWrite).length;
  const pushed = await mac.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  expect(
    mac.server.requests.filter(isContentWrite).length,
    "the folder went on writing once its links named the item again",
  ).toBe(before);
  expect(read(mac, "Host.md")).toBe(host);
}

describe("a body link to a retitled item", () => {
  it("names the item by its new title, its alias and heading kept, code, embeds and frontmatter lines left alone", async () => {
    const made = await linked("retitled-elsewhere");
    retitleElsewhere(made, made.old, "New");
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.pull?.relinked).toBe(1);
    expect(existsSync(join(harness!.dir, "New.md"))).toBe(true);
    expect(bodyOf(harness!, "Host.md")).toBe(REWRITTEN);
    // The line names the edge's item, which the pull renders by its title.
    expect(frontOf(harness!, "Host.md")).toContain('about: ["[[New]]"]');
    expect(frontOf(harness!, "Host.md")).not.toContain("references");
    expect(rewrites(harness!, made.host)).toEqual([
      { body: REWRITTEN, version_match: "exact" },
    ]);
    expect(made.held.get(made.host)?.properties.body).toBe(REWRITTEN);
    // The links name the same item, so no edge moves.
    expect(sentEdgeWrites(harness!).sort()).toEqual(
      [
        `create ${made.host} references ${made.old}`,
        `create ${made.host} about ${made.old}`,
      ].sort(),
    );
    await settled(harness!);
  });

  it("names the item by its new title where its file here was renamed", async () => {
    const made = await linked("retitled-here");
    renameSync(join(harness!.dir, "Old.md"), join(harness!.dir, "New.md"));
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(made.held.get(made.old)?.properties.title).toBe("New");
    expect(bodyOf(harness!, "Host.md")).toBe(REWRITTEN);
    expect(rewrites(harness!, made.host)).toHaveLength(1);
    await settled(harness!);
  });

  it("rewrites nothing for a title the server refuses", async () => {
    const made = await linked("retitled-refused", (_, sent) =>
      sent.properties?.title === "New"
        ? refusal(422, "validation_error", "Not a title this server takes")
        : undefined,
    );
    renameSync(join(harness!.dir, "Old.md"), join(harness!.dir, "New.md"));
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(made.held.get(made.old)?.properties.title).toBe("Old");
    expect(bodyOf(harness!, "Host.md")).toBe(BODY);
    expect(rewrites(harness!, made.host)).toEqual([]);
  });

  it("keeps an edit the person made and rewrites the links of what they wrote", async () => {
    const made = await linked("retitled-edited");
    retitleElsewhere(made, made.old, "New");
    put(harness!, "Host.md", `${read(harness!, "Host.md")}A thought.\n`);
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(bodyOf(harness!, "Host.md")).toBe(`${REWRITTEN}A thought.\n`);
    expect(made.held.get(made.host)?.properties.body).toBe(
      `${REWRITTEN}A thought.\n`,
    );
    await settled(harness!);
  });

  it("waits while a write of the linking document is unanswered, and rewrites it once answered", async () => {
    let unreachable = false;
    const made = await linked("retitled-unanswered", (id) =>
      unreachable && id !== undefined
        ? refusal(503, "service_unavailable", "Down for a moment")
        : undefined,
    );
    retitleElsewhere(made, made.old, "New");
    unreachable = true;
    put(harness!, "Host.md", `${read(harness!, "Host.md")}A thought.\n`);
    const waiting = await harness!.folder.push();
    expect(waiting.ok, JSON.stringify(waiting)).toBe(true);
    expect(read(harness!, "Host.md")).toContain("[[Old]], [[Old|the plan]]");
    expect(read(harness!, "Host.md")).toContain("A thought.\n");
    expect(rewrites(harness!, made.host)).toEqual([]);
    // Waiting, the link names the item still, and nothing is flagged.
    const flagged =
      waiting.ok && waiting.value.scan.flagged.map((flag) => flag.reason);
    expect(flagged).toEqual([]);

    unreachable = false;
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(bodyOf(harness!, "Host.md")).toBe(`${REWRITTEN}A thought.\n`);
    await settled(harness!);
  });

  it("names the item by its id where its new title names another item too", async () => {
    const made = await linked("retitled-namesake-title");
    put(harness!, "Other.md", "---\ntitle: New\n---\nAnother note.\n");
    expect((await harness!.folder.push()).ok).toBe(true);
    retitleElsewhere(made, made.old, "New");
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const id = made.old;
    expect(bodyOf(harness!, "Host.md")).toBe(
      BODY.replace(
        "See [[Old]], [[Old|the plan]] and [[Old#Steps]].",
        `See [[${id}|Old]], [[${id}|the plan]] and [[${id}#Steps|Old]].`,
      ),
    );
    await settled(harness!);
  });

  it("keeps naming the item when another takes its old title", async () => {
    const made = await linked("retitled-old-name-taken");
    retitleElsewhere(made, made.old, "New");
    put(harness!, "Newcomer.md", "---\ntitle: Old\n---\nA newcomer.\n");
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const newcomer = idIn(harness!, "Newcomer.md")!;
    expect(newcomer).not.toBe(made.old);
    expect(bodyOf(harness!, "Host.md")).toBe(REWRITTEN);
    expect(heldEdges(made.edges)).toEqual(
      [
        `${made.host} about ${made.old}`,
        `${made.host} references ${made.old}`,
      ].sort(),
    );
    await settled(harness!);
  });

  it.each([
    ["two machines hold the folder", "machines"],
    ["one machine holds two folders of it", "folders"],
  ] as const)("is rewritten once where %s", async (_, where) => {
    const made = await linked(
      `retitled-two-${where}`,
      undefined,
      async (owner, other) => {
        second = await folderHarness(
          `retitled-two-${where}-b`,
          where === "machines"
            ? {
                sharing: { server: owner.server, key: "another-mac-key" },
                folder: owner.settings,
              }
            : {
                sharing: { server: owner.server, key: KEY },
                folder: other,
                registry: owner.registry,
              },
        );
      },
    );
    expect((await caughtUp(second!)).ok).toBe(true);
    expect(bodyOf(second!, "Host.md")).toBe(BODY);
    // A folder that has joined sends where it lays its files out first.
    expect((await second!.folder.push()).ok).toBe(true);
    retitleElsewhere(made, made.old, "New");
    // Both rewrite before either sends, and only one rewrite lands.
    expect((await caughtUp(harness!)).ok).toBe(true);
    expect((await caughtUp(second!)).ok).toBe(true);
    expect(bodyOf(harness!, "Host.md")).toBe(REWRITTEN);
    expect(bodyOf(second!, "Host.md")).toBe(REWRITTEN);
    expect((await harness!.folder.push()).ok).toBe(true);
    const later = await second!.folder.push();
    expect(later.ok, JSON.stringify(later)).toBe(true);
    const landed = harness!.server.requests.filter(
      (request) =>
        request.method === "PATCH" &&
        request.pathname === `/items/${made.host}` &&
        request.body.includes('"version_match":"exact"'),
    );
    expect(landed).toHaveLength(2);
    expect(made.held.get(made.host)?.version).toBe(2);
    expect(made.held.get(made.host)?.properties.body).toBe(REWRITTEN);
    expect(bodyOf(second!, "Host.md")).toBe(REWRITTEN);
    // The losing copy took the winner's, and nothing waits.
    const queue = await second!.folder.device().queue();
    expect(
      queue.ok && queue.value.filter((write) => write.answered_at === null),
    ).toEqual([]);
    await settled(second!);
    await settled(harness!);
  });
});
