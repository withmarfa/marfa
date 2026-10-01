import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTypeSchema } from "@withmarfa/shared";
import { createSqliteStorage } from "./index.js";
import type { Storage } from "../interface.js";
import { forgetType } from "./item-links.js";

// `forgetType` runs inside the delete's transaction, after the row is gone,
// which makes it the place to look at the registry before the commit and to
// make the transaction fail after the registry has been told.
vi.mock("./item-links.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./item-links.js")>();
  return { ...original, forgetType: vi.fn(original.forgetType) };
});

describe("SqliteTypeStore.delete and the registry", () => {
  let tmpDir: string;
  let storage: Storage;
  const RUN = Math.random().toString(36).slice(2, 8);

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "marfa-type-delete-"));
    storage = await createSqliteStorage(join(tmpDir, "types.db"));
  });

  afterEach(async () => {
    vi.mocked(forgetType).mockRestore();
    await storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function register(suffix: string): Promise<string> {
    const id = `acme.store_del_${suffix}_${RUN}`;
    await storage.types.create({
      id,
      version: 1,
      fields: { name: { type: "string" } },
    });
    expect(getTypeSchema(id)).toBeDefined();
    return id;
  }

  it("takes the type out of the registry before its transaction commits", async () => {
    const id = await register("before_commit");
    const seen: unknown[] = [];
    const original = vi.mocked(forgetType).getMockImplementation();
    vi.mocked(forgetType).mockImplementationOnce(async (db, type) => {
      seen.push(getTypeSchema(type));
      await original?.(db, type);
    });

    await storage.types.delete(id);

    expect(seen).toEqual([undefined]);
    expect(getTypeSchema(id)).toBeUndefined();
  });

  it("puts the type back when the transaction fails after taking it out", async () => {
    const id = await register("rolled_back");
    vi.mocked(forgetType).mockImplementationOnce(() => {
      expect(getTypeSchema(id)).toBeUndefined();
      return Promise.reject(new Error("failed inside the delete"));
    });

    await expect(storage.types.delete(id)).rejects.toThrow(
      "failed inside the delete",
    );

    expect(getTypeSchema(id)).toBeDefined();
    expect((await storage.types.loadAll()).map((t) => t.schema.id)).toContain(
      id,
    );
  });
});
