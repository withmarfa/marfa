import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const path = String(args[0]);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        calls.push(`sync ${path}`);
        await sync();
      };
      const datasync = handle.datasync.bind(handle);
      handle.datasync = async () => {
        calls.push(`datasync ${path}`);
        await datasync();
      };
      return handle;
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      calls.push(`rename ${String(args[0])} ${String(args[1])}`);
      await real.rename(...args);
    },
  };
});

const { DiskBlobStore } = await import("./blob-store.js");

const dirs: string[] = [];
afterEach(async () => {
  calls.length = 0;
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function attachedStore() {
  const dir = await mkdtemp(join(tmpdir(), "blob-durability-"));
  dirs.push(dir);
  const store = new DiskBlobStore(dir);
  await store.attach();
  calls.length = 0;
  return { dir, store };
}

/** The steps that matter, in the order they happened. */
function steps(): string[] {
  return calls.map((call) => call.split(" ")[0] ?? "");
}

describe("a blob reaching its final name", () => {
  // A point-in-time image of the data directory (a volume snapshot, an APFS
  // snapshot) holds only what the disk had been told to keep. A row that
  // names a blob can then outlive the bytes, or the name, unless both were
  // made durable before the row could commit.
  it("is synced before it is renamed, and its directory after (a spooled file)", async () => {
    const { dir, store } = await attachedStore();
    const bytes = Buffer.from("a spooled upload");
    const hash =
      "sha256:6f1ba6a2b6a0f5f1c5d79bc3bfe5c2b2ad2a2f4f9f6f5d3c3b0b6c2c9a3a4e11";
    const spool = store.spoolPath();
    await writeFile(spool, bytes);

    await store.put(hash, { path: spool, size_bytes: bytes.length });

    expect(steps()).toEqual(["sync", "rename", "sync"]);
    expect(calls[0]).toBe(`sync ${spool}`);
    expect(calls[2]).toMatch(
      new RegExp(`^sync ${dir.replaceAll("\\", "\\\\")}/6f1b$`),
    );
  });

  it("is synced before it is renamed, and its directory after (a stream)", async () => {
    const { store } = await attachedStore();
    const bytes = Buffer.from("a streamed replica");
    const { createHash } = await import("node:crypto");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    await store.put(hash, {
      stream: Readable.from([bytes]),
      size_bytes: bytes.length,
    });

    expect(steps()).toEqual(["sync", "rename", "sync"]);
  });

  it("syncs nothing for bytes already in place", async () => {
    const { store } = await attachedStore();
    const bytes = Buffer.from("already here");
    const { createHash } = await import("node:crypto");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const first = store.spoolPath();
    await writeFile(first, bytes);
    await store.put(hash, { path: first, size_bytes: bytes.length });
    calls.length = 0;

    const again = store.spoolPath();
    await writeFile(again, bytes);
    await store.put(hash, { path: again, size_bytes: bytes.length });

    expect(steps()).toEqual([]);
  });
});
