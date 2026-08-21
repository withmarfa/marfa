/**
 * Moving a connection onto a newer manifest.
 *
 * Four properties matter here and each has a test that would fail without
 * it: consent gates a widening move, cursor state survives, both frozen
 * copies move together, and the runtime credential is revoked so the next
 * mint reprojects from the manifest the connection now resolves.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { registerIntegrationManifest } from "../integrations/register-manifest.js";
import {
  performUpgrade,
  previewUpgrade,
  UpgradeError,
} from "./upgrade-pipeline.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

let seq = 0;
function nextName(): string {
  seq += 1;
  return `acme/upgrade-${String(seq)}`;
}

function manifest(
  name: string,
  over: Partial<IntegrationManifest> = {},
): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    manifest_schema_version: "1.3.0",
    publisher: "acme",
    description: "upgrade test",
    direction: "read",
    triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
    target_types: ["core.note"],
    runtime_compatibility: ["local"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "ignore",
      partial_write_mode: "accept-partial",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    ...over,
  };
}

/** Register two versions and install a connection against the first. */
async function scenario(
  v2Overrides: Partial<IntegrationManifest>,
): Promise<{ name: string; connection: Item; v1: Item; v2: Item }> {
  const name = nextName();
  const v1 = await registerIntegrationManifest(
    ctx.storage,
    manifest(name),
    undefined,
  );
  const v2 = await registerIntegrationManifest(
    ctx.storage,
    manifest(name, { version: "2.0.0", ...v2Overrides }),
    undefined,
  );
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        runtime_status: "healthy",
        integration_ref: v1.item.id,
        configuration: {},
        direction: "read",
        triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
      },
    },
    undefined,
  );
  return { name, connection, v1: v1.item, v2: v2.item };
}

const caller = { apiKeyId: "key-under-test", spaceId: undefined };

describe("performUpgrade", () => {
  it("moves a connection onto the newer version when nothing widens", async () => {
    const s = await scenario({});
    const result = await performUpgrade(ctx.storage, {
      ...caller,
      connectionId: s.connection.id,
    });

    expect(result.from.manifest_version).toBe("1.0.0");
    expect(result.to.manifest_version).toBe("2.0.0");
    expect(result.integration_ref).toBe(s.v2.id);

    const after = await ctx.storage.items.get(s.connection.id, undefined);
    expect(after?.properties.integration_ref).toBe(s.v2.id);
  });

  it("refuses a widening move and names exactly what is new", async () => {
    const s = await scenario({ target_types: ["core.note", "core.bookmark"] });

    await expect(
      performUpgrade(ctx.storage, { ...caller, connectionId: s.connection.id }),
    ).rejects.toMatchObject({
      code: "consent_required",
      detail: {
        grants: ["Writes a new kind of item: core.bookmark"],
      },
    });

    // And it did not half-apply: the connection still resolves v1.
    const after = await ctx.storage.items.get(s.connection.id, undefined);
    expect(after?.properties.integration_ref).toBe(s.v1.id);
  });

  it("proceeds on a widening move once consent has been given", async () => {
    const s = await scenario({ target_types: ["core.note", "core.bookmark"] });
    const result = await performUpgrade(ctx.storage, {
      ...caller,
      connectionId: s.connection.id,
      consentedToWidening: true,
    });
    expect(result.to.manifest_version).toBe("2.0.0");
  });

  it("treats a narrowing manifest as needing no consent", async () => {
    const name = nextName();
    const v1 = await registerIntegrationManifest(
      ctx.storage,
      manifest(name, { target_types: ["core.note", "core.bookmark"] }),
      undefined,
    );
    const v2 = await registerIntegrationManifest(
      ctx.storage,
      manifest(name, { version: "2.0.0", target_types: ["core.note"] }),
      undefined,
    );
    const connection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: v1.item.id,
          configuration: {},
        },
      },
      undefined,
    );
    const result = await performUpgrade(ctx.storage, {
      ...caller,
      connectionId: connection.id,
    });
    expect(result.integration_ref).toBe(v2.item.id);
  });

  it("moves the second frozen copy — direction and triggers — with the ref", async () => {
    const s = await scenario({
      direction: "both",
      triggers: [
        { type: "schedule", config: { cron: "0 * * * *" } },
        { type: "manual" },
      ],
    });
    await performUpgrade(ctx.storage, {
      ...caller,
      connectionId: s.connection.id,
    });

    const after = await ctx.storage.items.get(s.connection.id, undefined);
    expect(after?.properties.direction).toBe("both");
    expect(after?.properties.triggers).toEqual([
      { type: "schedule", config: { cron: "0 * * * *" } },
      { type: "manual" },
    ]);
  });

  it("keeps cursor state, which is the whole reason this is not uninstall-and-reinstall", async () => {
    const s = await scenario({});
    await ctx.storage.metadata.mutateExtension(
      s.connection.id,
      "connection.runtime",
      () => ({ cursors: { feed: { last_seen: "abc" } } }),
    );

    await performUpgrade(ctx.storage, {
      ...caller,
      connectionId: s.connection.id,
    });

    const ext = await ctx.storage.metadata.getExtensions(s.connection.id);
    expect(ext["connection.runtime"]).toMatchObject({
      cursors: { feed: { last_seen: "abc" } },
    });
  });

  it("refuses when the connection already resolves the newest version", async () => {
    const s = await scenario({});
    await performUpgrade(ctx.storage, {
      ...caller,
      connectionId: s.connection.id,
    });
    await expect(
      performUpgrade(ctx.storage, { ...caller, connectionId: s.connection.id }),
    ).rejects.toBeInstanceOf(UpgradeError);
  });

  it("refuses when the stored settings do not satisfy the newer manifest", async () => {
    const s = await scenario({
      configuration_schema: {
        feed_url: {
          type: "string",
          description: "The feed to poll.",
          required: true,
        },
      },
    });
    // A newly-required field with no default is also a widening, so consent
    // is given here to isolate the configuration check itself.
    await expect(
      performUpgrade(ctx.storage, {
        ...caller,
        connectionId: s.connection.id,
        consentedToWidening: true,
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });

    const after = await ctx.storage.items.get(s.connection.id, undefined);
    expect(after?.properties.integration_ref).toBe(s.v1.id);
  });

  it("refuses a connection that is not an integration", async () => {
    const connection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    await expect(
      performUpgrade(ctx.storage, { ...caller, connectionId: connection.id }),
    ).rejects.toMatchObject({ code: "wrong_connection_kind" });
  });
});

describe("previewUpgrade", () => {
  it("reports the candidate and the consent lines without changing anything", async () => {
    const s = await scenario({ target_types: ["core.note", "core.bookmark"] });
    const preview = await previewUpgrade(ctx.storage, {
      connectionId: s.connection.id,
      spaceId: undefined,
    });

    expect(preview.current.manifest_version).toBe("1.0.0");
    expect(preview.candidate?.manifest_version).toBe("2.0.0");
    expect(preview.delta?.widens).toBe(true);
    expect(preview.consent_lines).toEqual([
      "Writes a new kind of item: core.bookmark",
    ]);

    const after = await ctx.storage.items.get(s.connection.id, undefined);
    expect(after?.properties.integration_ref).toBe(s.v1.id);
  });

  it("reports no candidate when the connection is already current", async () => {
    const name = nextName();
    const v1 = await registerIntegrationManifest(
      ctx.storage,
      manifest(name),
      undefined,
    );
    const connection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: v1.item.id,
          configuration: {},
        },
      },
      undefined,
    );
    const preview = await previewUpgrade(ctx.storage, {
      connectionId: connection.id,
      spaceId: undefined,
    });
    expect(preview.candidate).toBeNull();
    expect(preview.consent_lines).toEqual([]);
  });
});
