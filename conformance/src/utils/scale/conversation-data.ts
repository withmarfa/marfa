import { createHash } from "node:crypto";

const FIRST_SENT_MS = Date.parse("2026-01-01T00:00:00Z");
const AUTHORS = ["alice", "bob", "carol"];
const ATTACH_EVERY = 10;

const mod = (n: number, size: number) => ((n % size) + size) % size;

/**
 * The message numbered `n`. Numbers from 0 are sent one second apart in the
 * order of their numbers; a negative number is a late arrival, sent before
 * message 0 and so placed first by `sent_at` whenever it was written. Every
 * tenth message names a file.
 */
export function messageOf(
  n: number,
  files: readonly string[],
): Record<string, unknown> {
  const attached = files.length > 0 && mod(n, ATTACH_EVERY) === 0;
  return {
    author: AUTHORS[mod(n, AUTHORS.length)],
    text: `Message ${n} of the long conversation, sent on time`,
    sent_at: new Date(FIRST_SENT_MS + n * 1000).toISOString(),
    ...(attached
      ? { attachment: files[mod(Math.floor(n / ATTACH_EVERY), files.length)] }
      : {}),
  };
}

/** The number a generated message was made from, or null for values that are not one. */
export function messageNumber(
  values: unknown,
  files: readonly string[],
): number | null {
  if (typeof values !== "object" || values === null) return null;
  const text = (values as { text?: unknown }).text;
  const match =
    typeof text === "string" ? /^Message (-?\d+) of /.exec(text) : null;
  if (match === null) return null;
  const n = Number(match[1]);
  const wanted = messageOf(n, files);
  const held = values as Record<string, unknown>;
  if (Object.keys(held).length !== Object.keys(wanted).length) return null;
  for (const key of Object.keys(wanted)) {
    const same =
      key === "sent_at"
        ? typeof held[key] === "string" &&
          Date.parse(held[key]) === Date.parse(wanted[key] as string)
        : held[key] === wanted[key];
    if (!same) return null;
  }
  return n;
}

export type Direction = "asc" | "desc";

export interface MessagePlan {
  files: readonly string[];
  /** The number of the message the walk reads first. */
  first: number;
  direction: Direction;
  /** How many messages the walk should read in all. */
  total: number;
  limit: number;
}

/**
 * Judges a walk over a conversation's messages by `sent_at`, one page at a
 * time. Messages are numbered in the order they were sent, so each row must
 * be the next number up or down from the one before it, with the values
 * written.
 */
export class MessageWalk {
  readonly problems: string[] = [];
  problemCount = 0;
  private readonly ids = new Set<string>();
  private readonly cursors = new Set<string>();
  private readonly hash = createHash("sha256");
  private count = 0;
  private pages = 0;

  constructor(private readonly plan: MessagePlan) {}

  get rowsRead(): number {
    return this.count;
  }

  /** A hash of the ids read, in the order read. */
  digest(): string {
    return this.hash.copy().digest("hex");
  }

  private fail(message: string): void {
    this.problemCount++;
    if (this.problems.length < 10) {
      this.problems.push(`page ${this.pages}: ${message}`);
    }
  }

  /** Judges one page; `cursor` is the one the request carried, null for the first. */
  page(body: unknown, cursor: string | null): void {
    const { files, first, direction, limit } = this.plan;
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
    for (const row of data as { id?: unknown; values?: unknown }[]) {
      const id = row?.id;
      if (typeof id !== "string") {
        this.fail("a row has no id");
        continue;
      }
      const wanted = first + (direction === "asc" ? 1 : -1) * this.count;
      const n = messageNumber(row.values, files);
      if (n === null) {
        this.fail(`row ${id} holds values that were never written`);
      } else if (n !== wanted) {
        this.fail(`row ${id} is message ${n}, not message ${wanted}`);
      }
      if (this.ids.has(id)) this.fail(`row ${id} came twice`);
      this.ids.add(id);
      this.hash.update(id);
      this.count++;
    }
    this.pages++;
  }

  /** Judges what the whole walk covered; call once, after the last page. */
  finish(): void {
    if (this.count !== this.plan.total) {
      this.fail(
        `the walk read ${this.count} messages, not the ${this.plan.total} written`,
      );
    }
  }
}

/** The numbers `0..count-1` in an order that is not their own, by a stride coprime with `count`. */
export function scrambled(count: number): number[] {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const stride = [7919, 7907, 7901].find((s) => gcd(s, count) === 1) ?? 1;
  return Array.from({ length: count }, (_, i) => (i * stride) % count);
}

/**
 * Why a listing of conversations is not the expected one, or null when it is.
 * `expected` holds the `last_activity_at` each conversation's last append was
 * answered with. Appends in the same millisecond tie, so the order is judged
 * by those times: every conversation once with its time, latest first.
 */
export function judgeListing(
  listed: readonly { id: string; last_activity_at: string }[],
  expected: ReadonlyMap<string, string>,
): string | null {
  if (listed.length !== expected.size) {
    return `${listed.length} conversations were listed, not ${expected.size}`;
  }
  const seen = new Set<string>();
  let previous: number | null = null;
  for (const [i, item] of listed.entries()) {
    const wanted = expected.get(item.id);
    if (wanted === undefined)
      return `position ${i} is ${item.id}, not one made`;
    if (seen.has(item.id)) return `${item.id} was listed twice`;
    seen.add(item.id);
    const at = Date.parse(item.last_activity_at);
    if (at !== Date.parse(wanted)) {
      return `${item.id} reads ${item.last_activity_at}, its last append was answered ${wanted}`;
    }
    if (previous !== null && at > previous) {
      return `position ${i} (${item.id}) is later than the one before it`;
    }
    previous = at;
  }
  return null;
}
