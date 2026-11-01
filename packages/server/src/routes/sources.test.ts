/**
 * A source's name and mark: how the name is chosen, who may set them, who may
 * read them, and the count of items by source.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as clock from "../clock.js";
import type { TestContext } from "../test-utils.js";
import {
  cleanupTestContext,
  createTestContext,
  raceTheNextTransaction,
  request,
  seedOauthBearer,
  TEST_MANAGEMENT_PERMISSIONS,
} from "../test-utils.js";

let ctx: TestContext;

interface Source {
  source: string;
  name: string;
  name_from: string;
  mark?: string;
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

afterEach(() => {
  clock.resetClockForTests();
});

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function mint(
  body: Record<string, unknown>,
): Promise<{ key: string; id: string }> {
  const res = await ctx.ownerRequest("/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type_permissions: { "*": "write" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      permissions: [],
      default_tier: "library",
      ...body,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { key: string; id: string };
}

function query(source: string): string {
  return `?source=${encodeURIComponent(source)}`;
}

function getSource(key: string, source: string) {
  return request(ctx.app, "GET", `/source${query(source)}`, { key });
}

function patchSource(key: string, source: string, body: unknown) {
  return request(ctx.app, "PATCH", `/source${query(source)}`, { key, body });
}

function ownerPatch(source: string, body: unknown) {
  return ctx.ownerRequest(`/source${query(source)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function ownerGet(source: string): Promise<Source> {
  const res = await ctx.ownerRequest(`/source${query(source)}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Source;
}

async function createNote(key: string, extra: Record<string, unknown> = {}) {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body: "a note" }, ...extra },
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

describe("GET /items/stats?by=source", () => {
  it("counts items per source under a listing's filters", async () => {
    const aSource = unique("stats-a");
    const bSource = unique("stats-b");
    const a = await mint({ label: "Stats A", source: aSource });
    const b = await mint({ label: "Stats B", source: bSource });
    await createNote(a.key);
    await createNote(a.key);
    await createNote(b.key);
    const task = await request(ctx.app, "POST", "/items", {
      key: b.key,
      body: { type: "core.task", properties: { title: "a task" } },
    });
    expect(task.status, await task.clone().text()).toBe(201);

    const all = await request(ctx.app, "GET", "/items/stats?by=source", {
      key: ctx.workingKey,
    });
    expect(all.status).toBe(200);
    expect(await all.json()).toMatchObject({ [aSource]: 2, [bSource]: 2 });

    const notes = await request(
      ctx.app,
      "GET",
      "/items/stats?by=source&type=core.note",
      { key: ctx.workingKey },
    );
    const counts = (await notes.json()) as Record<string, number>;
    expect(counts[aSource]).toBe(2);
    expect(counts[bSource]).toBe(1);
  });
});

describe("a source's name", () => {
  it("is the name set on the source first", async () => {
    const source = unique("named");
    await mint({ label: "The key's label", source });
    expect((await ownerPatch(source, { name: "Set name" })).status).toBe(200);
    expect(await ownerGet(source)).toEqual({
      source,
      name: "Set name",
      name_from: "set",
    });
  });

  it("is the label of the live key whose own source it is, where none is set", async () => {
    const source = unique("labelled");
    await mint({ label: "Readwise sync", source });
    expect(await ownerGet(source)).toEqual({
      source,
      name: "Readwise sync",
      name_from: "key",
    });
  });

  it("is the app's sign-in name for the source an app writes under", async () => {
    const app = await seedOauthBearer(ctx, ["metadata:read"], {
      clientName: "Reading List",
    });
    const source = `oauth:${app.clientId}:${ctx.owner.id}`;
    expect(await ownerGet(source)).toEqual({
      source,
      name: "Reading List",
      name_from: "app",
    });
  });

  it("is the code where nothing names it", async () => {
    const source = unique("bare");
    expect(await ownerGet(source)).toEqual({
      source,
      name: source,
      name_from: "code",
    });
  });

  it("takes no label for a claimed source", async () => {
    const claimed = unique("claimed");
    const holder = await mint({
      label: "Claims it",
      source: unique("holder"),
      sources: [claimed],
    });
    const seen = await getSource(holder.key, claimed);
    expect(seen.status).toBe(200);
    expect(await seen.json()).toEqual({
      source: claimed,
      name: claimed,
      name_from: "code",
    });
  });

  it("keeps a set name when the source passes to a new key, and drops the old key's label", async () => {
    const source = unique("passing");
    const kept = unique("passing-kept");
    const expiresAt = new Date(clock.nowMs() + 60_000).toISOString();
    await mint({ label: "Old label", source, expires_at: expiresAt });
    await mint({ label: "Old label", source: kept, expires_at: expiresAt });
    expect((await ownerPatch(kept, { name: "Kept name" })).status).toBe(200);
    expect((await ownerGet(source)).name).toBe("Old label");

    clock.advanceClock(120_000);
    expect(await ownerGet(source)).toMatchObject({
      name: source,
      name_from: "code",
    });
    await mint({ label: "New label", source });
    await mint({ label: "New label", source: kept });
    expect(await ownerGet(source)).toMatchObject({
      name: "New label",
      name_from: "key",
    });
    expect(await ownerGet(kept)).toMatchObject({
      name: "Kept name",
      name_from: "set",
    });
  });
});

describe("setting a source's name and mark", () => {
  it("lets a key set its own source and a source it claims", async () => {
    const own = unique("own");
    const claimed = unique("claimed-set");
    const key = await mint({
      label: "Setter",
      source: own,
      sources: [claimed],
    });

    const setOwn = await patchSource(key.key, own, {
      name: "  My connector  ",
      mark: "simple-icons:github",
    });
    expect(setOwn.status, await setOwn.clone().text()).toBe(200);
    expect(await setOwn.json()).toEqual({
      source: own,
      name: "My connector",
      name_from: "set",
      mark: "simple-icons:github",
    });

    const setClaimed = await patchSource(key.key, claimed, { name: "Claimed" });
    expect(setClaimed.status).toBe(200);
    expect(await setClaimed.json()).toEqual({
      source: claimed,
      name: "Claimed",
      name_from: "set",
    });

    // A field left out keeps its value.
    const markOnly = await patchSource(key.key, own, { mark: "lucide:box" });
    expect(await markOnly.json()).toMatchObject({
      name: "My connector",
      mark: "lucide:box",
    });
  });

  it("refuses another source to a key without keys.manage, and allows it with it", async () => {
    const other = unique("other");
    const plain = await mint({ label: "Plain", source: unique("plain") });
    const refused = await patchSource(plain.key, other, { name: "Nope" });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as {
      error: { code: string; details?: { required_scope?: string } };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details?.required_scope).toBe("keys.manage");
    expect(await ctx.storage.sources.get(other)).toBeNull();

    const manager = await mint({
      label: "Manager",
      source: unique("manager"),
      permissions: TEST_MANAGEMENT_PERMISSIONS,
    });
    const allowed = await patchSource(manager.key, other, { name: "Named" });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect((await ctx.storage.sources.get(other))?.name).toBe("Named");
  });

  it("judges a claim in the transaction that writes, so a claim removed just before it sets nothing", async () => {
    const claimed = unique("claim-race");
    const key = await mint({
      label: "Claim race",
      source: unique("claim-race-own"),
      sources: [claimed],
    });
    const race = raceTheNextTransaction(ctx.storage, async () => {
      const res = await ctx.ownerRequest(`/keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: [] }),
      });
      expect(res.status).toBe(200);
    });
    try {
      const res = await patchSource(key.key, claimed, { name: "Too late" });
      expect(race.fired()).toBe(true);
      expect(res.status, await res.clone().text()).toBe(403);
    } finally {
      race.restore();
    }
    expect(await ctx.storage.sources.get(claimed)).toBeNull();
  });

  it("judges keys.manage in the transaction that writes, so a permission removed just before it sets nothing", async () => {
    const other = unique("manage-race");
    const manager = await mint({
      label: "Manage race",
      source: unique("manage-race-own"),
      permissions: TEST_MANAGEMENT_PERMISSIONS,
    });
    const race = raceTheNextTransaction(ctx.storage, async () => {
      const res = await ctx.ownerRequest(`/keys/${manager.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: [] }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    });
    try {
      const res = await patchSource(manager.key, other, { name: "Too late" });
      expect(race.fired()).toBe(true);
      expect(res.status, await res.clone().text()).toBe(403);
    } finally {
      race.restore();
    }
    expect(await ctx.storage.sources.get(other)).toBeNull();
  });

  it("measures a name as a sign-in's name is measured, so a name export would refuse is refused", async () => {
    const source = unique("emoji-name");
    const res = await ownerPatch(source, { name: "😀".repeat(150) });
    expect(res.status, await res.clone().text()).toBe(400);
    expect(await ctx.storage.sources.get(source)).toBeNull();
    const fits = await ownerPatch(source, { name: "😀".repeat(100) });
    expect(fits.status).toBe(200);
  });

  it("refuses a mark that is no icon ID with the type icon's error", async () => {
    const source = unique("bad-mark");
    for (const mark of ["star", "lucide:", "nosuchset:github"]) {
      const res = await ownerPatch(source, { mark });
      expect(res.status, mark).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: { errors?: unknown[] } };
      };
      expect(body.error.code).toBe("invalid_schema");
      expect(body.error.details?.errors).toHaveLength(1);
    }
    expect(await ctx.storage.sources.get(source)).toBeNull();
  });

  it("refuses a name a sign-in could not hold", async () => {
    const source = unique("bad-name");
    for (const name of ["", "   ", "a‮b", "x".repeat(201)]) {
      const res = await ownerPatch(source, { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
    expect(await ctx.storage.sources.get(source)).toBeNull();
  });

  it("removes the row when both name and mark are cleared", async () => {
    const source = unique("cleared");
    await ownerPatch(source, { name: "Named", mark: "lucide:box" });
    expect(await ctx.storage.sources.get(source)).not.toBeNull();
    await ownerPatch(source, { name: null });
    expect(await ctx.storage.sources.get(source)).toMatchObject({
      name: null,
      mark: "lucide:box",
    });
    const cleared = await ownerPatch(source, { mark: null });
    expect(await cleared.json()).toEqual({
      source,
      name: source,
      name_from: "code",
    });
    expect(await ctx.storage.sources.get(source)).toBeNull();
  });
});

describe("reading sources", () => {
  it("answers a credential no source it cannot see", async () => {
    const hidden = unique("hidden");
    const writer = await mint({ label: "Hidden writer", source: hidden });
    await createNote(writer.key);
    await ownerPatch(hidden, { name: "Hidden name" });

    // A key that reads no type sees only its own source.
    const own = unique("blind");
    const blind = await mint({
      label: "Blind",
      source: own,
      type_permissions: {},
    });
    const refused = await getSource(blind.key, hidden);
    expect(refused.status).toBe(404);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("source_not_found");
    const listed = await request(ctx.app, "GET", "/sources", {
      key: blind.key,
    });
    expect(listed.status).toBe(200);
    const codes = ((await listed.json()) as { data: Source[] }).data.map(
      (s) => s.source,
    );
    expect(codes).toEqual([own]);

    // The witness: a key that reads the note's type sees its source.
    const reader = await mint({ label: "Reader", source: unique("reader") });
    const seen = await getSource(reader.key, hidden);
    expect(seen.status).toBe(200);
    expect(await seen.json()).toMatchObject({ name: "Hidden name" });
    const readerList = (await (
      await request(ctx.app, "GET", "/sources", { key: reader.key })
    ).json()) as { data: Source[] };
    expect(readerList.data.map((s) => s.source)).toContain(hidden);
  });

  it("lists every source in use or named to the owner", async () => {
    const named = unique("named-only");
    await ownerPatch(named, { mark: "lucide:box" });
    const res = await ctx.ownerRequest("/sources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Source[];
      next_cursor: null;
    };
    expect(body.next_cursor).toBeNull();
    expect(body.data).toContainEqual({
      source: named,
      name: named,
      name_from: "code",
      mark: "lucide:box",
    });
    const codes = body.data.map((s) => s.source);
    expect(codes).toEqual([...codes].sort());
  });

  it("lists to a keys.manage credential with no type grants a source whose key is revoked and whose items remain, as GET /source answers it", async () => {
    const orphan = unique("orphan");
    const writer = await mint({ label: "Orphan writer", source: orphan });
    await createNote(writer.key);
    const revoked = await ctx.ownerRequest(`/keys/${writer.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    const manager = await mint({
      label: "Blind manager",
      source: unique("blind-manager"),
      type_permissions: {},
      permissions: TEST_MANAGEMENT_PERMISSIONS,
    });
    const single = await getSource(manager.key, orphan);
    expect(single.status).toBe(200);
    const listed = (await (
      await request(ctx.app, "GET", "/sources", { key: manager.key })
    ).json()) as { data: Source[] };
    expect(listed.data.map((s) => s.source)).toContain(orphan);
    // The witness: a key that holds no management permission and reads no
    // type is not shown it.
    const plain = await mint({
      label: "Blind plain",
      source: unique("blind-plain"),
      type_permissions: {},
    });
    expect((await getSource(plain.key, orphan)).status).toBe(404);
  });

  it("lists a source claimed by a live key that holds no items to a keys.manage credential", async () => {
    const claimed = unique("claimed-listed");
    await mint({
      label: "Claimer",
      source: unique("claimer"),
      sources: [claimed],
    });
    const manager = await mint({
      label: "Claim manager",
      source: unique("claim-manager"),
      type_permissions: {},
      permissions: TEST_MANAGEMENT_PERMISSIONS,
    });
    const listed = (await (
      await request(ctx.app, "GET", "/sources", { key: manager.key })
    ).json()) as { data: Source[] };
    expect(listed.data.map((s) => s.source)).toContain(claimed);
    expect((await getSource(manager.key, claimed)).status).toBe(200);
  });

  it("holds a source whose name is __proto__ in the counts and the visibility of its items", async () => {
    const odd = "__proto__";
    const writer = await mint({ label: "Proto writer", source: odd });
    await createNote(writer.key);
    const stats = await ctx.ownerRequest("/items/stats?by=source");
    const counts = (await stats.json()) as Record<string, number>;
    expect(Object.hasOwn(counts, odd)).toBe(true);
    expect(counts[odd]).toBe(1);
    const reader = await mint({ label: "Proto reader", source: unique("pr") });
    expect((await getSource(reader.key, odd)).status).toBe(200);
    // By type and by state share the accumulator; neither name can be held
    // by a type or a state, so the witness is the count itself.
    const byState = (await (
      await ctx.ownerRequest("/items/stats?by=state")
    ).json()) as Record<string, number>;
    expect(Object.getPrototypeOf(byState)).toBe(Object.prototype);
    expect(byState.active).toBeGreaterThan(0);
  });

  it("takes a code as long as a restore can make one, and refuses one longer", async () => {
    const longest = `restored:oauth:${"c".repeat(194)}`;
    expect(longest).toHaveLength(209);
    expect((await ownerPatch(longest, { name: "Long" })).status).toBe(200);
    expect(await ownerGet(longest)).toMatchObject({ source: longest });
    const tooLong = `${longest}x`;
    expect((await ownerPatch(tooLong, { name: "Longer" })).status).toBe(400);
  });

  it("refuses a source code with a space at either end", async () => {
    const res = await ctx.ownerRequest(`/source${query(" padded")}`);
    expect(res.status).toBe(400);
  });

  it("carries a code a path could not, such as .. or one holding a slash", async () => {
    for (const source of ["..", "a/b"]) {
      expect((await ownerPatch(source, { name: "Odd" })).status).toBe(200);
      expect(await ownerGet(source)).toMatchObject({ source, name: "Odd" });
    }
  });
});
