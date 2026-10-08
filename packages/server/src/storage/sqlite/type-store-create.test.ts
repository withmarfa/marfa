import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode, MarfaError, getTypeSchema } from "@withmarfa/shared";
import { createSqliteStorage } from "./index.js";
import type { Storage } from "../interface.js";

let tmpDir: string;
let storage: Storage;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "marfa-type-create-"));
  storage = await createSqliteStorage(join(tmpDir, "types.db"));
});

afterEach(async () => {
  await storage.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

it("refuses the second of two concurrent creates of one type as already existing", async () => {
  const id = "acme.concurrent_create";
  const schema = (field: string) => ({
    id,
    version: 1,
    fields: { [field]: { type: "string" as const } },
  });

  const results = await Promise.allSettled([
    storage.types.create(schema("first")),
    storage.types.create(schema("second")),
  ]);

  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const refused = results.filter((r) => r.status === "rejected");
  expect(refused).toHaveLength(1);
  const reason: unknown = refused[0]!.reason;
  expect(reason).toBeInstanceOf(MarfaError);
  expect((reason as MarfaError).code).toBe(ErrorCode.TYPE_ALREADY_EXISTS);
  expect(getTypeSchema(id)).toBeDefined();
});
