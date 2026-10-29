# MCP

The MCP endpoint, `/mcp`, serves Marfa's tools to an agent over Streamable HTTP. A request carries an API key or an app's access token as a Bearer credential, and every tool call is a call to the API with that credential, so the API's own rules for the credential hold for it. The tools are `marfa_overview`, `marfa_find`, `marfa_get`, `marfa_create`, `marfa_update` and `marfa_delete`.

## Who may call it

The challenges an MCP client signs in and steps up from are stated with the server's other resources, in `keys-and-oauth/mcp-challenge-credential` and `keys-and-oauth/mcp-challenge-scope`.

### `mcp/foreign-origin`

If a request to `/mcp` carries an `Origin` header naming neither the instance's own origin nor an origin the owner approved, then the server MUST answer `403 forbidden`.

**Reason:** a page on another site must not drive the tools with a credential it holds, which the MCP transport asks a server to prevent.

**Tests:** `compliance/mcp.test.ts › refuses a request from an origin the owner did not approve with 403, where the server's own origin is served`.

## Protocol revisions

### `mcp/revision-2026-07-28`

When a client of MCP revision 2026-07-28 calls `/mcp`, the server MUST serve its discovery and its tool calls without an `initialize` handshake.

**Tests:** `compliance/mcp.test.ts › serves a client of revision 2026-07-28 without an initialize handshake`.

### `mcp/revision-2025-11-25`

When a client of MCP revision 2025-11-25 opens with `initialize`, the server MUST serve it the tools it serves a client of revision 2026-07-28 with the same credential.

**Reason:** clients move to a new revision at their own pace.

**Tests:** `compliance/mcp.test.ts › serves a client of revision 2025-11-25 that opens with initialize the same tools`.

### `mcp/no-listen`

When a client calls `subscriptions/listen` on `/mcp`, the server MUST answer in a JSON body, not a stream, with the JSON-RPC error `-32601`.

**Reason:** the endpoint keeps no session and no stream between requests, so a listen held open would only hold a connection.

**Tests:** `compliance/mcp.test.ts › answers subscriptions/listen with method not found and opens no stream`.

## The tools a credential is offered

### `mcp/tools-for-writer`

While a credential's type map grants `write` on at least one type, the server MUST list `marfa_overview`, `marfa_find`, `marfa_get`, `marfa_create`, `marfa_update` and `marfa_delete` to it.

**Tests:** `compliance/mcp.test.ts › lists the six tools to a credential that writes a type`.

### `mcp/tools-for-reader`

While a credential's type map grants `read` on at least one type and `write` on none, the server MUST list only `marfa_overview`, `marfa_find` and `marfa_get` to it.

**Reason:** a tool the credential can never use costs the agent's context and invites calls that fail.

**Tests:** `compliance/mcp.test.ts › lists only marfa_overview, marfa_find and marfa_get to a credential that only reads`.

### `mcp/tools-for-no-type`

While a credential's type map grants no type, the server MUST NOT declare the `tools` capability to it.

**Tests:** `compliance/mcp.test.ts › offers no tools to a credential whose type map reaches no type`.

### `mcp/open-world-hint`

When the server lists its tools, the server MUST annotate `marfa_create` with `openWorldHint` `true` and every other tool with `openWorldHint` `false`.

**Reason:** `marfa_create` fetches a file from a web address the agent gives it, and a client asks the person differently before a tool that reaches outside the instance.

**Tests:** `compliance/mcp.test.ts › marks marfa_create as reaching outside the instance and no other tool`.

## Calling a tool

### `mcp/unknown-argument`

If a tool call names an argument the tool does not take, then the server MUST answer the call with a tool error that names the argument.

**Reason:** a misspelled filter that is dropped answers the whole set.

**Tests:** `compliance/mcp.test.ts › refuses a tool call naming an argument the tool does not take`.

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

If a `marfa_update` call names a version other than the item's current version, and the credential can read the item's snapshot of the version named, then the server MUST answer under `conflicting_fields` each field the call would set that a write since that version also changed, and no other.

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

When `marfa_delete` is called with the `confirm` token its preview of the same IDs gave, by the same credential, within five minutes, while the items the key can read that it would trash and their versions are unchanged, the server MUST move the named items to the trash.

**Tests:** `compliance/mcp.test.ts › trashes the items with the confirmation the preview gave`.

### `mcp/delete-plan-changed`

If the items the key can read that a `marfa_delete` call would trash, or their versions, changed since the preview that gave its `confirm` token, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** the person agreed to what the preview showed, not to what the trash would take now.

**Tests:** `compliance/mcp.test.ts › refuses a confirmation when what would be trashed changed since the preview`, `› refuses a confirmation when an item past the preview's list changed`.

### `mcp/delete-plan-changed-after-check`

If the items the key can read that trashing a named item would take, or their versions, change after a `marfa_delete` call checks its `confirm` token and before that item is trashed, then the server MUST leave that item out of the trash and answer the tool error code `trash_plan_changed`, naming in `trashed` the items already trashed.

**Reason:** the token is checked against a fresh preview, and each trash then names that preview's digest (`items/trash-digest-changed`), so the check and the trash are one step.

**Tests:** `compliance/mcp-scripted.test.ts › trashes nothing when a child joins between the confirmation's check and the trash`.

### `mcp/delete-other-credential`

If a `marfa_delete` call carries a `confirm` token a preview gave another credential, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp.test.ts › refuses a confirmation another credential got`.

### `mcp/delete-expired`

If a `marfa_delete` call carries a `confirm` token from a preview more than five minutes earlier, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Tests:** `compliance/mcp-scripted.test.ts › refuses a confirmation once five minutes have passed since the preview`.

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

### `mcp/file-too-large`

If the file `marfa_create` names is larger than `MARFA_MCP_FETCH_MAX_BYTES`, then the server MUST answer a tool error with code `file_not_fetched` and reason `too_large`.

**Tests:** `compliance/mcp-scripted.test.ts › refuses a file larger than MARFA_MCP_FETCH_MAX_BYTES with reason too_large and saves nothing`.

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

Where rate limiting is on, if one credential's tool calls ask to fetch more than 30 files within `RATE_LIMIT_WINDOW_MS`, then the server MUST answer each further request in that window with a tool error with code `file_not_fetched`, reason `rate_limited` and `retry_after_seconds`, without connecting to the address.

**Tests:** `compliance/mcp-scripted.test.ts › refuses a credential's 31st fetch in a window with reason rate_limited, and not another credential's`.

### `mcp/file-disabled`

While `MARFA_MCP_FETCH_ENABLED` is off, if `marfa_create` is asked to save a file from `url` or `file`, then the server MUST answer a tool error with code `file_not_fetched` and reason `disabled` without connecting to the address.

**Tests:** `compliance/mcp-scripted.test.ts › refuses url and file with reason disabled while MARFA_MCP_FETCH_ENABLED is off, without connecting`.
