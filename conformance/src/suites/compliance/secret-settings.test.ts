import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { archiveLines } from "../../utils/archive.js";
import { attentionOf, ownerOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor, everythingClient } from "../../utils/own-blob-server.js";
import { listened } from "../../utils/refused-boot.js";
import { waitFor } from "../../utils/wait.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * A secret setting is written through `/config` and never read back: each
 * answer says only whether it is set, and no log, audit entry, archive or
 * backup holds its value. The server seals it with a key kept beside the
 * database, so a restore or a lost key leaves secrets to set again.
 */
const SECRET = "object_store_secret_access_key";
const DISK = {
  MARFA_OBJECT_STORE_BUCKET: "",
  MARFA_OBJECT_STORE_SECRET_ACCESS_KEY: "",
  MARFA_ERROR_WEBHOOK_URL: "",
  MARFA_BACKUP_INTERVAL_SECONDS: "0",
};

interface Listed {
  key: string;
  value: unknown;
  default: unknown;
  stored: unknown;
  secret: boolean;
  set?: boolean;
  unreadable?: boolean;
}

async function listed(server: FreshServer, key: string): Promise<Listed> {
  const answer = await clientsFor(server).operator.rawRequest<{
    data: Listed[];
  }>("/config/settings");
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  const entry = answer.data.data.find((line) => line.key === key);
  expect(entry, key).toBeDefined();
  return entry!;
}

async function setFrom(
  operator: ReturnType<typeof clientsFor>["operator"],
  changes: Record<string, unknown>,
): Promise<void> {
  const set = await operator.patchConfig(changes);
  expect(set.status, JSON.stringify(set.error)).toBe(200);
}

async function config(server: FreshServer): Promise<Record<string, unknown>> {
  const answer = await clientsFor(server).operator.getConfig();
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  return answer.data as Record<string, unknown>;
}

/** Every file under `root`, gunzipped where it is gzip, as text. */
function filesUnder(root: string): string {
  const texts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const bytes = readFileSync(path);
      const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
      texts.push((gzip ? gunzipSync(bytes) : bytes).toString("utf8"));
    }
  };
  walk(root);
  return texts.join("\n");
}

describe("a secret setting", () => {
  it(
    "is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown",
    async () => {
      const endpoint = process.env.MARFA_OBJECT_STORE_ENDPOINT;
      if (!endpoint) {
        throw new Error(
          "MARFA_OBJECT_STORE_ENDPOINT is required: source the env file `pnpm garage:up` writes.",
        );
      }
      const folder = tempFolder("marfa-secret-backups-");
      const server = await bootFreshServer("secret-witness", DISK);
      try {
        const { operator } = clientsFor(server);
        const witness = `witness-${randomUUID()}`;
        const beat = `https://beat-${randomUUID()}.example.test/`;
        const visible = `visible-${randomUUID()}`;
        const secrets = [witness, beat];
        const answers: string[] = [];
        const keep = (answer: {
          status: number;
          data: unknown;
          error?: unknown;
        }) => {
          answers.push(
            JSON.stringify(answer.data),
            JSON.stringify(answer.error ?? null),
          );
          return answer;
        };

        const set = keep(
          await operator.patchConfig({
            [SECRET]: witness,
            heartbeat_url: beat,
            backup_path: folder,
            object_store_access_key_id: visible,
            trash_retention_days: 7,
          }),
        );
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        // The witness: a value that is no secret is shown back on the same path.
        expect(set.data).toMatchObject({
          object_store_access_key_id: visible,
          secrets_set: [SECRET, "heartbeat_url"],
        });
        const refused = keep(
          await operator.patchConfig({ [SECRET]: ` ${witness} ` }),
        );
        expect(refused.status).toBe(400);
        expect(JSON.stringify(refused.error)).toContain(SECRET);
        keep(await operator.getConfig());
        keep(await operator.rawRequest("/config/settings"));
        keep(await operator.listAudit({ kind: "settings" }));
        for (const answer of answers) {
          for (const secret of secrets) expect(answer).not.toContain(secret);
        }
        const audit = await operator.listAudit({ kind: "settings" });
        expect(JSON.stringify(audit.data)).toContain(SECRET);

        const everything = await everythingClient(server);
        const archive = await everything.exportArchive({
          state: "any",
          files: "false",
        });
        expect(archive.status).toBe(200);
        const bytes = new Uint8Array(archive.data);
        const settings = archiveLines<{ setting?: Record<string, unknown> }>(
          bytes,
          "instance",
        ).flatMap((line) => (line.setting ? [line.setting] : []));
        expect(settings).toContainEqual({ key: "heartbeat_url", secret: true });
        expect(settings).toContainEqual({
          key: "trash_retention_days",
          value: 7,
        });
        // The object store's secret belongs to this machine, as its bucket does.
        expect(settings.map((line) => line.key)).not.toContain(SECRET);
        for (const secret of secrets) {
          expect(Buffer.from(bytes).toString("latin1")).not.toContain(secret);
          expect(JSON.stringify(settings)).not.toContain(secret);
        }

        const run = await ownerOf(server).runBackup();
        expect(run.status, JSON.stringify(run.error)).toBe(200);
        const backup = filesUnder(folder);
        expect(backup).toContain(`"heartbeat_url"`);
        for (const secret of secrets) expect(backup).not.toContain(secret);

        const data = dirname(server.sqlitePath);
        const pages = ["marfa.db", "marfa.db-wal"]
          .map((name) => join(data, name))
          .filter((path) => existsSync(path))
          .map((path) => readFileSync(path).toString("latin1"))
          .join("");
        expect(pages).toContain(visible);
        for (const secret of secrets) expect(pages).not.toContain(secret);

        // An object store the secret cannot open is logged, and the log names
        // the store's bucket, which is no secret, and never the secret.
        const bucket = `witness-bucket-${randomUUID()}`;
        await setFrom(operator, {
          backup_path: null,
          object_store_bucket: bucket,
          object_store_endpoint: endpoint,
        });
        await waitFor("the store to be reported unusable", async () => {
          const said = await clientsFor(server).operator.rawRequest<{
            backups: Record<string, unknown>;
          }>("/health");
          return said.data.backups.reason === "destination_unusable"
            ? true
            : undefined;
        });
        const logs = ["server.log", "server.stderr"]
          .map((name) => join(server.stateDir, name))
          .filter((path) => existsSync(path))
          .map((path) => readFileSync(path, "utf8"));
        expect(logs.length).toBeGreaterThan(0);
        const logged = logs.join("\n");
        expect(logged).toContain(bucket);
        for (const secret of secrets) expect(logged).not.toContain(secret);
      } finally {
        await server.stop();
        rmSync(folder, { recursive: true, force: true });
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is named in secrets_set and listed as set with no value, kept by a PUT that leaves it out, and removed by null or an empty string",
    async () => {
      const server = await bootFreshServer("secret-set", DISK);
      try {
        const { operator } = clientsFor(server);
        expect(await config(server)).not.toHaveProperty("secrets_set");
        expect(await listed(server, SECRET)).toMatchObject({
          secret: true,
          set: false,
          value: null,
          default: null,
          stored: null,
        });

        const set = await operator.patchConfig({
          [SECRET]: `kept-${randomUUID()}`,
        });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        expect(await config(server)).toMatchObject({ secrets_set: [SECRET] });
        expect(await listed(server, SECRET)).toMatchObject({
          secret: true,
          set: true,
          value: null,
          default: null,
          stored: null,
        });
        expect((await listed(server, "trash_retention_days")).secret).toBe(
          false,
        );

        const whole = await config(server);
        const replaced = await operator.updateConfig(whole);
        expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
        expect(await config(server)).toMatchObject({ secrets_set: [SECRET] });

        const cleared = await operator.patchConfig({ [SECRET]: null });
        expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
        expect(await config(server)).not.toHaveProperty("secrets_set");
        expect((await listed(server, SECRET)).set).toBe(false);

        await operator.patchConfig({ [SECRET]: `again-${randomUUID()}` });
        expect((await listed(server, SECRET)).set).toBe(true);
        const emptied = await operator.patchConfig({ [SECRET]: "" });
        expect(emptied.status, JSON.stringify(emptied.error)).toBe(200);
        expect((await listed(server, SECRET)).set).toBe(false);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is reported on a restore, and on the attention list, when the archive's instance had it set and this one holds no value it can read",
    async () => {
      const origin = await bootFreshServer("secret-restore-origin", DISK);
      const target = await bootFreshServer("secret-restore-target", DISK);
      try {
        const beat = () => `https://beat-${randomUUID()}.example.test/`;
        const set = await clientsFor(origin).operator.patchConfig({
          [SECRET]: `origin-${randomUUID()}`,
          heartbeat_url: beat(),
          error_webhook_url: `https://${randomUUID()}.example.test/errors`,
        });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        const archive = await (
          await everythingClient(origin)
        ).exportArchive({
          state: "any",
          files: "false",
        });
        expect(archive.status).toBe(200);

        // The witness: a secret the restoring instance holds already is not reported.
        const held = await clientsFor(target).operator.patchConfig({
          heartbeat_url: beat(),
        });
        expect(held.status, JSON.stringify(held.error)).toBe(200);
        const restored = await ownerOf(target).restoreArchive(
          new Uint8Array(archive.data),
        );
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        // The object store's secret belongs to the machine, so it is not asked for.
        expect(restored.data.secrets_to_set).toEqual(["error_webhook_url"]);

        expect(await listed(target, "error_webhook_url")).toMatchObject({
          set: false,
          unreadable: true,
          stored: null,
        });
        expect((await listed(target, "heartbeat_url")).set).toBe(true);
        expect(await listed(target, SECRET)).toMatchObject({ set: false });
        expect((await listed(target, SECRET)).unreadable).not.toBe(true);
        const concerns = (await attentionOf(target)).filter(
          (concern) => concern.kind === "setting",
        );
        expect(concerns.map((concern) => concern.reference)).toEqual([
          "error_webhook_url",
        ]);

        const mended = await clientsFor(target).operator.patchConfig({
          error_webhook_url: `https://${randomUUID()}.example.test/errors`,
        });
        expect(mended.status, JSON.stringify(mended.error)).toBe(200);
        expect(
          (await attentionOf(target)).filter(
            (concern) => concern.kind === "setting",
          ),
        ).toEqual([]);
      } finally {
        await origin.stop();
        await target.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "survives a lost or damaged settings key: the server starts, serves, and lists each stored secret to set again",
    async () => {
      const server = await bootFreshServer("secret-key-lost", DISK);
      try {
        const key = join(dirname(server.sqlitePath), "marfa.settings.key");
        const set = await clientsFor(server).operator.patchConfig({
          [SECRET]: `sealed-${randomUUID()}`,
        });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        expect(existsSync(key)).toBe(true);
        expect((await listed(server, SECRET)).set).toBe(true);

        await server.restart(() => rmSync(key));
        expect(await listed(server, SECRET)).toMatchObject({
          set: false,
          unreadable: true,
        });
        expect(await config(server)).not.toHaveProperty("secrets_set");
        expect(
          (await attentionOf(server))
            .filter((concern) => concern.kind === "setting")
            .map((concern) => concern.reference),
        ).toEqual([SECRET]);
        expect((await clientsFor(server).operator.getConfig()).status).toBe(
          200,
        );

        const again = await clientsFor(server).operator.patchConfig({
          [SECRET]: `sealed-${randomUUID()}`,
        });
        expect(again.status, JSON.stringify(again.error)).toBe(200);
        await server.restart(() =>
          writeFileSync(key, "not a key\n", { mode: 0o600 }),
        );
        expect((await listed(server, SECRET)).set).toBe(false);
        expect(
          readdirSync(dirname(key)).filter((name) =>
            name.startsWith("marfa.settings.key.damaged-"),
          ),
        ).toHaveLength(1);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses to start on a settings key it cannot open, and keeps the file as it was",
    async () => {
      const cases: [string, (key: string, beside: string) => void][] = [
        [
          "a symbolic link",
          (key, beside) => {
            writeFileSync(join(beside, "target"), "settings_key=short\n", {
              mode: 0o600,
            });
            symlinkSync(join(beside, "target"), key);
          },
        ],
        ["a directory", (key) => mkdirSync(key, { mode: 0o700 })],
      ];
      // A process that runs as root opens a file whatever its mode.
      if (process.getuid?.() !== 0) {
        cases.push([
          "a file with mode 000",
          (key) => {
            writeFileSync(key, "settings_key=short\n");
            chmodSync(key, 0o000);
          },
        ]);
      }
      for (const [kind, arrange] of cases) {
        let before = "";
        const refused = await bootRefused("secret-key-unopened", {
          prepare: (_sqlitePath, state) => {
            const key = join(state, "marfa.settings.key");
            arrange(key, state);
            const found = lstatSync(key);
            before = `${String(found.mode)} ${found.isSymbolicLink() ? readlinkSync(key) : ""}`;
          },
        });
        try {
          expect(refused.code, kind).not.toBe(0);
          expect(listened(refused), kind).toBe(false);
          const key = join(refused.stateDir, "marfa.settings.key");
          const found = lstatSync(key);
          expect(
            `${String(found.mode)} ${found.isSymbolicLink() ? readlinkSync(key) : ""}`,
            kind,
          ).toBe(before);
          expect(
            readdirSync(refused.stateDir).filter((name) =>
              name.startsWith("marfa.settings.key.damaged-"),
            ),
            kind,
          ).toEqual([]);
        } finally {
          await refused.stop();
        }
      }
    },
    FRESH_SERVER_TIMEOUT_MS * 3,
  );
});
