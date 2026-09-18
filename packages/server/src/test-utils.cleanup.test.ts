/**
 * The test harness's own temp-directory lifetime.
 *
 * `createTestContext` mints a directory per context for the sqlite database
 * and the blob root. Nothing else removes it, and it is created before the
 * closure that removes it exists, so both the success path and the failure
 * path need their own guarantee. Left ungoverned this leaked one directory
 * per context and filled a disk.
 */

import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

describe("test-context temp directory", () => {
  it("removes its directory when cleanup runs", async () => {
    const { createTestContext } = await import("./test-utils.js");
    const ctx = await createTestContext();

    expect(existsSync(ctx.tmpDir)).toBe(true);
    await ctx.cleanup();
    expect(existsSync(ctx.tmpDir)).toBe(false);
  });

  it("removes its directory when the build throws before returning one", async () => {
    // The directory is minted first and the cleanup closure is only handed
    // back on success, so a throw in between leaves nothing holding a
    // reference to it.
    vi.resetModules();
    const boom = new Error("storage unavailable");
    vi.doMock("./storage/sqlite/index.js", () => ({
      createSqliteStorage: () => {
        throw boom;
      },
    }));

    const created: string[] = [];
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...realFs,
      mkdtempSync: (prefix: string) => {
        const dir = realFs.mkdtempSync(prefix);
        created.push(dir);
        return dir;
      },
    }));

    try {
      const { createTestContext } = await import("./test-utils.js");
      await expect(createTestContext()).rejects.toThrow(boom);

      expect(created).toHaveLength(1);
      expect(existsSync(created[0]!)).toBe(false);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("./storage/sqlite/index.js");
      vi.resetModules();
      for (const dir of created) {
        realFs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
