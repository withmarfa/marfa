import { controlRequest } from "./control-request.js";

/** What a fixture needs of a server to arm and clear a fault on it. */
export interface FaultTarget {
  setFault(spec: string): Promise<void>;
  clearFault(name?: string): Promise<void>;
}

/** The fault setters of the run's shared server, over its private socket. */
export function faultsOn(socket: string): FaultTarget {
  return {
    async setFault(spec) {
      const at = spec.indexOf("=");
      const answer = await controlRequest(socket, "/_control/test/faults", {
        method: "PUT",
        body: {
          name: at < 0 ? spec : spec.slice(0, at),
          arg: at < 0 ? null : spec.slice(at + 1),
        },
      });
      if (answer.status !== 200) {
        throw new Error(`fault ${spec} refused: ${JSON.stringify(answer)}`);
      }
    },
    async clearFault(name) {
      const query =
        name === undefined ? "" : `?name=${encodeURIComponent(name)}`;
      await controlRequest(socket, `/_control/test/faults${query}`, {
        method: "DELETE",
      });
    },
  };
}

/** Makes the disk store read each blob as absent until it deletes or places it again. */
export function loseBlobs(
  target: FaultTarget,
  hashes: readonly string[],
): Promise<void> {
  return target.setFault(`lose:blob=${hashes.join(",")}`);
}

/** Makes the disk store read each blob with its first byte changed, until it deletes or places it again. */
export function damageBlobs(
  target: FaultTarget,
  hashes: readonly string[],
): Promise<void> {
  return target.setFault(`damage:blob=${hashes.join(",")}`);
}

/** Makes the disk store fail a read of each blob and a question whether it holds it, until it deletes the blob. */
export function unreadBlobs(
  target: FaultTarget,
  hashes: readonly string[],
): Promise<void> {
  return target.setFault(`damage:blob-unreadable=${hashes.join(",")}`);
}

/** One attached store and what it physically holds of a blob. */
export interface StoreHolding {
  id: string;
  kind: "disk" | "s3";
  /** The store has a copy of the bytes under the blob's name. */
  holds: boolean;
  /** The bytes it has hash to the blob's name. */
  intact: boolean;
}

export interface StoreInspection {
  stores: StoreHolding[];
  /** The files the disk store keeps while it receives bytes, with their sizes. */
  spool: { name: string; size: number }[];
}

/**
 * What the instance's stores physically hold of `hash` and what the disk
 * store is receiving now, whatever a `lose:blob` or `damage:blob` fault makes
 * the server read.
 */
export async function inspectStores(
  socket: string,
  hash?: string,
): Promise<StoreInspection> {
  const query = hash === undefined ? "" : `?hash=${encodeURIComponent(hash)}`;
  const answer = await controlRequest(
    socket,
    `/_control/test/blob-stores${query}`,
  );
  if (answer.status !== 200) {
    throw new Error(`blob-stores refused: ${JSON.stringify(answer)}`);
  }
  return answer.body as unknown as StoreInspection;
}

/** Whether the disk store has the bytes of `hash` now. */
export async function diskHolds(
  socket: string,
  hash: string,
): Promise<boolean> {
  const disk = (await inspectStores(socket, hash)).stores.find(
    (store) => store.kind === "disk",
  );
  return disk?.holds === true;
}

/** Whether the disk store has bytes under the name of `hash` that hash to it. */
export async function diskIntact(
  socket: string,
  hash: string,
): Promise<boolean> {
  const disk = (await inspectStores(socket, hash)).stores.find(
    (store) => store.kind === "disk",
  );
  return disk?.holds === true && disk.intact;
}

/** The names of the files in the disk store's receiving folder. */
export async function spooled(socket: string): Promise<string[]> {
  return (await inspectStores(socket)).spool.map((file) => file.name);
}

/** The bytes in the disk store's receiving folder. */
export async function spooledBytes(socket: string): Promise<number> {
  return (await inspectStores(socket)).spool.reduce(
    (total, file) => total + file.size,
    0,
  );
}
