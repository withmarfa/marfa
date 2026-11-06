/**
 * One request at a time against the loaded instance: an item, its update and
 * delete, lists and searches. Each measurement starts with warm-up requests
 * nobody counts, and its first answer is checked, so a server that ignores a
 * filter or a sort is reported as not honoring it rather than as fast.
 */
import { RARE_WORD, scaleItem } from "../../src/utils/scale/generator.js";
import { spread, versionOf, WARM_UP, type Context } from "./context.js";
import {
  distribution,
  log,
  unavailable,
  type Figure,
  type Unit,
} from "./figures.js";
import {
  connect,
  missingDoor,
  ok,
  parse,
  request,
  type Method,
  type Reply,
  type Target,
} from "./http.js";

interface Row {
  id?: string;
  type?: string;
  source_id?: string;
  properties?: Record<string, unknown>;
}

interface Page {
  data?: Row[];
  next_cursor?: string | null;
}

interface Timed {
  name: string;
  label: string;
  unit?: Unit;
  method?: Method;
  samples: number;
  path: (i: number) => string;
  body?: (i: number) => Promise<object | undefined> | object | undefined;
  /** Says what is wrong with the first answer, or null when it is right. */
  check?: (reply: Reply) => string | null;
  warmUp?: number;
}

async function timed(target: Target, spec: Timed): Promise<Figure> {
  const describe = {
    name: spec.name,
    label: spec.label,
    unit: spec.unit ?? "ms",
  };
  const method = spec.method ?? "GET";
  const send = async (i: number) =>
    request(target, method, spec.path(i), await spec.body?.(i));
  const first = await send(0);
  if (missingDoor(first)) {
    return unavailable(describe, `${method} answered ${first.status}`);
  }
  if (!ok(first)) {
    return unavailable(
      describe,
      `${method} answered ${first.status}: ${first.text.slice(0, 200)}`,
    );
  }
  const wrong = spec.check?.(first) ?? null;
  if (wrong !== null) return unavailable(describe, `not honored: ${wrong}`);
  for (let i = 1; i <= (spec.warmUp ?? WARM_UP); i++) await send(-i);
  const times: number[] = [];
  let errors = 0;
  for (let i = 1; i <= spec.samples; i++) {
    const reply = await send(i);
    if (!ok(reply)) {
      errors++;
      if (errors === 1)
        log(`${spec.name}: ${reply.status} ${reply.text.slice(0, 200)}`);
      continue;
    }
    times.push(reply.ms);
  }
  return distribution({ ...describe, errors }, times);
}

const rowsOf = (reply: Reply) => parse<Page>(reply)?.data ?? [];

/** The position a generator item was made from, read back from its source id. */
function positionOf(row: Row): number | undefined {
  const match = /^scale-(\d+)$/.exec(row.source_id ?? "");
  return match === null ? undefined : Number(match[1]);
}

export async function singleItems(ctx: Context): Promise<void> {
  const target = connect(ctx.state);
  const { ids } = ctx;
  if (ids.length === 0) {
    ctx.record.note(
      "no loaded ids, so the single-item reads and writes were skipped",
    );
    return;
  }
  ctx.record.add(
    await timed(target, {
      name: "get_one_ms",
      label: "GET /items/{id}",
      samples: ctx.repeats * 3,
      path: (i) =>
        `/items/${ids[spread(i + 1_000, ctx.repeats * 3 + 1_000, ids.length)]}`,
    }),
  );

  // Each update is of a different item, read first and untimed for its version.
  const updates = ctx.repeats * 2;
  const updateId = (i: number) =>
    ids[spread(i + WARM_UP, updates + WARM_UP + 1, ids.length)] as string;
  ctx.record.add(
    await timed(target, {
      name: "update_one_ms",
      label: "PATCH /items/{id}, one property",
      method: "PATCH",
      samples: updates,
      path: (i) => `/items/${updateId(i)}`,
      body: async (i) => {
        const current = await request(target, "GET", `/items/${updateId(i)}`);
        return {
          version: versionOf(parse(current)) ?? 1,
          properties: { title: `Edited by the benchmark ${i}` },
        };
      },
    }),
  );

  const doomed =
    ctx.singleIds.length > 0 ? ctx.singleIds : ids.slice(-ctx.repeats * 2);
  if (ctx.singleIds.length === 0) {
    ctx.record.note(
      "no single creates to delete, so the delete step deletes the last loaded items",
    );
  }
  const deletes = Math.min(doomed.length - WARM_UP - 1, ctx.repeats * 2);
  ctx.record.add(
    await timed(target, {
      name: "delete_one_ms",
      label: "DELETE /items/{id}",
      method: "DELETE",
      samples: deletes,
      path: (i) => `/items/${doomed[i + WARM_UP]}`,
    }),
  );
}

/** Walks the default list in pages of 500 to about 90% of the items. */
async function deepCursor(
  ctx: Context,
  target: Target,
): Promise<{ cursor: string | null; depth: number; times: number[] }> {
  const want = Math.floor(ctx.items * 0.9);
  let cursor: string | null = null;
  let depth = 0;
  const times: number[] = [];
  while (depth < want) {
    const query: string =
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const reply = await request(target, "GET", `/items?limit=500${query}`);
    if (!ok(reply)) break;
    times.push(reply.ms);
    const page = parse<Page>(reply);
    depth += page?.data?.length ?? 0;
    const next = page?.next_cursor ?? null;
    if (next === null) break;
    cursor = next;
  }
  return { cursor, depth, times };
}

export async function lists(ctx: Context): Promise<void> {
  const target = connect(ctx.state);
  const samples = ctx.repeats;
  const add = async (spec: Timed) => ctx.record.add(await timed(target, spec));

  await add({
    name: "list_first_ms",
    label: "GET /items, first page of 50",
    samples,
    path: () => "/items?limit=50",
    check: (reply) => (rowsOf(reply).length === 0 ? "the page is empty" : null),
  });

  const walk = await deepCursor(ctx, target);
  ctx.record.add(
    distribution(
      {
        name: "list_walk_page_ms",
        label: "GET /items, a page of 500 while walking the list",
        unit: "ms",
      },
      walk.times,
    ),
  );
  if (walk.cursor === null) {
    ctx.record.add(
      unavailable(
        {
          name: "list_deep_ms",
          label: "GET /items, a deep page of 50",
          unit: "ms",
        },
        "the walk reached no cursor",
      ),
    );
  } else {
    const cursor = encodeURIComponent(walk.cursor);
    await add({
      name: "list_deep_ms",
      label: `GET /items, a page of 50 after ${walk.depth.toLocaleString("en-US")} items`,
      samples,
      path: () => `/items?limit=50&cursor=${cursor}`,
      check: (reply) =>
        rowsOf(reply).length === 0 ? "the page is empty" : null,
    });
  }

  await add({
    name: "list_type_ms",
    label: "GET /items, 50 tasks (type filter)",
    samples,
    path: () => "/items?limit=50&type=core.task",
    check: (reply) => {
      const rows = rowsOf(reply);
      if (rows.length === 0) return "no tasks came back";
      const other = rows.find((row) => row.type !== "core.task");
      return other === undefined
        ? null
        : `a row of type ${other.type ?? "none"} came back`;
    },
  });

  await add({
    name: "list_tag_ms",
    label: "GET /items, 50 tagged garden (tag filter)",
    samples,
    path: () => "/items?limit=50&tags=garden",
    check: (reply) => {
      const rows = rowsOf(reply);
      if (rows.length === 0) return "no items came back";
      const untagged = rows.find((row) => {
        const n = positionOf(row);
        return n !== undefined && !(scaleItem(n).tags ?? []).includes("garden");
      });
      return untagged === undefined
        ? null
        : `item ${untagged.source_id ?? ""} is not tagged garden`;
    },
  });

  await add({
    name: "list_sorted_ms",
    label: "GET /items, 50 tasks by due date (sort on a property)",
    samples,
    path: () =>
      `/items?limit=50&type=core.task&sort=${encodeURIComponent("properties.due_at")}`,
    check: (reply) => {
      const rows = rowsOf(reply);
      if (rows.length === 0) return "no tasks came back";
      const due = rows.flatMap((row) => {
        const value = row.properties?.due_at;
        return typeof value === "string" ? [value] : [];
      });
      if (due.length === 0) return "no row on the first page has a due date";
      for (let i = 1; i < due.length; i++) {
        if ((due[i] as string) > (due[i - 1] as string))
          return "due dates are not in descending order";
      }
      return null;
    },
  });
}

export async function search(ctx: Context): Promise<void> {
  const target = connect(ctx.state);
  const results = (reply: Reply) => rowsOf(reply).length;
  ctx.record.add(
    await timed(target, {
      name: "search_common_ms",
      label: "GET /search, a common word (garden)",
      samples: ctx.repeats,
      path: () => "/search?q=garden&limit=20",
      check: (reply) => (results(reply) === 0 ? "no results" : null),
    }),
  );
  ctx.record.add(
    await timed(target, {
      name: "search_rare_ms",
      label: `GET /search, a rare word (${RARE_WORD})`,
      samples: ctx.repeats,
      path: () => `/search?q=${RARE_WORD}&limit=20`,
      check: (reply) =>
        ctx.items >= 2_000 && results(reply) === 0 ? "no results" : null,
    }),
  );
}
