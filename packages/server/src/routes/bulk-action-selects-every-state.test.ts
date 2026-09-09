/**
 * The bulk-action filter can select every lifecycle state the platform has.
 *
 * The filter's `state` was an enum of three values written out by hand while
 * the platform has four, so the whole reserved namespace — whose types use a
 * bounded `active | revoked` lifecycle and nothing else — was outside what any
 * bulk operation could select on that axis. An operator clearing revoked rows
 * did it one at a time or not at all.
 *
 * Selecting rather than transitioning is the property under test. Reaching
 * `revoked` is still the lifecycle graph's business: `POST /items` admits it
 * for a `system.*` type because that type's graph contains it, and the
 * canonical graph still refuses it for `core.note`. This file asserts the
 * match set, which is what a filter is for.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const SYSTEM_TYPE = "system.device";

async function seedDevice(state: string, name: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: {
      type: SYSTEM_TYPE,
      state,
      properties: { name, kind: "laptop" },
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { item: { id: string; state: string } };
  expect(body.item.state).toBe(state);
  return body.item.id;
}

describe("POST /items/bulk-actions — the filter reaches every state", () => {
  it("selects revoked rows and only revoked rows", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const revoked = [
      await seedDevice("revoked", `revoked-a-${suffix}`),
      await seedDevice("revoked", `revoked-b-${suffix}`),
    ];
    // A live row of the same type, so the assertion is that the filter
    // narrowed rather than that it matched everything it could see.
    const active = await seedDevice("active", `active-${suffix}`);

    const { initialStatus, result, errorResponse } = await runBulkActionAsync(
      ctx,
      {
        // A dry run of a non-destructive action: the assertion is the
        // match set, so the action only has to be one the door accepts.
        action: "update_tags",
        add: ["probe"],
        dry_run: true,
        filter: { type: SYSTEM_TYPE, state: "revoked" },
      },
      ctx.spaceKey,
    );

    expect(errorResponse).toBeUndefined();
    expect(initialStatus).toBe(200);
    // By identity, not by count: a count still passes if the filter is
    // dropped and the whole type is matched at a coincidental size.
    const matched = (result?.ids ?? []).slice().sort();
    expect(matched).toEqual(revoked.slice().sort());
    expect(matched).not.toContain(active);
  });

  it("still selects each of the other three states", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const ids: Record<string, string> = {};
    for (const state of ["active", "archived", "trashed"]) {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "core.note",
          state,
          properties: { body: `note-${state}-${suffix}` },
          source_id: `note-${state}-${suffix}`,
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { item: { id: string } };
      ids[state] = body.item.id;
    }

    for (const state of ["active", "archived", "trashed"]) {
      const { initialStatus, result, errorResponse } = await runBulkActionAsync(
        ctx,
        {
          action: "update_tags",
          add: ["probe"],
          dry_run: true,
          filter: {
            type: "core.note",
            state,
            filter: `properties.body eq "note-${state}-${suffix}"`,
          },
        },
        ctx.spaceKey,
      );
      expect(errorResponse).toBeUndefined();
      expect(initialStatus).toBe(200);
      expect(result?.ids).toEqual([ids[state]]);
    }
  });
});

/**
 * The twin. `POST /items/bulk` writes items rather than selecting them, so
 * it is a different door — but it carried the same hand-written three-value
 * enum, and it sits beside `POST /items`, which admits `revoked` for a
 * `system.*` type because that type's graph contains it. One create door
 * consulted the lifecycle graph and the other refused before reaching it.
 */
describe("POST /items/bulk — the create door names the same states as its sibling", () => {
  it("creates a system item in revoked, as POST /items already does", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.spaceKey,
      body: {
        items: [
          {
            type: SYSTEM_TYPE,
            state: "revoked",
            properties: { name: `bulk-revoked-${suffix}`, kind: "laptop" },
            source_id: `bulk-revoked-${suffix}`,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { created: number; errored: number };
      results: { outcome: string; id?: string; error?: { message: string } }[];
    };
    expect(body.results[0]?.error?.message).toBeUndefined();
    expect(body.counts.errored).toBe(0);
    expect(body.counts.created).toBe(1);

    const id = body.results[0]?.id;
    expect(id).toBeDefined();
    const stored = await ctx.storage.items.get(id!);
    expect(stored?.state).toBe("revoked");
  });

  it("still refuses revoked for a type whose lifecycle does not contain it", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.spaceKey,
      body: {
        items: [
          {
            type: "core.note",
            state: "revoked",
            properties: { body: `bulk-note-${suffix}` },
            source_id: `bulk-note-${suffix}`,
          },
        ],
      },
    });
    // The door is atomic by default, so the refused entry rolls the whole
    // page back rather than erroring in place.
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { message?: string } };
    };
    expect(body.error.code).toBe("bulk_atomic_rollback");
    // Names the transition rather than repeating the state back, so the
    // refusal is the lifecycle graph's and not a membership test — which
    // would have passed `revoked` as a member of the universal list.
    expect(body.error.details?.message).toContain('"active" to "revoked"');
  });
});
