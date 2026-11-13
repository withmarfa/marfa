import {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MarfaClient } from "../client/api.js";
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
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array | string): Promise<void>;
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

/** The name a backup taken at `at` carries. */
export function backupName(at: Date): string {
  return `${at.toISOString()}.tar`;
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
