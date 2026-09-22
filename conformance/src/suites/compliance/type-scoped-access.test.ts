import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote, createBookmark } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "type-scoped-access",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Mint a scoped key with `type_permissions` and return a client bound to it.
 */
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

describe("type-scoped access control (type_permissions)", () => {
  it("note-write key can create and read notes but not bookmarks", async () => {
    const scoped = await createScopedClient("note-write-only", {
      "core.note": "write",
      "*": "none",
    });

    const note = await scoped.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const fetched = await scoped.getItem(note.data.item.id);
    expect(fetched.ok).toBe(true);

    const bookmark = await scoped.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.ok).toBe(false);
    expect(bookmark.status).toBe(403);
    expect(bookmark.error?.error.code).toBe("type_not_permitted");

    // A denied type is filtered out of a listing rather than refused.
    const list = await scoped.listItems({ type: "core.bookmark" });
    expect(list.ok).toBe(true);
    expect(list.data.data).toHaveLength(0);
  });

  it("mixed permissions: read notes, read+write bookmarks", async () => {
    const scoped = await createScopedClient("mixed-perms", {
      "core.note": "read",
      "core.bookmark": "write",
    });

    // Seed with the file's own credential so the scoped client has a note to
    // read.
    const adminNote = await client.createItem(
      createNote({ source: ctx.source }),
    );
    expect(adminNote.ok).toBe(true);
    trackItem(ctx, adminNote.data.item.id);

    const readNote = await scoped.getItem(adminNote.data.item.id);
    expect(readNote.ok).toBe(true);

    const writeNote = await scoped.createItem(
      createNote({ source: ctx.source }),
    );
    expect(writeNote.ok).toBe(false);
    expect(writeNote.status).toBe(403);
    expect(writeNote.error?.error.code).toBe("type_not_permitted");

    // `write` implies read.
    const bookmark = await scoped.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.ok).toBe(true);
    trackItem(ctx, bookmark.data.item.id);

    const readBookmark = await scoped.getItem(bookmark.data.item.id);
    expect(readBookmark.ok).toBe(true);
  });

  it("wildcard write grants full access to all types", async () => {
    const scoped = await createScopedClient("wildcard-write", {
      "*": "write",
    });

    const note = await scoped.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const bookmark = await scoped.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.ok).toBe(true);
    trackItem(ctx, bookmark.data.item.id);

    const list = await scoped.listItems({ limit: 1 });
    expect(list.ok).toBe(true);
  });

  it("wildcard read allows reading but not writing", async () => {
    const scoped = await createScopedClient("wildcard-read", {
      "*": "read",
    });

    const list = await scoped.listItems({ limit: 1 });
    expect(list.ok).toBe(true);

    const note = await scoped.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(false);
    expect(note.status).toBe(403);
    expect(note.error?.error.code).toBe("type_not_permitted");
  });

  it("unlisted types are implicitly denied (no wildcard)", async () => {
    const scoped = await createScopedClient("note-only-no-wildcard", {
      "core.note": "write",
    });

    const note = await scoped.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    // Bookmark is not listed — implicit none.
    const bookmark = await scoped.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.ok).toBe(false);
    expect(bookmark.status).toBe(403);
    expect(bookmark.error?.error.code).toBe("type_not_permitted");
  });

  it("namespace wildcard grants access to all types in the namespace", async () => {
    const scoped = await createScopedClient("core-wildcard", {
      "core.*": "read",
    });

    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const readNote = await scoped.getItem(note.data.item.id);
    expect(readNote.ok).toBe(true);

    const writeNote = await scoped.createItem(
      createNote({ source: ctx.source }),
    );
    expect(writeNote.ok).toBe(false);
    expect(writeNote.status).toBe(403);
    expect(writeNote.error?.error.code).toBe("type_not_permitted");
  });

  it("scoped key list filtering only returns permitted types", async () => {
    // Seed with the file's own credential, which holds both types.
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const bookmark = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.ok).toBe(true);
    trackItem(ctx, bookmark.data.item.id);

    const scoped = await createScopedClient("list-filter-test", {
      "core.note": "read",
      "*": "none",
    });

    const list = await scoped.listItems({ limit: 100, source: ctx.source });
    expect(list.ok).toBe(true);

    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(note.data.item.id);
    expect(ids).not.toContain(bookmark.data.item.id);
    for (const t of list.data.data.map((i) => i.type)) {
      expect(t).toBe("core.note");
    }
  });

  it("search results filtered by scoped permissions", async () => {
    const searchTerm = `scopedsearch${Date.now()}`;
    const note = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: searchTerm, body: "Search filter test" },
      }),
    );
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const bookmark = await client.createItem(
      createBookmark({
        source: ctx.source,
        properties: {
          url: "https://example.com",
          title: searchTerm,
          description: "Search filter test",
        },
      }),
    );
    expect(bookmark.ok).toBe(true);
    trackItem(ctx, bookmark.data.item.id);

    const scoped = await createScopedClient("search-filter-test", {
      "core.note": "read",
      "*": "none",
    });

    const results = await scoped.search(searchTerm);
    expect(results.ok).toBe(true);

    const ids = results.data.results.map((r) => r.item.id);
    expect(ids).toContain(note.data.item.id);
    expect(ids).not.toContain(bookmark.data.item.id);
    for (const r of results.data.results) {
      expect(r.item.type).toBe("core.note");
    }
  });

  it("a key holding every type passes every type-scoped check", async () => {
    // The file's own credential holds write on every type.
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const bookmark = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.ok).toBe(true);
    trackItem(ctx, bookmark.data.item.id);

    const list = await client.listItems({ limit: 1 });
    expect(list.ok).toBe(true);
  });

  it("rejects invalid permission values in key creation", async () => {
    const r = await client.createKey({
      label: "invalid-perm-value",
      source: `${ctx.source}-${"invalid-perm-value"}`,
      type_permissions: {
        "core.note": "superadmin",
      },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    // The code, not only the status. A client acts on the code, and a
    // status alone does not tell a body it can fix from a permission it
    // does not hold.
    expect(r.error?.error.code).toBe("validation_error");
    const errors = r.error?.error.details?.errors as
      { path: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("type_permissions.core.note");
  });
});
