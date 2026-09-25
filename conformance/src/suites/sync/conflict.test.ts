import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import {
  detectSyncCapabilities,
  requireRule,
  trackSourceScopedItems,
} from "./capabilities.js";
import type { SyncCapabilities } from "./capabilities.js";

/**
 * "Fields that do not collide merge on their own": a conflict is resolved by
 * the server, in the server's transaction, by the type's policy.
 *
 * The half this rule turns on is `keep_both_copies`. Two clients editing
 * different fields already merge, and the correctness suite covers that along
 * with the 409 envelope a `manual` resolution needs — none of which is
 * repeated here. What changes under this rule is who creates the sibling. A
 * client that has to create it makes two writes where the server makes one,
 * and there is no arrangement of two writes that is atomic: a queue that dies
 * between them leaves the conflicted copy unwritten and the original already
 * moved on, so the losing edit is gone with nothing recording that it existed.
 * Every engine then needs its own resolution code, and the two drift.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let caps: SyncCapabilities;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "conflict",
  ));
  caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the server resolves a conflict", () => {
  it("keeps both copies in one write where the type says to", async () => {
    requireRule(caps, "serverSideMerge");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "shared title", body: "shared body" },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const base = seed.data.item.version;

    // `body` on core.note is a keep-both field and `title` is
    // last-writer-wins, so one request exercises both arms of the policy.
    const winner = await client.updateItem(id, {
      properties: {
        title: "title from the winner",
        body: "body from the winner",
      },
      version: base,
    });
    expect(winner.ok).toBe(true);

    // The control. Without it a server that never refuses this write at all
    // would satisfy everything below, and the flag would be resolving a
    // collision that was never there.
    const refused = await client.rawRequest(`/items/${id}`, {
      method: "PATCH",
      body: {
        properties: {
          title: "title from the loser",
          body: "body from the loser",
        },
        version: base,
      },
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");

    const resolved = await client.rawRequest<{
      item: { id: string; properties: Record<string, unknown> };
      conflict_resolution?: {
        strategy?: Record<string, string>;
        conflicted_copy_id?: string;
      };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: {
          title: "title from the loser",
          body: "body from the loser",
        },
        version: base,
      },
    });
    expect(
      resolved.ok,
      `a colliding update sent with conflict=auto was not resolved: ${resolved.status} ${JSON.stringify(resolved.error)}`,
    ).toBe(true);
    // Every row this write may have spawned, before any assertion can throw:
    // a server that resolved differently may have written one the envelope
    // does not name, and a listing scoped to this file's credential owns it.
    await trackSourceScopedItems({ client, ctx });

    // The envelope reports the resolution, and the document says this is the
    // only place the sibling's id appears.
    const resolution = resolved.data.conflict_resolution;
    expect(
      resolution?.strategy?.body,
      "the resolution did not report the type's policy for the keep-both field",
    ).toBe("keep_both_copies");
    expect(
      resolution?.strategy?.title,
      "the resolution did not report the type's policy for the last-writer-wins field",
    ).toBe("last_writer_wins");
    expect(
      typeof resolution?.conflicted_copy_id,
      "the resolution named no conflicted copy, so the sibling it wrote is unreachable to the client that caused it",
    ).toBe("string");

    const original = await client.getItem(id);
    expect(original.ok).toBe(true);

    // The last-writer-wins arm. Without it the test would pass against a
    // server that answered 200 by discarding the losing write entirely.
    expect(
      original.data.item.properties.title,
      "a last-writer-wins field did not take the later writer, so the type's policy was not applied",
    ).toBe("title from the loser");

    // The keep-both arm on the original: the server's value stands.
    expect(
      original.data.item.properties.body,
      "a keep-both field took the losing write on the original row, which is last-writer-wins under another name",
    ).toBe("body from the winner");

    // And the losing text survives somewhere the person can find it. This is
    // the assertion the rule exists for: a resolution that keeps only one
    // copy has lost an edit the writer was never told about.
    const siblings = await client.rawRequest<{
      data?: Array<{ id: string; properties: Record<string, unknown> }>;
    }>(`/items?source=${encodeURIComponent(ctx.source)}&limit=200`);
    expect(siblings.ok).toBe(true);
    const kept = (siblings.data.data ?? []).filter(
      (i) => i.id !== id && i.properties.body === "body from the loser",
    );
    expect(
      kept.map((i) => i.id),
      "the row carrying the losing text is not the one the envelope named",
    ).toEqual([resolution?.conflicted_copy_id]);
    expect(
      kept,
      "the losing copy of a keep-both field was not written anywhere, so an edit the client had accepted is gone with nothing recording it",
    ).toHaveLength(1);

    // The sibling has to be findable as a conflicted copy of the same type,
    // or a person meets an unexplained second row rather than a copy they can
    // reconcile.
    const sibling = await client.getItem(kept[0].id);
    expect(sibling.ok).toBe(true);
    expect(sibling.data.item.type).toBe("core.note");
    expect(sibling.data.metadata.tags).toContain("conflicted-copy");
  });

  it("resolves a field a stale replace cleared by the policy: cleared under last-writer-wins, kept and left off the copy under keep-both", async () => {
    requireRule(caps, "serverSideMerge");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        title: "shared title",
        body: "shared body",
        notes: "shared notes",
      },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const base = seed.data.item.version;

    // `title` is last-writer-wins on core.note and `notes` keeps both, so
    // one replace that leaves both out meets both arms of the policy.
    const winner = await client.updateItem(id, {
      properties: {
        title: "title from the winner",
        notes: "notes from the winner",
      },
      version: base,
    });
    expect(winner.ok).toBe(true);

    // The control: the same clear without the flag is refused, naming both.
    const refused = await client.rawRequest(`/items/${id}`, {
      method: "PATCH",
      body: {
        properties: { body: "shared body" },
        properties_mode: "replace",
        version: base,
      },
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");
    expect(
      (refused.error as unknown as { conflicting_fields?: string[] })
        .conflicting_fields,
    ).toEqual(["notes", "title"]);

    const resolved = await client.rawRequest<{
      item: { id: string; properties: Record<string, unknown> };
      conflict_resolution?: {
        strategy?: Record<string, string>;
        conflicted_copy_id?: string;
      };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: "shared body" },
        properties_mode: "replace",
        version: base,
      },
    });
    expect(
      resolved.ok,
      `a colliding replace sent with conflict=auto was not resolved: ${resolved.status} ${JSON.stringify(resolved.error)}`,
    ).toBe(true);
    await trackSourceScopedItems({ client, ctx });

    const resolution = resolved.data.conflict_resolution;
    expect(resolution?.strategy?.title).toBe("last_writer_wins");
    expect(resolution?.strategy?.notes).toBe("keep_both_copies");
    // The later writer's clear takes the last-writer-wins field; the
    // keep-both field keeps the server's value on the row.
    expect(resolved.data.item.properties).not.toHaveProperty("title");
    expect(resolved.data.item.properties.notes).toBe("notes from the winner");
    expect(resolved.data.item.properties.body).toBe("shared body");

    const copyId = resolution?.conflicted_copy_id;
    expect(typeof copyId).toBe("string");
    const sibling = await client.getItem(copyId!);
    expect(sibling.ok).toBe(true);
    // The losing value of a keep-both field was "absent", so the copy
    // carries the row without it.
    expect(sibling.data.item.properties).not.toHaveProperty("notes");
    expect(sibling.data.item.properties.title).toBe("title from the winner");
    expect(sibling.data.item.properties.body).toBe("shared body");
    expect(sibling.data.metadata.tags).toContain("conflicted-copy");
  });

  it("resolves a colliding item field to the later writer, and leaves an echoed one alone", async () => {
    // `tier`, `occurred_at` and `source_id` are the item's own fields
    // rather than properties, so the type declares no strategy for them
    // and `keep_both_copies` has nothing to mean: a sibling is a copy of
    // the row's properties, and a tier on it would be the sibling's own.
    // They take the later writer, and the resolution says so rather than
    // naming a field in `fields` with no strategy beside it.
    const seed = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "item fields", body: "original" },
      }),
    );
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const base = seed.data.item.version;

    const winner = await client.updateItem(id, {
      occurred_at: "2026-05-01T00:00:00.000Z",
      tier: "feed",
      version: base,
    });
    expect(winner.ok).toBe(true);

    // The control, as above: without it a server that never refused this
    // write would satisfy everything below.
    const refused = await client.updateItem(id, {
      occurred_at: "2026-04-01T00:00:00.000Z",
      version: base,
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");

    // The same write asking the server to resolve, and carrying the tier
    // this caller read alongside the time it genuinely changed. The tier is
    // an echo, so resolving must not use it to undo the tier written since.
    const resolved = await client.rawRequest<{
      item: { tier: string; occurred_at: string };
      conflict_resolution?: {
        fields?: string[];
        strategy?: Record<string, string>;
      };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        occurred_at: "2026-04-01T00:00:00.000Z",
        tier: "library",
        version: base,
      },
    });
    expect(
      resolved.ok,
      `a colliding item-field update sent with conflict=auto was not resolved: ${resolved.status} ${JSON.stringify(resolved.error)}`,
    ).toBe(true);
    await trackSourceScopedItems({ client, ctx });

    expect(resolved.data.conflict_resolution?.fields).toEqual(["occurred_at"]);
    expect(
      resolved.data.conflict_resolution?.strategy?.occurred_at,
      "the resolution named the field without naming the strategy it applied",
    ).toBe("last_writer_wins");

    const after = await client.getItem(id);
    expect(after.ok).toBe(true);
    expect(
      after.data.item.occurred_at,
      "the colliding field did not take the later writer",
    ).toBe("2026-04-01T00:00:00.000Z");
    expect(
      after.data.item.tier,
      "an echoed item field reverted a value written since, which is the clobber the version check exists to stop",
    ).toBe("feed");
  });
});
