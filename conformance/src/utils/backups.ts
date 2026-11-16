import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MarfaClient } from "../client/api.js";
import { tar } from "./archive.js";
import { controlRequest } from "./control-request.js";
import type { FreshServer } from "./fresh-server.js";
import { clientsFor } from "./own-blob-server.js";
import { waitFor } from "./wait.js";

/**
 * The run's object store, reached directly with the credentials the
 * environment names, under the prefix a fixture's own server was given.
 */
export interface Bucket {
  prefix: string;
  /** Every key under the prefix, sorted. */
  keys(): Promise<string[]>;
  /** The keys directly and indirectly under `<prefix>/backups/`, sorted. */
  backupKeys(): Promise<string[]>;
  /** The keys under `<prefix>/backup-parts/<instance>/`, sorted. */
  partKeys(instance: string): Promise<string[]>;
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
  /** The keys of multipart uploads begun under the prefix and not finished. */
  unfinishedUploads(): Promise<string[]>;
}

export function bucketAt(prefix: string): Bucket {
  const bucket = process.env.S3_BUCKET!;
  const client = new S3Client({
    region: process.env.S3_REGION!,
    endpoint: process.env.S3_ENDPOINT!,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
  const listed = async (under: string) => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: under,
          ContinuationToken: token,
        }),
      );
      keys.push(...(page.Contents ?? []).map((object) => object.Key!));
      token = page.NextContinuationToken;
    } while (token);
    return keys.sort();
  };
  return {
    prefix,
    keys: () => listed(`${prefix}/`),
    backupKeys: () => listed(`${prefix}/backups/`),
    partKeys: (instance) => listed(`${prefix}/backup-parts/${instance}/`),
    async get(key) {
      const found = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      return await found.Body!.transformToByteArray();
    },
    async put(key, body) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
      );
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async unfinishedUploads() {
      const found = await client.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          Prefix: `${prefix}/`,
        }),
      );
      return (found.Uploads ?? []).map((upload) => upload.Key!).sort();
    },
  };
}

/** The owner's client on a fresh server, through its private local command. */
export function ownerOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
}

/** The name a backup taken at `at` carries: the instant in the ISO 8601 basic format. */
export function backupName(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, "")}.json`;
}

/** One part a backup's manifest names. */
export interface BackupPart {
  entry: string;
  sha256: string;
  size_bytes: number;
  lines: number;
}

/** What a backup's manifest holds. */
export interface BackupManifest {
  format: string;
  version: number;
  archive: Record<string, unknown>;
  parts: BackupPart[];
}

/** The name a part is stored under: the SHA-256 of its bytes. */
export function partName(part: { sha256: string }): string {
  return `${part.sha256}.ndjson.gz`;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The archive a backup's manifest and parts make: the archive manifest as
 * `manifest.json`, then each line file as its parts joined in order. Each part
 * read must hold the bytes its name gives.
 */
export async function assembled(
  manifest: BackupManifest,
  read: (name: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const entries = new Map<string, Buffer[]>();
  for (const part of manifest.parts) {
    const bytes = await read(partName(part));
    if (bytes.length !== part.size_bytes || sha256Of(bytes) !== part.sha256) {
      throw new Error(`the part ${partName(part)} does not hold its bytes`);
    }
    const joined = entries.get(part.entry) ?? [];
    joined.push(Buffer.from(bytes));
    entries.set(part.entry, joined);
  }
  return tar([
    { name: "manifest.json", body: JSON.stringify(manifest.archive) },
    ...[...entries].map(([name, parts]) => ({
      name,
      body: new Uint8Array(Buffer.concat(parts)),
    })),
  ]);
}

/** A backup as its destination holds it: its manifest, and the archive it and its parts make. */
export interface StoredBackup {
  manifest: BackupManifest;
  /** The bytes of the manifest itself. */
  manifestBytes: number;
  archive: Uint8Array;
}

/** The backup `name` of `instance` in `bucket`. */
export async function backupInBucket(
  bucket: Bucket,
  instance: string,
  name: string,
): Promise<StoredBackup> {
  const bytes = await bucket.get(
    `${bucket.prefix}/backups/${instance}/${name}`,
  );
  const manifest = JSON.parse(
    Buffer.from(bytes).toString("utf8"),
  ) as BackupManifest;
  const archive = await assembled(manifest, (part) =>
    bucket.get(`${bucket.prefix}/backup-parts/${instance}/${part}`),
  );
  return { manifest, manifestBytes: bytes.length, archive };
}

/** The backup `name` of `instance` in the backup folder `root`. */
export async function backupInFolder(
  root: string,
  instance: string,
  name: string,
): Promise<StoredBackup> {
  const bytes = readFileSync(join(root, "backups", instance, name));
  const manifest = JSON.parse(bytes.toString("utf8")) as BackupManifest;
  const archive = await assembled(manifest, (part) =>
    Promise.resolve(
      new Uint8Array(readFileSync(join(root, "backup-parts", instance, part))),
    ),
  );
  return { manifest, manifestBytes: bytes.length, archive };
}

/** What a stored backup takes: its manifest and every part it names. */
export function storedSize(backup: StoredBackup): number {
  return backup.manifest.parts.reduce(
    (sum, part) => sum + part.size_bytes,
    backup.manifestBytes,
  );
}

/** The server's instance id, which names the folder its backups go in. */
export async function instanceIdOf(server: FreshServer): Promise<string> {
  const root = await fetch(`${server.apiUrl}/`);
  return ((await root.json()) as { instance_id: string }).instance_id;
}

/**
 * Waits until the first scheduled backup run of a server that has the
 * schedule on has ended, so that with a long interval no scheduled run comes
 * during the test that follows, whenever the first one falls due.
 */
export async function afterFirstScheduledBackup(
  server: FreshServer,
): Promise<void> {
  const { operator } = clientsFor(server);
  await waitFor(
    "the first scheduled backup",
    async () => {
      const jobs = await operator.listHousekeeping();
      const backup = jobs.data.data.find((job) => job.name === "backup");
      return backup?.last_finished_at ? true : undefined;
    },
    60_000,
  );
}

/** One entry of the owner's attention list. */
export interface Concern {
  kind: string;
  reference: string;
  title: string;
  description: string;
}

/** The attention list, read through the private socket. */
export async function attentionOf(server: FreshServer): Promise<Concern[]> {
  const answer = await controlRequest(server.controlSocket, "/attention");
  if (answer.status !== 200) {
    throw new Error(`/attention answered ${String(answer.status)}`);
  }
  return (answer.body as { data: Concern[] }).data;
}

/** The entries of the attention list that concern backups. */
export async function backupConcerns(server: FreshServer): Promise<Concern[]> {
  return (await attentionOf(server)).filter(
    (concern) => concern.kind === "backup",
  );
}

/** `GET /health` as the operator reads it, with the reasons. */
export async function healthDetail(server: FreshServer): Promise<{
  status: string;
  backups: Record<string, unknown>;
}> {
  const answer = await clientsFor(server).operator.rawRequest<{
    status: string;
    backups: Record<string, unknown>;
  }>("/health");
  if (answer.status !== 200) {
    throw new Error(`/health answered ${String(answer.status)}`);
  }
  return answer.data;
}
