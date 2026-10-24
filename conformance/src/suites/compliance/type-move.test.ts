import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  BulkActionJob,
  BulkActionResponse,
  TestContext,
  TypeMoveDryRun,
} from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackFolder,
  trackItem,
  trackKey,
  trackView,
  trackWebhook,
} from "../../utils/setup.js";
import { generateId } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let receiver: Receiver;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "type-move",
  ));
  // The owner revokes the key with `keys.manage` this file mints.
  ctx.provisioningClient = getOwnerClient();
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
  await cleanup(ctx);
});

/** A publisher namespace no other run holds, with a deal and a contract type in it. */
async function pair(
  label: string,
  contract: Record<string, unknown> = { name: { type: "string" } },
): Promise<{ ns: string; deal: string; contract: string }> {
  const ns = `move${label}${generateId().slice(-8).toLowerCase()}`;
  const deal = `${ns}.deal`;
  const to = `${ns}.contract`;
  for (const [id, fields] of [
    [deal, { name: { type: "string" }, amount: { type: "number" } }],
    [to, contract],
  ] as const) {
    const r = await client.registerType({ id, fields } as never);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
  }
  return { ns, deal, contract: to };
}

async function item(
  type: string,
  properties: Record<string, unknown>,
  state?: "archived" | "trashed",
): Promise<string> {
  const r = await client.createItem({
    type,
    properties,
    source: ctx.source,
    ...(state && { state }),
  });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function move(
  from: string,
  body: { to: string; properties?: Record<string, unknown> },
  by: MarfaClient = client,
): Promise<BulkActionResponse> {
  const r = await by.moveType(from, body);
  expect(r.status, JSON.stringify(r.error)).toBe(202);
  await expectMatchesSchema("POST", "/types/{id}/move", 202, r.data);
  const job = await by.pollBulkActionToTerminal((r.data as BulkActionJob).id);
  expect(job.status, job.error).toBe("completed");
  return job.result!;
}

async function typeOf(id: string): Promise<{ type: string; state: string }> {
  const r = await client.getItem(id);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return { type: r.data.item.type, state: r.data.item.state };
}

async function properties(id: string): Promise<Record<string, unknown>> {
  const r = await client.getItem(id);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.data.item.properties;
}

async function folder(settings: Record<string, unknown>): Promise<string> {
  const r = await client.createFolder({ title: "Moving", ...settings });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackFolder(ctx, r.data.item.id);
  return r.data.item.id;
}

async function view(query: Record<string, unknown>): Promise<string> {
  const r = await client.createView({
    title: "Moving",
    layouts: [{ id: "main", kind: "list" }],
    query,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackView(ctx, r.data.item.id);
  return r.data.item.id;
}

async function webhook(typeFilter: string): Promise<string> {
  const r = await client.createWebhook({
    url: receiver.hookUrl("type-move"),
    events: ["item.updated"],
    type_filter: typeFilter,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackWebhook(ctx, r.data.id, client);
  return r.data.id;
}

describe("moving a type's items", () => {
  it("moves every item of the type in any state, keeping a binned one in the bin", async () => {
    const { deal, contract } = await pair("states");
    const active = await item(deal, { name: "active" });
    const archived = await item(deal, { name: "archived" }, "archived");
    const binned = await item(deal, { name: "binned" }, "trashed");

    const result = await move(deal, { to: contract });
    expect(result.succeeded).toBe(3);
    expect(result.settings_rewritten).toBe(true);
    expect(await typeOf(active)).toEqual({ type: contract, state: "active" });
    expect(await typeOf(archived)).toEqual({
      type: contract,
      state: "archived",
    });
    const inBin = await client.rawRequest<{ data: { id: string }[] }>(
      `/items?type=${contract}&state=trashed`,
    );
    expect(inBin.data.data.map((row) => row.id)).toEqual([binned]);

    const deleted = await client.deleteType(deal);
    expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
  });

  it("writes nothing on a dry run, and the same move run for real writes", async () => {
    const { deal, contract } = await pair("dry");
    const id = await item(deal, { name: "kept" });
    const folderId = await folder({ query: { types: [deal] } });

    const dry = await client.moveType(deal, { to: contract, dry_run: true });
    expect(dry.status, JSON.stringify(dry.error)).toBe(200);
    await expectMatchesSchema("POST", "/types/{id}/move", 200, dry.data);
    const plan = dry.data as TypeMoveDryRun;
    expect(plan.ids).toEqual([id]);
    expect(plan.settings).toEqual([
      { kind: "folder", id: folderId, field: "query.types" },
    ]);
    expect((await typeOf(id)).type).toBe(deal);
    expect((await properties(folderId)).query).toEqual({ types: [deal] });

    await move(deal, { to: contract });
    expect((await typeOf(id)).type).toBe(contract);
    expect((await properties(folderId)).query).toEqual({ types: [contract] });
  });

  it("refuses a move to a type that isn't there, to a malformed one and to the type itself", async () => {
    const { ns, deal } = await pair("target");
    const id = await item(deal, { name: "stays" });
    const answers = await Promise.all([
      client.moveType(deal, { to: `${ns}.missing` }),
      client.moveType(deal, { to: "Not A Type" }),
      client.moveType(deal, { to: deal }),
      client.moveType(`${ns}.missing`, { to: deal }),
      client.moveType("core.note", { to: deal }),
    ]);
    expect(answers.map((r) => [r.status, r.error?.error.code])).toEqual([
      [400, "unknown_type"],
      [400, "validation_error"],
      [400, "validation_error"],
      [404, "type_not_found"],
      [403, "core_type_immutable"],
    ]);
    expect((await typeOf(id)).type).toBe(deal);
  });

  it("refuses a key without write on both types", async () => {
    const { deal, contract } = await pair("reach");
    const id = await item(deal, { name: "stays" });
    const minted = await client.createKey({
      label: "type-move-reach",
      source: `${ctx.source}-reach`,
      type_permissions: { [deal]: "write", [contract]: "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    const r = await narrow.moveType(deal, { to: contract });
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("type_not_permitted");
    expect((await typeOf(id)).type).toBe(deal);
  });

  it("moves the items of a parent type, leaving its subtypes' items and keeping the folder holding them", async () => {
    const { ns, deal, contract } = await pair("parent");
    const sub = `${ns}.bigdeal`;
    const registered = await client.registerType({
      id: sub,
      parent: deal,
      fields: {},
    } as never);
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const parentItem = await item(deal, { name: "parent" });
    const subItem = await item(sub, { name: "sub" });
    const folderId = await folder({ query: { types: [deal] } });
    // One type filter can't name both types the subtypes' items and the
    // moved ones are in.
    const hook = await webhook(deal);
    const blocked = await client.moveType(deal, { to: contract });
    expect(blocked.status).toBe(409);
    expect(
      (blocked.error?.error.details as { settings: { reason?: string }[] })
        .settings,
    ).toMatchObject([{ kind: "webhook", id: hook, reason: "subtypes" }]);
    expect((await client.deleteWebhook(hook)).ok).toBe(true);

    const result = await move(deal, { to: contract });
    expect(result.succeeded).toBe(1);
    expect(result.settings_rewritten).toBe(true);
    expect((await typeOf(parentItem)).type).toBe(contract);
    expect((await typeOf(subItem)).type).toBe(sub);
    expect((await properties(folderId)).query).toEqual({
      types: [deal, contract],
    });

    const deleted = await client.deleteType(deal);
    expect(deleted.status).toBe(409);
    expect(deleted.error?.error.code).toBe("type_has_subtypes");
  });

  it("rewrites the folders, views and webhooks that name the type once every item has moved", async () => {
    const { ns, deal, contract } = await pair("settings");
    await item(deal, { name: "moved" });
    const folderId = await folder({
      query: {
        types: [deal, "core.note"],
        filter: `type eq "${deal}" OR properties.name eq "${deal}"`,
      },
      defaults: { type: deal, tags: ["kept"] },
      first_placement: { [deal]: "Deals", "core.note": "Notes" },
    });
    const viewId = await view({
      types: [deal],
      filter: `type neq "${deal}"`,
    });
    const named = await webhook(deal);
    const pattern = await webhook(`${ns}.*`);

    const result = await move(deal, { to: contract });
    expect(result.settings_rewritten).toBe(true);
    expect(result.settings).toHaveLength(7);

    const settings = await properties(folderId);
    expect(settings.query).toEqual({
      types: [contract, "core.note"],
      filter: `type eq "${contract}" OR properties.name eq "${deal}"`,
    });
    expect(settings.defaults).toEqual({ type: contract, tags: ["kept"] });
    expect(settings.first_placement).toEqual({
      "core.note": "Notes",
      [contract]: "Deals",
    });
    expect((await properties(viewId)).query).toEqual({
      types: [contract],
      filter: `type neq "${contract}"`,
    });
    expect((await client.getWebhook(named)).data.type_filter).toBe(contract);
    expect((await client.getWebhook(pattern)).data.type_filter).toBe(`${ns}.*`);
  });

  it("moves what the new type accepts, rewrites no setting, and a second run finishes", async () => {
    const { deal, contract } = await pair("partial", {
      name: { type: "string" },
      amount: { type: "number", required: true },
    });
    const priced = await item(deal, { name: "priced", amount: 5 });
    const unpriced = await item(deal, { name: "unpriced" });
    const folderId = await folder({ query: { types: [deal] } });

    const first = await move(deal, { to: contract });
    expect(first.succeeded).toBe(1);
    expect(first.errors?.map((e) => e.id)).toEqual([unpriced]);
    expect(first.remaining).toBe(1);
    expect(first.remaining_hidden).toBe(false);
    expect(first.settings_rewritten).toBe(false);
    expect((await typeOf(priced)).type).toBe(contract);
    expect((await typeOf(unpriced)).type).toBe(deal);
    expect((await properties(folderId)).query).toEqual({ types: [deal] });

    const second = await move(deal, {
      to: contract,
      properties: { amount: 0 },
    });
    expect(second.succeeded).toBe(1);
    expect(second.remaining).toBe(0);
    expect(second.settings_rewritten).toBe(true);
    expect(await properties(unpriced)).toEqual({
      name: "unpriced",
      amount: 0,
    });
    expect((await properties(priced)).amount).toBe(5);
    expect((await properties(folderId)).query).toEqual({
      types: [contract],
    });
  });

  it("refuses a move a setting would stop, naming each setting and moving nothing", async () => {
    const { ns, deal, contract } = await pair("blocked");
    const id = await item(deal, { name: "stays" });
    const viewId = await view({ filter: `type starts_with "${ns}.d"` });
    const folderId = await folder({
      first_placement: { [deal]: "Deals", [contract]: "Contracts" },
    });

    for (const dry_run of [true, false]) {
      const r = await client.moveType(deal, { to: contract, dry_run });
      expect(r.status).toBe(409);
      expect(r.error?.error.code).toBe("type_move_blocked");
      const blocked = (
        r.error?.error.details as { settings: Record<string, unknown>[] }
      ).settings;
      expect(
        blocked.map(({ kind, id, field, reason }) => ({
          kind,
          id,
          field,
          reason,
        })),
      ).toEqual([
        {
          kind: "folder",
          id: folderId,
          field: "first_placement",
          reason: "placement_conflict",
        },
        {
          kind: "view",
          id: viewId,
          field: "query.filter",
          reason: "filter_term",
        },
      ]);
    }
    expect((await typeOf(id)).type).toBe(deal);
  });

  it("refuses a move that would make a filter longer than a filter may be", async () => {
    const { deal, contract } = await pair("long");
    const id = await item(deal, { name: "stays" });
    const head = `type eq "${deal}" OR properties.name eq "`;
    // 2,048 characters as written, the most a filter takes, and over once
    // it names the longer type.
    const viewId = await view({
      filter: `${head}${"x".repeat(2048 - head.length - 1)}"`,
    });

    const r = await client.moveType(deal, { to: contract, dry_run: true });
    expect(r.status).toBe(409);
    expect(r.error?.error.code).toBe("type_move_blocked");
    expect(
      (r.error?.error.details as { settings: Record<string, unknown>[] })
        .settings,
    ).toMatchObject([
      {
        kind: "view",
        id: viewId,
        field: "query.filter",
        reason: "filter_term",
      },
    ]);
    expect((await typeOf(id)).type).toBe(deal);
  });

  it("refuses a move naming a setting the key may not change, before moving anything", async () => {
    const { deal, contract } = await pair("authority");
    const id = await item(deal, { name: "stays" });
    const folderId = await folder({ query: { types: [deal] } });
    const minted = await client.createKey({
      label: "type-move-authority",
      source: `${ctx.source}-authority`,
      type_permissions: { [deal]: "write", [contract]: "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    // The witness: the key that may change the folder is told it would.
    const allowed = await client.moveType(deal, {
      to: contract,
      dry_run: true,
    });
    expect((allowed.data as TypeMoveDryRun).settings).toEqual([
      { kind: "folder", id: folderId, field: "query.types" },
    ]);

    const r = await narrow.moveType(deal, { to: contract });
    expect(r.status).toBe(409);
    expect(r.error?.error.code).toBe("type_move_blocked");
    expect(
      (
        r.error?.error.details as { settings: { reason?: string }[] }
      ).settings.map((setting) => setting.reason),
    ).toEqual(["not_permitted"]);
    expect((await typeOf(id)).type).toBe(deal);
  });

  it("lists the first 100 items a move left and counts every one", async () => {
    const { deal, contract } = await pair("cap", {
      name: { type: "string" },
      amount: { type: "number", required: true },
    });
    const made = await client.bulkItems({
      atomic: false,
      items: Array.from({ length: 101 }, (_, at) => ({
        type: deal,
        properties: { name: `unpriced ${String(at)}` },
        source: ctx.source,
      })),
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    for (const entry of made.data.results)
      if (entry.id !== undefined) trackItem(ctx, entry.id);
    expect(made.data.counts.created).toBe(101);

    const result = await move(deal, { to: contract });
    expect(result.errors).toHaveLength(100);
    expect(result).toMatchObject({
      errored: 101,
      remaining: 101,
      settings_rewritten: false,
    });
  });

  it("moves only the items the key's source filter shows, and says others remain without counting them", async () => {
    const { deal, contract } = await pair("hidden");
    const shown = await item(deal, { name: "shown" });
    const elsewhere = `${ctx.source}-elsewhere`;
    const writer = await client.createKey({
      label: "type-move-elsewhere",
      source: elsewhere,
      type_permissions: { [deal]: "write" },
    });
    expect(writer.ok, JSON.stringify(writer.error)).toBe(true);
    trackKey(ctx, writer.data.id);
    const made = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: writer.data.key,
    }).createItem({
      type: deal,
      properties: { name: "hidden" },
      source: elsewhere,
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    const filtered = await client.createKey({
      label: "type-move-filtered",
      source: `${ctx.source}-filtered`,
      type_permissions: { [deal]: "write", [contract]: "write" },
      enforcement_override: {
        source_filter: { types: [deal], sources: [ctx.source] },
      },
    });
    expect(filtered.ok, JSON.stringify(filtered.error)).toBe(true);
    trackKey(ctx, filtered.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: filtered.data.key,
    });

    const first = await move(deal, { to: contract }, narrow);
    expect(first).toMatchObject({
      succeeded: 1,
      remaining: 0,
      remaining_hidden: true,
      settings_rewritten: false,
    });
    expect((await typeOf(shown)).type).toBe(contract);
    expect((await typeOf(made.data.item.id)).type).toBe(deal);

    // The witness: a key that sees every item moves the rest and finishes.
    const rest = await move(deal, { to: contract });
    expect(rest).toMatchObject({
      succeeded: 1,
      remaining: 0,
      remaining_hidden: false,
      settings_rewritten: true,
    });
  });

  it("names a setting the key may not read without its ID, on a move and a delete", async () => {
    const { deal, contract } = await pair("unread");
    await item(deal, { name: "stays" });
    const folderId = await folder({ query: { types: [deal] } });
    const viewId = await view({ types: [deal] });
    const hook = await webhook(deal);
    const minted = await client.createKey({
      label: "type-move-unread",
      source: `${ctx.source}-unread`,
      permissions: ["schema.write"],
      type_permissions: { [deal]: "write", [contract]: "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const settingsOf = (error: unknown) =>
      (error as { error: { details: { settings: Record<string, unknown>[] } } })
        .error.details.settings;

    // The witness: a key that reads them is told their IDs.
    const told = await client.deleteType(deal);
    expect(told.status).toBe(409);
    expect(settingsOf(told.error).map((setting) => setting.id)).toEqual([
      folderId,
      viewId,
      hook,
    ]);

    const dry = await narrow.moveType(deal, { to: contract, dry_run: true });
    expect(dry.status).toBe(409);
    expect(dry.error?.error.code).toBe("type_move_blocked");
    expect(
      settingsOf(dry.error).map(({ kind, field, reason }) => ({
        kind,
        field,
        reason,
      })),
    ).toEqual([
      { kind: "folder", field: "query.types", reason: "not_permitted" },
      { kind: "view", field: "query.types", reason: "not_permitted" },
      { kind: "webhook", field: "type_filter", reason: "not_permitted" },
    ]);
    const deleted = await narrow.deleteType(deal);
    expect(deleted.status).toBe(409);
    expect(deleted.error?.error.code).toBe("type_in_use");
    for (const settings of [settingsOf(dry.error), settingsOf(deleted.error)]) {
      expect(settings).toHaveLength(3);
      for (const setting of settings) expect(setting).not.toHaveProperty("id");
    }
    expect(JSON.stringify([dry.error, deleted.error])).not.toMatch(
      new RegExp(`${folderId}|${viewId}|${hook}`),
    );
  });

  it("names the new type for the rows a moved root took into the bin", async () => {
    const { deal, contract } = await pair("cascade");
    const root = await item(deal, { name: "root" });
    const child = await client.createItem({
      type: "core.note",
      properties: { body: "child" },
      source: ctx.source,
    });
    expect(child.ok, JSON.stringify(child.error)).toBe(true);
    trackItem(ctx, child.data.item.id);
    const edge = await client.createEdge({
      source_id: root,
      target_id: child.data.item.id,
      edge_type: "parent-of",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    expect((await client.deleteItem(root)).ok).toBe(true);
    const minted = await client.createKey({
      label: "type-move-cascade",
      source: `${ctx.source}-cascade`,
      type_permissions: { [contract]: "read", "core.note": "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const reader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const markOf = async (by: MarfaClient) => {
      const r = await by.rawRequest<{ data: Record<string, unknown>[] }>(
        `/items?type=core.note&state=trashed&source=${encodeURIComponent(ctx.source)}&limit=100`,
      );
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      return r.data.data.find((row) => row.id === child.data.item.id);
    };
    expect(await markOf(client)).toMatchObject({ trashed_with: root });
    expect(await markOf(reader)).not.toHaveProperty("trashed_with");

    expect((await move(deal, { to: contract })).succeeded).toBe(1);
    expect(await markOf(reader)).toMatchObject({
      trashed_by_cascade: true,
      trashed_with: root,
    });
  });

  it("lists the keys whose type map names the type, leaves them as they are, and a delete goes past them", async () => {
    const { deal, contract } = await pair("grants");
    await item(deal, { name: "moved" });
    const granted = await client.createKey({
      label: "type-move-granted",
      source: `${ctx.source}-granted`,
      type_permissions: { [deal]: "read" },
    });
    expect(granted.ok, JSON.stringify(granted.error)).toBe(true);
    trackKey(ctx, granted.data.id);
    const managing = await getOwnerClient().createKey({
      label: "type-move-manager",
      source: `${ctx.source}-manager`,
      permissions: ["keys.manage", "schema.write"],
      type_permissions: { "*": "write" },
    });
    expect(managing.ok, JSON.stringify(managing.error)).toBe(true);
    trackKey(ctx, managing.data.id);
    const manager = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: managing.data.key,
    });

    const dry = await manager.moveType(deal, { to: contract, dry_run: true });
    expect(dry.status, JSON.stringify(dry.error)).toBe(200);
    expect((dry.data as TypeMoveDryRun).grants).toEqual([
      { kind: "key", id: granted.data.id, label: "type-move-granted" },
    ]);

    await move(deal, { to: contract }, manager);
    const deleted = await manager.deleteType(deal);
    expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
    const kept = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: granted.data.key,
    }).rawRequest<{ type_permissions: Record<string, string> }>(
      "/keys/current",
    );
    expect(kept.data.type_permissions).toEqual({ [deal]: "read" });
  });
});

describe("deleting a type a setting names", () => {
  it("refuses a delete while a folder, view or webhook names the type, and deletes it once none does", async () => {
    const { deal } = await pair("delete");
    const folderId = await folder({ query: { types: [deal] } });
    const viewId = await view({ types: [deal] });
    const hook = await webhook(deal);

    const refused = await client.deleteType(deal);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("type_in_use");
    expect(refused.error?.error.details).toMatchObject({
      item_count: 0,
      settings: [
        { kind: "folder", id: folderId, field: "query.types" },
        { kind: "view", id: viewId, field: "query.types" },
        { kind: "webhook", id: hook, field: "type_filter" },
      ],
    });

    const folderRow = await client.getItem(folderId);
    expect(
      (
        await client.updateFolder(folderId, {
          query: { types: ["core.note"] },
          version: folderRow.data.item.version,
        })
      ).ok,
    ).toBe(true);
    expect((await client.deleteView(viewId)).ok).toBe(true);
    expect((await client.updateWebhook(hook, { type_filter: null })).ok).toBe(
      true,
    );

    const deleted = await client.deleteType(deal);
    expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
  });

  it("force-deletes a type a folder names, and leaves the folder as it is", async () => {
    const { deal } = await pair("force");
    const folderId = await folder({ query: { types: [deal] } });

    const deleted = await client.deleteType(deal, true);
    expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
    expect((await properties(folderId)).query).toEqual({ types: [deal] });
  });
});
