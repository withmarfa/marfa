/**
 * The order a request to a blob operation meets its refusals in. Each test
 * sends one request that deserves both of two adjacent refusals and asserts
 * the earlier one, with a witness that the later one is producible.
 *
 * The bearer operations meet, in this order: the credential, the standing of
 * the credential for the operation, a query key the operation does not
 * declare, the `ttl` schema, the hash format, and then the read permission
 * and the blob's existence, which answer alike. The instance's link has no
 * credential: it meets an undeclared query key, the query schema, the hash
 * format, the signature and expiry, and then the blob's existence.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse, TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { uploadReferenced } from "../../utils/blobs.js";

let client: MarfaClient;
let operator: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "blob-order",
  ));
  operator = getOperatorClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

let minted = 0;

/** A key of this run's own, holding exactly the type map named. */
async function keyHolding(
  typePermissions: Record<string, string>,
): Promise<MarfaClient> {
  minted += 1;
  const res = await client.createKey({
    label: `blob-order-${String(minted)}`,
    source: `${ctx.source}-${String(minted)}`,
    type_permissions: typePermissions,
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  trackKey(ctx, res.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: res.data.key });
}

/** A well-formed hash no blob holds. */
const UNKNOWN = `sha256:${"e".repeat(64)}`;
const MALFORMED = "not-a-hash";

/** What a refusal says of itself: the status, the code, and the two details
 *  that tell one `validation_error` from another. */
function verdict(res: ApiResponse<unknown>) {
  const details = res.error?.error.details as
    | {
        unknown_parameters?: string[];
        errors?: { path: string }[];
        field?: string;
      }
    | undefined;
  return {
    status: res.status,
    code: res.error?.error.code,
    unknownKeys: details?.unknown_parameters,
    badFields: details?.errors?.map((error) => error.path),
    missing: details?.field,
    message: res.error?.error.message,
  };
}

const STRAY = { status: 400, unknownKeys: ["bogus"] };
const NOT_FOUND = { status: 404, code: "blob_not_found" };
const BAD_TTL = { status: 400, code: "validation_error", badFields: ["ttl"] };
const BAD_HASH = {
  status: 400,
  code: "validation_error",
  message: "Invalid blob hash",
};

/** The three bearer operations that answer a JSON refusal to a read. */
function readings(
  as: MarfaClient,
  hash: string,
  query: string,
): [string, () => Promise<ApiResponse<unknown>>][] {
  const suffix = query === "" ? "" : `?${query}`;
  return [
    ["GET /blobs/{hash}", () => as.downloadBlob(`${hash}${suffix}`)],
    [
      "GET /blobs/{hash}/url",
      () => as.rawRequest(`/blobs/${hash}/url${suffix}`),
    ],
    [
      "GET /blobs/{hash}/locations",
      () => as.rawRequest(`/blobs/${hash}/locations${suffix}`),
    ],
  ];
}

describe("the order a blob operation meets its refusals in", () => {
  it("answers a missing credential before a stray query key", async () => {
    const bare = await fetch(`${apiUrl}/blobs/${UNKNOWN}?bogus=1`);
    expect(verdict(await asResponse(bare))).toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    const bareUpload = await fetch(`${apiUrl}/blobs?bogus=1`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "bytes",
    });
    expect(verdict(await asResponse(bareUpload))).toMatchObject({
      status: 401,
      code: "unauthorized",
    });

    // The witness: with a credential the same requests meet the stray key.
    expect(
      verdict(await client.downloadBlob(`${UNKNOWN}?bogus=1`)),
    ).toMatchObject(STRAY);
  });

  it("refuses a key that reaches no type before a stray query key", async () => {
    const empty = await keyHolding({});
    const reader = await keyHolding({ "core.note": "read" });
    for (const [name, call] of readings(empty, UNKNOWN, "bogus=1")) {
      expect(verdict(await call()), name).toMatchObject({
        status: 403,
        code: "type_not_permitted",
      });
    }
    expect((await empty.headBlob(`${UNKNOWN}?bogus=1`)).status).toBe(403);

    // The witness: a key that reaches a type is told of the stray key, on
    // each of the same operations.
    for (const [name, call] of readings(reader, UNKNOWN, "bogus=1")) {
      expect(verdict(await call()), name).toMatchObject(STRAY);
    }
    expect((await reader.headBlob(`${UNKNOWN}?bogus=1`)).status).toBe(400);
  });

  it("refuses an upload a key may not make before a stray query key", async () => {
    const reader = await keyHolding({ "core.note": "read" });
    const writer = await keyHolding({ "core.note": "write" });
    const bytes = new TextEncoder().encode(`an upload ${ctx.runId}`);
    const upload = (as: MarfaClient) =>
      as.rawRequest("/blobs?bogus=1", {
        method: "POST",
        body: bytes,
        headers: { "Content-Type": "text/plain" },
      });

    const refused = await upload(reader);
    expect(verdict(refused)).toMatchObject({
      status: 403,
      code: "type_not_permitted",
    });
    // The witness: a key that may upload is told of the stray key instead.
    const told = await upload(writer);
    expect(verdict(told)).toMatchObject(STRAY);
    expect(told.error?.error.code).toBe("validation_error");
    // Neither stored the bytes.
    expect((await operator.headBlob(sha256(bytes))).status).toBe(404);
  });

  it("answers a stray query key on an upload before the body it carries", async () => {
    const writer = await keyHolding({ "core.note": "write" });
    for (const [type, body] of [
      ["text/plain", new Uint8Array(0)],
      ["multipart/form-data", new TextEncoder().encode(`a form ${ctx.runId}`)],
    ] as const) {
      const told = await writer.rawRequest("/blobs?bogus=1", {
        method: "POST",
        body,
        headers: { "Content-Type": type },
      });
      expect(verdict(told), type).toMatchObject(STRAY);
      // The witness: without the stray key the body is what is refused.
      const refused = await writer.rawRequest("/blobs", {
        method: "POST",
        body,
        headers: { "Content-Type": type },
      });
      expect(verdict(refused), type).toMatchObject({
        status: 400,
        code: "validation_error",
        unknownKeys: undefined,
      });
    }
  });

  it("answers a stray query key before an unknown hash", async () => {
    // The witness: without the key, the unknown hash is what is answered.
    for (const [name, call] of readings(client, UNKNOWN, "")) {
      expect(verdict(await call()), name).toMatchObject(NOT_FOUND);
    }
    expect((await client.headBlob(UNKNOWN)).status).toBe(404);

    for (const [name, call] of readings(client, UNKNOWN, "bogus=1")) {
      expect(verdict(await call()), name).toMatchObject(STRAY);
    }
    expect((await client.headBlob(`${UNKNOWN}?bogus=1`)).status).toBe(400);
  });

  it("answers a stray query key before a malformed hash", async () => {
    // The witness: without the key, the malformed hash is what is refused.
    for (const [name, call] of readings(client, MALFORMED, "")) {
      expect(verdict(await call()), name).toMatchObject(BAD_HASH);
    }

    for (const [name, call] of readings(client, MALFORMED, "bogus=1")) {
      const told = verdict(await call());
      expect(told, name).toMatchObject(STRAY);
      expect(told.message, name).not.toBe(BAD_HASH.message);
    }
  });

  it("answers a stray query key before a malformed ttl", async () => {
    const link = (query: string) =>
      client.rawRequest(`/blobs/${UNKNOWN}/url?${query}`);
    expect(verdict(await link("ttl=0"))).toMatchObject(BAD_TTL);

    const told = verdict(await link("ttl=0&bogus=1"));
    expect(told).toMatchObject(STRAY);
    expect(told.badFields).toBeUndefined();
  });

  it("answers a malformed ttl before an unknown hash", async () => {
    const link = (query: string) =>
      client.rawRequest(`/blobs/${UNKNOWN}/url${query}`);
    // The witnesses: the same hash with a good ttl, and with none, is unknown.
    expect(verdict(await link(""))).toMatchObject(NOT_FOUND);
    expect(verdict(await link("?ttl=60"))).toMatchObject(NOT_FOUND);

    for (const ttl of ["0", "-1", "1.5", "soon"]) {
      expect(verdict(await link(`?ttl=${ttl}`)), ttl).toMatchObject(BAD_TTL);
    }
  });

  it("answers a malformed ttl before a malformed hash", async () => {
    const link = (query: string) =>
      client.rawRequest(`/blobs/${MALFORMED}/url${query}`);
    // The witness: with a good ttl the malformed hash is what is refused.
    expect(verdict(await link("?ttl=60"))).toMatchObject(BAD_HASH);

    const told = verdict(await link("?ttl=0"));
    expect(told).toMatchObject(BAD_TTL);
    expect(told.message).not.toBe(BAD_HASH.message);
  });

  it("answers a malformed ttl before a blob the key may not read", async () => {
    const upload = await uploadReferenced(
      client,
      ctx,
      new TextEncoder().encode(`a note's blob ${ctx.runId}`),
      "text/plain",
    );
    expect(upload.status).toBe(201);
    const hash = upload.data.hash;
    const noteReader = await keyHolding({ "core.note": "read" });
    const bookmarkReader = await keyHolding({ "core.bookmark": "read" });

    // The witnesses: a note reader is served the link, and a key that
    // reaches only bookmarks is told the blob is unknown.
    expect((await noteReader.getBlobUrl(hash)).status).toBe(200);
    expect(verdict(await bookmarkReader.getBlobUrl(hash))).toMatchObject(
      NOT_FOUND,
    );

    expect(
      verdict(await bookmarkReader.rawRequest(`/blobs/${hash}/url?ttl=0`)),
    ).toMatchObject(BAD_TTL);
  });

  it("answers a malformed hash on an instance link before its signature", async () => {
    const link = await instanceLink("a malformed path");
    const altered = alteredSignature(link.url);
    const at = (hash: string, url: URL) => {
      const copy = new URL(url);
      copy.pathname = `/blobs/${hash}/fetch`;
      return fetch(copy);
    };

    // The witnesses: the altered signature is refused 401 on a well-formed
    // path, and the unaltered link is served.
    expect(await statusOf(fetch(link.url))).toBe(200);
    expect(await statusOf(at(link.hash, altered))).toBe(401);

    const told = await at(MALFORMED, altered);
    expect(told.status).toBe(400);
    expect(verdict(await asResponse(told))).toMatchObject(BAD_HASH);
  });

  it("answers a stray key on an instance link before its signature", async () => {
    const link = await instanceLink("a stray key");
    const altered = alteredSignature(link.url);

    // The witness: the altered signature alone is refused 401.
    expect(await statusOf(fetch(altered))).toBe(401);

    const withStray = new URL(altered);
    withStray.searchParams.set("bogus", "1");
    expect(verdict(await asResponse(await fetch(withStray)))).toMatchObject(
      STRAY,
    );
  });

  it("answers a stray key on an instance link before a malformed hash", async () => {
    const link = await instanceLink("a stray key and a bad hash");
    const malformed = new URL(link.url);
    malformed.pathname = `/blobs/${MALFORMED}/fetch`;
    // The witness: without the key, the hash is what is refused.
    expect(verdict(await asResponse(await fetch(malformed)))).toMatchObject(
      BAD_HASH,
    );

    malformed.searchParams.set("bogus", "1");
    const told = verdict(await asResponse(await fetch(malformed)));
    expect(told).toMatchObject(STRAY);
    expect(told.message).not.toBe(BAD_HASH.message);
  });

  it("answers a stray key on an instance link before a missing query value", async () => {
    const bare = new URL(`${apiUrl}/blobs/${UNKNOWN}/fetch`);
    // The witness: without the key, the missing value is what is refused.
    expect(verdict(await asResponse(await fetch(bare)))).toMatchObject({
      status: 400,
      code: "missing_required_field",
      missing: "expires",
    });

    bare.searchParams.set("bogus", "1");
    expect(verdict(await asResponse(await fetch(bare)))).toMatchObject(STRAY);
  });

  it("answers a missing query value on an instance link before a malformed hash", async () => {
    const link = await instanceLink("a missing value and a bad hash");
    const whole = new URL(link.url);
    whole.pathname = `/blobs/${MALFORMED}/fetch`;
    // The witness: with both values, the hash is what is refused.
    expect(verdict(await asResponse(await fetch(whole)))).toMatchObject(
      BAD_HASH,
    );

    for (const name of ["expires", "signature"]) {
      const partial = new URL(whole);
      partial.searchParams.delete(name);
      expect(
        verdict(await asResponse(await fetch(partial))),
        name,
      ).toMatchObject({
        status: 400,
        code: "missing_required_field",
        missing: name,
      });
    }
  });

  it("answers an altered signature on an instance link before a blob the sweep has purged", async () => {
    const link = await instanceLink("linked, then purged");
    const altered = alteredSignature(link.url);
    expect(await statusOf(fetch(link.url))).toBe(200);

    const id = link.itemId;
    expect((await client.deleteItem(id)).status).toBe(200);
    expect((await client.purgeItem(id)).status).toBe(200);
    await run("blob-orphans");
    await run("blob-orphans");

    // The witness: the link as minted now answers the blob unknown.
    const gone = await fetch(link.url);
    expect(gone.status).toBe(404);
    expect(verdict(await asResponse(gone))).toMatchObject(NOT_FOUND);

    const refused = await fetch(altered);
    expect(refused.status).toBe(401);
    expect(verdict(await asResponse(refused)).code).toBe("unauthorized");
  });
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The status of a `fetch`, its body drained. */
async function statusOf(pending: Promise<Response>): Promise<number> {
  const res = await pending;
  await res.arrayBuffer();
  return res.status;
}

/** A `fetch` answer as the client's own shape, so `verdict` reads it. */
async function asResponse(res: Response): Promise<ApiResponse<unknown>> {
  const body = (await res.json()) as ApiResponse<unknown>["error"];
  return {
    status: res.status,
    data: undefined,
    headers: res.headers,
    ok: res.ok,
    error: body,
  };
}

function alteredSignature(url: string): URL {
  const altered = new URL(url);
  const signature = altered.searchParams.get("signature") ?? "";
  expect(signature.length).toBeGreaterThan(0);
  altered.searchParams.set(
    "signature",
    (signature.startsWith("0") ? "1" : "0") + signature.slice(1),
  );
  return altered;
}

/** Runs a housekeeping job until its door answers; a run the server's own
 *  scheduler holds answers 409 and is asked for again. */
async function run(name: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const res = await operator.runHousekeeping(name);
    if (res.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    expect(res.status, `${name}: ${JSON.stringify(res.error)}`).toBe(200);
    return;
  }
  throw new Error(`${name} was held by a run for five seconds`);
}

/** Runs `blob-replicate` until no store lacks a blob. */
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

/**
 * A link the instance serves itself to bytes a file item names: the object
 * store's copy is made and then dropped, so the link door has only the
 * instance to answer with.
 */
async function instanceLink(
  words: string,
): Promise<{ url: string; hash: string; itemId: string }> {
  const bytes = new TextEncoder().encode(`${words} ${ctx.runId}`);
  const upload = await client.uploadBlob(bytes, "text/plain");
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  const hash = upload.data.hash;
  const file = await client.createItem({
    type: "core.file",
    source: ctx.source,
    properties: { blob_ref: hash, mime_type: "text/plain" },
  });
  expect(file.ok, JSON.stringify(file.error)).toBe(true);
  trackItem(ctx, file.data.item.id);

  await replicateToZero();
  for (const location of (await operator.listBlobLocations(hash)).data.data) {
    if (location.kind !== "s3") continue;
    const dropped = await operator.deleteBlobLocation(hash, location.store_id);
    expect(dropped.status).toBe(200);
  }
  const link = await client.getBlobUrl(hash, 3600);
  expect(link.status).toBe(200);
  expect(new URL(link.data.url).host).toBe(new URL(apiUrl).host);
  return { url: link.data.url, hash, itemId: file.data.item.id };
}
