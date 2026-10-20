/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * What a key or an app holds, shown read-only in the words and layout the
 * approval pages use, for a key's page and an app's page.
 *
 * The description is {@link describeHeld}, the same one the approval pages
 * show as "Already allowed", so one grant reads the same wherever a person
 * meets it. This part shows and never asks: it posts nothing.
 */
import { DisclosureRow, Row, RowGroup } from "../pages/parts/index.js";
import { parseScope, type ParsedScope } from "@withmarfa/shared";
import type { Level } from "../pages/access-summary.js";
import type { Storage } from "../storage/interface.js";
import { describeHeld, type HeldExtras, type HeldRow } from "./access-model.js";
import {
  buildScopeDescriptions,
  resolveTypeLabels,
  resolveWildcardExpansions,
} from "./auth-consent.js";

/** The words a caller looked up to name what is held; see {@link describeHeld}. */
export interface AccessViewProps extends HeldExtras {
  /** The scopes held: an app's consent, or a key through {@link scopesOfKey}. */
  scopes: readonly string[];
  /** A sentence per type pattern, for a row the curated names do not explain. */
  descriptions?: Record<string, string>;
  /** The types an open-ended pattern matches today, keyed by pattern. */
  wildcardExpansions?: Record<string, string[]>;
  /** The label of each item type held, keyed by type id. */
  typeLabels?: Record<string, string>;
}

function HeldRows(props: { rows: readonly HeldRow[] }) {
  return (
    <>
      {props.rows.map((row) => (
        <Row title={row.title} value={row.value} />
      ))}
    </>
  );
}

/**
 * One box of rows that open: "Your data", then "Your profile" and "More
 * control over Marfa" where something is held in them. "Your data" is always
 * there, because that nothing is held in it is worth saying.
 */
export function AccessView(props: AccessViewProps) {
  const held = describeHeld(props.scopes, props, props);
  return (
    <RowGroup>
      <DisclosureRow title="Your data" description={held.summaries.data}>
        {held.data.length === 0 ? (
          <Row title="No access" />
        ) : (
          <HeldRows rows={held.data} />
        )}
      </DisclosureRow>
      {held.profile.length > 0 && (
        <DisclosureRow
          title="Your profile"
          description={held.summaries.profile}
        >
          <HeldRows rows={held.profile} />
        </DisclosureRow>
      )}
      {held.powers.length > 0 && (
        <DisclosureRow
          title="More control over Marfa"
          description={held.summaries.powers}
        >
          {held.powers.map((power) => (
            <Row
              title={power.title}
              description={power.description}
              descriptionTone={power.destructive ? "danger" : undefined}
              value="On"
            />
          ))}
        </DisclosureRow>
      )}
    </RowGroup>
  );
}

/** What a key holds, as the maps and permissions its record carries. */
export interface KeyAccess {
  permissions?: readonly string[];
  type_permissions?: Readonly<Record<string, string>>;
  edge_permissions?: Readonly<Record<string, string>>;
  metadata_permissions?: Readonly<Record<string, string>>;
  profile_permissions?: Readonly<Record<string, string>>;
  extension_permissions?: Readonly<Record<string, string>>;
}

/** A key's access as {@link AccessView} takes it: `<AccessView {...scopesOfKey(key)} />`. */
export interface KeyHeld extends HeldExtras {
  scopes: string[];
}

const levelOf = (level: string): Level | undefined =>
  level === "read" || level === "write" || level === "none" ? level : undefined;

/**
 * What a key's record holds, in the form the view reads. A map entry at
 * `none` is a thing the key is denied, shown as no access beside a wider
 * grant. A `*` in the profile or metadata map is the whole of it, named as
 * the pages and the CLI name it ("Profile", "Definitions on your server"),
 * not as a type pattern. An extension namespace is no scope and is carried
 * beside them.
 */
export function scopesOfKey(key: KeyAccess): KeyHeld {
  const scopes = [...(key.permissions ?? [])];
  const denied: string[] = [];
  const maps: [
    (name: string) => string,
    Readonly<Record<string, string>> | undefined,
  ][] = [
    [(name) => name, key.type_permissions],
    [(name) => `edge.${name}`, key.edge_permissions],
    [
      (name) => (name === "*" ? "metadata" : `metadata.${name}`),
      key.metadata_permissions,
    ],
    [
      (name) => (name === "*" ? "profile" : `profile.${name}`),
      key.profile_permissions,
    ],
  ];
  for (const [pattern, map] of maps)
    for (const [name, text] of Object.entries(map ?? {})) {
      const level = levelOf(text);
      if (level === "none") denied.push(`${pattern(name)}:read`);
      else if (level) scopes.push(`${pattern(name)}:${level}`);
    }
  const extensions: Record<string, Level> = {};
  for (const [namespace, text] of Object.entries(
    key.extension_permissions ?? {},
  )) {
    const level = levelOf(text);
    if (level) extensions[namespace] = level;
  }
  return { scopes, denied, extensions };
}

/**
 * Look up what {@link AccessView} needs to name the scopes: the labels of
 * the registered types, the sentences for the rows the curated names do not
 * explain, and the types an open-ended pattern reaches today. The approval
 * pages look up the same things.
 */
export async function readAccessWords(
  storage: Storage,
  scopes: readonly string[],
): Promise<
  Pick<AccessViewProps, "descriptions" | "wildcardExpansions" | "typeLabels">
> {
  const parsed = scopes
    .map((literal) => parseScope(literal))
    .filter((scope): scope is ParsedScope => scope !== null);
  return {
    descriptions: buildScopeDescriptions(parsed),
    wildcardExpansions: await resolveWildcardExpansions(storage, parsed),
    typeLabels: await resolveTypeLabels(storage, scopes),
  };
}
