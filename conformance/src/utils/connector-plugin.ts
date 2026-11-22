import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { MarfaClient } from "../client/api.js";
import type { FreshServer } from "./fresh-server.js";

/**
 * A plugin with a connector of two kinds, its connector's key, and the
 * owner's ticket type a mapping lands on, for the fixtures of a connector's
 * mapping and its reach. Every name holds a part no earlier run used, so a
 * test body runs again on the same server.
 */
export interface ConnectorPlugin {
  name: string;
  /** The connector's source, which is also the root of the plugin's types. */
  source: string;
  issue: string;
  comment: string;
  /** The owner's type, with a required `reporter`, that a mapping targets. */
  ticket: string;
}

/** A part of a name no earlier run of a test body on this server used. */
export function fresh(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

export function local(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
}

/** A key minted by local authority, holding exactly what it names. */
export async function mint(
  server: FreshServer,
  source: string,
  permissions: string[],
  types: Record<string, string>,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; key: string; client: MarfaClient }> {
  const minted = await local(server).createKey({
    label: source,
    source,
    permissions,
    type_permissions: types,
    edge_permissions: { "*": "write" },
    metadata_permissions: { "*": "write" },
    ...extra,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return {
    id: minted.data.id,
    key: minted.data.key!,
    client: new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    }),
  };
}

export function connectorBundle(
  plugin: ConnectorPlugin,
  connector: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    format: 1,
    name: plugin.name,
    title: "Tracker",
    description: "Issues from a tracker.",
    mark: "lucide:bug",
    maker: "Marfa",
    marfa: "0.0.1",
    version: "1.0.0",
    types: [
      {
        id: plugin.issue,
        parent: "core.task",
        description: "An issue in the tracker.",
        fields: {
          number: { type: "integer" },
          opened_by: { type: "string" },
        },
      },
      {
        id: plugin.comment,
        parent: "core.note",
        description: "A comment on an issue.",
        fields: { author: { type: "string" } },
      },
    ],
    edge_types: [],
    connector: {
      source_name: "Tracker",
      runs: { on: "host" },
      ...(connector ?? {
        source: plugin.source,
        kinds: [
          { name: "issue", type: plugin.issue, direction: "in" },
          {
            name: "comment",
            type: plugin.comment,
            direction: "in",
            default_mapping: { tier: "library" },
          },
        ],
      }),
    },
  };
}

/** The owner's ticket type: a task with a required reporter, a table and fields of several kinds. */
export function ticketType(id: string): Record<string, unknown> {
  return {
    id,
    parent: "core.task",
    fields: {
      reporter: { type: "string", required: true },
      severity: { type: "enum", enum_values: ["low", "high"] },
      opened: { type: "datetime" },
    },
    tables: {
      log: { columns: { line: { type: "string" } } },
    },
  };
}

/**
 * Registers the owner's ticket type and installs the plugin, both as `owner`,
 * with `shape` given the bundle to change before it is sent.
 */
export async function installed(
  owner: MarfaClient,
  shape: (
    bundle: Record<string, any>,
    plugin: ConnectorPlugin,
  ) => void = () => {},
): Promise<ConnectorPlugin> {
  const part = fresh();
  const plugin: ConnectorPlugin = {
    name: `tracker-${part}`,
    source: `trk${part}`,
    issue: `trk${part}.issue`,
    comment: `trk${part}.comment`,
    ticket: `user.ticket${part}`,
  };
  const registered = await owner.registerType(
    ticketType(plugin.ticket) as never,
  );
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  const bundle = connectorBundle(plugin);
  shape(bundle, plugin);
  const made = await owner.installPlugin(bundle);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return plugin;
}

export interface MintedKey {
  id: string;
  key: string;
  client: MarfaClient;
  host: MarfaClient;
}

/**
 * The plugin's connector key, minted by a connector host the plugin is
 * assigned to and returned with that host's client, holding what the mint
 * gave it.
 */
export async function hostMinted(
  server: FreshServer,
  plugin: Pick<ConnectorPlugin, "name">,
): Promise<MintedKey> {
  const owner = local(server);
  const host = await owner.createConnectorHost(`host-${fresh()}`);
  expect(host.status, JSON.stringify(host.error)).toBe(201);
  const redeemed = await owner.redeemConnectorLink({ code: host.data.code });
  expect(redeemed.status, JSON.stringify(redeemed.error)).toBe(201);
  const assigned = await owner.assignConnector(plugin.name, host.data.host.id);
  expect(assigned.status, JSON.stringify(assigned.error)).toBe(200);
  const hostClient = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: redeemed.data.key,
  });
  const minted = await hostClient.mintConnectorKey(plugin.name);
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return {
    id: minted.data.key_id,
    key: minted.data.key,
    client: new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    }),
    host: hostClient,
  };
}

/**
 * The plugin's connector key as `hostMinted` gives it, then set by local
 * authority to purge, to write the plugin's types and every edge type and
 * metadata, with `changes` over that.
 */
export async function connectorKey(
  server: FreshServer,
  plugin: ConnectorPlugin,
  changes: Record<string, unknown> = {},
): Promise<MintedKey> {
  const minted = await hostMinted(server, plugin);
  const set = await local(server).updateKey(minted.id, {
    permissions: ["items.purge"],
    type_permissions: { [`${plugin.source}.*`]: "write" },
    edge_permissions: { "*": "write" },
    metadata_permissions: { "*": "write" },
    ...changes,
  });
  expect(set.status, JSON.stringify(set.error)).toBe(200);
  return minted;
}

/** The mapping that lands `issue` on the owner's ticket type. */
export function onTickets(
  plugin: ConnectorPlugin,
  version: number,
  issue: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version,
    kinds: {
      issue: {
        target_type: plugin.ticket,
        fields: {
          title: { from: "title" },
          reporter: { fixed: "tracker" },
        },
        ...issue,
      },
    },
  };
}

export function paths(error: unknown): string[] {
  const errors = (
    error as { error?: { details?: { errors?: { path: string }[] } } }
  )?.error?.details?.errors;
  return (errors ?? []).map((entry) => entry.path);
}
