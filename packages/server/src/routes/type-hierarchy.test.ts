import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * A subtree resolves through the registry, not only through the name.
 *
 * A type's identifier is a namespace and its `parent` is a declared lineage,
 * and registration has always allowed the two to disagree: `acme.annotated`
 * may name `core.note` as its parent and nothing requires the identifier to
 * start with `core.note.`. Every read and every permission check matched on the
 * name alone, so such a type was absent from a query against its own parent —
 * no error, just a short answer, on data that had been accepted as valid.
 *
 * The tests below pin both halves of the union. The declared half is the fix;
 * the namespace half is the thing the fix must not break, because plenty of
 * subtrees have no parent type to declare (nothing declares a parent of
 * `google`, yet `google.*` plainly means the Google types).
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/**
 * A child whose identifier sits outside its declared parent's namespace.
 *
 * The id is unique per registration because the type registry is a
 * process-level singleton: a second test registering the same identifier gets
 * `type_already_exists` from the first one's leftover.
 */
let childCounter = 0;
function crossNamespaceChild(): { id: string; [k: string]: unknown } {
  childCounter += 1;
  return {
    id: `user.annotated_note_${String(childCounter)}`,
    name: "Annotated note",
    description: "A note that declares core.note as its parent by name only.",
    parent: "core.note",
    version: 1,
    fields: {
      body: { type: "string", required: true, description: "The note body." },
      annotation: {
        type: "string",
        required: false,
        description: "The annotation.",
      },
    },
  };
}

async function registerChild(c: TestContext): Promise<string> {
  const schema = crossNamespaceChild();
  const res = await request(c.app, "POST", "/types", {
    key: c.adminKey,
    body: schema,
  });
  expect(
    res.status,
    `POST /types -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(201);
  return schema.id;
}

async function createNote(
  c: TestContext,
  type: string,
  body: string,
  key?: string,
): Promise<string> {
  const res = await request(c.app, "POST", "/items", {
    key: key ?? c.adminKey,
    body: { type, properties: { body } },
  });
  expect(
    res.status,
    `POST /items ${type} -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function listTypes(
  c: TestContext,
  query: string,
  key?: string,
): Promise<string[]> {
  const res = await request(c.app, "GET", `/items?${query}`, {
    key: key ?? c.adminKey,
  });
  expect(
    res.status,
    `GET /items?${query} -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(200);
  const body = (await res.json()) as { data: { type: string }[] };
  return body.data.map((i) => i.type);
}

describe("a subtree query reaches a child declared outside its namespace", () => {
  it("returns the cross-namespace child from a bare parent filter", async () => {
    ctx = await createTestContext();
    const child = await registerChild(ctx);
    await createNote(ctx, "core.note", "plain");
    await createNote(ctx, child, "annotated");

    // The assertion the whole change turns on. Before the fix this returned
    // only the `core.note` row, because `user.annotated_note` matches neither
    // `type = 'core.note'` nor `type LIKE 'core.note.%'`.
    const types = await listTypes(ctx, "type=core.note");
    expect(types).toContain(child);
    expect(types).toContain("core.note");
  });

  it("returns it from the explicit wildcard spelling too", async () => {
    ctx = await createTestContext();
    const child = await registerChild(ctx);
    await createNote(ctx, child, "annotated");

    // `core.note` and `core.note.*` have always meant the same thing on a read
    // filter, so a fix that closed only one spelling would put the two back
    // into disagreement.
    const types = await listTypes(ctx, "type=core.note.*");
    expect(types).toContain(child);
  });

  it("does not sweep in an unrelated type that merely declares nothing", async () => {
    ctx = await createTestContext();
    const child = await registerChild(ctx);
    await createNote(ctx, "core.note", "plain");
    await createNote(ctx, child, "annotated");
    await createNote(ctx, "core.bookmark", "https://example.test");

    // Widening a subtree must not turn into widening everything: the union adds
    // declared descendants, and nothing else.
    const types = await listTypes(ctx, "type=core.note");
    expect(types).not.toContain("core.bookmark");
  });

  it("still resolves a namespace with no parent type to declare", async () => {
    ctx = await createTestContext();
    // `core.entity.person` declares `core.entity` as its parent AND sits in its
    // namespace, so the two halves agree about it. What makes it the right
    // witness is `google.youtube.video`, which declares no parent at all: the
    // only thing that can return it from a `google.youtube` query is the name.
    await createNote(ctx, "core.note", "plain");
    const person = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.entity.person",
        properties: { name: "Ada Lovelace" },
      },
    });
    expect(
      person.status,
      `POST /items core.entity.person -> ${String(person.status)}: ${await person.clone().text()}`,
    ).toBe(201);

    // Resolving subtrees through declared parents alone would still return this
    // one, so it is not the discriminating case on its own — but it is the case
    // that would break if the union dropped the name clause for a type whose
    // parent chain happens to be shorter than its identifier.
    const byNamespace = await listTypes(ctx, "type=core.entity");
    expect(byNamespace).toContain("core.entity.person");
    expect(byNamespace).not.toContain("core.note");
  });
});

describe("a permission map still resolves names, and only names", () => {
  it("does not let a subtree grant reach a child declared from another namespace", async () => {
    ctx = await createTestContext();
    const child = await registerChild(ctx);
    await createNote(ctx, "core.note", "plain");
    await createNote(ctx, child, "annotated");
    await createNote(ctx, "core.bookmark", "https://example.test");

    // The read filter resolves declared parentage; a permission map does not.
    // Expanding grants through the registry is what put the list query and the
    // single-item gate into disagreement, in the direction that shows a row a
    // fetch would refuse — so a grant covers the namespace it names, and a
    // credential reaches this child only through a `user.*` grant of its own.
    const keyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "notes only",
        source: "test",
        // Named rather than omitted: an omitted list takes the creator's
        // whole set, and this credential is meant to be a narrow one.
        space_permissions: [],
        type_permissions: { "core.note.*": "read" },
      },
    });
    expect(
      keyRes.status,
      `POST /keys -> ${String(keyRes.status)}: ${await keyRes.clone().text()}`,
    ).toBe(201);
    const scoped = ((await keyRes.json()) as { key: string }).key;

    const types = await listTypes(ctx, "type=core.note", scoped);
    expect(types).toContain("core.note");
    expect(types).not.toContain(child);
    expect(types).not.toContain("core.bookmark");
  });

  it("keeps an exact grant exact", async () => {
    ctx = await createTestContext();
    const child = await registerChild(ctx);
    await createNote(ctx, "core.note", "plain");
    await createNote(ctx, child, "annotated");

    // A bare identifier in a permission map grants that type alone. Widening
    // it through the registry would hand a deliberately narrow credential a
    // subtree it was never given.
    const keyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "exact grant",
        source: "test",
        space_permissions: [],
        type_permissions: { "core.note": "read" },
      },
    });
    expect(keyRes.status).toBe(201);
    const scoped = ((await keyRes.json()) as { key: string }).key;

    const types = await listTypes(ctx, "", scoped);
    expect(types).toContain("core.note");
    expect(types).not.toContain(child);
  });
});
