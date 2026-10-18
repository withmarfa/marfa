import { failAt } from "../control/faults.js";
import type { BlobStore } from "./blob-store.js";

/** The error the operating system raises for a write to a volume with no room. */
function noRoom(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOSPC: no space left on device, write"), {
    code: "ENOSPC",
  });
}

function unreadable(verb: "read" | "delete"): NodeJS.ErrnoException {
  return Object.assign(new Error(`EIO: i/o error, ${verb}`), { code: "EIO" });
}

/**
 * Makes `store` fail where the `blob-read`, `blob-write` and `blob-delete`
 * points of `control/faults.ts` say. Applied once to each attached store
 * under `MARFA_TEST_HOOKS` and to no store otherwise, so the disk store and
 * the object store fail the same way. A read fails before it opens the
 * bytes, a write before it stores any, and a delete before it removes any.
 */
export function withBlobFaults<S extends BlobStore>(store: S): S {
  const get = store.get.bind(store);
  const put = store.put.bind(store);
  const remove = store.delete.bind(store);
  store.get = (hash, range) =>
    failAt("blob-read") ? Promise.reject(unreadable("read")) : get(hash, range);
  store.put = (hash, source) =>
    failAt("blob-write") ? Promise.reject(noRoom()) : put(hash, source);
  store.delete = (hash) =>
    failAt("blob-delete") ? Promise.reject(unreadable("delete")) : remove(hash);
  return store;
}
