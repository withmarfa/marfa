/**
 * `GET /export` can read every lifecycle state in one pass.
 *
 * Export exists to produce a complete copy, and the archive it writes is
 * what `POST /admin/restore-archive` reads back. Its `state` filter took a
 * single lifecycle value or none, and none applies the same default every
 * item read applies — everything except `trashed`. So an export that
 * genuinely meant "everything this space holds" returned the space minus
 * its bin, with nothing in the response saying so, and getting the whole
 * corpus meant two or more full walks stitched together.
 *
 * Both output formats are covered because they are one door with one query
 * schema: a sentinel honoured by the NDJSON path and stripped by the
 * archive path would be worse than neither.
 */
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as tar from "tar-stream";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let activeId = "";
let trashedId = "";
let archivedId = "";
const SOURCE = `export-states-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  ctx = await createTestContext();

  const create = async (state: string, tag: string): Promise<string> => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        state,
        properties: { body: `export-${tag}` },
        source_id: `${SOURCE}-${tag}`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { id: string; state: string } };
    expect(body.item.state).toBe(state);
    return body.item.id;
  };

  activeId = await create("active", "active");
  archivedId = await create("archived", "archived");
  trashedId = await create("trashed", "trashed");
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Ids carried by an NDJSON export, restricted to this file's rows. */
async function ndjsonIds(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/export${query}`, {
    key: ctx.adminKey,
  });
  expect(res.status).toBe(200);
  const mine = new Set([activeId, archivedId, trashedId]);
  return (await res.text())
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { item?: { id: string } })
    .flatMap((row) => (row.item && mine.has(row.item.id) ? [row.item.id] : []));
}

/** Ids carried by an archive export's `items.ndjson`, same restriction. */
async function archiveIds(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/export${query}`, {
    key: ctx.adminKey,
  });
  expect(res.status).toBe(200);

  const archiveData = Buffer.from(await res.arrayBuffer());
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
    Readable.from(archiveData).pipe(gunzip).pipe(extract);
  });

  expect(entries.has("items.ndjson")).toBe(true);
  const mine = new Set([activeId, archivedId, trashedId]);
  return entries
    .get("items.ndjson")!
    .toString()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { item?: { id: string } })
    .flatMap((row) => (row.item && mine.has(row.item.id) ? [row.item.id] : []));
}

describe("GET /export — the all-states sentinel", () => {
  it("defaults to excluding trashed rows, unchanged", async () => {
    const ids = await ndjsonIds("?type=core.note");
    expect(ids.sort()).toEqual([activeId, archivedId].sort());
    expect(ids).not.toContain(trashedId);
  });

  it("returns trashed rows alongside the rest in one pass", async () => {
    const ids = await ndjsonIds("?type=core.note&state=any");
    // By identity: a count assertion would still pass if the sentinel were
    // read as a plain state filter and matched nothing at all.
    expect(ids.sort()).toEqual([activeId, archivedId, trashedId].sort());
  });

  it("still honours a single named state", async () => {
    expect(await ndjsonIds("?type=core.note&state=trashed")).toEqual([
      trashedId,
    ]);
    expect(await ndjsonIds("?type=core.note&state=archived")).toEqual([
      archivedId,
    ]);
  });

  it("refuses a state that is not a state", async () => {
    const res = await request(ctx.app, "GET", "/export?state=nonsense", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Invalid state");
  });
});

describe("GET /export?format=archive — the same sentinel on the other format", () => {
  it("defaults to excluding trashed rows", async () => {
    const ids = await archiveIds("?format=archive&type=core.note");
    expect(ids.sort()).toEqual([activeId, archivedId].sort());
  });

  it("returns trashed rows alongside the rest in one pass", async () => {
    const ids = await archiveIds("?format=archive&type=core.note&state=any");
    expect(ids.sort()).toEqual([activeId, archivedId, trashedId].sort());
  });

  it("refuses a state that is not a state", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/export?format=archive&state=nonsense",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Invalid state");
  });
});
