/**
 * The database refuses a space-less credential that holds something.
 *
 * The one model has two halves about the instance tier. The first, that a
 * space-less credential is the operator key and nothing else, has been a
 * `CHECK` since the keys-mode space landed. The second, that running the
 * instance is not a permission and so the tier that runs it holds none, was
 * enforced at two doors and cleared once by a migration -- and that asymmetry
 * is what let the second half be violated in the first place: a rule with no
 * structural form was a property of how the operator key happened to be
 * minted, and two doors wrote past it for months.
 *
 * So the assertion here is the refusal itself, driven at the database rather
 * than through a route. A door can be added without reading the doors that
 * came before it; it cannot be added without meeting this.
 *
 * Both directions, because a constraint that refuses everything is as wrong as
 * one that refuses nothing: the empty space-less row and the wide space-bound
 * row both have to survive it.
 *
 * Both dialects, because both carry it. The Postgres half needs a database it
 * can create, so it skips where the suite was not given one.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { runSqliteMigrations } from "./migrate.js";

const NOW = "2026-01-02T03:04:05.000Z";
const WIDE = '{"*":"write"}';
const CONSTRAINT = "api_keys_space_less_holds_nothing";

/** The six columns the constraint reads, and the value each holds on a
 *  credential that holds nothing. */
const EMPTY = {
  type_permissions: "{}",
  edge_permissions: "{}",
  metadata_permissions: "{}",
  extension_permissions: "{}",
  profile_permissions: "{}",
  space_permissions: "[]",
};

/**
 * One over-full column per case. Each is asserted on its own rather than in a
 * single row holding all six, because a constraint naming five of them would
 * pass a combined case and leave one family reachable.
 */
const OVER_FULL: [keyof typeof EMPTY, string][] = [
  ["type_permissions", WIDE],
  ["edge_permissions", WIDE],
  ["metadata_permissions", WIDE],
  ["extension_permissions", WIDE],
  ["profile_permissions", WIDE],
  ["space_permissions", '["space.keys"]'],
];

type PermissionColumn = keyof typeof EMPTY;

/**
 * Every column an insert names, and the `?` list that goes with it, built from
 * one source so a seventh permission column cannot land in one and not the
 * other. Hand-counting the placeholders is how a widened `EMPTY` turns into a
 * silently narrower insert.
 */
const COLUMNS = Object.keys(EMPTY) as PermissionColumn[];
const IDENTITY_COLUMNS = [
  "id",
  "space_id",
  "key_hash",
  "label",
  "source",
  "is_operator",
  "created_at",
];
const INSERT_COLUMNS = [...IDENTITY_COLUMNS, ...COLUMNS];
const PLACEHOLDERS = INSERT_COLUMNS.map(() => "?").join(", ");

/** The six permission values a case writes: empty everywhere, over-full at
 *  the one column the case is driving. */
function valuesFor(
  over?: [PermissionColumn, string],
): Record<PermissionColumn, string> {
  const values = { ...EMPTY };
  if (over) values[over[0]] = over[1];
  return values;
}

describe("the SQLite space-less-holds-nothing constraint", () => {
  const workDir = mkdtempSync(join(tmpdir(), "marfa-spaceless-check-"));
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("refuses a space-less row carrying a permission, and admits the two shapes that are legal", async () => {
    const dbPath = join(workDir, "constraint.db");
    await runSqliteMigrations(dbPath);
    const client = createClient({ url: `file:${dbPath}` });

    await client.execute({
      sql: `INSERT INTO spaces (id, name, created_at) VALUES ('space-a', 'A', ?)`,
      args: [NOW],
    });

    const insert = (
      id: string,
      spaceId: string | null,
      isOperator: 0 | 1,
      over?: [PermissionColumn, string],
    ) => {
      const permissions = valuesFor(over);
      return client.execute({
        sql: `INSERT INTO api_keys (${INSERT_COLUMNS.join(", ")})
              VALUES (${PLACEHOLDERS})`,
        args: [
          id,
          spaceId,
          `hash-${id}`,
          id,
          id,
          isOperator,
          NOW,
          ...COLUMNS.map((column) => permissions[column]),
        ],
      });
    };

    for (const over of OVER_FULL) {
      await expect(
        insert(`over-${over[0]}`, null, 1, over),
        over[0],
      ).rejects.toThrow(new RegExp(CONSTRAINT));
    }

    // The operator key itself: space-less and holding nothing.
    await insert("operator", null, 1);
    // A working credential: bound to a space, holding everything in it.
    await insert("working", "space-a", 0, ["type_permissions", WIDE]);

    const rows = await client.execute(`SELECT id FROM api_keys ORDER BY id`);
    expect(rows.rows.map((r) => r.id)).toEqual(["operator", "working"]);

    // The widening `PATCH /keys/{id}` used to perform, which is the shape the
    // migration cleared and nothing structural refused.
    await expect(
      client.execute({
        sql: `UPDATE api_keys SET type_permissions = ? WHERE id = 'operator'`,
        args: [WIDE],
      }),
    ).rejects.toThrow(new RegExp(CONSTRAINT));
  });
});
