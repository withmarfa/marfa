# MCP

The MCP endpoint, `/mcp`, serves Marfa's tools to an agent over Streamable HTTP. A request carries an API key or an app's access token as a Bearer credential, and every tool call is a call to the API with that credential. The tools are `marfa_overview`, `marfa_find`, `marfa_get`, `marfa_read_rows`, `marfa_create`, `marfa_update`, `marfa_write_rows` and `marfa_delete`.

Two more endpoints serve the same tools and a group of their own. `/mcp/schema` adds `marfa_save_type`, `marfa_save_view`, `marfa_move_items`, `marfa_bulk_save`, `marfa_search_docs`, `marfa_sources` and `marfa_name_source`, for shaping what the instance holds. `/mcp/admin` adds `marfa_health`, `marfa_audit`, the key and webhook tools, and the owner's tasks that `mcp/tools-for-admin` names, for running it. Unless a statement names an endpoint, it holds at all three.

## Who may call it

The challenges an MCP client signs in and steps up from are stated with the server's other resources, in `keys-and-oauth/mcp-challenge-credential` and `keys-and-oauth/mcp-challenge-scope`.

### `mcp/foreign-origin`

If a request to `/mcp` carries an `Origin` header naming neither the instance's own origin nor an origin the owner approved, then the server MUST answer `403 forbidden`.

**Reason:** a page on another site must not drive the tools with a credential it holds, which the MCP transport asks a server to prevent.

**Tests:** `compliance/mcp.test.ts › refuses a request from an origin the owner did not approve with 403, where the server's own origin is served`.

### `mcp/post-only`

If a `GET` or `DELETE` request reaches an MCP endpoint, then the server MUST answer `405` with an `Allow` header of `POST`.

**Reason:** the endpoint keeps no session and no stream, so there is nothing for either method to open or end, and MCP's transport asks a server that serves no stream from `GET` to say so with `405`.

**Tests:** `compliance/mcp.test.ts › answers a GET or DELETE to an MCP endpoint 405 with Allow POST, to a caller with a credential and to one without`.

## Protocol revisions

### `mcp/stateless-revision-no-initialize`

When a client of MCP revision 2026-07-28 calls `/mcp`, the server MUST serve its discovery and its tool calls without an `initialize` handshake.

**Tests:** `compliance/mcp.test.ts › serves a client of revision 2026-07-28 without an initialize handshake`.

### `mcp/initialize-revision-same-tools`

When a client of MCP revision 2025-11-25 opens with `initialize`, the server MUST serve it the tools it serves a client of revision 2026-07-28 with the same credential.

**Reason:** clients move to a new revision at their own pace.

**Tests:** `compliance/mcp.test.ts › serves a client of revision 2025-11-25 that opens with initialize the same tools`.

### `mcp/no-listen`

When a client calls `subscriptions/listen` on `/mcp`, the server MUST answer in a JSON body, not a stream, with the JSON-RPC error `-32601`.

**Reason:** the endpoint keeps no session and no stream between requests, so a listen held open would only hold a connection.

**Tests:** `compliance/mcp.test.ts › answers subscriptions/listen with method not found and opens no stream`.

## The tools a credential is offered

### `mcp/tools-for-writer`

While a credential's type map grants `write` on at least one type, the server MUST list `marfa_overview`, `marfa_find`, `marfa_get`, `marfa_read_rows`, `marfa_create`, `marfa_update`, `marfa_write_rows` and `marfa_delete` to it.

**Tests:** `compliance/mcp.test.ts › lists the eight tools to a credential that writes a type`.

### `mcp/tools-for-reader`

While a credential's type map grants `read` on at least one type and `write` on none, the server MUST list only `marfa_overview`, `marfa_find`, `marfa_get` and `marfa_read_rows` to it.

**Reason:** a tool the credential can never use costs the agent's context and invites calls that fail.

**Tests:** `compliance/mcp.test.ts › lists only marfa_overview, marfa_find, marfa_get and marfa_read_rows to a credential that only reads`.

### `mcp/tools-for-no-type`

While a credential's type map grants no type, the server MUST NOT declare the `tools` capability to it at `/mcp`.

**Reason:** every tool at `/mcp` reads or writes items, so a credential that reaches no type can use none of them. A group's tool may need only a permission, such as `webhooks.manage` for `marfa_webhooks`, so `/mcp/schema` and `/mcp/admin` offer what `mcp/tools-for-schema` and `mcp/tools-for-admin` say whatever the type map reaches.

**Tests:** `compliance/mcp.test.ts › offers no tools at /mcp to a credential whose type map reaches no type`.

### `mcp/tools-for-schema`

When a credential calls `/mcp/schema`, the server MUST list to it the tools `/mcp` lists it, `marfa_search_docs`, `marfa_sources` and `marfa_name_source`, with `marfa_save_type` while it may register types or holds `schema.write`, `marfa_save_view` while its type map grants `write` on `system.view`, and `marfa_move_items` and `marfa_bulk_save` while its type map grants `write` on at least one type.

**Reason:** a tool the credential can never use costs the agent's context and invites calls that fail.

**Tests:** `compliance/mcp.test.ts › lists the eight tools and every schema tool at /mcp/schema to a credential that may use each`, `› lists only the read tools and the schema tools every credential gets at /mcp/schema to a credential that only reads`, `› lists each schema tool at /mcp/schema to a credential that holds only the one thing it needs`.

### `mcp/tools-for-admin`

When a credential calls `/mcp/admin`, the server MUST list to it the tools `/mcp` lists it, with `marfa_health` while it holds `instance.read` or `connectors.manage`, `marfa_audit` while it holds `audit.read`, `marfa_keys`, `marfa_manage_key` and `marfa_revoke_key` while it holds `keys.mint` or `keys.manage`, `marfa_webhooks` and `marfa_manage_webhook` while it holds `webhooks.manage`, `marfa_settings` and `marfa_change_settings` while it holds `config.manage`, `marfa_trash` and `marfa_purge` while it holds `items.purge`, `marfa_apps` and `marfa_narrow_app` while it holds `grants.manage`, `marfa_backups` and `marfa_take_backup` while it holds `backups.manage`, `marfa_maintain` while it holds `instance.maintain`, `marfa_connectors`, `marfa_make_endpoint`, `marfa_delete_connector` and `marfa_retire_endpoint` while it holds `connectors.manage`, `marfa_files` while it holds `blobs.manage`, and `marfa_sign_ins` and `marfa_rename_sign_in` while it holds `sign_ins.manage`.

**Reason:** a credential that holds a permission can do the owner task it opens through the API, so an agent holding it does the same from MCP, except for the tasks `mcp/tools-withheld` names.

**Tests:** `compliance/mcp.test.ts › lists each admin tool at /mcp/admin only to a credential that holds its permission`, `› lists every admin tool at /mcp/admin to a credential that holds every permission and reaches no type`, `› lists each admin tool at /mcp/admin to a credential that holds only one of the permissions that opens it`.

### `mcp/health-instance-read`

While a credential holds `instance.read`, the server MUST add to the answer of `marfa_health` what needs the owner's attention, the housekeeping jobs, the metrics, the file storage diagnostics, whether a newer server is available, and the status of the bulk job a `job_id` names.

**Reason:** these are the reads `instance.read` opens at the API, so the tool answers what the credential may read there. The settings and their values are read with `marfa_settings`.

**Tests:** `compliance/owner-tasks.test.ts › adds what instance.read opens to the health tool, and only for a credential that holds it`.

### `mcp/health-parts`

If the server cannot read one part of the answer to `marfa_health`, then the server MUST answer every other part it read and name the part it could not read, with its error code, in `unread`.

**Reason:** a bulk job that does not exist, or one part that fails, says nothing about the rest, and a down instance is when health matters most.

**Tests:** `compliance/owner-tasks.test.ts › answers each part of the health tool on its own, so a bulk job it cannot read leaves the others`, `› adds what instance.read opens to the health tool, and only for a credential that holds it`.

### `mcp/connector-runs`

When `marfa_connectors` is called with an `id`, the server MUST answer the connector's runs as `GET /connectors/{id}/runs` lists them.

**Tests:** `compliance/owner-tasks.test.ts › lists a connector with its runs and makes an endpoint for it, refusing as the API does`, `› pages a connector's runs that do not fit one answer, each page continuing where the last stopped`.

### `mcp/connector-metadata-once`

When `marfa_connectors` is called with an `id` and a `runs_cursor`, the server MUST answer the runs without the connector and its endpoints.

**Reason:** the connector and its endpoints are the same on every page, and repeating them on each page spends the room the runs need.

**Tests:** `compliance/owner-tasks.test.ts › answers a connector's metadata with its first page of runs only, so every page of a connector with many declared types stays within the budget`.

### `mcp/connector-types-fit`

If the types a connector declares do not fit the first answer of `marfa_connectors` for its `id`, then the server MUST answer the declared types that fit, in the order the connector holds them, and the number it left out in `read_only_types_left_out`.

**Reason:** a connector may declare a thousand types, and the answer must stay within what a client hands to the model whole; `GET /connectors/{id}` lists every one.

**Tests:** `compliance/owner-tasks.test.ts › answers a connector's metadata with its first page of runs only, so every page of a connector with many declared types stays within the budget`.

### `mcp/page-continues`

When `marfa_trash` or `marfa_connectors` answers a page of rows, the server MUST answer a cursor that continues right after the last row the answer holds if and only if another row follows that row.

**Reason:** an agent reads a long list a page at a time, and a page cut short without its cursor loses the rest of the list.

**Tests:** `compliance/owner-tasks.test.ts › pages a connector's runs that do not fit one answer, each page continuing where the last stopped`, `› pages the trash that does not fit one answer, each page continuing where the last stopped`.

### `mcp/page-fits`

If the rows of a page that `marfa_trash` or `marfa_connectors` answers do not all fit one answer, then the server MUST answer fewer rows, except that a single row that alone exceeds the room is answered alone.

**Reason:** the answer stays within what a client hands to the model whole, and a page always holds a row, so the cursor advances past a row too long to share a page.

**Tests:** `compliance/owner-tasks.test.ts › pages a connector's runs that do not fit one answer, each page continuing where the last stopped`, `› pages the trash that does not fit one answer, each page continuing where the last stopped`.

### `mcp/tools-withheld`

The server MUST NOT list at any MCP endpoint a tool that revokes an app, ends a sign-in, removes a passkey, removes a copy of a file, adopts the backup folder, restores a backup or an archive, exports the instance, claims the instance, recovers or changes the owner's password, adds a passkey or gets the link that adds one, updates the server or confirms the server's clock.

**Reason:** an agent's confirmation of a change that cannot be undone must bind every effect of the change to the state the owner saw, and the confirmations for revoking, ending, removing and adopting do not do that yet. Claiming and password recovery start on the server host, changing the password would put owner credentials in tool arguments, adding a passkey needs a browser, and restoring data remotely needs a recent sign-in. The owner uses the server controls to update the server or confirm its clock and the export API to stream a copy of the instance. Housekeeping stays: `marfa_maintain` may run the trash's retention at once, which removes only the items the owner's retention policy makes eligible and never one an agent chose.

**Tests:** `compliance/mcp.test.ts › lists every admin tool at /mcp/admin to a credential that holds every permission and reaches no type`, `› lists the eight tools and every schema tool at /mcp/schema to a credential that may use each`, `compliance/owner-tasks.test.ts › runs the trash's retention through the maintenance tool, removing only what the retention makes eligible and no chosen item`.

### `mcp/settings-step-up-withheld`

If a `marfa_change_settings` call names `sign_in_address`, `allow_private_addresses`, `object_store_bucket`, `object_store_endpoint`, `object_store_region`, `object_store_path_style`, `object_store_prefix` or `backup_path`, then the server MUST answer the call with the tool error code `app_sign_in_required`.

**Reason:** the owner changes where people sign in, whether the server reaches private addresses and where it keeps files and backups from the command line or after a recent sign-in, never on a key's say-so. A setting that is not one of these changes through the tool as it does through `PATCH /config`.

**Tests:** `compliance/owner-tasks.test.ts › refuses each step-up setting in the settings tool by name and changes nothing, where a setting that is not one changes`.

### `mcp/settings-step-up-unchanged`

If a `marfa_change_settings` call names a setting that `mcp/settings-step-up-withheld` lists, then the server MUST NOT change any setting.

**Tests:** `compliance/owner-tasks.test.ts › refuses each step-up setting in the settings tool by name and changes nothing, where a setting that is not one changes`.

### `mcp/open-world-hint`

When the server lists its tools, the server MUST annotate `marfa_create`, `marfa_manage_webhook`, `marfa_take_backup`, `marfa_maintain` and `marfa_change_settings` with `openWorldHint` `true` and every other tool with `openWorldHint` `false`.

**Reason:** `marfa_create` fetches a file from a web address the agent gives it, `marfa_manage_webhook` has the instance send events to one, `marfa_take_backup` can upload a backup to an object store, `marfa_maintain` can send the heartbeat, and `marfa_change_settings` can set where errors are sent; a client asks the person differently before a tool that reaches outside the instance.

**Tests:** `compliance/mcp.test.ts › marks marfa_create as reaching outside the instance and no other tool`, `› marks each tool that can send something outside the instance as reaching outside it, and no other tool`.

## Calling a tool

### `mcp/api-rules`

When a tool call reads or writes, the server MUST apply the permissions, refusals and limits of the API operation that read or write is.

**Reason:** a tool is another door to what the API guards, so a credential the API refuses is refused by the tool with the same `code`, and no tool is a way round a rule the API holds. A tool the server does not list to a credential is not called at all (`mcp/unlisted-tool`).

**Tests:** `compliance/mcp.test.ts › refuses marfa_create for a type the credential only reads, as POST /items does`, `› refuses a change that needs schema.write at /mcp/schema, as PUT /types/{id} does`, `› refuses marfa_revoke_key for a key beyond its credential's reach, as DELETE /keys/{id} does`, `compliance/owner-tasks.test.ts › refuses a setting that does not exist in the settings tool, as the API does`, `› lists only the bin's items of the types a credential reads in the trash tool, as the API does`, `› refuses a search longer than the API takes in the trash tool, with the API's code`, `› refuses an app task the API refuses, with the API's code`, `› refuses a sign-in or passkey task the API refuses, with the API's code`, `› lists a connector with its runs and makes an endpoint for it, refusing as the API does`, `› runs housekeeping and cancels a job through the maintenance tool, refusing as the API does`.

### `mcp/unlisted-tool`

If a credential calls a tool that the endpoint does not list to it, then the server MUST answer the JSON-RPC error `-32602` with the message `Unknown tool:` and the tool's name.

**Reason:** a credential learns of a tool only from the list it is given, so a tool outside that list does not exist for it, and the answer says nothing of which permission would open it.

**Tests:** `compliance/mcp.test.ts › answers Unknown tool to a call of an admin tool the credential is not offered, where a credential offered it runs it`.

### `mcp/unknown-argument`

If a tool call names an argument the tool does not take, then the server MUST answer the call with a tool error that names the argument.

**Reason:** a misspelled filter that is dropped answers the whole set.

**Tests:** `compliance/mcp.test.ts › refuses a tool call naming an argument the tool does not take`.

### `mcp/write-audited`

When a tool call writes, the server MUST record on the write's audit entry the credential as `key_id`, the address the MCP request came from as `client_ip`, and `via: "mcp"` in `details`.

**Reason:** a tool call reaches the API inside the server, so without this the entry would name the server's own address, or its proxy's, and could not be told from a write the credential made directly.

**Tests:** `compliance/mcp-scripted.test.ts › records a tool call's write with the caller's address and marks it as made through MCP`, `compliance/table-rows-mcp.test.ts › records a rows write made through MCP with the caller's key and address and via mcp`.

### `mcp/find-query-bound`

If a `marfa_find` call names a `query` that `GET /search` refuses for its length or its number of distinct words (`search-and-filters/search-q-length`, `search-and-filters/search-q-words`), then the server MUST answer the call with a tool error carrying `validation_error`.

**Reason:** the bound is held after the text is trimmed and repeated words are dropped, as at `GET /search`, so the tool's input schema carries no length of its own, which would refuse what that door takes.

**Tests:** `compliance/search-bounds.test.ts › refuses a marfa_find query past the bound, and takes one at it`, `› counts what marfa_find is given as the server does, after trimming and dropping repeats`.

### `mcp/find-tags-bound`

If a `marfa_find` call names `tags` that `GET /items` refuses for their number or a tag's length (`search-and-filters/tags-count`, `search-and-filters/tags-length`), then the server MUST answer the call with a tool error carrying `validation_error`.

**Reason:** the bound is held after tags are trimmed and repeats and blank entries are dropped, as at `GET /items`, so the tool's input schema carries no count or length of its own, which would refuse what that door takes.

**Tests:** `compliance/search-bounds.test.ts › refuses marfa_find tags past the bound, and takes them at it`, `› counts what marfa_find is given as the server does, after trimming and dropping repeats`.

### `mcp/find-next-cursor`

If more items match a `marfa_find` call than it returns, then the server MUST answer a `next_cursor` that, sent as `cursor` in the same call, returns the items after those answered.

**Tests:** `compliance/mcp.test.ts › names a next_cursor that reads the rest and a hint, and none of either once nothing is left`.

### `mcp/find-hint`

If more items match a `marfa_find` call than it returns, then the server MUST answer a `hint` that says more items match, how to narrow the call and how to read the next page.

**Reason:** an agent that reads a short answer as the whole answer reports a part as the whole.

**Tests:** `compliance/mcp.test.ts › names a next_cursor that reads the rest and a hint, and none of either once nothing is left`.

## Reading items

`marfa_get` keeps its answer short enough for a client to hand to the model whole, and says where to read what it left out.

### `mcp/get-budget`

When `marfa_get` answers, the server MUST keep the answer's text within 40,000 characters.

**Reason:** a client cuts or drops a tool answer past its own limit, and the agent loses what the answer held.

**Tests:** `compliance/mcp.test.ts › cuts a long text field to fit the answer and reads the rest by offset`, `› leaves out a large list field, names it as cut and reads it back as JSON text`, `› leaves out the items that do not fit and names them`.

### `mcp/get-cut`

If the items `marfa_get` reads do not fit within 40,000 characters, then the server MUST cut the longest fields, and name each cut field in `cut` with the item's `id`, the `field` and the `next_offset` to read from.

**Tests:** `compliance/mcp.test.ts › cuts a long text field to fit the answer and reads the rest by offset`, `› leaves out a large list field, names it as cut and reads it back as JSON text`.

### `mcp/get-field-part`

When `marfa_get` names one ID, a `field` and an `offset`, the server MUST answer the field's text from that offset, or the JSON text of a value that is not text, with the `next_offset` to read from, or `null` when nothing is left.

**Tests:** `compliance/mcp.test.ts › cuts a long text field to fit the answer and reads the rest by offset`, `› leaves out a large list field, names it as cut and reads it back as JSON text`.

### `mcp/get-not-returned`

If the items `marfa_get` reads do not fit within 40,000 characters with every field cut, then the server MUST leave out the last items and name them in `not_returned`.

**Tests:** `compliance/mcp.test.ts › leaves out the items that do not fit and names them`.

## Changing an item

`marfa_update` changes an item only from the version the agent read: unlike `PATCH /items/{id}`, it never merges a stale write (`versions.md`).

### `mcp/update-stale-answer`

If a `marfa_update` call names a version other than the item's current version, then the server MUST answer a tool error with code `version_conflict` that carries the item as it is now in `current`.

**Tests:** `compliance/mcp.test.ts › answers a stale version with version_conflict, the item as it is now and the fields changed since`.

### `mcp/update-stale-fields`

If a `marfa_update` call names a version other than the item's current version, and the credential can read the item's snapshot of the version named, then the server MUST answer under `conflicting_fields` each field the call would set or clear that a write since that version also changed, and no other.

**Reason:** the agent decides from these whether its change still applies.

**Tests:** `compliance/mcp.test.ts › answers a stale version with version_conflict, the item as it is now and the fields changed since`.

### `mcp/update-stale-unchanged`

If a `marfa_update` call names a version other than the item's current version, then the server MUST NOT change the item's fields, tags, edges or state, whether or not the fields it would set collide with a change made since.

**Reason:** the agent decided on the item it read, so a change made since may make its own wrong.

**Tests:** `compliance/mcp.test.ts › leaves the item unchanged when called with a stale version`.

### `mcp/update-changed-mid-call`

If the item changes after a `marfa_update` call reads it and before one of the call's writes, then the server MUST refuse that write and every later one, and answer a tool error with code `version_conflict` that names the refused step in `failed_step` and the steps already written in `applied`.

**Reason:** each write names the version the call read or the one its own previous write left, so the agent's change never lands on a change it has not seen.

**Tests:** `compliance/mcp-scripted.test.ts › tags nothing when the item changes between the call's read and its tag write`.

## Deleting items

`marfa_delete` moves items to the trash in two calls: a preview that names everything the trash would take, with a `confirm` token, and a call with that token.

### `mcp/delete-preview`

When `marfa_delete` is called without `confirm`, the server MUST NOT move any item to the trash.

**Tests:** `compliance/mcp.test.ts › trashes nothing when called without a confirmation`.

### `mcp/delete-confirmed`

When `marfa_delete` is called with the `confirm` token its preview of the same IDs gave, by the same credential, within five minutes, while the items the key can read that it would trash and their versions are unchanged, the server MUST move the named items, and what their trash takes, to the trash.

**Tests:** `compliance/mcp.test.ts › trashes the items with the confirmation the preview gave`.

### `mcp/delete-atomic`

If `marfa_delete`, called with a `confirm` token that holds, fails after it has begun to move items, then the server MUST leave every item the call named, and every item their trash would take, as it was.

**Reason:** `marfa_delete` shares its trash with `POST /items/trash` (`items/trash-several-atomic`), and a person who agreed to a count must not find part of it done.

**Tests:** `compliance/mcp-scripted.test.ts › leaves every item as it was when the confirmed trash fails, and trashes them all without the fault`.

### `mcp/delete-total`

When `marfa_delete` answers, the server MUST answer under `total` how many items the key can read the trash moves, counting once an item that more than one named item would take.

**Reason:** the person agrees to a number, and two named items can share an item beneath them.

**Tests:** `compliance/mcp.test.ts › trashes every named item and an item they share, counting it once`.

### `mcp/delete-plan-changed`

If the items the key can read that a `marfa_delete` call would trash, or their versions, changed since the preview that gave its `confirm` token, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** the person agreed to what the preview showed, not to what the trash would take now.

**Tests:** `compliance/mcp.test.ts › refuses a confirmation when what would be trashed changed since the preview`, `› refuses a confirmation when an item past the preview's list changed`.

### `mcp/delete-plan-changed-after-check`

If the items the key can read that trashing the named items would take, or their versions, change after a `marfa_delete` call checks its `confirm` token and before the trash commits, then the server MUST move no item to the trash and answer the tool error code `trash_plan_changed`.

**Reason:** the token is checked against a fresh preview, and the trash then names that preview's digest (`items/trash-digest-changed`), so the check and the trash are one step.

**Tests:** `compliance/mcp-scripted.test.ts › trashes none of the items when a child joins one of them between the confirmation's check and the trash`.

### `mcp/delete-other-credential`

If a `marfa_delete` call carries a `confirm` token a preview gave another credential, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp.test.ts › refuses a confirmation another credential got`.

### `mcp/delete-expired`

If a `marfa_delete` call carries a `confirm` token from a preview more than five minutes earlier, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp-scripted.test.ts › refuses a confirmation once five minutes have passed since the preview`.

### `mcp/delete-single-use`

If a `marfa_delete` call carries a `confirm` token that an earlier call already used, then the server MUST NOT move any item to the trash on it.

**Reason:** a person agreed once. The server records a used token until it expires, in the transaction that moved the items, so a retry, a replay or a second client holding the token cannot trash again what was restored in between.

**Tests:** `compliance/mcp-single-use.test.ts › moves nothing to the trash again on a confirmation an earlier call used`.

### `mcp/delete-repeated`

When a `marfa_delete` call carries a `confirm` token that an earlier call used to move the same IDs to the trash, by the same credential, the server MUST answer `already_trashed` as `true` and the `total` that call moved.

**Reason:** a client that did not see the first answer, such as one that timed out, learns that the change landed.

**Tests:** `compliance/mcp-single-use.test.ts › says a repeated confirmation already moved the items to the trash`.

## Purging items

`marfa_purge` purges items from the trash in two calls: a preview, of the IDs it names or of one page of the trash, that answers the IDs to confirm and everything the purge would take, with a `confirm` token, and a call that sends those IDs with that token. The purge takes the walk of `POST /items/{id}/purge` from all the named items at once: each item's edges, and each part that went to the trash with its hosts once the walk takes every one of them.

### `mcp/purge-destructive`

When the server lists `marfa_purge`, the server MUST annotate it with `destructiveHint` `true` and `readOnlyHint` `false`.

**Reason:** a purge cannot be undone, and a client asks the person differently before a tool that destroys data.

**Tests:** `compliance/mcp.test.ts › marks narrowing an app, purging, deleting a connector, retiring an endpoint and the maintenance tool as destructive, the other owner-task changes as not, and each listing tool as read-only`.

### `mcp/purge-preview`

When `marfa_purge` is called without `confirm`, the server MUST NOT purge any item.

**Tests:** `compliance/mcp-purge.test.ts › purges nothing when called without a confirmation`.

### `mcp/purge-confirmed`

When `marfa_purge` is called with the `confirm` token its preview of the same IDs gave, by the same credential, within five minutes, while the walk takes the items and edges the preview's walk took, each at the version the preview read and each item holding what the preview read, the server MUST purge those items and edges and no others.

**Tests:** `compliance/mcp-purge.test.ts › purges the named items, everything their walk takes and what they hold with the confirmation the preview gave`, `› purges a part shared by two named hosts with them, where naming one host leaves it`.

### `mcp/purge-walk-once`

When `marfa_purge` names more than one item, the server MUST take each part that went to the trash with its hosts and whose every host is a named item or another item the walk takes.

**Reason:** a part shared by two hosts goes only with its last host, so purging the hosts one by one would leave it behind.

**Tests:** `compliance/mcp-purge.test.ts › purges a part shared by two named hosts with them, where naming one host leaves it`.

### `mcp/purge-preview-shows`

When `marfa_purge` previews, the server MUST answer under `items` each item the purge would take that the key can read, with its `id`, `type`, `title` and `version`, or, where they do not fit one answer, as many as fit and under `left_out` the number it left out, under `edges` the number of edges it would take that the key can read, under `hidden` the number of items and of edges it would take that the key cannot read, and under `total` the number of items it would take.

**Reason:** the person agrees to everything the purge takes, and an item or edge the key cannot read is counted without being named. An agent that reads a short list as the whole purge agrees to less than it confirms.

**Tests:** `compliance/mcp-purge.test.ts › purges the named items, everything their walk takes and what they hold with the confirmation the preview gave`, `› counts an item and an edge the key cannot read as hidden, and refuses the confirmation once the hidden item leaves the trash`, `› names as many items as fit one answer and how many it left out`.

### `mcp/purge-preview-goes-with`

When `marfa_purge` previews, the server MUST answer under `goes_with` how many earlier versions, tags, extensions, table rows and connector agreements the items the key can read hold.

**Reason:** a purge also deletes what an item holds, which no restore brings back.

**Tests:** `compliance/mcp-purge.test.ts › purges the named items, everything their walk takes and what they hold with the confirmation the preview gave`.

### `mcp/purge-changed`

If an item or edge the preview's walk took, or one the walk takes now, is not at the version the preview read, or an item the walk takes does not hold what the preview read, and every item the call names is still in the trash and the walk from them takes at most 1,000 items, then the server MUST refuse the `marfa_purge` call with the tool error code `confirmation_stale` and a new preview of the same IDs with a `confirm` token of its own.

**Reason:** the person agreed to what the preview showed, not to what the purge would take now.

**Tests:** `compliance/mcp-purge.test.ts › refuses a confirmation when a named item changed since the preview, with a new preview`, `› counts an item and an edge the key cannot read as hidden, and refuses the confirmation once the hidden item leaves the trash`, `› refuses a confirmation when a tag, an extension or a table row was added while the item was out of the trash, though its version did not move`, `› refuses a confirmation when a connector wrote an agreement on the item while it was in the trash`.

### `mcp/purge-binds-held`

If the tags or their order, the extensions, the tables or the connector agreements of an item the walk of a `marfa_purge` call takes differ, other than in a time, from what the preview that gave the call's `confirm` token read, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** a purge deletes what an item holds, and each of these can change without moving the item's version, such as while the item is out of the trash between the calls, or when a connector writes an agreement on an item in the trash. Only content is bound, never a time, so a time a running system rewrites does not make the token stale.

**Tests:** `compliance/mcp-purge.test.ts › refuses a confirmation when a tag, an extension or a table row was added while the item was out of the trash, though its version did not move`, `› refuses a confirmation when a connector wrote an agreement on the item while it was in the trash`.

### `mcp/purge-changed-hidden`

If an item or edge the key cannot read changed since the preview in a way that changes what the walk takes or the version it stands at, then the server MUST refuse the `marfa_purge` call with the tool error code `confirmation_stale`.

**Reason:** the confirmation covers every item and edge the purge deletes, including those the agent was only told the number of.

**Tests:** `compliance/mcp-purge.test.ts › counts an item and an edge the key cannot read as hidden, and refuses the confirmation once the hidden item leaves the trash`.

### `mcp/purge-gone`

If an item a `marfa_purge` call names with a `confirm` token is no longer in the trash, then the server MUST refuse the call with the tool error code `confirmation_stale` and purge none of the items it names.

**Reason:** the call answers the confirmation it was sent with, so it names no item as missing, and a person who agreed to a set must not find part of it done.

**Tests:** `compliance/mcp-purge.test.ts › refuses a confirmation when a named item is gone, and purges nothing else it names`.

### `mcp/purge-other-credential`

If a `marfa_purge` call carries a `confirm` token a preview gave another credential, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp-purge.test.ts › refuses a confirmation another credential got`.

### `mcp/purge-expired`

If a `marfa_purge` call carries a `confirm` token from a preview more than five minutes earlier, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp-purge.test.ts › refuses a confirmation once five minutes have passed since the preview`.

### `mcp/purge-token-first`

If a `marfa_purge` call carries a `confirm` token that another credential got, that expired, or that a preview of other IDs gave, then the server MUST answer `confirmation_stale` without a new preview, whatever the call's IDs name.

**Reason:** the server judges the token before it reads the IDs, so a token that does not hold tells the caller nothing about them.

**Tests:** `compliance/mcp-purge.test.ts › refuses a confirmation sent with ids its preview did not name before reading them`, `› refuses a confirmation once five minutes have passed since the preview`, `› refuses a confirmation another credential got`.

### `mcp/purge-atomic`

If a `marfa_purge` call, with a `confirm` token that holds, fails after it has begun to purge, then the server MUST leave every item and edge the purge would take as it was.

**Reason:** a person who agreed to a purge must not find part of it done.

**Tests:** `compliance/mcp-purge.test.ts › leaves every item and the confirmation as they were when the confirmed purge fails, and purges them all without the fault`.

### `mcp/purge-spent-on-commit`

If a `marfa_purge` call fails before its purge commits, then the server MUST purge on the same `confirm` token when it is sent again within five minutes.

**Reason:** a token is recorded as used in the transaction of the purge it allowed, so a purge that never happened does not use it up.

**Tests:** `compliance/mcp-purge.test.ts › leaves every item and the confirmation as they were when the confirmed purge fails, and purges them all without the fault`.

### `mcp/purge-single-use`

If a `marfa_purge` call carries a `confirm` token that an earlier call already used, then the server MUST NOT purge any item on it.

**Tests:** `compliance/mcp-purge.test.ts › purges nothing more on a confirmation an earlier call used, and says it already purged the items`.

### `mcp/purge-repeated`

When a `marfa_purge` call carries a `confirm` token that an earlier call by the same credential used to purge the same IDs, within five minutes of the preview, the server MUST answer `already_purged` as `true` and under `purged` the number of items that call purged.

**Reason:** a client that did not see the first answer, such as one that timed out, learns that the purge landed.

**Tests:** `compliance/mcp-purge.test.ts › purges nothing more on a confirmation an earlier call used, and says it already purged the items`.

### `mcp/purge-remaining`

When a `marfa_purge` call purges, or answers `already_purged`, the server MUST answer under `trash_remaining` the number of items in the trash that `marfa_trash` lists to the key.

**Tests:** `compliance/mcp-purge.test.ts › purges the named items, everything their walk takes and what they hold with the confirmation the preview gave`, `› previews a page of the trash from a trash cursor and purges it on the ids the preview returned`, `› purges nothing more on a confirmation an earlier call used, and says it already purged the items`.

### `mcp/purge-page`

When `marfa_purge` is called with `page`, the server MUST answer under `ids` the IDs of at most 200 items, the next that `marfa_trash` lists after the page's `cursor`, or from the first item without one, and under `next_cursor` a cursor that continues after them if and only if another item follows.

**Reason:** an agent empties the trash a page at a time, from where `marfa_trash` or the last preview stopped.

**Tests:** `compliance/mcp-purge.test.ts › previews a page of the trash from a trash cursor and purges it on the ids the preview returned`.

### `mcp/purge-page-confirm`

If a `marfa_purge` call carries `page` and `confirm`, then the server MUST answer the tool error code `validation_error`.

**Reason:** a page's items change as the trash does, so the confirming call names the IDs the preview answered.

**Tests:** `compliance/mcp-purge.test.ts › previews a page of the trash from a trash cursor and purges it on the ids the preview returned`.

### `mcp/purge-page-empty`

When `marfa_purge` previews a page of the trash that holds no item, the server MUST answer an empty `ids` without a `confirm` token.

**Tests:** `compliance/mcp-purge.test.ts › answers an empty page of the trash with no confirmation`.

### `mcp/purge-cap`

The server MUST NOT purge more than 1,000 items in one `marfa_purge` call.

**Reason:** one purge takes its whole walk in one write, which holds other writes until it commits, and no request holds up the others for long.

**Tests:** `compliance/mcp-purge.test.ts › refuses to preview ids whose walk takes more than 1,000 items, and previews a walk of 1,000`, `› refuses a confirmation whose walk grew past 1,000 items since the preview, and purges nothing`.

### `mcp/purge-cap-grew`

If the walk of a `marfa_purge` call with `confirm` takes more than 1,000 items, then the server MUST refuse the call with the tool error code `confirmation_stale` and no `confirm` token.

**Reason:** the walk grew past what one call can take since the preview, so no new preview of the same IDs can be confirmed.

**Tests:** `compliance/mcp-purge.test.ts › refuses a confirmation whose walk grew past 1,000 items since the preview, and purges nothing`.

### `mcp/purge-cap-preview`

If the walk from the IDs a `marfa_purge` call without `confirm` names would take more than 1,000 items, then the server MUST refuse the call with the tool error code `bulk_cap_exceeded`.

**Reason:** a preview gives a token only for a purge one call can take, so the agent names fewer IDs, or some of the parts on their own first.

**Tests:** `compliance/mcp-purge.test.ts › refuses to preview ids whose walk takes more than 1,000 items, and previews a walk of 1,000`.

### `mcp/purge-page-fits`

If the walk from a `marfa_purge` page would take more than 1,000 items, then the server MUST answer under `ids` the longest run of the page's first items whose walk takes at most 1,000 items, and under `next_cursor` a cursor that continues after them.

**Reason:** an agent that empties the trash a page at a time keeps going with a smaller page, rather than stopping at a page it cannot purge.

**Tests:** `compliance/mcp-purge.test.ts › previews a smaller page when a page's walk takes more than 1,000 items, and refuses a page whose first item alone does`.

### `mcp/purge-page-first-over`

If the walk from the first item of a `marfa_purge` page alone would take more than 1,000 items, then the server MUST refuse the call with the tool error code `bulk_cap_exceeded`.

**Tests:** `compliance/mcp-purge.test.ts › previews a smaller page when a page's walk takes more than 1,000 items, and refuses a page whose first item alone does`.

## Deleting a connector and clearing its state

`marfa_delete_connector` deletes a connector's registration, as `DELETE /connectors/{id}` does, or with `part` `state` clears its source's state, problems and agreements, as `DELETE /connectors/{id}/state` does, in two calls: a preview with a `confirm` token, and a call that sends the same `id` and `part` with that token. The statements under "A confirmation of a connector's change" hold for it too.

### `mcp/connector-delete-preview`

When `marfa_delete_connector` is called without `confirm`, the server MUST NOT change the registration, its runs, its source's endpoints and deliveries, or its source's state, problems and agreements.

**Tests:** `compliance/mcp-connector-acts.test.ts › deletes nothing when called without a confirmation, and previews what goes and what stays`, `› clears nothing without a confirmation, and clears the state, problems and agreements with the one the preview gave`.

### `mcp/connector-delete-preview-shows`

When `marfa_delete_connector` previews deleting a registration, the server MUST answer under `connector` its `id`, `name`, `description`, `source`, `key_id` and the leading `read_only_types` that fit the answer, with `read_only_types_left_out` counting the rest when any are left out, under `current` whether it is its source's current registration, under `goes_with` the number of its runs and, for the current registration, the source's endpoints and the number of its unhandled and of its handled deliveries, and under `stays` whether the source has state and the number of its agreements.

**Reason:** the person agrees to everything the delete removes, and is told what outlives it. Deleting the registration ends the read-only hold it puts on items of its declared types (`items/read-only-true`).

**Tests:** `compliance/mcp-connector-acts.test.ts › deletes nothing when called without a confirmation, and previews what goes and what stays`, `› refuses a confirmation once another registration took the source since the preview, and keeps the source's endpoints and deliveries when the old registration goes`, `› previews the registration's description and declared read-only types, counting those the answer leaves out`.

### `mcp/connector-delete-confirmed`

When `marfa_delete_connector` is called without `part` and with the `confirm` token its preview gave, by the same credential, within five minutes, while the registration, whether it is current and, for the current registration, the source's endpoints and the set of its unhandled deliveries stand as the preview read them, the server MUST delete the registration as `DELETE /connectors/{id}` does and answer `deleted` as `true`.

**Tests:** `compliance/mcp-connector-acts.test.ts › deletes the registration, its runs, endpoints and deliveries with the confirmation the preview gave, and keeps the source's state and agreements`.

### `mcp/connector-delete-runs`

When `marfa_delete_connector` deletes a registration, the server MUST answer under `runs` the number of runs that went with it.

**Tests:** `compliance/mcp-connector-acts.test.ts › deletes the registration, its runs, endpoints and deliveries with the confirmation the preview gave, and keeps the source's state and agreements`, `› deletes on a confirmation after the connector sent heartbeats, reported runs and registered again unchanged`.

### `mcp/connector-delete-keeps-state`

When `marfa_delete_connector` deletes a registration, the server MUST keep its source's state, problems and agreements.

**Reason:** they belong to the source, so a connector that registers again for it carries on where it stopped; `part` `state` clears them.

**Tests:** `compliance/mcp-connector-acts.test.ts › deletes the registration, its runs, endpoints and deliveries with the confirmation the preview gave, and keeps the source's state and agreements`.

### `mcp/connector-delete-old-registration`

When `marfa_delete_connector` deletes a registration that is not its source's current one, the server MUST keep the source's endpoints and deliveries.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation once another registration took the source since the preview, and keeps the source's endpoints and deliveries when the old registration goes`.

### `mcp/connector-delete-activity-unbound`

When the connector only sent heartbeats, took its hold, reported runs, received deliveries and marked them handled, or registered again with the same name, description and declared types between a preview of deleting its registration and the confirmation, the server MUST delete the registration on the confirmation.

**Reason:** a running connector does all of these every few minutes, so a confirmation bound to them would rarely hold. The preview's numbers of runs and of handled deliveries are counted when it is read, and the delete removes all there are when it happens.

**Tests:** `compliance/mcp-connector-acts.test.ts › deletes on a confirmation after the connector sent heartbeats, reported runs and registered again unchanged`, `› deletes on a confirmation after a delivery arrived and was marked handled since the preview, removing the handled delivery the preview did not count`.

### `mcp/connector-delete-changed-registration`

If the registration's name, description or declared types, or whether it is its source's current registration, changed since a `marfa_delete_connector` preview, then the server MUST refuse the call that confirms it with the tool error code `confirmation_stale` and a new preview with a `confirm` token of its own.

**Reason:** the person agreed to delete what the preview showed, and whether the registration is current decides whether the source's endpoints and deliveries go with it.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation once the registration changed since the preview`, `› refuses a confirmation once another registration took the source since the preview, and keeps the source's endpoints and deliveries when the old registration goes`.

### `mcp/connector-delete-changed-inbound`

If an endpoint was made or retired, or the set of the source's deliveries that are not handled changed (a delivery arrived and is not handled, or one the preview counted as not handled was marked handled or removed), under a source's current registration since a `marfa_delete_connector` preview of deleting it, then the server MUST refuse the call that confirms it with the tool error code `confirmation_stale` and a new preview with a `confirm` token of its own.

**Reason:** deleting the current registration removes the source's endpoints and every delivery a connector has not handled yet, so the confirmation covers each of them.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation once a delivery arrived or was marked handled since the preview, with a new preview`, `› refuses a confirmation once an endpoint was made or retired since the preview`.

### `mcp/connector-state-preview-shows`

When `marfa_delete_connector` previews clearing a state, the server MUST answer under `connector` the registration's `id`, `name`, `source` and `key_id`, under `state` whether the source has state, under `problems` the number of its problems, under `agreements` the number of its agreements and under `waiting` the number of those waiting on a change.

**Tests:** `compliance/mcp-connector-acts.test.ts › clears nothing without a confirmation, and clears the state, problems and agreements with the one the preview gave`.

### `mcp/connector-state-confirmed`

When `marfa_delete_connector` is called with `part` `state` and the `confirm` token its preview gave, by the same credential, within five minutes, while the source's state, problems and agreements stand as the preview read them, the server MUST clear them as `DELETE /connectors/{id}/state` does, answer `cleared` as `true` and answer under `agreements` the number of agreements it cleared.

**Tests:** `compliance/mcp-connector-acts.test.ts › clears nothing without a confirmation, and clears the state, problems and agreements with the one the preview gave`.

### `mcp/connector-state-changed`

If the source's state or problems, or any of its agreements, changed since a `marfa_delete_connector` preview of clearing its state, then the server MUST refuse the call that confirms it with the tool error code `confirmation_stale` and a new preview.

**Reason:** the agreements are what clearing destroys, and a connector that loses them treats every item as new, so the confirmation covers each one.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation once the state or an agreement changed since the preview`.

### `mcp/connector-state-empty`

When `marfa_delete_connector` previews clearing the state of a source that has no state and no agreements, the server MUST answer without a `confirm` token.

**Tests:** `compliance/mcp-connector-acts.test.ts › answers a source with no state and no agreements with no confirmation`.

## Retiring an endpoint

`marfa_retire_endpoint` retires a connector's inbound endpoint, as `DELETE /connectors/{id}/endpoints/{endpoint_id}` does, in two calls: a preview with a `confirm` token, and a call that sends the same `id` and `endpoint_id` with that token. The statements under "A confirmation of a connector's change" hold for it too.

### `mcp/endpoint-retire-preview`

When `marfa_retire_endpoint` is called without `confirm`, the server MUST NOT retire the endpoint.

**Tests:** `compliance/mcp-connector-acts.test.ts › retires nothing without a confirmation, and retires the endpoint with the one the preview gave, keeping its deliveries`.

### `mcp/endpoint-retire-preview-shows`

When `marfa_retire_endpoint` previews, the server MUST answer under `endpoint` the endpoint as `GET /connectors/{id}/endpoints` lists it and under `unhandled_deliveries` the number of its deliveries that are not handled.

**Tests:** `compliance/mcp-connector-acts.test.ts › retires nothing without a confirmation, and retires the endpoint with the one the preview gave, keeping its deliveries`.

### `mcp/endpoint-retire-confirmed`

When `marfa_retire_endpoint` is called with the `confirm` token its preview gave, by the same credential, within five minutes, while the endpoint is live and belongs to the source's current registration, the server MUST retire it as `DELETE /connectors/{id}/endpoints/{endpoint_id}` does and answer `retired` as `true`.

**Tests:** `compliance/mcp-connector-acts.test.ts › retires nothing without a confirmation, and retires the endpoint with the one the preview gave, keeping its deliveries`.

### `mcp/endpoint-retire-already`

When `marfa_retire_endpoint` previews an endpoint that is retired already, the server MUST answer `already_retired` as `true` without a `confirm` token.

**Tests:** `compliance/mcp-connector-acts.test.ts › answers an endpoint already retired with no confirmation`.

### `mcp/endpoint-retire-changed`

If the endpoint was retired, or its registration stopped being its source's current one, since a `marfa_retire_endpoint` preview, then the server MUST refuse the call that confirms it with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation once the endpoint was retired since the preview`, `› refuses a confirmation once the connector no longer holds the endpoint's source`.

## A confirmation of a connector's change

These statements hold for `marfa_delete_connector` and `marfa_retire_endpoint`.

### `mcp/connector-acts-destructive`

When the server lists `marfa_delete_connector` or `marfa_retire_endpoint`, the server MUST annotate it with `destructiveHint` `true` and `readOnlyHint` `false`.

**Reason:** neither change can be undone, and a client asks the person differently before a tool that destroys data.

**Tests:** `compliance/mcp.test.ts › marks narrowing an app, purging, deleting a connector, retiring an endpoint and the maintenance tool as destructive, the other owner-task changes as not, and each listing tool as read-only`.

### `mcp/connector-acts-gone`

If the connector or the endpoint a call with a `confirm` token names no longer exists, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** the call answers the confirmation it was sent with, so it names nothing as missing.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation when the connector is gone, without saying it was not found`.

### `mcp/connector-acts-other-credential`

If a call carries a `confirm` token a preview gave another credential, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation another credential got`.

### `mcp/connector-acts-expired`

If a call carries a `confirm` token from a preview more than five minutes earlier, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation once five minutes have passed since the preview`.

### `mcp/connector-acts-token-first`

If a call carries a `confirm` token that another credential got, that expired, or that a preview of another connector, `part` or endpoint gave, then the server MUST answer `confirmation_stale` without a new preview.

**Reason:** the server judges the token before it reads what the call names, so a token that does not hold tells the caller nothing about it.

**Tests:** `compliance/mcp-connector-acts.test.ts › refuses a confirmation sent for another connector, part or endpoint before reading it`, `› refuses a confirmation once five minutes have passed since the preview`, `› refuses a confirmation another credential got`.

### `mcp/connector-acts-atomic`

If a call with a `confirm` token that holds fails after it has begun its change, then the server MUST leave the registration, its runs, the source's endpoints, deliveries, state, problems and agreements as they were.

**Reason:** a person who agreed to a change must not find part of it done.

**Tests:** `compliance/mcp-connector-acts.test.ts › leaves the connector and the confirmation as they were when the confirmed change fails, and changes it without the fault`.

### `mcp/connector-acts-spent-on-commit`

If a call fails before its change commits, then the server MUST make the change on the same `confirm` token when it is sent again within five minutes.

**Reason:** a token is recorded as used in the transaction of the change it allowed, so a change that never happened does not use it up.

**Tests:** `compliance/mcp-connector-acts.test.ts › leaves the connector and the confirmation as they were when the confirmed change fails, and changes it without the fault`.

### `mcp/connector-acts-single-use`

If a call carries a `confirm` token that an earlier call already used, then the server MUST NOT change anything on it.

**Tests:** `compliance/mcp-connector-acts.test.ts › changes nothing more on a confirmation an earlier call used, and says it already did`.

### `mcp/connector-acts-repeated`

When a call carries a `confirm` token that an earlier call by the same credential used for the same change, within five minutes of the preview, the server MUST answer `already_done` as `true`, with the `runs` or `agreements` that earlier call answered.

**Reason:** a client that did not see the first answer, such as one that timed out, learns that the change landed.

**Tests:** `compliance/mcp-connector-acts.test.ts › changes nothing more on a confirmation an earlier call used, and says it already did`.

## Moving items to another type

`marfa_move_items` moves every item of one type to another in two calls, as `marfa_delete` trashes: a preview that names the items the move would take, with a `confirm` token, and a call with that token, which starts the move as a job. A token is refused, as `marfa_delete`'s is, when another credential sends it or five minutes have passed.

### `mcp/move-preview`

When `marfa_move_items` is called without `confirm`, the server MUST NOT move any item.

**Tests:** `compliance/mcp.test.ts › moves nothing when called without a confirmation, and refuses a confirmation when what would move changed`.

### `mcp/move-plan-changed`

If the items a `marfa_move_items` call would move, or the settings that name the type it moves them from, changed since the preview that gave its `confirm` token, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** the person agreed to what the preview showed, not to what the move would take now.

**Tests:** `compliance/mcp.test.ts › moves nothing when called without a confirmation, and refuses a confirmation when what would move changed`, `› refuses a move confirmation once a setting names the type after the preview`.

## Health and sources

### `mcp/health-error-withheld`

When a credential without `instance.read` calls `marfa_health`, the server MUST answer the components without an `error`.

**Reason:** the text is the database's or the operating system's own and carries paths and driver detail (`instance/health-error-others`). A credential with `connectors.manage` is offered the tool for its connectors, and no more of the instance's health is told it.

**Tests:** `compliance/mcp-shortened.test.ts › gives a credential without instance.read no error on a component and no housekeeping object, and gives both to one with it`.

### `mcp/health-housekeeping-withheld`

When a credential without `instance.read` calls `marfa_health`, the server MUST answer without a `housekeeping` object.

**Tests:** `compliance/mcp-shortened.test.ts › gives a credential without instance.read no error on a component and no housekeeping object, and gives both to one with it`.

### `mcp/sources-left-out`

If the sources a credential sees do not fit one `marfa_sources` answer, then the server MUST answer a `left_out` with the number of sources it left out.

**Reason:** an agent that reads a short list as the whole list names the wrong sources. A source left out is read by naming it as `source`.

**Tests:** `compliance/mcp-shortened.test.ts › names how many sources it left out when the list outgrows one answer, and none when it does not`.

## Revoking a key

`marfa_revoke_key` revokes a key in two calls: a preview of the key, with a `confirm` token, and a call with that token.

### `mcp/revoke-preview`

When `marfa_revoke_key` is called without `confirm`, the server MUST NOT revoke the key.

**Tests:** `compliance/mcp.test.ts › revokes nothing when called without a confirmation`.

### `mcp/revoke-confirmed`

When `marfa_revoke_key` is called with the `confirm` token its preview of the same key gave, by the same credential, within five minutes, while the key is unchanged apart from when it was last used, the server MUST revoke the key.

**Tests:** `compliance/mcp.test.ts › revokes the key with the confirmation the preview gave`.

### `mcp/revoke-other-credential`

If a `marfa_revoke_key` call carries a `confirm` token a preview gave another credential, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** the person agreed to a revoke through the agent they spoke to, not through whoever holds the token.

**Tests:** `compliance/mcp.test.ts › refuses a revoke confirmation another credential got`.

## Making a key

`marfa_manage_key` makes a key or narrows one.

### `mcp/key-made-owner-key`

When an app's access token holding `keys.mint` and `keys.manage` calls `marfa_manage_key` to make a key with `owner_key: true`, the server MUST make a key that carries no `oauth_client_id`.

**Reason:** The same call without `owner_key` makes a key that carries the app's `oauth_client_id`, so an app reaches the same choice through MCP as through `POST /keys` (`keys-and-oauth/owner-key-mint`).

**Tests:** `compliance/owner-keys.test.ts › makes an owner's key through an app that holds keys.mint and keys.manage, and an app's key without owner_key`.

### `mcp/key-made-claims`

When an app's access token holding `keys.mint` and `keys.manage` calls `marfa_manage_key` to make a key naming `sources`, the server MUST make a key that claims them.

**Reason:** A claim `keys-and-oauth/claims-manage` lets an app grant through `POST /keys` is granted through MCP the same way.

**Tests:** `compliance/owner-keys.test.ts › grants a claim through an app that holds keys.manage, and refuses it to one that does not`.

### `mcp/key-narrow-fields`

If a `marfa_manage_key` call with `action: "narrow"` names `owner_key` or `sources`, then the server MUST answer it with a tool error carrying `validation_error`.

**Reason:** Making a key is where its maker and its claims are chosen, so a narrowing that names them would otherwise be ignored without a word.

**Tests:** `compliance/owner-keys.test.ts › refuses owner_key through an app that does not hold keys.manage, and both fields where a key is narrowed`.

## Managing a webhook

`marfa_manage_webhook` makes, changes and deletes webhooks. Making a webhook, or changing its `url`, `events` or `type_filter`, takes two calls, as `marfa_delete` trashes: a preview of where the webhook would post and what it would send, with a `confirm` token, and a call with that token. A token is refused, as `marfa_delete`'s is, when five minutes have passed, and a token to make a webhook is refused once a webhook the credential can read, the one it made included, has been made or deleted since the preview. A new webhook starts active. Pausing, resuming or deleting a webhook takes one call.

### `mcp/webhook-preview`

When `marfa_manage_webhook` is called without `confirm` to make a webhook, or to change a webhook's `url`, `events` or `type_filter`, the server MUST NOT make or change any webhook.

**Reason:** a webhook posts what it sends outside the instance, so the person agrees to where it posts and what it sends before the first event leaves.

**Tests:** `compliance/mcp.test.ts › makes and changes no webhook when called without a confirmation`.

### `mcp/webhook-confirmed`

When `marfa_manage_webhook` is called with the `confirm` token its preview of the same arguments gave, by the same credential, within five minutes, while the webhook it would change is unchanged or, to make one, while the webhooks the credential can read are those it could read at the preview, the server MUST make or change the webhook as the preview showed.

**Tests:** `compliance/mcp.test.ts › makes a webhook with the confirmation the preview gave`.

### `mcp/webhook-changed`

If the `url`, `events`, `type_filter` or active state a `marfa_manage_webhook` call would leave a webhook with differ from what the preview that gave its `confirm` token showed, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** the person agreed to what the preview showed, not to what the call would do now.

**Tests:** `compliance/mcp.test.ts › refuses a webhook confirmation once where it posts or what it sends changed`.

### `mcp/webhook-made-once`

If a `marfa_manage_webhook` call to make a webhook carries a `confirm` token and a webhook the credential can read has been made or deleted since the preview that gave it, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** a token stays unexpired after the webhook it confirmed is made, so a client that retries the confirmation, or sends it twice, would otherwise make a second webhook posting the same events to the same address.

**Tests:** `compliance/mcp.test.ts › makes one webhook for a confirmation, however often it is sent`.

### `mcp/webhook-other-credential`

If a `marfa_manage_webhook` call carries a `confirm` token a preview gave another credential, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp.test.ts › refuses a webhook confirmation another credential got`.

### `mcp/webhook-one-step`

When `marfa_manage_webhook` is called to delete a webhook, or to change only whether it is active, the server MUST make the change without a `confirm` token.

**Reason:** neither sends anything to an address, or of a kind, that the person has not already agreed to.

**Tests:** `compliance/mcp.test.ts › pauses and deletes a webhook in one call`.

## Saving a file

`marfa_create` saves a file from a web address in `url`, or from the `download_url` of a file a chat attached in `file`.

### `mcp/file-saved`

When `marfa_create` names the address of a file at a public address, the server MUST save the file's bytes as a blob and create an item of the file type its MIME type names, whose `blob_ref` is the blob's hash and whose `source_url` is the address.

**Tests:** `compliance/mcp-scripted.test.ts › saves a file from a public address as a file item with its bytes and address`.

### `mcp/file-not-public`

If the address `marfa_create` names resolves to an address that is not public, then the server MUST answer a tool error with code `file_not_fetched` and reason `not_public` without connecting to it.

**Reason:** a tool call must not reach the instance's own network on the caller's behalf.

**Tests:** `compliance/mcp-scripted.test.ts › refuses a file at a loopback address with file_not_fetched and reason not_public, without connecting`.

### `mcp/file-redirect`

If the address `marfa_create` names answers with a redirect, then the server MUST answer a tool error with code `file_not_fetched` and reason `redirect` without following it.

**Tests:** `compliance/mcp-scripted.test.ts › does not follow a redirect, and answers file_not_fetched with reason redirect`.

### `mcp/fetch-settings`

When an authorized caller replaces or updates the configuration, the server MUST accept `mcp_fetch_enabled` as true or false, `mcp_fetch_max_bytes` as a whole number of bytes of 1 or more, and `mcp_fetch_timeout_seconds` as a whole number of seconds from 1 to 3600.

**Reason:** the owner decides whether agents may make the server fetch files, how large a file it fetches and how long it waits for one. Raising the largest file also needs a longer wait for it, so the time is a setting beside the size. They are stored in the instance and have no environment setting.

**Tests:** `compliance/mcp-scripted.test.ts › applies a stored mcp_fetch_max_bytes and mcp_fetch_enabled to the next fetch without a restart`.

### `mcp/fetch-settings-live`

When a stored `mcp_fetch_enabled`, `mcp_fetch_max_bytes` or `mcp_fetch_timeout_seconds` changes, the server MUST apply the stored value to the next fetch without a restart.

**Reason:** a fetch already running keeps the limits it started with, and the next one follows the owner's change.

**Tests:** `compliance/mcp-scripted.test.ts › applies a stored mcp_fetch_max_bytes and mcp_fetch_enabled to the next fetch without a restart`.

### `mcp/file-too-large`

If the file `marfa_create` names is larger than the stored `mcp_fetch_max_bytes`, then the server MUST answer a tool error with code `file_not_fetched` and reason `too_large`.

**Tests:** `compliance/mcp-scripted.test.ts › refuses a file larger than mcp_fetch_max_bytes with reason too_large and saves nothing`.

### `mcp/file-status`

If the address `marfa_create` names answers with a status other than a success, then the server MUST answer a tool error with code `file_not_fetched`, reason `status` and the status it answered with.

**Reason:** a chat's link to an attached file works for a short time, and the agent asks the person to attach the file again.

**Tests:** `compliance/mcp-scripted.test.ts › answers a chat file whose link has gone with file_not_fetched and the status`.

### `mcp/file-attach-repeat`

When `marfa_create` names an `attach_to` item that the item it saved, or the item it answers with `created: false`, already has an `attached-to` edge to, the server MUST answer the item with `attached_to` naming that item.

**Reason:** an agent repeats a call whose answer it lost, and the repeat finds the edge the first call wrote.

**Tests:** `compliance/mcp-scripted.test.ts › answers a repeated save naming attach_to as attached, with one edge`.

### `mcp/file-repeat-other-bytes`

When `marfa_create` answers with `created: false` and the stored item's `blob_ref` is not the hash of the file the call fetched, the server MUST leave `file` out of the answer.

**Reason:** `file` describes the file the item holds, and a repeat writes nothing to the item.

**Tests:** `compliance/mcp-scripted.test.ts › leaves file out of a repeated save whose stored item holds other bytes`.

### `mcp/file-audited`

When `marfa_create` is asked to fetch a file, whether the fetch succeeds or is refused, the server MUST record an `mcp.file_fetch` audit entry naming the credential as `key_id`, whose `details` carry the address's `scheme` and `host`, the length of its path as `path_length`, the SHA-256 hash of its path in hex as `path_sha256`, the length of its query as `query_length`, and the outcome as `outcome`: `fetched`, or the reason the tool error names.

**Reason:** the instance connects to an address the agent chose, so the owner can see each host it was asked to reach, and match a path they know against its hash.

**Tests:** `compliance/mcp-scripted.test.ts › records each fetch with its scheme, host and outcome, and its path and query only as lengths and a hash`.

### `mcp/file-audit-query`

When the server records an `mcp.file_fetch` audit entry, the server MUST NOT record the text of the address's path or query, or its user information.

**Reason:** a link to a file can carry a token that grants access to the file, in its query or in its path.

**Tests:** `compliance/mcp-scripted.test.ts › records each fetch with its scheme, host and outcome, and its path and query only as lengths and a hash`.

### `mcp/file-busy`

If `marfa_create` is asked to fetch a file while the server is fetching four files for tools, then the server MUST answer a tool error with code `file_not_fetched` and reason `busy` without connecting to the address.

**Reason:** a fetch holds a connection and a file being written, so the instance bounds how many run at once.

**Tests:** `compliance/mcp-scripted.test.ts › refuses a fifth fetch at once with reason busy, without connecting`.

### `mcp/file-rate-limited`

Where rate limiting is on, if one credential's tool calls ask to fetch more than 30 files within `rate_limit_window_seconds`, then the server MUST answer each further request in that window with a tool error with code `file_not_fetched`, reason `rate_limited` and `retry_after_seconds`, without connecting to the address.

**Tests:** `compliance/mcp-scripted.test.ts › refuses a credential's 31st fetch in a window with reason rate_limited, and not another credential's`.

### `mcp/file-disabled`

While the stored `mcp_fetch_enabled` is false, if `marfa_create` is asked to save a file from `url` or `file`, then the server MUST answer a tool error with code `file_not_fetched` and reason `disabled` without connecting to the address.

**Tests:** `compliance/mcp-scripted.test.ts › refuses url and file with reason disabled while mcp_fetch_enabled is false, without connecting`.
