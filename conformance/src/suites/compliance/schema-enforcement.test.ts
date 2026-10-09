import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  ApiKeyRequest,
  BulkActionInput,
  BulkActionJob,
  BulkActionResponse,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  getManagementClient,
  getOwnerClient,
  trackKey,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { itemsArchive } from "../../utils/archive.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let originalConfig: Record<string, unknown> = {};

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "schema-enforcement",
  ));

  const current = await client.getConfig();
  expect(current.ok).toBe(true);
  await expectMatchesSchema("GET", "/config", 200, current.data);
  originalConfig = current.data as Record<string, unknown>;
});

/** Replace the configuration and require the door to have accepted it. */
async function setConfig(
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await client.updateConfig(config);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return r.data as Record<string, unknown>;
}

afterAll(async () => {
  // Put back whatever the configuration held before this file ran. The levers
  // are instance-wide, so leaving one on would change how every other file's
  // writes validate — and `PUT` replaces the configuration wholesale, so
  // clearing it instead of restoring it would discard settings this file never
  // set.
  await setConfig(originalConfig);
  await cleanup(ctx);
});

/**
 * A writer identified by a specific `source`: a write naming none is stamped
 * with its credential's own, so a distinct source is a distinct credential.
 */
async function clientWithSource(
  label: string,
  source: string,
): Promise<MarfaClient> {
  const keyResp = await client.createKey({
    label,
    source,
    permissions: [],
    type_permissions: { "*": "write" },
  });
  expect(keyResp.ok).toBe(true);
  trackKey(ctx, keyResp.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: keyResp.data.key });
}

/** Queue a bulk action, poll its job until terminal, and return the result. */
async function runBulkAction(
  input: BulkActionInput,
): Promise<BulkActionResponse> {
  const res = await client.bulkAction(input);
  expect(res.status, JSON.stringify(res.error)).toBe(202);
  const final = await client.pollBulkActionToTerminal(
    (res.data as BulkActionJob).id,
  );
  expect(final.status).toBe("completed");
  expect(final.result).toBeDefined();
  return final.result!;
}

describe("the configuration door", () => {
  it("PUT replaces the configuration wholesale and GET reads it back", async () => {
    // The identity rides on both doors and is not configuration: a `PUT`
    // that omits it still gets it back, and the clear below does not remove
    // it. Everything else the body carries is replaced outright.
    const instanceId = (originalConfig as { instance_id: string }).instance_id;
    const lever = {
      enforcement: { strict_mode: { types: ["core.bookmark"] } },
    };
    const written = await setConfig(lever);
    await expectMatchesSchema("PUT", "/config", 200, written);
    expect(written).toEqual({ instance_id: instanceId, ...lever });
    const read = await client.getConfig();
    expect(read.ok).toBe(true);
    expect(read.data).toEqual({ instance_id: instanceId, ...lever });

    const cleared = await setConfig({});
    expect(cleared).toEqual({ instance_id: instanceId });
    const readAgain = await client.getConfig();
    expect(readAgain.data).toEqual({ instance_id: instanceId });
  });

  it("takes a body back as read, and refuses one addressed elsewhere", async () => {
    // What a full-replacement door is actually used for: read it, change one
    // lever, send it back. The identity is in every read, so a write that
    // carried it would be refused by the strict shape if the field were
    // merely unknown — and the refusal would read as a typo.
    //
    // Both halves, because either alone leaves the door wrong. Accepting any
    // identity means a backup script pointed at the wrong host answers 200.
    //
    // The precondition is set here rather than inherited from the test
    // above: the "changed nothing" check at the end only witnesses anything
    // while the refused body would have changed something, and a refusal
    // against a configuration that already matched it proves nothing.
    await setConfig({});
    const read = await client.getConfig();
    expect(read.ok).toBe(true);
    const body = read.data as Record<string, unknown>;
    expect(typeof body.instance_id).toBe("string");

    const echoed = await setConfig({ ...body, audit_retention_days: 31 });
    expect(echoed.instance_id).toBe(body.instance_id);
    expect(echoed.audit_retention_days).toBe(31);

    const elsewhere = await client.updateConfig({
      ...body,
      instance_id: "019537a0-7b80-7000-8000-000000000000",
    });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.error?.error.code).toBe("validation_error");
    // The field named, not just the code: a caller sending a whole
    // configuration object needs to be told which of its keys was the
    // problem, and every other refusal on this door says so too.
    const errors = elsewhere.error?.error.details?.errors as
      { path: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("instance_id");

    // And it changed nothing, which the status code cannot state.
    const after = await client.getConfig();
    expect(after.data).toEqual(echoed);
  });

  it("refuses a lever of the wrong shape", async () => {
    const r = await client.updateConfig({
      enforcement: { strict_mode: "yes" },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("refuses a configuration key it does not know, and keeps the configuration", async () => {
    const lever = {
      enforcement: { strict_mode: { types: ["core.bookmark"] } },
    };
    const held = await setConfig(lever);
    const before = await client.getConfig();
    expect(before.data).toEqual(held);

    const bodies: Record<string, unknown>[] = [
      { not_a_setting: 1 },
      { ...lever, not_a_setting: 1 },
      { enforcement: { ...lever.enforcement, not_a_lever: true } },
    ];
    for (const body of bodies) {
      const r = await client.updateConfig(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.error.code, JSON.stringify(body)).toBe(
        "validation_error",
      );
      const after = await client.getConfig();
      expect(after.data, JSON.stringify(body)).toEqual(held);
    }

    // The witness: the same body without the unknown key replaces the
    // configuration, so what was refused is the key.
    const accepted = await client.updateConfig({
      ...lever,
      audit_retention_days: 31,
    });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
  });

  it("refuses both doors to a key without config.manage", async () => {
    const narrowed = await clientWithSource(
      "config-no-settings",
      `${ctx.source}-config-no-settings`,
    );
    const read = await narrowed.getConfig();
    expect(read.status).toBe(403);
    expect(read.error?.error.code).toBe("forbidden");
    expect(read.error?.error.details?.required_scope).toBe("config.manage");
    const write = await narrowed.updateConfig({});
    expect(write.status).toBe(403);
    expect(write.error?.error.code).toBe("forbidden");
    expect(write.error?.error.details?.required_scope).toBe("config.manage");
  });
});

describe("strict_mode lever", () => {
  it("default-off accepts unknown property on core.note write", async () => {
    await setConfig({});
    const r = await client.createItem({
      type: "core.note",
      properties: { body: "with extras", not_a_real_field: "x" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });

  it("strict-on rejects unknown property with invalid_properties", async () => {
    await setConfig({
      enforcement: {
        strict_mode: { types: ["core.note"] },
      },
    });
    const r = await client.createItem({
      type: "core.note",
      properties: { body: "with extras", not_a_real_field: "x" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
  });

  it("strict-on rejects the same unknown property arriving through the restore door", async () => {
    // The lever is a property of the type, not of the door. The restore
    // writes through the store directly, where validation runs loose, so
    // an archive was the way around a lever the create door enforces —
    // and a read afterwards serves the property back, undeclared and
    // unmarked, under the type's current version.
    await setConfig({
      enforcement: {
        strict_mode: { types: ["core.note"] },
      },
    });
    const planted = uuidv7();
    const owner = getOwnerClient();
    const refused = await owner.restoreArchive(
      itemsArchive([
        {
          id: planted,
          type: "core.note",
          source: ctx.source,
          properties: { body: "with extras", not_a_real_field: "x" },
        },
      ]),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(
      refused.error?.error.details?.code,
      "the restore refused for some reason of its own rather than the one the create door gives",
    ).toBe("unknown_property");
    expect(
      (await client.getItem(planted)).status,
      "the refused archive wrote its row anyway",
    ).toBe(404);

    // The witness. The same archive without the property restores, so what
    // was refused is the property and not the archive, the type or the door.
    const fine = uuidv7();
    const restored = await owner.restoreArchive(
      itemsArchive([
        {
          id: fine,
          type: "core.note",
          source: ctx.source,
          properties: { body: "with extras" },
        },
      ]),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, fine);
    expect((await client.getItem(fine)).status).toBe(200);
  });

  it("strict-on rejects the same unknown property through the bulk door, on both halves of an upsert", async () => {
    // The door built for volume, reachable by any working key, writes
    // through a store whose validation runs loose whatever the lever says,
    // so the control `POST /items` enforces is one this door has to ask
    // for itself, on both the rows a page creates and the rows it updates.
    await setConfig({
      enforcement: { strict_mode: { types: ["core.note"] } },
    });

    const created = uuidv7();
    const refusedCreate = await client.bulkItems({
      items: [
        {
          id: created,
          type: "core.note",
          properties: { body: "bulk create", not_a_real_field: "x" },
        },
      ],
      atomic: false,
    });
    expect(refusedCreate.ok, JSON.stringify(refusedCreate.error)).toBe(true);
    expect(refusedCreate.data.counts.errored).toBe(1);
    expect(refusedCreate.data.results[0]?.error?.code).toBe(
      "invalid_properties",
    );
    expect(
      (await client.getItem(created)).status,
      "the refused entry wrote its row anyway",
    ).toBe(404);

    // The witness for the create half: the same body without the
    // property lands, so what was refused is the property and not the
    // door, the type or the id.
    const acceptedCreate = await client.bulkItems({
      items: [
        { id: created, type: "core.note", properties: { body: "bulk create" } },
      ],
      atomic: false,
    });
    expect(acceptedCreate.ok, JSON.stringify(acceptedCreate.error)).toBe(true);
    expect(acceptedCreate.data.counts.created).toBe(1);
    trackItem(ctx, created);

    // And the update half of the same door, against the row just
    // written. A door that refused an undeclared property on the rows it
    // creates and took it on the rows it updates would be the defect
    // restated rather than closed.
    const refusedUpdate = await client.bulkItems({
      items: [
        {
          id: created,
          type: "core.note",
          properties: { body: "bulk update", not_a_real_field: "x" },
        },
      ],
      atomic: false,
    });
    expect(refusedUpdate.ok, JSON.stringify(refusedUpdate.error)).toBe(true);
    expect(refusedUpdate.data.counts.errored).toBe(1);
    expect(refusedUpdate.data.results[0]?.error?.code).toBe(
      "invalid_properties",
    );
    expect(
      (await client.getItem(created)).data.item.properties.body,
      "the refused entry wrote its properties anyway",
    ).toBe("bulk create");

    const acceptedUpdate = await client.bulkItems({
      items: [
        { id: created, type: "core.note", properties: { body: "bulk update" } },
      ],
      atomic: false,
    });
    expect(acceptedUpdate.ok, JSON.stringify(acceptedUpdate.error)).toBe(true);
    expect(acceptedUpdate.data.counts.updated).toBe(1);
    expect((await client.getItem(created)).data.item.properties.body).toBe(
      "bulk update",
    );
  });

  it("strict-on rejects the same unknown property through the update door", async () => {
    // An update door that validated loosely would let a row created under
    // the lever be given the property it was refused at creation, one
    // request later.
    await setConfig({
      enforcement: { strict_mode: { types: ["core.note"] } },
    });
    const made = await client.createItem({
      type: "core.note",
      properties: { body: "patch base" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);

    const refused = await client.updateItem(made.data.item.id, {
      version: made.data.item.version,
      properties: { body: "patched", not_a_real_field: "x" },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(refused.error?.error.details?.code).toBe("unknown_property");
    const afterRefusal = await client.getItem(made.data.item.id);
    expect(
      afterRefusal.data.item.properties.body,
      "the refused update wrote its properties anyway",
    ).toBe("patch base");

    // The witness: the same body minus the property is taken.
    const accepted = await client.updateItem(made.data.item.id, {
      version: made.data.item.version,
      properties: { body: "patched" },
    });
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
    expect(
      (await client.getItem(made.data.item.id)).data.item.properties.body,
    ).toBe("patched");
  });

  it("takes a patch naming only declared properties, whatever else the type requires", async () => {
    // The lever refuses an undeclared key and nothing else. A strict
    // parse answers two questions at once — it also refuses a property
    // set missing a field the type requires — and the doors that hand it
    // a complete set never meet the second. A patch is not a complete
    // set: `core.note` requires `body`, so a patch setting only `title`
    // reads as a missing required field to a strict parse, and the update
    // doors would refuse an ordinary request under a message naming a
    // cause that is not the cause. The store still asks for the required
    // fields, against the merged row, and answers in its own words.
    await setConfig({
      enforcement: { strict_mode: { types: ["core.note"] } },
    });
    const made = await client.createItem({
      type: "core.note",
      properties: { body: "the body the type requires", title: "first" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);

    const patched = await client.updateItem(made.data.item.id, {
      version: made.data.item.version,
      properties: { title: "second" },
    });
    expect(
      patched.ok,
      `a patch naming only declared properties was refused: ${JSON.stringify(patched.error)}`,
    ).toBe(true);
    const read = await client.getItem(made.data.item.id);
    expect(read.data.item.properties.title).toBe("second");
    expect(
      read.data.item.properties.body,
      "the patch was taken but the store did not keep the property it did not name",
    ).toBe("the body the type requires");

    // The same shape through the bulk door, which reaches this branch by
    // resolving a row rather than by naming one.
    const viaBulk = await client.bulkItems({
      items: [
        {
          id: made.data.item.id,
          type: "core.note",
          properties: { title: "third" },
        },
      ],
      atomic: false,
    });
    expect(viaBulk.ok, JSON.stringify(viaBulk.error)).toBe(true);
    expect(
      viaBulk.data.counts.updated,
      `a bulk patch naming only declared properties was refused: ${JSON.stringify(viaBulk.data.results[0]?.error)}`,
    ).toBe(1);

    // The control: the same doors still refuse an undeclared key, so
    // this case is not passing because the lever came off.
    const stillRefused = await client.updateItem(made.data.item.id, {
      version: (await client.getItem(made.data.item.id)).data.item.version,
      properties: { not_a_real_field: "x" },
    });
    expect(stillRefused.status).toBe(400);
    expect(stillRefused.error?.error.details?.code).toBe("unknown_property");
  });

  it("strict-on refuses the same unknown property per row of a bulk update_properties job", async () => {
    // The filter-in door reaches every row a filter matches with one patch,
    // so it asks the lever per row, of the patch rather than of the merge,
    // and refuses only the rows of a type the lever names.
    await setConfig({
      enforcement: { strict_mode: { types: ["core.note"] } },
    });
    const tag = `strict-bulk-action-${ctx.runId}`;
    const note = await client.createItem({
      type: "core.note",
      properties: { body: "before" },
      tags: [tag],
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);
    // The witness: a row of a type the lever does not name, matched by the
    // same filter, takes the same patch, so what refuses the note is the
    // lever and not the job, the filter or the patch.
    const bookmark = await client.createItem({
      type: "core.bookmark",
      properties: { url: "https://example.com/strict-bulk-action" },
      tags: [tag],
    });
    expect(bookmark.ok, JSON.stringify(bookmark.error)).toBe(true);
    trackItem(ctx, bookmark.data.item.id);

    const refused = await runBulkAction({
      action: "update_properties",
      patch: { not_a_real_field: "x" },
      filter: { tags: [tag] },
    });
    expect(refused.succeeded).toBe(1);
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors?.[0]?.id).toBe(note.data.item.id);
    expect(refused.errors?.[0]?.code).toBe("invalid_properties");
    expect(
      refused.errors?.[0]?.details?.code,
      "the job refused the row for some reason of its own rather than the one the create door gives",
    ).toBe("unknown_property");
    expect(
      (await client.getItem(note.data.item.id)).data.item.properties,
      "the refused row was written anyway",
    ).toEqual({ body: "before" });
    expect(
      (await client.getItem(bookmark.data.item.id)).data.item.properties
        .not_a_real_field,
    ).toBe("x");

    // A patch naming only declared properties applies to every row.
    const accepted = await runBulkAction({
      action: "update_properties",
      patch: { title: "declared" },
      filter: { tags: [tag], type: "core.note" },
    });
    expect(accepted.errors ?? []).toEqual([]);
    expect(accepted.succeeded).toBe(1);
    expect(
      (await client.getItem(note.data.item.id)).data.item.properties.title,
    ).toBe("declared");
  });

  it("default-off accepts through the bulk and update doors as it does through the create door", async () => {
    // The other half of the lever, and the reason the two cases above are
    // about the lever rather than about those doors: with nothing
    // configured, both take the property and serve it back. A door that
    // refused it regardless would be a second rule wearing the first
    // one's name.
    await setConfig({});
    const id = uuidv7();
    const bulk = await client.bulkItems({
      items: [
        {
          id,
          type: "core.note",
          properties: { body: "off", not_a_real_field: "x" },
        },
      ],
      atomic: false,
    });
    expect(bulk.ok, JSON.stringify(bulk.error)).toBe(true);
    expect(bulk.data.counts.created).toBe(1);
    trackItem(ctx, id);
    expect(
      (await client.getItem(id)).data.item.properties.not_a_real_field,
      "the bulk door took the row and dropped the property, so the case above refuses something it never writes",
    ).toBe("x");

    const written = await client.getItem(id);
    const patched = await client.updateItem(id, {
      version: written.data.item.version,
      properties: { another_unreal_field: "y" },
    });
    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    expect(
      (await client.getItem(id)).data.item.properties.another_unreal_field,
      "the update door took the row and dropped the property",
    ).toBe("y");
  });

  it("default-off accepts through the restore door as it does through the create door", async () => {
    // The other half of the lever, and the reason the case above is about
    // the lever rather than about archives: with nothing configured, both
    // doors take the property. A restore that refused it regardless would
    // be a second rule wearing the first one's name.
    await setConfig({});
    const id = uuidv7();
    const restored = await getOwnerClient().restoreArchive(
      itemsArchive([
        {
          id,
          type: "core.note",
          source: ctx.source,
          properties: { body: "with extras", not_a_real_field: "x" },
        },
      ]),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    const read = await client.getItem(id);
    expect(read.status).toBe(200);
    expect(
      read.data.item.properties.not_a_real_field,
      "the restore took the row and dropped the property, so the case above refuses something this door never writes",
    ).toBe("x");
  });
});

describe("the levers that name a type", () => {
  it("holds strict mode and the source allow-list to the type named, not its subtypes", async () => {
    const parentId = `user.lever-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;
    expect(
      (
        await client.registerType({
          id: parentId,
          fields: { name: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await client.registerType({
          id: childId,
          parent: parentId,
          fields: { extra: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const undeclared = { name: "kept", not_a_real_field: "x" };

    try {
      await setConfig({
        enforcement: { strict_mode: { types: [parentId] } },
      });
      // The witness: the lever bites on the type it names.
      const named = await client.createItem({
        type: parentId,
        properties: undeclared,
      });
      expect(named.status).toBe(400);
      expect(named.error?.error.code).toBe("invalid_properties");
      const sub = await client.createItem({
        type: childId,
        properties: undeclared,
      });
      expect(sub.status, JSON.stringify(sub.error)).toBe(201);
      trackItem(ctx, sub.data.item.id);
      expect(sub.data.item.properties.not_a_real_field).toBe("x");

      const allowed = `${ctx.source}-lever-allowed`;
      await setConfig({
        enforcement: {
          source_allowlist: { types: [parentId], sources: [allowed] },
        },
      });
      const outsider = await client.createItem({
        type: parentId,
        properties: { name: "kept" },
      });
      expect(outsider.status).toBe(403);
      expect(outsider.error?.error.code).toBe("forbidden");
      const insider = await (
        await clientWithSource("lever-allowed", allowed)
      ).createItem({ type: parentId, properties: { name: "kept" } });
      expect(insider.status, JSON.stringify(insider.error)).toBe(201);
      trackItem(ctx, insider.data.item.id);
      const subOutsider = await client.createItem({
        type: childId,
        properties: { name: "kept" },
      });
      expect(subOutsider.status, JSON.stringify(subOutsider.error)).toBe(201);
      trackItem(ctx, subOutsider.data.item.id);
    } finally {
      await setConfig(originalConfig);
    }
  });
});

describe("source_allowlist lever", () => {
  it("rejects writes from non-listed source", async () => {
    await setConfig({
      enforcement: {
        source_allowlist: {
          types: ["core.note"],
          sources: [`${ctx.source}-allowed`],
        },
      },
    });

    const blocked = await clientWithSource(
      "allowlist-blocked",
      `${ctx.source}-blocked`,
    );
    const r = await blocked.createItem({
      type: "core.note",
      properties: { body: "should reject" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
    expect(r.error?.error.details?.type).toBe("core.note");
    expect(r.error?.error.details?.source).toBe(`${ctx.source}-blocked`);
    expect(r.error?.error.details?.allowed).toEqual([`${ctx.source}-allowed`]);
  });

  it("accepts writes from listed source", async () => {
    await setConfig({
      enforcement: {
        source_allowlist: {
          types: ["core.note"],
          sources: [`${ctx.source}-allowed`],
        },
      },
    });

    const allowed = await clientWithSource(
      "allowlist-allowed",
      `${ctx.source}-allowed`,
    );
    const r = await allowed.createItem({
      type: "core.note",
      properties: { body: "should accept" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });

  it("asks it of every bulk entry, under the source the entry resolves to", async () => {
    // A key whose own source is listed and which claims one that is not.
    // The lever reads the source a write resolves to, so a claim is no way
    // past it on either create door.
    const own = `${ctx.source}-bulk-own`;
    const claimed = `${ctx.source}-bulk-claimed`;
    await setConfig({
      enforcement: {
        source_allowlist: { types: ["core.note"], sources: [own] },
      },
    });
    const minted = await getOwnerClient().createKey({
      label: "allowlist-bulk",
      source: own,
      sources: [claimed],
      permissions: [],
      type_permissions: { "*": "write" },
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    trackKey(ctx, minted.data.id);
    const writer = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const entry = (source: string, sourceId: string) => ({
      type: "core.note",
      properties: { body: `under ${source}` },
      source,
      source_id: sourceId,
    });

    // The single create refuses the claimed source the list does not name.
    const single = await writer.createItem(entry(claimed, `${claimed}-single`));
    expect(single.status).toBe(403);
    expect(single.error?.error.details).toMatchObject({
      type: "core.note",
      source: claimed,
      allowed: [own],
    });

    const refused = await writer.bulkItems({
      items: [entry(claimed, `${claimed}-bulk`)],
      atomic: false,
    });
    expect(refused.ok, JSON.stringify(refused.error)).toBe(true);
    expect(
      refused.data.results[0]?.outcome,
      "a bulk entry wrote under a source the allow-list excludes, which the single create beside it refuses",
    ).toBe("errored");
    expect(refused.data.results[0]?.error?.code).toBe("forbidden");
    expect(refused.data.results[0]?.error?.details).toMatchObject({
      type: "core.note",
      source: claimed,
      allowed: [own],
    });
    for (const result of refused.data.results) {
      if (result.id !== undefined) trackItem(ctx, result.id);
    }

    // Atomic, the page rolls back with the permission's status, and the
    // entry before the refused one is gone with it.
    const rolled = await writer.bulkItems({
      items: [entry(own, `${own}-atomic`), entry(claimed, `${claimed}-atomic`)],
    });
    expect(rolled.status).toBe(403);
    expect(rolled.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rolled.error?.error.details?.code).toBe("forbidden");
    const ownRows = async () => {
      const listed = await writer.listItems({ source: own, limit: 100 });
      expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
      return listed.data.data.map((item) => item.source_id);
    };
    expect(
      await ownRows(),
      "the rolled-back page left a row behind",
    ).not.toContain(`${own}-atomic`);

    // The witness: the same entry under the key's own source, which the
    // list names, lands, and the listing that found no rolled-back row
    // finds it.
    const landed = await writer.bulkItems({
      items: [entry(own, `${own}-bulk`)],
      atomic: false,
    });
    expect(landed.ok, JSON.stringify(landed.error)).toBe(true);
    expect(landed.data.results[0]?.outcome).toBe("created");
    trackItem(ctx, landed.data.results[0]!.id!);
    const relisted = await ownRows();
    expect(
      relisted,
      "the listing does not surface a row the key wrote under its own source, so the absence above proves nothing",
    ).toContain(`${own}-bulk`);
    expect(relisted).not.toContain(`${own}-atomic`);
  });
});

describe("source_filter lever", () => {
  it("narrows reads to listed sources", async () => {
    await setConfig({});
    const a = await clientWithSource(
      "filter-source-a",
      `${ctx.source}-source-a`,
    );
    const b = await clientWithSource(
      "filter-source-b",
      `${ctx.source}-source-b`,
    );

    const ra = await a.createItem({
      type: "core.note",
      properties: { body: "from-a" },
      tags: [`filter-${ctx.runId}`],
    });
    expect(ra.ok).toBe(true);
    trackItem(ctx, ra.data.item.id);
    const rb = await b.createItem({
      type: "core.note",
      properties: { body: "from-b" },
      tags: [`filter-${ctx.runId}`],
    });
    expect(rb.ok).toBe(true);
    trackItem(ctx, rb.data.item.id);

    await setConfig({
      enforcement: {
        source_filter: {
          types: ["core.note"],
          sources: [`${ctx.source}-source-a`],
        },
      },
    });

    const list = await client.listItems({
      type: "core.note",
      tags: [`filter-${ctx.runId}`],
    });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(ra.data.item.id);
    expect(ids).not.toContain(rb.data.item.id);
  });

  /**
   * The lever applies per row, on every read that returns a set, so covering
   * `/items` alone proves nothing. Each surface below reaches rows by a
   * different path: a different index, a stream, an aggregate. A filter
   * applied in the list handler rather than in the query layer passes
   * `/items` and fails these.
   */
  it("narrows every read that returns a set, not just the list route", async () => {
    await setConfig({});

    const marker = `surfaces-${ctx.runId}`;
    const visible = await clientWithSource(
      "surfaces-visible",
      `${ctx.source}-surfaces-visible`,
    );
    const hidden = await clientWithSource(
      "surfaces-hidden",
      `${ctx.source}-surfaces-hidden`,
    );

    const shown = await visible.createItem({
      type: "core.note",
      properties: { body: `visible ${marker}` },
      tags: [marker],
    });
    expect(shown.ok).toBe(true);
    trackItem(ctx, shown.data.item.id);

    const concealed = await hidden.createItem({
      type: "core.note",
      properties: { body: `concealed ${marker}` },
      tags: [marker, `${marker}-hidden-only`],
    });
    expect(concealed.ok).toBe(true);
    trackItem(ctx, concealed.data.item.id);

    // The tag listing, a facet of the listing: before the lever it counts both
    // notes and names the tag only the concealed one carries.
    const tagCounts = async (): Promise<Record<string, number>> => {
      const tags = await client.listTags();
      expect(tags.ok).toBe(true);
      return Object.fromEntries(tags.data.data.map((t) => [t.tag, t.count]));
    };
    const tagsBefore = await tagCounts();
    expect(tagsBefore[marker]).toBe(2);
    expect(tagsBefore[`${marker}-hidden-only`]).toBe(1);

    const statsBefore = await client.itemStats();
    expect(statsBefore.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/stats", 200, statsBefore.data);
    const activeBefore = statsBefore.data["active"] ?? 0;

    await setConfig({
      enforcement: {
        source_filter: {
          types: ["core.note"],
          sources: [`${ctx.source}-surfaces-visible`],
        },
      },
    });

    // Full-text search: a separate index from the list query.
    const found = await client.search(marker, { limit: 50 });
    expect(found.ok).toBe(true);
    const searchIds = found.data.data.map((r) => r.item.id);
    // Both directions. Asserting only the absence passes vacuously against a
    // search that returned nothing at all, which is a plausible outcome — the
    // write happened milliseconds earlier and indexing need not be synchronous
    // — and would report the filter working when the index is simply empty.
    expect(searchIds).toContain(shown.data.item.id);
    expect(searchIds).not.toContain(concealed.data.item.id);

    // Export: a stream, built by a different reader from the paged list.
    const exported = await client.exportItems({ type: "core.note" });
    expect(exported.ok).toBe(true);
    expect(exported.data).not.toContain(concealed.data.item.id);
    expect(exported.data).toContain(shown.data.item.id);

    // Stats: an aggregate, keyed by lifecycle state. It returns counts
    // rather than rows, so a filter applied while shaping a response instead
    // of inside the query leaves this number unchanged while every other read
    // narrows. The filter admits one source, so at minimum the note written
    // by the other one stops counting.
    const statsAfter = await client.itemStats();
    expect(statsAfter.ok).toBe(true);
    expect(statsAfter.data["active"] ?? 0).toBeLessThan(activeBefore);

    // Tags: a tag counted over hidden rows would open to an empty listing, so
    // the shared tag counts the one visible row and the other is not named.
    const tagsAfter = await tagCounts();
    expect(tagsAfter[marker]).toBe(1);
    expect(tagsAfter[`${marker}-hidden-only`]).toBeUndefined();
  });

  it("narrows only the types the source filter names, and their subtypes", async () => {
    const parentId = `user.filter-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;
    expect(
      (
        await client.registerType({
          id: parentId,
          fields: { name: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await client.registerType({
          id: childId,
          parent: parentId,
          fields: { extra: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const shown = await clientWithSource(
      "filter-types-shown",
      `${ctx.source}-types-shown`,
    );
    const other = await clientWithSource(
      "filter-types-other",
      `${ctx.source}-types-other`,
    );
    const tag = `filter-types-${ctx.runId}`;
    const write = async (
      writer: MarfaClient,
      type: string,
      properties: Record<string, unknown>,
    ): Promise<string> => {
      const r = await writer.createItem({ type, properties, tags: [tag] });
      expect(r.status, JSON.stringify(r.error)).toBe(201);
      trackItem(ctx, r.data.item.id);
      return r.data.item.id;
    };

    try {
      await setConfig({});
      const named = await write(shown, parentId, { name: "named, shown" });
      const sub = await write(shown, childId, { name: "subtype, shown" });
      const namedHidden = await write(other, parentId, {
        name: "named, other",
      });
      const subHidden = await write(other, childId, { name: "subtype, other" });
      const unnamed = await write(other, "core.note", { body: "unnamed" });
      const listed = async (): Promise<string[]> => {
        const r = await client.listItems({ tags: [tag], limit: 100 });
        expect(r.status, JSON.stringify(r.error)).toBe(200);
        return r.data.data.map((i) => i.id).sort();
      };
      // The witness: nothing narrows until the lever is set.
      expect(await listed()).toEqual(
        [named, sub, namedHidden, subHidden, unnamed].sort(),
      );

      await setConfig({
        enforcement: {
          source_filter: {
            types: [parentId],
            sources: [`${ctx.source}-types-shown`],
          },
        },
      });
      expect(await listed()).toEqual([named, sub, unnamed].sort());
    } finally {
      await setConfig(originalConfig);
    }
  });

  /**
   * `GET /items/{id}` is deliberately exempt, and that is worth pinning.
   *
   * The lever narrows a result set; it is not an access-control gate, and the
   * id read is already fenced by the caller's type permissions. Quietly adding it
   * here would turn a filtered-out row into a 404 for a caller holding its id,
   * which reads as data loss rather than as a filter. Without a test the
   * exemption looks like an oversight and gets "fixed".
   */
  it("does not narrow a read by id", async () => {
    await setConfig({});

    const hidden = await clientWithSource(
      "byid-hidden",
      `${ctx.source}-byid-hidden`,
    );
    const created = await hidden.createItem({
      type: "core.note",
      properties: { body: `by-id ${ctx.runId}` },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);

    await setConfig({
      enforcement: {
        source_filter: {
          types: ["core.note"],
          sources: [`${ctx.source}-nothing-matches-this`],
        },
      },
    });

    const byId = await client.getItem(created.data.item.id);
    expect(byId.ok).toBe(true);
    expect(byId.data.item.id).toBe(created.data.item.id);
  });

  it("leaves out of a window the events the instance's source filter does not admit", async () => {
    const listed = `${ctx.source}-occ-listed`;
    const unlisted = `${ctx.source}-occ-unlisted`;
    const inFilter = await clientWithSource("occ-listed", listed);
    const outOfFilter = await clientWithSource("occ-unlisted", unlisted);
    const write = async (
      writer: MarfaClient,
      title: string,
      properties: Record<string, unknown>,
    ): Promise<string> => {
      const r = await writer.createItem({
        type: "core.event",
        properties: { title: `${title} ${ctx.runId}`, ...properties },
      });
      expect(r.status, JSON.stringify(r.error)).toBe(201);
      trackItem(ctx, r.data.item.id);
      return r.data.item.id;
    };
    const window = {
      from: "2057-05-10T00:00:00.000Z",
      to: "2057-05-11T00:00:00.000Z",
    };
    const occurring = async (): Promise<string[]> => {
      const r = await client.listOccurrences(window);
      expect(r.status, JSON.stringify(r.error)).toBe(200);
      return [...new Set(r.data.data.map((o) => o.item.id))].sort();
    };

    try {
      await setConfig({});
      const shown = await write(inFilter, "listed", {
        starts_at: "2057-05-10T09:00:00.000Z",
        ends_at: "2057-05-10T10:00:00.000Z",
      });
      const hidden = await write(outOfFilter, "unlisted", {
        starts_at: "2057-05-10T09:00:00.000Z",
        ends_at: "2057-05-10T10:00:00.000Z",
      });
      const shownSeries = await write(inFilter, "listed series", {
        starts_at: "2057-05-09T12:00:00.000Z",
        recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      });
      const hiddenSeries = await write(outOfFilter, "unlisted series", {
        starts_at: "2057-05-09T12:00:00.000Z",
        recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      });

      // The witness: before the filter the window holds both sources'
      // events, standalone and recurring.
      expect(await occurring()).toEqual(
        [shown, hidden, shownSeries, hiddenSeries].sort(),
      );

      await setConfig({
        enforcement: {
          source_filter: { types: ["core.event"], sources: [listed] },
        },
      });
      expect(await occurring()).toEqual([shown, shownSeries].sort());
    } finally {
      await setConfig(originalConfig);
    }
  });

  it("answers a row the instance's source filter leaves out of listings, as a read by key", async () => {
    const hiddenSource = `${ctx.source}-lookup-hidden`;
    const hidden = await clientWithSource("lookup-hidden", hiddenSource);
    const sourceId = `lookup-filtered-${ctx.runId}`;
    const tag = `lookup-filtered-${ctx.runId}`;
    const created = await hidden.createItem({
      type: "core.note",
      source_id: sourceId,
      properties: { body: `by key ${ctx.runId}` },
      tags: [tag],
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    const id = created.data.item.id;
    const found = async (input: Record<string, unknown>): Promise<string[]> => {
      const r = await client.lookupItems({
        type: "core.note",
        ...input,
      });
      expect(r.status, JSON.stringify(r.error)).toBe(200);
      return r.data.data.map((i) => i.id);
    };
    const listed = async (): Promise<string[]> => {
      const r = await client.listItems({ type: "core.note", tags: [tag] });
      expect(r.status, JSON.stringify(r.error)).toBe(200);
      return r.data.data.map((i) => i.id);
    };

    try {
      await setConfig({});
      // The witness: the row is listed before the filter, so its absence
      // from the listing below is the filter's doing.
      expect(await listed()).toEqual([id]);

      await setConfig({
        enforcement: {
          source_filter: {
            types: ["core.note"],
            sources: [`${ctx.source}-nothing-matches-this`],
          },
        },
      });
      expect(await listed()).toEqual([]);
      expect(await found({ ids: [id] })).toEqual([id]);
      expect(
        await found({ source: hiddenSource, source_ids: [sourceId] }),
      ).toEqual([id]);
    } finally {
      await setConfig(originalConfig);
    }
  });
});

describe("a key's own levers", () => {
  /** A note carrying a property `core.note` does not declare. */
  const undeclared = {
    type: "core.note",
    properties: { body: "with extras", not_a_real_field: "x" },
  };

  /** A key the working key mints, writing notes, with the levers named. */
  async function keyWith(
    label: string,
    extra: Partial<ApiKeyRequest> = {},
  ): Promise<{ client: MarfaClient; id: string }> {
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "core.note": "write" },
      ...extra,
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    trackKey(ctx, minted.data.id);
    return {
      client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
      id: minted.data.id,
    };
  }

  async function write(writer: MarfaClient): Promise<number> {
    const r = await writer.createItem(undeclared);
    if (r.ok) trackItem(ctx, r.data.item.id);
    return r.status;
  }

  it("replaces the instance's lever for the key, loosening as well as tightening", async () => {
    await setConfig({ enforcement: { strict_mode: { types: ["core.note"] } } });
    const loose = await keyWith("levers-loose", {
      enforcement_override: { strict_mode: { types: [] } },
    });
    // The witness: the instance's lever refuses a key with none of its own.
    const inheriting = await keyWith("levers-inheriting");
    expect(
      await write(inheriting.client),
      "the instance's strict mode admitted an undeclared property, so the key below loosens nothing",
    ).toBe(400);
    expect(
      await write(loose.client),
      "a key's own strict mode did not loosen the instance's for it",
    ).toBe(201);

    await setConfig({});
    const tight = await keyWith("levers-tight", {
      enforcement_override: { strict_mode: { types: ["core.note"] } },
    });
    expect(
      await write(inheriting.client),
      "with no lever on the instance an undeclared property was refused, so the refusal below may be every write",
    ).toBe(201);
    expect(
      await write(tight.client),
      "a key's own strict mode did not tighten the instance's for it",
    ).toBe(400);
  });

  it("leaves a lever it does not set to the instance", async () => {
    await setConfig({
      enforcement: {
        strict_mode: { types: ["core.note"] },
        source_allowlist: { types: ["core.note"], sources: [ctx.source] },
      },
    });
    const loose = await keyWith("levers-one", {
      enforcement_override: { strict_mode: { types: [] } },
    });
    // The witness: a listed source writes the same note.
    const listed = await client.createItem({
      type: "core.note",
      properties: { body: "listed" },
    });
    expect(listed.status).toBe(201);
    trackItem(ctx, listed.data.item.id);
    const refused = await loose.client.createItem({
      type: "core.note",
      properties: { body: "unlisted" },
    });
    if (refused.ok) trackItem(ctx, refused.data.item.id);
    expect(
      refused.status,
      "a key setting only strict mode escaped the instance's source allowlist too",
    ).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
  });

  it("reads back on the mint, the listing, the key itself and the update, is replaced whole and cleared by null", async () => {
    await setConfig({});
    const first = { strict_mode: { types: ["core.note"] } };
    const second = {
      source_filter: { types: ["core.note"], sources: [ctx.source] },
    };
    const minted = await client.createKey({
      label: "levers-read",
      source: `${ctx.source}-levers-read`,
      type_permissions: { "core.note": "write" },
      enforcement_override: first,
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    trackKey(ctx, minted.data.id);
    await expectMatchesSchema("POST", "/keys", 201, minted.data);
    expect(minted.data.enforcement_override).toEqual(first);
    const own = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });

    const listed = await client.listKeys();
    expect(listed.ok, "the key listing failed").toBe(true);
    expect(
      listed.data.data.find((k) => k.id === minted.data.id)
        ?.enforcement_override,
    ).toEqual(first);
    const current = await own.getCurrentKey();
    expect(current.status).toBe(200);
    await expectMatchesSchema("GET", "/keys/current", 200, current.data);
    expect(
      current.data.enforcement_override,
      "a key reading itself does not see its own levers",
    ).toEqual(first);

    const replaced = await client.updateKey(minted.data.id, {
      enforcement_override: second,
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect(
      replaced.data.enforcement_override,
      "an update merged the levers rather than replacing them",
    ).toEqual(second);
    expect((await own.getCurrentKey()).data.enforcement_override).toEqual(
      second,
    );

    const cleared = await client.updateKey(minted.data.id, {
      enforcement_override: null,
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    expect("enforcement_override" in cleared.data).toBe(false);
    expect("enforcement_override" in (await own.getCurrentKey()).data).toBe(
      false,
    );
  });

  it("names the field a lever lacks, on the mint and on the update", async () => {
    const lever = { source_filter: { sources: [ctx.source] } };
    const field = "enforcement_override.source_filter.types";
    // One fault, one answer: the update is held to the mint's refusal.
    const minted = await client.createKey({
      label: "levers-lacking",
      source: `${ctx.source}-levers-lacking`,
      enforcement_override: lever as never,
    });
    expect(minted.status).toBe(400);
    expect(minted.error?.error.code).toBe("missing_required_field");
    expect(minted.error?.error.details?.field).toBe(field);
    expect(minted.error?.error.message).toBe(`${field} is required`);

    const holder = await keyWith("levers-lacking-held");
    const refused = await client.updateKey(holder.id, {
      enforcement_override: lever as never,
    });
    expect(refused.status).toBe(400);
    expect(refused.error).toEqual(minted.error);

    const after = await client.listKeys();
    expect(
      after.data.data.find((k) => k.id === holder.id)?.enforcement_override,
      "a refused update stored a lever",
    ).toBeUndefined();
    expect(
      after.data.data.some((k) => k.label === "levers-lacking"),
      "a refused mint stored a key",
    ).toBe(false);
  });

  it("refuses a mint or an update naming levers to a caller without config.manage", async () => {
    const lever = { strict_mode: { types: [] } };
    const minter = await keyWith("levers-minter", {
      permissions: ["keys.mint"],
    });
    // The witness: the same caller mints and changes a key when the body
    // names no levers, so the refusals below are the levers'.
    const plain = await minter.client.createKey({
      label: "levers-plain",
      source: `${ctx.source}-levers-plain`,
      type_permissions: { "core.note": "write" },
    });
    expect(plain.status, JSON.stringify(plain.error)).toBe(201);
    trackKey(ctx, plain.data.id);
    const relabeled = await minter.client.updateKey(plain.data.id, {
      label: "levers-plain-relabeled",
    });
    expect(relabeled.status, JSON.stringify(relabeled.error)).toBe(200);

    const refusals = [
      await minter.client.createKey({
        label: "levers-refused",
        source: `${ctx.source}-levers-refused`,
        type_permissions: { "core.note": "write" },
        enforcement_override: lever,
      }),
      await minter.client.updateKey(plain.data.id, {
        enforcement_override: lever,
      }),
      await minter.client.updateKey(plain.data.id, {
        enforcement_override: null,
      }),
    ];
    // A caller holding `keys.manage` is held to the same permission.
    const managing = await getManagementClient().createKey({
      label: "levers-manager",
      source: `${ctx.source}-levers-manager`,
      permissions: ["keys.manage"],
    });
    expect(managing.status, JSON.stringify(managing.error)).toBe(201);
    trackKey(ctx, managing.data.id);
    const manager = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: managing.data.key,
    });
    refusals.push(
      await manager.updateKey(plain.data.id, {
        enforcement_override: lever,
      }),
    );
    for (const refused of refusals) {
      expect(refused.status, JSON.stringify(refused.error)).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
      expect(refused.error?.error.details?.required_scope).toBe(
        "config.manage",
      );
    }
    const listed = await client.listKeys();
    expect(
      listed.data.data.find((k) => k.id === plain.data.id)
        ?.enforcement_override,
      "a refused update stored a lever",
    ).toBeUndefined();
    expect(
      listed.data.data.some((k) => k.label === "levers-refused"),
      "a refused mint stored a key",
    ).toBe(false);
  });

  it("is not taken from the creator by a mint naming none", async () => {
    const creator = await keyWith("levers-creator", {
      permissions: ["keys.mint"],
      enforcement_override: { strict_mode: { types: ["core.note"] } },
    });
    expect(
      (await creator.client.getCurrentKey()).data.enforcement_override,
      "the creator holds no levers, so the child below inherits nothing either way",
    ).toBeDefined();
    const child = await creator.client.createKey({
      label: "levers-child",
      source: `${ctx.source}-levers-child`,
    });
    expect(child.status, JSON.stringify(child.error)).toBe(201);
    trackKey(ctx, child.data.id);
    expect("enforcement_override" in child.data).toBe(false);
  });

  it(
    "an app holding config.manage sets a key's levers looser than the instance's, and one without it is refused",
    async () => {
      const server = await bootFreshServer("key-levers-app");
      try {
        const working = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: server.workingKey,
        });
        const configured = await working.updateConfig({
          enforcement: { strict_mode: { types: ["core.note"] } },
        });
        expect(configured.status, JSON.stringify(configured.error)).toBe(200);
        const app = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: await approvedAppToken(server),
        });

        const mint = async (
          label: string,
          extra: Partial<ApiKeyRequest> = {},
        ): Promise<MarfaClient> => {
          const minted = await app.createKey({
            label,
            source: label,
            type_permissions: { "core.note": "write" },
            ...extra,
          });
          expect(minted.status, JSON.stringify(minted.error)).toBe(201);
          expect(minted.data.oauth_client_id).toBeDefined();
          return new MarfaClient({
            baseUrl: server.apiUrl,
            apiKey: minted.data.key,
          });
        };
        // The witness: an app's key with no levers of its own is held to
        // the instance's.
        const plain = await mint("app-plain");
        expect((await plain.createItem(undeclared)).status).toBe(400);

        const loose = await mint("app-loose", {
          enforcement_override: { strict_mode: { types: [] } },
        });
        expect(
          (await loose.createItem(undeclared)).status,
          "an app could not set a key's levers looser than the instance's",
        ).toBe(201);

        const unconfigured = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: await approvedAppToken(server, [
            "core.note:write",
            "keys.mint",
          ]),
        });
        // The witness: the same app mints the key when it names no levers.
        const allowed = await unconfigured.createKey({
          label: "app-unconfigured-plain",
          source: "app-unconfigured-plain",
          type_permissions: { "core.note": "write" },
        });
        expect(allowed.status, JSON.stringify(allowed.error)).toBe(201);
        const refused = await unconfigured.createKey({
          label: "app-unconfigured",
          source: "app-unconfigured",
          type_permissions: { "core.note": "write" },
          enforcement_override: { strict_mode: { types: [] } },
        });
        expect(refused.status, JSON.stringify(refused.error)).toBe(403);
        expect(refused.error?.error.code).toBe("forbidden");
        expect(refused.error?.error.details?.required_scope).toBe(
          "config.manage",
        );
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});
