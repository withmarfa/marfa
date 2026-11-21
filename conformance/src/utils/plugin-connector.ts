import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { MarfaClient } from "../client/api.js";
import type { FreshServer } from "./fresh-server.js";

/**
 * What the fixtures of a plugin's connector share: a bundle with a connector
 * section, keys minted by local authority, and a connector host linked once.
 */

/** A part of a name or id that no earlier run of a test body on this server used. */
export function fresh(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

/** A connector section whose one kind is `type`, writing under `source`. */
export function connectorSection(
  type: string,
  source: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source,
    source_name: "Example service",
    source_mark: "lucide:rss",
    kinds: [{ name: "entry", type, direction: "in" }],
    runs: { on: "host" },
    ...extra,
  };
}

/** A bundle of one type, `<root>.entry`, and a connector writing it under `source`. */
export function connectorBundle(
  name: string,
  root: string,
  source: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> & { types: Record<string, unknown>[] } {
  const type = `${root}.entry`;
  return {
    format: 1,
    name,
    title: "Entries",
    description: "Entries from a service.",
    mark: "lucide:rss",
    maker: "Marfa",
    marfa: "0.0.1",
    version: "1.0.0",
    types: [
      {
        id: type,
        description: "An entry a service holds.",
        fields: { note: { type: "string" } },
      },
    ],
    edge_types: [],
    connector: connectorSection(type, source),
    ...fields,
  };
}

let minted = 0;

/** A key minted by local authority: an owner's key, holding what it names. */
export async function ownerKey(
  server: FreshServer,
  permissions: string[],
  extra: Record<string, unknown> = {},
): Promise<{ client: MarfaClient; id: string; key: string }> {
  const local = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
  const made = await local.createKey({
    label: "plugin connector fixture",
    source: `plugin-connector-${String(++minted)}-${fresh()}`,
    permissions,
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    metadata_permissions: { "*": "write" },
    ...extra,
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return {
    client: new MarfaClient({ baseUrl: server.apiUrl, apiKey: made.data.key! }),
    id: made.data.id,
    key: made.data.key!,
  };
}

export type LinkedHost = {
  id: string;
  client: MarfaClient;
  key: string;
  keyId: string;
};

/** Makes a host and redeems its link, answering the host's key. */
export async function linkedHost(
  server: FreshServer,
  owner: MarfaClient,
  name: string,
): Promise<LinkedHost> {
  const made = await owner.createConnectorHost(name);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const redeemed = await owner.redeemConnectorLink({ code: made.data.code });
  expect(redeemed.status, JSON.stringify(redeemed.error)).toBe(201);
  return {
    id: made.data.host.id,
    key: redeemed.data.key,
    keyId: redeemed.data.key_id,
    client: new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: redeemed.data.key,
    }),
  };
}

/** Has `host` mint the connector key of `plugin`, answering a client bearing it. */
export async function connectorKey(
  server: FreshServer,
  host: LinkedHost,
  plugin: string,
): Promise<{ client: MarfaClient; id: string; key: string; source: string }> {
  const made = await host.client.mintConnectorKey(plugin);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return {
    client: new MarfaClient({ baseUrl: server.apiUrl, apiKey: made.data.key }),
    id: made.data.key_id,
    key: made.data.key,
    source: made.data.source,
  };
}
