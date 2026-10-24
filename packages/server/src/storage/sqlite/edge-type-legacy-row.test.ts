/**
 * A database written before every edge type carried a `label` holds rows
 * with none. They must still boot and list.
 */
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { listEdgeTypes } from "@withmarfa/shared";
import { createSqliteStorage } from "./index.js";
import type { Storage } from "../interface.js";

let tmpDir: string | undefined;
let storage: Storage | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

it("boots and lists an edge type stored without a label, giving it the label its id makes", async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "marfa-legacy-edge-"));
  const dbPath = join(tmpDir, "marfa.db");
  await (await createSqliteStorage(dbPath)).close();

  const raw = createClient({ url: `file:${dbPath}` });
  const stored = {
    id: "legacy.mentions",
    cardinality: "many-to-many",
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
    cascade_on_delete: "orphan",
    property_schema: {},
    written_at: "source",
  };
  await raw.execute({
    sql: "INSERT INTO edge_types (id, schema, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: [
      stored.id,
      JSON.stringify(stored),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ],
  });
  raw.close();

  storage = await createSqliteStorage(dbPath);
  expect(await storage.edgeTypes.get(stored.id)).toMatchObject({
    label: "Mentions",
  });
  expect(listEdgeTypes().find((t) => t.id === stored.id)).toMatchObject({
    label: "Mentions",
  });
});
