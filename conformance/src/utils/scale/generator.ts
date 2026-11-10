/**
 * A deterministic generator of items and edges shaped like a real instance:
 * what a person's notes, tasks and bookmarks look like once there are many.
 * The same position always makes the same item, so a rerun measures the same
 * instance and two nights are comparable.
 *
 * Positions run from 1. An item's `source_id` names its position, so a bulk
 * upsert of a position that already exists updates it and a rerun adds only
 * what is new.
 */
import type { BulkItemInput } from "../../client/types.js";

/** The words every text is built from. The first few are common by design. */
const WORDS = (
  "marfa note idea plan draft review sync folder device server rust swift " +
  "connector budget memory speed light reliable design decision ticket epic " +
  "garden kitchen travel book film music photo walk river city friend family " +
  "meeting call email invoice tax health run sleep coffee tea letter project"
).split(" ");

/**
 * Held in one item in every `RARE_EVERY`, so a search for it finds a few items
 * on any instance and the benchmark can tell a rare word from a common one.
 */
export const RARE_WORD = "quokka";
const RARE_EVERY = 2_000;

/** A small seeded generator (mulberry32), one per position and purpose. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, low: number, high: number) =>
  low + Math.floor(r() * (high - low + 1));
const pick = <T>(r: () => number, list: readonly T[]): T =>
  list[Math.floor(r() * list.length)] as T;

function sentence(r: () => number, words: number): string {
  const text = Array.from({ length: words }, () => pick(r, WORDS)).join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** The title of position `n`, which another note's `[[link]]` can name. */
function titleOf(n: number): string {
  const r = rng(n);
  return `${sentence(r, int(r, 2, 6)).slice(0, -1)} ${n}`;
}

export function sourceIdOf(n: number): string {
  return `scale-${n}`;
}

function noteBody(r: () => number, n: number): string {
  const parts = [`# ${titleOf(n)}`, ""];
  for (let p = int(r, 1, 8); p > 0; p--) {
    let paragraph = Array.from({ length: int(r, 1, 5) }, () =>
      sentence(r, int(r, 6, 18)),
    ).join(" ");
    if (r() < 0.4 && n > 1) {
      paragraph += ` See [[${titleOf(int(r, 1, n - 1))}]].`;
    }
    parts.push(paragraph, "");
  }
  if (r() < 0.3) {
    parts.push(`- [ ] ${sentence(r, 5)}`, `- [x] ${sentence(r, 4)}`, "");
  }
  if (r() < 0.15) parts.push("```", "let x = 1;", "```", "");
  return parts.join("\n");
}

/** The item at position `n`: 60% notes, 25% tasks, 15% bookmarks. */
export function scaleItem(n: number): BulkItemInput {
  const r = rng(n);
  const kind = r();
  const tier = r() < 0.1 ? "feed" : "library";
  const tags =
    r() < 0.4
      ? [
          ...new Set(
            Array.from({ length: int(r, 1, 3) }, () => pick(r, WORDS)),
          ),
        ].sort()
      : undefined;
  const rare = n % RARE_EVERY === 0 ? ` ${RARE_WORD}` : "";
  const base = {
    source_id: sourceIdOf(n),
    tier,
    ...(tags && { tags }),
  } as const;
  const title = titleOf(n);

  if (kind < 0.6) {
    return {
      ...base,
      type: "core.note",
      properties: { title, body: noteBody(r, n) + rare },
    };
  }
  if (kind < 0.85) {
    const properties: Record<string, unknown> = {
      title,
      description: sentence(r, 8) + rare,
    };
    if (r() < 0.3) properties.priority = pick(r, ["low", "medium", "high"]);
    if (r() < 0.5) {
      properties.due_at = `2027-0${int(r, 1, 9)}-1${int(r, 0, 9)}T09:00:00Z`;
    }
    return { ...base, type: "core.task", properties };
  }
  return {
    ...base,
    type: "core.bookmark",
    properties: {
      title,
      url: `https://example.com/${n}/${int(r, 1, 1_000_000)}`,
      body: sentence(r, 20) + rare,
    },
  };
}

/** How far back a parent can be, which makes the `parent-of` edges deep trees. */
const PARENT_WINDOW = 200;
/** Items with a parent: 45% reaches 100,000 `parent-of` edges at 250,000 items. */
const PARENT_SHARE = 0.45;
const ABOUT_SHARE = 0.2;

export interface EdgePlan {
  /** The position of the item's parent, whose `parent-of` edge points at it. */
  parent: number | null;
  /** The position of an earlier item it is `about`. */
  about: number | null;
}

/** The edges item `n` adds. They only reach earlier positions. */
export function edgePlan(n: number): EdgePlan {
  const r = rng(n * 7);
  const parent =
    n > 1 && r() < PARENT_SHARE
      ? int(r, Math.max(1, n - PARENT_WINDOW), n - 1)
      : null;
  const about = n > 1 && r() < ABOUT_SHARE ? int(r, 1, n - 1) : null;
  return { parent, about };
}
