/**
 * Moving a connection onto a newer manifest.
 *
 * Four properties matter here and each has a test that would fail without
 * it: consent gates a widening move, cursor state survives, both frozen
 * copies move together, and the runtime credential is revoked so the next
 * mint reprojects from the manifest the connection now resolves.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, TEST_API_KEY_SALT } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { registerIntegrationManifest } from "../integrations/register-manifest.js";
import { hashApiKey } from "../middleware/auth.js";
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
    manifest_schema_version: "2.0.0",
    publisher: "acme",
    description: "upgrade test",
    direction: "read",
    triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
    target_types: ["core.note"],
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

  it("applies the pinned version rather than the newest registered one", async () => {
    // What the approval route depends on. It checks the candidate against
    // the version a person was shown, then calls this; without the pin the
    // pipeline re-resolves the newest at apply time, so a version
    // registered in between is what actually lands, carrying a consent
    // nobody gave it. The pipeline re-previews inside a lock it may wait
    // on, so that window is not a matter of microseconds.
    const s = await scenario({ target_types: ["core.note", "core.bookmark"] });
    await registerIntegrationManifest(
      ctx.storage,
      manifest(s.name, {
        version: "3.0.0",
        target_types: ["core.note", "core.bookmark", "core.task"],
      }),
      undefined,
    );
    const result = await performUpgrade(ctx.storage, {
      ...caller,
      connectionId: s.connection.id,
      targetIntegrationItemId: s.v2.id,
      consentedToWidening: true,
    });

    expect(result.to.manifest_version).toBe("2.0.0");
    expect(result.integration_ref).toBe(s.v2.id);
    const after = await ctx.storage.items.get(s.connection.id, undefined);
    expect(after?.properties.integration_ref).toBe(s.v2.id);
  });

  it("refuses a pin that is not newer than what the connection resolves", async () => {
    // The pin exists so an approval lands on the version a person read.
    // Without a version check it also lets one land on an older version:
    // something else upgrades the connection while the approval waits on
    // the lifecycle lock, and the pinned row is now behind. That move
    // narrows rather than widens, so the consent gate says nothing about
    // it, and the connection walks backwards with its credentials revoked.
    const s = await scenario({});
    await performUpgrade(ctx.storage, {
      ...caller,
      connectionId: s.connection.id,
    });
    const now = await ctx.storage.items.get(s.connection.id, undefined);
    expect(now?.properties.integration_ref).toBe(s.v2.id);

    await expect(
      performUpgrade(ctx.storage, {
        ...caller,
        connectionId: s.connection.id,
        targetIntegrationItemId: s.v1.id,
      }),
    ).rejects.toMatchObject({ code: "no_newer_version" });

    const after = await ctx.storage.items.get(s.connection.id, undefined);
    expect(after?.properties.integration_ref).toBe(s.v2.id);
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

// ---------------------------------------------------------------------------
// Hosted mode.
//
// Every case above runs `spaceId: undefined` against a deployment where
// nothing carries a space, so the credential revocation below — the half of
// the acceptance that says a runtime credential stops carrying the old
// manifest's permissions — has never been exercised against a fence that
// narrows anything.
// ---------------------------------------------------------------------------

describe("performUpgrade — hosted mode", () => {
  let hosted: TestContext;

  beforeAll(async () => {
    hosted = await createTestContext({ authMode: "hosted" });
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  /** Two registered versions, a connection in its own space bound to the
   *  first, and a runtime credential carrying that space. */
  async function hostedScenario(): Promise<{
    spaceId: string;
    connection: Item;
    credentialId: string;
    v2: Item;
  }> {
    const name = nextName();
    const space = await hosted.storage.spaces!.create(
      `upgrade-${Math.random().toString(36).slice(2, 8)}`,
    );
    // The catalog rows carry no space, as they do on a live deployment:
    // they are registered by a platform credential and read through the
    // widening.
    const v1 = await registerIntegrationManifest(
      hosted.storage,
      manifest(name),
      undefined,
    );
    const v2 = await registerIntegrationManifest(
      hosted.storage,
      manifest(name, { version: "2.0.0" }),
      undefined,
    );
    const connection = await hosted.storage.items.create(
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
      space.id,
    );
    const suffix = Math.random().toString(36).slice(2, 10);
    const credential = await hosted.storage.keys.createRuntimeCredential(
      {
        label: `upgrade runtime ${suffix}`,
        source: `integration:${connection.id}`,
        role: "member",
        type_permissions: { "core.note": "write" },
        connection_id: connection.id,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        item_source: "integration:acme/upgrade",
      },
      hashApiKey(`marfa_k1_upgrade_${suffix}`, TEST_API_KEY_SALT),
      space.id,
    );
    return {
      spaceId: space.id,
      connection,
      credentialId: credential.id,
      v2: v2.item,
    };
  }

  it("revokes the space's runtime credential on a space-scoped upgrade", async () => {
    const s = await hostedScenario();

    const result = await performUpgrade(hosted.storage, {
      apiKeyId: "key-under-test",
      spaceId: s.spaceId,
      connectionId: s.connection.id,
    });

    expect(result.revoked_credential_ids).toEqual([s.credentialId]);
    expect(
      (await hosted.storage.keys.listForSpace(s.spaceId)).find(
        (k) => k.id === s.credentialId,
      ),
    ).toBeUndefined();
  });

  it("revokes it when a platform admin drives the upgrade", async () => {
    // Same mismatch the uninstall path has: a platform admin carries no
    // space, so the pipeline resolves the connection unfenced and then has
    // to find credentials that all carry the connection's space. Leaving
    // them live is worse here than on uninstall, because they keep working
    // against an upgraded connection while carrying the permissions the
    // old manifest projected.
    const s = await hostedScenario();

    const result = await performUpgrade(hosted.storage, {
      apiKeyId: "key-under-test",
      spaceId: undefined,
      connectionId: s.connection.id,
    });

    expect(result.integration_ref).toBe(s.v2.id);
    expect(result.revoked_credential_ids).toEqual([s.credentialId]);
    expect(
      (await hosted.storage.keys.listForSpace(s.spaceId)).find(
        (k) => k.id === s.credentialId,
      ),
    ).toBeUndefined();
  });

  it("reports no revocation when the credential was already retired", async () => {
    // The supersede path revokes a connection's older credentials on every
    // mint, so an upgrade routinely arrives with nothing left to retire.
    // Reporting one anyway is the same defect in the other direction.
    const s = await hostedScenario();
    expect(await hosted.storage.keys.revoke(s.credentialId)).toBe(true);

    const result = await performUpgrade(hosted.storage, {
      apiKeyId: "key-under-test",
      spaceId: s.spaceId,
      connectionId: s.connection.id,
    });

    expect(result.revoked_credential_ids).toEqual([]);
  });
});
