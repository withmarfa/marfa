import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
} from "../../utils/setup.js";
import { uploadReferenced } from "../../utils/blobs.js";
import { readTarGzEntry } from "../../utils/archive.js";

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
    const res = await operator.runHousekeeping("blob-replicate");
    if (res.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    if ((res.data.result as { remaining: number }).remaining === 0) return;
  }
  throw new Error("blob-replicate never reached remaining: 0");
}

/** The link the instance serves itself: the object store's copy is made,
 *  then dropped, so the link door has only the instance to answer with. */
async function instanceLink(hash: string): Promise<string> {
  // Replication first, so no copy of its own can arrive between the drop
  // below and the link.
  await replicateToZero();
  const locations = (await operator.listBlobLocations(hash)).data.data;
  for (const location of locations) {
    if (location.kind !== "s3") continue;
    const dropped = await operator.deleteBlobLocation(hash, location.store_id);
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

  it("answers a plain GET with every header of the bytes", async () => {
    const content = new TextEncoder().encode(`every header ${ctx.runId}`);
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;

    const download = await client.downloadBlob(hash);
    expect(download.status).toBe(200);
    expect(new Uint8Array(download.data)).toEqual(content);
    expect(download.headers.get("content-type")).toBe("text/plain");
    expect(download.headers.get("content-length")).toBe(
      String(content.byteLength),
    );
    expect(download.headers.get("accept-ranges")).toBe("bytes");
    expect(download.headers.get("etag")).toBe(`"${hash}"`);
    expect(download.headers.get("content-range")).toBeNull();
    expectInertDownload(download.headers, hash, "GET /blobs/{hash}");
  });

  it("refuses an instance link whose signature was altered with 401", async () => {
    const content = new TextEncoder().encode(`altered link ${ctx.runId}`);
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.status).toBe(201);
    const url = await instanceLink(upload.data.hash);

    // The witness: the link as minted fetches the bytes.
    const live = await fetch(url);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(content);

    const altered = new URL(url);
    const signature = altered.searchParams.get("signature") ?? "";
    expect(signature.length).toBeGreaterThan(0);
    altered.searchParams.set(
      "signature",
      (signature.startsWith("0") ? "1" : "0") + signature.slice(1),
    );
    const dead = await fetch(altered);
    expect(dead.status).toBe(401);
    const body = (await dead.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
    expect((await fetch(altered, { method: "HEAD" })).status).toBe(401);
  });

  it("refuses an instance link after its one second lifetime with 401", async () => {
    const content = new TextEncoder().encode(`expiring link ${ctx.runId}`);
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;
    const long = await instanceLink(hash);
    const short = await client.getBlobUrl(hash, 1);
    expect(short.status).toBe(200);
    expect(short.data.expires_in).toBe(1);
    expect(new URL(short.data.url).host).toBe(
      new URL(bootEnv("MARFA_API_URL")).host,
    );

    // The witnesses: the short link fetches while it lives, and a link of
    // the same blob that has not run out still fetches after.
    const alive = await fetch(short.data.url);
    expect(alive.status).toBe(200);
    expect(new Uint8Array(await alive.arrayBuffer())).toEqual(content);

    // A signer counts a lifetime from a whole second, so two seconds and a
    // little cover it.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const dead = await fetch(short.data.url);
    expect(dead.status).toBe(401);
    const body = (await dead.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
    expect((await fetch(short.data.url, { method: "HEAD" })).status).toBe(401);
    expect((await fetch(long)).status).toBe(200);
  });

  it("serves an instance link under a bare hash and refuses a malformed hash or a stray key on it", async () => {
    const content = new TextEncoder().encode(`link forms ${ctx.runId}`);
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;
    const url = new URL(await instanceLink(hash));
    const bare = hash.slice("sha256:".length);

    const live = await fetch(url);
    expect(live.status).toBe(200);
    await live.body?.cancel();

    const withPath = (segment: string, extra = "") => {
      const copy = new URL(url);
      copy.pathname = `/blobs/${segment}/fetch`;
      if (extra) copy.search += `&${extra}`;
      return copy;
    };
    const barePath = await fetch(withPath(bare));
    expect(barePath.status).toBe(200);
    expect(new Uint8Array(await barePath.arrayBuffer())).toEqual(content);

    for (const form of ["not-a-hash", bare.slice(1), bare.toUpperCase()]) {
      const refused = await fetch(withPath(form));
      expect(refused.status, form).toBe(400);
      const body = (await refused.json()) as { error: { code: string } };
      expect(body.error.code, form).toBe("validation_error");
    }

    const own = await fetch(withPath(hash, "_own=1"));
    expect(own.status).toBe(200);
    await own.body?.cancel();
    const stray = await fetch(withPath(hash, "bogus=1"));
    expect(stray.status).toBe(400);
    const body = (await stray.json()) as {
      error: { code: string; details?: { unknown_parameters?: string[] } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.unknown_parameters).toEqual(["bogus"]);
  });

  it("applies the range rules to an instance link", async () => {
    const upload = await uploadReferenced(
      client,
      ctx,
      new TextEncoder().encode("0123456789"),
      "text/plain",
    );
    expect(upload.status).toBe(201);
    const url = await instanceLink(upload.data.hash);
    const ranged = (range: string) => fetch(url, { headers: { Range: range } });

    const closed = await ranged("bytes=2-5");
    expect(closed.status).toBe(206);
    expect(closed.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await closed.text()).toBe("2345");

    const open = await ranged("bytes=4-");
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(await open.text()).toBe("456789");

    const clamped = await ranged("bytes=7-99");
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await clamped.text()).toBe("789");

    for (const range of ["bytes=10-12", "bytes=5-2"]) {
      const refused = await ranged(range);
      expect(refused.status, range).toBe(416);
      expect(refused.headers.get("content-range"), range).toBe("bytes */10");
      const body = (await refused.json()) as { error: { code: string } };
      expect(body.error.code, range).toBe("range_not_satisfiable");
    }

    const whole = await ranged("bytes=-3");
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe("0123456789");
  });

  it("answers an unsatisfiable range on an instance link with the size in details", async () => {
    const content = new TextEncoder().encode(`0123456789 ${ctx.runId}`);
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.status).toBe(201);
    const url = await instanceLink(upload.data.hash);
    const size = content.byteLength;

    // The witness: the last byte is the largest start the blob satisfies.
    const last = await fetch(url, {
      headers: { Range: `bytes=${String(size - 1)}-` },
    });
    expect(last.status).toBe(206);
    await last.arrayBuffer();

    for (const range of [`bytes=${String(size)}-`, "bytes=5-2"]) {
      const refused = await fetch(url, { headers: { Range: range } });
      expect(refused.status, range).toBe(416);
      expect(refused.headers.get("content-range"), range).toBe(
        `bytes */${String(size)}`,
      );
      const body = (await refused.json()) as {
        error: { code: string; details?: { size_bytes?: number } };
      };
      expect(body.error.code, range).toBe("range_not_satisfiable");
      expect(body.error.details, range).toEqual({ size_bytes: size });
    }
  });

  it("serves a ranged answer as the same sandboxed download, on every instance door", async () => {
    const content = new TextEncoder().encode(
      `<svg onload="fetch('/keys')"></svg> ${ctx.runId}`,
    );
    const upload = await uploadReferenced(client, ctx, content, "text/html");
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;
    const range = { Range: "bytes=1-5" };
    const slice = content.slice(1, 6);

    // The witness: the same door answers the whole of it with the headers.
    const whole = await client.downloadBlob(hash);
    expect(whole.status).toBe(200);
    expectInertDownload(whole.headers, hash, "GET /blobs/{hash}");

    const partial = await client.downloadBlob(hash, range);
    expect(partial.status).toBe(206);
    expect(new Uint8Array(partial.data)).toEqual(slice);
    expect(partial.headers.get("content-range")).toBe(
      `bytes 1-5/${String(content.length)}`,
    );
    expectInertDownload(partial.headers, hash, "ranged GET /blobs/{hash}");

    const head = await client.headBlob(hash, range);
    expect(head.status).toBe(206);
    expectInertDownload(head.headers, hash, "ranged HEAD /blobs/{hash}");

    const url = await instanceLink(hash);
    for (const method of ["GET", "HEAD"]) {
      const fetched = await fetch(url, { method, headers: range });
      expect(fetched.status).toBe(206);
      expect(fetched.headers.get("content-range")).toBe(
        `bytes 1-5/${String(content.length)}`,
      );
      expectInertDownload(fetched.headers, hash, `ranged ${method} the link`);
    }
  });

  it("serves an image as a download and never inline, on every instance door", async () => {
    for (const [type, content] of [
      ["image/png", `not a png, only typed as one ${ctx.runId}`],
      [
        "image/svg+xml",
        `<svg xmlns="http://www.w3.org/2000/svg"/> ${ctx.runId}`,
      ],
    ] as const) {
      const bytes = new TextEncoder().encode(content);
      const upload = await uploadReferenced(client, ctx, bytes, type);
      expect(upload.status, type).toBe(201);
      const hash = upload.data.hash;

      const download = await client.downloadBlob(hash);
      expect(download.status, type).toBe(200);
      expect(download.headers.get("content-type"), type).toBe(type);
      expectInertDownload(download.headers, hash, `GET ${type}`);

      const head = await client.headBlob(hash);
      expect(head.headers.get("content-type"), type).toBe(type);
      expectInertDownload(head.headers, hash, `HEAD ${type}`);

      const fetched = await fetch(await instanceLink(hash));
      expect(fetched.status, type).toBe(200);
      expect(fetched.headers.get("content-type"), type).toBe(type);
      expectInertDownload(fetched.headers, hash, `the link to ${type}`);
    }
  });

  it("answers a HEAD, a ranged read and a link with the type the first upload fixed", async () => {
    const content = new TextEncoder().encode(
      `typed once, read again ${ctx.runId}`,
    );
    const first = await uploadReferenced(client, ctx, content, "text/plain");
    expect(first.status).toBe(201);
    const hash = first.data.hash;
    const second = await client.uploadBlob(content, "text/html");
    expect(second.status).toBe(201);
    expect(second.data.mime_type).toBe("text/plain");

    expect((await client.headBlob(hash)).headers.get("content-type")).toBe(
      "text/plain",
    );
    const partial = await client.downloadBlob(hash, { Range: "bytes=0-3" });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-type")).toBe("text/plain");
    const fetched = await fetch(await instanceLink(hash), { method: "HEAD" });
    expect(fetched.headers.get("content-type")).toBe("text/plain");
  });

  it("sends an export archive as a download under its own name, whatever blobs it carries", async () => {
    const content = new TextEncoder().encode(
      `carried by an archive ${ctx.runId}`,
    );
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;

    const archive = await client.exportArchive({
      type: "core.note",
      source: ctx.source,
    });
    expect(archive.status).toBe(200);
    // The witness: the archive does carry the blob's bytes.
    expect(readTarGzEntry(archive.data, `blobs/${hash}`)).toBe(
      new TextDecoder().decode(content),
    );
    expect(archive.headers.get("content-type")).toBe("application/gzip");
    expect(archive.headers.get("content-disposition")).toMatch(
      /^attachment; filename="marfa-export-\d{4}-\d{2}-\d{2}\.tar\.gz"$/,
    );
    expect(archive.headers.get("content-disposition")).not.toContain(
      hash.slice("sha256:".length),
    );
  });
});
