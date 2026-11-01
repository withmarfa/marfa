import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { unregisterTypeSchema } from "@withmarfa/shared";
import { createSqliteStorage } from "./sqlite/index.js";
import type { Storage } from "./interface.js";
import * as logger from "../middleware/logger.js";

const STORED = ["boot.drift", "boot.broken_enum"];

let tmpDir: string | undefined;
let storage: Storage | undefined;
let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  for (const id of STORED) unregisterTypeSchema(id);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
  vi.restoreAllMocks();
});

async function databaseHolding(rows: Record<string, unknown>): Promise<string> {
  tmpDir = mkdtempSync(join(tmpdir(), "marfa-type-conflicts-"));
  const dbPath = join(tmpDir, "marfa.db");
  await (await createSqliteStorage(dbPath)).close();
  const raw = createClient({ url: `file:${dbPath}` });
  const at = "2026-10-01T00:00:00.000Z";
  for (const [id, schema] of Object.entries(rows)) {
    await raw.execute({
      sql: "INSERT INTO types (id, schema, origin, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)",
      args: [id, JSON.stringify(schema), at, at],
    });
  }
  raw.close();
  return dbPath;
}

const conflictLines = () =>
  logSpy.mock.calls.filter(([level, message]) => {
    return (
      level === "warn" &&
      message.includes("declare fields in a shape a type above them")
    );
  });

it("warns at boot about a stored type that conflicts with the shipped type above it", async () => {
  const dbPath = await databaseHolding({
    "boot.drift": {
      id: "boot.drift",
      version: 1,
      parent: "core.task",
      fields: { assignees: { type: "array", items_type: "string" } },
    },
  });
  storage = await createSqliteStorage(dbPath);
  const lines = conflictLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]?.[2]).toMatchObject({
    count: 1,
    conflicts: [{ type: "boot.drift", field: "assignees", owner: "core.task" }],
  });
});

it("starts when a stored type has a malformed enum, and still reports the other conflict", async () => {
  const dbPath = await databaseHolding({
    "boot.drift": {
      id: "boot.drift",
      version: 1,
      parent: "core.task",
      fields: { assignees: { type: "array", items_type: "string" } },
    },
    "boot.broken_enum": {
      id: "boot.broken_enum",
      version: 1,
      parent: "core.task",
      fields: { title: { type: "string", enum_values: "broken" } },
    },
  });
  storage = await createSqliteStorage(dbPath);
  const lines = conflictLines();
  expect(lines).toHaveLength(1);
  const reported = (
    lines[0]?.[2] as { conflicts: { type: string; attribute: string }[] }
  ).conflicts;
  expect(reported.map((c) => c.type).sort()).toEqual([
    "boot.broken_enum",
    "boot.drift",
  ]);
  expect(reported.find((c) => c.type === "boot.broken_enum")?.attribute).toBe(
    "enum_values",
  );
});
