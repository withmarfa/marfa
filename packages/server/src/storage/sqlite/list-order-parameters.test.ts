/**
 * A listing that would bind more values than one statement may is still read,
 * as one range and a sort, and answers what the sliced read would.
 *
 * Every slice repeats the listing's other conditions, so what a statement
 * binds is the slices times what those conditions bind: one value for each
 * tag, and a copy of the credential's type map in each `backref` term, as well
 * as the grants. SQLite refuses a statement past its variable limit.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
} from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  type TypeSchema,
} from "@withmarfa/shared";
import { createSqliteStorage } from "./index.js";
import type { ItemFilters } from "../interface.js";
import { MAX_STATEMENT_PARAMETERS, typeSlices } from "../type-slices.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;

const WIDE = "user.wide";
const WIDE_COUNT = 60;
const DEEP = "user.deep";
const DEEP_COUNT = 40;
const TAGS = Array.from(
  { length: 300 },
  (_, i) => `tag-${String(i).padStart(3, "0")}`,
);
const PER_TYPE = 4;
const PAGE = 7;

const subtypes = (root: string, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `${root}.t${String(i).padStart(2, "0")}`,
  );
const WIDE_TYPES = [WIDE, ...subtypes(WIDE, WIDE_COUNT)];
const DEEP_TYPES = [DEEP, ...subtypes(DEEP, DEEP_COUNT)];
// Stored with no schema: the read must still reach them.
const GHOSTS = [`${WIDE}.ghost`, `${DEEP}.ghost`];

let directory: string;
let storage: Storage;
let sent: { sql: string; args: InArgs }[] | null = null;
const registered: string[] = [];

function register(id: string, parent?: string): void {
  registerTypeSchema({
    id,
    name: id,
    description: "test",
    parent,
    version: 1,
    fields: {},
  } as unknown as TypeSchema);
  registered.push(id);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-list-order-parameters-"));
  storage = await createSqliteStorage(join(directory, "test.db"));
  for (const types of [WIDE_TYPES, DEEP_TYPES]) {
    for (const [i, id] of types.entries())
      register(id, i === 0 ? undefined : types[0]);
  }
  for (const type of [...WIDE_TYPES, ...DEEP_TYPES, ...GHOSTS]) {
    for (let i = 1; i <= PER_TYPE; i++) {
      const id = `${type}#${String(i)}`;
      await storage.__sqliteRun(
        `INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
         VALUES (?, ?, 'active', 'library', jsonb('{}'), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`,
        [id, type],
      );
      // Item 1 holds every tag, item 2 all but the last, the rest none.
      if (i <= 2) {
        await storage.__sqliteRun(
          "INSERT INTO metadata (item_id, tags) VALUES (?, ?)",
          [id, JSON.stringify(i === 1 ? TAGS : TAGS.slice(0, -1))],
        );
      }
    }
  }
  const driver = Object.getPrototypeOf(createClient({ url: ":memory:" })) as {
    execute: (
      this: Client,
      statement: InStatement | string,
      args?: InArgs,
    ) => Promise<ResultSet>;
  };
  const execute = driver.execute;
  vi.spyOn(driver, "execute").mockImplementation(function (
    this: Client,
    statement,
    args,
  ) {
    if (sent) {
      sent.push(
        typeof statement === "string"
          ? { sql: statement, args: args ?? [] }
          : { sql: statement.sql, args: statement.args ?? [] },
      );
    }
    return execute.call(this, statement, args);
  });
});

afterEach(() => {
  sent = null;
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const id of registered) unregisterTypeSchema(id);
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Every id of these types, newest first: the times tie, so by id, descending. */
function idsOf(types: string[], keep: (i: number) => boolean): string[] {
  return types
    .flatMap((type) =>
      Array.from({ length: PER_TYPE }, (_, i) => i + 1)
        .filter(keep)
        .map((i) => `${type}#${String(i)}`),
    )
    .sort((a, b) => compare(b, a));
}

/** The ids a listing walks, and the statements it sent to read `items`. */
async function walk(
  filters: ItemFilters,
): Promise<{ ids: string[]; statements: { sql: string; args: InArgs }[] }> {
  const ids: string[] = [];
  const statements: { sql: string; args: InArgs }[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    sent = [];
    const page = await storage.items.list({ ...filters, limit: PAGE, cursor });
    statements.push(
      ...sent.filter(({ sql }) => /from\s+["`]?items["`]?[\s,]/i.test(sql)),
    );
    sent = null;
    ids.push(...page.data.map((item) => item.id));
    if (page.next_cursor === null) return { ids, statements };
    cursor = page.next_cursor;
  }
  throw new Error("a listing never ended");
}

const sliced = ({ sql }: { sql: string }) => /union all/i.test(sql);

describe("a listing whose filters repeat in every slice", () => {
  it("has the slices the cases below depend on", () => {
    expect(typeSlices({ type: WIDE })?.length).toBeGreaterThan(120);
    expect(typeSlices({ type: DEEP })?.length).toBeGreaterThan(80);
  });

  it("reads a few tags in slices", async () => {
    const { ids, statements } = await walk({
      type: WIDE,
      tags: TAGS.slice(0, 3),
    });
    expect(ids).toEqual(idsOf([...WIDE_TYPES, `${WIDE}.ghost`], (i) => i <= 2));
    expect(statements.every(sliced)).toBe(true);
  });

  it("answers many tags over many slices, which would bind more values than a statement may", async () => {
    const { ids, statements } = await walk({ type: WIDE, tags: TAGS });
    expect(ids).toEqual(
      idsOf([...WIDE_TYPES, `${WIDE}.ghost`], (i) => i === 1),
    );
    expect(ids.length).toBeGreaterThan(PAGE);
    expect(statements.some(sliced)).toBe(false);
    for (const { args } of statements)
      expect(args.length).toBeLessThanOrEqual(MAX_STATEMENT_PARAMETERS);
  });

  it("answers grants for every type and a filter that names the type map many times", async () => {
    const grants = DEEP_TYPES;
    const reach = { allowed: grants, excluded: [] };
    const filter = Array.from(
      { length: 10 },
      () => "backref[about] not_exists",
    ).join(" AND ");
    const query: ItemFilters = {
      type: DEEP,
      allowed_types: grants,
      readable_sources: reach,
      filter,
    };
    const { ids, statements } = await walk(query);
    // The ghost type is outside the grants; the registered types are not.
    expect(ids).toEqual(idsOf(DEEP_TYPES, () => true));
    expect(statements.some(sliced)).toBe(false);
    for (const { args } of statements)
      expect(args.length).toBeLessThanOrEqual(MAX_STATEMENT_PARAMETERS);

    // The witness: one such term is within the limit, and is read in slices.
    const small = await walk({ ...query, filter: "backref[about] not_exists" });
    expect(small.ids).toEqual(ids);
    expect(small.statements.every(sliced)).toBe(true);
  });
});
