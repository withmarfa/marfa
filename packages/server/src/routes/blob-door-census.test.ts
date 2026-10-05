/**
 * Every door under `/blobs`, and the credential it answers.
 *
 * **A census rather than a test per door, for the reason the permission
 * census exists.** A blob's reach is borrowed from the items that reference
 * it, and the check that borrows it is one function the reading doors call.
 * A door added without calling it reads as covered from every angle a
 * per-route test can see. So the doors are read out of the app's own route
 * table, each has to be classified below before this file goes green, and
 * every door classified as reading is then driven with a credential that may
 * not read the blob, which is what the classification alone cannot prove.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Doors that read a blob for a credential, held to the read rule. */
const READING = [
  "GET /blobs/:hash",
  "GET /blobs/:hash/url",
  "GET /blobs/:hash/locations",
];

/** Doors only the operator key opens, refusing a working key outright. */
const OPERATOR_ONLY = [
  "GET /blobs/orphans",
  "GET /blobs/stores",
  "DELETE /blobs/:hash/locations/:store",
];

/**
 * Doors that answer a blob's bytes. Each answer, whatever type the bytes
 * were uploaded under, is a download a browser will not render as a page
 * of the instance's origin.
 */
const BYTES = ["GET /blobs/:hash", "GET /blobs/:hash/fetch"];

/** Doors with a rule of their own, each with what that rule is. */
const OWN_RULE: Record<string, string> = {
  "POST /blobs":
    "an upload, which takes write on at least one type rather than read on a referencing item",
  "GET /blobs/:hash/fetch":
    "the target of a link the reading door minted; the signature in the query is the credential, checked when the link was handed out",
};

function blobDoors(): string[] {
  return [
    ...new Set(
      ctx.app.routes
        .filter((r) => r.path === "/blobs" || r.path.startsWith("/blobs/"))
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();
}

function pathFor(door: string, hash: string): [string, string] {
  const [method, path] = door.split(" ") as [string, string];
  return [
    method,
    path.replace(":hash", hash).replace(":store", ctx.blobs.disk.id),
  ];
}

async function errorCode(res: Response): Promise<string | undefined> {
  if (res.headers.get("Content-Type")?.includes("application/json") !== true) {
    return undefined;
  }
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

/**
 * Every module outside `storage/` and `housekeeping/` that names a type
 * giving hold of a store's bytes, with what it does with them. A
 * byte-serving door outside `/blobs` is invisible to the route walk below,
 * so it is caught here instead: a new holder fails until it is named.
 *
 * What this sees is a module naming one of `BYTE_TYPES`; a module reaching
 * bytes without naming any of them, through a value typed elsewhere, is
 * not seen. `storage/` is the layer itself and `housekeeping/` holds the
 * jobs that act on every blob for no row and no credential.
 */
const BYTE_TYPES =
  /\b(createBlobLayer|BlobLayer|BlobStore|DiskBlobStore|S3BlobStore|BlobRead|Stores)\b/;

const BLOB_LAYER_HOLDERS: Record<string, string> = {
  "app.ts": "wiring: hands the layer to the routes below",
  "index.ts": "wiring: builds the layer at boot",
  "openapi-published.ts": "wiring: builds an app to read its document",
  "enrichment/sweeper.ts":
    "reads a file's bytes for its own row, only where that row's blob_ref reference lends (listCandidates)",
  "routes/blobs.ts": "the doors this census walks",
  "routes/export.ts": "hands the layer to the archive export below",
  "routes/export-archive.ts":
    "the export archive, which carries a blob's bytes only where mayReadBlob admits the caller",
  "routes/restore-archive.ts": "the restore, operator key only, writes bytes",
  "routes/health.ts": "a probe of the disk store under a fixed name",
};

function blobLayerHolders(): string[] {
  const root = join(import.meta.dirname, "..");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (rel === "storage" || rel === "housekeeping") continue;
        walk(rel);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        rel !== "test-utils.ts" &&
        BYTE_TYPES.test(readFileSync(join(root, rel), "utf8"))
      ) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

describe("every blob door is held to the credential's reach", () => {
  it("names every module holding the blob layer, and the export asks the read rule", () => {
    expect(blobLayerHolders()).toEqual(Object.keys(BLOB_LAYER_HOLDERS).sort());
    const exporter = readFileSync(
      join(import.meta.dirname, "export-archive.ts"),
      "utf8",
    );
    expect(exporter).toContain("mayReadBlob(");
    const candidates = readFileSync(
      join(import.meta.dirname, "../storage/sqlite/enrichment-store.ts"),
      "utf8",
    );
    expect(candidates).toContain("item_blob_references.lends");
  });

  it("classifies every door the app serves under /blobs, and no door it does not", () => {
    const doors = blobDoors();
    expect(doors.length).toBeGreaterThan(5);
    expect(doors).toEqual(
      [...READING, ...OPERATOR_ONLY, ...Object.keys(OWN_RULE)].sort(),
    );
    for (const door of BYTES) expect(doors).toContain(door);
  });

  it("answers a blob only an unreadable item references as unknown, on every reading door", async () => {
    const bytes = new TextEncoder().encode(
      "held by a file a note key cannot read",
    );
    const upload = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const named = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.file",
        properties: { blob_ref: hash, mime_type: "text/plain" },
      },
    });
    expect(named.status).toBe(201);
    const fileReader = await mintWorkingKey(ctx, {
      type_permissions: { "core.file": "read" },
    });
    const noteReader = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
    });
    const empty = await mintWorkingKey(ctx, { type_permissions: {} });

    for (const door of READING) {
      const [method, path] = pathFor(door, hash);
      for (const verb of method === "GET" ? ["GET", "HEAD"] : [method]) {
        // The witness: a key reaching the referencing item is served.
        const served = await request(ctx.app, verb, path, { key: fileReader });
        expect(served.status, `${verb} ${door}, the file reader`).toBe(200);

        const hidden = await request(ctx.app, verb, path, { key: noteReader });
        expect(hidden.status, `${verb} ${door}, the note reader`).toBe(404);
        if (verb !== "HEAD") {
          expect(await errorCode(hidden)).toBe("blob_not_found");
        }

        const refused = await request(ctx.app, verb, path, { key: empty });
        expect(refused.status, `${verb} ${door}, the empty key`).toBe(403);
        if (verb !== "HEAD") {
          expect(await errorCode(refused)).toBe("type_not_permitted");
        }
      }
    }
  });

  it("refuses an upload to a key that may write no type, and stores nothing", async () => {
    const reader = await mintWorkingKey(ctx, {
      type_permissions: { "*": "read" },
    });
    const bytes = new TextEncoder().encode("sent by a key that writes nothing");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reader}`,
        "Content-Type": "text/plain",
      },
      body: bytes,
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("type_not_permitted");
    expect(await ctx.storage.blobs.get(hash)).toBeNull();
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
  });

  it("answers bytes only as an inert download, on every door that answers them", async () => {
    const bytes = new TextEncoder().encode(
      "<!doctype html><script>document.title = 'ran'</script>",
    );
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const upload = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "text/html",
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const minted = await request(ctx.app, "GET", `/blobs/${hash}/url`, {
      key: ctx.operatorKey,
    });
    const link = new URL(((await minted.json()) as { url: string }).url);

    // Every door the app serves a GET or HEAD on is driven, so a new door
    // answering bytes is caught here rather than by remembering to list it.
    const answered: string[] = [];
    for (const door of blobDoors().filter((d) => d.startsWith("GET "))) {
      let [, path] = pathFor(door, hash);
      if (door === "GET /blobs/:hash/fetch") path += link.search;
      for (const verb of ["GET", "HEAD"]) {
        const res = await request(ctx.app, verb, path, {
          key: ctx.operatorKey,
        });
        const type = res.headers.get("Content-Type") ?? "";
        if (res.status >= 300 || type.startsWith("application/json")) continue;
        answered.push(door.replace("GET", verb));
        expect(type, `${verb} ${door}`).toBe("text/html");
        expect(res.headers.get("Content-Disposition"), `${verb} ${door}`).toBe(
          `attachment; filename="${hash.slice("sha256:".length)}"`,
        );
        expect(
          res.headers.get("Content-Security-Policy"),
          `${verb} ${door}`,
        ).toBe("sandbox; default-src 'none'");
        // Sent on every answer by the app's security headers, not the door.
        expect(
          res.headers.get("X-Content-Type-Options"),
          `${verb} ${door}`,
        ).toBe("nosniff");
      }
    }
    // The witness: each door classified as answering bytes did answer them.
    expect(answered.sort()).toEqual(
      BYTES.flatMap((door) => [door, door.replace("GET", "HEAD")]).sort(),
    );
  });

  it("refuses a working key on every operator door", async () => {
    const hash = `sha256:${"c".repeat(64)}`;
    for (const door of OPERATOR_ONLY) {
      const [method, path] = pathFor(door, hash);
      const res = await request(ctx.app, method, path, {
        key: ctx.workingKey,
      });
      expect(res.status, door).toBe(403);
      expect(await errorCode(res)).toBe("forbidden");
    }
  });
});
