import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FolderSettings } from "../../device/cli-adapter.js";
import {
  folderHarness,
  hashOf,
  scriptBlob,
  type FolderHarness,
} from "./harness.js";

let folder: FolderHarness | undefined;
afterEach(async () => {
  await folder?.stop();
  folder = undefined;
});

const id = (number: number) =>
  `01a00000-0000-7000-8000-${String(number).padStart(12, "0")}`;

describe("folder title names and retried pulls", () => {
  it("replaces separators and controls, trims hidden names, and names a dot-only title untitled", async () => {
    const titles = [
      "a/b\\c:d",
      "line\nnext\tend\u007f",
      " \n.hidden\r",
      "...",
      "Plain",
    ];
    const names = [
      "a-b-c-d.md",
      "line next end.md",
      "hidden.md",
      "untitled.md",
      "Plain.md",
    ];
    folder = await folderHarness("contract-c-names", {
      rows: {
        "core.note": titles.map((title, index) => ({
          item: { id: id(index), properties: { title, body: "kept body\n" } },
        })),
      },
    });
    const pulled = await folder.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect([pulled.value.written, pulled.value.unwritten]).toEqual([5, 0]);
    expect(
      readdirSync(folder.dir)
        .filter((name) => name !== ".marfa")
        .sort(),
    ).toEqual([...names].sort());
    names.forEach((name, index) => {
      const text = readFileSync(join(folder!.dir, name), "utf8");
      expect(text).toContain(`marfa_id: ${id(index)}`);
      expect(text).toContain("kept body");
    });
  });

  it("keeps a 32-byte extension whole and treats a longer ending as stem when fitting UTF-8 names", async () => {
    const bytes = Buffer.from("file bytes preserved\n");
    const stem = "日".repeat(100);
    const short = `.${"x".repeat(31)}`;
    const long = `.${"x".repeat(32)}`;
    folder = await folderHarness("contract-c-extensions", {
      settings: { search: { types: ["core.file"] } },
      rows: {
        "core.file": [short, long, ".png"].map((extension, index) => ({
          item: {
            id: id(index),
            type: "core.file",
            properties: {
              title: index === 2 ? "Plain.png" : `${stem}${extension}`,
              blob_ref: hashOf(bytes),
            },
          },
        })),
      },
    });
    scriptBlob(folder.server, bytes);
    const pulled = await folder.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect([pulled.value.written, pulled.value.unwritten]).toEqual([3, 0]);
    const names = [`${"日".repeat(74)}${short}`, "日".repeat(85), "Plain.png"];
    expect(
      readdirSync(folder.dir)
        .filter((name) => name !== ".marfa")
        .sort(),
    ).toEqual([...names].sort());
    for (const name of names) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
      expect(readFileSync(join(folder.dir, name))).toEqual(bytes);
    }
  });

  it("counts files and placements from before a restarted pull exactly once", async () => {
    folder = await folderHarness("contract-c-retry", {
      rows: {
        "core.note": ["first", "second"].map((title, index) => ({
          item: { id: id(index), properties: { title, body: "body\n" } },
        })),
      },
    });
    process.env.MARFA_TEST_FAULT = "copy-changes-during-pull=second";
    try {
      const pulled = await folder.folder.pull();
      expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
      if (!pulled.ok) return;
      expect([
        pulled.value.written,
        pulled.value.placed,
        pulled.value.unchanged,
      ]).toEqual([2, 2, 1]);
      const queued = await folder.folder.device().queue();
      expect(
        queued.ok &&
          queued.value.filter((write) => write.kind === "create_edge"),
      ).toHaveLength(2);
    } finally {
      delete process.env.MARFA_TEST_FAULT;
    }
    const next = await folder.folder.pull();
    expect(
      next.ok && [next.value.written, next.value.placed, next.value.unchanged],
    ).toEqual([0, 0, 2]);
  });

  it("retries a changed copy three times in total and succeeds on the third stable read", async () => {
    folder = await folderHarness("contract-c-attempts", {
      rows: {
        "core.note": [
          {
            item: {
              id: id(1),
              properties: { title: "Stable", body: "body\n" },
            },
          },
        ],
      },
    });
    process.env.MARFA_TEST_FAULT = "copy-changes-during-pull=thrice";
    try {
      const stopped = await folder.folder.pull();
      expect(stopped.ok).toBe(false);
      if (stopped.ok) return;
      expect(stopped.refusal.raw).toContain("local_copy_changed");
      expect(
        readdirSync(folder.dir).filter((name) => name !== ".marfa"),
      ).toEqual([]);
      process.env.MARFA_TEST_FAULT = "copy-changes-during-pull=twice";
      const finished = await folder.folder.pull();
      expect(finished.ok, JSON.stringify(finished)).toBe(true);
      expect(finished.ok && finished.value.written).toBe(1);
      expect(readFileSync(join(folder.dir, "Stable.md"), "utf8")).toContain(
        "body",
      );
    } finally {
      delete process.env.MARFA_TEST_FAULT;
    }
  });

  it("names each refused default and explains how to change it", async () => {
    const refused: [FolderSettings["defaults"], string, string][] = [
      [{ tags: [""] }, "defaults.tags", "tag"],
      [{ tags: ["a".repeat(129)] }, "defaults.tags", "128"],
      [{ properties: { "": 1 } }, "defaults.properties", "property name"],
    ];
    for (const [defaults, setting, reason] of refused) {
      await expect(
        folderHarness("contract-c-settings", {
          settings: {
            search: { types: ["core.note"] },
            defaults,
          },
        }),
      ).rejects.toThrow(
        new RegExp(`${setting}.*${reason}.*marfa folders change`),
      );
    }
    folder = await folderHarness("contract-c-good-settings", {
      settings: {
        search: { types: ["core.note"] },
        defaults: { tags: ["allowed"] },
      },
    });
    expect((await folder.folder.pull()).ok).toBe(true);
  });
});
