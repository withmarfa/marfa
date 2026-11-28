import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { v7 as uuidv7 } from "uuid";
import {
  archiveLines,
  editLineFile,
  emptyManifest,
  itemsArchive,
  lineFile,
  ndjson,
  tar,
} from "../../utils/archive.js";
import { attentionOf, ownerOf } from "../../utils/backups.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  serverOutput,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { clientsFor } from "../../utils/own-blob-server.js";
import {
  connectorBundle,
  connectorKey,
  connectorSection,
  fresh,
  linkedHost,
  ownerKey,
  type LinkedHost,
} from "../../utils/plugin-connector.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
} from "../../utils/signed-in.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * Each setting a plugin's connector declares is kept in Marfa: the owner sets
 * it through the plugin, and the connector reads it, its secrets opened, from
 * its own registration. A secret is sealed with the key beside the database,
 * shown back to nobody else, and named without its value in an archive, so a
 * restore onto another machine leaves it to set again. Each server is the
 * fixture's own, since plugins and connector hosts are the instance's.
 */

let origin: FreshServer;
let destination: FreshServer;
let owner: MarfaClient;
let host: LinkedHost;

const OWNER_PERMISSIONS = [
  "schema.write",
  "connectors.manage",
  "keys.manage",
  "keys.mint",
  "backups.manage",
  "audit.read",
];

/** The origin keeps its backups in a folder, so no object store may be set. */
const DISK = {
  MARFA_OBJECT_STORE_BUCKET: "",
  MARFA_OBJECT_STORE_SECRET_ACCESS_KEY: "",
  MARFA_BACKUP_INTERVAL_SECONDS: "0",
};

const SETTINGS = [
  { name: "feed_url", label: "Feed", kind: "text", required: true },
  {
    name: "every",
    label: "Every",
    kind: "number",
    default: 30,
    required: false,
  },
  {
    name: "pictures",
    label: "Pictures",
    kind: "boolean",
    default: false,
    required: false,
  },
  {
    name: "order",
    label: "Order",
    kind: "choice",
    choices: ["newest", "oldest"],
    default: "newest",
    required: false,
  },
  { name: "token", label: "Token", kind: "text", secret: true, required: true },
  {
    name: "spare",
    label: "Spare",
    kind: "text",
    secret: true,
    required: false,
  },
];

beforeAll(async () => {
  [origin, destination] = await Promise.all([
    bootFreshServer("connector-settings", DISK),
    bootFreshServer("connector-settings-destination"),
  ]);
  owner = (await ownerKey(origin, OWNER_PERMISSIONS)).client;
  host = await linkedHost(origin, owner, "settings host");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([origin?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

/** A bundle named `<prefix>-<part>` whose connector declares `settings`. */
function settingsBundle(
  name: string,
  settings: Record<string, unknown>[] = SETTINGS,
  version = "1.0.0",
): Record<string, unknown> {
  const root = name.replaceAll("-", "");
  return connectorBundle(name, root, name, {
    version,
    connector: connectorSection(`${root}.entry`, name, { settings }),
  });
}

async function installed(
  client: MarfaClient,
  name: string,
  settings: Record<string, unknown>[] = SETTINGS,
): Promise<void> {
  const made = await client.installPlugin(settingsBundle(name, settings));
  expect(made.status, JSON.stringify(made.error)).toBe(201);
}

type Running = {
  client: MarfaClient;
  keyId: string;
  registration: string;
};

/** Assigns the plugin's connector to `on`, mints its key and registers it. */
async function running(
  server: FreshServer,
  manager: MarfaClient,
  on: LinkedHost,
  name: string,
): Promise<Running> {
  const assigned = await manager.assignConnector(name, on.id);
  expect(assigned.status, JSON.stringify(assigned.error)).toBe(200);
  const key = await connectorKey(server, on, name);
  const registered = await key.client.registerConnector({ name });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  return {
    client: key.client,
    keyId: key.id,
    registration: registered.data.id,
  };
}

type Entry = Record<string, unknown> & { name: string };

function entry(answer: { data?: Record<string, any> }, name: string): Entry {
  const found = (answer.data?.settings as Entry[] | undefined)?.find(
    (held) => held.name === name,
  );
  expect(found, name).toBeDefined();
  return found!;
}

function errorPaths(answer: { error?: { error: { details?: unknown } } }) {
  const errors = (answer.error?.error.details as { errors?: unknown[] })
    ?.errors as { path: string }[] | undefined;
  return (errors ?? []).map((held) => held.path);
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

function databasePages(server: FreshServer): string {
  const data = dirname(server.sqlitePath);
  return ["marfa.db", "marfa.db-wal"]
    .map((name) => join(data, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString("latin1"))
    .join("");
}

function connectorSettingLines(bytes: Uint8Array): Record<string, unknown>[] {
  return archiveLines<{ connector_setting?: Record<string, unknown> }>(
    bytes,
    "instance",
  ).flatMap((line) => (line.connector_setting ? [line.connector_setting] : []));
}

describe("the owner's settings doors", () => {
  it("lists each declared setting with its default, sets values of each kind, clears one with null, and names a required setting with no value as missing", async () => {
    const name = `listed-${fresh()}`;
    await installed(owner, name);
    const listed = await owner.getConnectorSettings(name);
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/plugins/{name}/connector/settings",
      200,
      listed.data,
    );
    expect(listed.data.plugin).toBe(name);
    expect((listed.data.settings as Entry[]).map((held) => held.name)).toEqual(
      SETTINGS.map((setting) => setting.name),
    );
    expect(entry(listed, "feed_url")).toEqual({
      name: "feed_url",
      label: "Feed",
      kind: "text",
      choices: null,
      secret: false,
      required: true,
      default: null,
      value: null,
      set: false,
      unreadable: false,
    });
    expect(entry(listed, "every")).toMatchObject({
      default: 30,
      value: 30,
      set: false,
    });
    expect(entry(listed, "order")).toMatchObject({
      choices: ["newest", "oldest"],
      value: "newest",
      set: false,
    });
    expect(entry(listed, "token")).toMatchObject({
      secret: true,
      default: null,
      value: null,
      set: false,
      unreadable: false,
    });
    expect(listed.data.missing).toEqual(["feed_url", "token"]);

    const feed = `https://${fresh()}.example.test/feed`;
    const set = await owner.setConnectorSettings(name, {
      feed_url: feed,
      every: 15.5,
      pictures: true,
      order: "oldest",
      token: `token-${randomUUID()}`,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    await expectMatchesSchema(
      "PATCH",
      "/plugins/{name}/connector/settings",
      200,
      set.data,
    );
    expect(entry(set, "feed_url")).toMatchObject({ value: feed, set: true });
    expect(entry(set, "every")).toMatchObject({ value: 15.5, set: true });
    expect(entry(set, "pictures")).toMatchObject({ value: true, set: true });
    expect(entry(set, "order")).toMatchObject({ value: "oldest", set: true });
    expect(entry(set, "token")).toMatchObject({
      value: null,
      default: null,
      set: true,
    });
    expect(entry(set, "spare")).toMatchObject({ set: false });
    expect(set.data.missing).toEqual([]);

    const cleared = await owner.setConnectorSettings(name, {
      feed_url: null,
      every: null,
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    expect(entry(cleared, "feed_url")).toMatchObject({
      value: null,
      set: false,
    });
    expect(entry(cleared, "every")).toMatchObject({ value: 30, set: false });
    expect(entry(cleared, "pictures")).toMatchObject({ value: true });
    expect(cleared.data.missing).toEqual(["feed_url"]);
    const again = await owner.getConnectorSettings(name);
    expect(again.data).toEqual(cleared.data);
  });

  it("refuses 400 validation_error an unknown setting, a value of another kind, a choice outside its choices and a padded secret, naming each setting and storing nothing", async () => {
    const name = `refused-${fresh()}`;
    await installed(owner, name);
    const unknown = await owner.setConnectorSettings(name, {
      nope: 1,
      also_nope: "x",
      feed_url: "https://example.test/",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.error?.error.code).toBe("validation_error");
    expect(errorPaths(unknown).sort()).toEqual(["also_nope", "nope"]);

    const padded = `padded-${randomUUID()}`;
    const wrong: [string, unknown][] = [
      ["feed_url", 3],
      ["feed_url", ""],
      ["feed_url", "x".repeat(65_537)],
      ["feed_url", true],
      ["every", "15"],
      ["every", false],
      ["pictures", "true"],
      ["pictures", 1],
      ["order", "sideways"],
      ["order", 1],
      ["token", ` ${padded} `],
      ["token", `${padded}\n`],
      ["token", 5],
    ];
    for (const [setting, value] of wrong) {
      const refused = await owner.setConnectorSettings(name, {
        [setting]: value,
      });
      expect(refused.status, `${setting} ${JSON.stringify(value)}`).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(errorPaths(refused), setting).toEqual([setting]);
      expect(JSON.stringify(refused.error)).not.toContain(padded);
    }

    // One bad value refuses the whole write.
    const mixed = await owner.setConnectorSettings(name, {
      feed_url: "https://example.test/kept-out",
      order: "sideways",
    });
    expect(mixed.status).toBe(400);
    expect(errorPaths(mixed)).toEqual(["order"]);
    const notArray = await owner.rawRequest(
      `/plugins/${name}/connector/settings`,
      { method: "PATCH", body: ["feed_url"] as unknown as object },
    );
    expect(notArray.status).toBe(400);
    expect(notArray.error?.error.code).toBe("validation_error");
    const after = await owner.getConnectorSettings(name);
    expect(entry(after, "feed_url").set).toBe(false);
    expect(entry(after, "order").set).toBe(false);

    // The witness: the same values, each of its kind, are stored.
    const taken = await owner.setConnectorSettings(name, {
      feed_url: "x".repeat(4096),
      every: -2,
      pictures: false,
      order: "oldest",
      token: padded,
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
    expect(entry(taken, "token").set).toBe(true);
  });

  it(
    "takes a text value of 65536 characters, carries it through an export and a restore, and refuses one of 65537",
    { timeout: 2 * FRESH_SERVER_TIMEOUT_MS },
    async () => {
      const name = `long-${fresh()}`;
      await installed(owner, name);
      // A list of addresses, one to a line, as a connector keeps many feeds in one setting.
      const line = "https://feeds.example.test/a-feed-address\n";
      const long =
        line.repeat(Math.floor(65_536 / line.length)) +
        "x".repeat(65_536 % line.length);
      expect(long.length).toBe(65_536);

      const over = await owner.setConnectorSettings(name, {
        feed_url: `${long}x`,
      });
      expect(over.status).toBe(400);
      expect(over.error?.error.code).toBe("validation_error");
      expect(errorPaths(over)).toEqual(["feed_url"]);
      expect(
        entry(await owner.getConnectorSettings(name), "feed_url").set,
      ).toBe(false);

      const set = await owner.setConnectorSettings(name, { feed_url: long });
      expect(set.status, JSON.stringify(set.error)).toBe(200);
      expect(entry(set, "feed_url")).toMatchObject({ value: long, set: true });
      expect(
        entry(await owner.getConnectorSettings(name), "feed_url").value,
      ).toBe(long);

      const archive = await owner.exportArchive({
        state: "any",
        files: "false",
      });
      expect(archive.status).toBe(200);
      expect(
        connectorSettingLines(archive.data).filter(
          (held) => held.plugin === name,
        ),
      ).toEqual([{ plugin: name, name: "feed_url", value: long }]);

      const elsewhere = await bootFreshServer("connector-settings-long");
      try {
        const restored = await ownerOf(elsewhere).restoreArchive(archive.data);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        const there = (await ownerKey(elsewhere, OWNER_PERMISSIONS)).client;
        const read = await there.getConnectorSettings(name);
        expect(read.status, JSON.stringify(read.error)).toBe(200);
        expect(entry(read, "feed_url")).toMatchObject({
          value: long,
          set: true,
        });
      } finally {
        await elsewhere.stop();
      }
    },
  );

  it("refuses 403 the settings doors to a key without connectors.manage, and 404 a plugin not installed or with no connector", async () => {
    const name = `guarded-${fresh()}`;
    await installed(owner, name);
    const schemaOnly = (await ownerKey(origin, ["schema.write"])).client;
    for (const answer of [
      await schemaOnly.getConnectorSettings(name),
      await schemaOnly.setConnectorSettings(name, {
        feed_url: "https://a.test/",
      }),
    ]) {
      expect(answer.status).toBe(403);
      expect(answer.error?.error.code).toBe("forbidden");
      expect(answer.error?.error.details?.required_scope).toBe(
        "connectors.manage",
      );
    }
    expect(entry(await owner.getConnectorSettings(name), "feed_url").set).toBe(
      false,
    );

    const absent = `absent-${fresh()}`;
    for (const answer of [
      await owner.getConnectorSettings(absent),
      await owner.setConnectorSettings(absent, {}),
    ]) {
      expect(answer.status).toBe(404);
      expect(answer.error?.error.code).toBe("plugin_not_found");
    }

    const bareName = `bare-${fresh()}`;
    const { connector: _connector, ...bare } = connectorBundle(
      bareName,
      bareName.replaceAll("-", ""),
      "unused",
    );
    expect((await owner.installPlugin(bare)).status).toBe(201);
    for (const answer of [
      await owner.getConnectorSettings(bareName),
      await owner.setConnectorSettings(bareName, {}),
    ]) {
      expect(answer.status).toBe(404);
      expect(answer.error?.error.code).toBe("connector_not_found");
      expect(answer.error?.error.details?.plugin).toBe(bareName);
    }
  });

  it("keeps through a newer version each value whose setting keeps its kind and secrecy, and drops the rest", async () => {
    const name = `updated-${fresh()}`;
    const first = [
      { name: "feed_url", label: "Feed", kind: "text", required: true },
      { name: "every", label: "Every", kind: "number", required: false },
      {
        name: "order",
        label: "Order",
        kind: "choice",
        choices: ["newest", "oldest"],
        required: false,
      },
      {
        name: "sort",
        label: "Sort",
        kind: "choice",
        choices: ["title", "date"],
        required: false,
      },
      {
        name: "token",
        label: "Token",
        kind: "text",
        secret: true,
        required: false,
      },
      { name: "hint", label: "Hint", kind: "text", required: false },
      { name: "old_one", label: "Old", kind: "text", required: false },
    ];
    await installed(owner, name, first);
    const set = await owner.setConnectorSettings(name, {
      feed_url: "https://kept.example.test/",
      every: 5,
      order: "oldest",
      sort: "date",
      token: `token-${randomUUID()}`,
      hint: "was plain",
      old_one: "gone",
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    const second = [
      { name: "feed_url", label: "Feed URL", kind: "text", required: true },
      { name: "every", label: "Every", kind: "text", required: false },
      {
        name: "order",
        label: "Order",
        kind: "choice",
        choices: ["newest"],
        required: false,
      },
      {
        name: "sort",
        label: "Sort",
        kind: "choice",
        choices: ["date", "title", "size"],
        required: false,
      },
      {
        name: "token",
        label: "Token",
        kind: "text",
        secret: true,
        required: false,
      },
      {
        name: "hint",
        label: "Hint",
        kind: "text",
        secret: true,
        required: false,
      },
      { name: "new_one", label: "New", kind: "text", required: false },
    ];
    const updated = await owner.installPlugin(
      settingsBundle(name, second, "1.1.0"),
    );
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    const read = await owner.getConnectorSettings(name);
    expect(read.status).toBe(200);
    expect((read.data.settings as Entry[]).map((held) => held.name)).toEqual(
      second.map((setting) => setting.name),
    );
    expect(entry(read, "feed_url")).toMatchObject({
      label: "Feed URL",
      value: "https://kept.example.test/",
      set: true,
    });
    expect(entry(read, "sort")).toMatchObject({ value: "date", set: true });
    expect(entry(read, "token")).toMatchObject({ set: true });
    expect(entry(read, "every")).toMatchObject({ value: null, set: false });
    expect(entry(read, "order")).toMatchObject({ value: null, set: false });
    expect(entry(read, "hint")).toMatchObject({
      value: null,
      set: false,
      unreadable: false,
    });
    expect(entry(read, "new_one")).toMatchObject({ set: false });
  });

  it("removes every setting and secret with the plugin, so the plugin installed again starts with none", async () => {
    const name = `removed-${fresh()}`;
    await installed(owner, name);
    const set = await owner.setConnectorSettings(name, {
      feed_url: "https://removed.example.test/",
      token: `token-${randomUUID()}`,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    // The witness: before the removal, both are set.
    expect(entry(set, "feed_url").set).toBe(true);
    expect(entry(set, "token").set).toBe(true);
    const removed = await owner.removePlugin(name);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect((await owner.getConnectorSettings(name)).status).toBe(404);
    await installed(owner, name);
    const again = await owner.getConnectorSettings(name);
    expect(again.status).toBe(200);
    for (const held of again.data.settings as Entry[]) {
      expect(held, held.name).toMatchObject({ set: false, unreadable: false });
    }
  });
});

describe("the connector's own settings", () => {
  it("answers every setting with its secret opened to the connector's own key alone, 403 to the owner, an app and another connector's key, and 401 to the host's key", async () => {
    const name = `own-${fresh()}`;
    await installed(owner, name);
    const secret = `secret-${randomUUID()}`;
    const set = await owner.setConnectorSettings(name, {
      feed_url: "https://own.example.test/",
      token: secret,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    const connector = await running(origin, owner, host, name);
    const read = await connector.client.readOwnConnectorSettings(
      connector.registration,
    );
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/connectors/{id}/settings",
      200,
      read.data,
    );
    expect(read.data.plugin).toBe(name);
    expect(entry(read, "token")).toEqual({
      name: "token",
      kind: "text",
      secret: true,
      required: true,
      value: secret,
      set: true,
      unreadable: false,
    });
    expect(entry(read, "spare")).toMatchObject({ value: null, set: false });
    expect(entry(read, "every")).toMatchObject({ value: 30, set: false });
    expect(entry(read, "feed_url")).toMatchObject({
      value: "https://own.example.test/",
      set: true,
    });
    expect(read.data.missing).toEqual([]);

    const otherName = `other-${fresh()}`;
    await installed(owner, otherName);
    const other = await running(origin, owner, host, otherName);
    const token = await approvedAppToken(origin, ["connectors.manage"]);
    const app = new MarfaClient({ baseUrl: origin.apiUrl, apiKey: token });
    const refusals = [
      ["another connector's key", other.client],
      ["a key holding connectors.manage", owner],
      ["an app holding connectors.manage", app],
      ["the private socket", ownerOf(origin)],
    ] as const;
    for (const [who, client] of refusals) {
      const refused = await client.readOwnConnectorSettings(
        connector.registration,
      );
      expect(refused.status, who).toBe(403);
      expect(refused.error?.error.code, who).toBe("forbidden");
      expect(JSON.stringify(refused), who).not.toContain(secret);
    }
    // A host's key is no credential on any door but its own.
    const hosted = await host.client.readOwnConnectorSettings(
      connector.registration,
    );
    expect(hosted.status).toBe(401);
    expect(hosted.error?.error.code).toBe("unauthorized");
    expect(JSON.stringify(hosted)).not.toContain(secret);
    const unknown =
      await connector.client.readOwnConnectorSettings(randomUUID());
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("connector_not_found");

    // A registration no plugin's connector made reads no plugin's settings.
    const local = ownerOf(origin);
    const alone = await local.createKey({
      label: "a connector of its own",
      source: `alone-${fresh()}`,
      permissions: [],
    });
    expect(alone.status, JSON.stringify(alone.error)).toBe(201);
    const standalone = new MarfaClient({
      baseUrl: origin.apiUrl,
      apiKey: alone.data.key!,
    });
    const registered = await standalone.registerConnector({ name: "Alone" });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const none = await standalone.readOwnConnectorSettings(registered.data.id);
    expect(none.status).toBe(404);
    expect(none.error?.error.code).toBe("connector_not_found");

    // A fresh mint revokes the old key; the new one registers and reads.
    const next = await connectorKey(origin, host, name);
    const gone = await connector.client.readOwnConnectorSettings(
      connector.registration,
    );
    expect(gone.status).toBe(401);
    const successor = await next.client.registerConnector({ name });
    expect(successor.status, JSON.stringify(successor.error)).toBe(201);
    const reread = await next.client.readOwnConnectorSettings(
      successor.data.id,
    );
    expect(reread.status, JSON.stringify(reread.error)).toBe(200);
    expect(entry(reread, "token").value).toBe(secret);
  });

  it(
    "refuses the connector's settings 401 when its key is revoked while the read waits",
    { retry: 0 },
    async () => {
      // A failed try can leave the hold armed, which a retry would meet.
      const name = `waiting-${fresh()}`;
      await installed(owner, name);
      expect(
        (
          await owner.setConnectorSettings(name, {
            token: `token-${randomUUID()}`,
          })
        ).status,
      ).toBe(200);
      const connector = await running(origin, owner, host, name);
      await origin.setFault("hold:connector-settings");
      try {
        const waiting = connector.client.readOwnConnectorSettings(
          connector.registration,
        );
        await origin.waitForHold("hold:connector-settings");
        const next = await connectorKey(origin, host, name);
        await origin.clearFault("hold:connector-settings");
        const refused = await waiting;
        expect(refused.status).toBe(401);
        expect(refused.error?.error.code).toBe("unauthorized");

        // The witness: the same wait, with the key still standing, reads.
        const successor = await next.client.registerConnector({ name });
        expect(successor.status, JSON.stringify(successor.error)).toBe(201);
        await origin.setFault("hold:connector-settings");
        const control = next.client.readOwnConnectorSettings(successor.data.id);
        await origin.waitForHold("hold:connector-settings");
        await origin.clearFault("hold:connector-settings");
        expect((await control).status).toBe(200);
      } finally {
        await origin.clearFault();
      }
    },
  );
});

describe("a connector's secret", () => {
  it("is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds a connector's secret, where a setting that is no secret is shown", async () => {
    const name = `hidden-${fresh()}`;
    await installed(owner, name);
    const secret = `secret-${randomUUID()}`;
    const spare = `spare-${randomUUID()}`;
    const visible = `https://visible-${fresh()}.example.test/`;
    const secrets = [secret, spare];
    const answers: string[] = [];
    const keep = <T extends { status: number }>(answer: T): T => {
      answers.push(JSON.stringify(answer));
      return answer;
    };

    const set = keep(
      await owner.setConnectorSettings(name, {
        feed_url: visible,
        token: secret,
        spare,
      }),
    );
    expect(set.status, JSON.stringify(set)).toBe(200);
    // The witness: a value that is no secret is shown back on the same path.
    expect(JSON.stringify(set.data)).toContain(visible);
    const refused = keep(
      await owner.setConnectorSettings(name, { token: ` ${secret} ` }),
    );
    expect(refused.status).toBe(400);
    const connector = await running(origin, owner, host, name);
    const token = await approvedAppToken(origin, ["connectors.manage"]);
    const app = new MarfaClient({ baseUrl: origin.apiUrl, apiKey: token });
    keep(await owner.getConnectorSettings(name));
    keep(await app.getConnectorSettings(name));
    keep(await owner.getPlugin(name));
    keep(await owner.listPlugins());
    keep(await host.client.connectorHostSelf());
    keep(await owner.getConnector(connector.registration));
    keep(await connector.client.getConnector(connector.registration));
    keep(await owner.readOwnConnectorSettings(connector.registration));
    keep(await app.readOwnConnectorSettings(connector.registration));
    keep(
      await ownerOf(origin).readOwnConnectorSettings(connector.registration),
    );
    keep(await host.client.readOwnConnectorSettings(connector.registration));
    keep(await owner.listAudit({ resource_id: name }));
    keep(await ownerOf(origin).rawRequest("/attention"));
    for (const answer of answers) {
      for (const held of secrets) expect(answer).not.toContain(held);
    }

    const audit = await owner.listAudit({
      action: "connector.settings_change",
      resource_id: name,
    });
    expect(audit.status, JSON.stringify(audit.error)).toBe(200);
    expect(audit.data.data).toHaveLength(1);
    expect(audit.data.data[0]).toMatchObject({
      resource_type: "plugin",
      resource_id: name,
      details: { settings: ["feed_url", "token", "spare"] },
    });

    const archive = await owner.exportArchive({ state: "any", files: "false" });
    expect(archive.status).toBe(200);
    const lines = connectorSettingLines(archive.data);
    expect(lines).toContainEqual({
      plugin: name,
      name: "feed_url",
      value: visible,
    });
    expect(lines).toContainEqual({ plugin: name, name: "token", secret: true });
    expect(lines).toContainEqual({ plugin: name, name: "spare", secret: true });
    const instance = JSON.stringify(archiveLines(archive.data, "instance"));
    expect(instance).toContain(visible);
    for (const held of secrets) {
      expect(instance).not.toContain(held);
      expect(Buffer.from(archive.data).toString("latin1")).not.toContain(held);
    }

    const folder = tempFolder("marfa-connector-secret-backups-");
    const local = ownerOf(origin);
    const pointed = await local.patchConfig({ backup_path: folder });
    expect(pointed.status, JSON.stringify(pointed.error)).toBe(200);
    try {
      const run = await local.runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      const backup = filesUnder(folder);
      expect(backup).toContain(visible);
      for (const held of secrets) expect(backup).not.toContain(held);
    } finally {
      await local.patchConfig({ backup_path: null });
    }

    const pages = databasePages(origin);
    expect(pages).toContain(visible);
    for (const held of secrets) expect(pages).not.toContain(held);

    const logs = serverOutput(origin.stateDir);
    expect(logs.length).toBeGreaterThan(0);
    for (const held of secrets) expect(logs).not.toContain(held);
  });

  it("carries the settings in an archive, names each secret without its value, and after a restore onto another machine lists the secret unreadable, on the attention list and unset to the connector", async () => {
    const name = `moved-${fresh()}`;
    await installed(owner, name);
    const set = await owner.setConnectorSettings(name, {
      feed_url: "https://moved.example.test/",
      every: 12,
      token: `token-${randomUUID()}`,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    const archive = await owner.exportArchive({ state: "any", files: "false" });
    expect(archive.status).toBe(200);
    const lines = connectorSettingLines(archive.data).filter(
      (line) => line.plugin === name,
    );
    expect(lines).toEqual([
      { plugin: name, name: "feed_url", value: "https://moved.example.test/" },
      { plugin: name, name: "every", value: 12 },
      { plugin: name, name: "token", secret: true },
    ]);

    // A credential without connectors.manage is given the plugin and none of its settings.
    const exporter = (await ownerKey(origin, ["backups.manage"])).client;
    const narrow = await exporter.exportArchive({
      state: "any",
      files: "false",
    });
    expect(narrow.status).toBe(200);
    expect(
      archiveLines<{ plugin?: { name: string } }>(narrow.data, "instance").some(
        (line) => line.plugin?.name === name,
      ),
    ).toBe(true);
    expect(connectorSettingLines(narrow.data)).toEqual([]);

    const local = ownerOf(destination);
    const restored = await local.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(
      (restored.data as unknown as Record<string, unknown>)
        .connector_secrets_to_set,
    ).toContainEqual({ plugin: name, name: "token" });
    const there = (await ownerKey(destination, OWNER_PERMISSIONS)).client;
    const read = await there.getConnectorSettings(name);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    expect(entry(read, "feed_url")).toMatchObject({
      value: "https://moved.example.test/",
      set: true,
    });
    expect(entry(read, "every")).toMatchObject({ value: 12, set: true });
    expect(entry(read, "token")).toMatchObject({
      value: null,
      set: false,
      unreadable: true,
    });
    expect(entry(read, "spare")).toMatchObject({
      set: false,
      unreadable: false,
    });
    expect(read.data.missing).toEqual(["token"]);
    const reference = `${name}/token`;
    const concerns = (await attentionOf(destination)).filter(
      (concern) => concern.kind === "setting",
    );
    expect(concerns.map((concern) => concern.reference)).toContain(reference);
    expect(concerns.map((concern) => concern.reference)).not.toContain(
      `${name}/spare`,
    );

    const thereHost = await linkedHost(destination, there, `moved ${fresh()}`);
    const connector = await running(destination, there, thereHost, name);
    const own = await connector.client.readOwnConnectorSettings(
      connector.registration,
    );
    expect(own.status, JSON.stringify(own.error)).toBe(200);
    expect(entry(own, "token")).toMatchObject({
      value: null,
      set: false,
      unreadable: true,
    });
    expect(entry(own, "feed_url").value).toBe("https://moved.example.test/");
    expect(own.data.missing).toEqual(["token"]);

    const again = `again-${randomUUID()}`;
    const mended = await there.setConnectorSettings(name, { token: again });
    expect(mended.status, JSON.stringify(mended.error)).toBe(200);
    expect(
      (await attentionOf(destination)).map((concern) => concern.reference),
    ).not.toContain(reference);
    const opened = await connector.client.readOwnConnectorSettings(
      connector.registration,
    );
    expect(entry(opened, "token")).toMatchObject({ value: again, set: true });
  });

  it("refuses a version 3 manifest that leaves out or mistypes connector_setting_count, and restores a version 2 archive without it", async () => {
    const local = ownerOf(destination);
    const archive = (manifest: Record<string, unknown>) =>
      tar([
        { name: "manifest.json", body: JSON.stringify(manifest) },
        lineFile("files", ""),
        lineFile("instance", ndjson([])),
        lineFile("items", ""),
        lineFile("versions", ""),
        lineFile("edges", ""),
        lineFile("rows", ""),
      ]);
    for (const count of [undefined, "0", -1]) {
      const manifest = emptyManifest({
        version: 3,
        connector_setting_count: count,
      });
      if (count === undefined) delete manifest.connector_setting_count;
      const refused = await local.restoreArchive(archive(manifest));
      expect(refused.status, String(count)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(errorPaths(refused)).toEqual(["connector_setting_count"]);
    }
    // The witness: the same version 3 manifest counting no line restores.
    const counted = await local.restoreArchive(
      archive(emptyManifest({ version: 3 })),
    );
    expect(counted.status, JSON.stringify(counted.error)).toBe(200);
    const two = emptyManifest({ version: 2 });
    expect(two).not.toHaveProperty("connector_setting_count");
    const older = await local.restoreArchive(archive(two));
    expect(older.status, JSON.stringify(older.error)).toBe(200);
  });
});

describe("a sealed secret moved by hand", () => {
  let sealed: FreshServer;

  afterAll(async () => {
    await sealed?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("does not open a sealed value copied to another setting's row or to another plugin's connector", async () => {
    sealed = await bootFreshServer("connector-settings-sealed");
    const made = await ownerKey(sealed, OWNER_PERMISSIONS);
    let manager = made.client;
    const first = `first-${fresh()}`;
    const second = `second-${fresh()}`;
    const earlier = `earlier-${fresh()}`;
    for (const name of [first, second, earlier]) {
      await installed(manager, name);
      const set = await manager.setConnectorSettings(name, {
        token: `token-${randomUUID()}`,
        spare: `spare-${randomUUID()}`,
      });
      expect(set.status, JSON.stringify(set.error)).toBe(200);
    }
    const valueOf = (name: string, setting: string): string => {
      const db = new DatabaseSync(sealed.sqlitePath, { readOnly: true });
      try {
        const row = db
          .prepare(
            "SELECT value FROM plugin_connector_settings WHERE plugin = ? AND name = ?",
          )
          .get(name, setting) as { value: string } | undefined;
        expect(row, `${name} ${setting}`).toBeDefined();
        return row!.value;
      } finally {
        db.close();
      }
    };
    const firstToken = valueOf(first, "token");
    const earlierToken = valueOf(earlier, "token");
    // The same plugin, removed and installed again, is another install.
    expect((await manager.removePlugin(earlier)).status).toBe(200);
    await installed(manager, earlier);

    await sealed.restart(() => {
      const db = new DatabaseSync(sealed.sqlitePath);
      try {
        const move = db.prepare(
          "UPDATE plugin_connector_settings SET value = ? WHERE plugin = ? AND name = ?",
        );
        move.run(firstToken, first, "spare");
        move.run(firstToken, second, "token");
        db.prepare(
          "INSERT INTO plugin_connector_settings (plugin, name, value, updated_at) VALUES (?, ?, ?, ?)",
        ).run(earlier, "token", earlierToken, new Date().toISOString());
      } finally {
        db.close();
      }
    });
    manager = new MarfaClient({ baseUrl: sealed.apiUrl, apiKey: made.key });
    const firstRead = await manager.getConnectorSettings(first);
    expect(firstRead.status, JSON.stringify(firstRead.error)).toBe(200);
    // The witness: the value where it was sealed still opens.
    expect(entry(firstRead, "token")).toMatchObject({
      set: true,
      unreadable: false,
    });
    expect(entry(firstRead, "spare")).toMatchObject({
      set: false,
      unreadable: true,
    });
    expect(
      entry(await manager.getConnectorSettings(second), "token"),
    ).toMatchObject({ set: false, unreadable: true });
    expect(
      entry(await manager.getConnectorSettings(earlier), "token"),
    ).toMatchObject({ set: false, unreadable: true });
  });
});

describe("a plugin connector that does not read", () => {
  let unread: FreshServer;

  afterAll(async () => {
    await unread?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("lists every other entry when the record or settings of one plugin's connector do not read, the unreadable secret of a connector that reads among them", async () => {
    // No backup destination, so the attention list always names one.
    unread = await bootFreshServer("connector-settings-unread", {
      MARFA_OBJECT_STORE_BUCKET: "",
    });
    const made = await ownerKey(unread, OWNER_PERMISSIONS);
    const reads = `reads-${fresh()}`;
    const noInstall = `no-install-${fresh()}`;
    const noSettings = `no-settings-${fresh()}`;
    for (const name of [reads, noInstall, noSettings]) {
      await installed(made.client, name);
      const set = await made.client.setConnectorSettings(name, {
        token: `token-${randomUUID()}`,
      });
      expect(set.status, JSON.stringify(set.error)).toBe(200);
    }
    const references = async () =>
      (await attentionOf(unread)).map((concern) => concern.reference);
    expect(await references()).toContain("no_backup_destination");

    await unread.restart(() => {
      const db = new DatabaseSync(unread.sqlitePath);
      try {
        db.prepare(
          "UPDATE plugin_connector_settings SET value = 'sealed elsewhere' WHERE plugin = ? AND name = 'token'",
        ).run(reads);
        db.prepare(
          "UPDATE plugin_connectors SET id = NULL WHERE plugin = ?",
        ).run(noInstall);
        db.prepare(
          "UPDATE plugins SET manifest = json_set(manifest, '$.connector.settings', 'none') WHERE name = ?",
        ).run(noSettings);
      } finally {
        db.close();
      }
    });
    const listed = await attentionOf(unread);
    expect(listed.filter((concern) => concern.kind === "unavailable")).toEqual(
      [],
    );
    const after = listed.map((concern) => concern.reference);
    expect(after).toContain("no_backup_destination");
    expect(after).toContain(`${reads}/token`);
    const warned = serverOutput(unread.stateDir)
      .split("\n")
      .filter((line) => line.includes("settings were not read"))
      .join("\n");
    for (const name of [noInstall, noSettings]) {
      expect(after).not.toContain(`${name}/token`);
      expect(warned).toContain(name);
    }
    expect(warned).not.toContain(reads);
  });
});

describe("a restore of a plugin's connector and connectors.manage", () => {
  const RESTORE_ONLY = "backups.manage";
  const RESTORE_AND_CONNECTORS = "backups.manage connectors.manage";

  /** An app token on the origin whose owner has just signed in. */
  async function restoringApp(scope: string): Promise<MarfaClient> {
    const issuer = await issuerOrigin(origin);
    const app = await registerApp(origin, scope);
    const cookie = await signIn(origin, issuer);
    const tokens = await connect(origin, issuer, cookie, app, scope);
    return new MarfaClient({
      baseUrl: origin.apiUrl,
      apiKey: tokens.access_token!,
    });
  }

  /**
   * An archive of one new note and the plugin's own instance lines as the
   * origin exports them, with the plugin then removed from the origin.
   */
  async function pluginArchive(
    name: string,
  ): Promise<{ archive: Uint8Array; id: string }> {
    const exported = await owner.exportArchive({
      state: "any",
      files: "false",
    });
    expect(exported.status).toBe(200);
    const lines = archiveLines<{
      plugin?: { name: string };
      connector_setting?: { plugin: string };
    }>(exported.data, "instance").filter(
      (line) =>
        line.plugin?.name === name || line.connector_setting?.plugin === name,
    );
    const id = uuidv7();
    const archive = editLineFile(
      itemsArchive(
        [
          {
            id,
            type: "core.note",
            source: "connector-settings-restore",
            source_id: `restore-${randomUUID()}`,
            properties: { title: "restored beside a plugin" },
          },
        ],
        [],
        [],
        (manifest) => ({
          ...manifest,
          version: 3,
          plugin_count: 0,
          app_vendor_count: 0,
          connector_setting_count: 0,
          connector_mapping_count: 0,
        }),
      ),
      "instance",
      () => ndjson(lines),
    );
    expect((await owner.removePlugin(name)).status).toBe(200);
    return { archive, id };
  }

  function expectConnectorsRefused(answer: {
    status: number;
    error?: { error: { code: string; details?: unknown } };
  }): Record<string, unknown> {
    expect(answer.status, JSON.stringify(answer.error)).toBe(403);
    expect(answer.error?.error.code).toBe("forbidden");
    const details = answer.error?.error.details as Record<string, unknown>;
    expect(details.required_scope).toBe("connectors.manage");
    return details;
  }

  async function expectNothingWritten(name: string, id: string): Promise<void> {
    expect((await owner.getPlugin(name)).status).toBe(404);
    expect((await clientsFor(origin).working.getItem(id)).status).toBe(404);
  }

  it("refuses an app without connectors.manage an archive that would restore a plugin with a connector, writing nothing, which an app holding it restores", async () => {
    const name = `restored-${fresh()}`;
    await installed(owner, name);
    const held = await pluginArchive(name);

    const refused = await (
      await restoringApp(RESTORE_ONLY)
    ).restoreArchive(held.archive);
    const details = expectConnectorsRefused(refused);
    expect(details.plugins).toEqual([name]);
    expect(details.connector_settings).toEqual([]);
    await expectNothingWritten(name, held.id);

    const restored = await (
      await restoringApp(RESTORE_AND_CONNECTORS)
    ).restoreArchive(held.archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect((await owner.getPlugin(name)).status).toBe(200);
    expect((await clientsFor(origin).working.getItem(held.id)).status).toBe(
      200,
    );
  });

  it("refuses an app without connectors.manage an archive that would store a connector's settings and a secret to set again, writing nothing, which an app holding it restores", async () => {
    const name = `restored-set-${fresh()}`;
    await installed(owner, name);
    const set = await owner.setConnectorSettings(name, {
      feed_url: "https://restored.example.test/",
      token: `token-${randomUUID()}`,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    const held = await pluginArchive(name);

    const refused = await (
      await restoringApp(RESTORE_ONLY)
    ).restoreArchive(held.archive);
    const details = expectConnectorsRefused(refused);
    expect(details.plugins).toEqual([name]);
    expect(details.connector_settings).toEqual([
      `${name}/feed_url`,
      `${name}/token`,
    ]);
    await expectNothingWritten(name, held.id);

    const restored = await (
      await restoringApp(RESTORE_AND_CONNECTORS)
    ).restoreArchive(held.archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(
      (restored.data as unknown as Record<string, unknown>)
        .connector_secrets_to_set,
    ).toEqual([{ plugin: name, name: "token" }]);
    const read = await owner.getConnectorSettings(name);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    expect(entry(read, "feed_url")).toMatchObject({
      value: "https://restored.example.test/",
      set: true,
    });
    expect(entry(read, "token")).toMatchObject({
      set: false,
      unreadable: true,
    });
  });
});
