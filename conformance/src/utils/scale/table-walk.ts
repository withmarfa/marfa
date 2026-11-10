import { createHash } from "node:crypto";
import { readingCents, rowNumber, type Row } from "./table-data.js";

export type Ordering = "id" | "updated_at" | "reading";

export interface WalkPlan {
  /** The page size the walk asked for. */
  limit: number;
  /** The table holds the generated rows `0..rows-1`. */
  rows: number;
  buckets: number;
  order: Ordering;
  /** The generated rows a filter keeps; every row when absent. */
  keep?: (n: number) => boolean;
}

export type Ending =
  /** The server answered no cursor. */
  | "end"
  /** The walk stopped on its time budget, so only what it read is judged. */
  | "budget"
  /** The walk read as many pages as the table can hold and a cursor remained. */
  | "pages"
  /** A page was refused; that is counted where it happened. */
  | "failed";

const KEPT_PROBLEMS = 10;

/**
 * Judges a walk over a table's pages, one page at a time, and leaves the
 * timing of each request to the caller: a page is judged after its answer was
 * timed.
 */
export class WalkChecker {
  readonly problems: string[] = [];
  problemCount = 0;
  /** Per page, how many rows it held and the cents they read in all. */
  readonly pageSums: { rows: number; cents: number }[] = [];
  private readonly seen: Uint8Array;
  private readonly cursors = new Set<string>();
  private readonly hash = createHash("sha256");
  private previous: Row | null = null;
  private count = 0;
  private pages = 0;

  constructor(private readonly plan: WalkPlan) {
    this.seen = new Uint8Array(plan.rows);
  }

  get rowsSeen(): number {
    return this.count;
  }

  /** A hash of the ids read, in the order read. */
  digest(): string {
    return this.hash.copy().digest("hex");
  }

  private fail(message: string): void {
    this.problemCount++;
    if (this.problems.length < KEPT_PROBLEMS) {
      this.problems.push(`page ${this.pages}: ${message}`);
    }
  }

  private before(a: Row, b: Row): boolean {
    const { order } = this.plan;
    if (order === "id") return a.id < b.id;
    const key = (row: Row) =>
      order === "reading" ? row.values.reading : row.updated_at;
    const x = key(a);
    const y = key(b);
    if (typeof x !== typeof y) return false;
    if (typeof x === "number" && typeof y === "number") {
      return x < y || (x === y && a.id < b.id);
    }
    if (typeof x === "string" && typeof y === "string") {
      return x < y || (x === y && a.id < b.id);
    }
    return false;
  }

  /** Judges one page; `cursor` is the one the request carried, null for the first. */
  page(body: unknown, cursor: string | null): void {
    const { limit, buckets, keep } = this.plan;
    const answer = body as { data?: unknown; next_cursor?: unknown } | null;
    const data = answer?.data;
    const next = answer?.next_cursor;
    if (!Array.isArray(data)) {
      this.fail("the answer holds no data array");
      this.pages++;
      return;
    }
    if (next !== null && typeof next !== "string") {
      this.fail(`next_cursor is ${JSON.stringify(next)}`);
    }
    if (data.length > limit) {
      this.fail(`${data.length} rows came for a limit of ${limit}`);
    }
    if (typeof next === "string") {
      if (data.length !== limit) {
        this.fail(`${data.length} rows came with a cursor, not ${limit}`);
      }
      if (next === cursor || this.cursors.has(next)) {
        this.fail("the cursor did not move on");
      }
      this.cursors.add(next);
    }
    let cents = 0;
    for (const row of data as Row[]) {
      if (typeof row?.id !== "string") {
        this.fail("a row has no id");
        continue;
      }
      if (this.previous !== null && !this.before(this.previous, row)) {
        this.fail(`row ${row.id} is out of order after ${this.previous.id}`);
      }
      this.previous = row;
      this.hash.update(row.id);
      const n = rowNumber(row.values, buckets);
      if (n === null) {
        this.fail(`row ${row.id} holds values that were never written`);
        continue;
      }
      if (n >= this.plan.rows) {
        this.fail(
          `row ${row.id} is row ${n}, past the ${this.plan.rows} written`,
        );
        continue;
      }
      if (keep !== undefined && !keep(n)) {
        this.fail(`row ${row.id} (row ${n}) is not one the filter keeps`);
      }
      if (this.seen[n] === 1) this.fail(`row ${row.id} (row ${n}) came twice`);
      this.seen[n] = 1;
      this.count++;
      cents += readingCents(n);
    }
    this.pageSums.push({ rows: data.length, cents });
    this.pages++;
  }

  /** Judges what the whole walk covered; call once, after the last page. */
  finish(ending: Ending): void {
    if (ending === "pages") {
      this.fail("the walk did not end within the pages the table fills");
    }
    if (ending !== "end") return;
    const { keep, rows } = this.plan;
    let wanted = 0;
    for (let n = 0; n < rows; n++) if (keep === undefined || keep(n)) wanted++;
    if (this.count !== wanted) {
      this.fail(`the walk read ${this.count} rows, not the ${wanted} written`);
    }
  }
}
