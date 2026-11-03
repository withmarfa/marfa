import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { folderHarness } from "./harness.js";
import type { FolderHarness } from "./harness.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import { put, scriptFolderWrites, sentTitles } from "./folders.shared.js";

/**
 * "A folder can hold new files its query would not hold": with
 * `outside_query` set to `hold`, a new file whose item the query would not
 * hold is left on the disk, unsent and without an item, until it matches or
 * the setting is `send`.
 */

const made: FolderHarness[] = [];

afterEach(async () => {
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

const holding: FolderSettings = {
  query: { types: ["core.note"], state: ["active"] },
  defaults: { type: "core.note" },
  outside_query: "hold",
};

const note = (title: string, state: "active" | "archived" = "active"): string =>
  `---\ntitle: ${title}\nstate: ${state}\n---\nbody\n`;

/** An empty folder past its first sync. */
async function prepared(
  label: string,
  settings: FolderSettings,
): Promise<FolderHarness> {
  const harness = await folderHarness(label, { settings });
  made.push(harness);
  scriptFolderWrites(harness);
  expect((await harness.folder.push()).ok).toBe(true);
  return harness;
}

async function pushed(harness: FolderHarness) {
  const result = await harness.folder.push();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("push refused");
  return result.value;
}

async function change(
  harness: FolderHarness,
  settings: FolderSettings,
): Promise<void> {
  harness.settings.settings = settings;
  harness.settings.version += 1;
  expect((await harness.folder.hydrate()).ok).toBe(true);
}

describe("a new file outside the query", () => {
  it("is sent, as it always was, unless the folder holds it", async () => {
    const harness = await prepared("outside-query-default", {
      ...holding,
      outside_query: undefined,
    });
    put(harness, "out.md", note("Out", "archived"));
    const value = await pushed(harness);
    expect(value.scan.held_outside).toBe(0);
    expect(sentTitles(harness)).toEqual(["Out"]);

    const explicit = await prepared("outside-query-send", {
      ...holding,
      outside_query: "send",
    });
    put(explicit, "out.md", note("Out", "archived"));
    expect((await pushed(explicit)).scan.held_outside).toBe(0);
    expect(sentTitles(explicit)).toEqual(["Out"]);
  });

  it("is held unsent and unwritten, shown in status and listed as unmatched", async () => {
    const harness = await prepared("outside-query-held", holding);
    put(harness, "in.md", note("In"));
    const path = put(harness, "out.md", note("Out", "archived"));
    const before = readFileSync(path, "utf8");

    const value = await pushed(harness);
    expect(value.scan.held_outside).toBe(1);
    expect(value.scan.paused_additions).toBe(0);
    expect(sentTitles(harness)).toEqual(["In"]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(before).not.toContain("marfa_id");

    const status = await harness.folder.status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.paused.outside_query).toBe(1);
    expect(status.value.paused.additions).toBe(0);
    const files = status.value.files.filter((file) => file.path === "out.md");
    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe("held");
    expect(files[0]?.flag).toBe("outside_query");
    expect(files[0]?.item_id).toBeUndefined();

    const listed = await harness.folder.unmatched();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.unmatched).toHaveLength(1);
    expect(listed.value.unmatched[0]?.path).toBe("out.md");
    expect(listed.value.unmatched[0]?.item_id).toBeUndefined();
    expect(listed.value.unmatched[0]?.held).toContain("outside_query");

    const said = await harness.folder.pushText();
    expect(said.ok && said.value).toContain("held outside the query");
    expect(said.ok && said.value).not.toContain("a large addition waits");
  });

  it("is sent once its content matches the query", async () => {
    const harness = await prepared("outside-query-edit", holding);
    put(harness, "out.md", note("Out", "archived"));
    expect((await pushed(harness)).scan.held_outside).toBe(1);
    expect(sentTitles(harness)).toEqual([]);

    put(harness, "out.md", note("Out", "active"));
    const value = await pushed(harness);
    expect(value.scan.held_outside).toBe(0);
    expect(sentTitles(harness)).toEqual(["Out"]);
  });

  it("is sent once the folder's setting goes back to send", async () => {
    const harness = await prepared("outside-query-released", holding);
    put(harness, "out.md", note("Out", "archived"));
    expect((await pushed(harness)).scan.held_outside).toBe(1);

    await change(harness, { ...holding, outside_query: "send" });
    const value = await pushed(harness);
    expect(value.scan.held_outside).toBe(0);
    expect(sentTitles(harness)).toEqual(["Out"]);
  });

  it("is not counted towards the addition threshold", async () => {
    const harness = await prepared("outside-query-threshold", {
      ...holding,
      addition_threshold: { files: 2, fraction: 0.25 },
    });
    for (let n = 0; n < 3; n += 1)
      put(harness, `out-${String(n)}.md`, note(`Out ${String(n)}`, "archived"));
    put(harness, "in-0.md", note("In 0"));
    put(harness, "in-1.md", note("In 1"));
    const value = await pushed(harness);
    expect(value.scan.held_outside).toBe(3);
    expect(value.scan.paused_additions).toBe(0);
    expect(sentTitles(harness).sort()).toEqual(["In 0", "In 1"]);
  });
});
