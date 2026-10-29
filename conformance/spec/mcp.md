# MCP

The MCP endpoint, `/mcp`, serves Marfa's tools to an agent over Streamable HTTP. A request carries an API key or an app's access token as a Bearer credential, and every tool call is a call to the API with that credential, so the API's own rules for the credential hold for it. The tools are `marfa_overview`, `marfa_find`, `marfa_get`, `marfa_create`, `marfa_update` and `marfa_delete`.

## Who may call it

### `mcp/unauthenticated-challenge`

If a request to `/mcp` carries no credential the server accepts, then the server MUST answer `401 unauthorized` with the header `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"`, where `<base>` is the instance's public URL.

**Reason:** an MCP client starts its sign-in from the protected resource metadata the challenge names.

**Tests:** `compliance/mcp.test.ts › answers a request without a credential with 401 and a Bearer challenge naming the endpoint's resource metadata`.

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

## Changing an item

A change to an item's fields through `marfa_update` follows the API's own version rules in `versions.md`.

### `mcp/update-stale-answer`

If a `marfa_update` call that changes an item's tags, edges or state and none of its fields names a version other than the item's current version, then the server MUST answer a tool error with code `version_conflict` that carries the item as it is now in `current`.

**Tests:** `compliance/mcp.test.ts › answers a stale version with version_conflict and the item as it is now`.

### `mcp/update-stale-unchanged`

If a `marfa_update` call that changes an item's tags, edges or state and none of its fields names a version other than the item's current version, then the server MUST NOT change the item.

**Reason:** the agent decided on the item it read, so a change made since may make its own wrong.

**Tests:** `compliance/mcp.test.ts › leaves the item unchanged when called with a stale version`.

## Deleting items

`marfa_delete` moves items to the trash in two calls: a preview that names everything the trash would take, with a `confirm` token, and a call with that token.

### `mcp/delete-preview`

When `marfa_delete` is called without `confirm`, the server MUST NOT move any item to the trash.

**Tests:** `compliance/mcp.test.ts › trashes nothing when called without a confirmation`.

### `mcp/delete-confirmed`

When `marfa_delete` is called with the `confirm` token its preview of the same IDs gave, by the same credential, within five minutes, while the items it would trash and their versions are unchanged, the server MUST move the named items to the trash.

**Tests:** `compliance/mcp.test.ts › trashes the items with the confirmation the preview gave`.

### `mcp/delete-plan-changed`

If the items a `marfa_delete` call would trash, or their versions, changed since the preview that gave its `confirm` token, then the server MUST refuse the call with the tool error code `confirmation_stale`.

**Reason:** the person agreed to what the preview showed, not to what the trash would take now.

**Tests:** `compliance/mcp.test.ts › refuses a confirmation when what would be trashed changed since the preview`.

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
