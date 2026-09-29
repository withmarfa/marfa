import { createHash } from "node:crypto";
import { createReadStream, unlinkSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it, expect, afterEach } from "vitest";
import { BlobHashMismatch, DiskBlobStore, resolveRange } from "./blob-store.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "blob-store-test-"));
  dirs.push(dir);
  return dir;
}

function hashOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

describe("DiskBlobStore", () => {
  describe("attach", () => {
    it("mints an id into a marker on first attach and reads it back after", async () => {
      const dir = await freshDir();
      const first = new DiskBlobStore(dir);
      expect(() => first.id).toThrow(/attach/);
      await first.attach();
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
      const marker = JSON.parse(
        await readFile(join(dir, ".marfa-store"), "utf8"),
      ) as { id: string };
      expect(marker.id).toBe(first.id);

      // The identity is the folder's, not the process's: a second attach
      // to the same folder is the same store.
      const second = new DiskBlobStore(dir);
      await second.attach();
      expect(second.id).toBe(first.id);

      // And a fresh folder is a fresh store.
      const other = new DiskBlobStore(await freshDir());
      await other.attach();
      expect(other.id).not.toBe(first.id);
    });

    it("refuses a marker that names no id", async () => {
      const dir = await freshDir();
      await writeFile(join(dir, ".marfa-store"), "{}\n");
      await expect(new DiskBlobStore(dir).attach()).rejects.toThrow(
        /names no id/,
      );
    });

    it("empties the spool each boot", async () => {
      const dir = await freshDir();
      const store = new DiskBlobStore(dir);
      await store.attach();
      await writeFile(join(store.spoolDir, "left-by-a-dead-process"), "x");
      expect(await readdir(store.spoolDir)).toHaveLength(1);
      await new DiskBlobStore(dir).attach();
      expect(await readdir(store.spoolDir)).toHaveLength(0);
    });
  });

  describe("put", () => {
    it("keeps a stream that hashes to its name and refuses one that does not", async () => {
      const store = new DiskBlobStore(await freshDir());
      await store.attach();
      const bytes = Buffer.from("bytes under their own name");
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      expect(await store.has(hashOf(bytes))).toEqual({
        size_bytes: bytes.length,
      });

      const wrongName = hashOf(Buffer.from("something else"));
      await expect(
        store.put(wrongName, {
          stream: Readable.from(bytes),
          size_bytes: bytes.length,
        }),
      ).rejects.toBeInstanceOf(BlobHashMismatch);
      expect(await store.has(wrongName)).toBeNull();
      // Nothing is left in the spool either.
      expect(await readdir(store.spoolDir)).toHaveLength(0);
    });

    it("refuses a stream whose length disagrees with size_bytes", async () => {
      const store = new DiskBlobStore(await freshDir());
      await store.attach();
      const bytes = Buffer.from("twelve bytes");
      await expect(
        store.put(hashOf(bytes), {
          stream: Readable.from(bytes),
          size_bytes: bytes.length + 1,
        }),
      ).rejects.toBeInstanceOf(BlobHashMismatch);
      expect(await store.has(hashOf(bytes))).toBeNull();
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      expect(await store.has(hashOf(bytes))).not.toBeNull();
    });

    it("moves a path source into place, and discards a duplicate", async () => {
      const store = new DiskBlobStore(await freshDir());
      await store.attach();
      const bytes = Buffer.from("spooled by the upload route");
      const spool = store.spoolPath();
      await writeFile(spool, bytes);
      await store.put(hashOf(bytes), { path: spool, size_bytes: bytes.length });
      await expect(stat(spool)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await store.has(hashOf(bytes))).toEqual({
        size_bytes: bytes.length,
      });

      // A second spool of the same bytes loses the race and is dropped,
      // never copied over the winner.
      const again = store.spoolPath();
      await writeFile(again, bytes);
      await store.put(hashOf(bytes), { path: again, size_bytes: bytes.length });
      await expect(stat(again)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(store.spoolDir)).toHaveLength(0);
    });
  });

  describe("get", () => {
    it("streams the whole blob, or one range of it, and null when absent", async () => {
      const store = new DiskBlobStore(await freshDir());
      await store.attach();
      const bytes = Buffer.from("0123456789");
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });

      const whole = await store.get(hashOf(bytes));
      expect(whole).not.toBeNull();
      expect(whole?.size_bytes).toBe(10);
      expect(whole?.offset).toBe(0);
      expect(whole?.length).toBe(10);
      expect((await collect(whole!.stream)).equals(bytes)).toBe(true);

      const part = await store.get(hashOf(bytes), { start: 3, end: 5 });
      expect(part?.size_bytes).toBe(10);
      expect(part?.offset).toBe(3);
      expect(part?.length).toBe(3);
      expect((await collect(part!.stream)).toString()).toBe("345");

      expect(await store.get(hashOf(Buffer.from("absent")))).toBeNull();
    });

    it("holds the file it found, so a read dropped unread or finished after the file goes raises nothing", async () => {
      const dir = await freshDir();
      const store = new DiskBlobStore(dir);
      await store.attach();
      const bytes = Buffer.from("removed while read");
      const hash = hashOf(bytes);
      await store.put(hash, {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      const hex = hash.slice("sha256:".length);
      const path = join(dir, hex.slice(0, 4), hex);
      const errorsOf = async (stream: Readable): Promise<unknown[]> => {
        const errors: unknown[] = [];
        stream.on("error", (err) => errors.push(err));
        await new Promise((resolve) => stream.once("close", resolve));
        return errors;
      };

      // The witness: a stream that opens its path itself, dropped unread
      // and its file removed in the same tick, errors when it opens.
      const lazy = createReadStream(path);
      const lazyErrors = errorsOf(lazy);
      lazy.destroy();
      unlinkSync(path);
      expect(await lazyErrors).toMatchObject([{ code: "ENOENT" }]);
      await store.put(hash, {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });

      const dropped = await store.get(hash);
      const droppedErrors = errorsOf(dropped!.stream);
      dropped!.stream.destroy();
      unlinkSync(path);
      expect(await droppedErrors).toEqual([]);
      await store.put(hash, {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });

      const finished = await store.get(hash);
      unlinkSync(path);
      expect((await collect(finished!.stream)).equals(bytes)).toBe(true);
    });

    it("refuses a hash that would escape the store", async () => {
      const store = new DiskBlobStore(await freshDir());
      await store.attach();
      await expect(store.get("sha256:../../etc/passwd")).rejects.toThrow(
        /escapes/,
      );
    });
  });

  describe("delete", () => {
    it("removes the bytes and is idempotent", async () => {
      const store = new DiskBlobStore(await freshDir());
      await store.attach();
      const bytes = Buffer.from("to be deleted");
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      expect(await store.has(hashOf(bytes))).not.toBeNull();
      await store.delete(hashOf(bytes));
      expect(await store.has(hashOf(bytes))).toBeNull();
      await expect(store.delete(hashOf(bytes))).resolves.toBeUndefined();
    });
  });
});

describe("resolveRange", () => {
  it("resolves one range, clamps an open end, and refuses one past the end", () => {
    expect(resolveRange(undefined, 10)).toBeUndefined();
    expect(resolveRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(resolveRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(resolveRange("bytes=7-99", 10)).toEqual({ start: 7, end: 9 });
    expect(resolveRange("bytes=10-", 10)).toBeNull();
    expect(resolveRange("bytes=5-4", 10)).toBeNull();
  });

  it("does not serve a suffix range or several ranges", () => {
    expect(resolveRange("bytes=-5", 10)).toBeUndefined();
    expect(resolveRange("bytes=0-1,3-4", 10)).toBeUndefined();
    expect(resolveRange("items=0-1", 10)).toBeUndefined();
  });
});
