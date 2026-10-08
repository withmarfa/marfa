import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { Housekeeping } from "../housekeeping/scheduler.js";
import type { Storage } from "../storage/interface.js";
import {
  readInstanceConfig,
  writeInstanceConfig,
} from "../storage/instance-config.js";

async function createConfigContext(): Promise<TestContext> {
  return createTestContext();
}

// ----- The shared context: the door's defaults when nothing is set -----
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /config", () => {
  it("401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/config");
    expect(res.status).toBe(401);
  });

  it("carries the identity alone when the config was never set", async () => {
    // An unset config reads as an object carrying only the instance's
    // identity, rather than as null, so a client can merge into what it gets
    // back without a null check.
    const res = await request(ctx.app, "GET", "/config", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["instance_id"]);
    expect(typeof body.instance_id).toBe("string");
  });
});

describe("PUT /config", () => {
  it("401 without credentials", async () => {
    const res = await request(ctx.app, "PUT", "/config", {
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("requires config.manage even from a management key", async () => {
    const res = await request(ctx.app, "PUT", "/config", {
      key: ctx.managementKey,
      body: {},
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details?: { required_scope?: string } };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details?.required_scope).toBe("config.manage");
  });
});

// ----- A second context: the settings-backed round trips -------
describe("Instance config — round trips", () => {
  let configCtx: ConfigContext;

  beforeAll(async () => {
    configCtx = await createConfigContext();
  });

  afterAll(async () => {
    await configCtx.cleanup();
  });

  it("GET returns stored config for a caller holding config.manage", async () => {
    await writeInstanceConfig(configCtx.storage.settings, {
      enforcement: { strict_mode: { types: ["core.note"] } },
    });

    const res = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enforcement?: { strict_mode?: { types: string[] } };
    };
    expect(body.enforcement?.strict_mode?.types).toEqual(["core.note"]);
  });

  it("PUT rejects a negative cleanup-job override with 400", async () => {
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: {
        audit_retention_days: -1,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("PUT persists the retention overrides rather than discarding them", async () => {
    // The housekeeping jobs read these fields, so a value the route accepts
    // and drops is worse than one it refuses: PUT is a full replacement, so
    // following the documentation un-sets the neighbors.
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { audit_retention_days: 30, trash_retention_days: 7 },
    });
    expect(res.status).toBe(200);

    const getRes = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      audit_retention_days?: number;
      trash_retention_days?: number;
    };
    expect(getBody.audit_retention_days).toBe(30);
    expect(getBody.trash_retention_days).toBe(7);
  });

  // The destructive shape, and the reason the schema is strict. PUT is a
  // full replacement, so a key the schema does not know, dropped rather than
  // refused, answers 200 having erased everything the instance had set. A
  // round trip of a well-formed body passes either way, which is why the
  // case below sends a misspelling instead.
  it("PUT refuses a mistyped key instead of dropping it", async () => {
    const good = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { audit_retention_days: 30, trash_retention_days: 7 },
    });
    expect(good.status).toBe(200);

    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { audit_retention_day: 30 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");

    // And the refusal left the instance's config alone, which is the whole
    // point: a refused body must not have been applied.
    const getRes = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    const getBody = (await getRes.json()) as {
      audit_retention_days?: number;
      trash_retention_days?: number;
    };
    expect(getBody.audit_retention_days).toBe(30);
    expect(getBody.trash_retention_days).toBe(7);
  });

  // The outer object refusing an unknown key while the nested one accepts it
  // is the same defect one level down, and `.strict()` does not recurse.
  it("PUT refuses a mistyped key inside enforcement too", async () => {
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { enforcement: { strict_modes: { types: ["core.note"] } } },
    });
    expect(res.status).toBe(400);

    // And one level deeper again, inside a block that does exist.
    const deeper = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { enforcement: { strict_mode: { types: [], typo: 1 } } },
    });
    expect(deeper.status).toBe(400);
  });

  it("PUT persists a valid config and records an audit entry", async () => {
    const config = {
      enforcement: { strict_mode: { types: ["core.note"] } },
      audit_retention_days: 45,
    };
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: config,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof config;
    expect(body.enforcement.strict_mode.types).toEqual(["core.note"]);
    expect(body.audit_retention_days).toBe(45);

    // Round-trip: GET must return the persisted value.
    const getRes = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as typeof config;
    expect(getBody.enforcement.strict_mode.types).toEqual(["core.note"]);
    expect(getBody.audit_retention_days).toBe(45);

    // instead of an inline retry.
    const auditResult = await configCtx.storage.audit.list({
      action: "config.update",
    });
    expect(auditResult.data.length >= 1).toBe(true);
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.resource_type).toBe("config");
  });

  it("takes back the body GET handed over, identity and all", async () => {
    // The use a full-replacement door is actually put to. `instance_id` is
    // in every read, so a client that reads, edits one lever and sends the
    // object back would be refused by the strict write schema if the field
    // were merely unknown to it — and the refusal would look like a typo.
    const read = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    const body = (await read.json()) as Record<string, unknown>;
    expect(typeof body.instance_id).toBe("string");

    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { ...body, audit_retention_days: 31 },
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as Record<string, unknown>;
    expect(echoed.instance_id).toBe(body.instance_id);
    expect(echoed.audit_retention_days).toBe(31);

    // Read from the store, not from the door. `GET /config` spreads the
    // identity over whatever the configuration holds, so a copy persisted
    // into `instance_config` carrying the same value would be invisible on
    // the wire — and would then leave with the next body that omitted it,
    // which is the whole reason the identity lives elsewhere.
    expect(
      await readInstanceConfig(configCtx.storage.settings),
    ).not.toHaveProperty("instance_id");
  });

  it("refuses a body addressed to a different instance", async () => {
    // Dropping the field instead would answer 200 to a write meant for
    // somewhere else, which is what a backup script pointed at the wrong
    // host sends. The identity is not persisted either way, so the refusal
    // is the only thing that can carry the news.
    const before = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    const body = (await before.json()) as Record<string, unknown>;

    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: {
        instance_id: "019537a0-7b80-7000-8000-000000000000",
        audit_retention_days: 7,
      },
    });
    expect(res.status).toBe(400);
    const error = (await res.json()) as {
      error: { code: string; details?: { errors?: { path: string }[] } };
    };
    expect(error.error.code).toBe("validation_error");
    expect(error.error.details?.errors?.[0]?.path).toBe("instance_id");

    // And it changed nothing, which is the half a status code cannot state.
    const after = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(await after.json()).toEqual(body);
  });
});

it("rejects unsupported inbound horizons before saving and restarts at the supported boundaries", async () => {
  const ctx = await createTestContext();
  const scheduler = new Housekeeping(ctx.storage.housekeeping, {
    pollIntervalMs: 1000,
  });
  try {
    const accepted = await request(ctx.app, "PUT", "/config", {
      key: ctx.workingKey,
      body: {
        inbound_handled_retention_days: 36500,
        inbound_pending_retention_days: 36500,
      },
    });
    expect(accepted.status).toBe(200);
    for (const field of [
      "inbound_handled_retention_days",
      "inbound_pending_retention_days",
    ]) {
      const denied = await request(ctx.app, "PUT", "/config", {
        key: ctx.workingKey,
        body: { [field]: 36501 },
      });
      expect(denied.status).toBe(400);
    }
    const saved = (await (
      await request(ctx.app, "GET", "/config", { key: ctx.workingKey })
    ).json()) as {
      inbound_handled_retention_days: number;
      inbound_pending_retention_days: number;
    };
    expect(saved.inbound_handled_retention_days).toBe(36500);
    expect(saved.inbound_pending_retention_days).toBe(36500);
    await expect(
      ctx.storage.inbound.cleanup({ handledDays: 36500, pendingDays: 36500 }),
    ).resolves.toEqual({ deleted: 0, remaining: false });
    await expect(
      ctx.storage.inbound.cleanup({ handledDays: 0, pendingDays: 0 }),
    ).resolves.toEqual({ deleted: 0, remaining: false });
    const stamp = new Date().toISOString();
    await ctx.storage.housekeeping.upsert(
      "owned-boundary",
      2147483647,
      new Date(Date.parse(stamp) + 2147483647).toISOString(),
    );
    await (
      ctx.storage as Storage & {
        __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
      }
    ).__sqliteRun(
      "UPDATE housekeeping SET last_finished_at = ? WHERE name = ?",
      [stamp, "owned-boundary"],
    );
    scheduler.register({
      name: "owned-boundary",
      intervalMs: 2147483647,
      firstRunDelayMs: 0,
      run: () => Promise.resolve({ deleted: 0 }),
    });
    await expect(scheduler.start()).resolves.toBeUndefined();
    const row = (await ctx.storage.housekeeping.list()).find(
      (r) => r.name === "owned-boundary",
    );
    expect(row?.next_run_at).toBe(
      new Date(Date.parse(stamp) + 2147483647).toISOString(),
    );
  } finally {
    await scheduler.stop();
    await ctx.cleanup();
  }
});
