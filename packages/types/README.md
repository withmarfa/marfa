# @withmarfa/types

Canonical Marfa type schemas. Owns the JSON source, the codegen, and the generated TypeScript registries that `@withmarfa/shared` consumes.

## Layout

- `core/*.json` — the core type schemas
- `core/edges/*.json` — the core edge types
- `core/system/*.json` — the `system.*` types the server writes
- `scripts/validate.ts` — JSON shape validator (runs in CI)
- `scripts/generate.ts` — codegen: JSON → the two registries below
- `generated/type-registry.ts` — auto-generated; do not edit
- `generated/edge-type-registry.ts` — auto-generated; do not edit
- `src/schema-types.ts` — schema-shape interfaces (`TypeSchema`, `FieldDefinition`, `ItemState`, `VersionPolicy`)
- `src/index.ts` — package entry: re-exports the schema interfaces, `ALL_TYPES`, `ALL_SYSTEM_TYPES`, `ALL_EDGE_TYPES`, `ALL_TYPE_IDS` and `PlatformTypeId`

## Schema format

Each type is a JSON file with:

- **`id`** — type identifier (e.g. `core.note`, `core.media.book`)
- **`parent`** — parent type ID, if a subtype
- **`description`** — what this type represents
- **`version`** — schema version, positive integer
- **`fields`** — field name → definition map
- **`required`** — array of required field names

Field definitions:

- **`type`** — one of `FIELD_TYPES` (`src/schema-validation.ts`): `string`, `number`, `integer`, `boolean`, `url`, `email`, `datetime`, `date`, `enum`, `array`, `object`, `thumbnail`. A `thumbnail` is a small image the writer supplies as a `data:` URI of a PNG, JPEG or WebP, at most 16 KiB decoded; a type carries at most one, never named `title`, `body`, `description` or `name`.
- **`description`** — what the field is
- **`format`** — optional, one of `FIELD_FORMATS`: `url`, `email`, `datetime`, `date` and `thumbnail` normalize into `type`; `bcp47` and `iso3166` annotate a `string` and survive as `format`
- **`enum_values`** — required for `enum` type
- **`items_type`** — required for `array` type

Subtypes only declare fields they add. They inherit all parent fields and **may not redefine them** (enforced at registration).

## Commands

```sh
pnpm validate      # validate every schema in core/, core/system/ and core/edges/
pnpm generate      # regenerate both registries in generated/
pnpm shapes:digest # rewrite shipped-shapes.sha256 after a shipped shape changes
pnpm build         # bundle src/ to dist/ for downstream consumers
pnpm typecheck
```

CI runs `pnpm validate` and a codegen-freshness check on every push: it empties `generated/`, regenerates it, and refuses any difference, a file the generator did not write included.

## Adding a new type

1. Create `core/<name>.json` following the schema format above
2. If it's a subtype, set `parent` and include only new fields (do not redefine ancestor fields)
3. `pnpm validate` to check the schema
4. `pnpm generate` to regenerate the registry
5. `pnpm shapes:digest` to rewrite `shipped-shapes.sha256`, since a new or changed type moves the shapes it holds
6. Commit with `feat(types): add core.<name> type`
