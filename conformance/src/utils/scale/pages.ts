/**
 * Judging what the server's answers say about the work it did. A bulk page
 * that answers 200 can still have written fewer entries than it was sent, so
 * every page is checked by its counts and not by its status. Pure, so the
 * checks have tests; the steps do the requests.
 */

export interface PageJudgement {
  /** Entries not written: errored, skipped or missing from the counts. */
  errors: number;
  note: string | null;
}

const WHOLE: PageJudgement = { errors: 0, note: null };

function countOf(counts: Record<string, unknown>, name: string): number | null {
  const value = counts[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A page of `size` entries sent as new or changed (`/items/bulk` or
 * `/edges/bulk` in upsert mode). The server must say, in `counts`, that every
 * one was created or updated; the figure counts each entry it does not say
 * that of as an error.
 */
export function judgePage(
  status: number,
  text: string,
  size: number,
): PageJudgement {
  if (status < 200 || status >= 300) {
    return {
      errors: size,
      note: `the page of ${size} answered ${status}: ${text.slice(0, 120)}`,
    };
  }
  let counts: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as { counts?: unknown } | null;
    if (typeof parsed?.counts === "object" && parsed.counts !== null) {
      counts = parsed.counts as Record<string, unknown>;
    }
  } catch {
    // Handled with the missing counts below.
  }
  const created = counts && countOf(counts, "created");
  const updated = counts && countOf(counts, "updated");
  const errored = counts && countOf(counts, "errored");
  if (
    counts === undefined ||
    created === null ||
    updated === null ||
    errored === null
  ) {
    return {
      errors: size,
      note: `the page of ${size} answered no counts of what it wrote`,
    };
  }
  const written = (created ?? 0) + (updated ?? 0);
  const shortfall = Math.max(0, size - written);
  if (shortfall === 0) return WHOLE;
  return {
    errors: shortfall,
    note:
      `only ${written} of ${size} entries were created or updated` +
      ((errored ?? 0) > 0 ? `; ${errored} of ${size} entries errored` : ""),
  };
}

/** Several pages' judgements as one figure's errors. */
export function sumPageErrors(pages: PageJudgement[]): PageJudgement {
  const short = pages.filter((page) => page.errors > 0);
  if (short.length === 0) return WHOLE;
  return {
    errors: short.reduce((sum, page) => sum + page.errors, 0),
    note: `${short.length} of ${pages.length} pages fell short; the first: ${short[0]?.note ?? ""}`,
  };
}

/** The count of items in an `/items/stats` answer: `{"active": 20120}` and so on. */
export function totalOfStats(text: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const counts = Object.values(parsed).filter(
    (count): count is number => typeof count === "number",
  );
  return counts.length === 0 ? null : counts.reduce((a, b) => a + b, 0);
}

export interface ItemTotal {
  value: number;
  errors: number;
  note: string | null;
}

/**
 * The instance's size, judged against what the seed says it wrote. Later steps
 * add items, so the total may be above the claim and never below it.
 */
export function judgeItemTotal(
  status: number,
  text: string,
  claimed: number,
): ItemTotal {
  if (status < 200 || status >= 300) {
    return {
      value: 0,
      errors: 1,
      note: `/items/stats answered ${status}`,
    };
  }
  const total = totalOfStats(text);
  if (total === null) {
    return {
      value: 0,
      errors: 1,
      note: `/items/stats has no counts: ${text.slice(0, 120)}`,
    };
  }
  if (total < claimed) {
    return {
      value: total,
      errors: claimed - total,
      note: `the instance holds ${total.toLocaleString("en-US")} items and the seed claims ${claimed.toLocaleString("en-US")}`,
    };
  }
  return { value: total, errors: 0, note: null };
}
