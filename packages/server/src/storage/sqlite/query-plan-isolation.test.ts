import { afterEach, beforeEach, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";

let directory: string;
let storage: Awaited<ReturnType<typeof createSqliteStorage>>;
let independent: Client;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-query-plan-"));
  const path = join(directory, "test.db");
  storage = await createSqliteStorage(path);
  independent = createClient({ url: `file:${path}` });
  await storage.__sqliteRun("INSERT INTO settings(key,value) VALUES (?,?)", [
    "plan_fixture",
    "before",
  ]);
});
afterEach(async () => {
  independent.close();
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

it.each(["EXPLAIN QUERY PLAN", "EXPLAIN"])(
  "keeps normal readers current after %s of a write",
  async (prefix) => {
    const plan = await storage.__sqliteAll(
      `${prefix} DELETE FROM settings WHERE key = 'plan_fixture'`,
    );
    expect(plan.length).toBeGreaterThan(0);
    // A read between inspection and another connection's commit exposed the
    // native retained statement's stale implicit snapshot.
    expect(await storage.settings.get("plan_fixture")).toBe("before");
    await storage.runInTransaction(() =>
      storage.settings.set("plan_fixture", "committed"),
    );
    const witness = await independent.execute(
      "SELECT value FROM settings WHERE key = 'plan_fixture'",
    );
    expect(witness.rows[0]?.value).toBe("committed");
    expect(await storage.settings.get("plan_fixture")).toBe("committed");
    expect(
      await storage.__sqliteAll(
        "SELECT value FROM settings WHERE key = 'plan_fixture'",
      ),
    ).toEqual([{ value: "committed" }]);
    // Inspection only explains DELETE: it must never remove the target row.
    expect(await storage.settings.get("plan_fixture")).not.toBeNull();
  },
);

it("closes a refused inspection without changing subsequent writes or reads", async () => {
  await expect(
    storage.__sqliteAll("EXPLAIN QUERY PLAN DELETE FROM missing_fixture"),
  ).rejects.toThrow();
  await storage.runInTransaction(() =>
    storage.settings.set("plan_fixture", "after refusal"),
  );
  expect(await storage.settings.get("plan_fixture")).toBe("after refusal");
  expect(
    (
      await independent.execute(
        "SELECT value FROM settings WHERE key = 'plan_fixture'",
      )
    ).rows[0]?.value,
  ).toBe("after refusal");
});
