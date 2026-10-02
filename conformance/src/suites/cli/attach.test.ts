import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope, Refusal } from "./harness.js";

/**
 * A file attached to a note: its bytes stored by hash, a file item carrying
 * the reference, and an `attached-to` edge from the file to the note. And a
 * file added on its own: the same bytes and file item, and no edge.
 */

let c: CliContext;
let dir: string;

beforeAll(async () => {
  c = await cliContext("attach");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-attach-"));
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

/** A PNG signature followed by bytes that are not text, so a text path
 *  would corrupt it and a byte-equal download proves the round trip. */
function pngBytes(): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const body = Buffer.alloc(512);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 37 + 11) % 256;
  return Buffer.concat([signature, body]);
}

describe("attaching a file", () => {
  it("uploads the bytes, creates a file item for them, links it, and downloads them back byte for byte", async () => {
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-attach"), body: "b" }),
    ]);
    trackItem(c.ctx, created.item.id);
    const path = join(dir, "diagram.png");
    const bytes = pngBytes();
    writeFileSync(path, bytes);

    const attached = await c.cli.json<{
      blob: { hash: string; mime_type: string; size_bytes: number };
      item: { id: string; type: string; properties: Record<string, unknown> };
      edge: {
        edge: { source_id: string; target_id: string; edge_type: string };
      };
    }>(["items", "attach", created.item.id, path]);
    trackItem(c.ctx, attached.item.id);
    expect(attached.blob.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(attached.blob.mime_type).toBe("image/png");
    expect(attached.blob.size_bytes).toBe(bytes.length);
    expect(attached.item.type).toBe("core.file.image");
    expect(attached.item.properties.blob_ref).toBe(attached.blob.hash);
    expect(attached.item.properties.mime_type).toBe("image/png");
    expect(attached.item.properties.title).toBe("diagram.png");
    expect(attached.edge.edge.source_id).toBe(attached.item.id);
    expect(attached.edge.edge.target_id).toBe(created.item.id);
    expect(attached.edge.edge.edge_type).toBe("attached-to");

    const inbound = await c.cli.json<{
      data: Array<{ source_id: string }>;
    }>(["items", "backrefs", created.item.id, "--type", "attached-to"]);
    expect(inbound.data.map((row) => row.source_id)).toContain(
      attached.item.id,
    );
    const otherType = await c.cli.json<{
      data: Array<{ source_id: string }>;
    }>(["items", "backrefs", created.item.id, "--type", "references"]);
    expect(otherType.data.map((row) => row.source_id)).not.toContain(
      attached.item.id,
    );

    const out = join(dir, "diagram.out");
    await c.cli.json([
      "blobs",
      "download",
      attached.blob.hash,
      "--output",
      out,
    ]);
    expect(readFileSync(out).equals(bytes)).toBe(true);

    // The same bytes uploaded again answer the same hash: content addressed.
    const again = await c.cli.json<{ hash: string }>(["blobs", "upload", path]);
    expect(again.hash).toBe(attached.blob.hash);

    // The location log names the store the bytes went to.
    const locations = await c.cli.json<{
      data: { store_id: string; kind: string }[];
    }>(["blobs", "locations", attached.blob.hash]);
    expect(locations.data.map((copy) => copy.kind)).toContain("disk");

    // A link to the bytes, for a reader that cannot carry the key.
    const link = await c.cli.json<{ url: string; expires_in: number }>([
      "blobs",
      "url",
      attached.blob.hash,
      "--ttl",
      "120",
    ]);
    expect(link.url).toContain(attached.blob.hash.replace("sha256:", ""));
    expect(link.expires_in).toBe(120);

    // The last copy cannot be dropped: the door answers its own refusal
    // with the floor it holds, and the log still names the copy after. A
    // server with an object store may have replicated the upload by now, so
    // copies above the floor go first.
    let kept: { store: string; code: number; envelope: Refusal } | undefined;
    for (let tries = 0; tries < 5 && kept === undefined; tries += 1) {
      const now = await c.cli.json<{ data: { store_id: string }[] }>([
        "blobs",
        "locations",
        attached.blob.hash,
      ]);
      const store = now.data[0]?.store_id;
      if (store === undefined) break;
      const outcome = await c.operator.run([
        "--json",
        "blobs",
        "drop",
        attached.blob.hash,
        "--store",
        store,
      ]);
      if (outcome.code !== 0) {
        kept = {
          store,
          code: outcome.code,
          envelope: JSON.parse(outcome.stderr.trim()) as Refusal,
        };
      }
    }
    expect(kept, "every copy was dropped, so no floor was held").toBeDefined();
    expect(kept!.code).toBe(1);
    expect(kept!.envelope.error.server?.code).toBe("copies_below_minimum");
    const still = await c.cli.json<{ data: { store_id: string }[] }>([
      "blobs",
      "locations",
      attached.blob.hash,
    ]);
    expect(still.data.map((copy) => copy.store_id)).toContain(kept!.store);
  });

  it("adds a file as an item of its own, typed by its extension, under the title, tags and tier given, and links it to nothing", async () => {
    const path = join(dir, "talk.pptx");
    writeFileSync(path, Buffer.from("PK\u0003\u0004 slides\n"));
    const pptx =
      "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    const title = unique("cli-add");

    const added = await c.cli.json<{
      blob: { hash: string; mime_type: string };
      item: {
        id: string;
        type: string;
        tier: string;
        properties: Record<string, unknown>;
      };
    }>([
      "items",
      "add",
      path,
      "--title",
      title,
      "--tag",
      "slides",
      "--tier",
      "feed",
    ]);
    trackItem(c.ctx, added.item.id);
    expect(added.blob.mime_type).toBe(pptx);
    expect(added.item.type).toBe("core.file");
    expect(added.item.tier).toBe("feed");
    expect(added.item.properties).toMatchObject({
      blob_ref: added.blob.hash,
      mime_type: pptx,
      title,
    });
    const read = await c.cli.json<ItemEnvelope>([
      "items",
      "get",
      added.item.id,
      "--include",
      "metadata",
    ]);
    expect(read.metadata?.tags).toEqual(["slides"]);

    // The witness: an attachment of the same file draws an edge from it,
    // so an empty listing below is the command's and not the door's.
    const note = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-add-note"), body: "b" }),
    ]);
    trackItem(c.ctx, note.item.id);
    const attached = await c.cli.json<{ item: { id: string } }>([
      "items",
      "attach",
      note.item.id,
      path,
    ]);
    trackItem(c.ctx, attached.item.id);
    const drawn = await c.cli.json<{ data: unknown[] }>([
      "items",
      "edges",
      attached.item.id,
    ]);
    expect(drawn.data).toHaveLength(1);
    const none = await c.cli.json<{ data: unknown[] }>([
      "items",
      "edges",
      added.item.id,
    ]);
    expect(
      none.data,
      "a file added on its own was linked to something",
    ).toEqual([]);
  });

  it("refuses a file that is not there before anything is sent", async () => {
    const refused = await c.cli.refused([
      "blobs",
      "upload",
      join(dir, "missing.png"),
    ]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.code).toBe("invalid");
    expect(refused.envelope.error.server).toBeNull();
  });
});
