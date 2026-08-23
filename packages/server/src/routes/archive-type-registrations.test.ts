/**
 * An archive has to carry the registrations its items depend on.
 *
 * A space's items can be of types the space registered itself, and a
 * restore into an empty space had no way to learn about them: every such
 * item failed as an unknown type while the restore reported success on
 * whatever was left. These tests pin the round trip end to end — export a
 * space with a custom type and a custom edge type, restore onto a fresh
 * database, and create a *new* item of the restored type, which proves
 * the live registry and not just the table.
 */

import { createGunzip, createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { describe, expect, it, afterAll } from "vitest";
import * as tar from "tar-stream";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

async function extractArchive(data: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    Readable.from(data).pipe(gunzip).pipe(extract);
  });
  return entries;
}

/** Repacks an archive with one member replaced, for the tampering cases. */
async function repack(
  entries: Map<string, Buffer>,
  overrides: Record<string, string>,
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  pack.pipe(gzip);

  const merged = new Map(entries);
  for (const [name, text] of Object.entries(overrides)) {
    merged.set(name, Buffer.from(text));
  }
  for (const [name, buf] of merged) {
    pack.entry({ name, size: buf.length }, buf);
  }
  pack.finalize();

  await new Promise<void>((resolve) => gzip.on("end", resolve));
  return Buffer.concat(chunks);
}

interface RestoreResult {
  imported: number;
  custom_types_registered: number;
  custom_types_skipped: number;
  custom_edge_types_registered: number;
  custom_edge_types_skipped: number;
}

const contexts: TestContext[] = [];
async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterAll(async () => {
  for (const ctx of contexts) {
    await ctx.cleanup();
  }
});

let counter = 0;
/** Unique per registration: the type registry is a process-level singleton. */
function uniqueSuffix(): string {
  counter += 1;
  return `${String(counter)}${Math.random().toString(36).slice(2, 8)}`;
}

async function exportArchive(ctx: TestContext, space: string): Promise<Buffer> {
  const res = await request(
    ctx.app,
    "GET",
    `/export?format=archive&target_space_id=${space}`,
    { key: ctx.adminKey },
  );
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

async function restore(
  ctx: TestContext,
  space: string,
  archive: Buffer,
): Promise<Response> {
  return await ctx.app.request(
    `/admin/restore-archive?target_space_id=${space}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    },
  );
}

describe("archives carry custom type registrations", () => {
  it("round-trips a space whose items use its own types", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-${Math.random().toString(36).slice(2, 10)}`;
    const suffix = uniqueSuffix();
    const typeId = `user.recipe_${suffix}`;
    const edgeTypeId = `user.cooked-with-${suffix}`;

    await source.storage.types.create(
      {
        id: typeId,
        label: "Recipe",
        description: "A recipe.",
        version: 1,
        fields: {
          title: { type: "string", required: true, description: "Name." },
          servings: { type: "number", description: "How many it feeds." },
        },
      },
      space,
    );
    await source.storage.edgeTypes.create(
      {
        id: edgeTypeId,
        cardinality: "many-to-many",
        source_type_constraints: ["*"],
        target_type_constraints: ["*"],
        cascade_on_delete: "orphan",
        property_schema: {},
      },
      space,
    );

    const recipe = await source.storage.items.create(
      {
        type: typeId,
        properties: { title: "Soup", servings: 4 },
        source: "at-seed",
        source_id: "r1",
      },
      space,
    );
    const note = await source.storage.items.create(
      {
        type: "core.note",
        properties: { body: "made this" },
        source: "at-seed",
        source_id: "n1",
      },
      space,
    );
    await source.storage.edges.createRaw(
      {
        source_id: note.id,
        target_id: recipe.id,
        edge_type: edgeTypeId,
      },
      space,
    );

    const archive = await exportArchive(source, space);
    const entries = await extractArchive(archive);
    expect(entries.has("types.ndjson")).toBe(true);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      custom_type_count: number;
      custom_edge_type_count: number;
    };
    expect(manifest.custom_type_count).toBe(1);
    expect(manifest.custom_edge_type_count).toBe(1);

    const res = await restore(destination, space, archive);
    expect(
      res.status,
      `restore -> ${String(res.status)}: ${await res.clone().text()}`,
    ).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.custom_types_registered).toBe(1);
    expect(result.custom_edge_types_registered).toBe(1);
    // The item of the custom type landed, which is what used to fail.
    expect(result.imported).toBe(2);

    const restored = await destination.storage.items.get(recipe.id, space);
    expect(restored?.type).toBe(typeId);
    expect(restored?.properties).toEqual({ title: "Soup", servings: 4 });

    const restoredEdges = await destination.storage.edges.list({
      spaceId: space,
    });
    expect(restoredEdges.data).toHaveLength(1);
    expect(restoredEdges.data[0]?.edge_type).toBe(edgeTypeId);

    // The destination's own registrations, which is what its next boot
    // loads into the registry. An in-process test cannot check the live
    // registry itself: it is a process-level singleton that both contexts
    // share, so it would answer for the source's registration whatever
    // the restore did. The rows are the part this test can actually own.
    const destTypes = await destination.storage.types.listCustom(space);
    expect(destTypes.map((s) => s.id)).toContain(typeId);
    const destEdgeTypes = await destination.storage.edgeTypes.list(space);
    expect(destEdgeTypes.map((s) => s.id)).toContain(edgeTypeId);
  });

  it("restores a subtype whose parent is in the same archive", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-p-${Math.random().toString(36).slice(2, 10)}`;
    const suffix = uniqueSuffix();
    const parentId = `user.doc_${suffix}`;
    const childId = `user.doc_${suffix}.signed`;

    // Registered child-first so the archive lists it before its parent
    // only if ordering is incidental; the restore must not depend on it.
    await source.storage.types.create(
      {
        id: parentId,
        label: "Doc",
        description: "A document.",
        version: 1,
        fields: {
          title: { type: "string", required: true, description: "Name." },
        },
      },
      space,
    );
    await source.storage.types.create(
      {
        id: childId,
        label: "Signed doc",
        description: "A signed document.",
        parent: parentId,
        version: 1,
        fields: {
          title: { type: "string", required: true, description: "Name." },
          signed_by: { type: "string", description: "Who signed." },
        },
      },
      space,
    );
    await source.storage.items.create(
      {
        type: childId,
        properties: { title: "Lease", signed_by: "someone" },
        source: "at-p",
        source_id: "d1",
      },
      space,
    );

    const archive = await exportArchive(source, space);
    // Reverse the type lines so the child is offered before its parent.
    const entries = await extractArchive(archive);
    const lines = entries
      .get("types.ndjson")!
      .toString()
      .trimEnd()
      .split("\n")
      .reverse();
    const reordered = await repack(entries, {
      "types.ndjson": lines.join("\n") + "\n",
    });

    const res = await restore(destination, space, reordered);
    expect(
      res.status,
      `restore -> ${String(res.status)}: ${await res.clone().text()}`,
    ).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.custom_types_registered).toBe(2);
    expect(result.imported).toBe(1);
  });

  it("re-restoring skips the registrations it already made", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-r-${Math.random().toString(36).slice(2, 10)}`;
    const typeId = `user.repeat_${uniqueSuffix()}`;

    await source.storage.types.create(
      {
        id: typeId,
        label: "Repeat",
        description: "Registered twice on purpose.",
        version: 1,
        fields: {
          title: { type: "string", required: true, description: "Name." },
        },
      },
      space,
    );
    await source.storage.items.create(
      {
        type: typeId,
        properties: { title: "once" },
        source: "at-r",
        source_id: "x1",
      },
      space,
    );

    const archive = await exportArchive(source, space);
    const first = (await (
      await restore(destination, space, archive)
    ).json()) as RestoreResult;
    expect(first.custom_types_registered).toBe(1);
    expect(first.custom_types_skipped).toBe(0);

    const second = (await (
      await restore(destination, space, archive)
    ).json()) as RestoreResult;
    expect(second.custom_types_registered).toBe(0);
    expect(second.custom_types_skipped).toBe(1);
  });

  it("refuses an archive that redefines a type the space already holds", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-c-${Math.random().toString(36).slice(2, 10)}`;
    const typeId = `user.clash_${uniqueSuffix()}`;

    const schema = {
      id: typeId,
      label: "Clash",
      description: "Same id, two shapes.",
      version: 1,
      fields: {
        title: { type: "string" as const, required: true, description: "T." },
      },
    };
    await source.storage.types.create(schema, space);
    await source.storage.items.create(
      {
        type: typeId,
        properties: { title: "from source" },
        source: "at-c",
        source_id: "c1",
      },
      space,
    );
    // The destination already holds the same id with a different shape.
    await destination.storage.types.create(
      {
        ...schema,
        description: "A different reading of the same name.",
        fields: {
          headline: {
            type: "string" as const,
            required: true,
            description: "H.",
          },
        },
      },
      space,
    );

    const archive = await exportArchive(source, space);
    const res = await restore(destination, space, archive);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { conflicting_ids?: string[] } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details?.conflicting_ids).toContain(typeId);

    // Refused before anything was written: the item did not land.
    const items = await destination.storage.items.list({ spaceId: space });
    expect(items.data).toHaveLength(0);
  });

  it("refuses an archive claiming a reserved namespace", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-e-${Math.random().toString(36).slice(2, 10)}`;
    await source.storage.items.create(
      {
        type: "core.note",
        properties: { body: "innocent" },
        source: "at-e",
        source_id: "e1",
      },
      space,
    );

    const entries = await extractArchive(await exportArchive(source, space));
    const tampered = await repack(entries, {
      "types.ndjson":
        JSON.stringify({
          custom_type: {
            id: "core.evil",
            name: "Evil",
            description: "Should never register.",
            version: 1,
            fields: {
              title: { type: "string", required: true, description: "T." },
            },
          },
        }) + "\n",
    });

    const res = await restore(destination, space, tampered);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("refuses an archive carrying a malformed type", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-m-${Math.random().toString(36).slice(2, 10)}`;
    await source.storage.items.create(
      {
        type: "core.note",
        properties: { body: "innocent" },
        source: "at-m",
        source_id: "m1",
      },
      space,
    );

    const entries = await extractArchive(await exportArchive(source, space));
    const tampered = await repack(entries, {
      "types.ndjson":
        JSON.stringify({
          custom_type: {
            id: `user.garbage_${uniqueSuffix()}`,
            name: "Garbage",
            description: "Field type is not a field type.",
            version: 1,
            fields: {
              title: { type: "not-a-real-type", description: "T." },
            },
          },
        }) + "\n",
    });

    const res = await restore(destination, space, tampered);
    expect(res.status).toBe(400);
    const items = await destination.storage.items.list({ spaceId: space });
    expect(items.data).toHaveLength(0);
  });

  it("names the archive entry whose chain runs too deep", async () => {
    // The depth cap and the walk behind it are shared with `POST /types`,
    // and each door supplies its own phrasing. This is the archive door's,
    // and nothing else asserts it, so a transposed interpolation would read
    // as the registration door's message.
    //
    // The unknown-parent and circular phrasings this door also supplies are
    // not reachable from here: the loop below skips a schema whose immediate
    // parent has not resolved yet and raises its own error when nothing more
    // can be written, so it reports the stall before the walk ever sees it.
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-d-${Math.random().toString(36).slice(2, 10)}`;
    await source.storage.items.create(
      {
        type: "core.note",
        properties: { body: "innocent" },
        source: "at-d",
        source_id: "d1",
      },
      space,
    );

    // Eleven ancestors above the last entry, one past the cap.
    const suffix = uniqueSuffix();
    const link = (n: number): string => `user.deep${String(n)}_${suffix}`;
    const chain = Array.from({ length: 12 }, (_, n) =>
      JSON.stringify({
        custom_type: {
          id: link(n),
          name: `Deep ${String(n)}`,
          description: "One link of a chain built to outrun the cap.",
          version: 1,
          ...(n > 0 ? { parent: link(n - 1) } : {}),
          fields: {},
        },
      }),
    ).join("\n");

    const entries = await extractArchive(await exportArchive(source, space));
    const tampered = await repack(entries, { "types.ndjson": chain + "\n" });

    const res = await restore(destination, space, tampered);
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { message: string } };
    expect(payload.error.message).toBe(
      `Archive type "${link(11)}" has an inheritance chain deeper than 10`,
    );
  });

  it("refuses an archive redefining a core edge type", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-ce-${Math.random().toString(36).slice(2, 10)}`;
    await source.storage.items.create(
      {
        type: "core.note",
        properties: { body: "innocent" },
        source: "at-ce",
        source_id: "ce1",
      },
      space,
    );

    const entries = await extractArchive(await exportArchive(source, space));
    const tampered = await repack(entries, {
      "types.ndjson":
        JSON.stringify({
          custom_edge_type: { id: "about", cardinality: "one-to-one" },
        }) + "\n",
    });

    const res = await restore(destination, space, tampered);
    expect(res.status).toBe(409);
  });

  it("restores an archive that predates the types member", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-at-o-${Math.random().toString(36).slice(2, 10)}`;
    await source.storage.items.create(
      {
        type: "core.note",
        properties: { body: "from an older exporter" },
        source: "at-o",
        source_id: "o1",
      },
      space,
    );

    const entries = await extractArchive(await exportArchive(source, space));
    entries.delete("types.ndjson");
    const older = await repack(entries, {});

    const res = await restore(destination, space, older);
    expect(res.status).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.imported).toBe(1);
    expect(result.custom_types_registered).toBe(0);
    expect(result.custom_edge_types_registered).toBe(0);
  });
});
