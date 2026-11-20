# Shipped types

The type and edge type definitions Marfa ships. Each is a JSON file, and the rules crate (`core/marfa-rules`) is the only code that reads them: it registers every file with the rules a server applies to a type a person registers, and writes what the core is built from. The contract for a type is `conformance/spec/types.md`, for its tables `conformance/spec/tables.md` and for an edge type `conformance/spec/edges.md`.

## Layout

- `*.json`: the `core.*` types
- `system/*.json`: the `system.*` types, the platform's own records
- `edges/*.json`: the shipped edge types, one file named for the edge type's `id`
- `shipped-shapes.sha256`: the digest of every shipped shape, written by the rules crate
- `../icons/icon-set-lucide.json`, `../icons/icon-set-simple-icons.json`: the icon sets a type's `display_hints.icon` is checked against, written by `scripts/icon-sets.sh`
- `../src/builtin_catalog.json`: the catalog the core and the Rust server are built with, written by the rules crate

The writer reads only these folders: a folder it does not name, or a file that is not a JSON object, stops it.

## Type definition

A type file is a JSON object. A key the rules do not read is refused, with the key it most likely meant.

- **`id`**: the type identifier, such as `core.note` or `core.media.book`
- **`parent`**: the parent type's `id` for a subtype. A subtype declares only the fields it adds and inherits the rest
- **`label`**: optional, the name people see for the type, at most 100 characters. A type that names none is shown by one made from the last segment of its `id`
- **`plural`**: optional, the name of a list of the type's items, at most 100 characters. A type that names none is answered with one made from its label (`Story` makes `Stories`), never from its parent's
- **`description`**: what the type represents
- **`version`**: a non-negative integer, `0` where a file names none. Every shipped type is at 0
- **`fields`**: field name to definition
- **`required`**: optional, an array of field names, which each must be a declared or inherited field. A field may instead say `"required": true`
- **`tables`**: optional, the tables an item of the type holds, as `conformance/spec/tables.md` describes
- **`roles`**: optional, `["container"]`, the one role there is
- **`display_hints`**: optional, `title_field` and `body_field` (each a text field the type declares or inherits, never a thumbnail), `name_from_body` (`true` or `false`) and `icon`, an Iconify ID such as `lucide:calendar-days` from the icon sets above. A bare name is refused, and the refusal says which ID to send
- **`link_field`**: optional, the name of a `string` field that holds the vendor's own id
- **`merge_policy`**: optional, `default` and `fields` (field name to strategy), each strategy `last_writer_wins` or `keep_both_copies`
- **`version_policy`**: optional, `recent_days`, `daily_snapshot_days`, `weekly_snapshot_days` (whole days from 0 to 36500, each at least the longest window before it) and `max_versions` (a whole number from 1 to 1000000)
- **`retention_policy`**: optional, `feed_days`, a whole number of days from 1 to 36500, or `null`. A `system.*` type takes none
- **`compatible_with`**: optional, the types whose readers can read this type's items: the field-by-field rules are in `conformance/spec/types.md`

A type declares no `states`, `default_state` or `transitions`, and no field named for a first-class item field such as `state`, `source` or `occurred_at`.

## Field definition

- **`type`**: one of `string`, `number`, `integer`, `boolean`, `url`, `email`, `datetime`, `date`, `enum`, `status`, `array`, `object` and `thumbnail`
- **`description`**, **`label`**: optional. A label is at most 100 characters, and a field that names none is shown by one made from its name (`due_at` reads as `Due At`)
- **`required`**: optional, `true` to require the field
- **`format`**: optional. The formats `url`, `email`, `date` and `thumbnail` collapse into `type`; `bcp47`, `iso3166`, `currency` and `phone` annotate a `string` and stay as `format`. A write is checked only against `currency`, which takes three capital letters such as `GBP`. `datetime` is a type and never a format
- **`enum_values`**: required for an `enum`, a non-empty array of strings, and refused on any other type but an array of enums
- **`status_values`**: required for a `status` field, except on a subtype that declares an inherited status field again: the words, each `{ "value": "in_review", "group": "in_progress" }`, with the word a lowercase API name used once and the group one of `not_started`, `in_progress`, `completed` and `canceled`. A type carries at most one `status` field, and a subtype adds words after the inherited ones and never repeats one
- **`items_type`**: required for an `array`, and never `status` or `thumbnail`
- **`items_fields`**: optional on an `array` whose `items_type` is `object`: the members of each entry, by name, at least one. A member takes `type` (`string`, `email`, `url`, `enum`, `boolean`, `integer`, `number`, `date` or `datetime`), `description`, `label`, `required`, `enum_values`, `format`, `max_length`, `minimum` and `maximum`
- **`searchable`**: optional, `false` to keep the field out of full-text search
- **`max_length`**: optional, a whole number of at least 1, on a `string` or `enum` field and not on a `currency` one
- **`max_items`**: optional, a whole number of at least 1, on an `array`
- **`minimum`**, **`maximum`**: optional on a `number` or `integer` field or member, finite and inclusive, whole on an `integer`, the minimum no higher than the maximum. A subtype may raise a `minimum` or lower a `maximum`, never loosen or drop one

A `thumbnail` is a small image a writer supplies as a `data:` URI of a PNG, JPEG or WebP, at most 16 KiB decoded. A type carries at most one, counting inherited ones, and never names it `title`, `body`, `description` or `name`, which search always indexes. A thumbnail is never an array's element type, and an edge never carries one.

A subtype declares only the fields it adds. It may declare an inherited field again with a new `description` or `label`, or make it required, and may declare an inherited `status` field again with only the words it adds. It may not change an inherited field's shape.

## Edge type definition

An edge type file names its `id` (the file is `<id>.json`), `cardinality` (`one-to-one`, `one-to-many`, `many-to-one` or `many-to-many`), `label` and `reverse_label`, and may name `description`, `from_type_constraints` and `to_type_constraints` (each `["*"]` where it names none: type identifiers or `role:container`), `cascade_on_delete` (`cascade`, `orphan`, `block` or `with-hosts`, `orphan` where it names none), `property_schema` (property name to a field definition that takes `type`, `description`, `required`, `enum_values`, `items_type` and `format`), `reverse_name` and `written_from` (`from`, `to` or `none`, `from` where it names none). A shipped edge type is a lowercase kebab word with no empty constraint list, and no `id` or `reverse_name` is held by two shipped edge types.

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

Without `MARFA_WRITE_CATALOG`, the same tests fail when `builtin_catalog.json` or `shipped-shapes.sha256` differs from what the definitions write. CI's `Types codegen freshness` and `Generated clients are fresh` jobs run the writers and refuse any difference. The digest holds each type's and edge type's shape and leaves out prose (`label`, `plural`, `reverse_label`, `description` and `id`), so a change to a shape moves it and a change of wording does not.

## Adding a type

1. Create `<name>.json` here, or in `system/`, with the format above. A subtype sets `parent` and declares only what it adds.
2. Run `cargo nextest run -p marfa-rules builtin`. A file a person could not register is refused with its name and the field at fault.
3. Rewrite the catalog and the digest as above, since a new or changed type moves both.
4. From the repository root, run `pnpm --filter @withmarfa/conformance exec tsx scripts/catalogue-tables.ts` to rewrite the contract's table of shipped types, then `pnpm test:offline-lane`.
5. Commit with `feat(types): add core.<name>`.
