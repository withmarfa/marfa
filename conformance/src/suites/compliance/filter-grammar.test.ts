/**
 * The grammar of a `filter`, stated from outside: what each kind of field takes
 * and selects, the forms a value is written in, what is refused, how a `state`
 * term meets a door's default state, and the limits at every door that takes
 * an expression.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackFolder,
  trackItem,
  trackView,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let marker: string;

const enc = encodeURIComponent;

beforeAll(async () => {
  ({ client, ctx } = await createTestContext("compliance", "filter-grammar"));
  marker = `grammar${ctx.runId.replace(/[^a-z0-9]/gi, "")}`;
});

afterAll(async () => {
  await cleanup(ctx);
});

async function seed(
  properties: Record<string, unknown>,
  options: {
    tags?: string[];
    state?: "archived" | "trashed";
    source_id?: string;
    type?: string;
  } = {},
): Promise<string> {
  const made = await client.createItem({
    type: options.type ?? "core.note",
    source: ctx.source,
    properties: { body: marker, ...properties },
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.source_id === undefined
      ? {}
      : { source_id: options.source_id }),
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  const id = made.data.item.id;
  trackItem(ctx, id);
  if (options.state !== undefined) {
    const moved = await client.transitionItem(id, options.state);
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
  }
  return id;
}

async function link(
  source_id: string,
  target_id: string,
  edge_type: string,
): Promise<void> {
  const made = await client.createEdge({ source_id, target_id, edge_type });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackEdge(ctx, made.data.edge.id);
}

/** The ids `GET /items` selects from this file's items, in any state named. */
async function listed(filter: string, state?: string): Promise<string[]> {
  const r = await client.listItems({
    source: ctx.source,
    filter,
    limit: 100,
    ...(state === undefined ? {} : { state }),
  });
  expect(r.ok, `${filter}: ${JSON.stringify(r.error)}`).toBe(true);
  return r.data.data.map((item) => item.id).sort();
}

const sorted = (...ids: string[]): string[] => [...ids].sort();

/** Each of a group of ids the listing selects, narrowed to that group. */
async function among(filter: string, group: string[]): Promise<string[]> {
  return (await listed(filter)).filter((id) => group.includes(id));
}

async function searched(filter: string, state?: string): Promise<string[]> {
  const r = await client.search(marker, {
    source: ctx.source,
    filter,
    limit: 100,
    ...(state === undefined ? {} : { state }),
  });
  expect(r.ok, `${filter}: ${JSON.stringify(r.error)}`).toBe(true);
  return r.data.data.map((hit) => hit.item.id).sort();
}

async function counted(
  filter: string,
  state?: string,
): Promise<Record<string, number>> {
  const r = await client.rawRequest<Record<string, number>>(
    `/items/stats?source=${enc(ctx.source)}&filter=${enc(filter)}${state === undefined ? "" : `&state=${state}`}`,
  );
  expect(r.ok, `${filter}: ${JSON.stringify(r.error)}`).toBe(true);
  return r.data;
}

function bulkSelect(filter: string, state?: string) {
  return client.rawRequest<{ ids: string[] }>("/items/bulk-actions", {
    method: "POST",
    body: {
      filter: {
        source: ctx.source,
        filter,
        ...(state === undefined ? {} : { state }),
      },
      action: "update_tags",
      add: [`${marker}-never`],
      dry_run: true,
    },
  });
}

async function bulkSelected(filter: string, state?: string): Promise<string[]> {
  const r = await bulkSelect(filter, state);
  expect(r.status, `${filter}: ${JSON.stringify(r.error)}`).toBe(200);
  return [...r.data.ids].sort();
}

async function viewed(filter: string): Promise<string[]> {
  const made = await client.createView({
    title: `grammar ${marker}`,
    query: { filter: `source eq "${ctx.source}" AND ${filter}` },
  });
  expect(made.status, `${filter}: ${JSON.stringify(made.error)}`).toBe(201);
  trackView(ctx, made.data.item.id);
  const page = await client.listViewItems(made.data.item.id, { limit: 100 });
  expect(page.ok, JSON.stringify(page.error)).toBe(true);
  return page.data.data.map((item) => item.id).sort();
}

interface Door {
  name: string;
  send: (filter: string) => Promise<{
    status: number;
    error?: {
      error: {
        code: string;
        details?: {
          errors?: { path: string }[];
        } & Record<string, unknown>;
      };
    };
    data: unknown;
  }>;
}

/** Every door that takes a `filter`, with the expression as written. */
function doors(): Door[] {
  const view = async (filter: string) => {
    const r = await client.createView({
      title: `door ${marker}`,
      query: { filter },
    });
    if (r.ok) trackView(ctx, r.data.item.id);
    return r;
  };
  const folder = async (filter: string) => {
    const r = await client.createFolder({
      title: `door ${marker}`,
      query: { filter },
    });
    if (r.ok) trackFolder(ctx, r.data.item.id);
    return r;
  };
  return [
    {
      name: "GET /items",
      send: (filter) => client.rawRequest(`/items?filter=${enc(filter)}`),
    },
    {
      name: "GET /items/stats",
      send: (filter) => client.rawRequest(`/items/stats?filter=${enc(filter)}`),
    },
    {
      name: "GET /search",
      send: (filter) =>
        client.rawRequest(`/search?q=${marker}&filter=${enc(filter)}`),
    },
    { name: "POST /items/bulk-actions", send: (filter) => bulkSelect(filter) },
    { name: "POST /views", send: view },
    { name: "POST /folders", send: folder },
  ];
}

describe("every door that takes a filter", () => {
  it("selects the same items by one expression at each door", async () => {
    const chosen = await seed({ rank: `door-${marker}` });
    const passed = await seed({ rank: `other-${marker}` });
    const filter = `properties.rank eq "door-${marker}"`;

    expect(await listed(filter)).toEqual([chosen]);
    expect(await searched(filter)).toEqual([chosen]);
    expect(await counted(filter)).toMatchObject({ active: 1 });
    expect(await bulkSelected(filter)).toEqual([chosen]);
    expect(await viewed(filter)).toEqual([chosen]);
    // The witness that the expression is what narrowed them.
    expect(await listed(`properties.rank eq "other-${marker}"`)).toEqual([
      passed,
    ]);
  });

  const refused: [string, string][] = [
    ["a lower-case and", 'source eq "a" and source eq "b"'],
    ["a lower-case or", 'source eq "a" or source eq "b"'],
    ["an unterminated string", 'source eq "a'],
    ["an unknown operator on a known field", 'source like "a"'],
    ["an operator in the wrong case", 'source EQ "a"'],
    ["a field unknown to the grammar", 'author eq "a"'],
    ["an operator not allowed on an edge", 'edge[x] gt "y"'],
    ["an operator not allowed on a backref", 'backref[x] contains "y"'],
    ["an operator not allowed on tags", 'tags eq "a"'],
    ["exists on a system field", "source exists"],
    ["not_exists on a time field", "occurred_at not_exists"],
    ["exists on the version", "version exists"],
    ["a field and nothing else", "source"],
    ["an operator with no value", "source eq"],
    ["an unquoted word as a value", "source eq a"],
    ["a join with nothing after it", 'source eq "a" AND'],
    ["two conditions with no join", 'source eq "a" source eq "b"'],
    ["a line break between terms", 'source eq "a"\nAND source eq "b"'],
    ["a property with no name", 'properties. eq "a"'],
    ["a property name that starts with a digit", 'properties.1a eq "b"'],
    ["a number with an exponent", "properties.rank eq 1e5"],
    ["a number with no leading digit", "properties.rank eq .5"],
    ["a number with a plus sign", "properties.rank eq +5"],
    ["a value after exists", 'tags exists "a"'],
    ["a value after not_exists", "properties.n not_exists 5"],
    ["a parenthesis", "(properties.n eq 5)"],
    ["AND mixed with OR", 'source eq "a" AND source eq "b" OR source eq "c"'],
  ];

  it.each(refused)(
    "refuses %s at each door with validation_error",
    async (_label, filter) => {
      for (const door of doors()) {
        const r = await door.send(filter);
        expect(r.status, `${door.name}: ${JSON.stringify(r.data)}`).toBe(400);
        expect(r.error?.error.code, door.name).toBe("validation_error");
      }
    },
  );

  it("takes a backref term in a view and refuses it in a folder", async () => {
    const term = `backref[about] eq "01920000-0000-7000-8000-000000000000"`;
    const view = await client.createView({
      title: `backref ${marker}`,
      query: { filter: term },
    });
    expect(view.status, JSON.stringify(view.error)).toBe(201);
    trackView(ctx, view.data.item.id);

    const folder = await client.createFolder({
      title: `backref ${marker}`,
      query: { filter: term },
    });
    expect(folder.status, JSON.stringify(folder.data)).toBe(400);
    expect(folder.error?.error.code).toBe("validation_error");
    const details = folder.error?.error.details as
      { errors?: { path: string }[] } | undefined;
    expect(details?.errors?.[0]?.path).toBe("query.filter");
  });

  it("refuses a filter of only blanks, naming it at each door", async () => {
    for (const blanks of ["", "   ", " \t "]) {
      for (const door of doors()) {
        const r = await door.send(blanks);
        expect(r.status, door.name).toBe(400);
        expect(r.error?.error.code, door.name).toBe("validation_error");
        const details = r.error?.error.details;
        if (door.name === "POST /views" || door.name === "POST /folders") {
          expect(details?.errors?.[0]?.path, door.name).toBe("query.filter");
        } else if (door.name === "POST /items/bulk-actions") {
          expect(details?.empty_parameters, door.name).toEqual([
            "filter.filter",
          ]);
        } else {
          expect(details?.empty_parameters, door.name).toEqual(["filter"]);
        }
      }
    }
  });
});

describe("the limits of a filter", () => {
  const ofLength = (length: number): string => {
    const head = 'properties.body eq "';
    return `${head}${"x".repeat(length - head.length - 1)}"`;
  };
  const conditions = (count: number, logical: "AND" | "OR"): string =>
    Array.from({ length: count }, () => `source eq "${ctx.source}"`).join(
      ` ${logical} `,
    );

  it("takes 2,048 characters and refuses 2,049, at each door", async () => {
    expect(ofLength(2048)).toHaveLength(2048);
    for (const door of doors()) {
      const largest = await door.send(ofLength(2048));
      expect(largest.status, `${door.name}: 2,048`).toBeLessThan(300);
      const past = await door.send(ofLength(2049));
      expect(past.status, `${door.name}: 2,049`).toBe(400);
      expect(past.error?.error.code, door.name).toBe("validation_error");
    }
  });

  it("takes 10 conditions and refuses 11, at each door", async () => {
    for (const logical of ["AND", "OR"] as const) {
      for (const door of doors()) {
        const largest = await door.send(conditions(10, logical));
        expect(largest.status, `${door.name}: 10 ${logical}`).toBeLessThan(300);
        const past = await door.send(conditions(11, logical));
        expect(past.status, `${door.name}: 11 ${logical}`).toBe(400);
        expect(past.error?.error.code, door.name).toBe("validation_error");
      }
    }
  });

  describe.each([["/items?"], ["/items/stats?"]])("%s", (door) => {
    const asked = (query: string) => client.rawRequest(`${door}${query}`);
    const target = "01920000-0000-7000-8000-000000000000";

    it("counts an edge key as one of the 10 conditions", async () => {
      const key = `edge[about]=${target}`;
      const nine = await asked(
        `filter=${enc(conditions(9, "AND"))}&${enc("edge[about]")}=${target}`,
      );
      expect(nine.status, `9 and ${key}`).toBe(200);
      const ten = await asked(
        `filter=${enc(conditions(10, "AND"))}&${enc("edge[about]")}=${target}`,
      );
      expect(ten.status, `10 and ${key}`).toBe(400);
      expect(ten.error?.error.code).toBe("validation_error");
      const backref = await asked(
        `filter=${enc(conditions(10, "AND"))}&${enc("backref[about]")}=${target}`,
      );
      expect(backref.status, "10 and a backref key").toBe(400);
      expect(backref.error?.error.code).toBe("validation_error");
    });

    it("refuses OR beside an edge key and a backref key, and takes them beside AND", async () => {
      const or = 'type eq "core.note" OR type eq "core.bookmark"';
      const and = 'type eq "core.note" AND state eq "active"';
      for (const name of ["edge[about]", "backref[about]"]) {
        const key = `${enc(name)}=${target}`;
        // The witnesses: the OR alone and the AND with the key are taken.
        expect((await asked(`filter=${enc(or)}`)).status, name).toBe(200);
        expect((await asked(`${key}&filter=${enc(and)}`)).status, name).toBe(
          200,
        );
        const refused = await asked(`${key}&filter=${enc(or)}`);
        expect(refused.status, `${name} beside OR`).toBe(400);
        expect(refused.error?.error.code).toBe("validation_error");
      }
    });

    it("counts an edge key's clause and its AND toward the 2,048 characters", async () => {
      const added = ` AND edge[about] eq "${target}"`.length;
      const shorthand = `${enc("edge[about]")}=${target}`;
      const fits = await asked(
        `filter=${enc(ofLength(2048 - added))}&${shorthand}`,
      );
      expect(fits.status, "a total of 2,048").toBe(200);
      const past = await asked(
        `filter=${enc(ofLength(2049 - added))}&${shorthand}`,
      );
      expect(past.status, "a total of 2,049").toBe(400);
      expect(past.error?.error.code).toBe("validation_error");
      const backrefAdded = ` AND backref[about] eq "${target}"`.length;
      const backref = await asked(
        `filter=${enc(ofLength(2049 - backrefAdded))}&${enc("backref[about]")}=${target}`,
      );
      expect(backref.status, "a total of 2,049 with a backref key").toBe(400);
      expect(backref.error?.error.code).toBe("validation_error");
      // The witness: the same filter is within the limit with no key beside it.
      const alone = await asked(`filter=${enc(ofLength(2049 - added))}`);
      expect(alone.status, "the filter alone").toBe(200);
    });
  });
});

describe("a value in a filter", () => {
  it("takes a quoted string, a number and a boolean", async () => {
    const text = await seed({ held: 'say "hi"' });
    const negative = await seed({ held: -1.5 });
    const whole = await seed({ held: 7 });
    const yes = await seed({ held: true });
    const no = await seed({ held: false });
    const group = [text, negative, whole, yes, no];

    expect(await among('properties.held eq "say \\"hi\\""', group)).toEqual([
      text,
    ]);
    expect(await among("properties.held eq -1.5", group)).toEqual([negative]);
    expect(await among("properties.held eq 7", group)).toEqual([whole]);
    expect(await among("properties.held eq 7.0", group)).toEqual([whole]);
    expect(await among("properties.held eq 7.", group)).toEqual([whole]);
    expect(await among("properties.held eq true", group)).toEqual([yes]);
    expect(await among("properties.held eq false", group)).toEqual([no]);
  });
});

describe("the joins of a filter", () => {
  it("selects by AND the items every condition selects, and by OR the items any selects", async () => {
    const both = await seed({ a: `a-${marker}`, b: `b-${marker}` });
    const onlyA = await seed({ a: `a-${marker}` });
    const onlyB = await seed({ b: `b-${marker}` });
    const neither = await seed({ a: `c-${marker}` });
    const group = [both, onlyA, onlyB, neither];
    const a = `properties.a eq "a-${marker}"`;
    const b = `properties.b eq "b-${marker}"`;

    expect(await among(`${a} AND ${b}`, group)).toEqual([both]);
    expect(await among(`${a} OR ${b}`, group)).toEqual(
      sorted(both, onlyA, onlyB),
    );
  });

  it("narrows by the request's other keys what OR selects, on the listing, the stats and the search", async () => {
    const note = await seed({ a: `narrow-${marker}` });
    const entity = await seed(
      { name: `narrow-${marker}`, a: `narrow-${marker}` },
      { type: "core.entity" },
    );
    const filter = `properties.a eq "narrow-${marker}" OR properties.b eq "narrow-${marker}"`;

    expect(await listed(filter)).toEqual(sorted(note, entity));
    const r = await client.listItems({
      source: ctx.source,
      type: "core.note",
      filter,
      limit: 100,
    });
    expect(r.data.data.map((item) => item.id)).toEqual([note]);

    const stats = await client.rawRequest<Record<string, number>>(
      `/items/stats?source=${enc(ctx.source)}&type=core.note&filter=${enc(filter)}`,
    );
    expect(stats.status, JSON.stringify(stats.error)).toBe(200);
    expect(stats.data).toEqual({ active: 1 });
    const found = await client.search(marker, {
      source: ctx.source,
      type: "core.note",
      filter,
      limit: 100,
    });
    expect(found.ok, JSON.stringify(found.error)).toBe(true);
    expect(found.data.data.map((hit) => hit.item.id)).toEqual([note]);
  });
});

describe("a comparison of text", () => {
  it("compares the whole value, with regard to case, in code point order", async () => {
    const upper = await seed({ rank: "B" });
    const lower = await seed({ rank: "a" });
    const later = await seed({ rank: "b" });
    const accent = await seed({ rank: "é" });
    const longer = await seed({ rank: "bb" });
    const group = [upper, lower, later, accent, longer];
    // U+FFFD sorts after an astral character in UTF-16 and before it by code
    // point.
    const replacement = await seed({ ladder: "�" });
    const astral = await seed({ ladder: "😀" });

    expect(
      await among('properties.ladder gt "�"', [replacement, astral]),
    ).toEqual([astral]);
    expect(await among('properties.rank eq "b"', group)).toEqual([later]);
    expect(await among('properties.rank neq "b"', group)).toEqual(
      sorted(upper, lower, accent, longer),
    );
    expect(await among('properties.rank gt "b"', group)).toEqual(
      sorted(accent, longer),
    );
    expect(await among('properties.rank gte "b"', group)).toEqual(
      sorted(later, accent, longer),
    );
    expect(await among('properties.rank lt "a"', group)).toEqual([upper]);
    expect(await among('properties.rank lte "a"', group)).toEqual(
      sorted(upper, lower),
    );
  });

  it("compares a system field's whole value, with regard to case", async () => {
    const path = `Grammar/${marker}/One`;
    const held = await seed({}, { source_id: path });
    const folded = await seed({}, { source_id: path.toLowerCase() });
    const group = [held, folded];

    expect(await among(`source_id eq "${path}"`, group)).toEqual([held]);
    expect(await among(`source_id neq "${path}"`, group)).toEqual([folded]);
    expect(await among(`id eq "${held}"`, group)).toEqual([held]);
    expect(await among(`id neq "${held}"`, group)).toEqual([folded]);
    expect(await among(`source_id gt "${path}"`, group)).toEqual([folded]);
    expect(await among(`source_id lt "${path.toLowerCase()}"`, group)).toEqual([
      held,
    ]);
    expect(await among(`source eq "${ctx.source}"`, group)).toEqual(
      sorted(...group),
    );
    expect(await among(`source neq "${ctx.source}"`, group)).toEqual([]);
    expect(
      await among(`source eq "${ctx.source.toUpperCase()}"`, group),
    ).toEqual([]);

    const archived = await seed({}, { state: "archived" });
    const byState = (await listed('state neq "active"', "any")).filter(
      (id) => id === held || id === archived,
    );
    expect(byState).toEqual([archived]);
    const upperState = await listed('state eq "ACTIVE"', "any");
    expect(upperState).toEqual([]);
  });

  it("compares a type term with the identifier alone, not the types under it", async () => {
    const entity = await seed({ name: "entity" }, { type: "core.entity" });
    const person = await seed(
      { name: "person" },
      { type: "core.entity.person" },
    );
    const group = [entity, person];

    expect(await among('type eq "core.entity"', group)).toEqual([entity]);
    expect(await among('type neq "core.entity"', group)).toEqual([person]);
    // The witness: the `type` key takes the subtree.
    const r = await client.listItems({
      source: ctx.source,
      type: "core.entity",
      limit: 100,
    });
    const held = r.data.data.map((item) => item.id);
    expect(held).toEqual(expect.arrayContaining(group));
  });

  it("compares version as a number", async () => {
    const first = await seed({});
    const changed = await seed({});
    const update = await client.updateItem(changed, {
      version: 1,
      properties: { rank: "changed" },
    });
    expect(update.data.item.version).toBe(2);
    const group = [first, changed];

    expect(await among("version eq 1", group)).toEqual([first]);
    expect(await among("version gt 1", group)).toEqual([changed]);
    expect(await among("version neq 1", group)).toEqual([changed]);
  });

  it("selects no item whose property is absent or null, with any operator that takes a value", async () => {
    const held = await seed({ rank: "held" });
    const absent = await seed({});
    const nulled = await seed({ rank: null });
    const group = [held, absent, nulled];

    const numbered = await seed({ score: 3 });
    const unscored = [numbered, absent, nulled];
    expect(await among("properties.score neq 5", unscored)).toEqual([numbered]);
    expect(await among("properties.score lt 5", unscored)).toEqual([numbered]);
    expect(await among('properties.rank neq "other"', group)).toEqual([held]);
    expect(await among('properties.rank gt ""', group)).toEqual([held]);
    expect(await among('properties.rank lte "zzz"', group)).toEqual([held]);
    expect(await among('properties.rank contains "el"', group)).toEqual([held]);
    expect(await among('properties.rank starts_with "h"', group)).toEqual([
      held,
    ]);
    // The witness: both are items the presence test finds.
    expect(await among("properties.rank not_exists", group)).toEqual(
      sorted(absent, nulled),
    );
  });
});

describe("contains and starts_with", () => {
  it("selects a value that holds the text, and one that begins with it", async () => {
    const heron = await seed({ note: "a heron by the pond" });
    const pond = await seed({ note: "pond" });
    const none = await seed({ note: "marsh" });
    const group = [heron, pond, none];

    expect(await among('properties.note contains "pond"', group)).toEqual(
      sorted(heron, pond),
    );
    expect(await among('properties.note starts_with "pond"', group)).toEqual([
      pond,
    ]);
    expect(await among('source starts_with "conformance-"', group)).toEqual(
      sorted(...group),
    );
    expect(await among('type contains "NOTE"', group)).toEqual(
      sorted(...group),
    );
    expect(await among('type starts_with "CORE.no"', group)).toEqual(
      sorted(...group),
    );
  });

  it("selects by id, state and source_id as it does by a property", async () => {
    const path = `Grammar/${marker}/Deep`;
    const held = await seed({}, { source_id: path });
    const archived = await seed({}, { state: "archived" });
    const group = [held, archived];
    const anyState = async (filter: string): Promise<string[]> =>
      (await listed(filter, "any")).filter((id) => group.includes(id));

    expect(await anyState(`id contains "${held.slice(-12)}"`)).toEqual([held]);
    expect(await anyState(`id starts_with "${archived}"`)).toEqual([archived]);
    expect(await anyState('state contains "RCHIV"')).toEqual([archived]);
    expect(await anyState('state starts_with "arch"')).toEqual([archived]);
    expect(await anyState('state starts_with "act"')).toEqual([held]);
    expect(await anyState(`source_id contains "/${marker}/"`)).toEqual([held]);
    expect(await anyState(`source_id starts_with "grammar/${marker}"`)).toEqual(
      [held],
    );
    expect(await anyState('source_id starts_with "Other"')).toEqual([]);
  });

  it("folds ASCII case and no other", async () => {
    const ascii = await seed({ note: "HERON" });
    const accent = await seed({ note: "ÉCLAIR" });
    const group = [ascii, accent];

    expect(await among('properties.note contains "heron"', group)).toEqual([
      ascii,
    ]);
    expect(await among('properties.note starts_with "her"', group)).toEqual([
      ascii,
    ]);
    expect(await among('properties.note contains "ÉCLAIR"', group)).toEqual([
      accent,
    ]);
    expect(await among('properties.note contains "éclair"', group)).toEqual([]);
    expect(await among('properties.note starts_with "écl"', group)).toEqual([]);
  });

  it("matches a percent sign, an underscore and a backslash as themselves", async () => {
    const percent = await seed({ note: "50%off" });
    const underscore = await seed({ note: "web_gallery" });
    const backslash = await seed({ note: "C:\\temp" });
    const plain = await seed({ note: "50 off webXgallery Cxtemp" });
    const group = [percent, underscore, backslash, plain];

    expect(await among('properties.note contains "0%o"', group)).toEqual([
      percent,
    ]);
    expect(await among('properties.note contains "web_g"', group)).toEqual([
      underscore,
    ]);
    expect(await among('properties.note contains "C:\\\\t"', group)).toEqual([
      backslash,
    ]);
    expect(await among('properties.note starts_with "50%"', group)).toEqual([
      percent,
    ]);
    expect(await among('properties.note starts_with "web_"', group)).toEqual([
      underscore,
    ]);
    expect(await among('properties.note starts_with "C:\\\\"', group)).toEqual([
      backslash,
    ]);
    // The witness: each is a wildcard to an engine that reads it as one, and
    // the plain item would match it there.
    expect(await among('properties.note contains "web"', group)).toEqual(
      sorted(underscore, plain),
    );
  });
});

describe("a tags term", () => {
  it("takes a whole tag, with regard to case", async () => {
    const tag = `Tag-${marker}`;
    const exact = await seed({}, { tags: [tag, "other"] });
    const longer = await seed({}, { tags: [`${tag}-more`] });
    const folded = await seed({}, { tags: [tag.toLowerCase()] });
    const group = [exact, longer, folded];

    expect(await among(`tags contains "${tag}"`, group)).toEqual([exact]);
  });

  it("selects by exists the items with a tag, and by not_exists the items with none", async () => {
    const tagged = await seed({}, { tags: [`one-${marker}`] });
    const untagged = await seed({});
    const group = [tagged, untagged];

    expect(await among("tags exists", group)).toEqual([tagged]);
    expect(await among("tags not_exists", group)).toEqual([untagged]);
  });
});

describe("an edge term and a backref term", () => {
  let anchor: string;
  let otherAnchor: string;
  let toAnchor: string;
  let toOther: string;
  let noEdge: string;
  let group: string[];

  beforeAll(async () => {
    anchor = await seed({ role: "anchor" });
    otherAnchor = await seed({ role: "other anchor" });
    toAnchor = await seed({ role: "to anchor" });
    toOther = await seed({ role: "to other" });
    noEdge = await seed({ role: "no edge" });
    await link(toAnchor, anchor, "about");
    await link(toOther, otherAnchor, "about");
    // An edge of another type, which no term below reads.
    await link(noEdge, anchor, "references");
    group = [anchor, otherAnchor, toAnchor, toOther, noEdge];
  });

  it("selects by edge neq every item without that edge, an item with no edge of the type among them", async () => {
    expect(await among(`edge[about] neq "${anchor}"`, group)).toEqual(
      sorted(anchor, otherAnchor, toOther, noEdge),
    );
  });

  it("selects by edge exists the items with an outbound edge of the type, and by not_exists the items with none", async () => {
    expect(await among("edge[about] exists", group)).toEqual(
      sorted(toAnchor, toOther),
    );
    expect(await among("edge[about] not_exists", group)).toEqual(
      sorted(anchor, otherAnchor, noEdge),
    );
  });

  it("selects by backref eq the items that an edge of the type from that item points at", async () => {
    expect(await among(`backref[about] eq "${toAnchor}"`, group)).toEqual([
      anchor,
    ]);
    const shorthand = await client.listItems({
      source: ctx.source,
      backref: { about: toAnchor },
      limit: 100,
    });
    expect(shorthand.data.data.map((item) => item.id)).toEqual([anchor]);
  });

  it("selects by backref neq every item without that inbound edge, an item with no inbound edge of the type among them", async () => {
    expect(await among(`backref[about] neq "${toAnchor}"`, group)).toEqual(
      sorted(otherAnchor, toAnchor, toOther, noEdge),
    );
  });

  it("selects by backref exists the items with an inbound edge of the type, and by not_exists the items with none", async () => {
    expect(await among("backref[about] exists", group)).toEqual(
      sorted(anchor, otherAnchor),
    );
    expect(await among("backref[about] not_exists", group)).toEqual(
      sorted(toAnchor, toOther, noEdge),
    );
  });

  it("selects by an edge key and a backref key as the full form does, on the listing and the stats", async () => {
    const forms: [string, string, string[]][] = [
      [`edge[about]=${anchor}`, `edge[about] eq "${anchor}"`, [toAnchor]],
      [
        `backref[about]=${toAnchor}`,
        `backref[about] eq "${toAnchor}"`,
        [anchor],
      ],
    ];
    for (const [key, full, rows] of forms) {
      const [name, value] = key.split("=") as [string, string];
      const keyed = `source=${enc(ctx.source)}&${enc(name)}=${value}`;
      const fullForm = `source=${enc(ctx.source)}&filter=${enc(full)}`;
      const byKey = await client.rawRequest<{ data: { id: string }[] }>(
        `/items?${keyed}`,
      );
      expect(byKey.data.data.map((item) => item.id)).toEqual(rows);
      const byFull = await client.rawRequest<{ data: { id: string }[] }>(
        `/items?${fullForm}`,
      );
      expect(byFull.data.data.map((item) => item.id)).toEqual(rows);
      const countedByKey = await client.rawRequest<Record<string, number>>(
        `/items/stats?${keyed}`,
      );
      expect(countedByKey.data).toEqual({ active: rows.length });
      const countedByFull = await client.rawRequest<Record<string, number>>(
        `/items/stats?${fullForm}`,
      );
      expect(countedByFull.data).toEqual({ active: rows.length });
    }
  });

  it("selects by an edge eq term and a backref eq term on every door as the listing does", async () => {
    const edgeTerm = `edge[about] eq "${anchor}" AND properties.role eq "to anchor"`;
    const backrefTerm = `backref[about] eq "${toAnchor}" AND properties.role eq "anchor"`;
    for (const [term, rows] of [
      [edgeTerm, [toAnchor]],
      [backrefTerm, [anchor]],
    ] as const) {
      expect(await listed(term), term).toEqual(rows);
      expect(await searched(term), term).toEqual(rows);
      expect(await bulkSelected(term), term).toEqual(rows);
      expect(await viewed(term), term).toEqual(rows);
      expect(await counted(term), term).toEqual({ active: 1 });
    }
  });

  it("answers an edge term the same on the doors beyond the listing", async () => {
    const filter = `edge[about] neq "${anchor}" AND properties.role eq "no edge"`;
    expect(await searched(filter)).toEqual([noEdge]);
    expect(await bulkSelected(filter)).toEqual([noEdge]);
    expect(await viewed(filter)).toEqual([noEdge]);
    expect(await counted(filter)).toMatchObject({ active: 1 });
  });
});

describe("a state term", () => {
  let active: string;
  let archived: string;
  let trashed: string;
  const inFile = `properties.stage eq "state-term"`;

  beforeAll(async () => {
    active = await seed({ stage: "state-term" });
    archived = await seed({ stage: "state-term" }, { state: "archived" });
    trashed = await seed({ stage: "state-term" }, { state: "trashed" });
  });

  const archivedTerm = `state eq "archived" AND ${inFile}`;
  const trashedTerm = `state eq "trashed" AND ${inFile}`;

  it("meets the default state when no state is named, so state eq archived alone selects nothing", async () => {
    // The witnesses: the item is there to select, under each door's own name.
    expect(await listed(inFile, "any")).toEqual(
      sorted(active, archived, trashed),
    );
    expect(await listed(inFile)).toEqual([active]);
    expect(await searched(inFile)).toEqual([active]);
    expect(await bulkSelected(inFile)).toEqual([active]);

    expect(await listed(archivedTerm)).toEqual([]);
    expect(await searched(archivedTerm)).toEqual([]);
    expect(await bulkSelected(archivedTerm)).toEqual([]);
    expect(await listed(`state eq "active" AND ${inFile}`)).toEqual([active]);
  });

  it("meets a named state, so the two must agree to select an item", async () => {
    expect(await listed(archivedTerm, "archived")).toEqual([archived]);
    expect(await listed(archivedTerm, "any")).toEqual([archived]);
    expect(await listed(archivedTerm, "active")).toEqual([]);
    expect(await searched(archivedTerm, "archived")).toEqual([archived]);
    expect(await searched(archivedTerm, "active")).toEqual([]);
    expect(await bulkSelected(archivedTerm, "archived")).toEqual([archived]);
    expect(await bulkSelected(archivedTerm, "active")).toEqual([]);
    expect(await counted(archivedTerm, "archived")).toMatchObject({
      archived: 1,
    });
    expect(await counted(archivedTerm, "active")).not.toHaveProperty(
      "archived",
    );
  });

  it("counts on GET /items/stats among every state when none is named", async () => {
    const counts = await counted(archivedTerm);
    expect(counts).toMatchObject({ archived: 1 });
    expect(counts).not.toHaveProperty("active");
    expect(await counted(trashedTerm)).toEqual({ trashed: 1 });
    // The witness: every item is counted without the term.
    expect(await counted(inFile)).toMatchObject({
      active: 1,
      archived: 1,
      trashed: 1,
    });
  });

  it("meets a view's own default of active and archived, so state eq archived selects in a view", async () => {
    expect(await viewed(archivedTerm)).toEqual([archived]);
    expect(await viewed(inFile)).toEqual(sorted(active, archived));
    expect(await viewed(trashedTerm)).toEqual([]);
  });
});
