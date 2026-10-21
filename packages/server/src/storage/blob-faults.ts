import { Readable } from "node:stream";
import { failAt, holdArmed, holdAt } from "../control/faults.js";
import type { BlobRead, BlobStore } from "./blob-store.js";

/** The error the operating system raises for a write to a volume with no room. */
function noRoom(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOSPC: no space left on device, write"), {
    code: "ENOSPC",
  });
}

function unreadable(verb: "read" | "delete"): NodeJS.ErrnoException {
  return Object.assign(new Error(`EIO: i/o error, ${verb}`), { code: "EIO" });
}

/** The first `bytes` of `source`, and then a clean end. */
async function* firstOf(source: Readable, bytes: number) {
  let left = bytes;
  try {
    for await (const chunk of source) {
      if (left === 0) return;
      const part = (chunk as Buffer).subarray(0, left);
      left -= part.length;
      yield part;
    }
  } finally {
    source.destroy();
  }
}

/** `read` with its stream ending cleanly after half the bytes it carries. */
function endingShort(read: BlobRead): BlobRead {
  return {
    ...read,
    stream: Readable.from(firstOf(read.stream, Math.floor(read.length / 2)), {
      objectMode: false,
    }),
  };
}

/**
 * Makes `store` fail or hang where the `blob-read`, `blob-read-short`,
 * `blob-has`, `blob-write` and `blob-delete` points of `control/faults.ts`
 * say. Applied once to each attached store under `MARFA_TEST_HOOKS` and to
 * no store otherwise, so the disk store and the object store fail the same
 * way. A read fails or is held before it opens the bytes, or ends short
 * after it opens them, a question of presence is held before it is asked, a
 * write fails before it stores any, and a delete before it removes any. A
 * held read or question gives up when its caller's signal aborts, as a store
 * that honors the signal does.
 */
export function withBlobFaults<S extends BlobStore>(store: S): S {
  const get = store.get.bind(store);
  const put = store.put.bind(store);
  const remove = store.delete.bind(store);
  const has = store.has.bind(store);
  store.get = async (hash, range, signal) => {
    if (failAt("blob-read")) throw unreadable("read");
    if (holdArmed("blob-read")) await holdAt("blob-read", undefined, signal);
    const read = await get(hash, range, signal);
    return read && failAt("blob-read-short") ? endingShort(read) : read;
  };
  store.has = async (hash, signal) => {
    if (holdArmed("blob-has")) await holdAt("blob-has", undefined, signal);
    return has(hash, signal);
  };
  store.put = (hash, source) =>
    failAt("blob-write") ? Promise.reject(noRoom()) : put(hash, source);
  store.delete = (hash) =>
    failAt("blob-delete") ? Promise.reject(unreadable("delete")) : remove(hash);
  return store;
}
