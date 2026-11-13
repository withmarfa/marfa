import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  afterFirstScheduledBackup,
  instanceIdOf,
  ownerOf,
} from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor } from "../../utils/own-blob-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * The most one archive line may hold, lowered with `limit:archive-line` so
 * that a few kilobytes stand for 64 MiB. A server of the fixture's own, since
 * the fault holds every export and backup on the instance while it is set.
 */
const LOWERED = 2048;
const folder = mkdtempSync(join(tmpdir(), "marfa-archive-line-"));
let server: FreshServer;
let working: MarfaClient;
let backups: string;

beforeAll(async () => {
  server = await bootFreshServer("archive-line-cap", {
    S3_BUCKET: "",
    MARFA_BACKUP_PATH: folder,
    MARFA_BACKUP_INTERVAL_SECONDS: "31536000",
  });
  await afterFirstScheduledBackup(server);
  backups = join(folder, "backups", await instanceIdOf(server));
  working = clientsFor(server).working;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  rmSync(folder, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

async function exported(): Promise<Response> {
  return fetch(`${server.apiUrl}/export?format=archive`, {
    headers: { Authorization: `Bearer ${server.workingKey}` },
  });
}

async function note(body: string): Promise<{ id: string; version: number }> {
  const created = await working.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item;
}

describe("an archive line past what a restore reads", () => {
  it("refuses an export and a backup whose item line is past the limit, naming the item", async () => {
    const small = await note("short");
    const large = await note("x".repeat(4096));

    // The witness: at the full limit the same instance exports.
    const witness = await exported();
    expect(witness.status).toBe(200);
    await witness.arrayBuffer();

    await server.setFault(`limit:archive-line=${String(LOWERED)}`);
    try {
      const refused = await exported();
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as {
        error: {
          code: string;
          message: string;
          details: { entry: { kind: string; id: string } };
        };
      };
      expect(body.error.code).toBe("export_entry_unrestorable");
      expect(body.error.details.entry).toMatchObject({
        kind: "item",
        id: large.id,
      });
      expect(body.error.details.entry.id).not.toBe(small.id);
      expect(body.error.message).toContain(String(LOWERED));

      const before = readdirSync(backups).sort();
      const backup = await ownerOf(server).runBackup();
      expect(backup.ok, JSON.stringify(backup.data)).toBe(false);
      expect(backup.status).toBe(409);
      expect(backup.error?.error.code).toBe("export_entry_unrestorable");
      expect(backup.error?.error.details).toMatchObject({
        entry: { kind: "item", id: large.id },
      });
      await expectMatchesSchema("POST", "/backups", 409, backup.error);
      expect(readdirSync(backups).sort()).toEqual(before);
    } finally {
      await server.clearFault();
    }

    expect((await working.deleteItem(large.id)).ok).toBe(true);
    const purged = await working.purgeItem(large.id);
    expect(purged.ok, JSON.stringify(purged.error)).toBe(true);
    const again = await exported();
    expect(again.status).toBe(200);
    await again.arrayBuffer();
    // The witness for the backup: once the item is gone, one is put.
    const before = readdirSync(backups).length;
    const backup = await ownerOf(server).runBackup();
    expect(backup.ok, JSON.stringify(backup.error)).toBe(true);
    expect(readdirSync(backups)).toHaveLength(before + 1);
  });

  it("refuses an export whose version line is past the limit, naming the item and the version", async () => {
    const big = await note("y".repeat(4096));
    const patched = await working.updateItem(big.id, {
      version: big.version,
      properties: { body: "short now" },
    });
    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);

    await server.setFault(`limit:archive-line=${String(LOWERED)}`);
    try {
      const refused = await exported();
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as {
        error: { code: string; details: { entry: Record<string, unknown> } };
      };
      expect(body.error.code).toBe("export_entry_unrestorable");
      expect(body.error.details.entry).toMatchObject({
        kind: "item",
        id: big.id,
        field: "versions.1",
      });
    } finally {
      await server.clearFault();
    }

    expect((await working.deleteItem(big.id)).ok).toBe(true);
    const purged = await working.purgeItem(big.id);
    expect(purged.ok, JSON.stringify(purged.error)).toBe(true);
  });
});
