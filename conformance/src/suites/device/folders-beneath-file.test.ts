import { afterEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { answers, refusal } from "../../device/marfa-answers.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import type { Item, Outcome } from "../../device/protocol.js";
import type { Answer } from "../../device/scripted-server.js";
import { folderHarness, folderItem, type FolderHarness } from "./harness.js";
import { ON_MACOS } from "../../utils/platform.js";
import { put, scriptFolderWrites } from "./folders.shared.js";

/**
 * A folder whose query narrows beneath the path of a file it holds, on a
 * scripted server that can answer the folder door as it is not made to
 * answer a real one.
 */

let harness: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const id = (n: number): string =>
  `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const note = (n: number, title: string) => ({
  item: { id: id(n), properties: { title, body: `${title}\n` } },
});

const parentOf = (n: number, from: number, to: number) => ({
  id: `01a00000-0000-7000-8000-00000000e${String(n).padStart(3, "0")}`,
  from_id: id(from),
  to_id: id(to),
});

const PATH = "Projects/project.md";

/** The id a copy narrows beneath while the query names a path, which no
 *  item has. */
const NO_ITEM = "00000000-0000-7000-8000-000000000000";

const noItem = (server: FolderHarness["server"]): void => {
  server.copyAnswer(
    "GET",
    `/items/${NO_ITEM}`,
    refusal(404, "item_not_found", "Item not found"),
  );
};

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

async function heldIds(folder: FolderHarness): Promise<string[]> {
  const held = value(
    await folder.folder.device().list({ type: "core.note", allStates: true }),
  ) as Item[];
  return held.map((item) => item.id).sort();
}

/** A folder narrowed beneath `PATH`, whose file carries the id of the
 *  project the server holds, with two notes beneath it and one outside. */
async function beneathFile(
  label: string,
  named = PATH,
  at = PATH,
): Promise<FolderHarness> {
  const made = await folderHarness(label, {
    settings: { query: { types: ["core.note"], beneath: named } },
    items: {
      "core.note": [
        note(1, "Project"),
        note(2, "Inside one"),
        note(3, "Inside two"),
        note(4, "Outside"),
      ],
    },
    edges: { "parent-of": [parentOf(1, 1, 2), parentOf(2, 1, 3)] },
    beforeAdd: noItem,
    files: {
      [at]: `---\nmarfa_id: ${id(1)}\ntitle: Project\n---\nProject\n`,
    },
  });
  scriptFolderWrites(made);
  return made;
}

/** Answers the folder door's changes as the server does, counting them. */
function changes(
  folder: FolderHarness,
  first?: () => Answer | undefined,
): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  folder.server.answer("PATCH", `/folders/${folder.settings.id}`, (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    sent.push(body);
    const refused = sent.length === 1 ? first?.() : undefined;
    if (refused !== undefined) return refused;
    const { version: _version, ...settings } = body;
    folder.settings.settings = { ...folder.settings.settings, ...settings };
    folder.settings.version += 1;
    return answers.updated(folderItem(folder.settings));
  });
  return sent;
}

/** Another device's change to the folder, and the changes a device sends
 *  after it. */
const CHANGES: Array<[string, Partial<FolderSettings>, number]> = [
  [
    "the project was named by another device",
    { query: { types: ["core.note"], beneath: id(1) } },
    0,
  ],
  ["the folder was renamed by another device", { title: "renamed" }, 1],
];

const written = (folder: FolderHarness): string[] =>
  readdirSync(folder.dir).filter((name) => name !== ".marfa");

describe("a folder narrowed beneath a file it holds", () => {
  it("names the project's item once its file is sent, and pulls what lies beneath in the same pass", async () => {
    harness = await beneathFile("beneath-file-pass");
    const sent = changes(harness);

    const pushed = value(await harness.folder.push());
    expect(pushed.pull?.written).toBe(2);
    expect(sent).toEqual([
      { version: 1, query: { types: ["core.note"], beneath: id(1) } },
    ]);
    expect(await heldIds(harness)).toEqual([id(1), id(2), id(3)]);
    expect(written(harness).sort()).toEqual([
      "Inside one.md",
      "Inside two.md",
      "Projects",
    ]);

    // The witness: the note outside is one the server gives.
    value(await harness.folder.device().pin(id(4)));
    expect(await heldIds(harness)).toContain(id(4));
  });

  it.each(CHANGES)(
    "reads the folder again when %s between its read and its change",
    async (_name, change, resent) => {
      harness = await beneathFile("beneath-file-conflict");
      const row = harness.settings;
      const sent = changes(harness, () => {
        row.settings = { ...row.settings, ...change };
        row.version += 1;
        return refusal(409, "version_conflict", "The folder moved on");
      });

      value(await harness.folder.push());
      expect(sent).toHaveLength(1 + resent);
      if (resent === 1) expect(sent[1]?.version).toBe(2);
      expect(row.settings.query).toEqual({
        types: ["core.note"],
        beneath: id(1),
      });
      expect(await heldIds(harness)).toEqual([id(1), id(2), id(3)]);
    },
  );

  it("holds nothing from the server while the change is not sent, and finishes at the next pass", async () => {
    harness = await beneathFile("beneath-file-interrupted");
    let down = true;
    const sent = changes(harness, () =>
      down ? refusal(503, "unavailable", "The server is busy") : undefined,
    );

    value(await harness.folder.push());
    expect(sent).toHaveLength(1);
    expect(await heldIds(harness)).toEqual([id(1)]);
    expect(written(harness)).toEqual(["Projects"]);
    const status = value(await harness.folder.status());
    expect(status.beneath_waiting).toBe(PATH);

    down = false;
    value(await harness.folder.push());
    expect(await heldIds(harness)).toEqual([id(1), id(2), id(3)]);
    expect(written(harness).sort()).toEqual([
      "Inside one.md",
      "Inside two.md",
      "Projects",
    ]);
  });

  it(
    "takes the file the query names for the one the folder holds, as the folder compares paths",
    ON_MACOS,
    async () => {
      // One file name, in two Unicode forms and two cases: the file system
      // opens both.
      harness = await beneathFile(
        "beneath-file-names",
        "projects/CAF\u00c9.md",
        "Projects/Cafe\u0301.md",
      );
      changes(harness);

      value(await harness.folder.push());
      expect(harness.settings.settings.query).toEqual({
        types: ["core.note"],
        beneath: id(1),
      });
      expect(await heldIds(harness)).toEqual([id(1), id(2), id(3)]);
    },
  );

  it("refuses a first sync that names a file the folder does not have, writing and sending nothing", async () => {
    harness = await folderHarness("beneath-file-missing", {
      settings: { query: { types: ["core.note"], beneath: PATH } },
      items: { "core.note": [note(1, "Project"), note(2, "Inside")] },
      edges: { "parent-of": [parentOf(1, 1, 2)] },
      beforeAdd: noItem,
    });
    scriptFolderWrites(harness);
    const sent = changes(harness);
    put(harness, "other.md", "---\ntitle: Other\n---\nother\n");

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(false);
    if (!pushed.ok) expect(pushed.refusal.raw).toContain(PATH);
    expect(sent).toEqual([]);
    expect(written(harness)).toEqual(["other.md"]);
    expect(
      harness.server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ),
    ).toEqual([]);
  });
});
