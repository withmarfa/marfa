<!-- Generated from the command tree by `MARFA_WRITE_COMMANDS=1 cargo test -p marfa-cli --bin marfa reference`. Do not edit by hand. -->

# marfa command reference

Global options, which every command accepts, and the exit codes:

```text
Marfa from the command line: every operation of one instance, a working copy of a slice of it under
`device`, and folders that hold a slice as files

Usage: marfa [OPTIONS] <COMMAND>

Options:
  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr

Exit codes:
  0  done
  1  the request was refused, by the server, by the binary before
     sending, or for an answer on another contract; a retry does not
     change it
  2  the command line was wrong, or named no store or server
  3  the environment failed (unreachable, timed out, a 5xx, a 429, an
     answer naming no contract, full local storage); try again
  4  the working copy or the queue refused under the device rules, or
     this system has no keychain
  5  no credential, the credential was refused, or the sign-in ended;
     `marfa login` starts one

A device drain prints its complete report on stdout: 0 for a completed pass (including refused
writes), 3 for undelivered writes or an unavailable pass, and 5 for a credential-stopped pass. A
report exit prints no additional refusal on stderr. Refused verdicts have a separate plain-text
count.

With --json a refusal is one JSON object on stderr:
  {"error":{"code":...,"message":...,"server":{"status":...,"code":...,"details":...}|null,"retry_after_seconds":...},"exit":N}
where error.code is one of: not_found, unauthorized, forbidden, validation, unknown_type,
rate_limited, server, io, network, unnamed_answer, decoding, store, storage_full, signed_out,
no_keychain, redirect, no_server, no_cursor, hydration_incomplete, no_catalog, reading_handle,
wrong_schema, copy_expired, stream_incomplete, wrong_server, bytes_absent, contract_mismatch,
canceled, first_sync_waiting, invalid, not_held, watch, usage, no_store, no_credential, conflict,
too_large.
```

## status

### marfa status

```text
What the instance says about itself, and item counts where the credential reaches them

Usage: marfa status [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## whoami

### marfa whoami

```text
Which server, instance and credential a bare command would use

Usage: marfa whoami [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## login

### marfa login

```text
Sign in to a server as the owner: a code, approved in the browser

Usage: marfa login [OPTIONS]

Options:
      --scope <SCOPE>
          The scopes to ask for. Defaults to everything an owner can hold that the server supports;
          the consent screen narrows it

      --no-browser
          Print the page to open rather than opening it

      --print-token
          Print the token set instead of keeping it in the keychain

      --client-id <ID>
          The client id an earlier sign-in registered, where no keychain remembers it; without one
          the binary registers again

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## logout

### marfa logout

```text
Sign out of a server: the token is revoked and forgotten

Usage: marfa logout [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## owner

### marfa owner

```text
The owner: the one account behind the sign-in surface

Usage: marfa owner [OPTIONS] <COMMAND>

Commands:
  show    Who owns this instance. Operator key
  create  Create the owner, once. The password is asked for on the terminal, or read from stdin with
          --password-stdin; it is never an argument. Operator key
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa owner show

```text
Who owns this instance. Operator key

Usage: marfa owner show [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa owner create

```text
Create the owner, once. The password is asked for on the terminal, or read from stdin with
--password-stdin; it is never an argument. Operator key

Usage: marfa owner create [OPTIONS] --email <EMAIL>

Options:
      --email <EMAIL>
          The owner's email address, which is what they sign in with

      --name <NAME>
          A display name. The address's local part when absent

      --password-stdin
          Read the password from stdin (the first line) instead of the terminal

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## items

### marfa items

```text
Items: create, read, change, tag, link, attach, and the bulk doors

Usage: marfa items [OPTIONS] <COMMAND>

Commands:
  list         List items on the server, a page at a time
  get          One item by id
  create       Create an item
  update       Change an item's properties or fields, conditional on the version read
  delete       Move an item to the bin
  restore      Take an item out of the bin
  transition   Move an item to another lifecycle state
  purge        Destroy a trashed item irrecoverably. Needs `items.purge`
  versions     One page of the snapshots an item's history holds, oldest first. Pass the answer's
               `next_cursor` as `--cursor` for the next page
  tag          Put tags on an item
  untag        Take one tag off an item
  edges        The edges leaving an item
  backrefs     The edges arriving at an item
  add          Add a file as an item of its own: upload its bytes and create a file item for them
  attach       Attach a file: upload its bytes, create a file item for them, and link it to the
               target with an `attached-to` edge
  stats        Item counts, by state or by type
  occurrences  Occurrences of `core.event` items in a window
  bulk         Upsert many items in one request
  bulk-get     Read many items by id in one request
  lookup       Items by link, natural key or id, in every state, with the tombstones purges left for
               the keys named
  tombstones   Settle the tombstones purges left at a later time
  bulk-action  Apply one action to every item a filter selects, as a job
  help         Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items list

```text
List items on the server, a page at a time

Usage: marfa items list [OPTIONS]

Options:
      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state, or `any`. Unset answers the active state

          [possible values: active, archived, trashed, revoked, any]

      --source <SOURCE>
          The source the items were written under

      --tier <TIER>
          One tier, or `all`

          [possible values: library, feed, all]

      --tag <TAG>
          Items must carry every tag given

      --filter <FILTER>
          A property filter in the server's filter grammar

      --sort <SORT>
          The field to order by; the server's default is the creation time

          [possible values: created-at, updated-at, occurred-at]

      --direction <DIRECTION>
          `asc` or `desc`; the server's default is newest first

          [possible values: asc, desc]

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --updated-after <TIME>
          Inclusive lower bound on the modification time: the catch-up filter

      --updated-before <TIME>
          Exclusive upper bound on the modification time

      --include <NAME>
          Extra to hydrate onto each item: `edges`, `metadata`

      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items get

```text
One item by id

Usage: marfa items get [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --include <LIST>
          Extra to hydrate onto the item: `edges`, `metadata`, or both comma-separated

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items create

```text
Create an item

Usage: marfa items create [OPTIONS] --type <TYPE>

Options:
      --type <TYPE>
          The type the item is

      --properties <JSON>
          The properties, as a JSON object

      --prop <KEY=VALUE>
          One property as key=value, repeatable. The value is a string

      --tag <TAG>
          A tag, repeatable

      --tier <TIER>
          The tier to write it at; the server's default is the library

          [possible values: library, feed]

      --state <STATE>
          The state to create it in

          [possible values: active, archived, trashed, revoked]

      --occurred-at <TIME>
          The item's own time, RFC 3339. Defaults to now

      --source <SOURCE>
          The source to key and stamp it with: the key's own, or one it claims. Any other is refused

      --source-id <SOURCE_ID>
          The id this row has in the system it came from: the natural key

      --id <ID>
          The id to mint it under. Omitted, the server mints one

      --version <VERSION>
          The version this create is conditional on, where its natural key resolves a row the server
          already holds

      --edges <JSON>
          Edges to write with it, as the JSON object the door takes

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items update

```text
Change an item's properties or fields, conditional on the version read

Usage: marfa items update [OPTIONS] --version <VERSION> <ID>

Arguments:
  <ID>
          The item id

Options:
      --version <VERSION>
          The version the edit was based on. Required: a write that names no version overwrites
          whatever it finds

      --properties <JSON>
          The properties, as a JSON object

      --prop <KEY=VALUE>
          One property as key=value, repeatable. The value is a string

      --replace
          Replace the properties whole instead of merging the ones given

      --type <TYPE>
          Move the item to this type

      --retype
          Let the type change even where the target type is enforced

      --tier <TIER>
          The tier to move the item to

          [possible values: library, feed]

      --occurred-at <TIME>
          The item's own time, RFC 3339

      --source-id <KEY>
          The natural key to move the row to. The server refuses one another item already holds

      --edges <JSON>
          Edges to write with it, as the JSON object the door takes

      --conflict <CONFLICT>
          How a colliding write is settled: `auto` asks the server to resolve within its own
          transaction

          [possible values: auto, manual, callback]

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items delete

```text
Move an item to the bin

Usage: marfa items delete [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items restore

```text
Take an item out of the bin

Usage: marfa items restore [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items transition

```text
Move an item to another lifecycle state

Usage: marfa items transition [OPTIONS] --state <STATE> <ID>

Arguments:
  <ID>
          The item id

Options:
      --state <STATE>
          The state to move it to

          [possible values: active, archived, trashed]

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items purge

```text
Destroy a trashed item irrecoverably. Needs `items.purge`

Usage: marfa items purge [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items versions

```text
One page of the snapshots an item's history holds, oldest first. Pass the answer's `next_cursor` as
`--cursor` for the next page

Usage: marfa items versions [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items tag

```text
Put tags on an item

Usage: marfa items tag [OPTIONS] <ID> <TAGS>...

Arguments:
  <ID>
          The item id

  <TAGS>...
          One or more tags

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items untag

```text
Take one tag off an item

Usage: marfa items untag [OPTIONS] <ID> <TAG>

Arguments:
  <ID>
          The item id

  <TAG>
          The tag to take off

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items edges

```text
The edges leaving an item

Usage: marfa items edges [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --type <TYPE>
          Only edges of this type

      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items backrefs

```text
The edges arriving at an item

Usage: marfa items backrefs [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --type <TYPE>
          Only edges of this type

      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items add

```text
Add a file as an item of its own: upload its bytes and create a file item for them

Usage: marfa items add [OPTIONS] <FILE>

Arguments:
  <FILE>
          The file to add

Options:
      --mime-type <TYPE>
          The file's MIME type. Guessed from the extension when omitted

      --title <TITLE>
          The file item's title. Defaults to the file's name

      --type <TYPE>
          The file item's type. Defaults to `core.file`, or the image, audio or video subtype when
          the MIME type says

      --tag <TAG>
          A tag, repeatable

      --tier <TIER>
          The tier to write it at; the server's default is the library

          [possible values: library, feed]

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items attach

```text
Attach a file: upload its bytes, create a file item for them, and link it to the target with an
`attached-to` edge

Usage: marfa items attach [OPTIONS] <ID> <FILE>

Arguments:
  <ID>
          The item the file belongs to

  <FILE>
          The file to attach

Options:
      --mime-type <TYPE>
          The file's MIME type. Guessed from the extension when omitted

      --title <TITLE>
          The file item's title. Defaults to the file's name

      --type <TYPE>
          The file item's type. Defaults to `core.file`, or the image, audio or video subtype when
          the MIME type says

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items stats

```text
Item counts, by state or by type

Usage: marfa items stats [OPTIONS]

Options:
      --by <BY>
          What to count by

          [possible values: state, type]

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items occurrences

```text
Occurrences of `core.event` items in a window

Usage: marfa items occurrences [OPTIONS] --from <TIME> --to <TIME>

Options:
      --from <TIME>
          The window's start, RFC 3339

      --to <TIME>
          The window's end, RFC 3339

      --type <TYPE>
          A type identifier to narrow to

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk

```text
Upsert many items in one request

Usage: marfa items bulk [OPTIONS] --file <PATH>

Options:
      --file <PATH>
          A JSON file holding the items, or the whole body with `items` in it; `-` reads stdin

      --mode <MODE>
          `upsert` or `create_only`

      --atomic
          Refuse the whole request if any entry is refused

      --no-fanout
          Do not deliver the writes to webhooks

      --retype
          Let entries change the type of the rows they land on

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-get

```text
Read many items by id in one request

Usage: marfa items bulk-get [OPTIONS] <IDS>...

Arguments:
  <IDS>...
          The item ids

Options:
      --include <NAME>
          Extra to hydrate onto each item: `edges`, `metadata`

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items lookup

```text
Items by link, natural key or id, in every state, with the tombstones purges left for the keys named

Usage: marfa items lookup [OPTIONS] --type <TYPE>

Options:
      --type <TYPE>
          The type the links are held in and the tombstones kept under

      --link <VALUE>
          A link value; repeat for more

      --source <SOURCE>
          The source the `--source-id` natural keys are under

      --source-id <ID>
          A natural key's `source_id`; repeat for more

      --id <ID>
          An item id; repeat for more

      --include <NAME>
          Extra to hydrate onto each item: `edges`

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items tombstones

```text
Settle the tombstones purges left at a later time

Usage: marfa items tombstones [OPTIONS] --type <TYPE> --settled-at <TIME>

Options:
      --type <TYPE>
          The type the tombstones are kept under

      --link <VALUE>
          A link value; repeat for more

      --source <SOURCE>
          The source the `--source-id` natural keys are under

      --source-id <ID>
          A natural key's `source_id`; repeat for more

      --settled-at <TIME>
          The vendor-side change time, RFC 3339; one earlier than a tombstone holds leaves it as it
          is

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action

```text
Apply one action to every item a filter selects, as a job

Usage: marfa items bulk-action [OPTIONS] <COMMAND>

Commands:
  transition   Move every matching item to a state
  purge        Destroy every matching item that is in the trash when the job reaches it; any other
               match is left as it is and reported. Match the bin with `--state trashed`. Needs
               `items.purge` and `--confirm PURGE`
  tags         Add tags to, and remove tags from, every matching item
  tier         Move every matching item to a tier
  properties   Merge a patch into every matching item's properties
  occurred-at  Set every matching item's own time
  job          A bulk-action job's state
  cancel       Cancel a bulk-action job
  help         Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action transition

```text
Move every matching item to a state

Usage: marfa items bulk-action transition [OPTIONS] --to <STATE>

Options:
      --to <STATE>
          The state to move them to

          [possible values: active, archived, trashed]

      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state. Unset excludes the bin, as a listing does; there is no `any` on this door

          [possible values: active, archived, trashed, revoked]

      --source <SOURCE>
          The source the items were written under

      --tier <TIER>
          One tier

          [possible values: library, feed]

      --tag <TAG>
          Items must carry every tag given

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --filter <FILTER>
          A property filter in the server's filter grammar

      --dry-run
          Report what the action would touch and touch nothing

      --max-items <MAX_ITEMS>
          Refuse if more than this many items match

      --no-fanout
          Do not deliver the writes to webhooks

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action purge

```text
Destroy every matching item that is in the trash when the job reaches it; any other match is left as
it is and reported. Match the bin with `--state trashed`. Needs `items.purge` and `--confirm PURGE`

Usage: marfa items bulk-action purge [OPTIONS]

Options:
      --confirm <PURGE>
          The word `PURGE`, because the door asks for it out loud

      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state. Unset excludes the bin, as a listing does; there is no `any` on this door

          [possible values: active, archived, trashed, revoked]

      --source <SOURCE>
          The source the items were written under

      --tier <TIER>
          One tier

          [possible values: library, feed]

      --tag <TAG>
          Items must carry every tag given

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --filter <FILTER>
          A property filter in the server's filter grammar

      --dry-run
          Report what the action would touch and touch nothing

      --max-items <MAX_ITEMS>
          Refuse if more than this many items match

      --no-fanout
          Do not deliver the writes to webhooks

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action tags

```text
Add tags to, and remove tags from, every matching item

Usage: marfa items bulk-action tags [OPTIONS]

Options:
      --add <TAG>
          A tag to add, repeatable

      --remove <TAG>
          A tag to remove, repeatable

      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state. Unset excludes the bin, as a listing does; there is no `any` on this door

          [possible values: active, archived, trashed, revoked]

      --source <SOURCE>
          The source the items were written under

      --tier <TIER>
          One tier

          [possible values: library, feed]

      --tag <TAG>
          Items must carry every tag given

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --filter <FILTER>
          A property filter in the server's filter grammar

      --dry-run
          Report what the action would touch and touch nothing

      --max-items <MAX_ITEMS>
          Refuse if more than this many items match

      --no-fanout
          Do not deliver the writes to webhooks

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action tier

```text
Move every matching item to a tier

Usage: marfa items bulk-action tier [OPTIONS] --to <TIER>

Options:
      --to <TIER>
          The tier to move them to

          [possible values: library, feed]

      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state. Unset excludes the bin, as a listing does; there is no `any` on this door

          [possible values: active, archived, trashed, revoked]

      --source <SOURCE>
          The source the items were written under

      --tier <TIER>
          One tier

          [possible values: library, feed]

      --tag <TAG>
          Items must carry every tag given

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --filter <FILTER>
          A property filter in the server's filter grammar

      --dry-run
          Report what the action would touch and touch nothing

      --max-items <MAX_ITEMS>
          Refuse if more than this many items match

      --no-fanout
          Do not deliver the writes to webhooks

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action properties

```text
Merge a patch into every matching item's properties

Usage: marfa items bulk-action properties [OPTIONS] --patch <JSON>

Options:
      --patch <JSON>
          The patch, as a JSON object

      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state. Unset excludes the bin, as a listing does; there is no `any` on this door

          [possible values: active, archived, trashed, revoked]

      --source <SOURCE>
          The source the items were written under

      --tier <TIER>
          One tier

          [possible values: library, feed]

      --tag <TAG>
          Items must carry every tag given

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --filter <FILTER>
          A property filter in the server's filter grammar

      --dry-run
          Report what the action would touch and touch nothing

      --max-items <MAX_ITEMS>
          Refuse if more than this many items match

      --no-fanout
          Do not deliver the writes to webhooks

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action occurred-at

```text
Set every matching item's own time

Usage: marfa items bulk-action occurred-at [OPTIONS] --occurred-at <TIME>

Options:
      --occurred-at <TIME>
          The time to set, RFC 3339

      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state. Unset excludes the bin, as a listing does; there is no `any` on this door

          [possible values: active, archived, trashed, revoked]

      --source <SOURCE>
          The source the items were written under

      --tier <TIER>
          One tier

          [possible values: library, feed]

      --tag <TAG>
          Items must carry every tag given

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --filter <FILTER>
          A property filter in the server's filter grammar

      --dry-run
          Report what the action would touch and touch nothing

      --max-items <MAX_ITEMS>
          Refuse if more than this many items match

      --no-fanout
          Do not deliver the writes to webhooks

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action job

```text
A bulk-action job's state

Usage: marfa items bulk-action job [OPTIONS] <ID>

Arguments:
  <ID>
          The job id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa items bulk-action cancel

```text
Cancel a bulk-action job

Usage: marfa items bulk-action cancel [OPTIONS] <ID>

Arguments:
  <ID>
          The job id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## edges

### marfa edges

```text
Edges between items

Usage: marfa edges [OPTIONS] <COMMAND>

Commands:
  list    List edges on the server, a page at a time
  get     One edge by id
  create  Link two items with an edge
  update  Change an edge's properties, or move one of its ends, conditional on the version read
  delete  Remove an edge
  bulk    Upsert many edges in one request
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edges list

```text
List edges on the server, a page at a time

Usage: marfa edges list [OPTIONS]

Options:
      --type <TYPE>
          Only edges of this type

      --updated-after <TIME>
          Inclusive lower bound on the modification time: the catch-up filter

      --updated-before <TIME>
          Exclusive upper bound on the modification time

      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edges get

```text
One edge by id

Usage: marfa edges get [OPTIONS] <ID>

Arguments:
  <ID>
          The edge id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edges create

```text
Link two items with an edge

Usage: marfa edges create [OPTIONS] --source <ID> --target <ID> --type <TYPE>

Options:
      --source <ID>
          The item the edge leaves

      --target <ID>
          The item the edge arrives at

      --type <TYPE>
          The edge type

      --properties <JSON>
          The edge's properties, as a JSON object

      --id <ID>
          The id to mint it under. Omitted, the server mints one

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edges update

```text
Change an edge's properties, or move one of its ends, conditional on the version read

Usage: marfa edges update [OPTIONS] --version <VERSION> <ID>

Arguments:
  <ID>
          The edge id

Options:
      --properties <JSON>
          The properties, as a JSON object. Whole values

      --source <ID>
          Move the edge to this source, where each target holds one of its type

      --target <ID>
          Move the edge to this target, where each source holds one of its type

      --version <VERSION>
          The version the edit was based on

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edges delete

```text
Remove an edge

Usage: marfa edges delete [OPTIONS] <ID>

Arguments:
  <ID>
          The edge id

Options:
      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edges bulk

```text
Upsert many edges in one request

Usage: marfa edges bulk [OPTIONS] --file <PATH>

Options:
      --file <PATH>
          A JSON file holding the edges, or the whole body with `edges` in it; `-` reads stdin

      --mode <MODE>
          `upsert` or `create_only`

      --atomic
          Refuse the whole request if any entry is refused

      --no-fanout
          Do not deliver the writes to webhooks

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## edge-types

### marfa edge-types

```text
The edge types an instance holds

Usage: marfa edge-types [OPTIONS] <COMMAND>

Commands:
  list      Every edge type the instance holds
  register  Register an edge type from its definition. Needs `metadata.edge_types:write` and write
            on its id and any reverse name in the key's edge map
  delete    Remove a registered edge type. Needs `schema.write` and write on its id and any reverse
            name in the key's edge map
  help      Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edge-types list

```text
Every edge type the instance holds

Usage: marfa edge-types list [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edge-types register

```text
Register an edge type from its definition. Needs `metadata.edge_types:write` and write on its id and
any reverse name in the key's edge map

Usage: marfa edge-types register [OPTIONS]

Options:
      --file <PATH>
          A file holding the JSON body; `-` reads stdin

      --body <JSON>
          The JSON body inline

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa edge-types delete

```text
Remove a registered edge type. Needs `schema.write` and write on its id and any reverse name in the
key's edge map

Usage: marfa edge-types delete [OPTIONS] <ID>

Arguments:
  <ID>
          The edge type id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## types

### marfa types

```text
The types an instance holds, and the shipped ones it has outgrown

Usage: marfa types [OPTIONS] <COMMAND>

Commands:
  list      Every type the instance holds
  get       One type by id, with its schema
  register  Register a type from its definition. Needs `metadata.types:write` and write on the type
            in the key's type map
  replace   Replace a registered type's definition. Needs write on the type in the key's type map
            and `schema.write` or `metadata.types:write`
  delete    Remove a registered type. Needs `schema.write` and write on the type in the key's type
            map
  drift     Shipped types this instance carries that the build no longer does. Operator only
  prune     Remove one shipped type the build no longer carries. Operator only
  help      Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa types list

```text
Every type the instance holds

Usage: marfa types list [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa types get

```text
One type by id, with its schema

Usage: marfa types get [OPTIONS] <ID>

Arguments:
  <ID>
          The type id, such as `core.note` or `user.recipe`

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa types register

```text
Register a type from its definition. Needs `metadata.types:write` and write on the type in the key's
type map

Usage: marfa types register [OPTIONS]

Options:
      --file <PATH>
          A file holding the JSON body; `-` reads stdin

      --body <JSON>
          The JSON body inline

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa types replace

```text
Replace a registered type's definition. Needs write on the type in the key's type map and
`schema.write` or `metadata.types:write`.

`metadata.types:write` alone covers adding optional fields that no stored row holds a value under,
and changing the label, description, display hints and version. Any other change, removing a field
included, needs `schema.write`.

Usage: marfa types replace [OPTIONS] <ID>

Arguments:
  <ID>
          The type id

Options:
      --file <PATH>
          A file holding the JSON body; `-` reads stdin

      --body <JSON>
          The JSON body inline

  -h, --help
          Print help (see a summary with '-h')

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa types delete

```text
Remove a registered type. Needs `schema.write` and write on the type in the key's type map

Usage: marfa types delete [OPTIONS] <ID>

Arguments:
  <ID>
          The type id

Options:
      --force
          Remove it even where items of the type exist

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa types drift

```text
Shipped types this instance carries that the build no longer does. Operator only

Usage: marfa types drift [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa types prune

```text
Remove one shipped type the build no longer carries. Operator only

Usage: marfa types prune [OPTIONS] <ID>

Arguments:
  <ID>
          The type id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## search

### marfa search

```text
Full-text search on the server, best match first

Usage: marfa search [OPTIONS] <QUERY>

Arguments:
  <QUERY>
          What to look for

Options:
      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state, or `any`. Unset answers the active state

          [possible values: active, archived, trashed, revoked, any]

      --tier <TIER>
          One tier, or `all`

          [possible values: library, feed, all]

      --tag <TAG>
          Hits must carry every tag given

      --filter <FILTER>
          A property filter in the server's filter grammar

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --include <NAME>
          Extra to hydrate onto each hit: `edges`, `metadata`

      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## metadata

### marfa metadata

```text
An item's tags and the namespaces it carries, and every tag in use

Usage: marfa metadata [OPTIONS] <COMMAND>

Commands:
  get      An item's metadata: its tags and the namespaces it carries
  replace  Write an item's tags whole, dropping any not named
  update   Add the named tags, leaving the rest
  tags     Every distinct tag in use on the instance
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa metadata get

```text
An item's metadata: its tags and the namespaces it carries

Usage: marfa metadata get [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa metadata replace

```text
Write an item's tags whole, dropping any not named

Usage: marfa metadata replace [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --tag <TAG>
          A tag, repeatable; none at all clears them

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa metadata update

```text
Add the named tags, leaving the rest

Usage: marfa metadata update [OPTIONS] --tag <TAG> <ID>

Arguments:
  <ID>
          The item id

Options:
      --tag <TAG>
          A tag, repeatable

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa metadata tags

```text
Every distinct tag in use on the instance

Usage: marfa metadata tags [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## extensions

### marfa extensions

```text
An item's extension namespaces

Usage: marfa extensions [OPTIONS] <COMMAND>

Commands:
  list    The extension namespaces an item carries
  get     One namespace's contents
  write   Write one namespace whole
  delete  Remove one namespace
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa extensions list

```text
The extension namespaces an item carries

Usage: marfa extensions list [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa extensions get

```text
One namespace's contents

Usage: marfa extensions get [OPTIONS] <ID> <NAMESPACE>

Arguments:
  <ID>
          The item id

  <NAMESPACE>
          The namespace, such as `app.cursor`

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa extensions write

```text
Write one namespace whole

Usage: marfa extensions write [OPTIONS] <ID> <NAMESPACE>

Arguments:
  <ID>
          The item id

  <NAMESPACE>
          The namespace, such as `app.cursor`

Options:
      --file <PATH>
          A file holding the JSON body; `-` reads stdin

      --body <JSON>
          The JSON body inline

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa extensions delete

```text
Remove one namespace

Usage: marfa extensions delete [OPTIONS] <ID> <NAMESPACE>

Arguments:
  <ID>
          The item id

  <NAMESPACE>
          The namespace, such as `app.cursor`

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## blobs

### marfa blobs

```text
Bytes stored by content hash, and the stores that hold them

Usage: marfa blobs [OPTIONS] <COMMAND>

Commands:
  upload           Store a file's bytes by content hash
  download         Fetch a blob's bytes
  url              A time-limited link that fetches a blob without the API in between
  stores           Every store the instance has attached, and the copies a blob keeps at the least.
                   Operator key only
  locations        The stores recorded as holding one blob's bytes, and when each copy was last
                   found intact
  delete-location  Remove one store's copy of a blob, where enough live copies remain. Operator key
                   only
  orphans          The blobs the last orphan sweep found nothing referencing. Operator key only
  help             Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa blobs upload

```text
Store a file's bytes by content hash

Usage: marfa blobs upload [OPTIONS] <FILE>

Arguments:
  <FILE>
          The file

Options:
      --mime-type <TYPE>
          The file's MIME type. Guessed from the extension when omitted

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa blobs download

```text
Fetch a blob's bytes

Usage: marfa blobs download [OPTIONS] <HASH>

Arguments:
  <HASH>
          The blob hash, `sha256:<hex>`

Options:
      --output <PATH>
          Where to write the bytes. Omitted, they go to stdout

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa blobs url

```text
A time-limited link that fetches a blob without the API in between

Usage: marfa blobs url [OPTIONS] <HASH>

Arguments:
  <HASH>
          The blob hash, `sha256:<hex>`

Options:
      --ttl <TTL>
          How long the link lives, in seconds

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa blobs stores

```text
Every store the instance has attached, and the copies a blob keeps at the least. Operator key only

Usage: marfa blobs stores [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa blobs locations

```text
The stores recorded as holding one blob's bytes, and when each copy was last found intact

Usage: marfa blobs locations [OPTIONS] <HASH>

Arguments:
  <HASH>
          The blob hash, `sha256:<hex>`

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa blobs delete-location

```text
Remove one store's copy of a blob, where enough live copies remain. Operator key only

Usage: marfa blobs delete-location [OPTIONS] --store <STORE> <HASH>

Arguments:
  <HASH>
          The blob hash, `sha256:<hex>`

Options:
      --store <STORE>
          The store whose copy goes, as `blobs stores` names it

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa blobs orphans

```text
The blobs the last orphan sweep found nothing referencing. Operator key only

Usage: marfa blobs orphans [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## keys

### marfa keys

```text
Keys: the credentials that reach the API

Usage: marfa keys [OPTIONS] <COMMAND>

Commands:
  bootstrap  Mint a fresh instance's operator key with the one-time secret it printed to its log.
             The secret is read from `--secret` or from stdin. The operator key is not a working
             key: the next call is `keys create` with it
  create     Mint a key. Needs `keys.mint`, or the operator key
  list       Every key, without plaintext. Needs `keys.mint`, or the operator key
  current    The key this call bears, without plaintext: what it holds and what it claims. Any key
             may read itself
  update     Change a key's label, tier or permission maps. Needs `keys.mint`
  revoke     Revoke a key; the next request bearing it is refused. Needs `keys.mint`, or the
             operator key
  keep       Keep a key for this server in the operating system's keychain, and make this server the
             one a bare command talks to. The key is read from `--key`, from MARFA_API_KEY, or from
             stdin; never from a file
  forget     Forget the key kept for this server
  help       Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa keys bootstrap

```text
Mint a fresh instance's operator key with the one-time secret it printed to its log. The secret is
read from `--secret` or from stdin. The operator key is not a working key: the next call is `keys
create` with it

Usage: marfa keys bootstrap [OPTIONS]

Options:
      --secret <SECRET>
          The bootstrap secret from the server's log. Left out, it is read from stdin, which keeps
          it out of the shell's history

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa keys create

```text
Mint a key. Needs `keys.mint`, or the operator key.

The key holds exactly what the flags name. A permission, a map entry or a claim each names a part of
what it holds, and a part left unnamed is held as nothing. With none named, the key takes the
caller's whole set.

Usage: marfa keys create [OPTIONS] --label <LABEL> --source <SOURCE>

Options:
      --label <LABEL>
          What the key is for

      --source <SOURCE>
          The key's own source, which a row written under the key is keyed by and stamped with
          unless the write names one the key claims

      --permission <PERMISSION>
          A permission, repeatable

          [possible values: schema.write, keys.mint, items.purge, webhooks.manage, config.manage,
          audit.read, grants.manage]

      --type-permission <PATTERN=LEVEL>
          A type pattern and its level, `core.note=write`, repeatable

      --extension-permission <NAMESPACE=LEVEL>
          An extension namespace and its level, `app.cursor=write`, repeatable

      --edge-permission <TYPE=LEVEL>
          An edge type and its level, `references=write`, repeatable

      --metadata-permission <NAME=LEVEL>
          A metadata subresource and its level, `tags=write`, repeatable

      --profile-permission <FIELD=LEVEL>
          A profile field and its level, `email=read`, repeatable

      --enforcement-override <JSON>
          The enforcement override, as the JSON object the door takes

      --claim <SOURCE>
          A source a write under the key may name, so its rows are keyed by it. Repeatable

      --no-claims
          Claim no source besides the key's own, asked for out loud. On a mint naming no permission
          or map, naming the claims is naming what the key holds: it holds no map and no permission
          either

      --default-tier <DEFAULT_TIER>
          The tier a write under the key lands at when it names none

          [possible values: library, feed]

      --operator
          Mint a second operator key, which holds nothing. Operator only

      --no-permissions
          A key that holds nothing at all, asked for out loud

  -h, --help
          Print help (see a summary with '-h')

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa keys list

```text
Every key, without plaintext. Needs `keys.mint`, or the operator key

Usage: marfa keys list [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa keys current

```text
The key this call bears, without plaintext: what it holds and what it claims. Any key may read
itself

Usage: marfa keys current [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa keys update

```text
Change a key's label, tier or permission maps. Needs `keys.mint`

Usage: marfa keys update [OPTIONS] <ID>

Arguments:
  <ID>
          The key id

Options:
      --label <LABEL>
          What the key is for

      --permission <PERMISSION>
          A permission, repeatable

          [possible values: schema.write, keys.mint, items.purge, webhooks.manage, config.manage,
          audit.read, grants.manage]

      --type-permission <PATTERN=LEVEL>
          A type pattern and its level, `core.note=write`, repeatable

      --extension-permission <NAMESPACE=LEVEL>
          An extension namespace and its level, `app.cursor=write`, repeatable

      --edge-permission <TYPE=LEVEL>
          An edge type and its level, `references=write`, repeatable

      --metadata-permission <NAME=LEVEL>
          A metadata subresource and its level, `tags=write`, repeatable

      --profile-permission <FIELD=LEVEL>
          A profile field and its level, `email=read`, repeatable

      --enforcement-override <JSON>
          The enforcement override, as the JSON object the door takes

      --no-type-permissions
          Empty the type permission map on this update

      --no-extension-permissions
          Empty the extension permission map on this update

      --no-edge-permissions
          Empty the edge permission map on this update

      --no-metadata-permissions
          Empty the metadata permission map on this update

      --no-profile-permissions
          Empty the profile permission map on this update

      --claim <SOURCE>
          A source a write under the key may name, so its rows are keyed by it. Repeatable

      --no-claims
          Claim no source besides the key's own, asked for out loud. On a mint naming no permission
          or map, naming the claims is naming what the key holds: it holds no map and no permission
          either

      --default-tier <DEFAULT_TIER>
          The tier a write under the key lands at when it names none

          [possible values: library, feed]

      --no-permissions
          Take every permission and every map from the key, so a key minted too wide is narrowed in
          place

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa keys revoke

```text
Revoke a key; the next request bearing it is refused. Needs `keys.mint`, or the operator key

Usage: marfa keys revoke [OPTIONS] <ID>

Arguments:
  <ID>
          The key id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa keys keep

```text
Keep a key for this server in the operating system's keychain, and make this server the one a bare
command talks to. The key is read from `--key`, from MARFA_API_KEY, or from stdin; never from a file

Usage: marfa keys keep [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa keys forget

```text
Forget the key kept for this server

Usage: marfa keys forget [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## config

### marfa config

```text
The instance configuration

Usage: marfa config [OPTIONS] <COMMAND>

Commands:
  get      The instance configuration: the enforcement levers and the retention overrides. Needs
           `config.manage`
  replace  Replace the instance configuration whole. Needs `config.manage`
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa config get

```text
The instance configuration: the enforcement levers and the retention overrides. Needs
`config.manage`

Usage: marfa config get [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa config replace

```text
Replace the instance configuration whole. Needs `config.manage`

Usage: marfa config replace [OPTIONS]

Options:
      --file <PATH>
          A file holding the JSON body; `-` reads stdin

      --body <JSON>
          The JSON body inline

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## export

### marfa export

```text
Export the instance's data

Usage: marfa export [OPTIONS]

Options:
      --format <FORMAT>
          `ndjson` for items one per line, `archive` for the whole instance

          [possible values: ndjson, archive]

      --output <PATH>
          Where to write. Omitted, the export goes to stdout

      --type <TYPE>
          A type identifier; its subtypes are included

      --state <STATE>
          One state, or `any`

          [possible values: active, archived, trashed, revoked, any]

      --source <SOURCE>
          The source the items were written under

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## restore

### marfa restore

```text
Restore an archive. Operator key only.

Preserves item and edge IDs, created_at and updated_at dates, current versions, tags, extensions,
and the item's earlier versions carried in the archive. Existing items and their history remain
unchanged.

The archive contains only data the exporting credential could read, including history allowed by
each snapshot's type permissions and blobs that credential could read. It does not restore keys,
webhooks, or configuration. Trashed items are absent unless explicitly exported, for example with
`export --format archive --state any`.

Until the first public release, restore only with the server build that wrote the archive. Archive
format 0 does not promise compatibility between builds.

Usage: marfa restore [OPTIONS] <FILE>

Arguments:
  <FILE>
          The archive, as `export --format archive` wrote it

Options:
  -h, --help
          Print help (see a summary with '-h')

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## webhooks

### marfa webhooks

```text
Outbound subscriptions that send events out. Every command needs `webhooks.manage`

Usage: marfa webhooks [OPTIONS] <COMMAND>

Commands:
  create      Register a subscription. The secret is answered once, in plaintext
  list        Every subscription
  get         One subscription by id
  update      Change a subscription's URL, events, type filter or whether it is active
  delete      Remove a subscription
  deliveries  The deliveries a subscription was sent, newest first
  redeliver   Queue a failed delivery again using the subscription's current address
  help        Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa webhooks create

```text
Register a subscription. The secret is answered once, in plaintext

Usage: marfa webhooks create [OPTIONS] --to <URL> --event <EVENT>

Options:
      --to <URL>
          Where to deliver. Named `--to` rather than `--url`, which is the server

      --event <EVENT>
          An event name from the vocabulary, repeatable; `*` is refused

      --type-filter <TYPE>
          Only events for items of this type

      --secret <SECRET>
          The secret deliveries are signed with. Omitted, the server mints one

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa webhooks list

```text
Every subscription

Usage: marfa webhooks list [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa webhooks get

```text
One subscription by id

Usage: marfa webhooks get [OPTIONS] <ID>

Arguments:
  <ID>
          The webhook id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa webhooks update

```text
Change a subscription's URL, events, type filter or whether it is active

Usage: marfa webhooks update [OPTIONS] <ID>

Arguments:
  <ID>
          The webhook id

Options:
      --to <URL>
          Where to deliver. Named `--to` rather than `--url`, which is the server

      --event <EVENT>
          The events, whole; repeatable

      --type-filter <TYPE>
          Only events for items of this type

      --active
          Resume deliveries

      --inactive
          Pause deliveries

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa webhooks delete

```text
Remove a subscription

Usage: marfa webhooks delete [OPTIONS] <ID>

Arguments:
  <ID>
          The webhook id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa webhooks deliveries

```text
The deliveries a subscription was sent, newest first

Usage: marfa webhooks deliveries [OPTIONS] <ID>

Arguments:
  <ID>
          The webhook id

Options:
      --limit <LIMIT>
          How many at most

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa webhooks redeliver

```text
Queue a failed delivery again using the subscription's current address

Usage: marfa webhooks redeliver [OPTIONS] <ID> <DELIVERY_ID>

Arguments:
  <ID>
          The webhook id

  <DELIVERY_ID>
          The delivery id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## audit

### marfa audit

```text
The audit log: every write, with the acting key. Needs `audit.read`

Usage: marfa audit [OPTIONS]

Options:
      --action <ACTION>
          Only entries with this action, such as `item.create`

      --resource-type <TYPE>
          Only entries about this kind of resource

      --resource-id <ID>
          Only entries about this resource

      --created-after <TIME>
          Exclusive lower bound on the entry's time, RFC 3339

      --created-before <TIME>
          Exclusive upper bound on the entry's time, RFC 3339

      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## events

### marfa events

```text
The event stream, one frame per line

Usage: marfa events [OPTIONS]

Options:
      --type <TYPE>
          A type identifier to narrow to, repeatable up to ten; subtypes are included

      --edges <EDGES>
          Whether edge events ride along: `all` (the default) or `none`

          [possible values: all, none]

      --from <CURSOR>
          Resume from this cursor, replaying what the log holds after it

      --for <SECONDS>
          Stop after this many seconds. Unset, it reads until interrupted

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## housekeeping

### marfa housekeeping

```text
The housekeeping jobs the server runs on itself. Operator key only

Usage: marfa housekeeping [OPTIONS] <COMMAND>

Commands:
  list  Every housekeeping job the server runs on itself: its cadence, when it is next due, and what
        its last run did. Operator key only
  run   Run one housekeeping job now and report what it did. Operator key only
  help  Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa housekeeping list

```text
Every housekeeping job the server runs on itself: its cadence, when it is next due, and what its
last run did. Operator key only

Usage: marfa housekeeping list [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa housekeeping run

```text
Run one housekeeping job now and report what it did. Operator key only

Usage: marfa housekeeping run [OPTIONS] <NAME>

Arguments:
  <NAME>
          The housekeeping job's name, as `housekeeping list` shows it

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## connectors

### marfa connectors

```text
Processes that write on a key's behalf: registered, heard from, and reporting their runs. A key
registers itself; the operator key sees every registration and may remove one

Usage: marfa connectors [OPTIONS] <COMMAND>

Commands:
  register    Register the key this command runs under as a connector, or answer its registration if
              it has one: the key is the identity
  list        Every registered connector, newest first
  get         One connector's registration
  delete      Remove a registration. The connector's own key, or the operator key
  heartbeat   Say the connector is alive. Its own key only
  report      Report one run of the connector. Its own key only
  runs        The runs a connector has reported, newest first
  endpoints   The addresses a sender posts inbound webhooks to
  deliveries  What arrived at a connector's endpoints. Its own key only
  hold        Take or renew the hold for one process, which alone may then write the state and the
              agreements. Its own key only
  release     Give up the hold, if this process holds it. Its own key only
  state       The state document a connector keeps on the instance
  agreements  A connector's records of what it and its vendor last agreed about rows. Its own key
              only
  help        Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors register

```text
Register the key this command runs under as a connector, or answer its registration if it has one:
the key is the identity

Usage: marfa connectors register [OPTIONS] --name <NAME>

Options:
      --name <NAME>
          What the connector is called

      --description <DESCRIPTION>
          What it does

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors list

```text
Every registered connector, newest first

Usage: marfa connectors list [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors get

```text
One connector's registration

Usage: marfa connectors get [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors delete

```text
Remove a registration. The connector's own key, or the operator key

Usage: marfa connectors delete [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors heartbeat

```text
Say the connector is alive. Its own key only

Usage: marfa connectors heartbeat [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors report

```text
Report one run of the connector. Its own key only

Usage: marfa connectors report [OPTIONS] --outcome <OUTCOME> --started-at <TIME> --finished-at <TIME> <ID>

Arguments:
  <ID>
          The connector id

Options:
      --outcome <OUTCOME>
          How the run ended

          [possible values: succeeded, failed]

      --started-at <TIME>
          When the run started, RFC 3339

      --finished-at <TIME>
          When the run finished, RFC 3339

      --summary <SUMMARY>
          What the run did, in a sentence

      --error <ERROR>
          What went wrong, for a run that failed

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors runs

```text
The runs a connector has reported, newest first

Usage: marfa connectors runs [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
      --limit <LIMIT>
          How many at most

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors endpoints

```text
The addresses a sender posts inbound webhooks to

Usage: marfa connectors endpoints [OPTIONS] <COMMAND>

Commands:
  create  Make an endpoint. Its address is shown in full this once. The connector's own key, or the
          operator key
  list    A connector's endpoints, newest first, each address redacted
  retire  Retire an endpoint: its address stops answering
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors endpoints create

```text
Make an endpoint. Its address is shown in full this once. The connector's own key, or the operator
key

Usage: marfa connectors endpoints create [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
      --label <LABEL>
          What the endpoint is for

      --duplicate-header <HEADER>
          A header whose value names a delivery, such as X-GitHub-Delivery, so a repeat is marked as
          one

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors endpoints list

```text
A connector's endpoints, newest first, each address redacted

Usage: marfa connectors endpoints list [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors endpoints retire

```text
Retire an endpoint: its address stops answering

Usage: marfa connectors endpoints retire [OPTIONS] <ID> <ENDPOINT>

Arguments:
  <ID>
          The connector id

  <ENDPOINT>
          The endpoint id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors deliveries

```text
What arrived at a connector's endpoints. Its own key only

Usage: marfa connectors deliveries [OPTIONS] <COMMAND>

Commands:
  list    A connector's deliveries, oldest first, the unhandled ones unless --state says otherwise
  body    A delivery's body, byte for byte
  handle  Mark deliveries handled. The first mark stands
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors deliveries list

```text
A connector's deliveries, oldest first, the unhandled ones unless --state says otherwise

Usage: marfa connectors deliveries list [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
      --state <STATE>
          Which deliveries: not yet handled, handled, or both

          [possible values: pending, handled, any]

      --endpoint <ENDPOINT>
          Only what this endpoint received

      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors deliveries body

```text
A delivery's body, byte for byte

Usage: marfa connectors deliveries body [OPTIONS] <ID> <DELIVERY>

Arguments:
  <ID>
          The connector id

  <DELIVERY>
          The delivery id

Options:
      --output <PATH>
          Where to write the bytes. Omitted, they go to stdout

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors deliveries handle

```text
Mark deliveries handled. The first mark stands

Usage: marfa connectors deliveries handle [OPTIONS] --outcome <OUTCOME> <ID> <DELIVERIES>...

Arguments:
  <ID>
          The connector id

  <DELIVERIES>...
          The delivery ids

Options:
      --outcome <OUTCOME>
          What the connector made of them

          [possible values: processed, duplicate, rejected]

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors hold

```text
Take or renew the hold for one process, which alone may then write the state and the agreements. Its
own key only

Usage: marfa connectors hold [OPTIONS] --process <PROCESS> <ID>

Arguments:
  <ID>
          The connector id

Options:
      --process <PROCESS>
          The process's own name for itself, such as a UUID

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors release

```text
Give up the hold, if this process holds it. Its own key only

Usage: marfa connectors release [OPTIONS] --process <PROCESS> <ID>

Arguments:
  <ID>
          The connector id

Options:
      --process <PROCESS>
          The process's own name for itself

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors state

```text
The state document a connector keeps on the instance

Usage: marfa connectors state [OPTIONS] <COMMAND>

Commands:
  get     The state document, `{}` until one is written. Its own key only
  put     Replace the state document with a JSON object. Its own key only
  delete  Remove the state document and every agreement. The connector's own key, or the operator
          key
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors state get

```text
The state document, `{}` until one is written. Its own key only

Usage: marfa connectors state get [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors state put

```text
Replace the state document with a JSON object. Its own key only

Usage: marfa connectors state put [OPTIONS] --process <PROCESS> <ID>

Arguments:
  <ID>
          The connector id

Options:
      --process <PROCESS>
          The process writing, which must hold the registration

      --file <PATH>
          A file holding the JSON body; `-` reads stdin

      --body <JSON>
          The JSON body inline

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors state delete

```text
Remove the state document and every agreement. The connector's own key, or the operator key

Usage: marfa connectors state delete [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors agreements

```text
A connector's records of what it and its vendor last agreed about rows. Its own key only

Usage: marfa connectors agreements [OPTIONS] <COMMAND>

Commands:
  write   Set and clear agreements, from a JSON object with `set` and `clear`
  lookup  The agreements of the rows named, each once, in the order first named
  list    The agreements, the one written longest ago first
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors agreements write

```text
Set and clear agreements, from a JSON object with `set` and `clear`

Usage: marfa connectors agreements write [OPTIONS] --process <PROCESS> <ID>

Arguments:
  <ID>
          The connector id

Options:
      --process <PROCESS>
          The process writing, which must hold the registration

      --file <PATH>
          A file holding the JSON body; `-` reads stdin

      --body <JSON>
          The JSON body inline

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors agreements lookup

```text
The agreements of the rows named, each once, in the order first named

Usage: marfa connectors agreements lookup [OPTIONS] <ID> <ITEMS>...

Arguments:
  <ID>
          The connector id

  <ITEMS>...
          The item ids

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa connectors agreements list

```text
The agreements, the one written longest ago first

Usage: marfa connectors agreements list [OPTIONS] <ID>

Arguments:
  <ID>
          The connector id

Options:
      --waiting <WAITING>
          Only the ones waiting to be carried to the vendor, or only the others

          [possible values: true, false]

      --limit <LIMIT>
          How many at most

      --cursor <CURSOR>
          The cursor the previous page answered with

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## operations

### marfa operations

```text
Every published operation and the command that reaches it

Usage: marfa operations [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## device

### marfa device

```text
A working copy of a slice of one server, in the store --db names

Usage: marfa device [OPTIONS] <COMMAND>

Commands:
  hydrate     Replace the local copy with the declared types at one tier, or both
  pin         Hold one row by id whatever the slice says of it, read now and kept current, even
              after it leaves the slice
  unpin       Stop holding a row by id; one the slice does not take goes
  catch-up    Apply every event since the last hydrate or catch-up
  follow      Hold the event stream open and apply each event as it arrives, printing a line for
              each that changed the copy
  changes     Print a line each time another process saves to the store. Opens it to read, with or
              without `--reader`, so watching never takes the writer's place
  items       Read items from the local copy
  folders     Folders' settings: read from the copy, written through the folder door
  search      Full-text search over the local copy, best match first
  queue       Every queued write, the body it carries and what became of it
  drain       Send what the queue holds and record what came back
  forget      Clear the writes the server has answered
  discard     Take a refused write out of the queue, with the content it carried
  release     Send a blocked or dead write again, under a fresh key
  withdraw    Take a write blocked `ancestor_unavailable` or `conflict_unresolved` out of the queue,
              and put the copy back to what the server holds
  status      What the local copy holds and where it came from
  types       The item types the copy holds, read from it alone, the ones an app declares for it,
              and the server's
  edge-types  The edge types the copy holds, read from it alone, and the server's
  edges       Edges between items, each its own write
  tags        Tags on an item, each its own write
  metadata    An item's metadata, written whole or merged
  extensions  An item's extension namespaces, each its own write
  blobs       Blobs' bytes: uploaded as queued writes, fetched when asked for
  help        Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device hydrate

```text
Replace the local copy with the declared types at one tier, or both

Usage: marfa device hydrate [OPTIONS] --types <TYPE> --tier <TIER>

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --types <TYPE>
          Comma-separated type identifiers, such as core.note,core.file

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --tier <TIER>
          The tier to hold the slice at, or `all` for both

          [possible values: library, feed, all]

      --edge-type <TYPE>
          An edge type to hold whole: every edge of it the key reads, whichever ends the copy holds.
          Repeatable

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device pin

```text
Hold one row by id whatever the slice says of it, read now and kept current, even after it leaves
the slice

Usage: marfa device pin [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device unpin

```text
Stop holding a row by id; one the slice does not take goes

Usage: marfa device unpin [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device catch-up

```text
Apply every event since the last hydrate or catch-up

Usage: marfa device catch-up [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device follow

```text
Hold the event stream open and apply each event as it arrives, printing a line for each that changed
the copy

Usage: marfa device follow [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --for <SECONDS>
          Stop after this many seconds; without it, follow until interrupted. Either way it ends
          with its report

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device changes

```text
Print a line each time another process saves to the store. Opens it to read, with or without
`--reader`, so watching never takes the writer's place

Usage: marfa device changes [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --for <SECONDS>
          Stop after this many seconds; without it, watch until interrupted

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items

```text
Read items from the local copy

Usage: marfa device items [OPTIONS] <COMMAND>

Commands:
  list        List items, newest first unless sorted otherwise
  get         One item by id, with its properties and tags
  create      Write a new item into the local copy and queue it for the server
  update      Change an item in the local copy and queue the change
  delete      Move an item to the bin locally and queue the delete
  purge       Destroy an item in the bin on the server now, and take it out of the local copy. Never
              queued: it needs the server, a key holding `items.purge` and write on the item's type,
              and an item the copy holds in the bin with no write to it waiting
  bin         Read a page of the server's bin, newest change first. Online only, and held nowhere in
              the copy; each item's `updated_at` stands for when it went to the bin
  restore     Take an item out of the bin and queue the restore: locally where the copy holds it,
              and by id where it does not
  transition  Move an item to another lifecycle state
  add         Add a file as an item of its own: its upload and a file item naming the bytes, two
              queued writes, and one for each tag
  attach      Attach a file to an item: its upload, a file item naming the bytes, and an
              `attached-to` edge, three queued writes
  links       The links and embeds of files in an item's body, read from the local copy: each with
              the item it names, or why it names none yet
  embed       The text that embeds a file item in an item's body, which reads back as the file's
              `attached-to` edge to the item
  thumbnail   The thumbnail an item carries, read from the local copy with no request: its MIME type
              and size, and its bytes written to `--out`
  help        Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items list

```text
List items, newest first unless sorted otherwise

Usage: marfa device items list [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --type <TYPE>
          A type identifier; its subtypes are included

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --state <STATE>
          Exactly one state. Unset answers the active state

          [possible values: active, archived, trashed, revoked]

      --all-states
          Every state, not just the active one

      --tier <TIER>
          Only items at this tier

          [possible values: library, feed]

      --tag <TAG>
          Items must carry every tag given

      --occurred-after <TIME>
          Exclusive lower bound on the item's own time, RFC 3339

      --occurred-before <TIME>
          Exclusive upper bound on the item's own time, RFC 3339

      --filter <EXPR>
          An expression in the server's listing grammar, answered as the server answers `filter`; a
          `backref` condition is refused

      --beneath <ID>
          Only this item and what it reaches along `parent-of` edges

      --sort <SORT>
          The time to order by

          [default: created-at]
          [possible values: created-at, updated-at, occurred-at]

      --direction <DIRECTION>
          Newest first, or oldest

          [default: desc]
          [possible values: asc, desc]

      --limit <LIMIT>
          How many items at most

      --offset <OFFSET>
          How many items to skip first

      --folder <ID>
          Only what this `system.folder`'s search holds, as the folder holds it; refused where the
          copy's slice cannot answer the search whole

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items get

```text
One item by id, with its properties and tags

Usage: marfa device items get [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items create

```text
Write a new item into the local copy and queue it for the server

Usage: marfa device items create [OPTIONS] --type <TYPE> --properties <JSON>

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --type <TYPE>
          The type the item is

      --properties <JSON>
          The properties, as a JSON object

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --tag <TAG>
          A tag, repeatable. Each is queued as a write of its own

      --tier <TIER>
          The tier to write it at; the default is the tier of the held row its natural key names,
          else the slice's tier, or the library from a slice of both or before a first hydration

          [possible values: library, feed]

      --source <SOURCE>
          The source to stamp it with

      --source-id <SOURCE_ID>
          The id this row has in the system it came from

      --occurred-at <OCCURRED_AT>
          The item's own time, RFC 3339. Defaults to now

      --id <ID>
          The id to mint it under. Omitted, the device mints one

      --version <VERSION>
          The version this create is conditional on, where its natural key resolves a row the server
          already holds

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items update

```text
Change an item in the local copy and queue the change

Usage: marfa device items update [OPTIONS] --properties <JSON> <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --properties <JSON>
          The properties to write, as a JSON object. Whole values

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --version <VERSION>
          The version the edit was based on. Required: an update that names no version overwrites
          whatever it finds

      --source-id <KEY>
          The natural key to move the row to. The server refuses one another item already holds, so
          a rename does not take a name off a note

      --as-read
          The version is one read before the version the copy holds now, and the server merges the
          edit against it rather than taking it as newer than what came in since

      --type <TYPE>
          The type to move the item to. The server holds its properties to the type it enters

      --tier <TIER>
          The tier to move the item to

          [possible values: library, feed]

      --replace
          The properties are the item's whole properties: one they leave out is cleared rather than
          kept

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items delete

```text
Move an item to the bin locally and queue the delete

Usage: marfa device items delete [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items purge

```text
Destroy an item in the bin on the server now, and take it out of the local copy. Never queued: it
needs the server, a key holding `items.purge` and write on the item's type, and an item the copy
holds in the bin with no write to it waiting

Usage: marfa device items purge [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --version <VERSION>
          The version the item was read at in the bin; without it the copy's own, and an item the
          copy does not hold is refused

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items bin

```text
Read a page of the server's bin, newest change first. Online only, and held nowhere in the copy;
each item's `updated_at` stands for when it went to the bin

Usage: marfa device items bin [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --type <TYPE>
          A type identifier; its subtypes are included

      --cursor <CURSOR>
          Where the page starts, as the last page's `next_cursor` named it

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --limit <LIMIT>
          How many items at most, up to 100

          [default: 50]

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items restore

```text
Take an item out of the bin and queue the restore: locally where the copy holds it, and by id where
it does not

Usage: marfa device items restore [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items transition

```text
Move an item to another lifecycle state

Usage: marfa device items transition [OPTIONS] --state <STATE> <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --state <STATE>
          The state to move it to. `revoked` is the server's alone

          [possible values: active, archived, trashed, revoked]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items add

```text
Add a file as an item of its own: its upload and a file item naming the bytes, two queued writes,
and one for each tag

Usage: marfa device items add [OPTIONS] <FILE>

Arguments:
  <FILE>
          The file to add

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --mime-type <MIME_TYPE>
          The MIME type; the default comes from the file's extension

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --title <TITLE>
          The file item's title; the default is the file's name

      --type <TYPE>
          The file item's type; the default comes from the MIME type

      --tag <TAG>
          A tag, repeatable. Each is queued as a write of its own

      --tier <TIER>
          The tier to write the file item at

          [possible values: library, feed]

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items attach

```text
Attach a file to an item: its upload, a file item naming the bytes, and an `attached-to` edge, three
queued writes

Usage: marfa device items attach [OPTIONS] <ID> <FILE>

Arguments:
  <ID>
          The item to attach the file to

  <FILE>
          The file to attach

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --mime-type <MIME_TYPE>
          The MIME type; the default comes from the file's extension

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --title <TITLE>
          The file item's title; the default is the file's name

      --type <TYPE>
          The file item's type; the default comes from the MIME type

      --tier <TIER>
          The tier to write the file item at

          [possible values: library, feed]

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items links

```text
The links and embeds of files in an item's body, read from the local copy: each with the item it
names, or why it names none yet

Usage: marfa device items links [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items embed

```text
The text that embeds a file item in an item's body, which reads back as the file's `attached-to`
edge to the item

Usage: marfa device items embed [OPTIONS] <ID> <FILE>

Arguments:
  <ID>
          The item whose body the embed goes in

  <FILE>
          The file item to embed

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device items thumbnail

```text
The thumbnail an item carries, read from the local copy with no request: its MIME type and size, and
its bytes written to `--out`

Usage: marfa device items thumbnail [OPTIONS] <ID>

Arguments:
  <ID>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --out <FILE>
          Where to write the image's bytes

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device folders

```text
Folders' settings: read from the copy, written through the folder door

Usage: marfa device folders [OPTIONS] <COMMAND>

Commands:
  create  Create a folder's settings through the folder door, at once and never queued; settings no
          folder follows are refused before they are sent
  change  Change a folder's settings through the folder door, at once, each named one replaced whole
  revoke  Retire a folder's settings through the folder door, at once. A revoked folder does not
          change
  get     A folder's settings as the copy holds them
  help    Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device folders create

```text
Create a folder's settings through the folder door, at once and never queued; settings no folder
follows are refused before they are sent

Usage: marfa device folders create [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --file <PATH>
          A file holding the settings as a JSON object; `-` reads stdin

      --body <JSON>
          The settings as a JSON object, inline

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --title <TITLE>
          The folder's name

      --search <JSON>
          Which items the folder holds, as a JSON object: `types`, `tier`, `state`, `filter` and
          `beneath`

      --defaults <JSON>
          What a new file takes where it leaves a blank, as a JSON object: `type`, `tier`,
          `properties`, `tags` and `edges`

      --include <PATTERN>
          A gitignore pattern for the paths the folder takes, repeatable; a dot-led path only where
          a pattern names it, and never a secret

      --ignore <PATTERN>
          A gitignore pattern for the paths the folder leaves alone, repeatable; it wins over an
          include pattern

      --first-placement <TYPE=DIR>
          Where a new item of a type made elsewhere first appears, as TYPE=DIR relative to the
          folder's root, repeatable

      --removal-threshold <JSON>
          When a removal pauses, as a JSON object: `files` and `fraction`

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device folders change

```text
Change a folder's settings through the folder door, at once, each named one replaced whole

Usage: marfa device folders change [OPTIONS] --version <VERSION> <ID>

Arguments:
  <ID>
          The folder's `system.folder` id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --version <VERSION>
          The version the change was based on

      --file <PATH>
          A file holding the settings as a JSON object; `-` reads stdin

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --body <JSON>
          The settings as a JSON object, inline

      --title <TITLE>
          The folder's name

      --search <JSON>
          Which items the folder holds, as a JSON object: `types`, `tier`, `state`, `filter` and
          `beneath`

      --defaults <JSON>
          What a new file takes where it leaves a blank, as a JSON object: `type`, `tier`,
          `properties`, `tags` and `edges`

      --include <PATTERN>
          A gitignore pattern for the paths the folder takes, repeatable; a dot-led path only where
          a pattern names it, and never a secret

      --ignore <PATTERN>
          A gitignore pattern for the paths the folder leaves alone, repeatable; it wins over an
          include pattern

      --first-placement <TYPE=DIR>
          Where a new item of a type made elsewhere first appears, as TYPE=DIR relative to the
          folder's root, repeatable

      --removal-threshold <JSON>
          When a removal pauses, as a JSON object: `files` and `fraction`

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device folders revoke

```text
Retire a folder's settings through the folder door, at once. A revoked folder does not change

Usage: marfa device folders revoke [OPTIONS] <ID>

Arguments:
  <ID>
          The folder's `system.folder` id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device folders get

```text
A folder's settings as the copy holds them

Usage: marfa device folders get [OPTIONS] <ID>

Arguments:
  <ID>
          The folder's `system.folder` id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device search

```text
Full-text search over the local copy, best match first

Usage: marfa device search [OPTIONS] <QUERY>

Arguments:
  <QUERY>
          Words to look for, matched as the server matches them: all must match, the last as a
          prefix, and a query in double quotes is a phrase

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --state <STATE>
          Exactly one state. Unset answers the active state

          [possible values: active, archived, trashed, revoked]

      --all-states
          Every state, not just the active one

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --type <TYPE>
          A type identifier; its subtypes are included

      --tag <TAG>
          Hits must carry every tag given

      --filter <EXPR>
          An expression in the server's listing grammar, answered as the server answers `filter`; a
          `backref` condition is refused

      --beneath <ID>
          Only this item and what it reaches along `parent-of` edges

      --limit <LIMIT>
          How many hits at most

          [default: 20]

      --folder <ID>
          Only what this `system.folder`'s search holds, as the folder holds it; refused where the
          copy's slice cannot answer the search whole

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device queue

```text
Every queued write, the body it carries and what became of it

Usage: marfa device queue [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device drain

```text
Send what the queue holds and record what came back.

One pass. A write that met a network rather than an answer is left where it was, uncounted, for the
next drain.

Usage: marfa device drain [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help (see a summary with '-h')

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device forget

```text
Clear the writes the server has answered.

A queue nobody empties makes every later write slower. Blocked and dead rows stay, because a caller
may still release them, and so does a refused write that carried content, until it is discarded.

Usage: marfa device forget [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help (see a summary with '-h')

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device discard

```text
Take a refused write out of the queue, with the content it carried.

The one way a refused create, edit, metadata, extension or edge write leaves the queue. A write
still waiting on it keeps it.

Usage: marfa device discard [OPTIONS] <ID>

Arguments:
  <ID>
          The refused write to discard

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help (see a summary with '-h')

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device release

```text
Send a blocked or dead write again, under a fresh key

Usage: marfa device release [OPTIONS] [ID]

Arguments:
  [ID]
          The queued write to release

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reason <REASON>
          Release every write blocked for this reason instead of one by id

          [possible values: credential_refused, key_spent, ancestor_unavailable,
          conflict_unresolved, awaiting_dependency]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device withdraw

```text
Take a write blocked `ancestor_unavailable` or `conflict_unresolved` out of the queue, and put the
copy back to what the server holds.

Sent again, such a write is refused the same way under any key. The writes held for it are refused
unsent.

Usage: marfa device withdraw [OPTIONS] <ID>

Arguments:
  <ID>
          The queued write to withdraw

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help (see a summary with '-h')

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device status

```text
What the local copy holds and where it came from

Usage: marfa device status [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device types

```text
The item types the copy holds, read from it alone, the ones an app declares for it, and the server's

Usage: marfa device types [OPTIONS] <COMMAND>

Commands:
  list      Every one the copy holds, by id
  served    Every one the server holds, read from it now, so a slice can be chosen before a first
            hydration. The copy is left as it is
  get       One by id; a type inherits the fields of the types above it
  declare   Declare the types this app saves, so a copy with no server checks what it queues against
            them and a hydration registers the ones the instance lacks, where the key may
  declared  The declarations this copy holds, with the empty `fields` and the `version` a
            registration needs filled in
  help      Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device types list

```text
Every one the copy holds, by id

Usage: marfa device types list [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device types served

```text
Every one the server holds, read from it now, so a slice can be chosen before a first hydration. The
copy is left as it is

Usage: marfa device types served [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device types get

```text
One by id; a type inherits the fields of the types above it

Usage: marfa device types get [OPTIONS] <ID>

Arguments:
  <ID>
          The id, such as `core.note`

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device types declare

```text
Declare the types this app saves, so a copy with no server checks what it queues against them and a
hydration registers the ones the instance lacks, where the key may.

Marfa's own types need no declaring. The call is the app's whole set, so it replaces every earlier
declaration.

Usage: marfa device types declare [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --definitions <JSON>
          A type definition, or an array of them, as JSON

      --file <PATH>
          A file holding the same

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help (see a summary with '-h')

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device types declared

```text
The declarations this copy holds, with the empty `fields` and the `version` a registration needs
filled in

Usage: marfa device types declared [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edge-types

```text
The edge types the copy holds, read from it alone, and the server's

Usage: marfa device edge-types [OPTIONS] <COMMAND>

Commands:
  list    Every one the copy holds, by id
  served  Every one the server holds, read from it now, so a slice can be chosen before a first
          hydration. The copy is left as it is
  get     One by id; a type inherits the fields of the types above it
  help    Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edge-types list

```text
Every one the copy holds, by id

Usage: marfa device edge-types list [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edge-types served

```text
Every one the server holds, read from it now, so a slice can be chosen before a first hydration. The
copy is left as it is

Usage: marfa device edge-types served [OPTIONS]

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edge-types get

```text
One by id; a type inherits the fields of the types above it

Usage: marfa device edge-types get [OPTIONS] <ID>

Arguments:
  <ID>
          The id, such as `core.note` or `parent-of`

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edges

```text
Edges between items, each its own write

Usage: marfa device edges [OPTIONS] <COMMAND>

Commands:
  list    The edges the copy holds from one item
  to      The edges the copy holds to one item
  create  Link two items, and queue the edge
  update  Change an edge's properties
  delete  Drop an edge locally and queue the delete
  help    Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edges list

```text
The edges the copy holds from one item

Usage: marfa device edges list [OPTIONS] <ITEM>

Arguments:
  <ITEM>
          The item the edges start from

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edges to

```text
The edges the copy holds to one item

Usage: marfa device edges to [OPTIONS] <ITEM>

Arguments:
  <ITEM>
          The item the edges point at

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edges create

```text
Link two items, and queue the edge

Usage: marfa device edges create [OPTIONS] --source <ID> --target <ID> --type <TYPE>

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --source <ID>
          The item the edge starts from

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --target <ID>
          The item the edge points at

      --type <TYPE>
          The edge type

      --properties <JSON>
          The edge's properties, as a JSON object

          [default: {}]

      --id <ID>
          The id to mint it under. Omitted, the device mints one

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edges update

```text
Change an edge's properties

Usage: marfa device edges update [OPTIONS] <ID>

Arguments:
  <ID>
          The edge id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --properties <JSON>
          The properties to write, as a JSON object. Whole values

          [default: {}]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

      --version <VERSION>
          The version the edit was based on. Required, as on an item

      --source <ID>
          Move the edge to this source, where each target holds one of its type

      --target <ID>
          Move the edge to this target, where each source holds one of its type

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device edges delete

```text
Drop an edge locally and queue the delete

Usage: marfa device edges delete [OPTIONS] <ID>

Arguments:
  <ID>
          The edge id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device tags

```text
Tags on an item, each its own write

Usage: marfa device tags [OPTIONS] <COMMAND>

Commands:
  add     Put one tag on an item
  remove  Take one tag off an item
  help    Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device tags add

```text
Put one tag on an item

Usage: marfa device tags add [OPTIONS] <ITEM> <TAG>

Arguments:
  <ITEM>
          The item id

  <TAG>
          The tag

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device tags remove

```text
Take one tag off an item

Usage: marfa device tags remove [OPTIONS] <ITEM> <TAG>

Arguments:
  <ITEM>
          The item id

  <TAG>
          The tag

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device metadata

```text
An item's metadata, written whole or merged

Usage: marfa device metadata [OPTIONS] <COMMAND>

Commands:
  replace  Write the item's tags whole, dropping any not named
  merge    Add the named tags, leaving the rest
  help     Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device metadata replace

```text
Write the item's tags whole, dropping any not named

Usage: marfa device metadata replace [OPTIONS] <ITEM>

Arguments:
  <ITEM>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --tag <TAG>
          A tag, repeatable

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device metadata merge

```text
Add the named tags, leaving the rest

Usage: marfa device metadata merge [OPTIONS] <ITEM>

Arguments:
  <ITEM>
          The item id

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --tag <TAG>
          A tag, repeatable

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device extensions

```text
An item's extension namespaces, each its own write

Usage: marfa device extensions [OPTIONS] <COMMAND>

Commands:
  write   Write one extension namespace
  delete  Remove one extension namespace
  help    Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device extensions write

```text
Write one extension namespace

Usage: marfa device extensions write [OPTIONS] <ITEM> <NAMESPACE>

Arguments:
  <ITEM>
          The item id

  <NAMESPACE>
          The extension namespace

Options:
      --body <JSON>
          The namespace's contents, as a JSON object

          [default: {}]

      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device extensions delete

```text
Remove one extension namespace

Usage: marfa device extensions delete [OPTIONS] <ITEM> <NAMESPACE>

Arguments:
  <ITEM>
          The item id

  <NAMESPACE>
          The extension namespace

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device blobs

```text
Blobs' bytes: uploaded as queued writes, fetched when asked for

Usage: marfa device blobs [OPTIONS] <COMMAND>

Commands:
  put   Hold a file's bytes beside the store and queue their upload
  get   Print where a blob's bytes are held, fetching them first where the store does not hold them
        yet
  help  Print this message or the help of the given subcommand(s)

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device blobs put

```text
Hold a file's bytes beside the store and queue their upload

Usage: marfa device blobs put [OPTIONS] <FILE>

Arguments:
  <FILE>
          The file to upload

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --mime-type <MIME_TYPE>
          The MIME type to send them under; the default comes from the file's extension

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa device blobs get

```text
Print where a blob's bytes are held, fetching them first where the store does not hold them yet

Usage: marfa device blobs get [OPTIONS] <HASH>

Arguments:
  <HASH>
          The blob's hash, `sha256:<hex>`

Options:
      --db <PATH>
          The working copy's database file

          [env: MARFA_DB]

      --reader
          Open the store to read only: never claim the writer role, never write, and refuse a path
          where no store has been made

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

## folders

### marfa folders

```text
Folders on this machine, a directory that holds a slice as files, and their settings on the server

Usage: marfa folders [OPTIONS] <COMMAND>

Commands:
  add      Make a directory a folder that follows a `system.folder`'s settings, which `folders
           create` makes. Needs read on `system.folder`
  list     List the folders on this machine, as its registry holds them. The registry is the file
           MARFA_FOLDER_REGISTRY names, where it names one
  remove   Take a folder off this machine: its own state under `.marfa` goes, and its files stay as
           plain files. Refused while writes wait, except for a first sync still waiting to be
           confirmed, which this cancels. A folder whose directory is gone is taken off the list
  status   Say where every file in the folder stands, from its own store, asking the server nothing
  confirm  Let a folder's first sync go, or a paused large removal: its deletes are queued, and
           files whose items left elsewhere are taken away
  restore  Cancel a paused large removal: files gone from the disk are written back, and items that
           left elsewhere are restored
  hydrate  Pull what the folder's search needs into its working copy
  scan     Read the folder and queue what has changed. Sends nothing
  pull     Write what the folder's search matches out as files
  push     Scan, drain, catch up, pull, and send the placements the pull queued: everything a folder
           does, once
  create   Create a folder's settings on the server, as a `system.folder`. Needs write on
           `system.folder`
  change   Change a folder's settings on the server, each named one replaced whole
  revoke   Retire a folder's settings on the server. A revoked folder does not change
  watch    Watch a folder and keep it in step
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders add

```text
Make a directory a folder that follows a `system.folder`'s settings, which `folders create` makes.
Needs read on `system.folder`

Usage: marfa folders add [OPTIONS] --folder <ID> <DIR>

Arguments:
  <DIR>
          The directory. It is made if it is not there

Options:
      --folder <ID>
          The folder's `system.folder` id

      --yes
          Confirm the first sync without asking, for scripts. Without it, the add says what the
          first sync will do and waits for a go-ahead

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders list

```text
List the folders on this machine, as its registry holds them. The registry is the file
MARFA_FOLDER_REGISTRY names, where it names one

Usage: marfa folders list [OPTIONS]

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders remove

```text
Take a folder off this machine: its own state under `.marfa` goes, and its files stay as plain
files. Refused while writes wait, except for a first sync still waiting to be confirmed, which this
cancels. A folder whose directory is gone is taken off the list

Usage: marfa folders remove [OPTIONS] <DIR>

Arguments:
  <DIR>
          The folder

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders status

```text
Say where every file in the folder stands, from its own store, asking the server nothing

Usage: marfa folders status [OPTIONS] <DIR>

Arguments:
  <DIR>
          The folder

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders confirm

```text
Let a folder's first sync go, or a paused large removal: its deletes are queued, and files whose
items left elsewhere are taken away

Usage: marfa folders confirm [OPTIONS] <DIR>

Arguments:
  <DIR>
          The folder

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders restore

```text
Cancel a paused large removal: files gone from the disk are written back, and items that left
elsewhere are restored

Usage: marfa folders restore [OPTIONS] <DIR>

Arguments:
  <DIR>
          The folder

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders hydrate

```text
Pull what the folder's search needs into its working copy

Usage: marfa folders hydrate [OPTIONS] <DIR>

Arguments:
  <DIR>
          The folder

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders scan

```text
Read the folder and queue what has changed. Sends nothing

Usage: marfa folders scan [OPTIONS] <DIR>

Arguments:
  <DIR>
          The folder

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders pull

```text
Write what the folder's search matches out as files

Usage: marfa folders pull [OPTIONS] <DIR>

Arguments:
  <DIR>
          The folder

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders push

```text
Scan, drain, catch up, pull, and send the placements the pull queued: everything a folder does, once

Usage: marfa folders push [OPTIONS] <DIR>

Arguments:
  <DIR>
          The folder

Options:
  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders create

```text
Create a folder's settings on the server, as a `system.folder`. Needs write on `system.folder`

Usage: marfa folders create [OPTIONS]

Options:
      --file <PATH>
          A file holding the settings as a JSON object; `-` reads stdin

      --body <JSON>
          The settings as a JSON object, inline

      --title <TITLE>
          The folder's name

      --search <JSON>
          Which items the folder holds, as a JSON object: `types`, `tier`, `state`, `filter` and
          `beneath`

      --defaults <JSON>
          What a new file takes where it leaves a blank, as a JSON object: `type`, `tier`,
          `properties`, `tags` and `edges`

      --include <PATTERN>
          A gitignore pattern for the paths the folder takes, repeatable; a dot-led path only where
          a pattern names it, and never a secret

      --ignore <PATTERN>
          A gitignore pattern for the paths the folder leaves alone, repeatable; it wins over an
          include pattern

      --first-placement <TYPE=DIR>
          Where a new item of a type made elsewhere first appears, as TYPE=DIR relative to the
          folder's root, repeatable

      --removal-threshold <JSON>
          When a removal pauses, as a JSON object: `files` and `fraction`

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders change

```text
Change a folder's settings on the server, each named one replaced whole

Usage: marfa folders change [OPTIONS] --version <VERSION> <ID>

Arguments:
  <ID>
          The folder's `system.folder` id

Options:
      --version <VERSION>
          The version the change was based on

      --file <PATH>
          A file holding the settings as a JSON object; `-` reads stdin

      --body <JSON>
          The settings as a JSON object, inline

      --title <TITLE>
          The folder's name

      --search <JSON>
          Which items the folder holds, as a JSON object: `types`, `tier`, `state`, `filter` and
          `beneath`

      --defaults <JSON>
          What a new file takes where it leaves a blank, as a JSON object: `type`, `tier`,
          `properties`, `tags` and `edges`

      --include <PATTERN>
          A gitignore pattern for the paths the folder takes, repeatable; a dot-led path only where
          a pattern names it, and never a secret

      --ignore <PATTERN>
          A gitignore pattern for the paths the folder leaves alone, repeatable; it wins over an
          include pattern

      --first-placement <TYPE=DIR>
          Where a new item of a type made elsewhere first appears, as TYPE=DIR relative to the
          folder's root, repeatable

      --removal-threshold <JSON>
          When a removal pauses, as a JSON object: `files` and `fraction`

      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders revoke

```text
Retire a folder's settings on the server. A revoked folder does not change

Usage: marfa folders revoke [OPTIONS] <ID>

Arguments:
  <ID>
          The folder's `system.folder` id

Options:
      --idempotency-key <KEY>
          Sent as `Idempotency-Key`, so a repeat is answered from the record rather than written
          twice

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```

### marfa folders watch

```text
Watch a folder and keep it in step

Usage: marfa folders watch [OPTIONS] <DIR>

Arguments:
  <DIR>
          The directory to watch, recursively

Options:
      --for <SECONDS>
          Stop after this long. Unset, it runs until interrupted

  -h, --help
          Print help

Server:
      --url <URL>
          The server's base URL. Falls back to MARFA_API_URL, then to the server a kept credential
          made current

      --key <KEY>
          A key or a token for that server. Falls back to MARFA_API_KEY, then to the keychain: the
          file MARFA_KEYCHAIN names, where it names one

Output:
      --json
          Print the answer as JSON, and a refusal as one JSON object on stderr
```
