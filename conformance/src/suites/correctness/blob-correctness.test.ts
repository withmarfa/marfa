import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { referenceBlob, uploadReferenced } from "../../utils/blobs.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "correctness",
    "blob-correctness",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A link's bytes, fetched with no credential at all. */
async function fetchLink(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/**
 * A refused link: a status outside 2xx, and none of the blob's bytes. The
 * status itself is the signer's own, and the instance and an object store
 * answer a dead link with different ones; a client holding a link must not
 * care which of them signed it.
 */
function expectRefused(
  fetched: Awaited<ReturnType<typeof fetchLink>>,
  content: Uint8Array,
) {
  expect(Math.floor(fetched.status / 100)).not.toBe(2);
  expect(fetched.bytes).not.toEqual(content);
}

/** This run's own bytes, so no earlier run's row names or types them. */
function bytesOf(words: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${words} ${ctx.runId}`);
}

interface Answered {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  error?: { code?: string; details?: Record<string, unknown> };
}

/**
 * One request to the instance with the suite key, for what the client has no
 * method for: a header it would add or a query it would not send.
 */
async function call(
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: Uint8Array<ArrayBuffer>;
  } = {},
): Promise<Answered> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...options.headers },
    body: options.body,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let error: Answered["error"];
  if (response.status >= 400 && bytes.length > 0) {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      error?: Answered["error"];
    };
    error = parsed.error;
  }
  return { status: response.status, headers: response.headers, bytes, error };
}

describe("blob correctness", () => {
  it("upload returns the sha256 hash, the mime type sent and the byte length", async () => {
    const content = new TextEncoder().encode("hello blob world");

    const upload = await client.uploadBlob(content, "text/plain");
    expect(upload.status).toBe(201);
    await expectMatchesSchema("POST", "/blobs", 201, upload.data);
    expect(upload.data.hash).toBe(hashOf(content));
    expect(upload.data.mime_type).toBe("text/plain");
    expect(upload.data.size_bytes).toBe(content.byteLength);
  });

  it("stores a body far larger than the JSON cap, whole", async () => {
    // Sixty-four mebibytes and three bytes: well past the cap the JSON
    // write surface refuses at. The hash proves every byte arrived, the
    // download that they can be read.
    const content = new Uint8Array(64 * 1_048_576 + 3);
    for (let i = 0; i < content.length; i += 4093) content[i] = i & 0xff;

    const upload = await uploadReferenced(
      client,
      ctx,
      content,
      "application/octet-stream",
    );
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    expect(upload.data.hash).toBe(hashOf(content));
    expect(upload.data.size_bytes).toBe(content.byteLength);

    const download = await client.downloadBlob(upload.data.hash);
    expect(download.ok).toBe(true);
    expect(download.headers.get("content-length")).toBe(
      String(content.byteLength),
    );
    expect(hashOf(new Uint8Array(download.data))).toBe(upload.data.hash);
  });

  it("download returns byte-for-byte identical content", async () => {
    const content = new TextEncoder().encode("roundtrip blob content");

    const upload = await uploadReferenced(
      client,
      ctx,
      content,
      "application/octet-stream",
    );
    expect(upload.ok).toBe(true);

    const download = await client.downloadBlob(upload.data.hash);
    expect(download.ok).toBe(true);
    expect(new Uint8Array(download.data)).toEqual(content);
  });

  it("content-type is preserved on download", async () => {
    const content = new TextEncoder().encode("fake png data");

    const upload = await uploadReferenced(client, ctx, content, "image/png");
    expect(upload.ok).toBe(true);

    const download = await client.downloadBlob(upload.data.hash);
    expect(download.ok).toBe(true);

    const contentType = download.headers.get("content-type");
    expect(contentType).toContain("image/png");
  });

  it("serves one byte range with 206, and 416 outside the blob", async () => {
    const content = new TextEncoder().encode("0123456789");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.ok).toBe(true);

    const ranged = await client.downloadBlob(upload.data.hash, {
      Range: "bytes=2-5",
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    expect(new TextDecoder().decode(ranged.data)).toBe("2345");

    const outside = await client.downloadBlob(upload.data.hash, {
      Range: "bytes=10-12",
    });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("content-range")).toBe("bytes */10");
    expect(outside.error?.error.code).toBe("range_not_satisfiable");
  });

  it("answers HEAD with the headers of the bytes", async () => {
    const content = new TextEncoder().encode("headers only");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.ok).toBe(true);

    const head = await client.headBlob(upload.data.hash);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/plain");
    expect(head.headers.get("content-length")).toBe(String(content.length));
    expect(head.headers.get("etag")).toBe(`"${upload.data.hash}"`);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
  });

  it("duplicate upload returns same hash without error", async () => {
    const content = new TextEncoder().encode("duplicate blob test");

    const first = await client.uploadBlob(content, "text/plain");
    expect(first.ok).toBe(true);

    const second = await client.uploadBlob(content, "text/plain");
    expect(second.ok).toBe(true);
    expect(second.data.hash).toBe(first.data.hash);
  });

  it("refuses a multipart body and takes the same bytes raw", async () => {
    const content = new TextEncoder().encode(
      '--b\r\nContent-Disposition: form-data; name="file"\r\n\r\nx\r\n--b--\r\n',
    );
    const refused = await client.uploadBlob(
      content,
      "multipart/form-data; boundary=b",
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");

    const accepted = await client.uploadBlob(content, "text/plain");
    expect(accepted.status).toBe(201);
    expect(accepted.data.hash).toBe(hashOf(content));
  });

  it("download with an unknown hash returns 404", async () => {
    const fakeHash = "sha256:" + "a".repeat(64);
    const download = await client.downloadBlob(fakeHash);
    expect(download.status).toBe(404);
    expect(download.error?.error.code).toBe("blob_not_found");
  });

  it("mints a link that fetches the bytes without a credential", async () => {
    const content = new TextEncoder().encode("bytes behind a link");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.ok).toBe(true);

    const link = await client.getBlobUrl(upload.data.hash, 90);
    expect(link.status).toBe(200);
    await expectMatchesSchema("GET", "/blobs/{hash}/url", 200, link.data);
    expect(link.data.expires_in).toBe(90);

    const fetched = await fetchLink(link.data.url);
    expect(fetched.status).toBe(200);
    expect(fetched.bytes).toEqual(content);
    expect(fetched.headers.get("content-type")).toContain("text/plain");

    const ranged = await fetchLink(link.data.url, { Range: "bytes=0-4" });
    expect(ranged.status).toBe(206);
    expect(new TextDecoder().decode(ranged.bytes)).toBe("bytes");
  });

  it("caps a link's lifetime at seven days", async () => {
    const content = new TextEncoder().encode("a week at most");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.ok).toBe(true);
    const link = await client.getBlobUrl(upload.data.hash, 10_000_000);
    expect(link.status).toBe(200);
    expect(link.data.expires_in).toBe(7 * 24 * 60 * 60);
  });

  it("refuses a link that has expired or was altered", async () => {
    const content = new TextEncoder().encode("a link that stops working");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.ok).toBe(true);

    // The altered link's witness: the link as minted fetches the bytes.
    const live = await client.getBlobUrl(upload.data.hash, 60);
    expect(live.status).toBe(200);
    const served = await fetchLink(live.data.url);
    expect(served.status).toBe(200);
    expect(served.bytes).toEqual(content);

    // Its own witness first, with seconds to spare for a store's link, which
    // may stop up to a second short of `expires_in`.
    const short = await client.getBlobUrl(upload.data.hash, 3);
    expect(short.status).toBe(200);
    expect(short.data.expires_in).toBe(3);
    const alive = await fetchLink(short.data.url);
    expect(alive.status).toBe(200);
    expect(alive.bytes).toEqual(content);
    // A signer counts a lifetime from a whole second, so a second more, and
    // a little, covers its rounding either way.
    await new Promise((resolve) =>
      setTimeout(resolve, (short.data.expires_in + 1) * 1000 + 100),
    );
    expectRefused(await fetchLink(short.data.url), content);

    const altered = new URL(live.data.url);
    // The instance signs under `signature`; an object store under SigV4's
    // own name. Whichever it is, one character of it changes.
    const name = altered.searchParams.has("signature")
      ? "signature"
      : "X-Amz-Signature";
    const signature = altered.searchParams.get(name) ?? "";
    expect(signature.length).toBeGreaterThan(0);
    altered.searchParams.set(
      name,
      (signature.startsWith("0") ? "1" : "0") + signature.slice(1),
    );
    expectRefused(await fetchLink(altered.toString()), content);
  });

  it("answers 404 for a link to an unknown hash and 400 for a malformed one", async () => {
    const content = new TextEncoder().encode("a hash the instance knows");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.ok).toBe(true);
    expect((await client.getBlobUrl(upload.data.hash)).status).toBe(200);
    const unknown = await client.getBlobUrl(`sha256:${"0".repeat(64)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("blob_not_found");
    const malformed = await client.getBlobUrl("not-a-hash");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
  });

  it("refuses a malformed hash and an empty upload", async () => {
    const one = await uploadReferenced(
      client,
      ctx,
      new Uint8Array([1]),
      "text/plain",
    );
    expect(one.status).toBe(201);
    expect((await client.downloadBlob(one.data.hash)).status).toBe(200);
    const malformed = await client.downloadBlob("not-a-hash");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
    const empty = await client.uploadBlob(new Uint8Array(0), "text/plain");
    expect(empty.status).toBe(400);
    expect(empty.error?.error.code).toBe("validation_error");
  });

  it("takes a bare 64-character hash on every hash operation and refuses any other malformed one", async () => {
    const content = bytesOf("a hash sent without its prefix");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;
    const bare = hash.slice("sha256:".length);

    const bytes = await client.downloadBlob(bare);
    expect(bytes.status).toBe(200);
    expect(new Uint8Array(bytes.data)).toEqual(content);
    // The answer names the blob by its full hash, so the bare form was read
    // as the prefixed one and not as a second blob.
    const head = await client.headBlob(bare);
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(`"${hash}"`);
    const link = await client.getBlobUrl(bare);
    expect(link.status).toBe(200);
    expect((await fetchLink(link.data.url)).bytes).toEqual(content);
    const locations = await client.listBlobLocations(bare);
    expect(locations.status).toBe(200);
    expect(locations.data.data.length).toBeGreaterThan(0);

    const malformed = [
      bare.slice(1),
      `${bare}0`,
      bare.toUpperCase(),
      `sha256:${bare.toUpperCase()}`,
      `SHA256:${bare}`,
      `sha512:${bare}`,
      `sha256:${bare.slice(1)}`,
      "not-a-hash",
    ];
    for (const form of malformed) {
      const got = await client.downloadBlob(form);
      expect(got.status, `GET ${form}`).toBe(400);
      expect(got.error?.error.code, `GET ${form}`).toBe("validation_error");
      expect((await client.headBlob(form)).status, `HEAD ${form}`).toBe(400);
      const url = await client.getBlobUrl(form);
      expect(url.status, `url ${form}`).toBe(400);
      expect(url.error?.error.code, `url ${form}`).toBe("validation_error");
      const where = await client.listBlobLocations(form);
      expect(where.status, `locations ${form}`).toBe(400);
      expect(where.error?.error.code, `locations ${form}`).toBe(
        "validation_error",
      );
    }
  });

  it("records the media type without its parameters, keeps its case and takes octet-stream where none is sent", async () => {
    const cases: { sent: string | undefined; recorded: string }[] = [
      { sent: "text/plain", recorded: "text/plain" },
      { sent: "text/plain; charset=utf-8", recorded: "text/plain" },
      {
        sent: "text/plain ;charset=utf-8; format=flowed",
        recorded: "text/plain",
      },
      { sent: "Image/PNG", recorded: "Image/PNG" },
      { sent: undefined, recorded: "application/octet-stream" },
    ];
    for (const [index, { sent, recorded }] of cases.entries()) {
      const label = `${sent ?? "no content type"} (${String(index)})`;
      const content = bytesOf(`typed ${label}`);
      const upload = await call("POST", "/blobs", {
        body: content,
        headers: sent === undefined ? {} : { "Content-Type": sent },
      });
      expect(upload.status, label).toBe(201);
      const answered = JSON.parse(new TextDecoder().decode(upload.bytes)) as {
        hash: string;
        mime_type: string;
      };
      expect(answered.mime_type, label).toBe(recorded);

      await referenceBlob(client, ctx, answered.hash);
      const served = await client.downloadBlob(answered.hash);
      expect(served.headers.get("content-type"), label).toBe(recorded);
      expect(new Uint8Array(served.data), label).toEqual(content);
    }
  });

  it("stores a body of any non-multipart type as the bytes it is", async () => {
    const bodies = [
      { type: "application/json", words: "not json at all {" },
      { type: "application/x-www-form-urlencoded", words: "a=b&c=d" },
      { type: "application/octet-stream", words: "\u0000\u0001 binary-ish" },
    ];
    for (const { type, words } of bodies) {
      const content = bytesOf(words);
      const upload = await uploadReferenced(client, ctx, content, type);
      expect(upload.status, type).toBe(201);
      expect(upload.data.mime_type, type).toBe(type);
      expect(upload.data.hash, type).toBe(hashOf(content));
      const served = await client.downloadBlob(upload.data.hash);
      expect(served.headers.get("content-type"), type).toBe(type);
      expect(new Uint8Array(served.data), type).toEqual(content);
    }
  });

  it("answers every upload of the same bytes sent together with the one hash and the one type", async () => {
    // Two megabytes, so the requests are in flight together and not one
    // after another.
    const content = new Uint8Array(2 * 1_048_576);
    content.set(bytesOf("sent eight times at once"));
    for (let i = 4093; i < content.length; i += 4093) content[i] = i & 0xff;
    const types = ["text/plain", "application/octet-stream"];

    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        client.uploadBlob(content, types[i % types.length]!),
      ),
    );
    for (const answer of answers) {
      expect(answer.status, JSON.stringify(answer.error)).toBe(201);
      expect(answer.data.hash).toBe(hashOf(content));
      expect(answer.data.size_bytes).toBe(content.byteLength);
    }
    // Whichever request got there first fixed the type, and every answer
    // names that one.
    const recorded = new Set(answers.map((answer) => answer.data.mime_type));
    expect(recorded.size).toBe(1);
    const [fixed] = [...recorded];
    expect(types).toContain(fixed);

    const hash = hashOf(content);
    await referenceBlob(client, ctx, hash);
    const served = await client.downloadBlob(hash);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe(fixed);
    expect(hashOf(new Uint8Array(served.data))).toBe(hash);
    // One blob, one row per store holding it.
    const locations = (await client.listBlobLocations(hash)).data.data;
    expect(new Set(locations.map((row) => row.store_id)).size).toBe(
      locations.length,
    );
  });

  it("serves a range open at the end or running past it, and refuses one that starts past the end or ends before it starts", async () => {
    const upload = await uploadReferenced(
      client,
      ctx,
      new TextEncoder().encode("0123456789"),
      "text/plain",
    );
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;

    const ranged = async (range: string) =>
      call("GET", `/blobs/${hash}`, { headers: { Range: range } });
    const text = (answered: Answered) =>
      new TextDecoder().decode(answered.bytes);

    const open = await ranged("bytes=4-");
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(open.headers.get("content-length")).toBe("6");
    expect(text(open)).toBe("456789");

    // The last byte is in the blob, the first one past it is not.
    const last = await ranged("bytes=9-");
    expect(last.status).toBe(206);
    expect(last.headers.get("content-range")).toBe("bytes 9-9/10");
    expect(text(last)).toBe("9");
    expect((await ranged("bytes=10-")).status).toBe(416);

    const clamped = await ranged("bytes=7-99");
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(text(clamped)).toBe("789");

    // A range that ends where it starts is the smallest there is; one that
    // ends before it starts is refused.
    const single = await ranged("bytes=5-5");
    expect(single.status).toBe(206);
    expect(text(single)).toBe("5");
    for (const range of ["bytes=5-2", "bytes=10-", "bytes=10-12"]) {
      const refused = await ranged(range);
      expect(refused.status, range).toBe(416);
      expect(refused.headers.get("content-range"), range).toBe("bytes */10");
      expect(refused.error?.code, range).toBe("range_not_satisfiable");
      expect(refused.error?.details?.size_bytes, range).toBe(10);
    }
  });

  it("serves the whole blob for a Range it does not read", async () => {
    const upload = await uploadReferenced(
      client,
      ctx,
      new TextEncoder().encode("0123456789"),
      "text/plain",
    );
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;
    // The witness: a range it does read answers a part.
    const part = await call("GET", `/blobs/${hash}`, {
      headers: { Range: "bytes=0-3" },
    });
    expect(part.status).toBe(206);

    for (const range of [
      "bytes=-3",
      "bytes=0-1,3-4",
      "items=0-3",
      "bytes=a-b",
      "bytes=0-99999999999999999999",
      "bytes=99999999999999999999-",
    ]) {
      const whole = await call("GET", `/blobs/${hash}`, {
        headers: { Range: range },
      });
      expect(whole.status, range).toBe(200);
      expect(whole.headers.get("content-range"), range).toBeNull();
      expect(new TextDecoder().decode(whole.bytes), range).toBe("0123456789");
    }
  });

  it("answers HEAD with a Range as GET would, headers only", async () => {
    const upload = await uploadReferenced(
      client,
      ctx,
      new TextEncoder().encode("0123456789"),
      "text/plain",
    );
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;

    const part = await call("HEAD", `/blobs/${hash}`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-length")).toBe("4");
    expect(part.bytes.length).toBe(0);

    const open = await client.headBlob(hash, { Range: "bytes=4-" });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 4-9/10");

    const refused = await client.headBlob(hash, { Range: "bytes=10-12" });
    expect(refused.status).toBe(416);
    expect(refused.headers.get("content-range")).toBe("bytes */10");

    const whole = await client.headBlob(hash, { Range: "bytes=-3" });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe("10");
    expect(whole.headers.get("content-range")).toBeNull();
  });

  it("refuses a query key a blob operation does not declare and ignores one that starts with an underscore", async () => {
    const content = bytesOf("a request with a stray query key");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;

    // The witness for each: the same request with a key of the caller's own
    // is served.
    const own = "_own=1";
    expect((await call("GET", `/blobs/${hash}?${own}`)).status).toBe(200);
    expect((await call("HEAD", `/blobs/${hash}?${own}`)).status).toBe(200);
    expect((await call("GET", `/blobs/${hash}/url?${own}`)).status).toBe(200);
    expect((await call("GET", `/blobs/${hash}/locations?${own}`)).status).toBe(
      200,
    );

    const stray = "bogus=1";
    for (const [method, path] of [
      ["GET", `/blobs/${hash}?${stray}`],
      ["HEAD", `/blobs/${hash}?${stray}`],
      ["GET", `/blobs/${hash}/url?ttl=60&${stray}`],
      ["GET", `/blobs/${hash}/locations?${stray}`],
    ] as const) {
      const refused = await call(method, path);
      expect(refused.status, `${method} ${path}`).toBe(400);
      // A HEAD answer has no body to carry the code.
      if (method === "GET") {
        expect(refused.error?.code, path).toBe("validation_error");
        expect(refused.error?.details?.unknown_parameters, path).toEqual([
          "bogus",
        ]);
      }
    }

    // An upload takes no query at all, and stores nothing when it is refused.
    const fresh = bytesOf("sent with a stray query key");
    const refusedUpload = await call("POST", `/blobs?${stray}`, {
      body: fresh,
    });
    expect(refusedUpload.status).toBe(400);
    expect(refusedUpload.error?.code).toBe("validation_error");
    expect(refusedUpload.error?.details?.unknown_parameters).toEqual(["bogus"]);
    expect((await getOperatorClient().headBlob(hashOf(fresh))).status).toBe(
      404,
    );
    const accepted = await call("POST", `/blobs?${own}`, { body: fresh });
    expect(accepted.status).toBe(201);
  });

  it("gives a link an hour when no ttl is asked for, takes every whole number of seconds up to the cap and refuses any other", async () => {
    const upload = await uploadReferenced(
      client,
      ctx,
      bytesOf("a link whose lifetime is asked for"),
      "text/plain",
    );
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;

    const defaulted = await client.getBlobUrl(hash);
    expect(defaulted.status).toBe(200);
    expect(defaulted.data.expires_in).toBe(3600);

    // The smallest lifetime asked for is given, the cap is the most, and
    // one past the cap is answered with the cap.
    for (const [asked, given] of [
      [1, 1],
      [604_800, 604_800],
      [604_801, 604_800],
    ] as const) {
      const link = await client.getBlobUrl(hash, asked);
      expect(link.status, String(asked)).toBe(200);
      expect(link.data.expires_in, String(asked)).toBe(given);
    }

    for (const ttl of ["0", "-1", "1.5", "abc", ""]) {
      const refused = await call("GET", `/blobs/${hash}/url?ttl=${ttl}`);
      expect(refused.status, `ttl=${ttl}`).toBe(400);
      expect(refused.error?.code, `ttl=${ttl}`).toBe("validation_error");
    }
  });
});
