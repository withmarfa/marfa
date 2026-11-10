# Conversations

What the shipped type `core.conversation` declares, and how its messages, which are rows of a table the type declares, are appended, read and listed. Rows, columns and withholding are the rules of `tables.md`; this chapter holds what is particular to a conversation.

## The type

A conversation is one item. Its messages are the rows of its `messages` table, so a message has no version, tags or edges of its own and never appears among the items. A message you would view on its own, such as an email, stays a `core.message` item.

### `conversations/type`

The server MUST ship `core.conversation` taking `title` as an optional string field, naming `title` its display title, and requiring no field.

**Reason:** a chat app names a conversation after its first message or leaves it unnamed, so a conversation can be created with no properties.

**Tests:** `compliance/conversation.test.ts › ships core.conversation with an optional title`, `› creates a conversation with no properties`.

### `conversations/messages-table`

The server MUST ship `core.conversation` declaring one table, `messages`, with the columns `author`, a required `string`, `text`, a `string` marked `searchable`, `sent_at`, a required `datetime`, and `attachment`, an `item` that admits `core.file`.

**Reason:** `author` is a name, a handle or a role such as `assistant`, so one column serves a chat between people and one with an assistant. `sent_at` is when the message was sent, which differs from the row's `updated_at` for a message imported later or written on a device that was offline. `text` is not required, so a message may be only a picture. `attachment` holds one file, and a second picture is a second message. A message has no other column, so a type that extends `core.conversation` adds its own.

**Tests:** `compliance/conversation.test.ts › declares a messages table with the author, text, sent time and attachment columns`.

## Appending and reading

### `conversations/append-activity`

When a caller appends a message to a conversation with a `put` to its `messages` table, the server MUST move the conversation's `last_activity_at` to a time later than the one it held.

**Reason:** a conversation lists by its latest message, and the append leaves `updated_at` and `version` alone under `tables/rows-leave-item`.

**Tests:** `compliance/conversation.test.ts › appends a message as a row, moving last_activity_at and nothing else of the conversation`.

### `conversations/ids-ascend`

When a batch puts rows that name no `id`, the server MUST give each an `id` that sorts after the `id` of every row it gave an `id` before, in the order the operations came.

**Reason:** the ids are UUIDv7, so reading rows by `id` descending gives the rows appended last first. A writer that imports earlier messages gives each an `id` made from its `sent_at`, which `tables/rows-id-refused` takes.

**Tests:** `compliance/conversation.test.ts › gives each message appended without an id an id after every earlier one`.

### `conversations/latest`

When a caller reads the rows of a conversation's `messages` table with `sort` `id`, `direction` `desc` and a `limit`, the server MUST answer the messages with the greatest `id`s, up to `limit`, greatest first, with a `next_cursor` that continues to the earlier ones.

**Reason:** this is how an app reads the latest messages, 50 at a time, without reading the earlier ones. Reading by `values.sent_at` reads the whole table and is no faster for a long conversation.

**Tests:** `compliance/conversation.test.ts › reads the latest messages first, a page at a time`.

## Listing conversations

### `conversations/list-by-activity`

When a caller sends `GET /items` with `type` `core.conversation`, `sort` `last_activity_at` and `direction` `desc`, the server MUST answer the conversations whose `last_activity_at` is latest first.

**Reason:** an app shows the conversation that last had a message at the top, whichever was created first.

**Tests:** `compliance/conversation.test.ts › lists conversations by the latest message, newest first`.

## Pictures and files

### `conversations/attachment-admits`

When a message names in `attachment` the ID of an item of `core.file` or of a type that descends from it, such as `core.file.image`, the server MUST take the message.

**Tests:** `compliance/conversation.test.ts › takes a message that names an image or any other file`.

### `conversations/attachment-refused`

If a message names in `attachment` the ID of an item that is not a `core.file` or a descendant of it, then the server MUST answer `400 validation_error` naming `operations.<index>.values.attachment`.

**Tests:** `compliance/conversation.test.ts › refuses an attachment that is not a file`.

### `conversations/attachment-withheld`

When a message names in `attachment` the ID of a file the reading key may not read, the server MUST answer the message without `attachment` in `values` and with `attachment` in `withheld`, as `tables/rows-item-withheld` states.

**Reason:** a key that may read the conversation sees the message and never learns the ID of a picture it may not read.

**Tests:** `compliance/conversation.test.ts › withholds the attachment of a message from a key that may not read files, and keeps the message`.
