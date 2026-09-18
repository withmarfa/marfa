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
 * `revoked` is still the lifecycle graph's business: the canonical graph
 * refuses it for `core.note`, and only a `system.*` type contains it. No
 * credential writes a `system.*` row over the wire, and the door narrows the
 * reserved namespace out of a match set unless the caller may write the type
 * it named, so the `revoked` leg asserts what the door accepts rather than
 * what it matches: the value is in the vocabulary, and a filter naming it is
 * answered rather than refused.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BulkActionFilterShape } from "../bulk-actions/types.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /items/bulk-actions — the filter reaches every state", () => {
  it("accepts revoked as a filter value", async () => {
    // The vocabulary first: the shape the door parses names all four states.
    const parsed = BulkActionFilterShape.parse({
      type: "system.activity",
      state: "revoked",
    });
    expect(parsed.state).toBe("revoked");

    // Then the door: a filter naming `revoked` is answered, not refused as
    // an unknown value. The match set is empty because the canonical graph
    // never lets a `core.note` reach that state, which is the lifecycle's
    // business and not the filter's.
    const { initialStatus, result, errorResponse } = await runBulkActionAsync(
      ctx,
      {
        action: "update_tags",
        add: ["probe"],
        dry_run: true,
        filter: { type: "core.note", state: "revoked" },
      },
      ctx.spaceKey,
    );
    expect(errorResponse).toBeUndefined();
    expect(initialStatus).toBe(200);
    expect(result?.ids).toEqual([]);
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
