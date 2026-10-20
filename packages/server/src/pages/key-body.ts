/**
 * What the key pages send for the choices on their forms, in one place so the
 * browser module and its tests read the same rules.
 *
 * The access controls submit scope literals, the same ones an approval page
 * does. A key's record holds the same grants as five maps and a list of
 * permissions, and this turns the one into the other. It reads no document and
 * no server state, and it knows only the literals a key form offers: a level
 * on item types, on link types, on definitions or on the profile, and the
 * permissions.
 */

export type MapLevel = "read" | "write";

/** The access part of a key's record: what `POST /keys` and `PATCH /keys/{id}` take. */
export interface KeyAccessBody {
  permissions: string[];
  type_permissions: Record<string, MapLevel>;
  edge_permissions: Record<string, MapLevel>;
  metadata_permissions: Record<string, MapLevel>;
  profile_permissions: Record<string, MapLevel>;
}

/** The maps a key can hold a level in, by the name its record gives them. */
export const KEY_MAPS = [
  "type_permissions",
  "edge_permissions",
  "metadata_permissions",
  "profile_permissions",
] as const;

export type KeyMap = (typeof KEY_MAPS)[number];

/** The names a key is denied in each map: entries at `none`, which a scope cannot say. */
export type Denials = Partial<Record<KeyMap, readonly string[]>>;

const LEVEL_RE = /^(.+):(read|write)$/;

/** Which map a literal belongs to, and the name it has there. */
function placeOf(
  literal: string,
): { map: KeyMap; name: string; level: MapLevel } | undefined {
  const match = LEVEL_RE.exec(literal);
  if (!match) return undefined;
  const head = match[1] ?? "";
  const level = match[2] as MapLevel;
  if (head.startsWith("edge."))
    return { map: "edge_permissions", name: head.slice("edge.".length), level };
  if (head === "metadata" || head.startsWith("metadata."))
    return {
      map: "metadata_permissions",
      name: head === "metadata" ? "*" : head.slice("metadata.".length),
      level,
    };
  if (head === "profile" || head.startsWith("profile."))
    return {
      map: "profile_permissions",
      name: head === "profile" ? "*" : head.slice("profile.".length),
      level,
    };
  return { map: "type_permissions", name: head, level };
}

/**
 * The record's access for the literals a form submitted. A literal without a
 * level is a permission. Where two name one thing, the higher level wins. A
 * map nothing is in is `{}`, never left out, because a create that names none
 * of them gives the key everything its maker holds.
 */
export function accessBody(literals: readonly string[]): KeyAccessBody {
  const body: KeyAccessBody = {
    permissions: [],
    type_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
  };
  for (const literal of literals) {
    const place = placeOf(literal);
    if (!place) {
      if (!body.permissions.includes(literal)) body.permissions.push(literal);
      continue;
    }
    const map = body[place.map];
    if (map[place.name] !== "write") map[place.name] = place.level;
  }
  return body;
}

/**
 * The same access with the key's denials put back. A map is sent whole, so a
 * denial left out of it would be a denial dropped; one a grant now names
 * itself is left to the grant.
 */
export function withDenials(
  body: KeyAccessBody,
  denials: Denials,
): Record<KeyMap, Record<string, MapLevel | "none">> &
  Pick<KeyAccessBody, "permissions"> {
  const kept = {
    permissions: body.permissions,
    type_permissions: { ...body.type_permissions },
    edge_permissions: { ...body.edge_permissions },
    metadata_permissions: { ...body.metadata_permissions },
    profile_permissions: { ...body.profile_permissions },
  } as Record<KeyMap, Record<string, MapLevel | "none">> &
    Pick<KeyAccessBody, "permissions">;
  for (const map of KEY_MAPS)
    for (const name of denials[map] ?? []) kept[map][name] ??= "none";
  return kept;
}

/** The ends a key can be given, as the `Ends` select posts them. */
export const END_CHOICES = ["never", "30", "90", "365"] as const;

export type EndChoice = (typeof END_CHOICES)[number];

const DAY_MS = 86_400_000;

/**
 * When a key stops working for a choice made now: `null` for never, else an
 * ISO 8601 time that many days from `now`.
 */
export function endsAt(choice: EndChoice, now: number): string | null {
  return choice === "never"
    ? null
    : new Date(now + Number(choice) * DAY_MS).toISOString();
}

const DAYS_OF: Record<Exclude<EndChoice, "never">, number> = {
  "30": 30,
  "90": 90,
  "365": 365,
};

/**
 * The ends a saved key can be offered at `now`. A key that never ends can be
 * given any; one that ends can be given only an end no later than its own,
 * and never "never", because a key's page gives a key less and never more.
 */
export function endChoicesFor(
  current: number | null,
  now: number,
): EndChoice[] {
  if (current === null) return [...END_CHOICES];
  return END_CHOICES.filter(
    (choice) => choice !== "never" && now + DAYS_OF[choice] * DAY_MS <= current,
  );
}

/**
 * An end no later than `limit`. The page offers only ends within the key's
 * own, measured when it was drawn; this keeps the one sent within it when a
 * few seconds have passed since.
 */
export function notAfter(
  end: string | null,
  limit: string | undefined,
): string | null {
  return end !== null &&
    limit !== undefined &&
    Date.parse(end) > Date.parse(limit)
    ? limit
    : end;
}

/** The level integration (extension) data can be given on every namespace. */
export type ExtensionLevel = "none" | MapLevel;

/**
 * The level a new key's integration data starts at: that of all data, when
 * the key is given all data, else none.
 */
export function extensionFollowing(
  literals: readonly string[],
): ExtensionLevel {
  if (literals.includes("*:write")) return "write";
  if (literals.includes("*:read")) return "read";
  return "none";
}

/**
 * A new key's `extension_permissions`. None is an empty map, never left out,
 * because a create that names no map gives the key what its maker holds.
 */
export function extensionPermissions(
  level: ExtensionLevel,
): Record<string, MapLevel> {
  return level === "none" ? {} : { "*": level };
}

/** The parts of a key a saved page can change or be undone by. */
export interface FingerprintedKey {
  permissions?: readonly string[];
  type_permissions?: Readonly<Record<string, string>>;
  edge_permissions?: Readonly<Record<string, string>>;
  metadata_permissions?: Readonly<Record<string, string>>;
  profile_permissions?: Readonly<Record<string, string>>;
  extension_permissions?: Readonly<Record<string, string>>;
  expires_at?: string | null;
}

const sortedEntries = (
  map: Readonly<Record<string, string>> | undefined,
): [string, string][] =>
  Object.entries(map ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * What a key's page loaded, as one string: the server writes it into the page
 * from the stored key, and the browser computes it again from the key the API
 * answers, so a page can tell that the key changed after it was drawn.
 */
export function keyFingerprint(key: FingerprintedKey): string {
  return JSON.stringify([
    [...(key.permissions ?? [])].sort(),
    sortedEntries(key.type_permissions),
    sortedEntries(key.edge_permissions),
    sortedEntries(key.metadata_permissions),
    sortedEntries(key.profile_permissions),
    sortedEntries(key.extension_permissions),
    key.expires_at ?? null,
  ]);
}

/** The source a key writes as, claimed sources split from the comma list. */
export function claimedSources(text: string, own: string): string[] {
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && name !== own);
  return [...new Set(names)];
}

/** Marfa's write rules, skipped: every lever the instance sets, empty for this key. */
export const SKIPPED_WRITE_RULES = {
  strict_mode: { types: [] },
  source_allowlist: { types: [], sources: [] },
  source_filter: { types: [], sources: [] },
} as const;
