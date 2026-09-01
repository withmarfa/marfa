/**
 * The round trip D34 exists for: uninstall an integration, reinstall it,
 * and a re-synced upstream record lands on the item already there rather
 * than forking the corpus under a fresh Connection-keyed source. The
 * pre-fix behavior is attested by live staging data — four distinct
 * connection-uuid sources for one integration family — which the source
 * rewrite migration retires.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { performInstall } from "./install-pipeline.js";
import { performUninstall } from "./uninstall-pipeline.js";
import { runtimeCredentialItemSource } from "./lifecycle-lock.js";
import { hashApiKey } from "../middleware/auth.js";
import type { IntegrationManifest } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const MANIFEST: IntegrationManifest = {
  name: "acme/readopt",
  version: "1.0.0",
  publisher: "acme",
  description: "reinstall adoption test",
  direction: "read",
  triggers: [{ type: "manual" }],
  target_types: ["core.note"],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  webhook_verification: { method: "hmac-sha256" },
  manifest_schema_version: "2.0.0",
};

async function install(): Promise<string> {
  const adminKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.role === "instance_admin"));
  if (!adminKey) throw new Error("admin key not found in test ctx");
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: MANIFEST.name,
        manifest_version: MANIFEST.version,
        publisher: MANIFEST.publisher,
        direction: MANIFEST.direction,
        manifest: MANIFEST,
        registered_at: new Date().toISOString(),
      },
      source: `readopt-reg-${String(Date.now())}-${String(Math.random())}`,
      source_id: `readopt-reg-${String(Math.random())}`,
    },
    undefined,
  );
  const result = await performInstall(ctx.storage, {
    apiKeyId: adminKey.id,
    spaceId: undefined,
    authMode: "keys",
    integrationItemId: integration.id,
    manifest: MANIFEST,
    clientIp: null,
  });
  return result.connection_id;
}

async function mintRuntimeKey(
  connectionId: string,
  generation: number,
): Promise<string> {
  const rawKey = `marfa_k1_readopt_${String(generation)}_${String(Math.random()).slice(2)}`;
  await ctx.storage.keys.createRuntimeCredential(
    {
      label: `readopt-runtime-${String(generation)}`,
      source: `readopt-runtime-${String(generation)}-${String(Math.random()).slice(2)}`,
      role: "member",
      type_permissions: { "core.note": "write" },
      connection_id: connectionId,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      item_source: runtimeCredentialItemSource(MANIFEST),
    },
    hashApiKey(rawKey, "test-salt"),
    undefined,
  );
  return rawKey;
}

describe("install refuses configuration outside the declared contract", () => {
  async function tryInstall(
    manifest: IntegrationManifest,
    configuration: Record<string, unknown>,
  ): Promise<unknown> {
    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "instance_admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: manifest.name,
          manifest_version: manifest.version,
          publisher: manifest.publisher,
          direction: manifest.direction,
          manifest,
          registered_at: new Date().toISOString(),
        },
        source: `cfg-reg-${String(Math.random()).slice(2)}`,
        source_id: `cfg-reg-${String(Math.random()).slice(2)}`,
      },
      undefined,
    );
    return performInstall(ctx.storage, {
      apiKeyId: adminKey.id,
      spaceId: undefined,
      authMode: "keys",
      integrationItemId: integration.id,
      manifest,
      clientIp: null,
      configuration,
    });
  }

  it("refuses an undeclared key", async () => {
    await expect(
      tryInstall(
        { ...MANIFEST, name: "acme/cfg-undeclared" },
        { bogus_key: "x" },
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("refuses a missing required key and a wrong-typed one", async () => {
    const declaring: IntegrationManifest = {
      ...MANIFEST,
      name: "acme/cfg-declared",
      manifest_schema_version: "2.0.0",
      configuration_schema: {
        feed_url: {
          type: "string",
          description: "The feed to poll.",
          required: true,
        },
        max_entries: { type: "number", description: "Ingest ceiling." },
      },
    };
    await expect(
      tryInstall(declaring, { max_entries: 10 }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      tryInstall(declaring, {
        feed_url: "https://x.example/feed",
        max_entries: "ten",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      tryInstall(declaring, {
        feed_url: "https://x.example/feed",
        max_entries: 10,
      }),
    ).resolves.toMatchObject({ connection_id: expect.any(String) as string });
  });
});

describe("reinstall adopts what the integration already synced", () => {
  it("resolves the same item across uninstall and reinstall", async () => {
    const firstConnection = await install();
    const firstKey = await mintRuntimeKey(firstConnection, 1);

    const created = await request(ctx.app, "POST", "/items", {
      key: firstKey,
      body: {
        type: "core.note",
        source_id: "upstream-rec-1",
        properties: { body: "first sync" },
      },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { item: { id: string } };

    // The precondition D63 adds, and without it the case below tests the
    // wrong thing. Adoption over a *recorded, dead* writer and adoption
    // over a *null* writer take different arms of the guard, and only the
    // first is what a reinstall actually meets. Asserting the stamp landed
    // is what tells the two apart.
    expect(
      (await ctx.storage.items.writersOf([createdBody.item.id])).get(
        createdBody.item.id,
      ),
    ).toBe(firstConnection);

    const adminKey = await ctx.storage.keys
      .list()
      .then((keys) => keys.find((k) => k.role === "instance_admin"));
    if (!adminKey) throw new Error("admin key not found in test ctx");
    await performUninstall(ctx.storage, {
      apiKeyId: adminKey.id,
      connectionId: firstConnection,
      spaceId: undefined,
      clientIp: null,
    });

    const secondConnection = await install();
    expect(secondConnection).not.toBe(firstConnection);
    const secondKey = await mintRuntimeKey(secondConnection, 2);

    // The same upstream record re-syncs through the fresh Connection. The
    // natural-key pair must resolve the row the first generation wrote:
    // an update, never a second copy.
    const resynced = await request(ctx.app, "POST", "/items", {
      key: secondKey,
      body: {
        type: "core.note",
        source_id: "upstream-rec-1",
        properties: { body: "second sync" },
      },
    });
    expect(resynced.status).toBe(200);
    const resyncedBody = (await resynced.json()) as { item: { id: string } };
    expect(resyncedBody.item.id).toBe(createdBody.item.id);

    // Adopted, and re-stamped onto the connection that now owns it (D63).
    // The refusal is on liveness rather than on difference precisely so
    // this path stays open: the first connection is gone, so its rows are
    // the second's to take. Drop that qualifier and this answers 409.
    expect(
      (await ctx.storage.items.writersOf([createdBody.item.id])).get(
        createdBody.item.id,
      ),
    ).toBe(secondConnection);

    const list = await request(
      ctx.app,
      "GET",
      "/items?source_id=upstream-rec-1",
      { key: secondKey },
    );
    const listBody = (await list.json()) as { data: { id: string }[] };
    const matches = listBody.data.filter(
      (i) => i.id === createdBody.item.id,
    ).length;
    expect(listBody.data.length).toBe(matches);
    expect(matches).toBe(1);
  });
});
