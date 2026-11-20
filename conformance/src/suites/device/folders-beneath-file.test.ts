import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { answers, refusal } from "../../device/marfa-answers.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import type { Item, Outcome } from "../../device/protocol.js";
import type { Answer, RecordedRequest } from "../../device/scripted-server.js";
import {
  KEY,
  folderHarness,
  folderItem,
  scriptFolderItem,
  type FolderHarness,
} from "./harness.js";
import {
  onCaseSensitiveVolume,
  idIn,
  put,
  scriptFolderWrites,
  sentTitles,
  settingsFile,
} from "./folders.shared.js";

/**
 * A folder whose query narrows beneath the path of a file it holds, on a
 * scripted server that can answer the folder door as it is not made to
 * answer a real one.
 */

let harness: FolderHarness | undefined;
let elsewhere: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await elsewhere?.stop();
  harness = undefined;
  elsewhere = undefined;
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
const CHILD = "Notes/child.md";

/** An id a device once narrowed a copy beneath while the query named a path;
 *  an item may have it, as the server takes any id a client chooses. */
const RESERVED = "00000000-0000-7000-8000-000000000000";

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
  settings: Partial<FolderSettings> = {},
): Promise<FolderHarness> {
  const made = await folderHarness(label, {
    settings: { ...settings, query: { types: ["core.note"], beneath: named } },
    items: {
      "core.note": [
        note(1, "Project"),
        note(2, "Inside one"),
        note(3, "Inside two"),
        note(4, "Outside"),
        {
          item: {
            id: RESERVED,
            properties: { title: "Reserved", body: "r\n" },
          },
        },
      ],
    },
    edges: { "parent-of": [parentOf(1, 1, 2), parentOf(2, 1, 3)] },
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

/** What stops a device between sending the file and changing the query: the
 *  folder door answers it is busy, or the connection drops. */
const INTERRUPTIONS: Array<[string, Answer]> = [
  [
    "the folder door answered it was busy",
    refusal(503, "unavailable", "The server is busy"),
  ],
  ["the connection dropped", { kind: "drop" }],
];

/** The requests that list items. */
const listings = (folder: FolderHarness): RecordedRequest[] =>
  folder.server.requests.filter(
    (request) => request.method === "GET" && request.pathname === "/items",
  );

/** The requests that name the id a device once made up. */
const namingReserved = (folder: FolderHarness): string[] =>
  folder.server.requests
    .filter((request) => request.target.includes(RESERVED))
    .map((request) => `${request.method} ${request.target}`);

/** The items the device asked the server to make. */
const created = (folder: FolderHarness): number =>
  folder.server.requests.filter(
    (request) => request.method === "POST" && request.pathname === "/items",
  ).length;

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

  it.each(INTERRUPTIONS)(
    "holds nothing from the server while the change is not sent after %s, and finishes at the next pass",
    async (_name, interrupted) => {
      harness = await beneathFile("beneath-file-interrupted");
      let down = true;
      const sent = changes(harness, () => (down ? interrupted : undefined));

      value(await harness.folder.push());
      expect(sent).toHaveLength(1);
      expect(await heldIds(harness)).toEqual([id(1)]);
      expect(written(harness)).toEqual(["Projects"]);
      const status = value(await harness.folder.status());
      expect(status.beneath_waiting).toBe(PATH);
      // No request asked the server for items beneath a path, or named an id
      // the folder made up.
      expect(listings(harness)).toEqual([]);
      expect(namingReserved(harness)).toEqual([]);

      down = false;
      value(await harness.folder.push());
      const change = harness.server.requests
        .filter((request) => request.method === "PATCH")
        .at(-1);
      expect(await heldIds(harness)).toEqual([id(1), id(2), id(3)]);
      expect(written(harness).sort()).toEqual([
        "Inside one.md",
        "Inside two.md",
        "Projects",
      ]);
      // Nothing was pulled before the path was replaced by the item's id.
      const asked = listings(harness);
      expect(asked.length).toBeGreaterThan(0);
      for (const request of asked) {
        expect(request.seq).toBeGreaterThan(change?.seq ?? Infinity);
        // The conflicted copies are listed beside, whatever they are under.
        if (request.query.get("tags") === null)
          expect(request.query.get("beneath")).toBe(id(1));
      }
      expect(namingReserved(harness)).toEqual([]);
    },
  );

  it("writes nothing from outside the project while its key cannot name it, keeps what lies beneath it in step, and says why the path waits", async () => {
    // Another folder on the computer holds every note: an umbrella and the
    // projects under it.
    elsewhere = await folderHarness("beneath-file-elsewhere", {
      items: {
        "core.note": [
          note(10, "Umbrella"),
          note(11, "Sibling"),
          note(12, "Cousin"),
        ],
      },
      edges: {
        "parent-of": [parentOf(1, 10, 11), parentOf(2, 10, 12)],
      },
    });
    // Before the item doors, whose read would answer for any id.
    const folder = scriptFolderItem(elsewhere.server, {
      query: { types: ["core.note"], beneath: PATH },
    });
    scriptFolderWrites(elsewhere);
    value(await elsewhere.folder.pull());
    expect(written(elsewhere).sort()).toEqual([
      "Cousin.md",
      "Sibling.md",
      "Umbrella.md",
    ]);

    // This folder's project is new and names the umbrella as its parent, and
    // its key reads `system.folder` but cannot write it.
    harness = await folderHarness("beneath-file-unnamed", {
      sharing: { server: elsewhere.server, key: KEY },
      registry: elsewhere.registry,
      folder,
      files: {
        [PATH]: '---\ntitle: Project\nchild-of: "[[Umbrella]]"\n---\nProject\n',
      },
    });
    let writable = false;
    const sent: Array<Record<string, unknown>> = [];
    harness.server.answer("PATCH", `/folders/${folder.id}`, (request) => {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      sent.push(body);
      if (!writable)
        return refusal(
          403,
          "type_not_permitted",
          'Write access to type "system.folder" denied',
        );
      const { version: _version, ...settings } = body;
      folder.settings = { ...folder.settings, ...settings };
      folder.version += 1;
      return answers.updated(folderItem(folder));
    });

    const pushes = [
      value(await harness.folder.push()),
      value(await harness.folder.push()),
    ];
    expect(sent).toHaveLength(2);
    // The witness: the umbrella is in this folder's copy, held for the
    // project's parent line, so a pull could have written it.
    expect(await heldIds(harness)).toContain(id(10));
    expect(written(harness)).toEqual(["Projects"]);
    expect(readdirSync(join(harness.dir, "Projects"))).toEqual(["project.md"]);
    for (const pushed of pushes) {
      expect(pushed.beneath?.resolved ?? null).toBeNull();
      expect(pushed.beneath?.waiting).toContain("system.folder");
      expect(pushed.beneath?.waiting).toContain("cannot change the folder");
    }
    const status = value(await harness.folder.status());
    expect(status.beneath_waiting).toBe(PATH);
    expect(status.beneath_waiting_reason).toContain("cannot change the folder");
    expect(status.beneath_waiting_reason).toContain("system.folder");
    expect(status.files.map((file) => [file.path, file.status])).toEqual([
      [PATH, "in_step"],
    ]);

    // A note put beneath the project while the key still cannot name it is
    // sent as beneath the project's item, and the pull holds it the same way.
    mkdirSync(join(harness.dir, "Notes"));
    writeFileSync(
      join(harness.dir, CHILD),
      '---\ntitle: Child\nchild-of: "[[project]]"\n---\nChild\n',
    );
    const beneath = value(await harness.folder.push());
    expect(sent).toHaveLength(3);
    expect(beneath.beneath?.waiting).toContain("cannot change the folder");
    expect(idIn(harness, CHILD)).toBeDefined();
    expect(written(harness).sort()).toEqual(["Notes", "Projects"]);
    expect(readdirSync(join(harness.dir, "Notes"))).toEqual(["child.md"]);
    const held = value(await harness.folder.status());
    expect(held.beneath_waiting).toBe(PATH);
    expect(held.files.map((file) => [file.path, file.status]).sort()).toEqual([
      [CHILD, "in_step"],
      [PATH, "in_step"],
    ]);

    // With a key that can write the folder, the path names the project, and
    // the umbrella above it stays out.
    writable = true;
    const named = value(await harness.folder.push());
    const project = named.beneath?.resolved;
    expect(project).toBe(idIn(harness, PATH));
    expect(folder.settings.query).toEqual({
      types: ["core.note"],
      beneath: project,
    });
    expect(written(harness).sort()).toEqual(["Notes", "Projects"]);
    const after = value(await harness.folder.status());
    expect(after.beneath_waiting).toBeUndefined();
    expect(after.beneath_waiting_reason).toBeUndefined();
  });

  it("sends the files beneath the project in the pass that names its item, and holds the rest outside the query", async () => {
    const project = "---\ntitle: Project\n---\nProject\n";
    const inside =
      '---\ntitle: Inside\nchild-of: "[[Project]]"\n---\nunder the project\n';
    const outside = "---\ntitle: Other\n---\nx\n";
    harness = await folderHarness("beneath-file-hold", {
      settings: {
        query: { types: ["core.note"], beneath: PATH },
        defaults: { type: "core.note" },
        outside_query: "hold",
      },
      items: { "core.note": [note(4, "Outside")] },
    });
    scriptFolderWrites(harness);
    const sent = changes(harness);
    put(harness, PATH, project);
    put(harness, "Projects/inside.md", inside);
    const other = put(harness, "Other/x.md", outside);

    // The witness: a folder that holds nothing outside sends all three files.
    const control = await folderHarness("beneath-file-hold-control", {
      settings: {
        query: { types: ["core.note"] },
        defaults: { type: "core.note" },
      },
    });
    try {
      scriptFolderWrites(control);
      put(control, PATH, project);
      put(control, "Projects/inside.md", inside);
      put(control, "Other/x.md", outside);
      value(await control.folder.push());
      expect(created(control)).toBe(3);
    } finally {
      await control.stop();
    }

    const pushed = value(await harness.folder.push());
    expect(sent).toHaveLength(1);
    expect(sentTitles(harness).sort()).toEqual(["Inside", "Project"]);
    expect(readFileSync(other, "utf8")).toBe(outside);
    expect(pushed.scan.held_outside).toBe(1);
    const status = value(await harness.folder.status());
    expect(status.paused.outside_query).toBe(1);
  });

  it("takes the file the query names for the one the folder holds, as the folder compares paths", async () => {
    // One file name, in two Unicode forms and two cases, one of them a full
    // fold (`\u00df` and `SS`) that no file system opens as one name: the
    // folder compares them as one, on every platform.
    harness = await beneathFile(
      "beneath-file-names",
      "projects/Stra\u00dfe Caf\u00e9.md",
      "Projects/STRASSE Cafe\u0301.md",
    );
    changes(harness);

    value(await harness.folder.push());
    expect(harness.settings.settings.query).toEqual({
      types: ["core.note"],
      beneath: id(1),
    });
    expect(await heldIds(harness)).toEqual([id(1), id(2), id(3)]);
  });

  it("sends the first in byte order of the files the query's path matches, and neither a link nor a folder in its place", async () => {
    // Names the folder compares as one that a case-sensitive volume keeps
    // apart, where both can be there.
    const file = (title: string): string =>
      `---\ntitle: ${title}\n---\n${title}\n`;
    const run = async (
      label: string,
      named: string,
      setup: (folder: FolderHarness) => void,
    ): Promise<string[]> => {
      const made = await folderHarness(label, {
        settings: {
          query: { types: ["core.note"], beneath: named },
          defaults: { type: "core.note" },
          outside_query: "hold",
        },
      });
      try {
        await onCaseSensitiveVolume(made);
        scriptFolderWrites(made);
        changes(made);
        setup(made);
        value(await made.folder.push());
        expect(value(await made.folder.status()).paused.outside_query).toBe(1);
        return sentTitles(made);
      } finally {
        await made.stop();
      }
    };
    const named = "projects/strasse cafe.md";

    // Two files match: the first in byte order is the one the folder keeps.
    expect(
      await run("beneath-file-fold-order", named, (made) => {
        put(made, "Projects/Stra\u00dfe Cafe.md", file("Sharp"));
        put(made, "Projects/STRASSE Cafe.md", file("Capitals"));
        put(made, "Other.md", file("Other"));
      }),
    ).toEqual(["Capitals"]);

    // A link that sorts first does not hide the file.
    expect(
      await run("beneath-file-fold-link", named, (made) => {
        put(made, "Projects/Stra\u00dfe Cafe.md", file("Sharp"));
        put(made, "Other.md", file("Other"));
        symlinkSync(
          join(made.dir, "Other.md"),
          join(made.dir, "Projects/STRASSE Cafe.md"),
        );
      }),
    ).toEqual(["Sharp"]);

    // A folder that sorts first, and holds no such file, does not hide it.
    expect(
      await run(
        "beneath-file-fold-folder",
        "PROJECTS/strasse cafe.md",
        (made) => {
          put(made, "Projects/inside.md", file("Inside"));
          put(made, "projects/Stra\u00dfe Cafe.md", file("Sharp"));
        },
      ),
    ).toEqual(["Sharp"]);
  });

  it("judges the path a person has put in the settings file, so a bad path can be mended there", async () => {
    harness = await folderHarness("beneath-file-mended", {
      settings: {
        query: { types: ["core.note"], beneath: "Projects/gone.md" },
      },
      items: { "core.note": [note(1, "Project"), note(2, "Inside one")] },
      edges: { "parent-of": [parentOf(1, 1, 2)] },
      files: {
        [PATH]: `---\nmarfa_id: ${id(1)}\ntitle: Project\n---\nProject\n`,
      },
    });
    scriptFolderWrites(harness);
    const sent = changes(harness);

    // The witness: the path as it stands is refused, naming it.
    const refused = await harness.folder.push();
    expect(refused.ok, JSON.stringify(refused)).toBe(false);
    if (!refused.ok) expect(refused.refusal.raw).toContain("Projects/gone.md");
    expect(sent).toEqual([]);

    const file = settingsFile(harness);
    mkdirSync(dirname(file), { recursive: true });
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const held = harness;
    const edit = (beneath: string): string =>
      text.includes("Projects/gone.md")
        ? text.replace("Projects/gone.md", beneath)
        : `folder: ${held.settings.id}\nversion: ${held.settings.version}\nquery:\n  types:\n    - core.note\n  beneath: ${beneath}\n`;

    // An edit naming a file that is not there is sent nowhere, and the
    // folder's own path stays what the server holds.
    writeFileSync(file, edit("Projects/typo.md"));
    const typo = await harness.folder.push();
    expect(typo.ok, JSON.stringify(typo)).toBe(false);
    expect(sent).toEqual([]);
    expect(harness.settings.settings.query).toEqual({
      types: ["core.note"],
      beneath: "Projects/gone.md",
    });

    writeFileSync(file, edit(PATH));
    value(await harness.folder.push());
    expect(sent.map((body) => body.query)).toEqual([
      { types: ["core.note"], beneath: PATH },
      { types: ["core.note"], beneath: id(1) },
    ]);
    expect(await heldIds(harness)).toEqual([id(1), id(2)]);
  });

  it("refuses a first sync that names a file the folder does not have, writing and sending nothing", async () => {
    harness = await folderHarness("beneath-file-missing", {
      settings: { query: { types: ["core.note"], beneath: PATH } },
      items: { "core.note": [note(1, "Project"), note(2, "Inside")] },
      edges: { "parent-of": [parentOf(1, 1, 2)] },
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
