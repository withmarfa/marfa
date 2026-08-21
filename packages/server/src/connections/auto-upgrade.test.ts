/**
 * The pass that moves connections onto the manifest their deployment ships.
 *
 * Two properties carry the whole thing, and each has a case that fails
 * without it: a non-widening move happens with nobody asked, and a widening
 * one still does not. Around those sit the reasons a move is held back for
 * something other than consent, which have to be visible rather than
 * silent — a pass that skipped quietly would be the defect class it exists
 * to close.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { registerIntegrationManifest } from "../integrations/register-manifest.js";
import {
  assessConnection,
  surveyConnectionDrift,
  applyNonWideningUpgrades,
} from "./auto-upgrade.js";

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
  return `acme/auto-${String(seq)}`;
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
    description: "auto-upgrade test",
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

/** Register v1 and v2, install a connection against v1. */
async function scenario(options: {
  v1?: Partial<IntegrationManifest>;
  v2?: Partial<IntegrationManifest>;
  connectionProperties?: Record<string, unknown>;
  /** Omit v2 entirely, so the connection is already current. */
  onlyV1?: boolean;
}): Promise<{ name: string; connection: Item }> {
  const name = nextName();
  const v1 = await registerIntegrationManifest(
    ctx.storage,
    manifest(name, options.v1 ?? {}),
    undefined,
  );
  if (options.onlyV1 !== true) {
    await registerIntegrationManifest(
      ctx.storage,
      manifest(name, { version: "2.0.0", ...(options.v2 ?? {}) }),
      undefined,
    );
  }
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
        ...(options.connectionProperties ?? {}),
      },
    },
    undefined,
  );
  return { name, connection };
}

async function refetch(id: string): Promise<Item> {
  const row = await ctx.storage.items.get(id, undefined);
  if (!row) throw new Error(`connection ${id} vanished`);
  return row;
}

describe("assessConnection", () => {
  it("calls a connection on the newest version current", async () => {
    const s = await scenario({ onlyV1: true });
    const drift = await assessConnection(ctx.storage, s.connection);
    expect(drift.disposition).toBe("current");
    expect(drift.to_version).toBeNull();
  });

  it("calls a non-widening move upgradable", async () => {
    const s = await scenario({});
    const drift = await assessConnection(ctx.storage, s.connection);
    expect(drift.disposition).toBe("upgradable");
    expect(drift.from_version).toBe("1.0.0");
    expect(drift.to_version).toBe("2.0.0");
  });

  it("calls a widening move awaiting_consent", async () => {
    const s = await scenario({
      v2: { target_types: ["core.note", "core.bookmark"] },
    });
    const drift = await assessConnection(ctx.storage, s.connection);
    expect(drift.disposition).toBe("awaiting_consent");
  });

  it("calls a trigger addition upgradable, not awaiting_consent", async () => {
    // The ruling, exercised through the pass rather than the diff: a
    // trigger changes when an integration runs, not what it reaches.
    const s = await scenario({
      v2: {
        triggers: [
          { type: "schedule", config: { cron: "0 * * * *" } },
          { type: "manual" },
        ],
      },
    });
    const drift = await assessConnection(ctx.storage, s.connection);
    expect(drift.disposition).toBe("upgradable");
  });
});

describe("assessConnection — a stored mapping is not stranded", () => {
  const mapping = {
    version: 1 as const,
    otherwise: "family" as const,
    rules: [
      {
        when: { path: "kind", op: "equals" as const, value: "link" },
        target_type: "core.bookmark",
        assign: { title: { path: "subject" } },
      },
    ],
  };

  it("blocks when the new manifest drops mapping support and a mapping is stored", async () => {
    const s = await scenario({
      v1: { supports_user_mappings: true },
      v2: { supports_user_mappings: false },
      connectionProperties: { mapping },
    });
    const drift = await assessConnection(ctx.storage, s.connection);
    expect(drift.disposition).toBe("blocked");
    expect(drift.blocked_reason).toBe("mapping_would_be_stranded");
  });

  it("does not block when no mapping is stored", async () => {
    // Dropping a capability nobody exercised takes nothing from anybody.
    const s = await scenario({
      v1: { supports_user_mappings: true },
      v2: { supports_user_mappings: false },
    });
    const drift = await assessConnection(ctx.storage, s.connection);
    expect(drift.disposition).toBe("upgradable");
  });

  it("does not block when the new manifest keeps mapping support", async () => {
    const s = await scenario({
      v1: { supports_user_mappings: true },
      v2: { supports_user_mappings: true },
      connectionProperties: { mapping },
    });
    const drift = await assessConnection(ctx.storage, s.connection);
    expect(drift.disposition).toBe("upgradable");
  });
});

describe("applyNonWideningUpgrades", () => {
  it("moves a non-widening connection with nobody asked", async () => {
    const s = await scenario({});

    const report = await applyNonWideningUpgrades(ctx.storage);

    expect(
      report.upgraded.some((u) => u.connection_id === s.connection.id),
    ).toBe(true);
    const after = await refetch(s.connection.id);
    const drift = await assessConnection(ctx.storage, after);
    expect(drift.disposition).toBe("current");
  });

  it("leaves a widening connection where it is", async () => {
    const s = await scenario({
      v2: { target_types: ["core.note", "core.bookmark"] },
    });

    await applyNonWideningUpgrades(ctx.storage);

    const after = await refetch(s.connection.id);
    const drift = await assessConnection(ctx.storage, after);
    expect(drift.disposition).toBe("awaiting_consent");
    expect(drift.from_version).toBe("1.0.0");
  });

  it("writes an activity row naming the version move", async () => {
    // Never silently, or this becomes the defect it is fixing.
    const s = await scenario({});

    await applyNonWideningUpgrades(ctx.storage);

    const activity = await ctx.storage.items.list({
      type: "system.activity",
      limit: 200,
    });
    const row = activity.data.find(
      (a) =>
        (a.properties as { connection_id?: string }).connection_id ===
        s.connection.id,
    );
    expect(row).toBeDefined();
    expect((row?.properties as { summary?: string }).summary).toContain(
      "1.0.0",
    );
    expect((row?.properties as { summary?: string }).summary).toContain(
      "2.0.0",
    );
  });

  it("leaves a blocked connection alone and counts it", async () => {
    const s = await scenario({
      v1: { supports_user_mappings: true },
      v2: { supports_user_mappings: false },
      connectionProperties: {
        mapping: {
          version: 1 as const,
          otherwise: "family" as const,
          rules: [
            {
              when: { path: "kind", op: "equals" as const, value: "link" },
              target_type: "core.bookmark",
              assign: { title: { path: "subject" } },
            },
          ],
        },
      },
    });

    const report = await applyNonWideningUpgrades(ctx.storage);

    expect(report.blocked).toBeGreaterThan(0);
    expect(
      report.upgraded.some((u) => u.connection_id === s.connection.id),
    ).toBe(false);
    const after = await refetch(s.connection.id);
    expect(
      (after.properties as { integration_ref?: string }).integration_ref,
    ).toBe(
      (s.connection.properties as { integration_ref?: string }).integration_ref,
    );
  });

  it("is idempotent — a second pass moves nothing", async () => {
    await scenario({});
    await applyNonWideningUpgrades(ctx.storage);
    const second = await applyNonWideningUpgrades(ctx.storage);
    expect(second.upgraded).toEqual([]);
  });
});

describe("surveyConnectionDrift", () => {
  it("counts what it sees, and the counts add up", async () => {
    const { summary, connections } = await surveyConnectionDrift(ctx.storage);
    expect(summary.live).toBe(connections.length);
    expect(summary.behind).toBe(
      summary.upgradable + summary.awaiting_consent + summary.blocked,
    );
  });

  it("reports a revoked connection nowhere", async () => {
    // Drift is a question about live connections. A revoked one is not
    // behind, it is gone, and counting it would make the number never
    // reach zero for a different reason than the one being fixed.
    const s = await scenario({});
    await ctx.storage.items.transition(s.connection.id, "revoked", undefined);

    const { connections } = await surveyConnectionDrift(ctx.storage);
    expect(connections.some((c) => c.connection_id === s.connection.id)).toBe(
      false,
    );
  });
});
