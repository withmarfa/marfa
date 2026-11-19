import { randomUUID } from "node:crypto";
import { createServer, get, type RequestOptions } from "node:http";
import { describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BlobStoreRow } from "../../client/types.js";
import { beatReceiver } from "../../utils/beat-receiver.js";
import {
  approvedAppToken,
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
  storeByName,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * While `allow_private_addresses` is off, the heartbeat, the error webhook
 * and the object store reach only public addresses, as webhooks do, and only
 * the private local process turns it on. Every receiver here, and the run's
 * object store, listens on loopback; a receiver named `localhost` is a name
 * that leads there, which only a lookup can judge.
 */
const SWITCH = "allow_private_addresses";

function socketOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
}

async function setFrom(
  client: MarfaClient,
  changes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const set = await client.patchConfig(changes);
  expect(set.status, JSON.stringify(set.error)).toBe(200);
  return set.data as Record<string, unknown>;
}

function byName(url: string): string {
  const named = new URL(url);
  named.hostname = "localhost";
  return named.toString();
}

/** An address the server judges public, where the resolver fault scripts one. */
const PUBLIC_ADDRESS = "93.184.216.34";

/** `url` asked of loopback under its own host, which no lookup then needs to find. */
function getAtLoopback(url: URL): Promise<{ status: number; body: Buffer }> {
  const lookup: RequestOptions["lookup"] = (_host, options, done) => {
    if (options.all) {
      done(null, [{ address: "127.0.0.1", family: 4 }]);
    } else {
      done(null, "127.0.0.1", 4);
    }
  };
  return new Promise((resolve, reject) => {
    get(url, { lookup }, (answer) => {
      const parts: Buffer[] = [];
      answer.on("data", (part: Buffer) => parts.push(part));
      answer.on("end", () =>
        resolve({ status: answer.statusCode ?? 0, body: Buffer.concat(parts) }),
      );
      answer.on("error", reject);
    }).on("error", reject);
  });
}

/** The run's object store, which `pnpm garage:up` names in the environment. */
function runStore(): { endpoint: string; bucket: string } {
  const endpoint = process.env.MARFA_OBJECT_STORE_ENDPOINT;
  const bucket = process.env.MARFA_OBJECT_STORE_BUCKET;
  if (!endpoint || !bucket) {
    throw new Error(
      "MARFA_OBJECT_STORE_BUCKET and MARFA_OBJECT_STORE_ENDPOINT are required: source the env file `pnpm garage:up` writes.",
    );
  }
  return { endpoint, bucket };
}

/** The run's object store's settings but its endpoint and path style, under a prefix of its own. */
function storeSettings(bucket: string): Record<string, unknown> {
  return {
    object_store_bucket: bucket,
    object_store_region: process.env.MARFA_OBJECT_STORE_REGION ?? "",
    object_store_access_key_id:
      process.env.MARFA_OBJECT_STORE_ACCESS_KEY_ID ?? "",
    object_store_secret_access_key:
      process.env.MARFA_OBJECT_STORE_SECRET_ACCESS_KEY ?? "",
    object_store_prefix: `fixture-${randomUUID()}`,
  };
}

async function backupsOf(
  server: FreshServer,
): Promise<{ status: number; backups: Record<string, unknown> }> {
  const answer = await clientsFor(server).operator.rawRequest<{
    backups: Record<string, unknown>;
  }>("/health");
  return { status: answer.status, backups: answer.data.backups };
}

async function storeInUse(server: FreshServer): Promise<void> {
  await waitFor("the object store to be in use", async () => {
    const { backups } = await backupsOf(server);
    return backups.destination === "bucket" &&
      backups.reason !== "destination_unusable"
      ? true
      : undefined;
  });
}

/** The one object store `GET /blobs/stores` lists as attached. */
async function attachedStore(server: FreshServer): Promise<BlobStoreRow> {
  const stores = (await clientsFor(server).operator.listBlobStores()).data.data;
  const attached = stores.filter(
    (store) => store.kind === "s3" && store.detached_at === null,
  );
  expect(attached, JSON.stringify(stores)).toHaveLength(1);
  return attached[0];
}

/** Files kept in the store in use: `held` also on the disk, `storeOnly` in the store alone. */
interface Kept {
  held: string;
  storeOnly: string;
}

/** Checks that the store `id` stays attached and that nothing uses it. */
async function expectStoreUnusable(
  server: FreshServer,
  storeHost: string,
  id: string,
  kept: Kept,
): Promise<void> {
  const { operator, working } = clientsFor(server);
  const replicated = await runJob(operator, "blob-replicate");
  expect(replicated.outcome).toBe("succeeded");
  const { status, backups } = await backupsOf(server);
  expect(status, JSON.stringify(backups)).toBe(200);
  expect(backups).toMatchObject({
    status: "failing",
    destination: "bucket",
    reason: "destination_unusable",
  });
  const store = await attachedStore(server);
  expect(store.id).toBe(id);
  expect(store.unusable_reason).toContain(SWITCH);
  const owner = socketOf(server);
  for (const answer of [await owner.listBackups(), await owner.runBackup()]) {
    expect(answer.status, JSON.stringify(answer.error)).toBe(503);
    expect(answer.error?.error.code).toBe("blob_store_unavailable");
  }
  const link = await working.getBlobUrl(kept.held);
  expect(link.status, JSON.stringify(link.error)).toBe(200);
  expect(new URL(link.data.url).host).not.toBe(storeHost);
  expect((await operator.downloadBlob(kept.held)).status).toBe(200);
  const unlinked = await working.getBlobUrl(kept.storeOnly);
  expect(unlinked.status, JSON.stringify(unlinked.error)).toBe(503);
  expect(unlinked.error?.error.code).toBe("blob_store_unavailable");
  expect((await operator.downloadBlob(kept.storeOnly)).status).toBe(503);
  const later = await working.uploadBlob(
    bytesOf("kept on the disk alone", 64),
    "text/plain",
  );
  expect(later.status, JSON.stringify(later.error)).toBe(201);
  await runJob(operator, "blob-replicate");
  expect(
    (await operator.listBlobCopies(later.data.hash)).data.data,
  ).toHaveLength(1);
}

/** A file kept in the store in use, whose link the store signs at `storeHost`. */
async function heldInStore(
  server: FreshServer,
  storeHost: string,
  label = "kept in the store while it is in use",
): Promise<string> {
  const { operator, working } = clientsFor(server);
  const upload = await working.uploadBlob(bytesOf(label, 100), "text/plain");
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  const note = await working.createItem({
    type: "core.note",
    properties: { body: `![blob](${upload.data.hash})` },
  });
  expect(note.status, JSON.stringify(note.error)).toBe(201);
  await replicateUntilCaughtUp(operator, "the file's copy in the store");
  expect(
    (await operator.listBlobCopies(upload.data.hash)).data.data,
  ).toHaveLength(2);
  const link = await working.getBlobUrl(upload.data.hash);
  expect(link.status, JSON.stringify(link.error)).toBe(200);
  expect(new URL(link.data.url).host).toBe(storeHost);
  const listed = await socketOf(server).listBackups();
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return upload.data.hash;
}

/** A file in the store in use and on the disk, and one whose disk copy is dropped. */
async function keptInStore(
  server: FreshServer,
  storeHost: string,
): Promise<Kept> {
  const { operator } = clientsFor(server);
  const held = await heldInStore(server, storeHost);
  const storeOnly = await heldInStore(
    server,
    storeHost,
    "kept in the store alone",
  );
  const disk = (await operator.listBlobStores()).data.data.find(
    (store) => store.kind === "disk",
  );
  const dropped = await operator.deleteBlobCopy(storeOnly, disk?.id ?? "");
  expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
  expect((await operator.downloadBlob(storeOnly)).status).toBe(200);
  return { held, storeOnly };
}

describe("where the server may send", () => {
  it(
    "refuses a key holding config.manage the switch, which an app whose owner signed in just now changes",
    async () => {
      const server = await bootFreshServer("switch-authority", PUBLIC_ONLY);
      try {
        const { operator } = clientsFor(server);
        const refused = await operator.patchConfig({ [SWITCH]: true });
        expect(refused.status).toBe(403);
        expect(refused.error?.error.code).toBe("app_sign_in_required");
        const put = await operator.updateConfig({ [SWITCH]: true });
        expect(put.status).toBe(403);
        expect((await operator.getConfig()).data).not.toHaveProperty(SWITCH);

        // The witness: an app whose owner signed in just now changes the same
        // setting, and so does the private local process.
        const app = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: await approvedAppToken(server, ["config.manage"]),
        });
        expect((await setFrom(app, { [SWITCH]: true }))[SWITCH]).toBe(true);
        expect((await setFrom(app, { [SWITCH]: false }))[SWITCH]).toBe(false);
        const turned = await setFrom(socketOf(server), { [SWITCH]: true });
        expect(turned[SWITCH]).toBe(true);
        const same = await operator.patchConfig({ [SWITCH]: true });
        expect(same.status, JSON.stringify(same.error)).toBe(200);
        // A private destination stored while the switch is on does not turn
        // the key's refusal into a judgment of the settings.
        await setFrom(socketOf(server), {
          object_store_endpoint: "http://127.0.0.1:9",
        });
        const off = await operator.patchConfig({ [SWITCH]: false });
        expect(off.status).toBe(403);
        expect(off.error?.error.code).toBe("app_sign_in_required");
        expect(
          ((await operator.getConfig()).data as Record<string, unknown>)[
            SWITCH
          ],
        ).toBe(true);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a heartbeat_url, error_webhook_url or object_store_endpoint written as a private address while the switch is off",
    async () => {
      const server = await bootFreshServer("switch-literals", PUBLIC_ONLY);
      try {
        const socket = socketOf(server);
        const keys = [
          "heartbeat_url",
          "error_webhook_url",
          "object_store_endpoint",
        ];
        const hosts = [
          "127.0.0.1:9",
          "[::1]:9",
          "10.1.2.3",
          "169.254.169.254",
          "[::ffff:192.168.0.1]",
        ];
        for (const key of keys) {
          for (const host of hosts) {
            const refused = await socket.patchConfig({
              [key]: `http://${host}/hush-${key}`,
            });
            expect(refused.status, `${key} ${host}`).toBe(400);
            const said = JSON.stringify(refused.error);
            expect(said).toContain(key);
            expect(said).toContain(SWITCH);
            expect(said).not.toContain(`hush-${key}`);
          }
          // The witness: the same setting takes a name, which a lookup judges.
          await setFrom(socket, { [key]: "http://receiver.example.test/" });
          await setFrom(socket, { [key]: null });
        }

        await setFrom(socket, {
          [SWITCH]: true,
          object_store_endpoint: "http://127.0.0.1:9",
        });
        const off = await socket.patchConfig({ [SWITCH]: false });
        expect(off.status).toBe(400);
        expect(JSON.stringify(off.error)).toContain("object_store_endpoint");
        const cleared = await setFrom(socket, {
          [SWITCH]: false,
          object_store_endpoint: null,
        });
        expect(cleared[SWITCH]).toBe(false);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "sends no heartbeat to a name that leads to a private address until the switch is on",
    async () => {
      const beats = await beatReceiver();
      const server = await bootFreshServer("switch-heartbeat", PUBLIC_ONLY);
      try {
        const { operator } = clientsFor(server);
        await setFrom(operator, { heartbeat_url: byName(beats.url) });
        const before = beats.count();
        const refused = await runJob<{ ok: boolean }>(operator, "heartbeat");
        expect(refused.result.ok).toBe(false);
        expect(beats.count()).toBe(before);

        // The witness: with the switch on, the same address hears the beat.
        await setFrom(socketOf(server), { [SWITCH]: true });
        const sent = await runJob<{ ok: boolean }>(operator, "heartbeat");
        expect(sent.result.ok).toBe(true);
        expect(beats.count()).toBeGreaterThan(before);
      } finally {
        await server.stop();
        await beats.close();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "sends no error notice to a name that leads to a private address until the switch is on",
    async () => {
      const notices: Record<string, unknown>[] = [];
      const receiver = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          notices.push(JSON.parse(body) as Record<string, unknown>);
          response.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) =>
        receiver.listen(0, "127.0.0.1", resolve),
      );
      const address = receiver.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("the receiver did not bind to a port");
      }
      const server = await bootFreshServer("switch-error-webhook", PUBLIC_ONLY);
      try {
        const { operator, working } = clientsFor(server);
        const fail = async () => {
          await server.setFault("fail:audit=item.create");
          const failed = await working.createItem({
            type: "core.note",
            properties: { body: `fails ${randomUUID()}` },
          });
          await server.clearFault();
          expect(failed.status).toBe(500);
          return failed.headers.get("x-request-id");
        };
        await setFrom(operator, {
          error_webhook_url: `http://localhost:${String(address.port)}/errors`,
        });
        const unsent = await fail();

        // The witness: the notices go out in order, so the one sent once the
        // switch is on arrives after the first would have.
        await setFrom(socketOf(server), { [SWITCH]: true });
        const sent = await fail();
        await waitFor("the notice sent once the switch is on", async () =>
          notices.find((notice) => notice.request_id === sent),
        );
        expect(notices.map((notice) => notice.request_id)).toEqual([sent]);
        expect(unsent).not.toBe(sent);
      } finally {
        await server.stop();
        receiver.closeAllConnections();
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "takes an object store on a private address once the private local process turns the switch on, and not before",
    async () => {
      const endpoint = process.env.MARFA_OBJECT_STORE_ENDPOINT;
      const bucket = process.env.MARFA_OBJECT_STORE_BUCKET;
      if (!endpoint || !bucket) {
        throw new Error(
          "MARFA_OBJECT_STORE_BUCKET and MARFA_OBJECT_STORE_ENDPOINT are required: source the env file `pnpm garage:up` writes.",
        );
      }
      const server = await bootFreshServer("switch-object-store", {
        ...PUBLIC_ONLY,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      try {
        const { operator, working } = clientsFor(server);
        const backups = async () => {
          const answer = await operator.rawRequest<{
            backups: Record<string, unknown>;
          }>("/health");
          expect(answer.status, JSON.stringify(answer.data)).toBe(200);
          return answer.data.backups;
        };
        const store = {
          object_store_bucket: bucket,
          object_store_region: process.env.MARFA_OBJECT_STORE_REGION ?? "",
          object_store_access_key_id:
            process.env.MARFA_OBJECT_STORE_ACCESS_KEY_ID ?? "",
          object_store_secret_access_key:
            process.env.MARFA_OBJECT_STORE_SECRET_ACCESS_KEY ?? "",
          object_store_path_style: true,
          object_store_prefix: `fixture-${randomUUID()}`,
        };
        const socket = socketOf(server);
        const literal = await socket.patchConfig({
          ...store,
          object_store_endpoint: endpoint,
        });
        expect(literal.status).toBe(400);
        await setFrom(socket, {
          ...store,
          object_store_endpoint: byName(endpoint),
        });
        const unusable = await waitFor("the store to be unusable", async () => {
          const said = await backups();
          return said.reason === "destination_unusable" ? said : undefined;
        });
        expect(unusable.status).toBe("failing");

        await setFrom(socket, { [SWITCH]: true });
        await waitFor("the object store to be in use", async () => {
          const said = await backups();
          return said.destination === "bucket" &&
            said.reason !== "destination_unusable"
            ? true
            : undefined;
        });
        const upload = await working.uploadBlob(
          bytesOf("kept in a private store", 64),
          "text/plain",
        );
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        await replicateUntilCaughtUp(operator, "the file's copy in the store");
        expect(
          (await operator.listBlobCopies(upload.data.hash)).data.data,
        ).toHaveLength(2);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "reaches an object store by virtual host at the bucket before the endpoint's host, and not while that host leads to a private address",
    async () => {
      const endpoint = process.env.MARFA_OBJECT_STORE_ENDPOINT;
      const bucket = process.env.MARFA_OBJECT_STORE_BUCKET;
      if (!endpoint || !bucket) {
        throw new Error(
          "MARFA_OBJECT_STORE_BUCKET and MARFA_OBJECT_STORE_ENDPOINT are required: source the env file `pnpm garage:up` writes.",
        );
      }
      const server = await bootFreshServer("switch-virtual-host", {
        ...PUBLIC_ONLY,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      try {
        const { operator, working } = clientsFor(server);
        const socket = socketOf(server);
        const backups = async () => {
          const answer = await operator.rawRequest<{
            backups: Record<string, unknown>;
          }>("/health");
          expect(answer.status, JSON.stringify(answer.data)).toBe(200);
          return answer.data.backups;
        };
        const named = storeByName(endpoint);
        // The bucket's host is scripted, so the test needs no resolver of its own.
        const host = `resolve:${bucket}.${new URL(named).hostname}`;
        await server.setFault(`${host}=127.0.0.1`);
        const settings = {
          object_store_bucket: bucket,
          object_store_region: process.env.MARFA_OBJECT_STORE_REGION ?? "",
          object_store_access_key_id:
            process.env.MARFA_OBJECT_STORE_ACCESS_KEY_ID ?? "",
          object_store_secret_access_key:
            process.env.MARFA_OBJECT_STORE_SECRET_ACCESS_KEY ?? "",
          object_store_endpoint: named,
          object_store_path_style: false,
        };
        await setFrom(socket, {
          ...settings,
          object_store_prefix: `fixture-${randomUUID()}`,
        });
        const unusable = await waitFor("the store to be unusable", async () => {
          const said = await backups();
          return said.reason === "destination_unusable" ? said : undefined;
        });
        expect(unusable.status).toBe("failing");

        // The witness: the same store, its host judged public, is taken.
        await server.setFault(`${host}=${PUBLIC_ADDRESS}>127.0.0.1`);
        const prefix = `fixture-${randomUUID()}`;
        await setFrom(socket, { ...settings, object_store_prefix: prefix });
        await waitFor("the object store to be in use", async () => {
          const said = await backups();
          return said.destination === "bucket" &&
            said.reason !== "destination_unusable"
            ? true
            : undefined;
        });
        const bytes = bytesOf("kept in a store reached by its host", 128);
        const upload = await working.uploadBlob(bytes, "text/plain");
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        const note = await working.createItem({
          type: "core.note",
          properties: { body: `![blob](${upload.data.hash})` },
        });
        expect(note.status, JSON.stringify(note.error)).toBe(201);
        await replicateUntilCaughtUp(operator, "the file's copy in the store");
        expect(
          (await operator.listBlobCopies(upload.data.hash)).data.data,
        ).toHaveLength(2);

        const link = await working.getBlobUrl(upload.data.hash);
        expect(link.status, JSON.stringify(link.error)).toBe(200);
        const url = new URL(link.data.url);
        expect(url.host).toBe(`${bucket}.${new URL(named).host}`);
        expect(url.pathname.startsWith(`/${prefix}/`), url.pathname).toBe(true);
        const fetched = await getAtLoopback(url);
        expect(fetched.status).toBe(200);
        expect(new Uint8Array(fetched.body)).toEqual(bytes);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
  it(
    "keeps an object store it used attached under its id while the switch is off and the store's name leads to a private address, uses it for nothing, and uses it again once the switch is on",
    async () => {
      const { endpoint, bucket } = runStore();
      const server = await bootFreshServer("switch-off-object-store", {
        ...PUBLIC_ONLY,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      try {
        const { operator } = clientsFor(server);
        const socket = socketOf(server);
        const named = byName(endpoint);
        const storeHost = new URL(named).host;
        await setFrom(socket, { [SWITCH]: true });
        await setFrom(operator, {
          ...storeSettings(bucket),
          object_store_endpoint: named,
          object_store_path_style: true,
        });
        await storeInUse(server);
        const kept = await keptInStore(server, storeHost);
        const { id } = await attachedStore(server);

        await setFrom(socket, { [SWITCH]: false });
        await expectStoreUnusable(server, storeHost, id, kept);

        // The witness: with the switch on again, the same store is in use.
        await setFrom(socket, { [SWITCH]: true });
        await storeInUse(server);
        const store = await attachedStore(server);
        expect(store).toMatchObject({ id, unusable_reason: null });
        expect((await operator.downloadBlob(kept.storeOnly)).status).toBe(200);
        await heldInStore(server, storeHost, "kept once the switch is on");
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps an object store reached by virtual host attached under its id once the bucket's host leads to a private address with the settings unchanged, and uses it again once a request to it is allowed",
    async () => {
      const { endpoint, bucket } = runStore();
      const server = await bootFreshServer("lookup-private-virtual-host", {
        ...PUBLIC_ONLY,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      try {
        const { operator, working } = clientsFor(server);
        const named = storeByName(endpoint);
        const storeHost = `${bucket}.${new URL(named).host}`;
        const host = `resolve:${bucket}.${new URL(named).hostname}`;
        await server.setFault(`${host}=${PUBLIC_ADDRESS}>127.0.0.1`);
        await setFrom(operator, {
          ...storeSettings(bucket),
          object_store_endpoint: named,
          object_store_path_style: false,
        });
        await storeInUse(server);
        const kept = await keptInStore(server, storeHost);
        const { id } = await attachedStore(server);

        // The next request to the store, a copy of a new file, meets the private address.
        await server.setFault(`${host}=127.0.0.1`);
        const met = await working.uploadBlob(
          bytesOf("met by the private address", 64),
          "text/plain",
        );
        expect(met.status, JSON.stringify(met.error)).toBe(201);
        await runJob(operator, "blob-replicate", "either");
        await expectStoreUnusable(server, storeHost, id, kept);

        // The witness: once the host is public again, the next run's request is allowed.
        await server.setFault(`${host}=${PUBLIC_ADDRESS}>127.0.0.1`);
        await replicateUntilCaughtUp(
          operator,
          "the copies the refusal held back",
        );
        await storeInUse(server);
        expect(await attachedStore(server)).toMatchObject({
          id,
          unusable_reason: null,
        });
        expect(
          (await operator.listBlobCopies(met.data.hash)).data.data,
        ).toHaveLength(2);
        const link = await working.getBlobUrl(kept.storeOnly);
        expect(link.status, JSON.stringify(link.error)).toBe(200);
        expect(new URL(link.data.url).host).toBe(storeHost);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
