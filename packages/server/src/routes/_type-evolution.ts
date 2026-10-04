import { isDeepStrictEqual } from "node:util";
import type { FieldDefinition, TypeSchema } from "@withmarfa/shared";

/**
 * The members of a type a replacement may change without `schema.write`.
 *
 * A key holding `metadata.types:write` registered the type, and may add to it
 * and take its own declarations away: the changes that act on no stored row,
 * no history and no other type. Everything not named here needs
 * `schema.write`, so a member added to the definition later is held back by
 * default.
 *
 * - `label`, `description` and `display_hints` are presentation.
 * - `version` is a number the server never reads.
 * - `fields` is judged field by field in {@link changesNeedingSchemaWrite}.
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

/**
 * What `next` changes about `stored` that only `schema.write` may change,
 * as the names a refusal reports, in order.
 *
 * **A field added or removed is free; a field kept is held to what it was**,
 * its `description` apart. A kept field's type, constraints, `required` and
 * `searchable` decide whether the rows already written still pass the next
 * write, and how they are searched, so they are not an addition. A removed
 * field leaves each row's value where it is.
 *
 * **Every other member must be as it was**: `parent`, `roles`, `link_field`,
 * `version_policy`, `merge_policy` and `compatible_with`. Each acts beyond
 * the type: a link change forgets the purges its tombstones record, a
 * version policy thins history, a merge policy decides which concurrent edit
 * is dropped, a role changes what may link to the type, a parent changes
 * which fields it inherits and which queries find its rows, and a
 * `compatible_with` is a claim readers rely on.
 */
export function changesNeedingSchemaWrite(
  stored: TypeSchema,
  next: TypeSchema,
): string[] {
  const changes: string[] = [];
  const before = stored as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  for (const member of new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    if (FREE_MEMBERS.has(member)) continue;
    if (!isDeepStrictEqual(plain(before[member]), plain(after[member]))) {
      changes.push(member);
    }
  }
  for (const [name, field] of Object.entries(stored.fields)) {
    const replaced = next.fields[name];
    if (replaced === undefined) continue;
    if (!isDeepStrictEqual(plain(shapeOf(field)), plain(shapeOf(replaced)))) {
      changes.push(`fields.${name}`);
    }
  }
  return changes.sort();
}
