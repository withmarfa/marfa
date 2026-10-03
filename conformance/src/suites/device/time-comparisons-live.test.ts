import { afterAll, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { TestContext } from "../../client/types.js";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let store: ReturnType<typeof newStore>;
const rows: {
  id: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}[] = [];
const spellings = [
  "2026",
  "2026-01",
  "2026-01-01",
  "2026-01-01T00:00",
  "2026-01-01T00:00:00Z",
  "2026-01-01T01:00:00+0100",
  "2025-12-31T23:00:00-01:00",
  "2026-01-01T00:00:00.500999Z",
  "2026-01-01T00:00:00.5",
  "2025-12-31T24:00:00.0000Z",
  "2026-01-01T00:00+2359",
  "0000",
  "0099-02",
  "2000-02-29",
  "9999-12-31T23:59:59.9999Z",
];
const invalid = [
  "bad",
  "2026-02-29",
  "1900-02-29",
  "2026-01-01T00:00:60Z",
  "2026-01-01T24:00:00.0001Z",
  "2026-01-01T00:00+2400",
  "0000-01-01T00:00+00:01",
  "9999-12-31T24:00Z",
];
function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}
beforeAll(async () => {
  const context = await createTestContext("device", "time-comparisons");
  ({ client, ctx } = context);
  for (const occurred_at of [
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.500Z",
    "2026-01-01T00:00:01.000Z",
  ]) {
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      tier: "library",
      occurred_at,
      properties: { body: ctx.runId },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    rows.push({
      ...made.data.item,
      occurred_at: made.data.item.occurred_at!,
      updated_at: made.data.item.updated_at!,
    });
  }
  store = newStore("time-comparisons");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  value(await device.hydrate(["core.note"], "library"));
});
afterAll(async () => {
  if (store) rmSync(dirname(store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

it("normalizes exclusive time bounds as the server does", async () => {
  const filter = `source eq "${ctx.source}"`;
  expect(value(await device.list({ filter }))).toHaveLength(rows.length);
  for (const bound of spellings) {
    for (const side of ["after", "before"] as const) {
      const served = await client.listItems({
        filter,
        [`occurred_${side}`]: bound,
      });
      expect(served.ok, `${bound}: ${JSON.stringify(served.error)}`).toBe(true);
      const local = value(
        await device.list({
          filter,
          [side === "after" ? "occurredAfter" : "occurredBefore"]: bound,
        }),
      );
      expect(local.map((r) => r.id).sort(), `${side} ${bound}`).toEqual(
        served.data.data.map((r) => r.id).sort(),
      );
    }
  }
  for (const row of rows) {
    for (const filters of [
      { occurredAfter: row.occurred_at },
      { occurredBefore: row.occurred_at },
    ]) {
      expect(
        value(await device.list({ filter, ...filters })).map((r) => r.id),
      ).not.toContain(row.id);
    }
  }
  const second = value(
    await device.list({
      filter,
      occurredAfter: "2026-01-01T00:00:00Z",
      occurredBefore: "2026-01-01T00:00:01Z",
    }),
  );
  expect(second.map((r) => r.id)).toEqual([rows[1].id]);
  for (const bound of invalid) {
    for (const side of ["after", "before"] as const) {
      const served = await client.listItems({ [`occurred_${side}`]: bound });
      expect(served.status, bound).toBe(400);
      expect(served.error?.error.code, bound).toBe("validation_error");
      const local = await device.list({
        [side === "after" ? "occurredAfter" : "occurredBefore"]: bound,
      });
      expect(local.ok, bound).toBe(false);
      if (!local.ok)
        expect(JSON.parse(local.refusal.raw).error.server.code, bound).toBe(
          "validation_error",
        );
    }
  }
});

it.each(["listing", "search"] as const)(
  "normalizes and validates time filters on %s",
  async (door) => {
    async function check(expression?: string) {
      const filter = `source eq "${ctx.source}"${expression ? ` AND ${expression}` : ""}`;
      const served =
        door === "listing"
          ? await client.listItems({ filter })
          : await client.search(ctx.runId, { filter });
      const local =
        door === "listing"
          ? await device.list({ filter })
          : await device.search(ctx.runId, { filter });
      expect(local.ok, `${expression}: ${JSON.stringify(local)}`).toBe(
        served.ok,
      );
      if (!served.ok) {
        expect(served.status, expression).toBe(400);
        expect(served.error?.error.code, expression).toBe("validation_error");
        if (!local.ok)
          expect(
            JSON.parse(local.refusal.raw).error.server.code,
            expression,
          ).toBe("validation_error");
        return;
      }
      const servedIds = served.data.data
        .map((r) => ("item" in r ? r.item.id : r.id))
        .sort();
      if (!local.ok) throw new Error(local.refusal.raw);
      const localIds = local.value
        .map((r) => ("item" in r ? r.item.id : r.id))
        .sort();
      expect(localIds, expression).toEqual(servedIds);
      if (!expression) expect(servedIds).toHaveLength(rows.length);
    }
    await check();
    for (const field of ["occurred_at", "created_at", "updated_at"] as const) {
      for (const op of ["eq", "neq", "gt", "gte", "lt", "lte"]) {
        for (const bound of [
          "2026-01-01T00:00:00Z",
          "2026-01-01T01:00:00.500+01:00",
          rows[1][field].replace(/\.\d+Z$/, "Z"),
          rows[1][field],
        ]) {
          await check(`${field} ${op} "${bound}"`);
        }
        for (const literal of [
          ...invalid.map((v) => JSON.stringify(v)),
          "42",
          "true",
          "null",
        ]) {
          await check(`${field} ${op} ${literal}`);
        }
      }
      for (const bound of spellings) await check(`${field} eq "${bound}"`);
      await check(`${field} contains "T00:"`);
      await check(`${field} starts_with "2026"`);
    }
  },
);

it("compares an unsent projection canonically and keeps its queued request", async () => {
  const spelling = "2026-01-01T01:00:00.500+0100";
  const queued = value(
    await device.create({
      type: "core.note",
      occurredAt: spelling,
      properties: { body: "unsent time" },
    }),
  );
  const id = queued.item_id!;
  expect(value(await device.get(id)).occurred_at).toBe(
    "2026-01-01T00:00:00.500Z",
  );
  const filter = `id eq "${id}" AND occurred_at eq "2026-01-01T00:00:00.500Z"`;
  expect(value(await device.list({ filter })).map((r) => r.id)).toEqual([id]);
  expect(
    value(await device.search("unsent", { filter })).map((r) => r.item.id),
  ).toEqual([id]);
  const held = value(await device.queue()).find((r) => r.id === queued.id)!;
  expect(held.body).toMatchObject({ occurred_at: spelling });
  expect(held.idempotency_key).toBe(queued.idempotency_key);
});

it("projects every accepted spelling to the server's exact instant", async () => {
  for (const spelling of spellings) {
    const served = await client.createItem({
      type: "core.note",
      source: ctx.source,
      tier: "library",
      occurred_at: spelling,
      properties: { body: "canonical instant" },
    });
    expect(served.ok, `${spelling}: ${JSON.stringify(served.error)}`).toBe(
      true,
    );
    trackItem(ctx, served.data.item.id);
    const queued = value(
      await device.create({
        type: "core.note",
        occurredAt: spelling,
        properties: { body: "canonical instant" },
      }),
    );
    const held = value(await device.get(queued.item_id!));
    expect(held.occurred_at, spelling).toBe(served.data.item.occurred_at);
    const filter = `id eq "${held.id}" AND occurred_at eq "${spelling}"`;
    expect(
      value(await device.list({ filter })).map((r) => r.id),
      spelling,
    ).toEqual([held.id]);
    expect(
      value(await device.queue()).find((r) => r.id === queued.id)?.body,
    ).toMatchObject({ occurred_at: spelling });
  }
});
