import { Readable } from "node:stream";
import {
  blobLie,
  failAt,
  healBlob,
  holdArmed,
  holdAt,
} from "../control/faults.js";
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

/** `source` with its first byte changed. */
async function* firstByteChanged(source: Readable) {
  let first = true;
  try {
    for await (const chunk of source) {
      if (!first) {
        yield chunk;
        continue;
      }
      first = false;
      const changed = Buffer.from(chunk as Buffer);
      changed[0] = (changed[0] ?? 0) ^ 0xff;
      yield changed;
    }
  } finally {
    source.destroy();
  }
}

/** `read` with the first byte of the blob changed, when it carries that byte. */
function withFirstByteChanged(read: BlobRead): BlobRead {
  if (read.offset !== 0 || read.length === 0) return read;
  return {
    ...read,
    stream: Readable.from(firstByteChanged(read.stream), { objectMode: false }),
  };
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

/** What a store really holds, whatever a `lose:blob` or `damage:blob` fault makes it read. */
const unlied = new WeakMap<BlobStore, Pick<BlobStore, "get" | "has">>();

/** The store's own answers, past every fault. */
export function unfaulted(store: BlobStore): Pick<BlobStore, "get" | "has"> {
  return unlied.get(store) ?? store;
}

/**
 * Makes `store` fail or hang where the `blob-read`, `blob-read-short`,
 * `blob-has`, `blob-write` and `blob-delete` points of `control/faults.ts`
 * say. Applied once to each attached store under `MARFA_TEST_HOOKS` and to
 * no store otherwise, so the disk store and the object store fail the same
 * way. A blob named by `lose:blob` reads as absent, one named by
 * `damage:blob` reads with its first byte changed and one named by
 * `damage:blob-unreadable` fails to read, on the disk store alone. A read
 * fails or is held before it opens the bytes, or ends short after it opens
 * them, a question of presence is held before it is asked, a
 * write fails or is held before it stores any, and a delete before it
 * removes any. A held read or question gives up when its caller's signal
 * aborts, as a store that honors the signal does; a held write or delete
 * takes no signal and goes on once the fault is cleared, as a store's late
 * answer does.
 */
export function withBlobFaults<S extends BlobStore>(store: S): S {
  const get = store.get.bind(store);
  const put = store.put.bind(store);
  const remove = store.delete.bind(store);
  const has = store.has.bind(store);
  const lies = store.kind === "disk";
  unlied.set(store, { get, has });
  store.get = async (hash, range, signal) => {
    if (failAt("blob-read")) throw unreadable("read");
    if (holdArmed("blob-read")) await holdAt("blob-read", undefined, signal);
    const lie = lies ? blobLie(hash) : undefined;
    if (lie === "unreadable") throw unreadable("read");
    if (lie === "lose") return null;
    const opened = await get(hash, range, signal);
    const shown =
      opened && lie === "damage" ? withFirstByteChanged(opened) : opened;
    return shown && failAt("blob-read-short") ? endingShort(shown) : shown;
  };
  store.has = async (hash, signal) => {
    if (holdArmed("blob-has")) await holdAt("blob-has", undefined, signal);
    const lie = lies ? blobLie(hash) : undefined;
    if (lie === "unreadable") throw unreadable("read");
    if (lie === "lose") return null;
    return has(hash, signal);
  };
  store.put = async (hash, source) => {
    if (failAt("blob-write")) throw noRoom();
    if (holdArmed("blob-write")) await holdAt("blob-write");
    await put(hash, source);
    if (lies) healBlob(hash, true);
  };
  store.delete = async (hash) => {
    if (failAt("blob-delete")) throw unreadable("delete");
    if (holdArmed("blob-delete")) await holdAt("blob-delete");
    await remove(hash);
    if (lies) healBlob(hash, false);
  };
  return store;
}
