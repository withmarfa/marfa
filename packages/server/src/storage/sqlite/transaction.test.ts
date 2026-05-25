/**
 * T-071 — proves `runInTransaction` is genuinely transactional on SQLite.
 *
 * Pre-T-071 this was a silent no-op for async bodies on better-sqlite3:
 * the body ran statement-by-statement with no `BEGIN`/`COMMIT` bracket,
 * so a thrown error left half-applied state on disk. With libsql + the
 * AsyncLocalStorage routing in `request-context.ts`, every store call
 * inside `fn` flows through the active tx and rolls back together.
 *
 * Two tests cover the contract:
 *   1. Throw mid-tx → both writes roll back.
 *   2. Successful tx → both writes persist.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import type { Storage } from "../interface.js";

describe("SqliteStorage.runInTransaction (T-071)", () => {
  let tmpDir: string;
  let storage: Storage;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "marfa-tx-test-"));
    storage = await createSqliteStorage(join(tmpDir, "tx.db"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rolls back every write inside an async transaction body when the body throws", async () => {
    await expect(
      storage.runInTransaction(async () => {
        await storage.items.create(
          {
            id: "019d1111-1111-7111-a111-111111111111",
            type: "core.note",
            properties: { body: "rollback-alpha" },
          },
          undefined,
        );
        await storage.items.create(
          {
            id: "019d1111-1111-7111-a111-111111111112",
            type: "core.note",
            properties: { body: "rollback-bravo" },
          },
          undefined,
        );
        throw new Error("force rollback");
      }),
    ).rejects.toThrow(/force rollback/);

    expect(
      await storage.items.get("019d1111-1111-7111-a111-111111111111"),
    ).toBeNull();
    expect(
      await storage.items.get("019d1111-1111-7111-a111-111111111112"),
    ).toBeNull();
  });

  it("commits every write when the transaction body resolves", async () => {
    await storage.runInTransaction(async () => {
      await storage.items.create(
        {
          id: "019d2222-2222-7222-a222-222222222221",
          type: "core.note",
          properties: { body: "commit-alpha" },
        },
        undefined,
      );
      await storage.items.create(
        {
          id: "019d2222-2222-7222-a222-222222222222",
          type: "core.note",
          properties: { body: "commit-bravo" },
        },
        undefined,
      );
    });

    const a = await storage.items.get("019d2222-2222-7222-a222-222222222221");
    const b = await storage.items.get("019d2222-2222-7222-a222-222222222222");
    expect(a?.properties.body).toBe("commit-alpha");
    expect(b?.properties.body).toBe("commit-bravo");
  });
});
