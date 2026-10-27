/** Archive helpers the archive tests share: pack, unpack, export, restore. */
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { expect } from "vitest";
import type { TestContext } from "../test-utils.js";
import { request } from "../test-utils.js";

export async function extractArchive(
  data: Buffer,
): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => {
        if (!Buffer.isBuffer(c)) throw new Error("Expected archive bytes");
        chunks.push(c);
      });
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
export async function repack(
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

/** Export the instance as an archive, through the working key. */
export async function exportArchive(ctx: TestContext): Promise<Buffer> {
  const res = await request(ctx.app, "GET", `/export?format=archive`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

/** Full archive restore uses the recently authenticated owner session. */
export async function restore(
  ctx: TestContext,
  archive: Buffer,
): Promise<Response> {
  return await ctx.app.request(`/restore`, {
    method: "POST",
    headers: {
      cookie: ctx.owner.cookie,
      origin: new URL(ctx.config.authBaseUrl).origin,
      "Content-Type": "application/gzip",
    },
    body: archive,
  });
}
