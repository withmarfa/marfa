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

const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 };

/** Whether `level` is above `held`: a choice that adds access. */
export const addsAccess = (level: Level, held: Level): boolean =>
  RANK[level] > RANK[held];

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

const lowerFirst = (text: string): string =>
  text.charAt(0).toLowerCase() + text.slice(1);

/** More than this many names are counted, with the first few named. */
const NAMED = 4;
const NAMED_OF_MANY = 3;

function namesOf(nouns: readonly string[]): string {
  return nouns.length <= NAMED
    ? listWords(nouns)
    : `${String(nouns.length)} kinds of data, including ${listWords(nouns.slice(0, NAMED_OF_MANY))}`;
}

export interface LevelPick {
  /** What the control is for, lower case and plural: "notes". */
  noun: string;
  /** The level the control is set to. */
  level: Level;
  /** The level the app already holds. */
  held: Level;
}

/**
 * What a set of level controls gives, as "read and edit notes and drafts;
 * read events". A control that adds nothing to what the app holds is left
 * out, so the line says what this approval gives.
 */
function levelWords(picks: readonly LevelPick[]): string[] {
  const gives = picks.filter((pick) => addsAccess(pick.level, pick.held));
  const edit = gives.filter((pick) => pick.level === "write");
  const read = gives.filter((pick) => pick.level === "read");
  const words: string[] = [];
  if (edit.length > 0)
    words.push(`read and edit ${namesOf(edit.map((pick) => pick.noun))}`);
  if (read.length > 0)
    words.push(`read ${namesOf(read.map((pick) => pick.noun))}`);
  return words;
}

/** The line under "Your data". `empty` is said when nothing is on. */
export function dataSummary(
  picks: readonly LevelPick[],
  empty: string,
): string {
  const words = levelWords(picks);
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
): string {
  const words = levelWords(picks);
  if (switchesOn.length > 0)
    words.push(`see ${listWords(switchesOn.map(lowerFirst))}`);
  return words.length > 0 ? capitalize(words.join("; ")) : empty;
}

/** The line under "More control over Marfa". */
export function powersSummary(on: number, total: number): string {
  if (on > 0) return `${String(on)} of ${String(total)} turned on`;
  return total === 1
    ? "1 thing asked, off until you turn it on"
    : `${String(total)} things asked, each off until you turn it on`;
}

export interface HeldLevel {
  noun: string;
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
): string {
  const words = levelWords(levels.map((pick) => ({ ...pick, held: "none" })));
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
