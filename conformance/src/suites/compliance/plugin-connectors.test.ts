import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { archiveLines } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  connectorBundle,
  connectorKey,
  connectorSection,
  fresh,
  linkedHost,
  ownerKey,
} from "../../utils/plugin-connector.js";

/**
 * A plugin's connector section, checked at install; the one source each
 * connector holds; what removing the plugin removes and keeps; and the
 * connector's record through an export and a restore. Each server is the
 * fixture's own, since plugins, hosts and sources are the instance's.
 */

let origin: FreshServer;
let destination: FreshServer;
let owner: MarfaClient;

const OWNER_PERMISSIONS = [
  "schema.write",
  "connectors.manage",
  "keys.manage",
  "keys.mint",
  "backups.manage",
];

beforeAll(async () => {
  [origin, destination] = await Promise.all([
    bootFreshServer("plugin-connectors"),
    bootFreshServer("plugin-connectors-destination"),
  ]);
  owner = (await ownerKey(origin, OWNER_PERMISSIONS)).client;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([origin?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

function errorPaths(answer: { error?: { error: { details?: unknown } } }) {
  const errors = (answer.error?.error.details as { errors?: unknown[] })
    ?.errors as { path: string }[] | undefined;
  return (errors ?? []).map((held) => held.path);
}

describe("the connector section", () => {
  it("installs a bundle with a well-formed connector, keeps the section as sent and records the connector with no host", async () => {
    const part = fresh();
    const name = `wellformed-${part}`;
    const type = `wellformed${part}.entry`;
    const connector = connectorSection(type, `wellformed-${part}`, {
      kinds: [
        {
          name: "entry",
          type,
          direction: "both",
          default_mapping: { fields: {} },
        },
      ],
      settings: [
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
        {
          name: "client_id",
          label: "Client ID",
          kind: "text",
          required: false,
        },
        {
          name: "client_secret",
          label: "Client secret",
          kind: "text",
          secret: true,
          required: false,
        },
        {
          name: "token",
          label: "Token",
          kind: "text",
          secret: true,
          required: false,
        },
      ],
      sign_in: {
        kind: "oauth2",
        provider: "google",
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        client_id_setting: "client_id",
        client_secret_setting: "client_secret",
        token_setting: "token",
      },
    });
    const installed = await owner.installPlugin(
      connectorBundle(name, `wellformed${part}`, `wellformed-${part}`, {
        connector,
      }),
    );
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    await expectMatchesSchema("POST", "/plugins", 201, installed.data);
    expect(installed.data.connector).toEqual(connector);
    expect(installed.data.connector_host).toBeNull();
    const read = await owner.getPlugin(name);
    expect(read.data.connector).toEqual(connector);
    expect(read.data.connector_host).toBeNull();
    const listed = await owner.listPlugins();
    expect(
      listed.data.data.find((held) => held.name === name)?.connector,
    ).toEqual(connector);
    const hosts = await owner.listConnectorHosts();
    expect(hosts.status, JSON.stringify(hosts.error)).toBe(200);
    for (const host of hosts.data.data) {
      expect(host.connectors.map((held: any) => held.plugin)).not.toContain(
        name,
      );
    }
    // The record: the connector is the plugin's, so assigning it is taken.
    const host = await owner.createConnectorHost(`wellformed ${part}`);
    const assigned = await owner.assignConnector(name, host.data.host.id);
    expect(assigned.status, JSON.stringify(assigned.error)).toBe(200);
    expect((await owner.getPlugin(name)).data.connector_host).toBe(
      host.data.host.id,
    );
  });

  it("refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing", async () => {
    const part = fresh();
    const root = `malformed${part}`;
    const type = `${root}.entry`;
    const source = `malformed-${part}`;
    const base = connectorSection(type, source);
    const { kinds: _kinds, ...kindless } = base;
    const cases: [string, Record<string, unknown>, string][] = [
      ["unknown key", { ...base, polls: true }, "connector.polls"],
      [
        "unknown key in runs",
        { ...base, runs: { on: "host", where: "mac" } },
        "connector.runs.where",
      ],
      ["no kinds", kindless, "connector.kinds"],
      ["no kind", { ...base, kinds: [] }, "connector.kinds"],
      [
        "a kind type outside the bundle",
        {
          ...base,
          kinds: [{ name: "entry", type: "core.note", direction: "in" }],
        },
        "connector.kinds.0.type",
      ],
      [
        "a direction it does not know",
        { ...base, kinds: [{ name: "entry", type, direction: "sideways" }] },
        "connector.kinds.0.direction",
      ],
      [
        "a choice with no choices",
        {
          ...base,
          settings: [
            { name: "order", label: "Order", kind: "choice", required: false },
          ],
        },
        "connector.settings.0.choices",
      ],
      [
        "a secret with a default",
        {
          ...base,
          settings: [
            {
              name: "token",
              label: "Token",
              kind: "text",
              secret: true,
              default: "shipped",
              required: false,
            },
          ],
        },
        "connector.settings.0.default",
      ],
      [
        "a sign-in naming an undeclared setting",
        {
          ...base,
          settings: [
            { name: "client_id", label: "ID", kind: "text", required: false },
            {
              name: "token",
              label: "Token",
              kind: "text",
              secret: true,
              required: false,
            },
          ],
          sign_in: {
            kind: "oauth2",
            provider: "google",
            scopes: [],
            client_id_setting: "client_id",
            client_secret_setting: "no_such_setting",
            token_setting: "token",
          },
        },
        "connector.sign_in.client_secret_setting",
      ],
      [
        "a sign-in whose token is not secret",
        {
          ...base,
          settings: [
            { name: "client_id", label: "ID", kind: "text", required: false },
            {
              name: "client_secret",
              label: "Secret",
              kind: "text",
              secret: true,
              required: false,
            },
            { name: "token", label: "Token", kind: "text", required: false },
          ],
          sign_in: {
            kind: "oauth2",
            provider: "google",
            scopes: [],
            client_id_setting: "client_id",
            client_secret_setting: "client_secret",
            token_setting: "token",
          },
        },
        "connector.sign_in.token_setting",
      ],
      [
        "no runs",
        (() => {
          const { runs: _runs, ...rest } = base;
          return rest;
        })(),
        "connector.runs",
      ],
    ];
    for (const [label, connector, path] of cases) {
      const refused = await owner.installPlugin(
        connectorBundle(`malformed-${part}`, root, source, { connector }),
      );
      expect(refused.status, label).toBe(400);
      expect(refused.error?.error.code, label).toBe("validation_error");
      expect(errorPaths(refused), label).toContain(path);
      expect((await owner.getPlugin(`malformed-${part}`)).status, label).toBe(
        404,
      );
      expect((await owner.getType(type)).status, label).toBe(404);
    }
    // The witness: the same bundle with the base section installs.
    const taken = await owner.installPlugin(
      connectorBundle(`malformed-${part}`, root, source),
    );
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("refuses 400 validation_error a secret setting of a kind other than text, naming its secret, and installs the same setting as text", async () => {
    const part = fresh();
    const root = `secretkind${part}`;
    const name = `secret-kind-${part}`;
    const base = connectorSection(`${root}.entry`, name);
    const secretOf = (kind: string, extra: Record<string, unknown> = {}) =>
      connectorBundle(name, root, name, {
        connector: {
          ...base,
          settings: [
            { name: "every", label: "Every", kind: "number", required: false },
            {
              name: "token",
              label: "Token",
              kind,
              secret: true,
              required: false,
              ...extra,
            },
          ],
        },
      });
    for (const [kind, extra] of [
      ["choice", { choices: ["one", "two"] }],
      ["number", {}],
      ["boolean", {}],
    ] as const) {
      const refused = await owner.installPlugin(secretOf(kind, extra));
      expect(refused.status, kind).toBe(400);
      expect(refused.error?.error.code, kind).toBe("validation_error");
      expect(errorPaths(refused), kind).toEqual([
        "connector.settings.1.secret",
      ]);
      expect((await owner.getPlugin(name)).status, kind).toBe(404);
    }
    // The witness: the same secret as text installs.
    const taken = await owner.installPlugin(secretOf("text"));
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("refuses a source a key could not hold, two kinds or settings of one name, and a default that does not fit its kind", async () => {
    const part = fresh();
    const root = `limits${part}`;
    const type = `${root}.entry`;
    const base = connectorSection(type, `limits-${part}`);
    const cases: [string, Record<string, unknown>, string][] = [
      ["an empty source", { ...base, source: "" }, "connector.source"],
      ["a padded source", { ...base, source: " padded " }, "connector.source"],
      ["a dot segment", { ...base, source: ".." }, "connector.source"],
      [
        "a source too long",
        { ...base, source: "s".repeat(201) },
        "connector.source",
      ],
      ["an app's source", { ...base, source: "OAuth:app" }, "connector.source"],
      [
        "a restored source",
        { ...base, source: "restored:old" },
        "connector.source",
      ],
      [
        "a host's source",
        { ...base, source: "connector-host:one" },
        "connector.source",
      ],
      [
        "two kinds of one name",
        {
          ...base,
          kinds: [
            { name: "entry", type, direction: "in" },
            { name: "entry", type, direction: "out" },
          ],
        },
        "connector.kinds.1.name",
      ],
      [
        "two settings of one name",
        {
          ...base,
          settings: [
            { name: "url", label: "URL", kind: "text", required: true },
            { name: "url", label: "URL", kind: "text", required: true },
          ],
        },
        "connector.settings.1.name",
      ],
      [
        "a number given as text",
        {
          ...base,
          settings: [
            {
              name: "every",
              label: "Every",
              kind: "number",
              default: "30",
              required: false,
            },
          ],
        },
        "connector.settings.0.default",
      ],
      [
        "a choice it does not offer",
        {
          ...base,
          settings: [
            {
              name: "order",
              label: "Order",
              kind: "choice",
              choices: ["newest"],
              default: "oldest",
              required: false,
            },
          ],
        },
        "connector.settings.0.default",
      ],
      [
        "choices on text",
        {
          ...base,
          settings: [
            {
              name: "url",
              label: "URL",
              kind: "text",
              choices: ["a"],
              required: false,
            },
          ],
        },
        "connector.settings.0.choices",
      ],
    ];
    for (const [label, connector, path] of cases) {
      const refused = await owner.installPlugin(
        connectorBundle(`limits-${part}`, root, `limits-${part}`, {
          connector,
        }),
      );
      expect(refused.status, label).toBe(400);
      expect(refused.error?.error.code, label).toBe("validation_error");
      expect(errorPaths(refused), label).toContain(path);
    }
    const taken = await owner.installPlugin(
      connectorBundle(`limits-${part}`, root, `limits-${part}`),
    );
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });
});

describe("one source, one connector", () => {
  it("refuses 409 connector_source_held a second plugin with the same source, naming the plugin that holds it", async () => {
    const part = fresh();
    const source = `shared-${part}`;
    const first = await owner.installPlugin(
      connectorBundle(`first-${part}`, `first${part}`, source),
    );
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    const second = await owner.installPlugin(
      connectorBundle(`second-${part}`, `second${part}`, source),
    );
    expect(second.status).toBe(409);
    expect(second.error?.error.code).toBe("connector_source_held");
    expect(second.error?.error.details).toMatchObject({
      source,
      plugin: `first-${part}`,
    });
    expect((await owner.getPlugin(`second-${part}`)).status).toBe(404);
    expect((await owner.getType(`second${part}.entry`)).status).toBe(404);
    // The witness: the second plugin under a source of its own installs.
    const own = await owner.installPlugin(
      connectorBundle(`second-${part}`, `second${part}`, `second-${part}`),
    );
    expect(own.status, JSON.stringify(own.error)).toBe(201);
  });

  it("refuses 409 connector_source_held a source a live key holds, naming its registration, and installs once the registration is gone", async () => {
    const part = fresh();
    const source = `selfmade-${part}`;
    const local = new MarfaClient({
      baseUrl: origin.apiUrl,
      controlSocket: origin.controlSocket,
    });
    const made = await local.createKey({
      label: "a connector that registers itself",
      source,
      permissions: [],
      type_permissions: { "core.note": "write" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const bundle = connectorBundle(
      `selfmade-${part}`,
      `selfmade${part}`,
      source,
    );
    const byKey = await owner.installPlugin(bundle);
    expect(byKey.status).toBe(409);
    expect(byKey.error?.error.code).toBe("connector_source_held");
    expect(byKey.error?.error.details).toMatchObject({
      source,
      key_id: made.data.id,
    });
    const connector = new MarfaClient({
      baseUrl: origin.apiUrl,
      apiKey: made.data.key!,
    });
    const registered = await connector.registerConnector({ name: "Self-made" });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const byRegistration = await owner.installPlugin(bundle);
    expect(byRegistration.status).toBe(409);
    expect(byRegistration.error?.error.details).toMatchObject({
      source,
      connector_id: registered.data.id,
    });
    expect((await owner.revokeKey(made.data.id)).status).toBe(200);
    const revokedOnly = await owner.installPlugin(bundle);
    expect(revokedOnly.status).toBe(409);
    expect(revokedOnly.error?.error.details?.connector_id).toBe(
      registered.data.id,
    );
    expect((await owner.deleteConnector(registered.data.id)).status).toBe(200);
    const taken = await owner.installPlugin(bundle);
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("refuses 409 plugin_narrows a newer version that changes the connector's source or drops the connector, and takes one that keeps it", async () => {
    const part = fresh();
    const name = `moving-${part}`;
    const root = `moving${part}`;
    const first = await owner.installPlugin(
      connectorBundle(name, root, `moving-${part}`),
    );
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    const moved = await owner.installPlugin(
      connectorBundle(name, root, `moved-${part}`, { version: "1.1.0" }),
    );
    expect(moved.status).toBe(409);
    expect(moved.error?.error.code).toBe("plugin_narrows");
    expect(JSON.stringify(moved.error?.error.details?.changes)).toContain(
      "connector.source",
    );
    const { connector: _connector, ...bare } = connectorBundle(
      name,
      root,
      `moving-${part}`,
      { version: "1.1.0" },
    );
    const dropped = await owner.installPlugin(bare);
    expect(dropped.status).toBe(409);
    expect(dropped.error?.error.code).toBe("plugin_narrows");
    expect(
      (dropped.error?.error.details?.changes as { path: string }[]).map(
        (held) => held.path,
      ),
    ).toContain("connector");
    expect((await owner.getPlugin(name)).data.version).toBe("1.0.0");
    const kept = await owner.installPlugin(
      connectorBundle(name, root, `moving-${part}`, { version: "1.1.0" }),
    );
    expect(kept.status, JSON.stringify(kept.error)).toBe(200);
    expect(kept.data.outcome).toBe("updated");
  });

  it("refuses a key mint or a claim of a source a plugin's connector holds, naming the plugin", async () => {
    const part = fresh();
    const source = `pluginheld-${part}`;
    const name = `pluginheld-${part}`;
    const installed = await owner.installPlugin(
      connectorBundle(name, `pluginheld${part}`, source),
    );
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    const local = new MarfaClient({
      baseUrl: origin.apiUrl,
      controlSocket: origin.controlSocket,
    });
    for (const minter of [local, owner]) {
      const own = await minter.createKey({
        label: "takes the plugin's source",
        source,
        permissions: [],
      });
      expect(own.status).toBe(409);
      expect(own.error?.error.code).toBe("connector_source_held");
      expect(own.error?.error.details).toMatchObject({ source, plugin: name });
      const claim = await minter.createKey({
        label: "claims the plugin's source",
        source: `claimer-${fresh()}`,
        permissions: [],
        sources: [source],
      });
      expect(claim.status).toBe(409);
      expect(claim.error?.error.details).toMatchObject({
        source,
        plugin: name,
      });
    }
    const plain = await local.createKey({
      label: "claims later",
      source: `later-${part}`,
      permissions: [],
    });
    expect(plain.status, JSON.stringify(plain.error)).toBe(201);
    const widened = await local.updateKey(plain.data.id, { sources: [source] });
    expect(widened.status).toBe(409);
    expect(widened.error?.error.code).toBe("connector_source_held");
    // The witness: the same claim of a source no plugin holds is taken.
    const free = await local.updateKey(plain.data.id, {
      sources: [`free-${part}`],
    });
    expect(free.status, JSON.stringify(free.error)).toBe(200);
  });
});

describe("removing a plugin with a connector", () => {
  it("refuses 403 removing a plugin with a connector to a key without connectors.manage, and keeps it", async () => {
    const part = fresh();
    const name = `kept-${part}`;
    const installed = await owner.installPlugin(
      connectorBundle(name, `kept${part}`, `kept-${part}`),
    );
    expect(installed.status, JSON.stringify(installed.error)).toBe(201);
    const schemaOnly = (await ownerKey(origin, ["schema.write"])).client;
    const refused = await schemaOnly.removePlugin(name);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.details?.required_scope).toBe(
      "connectors.manage",
    );
    expect((await owner.getPlugin(name)).status).toBe(200);
    // The witness: schema.write alone removes a plugin with no connector.
    const { connector: _connector, ...bare } = connectorBundle(
      `bare-${part}`,
      `bare${part}`,
      "unused",
    );
    expect((await owner.installPlugin(bare)).status).toBe(201);
    expect((await schemaOnly.removePlugin(`bare-${part}`)).status).toBe(200);
  });

  it("removes a plugin's connector: revokes its key, removes its registration and record, keeps its types, items, state and agreements, and says which", async () => {
    const part = fresh();
    const name = `removed-${part}`;
    const root = `removed${part}`;
    const source = `removed-${part}`;
    const bundle = connectorBundle(name, root, source);
    expect((await owner.installPlugin(bundle)).status).toBe(201);
    const host = await linkedHost(origin, owner, `removing ${part}`);
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    const connector = await connectorKey(origin, host, name);
    const registered = await connector.client.registerConnector({
      name: "Removed",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const item = await connector.client.createItem({
      type: `${root}.entry`,
      properties: { note: "brought" },
    });
    expect(item.status, JSON.stringify(item.error)).toBe(201);
    const process = randomUUID();
    expect(
      (await connector.client.takeConnectorHold(registered.data.id, process))
        .status,
    ).toBe(200);
    const state = await connector.client.replaceConnectorState(
      registered.data.id,
      { process, state: { cursor: "kept" } },
    );
    expect(state.status, JSON.stringify(state.error)).toBe(200);
    const agreed = await connector.client.writeConnectorAgreements(
      registered.data.id,
      {
        process,
        set: [{ item_id: item.data.item.id, waiting: false, record: {} }],
      },
    );
    expect(agreed.status, JSON.stringify(agreed.error)).toBe(200);

    const removed = await owner.removePlugin(name);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    await expectMatchesSchema("DELETE", "/plugins/{name}", 200, removed.data);
    expect(removed.data).toMatchObject({
      removed: {
        name,
        connector: {
          source,
          key_id: connector.id,
          registrations: [registered.data.id],
        },
      },
      kept: {
        types: [`${root}.entry`],
        connector: { source, state: true, agreements: 1 },
      },
    });
    expect((await connector.client.getCurrentKey()).status).toBe(401);
    expect((await owner.getConnector(registered.data.id)).status).toBe(404);
    expect((await owner.getPlugin(name)).status).toBe(404);
    expect((await owner.getType(`${root}.entry`)).status).toBe(200);
    expect((await owner.getItem(item.data.item.id)).status).toBe(200);
    const listed = await owner.getConnectorHost(host.id);
    expect(listed.data.connectors).toEqual([]);

    // Installed again, the next connector takes up the source's state and agreements.
    expect((await owner.installPlugin(bundle)).status).toBe(201);
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    const next = await connectorKey(origin, host, name);
    const again = await next.client.registerConnector({ name: "Removed" });
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    const read = await next.client.getConnectorState(again.data.id);
    expect(read.data.state).toEqual({ cursor: "kept" });
    const looked = await next.client.lookupConnectorAgreements(again.data.id, [
      item.data.item.id,
    ]);
    expect(looked.data.data).toHaveLength(1);
  });
});

describe("a connector no plugin made", () => {
  it("registers and runs a connector whose key no plugin made, as before", async () => {
    const part = fresh();
    const local = new MarfaClient({
      baseUrl: origin.apiUrl,
      controlSocket: origin.controlSocket,
    });
    const made = await local.createKey({
      label: "a connector of its own",
      source: `standalone-${part}`,
      permissions: [],
      type_permissions: { "core.note": "write" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const connector = new MarfaClient({
      baseUrl: origin.apiUrl,
      apiKey: made.data.key!,
    });
    const registered = await connector.registerConnector({ name: "Alone" });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    expect(registered.data.source).toBe(`standalone-${part}`);
    const beat = await connector.sendConnectorHeartbeat(registered.data.id);
    expect(beat.status).toBe(200);
    const run = await connector.reportConnectorRun(
      {
        outcome: "succeeded",
        started_at: new Date(Date.now() - 1000).toISOString(),
        finished_at: new Date().toISOString(),
      } as never,
      registered.data.id,
    );
    expect(run.status, JSON.stringify(run.error)).toBe(201);
    const note = await connector.createItem({
      type: "core.note",
      properties: { content: "written as before" },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
  });
});

describe("a plugin's connector in an archive", () => {
  it("restores a plugin with a connector with its record and no host or key", async () => {
    const part = fresh();
    const name = `travels-${part}`;
    const source = `travels-${part}`;
    expect(
      (
        await owner.installPlugin(
          connectorBundle(name, `travels${part}`, source),
        )
      ).status,
    ).toBe(201);
    const host = await linkedHost(origin, owner, `travelling ${part}`);
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    await connectorKey(origin, host, name);
    const archive = await owner.exportArchive({ state: "any" });
    expect(archive.status).toBe(200);
    const lines = archiveLines(archive.data, "instance");
    expect(lines.some((line) => "plugin" in line)).toBe(true);
    for (const line of lines) {
      expect(Object.keys(line)).not.toContain("connector_host");
    }
    const local = new MarfaClient({
      baseUrl: destination.apiUrl,
      controlSocket: destination.controlSocket,
    });
    // A source a live key holds on the destination refuses the restore.
    const holder = await local.createKey({
      label: "holds the source",
      source,
      permissions: [],
    });
    expect(holder.status, JSON.stringify(holder.error)).toBe(201);
    const refused = await local.restoreArchive(archive.data);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("connector_source_held");
    expect(refused.error?.error.details?.source).toBe(source);
    const elsewhere = (await ownerKey(destination, OWNER_PERMISSIONS)).client;
    expect((await elsewhere.getPlugin(name)).status).toBe(404);
    expect((await local.revokeKey(holder.data.id)).status).toBe(200);

    const restored = await local.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const read = await elsewhere.getPlugin(name);
    expect(read.status).toBe(200);
    expect(read.data.connector_host).toBeNull();
    const hosts = await elsewhere.listConnectorHosts();
    expect(hosts.data.data).toEqual([]);
    const keys = await elsewhere.listKeys();
    expect(keys.data.data.map((key) => key.source)).not.toContain(source);
    // The record stands: the source is the plugin's, and its connector can be assigned.
    const taken = await local.createKey({
      label: "after the restore",
      source,
      permissions: [],
    });
    expect(taken.status).toBe(409);
    expect(taken.error?.error.details?.plugin).toBe(name);
    const there = await elsewhere.createConnectorHost(`restored ${part}`);
    expect(
      (await elsewhere.assignConnector(name, there.data.host.id)).status,
    ).toBe(200);
  });
});
