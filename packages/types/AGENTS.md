# @withmarfa/types

JSON schemas for the platform-shipped type set, the validator those schemas are judged by, and the codegen that turns them into TypeScript registries. Private; bundled into `@withmarfa/shared`'s dist rather than published.

**Type identifiers are a data contract.** Stored items carry their type as a plain string and nothing rewrites that column, so moving a file between directories, re-partitioning the emitted registries or renaming anything must leave the identifier set untouched. `type-registry-identity.test.ts` in `@withmarfa/shared` pins the full set literally.

## One validator, two authoring paths

A type can be authored by committing JSON here or by `POST /types` on a running server, and both go through `validateTypeSchema`. There is no build-time dialect: a schema that builds here is one a space could have submitted over the wire, verbatim. `schema-round-trip.test.ts` is the guarantee.

Consequences worth knowing:

- **Required-ness may be declared either way.** A top-level `required` array and `required: true` on the field mean the same thing; the validator normalizes to the field.
- **`format` normalizes.** `url`, `email`, `datetime` and `date` are first-class field types, so the annotated string collapses. The annotation-only formats survive as `format` and are carried through, but are not enforced against values at write time.
- **Every field attribute survives to the registry.** An attribute the codegen dropped would make the in-tree files lie about what the runtime accepts.
- **Errors are self-describing**, carrying `field`, `expected`, `actual` and `hint`, plus a `code` for the classes the API maps to dedicated HTTP errors.

## Authoring rules

- **JSON-first.** Edit the type's JSON and run `pnpm --filter @withmarfa/types generate`. Never hand-edit `generated/*`; the freshness check regenerates and diffs.
- **Inheritance is single-parent and additive.** A child may add fields, and may re-state an inherited field only to sharpen its description or tighten it to required. The line is there because a child that reshapes a field leaves two incompatible readings of one property name on items a parent-typed reader expects to understand, while a sharper description resolves unambiguously.
- **No field name may shadow a first-class `Item` wire field.** Those names are top-level columns, so reusing one produces two values under the same key with no way to tell which is authoritative. `RESERVED_ITEM_FIELDS` is the list, held in step with the `Item` interface by a freshness test.
- **`_deferred: true`** keeps a JSON file on disk as a record of shape while excluding it from the runtime registry.
- **`compatible_with` is a claim that a reader of the target can read this type without knowing it**, verified at registration and at build time. Declare it only when true: a false claim invites a reader to parse fields that are not there. Every field the target _requires_ must be present here, required and shaped the same; every field it merely _declares_ must, if this type declares the same name, be shaped compatibly, because a reader reads an optional field whenever it is present. Omitting the field entirely is fine.
  - **Shape compatibility asks one question:** can a value valid under this field be handed to a reader of the target's field without a mis-parse? A narrower type may stand in for the wider one it lives inside, never the reverse, and an enum may narrow the target's value set.
  - **`format` does not gate on absence.** Nothing checks the annotation-only formats at write time, so a plain string and an annotated one admit the same values. A field that omits the target's annotation is accepted; one declaring a different annotation is rejected, because that is an author stating a contradiction rather than leaving a detail unsaid.
  - **Known limit:** the check reaches field declarations only. Two `object` fields compare as compatible whatever they contain, because the field model has no vocabulary for nested shape.
- **`roles` is a closed set of structural roles a type declares about itself**, so an edge can constrain on what a type is for rather than on its name. They are inherited down the parent chain and resolved at lookup time rather than flattened by the codegen, because a type registered at runtime under a shipped parent never passes through the codegen. Declaring a role widens a type; withdrawing one is breaking, since every edge constraining on it stops accepting the type.

Codegen output is deterministic: same input, byte-identical output. `pnpm --filter @withmarfa/types validate` checks the schemas without writing anything.
