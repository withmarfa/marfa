import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
} from "../../utils/setup.js";
import { uploadReferenced } from "../../utils/blobs.js";

let client: MarfaClient;
let operator: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "blob-served"));
  operator = getOperatorClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

/** One of the values the run booted the server with. */
function bootEnv(name: "MARFA_API_URL" | "S3_ENDPOINT"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required here: source the env files \`pnpm marfa:up\` and \`pnpm garage:up\` write.`,
    );
  }
  return value;
}

/** Runs `blob-replicate` until no store lacks a blob. A run the server's
 *  own scheduler holds answers 409, and is asked for again. */
async function replicateToZero(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const res = await operator.runBackgroundJob("blob-replicate");
    if (res.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    if ((res.data.result as { remaining: number }).remaining === 0) return;
  }
  throw new Error("blob-replicate never reached remaining: 0");
}

/** The link the instance serves itself: the object store's copy, which the
 *  server's own scheduler makes within a second of an upload, is dropped,
 *  so the link door has only the instance to answer with. */
async function instanceLink(hash: string): Promise<string> {
  const locations = (await operator.listBlobLocations(hash)).data.data;
  for (const location of locations) {
    if (location.kind !== "s3") continue;
    const dropped = await operator.dropBlobLocation(hash, location.store_id);
    expect(dropped.status).toBe(200);
  }
  const link = await client.getBlobUrl(hash);
  expect(link.status).toBe(200);
  expect(new URL(link.data.url).host).toBe(
    new URL(bootEnv("MARFA_API_URL")).host,
  );
  return link.data.url;
}

function expectInertDownload(headers: Headers, hash: string, label: string) {
  expect(headers.get("content-disposition"), label).toBe(
    `attachment; filename="${hash.slice("sha256:".length)}"`,
  );
  expect(headers.get("content-security-policy"), label).toBe(
    "sandbox; default-src 'none'",
  );
  expect(headers.get("x-content-type-options"), label).toBe("nosniff");
}

describe("how a blob's bytes are served", () => {
  it("serves an HTML blob as a sandboxed download on every instance door", async () => {
    const content = new TextEncoder().encode(
      `<!doctype html><script>fetch("/keys")</script> ${ctx.runId}`,
    );
    const upload = await uploadReferenced(client, ctx, content, "text/html");
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;

    // The witness: the type the uploader sent is the type served.
    const download = await client.downloadBlob(hash);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("text/html");
    expect(new Uint8Array(download.data)).toEqual(content);
    expectInertDownload(download.headers, hash, "GET /blobs/{hash}");

    const head = await client.headBlob(hash);
    expect(head.status).toBe(200);
    expectInertDownload(head.headers, hash, "HEAD /blobs/{hash}");

    const url = await instanceLink(hash);
    for (const method of ["GET", "HEAD"]) {
      const fetched = await fetch(url, { method });
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get("content-type")).toBe("text/html");
      expectInertDownload(fetched.headers, hash, `${method} the link`);
    }
  });

  it("answers a second upload under another type with the type the first fixed, on every link", async () => {
    const content = new TextEncoder().encode(`typed once ${ctx.runId}`);
    const first = await uploadReferenced(client, ctx, content, "text/plain");
    expect(first.status).toBe(201);
    expect(first.data.mime_type).toBe("text/plain");
    const hash = first.data.hash;

    const second = await client.uploadBlob(content, "text/html");
    expect(second.status).toBe(201);
    expect(second.data.hash).toBe(hash);
    expect(second.data.mime_type).toBe("text/plain");

    const download = await client.downloadBlob(hash);
    expect(download.headers.get("content-type")).toBe("text/plain");

    // The object store's own link serves the recorded type and the
    // download, signed into the link, from the store's own host.
    await replicateToZero();
    const stored = await client.getBlobUrl(hash);
    expect(stored.status).toBe(200);
    expect(new URL(stored.data.url).host).toBe(
      new URL(bootEnv("S3_ENDPOINT")).host,
    );
    const fromStore = await fetch(stored.data.url);
    expect(fromStore.status).toBe(200);
    expect(new Uint8Array(await fromStore.arrayBuffer())).toEqual(content);
    expect(fromStore.headers.get("content-type")).toBe("text/plain");
    expect(fromStore.headers.get("content-disposition")).toBe(
      `attachment; filename="${hash.slice("sha256:".length)}"`,
    );

    const fromInstance = await fetch(await instanceLink(hash));
    expect(fromInstance.status).toBe(200);
    expect(fromInstance.headers.get("content-type")).toBe("text/plain");
  });
});
