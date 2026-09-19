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
      "CREATE TABLE items (id TEXT PRIMARY KEY, source_id TEXT, timestamp TEXT NOT NULL)",
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
      "CREATE TABLE audit_log (id TEXT PRIMARY KEY, resource_type TEXT, timestamp TEXT NOT NULL)",
    );
    seed.close();

    await expect(createConnection(path)).rejects.toThrow(/no created_at/);
  });

  it("refuses an api_keys that predates the permissions rename", async () => {
    // The column no index is built over, which is why it has to be named
    // explicitly: the DDL passes against an old table, the boot succeeds,
    // and the first authenticated request throws out of the bearer
    // middleware. A refusal that only covered indexed columns would let this
    // through as a 500 per request after a silent start.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE api_keys (id TEXT PRIMARY KEY, is_operator INTEGER, space_permissions TEXT NOT NULL)",
    );
    seed.close();

    await expect(createConnection(path)).rejects.toThrow(/no permissions/);
    await expect(createConnection(path)).rejects.toThrow(path);
  });

  it("refuses a types table that predates the owner_connector rename", async () => {
    // The second unindexed column, and it fails later than the api_keys one
    // rather than louder. `idx_types_origin` is the only index on this
    // table, so the DDL passes against a file still carrying
    // `owner_integration`; the boot then reads the registry with a select
    // that names every column, and the open dies on `no such column`
    // after the PRAGMAs have already rewritten the header.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE types (id TEXT PRIMARY KEY, origin TEXT, owner_integration TEXT)",
    );
    seed.close();
    const before = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");

    await expect(createConnection(path)).rejects.toThrow(/no owner_connector/);
    await expect(createConnection(path)).rejects.toThrow(path);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before,
    );
  });

  it("refuses a blobs table that predates the size_bytes rename", async () => {
    // The third unindexed column, and the quietest read of the three. Nothing
    // indexes it, so the DDL passes against a file still carrying `size`, and
    // the columns a sweep selects — `hash`, `created_at` — are both still
    // there. What dies is every door that reads a blob's row: upload,
    // download, the archive export, the enrichment sweep, and `GET /metrics`,
    // whose blob counter sums this very column. Items keep reading, so a boot
    // that said nothing was wrong is followed by an instance whose files have
    // all become unreachable and whose health surface answers 500.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE blobs (hash TEXT PRIMARY KEY, storage_path TEXT, size INTEGER NOT NULL)",
    );
    seed.close();
    const before = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");

    await expect(createConnection(path)).rejects.toThrow(/no size_bytes/);
    await expect(createConnection(path)).rejects.toThrow(path);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before,
    );
  });

  it("refuses an outbound_webhook_deliveries table that predates the event_type rename", async () => {
    // The fourth unindexed column, and it is quiet in a way the others are
    // not: the failure is confined to one feature. Both indexes on this
    // table are over `webhook_id` and `next_attempt_at`, which an older file
    // still has, so the DDL passes and the boot says nothing. Items, edges,
    // search and the event stream all keep working. What stops is every
    // outbound webhook: the scheduler's insert names `event_type`, so no
    // delivery is ever queued, `GET /webhooks/{id}/deliveries` answers 500,
    // and the poller throws on its own schedule for as long as the process
    // runs. A subscription that receives nothing is exactly the failure the
    // wildcard refusal exists to prevent, arriving by another door.
    //
    // `webhook_secret` is the witness: this build keeps the signing secret
    // on the delivery row so a worker can sign without joining back to the
    // subscription, which a table of this name written by anything else
    // would not.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE outbound_webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, event TEXT NOT NULL, webhook_secret TEXT)",
    );
    seed.close();
    const before = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");

    await expect(createConnection(path)).rejects.toThrow(/no event_type/);
    await expect(createConnection(path)).rejects.toThrow(path);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before,
    );
  });

  it("refuses settings still keyed to the retired config name", async () => {
    // The quietest of the three. Nothing fails: the table and the column are
    // both there, the read finds no row and answers an empty object, and the
    // operator's enforcement levers and retention overrides are replaced by
    // this build's defaults with nothing in the log. An instance keeping
    // records longer than the default would start deleting them on the first
    // sweep after the upgrade.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    await seed.execute(
      "INSERT INTO settings (key, value) VALUES ('space_config', '{\"trash_retention_days\":90}')",
    );
    seed.close();

    const before = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
    await expect(createConnection(path)).rejects.toThrow(/space_config/);
    await expect(createConnection(path)).rejects.toThrow(path);
    // Asserted on the bytes here as well as on the retired-table case,
    // because this check is the one most easily moved: it reads no PRAGMA
    // and so looks placeable anywhere. Below `journal_mode = WAL` it would
    // still refuse, still name the key, and still pass every other
    // assertion in this file — while handing back a database a refused boot
    // had rewritten.
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before,
    );
  });

  it("does not die on a settings table of another shape", async () => {
    // The probe asks `PRAGMA table_info` for the column it needs rather than
    // naming it in the SELECT. Naming it answers a foreign `settings` table
    // with libsql's own `no such column: key` — no file, no remedy, and an
    // open client never closed — which is the failure this whole block
    // exists to replace with one sentence.
    //
    // Recognizing a stranger's schema is not this check's job, so the right
    // answer here is to say nothing and move on. Whether such a database is
    // usable afterwards is a different question and not one a check for a
    // retired key of our own should be answering.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    seed.close();

    const opened = await createConnection(path);
    await opened.close();
  });

  it("opens a database whose settings hold something else entirely", async () => {
    // The control. A settings table is ordinary and most rows in it are not
    // this one; refusing on the table's existence rather than on the key
    // would refuse every database that has ever been booted.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    await seed.execute(
      "INSERT INTO settings (key, value) VALUES ('bootstrap_done', 'true')",
    );
    seed.close();

    const opened = await createConnection(path);
    await opened.close();
  });

  it("opens a database carrying the retired provenance prefix", async () => {
    // Deliberately not refused, and the reason is worth the test.
    //
    // A refusal keyed on this prefix stood here briefly. It was reachable
    // through the API: `POST /keys` accepts a caller-chosen `source`, so one
    // request could stamp a row that the next boot refused, permanently, with
    // the refusal advising the operator to discard the database. Every other
    // check in this file refuses a shape no request can create.
    //
    // What the prefix costs instead is bounded: mirror protection knows one
    // spelling, so a row an older build stamped is an ordinary row. There is
    // no corpus of them — the estate is torn down and every database here is
    // test data — which is why that is the cheaper of the two failures.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE api_keys (id TEXT PRIMARY KEY, source TEXT NOT NULL, permissions TEXT)",
    );
    await seed.execute(
      "INSERT INTO api_keys (id, source, permissions) VALUES ('k1', 'integration:acme/thing', '[]')",
    );
    seed.close();

    await expect(createConnection(path)).rejects.not.toThrow(/integration:/);
  });

  it("opens a stranger's table that happens to share a name", async () => {
    // `blobs` is a name anything might use, so the table alone is not
    // evidence the file is one of ours. Each entry names a witness column
    // this build's table has and an unrelated one would not, and concludes
    // nothing without it. Refusing a foreign database with advice about a
    // build that never wrote it is worse than opening it — the sibling
    // `settings` probe reached the same answer from the other direction.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)",
    );
    seed.close();

    const opened = await createConnection(path);
    await opened.close();
  });

  it("opens a fresh database, and one it has already opened", async () => {
    const path = scratch();
    const first = await createConnection(path);
    await first.close();
    const second = await createConnection(path);
    await second.close();
  });
});
