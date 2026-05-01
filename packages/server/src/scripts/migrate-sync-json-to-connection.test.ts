/**
 * Tests for the sync.json → Connection migration — Layer 3 PR 4.
 *
 * Covers:
 *   - Happy path: sync.json present → system.integration created (or
 *     reused), system.credential created with encrypted key, system.connection
 *     created bound to both refs, sentinel pointer file written.
 *   - Idempotency: re-running with sentinel present → already_migrated.
 *   - Missing sync.json → no_sync_json status.
 *   - Missing key in sync.json → missing_key status.
 *   - Multiple migrations against the same instance reuse the existing
 *     system.integration row (no duplicate).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  migrateSyncJsonToConnection,
  type MigrationPaths,
} from "./migrate-sync-json-to-connection.js";
import { decryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

function makePaths(): MigrationPaths & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "myme-sync-migration-"));
  return {
    dir,
    sync_json_path: join(dir, "sync.json"),
    sync_connection_path: join(dir, "sync.connection.json"),
  };
}

const sampleSyncJson = {
  url: "http://localhost:8602",
  key: "myme_k1_sample_long_lived_key_xyz",
  types: ["core.note", "core.file"],
  debounceMs: 3000,
  roots: [{ path: "/home/user/notes", type: "core.note" }],
};

describe("migrateSyncJsonToConnection", () => {
  it("creates integration + credential + connection on a fresh sync.json", async () => {
    const paths = makePaths();
    try {
      writeFileSync(paths.sync_json_path, JSON.stringify(sampleSyncJson));

      const report = await migrateSyncJsonToConnection(ctx.storage, paths);
      expect(report.status).toBe("migrated");
      expect(report.pointer).toBeDefined();

      const pointer = report.pointer!;

      // System.integration exists with manifest_name = mymehq.sync-agent.
      const integration = await ctx.storage.items.get(pointer.integration_id);
      expect(integration?.type).toBe("system.integration");
      expect(
        (integration?.properties as { manifest_name?: string }).manifest_name,
      ).toBe("mymehq.sync-agent");

      // System.credential is kind: api_key with secret_encrypted that
      // round-trips through decryptSecret under apiKeyCredential domain.
      const credential = await ctx.storage.items.get(pointer.credential_id);
      expect(credential?.type).toBe("system.credential");
      const credProps = credential?.properties as {
        kind?: string;
        secret_encrypted?: string;
        label?: string;
      };
      expect(credProps.kind).toBe("api_key");
      expect(typeof credProps.secret_encrypted).toBe("string");
      const decrypted = decryptSecret(
        credProps.secret_encrypted!,
        SECRET_INFO.apiKeyCredential,
      );
      expect(decrypted).toBe(sampleSyncJson.key);

      // System.connection bound to both refs + carries the configuration.
      const connection = await ctx.storage.items.get(pointer.connection_id);
      expect(connection?.type).toBe("system.connection");
      const connProps = connection?.properties as {
        kind?: string;
        integration_ref?: string;
        credential_ref?: string;
        runtime_compatibility?: string[];
        configuration?: Record<string, unknown>;
      };
      expect(connProps.kind).toBe("external-service-connector");
      expect(connProps.integration_ref).toBe(pointer.integration_id);
      expect(connProps.credential_ref).toBe(pointer.credential_id);
      expect(connProps.runtime_compatibility).toEqual(["local"]);
      expect(connProps.configuration?.roots).toEqual(sampleSyncJson.roots);
      expect(connProps.configuration?.debounceMs).toBe(3000);
      expect(connProps.configuration?.types).toEqual([
        "core.note",
        "core.file",
      ]);

      // Sentinel pointer file is written with the new IDs.
      expect(existsSync(paths.sync_connection_path)).toBe(true);
      const onDisk = JSON.parse(
        readFileSync(paths.sync_connection_path, "utf8"),
      ) as Record<string, unknown>;
      expect(onDisk.connection_id).toBe(pointer.connection_id);
      expect(onDisk.credential_id).toBe(pointer.credential_id);
      expect(onDisk.schema_version).toBe(1);
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  it("returns already_migrated when the sentinel file already exists", async () => {
    const paths = makePaths();
    try {
      writeFileSync(paths.sync_json_path, JSON.stringify(sampleSyncJson));
      writeFileSync(paths.sync_connection_path, "{}");
      const report = await migrateSyncJsonToConnection(ctx.storage, paths);
      expect(report.status).toBe("already_migrated");
      expect(report.pointer).toBeUndefined();
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  it("returns no_sync_json when the source file is missing", async () => {
    const paths = makePaths();
    try {
      const report = await migrateSyncJsonToConnection(ctx.storage, paths);
      expect(report.status).toBe("no_sync_json");
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  it("returns missing_key when sync.json has no key field", async () => {
    const paths = makePaths();
    try {
      writeFileSync(
        paths.sync_json_path,
        JSON.stringify({ url: "x", types: [] }),
      );
      const report = await migrateSyncJsonToConnection(ctx.storage, paths);
      expect(report.status).toBe("missing_key");
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing system.integration row across multiple migrations", async () => {
    const paths1 = makePaths();
    const paths2 = makePaths();
    try {
      writeFileSync(paths1.sync_json_path, JSON.stringify(sampleSyncJson));
      writeFileSync(paths2.sync_json_path, JSON.stringify(sampleSyncJson));

      const r1 = await migrateSyncJsonToConnection(ctx.storage, paths1);
      const r2 = await migrateSyncJsonToConnection(ctx.storage, paths2);
      expect(r1.status).toBe("migrated");
      expect(r2.status).toBe("migrated");
      // Both runs find the same system.integration item.
      expect(r1.pointer!.integration_id).toBe(r2.pointer!.integration_id);
      // But each run mints a new connection + credential.
      expect(r1.pointer!.connection_id).not.toBe(r2.pointer!.connection_id);
      expect(r1.pointer!.credential_id).not.toBe(r2.pointer!.credential_id);
    } finally {
      rmSync(paths1.dir, { recursive: true, force: true });
      rmSync(paths2.dir, { recursive: true, force: true });
    }
  });
});
