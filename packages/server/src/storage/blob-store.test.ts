import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, unlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  BlobHashMismatch,
  BlobStoreUnreachable,
  DiskBlobStore,
  resolveRange,
} from "./blob-store.js";

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

    it("refuses a read that closed before the write began, rather than wait on it", async () => {
      // A copy whose writer was given up on can start long after its source
      // read closed, and the write holds the blob's lock until it ends.
      const source = new DiskBlobStore(await freshDir());
      const store = new DiskBlobStore(await freshDir());
      await source.attach();
      await store.attach();
      const bytes = Buffer.from("a read that closed before its write");
      await source.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      const read = await source.get(hashOf(bytes));
      if (!read) throw new Error("the source holds the bytes");
      // Left unread long enough for the whole file to reach its buffer.
      await new Promise((resolve) => setTimeout(resolve, 50));
      read.stream.destroy();
      const outcome = await Promise.race([
        store.put(hashOf(bytes), read).then(
          () => "written",
          () => "refused",
        ),
        new Promise((resolve) => setTimeout(resolve, 2_000, "waiting")),
      ]);
      expect(outcome).toBe("refused");
      expect(await store.has(hashOf(bytes))).toBeNull();
      expect(await readdir(store.spoolDir)).toHaveLength(0);
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
    it("survives garbage collection of an unread response on the running Node version", async () => {
      const moduleUrl = new URL("./blob-store.ts", import.meta.url).href;
      const script = `
        import { mkdtemp, rm } from "node:fs/promises";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { createHash } from "node:crypto";
        import { Readable } from "node:stream";
        import { DiskBlobStore } from ${JSON.stringify(moduleUrl)};
        const dir = await mkdtemp(join(tmpdir(), "blob-gc-test-"));
        try {
          const store = new DiskBlobStore(dir, 50);
          await store.attach();
          const bytes = Buffer.alloc(8 * 1024 * 1024, 42);
          const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
          await store.put(hash, { stream: Readable.from(bytes), size_bytes: bytes.length });
          await (async () => {
            const read = await store.get(hash);
            new Response(Readable.toWeb(read.stream));
          })();
          for (let i = 0; i < 10; i++) {
            global.gc();
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          console.log("survived");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      `;
      const result = await promisify(execFile)(process.execPath, [
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
      ]);
      expect(result.stdout.trim()).toBe("survived");
      expect(result.stderr).toBe("");
    });

    it("closes an unread large blob after its idle deadline", async () => {
      const store = new DiskBlobStore(await freshDir(), 30);
      await store.attach();
      const bytes = Buffer.alloc(1024 * 1024, 42);
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      const read = (await store.get(hashOf(bytes)))!;
      await vi.waitFor(() => {
        expect(read.stream.destroyed).toBe(true);
      });
    });

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

describe("a DiskBlobStore that cannot be reached", () => {
  /** An attached store holding one blob, and that blob's name. */
  async function holding(): Promise<{
    store: DiskBlobStore;
    hash: string;
    absent: string;
  }> {
    const store = new DiskBlobStore(join(await freshDir(), "blobs"));
    await store.attach();
    const bytes = Buffer.from("kept on a drive that can go");
    const hash = hashOf(bytes);
    await store.put(hash, {
      stream: Readable.from(bytes),
      size_bytes: bytes.length,
    });
    return { store, hash, absent: hashOf(Buffer.from("never stored")) };
  }

  async function answersForEveryVerb(
    store: DiskBlobStore,
    hash: string,
  ): Promise<void> {
    await expect(store.get(hash)).rejects.toBeInstanceOf(BlobStoreUnreachable);
    await expect(store.has(hash)).rejects.toBeInstanceOf(BlobStoreUnreachable);
    await expect(store.delete(hash)).rejects.toBeInstanceOf(
      BlobStoreUnreachable,
    );
  }

  it("answers absent for a name a present store does not hold, which is the witness for the rest", async () => {
    const { store, absent } = await holding();
    expect(await store.get(absent)).toBeNull();
    expect(await store.has(absent)).toBeNull();
    await expect(store.delete(absent)).resolves.toBeUndefined();
  });

  it("rejects, rather than answers absent, once the folder is gone, and answers again when it returns", async () => {
    const { store, hash, absent } = await holding();
    const away = `${store.locator}.away`;
    await rename(store.locator, away);
    await answersForEveryVerb(store, hash);
    await answersForEveryVerb(store, absent);

    await rename(away, store.locator);
    const read = await store.get(hash);
    expect((await collect(read!.stream)).toString()).toBe(
      "kept on a drive that can go",
    );
    expect(await store.get(absent)).toBeNull();
  });

  it("rejects when the folder is there but empty, as a mount point is without its drive", async () => {
    const { store, hash } = await holding();
    const away = `${store.locator}.away`;
    await rename(store.locator, away);
    await mkdir(store.locator);
    await answersForEveryVerb(store, hash);

    await rm(store.locator, { recursive: true });
    await rename(away, store.locator);
    expect(await store.has(hash)).not.toBeNull();
  });

  it("rejects when the folder is another store's, or its marker cannot be read as one", async () => {
    const { store, hash, absent } = await holding();
    const marker = join(store.locator, ".marfa-store");
    const own = await readFile(marker, "utf8");

    // A name the folder does hold is still served: the bytes are there.
    await writeFile(marker, '{"id":"another-store"}\n');
    expect(await store.has(hash)).not.toBeNull();
    await answersForEveryVerb(store, absent);
    await writeFile(marker, "not json");
    await answersForEveryVerb(store, absent);

    await writeFile(marker, own);
    expect(await store.has(hash)).not.toBeNull();
  });

  it("deletes nothing of a blob it cannot reach", async () => {
    const { store, hash } = await holding();
    const away = `${store.locator}.away`;
    await rename(store.locator, away);
    await expect(store.delete(hash)).rejects.toBeInstanceOf(
      BlobStoreUnreachable,
    );
    await rename(away, store.locator);
    expect(await store.has(hash)).not.toBeNull();
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
