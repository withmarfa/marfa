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
import {
  closeTestContexts,
  createTestContext,
  request,
} from "../test-utils.js";
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
  await closeTestContexts(contexts);
});

let counter = 0;
/** Unique per registration: the type registry is a process-level singleton. */
function uniqueSuffix(): string {
  counter += 1;
  return `${String(counter)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Export the instance as an archive, through the working key. */
async function exportArchive(ctx: TestContext): Promise<Buffer> {
  const res = await request(ctx.app, "GET", `/export?format=archive`, {
    key: ctx.spaceKey,
  });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

/** Restore an archive. `/admin/restore-archive` is an operator route, so it
 *  takes the operator key and no working credential reaches it. */
async function restore(ctx: TestContext, archive: Buffer): Promise<Response> {
  return await ctx.app.request(`/admin/restore-archive`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.operatorKey}`,
      "Content-Type": "application/gzip",
    },
    body: archive,
  });
}

describe("archives carry custom type registrations", () => {
  it("round-trips a space whose items use its own types", async () => {
    const source = await newContext();
    const destination = await newContext();
    const suffix = uniqueSuffix();
    const typeId = `user.recipe_${suffix}`;
    const edgeTypeId = `user.cooked-with-${suffix}`;

    await source.storage.types.create({
      id: typeId,
      label: "Recipe",
      description: "A recipe.",
      version: 1,
      fields: {
        title: { type: "string", required: true, description: "Name." },
        servings: { type: "number", description: "How many it feeds." },
      },
    });
    await source.storage.edgeTypes.create({
      id: edgeTypeId,
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["*"],
      cascade_on_delete: "orphan",
      property_schema: {},
    });

    const recipe = await source.storage.items.create({
      type: typeId,
      properties: { title: "Soup", servings: 4 },
      source: "at-seed",
      source_id: "r1",
    });
    const note = await source.storage.items.create({
      type: "core.note",
      properties: { body: "made this" },
      source: "at-seed",
      source_id: "n1",
    });
    await source.storage.edges.createRaw({
      source_id: note.id,
      target_id: recipe.id,
      edge_type: edgeTypeId,
    });

    const archive = await exportArchive(source);
    const entries = await extractArchive(archive);
    expect(entries.has("types.ndjson")).toBe(true);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      custom_type_count: number;
      custom_edge_type_count: number;
    };
    expect(manifest.custom_type_count).toBe(1);
    expect(manifest.custom_edge_type_count).toBe(1);

    const res = await restore(destination, archive);
    expect(
      res.status,
      `restore -> ${String(res.status)}: ${await res.clone().text()}`,
    ).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.custom_types_registered).toBe(1);
    expect(result.custom_edge_types_registered).toBe(1);
    // The item of the custom type landed, which is what used to fail.
    expect(result.imported).toBe(2);

    const restored = await destination.storage.items.get(recipe.id);
    expect(restored?.type).toBe(typeId);
    expect(restored?.properties).toEqual({ title: "Soup", servings: 4 });

    const restoredEdges = await destination.storage.edges.list({});
    expect(restoredEdges.data).toHaveLength(1);
    expect(restoredEdges.data[0]?.edge_type).toBe(edgeTypeId);

    // The destination's own registrations, which is what its next boot
    // loads into the registry. An in-process test cannot check the live
    // registry itself: it is a process-level singleton that both contexts
    // share, so it would answer for the source's registration whatever
    // the restore did. The rows are the part this test can actually own.
    const destTypes = await destination.storage.types.listCustom();
    expect(destTypes.map((s) => s.id)).toContain(typeId);
    const destEdgeTypes = await destination.storage.edgeTypes.list();
    expect(destEdgeTypes.map((s) => s.id)).toContain(edgeTypeId);
  });

  it("restores a subtype whose parent is in the same archive", async () => {
    const source = await newContext();
    const destination = await newContext();
    const suffix = uniqueSuffix();
    const parentId = `user.doc_${suffix}`;
    const childId = `user.doc_${suffix}.signed`;

    // Registered child-first so the archive lists it before its parent
    // only if ordering is incidental; the restore must not depend on it.
    await source.storage.types.create({
      id: parentId,
      label: "Doc",
      description: "A document.",
      version: 1,
      fields: {
        title: { type: "string", required: true, description: "Name." },
      },
    });
    await source.storage.types.create({
      id: childId,
      label: "Signed doc",
      description: "A signed document.",
      parent: parentId,
      version: 1,
      fields: {
        title: { type: "string", required: true, description: "Name." },
        signed_by: { type: "string", description: "Who signed." },
      },
    });
    await source.storage.items.create({
      type: childId,
      properties: { title: "Lease", signed_by: "someone" },
      source: "at-p",
      source_id: "d1",
    });

    const archive = await exportArchive(source);
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

    const res = await restore(destination, reordered);
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
    const typeId = `user.repeat_${uniqueSuffix()}`;

    await source.storage.types.create({
      id: typeId,
      label: "Repeat",
      description: "Registered twice on purpose.",
      version: 1,
      fields: {
        title: { type: "string", required: true, description: "Name." },
      },
    });
    await source.storage.items.create({
      type: typeId,
      properties: { title: "once" },
      source: "at-r",
      source_id: "x1",
    });

    const archive = await exportArchive(source);
    const first = (await (
      await restore(destination, archive)
    ).json()) as RestoreResult;
    expect(first.custom_types_registered).toBe(1);
    expect(first.custom_types_skipped).toBe(0);

    const second = (await (
      await restore(destination, archive)
    ).json()) as RestoreResult;
    expect(second.custom_types_registered).toBe(0);
    expect(second.custom_types_skipped).toBe(1);
  });

  it("refuses an archive that redefines a type the space already holds", async () => {
    const source = await newContext();
    const destination = await newContext();
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
    await source.storage.types.create(schema);
    await source.storage.items.create({
      type: typeId,
      properties: { title: "from source" },
      source: "at-c",
      source_id: "c1",
    });
    // The destination already holds the same id with a different shape.
    await destination.storage.types.create({
      ...schema,
      description: "A different reading of the same name.",
      fields: {
        headline: {
          type: "string" as const,
          required: true,
          description: "H.",
        },
      },
    });

    const archive = await exportArchive(source);
    const res = await restore(destination, archive);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { conflicting_ids?: string[] } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details?.conflicting_ids).toContain(typeId);

    // Refused before anything was written: the item did not land.
    const items = await destination.storage.items.list({});
    expect(items.data).toHaveLength(0);
  });

  it("refuses an archive claiming a reserved namespace", async () => {
    const source = await newContext();
    const destination = await newContext();
    await source.storage.items.create({
      type: "core.note",
      properties: { body: "innocent" },
      source: "at-e",
      source_id: "e1",
    });

    const entries = await extractArchive(await exportArchive(source));
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

    const res = await restore(destination, tampered);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("refuses an archive carrying a malformed type", async () => {
    const source = await newContext();
    const destination = await newContext();
    await source.storage.items.create({
      type: "core.note",
      properties: { body: "innocent" },
      source: "at-m",
      source_id: "m1",
    });

    const entries = await extractArchive(await exportArchive(source));
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

    const res = await restore(destination, tampered);
    expect(res.status).toBe(400);
    const items = await destination.storage.items.list({});
    expect(items.data).toHaveLength(0);
  });

  it("names the archive entry whose chain runs too deep", async () => {
    // The depth cap and the walk behind it are shared with `POST /types`,
    // and each door supplies its own phrasing. This is the archive door's,
    // and nothing else asserts it, so a transposed interpolation would read
    // as the registration door's message.
    //
    // The unknown-parent and circular phrasings this door also supplies are
    // not reachable from an archive alone. The restore's own loop skips a
    // schema whose immediate parent has not resolved and raises its own
    // error when nothing more can be written, so it reports the stall first. They need
    // the registry to already hold a chain that points at nothing, and two
    // paths produce that. Deleting a type does not check for types that
    // inherit from it, and manifest registration writes a declared schema
    // without checking its parent resolves at all. Both are defects of their
    // own, and the cases for these two messages belong with either fix.
    const source = await newContext();
    const destination = await newContext();
    await source.storage.items.create({
      type: "core.note",
      properties: { body: "innocent" },
      source: "at-d",
      source_id: "d1",
    });

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

    const entries = await extractArchive(await exportArchive(source));
    const tampered = await repack(entries, { "types.ndjson": chain + "\n" });

    const res = await restore(destination, tampered);
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { message: string } };
    expect(payload.error.message).toBe(
      `Archive type "${link(11)}" has an inheritance chain deeper than 10`,
    );
  });

  it("refuses an archive redefining a core edge type", async () => {
    const source = await newContext();
    const destination = await newContext();
    await source.storage.items.create({
      type: "core.note",
      properties: { body: "innocent" },
      source: "at-ce",
      source_id: "ce1",
    });

    const entries = await extractArchive(await exportArchive(source));
    const tampered = await repack(entries, {
      "types.ndjson":
        JSON.stringify({
          custom_edge_type: { id: "about", cardinality: "one-to-one" },
        }) + "\n",
    });

    const res = await restore(destination, tampered);
    expect(res.status).toBe(409);
  });

  it("restores an archive that predates the types member", async () => {
    const source = await newContext();
    const destination = await newContext();
    await source.storage.items.create({
      type: "core.note",
      properties: { body: "from an older exporter" },
      source: "at-o",
      source_id: "o1",
    });

    const entries = await extractArchive(await exportArchive(source));
    entries.delete("types.ndjson");
    const older = await repack(entries, {});

    const res = await restore(destination, older);
    expect(res.status).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.imported).toBe(1);
    expect(result.custom_types_registered).toBe(0);
    expect(result.custom_edge_types_registered).toBe(0);
  });
});

describe("an archive carries where a type came from", () => {
  const baseType = {
    version: 1,
    fields: { name: { type: "string", required: true } },
  } as const;

  /** The provenance the destination actually stored for one type id. */
  async function storedOrigin(
    ctx: TestContext,
    typeId: string,
  ): Promise<string | undefined> {
    const rows = await ctx.storage.types.listCustomWithProvenance();
    return rows.find((r) => r.schema.id === typeId)?.origin;
  }

  it("replays an integration's provenance instead of defaulting it", async () => {
    // The laundering this exists to stop. The column defaults to `user`,
    // and `user` is what the consent screen offers a read-and-write
    // wildcard over, so a type a connected service published came back
    // from a backup as a type the person registered, through a
    // first-party operation described to them as a restore.
    const source = await newContext();
    const destination = await newContext();
    const typeId = `acme.widget_${uniqueSuffix()}`;

    await source.storage.types.create(
      { id: typeId, ...baseType },
      {
        origin: "integration",
        family: "integration",
        owner_integration: "acme/widgets",
      },
    );

    const res = await restore(destination, await exportArchive(source));
    expect(res.status).toBe(200);
    expect(await storedOrigin(destination, typeId)).toBe("integration");
  });

  it("records an archive with no provenance as unrecorded", async () => {
    // Every archive taken before exports carried provenance looks like
    // this. `unknown` is a real answer rather than a missing one: it is
    // what lets the consent screen offer the root read-only instead of
    // guessing, and guessing defaulted to the permissive side.
    const source = await newContext();
    const destination = await newContext();
    const typeId = `salvage.record_${uniqueSuffix()}`;

    await source.storage.types.create(
      { id: typeId, ...baseType },
      {
        origin: "user",
      },
    );

    const entries = await extractArchive(await exportArchive(source));
    const stripped = (entries.get("types.ndjson")?.toString() ?? "")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        delete parsed.provenance;
        return JSON.stringify(parsed);
      })
      .join("\n");

    const res = await restore(
      destination,
      await repack(entries, { "types.ndjson": stripped + "\n" }),
    );
    expect(res.status).toBe(200);
    expect(await storedOrigin(destination, typeId)).toBe("unknown");
  });

  it("records an origin this build does not recognize as unrecorded", async () => {
    // Distinct from provenance being absent, and it reaches a different
    // branch: a newer build may write an origin this one has never heard
    // of. Falling back to `user` would be the permissive answer for a
    // value nobody here can interpret, so it falls back to the same
    // read-only treatment an archive with nothing recorded gets.
    const source = await newContext();
    const destination = await newContext();
    const typeId = `salvage.future_${uniqueSuffix()}`;

    await source.storage.types.create(
      { id: typeId, ...baseType },
      {
        origin: "user",
      },
    );

    const entries = await extractArchive(await exportArchive(source));
    const tampered = (entries.get("types.ndjson")?.toString() ?? "")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.custom_type) {
          parsed.provenance = { origin: "something-later" };
        }
        return JSON.stringify(parsed);
      })
      .join("\n");

    const res = await restore(
      destination,
      await repack(entries, { "types.ndjson": tampered + "\n" }),
    );
    expect(res.status).toBe(200);
    expect(await storedOrigin(destination, typeId)).toBe("unknown");
  });

  it("refuses an archive claiming a type is platform-shipped", async () => {
    // The delayed fuse. A restore on a self-host writes into the same
    // space-less bucket the platform seed uses, and the boot warmup skips
    // `platform` rows on the way to projecting them globally, so a
    // replayed claim would seed an attacker-chosen type into the global
    // registry at the next restart, resolving for every space and
    // undeletable. Nothing manifests until then, which is what makes it
    // worth refusing rather than downgrading.
    const source = await newContext();
    const destination = await newContext();

    await source.storage.types.create(
      { id: `acme.sneak_${uniqueSuffix()}`, ...baseType },
      { origin: "user" },
    );

    const entries = await extractArchive(await exportArchive(source));
    const tampered = (entries.get("types.ndjson")?.toString() ?? "")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.custom_type) parsed.provenance = { origin: "platform" };
        return JSON.stringify(parsed);
      })
      .join("\n");

    const res = await restore(
      destination,
      await repack(entries, { "types.ndjson": tampered + "\n" }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("refuses an archive claiming a shipped family", async () => {
    // Family decides membership of the content category, and `core` is
    // the permissive value the boot projection exists to warn about. The
    // namespace guard stops a reserved identifier; this is the separate
    // axis, and an ordinary namespace claiming a shipped family is
    // claiming to be part of the build.
    const source = await newContext();
    const destination = await newContext();

    await source.storage.types.create(
      { id: `acme.family_${uniqueSuffix()}`, ...baseType },
      { origin: "user" },
    );

    const entries = await extractArchive(await exportArchive(source));
    const tampered = (entries.get("types.ndjson")?.toString() ?? "")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.custom_type) {
          parsed.provenance = { origin: "user", family: "core" };
        }
        return JSON.stringify(parsed);
      })
      .join("\n");

    const res = await restore(
      destination,
      await repack(entries, { "types.ndjson": tampered + "\n" }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});

describe("a claimed `user` origin is checked against the handle", () => {
  const baseType = {
    version: 1,
    fields: { name: { type: "string", required: true } },
  } as const;

  /**
   * Builds a one-line archive claiming `provenance` for `typeId`, addressed
   * to `space`.
   *
   * The vehicle is exported from the source's own space, because that is the
   * only one its key may name, and the manifest is then restamped with the
   * space the archive is going to be restored into — the restore door
   * compares the two and refuses a mismatch. Where the destination needs a
   * real space row of its own, as the hosted cases do for the users foreign
   * key, that is the id the caller passes here.
   */
  async function archiveClaiming(
    source: TestContext,
    seedTypeId: string,
    typeId: string,
    provenance: Record<string, unknown>,
  ): Promise<Buffer> {
    await source.storage.types.create(
      { id: seedTypeId, ...baseType },
      { origin: "user" },
    );
    const entries = await extractArchive(await exportArchive(source));
    const manifest = JSON.parse(
      entries.get("manifest.json")!.toString(),
    ) as Record<string, unknown>;
    const line =
      JSON.stringify({
        custom_type: { id: typeId, ...baseType },
        provenance,
      }) + "\n";
    return await repack(entries, {
      "types.ndjson": line,
      "manifest.json": JSON.stringify(manifest),
    });
  }

  async function storedOriginOf(
    ctx: TestContext,
    typeId: string,
  ): Promise<string | undefined> {
    const rows = await ctx.storage.types.listCustomWithProvenance();
    return rows.find((r) => r.schema.id === typeId)?.origin;
  }

  it("refuses an archive claiming the system family", async () => {
    // The sibling of the `core` case. Both values are named in the
    // refusal and both need pinning, or half of it can be deleted with
    // the suite staying green.
    const source = await newContext();
    const destination = await newContext();
    const suffix = uniqueSuffix();

    const archive = await archiveClaiming(
      source,
      `user.seed_${suffix}`,
      `acme_${suffix}.thing`,
      { origin: "user", family: "system" },
    );
    const res = await restore(destination, archive);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("does not rewrite the provenance of a row that already exists", async () => {
    // Re-restoring must stay a no-op. If the skip branch ever started
    // refreshing the column, a second restore of an older copy would walk
    // a row an integration had claimed back to `unknown`.
    const source = await newContext();
    const destination = await newContext();
    const suffix = uniqueSuffix();
    const typeId = `acme_${suffix}.widget`;

    await destination.storage.types.create(
      { id: typeId, ...baseType },
      {
        origin: "integration",
        family: "integration",
      },
    );

    const archive = await archiveClaiming(
      source,
      `user.seed_${suffix}`,
      typeId,
      { origin: "user" },
    );
    const res = await restore(destination, archive);
    expect(res.status).toBe(200);
    expect(await storedOriginOf(destination, typeId)).toBe("integration");
  });
});
