export interface GeneratedRow {
  sensor: string;
  reading: number;
  bucket: number;
  note: string;
}

export function rowOf(n: number, buckets: number): GeneratedRow {
  const sensor = n % 64;
  return {
    sensor: `s-${sensor}`,
    reading: readingCents(n) / 100,
    bucket: n % buckets,
    note: `Reading ${n} from sensor ${sensor}, steady`,
  };
}

export const readingCents = (n: number) => (n * 7919) % 100_000;

/** The number a generated row was made from, or null for values that are not one. */
export function rowNumber(values: unknown, buckets: number): number | null {
  if (typeof values !== "object" || values === null) return null;
  const note = (values as { note?: unknown }).note;
  const match =
    typeof note === "string" ? /^Reading (\d+) from sensor /.exec(note) : null;
  if (match === null) return null;
  const n = Number(match[1]);
  const wanted = rowOf(n, buckets);
  const held = values as Record<string, unknown>;
  const keys = Object.keys(held);
  const same =
    keys.length === 4 &&
    (Object.keys(wanted) as (keyof GeneratedRow)[]).every(
      (key) => held[key] === wanted[key],
    );
  return same ? n : null;
}

export interface Expected {
  rows: number;
  cents: number;
}

/** What the generated rows `0..count-1` that `select` keeps hold in all. */
export function expectedTotals(
  count: number,
  select: (n: number) => boolean = () => true,
): Expected {
  let rows = 0;
  let cents = 0;
  for (let n = 0; n < count; n++) {
    if (!select(n)) continue;
    rows++;
    cents += readingCents(n);
  }
  return { rows, cents };
}

/** Why a totals answer is not the expected one, or null when it is. */
export function judgeTotals(
  body: unknown,
  expected: Expected,
  column = "reading",
): string | null {
  const answer = body as {
    row_count?: unknown;
    totals?: Record<string, { sum?: unknown } | undefined>;
  } | null;
  if (answer?.row_count !== expected.rows) {
    return `row_count is ${JSON.stringify(answer?.row_count)}, not ${expected.rows}`;
  }
  const sum = answer.totals?.[column]?.sum;
  const wanted = expected.cents / 100;
  if (
    typeof sum !== "number" ||
    Math.abs(sum - wanted) > 1e-6 + 1e-9 * Math.abs(wanted)
  ) {
    return `${column} sum is ${JSON.stringify(sum)}, not ${wanted}`;
  }
  return null;
}

export interface Row {
  id: string;
  values: Record<string, unknown>;
  updated_at?: string;
}

/** Why rows read back are not the expected ones, in order, or null when they are. */
export function judgeRows(
  actual: unknown,
  ids: string[],
  values: Record<string, unknown>[],
): string | null {
  if (!Array.isArray(actual)) return "the answer holds no rows";
  if (actual.length !== ids.length) {
    return `${actual.length} rows were read, not ${ids.length}`;
  }
  for (let i = 0; i < ids.length; i++) {
    const row = actual[i] as Row | undefined;
    if (row?.id !== ids[i]) return `row ${i} is ${row?.id}, not ${ids[i]}`;
    const held = row.values ?? {};
    const wanted = values[i] ?? {};
    const keys = new Set([...Object.keys(held), ...Object.keys(wanted)]);
    for (const key of keys) {
      if (held[key] !== wanted[key]) {
        return `row ${ids[i]} holds ${key} ${JSON.stringify(held[key])}, not ${JSON.stringify(wanted[key])}`;
      }
    }
  }
  return null;
}
