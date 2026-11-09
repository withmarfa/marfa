/**
 * Conformance for POST /restore.
 *
 * The round trip is end to end: the server builds the archive via
 * GET /export?format=archive and accepts it back via
 * POST /restore, which is what proves the manifest contract
 * and blob-hash verification agree.
 *
 * The rest build their archive with `utils/archive.ts` instead: a row no
 * door writes, so no export carries it; a blob the instance does not hold
 * yet, which is what makes its restore the thing that puts the bytes there;
 * a format version no build of this contract writes; and a manifest
 * missing or mistyping a field the restore reads.
 */

import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import {
  tar,
  lineFile,
  listEntries,
  readEntry,
  readLineFile,
  itemsArchive,
  blobHash,
  type ArchiveFile,
  type LineFile,
} from "../../utils/archive.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOwnerClient,
  trackEdgeType,
  trackItem,
  trackKey,
  trackType,
  cleanup,
} from "../../utils/setup.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
/** The file's own credential, for the export half. */
let fileKey: string;
/** The local command's client, for the restore half. */
let owner: MarfaClient;

beforeAll(async () => {
  const setup = await createTestContext("compliance", "restore-archive");
  ({ ctx, client, apiUrl } = setup);
  fileKey = setup.apiKey;
  owner = getOwnerClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("restore", () => {
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

    // Fetch the archive the server produces, scoped to this file's own
    // credential-stamped `source`, which keeps other files' rows out of it.
    const url = `${apiUrl}/export?source=${encodeURIComponent(ctx.source)}&format=archive`;
    const archiveRes = await fetch(url, {
      headers: { Authorization: `Bearer ${fileKey}` },
    });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.headers.get("Content-Type")).toBe("application/x-tar");
    const archiveBytes = new Uint8Array(await archiveRes.arrayBuffer());
    expect(archiveBytes.byteLength).toBeGreaterThan(0);

    // Post it back. The archive holds only this file's source-scoped
    // items; the seeded `(source, source_id)` pair matches the row
    // already there, so it dedupes — that's the assertion proving
    // archive → restore rebuilds the same shape the export emitted.
    const restored = await owner.restoreArchive(archiveBytes);
    expect(restored.ok).toBe(true);
    expect(restored.data.duplicates).toBeGreaterThanOrEqual(1);
    expect(restored.data.blobs_imported).toBe(0);
    await expectMatchesSchema("POST", "/restore", 200, restored.data);
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

    expect((await owner.downloadBlob(hash)).status).toBe(404);
    const restored = await owner.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    expect(restored.data).toMatchObject({ imported: 1, blobs_imported: 1 });

    const read = await client.downloadBlob(hash);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/x-drill");
    expect(Buffer.from(read.data).equals(Buffer.from(data))).toBe(true);
    expect((await owner.downloadBlob(claimed)).status).toBe(404);
    expect((await owner.downloadBlob(blobHash(impostor))).status).toBe(404);
    const item = await client.getItem(id);
    expect(item.ok).toBe(true);
    expect(item.data.item.properties.blob_ref).toBe(hash);
  });

  it("rewrites app sources exactly and accepts previously restored sources", async () => {
    for (const source of [
      "oauth:client:person",
      " OAuth:client:person ",
      "restored:oauth:client:person",
      " Restored:oauth:client:person ",
    ]) {
      const id = uuidv7();
      const restored = await owner.restoreArchive(
        itemsArchive([
          {
            id,
            type: "core.note",
            source,
            properties: { body: "app history" },
          },
        ]),
      );
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      trackItem(ctx, id);
      const row = await client.getItem(id);
      expect(row.status).toBe(200);
      expect(row.data.item.source).toBe(
        source.trim().toLowerCase().startsWith("oauth:")
          ? `restored:${source}`
          : source,
      );
    }
  });

  it("keeps a blob whose manifest names a type no header can carry under application/octet-stream", async () => {
    const data = new Uint8Array(randomBytes(40));
    const hash = blobHash(data);
    const restored = await owner.restoreArchive(
      itemsArchive([], [{ data, mime_type: "text/\ud83d\ude00" }]),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    const read = await owner.downloadBlob(hash);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(read.data)).toEqual(data);
    // An object store takes the type as a header too, so the blob is copied
    // there, and replication has nothing left.
    for (let run = 0; run < 20; run++) {
      const ran = await owner.runHousekeeping("blob-replicate");
      if (ran.status === 409) continue;
      expect(ran.status, JSON.stringify(ran.error)).toBe(200);
      const left = (ran.data.result as { remaining: number }).remaining;
      const copies = await owner.listBlobCopies(hash);
      if (left === 0 && copies.data.data.some((copy) => copy.kind === "s3"))
        return;
    }
    throw new Error("replication never copied the restored blob");
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
    const refused = await owner.restoreArchive(itemsArchive(rows("revoked")));
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain(impossible);
    expect((await client.getItem(fine)).status).toBe(404);
    expect((await client.getItem(impossible)).status).toBe(404);

    // A `system.*` row's lifecycle is `active | revoked`: `trashed` is a
    // state, and not one it can be in. No door writes such a row, which is
    // why an export never carries one and only a built archive can ask.
    // The same row restored in `active` is not tried here: no door the
    // referee holds could remove a system row it restored.
    const systemId = uuidv7();
    const systemRefused = await owner.restoreArchive(
      itemsArchive([
        {
          id: systemId,
          type: "system.folder",
          source: ctx.source,
          state: "trashed",
          properties: { title: "recorded in a state it cannot be in" },
        },
      ]),
    );
    expect(systemRefused.status).toBe(400);
    expect(systemRefused.error?.error.message).toContain(systemId);
    expect(systemRefused.error?.error.details?.field).toBe("state");
    expect((await client.getItem(systemId)).status).toBe(404);

    // A value that is no state at all is refused the same way, since the
    // store would otherwise write it as it came.
    const numbered = uuidv7();
    const numeric = await owner.restoreArchive(
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
    expect(numeric.error?.error.message).toContain(numbered);
    expect(numeric.error?.error.details?.field).toBe("state");
    expect((await client.getItem(numbered)).status).toBe(404);

    // The same two rows in states the lifecycle contains restore, each in
    // the state the archive recorded.
    const restored = await owner.restoreArchive(itemsArchive(rows("active")));
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, fine);
    trackItem(ctx, impossible);
    expect(restored.data.imported).toBe(2);
    expect((await client.getItem(fine)).data.item.state).toBe("archived");
    expect((await client.getItem(impossible)).data.item.state).toBe("active");
  });

  it("refuses a manifest missing or mistyping a field the restore reads, naming the field, and writes nothing", async () => {
    // Each archive carries a blob and a row naming it, so a manifest whose
    // `blobs` the restore could not read is asked about the one blob entry
    // that reads it.
    const data = new Uint8Array(randomBytes(32));
    const hash = blobHash(data);
    const id = uuidv7();
    const archive = (reshape: (m: Record<string, unknown>) => unknown) =>
      itemsArchive(
        [
          {
            id,
            type: "core.file",
            source: ctx.source,
            source_id: `archive-manifest-${ctx.runId}`,
            properties: { blob_ref: hash, mime_type: "text/plain" },
          },
        ],
        [{ data, mime_type: "text/plain" }],
        [],
        reshape,
      );
    const without = (m: Record<string, unknown>, field: string) =>
      Object.fromEntries(Object.entries(m).filter(([key]) => key !== field));
    const cases: {
      reshape: (m: Record<string, unknown>) => unknown;
      path: string;
    }[] = [
      { reshape: (m) => without(m, "blobs"), path: "blobs" },
      { reshape: (m) => ({ ...m, blobs: [] }), path: "blobs" },
      {
        reshape: (m) => ({
          ...m,
          blobs: { [hash]: { mime_type: null, size_bytes: data.length } },
        }),
        path: `blobs.${hash}.mime_type`,
      },
      {
        reshape: (m) => ({
          ...m,
          blobs: { [hash]: { mime_type: "text/plain", size_bytes: "32" } },
        }),
        path: `blobs.${hash}.size_bytes`,
      },
      { reshape: (m) => ({ ...m, missing_blobs: [] }), path: "missing_blobs" },
      {
        reshape: (m) => ({
          ...m,
          missing_blobs: {
            [hash]: { mime_type: "text/plain", size_bytes: -1 },
          },
        }),
        path: `missing_blobs.${hash}.size_bytes`,
      },
      { reshape: (m) => without(m, "version"), path: "version" },
      { reshape: (m) => ({ ...m, version: "0" }), path: "version" },
    ];

    for (const { reshape, path } of cases) {
      const refused = await owner.restoreArchive(archive(reshape));
      expect(refused.status, path).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.message).toContain(path);
      const errors = refused.error?.error.details?.errors as
        { path: string }[] | undefined;
      expect(errors?.map((e) => e.path)).toContain(path);
      expect((await client.getItem(id)).status).toBe(404);
      expect((await owner.downloadBlob(hash)).status).toBe(404);
    }

    // The same archive under the manifest as built restores, row and blob.
    const restored = await owner.restoreArchive(archive((m) => m));
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    expect(restored.data).toMatchObject({ imported: 1, blobs_imported: 1 });
    expect((await client.downloadBlob(hash)).status).toBe(200);
  });

  it("refuses an archive at another format version, saying it is read only by the build that wrote it", async () => {
    // Every version inside Marfa is 0 until the first public release, so
    // an archive naming any other is one no build of this contract wrote.
    const witness = uuidv7();
    const other = uuidv7();
    const archiveAt = (version: number, id: string): Uint8Array => {
      const zero = itemsArchive([
        {
          id,
          type: "core.note",
          source: ctx.source,
          properties: { body: `an archived row at format ${version}` },
        },
      ]);
      const manifest = readEntry(zero, "manifest.json");
      const items = readLineFile(zero, "items");
      if (manifest === null || items === null) {
        throw new Error("the archive helper wrote no manifest or no items");
      }
      return tar([
        {
          name: "manifest.json",
          body: JSON.stringify({
            ...(JSON.parse(manifest) as Record<string, unknown>),
            version,
            format: `marfa-archive-v${version}`,
          }),
        },
        lineFile("instance", ""),
        lineFile("items", items),
        lineFile("edges", ""),
      ]);
    };

    // The witness: the same archive at version 0 restores, so what is
    // refused below is the version and nothing else.
    const restored = await owner.restoreArchive(archiveAt(0, witness));
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, witness);
    expect(restored.data.imported).toBe(1);

    const refused = await owner.restoreArchive(archiveAt(1, other));
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain(
      "read only by the build that wrote it",
    );
    expect((await client.getItem(other)).status).toBe(404);
  });

  /** One archived note of this file's source, as an `items.ndjson.gz` line. */
  const archivedLine = (id: string, body: string): string => {
    const lines = readLineFile(
      itemsArchive([
        { id, type: "core.note", source: ctx.source, properties: { body } },
      ]),
      "items",
    );
    if (lines === null) throw new Error("the archive helper wrote no items");
    return lines.trimEnd();
  };
  const manifest = {
    name: "manifest.json",
    body: JSON.stringify({ version: 0, format: "marfa-archive-v0", blobs: {} }),
  };
  /** An archive of `items`, its other line files empty, then `rest`. */
  const around = (items: ArchiveFile[], rest: ArchiveFile[] = []): Uint8Array =>
    tar([
      manifest,
      lineFile("instance", ""),
      ...items,
      lineFile("edges", ""),
      ...rest,
    ]);

  it("steps past an entry it does not read", async () => {
    const id = uuidv7();
    const restored = await owner.restoreArchive(
      around(
        [lineFile("items", archivedLine(id, "beside padding") + "\n")],
        [{ name: "padding.bin", body: new Uint8Array(16 * 1024 * 1024) }],
      ),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    expect(restored.data.imported).toBe(1);
  });

  it("refuses a line longer than 64 MiB, and writes nothing", async () => {
    const id = uuidv7();
    const refused = await owner.restoreArchive(
      around([
        lineFile(
          "items",
          Buffer.concat([
            Buffer.from(archivedLine(id, "ahead of a long line") + "\n"),
            Buffer.alloc(64 * 1024 * 1024 + 1, "x"),
          ]),
        ),
      ]),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain("Line 2 of items.ndjson.gz");
    expect(refused.error?.error.details?.entry).toBe("items.ndjson.gz");
    expect((await client.getItem(id)).status).toBe(404);
  });

  it("refuses an archive carrying an entry twice, and writes nothing", async () => {
    const first = uuidv7();
    const second = uuidv7();
    const items = (id: string, body: string) =>
      lineFile("items", archivedLine(id, body) + "\n");
    const refused = await owner.restoreArchive(
      around([items(first, "first copy"), items(second, "second copy")]),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain(
      "items.ndjson.gz more than once",
    );
    expect((await client.getItem(first)).status).toBe(404);
    expect((await client.getItem(second)).status).toBe(404);

    // The witness: either copy alone restores.
    const restored = await owner.restoreArchive(
      around([items(first, "first copy")]),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, first);
    expect(restored.data.imported).toBe(1);
  });

  it("requires local authority", async () => {
    // A credential holding write on every type. Restoring takes the local
    // command, which is a different thing from holding every permission:
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

    // A zero-length body is rejected before the owner check, so build a real
    // minimal archive to isolate the 403 path. Reuse the server-built archive,
    // valid by construction and scoped to this file's own `source`: this case
    // needs only *a* valid body, and an unscoped export is work it has no use
    // for. Without file bytes it stays under the request cap, so the server
    // reads all of it before it closes the connection.
    const url = `${apiUrl}/export?source=${encodeURIComponent(ctx.source)}&format=archive&files=false`;
    const archiveRes = await fetch(url, {
      headers: { Authorization: `Bearer ${fileKey}` },
    });
    const archiveBytes = new Uint8Array(await archiveRes.arrayBuffer());
    expect(archiveRes.status).toBe(200);
    expect(archiveBytes.byteLength).toBeLessThan(1024 * 1024);

    const res = await scoped.restoreArchive(archiveBytes);
    expect(res.status).toBe(403);
    expect(res.error?.error.code).toBe("forbidden");
  });
});

/** The archive with one line file's lines replaced, every other entry as it was. */
function withLines(
  archive: Uint8Array,
  file: LineFile,
  lines: string,
): Uint8Array {
  const replaced = lineFile(file, lines);
  return tar(
    listEntries(archive).map((entry) =>
      entry.name === replaced.name ? replaced : entry,
    ),
  );
}

describe("an archive that lacks a member", () => {
  const MEMBERS = [
    "manifest.json",
    "instance.ndjson.gz",
    "items.ndjson.gz",
    "edges.ndjson.gz",
  ];

  /** An archive of one note and one blob that a restore would write. */
  function carrying() {
    const id = uuidv7();
    const bytes = new Uint8Array(randomBytes(64));
    const hash = blobHash(bytes);
    const archive = itemsArchive(
      [
        {
          id,
          type: "core.file",
          source: ctx.source,
          properties: { blob_ref: hash, mime_type: "application/x-lack" },
        },
      ],
      [{ data: bytes, mime_type: "application/x-lack" }],
    );
    return { id, hash, archive };
  }
  const without = (archive: Uint8Array, member: string): Uint8Array =>
    tar(listEntries(archive).filter((entry) => entry.name !== member));

  it.each(MEMBERS)(
    "refuses an archive without %s, naming it, and writes nothing",
    async (member) => {
      const { id, hash, archive } = carrying();
      const refused = await owner.restoreArchive(without(archive, member));
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.message).toContain(member);
      expect(refused.error?.error.details?.entries).toEqual([member]);
      expect((await client.getItem(id)).status).toBe(404);
      expect((await owner.downloadBlob(hash)).status).toBe(404);

      // The witness: the same archive with the member restores the row and
      // the blob that the refusal left unwritten.
      const restored = await owner.restoreArchive(archive);
      expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
      trackItem(ctx, id);
      expect(restored.data).toMatchObject({ imported: 1, blobs_imported: 1 });
      expect((await client.getItem(id)).status).toBe(200);
      expect((await owner.downloadBlob(hash)).status).toBe(200);
    },
  );

  it("refuses a tar that is no archive, naming every member it lacks", async () => {
    const unrelated = tar([{ name: "notes.txt", body: "not an archive" }]);
    const refused = await owner.restoreArchive(unrelated);
    expect(refused.status, JSON.stringify(refused.error)).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    for (const member of MEMBERS) {
      expect(refused.error?.error.message).toContain(member);
    }
    expect(refused.error?.error.details?.entries).toEqual(MEMBERS);

    // The witness: the same tar with the four members, all empty, is an
    // archive of nothing and restores as one.
    const nothing = await owner.restoreArchive(
      tar([
        { name: "notes.txt", body: "not an archive" },
        {
          name: "manifest.json",
          body: JSON.stringify({
            version: 0,
            format: "marfa-archive-v0",
            blobs: {},
          }),
        },
        lineFile("instance", ""),
        lineFile("items", ""),
        lineFile("edges", ""),
      ]),
    );
    expect(nothing.ok, JSON.stringify(nothing.error)).toBe(true);
    expect(nothing.data).toMatchObject({ imported: 0, edges_imported: 0 });
  });
});

describe("an archived item that no instance wrote", () => {
  const line = (item: Record<string, unknown>): string =>
    `${JSON.stringify({ item: { source: ctx.source, ...item }, metadata: { tags: [], extensions: {} } })}\n`;

  it("refuses an item whose type is no identifier or whose properties are no object, and writes nothing", async () => {
    const witness = uuidv7();
    const good = line({
      id: witness,
      type: "user.never_registered",
      properties: { anything: [1, { a: 2 }] },
    });
    const cases: [string, Record<string, unknown>, string, string][] = [
      ["no type", { properties: {} }, "validation_error", "type"],
      [
        "a type that is no identifier",
        { type: "Not A Type", properties: {} },
        "validation_error",
        "type",
      ],
      [
        "properties that are a list",
        { type: "user.never_registered", properties: [1, 2] },
        "invalid_properties",
        "properties",
      ],
      [
        "properties that are a string",
        { type: "core.note", properties: "body" },
        "invalid_properties",
        "properties",
      ],
    ];
    for (const [what, item, code, field] of cases) {
      const id = uuidv7();
      const refused = await owner.restoreArchive(
        withLines(itemsArchive([]), "items", good + line({ id, ...item })),
      );
      expect(refused.status, `${what}: ${JSON.stringify(refused.error)}`).toBe(
        400,
      );
      expect(refused.error?.error.code, what).toBe(code);
      expect(refused.error?.error.message, what).toContain(id);
      expect(refused.error?.error.message, what).toContain(field);
      // The row ahead of it is not written either.
      expect((await client.getItem(witness)).status, what).toBe(404);
      expect((await client.getItem(id)).status, what).toBe(404);
    }

    // The witness: the first line alone, an item of a type nothing
    // registers, restores.
    const restored = await owner.restoreArchive(
      withLines(itemsArchive([]), "items", good),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, witness);
    expect(restored.data.imported).toBe(1);
    expect((await client.getItem(witness)).status).toBe(200);
  });
});

describe("a body that is no archive", () => {
  /** An archive of one note that would restore, so a refusal can be told from
   *  an empty restore by the row it did not write, and where its items file
   *  sits in the tar, so a test can damage the middle of a compressed stream. */
  function oneNote(): {
    id: string;
    archive: Uint8Array;
    items: number;
    length: number;
  } {
    const id = uuidv7();
    // Random text the gzip stream cannot shrink much, so there is a middle to damage.
    const body = randomBytes(192 * 1024).toString("base64");
    const archive = itemsArchive([
      { id, type: "core.note", source: ctx.source, properties: { body } },
    ]);
    const entry = listEntries(archive).find(
      (one) => one.name === "items.ndjson.gz",
    );
    if (entry === undefined)
      throw new Error("the archive helper wrote no items");
    const items = Buffer.from(archive).indexOf(Buffer.from(entry.body));
    return { id, archive, items, length: entry.body.length };
  }

  it("refuses an empty body, and takes an archive of nothing", async () => {
    const refused = await owner.restoreArchive(new Uint8Array(0));
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");

    // The witness: an archive that carries no row is not an empty body.
    const nothing = await owner.restoreArchive(itemsArchive([]));
    expect(nothing.ok, JSON.stringify(nothing.error)).toBe(true);
    expect(nothing.data).toMatchObject({ imported: 0, duplicates: 0 });
  });

  it("refuses a body that is not a tar, or whose line file breaks partway, and goes on serving", async () => {
    const whole = oneNote();
    const bytes = Buffer.from(whole.archive);
    const middle = whole.items + Math.floor(whole.length / 2);
    const damaged = Buffer.from(bytes);
    randomBytes(64).copy(damaged, middle);
    const bodies: [string, Uint8Array][] = [
      ["bytes that are not a tar", new Uint8Array(randomBytes(4096))],
      [
        "a gzip stream of text, which is no tar",
        new Uint8Array(gzipSync(Buffer.from("not a tar ".repeat(200)))),
      ],
      ["an archive cut short", new Uint8Array(bytes.subarray(0, middle))],
      [
        "an items file whose compressed stream breaks partway",
        new Uint8Array(damaged),
      ],
    ];

    // The witness: the whole archive restores and writes its row.
    const restored = await owner.restoreArchive(whole.archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data.imported).toBe(1);
    trackItem(ctx, whole.id);
    expect((await client.getItem(whole.id)).status).toBe(200);
    expect((await client.deleteItem(whole.id)).ok).toBe(true);
    expect((await client.purgeItem(whole.id)).ok).toBe(true);
    expect((await client.getItem(whole.id)).status).toBe(404);

    for (const [what, body] of bodies) {
      const refused = await owner.restoreArchive(body);
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("validation_error");
      expect((await client.getItem(whole.id)).status, what).toBe(404);
      const health = await client.rawRequest<{ status: string }>("/health");
      expect(health.status, `${what}: the server stopped answering`).toBe(200);
    }
    const after = await owner.restoreArchive(whole.archive);
    expect(after.ok, JSON.stringify(after.error)).toBe(true);
    expect(after.data.imported).toBe(1);
  });
});

describe("what a restore answers", () => {
  const edgeType = (id: string) => ({
    id,
    label: "Test edge type",
    cardinality: "many-to-many",
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
    cascade_on_delete: "orphan",
    property_schema: {},
    written_at: "source",
  });

  /** A type, an edge type, a blob, two notes and an edge between them. */
  function carrying(ids: { type: string; edgeType: string }) {
    const a = uuidv7();
    const b = uuidv7();
    const edgeId = uuidv7();
    const bytes = new Uint8Array(randomBytes(48));
    const hash = blobHash(bytes);
    const base = itemsArchive(
      [a, b].map((id) => ({
        id,
        type: ids.type,
        source: ctx.source,
        properties: { label: `answer ${id}`, blob: hash },
      })),
      [{ data: bytes, mime_type: "application/octet-stream" }],
      [
        {
          id: ids.type,
          label: "Answer",
          version: 1,
          fields: { label: { type: "string" }, blob: { type: "string" } },
        },
      ],
    );
    const edges = (extra: Record<string, unknown>[] = []) =>
      [
        { id: edgeId, source_id: a, target_id: b, edge_type: ids.edgeType },
        ...extra,
      ]
        .map((edge) => `${JSON.stringify({ edge })}\n`)
        .join("");
    const types = `${JSON.stringify({
      type: {
        id: ids.type,
        label: "Answer",
        version: 1,
        fields: { label: { type: "string" }, blob: { type: "string" } },
      },
    })}\n${JSON.stringify({ edge_type: edgeType(ids.edgeType) })}\n`;
    const archive = (extraEdges: Record<string, unknown>[] = []) =>
      withLines(withLines(base, "edges", edges(extraEdges)), "instance", types);
    return { a, b, edgeId, hash, archive };
  }

  it("answers the restore result fields on the first restore and on a repeat", async () => {
    const ids = {
      type: `user.restoreanswer${ctx.runId}`,
      edgeType: `restoreanswer.${ctx.runId}`,
    };
    const rows = carrying(ids);
    trackItem(ctx, rows.a);
    trackItem(ctx, rows.b);
    trackType(ctx, ids.type);
    trackEdgeType(ctx, ids.edgeType);

    const first = await owner.restoreArchive(rows.archive());
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    expect(Object.keys(first.data).sort()).toEqual(
      [
        "blobs_imported",
        "blobs_missing",
        "duplicates",
        "edge_types_registered",
        "edge_types_skipped",
        "edges_imported",
        "edges_skipped",
        "edges_skipped_reasons",
        "imported",
        "type_icons_added",
        "type_icons_skipped",
        "type_icons_skipped_reasons",
        "sources_added",
        "sources_skipped",
        "sources_skipped_reasons",
        "types_registered",
        "types_skipped",
        "settings_added",
        "settings_skipped",
        "connector_states_added",
        "connector_states_skipped",
        "connector_agreements_added",
        "connector_agreements_skipped",
        "set_up_again",
      ].sort(),
    );
    expect(first.data.set_up_again).toContain(
      "sign-in, keys, apps or webhooks",
    );
    expect(first.data).toEqual({
      imported: 2,
      duplicates: 0,
      edges_imported: 1,
      edges_skipped: 0,
      edges_skipped_reasons: {},
      blobs_imported: 1,
      blobs_missing: [],
      types_registered: 1,
      types_skipped: 0,
      edge_types_registered: 1,
      edge_types_skipped: 0,
      type_icons_added: 0,
      type_icons_skipped: 0,
      type_icons_skipped_reasons: {},
      sources_added: 0,
      sources_skipped: 0,
      sources_skipped_reasons: {},
      settings_added: 0,
      settings_skipped: 0,
      connector_states_added: 0,
      connector_states_skipped: 0,
      connector_agreements_added: 0,
      connector_agreements_skipped: 0,
      set_up_again: expect.any(String),
    });
    await expectMatchesSchema("POST", "/restore", 200, first.data);

    // The same archive again, with an edge naming a row it does not carry and
    // one naming no kind of edge.
    const again = await owner.restoreArchive(
      rows.archive([
        {
          id: uuidv7(),
          source_id: rows.a,
          target_id: uuidv7(),
          edge_type: ids.edgeType,
        },
        { id: uuidv7(), source_id: rows.a, target_id: rows.b },
      ]),
    );
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(again.data).toEqual({
      imported: 0,
      duplicates: 2,
      edges_imported: 0,
      edges_skipped: 3,
      edges_skipped_reasons: {
        already_present: 1,
        endpoint_missing: 1,
        malformed: 1,
      },
      blobs_imported: 1,
      blobs_missing: [],
      types_registered: 0,
      types_skipped: 1,
      edge_types_registered: 0,
      edge_types_skipped: 1,
      type_icons_added: 0,
      type_icons_skipped: 0,
      type_icons_skipped_reasons: {},
      sources_added: 0,
      sources_skipped: 0,
      sources_skipped_reasons: {},
      settings_added: 0,
      settings_skipped: 0,
      connector_states_added: 0,
      connector_states_skipped: 0,
      connector_agreements_added: 0,
      connector_agreements_skipped: 0,
      set_up_again: expect.any(String),
    });
    await expectMatchesSchema("POST", "/restore", 200, again.data);
  });

  it("restores an archived edge whose properties break its edge type's property_schema, and counts it as imported", async () => {
    const edgeTypeId = `restoreschema.${ctx.runId}`;
    trackEdgeType(ctx, edgeTypeId);
    const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()];
    const [fits, wrongType, noLabel] = [uuidv7(), uuidv7(), uuidv7()];
    const base = itemsArchive(
      [a, b, c].map((id) => ({
        id,
        type: "core.note",
        source: ctx.source,
        properties: { body: `schema ${id}` },
      })),
    );
    const edge = (id: string, target: string, properties: object) => ({
      id,
      source_id: a,
      target_id: target,
      edge_type: edgeTypeId,
      properties,
    });
    const archive = withLines(
      withLines(
        base,
        "edges",
        [
          edge(fits, b, { label: "fits" }),
          edge(wrongType, c, { label: "x", weight: "heavy" }),
          edge(noLabel, uuidv7(), {}),
        ]
          .map((line) => `${JSON.stringify({ edge: line })}\n`)
          .join(""),
      ),
      "instance",
      `${JSON.stringify({
        edge_type: {
          ...edgeType(edgeTypeId),
          property_schema: {
            label: { type: "string", required: true },
            weight: { type: "number" },
          },
        },
      })}\n`,
    );
    trackItem(ctx, a);
    trackItem(ctx, b);
    trackItem(ctx, c);
    const restored = await owner.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data).toMatchObject({
      imported: 3,
      edges_imported: 2,
      edges_skipped: 1,
      edges_skipped_reasons: { endpoint_missing: 1 },
    });
    expect((await client.getEdge(fits)).status).toBe(200);
    const kept = await client.getEdge(wrongType);
    expect(kept.status).toBe(200);
    expect(kept.data.edge.properties).toEqual({ label: "x", weight: "heavy" });
  });

  it("counts an edge that POST /edges would refuse under the code of its refusal, and keeps one whose type nothing registers", async () => {
    const [a, b] = [uuidv7(), uuidv7()];
    const [fits, loop, unknown, bound] = [
      uuidv7(),
      uuidv7(),
      uuidv7(),
      uuidv7(),
    ];
    const archive = withLines(
      itemsArchive(
        [a, b].map((id) => ({
          id,
          type: "core.note",
          source: ctx.source,
          properties: { body: `refused ${id}` },
        })),
      ),
      "edges",
      [
        { id: fits, source_id: a, target_id: b, edge_type: "references" },
        { id: loop, source_id: a, target_id: a, edge_type: "references" },
        {
          id: unknown,
          source_id: b,
          target_id: a,
          edge_type: `restorekept.${ctx.runId}`,
        },
        // A registered edge type still holds its constraints: a note is no
        // collection.
        { id: bound, source_id: a, target_id: b, edge_type: "in-collection" },
      ]
        .map((edge) => `${JSON.stringify({ edge })}\n`)
        .join(""),
    );
    trackItem(ctx, a);
    trackItem(ctx, b);
    const restored = await owner.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data).toMatchObject({
      imported: 2,
      edges_imported: 2,
      edges_skipped: 2,
    });
    expect(restored.data.edges_skipped_reasons).toEqual({
      edge_cycle: 1,
      edge_constraint_violation: 1,
    });
    expect((await client.getEdge(fits)).status).toBe(200);
    expect((await client.getEdge(loop)).status).toBe(404);
    expect((await client.getEdge(bound)).status).toBe(404);
    const kept = await client.getEdge(unknown);
    expect(kept.status).toBe(200);
    expect(kept.data.edge.edge_type).toBe(`restorekept.${ctx.runId}`);
  });

  it("refuses an archive that registers a type or an edge type this instance holds differently, naming each, and writes nothing", async () => {
    const ids = {
      type: `user.restoreconflict${ctx.runId}`,
      edgeType: `restoreconflict.${ctx.runId}`,
    };
    const held = carrying(ids);
    trackItem(ctx, held.a);
    trackItem(ctx, held.b);
    trackType(ctx, ids.type);
    trackEdgeType(ctx, ids.edgeType);
    const taken = await owner.restoreArchive(held.archive());
    expect(taken.ok, JSON.stringify(taken.error)).toBe(true);

    // The same two ids, defined another way, beside a type nothing holds.
    const fresh = {
      type: `user.restorefresh${ctx.runId}`,
      id: uuidv7(),
    };
    const types = [
      {
        type: {
          id: ids.type,
          label: "Answer",
          version: 1,
          fields: { label: { type: "integer" } },
        },
      },
      { edge_type: { ...edgeType(ids.edgeType), cardinality: "one-to-one" } },
      {
        type: {
          id: fresh.type,
          label: "Fresh",
          version: 1,
          fields: { label: { type: "string" } },
        },
      },
    ];
    const redefining = withLines(
      itemsArchive([
        {
          id: fresh.id,
          type: fresh.type,
          source: ctx.source,
          properties: { label: "a row of a type the archive registers" },
        },
      ]),
      "instance",
      types.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    const refused = await owner.restoreArchive(redefining);
    expect(refused.status, JSON.stringify(refused.error)).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
    expect(refused.error?.error.details?.conflicting_ids).toEqual(
      expect.arrayContaining([ids.type, ids.edgeType]),
    );
    expect((await client.getType(fresh.type)).status).toBe(404);
    expect((await client.getItem(fresh.id)).status).toBe(404);
    const held_ = await client.getType(ids.type);
    expect(held_.data.fields).toEqual({
      label: { type: "string", label: "Label" },
      blob: { type: "string", label: "Blob" },
    });
  });

  it("refuses an archive that carries a core edge type with 409 conflict", async () => {
    const archive = tar([
      {
        name: "manifest.json",
        body: JSON.stringify({
          version: 0,
          format: "marfa-archive-v0",
          created_at: new Date().toISOString(),
          item_count: 0,
          edge_count: 0,
          blob_count: 0,
          type_count: 0,
          edge_type_count: 1,
          blobs: {},
        }),
      },
      lineFile(
        "instance",
        `${JSON.stringify({ edge_type: { id: "about", label: "About" } })}\n`,
      ),
      lineFile("items", ""),
      lineFile("edges", ""),
    ]);
    const restored = await owner.restoreArchive(archive);
    expect(restored.status).toBe(409);
    expect(restored.error?.error.code).toBe("conflict");
    await expectMatchesSchema("POST", "/restore", 409, restored.error);
  });
});

describe("a restore sent under text/plain", () => {
  it("takes an archive sent under text/plain, which a JSON door refuses when sent that way", async () => {
    // The witness: a JSON door refuses the same media type.
    const json = await fetch(`${apiUrl}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fileKey}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ type: "core.note", properties: { body: "x" } }),
    });
    expect(json.status).toBe(400);
    expect(
      ((await json.json()) as { error: { code: string } }).error.code,
    ).toBe("validation_error");

    const id = uuidv7();
    const archive = itemsArchive([
      {
        id,
        type: "core.note",
        source: ctx.source,
        source_id: `restore-text-plain-${ctx.runId}`,
        properties: { body: "restored under text/plain" },
      },
    ]);
    const res = await owner.rawRequest<{ imported: number }>("/restore", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: Buffer.from(archive),
    });
    trackItem(ctx, id);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data.imported).toBe(1);
  });
});

describe("a restore of a registration carrying a key the schema does not define", () => {
  it("refuses a type and an edge type that carry one, naming its path, and restores the same archive without it", async () => {
    const lines = (key: Record<string, unknown>, ids: [string, string]) => [
      {
        type: {
          id: ids[0],
          label: "Unread",
          version: 1,
          fields: { serves: { type: "integer", ...key } },
        },
      },
      {
        edge_type: {
          id: ids[1],
          label: "Test edge type",
          cardinality: "many-to-many",
          property_schema: { rank: { type: "number", ...key } },
        },
      },
    ];
    const archive = (key: Record<string, unknown>, ids: [string, string]) =>
      withLines(
        itemsArchive([]),
        "instance",
        lines(key, ids)
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
      );

    const refusedIds: [string, string] = [
      `user.restoreunread${ctx.runId}`,
      `restoreunread.${ctx.runId}`,
    ];
    for (const [what, path] of [
      ["type", "fields.serves.exclusiveMinimum"],
      ["edge type", "property_schema.rank.exclusiveMinimum"],
    ] as const) {
      const refused = await owner.restoreArchive(
        withLines(
          itemsArchive([]),
          "instance",
          `${JSON.stringify(
            lines({ exclusiveMinimum: 1 }, refusedIds)[what === "type" ? 0 : 1],
          )}\n`,
        ),
      );
      expect(refused.status, `${what}: ${JSON.stringify(refused.error)}`).toBe(
        400,
      );
      expect(refused.error?.error.code, what).toBe("invalid_schema");
      expect(
        (refused.error?.error.details?.errors as { field: string }[]).map(
          (error) => error.field,
        ),
        what,
      ).toEqual([path]);
    }
    expect((await client.getType(refusedIds[0])).status).toBe(404);

    // The witness: the same two registrations without the key restore.
    const mendedIds: [string, string] = [
      `user.restoremended${ctx.runId}`,
      `restoremended.${ctx.runId}`,
    ];
    trackType(ctx, mendedIds[0]);
    trackEdgeType(ctx, mendedIds[1]);
    const restored = await owner.restoreArchive(archive({}, mendedIds));
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data).toMatchObject({
      types_registered: 1,
      edge_types_registered: 1,
    });
  });
});

describe("a restore of an edge type's property formats", () => {
  const archiveOf = (id: string, property: Record<string, unknown>) =>
    withLines(
      itemsArchive([]),
      "instance",
      `${JSON.stringify({
        edge_type: {
          id,
          label: "Test edge type",
          cardinality: "many-to-many",
          property_schema: { contact: property },
        },
      })}\n`,
    );

  it("registers a string property with a format as the type of that format", async () => {
    const id = `restoreformat.${ctx.runId}`;
    trackEdgeType(ctx, id);
    const restored = await owner.restoreArchive(
      archiveOf(id, { type: "string", format: "email" }),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data).toMatchObject({ edge_types_registered: 1 });
    const listed = await client.listEdgeTypes();
    expect(listed.data.data.find((t) => t.id === id)?.property_schema).toEqual({
      contact: { type: "email" },
    });
  });

  it("refuses an archive whose edge type puts a format on a property it does not suit, naming the property, and registers nothing", async () => {
    const id = `restoremisfit.${ctx.runId}`;
    const refused = await owner.restoreArchive(
      archiveOf(id, { type: "number", format: "url" }),
    );
    expect(refused.status, JSON.stringify(refused.error)).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    expect(
      (refused.error?.error.details?.errors as { field: string }[]).map(
        (error) => error.field,
      ),
    ).toEqual(["property_schema.contact.format"]);
    const listed = await client.listEdgeTypes();
    expect(listed.data.data.map((t) => t.id)).not.toContain(id);

    // The witness: the same edge type with a property the format suits.
    trackEdgeType(ctx, id);
    const mended = await owner.restoreArchive(
      archiveOf(id, { type: "string", format: "url" }),
    );
    expect(mended.ok, JSON.stringify(mended.error)).toBe(true);
  });
});

describe("a restore refused after it began", () => {
  it("leaves no row, type, edge type, blob, event or audit record behind when a later row is refused", async () => {
    const ids = {
      type: `user.restorerollback${ctx.runId}`,
      edgeType: `restorerollback.${ctx.runId}`,
    };
    const bytes = new Uint8Array(randomBytes(64));
    const hash = blobHash(bytes);
    const notes = Array.from({ length: 10 }, () => uuidv7());
    const event = uuidv7();
    const archive = (rule: string) => {
      const base = itemsArchive(
        [
          ...notes.map((id) => ({
            id,
            type: ids.type,
            source: ctx.source,
            properties: { label: `before the refusal ${id}`, blob: hash },
          })),
          {
            id: event,
            type: "core.event",
            source: ctx.source,
            properties: {
              title: "the row that is refused",
              starts_at: "2041-01-15T09:00:00.000Z",
              recurrence: [rule],
            },
          },
        ],
        [{ data: bytes, mime_type: "application/octet-stream" }],
        [
          {
            id: ids.type,
            label: "Rollback",
            version: 1,
            fields: { label: { type: "string" }, blob: { type: "string" } },
          },
        ],
      );
      return withLines(
        base,
        "instance",
        [
          {
            type: {
              id: ids.type,
              label: "Rollback",
              version: 1,
              fields: { label: { type: "string" }, blob: { type: "string" } },
            },
          },
          {
            edge_type: {
              id: ids.edgeType,
              label: "Test edge type",
              cardinality: "many-to-many",
              source_type_constraints: ["*"],
              target_type_constraints: ["*"],
              cascade_on_delete: "orphan",
              property_schema: {},
              written_at: "source",
            },
          },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
      );
    };

    const { eventId, markerId } = await baselineEventId(
      apiUrl,
      fileKey,
      async () => {
        const marker = await client.createItem(
          createNote({ source: ctx.source }),
        );
        expect(marker.ok).toBe(true);
        return marker.data.item.id;
      },
    );
    trackItem(ctx, markerId);
    const idsOf = (events: { data?: unknown }[]) =>
      events.map(
        (e) => (e.data as { item?: { id?: string } } | undefined)?.item?.id,
      );

    const refused = await owner.restoreArchive(
      archive("RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"),
    );
    expect(refused.status, JSON.stringify(refused.error)).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    for (const id of [...notes, event]) {
      expect((await client.getItem(id)).status, id).toBe(404);
    }
    expect((await client.getType(ids.type)).status).toBe(404);
    expect(
      (await client.listEdgeTypes()).data.data.map((e) => e.id),
    ).not.toContain(ids.edgeType);
    expect((await owner.downloadBlob(hash)).status).toBe(404);
    expect(
      (await client.listAudit({ resource_id: ids.type })).data.data,
    ).toEqual([]);

    // A write after the refusal settles the event stream: its own event
    // arriving means everything the restore had announced would have too.
    const after = await client.createItem(createNote({ source: ctx.source }));
    expect(after.ok).toBe(true);
    trackItem(ctx, after.data.item.id);
    await withStream(apiUrl, fileKey, { lastEventId: eventId }, async (s) => {
      const { events } = await collectUntil(
        s,
        (seen) => idsOf(seen).includes(after.data.item.id),
        "the write that follows a refused restore",
      );
      for (const id of [...notes, event]) {
        expect(idsOf(events), id).not.toContain(id);
      }
    });

    // The witness: the same archive with a rule it can unfold restores every
    // row, registration and blob, announces them and audits the type.
    const taken = await owner.restoreArchive(
      archive("RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28"),
    );
    expect(taken.ok, JSON.stringify(taken.error)).toBe(true);
    for (const id of [...notes, event]) trackItem(ctx, id);
    trackType(ctx, ids.type);
    trackEdgeType(ctx, ids.edgeType);
    expect(taken.data).toMatchObject({
      imported: 11,
      types_registered: 1,
      edge_types_registered: 1,
      blobs_imported: 1,
    });
    expect(
      (await client.listAudit({ resource_id: ids.type })).data.data.length,
    ).toBeGreaterThan(0);
    await withStream(apiUrl, fileKey, { lastEventId: eventId }, async (s) => {
      const { events } = await collectUntil(
        s,
        (seen) => notes.every((id) => idsOf(seen).includes(id)),
        "the notes a restore announces",
      );
      expect(idsOf(events)).toEqual(expect.arrayContaining(notes));
    });
  });
});

describe("type creator provenance in archives", () => {
  it("preserves a recorded creator and leaves an absent creator unknown", async () => {
    const recorded = `user.restoremaker${ctx.runId}`;
    const unknown = `user.restoreunknownmaker${ctx.runId}`;
    trackType(ctx, recorded);
    trackType(ctx, unknown);
    const creator = { kind: "key", id: "retired-key", name: "Original maker" };
    const archive = withLines(
      itemsArchive([]),
      "instance",
      [
        {
          type: { id: recorded, label: "Recorded", version: 1, fields: {} },
          provenance: { origin: "user", created_by: creator },
        },
        { type: { id: unknown, label: "Unknown", version: 1, fields: {} } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const result = await owner.restoreArchive(archive);
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(
      (await client.getType(recorded)).data.provenance?.created_by,
    ).toEqual(creator);
    expect(
      (await client.getType(unknown)).data.provenance?.created_by,
    ).toBeNull();
  });
});

describe("a restore refused while its body is still arriving", () => {
  /** A manifest the restore refuses on reading it, then `size` bytes more. */
  const refusedEarly = (size: number): Uint8Array =>
    tar([
      {
        name: "manifest.json",
        body: JSON.stringify({ version: 99, format: "marfa-archive-v0" }),
      },
      { name: "padding.bin", body: new Uint8Array(size) },
    ]);

  /**
   * Sends `body` the way `marfa restore` does, after `Expect: 100-continue`:
   * it is sent only once the server says `100 Continue`, and not at all if
   * the server answers first.
   */
  const sendAfterContinue = (
    authorization: string,
    body: Uint8Array,
  ): Promise<{ status: number; sent: boolean; text: string }> =>
    new Promise((resolve, reject) => {
      const url = new URL(`${apiUrl}/restore`);
      let sent = false;
      const request = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/x-tar",
            "Content-Length": String(body.length),
            Expect: "100-continue",
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, sent, text }),
          );
        },
      );
      request.on("error", reject);
      request.on("continue", () => {
        sent = true;
        request.end(body);
      });
      request.flushHeaders();
    });

  it("reads the rest of a large body and answers the refusal, to the owner, and answers a working key before the body", async () => {
    const body = refusedEarly(64 * 1024 * 1024);
    const keyResp = await client.createKey({
      label: "restore-refused-early",
      source: `${ctx.source}-refused-early`,
      type_permissions: { "*": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const forbidden = await sendAfterContinue(
        `Bearer ${keyResp.data.key}`,
        body,
      );
      expect(forbidden.status).toBe(403);
      expect(
        (JSON.parse(forbidden.text) as { error: { code: string } }).error.code,
      ).toBe("forbidden");
      expect(forbidden.sent).toBe(false);

      const refused = await owner.restoreArchive(body);
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.message).toContain("version 99");
    }
  });

  it("answers a caller with no credential within two seconds and closes the connection while it keeps sending", async () => {
    const url = new URL(apiUrl);
    const started = Date.now();
    const answer = await new Promise<{ head: string; at: number }>(
      (resolve, reject) => {
        const socket = connect(Number(url.port || 80), url.hostname);
        let head = "";
        const sender = setInterval(() => {
          socket.write(Buffer.alloc(64 * 1024), () => {});
        }, 50);
        const stop = () => {
          clearInterval(sender);
          clearTimeout(giveUp);
          socket.destroy();
        };
        const giveUp = setTimeout(() => {
          stop();
          reject(new Error(`no answer in 5 s; the server read on: ${head}`));
        }, 5000);
        socket.on("error", () => {});
        socket.on("connect", () => {
          socket.write(
            `POST /restore HTTP/1.1\r\nHost: ${url.host}\r\n` +
              `Content-Type: application/x-tar\r\n` +
              `Content-Length: ${64 * 1024 * 1024 * 1024}\r\n\r\n`,
          );
        });
        socket.on("data", (chunk) => {
          head += chunk.toString("latin1");
          if (head.includes("\r\n\r\n")) {
            stop();
            resolve({ head, at: Date.now() - started });
          }
        });
      },
    );
    expect(answer.head).toMatch(/^HTTP\/1\.1 401 /);
    expect(answer.head.toLowerCase()).toContain("connection: close");
    expect(answer.at).toBeLessThan(3000);
  });
});

describe("lines an archive holds that no instance writes", () => {
  const note = (id: string) => ({
    id,
    type: "core.note",
    source: ctx.source,
    properties: { body: `line ${id}` },
  });

  it("refuses an item line that holds no item, naming its row, and writes nothing", async () => {
    const kept = uuidv7();
    const good = `${JSON.stringify({ item: note(kept), metadata: { tags: [], extensions: {} } })}\n`;
    for (const line of [
      { metadata: { tags: [], extensions: {} } },
      { item: "a note", metadata: { tags: [], extensions: {} } },
      { item: null },
    ]) {
      const refused = await owner.restoreArchive(
        withLines(
          itemsArchive([]),
          "items",
          good + JSON.stringify(line) + "\n",
        ),
      );
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details?.row).toBe(2);
      expect((await client.getItem(kept)).status).toBe(404);
    }

    // The witness: the item line alone restores.
    const restored = await owner.restoreArchive(
      withLines(itemsArchive([]), "items", good),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, kept);
    expect(restored.data.imported).toBe(1);
  });

  it("refuses an edge whose ID is not a lowercase UUIDv7, and writes nothing", async () => {
    const [a, b] = [uuidv7(), uuidv7()];
    const items = itemsArchive([note(a), note(b)]);
    const edge = (id: unknown) =>
      `${JSON.stringify({ edge: { id, source_id: a, target_id: b, edge_type: "references" } })}\n`;
    for (const id of ["x", 7, uuidv7().toUpperCase(), ""]) {
      const refused = await owner.restoreArchive(
        withLines(items, "edges", edge(id)),
      );
      expect(
        refused.status,
        `${String(id)}: ${JSON.stringify(refused.error)}`,
      ).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details?.field).toBe("id");
      expect((await client.getItem(a)).status).toBe(404);
    }

    // The witness: the same edge under a lowercase UUIDv7 restores, once.
    const id = uuidv7();
    const archive = withLines(items, "edges", edge(id));
    const restored = await owner.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, a);
    trackItem(ctx, b);
    expect(restored.data.edges_imported).toBe(1);
    expect((await client.getEdge(id)).status).toBe(200);
    const again = await owner.restoreArchive(archive);
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(again.data.edges_imported).toBe(0);
  });

  it("refuses an archive that registers a type or an edge type twice, and writes nothing", async () => {
    const id = uuidv7();
    const type = {
      type: {
        id: `user.twice${ctx.runId.replace(/[^a-z0-9]/g, "")}`,
        label: "Twice",
        version: 1,
        fields: { body: { type: "string" } },
      },
    };
    const edgeType = {
      edge_type: {
        id: `twice.x${ctx.runId.replace(/[^a-z0-9]/g, "")}`,
        label: "Twice",
        cardinality: "many-to-many",
        source_type_constraints: ["*"],
        target_type_constraints: ["*"],
        cascade_on_delete: "orphan",
        property_schema: {},
        written_at: "source",
      },
    };
    for (const line of [type, edgeType]) {
      const twice = `${JSON.stringify(line)}\n`.repeat(2);
      const refused = await owner.restoreArchive(
        withLines(itemsArchive([note(id)]), "instance", twice),
      );
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.message).toContain("more than once");
      expect((await client.getItem(id)).status).toBe(404);
    }
    expect((await client.getType(type.type.id)).status).toBe(404);

    // The witness: each line once restores.
    const restored = await owner.restoreArchive(
      withLines(
        itemsArchive([note(id)]),
        "instance",
        `${JSON.stringify(type)}\n${JSON.stringify(edgeType)}\n`,
      ),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    trackType(ctx, type.type.id);
    trackEdgeType(ctx, edgeType.edge_type.id);
    expect(restored.data.types_registered).toBe(1);
    expect(restored.data.edge_types_registered).toBe(1);
  });

  it("writes a snapshot's dates in UTC to the millisecond", async () => {
    const id = uuidv7();
    const spelled = "2019-12-31T23:59:59+01:00";
    const line = {
      item: { ...note(id), version: 2 },
      metadata: { tags: [], extensions: {} },
      versions: [
        {
          id: uuidv7(),
          item_id: id,
          version: 1,
          properties: { body: "the first version" },
          type: "core.note",
          tier: "library",
          created_at: spelled,
          occurred_at: spelled,
          source_id: null,
          writer: null,
        },
      ],
    };
    const restored = await owner.restoreArchive(
      withLines(itemsArchive([]), "items", `${JSON.stringify(line)}\n`),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    const versions = await client.getVersions(id);
    expect(versions.status, JSON.stringify(versions.error)).toBe(200);
    expect(versions.data.data).toHaveLength(1);
    expect(versions.data.data[0]?.created_at).toBe("2019-12-31T22:59:59.000Z");
    expect(versions.data.data[0]?.occurred_at).toBe("2019-12-31T22:59:59.000Z");
  });
});
