/**
 * The tag facet's type scoping, asserted at the store rather than through
 * the route: `GET /metadata/tags` refuses a credential with no readable type
 * before it reaches `listTags`, so only a test here holds the store's own
 * reading of an empty allow-list.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import type { Storage } from "../interface.js";

let tmpDir: string | undefined;
let storage: Storage | undefined;

async function tagged(): Promise<Storage> {
  tmpDir = mkdtempSync(join(tmpdir(), "marfa-metadata-"));
  storage = await createSqliteStorage(join(tmpDir, "marfa.db"));
  const note = await storage.items.create({
    type: "core.note",
    properties: { body: "a note" },
  });
  const task = await storage.items.create({
    type: "core.task",
    properties: { title: "a task" },
  });
  await storage.metadata.set(note.id, ["on-a-note"]);
  await storage.metadata.set(task.id, ["on-a-task"]);
  return storage;
}

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("SqliteMetadataStore.listTags", () => {
  it("reads an empty allow-list as no readable type, not as no restriction", async () => {
    const store = (await tagged()).metadata;
    // The witness: the tags exist and a list naming a type answers its own.
    expect(await store.listTags({ allowedTypes: ["core.note"] })).toEqual([
      { tag: "on-a-note", count: 1 },
    ]);
    expect(await store.listTags({ allowedTypes: [] })).toEqual([]);
  });
});
