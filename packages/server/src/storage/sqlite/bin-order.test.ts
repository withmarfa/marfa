/**
 * A listing of the bin alone that names no sort is ordered by when each row
 * went there (`search-and-filters/bin-order`), and a row an archive restored
 * to the bin without that time stands at its `updated_at`. The rows are
 * created in the opposite order to the one they were binned in, and two tie
 * on the time, so a listing still ordered by creation or by the column alone
 * answers a different sequence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import type { ItemFilters } from "../interface.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;

interface Row {
  id: string;
  state: string;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
}

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const ROWS: Row[] = [
  {
    id: "a",
    state: "trashed",
    created_at: at(6),
    updated_at: at(10),
    trashed_at: at(10),
  },
  {
    id: "b",
    state: "trashed",
    created_at: at(5),
    updated_at: at(30),
    trashed_at: at(11),
  },
  // Restored from an archive without the time it went to the bin.
  {
    id: "c",
    state: "trashed",
    created_at: at(4),
    updated_at: at(12),
    trashed_at: null,
  },
  {
    id: "d",
    state: "trashed",
    created_at: at(3),
    updated_at: at(13),
    trashed_at: at(13),
  },
  {
    id: "e",
    state: "trashed",
    created_at: at(2),
    updated_at: at(13),
    trashed_at: at(13),
  },
  {
    id: "f",
    state: "trashed",
    created_at: at(1),
    updated_at: at(14),
    trashed_at: null,
  },
  {
    id: "live",
    state: "active",
    created_at: at(0),
    updated_at: at(20),
    trashed_at: null,
  },
];

let directory: string;
let storage: Storage;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-bin-order-"));
  storage = await createSqliteStorage(join(directory, "test.db"));
  for (const row of ROWS) {
    await storage.__sqliteRun(
      `INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, trashed_at, version)
       VALUES (?, 'core.note', ?, 'library', jsonb('{}'), ?, ?, ?, ?, 1)`,
      [
        row.id,
        row.state,
        row.created_at,
        row.updated_at,
        row.created_at,
        row.trashed_at,
      ],
    );
  }
});

afterAll(async () => {
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

async function walk(filters: ItemFilters, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await storage.items.list({ ...filters, limit, cursor });
    ids.push(...page.data.map((item) => item.id));
    if (page.next_cursor === null) return ids;
    cursor = page.next_cursor;
  }
  throw new Error("a listing never ended");
}

describe("the order of the bin", () => {
  // f at 14 (its updated_at), d and e tie at 13 and fall to the id, c at 12
  // (its updated_at), b at 11 whatever its later write, a at 10.
  const NEWEST = ["f", "e", "d", "c", "b", "a"];

  for (const limit of [1, 2, 100]) {
    it(`is newest binned first, ${String(limit)} at a time`, async () => {
      expect(await walk({ states: ["trashed"] }, limit)).toEqual(NEWEST);
    });

    it(`is oldest binned first with direction asc, ${String(limit)} at a time`, async () => {
      expect(
        await walk({ states: ["trashed"], direction: "asc" }, limit),
      ).toEqual(["a", "b", "c", "d", "e", "f"]);
    });
  }

  it("carries the time on each row, and null where none was kept", async () => {
    const page = await storage.items.list({ states: ["trashed"], limit: 100 });
    expect(
      Object.fromEntries(page.data.map((item) => [item.id, item.trashed_at])),
    ).toEqual(
      Object.fromEntries(
        ROWS.filter((row) => row.state === "trashed").map((row) => [
          row.id,
          row.trashed_at,
        ]),
      ),
    );
  });

  it("follows a named sort instead", async () => {
    expect(await walk({ states: ["trashed"], sort: "created_at" }, 2)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  it("orders a listing of more than the bin by creation", async () => {
    expect(await walk({ states: ["trashed", "active"] }, 2)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "live",
    ]);
    expect(await walk({ all_states: true }, 100)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "live",
    ]);
  });

  it("refuses a cursor from the bin's order on a listing in another", async () => {
    const page = await storage.items.list({ states: ["trashed"], limit: 1 });
    expect(page.next_cursor).not.toBe(null);
    await expect(
      storage.items.list({
        states: ["trashed"],
        sort: "created_at",
        limit: 1,
        cursor: page.next_cursor ?? undefined,
      }),
    ).rejects.toThrow();
  });
});
