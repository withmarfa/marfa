import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackKey,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let originalConfig: Record<string, unknown> = {};

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "schema-enforcement",
  ));

  const current = await client.getConfig();
  expect(current.ok).toBe(true);
  await expectMatchesSchema("GET", "/config", 200, current.data);
  originalConfig = current.data as Record<string, unknown>;
});

/** Replace the configuration and require the door to have accepted it. */
async function setConfig(
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await client.updateConfig(config);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return r.data as Record<string, unknown>;
}

afterAll(async () => {
  // Put back whatever the configuration held before this file ran. The levers
  // are instance-wide, so leaving one on would change how every other file's
  // writes validate — and `PUT` replaces the configuration wholesale, so
  // clearing it instead of restoring it would discard settings this file never
  // set.
  await setConfig(originalConfig);
  await cleanup(ctx);
});

/**
 * A writer identified by a specific `source`. `source` is credential-stamped
 * and not forgeable, so a distinct source means a distinct credential.
 */
async function clientWithSource(
  label: string,
  source: string,
): Promise<MarfaClient> {
  const keyResp = await client.createKey({
    label,
    source,
    permissions: [],
    type_permissions: { "*": "write" },
  });
  expect(keyResp.ok).toBe(true);
  trackKey(ctx, keyResp.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: keyResp.data.key });
}

describe("the configuration door", () => {
  it("PUT replaces the configuration wholesale and GET reads it back", async () => {
    const lever = {
      enforcement: { strict_mode: { types: ["core.bookmark"] } },
    };
    const written = await setConfig(lever);
    await expectMatchesSchema("PUT", "/config", 200, written);
    expect(written).toEqual(lever);
    const read = await client.getConfig();
    expect(read.ok).toBe(true);
    expect(read.data).toEqual(lever);

    const cleared = await setConfig({});
    expect(cleared).toEqual({});
    const readAgain = await client.getConfig();
    expect(readAgain.data).toEqual({});
  });

  it("refuses a lever of the wrong shape", async () => {
    const r = await client.updateConfig({
      enforcement: { strict_mode: "yes" },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("refuses both doors to a key without config.manage", async () => {
    const narrowed = await clientWithSource(
      "config-no-settings",
      `${ctx.source}-config-no-settings`,
    );
    const read = await narrowed.getConfig();
    expect(read.status).toBe(403);
    expect(read.error?.error.code).toBe("forbidden");
    expect(read.error?.error.details?.required_scope).toBe("config.manage");
    const write = await narrowed.updateConfig({});
    expect(write.status).toBe(403);
    expect(write.error?.error.code).toBe("forbidden");
  });
});

describe("strict_mode lever", () => {
  it("default-off accepts unknown property on core.note write", async () => {
    await setConfig({});
    const r = await client.createItem({
      type: "core.note",
      properties: { body: "with extras", not_a_real_field: "x" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });

  it("strict-on rejects unknown property with invalid_properties", async () => {
    await setConfig({
      enforcement: {
        strict_mode: { types: ["core.note"] },
      },
    });
    const r = await client.createItem({
      type: "core.note",
      properties: { body: "with extras", not_a_real_field: "x" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
  });
});

describe("source_allowlist lever", () => {
  it("rejects writes from non-listed source", async () => {
    await setConfig({
      enforcement: {
        source_allowlist: {
          types: ["core.note"],
          sources: [`${ctx.source}-allowed`],
        },
      },
    });

    const blocked = await clientWithSource(
      "allowlist-blocked",
      `${ctx.source}-blocked`,
    );
    const r = await blocked.createItem({
      type: "core.note",
      properties: { body: "should reject" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
    expect(r.error?.error.details?.type).toBe("core.note");
    expect(r.error?.error.details?.source).toBe(`${ctx.source}-blocked`);
    expect(r.error?.error.details?.allowed).toEqual([`${ctx.source}-allowed`]);
  });

  it("accepts writes from listed source", async () => {
    await setConfig({
      enforcement: {
        source_allowlist: {
          types: ["core.note"],
          sources: [`${ctx.source}-allowed`],
        },
      },
    });

    const allowed = await clientWithSource(
      "allowlist-allowed",
      `${ctx.source}-allowed`,
    );
    const r = await allowed.createItem({
      type: "core.note",
      properties: { body: "should accept" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });
});

describe("source_filter lever", () => {
  it("narrows reads to listed sources", async () => {
    await setConfig({});
    const a = await clientWithSource(
      "filter-source-a",
      `${ctx.source}-source-a`,
    );
    const b = await clientWithSource(
      "filter-source-b",
      `${ctx.source}-source-b`,
    );

    const ra = await a.createItem({
      type: "core.note",
      properties: { body: "from-a" },
      tags: [`filter-${ctx.runId}`],
    });
    expect(ra.ok).toBe(true);
    trackItem(ctx, ra.data.item.id);
    const rb = await b.createItem({
      type: "core.note",
      properties: { body: "from-b" },
      tags: [`filter-${ctx.runId}`],
    });
    expect(rb.ok).toBe(true);
    trackItem(ctx, rb.data.item.id);

    await setConfig({
      enforcement: {
        source_filter: {
          types: ["core.note"],
          sources: [`${ctx.source}-source-a`],
        },
      },
    });

    const list = await client.listItems({
      type: "core.note",
      tags: [`filter-${ctx.runId}`],
    });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(ra.data.item.id);
    expect(ids).not.toContain(rb.data.item.id);
  });

  /**
   * The lever applies per row, on every read that returns a set, so covering
   * `/items` alone proves nothing. Each surface below reaches rows by a
   * different path: a different index, a stream, an aggregate. A filter
   * applied in the list handler rather than in the query layer passes
   * `/items` and fails these.
   */
  it("narrows every read that returns a set, not just the list route", async () => {
    await setConfig({});

    const marker = `surfaces-${ctx.runId}`;
    const visible = await clientWithSource(
      "surfaces-visible",
      `${ctx.source}-surfaces-visible`,
    );
    const hidden = await clientWithSource(
      "surfaces-hidden",
      `${ctx.source}-surfaces-hidden`,
    );

    const shown = await visible.createItem({
      type: "core.note",
      properties: { body: `visible ${marker}` },
      tags: [marker],
    });
    expect(shown.ok).toBe(true);
    trackItem(ctx, shown.data.item.id);

    const concealed = await hidden.createItem({
      type: "core.note",
      properties: { body: `concealed ${marker}` },
      tags: [marker],
    });
    expect(concealed.ok).toBe(true);
    trackItem(ctx, concealed.data.item.id);

    const statsBefore = await client.itemStats();
    expect(statsBefore.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/stats", 200, statsBefore.data);
    const activeBefore = statsBefore.data["active"] ?? 0;

    await setConfig({
      enforcement: {
        source_filter: {
          types: ["core.note"],
          sources: [`${ctx.source}-surfaces-visible`],
        },
      },
    });

    // Full-text search: a separate index from the list query.
    const found = await client.search(marker, { limit: 50 });
    expect(found.ok).toBe(true);
    const searchIds = found.data.results.map((r) => r.item.id);
    // Both directions. Asserting only the absence passes vacuously against a
    // search that returned nothing at all, which is a plausible outcome — the
    // write happened milliseconds earlier and indexing need not be synchronous
    // — and would report the filter working when the index is simply empty.
    expect(searchIds).toContain(shown.data.item.id);
    expect(searchIds).not.toContain(concealed.data.item.id);

    // Export: a stream, built by a different reader from the paged list.
    const exported = await client.exportItems({ type: "core.note" });
    expect(exported.ok).toBe(true);
    expect(exported.data).not.toContain(concealed.data.item.id);
    expect(exported.data).toContain(shown.data.item.id);

    // Stats: an aggregate, keyed by lifecycle state. It returns counts
    // rather than rows, so a filter applied while shaping a response instead
    // of inside the query leaves this number unchanged while every other read
    // narrows. The filter admits one source, so at minimum the note written
    // by the other one stops counting.
    const statsAfter = await client.itemStats();
    expect(statsAfter.ok).toBe(true);
    expect(statsAfter.data["active"] ?? 0).toBeLessThan(activeBefore);
  });

  /**
   * `GET /items/{id}` is deliberately exempt, and that is worth pinning.
   *
   * The lever narrows a result set; it is not an access-control gate, and the
   * id read is already fenced by the caller's type permissions. Quietly adding it
   * here would turn a filtered-out row into a 404 for a caller holding its id,
   * which reads as data loss rather than as a filter. Without a test the
   * exemption looks like an oversight and gets "fixed".
   */
  it("does not narrow a read by id", async () => {
    await setConfig({});

    const hidden = await clientWithSource(
      "byid-hidden",
      `${ctx.source}-byid-hidden`,
    );
    const created = await hidden.createItem({
      type: "core.note",
      properties: { body: `by-id ${ctx.runId}` },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);

    await setConfig({
      enforcement: {
        source_filter: {
          types: ["core.note"],
          sources: [`${ctx.source}-nothing-matches-this`],
        },
      },
    });

    const byId = await client.getItem(created.data.item.id);
    expect(byId.ok).toBe(true);
    expect(byId.data.item.id).toBe(created.data.item.id);
  });
});
