import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  answers,
  copyItemEvent,
  copyLiveReplay,
  copyReplay,
  wireItem,
} from "../../device/marfa-answers.js";
import {
  acceptUploads,
  folderHarness,
  folderItem,
  requireBinary,
  type FolderHarness,
} from "./harness.js";
import {
  bodyOf,
  isContentWrite,
  put,
  read,
  scriptFolderChanges,
  scriptFolderWrites,
  sentCreates,
  settingsFile,
} from "./folders.shared.js";

let harness: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

it("writes matching library and feed items with query tier all", async () => {
  harness = await folderHarness("query-all", {
    settings: { query: { types: ["core.note"], tier: "all" } },
    rows: {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000f01",
            tier: "library",
            properties: { title: "Library", body: "kept\n" },
          },
        },
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000f02",
            tier: "feed",
            properties: { title: "Feed", body: "arrived\n" },
          },
        },
      ],
    },
  });
  scriptFolderWrites(harness);
  const pulled = await harness.folder.pull();
  expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
  expect(read(harness, "Library.md")).toContain("tier: library");
  expect(read(harness, "Feed.md")).toContain("tier: feed");
  const settings = readFileSync(settingsFile(harness), "utf8");
  expect(settings).toMatch(/^query:$/m);
  expect(settings).toContain("tier: all");
  expect(settings).not.toMatch(/^search:/m);
});

it.each([undefined, "feed"] as const)(
  "uses defaults tier or library for new documents and file items with query tier all (%s)",
  async (tier) => {
    harness = await folderHarness("query-all-default", {
      settings: {
        query: { types: ["core.note", "core.file"], tier: "all" },
        ...(tier === undefined ? {} : { defaults: { tier } }),
      },
      events: [copyLiveReplay("1", [])],
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    put(harness, "image.png", "image bytes");
    put(harness, "New.md", "---\ntitle: New\n---\nEvery edit stays.\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const created = sentCreates(harness);
    expect(created).toHaveLength(2);
    expect(created.map((item) => item.tier)).toEqual([
      tier ?? "library",
      tier ?? "library",
    ]);
    expect(created.find((item) => item.type === "core.note")).toMatchObject({
      properties: { body: "Every edit stays.\n" },
    });
  },
);

it.each([
  { setting: "search: {}\n", message: /unknown field `search`/ },
  { setting: "query:\n  tier: attic\n", message: /attic/ },
])(
  "refuses an unsupported settings-file key or tier ($setting)",
  async ({ setting, message }) => {
    harness = await folderHarness("query-refused-yaml", {
      settings: {},
      events: [copyLiveReplay("1", [])],
    });
    scriptFolderWrites(harness);
    const sent = scriptFolderChanges(harness);
    const original = readFileSync(settingsFile(harness), "utf8");
    writeFileSync(
      settingsFile(harness),
      original + "defaults:\n  tags: [witness]\n",
    );
    const accepted = await harness.folder.push();
    expect(
      accepted.ok && accepted.value.settings.sent,
      JSON.stringify(accepted),
    ).toBe(true);
    expect(sent).toHaveLength(1);
    const valid = readFileSync(settingsFile(harness), "utf8");
    const edited = valid + setting;
    writeFileSync(settingsFile(harness), edited);
    const refused = await harness.folder.push();
    expect(refused.ok, JSON.stringify(refused)).toBe(true);
    expect(refused.ok && refused.value.settings.flagged).toMatch(message);
    expect(sent).toHaveLength(1);
    expect(readFileSync(settingsFile(harness), "utf8")).toBe(edited);
  },
);

it.each(["create", "change"])(
  "names only --query in folders %s and refuses --search",
  async (command) => {
    const binary = requireBinary();
    const help = spawnSync(binary, ["folders", command, "--help"], {
      encoding: "utf8",
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("--query");
    expect(help.stdout).not.toContain("--search");
    harness = await folderHarness(`query-cli-${command}`, { settings: {} });
    const sent: Array<Record<string, unknown>> = [];
    harness.server.answer(
      command === "create" ? "POST" : "PATCH",
      command === "create" ? "/folders" : `/folders/${harness.settings.id}`,
      (request) => {
        sent.push(JSON.parse(request.body) as Record<string, unknown>);
        return command === "create"
          ? answers.created(folderItem(harness!.settings))
          : answers.updated(folderItem(harness!.settings));
      },
    );
    const accepted = await harness.folder
      .device()
      .rootReport([
        "folders",
        command,
        ...(command === "change"
          ? [harness.settings.id, "--version", "1"]
          : ["--title", "Query"]),
        "--query",
        JSON.stringify({ types: ["core.note"], tier: "all" }),
      ]);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(sent).toMatchObject([
      { query: { types: ["core.note"], tier: "all" } },
    ]);

    const refused = spawnSync(
      binary,
      [
        "folders",
        command,
        ...(command === "change"
          ? ["01a00000-0000-7000-8000-000000000f03"]
          : []),
        "--search",
        "{}",
      ],
      { encoding: "utf8" },
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/unexpected argument '--search'/);
  },
);

it("keeps files and sends no item write when a query narrows from all to library", async () => {
  let changed: Record<string, unknown> = {};
  harness = await folderHarness("query-all-narrowed", {
    settings: { query: { types: ["core.note"], tier: "all" } },
    rows: {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000f04",
            tier: "library",
            properties: { title: "Library", body: "kept\n" },
          },
        },
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000f05",
            tier: "feed",
            properties: { title: "Feed", body: "arrived\n" },
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
  expect((await harness.folder.pull()).ok).toBe(true);
  put(harness, "Witness.md", "---\ntitle: Witness\n---\nA writable item.\n");
  expect((await harness.folder.scan()).ok).toBe(true);
  expect((await harness.folder.device().drain()).ok).toBe(true);
  expect(sentCreates(harness)).toHaveLength(1);
  const before = read(harness, "Feed.md");
  expect(read(harness, "Library.md")).toContain("kept");
  harness.settings.settings = {
    query: { types: ["core.note"], tier: "library" },
  };
  harness.settings.version = 2;
  changed = folderItem(harness.settings);
  const start = harness.server.requests.length;
  const pushed = await harness.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  expect(pushed.ok && pushed.value.pull?.unmatched).toBe(1);
  expect(read(harness, "Feed.md")).toBe(before);
  expect(existsSync(join(harness.dir, "Library.md"))).toBe(true);
  const unmatched = await harness.folder.unmatched();
  expect(
    unmatched.ok && unmatched.value.unmatched.map((file) => file.path),
  ).toEqual(["Feed.md"]);
  expect(
    harness.server.requests
      .slice(start)
      .filter(
        (request) =>
          isContentWrite(request) && request.pathname.startsWith("/items"),
      ),
  ).toEqual([]);
});

it("keeps a file and sends no item write when its item leaves the query tier", async () => {
  const item = {
    id: "01a00000-0000-7000-8000-000000000f06",
    properties: { title: "Departing", body: "Every byte stays.\n" },
  };
  harness = await folderHarness("query-tier-departure", {
    settings: { query: { types: ["core.note"], tier: "library" } },
    rows: { "core.note": [{ item: { ...item, tier: "library" } }] },
    events: [
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.updated",
          wireItem({ ...item, tier: "feed", version: 2 }),
        ),
      ]),
      copyLiveReplay("2", []),
    ],
  });
  scriptFolderWrites(harness);
  expect((await harness.folder.pull()).ok).toBe(true);
  put(harness, "Witness.md", "---\ntitle: Witness\n---\nA writable item.\n");
  expect((await harness.folder.scan()).ok).toBe(true);
  expect((await harness.folder.device().drain()).ok).toBe(true);
  expect(sentCreates(harness)).toHaveLength(1);
  const before = bodyOf(harness, "Departing.md");
  const start = harness.server.requests.length;
  const pushed = await harness.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  expect(pushed.ok && pushed.value.pull?.unmatched).toBe(1);
  expect(bodyOf(harness, "Departing.md")).toBe(before);
  expect(read(harness, "Departing.md")).toContain(item.id);
  expect(
    harness.server.requests
      .slice(start)
      .filter(
        (request) =>
          isContentWrite(request) && request.pathname.startsWith("/items"),
      ),
  ).toEqual([]);
});
