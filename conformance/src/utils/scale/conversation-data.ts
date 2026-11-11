import { createHash } from "node:crypto";

const FIRST_SENT_MS = Date.parse("2026-01-01T00:00:00Z");
const AUTHORS = ["alice", "bob", "carol"];
const ATTACH_EVERY = 10;

const mod = (n: number, size: number) => ((n % size) + size) % size;

const TIE_SIZE = 4;

/** Messages of one group share a `sent_at`, so a read must break the tie by id. */
export const tieGroup = (n: number) => Math.floor(n / TIE_SIZE);

// Negative numbers model late arrivals that belong before the messages already held.
export function messageOf(
  n: number,
  files: readonly string[],
): Record<string, unknown> {
  const attached = files.length > 0 && mod(n, ATTACH_EVERY) === 0;
  return {
    author: AUTHORS[mod(n, AUTHORS.length)],
    text: `Message ${n} of the long conversation, sent on time`,
    sent_at: new Date(FIRST_SENT_MS + tieGroup(n) * 1000).toISOString(),
    ...(attached
      ? { attachment: files[mod(Math.floor(n / ATTACH_EVERY), files.length)] }
      : {}),
  };
}

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
  first: number;
  direction: Direction;
  /** Messages this walk reads. */
  total: number;
  /** Messages the conversation holds, when the walk reads only the first of them. */
  held?: number;
  limit: number;
}

export class MessageWalk {
  readonly problems: string[] = [];
  problemCount = 0;
  private readonly ids = new Set<string>();
  private readonly numbers = new Set<number>();
  private readonly cursors = new Set<string>();
  private previous: { id: string; n: number } | null = null;
  private readonly hash = createHash("sha256");
  private count = 0;
  private pages = 0;
  /** Set once a cursor came back that an earlier page already answered. */
  cursorStuck = false;

  constructor(private readonly plan: MessagePlan) {}

  get rowsRead(): number {
    return this.count;
  }

  digest(): string {
    return this.hash.copy().digest("hex");
  }

  private fail(message: string): void {
    this.problemCount++;
    if (this.problems.length < 10) {
      this.problems.push(`page ${this.pages}: ${message}`);
    }
  }

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
        this.cursorStuck = true;
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
        this.previous = null;
      } else {
        if (tieGroup(n) !== tieGroup(wanted)) {
          this.fail(
            `row ${id} is message ${n}, not one sent with message ${wanted}`,
          );
        }
        if (this.numbers.has(n)) this.fail(`message ${n} came twice`);
        this.numbers.add(n);
        const before = this.previous;
        if (
          before !== null &&
          tieGroup(before.n) === tieGroup(n) &&
          !(before.id < id)
        ) {
          this.fail(
            `row ${id} follows row ${before.id}, sent at the same time: a tie goes by id ascending`,
          );
        }
        this.previous = { id, n };
      }
      if (this.ids.has(id)) this.fail(`row ${id} came twice`);
      this.ids.add(id);
      this.hash.update(id);
      this.count++;
    }
    if (next === null && this.count < (this.plan.held ?? this.plan.total)) {
      this.fail(
        `no next_cursor after ${this.count} messages of ${this.plan.held ?? this.plan.total}`,
      );
    }
    this.pages++;
  }

  finish(): void {
    if (this.count !== this.plan.total) {
      this.fail(
        `the walk read ${this.count} messages, not the ${this.plan.total} written`,
      );
    }
  }
}

export function scrambled(count: number): number[] {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const stride = [7919, 7907, 7901].find((s) => gcd(s, count) === 1) ?? 1;
  return Array.from({ length: count }, (_, i) => (i * stride) % count);
}

const MIN_GAP_MS = 2;

/**
 * Keeps the `last_activity_at` each write answered. A write begun at least
 * `MIN_GAP_MS` after the previous answer to the same conversation arrived must
 * read later, so an activity that never moves cannot pass as a listing order.
 */
export class ActivityLog {
  readonly latest = new Map<string, string>();
  /** Writes proved to have moved the activity on. */
  advances = 0;
  private readonly received = new Map<string, number>();

  record(
    id: string,
    sentAt: number,
    receivedAt: number,
    activity: string,
  ): string | null {
    const at = Date.parse(activity);
    const before = this.latest.get(id);
    const answeredAt = this.received.get(id);
    let problem: string | null = null;
    if (Number.isNaN(at)) {
      problem = `last_activity_at ${activity} is not a time`;
    } else if (before !== undefined && answeredAt !== undefined) {
      const earlier = Date.parse(before);
      if (at < earlier) {
        problem = `last_activity_at went back from ${before} to ${activity}`;
      } else if (sentAt - answeredAt >= MIN_GAP_MS) {
        if (at === earlier) {
          problem = `last_activity_at stayed ${activity} across writes ${sentAt - answeredAt} ms apart`;
        } else {
          this.advances++;
        }
      }
    }
    this.latest.set(id, activity);
    this.received.set(id, receivedAt);
    return problem;
  }
}

/** Judges each page of a listing, and stops a walk that repeats a cursor or runs past the known count. */
export class ListingWalk {
  readonly items: { id: string; last_activity_at: string }[] = [];
  private readonly cursors = new Set<string>();
  private pages = 0;

  constructor(
    private readonly known: number,
    private readonly limit: number,
  ) {}

  /** The next cursor, or null at the end; a problem ends the walk. */
  page(
    body: unknown,
    cursor: string | null,
  ): { next: string | null; problem: string | null } {
    const answer = body as { data?: unknown; next_cursor?: unknown } | null;
    const stop = (problem: string) => ({ next: null, problem });
    if (!Array.isArray(answer?.data))
      return stop("the answer holds no data array");
    this.items.push(
      ...(answer.data as { id: string; last_activity_at: string }[]),
    );
    if (this.items.length > this.known) {
      return stop(`more than the ${this.known} conversations made were listed`);
    }
    const next = answer.next_cursor ?? null;
    if (next !== null && typeof next !== "string") {
      return stop(`next_cursor is ${JSON.stringify(next)}`);
    }
    if (next !== null) {
      if (next === cursor || this.cursors.has(next)) {
        return stop("the cursor did not move on");
      }
      this.cursors.add(next);
      if (++this.pages > Math.ceil(this.known / this.limit) + 1) {
        return stop(`still paging after ${this.pages} pages of ${this.limit}`);
      }
    }
    return { next, problem: null };
  }
}

/** A download counts only with a successful status and the bytes uploaded. */
export function judgeBlob(
  answer: { status: number; text: string },
  expected: string,
): string | null {
  if (answer.status < 200 || answer.status >= 300) {
    return `answered ${answer.status}`;
  }
  if (answer.text !== expected) {
    return `holds "${answer.text.slice(0, 40)}", not "${expected}"`;
  }
  return null;
}

// Appends can share a millisecond, so their receipt order does not determine the listing.
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
