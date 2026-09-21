/**
 * The orphan report stands between an unreferenced blob and its deletion:
 * one run reports, and a later run purges what is still unreferenced once
 * the grace has passed since the report. What counts as a reference is
 * asserted here too: an item in any lifecycle state, a metadata extension,
 * a version snapshot.
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BlobOrphanReporter } from "./blob-orphans.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const GRACE_MS = 3_600_000;

/** A clock the test moves by hand, starting now. */
function clock() {
  let now = Date.now();
  return {
    nowFn: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Register through the real upload door, so the row carries whatever the
 *  store actually writes rather than what the test chose. */
async function upload(c: TestContext, content: string): Promise<string> {
  const res = await c.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.workingKey}`,
      "Content-Type": "application/octet-stream",
    },
    body: new TextEncoder().encode(content),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { hash: string }).hash;
}

/** Two runs a millisecond apart under a grace of zero: a report, then the
 *  purge of what the report named. */
async function reportThenPurge(c: TestContext): Promise<void> {
  const time = clock();
  const reporter = new BlobOrphanReporter(c.storage, c.blobs, 0, time.nowFn);
  await reporter.runOnce();
  time.advance(1);
  await reporter.runOnce();
}

describe("BlobOrphanReporter.runOnce", () => {
  it("reports an unreferenced blob, keeps it through the grace, and purges it after", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "no item will ever point at this");
    const referenced = await upload(ctx, "an item points at this");
    const itemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "see attached", attachment: referenced },
      },
    });
    expect(itemRes.status).toBe(201);

    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      GRACE_MS,
      time.nowFn,
    );
    // The first run reports and purges nothing: the report is what a
    // person reads before anything goes.
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    const report = await ctx.storage.blobs.listOrphans();
    expect(report.map((row) => row.hash)).toEqual([orphan]);
    expect(report[0]?.reported_at).toBe(time.nowFn().toISOString());
    expect(await ctx.storage.blobs.get(orphan)).not.toBeNull();

    // Inside the grace: still reported, still there.
    time.advance(GRACE_MS - 1);
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    expect(await ctx.blobs.disk.has(orphan)).not.toBeNull();

    // Past it: gone from every store, the log and the registry.
    time.advance(2);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 1 });
    expect(await ctx.storage.blobs.get(orphan)).toBeNull();
    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    expect(await ctx.storage.blobs.listLocations(orphan)).toHaveLength(0);
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
    // Age is not what condemns a blob; being unreferenced is.
    expect(await ctx.storage.blobs.get(referenced)).not.toBeNull();
    expect(await ctx.blobs.disk.has(referenced)).not.toBeNull();
    // And a run that finds nothing new reports nothing.
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 0 });
    // The folder the spool and the marker live in is untouched.
    expect(await readdir(join(ctx.blobs.disk.locator))).toContain(
      ".marfa-store",
    );
  });

  it("forgets a reported blob that an item names before the grace is up", async () => {
    ctx = await createTestContext();
    const late = await upload(ctx, "named after the report");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      GRACE_MS,
      time.nowFn,
    );
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    const itemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "late but in time", blob_ref: late },
      },
    });
    expect(itemRes.status).toBe(201);
    time.advance(GRACE_MS * 2);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 0 });
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
    expect(await ctx.blobs.disk.has(late)).not.toBeNull();
  });

  it("forgets only the blob referenced again, keeping the others reported", async () => {
    ctx = await createTestContext();
    const kept = await upload(ctx, "still nothing names this");
    const late = await upload(ctx, "named after the report, beside another");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      GRACE_MS,
      time.nowFn,
    );
    expect(await reporter.runOnce()).toEqual({ reported: 2, purged: 0 });
    const itemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "late", blob_ref: late } },
    });
    expect(itemRes.status).toBe(201);
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    expect((await ctx.storage.blobs.listOrphans()).map((r) => r.hash)).toEqual([
      kept,
    ]);
    // Past the grace, only the one still unreferenced goes.
    time.advance(GRACE_MS);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 1 });
    expect(await ctx.blobs.disk.has(kept)).toBeNull();
    expect(await ctx.blobs.disk.has(late)).not.toBeNull();
  });

  it("lists the report oldest first, and purges a report only once it is older than the grace", async () => {
    ctx = await createTestContext();
    const first = await upload(ctx, "reported first");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      GRACE_MS,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1_000);
    const second = await upload(ctx, "reported second");
    await reporter.runOnce();
    const report = await ctx.storage.blobs.listOrphans();
    expect(report.map((r) => r.hash)).toEqual([first, second]);
    expect(Date.parse(report[0]!.reported_at)).toBeLessThan(
      Date.parse(report[1]!.reported_at),
    );
    // Exactly the grace old: waits for the next run. A millisecond older:
    // purged.
    time.advance(GRACE_MS - 1_000);
    expect(await reporter.runOnce()).toEqual({ reported: 2, purged: 0 });
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 1 });
    expect(await ctx.blobs.disk.has(first)).toBeNull();
    expect(await ctx.blobs.disk.has(second)).not.toBeNull();
  });

  it("never purges what the same run reported, whatever the grace", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "reported and purged are two runs");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    expect(await ctx.blobs.disk.has(orphan)).not.toBeNull();
    // The witness: the next run, a millisecond later under the same zero
    // grace, is the one that purges.
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 1 });
    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
  });

  it("counts a metadata extension naming a blob as a reference", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "no extension names this");
    const named = await upload(ctx, "an extension names this");
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "carries a sidecar" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    await ctx.storage.metadata.setExtension(item.id, "user.files", {
      attachment: named,
    });

    await reportThenPurge(ctx);

    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    expect(await ctx.blobs.disk.has(named)).not.toBeNull();
  });
});

describe("what the report counts as a reference", () => {
  it("removes a blob nothing references and keeps one an item names", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "orphan blob content");
    const named = await upload(ctx, "custom field blob");
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "has a logo", logo_blob_hash: named },
      },
    });
    expect(created.status).toBe(201);

    await reportThenPurge(ctx);

    expect(await ctx.storage.blobs.get(orphan)).toBeNull();
    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    expect(await ctx.storage.blobs.get(named)).not.toBeNull();
    expect(await ctx.blobs.disk.has(named)).not.toBeNull();
  });

  it("keeps a blob referenced only by a trashed item", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "nothing points at this one");
    const data = await upload(ctx, "bytes only the bin points at");
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        state: "trashed",
        properties: {
          body: "in the bin, still holds a file",
          blob_ref: data,
        },
      },
    });
    expect(createRes.status).toBe(201);

    await reportThenPurge(ctx);

    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    expect(await ctx.blobs.disk.has(data)).not.toBeNull();
  });

  it("keeps a blob referenced only by an archived or revoked item", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "nothing points at this one either");
    const kept: string[] = [];
    for (const [state, type, properties] of [
      ["archived", "core.note", { body: "archived, holds a file" }],
      ["revoked", "system.device", { name: "Revoked laptop", kind: "laptop" }],
    ] as const) {
      const data = await upload(ctx, `bytes only ${state} points at`);
      kept.push(data);
      // Written through the storage layer rather than `POST /items`, because
      // one of these rows is a `system.*` type and the reserved namespace is
      // closed to every credential. The claim here is about what the scan
      // keeps, not about which door wrote the row.
      await ctx.storage.items.create({
        type,
        tier: "library",
        state,
        properties: { ...properties, blob_ref: data },
        source: "test/blob-cleanup",
      });
    }

    await reportThenPurge(ctx);

    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    for (const data of kept) {
      expect(await ctx.blobs.disk.has(data)).not.toBeNull();
    }
  });

  it("keeps a blob referenced only by version history", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "no history points at this");
    const data = await upload(ctx, "bytes only history points at");
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "carries a file", attachment_hash: data },
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      item: { id: string; version: number };
    };
    const patchRes = await request(
      ctx.app,
      "PATCH",
      `/items/${created.item.id}`,
      {
        key: ctx.workingKey,
        body: {
          properties: { attachment_hash: "replaced" },
          version: created.item.version,
        },
      },
    );
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    await reportThenPurge(ctx);

    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    expect(await ctx.blobs.disk.has(data)).not.toBeNull();
  });

  it("purges the bytes, the log's rows and the report's row together", async () => {
    ctx = await createTestContext();
    const data = new TextEncoder().encode("rows go with the bytes");
    const hash = hashOf(data);
    expect(await upload(ctx, "rows go with the bytes")).toBe(hash);
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(1);
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    // Between the runs: reported, still located, still there.
    expect((await ctx.storage.blobs.listOrphans()).map((r) => r.hash)).toEqual([
      hash,
    ]);
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(1);
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    time.advance(1);
    await reporter.runOnce();
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(0);
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
  });
});
