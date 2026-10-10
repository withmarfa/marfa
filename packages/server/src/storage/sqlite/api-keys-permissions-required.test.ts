import { expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "./connection.js";

const COLUMNS = "id, key_hash, label, source, created_at";
const VALUES =
  "'k1', 'h1', 'acme', 'integration:acme/thing', '2026-01-01T00:00:00.000Z'";

it("refuses a key row that leaves out its type permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marfa-key-permissions-"));
  const connection = await createConnection(join(dir, "test.db"));
  try {
    await expect(
      connection.raw.execute(
        `INSERT INTO api_keys (${COLUMNS}) VALUES (${VALUES})`,
      ),
    ).rejects.toThrow(/type_permissions/);
    await connection.raw.execute(
      `INSERT INTO api_keys (${COLUMNS}, type_permissions) VALUES (${VALUES}, '{}')`,
    );
  } finally {
    connection.raw.close();
  }
});
