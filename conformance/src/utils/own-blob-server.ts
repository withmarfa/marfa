import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { MarfaClient } from "../client/api.js";
import type { FreshServer } from "./fresh-server.js";
import { waitFor } from "./wait.js";

/**
 * The settings of a server of a fixture's own that keeps bytes on its disk
 * and nowhere else: the run's object store is named by the environment the
 * fixture inherits, and a blank bucket leaves it unattached.
 */
export const DISK_ONLY: Record<string, string> = { S3_BUCKET: "" };

/**
 * The settings of a server of a fixture's own that attaches the run's object
 * store under a prefix no other server uses. A store's id is read from a
 * marker under its prefix, so a server of its own sharing the run's prefix
 * would be the same store as the run's server, and each would count the
 * other's blobs as copies it holds.
 */
export function ownObjectStore(): Record<string, string> {
  for (const name of ["S3_BUCKET", "S3_ENDPOINT"]) {
    if (!process.env[name]) {
      throw new Error(
        `${name} is required for the object-store fixtures: source the env file \`pnpm garage:up\` writes.`,
      );
    }
  }
  return { S3_PREFIX: `fixture-${randomUUID()}` };
}

/** The operator's client and a working key's client on a fresh server, at
 *  the address it has now. */
export function clientsFor(server: FreshServer): {
  operator: MarfaClient;
  working: MarfaClient;
} {
  return {
    operator: new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    }),
    working: new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    }),
  };
}

/** The folder the server keeps its disk store in. */
export function blobFolder(server: FreshServer): string {
  return join(dirname(server.sqlitePath), "blobs");
}

/** Where the server keeps one blob's bytes on its disk. */
export function diskPath(server: FreshServer, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(blobFolder(server), hex.slice(0, 4), hex);
}

/**
 * Runs a housekeeping job through its door and answers the whole run. A run
 * the scheduler holds answers 409 and is asked for again once it has
 * finished.
 */
export async function runJob<T = Record<string, number>>(
  operator: MarfaClient,
  name: string,
): Promise<{ result: T; started_at: string; finished_at: string }> {
  for (let i = 0; i < 50; i++) {
    const res = await operator.runHousekeeping(name);
    if (res.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    expect(res.status, `${name}: ${JSON.stringify(res.error)}`).toBe(200);
    expect(res.data.outcome, res.data.error ?? "").toBe("ok");
    return {
      result: res.data.result as T,
      started_at: res.data.started_at,
      finished_at: res.data.finished_at,
    };
  }
  throw new Error(`${name} was held by a run for five seconds`);
}

/** Bytes of exactly `size`, distinct for every `words`. */
export function bytesOf(words: string, size: number): Uint8Array {
  const text = `${words} ${randomUUID()} `;
  if (text.length > size) {
    throw new Error(`${String(size)} bytes cannot hold "${words}" and a uuid`);
  }
  return new TextEncoder().encode(text.padEnd(size, "."));
}

/** Resolves once the clock has moved past `iso`, so a time taken after it
 *  is strictly later. */
export async function pastInstant(iso: string): Promise<void> {
  while (new Date().toISOString() <= iso) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Resolves once the clock reads a millisecond other than this one's, so two
 *  rows written one after the other carry different creation times. */
export async function nextMillisecond(): Promise<void> {
  const now = Date.now();
  while (Date.now() === now) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Waits until nothing is left for replication on its own clock: no run in
 * progress, and the next one an interval away rather than woken. What a
 * fixture then asks of the job is the first work it does.
 */
export async function replicationIdle(operator: MarfaClient): Promise<void> {
  await waitFor("replication to go idle", async () => {
    const jobs = (await operator.listHousekeeping()).data.data;
    const job = jobs.find((row) => row.name === "blob-replicate");
    return job !== undefined &&
      job.running_since === null &&
      Date.parse(job.next_run_at) > Date.now() + 60_000
      ? true
      : undefined;
  });
}

/**
 * Uploads each of `contents` in order, waits until the server has copied every
 * one to its object store on its own, then drops the object store's copies
 * through the operator door, which wakes nothing. What is left is a backlog
 * of exactly these blobs for the next run of `blob-replicate`.
 */
export async function leaveBacklog(
  operator: MarfaClient,
  working: MarfaClient,
  contents: readonly Uint8Array[],
): Promise<string[]> {
  const stores = (await operator.listBlobStores()).data.data;
  const s3 = stores.find((store) => store.kind === "s3")!;
  const hashes: string[] = [];
  for (const content of contents) {
    await nextMillisecond();
    const upload = await working.uploadBlob(content, "text/plain");
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    hashes.push(upload.data.hash);
  }
  for (const hash of hashes) {
    await waitFor(`the object store's copy of ${hash}`, async () =>
      (await operator.listBlobLocations(hash)).data.data.length === 2
        ? true
        : undefined,
    );
  }
  await replicationIdle(operator);
  for (const hash of hashes) {
    const dropped = await operator.deleteBlobLocation(hash, s3.id);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
  }
  return hashes;
}

/** Waits until every blob has its object store's copy back. */
export async function whenCopied(
  operator: MarfaClient,
  hashes: readonly string[],
): Promise<void> {
  for (const hash of hashes) {
    await waitFor(`the object store's copy of ${hash}`, async () =>
      (await operator.listBlobLocations(hash)).data.data.length === 2
        ? true
        : undefined,
    );
  }
}
