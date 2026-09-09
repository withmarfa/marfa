/**
 * A key means something inside one space and nothing outside it.
 *
 * The record is keyed on `COALESCE(space_id, '')` plus the key, mirroring
 * `idx_items_source_dedup`, so two spaces choosing the same key are two
 * records. Without the COALESCE the null-space bucket would not dedupe at
 * all, and with a plain equality on a nullable column two spaces would
 * still be separate but every operator-key request would share one
 * keyspace with every other.
 *
 * The second case here is the one a reader should look for: a create
 * naming an id that exists in a space this caller cannot see is a genuine
 * collision, and no amount of idempotency machinery may turn it into a
 * success. Recording the 409 is right; softening it is not.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let keyA: string;
let keyB: string;
let spaceA: string;

beforeAll(async () => {
  // `hosted`: a space-bound credential is what makes the scoping
  // observable at all.
  ctx = await createTestContext({ authMode: "hosted" });
  const a = await ctx.storage.spaces!.create("idempotency-a");
  const b = await ctx.storage.spaces!.create("idempotency-b");
  spaceA = a.id;
  keyA = await spaceKey(a.id, "a");
  keyB = await spaceKey(b.id, "b");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function spaceKey(spaceId: string, label: string): Promise<string> {
  const res = await request(ctx.app, "POST", `/admin/spaces/${spaceId}/keys`, {
    key: ctx.adminKey,
    // The type grant is named rather than implied: a rank used to bypass the
    // permission maps and there is no rank now, so a key that names nothing
    // reaches nothing.
    body: { label, source: label, type_permissions: { "*": "write" } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

describe("the key is scoped to the space", () => {
  it("lets two spaces use one key for different writes", async () => {
    const shared = "the-same-key-in-both-spaces";
    const inA = await request(ctx.app, "POST", "/items", {
      key: keyA,
      headers: { "Idempotency-Key": shared },
      body: { type: "core.note", properties: { body: "space a" } },
    });
    expect(inA.status).toBe(201);

    const inB = await request(ctx.app, "POST", "/items", {
      key: keyB,
      headers: { "Idempotency-Key": shared },
      body: { type: "core.note", properties: { body: "space b" } },
    });
    // Not a reuse and not a replay: a different space is a different
    // record, so B's own write runs.
    expect(inB.status).toBe(201);
    const idA = ((await inA.json()) as { item: { id: string } }).item.id;
    const idB = ((await inB.json()) as { item: { id: string } }).item.id;
    expect(idA).not.toBe(idB);
    expect((await ctx.storage.items.get(idB))?.properties.body).toBe("space b");
  });
});

describe("the credential is in the digest too", () => {
  it("refuses one credential's key replayed by another in the same space", async () => {
    // **Two credentials in ONE space**, which is what makes this about the
    // credential. The scoping case above uses two spaces, and two spaces
    // are already separate records — so it would pass unchanged with the
    // credential removed from the digest entirely, and cannot be read as
    // evidence that it is there.
    //
    // Why it belongs in the digest: the key is scoped to the space, so two
    // credentials in one space share a keyspace, and without this one
    // could be handed a response body derived from a row the other may not
    // read.
    const first = await spaceKey(spaceA, "cred-one");
    const second = await spaceKey(spaceA, "cred-two");
    const k = `shared-${Date.now().toString(36)}`;
    const body = { type: "core.note", properties: { body: "one write" } };

    const a = await request(ctx.app, "POST", "/items", {
      key: first,
      headers: { "Idempotency-Key": k },
      body,
    });
    expect(a.status).toBe(201);

    // Same space, same key, same method, same path, same body — only the
    // credential differs.
    const b = await request(ctx.app, "POST", "/items", {
      key: second,
      headers: { "Idempotency-Key": k },
      body,
    });
    expect(b.status).toBe(422);
    expect(((await b.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_key_reused",
    );
  });
});

describe("a create naming another space's id", () => {
  it("stays a conflict, and the repeat replays that conflict", async () => {
    const id = "01a00000-0000-7000-8000-00000000c0de";
    const seeded = await request(ctx.app, "POST", "/items", {
      key: keyA,
      body: { id, type: "core.note", properties: { body: "space a's row" } },
    });
    expect(seeded.status).toBe(201);

    const k = "collides-across-spaces";
    const first = await request(ctx.app, "POST", "/items", {
      key: keyB,
      headers: { "Idempotency-Key": k },
      body: { id, type: "core.note", properties: { body: "space b's try" } },
    });
    expect(first.status).toBe(409);
    const firstText = await first.text();

    const second = await request(ctx.app, "POST", "/items", {
      key: keyB,
      headers: { "Idempotency-Key": k },
      body: { id, type: "core.note", properties: { body: "space b's try" } },
    });
    expect(second.status).toBe(409);
    expect(await second.text()).toBe(firstText);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");

    // And the row is still space A's, unchanged.
    const stored = await ctx.storage.items.get(id, spaceA);
    expect(stored?.properties.body).toBe("space a's row");
  });
});
