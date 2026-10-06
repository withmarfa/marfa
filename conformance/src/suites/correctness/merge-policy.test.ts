import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  ConflictResponse,
  MergePolicy,
  TestContext,
  TypeSchema,
} from "../../client/types.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  trackItem,
} from "../../utils/setup.js";

let client: MarfaClient;
let clientB: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "merge-policy"));
  clientB = await createSecondClient(ctx, "second");
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * The keep-both resolution a client performs on a 409, driven through the raw
 * HTTP client so the wire contract is what is exercised.
 */
async function resolveConflictKeepBoth(
  laterClient: MarfaClient,
  itemId: string,
  itemType: string,
  laterPatch: Record<string, unknown>,
  conflict: ConflictResponse,
): Promise<{ siblingId?: string; finalVersion: number }> {
  const policy = conflict.merge_policy;
  const strategyFor = (field: string) =>
    policy.fields?.[field] ?? policy.default ?? "last_writer_wins";

  const keepBothFields = conflict.conflicting_fields.filter(
    (f) => strategyFor(f) === "keep_both_copies",
  );

  let siblingId: string | undefined;
  if (keepBothFields.length > 0) {
    const siblingProps: Record<string, unknown> = {
      ...conflict.current.properties,
    };
    for (const field of keepBothFields) {
      siblingProps[field] = laterPatch[field];
    }
    // One create carries the copy, its tag and its link to the original, as
    // the server's own resolution writes them in one transaction.
    const sib = await laterClient.createItem({
      type: itemType,
      properties: siblingProps,
      tags: ["conflicted-copy"],
      edges: { "derived-from": [itemId] },
    });
    expect(
      sib.ok,
      `keep-both sibling create failed: ${JSON.stringify(sib.error)}`,
    ).toBe(true);
    trackItem(ctx, sib.data.item.id);
    siblingId = sib.data.item.id;
  }

  // Keep-both fields are dropped from the retry, so the server's pre-conflict
  // value stays on the original.
  const lwwProperties: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(laterPatch)) {
    if (!keepBothFields.includes(field)) {
      lwwProperties[field] = value;
    }
  }

  let finalVersion = conflict.current.version;
  if (Object.keys(lwwProperties).length > 0) {
    const retry = await laterClient.updateItem(itemId, {
      properties: lwwProperties,
      version: conflict.current.version,
    });
    expect(retry.ok, `LWW retry failed: ${JSON.stringify(retry.error)}`).toBe(
      true,
    );
    finalVersion = retry.data.item.version;
  }
  return { siblingId, finalVersion };
}

describe("core.note — body keep-both, title last-writer-wins", () => {
  it("non-conflicting writes from two clients both apply (different fields)", async () => {
    // A and B change different fields, so the changed sets are disjoint and
    // B's write at the stale version 1 merges rather than conflicting.
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "Original title", body: "Original body" },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const id = seed.data.item.id;

    const a = await client.updateItem(id, {
      properties: { body: "Body from A" },
      version: 1,
    });
    expect(a.ok).toBe(true);
    expect(a.data.item.version).toBe(2);

    const b = await clientB.updateItem(id, {
      properties: { title: "Title from B" },
      version: 1,
    });
    expect(
      b.ok,
      `expected non-conflicting B patch to succeed: ${JSON.stringify(b.error)}`,
    ).toBe(true);
    expect(b.data.item.version).toBe(3);

    const fetched = await client.getItem(id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.properties.body).toBe("Body from A");
    expect(fetched.data.item.properties.title).toBe("Title from B");
  });

  it("keep-both and LWW arrive in one 409, and the resolution reads back", async () => {
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "Shared title", body: "Shared body" },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const id = seed.data.item.id;

    const a = await client.updateItem(id, {
      properties: { title: "Title from A", body: "Body from A" },
      version: 1,
    });
    expect(a.ok).toBe(true);
    expect(a.data.item.version).toBe(2);

    // The stale patch overlaps on body (keep-both) and on title
    // (last-writer-wins), which is what makes one 409 carry both arms.
    const bPatch = {
      title: "Title from B",
      body: "Body from B",
    };
    const conflictResp = await client.updateItem(id, {
      properties: bPatch,
      version: 1,
    });
    expect(conflictResp.status).toBe(409);
    const conflict = conflictResp.error as unknown as ConflictResponse;

    expect(conflict.conflicting_fields).toEqual(["body", "title"]);
    expect(conflict.merge_policy.fields?.body).toBe("keep_both_copies");
    expect(conflict.merge_policy.default).toBe("last_writer_wins");
    expect(conflict.current.version).toBe(2);
    expect(conflict.current.properties.body).toBe("Body from A");

    const { siblingId } = await resolveConflictKeepBoth(
      clientB,
      id,
      "core.note",
      bPatch,
      conflict,
    );
    expect(siblingId).toBeDefined();

    const sib = await client.getItem(siblingId!);
    expect(sib.ok).toBe(true);
    expect(sib.data.metadata.tags).toContain("conflicted-copy");
    expect(sib.data.item.type).toBe("core.note");
    expect(sib.data.item.properties.body).toBe("Body from B");
    const link = await client.listItemEdges(siblingId!, {
      edge_type: "derived-from",
    });
    expect(link.ok).toBe(true);
    expect(
      link.data.data.map((edge) => edge.target_id),
      "the copy a client resolved does not name its original, as the server's copy does",
    ).toEqual([id]);
    expect(sib.data.item.properties.title).toBe("Title from A");

    // Keep-both leaves A's body on the original; title is last-writer-wins, so
    // B's value lands there.
    const original = await client.getItem(id);
    expect(original.ok).toBe(true);
    expect(original.data.item.properties.body).toBe("Body from A");
    expect(original.data.item.properties.title).toBe("Title from B");
  });
});

describe("core.bookmark — body+notes keep-both, url+title LWW", () => {
  it("keep-both for body, last-writer-wins for url and title", async () => {
    const seed = await client.createItem({
      type: "core.bookmark",
      source: ctx.source,
      properties: {
        url: "https://example.com/a",
        title: "Original title",
        body: "Original excerpt",
      },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const id = seed.data.item.id;

    const a = await client.updateItem(id, {
      properties: {
        url: "https://example.com/a-from-a",
        title: "Title from A",
        body: "Body from A",
      },
      version: 1,
    });
    expect(a.ok).toBe(true);

    const bPatch = {
      url: "https://example.com/a-from-b",
      title: "Title from B",
      body: "Body from B",
    };
    const conflictResp = await client.updateItem(id, {
      properties: bPatch,
      version: 1,
    });
    expect(conflictResp.status).toBe(409);
    const conflict = conflictResp.error as unknown as ConflictResponse;

    expect(conflict.conflicting_fields).toEqual(["body", "title", "url"]);
    expect(conflict.merge_policy.fields?.body).toBe("keep_both_copies");
    expect(conflict.merge_policy.fields?.notes).toBe("keep_both_copies");
    expect(conflict.merge_policy.fields?.url).toBeUndefined();
    expect(conflict.merge_policy.fields?.title).toBeUndefined();

    const { siblingId } = await resolveConflictKeepBoth(
      clientB,
      id,
      "core.bookmark",
      bPatch,
      conflict,
    );
    expect(siblingId).toBeDefined();

    const sib = await client.getItem(siblingId!);
    expect(sib.ok).toBe(true);
    expect(sib.data.metadata.tags).toContain("conflicted-copy");
    // Sibling has B's body (keep-both) + A's url and title (server-current,
    // since they're LWW and the sibling is a coherent copy at conflict time).
    expect(sib.data.item.properties.body).toBe("Body from B");
    expect(sib.data.item.properties.url).toBe("https://example.com/a-from-a");
    expect(sib.data.item.properties.title).toBe("Title from A");

    const original = await client.getItem(id);
    expect(original.ok).toBe(true);
    expect(original.data.item.properties.body).toBe("Body from A");
    expect(original.data.item.properties.url).toBe(
      "https://example.com/a-from-b",
    );
    expect(original.data.item.properties.title).toBe("Title from B");
  });
});

describe("core.task — body+notes keep-both, status+priority LWW", () => {
  it("status (most-conflicted task field) takes the latter writer; body keeps both", async () => {
    const seed = await client.createItem({
      type: "core.task",
      source: ctx.source,
      properties: {
        title: "Ship the conformance suite",
        status: "pending",
        priority: "medium",
        body: "Original details",
      },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const id = seed.data.item.id;

    const a = await client.updateItem(id, {
      properties: {
        status: "in_progress",
        priority: "low",
        body: "A added next steps.",
      },
      version: 1,
    });
    expect(a.ok).toBe(true);

    const bPatch = {
      status: "completed",
      priority: "urgent",
      body: "B noted the demo deadline.",
    };
    const conflictResp = await client.updateItem(id, {
      properties: bPatch,
      version: 1,
    });
    expect(conflictResp.status).toBe(409);
    const conflict = conflictResp.error as unknown as ConflictResponse;

    expect(conflict.conflicting_fields).toEqual(["body", "priority", "status"]);
    expect(conflict.merge_policy.fields?.body).toBe("keep_both_copies");
    expect(conflict.merge_policy.fields?.status).toBeUndefined();
    expect(conflict.merge_policy.fields?.priority).toBeUndefined();

    const { siblingId } = await resolveConflictKeepBoth(
      clientB,
      id,
      "core.task",
      bPatch,
      conflict,
    );
    expect(siblingId).toBeDefined();

    const sib = await client.getItem(siblingId!);
    expect(sib.ok).toBe(true);
    expect(sib.data.metadata.tags).toContain("conflicted-copy");
    expect(sib.data.item.properties.body).toBe("B noted the demo deadline.");
    // Sibling carries server-current (A's) status and priority.
    expect(sib.data.item.properties.status).toBe("in_progress");
    expect(sib.data.item.properties.priority).toBe("low");

    const original = await client.getItem(id);
    expect(original.ok).toBe(true);
    expect(original.data.item.properties.body).toBe("A added next steps.");
    expect(original.data.item.properties.status).toBe("completed");
    expect(original.data.item.properties.priority).toBe("urgent");
  });
});

describe("core.entity.person — empty keep-both fields, all LWW", () => {
  it("a conflicting field falls through to last-writer-wins via the policy default", async () => {
    const seed = await client.createItem({
      type: "core.entity.person",
      source: ctx.source,
      properties: {
        // `name` is required (inherited from core.entity).
        name: "Alex Original",
        given_name: "Alex",
        family_name: "Original",
        organization: "Original Corp",
      },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const id = seed.data.item.id;

    const a = await client.updateItem(id, {
      properties: { organization: "Org from A" },
      version: 1,
    });
    expect(a.ok).toBe(true);

    const bPatch = { organization: "Org from B" };
    const conflictResp = await client.updateItem(id, {
      properties: bPatch,
      version: 1,
    });
    expect(conflictResp.status).toBe(409);
    const conflict = conflictResp.error as unknown as ConflictResponse;

    // Empty-fields path: resolved policy carries `default` only; per-field
    // overrides are absent because core.entity.person inherits an empty
    // `merge_policy.fields` map from core.entity.
    expect(conflict.merge_policy.default).toBe("last_writer_wins");
    expect(conflict.merge_policy.fields ?? {}).toEqual({});
    expect(conflict.conflicting_fields).toEqual(["organization"]);

    // With no keep-both field in play there is nothing to spawn a sibling
    // from, so the resolution is only the retry at the current version.
    const { siblingId } = await resolveConflictKeepBoth(
      clientB,
      id,
      "core.entity.person",
      bPatch,
      conflict,
    );
    expect(siblingId).toBeUndefined();

    const original = await client.getItem(id);
    expect(original.ok).toBe(true);
    expect(original.data.item.properties.organization).toBe("Org from B");
  });
});

describe("custom type with explicit merge_policy override", () => {
  it("a child of core.note can override body from keep_both_copies to last_writer_wins", async () => {
    // A subtype of core.note that overrides body to last-writer-wins, where
    // the parent keeps both copies. A last-writer-wins field spawns no
    // conflicted-copy sibling, so the override changes what resolution does.
    const typeId = `user.evaluator-mp-note-override-${ctx.runId}`;
    const reg = await client.registerType({
      id: typeId,
      parent: "core.note",
      fields: {
        priority: { type: "string" },
      },
      merge_policy: {
        fields: {
          body: "last_writer_wins",
        },
        default: "last_writer_wins",
      },
    } as TypeSchema);
    expect(
      reg.ok,
      `register custom type failed: ${JSON.stringify(reg.error)}`,
    ).toBe(true);

    const fetched = await client.getType(typeId);
    expect(fetched.ok).toBe(true);
    const resolved = fetched.data.merge_policy as MergePolicy;
    expect(resolved.fields?.body).toBe("last_writer_wins");
    expect(resolved.default).toBe("last_writer_wins");

    // Both writers touch body, which is last-writer-wins for this subtype, so
    // the 409 carries the child's override rather than the parent's keep-both.
    const seed = await client.createItem({
      type: typeId,
      source: ctx.source,
      properties: {
        title: "Seed title",
        body: "Seed body",
        priority: "medium",
      },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const id = seed.data.item.id;

    const a = await client.updateItem(id, {
      properties: { body: "Body from A", priority: "low" },
      version: 1,
    });
    expect(a.ok).toBe(true);

    const bPatch = { body: "Body from B", priority: "high" };
    const conflictResp = await client.updateItem(id, {
      properties: bPatch,
      version: 1,
    });
    expect(conflictResp.status).toBe(409);
    const conflict = conflictResp.error as unknown as ConflictResponse;
    expect(conflict.merge_policy.fields?.body).toBe("last_writer_wins");
    expect(conflict.merge_policy.default).toBe("last_writer_wins");

    // With body last-writer-wins and no keep-both field in play, no sibling
    // spawns and the retry at the server-current version applies B's values.
    const { siblingId } = await resolveConflictKeepBoth(
      clientB,
      id,
      typeId,
      bPatch,
      conflict,
    );
    expect(siblingId).toBeUndefined();

    const original = await client.getItem(id);
    expect(original.ok).toBe(true);
    expect(original.data.item.properties.body).toBe("Body from B");
    expect(original.data.item.properties.priority).toBe("high");
  });
});
