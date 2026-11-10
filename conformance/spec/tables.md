# Tables

What a type declares about the tables an item of it can hold: their names, their columns and how a column totals. A table holds rows, and a row is never an item. This chapter also holds how rows are written, read, announced and undone.

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

If a door under `/items/{id}/tables/{table}` names a table the item's type does not declare, then the server MUST answer `404 table_not_found`.

**Tests:** `compliance/table-rows.test.ts › answers table_not_found for a table the type does not declare`, `compliance/table-rows-undo.test.ts › answers table_not_found for an undo once a forced change removed the table`.

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

If a `cursor` was not answered for the same item, table, `filter`, `sort` and `direction`, then the server MUST answer `400 validation_error` naming `cursor`.

**Tests:** `compliance/table-rows-reads.test.ts › pages a table's rows by id, continuing by a signed cursor`, `› refuses a cursor answered for the other direction`.

### `tables/rows-filter`

When `GET /items/{id}/tables/{table}/rows` or `GET /items/{id}/tables/{table}/totals` names a `filter`, the server MUST select the rows it selects under the grammar of `search-and-filters/filter-doors`, reading `values.<column>` as a column and `id` and `updated_at` as the row's own.

**Reason:** a client that filters items filters rows with the same expressions.

**Tests:** `compliance/table-rows-reads.test.ts › filters rows on columns with the item filter grammar`.

### `tables/rows-filter-refused`

If a row `filter` names a column the table does not declare, or a field other than `values.<column>`, `id` and `updated_at`, then the server MUST answer `400 validation_error` naming `filter`.

**Tests:** `compliance/table-rows-reads.test.ts › filters rows on columns with the item filter grammar`.

### `tables/rows-sort`

When `GET /items/{id}/tables/{table}/rows` names `sort` as `id`, `updated_at` or `values.<column>` and `direction` as `asc` or `desc`, the server MUST answer the rows in that order, a row without the column last in either direction and a tie by `id` ascending.

**Tests:** `compliance/table-rows-reads.test.ts › sorts rows on a column, rows without it last`.

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

### `tables/rows-event-copy`

While a stream is a copy stream, the server MUST NOT send it `rows.changed`.

**Reason:** a copy stream feeds a device's working copy, which holds no rows.

**Tests:** `compliance/table-rows-events.test.ts › sends no rows.changed on a copy stream`.

## The change log and undo

A table keeps a change log: each batch that changed at least one of its rows, with each row as it stood before the batch, for `row_log_retention_days`. An undo is itself a batch, so undoing an undo redoes the batch it undid. A row stands as a batch left it while no later batch has changed it, or every later batch that did has been undone, newest first; a row the batch deleted stands as it left it while the table holds no row with its id. The doors are `POST /items/{id}/tables/{table}/batches/{batch}/undo` and `GET /items/{id}/tables/{table}/batches`.

### `tables/undo`

When a caller sends `POST /items/{id}/tables/{table}/batches/{batch}/undo` and every row the batch changed stands as the batch left it or as it was before the batch, the server MUST leave each of those rows as it was before the batch.

**Reason:** a person takes back a write whole, one batch at a time, from the newest.

**Tests:** `compliance/table-rows-undo.test.ts › undoes a batch, putting back rows it replaced, patched and deleted and removing rows it created`, `› undoes a batch where a later batch left a row as it was before the batch`, `› undoes a run of batches newest first, and redoes them oldest first`.

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

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo where a later batch changed a row, naming the rows, and changes nothing`, `› refuses an undo that would put back or replace a value the key may not read, and removes a created row holding one`.

### `tables/undo-values-kept`

When an undo puts back a row's values, the server MUST put them back as they were before the batch, whatever the table's columns declare since.

**Reason:** an undo recovers what a person had, as `tables/change-forced` keeps values the declaration no longer takes.

**Tests:** `compliance/table-rows-undo.test.ts › puts back values in a column the type has since removed`.

### `tables/undo-not-found`

If an undo names a batch that the change log of the item's table does not hold, then the server MUST answer `404 batch_not_found`.

**Reason:** a batch of another table, an id no batch has and a batch past `row_log_retention_days` read alike.

**Tests:** `compliance/table-rows-undo.test.ts › answers batch_not_found for a batch of another table or item, and an id no batch has`, `compliance/table-rows-retention.test.ts › removes the batches older than row_log_retention_days at the next table-row-cleanup run, and keeps the newer`.

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

If an undo would change the value of a column in a row it keeps, where the row holds before or after the undo a value the server would withhold from the undoing key on a read of the row, then the server MUST answer `403 forbidden` with `details.row` naming the row and `details.column` naming the column.

**Reason:** an undo that put the value back or replaced it would write a reference the key cannot see, which `tables/rows-withheld-write` refuses to a write.

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo that would put back or replace a value the key may not read, and removes a created row holding one`.

### `tables/undo-withheld-delete`

When an undo removes a row the undone batch created, the server MUST remove it whatever value it holds that the server would withhold from the undoing key.

**Reason:** removing the row leaves alone the item its value names, as `tables/rows-withheld-delete` allows a delete.

**Tests:** `compliance/table-rows-undo.test.ts › refuses an undo that would put back or replace a value the key may not read, and removes a created row holding one`.

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

Where `row_log_retention_days` is positive, when the `table-row-cleanup` job runs, the server MUST remove from each table's change log every batch made more than that many days before.

**Reason:** the log is for taking back recent writes, not a history, and an old batch could no longer be undone over what came after it anyway.

**Tests:** `compliance/table-rows-retention.test.ts › removes the batches older than row_log_retention_days at the next table-row-cleanup run, and keeps the newer`.

### `tables/log-retention-zero`

Where `row_log_retention_days` is 0, the server MUST NOT remove a batch from a change log by its age.

**Tests:** `compliance/table-rows-retention.test.ts › keeps every batch while row_log_retention_days is 0, however far the clock moves`.

## Rows and the life of an item

### `tables/purge-rows`

When the server purges an item, the server MUST remove its rows through the `table-row-cleanup` housekeeping job, a page at a time.

**Reason:** removing a large table in one statement would hold every other write behind it.

**Tests:** `compliance/table-rows-lifecycle.test.ts › removes a purged item's rows in pages, answering other requests meanwhile`.

### `tables/move-refused`

If `POST /types/{id}/move` or a retype of an item would leave an item in a type that does not declare a table the item holds rows in, then the server MUST answer `409 type_move_blocked` naming those tables in `details.tables`.

**Reason:** a move never drops what a person made.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses a type move and a retype whose target does not declare the tables an item holds`.

### `tables/change-in-use`

If `PUT /types/{id}` without `force=true` would remove a table that holds rows, remove a column that holds a value, or change the `type` of a column that holds a value, then the server MUST answer `409 type_in_use` naming each in `details.tables`, as `<table>` or `<table>.<column>`.

**Reason:** removing what rows hold follows how deleting a type that has items is refused unless forced.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses to remove a table or a column that holds rows unless forced, and keeps the rows when forced`.

### `tables/change-forced`

When `PUT /types/{id}` names `force=true`, the server MUST keep every row and value it would refuse to remove under `tables/change-in-use`, as it is.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses to remove a table or a column that holds rows unless forced, and keeps the rows when forced`.

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
