/**
 * A database still holding the registry in `custom_types` is refused on
 * open, rather than opened beside an empty `types`.
 *
 * The schema is applied with `CREATE TABLE IF NOT EXISTS`, so a rename does
 * not move rows: without this refusal the open succeeds and every reader
 * sees an empty registry. That failure has no loud edge anywhere — a type
 * the instance registered answers `unknown_type`, the operator metric reads
 * zero, the consent screen offers no publisher root, and re-registering the
 * same identifier succeeds against the new table rather than conflicting —
 * which is why the check has to be on the open path and not in a reader.
 *
 * The last case is the one a careless probe fails: the refusal must not fire
 * on a database whose registry is where this build expects it.
 */
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "./connection.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-registry-"));
  dirs.push(dir);
  return join(dir, "marfa.db");
}

/** A database carrying the named tables and nothing else. */
async function seedTables(path: string, names: readonly string[]) {
  const seed = createClient({ url: `file:${path}` });
  for (const name of names) {
    await seed.execute(
      `CREATE TABLE ${name} (id TEXT PRIMARY KEY, schema TEXT NOT NULL)`,
    );
  }
  seed.close();
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("a retired registry table is refused on open", () => {
  it("refuses a database holding custom_types, naming the table and the file", async () => {
    const path = scratch();
    await seedTables(path, ["custom_types"]);

    await expect(createConnection(path)).rejects.toThrow(/custom_types/);
    await expect(createConnection(path)).rejects.toThrow(path);
  });

  it("names both tables when both are there", async () => {
    const path = scratch();
    await seedTables(path, ["custom_types", "custom_edge_types"]);

    await expect(createConnection(path)).rejects.toThrow(
      /custom_edge_types and custom_types/,
    );
  });

  it("refuses on custom_edge_types alone, which a types-only probe would miss", async () => {
    const path = scratch();
    await seedTables(path, ["custom_edge_types"]);

    await expect(createConnection(path)).rejects.toThrow(/custom_edge_types/);
  });

  it("leaves a refused database byte for byte as it found it", async () => {
    // Asserted on the bytes rather than on the absence of a `types` table,
    // because the first draft of this refusal ran after
    // `PRAGMA journal_mode = WAL` and so rewrote the file header of every
    // database it then refused. A table-shaped assertion passes through
    // that; a hash does not. A refused boot must change nothing, or a
    // second attempt meets a file the first one altered.
    const path = scratch();
    await seedTables(path, ["custom_types"]);
    const before = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");

    await expect(createConnection(path)).rejects.toThrow();

    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before,
    );
  });

  it("names a remedy it has not itself taken away", async () => {
    // The advice used to be "export with the previous build and load that
    // export here". The archive format moved with the registry rename, so
    // that export is a version 1 archive and the restore door refuses it:
    // the sentence named a recovery ending in a 400. It must not come back.
    const path = scratch();
    await seedTables(path, ["custom_types"]);

    await expect(createConnection(path)).rejects.not.toThrow(
      /load that export|into a fresh instance on this one/,
    );
    await expect(createConnection(path)).rejects.toThrow(
      /readable only by the build that wrote it/,
    );
  });

  it("refuses a database whose items table predates the occurred_at rename", async () => {
    // Not because it would be read wrongly — the DDL builds an index over
    // the new column, so an old file fails at that statement whatever this
    // check does. It is the shape of the failure that matters: without this
    // the operator gets a driver error naming an index, after the PRAGMAs
    // have already rewritten the file header.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE items (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL)",
    );
    seed.close();
    const before = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");

    await expect(createConnection(path)).rejects.toThrow(/no occurred_at/);
    await expect(createConnection(path)).rejects.toThrow(path);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before,
    );
  });

  it("refuses an audit_log that predates the created_at rename", async () => {
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE audit_log (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL)",
    );
    seed.close();

    await expect(createConnection(path)).rejects.toThrow(/no created_at/);
  });

  it("opens a fresh database, and one it has already opened", async () => {
    const path = scratch();
    const first = await createConnection(path);
    await first.close();
    const second = await createConnection(path);
    await second.close();
  });
});
