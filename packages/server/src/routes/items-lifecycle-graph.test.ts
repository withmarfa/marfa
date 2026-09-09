/**
 * A lifecycle write obeys the type's own graph.
 *
 * `system.*` types declare a bounded lifecycle — `active | revoked`, with
 * `revoked` terminal — while every other type follows the canonical
 * `active | archived | trashed` graph. Three of the four write paths that
 * move an item's `state` asked `validateTransition` about it. Two did not,
 * and they chained:
 *
 *   - `items.restore()` wrote `active` unconditionally once the row read
 *     `trashed`, in both dialects, where `delete()` and `transition()` both
 *     validated first.
 *   - `POST /items` accepted an optional `state` checked only for membership
 *     of the universal state list, so the operator key could create a
 *     `system.*` row directly in `trashed` — a state that type's lifecycle
 *     does not contain, reachable by no transition and leavable by none.
 *
 * Create in `trashed`, then restore, and the row is `active` having passed
 * nothing the graph admits.
 *
 * **The two fixes sit at different layers on purpose**, and the tests below
 * pin the asymmetry as much as the refusals. The restore gate is in the
 * store, beside its two siblings, because keeping the three together is what
 * stops them drifting again. The create gate is in the route, because
 * `storage.items.create` is also the archive restore's writer and has to
 * faithfully replay states written before this rule existed.
 *
 * Assertions read the error MESSAGE, not only the code: `restore()` already
 * threw `INVALID_TRANSITION` for a non-trashed row, so a code-only assertion
 * passes with the new `validateTransition` call deleted.
 */
import { createGzip } from "node:zlib";
import { describe, expect, it, afterEach } from "vitest";
import * as tar from "tar-stream";
import { generateId } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/** `system.device` is the smallest bounded-lifecycle type: two required
 *  properties and none of the connection machinery. What is under test is
 *  the graph the `system.*` classification selects, not anything specific
 *  to a grant. */
const SYSTEM_TYPE = "system.device";
const SYSTEM_PROPERTIES = { name: "Test laptop", kind: "laptop" };

async function errorOf(
  res: Response,
): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  return body.error;
}

describe("POST /items/:id/restore — the restore obeys the type's graph", () => {
  it("refuses to restore a system item whose lifecycle has no path out of trashed", async () => {
    ctx = await createTestContext();
    const c = ctx;

    // Built through the store rather than the API, and it has to be: the
    // create route now refuses this exact state for this exact type, which
    // is the other half of this ticket. The store stays permissive so the
    // archive restore can replay it, so it is the only way to reach the row
    // shape the restore gate exists for.
    const trashed = await c.storage.items.create({
      type: SYSTEM_TYPE,
      state: "trashed",
      properties: SYSTEM_PROPERTIES,
    });
    expect(trashed.state).toBe("trashed");

    const res = await request(c.app, "POST", `/items/${trashed.id}/restore`, {
      key: c.spaceKey,
    });
    expect(res.status).toBe(400);

    // The message, not just the code. `restore()` already answered
    // `invalid_transition` for a row that is not trashed, so a code-only
    // assertion stays green with the graph check deleted — this row IS
    // trashed, and only the transition check can refuse it.
    const error = await errorOf(res);
    expect(error.code).toBe("invalid_transition");
    expect(error.message).toContain('Transition from "trashed" to "active"');
    expect(error.message).not.toBe("Item is not trashed");

    // Refused means unmoved, not merely un-returned.
    const after = await c.storage.items.getIncludingTrashed(trashed.id);
    expect(after?.state).toBe("trashed");
  });

  it("still restores an ordinary trashed item, so the refusal is not blanket", async () => {
    ctx = await createTestContext();
    const c = ctx;

    const created = await request(c.app, "POST", "/items", {
      key: c.spaceKey,
      body: { type: "core.note", properties: { body: "To restore" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };

    const deleted = await request(c.app, "DELETE", `/items/${item.id}`, {
      key: c.spaceKey,
    });
    expect(deleted.status).toBe(200);
    expect((await c.storage.items.getIncludingTrashed(item.id))?.state).toBe(
      "trashed",
    );

    const restored = await request(c.app, "POST", `/items/${item.id}/restore`, {
      key: c.spaceKey,
    });
    expect(restored.status).toBe(200);
    expect((await c.storage.items.get(item.id))?.state).toBe("active");
  });
});

describe("POST /items — a create names a state the type's lifecycle contains", () => {
  it("refuses to create a system item in a state its lifecycle does not contain", async () => {
    ctx = await createTestContext();
    const c = ctx;

    const res = await request(c.app, "POST", "/items", {
      key: c.spaceKey,
      body: {
        type: SYSTEM_TYPE,
        state: "trashed",
        properties: SYSTEM_PROPERTIES,
      },
    });
    expect(res.status).toBe(400);

    const error = await errorOf(res);
    expect(error.code).toBe("validation_error");
    // Names the transition rather than repeating the state back, so the
    // refusal survives a weakening back to a membership test — `trashed` is
    // a member of the universal list, so `Invalid state: trashed` is exactly
    // what the old check could never have said.
    expect(error.message).toContain('"active" to "trashed"');
  });

  it("admits the states a system lifecycle does contain", async () => {
    ctx = await createTestContext();
    const c = ctx;

    // `revoked` is where a `system.*` type's lifecycle actually ends, and
    // `active` is where it starts. Both have to keep working, or the gate is
    // refusing the graph rather than enforcing it.
    for (const state of ["active", "revoked"]) {
      const res = await request(c.app, "POST", "/items", {
        key: c.spaceKey,
        body: {
          type: SYSTEM_TYPE,
          state,
          properties: { ...SYSTEM_PROPERTIES, name: `Device ${state}` },
        },
      });
      expect(res.status).toBe(201);
      const { item } = (await res.json()) as {
        item: { id: string; state: string };
      };
      expect(item.state).toBe(state);
    }
  });

  it("still admits archived and trashed for an ordinary type", async () => {
    ctx = await createTestContext();
    const c = ctx;

    for (const state of ["archived", "trashed"]) {
      const res = await request(c.app, "POST", "/items", {
        key: c.spaceKey,
        body: {
          type: "core.note",
          state,
          properties: { body: `Note ${state}` },
        },
      });
      expect(res.status).toBe(201);
    }

    // And `revoked`, which the canonical graph does not reach, is refused —
    // the same gate reading a different type's lifecycle.
    const revoked = await request(c.app, "POST", "/items", {
      key: c.spaceKey,
      body: {
        type: "core.note",
        state: "revoked",
        properties: { body: "Note revoked" },
      },
    });
    expect(revoked.status).toBe(400);
    expect((await errorOf(revoked)).message).toContain('"active" to "revoked"');
  });
});

// ---------------------------------------------------------------------------
// The tolerance case: the route/store split has to be real
// ---------------------------------------------------------------------------

async function buildArchive(
  manifest: Record<string, unknown>,
  ndjsonLines: string[],
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  pack.pipe(gzip);

  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  pack.entry({ name: "manifest.json", size: manifestBuf.length }, manifestBuf);
  const ndjsonBuf = Buffer.from(ndjsonLines.join("\n") + "\n");
  pack.entry({ name: "items.ndjson", size: ndjsonBuf.length }, ndjsonBuf);

  pack.finalize();
  await new Promise<void>((resolve) => gzip.on("end", resolve));
  return Buffer.concat(chunks);
}

describe("POST /admin/restore-archive — an archive replays a state the create route refuses", () => {
  it("restores a system item recorded in trashed, because the store gate was deliberately not added", async () => {
    ctx = await createTestContext();
    const c = ctx;

    // Exactly the row the create route refuses two describes above. An
    // archive is a record of what a space held, and rows in this shape exist
    // because nothing refused them at the time. Tightening
    // `storage.items.create` alongside the route would make those archives
    // unrestorable, which is why the two gates sit at different layers.
    const archiveId = generateId();
    const archive = await buildArchive(
      {
        version: 1,
        format: "marfa-archive-v1",
        created_at: new Date().toISOString(),
        item_count: 1,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: archiveId,
            type: SYSTEM_TYPE,
            state: "trashed",
            properties: SYSTEM_PROPERTIES,
          },
        }),
      ],
    );

    const res = await c.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.spaceKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { imported: number };
    expect(data.imported).toBe(1);

    // Replayed faithfully, in the state the archive recorded.
    const stored = await c.storage.items.getIncludingTrashed(archiveId);
    expect(stored?.type).toBe(SYSTEM_TYPE);
    expect(stored?.state).toBe("trashed");

    // And the chain the ticket is about is still closed at the other end:
    // the row exists, and the graph still refuses to walk it out to active.
    const restore = await request(
      c.app,
      "POST",
      `/items/${archiveId}/restore`,
      {
        key: c.spaceKey,
      },
    );
    expect(restore.status).toBe(400);
    expect((await errorOf(restore)).message).toContain(
      'Transition from "trashed" to "active"',
    );
  });
});
