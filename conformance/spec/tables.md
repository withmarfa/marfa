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

## Rows

An item of a type that declares a table holds rows in it. A row is `{ "id", "values", "updated_at" }`: `id` is a UUIDv7, `values` an object keyed by column name holding the row's values, and `updated_at` when the row last changed. A row has no version, tags, edges or history of its own, and is never an item. The doors are under the item: `GET /items/{id}/tables`, `GET` and `POST /items/{id}/tables/{table}/rows`, `GET /items/{id}/tables/{table}/rows/{row}` and `GET /items/{id}/tables/{table}/totals`.

## Writing rows

`POST /items/{id}/tables/{table}/rows` takes a batch, `{ "operations": [...] }`, for one table of one item. An operation is `{ "op": "put", "id"?, "values" }`, which creates or replaces a whole row, `{ "op": "patch", "id", "values" }`, which sets the columns it names, or `{ "op": "delete", "id" }`. Each refusal below names in `details.operation` the index of the operation it refuses.

### `tables/rows-write`

When a caller sends `POST /items/{id}/tables/{table}/rows` with operations that all hold, the server MUST answer `200` with `results` holding, for each operation in order, the row's `id` and its `outcome`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-put-create`

When a `put` names no `id`, or an `id` no row of the table holds, the server MUST create the row with the values it sends and answer its outcome `created`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`, `› keeps the id a client sends for a new row`.

### `tables/rows-id-minted`

When a `put` names no `id`, the server MUST give the row a new UUIDv7 as its `id`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-id-refused`

If an operation names an `id` that is not a UUIDv7 in lowercase, then the server MUST answer `400 validation_error` naming `operations.<index>.id`.

**Tests:** `compliance/table-rows.test.ts › refuses a row id that is not a UUID and an operation it does not know`.

### `tables/rows-op-refused`

If an operation's `op` is not `put`, `patch` or `delete`, or a `patch` or `delete` names no `id`, then the server MUST answer `400 validation_error` naming the member.

**Tests:** `compliance/table-rows.test.ts › refuses a row id that is not a UUID and an operation it does not know`.

### `tables/rows-put-replace`

When a `put` names the `id` of a row the table holds, the server MUST replace the row's values with those it sends and answer its outcome `replaced`.

**Reason:** a `put` is the whole row, so a column it leaves out is cleared.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-put-repeat`

When a `put` sends exactly the values the row it names holds, the server MUST leave the row as it is and answer its outcome `unchanged`.

**Reason:** a connector sends the same rows again after a lost answer, and the second send changes nothing and announces nothing.

**Tests:** `compliance/table-rows.test.ts › takes a put sent twice as one row, the second unchanged`.

### `tables/rows-patch`

When a `patch` names a row the table holds, the server MUST set each column it names, keep every column it does not name, and answer its outcome `patched`, or `unchanged` where every column it names already held that value.

**Reason:** two writers that change different columns of one row both land.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`, `› patches only the columns it names`.

### `tables/rows-patch-clear`

When a `patch` sends `null` for a column, the server MUST remove the row's value for the column.

**Tests:** `compliance/table-rows.test.ts › patches only the columns it names`.

### `tables/rows-patch-missing`

If a `patch` names a row the table does not hold, then the server MUST answer `404 row_not_found`.

**Tests:** `compliance/table-rows.test.ts › refuses a patch of a row the table does not hold, and writes nothing of its batch`.

### `tables/rows-delete`

When a `delete` names a row the table holds, the server MUST remove the row and answer its outcome `deleted`.

**Tests:** `compliance/table-rows.test.ts › creates, replaces, patches and deletes rows in one batch, answering each in order`.

### `tables/rows-delete-absent`

When a `delete` names a row the table does not hold, the server MUST answer its outcome `absent`.

**Reason:** the row is gone either way, so a repeated delete is acknowledged.

**Tests:** `compliance/table-rows.test.ts › acknowledges a delete of a row the table does not hold`.

### `tables/rows-in-order`

When a batch names one row in more than one operation, the server MUST apply each operation to the row as the operations before it in the batch leave it.

**Tests:** `compliance/table-rows.test.ts › applies operations on one row in the order they are sent`.

### `tables/rows-all-or-none`

If the server refuses any operation of a batch, then the server MUST write none of the batch.

**Tests:** `compliance/table-rows.test.ts › refuses a patch of a row the table does not hold, and writes nothing of its batch`, `› writes nothing of a batch with one bad operation among many`.

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

If a `put` leaves out a column the table declares `required`, or a `patch` sends `null` for one, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Tests:** `compliance/table-rows.test.ts › refuses a value of the wrong kind, a missing required column and an unknown column, naming each`.

### `tables/rows-item-missing`

If a value in a column of type `item` is not the id of an item the writing key may read, outside the bin, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Reason:** a row points at an item that exists when it is written, and a write never learns of an item its key cannot read.

**Tests:** `compliance/table-rows.test.ts › refuses an item column naming an item that does not exist or that the key may not read`.

### `tables/rows-item-constraint`

If a value in a column of type `item` names an item of a type the column's `type_constraints` does not admit, then the server MUST answer `400 validation_error` naming `operations.<index>.values.<column>`.

**Tests:** `compliance/table-rows.test.ts › refuses an item column naming an item of a type its constraints do not admit`.

### `tables/rows-batch-limit`

If a batch holds more than 1000 operations, then the server MUST answer `400 validation_error` naming `operations`.

**Reason:** a batch of 1000 rows of 1 KB each holds the writer for about 10 ms on the server's reference machine, so no other write waits long behind it.

**Tests:** `compliance/table-rows.test.ts › refuses a row over 64 KiB and a batch over 1000 operations`.

### `tables/rows-row-limit`

If an operation's `values`, written as JSON, is longer than 65536 bytes, then the server MUST answer `400 validation_error` naming `operations.<index>.values`.

**Reason:** a row is small; a long text belongs in a file item the row points at.

**Tests:** `compliance/table-rows.test.ts › refuses a row over 64 KiB and a batch over 1000 operations`.

### `tables/rows-batch-answer`

When a batch changes at least one row, the server MUST answer the batch's UUIDv7 in `batch`, and answer `batch` `null` when it changes none.

**Tests:** `compliance/table-rows.test.ts › takes a put sent twice as one row, the second unchanged`.

### `tables/table-not-found`

If a door under `/items/{id}/tables/{table}` names a table the item's type does not declare, then the server MUST answer `404 table_not_found`.

**Tests:** `compliance/table-rows.test.ts › answers table_not_found for a table the type does not declare`.

## Who may read and write rows

### `tables/rows-read-access`

If a key may not read an item, by its type or because no item holds the id, then the server MUST answer each door under `/items/{id}/tables` `404 item_not_found`.

**Reason:** reading a table is reading its item.

**Tests:** `compliance/table-rows.test.ts › reads rows as the item is read, and refuses a key with read but not write`.

### `tables/rows-write-access`

If a key that may read an item's type and not write it sends `POST /items/{id}/tables/{table}/rows`, then the server MUST answer `403 type_not_permitted` and write nothing.

**Tests:** `compliance/table-rows.test.ts › reads rows as the item is read, and refuses a key with read but not write`.

### `tables/rows-bin-read`

When a read under `/items/{id}/tables` names an item in the bin, the server MUST answer `404 item_not_found` with no `details`.

**Reason:** an item in the bin reads as `errors/bin-read` says, and its rows with it.

**Tests:** `compliance/table-rows.test.ts › refuses to read or write the rows of an item in the bin`.

### `tables/rows-bin-write`

When `POST /items/{id}/tables/{table}/rows` names an item in the bin whose type the key may read, the server MUST answer `404 item_not_found` with `details` of exactly `{ "trashed": true }` and write nothing.

**Tests:** `compliance/table-rows.test.ts › refuses to read or write the rows of an item in the bin`.

### `tables/rows-item-withheld`

When a row holds in a column of type `item` the id of an item the reading key may not read, the server MUST answer the row without the column in `values` and with the column named in `withheld`.

**Reason:** the row is the reader's to see, and the item it names is not.

**Tests:** `compliance/table-rows.test.ts › withholds an item column's id from a key that may not read the item, and keeps the row`.

## Reading rows

### `tables/list`

When a caller that may read an item sends `GET /items/{id}/tables`, the server MUST answer in `data` each table the item's type declares, by name, with its `row_count`, `bytes`, `last_batch` and `changed_at`.

**Tests:** `compliance/table-rows-reads.test.ts › lists the tables an item's type declares with what each holds`.

### `tables/rows-page`

When a caller sends `GET /items/{id}/tables/{table}/rows` with no `sort`, the server MUST answer the rows in `data` by `id` ascending, at most `limit` of them, with a `next_cursor` that continues the page while more remain.

**Tests:** `compliance/table-rows-reads.test.ts › pages a table's rows by id, continuing by a signed cursor`.

### `tables/rows-limit`

If `limit` is not a whole number from 1 to 1000, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `compliance/table-rows-reads.test.ts › pages a table's rows by id, continuing by a signed cursor`.

### `tables/rows-cursor`

If a `cursor` was not answered for the same item, table, `filter` and `sort`, then the server MUST answer `400 validation_error` naming `cursor`.

**Tests:** `compliance/table-rows-reads.test.ts › pages a table's rows by id, continuing by a signed cursor`.

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

The server MUST answer `sum` as the sum of the column's values, `average` as their mean, `min` and `max` as the smallest and largest, a `date` or `datetime` value by the instant it names, and `count` as how many rows hold a value, answering `sum` and `count` as `0`, and `average`, `min` and `max` as `null`, over rows that hold none.

**Tests:** `compliance/table-rows-reads.test.ts › totals each column that adds up, over the rows a filter selects`, `› totals nothing as zero or null`.

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

When a batch changes at least one row, the server MUST announce one `rows.changed` naming the `item` by `id`, `type` and `source`, the `table`, the `batch`, the item's `last_activity_at`, and in `rows` each row the batch changed, as `{ "id", "values", "updated_at" }` as the batch left it or `{ "id", "deleted": true }`.

**Reason:** a device applies a batch from one event on the one cursor, without a read.

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

**Tests:** `compliance/table-rows-events.test.ts › announces one rows.changed per batch to a stream and a webhook`.

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

### `tables/delete-constrained`

If `DELETE /types/{id}` without `force=true` names a type that a column's `type_constraints` names, then the server MUST answer `409 type_in_use` naming each such column in `details.columns`, as `<type>.<table>.<column>`.

**Tests:** `compliance/table-rows-lifecycle.test.ts › refuses to delete a type a column constrains to unless forced`.
