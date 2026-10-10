import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemWrites } from "./item-writes.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { conflictedSiblingId } from "./conflict.js";
import { isValidId } from "@withmarfa/shared";

/**
 * A keep-both resolution that runs twice writes one sibling.
 *
 * Exercised against the store rather than the route on purpose. The replay
 * cache in front of `PATCH /items/:id` answers an ordinary repeat from its
 * record, so a route-level test would pass without the mechanism under test
 * existing at all. What this covers is the case the cache does not: a write
 * whose claim was released — a connection that died mid-flight, a retention
 * sweep — and whose retry therefore executes for real.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A note whose next stale write at `base` collides on `body`. */
async function collidingNote(seed: string): Promise<{
  id: string;
  base: number;
}> {
  const created = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: `${seed} original` },
  });
  const updated = await itemWrites(ctx.storage).update(created.id, {
    writer: null,
    properties: { body: `${seed} from the winner` },
    version: created.version,
    may_read_type: () => true,
  });
  expect("error" in updated).toBe(false);
  return { id: created.id, base: created.version };
}

/** Every keep-both sibling carrying `body`. */
async function siblingsHolding(body: string): Promise<string[]> {
  const listed = await ctx.storage.items.list({ limit: 200 });
  return listed.data
    .filter((item) => item.properties.body === body)
    .map((item) => item.id);
}

describe("a keep-both resolution that runs twice", () => {
  it("writes one sibling when the write carries an idempotency key", async () => {
    const { id, base } = await collidingNote("keyed");
    const losing = "keyed from the loser";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await itemWrites(ctx.storage).update(id, {
        writer: null,
        properties: { body: losing },
        version: base,
        may_read_type: () => true,
        conflict_mode: "auto",
        idempotency_key: "a-key-the-client-retried-under",
      });
      expect(
        "error" in result,
        `attempt ${String(attempt)} should have resolved, not refused`,
      ).toBe(false);
    }

    // One, not two. The second execution derives the same sibling id from
    // the same key and finds the row it is responsible for already there.
    expect(await siblingsHolding(losing)).toHaveLength(1);
  });

  it("writes two without one, which is what the key is for", async () => {
    const { id, base } = await collidingNote("unkeyed");
    const losing = "unkeyed from the loser";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await itemWrites(ctx.storage).update(id, {
        writer: null,
        properties: { body: losing },
        version: base,
        may_read_type: () => true,
        conflict_mode: "auto",
      });
    }

    // Not a defect: with no key the server cannot tell a retry from a second
    // edit, and inventing an answer would silently swallow a real one. Held
    // as a test so the limit is stated rather than discovered.
    expect(await siblingsHolding(losing)).toHaveLength(2);
  });
});

describe("the derived sibling id", () => {
  const base = {
    itemId: "01a06d6c-d155-7eec-8628-500b85ecb781",
    baseVersion: 3,
    idempotencyKey: "some-key",
  };

  it("is stable for one write and passes the id shape every door checks", () => {
    const id = conflictedSiblingId(base);
    expect(conflictedSiblingId(base)).toBe(id);
    expect(isValidId(id)).toBe(true);
  });

  it("separates two collisions on one item under a reused key", () => {
    // Without the base version in the key, a second, genuinely different
    // conflict under a reused key lands on the first sibling's id and is
    // swallowed by the same do-nothing that makes the retry safe.
    expect(conflictedSiblingId({ ...base, baseVersion: 4 })).not.toBe(
      conflictedSiblingId(base),
    );
  });

  it("separates two items and two keys", () => {
    expect(
      conflictedSiblingId({
        ...base,
        itemId: "01a06d6c-d155-7eec-8628-500b85ecb782",
      }),
    ).not.toBe(conflictedSiblingId(base));
    expect(
      conflictedSiblingId({ ...base, idempotencyKey: "another-key" }),
    ).not.toBe(conflictedSiblingId(base));
  });
});
