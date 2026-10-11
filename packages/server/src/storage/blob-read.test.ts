import { Readable } from "node:stream";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundBlobRead } from "./blob-read.js";

afterEach(() => vi.useRealTimers());

function endless(): Readable {
  return new Readable({
    highWaterMark: 64 * 1024,
    read() {
      this.push(Buffer.alloc(64 * 1024, 42));
    },
  });
}

describe("blob read idle lifetime", () => {
  it("closes the actual file descriptor before garbage collection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blob-idle-fd-"));
    const handle = await open(join(dir, "blob"), "w+");
    try {
      await handle.truncate(1024 * 1024);
      const source = handle.createReadStream();
      const closed = new Promise<void>((resolve) =>
        source.once("close", resolve),
      );
      boundBlobRead(source, 30);
      await closed;
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("closes an unread source and makes the idle error visible to a later reader", async () => {
    vi.useFakeTimers();
    const source = endless();
    const output = boundBlobRead(source, 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(source.destroyed).toBe(true);
    await expect(output.iterator().next()).rejects.toMatchObject({
      code: "ERR_BLOB_READ_IDLE",
    });
  });

  it("keeps progressing reads alive beyond one deadline and closes on cancellation", async () => {
    vi.useFakeTimers();
    const source = endless();
    const output = boundBlobRead(source, 100);
    const reader = Readable.toWeb(output).getReader();
    for (let i = 0; i < 10; i++) {
      expect((await reader.read()).done).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
    }
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps completed bytes readable after the idle deadline", async () => {
    vi.useFakeTimers();
    const source = Readable.from([Buffer.from("complete")]);
    const output = boundBlobRead(source, 100);
    await vi.advanceTimersByTimeAsync(200);
    expect(source.destroyed).toBe(true);
    expect(output.destroyed).toBe(false);
    const chunks: Buffer[] = [];
    for await (const chunk of output) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("complete");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a source failure and clears its deadline", async () => {
    vi.useFakeTimers();
    const source = endless();
    const output = boundBlobRead(source, 100);
    source.destroy(new Error("store unavailable"));
    await expect(output.iterator().next()).rejects.toThrow("store unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });
});
