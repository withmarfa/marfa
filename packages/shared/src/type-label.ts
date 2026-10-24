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
  const last = id.split(".").at(-1) ?? id;
  return last.replace(/[_-]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** The label a definition names, or `undefined` where it names none: an empty
 *  label names nothing. */
export function namedLabel(label: string | undefined): string | undefined {
  return label === undefined || label === "" ? undefined : label;
}

/** Gives a definition that names no label, or an empty one, the label its
 *  identifier makes. Changes the definition it is given and returns it. */
export function labelledTypeDefinition<
  T extends { id: string; label?: string },
>(schema: T): T {
  schema.label = namedLabel(schema.label) ?? labelFromId(schema.id);
  return schema;
}
