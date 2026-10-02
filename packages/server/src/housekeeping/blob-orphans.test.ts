/**
 * The orphan report stands between an unreferenced blob and its deletion:
 * one run reports, and a later run purges what is still unreferenced once
 * the grace has passed since the report. What counts as a reference is
 * asserted here too: an item in any lifecycle state, a metadata extension,
 * a version snapshot and an edge's properties, wherever a string in them
 * holds the hash.
 */
import { itemWrites } from "../storage/item-writes.js";
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

  it("keeps a blob a body links to after the file item naming it is purged", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "nothing links to this");
    const image = await upload(ctx, "an image a note links in its body");
    const file = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.file",
        properties: { blob_ref: image, mime_type: "image/png" },
      },
    });
    expect(file.status).toBe(201);
    const fileId = ((await file.json()) as { item: { id: string } }).item.id;
    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: `A chart:\n\n![chart](${image})\n` },
      },
    });
    expect(note.status).toBe(201);
    expect(
      (
        await request(ctx.app, "DELETE", `/items/${fileId}`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);
    const purge = await request(ctx.app, "DELETE", `/items/${fileId}/purge`, {
      key: ctx.workingKey,
    });
    expect(purge.status, await purge.clone().text()).toBe(200);

    await reportThenPurge(ctx);

    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    expect(await ctx.storage.blobs.get(image)).not.toBeNull();
    expect(await ctx.blobs.disk.has(image)).not.toBeNull();
  });

  it("keeps a blob named only in an edge's properties, whole or inside text", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "no edge names this");
    const whole = await upload(ctx, "an edge property is this hash");
    const linked = await upload(ctx, "an edge property links this");
    const ids: string[] = [];
    for (const body of ["one end", "the other end"]) {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body } },
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { item: { id: string } }).item.id);
    }
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: {
        source_id: ids[0],
        target_id: ids[1],
        edge_type: "about",
        properties: { cover: whole, caption: `see ![it](${linked})` },
      },
    });
    expect(edge.status, await edge.clone().text()).toBe(201);

    await reportThenPurge(ctx);

    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    expect(await ctx.blobs.disk.has(whole)).not.toBeNull();
    expect(await ctx.blobs.disk.has(linked)).not.toBeNull();
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
      ["revoked", "system.folder", { title: "Revoked folder" }],
    ] as const) {
      const data = await upload(ctx, `bytes only ${state} points at`);
      kept.push(data);
      // Written through the storage layer rather than `POST /items`, because
      // one of these rows is a `system.*` type and the reserved namespace is
      // closed to every credential. The claim here is about what the scan
      // keeps, not about which door wrote the row.
      await itemWrites(ctx.storage).create({
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

/**
 * Run `during` once, after the run's walk of the corpus has read its last
 * page and before anything is purged: the window in which the walk's
 * answer is already stale.
 */
function afterTheWalk(c: TestContext, during: () => Promise<void>): void {
  const versions = c.storage.versions;
  const scan = versions.scanProperties.bind(versions);
  let fired = false;
  versions.scanProperties = async (limit, cursor) => {
    const page = await scan(limit, cursor);
    if (!page.cursor && !fired) {
      fired = true;
      await during();
    }
    return page;
  };
}

describe("a blob sent or named again while the sweep runs", () => {
  it("lifts the report on an upload of the same bytes, so the grace starts again", async () => {
    ctx = await createTestContext();
    const content = "uploaded, reported, uploaded again";
    const hash = await upload(ctx, content);
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });

    // The caller is told the bytes are stored, and the report says so.
    expect(await upload(ctx, content)).toBe(hash);
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);

    // The next run reports it afresh rather than purging it.
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();

    // Still unreferenced past a grace counted from that report, it goes.
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 1 });
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
  });

  it("keeps a reported blob uploaded again while the run walks the corpus", async () => {
    ctx = await createTestContext();
    const content = "uploaded again mid-walk";
    const hash = await upload(ctx, content);
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1);
    afterTheWalk(ctx, async () => {
      expect(await upload(ctx!, content)).toBe(hash);
    });
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
  });

  it("keeps a reported blob an item names after the walk and before the purge", async () => {
    ctx = await createTestContext();
    const content = "named after the walk read past it";
    const hash = await upload(ctx, content);
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1);
    let itemId = "";
    afterTheWalk(ctx, async () => {
      expect(await upload(ctx!, content)).toBe(hash);
      const res = await request(ctx!.app, "POST", "/items", {
        key: ctx!.workingKey,
        body: { type: "core.note", properties: { body: "x", blob_ref: hash } },
      });
      expect(res.status).toBe(201);
      itemId = ((await res.json()) as { item: { id: string } }).item.id;
    });
    expect(await reporter.runOnce()).toMatchObject({ purged: 0 });
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    // The item that names it reads the bytes.
    const item = await request(ctx.app, "GET", `/items/${itemId}`, {
      key: ctx.workingKey,
    });
    expect(item.status).toBe(200);
    const bytes = await ctx.app.request(`/blobs/${hash}`, {
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe(content);
    // A later run finds it referenced and leaves it out of the report.
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 0 });
  });

  it("keeps a reported blob an item names after the walk without sending the bytes again", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "named, never sent again");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1);
    afterTheWalk(ctx, async () => {
      const res = await request(ctx!.app, "POST", "/items", {
        key: ctx!.workingKey,
        body: { type: "core.note", properties: { body: "x", blob_ref: hash } },
      });
      expect(res.status).toBe(201);
    });
    expect(await reporter.runOnce()).toMatchObject({ purged: 0 });
    expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    // The next walk sees the reference and leaves it out of the report.
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 0 });
  });

  it("keeps a reported blob an edge names after the walk", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "named by an edge after the walk");
    const ids: string[] = [];
    for (const body of ["one end", "the other end"]) {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body } },
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { item: { id: string } }).item.id);
    }
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1);
    afterTheWalk(ctx, async () => {
      const res = await request(ctx!.app, "POST", "/edges", {
        key: ctx!.workingKey,
        body: {
          source_id: ids[0],
          target_id: ids[1],
          edge_type: "about",
          properties: { caption: `see ![it](${hash})` },
        },
      });
      expect(res.status).toBe(201);
    });
    expect(await reporter.runOnce()).toMatchObject({ purged: 0 });
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
  });
});

describe("a reference added or removed between runs", () => {
  it("restarts the grace for a blob an item named and then stopped naming", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "named, then unnamed, between runs");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    expect((await ctx.storage.blobs.listOrphans()).map((r) => r.hash)).toEqual([
      hash,
    ]);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "x", blob_ref: hash } },
    });
    expect(created.status).toBe(201);
    // The new reference lifts the report.
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
    const item = ((await created.json()) as { item: { id: string } }).item;
    const trashed = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.workingKey,
    });
    expect(trashed.status).toBe(200);
    const purged = await request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
      key: ctx.workingKey,
    });
    expect(purged.status, await purged.clone().text()).toBe(200);

    // The run after reports it afresh rather than purging on the old report.
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 1 });
  });

  it("restarts the grace for a blob an extension named and then stopped naming", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "named by an extension between runs");
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "host" } },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { item: { id: string } }).item.id;
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    expect((await ctx.storage.blobs.listOrphans()).map((r) => r.hash)).toEqual([
      hash,
    ]);
    const put = await request(
      ctx.app,
      "PUT",
      `/items/${id}/extensions/custom.cover`,
      { key: ctx.workingKey, body: { cover: hash } },
    );
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
    const removed = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/extensions/custom.cover`,
      { key: ctx.workingKey },
    );
    expect(removed.status).toBe(200);
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
  });

  it("restarts the grace for a blob an edge named and then stopped naming", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "named by an edge between runs");
    const ids: string[] = [];
    for (const body of ["one end", "the other end"]) {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body } },
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { item: { id: string } }).item.id);
    }
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: {
        source_id: ids[0],
        target_id: ids[1],
        edge_type: "about",
        properties: { caption: `see ${hash}` },
      },
    });
    expect(edge.status).toBe(201);
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
    const edgeId = ((await edge.json()) as { edge: { id: string } }).edge.id;
    const removed = await request(ctx.app, "DELETE", `/edges/${edgeId}`, {
      key: ctx.workingKey,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
  });
});

describe("lifting a report costs a lookup, not a scan", () => {
  /** Raw SQL on the test's own database. */
  function raw(c: TestContext) {
    return c.storage as unknown as {
      __sqliteAll: (query: string) => Promise<Record<string, unknown>[]>;
      __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
    };
  }

  it("puts no text-matching trigger on extensions, edges or versions", async () => {
    ctx = await createTestContext();
    const triggers = await raw(ctx).__sqliteAll(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    );
    expect(new Set(triggers.map((t) => t.tbl_name))).toEqual(
      new Set(["item_blob_references"]),
    );
  });

  it("lifts reports by hash, through the index, with many reports held", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "named by a large extension");
    // Ten thousand other reports, as a large instance's report can hold.
    await raw(ctx).__sqliteRun(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
       INSERT INTO blobs (hash, mime_type, size_bytes, created_at)
       SELECT printf('sha256:%064x', i), 'text/plain', 1, '2026-01-01T00:00:00.000Z' FROM n`,
      [],
    );
    await raw(ctx).__sqliteRun(
      `INSERT INTO blob_orphans (hash, reported_at)
       SELECT hash, '2026-01-01T00:00:00.000Z' FROM blobs`,
      [],
    );
    const plan = await raw(ctx).__sqliteAll(
      "EXPLAIN QUERY PLAN DELETE FROM blob_orphans WHERE hash IN ('sha256:0')",
    );
    expect(plan.map((row) => String(row.detail)).join(" ")).toMatch(
      /SEARCH blob_orphans USING (INDEX|PRIMARY KEY)/,
    );

    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "host" } },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { item: { id: string } }).item.id;
    const filler = "x".repeat(90_000);
    const started = Date.now();
    const put = await request(
      ctx.app,
      "PUT",
      `/items/${id}/extensions/custom.big`,
      { key: ctx.workingKey, body: { filler, cover: hash } },
    );
    expect(put.status, await put.clone().text()).toBe(200);
    // Generous: a scan of every report per write is what this rules out.
    expect(Date.now() - started).toBeLessThan(2_000);
    const left = await raw(ctx).__sqliteAll(
      "SELECT count(*) AS n FROM blob_orphans",
    );
    expect(Number(left[0]?.n)).toBe(10_000);
    expect(
      await raw(ctx).__sqliteAll(
        `SELECT hash FROM blob_orphans WHERE hash = '${hash}'`,
      ),
    ).toEqual([]);
  });
});

describe("a purge cut short between the row and the bytes", () => {
  /** Make the disk store's next delete fail, as a crash or an outage would. */
  function failNextDelete(c: TestContext): void {
    const disk = c.blobs.disk;
    const original = disk.delete.bind(disk);
    disk.delete = () => {
      disk.delete = original;
      return Promise.reject(new Error("store unavailable"));
    };
  }

  it("leaves no row without bytes, and the next run finishes it", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "the store fails mid-purge");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1);
    failNextDelete(ctx);
    expect(await reporter.runOnce()).toMatchObject({ purged: 0 });
    // The row went first: nothing names bytes that may be gone.
    expect(await ctx.storage.blobs.get(hash)).toBeNull();
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    time.advance(1);
    await reporter.runOnce();
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
    expect(await ctx.storage.blobs.listPendingPurges()).toEqual([]);
  });

  it("purges the rest of a run when one blob's purge fails", async () => {
    ctx = await createTestContext();
    const first = await upload(ctx, "its purge meets a busy database");
    const second = await upload(ctx, "its purge goes ahead");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1);
    const registry = ctx.storage.blobs;
    const claim = registry.claimOrphanPurge.bind(registry);
    registry.claimOrphanPurge = (hash, before, runStartedAt) =>
      hash === first
        ? Promise.reject(new Error("SQLITE_BUSY: database is locked"))
        : claim(hash, before, runStartedAt);
    try {
      expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 1 });
    } finally {
      registry.claimOrphanPurge = claim;
    }
    expect(await ctx.blobs.disk.has(second)).toBeNull();
    expect(await ctx.blobs.disk.has(first)).not.toBeNull();
    // Left for the next run, which purges it.
    time.advance(1);
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 1 });
    expect(await ctx.blobs.disk.has(first)).toBeNull();
  });

  it("keeps reporting while a store's deletes keep failing", async () => {
    ctx = await createTestContext();
    const stuck = await upload(ctx, "a store that never lets go");
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1);
    const disk = ctx.blobs.disk;
    const original = disk.delete.bind(disk);
    disk.delete = () => Promise.reject(new Error("store unavailable"));
    try {
      expect(await reporter.runOnce()).toMatchObject({ purged: 0 });
      expect(await ctx.storage.blobs.listPendingPurges()).toEqual([stuck]);
      // The unfinished purge is retried and logged, and the run still
      // reports what is new.
      const fresh = await upload(ctx, "reported despite the stuck store");
      time.advance(1);
      expect(await reporter.runOnce()).toEqual({ reported: 1, purged: 0 });
      expect(
        (await ctx.storage.blobs.listOrphans()).map((r) => r.hash),
      ).toEqual([fresh]);
      expect(await ctx.storage.blobs.listPendingPurges()).toEqual([stuck]);
    } finally {
      disk.delete = original;
    }
    time.advance(1);
    await reporter.runOnce();
    expect(await ctx.storage.blobs.listPendingPurges()).toEqual([]);
    expect(await disk.has(stuck)).toBeNull();
  });

  it("keeps bytes uploaded again before the next run finishes the purge", async () => {
    ctx = await createTestContext();
    const content = "uploaded again after a purge was cut short";
    const hash = await upload(ctx, content);
    const time = clock();
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      time.nowFn,
    );
    await reporter.runOnce();
    time.advance(1);
    failNextDelete(ctx);
    expect(await reporter.runOnce()).toMatchObject({ purged: 0 });
    expect(await upload(ctx, content)).toBe(hash);
    time.advance(1);
    await reporter.runOnce();
    expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    expect(await ctx.storage.blobs.listPendingPurges()).toEqual([]);
  });
});
