import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

/**
 * `POST /items/bulk-actions` narrows on every axis a read narrows on.
 *
 * It is a filter-in door that writes: nothing arrives by id, and there is no
 * per-row permission check behind the match query, so whatever the query
 * admits is what the action rewrites. Two axes were missing from it, and both
 * failed in the same direction — the query was wider than the caller.
 *
 * **The permission level.** `getTypeFilter` compiled every *readable* pattern
 * into `allowed`, so a key holding read on a type reached this door with that
 * type in its match set and the action then wrote to it. Two comments in the
 * route already said the narrowing was to writable types, which is what made
 * it hard to see.
 *
 * **The space's own source filter.** The three read doors resolve it and this
 * one passed nothing, so a match set included rows every read hides. It is a
 * narrowing lever, so applying it to a door that writes is the safe reading
 * rather than a new policy.
 *
 * Every case pairs the row that must leave the match set with one that must
 * stay in it. Asserting the absence alone would pass on a filter that matched
 * nothing at all, which is the failure shape this whole route keeps producing.
 */

let ctx: TestContext;
let spaceId: string;

/** Writes on bookmarks, reads on notes — the shape T-1338 is about. */
let readerWriterKey: string;
/** A source the space's `source_filter` approves, and one it does not. */
let trustedKey: string;
let untrustedKey: string;

async function mintKey(
  label: string,
  source: string,
  typePermissions: Record<string, "read" | "write">,
  role: "instance_admin" | "space_admin" | "member",
): Promise<string> {
  const raw = `marfa_k1_axes_${Math.random().toString(36).slice(2, 12)}`;
  await ctx.storage.keys.create(
    {
      label,
      source,
      role,
      type_permissions: typePermissions,
      default_tier: "library",
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

async function seed(
  key: string,
  type: string,
  properties: Record<string, unknown>,
  marker: string,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type, properties, tags: [marker] },
  });
  expect(res.status).toBe(201);
  const { item } = (await res.json()) as { item: { id: string } };
  return item.id;
}

/** The ids a dry run reports, which is the match set itself. */
async function matchedIds(
  key: string,
  filter: Record<string, unknown>,
): Promise<string[]> {
  const { initialStatus, result } = await runBulkActionAsync(
    ctx,
    { action: "update_tags", add: ["axes-probe"], filter, dry_run: true },
    key,
  );
  expect(initialStatus).toBe(200);
  return result?.ids ?? [];
}

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
  const space = await ctx.storage.spaces!.create("bulk-action-axes");
  spaceId = space.id;

  readerWriterKey = await mintKey(
    "reads-notes-writes-bookmarks",
    "reader-writer",
    { "core.note": "read", "core.bookmark": "write" },
    "member",
  );
  trustedKey = await mintKey("trusted", "trusted", {}, "space_admin");
  untrustedKey = await mintKey("untrusted", "untrusted", {}, "space_admin");

  await ctx.storage.spaces!.updateConfig(spaceId, {
    enforcement: {
      source_filter: { types: ["core.note"], sources: ["trusted"] },
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("the match set narrows to what the caller may write", () => {
  it("drops a type the caller may only read, and keeps one it may write", async () => {
    const marker = `lvl${Math.random().toString(36).slice(2, 8)}`;
    // Seeded by a trusted credential so the source filter admits the note;
    // this case is about the permission level and nothing else.
    const noteId = await seed(
      trustedKey,
      "core.note",
      { body: "readable" },
      marker,
    );
    const bookmarkId = await seed(
      readerWriterKey,
      "core.bookmark",
      { title: "writable" },
      marker,
    );

    const ids = await matchedIds(readerWriterKey, { tags: [marker] });

    expect(ids).toContain(bookmarkId);
    expect(ids).not.toContain(noteId);
  });

  it("still lets that credential read the row it may not act on", async () => {
    const marker = `rd${Math.random().toString(36).slice(2, 8)}`;
    const noteId = await seed(
      trustedKey,
      "core.note",
      { body: "readable" },
      marker,
    );

    // The control that says the case above fails for the right reason. A read
    // grant is unchanged by this: the row is visible, it is only unreachable
    // by an action. Narrowing `getTypeFilter` unconditionally would break
    // every list read and pass the previous case anyway.
    const res = await request(ctx.app, "GET", `/items?tags=${marker}`, {
      key: readerWriterKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((i) => i.id)).toContain(noteId);
  });

  it("refuses the same row through the single-item door", async () => {
    const marker = `pt${Math.random().toString(36).slice(2, 8)}`;
    const noteId = await seed(
      trustedKey,
      "core.note",
      { body: "readable" },
      marker,
    );

    // The parity claim, and the reason the narrowing is a defect rather than
    // a design choice: the two doors now answer the same question the same
    // way. `PATCH` refuses because it runs `requireTypeAccess`; the bulk door
    // has no equivalent per-row check, so its filter has to carry it.
    const patched = await request(ctx.app, "PATCH", `/items/${noteId}`, {
      key: readerWriterKey,
      body: { properties: { body: "rewritten" } },
    });
    expect(patched.status).toBe(403);
  });

  it("leaves an admin caller's reach unchanged", async () => {
    const marker = `ad${Math.random().toString(36).slice(2, 8)}`;
    const noteId = await seed(
      trustedKey,
      "core.note",
      { body: "admin-reachable" },
      marker,
    );

    // `space_admin` bypasses the permission maps entirely, so the level this
    // door now asks for changes nothing for it. Without this case the fix
    // could have narrowed every caller and still passed.
    const ids = await matchedIds(trustedKey, { tags: [marker] });
    expect(ids).toContain(noteId);
  });
});

describe("the match set narrows on the space's source filter", () => {
  it("drops a listed-type row from an unapproved source", async () => {
    const marker = `sf${Math.random().toString(36).slice(2, 8)}`;
    const trustedNote = await seed(
      trustedKey,
      "core.note",
      { body: "trusted" },
      marker,
    );
    const untrustedNote = await seed(
      untrustedKey,
      "core.note",
      { body: "untrusted" },
      marker,
    );

    const ids = await matchedIds(trustedKey, { tags: [marker] });

    expect(ids).toContain(trustedNote);
    expect(ids).not.toContain(untrustedNote);
  });

  it("keeps an unlisted type from the same unapproved source", async () => {
    const marker = `un${Math.random().toString(36).slice(2, 8)}`;
    const bookmark = await seed(
      untrustedKey,
      "core.bookmark",
      { title: "unlisted" },
      marker,
    );

    // The lever is per-type, decided from the row's own type. A fix that
    // narrowed the whole match set to approved sources would pass the case
    // above and be wrong here.
    const ids = await matchedIds(trustedKey, { tags: [marker] });
    expect(ids).toContain(bookmark);
  });

  it("narrows a filter phrased on some other axis too", async () => {
    const marker = `ax${Math.random().toString(36).slice(2, 8)}`;
    const untrustedNote = await seed(
      untrustedKey,
      "core.note",
      { body: `axis-${marker}` },
      marker,
    );

    // Keying the lever off the request's own `type` would make it optional
    // from the caller's side, which is the failure the read doors already
    // carry a suite about. The free-text grammar compiles straight through
    // to SQL and names no type at all.
    const ids = await matchedIds(trustedKey, {
      filter: `properties.body eq "axis-${marker}"`,
    });
    expect(ids).not.toContain(untrustedNote);

    // Not vacuous: the same row reaches the door for a caller the filter
    // approves, so the absence above is the lever rather than a query that
    // found nothing.
    const trustedNote = await seed(
      trustedKey,
      "core.note",
      { body: `axis-ok-${marker}` },
      marker,
    );
    const found = await matchedIds(trustedKey, {
      filter: `properties.body eq "axis-ok-${marker}"`,
    });
    expect(found).toContain(trustedNote);
  });
});
