import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./open.js";
import { resolveLocalMigrationsFolder } from "./migrations-folder.js";

const dirs: string[] = [];

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-local-open-"));
  dirs.push(dir);
  return join(dir, "store.db");
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("the local store's database", () => {
  it("runs in WAL", async () => {
    // libsql opens a file-backed database in `delete` journal mode, so the
    // engine has to ask for WAL rather than assume it. Without it the reader
    // the projection uses is locked out for the length of every write.
    const opened = await openDatabase(storePath());
    try {
      const result = await opened.raw.execute("PRAGMA journal_mode");
      expect(result.rows[0]?.journal_mode).toBe("wal");
    } finally {
      opened.close();
    }
  });

  it("migrates forward on open, and opening again changes nothing", async () => {
    const path = storePath();

    const first = await openDatabase(path);
    const applied = await first.raw.execute(
      "SELECT hash FROM __drizzle_migrations ORDER BY id",
    );
    first.close();

    const second = await openDatabase(path);
    try {
      const again = await second.raw.execute(
        "SELECT hash FROM __drizzle_migrations ORDER BY id",
      );
      expect(again.rows.map((r) => r.hash)).toEqual(
        applied.rows.map((r) => r.hash),
      );
      expect(again.rows.length).toBeGreaterThan(0);
    } finally {
      second.close();
    }
  });

  it("finds the migrations folder from the module that asks for it", () => {
    // The engine ships its migrations as files, so a build that drops them
    // leaves a store nobody can open. This is what notices.
    expect(resolveLocalMigrationsFolder(import.meta.url)).toMatch(
      /drizzle\/local$/,
    );
  });
});
