import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Item, ItemState } from "@withmarfa/shared";

/**
 * The bulk-action door matches what the read doors match.
 *
 * `GET /items` keeps platform-internal rows out of an ordinary query with two
 * gates. The state mask is the weaker one, because a caller names the state
 * and is answered on it: `revoked` is reachable only on a `system.*` type,
 * and a filter naming it is a filter that reaches those rows. The one that
 * does the work is the type-column exclusion, and `POST /items/bulk-actions`
 * never passed it.
 *
 * So a filter that named no type matched platform-internal rows, `dry_run`
 * enumerated their ids for a caller who never writes at all, and the actions
 * that are not bounded by something else acted on what it enumerated.
 *
 * **Two ways in and one flag closes both**, which is why the cases below drive
 * each separately. A caller can reach those rows through the structured
 * `state`, or name `state eq "revoked"` in the free-text grammar, which
 * recognizes `state` as a system field with no value allowlist. Narrowing the
 * type column rather than the state column is what makes one fix cover both,
 * and a fix that closed one and not the other would close nothing.
 *
 * Reserved namespaces are writable only by platform machinery. A
 * `system.folder` row witnesses that the public bulk door cannot write them.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A platform-owned row, seeded below the public reserved-namespace fence. */
function seedReserved(marker: string, state?: ItemState): Promise<Item> {
  return itemWrites(ctx.storage).create({
    writer: null,
    type: "system.folder",
    properties: { title: `ba-${marker}` },
    ...(state === undefined ? {} : { state }),
    tags: [marker],
    source: `bulk-action-seed-${marker}-${Math.random().toString(36).slice(2, 8)}`,
  });
}

async function seedPair(
  marker: string,
): Promise<{ noteId: string; reservedId: string }> {
  const note = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { body: `ba-${marker}` },
      tags: [marker],
    },
  });
  expect(note.status).toBe(201);
  const { item: n } = (await note.json()) as { item: { id: string } };
  const reserved = await seedReserved(marker);
  return { noteId: n.id, reservedId: reserved.id };
}

/** The ids a dry run reports for a filter, which is the enumeration itself. */
async function matchedIds(
  filter: Record<string, unknown>,
  key: string = ctx.workingKey,
): Promise<string[]> {
  const { initialStatus, result } = await runBulkActionAsync(
    ctx,
    { action: "update_tags", add: ["ba-probe"], filter, dry_run: true },
    key,
  );
  expect(initialStatus).toBe(200);
  return result?.ids ?? [];
}

describe("the bulk-action door and the read doors agree about system rows", () => {
  it("does not match a system row when the filter names no type", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    const { noteId, reservedId } = await seedPair(marker);

    const ids = await matchedIds({ tags: [marker] });

    // Asserting the absence alone would pass on a filter that matched
    // nothing at all, which is the shape this whole area keeps producing.
    // The note is what says the filter reached rows.
    expect(ids).toContain(noteId);
    expect(ids).not.toContain(reservedId);
  });

  it("does not match one through the free-text filter grammar either", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    const { reservedId } = await seedPair(marker);

    // The other way in. The free-text grammar compiles a comparison straight
    // through to SQL, so it reaches rows the structured filter fields never
    // name. One flag closes both, because it narrows the type column rather
    // than the state one, and a fix that closed one and not the other would
    // close nothing.
    const ids = await matchedIds({
      filter: `properties.url eq "https://example.test/ba-${marker}"`,
    });
    expect(ids).not.toContain(reservedId);
  });

  it("does not match a revoked reserved row through the state predicate", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    // Revoked at create, because the transition route's own enum is the
    // universal three states and cannot reach this one. `revoked` is the
    // state a platform-internal row actually sits in, and the predicate
    // below is the one the two gates were described in terms of, so a test
    // that drove any other comparison would be about a neighboring claim.
    const revoked = await seedReserved(`rev-${marker}`, "revoked");
    expect(revoked.state).toBe("revoked");
    // The tag the filters below select on: `seedReserved` tags with the
    // marker it was handed.
    const tag = `rev-${marker}`;

    // Both ways of naming the state, together. `state` is a recognized
    // system field in the filter grammar with no value allowlist, so the
    // free-text half compiles straight through to SQL; the structured half
    // is what suppresses the door's own default, which answers the active
    // state and would otherwise AND this query down to nothing and leave
    // the absence below true whatever the type gate did.
    const ids = await matchedIds({
      tags: [tag],
      state: "revoked",
      filter: 'state eq "revoked"',
    });
    expect(
      ids,
      "the bulk-action door matches a reserved row, so a dry run enumerates platform records and every unbounded action writes to them",
    ).not.toContain(revoked.id);

    // The same selection, through the store rather than the door, and
    // carrying the free-text half as well. Without it the case above is an
    // absence with no witness that either predicate reached a row, which is
    // the shape this whole area keeps producing: a grammar that compiled
    // bare `state` to something other than the column would empty the match
    // set and satisfy the assertion for the wrong reason.
    const reached = await ctx.storage.items.list({
      state: "revoked",
      tags: [tag],
      filter: 'state eq "revoked"',
    });
    expect(
      reached.data.map((i) => i.id),
      "the seeded revoked row is not selectable by the two predicates the door was handed, so the door's refusal above proves nothing",
    ).toContain(revoked.id);
  });

  it("refuses the opt-in to a credential the fence does not admit", async () => {
    // This door runs no per-row `requireTypeAccess`, so a credential that
    // reaches the match query never meets the reserved-namespace fence that
    // guards `system.*` on every single-item write door. Gating only the
    // default and letting anyone widen by naming a type would therefore
    // publish a write path into the reserved namespace that
    // `PATCH /items/{id}` refuses to the same key.
    //
    // **The grant has to be `write`, and that is the whole reason this case
    // works.** It held `{"*": "read"}` until the filter started narrowing to
    // writable types, at which point the key matched *nothing at all* — so
    // the refusal below passed without the fence ever being reached, on a
    // query that returned zero rows. A write grant is what puts the fence
    // back in the path as the only thing standing between this key and a
    // reserved row.
    const raw = await mintWorkingKey(ctx, {
      label: "reads-everything",
      permissions: [],
      type_permissions: { "*": "write" },
    });

    const marker = Math.random().toString(36).slice(2, 8);
    const { noteId, reservedId } = await seedPair(marker);

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "update_tags",
        add: ["reader-probe"],
        filter: { type: "system.folder", tags: [marker] },
        dry_run: true,
      },
      raw,
    );
    expect(initialStatus).toBe(200);
    expect(result?.ids ?? []).not.toContain(reservedId);

    // Not vacuous, on the same credential: this key reaches the door and
    // matches an ordinary row, so the reserved row is absent because the
    // fence refused it rather than because the query found nothing. The
    // control has to run as *this* key — the runtime check below says
    // something about that credential and nothing about this one.
    const { result: ownReach } = await runBulkActionAsync(
      ctx,
      {
        action: "update_tags",
        add: ["reader-probe"],
        filter: { tags: [marker] },
        dry_run: true,
      },
      raw,
    );
    expect(ownReach?.ids ?? []).toContain(noteId);
  });
});

/**
 * The other half of "matches what a read matches": the state axis.
 *
 * `GET /items` documents what an omitted `state` means, and the bulk-action
 * filter did not — it declared a bare enum of the four states with no word
 * about the absent value. The device resolves that filter locally at enqueue
 * and the server resolves it again on replay, so two defaults that differed
 * would act on different sets, and neither the specification nor a test could
 * say whether they did.
 *
 * They agree, and the agreement is structural rather than a coincidence of two
 * literals: both doors hand `state` to the same item query and neither sets the
 * widening flag, so the store's own default applies to both. Pinned here so a
 * later change to either one has to answer for it.
 */
describe("the bulk-action door and the list read agree about an omitted state", () => {
  it("answers the active state on both doors when no state is named", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    const seed = async (
      label: string,
      state?: string,
    ): Promise<{ id: string }> => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          ...(state === undefined ? {} : { state }),
          properties: { body: `state-${label}-${marker}` },
          tags: [marker],
        },
      });
      expect(
        res.status,
        "the fixture cannot seed a row in this state, so every assertion below is about an empty set",
      ).toBe(201);
      return ((await res.json()) as { item: { id: string } }).item;
    };

    const live = await seed("live");
    // Both of the states a row can be put away in, because an omitted state
    // that answered one and hid the other would pass a case that named only
    // the bin.
    const archived = await seed("archived", "archived");
    const binned = await seed("binned", "trashed");

    // The bulk-action door, naming no state.
    const acted = await matchedIds({ tags: [marker] });
    expect(
      acted,
      "a bulk action naming no state stopped reaching live rows, so every unnarrowed action is now a no-op",
    ).toContain(live.id);
    expect(
      acted,
      "a bulk action naming no state reaches archived rows, so an unnarrowed write lands on rows the caller put away and cannot see in a listing",
    ).not.toContain(archived.id);
    expect(
      acted,
      "a bulk action naming no state reaches the bin, so an unnarrowed write resurrects deleted rows",
    ).not.toContain(binned.id);

    // The list read, same filter, same omission. Both halves asserted, so
    // this cannot pass on a pair that agree by both matching nothing.
    const list = await request(ctx.app, "GET", `/items?tags=${marker}`, {
      key: ctx.workingKey,
    });
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as { data: { id: string }[] }).data.map(
      (i) => i.id,
    );
    expect(
      listed,
      "a listing naming no state stopped answering live rows, so the default hides the corpus",
    ).toContain(live.id);
    expect(
      listed,
      "a listing naming no state answers archived rows, so the default is no longer the active state",
    ).not.toContain(archived.id);
    expect(
      listed,
      "a listing naming no state answers the bin, so a deleted row still reads as present",
    ).not.toContain(binned.id);

    // And the same ids come back on both doors, which is the property the
    // device's local resolve depends on.
    expect(
      acted.slice().sort(),
      "the two doors resolve an omitted state differently, so a filter enqueued locally acts on one set and replays against another",
    ).toEqual(listed.slice().sort());
  });
});
