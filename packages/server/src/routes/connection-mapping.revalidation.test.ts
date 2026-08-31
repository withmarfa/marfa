import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revalidateAndReport } from "../connections/mapping-health.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * A mapping is validated at save and the registry keeps moving underneath
 * it. These cover the two ordinary operations that break one — deleting
 * its target type and changing that type's required fields — and the
 * repair that answers the report.
 */
let ctx: TestContext;

async function seedMappedConnection(name: string): Promise<string> {
  const manifest = {
    name,
    version: "0.1.0",
    manifest_schema_version: "2.0.0",
    publisher: "demo",
    description: "Revalidation fixture integration.",
    direction: "read",
    target_types: ["core.bookmark"],
    triggers: [{ type: "manual" }],
    bidirectional_handling: {
      echo_ttl_seconds: 1,
      lag_window_seconds: 1,
      tombstone_mapping: "ignore",
      partial_write_mode: "accept-partial",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    supports_user_mappings: true,
  };
  const integration = await ctx.storage.items.create({
    type: "system.integration",
    properties: {
      manifest,
      manifest_name: name,
      manifest_version: "0.1.0",
      publisher: "demo",
      summary: manifest.description,
      direction: "read",
      registered_at: new Date().toISOString(),
    },
  });
  const connection = await ctx.storage.items.create({
    type: "system.connection",
    properties: {
      kind: "integration",
      status: "active",
      granted_at: new Date().toISOString(),
      integration_ref: integration.id,
      configuration: {},
      direction: "read",
      triggers: [{ type: "manual" }],
    },
  });
  return connection.id;
}

async function registerType(
  id: string,
  fields: Record<string, unknown>,
  version = 1,
): Promise<void> {
  const res = await request(ctx.app, "POST", "/types", {
    key: ctx.adminKey,
    body: { id, version, fields },
  });
  expect(res.status).toBe(201);
}

async function storeMapping(
  connectionId: string,
  targetType: string,
  assign: Record<string, unknown>,
): Promise<void> {
  const res = await request(
    ctx.app,
    "PUT",
    `/connections/${connectionId}/mapping`,
    {
      key: ctx.adminKey,
      body: {
        version: 1,
        rules: [
          {
            when: { path: "kind", op: "equals", value: "article" },
            target_type: targetType,
            assign,
          },
        ],
      },
    },
  );
  expect(res.status).toBe(200);
}

/** The connection's own activity rows, newest first. */
async function activityFor(connectionId: string): Promise<
  {
    severity: string;
    summary: string;
    detail?: { kind?: string; type_id?: string; change?: string };
  }[]
> {
  const page = await ctx.storage.items.list({
    type: "system.activity",
    limit: 100,
  });
  return page.data
    .filter((row) => row.properties.connection_id === connectionId)
    .map(
      (row) =>
        row.properties as unknown as {
          severity: string;
          summary: string;
          detail?: { kind?: string };
        },
    );
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a type change revalidates the mappings that name it", () => {
  it("reports the mapping a type deletion breaks, and still deletes", async () => {
    const connectionId = await seedMappedConnection("demo/deleted-target");
    await registerType("user.doomed_log", {
      title: { type: "string", required: true },
    });
    await storeMapping(connectionId, "user.doomed_log", {
      title: { path: "title" },
    });

    const deleted = await request(ctx.app, "DELETE", "/types/user.doomed_log", {
      key: ctx.adminKey,
    });
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as {
      ok: boolean;
      broken_mappings: { connection_id: string; issues: { field: string }[] }[];
    };

    // The delete succeeds. Reporting is not refusing.
    expect(body.ok).toBe(true);
    expect(body.broken_mappings).toHaveLength(1);
    expect(body.broken_mappings[0]?.connection_id).toBe(connectionId);
    // The same sentence the save-time refusal gives, naming the rule.
    expect(body.broken_mappings[0]?.issues.map((i) => i.field)).toContain(
      "rules.0.target_type",
    );

    const rows = await activityFor(connectionId);
    const break_ = rows.find((r) => r.detail?.kind === "mapping_broken");
    expect(break_?.severity).toBe("action_required");
    expect(break_?.detail?.change).toBe("deleted");
    expect(break_?.detail?.type_id).toBe("user.doomed_log");
  });

  it("reports a mapping the type's new required field leaves uncovered", async () => {
    const connectionId = await seedMappedConnection("demo/widened-target");
    await registerType("user.widening_log", {
      title: { type: "string", required: true },
    });
    await storeMapping(connectionId, "user.widening_log", {
      title: { path: "title" },
    });

    // An additive change: the mapping still parses and still names a type
    // that exists, and its coverage no longer holds.
    const updated = await request(ctx.app, "PUT", "/types/user.widening_log", {
      key: ctx.adminKey,
      body: {
        version: 2,
        fields: {
          title: { type: "string", required: true },
          source_url: { type: "string", required: true },
        },
      },
    });
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as {
      broken_mappings: { connection_id: string; issues: { field: string }[] }[];
    };
    expect(body.broken_mappings).toHaveLength(1);
    expect(body.broken_mappings[0]?.issues.map((i) => i.field)).toContain(
      "rules.0.assign.source_url",
    );

    const rows = await activityFor(connectionId);
    expect(
      rows.find((r) => r.detail?.kind === "mapping_broken")?.detail?.change,
    ).toBe("updated");
  });

  it("leaves a mapping that does not name the changed type alone", async () => {
    const connectionId = await seedMappedConnection("demo/unrelated-target");
    await registerType("user.kept_log", {
      title: { type: "string", required: true },
    });
    await registerType("user.other_log", {
      title: { type: "string", required: true },
    });
    await storeMapping(connectionId, "user.kept_log", {
      title: { path: "title" },
    });

    const deleted = await request(ctx.app, "DELETE", "/types/user.other_log", {
      key: ctx.adminKey,
    });
    expect(deleted.status).toBe(200);
    expect(
      ((await deleted.json()) as { broken_mappings: unknown[] })
        .broken_mappings,
    ).toHaveLength(0);
    expect(
      (await activityFor(connectionId)).filter(
        (r) => r.detail?.kind === "mapping_broken",
      ),
    ).toHaveLength(0);
  });

  it("closes the break when the mapping is repaired", async () => {
    const connectionId = await seedMappedConnection("demo/repaired-target");
    await registerType("user.repair_log", {
      title: { type: "string", required: true },
    });
    await storeMapping(connectionId, "user.repair_log", {
      title: { path: "title" },
    });

    await request(ctx.app, "PUT", "/types/user.repair_log", {
      key: ctx.adminKey,
      body: {
        version: 2,
        fields: {
          title: { type: "string", required: true },
          author: { type: "string", required: true },
        },
      },
    });
    expect(
      (await activityFor(connectionId)).filter(
        (r) => r.detail?.kind === "mapping_broken",
      ),
    ).toHaveLength(1);

    // The repair: assign the field the widened type now requires.
    await storeMapping(connectionId, "user.repair_log", {
      title: { path: "title" },
      author: { path: "author" },
    });

    const rows = (await activityFor(connectionId)).filter(
      (r) => r.detail?.kind === "mapping_broken",
    );
    // Downgraded, not deleted: the break did happen and the row still says
    // so. Only its surfacing changes.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe("info");
    expect(rows[0]?.summary).toContain("no longer valid");
  });

  it("closes the break when the mapping is cleared instead of repaired", async () => {
    const connectionId = await seedMappedConnection("demo/cleared-target");
    await registerType("user.cleared_log", {
      title: { type: "string", required: true },
    });
    await storeMapping(connectionId, "user.cleared_log", {
      title: { path: "title" },
    });
    await request(ctx.app, "DELETE", "/types/user.cleared_log", {
      key: ctx.adminKey,
    });
    expect(
      (await activityFor(connectionId)).filter(
        (r) => r.detail?.kind === "mapping_broken",
      ),
    ).toHaveLength(1);

    const cleared = await request(
      ctx.app,
      "DELETE",
      `/connections/${connectionId}/mapping`,
      { key: ctx.adminKey },
    );
    expect(cleared.status).toBe(200);
    expect(
      (await activityFor(connectionId))
        .filter((r) => r.detail?.kind === "mapping_broken")
        .map((r) => r.severity),
    ).toEqual(["info"]);
  });
});

describe("a check that could not run", () => {
  it("answers null rather than an empty list, and does not throw", async () => {
    // The registry can hold a chain no write path produces any more, and
    // reading it is enough to throw. The type change has already landed by
    // the time this runs, so failing the request would answer a successful
    // mutation with an error because the commentary on it failed.
    const failing = {
      items: {
        list: () => {
          throw new Error("type chain unresolvable");
        },
      },
      audit: { log: () => Promise.resolve() },
    } as unknown as Parameters<typeof revalidateAndReport>[0];

    const result = await revalidateAndReport(failing, undefined, {
      typeId: "user.whatever",
      change: "deleted",
    });

    // Null, not []. An empty list means the check ran and found nothing;
    // this check established nothing at all, and saying so is the point.
    expect(result).toBeNull();
  });

  it("records the failure where a missing report is findable", async () => {
    const logged: { action: string }[] = [];
    const failing = {
      items: {
        list: () => {
          throw new Error("boom");
        },
      },
      audit: {
        log: (entry: { action: string }) => {
          logged.push(entry);
          return Promise.resolve();
        },
      },
    } as unknown as Parameters<typeof revalidateAndReport>[0];

    await revalidateAndReport(failing, undefined, {
      typeId: "user.whatever",
      change: "updated",
    });

    expect(logged.map((e) => e.action)).toContain(
      "connection.mapping_revalidation_failed",
    );
  });
});
