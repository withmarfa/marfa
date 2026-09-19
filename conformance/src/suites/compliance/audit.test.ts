import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "audit"));
});

afterAll(async () => {
  await cleanup(ctx);
});

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
    // and `has_more` could not be asserted; a window this narrow cannot be.
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
        page.data.has_more,
        "the page was truncated, so a row missing from it proves nothing about the bound",
      ).toBe(false);
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
      if (!rows.data.has_more) break;
      expect(typeof rows.data.cursor).toBe("string");
      cursor = rows.data.cursor ?? undefined;
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

    // A value that is not an instant is refused rather than compared. The
    // silence this replaces answered 200 to both of these: the empty trail
    // for a lower bound, the whole trail for an upper one, neither
    // distinguishable from a window that matched that much.
    for (const bound of ["created_after", "created_before"]) {
      const bad = await client.rawRequest(`/audit?${bound}=banana`);
      expect(bad.status).toBe(400);
      expect(bad.error?.error.code).toBe("validation_error");
    }
  });

  it("refuses a retired bound rather than answering the whole trail", async () => {
    // The bounds used to be `since` and `until`, and this door had no
    // unknown-parameter refusal, so a caller still sending one was answered
    // `200` with everything — a dropped filter reads exactly like a time
    // range that matched every row. The control is the second assertion:
    // the same request with the current name has to come back `200`, or
    // this case would pass against a door that refused its own vocabulary.
    const retired = await client.rawRequest(
      `/audit?since=${encodeURIComponent(new Date(0).toISOString())}`,
    );
    expect(retired.status).toBe(400);
    expect(retired.error?.error.code).toBe("validation_error");
    expect(retired.error?.error.details?.unknown_parameters).toEqual(["since"]);

    const current = await client.listAudit({
      created_after: new Date(0).toISOString(),
      limit: 1,
    });
    expect(current.status).toBe(200);
  });

  it("refuses a request with no credential", async () => {
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    const rows = await anonymous.listAudit();
    expect(rows.status).toBe(401);
    expect(rows.error?.error.code).toBe("unauthorized");
  });
});
