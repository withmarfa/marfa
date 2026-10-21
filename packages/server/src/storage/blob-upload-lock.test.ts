import { describe, expect, it } from "vitest";
import {
  holdBlobUploadLocks,
  LOCK_HELD,
  outlastBlobUploadLock,
  tryBlobUploadLock,
  withBlobUploadLock,
} from "./blob-upload-lock.js";

const hashes = (count: number, tag: string): string[] =>
  Array.from({ length: count }, (_, i) => `sha256:${tag}-${String(i)}`);

describe("blob upload locks over many hashes", () => {
  it("takes and releases the locks on 5,000 hashes", async () => {
    const many = hashes(5_000, "many");
    const first = await holdBlobUploadLocks(many);
    first();
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
});

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("a hold that outlasts its caller", () => {
  it("keeps the lock until the call it outlasts ends, after its caller returns", async () => {
    const [hash = ""] = hashes(1, "outlast");
    const call = gate();
    await withBlobUploadLock(hash, () => {
      outlastBlobUploadLock(hash, call.promise, () => new Error("unanswered"));
      return Promise.resolve();
    });
    let entered = false;
    const next = withBlobUploadLock(hash, () => {
      entered = true;
      return Promise.resolve();
    });
    await tick();
    expect(entered).toBe(false);
    call.open();
    await next;
    expect(entered).toBe(true);
  });

  it("refuses a caller that asks not to wait on it, at once and while queued", async () => {
    const [hash = ""] = hashes(1, "refuse");
    const call = gate();
    const refusal = new Error("a store did not answer");
    const caller = gate();
    const holding = withBlobUploadLock(hash, async () => {
      await caller.promise;
      outlastBlobUploadLock(hash, call.promise, () => refusal);
    });
    // Queued behind an ordinary hold, which then gives up on its call.
    const queued = withBlobUploadLock(hash, () => Promise.resolve("ran"), {
      refuseUnanswered: true,
    });
    await tick();
    caller.open();
    await holding;
    await expect(queued).rejects.toBe(refusal);
    // Asked while the call is still out.
    await expect(
      withBlobUploadLock(hash, () => Promise.resolve("ran"), {
        refuseUnanswered: true,
      }),
    ).rejects.toBe(refusal);
    // The witness: once the call ends, the same caller runs.
    call.open();
    await tick();
    await expect(
      withBlobUploadLock(hash, () => Promise.resolve("ran"), {
        refuseUnanswered: true,
      }),
    ).resolves.toBe("ran");
  });

  it("waits for an ordinary hold without refusing", async () => {
    const [hash = ""] = hashes(1, "ordinary");
    const caller = gate();
    const holding = withBlobUploadLock(hash, () => caller.promise);
    const queued = withBlobUploadLock(hash, () => Promise.resolve("ran"), {
      refuseUnanswered: true,
    });
    await tick();
    caller.open();
    await holding;
    await expect(queued).resolves.toBe("ran");
  });
});

describe("taking a lock only when it is free", () => {
  it("skips a hash that is held, and runs once it is free", async () => {
    const [hash = ""] = hashes(1, "try");
    const call = gate();
    await withBlobUploadLock(hash, () => {
      outlastBlobUploadLock(hash, call.promise, () => new Error("unanswered"));
      return Promise.resolve();
    });
    let ran = false;
    const skipped = await tryBlobUploadLock(hash, () => {
      ran = true;
      return Promise.resolve("ran");
    });
    expect(skipped).toBe(LOCK_HELD);
    expect(ran).toBe(false);
    call.open();
    await withBlobUploadLock(hash, () => Promise.resolve());
    await expect(
      tryBlobUploadLock(hash, () => Promise.resolve("ran")),
    ).resolves.toBe("ran");
  });
});
