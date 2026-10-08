import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answers,
  copyLiveReplay,
  copyReplay,
  copyItemEvent,
  wireItem,
  refusal,
  writeAnswers,
} from "../../device/marfa-answers.js";
import { FolderDoor } from "../../device/folder-door.js";
import { folderHarness, folderItem, scriptWrites } from "./harness.js";
import type { FolderHarness } from "./harness.js";

let harness: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

it("records each folder's distinct store identity in the shared registry", async () => {
  harness = await folderHarness("contract-registry-store");
  const second = await folderHarness("contract-registry-store-two", {
    registry: harness.registry,
  });
  try {
    const registry = JSON.parse(readFileSync(harness.registry, "utf8")) as {
      folders: Array<{ folder: string; store: string }>;
    };
    expect(registry.folders.map((entry) => entry.folder).sort()).toEqual(
      [harness.settings.id, second.settings.id].sort(),
    );
    for (const entry of registry.folders)
      expect(entry.store).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Set(registry.folders.map((entry) => entry.store)).size).toBe(2);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect(JSON.parse(readFileSync(harness.registry, "utf8"))).toEqual(
      registry,
    );
  } finally {
    await second.stop();
  }
});

it("materializes only readable copy rows reached by a beneath search", async () => {
  const root = "01a00000-0000-7000-8000-00000000a201";
  const child = "01a00000-0000-7000-8000-00000000a202";
  const unreadable = "01a00000-0000-7000-8000-00000000a203";
  harness = await folderHarness("contract-readable-beneath", {
    settings: { search: { types: ["core.note"], beneath: root } },
    rows: {
      "core.note": [
        { item: { id: root, properties: { title: "Root", body: "root\n" } } },
        {
          item: { id: child, properties: { title: "Child", body: "child\n" } },
        },
      ],
    },
    edges: {
      "parent-of": [child, unreadable].map((target_id, index) => ({
        id: `01a00000-0000-7000-8000-00000000a21${index}`,
        source_id: root,
        target_id,
        edge_type: "parent-of",
      })),
    },
  });
  scriptWrites(harness.server);
  const pulled = await harness.folder.pull();
  expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
  expect(
    readdirSync(harness.dir)
      .filter((name) => name !== ".marfa")
      .sort(),
  ).toEqual(["Child.md", "Root.md"]);
  const listed = await harness.folder.device().list({ type: "core.note" });
  expect(listed.ok && listed.value.map((item) => item.id).sort()).toEqual(
    [root, child].sort(),
  );
});

function settingsPath(folder: FolderHarness): string {
  return join(folder.dir, ".marfa", "folder.yaml");
}

function changes(folder: FolderHarness, status?: number) {
  const sent: Array<Record<string, unknown>> = [];
  folder.server.answer("PATCH", `/folders/${folder.settings.id}`, (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    sent.push(body);
    if (status !== undefined && sent.length === 1) {
      return refusal(
        status,
        "fixture_refusal",
        "the settings were not accepted",
      );
    }
    const { version: _version, ...settings } = body;
    folder.settings.settings = { ...folder.settings.settings, ...settings };
    folder.settings.version += 1;
    return answers.updated(folderItem(folder.settings));
  });
  return sent;
}

describe("folder settings contract", () => {
  it("uses the last written settings version when the file names no valid version", async () => {
    harness = await folderHarness("contract-settings-version", {
      events: [copyLiveReplay("1", [])],
    });
    const sent = changes(harness);
    for (const [index, line] of [
      "",
      "version: 0\n",
      "version: -1\n",
      "version: 1.5\n",
      'version: "abc"\n',
    ].entries()) {
      const version = harness.settings.version;
      const file = settingsPath(harness);
      writeFileSync(
        file,
        readFileSync(file, "utf8")
          .replace(/^version:.*\n/m, line)
          .replace(/^title:.*$/m, `title: changed-${index}`),
      );
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(sent.at(-1)).toEqual({ version, title: `changed-${index}` });
    }
  });

  it.each([400, 403, 404, 409, 422])(
    "holds a settings edit refused with status %s without resending its text",
    async (status) => {
      harness = await folderHarness(`contract-settings-refused-${status}`, {
        events: [copyLiveReplay("1", [])],
      });
      const sent = changes(harness, status);
      const file = settingsPath(harness);
      const edited = readFileSync(file, "utf8").replace(
        "title: folder",
        "title: refused",
      );
      writeFileSync(file, edited);
      for (let pass = 0; pass < 2; pass += 1) {
        const pushed = await harness.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
        if (!pushed.ok) return;
        expect(pushed.value.settings.flagged).toContain("folder door refused");
        expect(pushed.value.settings.flagged).toContain("fixture_refusal");
        expect(readFileSync(file, "utf8")).toBe(edited);
        expect(harness.settings.version).toBe(1);
      }
      expect(sent).toHaveLength(1);
      writeFileSync(file, edited.replace("title: refused", "title: recovered"));
      const recovered = await harness.folder.push();
      expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.value.settings).toMatchObject({
        sent: true,
        flagged: null,
      });
      expect(sent).toHaveLength(2);
    },
  );

  it.each([401, 429, 503])(
    "retries a settings edit after status %s",
    async (status) => {
      harness = await folderHarness(`contract-settings-retry-${status}`, {
        events: [copyLiveReplay("1", [])],
      });
      const sent = changes(harness, status);
      const file = settingsPath(harness);
      const edited = readFileSync(file, "utf8").replace(
        "title: folder",
        "title: retried",
      );
      writeFileSync(file, edited);
      const first = await harness.folder.push();
      expect(first.ok, JSON.stringify(first)).toBe(true);
      if (!first.ok) return;
      expect(first.value.settings.flagged).toContain("not sent yet");
      expect(readFileSync(file, "utf8")).toBe(edited);
      const second = await harness.folder.push();
      expect(second.ok, JSON.stringify(second)).toBe(true);
      if (!second.ok) return;
      expect(second.value.settings).toMatchObject({
        sent: true,
        flagged: null,
      });
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
    },
  );

  it("replaces an unsent settings edit when the same folder is added again", async () => {
    harness = await folderHarness("contract-settings-readd");
    const file = settingsPath(harness);
    const written = readFileSync(file, "utf8");
    writeFileSync(file, written.replace("title: folder", "title: unsent"));
    expect(readFileSync(file, "utf8")).toContain("title: unsent");
    const added = await harness.folder.add(harness.settings.id, {
      confirm: true,
    });
    expect(added.ok, JSON.stringify(added)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(written);
    expect(
      harness.server.requests.filter((request) => request.method === "PATCH"),
    ).toEqual([]);
  });
});

describe("document admission contract", () => {
  it("uses core.note without a type default and preserves explicit empty tags and titles", async () => {
    harness = await folderHarness("contract-default-document", {
      settings: {
        search: {},
        defaults: {
          tags: ["default-tag"],
          properties: { title: "Default title" },
        },
      },
    });
    writeFileSync(
      join(harness.dir, "explicit.md"),
      "---\ntitle: Authored title\ntags: []\nbody: ignored frontmatter value\n---\nbody\n",
    );
    writeFileSync(join(harness.dir, "blank.md"), "body\n");
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (scanned.ok) expect(scanned.value.flagged).toEqual([]);
    const queued = await harness.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    const creates = queued.value.filter(
      (write) => write.kind === "create_item",
    );
    expect(creates).toHaveLength(2);
    expect(
      creates.map(
        (write) =>
          (write.body as { properties: Record<string, unknown> }).properties
            .body,
      ),
    ).toEqual(["body\n", "body\n"]);
    expect(
      creates.map((write) => (write.body as { type: string }).type),
    ).toEqual(["core.note", "core.note"]);
    expect(
      creates
        .map(
          (write) =>
            (write.body as { properties: Record<string, unknown> }).properties
              .title,
        )
        .sort(),
    ).toEqual(["Authored title", "Default title"]);
    const explicit = creates.find(
      (write) =>
        (write.body as { properties: Record<string, unknown> }).properties
          .title === "Authored title",
    );
    const implicit = creates.find(
      (write) =>
        (write.body as { properties: Record<string, unknown> }).properties
          .title === "Default title",
    );
    expect(
      queued.value
        .filter((write) => write.kind === "add_tag")
        .map((write) => [write.item_id, write.tag]),
    ).toEqual([[implicit?.item_id, "default-tag"]]);
    expect(explicit?.item_id).not.toBe(implicit?.item_id);
  });

  it("reads incomplete fences as body and an empty fence pair as empty frontmatter", async () => {
    harness = await folderHarness("contract-document-fences");
    const bodies = [
      "----\nword\n---\n",
      "--- text\nword\n---\n",
      "---\ntitle: unfinished\n",
      "---\n\nNote: text\n---\n",
    ];
    for (const [index, body] of bodies.entries())
      writeFileSync(join(harness.dir, `${index}.md`), body);
    writeFileSync(join(harness.dir, "empty.md"), "---\n---\nbody\n");
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.value.flagged).toEqual([]);
    const queued = await harness.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    const properties = queued.value
      .filter((write) => write.kind === "create_item")
      .map(
        (write) =>
          (write.body as { properties: Record<string, unknown> }).properties,
      );
    expect(properties).toHaveLength(5);
    for (const body of [...bodies, "body\n"])
      expect(properties.map((value) => value?.body)).toContain(body);
    expect(properties.find((value) => value?.title === "empty")).toEqual({
      body: "body\n",
      title: "empty",
    });
  });

  it("holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date", async () => {
    harness = await folderHarness("contract-document-invalid");
    for (const [name, lines] of [
      ["duplicate", "title: first\ntitle: second"],
      ["empty-date", 'occurred_at: ""'],
      ["large-year", "occurred_at: 10000-01-01"],
      ["valid", "occurred_at: 2026-10-06"],
    ]) {
      writeFileSync(
        join(harness.dir, `${name}.md`),
        `---\n${lines}\n---\nbody\n`,
      );
    }
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.flagged.map((file) => [file.path, file.flag]).sort(),
    ).toEqual(
      ["duplicate.md", "empty-date.md", "large-year.md"].map((name) => [
        name,
        "unreadable",
      ]),
    );
    const queued = await harness.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    const creates = queued.value.filter(
      (write) => write.kind === "create_item",
    );
    expect(creates).toHaveLength(1);
    expect(
      (creates[0]?.body as { properties: Record<string, unknown> }).properties
        .title,
    ).toBe("valid");
    expect((creates[0]?.body as { occurred_at: string }).occurred_at).toBe(
      "2026-10-06T00:00:00.000Z",
    );
  });
});

describe("document rendering contract", () => {
  it.each([false, true])(
    "expands affected aliases and preserves untouched anchors when removal is %s",
    async (remove) => {
      const id = "01a00000-0000-7000-8000-000000000aa1";
      const original = {
        title: "Styled",
        body: "body\n",
        base: { keep: "é", change: "old" },
        copy: { keep: "é", change: "old" },
        other: ["a", "b"],
        untouched: ["a", "b"],
      };
      const changed: Record<string, unknown> = { ...original };
      if (remove) delete changed.base;
      else changed.base = { keep: "é", change: "new" };
      harness = await folderHarness("contract-aliases", {
        rows: { "core.note": [{ item: { id, properties: original } }] },
        files: {
          "Styled.md": `---\ntitle: Styled\nbase: &base {keep: 'é', change: old}\ncopy: *base # alias\nother: &other [a, b]\nuntouched: *other\nmarfa_id: ${id}\nmarfa_version: 1\n---\nbody\n`,
        },
        events: [
          copyReplay("2", [
            copyItemEvent(
              "2",
              "item.updated",
              wireItem({ id, version: 2, properties: changed }),
            ),
          ]),
          copyLiveReplay("2", []),
        ],
      });
      expect((await harness.folder.scan()).ok).toBe(true);
      const before = await harness.folder.pull();
      expect(before.ok, JSON.stringify(before)).toBe(true);
      const path = join(harness.dir, "Styled.md");
      const beforeChange = readFileSync(path, "utf8");
      expect(beforeChange).toContain("copy: *base # alias");
      expect(beforeChange.indexOf("type: core.note")).toBeGreaterThan(
        beforeChange.indexOf("marfa_version: 1"),
      );
      expect(beforeChange.indexOf("tier: library")).toBeGreaterThan(
        beforeChange.indexOf("type: core.note"),
      );
      expect((await harness.folder.device().catchUp()).ok).toBe(true);
      const pulled = await harness.folder.pull();
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      const rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("other: &other [a, b]\nuntouched: *other\n");
      expect(rendered).not.toContain("copy: *base");
      expect(rendered).toContain("# alias");
      const front = parseYaml(rendered.split("---\n")[1]!) as Record<
        string,
        unknown
      >;
      expect(front.copy).toEqual(original.copy);
      expect(front.base).toEqual(changed.base);
      const scanned = await harness.folder.scan();
      expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
      if (scanned.ok) expect(scanned.value.updated).toBe(0);
    },
  );

  it("writes own fields in order before properties including an explicit time", async () => {
    harness = await folderHarness("contract-own-order", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000aa2",
              state: "archived",
              occurred_at: "2020-01-02T00:00:00.000Z",
              created_at: "2026-10-08T00:00:00.000Z",
              properties: { title: "Ordered", second: "kept", body: "body\n" },
            },
            tags: ["z", "a"],
          },
        ],
      },
    });
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    const text = readFileSync(join(harness.dir, "Ordered.md"), "utf8");
    const names = [...text.matchAll(/^([a-z_]+):/gm)].map((match) => match[1]);
    expect(names.slice(0, 7)).toEqual([
      "type",
      "tier",
      "tags",
      "state",
      "occurred_at",
      "title",
      "second",
    ]);
  });

  it("keeps a read-only document unchanged when another device changes its item", async () => {
    const id = "01a00000-0000-7000-8000-000000000aa3";
    harness = await folderHarness("contract-read-only", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Protected", body: "before\n" } },
          },
        ],
      },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "Protected", body: "after\n" },
            }),
          ),
        ]),
        copyLiveReplay("2", []),
      ],
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const path = join(harness.dir, "Protected.md");
    const before = readFileSync(path, "utf8");
    chmodSync(path, 0o444);
    try {
      expect((await harness.folder.device().catchUp()).ok).toBe(true);
      const pulled = await harness.folder.pull();
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      if (!pulled.ok) return;
      expect(pulled.value.unwritten).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      chmodSync(path, 0o644);
    }
    const recovered = await harness.folder.pull();
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("after\n");
  });
});

describe("settings and folder reporting", () => {
  it("tells a watch why a settings edit is not in force", async () => {
    harness = await folderHarness("contract-settings-watch", {
      events: [copyLiveReplay("1", [])],
    });
    const watch = harness.folder.watchText();
    try {
      await vi.waitFor(() => expect(watch.stderr).toContain("watching"));
      const file = settingsPath(harness);
      writeFileSync(
        file,
        readFileSync(file, "utf8") + "unknown_setting: true\n",
      );
      await vi.waitFor(
        () => {
          expect(watch.stdout).toContain("not in force");
          expect(watch.stdout).toContain("unknown_setting");
        },
        { timeout: 10_000, interval: 50 },
      );
      expect(watch.running(), watch.stderr).toBe(true);
    } finally {
      await watch.stop();
    }
  });

  it("advises empty values when an edit removes a current setting", async () => {
    harness = await folderHarness("contract-settings-empty-advice", {
      events: [copyLiveReplay("1", [])],
    });
    const sent = changes(harness);
    const file = settingsPath(harness);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^title:.*\n/m, ""));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.settings.flagged).toContain("write it empty instead");
    expect(pushed.value.settings.flagged).toContain("[]");
    expect(pushed.value.settings.flagged).toContain("{}");
    expect(sent).toEqual([]);
  });

  it("hydrates a changed watch slice at the next push rather than during the watch", async () => {
    harness = await folderHarness("contract-watch-slice", {
      events: [copyLiveReplay("1", [])],
    });
    const sent = changes(harness);
    const watch = harness.folder.watch();
    try {
      await vi.waitFor(() => expect(watch.stderr).toContain("watching"));
      const file = settingsPath(harness);
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("core.note", "core.bookmark"),
      );
      await vi.waitFor(() => expect(sent).toHaveLength(1), {
        timeout: 10_000,
        interval: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(
        harness.server.requests.filter(
          (request) =>
            request.pathname === "/items" &&
            request.query.get("type") === "core.bookmark",
        ),
      ).toEqual([]);
      expect(watch.running(), watch.stderr).toBe(true);
    } finally {
      await watch.stop();
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.hydrated).not.toBeNull();
    expect(
      harness.server.requests.some(
        (request) =>
          request.pathname === "/items" &&
          request.query.get("type") === "core.bookmark",
      ),
    ).toBe(true);
  });

  it("reports root_gone and ignores a replacement directory while watching", async () => {
    harness = await folderHarness("contract-root-gone", {
      events: [copyLiveReplay("1", [])],
    });
    const sent = changes(harness);
    const watch = harness.folder.watch();
    const dir = harness.dir;
    const away = `${dir}-original`;
    const copy = `${dir}-replacement`;
    try {
      await vi.waitFor(() => expect(watch.stderr).toContain("watching"));
      const file = settingsPath(harness);
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("title: folder", "title: accepted"),
      );
      await vi.waitFor(() => expect(sent).toHaveLength(1), {
        timeout: 10_000,
        interval: 50,
      });
      await vi.waitFor(() =>
        expect(readFileSync(file, "utf8")).toContain("version: 2"),
      );
      cpSync(dir, copy, { recursive: true });
      renameSync(dir, away);
      renameSync(copy, dir);
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("title: accepted", "title: ignored"),
      );
      writeFileSync(join(dir, "Unowned.md"), "not this folder's file\n");
      await vi.waitFor(
        () =>
          expect(watch.stdout).toMatch(
            /"root_gone": "[^"\n]*no longer the directory/,
          ),
        { timeout: 10_000, interval: 50 },
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(sent).toHaveLength(1);
      expect(readFileSync(file, "utf8")).toContain("title: ignored");
      expect(readFileSync(join(dir, "Unowned.md"), "utf8")).toBe(
        "not this folder's file\n",
      );
      expect(
        harness.server.requests.filter(
          (request) =>
            request.pathname === "/items" && request.method === "POST",
        ),
      ).toEqual([]);
      expect(watch.stdout).toMatch(/"created": 0/);
      expect(watch.running(), watch.stderr).toBe(true);
    } finally {
      await watch.stop();
      if (existsSync(away)) {
        rmSync(dir, { recursive: true, force: true });
        renameSync(away, dir);
      }
    }
  });
});

describe("remaining document field boundaries", () => {
  it("applies default properties to documents but not file items", async () => {
    harness = await folderHarness("contract-file-defaults", {
      settings: {
        search: {},
        defaults: { tags: ["default"], properties: { language: "en" } },
      },
    });
    writeFileSync(join(harness.dir, "note.md"), "body\n");
    writeFileSync(
      join(harness.dir, "raw.bin"),
      Buffer.from([0xff, 0x00, 0xfe]),
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.value.flagged).toEqual([]);
    const queue = await harness.folder.device().queue();
    expect(queue.ok, JSON.stringify(queue)).toBe(true);
    if (!queue.ok) return;
    const creates = queue.value
      .filter((entry) => entry.kind === "create_item")
      .map(
        (entry) =>
          entry.body as { type: string; properties: Record<string, unknown> },
      );
    expect(creates).toHaveLength(2);
    expect(
      creates.find((entry) => entry.type === "core.note")?.properties.language,
    ).toBe("en");
    expect(
      creates.find((entry) => entry.type.startsWith("core.file"))?.properties
        .language,
    ).toBeUndefined();
    expect(
      queue.value.filter((entry) => entry.kind === "upload_blob"),
    ).toHaveLength(1);
    expect(
      queue.value
        .filter((entry) => entry.kind === "add_tag")
        .map((entry) => entry.tag),
    ).toEqual(["default", "default"]);
  });

  it.each(["", "marfa_version: 99\n"])(
    "merges on the copy version when the file version line is %s",
    async (line) => {
      const id = "01a00000-0000-7000-8000-000000000ab1";
      harness = await folderHarness("contract-line-base", {
        rows: {
          "core.note": [
            {
              item: {
                id,
                version: 3,
                properties: { title: "Base", body: "before\n" },
              },
            },
          ],
        },
      });
      expect((await harness.folder.pull()).ok).toBe(true);
      const path = join(harness.dir, "Base.md");
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replace(/^marfa_version:.*\n/m, line)
          .replace("before", "after"),
      );
      expect((await harness.folder.scan()).ok).toBe(true);
      const queue = await harness.folder.device().queue();
      expect(queue.ok, JSON.stringify(queue)).toBe(true);
      if (!queue.ok) return;
      const update = queue.value.find((entry) => entry.kind === "update_item");
      expect(update?.base_version).toBe(3);
      const body = update?.body as {
        properties: Record<string, unknown>;
        properties_mode?: string;
      };
      expect(body.properties_mode).toBeUndefined();
      expect(body.properties).toEqual({ title: "Base", body: "after\n" });
      expect(body.properties).not.toHaveProperty("marfa_id");
      expect(body.properties).not.toHaveProperty("marfa_version");
    },
  );

  it("writes current own fields over a behind file without sending the old fields", async () => {
    const id = "01a00000-0000-7000-8000-000000000ab2";
    harness = await folderHarness("contract-behind-render", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Stale", body: "body\n" } },
            tags: ["old"],
          },
        ],
      },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              type: "core.bookmark",
              state: "archived",
              properties: { title: "Stale", body: "body\n" },
            }),
            { tags: ["old", "new"] },
          ),
        ]),
        copyLiveReplay("2", []),
      ],
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const path = join(harness.dir, "Stale.md");
    const old = readFileSync(path, "utf8");
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("type: core.bookmark");
    writeFileSync(path, old.replace("body\n", "edited\n"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.value.flagged.map((entry) => entry.flag)).toContain(
      "behind",
    );
    const queue = await harness.folder.device().queue();
    expect(queue.ok, JSON.stringify(queue)).toBe(true);
    if (!queue.ok) return;
    expect(
      queue.value.some(
        (entry) =>
          entry.kind === "remove_tag" || entry.kind === "transition_item",
      ),
    ).toBe(false);
    expect((await harness.folder.pull()).ok).toBe(true);
    const current = readFileSync(path, "utf8");
    expect(current).toContain("type: core.bookmark");
    expect(current).toContain("state: archived");
    expect(current).toContain("  - new\n");
  });

  it("queues successive state changes from one version in save order", async () => {
    const id = "01a00000-0000-7000-8000-000000000ab3";
    harness = await folderHarness("contract-two-state-saves", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "State", body: "body\n" } } },
        ],
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const path = join(harness.dir, "State.md");
    const first = readFileSync(path, "utf8");
    writeFileSync(
      path,
      first.replace("type: core.note", "state: archived\ntype: core.note"),
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    writeFileSync(path, first);
    expect((await harness.folder.scan()).ok).toBe(true);
    const queue = await harness.folder.device().queue();
    expect(queue.ok, JSON.stringify(queue)).toBe(true);
    if (!queue.ok) return;
    expect(
      queue.value
        .filter((entry) => entry.kind === "transition_item")
        .map((entry) => (entry.body as { state: string }).state),
    ).toEqual(["archived", "active"]);
  });
});

describe("deletion guards", () => {
  it("sends no journaled deletion from an incomplete walk and resumes after a complete walk", async () => {
    const ids = [
      "01a00000-0000-7000-8000-000000000ac1",
      "01a00000-0000-7000-8000-000000000ac2",
    ];
    harness = await folderHarness("contract-incomplete-delete", {
      rows: {
        "core.note": ids.map((id, index) => ({
          item: { id, properties: { title: `Note${index}`, body: "body\n" } },
        })),
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    mkdirSync(join(harness.dir, "sub"));
    renameSync(
      join(harness.dir, "Note1.md"),
      join(harness.dir, "sub", "Note1.md"),
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    rmSync(join(harness.dir, "Note0.md"));
    const first = await harness.folder.scan();
    expect(first.ok && first.value.missing).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const oldFault = process.env.MARFA_TEST_FAULT;
    try {
      process.env.MARFA_TEST_FAULT = "vanish-while-walking=sub";
      const incomplete = await harness.folder.scan();
      expect(incomplete.ok, JSON.stringify(incomplete)).toBe(true);
      if (!incomplete.ok) return;
      expect(
        incomplete.value.directories.map((entry) => [entry.path, entry.flag]),
      ).toEqual([["sub", "gone"]]);
      expect(incomplete.value.deleted).toBe(0);
      const held = await harness.folder.device().queue();
      expect(held.ok, JSON.stringify(held)).toBe(true);
      if (held.ok)
        expect(
          held.value.filter((entry) => entry.kind === "delete_item"),
        ).toEqual([]);
    } finally {
      if (oldFault === undefined) delete process.env.MARFA_TEST_FAULT;
      else process.env.MARFA_TEST_FAULT = oldFault;
      if (existsSync(join(harness.dir, "sub.vanished")))
        renameSync(join(harness.dir, "sub.vanished"), join(harness.dir, "sub"));
    }
    const complete = await harness.folder.scan();
    expect(complete.ok && complete.value.deleted).toBe(1);
    const queued = await harness.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (queued.ok)
      expect(
        queued.value
          .filter((entry) => entry.kind === "delete_item")
          .map((entry) => entry.item_id),
      ).toEqual([ids[0]]);
  });

  it("journals files from a directory removed before the walk begins", async () => {
    harness = await folderHarness("contract-directory-before-walk", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000ac3",
              properties: { title: "Gone", body: "body\n" },
            },
          },
        ],
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    mkdirSync(join(harness.dir, "sub"));
    renameSync(
      join(harness.dir, "Gone.md"),
      join(harness.dir, "sub", "Gone.md"),
    );
    const bound = await harness.folder.scan();
    expect(bound.ok && bound.value.renamed).toBe(1);
    rmSync(join(harness.dir, "sub"), { recursive: true });
    const missing = await harness.folder.scan();
    expect(missing.ok, JSON.stringify(missing)).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.missing).toBe(1);
    expect(missing.value.directories).toEqual([]);
  });

  it("refuses status and removal decisions while the folder directory is missing", async () => {
    harness = await folderHarness("contract-gone-commands");
    const present = await harness.folder.status();
    expect(present.ok, JSON.stringify(present)).toBe(true);
    const away = `${harness.dir}-away`;
    renameSync(harness.dir, away);
    try {
      for (const result of [
        await harness.folder.status(),
        await harness.folder.confirm(),
        await harness.folder.restore(),
      ]) {
        expect(result.ok, JSON.stringify(result)).toBe(false);
        if (!result.ok)
          expect(result.refusal.raw).toMatch(/folder|directory|find|found/i);
      }
      expect(existsSync(harness.dir)).toBe(false);
    } finally {
      renameSync(away, harness.dir);
    }
    expect((await harness.folder.status()).ok).toBe(true);
  });
});

describe("own-field recovery", () => {
  it("allows a previously ambiguous tag change after the item version advances", async () => {
    const id = "01a00000-0000-7000-8000-000000000ad1";
    let stage = 0;
    const current = () =>
      wireItem({
        id,
        version: stage === 2 ? 2 : 1,
        properties: {
          title: "Tags",
          body: "body\n",
          ...(stage === 2 ? { notes: "a versioned change" } : {}),
        },
      });
    harness = await folderHarness("contract-tag-version-advance", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Tags", body: "body\n" } },
            tags: ["a"],
          },
        ],
      },
      events: [
        () =>
          copyLiveReplay(
            String(stage + 1),
            stage === 0
              ? []
              : [
                  copyItemEvent(String(stage + 1), "item.updated", current(), {
                    tags: ["a", "b"],
                  }),
                ],
          ),
      ],
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const path = join(harness.dir, "Tags.md");
    const old = readFileSync(path, "utf8");
    stage = 1;
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("  - b\n");
    writeFileSync(path, old);
    const flagged = await harness.folder.scan();
    expect(flagged.ok, JSON.stringify(flagged)).toBe(true);
    if (!flagged.ok) return;
    expect(flagged.value.flagged.map((entry) => entry.flag)).toContain(
      "behind",
    );
    let queue = await harness.folder.device().queue();
    expect(
      queue.ok && queue.value.filter((entry) => entry.kind === "remove_tag"),
    ).toEqual([]);
    expect((await harness.folder.pull()).ok).toBe(true);
    stage = 2;
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    expect((await harness.folder.pull()).ok).toBe(true);
    const currentFile = readFileSync(path, "utf8");
    expect(currentFile).toContain("marfa_version: 2");
    writeFileSync(path, currentFile.replace("  - b\n", ""));
    const accepted = await harness.folder.scan();
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (accepted.ok) expect(accepted.value.flagged).toEqual([]);
    queue = await harness.folder.device().queue();
    expect(
      queue.ok &&
        queue.value
          .filter((entry) => entry.kind === "remove_tag")
          .map((entry) => entry.tag),
    ).toEqual(["b"]);
  });

  it("allows a previously ambiguous state change after the item version advances", async () => {
    const id = "01a00000-0000-7000-8000-000000000ad3";
    let stage = 0;
    const current = () =>
      wireItem({
        id,
        version: stage === 2 ? 2 : 1,
        state: stage === 0 ? "active" : "archived",
        properties: {
          title: "Tags",
          body: "body\n",
          ...(stage === 2 ? { notes: "a versioned change" } : {}),
        },
      });
    harness = await folderHarness("contract-state-version-advance", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Tags", body: "body\n" } },
            tags: ["a"],
          },
        ],
      },
      events: [
        () =>
          copyLiveReplay(
            String(stage + 1),
            stage === 0
              ? []
              : [
                  copyItemEvent(String(stage + 1), "item.updated", current(), {
                    tags: ["a"],
                  }),
                ],
          ),
      ],
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const path = join(harness.dir, "Tags.md");
    const old = readFileSync(path, "utf8");
    stage = 1;
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("state: archived\n");
    writeFileSync(path, old);
    const flagged = await harness.folder.scan();
    expect(flagged.ok, JSON.stringify(flagged)).toBe(true);
    if (!flagged.ok) return;
    expect(flagged.value.flagged.map((entry) => entry.flag)).toContain(
      "behind",
    );
    let queue = await harness.folder.device().queue();
    expect(
      queue.ok &&
        queue.value.filter((entry) => entry.kind === "transition_item"),
    ).toEqual([]);
    expect((await harness.folder.pull()).ok).toBe(true);
    stage = 2;
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    expect((await harness.folder.pull()).ok).toBe(true);
    const currentFile = readFileSync(path, "utf8");
    expect(currentFile).toContain("marfa_version: 2");
    writeFileSync(path, currentFile.replace("state: archived\n", ""));
    const accepted = await harness.folder.scan();
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (accepted.ok) expect(accepted.value.flagged).toEqual([]);
    queue = await harness.folder.device().queue();
    expect(
      queue.ok &&
        queue.value
          .filter((entry) => entry.kind === "transition_item")
          .map((entry) => (entry.body as { state: string }).state),
    ).toEqual(["active"]);
  });

  it.each(["tag", "state"])(
    "releases a refused %s when a later change of it is accepted",
    async (kind) => {
      const id = "01a00000-0000-7000-8000-000000000ad2";
      const properties = { title: "Refused", body: "body\n" };
      const door = new FolderDoor([
        [
          id,
          {
            properties,
            type: "core.note",
            source: "device-fixtures",
            source_id: null,
            version: 1,
            tier: "library",
            tags: ["a"],
          },
        ],
      ]);
      let changed = false;
      harness = await folderHarness(`contract-refused-${kind}`, {
        rows: { "core.note": [{ item: { id, properties }, tags: ["a"] }] },
        events: [
          () =>
            copyLiveReplay(
              changed ? "2" : "1",
              changed
                ? [
                    copyItemEvent(
                      "2",
                      "item.updated",
                      wireItem({
                        id,
                        version: 2,
                        state: kind === "state" ? "archived" : "active",
                        properties,
                      }),
                      { tags: kind === "tag" ? ["a", "b"] : ["a"] },
                    ),
                  ]
                : [],
            ),
        ],
      });
      harness.server.copyAnswer(
        "GET",
        /^\/edges\/[^/]+$/,
        refusal(404, "edge_not_found", "No such edge"),
      );
      let refused = false;
      scriptWrites(harness.server, {
        read: [(request) => door.read(request.pathname.split("/").at(-1)!)],
        edges: [
          refusal(
            403,
            "edge_permission_denied",
            "the fixture retains its unplaced file",
          ),
        ],
        tags: [
          (request) => {
            if (!refused) {
              refused = true;
              return refusal(403, "forbidden", "tag refused");
            }
            const row = door.rows.get(id)!;
            const tags =
              request.method === "DELETE"
                ? (row.tags ?? []).filter((tag) => tag !== "b")
                : ["a", "b"];
            door.rows.set(id, { ...row, tags });
            return writeAnswers.metadata(id, tags);
          },
        ],
      });
      harness.server.answer("POST", `/items/${id}/transition`, (request) => {
        if (!refused) {
          refused = true;
          return refusal(403, "forbidden", "state refused");
        }
        return door.transition(
          id,
          (JSON.parse(request.body) as { state: string }).state,
        );
      });
      expect((await harness.folder.pull()).ok).toBe(true);
      const path = join(harness.dir, "Refused.md");
      const original = readFileSync(path, "utf8");
      const edit =
        kind === "tag"
          ? original.replace("  - a\n", "  - a\n  - b\n")
          : original.replace(
              "type: core.note",
              "state: archived\ntype: core.note",
            );
      writeFileSync(path, edit);
      const first = await harness.folder.push();
      expect(first.ok, JSON.stringify(first)).toBe(true);
      if (!first.ok) return;
      expect(
        first.value.pull?.flagged.map((entry) => entry.flag),
        JSON.stringify(first),
      ).toContain("refused");
      expect(refused).toBe(true);
      door.rows.set(id, {
        ...door.rows.get(id)!,
        version: 2,
        ...(kind === "tag" ? { tags: ["a", "b"] } : { state: "archived" }),
      });
      changed = true;
      expect((await harness.folder.device().catchUp()).ok).toBe(true);
      // A current buffer deliberately reverses the now accepted remote value.
      writeFileSync(
        path,
        original.replace("marfa_version: 1", "marfa_version: 2"),
      );
      if (kind === "state")
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(
            "type: core.note",
            "state: active\ntype: core.note",
          ),
        );
      const recovered = await harness.folder.push();
      expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.value.pull?.flagged).toEqual([]);
      if (kind === "tag") expect(door.rows.get(id)?.tags).toEqual(["a"]);
      else expect(door.rows.get(id)?.state).toBe("active");
      expect(
        recovered.value.drain.verdicts.some(
          (entry) =>
            entry.verdict === "accepted" &&
            entry.kind === (kind === "tag" ? "remove_tag" : "transition_item"),
        ),
      ).toBe(true);
    },
  );
});

it("expands an alias moved before its anchor while preserving other anchor groups", async () => {
  const id = "01a00000-0000-7000-8000-000000000ae1";
  const first = { base: { value: "old" }, rank: 1 };
  const second = { copy: { value: "old" }, rank: 2 };
  const properties = {
    title: "Moved",
    body: "body\n",
    steps: [first, second],
    other: ["a", "b"],
    kept: ["a", "b"],
  };
  harness = await folderHarness("contract-alias-moved", {
    rows: { "core.note": [{ item: { id, properties } }] },
    files: {
      "Moved.md": `---\ntitle: Moved\nsteps:\n  - base: &shared {value: old}\n    rank: 1\n  - copy: *shared # retained value\n    rank: 2\nother: &other [a, b]\nkept: *other\nmarfa_id: ${id}\nmarfa_version: 1\n---\nbody\n`,
    },
    events: [
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.updated",
          wireItem({
            id,
            version: 2,
            properties: { ...properties, steps: [second, first] },
          }),
        ),
      ]),
      copyLiveReplay("2", []),
    ],
  });
  expect((await harness.folder.scan()).ok).toBe(true);
  expect((await harness.folder.pull()).ok).toBe(true);
  const path = join(harness.dir, "Moved.md");
  expect(readFileSync(path, "utf8")).toContain("copy: *shared");
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  const pulled = await harness.folder.pull();
  expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
  const rendered = readFileSync(path, "utf8");
  const front = parseYaml(rendered.split("---\n")[1]!) as Record<
    string,
    unknown
  >;
  expect(front.steps).toEqual([second, first]);
  expect(rendered).not.toContain("copy: *shared");
  expect(rendered).toContain("# retained value");
  expect(rendered).toContain("other: &other [a, b]\nkept: *other\n");
  const scanned = await harness.folder.scan();
  expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
  if (scanned.ok) expect(scanned.value.updated).toBe(0);
});

it("reports a locally missing item already trashed elsewhere as waiting on scan", async () => {
  const id = "01a00000-0000-7000-8000-000000000af1";
  const item = { id, properties: { title: "Trashed", body: "body\n" } };
  harness = await folderHarness("contract-trashed-status", {
    rows: { "core.note": [{ item }] },
    events: [
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.deleted",
          wireItem({ ...item, state: "trashed" }),
        ),
      ]),
      copyLiveReplay("2", []),
    ],
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  rmSync(join(harness.dir, "Trashed.md"));
  expect((await harness.folder.scan()).ok).toBe(true);
  const before = await harness.folder.status();
  expect(
    before.ok &&
      before.value.files.find((file) => file.path === "Trashed.md")?.waits,
  ).toEqual(["delete"]);
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  const pulled = await harness.folder.pull();
  expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
  if (pulled.ok)
    expect([pulled.value.removed, pulled.value.kept]).toEqual([0, 0]);
  const after = await harness.folder.status();
  expect(
    after.ok &&
      after.value.files.find((file) => file.path === "Trashed.md")?.waits,
  ).toEqual(["scan"]);
});
