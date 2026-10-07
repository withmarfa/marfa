import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { startReceiver } from "../../utils/webhook-receiver.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import type { AuditEntry } from "../../client/types.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "audit",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Every audit entry this file's own key wrote under `action` since `since`,
 * newest first. The log is the instance's and sibling files write to it, so
 * a read is narrowed to this file's key and to the window it opened.
 */
async function ownEntries(
  action: string,
  since: string,
  keyId: string = ctx.trackedKeys[0]!,
): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAudit({
      action,
      created_after: since,
      limit: 200,
      cursor,
    });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    entries.push(...page.data.data);
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return entries.filter((entry) => entry.key_id === keyId);
}

/**
 * An item that holds a source id, written outside the bulk door so its own
 * entry is an `item.create`, with the instant of that entry. A later read
 * takes the instant as its exclusive lower bound, so everything it sees was
 * written after the seed with no clock of this process involved.
 */
async function seedHolding(
  sourceId: string,
): Promise<{ id: string; since: string }> {
  const created = await client.createItem(
    createNote({ source: ctx.source, source_id: sourceId }),
  );
  expect(created.ok).toBe(true);
  trackItem(ctx, created.data.item.id);
  const row = await createdRow(created.data.item.id);
  return { id: created.data.item.id, since: row.created_at };
}

async function createdRow(itemId: string) {
  const rows = await client.listAudit({
    resource_id: itemId,
    action: "item.create",
  });
  expect(rows.ok).toBe(true);
  expect(rows.data.data).toHaveLength(1);
  return rows.data.data[0];
}

describe("audit log", () => {
  it("records a write with the acting key, the resource and the action", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const rows = await client.listAudit({ resource_id: item.data.item.id });
    expect(rows.ok).toBe(true);
    await expectMatchesSchema("GET", "/audit", 200, rows.data);
    const row = rows.data.data.find((r) => r.action === "item.create");
    expect(row).toBeDefined();
    expect(row?.resource_type).toBe("item");
    expect(row?.resource_id).toBe(item.data.item.id);
    expect(row?.key_id).toBe(ctx.trackedKeys[0]);
    expect(row?.details.type).toBe("core.note");
  });

  it("exposes each committed best-effort entry immediately with one operation context", async () => {
    const page = await client.bulkItems({
      atomic: false,
      items: [
        createNote({ source: ctx.source }),
        { type: "audit_missing_type", properties: {} },
        createNote({ source: ctx.source }),
      ],
    });
    expect(page.status).toBe(200);
    expect(page.data.results.map((row) => row.outcome)).toEqual([
      "created",
      "errored",
      "created",
    ]);
    const operations: unknown[] = [];
    for (const index of [0, 2]) {
      const id = page.data.results[index].id!;
      trackItem(ctx, id);
      expect((await client.getItem(id)).status).toBe(200);
      const rows = await client.listAudit({
        action: "items.bulk",
        resource_id: id,
      });
      expect(rows.status).toBe(200);
      expect(rows.data.data).toHaveLength(1);
      const row = rows.data.data[0];
      expect(row.key_id).toBe(ctx.trackedKeys[0]);
      expect(row.details).toMatchObject({
        atomic: false,
        index,
        outcome: "created",
        total: 3,
      });
      expect(typeof row.details.operation_id).toBe("string");
      operations.push(row.details.operation_id);
    }
    expect(new Set(operations).size).toBe(1);
  });

  it("filters by action and resource type with an excluded control", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const tagged = await client.addTags(item.data.item.id, ["audited"]);
    expect(tagged.ok).toBe(true);

    const creates = await client.listAudit({
      resource_id: item.data.item.id,
      action: "item.create",
    });
    expect(creates.ok).toBe(true);
    expect(creates.data.data.map((r) => r.action)).toEqual(["item.create"]);

    const tags = await client.listAudit({
      resource_id: item.data.item.id,
      action: "item.tag",
    });
    expect(tags.ok).toBe(true);
    expect(tags.data.data.map((r) => r.action)).toEqual(["item.tag"]);

    const edges = await client.listAudit({
      resource_id: item.data.item.id,
      resource_type: "edge",
    });
    expect(edges.ok).toBe(true);
    expect(edges.data.data).toEqual([]);
  });

  it("bounds by created_after and created_before, both exclusive", async () => {
    // Three rows written in order, so one sits on each side of the middle
    // one's instant. Two rows could not tell these failures apart: the
    // boundary row proves the comparison is strict rather than inclusive,
    // and the row inside the range proves the predicate reached the query
    // at all — a bound that was dropped and a bound that excluded
    // everything both leave the boundary row absent.
    //
    // The audit log stamps its own instant, so the three are seeded and
    // then read back rather than chosen. A pause between them keeps the
    // three stamps distinct at millisecond resolution.
    //
    // Every read below carries both bounds, holding the one not under test
    // a millisecond outside the outermost row. The log is instance-wide and
    // sibling files write to it, so an unbounded page would be truncated
    // and a whole page could not be asserted; a window this narrow can be.
    // It does not weaken the case: a dropped bound under test still leaves
    // the boundary row inside the window, where the assertion finds it.
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const item = await client.createItem(createNote({ source: ctx.source }));
      expect(item.ok).toBe(true);
      trackItem(ctx, item.data.item.id);
      rows.push(await createdRow(item.data.item.id));
      await new Promise((r) => setTimeout(r, 5));
    }
    const [earlier, onBound, later] = rows;
    expect(
      new Set(rows.map((r) => r.created_at)).size,
      "two audit rows share an instant, so a bound on one cannot separate them",
    ).toBe(3);

    const ids = async (bound: Record<string, string>): Promise<string[]> => {
      const page = await client.listAudit({
        action: "item.create",
        resource_type: "item",
        limit: 200,
        ...bound,
      });
      expect(page.ok).toBe(true);
      // The page has to be whole, or an absence below is a truncation
      // rather than a bound.
      expect(
        page.data.next_cursor,
        "the page was truncated, so a row missing from it proves nothing about the bound",
      ).toBeNull();
      return page.data.data.map((r) => r.id);
    };

    const lo = new Date(Date.parse(earlier.created_at) - 1).toISOString();
    const hi = new Date(Date.parse(later.created_at) + 1).toISOString();

    const afterBound = await ids({
      created_after: onBound.created_at,
      created_before: hi,
    });
    expect(
      afterBound,
      "the row whose instant is exactly the lower bound came back, so the bound is inclusive where the rule says exclusive",
    ).not.toContain(onBound.id);
    expect(
      afterBound,
      "a row written after the lower bound was missing, so the bound is being dropped or is narrowing the wrong way",
    ).toContain(later.id);
    expect(afterBound).not.toContain(earlier.id);

    const beforeBound = await ids({
      created_before: onBound.created_at,
      created_after: lo,
    });
    expect(
      beforeBound,
      "the row whose instant is exactly the upper bound came back: this is the inclusive-`until` defect, and it is what this case exists to keep dead",
    ).not.toContain(onBound.id);
    expect(
      beforeBound,
      "a row written before the upper bound was missing, so the bound is being dropped or is narrowing the wrong way",
    ).toContain(earlier.id);
    expect(beforeBound).not.toContain(later.id);
  });

  it("paginates with a cursor and delivers every row once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const item = await client.createItem(createNote({ source: ctx.source }));
      expect(item.ok).toBe(true);
      trackItem(ctx, item.data.item.id);
      ids.push(item.data.item.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await client.listAudit({
        action: "item.create",
        limit: 2,
        cursor,
      });
      expect(rows.ok).toBe(true);
      expect(rows.data.data.length).toBeLessThanOrEqual(2);
      seen.push(...rows.data.data.map((r) => r.resource_id));
      if (rows.data.next_cursor === null) break;
      expect(typeof rows.data.next_cursor).toBe("string");
      cursor = rows.data.next_cursor ?? undefined;
    }
    for (const id of ids) {
      expect(seen.filter((s) => s === id)).toHaveLength(1);
    }
  });

  it("refuses a key without audit.read", async () => {
    const keyResp = await client.createKey({
      label: "no-audit",
      source: `${ctx.source}-no-audit`,
      permissions: [],
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const narrowed = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });
    const rows = await narrowed.listAudit();
    expect(rows.status).toBe(403);
    expect(rows.error?.error.code).toBe("forbidden");
  });

  it("reads a bound at any precision, and refuses one that is not an instant", async () => {
    // The bounds compile to a text comparison against a column stamped at
    // millisecond width, and text comparison is lexical: `.` sorts below
    // `Z`, so a bound written at second precision names a different string
    // than the instant it means. A lower bound loses the whole second and
    // an upper bound keeps it, and both answer a well-formed 200 — which is
    // why this is a fixture and not a code comment.
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const row = await createdRow(item.data.item.id);

    // The same instant as the row, spelled without the milliseconds. On a
    // door that compares the raw string this excludes the row it names.
    const second = `${row.created_at.slice(0, 19)}Z`;

    const seen = async (bound: Record<string, string>): Promise<boolean> => {
      const page = await client.listAudit({
        resource_id: item.data.item.id,
        action: "item.create",
        limit: 200,
        ...bound,
      });
      expect(page.ok).toBe(true);
      return page.data.data.some((r) => r.id === row.id);
    };

    // `second` names the start of the row's own second, which is earlier
    // than the row. So both answers follow from the instants alone: the row
    // is strictly after it, and not strictly before it.
    //
    // Both assertions bite, and they bite in opposite directions, which is
    // what makes the pair worth writing. Compared as raw text, `.` sorts
    // below `Z`, so `"…12.948Z"` sorts BEFORE `"…12Z"` — a lower bound at
    // second precision drops the row it should keep, and an upper bound at
    // the same precision keeps the row it should drop. One assertion would
    // have caught one of those.
    expect(await seen({ created_after: second })).toBe(true);
    expect(await seen({ created_before: second })).toBe(false);

    // The witness: a bound written at the stored width, one millisecond
    // below the row. Without it a failure to read anything at all — a
    // refused request, an empty page — would satisfy the exclusion above
    // for free.
    const justBefore = new Date(Date.parse(row.created_at) - 1).toISOString();
    expect(await seen({ created_after: justBefore })).toBe(true);

    // A value that is not an instant is refused rather than compared.
    // Compared, it would answer 200 to both of these: the empty trail for a
    // lower bound, the whole trail for an upper one, neither
    // distinguishable from a window that matched that much.
    for (const bound of ["created_after", "created_before"]) {
      const bad = await client.rawRequest(`/audit?${bound}=banana`);
      expect(bad.status).toBe(400);
      expect(bad.error?.error.code).toBe("validation_error");
    }
  });

  it("refuses an undeclared bound rather than answering the whole trail", async () => {
    // A bound the door does not declare, answered `200` with everything,
    // would read exactly like a time range that matched every row. The
    // control is the second assertion: the same request under the declared
    // name has to come back `200`, or this case would pass against a door
    // that refused its own vocabulary.
    const undeclared = await client.rawRequest(
      `/audit?since=${encodeURIComponent(new Date(0).toISOString())}`,
    );
    expect(undeclared.status).toBe(400);
    expect(undeclared.error?.error.code).toBe("validation_error");
    expect(undeclared.error?.error.details?.unknown_parameters).toEqual([
      "since",
    ]);

    const declared = await client.listAudit({
      created_after: new Date(0).toISOString(),
      limit: 1,
    });
    expect(declared.status).toBe(200);
  });

  it("refuses a request with no credential", async () => {
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    const rows = await anonymous.listAudit();
    expect(rows.status).toBe(401);
    expect(rows.error?.error.code).toBe("unauthorized");
  });
  it("records one summary entry for an atomic bulk page, and none for a page that rolled back", async () => {
    const sourceId = `audit-atomic-${ctx.runId}`;
    const { since } = await seedHolding(sourceId);
    const page = await client.bulkItems({
      atomic: true,
      mode: "create_only",
      items: [
        {
          type: "core.note",
          properties: { title: "audit-atomic", body: "created" },
          source_id: `${sourceId}-new`,
        },
        {
          type: "core.note",
          properties: { title: "audit-atomic", body: "skipped" },
          source_id: sourceId,
        },
      ],
    });
    expect(page.status).toBe(200);
    expect(page.data.counts).toEqual({
      created: 1,
      updated: 0,
      skipped: 1,
      errored: 0,
    });
    trackItem(ctx, page.data.results[0]!.id!);

    const summaries = await ownEntries("items.bulk", since);
    expect(
      summaries,
      "an atomic page leaves one entry for the page, not one for each entry",
    ).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.resource_type).toBe("items.bulk");
    expect(summary.details).toMatchObject({
      atomic: true,
      mode: "create_only",
      total: 2,
      created: 1,
      updated: 0,
      skipped: 1,
      errored: 0,
    });
    expect(typeof summary.details.operation_id).toBe("string");

    // A page that changed nothing is still one entry, and its skipped count
    // is all of it.
    const unchanged = await client.bulkItems({
      atomic: true,
      mode: "create_only",
      items: [
        {
          type: "core.note",
          properties: { title: "audit-atomic", body: "again" },
          source_id: sourceId,
        },
      ],
    });
    expect(unchanged.data.counts.skipped).toBe(1);
    const afterUnchanged = await ownEntries("items.bulk", since);
    expect(afterUnchanged).toHaveLength(2);
    expect(afterUnchanged[0]!.details).toMatchObject({
      atomic: true,
      total: 1,
      created: 0,
      skipped: 1,
    });

    // The witness above is that a committed page leaves its entry; a page
    // that fails rolls its entry back with its writes.
    const rolledBack = await client.bulkItems({
      atomic: true,
      items: [
        createNote({ source: ctx.source }),
        { type: "audit_missing_type", properties: {} },
      ],
    });
    expect(rolledBack.status).toBe(400);
    expect(rolledBack.error?.error.code).toBe("bulk_atomic_rollback");
    expect(await ownEntries("items.bulk", since)).toHaveLength(2);
  });

  it("records no entry for a best-effort entry that was skipped or refused", async () => {
    const sourceId = `audit-skip-${ctx.runId}`;
    const { since } = await seedHolding(sourceId);
    const page = await client.bulkItems({
      atomic: false,
      mode: "create_only",
      items: [
        {
          type: "core.note",
          properties: { title: "audit-skip", body: "first" },
          source_id: `${sourceId}-first`,
        },
        { type: "audit_missing_type", properties: {} },
        {
          type: "core.note",
          properties: { title: "audit-skip", body: "duplicate" },
          source_id: sourceId,
        },
        {
          type: "core.note",
          properties: { title: "audit-skip", body: "last" },
          source_id: `${sourceId}-last`,
        },
      ],
    });
    expect(page.status).toBe(200);
    expect(page.data.results.map((row) => row.outcome)).toEqual([
      "created",
      "errored",
      "skipped",
      "created",
    ]);
    for (const index of [0, 3]) trackItem(ctx, page.data.results[index]!.id!);

    const entries = await ownEntries("items.bulk", since);
    expect(entries.map((entry) => entry.details.index).sort()).toEqual([0, 3]);
    expect(new Set(entries.map((e) => e.details.operation_id)).size).toBe(1);
  });
  it("records export.run before the export's stream begins, and none for an export it refuses", async () => {
    const { since } = await seedHolding(`audit-export-${ctx.runId}`);
    const exportAs = (credential: string, query: string) =>
      fetch(`${apiUrl}/export?${query}`, {
        headers: { Authorization: `Bearer ${credential}` },
      });

    // The response has begun when its headers are in, and its body is not
    // read until the entry has been looked for.
    const streaming = await exportAs(apiKey, `source=${ctx.source}`);
    expect(streaming.status).toBe(200);
    const begun = await ownEntries("export.run", since);
    expect(begun).toHaveLength(1);
    expect(begun[0]!.resource_type).toBe("export");
    expect(begun[0]!.details).toEqual({ format: "ndjson" });
    await streaming.text();

    const archive = await exportAs(
      apiKey,
      `format=archive&source=${ctx.source}`,
    );
    expect(archive.status).toBe(200);
    await archive.arrayBuffer();
    expect(
      (await ownEntries("export.run", since)).map((e) => e.details.format),
    ).toEqual(["archive", "ndjson"]);

    // An export refused for its type or its time bounds is never served, and
    // leaves no entry.
    const badBound = await exportAs(apiKey, "occurred_after=banana");
    expect(badBound.status).toBe(400);
    await badBound.text();
    expect(await ownEntries("export.run", since)).toHaveLength(2);

    const narrow = await client.createKey({
      label: "audit-export-narrow",
      source: `${ctx.source}-export-narrow`,
      type_permissions: { "core.task": "read" },
      edge_permissions: {},
      extension_permissions: {},
    });
    expect(narrow.ok).toBe(true);
    trackKey(ctx, narrow.data.id);
    const unreadable = await exportAs(narrow.data.key, "type=core.note");
    expect(unreadable.status).toBe(403);
    expect(
      ((await unreadable.json()) as { error: { code: string } }).error.code,
    ).toBe("type_not_permitted");
    const refusedEntries = await ownEntries(
      "export.run",
      since,
      narrow.data.id,
    );
    expect(refusedEntries).toEqual([]);

    // Nor does a credential that reaches no type, turned away at the door.
    const operator = process.env.MARFA_OPERATOR_KEY!;
    const turnedAway = await exportAs(operator, "");
    expect(turnedAway.status).toBe(403);
    await turnedAway.text();
    const operatorId = (
      await new MarfaClient({
        baseUrl: apiUrl,
        apiKey: operator,
      }).getCurrentKey()
    ).data.id;
    expect(await ownEntries("export.run", since, operatorId)).toEqual([]);
  });
  it("keeps every credential value out of the entries a key's and a webhook's writes leave", async () => {
    const { since } = await seedHolding(`audit-secret-${ctx.runId}`);
    const receiver = await startReceiver();
    try {
      const minted = await client.createKey({
        label: "audit-secret",
        source: `${ctx.source}-secret`,
        type_permissions: { "core.note": "read" },
      });
      expect(minted.ok).toBe(true);
      trackKey(ctx, minted.data.id);
      const updated = await client.updateKey(minted.data.id, {
        label: "audit-secret-renamed",
      });
      expect(updated.ok, JSON.stringify(updated.error)).toBe(true);

      const generated = await client.createWebhook({
        url: receiver.hookUrl("audit-generated"),
        events: ["item.created"],
      });
      expect(generated.status).toBe(201);
      trackWebhook(ctx, generated.data.id, client);
      const supplied = `audit-supplied-secret-${ctx.runId}-0123456789abcdef`;
      const chosen = await client.createWebhook({
        url: receiver.hookUrl("audit-supplied"),
        events: ["item.created"],
        secret: supplied,
      });
      expect(chosen.status).toBe(201);
      trackWebhook(ctx, chosen.data.id, client);
      expect((await client.revokeKey(minted.data.id)).ok).toBe(true);

      const entries: AuditEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listAudit({
          created_after: since,
          limit: 200,
          cursor,
        });
        expect(page.ok).toBe(true);
        // This file's own key wrote all of them. A sibling file's blob
        // upload leaves a 64-character hash in its entry, which the shape
        // check below must not be asked about.
        entries.push(
          ...page.data.data.filter((e) => e.key_id === ctx.trackedKeys[0]),
        );
        cursor = page.data.next_cursor ?? undefined;
      } while (cursor !== undefined);

      // The witness: the writes are in the log, so a value missing from it
      // is one that was left out and not one that was never recorded.
      const actions = new Set(entries.map((entry) => entry.action));
      for (const action of ["key.create", "key.revoke", "webhook.create"]) {
        expect(actions, action).toContain(action);
      }
      expect(
        entries.filter((entry) => entry.action === "webhook.create"),
      ).toHaveLength(2);
      expect(
        entries.some(
          (entry) =>
            entry.action === "key.create" &&
            entry.resource_id === minted.data.id,
        ),
      ).toBe(true);

      const logged = JSON.stringify(entries.map((entry) => entry.details));
      for (const value of [
        minted.data.key,
        apiKey,
        process.env.MARFA_API_KEY ?? "",
        generated.data.secret,
        supplied,
      ]) {
        expect(value.length).toBeGreaterThan(0);
        expect(logged).not.toContain(value);
      }
      // Nor a value shaped like one: a key, or the 64 hexadecimal characters
      // of a generated secret or a stored hash.
      expect(logged).not.toMatch(/marfa_k1_[0-9a-f]{16}/);
      expect(logged).not.toMatch(/[0-9a-f]{64}/);
    } finally {
      await receiver.close();
    }
  });

  it("lists newest first, and refuses the operator key, which does not hold audit.read", async () => {
    const first = await client.createItem(createNote({ source: ctx.source }));
    expect(first.ok).toBe(true);
    trackItem(ctx, first.data.item.id);
    await new Promise((r) => setTimeout(r, 5));
    const second = await client.createItem(createNote({ source: ctx.source }));
    expect(second.ok).toBe(true);
    trackItem(ctx, second.data.item.id);

    const older = await createdRow(first.data.item.id);
    const newer = await createdRow(second.data.item.id);
    expect(older.created_at < newer.created_at).toBe(true);
    const page = await client.listAudit({
      action: "item.create",
      created_after: new Date(Date.parse(older.created_at) - 1).toISOString(),
      limit: 200,
    });
    expect(page.ok).toBe(true);
    const ids = page.data.data.map((row) => row.id);
    expect(ids.indexOf(newer.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    const stamps = page.data.data.map((row) => row.created_at);
    expect([...stamps].sort().reverse()).toEqual(stamps);

    const operator = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: process.env.MARFA_OPERATOR_KEY!,
    });
    const refused = await operator.listAudit();
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
  });
});
