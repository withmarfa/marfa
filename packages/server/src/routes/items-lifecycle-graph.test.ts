/**
 * A lifecycle write obeys the type's own graph.
 *
 * `system.*` types declare a bounded lifecycle, `active | revoked` with
 * `revoked` terminal, while every other type follows the canonical
 * `active | archived | trashed` graph. Every door that moves or names an
 * item's `state` asks `validateTransition` about it: `delete()`,
 * `transition()` and `restore()` in the store, because each is a
 * transition; `POST /items` and `POST /restore` in the route,
 * because a create is not a transition and the store's `create` is the
 * writer both doors share. A `system.*` row in `trashed` would be
 * reachable by no transition and leavable by none, so no door writes one.
 *
 * Assertions read the error MESSAGE, not only the code: `restore()` already
 * threw `INVALID_TRANSITION` for a non-trashed row, so a code-only assertion
 * passes with the new `validateTransition` call deleted.
 */
import { generateId } from "@withmarfa/shared";
import { createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/** The bounded lifecycle belongs to the `system.*` classification rather
 *  than to any one type, so any system type states the same graph. */
const SYSTEM_TYPE = "system.folder";

/** Properties a `system.folder` row accepts. The rows are built through
 *  the store, because no credential writes a reserved namespace over the
 *  wire. */
function systemProperties(): Record<string, unknown> {
  return { title: "lifecycle" };
}

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
    // create route refuses this exact state for this exact type. The store
    // stays permissive so the archive restore can replay it, so it is the
    // only way to reach the row shape the restore gate exists for.
    const trashed = await itemWrites(c.storage).create({
      writer: null,
      type: SYSTEM_TYPE,
      state: "trashed",
      properties: systemProperties(),
      source: "test/lifecycle-graph",
    });
    expect(trashed.state).toBe("trashed");

    // Through the store: no credential writes a reserved namespace over the
    // wire, so the restore door refuses at the type gate before the
    // lifecycle question is asked. The lifecycle rule lives in the store.
    //
    // The message, not just the code. `restore()` already answered
    // `invalid_transition` for a row that is not trashed, so a code-only
    // assertion stays green with the graph check deleted — this row IS
    // trashed, and only the transition check can refuse it.
    const error = await itemWrites(c.storage)
      .restore(trashed.id)
      .then(
        () => null,
        (err: unknown) => err as { code: string; message: string },
      );
    expect(error?.code).toBe("invalid_transition");
    expect(error?.message).toContain('Transition from "trashed" to "active"');
    expect(error?.message).not.toBe("Item is not trashed");

    // Refused means unmoved, not merely un-returned.
    const after = await c.storage.items.getIncludingTrashed(trashed.id);
    expect(after?.state).toBe("trashed");
  });

  it("still restores an ordinary trashed item, so the refusal is not blanket", async () => {
    ctx = await createTestContext();
    const c = ctx;

    const created = await request(c.app, "POST", "/items", {
      key: c.workingKey,
      body: { type: "core.note", properties: { body: "To restore" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };

    const deleted = await request(c.app, "DELETE", `/items/${item.id}`, {
      key: c.workingKey,
    });
    expect(deleted.status).toBe(200);
    expect((await c.storage.items.getIncludingTrashed(item.id))?.state).toBe(
      "trashed",
    );

    const restored = await request(c.app, "POST", `/items/${item.id}/restore`, {
      key: c.workingKey,
    });
    expect(restored.status).toBe(200);
    expect((await c.storage.items.get(item.id))?.state).toBe("active");
  });
});

describe("POST /items/:id/transition — a transition out of the trash is judged by the graph", () => {
  it("refuses trashed → archived by name, and admits trashed → active", async () => {
    // Read through the getter that sees trashed rows: through the other
    // one every trashed row would answer 404 and the graph's own refusal
    // would be unreachable. `trashed` admits `active` alone, and the
    // refusal has to say so.
    ctx = await createTestContext();
    const c = ctx;

    const created = await request(c.app, "POST", "/items", {
      key: c.workingKey,
      body: { type: "core.note", properties: { body: "To move" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    const deleted = await request(c.app, "DELETE", `/items/${item.id}`, {
      key: c.workingKey,
    });
    expect(deleted.status).toBe(200);

    const archived = await request(
      c.app,
      "POST",
      `/items/${item.id}/transition`,
      { key: c.workingKey, body: { state: "archived" } },
    );
    expect(archived.status).toBe(400);
    const error = await errorOf(archived);
    expect(error.code).toBe("invalid_transition");
    expect(error.message).toContain('Transition from "trashed" to "archived"');
    expect((await c.storage.items.getIncludingTrashed(item.id))?.state).toBe(
      "trashed",
    );

    const activated = await request(
      c.app,
      "POST",
      `/items/${item.id}/transition`,
      { key: c.workingKey, body: { state: "active" } },
    );
    expect(activated.status).toBe(200);
    expect((await c.storage.items.get(item.id))?.state).toBe("active");
  });
});

describe("POST /items — a create names a state the type's lifecycle contains", () => {
  it("still admits archived and trashed for an ordinary type", async () => {
    ctx = await createTestContext();
    const c = ctx;

    for (const state of ["archived", "trashed"]) {
      const res = await request(c.app, "POST", "/items", {
        key: c.workingKey,
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
      key: c.workingKey,
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
// The archive door asks the same question of every row it would write
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

const MANIFEST = {
  version: 0,
  format: "marfa-archive-v0",
  created_at: new Date().toISOString(),
  item_count: 2,
  blob_count: 0,
  blobs: {},
};

describe("POST /restore — an archive names a state the type's lifecycle contains", () => {
  it("refuses the whole archive when a system row is recorded in trashed, and writes nothing", async () => {
    ctx = await createTestContext();
    const c = ctx;

    const systemId = generateId();
    const noteId = generateId();
    const archive = await buildArchive(MANIFEST, [
      // An ordinary row first, so the refusal is shown to take the whole
      // archive with it rather than the rows after the bad one.
      JSON.stringify({
        item: {
          id: noteId,
          type: "core.note",
          state: "trashed",
          properties: { body: "Trashed note" },
        },
      }),
      JSON.stringify({
        item: {
          id: systemId,
          type: SYSTEM_TYPE,
          state: "trashed",
          properties: systemProperties(),
        },
      }),
    ]);

    const res = await c.app.request(`/restore`, {
      method: "POST",
      headers: {
        cookie: c.owner.cookie,
        origin: new URL(c.config.authBaseUrl).origin,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("validation_error");
    expect(error.message).toContain(systemId);
    expect(error.message).toContain('"active" to "trashed"');
    expect(await c.storage.items.getIncludingTrashed(systemId)).toBeNull();
    expect(await c.storage.items.getIncludingTrashed(noteId)).toBeNull();

    // `archived` is as unreachable for a system row as `trashed`.
    const archivedId = generateId();
    const archived = await c.app.request(`/restore`, {
      method: "POST",
      headers: {
        cookie: c.owner.cookie,
        origin: new URL(c.config.authBaseUrl).origin,
        "Content-Type": "application/gzip",
      },
      body: await buildArchive(MANIFEST, [
        JSON.stringify({
          item: {
            id: archivedId,
            type: SYSTEM_TYPE,
            state: "archived",
            properties: systemProperties(),
          },
        }),
      ]),
    });
    expect(archived.status).toBe(400);
    expect((await errorOf(archived)).message).toContain(
      '"active" to "archived"',
    );
    expect(await c.storage.items.getIncludingTrashed(archivedId)).toBeNull();

    // A state that is no state at all is refused the same way, since the
    // store would otherwise write it as it came.
    const numeric = await c.app.request(`/restore`, {
      method: "POST",
      headers: {
        cookie: c.owner.cookie,
        origin: new URL(c.config.authBaseUrl).origin,
        "Content-Type": "application/gzip",
      },
      body: await buildArchive(MANIFEST, [
        JSON.stringify({
          item: {
            id: noteId,
            type: "core.note",
            state: 5,
            properties: { body: "Numbered note" },
          },
        }),
      ]),
    });
    expect(numeric.status).toBe(400);
    expect((await errorOf(numeric)).message).toContain(
      'Invalid target state "5"',
    );
    expect(await c.storage.items.getIncludingTrashed(noteId)).toBeNull();
  });

  it("restores the states each lifecycle contains: trashed for an ordinary row, active for a system row", async () => {
    ctx = await createTestContext();
    const c = ctx;

    const systemId = generateId();
    const noteId = generateId();
    const archive = await buildArchive(MANIFEST, [
      JSON.stringify({
        item: {
          id: noteId,
          type: "core.note",
          state: "trashed",
          properties: { body: "Trashed note" },
        },
      }),
      JSON.stringify({
        item: {
          id: systemId,
          type: SYSTEM_TYPE,
          state: "active",
          properties: systemProperties(),
        },
      }),
    ]);

    const res = await c.app.request(`/restore`, {
      method: "POST",
      headers: {
        cookie: c.owner.cookie,
        origin: new URL(c.config.authBaseUrl).origin,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { imported: number }).imported).toBe(2);
    expect((await c.storage.items.getIncludingTrashed(noteId))?.state).toBe(
      "trashed",
    );
    expect((await c.storage.items.get(systemId))?.state).toBe("active");
  });
});
