import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { fanOutSchedule } from "./walker.js";
import type { LocalRuntime, SchedulerEnvelope } from "./types.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const MANIFEST_LOCAL = {
  name: "test.walker-local",
  version: "0.0.1",
  publisher: "test",
  description: "Walker test (local-only)",
  manifest_schema_version: "1.0.0",
  direction: "read" as const,
  runtime_compatibility: ["local"],
  target_types: ["core.note"],
  triggers: [{ type: "schedule" as const, config: { cron: "*/1 * * * *" } }],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "all-or-nothing",
  },
  oauth_requirements: {},
  webhook_verification: { method: "hmac-sha256" as const },
};

const MANIFEST_HOSTED_ONLY = {
  ...MANIFEST_LOCAL,
  name: "test.walker-hosted",
  runtime_compatibility: ["hosted"],
};

async function createIntegrationItem(
  manifest: typeof MANIFEST_LOCAL,
): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        publisher: manifest.publisher,
        manifest,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

async function createConnection(opts: {
  integrationItemId: string;
  state?: "active" | "revoked";
  status?: string;
  runtimeStatus?: string;
}): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: opts.status ?? "active",
        ...(opts.runtimeStatus !== undefined && {
          runtime_status: opts.runtimeStatus,
        }),
        integration_ref: opts.integrationItemId,
        granted_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  if (opts.state && opts.state !== "active") {
    await ctx.storage.items.transition(item.id, opts.state, undefined);
  }
  return item.id;
}

function makeStubRuntime(enqueued: SchedulerEnvelope[]): LocalRuntime {
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    enqueue: (envelope) => {
      enqueued.push(envelope);
      return Promise.resolve();
    },
    dispatchForTest: () => Promise.resolve({ ok: true }),
    getRegistration: () => undefined,
  };
}

describe("local-runtime connection walker", () => {
  it("enqueues one schedule message per active local Connection matching the integration", async () => {
    const localId = await createIntegrationItem(MANIFEST_LOCAL);
    const hostedId = await createIntegrationItem(MANIFEST_HOSTED_ONLY);
    const conn1 = await createConnection({ integrationItemId: localId });
    const conn2 = await createConnection({ integrationItemId: localId });
    // Hosted-only integration's Connection must NOT be walked.
    await createConnection({ integrationItemId: hostedId });
    // Revoked Connection must be skipped — the walker only fans out to active Connections.
    await createConnection({ integrationItemId: localId, state: "revoked" });

    const enqueued: SchedulerEnvelope[] = [];
    const runtime = makeStubRuntime(enqueued);

    const count = await fanOutSchedule(
      ctx.storage,
      runtime,
      MANIFEST_LOCAL.name,
      Date.now(),
    );
    expect(count).toBe(2);
    const ids = enqueued.map((e) => e.message.connection_id).sort();
    expect(ids).toEqual([conn1, conn2].sort());
    for (const e of enqueued) {
      expect(e.integration_name).toBe(MANIFEST_LOCAL.name);
      expect(e.message.kind).toBe("schedule");
    }
  });

  it("skips a paused Connection and picks it back up on resume", async () => {
    // Pause is the operator's stop control, and the walker is the
    // schedule's only source on this runtime — if it does not gate here,
    // pause reports success and the connection keeps running (T-627's
    // shape). The gate is the walk itself, so resume needs no re-arm.
    const pauseManifest = { ...MANIFEST_LOCAL, name: "test.walker-paused" };
    const integrationId = await createIntegrationItem(pauseManifest);
    const pausedId = await createConnection({
      integrationItemId: integrationId,
      runtimeStatus: "paused",
    });

    const enqueued: SchedulerEnvelope[] = [];
    const first = await fanOutSchedule(
      ctx.storage,
      makeStubRuntime(enqueued),
      pauseManifest.name,
      Date.now(),
    );
    expect(first).toBe(0);
    expect(enqueued).toHaveLength(0);

    const row = await ctx.storage.items.get(pausedId, undefined);
    await ctx.storage.items.update(
      pausedId,
      { properties: { ...row!.properties, runtime_status: "healthy" } },
      undefined,
    );
    const second = await fanOutSchedule(
      ctx.storage,
      makeStubRuntime(enqueued),
      pauseManifest.name,
      Date.now(),
    );
    expect(second).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.message.connection_id).toBe(pausedId);
  });

  it("does not enqueue anything for an integration with no Connections", async () => {
    const enqueued: SchedulerEnvelope[] = [];
    const runtime = makeStubRuntime(enqueued);
    const count = await fanOutSchedule(
      ctx.storage,
      runtime,
      "does-not-exist",
      Date.now(),
    );
    expect(count).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});
