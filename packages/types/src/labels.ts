import type { FieldDefinition } from "./schema-types.js";

/**
 * The label a name gets when nothing names one: each hyphen and underscore
 * made a space and the first letter after the start or a space capitalized,
 * whatever its script. `due_at` becomes `Due At` and `résumé` becomes `Résumé`.
 *
 * The Rust core carries the same function (`label_from_name` in
 * `marfa-core`'s `wire.rs`); a test on each side holds them to the same
 * answers.
 */
export function labelFromName(name: string): string {
  return name
    .replace(/[_-]/g, " ")
    .replace(
      /(^| )([^ ])/gu,
      (_, lead: string, ch: string) => lead + ch.toUpperCase(),
    );
}

/**
 * The plural a label gets when its type names none, by the regular English
 * rule on lowercase letters: a consonant and `y` become `ies`, an ending of
 * `s`, `x`, `z`, `ch` or `sh` takes `es`, and any other label takes `s`, so
 * `Story` makes `Stories`, `Box` makes `Boxes` and `URL` makes `URLs`. A word the rule gets wrong,
 * such as `Person`, is named by its type.
 *
 * The Rust core carries the same function (`plural_from_label` in
 * `marfa-core`'s `wire.rs`); a test on each side holds them to the same
 * answers.
 */
export function pluralFromLabel(label: string): string {
  if (/[b-df-hj-np-tv-z]y$/.test(label)) return `${label.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(label)) return `${label}es`;
  return `${label}s`;
}

/**
 * Resolved fields with every label filled: a field or a member of a list's
 * entries that names none takes the one its name makes. Returns new
 * definitions and leaves those given unchanged.
 */
export function withFieldLabels(
  fields: Readonly<Record<string, FieldDefinition>>,
): Record<string, FieldDefinition> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => {
      const labelled: FieldDefinition = {
        ...field,
        label: field.label ?? labelFromName(name),
      };
      if (field.items_fields) {
        labelled.items_fields = Object.fromEntries(
          Object.entries(field.items_fields).map(([member, definition]) => [
            member,
            { ...definition, label: definition.label ?? labelFromName(member) },
          ]),
        );
      }
      return [name, labelled];
    }),
  );
}
