import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { afterEach, expect, it } from "vitest";
import {
  folderHarness,
  folderItem,
  scriptWrites,
  type FolderHarness,
} from "./harness.js";

import { join } from "node:path";
import {
  SCRIPTED_INSTANCE,
  copyItemEvent,
  copyLiveReplay,
  copyReplay,
  edgeEvent,
  refusal,
  wireEdge,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import type { DoorItem } from "../../device/folder-door.js";
import {
  lastReport,
  scriptFolderWrites,
  settingsFile,
  withFault,
} from "./folders.shared.js";

interface Report {
  folder_store_id: string;
  sequence: number;
  last_success_at: string | null;
  pending_uploads: number;
  pending_downloads: number;
  paused_removals: number;
  first_sync_waiting: boolean;
  problems: Array<{ code: string; count: number }>;
}

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;
afterEach(async () => {
  await second?.stop();
  second = undefined;
  await harness?.stop();
  harness = undefined;
});

function reports(folder: FolderHarness): Report[] {
  return folder.server.requests
    .filter(
      (request) =>
        request.method === "PUT" &&
        request.pathname === `/folders/${folder.settings.id}/status`,
    )
    .map((request) => JSON.parse(request.body) as Report);
}

function latest(folder: FolderHarness): Report {
  const report = reports(folder).at(-1);
  if (report === undefined) throw new Error("the folder sent no report");
  return report;
}

async function statusOf(folder: FolderHarness) {
  const status = await folder.folder.status();
  if (!status.ok) throw new Error(JSON.stringify(status));
  return status.value;
}

function flagOf(status: Awaited<ReturnType<typeof statusOf>>, path: string) {
  const file = status.files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`status does not list ${path}`);
  return [file.status, file.flag];
}

it("counts the files its status shows waiting as pending uploads", async () => {
  harness = await folderHarness("health-pending-uploads", {
    confirm: false,
    hydrate: false,
    files: {
      "first.md": "first\n",
      "second.md": "second\n",
      "photo.bin": "bytes this folder's query takes no type for",
    },
  });
  expect((await harness.folder.pushWaiting()).ok).toBe(true);
  const status = await statusOf(harness);
  expect(flagOf(status, "first.md")[0]).toBe("waiting");
  expect(flagOf(status, "second.md")[0]).toBe("waiting");
  expect(flagOf(status, "photo.bin")).toEqual(["outside", "query"]);
  expect(latest(harness).pending_uploads).toBe(2);
  expect(latest(harness).problems).toEqual([]);
});

it("counts the removals a large removal holds on disk or from a pull as paused removals and no problem", async () => {
  const tight = {
    query: { types: ["core.note"] },
    defaults: { type: "core.note" },
    removal_threshold: { files: 2, fraction: 0.25 },
  };
  harness = await folderHarness("health-paused-disk", { settings: tight });
  scriptFolderWrites(harness);
  for (let n = 0; n < 6; n += 1)
    writeFileSync(join(harness.dir, `note-${n}.md`), `note ${n}\n`);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(latest(harness).paused_removals).toBe(0);
  for (let n = 0; n < 3; n += 1) rmSync(join(harness.dir, `note-${n}.md`));
  expect((await harness.folder.push()).ok).toBe(true);
  const disk = await statusOf(harness);
  expect(disk.paused).toMatchObject({ disk: 3, pull: 0 });
  expect(flagOf(disk, "note-0.md")[1]).toBe("removal");
  expect(latest(harness)).toMatchObject({ paused_removals: 3, problems: [] });

  const rows = Array.from({ length: 6 }, (_, n) => ({
    item: {
      id: `01a00000-0000-7000-8000-00000000010${n}`,
      properties: { title: `Note ${n}`, body: "body\n" },
    },
  }));
  second = await folderHarness("health-paused-pull", {
    items: { "core.note": rows },
    settings: { ...tight, query: { types: ["core.note"], state: ["active"] } },
    events: [
      copyReplay(
        "4",
        rows
          .slice(0, 3)
          .map((row, n) =>
            copyItemEvent(
              String(n + 2),
              "item.deleted",
              wireItem({ ...row.item, state: "trashed" }),
            ),
          ),
      ),
    ],
  });
  scriptFolderWrites(second);
  expect((await second.folder.pull()).ok).toBe(true);
  expect((await second.folder.device().catchUp()).ok).toBe(true);
  expect((await second.folder.push()).ok).toBe(true);
  const pull = await statusOf(second);
  expect(pull.paused).toMatchObject({ disk: 0, pull: 3 });
  expect(flagOf(pull, "Note 0.md")[1]).toBe("removal");
  expect(latest(second)).toMatchObject({ paused_removals: 3, problems: [] });
});

it("counts a file the server refused under refused", async () => {
  harness = await folderHarness("health-refused-file", {
    items: {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000101",
            properties: { title: "Rejected", body: "body\n" },
          },
        },
      ],
    },
  });
  scriptFolderWrites(harness, {
    door: (door) => {
      door.update = () =>
        refusal(400, "validation_error", "that is not allowed");
    },
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  const rejected = join(harness.dir, "Rejected.md");
  writeFileSync(rejected, `${readFileSync(rejected, "utf8")}an edit\n`);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(flagOf(await statusOf(harness), "Rejected.md")[1]).toBe("refused");
  expect(lastReport(harness).problems).toEqual([{ code: "refused", count: 1 }]);
});

it("counts a file flagged encoding or unreadable under unreadable", async () => {
  harness = await folderHarness("health-unreadable-files");
  scriptFolderWrites(harness);
  writeFileSync(join(harness.dir, "NotText.md"), Buffer.from([255]));
  writeFileSync(
    join(harness.dir, "NoTime.md"),
    "---\noccurred_at: not a time\n---\nbody\n",
  );
  expect((await harness.folder.push()).ok).toBe(true);
  const status = await statusOf(harness);
  expect(flagOf(status, "NotText.md")[1]).toBe("encoding");
  expect(flagOf(status, "NoTime.md")[1]).toBe("unreadable");
  expect(lastReport(harness).problems).toEqual([
    { code: "unreadable", count: 2 },
  ]);
});

it("counts an empty file as a held file, and a file the query leaves alone as no problem", async () => {
  harness = await folderHarness("health-held-empty");
  scriptFolderWrites(harness);
  writeFileSync(join(harness.dir, "Blank.bin"), "");
  writeFileSync(join(harness.dir, "Other.bin"), "not a type the query takes");
  expect((await harness.folder.push()).ok).toBe(true);
  const status = await statusOf(harness);
  expect(flagOf(status, "Blank.bin")[1]).toBe("empty");
  expect(flagOf(status, "Other.bin")[1]).toBe("query");
  // The witness: the empty file is counted, so the file beside it was
  // passed over, not missed.
  expect(lastReport(harness).problems).toEqual([
    { code: "held_file", count: 1 },
  ]);
});

it("counts no problem for a file whose item is already in the bin", async () => {
  const id = "01a00000-0000-7000-8000-000000000201";
  const row = { item: { id, properties: { title: "Binned", body: "body\n" } } };
  harness = await folderHarness("health-gone-file", {
    items: { "core.note": [row] },
    events: [
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.deleted",
          wireItem({ ...row.item, state: "trashed" }),
        ),
      ]),
    ],
  });
  scriptFolderWrites(harness);
  expect((await harness.folder.pull()).ok).toBe(true);
  rmSync(join(harness.dir, "Binned.md"));
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  expect(flagOf(await statusOf(harness), "Binned.md")).toEqual([
    "waiting",
    "gone",
  ]);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(latest(harness)).toMatchObject({ pending_uploads: 1, problems: [] });
});

it("counts a file in an unreadable directory only through the directory", async () => {
  harness = await folderHarness("health-directories");
  scriptFolderWrites(harness);
  mkdirSync(join(harness.dir, "locked"));
  writeFileSync(join(harness.dir, "locked", "Bound.md"), "bound\n");
  expect((await harness.folder.push()).ok).toBe(true);
  expect(latest(harness).problems).toEqual([]);

  chmodSync(join(harness.dir, "locked"), 0);
  try {
    // The witness: both the file and its directory are flagged `unreadable`,
    // so either could have been counted.
    const status = await statusOf(harness);
    expect(flagOf(status, "locked/Bound.md")[1]).toBe("unreadable");
    expect(status.directories).toMatchObject([
      { path: "locked", flag: "unreadable" },
    ]);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      lastReport(harness).problems.find(
        (problem) => problem.code === "unreadable",
      ),
    ).toEqual({ code: "unreadable", count: 1 });
  } finally {
    chmodSync(join(harness.dir, "locked"), 0o700);
  }
});

it("counts what the last pull could not write as pending downloads and held files, until a later pull writes it", async () => {
  const rows = ["Blocked", "Witness"].map((title, n) => ({
    item: {
      id: `01a00000-0000-7000-8000-00000000030${n}`,
      properties: { title, body: "body\n" },
    },
  }));
  harness = await folderHarness("health-pending-downloads", {
    items: { "core.note": rows },
  });
  scriptFolderWrites(harness);
  const pushed = await withFault("rename-new-unsupported=Blocked.md", () =>
    harness!.folder.push(),
  );
  expect(pushed.ok && pushed.value.pull?.flagged).toMatchObject([
    { path: "Blocked.md", flag: "unwritten" },
  ]);
  expect(latest(harness)).toMatchObject({
    pending_downloads: 1,
    problems: [{ code: "held_file", count: 1 }],
  });

  const first = latest(harness).sequence;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await harness.folder.pushSendOnly()).ok).toBe(true);
  expect(latest(harness).sequence).toBeGreaterThan(first);
  expect(latest(harness)).toMatchObject({
    pending_downloads: 1,
    problems: [{ code: "held_file", count: 1 }],
  });

  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await harness.folder.push()).ok).toBe(true);
  expect(latest(harness)).toMatchObject({
    pending_downloads: 0,
    problems: [],
  });
});

/** Items for the conflict cases, which arrive as a copy's events: a pair of
 *  notes joined by a `derived-from` edge from the copy to the original. */
function conflictPairs() {
  const id = (n: number) =>
    `01a00000-0000-7000-8000-${String(400 + n).padStart(12, "0")}`;
  let sequence = 1;
  const next = () => String((sequence += 1));
  const pair = (
    [copy, copyTitle, copyState]: [number, string, string],
    [original, originalTitle, originalState]: [number, string, string],
    tagged = true,
  ) => {
    const note = (n: number, title: string, state: string) =>
      wireItem({ id: id(n), state, properties: { title, body: "body\n" } });
    return [
      copyItemEvent(
        next(),
        "item.created",
        note(original, originalTitle, originalState),
      ),
      copyItemEvent(
        next(),
        "item.created",
        note(copy, copyTitle, copyState),
        tagged ? { tags: ["conflicted-copy"] } : undefined,
      ),
      edgeEvent(
        next(),
        "edge.created",
        wireEdge({
          id: `01a00000-0000-7000-8000-${String(500 + copy).padStart(12, "0")}`,
          source_id: id(copy),
          target_id: id(original),
          edge_type: "derived-from",
        }),
      ),
    ];
  };
  return { id, pair, head: () => String(sequence) };
}

const activeNotes: FolderSettings = {
  query: { types: ["core.note"], state: ["active"] },
};

it("counts a tagged copy derived from a bound file as a conflict, whichever end holds the file, and neither one in the bin nor one without the tag", async () => {
  const { id, pair, head } = conflictPairs();
  const frames = [
    // Both ends have a file.
    ...pair([1, "Both copy", "active"], [2, "Both original", "active"]),
    // Only the copy has a file: its original is archived, outside the query.
    ...pair([3, "Source copy", "active"], [4, "Source original", "archived"]),
    // Only the original has a file: the copy's file cannot be written.
    ...pair([5, "Target copy", "active"], [6, "Target original", "active"]),
    // Both ends have a file, but the copy is in the bin.
    ...pair([7, "Binned copy", "trashed"], [8, "Binned original", "active"]),
    // Both ends have a file, but the copy has no tag.
    ...pair(
      [9, "Untagged copy", "active"],
      [10, "Untagged original", "active"],
      false,
    ),
  ];
  harness = await folderHarness("health-conflict", {
    settings: activeNotes,
    events: [copyReplay(head(), frames)],
  });
  scriptFolderWrites(harness);
  expect((await harness.folder.pull()).ok).toBe(true);
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  const pushed = await withFault("rename-new-unsupported=Target copy.md", () =>
    harness!.folder.push(),
  );
  expect(pushed.ok).toBe(true);
  const paths = (await statusOf(harness)).files.map((file) => file.path);
  expect(paths).toEqual(
    expect.arrayContaining([
      "Both copy.md",
      "Both original.md",
      "Source copy.md",
      "Target original.md",
    ]),
  );
  expect(paths).not.toContain("Source original.md");
  expect(paths).not.toContain("Target copy.md");
  expect((await harness.folder.device().get(id(5))).ok).toBe(true);
  // The copy of the item whose file cannot be written is held, not counted
  // as a conflict twice.
  expect(lastReport(harness).problems).toEqual([
    { code: "conflict", count: 3 },
    { code: "held_file", count: 1 },
  ]);
});

it("counts no conflict for a tagged copy derived from an item when neither has a file", async () => {
  const { id, pair, head } = conflictPairs();
  const frames = pair(
    [1, "Lone copy", "active"],
    [2, "Lone original", "archived"],
  );
  harness = await folderHarness("health-conflict-neither", {
    settings: activeNotes,
    items: {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000499",
            properties: { title: "Plain", body: "body\n" },
          },
        },
      ],
    },
    events: [copyReplay(head(), frames)],
  });
  scriptFolderWrites(harness);
  expect((await harness.folder.pull()).ok).toBe(true);
  const caught = await harness.folder.device().catchUp();
  expect(caught.ok, JSON.stringify(caught)).toBe(true);
  const pushed = await withFault("rename-new-unsupported=Lone copy.md", () =>
    harness!.folder.push(),
  );
  expect(pushed.ok).toBe(true);
  // The witness: the copy holds the tagged item, which has no file, and the
  // folder holds a file beside it.
  expect((await harness.folder.device().get(id(1))).ok).toBe(true);
  const paths = (await statusOf(harness)).files.map((file) => file.path);
  expect(paths).toContain("Plain.md");
  expect(paths).not.toContain("Lone copy.md");
  // The file that could not be written is held, and no conflict is counted.
  expect(lastReport(harness).problems).toEqual([
    { code: "held_file", count: 1 },
  ]);
});

it("counts one credential_refused however many files a refused key holds back", async () => {
  harness = await folderHarness("health-credential");
  scriptFolderWrites(harness, {
    creating: () => refusal(401, "unauthorized", "this key was revoked"),
  });
  writeFileSync(join(harness.dir, "One.md"), "one\n");
  writeFileSync(join(harness.dir, "Two.md"), "two\n");
  await harness.folder.push();
  const status = await statusOf(harness);
  expect(flagOf(status, "One.md")[1]).toBe("credential_refused");
  expect(latest(harness).pending_uploads).toBe(2);
  expect(latest(harness).problems).toEqual([
    { code: "credential_refused", count: 1 },
  ]);
});

it("reports unavailable, and not credential_refused, for a read the server answers 403", async () => {
  let forbidden = false;
  harness = await folderHarness("health-forbidden-read", {
    events: [
      () =>
        forbidden
          ? refusal(403, "forbidden", "this grant may not read that")
          : copyReplay("1", []),
    ],
  });
  scriptFolderWrites(harness);
  expect((await harness.folder.push()).ok).toBe(true);
  const before = latest(harness).sequence;
  forbidden = true;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const pushed = await harness.folder.push();
  expect(pushed.ok).toBe(false);
  // The witness: the pass reported, so the report was not merely missing.
  expect(latest(harness).sequence).toBeGreaterThan(before);
  expect(lastReport(harness).problems).toEqual([
    { code: "unavailable", count: 1 },
  ]);
});

it.each([
  [429, "rate_limited"],
  [500, "internal_error"],
  [503, "unavailable"],
] as const)(
  "reports unavailable while the server answers a read %s",
  async (status, code) => {
    let failing = false;
    harness = await folderHarness(`health-answers-${String(status)}`, {
      events: [
        () =>
          failing ? refusal(status, code, "try again") : copyReplay("1", []),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(latest(harness).problems).toEqual([]);
    failing = true;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await harness.folder.push();
    expect(latest(harness).problems).toEqual([
      { code: "unavailable", count: 1 },
    ]);
  },
);

it("counts one settings_invalid while the settings file is refused", async () => {
  harness = await folderHarness("health-settings");
  scriptFolderWrites(harness);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(latest(harness).problems).toEqual([]);
  const file = settingsFile(harness);
  writeFileSync(file, `${readFileSync(file, "utf8")}include: [not closed\n`);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(latest(harness).problems).toEqual([
    { code: "settings_invalid", count: 1 },
  ]);
});

it("counts one settings_invalid while a pull cannot write the settings file, and none once it can", async () => {
  let changed: Record<string, unknown> = {};
  harness = await folderHarness("health-settings-unwritable", {
    items: {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-00000000fa90",
            properties: { title: "Independent", body: "work continues\n" },
          },
        },
      ],
    },
    events: [
      () => copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
      copyLiveReplay("2", []),
    ],
  });
  scriptFolderWrites(harness);
  harness.settings.settings = {
    ...harness.settings.settings,
    defaults: { tags: ["from elsewhere"] },
  };
  harness.settings.version = 2;
  changed = folderItem(harness.settings);
  const caught = await harness.folder.device().catchUp();
  expect(caught.ok && caught.value.applied).toBe(1);
  // A path no file can be written over, as a full disk refuses one. The
  // settings are in force, so the pass can read what it holds.
  const file = settingsFile(harness);
  rmSync(file);
  mkdirSync(file);
  const pulled = await harness.folder.push();
  expect(pulled.ok && pulled.value.pull?.settings.unwritten).toContain(
    "folder.yaml",
  );
  expect(latest(harness).problems).toEqual([
    { code: "settings_invalid", count: 1 },
  ]);

  // The witness: the same folder, once the path is free, writes the settings
  // and reports none.
  rmSync(file, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await harness.folder.push()).ok).toBe(true);
  expect(existsSync(file)).toBe(true);
  expect(latest(harness).problems).toEqual([]);
});

it("counts one root_gone when another directory has taken the folder's place", async () => {
  harness = await folderHarness("health-root-gone");
  scriptFolderWrites(harness);
  expect((await harness.folder.push()).ok).toBe(true);
  const folder = harness;
  const away = `${folder.dir}.original`;
  cpSync(folder.dir, `${folder.dir}.replacement`, { recursive: true });
  try {
    const pushed = await withFault("replace-root-before-settings-read", () =>
      folder.folder.push(),
    );
    expect(pushed.ok && pushed.value.scan.root_gone).toContain(
      "no longer the directory",
    );
    expect(latest(folder).problems).toEqual([{ code: "root_gone", count: 1 }]);
  } finally {
    rmSync(folder.dir, { recursive: true, force: true });
    if (existsSync(away)) renameSync(away, folder.dir);
    rmSync(`${folder.dir}.replacement`, { recursive: true, force: true });
  }
});

it("counts one root_gone when another directory has taken the folder's place as a pull writes", async () => {
  harness = await folderHarness("health-root-gone-pull", {
    items: {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000601",
            properties: { title: "Landing", body: "body\n" },
          },
        },
      ],
    },
  });
  scriptFolderWrites(harness);
  const folder = harness;
  const away = `${folder.dir}.original`;
  cpSync(folder.dir, `${folder.dir}.replacement`, { recursive: true });
  try {
    const pushed = await withFault("replace-root-before-publication", () =>
      folder.folder.push(),
    );
    // The directory is replaced as the pull writes, not as the scan reads.
    expect(pushed.ok && pushed.value.scan.root_gone).toBeFalsy();
    expect(pushed.ok && pushed.value.pull?.root_gone).toContain(
      "no longer the directory",
    );
    expect(lastReport(folder).problems).toEqual([
      { code: "root_gone", count: 1 },
    ]);
  } finally {
    rmSync(folder.dir, { recursive: true, force: true });
    if (existsSync(away)) renameSync(away, folder.dir);
    rmSync(`${folder.dir}.replacement`, { recursive: true, force: true });
  }
});

it("reports a confirmed complete sync using the registry's opaque copy identity", async () => {
  harness = await folderHarness("health-complete");
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  const [report] = reports(harness);
  expect(report.last_success_at).toMatch(/^\d{4}-.*\.\d{3}Z$/);
  expect(report.pending_uploads).toBe(0);
  expect(report.pending_downloads).toBe(0);
  expect(report.problems).toEqual([]);
  const registry = JSON.parse(readFileSync(harness.registry, "utf8")) as {
    folders: Array<{ store: string }>;
  };
  expect(report.folder_store_id).toBe(registry.folders[0].store);
  expect(Object.keys(report).sort()).toEqual(
    [
      "folder_store_id",
      "sequence",
      "last_success_at",
      "pending_uploads",
      "pending_downloads",
      "paused_removals",
      "first_sync_waiting",
      "problems",
    ].sort(),
  );
});

it("names the copy's instance on each status report", async () => {
  harness = await folderHarness("health-names-instance");
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  const { settings } = harness;
  const sent = harness.server.requests.filter(
    (request) =>
      request.method === "PUT" &&
      request.pathname === `/folders/${settings.id}/status`,
  );
  // The positive control: a push reports at least once.
  expect(sent.length).toBeGreaterThan(0);
  for (const request of sent)
    expect(request.headers["x-marfa-instance-id"]).toBe(SCRIPTED_INSTANCE);
});

it("sends no status report after another instance refuses a write, and sends it once the copy is built again", async () => {
  harness = await folderHarness("health-instance-changed");
  let elsewhere = true;
  scriptFolderWrites(harness, {
    creating: (answer) =>
      elsewhere
        ? refusal(409, "instance_changed", "another instance at this address")
        : answer,
  });
  const before = reports(harness).length;
  writeFileSync(join(harness.dir, "elsewhere.md"), "# Elsewhere\n");
  const pushed = await harness.folder.push();
  expect(pushed.ok, "the push went on past another instance").toBe(false);
  if (!pushed.ok) expect(pushed.refusal.raw).toContain("instance_changed");
  expect(
    reports(harness).length,
    "a status report was sent after another instance refused a write",
  ).toBe(before);

  // The witness: built again from the instance now there, the report held
  // back goes out.
  elsewhere = false;
  expect((await harness.folder.hydrate()).ok).toBe(true);
  await harness.folder.push();
  expect(reports(harness).length).toBeGreaterThan(before);
});

it("reports first-sync waiting without claiming a successful content pass", async () => {
  harness = await folderHarness("health-first", {
    confirm: false,
    hydrate: false,
    files: { "note.md": "a local note\n" },
  });
  expect((await harness.folder.pushWaiting()).ok).toBe(true);
  const [report] = reports(harness);
  expect(report.first_sync_waiting).toBe(true);
  expect(report.last_success_at).toBeNull();
});

it("counts no settings_invalid for a refused settings file while the first sync waits", async () => {
  harness = await folderHarness("health-first-settings", {
    confirm: false,
    hydrate: false,
    files: { "note.md": "a local note\n" },
  });
  const file = settingsFile(harness);
  writeFileSync(file, `${readFileSync(file, "utf8")}include: [not closed\n`);
  expect((await harness.folder.pushWaiting()).ok).toBe(true);
  const report = latest(harness);
  expect(report.first_sync_waiting).toBe(true);
  expect(report.problems).toEqual([]);
});

it("preserves successful content sync when reporting fails and coalesces across CLI restarts", async () => {
  harness = await folderHarness("health-failure", {
    statusReport: [
      {
        kind: "json",
        status: 503,
        body: {
          error: { code: "unavailable", message: "reporting is unavailable" },
        },
      },
      (request) => ({
        kind: "json",
        status: 200,
        body: {
          accepted: true,
          sequence: (JSON.parse(request.body) as Report).sequence,
          received_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    ],
  });
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await harness.folder.push()).ok).toBe(true);
  const delivered = reports(harness);
  expect(delivered).toHaveLength(2);
  expect(delivered[1].sequence).toBeGreaterThan(delivered[0].sequence);
  expect(delivered[1].problems).toEqual([]);
  expect(delivered[1].last_success_at).not.toBeNull();
});

it("does not report a send-only run as a full success, where a push that pulls does", async () => {
  harness = await folderHarness("health-send-only");
  scriptWrites(harness.server);
  expect((await harness.folder.pushSendOnly()).ok).toBe(true);
  const [sent] = reports(harness);
  expect(
    sent.last_success_at,
    "a run that caught up with nothing and pulled nothing was reported as a complete sync",
  ).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await harness.folder.push()).ok).toBe(true);
  expect(
    reports(harness).at(-1)?.last_success_at,
    "the witness: the same folder, pushed in full, reports a full success",
  ).not.toBeNull();
});

it("distinguishes two directories following the same folder and sign-in", async () => {
  harness = await folderHarness("health-copy-one");
  second = await folderHarness("health-copy-two", {
    sharing: { server: harness.server, key: "device-fixture-key" },
    folder: harness.settings,
    registry: harness.registry,
  });
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  expect((await second.folder.push()).ok).toBe(true);
  const delivered = reports(harness);
  expect(new Set(delivered.map((report) => report.folder_store_id)).size).toBe(
    2,
  );
  expect(delivered.map((report) => report.sequence)).toEqual([1, 1]);
});

it("does not advance last full success after an offline push with an empty queue", async () => {
  harness = await folderHarness("health-offline");
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  const successful = reports(harness)[0];
  await harness.server.offline();
  const offline = await harness.folder.push();
  expect(offline.ok).toBe(true);
  if (offline.ok) expect(offline.value.catch_up).toHaveProperty("failed");
  await harness.server.online();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  // A retry from a restarted watch sends the durable offline report before
  // its first pass can produce a newer observation.
  const watched = harness.folder.watch();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await watched.stop();
  }
  const failed = reports(harness).find((report) =>
    report.problems.some((problem) => problem.code === "unavailable"),
  );
  expect(failed?.problems).toEqual([{ code: "unavailable", count: 1 }]);
  expect(failed?.last_success_at).toBe(successful.last_success_at);
});

it("refreshes the newest local observation above a restored backup sequence", async () => {
  harness = await folderHarness("health-restored", {
    statusReport: [
      {
        kind: "json",
        status: 200,
        body: {
          accepted: false,
          sequence: 40,
          received_at: "2026-01-01T00:00:00.000Z",
        },
      },
      (request) => ({
        kind: "json",
        status: 200,
        body: {
          accepted: true,
          sequence: (JSON.parse(request.body) as Report).sequence,
          received_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    ],
  });
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  writeFileSync(`${harness.dir}/private.md`, Buffer.from([255]));
  expect((await harness.folder.push()).ok).toBe(true);
  const delivered = reports(harness);
  expect(delivered[1].sequence).toBeGreaterThan(40);
  expect(delivered[1].problems).toContainEqual({
    code: "unreadable",
    count: 1,
  });
  expect(JSON.stringify(delivered[1])).not.toContain("private.md");
});

it("keeps dead file effects current until an accepted replacement, survives clear and restart, and restores them on release", async () => {
  const id = "01a00000-0000-7000-8000-00000000000a";
  harness = await folderHarness("health-dead-effects", {
    items: {
      "core.note": [
        {
          item: {
            id,
            version: 3,
            properties: { title: "Held", body: "baseline\n" },
          },
        },
      ],
    },
  });
  let broken = false;
  scriptFolderWrites(harness, {
    door: (door) => {
      const update = door.update.bind(door);
      door.update = (...args) =>
        broken
          ? { kind: "json", status: 200, body: "unreadable answer" }
          : update(...args);
    },
  });
  expect((await harness.folder.push()).ok).toBe(true);
  const path = `${harness.dir}/Held.md`;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("baseline", "dead bytes"),
  );
  expect((await harness.folder.scan()).ok).toBe(true);
  broken = true;
  const device = harness.folder.device();
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await device.drain()).ok).toBe(true);
  const queue = await device.queue();
  expect(queue.ok).toBe(true);
  if (!queue.ok) return;
  const dead = queue.value.find((row) => row.verdict === "dead");
  expect(dead).toBeDefined();
  if (dead === undefined) return;
  expect((await harness.folder.push()).ok).toBe(true);
  expect(reports(harness).at(-1)?.pending_uploads).toBe(1);
  expect(reports(harness).at(-1)?.problems).toContainEqual({
    code: "held_file",
    count: 1,
  });
  const heldSuccess = reports(harness).at(-1)?.last_success_at;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("dead bytes", "accepted bytes"),
  );
  broken = false;
  expect((await harness.folder.push()).ok).toBe(true);
  expect(reports(harness).at(-1)?.pending_uploads).toBe(0);
  expect(reports(harness).at(-1)?.problems).toEqual([]);
  expect(reports(harness).at(-1)?.last_success_at).not.toBe(heldSuccess);
  expect((await device.forget()).ok).toBe(true);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("accepted bytes");
  expect(reports(harness).at(-1)?.pending_uploads).toBe(0);
  expect((await device.release({ id: dead.id })).ok).toBe(true);
  const projected = await device.get(id);
  expect(projected.ok && projected.value.properties.body).toBe("dead bytes\n");
  broken = true;
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await device.drain()).ok).toBe(true);
  expect((await harness.folder.push()).ok).toBe(true);
  expect(reports(harness).at(-1)?.pending_uploads).toBe(1);
  expect(reports(harness).at(-1)?.problems).toContainEqual({
    code: "held_file",
    count: 1,
  });
  const releasedQueue = await device.queue();
  expect(releasedQueue.ok).toBe(true);
  if (releasedQueue.ok) {
    const released = releasedQueue.value.find((row) => row.id === dead.id);
    expect(released?.body).toEqual(dead.body);
    expect(released?.idempotency_key).toBe(dead.idempotency_key);
  }
});

it("reports an unreadable unbound directory as incomplete inventory and clears it after readable recovery", async () => {
  harness = await folderHarness("health-partial-inventory");
  scriptWrites(harness.server);
  expect((await harness.folder.push()).ok).toBe(true);
  const success = reports(harness).at(-1)?.last_success_at;
  const child = `${harness.dir}/unreadable`;
  mkdirSync(child);
  writeFileSync(`${child}/Unbound.md`, "unbound bytes\n");
  const witness = await harness.folder.status();
  expect(
    witness.ok &&
      witness.value.files.some((file) => file.path === "unreadable/Unbound.md"),
  ).toBe(true);
  chmodSync(child, 0);
  try {
    const partial = await harness.folder.status();
    expect(
      partial.ok &&
        partial.value.directories.some((entry) => entry.flag === "unreadable"),
    ).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(reports(harness).at(-1)?.problems).toContainEqual({
      code: "unreadable",
      count: 1,
    });
    expect(reports(harness).at(-1)?.last_success_at).toBe(success);
  } finally {
    chmodSync(child, 0o700);
  }
  rmSync(child, { recursive: true });
  expect((await harness.folder.push()).ok).toBe(true);
  expect(reports(harness).at(-1)?.problems).toEqual([]);
  expect(reports(harness).at(-1)?.last_success_at).not.toBe(success);
});

it("preserves a nonzero known upload count while an unreadable inventory hides unbound files", async () => {
  harness = await folderHarness("health-retained-inventory", {
    confirm: false,
    hydrate: false,
    files: { "unreadable/Unbound.md": "unbound bytes\n" },
  });
  expect((await harness.folder.pushWaiting()).ok).toBe(true);
  const before = reports(harness).at(-1);
  expect(before?.pending_uploads).toBe(1);
  const child = `${harness.dir}/unreadable`;
  writeFileSync(`${child}/Unseen.md`, "unbound unseen bytes\n");
  chmodSync(child, 0);
  try {
    const partial = await harness.folder.status();
    expect(
      partial.ok &&
        partial.value.files.every((file) => file.status !== "waiting"),
    ).toBe(true);
    expect(
      partial.ok &&
        partial.value.files.some(
          (file) => file.path === "unreadable/Unseen.md",
        ),
    ).toBe(false);
    expect((await harness.folder.pushWaiting()).ok).toBe(true);
    const after = reports(harness).at(-1);
    expect(after?.pending_uploads).toBe(1);
    expect(after?.problems).toContainEqual({ code: "unreadable", count: 1 });
    expect(after?.last_success_at).toBeNull();
  } finally {
    chmodSync(child, 0o700);
  }
  rmSync(`${child}/Unseen.md`);
  expect((await harness.folder.pushWaiting()).ok).toBe(true);
  expect(reports(harness).at(-1)?.pending_uploads).toBe(1);
  expect(reports(harness).at(-1)?.problems).toEqual([]);
});

it.each(["replacement", "tag addition"] as const)(
  "preserves accepted %s membership when projecting dead metadata intent",
  async (operation) => {
    const id = "01a00000-0000-7000-8000-00000000000a";
    harness = await folderHarness(`health-dead-metadata-${operation}`, {
      items: {
        "core.note": [
          {
            item: {
              id,
              version: 3,
              properties: { title: "Held", body: "baseline\n" },
            },
          },
        ],
      },
    });
    let broken = false;
    let rows: Map<string, DoorItem>;
    scriptFolderWrites(harness, {
      door: (door) => {
        rows = door.rows;
      },
      tagging: (request) => {
        if (broken)
          return {
            kind: "json",
            status: 409,
            body: {
              error: {
                code: "idempotency_key_in_flight",
                message: "this request is still in flight",
              },
            },
          };
        if (request.pathname.endsWith("/metadata")) {
          const row = rows.get(id)!;
          const tags = (JSON.parse(request.body) as { tags: string[] }).tags;
          row.tags =
            request.method === "PUT"
              ? tags
              : [...new Set([...(row.tags ?? []), ...tags])];
          return writeAnswers.metadata(id, row.tags);
        }
        return undefined;
      },
    });
    expect((await harness.folder.push()).ok).toBe(true);
    const device = harness.folder.device();
    const queued =
      operation === "replacement"
        ? await device.addTag(id, "stale")
        : await device.replaceMetadata(id, ["old"]);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    broken = true;
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await device.drain()).ok).toBe(true);
    const dead = await device.queue();
    expect(
      dead.ok &&
        dead.value.some(
          (write) => write.id === queued.value.id && write.verdict === "dead",
        ),
    ).toBe(true);
    broken = false;
    const newer =
      operation === "replacement"
        ? await device.replaceMetadata(id, [])
        : await device.addTag(id, "new");
    expect(newer.ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    const observed = await device.get(id);
    expect(observed.ok && observed.value.tags).toEqual(
      operation === "replacement" ? [] : ["new", "old"],
    );
    expect(reports(harness).at(-1)?.pending_uploads).toBe(
      operation === "replacement" ? 0 : 1,
    );
    expect((await device.forget()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    const restarted = await device.get(id);
    expect(restarted.ok && restarted.value.tags).toEqual(
      operation === "replacement" ? [] : ["new", "old"],
    );
    const kept = await device.queue();
    expect(
      kept.ok &&
        kept.value.some(
          (write) => write.id === queued.value.id && write.verdict === "dead",
        ),
    ).toBe(true);
    expect((await device.release({ id: queued.value.id })).ok).toBe(true);
    const restored = await device.get(id);
    expect(restored.ok && restored.value.tags).toEqual(
      operation === "replacement" ? ["stale"] : ["old"],
    );
  },
);
