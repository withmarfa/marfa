# Glossary

The words this repository uses for Marfa's things, one name per thing, and the words it does not use. Each entry says what a word names, what it does not name, and which word not to confuse it with. What each thing does is in the contract, `conformance/spec/`. A pull request is checked against this file: a name that is not here is either an ordinary English word or a mistake.

Write American English. Where Marfa has no rule of its own, the API's names and shapes follow Stripe's API conventions.

## The words

### Items and types

- **item**: One record, the unit everything else hangs off. It has a type, a state, properties, the time it occurred at and, except for an item of a `system.*` type, a tier.
- **type**: What an item is, named in the namespace grammar, such as `core.note`, `user.recipe` or `<publisher>.<name>`. The first segment is its **namespace**: `core` and `system` hold the types Marfa ships, `marfa` is reserved to Marfa, and `app`, `user` and a publisher's root hold the types registered at run time. An `app.<vendor>` namespace is a **vendor**: it belongs to the app (the OAuth client) that registered the first type under it, which alone registers there and reaches its items without naming them. A namespace is never called a tier.
- **display hints**: What a type says about how to show its items: `title_field`, the field that names an item; `body_field`, the field that holds its text as Markdown; `name_from_body`, false where that text never names an item; and `icon`.
- **icon**: The picture a type is shown by: an Iconify icon ID, `<set>:<name>`, such as `lucide:calendar-days` or `simple-icons:github`. A type's author sets it as `display_hints.icon`. The owner's icon for a type is a separate choice, kept beside the definition.
- **state**: Where an item is in its lifecycle: `active`, `archived`, `trashed` or `revoked`. Not a tier and not a status word. A connector's **state document**, the JSON object it keeps on the instance under its source, is another thing; name it in full.
- **bin**: Where a deleted item waits before a purge, in the CLI and in prose written for a person. The API's words are other words: the state is `trashed`, the operations say `trash`, and the permission is `items.purge`. Never write `bin` as a state, a path or a permission.
- **purge**: To delete an item in the bin for good: by `POST /items/{id}/purge`, a bulk `purge`, `POST /trash/empty`, or the `trash-purge` housekeeping job once the bin's retention has elapsed. A purge takes the item's edges and the parts that went with it, announces `item.purged`, and leaves a tombstone. Only an item in the bin can be purged. Through the API, a credential needs `items.purge` and write on the item's type (`items/purge-type-write`). Not a trash, which moves an item to the bin and can be undone by a restore.
- **tier**: The layer an item sits in. `feed` holds what arrives in volume and as it came, from connectors and capture, under the source's own type, until a person or an app moves it to the library or archives it. `library` holds what a person chose to keep, modeled in a core type or a child of one. An item **moves to the library** or **moves to the feed** by a change of its `tier`: it is the same item, not a copy. A moved item is read as a core type through its type's `parent` or `compatible_with` (`types/parent`, `types/compatible-with`). Not a permission, not a lifecycle and not a namespace.
- **link**: The value an item holds in the field its type names as `link_field`: the item's own ID at the vendor that writes the type, by which a connector finds the item. A type's own, never inherited. The word keeps its ordinary sense of a URL, a blob's link or a `[[name]]` in a Markdown body where the sentence says which.
- **tombstone**: What a purge leaves of an item under its type: its link and its natural key, `(source, source_id)`, each with `purged_at` and `settled_at`. Not a trashed item, which leaves none, and not a revoked grant. What a write that names the key does is `connectors/tombstone-write-accepted`.
- **natural key**: An item's `source` and `source_id` together. A write that names one that a live item of its type holds updates that item, whichever key sends it, so a connector's item stays one item. Not the item's `id`, which a natural key decides before, and not its link. A conflicted copy gets neither it nor a link, and a tombstone keeps it.
- **conversation**: One item of `core.conversation`, whose messages are the rows of its `messages` table. A message is never an item, so it has no version, tags or edges. A message people view on its own, such as an email, is a `core.message` item.
- **occurrence**: One time an event happens, computed from a series when `GET /occurrences` reads a window and never stored. A series is one `core.event` item that carries rule lines in `recurrence`. An event that takes the place of one occurrence is an item of its own, joined to the series by `parent-of`; it is a moved occurrence, not a second series. Not a task, which carries `recurrence` but is never unfolded.
- **view**: A saved list of items, held as a `system.view` that every app shares: its query says which items it lists, and its sort and group say in what order and how they group. How an app shows them is the app's own. It is written through `/views` (`items/system-types`). Not a folder, which a directory on a machine follows, and not a collection.

### Properties, metadata and edges

- **property**: A named value inside an item, governed by its type's schema. Never "field" for the same thing on the wire.
- **status field**: A type's one field of the `status` kind, whatever its name: `core.task` calls it `status`, `core.media` calls it `progress`.
- **status word**: A value a type's status field takes, such as `in_review`, declared in the field's `status_values` with the status group it belongs to. Never "status value", and never "state", which is the lifecycle.
- **status group**: One of four fixed meanings every status word belongs to: `not_started`, `in_progress`, `completed` and `canceled`. The same on every type, so a filter (`status_group`), a view or an app can tell what is open or finished without knowing a type's words.
- **table**: Rows in named columns that an item holds, such as the lines of a ledger, as its type declares. A table belongs to the item. An item of `core.table` holds one of its own, named `table`, whose columns are the item's `columns` property.
- **column**: A named, typed value a row of a table can hold: a `type` such as `string` or `number`, or `item` for the ID of an item.
- **row**: One record of a table, its values keyed by column, with an `id` that is a UUIDv7. Never an item: it has no version, tags, edges or history.
- **batch**: One write to the rows of one table of an item, made whole and named by a UUIDv7. The table's **change log** keeps each row as it stood before each batch, so a batch can be undone; an undo is a batch too.
- **tag**: A free-form, flat label on an item (`search-and-filters/search-tags-with-text`). A git tag that names a release, such as `v0.0.1`, is a release tag, not this.
- **metadata**: The `metadata` member of an item answer: the item's `item_id`, its tags and its extensions. The word never means the tags alone, which have their own doors, `/items/{id}/tags` and `/tags`.
- **backrefs**: The edges that point at an item, listed by `GET /items/{id}/backrefs` and carried by an item read that asks for them. Never "inbound edges" or "reverse edges".
- **extension**: A namespaced JSON object of metadata attached to an item by something other than the key that wrote the item, read and written per namespace. Not a blob and not a property.
- **edge**: A directed relationship from one item to another, named by its **edge type**. `from_id` names its **from item**, the item it points from, and `to_id` its **to item**, the item it points to; together they are its two **ends**. An edge has properties and a version of its own. Never "source" or "target" for an end: a source is what wrote an item.
- **reverse name**: The name an edge type may declare for its edges read from the to item, such as `child-of` for `parent-of`, used as a frontmatter key. Never "inverse". Not a reverse label.
- **written from**: The end of an edge type whose file writes its edges in a directory, `from` or `to`, or `none` where no file does (`written_from`).
- **label**: The heading a type, a field or an edge type shows for itself. An edge type's label heads the from end of its edges, such as `Children` on `parent-of`. Not the `id` and not a reverse name.
- **plural**: The name of a list of a type's items, such as `People` for `core.entity.person`.
- **reverse label**: The heading an edge type shows for the to end of its edges, such as `Parent` on `parent-of`. Not a reverse name, which is a frontmatter key.
- **excerpt**: A highlight, quote or clip that carries its own text and is taken from one item: the from item of an `excerpt-of` edge to that item. Not a mention.
- **mention**: A link or embed in an item's text, or a system's own link from one item to another: a `references` edge, and nothing else. A passage taken from an item is an excerpt.
- **part**: An item out of the bin that is the from item of an edge, to an item out of the bin, whose type's `cascade_on_delete` is `with-hosts`, such as `attached-to` or `comments-on`. The filter term `part eq true` selects parts.
- **host**: The to item of a part's `with-hosts` edge: the item a comment is on or a file is attached to. Never a parent: a `parent-of` edge makes a child.

### Versions and events

- **version**: A monotonic integer on an item or an edge, which a write names to say which version it read (`versions/update-order`). The number a release's git tag carries is the product version, and the integer the root answers as `contract` is the contract version; neither is this.
- **writer**: The sign-in that wrote a version of an item: a browser session, an app, a key, or the private local command (`kind` `local`). `null` where no sign-in wrote the version, such as an enrichment (`versions/writer-recorded`).
- **conflicted copy**: The new item the server writes when a stale write resolved under `conflict=auto` collides on a property whose type's `merge_policy` is `keep_both_copies`: it holds the losing value, is tagged `conflicted-copy`, and carries the original's `source` and tags, with no natural key or link, at version 1. A device gives the write that made one the verdict `conflicted`.
- **keep-both copy**: Another name in the contract for a conflicted copy, taken from the `keep_both_copies` strategy that writes it. A keep-both write is the stale write that writes one. Use **conflicted copy** where a reader meets the tag or the verdict.
- **event**: One entry in the log of what changed, with an `event_type`, read from the event stream and sent to outbound webhooks.

### Files

- **blob**: Bytes stored by content hash, with a size in `size_bytes` and a MIME type. An item refers to a blob; it never contains one.
- **file**: An item whose type inherits from `core.file` and refers to the blob that holds its bytes. In a directory, a file on disk, which is one item.
- **store**: A place a blob's bytes live: the disk beside the server, or an S3-compatible bucket. A store answers four verbs on a hash, put, get, has and delete, and carries its identity in a marker it holds. The **copy record** says which stores hold which blob. Never "backend".
- **copy record**: The server's record of which stores hold which blob, and since when, read at `GET /blobs/{hash}/copies`.
- **replicate**: To copy into a store what it lacks from a store that has it, as the `blob-replicate` housekeeping job does. Never "mirror".

### Access

- **owner**: The person an instance belongs to: one per instance, established by a one-time claim.
- **credential**: An API key or an approved app's OAuth access token, whose permissions and maps define its API access. Not a browser session, and not local authority, which is a separate form of authority.
- **key**: An ordinary API credential, minted by local authority or by a credential with `keys.mint` within its own access, limited by its permissions and maps, and revocable. Not an access token.
- **working key**: An ordinary API key used by a client, script or connector.
- **source**: The code an item carries in `source` to say what wrote it. A key writes under its own source and any it claims (`sources`); an app writes under one that starts `oauth:` and names its `client_id`. A source is shown by its **name** and its **mark**, an icon ID set and checked as a type's icon is.
- **claimed source**: A source a key may write under besides its own, held in the key's `sources`. Keys that claim one source share its natural keys. A claim gives no ownership of an inbound endpoint, and a key an app made cannot gain one.
- **app's key**: A key an app minted, or one minted by such a key, which carries the app's `client_id` in `oauth_client_id`. It can only be narrowed, and it ends when the owner narrows the app below it, or disconnects the app and revokes its keys. Not an owner's key.
- **owner's key**: A key that carries no `oauth_client_id`, which no change to an app's access ends. Local authority and a key no app made mint only owner's keys; an app, or a key an app made, mints one with `owner_key`, which needs `keys.manage`. Not an app's key.
- **type map**: What a key's `type_permissions` say: the item types it may `read` or `write`, by exact type ID, a subtree wildcard such as `core.media.*`, or `*`. An exact entry decides before a wildcard, and a longer wildcard before a shorter. It is one of a key's **five maps**, with the extension map (`extension_permissions`, namespaces), the edge map (`edge_permissions`, edge types), the metadata map (`metadata_permissions`, registering types and edge types) and the profile map (`profile_permissions`, the owner's name, email and avatar). Not a permission: a permission opens operations, and a map alone opens items.
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
- **local command**: A request made with local authority, over the private socket: the route to what no key may do, such as claiming the instance, recovering the owner's password and minting a key with no ceiling. A write it makes has the writer `kind` `local`. Not an API key, and not a command of the CLI.
- **setup code**: A machine-issued proof that authorizes one owner claim. It grants no API access.
- **secret setting**: A stored setting that holds a credential, such as `object_store_secret_access_key`, `heartbeat_url` or `posthog_project_token`. The server seals it with a key that stays beside the database, says only whether it is set, and never puts its value in an answer, a log, a backup or an archive. Not a start-only secret such as `MARFA_AUTH_SECRET`, which the environment or `marfa.secrets` holds.

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
| `core.*`              | Built-in types             |
| `app.*`               | Every app's own data       |
| `edge.*`              | Links between items        |
| `profile`             | Profile                    |
| `profile.name`        | Name                       |
| `profile.username`    | Username                   |
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
| `instance.maintain` | Run housekeeping and update the server             |
| `schema.write`      | Replace or remove type definitions                 |
| `blobs.manage`      | Read and add any file, and manage file storage     |
| `webhooks.manage`   | Manage webhooks that send events to other services |
| `connectors.manage` | See, manage and remove all connectors              |
| `audit.read`        | Read the activity log                              |
| `items.purge`       | Delete items in the trash for good                 |
| `backups.manage`    | See, take, adopt and restore backups               |
| `sign_ins.manage`   | See, rename and end sign-ins and passkeys          |

### The instance

- **instance**: One Marfa: the deployment that holds a dataset, identified by the `instance_id` minted at its first boot. Never a prefix, a permission or a column on an item. A sentence about what holds your items takes "instance"; a sentence about what answers HTTP takes "server". A device or client sentence naming the other end of the wire takes "server" too, whatever the verb: "an item on the server" draws the contrast between local and remote that is the point of the sentence.
- **server**: The software that answers HTTP for an instance: the source of truth every device copies.
- **operation**: One thing the API does, named by its method and path, such as `GET /items/{id}`, and by its `operationId` in the API document. Never "door".
- **contract version**: One integer, answered at `GET /` as `contract`, sent on every answer as `X-Marfa-Contract` and carried as the API document's `info.version`. Not the product version and not the build.
- **housekeeping**: The periodic jobs the server runs on itself, from one table and one scheduler; `housekeeping.md` lists them. What stays of a connector's data is `housekeeping/connector-state-kept`. One is "a housekeeping job", never a job alone: a bare job is a queued bulk action.
- **archive**: The file `GET /export?format=archive` writes and `POST /restore` reads: a `manifest.json` with its own `version`, and the items and instance lines. Its version is the archive version, a number of its own, and not the contract version. A backup is a manifest and the parts it names, which together make an archive. Not the `archived` state of an item, which is `state` alone.
- **export**: What `GET /export` writes: items one per line (`ndjson`), or an archive. Naming no `state`, the server carries every state but `trashed`, in either format; `state=any` adds the bin. `marfa export` names no state for an archive as `any`, so an archive it writes holds the bin, and names none for `ndjson`, which leaves the bin out. A credential's export holds only what its maps let it read.
- **backup**: An archive of the instance that the server puts in the object store (`object_store_bucket`) or the backup folder (`backup_path`), on a schedule and when the owner asks with `POST /backups`. It holds every item and instance line, the trash included, and no file bytes, no credential and no secret setting's value. Not an export, which a credential reads of its own reach, and not a copy of the data directory.

### Devices and folders

- **device**: Something that keeps a working copy of a slice and a queue of writes, through the core: an app built on the Swift SDK, or the CLI. A directory that follows a folder is a device whose face is a file system.
- **core**: The Rust engine every native client embeds, through UniFFI to Swift and a native module to Node.
- **working copy**: A device's local copy of its slice. A copy, not a peer: the server is the truth.
- **hydration**: A device's read of its whole slice from the server: the head of the log first, then the item listing of each type the slice names, in every state, the edge types held whole and each pin. It runs when a copy is new or has expired, and a refused listing ends it before the copy loses anything. Not the edges an item answer carries, which `edges.md` calls hydrated.
- **catch-up**: A device's read of what changed since its cursor: it opens the event stream there and applies each event to the copy, or skips it. It keeps a hydrated copy current. Not a drain, which sends the device's writes. On the server, `updated_after` is the catch-up filter on `GET /items` and `GET /edges`.
- **slice**: The declared subset of an instance one device holds: a type list and a tier, and any edge types it holds whole. What a working copy is a copy of.
- **reach**: Two senses, so a sentence names which. **A key's reach** is what its permissions and maps let it read and write. **A working copy's reach** is the server's proof, for one credential, that the inventory, the direct reads and the event stream the copy holds were all read under the same limits; a copy stream gives it as `reach`, and a request sends it back as `X-Marfa-Reach`. Not `instance_changed`, which says a request reached another instance.
- **pin**: To hold one item in a working copy by ID, whatever the slice says of it.
- **verdict**: What a device gives a queued write once the server answers it, or once it cannot be sent: `accepted`, `merged` (applied with changes), `conflicted` (written to a conflicted copy), `refused` (with a reason), `blocked` (held, with a reason) or `dead` (given up after retries).
- **drain**: To send a device's queued writes to the server and record each answer as the write's verdict. Also the noun: one such pass over the queue, as `marfa device drain` runs it. Not catch-up, which brings the server's changes into the working copy.
- **forget**: To clear a device's answered writes from its queue: `marfa device forget`, and `forgetAnswered()` in the Swift SDK and the Node module. The contract says "clear" for the same act (`queue-and-verdicts/clear-answered`). `marfa keys forget` keeps the ordinary sense: it removes the credential kept for a server.
- **file cache**: The directory beside a device's store that holds, by hash, the bytes of the files the device fetched and of its queued uploads.
- **file budget**: The most bytes a device's file cache is to hold, other than the bytes of attachments.
- **attachment**: A part by an `attached-to` edge: any item, most often a file. A file attachment's bytes stay in the file cache outside the file budget.
- **folder**: A `system.folder` item on the instance: the settings every directory that follows it shares, which it writes out as one editable file, `.marfa/folder.yaml`: a query that decides what the folder holds, the defaults a new file takes, and include and ignore lists, and its ID. The instance holds it, so it has no place on any machine; a folder is named by its ID or its title. Not a directory, which is where a machine keeps a folder's files, and not a view or a collection.
- **directory**: A place on a machine's disk that follows a folder, added with `marfa folders add`. It holds a working copy and a queue, and a device whose face is a file system: a file in it is an item on the server, and an item its folder's query matches is a file in it. The `folders` commands, such as pull, scan, push and watch, act on a directory. A folder is not on disk; the directory is. Not a folder.
- **folder status**: The last observations reported for one directory of a folder under a sign-in that still stands, read at `GET /folders/{id}/status`. A report's age is not a claim that a machine is online.
- **placement**: Where an item's file sits in a directory: its `in-folder` edge to the folder's `system.folder`, whose `path` names the file from the directory's root and whose `form` says how the file writes its frontmatter. It never decides what a folder holds, and it is never written in a file. The edge keeps its name, `in-folder`.
- **form**: How a document's frontmatter is written, apart from what it says: its keys in order, which are empty, and each value's style. Its placement carries it as `form`, with no values, so a directory that never had the file writes it the same way. Not a format, which is what a field's value must look like.
- **registry**: The folder registry: one file on a machine that lists its directories, each with the `system.folder` it follows. It keeps the name folder registry, as `MARFA_FOLDER_REGISTRY` and `folders.json` do. Never a directory's store. The type registry is the server's catalog of types (`types.md`), another thing.
- **embed**: A file an item's body shows inside it, `![](path)` or `![[file]]`: the item's `references` edge to that file item. Showing a file is not owning it: the file is part of the item only through its `attached-to` edge. An embed that names no file, `![[A note]]` say, is an embed of a note: text in the body, neither a link nor an edge.
- **collection**: A container and its members: an item whose type plays the `container` role, such as `core.collection`, an album or a series, and the items joined to it by an `in-collection` edge, each with an optional `position`. Flat: a container is never a member, and `parent-of` is what hierarchy is for. Not a folder and not a view.
- **frontmatter**: The block of `key: value` lines between `---` fences that a Markdown file in a directory opens with. Never "header".

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
- **profile**: Two things, so a sentence names which. **The owner's profile** is the owner's name, username, email address and avatar on the instance. The username is the name the owner signs in with, and the email address is optional and plays no part in signing in. `marfa profile update` changes the profile, and the `profile` access row and `--profile-permission` grant. **A profile in `profiles.toml`** is a section of the CLI's own file, written by hand, that names a server and where its key comes from, and that `--profile` or `MARFA_PROFILE` picks.

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

A permission is named by what it permits, never by a noun for the whole. It opens the operations it names and no item: what a credential reads and writes is its maps' alone, except that a restore under `backups.manage` adds the archive's items and definitions, and its settings only with `config.manage`, and no permission gives local authority. The opening sentences of each row are copied into the contract's table of the fourteen, in `conformance/spec/keys-and-oauth.md`, through `PERMISSION_TEXT` in `conformance/src/utils/catalogue-tables.ts`; change both together.

| Permission          | What it permits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.write`      | Removing or replacing type and edge type definitions, within the credential's type or edge write access, and adding, changing or removing a type's guidance when registering, replacing or restoring. Registering a type still requires `metadata.types:write`. Registering an edge type requires `metadata.edge_types:write`.                                                                                                                                                                                                                                                                                                                                                    |
| `keys.mint`         | Minting keys within the caller's current access, and listing, changing and revoking keys within that access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `items.purge`       | Destroying a trashed item irrecoverably, through the single-item operation and the bulk one alike, and listing and emptying the trash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `webhooks.manage`   | Reading, registering, changing and removing the outbound subscriptions that send an instance's events out, and redelivering what they sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `config.manage`     | Reading and replacing the instance configuration at `/config`: the enforcement levers, the cleanup-job retention overrides and the stored settings, such as the addresses, the object store, the backup destination, the heartbeat and the PostHog settings. A secret setting can be set or removed but is never read back. A `PUT` keeps unnamed secrets, except `object_store_secret_access_key` when its bucket or endpoint changes. Changing `backup_path` or an `object_store_` setting other than the access key ID and the secret needs a recent sign-in, as `allow_private_addresses` does. Not `config.write`: a caller refused it cannot read the configuration either. |
| `audit.read`        | Reading the audit log. There is no `audit.write`: the server writes the log, a caller never does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `grants.manage`     | Listing, narrowing and revoking other apps' access, and moving a vendor to another app. Not part of `keys.mint`: a key is this app's own credential, a grant is another app's, and an app trusted to rotate a key must not revoke every other app the owner authorized.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `instance.read`     | Reading detailed health, what needs the owner's attention, metrics, housekeeping status, blob storage diagnostics and bulk job status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `instance.maintain` | Running housekeeping, canceling bulk jobs, updating the server and confirming the server's clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `connectors.manage` | Reading and administering connector registrations, their runs and their endpoints, deleting registrations and clearing a registration's retained state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `blobs.manage`      | Managing blob bytes and copies across the instance, without granting item content access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `keys.manage`       | Listing and revoking keys across the instance, changing their metadata or narrowing access, granting any source as a claim, and setting the name and mark of any source. Alone it never widens a key; with `keys.mint` the caller widens within its own access, and an app mints an owner's key.                                                                                                                                                                                                                                                                                                                                                                                  |
| `backups.manage`    | Listing the backups, taking one now, adopting the backup folder and restoring a backup or an archive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sign_ins.manage`   | Listing, renaming and ending the owner's sign-ins, listing, renaming and removing the owner's passkeys, getting the link that adds one and changing the owner's password.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The fourteen permissions use twelve roots, `schema`, `keys`, `items`, `webhooks`, `config`, `audit`, `grants`, `instance`, `connectors`, `blobs`, `backups` and `sign_ins`, which the type grammar reserves with the scope roots (`types/id-reserved-scope-root`). The scope parser takes no other name under them (`keys-and-oauth/device-permission-scope-closed`).

## Time

One rule across the API, with one exception that is named rather than implied.

- Every time field is a verb plus `_at`: `occurred_at`, `created_at`, `updated_at`, `expires_at`, `revoked_at`.
- Every duration is a whole number whose name ends in its unit: `ttl_seconds`, `interval_seconds`, `retry_after_seconds`, and `_days` or `_hours` for a retention. `_ms` names only a measured elapsed time, such as `latency_ms`. Marfa rounds a wait up, so a client never waits less than the real one. `Retry-After` and an OAuth token's `expires_in` keep the spelling their standards give them.
- Every range filter is that verb plus `_after` and `_before`, and **both are exclusive**: an item's own time is filtered by `occurred_after` and `occurred_before`, and the audit log by `created_after` and `created_before`.

**`updated_after` is the exception, and it is not a bug.** It is the catch-up filter on `GET /items` and `GET /edges`, and it is **inclusive**, because `updated_at` ties across a bulk write: a strict bound drops every item that shares the cursor's instant, silently and for good, so a caller deduplicates by ID instead. **Do not make it exclusive to satisfy the rule above.** Its sibling `updated_before` is exclusive, like every other bound: a lower bound is a resume point a client hands back, an upper bound is an end point a caller chooses, and only the resume point can lose items to a tie.

## Errors

The meaning of every error code is in `conformance/spec/errors.md`. Two codes that are easy to misread:

- `type_not_permitted` does not say whether a type exists (`errors/read-type-unregistered`, `errors/grant-type-unregistered`).
- `table_not_found` is for an item the credential may read (`tables/table-not-found-hidden`).
