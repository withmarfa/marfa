/**
 * Conformance for POST /admin/restore-archive.
 *
 * The round trip is end to end: the server builds the archive via
 * GET /export?format=archive and accepts it back via
 * POST /admin/restore-archive, which is what proves the manifest contract
 * and blob-hash verification agree.
 *
 * Two cases build their archive with `utils/archive.ts` instead: a row in
 * a state its lifecycle cannot reach, which no export carries because no
 * door writes one, and a blob the instance does not hold yet, which is what
 * makes its restore the thing that puts the bytes there.
 */

import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { blobHash, itemsArchive } from "../../utils/archive.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

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
    await expectMatchesSchema(
      "POST",
      "/admin/restore-archive",
      200,
      restored.data,
    );
  });

  it("restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name", async () => {
    // Random bytes twice the cap every other body sits under (the cap's
    // own fixture is `compliance/adversarial.test.ts`) and one more, so the
    // archive cannot compress under it and the entry is not block-aligned.
    // The blob is one nothing on the instance names, so the restore is
    // what puts the bytes there, under a type the manifest names and the
    // default would not. A second entry carries other bytes under a name
    // they do not hash to, and is left out.
    const data = new Uint8Array(randomBytes(2 * 1024 * 1024 + 1));
    const hash = blobHash(data);
    const impostor = new Uint8Array(randomBytes(64));
    const claimed = blobHash(new Uint8Array(randomBytes(64)));
    const id = uuidv7();
    const archive = itemsArchive(
      [
        {
          id,
          type: "core.file",
          source: ctx.source,
          source_id: `archive-large-${ctx.runId}`,
          properties: { blob_ref: hash, mime_type: "application/x-drill" },
        },
      ],
      [
        { data, mime_type: "application/x-drill" },
        { data: impostor, mime_type: "application/x-drill", named: claimed },
      ],
    );
    expect(archive.byteLength).toBeGreaterThan(1024 * 1024);

    expect((await client.downloadBlob(hash)).status).toBe(404);
    const restored = await operator.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    expect(restored.data).toMatchObject({ imported: 1, blobs_imported: 1 });

    const read = await client.downloadBlob(hash);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/x-drill");
    expect(Buffer.from(read.data).equals(Buffer.from(data))).toBe(true);
    expect((await client.downloadBlob(claimed)).status).toBe(404);
    expect((await client.downloadBlob(blobHash(impostor))).status).toBe(404);
    const item = await client.getItem(id);
    expect(item.ok).toBe(true);
    expect(item.data.item.properties.blob_ref).toBe(hash);
  });

  it("refuses an archive recording a source no credential can hold, and writes nothing", async () => {
    // The restore is the one door that copies `source` verbatim, and
    // `POST /keys` refuses the reserved prefix precisely so no key can
    // stamp one. Without this the restore would be the way around that: a
    // row could be planted carrying `oauth:`, and would read ever after as
    // written by a grant that never existed.
    //
    // Refused whole, like the state check beside it, so the answer is
    // never half a restore.
    const fine = uuidv7();
    const planted = uuidv7();
    const refused = await operator.restoreArchive(
      itemsArchive([
        {
          id: fine,
          type: "core.note",
          source: ctx.source,
          properties: { body: "an ordinary row ahead of the bad one" },
        },
        {
          id: planted,
          type: "core.note",
          source: "oauth:client:person",
          properties: { body: "a row claiming an app wrote it" },
        },
      ]),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain(planted);
    expect((await client.getItem(fine)).status).toBe(404);
    expect((await client.getItem(planted)).status).toBe(404);

    // **Before anything is written, and the blob is what proves it.**
    // The items are the last thing a restore writes: its blobs and its
    // type registrations land first, so a check that ran late would
    // still answer `400` while leaving both behind. A refused archive
    // that has already put bytes in the store is a refusal in name.
    const bytes = new TextEncoder().encode(
      `a blob no refused archive should land ${ctx.runId}`,
    );
    const hash = blobHash(bytes);
    expect((await client.downloadBlob(hash)).status).toBe(404);

    const withBlob = await operator.restoreArchive(
      itemsArchive(
        [
          {
            id: uuidv7(),
            type: "core.note",
            source: "oauth:client:person",
            properties: { body: "a row claiming an app wrote it" },
          },
        ],
        [{ data: bytes, mime_type: "text/plain" }],
      ),
    );
    expect(withBlob.status).toBe(400);
    expect(withBlob.error?.error.code).toBe("validation_error");
    expect(
      (await client.downloadBlob(hash)).status,
      "a refused archive left its blob bytes in the store",
    ).toBe(404);

    // The witness. The same two rows with an ordinary source restore, so
    // what was refused is the source and not the archive.
    const okFine = uuidv7();
    const okOther = uuidv7();
    const restored = await operator.restoreArchive(
      itemsArchive([
        {
          id: okFine,
          type: "core.note",
          source: ctx.source,
          properties: { body: "an ordinary row ahead of the bad one" },
        },
        {
          id: okOther,
          type: "core.note",
          source: ctx.source,
          properties: { body: "a row claiming an app wrote it" },
        },
      ]),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, okFine);
    trackItem(ctx, okOther);
    expect((await client.getItem(okFine)).status).toBe(200);
    expect((await client.getItem(okOther)).status).toBe(200);
  });

  it("refuses an archive recording a state the type's lifecycle cannot produce, and writes nothing", async () => {
    // `revoked` is a state, and not one the canonical lifecycle reaches, so
    // a note recorded in it is a row no door could have written. The whole
    // archive is refused, the note ahead of the bad row included.
    const fine = uuidv7();
    const impossible = uuidv7();
    const rows = (state: string) => [
      {
        id: fine,
        type: "core.note",
        source: ctx.source,
        state: "archived",
        properties: { body: "Archived note" },
      },
      {
        id: impossible,
        type: "core.note",
        source: ctx.source,
        state,
        properties: { body: `Note in ${state}` },
      },
    ];
    const refused = await operator.restoreArchive(
      itemsArchive(rows("revoked")),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain(impossible);
    expect((await client.getItem(fine)).status).toBe(404);
    expect((await client.getItem(impossible)).status).toBe(404);

    // A `system.*` row's lifecycle is `active | revoked`: `trashed` is a
    // state, and not one it can be in. No door writes such a row, which is
    // why an export never carries one and only a built archive can ask.
    // The same row restored in `active` is the server suite's witness
    // (`routes/items-lifecycle-graph.test.ts`), not this file's: no door
    // the referee holds could remove a system row it restored.
    const systemId = uuidv7();
    const systemRefused = await operator.restoreArchive(
      itemsArchive([
        {
          id: systemId,
          type: "system.webhook",
          source: ctx.source,
          state: "trashed",
          properties: {
            url: "https://example.test/recorded-in-a-state-it-cannot-be-in",
            events: ["item.created"],
          },
        },
      ]),
    );
    expect(systemRefused.status).toBe(400);
    expect(systemRefused.error?.error.message).toContain(systemId);
    expect(systemRefused.error?.error.message).toContain(
      '"active" to "trashed"',
    );
    expect((await client.getItem(systemId)).status).toBe(404);

    // A value that is no state at all is refused the same way, since the
    // store would otherwise write it as it came.
    const numbered = uuidv7();
    const numeric = await operator.restoreArchive(
      itemsArchive([
        {
          id: numbered,
          type: "core.note",
          source: ctx.source,
          state: 5 as unknown as string,
          properties: { body: "Numbered note" },
        },
      ]),
    );
    expect(numeric.status).toBe(400);
    expect(numeric.error?.error.message).toContain('Invalid target state "5"');
    expect((await client.getItem(numbered)).status).toBe(404);

    // The same two rows in states the lifecycle contains restore, each in
    // the state the archive recorded.
    const restored = await operator.restoreArchive(
      itemsArchive(rows("active")),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, fine);
    trackItem(ctx, impossible);
    expect(restored.data.imported).toBe(2);
    expect((await client.getItem(fine)).data.item.state).toBe("archived");
    expect((await client.getItem(impossible)).data.item.state).toBe("active");
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
