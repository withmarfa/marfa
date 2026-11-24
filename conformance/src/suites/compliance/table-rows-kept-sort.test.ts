import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { RowOperation } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

// A dedicated server lets the fixture hold cleanup without delaying other tests.
const HELD = "hold:housekeeping:table-row-cleanup";
// A page read without kept keys fails, so one that answers under it was read from them.
const SCANNED = "fail:table-rows-scan";

let server: FreshServer;
let client: MarfaClient;
let management: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("table-rows-kept-sort");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

type Held = Map<string, string | number | undefined>;
type Cleaned = {
  keyed: number;
  keys_removed: number;
  largest_key_page: number;
  pages: number;
};

async function write(item: string, operations: RowOperation[]) {
  const res = await client.writeRows(item, "lines", { operations });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data.results.map((r) => r.id);
}

async function walk(
  item: string,
  sort: string,
  direction: "asc" | "desc",
  from?: { seen: string[]; cursor: string },
): Promise<string[]> {
  const seen: string[] = [...(from?.seen ?? [])];
  let cursor: string | undefined = from?.cursor;
  do {
    const res = await client.listRows(item, "lines", {
      sort,
      direction,
      limit: 1000,
      cursor,
    });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    seen.push(...res.data.data.map((r) => r.id));
    cursor = res.data.next_cursor ?? undefined;
  } while (cursor);
  return seen;
}

/** The order `tables/rows-sort` states: rows without a value last, a tie by id ascending. */
function expected(values: Held, direction: "asc" | "desc"): string[] {
  const byId = [...values.keys()].sort();
  const held = byId.filter((id) => values.get(id) !== undefined);
  const none = byId.filter((id) => values.get(id) === undefined);
  held.sort((a, b) => {
    const x = values.get(a)!;
    const y = values.get(b)!;
    const by = x < y ? -1 : x > y ? 1 : 0;
    return direction === "asc" ? by : -by;
  });
  return [...held, ...none];
}

/** Lets the held job go, then runs it until a run finds nothing to key or remove. */
async function settle(since: string): Promise<Cleaned[]> {
  await server.clearFault(HELD);
  const runs = new Map<string, Cleaned>();
  for (;;) {
    const job = (await management.listHousekeeping()).data.data.find(
      (row) => row.name === "table-row-cleanup",
    )!;
    if (!job.running_since) {
      if (
        job.last_started_at &&
        job.last_started_at > since &&
        job.last_finished_at &&
        job.last_finished_at >= job.last_started_at
      ) {
        expect(job.last_outcome).toBe("succeeded");
        const run = job.last_result as Cleaned;
        expect(run.largest_key_page).toBeLessThanOrEqual(1_000);
        runs.set(job.last_started_at, run);
        if (run.keyed === 0 && run.keys_removed === 0) {
          return [...runs.values()];
        }
      }
      await management.runHousekeeping("table-row-cleanup");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const total = (runs: Cleaned[], of: "keyed" | "keys_removed") =>
  runs.reduce((sum, run) => sum + run[of], 0);

it("keeps large table pages in order during key fills, row writes, and column changes", async () => {
  const type = `user.rows-kept-sort-${randomUUID()}`;
  const columns = {
    rank: { type: "integer" },
    label: { type: "string" },
    score: { type: "number" },
  };
  const table = { columns, order: "rank" };
  const made = await client.registerType({
    id: type,
    fields: { title: { type: "string" } },
    tables: { lines: table },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const created = await client.createItem({
    type,
    properties: { title: "Kept sort" },
  } as never);
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  const item = created.data.item.id;

  const count = 20_000;
  const label = (at: number) =>
    `l${String((at * 7_919) % count).padStart(5, "0")}`;
  const labels: Held = new Map();
  const scores: Held = new Map();
  for (let start = 0; start < count; start += 1_000) {
    const ids = await write(
      item,
      Array.from(
        { length: 1_000 },
        (_, n) =>
          ({
            op: "put",
            values: {
              rank: start + n,
              label: label(start + n),
              score: ((start + n) * 31) % count,
            },
          }) as RowOperation,
      ),
    );
    ids.forEach((id, n) => {
      labels.set(id, label(start + n));
      scores.set(id, ((start + n) * 31) % count);
    });
  }
  const ids = [...labels.keys()];

  const sorted = async (column: string, values: Held) => {
    for (const direction of ["asc", "desc"] as const) {
      expect(await walk(item, `values.${column}`, direction)).toEqual(
        expected(values, direction),
      );
    }
  };
  const change = async (operations: RowOperation[]) => {
    const written = await write(item, operations);
    operations.forEach((operation, n) => {
      if (operation.op === "delete") {
        labels.delete(operation.id);
        scores.delete(operation.id);
        return;
      }
      const values = operation.values as { label?: string; score?: number };
      for (const [column, held] of [
        ["label", labels],
        ["score", scores],
      ] as const) {
        if (operation.op === "put" || column in values) {
          held.set(written[n]!, values[column]);
        }
      }
    });
  };

  // A second change would schedule another run and could replace the result under test.
  for (const [column, values, operations] of [
    [
      "label",
      labels,
      [
        { op: "put", values: { rank: -1, label: "l00000a", score: -5 } },
        { op: "patch", id: ids[0]!, values: { label: "l99999" } },
        { op: "delete", id: ids[2]! },
      ],
    ],
    [
      "score",
      scores,
      [
        { op: "patch", id: ids[1]!, values: { score: 0.5 } },
        { op: "put", values: { rank: -4, label: "l00000b", score: -6 } },
      ],
    ],
  ] as const) {
    await server.setFault(HELD);
    const sortedAt = new Date().toISOString();
    await sorted(column, values);
    await server.waitForHold(HELD);
    await change([...operations]);
    await sorted(column, values);
    const begun = await client.listRows(item, "lines", {
      sort: `values.${column}`,
      direction: "desc",
      limit: 1000,
    });
    expect(begun.status, JSON.stringify(begun.error)).toBe(200);
    await server.setFault(`${SCANNED}=lines@always`);
    const filling = await client.listRows(item, "lines", {
      sort: `values.${column}`,
      limit: 1,
    });
    expect(filling.status).toBe(500);
    expect(total(await settle(sortedAt), "keyed")).toBeGreaterThanOrEqual(
      count,
    );
    const from = {
      seen: begun.data.data.map((r) => r.id),
      cursor: begun.data.next_cursor!,
    };
    expect(await walk(item, `values.${column}`, "desc", from)).toEqual(
      expected(values, "desc"),
    );
    await sorted(column, values);
    await server.clearFault(SCANNED);
  }

  await change([
    { op: "put", values: { rank: -2, label: "a", score: count } },
    { op: "put", values: { rank: -3 } },
    { op: "patch", id: ids[3]!, values: { label: "m", score: -1 } },
    { op: "delete", id: ids[4]! },
  ]);
  await sorted("label", labels);
  await sorted("score", scores);

  await server.setFault(HELD);
  const changedAt = new Date().toISOString();
  const changed = await client.replaceType(
    type,
    {
      id: type,
      fields: { title: { type: "string" } },
      tables: {
        lines: {
          ...table,
          columns: { rank: columns.rank, score: { type: "string" } },
        },
      },
    },
    true,
  );
  expect(changed.status, JSON.stringify(changed.error)).toBe(200);
  for (const id of scores.keys()) scores.set(id, undefined);
  await sorted("score", scores);
  expect(total(await settle(changedAt), "keys_removed")).toBeGreaterThanOrEqual(
    2 * count,
  );

  await server.setFault(HELD);
  const resortedAt = new Date().toISOString();
  await sorted("score", scores);
  await change([
    { op: "patch", id: ids[6]!, values: { score: "b" } },
    { op: "patch", id: ids[7]!, values: { score: "a" } },
  ]);
  await sorted("score", scores);
  expect(total(await settle(resortedAt), "keyed")).toBeGreaterThanOrEqual(
    count,
  );
  await change([{ op: "patch", id: ids[8]!, values: { score: "c" } }]);
  await server.setFault(`${SCANNED}=lines@always`);
  await sorted("score", scores);
  await server.clearFault(SCANNED);
}, 600_000);
