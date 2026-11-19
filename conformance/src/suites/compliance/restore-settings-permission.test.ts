import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { blobHash, editLineFile, itemsArchive } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  clientsFor,
  DISK_ONLY,
  everythingClient,
} from "../../utils/own-blob-server.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
  type App,
} from "../../utils/signed-in.js";
import { tempFolder } from "../../utils/temp-folder.js";

// The fixtures change instance settings and need their own backup folder.
let server: FreshServer;
let origin: string;
let operator: MarfaClient;
let working: MarfaClient;
let everything: MarfaClient;
let backupsOnlyApp: App;
let bothApp: App;
const backups = tempFolder("marfa-restore-settings-");
const BACKUPS_ONLY = "backups.manage";
const BOTH = "backups.manage config.manage";

beforeAll(async () => {
  server = await bootFreshServer("restore-settings-permission", {
    ...DISK_ONLY,
    MARFA_BACKUP_PATH: backups,
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
  });
  origin = await issuerOrigin(server);
  ({ operator, working } = clientsFor(server));
  everything = await everythingClient(server);
  backupsOnlyApp = await registerApp(server, BACKUPS_ONLY);
  bothApp = await registerApp(server, BOTH);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  rmSync(backups, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

async function signedInNow(app: App, scope: string): Promise<MarfaClient> {
  const cookie = await signIn(server, origin);
  const tokens = await connect(server, origin, cookie, app, scope);
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: tokens.access_token!,
  });
}

async function config(): Promise<Record<string, unknown>> {
  const read = await operator.getConfig();
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data as Record<string, unknown>;
}

async function setConfig(body: Record<string, unknown>): Promise<void> {
  const set = await operator.patchConfig(body);
  expect(set.status, JSON.stringify(set.error)).toBe(200);
}

/** An archive of one file item and its bytes, with `lines` added to its instance lines. */
function archiveWith(lines: unknown[]): {
  archive: Uint8Array;
  id: string;
  hash: string;
} {
  const data = new Uint8Array(randomBytes(48));
  const hash = blobHash(data);
  const id = uuidv7();
  const archive = editLineFile(
    itemsArchive(
      [
        {
          id,
          type: "core.file",
          source: "restore-settings",
          source_id: `restore-settings-${randomUUID()}`,
          properties: { blob_ref: hash, mime_type: "text/plain" },
        },
      ],
      [{ data, mime_type: "text/plain" }],
    ),
    "instance",
    (text) =>
      lines.reduce<string>(
        (written, line) => `${written}${JSON.stringify(line)}\n`,
        text,
      ),
  );
  return { archive, id, hash };
}

const setting = (key: string, value: unknown) => ({ setting: { key, value } });

async function expectNothingWritten(id: string, hash: string): Promise<void> {
  expect((await working.getItem(id)).status).toBe(404);
  expect((await everything.headBlob(hash)).status).toBe(404);
}

async function expectWritten(id: string, hash: string): Promise<void> {
  expect((await working.getItem(id)).status).toBe(200);
  expect((await everything.headBlob(hash)).status).toBe(200);
}

function expectSettingsRefused(
  answer: { status: number; error?: unknown },
  settings: string[],
): void {
  expect(answer.status, JSON.stringify(answer.error)).toBe(403);
  const error = (
    answer.error as {
      error: { code: string; details?: Record<string, unknown> };
    }
  ).error;
  expect(error.code).toBe("forbidden");
  expect(error.details?.required_scope).toBe("config.manage");
  expect(error.details?.settings).toEqual(settings);
}

describe("a restore's settings and config.manage", () => {
  it("refuses an app without config.manage an archive that would store a setting, writing no item, file or setting, where the same archive without it restores", async () => {
    const app = await signedInNow(backupsOnlyApp, BACKUPS_ONLY);
    expect((await config()).trash_retention_days).toBeUndefined();
    const held = archiveWith([setting("trash_retention_days", 45)]);

    const refused = await app.restoreArchive(held.archive);
    expectSettingsRefused(refused, ["trash_retention_days"]);
    await expectNothingWritten(held.id, held.hash);
    expect((await config()).trash_retention_days).toBeUndefined();

    const plain = archiveWith([]);
    const restored = await app.restoreArchive(plain.archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.settings_added).toBe(0);
    await expectWritten(plain.id, plain.hash);
  });

  it("restores for an app without config.manage an archive whose every setting the instance already stores, and changes none", async () => {
    await setConfig({ trash_retention_days: 30 });
    try {
      const app = await signedInNow(backupsOnlyApp, BACKUPS_ONLY);
      const held = archiveWith([setting("trash_retention_days", 45)]);
      const restored = await app.restoreArchive(held.archive);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.settings_added).toBe(0);
      expect(restored.data.settings_skipped).toBe(1);
      await expectWritten(held.id, held.hash);
      expect((await config()).trash_retention_days).toBe(30);
    } finally {
      await setConfig({ trash_retention_days: null });
    }
  });

  it("stores an archive's settings for an app that holds config.manage as well", async () => {
    try {
      const app = await signedInNow(bothApp, BOTH);
      const held = archiveWith([setting("trash_retention_days", 45)]);
      const restored = await app.restoreArchive(held.archive);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.settings_added).toBe(1);
      await expectWritten(held.id, held.hash);
      expect((await config()).trash_retention_days).toBe(45);
    } finally {
      await setConfig({ trash_retention_days: null });
    }
  });

  it("refuses an app without config.manage an archive whose only instance line is an enforcement setting, which an app holding it restores", async () => {
    const levers = { enforcement: { strict_mode: { types: ["core.task"] } } };
    expect((await config()).enforcement).toBeUndefined();
    const refusedArchive = archiveWith([levers]);
    const refused = await (
      await signedInNow(backupsOnlyApp, BACKUPS_ONLY)
    ).restoreArchive(refusedArchive.archive);
    expectSettingsRefused(refused, ["enforcement"]);
    await expectNothingWritten(refusedArchive.id, refusedArchive.hash);
    expect((await config()).enforcement).toBeUndefined();

    try {
      const restored = await (
        await signedInNow(bothApp, BOTH)
      ).restoreArchive(archiveWith([levers]).archive);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.enforcement_added).toEqual(["strict_mode"]);
      expect((await config()).enforcement).toEqual(levers.enforcement);
    } finally {
      await setConfig({ enforcement: null });
    }
  });

  it("refuses an app without config.manage an archive naming a secret the instance would ask to be set again, which an app holding it restores", async () => {
    const secret = { setting: { key: "heartbeat_url", secret: true } };
    const refusedArchive = archiveWith([secret]);
    const refused = await (
      await signedInNow(backupsOnlyApp, BACKUPS_ONLY)
    ).restoreArchive(refusedArchive.archive);
    expectSettingsRefused(refused, ["heartbeat_url"]);
    await expectNothingWritten(refusedArchive.id, refusedArchive.hash);

    const restored = await (
      await signedInNow(bothApp, BOTH)
    ).restoreArchive(archiveWith([secret]).archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.secrets_to_set).toEqual(["heartbeat_url"]);
  });

  it("restores for an app without config.manage an archive whose only setting this server does not have, and names it as dropped", async () => {
    const held = archiveWith([setting("no_such_setting", 1)]);
    const restored = await (
      await signedInNow(backupsOnlyApp, BACKUPS_ONLY)
    ).restoreArchive(held.archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.settings_added).toBe(0);
    expect(restored.data.settings_dropped).toEqual(["no_such_setting"]);
    await expectWritten(held.id, held.hash);
  });

  it("refuses an archive carrying a setting that describes this machine, even to an app holding config.manage, and writes nothing, where the archive without it restores", async () => {
    const app = await signedInNow(bothApp, BOTH);
    const before = await config();
    for (const [key, value] of [
      ["allow_private_addresses", true],
      ["sign_in_address", "https://elsewhere.example"],
      ["addresses", ["https://elsewhere.example"]],
      ["backup_path", "/srv/elsewhere"],
      ["object_store_bucket", "elsewhere"],
    ] as const) {
      const held = archiveWith([setting(key, value)]);
      const refused = await app.restoreArchive(held.archive);
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.message).toContain(key);
      await expectNothingWritten(held.id, held.hash);
    }
    expect(await config()).toEqual(before);

    const plain = archiveWith([]);
    const restored = await app.restoreArchive(plain.archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    await expectWritten(plain.id, plain.hash);
  });

  it("holds a backup restore to the same rule: it restores while the instance stores the backup's settings, and needs config.manage once one is gone", async () => {
    await setConfig({ trash_retention_days: 45 });
    const note = await working.createItem({
      type: "core.note",
      properties: { title: `restore settings ${randomUUID()}` },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    const id = note.data.item.id;
    const ran = await operator.runBackup();
    expect(ran.status, JSON.stringify(ran.error)).toBe(200);
    const { instance_id, name } = ran.data.backup;

    const same = await (
      await signedInNow(backupsOnlyApp, BACKUPS_ONLY)
    ).restoreBackup(instance_id, name);
    expect(same.status, JSON.stringify(same.error)).toBe(200);
    expect(same.data.settings_added).toBe(0);

    await setConfig({ trash_retention_days: null });
    expect((await working.deleteItem(id)).status).toBe(200);
    expect((await working.purgeItem(id)).status).toBe(200);
    expect((await working.getItem(id)).status).toBe(404);

    const refused = await (
      await signedInNow(backupsOnlyApp, BACKUPS_ONLY)
    ).restoreBackup(instance_id, name);
    expectSettingsRefused(refused, ["trash_retention_days"]);
    expect((await working.getItem(id)).status).toBe(404);
    expect((await config()).trash_retention_days).toBeUndefined();

    try {
      const restored = await (
        await signedInNow(bothApp, BOTH)
      ).restoreBackup(instance_id, name);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.settings_added).toBe(1);
      expect((await working.getItem(id)).status).toBe(200);
      expect((await config()).trash_retention_days).toBe(45);
    } finally {
      await setConfig({ trash_retention_days: null });
    }
  });
});
