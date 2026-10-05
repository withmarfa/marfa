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
