<!-- Generated from the command tree by `MARFA_WRITE_COMMANDS=1 cargo test -p marfa-cli --bin marfa reference`. Do not edit by hand. -->

# Command reference

Marfa from the command line: every operation of one instance, a working copy of a slice of it under `device`, and folders that hold a slice as files.

## Global options

Every command accepts these.

| Option | Description |
| --- | --- |
| `--url <URL>` | The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential made current. |
| `--key <KEY>` | A key or a token for that server. Prefer MARFA_API_KEY or the keychain: a command line is readable by other users of the machine and stays in shell history. Falls back to MARFA_API_KEY, then to the keychain: the file MARFA_KEYCHAIN names, where it names one. |
| `--allow-http` | Send a credential over plain http to a host that is not this machine without the warning, for a network that is private. MARFA_ALLOW_HTTP=1 does the same. |
| `--socket <PATH>` | Use private local process authority through this Unix socket, without a keychain. |
| `--json` | Print the answer as JSON, and a refusal as one JSON object on stderr, after any warning, which is one plain line. |

`marfa` itself also accepts these.

| Option | Description |
| --- | --- |
| `-V, --version` | Print version. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done. |
| 1 | The request was refused, by the server, by the CLI before sending, for an answer on another contract, or for a docs page that does not exist; a retry does not change it. |
| 2 | The command line was wrong, or named no store or server. |
| 3 | The environment failed (unreachable, timed out, a 5xx, a 429, an answer naming no contract, full local storage, a docs site that cannot be read); try again. |
| 4 | The working copy or the queue refused under the device rules, or this system has no keychain. |
| 5 | No credential, the credential was refused, or the sign-in ended; `marfa login` starts one. |

A device drain prints its complete report on stdout: 0 for a completed pass (including refused writes), 3 for undelivered writes or an unavailable pass, and 5 for a credential-stopped pass. A report exit prints no additional refusal on stderr. Refused verdicts have a separate plain-text count.

A device catch-up that fails says whether it had changed the catalog the copy holds, which the copy keeps; with --json, as "catalog_changed" beside "exit".

With --json a refusal is one JSON object on stderr:

```text
{"error":{"code":...,"message":...,"server":{"status":...,"code":...,"details":...}|null,"retry_after_seconds":...},"exit":N}
```

where error.code is one of: `not_found`, `unauthorized`, `forbidden`, `validation`, `unknown_type`, `rate_limited`, `server`, `io`, `network`, `unnamed_answer`, `decoding`, `store`, `storage_full`, `signed_out`, `no_keychain`, `redirect`, `no_server`, `no_cursor`, `hydration_incomplete`, `no_catalog`, `reading_handle`, `wrong_schema`, `copy_expired`, `stream_incomplete`, `wrong_server`, `bytes_absent`, `contract_mismatch`, `canceled`, `first_sync_waiting`, `invalid`, `not_held`, `watch`, `usage`, `no_store`, `no_credential`, `docs_page_not_found`, `docs_unreachable`, `conflict`, `too_large`.

## status

What the instance says about itself, and item counts where the credential reaches them.

### marfa status

```text
marfa status [OPTIONS]
```

## metrics

Instance-wide counters and process uptime. Needs `instance.read`.

### marfa metrics

```text
marfa metrics [OPTIONS]
```

## whoami

Which server, instance and credential a bare command would use.

### marfa whoami

```text
marfa whoami [OPTIONS]
```

## login

Sign in to a server as an app: a code the owner approves in the browser.

### marfa login

```text
marfa login [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--scope <SCOPE>` | The scopes to ask for. Defaults to everything an owner can hold that the server supports; the consent screen narrows it. |
| `--no-browser` | Print the page to open rather than opening it. |
| `--print-token` | Print the token set instead of keeping it in the keychain. |
| `--client-id <ID>` | The client id an earlier sign-in registered, where no keychain remembers it; without one the binary registers again. |
| `--name <NAME>` | The name this sign-in registers under, which is sent to the server and shown to its owner among their sign-ins. Defaults to `marfa on` and this machine's host name without its domain. Giving it registers the binary again. |

## logout

Sign out of a server: the token is revoked and forgotten.

### marfa logout

```text
marfa logout [OPTIONS]
```

## setup

Claim a new instance, obtain a setup code, or open a browser handoff.

### marfa setup

```text
marfa setup [OPTIONS] <COMMAND>
```

### marfa setup status

Show whether this instance has been claimed (private socket required).

```text
marfa setup status [OPTIONS]
```

### marfa setup code

Replace the setup code and invalidate earlier setup sessions (private socket required).

```text
marfa setup code [OPTIONS]
```

### marfa setup open

Issue a single-use browser handoff and open it (private socket required).

```text
marfa setup open [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--no-browser` | Print the handoff link without opening a browser. |

### marfa setup claim

Claim the instance. Password and remote setup code use hidden prompts or structured stdin.

```text
marfa setup claim [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--email <EMAIL>` | The owner's email address. Required when using terminal prompts. |
| `--name <NAME>` | The owner's display name. |
| `--stdin` | Read JSON containing email, password, optional name, and code for a remote claim. |

## owner

The owner: the one account behind the sign-in surface.

### marfa owner

```text
marfa owner [OPTIONS] <COMMAND>
```

### marfa owner show

Show the instance's owner.

```text
marfa owner show [OPTIONS]
```

### marfa owner recover

Recover the owner's password using private machine authority; revoke browser sessions.

```text
marfa owner recover [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--stdin` | Read a JSON object containing password from standard input instead of a hidden prompt. |

## sign-ins

Sign-ins: every browser, app and key that can reach the server. A key or an app's token is refused; use --socket.

### marfa sign-ins

```text
marfa sign-ins [OPTIONS] <COMMAND>
```

### marfa sign-ins list

List every browser, app and key that can reach the server, each with its name, its kind and when it was last used. Needs direct local authority (--socket).

```text
marfa sign-ins list [OPTIONS]
```

### marfa sign-ins rename

Give an app or a key a new name. A key's name is its label; a browser's comes from the browser and can't be changed. Needs direct local authority (--socket).

```text
marfa sign-ins rename [OPTIONS] <ID> <NAME>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The sign-in's id. |
| `<NAME>` | The new name, which may start with `-`. |

### marfa sign-ins end

End a sign-in at once: its next request is refused, and an app can't refresh its tokens. What it wrote stays, and so do the keys an app minted unless --revoke-keys is given. Needs direct local authority (--socket).

```text
marfa sign-ins end [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The sign-in's id. |

| Option | Description |
| --- | --- |
| `--revoke-keys` | For an app, also revoke every key it minted. Refused for a browser or a key. |

## items

Items: create, read, change, tag, link, attach, and the bulk operations.

### marfa items

```text
marfa items [OPTIONS] <COMMAND>
```

### marfa items list

List items on the server, a page at a time.

```text
marfa items list [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state, or `any`. Unset answers the active state. One of `active`, `archived`, `trashed`, `revoked`, `any`. |
| `--source <SOURCE>` | The source the items were written under. |
| `--tier <TIER>` | One tier, or `all`. One of `library`, `feed`, `all`. |
| `--tag <TAG>` | Items must carry every tag given. |
| `--filter <FILTER>` | A property filter in the server's filter grammar. |
| `--sort <SORT>` | The field to order by; the server's default is the creation time. One of `created-at`, `updated-at`, `occurred-at`. |
| `--direction <DIRECTION>` | `asc` or `desc`; the server's default is newest first. One of `asc`, `desc`. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--updated-after <TIME>` | Inclusive lower bound on the modification time: the catch-up filter. |
| `--updated-before <TIME>` | Exclusive upper bound on the modification time. |
| `--include <NAME>` | Extra to hydrate onto each item: `edges`, `metadata`. |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

### marfa items get

One item by id.

```text
marfa items get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--include <LIST>` | Extra to hydrate onto the item: `edges`, `metadata`, or both comma-separated. |

### marfa items create

Create an item.

```text
marfa items create [OPTIONS] --type <TYPE>
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | The type the item is. |
| `--properties <JSON>` | The properties, as a JSON object. |
| `--prop <KEY=VALUE>` | One property as key=value, repeatable. The value is a string. |
| `--tag <TAG>` | A tag, repeatable. |
| `--tier <TIER>` | The tier to write it at; the server's default is the library. One of `library`, `feed`. |
| `--state <STATE>` | The state to create it in. One of `active`, `archived`, `trashed`, `revoked`. |
| `--occurred-at <TIME>` | The item's own time, RFC 3339. Defaults to now. |
| `--source <SOURCE>` | The source to key and stamp it with: the key's own, or one it claims. Any other is refused. |
| `--source-id <SOURCE_ID>` | The id this row has in the system it came from: the natural key. |
| `--id <ID>` | The id to mint it under. Omitted, the server mints one. |
| `--version <VERSION>` | The version this create is conditional on, where its natural key resolves a row the server already holds. |
| `--edges <JSON>` | Edges to write with it, as the JSON object the operation takes. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa items update

Change an item's properties or fields, conditional on the version read.

```text
marfa items update [OPTIONS] --version <VERSION> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--version <VERSION>` | The version the edit was based on. Required: the server refuses an update that names no version. |
| `--properties <JSON>` | The properties, as a JSON object. |
| `--prop <KEY=VALUE>` | One property as key=value, repeatable. The value is a string. |
| `--replace` | Replace the properties whole instead of merging the ones given. |
| `--type <TYPE>` | Move the item to this type. |
| `--retype` | Let the type change even where the target type is enforced. |
| `--tier <TIER>` | The tier to move the item to. One of `library`, `feed`. |
| `--occurred-at <TIME>` | The item's own time, RFC 3339. |
| `--source-id <KEY>` | The natural key to move the row to. The server refuses one another item already holds. |
| `--edges <JSON>` | Edges to write with it, as the JSON object the operation takes. |
| `--conflict <CONFLICT>` | How a colliding write is settled: `auto` asks the server to resolve within its own transaction. One of `auto`, `manual`, `callback`. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa items delete

Move an item to the bin.

```text
marfa items delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa items restore

Take an item out of the bin.

```text
marfa items restore [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa items transition

Move an item to another lifecycle state.

```text
marfa items transition [OPTIONS] --state <STATE> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--state <STATE>` | The state to move it to. One of `active`, `archived`, `trashed`. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa items purge

Destroy a trashed item irrecoverably. Needs `items.purge`.

```text
marfa items purge [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa items versions

One page of the snapshots an item's history holds, oldest first. Pass the answer's `next_cursor` as `--cursor` for the next page.

```text
marfa items versions [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

### marfa items tag

Put tags on an item.

```text
marfa items tag [OPTIONS] <ID> <TAGS>...
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |
| `<TAGS>...` | One or more tags. |

### marfa items untag

Take one tag off an item.

```text
marfa items untag [OPTIONS] <ID> <TAG>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |
| `<TAG>` | The tag to take off. |

### marfa items edges

The edges leaving an item.

```text
marfa items edges [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--type <TYPE>` | Only edges of this type. |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

### marfa items backrefs

The edges arriving at an item.

```text
marfa items backrefs [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--type <TYPE>` | Only edges of this type. |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

### marfa items add

Add a file as an item of its own: upload its bytes and create a file item for them.

```text
marfa items add [OPTIONS] <FILE>
```

| Argument | Description |
| --- | --- |
| `<FILE>` | The file to add. |

| Option | Description |
| --- | --- |
| `--mime-type <TYPE>` | The file's MIME type. Guessed from the extension when omitted. |
| `--title <TITLE>` | The file item's title. Defaults to the file's name. |
| `--type <TYPE>` | The file item's type. Defaults to `core.file`, or the image, audio or video subtype when the MIME type says. |
| `--tag <TAG>` | A tag, repeatable. |
| `--tier <TIER>` | The tier to write it at; the server's default is the library. One of `library`, `feed`. |

### marfa items attach

Attach a file: upload its bytes, create a file item for them, and link it to the target with an `attached-to` edge.

```text
marfa items attach [OPTIONS] <ID> <FILE>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item the file belongs to. |
| `<FILE>` | The file to attach. |

| Option | Description |
| --- | --- |
| `--mime-type <TYPE>` | The file's MIME type. Guessed from the extension when omitted. |
| `--title <TITLE>` | The file item's title. Defaults to the file's name. |
| `--type <TYPE>` | The file item's type. Defaults to `core.file`, or the image, audio or video subtype when the MIME type says. |

### marfa items stats

Item counts, by state or by type.

```text
marfa items stats [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--by <BY>` | What to count by. One of `state`, `type`. |

### marfa items occurrences

Occurrences of `core.event` items in a window.

```text
marfa items occurrences [OPTIONS] --from <TIME> --to <TIME>
```

| Option | Description |
| --- | --- |
| `--from <TIME>` | The window's start, RFC 3339. |
| `--to <TIME>` | The window's end, RFC 3339. |
| `--type <TYPE>` | A type identifier to narrow to. |

### marfa items bulk

Upsert many items in one request.

```text
marfa items bulk [OPTIONS] --file <PATH>
```

| Option | Description |
| --- | --- |
| `--file <PATH>` | A JSON file holding the items, or the whole body with `items` in it; `-` reads stdin. |
| `--mode <MODE>` | `upsert` or `create_only`. |
| `--atomic` | Refuse the whole request if any entry is refused. |
| `--no-fanout` | Do not deliver the writes to webhooks. |
| `--retype` | Let entries change the type of the rows they land on. |

### marfa items bulk-get

Read many items by id in one request.

```text
marfa items bulk-get [OPTIONS] <IDS>...
```

| Argument | Description |
| --- | --- |
| `<IDS>...` | The item ids. |

| Option | Description |
| --- | --- |
| `--include <NAME>` | Extra to hydrate onto each item: `edges`, `metadata`. |

### marfa items lookup

Items by link, natural key or id, in every state, with the tombstones purges left for the keys named.

```text
marfa items lookup [OPTIONS] --type <TYPE>
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | The type the links are held in and the tombstones kept under. |
| `--link <VALUE>` | A link value; repeat for more. |
| `--source <SOURCE>` | The source the `--source-id` natural keys are under. |
| `--source-id <ID>` | A natural key's `source_id`; repeat for more. |
| `--id <ID>` | An item id; repeat for more. |
| `--include <NAME>` | Extra to hydrate onto each item: `edges`. |

### marfa items tombstones

Settle the tombstones purges left at a later time.

```text
marfa items tombstones [OPTIONS] --type <TYPE> --settled-at <TIME>
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | The type the tombstones are kept under. |
| `--link <VALUE>` | A link value; repeat for more. |
| `--source <SOURCE>` | The source the `--source-id` natural keys are under. |
| `--source-id <ID>` | A natural key's `source_id`; repeat for more. |
| `--settled-at <TIME>` | The vendor-side change time, RFC 3339; one earlier than a tombstone holds leaves it as it is. |

### marfa items bulk-action

Apply one action to every item a filter selects, as a job.

```text
marfa items bulk-action [OPTIONS] <COMMAND>
```

### marfa items bulk-action transition

Move every matching item to a state.

```text
marfa items bulk-action transition [OPTIONS] --to <STATE>
```

| Option | Description |
| --- | --- |
| `--to <STATE>` | The state to move them to. One of `active`, `archived`, `trashed`. |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state. Unset excludes the bin, as a listing does; there is no `any` on this operation. One of `active`, `archived`, `trashed`, `revoked`. |
| `--source <SOURCE>` | The source the items were written under. |
| `--tier <TIER>` | One tier. One of `library`, `feed`. |
| `--tag <TAG>` | Items must carry every tag given. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--filter <FILTER>` | A property filter in the server's filter grammar. |
| `--dry-run` | Report what the action would touch and touch nothing. |
| `--max-items <MAX_ITEMS>` | Refuse if more than this many items match. |
| `--no-fanout` | Do not deliver the writes to webhooks. |

### marfa items bulk-action purge

Destroy every matching item that is in the trash when the job reaches it; any other match is left as it is and reported. Match the bin with `--state trashed`. Needs `items.purge` and `--confirm PURGE`.

```text
marfa items bulk-action purge [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--confirm <PURGE>` | The word `PURGE`, because the operation asks for it out loud. |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state. Unset excludes the bin, as a listing does; there is no `any` on this operation. One of `active`, `archived`, `trashed`, `revoked`. |
| `--source <SOURCE>` | The source the items were written under. |
| `--tier <TIER>` | One tier. One of `library`, `feed`. |
| `--tag <TAG>` | Items must carry every tag given. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--filter <FILTER>` | A property filter in the server's filter grammar. |
| `--dry-run` | Report what the action would touch and touch nothing. |
| `--max-items <MAX_ITEMS>` | Refuse if more than this many items match. |
| `--no-fanout` | Do not deliver the writes to webhooks. |

### marfa items bulk-action tags

Add tags to, and remove tags from, every matching item.

```text
marfa items bulk-action tags [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--add <TAG>` | A tag to add, repeatable. |
| `--remove <TAG>` | A tag to remove, repeatable. |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state. Unset excludes the bin, as a listing does; there is no `any` on this operation. One of `active`, `archived`, `trashed`, `revoked`. |
| `--source <SOURCE>` | The source the items were written under. |
| `--tier <TIER>` | One tier. One of `library`, `feed`. |
| `--tag <TAG>` | Items must carry every tag given. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--filter <FILTER>` | A property filter in the server's filter grammar. |
| `--dry-run` | Report what the action would touch and touch nothing. |
| `--max-items <MAX_ITEMS>` | Refuse if more than this many items match. |
| `--no-fanout` | Do not deliver the writes to webhooks. |

### marfa items bulk-action tier

Move every matching item to a tier.

```text
marfa items bulk-action tier [OPTIONS] --to <TIER>
```

| Option | Description |
| --- | --- |
| `--to <TIER>` | The tier to move them to. One of `library`, `feed`. |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state. Unset excludes the bin, as a listing does; there is no `any` on this operation. One of `active`, `archived`, `trashed`, `revoked`. |
| `--source <SOURCE>` | The source the items were written under. |
| `--tier <TIER>` | One tier. One of `library`, `feed`. |
| `--tag <TAG>` | Items must carry every tag given. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--filter <FILTER>` | A property filter in the server's filter grammar. |
| `--dry-run` | Report what the action would touch and touch nothing. |
| `--max-items <MAX_ITEMS>` | Refuse if more than this many items match. |
| `--no-fanout` | Do not deliver the writes to webhooks. |

### marfa items bulk-action properties

Merge a patch into every matching item's properties.

```text
marfa items bulk-action properties [OPTIONS] --patch <JSON>
```

| Option | Description |
| --- | --- |
| `--patch <JSON>` | The patch, as a JSON object. |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state. Unset excludes the bin, as a listing does; there is no `any` on this operation. One of `active`, `archived`, `trashed`, `revoked`. |
| `--source <SOURCE>` | The source the items were written under. |
| `--tier <TIER>` | One tier. One of `library`, `feed`. |
| `--tag <TAG>` | Items must carry every tag given. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--filter <FILTER>` | A property filter in the server's filter grammar. |
| `--dry-run` | Report what the action would touch and touch nothing. |
| `--max-items <MAX_ITEMS>` | Refuse if more than this many items match. |
| `--no-fanout` | Do not deliver the writes to webhooks. |

### marfa items bulk-action occurred-at

Set every matching item's own time.

```text
marfa items bulk-action occurred-at [OPTIONS] --occurred-at <TIME>
```

| Option | Description |
| --- | --- |
| `--occurred-at <TIME>` | The time to set, RFC 3339. |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state. Unset excludes the bin, as a listing does; there is no `any` on this operation. One of `active`, `archived`, `trashed`, `revoked`. |
| `--source <SOURCE>` | The source the items were written under. |
| `--tier <TIER>` | One tier. One of `library`, `feed`. |
| `--tag <TAG>` | Items must carry every tag given. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--filter <FILTER>` | A property filter in the server's filter grammar. |
| `--dry-run` | Report what the action would touch and touch nothing. |
| `--max-items <MAX_ITEMS>` | Refuse if more than this many items match. |
| `--no-fanout` | Do not deliver the writes to webhooks. |

### marfa items bulk-action job

A bulk-action job's state.

```text
marfa items bulk-action job [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The job id. |

### marfa items bulk-action cancel

Cancel a bulk-action job.

```text
marfa items bulk-action cancel [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The job id. |

## edges

Edges between items.

### marfa edges

```text
marfa edges [OPTIONS] <COMMAND>
```

### marfa edges list

List edges on the server, a page at a time.

```text
marfa edges list [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | Only edges of this type. |
| `--updated-after <TIME>` | Inclusive lower bound on the modification time: the catch-up filter. |
| `--updated-before <TIME>` | Exclusive upper bound on the modification time. |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

### marfa edges get

One edge by id.

```text
marfa edges get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The edge id. |

### marfa edges create

Link two items with an edge.

```text
marfa edges create [OPTIONS] --source <ID> --target <ID> --type <TYPE>
```

| Option | Description |
| --- | --- |
| `--source <ID>` | The item the edge leaves. |
| `--target <ID>` | The item the edge arrives at. |
| `--type <TYPE>` | The edge type. |
| `--properties <JSON>` | The edge's properties, as a JSON object. |
| `--id <ID>` | The id to mint it under. Omitted, the server mints one. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa edges update

Change an edge's properties, or move one of its ends, conditional on the version read.

```text
marfa edges update [OPTIONS] --version <VERSION> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The edge id. |

| Option | Description |
| --- | --- |
| `--properties <JSON>` | The properties, as a JSON object. Whole values. |
| `--source <ID>` | Move the edge to this source, where each target holds one of its type. |
| `--target <ID>` | Move the edge to this target, where each source holds one of its type. |
| `--version <VERSION>` | The version the edit was based on. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa edges delete

Remove an edge.

```text
marfa edges delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The edge id. |

| Option | Description |
| --- | --- |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa edges bulk

Upsert many edges in one request.

```text
marfa edges bulk [OPTIONS] --file <PATH>
```

| Option | Description |
| --- | --- |
| `--file <PATH>` | A JSON file holding the edges, or the whole body with `edges` in it; `-` reads stdin. |
| `--mode <MODE>` | `upsert` or `create_only`. |
| `--atomic` | Refuse the whole request if any entry is refused. |
| `--no-fanout` | Do not deliver the writes to webhooks. |

## edge-types

The edge types an instance holds.

### marfa edge-types

```text
marfa edge-types [OPTIONS] <COMMAND>
```

### marfa edge-types list

Every edge type the instance holds.

```text
marfa edge-types list [OPTIONS]
```

### marfa edge-types register

Register an edge type from its definition. Needs `metadata.edge_types:write` and write on its id and any reverse name in the key's edge map.

```text
marfa edge-types register [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--file <PATH>` | A file holding the JSON body; `-` reads stdin. |
| `--body <JSON>` | The JSON body inline. |

### marfa edge-types delete

Remove a registered edge type. Needs `schema.write` and write on its id and any reverse name in the key's edge map.

```text
marfa edge-types delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The edge type id. |

## types

The types an instance holds, and the shipped ones it has outgrown.

### marfa types

```text
marfa types [OPTIONS] <COMMAND>
```

### marfa types list

Every type the instance holds.

```text
marfa types list [OPTIONS]
```

### marfa types get

One type by id, with its schema.

```text
marfa types get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The type id, such as `core.note` or `user.recipe`. |

### marfa types register

Register a type from its definition. Needs `metadata.types:write` and write on the type in the key's type map.

```text
marfa types register [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--file <PATH>` | A file holding the JSON body; `-` reads stdin. |
| `--body <JSON>` | The JSON body inline. |

### marfa types normalize

Normalize a definition and compare it with the registered type. Any authenticated key can use this command.

```text
marfa types normalize [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--file <PATH>` | A file holding the JSON body; `-` reads stdin. |
| `--body <JSON>` | The JSON body inline. |

### marfa types replace

Replace a registered type's definition. Needs write on the type in the key's type map and `schema.write` or `metadata.types:write`.

`metadata.types:write` alone covers adding optional fields that no stored row holds a value under, and changing the label, description, display hints and version. Any other change, removing a field included, needs `schema.write`.

```text
marfa types replace [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The type id. |

| Option | Description |
| --- | --- |
| `--file <PATH>` | A file holding the JSON body; `-` reads stdin. |
| `--body <JSON>` | The JSON body inline. |

### marfa types delete

Remove a registered type. Needs `schema.write` and write on the type in the key's type map.

```text
marfa types delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The type id. |

| Option | Description |
| --- | --- |
| `--force` | Remove it even where items of the type exist. |

### marfa types drift

Shipped types this instance carries that the build no longer does. Requires `instance.read`.

```text
marfa types drift [OPTIONS]
```

### marfa types prune

Remove one shipped type the build no longer carries. Requires `instance.maintain`.

```text
marfa types prune [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The type id. |

## search

Full-text search on the server, best match first.

### marfa search

```text
marfa search [OPTIONS] <QUERY>
```

| Argument | Description |
| --- | --- |
| `<QUERY>` | What to look for. |

| Option | Description |
| --- | --- |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state, or `any`. Unset answers the active state. One of `active`, `archived`, `trashed`, `revoked`, `any`. |
| `--tier <TIER>` | One tier, or `all`. One of `library`, `feed`, `all`. |
| `--tag <TAG>` | Hits must carry every tag given. |
| `--filter <FILTER>` | A property filter in the server's filter grammar. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--include <NAME>` | Extra to hydrate onto each hit: `edges`, `metadata`. |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

## metadata

An item's tags and the namespaces it carries, and every tag in use.

### marfa metadata

```text
marfa metadata [OPTIONS] <COMMAND>
```

### marfa metadata get

An item's metadata: its tags and the namespaces it carries.

```text
marfa metadata get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

### marfa metadata replace

Write an item's tags whole, dropping any not named.

```text
marfa metadata replace [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--tag <TAG>` | A tag, repeatable; none at all clears them. |

### marfa metadata update

Add the named tags, leaving the rest.

```text
marfa metadata update [OPTIONS] --tag <TAG> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--tag <TAG>` | A tag, repeatable. |

### marfa metadata tags

Every distinct tag in use on the instance.

```text
marfa metadata tags [OPTIONS]
```

## extensions

An item's extension namespaces.

### marfa extensions

```text
marfa extensions [OPTIONS] <COMMAND>
```

### marfa extensions list

The extension namespaces an item carries.

```text
marfa extensions list [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

### marfa extensions get

One namespace's contents.

```text
marfa extensions get [OPTIONS] <ID> <NAMESPACE>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |
| `<NAMESPACE>` | The namespace, such as `app.cursor`. |

### marfa extensions write

Write one namespace whole.

```text
marfa extensions write [OPTIONS] <ID> <NAMESPACE>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |
| `<NAMESPACE>` | The namespace, such as `app.cursor`. |

| Option | Description |
| --- | --- |
| `--file <PATH>` | A file holding the JSON body; `-` reads stdin. |
| `--body <JSON>` | The JSON body inline. |

### marfa extensions delete

Remove one namespace.

```text
marfa extensions delete [OPTIONS] <ID> <NAMESPACE>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |
| `<NAMESPACE>` | The namespace, such as `app.cursor`. |

## blobs

Bytes stored by content hash, and the stores that hold them.

### marfa blobs

```text
marfa blobs [OPTIONS] <COMMAND>
```

### marfa blobs upload

Store a file's bytes by content hash.

```text
marfa blobs upload [OPTIONS] <FILE>
```

| Argument | Description |
| --- | --- |
| `<FILE>` | The file. |

| Option | Description |
| --- | --- |
| `--mime-type <TYPE>` | The file's MIME type. Guessed from the extension when omitted. |

### marfa blobs download

Fetch a blob's bytes.

```text
marfa blobs download [OPTIONS] <HASH>
```

| Argument | Description |
| --- | --- |
| `<HASH>` | The blob hash, `sha256:<hex>`. |

| Option | Description |
| --- | --- |
| `--output <PATH>` | Where to write the bytes. Omitted, they go to stdout. |

### marfa blobs url

A time-limited link that fetches a blob without the API in between.

```text
marfa blobs url [OPTIONS] <HASH>
```

| Argument | Description |
| --- | --- |
| `<HASH>` | The blob hash, `sha256:<hex>`. |

| Option | Description |
| --- | --- |
| `--ttl <TTL>` | How long the link lives, in seconds. |

### marfa blobs stores

Every store the instance has attached, and the copies a blob keeps at the least. Requires `blobs.manage`.

```text
marfa blobs stores [OPTIONS]
```

### marfa blobs locations

The stores recorded as holding one blob's bytes, and when each copy was last found intact.

```text
marfa blobs locations [OPTIONS] <HASH>
```

| Argument | Description |
| --- | --- |
| `<HASH>` | The blob hash, `sha256:<hex>`. |

### marfa blobs delete-location

Remove one store's copy of a blob, where enough live copies remain. Requires `blobs.manage`.

```text
marfa blobs delete-location [OPTIONS] --store <STORE> <HASH>
```

| Argument | Description |
| --- | --- |
| `<HASH>` | The blob hash, `sha256:<hex>`. |

| Option | Description |
| --- | --- |
| `--store <STORE>` | The store whose copy goes, as `blobs stores` names it. |

### marfa blobs orphans

The blobs the last orphan sweep found nothing referencing. Requires `blobs.manage`.

```text
marfa blobs orphans [OPTIONS]
```

## keys

Keys: the credentials that reach the API.

### marfa keys

```text
marfa keys [OPTIONS] <COMMAND>
```

### marfa keys create

Mint a key. Needs `keys.mint` or direct owner/local authority.

The key holds exactly what the flags name. A permission, a map entry or a claim each names a part of what it holds, and a part left unnamed is held as nothing. With none named, the key takes the caller's whole set.

```text
marfa keys create [OPTIONS] --label <LABEL> --source <SOURCE>
```

| Option | Description |
| --- | --- |
| `--label <LABEL>` | What the key is for. |
| `--source <SOURCE>` | The key's own source, which a row written under the key is keyed by and stamped with unless the write names one the key claims. |
| `--permission <PERMISSION>` | A permission, repeatable. One of `schema.write`, `keys.mint`, `items.purge`, `webhooks.manage`, `config.manage`, `audit.read`, `grants.manage`, `instance.read`, `instance.maintain`, `connectors.manage`, `blobs.manage`, `keys.manage`. |
| `--type-permission <PATTERN=LEVEL>` | A type pattern and its level, `core.note=write`, repeatable. |
| `--extension-permission <NAMESPACE=LEVEL>` | An extension namespace and its level, `app.cursor=write`, repeatable. |
| `--edge-permission <TYPE=LEVEL>` | An edge type and its level, `references=write`, repeatable. |
| `--metadata-permission <NAME=LEVEL>` | A kind of registration and its level, `types=write` or `edge_types=write`, repeatable. |
| `--profile-permission <FIELD=LEVEL>` | A profile field and its level, `email=read`, repeatable. |
| `--enforcement-override <JSON>` | The enforcement override, as the JSON object the operation takes. |
| `--claim <SOURCE>` | A source a write under the key may name, so its rows are keyed by it. Repeatable. |
| `--no-claims` | Claim no source besides the key's own, asked for out loud. On a mint naming no permission or map, naming the claims is naming what the key holds: it holds no map and no permission either. |
| `--default-tier <DEFAULT_TIER>` | The tier a write under the key lands at when it names none. One of `library`, `feed`. |
| `--expires-in <DURATION>` | Stop the key working this long from now: a whole number and a unit, `s`, `m`, `h`, `d` or `w`, such as `90m` or `7d`. Measured on this machine's clock. |
| `--expires-at <TIME>` | Stop the key working at this time, as an RFC 3339 time such as `2030-01-31T12:00:00Z`. |
| `--no-permissions` | A key that holds nothing at all, asked for out loud. |

### marfa keys list

List key metadata. Needs `keys.manage`, `keys.mint` (the keys within the caller's reach) or direct owner/local authority.

```text
marfa keys list [OPTIONS]
```

### marfa keys current

The key this call bears, without plaintext: what it holds and what it claims. Any key may read itself.

```text
marfa keys current [OPTIONS]
```

### marfa keys update

Change a key's label, tier, expiry or permission maps. Needs `keys.manage`, `keys.mint` (a key within the caller's reach) or direct owner/local authority.

```text
marfa keys update [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The key id. |

| Option | Description |
| --- | --- |
| `--label <LABEL>` | What the key is for. |
| `--permission <PERMISSION>` | A permission, repeatable. One of `schema.write`, `keys.mint`, `items.purge`, `webhooks.manage`, `config.manage`, `audit.read`, `grants.manage`, `instance.read`, `instance.maintain`, `connectors.manage`, `blobs.manage`, `keys.manage`. |
| `--type-permission <PATTERN=LEVEL>` | A type pattern and its level, `core.note=write`, repeatable. |
| `--extension-permission <NAMESPACE=LEVEL>` | An extension namespace and its level, `app.cursor=write`, repeatable. |
| `--edge-permission <TYPE=LEVEL>` | An edge type and its level, `references=write`, repeatable. |
| `--metadata-permission <NAME=LEVEL>` | A kind of registration and its level, `types=write` or `edge_types=write`, repeatable. |
| `--profile-permission <FIELD=LEVEL>` | A profile field and its level, `email=read`, repeatable. |
| `--enforcement-override <JSON>` | The enforcement override, as the JSON object the operation takes. |
| `--no-type-permissions` | Empty the type permission map on this update. |
| `--no-extension-permissions` | Empty the extension permission map on this update. |
| `--no-edge-permissions` | Empty the edge permission map on this update. |
| `--no-metadata-permissions` | Empty the metadata permission map on this update. |
| `--no-profile-permissions` | Empty the profile permission map on this update. |
| `--claim <SOURCE>` | A source a write under the key may name, so its rows are keyed by it. Repeatable. |
| `--no-claims` | Claim no source besides the key's own, asked for out loud. On a mint naming no permission or map, naming the claims is naming what the key holds: it holds no map and no permission either. |
| `--default-tier <DEFAULT_TIER>` | The tier a write under the key lands at when it names none. One of `library`, `feed`. |
| `--expires-in <DURATION>` | Stop the key working this long from now: a whole number and a unit, `s`, `m`, `h`, `d` or `w`, such as `90m` or `7d`. Measured on this machine's clock. |
| `--expires-at <TIME>` | Stop the key working at this time, as an RFC 3339 time such as `2030-01-31T12:00:00Z`. |
| `--no-expiry` | Clear the key's expiry, so it never expires. |
| `--no-permissions` | Take every permission and every map from the key, so a key minted too wide is narrowed in place. |

### marfa keys revoke

Revoke a key; the next request bearing it is refused. Needs `keys.manage`, `keys.mint` (a key within the caller's reach) or direct owner/local authority.

```text
marfa keys revoke [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The key id. |

### marfa keys keep

Keep a key for this server in the operating system's keychain, and make this server the one a bare command talks to. The key is read from MARFA_API_KEY or from stdin, or from `--key`, which other users of the machine can read in the process list; never from a file.

```text
marfa keys keep [OPTIONS]
```

### marfa keys forget

Forget the key kept for this server.

```text
marfa keys forget [OPTIONS]
```

## config

The instance configuration.

### marfa config

```text
marfa config [OPTIONS] <COMMAND>
```

### marfa config get

The instance configuration: the enforcement levers and the retention overrides. Needs `config.manage`.

```text
marfa config get [OPTIONS]
```

### marfa config replace

Replace the instance configuration whole. Needs `config.manage`.

```text
marfa config replace [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--file <PATH>` | A file holding the JSON body; `-` reads stdin. |
| `--body <JSON>` | The JSON body inline. |

## export

Export the instance's data.

### marfa export

```text
marfa export [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--format <FORMAT>` | `ndjson` for items one per line, `archive` for the whole instance. One of `ndjson`, `archive`. |
| `--output <PATH>` | Where to write. Omitted, the export goes to stdout. |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | One state, or `any`. One of `active`, `archived`, `trashed`, `revoked`, `any`. |
| `--source <SOURCE>` | The source the items were written under. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |

## restore

Restore an archive with direct owner or local authority.

### marfa restore

Preserves item and edge IDs, created_at and updated_at dates, current versions, tags, extensions, and the item's earlier versions carried in the archive. Existing items and their history remain unchanged.

The archive contains only data the exporting credential could read, including history allowed by each snapshot's type permissions and blobs that credential could read. It does not restore keys, webhooks, or configuration. Trashed items are absent unless explicitly exported, for example with `export --format archive --state any`.

Until the first public release, restore only with the server build that wrote the archive. Archive format 0 does not promise compatibility between builds.

```text
marfa restore [OPTIONS] <FILE>
```

| Argument | Description |
| --- | --- |
| `<FILE>` | The archive, as `export --format archive` wrote it. |

## webhooks

Outbound subscriptions that send events out. Every command needs `webhooks.manage`.

### marfa webhooks

```text
marfa webhooks [OPTIONS] <COMMAND>
```

### marfa webhooks create

Register a subscription. The secret is answered once, in plaintext.

```text
marfa webhooks create [OPTIONS] --to <URL> --event <EVENT>
```

| Option | Description |
| --- | --- |
| `--to <URL>` | Where to deliver. Named `--to` rather than `--url`, which is the server. |
| `--event <EVENT>` | An event name from the vocabulary, repeatable; `*` is refused. |
| `--type-filter <TYPE>` | Only events for items of this type. |
| `--secret <SECRET>` | The secret deliveries are signed with. Omitted, the server mints one. |

### marfa webhooks list

Every subscription.

```text
marfa webhooks list [OPTIONS]
```

### marfa webhooks get

One subscription by id.

```text
marfa webhooks get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The webhook id. |

### marfa webhooks update

Change a subscription's URL, events, type filter or whether it is active.

```text
marfa webhooks update [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The webhook id. |

| Option | Description |
| --- | --- |
| `--to <URL>` | Where to deliver. Named `--to` rather than `--url`, which is the server. |
| `--event <EVENT>` | The events, whole; repeatable. |
| `--type-filter <TYPE>` | Only events for items of this type. |
| `--active` | Resume deliveries. |
| `--inactive` | Pause deliveries. |

### marfa webhooks delete

Remove a subscription.

```text
marfa webhooks delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The webhook id. |

### marfa webhooks deliveries

The deliveries a subscription was sent, newest first.

```text
marfa webhooks deliveries [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The webhook id. |

| Option | Description |
| --- | --- |
| `--limit <LIMIT>` | How many at most. |

### marfa webhooks redeliver

Queue a failed delivery again using the subscription's current address.

```text
marfa webhooks redeliver [OPTIONS] <ID> <DELIVERY_ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The webhook id. |
| `<DELIVERY_ID>` | The delivery id. |

## audit

The audit log: every write, with the acting key. Needs `audit.read`.

### marfa audit

```text
marfa audit [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--action <ACTION>` | Only entries with this action, such as `item.create`. |
| `--resource-type <TYPE>` | Only entries about this kind of resource. |
| `--resource-id <ID>` | Only entries about this resource. |
| `--created-after <TIME>` | Exclusive lower bound on the entry's time, RFC 3339. |
| `--created-before <TIME>` | Exclusive upper bound on the entry's time, RFC 3339. |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

## events

The event stream, one frame per line.

### marfa events

```text
marfa events [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | A type identifier to narrow to, repeatable up to ten; subtypes are included. |
| `--edges <EDGES>` | Whether edge events ride along: `all` (the default) or `none`. One of `all`, `none`. |
| `--from <CURSOR>` | Resume from this cursor, replaying what the log holds after it. |
| `--for <SECONDS>` | Stop after this many seconds. Unset, it reads until interrupted. |

## housekeeping

The housekeeping jobs the server runs on itself. Explicit management permission required.

### marfa housekeeping

```text
marfa housekeeping [OPTIONS] <COMMAND>
```

### marfa housekeeping list

Every housekeeping job the server runs on itself: its cadence, when it is next due, and what its last run did. Requires `instance.read`.

```text
marfa housekeeping list [OPTIONS]
```

### marfa housekeeping run

Run one housekeeping job now and report what it did. Requires `instance.maintain`.

```text
marfa housekeeping run [OPTIONS] <NAME>
```

| Argument | Description |
| --- | --- |
| `<NAME>` | The housekeeping job's name, as `housekeeping list` shows it. |

## connectors

Processes that write on a key's behalf: registered, heard from, and reporting their runs. A key registers itself; `connectors.manage` sees every registration and may remove one.

### marfa connectors

```text
marfa connectors [OPTIONS] <COMMAND>
```

### marfa connectors register

Register the key this command runs under as a connector, or answer its registration if it has one: the key is the identity.

```text
marfa connectors register [OPTIONS] --name <NAME>
```

| Option | Description |
| --- | --- |
| `--name <NAME>` | What the connector is called. |
| `--description <DESCRIPTION>` | What it does. |

### marfa connectors list

Registered connectors, newest first: every one with `connectors.manage` or direct owner/local authority, otherwise the key's own.

```text
marfa connectors list [OPTIONS]
```

### marfa connectors get

One connector's registration.

```text
marfa connectors get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

### marfa connectors delete

Remove a registration. The connector's own key, or `connectors.manage`.

```text
marfa connectors delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

### marfa connectors heartbeat

Say the connector is alive. Its own key only.

```text
marfa connectors heartbeat [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

### marfa connectors report

Report one run of the connector. Its own key only.

```text
marfa connectors report [OPTIONS] --outcome <OUTCOME> --started-at <TIME> --finished-at <TIME> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--outcome <OUTCOME>` | How the run ended. One of `succeeded`, `failed`. |
| `--started-at <TIME>` | When the run started, RFC 3339. |
| `--finished-at <TIME>` | When the run finished, RFC 3339. |
| `--summary <SUMMARY>` | What the run did, in a sentence. |
| `--error <ERROR>` | What went wrong, for a run that failed. |

### marfa connectors runs

The runs a connector has reported, newest first.

```text
marfa connectors runs [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--limit <LIMIT>` | How many at most. |

### marfa connectors endpoints

The addresses a sender posts inbound webhooks to.

```text
marfa connectors endpoints [OPTIONS] <COMMAND>
```

### marfa connectors endpoints create

Make an endpoint. Its address is shown in full this once. The connector's own key, or `connectors.manage`.

```text
marfa connectors endpoints create [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--label <LABEL>` | What the endpoint is for. |
| `--duplicate-header <HEADER>` | A header whose value names a delivery, such as X-GitHub-Delivery, so a repeat is marked as one. |

### marfa connectors endpoints list

A connector's endpoints, newest first, each address redacted.

```text
marfa connectors endpoints list [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

### marfa connectors endpoints retire

Retire an endpoint: its address stops answering.

```text
marfa connectors endpoints retire [OPTIONS] <ID> <ENDPOINT>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |
| `<ENDPOINT>` | The endpoint id. |

### marfa connectors deliveries

What arrived at a connector's endpoints. Its own key only.

```text
marfa connectors deliveries [OPTIONS] <COMMAND>
```

### marfa connectors deliveries list

A connector's deliveries, oldest first, the unhandled ones unless --state says otherwise.

```text
marfa connectors deliveries list [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--state <STATE>` | Which deliveries: not yet handled, handled, or both. One of `pending`, `handled`, `any`. |
| `--endpoint <ENDPOINT>` | Only what this endpoint received. |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

### marfa connectors deliveries body

A delivery's body, byte for byte.

```text
marfa connectors deliveries body [OPTIONS] <ID> <DELIVERY>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |
| `<DELIVERY>` | The delivery id. |

| Option | Description |
| --- | --- |
| `--output <PATH>` | Where to write the bytes. Omitted, they go to stdout. |

### marfa connectors deliveries handle

Mark deliveries handled. The first mark stands.

```text
marfa connectors deliveries handle [OPTIONS] --outcome <OUTCOME> <ID> <DELIVERIES>...
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |
| `<DELIVERIES>...` | The delivery ids. |

| Option | Description |
| --- | --- |
| `--outcome <OUTCOME>` | What the connector made of them. One of `processed`, `duplicate`, `rejected`. |

### marfa connectors hold

Take or renew the hold for one process, which alone may then write the state and the agreements. Its own key only.

```text
marfa connectors hold [OPTIONS] --process <PROCESS> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--process <PROCESS>` | The process's own name for itself, such as a UUID. |

### marfa connectors release

Give up the hold, if this process holds it. Its own key only.

```text
marfa connectors release [OPTIONS] --process <PROCESS> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--process <PROCESS>` | The process's own name for itself. |

### marfa connectors state

The state document a connector keeps on the instance.

```text
marfa connectors state [OPTIONS] <COMMAND>
```

### marfa connectors state get

The state document, `{}` until one is written. Its own key only.

```text
marfa connectors state get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

### marfa connectors state put

Replace the state document with a JSON object. Its own key only.

```text
marfa connectors state put [OPTIONS] --process <PROCESS> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--process <PROCESS>` | The process writing, which must hold the registration. |
| `--problems <JSON>` | Current problems as a JSON object of messages. Omit to preserve them; `{}` clears them. |
| `--file <PATH>` | A file holding the JSON body; `-` reads stdin. |
| `--body <JSON>` | The JSON body inline. |

### marfa connectors state delete

Remove the state document, current problems and every agreement. The connector's own key, or `connectors.manage`.

```text
marfa connectors state delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

### marfa connectors agreements

A connector's records of what it and its vendor last agreed about rows. Its own key only.

```text
marfa connectors agreements [OPTIONS] <COMMAND>
```

### marfa connectors agreements write

Set and clear agreements, from a JSON object with `set` and `clear`.

```text
marfa connectors agreements write [OPTIONS] --process <PROCESS> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--process <PROCESS>` | The process writing, which must hold the registration. |
| `--file <PATH>` | A file holding the JSON body; `-` reads stdin. |
| `--body <JSON>` | The JSON body inline. |

### marfa connectors agreements lookup

The agreements of the rows named, each once, in the order first named.

```text
marfa connectors agreements lookup [OPTIONS] <ID> <ITEMS>...
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |
| `<ITEMS>...` | The item ids. |

### marfa connectors agreements list

The agreements, the one written longest ago first.

```text
marfa connectors agreements list [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The connector id. |

| Option | Description |
| --- | --- |
| `--waiting <WAITING>` | Only the ones waiting to be carried to the vendor, or only the others. One of `true`, `false`. |
| `--limit <LIMIT>` | How many at most. |
| `--cursor <CURSOR>` | The cursor the previous page answered with. |

## operations

Every published operation and the command that reaches it.

### marfa operations

```text
marfa operations [OPTIONS]
```

## device

A working copy of a slice of one server, in the store --db names.

### marfa device

```text
marfa device [OPTIONS] <COMMAND>
```

Every `marfa device` command accepts these.

| Option | Description |
| --- | --- |
| `--db <PATH>` | The working copy's database file. Environment variable: `MARFA_DB`. |
| `--reader` | Open the store to read only: never claim the writer role, never write, and refuse a path where no store has been made. |

### marfa device hydrate

Replace the local copy with the declared types at one tier, or both.

```text
marfa device hydrate [OPTIONS] --types <TYPE> --tier <TIER>
```

| Option | Description |
| --- | --- |
| `--types <TYPE>` | Comma-separated type identifiers, such as core.note,core.file. |
| `--tier <TIER>` | The tier to hold the slice at, or `all` for both. One of `library`, `feed`, `all`. |
| `--edge-type <TYPE>` | An edge type to hold whole: every edge of it the key reads, whichever ends the copy holds. Repeatable. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device pin

Hold one row by id whatever the slice says of it, read now and kept current, even after it leaves the slice.

```text
marfa device pin [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device unpin

Stop holding a row by id; one the slice does not take goes.

```text
marfa device unpin [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device catch-up

Apply every event since the last hydrate or catch-up.

```text
marfa device catch-up [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device follow

Hold the event stream open and apply each event as it arrives, printing a line for each that changed the copy.

On a copy never hydrated, or whose hydration was interrupted, it waits for a hydration and asks the server nothing, as an app's follow does. This process holds the store until it ends, so no other can hydrate it meanwhile: hydrate first. An expired copy is refused.

```text
marfa device follow [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--for <SECONDS>` | Stop after this many seconds; without it, follow until interrupted. Either way it ends with its report. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device changes

Print a line each time another process saves to the store. Opens it to read, with or without `--reader`, so watching never takes the writer's place.

```text
marfa device changes [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--for <SECONDS>` | Stop after this many seconds; without it, watch until interrupted. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items

Read items from the local copy.

```text
marfa device items [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items list

List items, newest first unless sorted otherwise.

```text
marfa device items list [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--state <STATE>` | Exactly one state. Unset answers the active state. One of `active`, `archived`, `trashed`, `revoked`. |
| `--all-states` | Every state, not just the active one. |
| `--tier <TIER>` | Only items at this tier. One of `library`, `feed`. |
| `--tag <TAG>` | Items must carry every tag given. |
| `--occurred-after <TIME>` | Exclusive lower bound on the item's own time, RFC 3339. |
| `--occurred-before <TIME>` | Exclusive upper bound on the item's own time, RFC 3339. |
| `--filter <EXPR>` | An expression in the server's listing grammar, answered as the server answers `filter`; a `backref` condition is refused. |
| `--beneath <ID>` | Only this item and what it reaches along `parent-of` edges. |
| `--sort <SORT>` | The time to order by. One of `created-at`, `updated-at`, `occurred-at`. Default: `created-at`. |
| `--direction <DIRECTION>` | Newest first, or oldest. One of `asc`, `desc`. Default: `desc`. |
| `--limit <LIMIT>` | How many items at most. |
| `--offset <OFFSET>` | How many items to skip first. |
| `--folder <ID>` | Only what this `system.folder`'s search holds, as the folder holds it; refused where the copy's slice cannot answer the search whole. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items get

One item by id, with its properties and tags.

```text
marfa device items get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items create

Write a new item into the local copy and queue it for the server.

```text
marfa device items create [OPTIONS] --type <TYPE> --properties <JSON>
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | The type the item is. |
| `--properties <JSON>` | The properties, as a JSON object. |
| `--tag <TAG>` | A tag, repeatable. Each is queued as a write of its own. |
| `--tier <TIER>` | The tier to write it at; the default is the tier of the held row its natural key names, else the slice's tier, or the library from a slice of both or before a first hydration. One of `library`, `feed`. |
| `--source <SOURCE>` | The source to stamp it with. |
| `--source-id <SOURCE_ID>` | The id this row has in the system it came from. |
| `--occurred-at <OCCURRED_AT>` | The item's own time, RFC 3339. Defaults to now. |
| `--id <ID>` | The id to mint it under. Omitted, the device mints one. |
| `--version <VERSION>` | The version this create is conditional on, where its natural key resolves a row the server already holds. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items update

Change an item in the local copy and queue the change.

```text
marfa device items update [OPTIONS] --properties <JSON> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--properties <JSON>` | The properties to write, as a JSON object. Whole values. |
| `--version <VERSION>` | The version the edit was based on. Required: the device refuses an update that names no version, as the server does. |
| `--source-id <KEY>` | The natural key to move the row to. The server refuses one another item already holds, so a rename does not take a name off a note. |
| `--as-read` | The version is one read before the version the copy holds now, and the server merges the edit against it rather than taking it as newer than what came in since. |
| `--type <TYPE>` | The type to move the item to. The server holds its properties to the type it enters. |
| `--tier <TIER>` | The tier to move the item to. One of `library`, `feed`. |
| `--replace` | The properties are the item's whole properties: one they leave out is cleared rather than kept. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items delete

Move an item to the bin locally and queue the delete.

```text
marfa device items delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items purge

Destroy an item in the bin on the server now, and take it out of the local copy. Never queued: it needs the server, a key holding `items.purge` and write on the item's type, and an item the copy holds in the bin with no write to it waiting.

```text
marfa device items purge [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--version <VERSION>` | The version the item was read at in the bin; without it the copy's own, and an item the copy does not hold is refused. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items bin

Read a page of the server's bin, newest change first. Online only, and held nowhere in the copy; each item's `updated_at` stands for when it went to the bin.

```text
marfa device items bin [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--cursor <CURSOR>` | Where the page starts, as the last page's `next_cursor` named it. |
| `--limit <LIMIT>` | How many items at most, up to 100. Default: `50`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items restore

Take an item out of the bin and queue the restore: locally where the copy holds it, and by id where it does not.

```text
marfa device items restore [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items transition

Move an item to another lifecycle state.

```text
marfa device items transition [OPTIONS] --state <STATE> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--state <STATE>` | The state to move it to. `revoked` is the server's alone. One of `active`, `archived`, `trashed`, `revoked`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items add

Add a file as an item of its own: its upload and a file item naming the bytes, two queued writes, and one for each tag.

```text
marfa device items add [OPTIONS] <FILE>
```

| Argument | Description |
| --- | --- |
| `<FILE>` | The file to add. |

| Option | Description |
| --- | --- |
| `--mime-type <MIME_TYPE>` | The MIME type; the default comes from the file's extension. |
| `--title <TITLE>` | The file item's title; the default is the file's name. |
| `--type <TYPE>` | The file item's type; the default comes from the MIME type. |
| `--tag <TAG>` | A tag, repeatable. Each is queued as a write of its own. |
| `--tier <TIER>` | The tier to write the file item at. One of `library`, `feed`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items attach

Attach a file to an item: its upload, a file item naming the bytes, and an `attached-to` edge, three queued writes.

Answers the text that embeds the file in the item's body, `![[title]]`, where the file's title names it alone among the item's attachments. Under --json the answer is one object: `upload`, `item` and `edge`, each a queued write, and `embed`, the text or null.

```text
marfa device items attach [OPTIONS] <ID> <FILE>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item to attach the file to. |
| `<FILE>` | The file to attach. |

| Option | Description |
| --- | --- |
| `--mime-type <MIME_TYPE>` | The MIME type; the default comes from the file's extension. |
| `--title <TITLE>` | The file item's title; the default is the file's name. |
| `--type <TYPE>` | The file item's type; the default comes from the MIME type. |
| `--tier <TIER>` | The tier to write the file item at. One of `library`, `feed`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items links

The links and embeds of files in an item's body, read from the local copy: each with the item it names, or why it names none yet.

```text
marfa device items links [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items embed

The text that embeds a file item in an item's body, which reads back as the file's `attached-to` edge to the item.

```text
marfa device items embed [OPTIONS] <ID> <FILE>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item whose body the embed goes in. |
| `<FILE>` | The file item to embed. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device items thumbnail

The thumbnail an item carries, read from the local copy with no request: its MIME type and size, and its bytes written to `--out`.

```text
marfa device items thumbnail [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The item id. |

| Option | Description |
| --- | --- |
| `--out <FILE>` | Where to write the image's bytes. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device folders

Folders' settings: read from the copy, written through the folder operations.

```text
marfa device folders [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device folders create

Create a folder's settings through the folder operations, at once and never queued; settings no folder follows are refused before they are sent.

```text
marfa device folders create [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--file <PATH>` | A file holding the settings as a JSON object; `-` reads stdin. |
| `--body <JSON>` | The settings as a JSON object, inline. |
| `--title <TITLE>` | The folder's name. |
| `--search <JSON>` | Which items the folder holds, as a JSON object: `types`, `tier`, `state`, `filter` and `beneath`. |
| `--defaults <JSON>` | What a new file takes where it leaves a blank, as a JSON object: `type`, `tier`, `properties`, `tags` and `edges`. |
| `--include <PATTERN>` | A gitignore pattern for the paths the folder takes, repeatable; a dot-led path only where a pattern names it, and never a secret. |
| `--ignore <PATTERN>` | A gitignore pattern for the paths the folder leaves alone, repeatable; it wins over an include pattern. |
| `--first-placement <TYPE=DIR>` | Where a new item of a type made elsewhere first appears, as TYPE=DIR relative to the folder's root, repeatable. |
| `--removal-threshold <JSON>` | When a removal pauses, as a JSON object: `files` and `fraction`. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device folders change

Change a folder's settings through the folder operations, at once, each named one replaced whole.

```text
marfa device folders change [OPTIONS] --version <VERSION> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The folder's `system.folder` id. |

| Option | Description |
| --- | --- |
| `--version <VERSION>` | The version the change was based on. |
| `--file <PATH>` | A file holding the settings as a JSON object; `-` reads stdin. |
| `--body <JSON>` | The settings as a JSON object, inline. |
| `--title <TITLE>` | The folder's name. |
| `--search <JSON>` | Which items the folder holds, as a JSON object: `types`, `tier`, `state`, `filter` and `beneath`. |
| `--defaults <JSON>` | What a new file takes where it leaves a blank, as a JSON object: `type`, `tier`, `properties`, `tags` and `edges`. |
| `--include <PATTERN>` | A gitignore pattern for the paths the folder takes, repeatable; a dot-led path only where a pattern names it, and never a secret. |
| `--ignore <PATTERN>` | A gitignore pattern for the paths the folder leaves alone, repeatable; it wins over an include pattern. |
| `--first-placement <TYPE=DIR>` | Where a new item of a type made elsewhere first appears, as TYPE=DIR relative to the folder's root, repeatable. |
| `--removal-threshold <JSON>` | When a removal pauses, as a JSON object: `files` and `fraction`. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device folders revoke

Retire a folder's settings through the folder operations, at once. A revoked folder does not change.

```text
marfa device folders revoke [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The folder's `system.folder` id. |

| Option | Description |
| --- | --- |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device folders get

A folder's settings as the copy holds them.

```text
marfa device folders get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The folder's `system.folder` id. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device search

Full-text search over the local copy, best match first.

```text
marfa device search [OPTIONS] <QUERY>
```

| Argument | Description |
| --- | --- |
| `<QUERY>` | Words to look for, matched as the server matches them: all must match, the last as a prefix, and a query in double quotes is a phrase. |

| Option | Description |
| --- | --- |
| `--state <STATE>` | Exactly one state. Unset answers the active state. One of `active`, `archived`, `trashed`, `revoked`. |
| `--all-states` | Every state, not just the active one. |
| `--type <TYPE>` | A type identifier; its subtypes are included. |
| `--tag <TAG>` | Hits must carry every tag given. |
| `--filter <EXPR>` | An expression in the server's listing grammar, answered as the server answers `filter`; a `backref` condition is refused. |
| `--beneath <ID>` | Only this item and what it reaches along `parent-of` edges. |
| `--limit <LIMIT>` | How many hits at most. Default: `20`. |
| `--folder <ID>` | Only what this `system.folder`'s search holds, as the folder holds it; refused where the copy's slice cannot answer the search whole. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device queue

Every queued write, the body it carries and what became of it.

```text
marfa device queue [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device drain

Send what the queue holds and record what came back.

One pass. A write that met a network rather than an answer is left where it was, uncounted, for the next drain.

```text
marfa device drain [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device forget

Clear the writes the server has answered.

A queue nobody empties makes every later write slower. Blocked and dead rows stay, because a caller may still release them, and so does a refused write that carried content, until it is discarded.

```text
marfa device forget [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device discard

Take a refused write out of the queue, with the content it carried.

The one way a refused create, edit, metadata, extension or edge write leaves the queue. A write still waiting on it keeps it.

```text
marfa device discard [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The refused write to discard. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device release

Send a blocked, dead or unsent refused write again, under a fresh key.

A write blocked `awaiting_dependency` is released only by the answer to the write it waits behind, never by this command.

```text
marfa device release [OPTIONS] [ID]
```

| Argument | Description |
| --- | --- |
| `[ID]` | The queued write to release. |

| Option | Description |
| --- | --- |
| `--reason <REASON>` | Release every write blocked for this reason instead of one by id. One of `credential_refused`, `key_spent`, `ancestor_unavailable`, `conflict_unresolved`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device withdraw

Take a write blocked `ancestor_unavailable` or `conflict_unresolved` out of the queue, and put the copy back to what the server holds.

Sent again, such a write is refused the same way under any key. The writes held for it are refused unsent.

```text
marfa device withdraw [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The queued write to withdraw. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device status

What the local copy holds and where it came from.

```text
marfa device status [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device types

The item types the copy holds, read from it alone, the ones an app declares for it, and the server's.

```text
marfa device types [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device types list

Every one the copy holds, by id.

```text
marfa device types list [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device types served

Every one the server holds, read from it now, so a slice can be chosen before a first hydration. The copy is left as it is.

```text
marfa device types served [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device types get

One by id; a type inherits the fields of the types above it.

```text
marfa device types get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The id, such as `core.note`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device types declare

Declare the types this app saves, so a copy with no server checks what it queues against them and a hydration registers the ones the instance lacks, where the key may.

Marfa's own types need no declaring. The call is the app's whole set, so it replaces every earlier declaration.

```text
marfa device types declare [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--definitions <JSON>` | A type definition, or an array of them, as JSON. |
| `--file <PATH>` | A file holding the same. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device types declared

The declarations this copy holds, with the empty `fields` and the `version` a registration needs filled in.

```text
marfa device types declared [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edge-types

The edge types the copy holds, read from it alone, and the server's.

```text
marfa device edge-types [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edge-types list

Every one the copy holds, by id.

```text
marfa device edge-types list [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edge-types served

Every one the server holds, read from it now, so a slice can be chosen before a first hydration. The copy is left as it is.

```text
marfa device edge-types served [OPTIONS]
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edge-types get

One by id; a type inherits the fields of the types above it.

```text
marfa device edge-types get [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The id, such as `core.note` or `parent-of`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edges

Edges between items, each its own write.

```text
marfa device edges [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edges list

The edges the copy holds from one item.

```text
marfa device edges list [OPTIONS] <ITEM>
```

| Argument | Description |
| --- | --- |
| `<ITEM>` | The item the edges start from. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edges to

The edges the copy holds to one item.

```text
marfa device edges to [OPTIONS] <ITEM>
```

| Argument | Description |
| --- | --- |
| `<ITEM>` | The item the edges point at. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edges create

Link two items, and queue the edge.

```text
marfa device edges create [OPTIONS] --source <ID> --target <ID> --type <TYPE>
```

| Option | Description |
| --- | --- |
| `--source <ID>` | The item the edge starts from. |
| `--target <ID>` | The item the edge points at. |
| `--type <TYPE>` | The edge type. |
| `--properties <JSON>` | The edge's properties, as a JSON object. Default: `{}`. |
| `--id <ID>` | The id to mint it under. Omitted, the device mints one. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edges update

Change an edge's properties, or move one of its ends. An edit that names no property and no new end queues no write.

```text
marfa device edges update [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The edge id. |

| Option | Description |
| --- | --- |
| `--properties <JSON>` | The properties to write, as a JSON object. Whole values. Default: `{}`. |
| `--version <VERSION>` | The version the edit was based on. Required, as on an item. |
| `--source <ID>` | Move the edge to this source, where each target holds one of its type. |
| `--target <ID>` | Move the edge to this target, where each source holds one of its type. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device edges delete

Drop an edge locally and queue the delete.

```text
marfa device edges delete [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The edge id. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device tags

Tags on an item, each its own write.

```text
marfa device tags [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device tags add

Put one tag on an item.

```text
marfa device tags add [OPTIONS] <ITEM> <TAG>
```

| Argument | Description |
| --- | --- |
| `<ITEM>` | The item id. |
| `<TAG>` | The tag. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device tags remove

Take one tag off an item.

```text
marfa device tags remove [OPTIONS] <ITEM> <TAG>
```

| Argument | Description |
| --- | --- |
| `<ITEM>` | The item id. |
| `<TAG>` | The tag. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device metadata

An item's metadata, written whole or merged.

```text
marfa device metadata [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device metadata replace

Write the item's tags whole, dropping any not named.

```text
marfa device metadata replace [OPTIONS] <ITEM>
```

| Argument | Description |
| --- | --- |
| `<ITEM>` | The item id. |

| Option | Description |
| --- | --- |
| `--tag <TAG>` | A tag, repeatable. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device metadata merge

Add the named tags, leaving the rest.

```text
marfa device metadata merge [OPTIONS] <ITEM>
```

| Argument | Description |
| --- | --- |
| `<ITEM>` | The item id. |

| Option | Description |
| --- | --- |
| `--tag <TAG>` | A tag, repeatable. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device extensions

An item's extension namespaces, each its own write.

```text
marfa device extensions [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device extensions write

Write one extension namespace.

```text
marfa device extensions write [OPTIONS] <ITEM> <NAMESPACE>
```

| Argument | Description |
| --- | --- |
| `<ITEM>` | The item id. |
| `<NAMESPACE>` | The extension namespace. |

| Option | Description |
| --- | --- |
| `--body <JSON>` | The namespace's contents, as a JSON object. Default: `{}`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device extensions delete

Remove one extension namespace.

```text
marfa device extensions delete [OPTIONS] <ITEM> <NAMESPACE>
```

| Argument | Description |
| --- | --- |
| `<ITEM>` | The item id. |
| `<NAMESPACE>` | The extension namespace. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device blobs

Blobs' bytes: uploaded as queued writes, fetched when asked for.

```text
marfa device blobs [OPTIONS] <COMMAND>
```

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device blobs put

Hold a file's bytes beside the store and queue their upload.

```text
marfa device blobs put [OPTIONS] <FILE>
```

| Argument | Description |
| --- | --- |
| `<FILE>` | The file to upload. |

| Option | Description |
| --- | --- |
| `--mime-type <MIME_TYPE>` | The MIME type to send them under; the default comes from the file's extension. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

### marfa device blobs get

Print where a blob's bytes are held, fetching them first where the store does not hold them yet.

```text
marfa device blobs get [OPTIONS] <HASH>
```

| Argument | Description |
| --- | --- |
| `<HASH>` | The blob's hash, `sha256:<hex>`. |

Also accepts the options of `marfa device`: `--db <PATH>` and `--reader`.

## folders

Folders on this machine, a directory that holds a slice as files, and their settings on the server.

### marfa folders

```text
marfa folders [OPTIONS] <COMMAND>
```

### marfa folders add

Make a directory a folder that follows a `system.folder`'s settings, which `folders create` makes. Needs read on `system.folder`.

```text
marfa folders add [OPTIONS] --folder <ID> <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The directory. It is made if it is not there. |

| Option | Description |
| --- | --- |
| `--folder <ID>` | The folder's `system.folder` id. |
| `--yes` | Confirm the first sync without asking, for scripts. Without it, the add says what the first sync will do and waits for a go-ahead. |

### marfa folders list

List the folders on this machine, as its registry holds them. The registry is the file MARFA_FOLDER_REGISTRY names, where it names one.

```text
marfa folders list [OPTIONS]
```

### marfa folders remove

Take a folder off this machine: its own state under `.marfa` goes, and its files stay as plain files. Empty administrative directories remain. Refused while writes wait, except for a first sync still waiting to be confirmed, which this cancels. Follows no symbolic link, and takes a path through one only where it is the path `folders list` shows. Where that path is gone, passes through a link, or holds state the registry does not show to be the folder's own, the folder is only taken off the list and nothing is deleted.

```text
marfa folders remove [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The folder. |

### marfa folders status

Say where every file in the folder stands, from its own store, asking the server nothing.

```text
marfa folders status [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The folder. |

### marfa folders health

Read the server's latest reports from every sign-in and local copy. Receipt ages describe reports; they do not establish current reachability.

```text
marfa folders health [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The folder's `system.folder` id. |

### marfa folders confirm

Let a folder's first sync go, or a paused large removal: its deletes are queued, and files whose items left elsewhere are taken away.

```text
marfa folders confirm [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The folder. |

### marfa folders restore

Cancel a paused large removal: files gone from the disk are written back, and items that left elsewhere are restored.

```text
marfa folders restore [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The folder. |

### marfa folders hydrate

Pull what the folder's search needs into its working copy.

```text
marfa folders hydrate [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The folder. |

### marfa folders scan

Read the folder and queue what has changed. Sends nothing.

```text
marfa folders scan [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The folder. |

### marfa folders pull

Write what the folder's search matches out as files.

```text
marfa folders pull [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The folder. |

### marfa folders push

Scan, drain, catch up, pull, and send the placements the pull queued: everything a folder does, once.

```text
marfa folders push [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The folder. |

### marfa folders create

Create a folder's settings on the server, as a `system.folder`. Needs write on `system.folder`.

```text
marfa folders create [OPTIONS]
```

| Option | Description |
| --- | --- |
| `--file <PATH>` | A file holding the settings as a JSON object; `-` reads stdin. |
| `--body <JSON>` | The settings as a JSON object, inline. |
| `--title <TITLE>` | The folder's name. |
| `--search <JSON>` | Which items the folder holds, as a JSON object: `types`, `tier`, `state`, `filter` and `beneath`. |
| `--defaults <JSON>` | What a new file takes where it leaves a blank, as a JSON object: `type`, `tier`, `properties`, `tags` and `edges`. |
| `--include <PATTERN>` | A gitignore pattern for the paths the folder takes, repeatable; a dot-led path only where a pattern names it, and never a secret. |
| `--ignore <PATTERN>` | A gitignore pattern for the paths the folder leaves alone, repeatable; it wins over an include pattern. |
| `--first-placement <TYPE=DIR>` | Where a new item of a type made elsewhere first appears, as TYPE=DIR relative to the folder's root, repeatable. |
| `--removal-threshold <JSON>` | When a removal pauses, as a JSON object: `files` and `fraction`. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa folders change

Change a folder's settings on the server, each named one replaced whole.

```text
marfa folders change [OPTIONS] --version <VERSION> <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The folder's `system.folder` id. |

| Option | Description |
| --- | --- |
| `--version <VERSION>` | The version the change was based on. |
| `--file <PATH>` | A file holding the settings as a JSON object; `-` reads stdin. |
| `--body <JSON>` | The settings as a JSON object, inline. |
| `--title <TITLE>` | The folder's name. |
| `--search <JSON>` | Which items the folder holds, as a JSON object: `types`, `tier`, `state`, `filter` and `beneath`. |
| `--defaults <JSON>` | What a new file takes where it leaves a blank, as a JSON object: `type`, `tier`, `properties`, `tags` and `edges`. |
| `--include <PATTERN>` | A gitignore pattern for the paths the folder takes, repeatable; a dot-led path only where a pattern names it, and never a secret. |
| `--ignore <PATTERN>` | A gitignore pattern for the paths the folder leaves alone, repeatable; it wins over an include pattern. |
| `--first-placement <TYPE=DIR>` | Where a new item of a type made elsewhere first appears, as TYPE=DIR relative to the folder's root, repeatable. |
| `--removal-threshold <JSON>` | When a removal pauses, as a JSON object: `files` and `fraction`. |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa folders revoke

Retire a folder's settings on the server. A revoked folder does not change.

```text
marfa folders revoke [OPTIONS] <ID>
```

| Argument | Description |
| --- | --- |
| `<ID>` | The folder's `system.folder` id. |

| Option | Description |
| --- | --- |
| `--idempotency-key <KEY>` | Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written twice. |

### marfa folders watch

Watch a folder and keep it in step.

```text
marfa folders watch [OPTIONS] <DIR>
```

| Argument | Description |
| --- | --- |
| `<DIR>` | The directory to watch, recursively. |

| Option | Description |
| --- | --- |
| `--for <SECONDS>` | Stop after this long. Unset, it runs until interrupted. |

## docs

Read Marfa's public docs: search them, list their pages, or print one.

### marfa docs

Reads the docs site at https://docs.marfa.so, or at the address in MARFA_DOCS_URL. It needs no server, store or key, and sends no credential.

A page is its path on the site. `files`, `/files`, `files.md` and `https://docs.marfa.so/files` name the same page. `search`, `topics` and `help` are commands, so a page with one of those names takes a leading slash, such as `/search`.

`--url` and `--key` name a Marfa server, so this command refuses them.

```text
marfa docs [OPTIONS] [PAGE]
marfa docs <COMMAND>
```

| Argument | Description |
| --- | --- |
| `[PAGE]` | The page to print, as Markdown: its path on the docs site, or its address. |

Examples:

```text
marfa docs search "restore an archive" --limit 5
marfa docs topics
marfa docs files
```

### marfa docs search

Search the docs, best match first: each page's title, address and a snippet.

```text
marfa docs search [OPTIONS] <QUERY>
```

| Argument | Description |
| --- | --- |
| `<QUERY>` | What to look for. |

| Option | Description |
| --- | --- |
| `--limit <N>` | How many pages at most, 1 to 50. Unset takes the site's own default. |

### marfa docs topics

Every docs page: its title, address and description.

```text
marfa docs topics [OPTIONS]
```
