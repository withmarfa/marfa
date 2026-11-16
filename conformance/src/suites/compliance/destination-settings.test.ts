import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attentionOf, instanceIdOf, ownerOf } from "../../utils/backups.js";
import { beatReceiver } from "../../utils/beat-receiver.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  ownObjectStore,
  replicateUntilCaughtUp,
  runJob,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * The backup destination, the object store and the notice addresses are
 * stored settings: a write to `/config` takes effect without a restart, and a
 * destination that cannot be used is reported while the server serves on.
 */
const DISK = {
  MARFA_OBJECT_STORE_BUCKET: "",
  MARFA_BACKUP_INTERVAL_SECONDS: "0",
};

async function backups(server: FreshServer) {
  const answer = await clientsFor(server).operator.rawRequest<{
    backups: Record<string, unknown>;
  }>("/health");
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  return answer.data.backups;
}

function manifests(root: string, instance: string): string[] {
  const dir = join(root, "backups", instance);
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".json"))
    : [];
}

describe("a destination set through /config", () => {
  it(
    "takes a backup folder set through /config without a restart, and finishes a backup that was running in the folder it began in",
    async () => {
      const server = await bootFreshServer("destination-swap", DISK);
      const first = mkdtempSync(join(tmpdir(), "marfa-destination-first-"));
      const second = mkdtempSync(join(tmpdir(), "marfa-destination-second-"));
      try {
        const { operator } = clientsFor(server);
        const owner = ownerOf(server);
        const id = await instanceIdOf(server);
        const set = await operator.patchConfig({ backup_path: first });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        await waitFor("the first folder to be in use", async () =>
          (await backups(server)).destination === "folder" ? true : undefined,
        );

        await server.setFault("hold:backup:put");
        const running = owner.runBackup();
        await server.waitForHold("hold:backup:put");
        const moved = await operator.patchConfig({ backup_path: second });
        expect(moved.status, JSON.stringify(moved.error)).toBe(200);
        await waitFor("the second folder to be in use", async () => {
          const stores = (await operator.listBlobStores()).data.data;
          return stores.some(
            (store) => store.locator === join(second, "files", id),
          )
            ? true
            : undefined;
        });
        await server.clearFault();
        const held = await running;
        expect(held.status, JSON.stringify(held.error)).toBe(200);
        expect(manifests(first, id)).toEqual([`${held.data.backup.name}`]);
        expect(manifests(second, id)).toEqual([]);

        const next = await owner.runBackup();
        expect(next.status, JSON.stringify(next.error)).toBe(200);
        expect(manifests(second, id)).toEqual([`${next.data.backup.name}`]);
        expect(manifests(first, id)).toEqual([`${held.data.backup.name}`]);
      } finally {
        await server.stop();
        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "reports an object store that refuses its secret as unusable, keeps serving files from the disk, and takes the store once the secret is right",
    async () => {
      const server = await bootFreshServer(
        "destination-wrong-secret",
        ownObjectStore(),
      );
      try {
        const { operator, working } = clientsFor(server);
        await waitFor("the object store to be in use", async () =>
          (await backups(server)).destination === "bucket" ? true : undefined,
        );

        const wrong = await operator.patchConfig({
          object_store_secret_access_key: `wrong-${randomUUID()}`,
        });
        expect(wrong.status, JSON.stringify(wrong.error)).toBe(200);
        const unusable = await waitFor("the store to be unusable", async () => {
          const said = await backups(server);
          return said.reason === "destination_unusable" ? said : undefined;
        });
        expect(unusable.status).toBe("failing");
        expect(String(unusable.store_error)).toContain("The object store");
        const concerns = (await attentionOf(server)).filter(
          (concern) =>
            concern.kind === "backup" && concern.reference === "store",
        );
        expect(concerns.map((concern) => concern.title)).toEqual([
          "The backup destination cannot be used",
        ]);

        const bytes = bytesOf("served from the disk", 64);
        const upload = await working.uploadBlob(bytes, "text/plain");
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        const read = await operator.downloadBlob(upload.data.hash);
        expect(new Uint8Array(read.data)).toEqual(bytes);
        const stores = (await operator.listBlobStores()).data.data;
        expect(
          stores.filter(
            (store) => store.kind === "s3" && store.detached_at === null,
          ),
        ).toEqual([]);

        const mended = await operator.patchConfig({
          object_store_secret_access_key: null,
        });
        expect(mended.status, JSON.stringify(mended.error)).toBe(200);
        await waitFor("the store to be in use again", async () =>
          (await backups(server)).destination === "bucket" ? true : undefined,
        );
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
    "takes an untidy object store setting in its plain spelling, and refuses an endpoint that carries a credential without repeating it",
    async () => {
      const server = await bootFreshServer("destination-untidy", DISK);
      try {
        const { operator } = clientsFor(server);
        const set = await operator.patchConfig({
          object_store_endpoint: "http://127.0.0.1:9/",
          object_store_prefix: "/fixtures/untidy/",
          object_store_region: "  eu-west-1 ",
        });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        expect(set.data).toMatchObject({
          object_store_endpoint: "http://127.0.0.1:9",
          object_store_prefix: "fixtures/untidy",
          object_store_region: "eu-west-1",
        });

        const carried = "http://keyid:hush-hush@127.0.0.1:9";
        const refused = await operator.patchConfig({
          object_store_endpoint: carried,
        });
        expect(refused.status).toBe(400);
        const said = JSON.stringify(refused.error);
        expect(said).toContain("object_store_endpoint");
        expect(said).not.toContain("hush-hush");
        expect(said).not.toContain("keyid");
        expect((await operator.getConfig()).data).toMatchObject({
          object_store_endpoint: "http://127.0.0.1:9",
        });
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("the notice addresses set through /config", () => {
  it(
    "lists and sends the heartbeat to a heartbeat_url set through /config, without a restart",
    async () => {
      const beats = await beatReceiver();
      const server = await bootFreshServer("notice-heartbeat", DISK);
      try {
        const { operator } = clientsFor(server);
        const listed = async () =>
          (await operator.listHousekeeping()).data.data.map((job) => job.name);
        expect(await listed()).not.toContain("heartbeat");

        const set = await operator.patchConfig({ heartbeat_url: beats.url });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        await waitFor("the heartbeat to be listed", async () =>
          (await listed()).includes("heartbeat") ? true : undefined,
        );
        const before = beats.count();
        const run = await runJob<{ ok: boolean }>(operator, "heartbeat");
        expect(run.result.ok).toBe(true);
        expect(beats.count()).toBeGreaterThan(before);
      } finally {
        await server.stop();
        await beats.close();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "posts a notice of a 500 to an error_webhook_url set through /config, without a restart",
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
      const server = await bootFreshServer("notice-error-webhook", DISK);
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

        // The witness: with no address set, a 500 sends nothing.
        await fail();
        const set = await operator.patchConfig({
          error_webhook_url: `http://127.0.0.1:${String(address.port)}/errors`,
        });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        const requestId = await fail();
        await waitFor("the notice of the 500", async () =>
          notices.find((notice) => notice.request_id === requestId),
        );
        expect(notices).toHaveLength(1);
      } finally {
        await server.stop();
        receiver.closeAllConnections();
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
