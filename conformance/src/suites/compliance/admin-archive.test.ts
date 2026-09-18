/**
 * Conformance for POST /admin/restore-archive.
 *
 * Exercises the export-to-restore round trip end to end: the server builds
 * the archive via GET /export?format=archive and accepts it back via
 * POST /admin/restore-archive, which is what proves manifest-v1 and
 * blob-hash verification agree.
 *
 * No tar.gz construction in test code — relying on the server's own
 * archive export keeps this dependency-free and exercises the only archive
 * format callers actually see.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
/** The file's own credential, for the export half. */
let fileKey: string;
/** The operator key's client, for the restore half. */
let operator: MarfaClient;

beforeAll(async () => {
  const setup = await createTestContext("compliance", "admin-archive");
  ({ ctx, client, apiUrl } = setup);
  fileKey = setup.apiKey;
  operator = getOperatorClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("admin/restore-archive", () => {
  it("round-trips: archive export then restore accepts the same payload", async () => {
    // Seed with an explicit source_id so the re-import path hits the
    // (source, source_id) dedup branch — that's the bit that proves
    // archive → restore is genuinely round-tripping rather than
    // silently creating net-new rows on the second hop.
    const sourceId = `archive-rt-${ctx.runId}`;
    const r = await client.createItem(
      createNote({ source: ctx.source, source_id: sourceId }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    // Fetch the archive the server produces — scoped to this file's own
    // credential-stamped `source`, which keeps the round trip inside the
    // 5000-item `/admin/restore-archive` cap and keeps other files' rows out
    // of it.
    const url = `${apiUrl}/export?source=${encodeURIComponent(ctx.source)}&format=archive`;
    const archiveRes = await fetch(url, {
      headers: { Authorization: `Bearer ${fileKey}` },
    });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.headers.get("Content-Type")).toBe("application/gzip");
    const archiveBytes = new Uint8Array(await archiveRes.arrayBuffer());
    expect(archiveBytes.byteLength).toBeGreaterThan(0);

    // Post it back. The archive holds only this file's source-scoped
    // items; the seeded `(source, source_id)` pair matches the row
    // already there, so it dedupes — that's the assertion proving
    // archive → restore rebuilds the same shape the export emitted.
    const restored = await operator.restoreArchive(archiveBytes);
    expect(restored.ok).toBe(true);
    expect(restored.data.duplicates).toBeGreaterThanOrEqual(1);
    expect(restored.data.blobs_imported).toBe(0);
  });

  it("requires the operator key", async () => {
    // A credential holding write on every type. The archive routes take the
    // operator key, which is a different thing from holding every permission:
    // running the instance is fenced outside the model.
    const keyResp = await client.createKey({
      label: "archive-working",
      source: `${ctx.source}-archive-working`,
      type_permissions: { "*": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scoped = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    // A zero-length body is rejected before the admin check, so build a real
    // minimal archive to isolate the 403 path. Reuse the server-built archive,
    // valid by construction and scoped to this file's own `source`: this case
    // needs only *a* valid body, and an unscoped export is work it has no use
    // for.
    const url = `${apiUrl}/export?source=${encodeURIComponent(ctx.source)}&format=archive`;
    const archiveRes = await fetch(url, {
      headers: { Authorization: `Bearer ${fileKey}` },
    });
    const archiveBytes = new Uint8Array(await archiveRes.arrayBuffer());

    const res = await scoped.restoreArchive(archiveBytes);
    expect(res.status).toBe(403);
    expect(res.error?.error.code).toBe("forbidden");
  });
});
