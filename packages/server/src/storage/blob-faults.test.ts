import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearFaults, setFault } from "../control/faults.js";
import { DiskBlobStore } from "./blob-store.js";
import { withBlobFaults } from "./blob-faults.js";
import { diskFull } from "./disk-space.js";
import { createHash } from "node:crypto";

const BYTES = Buffer.from("bytes under a name");
const HASH = `sha256:${createHash("sha256").update(BYTES).digest("hex")}`;

let folder: string;
let store: DiskBlobStore;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "blob-faults-"));
  store = withBlobFaults(new DiskBlobStore(folder));
  await store.attach();
});

afterEach(async () => {
  clearFaults();
  await rm(folder, { recursive: true, force: true });
});

const source = () => ({
  stream: Readable.from([BYTES]),
  size_bytes: BYTES.length,
});

describe("a store made to fail", () => {
  it("fails a write as a volume with no room does, once, and keeps nothing", async () => {
    setFault("fail:blob-write", null);
    const failure = await store.put(HASH, source()).catch((e: unknown) => e);
    expect(diskFull(failure)).toBeDefined();
    expect(await store.has(HASH)).toBeNull();
    await store.put(HASH, source());
    expect(await store.has(HASH)).toEqual({ size_bytes: BYTES.length });
  });

  it("fails the nth read and the nth delete, and no other", async () => {
    await store.put(HASH, source());
    setFault("fail:blob-read", "2");
    expect(await store.get(HASH)).not.toBeNull();
    await expect(store.get(HASH)).rejects.toThrow(/i\/o error/);
    expect(await store.get(HASH)).not.toBeNull();

    setFault("fail:blob-delete", null);
    await expect(store.delete(HASH)).rejects.toThrow(/i\/o error/);
    expect(await store.has(HASH)).not.toBeNull();
    await store.delete(HASH);
    expect(await store.has(HASH)).toBeNull();
  });

  it("ends the nth read cleanly after half its bytes, and no other", async () => {
    await store.put(HASH, source());
    const bytesOf = async (read: Awaited<ReturnType<typeof store.get>>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of read!.stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };
    setFault("fail:blob-read-short", "2");
    expect(await bytesOf(await store.get(HASH))).toEqual(BYTES);
    const short = await store.get(HASH);
    expect(short?.length).toBe(BYTES.length);
    expect(await bytesOf(short)).toEqual(
      BYTES.subarray(0, Math.floor(BYTES.length / 2)),
    );
    expect(await bytesOf(await store.get(HASH))).toEqual(BYTES);
  });

  it("hands a read the signal that calls it off", async () => {
    await store.put(HASH, source());
    const called = new AbortController();
    called.abort();
    await expect(
      store.get(HASH, undefined, called.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
