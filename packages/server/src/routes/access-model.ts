/**
 * What an approval screen offers, and what a submitted choice means.
 *
 * Both approval screens, the browser authorize screen and the device-code
 * screen, build their controls here and read a submission back through here,
 * so a request reads the same on either and a choice is held to the request
 * the same way on both.
 *
 * A request names scope literals. The screen offers one control for each
 * thing they name: a level select for an item type, a link type, a metadata
 * area or a profile row, and a switch for a power or a single profile claim.
 * Every value a control submits is one of the request's own literals (an
 * empty value means no access), and a choice is therefore the request
 * narrowed and never widened. The one exception is a request for all data,
 * where the person may choose types instead: each type control submits a
 * scope the all-data scope covers, which the provider cannot issue from the
 * request as signed, so the decision signs it again
 * (`auth/narrow-signed-query.ts`). {@link resolveSelection} checks both.
 */
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import {
  getTypeSchema,
  grantCoversScope,
  HIDDEN_MECHANISM_SCOPES,
  parseScope,
  requiresExplicitConsent,
  scopesOfferedOffByDefaultOnly,
} from "@withmarfa/shared";
import {
  CHOOSE_TYPES,
  dataSummary,
  heldSummary,
  LEVEL_RANK,
  listWords,
  levelOfValue,
  lowerFirst,
  nameApart,
  powersSummary,
  profileSummary,
  type HeldLevel,
  type Level,
  type LevelPick,
} from "../pages/access-summary.js";
import {
  DESTRUCTIVE_PERMISSIONS,
  PERMISSION_GROUPS,
  permissionDescription,
} from "./permission-labels.js";
import type { ChoosableType } from "./access-types.js";
import { reachLine } from "./scope-openness.js";
import {
  humanizeType,
  isExactTypeScope,
  pluralNoun,
  SCOPE_LABELS,
  SCOPE_NOUNS,
  scopeTitle,
} from "./scope-copy.js";

export { CHOOSE_TYPES };

/** The word for each level, on every page and in the CLI (`GLOSSARY.md`, "Access words"). */
export const LEVEL_LABELS: Record<Level, string> = {
  none: "No access",
  read: "Read only",
  write: "Read and edit",
};

/** The choice beside the levels of an ask for all data. */
export const CHOOSE_TYPES_LABEL = "Choose types";

/** The title of the row for the global type wildcard. */
export const ALL_DATA_TITLE = "All your data";

/** The literal a parsed scope came from, which is what a control submits. */
function scopeLiteral(scope: ParsedScope): string {
  if (scope.kind === "oidc") return scope.oidcScope ?? scope.typePattern;
  if (scope.kind === "permission") return scope.permission ?? scope.typePattern;
  return `${scope.typePattern}:${scope.operation}`;
}

/** An OAuth mechanism rather than a data permission: it rides along unseen. */
function isMechanism(literal: string): boolean {
  return (HIDDEN_MECHANISM_SCOPES as readonly string[]).includes(literal);
}

export interface LevelOption {
  /** The literal a person gets by choosing this level; empty for no access. */
  value: string;
  label: string;
}

/**
 * The types a person may choose one by one in place of all data. The all-data
 * row offers {@link CHOOSE_TYPES} beside its levels, and these rows are what
 * it means.
 */
export interface ChooseTypes {
  /** What the all-data control posts for this choice. */
  value: string;
  /** Every type the person may choose, in the order the page lists them. */
  rows: LevelRow[];
}

/** One thing the app asks for at up to two levels. */
export interface LevelRow {
  kind: "level";
  id: string;
  /** The field the control posts under; `scopes` where it is left out. */
  name?: "types";
  title: string;
  description?: string;
  /** What the row is for in a sentence about the choice, lower case and plural. */
  noun: string;
  /** The level the app already holds. */
  held: Level;
  /** Lowest first. Never above the request, never below what the app holds. */
  options: LevelOption[];
  selected: string;
  /** Present on a row for all data when the person may choose types instead. */
  choose?: ChooseTypes;
  /** The item type the row is for, where it is for one item type: the identifier a search matches and a clash names it by. */
  type?: string;
}

/** One thing the app asks for that is simply on or off. */
export interface SwitchRow {
  kind: "switch";
  id: string;
  literal: string;
  title: string;
  description?: string;
  /** Deletes data with no way back. */
  destructive: boolean;
  checked: boolean;
}

/** One thing the app holds, at the level it holds it. */
export interface HeldRow {
  title: string;
  /** Set where other rows share the title: what this one stands for. */
  description?: string;
  value: string;
}

/** The line under each opening row, for the choice the controls start at. */
export interface AccessSummaries {
  data: string;
  profile: string;
  powers: string;
  /** What each says when nothing is on, which the browser module says again. */
  empty: { data: string; profile: string };
  held: string;
}

export interface AccessModel {
  data: LevelRow[];
  profile: (LevelRow | SwitchRow)[];
  /** Every permission asked for, in the order the pages list them. */
  powers: SwitchRow[];
  /** What the app already holds, to show and not to change. */
  held: HeldRow[];
  summaries: AccessSummaries;
  /** Submitted with the form without a control: the OAuth mechanisms the request names. */
  mechanisms: string[];
  /** Whether the app already holds some access. */
  returning: boolean;
  /**
   * Whether a control offers the level to edit an item type or the content,
   * which adds, changes and deletes items. Editing a definition, a link type
   * or the profile does not, so those never set it.
   */
  offersEdit: boolean;
}

export interface AccessInput {
  scopes: readonly ParsedScope[];
  /** The consent the app already holds, or undefined for a first request. */
  held: readonly string[] | undefined;
  /** A sentence per type pattern, for a row the curated names do not explain. */
  descriptions?: Record<string, string>;
  /** The types an open-ended pattern matches today, keyed by pattern. */
  wildcardExpansions?: Record<string, string[]>;
  /**
   * The label of each item type the request or the held consent names, keyed
   * by type id, for a type registered on the instance. A shipped type's label
   * comes from the shipped registry, so a caller passes only what it looked up.
   */
  typeLabels?: Record<string, string>;
  /**
   * The item types a person may choose in place of all data, when the
   * request names it. Without them an ask for all data is a level and no
   * more.
   */
  chooseTypes?: readonly ChoosableType[];
  bundles: readonly PermissionBundle[];
}

/** What a caller looked up to name a scope in words; a pattern it leaves out is named from the registry. */
type Words = Pick<
  AccessInput,
  "descriptions" | "wildcardExpansions" | "typeLabels"
>;

interface Ask {
  key: string;
  scope: ParsedScope;
  read?: string;
  write?: string;
}

/** The highest level the held consent gives on a pattern. */
function levelHeld(held: readonly string[], pattern: string): Level {
  if (grantCoversScope(held, `${pattern}:write`)) return "write";
  if (grantCoversScope(held, `${pattern}:read`)) return "read";
  return "none";
}

const isLevelKind = (scope: ParsedScope): boolean =>
  scope.kind === "type" ||
  scope.kind === "content" ||
  scope.kind === "edge" ||
  scope.kind === "metadata" ||
  scope.kind === "profile";

/**
 * Whether the page carries a literal without a choice: a mechanism, or
 * something the app already holds. Approving one is not a choice a person
 * made, though it rides in the token.
 */
function isCarried(literal: string, held: readonly string[]): boolean {
  return isMechanism(literal) || grantCoversScope(held, literal);
}

/**
 * The label an exact item type carries: the instance's, then the shipped
 * registry's. Every page names a type through here, so one type reads the same
 * wherever it is shown.
 */
export function typeLabel(pattern: string, input: Words): string {
  return (
    input.typeLabels?.[pattern] ??
    getTypeSchema(pattern)?.label ??
    humanizeType(pattern)
  );
}

/**
 * The title a row carries, the sentence about the choice it sits in, and the
 * line under the title where one adds something.
 *
 * An item type is named by its own singular label, as the registry gives it.
 * Anything else a curated name titles. Without one the sentence that explains
 * the scope stands in, without its full stop, and the humanized pattern is
 * the floor. The line under the title says how far an open-ended grant
 * reaches, which is composed from the grammar and never written into any
 * copy, and, for a metadata area, a profile row or the content category, a
 * sentence that says what the name alone does not.
 */
function describe(
  scope: ParsedScope,
  input: Words,
): { title: string; noun: string; description?: string } {
  const sentence = input.descriptions?.[scope.typePattern];
  const expansion =
    scope.kind === "oidc"
      ? undefined
      : input.wildcardExpansions?.[scope.typePattern];
  const reach = reachLine(scope, expansion);
  if (isExactTypeScope(scope)) {
    const label = typeLabel(scope.typePattern, input);
    return {
      title: label,
      noun: pluralNoun(label),
      description: reach || undefined,
    };
  }
  if (scope.kind === "type" && scope.typePattern === "*")
    return {
      title: ALL_DATA_TITLE,
      noun: lowerFirst(ALL_DATA_TITLE),
      description: reach || undefined,
    };
  if (scope.kind === "oidc" || scope.kind === "permission") {
    const title = scopeTitle(scope);
    return { title, noun: lowerFirst(title) };
  }
  const curated = SCOPE_LABELS[scope.typePattern];
  if (curated !== undefined) {
    const explains =
      scope.kind === "metadata" ||
      scope.kind === "profile" ||
      scope.kind === "content";
    return {
      title: curated,
      noun: SCOPE_NOUNS[scope.typePattern] ?? lowerFirst(curated),
      description:
        [explains ? sentence : undefined, reach || undefined]
          .filter(Boolean)
          .join(" ") || undefined,
    };
  }
  const title = sentence?.replace(/\.$/, "") ?? scopeTitle(scope);
  return {
    title,
    noun: lowerFirst(title),
    description: reach || undefined,
  };
}

/** Build the controls for a request. */
export function buildAccess(given: AccessInput): AccessModel {
  const input: AccessInput = {
    ...given,
    typeLabels: {
      ...Object.fromEntries(
        (given.chooseTypes ?? []).flatMap((type) =>
          type.label === undefined ? [] : [[type.id, type.label]],
        ),
      ),
      ...given.typeLabels,
    },
  };
  const held = input.held ?? [];
  const returning = held.some((literal) => !isMechanism(literal));
  const withheld = [...scopesOfferedOffByDefaultOnly(input.bundles)];
  // A scope starts on unless a power, or unless it is one only an
  // off-by-default bundle offers or covers. A wildcard that covers a withheld
  // literal starts off with it, so a request cannot arrive on by being broad.
  const startsOn = (literal: string): boolean =>
    !requiresExplicitConsent(literal) &&
    !withheld.some((w) => grantCoversScope([literal], w));

  const asks = new Map<string, Ask>();
  const switches: ParsedScope[] = [];
  const mechanisms: string[] = [];
  for (const scope of input.scopes) {
    const literal = scopeLiteral(scope);
    if (scope.kind === "oidc" && isMechanism(literal)) {
      mechanisms.push(literal);
    } else if (isLevelKind(scope)) {
      const key = `${scope.kind}:${scope.typePattern}`;
      const ask = asks.get(key) ?? { key, scope };
      if (scope.operation === "write") ask.write = literal;
      else ask.read = literal;
      asks.set(key, ask);
    } else {
      switches.push(scope);
    }
  }

  let counter = 0;
  const nextId = (): string => `access-${String(++counter)}`;
  /** The pattern each level row stands for, by the row's id. */
  const patternOf = new Map<string, string>();

  const rowFor = (ask: Ask, name?: "types"): LevelRow | null => {
    const floor = levelHeld(held, ask.scope.typePattern);
    const top: Level = ask.write !== undefined ? "write" : "read";
    // Held in full: shown, not offered. The server adds it to what the
    // approval grants while the app still holds it (see `resolveSelection`).
    if (LEVEL_RANK[floor] >= LEVEL_RANK[top]) return null;
    // The floor is none or read here: an app that holds write holds all of
    // any ask. The lowest choice is the level the app holds, and it always
    // posts nothing: it is no access, or the held read, which the server adds
    // while it is still held. A held literal is never a value the page posts,
    // so an approval after the app was disconnected cannot count it as newly
    // chosen.
    const options: { level: Level; value: string }[] = [
      { level: floor, value: "" },
    ];
    if (floor === "none" && ask.read !== undefined)
      options.push({ level: "read", value: ask.read });
    if (ask.write !== undefined)
      options.push({ level: "write", value: ask.write });
    const wanted = [...options]
      .reverse()
      .find((c) => c.value === "" || startsOn(c.value));
    const pick = wanted ?? options[0];
    const { title, noun, description } = describe(ask.scope, input);
    const now = floor === "none" ? undefined : `Now: ${LEVEL_LABELS[floor]}`;
    const id = nextId();
    patternOf.set(id, ask.scope.typePattern);
    return {
      kind: "level",
      id,
      ...(name === undefined ? {} : { name }),
      ...(isExactTypeScope(ask.scope) ? { type: ask.scope.typePattern } : {}),
      title,
      noun,
      held: floor,
      description: [now, description].filter(Boolean).join(". ") || undefined,
      options: options.map((c) => ({
        value: c.value,
        label: LEVEL_LABELS[c.level],
      })),
      selected: pick?.value ?? "",
    };
  };

  /** The types to choose in place of all data, one level control each. */
  const chooseFor = (ask: Ask): ChooseTypes | undefined => {
    if (ask.scope.kind !== "type" || ask.scope.typePattern !== "*")
      return undefined;
    const rows: LevelRow[] = [];
    for (const type of input.chooseTypes ?? []) {
      const parsed = parseScope(`${type.id}:read`);
      if (!parsed) continue;
      const row = rowFor(
        {
          key: `type:${type.id}`,
          scope: parsed,
          read: ask.read === undefined ? undefined : `${type.id}:read`,
          write: ask.write === undefined ? undefined : `${type.id}:write`,
        },
        "types",
      );
      if (row) rows.push(row);
    }
    return rows.length > 0 ? { value: CHOOSE_TYPES, rows } : undefined;
  };

  const data: LevelRow[] = [];
  const profile: (LevelRow | SwitchRow)[] = [];
  let offersEdit = false;
  for (const ask of asks.values()) {
    const row = rowFor(ask);
    if (!row) continue;
    const choose = chooseFor(ask);
    if (choose) {
      row.choose = choose;
      row.options.push({ value: CHOOSE_TYPES, label: CHOOSE_TYPES_LABEL });
    }
    if (
      (ask.scope.kind === "type" || ask.scope.kind === "content") &&
      row.options.some((option) => option.label === LEVEL_LABELS.write)
    )
      offersEdit = true;
    if (ask.scope.kind === "profile") profile.push(row);
    else data.push(row);
  }
  const powers = new Map<string, SwitchRow[]>();
  for (const scope of switches) {
    const literal = scopeLiteral(scope);
    if (grantCoversScope(held, literal)) continue;
    const permission =
      scope.kind === "permission" ? scope.permission : undefined;
    const destructive =
      permission !== undefined && DESTRUCTIVE_PERMISSIONS.has(permission);
    const row: SwitchRow = {
      kind: "switch",
      id: nextId(),
      literal,
      title: scopeTitle(scope),
      description: permission ? permissionDescription(permission) : undefined,
      destructive,
      checked: startsOn(literal),
    };
    if (scope.kind === "permission") {
      const group =
        PERMISSION_GROUPS.find((g) =>
          g.permissions.some((p) => p === scope.permission),
        )?.id ?? "run";
      powers.set(group, [...(powers.get(group) ?? []), row]);
    } else {
      profile.push(row);
    }
  }

  const ordered: SwitchRow[] = [];
  for (const group of PERMISSION_GROUPS)
    ordered.push(
      ...(powers.get(group.id) ?? []).sort(
        (a, b) =>
          group.permissions.findIndex((p) => p === a.literal) -
          group.permissions.findIndex((p) => p === b.literal),
      ),
    );

  const offered = [...data, ...profile].flatMap((row) =>
    row.kind === "level" ? [row, ...(row.choose?.rows ?? [])] : [],
  );
  const heldList = describeHeld(
    held,
    input,
    {},
    offered.map((row) => ({
      row,
      pattern: patternOf.get(row.id) ?? "",
      exact: row.type !== undefined,
    })),
  );
  const empty = {
    data: returning ? "Nothing new turned on" : "No access to your data",
    profile: returning ? "Nothing new turned on" : "No access to your profile",
  };
  const picks = (rows: readonly (LevelRow | SwitchRow)[]): LevelPick[] =>
    rows
      .filter((row): row is LevelRow => row.kind === "level")
      .map((row) => ({
        noun: row.noun,
        alias: row.type,
        held: row.held,
        level: levelOfValue(row.selected, row.held),
      }));

  return {
    data,
    profile,
    powers: ordered,
    held: heldList.rows,
    summaries: {
      data: dataSummary(picks(data), empty.data),
      profile: profileSummary(
        picks(profile),
        profile
          .filter((row): row is SwitchRow => row.kind === "switch")
          .filter((row) => row.checked)
          .map((row) => row.title),
        empty.profile,
      ),
      powers: powersSummary(
        ordered.filter((row) => row.checked).length,
        ordered.length,
      ),
      empty,
      held: heldList.summary,
    },
    mechanisms,
    returning,
    offersEdit,
  };
}

/** A power a credential holds, by its title. */
export interface HeldPower {
  title: string;
  /** The line under the title wherever a person decides on the power, if it has one. */
  description?: string;
  /** Deletes data with no way back. */
  destructive: boolean;
}

/**
 * What a credential holds, described once for every page that shows it: the
 * approval pages (as "Already allowed"), and a key's or an app's page. It is
 * the words the approval controls use, so one grant reads the same wherever
 * it is shown.
 */
export interface HeldAccess {
  /** One line for each thing held, in the order held: the box on the approval pages. */
  rows: HeldRow[];
  /** What is held of the person's data, links and definitions, at the level held. */
  data: HeldRow[];
  /** What is held of the person's profile, at the level held. */
  profile: HeldRow[];
  /** The powers held, in the order held. */
  powers: HeldPower[];
  /** The line for the whole box. */
  summary: string;
  /** The line for each group, as the approval controls say it. */
  summaries: { data: string; profile: string; powers: string };
}

/** A row of a page beside the pattern it stands for, and whether that is one item type exactly. */
interface Named {
  row: { title: string; description?: string };
  pattern: string;
  exact: boolean;
}

/**
 * Where rows a person reads together share a title but stand for different
 * things, put what an item type stands for under its title: two item types
 * can share a label, and so can a type and a curated row such as Profile, and
 * a list of "Task" and "Task" leaves the person nothing to tell them by. A
 * curated row never gets a line, since its title is the name of what it is.
 * A row whose title is its own is left as it is. Call it once for a page's
 * rows, since a second call would name them twice.
 */
function tellApart(named: readonly Named[]): void {
  const patterns = new Map<string, Set<string>>();
  for (const { row, pattern } of named)
    patterns.set(
      row.title,
      (patterns.get(row.title) ?? new Set()).add(pattern),
    );
  for (const { row, pattern, exact } of named) {
    if (!exact || (patterns.get(row.title)?.size ?? 0) < 2) continue;
    row.description = [pattern, row.description].filter(Boolean).join(". ");
  }
}

/**
 * What a key holds that a scope cannot say: a thing held at no access beside
 * a wider grant, and an extension namespace, which no scope names.
 */
export interface HeldExtras {
  /**
   * Scope literals, at either level, that name a thing held at no access: a
   * key that reads all data and is denied one type. Shown as no access.
   */
  denied?: readonly string[];
  /** An extension namespace and the level it is held at. */
  extensions?: Readonly<Record<string, Level>>;
}

/**
 * Describe the scopes a credential holds: an app's consent or a key's
 * permissions read as scopes ({@link scopesOfKey}). The mechanisms
 * (`openid`, `offline_access`) are no access and are left out.
 *
 * `alongside` is the rows the same page offers, so that a held row and an
 * offered one that read alike are told apart too.
 */
export function describeHeld(
  held: readonly string[],
  words: Words,
  extras: HeldExtras = {},
  alongside: readonly Named[] = [],
): HeldAccess {
  const rows = new Map<string, HeldRow>();
  const named: Named[] = [];
  const data: HeldRow[] = [];
  const profile: HeldRow[] = [];
  const powers: HeldPower[] = [];
  const levels: HeldLevel[] = [];
  const dataLevels: HeldLevel[] = [];
  const profileLevels: HeldLevel[] = [];
  const seen: string[] = [];
  const powerTitles: string[] = [];
  const keyOf = (scope: ParsedScope, literal: string): string =>
    isLevelKind(scope) ? `${scope.kind}:${scope.typePattern}` : literal;
  const denied = new Map<string, { scope: ParsedScope; profile: boolean }>();
  for (const literal of extras.denied ?? []) {
    const scope = parseScope(literal);
    if (scope && isLevelKind(scope))
      denied.set(keyOf(scope, literal), {
        scope,
        profile: scope.kind === "profile",
      });
  }
  for (const literal of held) {
    const scope = parseScope(literal);
    if (!scope || (scope.kind === "oidc" && isMechanism(literal))) continue;
    const key = keyOf(scope, literal);
    if (rows.has(key) || denied.has(key)) continue;
    const { title, noun } = describe(scope, words);
    if (isLevelKind(scope)) {
      const level = levelHeld(held, scope.typePattern);
      const row: HeldRow = { title, value: LEVEL_LABELS[level] };
      rows.set(key, row);
      const exact = isExactTypeScope(scope);
      const alias = exact ? scope.typePattern : undefined;
      named.push({ row, pattern: scope.typePattern, exact });
      levels.push({ noun, alias, level });
      if (scope.kind === "profile") {
        profile.push(row);
        profileLevels.push({ noun, alias, level });
      } else {
        data.push(row);
        dataLevels.push({ noun, alias, level });
      }
    } else {
      const row = { title, value: "On" };
      rows.set(key, row);
      if (scope.kind === "permission") {
        powerTitles.push(title);
        powers.push({
          title,
          description:
            scope.permission === undefined
              ? undefined
              : permissionDescription(scope.permission),
          destructive:
            scope.permission !== undefined &&
            DESTRUCTIVE_PERMISSIONS.has(scope.permission),
        });
      } else {
        seen.push(title);
        profile.push(row);
      }
    }
  }
  // Held at no access: shown as such, and said in the line, because a wider
  // grant beside it would otherwise read as covering it.
  const noAccess = {
    data: [] as { noun: string; alias?: string }[],
    profile: [] as { noun: string; alias?: string }[],
  };
  for (const [key, { scope, profile: isProfile }] of denied) {
    const { title, noun } = describe(scope, words);
    const row: HeldRow = { title, value: LEVEL_LABELS.none };
    rows.set(key, row);
    const exact = isExactTypeScope(scope);
    named.push({ row, pattern: scope.typePattern, exact });
    (isProfile ? profile : data).push(row);
    (isProfile ? noAccess.profile : noAccess.data).push({
      noun,
      alias: exact ? scope.typePattern : undefined,
    });
  }
  for (const [namespace, level] of Object.entries(extras.extensions ?? {})) {
    const row = { title: namespace, value: LEVEL_LABELS[level] };
    rows.set(`extension:${namespace}`, row);
    data.push(row);
    if (level === "none") noAccess.data.push({ noun: namespace });
    else {
      levels.push({ noun: namespace, level });
      dataLevels.push({ noun: namespace, level });
    }
  }
  tellApart([...named, ...alongside]);
  const none = {
    data: "No access to your data",
    profile: "No access to your profile",
  };
  const withNoAccess = (
    line: string,
    empty: string,
    denied: readonly { noun: string; alias?: string }[],
  ): string => {
    if (denied.length === 0) return line;
    const denial = `no access to ${listWords(nameApart(denied).map((d) => d.noun))}`;
    return line === empty
      ? denial.charAt(0).toUpperCase() + denial.slice(1)
      : `${line}; ${denial}`;
  };
  return {
    rows: [...rows.values()],
    data,
    profile,
    powers,
    summary: heldSummary(levels, seen, powerTitles),
    summaries: {
      data: withNoAccess(
        dataSummary(
          dataLevels.map((pick) => ({ ...pick, held: "none" })),
          none.data,
        ),
        none.data,
        noAccess.data,
      ),
      profile: withNoAccess(
        profileSummary(
          profileLevels.map((pick) => ({ ...pick, held: "none" })),
          seen,
          none.profile,
        ),
        none.profile,
        noAccess.profile,
      ),
      powers: `${String(powers.length)} turned on`,
    },
  };
}

export type Selection =
  { ok: true; scopes: string[]; chosen: boolean } | { ok: false };

/** The type controls of a submission: what they posted, and what the page offered. */
export interface TypeChoices {
  /** Every value the type controls posted, a scope literal or empty. */
  values: readonly string[];
  /** The ids of the item types the page offered, in the order it listed them. */
  offered: readonly string[];
}

const isAllDataScope = (literal: string): boolean => {
  const scope = parseScope(literal);
  return scope?.kind === "type" && scope.typePattern === "*";
};

/**
 * Read a submission back against the request it answers and the consent the
 * app holds when the approval commits.
 *
 * A submission carries only what the person chose and the mechanisms. Every
 * submitted value must be a literal the request named: anything else is a
 * form edited to ask for more than the screen showed, and nothing from it is
 * granted. A write that the request also named the read of brings that
 * read, so "Read and edit" is the same grant a person had before a level was
 * one control.
 *
 * Where the request names all data, the person may choose types instead: the
 * all-data control then posts {@link CHOOSE_TYPES} and the type controls
 * post the scopes chosen. Each is a type the page offered, at a level the
 * all-data scope the request named covers, so the choice is still the
 * request narrowed. Chosen types are granted in place of the all-data scope,
 * never beside it. The type controls are read only when types were chosen:
 * a page without a script posts them all the same, and one that names a type
 * deleted since the page was drawn means nothing while all data is kept.
 *
 * What the app holds rides along from the consent passed in, never from the
 * submission: the scopes the request names that this consent covers are
 * added, and so are the scopes it holds under an all-data scope the request
 * names, so a held scope stays in the token only while it is still held and
 * choosing types never drops one. A screen left open while the person ended
 * the app's access therefore gives back nothing it showed as allowed.
 *
 * `chosen` is whether the person chose anything new. A mechanism, or a
 * scope the app already holds, is never a choice. Where the request names
 * something else, so the page offered a control, approving with none of them
 * on is a denial and `chosen` is false. Where it names nothing else (an app
 * confirming what it holds, or asking only to know who the person is)
 * approving is a yes.
 */
export function resolveSelection(
  requested: readonly string[],
  submitted: readonly string[],
  held: readonly string[],
  types?: TypeChoices,
): Selection {
  const named = new Set(requested);
  const choosing = submitted.includes(CHOOSE_TYPES);
  const picked = [
    ...new Set(submitted.filter((v) => v !== "" && v !== CHOOSE_TYPES)),
  ];
  if (picked.some((v) => !named.has(v))) return { ok: false };

  const allData = requested.filter(isAllDataScope);
  const offered = types?.offered ?? [];
  const typeValues = [
    ...new Set((types?.values ?? []).filter((v) => v !== "")),
  ];
  const underAsk = (literal: string): boolean => {
    const scope = parseScope(literal);
    return (
      scope?.kind === "type" &&
      (scope.operation === "read" || scope.operation === "write") &&
      isExactTypeScope(scope) &&
      offered.includes(scope.typePattern) &&
      allData.some((wide) => grantCoversScope([wide], literal))
    );
  };
  if (choosing && typeValues.some((v) => !underAsk(v))) return { ok: false };
  if (choosing && allData.length === 0) return { ok: false };

  const scopes = new Set(picked);
  if (choosing) for (const literal of typeValues) scopes.add(literal);
  for (const literal of requested)
    if (!isMechanism(literal) && grantCoversScope(held, literal))
      scopes.add(literal);
  for (const literal of [...scopes]) {
    const scope = parseScope(literal);
    if (scope?.operation !== "write" || !isLevelKind(scope)) continue;
    const read = `${scope.typePattern}:read`;
    if (
      (named.has(read) && grantCoversScope([literal], read)) ||
      (typeValues.includes(literal) &&
        allData.some(
          (wide) => wide.endsWith(":read") && grantCoversScope([wide], read),
        ))
    )
      scopes.add(read);
  }

  // What the app holds under all data, kept unless something chosen already
  // covers it.
  const kept = held.filter((literal) => {
    const scope = parseScope(literal);
    return (
      scope !== null &&
      !scopes.has(literal) &&
      isExactTypeScope(scope) &&
      offered.includes(scope.typePattern) &&
      allData.some((wide) => grantCoversScope([wide], literal))
    );
  });
  for (const literal of kept)
    if (![...scopes].some((other) => grantCoversScope([other], literal)))
      scopes.add(literal);

  const offersChoice = requested.some((v) => !isCarried(v, held));
  const chosenValues = choosing ? [...picked, ...typeValues] : picked;
  const chosen = offersChoice
    ? chosenValues.some((v) => !isCarried(v, held))
    : scopes.size > 0;
  // In the request's order, whatever order the form arrived in, then the
  // types in the order the page lists them.
  const asked = new Set(requested);
  const order = (literal: string): number =>
    offered.indexOf(parseScope(literal)?.typePattern ?? "");
  const extra = [...scopes]
    .filter((literal) => !asked.has(literal))
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        (a.endsWith(":read") ? 0 : 1) - (b.endsWith(":read") ? 0 : 1),
    );
  return {
    ok: true,
    scopes: [...[...asked].filter((v) => scopes.has(v)), ...extra],
    chosen,
  };
}
