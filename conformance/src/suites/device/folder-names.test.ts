import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FolderSettings } from "../../device/cli-adapter.js";
import { folderHarness, type FolderHarness } from "./harness.js";

/**
 * A folder holds the tags and property names its files carry to the bounds
 * the server holds them to, and one file that breaks them stops nothing else.
 */

const ROW = "01a00000-0000-7000-8000-00000000000b";
let folder: FolderHarness | undefined;

afterEach(async () => {
  await folder?.stop();
  folder = undefined;
});

const note = (name: string, extra: string, body = "a body\n") =>
  `---\ntype: core.note\ntitle: ${name}\n${extra}---\n${body}`;

/** A tag the server refuses, beside why. */
const BAD_TAGS: Array<[string, string]> = [
  ["a".repeat(129), "over 128 UTF-16 code units"],
  ["﻿", "a tag of only U+FEFF, which JavaScript's trim strips"],
];

async function started(settings = {}) {
  folder = await folderHarness("names", {
    settings: { search: { types: ["core.note"] }, ...settings },
    rows: {
      "core.note": [
        {
          item: {
            id: ROW,
            type: "core.note",
            properties: { title: "held", body: "held\n" },
          },
        },
      ],
    },
  });
  expect((await folder.folder.pull()).ok).toBe(true);
  return folder;
}

describe("a folder's file naming a tag or a property the server refuses", () => {
  it("is flagged with its reason while the files either side of it are saved", async () => {
    const f = await started();
    const files: Array<[string, string]> = [
      ["a-first.md", note("first", "")],
      ...BAD_TAGS.map(([tag], index): [string, string] => [
        `b-bad-tag-${String(index)}.md`,
        note(`bad tag ${String(index)}`, `tags:\n  - ${JSON.stringify(tag)}\n`),
      ]),
      ["c-bad-property.md", note("bad property", '"": 1\n')],
      ["d-last.md", note("last", "")],
    ];
    for (const [name, text] of files)
      writeFileSync(join(f.dir, name), text, "utf8");
    const scanned = await f.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    // The witnesses: the files sorting either side of the refused ones were
    // saved, so the refusals are of those files and not of the scan.
    expect(scanned.value.created).toBe(2);
    const flagged = new Map(
      scanned.value.flagged.map((entry) => [entry.path, entry]),
    );
    expect([...flagged.keys()].sort()).toEqual([
      "b-bad-tag-0.md",
      "b-bad-tag-1.md",
      "c-bad-property.md",
    ]);
    for (const entry of flagged.values()) {
      expect(entry.flag).toBe("refused");
      expect(entry.reason).toContain("validation_error");
    }
    expect(flagged.get("b-bad-tag-0.md")?.reason).toContain("tags[0]");
    expect(flagged.get("c-bad-property.md")?.reason).toContain("property name");
    for (const [name, text] of files)
      expect(readFileSync(join(f.dir, name), "utf8"), name).toBe(text);

    // Scanned again, they are named again and nothing else is made.
    const again = await f.folder.scan();
    expect(again.ok && again.value.created).toBe(0);
    expect(again.ok && again.value.flagged.length).toBe(3);

    // A corrected file is taken at the next scan.
    writeFileSync(
      join(f.dir, "b-bad-tag-0.md"),
      note("bad tag 0", "tags:\n  - fine\n"),
    );
    const fixed = await f.folder.scan();
    expect(fixed.ok && fixed.value.created).toBe(1);
  });

  it("queues nothing of an edit whose added tag is refused, and the edit once the tag is dropped", async () => {
    const f = await started();
    const path = join(f.dir, "held.md");
    const held = readFileSync(path, "utf8");
    expect(held.startsWith("---\n")).toBe(true);
    const before = await f.folder.device().queue();
    expect(before.ok).toBe(true);

    for (const [tag] of BAD_TAGS) {
      writeFileSync(
        path,
        held.replace("---\n", `---\ntags:\n  - ${JSON.stringify(tag)}\n`) +
          "an edited body\n",
        "utf8",
      );
      const scanned = await f.folder.scan();
      expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
      if (!scanned.ok) return;
      expect(scanned.value.flagged).toEqual([
        expect.objectContaining({ path: "held.md", flag: "refused" }),
      ]);
      expect(
        await f.folder.device().queue(),
        "the body edit was queued with a tag the server refuses",
      ).toEqual(before);
    }

    writeFileSync(path, held + "an edited body\n", "utf8");
    const taken = await f.folder.scan();
    expect(taken.ok && taken.value.updated).toBe(1);
    const queue = await f.folder.device().queue();
    expect(queue.ok && queue.value.map((write) => write.kind)).toContain(
      "update_item",
    );
  });
});

describe("a folder's file whose tags would leave its item more than 100", () => {
  const FULL = "01a00000-0000-7000-8000-00000000000c";
  const LATER = "01a00000-0000-7000-8000-00000000000d";
  const named = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`);
  const row = (id: string, title: string, tags: string[]) => ({
    item: {
      id,
      type: "core.note",
      properties: { title, body: `${title}\n` },
    },
    tags,
  });

  it("is flagged with its reason and queues nothing of it, while a swap on a full item and the files after it are saved", async () => {
    folder = await folderHarness("tag-count", {
      settings: { search: { types: ["core.note"] } },
      rows: {
        "core.note": [
          row(FULL, "full", named("f", 100)),
          row(ROW, "held", named("h", 60)),
          row(LATER, "later", []),
        ],
      },
    });
    const f = folder;
    expect((await f.folder.pull()).ok).toBe(true);
    const before = await f.folder.device().queue();
    expect(before.ok).toBe(true);

    const edit = (name: string, change: (text: string) => string) => {
      const path = join(f.dir, name);
      writeFileSync(path, change(readFileSync(path, "utf8")), "utf8");
    };
    const lines = (tags: string[]) =>
      tags.map((tag) => `  - ${tag}\n`).join("");
    edit("full.md", (text) => {
      expect(text).toContain("  - f0\n");
      return text.replace("  - f0\n", "  - swapped\n");
    });
    edit("held.md", (text) => {
      expect(text).toContain("tags:\n");
      return (
        text.replace("tags:\n", `tags:\n${lines(named("added", 50))}`) +
        "an edited body\n"
      );
    });
    edit("later.md", (text) => text + "an edited body\n");

    for (const pass of ["first", "again"]) {
      const scanned = await f.folder.scan();
      expect(scanned.ok, `${pass}: ${JSON.stringify(scanned)}`).toBe(true);
      if (!scanned.ok) return;
      expect(scanned.value.flagged).toEqual([
        expect.objectContaining({ path: "held.md", flag: "refused" }),
      ]);
      expect(scanned.value.flagged[0]?.reason).toContain("validation_error");
      expect(scanned.value.flagged[0]?.reason).toContain("100 tags");
    }

    const queue = await f.folder.device().queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok || !before.ok) return;
    const fresh = queue.value.slice(before.value.length);
    expect(
      fresh.filter((write) => write.item_id === ROW),
      "a write of the refused file was queued",
    ).toEqual([]);
    // The witnesses: the file sorting after it, and a swap on an item at
    // 100, are queued, the swap's removal ahead of its add.
    expect(
      fresh
        .filter((write) => write.item_id === LATER)
        .map((write) => write.kind),
    ).toEqual(["update_item"]);
    expect(
      fresh
        .filter((write) => write.item_id === FULL)
        .map((write) => [write.kind, write.tag]),
    ).toEqual([
      ["remove_tag", "f0"],
      ["add_tag", "swapped"],
    ]);

    // Dropping the added tags takes the edit.
    edit("held.md", (text) => text.replace(lines(named("added", 50)), ""));
    const taken = await f.folder.scan();
    expect(taken.ok && taken.value.flagged).toEqual([]);
    const after = await f.folder.device().queue();
    expect(
      after.ok &&
        after.value
          .slice(before.value.length)
          .filter((write) => write.item_id === ROW)
          .map((write) => write.kind),
    ).toEqual(["update_item"]);
  });
});

describe("a folder whose settings hold a default the server refuses", () => {
  it("stops where it is told, naming the setting, and runs with a default it takes", async () => {
    const refusedDefaults: Array<[FolderSettings, string]> = [
      [{ defaults: { tags: [""] } }, "defaults.tags"],
      [{ defaults: { tags: ["a".repeat(129)] } }, "defaults.tags"],
      [{ defaults: { properties: { "": 1 } } }, "defaults.properties"],
    ];
    for (const [settings, named] of refusedDefaults) {
      let refused = "";
      try {
        folder = await folderHarness("names-defaults", {
          settings: { search: { types: ["core.note"] }, ...settings },
        });
      } catch (error) {
        refused = String(error);
      }
      expect(
        refused,
        `a folder was added with ${named} the server refuses`,
      ).toContain(named);
      await folder?.stop().catch(() => undefined);
      folder = undefined;
    }
    // The witness: the same settings with defaults the server takes.
    folder = await folderHarness("names-defaults", {
      settings: {
        search: { types: ["core.note"] },
        defaults: { tags: ["a".repeat(128)], properties: { named: 1 } },
      },
    });
    writeFileSync(join(folder.dir, "new.md"), note("new", ""), "utf8");
    const scanned = await folder.folder.scan();
    expect(scanned.ok && scanned.value.created).toBe(1);
  });
});

describe("a folder whose saved filter compares with null", () => {
  it("says which setting, what is wrong with it and how to change it", async () => {
    let refused = "";
    try {
      folder = await folderHarness("names-filter", {
        settings: {
          search: {
            types: ["core.note"],
            filter: 'properties.a eq "x" OR properties.b eq null',
          },
        },
      });
    } catch (error) {
      refused = String(error);
    }
    expect(refused).toContain("search.filter");
    expect(refused).toContain("Null is not a value to compare with");
    expect(refused).toContain("marfa folders change");
    await folder?.stop().catch(() => undefined);
    folder = undefined;
  });
});
