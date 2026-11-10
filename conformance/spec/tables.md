# Tables

What a type declares about the tables an item of it can hold: their names, their columns and how a column totals. A table holds rows, and a row is never an item. A column's value rules and totals apply to rows once they exist; this chapter holds only the declaration.

## Declaring tables

A type declares tables under `tables`, an object keyed by table name. A table has an optional `label` and `description`, and `columns`, an object keyed by column name. A column has a `type` and optionally a `label`, `description`, `required`, `enum_values`, `format`, `maxLength`, `minimum`, `maximum`, `type_constraints`, `adds_up` and `searchable`. A column's `type` is `string`, `email`, `url`, `enum`, `boolean`, `integer`, `number`, `date`, `datetime` or `item`, a column of type `item` holding the ID of an item.

### `tables/declare`

When a caller registers a type that declares a table with columns, the server MUST answer the table and its columns on `GET /types/{id}`.

**Tests:** `compliance/type-tables.test.ts › answers the tables a type declares on a read and a listing`.

### `tables/list`

When a type declares tables, the server MUST answer them on `GET /types` as the type declares them, without those it inherits.

**Reason:** the listing answers each type's own definition, as it does for fields.

**Tests:** `compliance/type-tables.test.ts › answers the tables a type declares on a read and a listing`, `› answers a subtype the tables of its parents and its own`.

### `tables/none`

Where a type declares no table and inherits none, the server MUST answer it without a `tables` member.

**Tests:** `compliance/type-tables.test.ts › answers no tables for a type that declares none`.

### `tables/labels-read`

Where a table or a column declares no `label`, the server MUST answer a label made from its name on `GET /types/{id}`, `due_at` as `Due At`.

**Tests:** `compliance/type-tables.test.ts › answers a label made from its name for a table and a column that declare none on a read`.

### `tables/labels-listed`

Where a table or a column declares no `label`, the server MUST answer it on `GET /types` without a `label`.

**Reason:** the listing answers each type's own definition, as it does for fields.

**Tests:** `compliance/type-tables.test.ts › answers only the declared label for a table and a column in the listing`.

### `tables/defaults`

When a caller sends `POST /types/normalize` a type that declares a column without `required` or `searchable`, the server MUST answer the column with `required` `false` and `searchable` `false`.

**Reason:** a column is searchable only where it says so, unlike a field, so that a table of numbers stays out of full-text search.

**Tests:** `compliance/type-tables.test.ts › writes a column's defaults down when a type is normalized`.

### `tables/bounds`

The server MUST take a type that declares 32 tables, and a table that declares 64 columns.

**Tests:** `compliance/type-tables.test.ts › takes 32 tables and a table of 64 columns, and refuses a 33rd table and a 65th column`.

### `tables/adds-up-kinds`

The server MUST take `sum`, `average`, `min`, `max` and `count` as the `adds_up` of a `number` or `integer` column, `min`, `max` and `count` as that of a `date` or `datetime` column, and `count` as that of a column of any other type.

**Reason:** `count` is the rows that hold a value for the column, so any kind can be counted. A sum or an average of text, or an earliest boolean, would mean nothing.

**Tests:** `compliance/type-tables.test.ts › takes the adds_up each kind of column can`.

### `tables/item-column`

The server MUST take a column of type `item` that names in `type_constraints` the type that declares it, or any registered type, or names none.

**Tests:** `compliance/type-tables.test.ts › refuses an item column that names a type nothing registers, one that is not a type identifier and an empty list, and takes its own type`.

### `tables/searchable-kinds`

The server MUST take `searchable` `true` on a `string`, `email` or `url` column.

**Tests:** `compliance/type-tables.test.ts › refuses searchable on a column that holds no text, and takes it on one that does`.

## Refusing a declaration

Each refusal below answers `400 invalid_schema` with `details.errors` naming the path of each fault, and registers or changes nothing.

### `tables/unknown-key`

If a table or a column names a key it does not define, then the server MUST answer `400 invalid_schema` naming the path of each such key, and in `hint` the key it most likely meant.

**Reason:** a key the server ignored would let a misspelled rule, such as `addsUp`, register as though it held.

**Tests:** `compliance/type-tables.test.ts › refuses an unread key in a table and in a column, naming the key meant`.

### `tables/name-grammar`

If a table or a column is named other than by a lowercase letter and then at most 63 lowercase letters, digits and underscores, then the server MUST answer `400 invalid_schema` naming it.

**Reason:** a name appears in addresses and in commands.

**Tests:** `compliance/type-tables.test.ts › refuses a table or a column whose name is not a lowercase letter then lowercase letters, digits and underscores`.

### `tables/column-kind`

If a column has a `type` that is not one of the column types, including a list, an object, a status and a thumbnail, or has none, then the server MUST answer `400 invalid_schema` naming the column's `type`.

**Reason:** a column holds one plain value, or the ID of an item.

**Tests:** `compliance/type-tables.test.ts › refuses a column of a kind that does not exist or that nests`.

### `tables/columns-required`

If a table declares no `columns`, or declares `columns` that is empty or is not an object, then the server MUST answer `400 invalid_schema` naming the table's `columns`.

**Tests:** `compliance/type-tables.test.ts › refuses a table with no columns`.

### `tables/column-rules`

If a column breaks a rule that a field of its type keeps, in its `enum_values`, `minimum`, `maximum` or `maxLength`, or has a `required` that is not `true` or `false`, then the server MUST answer `400 invalid_schema` naming the member.

**Tests:** `compliance/type-tables.test.ts › refuses a column that breaks a rule a field of its kind keeps`.

### `tables/adds-up-refused`

If a column names an `adds_up` that is not `sum`, `average`, `min`, `max` or `count`, or that the type of the column cannot take under `tables/adds-up-kinds`, then the server MUST answer `400 invalid_schema` naming the column's `adds_up`.

**Tests:** `compliance/type-tables.test.ts › refuses an adds_up that is not sum, average, min, max or count, or that the kind of its column cannot take`.

### `tables/searchable-refused`

If a column names a `searchable` that is not `true` or `false`, or `true` on a column of a type other than `string`, `email` or `url`, then the server MUST answer `400 invalid_schema` naming the column's `searchable`.

**Reason:** search indexes text.

**Tests:** `compliance/type-tables.test.ts › refuses searchable on a column that holds no text, and takes it on one that does`.

### `tables/item-unregistered`

If a column's `type_constraints` is empty, is not a list, or holds an entry that is not an identifier of a registered type or of the type that declares the column, then the server MUST answer `400 invalid_schema` naming the column's `type_constraints`.

**Tests:** `compliance/type-tables.test.ts › refuses an item column that names a type nothing registers, one that is not a type identifier and an empty list, and takes its own type`.

### `tables/item-values-refused`

If a column names `type_constraints` and is not of type `item`, or is of type `item` and names `enum_values`, `format`, `maxLength`, `minimum` or `maximum`, then the server MUST answer `400 invalid_schema` naming the member.

**Tests:** `compliance/type-tables.test.ts › refuses type_constraints on a column that is not an item, and a value rule on an item column`.

### `tables/too-many`

If a type declares more than 32 tables, or a table declares more than 64 columns, then the server MUST answer `400 invalid_schema` naming the type's `tables` or the table's `columns`.

**Reason:** a table is what an item holds many of, and a narrow one keeps a row small.

**Tests:** `compliance/type-tables.test.ts › takes 32 tables and a table of 64 columns, and refuses a 33rd table and a 65th column`.

## Inheritance

### `tables/inherit`

When a type has a parent, the server MUST answer on `GET /types/{id}` the tables of every type above it together with its own.

**Tests:** `compliance/type-tables.test.ts › answers a subtype the tables of its parents and its own`.

### `tables/inherit-changed`

If a type declares a table of the name of one a type above it declares, with any definition other than that type's as `GET /types/{id}` answers it, then the server MUST answer `400 inheritance_violation` naming the table.

**Reason:** a table is declared once down a chain, so a subtype never holds rows under a shape its parent does not know.

**Tests:** `compliance/type-tables.test.ts › refuses a subtype that declares a table of its parents differently`.

### `tables/inherit-restated`

When a type declares a table exactly as `GET /types/{id}` answers it for a type above it, the server MUST answer the type on `GET /types` without that table.

**Reason:** a type written back as it was read stays what it was.

**Tests:** `compliance/type-tables.test.ts › stores no table again that a subtype restates exactly as a read of its parent gives it`.

### `tables/inherit-gained`

If a replacement of a type would give it a table of the name of one a type below it declares, then the server MUST answer `400 inheritance_violation` naming the table.

**Reason:** a table is declared once down a chain, so a type below that declares it alike holds a second declaration a later change to the table would contradict.

**Tests:** `compliance/type-tables.test.ts › refuses a parent that gains a table a subtype declares`.

### `tables/inherit-reparented`

If a replacement of a type would give it a parent above which a type below it declares a table of the name of one a type above that parent declares, then the server MUST answer `400 inheritance_violation` naming the type's `parent`.

**Reason:** attaching a type under an ancestor is judged against every type below it, as adding a table to it is (`tables/inherit-gained`).

**Tests:** `compliance/type-tables.test.ts › refuses a replacement that gives a type a parent above which a subtype declares a table of the parent's`.

### `tables/inherit-reparented-unchanged`

When the server refuses a replacement under `tables/inherit-reparented`, the server MUST NOT change the type.

**Tests:** `compliance/type-tables.test.ts › changes nothing when it refuses a replacement for the parent it would give a type`.

## Evolving a type's tables without schema.write

### `tables/evolve-free`

When a key holding `metadata.types:write`, without `schema.write`, sends `PUT /types/{id}` for a type registered at run time its map grants write on, the server MUST take a replacement that only adds a table, adds an optional column to a table, or changes a table's or a column's `label` or `description`.

**Reason:** each release of a connector adds tables and columns, and these change no stored row.

**Tests:** `compliance/type-tables.test.ts › lands a table, an optional column and new labels for a key holding metadata.types:write alone`.

### `tables/evolve-schema-change`

If a key holding `metadata.types:write` and not `schema.write` sends `PUT /types/{id}` for a type registered at run time its map grants write on, removing a table or a column, changing a column's `type` or another member `tables/evolve-free` does not name, or adding a required column to a table the type already declares, then the server MUST answer `403 forbidden`.

**Reason:** a changed or removed column leaves rows that no longer fit, and a required column leaves rows without a value.

**Tests:** `compliance/type-tables.test.ts › refuses a column's changed kind, a required column, a removed column and a removed table to a key without schema.write, listing each`.

### `tables/evolve-refusal-scope`

When the server refuses a replacement under `tables/evolve-schema-change`, the server MUST answer `details.required_scope` `schema.write`.

**Tests:** `compliance/type-tables.test.ts › refuses a column's changed kind, a required column, a removed column and a removed table to a key without schema.write, listing each`.

### `tables/evolve-refusal-changes`

When the server refuses a replacement under `tables/evolve-schema-change`, the server MUST answer `details.changes` listing, in sorted order, each change that needs `schema.write`, a table as `tables.<name>` and a column as `tables.<name>.columns.<column>`.

**Tests:** `compliance/type-tables.test.ts › refuses a column's changed kind, a required column, a removed column and a removed table to a key without schema.write, listing each`.

### `tables/evolve-schema-write`

When a key holding `schema.write` sends `PUT /types/{id}` for a type its map grants write on, the server MUST NOT refuse it under `tables/evolve-schema-change`.

**Tests:** `compliance/type-tables.test.ts › lands every change for a key holding schema.write, and a replacement without tables removes them`.

### `tables/replace-omitted`

When a key holding `schema.write` sends `PUT /types/{id}` without `tables`, the server MUST answer the type without the tables it declared.

**Reason:** a replacement is the whole definition, as for fields.

**Tests:** `compliance/type-tables.test.ts › lands every change for a key holding schema.write, and a replacement without tables removes them`.

## Archives and tools

### `tables/archive`

The server MUST carry the `tables` a type declares in the `type` line of the archive that `GET /export` writes for it, without the tables it inherits.

**Tests:** `compliance/type-tables.test.ts › carries a type's tables in an archive and registers them when the archive is restored`.

### `tables/restore`

When `POST /restore` reads a `type` line that declares tables, the server MUST register the type with them.

**Tests:** `compliance/type-tables.test.ts › carries a type's tables in an archive and registers them when the archive is restored`, `› restores a subtype whose type line restates a table of its parent (reversed: %s)`.

### `tables/save-type-register`

When a caller sends `marfa_save_type` with `action` `register` and `tables`, the server MUST register the type with them.

**Tests:** `compliance/type-tables.test.ts › registers a type with tables through marfa_save_type, and refuses a table the server refuses`.

### `tables/save-type-change`

When a caller sends `marfa_save_type` with `action` `change` and `tables`, the server MUST replace each table the call names, remove each it names as `null` and leave the rest.

**Tests:** `compliance/type-tables.test.ts › changes a type's tables through marfa_save_type, replacing a table by name, removing one with null and leaving the rest`.
