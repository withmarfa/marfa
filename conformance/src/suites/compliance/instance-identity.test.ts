import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";
import { readEntry } from "../../utils/archive.js";

/** The shape `generateId` mints, which is what the identity is. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "instance-identity",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the instance's identity", () => {
  it("names itself the same way at the root, at /config and in an archive", async () => {
    // One identity, three doors, and the third is the one the first two
    // cannot stand in for: the manifest is written into a file nothing
    // echoes back, so an export that recorded a different name — or none —
    // would go unnoticed by every assertion made over HTTP.
    //
    // A credential-less read of the root is deliberate. The identity is how
    // a caller pointed at an address tells this deployment from another one
    // answering the same shape, which is a question asked before any key
    // exists.
    const bare = await fetch(`${apiUrl}/`);
    expect(bare.status).toBe(200);
    const root = (await bare.json()) as { instance_id: string };
    expect(root.instance_id).toMatch(UUID_V7);

    const config = await client.getConfig();
    expect(config.ok).toBe(true);
    expect((config.data as { instance_id: string }).instance_id).toBe(
      root.instance_id,
    );
    // The same value is a UUIDv7 at the other two doors, whether or not the
    // equality above holds the shape.
    expect((config.data as { instance_id: string }).instance_id).toMatch(
      UUID_V7,
    );

    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.ok).toBe(true);
    const raw = readEntry(archive.data, "manifest.json");
    expect(raw).not.toBeNull();
    const manifest = JSON.parse(raw as string) as {
      version: number;
      instance_id: string;
    };
    // The witness. Without it a reader that silently returned the wrong
    // member, or an empty one, would satisfy the identity assertion below
    // for the wrong reason.
    expect(manifest.version).toBe(0);
    expect(manifest.instance_id).toBe(root.instance_id);
    expect(manifest.instance_id).toMatch(UUID_V7);
  });
});
