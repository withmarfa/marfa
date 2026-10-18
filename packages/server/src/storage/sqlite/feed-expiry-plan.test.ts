/**
 * The feed-expiry job reads one type's oldest active feed items from the
 * partial index made for it, in the order its cursor walks, without sorting.
 * The plans are read from the statements the store really sends, on a store
 * where most items are of another type, tier or state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
} from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;

const FEED = 3_000;
const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-06-01T00:00:00.000Z";

let directory: string;
let storage: Storage;
let reader: Client;
let sent: { sql: string; args: InArgs }[] | null = null;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-feed-expiry-plan-"));
  const path = join(directory, "test.db");
  storage = await createSqliteStorage(path);
  const insert = (type: string, state: string, tier: string, at: string) =>
    storage.__sqliteRun(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
       SELECT ? || i, ?, ?, ?, jsonb('{}'), ?, ?, ?, 1 FROM n`,
      [FEED, `${type}-${state}-${tier}-${at}-`, type, state, tier, at, at, at],
    );
  await insert("user.feed", "active", "feed", OLD);
  await insert("user.feed", "active", "library", OLD);
  await insert("user.feed", "archived", "feed", OLD);
  await insert("user.other", "active", "feed", OLD);
  await insert("user.feed", "active", "feed", NEW);
  reader = createClient({ url: `file:${path}` });
  const driver = Object.getPrototypeOf(createClient({ url: ":memory:" })) as {
    execute: (
      this: Client,
      statement: InStatement | string,
      args?: InArgs,
    ) => Promise<ResultSet>;
  };
  const execute = driver.execute;
  vi.spyOn(driver, "execute").mockImplementation(function (
    this: Client,
    statement,
    args,
  ) {
    if (sent) {
      sent.push(
        typeof statement === "string"
          ? { sql: statement, args: args ?? [] }
          : { sql: statement.sql, args: statement.args ?? [] },
      );
    }
    return execute.call(this, statement, args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  sent = null;
  reader.close();
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

async function planOf(call: () => Promise<unknown>): Promise<string> {
  sent = [];
  await call();
  const statements = sent.filter(({ sql }) =>
    /from\s+["`]?items["`]?[\s,]/i.test(sql),
  );
  sent = null;
  expect(statements).toHaveLength(1);
  const { sql, args } = statements[0]!;
  const rows = await reader.execute({
    sql: `EXPLAIN QUERY PLAN ${sql}`,
    args,
  });
  return rows.rows.map((row) => row.detail as string).join(" | ");
}

describe("listing the expired feed items of a type", () => {
  const cutoff = "2026-03-01T00:00:00.000Z";

  it("finds only the active feed items of the type that arrived before the cutoff", async () => {
    const page = await storage.items.listExpiredFeed(
      "user.feed",
      cutoff,
      undefined,
      5_000,
    );
    expect(page).toHaveLength(FEED);
    expect(page.every((row) => row.created_at === OLD)).toBe(true);
    // The witness: each row the other fixtures hold is there to be found
    // under a looser question.
    const rows = await storage.__sqliteAll(
      "SELECT count(*) AS n FROM items WHERE type = 'user.feed' AND created_at < '2026-03-01T00:00:00.000Z'",
    );
    expect((rows[0] as { n: number }).n).toBe(3 * FEED);
  });

  it("walks in (created_at, id) order and resumes after the last row it gave", async () => {
    const first = await storage.items.listExpiredFeed(
      "user.feed",
      cutoff,
      undefined,
      100,
    );
    const second = await storage.items.listExpiredFeed(
      "user.feed",
      cutoff,
      first.at(-1),
      100,
    );
    const ordered = [...first, ...second].map((row) => row.id);
    expect(ordered).toEqual([...ordered].sort());
    expect(new Set(ordered).size).toBe(200);
  });

  it("searches the partial index and sorts nothing", async () => {
    const plan = await planOf(() =>
      storage.items.listExpiredFeed("user.feed", cutoff, undefined, 100),
    );
    expect(plan).toMatch(
      /SEARCH \w+ USING (COVERING )?INDEX idx_items_feed_expiry/,
    );
    expect(plan).not.toMatch(/TEMP B-TREE/);
    expect(plan).not.toMatch(/SCAN/);
  });

  it("falls back to sorting when the index is removed", async () => {
    // The witness for the plan above: without the index the same question
    // sorts or scans.
    await storage.__sqliteRun("DROP INDEX idx_items_feed_expiry", []);
    reader.close();
    const path = join(directory, "test.db");
    reader = createClient({ url: `file:${path}` });
    const plan = await planOf(() =>
      storage.items.listExpiredFeed("user.feed", cutoff, undefined, 100),
    );
    expect(plan).not.toMatch(/idx_items_feed_expiry/);
    expect(plan).toMatch(/TEMP B-TREE|SCAN/);
  });
});
