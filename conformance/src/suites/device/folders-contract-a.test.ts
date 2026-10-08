import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
  copyLiveReplay,
  copyReplay,
  copyItemEvent,
  wireItem,
  refusal,
} from "../../device/marfa-answers.js";
import { folderHarness, folderItem } from "./harness.js";
import type { FolderHarness } from "./harness.js";

let harness: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
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
      "---\ntitle: Authored title\ntags: []\n---\nbody\n",
    );
    writeFileSync(join(harness.dir, "blank.md"), "body\n");
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    const queued = await harness.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    const creates = queued.value.filter(
      (write) => write.kind === "create_item",
    );
    expect(creates).toHaveLength(2);
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
      expect(readFileSync(path, "utf8")).toContain("copy: *base # alias");
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
