import { labelFromName, pluralFromLabel } from "@withmarfa/types";

export {
  MAX_LABEL_LENGTH,
  labelFromName,
  pluralFromLabel,
  withFieldLabels,
} from "@withmarfa/types";

/**
 * The label a type or edge type gets when it names none: the last segment of
 * its identifier, with each hyphen and underscore made a space and each word
 * capitalized. `acme.list-member` becomes `List Member`.
 *
 * The Rust core carries the same function (`label_from_id` in
 * `marfa-core`'s `wire.rs`); a test on each side holds them to the same
 * answers.
 */
export function labelFromId(id: string): string {
  return labelFromName(id.split(".").at(-1) ?? id);
}

/** The label a definition names, or `undefined` where it names none: an empty
 *  label names nothing. */
export function namedLabel(label: string | undefined): string | undefined {
  return label === undefined || label === "" ? undefined : label;
}

/** Gives a definition that names no label, or an empty one, the label its
 *  identifier makes, and one that names no plural, or an empty one, the
 *  plural its label makes. Changes the definition it is given and returns
 *  it. */
export function labelledTypeDefinition<
  T extends { id: string; label?: string; plural?: string },
>(schema: T): T {
  schema.label = namedLabel(schema.label) ?? labelFromId(schema.id);
  schema.plural = namedLabel(schema.plural) ?? pluralFromLabel(schema.label);
  return schema;
}
