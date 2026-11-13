# Glossary

The words this repository uses for Marfa's things, one name per thing, and the words it does not use. Each entry says what a word names, what it does not name, and which word not to confuse it with. What each thing does is in the contract, `conformance/spec/`. A pull request is checked against this file: a name that is not here is either an ordinary English word or a mistake.

Write American English. Where Marfa has no rule of its own, the API's names and shapes follow Stripe's API conventions.

## The words

### Items and types

- **item**: One record, the unit everything else hangs off. It has a type, a state, properties, the time it occurred at and, except for an item of a `system.*` type, a tier.
- **type**: What an item is, named in the namespace grammar, such as `core.note`, `user.recipe` or `<publisher>.<name>`. The first segment is its **namespace**: `core` and `system` hold the types Marfa ships, `marfa` is reserved to Marfa, and `app`, `user` and a publisher's root hold the types registered at run time. A namespace is never called a tier.
- **display hints**: What a type says about how to show its items: `title_field`, the field that names an item; `body_field`, the field that holds its text as Markdown; `name_from_body`, false where that text never names an item; and `icon`.
- **icon**: The picture a type is shown by: an Iconify icon ID, `<set>:<name>`, such as `lucide:calendar-days` or `simple-icons:github`. A type's author sets it as `display_hints.icon`. The owner's icon for a type is a separate choice, kept beside the definition.
- **state**: Where an item is in its lifecycle: `active`, `archived`, `trashed` or `revoked`. Not a tier and not a status word. A connector's **state document**, the JSON object it keeps on the instance under its source, is another thing; name it in full.
- **bin**: Where a deleted item waits before a purge, in the CLI and in prose written for a person. The API's words are other words: the state is `trashed`, the operations say `trash`, and the permission is `items.purge`. Never write `bin` as a state, a path or a permission.
- **tier**: The layer an item sits in. `feed` holds what arrives in volume and as it came, from connectors and capture, under the source's own type, until a person or an app moves it to the library or archives it. `library` holds what a person chose to keep, modeled in a core type or a child of one. An item **moves to the library** or **moves to the feed** by a change of its `tier`: it is the same item, not a copy, and a connector's type must be readable as a core type, by `parent` or `compatible_with`, for the moved item to be read as one. Not a permission, not a lifecycle and not a namespace.
- **link**: The value an item holds in the field its type names as `link_field`: the item's own ID at the vendor that writes the type, by which a connector finds the item. A type's own, never inherited. The word keeps its ordinary sense of a URL, a blob's link or a `[[name]]` in a Markdown body where the sentence says which.
- **tombstone**: What a purge leaves of an item under its type: its link and its natural key, `(source, source_id)`, each with `purged_at` and `settled_at`. An entry from the vendor naming the key is a new item only if the vendor changed it after `settled_at`. Not a trashed item, which leaves none, and not a revoked grant.
- **view**: A saved list of items, held as a `system.view` that every app shares: its query says which items it lists, and its sort and group say in what order and how they group. How an app shows them is the app's own. Written only through `/views`. Not a folder, which holds items as files on a machine, and not a collection.

### Properties, metadata and edges

- **property**: A named value inside an item, governed by its type's schema. Never "field" for the same thing on the wire.
- **status field**: A type's one field of the `status` kind, whatever its name: `core.task` calls it `status`, `core.media` calls it `progress`.
- **status word**: A value a type's status field takes, such as `in_review`, declared in the field's `status_values` with the status group it belongs to. Never "status value", and never "state", which is the lifecycle.
- **status group**: One of four fixed meanings every status word belongs to: `not_started`, `in_progress`, `completed` and `canceled`. The same on every type, so a filter (`status_group`), a view or an app can tell what is open or finished without knowing a type's words.
- **table**: Rows in named columns that an item holds, such as the lines of a ledger, as its type declares. A table belongs to the item. An item of `core.table` holds one of its own, named `table`, whose columns are the item's `columns` property.
- **column**: A named, typed value a row of a table can hold: a `type` such as `string` or `number`, or `item` for the ID of an item.
- **row**: One record of a table, its values keyed by column, with an `id` that is a UUIDv7. Never an item: it has no version, tags, edges or history.
- **batch**: One write to the rows of one table of an item, made whole and named by a UUIDv7. The table's **change log** keeps each row as it stood before each batch, so a batch can be undone; an undo is a batch too.
- **tag**: A free-form, flat label on an item, searched alongside the item's text. A git tag that names a release, such as `v0.0.1`, is a release tag, not this.
- **extension**: A namespaced JSON object of metadata attached to an item by something other than the key that wrote the item, read and written per namespace. Not a blob and not a property.
- **edge**: A directed relationship between two items, named by its **edge type**. An edge has properties and a version of its own.
- **reverse name**: The name an edge type may declare for its edges read from the target, such as `child-of` for `parent-of`, used as a frontmatter key. Never "inverse". Not a reverse label.
- **written at**: The end of an edge type whose file writes its edges in a folder, `source` or `target`, or `none` where no file does (`written_at`).
- **label**: The heading a type, a field or an edge type shows for itself. An edge type's label heads the source end of its edges, such as `Children` on `parent-of`. Not the `id` and not a reverse name.
- **plural**: The name of a list of a type's items, such as `People` for `core.entity.person`.
- **reverse label**: The heading an edge type shows for the target end of its edges, such as `Parent` on `parent-of`. Not a reverse name, which is a frontmatter key.
- **excerpt**: A highlight, quote or clip that carries its own text and is taken from one item: the source of an `excerpt-of` edge to that item. Not a mention.
- **mention**: A link or embed in an item's text, or a system's own link from one item to another: a `references` edge, and nothing else. A passage taken from an item is an excerpt.
- **part**: An item out of the bin that is the source of an edge, to an item out of the bin, whose type's `cascade_on_delete` is `with-hosts`, such as `attached-to` or `comments-on`. The filter term `part eq true` selects parts.
- **host**: The target of a part's `with-hosts` edge: the item a comment is on or a file is attached to. Never a parent: a `parent-of` edge makes a child.

### Versions and events

- **version**: A monotonic integer on an item or an edge, which a write names to say which version it read (`versions/update-order`). The number a release's git tag carries is the product version, and the integer the root answers as `contract` is the contract version; neither is this.
- **writer**: The sign-in that wrote a version of an item: a browser session, an app, a key, or the private local command (`kind` `local`). `null` where no sign-in wrote the version, such as an enrichment (`versions/writer-recorded`).
- **event**: One entry in the log of what changed, with an `event_type`, read from the event stream and sent to outbound webhooks.

### Files

- **blob**: Bytes stored by content hash, with a size in `size_bytes` and a MIME type. An item refers to a blob; it never contains one.
- **file**: An item whose type inherits from `core.file` and refers to the blob that holds its bytes. In a folder, a file on disk, which is one item.
- **store**: A place a blob's bytes live: the disk beside the server, or an S3-compatible bucket. A store answers four verbs on a hash, put, get, has and delete, and carries its identity in a marker it holds. The **copy record** says which stores hold which blob. Never "backend".
- **replicate**: To copy into a store what it lacks from a store that has it, as the `blob-replicate` housekeeping job does. Never "mirror".

### Access

- **owner**: The person an instance belongs to: one per instance, established by a one-time claim.
- **credential**: An API key or an approved app's OAuth access token, whose permissions and maps define its API access. Not a browser session, and not local authority, which is a separate form of authority.
- **key**: An ordinary API credential, minted by local authority or by a credential with `keys.mint` within its own access, limited by its permissions and maps, and revocable. Not an access token.
- **working key**: An ordinary API key used by a client, script or connector.
- **source**: The code an item carries in `source` to say what wrote it. A key writes under its own source and any it claims (`sources`); an app writes under one that starts `oauth:` and names its `client_id`. A source is shown by its **name** and its **mark**, an icon ID set and checked as a type's icon is.
- **access token**: The credential an app holds once the owner signs in to it, issued by the OAuth provider and limited to what the owner granted. Not a key.
- **app**: A program a person signs in to the instance through the OAuth provider. Its registration, a `client_id` with its redirect URIs and the scopes it is registered for, is its **client**. An app holds an access token, and a refresh token where it asked for `offline_access`, and acts within its grant. "Client" keeps its ordinary sense of a program that calls the API where the sentence says which.
- **web page**: An app registered as a web client, whose redirect URIs are `https` addresses off the loopback. While the owner's grant to it stands, a browser page at those addresses may call the instance.
- **scope**: One literal an app asks for and a grant holds, such as `core.note:read`, `keys.mint` or `offline_access`: a type, edge or profile pattern at a level, a permission, or `offline_access`. A key holds the same reach through its permissions and maps, never through scopes.
- **consent**: A person's standing decision to let one app have some scopes, made on the consent screen or the device approval page. It outlives the browser session it was made in.
- **grant**: What a person's consent gives one app: the scopes it may use for that person. Not a permission, which a key holds.
- **refresh token**: The credential an app exchanges for a new access token without the person, issued only to an authorization that asked for `offline_access`.
- **session**: A signed-in browser: the cookie a password sign-in sets, which only the sign-in pages read, for consent, device approval and the owner's passkeys. Not a credential, so ending one ends no app's access. A connector's session token is another thing; name it in full.
- **sign-in**: One way the owner's Marfa can be reached, as `GET /owner/sign-ins` lists it: a browser session (`kind` `browser`), an app the owner approved (`kind` `app`, its grant) or a live key (`kind` `key`).
- **local authority**: Authority that only the private Unix socket supplies, to a process running under the server's operating-system account. Not an API key, and never asserted through public HTTP.
- **setup code**: A machine-issued proof that authorizes one owner claim. It grants no API access.

### Access words

Access is read the same way wherever a person sees it: on the pages where they approve it, on a key's page, on an app's page and in the CLI's output. For each kind of thing it is one level, and a short list of named powers. The server keeps its words in `core/marfa-server/src/http/pages/words.rs`; the CLI keeps the same words in `core/marfa-cli/src/access.rs`; `ci/access-words.test.ts` holds both to the tables below. A row the table does not title, such as an item type or a link type, is named by its own label on a page and as the scope writes it in the CLI (`core.note`, `edge.references`).

| Level   | The word      |
| ------- | ------------- |
| `none`  | No access     |
| `read`  | Read only     |
| `write` | Read and edit |

| Row                   | The title                  |
| --------------------- | -------------------------- |
| `*`                   | All your data              |
| `content`             | Your content               |
| `user.*`              | Your custom types          |
| `edge.*`              | Links between items        |
| `profile`             | Profile                    |
| `profile.name`        | Name                       |
| `profile.email`       | Email address              |
| `profile.avatar`      | Avatar                     |
| `metadata`            | Definitions on your server |
| `metadata.types`      | Custom data types          |
| `metadata.edge_types` | Custom relationship types  |

| Power               | The title                                          |
| ------------------- | -------------------------------------------------- |
| `keys.mint`         | Make, see, edit and revoke keys                    |
| `keys.manage`       | See, edit, narrow and revoke every key             |
| `grants.manage`     | See and disconnect other apps                      |
| `config.manage`     | See and change Marfa's settings                    |
| `instance.read`     | See health, metrics, storage and job status        |
| `instance.maintain` | Run housekeeping and cancel bulk jobs              |
| `schema.write`      | Replace or remove type definitions                 |
| `blobs.manage`      | Read and add any file, and manage file storage     |
| `webhooks.manage`   | Manage webhooks that send events to other services |
| `connectors.manage` | See, manage and remove all connectors              |
| `audit.read`        | Read the activity log                              |
| `items.purge`       | Delete items in the trash for good                 |

### The instance

- **instance**: One Marfa: the deployment that holds a dataset, identified by the `instance_id` minted at its first boot. Never a prefix, a permission or a column on an item. A sentence about what holds your items takes "instance"; a sentence about what answers HTTP takes "server". A device or client sentence naming the other end of the wire takes "server" too, whatever the verb: "an item on the server" draws the contrast between local and remote that is the point of the sentence.
- **server**: The software that answers HTTP for an instance: the source of truth every device copies.
- **operation**: One thing the API does, named by its method and path, such as `GET /items/{id}`, and by its `operationId` in the API document. Never "door".
- **contract version**: One integer, answered at `GET /` as `contract`, sent on every answer as `X-Marfa-Contract` and carried as the API document's `info.version`. Not the product version and not the build.
- **housekeeping**: The periodic jobs the server runs on itself, from one table and one scheduler; `housekeeping.md` lists them. None bounds what a connector keeps: its agreements go with their items, and its state document stays until it is cleared. One is "a housekeeping job", never a job alone: a bare job is a queued bulk action.

### Devices and folders

- **device**: Something that keeps a working copy of a slice and a queue of writes, through the core: an app built on the Swift SDK or the Node module, or the CLI. A folder is a device whose face is a directory.
- **core**: The Rust engine every native client embeds, through UniFFI to Swift and a native module to Node.
- **working copy**: A device's local copy of its slice. A copy, not a peer: the server is the truth.
- **slice**: The declared subset of an instance one device holds: a type list and a tier, and any edge types it holds whole. What a working copy is a copy of.
- **reach**: Two senses, so a sentence names which. **A key's reach** is what its permissions and maps let it read and write. **A working copy's reach** is the server's proof, for one credential, that the inventory, the direct reads and the event stream the copy holds were all read under the same limits; a copy stream gives it as `reach`, and a request sends it back as `X-Marfa-Reach`. Not `instance_changed`, which says a request reached another instance.
- **pin**: To hold one item in a working copy by ID, whatever the slice says of it.
- **verdict**: What a device gives a queued write once the server answers it, or once it cannot be sent: `accepted`, `merged` (applied with changes), `conflicted` (written to a conflicted copy), `refused` (with a reason), `blocked` (held, with a reason) or `dead` (given up after retries).
- **drain**: To send a device's queued writes to the server and record each answer as the write's verdict. Also the noun: one such pass over the queue, as `marfa device drain` runs it. Not catch-up, which brings the server's changes into the working copy.
- **forget**: To clear a device's answered writes from its queue: `marfa device forget`, and `forgetAnswered()` in the Swift SDK and the Node module. The contract says "clear" for the same act (`queue-and-verdicts/clear-answered`). `marfa keys forget` keeps the ordinary sense: it removes the credential kept for a server.
- **file cache**: The folder beside a device's store that holds, by hash, the bytes of the files the device fetched and of its queued uploads.
- **file budget**: The most bytes a device's file cache is to hold, other than the bytes of attachments.
- **attachment**: A part by an `attached-to` edge: any item, most often a file. A file attachment's bytes stay in the file cache outside the file budget.
- **folder**: A directory on a machine bound to a `system.folder`, whose settings every machine bound to it shares and writes out as one editable file, `.marfa/folder.yaml`: a query that decides what the folder holds, the defaults a new file takes, and include and ignore lists. A device whose face is a file system: a file in it is an item on the server, and an item its query matches is a file in it. Not a view and not a collection.
- **folder status**: The last observations reported for one folder copy under a sign-in that still stands, read at `GET /folders/{id}/status`. A report's age is not a claim that a machine is online.
- **placement**: Where an item's file sits in a folder: its `in-folder` edge to the folder's `system.folder`, whose `path` names the file from the folder's root. It never decides what a folder holds, and it is never written in a file.
- **registry**: The folder registry: one file on a machine that lists its folders, each by its directory and the `system.folder` it follows. Never a folder's store. The type registry is the server's catalog of types (`types.md`), another thing.
- **embed**: A file an item's body shows inside it, `![](path)` or `![[file]]`: the item's `references` edge to that file item. Showing a file is not owning it: the file is part of the item only through its `attached-to` edge. An embed that names no file, `![[A note]]` say, is an embed of a note: text in the body, neither a link nor an edge.
- **collection**: A container and its members: an item whose type plays the `container` role, such as `core.collection`, an album or a series, and the items joined to it by an `in-collection` edge, each with an optional `position`. Flat: a container is never a member, and `parent-of` is what hierarchy is for. Not a folder and not a view.
- **frontmatter**: The block of `key: value` lines between `---` fences that a Markdown file in a folder opens with. Never "header".

### Connectors

- **connector**: A program outside the server that has a connector registration, made under a key of its own (`POST /connectors`). Connectors never run inside the server. An app or a script that acts with a key or through OAuth but has no registration is not a connector.
- **hold**: The lock one process of a connector takes on its registration, under a name the process chose, and renews before it expires (`hold_expires_at`). As a verb, _hold_ stays ordinary English.
- **agreement**: A connector's record of what it and its vendor last agreed about one item, kept on the instance under the connector's source beside the item rather than in it. Not an extension, which is part of the item.
- **inbound webhook**: A request a sender outside the instance, such as GitHub, makes to tell a connector something changed. The webhooks the instance sends are **outbound webhooks**; "webhook" alone means those.
- **inbound endpoint**: An address on the instance that belongs to one source, where a sender posts inbound webhooks without a credential: the address is the credential.
- **delivery**: One request that arrived at an inbound endpoint, or one event the instance sends to an outbound webhook, across all its attempts.

### The CLI

- **CLI**: The `marfa` program: the reference client of an instance, and the subject of a rule for what only it does. Everything it does is a **command**.
- **command**: One command of the CLI, such as `marfa items list`. `core/marfa-cli/COMMANDS.md` lists every one.
- **binary**: The built file of the CLI. In prose about what it does, say **CLI**.
- **profile**: Two things, so a sentence names which. **The owner's profile** is the owner's name, email address and avatar on the instance, which `marfa profile update` changes and the `profile` access row and `--profile-permission` grant. **A profile in `profiles.toml`** is a section of the CLI's own file, written by hand, that names a server and where its key comes from, and that `--profile` or `MARFA_PROFILE` picks.

## Banned

These words are not used: none belongs in a tracked file, in code, a comment, a description or a document. Naming one in order to remove it, as this table does, is not a use. `ci/openapi/style.test.ts` checks `openapi.json` for `integration`, `substrate`, `hosted mode` and the British spelling of `canceled`.

| Banned                                                                     | Say instead                                                                                                                                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **integration**                                                            | **connector**, for a program with a connector registration; otherwise **app** or **script**                                                               |
| **the command**, or **the `marfa` command**, as the name of the whole tool | **the CLI**. A **command** is one command of it.                                                                                                          |
| **space**                                                                  | Nothing. There is no noun for the whole; permissions are named by what they permit, and the instance config lives at `/config`.                           |
| **sync**, as a program or product                                          | **folders**, for the thing that watches a directory; synchronization is still an ordinary English word, and the `sync` conformance project names the act. |
| **cancelled**, the British spelling                                        | **canceled**, and `canceling` for the same reason; `cancellation` is the American spelling too and is untouched.                                          |
| **substrate**                                                              | Name the thing itself: the store, the queue, the job table.                                                                                               |
| **hosted mode**                                                            | Nothing. There is one mode. "Self-hosted runner" and a virtual-hosted S3 URL are different words and are fine.                                            |

## Permissions

A permission is named by what it permits, never by a noun for the whole. It opens the operations it names and no item: what a credential reads and writes is its maps' alone, and no permission gives local authority. The first sentence of each row is copied into the contract's table of the twelve, in `conformance/spec/keys-and-oauth.md`, through `PERMISSION_TEXT` in `conformance/src/utils/catalogue-tables.ts`; change both together.

| Permission          | What it permits                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.write`      | Removing type and edge type definitions that already exist, and replacing them, only those the credential's type or edge map grants write on. Registering one takes `metadata.types:write` or `metadata.edge_types:write` instead. |
| `keys.mint`         | Minting keys within the caller's current access, and listing, changing and revoking keys within that access.                                                                                                                       |
| `items.purge`       | Destroying a trashed item irrecoverably, through the single-item operation and the bulk one alike.                                                                                                                                 |
| `webhooks.manage`   | Reading, registering, changing and removing the outbound subscriptions that send an instance's events out, and redelivering what they sent.                                                                                        |
| `config.manage`     | Reading and replacing the instance configuration at `/config`: the enforcement levers and the cleanup-job retention overrides. Not `config.write`: a caller refused it cannot read the configuration either.                       |
| `audit.read`        | Reading the audit log. There is no `audit.write`: the server writes the log, a caller never does.                                                                                                                                  |
| `grants.manage`     | Listing and revoking other apps' access. Not part of `keys.mint`: a key is this app's own credential, a grant is another app's, and an app trusted to rotate a key must not revoke every other app the owner authorized.           |
| `instance.read`     | Reading detailed health, metrics, housekeeping status, blob storage diagnostics and bulk job status.                                                                                                                               |
| `instance.maintain` | Running housekeeping and canceling bulk jobs.                                                                                                                                                                                      |
| `connectors.manage` | Reading and administering connector registrations, their runs and their endpoints, deleting registrations and clearing a registration's retained state.                                                                            |
| `blobs.manage`      | Managing blob bytes and copies across the instance, without granting item content access.                                                                                                                                          |
| `keys.manage`       | Listing and revoking keys across the instance, changing their metadata or narrowing access, and setting the name and mark of any source.                                                                                           |

The twelve permissions use ten roots, `schema`, `keys`, `items`, `webhooks`, `config`, `audit`, `grants`, `instance`, `connectors` and `blobs`, which the type grammar reserves with the scope roots (`types/id-reserved-scope-root`). Registration checks the reserved set, while the scope parser checks the closed set of permission literals: anything else under a permission root is refused, including `<root>.*:read` as a type grant.

## Time

One rule across the API, with one exception that is named rather than implied.

- Every time field is a verb plus `_at`: `occurred_at`, `created_at`, `updated_at`, `expires_at`, `revoked_at`.
- Every range filter is that verb plus `_after` and `_before`, and **both are exclusive**: an item's own time is filtered by `occurred_after` and `occurred_before`, and the audit log by `created_after` and `created_before`.

**`updated_after` is the exception, and it is not a bug.** It is the catch-up filter on `GET /items` and `GET /edges`, and it is **inclusive**, because `updated_at` ties across a bulk write: a strict bound drops every item that shares the cursor's instant, silently and for good, so a caller deduplicates by ID instead. **Do not make it exclusive to satisfy the rule above.** Its sibling `updated_before` is exclusive, like every other bound: a lower bound is a resume point a client hands back, an upper bound is an end point a caller chooses, and only the resume point can lose items to a tie.

## Errors

The meaning of every error code is in `conformance/spec/errors.md`. Two readings it does not state:

- `type_not_permitted` consults no registry: it says the credential may not reach the type here, never that the type exists.
- `table_not_found` is answered only for an item the credential may read; one it may not read answers `item_not_found` first, so the answer says nothing of the item's type.
