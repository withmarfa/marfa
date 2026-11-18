import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  type AddressInfo,
  connect,
  createServer as createListener,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attentionOf, instanceIdOf, ownerOf } from "../../utils/backups.js";
import { beatReceiver } from "../../utils/beat-receiver.js";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  type RefusedBoot,
} from "../../utils/fresh-server.js";
import { storeSettingRow } from "../../utils/instance-database.js";
import {
  blobFolder,
  bytesOf,
  clientsFor,
  diskPath,
  DISK_ONLY,
  ownObjectStore,
  replicateUntilCaughtUp,
  runJob,
  whenCopied,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";
import { tempFolder } from "../../utils/temp-folder.js";

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

/** `a<c>b` for each printable ASCII character `allowed` does not hold. */
function withEachOtherCharacter(allowed: RegExp): string[] {
  const names: string[] = [];
  for (let code = 0x20; code <= 0x7e; code += 1) {
    const character = String.fromCharCode(code);
    if (!allowed.test(character)) names.push(`a${character}b`);
  }
  return names;
}

function hyphenatedNames(): string[] {
  const letters = [..."aenstx"];
  return letters.flatMap((first) =>
    letters.flatMap((second) =>
      ["a", "0", "-"].map((last) => `${first}${second}--${last}`),
    ),
  );
}

/** A port in front of the run's object store that can refuse every request. */
async function storeDoor() {
  const store = new URL(process.env.MARFA_OBJECT_STORE_ENDPOINT!);
  const sockets = new Set<Socket>();
  let refusing = false;
  const track = (socket: Socket, onError: () => void) => {
    sockets.add(socket);
    socket.on("error", onError);
    socket.on("close", () => sockets.delete(socket));
  };
  const door = createListener((inbound) => {
    if (refusing) {
      track(inbound, () => inbound.destroy());
      inbound.once("data", () =>
        inbound.end(
          "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ),
      );
      return;
    }
    const outbound = connect(Number(store.port), store.hostname);
    const end = () => {
      inbound.destroy();
      outbound.destroy();
    };
    track(inbound, end);
    track(outbound, end);
    inbound.pipe(outbound).pipe(inbound);
  });
  await new Promise<void>((resolve) =>
    door.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = door.address() as AddressInfo;
  const dropConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    refuse: (refuse: boolean) => {
      refusing = refuse;
      dropConnections();
    },
    close: () =>
      new Promise<void>((resolve) => {
        door.close(() => resolve());
        dropConnections();
      }),
  };
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
      const first = tempFolder("marfa-destination-first-");
      const second = tempFolder("marfa-destination-second-");
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

        const blank = await operator.patchConfig({
          object_store_endpoint: "   ",
          object_store_region: "",
        });
        expect(blank.status, JSON.stringify(blank.error)).toBe(200);
        expect(blank.data).not.toHaveProperty("object_store_endpoint");
        expect(blank.data).not.toHaveProperty("object_store_region");
        expect(blank.data).toMatchObject({
          object_store_prefix: "fixtures/untidy",
        });
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses an object store region that is not a plain name, and takes the names real stores use",
    async () => {
      const server = await bootFreshServer("destination-region", DISK);
      try {
        const { operator } = clientsFor(server);
        for (const plain of [
          "auto",
          "us-east-1",
          "eu-west-2",
          "US",
          "my_region",
          "-a",
          "a-",
        ]) {
          const set = await operator.patchConfig({
            object_store_region: plain,
          });
          expect(set.status, JSON.stringify(set.error)).toBe(200);
          expect(set.data).toMatchObject({ object_store_region: plain });
        }
        for (const odd of [
          ...withEachOtherCharacter(/[A-Za-z0-9_-]/),
          "a".repeat(64),
        ]) {
          const refused = await operator.patchConfig({
            object_store_region: odd,
          });
          expect(refused.status, odd).toBe(400);
          expect(JSON.stringify(refused.error), odd).toContain(
            "object_store_region",
          );
        }
        expect((await operator.getConfig()).data).toMatchObject({
          object_store_region: "a-",
        });
        // The rule takes some of these and refuses others.
        const answers = new Set<number>();
        for (const name of hyphenatedNames()) {
          const answer = await operator.patchConfig({
            object_store_region: name,
          });
          answers.add(answer.status);
          if (answer.status !== 200) {
            expect(answer.status, name).toBe(400);
            expect(JSON.stringify(answer.error), name).toContain(
              "object_store_region",
            );
          }
        }
        expect([...answers].sort()).toEqual([200, 400]);
        const padded = await operator.patchConfig({
          object_store_region: "  eu-west-1 ",
        });
        expect(padded.status, JSON.stringify(padded.error)).toBe(200);
        expect(padded.data).toMatchObject({ object_store_region: "eu-west-1" });
        for (const blank of ["", "   "]) {
          const cleared = await operator.patchConfig({
            object_store_region: blank,
          });
          expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
          expect(cleared.data).not.toHaveProperty("object_store_region");
        }
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses an object store bucket that is not a valid name, and takes the names real stores use",
    async () => {
      const server = await bootFreshServer("destination-bucket", DISK);
      try {
        const { operator } = clientsFor(server);
        const endpoint = await operator.patchConfig({
          object_store_endpoint: "http://127.0.0.1:9/",
        });
        expect(endpoint.status, JSON.stringify(endpoint.error)).toBe(200);
        for (const valid of [
          "marfa",
          "my-bucket",
          "my.bucket.name",
          "tenant:bucket",
          "My_Old_Bucket",
        ]) {
          const set = await operator.patchConfig({
            object_store_bucket: valid,
          });
          expect(set.status, JSON.stringify(set.error)).toBe(200);
          expect(set.data).toMatchObject({ object_store_bucket: valid });
        }
        for (const odd of [
          ...withEachOtherCharacter(/[A-Za-z0-9._:-]/),
          ".",
          "..",
          "b\u00fccket",
          "b".repeat(256),
        ]) {
          const refused = await operator.patchConfig({
            object_store_bucket: odd,
          });
          expect(refused.status, odd).toBe(400);
          expect(JSON.stringify(refused.error), odd).toContain(
            "object_store_bucket",
          );
        }
        expect((await operator.getConfig()).data).toMatchObject({
          object_store_bucket: "My_Old_Bucket",
        });
        const padded = await operator.patchConfig({
          object_store_bucket: "  my.bucket ",
        });
        expect(padded.status, JSON.stringify(padded.error)).toBe(200);
        expect(padded.data).toMatchObject({ object_store_bucket: "my.bucket" });
        for (const blank of ["", "   "]) {
          const cleared = await operator.patchConfig({
            object_store_bucket: blank,
          });
          expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
          expect(cleared.data).not.toHaveProperty("object_store_bucket");
        }
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a stored store setting that does not read", () => {
  const unreadable = { key: "object_store_region", value: "not a region" };
  const unreadablePath = { key: "backup_path", value: "not/an/absolute/path" };

  async function storeConcerns(server: FreshServer) {
    return (await attentionOf(server)).filter(
      (concern) => concern.kind === "backup" && concern.reference === "store",
    );
  }

  /** Boots a disk-only server holding one file no item names, already reported. */
  async function diskServerWithOrphan(
    label: string,
    env: Record<string, string> = {},
  ) {
    const server = await bootFreshServer(label, {
      ...DISK,
      ...env,
      MARFA_BLOB_CLEANUP_GRACE_SECONDS: "0",
    });
    const { operator, working } = clientsFor(server);
    const bytes = bytesOf("nothing names these bytes", 100);
    const upload = await working.uploadBlob(bytes, "text/plain");
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    const stores = (await operator.listBlobStores()).data.data;
    const first = await runJob(operator, "blob-orphans");
    expect(first.result).toMatchObject({ purged: 0 });
    return {
      server,
      hash: upload.data.hash,
      diskId: stores.find((store) => store.kind === "disk")!.id,
    };
  }

  /** What holds while the disk store's folder is away and `backup_path` does not read. */
  async function expectHeldBack(
    server: FreshServer,
    hash: string,
    diskId: string,
  ) {
    const { operator, working } = clientsFor(server);
    const stores = (await operator.listBlobStores()).data.data;
    expect(
      stores
        .filter((store) => store.detached_at === null)
        .map((store) => store.id),
    ).toEqual([diskId]);
    const told = await storeConcerns(server);
    expect(told).toHaveLength(1);
    expect(told[0]!.description).toContain(unreadablePath.key);
    expect(told[0]!.description).not.toContain(unreadablePath.value);
    // The blob folder being away makes this answer 503, with the same body.
    const health = await operator.rawRequest<{
      backups: Record<string, unknown>;
      components: Record<string, { status: string }>;
    }>("/health");
    expect(health.data.components.blob_storage?.status).toBe("down");
    expect(health.data.backups).toMatchObject({
      destination: "folder",
      reason: "destination_unusable",
    });
    const read = await operator.downloadBlob(hash);
    expect(read.status).toBe(503);
    expect(read.error?.error.code).toBe("blob_store_unavailable");
    const upload = await working.uploadBlob(
      bytesOf("sent while the folder is away", 100),
      "text/plain",
    );
    expect(upload.status).toBe(503);
    expect(upload.error?.error.code).toBe("blob_store_unavailable");
    const sweep = await runJob(operator, "blob-orphans");
    expect(sweep.result).toMatchObject({ purged: 0 });
  }

  it(
    "starts, attaches no object store, purges nothing and names the setting without its value while a stored object store setting does not read, and takes the store once it is set again",
    async () => {
      const server = await bootFreshServer("destination-unreadable", {
        ...ownObjectStore(),
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
        MARFA_BLOB_CLEANUP_GRACE_SECONDS: "0",
      });
      try {
        const before = clientsFor(server);
        await waitFor("the object store to be in use", async () =>
          (await backups(server)).destination === "bucket" ? true : undefined,
        );
        const upload = await before.working.uploadBlob(
          bytesOf("nothing names these bytes", 100),
          "text/plain",
        );
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        const hash = upload.data.hash;
        await whenCopied(before.operator, [hash]);
        const stores = (await before.operator.listBlobStores()).data.data;
        const bucket = stores.find((store) => store.kind === "s3")!;
        expect(bucket.detached_at).toBeNull();
        const first = await runJob(before.operator, "blob-orphans");
        expect(first.result).toMatchObject({ purged: 0 });

        await server.restart(() => {
          storeSettingRow(server.sqlitePath, unreadable.key, unreadable.value);
        });
        const { operator } = clientsFor(server);
        const after = (await operator.listBlobStores()).data.data;
        expect(
          after.find((store) => store.id === bucket.id)!.detached_at,
        ).not.toBeNull();
        const told = await storeConcerns(server);
        expect(told).toHaveLength(1);
        expect(told[0]!.description).toContain(unreadable.key);
        expect(told[0]!.description).not.toContain(unreadable.value);
        expect(await backups(server)).toMatchObject({
          destination: "bucket",
          reason: "destination_unusable",
        });
        const held = await runJob(operator, "blob-orphans");
        expect(held.result).toMatchObject({ purged: 0 });
        expect(existsSync(diskPath(server, hash))).toBe(true);
        expect((await operator.downloadBlob(hash)).status).toBe(200);

        const set = await operator.patchConfig({ [unreadable.key]: null });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        await waitFor("the object store to be in use again", async () => {
          const said = await backups(server);
          return said.destination === "bucket" &&
            said.reason !== "destination_unusable"
            ? true
            : undefined;
        });
        expect(await storeConcerns(server)).toEqual([]);
        // The witness: with the store back, the same sweep purges the file.
        const purged = await runJob(operator, "blob-orphans");
        expect(purged.result).toMatchObject({ purged: 1 });
        expect((await operator.downloadBlob(hash)).status).toBe(404);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "starts over an emptied blob folder while a stored object store setting does not read, answers 503 for the file it held, and serves it once the setting is set again",
    async () => {
      const server = await bootFreshServer("destination-unreadable-empty", {
        ...ownObjectStore(),
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      try {
        const before = clientsFor(server);
        await waitFor("the object store to be in use", async () =>
          (await backups(server)).destination === "bucket" ? true : undefined,
        );
        const bytes = bytesOf("held by the bucket too", 100);
        const upload = await before.working.uploadBlob(bytes, "text/plain");
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        const hash = upload.data.hash;
        await whenCopied(before.operator, [hash]);
        const disk = (await before.operator.listBlobStores()).data.data.find(
          (store) => store.kind === "disk",
        )!;

        await server.restart(() => {
          storeSettingRow(server.sqlitePath, unreadable.key, unreadable.value);
          rmSync(blobFolder(server), { recursive: true, force: true });
        });
        const { operator } = clientsFor(server);
        const told = await storeConcerns(server);
        expect(told).toHaveLength(1);
        expect(told[0]!.description).toContain(unreadable.key);
        expect(told[0]!.description).not.toContain(unreadable.value);
        const absent = await operator.downloadBlob(hash);
        expect(absent.status).toBe(503);
        expect(readdirSync(blobFolder(server))).toEqual([]);
        const kept = (await operator.listBlobStores()).data.data.find(
          (store) => store.id === disk.id,
        )!;
        expect(kept.detached_at).toBeNull();

        const set = await operator.patchConfig({ [unreadable.key]: null });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        const served = await waitFor("the file to be served", async () => {
          const download = await operator.downloadBlob(hash);
          return download.status === 200 ? download : undefined;
        });
        expect(
          Buffer.from(served.data as ArrayBuffer).equals(Buffer.from(bytes)),
        ).toBe(true);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "purges nothing while the object store the settings name cannot be used, and purges the same file once no store is named",
    async () => {
      const server = await bootFreshServer("destination-unusable-purge", {
        ...DISK,
        MARFA_BLOB_CLEANUP_GRACE_SECONDS: "0",
      });
      try {
        const { operator, working } = clientsFor(server);
        const named = await operator.patchConfig({
          object_store_bucket: "marfa",
          object_store_endpoint: "http://127.0.0.1:9/",
        });
        expect(named.status, JSON.stringify(named.error)).toBe(200);
        await waitFor("the store to be unusable", async () =>
          (await storeConcerns(server)).length === 1 ? true : undefined,
        );
        const upload = await working.uploadBlob(
          bytesOf("nothing names these bytes", 100),
          "text/plain",
        );
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        const hash = upload.data.hash;
        for (let run = 0; run < 2; run += 1) {
          const held = await runJob(operator, "blob-orphans");
          expect(held.result).toMatchObject({ purged: 0 });
        }
        expect((await operator.downloadBlob(hash)).status).toBe(200);

        const cleared = await operator.patchConfig({
          object_store_bucket: "",
        });
        expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
        await waitFor("the store to be let go", async () =>
          (await storeConcerns(server)).length === 0 ? true : undefined,
        );
        // The witness: with no store named, the same sweep purges the file.
        const purged = await runJob(operator, "blob-orphans");
        expect(purged.result).toMatchObject({ purged: 1 });
        expect((await operator.downloadBlob(hash)).status).toBe(404);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "tries the object store again when a sweep finds it out of use, and purges the file once it answers, with no restart or settings write",
    async () => {
      const door = await storeDoor();
      const server = await bootFreshServer("destination-store-returns", {
        ...ownObjectStore(),
        MARFA_OBJECT_STORE_ENDPOINT: door.url,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
        MARFA_BLOB_CLEANUP_GRACE_SECONDS: "0",
      });
      try {
        const before = clientsFor(server);
        await waitFor("the object store to be in use", async () =>
          (await backups(server)).destination === "bucket" ? true : undefined,
        );
        const upload = await before.working.uploadBlob(
          bytesOf("nothing names these bytes", 100),
          "text/plain",
        );
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        const hash = upload.data.hash;
        await whenCopied(before.operator, [hash]);
        const first = await runJob(before.operator, "blob-orphans");
        expect(first.result).toMatchObject({ purged: 0 });

        await server.restart(() => door.refuse(true));
        const { operator } = clientsFor(server);
        expect(await storeConcerns(server)).toHaveLength(1);
        const held = await runJob(operator, "blob-orphans");
        expect(held.result).toMatchObject({ purged: 0 });
        expect((await operator.downloadBlob(hash)).status).toBe(200);

        door.refuse(false);
        const purged = await runJob(operator, "blob-orphans");
        expect(purged.result).toMatchObject({ purged: 1 });
        expect(await storeConcerns(server)).toEqual([]);
        expect((await operator.downloadBlob(hash)).status).toBe(404);
      } finally {
        await server.stop();
        await door.close();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "starts, purges nothing and names the setting without its value while a stored backup_path does not read, and purges the file once it is set again",
    async () => {
      const { server, hash } = await diskServerWithOrphan(
        "destination-path-unreadable",
      );
      try {
        await server.restart(() => {
          storeSettingRow(
            server.sqlitePath,
            unreadablePath.key,
            unreadablePath.value,
          );
        });
        const { operator } = clientsFor(server);
        const told = await storeConcerns(server);
        expect(told).toHaveLength(1);
        expect(told[0]!.description).toContain(unreadablePath.key);
        expect(told[0]!.description).not.toContain(unreadablePath.value);
        const held = await runJob(operator, "blob-orphans");
        expect(held.result).toMatchObject({ purged: 0 });
        expect(existsSync(diskPath(server, hash))).toBe(true);
        expect((await operator.downloadBlob(hash)).status).toBe(200);

        const set = await operator.patchConfig({ [unreadablePath.key]: null });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        await waitFor("the setting to be taken", async () =>
          (await storeConcerns(server)).length === 0 ? true : undefined,
        );
        // The witness: with the setting read, the same sweep purges the file.
        const purged = await runJob(operator, "blob-orphans");
        expect(purged.result).toMatchObject({ purged: 1 });
        expect((await operator.downloadBlob(hash)).status).toBe(404);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "starts over a missing or empty blob folder while a stored backup_path does not read, leaves the folder and its store alone, and serves the files once the folder returns",
    async () => {
      // Outside the state folder, where the adapter makes no folder at a boot.
      const folder = join(tempFolder("marfa-destination-disk-"), "blobs");
      const away = `${folder}.away`;
      const { server, hash, diskId } = await diskServerWithOrphan(
        "destination-path-folder-away",
        { MARFA_BLOB_PATH: folder },
      );
      try {
        await server.restart(() => {
          storeSettingRow(
            server.sqlitePath,
            unreadablePath.key,
            unreadablePath.value,
          );
          renameSync(folder, away);
        });
        await expectHeldBack(server, hash, diskId);
        expect(existsSync(folder)).toBe(false);

        // A mount point left empty by a drive that did not mount.
        await server.restart(() => {
          mkdirSync(folder);
        });
        await expectHeldBack(server, hash, diskId);
        expect(readdirSync(folder)).toEqual([]);

        rmdirSync(folder);
        renameSync(away, folder);
        const { operator, working } = clientsFor(server);
        expect((await operator.downloadBlob(hash)).status).toBe(200);
        const later = await working.uploadBlob(
          bytesOf("sent once the folder is back", 100),
          "text/plain",
        );
        expect(later.status, JSON.stringify(later.error)).toBe(201);
        const held = await runJob(operator, "blob-orphans");
        expect(held.result).toMatchObject({ purged: 0 });
        expect((await operator.downloadBlob(hash)).status).toBe(200);

        const set = await operator.patchConfig({ [unreadablePath.key]: null });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        await waitFor("the setting to be taken", async () =>
          (await storeConcerns(server)).length === 0 ? true : undefined,
        );
        // The witness: both files were there to purge all along.
        const purged = await runJob(operator, "blob-orphans");
        expect(purged.result).toMatchObject({ purged: 2 });
        expect((await operator.downloadBlob(hash)).status).toBe(404);
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses the next start over that folder once the setting reads again, and starts once the folder returns",
    async () => {
      const { server, hash, diskId } = await diskServerWithOrphan(
        "destination-path-next-start",
      );
      const folder = blobFolder(server);
      const away = `${folder}.away`;
      let image: string | undefined;
      let refused: RefusedBoot | undefined;
      try {
        await server.restart(() => {
          storeSettingRow(
            server.sqlitePath,
            unreadablePath.key,
            unreadablePath.value,
          );
          renameSync(folder, away);
          mkdirSync(folder);
        });
        const set = await clientsFor(server).operator.patchConfig({
          [unreadablePath.key]: null,
        });
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        await waitFor("the setting to be taken", async () =>
          (await storeConcerns(server)).length === 0 ? true : undefined,
        );
        const taken = await server.image();
        image = taken;

        await server.restart(async () => {
          refused = await bootRefused("destination-path-refused", {
            prepare: (_database, state) =>
              cpSync(taken, state, { recursive: true }),
            extraEnv: { ...DISK_ONLY, MARFA_BLOB_PATH: folder },
          });
          expect(refused.code).toBe(1);
          expect(refused.output).toContain(folder);
          expect(readdirSync(folder)).toEqual([]);
          rmdirSync(folder);
          renameSync(away, folder);
        });

        // The witness: with the folder back, the same store serves the file.
        const { operator } = clientsFor(server);
        const stores = (await operator.listBlobStores()).data.data;
        expect(
          stores
            .filter((store) => store.detached_at === null)
            .map((store) => store.id),
        ).toEqual([diskId]);
        expect((await operator.downloadBlob(hash)).status).toBe(200);
      } finally {
        await refused?.stop();
        if (image) rmSync(image, { recursive: true, force: true });
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses the next start over that folder when the store named since holds none of its copies, and rebuilds it from the store that does",
    async () => {
      const store = ownObjectStore();
      const server = await bootFreshServer("destination-other-store", {
        ...store,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      let image: string | undefined;
      let refused: RefusedBoot | undefined;
      try {
        const before = clientsFor(server);
        await waitFor("the object store to be in use", async () =>
          (await backups(server)).destination === "bucket" ? true : undefined,
        );
        const upload = await before.working.uploadBlob(
          bytesOf("held by the first store", 100),
          "text/plain",
        );
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        const hash = upload.data.hash;
        await whenCopied(before.operator, [hash]);

        const folder = blobFolder(server);
        await server.restart(() => {
          storeSettingRow(server.sqlitePath, unreadable.key, unreadable.value);
          rmSync(folder, { recursive: true, force: true });
        });
        const { operator } = clientsFor(server);
        const other = await operator.patchConfig({
          [unreadable.key]: null,
          object_store_prefix: `fixture-${randomUUID()}`,
        });
        expect(other.status, JSON.stringify(other.error)).toBe(200);
        await waitFor("the other store to be in use", async () =>
          (await storeConcerns(server)).length === 0 ? true : undefined,
        );
        expect((await operator.downloadBlob(hash)).status).toBe(503);
        const taken = await server.image();
        image = taken;

        const back = await operator.patchConfig({
          object_store_prefix: store.MARFA_OBJECT_STORE_PREFIX,
        });
        expect(back.status, JSON.stringify(back.error)).toBe(200);
        await server.restart(async () => {
          refused = await bootRefused("destination-other-store-refused", {
            prepare: (_database, state) =>
              cpSync(taken, state, { recursive: true }),
            extraEnv: { MARFA_BLOB_PATH: folder },
          });
          expect(refused.code).toBe(1);
          expect(refused.output).toContain(folder);
          expect(readdirSync(folder)).toEqual([]);
        });

        // The witness: the store that holds the copies rebuilds the folder.
        const after = clientsFor(server).operator;
        expect((await after.downloadBlob(hash)).status).toBe(200);
        await replicateUntilCaughtUp(after, "the folder to be filled again");
        expect(existsSync(diskPath(server, hash))).toBe(true);
      } finally {
        await refused?.stop();
        if (image) rmSync(image, { recursive: true, force: true });
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses to start over an emptied blob folder while the setting that does not read is not one that names the store",
    async () => {
      const { server } = await diskServerWithOrphan("destination-still-judged");
      const folder = blobFolder(server);
      const image = await server.image();
      const refusals: RefusedBoot[] = [];
      const refusedStart = async (
        setting: { key: string; value: string },
        env: Record<string, string>,
      ) => {
        const refused = await bootRefused("destination-still-refused", {
          prepare: (_database, state) => {
            cpSync(image, state, { recursive: true });
            storeSettingRow(
              join(state, "marfa.db"),
              setting.key,
              setting.value,
            );
          },
          extraEnv: { ...env, MARFA_BLOB_PATH: folder },
        });
        refusals.push(refused);
        expect(refused.code).toBe(1);
        expect(refused.output).toContain(folder);
        expect(existsSync(folder)).toBe(false);
      };
      try {
        await server.restart(async () => {
          renameSync(folder, `${folder}.away`);
          await refusedStart(unreadable, DISK_ONLY);
          await refusedStart(unreadablePath, {
            MARFA_OBJECT_STORE_BUCKET: "marfa",
            MARFA_OBJECT_STORE_ENDPOINT: "http://127.0.0.1:9/",
          });
          renameSync(`${folder}.away`, folder);
        });
      } finally {
        for (const refused of refusals) await refused.stop();
        rmSync(image, { recursive: true, force: true });
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
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
