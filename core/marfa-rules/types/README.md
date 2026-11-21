# Shipped types

The rules crate reads these JSON definitions and writes the shipped catalog. The contract describes [types](../../../conformance/spec/types.md), [tables](../../../conformance/spec/tables.md), and [edge types](../../../conformance/spec/edges.md).

## Layout

- `*.json`: the `core.*` types
- `system/*.json`: the `system.*` types, the platform's own records
- `edges/*.json`: the shipped edge types, one file named for the edge type's `id`
- `shipped-shapes.sha256`: the digest of every shipped shape, written by the rules crate
- `../icons/icon-set-lucide.json`, `../icons/icon-set-simple-icons.json`: the icon sets a type's `display_hints.icon` is checked against, written by `scripts/icon-sets.sh`
- `../src/builtin_catalog.json`: the catalog the core and the Rust server are built with, written by the rules crate

The writer checks for unexpected folders directly under `types/` and requires every `.json` file it reads to contain an object.

## Type definition

A type file is a JSON object. A key the rules do not read is refused, with the key it most likely meant.

- **`id`**: the type identifier, such as `core.note` or `core.media.book`
- **`parent`**: the parent type's `id` for a subtype. A subtype declares only the fields it adds and inherits the rest
- **`label`**: optional, the name people see for the type, at most 100 characters. A type that names none is shown by one made from the last segment of its `id`
- **`plural`**: optional, the name of a list of the type's items, at most 100 characters. A type that names none is answered with one made from its label (`Story` makes `Stories`), never from its parent's
- **`description`**: what the type represents, in one sentence of at most 200 characters
- **`guidance`**: a shipped type carries none yet. The catalog writer refuses a definition that names `guidance`, and a `<id>.md` beside a definition, and names the file. A registered type may carry optional Markdown guidance of at most 1,000 characters, and `marfa types check` reads `<id>.md` beside `<id>.json` as the guidance of a folder's type. Limits count characters (Unicode code points), as labels do
- **`version`**: a non-negative integer, `0` where a file names none. Every shipped type is at 0
- **`fields`**: field name to definition
- **`required`**: optional, an array of field names, which each must be a declared or inherited field. A field may instead say `"required": true`
- **`tables`**: optional, the tables an item of the type holds, as `conformance/spec/tables.md` describes
- **`roles`**: optional, `["container"]`, the one role there is
- **`display_hints`**: optional. `title_field` and `body_field` name a field the type declares or inherits, excluding thumbnails. `name_from_body` takes `true` or `false`. `icon` takes an ID from the pinned sets, such as `lucide:calendar-days`
- **`link_field`**: optional, the name of a `string` field that holds the vendor's own id
- **`merge_policy`**: optional, `default` and `fields` (field name to strategy), each strategy `last_writer_wins` or `keep_both_copies`
- **`version_policy`**: optional, `recent_days`, `daily_snapshot_days`, `weekly_snapshot_days` (whole days from 0 to 36500, each at least the longest window before it) and `max_versions` (a whole number from 1 to 1000000)
- **`retention_policy`**: optional, `feed_days`, a whole number of days from 1 to 36500, or `null`. A `system.*` type takes none
- **`compatible_with`**: optional, the types whose readers can read this type's items: the field-by-field rules are in `conformance/spec/types.md`

A type declares no `states`, `default_state` or `transitions`, and no field named for a first-class item field such as `state`, `source` or `occurred_at`.

## Field definition

- **`type`**: one of `string`, `number`, `integer`, `boolean`, `url`, `email`, `datetime`, `date`, `enum`, `status`, `array`, `object` and `thumbnail`
- **`description`**, **`label`**: optional. A description is at most 300 characters. A label is at most 100 characters, and a field that names none is shown by one made from its name (`due_at` reads as `Due At`)
- **`required`**: optional, `true` to require the field
- **`format`**: optional. The formats `url`, `email`, `date`, and `thumbnail` collapse into `type`. The formats `bcp47`, `iso3166`, `currency`, and `phone` annotate a `string` and stay as `format`. Of those annotations, only `currency` is checked on write. It takes three capital letters, such as `GBP`. Declare `datetime` with `type`
- **`enum_values`**: required for an `enum`, a non-empty array of strings, and refused on any other type but an array of enums
- **`status_values`**: required for a `status` field, except on a subtype that declares an inherited status field again: the words, each `{ "value": "in_review", "group": "in_progress" }` and optionally a text `description` of at most 120 characters, with the word a lowercase API name used once and the group one of `not_started`, `in_progress`, `completed` and `canceled`. A type carries at most one `status` field, and a subtype adds words after the inherited ones and never repeats one
- **`items_type`**: required for an `array`, and never `status` or `thumbnail`
- **`items_fields`**: optional on an `array` whose `items_type` is `object`: the members of each entry, by name, at least one. A member takes `type` (`string`, `email`, `url`, `enum`, `boolean`, `integer`, `number`, `date` or `datetime`), `description`, `label`, `required`, `enum_values`, `format`, `max_length`, `minimum` and `maximum`
- **`searchable`**: optional, `false` to keep the field out of full-text search
- **`max_length`**: optional, a whole number of at least 1, on a `string` or `enum` field and not on a `currency` one
- **`max_items`**: optional, a whole number of at least 1, on an `array`
- **`minimum`**, **`maximum`**: optional on a `number` or `integer` field or member, finite and inclusive, whole on an `integer`, the minimum no higher than the maximum. A subtype may raise a `minimum` or lower a `maximum`, never loosen or drop one

A `thumbnail` is a small image a writer supplies as a `data:` URI of a PNG, JPEG or WebP, at most 16 KiB decoded. A type carries at most one, counting inherited ones, and never names it `title`, `body`, `description` or `name`, which search always indexes. A thumbnail is never an array's element type, and an edge never carries one.

A subtype declares only the fields it adds. It may declare an inherited field again with a new `description` or `label`, or make it required, and may declare an inherited `status` field again with only the words it adds. It may not change an inherited field's shape.

## Edge type definition

Name each edge type file `<id>.json` and give it a lowercase kebab-case `id`, a `label`, a `reverse_label`, and a `cardinality` of `one-to-one`, `one-to-many`, `many-to-one`, or `many-to-many`. An `id` or `reverse_name` must be unique across shipped edge types.

The optional keys are:

- `description`
- `from_type_constraints` and `to_type_constraints`. Use a non-empty list of type IDs or `role:container`. Use `["*"]` or omit the key to allow every type.
- `cascade_on_delete`. Accepts `cascade`, `orphan`, `block`, or `with-hosts`. The default is `orphan`.
- `property_schema`. Maps property names to definitions that accept `type`, `description`, `required`, `enum_values`, `items_type`, and `format`.
- `reverse_name`
- `written_from`. Accepts `from`, `to`, or `none`. The default is `from`. Use `reverse_name` with `to`.

## Checking and writing

Run these from `core/`.

```sh
# Register every file the way a server would and hold each rule to its cases.
cargo nextest run -p marfa-rules builtin

# Rewrite the catalog and the digest after a definition or a rule changes.
MARFA_WRITE_CATALOG=1 cargo nextest run -p marfa-rules builtin::catalog_file

# Rewrite the icon sets from the pinned Iconify releases.
../scripts/icon-sets.sh
```

Without `MARFA_WRITE_CATALOG`, the same tests fail when `builtin_catalog.json` or `shipped-shapes.sha256` differs from what the definitions write. CI's `Types codegen freshness` and `Generated clients are fresh` jobs run the writers and refuse any difference. The digest includes each type's and edge type's identifier and shape. It omits labels, plurals, and descriptions.

## Adding a type

1. Create `<name>.json` here, or in `system/`, with the format above. A subtype sets `parent` and declares only what it adds.
2. Run `cargo nextest run -p marfa-rules builtin`. A file a person could not register is refused with its name and the field at fault.
3. Rewrite the catalog and the digest as above, since a new or changed type moves both.
4. From the repository root, run `pnpm --filter @withmarfa/conformance exec tsx scripts/catalogue-tables.ts` to rewrite the contract's table of shipped types, then `pnpm test:offline-lane`.
5. Commit with `feat(types): add core.<name>`.
