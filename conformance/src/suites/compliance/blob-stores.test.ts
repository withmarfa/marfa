import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getManagementClient,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { uploadReferenced } from "../../utils/blobs.js";

let client: MarfaClient;
let ctx: TestContext;

/** One of the `S3_*` values the run booted the object store with. A run
 *  without them is a run booted without `pnpm garage:up`, which is a
 *  failure here rather than a skip. */
function objectStoreEnv(name: "S3_BUCKET"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for the object-store fixtures: source the env file \`pnpm garage:up\` writes.`,
    );
  }
  return value;
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "blob-stores"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the stores an instance keeps bytes in", () => {
  it("lists the disk store and the object store to the management key", async () => {
    const operator = getManagementClient();
    const stores = await operator.listBlobStores();
    expect(stores.status).toBe(200);
    await expectMatchesSchema("GET", "/blobs/stores", 200, stores.data);

    // Two, and never one: the referee boots the server against an object
    // store beside its disk, so the object-store half of these chapters is
    // asserted rather than skipped. A run that sees one store was booted
    // without `pnpm garage:up`.
    const kinds = stores.data.data.map((store) => store.kind).sort();
    expect(kinds, "boot the server with the object store attached").toEqual([
      "disk",
      "s3",
    ]);
    for (const store of stores.data.data) {
      expect(store.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(store.policy).toBe("all");
      expect(store.detached_at).toBeNull();
      expect(store.locator.length).toBeGreaterThan(0);
    }
    // The locator is the bucket and the prefix the referee booted the store
    // with, and nothing else: an exact match is what leaves no room for a
    // credential in it. The run's own `S3_*` values name them.
    const s3 = stores.data.data.find((store) => store.kind === "s3");
    const prefix = process.env.S3_PREFIX ?? "blobs";
    expect(s3?.locator).toBe(`s3://${objectStoreEnv("S3_BUCKET")}/${prefix}`);
  });

  it("lists each store with the time it was first attached", async () => {
    const stores = await getManagementClient().listBlobStores();
    expect(stores.data.data.length).toBeGreaterThanOrEqual(1);
    for (const store of stores.data.data) {
      expect(Date.parse(store.attached_at)).not.toBeNaN();
      expect(Date.parse(store.attached_at)).toBeLessThanOrEqual(Date.now());
    }
    const again = await getManagementClient().listBlobStores();
    expect(
      again.data.data.map((store) => [store.id, store.attached_at]),
    ).toEqual(stores.data.data.map((store) => [store.id, store.attached_at]));
  });

  it("refuses the listing to a working key", async () => {
    expect((await getManagementClient().listBlobStores()).status).toBe(200);
    const stores = await client.listBlobStores();
    expect(stores.status).toBe(403);
    expect(stores.error?.error.code).toBe("forbidden");
  });

  it("records a new blob's location as the disk store", async () => {
    const content = new TextEncoder().encode("located on the disk first");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.ok).toBe(true);

    const locations = await client.listBlobLocations(upload.data.hash);
    expect(locations.status).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/blobs/{hash}/locations",
      200,
      locations.data,
    );
    const stores = await getManagementClient().listBlobStores();
    const disk = stores.data.data.find((store) => store.kind === "disk");
    // The upload woke replication and the run's other files run the
    // integrity check, so with an object store attached its copy can land,
    // and the disk copy be stamped, between the upload and this read. The
    // case that asserts the one unverified location is on an instance of its
    // own with no object store (`blob-store-folders.test.ts`).
    expect(locations.data.data).toContainEqual(
      expect.objectContaining({
        store_id: disk?.id,
        kind: "disk",
        policy: "all",
        detached: false,
      }),
    );
    expect(
      locations.data.data.filter((row) => row.kind === "disk"),
    ).toHaveLength(1);
  });

  it("answers 404 for the locations of an unknown hash and 400 for a malformed one", async () => {
    const content = new TextEncoder().encode("a hash with locations");
    const upload = await uploadReferenced(client, ctx, content, "text/plain");
    expect(upload.ok).toBe(true);
    expect((await client.listBlobLocations(upload.data.hash)).status).toBe(200);
    const unknown = await client.listBlobLocations(`sha256:${"0".repeat(64)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("blob_not_found");
    const malformed = await client.listBlobLocations("not-a-hash");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
  });
});
