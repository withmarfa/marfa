import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  archiveLines,
  archiveManifest,
  editLineFile,
  emptyManifest,
  lineFile,
  listEntries,
  ndjson,
  tar,
} from "../../utils/archive.js";
import {
  type ConnectorPlugin,
  connectorBundle,
  connectorKey,
  fresh,
  installed,
  local,
  mint,
  onTickets,
  paths,
  ticketType,
} from "../../utils/connector-plugin.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
} from "../../utils/signed-in.js";

/**
 * A plugin connector's mapping: read, saved, judged against the types as they
 * stand, rewritten on request, removed with its plugin and carried in an
 * archive (`plugins/mapping-*`, `plugins/rewrite-*`,
 * `archive/archive-connector-mapping`). Each server is the fixture's own,
 * since a plugin is the instance's and an export and a restore are the whole
 * instance's.
 */
let server: FreshServer;
let destination: FreshServer;
let owner: MarfaClient;
let serial = 0;

beforeAll(async () => {
  [server, destination] = await Promise.all([
    bootFreshServer("connector-mapping"),
    bootFreshServer("connector-mapping-destination"),
  ]);
  owner = (
    await mint(
      server,
      "mapping-owner",
      ["schema.write", "connectors.manage", "backups.manage", "audit.read"],
      { "*": "write" },
    )
  ).client;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([server?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

async function another(
  permissions: string[],
  types: Record<string, string> = { "*": "write" },
): Promise<MarfaClient> {
  serial += 1;
  return (
    await mint(
      server,
      `mapping-other-${String(serial)}-${fresh()}`,
      permissions,
      types,
    )
  ).client;
}

async function saved(plugin: ConnectorPlugin, body: Record<string, unknown>) {
  const answer = await owner.saveConnectorMapping(plugin.name, body);
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  return answer.data;
}

describe("reading a mapping", () => {
  it("answers the default mapping to connectors.manage and to the connector's own key, and 403 to another key", async () => {
    const plugin = await installed(owner);
    const read = await owner.getConnectorMapping(plugin.name);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/plugins/{name}/connector/mapping",
      200,
      read.data,
    );
    expect(read.data.version).toBe(0);
    expect(read.data.rewrites).toEqual([]);
    expect(Object.keys(read.data.kinds).sort()).toEqual(["comment", "issue"]);
    expect(read.data.kinds.issue).toMatchObject({
      enabled: true,
      target_type: plugin.issue,
      tier: "feed",
      status_overrides: {},
    });
    expect(read.data.kinds.issue.fields.number).toEqual({ from: "number" });
    expect(read.data.kinds.issue.fields.title).toEqual({ from: "title" });
    expect(read.data.kinds.issue.fields.status).toEqual({ from: "status" });
    expect(read.data.kinds.comment).toMatchObject({
      enabled: true,
      target_type: plugin.comment,
      tier: "library",
    });
    expect(read.data.kinds.comment.fields.author).toEqual({ from: "author" });

    const own = await connectorKey(server, plugin);
    const asConnector = await own.client.getConnectorMapping(plugin.name);
    expect(asConnector.status, JSON.stringify(asConnector.error)).toBe(200);
    expect(asConnector.data).toEqual(read.data);

    const stranger = await another(["schema.write"]);
    const refused = await stranger.getConnectorMapping(plugin.name);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
    expect(refused.error?.error.details?.required_scope).toBe(
      "connectors.manage",
    );
  });

  it("answers 404 plugin_not_found for a plugin not installed and 404 plugin_connector_not_found for one with no connector", async () => {
    const missing = await owner.getConnectorMapping(`absent-${fresh()}`);
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("plugin_not_found");

    const part = fresh();
    const bare = connectorBundle({
      name: `bare-${part}`,
      source: `bare${part}`,
      issue: `bare${part}.issue`,
      comment: `bare${part}.comment`,
      ticket: "",
    });
    delete bare.connector;
    const made = await owner.installPlugin(bare);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const none = await owner.getConnectorMapping(`bare-${part}`);
    expect(none.status).toBe(404);
    expect(none.error?.error.code).toBe("plugin_connector_not_found");
    const noRewrite = await owner.rewriteConnectorItems(`bare-${part}`, {
      dry_run: true,
    });
    expect(noRewrite.error?.error.code).toBe("plugin_connector_not_found");
  });
});

describe("a plugin's default mapping", () => {
  it("refuses at install a default_mapping that names a target type, enabled or a member a kind's mapping does not hold, or a field its own type refuses, naming each path", async () => {
    const part = fresh();
    const plugin: ConnectorPlugin = {
      name: `defaults-${part}`,
      source: `dfl${part}`,
      issue: `dfl${part}.issue`,
      comment: `dfl${part}.comment`,
      ticket: "",
    };
    const bundle = connectorBundle(plugin, {
      source: plugin.source,
      kinds: [
        {
          name: "issue",
          type: plugin.issue,
          direction: "in",
          default_mapping: { enabled: false, colour: "red" },
        },
        {
          name: "comment",
          type: plugin.comment,
          direction: "in",
          default_mapping: { target_type: "core.note", tier: "library" },
        },
      ],
    });
    const refused = await owner.installPlugin(bundle);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(paths(refused.error).sort()).toEqual([
      "connector.kinds.0.default_mapping.colour",
      "connector.kinds.0.default_mapping.enabled",
      "connector.kinds.1.default_mapping.target_type",
    ]);
    expect((await owner.getPlugin(plugin.name)).status).toBe(404);

    // A default of the right shape is judged against the plugin's own types, as a save is.
    const misfit = await owner.installPlugin(
      connectorBundle(plugin, {
        source: plugin.source,
        kinds: [
          {
            name: "issue",
            type: plugin.issue,
            direction: "in",
            default_mapping: {
              fields: {
                title: { from: "title" },
                opened_by: { from: "nothing" },
              },
            },
          },
        ],
      }),
    );
    expect(misfit.status).toBe(400);
    expect(misfit.error?.error.code).toBe("validation_error");
    expect(paths(misfit.error)).toEqual([
      "connector.kinds.0.default_mapping.fields.opened_by.from",
    ]);
    expect((await owner.getPlugin(plugin.name)).status).toBe(404);

    // The witness: the same kinds with a default of tier, fields and overrides alone install,
    // and the mapping, the tier and the reach all read that default.
    const kept = connectorBundle(plugin, {
      source: plugin.source,
      kinds: [
        {
          name: "issue",
          type: plugin.issue,
          direction: "in",
          default_mapping: {
            tier: "library",
            fields: { title: { from: "title" } },
          },
        },
        { name: "comment", type: plugin.comment, direction: "in" },
      ],
    });
    const made = await owner.installPlugin(kept);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const read = await owner.getConnectorMapping(plugin.name);
    expect(read.data.kinds.issue).toEqual({
      enabled: true,
      target_type: plugin.issue,
      tier: "library",
      status_overrides: {},
      fields: { title: { from: "title" } },
    });
    const own = await connectorKey(server, { ...plugin, ticket: "" });
    const issue = await own.client.createItem({
      type: plugin.issue,
      properties: { title: "at the default's tier" },
    });
    expect(issue.status, JSON.stringify(issue.error)).toBe(201);
    expect(issue.data.item.tier).toBe("library");
  });
});

describe("saving a mapping", () => {
  it("saves a mapping that fills a required field with a fixed value, and fills a kind it leaves out with its default", async () => {
    const plugin = await installed(owner);
    const before = await owner.getConnectorMapping(plugin.name);
    const stored = await saved(plugin, onTickets(plugin, 0));
    await expectMatchesSchema(
      "PUT",
      "/plugins/{name}/connector/mapping",
      200,
      stored,
    );
    expect(stored.version).toBe(1);
    expect(stored.kinds.issue).toEqual({
      enabled: true,
      target_type: plugin.ticket,
      tier: "feed",
      status_overrides: {},
      fields: { title: { from: "title" }, reporter: { fixed: "tracker" } },
    });
    expect(stored.kinds.comment).toEqual(before.data.kinds.comment);
    expect((await owner.getConnectorMapping(plugin.name)).data).toEqual(stored);

    const templated = await saved(
      plugin,
      onTickets(plugin, 1, {
        tier: "library",
        fields: {
          title: { from: "title" },
          reporter: { template: "{{ opened_by }}" },
        },
      }),
    );
    expect(templated.version).toBe(2);
    expect(templated.kinds.issue.tier).toBe("library");

    const audit = await owner.listAudit({
      action: "connector.mapping_change",
      resource_id: plugin.name,
    });
    expect(audit.status).toBe(200);
    const versions = audit.data.data.map((entry) => entry.details);
    expect(versions).toContainEqual({ version: 1 });
    expect(versions).toContainEqual({ version: 2 });
  });

  it("stores the fields both types declare for a target type a saved kind names without fields, and its own defaults once it lands back", async () => {
    const plugin = await installed(owner);
    const target = `user.bug${fresh()}`;
    const registered = await owner.registerType({
      id: target,
      parent: "core.task",
      fields: { number: { type: "integer" }, triage: { type: "string" } },
    } as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const before = await owner.getConnectorMapping(plugin.name);
    // The witness: the kind's own default holds a field the target does not declare.
    expect(before.data.kinds.issue.fields.opened_by).toEqual({
      from: "opened_by",
    });
    const moved = await saved(plugin, {
      version: 0,
      kinds: { issue: { target_type: target } },
    });
    const fields = moved.kinds.issue.fields;
    expect(fields.number).toEqual({ from: "number" });
    expect(fields.title).toEqual({ from: "title" });
    expect(Object.keys(fields)).not.toContain("opened_by");
    expect(Object.keys(fields)).not.toContain("triage");
    expect((await owner.getConnectorMapping(plugin.name)).data).toEqual(moved);

    const back = await saved(plugin, {
      version: 1,
      kinds: { issue: { target_type: plugin.issue } },
    });
    expect(back.kinds.issue).toEqual(before.data.kinds.issue);
  });

  it("stores no status overrides for a target type a saved kind names without them, and its own defaults once it lands back", async () => {
    const plugin = await installed(owner, (bundle) => {
      bundle.connector.kinds[0].default_mapping = {
        status_overrides: { in_progress: "completed" },
      };
    });
    const before = await owner.getConnectorMapping(plugin.name);
    // The witness: the kind's own default holds an override the target would take.
    expect(before.data.kinds.issue.status_overrides).toEqual({
      in_progress: "completed",
    });
    const moved = await saved(plugin, onTickets(plugin, 0));
    expect(moved.kinds.issue.status_overrides).toEqual({});
    expect((await owner.getConnectorMapping(plugin.name)).data).toEqual(moved);

    const kept = await saved(
      plugin,
      onTickets(plugin, 1, { status_overrides: { in_progress: "completed" } }),
    );
    expect(kept.kinds.issue.status_overrides).toEqual({
      in_progress: "completed",
    });

    const back = await saved(plugin, {
      version: 2,
      kinds: { issue: { target_type: plugin.issue } },
    });
    expect(back.kinds.issue).toEqual(before.data.kinds.issue);
  });

  it("refuses a mapping that leaves a required field of the target type unfilled, naming the field", async () => {
    const plugin = await installed(owner);
    const refused = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 0, { fields: { title: { from: "title" } } }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(paths(refused.error)).toEqual(["kinds.issue.fields.reporter"]);
    expect((await owner.getConnectorMapping(plugin.name)).data.version).toBe(0);
    // The witness: the same mapping with the field filled is saved.
    await saved(plugin, onTickets(plugin, 0));
  });

  it("refuses a from naming no field of the kind's own type, a fixed value the field refuses, a template on a field that is not text and an unknown field", async () => {
    const plugin = await installed(owner);
    const refused = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 0, {
        fields: {
          title: { from: "headline" },
          reporter: { fixed: "tracker" },
          severity: { fixed: "medium" },
          opened: { template: "{{ number }}" },
          shelf: { from: "title" },
        },
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(paths(refused.error).sort()).toEqual([
      "kinds.issue.fields.opened.template",
      "kinds.issue.fields.severity.fixed",
      "kinds.issue.fields.shelf",
      "kinds.issue.fields.title.from",
    ]);
    // The witness: each field filled in a way the types take is saved.
    await saved(
      plugin,
      onTickets(plugin, 0, {
        fields: {
          title: { from: "title" },
          reporter: { fixed: "tracker" },
          severity: { fixed: "high" },
          opened: { from: "due_at" },
        },
      }),
    );
  });

  it("refuses a status override naming a word either type does not declare", async () => {
    const plugin = await installed(owner);
    const overridden = (overrides: Record<string, string>) =>
      owner.saveConnectorMapping(
        plugin.name,
        onTickets(plugin, 0, {
          status_overrides: overrides,
          fields: {
            title: { from: "title" },
            reporter: { fixed: "tracker" },
            status: { from: "status" },
          },
        }),
      );
    const refused = await overridden({
      shelved: "completed",
      in_progress: "parked",
    });
    expect(refused.status).toBe(400);
    expect(paths(refused.error).sort()).toEqual([
      "kinds.issue.status_overrides.in_progress",
      "kinds.issue.status_overrides.shelved",
    ]);
    const taken = await overridden({ in_progress: "completed" });
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
    expect(taken.data.kinds.issue.status_overrides).toEqual({
      in_progress: "completed",
    });
  });

  it("refuses 400 validation_error a mapping whose shape is wrong, naming each path", async () => {
    const plugin = await installed(owner);
    const refused = await owner.saveConnectorMapping(plugin.name, {
      version: 0,
      extra: true,
      kinds: {
        issue: {
          enabled: "yes",
          tier: "archive",
          colour: "red",
          status_overrides: { open: 1 },
          fields: {
            title: { from: "title", fixed: "both" },
            body: { template: 3 },
            reporter: "tracker",
          },
        },
        ghost: {},
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(paths(refused.error).sort()).toEqual([
      "extra",
      "kinds.ghost",
      "kinds.issue.colour",
      "kinds.issue.enabled",
      "kinds.issue.fields.body",
      "kinds.issue.fields.reporter",
      "kinds.issue.fields.title",
      "kinds.issue.status_overrides.open",
      "kinds.issue.tier",
    ]);
    const unversioned = await owner.saveConnectorMapping(plugin.name, {
      kinds: {},
    });
    expect(paths(unversioned.error)).toEqual(["version"]);
    expect((await owner.getConnectorMapping(plugin.name)).data.version).toBe(0);
  });

  it("refuses a target type that is not registered, is a system type or that the caller may not write", async () => {
    const plugin = await installed(owner);
    for (const target of [`user.absent${fresh()}`, "system.view"]) {
      const refused = await owner.saveConnectorMapping(plugin.name, {
        version: 0,
        kinds: { issue: { target_type: target, fields: {} } },
      });
      expect(refused.status, target).toBe(400);
      expect(paths(refused.error), target).toEqual(["kinds.issue.target_type"]);
    }
    const narrow = await another(["connectors.manage"], {
      [`${plugin.source}.*`]: "write",
      [plugin.ticket]: "read",
    });
    const unwritable = await narrow.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 0),
    );
    expect(unwritable.status).toBe(400);
    expect(paths(unwritable.error)).toEqual(["kinds.issue.target_type"]);
    // The witness: a key that writes the ticket type saves the same mapping.
    const writer = await another(["connectors.manage"], {
      [`${plugin.source}.*`]: "write",
      [plugin.ticket]: "write",
    });
    const taken = await writer.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 0),
    );
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("saves a disabled kind whose target type is not registered, and refuses the same kind enabled", async () => {
    const plugin = await installed(owner);
    const gone = `user.gone${fresh()}`;
    const enabled = await owner.saveConnectorMapping(plugin.name, {
      version: 0,
      kinds: { issue: { target_type: gone } },
    });
    expect(enabled.status).toBe(400);
    expect(paths(enabled.error)).toEqual(["kinds.issue.target_type"]);
    const off = await saved(plugin, {
      version: 0,
      kinds: { issue: { enabled: false, target_type: gone } },
    });
    expect(off.kinds.issue).toMatchObject({
      enabled: false,
      target_type: gone,
    });
  });

  it("judges a save against a type changed after the mapping was read", async () => {
    const plugin = await installed(owner);
    const read = await owner.getConnectorMapping(plugin.name);
    const later = `user.later${fresh()}`;
    const early = await owner.saveConnectorMapping(plugin.name, {
      version: read.data.version,
      kinds: { issue: { target_type: later, fields: {} } },
    });
    expect(paths(early.error)).toEqual(["kinds.issue.target_type"]);
    const made = await owner.registerType({
      id: later,
      fields: { title: { type: "string" } },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const taken = await saved(plugin, {
      version: read.data.version,
      kinds: {
        issue: { target_type: later, fields: { title: { from: "title" } } },
      },
    });
    expect(taken.kinds.issue.target_type).toBe(later);

    const dropping = `user.dropping${fresh()}`;
    const registered = await owner.registerType(ticketType(dropping) as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const current = await owner.getConnectorMapping(plugin.name);
    expect((await owner.deleteType(dropping)).status).toBe(200);
    const refused = await owner.saveConnectorMapping(plugin.name, {
      version: current.data.version,
      kinds: {
        issue: {
          target_type: dropping,
          fields: { title: { from: "title" }, reporter: { fixed: "x" } },
        },
      },
    });
    expect(paths(refused.error)).toEqual(["kinds.issue.target_type"]);
  });

  it("refuses 409 connector_mapping_stale a save naming a version that is no longer current", async () => {
    const plugin = await installed(owner);
    await saved(plugin, onTickets(plugin, 0));
    const stale = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 0, { tier: "library" }),
    );
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("connector_mapping_stale");
    expect(stale.error?.error.details?.version).toBe(1);
    const held = await owner.getConnectorMapping(plugin.name);
    expect(held.data.version).toBe(1);
    expect(held.data.kinds.issue.tier).toBe("feed");
  });

  it("refuses 403 a save from the connector's own key and from a key without connectors.manage", async () => {
    const plugin = await installed(owner);
    const own = await connectorKey(server, plugin);
    const stranger = await another(["schema.write"]);
    for (const caller of [own.client, stranger]) {
      const refused = await caller.saveConnectorMapping(
        plugin.name,
        onTickets(plugin, 0),
      );
      expect(refused.status).toBe(403);
      expect(refused.error?.error.details?.required_scope).toBe(
        "connectors.manage",
      );
    }
    expect((await owner.getConnectorMapping(plugin.name)).data.version).toBe(0);
  });

  it("removes the mapping with the plugin, and answers the default once it is installed again", async () => {
    const plugin = await installed(owner);
    await saved(plugin, onTickets(plugin, 0));
    const rewrite = await owner.rewriteConnectorItems(plugin.name, {});
    expect(rewrite.status, JSON.stringify(rewrite.error)).toBe(200);
    expect((await owner.removePlugin(plugin.name)).status).toBe(200);
    const gone = await owner.getConnectorMapping(plugin.name);
    expect(gone.error?.error.code).toBe("plugin_not_found");
    const again = await owner.installPlugin(connectorBundle(plugin));
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    const read = await owner.getConnectorMapping(plugin.name);
    expect(read.data.version).toBe(0);
    expect(read.data.rewrites).toEqual([]);
    expect(read.data.kinds.issue.target_type).toBe(plugin.issue);
  });
});

describe("rewriting existing items", () => {
  it("counts exactly the items under the connector's source that a rewrite would move onto a kind's target type, from its own type and from a type it was mapped onto before, and changes no item on a save or a rewrite", async () => {
    const plugin = await installed(owner);
    const own = await connectorKey(server, plugin);
    await saved(plugin, onTickets(plugin, 0));
    const made: { id: string; version: number }[] = [];
    for (const title of ["first", "second", "binned"]) {
      const item = await own.client.createItem({
        type: plugin.ticket,
        properties: { title, reporter: "tracker" },
      });
      expect(item.status, JSON.stringify(item.error)).toBe(201);
      made.push({ id: item.data.item.id, version: item.data.item.version });
    }
    const binned = made.pop()!;
    expect((await own.client.deleteItem(binned.id)).status).toBe(200);
    const ownType = await own.client.createItem({
      type: plugin.issue,
      properties: { title: "its own type" },
    });
    expect(ownType.status).toBe(201);
    const owners = await owner.createItem({
      type: plugin.ticket,
      properties: { title: "the owner's", reporter: "me" },
    });
    expect(owners.status).toBe(201);
    made.push(
      { id: ownType.data.item.id, version: ownType.data.item.version },
      { id: owners.data.item.id, version: owners.data.item.version },
    );

    const counted = await owner.rewriteConnectorItems(plugin.name, {
      dry_run: true,
    });
    expect(counted.status, JSON.stringify(counted.error)).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/plugins/{name}/connector/mapping/rewrite",
      200,
      counted.data,
    );
    expect(counted.data).toEqual({
      dry_run: true,
      version: 1,
      kinds: {
        issue: { target_type: plugin.ticket, count: 1 },
        comment: { target_type: plugin.comment, count: 0 },
      },
    });
    expect(
      (await owner.getConnectorMapping(plugin.name)).data.rewrites,
    ).toEqual([]);

    await saved(plugin, {
      version: 1,
      kinds: { issue: { target_type: plugin.issue, tier: "library" } },
    });
    const back = await owner.rewriteConnectorItems(plugin.name, {
      dry_run: true,
      kinds: ["issue"],
    });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    expect(back.data.kinds).toEqual({
      issue: { target_type: plugin.issue, count: 2 },
    });
    const asked = await owner.rewriteConnectorItems(plugin.name, {
      kinds: ["issue"],
    });
    expect(asked.status, JSON.stringify(asked.error)).toBe(200);
    expect(asked.data).toEqual({
      dry_run: false,
      number: expect.any(Number),
      version: 2,
      kinds: { issue: { target_type: plugin.issue, count: 2 } },
    });
    for (const { id, version } of made) {
      const read = await owner.getItem(id);
      expect(read.data.item.version, id).toBe(version);
    }
  });

  it("stores each rewrite request under its own number, which the connector clears one at a time, and refuses another key clearing one", async () => {
    const plugin = await installed(owner);
    const own = await connectorKey(server, plugin);
    await saved(plugin, onTickets(plugin, 0));
    const unknown = await owner.rewriteConnectorItems(plugin.name, {
      kinds: ["issue", "ghost"],
      dry_run: "no",
    });
    expect(unknown.status).toBe(400);
    expect(paths(unknown.error).sort()).toEqual(["dry_run", "kinds.1"]);
    const stranger = await another(["schema.write"]);
    const forbidden = await stranger.rewriteConnectorItems(plugin.name, {});
    expect(forbidden.status).toBe(403);
    expect(forbidden.error?.error.details?.required_scope).toBe(
      "connectors.manage",
    );
    expect(
      (await owner.getConnectorMapping(plugin.name)).data.rewrites,
    ).toEqual([]);

    const first = await owner.rewriteConnectorItems(plugin.name, {
      kinds: ["issue"],
    });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const second = await owner.rewriteConnectorItems(plugin.name, {});
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    expect(second.data.version).toBe(first.data.version);
    expect(second.data.number).toBeGreaterThan(first.data.number!);
    const pending = await own.client.getConnectorMapping(plugin.name);
    expect(pending.data.rewrites).toEqual([
      {
        number: first.data.number,
        version: 1,
        kinds: ["issue"],
        from: { issue: [plugin.issue] },
        requested_at: expect.any(String),
      },
      {
        number: second.data.number,
        version: 1,
        kinds: ["issue", "comment"].sort(),
        from: { issue: [plugin.issue], comment: [] },
        requested_at: expect.any(String),
      },
    ]);

    const byOwner = await owner.finishConnectorRewrite(plugin.name, {
      number: first.data.number,
    });
    expect(byOwner.status).toBe(403);
    const unnamed = await own.client.finishConnectorRewrite(plugin.name, {
      version: 1,
    });
    expect(unnamed.status).toBe(400);
    expect(paths(unnamed.error).sort()).toEqual(["number", "version"]);
    expect(
      (await owner.getConnectorMapping(plugin.name)).data.rewrites,
    ).toHaveLength(2);

    const done = await own.client.finishConnectorRewrite(plugin.name, {
      number: first.data.number,
    });
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/plugins/{name}/connector/mapping/rewrite/done",
      200,
      done.data,
    );
    expect(done.data.rewrites.map((held) => held.number)).toEqual([
      second.data.number,
    ]);
    expect(
      (await owner.getConnectorMapping(plugin.name)).data.rewrites.map(
        (held) => held.number,
      ),
    ).toEqual([second.data.number]);
    const again = await own.client.finishConnectorRewrite(plugin.name, {
      number: first.data.number,
    });
    expect(again.status).toBe(200);
    expect(again.data.rewrites).toHaveLength(1);

    // A number is never given again, even once every request is cleared.
    await own.client.finishConnectorRewrite(plugin.name, {
      number: second.data.number,
    });
    const third = await owner.rewriteConnectorItems(plugin.name, {});
    expect(third.data.number).toBeGreaterThan(second.data.number!);
  });
});

async function appToken(target: FreshServer, scope: string) {
  const issuer = await issuerOrigin(target);
  const app = await registerApp(target, scope);
  const tokens = await connect(
    target,
    issuer,
    await signIn(target, issuer),
    app,
    scope,
  );
  const { MarfaClient } = await import("../../client/api.js");
  return new MarfaClient({
    baseUrl: target.apiUrl,
    apiKey: tokens.access_token,
  });
}

describe("a mapping in an archive", () => {
  it("keeps the mapping through an export and a restore, restores a version 2 archive, and refuses a mapping line to a key without connectors.manage", async () => {
    const plugin = await installed(owner);
    const mapping = await saved(plugin, onTickets(plugin, 0));
    const archive = await owner.exportArchive({ state: "any" });
    expect(archive.status).toBe(200);
    const manifest = archiveManifest(archive.data);
    expect(manifest.version).toBe(4);
    const lines = archiveLines(archive.data, "instance").filter(
      (line) => "connector_mapping" in line,
    );
    expect(lines).toContainEqual({
      connector_mapping: {
        plugin: plugin.name,
        version: 1,
        kinds: mapping.kinds,
        former_targets: {},
        rewrites: [],
      },
    });
    expect(manifest.connector_mapping_count).toBe(lines.length);

    const unmanaged = await mint(
      server,
      `mapping-unmanaged-${fresh()}`,
      ["backups.manage"],
      { "*": "write" },
    );
    const withheld = await unmanaged.client.exportArchive({ state: "any" });
    expect(withheld.status).toBe(200);
    expect(
      archiveLines(withheld.data, "instance").filter(
        (line) => "connector_mapping" in line,
      ),
    ).toEqual([]);

    const app = await appToken(destination, "backups.manage schema.write");
    // A plugin with a connector the instance lacks and its mapping: one refusal names both.
    const refused = await app.restoreArchive(archive.data);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.details?.required_scope).toBe(
      "connectors.manage",
    );
    expect(refused.error?.error.details?.plugins).toContain(plugin.name);
    expect(refused.error?.error.details?.connector_mappings).toContain(
      plugin.name,
    );
    expect((await local(destination).getPlugin(plugin.name)).status).toBe(404);
    const unmapped = editLineFile(archive.data, "instance", (text) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith('{"connector_mapping"'))
        .join("\n"),
    );
    // Once the plugins are recorded, the mapping alone is refused.
    const recorded = await local(destination).restoreArchive(unmapped);
    expect(recorded.status, JSON.stringify(recorded.error)).toBe(200);
    const mappedOnly = await app.restoreArchive(archive.data);
    expect(mappedOnly.status).toBe(403);
    expect(mappedOnly.error?.error.details).toMatchObject({
      required_scope: "connectors.manage",
      plugins: [],
      connector_settings: [],
    });
    expect(mappedOnly.error?.error.details?.connector_mappings).toContain(
      plugin.name,
    );
    // The witness: the same archive without its mapping lines restores for the app.
    const plain = await app.restoreArchive(unmapped);
    expect(plain.status, JSON.stringify(plain.error)).toBe(200);
    expect(plain.data).toMatchObject({ connector_mappings_added: 0 });

    const restored = await local(destination).restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({
      connector_mappings_added: lines.length,
      connector_mappings_skipped: 0,
    });
    const read = await local(destination).getConnectorMapping(plugin.name);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    expect(read.data).toEqual(mapping);

    const again = await local(destination).restoreArchive(archive.data);
    expect(again.data).toMatchObject({
      connector_mappings_added: 0,
      connector_mappings_skipped: lines.length,
    });

    const orphan = tar([
      {
        name: "manifest.json",
        body: JSON.stringify(
          emptyManifest({ version: 3, connector_mapping_count: 1 }),
        ),
      },
      lineFile("files", ""),
      lineFile(
        "instance",
        ndjson([
          {
            connector_mapping: {
              plugin: `absent-${fresh()}`,
              version: 1,
              kinds: {},
            },
          },
        ]),
      ),
      lineFile("items", ""),
      lineFile("versions", ""),
      lineFile("edges", ""),
      lineFile("rows", ""),
    ]);
    const unheld = await local(destination).restoreArchive(orphan);
    expect(unheld.status).toBe(400);
    expect(unheld.error?.error.code).toBe("validation_error");
    expect(unheld.error?.error.details).toMatchObject({
      entry: "instance.ndjson.gz",
      line: 1,
    });

    const versionTwo = tar([
      {
        name: "manifest.json",
        body: JSON.stringify(emptyManifest({ version: 2 })),
      },
      lineFile("files", ""),
      lineFile("instance", ""),
      lineFile("items", ""),
      lineFile("versions", ""),
      lineFile("edges", ""),
      lineFile("rows", ""),
    ]);
    const older = await local(destination).restoreArchive(versionTwo);
    expect(older.status, JSON.stringify(older.error)).toBe(200);
  });

  it(
    "keeps a kind's former targets and open rewrites through an export and a restore, so a rewrite on the restored instance moves every one of the connector's own items back",
    async () => {
      const plugin = await installed(owner);
      const own = await connectorKey(server, plugin);
      await saved(plugin, onTickets(plugin, 0));
      const mine = [];
      for (const title of ["first", "second", "third"]) {
        const made = await own.client.createItem({
          type: plugin.ticket,
          source_id: `kept-${fresh()}`,
          properties: { title, reporter: "tracker" },
        });
        expect(made.status, JSON.stringify(made.error)).toBe(201);
        mine.push(made.data.item);
      }
      const owners = await owner.createItem({
        type: plugin.ticket,
        properties: { title: "the owner's", reporter: "me" },
      });
      expect(owners.status).toBe(201);
      await saved(plugin, {
        version: 1,
        kinds: { issue: { target_type: plugin.issue } },
      });
      const asked = await owner.rewriteConnectorItems(plugin.name, {
        kinds: ["issue"],
      });
      expect(asked.status, JSON.stringify(asked.error)).toBe(200);
      const pending = (await owner.getConnectorMapping(plugin.name)).data
        .rewrites;
      expect(pending).toHaveLength(1);

      const archive = await owner.exportArchive({ state: "any" });
      expect(archive.status).toBe(200);
      const line = archiveLines<{
        connector_mapping?: Record<string, unknown>;
      }>(archive.data, "instance").find(
        (held) => held.connector_mapping?.plugin === plugin.name,
      );
      expect(line?.connector_mapping).toMatchObject({
        version: 2,
        former_targets: { issue: [plugin.ticket] },
        rewrites: [
          {
            version: 2,
            kinds: ["issue"],
            requested_at: pending[0]!.requested_at,
          },
        ],
      });

      const target = await bootFreshServer("connector-mapping-former");
      try {
        const restored = await local(target).restoreArchive(archive.data);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        const carried = await local(target).getConnectorMapping(plugin.name);
        expect(carried.status, JSON.stringify(carried.error)).toBe(200);
        expect(carried.data.version).toBe(2);
        expect(carried.data.rewrites).toEqual([
          {
            number: expect.any(Number),
            version: 2,
            kinds: ["issue"],
            from: { issue: [plugin.ticket] },
            requested_at: pending[0]!.requested_at,
          },
        ]);
        const again = await local(target).rewriteConnectorItems(plugin.name, {
          kinds: ["issue"],
        });
        expect(again.status, JSON.stringify(again.error)).toBe(200);
        expect(again.data.kinds).toEqual({
          issue: { target_type: plugin.issue, count: 3 },
        });

        const key = await connectorKey(target, plugin);
        const listed = await key.client.listItems({ type: plugin.ticket });
        expect(listed.status, JSON.stringify(listed.error)).toBe(200);
        expect(listed.data.data.map((item) => item.id).sort()).toEqual(
          mine.map((item) => item.id).sort(),
        );
        for (const item of mine) {
          const back = await key.client.updateItem(item.id, {
            version: item.version,
            type: plugin.issue,
            retype: true,
          });
          expect(back.status, JSON.stringify(back.error)).toBe(200);
          expect(back.data.item.type).toBe(plugin.issue);
        }
        for (const number of [carried.data.rewrites[0]!.number, again.data.number]) {
          const done = await key.client.finishConnectorRewrite(plugin.name, {
            number,
          });
          expect(done.status, JSON.stringify(done.error)).toBe(200);
        }
        const left = await local(target).rewriteConnectorItems(plugin.name, {
          dry_run: true,
          kinds: ["issue"],
        });
        expect(left.data.kinds.issue?.count).toBe(0);
        const reader = await mint(target, `reader-${fresh()}`, [], {
          "*": "read",
        });
        const theirs = await reader.client.getItem(owners.data.item.id);
        expect(theirs.status, JSON.stringify(theirs.error)).toBe(200);
        expect(theirs.data.item.type).toBe(plugin.ticket);
      } finally {
        await target.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it("refuses a version 4 mapping line that leaves out its former targets or rewrites, naming its line, and restores a version 3 line without them", async () => {
    const plugin = await installed(owner);
    await saved(plugin, onTickets(plugin, 0));
    await saved(plugin, {
      version: 1,
      kinds: { issue: { target_type: plugin.issue } },
    });
    const archive = await owner.exportArchive({ state: "any" });
    expect(archive.status).toBe(200);
    const without = (field: string) => {
      let line = 0;
      const edited = editLineFile(archive.data, "instance", (text) =>
        text
          .split("\n")
          .map((held, at) => {
            if (!held.startsWith('{"connector_mapping"')) return held;
            const parsed = JSON.parse(held) as {
              connector_mapping: Record<string, unknown>;
            };
            if (parsed.connector_mapping.plugin !== plugin.name) return held;
            line = at + 1;
            delete parsed.connector_mapping[field];
            return JSON.stringify(parsed);
          })
          .join("\n"),
      );
      expect(line).toBeGreaterThan(0);
      return { edited, line };
    };
    for (const field of ["former_targets", "rewrites"]) {
      const { edited, line } = without(field);
      const refused = await local(destination).restoreArchive(edited);
      expect(refused.status, field).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details).toMatchObject({
        entry: "instance.ndjson.gz",
        line,
      });
    }
    expect(
      (await local(destination).getConnectorMapping(plugin.name)).status,
    ).toBe(404);

    const atThree = tar(
      listEntries(without("former_targets").edited).map((entry) =>
        entry.name === "manifest.json"
          ? {
              name: entry.name,
              body: JSON.stringify({
                ...(JSON.parse(entry.body.toString("utf8")) as object),
                version: 3,
              }),
            }
          : { name: entry.name, body: entry.body },
      ),
    );
    const restored = await local(destination).restoreArchive(atThree);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const read = await local(destination).getConnectorMapping(plugin.name);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    expect(read.data.version).toBe(2);
  });

  it(
    "refuses a restore whose plugin's default_mapping installing would refuse, naming its line, and restores nothing",
    async () => {
      const plugin = await installed(owner);
      const archive = await owner.exportArchive({ state: "any" });
      expect(archive.status).toBe(200);
      const withDefault = (fault: Record<string, unknown>) => {
        let line = 0;
        const edited = editLineFile(archive.data, "instance", (text) =>
          text
            .split("\n")
            .map((held, at) => {
              if (!held.startsWith('{"plugin"')) return held;
              const parsed = JSON.parse(held) as {
                plugin: {
                  name: string;
                  bundle: {
                    connector: { kinds: Record<string, unknown>[] };
                  };
                };
              };
              if (parsed.plugin.name !== plugin.name) return held;
              line = at + 1;
              parsed.plugin.bundle.connector.kinds[0]!.default_mapping = fault;
              return JSON.stringify(parsed);
            })
            .join("\n"),
        );
        expect(line).toBeGreaterThan(0);
        return { edited, line };
      };
      const target = await bootFreshServer("connector-mapping-defaults");
      try {
        const shape = withDefault({ enabled: false });
        const misshapen = await local(target).restoreArchive(shape.edited);
        expect(misshapen.status).toBe(400);
        expect(misshapen.error?.error.code).toBe("validation_error");
        expect(misshapen.error?.error.details).toMatchObject({
          entry: "instance.ndjson.gz",
          line: shape.line,
        });

        const misfit = withDefault({
          fields: { title: { from: "title" }, opened_by: { from: "nothing" } },
        });
        const judged = await local(target).restoreArchive(misfit.edited);
        expect(judged.status).toBe(400);
        expect(judged.error?.error.code).toBe("validation_error");
        expect(judged.error?.error.details).toMatchObject({
          entry: "instance.ndjson.gz",
          line: misfit.line,
          name: plugin.name,
        });
        expect(paths(judged.error)).toEqual([
          "connector.kinds.0.default_mapping.fields.opened_by.from",
        ]);
        expect((await local(target).getPlugin(plugin.name)).status).toBe(404);

        // The witness: the archive as written restores whole.
        const restored = await local(target).restoreArchive(archive.data);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect((await local(target).getPlugin(plugin.name)).status).toBe(200);
      } finally {
        await target.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a restore whose mapping the types as restored would refuse, naming its line, and restores nothing",
    async () => {
      const plugin = await installed(owner);
      await saved(plugin, onTickets(plugin, 0));
      const archive = await owner.exportArchive({ state: "any" });
      expect(archive.status).toBe(200);
      let line = 0;
      const unfilled = editLineFile(archive.data, "instance", (text) =>
        text
          .split("\n")
          .map((held, at) => {
            if (!held.startsWith('{"connector_mapping"')) return held;
            const parsed = JSON.parse(held) as {
              connector_mapping: {
                plugin: string;
                kinds: Record<string, { fields: Record<string, unknown> }>;
              };
            };
            if (parsed.connector_mapping.plugin !== plugin.name) return held;
            line = at + 1;
            delete parsed.connector_mapping.kinds.issue!.fields.reporter;
            return JSON.stringify(parsed);
          })
          .join("\n"),
      );
      expect(line).toBeGreaterThan(0);
      const target = await bootFreshServer("connector-mapping-judged");
      try {
        const refused = await local(target).restoreArchive(unfilled);
        expect(refused.status).toBe(400);
        expect(refused.error?.error.code).toBe("validation_error");
        expect(refused.error?.error.details).toMatchObject({
          entry: "instance.ndjson.gz",
          line,
          plugin: plugin.name,
        });
        expect(paths(refused.error).sort()).toEqual([
          "kinds.issue.fields.reporter",
        ]);
        expect((await local(target).getPlugin(plugin.name)).status).toBe(404);
        // The witness: the archive as written restores whole.
        const restored = await local(target).restoreArchive(archive.data);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(
          (await local(target).getConnectorMapping(plugin.name)).data.version,
        ).toBe(1);
      } finally {
        await target.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
