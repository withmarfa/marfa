/**
 * One refusal, one code, on every door that writes an item's properties.
 *
 * A durable client's failure classification is closed and keys on the code:
 * a schema refusal is permanent, and a code it does not recognize falls
 * through to transient and retries forever. So a split here is not a
 * cosmetic inconsistency — a client taught one code retries a refused write
 * until it hits its ceiling, and a client taught the other treats unrelated
 * validation failures as permanent and dead-letters writes it should have
 * retried.
 *
 * `invalid_properties` is the code, on every door. `validation_error` stays
 * what it always was: the generic refusal for everything that is not a
 * properties-versus-type mismatch, which several of these doors also raise
 * for their own reasons.
 *
 * One payload drives every door but the last, so the table cannot be
 * satisfied by doors that disagree about what they were asked. The retype
 * arm is the exception: its payload is bad by naming a destination the row
 * cannot satisfy rather than by carrying a value of the wrong shape, because
 * that is the only way to be refused for moving somewhere.
 *
 * This docblock used to say the bulk update arm ran no property validation
 * at all and so had no code to compare. That was true and is not: the arm
 * validated only on a move, and a same-type entry went to the store unjudged.
 * It is a row in the table now, driven by the same payload as the rest.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  runBulkActionAsync,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { runtimeCredentialItemSource } from "../connections/lifecycle-lock.js";

let ctx: TestContext;

const CONNECTION_ID = "conn_properties_refusal";
const ITEM_SOURCE = runtimeCredentialItemSource({ name: CONNECTION_ID });
const RUNTIME_KEY = "marfa_k1_test_properties_refusal";

/** `core.note` declares `body` as a required string, so a number is a
 *  properties-versus-type refusal at every door and nothing else. */
const BAD = { body: 12345 };
const GOOD = { body: "well formed" };

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.storage.keys.createRuntimeCredential(
    {
      label: "properties-refusal",
      source: "properties-refusal",
      type_permissions: { "*": "write" },
      connection_id: CONNECTION_ID,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      item_source: ITEM_SOURCE,
    },
    hashApiKey(RUNTIME_KEY, TEST_API_KEY_SALT),
    ctx.spaceId,
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

let seq = 0;
const uniq = (p: string): string =>
  `${p}-${String(++seq)}-${String(Date.now())}`;

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? "(no code)";
}

async function makeNote(): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: { type: "core.note", properties: GOOD },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

interface BulkEntryResult {
  outcome: string;
  error?: { code: string };
}

async function bulkEntryOutcome(
  items: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Promise<BulkEntryResult> {
  const res = await request(ctx.app, "POST", "/items/bulk", {
    key: ctx.spaceKey,
    body: { atomic: false, ...extra, items },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { results: BulkEntryResult[] };
  const first = body.results[0];
  expect(first, "one entry in, one result out").toBeDefined();
  return first!;
}

async function bulkEntryCode(
  items: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await bulkEntryOutcome(items, extra);
  expect(result.outcome, JSON.stringify(result)).toBe("errored");
  return result.error?.code ?? "(no code)";
}

/**
 * Each door, driven through the same bad payload, answering with the code it
 * gives a properties-versus-type refusal. The refusal is per-entry rather
 * than per-response on `POST /items/bulk`, which reports each item's own.
 */
const doors: { name: string; refuse: () => Promise<string> }[] = [
  {
    name: "POST /items creates",
    refuse: async () =>
      errorCode(
        await request(ctx.app, "POST", "/items", {
          key: ctx.spaceKey,
          body: { type: "core.note", properties: BAD },
        }),
      ),
  },
  {
    name: "PATCH /items/{id} updates",
    refuse: async () =>
      errorCode(
        await request(ctx.app, "PATCH", `/items/${await makeNote()}`, {
          key: ctx.spaceKey,
          body: { properties: BAD },
        }),
      ),
  },
  {
    name: "POST /items upserts onto a new natural key",
    refuse: async () =>
      errorCode(
        await request(ctx.app, "POST", "/items", {
          key: RUNTIME_KEY,
          body: {
            type: "core.note",
            properties: BAD,
            source_id: uniq("upsert-create"),
          },
        }),
      ),
  },
  {
    name: "POST /items upserts onto an existing natural key",
    refuse: async () => {
      const sourceId = uniq("upsert-update");
      const seeded = await request(ctx.app, "POST", "/items", {
        key: RUNTIME_KEY,
        body: { type: "core.note", properties: GOOD, source_id: sourceId },
      });
      expect(seeded.status).toBe(201);
      return errorCode(
        await request(ctx.app, "POST", "/items", {
          key: RUNTIME_KEY,
          body: { type: "core.note", properties: BAD, source_id: sourceId },
        }),
      );
    },
  },
  {
    // `atomic: false`, which defaults on: an atomic batch answers
    // `bulk_atomic_rollback` at the envelope and reports no per-entry code
    // at all, so the code this table is about is only observable in the
    // mode that reports each entry on its own.
    name: "POST /items/bulk creates",
    refuse: async () =>
      bulkEntryCode([
        { type: "core.note", properties: BAD, source_id: uniq("bulk-create") },
      ]),
  },
  {
    name: "POST /items/bulk updates without moving",
    refuse: async () => {
      const sourceId = uniq("bulk-update");
      await bulkEntryOutcome([
        { type: "core.note", properties: GOOD, source_id: sourceId },
      ]);
      return bulkEntryCode([
        { type: "core.note", properties: BAD, source_id: sourceId },
      ]);
    },
  },
  {
    name: "POST /items/bulk-actions updates properties by filter",
    refuse: async () => {
      const marker = uniq("bulk-action");
      const seeded = await request(ctx.app, "POST", "/items", {
        key: RUNTIME_KEY,
        body: { type: "core.note", properties: GOOD, tags: [marker] },
      });
      expect(seeded.status).toBe(201);
      const { result } = await runBulkActionAsync(
        ctx,
        {
          action: "update_properties",
          patch: BAD,
          filter: { tags: [marker] },
        },
        RUNTIME_KEY,
      );
      return result?.errors?.[0]?.code ?? "no error reported";
    },
  },
  {
    name: "POST /items/bulk moves a row to a type it does not satisfy",
    refuse: async () => {
      const sourceId = uniq("bulk-retype");
      await bulkEntryOutcome([
        { type: "core.note", properties: GOOD, source_id: sourceId },
      ]);
      // `core.event` requires `title`, which the note has never carried, so
      // the merged result is invalid at the destination.
      return bulkEntryCode(
        [{ type: "core.event", properties: {}, source_id: sourceId }],
        { retype: true },
      );
    },
  },
];

describe("a properties-versus-type refusal", () => {
  for (const door of doors) {
    it(`is invalid_properties on ${door.name}`, async () => {
      expect(await door.refuse()).toBe("invalid_properties");
    });
  }

  it("is the same code on every door", async () => {
    const codes = new Map<string, string>();
    for (const door of doors) {
      codes.set(door.name, await door.refuse());
    }
    expect(new Set(codes.values()).size, JSON.stringify([...codes])).toBe(1);
  });
});

describe("the generic refusal", () => {
  it("still answers for a refusal that is not about properties", async () => {
    // Nothing here narrows `validation_error` out of existence: the tag
    // bound on the same door is one of several refusals that are genuinely
    // generic, and moving them too would leave the specific code meaning
    // nothing in particular.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: GOOD,
        tags: Array.from({ length: 101 }, (_, i) => `t${String(i)}`),
      },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_error");
  });
});
