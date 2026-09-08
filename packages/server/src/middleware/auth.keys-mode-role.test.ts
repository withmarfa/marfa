/**
 * The keys-mode invariant, made a check rather than an absence.
 *
 * In keys mode no OAuth principal may carry a role. Today it cannot, and until
 * this suite existed the only reason was that `storage.users` is wired under
 * `authMode === "hosted"` and nowhere else — so the projection had nothing to
 * read and every keys-mode OAuth principal stayed `member` by default rather
 * than by decision.
 *
 * **That is one refactor away from being false.** `lib.ts` exports `createApp`
 * and both storage constructors, so a keys-mode app over a storage that has a
 * user store is constructible today, by anyone wiring one for an unrelated
 * reason. Were the projection to run there, every `requireAdmin` route would
 * open to OAuth: a keys-mode token is space-less by design, and the hosted
 * space-less refusal in the bearer middleware has no keys-mode equivalent to
 * catch it.
 *
 * So this file builds exactly that configuration — the one nothing in the
 * repository builds on purpose — and asserts the principal stays `member`.
 * A test that passed before the guard and after it would be worthless, so the
 * shape here is deliberately the pathological one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { request, seedOauthBearer } from "../test-utils.js";
import type { Storage } from "../storage/interface.js";
import type { AppConfig } from "../config.js";

const SKIP = (process.env.DB_DIALECT ?? "sqlite") !== "sqlite";

let tmpDir: string;
let storage: Storage;
let app: ReturnType<typeof createApp>;

function config(blobPath: string): AppConfig {
  return {
    port: 0,
    storageDialect: "sqlite",
    sqlitePath: "",
    databaseUrl: "",
    blobPath,
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: "test-salt",
    corsOrigins: [],
    cdnBaseUrl: "",
    // The whole point: a keys-mode app.
    authMode: "keys",
    rateLimitEnabled: false,
    enableHsts: false,
    auditRetentionDays: 90,
    auditCleanupIntervalMs: 86_400_000,
    eventLogRetentionHours: 168,
    versionThinningIntervalMs: 3_600_000,
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
    versionWeeklySnapshotDays: 365,
    versionMaxVersions: 500,
    trashRetentionDays: 60,
    trashPurgeIntervalMs: 3_600_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    authBaseUrl: "http://localhost:0",
    authAllowSignup: true,
    seedStarterContent: false,
    authSecret: "test-auth-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    mcpEnabled: false,
  };
}

describe.skipIf(SKIP)(
  "keys mode never projects a role onto an OAuth principal",
  () => {
    beforeAll(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "marfa-keysmode-guard-"));
      // Hosted storage, so `storage.users` exists and the projection has
      // something to read — the configuration the guard is about.
      storage = await createSqliteStorage(join(tmpDir, "test.db"), {
        authMode: "hosted",
      });
      app = createApp(
        storage,
        new FilesystemBlobBackend(join(tmpDir, "blobs")),
        config(join(tmpDir, "blobs")),
      );
    });

    afterAll(async () => {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("has the user store the guard exists to ignore", () => {
      // Without this the suite could pass by building a storage that simply has
      // no users, which is the arrangement the guard replaces.
      expect(storage.users).toBeDefined();
    });

    it("leaves an instance_admin user's token a member on a space-admin door", async () => {
      // **The door has to read role and nothing else that could refuse first.**
      // A capability-gated door would refuse this token for the missing scope
      // whatever its role, so a green test there says nothing about the
      // projection — which is what the first version of this file did, and what
      // the mutation check caught. The capability is granted, so the only
      // remaining variable is the rank the middleware projected.
      //
      // The platform tier (`requireAdmin`, which is `instance_admin` AND no
      // space) is the wider half of the hole and is not exercised here: it needs
      // a space-less token, and `seedOauthBearer` cannot build one because the
      // users row it creates is foreign-key bound to a space. The guard is one
      // condition covering both, and this is the half that can be built.
      const space = await storage.spaces!.create("keys-mode-space-1");
      const { token } = await seedOauthBearer(
        storage,
        ["openid", "capability.audit_read"],
        { spaceId: space.id, userRole: "instance_admin" },
      );
      const res = await request(app, "GET", "/audit", { key: token });
      expect(res.status).toBe(403);
    });

    it("leaves a space_admin user's token a member on a space-admin door", async () => {
      // The second rank, on a door that reads it. `/audit` consults a capability
      // as well now, so the grant carries it — otherwise this would pass on the
      // missing scope rather than on the role, for the same reason as above.
      const space = await storage.spaces!.create("keys-mode-space-2");
      const { token } = await seedOauthBearer(
        storage,
        ["openid", "capability.audit_read"],
        { spaceId: space.id, userRole: "space_admin" },
      );
      const res = await request(app, "GET", "/audit", { key: token });
      expect(res.status).toBe(403);
    });
  },
);
