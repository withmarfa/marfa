import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  connectorBundle,
  connectorKey,
  fresh,
  linkedHost,
  ownerKey,
} from "../../utils/plugin-connector.js";

/**
 * Connector hosts: making one with a one-time link, redeeming the link for
 * the host's own key, what that key reaches, the connector keys a host mints,
 * assigning a connector to a host and removing one. Hosts and links are the
 * instance's, so the server is the fixture's own.
 */

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

let server: FreshServer;
let owner: MarfaClient;
let ownerKeyId: string;

beforeAll(async () => {
  server = await bootFreshServer("connector-hosts");
  const made = await ownerKey(server, [
    "schema.write",
    "connectors.manage",
    "keys.manage",
    "keys.mint",
    "audit.read",
  ]);
  owner = made.client;
  ownerKeyId = made.id;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** Installs a connector plugin of its own, answering its name and kind type. */
async function plugin(label: string): Promise<{ name: string; type: string }> {
  const part = fresh();
  const name = `${label}-${part}`;
  const root = `${label.replaceAll("-", "")}${part}`;
  const installed = await owner.installPlugin(
    connectorBundle(name, root, `${label}-${part}`),
  );
  expect(installed.status, JSON.stringify(installed.error)).toBe(201);
  return { name, type: `${root}.entry` };
}

function client(key?: string): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: key });
}

describe("making a host", () => {
  it("makes a host and a one-time link that answers the code once, in the link's fragment, for 15 minutes", async () => {
    const before = Date.now() + server.clockOffsetMs;
    const made = await owner.createConnectorHost("  Studio Mac  ");
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    await expectMatchesSchema("POST", "/connector-hosts", 201, made.data);
    expect(made.data.host).toMatchObject({
      name: "Studio Mac",
      linked: false,
      last_seen_at: null,
      connectors: [],
    });
    expect(made.data.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const origin = new URL(made.data.link).origin;
    expect(made.data.link).toBe(`${origin}/connect#${made.data.code}`);
    const expires = Date.parse(made.data.expires_at);
    const created = Date.parse(made.data.host.created_at);
    expect(expires - created).toBe(FIFTEEN_MINUTES_MS);
    expect(created).toBeGreaterThanOrEqual(before - 5_000);
    expect(made.data.host.link_expires_at).toBe(made.data.expires_at);
    const read = await owner.getConnectorHost(made.data.host.id);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.data)).not.toContain(made.data.code);
    const listed = await owner.listConnectorHosts();
    expect(JSON.stringify(listed.data)).not.toContain(made.data.code);

    for (const name of [undefined, "", "   ", 7, "n".repeat(101)]) {
      const refused = await owner.createConnectorHost(name);
      expect(refused.status, String(name)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(JSON.stringify(refused.error?.error.details)).toContain("name");
    }
  });

  it("refuses 403 every host door to a key without connectors.manage", async () => {
    const { name } = await plugin("unmanaged");
    const made = await owner.createConnectorHost(`unmanaged ${fresh()}`);
    const id = made.data.host.id;
    const lacking = (await ownerKey(server, ["schema.write", "keys.mint"]))
      .client;
    const doors = [
      () => lacking.createConnectorHost("not made"),
      () => lacking.listConnectorHosts(),
      () => lacking.getConnectorHost(id),
      () => lacking.linkConnectorHost(id),
      () => lacking.removeConnectorHost(id),
      () => lacking.assignConnector(name, id),
    ];
    for (const door of doors) {
      const refused = await door();
      expect(refused.status).toBe(403);
      expect(refused.error?.error.details?.required_scope).toBe(
        "connectors.manage",
      );
    }
    const still = await owner.getConnectorHost(id);
    expect(still.data.link_expires_at).toBe(made.data.expires_at);
    expect((await owner.getPlugin(name)).data.connector_host).toBeNull();
    const hosts = await owner.listConnectorHosts();
    expect(hosts.data.data.map((host) => host.name)).not.toContain("not made");
  });

  it("lists and reads hosts with their connectors, and answers 404 connector_host_not_found for one that does not exist", async () => {
    const { name } = await plugin("listed");
    const first = await owner.createConnectorHost(`listed one ${fresh()}`);
    const second = await owner.createConnectorHost(`listed two ${fresh()}`);
    expect(
      (await owner.assignConnector(name, second.data.host.id)).status,
    ).toBe(200);
    const listed = await owner.listConnectorHosts();
    expect(listed.status).toBe(200);
    await expectMatchesSchema("GET", "/connector-hosts", 200, listed.data);
    expect(listed.data.next_cursor).toBeNull();
    const ids = listed.data.data.map((host) => host.id);
    expect(ids.indexOf(first.data.host.id)).toBeLessThan(
      ids.indexOf(second.data.host.id),
    );
    const read = await owner.getConnectorHost(second.data.host.id);
    expect(read.status).toBe(200);
    await expectMatchesSchema("GET", "/connector-hosts/{id}", 200, read.data);
    expect(read.data).toMatchObject({
      id: second.data.host.id,
      linked: false,
      connectors: [{ plugin: name, version: "1.0.0", key_minted: false }],
    });
    expect(
      listed.data.data.find((host) => host.id === second.data.host.id),
    ).toEqual(read.data);
    const unknown = "01890000-0000-7000-8000-000000000000";
    for (const answer of [
      await owner.getConnectorHost(unknown),
      await owner.linkConnectorHost(unknown),
      await owner.removeConnectorHost(unknown),
    ]) {
      expect(answer.status).toBe(404);
      expect(answer.error?.error.code).toBe("connector_host_not_found");
    }
  });
});

describe("redeeming a link", () => {
  it("redeems a link once, minting a key that holds connectors.host alone, and answers 404 connector_link_not_found to a second use and nothing else minted", async () => {
    const made = await owner.createConnectorHost(`redeemed ${fresh()}`);
    const id = made.data.host.id;
    const redeemed = await owner.redeemConnectorLink({ code: made.data.code });
    expect(redeemed.status, JSON.stringify(redeemed.error)).toBe(201);
    await expectMatchesSchema(
      "POST",
      "/connector-hosts/redeem",
      201,
      redeemed.data,
    );
    expect(redeemed.data.host).toEqual({ id, name: made.data.host.name });
    const keys = await owner.listKeys();
    const key = keys.data.data.find((held) => held.id === redeemed.data.key_id);
    expect(key).toMatchObject({
      permissions: ["connectors.host"],
      source: `connector-host:${id}`,
      sources: [],
      type_permissions: {},
      edge_permissions: {},
      extension_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
    });
    const linked = await owner.getConnectorHost(id);
    expect(linked.data).toMatchObject({ linked: true, link_expires_at: null });
    const count = keys.data.data.length;

    const again = await owner.redeemConnectorLink({ code: made.data.code });
    expect(again.status).toBe(404);
    expect(again.error?.error.code).toBe("connector_link_not_found");
    expect((await owner.listKeys()).data.data).toHaveLength(count);
    expect((await client(redeemed.data.key).connectorHostSelf()).status).toBe(
      200,
    );
  });

  it("revokes the host's old key when a fresh link is redeemed", async () => {
    const host = await linkedHost(server, owner, `moved ${fresh()}`);
    const fresh_link = await owner.linkConnectorHost(host.id);
    expect(fresh_link.status, JSON.stringify(fresh_link.error)).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/connector-hosts/{id}/link",
      200,
      fresh_link.data,
    );
    expect(fresh_link.data.host.id).toBe(host.id);
    // Until the fresh link is redeemed, the old key stands.
    expect((await host.client.connectorHostSelf()).status).toBe(200);
    const redeemed = await owner.redeemConnectorLink({
      code: fresh_link.data.code,
    });
    expect(redeemed.status).toBe(201);
    expect(redeemed.data.key_id).not.toBe(host.keyId);
    expect((await host.client.connectorHostSelf()).status).toBe(401);
    expect((await client(redeemed.data.key).connectorHostSelf()).status).toBe(
      200,
    );
  });

  it("answers 404 connector_link_not_found to an expired code, a code whose host was removed, a replaced code and a made-up one, and mints nothing", async () => {
    const count = (await owner.listKeys()).data.data.length;
    const replaced = await owner.createConnectorHost(`replaced ${fresh()}`);
    const replacing = await owner.linkConnectorHost(replaced.data.host.id);
    expect(replacing.status).toBe(200);
    const removed = await owner.createConnectorHost(`removed ${fresh()}`);
    expect((await owner.removeConnectorHost(removed.data.host.id)).status).toBe(
      200,
    );
    const made_up = "a".repeat(43);
    for (const code of [
      replaced.data.code,
      removed.data.code,
      made_up,
      "not a code",
      "",
    ]) {
      const refused = await owner.redeemConnectorLink({ code });
      expect(refused.status, code).toBe(404);
      expect(refused.error?.error.code).toBe("connector_link_not_found");
    }
    for (const body of [{}, { code: 7 }, { code: null }]) {
      const refused = await owner.redeemConnectorLink(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    const ending = await owner.createConnectorHost(`ending ${fresh()}`);
    await server.advanceClock(FIFTEEN_MINUTES_MS + 1_000);
    const expired = await owner.redeemConnectorLink({
      code: ending.data.code,
    });
    expect(expired.status).toBe(404);
    expect(expired.error?.error.code).toBe("connector_link_not_found");
    expect((await owner.listKeys()).data.data).toHaveLength(count);
    for (const id of [replaced.data.host.id, ending.data.host.id]) {
      expect((await owner.getConnectorHost(id)).data.linked).toBe(false);
    }
    // The witness: the replacing link, made before the clock moved, has ended too,
    // and a link made now redeems.
    const now = await owner.linkConnectorHost(ending.data.host.id);
    expect(
      (await owner.redeemConnectorLink({ code: now.data.code })).status,
    ).toBe(201);
  });
});

describe("a host's key", () => {
  it("refuses the host's key 401 on every door but its own, and its own doors 403 to every other credential", async () => {
    const { name, type } = await plugin("gated");
    const host = await linkedHost(server, owner, `gated ${fresh()}`);
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    const doors: [string, () => Promise<{ status: number }>][] = [
      ["plugins", () => host.client.listPlugins()],
      ["plugin", () => host.client.getPlugin(name)],
      [
        "install",
        () => host.client.installPlugin(connectorBundle("x", "x", "x")),
      ],
      ["keys", () => host.client.listKeys()],
      ["current key", () => host.client.getCurrentKey()],
      [
        "mint",
        () =>
          host.client.createKey({ label: "x", source: "x", permissions: [] }),
      ],
      ["types", () => host.client.listTypes()],
      ["type", () => host.client.getType(type)],
      [
        "register",
        () =>
          host.client.registerType({
            id: "user.hosted",
            guidance: "Owner words.",
            fields: { title: { type: "string" } },
          } as never),
      ],
      ["items", () => host.client.listItems()],
      ["item", () => host.client.createItem({ type, properties: {} })],
      ["connectors", () => host.client.listConnectors()],
      [
        "register connector",
        () => host.client.registerConnector({ name: "x" }),
      ],
      ["hosts", () => host.client.listConnectorHosts()],
      ["host", () => host.client.getConnectorHost(host.id)],
      ["assign", () => host.client.assignConnector(name, null)],
    ];
    for (const [label, door] of doors) {
      const refused = await door();
      expect(refused.status, label).toBe(401);
      expect(refused.error?.error.code, label).toBe("unauthorized");
    }
    // The witness: its own doors answer it.
    expect((await host.client.connectorHostSelf()).status).toBe(200);
    expect((await host.client.mintConnectorKey(name)).status).toBe(201);

    const connector = await connectorKey(server, host, name);
    const others = [owner, connector.client];
    for (const other of others) {
      expect((await other.connectorHostSelf()).status).toBe(403);
      expect((await other.mintConnectorKey(name)).status).toBe(403);
    }
    expect((await client().connectorHostSelf()).status).toBe(401);
    expect((await client().mintConnectorKey(name)).status).toBe(401);
  });

  it("refuses connectors.host to a key mint or update, from local authority too", async () => {
    const local = new MarfaClient({
      baseUrl: server.apiUrl,
      controlSocket: server.controlSocket,
    });
    for (const minter of [local, owner]) {
      const refused = await minter.createKey({
        label: "a host's power",
        source: `host-power-${fresh()}`,
        permissions: ["connectors.host"],
      });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    const plain = await local.createKey({
      label: "widened later",
      source: `host-power-${fresh()}`,
      permissions: ["audit.read"],
    });
    expect(plain.status, JSON.stringify(plain.error)).toBe(201);
    const widened = await local.updateKey(plain.data.id, {
      permissions: ["audit.read", "connectors.host"],
    });
    expect(widened.status).toBe(400);
    expect(widened.error?.error.code).toBe("validation_error");
    // The witness: the same update without it is taken, and a key minted with nothing named lacks it.
    const kept = await local.updateKey(plain.data.id, {
      permissions: ["audit.read", "connectors.manage"],
    });
    expect(kept.status, JSON.stringify(kept.error)).toBe(200);
    const everything = await local.createKey({
      label: "everything a key can be given",
      source: `host-power-${fresh()}`,
    });
    expect(everything.status, JSON.stringify(everything.error)).toBe(201);
    expect(everything.data.permissions).toHaveLength(14);
    expect(everything.data.permissions).not.toContain("connectors.host");
  });

  it("answers a host only the connectors assigned to it, and records when it was last seen", async () => {
    const mine = await plugin("mine");
    const theirs = await plugin("theirs");
    const host = await linkedHost(server, owner, `seen ${fresh()}`);
    const other = await linkedHost(server, owner, `other ${fresh()}`);
    expect(
      (await owner.getConnectorHost(host.id)).data.last_seen_at,
    ).toBeNull();
    const assigned = await owner.assignConnector(mine.name, host.id);
    expect(assigned.status, JSON.stringify(assigned.error)).toBe(200);
    await expectMatchesSchema(
      "PUT",
      "/plugins/{name}/connector",
      200,
      assigned.data,
    );
    expect(assigned.data).toEqual({
      plugin: mine.name,
      source: assigned.data.source,
      host: host.id,
      key_minted: false,
    });
    expect((await owner.getPlugin(mine.name)).data.connector_host).toBe(
      host.id,
    );
    expect((await owner.assignConnector(theirs.name, other.id)).status).toBe(
      200,
    );
    const self = await host.client.connectorHostSelf();
    expect(self.status).toBe(200);
    await expectMatchesSchema("GET", "/connector-hosts/self", 200, self.data);
    const installed = await owner.getPlugin(mine.name);
    expect(self.data).toEqual({
      id: host.id,
      name: expect.any(String),
      connectors: [
        {
          plugin: mine.name,
          version: "1.0.0",
          fingerprint: installed.data.fingerprint,
          connector: installed.data.connector,
          registration_id: null,
          key_minted: false,
        },
      ],
    });
    const seen = await owner.getConnectorHost(host.id);
    expect(seen.data.last_seen_at).not.toBeNull();
    const connector = await connectorKey(server, host, mine.name);
    const registered = await connector.client.registerConnector({
      name: "Mine",
    });
    expect(registered.status).toBe(201);
    const after = await host.client.connectorHostSelf();
    expect(after.data.connectors[0]).toMatchObject({
      registration_id: registered.data.id,
      key_minted: true,
    });
    const unassigned = await owner.assignConnector(mine.name, null);
    expect(unassigned.data.host).toBeNull();
    expect((await owner.getPlugin(mine.name)).data.connector_host).toBeNull();
    expect((await host.client.connectorHostSelf()).data.connectors).toEqual([]);
  });
});

describe("a connector's key", () => {
  it("mints a connector key with the manifest's source and write on its kinds' types, which registers itself and writes its types", async () => {
    const { name, type } = await plugin("minted");
    const host = await linkedHost(server, owner, `minting ${fresh()}`);
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    const made = await host.client.mintConnectorKey(name);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    await expectMatchesSchema(
      "POST",
      "/connector-hosts/self/connectors/{plugin}/key",
      201,
      made.data,
    );
    const source = (await owner.getPlugin(name)).data.connector as {
      source: string;
    };
    expect(made.data).toMatchObject({ plugin: name, source: source.source });
    const key = (await owner.listKeys()).data.data.find(
      (held) => held.id === made.data.key_id,
    );
    expect(key).toMatchObject({
      source: source.source,
      permissions: [],
      sources: [],
      type_permissions: { [type]: "write" },
      edge_permissions: {},
      extension_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      default_tier: "feed",
    });
    const connector = client(made.data.key);
    const registered = await connector.registerConnector({ name: "Minted" });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    expect(registered.data).toMatchObject({
      source: source.source,
      key_id: made.data.key_id,
    });
    const written = await connector.createItem({
      type,
      properties: { note: "from the connector" },
    });
    expect(written.status, JSON.stringify(written.error)).toBe(201);
    expect(written.data.item.source).toBe(source.source);
    const elsewhere = await connector.createItem({
      type: "core.note",
      properties: { content: "outside its kinds" },
    });
    expect(elsewhere.status).toBe(403);
  });

  it("revokes the connector key a host minted when it mints again, and when the connector moves to another host or is unassigned", async () => {
    const { name } = await plugin("remint");
    const host = await linkedHost(server, owner, `remint ${fresh()}`);
    const next = await linkedHost(server, owner, `remint next ${fresh()}`);
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    const first = await connectorKey(server, host, name);
    const second = await connectorKey(server, host, name);
    expect((await first.client.registerConnector({ name: "x" })).status).toBe(
      401,
    );
    const registered = await second.client.registerConnector({ name: "x" });
    expect(registered.status).toBe(201);
    // The same host again keeps the key.
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    expect(
      (await second.client.sendConnectorHeartbeat(registered.data.id)).status,
    ).toBe(200);
    const moved = await owner.assignConnector(name, next.id);
    expect(moved.data).toMatchObject({ host: next.id, key_minted: false });
    expect(
      (await second.client.sendConnectorHeartbeat(registered.data.id)).status,
    ).toBe(401);
    const third = await connectorKey(server, next, name);
    expect((await owner.assignConnector(name, null)).status).toBe(200);
    expect((await third.client.registerConnector({ name: "x" })).status).toBe(
      401,
    );
  });

  it("answers 404 plugin_not_found to a host minting for a plugin not assigned to it", async () => {
    const { name } = await plugin("unassigned");
    const host = await linkedHost(server, owner, `unassigned ${fresh()}`);
    const other = await linkedHost(server, owner, `assigned ${fresh()}`);
    const count = (await owner.listKeys()).data.data.length;
    for (const plugin_name of [name, "no-such-plugin"]) {
      const refused = await host.client.mintConnectorKey(plugin_name);
      expect(refused.status, plugin_name).toBe(404);
      expect(refused.error?.error.code).toBe("plugin_not_found");
    }
    expect((await owner.assignConnector(name, other.id)).status).toBe(200);
    const elsewhere = await host.client.mintConnectorKey(name);
    expect(elsewhere.status).toBe(404);
    expect((await owner.listKeys()).data.data).toHaveLength(count);
    // The witness: the host it is assigned to mints it.
    expect((await other.client.mintConnectorKey(name)).status).toBe(201);
  });

  it("keeps a connector's host and key through a newer version of its plugin", async () => {
    const part = fresh();
    const name = `updated-${part}`;
    const root = `updated${part}`;
    expect(
      (await owner.installPlugin(connectorBundle(name, root, name))).status,
    ).toBe(201);
    const host = await linkedHost(server, owner, `updated ${part}`);
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    const connector = await connectorKey(server, host, name);
    const updated = await owner.installPlugin(
      connectorBundle(name, root, name, { version: "1.1.0" }),
    );
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    expect(updated.data.connector_host).toBe(host.id);
    expect((await connector.client.getCurrentKey()).status).toBe(200);
    const self = await host.client.connectorHostSelf();
    expect(self.data.connectors[0]).toMatchObject({
      plugin: name,
      version: "1.1.0",
      key_minted: true,
    });
  });
});

describe("assigning and removing", () => {
  it("refuses 404 assigning a plugin with no connector or a host that does not exist", async () => {
    const part = fresh();
    const { connector: _connector, ...bare } = connectorBundle(
      `bare-${part}`,
      `bare${part}`,
      "unused",
    );
    expect((await owner.installPlugin(bare)).status).toBe(201);
    const host = await owner.createConnectorHost(`assigning ${part}`);
    const none = await owner.assignConnector(`bare-${part}`, host.data.host.id);
    expect(none.status).toBe(404);
    expect(none.error?.error.code).toBe("connector_not_found");
    expect(none.error?.error.details?.plugin).toBe(`bare-${part}`);
    const missing = await owner.assignConnector("no-such-plugin", null);
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("plugin_not_found");
    const { name } = await plugin("assigning");
    const nowhere = await owner.assignConnector(
      name,
      "01890000-0000-7000-8000-000000000000",
    );
    expect(nowhere.status).toBe(404);
    expect(nowhere.error?.error.code).toBe("connector_host_not_found");
    for (const body of [{}, { host: 7 }]) {
      const refused = await owner.rawRequest(`/plugins/${name}/connector`, {
        method: "PUT",
        body,
      });
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    expect((await owner.getPlugin(name)).data.connector_host).toBeNull();
  });

  it("removes a host: revokes its key and every connector key it minted, and unassigns its connectors", async () => {
    const one = await plugin("hosted-one");
    const two = await plugin("hosted-two");
    const host = await linkedHost(server, owner, `removed ${fresh()}`);
    for (const { name } of [one, two]) {
      expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    }
    const first = await connectorKey(server, host, one.name);
    const second = await connectorKey(server, host, two.name);
    const removed = await owner.removeConnectorHost(host.id);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    await expectMatchesSchema(
      "DELETE",
      "/connector-hosts/{id}",
      200,
      removed.data,
    );
    expect(removed.data.removed.id).toBe(host.id);
    expect(removed.data.revoked_keys).toBe(3);
    expect([...removed.data.unassigned].sort()).toEqual(
      [one.name, two.name].sort(),
    );
    expect((await host.client.connectorHostSelf()).status).toBe(401);
    expect((await first.client.getCurrentKey()).status).toBe(401);
    expect((await second.client.getCurrentKey()).status).toBe(401);
    expect((await owner.getConnectorHost(host.id)).status).toBe(404);
    for (const { name } of [one, two]) {
      expect((await owner.getPlugin(name)).data.connector_host).toBeNull();
    }
    // The witness: the owner's own key still stands.
    expect((await owner.getCurrentKey()).status).toBe(200);
  });
});

describe("the record of hosts", () => {
  it("audits making, linking, redeeming and removing a host, assigning a connector and minting its key", async () => {
    const { name } = await plugin("audited");
    const made = await owner.createConnectorHost(`audited ${fresh()}`);
    const id = made.data.host.id;
    const linked = await owner.linkConnectorHost(id);
    const redeemed = await owner.redeemConnectorLink({
      code: linked.data.code,
    });
    expect((await owner.assignConnector(name, id)).status).toBe(200);
    const host = client(redeemed.data.key);
    const minted = await host.mintConnectorKey(name);
    expect(minted.status).toBe(201);
    expect((await owner.removeConnectorHost(id)).status).toBe(200);
    for (const action of [
      "connector_host.create",
      "connector_host.link",
      "connector_host.redeem",
      "connector_host.remove",
    ]) {
      const entries = await owner.listAudit({ action, resource_id: id });
      expect(entries.status).toBe(200);
      expect(entries.data.data, action).toHaveLength(1);
    }
    const assigned = await owner.listAudit({
      action: "plugin.connector_assign",
      resource_id: name,
    });
    expect(assigned.data.data.map((entry) => entry.details.host)).toEqual([id]);
    const mints = await owner.listAudit({
      action: "connector.key_mint",
      resource_id: name,
    });
    expect(mints.data.data).toHaveLength(1);
    expect(mints.data.data[0]?.details).toMatchObject({
      host: id,
      key_id: minted.data.key_id,
    });
  });

  it("keeps every link code, host key and connector key out of audit entries, the log and refusals", async () => {
    const { name } = await plugin("secrets");
    const made = await owner.createConnectorHost(`secrets ${fresh()}`);
    const code = made.data.code as string;
    const redeemed = await owner.redeemConnectorLink({ code });
    const hostKey = redeemed.data.key as string;
    expect((await owner.assignConnector(name, made.data.host.id)).status).toBe(
      200,
    );
    const minted = await client(hostKey).mintConnectorKey(name);
    const connectorKeyText = minted.data.key as string;
    // The witness: each was answered once, so each was there to leak.
    for (const secret of [code, hostKey, connectorKeyText]) {
      expect(secret.length).toBeGreaterThan(20);
    }
    const again = await owner.redeemConnectorLink({ code });
    const refusals = [
      again,
      await client(hostKey).listKeys(),
      await client(connectorKeyText).connectorHostSelf(),
      await owner.mintConnectorKey(name),
    ];
    const audit = await owner.listAudit({ limit: 200 });
    expect(audit.status).toBe(200);
    expect(audit.data.data.length).toBeGreaterThan(0);
    const log = await server.output();
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [code, hostKey, connectorKeyText]) {
      for (const refusal of refusals) {
        expect(JSON.stringify(refusal.error)).not.toContain(secret);
      }
      expect(JSON.stringify(audit.data)).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
    expect(ownerKeyId).toBeTruthy();
  });
});

describe("the redeem door's limit", () => {
  let limited: FreshServer;

  beforeAll(async () => {
    limited = await bootFreshServer("connector-hosts-limited", {
      MARFA_RATE_LIMIT_ENABLED: "true",
    });
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await limited?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it(
    "refuses 429 rate_limited redemptions from one address past ten in fifteen minutes",
    { retry: 0 },
    async () => {
      // The retry would start past the limit this test spends.
      const anyone = new MarfaClient({ baseUrl: limited.apiUrl });
      for (let tried = 0; tried < 10; tried += 1) {
        const refused = await anyone.redeemConnectorLink({ code: "made-up" });
        expect(refused.status, String(tried)).toBe(404);
      }
      const spent = await anyone.redeemConnectorLink({ code: "made-up" });
      expect(spent.status).toBe(429);
      expect(spent.error?.error.code).toBe("rate_limited");
    },
  );
});
