import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { ApiResponse } from "../../client/types.js";
import {
  type ConnectorPlugin,
  type MintedKey,
  connectorKey,
  fresh,
  hostMinted,
  installed,
  local,
  mint,
  onTickets,
  ticketType,
} from "../../utils/connector-plugin.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
} from "../../utils/mcp.js";
import { collectUntil, withStreamAtCursor } from "../../utils/stream.js";

/**
 * What a plugin connector's key may write once its mapping lands a kind on a
 * type that also holds the owner's items (`plugins/reach-*`,
 * `items/tier-connector`, `items/read-only-mapped`). The key's type map
 * writes only its own types; the reach on the target type comes from the
 * mapping, for the connector's own items alone. Each refusal on an owner's
 * item is paired with the same call on the connector's own item, which
 * succeeds.
 */
let server: FreshServer;
let owner: MarfaClient;
let ownerSource: string;

beforeAll(async () => {
  server = await bootFreshServer("connector-reach");
  ownerSource = `reach-owner-${fresh()}`;
  owner = (
    await mint(
      server,
      ownerSource,
      ["schema.write", "connectors.manage", "items.purge", "keys.manage"],
      { "*": "write" },
    )
  ).client;
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface Mapped {
  plugin: ConnectorPlugin;
  key: MintedKey;
}

/** A plugin whose `issue` kind lands on the owner's ticket type, and its key. */
async function mapped(extra: Record<string, unknown> = {}): Promise<Mapped> {
  const plugin = await installed(owner);
  const key = await connectorKey(server, plugin, extra);
  const saved = await owner.saveConnectorMapping(
    plugin.name,
    onTickets(plugin, 0),
  );
  expect(saved.status, JSON.stringify(saved.error)).toBe(200);
  return { plugin, key };
}

async function ticket(
  by: MarfaClient,
  plugin: ConnectorPlugin,
  fields: Record<string, unknown> = {},
) {
  const made = await by.createItem({
    type: plugin.ticket,
    properties: { title: "a ticket", reporter: "someone" },
    ...fields,
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item;
}

function refusedAsUnreached(answer: ApiResponse<unknown>, door: string) {
  expect(answer.ok, `${door}: ${JSON.stringify(answer.data)}`).toBe(false);
  expect([403, 404, 409], `${door}: ${String(answer.status)}`).toContain(
    answer.status,
  );
}

describe("the connector's own items on its target type", () => {
  it("creates, updates, tags, links, fills the table of, trashes, restores and purges its own items on its mapped target type", async () => {
    const plugin = await installed(owner);
    const { client: own, id } = await connectorKey(server, plugin);
    // The witness: before the mapping lands `issue` on tickets, the key may not write one.
    const before = await own.createItem({
      type: plugin.ticket,
      properties: { title: "too soon", reporter: "x" },
    });
    expect(before.status).toBe(403);
    expect(before.error?.error.code).toBe("type_not_permitted");
    const saved = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 0),
    );
    expect(saved.status, JSON.stringify(saved.error)).toBe(200);

    const item = await ticket(own, plugin, { source_id: `t-${fresh()}` });
    expect(item.source).toBe(plugin.source);
    const read = await own.getItem(item.id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    const looked = await own.lookupItems({
      type: plugin.ticket,
      source: plugin.source,
      source_ids: [item.source_id!],
    });
    expect(looked.status, JSON.stringify(looked.error)).toBe(200);
    expect(looked.data.data.map((held) => held.id)).toEqual([item.id]);

    const patched = await own.updateItem(item.id, {
      version: item.version,
      properties: { title: "patched", attachments: [{ name: "a.txt" }] },
    });
    expect(patched.status, JSON.stringify(patched.error)).toBe(200);
    const upserted = await own.createItem({
      type: plugin.ticket,
      source_id: item.source_id!,
      properties: { title: "upserted" },
    });
    expect(upserted.status, JSON.stringify(upserted.error)).toBe(200);
    expect(upserted.data.item.id).toBe(item.id);
    const bulk = await own.bulkItems({
      items: [
        {
          type: plugin.ticket,
          source_id: item.source_id!,
          properties: { title: "bulk" },
        },
      ],
    });
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(bulk.data.results[0]?.outcome).toBe("updated");
    const tagged = await own.addTags(item.id, ["synced"]);
    expect(tagged.status, JSON.stringify(tagged.error)).toBe(200);
    const issue = await own.createItem({
      type: plugin.issue,
      properties: { title: "its own type" },
    });
    expect(issue.status).toBe(201);
    const edge = await own.createEdge({
      from_id: item.id,
      to_id: issue.data.item.id,
      edge_type: "references",
    });
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
    const rows = await own.writeRows(item.id, "log", {
      operations: [{ op: "put", values: { line: "opened" } }],
    });
    expect(rows.status, JSON.stringify(rows.error)).toBe(200);
    expect((await own.listRows(item.id, "log")).status).toBe(200);
    expect((await own.deleteItem(item.id)).status).toBe(200);
    const restored = await own.restoreItem(item.id);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect((await own.deleteItem(item.id)).status).toBe(200);
    const purged = await own.purgeItem(item.id);
    expect(purged.status, JSON.stringify(purged.error)).toBe(200);

    const key = await owner.listKeys();
    const held = key.data.data.find((entry) => entry.id === id);
    expect(held?.type_permissions).toEqual({ [`${plugin.source}.*`]: "write" });
  });

  it("writes a kind's own type only as its type map allows, whatever the mapping", async () => {
    const plugin = await installed(owner);
    const reader = await connectorKey(server, plugin, {
      permissions: [],
      type_permissions: { [`${plugin.source}.*`]: "read" },
    });
    const mapping = await reader.client.getConnectorMapping(plugin.name);
    expect(mapping.status, JSON.stringify(mapping.error)).toBe(200);
    expect(mapping.data.kinds.comment).toMatchObject({
      enabled: true,
      target_type: plugin.comment,
    });
    const refused = await reader.client.createItem({
      type: plugin.comment,
      properties: { title: "a comment" },
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    // The witness: once its type map writes the plugin's types, the same key creates the item.
    const widened = await local(server).updateKey(reader.id, {
      type_permissions: { [`${plugin.source}.*`]: "write" },
    });
    expect(widened.status, JSON.stringify(widened.error)).toBe(200);
    const made = await reader.client.createItem({
      type: plugin.comment,
      properties: { title: "a comment" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
  });

  it("gives a connector's new item the tier of its mapping, the feed by default, whatever the key's default_tier", async () => {
    const plugin = await installed(owner);
    const { client: own } = await connectorKey(server, plugin, {
      default_tier: "library",
    });
    const issue = await own.createItem({
      type: plugin.issue,
      properties: { title: "default" },
    });
    expect(issue.status, JSON.stringify(issue.error)).toBe(201);
    expect(issue.data.item.tier).toBe("feed");
    const comment = await own.createItem({
      type: plugin.comment,
      properties: { body: "a comment" },
    });
    expect(comment.data.item.tier).toBe("library");

    const saved = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 0, { tier: "library" }),
    );
    expect(saved.status, JSON.stringify(saved.error)).toBe(200);
    expect((await ticket(own, plugin)).tier).toBe("library");
    expect((await ticket(own, plugin, { tier: "feed" })).tier).toBe("feed");
    const unmapped = await own.createItem({
      type: plugin.issue,
      properties: { title: "no kind lands here now" },
    });
    expect(unmapped.data.item.tier).toBe("feed");

    // The witness: another key's create keeps its own default_tier.
    const other = await mint(
      server,
      `reach-tier-${fresh()}`,
      [],
      { [plugin.ticket]: "write" },
      { default_tier: "feed" },
    );
    expect((await ticket(other.client, plugin)).tier).toBe("feed");
    const library = await mint(
      server,
      `reach-tier-${fresh()}`,
      [],
      { [plugin.ticket]: "write" },
      { default_tier: "library" },
    );
    expect((await ticket(library.client, plugin)).tier).toBe("library");
  });
});

describe("the owner's items on the target type", () => {
  it("answers an owner's item of the target type as one the key cannot reach on every door, where the same call on its own item succeeds", async () => {
    const { plugin, key } = await mapped({ sources: [ownerSource] });
    const own = key.client;
    const theirs = await ticket(owner, plugin, { source_id: `o-${fresh()}` });
    const mine = await ticket(own, plugin, { source_id: `m-${fresh()}` });
    const issue = await own.createItem({
      type: plugin.issue,
      properties: { title: "an end" },
    });
    expect(issue.status).toBe(201);

    const pairs: [string, (id: string) => Promise<ApiResponse<unknown>>][] = [
      ["read", (id) => own.getItem(id)],
      [
        "patch",
        async (id) => {
          const version = (await owner.getItem(id)).data.item.version;
          return own.updateItem(id, { version, properties: { title: "x" } });
        },
      ],
      [
        "file",
        async (id) => {
          const version = (await owner.getItem(id)).data.item.version;
          return own.updateItem(id, {
            version,
            properties: { attachments: [{ name: "b.txt" }] },
          });
        },
      ],
      ["tag", (id) => own.addTags(id, ["reached"])],
      [
        "edge",
        (id) =>
          own.createEdge({
            from_id: id,
            to_id: issue.data.item.id,
            edge_type: "references",
          }),
      ],
      [
        "table",
        (id) =>
          own.writeRows(id, "log", {
            operations: [{ op: "put", values: { line: "x" } }],
          }),
      ],
      ["trash", (id) => own.deleteItem(id)],
    ];
    for (const [door, call] of pairs) {
      const witness = await call(mine.id);
      expect(
        witness.ok,
        `${door} on its own: ${JSON.stringify(witness.error)}`,
      ).toBe(true);
      if (door === "trash") {
        expect((await own.restoreItem(mine.id)).status).toBe(200);
      }
      refusedAsUnreached(await call(theirs.id), door);
    }
    const looked = await own.lookupItems({
      type: plugin.ticket,
      ids: [theirs.id, mine.id],
    });
    expect(looked.status, JSON.stringify(looked.error)).toBe(200);
    expect(looked.data.data.map((held) => held.id)).toEqual([mine.id]);

    // A natural key under a source the key claims is not its own.
    const claimed = await own.createItem({
      type: plugin.ticket,
      source: ownerSource,
      source_id: theirs.source_id!,
      properties: { title: "taken over" },
    });
    expect(claimed.status).toBe(403);
    expect(claimed.error?.error.code).toBe("type_not_permitted");
    const created = await own.createItem({
      type: plugin.ticket,
      source: ownerSource,
      properties: { title: "new under a claim", reporter: "x" },
    });
    expect(created.status).toBe(403);
    expect(created.error?.error.code).toBe("type_not_permitted");
    const upsertOwn = await own.createItem({
      type: plugin.ticket,
      source_id: mine.source_id!,
      properties: { title: "its own natural key" },
    });
    expect(upsertOwn.status, JSON.stringify(upsertOwn.error)).toBe(200);
    const bulk = await own.bulkItems({
      atomic: false,
      items: [
        {
          type: plugin.ticket,
          source_id: mine.source_id!,
          properties: { title: "bulk own" },
        },
        {
          type: plugin.ticket,
          source: ownerSource,
          source_id: theirs.source_id!,
          properties: { title: "bulk theirs" },
        },
      ],
    });
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(bulk.data.results.map((entry) => entry.outcome)).toEqual([
      "updated",
      "errored",
    ]);
    expect(bulk.data.results[1]?.error?.code).toBe("type_not_permitted");

    // Restore and purge an owner's item in the bin; the same on its own succeed.
    expect((await owner.deleteItem(theirs.id)).status).toBe(200);
    expect((await own.deleteItem(mine.id)).status).toBe(200);
    refusedAsUnreached(await own.restoreItem(theirs.id), "restore");
    expect((await own.restoreItem(mine.id)).status).toBe(200);
    expect((await own.deleteItem(mine.id)).status).toBe(200);
    refusedAsUnreached(await own.purgeItem(theirs.id), "purge");
    expect((await own.purgeItem(mine.id)).status).toBe(200);

    const after = await owner.getItem(theirs.id, "trashed");
    expect(after.status, JSON.stringify(after.error)).toBe(200);
    expect(after.data.item.properties.title).toBe("a ticket");
    expect(after.data.item.properties.attachments).toBeUndefined();
    expect(after.data.metadata.tags).not.toContain("reached");
  });
});

describe("what the connector's trash, restore and purge carry", () => {
  it("leaves the owner's child, comment and attachment on its item where they are through its trash, restore and purge, and carries its own", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const state = async (id: string) =>
      (await owner.getItem(id, "any")).data.item.state;
    const edge = async (
      by: MarfaClient,
      from_id: string,
      to_id: string,
      edge_type: string,
    ) => {
      const made = await by.createEdge({ from_id, to_id, edge_type });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
    };
    const note = async (by: MarfaClient, type: string, title: string) => {
      const made = await by.createItem({ type, properties: { title } });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      return made.data.item.id;
    };
    const mine = (await ticket(own, plugin)).id;
    const myChild = (await ticket(own, plugin)).id;
    const myComment = await note(own, plugin.comment, "its own comment");
    await edge(own, mine, myChild, "parent-of");
    await edge(own, myComment, mine, "comments-on");
    const theirChild = (await ticket(owner, plugin)).id;
    const theirComment = await note(owner, "core.note", "the owner's comment");
    const theirAttachment = await note(owner, "core.note", "a scan");
    await edge(owner, mine, theirChild, "parent-of");
    await edge(owner, theirComment, mine, "comments-on");
    await edge(owner, theirAttachment, mine, "attached-to");
    const theirs = [theirChild, theirComment, theirAttachment];

    // The connector's trash carries its own child and comment, and none of the owner's.
    expect((await own.deleteItem(mine)).status).toBe(200);
    for (const id of [mine, myChild, myComment]) {
      expect(await state(id), id).toBe("trashed");
    }
    for (const id of theirs) {
      expect(await state(id), id).toBe("active");
    }
    expect((await own.restoreItem(mine)).status).toBe(200);
    for (const id of [mine, myChild, myComment, ...theirs]) {
      expect(await state(id), id).toBe("active");
    }

    // The owner's trash carries everything; the connector's restore brings back only its own.
    expect((await owner.deleteItem(mine)).status).toBe(200);
    for (const id of [mine, myChild, myComment, ...theirs]) {
      expect(await state(id), id).toBe("trashed");
    }
    expect((await own.restoreItem(mine)).status).toBe(200);
    for (const id of [mine, myChild, myComment]) {
      expect(await state(id), id).toBe("active");
    }
    for (const id of theirs) {
      expect(await state(id), id).toBe("trashed");
    }

    // The connector's purge takes its own comment with its item, and leaves the owner's in the bin.
    expect((await own.deleteItem(mine)).status).toBe(200);
    expect((await own.purgeItem(mine)).status).toBe(200);
    expect((await owner.getItem(mine, "any")).status).toBe(404);
    expect((await owner.getItem(myComment, "any")).status).toBe(404);
    for (const id of theirs) {
      expect(await state(id), id).toBe("trashed");
    }
  });
});

/**
 * Leaves the plugin's stored connector or mapping unreadable with `statement`,
 * reaching into the database because every door refuses one, and holds the
 * key to what its type map writes, with the cascade rule still in force.
 */
async function failsClosed(statement: string) {
  const { plugin, key } = await mapped();
  const own = key.client;
  const state = async (id: string) =>
    (await owner.getItem(id, "any")).data.item.state;

  // The witness: while the connector and mapping read, the key writes the target type.
  await ticket(own, plugin);

  const changed = withInstanceDatabase(server.sqlitePath, (db) =>
    db.prepare(statement).run(plugin.name),
  );
  expect(Number(changed.changes)).toBe(1);

  const refused = await own.createItem({
    type: plugin.ticket,
    properties: { title: "unmapped", reporter: "x" },
  });
  expect(refused.status).toBe(403);
  expect(refused.error?.error.code).toBe("type_not_permitted");

  const made = await own.createItem({
    type: plugin.issue,
    properties: { title: "its issue" },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const mine = made.data.item.id;
  const theirChild = (await ticket(owner, plugin)).id;
  const linked = await owner.createEdge({
    from_id: mine,
    to_id: theirChild,
    edge_type: "parent-of",
  });
  expect(linked.status, JSON.stringify(linked.error)).toBe(201);
  expect((await own.deleteItem(mine)).status).toBe(200);
  expect(await state(mine)).toBe("trashed");
  expect(await state(theirChild)).toBe("active");
}

describe("a connector or mapping that does not read", () => {
  it("keeps the key a plugin connector key when its stored connector does not read: its trash leaves the owner's child, and it writes no target type", async () => {
    await failsClosed(
      "UPDATE plugins SET manifest = json_set(manifest, '$.connector.kinds', 'unreadable') WHERE name = ?",
    );
  });

  it("keeps the key a plugin connector key when its stored mapping does not read: its trash leaves the owner's child, and it writes no target type", async () => {
    await failsClosed(
      `UPDATE connector_mappings SET kinds = '{"issue":{"tier":"archive"}}' WHERE plugin = ?`,
    );
  });
});

describe("a mapping that changes", () => {
  it("refuses the target type once the kind is off or moved, and takes it again once it is back", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const mine = await ticket(own, plugin);
    const off = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 1, { enabled: false }),
    );
    expect(off.status, JSON.stringify(off.error)).toBe(200);
    const refusedCreate = await own.createItem({
      type: plugin.ticket,
      properties: { title: "off", reporter: "x" },
    });
    expect(refusedCreate.status).toBe(403);
    expect(refusedCreate.error?.error.code).toBe("type_not_permitted");
    refusedAsUnreached(
      await own.updateItem(mine.id, {
        version: mine.version,
        properties: { title: "off" },
      }),
      "patch while off",
    );
    const moved = await owner.saveConnectorMapping(plugin.name, {
      version: 2,
      kinds: { issue: { target_type: plugin.issue } },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect((await own.getItem(mine.id)).status).toBe(404);
    const back = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 3),
    );
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    const patched = await own.updateItem(mine.id, {
      version: mine.version,
      properties: { title: "back" },
    });
    expect(patched.status, JSON.stringify(patched.error)).toBe(200);
  });

  it("decides a write held on the writer by the mapping saved while it waited", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const held = async (version: number, enabled: boolean) => {
      await server.setFault("hold:write=item.create@1");
      const pending = own.createItem({
        type: plugin.ticket,
        properties: { title: "held", reporter: "x" },
      });
      await server.waitForHold("hold:write");
      const saved = await owner.saveConnectorMapping(
        plugin.name,
        onTickets(plugin, version, { enabled }),
      );
      expect(saved.status, JSON.stringify(saved.error)).toBe(200);
      await server.clearFault("hold:write");
      return pending;
    };
    // The witness: a save that keeps the kind on lets the held create through.
    const kept = await held(1, true);
    expect(kept.status, JSON.stringify(kept.error)).toBe(201);
    const turnedOff = await held(2, false);
    expect(turnedOff.status).toBe(403);
    expect(turnedOff.error?.error.code).toBe("type_not_permitted");
    const turnedOn = await held(3, true);
    expect(turnedOn.status, JSON.stringify(turnedOn.error)).toBe(201);
  });

  it("reads the connector's item of a mapped type read only while it declares the type, and editable once the kind is off", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const registered = await own.registerConnector({
      name: `reach ${fresh()}`,
      read_only_types: [plugin.ticket],
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const mine = await ticket(own, plugin);
    expect((await owner.getItem(mine.id)).data.item.read_only).toBe(true);
    const off = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 1, { enabled: false }),
    );
    expect(off.status, JSON.stringify(off.error)).toBe(200);
    expect((await owner.getItem(mine.id)).data.item.read_only).toBe(false);
  });
});

describe("the edge types a connector writes", () => {
  it("mints a connector key holding write on the edge types its connector names, own and shipped, which writes both from its own item and no other", async () => {
    let sent: Record<string, any> = {};
    let cites = "";
    const plugin = await installed(owner, (bundle, named) => {
      cites = `${named.source}.cites`;
      bundle.edge_types = [
        {
          id: cites,
          cardinality: "many-to-many",
          from_type_constraints: ["*"],
          to_type_constraints: ["*"],
        },
      ];
      bundle.connector.edge_types = [cites, "attached-to"];
      sent = bundle;
    });
    const minted = await hostMinted(server, plugin);
    const own = minted.client;
    const held = async (id: string) =>
      (await owner.listKeys()).data.data.find((entry) => entry.id === id);
    expect((await held(minted.id))?.edge_permissions).toEqual({
      [cites]: "write",
      "attached-to": "write",
    });
    expect((await held(minted.id))?.type_permissions).toEqual({
      [plugin.issue]: "write",
      [plugin.comment]: "write",
    });

    const issue = async (title: string) => {
      const made = await own.createItem({
        type: plugin.issue,
        properties: { title },
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      return made.data.item.id;
    };
    const [one, two] = [await issue("one"), await issue("two")];
    for (const edge_type of [cites, "attached-to"]) {
      const linked = await own.createEdge({
        from_id: one,
        to_id: two,
        edge_type,
      });
      expect(
        linked.status,
        `${edge_type}: ${JSON.stringify(linked.error)}`,
      ).toBe(201);
    }
    const unnamed = await own.createEdge({
      from_id: one,
      to_id: two,
      edge_type: "parent-of",
    });
    expect(unnamed.status).toBe(403);
    expect(unnamed.error?.error.code).toBe("edge_type_not_permitted");

    // From its own item on the mapped type, and never to or from the owner's.
    const saved = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 0),
    );
    expect(saved.status, JSON.stringify(saved.error)).toBe(200);
    const mine = await ticket(own, plugin);
    const fromMine = await own.createEdge({
      from_id: mine.id,
      to_id: one,
      edge_type: cites,
    });
    expect(fromMine.status, JSON.stringify(fromMine.error)).toBe(201);
    const theirs = await ticket(owner, plugin);
    // The witness: a key that reaches the owner's ticket links to it.
    const byOwner = await owner.createEdge({
      from_id: one,
      to_id: theirs.id,
      edge_type: "attached-to",
    });
    expect(byOwner.status, JSON.stringify(byOwner.error)).toBe(201);
    refusedAsUnreached(
      await own.createEdge({
        from_id: two,
        to_id: theirs.id,
        edge_type: cites,
      }),
      "edge to the owner's item",
    );
    refusedAsUnreached(
      await own.createEdge({
        from_id: theirs.id,
        to_id: one,
        edge_type: cites,
      }),
      "edge from the owner's item",
    );

    // A newer version may name fewer; the key keeps what it holds until its host mints again.
    const newer = structuredClone(sent);
    newer.version = "1.1.0";
    newer.connector.edge_types = [cites];
    const updated = await owner.installPlugin(newer);
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    expect((updated.data as { outcome?: string }).outcome).toBe("updated");
    expect((await held(minted.id))?.edge_permissions).toEqual({
      [cites]: "write",
      "attached-to": "write",
    });
    const again = await minted.host.mintConnectorKey(plugin.name);
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    expect((await held(again.data.key_id))?.edge_permissions).toEqual({
      [cites]: "write",
    });
  });
});

/**
 * Leaves the plugin's stored connector or mapping unreadable with `statement`,
 * after which the key lists, streams and settles nothing of the target type.
 */
async function readsNothing(statement: string) {
  const { plugin, key } = await mapped();
  const own = key.client;
  await ticket(own, plugin);
  const stream = `type=${encodeURIComponent(plugin.ticket)}`;
  // The witness: while the connector and mapping read, the key lists and streams the target type.
  expect((await own.listItems({ type: plugin.ticket })).status).toBe(200);
  expect(await streamOpened(key.key, stream)).toBe(200);
  const changed = withInstanceDatabase(server.sqlitePath, (db) =>
    db.prepare(statement).run(plugin.name),
  );
  expect(Number(changed.changes)).toBe(1);
  const listed = await own.listItems({ type: plugin.ticket });
  expect(listed.status).toBe(403);
  expect(listed.error?.error.code).toBe("type_not_permitted");
  expect(await streamOpened(key.key, stream)).toBe(403);
  const settled = await own.settleTombstones({
    type: plugin.ticket,
    source: plugin.source,
    source_ids: ["anything"],
    settled_at: new Date().toISOString(),
  });
  expect(settled.status).toBe(403);
  expect(settled.error?.error.code).toBe("type_not_permitted");
}

/** The status of `GET /events` opened as `key`, its body left unread. */
async function streamOpened(key: string, query: string): Promise<number> {
  const answer = await fetch(`${server.apiUrl}/events?${query}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" },
  });
  await answer.body?.cancel();
  return answer.status;
}

describe("what the connector reads of its own items on the target type", () => {
  it("lists its own items of the mapped type page by page and none of the owner's, which the owner lists beside them, and lists, streams and settles none once the kind is off", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const mine: string[] = [];
    const theirs: string[] = [];
    for (let at = 0; at < 5; at += 1) {
      mine.push((await ticket(own, plugin, { source_id: `m-${fresh()}` })).id);
      if (at < 4) theirs.push((await ticket(owner, plugin)).id);
    }

    const walked: string[] = [];
    const pages: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await own.listItems({
        type: plugin.ticket,
        limit: 2,
        ...(cursor !== undefined && { cursor }),
      });
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      pages.push(page.data.data.length);
      walked.push(...page.data.data.map((item) => item.id));
      cursor = page.data.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(walked.sort()).toEqual([...mine].sort());
    expect(pages.slice(0, -1).every((count) => count === 2)).toBe(true);
    // The witness: the owner lists both the connector's tickets and their own.
    const all = await owner.listItems({ type: plugin.ticket, limit: 100 });
    expect(all.data.data.map((item) => item.id).sort()).toEqual(
      [...mine, ...theirs].sort(),
    );
    const parent = await own.listItems({ type: "core.task", limit: 100 });
    expect(parent.status, JSON.stringify(parent.error)).toBe(200);
    expect(parent.data.data.map((item) => item.id)).not.toContain(theirs[0]);
    expect(parent.data.data.map((item) => item.id)).toContain(mine[0]);

    // The edge-filtered form, as a connector finds the rows linked to one of its own.
    const issue = await own.createItem({
      type: plugin.issue,
      properties: { title: "the target" },
    });
    expect(issue.status).toBe(201);
    for (const [by, from] of [
      [own, mine[0]!],
      [owner, theirs[0]!],
    ] as const) {
      const linked = await by.createEdge({
        from_id: from,
        to_id: issue.data.item.id,
        edge_type: "references",
      });
      expect(linked.status, JSON.stringify(linked.error)).toBe(201);
    }
    const filter = `edge[references] eq ${JSON.stringify(issue.data.item.id)}`;
    const ownLinked = await own.listItems({ type: plugin.ticket, filter });
    expect(ownLinked.status, JSON.stringify(ownLinked.error)).toBe(200);
    expect(ownLinked.data.data.map((item) => item.id)).toEqual([mine[0]]);
    const allLinked = await owner.listItems({ type: plugin.ticket, filter });
    expect(allLinked.data.data.map((item) => item.id).sort()).toEqual(
      [mine[0], theirs[0]].sort(),
    );

    const stream = `type=${encodeURIComponent(plugin.ticket)}`;
    expect(await streamOpened(key.key, stream)).toBe(200);
    const off = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 1, { enabled: false }),
    );
    expect(off.status, JSON.stringify(off.error)).toBe(200);
    const listed = await own.listItems({ type: plugin.ticket });
    expect(listed.status).toBe(403);
    expect(listed.error?.error.code).toBe("type_not_permitted");
    expect(await streamOpened(key.key, stream)).toBe(403);
    const settled = await own.settleTombstones({
      type: plugin.ticket,
      source: plugin.source,
      source_ids: ["anything"],
      settled_at: new Date().toISOString(),
    });
    expect(settled.status).toBe(403);
    expect(settled.error?.error.code).toBe("type_not_permitted");
  });

  it("streams the events of its own items of the mapped type and never the owner's, settled by a later event", async ({
    signal,
  }) => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const issue = await own.createItem({
      type: plugin.issue,
      properties: { title: "an end" },
    });
    expect(issue.status).toBe(201);
    const ownerKey = (
      await mint(server, `reach-stream-${fresh()}`, [], { "*": "read" })
    ).key;
    const query: [string, string][] = [
      ["type", plugin.ticket],
      ["edges", "all"],
    ];
    const itemOf = (event: { data: unknown }) =>
      (event.data as { item?: { id?: string } })?.item?.id ??
      (event.data as { edge?: { from_id?: string } })?.edge?.from_id;

    await withStreamAtCursor(
      server.apiUrl,
      key.key,
      { query, signal },
      async (connector) => {
        expect(connector.response.status).toBe(200);
        await withStreamAtCursor(
          server.apiUrl,
          ownerKey,
          { query, signal },
          async (watching) => {
            const theirs = await ticket(owner, plugin);
            const mine = await ticket(own, plugin);
            const changed = await owner.updateItem(mine.id, {
              version: mine.version,
              properties: { title: "changed in Marfa" },
            });
            expect(changed.status, JSON.stringify(changed.error)).toBe(200);
            for (const from of [theirs.id, mine.id]) {
              const linked = await owner.createEdge({
                from_id: from,
                to_id: issue.data.item.id,
                edge_type: "references",
              });
              expect(linked.status, JSON.stringify(linked.error)).toBe(201);
            }
            const sentinel = await ticket(own, plugin);

            // The witness: the owner's stream carries the owner's ticket.
            const seen = await collectUntil(
              watching,
              (events) => events.some((event) => itemOf(event) === sentinel.id),
              "the sentinel on the owner's stream",
              signal,
            );
            expect(
              seen.events.filter((event) => itemOf(event) === theirs.id).length,
            ).toBe(2);

            const { events } = await collectUntil(
              connector,
              (got) => got.some((event) => itemOf(event) === sentinel.id),
              "the sentinel on the connector's stream",
              signal,
            );
            const about = (id: string) =>
              events
                .filter((event) => itemOf(event) === id)
                .map((event) => event.event);
            expect(about(mine.id)).toEqual([
              "item.created",
              "item.updated",
              "edge.created",
            ]);
            expect(about(theirs.id)).toEqual([]);
          },
        );
      },
    );
  });

  it("settles the tombstones of its own purged items of the mapped type by source and natural key, and none by link or under another source", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const mine = await ticket(own, plugin, { source_id: `m-${fresh()}` });
    const theirs = await ticket(owner, plugin, { source_id: `o-${fresh()}` });
    for (const [by, id] of [
      [own, mine.id],
      [owner, theirs.id],
    ] as const) {
      expect((await by.deleteItem(id)).status).toBe(200);
      expect((await by.purgeItem(id)).status).toBe(200);
    }
    const later = new Date(Date.now() + 3_600_000).toISOString();

    const settled = await own.settleTombstones({
      type: plugin.ticket,
      source: plugin.source,
      source_ids: [mine.source_id!],
      settled_at: later,
    });
    expect(settled.status, JSON.stringify(settled.error)).toBe(200);
    expect(settled.data.data).toEqual([
      expect.objectContaining({ key: mine.source_id, settled_at: later }),
    ]);

    const another = await own.settleTombstones({
      type: plugin.ticket,
      source: ownerSource,
      source_ids: [theirs.source_id!],
      settled_at: later,
    });
    expect(another.status).toBe(403);
    expect(another.error?.error.code).toBe("type_not_permitted");
    // The witness: the owner settles the tombstone the connector was refused.
    const byOwner = await owner.settleTombstones({
      type: plugin.ticket,
      source: ownerSource,
      source_ids: [theirs.source_id!],
      settled_at: later,
    });
    expect(byOwner.data.data).toHaveLength(1);

    // A link's tombstone names no source, so the connector settles none by link.
    const linked = `user.linkticket${fresh()}`;
    const registered = await owner.registerType({
      id: linked,
      parent: "core.task",
      fields: { address: { type: "string" } },
      link_field: "address",
    } as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const moved = await owner.saveConnectorMapping(plugin.name, {
      version: 1,
      kinds: {
        issue: { target_type: linked, fields: { title: { from: "title" } } },
      },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    const address = `https://tracker.example.test/${fresh()}`;
    const made = await own.createItem({
      type: linked,
      source_id: `l-${fresh()}`,
      properties: { title: "linked", address },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    expect((await own.deleteItem(made.data.item.id)).status).toBe(200);
    expect((await own.purgeItem(made.data.item.id)).status).toBe(200);
    const byLink = await own.settleTombstones({
      type: linked,
      links: [address],
      settled_at: later,
    });
    expect(byLink.status).toBe(403);
    expect(byLink.error?.error.code).toBe("type_not_permitted");
    const bySource = await own.settleTombstones({
      type: linked,
      source: plugin.source,
      source_ids: [made.data.item.source_id!],
      settled_at: later,
    });
    expect(bySource.status, JSON.stringify(bySource.error)).toBe(200);
    expect(bySource.data.data).toHaveLength(1);
    const ownerByLink = await owner.settleTombstones({
      type: linked,
      links: [address],
      settled_at: later,
    });
    expect(ownerByLink.data.data).toHaveLength(1);
  });

  it("lists, streams and settles nothing of the mapped type when its stored mapping does not read", async () => {
    await readsNothing(
      `UPDATE connector_mappings SET kinds = '{"issue":{"tier":"archive"}}' WHERE plugin = ?`,
    );
  });

  it("lists, streams and settles nothing of the mapped type when its stored connector does not read", async () => {
    await readsNothing(
      "UPDATE plugins SET manifest = json_set(manifest, '$.connector.kinds', 'unreadable') WHERE name = ?",
    );
  });
});

describe("a mapped type that holds none of the connector's items", () => {
  it("lists the mapped type and its parent as an empty page while it holds no items, and while it holds only the owner's", async () => {
    const part = fresh();
    const group = `user.group${part}`;
    const target = `user.groupticket${part}`;
    for (const registered of [
      await owner.registerType({
        id: group,
        parent: "core.task",
        fields: {},
      } as never),
      await owner.registerType({
        id: target,
        parent: group,
        fields: { reporter: { type: "string" } },
      } as never),
    ]) {
      expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    }
    const plugin = await installed(owner);
    const key = await connectorKey(server, plugin);
    const saved = await owner.saveConnectorMapping(plugin.name, {
      version: 0,
      kinds: {
        issue: { target_type: target, fields: { title: { from: "title" } } },
      },
    });
    expect(saved.status, JSON.stringify(saved.error)).toBe(200);
    const listedBy = async (by: MarfaClient, type: string) => {
      const page = await by.listItems({ type, limit: 100 });
      expect(page.status, `${type}: ${JSON.stringify(page.error)}`).toBe(200);
      return page.data.data.map((item) => item.id);
    };

    for (const type of [target, group]) {
      expect(await listedBy(key.client, type)).toEqual([]);
    }
    const theirs = await owner.createItem({
      type: target,
      properties: { title: "the owner's", reporter: "o" },
    });
    expect(theirs.status, JSON.stringify(theirs.error)).toBe(201);
    for (const type of [target, group]) {
      // The witness: the owner lists its item under both types.
      expect(await listedBy(owner, type)).toEqual([theirs.data.item.id]);
      expect(await listedBy(key.client, type)).toEqual([]);
    }
    const mine = await key.client.createItem({
      type: target,
      source_id: `m-${part}`,
      properties: { title: "the connector's" },
    });
    expect(mine.status, JSON.stringify(mine.error)).toBe(201);
    for (const type of [target, group]) {
      expect(await listedBy(key.client, type)).toEqual([mine.data.item.id]);
    }
  });
});

/** The ids of the edges in `blocks` of `edge_type`, or none for a block left out. */
function blockIds(
  blocks: Record<string, { data: { id: string }[] }> | undefined,
  edgeType: string,
): string[] {
  return (blocks?.[edgeType]?.data ?? []).map((edge) => edge.id);
}

/** Every edge `walk` pages through, two at a time, with the size of each page. */
async function pagedEdges(
  walk: (
    cursor: string | undefined,
  ) => Promise<
    ApiResponse<{ data: { id: string }[]; next_cursor?: string | null }>
  >,
): Promise<{ ids: string[]; sizes: number[] }> {
  const ids: string[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await walk(cursor);
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    sizes.push(page.data.data.length);
    ids.push(...page.data.data.map((edge) => edge.id));
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return { ids, sizes };
}

describe("the edges the connector reads from its own items on the target type", () => {
  it("reads an edge from its own item of the mapped type on every edge door, and never one from the owner's item into its own", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const mine = await ticket(own, plugin, { source_id: `a-${fresh()}` });
    const other = await ticket(own, plugin, { source_id: `b-${fresh()}` });
    const theirs = await ticket(owner, plugin);
    const link = async (by: MarfaClient, from: string, to: string) => {
      const made = await by.createEdge({
        from_id: from,
        to_id: to,
        edge_type: "references",
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      return made.data.edge.id;
    };
    const ownEdge = await link(own, mine.id, other.id);
    const intoMine = await link(owner, theirs.id, mine.id);

    // `include=edges` on a listing, an item read and a lookup.
    const listed = await own.listItems({
      type: plugin.ticket,
      include: "edges",
      limit: 100,
    });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    const listedMine = listed.data.data.find((item) => item.id === mine.id);
    expect(blockIds(listedMine?.edges as never, "references")).toEqual([
      ownEdge,
    ]);
    const read = await own.getItemWithBackrefs(mine.id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    expect(blockIds(read.data.item.edges as never, "references")).toEqual([
      ownEdge,
    ]);
    expect(blockIds(read.data.backrefs as never, "references")).toEqual([]);
    const otherRead = await own.getItemWithBackrefs(other.id);
    expect(blockIds(otherRead.data.backrefs as never, "references")).toEqual([
      ownEdge,
    ]);
    const looked = await own.lookupItems({
      type: plugin.ticket,
      ids: [mine.id],
      include: ["edges"],
    });
    expect(looked.status, JSON.stringify(looked.error)).toBe(200);
    expect(blockIds(looked.data.data[0]?.edges as never, "references")).toEqual(
      [ownEdge],
    );

    // The per-item doors and the edge listing.
    const out = await own.listItemEdges(mine.id, { edge_type: "references" });
    expect(out.status, JSON.stringify(out.error)).toBe(200);
    expect(out.data.data.map((edge) => edge.id)).toEqual([ownEdge]);
    const back = await own.listItemBackrefs(mine.id, {
      edge_type: "references",
    });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    expect(back.data.data).toEqual([]);
    const otherBack = await own.listItemBackrefs(other.id, {
      edge_type: "references",
    });
    expect(otherBack.data.data.map((edge) => edge.id)).toEqual([ownEdge]);
    const all = await pagedEdges((cursor) =>
      own.listEdges({
        edge_type: "references",
        limit: 2,
        ...(cursor !== undefined && { cursor }),
      }),
    );
    expect(all.ids).toContain(ownEdge);
    expect(all.ids).not.toContain(intoMine);
    expect((await own.getEdge(ownEdge)).status).toBe(200);
    expect((await own.getEdge(intoMine)).status).toBe(404);

    // The witness: the owner reads the edge from its item into the connector's.
    const ownerBack = await owner.listItemBackrefs(mine.id, {
      edge_type: "references",
    });
    expect(ownerBack.data.data.map((edge) => edge.id)).toEqual([intoMine]);
    const ownerRead = await owner.getItemWithBackrefs(mine.id);
    expect(blockIds(ownerRead.data.backrefs as never, "references")).toEqual([
      intoMine,
    ]);
    expect((await owner.getEdge(intoMine)).status).toBe(200);
  });

  it("fills each page of the edge listing and of an item's edges with the edges from its own items, between many from the owner's, and pages to the end", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const hub = await ticket(own, plugin, { source_id: `h-${fresh()}` });
    const edgeType = `mock.reach.paged.p${fresh()}`;
    const registered = await owner.registerEdgeType({
      label: "Paged",
      id: edgeType,
      cardinality: "many-to-many",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const mine: string[] = [];
    const theirs: string[] = [];
    for (let at = 0; at < 5; at += 1) {
      const from = await ticket(own, plugin, { source_id: `p-${fresh()}` });
      const made = await own.createEdge({
        from_id: from.id,
        to_id: hub.id,
        edge_type: edgeType,
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      mine.push(made.data.edge.id);
      for (let more = 0; more < 3; more += 1) {
        const by = await ticket(owner, plugin);
        const hidden = await owner.createEdge({
          from_id: by.id,
          to_id: hub.id,
          edge_type: edgeType,
        });
        expect(hidden.status, JSON.stringify(hidden.error)).toBe(201);
        theirs.push(hidden.data.edge.id);
      }
    }
    const walks = {
      edges: (cursor: string | undefined) =>
        own.listEdges({
          edge_type: edgeType,
          limit: 2,
          ...(cursor !== undefined && { cursor }),
        }),
      backrefs: (cursor: string | undefined) =>
        own.listItemBackrefs(hub.id, {
          edge_type: edgeType,
          limit: 2,
          ...(cursor !== undefined && { cursor }),
        }),
    };
    for (const [door, walk] of Object.entries(walks)) {
      const { ids, sizes } = await pagedEdges(walk);
      expect([...ids].sort(), door).toEqual([...mine].sort());
      expect(sizes, door).toEqual([2, 2, 1]);
    }
    // The witness: the owner pages through every edge.
    const everything = await pagedEdges((cursor) =>
      owner.listEdges({
        edge_type: edgeType,
        limit: 50,
        ...(cursor !== undefined && { cursor }),
      }),
    );
    expect([...everything.ids].sort()).toEqual([...mine, ...theirs].sort());
  });

  it("reads no edge from its own item of an edge type its edge map does not read", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const mine = await ticket(own, plugin, { source_id: `a-${fresh()}` });
    const other = await ticket(own, plugin, { source_id: `b-${fresh()}` });
    const made = await owner.createEdge({
      from_id: mine.id,
      to_id: other.id,
      edge_type: "references",
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const edge = made.data.edge.id;
    // The witness: while its edge map reads the type, the key reads the edge.
    const seen = await own.listItemEdges(mine.id, { edge_type: "references" });
    expect(seen.data.data.map((held) => held.id)).toEqual([edge]);
    const narrowed = await local(server).updateKey(key.id, {
      edge_permissions: { "attached-to": "read" },
    });
    expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);

    const out = await own.listItemEdges(mine.id, { edge_type: "references" });
    expect(out.status, JSON.stringify(out.error)).toBe(200);
    expect(out.data.data).toEqual([]);
    const listed = await own.listEdges({ edge_type: "references" });
    expect(listed.data.data.map((held) => held.id)).not.toContain(edge);
    const read = await own.getItem(mine.id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    expect(blockIds(read.data.item.edges as never, "references")).toEqual([]);
    expect((await own.getEdge(edge)).status).toBe(404);
  });
});

describe("what the connector reads of its own item's history, extensions and tables", () => {
  it("reads the versions, extensions and table rows of its own item of the mapped type, and answers the owner's item of that type as one it cannot read", async () => {
    const namespace = `reachext.${fresh()}`;
    const { plugin, key } = await mapped({
      extension_permissions: { [namespace]: "read" },
    });
    const own = key.client;
    const mine = await ticket(own, plugin, { source_id: `h-${fresh()}` });
    const theirs = await ticket(owner, plugin, { source_id: `o-${fresh()}` });
    const extender = (
      await mint(
        server,
        `reach-ext-${fresh()}`,
        [],
        { "*": "write" },
        {
          extension_permissions: { [namespace]: "write" },
        },
      )
    ).client;
    for (const [by, item] of [
      [own, mine],
      [owner, theirs],
    ] as const) {
      const patched = await by.updateItem(item.id, {
        version: item.version,
        properties: { title: "a second version" },
      });
      expect(patched.status, JSON.stringify(patched.error)).toBe(200);
      const rows = await by.writeRows(item.id, "log", {
        operations: [{ op: "put", values: { line: "opened" } }],
      });
      expect(rows.status, JSON.stringify(rows.error)).toBe(200);
      const extended = await extender.setItemExtension(item.id, namespace, {
        synced: true,
      });
      expect(extended.status, JSON.stringify(extended.error)).toBe(200);
    }

    const doors: [string, (id: string) => Promise<ApiResponse<any>>][] = [
      ["versions", (id) => own.getVersions(id)],
      ["extensions", (id) => own.listItemExtensions(id)],
      ["extension", (id) => own.getItemExtension(id, namespace)],
      ["tables", (id) => own.listTables(id)],
      ["rows", (id) => own.listRows(id, "log")],
      ["totals", (id) => own.rowTotals(id, "log")],
      ["batches", (id) => own.listBatches(id, "log")],
    ];
    const answered = new Map<string, any>();
    for (const [door, call] of doors) {
      const answer = await call(mine.id);
      expect(answer.status, `${door}: ${JSON.stringify(answer.error)}`).toBe(
        200,
      );
      answered.set(door, answer.data);
    }
    // A key whose type map reads the type reads the same history of it.
    const history = (await owner.getVersions(mine.id)).data.data;
    expect(history.length).toBeGreaterThan(0);
    expect(answered.get("versions").data).toEqual(history);
    expect(
      (answered.get("extensions").data as { namespace: string }[]).map(
        (entry) => entry.namespace,
      ),
    ).toContain(namespace);
    expect(answered.get("extension").document).toEqual({ synced: true });
    expect(
      (answered.get("tables").data as { name: string }[]).map(
        (table) => table.name,
      ),
    ).toContain("log");
    const rows = answered.get("rows").data as { id: string; values: unknown }[];
    expect(rows.map((row) => row.values)).toEqual([{ line: "opened" }]);
    expect(answered.get("batches").data).toHaveLength(1);
    const row = await own.getRow(mine.id, "log", rows[0]!.id);
    expect(row.status, JSON.stringify(row.error)).toBe(200);
    expect(row.data.values).toEqual({ line: "opened" });

    // The witness: the owner reads the same doors on its own item.
    const ownerVersions = await owner.getVersions(theirs.id);
    expect(ownerVersions.data.data.length).toBeGreaterThan(0);
    const ownerRows = await owner.listRows(theirs.id, "log");
    expect(ownerRows.data.data).toHaveLength(1);
    const unreached = await own.getItem(theirs.id);
    expect(unreached.status).toBe(404);
    const refusal = (answer: ApiResponse<unknown>) => ({
      status: answer.status,
      code: answer.error?.error.code,
    });
    for (const [door, call] of doors) {
      expect(refusal(await call(theirs.id)), door).toEqual(refusal(unreached));
    }
    expect(
      refusal(await own.getRow(theirs.id, "log", ownerRows.data.data[0]!.id)),
    ).toEqual(refusal(unreached));
  });
});

describe("the agreements on its own items of the target type", () => {
  async function holding(own: MarfaClient): Promise<{
    id: string;
    process: string;
  }> {
    const registered = await own.registerConnector({
      name: `agreements ${fresh()}`,
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const process = `run-${fresh()}`;
    const held = await own.takeConnectorHold(registered.data.id, process);
    expect(held.status, JSON.stringify(held.error)).toBe(200);
    return { id: registered.data.id, process };
  }

  it("writes, reads, lists and clears the agreements of its own items of the mapped type, and skips the owner's", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const { id, process } = await holding(own);
    const mine = await ticket(own, plugin);
    const owners = await ticket(owner, plugin);
    const issue = await own.createItem({
      type: plugin.issue,
      properties: { title: "its own type" },
    });
    expect(issue.status).toBe(201);
    const ownType = issue.data.item.id;

    const written = await own.writeConnectorAgreements(id, {
      process,
      set: [mine.id, owners.id, ownType].map((item_id) => ({
        item_id,
        waiting: false,
        record: { at: item_id },
      })),
    });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    expect(written.data).toEqual({
      written: 2,
      cleared: 0,
      skipped: [owners.id],
    });
    const looked = await own.lookupConnectorAgreements(id, [
      mine.id,
      owners.id,
      ownType,
    ]);
    expect(looked.status, JSON.stringify(looked.error)).toBe(200);
    expect(looked.data.data.map((row) => row.item_id).sort()).toEqual(
      [mine.id, ownType].sort(),
    );
    expect(
      looked.data.data.find((row) => row.item_id === mine.id)?.record,
    ).toEqual({ at: mine.id });
    const listed = await own.listConnectorAgreements(id);
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.data.map((row) => row.item_id).sort()).toEqual(
      [mine.id, ownType].sort(),
    );

    const cleared = await own.writeConnectorAgreements(id, {
      process,
      clear: [mine.id, owners.id],
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    expect(cleared.data).toEqual({
      written: 0,
      cleared: 1,
      skipped: [owners.id],
    });
    expect(
      (await own.lookupConnectorAgreements(id, [mine.id])).data.data,
    ).toEqual([]);
  });

  it("skips its own items of the mapped type once the kind is off, keeps their agreements, and answers them again once it is back", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const { id, process } = await holding(own);
    const mine = await ticket(own, plugin);
    const set = (record: string) =>
      own.writeConnectorAgreements(id, {
        process,
        set: [{ item_id: mine.id, waiting: true, record: { record } }],
      });
    // The witness: while the kind is on, the agreement is written.
    const first = await set("on");
    expect(first.data, JSON.stringify(first.error)).toMatchObject({
      written: 1,
      skipped: [],
    });
    const off = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 1, { enabled: false }),
    );
    expect(off.status, JSON.stringify(off.error)).toBe(200);
    const skipped = await set("off");
    expect(skipped.data, JSON.stringify(skipped.error)).toEqual({
      written: 0,
      cleared: 0,
      skipped: [mine.id],
    });
    expect((await own.listConnectorAgreements(id)).data.data).toEqual([]);
    expect(
      (await own.lookupConnectorAgreements(id, [mine.id])).data.data,
    ).toEqual([]);
    const back = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 2),
    );
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    const kept = await own.lookupConnectorAgreements(id, [mine.id]);
    expect(kept.data.data.map((row) => row.record)).toEqual([{ record: "on" }]);
  });

  it("decides an agreement held on the writer by the mapping saved while it waited", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const { id, process } = await holding(own);
    const mine = await ticket(own, plugin);
    const held = async (version: number, enabled: boolean) => {
      await server.setFault("hold:connector-write");
      const pending = own.writeConnectorAgreements(id, {
        process,
        set: [{ item_id: mine.id, waiting: false, record: { version } }],
      });
      await server.waitForHold("hold:connector-write");
      const saved = await owner.saveConnectorMapping(
        plugin.name,
        onTickets(plugin, version, { enabled }),
      );
      expect(saved.status, JSON.stringify(saved.error)).toBe(200);
      await server.clearFault("hold:connector-write");
      return pending;
    };
    // The witness: a save that keeps the kind on lets the held write through.
    const kept = await held(1, true);
    expect(kept.data, JSON.stringify(kept.error)).toMatchObject({
      written: 1,
    });
    const turnedOff = await held(2, false);
    expect(turnedOff.data, JSON.stringify(turnedOff.error)).toMatchObject({
      written: 0,
      skipped: [mine.id],
    });
  });
});

describe("moving its own item between its own type and the target type", () => {
  it("retypes its own item into the mapped target type and back, refusing a move that falls short of the type it enters", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const made = await own.createItem({
      type: plugin.issue,
      properties: { title: "moves", number: 7 },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const item = made.data.item;
    const short = await own.updateItem(item.id, {
      version: item.version,
      type: plugin.ticket,
      retype: true,
    });
    expect(short.status, JSON.stringify(short.data)).toBe(400);
    expect(short.error?.error.code).toBe("invalid_properties");
    const into = await own.updateItem(item.id, {
      version: item.version,
      type: plugin.ticket,
      retype: true,
      properties: { reporter: "tracker" },
    });
    expect(into.status, JSON.stringify(into.error)).toBe(200);
    expect(into.data.item.type).toBe(plugin.ticket);
    expect(into.data.item.source).toBe(plugin.source);
    const read = await own.getItem(item.id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    expect(read.data.item.type).toBe(plugin.ticket);

    const back = await own.updateItem(item.id, {
      version: into.data.item.version,
      type: plugin.issue,
      retype: true,
    });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    expect(back.data.item.type).toBe(plugin.issue);

    const bulk = await own.bulkItems({
      retype: true,
      items: [
        {
          id: item.id,
          type: plugin.ticket,
          properties: { reporter: "tracker" },
        },
      ],
    });
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(bulk.data.results[0]?.outcome, JSON.stringify(bulk.data)).toBe(
      "updated",
    );
    expect((await own.getItem(item.id)).data.item.type).toBe(plugin.ticket);
  });

  it("refuses to move the owner's item of its own type into the target type, an item into a type outside its reach, and its own item once the kind is off", async () => {
    const { plugin, key } = await mapped();
    const own = key.client;
    const owners = await owner.createItem({
      type: plugin.issue,
      properties: { title: "the owner's" },
    });
    expect(owners.status, JSON.stringify(owners.error)).toBe(201);
    const theirs = owners.data.item;
    // The witness: the key's type map writes the owner's item of its own type.
    const edited = await own.updateItem(theirs.id, {
      version: theirs.version,
      properties: { title: "edited by the connector" },
    });
    expect(edited.status, JSON.stringify(edited.error)).toBe(200);
    const moved = await own.updateItem(theirs.id, {
      version: edited.data.item.version,
      type: plugin.ticket,
      retype: true,
      properties: { reporter: "x" },
    });
    expect(moved.status, JSON.stringify(moved.data)).toBe(403);
    expect(moved.error?.error.code).toBe("type_not_permitted");
    const bulk = await own.bulkItems({
      atomic: false,
      retype: true,
      items: [
        {
          id: theirs.id,
          type: plugin.ticket,
          properties: { reporter: "x" },
        },
      ],
    });
    expect(bulk.data.results[0]?.outcome, JSON.stringify(bulk.data)).toBe(
      "errored",
    );
    expect(bulk.data.results[0]?.error?.code).toBe("type_not_permitted");
    const still = await owner.getItem(theirs.id);
    expect(still.data.item.type).toBe(plugin.issue);

    const ownersTicket = await ticket(owner, plugin);
    refusedAsUnreached(
      await own.updateItem(ownersTicket.id, {
        version: ownersTicket.version,
        type: plugin.issue,
        retype: true,
      }),
      "retype the owner's ticket",
    );
    expect((await owner.getItem(ownersTicket.id)).data.item.type).toBe(
      plugin.ticket,
    );

    const mine = await own.createItem({
      type: plugin.issue,
      properties: { title: "mine" },
    });
    expect(mine.status).toBe(201);
    const outside = await own.updateItem(mine.data.item.id, {
      version: mine.data.item.version,
      type: "core.note",
      retype: true,
    });
    expect(outside.status, JSON.stringify(outside.data)).toBe(403);
    expect(outside.error?.error.code).toBe("type_not_permitted");

    const off = await owner.saveConnectorMapping(
      plugin.name,
      onTickets(plugin, 1, { enabled: false }),
    );
    expect(off.status, JSON.stringify(off.error)).toBe(200);
    const whileOff = await own.updateItem(mine.data.item.id, {
      version: mine.data.item.version,
      type: plugin.ticket,
      retype: true,
      properties: { reporter: "x" },
    });
    expect(whileOff.status, JSON.stringify(whileOff.data)).toBe(403);
    expect(whileOff.error?.error.code).toBe("type_not_permitted");
  });
});

describe("the MCP tools", () => {
  it("finds none of its own items of the mapped type through marfa_find, which GET /items lists", async () => {
    const { plugin, key } = await mapped();
    const mine = await ticket(key.client, plugin, {
      source_id: `m-${fresh()}`,
    });
    // The witness: the listing door lists the connector's own item.
    const listed = await key.client.listItems({ type: plugin.ticket });
    expect(listed.data.data.map((item) => item.id)).toEqual([mine.id]);
    const mcp = await connectMcp(server.apiUrl, key.key);
    try {
      const found = await callTool(mcp, "marfa_find", { type: plugin.ticket });
      expect(JSON.stringify(found)).not.toContain(mine.id);
      expect(toolError(found).code).toBe("type_not_permitted");
    } finally {
      await mcp.close();
    }
  });

  it("reads no field of its own item of the mapped type through marfa_get, which answers it as an item it cannot read", async () => {
    const { plugin, key } = await mapped();
    const mine = await ticket(key.client, plugin, {
      source_id: `f-${fresh()}`,
      properties: { title: "a field to read", reporter: "someone" },
    });
    const absent = `${mine.id.slice(0, -1)}${mine.id.endsWith("0") ? "1" : "0"}`;
    // The witnesses: GET /items/{id} reads the connector's own item, and a
    // key whose type map reads the type reads the field over MCP.
    const read = await key.client.getItem(mine.id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    const reader = await mint(server, `reach-reader-${fresh()}`, [], {
      [plugin.ticket]: "read",
    });
    const readerMcp = await connectMcp(server.apiUrl, reader.key);
    try {
      const part = await callTool(readerMcp, "marfa_get", {
        ids: [mine.id],
        field: "title",
      });
      expect(toolResult(part).text).toBe("a field to read");
    } finally {
      await readerMcp.close();
    }

    const mcp = await connectMcp(server.apiUrl, key.key);
    try {
      const part = await callTool(mcp, "marfa_get", {
        ids: [mine.id],
        field: "title",
      });
      expect(JSON.stringify(part)).not.toContain("a field to read");
      const missing = await callTool(mcp, "marfa_get", {
        ids: [absent],
        field: "title",
      });
      const unread = (answer: typeof part, id: string) =>
        JSON.stringify(toolError(answer)).replaceAll(id, "<id>");
      expect(unread(part, mine.id)).toBe(unread(missing, absent));
      const whole = await callTool(mcp, "marfa_get", { ids: [mine.id] });
      expect(toolResult(whole).not_found).toEqual([mine.id]);
    } finally {
      await mcp.close();
    }
  });
});

describe("a rewrite back from a type the kind was mapped onto before", () => {
  /** Its own tickets, the owner's and another source's, then the kind moved off tickets. */
  async function strandedOnTickets(
    entry: (plugin: ConnectorPlugin) => Record<string, unknown>,
  ) {
    const { plugin, key } = await mapped();
    const mine = [];
    for (const title of ["first", "second", "third", "left behind"]) {
      mine.push(
        await ticket(key.client, plugin, {
          source_id: `back-${fresh()}`,
          properties: { title, reporter: "tracker" },
        }),
      );
    }
    const owners = await ticket(owner, plugin);
    const other = await mint(server, `reach-other-${fresh()}`, [], {
      [plugin.ticket]: "write",
    });
    const others = await ticket(other.client, plugin);
    const moved = await owner.saveConnectorMapping(plugin.name, {
      version: 1,
      kinds: { issue: entry(plugin) },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    return { plugin, key, mine, owners, others };
  }

  it("lists, reads and moves its own items back from the former target type while a rewrite is open, never the owner's or another source's, and reaches none once the request is cleared", async () => {
    const { plugin, key, mine, owners, others } = await strandedOnTickets(
      (plugin) => ({ target_type: plugin.issue }),
    );
    const own = key.client;
    // The witness: the kind's move off tickets leaves its items there out of reach.
    refusedAsUnreached(await own.getItem(mine[0]!.id), "before the rewrite");

    const asked = await owner.rewriteConnectorItems(plugin.name, {
      kinds: ["issue"],
    });
    expect(asked.status, JSON.stringify(asked.error)).toBe(200);
    expect(asked.data.kinds).toEqual({
      issue: { target_type: plugin.issue, count: 4 },
    });
    const mapping = await own.getConnectorMapping(plugin.name);
    expect(mapping.status, JSON.stringify(mapping.error)).toBe(200);
    expect(mapping.data.rewrites).toEqual([
      expect.objectContaining({
        number: asked.data.number,
        kinds: ["issue"],
        from: { issue: [plugin.ticket] },
      }),
    ]);

    const listed = await own.listItems({ type: plugin.ticket, limit: 2 });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    const ids = listed.data.data.map((item) => item.id);
    let cursor = listed.data.next_cursor ?? undefined;
    while (cursor) {
      const page = await own.listItems({
        type: plugin.ticket,
        limit: 2,
        cursor,
      });
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      ids.push(...page.data.data.map((item) => item.id));
      cursor = page.data.next_cursor ?? undefined;
    }
    expect(ids.sort()).toEqual(mine.map((item) => item.id).sort());
    const read = await own.getItem(mine[0]!.id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);

    for (const theirs of [owners, others]) {
      expect((await own.getItem(theirs.id)).status).toBe(404);
      const taken = await own.updateItem(theirs.id, {
        version: theirs.version,
        type: plugin.issue,
        retype: true,
      });
      expect(taken.status, JSON.stringify(taken.data)).toBe(404);
    }
    const edited = await own.updateItem(mine[0]!.id, {
      version: mine[0]!.version,
      properties: { title: "edited where it was" },
    });
    expect(edited.status, JSON.stringify(edited.data)).toBe(403);
    expect(edited.error?.error.code).toBe("type_not_permitted");
    const created = await own.createItem({
      type: plugin.ticket,
      properties: { title: "new on the former target", reporter: "tracker" },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(403);

    for (const item of mine.slice(0, 2)) {
      const back = await own.updateItem(item.id, {
        version: item.version,
        type: plugin.issue,
        retype: true,
      });
      expect(back.status, JSON.stringify(back.error)).toBe(200);
      expect(back.data.item.type).toBe(plugin.issue);
    }
    const bulk = await own.bulkItems({
      retype: true,
      items: [
        {
          type: plugin.issue,
          source_id: mine[2]!.source_id!,
          properties: { title: "third" },
        },
      ],
    });
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(bulk.data.results[0]?.outcome, JSON.stringify(bulk.data)).toBe(
      "updated",
    );
    expect((await own.getItem(mine[2]!.id)).data.item.type).toBe(plugin.issue);

    const done = await own.finishConnectorRewrite(plugin.name, {
      number: asked.data.number,
    });
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    refusedAsUnreached(await own.getItem(mine[3]!.id), "after the rewrite");
    const after = await own.listItems({ type: plugin.ticket });
    expect(
      after.ok ? after.data.data.map((item) => item.id) : [],
    ).not.toContain(mine[3]!.id);
    const late = await own.updateItem(mine[3]!.id, {
      version: mine[3]!.version,
      type: plugin.issue,
      retype: true,
    });
    refusedAsUnreached(late, "a move after the rewrite");
    for (const theirs of [owners, others]) {
      const held = await owner.getItem(theirs.id);
      expect(held.data.item).toMatchObject({
        type: plugin.ticket,
        version: theirs.version,
      });
    }
  });

  it("moves its own items from the former target type onto the kind's new target type and no other", async () => {
    const third = `user.third${fresh()}`;
    const registered = await owner.registerType(ticketType(third) as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const { plugin, key, mine } = await strandedOnTickets(() => ({
      target_type: third,
      fields: { title: { from: "title" }, reporter: { fixed: "tracker" } },
    }));
    const own = key.client;
    const asked = await owner.rewriteConnectorItems(plugin.name, {
      kinds: ["issue"],
    });
    expect(asked.status, JSON.stringify(asked.error)).toBe(200);
    expect(asked.data.kinds.issue).toEqual({ target_type: third, count: 4 });

    const elsewhere = await own.updateItem(mine[0]!.id, {
      version: mine[0]!.version,
      type: plugin.issue,
      retype: true,
    });
    expect(elsewhere.status, JSON.stringify(elsewhere.data)).toBe(403);
    expect(elsewhere.error?.error.code).toBe("type_not_permitted");
    const onto = await own.updateItem(mine[0]!.id, {
      version: mine[0]!.version,
      type: third,
      retype: true,
    });
    expect(onto.status, JSON.stringify(onto.error)).toBe(200);
    expect(onto.data.item).toMatchObject({
      type: third,
      source: plugin.source,
    });
  });
});
