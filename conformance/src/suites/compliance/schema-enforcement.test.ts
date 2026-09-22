import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackKey,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { itemsArchive } from "../../utils/archive.js";
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
 * A writer identified by a specific `source`. `source` is credential-stamped
 * and not forgeable, so a distinct source means a distinct credential.
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
    const operator = getOperatorClient();
    const refused = await operator.restoreArchive(
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
    const restored = await operator.restoreArchive(
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
    // The door built for volume, reachable by any working key, and it
    // reached `storage.items.create` and `storage.items.update` directly
    // — where validation runs loose whatever the lever says. So the
    // control `POST /items` enforces was a different door away, on both
    // the rows this page creates and the rows it updates.
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
    // `PATCH /items/{id}` validated loosely too, so a row created under
    // the lever could be given the property it was refused at creation,
    // one request later.
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
    const restored = await getOperatorClient().restoreArchive(
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
      tags: [marker],
    });
    expect(concealed.ok).toBe(true);
    trackItem(ctx, concealed.data.item.id);

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
    const searchIds = found.data.results.map((r) => r.item.id);
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
});
