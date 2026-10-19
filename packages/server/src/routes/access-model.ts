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
 * empty value means no access), because the OAuth provider issues only
 * literals the signed request named. A choice is therefore the request
 * narrowed and never widened, and {@link resolveSelection} checks it as such.
 */
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import {
  grantCoversScope,
  HIDDEN_MECHANISM_SCOPES,
  parseScope,
  requiresExplicitConsent,
  scopesOfferedOffByDefaultOnly,
} from "@withmarfa/shared";
import {
  DESTRUCTIVE_PERMISSIONS,
  PERMISSION_GROUPS,
  permissionDescription,
} from "./permission-labels.js";
import { reachLine } from "./scope-openness.js";
import { SCOPE_LABELS, scopeTitle } from "./scope-copy.js";

type Level = "none" | "read" | "write";

const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 };

const LEVEL_LABELS: Record<Level, string> = {
  none: "No access",
  read: "Read only",
  write: "Read and edit",
};

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

/** One thing the app asks for at up to two levels. */
export interface LevelRow {
  kind: "level";
  id: string;
  title: string;
  description?: string;
  /** Lowest first. Never above the request, never below what the app holds. */
  options: LevelOption[];
  selected: string;
  isNew: boolean;
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
  isNew: boolean;
}

export interface HeldRow {
  title: string;
  value: string;
}

export interface PowerSection {
  id: string;
  title: string;
  description: string;
  rows: SwitchRow[];
}

export interface AccessModel {
  data: LevelRow[];
  profile: (LevelRow | SwitchRow)[];
  powers: PowerSection[];
  /** What the app already holds, to show and not to change. */
  held: HeldRow[];
  /** Submitted with the form without a control: mechanisms, and what the app already holds in full. */
  carried: string[];
  /** Whether the app already holds some access. */
  returning: boolean;
}

export interface AccessInput {
  scopes: readonly ParsedScope[];
  /** The consent the app already holds, or undefined for a first request. */
  held: readonly string[] | undefined;
  /** A sentence per type pattern, for a row the curated names do not explain. */
  descriptions?: Record<string, string>;
  /** The types an open-ended pattern matches today, keyed by pattern. */
  wildcardExpansions?: Record<string, string[]>;
  bundles: readonly PermissionBundle[];
}

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
 * The title a row carries, and the line under it where one adds something.
 *
 * A curated name is the title. Without one the sentence that explains the
 * scope stands in, without its full stop, and the humanized pattern is the
 * floor. The line under the title says how far an open-ended grant reaches,
 * which is composed from the grammar and never written into any copy, or
 * explains a scope whose name alone does not.
 */
function describe(
  scope: ParsedScope,
  input: AccessInput,
): { title: string; description?: string } {
  const sentence = input.descriptions?.[scope.typePattern];
  const curated = SCOPE_LABELS[scope.typePattern];
  const expansion =
    scope.kind === "oidc"
      ? undefined
      : input.wildcardExpansions?.[scope.typePattern];
  const reach = reachLine(scope, expansion);
  if (scope.kind === "type" && scope.typePattern === "*")
    return { title: "All your data", description: reach || undefined };
  if (scope.kind === "oidc" || scope.kind === "permission")
    return { title: scopeTitle(scope) };
  if (curated !== undefined) {
    const explains = scope.kind === "metadata" || scope.kind === "profile";
    return {
      title: curated,
      description:
        [explains ? sentence : undefined, reach || undefined]
          .filter(Boolean)
          .join(" ") || undefined,
    };
  }
  return {
    title: sentence?.replace(/\.$/, "") ?? scopeTitle(scope),
    description: reach || undefined,
  };
}

/** Build the controls for a request. */
export function buildAccess(input: AccessInput): AccessModel {
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
  const carried: string[] = [];
  for (const scope of input.scopes) {
    const literal = scopeLiteral(scope);
    if (scope.kind === "oidc" && isMechanism(literal)) {
      carried.push(literal);
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

  const rowFor = (ask: Ask): LevelRow | null => {
    const floor = levelHeld(held, ask.scope.typePattern);
    const top: Level = ask.write !== undefined ? "write" : "read";
    if (RANK[floor] >= RANK[top]) {
      // Held in full: shown, not offered, and still part of the request.
      for (const literal of [ask.read, ask.write])
        if (literal !== undefined) carried.push(literal);
      return null;
    }
    // The floor is none or read here: an app that holds write holds all of
    // any ask. The lowest choice adds nothing to the token. It is no access,
    // or, where the app holds a read the request does not name a literal for,
    // that held read, so a person can decline what is asked and keep what is
    // held.
    const options: { level: Level; value: string }[] = [];
    if (floor === "none" || ask.read === undefined)
      options.push({ level: floor, value: "" });
    if (ask.read !== undefined)
      options.push({ level: "read", value: ask.read });
    if (ask.write !== undefined)
      options.push({ level: "write", value: ask.write });
    const wanted = [...options]
      .reverse()
      .find((c) => c.value === "" || startsOn(c.value));
    const pick = wanted ?? options[0];
    const { title, description } = describe(ask.scope, input);
    const now = floor === "none" ? undefined : `Now: ${LEVEL_LABELS[floor]}.`;
    return {
      kind: "level",
      id: nextId(),
      title,
      description: [now, description].filter(Boolean).join(" ") || undefined,
      options: options.map((c) => ({
        value: c.value,
        label: LEVEL_LABELS[c.level],
      })),
      selected: pick?.value ?? "",
      isNew: returning,
    };
  };

  const data: LevelRow[] = [];
  const profile: (LevelRow | SwitchRow)[] = [];
  const patternOf = new Map<string, string>();
  for (const ask of asks.values()) {
    const row = rowFor(ask);
    if (!row) continue;
    patternOf.set(row.id, ask.scope.typePattern);
    if (ask.scope.kind === "profile") profile.push(row);
    else data.push(row);
  }
  // Two things that read alike are told apart by what they are called in
  // the registry, so no control is left unread.
  const seen = new Map<string, number>();
  for (const row of [...data, ...profile])
    seen.set(row.title, (seen.get(row.title) ?? 0) + 1);
  for (const row of [...data, ...profile]) {
    if (row.kind !== "level" || (seen.get(row.title) ?? 0) < 2) continue;
    const pattern = patternOf.get(row.id);
    row.description = [pattern, row.description].filter(Boolean).join(". ");
  }

  const powers = new Map<string, SwitchRow[]>();
  for (const scope of switches) {
    const literal = scopeLiteral(scope);
    if (grantCoversScope(held, literal)) {
      carried.push(literal);
      continue;
    }
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
      isNew: returning,
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

  const sections: PowerSection[] = [];
  for (const group of PERMISSION_GROUPS) {
    const rows = (powers.get(group.id) ?? []).sort(
      (a, b) =>
        group.permissions.findIndex((p) => p === a.literal) -
        group.permissions.findIndex((p) => p === b.literal),
    );
    if (rows.length > 0)
      sections.push({
        id: group.id,
        title: group.title,
        description: group.description,
        rows,
      });
  }

  return {
    data,
    profile,
    powers: sections,
    held: heldRows(held, input),
    carried,
    returning,
  };
}

/** Everything the app holds, one line for each thing, at the level it holds it. */
function heldRows(held: readonly string[], input: AccessInput): HeldRow[] {
  const rows = new Map<string, HeldRow>();
  for (const literal of held) {
    const scope = parseScope(literal);
    if (!scope || (scope.kind === "oidc" && isMechanism(literal))) continue;
    const key = isLevelKind(scope)
      ? `${scope.kind}:${scope.typePattern}`
      : literal;
    if (rows.has(key)) continue;
    const { title } = describe(scope, input);
    rows.set(key, {
      title,
      value: isLevelKind(scope)
        ? LEVEL_LABELS[levelHeld(held, scope.typePattern)]
        : "On",
    });
  }
  return [...rows.values()];
}

export type Selection =
  { ok: true; scopes: string[]; chosen: boolean } | { ok: false };

/**
 * Read a submission back against the request it answers and what the app
 * holds.
 *
 * Every submitted value must be a literal the request named: anything else is
 * a form edited to ask for more than the screen showed, and nothing from it
 * is granted. A write that the request also named the read of brings that
 * read, so "Read and edit" is the same grant a person had before a level was
 * one control.
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
): Selection {
  const named = new Set(requested);
  const picked = [...new Set(submitted.filter((v) => v !== ""))];
  if (picked.some((v) => !named.has(v))) return { ok: false };
  const scopes = new Set(picked);
  for (const literal of picked) {
    const scope = parseScope(literal);
    if (scope?.operation !== "write" || !isLevelKind(scope)) continue;
    const read = `${scope.typePattern}:read`;
    if (named.has(read) && grantCoversScope([literal], read)) scopes.add(read);
  }
  const offersChoice = requested.some((v) => !isCarried(v, held));
  const chosen = offersChoice
    ? picked.some((v) => !isCarried(v, held))
    : scopes.size > 0;
  return { ok: true, scopes: [...scopes], chosen };
}
