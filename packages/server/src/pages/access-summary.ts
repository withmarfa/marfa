/**
 * The words an approval page uses for what its choices give, in one place so
 * the server and the browser say the same thing.
 *
 * The server renders each line for the choice a control starts at, and the
 * browser module rewrites it as the person changes a control. Both call the
 * functions here with the same inputs, so the line never disagrees with what
 * the controls would grant. This file reads no document and no server state.
 */

export type Level = "none" | "read" | "write";

/**
 * The value the all-data control posts when the person chose types instead.
 * It is no scope: it says the type controls are the choice.
 */
export const CHOOSE_TYPES = "choose-types";

/** More types than this and the list gets a search and a way to set them all. */
export const MANY_TYPES = 8;

/** How many types a long list shows before "Show all". */
export const SHOWN_TYPES = 5;

export const LEVEL_RANK: Record<Level, number> = { none: 0, read: 1, write: 2 };

/** Whether `level` is above `held`: a choice that adds access. */
export const addsAccess = (level: Level, held: Level): boolean =>
  LEVEL_RANK[level] > LEVEL_RANK[held];

/**
 * The level a control's value gives. An empty value adds nothing: it is no
 * access, or, where the app holds some, the level it holds. Any other value is
 * a scope literal, and its verb says the level.
 */
export function levelOfValue(value: string, held: Level): Level {
  if (value === "") return held;
  return value.endsWith(":write") ? "write" : "read";
}

/** "a", "a and b", "a, b, and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1) ?? ""}`;
}

const capitalize = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

export const lowerFirst = (text: string): string =>
  text.charAt(0).toLowerCase() + text.slice(1);

/** More than this many names are counted, with the first few named. */
const NAMED = 4;
const NAMED_OF_MANY = 3;

/**
 * The words for the things one level gives. `total` is how many types a
 * person is choosing among, where they are choosing types: all but a few of
 * them is "21 of your 21 types", which says more than a list of names. Only
 * the type controls are counted against it; a control that is not a type,
 * such as links between items, is named beside the count.
 */
function namesOf(picks: readonly LevelPick[], total?: number): string {
  const nouns = picks.map((pick) => pick.noun);
  if (nouns.length <= NAMED) return listWords(nouns);
  if (total !== undefined) {
    const types = picks.filter((pick) => pick.type).length;
    if (types > NAMED && types >= total - NAMED)
      return listWords([
        `${String(types)} of your ${String(total)} types`,
        ...picks.filter((pick) => !pick.type).map((pick) => pick.noun),
      ]);
  }
  return `${String(nouns.length)} kinds of data, including ${listWords(nouns.slice(0, NAMED_OF_MANY))}`;
}

export interface LevelPick {
  /** What the control is for, lower case and plural: "notes". */
  noun: string;
  /**
   * What a control stands for where it is one item type: its identifier, which
   * names it where another control has the same noun.
   */
  alias?: string;
  /** The level the control is set to. */
  level: Level;
  /** The level the app already holds. */
  held: Level;
  /** The control is one of the types chosen in place of all data. */
  type?: boolean;
}

/** What a line needs of a control to name it: see {@link nameApart}. */
export interface Nameable {
  noun: string;
  alias?: string;
}

/**
 * The picks, each named by its identifier where another pick has its noun and
 * the two stand for different things: "tasks and tasks" says nothing. A pick
 * with no identifier keeps its noun. `alongside` is what else the page shows
 * under the same nouns, such as what the app holds beside what it is asked
 * for, so a line never reads as the same tasks changing when they are two
 * types. The server and the browser call this on the same picks, so the line
 * is the same in both.
 */
export function nameApart<T extends Nameable>(
  picks: readonly T[],
  alongside: readonly Nameable[] = [],
): T[] {
  const stands = new Map<string, Set<string | undefined>>();
  for (const pick of [...picks, ...alongside])
    stands.set(pick.noun, (stands.get(pick.noun) ?? new Set()).add(pick.alias));
  return picks.map((pick) =>
    pick.alias !== undefined && (stands.get(pick.noun)?.size ?? 0) > 1
      ? { ...pick, noun: pick.alias }
      : pick,
  );
}

/**
 * What a set of level controls gives, as "read and edit notes and drafts;
 * read events". A control that adds nothing to what the app holds is left
 * out, so the line says what this approval gives.
 */
function levelWords(
  picks: readonly LevelPick[],
  total?: number,
  alongside: readonly Nameable[] = [],
): string[] {
  const gives = nameApart(picks, alongside).filter((pick) =>
    addsAccess(pick.level, pick.held),
  );
  const edit = gives.filter((pick) => pick.level === "write");
  const read = gives.filter((pick) => pick.level === "read");
  const words: string[] = [];
  if (edit.length > 0) words.push(`read and edit ${namesOf(edit, total)}`);
  if (read.length > 0) words.push(`read ${namesOf(read, total)}`);
  return words;
}

/** The line under "Your data". `empty` is said when nothing is on. */
export function dataSummary(
  picks: readonly LevelPick[],
  empty: string,
  total?: number,
  alongside: readonly Nameable[] = [],
): string {
  const words = levelWords(picks, total, alongside);
  return words.length > 0 ? capitalize(words.join("; ")) : empty;
}

/**
 * The line under "Your profile": the level controls, then the switches that
 * are on, each named by its own title.
 */
export function profileSummary(
  picks: readonly LevelPick[],
  switchesOn: readonly string[],
  empty: string,
  alongside: readonly Nameable[] = [],
): string {
  const words = levelWords(picks, undefined, alongside);
  if (switchesOn.length > 0)
    words.push(`see ${listWords(switchesOn.map(lowerFirst))}`);
  return words.length > 0 ? capitalize(words.join("; ")) : empty;
}

/**
 * The line under "More control over Marfa". `counted` is for a page where the
 * person is not answering a request, so "asked" would be untrue: it says how
 * many are on even when none is.
 */
export function powersSummary(
  on: number,
  total: number,
  counted = false,
): string {
  if (on > 0 || counted) return `${String(on)} of ${String(total)} turned on`;
  return total === 1
    ? "1 thing asked, off until you turn it on"
    : `${String(total)} things asked, each off until you turn it on`;
}

export interface HeldLevel {
  noun: string;
  /** See {@link LevelPick.alias}. */
  alias?: string;
  level: Level;
}

/**
 * The line under "Already allowed": what the app holds, in the same words as
 * the lines above, then the powers it holds.
 */
export function heldSummary(
  levels: readonly HeldLevel[],
  seen: readonly string[],
  powers: readonly string[],
  alongside: readonly Nameable[] = [],
): string {
  const words = levelWords(
    levels.map((pick) => ({ ...pick, held: "none" })),
    undefined,
    alongside,
  );
  if (seen.length > 0) words.push(`see ${listWords(seen.map(lowerFirst))}`);
  const line = capitalize(words.join("; "));
  const parts = line === "" ? [] : [line];
  if (powers.length === 1)
    parts.push(`Can also ${lowerFirst(powers[0] ?? "")}`);
  else if (powers.length > 1)
    parts.push(
      `Can also do ${String(powers.length)} things that control Marfa`,
    );
  return parts.join(". ");
}
