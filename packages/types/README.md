# @mymehq/types

Canonical Myme type schemas. Owns the JSON source, the codegen, and the generated TypeScript registry that `@mymehq/shared` consumes.

## Layout

- `core/*.json` — the core type schemas
- `scripts/validate.ts` — JSON shape validator (runs in CI)
- `scripts/generate.ts` — codegen: JSON → `generated/type-registry.ts`
- `generated/type-registry.ts` — auto-generated; do not edit
- `src/schema-types.ts` — schema-shape interfaces (`TypeSchema`, `FieldDefinition`, `ItemState`, `VersionPolicy`)
- `src/index.ts` — package entry: re-exports the schema interfaces and `ALL_TYPES`

## Schema format

Each type is a JSON file with:

- **`id`** — type identifier (e.g. `core.note`, `core.media.book`)
- **`parent`** — parent type ID, if a subtype
- **`description`** — what this type represents
- **`version`** — schema version, positive integer
- **`fields`** — field name → definition map
- **`required`** — array of required field names

Field definitions:

- **`type`** — `string`, `integer`, `number`, `boolean`, `array`, `object`, `enum`
- **`description`** — what the field is
- **`format`** — optional: `url`, `date`, `datetime`, `email`, `bcp47`, `iso3166`
- **`enum_values`** — required for `enum` type
- **`items_type`** — required for `array` type

Subtypes only declare fields they add. They inherit all parent fields and **may not redefine them** (enforced at registration).

## Dormant stubs — the `_deferred` marker

A type schema may carry `"_deferred": true` to mark it as retained-but-inactive. The generator skips `_deferred: true` schemas — they are **not** emitted into the generated registry, **not** included in `ALL_TYPES`, and therefore not available to the server or SDK at runtime. The JSON file stays in `core/` as a record of the shape so the type can be resurrected cleanly when it returns. No active core type is currently deferred.

## Commands

```sh
pnpm validate     # validate every schema in core/
pnpm generate     # regenerate generated/type-registry.ts
pnpm build        # bundle src/ to dist/ for downstream consumers
pnpm typecheck
```

CI runs `pnpm validate` and a codegen-freshness check (`pnpm generate` + `git diff --exit-code generated/`) on every push.

## Adding a new type

1. Create `core/<name>.json` following the schema format above
2. If it's a subtype, set `parent` and include only new fields (do not redefine ancestor fields)
3. `pnpm validate` to check the schema
4. `pnpm generate` to regenerate the registry
5. Commit with `feat(types): add core.<name> type`
