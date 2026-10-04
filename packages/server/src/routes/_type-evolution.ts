import { isDeepStrictEqual } from "node:util";
import type { FieldDefinition, TypeSchema } from "@withmarfa/shared";

/**
 * The members of a type a replacement may change without `schema.write`.
 *
 * A key holding `metadata.types:write` registered the type, and may add to it:
 * the changes that act on no stored row, no history and no other type.
 * Everything not named here needs `schema.write`, so a member added to the
 * definition later is held back by default.
 *
 * - `label`, `description` and `display_hints` are presentation.
 * - `version` is stamped on each row written afterwards as its
 *   `schema_version`, and the server decides nothing by it.
 * - `fields` is judged field by field in {@link evolutionOf}.
 */
const FREE_MEMBERS: ReadonlySet<string> = new Set([
  "id",
  "label",
  "description",
  "display_hints",
  "version",
  "fields",
]);

/** A field as the rows see it: everything but its description. */
function shapeOf(field: FieldDefinition): FieldDefinition {
  const shape = { ...field };
  delete shape.description;
  return shape;
}

const plain = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/** What a replacement does, sorted by whether `schema.write` is needed. */
export interface Evolution {
  /** The members and fields that need `schema.write`, as a refusal names
   *  them: a member's name, or `fields.<name>`. */
  needsSchemaWrite: string[];
  /** The optional fields the replacement adds. Each is free only where no
   *  stored row holds a value under its name. */
  additions: string[];
}

/**
 * What `next` does to `stored`, split into what needs `schema.write` and the
 * optional fields it adds.
 *
 * **Only an optional field added under a name no row holds is free.** A
 * removed field leaves each row's value where it is, so a removal followed by
 * an addition would give those values a new shape, or make a value the field
 * kept out of search searchable. A kept field's type, constraints, `required`
 * and `searchable` decide whether the rows already written pass their next
 * write and how they are searched. A required field is a new condition on
 * every row.
 *
 * **Every other member must be as it was**: `parent`, `roles`, `link_field`,
 * `version_policy`, `merge_policy` and `compatible_with`. Each acts beyond
 * the type: a link change forgets the purges its tombstones record, a
 * version policy thins history, a merge policy decides which concurrent edit
 * is dropped, a role changes what may link to the type, a parent changes
 * which fields it inherits and which queries find its rows, and a
 * `compatible_with` is a claim readers rely on.
 */
export function evolutionOf(stored: TypeSchema, next: TypeSchema): Evolution {
  const needsSchemaWrite: string[] = [];
  const additions: string[] = [];
  const before = stored as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  for (const member of new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    if (FREE_MEMBERS.has(member)) continue;
    if (!isDeepStrictEqual(plain(before[member]), plain(after[member]))) {
      needsSchemaWrite.push(member);
    }
  }
  for (const [name, field] of Object.entries(stored.fields)) {
    const replaced = Object.hasOwn(next.fields, name)
      ? next.fields[name]
      : undefined;
    if (
      replaced === undefined ||
      !isDeepStrictEqual(plain(shapeOf(field)), plain(shapeOf(replaced)))
    ) {
      needsSchemaWrite.push(`fields.${name}`);
    }
  }
  for (const [name, field] of Object.entries(next.fields)) {
    if (Object.hasOwn(stored.fields, name)) continue;
    if (field.required === true) needsSchemaWrite.push(`fields.${name}`);
    else additions.push(name);
  }
  return { needsSchemaWrite, additions };
}
