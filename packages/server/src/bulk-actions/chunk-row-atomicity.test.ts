/**
 * A row a bulk-action chunk reports errored has written nothing.
 *
 * A chunk runs its rows inside one transaction and reports each row's
 * failure rather than failing the chunk, so a row whose write fails part-way
 * must be undone on its own: caught inside the shared transaction with
 * nothing of its own to roll back, whatever it wrote before the failure
 * commits with the rest. The failure is injected at the last write of each
 * row, the only position from which its earlier writes have happened.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { runChunk } from "./index.js";
import { resolveLiveCredential } from "../auth/live-credential.js";
import type { LiveCredential } from "../auth/live-credential.js";

let ctx: TestContext;
let credential: LiveCredential;

beforeAll(async () => {
  ctx = await createTestContext();
  const current = await request(ctx.app, "GET", "/keys/current", {
    key: ctx.workingKey,
  });
  const resolved = await resolveLiveCredential(
    ctx.storage,
    ((await current.json()) as { id: string }).id,
    { tokenOutlivesExpiry: true },
  );
  if (!resolved) throw new Error("the working key does not resolve");
  credential = resolved;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function note(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function edge(
  source_id: string,
  target_id: string,
  edge_type: string,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: { source_id, target_id, edge_type },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { edge: { id: string } }).edge.id;
}

/** Make each named method throw where `when` says, and count the throws. */
function breakMethods(
  owner: object,
  names: readonly string[],
  when: (...args: unknown[]) => boolean,
): { fired: () => number; restore: () => void } {
  const target = owner as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  let fired = 0;
  for (const name of names) {
    const original = target[name];
    if (typeof original !== "function") continue;
    originals.set(name, original);
    target[name] = (...args: unknown[]): unknown => {
      if (when(...args)) {
        fired += 1;
        throw new Error(`forced failure at ${name}`);
      }
      return (original as (...a: unknown[]) => unknown).apply(owner, args);
    };
  }
  return {
    fired: () => fired,
    restore: () => {
      for (const [name, original] of originals) target[name] = original;
    },
  };
}

describe("a row that fails inside a bulk-action chunk leaves nothing behind", () => {
  it("purge: the row and its edges stay when the last edge delete fails", async () => {
    const doomed = await note("doomed");
    const pointing = await note("pointing");
    const target = await note("target");
    const inbound = await edge(pointing, doomed, "references");
    const outbound = await edge(doomed, target, "references");
    expect(
      (
        await request(ctx.app, "DELETE", `/items/${doomed}`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);

    const broken = breakMethods(
      ctx.storage.edges,
      ["deleteByTarget", "deleteByTargetBatch"],
      () => true,
    );
    let result;
    try {
      result = await runChunk({
        storage: ctx.storage,
        input: { action: "purge", confirm: "PURGE" },
        ids: [doomed],
        credential,
      });
    } finally {
      broken.restore();
    }

    expect(broken.fired()).toBeGreaterThan(0);
    expect(result.succeeded).toEqual([]);
    expect(result.errors.map((e) => e.id)).toEqual([doomed]);
    expect(await ctx.storage.items.getIncludingTrashed(doomed)).not.toBeNull();
    expect(await ctx.storage.edges.get(outbound)).not.toBeNull();
    expect(await ctx.storage.edges.get(inbound)).not.toBeNull();
  });

  it("transition into the bin: what the cascade took comes back when the row's own move fails", async () => {
    const parent = await note("parent");
    const child = await note("child");
    await edge(parent, child, "parent-of");

    const broken = breakMethods(
      ctx.storage.items,
      ["delete", "transition"],
      (id) => id === parent,
    );
    let result;
    try {
      result = await runChunk({
        storage: ctx.storage,
        input: { action: "transition", state: "trashed" },
        ids: [parent],
        credential,
      });
    } finally {
      broken.restore();
    }

    expect(broken.fired()).toBeGreaterThan(0);
    expect(result.succeeded).toEqual([]);
    expect(result.errors.map((e) => e.id)).toEqual([parent]);
    expect((await ctx.storage.items.get(parent))?.state).toBe("active");
    expect((await ctx.storage.items.get(child))?.state).toBe("active");
  });
});
