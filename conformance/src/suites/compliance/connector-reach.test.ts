import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { ApiResponse } from "../../client/types.js";
import {
  type ConnectorPlugin,
  connectorKey,
  fresh,
  installed,
  local,
  mint,
  onTickets,
} from "../../utils/connector-plugin.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

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
  key: { id: string; client: MarfaClient };
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
      "UPDATE connector_mappings SET kinds = 'unreadable' WHERE plugin = ?",
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
