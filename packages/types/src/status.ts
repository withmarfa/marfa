import type {
  FieldDefinition,
  StatusGroup,
  StatusValue,
} from "./schema-types.js";
import { STATUS_GROUPS } from "./schema-types.js";

const STATUS_GROUP_SET: ReadonlySet<string> = new Set<string>(STATUS_GROUPS);

/**
 * What a status word may be: a lowercase letter, then up to 63 lowercase
 * letters, digits and underscores. The groups' own names fit it, and a word
 * fits a filter value, a URL and a command-line argument unquoted.
 */
export const STATUS_WORD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function isStatusGroup(value: unknown): value is StatusGroup {
  return typeof value === "string" && STATUS_GROUP_SET.has(value);
}

/**
 * One field's definition after a type in the chain declares it again. A
 * `status` field redeclared as `status` keeps the words above it and adds the
 * new ones after them; any other redeclaration replaces the definition.
 */
export function mergeFieldDefinition(
  inherited: FieldDefinition | undefined,
  own: FieldDefinition,
): FieldDefinition {
  if (inherited?.type !== "status" || own.type !== "status") return own;
  const above = inherited.status_values ?? [];
  const held = new Set(above.map((entry) => entry.value));
  const added = (own.status_values ?? []).filter(
    (entry) => !held.has(entry.value),
  );
  return { ...inherited, ...own, status_values: [...above, ...added] };
}

/**
 * Merges each type's own fields root to leaf into the fields the leaf
 * resolves to: a nearer declaration replaces a farther one, except that a
 * status field joins its words down the chain.
 */
export function mergeFieldChain(
  chain: readonly Readonly<Record<string, FieldDefinition>>[],
  into: Record<string, FieldDefinition> = {},
): Record<string, FieldDefinition> {
  for (const fields of chain) {
    for (const [name, own] of Object.entries(fields)) {
      into[name] = mergeFieldDefinition(into[name], own);
    }
  }
  return into;
}

/** The name of the one `status` field among `fields`, if there is one. */
export function statusFieldName(
  fields: Readonly<Record<string, FieldDefinition>>,
): string | undefined {
  return Object.entries(fields).find(([, def]) => def.type === "status")?.[0];
}

/** The group a resolved status field puts `word` in, if it declares it. */
export function statusGroupOf(
  field: FieldDefinition,
  word: unknown,
): StatusGroup | undefined {
  if (typeof word !== "string") return undefined;
  return field.status_values?.find((entry) => entry.value === word)?.group;
}

export type { StatusValue };
