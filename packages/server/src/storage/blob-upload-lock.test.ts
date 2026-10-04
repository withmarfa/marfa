import { describe, expect, it } from "vitest";
import {
  holdBlobUploadLocks,
  withBlobUploadLock,
  withBlobUploadLocks,
} from "./blob-upload-lock.js";

const hashes = (count: number, tag: string): string[] =>
  Array.from({ length: count }, (_, i) => `sha256:${tag}-${String(i)}`);

describe("blob upload locks over many hashes", () => {
  it("takes and releases the locks on 5,000 hashes", async () => {
    const many = hashes(5_000, "many");
    const result = await withBlobUploadLocks(many, () =>
      Promise.resolve("held"),
    );
    expect(result).toBe("held");
    // Every lock was let go: another caller takes each at once.
    const release = await holdBlobUploadLocks(many);
    release();
  });

  it("holds every lock until released, and lets each go after", async () => {
    const some = hashes(3, "held");
    const release = await holdBlobUploadLocks(some);
    let entered = false;
    const waiting = withBlobUploadLock(some[1] ?? "", () => {
      entered = true;
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(false);
    release();
    release();
    await waiting;
    expect(entered).toBe(true);
  });

  it("lets every lock go when the locked work throws", async () => {
    const some = hashes(3, "thrown");
    await expect(
      withBlobUploadLocks(some, () => Promise.reject(new Error("refused"))),
    ).rejects.toThrow("refused");
    const release = await holdBlobUploadLocks(some);
    release();
  });
});
