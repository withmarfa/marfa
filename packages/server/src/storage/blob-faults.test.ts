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

describe("a store made to hang", () => {
  const settledSoon = async (work: Promise<unknown>) =>
    Promise.race([
      work.then(() => true),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, 30);
      }),
    ]);

  it("holds a write and a delete until the fault is cleared, and then carries each out", async () => {
    setFault("hold:blob-write", null);
    const write = store.put(HASH, source());
    expect(await settledSoon(write)).toBe(false);
    expect(await store.has(HASH)).toBeNull();
    clearFaults();
    await write;
    expect(await store.has(HASH)).toEqual({ size_bytes: BYTES.length });

    setFault("hold:blob-delete", null);
    const removal = store.delete(HASH);
    expect(await settledSoon(removal)).toBe(false);
    expect(await store.has(HASH)).not.toBeNull();
    clearFaults();
    await removal;
    expect(await store.has(HASH)).toBeNull();
  });

  it("holds only the nth read when the hold names one", async () => {
    await store.put(HASH, source());
    setFault("hold:blob-read", "2");
    expect(await store.get(HASH)).not.toBeNull();
    const second = store.get(HASH);
    expect(await settledSoon(second)).toBe(false);
    expect(await store.get(HASH)).not.toBeNull();
    clearFaults();
    expect(await second).not.toBeNull();
  });
});

describe("a blob made to read as lost or damaged", () => {
  const OTHER = `sha256:${"b".repeat(64)}`;
  const bytesOf = async (read: Awaited<ReturnType<typeof store.get>>) => {
    const chunks: Buffer[] = [];
    for await (const chunk of read!.stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  it("reads a lost blob as absent to a read and a question, and no other blob", async () => {
    await store.put(HASH, source());
    setFault("lose:blob", HASH);
    expect(await store.get(HASH)).toBeNull();
    expect(await store.has(HASH)).toBeNull();
    setFault("lose:blob", `${HASH},${OTHER}`);
    expect(await store.has(OTHER)).toBeNull();
    clearFaults();
    expect(await store.has(HASH)).toEqual({ size_bytes: BYTES.length });
  });

  it("ends the loss when the store places the blob again or deletes it", async () => {
    await store.put(HASH, source());
    setFault("lose:blob", HASH);
    await store.put(HASH, source());
    expect(await store.has(HASH)).not.toBeNull();

    setFault("lose:blob", HASH);
    await store.delete(HASH);
    await store.put(HASH, source());
    expect(await store.has(HASH)).not.toBeNull();
  });

  it("reads a damaged blob with its first byte changed and its length kept, until the store deletes it", async () => {
    await store.put(HASH, source());
    setFault("damage:blob", HASH);
    const read = await store.get(HASH);
    const shown = await bytesOf(read);
    expect(shown.length).toBe(BYTES.length);
    expect(shown[0]).toBe(BYTES[0]! ^ 0xff);
    expect(shown.subarray(1)).toEqual(BYTES.subarray(1));
    expect(await store.has(HASH)).toEqual({ size_bytes: BYTES.length });

    await store.put(HASH, source());
    expect((await bytesOf(await store.get(HASH)))[0]).toBe(BYTES[0]! ^ 0xff);
    await store.delete(HASH);
    await store.put(HASH, source());
    expect(await bytesOf(await store.get(HASH))).toEqual(BYTES);
  });

  it("changes nothing for a read that does not start at the first byte", async () => {
    await store.put(HASH, source());
    setFault("damage:blob", HASH);
    const tail = await store.get(HASH, { start: 1, end: 4 });
    expect(await bytesOf(tail)).toEqual(BYTES.subarray(1, 5));
  });

  it("fails a read and a question of presence for an unreadable blob alone, until the store deletes it", async () => {
    await store.put(HASH, source());
    setFault("damage:blob-unreadable", HASH);
    await expect(store.get(HASH)).rejects.toThrow(/i\/o error/);
    await expect(store.has(HASH)).rejects.toThrow(/i\/o error/);
    await store.delete(HASH);
    await store.put(HASH, source());
    expect(await store.has(HASH)).not.toBeNull();
  });
});
