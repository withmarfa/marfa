/**
 * An `Idempotency-Key` belongs to the credential that sent it.
 *
 * Two credentials choosing keys independently, from a counter or a clock,
 * will sooner or later choose the same one. Each must be answered about its
 * own request: neither refused because the other spent the key, nor handed
 * the other's stored answer, which can name rows it may not read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BulkActionWorker } from "../bulk-actions/worker.js";

let ctx: TestContext;
let other: string;

beforeAll(async () => {
  ctx = await createTestContext();
  other = await mintWorkingKey(ctx);
});

afterAll(async () => {
  await ctx.cleanup();
});

const fresh = (label: string): string =>
  `${label}-${Math.random().toString(36).slice(2, 10)}`;

interface ItemBody {
  item: { id: string; version: number; properties: Record<string, unknown> };
}

interface JobBody {
  id: string;
  status: string;
  matched: number;
}

async function note(key: string, tag: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body: tag }, tags: [tag] },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as ItemBody).item.id;
}

async function drainWorker(): Promise<void> {
  const worker = new BulkActionWorker({
    storage: ctx.storage,
    chunkSize: 100,
    pollIntervalMs: 1,
  });
  while (await worker.runOnce()) {
    /* keep draining */
  }
}

describe("two credentials using one key value", () => {
  it("each create their own row, and neither is a replay", async () => {
    const k = fresh("shared-create");
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      headers: { "Idempotency-Key": k },
      body: { type: "core.note", properties: { body: "from the first" } },
    });
    expect(first.status).toBe(201);

    const second = await request(ctx.app, "POST", "/items", {
      key: other,
      headers: { "Idempotency-Key": k },
      body: { type: "core.note", properties: { body: "from the second" } },
    });
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBeNull();
    const a = ((await first.json()) as ItemBody).item;
    const b = ((await second.json()) as ItemBody).item;
    expect(b.id).not.toBe(a.id);
    expect(b.properties.body).toBe("from the second");
  });

  it("never serves one credential the other's stored answer", async () => {
    // The same request from both: under an instance-wide key the second
    // would be the first's replay, carrying a row the second never wrote.
    const k = fresh("shared-same-body");
    const body = { type: "core.note", properties: { body: "one body" } };
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      headers: { "Idempotency-Key": k },
      body,
    });
    const second = await request(ctx.app, "POST", "/items", {
      key: other,
      headers: { "Idempotency-Key": k },
      body,
    });
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBeNull();
    expect(((await second.json()) as ItemBody).item.id).not.toBe(
      ((await first.json()) as ItemBody).item.id,
    );

    // The witness: each credential's own repeat is still a replay.
    const again = await request(ctx.app, "POST", "/items", {
      key: other,
      headers: { "Idempotency-Key": k },
      body,
    });
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("each keep their own losing text when both collide on one row", async () => {
    // The keep-both sibling's id is derived from the key so that a write
    // which runs twice writes one sibling. Derived from the bare key, a
    // second credential's sibling lands on the first's id and its text is
    // lost.
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "original" } },
    });
    const { item } = (await created.json()) as ItemBody;
    const moved = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.workingKey,
      body: { properties: { body: "from the winner" }, version: item.version },
    });
    expect(moved.status).toBe(200);

    const k = fresh("shared-sibling");
    const texts = [fresh("first loser"), fresh("second loser")];
    for (const [i, key] of [ctx.workingKey, other].entries()) {
      const res = await request(
        ctx.app,
        "PATCH",
        `/items/${item.id}?conflict=auto`,
        {
          key,
          headers: { "Idempotency-Key": k },
          body: { properties: { body: texts[i] }, version: item.version },
        },
      );
      expect(res.status).toBe(200);
    }

    const listed = await request(ctx.app, "GET", "/items?limit=200", {
      key: ctx.workingKey,
    });
    const { data } = (await listed.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    const bodies = data.map((row) => row.properties.body);
    expect(bodies).toContain(texts[0]);
    expect(bodies).toContain(texts[1]);
  });
});

describe("the bulk-action door", () => {
  it("runs a second credential's own job under a key the first used", async () => {
    const first = fresh("bulk-first");
    const second = fresh("bulk-second");
    await note(ctx.workingKey, first);
    const theirs = await note(other, second);
    const k = fresh("shared-bulk");

    const a = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      headers: { "Idempotency-Key": k },
      body: {
        action: "update_tags",
        add: ["a-done"],
        filter: { tags: [first] },
      },
    });
    expect(a.status).toBe(202);
    const jobA = (await a.json()) as JobBody;

    const b = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: other,
      headers: { "Idempotency-Key": k },
      body: {
        action: "update_tags",
        add: ["b-done"],
        filter: { tags: [second] },
      },
    });
    expect(b.status).toBe(202);
    expect(b.headers.get("Idempotency-Replayed")).toBeNull();
    const jobB = (await b.json()) as JobBody;
    expect(jobB.id).not.toBe(jobA.id);

    await drainWorker();
    const read = await request(ctx.app, "GET", `/items/${theirs}/metadata`, {
      key: other,
    });
    const { metadata } = (await read.json()) as {
      metadata: { tags: string[] };
    };
    expect(metadata.tags).toContain("b-done");

    // And the job it was handed is its own to read.
    const status = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${jobB.id}`,
      { key: other },
    );
    expect(status.status).toBe(200);
  });

  it("refuses one credential's different request under a key it used", async () => {
    const tag = fresh("bulk-reuse");
    await note(ctx.workingKey, tag);
    const k = fresh("bulk-reused");
    const first = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      headers: { "Idempotency-Key": k },
      body: { action: "update_tags", add: ["once"], filter: { tags: [tag] } },
    });
    expect(first.status).toBe(202);

    // The witness: the same request is a replay of the same job.
    const replay = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      headers: { "Idempotency-Key": k },
      body: { action: "update_tags", add: ["once"], filter: { tags: [tag] } },
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await replay.json()) as JobBody).id).toBe(
      ((await first.json()) as JobBody).id,
    );

    const different = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      headers: { "Idempotency-Key": k },
      body: { action: "update_tags", add: ["twice"], filter: { tags: [tag] } },
    });
    expect(different.status).toBe(422);
    expect(different.headers.get("X-Error-Code")).toBe(
      "idempotency_key_reused",
    );
  });
});
