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
- **`description`**: what this type represents
- **`version`**: schema version, a non-negative integer; every shipped type is at 0 until the first public release
- **`fields`**: field name → definition map
- **`required`**: array of required field names

Field definitions:

- **`type`**: one of `FIELD_TYPES` (`src/schema-validation.ts`), namely `string`, `number`, `integer`, `boolean`, `url`, `email`, `datetime`, `date`, `enum`, `status`, `array`, `object`, `thumbnail`. A `thumbnail` is a small image the writer supplies as a `data:` URI of a PNG, JPEG or WebP, at most 16 KiB decoded; a type carries at most one, never named `title`, `body`, `description` or `name`.
- **`description`**: what the field is
- **`format`**: optional, one of `FIELD_FORMATS`. The formats `url`, `email`, `datetime`, `date` and `thumbnail` normalize into `type`; `bcp47` and `iso3166` annotate a `string` and survive as `format`
- **`enum_values`**: required for `enum` type
- **`status_values`**: required for `status` type, except on a subtype that declares its inherited `status` field again: the words the field takes, each `{ "value": "in_review", "group": "in_progress" }`, in one of the four groups `not_started`, `in_progress`, `completed` and `canceled`. A type carries at most one `status` field
- **`items_type`**: required for `array` type

A property holds a number as a 64-bit float, and Marfa serves it in the shortest digits that name that float. A write that holds a whole number written in other digits, such as `1152921504606846976`, which is served as `1152921504606847000`, in a declared or an undeclared property at any depth, in an item, an edge or an extension, is refused as `invalid_properties`; send such a number as a string. Every whole number up to 9007199254740991 is kept as written, except `-0`, which is served as `0` and so is refused. Marfa judges a `url` value as the WHATWG URL standard does and stores it without the whitespace around it and without any tab or line break inside it.

Subtypes only declare fields they add. They inherit all parent fields and **may not redefine them** (enforced at registration), except that a subtype may declare an inherited `status` field again with only the words it adds.

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
