# Tables

What a type declares about the tables an item of it can hold: their names, their columns and how a column totals. A table holds rows, and a row is never an item. This chapter also holds how rows are written, read, announced, undone, searched and linked to.

## Declaring tables

A type declares tables under `tables`, an object keyed by table name. A table has an optional `label`, `description` and `order`, and `columns`, an object keyed by column name. A column has a `type` and optionally a `label`, `description`, `required`, `enum_values`, `format`, `maxLength`, `minimum`, `maximum`, `type_constraints`, `adds_up` and `searchable`. A column's `type` is `string`, `email`, `url`, `enum`, `boolean`, `integer`, `number`, `date`, `datetime` or `item`, a column of type `item` holding the ID of an item.

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

### `tables/searchable-bound`

The server MUST take a table that marks 8 columns `searchable` `true`.

**Tests:** `compliance/table-rows-search.test.ts › takes a table that marks 8 columns searchable and refuses one that marks 9`.

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

### `tables/order`

The server MUST take a table that names in `order` one of its own columns of type `datetime`, `number`, `integer` or `string`, required or not.

**Reason:** the server keeps a table's rows in the order of its `order` column, so a page sorted by that column reads only the rows it answers. The column need not be required: a row written before the column was added has no value, and sorts last under `tables/rows-sort`.

**Tests:** `compliance/type-tables.test.ts › takes an order naming a datetime, number, integer or string column, required or not`.

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

### `tables/searchable-max`

If a table marks more than 8 columns `searchable` `true`, then the server MUST answer `400 invalid_schema` naming the table's `columns`.

**Reason:** each searchable column of a table is a column of the search index, which holds the text of every row.

**Tests:** `compliance/table-rows-search.test.ts › takes a table that marks 8 columns searchable and refuses one that marks 9`.

### `tables/order-refused`

If a table names an `order` that is not the name of one of its columns of type `datetime`, `number`, `integer` or `string`, then the server MUST answer `400 invalid_schema` naming the table's `order`.

**Tests:** `compliance/type-tables.test.ts › refuses an order that names no column of the table, or a column of another type`.

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

When a key holding `metadata.types:write`, without `schema.write`, sends `PUT /types/{id}` for a type registered at run time its map grants write on, the server MUST take a replacement that only adds a table, adds an optional column to a table, names an `order` for a table that names none, or changes a table's or a column's `label` or `description`.

**Reason:** each release of a connector adds tables and columns, and these change no stored row. A new `order` changes only how fast a sorted page is read.

**Tests:** `compliance/type-tables.test.ts › lands a table, an optional column, an order and new labels for a key holding metadata.types:write alone`.

### `tables/evolve-schema-change`

If a key holding `metadata.types:write` and not `schema.write` sends `PUT /types/{id}` for a type registered at run time its map grants write on, removing a table or a column, changing a column's `type` or another member `tables/evolve-free` does not name, adding a required column to a table the type already declares, or changing or removing a table's `order`, then the server MUST answer `403 forbidden`.

**Reason:** a changed or removed column leaves rows that no longer fit, a required column leaves rows without a value, and a changed `order` changes which sorted page is fast for every app that reads the table.

**Tests:** `compliance/type-tables.test.ts › refuses a column's changed kind, a required column, a removed column, a removed table and a changed or removed order to a key without schema.write, listing each`.

### `tables/evolve-refusal-scope`

When the server refuses a replacement under `tables/evolve-schema-change`, the server MUST answer `details.required_scope` `schema.write`.

**Tests:** `compliance/type-tables.test.ts › refuses a column's changed kind, a required column, a removed column, a removed table and a changed or removed order to a key without schema.write, listing each`.

### `tables/evolve-refusal-changes`

When the server refuses a replacement under `tables/evolve-schema-change`, the server MUST answer `details.changes` listing, in sorted order, each change that needs `schema.write`, a table as `tables.<name>`, a column as `tables.<name>.columns.<column>` and an order as `tables.<name>.order`.

**Tests:** `compliance/type-tables.test.ts › refuses a column's changed kind, a required column, a removed column, a removed table and a changed or removed order to a key without schema.write, listing each`.

### `tables/evolve-schema-write`

When a key holding `schema.write` sends `PUT /types/{id}` for a type its map grants write on, the server MUST NOT refuse it under `tables/evolve-schema-change`.

**Tests:** `compliance/type-tables.test.ts › lands every change for a key holding schema.write, and a replacement without tables removes them`.

### `tables/replace-omitted`

When a key holding `schema.write` sends `PUT /types/{id}` without `tables`, the server MUST answer the type without the tables it declared.

**Reason:** a replacement is the whole definition, as for fields.

**Tests:** `compliance/type-tables.test.ts › lands every change for a key holding schema.write, and a replacement without tables removes them`.

## A table a person keeps

An item of `core.table`, or of a type below it, declares its own columns as item data, in its `columns` property, an object keyed by column name that a type's declared table holds in the same shape. The type declares no table. The item's columns are judged by the rules a declared table's columns are, so one validator serves both.

### `tables/own-type`

The server MUST ship `core.table`, with `title` and `columns` required, `description` optional, `columns` an object, and no `tables` of its own.

**Reason:** the person defines the columns, so they are item data, never part of the type.

**Tests:** `compliance/table-own-columns.test.ts › ships core.table with its columns as a required object and declares no table`.

### `tables/own-columns-taken`

When a caller creates or updates an item of `core.table`, or of a type below it, with `columns` that a table a type declares would take under `tables/declare`, `tables/adds-up-kinds`, `tables/item-column` and `tables/searchable-kinds`, the server MUST take the item and answer its `columns` as written.

**Tests:** `compliance/table-own-columns.test.ts › takes the columns a declared table takes, on a create, an update and a subtype`.

### `tables/own-columns-bounds`

The server MUST take an item of `core.table` whose `columns` names 64 columns.

**Tests:** `compliance/table-own-columns.test.ts › takes 64 columns and refuses a 65th`.

### `tables/own-columns-refused`

If a caller creates or updates an item of `core.table`, or of a type below it, with `columns` that break `tables/unknown-key`, `tables/name-grammar`, `tables/column-kind`, `tables/column-rules`, `tables/adds-up-refused`, `tables/searchable-refused`, `tables/item-unregistered`, `tables/item-values-refused` or `tables/too-many`, then the server MUST answer `400 invalid_properties` naming in `details.errors` the path of each fault under `columns`.

**Tests:** `compliance/table-own-columns.test.ts › refuses the columns a declared table would refuse, naming each fault under columns`, `› takes 64 columns and refuses a 65th`.

### `tables/own-columns-required`

If a caller creates or updates an item of `core.table`, or of a type below it, so that its `columns` is missing, is not an object or names no column, then the server MUST answer `400 invalid_properties` naming `columns`.

**Reason:** a table with no column holds no row (`tables/columns-required`).

**Tests:** `compliance/table-own-columns.test.ts › refuses columns that are missing, cleared, empty, null or not an object`.

### `tables/own-order-refused`

If a caller creates or updates an item of `core.table`, or of a type below it that declares no `order` field, with an `order` property, then the server MUST answer `400 invalid_properties` naming `order` in `details.errors`.

**Reason:** only a table a type declares names an `order` (`tables/order`), so the server refuses an order sent for an item's own columns rather than ignore it.

**Tests:** `compliance/table-own-columns.test.ts › refuses an order sent beside an item's own columns and takes the same write without it`.

### `tables/own-columns-unchanged`

When the server refuses a write under `tables/own-columns-refused`, `tables/own-columns-required` or `tables/own-order-refused`, the server MUST NOT create or change the item.

**Tests:** `compliance/table-own-columns.test.ts › refuses the columns a declared table would refuse, naming each fault under columns`, `› refuses columns that are missing, cleared, empty, null or not an object`, `› refuses an order sent beside an item's own columns and takes the same write without it`.

### `tables/own-evolve-free`

When a key without `schema.write` that may write an item of `core.table` updates its `columns` so that they only add an optional column, change a column's `label` or `description`, or reorder the columns, the server MUST take the update.

**Reason:** these change no stored row, as for a declared table (`tables/evolve-free`).

**Tests:** `compliance/table-own-columns.test.ts › lands an added optional column, new labels and a new order for a key without schema.write`.

### `tables/own-evolve-schema-change`

If a key without `schema.write` that may write an item of `core.table` updates its `columns` so that they remove a column, change a column's `type` or another member `tables/own-evolve-free` does not name, or add a required column, then the server MUST answer `403 forbidden`.

**Reason:** a changed or removed column leaves rows that no longer fit, and a required column leaves rows without a value (`tables/evolve-schema-change`).

**Tests:** `compliance/table-own-columns.test.ts › refuses a removed column, a changed kind and a required column to a key without schema.write, listing each and changing nothing`.

### `tables/own-evolve-refusal-scope`

When the server refuses an update under `tables/own-evolve-schema-change` or `tables/retype-schema-change`, the server MUST answer `details.required_scope` `schema.write`.

**Tests:** `compliance/table-own-columns.test.ts › refuses a removed column, a changed kind and a required column to a key without schema.write, listing each and changing nothing`, `› refuses a retype that reshapes a table the item has before and after to a key without schema.write, listing each and changing nothing`.

### `tables/own-evolve-refusal-changes`

When the server refuses an update under `tables/own-evolve-schema-change`, the server MUST answer `details.changes` listing, in sorted order, each column that needs `schema.write`, as `columns.<column>`.

**Tests:** `compliance/table-own-columns.test.ts › refuses a removed column, a changed kind and a required column to a key without schema.write, listing each and changing nothing`.

### `tables/own-evolve-schema-write`

When a key holding `schema.write` updates the `columns` of an item of `core.table` that it may write, the server MUST NOT refuse the update under `tables/own-evolve-schema-change`.

**Tests:** `compliance/table-own-columns.test.ts › lands a removed column, a changed kind and a required column for a key holding schema.write`.

### `tables/retype-schema-change`

If a key without `schema.write` retypes an item, and a table the item has both before and after the retype, whether its type declares it or the item keeps it under `tables/own-table-listed`, would remove a column, change a column's `type` or another member `tables/own-evolve-free` does not name, or add a required column, then the server MUST answer `403 forbidden`.

**Reason:** a retype changes the columns a table's rows are judged by, as a change to the columns does (`tables/own-evolve-schema-change`), so moving an item through another type never reshapes its table without `schema.write`.

**Tests:** `compliance/table-own-columns.test.ts › refuses a retype that reshapes a table the item has before and after to a key without schema.write, listing each and changing nothing`.

### `tables/retype-refusal-changes`

When the server refuses a retype under `tables/retype-schema-change`, the server MUST answer `details.changes` listing, in sorted order, each column that needs `schema.write`, as `columns.<column>` where the item keeps the table after the retype, and as `tables.<table>.columns.<column>` where its type declares it.

**Tests:** `compliance/table-own-columns.test.ts › refuses a retype that reshapes a table the item has before and after to a key without schema.write, listing each and changing nothing`.

### `tables/retype-schema-write`

When a key holding `schema.write` retypes an item that it may write, the server MUST NOT refuse the retype under `tables/retype-schema-change`.

**Tests:** `compliance/table-own-columns.test.ts › lands a retype that reshapes a table the item has before and after for a key holding schema.write`.

## Archives and tools

### `tables/archive`

The server MUST carry the `tables` a type declares in the `type` line of the archive that `GET /export` writes for it, without the tables it inherits.

**Tests:** `compliance/type-tables.test.ts › carries a type's tables in an archive and registers them when the archive is restored`.

### `tables/restore`

When `POST /restore` reads a `type` line that declares tables, the server MUST register the type with them.

**Tests:** `compliance/type-tables.test.ts › carries a type's tables in an archive and registers them when the archive is restored`, `› restores a subtype whose type line restates a table of its parent (reversed: %s)`.

### `tables/restore-unregistered`

When `POST /restore` reads a `type` line that declares a table with a column whose `type_constraints` names a type that is not registered once the archive's own types are, the server MUST register the type with the table as the archive holds it.

**Reason:** a forced delete keeps the columns that name the deleted type (`tables/delete-constrained`), so an export carries them, and a backup that its own instance cannot restore is no backup. An empty list, a value that is not a list and an entry that is not a type identifier stay refused (`tables/item-unregistered`).

**Tests:** `compliance/type-tables.test.ts › restores a type whose table names a type deleted with force, and refuses an empty type_constraints on restore`.

### `tables/own-restore-columns`

If `POST /restore` names an item of `core.table`, or of a type below it, whose `columns` break a rule `tables/own-columns-refused` names other than `tables/item-unregistered` naming a type that is not registered, then the server MUST answer `400 invalid_properties` naming the path of the fault under `properties.columns` in `details.field`.

**Reason:** the item's rows are judged by its columns, so an archive cannot bring in columns a write would refuse.

**Tests:** `compliance/table-own-restore.test.ts › refuses an item of a type below core.table whose columns a table cannot take, naming the column`, `› refuses a restored item of core.table whose column has an empty type_constraints, naming it`.

### `tables/own-restore-unregistered`

When `POST /restore` names an item of `core.table`, or of a type below it, with a column whose `type_constraints` names a type that is not registered once the archive's own types are, the server MUST store the item's `columns` as the archive holds them.

**Reason:** a forced delete keeps the columns that name the deleted type (`tables/own-delete-constrained`), so an export carries them, and a backup that its own instance cannot restore is no backup.

**Tests:** `compliance/table-own-restore.test.ts › exports and restores an item of core.table whose column names a type deleted with force`.

### `tables/save-type-register`

When a caller sends `marfa_save_type` with `action` `register` and `tables`, the server MUST register the type with them.

**Tests:** `compliance/type-tables.test.ts › registers a type with tables through marfa_save_type, and refuses a table the server refuses`.

### `tables/save-type-change`

When a caller sends `marfa_save_type` with `action` `change` and `tables`, the server MUST replace each table the call names, remove each it names as `null` and leave the rest.

**Tests:** `compliance/type-tables.test.ts › changes a type's tables through marfa_save_type, replacing a table by name, removing one with null and leaving the rest`.

## Rows

An item of a type that declares a table holds rows in it. A row is `{ "id", "values", "updated_at" }`: `id` is a UUIDv7, `values` an object keyed by column name holding the row's values, and `updated_at` when the row last changed. A row has no version, tags, edges or history of its own, and is never an item. The doors are under the item: `GET /items/{id}/tables`, `GET` and `POST /items/{id}/tables/{table}/rows`, `GET /items/{id}/tables/{table}/rows/{row}` and `GET /items/{id}/tables/{table}/totals`.

## Writing rows

`POST /items/{id}/tables/{table}/rows` takes a batch, `{ "operations": [...] }`, for one table of one item. An operation is `{ "op": "put", "id"?, "values" }`, which creates or replaces a whole row, `{ "op": "patch", "id", "values" }`, which sets the columns it names, or `{ "op": "delete", "id" }`. Each refusal below names in `details.operation` the index of the operation it refuses.

### `tables/rows-write`

When a caller sends `POST /items/{id}/tables/{table}/rows` with operations that all hold, the server MUST answer `200` with `results` holding, for each operation in order, the row's `id` and its `outcome`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-put-create`

When a `put` names no `id`, or an `id` no row of the table holds, the server MUST create the row with the values it sends.

**Tests:** `compliance/table-rows.test.ts › keeps the id a client sends for a new row`.

### `tables/rows-put-created`

When a `put` creates a row, the server MUST answer its outcome `created`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-id-minted`

When a `put` names no `id`, the server MUST give the row a new UUIDv7 as its `id`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-id-refused`

If an operation names an `id` that is not a UUIDv7 in lowercase, then the server MUST answer `400 validation_error` naming `operations.<index>.id`.

**Tests:** `compliance/table-rows.test.ts › refuses a row id that is not a UUID and an operation it does not know`.

### `tables/rows-op-refused`

If an operation's `op` is not `put`, `patch` or `delete`, or a `patch` or `delete` names no `id`, then the server MUST answer `400 validation_error` naming the member.

**Tests:** `compliance/table-rows.test.ts › refuses a row id that is not a UUID and an operation it does not know`.

### `tables/rows-op-member-refused`

If an operation names a member other than `op`, `id` and `values`, or a `delete` names `values`, then the server MUST answer `400 validation_error` naming `operations.<index>.<member>`.

**Reason:** a member the server would not read, such as a `version`, asks for something the write would not do.

**Tests:** `compliance/table-rows.test.ts › refuses an operation with a member it does not take, or a delete that sends values`.

### `tables/rows-values-refused`

If a `put` or `patch` sends no `values`, or `values` that is not an object, then the server MUST answer `400 validation_error` naming `operations.<index>.values`.

**Tests:** `compliance/table-rows.test.ts › refuses a put or patch whose values is missing or not an object`.

### `tables/rows-put-replace`

When a `put` names the `id` of a row the table holds and sends values other than those it holds, the server MUST replace the row's values with those it sends and those `tables/rows-withheld-put-kept` keeps.

**Reason:** a `put` is the whole row, so a column it leaves out is cleared, unless the writing key may not see its value.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-put-replaced`

When a `put` replaces a row's values, the server MUST answer its outcome `replaced`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-put-null`

When a `put` sends `null` for a column, the server MUST hold the row without a value for the column.

**Reason:** a row holds no `null`, so a `put` that names a column as `null` and one that leaves it out write the same row.

**Tests:** `compliance/table-rows.test.ts › holds a column a put sends as null as one it leaves out`.

### `tables/rows-put-repeat`

When the values a `put` would leave in the row it names are exactly those the row holds, the server MUST leave the row as it is, its `updated_at` included.

**Reason:** a connector sends the same rows again after a lost answer, and the second send changes nothing and announces nothing.

**Tests:** `compliance/table-rows.test.ts › takes a put sent twice as one row, the second unchanged`, `› keeps a value the key may not read in each column a put leaves out`.

### `tables/rows-put-unchanged`

When a `put` leaves a row as it is, the server MUST answer its outcome `unchanged`.

**Tests:** `compliance/table-rows.test.ts › takes a put sent twice as one row, the second unchanged`.

### `tables/rows-patch`

When a `patch` names a row the table holds, the server MUST set each column the `patch` names to the value it sends.

**Tests:** `compliance/table-rows.test.ts › patches only the columns it names`.

### `tables/rows-patch-keep`

When a `patch` names a row the table holds, the server MUST keep each column the `patch` does not name as it is.

**Reason:** two writers that change different columns of one row both land.

**Tests:** `compliance/table-rows.test.ts › patches only the columns it names`.

### `tables/rows-patch-patched`

When a `patch` changes a row's values, the server MUST answer its outcome `patched`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-patch-same`

When every column a `patch` names already holds the value it sends, or holds no value where it sends `null`, the server MUST leave the row as it is, its `updated_at` included.

**Tests:** `compliance/table-rows.test.ts › leaves a row a patch would not change as it is, answering unchanged`.

### `tables/rows-patch-unchanged`

When a `patch` leaves a row as it is, the server MUST answer its outcome `unchanged`.

**Tests:** `compliance/table-rows.test.ts › leaves a row a patch would not change as it is, answering unchanged`.

### `tables/rows-patch-clear`

When a `patch` sends `null` for a column, the server MUST remove the row's value for the column.

**Tests:** `compliance/table-rows.test.ts › patches only the columns it names`.

### `tables/rows-patch-missing`

If a `patch` names a row the table does not hold, then the server MUST answer `404 row_not_found`.

**Tests:** `compliance/table-rows.test.ts › refuses a patch of a row the table does not hold, and writes nothing of its batch`.

### `tables/rows-delete`

When a `delete` names a row the table holds, the server MUST remove the row.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-deleted`

When a `delete` removes a row, the server MUST answer its outcome `deleted`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-delete-absent`

When a `delete` names a row the table does not hold, the server MUST answer its outcome `absent`.

**Reason:** the row is gone either way, so a repeated delete is acknowledged.

**Tests:** `compliance/table-rows.test.ts › acknowledges a delete of a row the table does not hold`.

### `tables/rows-in-order`

When a batch names one row in more than one operation, the server MUST apply each operation to the row as the operations before it in the batch leave it.

**Tests:** `compliance/table-rows.test.ts › applies operations on one row in the order they are sent`.

### `tables/rows-all-or-none`

If the server refuses a batch, or any operation of it, then the server MUST write none of the batch.

**Tests:** `compliance/table-rows.test.ts › refuses a patch of a row the table does not hold, and writes nothing of its batch`, `› writes nothing of a batch with one bad operation among many`, `› refuses a patch that would leave a row over 64 KiB`, `› reads rows as the item is read, and refuses a key with read but not write`, `› refuses to read or write the rows of an item in the bin`, `› refuses a put or patch naming a column whose value the key may not read, and writes nothing of its batch`.

### `tables/rows-operations-required`

If a batch has no `operations`, or `operations` is not a list of objects or is empty, then the server MUST answer `400 validation_error` naming `operations`.

**Tests:** `compliance/table-rows.test.ts › refuses a batch with no operations`.

### `tables/rows-unknown-column`

If an operation's `values` names a column the table does not declare, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Tests:** `compliance/table-rows.test.ts › refuses a value of the wrong kind, a missing required column and an unknown column, naming each`.

### `tables/rows-value-rules`

If a value breaks a rule its column states, in its `type`, `enum_values`, `format`, `maxLength`, `minimum` or `maximum`, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Reason:** a column holds the values a field of its type holds.

**Tests:** `compliance/table-rows.test.ts › refuses a value of the wrong kind, a missing required column and an unknown column, naming each`.

### `tables/rows-required`

If a `put` leaves out a column the table declares `required` that `tables/rows-withheld-put-kept` does not keep, or a `patch` sends `null` for one, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Tests:** `compliance/table-rows.test.ts › refuses a value of the wrong kind, a missing required column and an unknown column, naming each`, `› keeps a value the key may not read in each column a put leaves out`.

### `tables/rows-item-missing`

If a value in a column of type `item` is not the id of an item the writing key may read, outside the bin, and is not the id `tables/rows-item-binned-kept` accepts, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Reason:** a row points at an item that exists when it is written, and a write never learns of an item its key cannot read.

**Tests:** `compliance/table-rows.test.ts › refuses an item column naming an item that does not exist or that the key may not read`, `› takes back the id of an item now in the bin that a column already holds, and refuses it as a new reference`.

### `tables/rows-item-binned-kept`

When a `put` or `patch` sends, for a column of type `item`, the id the row already holds in that column, and the item that id names is in the bin and of a type the writing key may read, the server MUST accept the id.

**Reason:** a key that reads a row, edits it and puts it back sends the id it read; the item's move to the bin does not make that round trip fail, and a write that names a binned item the column does not hold stays refused under `tables/rows-item-missing`.

**Tests:** `compliance/table-rows.test.ts › takes back the id of an item now in the bin that a column already holds, and refuses it as a new reference`.

### `tables/rows-item-constraint`

If a value in a column of type `item` names an item of a type the column's `type_constraints` does not admit, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Tests:** `compliance/table-rows.test.ts › refuses an item column naming an item of a type its constraints do not admit`.

### `tables/rows-batch-limit`

If a batch holds more than 1000 operations, then the server MUST answer `400 validation_error` naming `operations`.

**Reason:** a batch of 1000 rows of 1 KB each holds the writer for about 10 ms on the server's reference machine, so no other write waits long behind it.

**Tests:** `compliance/table-rows.test.ts › refuses a row over 64 KiB and a batch over 1000 operations`.

### `tables/rows-row-limit`

If the values of the row an operation would leave, written as JSON, are longer than 65536 bytes (64 KiB), then the server MUST answer `400 validation_error` naming `operations.<index>.values`.

**Reason:** a row is small; a long text belongs in a file item the row points at. A `patch` adds to what the row holds, so the limit holds for the row it leaves, not for what it sends.

**Tests:** `compliance/table-rows.test.ts › refuses a row over 64 KiB and a batch over 1000 operations`, `› refuses a patch that would leave a row over 64 KiB`.

### `tables/rows-batch-answer`

When a batch changes at least one row, the server MUST answer the batch's UUIDv7 in `batch`.

**Tests:** `compliance/table-rows.test.ts › takes a put sent twice as one row, the second unchanged`.

### `tables/rows-batch-none`

When a batch changes no row, the server MUST answer `batch` `null`.

**Tests:** `compliance/table-rows.test.ts › takes a put sent twice as one row, the second unchanged`, `› acknowledges a delete of a row the table does not hold`.

### `tables/table-not-found`

If a door under `/items/{id}/tables/{table}` names a table that the item's type does not declare and the item does not keep under `tables/own-table-listed`, then the server MUST answer `404 table_not_found`.

**Tests:** `compliance/table-rows.test.ts › answers table_not_found for a table the type does not declare`, `compliance/table-rows-own.test.ts › answers table_not_found for a table other than the one the item keeps`, `compliance/table-rows-undo.test.ts › answers table_not_found for an undo once a forced change removed the table`.

## Who may read and write rows

### `tables/rows-read-access`

If a key may not read an item, by its type or because no item holds the id, then the server MUST answer each door under `/items/{id}/tables` `404 item_not_found`.

**Reason:** reading a table is reading its item.

**Tests:** `compliance/table-rows.test.ts › reads rows as the item is read, and refuses a key with read but not write`.

### `tables/rows-write-access`

If a key that may read an item's type and not write it sends `POST /items/{id}/tables/{table}/rows`, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/table-rows.test.ts › reads rows as the item is read, and refuses a key with read but not write`.

### `tables/rows-bin-read`

When a read under `/items/{id}/tables` names an item in the bin, the server MUST answer `404 item_not_found` with no `details`.

**Reason:** an item in the bin reads as `errors/bin-read` says, and its rows with it.

**Tests:** `compliance/table-rows.test.ts › refuses to read or write the rows of an item in the bin`.

### `tables/rows-bin-write`

When `POST /items/{id}/tables/{table}/rows` names an item in the bin whose type the key may read, the server MUST answer `404 item_not_found` with `details` of exactly `{ "trashed": true }`.

**Tests:** `compliance/table-rows.test.ts › refuses to read or write the rows of an item in the bin`.

### `tables/rows-item-withheld`

When a row holds in a column of type `item` the id of an item the reading key may not read, the server MUST answer the row without the column in `values` and with the column named in `withheld`.

**Reason:** the row is the reader's to see, and the item it names is not.

**Tests:** `compliance/table-rows.test.ts › withholds an item column's id from a key that may not read the item, and keeps the row`.

### `tables/rows-item-origin`

While a row holds a value that was written to a column of type `item`, the server MUST withhold it as the id of an item under `tables/rows-item-withheld` and `tables/rows-event-withheld`, whatever the item's type declares for the column since.

**Reason:** a forced change that removes the column or changes its `type`, or a retype of the item, keeps the value, and never shows it to a key that may not read the item it names.

**Tests:** `compliance/table-rows-lifecycle.test.ts › withholds an item id a row holds after its column is removed or retyped, or its item is retyped`, `compliance/table-rows-events.test.ts › withholds an item id a row holds from a stream after its column is removed`.

### `tables/rows-item-gone`

While a row holds a value that was written to a column of type `item` as the id of an item no longer held, the server MUST withhold it under `tables/rows-item-withheld` and `tables/rows-event-withheld` only from a key that may not read every type, a key that may read every type being one whose `type_permissions` grant read on `*` and narrow no type below it.

**Reason:** a purge leaves the id in the rows that name the item, and only a key that may read every type could have read whatever item it named.

**Tests:** `compliance/table-rows-lifecycle.test.ts › shows the id of a purged item to a key that reads every type, and withholds it from any other`, `› shows a purged item's id to a key that reads every type after its column is removed or retyped, and withholds it from any other`, `compliance/table-rows-events.test.ts › sends a purged item's id to a stream that reads every type, and withholds it from any other`.

### `tables/rows-withheld-write`

If a `put` or `patch` names in `values` a column whose value the server would withhold from the writing key on a read of the row, then the server MUST answer `403 forbidden` with `details.operation` naming the operation and `details.column` naming the column.

**Reason:** a write that compared the value, or replaced it, would tell the key which item the value names or remove a reference it cannot see; the refusal tells it only what `withheld` on a read already shows.

**Tests:** `compliance/table-rows.test.ts › refuses a put or patch naming a column whose value the key may not read, and writes nothing of its batch`, `compliance/table-rows-lifecycle.test.ts › refuses a write naming an item id the key may not read after its column is retyped, whatever value it sends`.

### `tables/rows-withheld-put-kept`

When a `put` replaces a row, the server MUST keep in the row each value it would withhold from the writing key on a read of the row.

**Reason:** a key that reads a row, edits what it sees and puts it back leaves the reference it could not see as it was.

**Tests:** `compliance/table-rows.test.ts › keeps a value the key may not read in each column a put leaves out`.

### `tables/rows-withheld-delete`

When a key that may write an item's type sends a `delete` of a row holding a value the server would withhold from the key on a read of the row, the server MUST delete the row.

**Reason:** the key may write the table; what it may not see is the item the value names, which the delete leaves alone.

**Tests:** `compliance/table-rows.test.ts › deletes a row holding a value the key may not read`.

### `tables/rows-withheld-reads`

When the server withholds a row's value from the reading key, the server MUST select, sort and total the row, and continue a page after it, as though the row held no value for the column.

**Reason:** a filter, an order, a total or a cursor that read the value would tell the key which item it names.

**Tests:** `compliance/table-rows-reads.test.ts › filters, sorts, totals and pages a withheld item id as no value`.

## Reading rows

### `tables/item-tables-list`

When a caller that may read an item sends `GET /items/{id}/tables`, the server MUST answer in `data` each table the item's type declares, by name, with its `row_count`, `bytes`, `last_batch` and `changed_at`.

**Tests:** `compliance/table-rows-reads.test.ts › lists the tables an item's type declares with what each holds`.

### `tables/rows-page`

When a caller sends `GET /items/{id}/tables/{table}/rows` with no `sort`, the server MUST answer the rows in `data` by `id` ascending, at most `limit` of them, with a `next_cursor` that continues the page while more remain.

**Tests:** `compliance/table-rows-reads.test.ts › pages a table's rows by id, continuing by a signed cursor`.

### `tables/rows-limit`

If `limit` is not a whole number from 1 to 1000, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `compliance/table-rows-reads.test.ts › pages a table's rows by id, continuing by a signed cursor`.

### `tables/rows-cursor`

If a `cursor` was not answered for the same item, table, `filter`, `sort`, `direction` and, when `sort` names a column, the same `type` of that column, then the server MUST answer `400 validation_error` naming `cursor`.

**Reason:** a position read as one kind of value cannot continue a page read as another, and a page that continued from it would end the walk with rows unread.

**Tests:** `compliance/table-rows-reads.test.ts › pages a table's rows by id, continuing by a signed cursor`, `› refuses a cursor answered for the other direction`, `› refuses a cursor answered before the sorted column changed type`.

### `tables/rows-cursor-size`

When `GET /items/{id}/tables/{table}/rows` answers a `next_cursor`, the server MUST answer a cursor of at most 512 characters, however long the sort value of the last row it answers.

**Reason:** a cursor travels in a URL and in a tool call, and a text column holds up to 64 KiB.

**Tests:** `compliance/table-rows-reads.test.ts › keeps a cursor short however long the sort value is, and follows the row it names`.

### `tables/rows-cursor-continues`

When a caller continues a listing by a `cursor` that follows a row whose sort value is unchanged, the server MUST answer the rows that come after that row in the listing's order, skipping none and repeating none, whatever the length of that sort value.

**Tests:** `compliance/table-rows-reads.test.ts › keeps a cursor short however long the sort value is, and follows the row it names`, `› pages rows that share a long sort value without skipping or repeating one`.

### `tables/rows-cursor-moved`

If a `cursor` follows a row whose sort value is a text of more than 128 bytes in UTF-8, and that row has been removed or holds another sort value since the cursor was answered, then the server MUST answer `400 validation_error` naming `cursor`.

**Reason:** a cursor keeps a long sort value as a tag of it, so the page boundary is checked against the row as it is now, and a boundary that moved is refused rather than guessed.

**Tests:** `compliance/table-rows-reads.test.ts › keeps a cursor short however long the sort value is, and follows the row it names`.

### `tables/rows-filter`

When `GET /items/{id}/tables/{table}/rows` or `GET /items/{id}/tables/{table}/totals` names a `filter`, the server MUST select the rows it selects under the grammar of `search-and-filters/filter-doors`, reading `values.<column>` as a column and `id` and `updated_at` as the row's own.

**Reason:** a client that filters items filters rows with the same expressions.

**Tests:** `compliance/table-rows-reads.test.ts › filters rows on columns with the item filter grammar`.

### `tables/rows-filter-refused`

If a row `filter` names a column the table does not declare, or a field other than `values.<column>`, `id` and `updated_at`, then the server MUST answer `400 validation_error` naming `filter`.

**Tests:** `compliance/table-rows-reads.test.ts › filters rows on columns with the item filter grammar`.

### `tables/rows-sort`

When `GET /items/{id}/tables/{table}/rows` names `sort` as `id`, `updated_at` or `values.<column>` and `direction` as `asc` or `desc`, the server MUST answer the rows in that order, a row without the column last in either direction and a tie by `id` ascending.

**Tests:** `compliance/table-rows-reads.test.ts › sorts rows on a column, rows without it last`, `compliance/conversation.test.ts › pages the messages by sent_at in either direction, a tie by id`.

### `tables/rows-sort-instant`

When a page of rows is sorted by a `datetime` column, the server MUST order the values by their instant, a calendar date as midnight UTC.

**Reason:** rows written from places with different offsets sort by when they happened, not by how the time was written.

**Tests:** `compliance/table-rows-reads.test.ts › sorts a datetime column by its instant, whatever the offset`.

### `tables/rows-sort-kind`

When a page of rows is sorted by a `datetime`, `number`, `integer` or `string` column, the server MUST sort a value of another type as though the row held no value for the column.

**Reason:** a type changed with `force=true` keeps the values its rows held, which may no longer be of the column's type.

**Tests:** `compliance/table-rows-reads.test.ts › sorts a value a forced change left of another type as no value`.

### `tables/rows-order-item-id`

When a page of rows is sorted by a table's `order` column, the server MUST sort a value written as an item's ID as though the row held no value for the column, for every reader.

**Reason:** the order is kept once for every reader, and a key that may not read the item must not learn where its ID sorts. Such a value is left only by a column changed from `item` with `force=true`.

**Tests:** `compliance/table-rows-reads.test.ts › sorts an item id a forced change left in the order column as no value`.

### `tables/order-changed`

When a type's change names another column as a table's `order`, removes its `order` or changes the type of its `order` column, the server MUST answer each page of the table's rows from then on in the order `tables/rows-sort` states.

**Reason:** the server rewrites the order it keeps for a large table a page at a time, in `table-row-cleanup`, and a page read meanwhile is still sorted right.

**Tests:** `compliance/table-rows-reads.test.ts › sorts by a new order at once, while table-row-cleanup rewrites the kept order of a large table`, `› rewrites the kept order of many small tables mostly in table-row-cleanup, sorting every page right meanwhile`.

### `tables/order-change-bounded`

When a change to a type moves the order the server keeps for the rows of its items' tables, the server MUST rewrite at most 1000 rows in the write of that change and leave the rest to `table-row-cleanup`.

**Reason:** a type can have any number of items with any number of tables, and one write that rewrote them all would hold every other write.

**Tests:** `compliance/table-rows-reads.test.ts › rewrites the kept order of many small tables mostly in table-row-cleanup, sorting every page right meanwhile`.

### `tables/order-undo`

When an undo puts back or removes rows of a table that names an `order`, the server MUST answer each page of the table's rows sorted by the column the table names as its `order` when the undo is made, in the order `tables/rows-sort` states.

**Reason:** an undo writes rows as any batch does, so a type's change to the `order` between a batch and its undo sorts the rows the undo puts back by the new `order`.

**Tests:** `compliance/table-rows-undo.test.ts › puts back and removes the rows of an ordered table in its order, also after its order names another column`, `compliance/table-rows-archive.test.ts › undoes a write over restored rows, putting each back as the restore wrote it`.

### `tables/order-restored`

When `POST /restore` writes the rows of a table that names an `order`, the server MUST answer each page of the table's rows sorted by that column in the order `tables/rows-sort` states from the restore's answer on.

**Reason:** the server keeps each restored row in the table's order as it writes the row, so the first read after a restore is as fast as any later one.

**Tests:** `compliance/table-rows-archive.test.ts › restores a conversation's latest messages in sent_at order straight after the restore`.

### `tables/rows-get`

When a caller sends `GET /items/{id}/tables/{table}/rows/{row}` for a row the table holds, the server MUST answer the row.

**Tests:** `compliance/table-rows-reads.test.ts › reads one row, and answers row_not_found for a row the table does not hold`.

### `tables/row-not-found`

If `GET /items/{id}/tables/{table}/rows/{row}` names a row the table does not hold, then the server MUST answer `404 row_not_found`.

**Tests:** `compliance/table-rows-reads.test.ts › reads one row, and answers row_not_found for a row the table does not hold`.

### `tables/totals`

When a caller sends `GET /items/{id}/tables/{table}/totals`, the server MUST answer in `totals`, for each column that names `adds_up`, its total over the rows the `filter` selects, and in `row_count` how many rows it selects.

**Tests:** `compliance/table-rows-reads.test.ts › totals each column that adds up, over the rows a filter selects`.

### `tables/totals-meaning`

The server MUST answer `sum` as the sum of the column's values, `average` as their mean, `min` and `max` as the smallest and largest, a `datetime` compared and answered as its instant in UTC, and `count` as how many rows hold a value.

**Tests:** `compliance/table-rows-reads.test.ts › totals each column that adds up, over the rows a filter selects`.

### `tables/totals-empty`

When no row the `filter` selects holds a value for a column that names `adds_up`, the server MUST answer its `sum` and `count` as `0`, and its `average`, `min` and `max` as `null`.

**Tests:** `compliance/table-rows-reads.test.ts › totals nothing as zero or null`.

## Rows through MCP

`marfa_read_rows` reads an item's rows and `marfa_write_rows` writes them, each for one item and one table named in `id` and `table`, with the credential's own access: the doors under the item decide, so a refusal below is the one that door answers, carried as a tool error. `marfa_get` lists an item's tables without their rows.

### `tables/mcp-read-rows`

When `marfa_read_rows` names an item and a table, the server MUST answer as `rows` the first rows `GET /items/{id}/tables/{table}/rows` answers for the same `filter`, `sort`, `direction` and `cursor`, in that door's order, and as `next_cursor` the cursor that continues after the last of them, or `null` when no row follows.

**Reason:** an agent reads rows with the expressions and the order a client of the API uses, and a prefix of the door's page, not a different page, is what a size limit leaves.

**Tests:** `compliance/table-rows-mcp.test.ts › reads rows as the page door does, by filter, sort and cursor`, `› reads a table's order column as the page door does, in either direction`.

### `tables/mcp-read-limit`

When `marfa_read_rows` names a `limit` from 1 to 1000, the server MUST answer at most that many rows, and 50 where it names none.

**Tests:** `compliance/table-rows-mcp.test.ts › reads rows as the page door does, by filter, sort and cursor`.

### `tables/mcp-read-refused`

If a `marfa_read_rows` call names what `GET /items/{id}/tables/{table}/rows` refuses, then the server MUST answer a tool error with the code that door answers.

**Reason:** an item the credential may not read, a table the type does not declare, and a `filter`, `sort`, `direction`, `cursor` or `limit` the door refuses are refused the same way through either door.

**Tests:** `compliance/table-rows-mcp.test.ts › refuses a read as the page door does`.

### `tables/mcp-read-totals`

When `marfa_read_rows` names `totals` `true`, the server MUST answer `row_count` and `totals` as `GET /items/{id}/tables/{table}/totals` answers them for the same `filter`.

**Tests:** `compliance/table-rows-mcp.test.ts › answers totals only when asked`.

### `tables/mcp-read-totals-unasked`

While a `marfa_read_rows` call names no `totals` or `totals` `false`, the server MUST NOT answer `row_count` or `totals`.

**Reason:** a total over a large table costs the server a pass over its rows, which a call that did not ask for it does not pay.

**Tests:** `compliance/table-rows-mcp.test.ts › answers totals only when asked`.

### `tables/mcp-read-budget`

When `marfa_read_rows` answers, the server MUST keep the answer's text within 40,000 characters.

**Reason:** a client cuts or drops a tool answer past its own limit, and the agent loses what the answer held.

**Tests:** `compliance/table-rows-mcp.test.ts › stops a page at the answer budget and continues by next_cursor`.

### `tables/mcp-read-cursor-size`

When `marfa_read_rows` answers a `next_cursor`, the server MUST answer a cursor of at most 512 characters, however long the sort value of the last row it answers.

**Reason:** a row may sort on a text of 64 KiB, and a cursor that carried it would be larger than the answer budget.

**Tests:** `compliance/table-rows-mcp.test.ts › keeps next_cursor short and exact when rows sort on a 54,000-character value`.

### `tables/mcp-read-cursor-continues`

When `marfa_read_rows` answers a `next_cursor`, the server MUST answer a cursor that continues exactly after the last row it answers, skipping none and repeating none, as `tables/rows-cursor-continues` states for the page door.

**Tests:** `compliance/table-rows-mcp.test.ts › keeps next_cursor short and exact when rows sort on a 54,000-character value`.

### `tables/mcp-read-stopped`

If the rows a `marfa_read_rows` call selects do not all fit within 40,000 characters, and the first of them fits alone, then the server MUST answer fewer rows, ending with a `next_cursor` that continues after the last row it answers.

**Tests:** `compliance/table-rows-mcp.test.ts › stops a page at the answer budget and continues by next_cursor`.

### `tables/mcp-read-stopped-hint`

If a `marfa_read_rows` call answers fewer rows than it selected for the size of the answer, then the server MUST answer a `hint` that says the answer stopped early for its size and to pass `next_cursor` as `cursor`.

**Tests:** `compliance/table-rows-mcp.test.ts › stops a page at the answer budget and continues by next_cursor`.

### `tables/mcp-read-cut`

If the first row a `marfa_read_rows` call selects does not fit alone within 40,000 characters, then the server MUST answer that row alone with its longest text values cut, and name each cut value in `cut` with the row's `id`, the `column` and the `next_offset` to read from.

**Reason:** a row may hold up to 64 KiB of values, more than one answer holds.

**Tests:** `compliance/table-rows-mcp.test.ts › cuts the text of a row too long to fit and reads the rest by offset`.

### `tables/mcp-read-cut-hint`

If a `marfa_read_rows` call answers a cut row, then the server MUST answer a `hint` that names `next_offset` as where to read the rest.

**Tests:** `compliance/table-rows-mcp.test.ts › cuts the text of a row too long to fit and reads the rest by offset`.

### `tables/mcp-read-cut-unstopped`

If a `marfa_read_rows` call answers a cut row, then the server MUST NOT answer a `hint` that the answer stopped early.

**Reason:** a cut row is read on by offset, and a stopped page by `next_cursor`, so one hint for both would send the agent the wrong way.

**Tests:** `compliance/table-rows-mcp.test.ts › cuts the text of a row too long to fit and reads the rest by offset`.

### `tables/mcp-read-cut-cursor`

If a `marfa_read_rows` call answers a cut row, then the server MUST answer `next_cursor` as the cursor that continues after that row, or `null` when no row follows it.

**Tests:** `compliance/table-rows-mcp.test.ts › cuts the text of a row too long to fit and reads the rest by offset`, `› keeps next_cursor short and exact when rows sort on a 54,000-character value`.

### `tables/mcp-read-column-part`

When `marfa_read_rows` names a `row`, a `column` and an `offset`, the server MUST answer the column's text of that row from that offset, with the `next_offset` to read from, or `null` when nothing is left.

**Tests:** `compliance/table-rows-mcp.test.ts › cuts the text of a row too long to fit and reads the rest by offset`.

### `tables/mcp-write-rows`

When `marfa_write_rows` names an item, a table and operations that all hold, the server MUST apply them as `POST /items/{id}/tables/{table}/rows` applies a batch.

**Tests:** `compliance/table-rows-mcp.test.ts › writes a batch through marfa_write_rows as the write door does`.

### `tables/mcp-write-answer`

When `marfa_write_rows` applies a batch, the server MUST answer the `batch`, `last_activity_at` and `results` that `POST /items/{id}/tables/{table}/rows` answers.

**Tests:** `compliance/table-rows-mcp.test.ts › writes a batch through marfa_write_rows as the write door does`.

### `tables/mcp-write-refused`

If a `marfa_write_rows` call names a batch that `POST /items/{id}/tables/{table}/rows` refuses, then the server MUST answer a tool error with the code, message and `details` that door answers, whether the batch is missing, null, an object, a string, a number or a list with a fault in it.

**Reason:** the checks are the door's, including a column whose value the key may not read, which the door refuses `403 forbidden`.

**Tests:** `compliance/table-rows-mcp.test.ts › refuses a batch as the write door does and writes none of it`, `› refuses a batch that is not a list as the write door does`.

### `tables/mcp-write-refused-nothing`

If a `marfa_write_rows` call names a batch that `POST /items/{id}/tables/{table}/rows` refuses, then the server MUST NOT write any operation of the batch.

**Tests:** `compliance/table-rows-mcp.test.ts › refuses a batch as the write door does and writes none of it`, `› refuses a batch that is not a list as the write door does`, `› refuses a column whose value the key may not read, as the write door does`.

### `tables/mcp-write-limit`

If `operations` holds more than 200 operations, then the server MUST answer a tool error `validation_error` that names `operations`.

**Reason:** the answer names every operation's outcome, and 200 of them fit within one answer.

**Tests:** `compliance/table-rows-mcp.test.ts › refuses a batch of more than 200 operations`.

### `tables/mcp-write-limit-nothing`

If `operations` holds more than 200 operations, then the server MUST NOT write any of them.

**Tests:** `compliance/table-rows-mcp.test.ts › refuses a batch of more than 200 operations`.

### `tables/mcp-get-tables`

When `marfa_get` reads an item whose type declares tables, the server MUST answer under `tables` each table with its `name`, `label`, the names of its `columns` and its `row_count`, and no row.

**Tests:** `compliance/table-rows-mcp.test.ts › lists an item's tables with marfa_get and answers no row`.

### `tables/mcp-get-no-tables`

When `marfa_get` reads an item whose type declares no table, the server MUST NOT answer `tables` for it.

**Tests:** `compliance/table-rows-mcp.test.ts › leaves tables out of an item whose type declares none`.

### `tables/mcp-get-columns-cut`

If the items `marfa_get` reads do not fit within 40,000 characters once every field is cut, then the server MUST leave the `columns` out of the tables it lists before it leaves out an item.

**Reason:** a type holds up to 32 tables of 64 columns, and a table's name and `row_count` serve the agent where its columns do not fit.

**Tests:** `compliance/table-rows-mcp.test.ts › leaves the columns out of the listed tables before it leaves out an item`.

## Activity

### `tables/last-activity`

The server MUST answer on an item `last_activity_at`, the later of when the item was last written and when a row of it last changed.

**Reason:** a conversation lists by its latest message, and a new row leaves `updated_at` and `version` alone.

**Tests:** `compliance/table-rows-lifecycle.test.ts › moves last_activity_at, and not updated_at or version, when a row changes`.

### `tables/rows-leave-item`

When a batch changes rows, the server MUST leave the item's `updated_at` and `version` as they were.

**Tests:** `compliance/table-rows-lifecycle.test.ts › moves last_activity_at, and not updated_at or version, when a row changes`.

### `tables/last-activity-sort`

When `GET /items` names `sort` `last_activity_at`, the server MUST answer the items by `last_activity_at` in the `direction` it names.

**Tests:** `compliance/table-rows-lifecycle.test.ts › lists items by last_activity_at`.

## Announcing rows

### `tables/rows-event`

When a batch changes at least one row, the server MUST announce one `rows.changed` naming the `item` by `id`, `type` and `source`, the `table`, the `batch`, the item's `last_activity_at`, and in `rows` each row the batch changed, as `{ "id", "values" }` as the batch left it or `{ "id", "deleted": true }`.

**Reason:** a device applies a batch from one event on the one cursor, without a read; each row's `updated_at` is the event's `last_activity_at`.

**Tests:** `compliance/table-rows-events.test.ts › announces one rows.changed per batch to a stream and a webhook`.

### `tables/rows-event-none`

When a batch changes no row, the server MUST NOT announce `rows.changed`.

**Tests:** `compliance/table-rows-events.test.ts › announces nothing for a batch that changes nothing`.

### `tables/rows-event-cap`

When the rows a batch changed hold more than 65536 bytes of values, the server MUST carry `rows` in its `rows.changed` as `{ "id" }` or `{ "id", "deleted": true }` alone, with `values_included` `false`.

**Reason:** an event stays small for every stream and webhook it reaches, and a device reads the rows it lacks.

**Tests:** `compliance/table-rows-events.test.ts › carries ids alone past the event's byte cap`.

### `tables/rows-event-reach`

If a key may not read an item's type, or a stream's source filter hides the item, then the server MUST NOT send that key's stream or webhook the item's `rows.changed`.

**Tests:** `compliance/table-rows-events.test.ts › announces one rows.changed per batch to a stream and a webhook`, `› sends no rows.changed to a stream whose source filter hides the item`.

### `tables/rows-event-type-filter`

When a stream or a webhook names a type filter, the server MUST send it only the `rows.changed` of items the filter selects.

**Tests:** `compliance/table-rows-events.test.ts › sends rows.changed only where a type filter selects the item`.

### `tables/rows-event-withheld`

When a `rows.changed` carries a row holding in a column of type `item` the id of an item of a type the receiving key may not read, the server MUST send the row without the column in `values` and with the column named in `withheld`.

**Tests:** `compliance/table-rows-events.test.ts › withholds an item column's id from a stream that may not read the item`.

### `tables/rows-event-copy-sent`

While a stream is a copy stream, the server MUST send it the `rows.changed` of each item whose type the credential may read, whatever the source filter.

**Reason:** a device holds the tables of the items its copy holds (`device/table-hold`), and its copy can hold an item the source filter leaves out (`reach/frame-excluded`).

**Tests:** `compliance/table-rows-events.test.ts › sends rows.changed on a copy stream, for an item the source filter leaves out too`.

## The change log and undo

A table keeps a change log: each batch that changed at least one of its rows, with each row as it stood before the batch, for `row_log_retention_days`. An undo is itself a batch, so undoing an undo redoes the batch it undid. A row stands as a batch left it while no later batch has changed it, or every later batch that did has been undone, newest first; a row the batch deleted stands as it left it while the table holds no row with its id. The doors are `POST /items/{id}/tables/{table}/batches/{batch}/undo` and `GET /items/{id}/tables/{table}/batches`.

### `tables/undo`

When a caller sends `POST /items/{id}/tables/{table}/batches/{batch}/undo` and every row the batch changed stands as the batch left it or as it was before the batch, the server MUST leave each of those rows as it was before the batch.

**Reason:** a person takes back a write whole, one batch at a time, from the newest.

**Tests:** `compliance/table-rows-undo.test.ts › undoes a batch, putting back rows it replaced, patched and deleted and removing rows it created`, `› undoes a batch where a later batch left a row as it was before the batch`, `› undoes a run of batches newest first, and redoes them oldest first`, `› undoes an earlier batch once a later batch that left its rows as it found them is undone`.

### `tables/undo-answer`

When an undo changes at least one row, the server MUST answer `200` with the undo's own UUIDv7 in `batch`, the batch it undid in `undoes`, the item's `last_activity_at`, and in `results` each row the undone batch changed, by `id` ascending, with its `outcome`.

**Tests:** `compliance/table-rows-undo.test.ts › answers each row of the undone batch in id order with its outcome, and moves last_activity_at`.

### `tables/undo-outcomes`

The server MUST answer the `outcome` of a row in an undo as `created` where it puts back a row the batch deleted, `replaced` where it puts back values the batch changed, `deleted` where it removes a row the batch created, and `unchanged` where the row already stands as it was before the batch.

**Tests:** `compliance/table-rows-undo.test.ts › answers each row of the undone batch in id order with its outcome, and moves last_activity_at`, `› undoes a batch where a later batch left a row as it was before the batch`.

### `tables/undo-nothing`

When every row an undone batch changed already stands as it was before the batch, the server MUST answer `batch` `null`.

**Reason:** an undo sent again after a lost answer changes nothing.

**Tests:** `compliance/table-rows-undo.test.ts › answers batch null for an undo sent again, changing nothing`.

### `tables/undo-redo`

When the batch an undo names is itself an undo, the server MUST undo it as any batch, leaving each row as the batch that undo undid left it.

**Reason:** redo is the undo of an undo, so one door and one log serve both.

**Tests:** `compliance/table-rows-undo.test.ts › redoes a batch by undoing its undo, and undoes it again`, `› undoes a run of batches newest first, and redoes them oldest first`.

### `tables/undo-conflict`

If a row the undone batch changed stands neither as the batch left it nor as it was before the batch, then the server MUST answer `409 undo_conflict` naming each such row by `id` in `details.rows`.

**Reason:** a later batch changed the row, and an undo over it would drop that work. Undoing the later batches first, newest first, clears the way.

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo where a later batch changed a row, naming the rows, and changes nothing`, `› takes a row the batch deleted as standing while the table holds no row with its id`.

### `tables/undo-all-or-none`

If the server refuses an undo, then the server MUST change none of the rows of the batch it names.

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo where a later batch changed a row, naming the rows, and changes nothing`, `› refuses an undo of a row holding a value the key may not read, and removes a created row holding one`, `› refuses an undo to a key that may not read a value a row held before or after the batch, whatever the row holds now`.

### `tables/undo-values-kept`

When an undo puts back a row's values, the server MUST put them back as they were before the batch, whatever the table's columns declare since.

**Reason:** an undo recovers what a person had, as `tables/change-forced` keeps values the declaration no longer takes.

**Tests:** `compliance/table-rows-undo.test.ts › puts back values in a column the type has since removed`.

### `tables/undo-not-found`

If an undo names a batch that the change log of the item's table does not hold, then the server MUST answer `404 batch_not_found`.

**Reason:** a batch of another table, an id no batch has and a batch past `row_log_retention_days` read alike.

**Tests:** `compliance/table-rows-undo.test.ts › answers batch_not_found for a batch of another table or item, and an id no batch has`, `compliance/table-rows-retention.test.ts › removes the batches older than row_log_retention_days at the next table-row-cleanup run, and keeps the newer`, `compliance/table-rows-archive.test.ts › logs no batch for the rows a restore writes, so an undo of its last_batch answers batch_not_found`.

### `tables/undo-write-access`

If a key that may read an item's type and not write it sends an undo, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo by a key that may read and not write, and on an item in the bin, and undoes once the item is back`.

### `tables/undo-bin`

When an undo names an item in the bin whose type the key may read, the server MUST answer `404 item_not_found` with `details` of exactly `{ "trashed": true }`.

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo by a key that may read and not write, and on an item in the bin, and undoes once the item is back`.

### `tables/undo-restored`

When an item has come back from the bin, the server MUST undo a batch of its tables that the change log holds.

**Reason:** the bin keeps an item's rows, and their change log with them.

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo by a key that may read and not write, and on an item in the bin, and undoes once the item is back`.

### `tables/undo-withheld`

If an undo names a batch that changed a row it did not create, and the row holds now, held before the batch or held after it a value the server would withhold from the undoing key on a read of the row, then the server MUST answer `403 forbidden` with `details.row` naming the row and `details.column` naming the column, whatever else it would answer for the row.

**Reason:** whether an undo puts a row back, finds it unchanged or refuses it as changed since turns on the values it compares, so an answer that differed would tell the key which item a withheld value names. A put back or replaced value is also a reference the key cannot see, which `tables/rows-withheld-write` refuses to a write. A row the batch created is removed or left by whether it is there alone (`tables/undo-withheld-delete`).

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo of a row holding a value the key may not read, and removes a created row holding one`, `› refuses an undo to a key that may not read a value a row held before or after the batch, whatever the row holds now`.

### `tables/undo-withheld-delete`

When an undo removes a row the undone batch created, the server MUST remove it whatever value it holds that the server would withhold from the undoing key.

**Reason:** removing the row leaves alone the item its value names, as `tables/rows-withheld-delete` allows a delete.

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo of a row holding a value the key may not read, and removes a created row holding one`.

### `tables/undo-event`

When an undo changes at least one row, the server MUST announce one `rows.changed` with the fields `tables/rows-event` names, and the batch it undid in `undoes`.

**Reason:** a device applies an undo as any batch, and an app can show which write it took back.

**Tests:** `compliance/table-rows-undo.test.ts › announces one rows.changed for an undo naming the batch it undid, and nothing for an undo that changes nothing`.

### `tables/undo-event-none`

When an undo changes no row, the server MUST NOT announce `rows.changed`.

**Tests:** `compliance/table-rows-undo.test.ts › announces one rows.changed for an undo naming the batch it undid, and nothing for an undo that changes nothing`.

### `tables/batches-list`

When a caller that may read an item sends `GET /items/{id}/tables/{table}/batches`, the server MUST answer in `data` the batches the table's change log holds, newest first, each with its `id`, `at`, `rows`, the number of rows it changed, and `undoes`, the batch it undid or `null`.

**Reason:** a person finds the write to take back, such as the one that deleted a row last week, from when it was made and how much it changed.

**Tests:** `compliance/table-rows-undo.test.ts › lists the table's batches newest first, with the rows each changed and what it undid`.

### `tables/batches-page`

When a caller sends `GET /items/{id}/tables/{table}/batches`, the server MUST answer at most `limit` batches, 100 where it names none, with a `next_cursor` that continues the page while more remain.

**Tests:** `compliance/table-rows-undo.test.ts › pages the batches by a signed cursor, and refuses a limit or cursor it did not answer`.

### `tables/batches-limit`

If a listing of batches names a `limit` that is not a whole number from 1 to 1000, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `compliance/table-rows-undo.test.ts › pages the batches by a signed cursor, and refuses a limit or cursor it did not answer`.

### `tables/batches-cursor`

If a listing of batches names a `cursor` that was not answered for the same item and table, then the server MUST answer `400 validation_error` naming `cursor`.

**Tests:** `compliance/table-rows-undo.test.ts › pages the batches by a signed cursor, and refuses a limit or cursor it did not answer`.

### `tables/log-retention`

Where `row_log_retention_days` is positive, when the `table-row-cleanup` job runs, the server MUST remove from each table's change log every batch made more than that many days before, up to the oldest batch whose stored time does not read.

**Reason:** the log is for taking back recent writes, not a history, and an old batch could no longer be undone over what came after it anyway.

**Tests:** `compliance/table-rows-retention.test.ts › removes the batches older than row_log_retention_days at the next table-row-cleanup run, and keeps the newer`, `› keeps a batch whose stored time does not read and every batch after it, and removes the older batches before it`.

### `tables/log-retention-zero`

Where `row_log_retention_days` is 0, the server MUST NOT remove a batch from a change log by its age.

**Tests:** `compliance/table-rows-retention.test.ts › keeps every batch while row_log_retention_days is 0, however far the clock moves`.

## Rows and the life of an item

### `tables/purge-rows`

When the server purges an item, the server MUST remove its rows through the `table-row-cleanup` housekeeping job, a page at a time.

**Reason:** removing a large table in one statement would hold every other write behind it.

**Tests:** `compliance/table-rows-lifecycle.test.ts › removes a purged item's rows in pages, answering other requests meanwhile`.

### `tables/move-refused`

If `POST /types/{id}/move` or a retype of an item would leave an item in a type that neither declares nor keeps under `tables/own-table-listed` a table the item holds rows in, then the server MUST answer `409 type_move_blocked` naming those tables in `details.tables`.

**Reason:** a move never drops what a person made.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses a type move and a retype whose target does not declare the tables an item holds`, `compliance/table-rows-own.test.ts › refuses a retype of an item holding rows to a type that keeps no table, and takes one to a type that does`.

### `tables/change-in-use`

If `PUT /types/{id}` without `force=true` would remove a table that holds rows, remove a column that holds a value, or change the `type` of a column that holds a value, then the server MUST answer `409 type_in_use` naming each in `details.tables`, as `<table>` or `<table>.<column>`.

**Reason:** removing what rows hold follows how deleting a type that has items is refused unless forced.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses to remove a table or a column that holds rows unless forced, and keeps the rows when forced`.

### `tables/change-forced`

When `PUT /types/{id}` names `force=true`, the server MUST keep every row and value it would refuse to remove under `tables/change-in-use` or `tables/own-change-in-use`, as it is.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses to remove a table or a column that holds rows unless forced, and keeps the rows when forced`, `compliance/table-rows-own.test.ts › refuses a replacement that takes a type away from core.table while its items hold rows in the table they keep, unless forced`.

### `tables/save-type-change-in-use`

If a `marfa_save_type` call with `action` `change` would remove a table that holds rows, remove a column that holds a value, or change the `type` of a column that holds a value, then the server MUST answer a tool error with code `type_in_use` naming each in `details.tables`, as `<table>` or `<table>.<column>`.

**Reason:** the tool takes no `force`, so it never removes what rows hold.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses a marfa_save_type change that removes what rows hold`.

### `tables/save-type-change-kept`

If the server refuses a `marfa_save_type` call under `tables/save-type-change-in-use`, then the server MUST leave the type as it was.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses a marfa_save_type change that removes what rows hold`.

### `tables/delete-constrained`

If `DELETE /types/{id}` without `force=true` names a type that a column's `type_constraints` names, then the server MUST answer `409 type_in_use` naming each such column in `details.columns`, as `<type>.<table>.<column>`.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses to delete a type a column constrains to unless forced`.

## Rows of a table a person keeps

An item of `core.table`, or of a type below it, keeps one table of its own, named `table`, whose columns are the item's `columns` property. Every row door under `/items/{id}/tables/table` works for it as for a table a type declares, with those columns.

### `tables/own-table-listed`

When a caller that may read an item of `core.table`, or of a type below it, sends `GET /items/{id}/tables`, the server MUST answer in `data` a table named `table`, labeled `Table`, with its `row_count`, `bytes`, `last_batch` and `changed_at`.

**Tests:** `compliance/table-rows-own.test.ts › lists the table an item keeps, with what it holds`.

### `tables/own-rows-write`

When a caller that may write an item of `core.table`, or of a type below it, sends `POST /items/{id}/tables/table/rows` with operations that all hold under the item's `columns`, the server MUST answer `200` with `results` as `tables/rows-write` answers.

**Tests:** `compliance/table-rows-own.test.ts › writes rows against the item's columns, answering each operation in order`.

### `tables/own-rows-refused`

If an operation of `POST /items/{id}/tables/table/rows` on an item of `core.table`, or of a type below it, sends a value that breaks the item's `columns`, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Tests:** `compliance/table-rows-own.test.ts › refuses a value the item's columns do not take, and writes nothing`.

### `tables/own-rows-refused-none`

When the server refuses a batch under `tables/own-rows-refused`, the server MUST write no row of the batch.

**Tests:** `compliance/table-rows-own.test.ts › refuses a value the item's columns do not take, and writes nothing`.

### `tables/own-rows-read`

When a caller that may read an item of `core.table`, or of a type below it, sends `GET /items/{id}/tables/table/rows` or `GET /items/{id}/tables/table/rows/{row}`, the server MUST answer the rows the item holds, filtered and sorted by the item's `columns`.

**Tests:** `compliance/table-rows-own.test.ts › reads, filters and sorts rows by the item's columns`.

### `tables/own-rows-totals`

When a caller sends `GET /items/{id}/tables/table/totals` for an item of `core.table`, or of a type below it, the server MUST answer in `totals`, for each column of the item's `columns` that names `adds_up`, its total as `tables/totals` answers.

**Tests:** `compliance/table-rows-own.test.ts › totals the columns the item says add up`.

### `tables/own-rows-event`

When a batch changes at least one row of an item of `core.table`, or of a type below it, the server MUST announce one `rows.changed` naming the `table` `table`, as `tables/rows-event` announces.

**Tests:** `compliance/table-rows-own.test.ts › announces a rows.changed for a batch on the table an item keeps`.

### `tables/own-rows-withheld`

When a row of an item of `core.table`, or of a type below it, holds in a column of type `item` the id of an item the reading key may not read, the server MUST answer the row as `tables/rows-item-withheld` does.

**Tests:** `compliance/table-rows-own.test.ts › withholds an item column's id from a key that may not read the item, in a read and an event`.

### `tables/own-rows-event-withheld`

When a `rows.changed` carries a row of an item of `core.table`, or of a type below it, holding in a column of type `item` the id of an item the receiving key may not read, the server MUST send the row as `tables/rows-event-withheld` does.

**Tests:** `compliance/table-rows-own.test.ts › withholds an item column's id from a key that may not read the item, in a read and an event`.

### `tables/own-rows-follow`

When a caller updates the `columns` of an item of `core.table`, or of a type below it, the server MUST judge the next row batch on the item by the updated columns.

**Tests:** `compliance/table-rows-own.test.ts › judges rows by the columns as last updated`.

### `tables/own-rows-kept`

When a key holding `schema.write` removes a column from an item of `core.table`, or of a type below it, or changes a column's `type`, the server MUST keep every row and value the item holds, as `tables/change-forced` does for a type.

**Reason:** a change to the columns never drops what a person made, and a retyped or removed `item` column keeps being withheld from a key that may not read the item it names (`tables/rows-item-origin`).

**Tests:** `compliance/table-rows-own.test.ts › keeps every row and value when a column is removed or retyped, and keeps withholding an item id`.

### `tables/own-delete-constrained`

If `DELETE /types/{id}` without `force=true` names a type that a column of an item of `core.table`, or of a type below it, names in `type_constraints`, then the server MUST answer `409 type_in_use` naming each such column in `details.columns`, as `<item>.table.<column>`, or as `<type>.table.<column>` where the caller may not read the item's type.

**Tests:** `compliance/table-rows-own.test.ts › refuses to delete a type an item's column constrains to unless forced`.

### `tables/own-name-reserved`

If `POST /types` or `PUT /types/{id}` gives a type that is `core.table` or is below it a table named `table`, then the server MUST answer `400 invalid_schema` naming `tables.table`.

**Reason:** an item of such a type keeps its own table under that name.

**Tests:** `compliance/table-rows-own.test.ts › refuses a type below core.table that declares a table named table`.

### `tables/own-name-reserved-below`

If `PUT /types/{id}` would place a type at or below `core.table` while a type below it declares a table named `table`, then the server MUST answer `400 invalid_schema` naming the type's `parent`.

**Reason:** every type below `core.table` keeps its own table under that name, so a type brought there by its ancestor is judged as one registered there is (`tables/own-name-reserved`).

**Tests:** `compliance/table-rows-own.test.ts › refuses a replacement that places a type under core.table while a type below it declares a table named table`.

### `tables/own-columns-reparented`

If `PUT /types/{id}` would place a type at or below `core.table` while an item of it, or of a type below it, holds `columns` that break a rule `tables/own-columns-refused` names other than `tables/item-unregistered` naming a type that is not registered, then the server MUST answer `400 invalid_schema` naming the type's `parent`.

**Reason:** an item there keeps its own table from its `columns` (`tables/own-table-listed`), so they are held to the rules a write of them is.

**Tests:** `compliance/table-rows-own.test.ts › refuses a replacement that places a type under core.table while its items hold columns a table cannot take`, `› takes a type under core.table whose items name an unregistered type in a column, and refuses one whose column has an empty type_constraints`.

### `tables/own-change-in-use`

If `PUT /types/{id}` without `force=true` would leave an item that holds rows in the table it keeps under `tables/own-table-listed` with no table of that name, or with one whose column of the same name has another `type` where a row holds a value, then the server MUST answer `409 type_in_use` naming each in `details.tables`, as `table` or `table.<column>`.

**Reason:** taking a type away from `core.table` hides the rows its items keep, as removing a table a type declares does (`tables/change-in-use`).

**Tests:** `compliance/table-rows-own.test.ts › refuses a replacement that takes a type away from core.table while its items hold rows in the table they keep, unless forced`, `› refuses a replacement that judges rows an item keeps by a table its type declares in their place, unless the column types agree`.

### `tables/own-rows-undo`

When a caller sends `POST /items/{id}/tables/table/batches/{batch}/undo` for an item of `core.table`, or of a type below it, the server MUST undo the batch as `tables/undo` does for a table a type declares, and answer as `tables/undo-answer` does.

**Tests:** `compliance/table-rows-own.test.ts › undoes and redoes a batch on the table an item keeps, and lists its batches`.

### `tables/own-rows-batches`

When a caller that may read an item of `core.table`, or of a type below it, sends `GET /items/{id}/tables/table/batches`, the server MUST answer the batches the table's change log holds as `tables/batches-list` does.

**Tests:** `compliance/table-rows-own.test.ts › undoes and redoes a batch on the table an item keeps, and lists its batches`.

### `tables/own-mcp-get-tables`

When `marfa_get` reads an item of `core.table`, or of a type below it, the server MUST answer under `tables` the table named `table`, as `tables/mcp-get-tables` answers a declared one, with the names of the item's `columns`.

**Tests:** `compliance/table-rows-own.test.ts › lists the table an item keeps with marfa_get, and reads and writes its rows through MCP`.

### `tables/own-mcp-rows`

When `marfa_read_rows` or `marfa_write_rows` names an item of `core.table`, or of a type below it, and the table `table`, the server MUST read or write the rows as `tables/mcp-read-rows` and `tables/mcp-write-rows` state, judged by the item's `columns`.

**Tests:** `compliance/table-rows-own.test.ts › lists the table an item keeps with marfa_get, and reads and writes its rows through MCP`.

### `tables/own-archive-rows`

When `GET /export?format=archive` carries an item of `core.table`, or of a type below it, that holds rows, the server MUST carry in `rows.ndjson.gz` one line for each row, with `table` `table`, as `tables/archive-rows` states.

**Tests:** `compliance/table-own-restore.test.ts › exports and restores the rows of an item of core.table, as unlogged rows that a later write can undo`.

### `tables/own-restore-rows`

When `POST /restore` writes an item of `core.table`, or of a type below it, the server MUST write each of its rows that `rows.ndjson.gz` holds, as `tables/restore-rows` states, and answer the table on `GET /items/{id}/tables` with the `row_count` and `bytes` of the rows written.

**Tests:** `compliance/table-own-restore.test.ts › exports and restores the rows of an item of core.table, as unlogged rows that a later write can undo`.

### `tables/own-restore-rows-unlogged`

When `POST /restore` writes the rows of the table an item of `core.table`, or of a type below it, keeps, the server MUST add no batch to the table's change log, as `tables/restore-rows-unlogged` states.

**Tests:** `compliance/table-own-restore.test.ts › exports and restores the rows of an item of core.table, as unlogged rows that a later write can undo`.

### `tables/own-restore-rows-undo`

When an undo names a batch that changed a row `POST /restore` wrote to the table an item of `core.table`, or of a type below it, keeps, the server MUST put the row back as the restore wrote it, as `tables/restore-rows-undo` states.

**Tests:** `compliance/table-own-restore.test.ts › exports and restores the rows of an item of core.table, as unlogged rows that a later write can undo`.

## Rows in an archive

An archive carries rows in `rows.ndjson.gz`, one line per row. A line is `{ "item_id", "table", "id", "values", "refs"?, "updated_at" }`.

### `tables/archive-rows`

When `GET /export?format=archive` carries an item, the server MUST carry in `rows.ndjson.gz` one line for each row the item holds, in every table that holds a row.

**Reason:** a forced change keeps the rows of a table a type no longer declares (`tables/change-forced`), and a backup is the same archive, so a table the type does not declare now is carried too.

**Tests:** `compliance/table-rows-archive.test.ts › carries each row of a carried item in rows.ndjson.gz, in table and id order, and counts them in row_count`, `› carries a row of a table its type no longer declares, and a value its column no longer takes, and restores both as held`.

### `tables/archive-row-line`

The server MUST write each line of `rows.ndjson.gz` as an object holding the row's `item_id`, `table`, `id`, `values` and `updated_at`.

**Reason:** this is all a row holds. A row has no version, records no time it was created, and carries no batch, because the change log stays out of an archive and a restored batch would name nothing the instance records.

**Tests:** `compliance/table-rows-archive.test.ts › carries a row's item_id, table, id, values and updated_at, and in refs the columns written as an item's id`.

### `tables/archive-row-refs`

When a row holds a value written to a column of type `item` (`tables/rows-item-origin`), the server MUST name that column in the line's `refs`, and leave `refs` out of a line that names none.

**Reason:** a value is withheld by how it was written and not by what its column is now, so a restore needs the mark to keep withholding it.

**Tests:** `compliance/table-rows-archive.test.ts › carries a row's item_id, table, id, values and updated_at, and in refs the columns written as an item's id`.

### `tables/archive-rows-order`

The server MUST write the lines of `rows.ndjson.gz` in ascending order of `item_id`, then `table`, then `id`.

**Reason:** comparing adjacent lines detects repeated or out-of-order rows without holding a table's IDs.

**Tests:** `compliance/table-rows-archive.test.ts › carries each row of a carried item in rows.ndjson.gz, in table and id order, and counts them in row_count`.

### `tables/archive-row-withheld`

When the credential requesting `GET /export?format=archive` may not read a row's value under `tables/rows-item-withheld`, the server MUST carry the row without that value and without naming its column in `refs`.

**Reason:** an archive holds only what its credential may read, as a read of the row does.

**Tests:** `compliance/table-rows-archive.test.ts › leaves out of an archive a value the exporting key may not read, and its mark`.

### `tables/archive-rows-shape-free`

When `GET /export?format=archive` carries a row of a table its item's type does not declare, or a value its column does not take, the server MUST NOT refuse the export for it.

**Reason:** a forced change leaves such rows (`tables/change-forced`), and an instance that held one could not be backed up.

**Tests:** `compliance/table-rows-archive.test.ts › carries a row of a table its type no longer declares, and a value its column no longer takes, and restores both as held`.

### `tables/restore-rows`

When `POST /restore` writes an item, the server MUST write each row that `rows.ndjson.gz` holds for it, with its `table`, `id`, `values` and `updated_at` as the line holds them.

**Tests:** `compliance/table-rows-archive.test.ts › restores each row with its values, refs and updated_at, and the tables' row counts and bytes`.

### `tables/restore-rows-refs`

When `POST /restore` writes a row, the server MUST withhold under `tables/rows-item-origin` each value whose column the line names in `refs`.

**Tests:** `compliance/table-rows-archive.test.ts › restores each row with its values, refs and updated_at, and the tables' row counts and bytes`.

### `tables/restore-rows-shape-free`

When `POST /restore` writes a row, the server MUST NOT refuse it because its item's type does not declare its table, its values name a column the table does not declare, or a value is not one its column takes.

**Reason:** the archive holds rows as the instance it came from held them, and an export carries such rows (`tables/archive-rows-shape-free`).

**Tests:** `compliance/table-rows-archive.test.ts › carries a row of a table its type no longer declares, and a value its column no longer takes, and restores both as held`.

### `tables/restore-rows-summary`

When `POST /restore` writes rows to a table its item's type declares, the server MUST answer that table on `GET /items/{id}/tables` with the `row_count` and `bytes` of the rows written.

**Tests:** `compliance/table-rows-archive.test.ts › restores each row with its values, refs and updated_at, and the tables' row counts and bytes`.

### `tables/restore-rows-event`

When `POST /restore` writes the rows of a table, the server MUST announce them in `rows.changed` events of at most 1000 rows each, each with a batch of its own.

**Reason:** a restored table reaches a device the way a written one does, in batches no larger than a write takes (`tables/rows-batch-limit`).

**Tests:** `compliance/table-rows-archive.test.ts › announces restored rows in rows.changed of at most 1000 rows`.

### `tables/restore-rows-unlogged`

When `POST /restore` writes the rows of a table, the server MUST NOT add a batch to the table's change log.

**Reason:** no one on the instance wrote the rows, so there is no write to take back. The batches a restore announces, and the table's `last_batch` after it, name no batch the log holds, and an undo of one answers `tables/undo-not-found`.

**Tests:** `compliance/table-rows-archive.test.ts › logs no batch for the rows a restore writes, so an undo of its last_batch answers batch_not_found`.

### `tables/restore-rows-undo`

When an undo names a batch that changed a row `POST /restore` wrote, the server MUST put the row back as the restore wrote it.

**Reason:** a restored row stands as no logged batch left it, so a later write over it is undone, and redone, as over any row.

**Tests:** `compliance/table-rows-archive.test.ts › undoes a write over restored rows, putting each back as the restore wrote it`.

### `tables/restore-rows-counts`

When `POST /restore` succeeds, the server MUST answer in `rows_imported` the number of rows it wrote, and in `rows_skipped` the number of rows of items it counted as duplicates.

**Tests:** `compliance/table-rows-archive.test.ts › restores each row with its values, refs and updated_at, and the tables' row counts and bytes`, `› leaves the rows of an item counted as a duplicate as they are, counting the archive's in rows_skipped`.

### `tables/restore-rows-duplicate`

When `POST /restore` counts an item as a duplicate, the server MUST leave the rows the instance holds for it as they are and write none of the archive's.

**Reason:** a restore replaces nothing the instance holds (`search-and-filters/restore-duplicate-kept`).

**Tests:** `compliance/table-rows-archive.test.ts › leaves the rows of an item counted as a duplicate as they are, counting the archive's in rows_skipped`.

### `tables/restore-last-activity`

When `POST /restore` writes an item, the server MUST answer as its `last_activity_at` the later of the `last_activity_at` and the `updated_at` the archive records.

**Reason:** a conversation restored keeps its place in a list by latest activity (`tables/last-activity-sort`), and a restored row is not new activity.

**Tests:** `compliance/table-rows-archive.test.ts › keeps an item's last_activity_at through a restore`.

### `tables/restore-row-item`

If a line of `rows.ndjson.gz` names an `item_id` that no line of `items.ndjson.gz` holds, then the server MUST answer `400 validation_error` naming the line and `item_id`.

**Reason:** a row belongs to its item, and an archive carries the item with it.

**Tests:** `compliance/table-rows-archive.test.ts › refuses a row naming an item the archive does not hold, naming its line, and writes nothing`.

### `tables/restore-row-line`

If a line of `rows.ndjson.gz` is not a JSON object, then the server MUST answer `400 validation_error` naming the line.

**Reason:** a line that is not an object holds no field to name.

**Tests:** `compliance/table-rows-archive.test.ts › refuses a row line that is %s, naming its line, and writes nothing`.

### `tables/restore-row-shape`

If a line of `rows.ndjson.gz` is an object that holds no `table` that `tables/name-grammar` takes, no `id` that is a UUIDv7 in lowercase, no object of `values`, no `updated_at` that is an instant or, where it holds `refs`, anything but an array of distinct columns that each hold an item ID in `values`, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/table-rows-archive.test.ts › refuses a row line whose %s is malformed, naming its line and field, and writes nothing`.

### `tables/restore-row-limit`

If the `values` of a line of `rows.ndjson.gz`, written as JSON, are longer than 65536 bytes, then the server MUST answer `400 validation_error` naming the line and `values`.

**Reason:** no write leaves a row past `tables/rows-row-limit`.

**Tests:** `compliance/table-rows-archive.test.ts › refuses a row over 64 KiB, naming its line`.

### `tables/restore-rows-order`

If a line of `rows.ndjson.gz` does not come after the line before it in the order `tables/archive-rows-order` states, then the server MUST answer `400 validation_error` naming the line.

**Reason:** an export never writes repeated or out-of-order rows. This check does not detect a missing line; `search-and-filters/restore-line-counts` checks the counts.

**Tests:** `compliance/table-rows-archive.test.ts › refuses a row out of order or repeated, naming its line`.

### `tables/backup-rows-change`

The server MUST count a batch that changes rows as a change a backup holds.

**Reason:** a scheduled run skips a backup when nothing it holds has changed (`instance/backup-unchanged`), and rows change without their item.

**Tests:** `compliance/backups.test.ts › takes a scheduled backup after a batch changes rows, and skips one when nothing changed`.

## Searching rows

`GET /search` matches rows as well as items. A hit for a row is still an item: it answers the row's item under `item`, with its `metadata`, `relevance_score` and `snippet_html` as an item hit has them, and names the row under `row` as `{ "table", "id", "column" }`.

### `tables/search-row-hit`

When `GET /search` carries a `q` that a row's searchable columns match, the server MUST answer a hit for that row, apart from any hit for its item's own text.

**Reason:** a person searching for what a message said is looking for the message, so each row that matches is a hit of its own, as an item is.

**Tests:** `compliance/table-rows-search.test.ts › answers a row whose searchable column matches as a hit naming its item, table, row and column`.

### `tables/search-row-named`

The server MUST answer a row hit with the row's item under `item` and, under `row`, the row's table as `table`, its ID as `id` and as `column` the column its excerpt is drawn from.

**Tests:** `compliance/table-rows-search.test.ts › answers a row whose searchable column matches as a hit naming its item, table, row and column`.

### `tables/search-item-unnamed`

The server MUST NOT carry `row` on a hit for an item's own text.

**Tests:** `compliance/table-rows-search.test.ts › answers a row whose searchable column matches as a hit naming its item, table, row and column`.

### `tables/search-row-columns`

The server MUST match a row against the string values of the columns its table marks `searchable` `true`, and against no other column.

**Tests:** `compliance/table-rows-search.test.ts › matches a row by every word across its searchable columns, and never by a column not marked searchable or a value written as an item's id`.

### `tables/search-row-words`

The server MUST match a query against a row by the rules `search-and-filters/search-stem` to `search-and-filters/search-no-word` hold for an item, with the row's searchable columns in place of the item's text.

**Reason:** one query reads the same way against an item and against a row, so every word of it may match in any searchable column of the row.

**Tests:** `compliance/table-rows-search.test.ts › matches a row by every word across its searchable columns, and never by a column not marked searchable or a value written as an item's id`.

### `tables/search-row-reference`

The server MUST NOT match a value that a row holds as an item's ID, whatever the type of its column now is.

**Reason:** such a value is withheld from a key that may not read that item (`tables/rows-item-withheld`), and a column retyped from `item` to text keeps it so (`tables/rows-item-origin`).

**Tests:** `compliance/table-rows-search.test.ts › matches a row by every word across its searchable columns, and never by a column not marked searchable or a value written as an item's id`.

### `tables/search-row-reach`

The server MUST answer a row hit only to a credential that may read the row's item.

**Reason:** reading a row is reading its item (`tables/rows-read-access`).

**Tests:** `compliance/table-rows-search.test.ts › answers a row hit only where the search would answer its item: the key's reach, the search's narrowing and the bin`.

### `tables/search-row-narrowed`

When `GET /search` names a `type`, `state`, `source`, `tags`, `filter`, `include`, `occurred_after`, `occurred_before`, `updated_after` or `updated_before`, the server MUST answer a row hit only where the row's item meets it.

**Tests:** `compliance/table-rows-search.test.ts › answers a row hit only where the search would answer its item: the key's reach, the search's narrowing and the bin`.

### `tables/search-row-bin`

The server MUST NOT match a row of an item in the bin on `GET /search`, whatever `state` the search names.

**Tests:** `compliance/table-rows-search.test.ts › answers a row hit only where the search would answer its item: the key's reach, the search's narrowing and the bin`.

### `tables/search-row-rank`

When `GET /search` names no `sort`, or `sort=relevance`, the server MUST rank a row hit by BM25 over its table's searchable columns at equal weight, with the rows of the items the credential may read as the corpus, in one ranking with the item hits.

**Reason:** a row and an item that match a query are answered in the order of how well each matches, so a page never puts every item before every row.

**Tests:** `compliance/table-rows-search.test.ts › ranks row hits with item hits by BM25, scoring the best hit highest`.

### `tables/search-row-sort`

When `GET /search` names `sort=created_at`, `sort=updated_at`, `sort=occurred_at` or `sort=properties.<field>`, the server MUST order a row hit by its item's value.

**Reason:** a hit for a row is still an item, so it sorts where its item does.

**Tests:** `compliance/table-rows-search.test.ts › orders a sorted search's row hits by their item's value and breaks ties by item, own hit first, then table and row id`.

### `tables/search-row-ties`

When `GET /search` orders hits of one item that tie, the server MUST put the item's own hit first and its row hits after it, by table name and then row ID, ascending.

**Reason:** an unordered tie is two answers to one query (`search-and-filters/search-sort-ties`).

**Tests:** `compliance/table-rows-search.test.ts › orders a sorted search's row hits by their item's value and breaks ties by item, own hit first, then table and row id`.

### `tables/search-row-cursor`

When a client sends back the `next_cursor` of each page of a `GET /search` whose hits include rows, the server MUST continue the ranking, so that walking to `null` delivers every item hit and every row hit once.

**Tests:** `compliance/table-rows-search.test.ts › walks a search whose hits include rows to a null cursor, delivering every hit once`.

### `tables/search-row-depth`

The server MUST count each row hit as one of the 10,000 hits a search reads at most (`search-and-filters/search-depth`).

**Tests:** `compliance/table-rows-search.test.ts › counts row hits toward the depth of a search`.

### `tables/search-row-excerpt`

The server MUST draw a row hit's `snippet_html` from the searchable column with the most matched words in its excerpt, counting each word of a matched phrase, the first by name where two tie, by the rules `search-and-filters/excerpt-words` to `search-and-filters/excerpt-markup` hold for an item's excerpt.

**Tests:** `compliance/table-rows-search.test.ts › excerpts a row hit from its searchable column with the most matched words, marked and escaped`.

### `tables/search-row-written`

When a `put` or a `patch` changes a row's searchable values, the server MUST match the row by its new values, and not by its old ones, from that write's answer on.

**Tests:** `compliance/table-rows-search.test.ts › follows a row's put, patch and delete, an undo, and its item's purge`.

### `tables/search-row-deleted`

When a `delete` removes a row, the server MUST NOT match the row from that write's answer on.

**Tests:** `compliance/table-rows-search.test.ts › follows a row's put, patch and delete, an undo, and its item's purge`.

### `tables/search-row-undone`

When an undo puts a row back, changes it or removes it, the server MUST match the row as the undo left it from the undo's answer on.

**Tests:** `compliance/table-rows-search.test.ts › follows a row's put, patch and delete, an undo, and its item's purge`.

### `tables/search-row-purged`

When the server purges an item, the server MUST NOT match its rows from the purge's answer on.

**Tests:** `compliance/table-rows-search.test.ts › follows a row's put, patch and delete, an undo, and its item's purge`.

### `tables/search-row-restored`

When `POST /restore` writes rows, the server MUST match each by its table's searchable columns from the restore's answer on.

**Tests:** `compliance/table-rows-archive.test.ts › matches the rows a restore writes`, `compliance/table-own-restore.test.ts › finds the rows a restore writes to an item of core.table by the columns the item marks searchable`.

### `tables/search-column-withdrawn`

When a type change, or an update to the `columns` of an item of `core.table` or of a type below it, takes `searchable` from a column, changes its type to one other than `string`, `email` or `url`, removes it or removes its table, the server MUST NOT match a row by that column's values from the change's answer on.

**Reason:** a column a person has taken out of search is out of it at once, however many rows its table holds.

**Tests:** `compliance/table-rows-search.test.ts › follows a change to what a table marks searchable, a column removed, retyped within or away from text, and a table removed`, `› follows a change to the columns an item of core.table keeps`, `› rebuilds a large table's index through table-row-cleanup, matching nothing by a withdrawn column meanwhile`.

### `tables/search-column-retyped-text`

When a type change, or an update to the `columns` of an item of `core.table` or of a type below it, changes a column's type between `string`, `email` and `url` and leaves it `searchable` `true`, the server MUST go on matching the rows of the tables it applies to by that column's values.

**Reason:** the values are text under each of those types, so the column stays in search as its type still says.

**Tests:** `compliance/table-rows-search.test.ts › follows a change to what a table marks searchable, a column removed, retyped within or away from text, and a table removed`, `› follows a change to the columns an item of core.table keeps`.

### `tables/search-column-added`

When a type change, or an update to the `columns` of an item of `core.table` or of a type below it, marks a column `searchable` `true`, the server MUST match the rows of the tables it applies to by that column at the latest once `table-row-cleanup` has run.

**Reason:** a type change rebuilds at most 1,000 rows inline and leaves the remaining tables to paged background work, so other writes do not wait for all affected rows.

**Tests:** `compliance/table-rows-search.test.ts › follows a change to what a table marks searchable, a column removed, retyped within or away from text, and a table removed`, `› follows a change to the columns an item of core.table keeps`, `› rebuilds a large table's index through table-row-cleanup, matching nothing by a withdrawn column meanwhile`.

### `tables/search-rebuilding`

While `table-row-cleanup` has still to rebuild the index of a table after a change to its columns, the server MUST NOT answer a row hit from that table.

**Reason:** until the rebuild ends, the index holds some rows by the old columns and some by the new, and neither answer is what the columns now say.

**Tests:** `compliance/table-rows-search.test.ts › rebuilds a large table's index through table-row-cleanup, matching nothing by a withdrawn column meanwhile`.

### `tables/mcp-find-row`

When `marfa_find` answers a search hit for a row, the server MUST name the row in the entry's `row`, as `GET /search` names it.

**Tests:** `compliance/table-rows-search.test.ts › names the row of a row hit in marfa_find`.

## Linking to a row

A link names a row by `#^` and the row's ID after the item's name, `[[item#^row]]`, as Obsidian names a block. It stays a link to the item, and the row is the one with that ID among the item's tables: a row ID is unique within its table, so where two tables of one item hold the same ID, the link names both. The device's half is `device/link-parts-row` and `device/body-link-row`.
