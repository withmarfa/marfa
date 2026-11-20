import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BlobStoreRow } from "../../client/types.js";
import { attentionOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  PUBLIC_ONLY,
  replicateUntilCaughtUp,
  runJob,
} from "../../utils/own-blob-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { waitFor } from "../../utils/wait.js";

/**
 * An object store the server attached while `allow_private_addresses` was on,
 * then refused by the address rules once it is off. The run's object store
 * listens on loopback, reached here by the name `localhost`, which only a
 * lookup can judge; the resolver fault scripts that lookup as public.
 */
const SWITCH = "allow_private_addresses";

/** An address the server judges public, where the resolver fault scripts one. */
const PUBLIC_ADDRESS = "93.184.216.34";

const PUBLIC_AGAIN = `resolve:localhost=${PUBLIC_ADDRESS}>127.0.0.1`;

function socketOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
}

async function setFrom(
  client: MarfaClient,
  changes: Record<string, unknown>,
): Promise<void> {
  const set = await client.patchConfig(changes);
  expect(set.status, JSON.stringify(set.error)).toBe(200);
}

function byName(url: string): string {
  const named = new URL(url);
  named.hostname = "localhost";
  return named.toString();
}

function boot(
  label: string,
  env: Record<string, string> = {},
): Promise<FreshServer> {
  return bootFreshServer(label, {
    ...PUBLIC_ONLY,
    ...env,
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
    MARFA_BLOB_CLEANUP_GRACE_SECONDS: "0",
  });
}

async function backups(
  operator: MarfaClient,
): Promise<Record<string, unknown>> {
  const answer = await operator.rawRequest<{
    backups: Record<string, unknown>;
  }>("/health");
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  return answer.data.backups;
}

async function objectStores(operator: MarfaClient): Promise<BlobStoreRow[]> {
  const listed = await operator.listBlobStores();
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data.filter((store) => store.kind === "s3");
}

async function refusedHealth(
  operator: MarfaClient,
): Promise<Record<string, unknown>> {
  return waitFor("health to say the store cannot be used", async () => {
    const said = await backups(operator);
    return said.reason === "destination_unusable" ? said : undefined;
  });
}

/**
 * Attaches the run's object store by name while the switch is on, copies one
 * file there, and answers the store's id.
 */
async function attachedByName(server: FreshServer): Promise<string> {
  const endpoint = process.env.MARFA_OBJECT_STORE_ENDPOINT;
  const bucket = process.env.MARFA_OBJECT_STORE_BUCKET;
  if (!endpoint || !bucket) {
    throw new Error(
      "MARFA_OBJECT_STORE_BUCKET and MARFA_OBJECT_STORE_ENDPOINT are required: source the env file `pnpm garage:up` writes.",
    );
  }
  const { operator, working } = clientsFor(server);
  await setFrom(socketOf(server), {
    [SWITCH]: true,
    object_store_bucket: bucket,
    object_store_region: process.env.MARFA_OBJECT_STORE_REGION ?? "",
    object_store_access_key_id:
      process.env.MARFA_OBJECT_STORE_ACCESS_KEY_ID ?? "",
    object_store_secret_access_key:
      process.env.MARFA_OBJECT_STORE_SECRET_ACCESS_KEY ?? "",
    object_store_endpoint: byName(endpoint),
    object_store_path_style: true,
    object_store_prefix: `fixture-${randomUUID()}`,
  });
  await waitFor("the object store to be in use", async () => {
    const said = await backups(operator);
    return said.destination === "bucket" &&
      said.reason !== "destination_unusable"
      ? true
      : undefined;
  });
  const upload = await working.uploadBlob(
    bytesOf("copied while the switch is on", 128),
    "text/plain",
  );
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  await named(working, upload.data.hash);
  await replicateUntilCaughtUp(operator, "the file's copy in the store");
  const stores = await objectStores(operator);
  expect(stores).toHaveLength(1);
  return stores[0].id;
}

async function named(working: MarfaClient, hash: string): Promise<void> {
  const note = await working.createItem({
    type: "core.note",
    properties: { body: `![blob](${hash})` },
  });
  expect(note.status, JSON.stringify(note.error)).toBe(201);
}

/** The store `id` is the one object store attached, as it was. */
async function stillAttached(
  operator: MarfaClient,
  id: string,
): Promise<BlobStoreRow> {
  const attached = (await objectStores(operator)).filter(
    (store) => store.detached_at === null,
  );
  expect(attached.map((store) => store.id)).toEqual([id]);
  return attached[0];
}

describe("an object store the address rules refuse", () => {
  it(
    "keeps an object store it attached before attached while the address rules refuse it, says why in health, attention and the store list, purges nothing, and uses the store again once its host is public",
    async () => {
      const server = await boot("store-refused");
      try {
        const { operator, working } = clientsFor(server);
        const id = await attachedByName(server);
        const kept = (await operator.listBlobStores()).data.data.find(
          (store) => store.id === id,
        );
        expect(kept?.error).toBeNull();
        const first = await working.uploadBlob(
          bytesOf("held in the store before the refusal", 128),
          "text/plain",
        );
        expect(first.status, JSON.stringify(first.error)).toBe(201);
        await named(working, first.data.hash);
        await replicateUntilCaughtUp(operator, "the second file's copy");

        await setFrom(socketOf(server), { [SWITCH]: false });
        const refused = await refusedHealth(operator);
        expect(refused.status).toBe("failing");
        expect(String(refused.store_error)).toContain(SWITCH);
        expect(String(refused.store_error)).not.toMatch(/credentials/);
        const store = await stillAttached(operator, id);
        expect(store.error).toBe(refused.store_error);
        // Both concerns show: a refused store does not hide that backups are off.
        const concerns = (await attentionOf(server)).filter(
          (concern) =>
            concern.kind === "backup" &&
            ["store", "turned_off"].includes(concern.reference),
        );
        expect(concerns.map((concern) => concern.title).sort()).toEqual([
          "Scheduled backups are turned off",
          "The backup destination cannot be used",
        ]);

        // Work for the store waits for it; nothing reads its absence as no copy.
        const waiting = await working.uploadBlob(
          bytesOf("uploaded while the store is refused", 128),
          "text/plain",
        );
        expect(waiting.status, JSON.stringify(waiting.error)).toBe(201);
        await named(working, waiting.data.hash);
        const replicated = await runJob<{
          remaining: number;
          refused: Record<string, string>;
        }>(operator, "blob-replicate", "either");
        expect(replicated.outcome).toBe("failed");
        expect(replicated.error).toContain(SWITCH);
        expect(replicated.result.remaining).toBeGreaterThanOrEqual(1);
        expect(replicated.result.refused[id]).toContain(SWITCH);
        const listed = await operator.listHousekeeping();
        expect(listed.status, JSON.stringify(listed.error)).toBe(200);
        await expectMatchesSchema("GET", "/housekeeping", 200, listed.data);
        expect(
          listed.data.data.find((job) => job.name === "blob-replicate")
            ?.last_result,
        ).toEqual(replicated.result);
        const checked = await runJob(operator, "blob-integrity");
        expect(checked.result).toMatchObject({ struck: 0 });
        expect(checked.result.unreachable).toBeGreaterThanOrEqual(1);
        const drop = await operator.deleteBlobCopy(first.data.hash, id);
        expect(drop.status).toBe(503);
        expect(drop.error?.error.code).toBe("blob_store_unavailable");
        expect(
          (await operator.listBlobCopies(first.data.hash)).data.data,
        ).toHaveLength(2);
        const orphan = await working.uploadBlob(
          bytesOf("nothing names these bytes", 128),
          "text/plain",
        );
        expect(orphan.status, JSON.stringify(orphan.error)).toBe(201);
        for (let run = 0; run < 2; run += 1) {
          const held = await runJob(operator, "blob-orphans");
          expect(held.result).toMatchObject({ purged: 0 });
        }
        expect((await operator.downloadBlob(orphan.data.hash)).status).toBe(
          200,
        );
        await stillAttached(operator, id);

        // The witness: once the host is public again, the same store is used and the file goes.
        await server.setFault(PUBLIC_AGAIN);
        // A run that reaches the store ends the refusal, and health stops saying it at once,
        // though the last copy run still holds the refusal's text.
        await runJob(operator, "blob-integrity");
        const cleared = await backups(operator);
        expect(cleared.store_error).toBeNull();
        expect(cleared.reason).toBe("turned_off");
        expect((await stillAttached(operator, id)).error).toBeNull();
        await replicateUntilCaughtUp(operator, "the waiting file's copy");
        expect(
          (await operator.listBlobCopies(waiting.data.hash)).data.data,
        ).toHaveLength(2);
        const used = await backups(operator);
        expect(used.reason).toBe("turned_off");
        expect(used.store_error).toBeNull();
        expect((await stillAttached(operator, id)).error).toBeNull();
        const purged = await runJob(operator, "blob-orphans");
        expect(purged.result).toMatchObject({ purged: 1 });
        expect((await operator.downloadBlob(orphan.data.hash)).status).toBe(
          404,
        );
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "uses an object store the address rules refused again under its own id once a write to /config turns allow_private_addresses on, with no restart",
    async () => {
      const server = await boot("store-refused-switch");
      try {
        const { operator, working } = clientsFor(server);
        const id = await attachedByName(server);
        await setFrom(socketOf(server), { [SWITCH]: false });
        await refusedHealth(operator);

        await setFrom(socketOf(server), { [SWITCH]: true });
        await waitFor("the store to be used again", async () => {
          const said = await backups(operator);
          return said.reason === "turned_off" ? true : undefined;
        });
        expect((await stillAttached(operator, id)).error).toBeNull();
        const upload = await working.uploadBlob(
          bytesOf("copied once the switch is on again", 128),
          "text/plain",
        );
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        await named(working, upload.data.hash);
        await replicateUntilCaughtUp(operator, "the file's copy in the store");
        expect(
          (await operator.listBlobCopies(upload.data.hash)).data.data.map(
            (copy) => copy.store_id,
          ),
        ).toContain(id);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names the credentials fetch, not the store's address, when the address rules refuse it for an object store with no access key, and keeps that store attached",
    async () => {
      // No key the run's environment seeds stands in for the one the test clears.
      const server = await boot("store-refused-credentials", {
        MARFA_OBJECT_STORE_ACCESS_KEY_ID: "",
        MARFA_OBJECT_STORE_SECRET_ACCESS_KEY: "",
      });
      try {
        const { operator } = clientsFor(server);
        const id = await attachedByName(server);
        // The store's own host is judged public, so only the credentials fetch is refused.
        await server.setFault(PUBLIC_AGAIN);
        await setFrom(socketOf(server), {
          [SWITCH]: false,
          object_store_access_key_id: "",
          object_store_secret_access_key: "",
        });
        const refused = await refusedHealth(operator);
        expect(refused.status).toBe("failing");
        const error = String(refused.store_error);
        expect(error).toContain(SWITCH);
        expect(error).toMatch(/credentials/);
        expect(error).not.toMatch(/object store's address/);
        expect((await stillAttached(operator, id)).error).toBe(
          refused.store_error,
        );
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
