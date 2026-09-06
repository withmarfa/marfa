import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

/**
 * The bulk-action door matches what the read doors match.
 *
 * `GET /items` keeps platform-internal rows out of an ordinary query with two
 * gates. The default state mask is the weaker one: it excludes only `trashed`,
 * so a `revoked` row passes it, and `revoked` is reachable only on a `system.*`
 * type. The one that does the work is the type-column exclusion, and
 * `POST /items/bulk-actions` never passed it.
 *
 * So a filter that named no type matched platform-internal rows, `dry_run`
 * enumerated their ids for a caller who never writes at all, and the actions
 * that are not bounded by something else acted on what it enumerated.
 *
 * **Two ways in and one flag closes both**, which is why the cases below drive
 * each separately. A caller can omit `state` and let the default mask keep
 * revoked rows, or name `state eq "revoked"` in the free-text grammar, which
 * recognizes `state` as a system field with no value allowlist. Narrowing the
 * type column rather than the state column is what makes one fix cover both,
 * and a fix that closed one and not the other would close nothing.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedPair(
  marker: string,
): Promise<{ noteId: string; deviceId: string }> {
  const note = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "core.note",
      properties: { body: `ba-${marker}` },
      tags: [marker],
    },
  });
  expect(note.status).toBe(201);
  const device = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "system.device",
      properties: { name: `ba-${marker}`, kind: "laptop" },
      tags: [marker],
    },
  });
  expect(device.status).toBe(201);
  const { item: n } = (await note.json()) as { item: { id: string } };
  const { item: d } = (await device.json()) as { item: { id: string } };
  return { noteId: n.id, deviceId: d.id };
}

/** The ids a dry run reports for a filter, which is the enumeration itself. */
async function matchedIds(filter: Record<string, unknown>): Promise<string[]> {
  const { initialStatus, result } = await runBulkActionAsync(
    ctx,
    { action: "update_tags", add: ["ba-probe"], filter, dry_run: true },
    ctx.adminKey,
  );
  expect(initialStatus).toBe(200);
  return result?.ids ?? [];
}

describe("the bulk-action door and the read doors agree about system rows", () => {
  it("does not match a system row when the filter names no type", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    const { noteId, deviceId } = await seedPair(marker);

    const ids = await matchedIds({ tags: [marker] });

    // Asserting the absence alone would pass on a filter that matched
    // nothing at all, which is the shape this whole area keeps producing.
    // The note is what says the filter reached rows.
    expect(ids).toContain(noteId);
    expect(ids).not.toContain(deviceId);
  });

  it("does not match one through the free-text filter grammar either", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    const { deviceId } = await seedPair(marker);

    // The other way in. The free-text grammar compiles a comparison straight
    // through to SQL, so it reaches rows the structured filter fields never
    // name. One flag closes both, because it narrows the type column rather
    // than the state one, and a fix that closed one and not the other would
    // close nothing.
    const ids = await matchedIds({
      filter: `properties.name eq "ba-${marker}"`,
    });
    expect(ids).not.toContain(deviceId);

    // Not vacuous: the same grammar, with the namespace named, finds it.
    const named = await matchedIds({
      type: "system.device",
      filter: `properties.name eq "ba-${marker}"`,
    });
    expect(named).toContain(deviceId);
  });

  it("does not match a revoked reserved row through the state predicate", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    // Revoked at create, because the transition route's own enum is the
    // universal three states and cannot reach this one. `revoked` is the
    // state a platform-internal row actually sits in, and the predicate
    // below is the one the two gates were described in terms of, so a test
    // that drove any other comparison would be about a neighbouring claim.
    const revoked = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.device",
        state: "revoked",
        properties: { name: `ba-rev-${marker}`, kind: "laptop" },
        tags: [marker],
      },
    });
    expect(revoked.status).toBe(201);
    const { item } = (await revoked.json()) as {
      item: { id: string; state: string };
    };
    expect(item.state).toBe("revoked");

    // `state` is a recognized system field in the filter grammar with no
    // value allowlist, so this compiles straight through and would otherwise
    // reach a row the structured `state` enum cannot name on this door.
    const ids = await matchedIds({
      tags: [marker],
      filter: 'state eq "revoked"',
    });
    expect(ids).not.toContain(item.id);

    const named = await matchedIds({
      tags: [marker],
      type: "system.device",
      filter: 'state eq "revoked"',
    });
    expect(named).toContain(item.id);
  });

  it("matches one when the filter names the namespace", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    const { deviceId } = await seedPair(marker);

    // The opt-in, and the reason the exclusion is not simply unconditional:
    // a caller naming `system.device` has said what it wants, and refusing
    // it would answer a different question. This is also the control that
    // says the two cases above fail for the right reason — if the door
    // excluded the namespace unconditionally they would pass anyway.
    const ids = await matchedIds({ type: "system.device", tags: [marker] });
    expect(ids).toContain(deviceId);
  });

  it("refuses the opt-in to a credential that is not platform", async () => {
    // The opt-in is a platform credential naming a reserved type, and this
    // is the half that is easy to leave out.
    //
    // This door runs no per-row `requireTypeAccess`, so a credential that
    // reaches the match query never meets the platform-credential fence that
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
    const raw = `marfa_k1_reader_${Math.random().toString(36).slice(2)}`;
    await ctx.storage.keys.create(
      {
        label: "reads-everything",
        source: `reader-${raw.slice(-6)}`,
        role: "member",
        type_permissions: { "*": "write" },
      },
      hashApiKey(raw, "test-salt"),
    );

    const marker = Math.random().toString(36).slice(2, 8);
    const { noteId, deviceId } = await seedPair(marker);

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "update_tags",
        add: ["reader-probe"],
        filter: { type: "system.device", tags: [marker] },
        dry_run: true,
      },
      raw,
    );
    expect(initialStatus).toBe(200);
    expect(result?.ids ?? []).not.toContain(deviceId);

    // Not vacuous, on the same credential: this key reaches the door and
    // matches an ordinary row, so the reserved row is absent because the
    // fence refused it rather than because the query found nothing. The
    // control has to run as *this* key — the platform check below says
    // something about the platform credential and nothing about this one.
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

    // And the platform credential naming the same reserved type finds it, so
    // the refusal is about the credential rather than about the filter.
    const asPlatform = await matchedIds({
      type: "system.device",
      tags: [marker],
    });
    expect(asPlatform).toContain(deviceId);
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
  it("excludes trashed rows on both doors when no state is named", async () => {
    const marker = Math.random().toString(36).slice(2, 8);
    const live = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: `state-${marker}` },
        tags: [marker],
      },
    });
    expect(live.status).toBe(201);
    const binned = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        state: "trashed",
        properties: { body: `state-binned-${marker}` },
        tags: [marker],
      },
    });
    expect(binned.status).toBe(201);
    const { item: liveItem } = (await live.json()) as { item: { id: string } };
    const { item: binnedItem } = (await binned.json()) as {
      item: { id: string };
    };

    // The bulk-action door, naming no state.
    const acted = await matchedIds({ tags: [marker] });
    expect(acted).toContain(liveItem.id);
    expect(acted).not.toContain(binnedItem.id);

    // The list read, same filter, same omission. Both halves asserted, so
    // this cannot pass on a pair that agree by both matching nothing.
    const list = await request(ctx.app, "GET", `/items?tags=${marker}`, {
      key: ctx.adminKey,
    });
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as { data: { id: string }[] }).data.map(
      (i) => i.id,
    );
    expect(listed).toContain(liveItem.id);
    expect(listed).not.toContain(binnedItem.id);

    // And the same two ids come back on both doors, which is the property the
    // device's local resolve depends on.
    expect(acted.slice().sort()).toEqual(listed.slice().sort());
  });
});
