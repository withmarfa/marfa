import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { setAvailableBytesProbe } from "../storage/disk-space.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";

const MIB = 1024 * 1024;

let ctx: TestContext | undefined;
afterEach(async () => {
  setAvailableBytesProbe(undefined);
  await ctx?.cleanup();
  ctx = undefined;
});

async function boot(diskReserveBytes: number): Promise<TestContext> {
  ctx = await createTestContext({ diskReserveBytes });
  return ctx;
}

/**
 * A volume that loses `lostPerLook` bytes at each look at it, from `start`:
 * the room a body leaves behind it as it is written, said by a test and not
 * left to whatever else is using the machine's disk.
 */
function shrinking(start: number, lostPerLook: number) {
  const state = { looks: 0 };
  setAvailableBytesProbe(() => {
    state.looks++;
    return Promise.resolve(start - (state.looks - 1) * lostPerLook);
  });
  return state;
}

async function spoolEntries(c: TestContext): Promise<string[]> {
  return readdir(join(c.config.blobPath, "tmp"));
}

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function upload(
  c: TestContext,
  body: Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
) {
  return c.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.workingKey}`,
      "Content-Type": "application/octet-stream",
      ...headers,
    },
    body,
    // Node's fetch needs `duplex` to send a stream.
    duplex: "half",
  });
}

/** A body of `mebibytes` MiB with no length of its own, so only the guard
 *  can see how large it is. */
function streamed(mebibytes: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    Readable.from(
      (function* () {
        for (let i = 0; i < mebibytes; i++) yield Buffer.alloc(MIB, i % 251);
      })(),
    ),
  ) as ReadableStream<Uint8Array>;
}

async function errorOf(res: Response) {
  return (
    (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: Record<string, number>;
      };
    }
  ).error;
}

/** A gzipped tar of a manifest and one blob entry of `mebibytes` MiB of
 *  zeros, under a name that is a hash, which inflates a thousandfold. */
async function inflatingArchive(mebibytes: number): Promise<Buffer> {
  const pack = tar.pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => gzip.on("end", resolve));
  pack.pipe(gzip);
  const manifest = Buffer.from(
    JSON.stringify({ version: 0, format: "marfa-archive-v0", blobs: {} }),
  );
  pack.entry({ name: "manifest.json", size: manifest.length }, manifest);
  await pipeline(
    Readable.from(
      (function* () {
        const chunk = Buffer.alloc(MIB);
        for (let i = 0; i < mebibytes; i++) yield chunk;
      })(),
    ),
    pack.entry({
      name: `blobs/sha256:${"0".repeat(64)}`,
      size: mebibytes * MIB,
    }),
  );
  pack.finalize();
  await ended;
  return Buffer.concat(chunks);
}

function restore(c: TestContext, archive: Buffer): Promise<Response> {
  return Promise.resolve(
    c.app.request("/restore", {
      method: "POST",
      headers: {
        cookie: c.owner.cookie,
        origin: new URL(c.config.authBaseUrl).origin,
        "Content-Type": "application/gzip",
      },
      body: archive,
    }),
  );
}

describe("POST /blobs keeps the disk reserve", () => {
  it("refuses a body that declares more than the volume can take beside the reserve, and keeps nothing", async () => {
    const c = await boot(Number.MAX_SAFE_INTEGER);
    const bytes = Buffer.from("a few bytes");
    const res = await upload(c, bytes, {
      "Content-Length": String(bytes.length),
    });
    expect(res.status).toBe(507);
    const error = await errorOf(res);
    expect(error.code).toBe("insufficient_storage");
    expect(error.details?.reserve_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(typeof error.details?.available_bytes).toBe("number");
    expect(await c.storage.blobs.get(hashOf(bytes))).toBeNull();
    expect(await spoolEntries(c)).toEqual([]);
  });

  it("takes the same body once the reserve is one the volume can keep", async () => {
    const c = await boot(1);
    const bytes = Buffer.from("a few bytes");
    const res = await upload(c, bytes);
    expect(res.status).toBe(201);
    expect(await c.storage.blobs.get(hashOf(bytes))).not.toBeNull();
  });

  it("stops a body that declares no length as the volume falls inside the reserve, and removes its spool", async () => {
    const c = await boot(100 * MIB);
    const volume = shrinking(1000 * MIB, 40 * MIB);
    const res = await upload(c, streamed(128));
    expect(res.status).toBe(507);
    expect((await errorOf(res)).code).toBe("insufficient_storage");
    expect(await spoolEntries(c)).toEqual([]);
    // Refused part of the way through, not at the door and not at the end.
    expect(volume.looks).toBeGreaterThan(2);
    expect(volume.looks).toBeLessThan(128 / 4);
  });

  it("takes bodies that arrive together one at a time against the room", async () => {
    const c = await boot(100 * MIB);
    setAvailableBytesProbe(() => Promise.resolve(100 * MIB + 10 * MIB));
    const bodies = Array.from({ length: 4 }, () => Buffer.alloc(3 * MIB, 1));
    const answers = await Promise.all(
      bodies.map(async (body, i) => {
        // Different bytes, so the four are four blobs.
        body[0] = i;
        return (
          await upload(c, body, { "Content-Length": String(body.length) })
        ).status;
      }),
    );
    expect(answers.filter((status) => status === 201)).toHaveLength(1);
    expect(answers.filter((status) => status === 507)).toHaveLength(3);
  });

  it("takes the same streamed body when nothing is held back", async () => {
    const c = await boot(0);
    const res = await upload(c, streamed(16));
    expect(res.status).toBe(201);
  });

  it("does not ask the reserve of a JSON write", async () => {
    const c = await boot(Number.MAX_SAFE_INTEGER);
    const res = await request(c.app, "POST", "/items", {
      key: c.workingKey,
      body: { type: "core.note", properties: { body: "still taken" } },
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /restore keeps the disk reserve", () => {
  it("refuses an archive whose entry inflates past the reserve, and writes nothing", async () => {
    const c = await boot(100 * MIB);
    const volume = shrinking(1000 * MIB, 40 * MIB);
    const archive = await inflatingArchive(96);
    // The archive is small on the wire and large once inflated, which is
    // what the length it declares cannot show.
    expect(archive.length).toBeLessThan(2 * MIB);
    const res = await restore(c, archive);
    expect(res.status).toBe(507);
    expect((await errorOf(res)).code).toBe("insufficient_storage");
    expect(await spoolEntries(c)).toEqual([]);
    // Stopped while the entry was being written.
    expect(volume.looks).toBeGreaterThan(2);
  });

  it("refuses an entry by the size its header gives, before any of it is written", async () => {
    const c = await boot(100 * MIB);
    // Room for the reserve and a little over, not for a 96 MiB entry.
    const volume = shrinking(150 * MIB, 0);
    const res = await restore(c, await inflatingArchive(96));
    expect(res.status).toBe(507);
    expect((await errorOf(res)).code).toBe("insufficient_storage");
    // The archive's own admission and the entry's, and no look at a stream.
    expect(volume.looks).toBe(2);
    expect(await spoolEntries(c)).toEqual([]);
  });

  it("restores the same archive when nothing is held back", async () => {
    const c = await boot(0);
    const res = await restore(c, await inflatingArchive(96));
    expect(res.status).toBe(200);
    expect(await spoolEntries(c)).toEqual([]);
  });

  it("refuses an archive that declares more than the volume can take beside the reserve", async () => {
    const c = await boot(Number.MAX_SAFE_INTEGER);
    const res = await restore(c, await inflatingArchive(1));
    expect(res.status).toBe(507);
    expect((await errorOf(res)).code).toBe("insufficient_storage");
  });
});
