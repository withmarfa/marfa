import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BulkActionWorker } from "../bulk-actions/index.js";
import type { BulkActionJob } from "../bulk-actions/types.js";

/**
 * `POST /items/bulk-actions` with `update_properties` asks the strict-mode
 * lever as every other item write door does, of the patch the caller sent,
 * per row of a type the lever names, and when the job writes rather than
 * when it was queued.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(async () => {
  await setConfig({});
});

interface ErrorEntry {
  id: string;
  code: string;
  message: string;
  details?: { code?: string };
}

async function setConfig(config: Record<string, unknown>): Promise<void> {
  const res = await request(ctx.app, "PUT", "/config", {
    key: ctx.workingKey,
    body: config,
  });
  expect(res.status).toBe(200);
}

const STRICT_NOTES = { enforcement: { strict_mode: { types: ["core.note"] } } };

function marker(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed(
  tag: string,
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type, properties, tags: [tag] },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function propertiesOf(id: string): Promise<Record<string, unknown>> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return (
    (await res.json()) as { item: { properties: Record<string, unknown> } }
  ).item.properties;
}

async function patchByTag(
  tag: string,
  patch: Record<string, unknown>,
  key = ctx.workingKey,
): Promise<{ succeeded: number; errors: ErrorEntry[] }> {
  const { initialStatus, result } = await runBulkActionAsync(
    ctx,
    { action: "update_properties", patch, filter: { tags: [tag] } },
    key,
  );
  expect(initialStatus).toBe(202);
  return {
    succeeded: result?.succeeded ?? 0,
    errors: result?.errors ?? [],
  };
}

/** A key whose own override names `core.note` strictly. */
async function mintStrictKey(
  tag: string,
): Promise<{ id: string; key: string }> {
  const minted = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: {
      label: tag,
      source: tag,
      default_tier: "feed",
      type_permissions: { "core.note": "write" },
      extension_permissions: {},
      edge_permissions: {},
      enforcement_override: STRICT_NOTES.enforcement,
    },
  });
  expect(minted.status).toBe(201);
  return (await minted.json()) as { id: string; key: string };
}

async function drain(): Promise<void> {
  const worker = new BulkActionWorker({
    storage: ctx.storage,
    chunkSize: 100,
    pollIntervalMs: 1,
  });
  while (await worker.runOnce()) {
    /* drain */
  }
}

describe("the bulk-action door asks the strict-mode lever", () => {
  it("refuses each row of a type the lever names, and writes the rest", async () => {
    const tag = marker("bastrict");
    const note = await seed(tag, "core.note", { body: "before" });
    // A type the lever does not name, matched by the same filter: the
    // refusal is per row of a named type, not for the job.
    const bookmark = await seed(tag, "core.bookmark", {
      url: "https://example.com/",
    });
    await setConfig(STRICT_NOTES);

    const outcome = await patchByTag(tag, { not_a_real_field: "x" });

    expect(outcome.succeeded).toBe(1);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]?.id).toBe(note);
    expect(outcome.errors[0]?.code).toBe("invalid_properties");
    expect(outcome.errors[0]?.details?.code).toBe("unknown_property");
    expect(await propertiesOf(note)).toEqual({ body: "before" });
    expect((await propertiesOf(bookmark)).not_a_real_field).toBe("x");
  });

  it("applies a patch naming only declared properties, to a row already carrying an undeclared one", async () => {
    const tag = marker("badeclared");
    const note = await seed(tag, "core.note", {
      body: "before",
      carried_from_before: "kept",
    });
    await setConfig(STRICT_NOTES);

    const outcome = await patchByTag(tag, { title: "set" });

    expect(outcome.errors).toEqual([]);
    expect(outcome.succeeded).toBe(1);
    expect(await propertiesOf(note)).toEqual({
      body: "before",
      title: "set",
      carried_from_before: "kept",
    });
  });

  it("asks the lever of the credential that queued the job", async () => {
    const tag = marker("baoverride");
    const note = await seed(tag, "core.note", { body: "before" });
    const { key } = await mintStrictKey(tag);

    const outcome = await patchByTag(tag, { not_a_real_field: "x" }, key);

    expect(outcome.succeeded).toBe(0);
    expect(outcome.errors[0]?.details?.code).toBe("unknown_property");
    expect(await propertiesOf(note)).toEqual({ body: "before" });
  });

  it("writes nothing for a strict key revoked while its job is queued", async () => {
    // With the instance lever off, only the key's override refuses the
    // patch, so a job that lost the key and asked the instance alone would
    // write it.
    const tag = marker("barevoked");
    const note = await seed(tag, "core.note", { body: "before" });
    const { id: keyId, key } = await mintStrictKey(tag);
    const queued = await request(ctx.app, "POST", "/items/bulk-actions", {
      key,
      body: {
        action: "update_properties",
        patch: { not_a_real_field: "x" },
        filter: { tags: [tag] },
      },
    });
    expect(queued.status).toBe(202);
    const { id } = (await queued.json()) as BulkActionJob;
    const revoked = await request(ctx.app, "DELETE", `/keys/${keyId}`, {
      key: ctx.workingKey,
    });
    expect(revoked.status).toBeLessThan(300);

    await drain();

    const job = await ctx.storage.bulkActionJobs.getById(id);
    expect(job?.status).toBe("failed");
    expect(await propertiesOf(note)).toEqual({ body: "before" });
  });

  it("asks when the job writes, so a lever set while it is queued holds", async () => {
    const tag = marker("baqueued");
    const note = await seed(tag, "core.note", { body: "before" });
    const queued = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      body: {
        action: "update_properties",
        patch: { not_a_real_field: "x" },
        filter: { tags: [tag] },
      },
    });
    expect(queued.status).toBe(202);
    const { id } = (await queued.json()) as BulkActionJob;

    await setConfig(STRICT_NOTES);
    await drain();

    const read = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${id}`,
      {
        key: ctx.workingKey,
      },
    );
    const job = (await read.json()) as BulkActionJob;
    expect(job.status).toBe("completed");
    const errors = (job.result?.errors ?? []) as ErrorEntry[];
    expect(errors[0]?.details?.code).toBe("unknown_property");
    expect(await propertiesOf(note)).toEqual({ body: "before" });
  });

  it("takes the undeclared property with the lever off", async () => {
    const tag = marker("baoff");
    const note = await seed(tag, "core.note", { body: "before" });

    const outcome = await patchByTag(tag, { not_a_real_field: "x" });

    expect(outcome.errors).toEqual([]);
    expect((await propertiesOf(note)).not_a_real_field).toBe("x");
  });
});
