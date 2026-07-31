/**
 * A quota holds under concurrency.
 *
 * The check used to precede the write and nothing joined them, so a count
 * read by one writer did not include a write another had already been
 * admitted for. N writers at `limit - 1` each saw room, each wrote, and the
 * space settled at `limit + N - 1`.
 *
 * `reserveQuota` closes it by taking a `(space, resource)` lock on the
 * transaction the write commits in, so the count a writer reads already
 * includes every write admitted ahead of it. That is the property under test
 * here, and it can only be tested by running the writes at once — a
 * sequential test passes against the broken code, which is why the defect
 * survived.
 *
 * The exposure was never unbounded: overshoot was limited by in-flight
 * concurrency. `storage_bytes` is the one that made it worth fixing, being
 * unbounded disk rather than a row count.
 *
 * **If these time out rather than fail, suspect the lock's connection.** A
 * lock that holds a pool connection of its own while the request holds one
 * deadlocks once enough writers each wait for a second slot, and eight
 * concurrent writers against the test pool reach that immediately. The lock
 * has to ride the write's transaction; see `CoordinationStore`.
 */
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Postgres only, and the reason is the same reason the fix is shaped the way
 * it is. SQLite admits one writer at a time, so the interleaving this guards
 * cannot occur there — and the in-memory test database does not merely pass,
 * it fails every genuinely concurrent request with SQLITE_BUSY, which would
 * make the results say nothing about the quota.
 */
const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";

let ctx: TestContext;

/**
 * Lock keys taken since the last reset. Two of the properties below are about
 * which locks are taken rather than about the outcome of a write, and a
 * status code cannot distinguish them: a space serialised against a ceiling
 * it does not have still returns 201, just slower. Timing would be the other
 * way to read it and would be flaky on a loaded machine.
 */
let lockKeys: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
  const coordination = ctx.storage.coordination;
  const real = coordination.lockInTransaction.bind(coordination);
  coordination.lockInTransaction = (name: string): Promise<void> => {
    lockKeys.push(name);
    return real(name);
  };
});

beforeEach(() => {
  lockKeys = [];
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A space with an items ceiling, and a member key inside it. */
async function spaceWithItemLimit(
  limit: number,
): Promise<{ spaceId: string; key: string }> {
  const space = await ctx.storage.spaces!.create(
    `quota-${Math.random().toString(36).slice(2, 8)}`,
  );
  const quotaRes = await request(ctx.app, "PUT", `/spaces/${space.id}/quotas`, {
    key: ctx.adminKey,
    body: { items_limit: limit },
  });
  expect(quotaRes.status).toBeLessThan(400);

  const suffix = Math.random().toString(36).slice(2, 10);
  const keyRes = await request(
    ctx.app,
    "POST",
    `/admin/spaces/${space.id}/keys`,
    {
      key: ctx.adminKey,
      body: {
        label: `quota-${suffix}`,
        source: `quota-${suffix}`,
        role: "space_admin",
        default_tier: "library",
        type_permissions: { "*": "write" },
      },
    },
  );
  expect(keyRes.status).toBe(201);
  return {
    spaceId: space.id,
    key: ((await keyRes.json()) as { key: string }).key,
  };
}

function createNote(key: string, body: string): Promise<Response> {
  return request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body } },
  });
}

async function itemCount(spaceId: string): Promise<number> {
  return ctx.storage.spaceQuotas.count(spaceId, "items");
}

/**
 * The blob paths put bytes on disk before the reserving transaction, so a
 * refusal has something to clean up. Both dialects run these: the property is
 * about what is left behind, not about concurrency.
 */
describe("a refused blob upload leaves nothing on disk", () => {
  async function spaceWithBlobLimit(
    limit: number,
  ): Promise<{ spaceId: string; key: string }> {
    const t = await spaceWithItemLimit(500);
    const res = await request(ctx.app, "PUT", `/spaces/${t.spaceId}/quotas`, {
      key: ctx.adminKey,
      body: { items_limit: 500, blobs_limit: limit },
    });
    expect(res.status).toBeLessThan(400);
    return t;
  }

  /** Raw byte upload — `request()` sends JSON, and /blobs takes a body. */
  async function upload(key: string, body: string): Promise<Response> {
    return await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/octet-stream",
      },
      body: new TextEncoder().encode(body),
    });
  }

  it("REGRESSION: bytes written for a refused upload are removed again", async () => {
    const { key } = await spaceWithBlobLimit(1);
    expect((await upload(key, "first blob")).status).toBe(201);

    // Second upload is over the ceiling. Its bytes reached disk before the
    // reservation refused, and nothing sweeps an unregistered blob, so the
    // route has to undo its own put.
    const bytes = Buffer.from("refused blob");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const refused = await upload(key, "refused blob");
    expect(refused.status).toBe(429);
    expect(await ctx.blobBackend.exists(hash)).toBe(false);
  });

  it("REGRESSION: a refusal cannot delete bytes a concurrent upload committed", async () => {
    // Deduplication makes two spaces uploading identical bytes ordinary
    // rather than exotic, and a quota ceiling is the designed failure on
    // that path. The route decides what it may delete from an `exists()`
    // read taken before it writes, which answers "were these bytes here a
    // moment ago" and not "are these bytes mine". Unserialised, both
    // requests read false, both write, and the refused one deletes a blob
    // the other has already committed a row against.
    //
    // The per-hash lock is what makes that read authoritative, so the
    // outcome stops depending on the interleaving: whichever request gets
    // the lock first writes, and the second finds the bytes already there.
    // Either order leaves A holding a readable blob.
    //
    // The delay on the first write is a lower bound on overlap rather than a
    // deadline, so a loaded machine makes the unserialised failure more
    // likely to reproduce, never less. Both dialects: the lock is
    // in-process, and neither request opens a transaction until after it has
    // written.
    const shared = "bytes two spaces both want, at the same moment";
    const hash = `sha256:${createHash("sha256")
      .update(Buffer.from(shared))
      .digest("hex")}`;

    const a = await spaceWithBlobLimit(5);
    const b = await spaceWithBlobLimit(1);
    expect((await upload(b.key, "b fills its one slot")).status).toBe(201);

    const backend = ctx.blobBackend as unknown as {
      put: (h: string, d: Uint8Array, m: string) => Promise<unknown>;
    };
    const realPut = backend.put.bind(backend);
    let first = true;
    backend.put = async (h, d, m) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 100));
      }
      return realPut(h, d, m);
    };

    let aRes: Response;
    let bRes: Response;
    try {
      [bRes, aRes] = await Promise.all([
        upload(b.key, shared),
        upload(a.key, shared),
      ]);
    } finally {
      backend.put = realPut;
    }

    expect(bRes.status).toBe(429);
    expect(aRes.status).toBe(201);

    expect(await ctx.blobBackend.exists(hash)).toBe(true);
    const readBack = await request(ctx.app, "HEAD", `/blobs/${hash}`, {
      key: a.key,
    });
    expect(readBack.status).toBe(200);
  });

  it("leaves bytes alone when they were already registered by someone else", async () => {
    // Deduplication means a refused upload of bytes that already exist must
    // not delete them: they belong to whoever registered them first.
    const shared = "bytes two spaces both want";
    const hash = `sha256:${createHash("sha256")
      .update(Buffer.from(shared))
      .digest("hex")}`;

    const a = await spaceWithBlobLimit(5);
    expect((await upload(a.key, shared)).status).toBe(201);

    const b = await spaceWithBlobLimit(1);
    expect((await upload(b.key, "b fills its one slot")).status).toBe(201);
    expect((await upload(b.key, shared)).status).toBe(429);

    expect(await ctx.blobBackend.exists(hash)).toBe(true);
    const stillThere = await request(ctx.app, "HEAD", `/blobs/${hash}`, {
      key: a.key,
    });
    expect(stillThere.status).toBe(200);
  });
});

describe.skipIf(!isPg)("items quota under concurrency", () => {
  it("REGRESSION: simultaneous creates at the ceiling do not overshoot it", async () => {
    const limit = 5;
    const { spaceId, key } = await spaceWithItemLimit(limit);

    // Fill to one below the ceiling sequentially: this part was never in
    // doubt, and it sets up the state where the race bites.
    for (let i = 0; i < limit - 1; i++) {
      expect((await createNote(key, `seed ${String(i)}`)).status).toBe(201);
    }
    expect(await itemCount(spaceId)).toBe(limit - 1);

    // Now eight writers at once, with room for exactly one.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createNote(key, `race ${String(i)}`)),
    );
    const created = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 429).length;

    expect(created).toBe(1);
    expect(refused).toBe(7);
    // The count is the property, not the status distribution: a route that
    // returned 429 while still writing would pass the assertions above.
    expect(await itemCount(spaceId)).toBe(limit);
  });

  it("refuses every writer when the ceiling is already reached", async () => {
    const limit = 3;
    const { spaceId, key } = await spaceWithItemLimit(limit);
    for (let i = 0; i < limit; i++) {
      expect((await createNote(key, `seed ${String(i)}`)).status).toBe(201);
    }

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createNote(key, `over ${String(i)}`)),
    );
    expect(results.every((r) => r.status === 429)).toBe(true);
    expect(await itemCount(spaceId)).toBe(limit);
  });

  it("does not serialise writers in different spaces", async () => {
    // The lock is per space and per resource. One keyed on the resource
    // alone would still close the race, and would turn every space's writes
    // into one global queue to do it — a worse outcome than the overshoot,
    // and invisible in a response status.
    const a = await spaceWithItemLimit(50);
    const b = await spaceWithItemLimit(50);
    lockKeys = [];
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) =>
        createNote(a.key, `a${String(i)}`),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        createNote(b.key, `b${String(i)}`),
      ),
    ]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await itemCount(a.spaceId)).toBe(4);
    expect(await itemCount(b.spaceId)).toBe(4);

    // Eight writes, eight locks, and the two spaces never share a key.
    expect(lockKeys.length).toBe(8);
    expect(new Set(lockKeys)).toEqual(
      new Set([`quota:${a.spaceId}:items`, `quota:${b.spaceId}:items`]),
    );
  });

  it("leaves an unlimited space unlocked and unbounded", async () => {
    // No ceiling means no reservation and no lock: serialising writers
    // against a limit that does not exist is pure contention.
    const space = await ctx.storage.spaces!.create(
      `unl-${Math.random().toString(36).slice(2, 8)}`,
    );
    const suffix = Math.random().toString(36).slice(2, 10);
    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${space.id}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: `unl-${suffix}`,
          source: `unl-${suffix}`,
          role: "space_admin",
          default_tier: "library",
          type_permissions: { "*": "write" },
        },
      },
    );
    const key = ((await keyRes.json()) as { key: string }).key;

    lockKeys = [];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createNote(key, `u${String(i)}`)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await itemCount(space.id)).toBe(10);
    expect(lockKeys).toEqual([]);
  });
});
