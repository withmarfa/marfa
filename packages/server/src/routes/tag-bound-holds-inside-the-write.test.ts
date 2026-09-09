import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { MAX_TAGS_PER_ITEM } from "../tag-limits.js";

/**
 * The per-item tag bound, held where the tags are written rather than in
 * front of it.
 *
 * The doors project the resulting set and refuse before writing, which is the
 * refusal a caller wants. But that check reads in one transaction and writes
 * in another, so it bounds nothing under concurrency: two tag writes to one
 * item each read a set under the bound, each pass, and the merged result is
 * over it with nothing refused and nothing reported.
 *
 * Both stores now check inside the transaction that computes the merged set,
 * on the same read the write uses, and the Postgres store takes the row lock
 * its own `mutateExtension` already documents as load-bearing for exactly
 * this shape: "the extensions map is one JSON column, so a plain read-then-
 * write lets a concurrent writer commit in between and lose one of the two
 * updates." Tags are the same one JSON column.
 */

const dialect = process.env.DB_DIALECT ?? "sqlite";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createNote(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  const { item } = (await res.json()) as { item: { id: string } };
  return item.id;
}

function tags(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);
}

describe("the tag bound is enforced where the tags are written", () => {
  // The deterministic guard. It does not exercise the race at all, which is
  // the point: it fails on the unfixed store on every run and every dialect,
  // where the concurrency test below can pass by luck. Deleting this as
  // redundant to the expressive one leaves nothing that reliably reddens.
  it("refuses a merge whose result is over the bound, at the store", async () => {
    const id = await createNote("bound at the store, merge");
    const under = MAX_TAGS_PER_ITEM - 10;
    await ctx.storage.metadata.merge(id, tags("a", under));

    await expect(ctx.storage.metadata.merge(id, tags("b", 20))).rejects.toThrow(
      /tags per item/,
    );

    const after = await ctx.storage.metadata.get(id);
    expect(after.tags).toHaveLength(under);
  });

  it("refuses an addTags whose result is over the bound, at the store", async () => {
    const id = await createNote("bound at the store, addTags");
    const under = MAX_TAGS_PER_ITEM - 10;
    await ctx.storage.metadata.addTags(id, tags("a", under));

    await expect(
      ctx.storage.metadata.addTags(id, tags("b", 20)),
    ).rejects.toThrow(/tags per item/);

    const after = await ctx.storage.metadata.get(id);
    expect(after.tags).toHaveLength(under);
  });

  // The statement of intent, and the one that catches the lost update the
  // bound was only a symptom of.
  //
  // Both calls are well inside the bound, so neither can be refused for it.
  // What is asserted is that a call reporting success actually wrote: on the
  // unlocked Postgres store both transactions read the empty set, the second
  // overwrites the first, and one caller's tags are gone with a resolved
  // promise in hand. The row lock is what closes that, and this is what
  // observes it.
  //
  // **Postgres only, and not as a convenience.** The libsql driver holds one
  // connection, so two overlapping `db.transaction` calls interleave their
  // BEGIN and COMMIT on it and leave the session wedged — the next
  // transaction anywhere in the process fails on a savepoint. That is a
  // driver misuse rather than a race, so running it there would assert
  // nothing about the code and would poison every test after it. It is also
  // the defect's own boundary: SQLite admits one writer, which is why the
  // Postgres store needed a lock and the SQLite one did not.
  it.skipIf(dialect !== "pg")(
    "loses no tags when two writes reach one item at once",
    async () => {
      const id = await createNote("two writers, one item");
      const first = tags("first", 10);
      const second = tags("second", 10);

      // Promise.all rather than allSettled: both are well inside the bound,
      // so neither may be refused, and allSettled would absorb the reason a
      // rejection carried and report only a count.
      await Promise.all([
        ctx.storage.metadata.addTags(id, first),
        ctx.storage.metadata.addTags(id, second),
      ]);

      const survived = await ctx.storage.metadata.get(id);
      for (const tag of [...first, ...second]) {
        expect(survived.tags).toContain(tag);
      }
    },
  );

  // The bound itself, off by nothing. Every case above clears it by ten or
  // more, so flipping any of the four comparisons to `>=` would leave them
  // all green.
  it("accepts a set landing exactly on the bound", async () => {
    const id = await createNote("exactly at the bound");
    await ctx.storage.metadata.merge(id, tags("a", MAX_TAGS_PER_ITEM - 1));

    const at = await ctx.storage.metadata.addTags(id, ["one-more"]);
    expect(at.tags).toHaveLength(MAX_TAGS_PER_ITEM);

    await expect(ctx.storage.metadata.addTags(id, ["over"])).rejects.toThrow(
      /tags per item/,
    );
  });

  // A row can already be over the bound: rows were written through the bulk
  // doors before those consulted it, and `items.create` still writes tags
  // verbatim so an archive of such rows stays restorable. Refusing every write
  // to one would strand it — a merge carrying nothing, which changes nothing,
  // would answer 400 about a limit the caller never approached.
  it("leaves a row that is already over the bound writable", async () => {
    // Through `items.create`, the one writer that is deliberately unbounded,
    // which is now the only way such a row can come about — the same way an
    // archive restore produces one.
    const created = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "already over" },
      tags: tags("legacy", MAX_TAGS_PER_ITEM + 20),
    });
    const id = created.id;

    const unchanged = await ctx.storage.metadata.merge(id, undefined);
    expect(unchanged.tags.length).toBeGreaterThan(MAX_TAGS_PER_ITEM);

    // Adding to it is still refused, because that is an increase.
    await expect(
      ctx.storage.metadata.addTags(id, ["one-more"]),
    ).rejects.toThrow(/tags per item/);
  });

  // What a caller may send is a different bound and still the route's, because
  // the store cannot answer it: a hundred and one copies of one tag projects
  // to one and is inside the bound the store enforces.
  it("refuses a body carrying more tags than the bound", async () => {
    const id = await createNote("too many in one body");

    const res = await request(ctx.app, "POST", `/items/${id}/tags`, {
      key: ctx.spaceKey,
      body: { tags: tags("sent", MAX_TAGS_PER_ITEM + 1) },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(String(MAX_TAGS_PER_ITEM));

    const after = await ctx.storage.metadata.get(id);
    expect(after.tags).toHaveLength(0);
  });
});

/**
 * The doors that reach those writers, and the three that consulted the bound
 * at neither layer.
 *
 * The bulk create arm writes tags through `items.create`, which is also the
 * archive restore's writer and must stay unbounded — an archive is a faithful
 * record of rows written before this rule existed, so tightening the store
 * makes those unrestorable. The bound therefore belongs on the route, which is
 * where the single-item create already puts it.
 *
 * The bulk update arm writes through `set`, the wholesale replace, which had
 * no check of its own; it does now, so the bound holds wherever that writer is
 * reached rather than only at the doors that remember.
 *
 * The bulk action's `add` array is the third question — what a caller may
 * *send* — which the store cannot answer, because a hundred and one copies of
 * one tag projects to one.
 */
describe("the bulk doors bound the tags they write", () => {
  it("refuses a bulk create over the bound, and writes nothing", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.spaceKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "bulk create over the bound" },
            tags: tags("bulkcreate", MAX_TAGS_PER_ITEM + 1),
          },
        ],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(JSON.stringify(body)).toContain(String(MAX_TAGS_PER_ITEM));

    // Nothing landed. Keyed on a tag the refused entry carried, so a row
    // written in spite of the refusal is exactly what this finds.
    const after = await request(ctx.app, "GET", "/items?tags=bulkcreate-0", {
      key: ctx.spaceKey,
    });
    expect(after.status).toBe(200);
    const listed = (await after.json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(0);
  });

  it("refuses a bulk update over the bound, and leaves the row as it was", async () => {
    const id = await createNote("bulk update over the bound");
    await ctx.storage.metadata.set(id, ["kept"]);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.spaceKey,
      body: {
        items: [
          {
            id,
            type: "core.note",
            tags: tags("bulkupdate", MAX_TAGS_PER_ITEM + 1),
          },
        ],
      },
    });
    expect(res.status).toBe(400);

    const after = await ctx.storage.metadata.get(id);
    expect(after.tags).toEqual(["kept"]);
  });

  it("refuses a bulk action adding more tags than the bound", async () => {
    const id = await createNote("bulk action over the bound");
    await ctx.storage.metadata.set(id, ["selector"]);

    const res = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.spaceKey,
      body: {
        action: "update_tags",
        filter: { tags: ["selector"] },
        add: tags("bulkaction", MAX_TAGS_PER_ITEM + 1),
      },
    });
    // Refused at the door rather than queued: the store would reject the
    // write per row anyway, so accepting the request only defers a refusal
    // the caller then has to read out of a job's error list.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(String(MAX_TAGS_PER_ITEM));

    const after = await ctx.storage.metadata.get(id);
    expect(after.tags).toEqual(["selector"]);
  });
});
