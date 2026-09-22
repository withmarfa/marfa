/**
 * Conformance for POST /items/bulk and POST /items/bulk-actions.
 *
 * Scope is deliberately narrow: the wire shape of each endpoint — per-item
 * outcomes, the upsert and create_only modes, atomic rollback, the per-item
 * permission gate, and the async job lifecycle behind bulk actions.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  TestContext,
  MarfaItem,
  MarfaMetadata,
  BulkActionInput,
  BulkActionResponse,
  BulkActionJob,
} from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "bulk"));
});

afterAll(async () => {
  await cleanup(ctx);
});

function parseNdjson(
  raw: string,
): Array<{ item: MarfaItem; metadata: MarfaMetadata }> {
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(
      (line) =>
        JSON.parse(line) as { item: MarfaItem; metadata: MarfaMetadata },
    );
}

async function createScopedClient(
  label: string,
  typePermissions: Record<string, string>,
): Promise<MarfaClient> {
  const keyResp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: typePermissions,
  });
  expect(keyResp.ok).toBe(true);
  trackKey(ctx, keyResp.data.id);

  return new MarfaClient({
    baseUrl: apiUrl,
    apiKey: keyResp.data.key,
  });
}

describe("bulk", () => {
  it("round-trips export → bulk (create_only) with a new source_id", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await client.createItem(createNote({ source: ctx.source }));
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
    }

    const exported = await client.exportItems({ type: "core.note" });
    expect(exported.ok).toBe(true);

    const lines = parseNdjson(exported.data);
    expect(lines.length).toBeGreaterThan(0);

    const prefix = `reimported-${ctx.runId}`;
    const bulkItems = lines.slice(0, 3).map((line, i) => ({
      type: line.item.type,
      properties: line.item.properties,
      source_id: `${prefix}-${i}`,
      tags: line.metadata.tags,
    }));

    const imported = await client.bulkItems({
      items: bulkItems,
      mode: "create_only",
    });
    expect(imported.ok).toBe(true);
    await expectMatchesSchema("POST", "/items/bulk", 200, imported.data);
    expect(imported.data.counts.created).toBe(3);
    expect(imported.data.counts.updated).toBe(0);
    expect(imported.data.results).toHaveLength(3);
    for (const r of imported.data.results) {
      expect(r.outcome).toBe("created");
      expect(r.id).toBeDefined();
    }

    // Verify the reimported rows exist — /items/bulk stamps tier=feed by
    // default, so query with tier=all.
    const list = await client.listItems({
      type: "core.note",
      tier: "all",
      limit: 100,
    });
    expect(list.ok).toBe(true);
    const reimported = list.data.data.filter((item) =>
      (item.source_id ?? "").startsWith(prefix),
    );
    expect(reimported.length).toBe(3);
    for (const item of reimported) {
      trackItem(ctx, item.id);
    }
  });

  it("upsert mode updates an existing (source, source_id) row in place", async () => {
    const sourceId = `upsert-${ctx.runId}`;
    const first = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "initial", body: "v1" },
          source_id: sourceId,
        },
      ],
    });
    expect(first.ok).toBe(true);
    expect(first.data.counts.created).toBe(1);
    const originalId = first.data.results[0]!.id!;
    trackItem(ctx, originalId);

    const second = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "initial", body: "v2" },
          source_id: sourceId,
        },
      ],
      mode: "upsert",
    });
    expect(second.ok).toBe(true);
    expect(second.data.counts.updated).toBe(1);
    expect(second.data.counts.created).toBe(0);
    expect(second.data.results[0]!.id).toBe(originalId);

    const getRes = await client.getItem(originalId);
    expect(getRes.ok).toBe(true);
    expect((getRes.data.item.properties as { body: string }).body).toBe("v2");
  });

  it("atomic rollback on invalid type returns 400 and leaves no rows", async () => {
    const tag = `atomic-${ctx.runId}`;
    const res = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "good" },
          tags: [tag],
          source_id: `${tag}-good`,
        },
        {
          type: "NOT a valid type",
          properties: { title: "bad" },
          tags: [tag],
          source_id: `${tag}-bad`,
        },
      ],
      atomic: true,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("bulk_atomic_rollback");

    const list = await client.listItems({ tags: [tag], tier: "all" });
    expect(list.ok).toBe(true);
    expect(list.data.data).toHaveLength(0);
  });

  it("gates bulk writes per item type, and on nothing else", async () => {
    // A key may bulk-write any type it holds write on. Bulk authorizes per
    // item rather than per caller, so nothing about the credential beyond its
    // type map is consulted. A key with write on all types succeeds.
    const writer = await createScopedClient("bulk-writer", { "*": "write" });
    const ok = await writer.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "permitted", body: "permitted body" },
        },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.data.counts.created).toBe(1);
    trackItem(ctx, ok.data.results[0]!.id!);

    // A key lacking write on core.note is denied at the per-item gate.
    // In atomic mode the batch rolls back with the inner type_not_permitted.
    const denied = await createScopedClient("bulk-denied", {
      "core.bookmark": "write",
    });
    const rejected = await denied.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "denied", body: "denied body" },
        },
      ],
    });
    expect(rejected.ok).toBe(false);
    // `403`, because the batch was refused for a permission the caller
    // does not hold. A client sorts refusals by status before it reads a
    // code, and a `400` filed this under "fix the request" — which is the
    // one thing the caller cannot do about it.
    expect(rejected.status).toBe(403);
    expect(rejected.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rejected.error?.error.details?.code).toBe("type_not_permitted");

    // The rollback is still a rollback. A status that changed and a page
    // that landed would be worse than either.
    const listed = await denied.listItems({ type: "core.note", limit: 5 });
    expect(listed.ok).toBe(true);
    expect(listed.data.data).toHaveLength(0);
  });

  it("keeps a rollback that is not a permission refusal at 400", async () => {
    // The witness for the case above, and the line the status draws: a
    // page refused for something the caller can fix stays where a caller
    // looks for that, and only the permission refusal moves.
    const rejected = await client.bulkItems({
      items: [
        {
          type: "acme.not-registered",
          properties: { title: "unknown type" },
        },
      ],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.status).toBe(400);
    expect(rejected.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rejected.error?.error.details?.code).toBe("unknown_type");
  });

  it("create_only skips a repeated (source, source_id) as duplicate_source", async () => {
    const sourceId = `create-only-${ctx.runId}`;
    const entry = {
      type: "core.note",
      properties: { title: "create_only", body: "first" },
      source_id: sourceId,
    };

    const first = await client.bulkItems({
      items: [entry],
      mode: "create_only",
    });
    expect(first.ok).toBe(true);
    expect(first.data.counts.created).toBe(1);
    const originalId = first.data.results[0]!.id!;
    trackItem(ctx, originalId);

    const second = await client.bulkItems({
      items: [
        { ...entry, properties: { title: "create_only", body: "second" } },
      ],
      mode: "create_only",
    });
    expect(second.ok).toBe(true);
    expect(second.data.counts.skipped).toBe(1);
    expect(second.data.counts.created).toBe(0);
    expect(second.data.counts.updated).toBe(0);
    expect(second.data.results).toHaveLength(1);
    expect(second.data.results[0]!.outcome).toBe("skipped");
    expect(second.data.results[0]!.reason).toBe("duplicate_source");
    expect(second.data.results[0]!.id).toBe(originalId);

    const stored = await client.getItem(originalId);
    expect(stored.ok).toBe(true);
    expect((stored.data.item.properties as { body: string }).body).toBe(
      "first",
    );
  });

  it("atomic=false keeps the good entry and errors the unregistered type", async () => {
    const unregistered = `user.bulk-unregistered-${ctx.runId}`;
    const res = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "good", body: "good body" },
          source_id: `mixed-good-${ctx.runId}`,
        },
        {
          type: unregistered,
          properties: { title: "bad" },
          source_id: `mixed-bad-${ctx.runId}`,
        },
      ],
      atomic: false,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data.counts.created).toBe(1);
    expect(res.data.counts.errored).toBe(1);
    expect(res.data.results).toHaveLength(2);

    expect(res.data.results[0]!.outcome).toBe("created");
    const goodId = res.data.results[0]!.id!;
    trackItem(ctx, goodId);

    expect(res.data.results[1]!.outcome).toBe("errored");
    expect(res.data.results[1]!.error?.code).toBe("unknown_type");
    expect(res.data.results[1]!.id).toBeUndefined();

    const stored = await client.getItem(goodId);
    expect(stored.ok).toBe(true);
    expect(stored.data.item.source_id).toBe(`mixed-good-${ctx.runId}`);
  });

  it("purge is refused to a key holding no permissions", async () => {
    const label = `bulk-purge-noperms-${ctx.runId}`;
    const keyResp = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "*": "write" },
      permissions: [],
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scoped = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const tag = `ba-purge-noperms-${ctx.runId}`;
    const seeded = await client.createItem(
      createNote({ source: ctx.source, tags: [tag], tier: "library" }),
    );
    expect(seeded.ok).toBe(true);
    trackItem(ctx, seeded.data.item.id);

    const res = await scoped.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag] },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error?.error.code).toBe("forbidden");
    expect(res.error?.error.details?.required_scope).toBe("items.purge");

    const survivor = await client.getItem(seeded.data.item.id);
    expect(survivor.ok).toBe(true);
  });
});

describe("bulk_action time filters", () => {
  /**
   * Presence of a field in the client type is not the property worth
   * asserting, so this narrows a real match set: two items are seeded, one is
   * bounded out, and the assertion is which ids come back.
   */
  it("narrows a match set by the item's own time", async () => {
    const tag = `ba-time-${ctx.runId}`;
    const old = await client.createItem(
      createNote({
        source: ctx.source,
        tags: [tag],
        tier: "library",
        occurred_at: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(old.ok).toBe(true);
    trackItem(ctx, old.data.item.id);

    const recent = await client.createItem(
      createNote({
        source: ctx.source,
        tags: [tag],
        tier: "library",
        occurred_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(recent.ok).toBe(true);
    trackItem(ctx, recent.data.item.id);

    // The control: unbounded, both rows are in the match set. Without it a
    // bounded run returning one row says nothing about the bound.
    const unbounded = await client.bulkAction({
      action: "update_tags",
      add: [`${tag}-probe`],
      filter: { tags: [tag] },
      dry_run: true,
    });
    expect(unbounded.ok).toBe(true);
    expect((unbounded.data as BulkActionResponse).ids?.sort()).toEqual(
      [old.data.item.id, recent.data.item.id].sort(),
    );

    const bounded = await client.bulkAction({
      action: "update_tags",
      add: [`${tag}-probe`],
      filter: { tags: [tag], occurred_after: "2023-01-01T00:00:00.000Z" },
      dry_run: true,
    });
    expect(bounded.ok).toBe(true);
    const boundedResult = bounded.data as BulkActionResponse;
    expect(boundedResult.ids).toEqual([recent.data.item.id]);
    expect(boundedResult.ids).not.toContain(old.data.item.id);

    const upperBounded = await client.bulkAction({
      action: "update_tags",
      add: [`${tag}-probe`],
      filter: { tags: [tag], occurred_before: "2023-01-01T00:00:00.000Z" },
      dry_run: true,
    });
    expect(upperBounded.ok).toBe(true);
    expect((upperBounded.data as BulkActionResponse).ids).toEqual([
      old.data.item.id,
    ]);
  });

  it("refuses a filter field it does not declare, naming it", async () => {
    const tag = `ba-undeclared-${ctx.runId}`;
    await seedTagged(1, tag);

    // A dropped filter field here is not a narrower match set but every row
    // the credential can see, so the door refuses rather than strips.
    for (const undeclared of ["since", "until", "occurred_at_after"]) {
      const res = await client.bulkAction({
        action: "update_tags",
        add: ["probe"],
        dry_run: true,
        // Deliberately off-type: the client type does not offer these
        // fields, and the point is that the wire refuses them.
        filter: { [undeclared]: "2023-01-01T00:00:00.000Z" } as never,
      });
      expect(res.status).toBe(400);
      expect(res.error?.error.details?.unknown_filter_fields).toEqual([
        undeclared,
      ]);
    }
  });
});

async function seedTagged(count: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = await client.createItem(
      createNote({ source: ctx.source, tags: [tag], tier: "library" }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    ids.push(r.data.item.id);
  }
  return ids;
}

/** Queue an action, poll its job to completion, and return the result. */
async function runToCompletion(
  input: BulkActionInput,
): Promise<BulkActionResponse> {
  const res = await client.bulkAction(input);
  expect(res.status).toBe(202);
  const queued = res.data as BulkActionJob;
  expect(queued.status).toBe("queued");
  const final = await client.pollBulkActionToTerminal(queued.id);
  expect(final.status).toBe("completed");
  expect(final.result).toBeDefined();
  return final.result!;
}

describe("bulk_action", () => {
  it("transition archives every match (async job path)", async () => {
    const tag = `ba-trans-${ctx.runId}`;
    const ids = await seedTagged(3, tag);

    const result = await runToCompletion({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(3);
    expect(result.errored).toBe(0);

    for (const id of ids) {
      const got = await client.getItem(id);
      expect(got.ok).toBe(true);
      expect(got.data.item.state).toBe("archived");
    }
  });

  it("purge deletes matching items (with confirm)", async () => {
    const tag = `ba-purge-${ctx.runId}`;
    const ids = await seedTagged(3, tag);

    const result = await runToCompletion({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(3);
    // Three notes, no blobs: the count is the purge's report of what it
    // would have orphaned, and zero is the answer it has to give.
    expect(result.blob_hashes_referenced).toBe(0);

    const got = await client.getItem(ids[0]!);
    expect(got.status).toBe(404);
  });

  it("purge without confirm returns 400 bulk_confirmation_required", async () => {
    const tag = `ba-purge-confirm-${ctx.runId}`;
    await seedTagged(1, tag);

    const res = await client.bulkAction({
      action: "purge",
      filter: { tags: [tag] },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("bulk_confirmation_required");
  });

  it("dry_run stays synchronous and returns matched ids without mutating", async () => {
    const tag = `ba-dry-${ctx.runId}`;
    const ids = await seedTagged(2, tag);

    const res = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
      dry_run: true,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const result = res.data as BulkActionResponse;
    expect(result.dry_run).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.ids?.sort()).toEqual(ids.slice().sort());

    const got = await client.getItem(ids[0]!);
    expect(got.ok).toBe(true);
    expect(got.data.item.state).toBe("active");
  });

  it("update_tags adds and removes", async () => {
    const tag = `ba-tags-${ctx.runId}`;
    const ids = await seedTagged(2, tag);

    const result = await runToCompletion({
      action: "update_tags",
      add: [`${tag}-added`],
      remove: [tag],
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(2);

    const got = await client.getItem(ids[0]!);
    expect(got.ok).toBe(true);
    expect(got.data.metadata.tags).toContain(`${tag}-added`);
    expect(got.data.metadata.tags).not.toContain(tag);
  });

  it("update_tier and update_properties both land", async () => {
    // Combined: both actions are one item update each.
    const tag = `ba-tier-${ctx.runId}`;
    const ids = await seedTagged(1, tag);

    const tier = await runToCompletion({
      action: "update_tier",
      tier: "feed",
      filter: { tags: [tag] },
    });
    expect(tier.succeeded).toBe(1);

    const props = await runToCompletion({
      action: "update_properties",
      patch: { extra_bulk_field: "patched" },
      filter: { tags: [tag] },
    });
    expect(props.succeeded).toBe(1);

    const got = await client.getItem(ids[0]!);
    expect(got.ok).toBe(true);
    expect(got.data.item.tier).toBe("feed");
    expect(
      (got.data.item.properties as { extra_bulk_field?: string })
        .extra_bulk_field,
    ).toBe("patched");
  });

  it("update_occurred_at overrides the item's own time", async () => {
    const tag = `ba-ts-${ctx.runId}`;
    const ids = await seedTagged(1, tag);
    const newTs = "2001-09-11T08:46:00.000Z";

    const result = await runToCompletion({
      action: "update_occurred_at",
      occurred_at: newTs,
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(1);

    const got = await client.getItem(ids[0]!);
    expect(got.ok).toBe(true);
    expect(got.data.item.occurred_at).toBe(newTs);
  });
});

describe("bulk_action async-job lifecycle", () => {
  it("POST returns 202 with a queued envelope; status terminates completed", async () => {
    const tag = `ba-lifecycle-${ctx.runId}`;
    await seedTagged(2, tag);

    const post = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(post.ok).toBe(true);
    expect(post.status).toBe(202);
    await expectMatchesSchema("POST", "/items/bulk-actions", 202, post.data);
    const queued = post.data as BulkActionJob;
    expect(queued.id).toBeTruthy();
    expect(queued.status).toBe("queued");
    expect(queued.matched).toBe(2);

    const final = await client.pollBulkActionToTerminal(queued.id);
    expect(final.status).toBe("completed");
    expect(final.matched).toBe(2);
    expect(final.succeeded).toBe(2);
    expect(final.result?.action).toBe("transition");

    const status = await client.bulkActionStatus(queued.id);
    expect(status.ok).toBe(true);
    await expectMatchesSchema(
      "GET",
      "/items/bulk-actions/jobs/{id}",
      200,
      status.data,
    );
    expect(status.data.id).toBe(queued.id);
  });

  it("GET on an unknown id returns 404 bulk_job_not_found", async () => {
    const res = await client.bulkActionStatus(`baj-doesnt-exist-${ctx.runId}`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error?.error.code).toBe("bulk_job_not_found");
  });

  it("DELETE on a terminal job answers 200 with its final state unchanged", async () => {
    // The worker takes a job the moment it is queued and a local run of a
    // few hundred rows completes before a second request can land, so the
    // queued and in-flight cancellations are not reachable over the wire.
    // What is reachable is the door's answer once the job is terminal.
    const tag = `ba-cancel-${ctx.runId}`;
    await seedTagged(5, tag);
    const post = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(post.status).toBe(202);
    const queued = post.data as BulkActionJob;
    const final = await client.pollBulkActionToTerminal(queued.id);
    expect(final.status).toBe("completed");

    const del = await client.bulkActionCancel(queued.id);
    expect(del.status).toBe(200);
    await expectMatchesSchema(
      "DELETE",
      "/items/bulk-actions/jobs/{id}",
      200,
      del.data,
    );
    expect(del.data.status).toBe("completed");
    expect(del.data.finished_at).toBe(final.finished_at);
    expect(del.data.succeeded).toBe(final.succeeded);
  });

  it("DELETE on an unknown id returns 404 bulk_job_not_found", async () => {
    const res = await client.bulkActionCancel(`baj-doesnt-exist-${ctx.runId}`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error?.error.code).toBe("bulk_job_not_found");
  });

  it("Idempotency-Key returns the same job id on replay", async () => {
    const tag = `ba-idem-${ctx.runId}`;
    await seedTagged(2, tag);
    const key = `idem-${ctx.runId}-${Math.random().toString(36).slice(2, 8)}`;

    const first = await client.bulkAction(
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
      { idempotencyKey: key },
    );
    expect(first.ok).toBe(true);
    expect(first.status).toBe(202);
    const firstJobId = (first.data as BulkActionJob).id;

    const replay = await client.bulkAction(
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
      { idempotencyKey: key },
    );
    expect(replay.ok).toBe(true);
    expect((replay.data as BulkActionJob).id).toBe(firstJobId);
  });

  it("tells a reused id from a mistaken declaration, as the single-item doors do", async () => {
    // The code a batched write gets must not depend on its being batched.
    // An entry whose own `id` resolves a row of another type is the
    // reused-id mistake and answers `id_reused`; one whose natural key
    // resolves a row of another type is the declaration mistake and
    // answers `type_mismatch`. Both travel in `details.code` here,
    // because the page rolls back under the default `atomic`.
    const byId = await client.createItem(createNote({ source: ctx.source }));
    expect(byId.ok).toBe(true);
    trackItem(ctx, byId.data.item.id);

    const reusedId = await client.bulkItems({
      items: [
        {
          id: byId.data.item.id,
          type: "core.task",
          properties: { title: "landed on a note by id" },
        },
      ],
    });
    expect(reusedId.status).toBe(400);
    expect(reusedId.error?.error.code).toBe("bulk_atomic_rollback");
    expect(reusedId.error?.error.details?.code).toBe("id_reused");

    const sourceId = `bulk-retype-${ctx.runId}`;
    const byKey = await client.createItem(
      createNote({ source: ctx.source, source_id: sourceId }),
    );
    expect(byKey.ok).toBe(true);
    trackItem(ctx, byKey.data.item.id);

    const mistakenDeclaration = await client.bulkItems({
      items: [
        {
          type: "core.task",
          source_id: sourceId,
          properties: { title: "landed on a note by natural key" },
        },
      ],
    });
    expect(mistakenDeclaration.status).toBe(400);
    expect(mistakenDeclaration.error?.error.details?.code).toBe(
      "type_mismatch",
    );

    // The witness for both: the same two entries declaring the rows' own
    // type land, so each refusal is the type rather than the door.
    const accepted = await client.bulkItems({
      items: [
        {
          id: byId.data.item.id,
          type: "core.note",
          properties: { body: "by id" },
        },
        {
          type: "core.note",
          source_id: sourceId,
          properties: { body: "by natural key" },
        },
      ],
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.data.counts.updated).toBe(2);
  });
});
