# @withmarfa/types

Canonical Marfa type schemas. Owns the JSON source, the codegen, and the generated TypeScript registries that `@withmarfa/shared` consumes.

## Layout

- `core/*.json`: the core type schemas
- `core/edges/*.json`: the core edge types
- `core/system/*.json`: the `system.*` types, the platform's own records
- `scripts/validate.ts`: JSON shape validator (runs in CI)
- `scripts/generate.ts`: codegen that turns the JSON into the two registries below
- `generated/type-registry.ts`: auto-generated; do not edit
- `generated/edge-type-registry.ts`: auto-generated; do not edit
- `src/schema-types.ts`: schema-shape interfaces (`TypeSchema`, `FieldDefinition`, `ItemState`, `VersionPolicy`)
- `src/index.ts`: the package entry, which re-exports the schema interfaces, `ALL_TYPES`, `ALL_SYSTEM_TYPES`, `ALL_EDGE_TYPES`, `ALL_TYPE_IDS` and `PlatformTypeId`

## Schema format

Each type is a JSON file with:

- **`id`**: type identifier (e.g. `core.note`, `core.media.book`)
- **`parent`**: parent type ID, if a subtype
- **`label`**: optional, the name people see for the type, at most 100 characters; a type that names none is shown by one made from the last segment of its `id`
- **`plural`**: optional, the name of a list of the type's items, at most 100 characters; a type that names none is answered with one made from its label (`Story` makes `Stories`), and a subtype never takes its parent's
- **`description`**: what this type represents
- **`version`**: schema version, a non-negative integer; every shipped type is at 0 until the first public release
- **`fields`**: field name → definition map
- **`required`**: array of required field names

Field definitions:

- **`type`**: one of `FIELD_TYPES` (`src/schema-validation.ts`), namely `string`, `number`, `integer`, `boolean`, `url`, `email`, `datetime`, `date`, `enum`, `status`, `array`, `object`, `thumbnail`. A `thumbnail` is a small image the writer supplies as a `data:` URI of a PNG, JPEG or WebP, at most 16 KiB decoded; a type carries at most one, never named `title`, `body`, `description` or `name`.
- **`description`**: what the field is
- **`label`**: optional, the name people see for the field, at most 100 characters. `GET /types/{id}` answers the nearest label in the type's chain, else one made from the field's name (`due_at` reads as `Due At`); a member of `items_fields` takes one the same way
- **`format`**: optional, one of `FIELD_FORMATS`. The formats `url`, `email`, `datetime`, `date` and `thumbnail` normalize into `type`; `bcp47`, `iso3166`, `currency` and `phone` annotate a `string` and survive as `format`; a write is checked only against `currency`, which takes three capital letters such as `GBP`
- **`enum_values`**: required for `enum` type
- **`status_values`**: required for `status` type, except on a subtype that declares its inherited `status` field again: the words the field takes, each `{ "value": "in_review", "group": "in_progress" }`, in one of the four groups `not_started`, `in_progress`, `completed` and `canceled`. A type carries at most one `status` field
- **`items_type`**: required for `array` type
- **`items_fields`**: optional on an `array` whose `items_type` is `object`: the members of each entry, by name. A member takes `type` (`string`, `email`, `url`, `enum`, `boolean`, `integer`, `number`, `date` or `datetime`), `description`, `label`, `required`, `enum_values`, `format`, `maxLength`, `minimum` and `maximum`. An entry holds at least one member, only declared ones and every required one
- **`minimum`**, **`maximum`**: optional on a `number` or `integer` field or member; both bounds are inclusive. A subtype may raise a `minimum` or lower a `maximum`, never loosen or drop one

A property holds a number as a 64-bit float, and Marfa serves it in the shortest digits that name that float. A write that holds a whole number written in other digits, such as `1152921504606846976`, which is served as `1152921504606847000`, in a declared or an undeclared property at any depth, in an item, an edge or an extension, is refused as `invalid_properties`; send such a number as a string. Every whole number up to 9007199254740991 is kept as written, except `-0`, which is served as `0` and so is refused. Marfa judges a `url` value as the WHATWG URL standard does and stores it without the whitespace around it and without any tab or line break inside it.

Subtypes only declare fields they add. They inherit all parent fields and **may not redefine them** (enforced at registration), except that a subtype may declare an inherited field again with a new `description` or `label`, or make it required, and may declare an inherited `status` field again with only the words it adds.

## Commands

```sh
pnpm validate      # validate every schema in core/, core/system/ and core/edges/
pnpm generate      # regenerate both registries in generated/
pnpm shapes:digest # rewrite shipped-shapes.sha256 after a shipped shape changes
pnpm build         # bundle src/ to dist/ for downstream consumers
pnpm typecheck
```

CI runs `pnpm validate` and a codegen-freshness check on every push to `main` and every pull request that can affect them: it empties `generated/`, regenerates it, and refuses any difference, a file the generator did not write included.

## Adding a new type

1. Create `core/<name>.json` following the schema format above
2. If it's a subtype, set `parent` and include only new fields (do not redefine ancestor fields)
3. `pnpm validate` to check the schema
4. `pnpm generate` to regenerate the registry
5. `pnpm shapes:digest` to rewrite `shipped-shapes.sha256`, since a new or changed type moves the shapes it holds
6. Commit with `feat(types): add core.<name> type`
