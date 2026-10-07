/**
 * Conformance for what the two bulk item operations refuse by size or reach:
 * the entry cap, the body cap, the match caps of a bulk action, the keys a
 * bulk action does not declare, and who may read a job.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  BulkActionInput,
  BulkActionJob,
  BulkActionResponse,
  BulkItemInput,
  TestContext,
} from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  getOperatorClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "bulk-limits",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const MAX_ENTRIES = 5000;
const BULK_BODY_CAP = 16 * 1024 * 1024;
const DEFAULT_MATCH_CAP = 10_000;
const HARD_MATCH_CAP = 50_000;
const MAX_TAGS = 100;

async function mintKey(
  label: string,
  request: Record<string, unknown>,
): Promise<MarfaClient & { secret: string }> {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    ...request,
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return Object.assign(
    new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
    { secret: minted.data.key },
  );
}

async function post(
  key: string,
  path: string,
  body: string,
): Promise<{
  status: number;
  code?: string;
  details?: Record<string, unknown>;
}> {
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body,
  });
  const parsed = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; details?: Record<string, unknown> };
  };
  return {
    status: res.status,
    code: parsed.error?.code,
    details: parsed.error?.details,
  };
}

/** A JSON text of exactly `bytes` bytes: `prefix`, a run of one ASCII
 *  character, then `suffix`. */
function jsonOfSize(prefix: string, suffix: string, bytes: number): string {
  return prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
}

async function seedTagged(
  seeder: MarfaClient,
  count: number,
  tag: string,
): Promise<void> {
  for (let from = 0; from < count; from += MAX_ENTRIES) {
    const items: BulkItemInput[] = Array.from(
      { length: Math.min(MAX_ENTRIES, count - from) },
      (_, i) => ({
        type: "core.note",
        properties: { title: `limits ${String(from + i)}`, body: "limits" },
        tags: [tag],
      }),
    );
    const page = await seeder.bulkItems({ items });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    expect(page.data.counts.created).toBe(items.length);
  }
}

async function runToCompletion(
  runner: MarfaClient,
  input: BulkActionInput,
): Promise<BulkActionResponse> {
  const res = await runner.bulkAction(input);
  expect(res.status, JSON.stringify(res.error)).toBe(202);
  const final = await runner.pollBulkActionToTerminal(
    (res.data as BulkActionJob).id,
    { timeoutMs: 110_000 },
  );
  expect(final.status).toBe("completed");
  return final.result!;
}

async function noteWithTag(tag: string, extra = {}): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, tags: [tag], ...extra }),
  );
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("POST /items/bulk entry and body limits", () => {
  it("refuses a key that reaches no type before it reads the page, an empty page included", async () => {
    const none = await mintKey("no-type", { type_permissions: {} });

    for (const [label, body] of [
      ["an empty page", '{"items":[]}'],
      ["a body that is not JSON", "{not json"],
      ["a body of the wrong shape", '{"items":"x"}'],
    ] as const) {
      const refused = await post(none.secret, "/items/bulk", body);
      expect(refused.status, label).toBe(403);
      expect(refused.code, label).toBe("type_not_permitted");
    }

    // The witness: the file's own key is answered the empty page, and the
    // malformed bodies are refused by the page's own validation, not by
    // anything the no-type key lacks.
    const served = await post(apiKey, "/items/bulk", '{"items":[]}');
    expect(served.status).toBe(200);
    expect((await post(apiKey, "/items/bulk", "{not json")).status).toBe(400);
    expect((await post(apiKey, "/items/bulk", '{"items":"x"}')).status).toBe(
      400,
    );
  });

  it("refuses a page of more than 5,000 entries, and takes one of 5,000", async () => {
    const entry = (sourceId: string): BulkItemInput => ({
      type: "core.note",
      properties: { title: "cap", body: "cap" },
      source_id: sourceId,
    });
    const refusedId = `limits-over-${ctx.runId}`;
    const over = await client.bulkItems({
      items: Array.from({ length: MAX_ENTRIES + 1 }, () => entry(refusedId)),
      mode: "create_only",
    });
    expect(over.status).toBe(400);
    expect(over.error?.error.code).toBe("validation_error");
    expect(over.error?.error.details).toMatchObject({
      cap: MAX_ENTRIES,
      provided: MAX_ENTRIES + 1,
    });
    const nothing = await client.lookupItems({
      type: "core.note",
      source: ctx.source,
      source_ids: [refusedId],
    });
    expect(nothing.ok).toBe(true);
    expect(nothing.data.data).toEqual([]);

    const takenId = `limits-at-${ctx.runId}`;
    const at = await client.bulkItems({
      items: Array.from({ length: MAX_ENTRIES }, () => entry(takenId)),
      mode: "create_only",
    });
    expect(at.status, JSON.stringify(at.error)).toBe(200);
    expect(at.data.counts).toEqual({
      created: 1,
      updated: 0,
      skipped: MAX_ENTRIES - 1,
      errored: 0,
    });
    expect(at.data.results).toHaveLength(MAX_ENTRIES);
    expect(
      at.data.results.slice(1).every((r) => r.reason === "duplicate_source"),
    ).toBe(true);
    trackItem(ctx, String(at.data.results[0]?.id));
  });

  it("refuses a bulk body over 16 MiB with request_too_large, on both bulk item operations", async () => {
    const bulkPrefix = '{"items":[{"type":"core.note","properties":{"body":"';
    const bulkSuffix = '"}}]}';
    const actionPrefix =
      '{"action":"transition","state":"archived","dry_run":true,"filter":{"tags":["';
    const actionSuffix = '"]}}';

    // The witness: a body one kilobyte under the cap is read, and refused
    // for what it says, so the 413 below is the size and nothing else.
    const under = await post(
      apiKey,
      "/items/bulk",
      jsonOfSize(bulkPrefix, bulkSuffix, BULK_BODY_CAP - 1024),
    );
    expect(under.status).not.toBe(413);
    expect(under.status).toBe(400);
    expect(under.code).toBe("bulk_atomic_rollback");
    expect(under.details?.code).toBe("invalid_properties");

    const over = await post(
      apiKey,
      "/items/bulk",
      jsonOfSize(bulkPrefix, bulkSuffix, BULK_BODY_CAP + 1),
    );
    expect(over.status).toBe(413);
    expect(over.code).toBe("request_too_large");

    const overAction = await post(
      apiKey,
      "/items/bulk-actions",
      jsonOfSize(actionPrefix, actionSuffix, BULK_BODY_CAP + 1),
    );
    expect(overAction.status).toBe(413);
    expect(overAction.code).toBe("request_too_large");

    const underAction = await post(
      apiKey,
      "/items/bulk-actions",
      jsonOfSize(actionPrefix, actionSuffix, BULK_BODY_CAP - 1024),
    );
    expect(underAction.status).not.toBe(413);
  });
});

describe("POST /items/bulk with retype", () => {
  it("answers unknown_type for a bulk entry retyped into a type nothing registered, and moves nothing", async () => {
    const registered = `user.bulk-limits-${ctx.runId}`;
    const reg = await client.registerType({
      id: registered,
      fields: { title: { type: "string" }, body: { type: "string" } },
    });
    expect(reg.ok, JSON.stringify(reg.error)).toBe(true);

    const seed = async (sourceId: string) => {
      const created = await client.createItem(
        createNote({ source: ctx.source, source_id: sourceId }),
      );
      expect(created.ok).toBe(true);
      trackItem(ctx, created.data.item.id);
      return created.data.item;
    };
    const staysSourceId = `limits-retype-stays-${ctx.runId}`;
    const movesSourceId = `limits-retype-moves-${ctx.runId}`;
    const stays = await seed(staysSourceId);
    const moves = await seed(movesSourceId);
    const absent = `user.bulk-limits-absent-${ctx.runId}`;

    const page = await client.bulkItems({
      atomic: false,
      retype: true,
      items: [
        {
          type: absent,
          properties: { title: "t" },
          source_id: staysSourceId,
        },
        {
          type: registered,
          properties: { title: "t" },
          source_id: movesSourceId,
        },
      ],
    });
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    expect(page.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "unknown_type", details: { type: absent } },
    });
    expect(page.data.results[1]).toMatchObject({
      outcome: "updated",
      id: moves.id,
    });

    const kept = await client.getItem(stays.id);
    expect(kept.data.item.type).toBe("core.note");
    expect(kept.data.item.version).toBe(stays.version);
    const moved = await client.getItem(moves.id);
    expect(moved.data.item.type).toBe(registered);
  });
});

describe("POST /items/bulk-actions match caps", () => {
  it("refuses a bulk action matching more than 10,000 items when it names no max_items", async () => {
    const tag = `limits-default-cap-${ctx.runId}`;
    try {
      await seedTagged(client, DEFAULT_MATCH_CAP + 1, tag);
      const filter = { tags: [tag] };

      const refused = await client.bulkAction({
        action: "transition",
        state: "archived",
        filter,
        dry_run: true,
      });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("bulk_cap_exceeded");
      expect(refused.error?.error.details).toMatchObject({
        cap: DEFAULT_MATCH_CAP,
      });

      const named = await client.bulkAction({
        action: "transition",
        state: "archived",
        filter,
        dry_run: true,
        max_items: DEFAULT_MATCH_CAP + 1,
      });
      expect(named.status, JSON.stringify(named.error)).toBe(200);
      expect((named.data as BulkActionResponse).matched).toBe(
        DEFAULT_MATCH_CAP + 1,
      );
    } finally {
      const covers = DEFAULT_MATCH_CAP + 1;
      await runToCompletion(client, {
        action: "transition",
        state: "trashed",
        filter: { tags: [tag] },
        max_items: covers,
      });
      const purged = await runToCompletion(client, {
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [tag], state: "trashed" },
        max_items: covers,
      });
      expect(purged.succeeded).toBe(covers);
    }
  }, 300_000);

  it(
    "counts a max_items above 50,000 as 50,000",
    async () => {
      const server = await bootFreshServer("bulk-limits-hard-cap");
      try {
        const own = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: server.workingKey,
        });
        const tag = `limits-hard-cap-${ctx.runId}`;
        const dryRun = (maxItems: number) =>
          own.bulkAction({
            action: "transition",
            state: "archived",
            filter: { tags: [tag] },
            dry_run: true,
            max_items: maxItems,
          });

        await seedTagged(own, HARD_MATCH_CAP, tag);
        const at = await dryRun(HARD_MATCH_CAP);
        expect(at.status, JSON.stringify(at.error)).toBe(200);
        expect((at.data as BulkActionResponse).matched).toBe(HARD_MATCH_CAP);

        await seedTagged(own, 1, tag);
        const over = await dryRun(60_000);
        expect(over.status).toBe(400);
        expect(over.error?.error.code).toBe("bulk_cap_exceeded");
        expect(over.error?.error.details).toMatchObject({
          cap: HARD_MATCH_CAP,
        });
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS + 540_000,
  );
});

describe("POST /items/bulk-actions body", () => {
  it("refuses a body key the bulk-action operation does not declare, naming it", async () => {
    const tag = `limits-undeclared-${ctx.runId}`;
    const id = await noteWithTag(tag);
    const base = {
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    };

    for (const [field, extra] of [
      ["max_item", { max_item: 1 }],
      ["tags", { tags: ["x"] }],
    ] as const) {
      const refused = await client.rawRequest<unknown>("/items/bulk-actions", {
        method: "POST",
        body: { ...base, ...extra },
      });
      expect(refused.status, field).toBe(400);
      expect(refused.error?.error.code, field).toBe("validation_error");
      expect(refused.error?.error.details?.unknown_body_fields, field).toEqual([
        field,
      ]);
      expect((await client.getItem(id)).data.item.state, field).toBe("active");
    }

    // The witness: the corrected body is accepted and runs.
    const result = await runToCompletion(client, {
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
      max_items: 1,
    });
    expect(result.succeeded).toBe(1);
    expect((await client.getItem(id)).data.item.state).toBe("archived");
  });

  it("refuses an update_tags action adding more than 100 tags", async () => {
    const tag = `limits-tags-${ctx.runId}`;
    await noteWithTag(tag);
    const tags = (count: number) =>
      Array.from({ length: count }, (_, i) => `limits-add-${String(i)}`);
    const ask = (count: number) =>
      client.bulkAction({
        action: "update_tags",
        add: tags(count),
        filter: { tags: [tag] },
        dry_run: true,
      });

    const over = await ask(MAX_TAGS + 1);
    expect(over.status).toBe(400);
    expect(over.error?.error.code).toBe("validation_error");

    const at = await ask(MAX_TAGS);
    expect(at.status, JSON.stringify(at.error)).toBe(200);
    expect((at.data as BulkActionResponse).matched).toBe(1);
  });
});

describe("a bulk purge", () => {
  it("asks a purge dry run for items.purge and confirm, as it asks a purge", async () => {
    const tag = `limits-purge-dry-${ctx.runId}`;
    const id = await noteWithTag(tag);
    const keyless = await mintKey("no-purge", {
      type_permissions: { "*": "write" },
      permissions: [],
    });
    const dry = (confirm: boolean) => ({
      action: "purge" as const,
      filter: { tags: [tag] },
      dry_run: true,
      ...(confirm ? { confirm: "PURGE" as const } : {}),
    });

    const unconfirmed = await client.bulkAction(dry(false));
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.error?.error.code).toBe("bulk_confirmation_required");

    const unpermitted = await keyless.bulkAction(dry(true));
    expect(unpermitted.status).toBe(403);
    expect(unpermitted.error?.error.code).toBe("forbidden");
    expect(unpermitted.error?.error.details?.required_scope).toBe(
      "items.purge",
    );

    // The witness: with both, the same dry run is answered.
    const served = await client.bulkAction(dry(true));
    expect(served.status, JSON.stringify(served.error)).toBe(200);
    expect((served.data as BulkActionResponse).ids).toEqual([id]);
  });

  it("lists a live row in a purge dry run, which the purge then leaves", async () => {
    const tag = `limits-purge-live-${ctx.runId}`;
    const id = await noteWithTag(tag);
    const filter = { tags: [tag] };

    const dry = await client.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter,
      dry_run: true,
    });
    expect(dry.status, JSON.stringify(dry.error)).toBe(200);
    expect((dry.data as BulkActionResponse).ids).toEqual([id]);

    const result = await runToCompletion(client, {
      action: "purge",
      confirm: "PURGE",
      filter,
    });
    expect(result.succeeded).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({ id, code: "invalid_transition" }),
    ]);
    expect((await client.getItem(id)).data.item.state).toBe("active");
  });
});

describe("a bulk-action job", () => {
  it("lets the operator key read and cancel any job", async () => {
    const tag = `limits-operator-${ctx.runId}`;
    await noteWithTag(tag);
    const queued = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(queued.status).toBe(202);
    const jobId = (queued.data as BulkActionJob).id;
    const final = await client.pollBulkActionToTerminal(jobId);
    expect(final.status).toBe("completed");

    const operator = getOperatorClient();
    const read = await operator.bulkActionStatus(jobId);
    expect(read.status).toBe(200);
    expect(read.data).toEqual(final);

    const cancelled = await operator.bulkActionCancel(jobId);
    expect(cancelled.status).toBe(200);
    expect(cancelled.data).toEqual(final);

    // The witness: a credential that is not the operator is refused.
    const other = await createSecondClient(ctx, "limits-other");
    expect((await other.bulkActionStatus(jobId)).status).toBe(403);
  });
});

describe("a bulk-action filter's own-time bounds", () => {
  it("matches own time strictly after occurred_after and strictly before occurred_before", async () => {
    const tag = `limits-time-${ctx.runId}`;
    const bound = Date.parse("2024-06-01T12:00:00.000Z");
    const at = (offsetMs: number) => new Date(bound + offsetMs).toISOString();
    const before = await noteWithTag(tag, { occurred_at: at(-1) });
    const on = await noteWithTag(tag, { occurred_at: at(0) });
    const after = await noteWithTag(tag, { occurred_at: at(1) });

    const matched = async (bounds: {
      occurred_after?: string;
      occurred_before?: string;
    }) => {
      const res = await client.bulkAction({
        action: "update_tags",
        add: ["limits-probe"],
        filter: { tags: [tag], ...bounds },
        dry_run: true,
      });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return ((res.data as BulkActionResponse).ids ?? []).sort();
    };

    // The control: unbounded, all three are in the match set.
    expect(await matched({})).toEqual([before, on, after].sort());
    expect(await matched({ occurred_after: at(0) })).toEqual([after]);
    expect(await matched({ occurred_before: at(0) })).toEqual([before]);
  });
});
