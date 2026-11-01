# Types

The registry of item types: identifiers, fields, inheritance, merge and version policies, and the instance's enforcement levers.

## Shipped types

Every instance ships these types, core and `system`, each a row of the table below, which is written from the shipped type definitions and so cannot differ from them. A type's required properties include those it inherits from its parent.

<!-- types-table:start -->

| Type                 | Family | Parent        | Required properties            | Description                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------ | ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core.bookmark`      | core   | None          | None                           | Content you captured from elsewhere: a saved URL, a highlight, an excerpt, a clipped paragraph.                                                                                                                                                                                                                          |
| `core.collection`    | core   | None          | `title`                        | Items of any type that you gather together. Members join it through the in-collection edge, and it can hold any item but another container.                                                                                                                                                                              |
| `core.entity`        | core   | None          | `name`                         | Any named entity: a person, a company, a band, a team, a charity, a brand, a school or a place. `core.entity.person` and `core.entity.place` narrow it.                                                                                                                                                                  |
| `core.entity.person` | core   | `core.entity` | `name`                         | Contact information for an individual. Inherits all core.entity fields.                                                                                                                                                                                                                                                  |
| `core.entity.place`  | core   | `core.entity` | `name`                         | A location or venue. Inherits all core.entity fields.                                                                                                                                                                                                                                                                    |
| `core.event`         | core   | None          | `title`                        | Something that happens at a time.                                                                                                                                                                                                                                                                                        |
| `core.file`          | core   | None          | `blob_ref`, `mime_type`        | A file or binary reference: the generic fallback for any file that has no more specific type.                                                                                                                                                                                                                            |
| `core.file.audio`    | core   | `core.file`   | `blob_ref`, `mime_type`        | Recordings, music files, voice memos. Inherits all core.file fields.                                                                                                                                                                                                                                                     |
| `core.file.image`    | core   | `core.file`   | `blob_ref`, `mime_type`        | Photos, screenshots, diagrams. Inherits all core.file fields.                                                                                                                                                                                                                                                            |
| `core.file.video`    | core   | `core.file`   | `blob_ref`, `mime_type`        | Video files. Inherits all core.file fields.                                                                                                                                                                                                                                                                              |
| `core.file.webpage`  | core   | `core.file`   | `blob_ref`, `mime_type`        | An HTML page held as a file, such as a report an agent wrote. Inherits all core.file fields.                                                                                                                                                                                                                             |
| `core.highlight`     | core   | None          | `text`                         | A user's engagement with content: the highlighted passage plus optional annotation. What was highlighted is linked with an `excerpt-of` edge, not `references`; the moment of highlighting is the item's own `occurred_at`.                                                                                              |
| `core.media`         | core   | None          | `title`                        | Content produced by someone that the user engages with: a film, podcast, book, article, song, show.                                                                                                                                                                                                                      |
| `core.media.album`   | core   | `core.media`  | `title`                        | An album. Inherits all core.media fields.                                                                                                                                                                                                                                                                                |
| `core.media.article` | core   | `core.media`  | `title`                        | An article. Inherits all core.media fields.                                                                                                                                                                                                                                                                              |
| `core.media.book`    | core   | `core.media`  | `title`                        | A book. Inherits all core.media fields.                                                                                                                                                                                                                                                                                  |
| `core.media.episode` | core   | `core.media`  | `title`                        | Any member of an ongoing series: a TV episode, a podcast episode, one part of a serial. Inherits all core.media fields. Joins its series through the in-collection edge, so one episode can belong to several series and outlives any of them.                                                                           |
| `core.media.film`    | core   | `core.media`  | `title`                        | A film. Inherits all core.media fields.                                                                                                                                                                                                                                                                                  |
| `core.media.game`    | core   | `core.media`  | `title`                        | A video, board or card game. Inherits all core.media fields.                                                                                                                                                                                                                                                             |
| `core.media.series`  | core   | `core.media`  | `title`                        | Any ongoing media container: a TV show, a podcast, a radio serial, a video series. Inherits all core.media fields. Episodes join it through the in-collection edge; containment is never part of a type name.                                                                                                            |
| `core.media.song`    | core   | `core.media`  | `title`                        | A song. Inherits all core.media fields.                                                                                                                                                                                                                                                                                  |
| `core.message`       | core   | None          | `from`                         | A light, cross-platform message. Threading is edge-based via in-thread; reply trees via parent-of. Tool-specific richness lives in app namespaces.                                                                                                                                                                       |
| `core.note`          | core   | None          | None                           | Text content you created.                                                                                                                                                                                                                                                                                                |
| `core.task`          | core   | None          | `title`                        | Something to be done.                                                                                                                                                                                                                                                                                                    |
| `system.connection`  | system | None          | `kind`, `status`, `granted_at` | An OAuth client this user has authorized, written when the user approves the client's consent or device sign-in. `kind` is `app`. Lifecycle bounded to active \| revoked. Has no tier.                                                                                                                                   |
| `system.folder`      | system | None          | `title`                        | A folder's settings, held here and shared by every machine bound to the folder; each machine chooses only the directory. The settings are written only through `/folders`: created, changed at a version, and revoked. Lifecycle bounded to active \| revoked. Has no tier.                                              |
| `system.view`        | system | None          | `title`                        | A saved list of items, held here and shared by every app: which items, in what order and how they group. How an app shows them is the app's own. Written only through `/views`: created, changed at a version, and deleted, which removes it at once with no trash. Lifecycle bounded to active \| revoked. Has no tier. |

<!-- types-table:end -->

## Identifiers

### `types/id-grammar`

The server MUST take as a type identifier two or more dot-separated segments, each starting with a lowercase letter and holding only lowercase letters, digits, hyphens and underscores, at most 128 characters in all, with exactly two segments after an `app` root.

**Tests:** `compliance/type-identifier-validation.test.ts › accepts a three-part app-namespaced type identifier (app.example.bookmark)`, `› rejects a non-tiered three-part type identifier (com.example.bookmark)`, `› accepts underscores in type identifier segments (eval.custom_type)`, `› accepts hyphens in type identifier segments (local.my-custom-type)`, `› accepts community type format (acme.deal)`, `› accepts a two-part type identifier (core.bookmark)`, `compliance/validation.test.ts › rejects deep multi-segment type identifiers as unknown`, `› accepts type identifier at exactly 128 characters (grammar boundary)`, `› accepts hyphens in type identifier segments (grammar boundary)`, `› accepts type identifier with exactly 2 segments`, `compliance/namespace.test.ts › accepts user.<type>`, `compliance/publisher-types.test.ts › accepts a two-segment publisher type identifier`.

### `types/id-malformed`

If an item write, a listing filter or `POST /types` names a type identifier the grammar refuses, then the server MUST answer `400 validation_error` naming the field, `type` or `id`.

**Tests:** `compliance/type-identifier-validation.test.ts › rejects a one-part type identifier (bookmark)`, `› rejects uppercase characters in type identifier (Core.Bookmark)`, `› rejects slash-separated type identifiers`, `› refuses a segment that does not start with a letter, an empty segment and a trailing dot`, `compliance/namespace.test.ts › refuses an app type with more than one segment after app.`, `compliance/validation.test.ts › rejects type identifier with fewer than 2 segments`, `› rejects type identifier exceeding 128 characters`, `compliance/namespace.test.ts › rejects app.<X> with only one segment after app.`, `› rejects forward-slash type identifiers`, `compliance/types.test.ts › rejects type registration with invalid type identifier`.

### `types/id-unknown`

If an item write or a listing filter names a well-formed type identifier nothing registered, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/type-registry.test.ts › rejects item with an unregistered type`, `compliance/type-identifier-validation.test.ts › accepts community type format (acme.deal)`, `compliance/validation.test.ts › rejects deep multi-segment type identifiers as unknown`.

### `types/id-reserved-scope-root`

If a type identifier's first segment is `schema`, `keys`, `items`, `webhooks`, `config`, `audit`, `grants`, `instance`, `connectors`, `blobs`, `content`, `metadata`, `edge`, `profile` or `space`, then the server MUST refuse it as `types/id-malformed` refuses an identifier the grammar refuses.

**Reason:** each heads a permission or scope family, so a type under it could be written and never granted.

**Tests:** `compliance/namespace.test.ts › refuses a two-segment type under every root the grammar reserves`, `› still answers unknown_type for a publisher root that merely looks reserved`, `› refuses to register a type under a root the grammar reserves`.

### `types/id-reserved-namespace`

If `POST /types` names an identifier under `core`, `system` or `marfa`, then the server MUST answer `403 forbidden` with `details.namespace` naming the root, whatever the credential.

**Tests:** `compliance/namespace.test.ts › refuses %s.* registration from the broadest credential the suite holds`, `› refuses a reserved-namespace registration from a narrower credential too`.

### `types/id-root-not-prefix`

The server MUST judge a reserved root by the whole first segment, so `core-pub` or `keys-pub` is an ordinary root.

**Tests:** `compliance/publisher-types.test.ts › reserved-root prefix-match heuristic does not false-positive`, `› registers a publisher type whose root only looks reserved`, `compliance/namespace.test.ts › still answers unknown_type for a publisher root that merely looks reserved`.

## Registering a type

### `types/register`

When a key sends `POST /types` with an `id` and `fields` it may register, the server MUST answer `201` with the `type` as stored.

**Tests:** `compliance/type-registry.test.ts › registers a new custom type`, `compliance/types.test.ts › registers a custom type`.

### `types/register-effective`

When a type is registered, the server MUST list it at `GET /types`, answer it at `GET /types/{id}` and validate items of it against it.

**Tests:** `compliance/type-label.test.ts › label appears in type list`, `› register custom type with label`, `compliance/type-registry.test.ts › creates item with valid properties for a registered type`, `› rejects item with invalid properties for a registered type`.

### `types/register-permission`

If a key without `metadata.types:write` sends `POST /types`, then the server MUST answer `403 forbidden` with `details.metadata_subresource` `types`.

**Tests:** `compliance/type-registry.test.ts › rejects type registration from a key without metadata.types:write`.

### `types/register-reach`

If a key whose type map does not grant write on an identifier sends `POST /types` for it, then the server MUST answer `403 type_not_permitted` naming the identifier, whether or not another key registered it.

**Reason:** one key cannot take an identifier first and leave the key it was meant for unable to register it.

**Tests:** `compliance/type-registry.test.ts › registers only the ids the key's own type map grants write on`, `› refuses an identifier another key registered with 403 to a key whose map does not reach it`.

### `types/register-reach-scope`

When the server refuses `POST /types` under `types/register-reach` for an identifier whose own write scope an app cannot be granted, because nothing registered the identifier, the server MUST name in `details.required_scope` the narrowest namespace wildcard covering the identifier that an app can be granted, where there is one.

**Reason:** an unregistered identifier has no scope of its own, so without the wildcard an app signed in through OAuth could not be asked for what lets it register the identifier.

**Tests:** `compliance/type-registry.test.ts › names the namespace wildcard an app can be granted when a key may not register a new identifier`.

### `types/register-duplicate`

If `POST /types` names a valid schema under an identifier already registered, then the server MUST answer `409 type_already_exists`.

**Tests:** `compliance/type-registry.test.ts › rejects duplicate type registration with 409`, `compliance/types.test.ts › refuses a duplicate registration with a bad schema as the bad schema`.

### `types/register-no-fields`

If `POST /types` names no `fields`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/types.test.ts › rejects type registration without fields`.

### `types/register-no-id`

If `POST /types` names `fields` and no `id`, then the server MUST answer `400 invalid_schema`.

**Tests:** `compliance/types.test.ts › refuses a registration with no id as an invalid schema`.

### `types/field-shadows-item`

If a type declares a field named `id`, `type`, `state`, `tier`, `properties`, `created_at`, `updated_at`, `occurred_at`, `source`, `source_id`, `version`, `schema_version`, `capture_latitude`, `capture_longitude`, `trashed_at`, `trashed_by_cascade` or `trashed_with`, then the server MUST answer `400 property_shadows_field` naming each such field.

**Reason:** a row would carry two values under one key, with nothing to say which is authoritative.

**Tests:** `compliance/types.test.ts › rejects type registration whose property name shadows a first-class Item field`, `› refuses each field named like one every item has`, `› refuses a replacement whose property name shadows a first-class Item field, as registration does`.

### `types/field-builtin-names`

The server MUST take a field named like a built-in member of an object, such as `toString`, `valueOf`, `constructor` or `hasOwnProperty`, and write, read and update it as any other field.

**Tests:** `compliance/types.test.ts › writes and reads items of a type whose fields share a name with an object's built-in members`, `compliance/type-evolution.test.ts › takes fields named like an object's built-in members`.

### `types/refused-unchanged`

If the server refuses `POST /types` or `PUT /types/{id}`, then the server MUST leave the registry as it was.

**Tests:** `compliance/version-policy.test.ts › refuses the same on a replacement and keeps the type as it was`, `› names the field on a replacement that breaks the version policy, and registers nothing on a create`.

### `types/write-race`

When `POST /types`, `PUT /types/{id}` or `DELETE /types/{id}` races another registry write, the server MUST judge each against the registry as it stands when that write lands.

**Reason:** a parent deleted while a child registers, a child registered while its parent is deleted, or two re-parents closing a loop would otherwise leave a registry no single write could make.

**Tests:** `compliance/write-order.test.ts › refuses a child whose parent was deleted while registration waited`, `› refuses a parent deletion after a child registers`, `› refuses the second reparent that would close a loop`.

### `types/label`

When `POST /types` or `PUT /types/{id}` names no `label`, or an empty one, the server MUST give the type one made from the last segment of its identifier, with each hyphen and underscore made a space and each word capitalized.

**Tests:** `compliance/type-label.test.ts › register custom type without label`, `› makes a label from the identifier when a replacement names none`.

### `types/label-kept`

When `POST /types` or `PUT /types/{id}` names a non-empty `label`, the server MUST store it and answer it on every read of the type.

**Tests:** `compliance/type-label.test.ts › register custom type with label`, `› label appears in type list`.

### `types/plural`

When the definition stored for a type names no `plural`, or an empty one, the server MUST answer on every `GET /types/{id}`, and in the answer to `POST /types` and `PUT /types/{id}`, a plural made from its current label: a label that ends in a lowercase consonant and `y` takes `ies` in place of the `y`, a label that ends in `s`, `x`, `z`, `ch` or `sh` takes `es`, and any other label takes `s`.

**Reason:** an app names a list of a type's items, such as a sidebar's "Notes", and takes the name from Marfa rather than making its own from the identifier. `GET /types` answers only a plural a type declares (`types/list-declared-plural`). The rule is the regular English one, so `Story` makes `Stories` and `URL` makes `URLs`; a word it gets wrong, such as `Person`, is named by its type (`types/plural-kept`). A subtype's plural comes from its own label, never from its parent's plural.

**Tests:** `compliance/type-label.test.ts › makes a plural from the label when a type names none`, `› keeps a plural the type names`.

### `types/plural-kept`

When `POST /types` or `PUT /types/{id}` names a non-empty `plural`, the server MUST store it and answer it on every read of the type, `GET /types` included.

**Tests:** `compliance/type-label.test.ts › keeps a plural the type names`, `compliance/type-evolution.test.ts › admits a change to the plural and to a kept field's labels on metadata.types:write alone`.

### `types/field-label`

When a credential sends `GET /types/{id}` for a registered type, the server MUST answer a `label` for each field and for each member of a field's entries: the one the nearest type names, the type itself first and then its ancestors in turn, else one made from the field's or member's name as `types/label` makes one from an identifier's last segment.

**Reason:** an app shows a field by a name for people, such as "Due At" for `due_at`, and takes it from Marfa so that every app shows the same one. A subtype that declares an inherited field again without a label keeps the label above it, and a subtype's own label applies to it and its subtypes, never to its parent.

**Tests:** `compliance/type-label.test.ts › answers a field's own label, and one made from the name of a field or member that names none`, `› answers the nearest field label a type above names, and a child's own in its place`.

### `types/list-declared-label`

When `GET /types` lists a type, the server MUST answer the `label` of each field and member that the type itself declares, and none it only inherits or makes from a name.

**Reason:** a working copy resolves each type from the listing as `GET /types/{id}` does (`device/catalog-type-read`), and a made or inherited label listed as the type's own could not be told from a declared one, so it would take the place of a label a type above names. `GET /types/{id}` answers the label each field is shown by (`types/field-label`).

**Tests:** `compliance/type-label.test.ts › lists only the field labels a type declares`.

### `types/list-declared-plural`

When `GET /types` lists a type, the server MUST answer the `plural` the type itself declares, and none when it declares none.

**Reason:** a working copy makes the plural of each type from the listing as `GET /types/{id}` does (`device/catalog-type-read`), and a made plural listed as the type's own could not be told from a declared one, so it would freeze at the label the type had when listed. It is the same rule as for field labels (`types/list-declared-label`). `GET /types/{id}` answers the plural a type is shown by (`types/plural`).

**Tests:** `compliance/type-label.test.ts › lists only the plural a type declares`.

### `types/label-refused`

If `POST /types` or `PUT /types/{id}` names a `label` or `plural` for the type, or a `label` for a field or a member of a field's entries, that is not a string or is longer than 100 characters counted as Unicode code points, then the server MUST answer `400 invalid_schema` naming it.

**Reason:** a label is a short name an app shows in a list, a heading or a form; a longer text is a `description`.

**Tests:** `compliance/type-label.test.ts › refuses a label or plural longer than 100 characters or not text`.

## Reading the registry

### `types/read`

When a credential sends `GET /types/{id}` for a registered type, the server MUST answer it with the fields, `version_policy`, `merge_policy` and `retention_policy` its parents give it merged beside its own.

**Tests:** `compliance/type-inheritance.test.ts › a child reads back with the parent's fields merged beside its own`, `compliance/types.test.ts › a runtime-registered custom child type inherits the parent's resolved merge_policy on GET`, `compliance/version-policy.test.ts › reads back field by field from the parent, a field the child declares overriding`, `compliance/retention-policy.test.ts › reads back the window a parent declares, a child's own or null replacing it`.

### `types/list-declared-policy`

When `GET /types` lists a type, the server MUST answer the `version_policy`, `merge_policy` and `retention_policy` the type itself declares, and none it only inherits.

**Reason:** `GET /types/{id}` answers the policies a type is held to (`types/read`); the listing shows what each registration says.

**Tests:** `compliance/version-order.test.ts › lists the version_policy and merge_policy a type declares, and answers the resolved ones for the type itself`, `compliance/retention-policy.test.ts › lists the window a type declares and none it only inherits`.

### `types/read-display-hint`

When a credential sends `GET /types/{id}` for a registered type, the server MUST answer each of `display_hints.title_field`, `display_hints.body_field` and `display_hints.icon` from the nearest type, the type itself first and then its ancestors in turn, that sets that hint.

**Reason:** a type that names only a body hint still shows its parent's title, and a subtype that names only an icon keeps both of its parent's other hints, so a reader never has to guess which hints a type sets for itself (`device/catalog-type-read`).

**Tests:** `compliance/type-inheritance.test.ts › answers each display hint from the nearest type that sets it`.

### `types/list-declared-hints`

When `GET /types` lists a type, the server MUST answer the `display_hints` the type itself declares, with the icon the owner chose for it (`types/icon-read`), and none it only inherits.

**Reason:** `GET /types/{id}` answers the hints a type is shown by (`types/read-display-hint`); the listing shows what each registration says.

**Tests:** `compliance/type-icons.test.ts › lists the hints a type declares and not those it inherits`.

### `types/list-own-roles`

When `GET /types` lists a type, the server MUST answer in `own_roles` the roles the type itself declares, an empty list when it declares none, beside the `roles` it plays with those its ancestors give it.

**Reason:** a client that changes a type through `PUT /types/{id}` sends the roles the type declares, and `roles` alone cannot tell a role a subtype declares from one its parent also plays; the subtype keeps a role it declares when its parent stops playing it.

**Tests:** `compliance/type-inheritance.test.ts › lists the roles a type declares apart from the roles it plays`.

### `types/body-markdown`

The server MUST keep the field a type names in `display_hints.body_field` as Markdown text, storing its value as sent and never refusing it as malformed Markdown.

**Reason:** an app renders the body as Markdown, and a device reads it as Markdown to make the edges its text names (`folders/body-reference`); the server stores what it is given, so a connector converts HTML to Markdown before it writes.

**Tests:** `compliance/type-icons.test.ts › stores a body field's value as sent, whatever Markdown it holds`.

### `types/icon-name`

If a request to `POST /types`, `PUT /types/{id}` or `POST /types/normalize` carries a `display_hints.icon` that is not an Iconify icon ID, `<set>:<name>`, whose set is `lucide` at `@iconify-json/lucide` 1.2.149 or `simple-icons` at `@iconify-json/simple-icons` 1.2.101 and whose name is one of that version's icons, neither an alias nor one the set marks hidden, then the server MUST answer `400 invalid_schema` naming the member `display_hints.icon`.

**Reason:** an app draws the icon from its own copy of those sets at those versions, so an ID outside them draws nothing. A bare name such as `calendar`, a set not named here, a name the set's version does not have, an alias such as `lucide:alert-circle`, an icon the set marks hidden because it removed it, and a wrong-case or padded ID are all refused alike. Lucide is the set for everything but brand marks, which come from Simple Icons, such as `simple-icons:github`. The lists are `packages/types/generated/icon-set-lucide.json` and `icon-set-simple-icons.json`, regenerated from the pinned packages.

**Tests:** `compliance/type-icons.test.ts › refuses a display_hints.icon that is not an icon ID from a pinned set on every door that takes a definition`.

### `types/read-missing`

If `GET /types/{id}` or `DELETE /types/{id}` names an identifier nothing registered, or `PUT /types/{id}` names a well-formed one nothing registered, then the server MUST answer `404 type_not_found`, whatever the key's type map.

**Tests:** `compliance/types.test.ts › answers 404 for a type that is not registered`, `compliance/type-registry.test.ts › returns 404 for a non-existent type identifier`, `› answers 404 deleting a type identifier that was never registered`, `› answers 404 to a replacement of a type nothing registered, whatever the key's map`.

### `types/registry-open`

The server MUST answer `GET /types`, `GET /types/{id}` and `GET /edge-types` with the whole registry to every credential, whatever its type map and edge map reach.

**Reason:** a registered type and an unregistered one are already told apart, a schema holds no item data, and a device resolves an inherited field by walking `parent` (`device/catalog-type-read`).

**Tests:** `compliance/unreadable-type-filter.test.ts › lists every type and edge type to a key that reads two types`.

## Inheritance

### `types/parent`

When a type names a registered `parent`, the server MUST let its items take the parent's fields.

**Tests:** `compliance/type-inheritance.test.ts › a child reads back with the parent's fields merged beside its own`, `compliance/entity-subtypes.test.ts › person inherits all entity fields`.

### `types/parent-required`

When a parent requires a field, the server MUST require it of its subtypes' items.

**Tests:** `compliance/entity-subtypes.test.ts › requires an entity's name on a person and a place too`.

### `types/parent-unknown`

If `POST /types`, or a `PUT /types/{id}` from a key holding `schema.write` that changes the stored `parent`, names a `parent` nothing registered that the key's type map grants write on, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/type-inheritance.test.ts › refuses a parent nothing registered, and accepts the same child under one that is`, `compliance/type-evolution.test.ts › asks write on a parent nothing registered, before saying it is unknown`.

### `types/parent-chain`

If `POST /types`, or a `PUT /types/{id}` from a key holding `schema.write` that changes the stored `parent`, names a parent `types/parent-reach` admits and would make a type its own ancestor, or give any type more than ten ancestors, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/type-inheritance.test.ts › refuses a parent chain deeper than ten, and a circular one`.

### `types/child-adds`

The server MUST let a subtype add fields, redeclare an inherited field unchanged or with a new `description` or `label`, make an inherited field required, and redeclare an inherited status field with only the words it adds or none.

**Tests:** `compliance/type-inheritance.test.ts › accepts a child type that adds a field not present on the parent`, `› accepts a child that redeclares an inherited field without changing it`, `› lets a child tighten an inherited field to required, and refuses one that loosens it`, `compliance/type-label.test.ts › answers the nearest field label a type above names, and a child's own in its place`.

### `types/child-shape`

If a type would give a field another `type`, `format`, `items_type`, `items_fields`, `searchable`, `maxLength`, `maxItems` or `enum_values` than a type in its chain gives it, or a status field's words in a way `types/status-inherit` does not take, or make an inherited required field optional, then the server MUST answer `400 inheritance_violation` naming the field.

**Tests:** `compliance/type-inheritance.test.ts › rejects a child type that changes an inherited field shape (inheritance_violation)`, `› rejects a parent gaining a field whose shape differs from one its child declares`, `› lets a child tighten an inherited field to required, and refuses one that loosens it`, `› refuses a replacement of a child that changes an inherited field's shape`, `compliance/thumbnails.test.ts › refuses a parent gaining a thumbnail under a name its child declares as text, and takes one its child declares as a thumbnail`, `compliance/status-groups.test.ts › refuses the inherited status field redeclared as another kind`, `compliance/field-rules.test.ts › refuses a child that changes the members of an inherited list`.

### `types/child-range`

The server MUST let a subtype add a `minimum` or a `maximum` to an inherited `number` or `integer` field that has none, and narrow an inherited range by raising its `minimum` or lowering its `maximum`.

**Reason:** a parent's items must stay valid as the parent's own, so a reader that relies on the parent's range is never surprised by a child.

**Tests:** `compliance/field-rules.test.ts › takes a child that tightens an inherited range, and refuses one that loosens it`.

### `types/child-range-refused`

If a type would give a `number` or `integer` field a `minimum` below, or a `maximum` above, the one a type in its chain gives it, or no `minimum` or `maximum` where that type gives one, or a replacement of a type would leave a subtype's range looser than the type's own, then the server MUST answer `400 inheritance_violation` naming the field.

**Tests:** `compliance/field-rules.test.ts › takes a child that tightens an inherited range, and refuses one that loosens it`, `› refuses a parent replacement that leaves a child's range looser`.

### `types/listing-subtree`

When a listing names a type, the server MUST answer the items of that type, of every type whose identifier begins with it and a dot, and of every type whose chain of `parent` reaches it.

**Tests:** `compliance/entity-subtypes.test.ts › querying core.entity returns all entity subtypes`, `› querying core.entity.person returns only persons`, `compliance/types.test.ts › selects a type filter's items by identifier and by declared parent alike`.

### `types/compatible-with`

When a type names `compatible_with`, the server MUST take it only where the type requires every field the target requires, its own or inherited, and every target field the type declares or inherits is readable as the target's: the same type, or `url`, `email`, `datetime`, `date`, `thumbnail`, `enum` or `status` where the target's is `string`, or `integer` where it is `number`; for an `array`, the same `items_type`; for an `enum`, values drawn from the target's; for a `status`, words the target's status field also holds, each in the same group; and, where both name a `format`, the same one.

**Tests:** `compliance/type-inheritance.test.ts › accepts compatible_with: core.note when fields satisfy the structural superset`, `› takes a compatible_with claim whose fields are readable as the target's, and refuses one that is not`, `compliance/thumbnails.test.ts › is read as the target's by a type claiming compatibility, and refused as text`, `compliance/status-groups.test.ts › reads a status field as a string, and as a status field holding its words in the same groups`.

### `types/compatible-with-range`

Where a type names `compatible_with` and the target's `number` or `integer` field has a `minimum` or a `maximum`, the server MUST take the claim only where the type's field has a `minimum` no lower, and a `maximum` no higher, than the target's.

**Reason:** a reader of the target relies on every value being inside its range, and a looser range lets a value through that the reader never expects. A target with no range is read from any range.

**Tests:** `compliance/field-rules.test.ts › reads a range as the target's only where it is inside the target's`.

### `types/compatible-with-currency`

Where a type names `compatible_with` and the target's field has the `format` `currency`, the server MUST take the claim only where the type's field has that `format`; a `string` field with the `format` `currency` is readable as a `string` field with no `format`.

**Reason:** `currency` is the one string format whose value is checked, so a plain string holds values a reader of a currency field never expects, while a currency string is a string.

**Tests:** `compliance/field-rules.test.ts › reads a currency string as a string, and a string not as a currency`.

### `types/compatible-with-items-fields`

Where a type names `compatible_with` and the target's `array` field names `items_fields`, or the type's does, the server MUST take the claim only where both name the same members, each defined alike.

**Reason:** a list of entries means what its members say, and two lists whose members differ hold entries a reader of the other would misread.

**Tests:** `compliance/field-rules.test.ts › reads a list of entries as the target's only where the members are identical`.

### `types/compatible-with-refused`

If a registration or replacement declares `compatible_with` naming a type nothing registered, or one the type is not compatible with, then the server MUST answer `422 compatible_with_violation`.

**Tests:** `compliance/type-inheritance.test.ts › rejects compatible_with target that does not exist`, `› rejects compatible_with when a required ancestor field is missing`, `› refuses a compatible_with claim whose target field the type declares in another shape, or optional where the target requires it`, `compliance/types.test.ts › refuses a replacement that breaks its compatible_with claim, as registration does`.

### `types/compatible-with-preserved`

If an otherwise permitted `PUT /types/{id}` or `DELETE /types/{id}` would break a registered type's `compatible_with` claim, directly or through inherited fields on either side, then the server MUST refuse the change with `422 compatible_with_violation` naming the affected claimants in `details.dependent_type_ids`, including a deletion with `force=true`.

**Reason:** compatibility is a maintained promise, so accepted registrations remain valid when exported and restored under `search-and-filters/restore-compatible-types`.

**Tests:** `compliance/restore-compatible-types.test.ts › refuses a target change that breaks a reader and restores the accepted registry`.

### `types/custom-lifecycle`

The server MUST hold an item of a registered type to the lifecycle of `items/transition`.

**Tests:** `compliance/types.test.ts › items of a custom type follow the universal lifecycle`.

## Merge policy

### `types/merge-policy`

When a type names a `merge_policy` of a `default` and per-field strategies, each `last_writer_wins` or `keep_both_copies`, the server MUST store it and answer it on `GET /types/{id}` merged through the parent chain, a field the type names overriding its parents.

**Tests:** `compliance/types.test.ts › POST /types accepts a custom type with a valid merge_policy`, `› GET /types/core.note returns the artifact-declared merge_policy`, `› a core child type exposes the parent's resolved merge_policy on GET`, `› a runtime-registered custom child type inherits the parent's resolved merge_policy on GET`, `correctness/merge-policy.test.ts › a child of core.note can override body from keep_both_copies to last_writer_wins`.

### `types/merge-policy-refused`

If a `merge_policy` names a field the type does not declare or inherit, or a strategy other than `last_writer_wins` and `keep_both_copies`, then the server MUST answer `400 invalid_schema`.

**Tests:** `compliance/types.test.ts › POST /types rejects a merge_policy referencing an unknown field`, `› POST /types rejects a merge_policy with an unknown strategy`, `› refuses a merge_policy naming an unknown field or strategy on a replacement too`.

## Field definitions

### `types/field-grammar`

If a type names a field definition with an unknown `type` or `format`, an `enum` whose `enum_values` is missing or empty or holds a value that is not a string, a status field `types/status-refused` refuses, an `array` with no `items_type`, or a `maxLength` or `maxItems` that is not a whole number of at least 1 or on a type it does not apply to, a `maxLength` on a `string` field whose `format` is `currency`, or a `minimum`, `maximum` or `items_fields` that `types/range-refused` or `types/items-fields-refused` refuses, or the type names `states`, `default_state` or `transitions`, a `required` entry naming a field that neither the type nor an ancestor declares, a role other than `container`, or a `display_hints` `title_field` or `body_field` naming a field neither it nor an ancestor declares, then the server MUST answer `400 invalid_schema` naming the member.

**Tests:** `compliance/field-types.test.ts › refuses a field definition the grammar does not take`, `› takes a required entry naming a field only an ancestor declares`, `compliance/field-rules.test.ts › refuses $what with invalid_schema, naming the member`.

### `types/unknown-key`

If `POST /types` or `PUT /types/{id}` names a key the type schema does not define, at the top level, in a field definition (which takes only `type`, `description`, `required`, `enum_values`, `status_values`, `items_type`, `items_fields`, `format`, `searchable`, `maxLength`, `maxItems`, `minimum` and `maximum`), in a member of `items_fields` (which takes only `type`, `description`, `required`, `enum_values`, `format`, `maxLength`, `minimum` and `maximum`), or in `display_hints`, `version_policy`, `merge_policy` or `retention_policy`, then the server MUST answer `400 invalid_schema` with `details.errors` naming the path of each such key.

**Reason:** a key the server ignored would let a misspelled rule, or an `exclusiveMinimum` on an `integer` field, register as though it held, and the type would then accept what its author meant it to refuse.

**Tests:** `compliance/types.test.ts › refuses a key the type schema does not define, at the top level, in a field and in a block, naming each path`, `› refuses a key the type schema does not define on a replacement, and keeps the type as it was`.

### `types/range`

When a type names a `minimum`, a `maximum` or both on a `number` or `integer` field, or on a member of `items_fields` of those kinds, the server MUST store them and answer them on `GET /types/{id}`.

**Reason:** a type that means "a whole number from 1 to 5" says so once, and every app gets the same refusal instead of each app checking for itself (`types/range-value-refused`). Both bounds are inclusive, as JSON Schema defines them.

**Tests:** `compliance/field-rules.test.ts › registers a range, a currency format and a list of entries, and answers them`.

### `types/range-refused`

If a field or a member of `items_fields` names a `minimum` or `maximum` on a type other than `number` or `integer`, one that is not a finite number, one that is not a whole number on an `integer` field, or a `minimum` above the `maximum`, then the server MUST answer `400 invalid_schema` naming the member.

**Tests:** `compliance/field-rules.test.ts › refuses $what with invalid_schema, naming the member`.

### `types/items-fields`

When a type names `items_fields` on an `array` field whose `items_type` is `object`, the server MUST store the members and answer them on `GET /types/{id}`.

**Reason:** a type can then promise that each entry in a list has a given shape, as a list of contacts or of attendees needs. A member takes `type`, `description`, `required`, `enum_values`, `format`, `maxLength`, `minimum` and `maximum`.

**Tests:** `compliance/field-rules.test.ts › registers a range, a currency format and a list of entries, and answers them`.

### `types/items-fields-refused`

If a type names `items_fields` on a field that is not an `array` whose `items_type` is `object`, names no member in it, or names a member that is not a `string`, `email`, `url`, `enum`, `boolean`, `integer`, `number`, `date` or `datetime`, or whose definition the field grammar refuses, then the server MUST answer `400 invalid_schema` naming the member.

**Reason:** a flat entry keeps the check simple and is enough for contact lists and attendees. A member that is a list, an object, a `status` or a `thumbnail` would need nesting the entry does not have.

**Tests:** `compliance/field-rules.test.ts › refuses $what with invalid_schema, naming the member`.

### `types/format-collapses`

When a `string` field names a `format` of `url`, `email`, `datetime`, `date` or `thumbnail`, the server MUST store the field as that type, and an `array` of strings naming one of the first four as an array of that type.

**Tests:** `compliance/types.test.ts › keeps a list of strings with a type-naming format a list`, `compliance/types.test.ts › stores email, datetime and date formats on a string as their own types`, `compliance/thumbnails.test.ts › registers by its type or by the format that stands for it`.

### `types/format-own-type`

When a field names a `format` that is its own type, the server MUST store the field as that type, without the `format`.

**Tests:** `compliance/types.test.ts › leaves a format that names the field's own type unchanged, and refuses thumbnail on a list`.

### `types/format-refused`

If a field names a type-naming `format` on a type other than `string`, the type the format names or a list of strings, or `thumbnail` on a list, then the server MUST answer `400 invalid_schema` naming the field's `format`.

**Tests:** `compliance/types.test.ts › refuses a type-naming format on a field that is neither a string nor a list of strings`, `compliance/types.test.ts › leaves a format that names the field's own type unchanged, and refuses thumbnail on a list`.

### `types/format-string-only`

When a `string` field names a `format` of `bcp47`, `iso3166`, `currency` or `phone`, the server MUST store the field as a `string` with that `format`.

**Tests:** `compliance/types.test.ts › keeps bcp47 and iso3166 as formats of a string, and refuses them on any other type`, `› keeps phone as a format of a string that takes any text, and refuses it on any other type`, `compliance/field-rules.test.ts › registers a range, a currency format and a list of entries, and answers them`.

### `types/format-string-only-refused`

If a field of a type other than `string` names a `format` of `bcp47`, `iso3166`, `currency` or `phone`, then the server MUST answer `400 invalid_schema`.

**Tests:** `compliance/types.test.ts › keeps bcp47 and iso3166 as formats of a string, and refuses them on any other type`, `› keeps phone as a format of a string that takes any text, and refuses it on any other type`, `compliance/field-rules.test.ts › refuses $what with invalid_schema, naming the member`.

### `types/datetime-value`

When an item names a value for a `datetime` field, the server MUST take a `YYYY-MM-DD` calendar date, or such a date followed by `T`, `HH:MM`, `HH:MM:SS` or `HH:MM:SS` with a decimal fraction, and `Z` or a `±HH:MM` offset, with hours to 23 and minutes and seconds to 59.

**Reason:** a value keeps the precision its source gave it, and a device validates the same values offline as the server does online (`device/declared-checked`).

**Tests:** `compliance/field-types.test.ts › takes every datetime form and refuses one with no zone or an hour past 23`, `device/property-validation-live.test.ts › matches a real server's field decisions and keeps queued writes across a catalog change`.

### `types/datetime-refused`

If an item names a `datetime` value with a time and no zone, or outside the bounds `types/datetime-value` states, or a `datetime` or `date` value naming a day the calendar does not have, or a `date` value with a time, then the server MUST answer `400 invalid_properties` naming the field.

**Tests:** `compliance/field-types.test.ts › takes every datetime form and refuses one with no zone or an hour past 23`.

### `types/url-value`

When an item names a value for a `url` field, an element of an array field whose `items_type` is `url`, or a `url` member of an entry of a list, the server MUST take the value where the WHATWG URL standard parses it as an absolute URL after the whitespace of JavaScript's `String.prototype.trim` is removed from both ends: the characters Unicode counts as white space except U+0085, and U+FEFF.

**Reason:** a device judges the same value offline as the server does online (`device/url-trimmed`), so a padded value that the standard takes is taken on both. The Node versions the server supports judge some hosts differently from each other and from the standard, so the server runs the standard with `whatwg-url`, its reference implementation, and does not use the platform's `URL`.

**Tests:** `device/property-validation-live.test.ts › treats %s in a url the same on both paths and stores the same value`.

### `types/url-punycode`

When a `url` value of a special scheme has a host that is ASCII once percent-decoded, the server MUST take the host whatever its labels hold, including a label that starts `xn--` and is not valid Punycode, except as `types/url-host-refused` states.

**Reason:** the standard lowercases an ASCII host and does not judge its labels, so `http://xn--`, `http://xn--%41` and `http://xn--xn---yna/` are URLs.

**Tests:** `compliance/field-types.test.ts › takes the url %s on a create`, `device/property-validation-live.test.ts › treats %s in a url the same on both paths and stores the same value`.

### `types/url-idna`

If a `url` value of a special scheme has a host with a character that is not ASCII once percent-decoded, and the host is not valid IDNA, then the server MUST refuse the value `invalid_properties`.

**Reason:** the standard runs only such a host through IDNA, so `http://bücher.xn--` is refused, because its `xn--` label is not Punycode and its host is not ASCII, while `http://xn--mnchen-3ya.de/` is taken.

**Tests:** `compliance/field-types.test.ts › refuses %s on a create, naming the field`, `device/property-validation-live.test.ts › refuses the url %j on both paths`.

### `types/url-host-refused`

If a `url` value of a special scheme has a host that holds a forbidden domain code point once percent-decoded, or whose last label is a number and the host is not a valid IPv4 address, then the server MUST refuse the value `invalid_properties`.

**Reason:** the standard refuses these hosts whatever their labels hold, so `http://xn--%2f/` and `http://xn--a.1/` are refused: the first decodes to a host with a slash, and the second goes to the standard's IPv4 parser.

**Tests:** `compliance/field-types.test.ts › refuses %s on a create, naming the field`, `device/property-validation-live.test.ts › refuses the url %j on both paths`.

### `types/url-stored`

When the server takes a `url` value, an element of an array of `url` or a `url` member of an entry of a list, the server MUST store the value without the whitespace trimmed from its ends and without tab, line feed and carriage return characters anywhere in it.

**Reason:** this holds at every door that writes properties: a create, an update (at the current version and a passed one), an upsert onto an existing item and a bulk entry.

**Tests:** `device/property-validation-live.test.ts › treats %s in a url the same on both paths and stores the same value`, `compliance/field-rules.test.ts › a url is stored without the whitespace around it at every door`.

### `types/array-items`

When an item names an `array` field whose `items_type` is a field type other than `status`, the server MUST take each element that a field of that type takes as its value, an `enum` taking the field's `enum_values` and, where the field names `items_fields`, an `object` taking only the entries `types/array-entries` takes.

**Reason:** a type is a promise a reader can rely on, and a list of strings that may hold a number makes every reader check each element again. `attachments` is a list of `object` and `links` a list of `string` on every type.

**Tests:** `compliance/field-types.test.ts › takes the values of the declared types, an empty array and a null`, `› checks a subtype's inherited array field`, `› checks a shipped type's array field`.

### `types/array-items-refused`

If a write of an item's properties, by a create, an update, an upsert or an entry of a bulk write, leaves an `array` field holding an element that a field of its `items_type` refuses, then the server MUST answer `400 invalid_properties` with `details.errors` naming the field and the element's position in `field`, as `names.1`.

**Reason:** this holds at every door and on the properties the item would stand with after the write, so the item is left as it was. An array already stored with a wrong element therefore also refuses a write that leaves it in place, because the whole resulting property set is judged, and the refusal names the element.

**Tests:** `compliance/field-types.test.ts › refuses %s on a create, naming the field`, `› checks the elements on an update, and keeps the item as it was when it refuses`, `› checks the elements of a bulk entry, an upsert by natural key and a bulk upsert`.

### `types/array-items-unnamed`

Where an `array` field's `items_type` names no field type, the server MUST NOT check the field's elements.

**Reason:** the grammar requires `items_type` to be a string and no more, so a type registered or stored with another name keeps loading and keeps taking writes.

**Tests:** `compliance/field-types.test.ts › leaves the elements of an array unchecked where items_type names no field type`.

### `types/range-value-refused`

If a write of an item's properties, by a create, an update, an upsert or an entry of a bulk write, leaves a `number` or `integer` field, or a member of an entry of a list, holding a value below its `minimum` or above its `maximum`, then the server MUST answer `400 invalid_properties` with `details.errors` naming the field in `field`, and for a member the field, the entry's position and the member, as `ratings.1.score`.

**Reason:** a bound includes the number it names, so a value equal to it is taken. The check holds at every door and on the properties the item would stand with after the write, as `types/array-items-refused` does, so a value stored before a type gained its range also refuses a write that leaves it in place. A device refuses the same writes (`device/range-checked`).

**Tests:** `compliance/field-rules.test.ts › takes a value at each bound and refuses one past it`, `› checks the range on an update and a bulk entry, and on a value stored before the type had one`.

### `types/currency-value`

When a write names a value for a `string` field whose `format` is `currency`, the server MUST take it only where it is three characters, each a capital letter from A to Z, whether or not ISO 4217 assigns the code.

**Reason:** the list of codes changes as currencies are introduced and withdrawn, so a fixed list would refuse a valid code or go stale. Of the string formats, only `currency` has its value checked; `bcp47`, `iso3166` and `phone` label a field and check nothing (`types/phone-value`). A device judges the same value (`device/currency-checked`).

**Tests:** `compliance/field-rules.test.ts › takes the currency %s`, `› refuses the currency %j, naming the field`.

### `types/phone-value`

When a write names a string value for a `string` field or member whose `format` is `phone`, the server MUST NOT refuse it for its form.

**Reason:** phone numbers are written in many forms, with extensions, letters and national prefixes, and a vendor sends the form it holds, so a check would refuse real numbers from a connector. The format tells an app it can offer to call or message the number.

**Tests:** `compliance/types.test.ts › keeps phone as a format of a string that takes any text, and refuses it on any other type`.

### `types/currency-value-refused`

If a write leaves a `string` field whose `format` is `currency` holding a value that `types/currency-value` does not take, then the server MUST answer `400 invalid_properties` naming the field.

**Tests:** `compliance/field-rules.test.ts › takes the currency %s`, `› refuses the currency %j, naming the field`.

### `types/array-entries`

When an item names an `array` field whose `items_fields` names members, the server MUST take each entry that is an object with at least one member, only members the field declares, every member it requires, and for each member a value that a field of the member's definition takes.

**Reason:** a list of contacts or attendees promises its readers a shape for every entry. A member with no value is left out, and a `null` is no value a member takes. An entry that is not an object is refused as `types/array-items-refused` refuses it.

**Tests:** `compliance/field-rules.test.ts › takes entries that match their members`.

### `types/array-entries-refused`

If a write of an item's properties, by a create, an update, an upsert or an entry of a bulk write, leaves an `array` field holding an entry with a member its `items_fields` does not declare, without a member it requires, with a member value its definition refuses, or with no member at all, then the server MUST answer `400 invalid_properties` with `details.errors` naming the field, the entry's position and, except for an entry with no member, the member in `field`, as `emails.1.value`.

**Reason:** this holds at every door and on the properties the item would stand with after the write, as `types/array-items-refused` does, so an entry stored before the field declared its members refuses a write that leaves it in place. A device refuses the same writes (`device/entries-checked`).

**Tests:** `compliance/field-rules.test.ts › refuses %s, naming the field, the position and the member`, `› checks the entries on an update and a bulk entry, naming the member, and on entries stored before the field declared its members`.

### `types/object-stored`

When the server takes an `object` field, or an element of an `array` field of `object` with no `items_fields`, the server MUST store each key of the object as given, a key named `__proto__` among them.

**Reason:** a JSON text makes `__proto__` an ordinary key, and an update that names another property must keep what the item holds.

**Tests:** `compliance/field-rules.test.ts › an object is stored key for key as given`.

### `types/searchable-false`

When a field declares `searchable: false`, the server MUST leave its value out of full-text matches and answer it on the item.

**Tests:** `compliance/fts-searchable.test.ts › field with searchable:false is excluded from full-text matches`, `› content remains retrievable on the item even when not searchable`.

## Status fields

A status field is a field of the `status` kind, whatever its name: `core.task` calls it `status`, and `core.media` calls it `progress`. It holds one word from a list the type declares in `status_values`, and each word belongs to one of four fixed groups, so an app can tell what is open, active or finished on any type without knowing its words.

### `types/status-groups`

When a type declares a status field whose `status_values` holds one or more entries, each an object of exactly a `value` matching `^[a-z][a-z0-9_]{0,63}$` that no other entry holds and a `group` of `not_started`, `in_progress`, `completed` or `canceled`, the server MUST take it and answer the entries, in order, on `GET /types/{id}`.

**Reason:** the groups are fixed so that a filter, a view or an app reads the same four meanings on every type; a word is a type's own name for where its item stands.

**Tests:** `compliance/status-groups.test.ts › takes words in the four groups and answers each with its group`, `› declares its status words in the four groups`.

### `types/status-refused`

If a type declares a status field it does not inherit with no `status_values`, any status field with an empty `status_values`, an entry other than an object of exactly `value` and `group`, a word outside `^[a-z][a-z0-9_]{0,63}$` or held twice, a group outside the four, or `enum_values`, or declares `status_values` on a field of another type, or an `array` whose `items_type` is `status`, then the server MUST answer `400 invalid_schema` naming the member.

**Reason:** a subtype may declare the field it inherits without `status_values`, because its chain gives the words (`types/child-adds`).

**Tests:** `compliance/status-groups.test.ts › refuses %s with invalid_schema, naming the member`.

### `types/status-one`

If a type declares two status fields, then the server MUST answer `400 invalid_schema` naming the second.

**Reason:** a type has one place where its items stand, so "the item's status" and a `status_group` term each read one field.

**Tests:** `compliance/status-groups.test.ts › refuses a second status field in one type`.

### `types/status-one-chain`

If a type would declare a status field under a name other than the one a type in its chain gives its status field, then the server MUST answer `400 inheritance_violation` naming the field, whether the type is the subtype or the parent being registered or replaced.

**Tests:** `compliance/status-groups.test.ts › refuses a second status field under another name`, `› refuses a parent gaining a status field beside a subtype's own under another name`.

### `types/status-inherit`

When a subtype declares the status field it inherits, the server MUST take the words it adds and answer the field on `GET /types/{id}` with every word its chain declares, the root's first and its own last, each with its group.

**Reason:** a subtype can refine where its items stand, such as adding `blocked` under `in_progress`, and still hold every word its parent's items can hold. A subtype may also declare the field without `status_values`, to require it or describe it (`types/child-adds`).

**Tests:** `compliance/status-groups.test.ts › answers a subtype's words after the inherited ones, each with its group`.

### `types/status-word-redeclared`

If a type would declare a word that a type in its chain already gives the same status field, in any group, then the server MUST answer `400 inheritance_violation` naming `fields.<name>.status_values`, whether the type is the subtype or the parent being replaced.

**Reason:** a word means one group down a chain, so a filter by group answers the same item the same way on the type and on each of its parents.

**Tests:** `compliance/status-groups.test.ts › refuses an inherited word declared again, in any group`, `› refuses a parent change that adds a word a subtype already declares`.

### `types/status-parent-wordless`

If a change to a type would leave no word in the chain of a type below it that declares a status field without `status_values`, by removing the field or by giving it another kind, then the server MUST answer `400 inheritance_violation` naming the field.

**Reason:** the subtype's declaration was taken because its chain gave the words (`types/child-adds`), and a status field with no words takes no value.

**Tests:** `compliance/status-groups.test.ts › refuses a parent change that leaves a subtype's status field without words`.

### `types/list-declared-status`

When `GET /types` lists a type, the server MUST answer its status field with the words the type itself declares, and none it only inherits.

**Reason:** `GET /types/{id}` answers every word the type's items can hold (`types/status-inherit`); the listing shows what each registration says.

**Tests:** `compliance/status-groups.test.ts › lists each type with the words it declares itself`.

### `types/status-write-refused`

If a create, an update, an upsert or an entry of a bulk write would leave an item, or a conflicted copy it makes, holding a value in its status field that is not a word the item's type gives the field, its own or inherited, and the write is a create that names the value, changes the stored value, or moves the item to another type, then the server MUST answer `400 invalid_properties` with `details.errors` naming the field.

**Tests:** `compliance/status-groups.test.ts › refuses a word the type does not declare, naming the field`, `› takes a subtype's word on its own items and refuses it on the parent's`, `› refuses an undeclared word in a bulk entry, an upsert by natural key and a bulk upsert`, `› refuses a move into a type that does not declare the item's word, and keeps the item`, `› refuses a stale write whose conflicted copy would hold an undeclared word, writing nothing`, `› makes the copy when the stale write leaves an undeclared stored word alone`.

### `types/status-word-held`

If an item holds a value in its status field that its type no longer declares, then the server MUST NOT refuse an update of the item for that value unless the update changes the field's value or moves the item to another type.

**Reason:** a type can stop declaring a word while its items still hold it, and an edit to an item's title is not the write that has to move it to a word the type declares. A synced file and a whole-properties write send every property back, the stored word among them, so naming the field unchanged is not a change. A conflicted copy is a new item, so a value the stale write changed is judged as a create's is (`types/status-write-refused`), and a stored value the write leaves alone is kept in the copy. The value is in no group (`search-and-filters/status-group-none`).

**Tests:** `compliance/status-groups.test.ts › leaves a stored word the type no longer declares until a write changes it`, `› refuses a move into a type that does not declare the item's word, and keeps the item`, `› makes the copy when the stale write leaves an undeclared stored word alone`.

### `types/shipped-progress`

The server MUST ship `core.media` declaring an optional field named `progress` of the `status` kind, with the words `planned` in the `not_started` group, `started` in `in_progress`, `finished` in `completed` and `abandoned` in `canceled`, which every subtype of `core.media` inherits.

**Reason:** `progress` is where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up. It is not named `status`, because `core.media.series` declares `status` as an `enum` for whether the series is still producing episodes, and a subtype cannot give an inherited field another kind (`types/child-shape`). A series holds both, and `status_group` reads `progress` on every media type (`types/status-one`).

**Tests:** `compliance/media-progress.test.ts › is an optional status field on %s`, `› sits beside a series' own status enum`, `› takes a book started and puts it in the in_progress group`, `› refuses a word the type does not declare, naming progress`, `› finds a finished film by its group, and leaves a planned one out`.

### `types/shipped-attendees`

The server MUST ship `core.event` declaring an optional field named `attendees`, an `array` of `object` whose `items_fields` are `name`, a `string`, `email`, an `email`, and `response`, an `enum` of `needs_action`, `accepted`, `declined` and `tentative`, none of them required, which every subtype of `core.event` inherits.

**Reason:** an app shows who is invited and who has replied from the event alone. An entry names a person by the one thing every calendar gives, the email, and holds no item ID, so an invitee needs no item of their own; an app finds the person behind an entry by matching its email to the email addresses a `core.entity` holds. The four replies are the participation statuses of RFC 5545 an invitation moves through, `needs_action` before a reply. An entry holding only an email or only a name is taken, and the entry rules (`types/array-entries-refused`) refuse the rest, naming the field, the position and the member, as `attendees.0.response`. A device refuses the same writes (`device/entries-checked`).

**Tests:** `compliance/attendees.test.ts › lists attendees on core.event and assignees on core.task`, `› takes an event with two attendees, one only an email and one only a name, in the order written`, `› refuses a response outside the four, naming attendees.0.response: %j`, `› refuses an attendee whose email is not an email address, or who holds another member`, `› lets a type under core.event hold attendees and refuse a bad one`, `device/attendees-live.test.ts › refuses on the device the attendee the server refuses`.

### `types/shipped-assignees`

The server MUST ship `core.task` declaring an optional field named `assignees`, an `array` of `object` whose `items_fields` are `name`, a `string`, and `email`, an `email`, neither of them required, which every subtype of `core.task` inherits.

**Reason:** an entry has the members and the meaning of an attendee's (`types/shipped-attendees`) without `response`, because a task has no reply to give, so an app that reads one list reads the other. A source with no email writes the person's login as `name`. An entry with a `response` is refused as an undeclared member.

**Tests:** `compliance/attendees.test.ts › lists attendees on core.event and assignees on core.task`, `› takes a task with an assignee and refuses a response on it`.

### `types/shipped-rating`

The server MUST ship `core.media` declaring an optional field named `rating` of the `integer` kind with a `minimum` of 1 and a `maximum` of 5, which every subtype of `core.media` inherits.

**Reason:** `rating` is the owner's overall view of the work, from 1 (lowest) to 5 (highest). One whole-number scale on the parent means an app reads a rating the same way on a film as on a book, with no half steps to guess at. A rating outside the range, or one that is not a whole number, is refused by the field's range (`types/range-value-refused`).

**Tests:** `compliance/media-rating-game.test.ts › is an optional integer from 1 to 5 on core.media and every type under it`, `› takes a book rated %s and reads it back`, `› refuses a rating of %s, naming rating`.

### `types/shipped-game`

The server MUST ship `core.media.game`, a child of `core.media`, declaring the optional fields `platforms`, an `array` of `string`, and `min_players` and `max_players`, each an `integer` with a `minimum` of 1.

**Reason:** a video game and a board game are both played on something and by some number of people, so one type covers both without two near-identical types. The type does not require `max_players` to be at least `min_players`, and it declares no other game property.

**Tests:** `compliance/media-rating-game.test.ts › lists core.media.game beneath core.media`, `› declares its own fields and inherits progress and rating`, `› takes a game on two platforms for one to four players`, `› takes a game with a title alone`, `› is found by a listing of core.media`, `› refuses %s of %s, naming the field`, `› refuses a platform that is not text, naming the field and the position`.

## Thumbnails

A `thumbnail` field holds a small image the writer supplies; what a value may be is `items/thumbnail-format`.

### `types/shipped-thumbnail`

The server MUST ship `core.file.image` and `core.media` each declaring an optional field named `thumbnail` of the `thumbnail` kind, which every subtype of either inherits.

**Reason:** an app lists images and works from what a device already holds, without fetching a file or a cover for each.

**Tests:** `compliance/thumbnails.test.ts › shows the optional thumbnail field on a read of each type, and of a subtype`, `› takes an item without a thumbnail, and one with a valid thumbnail on a create and an update`, `› leaves a subtype of either type to add no second thumbnail`.

### `types/thumbnail-one`

If a type would carry two thumbnail fields, counting one it inherits and one a type inheriting from it declares under another name, then the server MUST answer `400 invalid_schema`.

**Tests:** `compliance/thumbnails.test.ts › refuses a thumbnail named for a field search indexes, and a second thumbnail`, `› refuses a parent gaining a thumbnail beside one its child already declares`, `› refuses a parent gaining a thumbnail under a name its child declares as text, and takes one its child declares as a thumbnail`.

### `types/thumbnail-name`

If a type declares a thumbnail named `title`, `body`, `description` or `name`, or as an array's `items_type`, then the server MUST answer `400 invalid_schema`.

**Reason:** search indexes those four names whatever their type.

**Tests:** `compliance/thumbnails.test.ts › refuses a thumbnail named for a field search indexes, and a second thumbnail`.

### `types/thumbnail-hint`

If a type's `display_hints.title_field` or `display_hints.body_field` names a thumbnail, then the server MUST answer `400 invalid_schema`.

**Tests:** `compliance/thumbnails.test.ts › refuses a title or a body naming the thumbnail, and an edge property that is one`.

### `types/link-field`

When a type names a `link_field` that is a `string` field it declares or inherits, the server MUST store it and answer it on `GET /types/{id}` of that type and of no subtype.

**Reason:** the link is the type's own: a subtype inherits the field and not the link, and may name a link of its own.

**Tests:** `compliance/links.test.ts › declares a link and answers it on the type, not on a subtype`.

### `types/link-field-refused`

If a type's `link_field` is not a string, names no field the type declares or inherits, names one whose type is not `string`, or names one whose name holds `"` or `\`, then the server MUST answer `400 invalid_schema` naming `link_field`.

**Tests:** `compliance/links.test.ts › refuses a link that is not a string field the type declares or inherits`, `› refuses a link whose field's name holds a quote or a backslash`, `› refuses a link that is not a string field on a replacement too`.

### `types/link-subtype-guard`

If a replacement would leave a type inheriting from the replaced type linking by a field it no longer declares or inherits, or one no longer a `string`, then the server MUST answer `400 invalid_schema` naming the field.

**Tests:** `compliance/links.test.ts › refuses a parent change that leaves a subtype's link naming no string field`.

### `types/link-gained`

If a write naming or changing a type's `link_field` finds two of the type's items, in any state, holding one value in it, then the server MUST answer `409 link_taken` with `details` naming the type and the field and no item.

**Tests:** `compliance/links.test.ts › holds the rows a type already has to a link it gains`, `› holds the rows to a changed link at once`, `› refuses to register a link the rows a forced delete left share`.

### `types/link-withdrawn`

When a replacement withdraws a type's `link_field`, the server MUST stop holding the type's items to it.

**Tests:** `compliance/links.test.ts › frees the rows and forgets the tombstones when a type withdraws its link`.

## Replacing a type

### `types/replace`

When a key holding `schema.write` or `metadata.types:write` sends `PUT /types/{id}` for a type registered at run time, with a schema no other rule of this chapter refuses, the server MUST replace the type and answer `200` with it.

**Tests:** `compliance/type-registry.test.ts › updates type schema: adding a field succeeds`.

### `types/version`

The server MUST keep the `version` that `POST /types` or `PUT /types/{id}` names, and 0 where it names none, whatever else the write changes.

**Tests:** `compliance/type-versioning.test.ts › registers a type that names no version at 0`, `› replaces a type at the version it already holds, whatever the change`, `› keeps the version a replacement names, and 0 where it names none`.

### `types/replace-refused`

If `PUT /types/{id}` names a malformed identifier, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/type-versioning.test.ts › refuses a malformed identifier and a schema the validator refuses with 400`.

### `types/replace-schema-refused`

If a key whose type map grants write on a type registered at run time sends `PUT /types/{id}` for it naming a schema registration would refuse, then the server MUST answer the code registration answers for it.

**Tests:** `compliance/types.test.ts › refuses a replacement whose property name shadows a first-class Item field, as registration does`, `› refuses a replacement that breaks its compatible_with claim, as registration does`, `compliance/type-versioning.test.ts › refuses a malformed identifier and a schema the validator refuses with 400`.

### `types/replace-permission`

If a key holding neither `schema.write` nor `metadata.types:write` sends `PUT /types/{id}`, then the server MUST answer `403 forbidden` with `details.required_scope` `schema.write`.

**Tests:** `compliance/type-registry.test.ts › refuses both schema.write doors to a key without it, and declares the refusal`, `compliance/type-evolution.test.ts › holds a key with metadata.types:write alone to the type map, and a key with neither permission out`.

### `types/shipped-immutable`

If `PUT /types/{id}` or `DELETE /types/{id}` names a platform type, shipped or retired, then the server MUST answer `403 core_type_immutable`, before it asks about items, subtypes or the key's type map.

**Tests:** `compliance/type-registry.test.ts › refuses both schema.write doors a platform-shipped type, and declares that refusal too`, `› refuses a platform type before it asks about subtypes, items or the key's type map`, `compliance/retired-platform-types.test.ts › refuses a replacement and a delete of a retired platform type through the type registry`.

### `types/replace-reach`

If a key whose type map does not grant write on a type registered at run time sends `PUT /types/{id}` or `DELETE /types/{id}` for it, then the server MUST answer `403 type_not_permitted` naming the type.

**Tests:** `compliance/type-registry.test.ts › replaces and deletes only the types the key's own type map grants write on`.

### `types/field-gained`

When a replacement adds a field, required or not, the server MUST leave every stored item of the type as it is, at its version.

**Reason:** the items meet the field at their next write of properties, under `items/property-invalid`.

**Tests:** `compliance/type-registry.test.ts › keeps the rows a type already has as they are when it gains a field`.

### `types/field-removed`

When a replacement removes a field, the server MUST keep the value each item holds under its name and answer it on every read of the item.

**Tests:** `compliance/type-evolution.test.ts › leaves a removed field's values readable and the row writable`.

### `types/field-removed-writable`

When a replacement removes a field, the server MUST NOT refuse a later write of an item of the type for the value it holds under that name.

**Tests:** `compliance/type-evolution.test.ts › leaves a removed field's values readable and the row writable`.

### `types/subtype-members`

If a replacement would leave a type inheriting from it with a `display_hints` or `merge_policy` entry naming a field neither it nor an ancestor declares, then the server MUST answer `400 invalid_schema` naming the subtype and the member.

**Tests:** `compliance/type-evolution.test.ts › refuses removing a field a subtype's display hints or merge policy name, naming both`.

## Evolving a type without schema.write

A connector's key holds `metadata.types:write` and not `schema.write`, so that a leaked key cannot remove its types.

### `types/evolve-free`

When a key holding `metadata.types:write`, without `schema.write`, sends `PUT /types/{id}` for a type registered at run time its map grants write on, the server MUST take a replacement that only adds optional fields no stored item holds a value under, or changes the `label`, `plural`, `description`, `display_hints`, `version`, or a kept field's `description` or the `label` of the field or of a member of its entries, including when its retained parent or compatibility targets are outside the key's write permissions.

**Reason:** each release of a connector adds fields, and these change no stored item and only how the type is presented.

**Tests:** `compliance/type-evolution.test.ts › adds an optional field and changes the label, description and display hints, with metadata.types:write alone`, `› admits a change to the version and to a kept field's description on metadata.types:write alone`, `› admits a change to the plural and to a kept field's labels on metadata.types:write alone`, `compliance/type-dependency-permissions.test.ts › permits connector label and optional-field updates retaining %s without target write permission`.

### `types/evolve-held-name`

If a key holding `metadata.types:write` and not `schema.write` sends `PUT /types/{id}` for a type registered at run time its map grants write on, adding a field under a name an item of the type or of a type under it holds a value under, in any state, then the server MUST answer `403 forbidden`.

**Reason:** a removal leaves the values items hold, so adding a field under a held name would give those values a shape.

**Tests:** `compliance/type-evolution.test.ts › refuses a field whose name a stored row holds, in any lifecycle state, and lands it for a key with schema.write`, `› refuses a field whose name only a row of a subtype holds`, `› refuses bringing a removed field back, which would reshape the values rows still hold`.

### `types/evolve-schema-change`

If a key holding `metadata.types:write` and not `schema.write` sends `PUT /types/{id}` for a type registered at run time its map grants write on, changing anything `types/evolve-free` does not name, then the server MUST answer `403 forbidden`.

**Reason:** a removed field, a required one, a changed field shape, `parent`, `roles`, `link_field`, `version_policy`, `merge_policy`, `retention_policy` or `compatible_with` each acts beyond the type. Holding back whatever is not named free keeps a member added to the definition later from being opened to every connector's key.

**Tests:** `compliance/type-evolution.test.ts › refuses %s to a key without schema.write, naming it, and lands it for a key with schema.write`, `› refuses a change to compatible_with, a kept field's constraint, required or searchable to a key without schema.write, and lands it with it`, `› refuses a key on metadata.types:write alone a change of parent as a schema change`.

### `types/evolve-refusal-details`

When the server refuses a replacement under `types/evolve-held-name` or `types/evolve-schema-change`, the server MUST answer `details.required_scope` `schema.write` and `details.changes` listing, in sorted order, each member that needs it, a field as `fields.<name>`.

**Reason:** the client reads what to ask for, and which part of its replacement to split off.

**Tests:** `compliance/type-evolution.test.ts › refuses %s to a key without schema.write, naming it, and lands it for a key with schema.write`, `› lists every change that needs schema.write, sorted`.

### `types/evolve-schema-write`

When a key holding `schema.write` sends `PUT /types/{id}` for a type its map grants write on, the server MUST NOT refuse it under `types/evolve-held-name` or `types/evolve-schema-change`.

**Tests:** `compliance/type-evolution.test.ts › refuses %s to a key without schema.write, naming it, and lands it for a key with schema.write`, `› refuses a field whose name a stored row holds, in any lifecycle state, and lands it for a key with schema.write`.

## Dependency permissions

### `types/parent-reach`

If `POST /types`, or an otherwise permitted `PUT /types/{id}` that changes the stored `parent`, names a non-platform parent the key's type map does not grant write on, then the server MUST answer `403 type_not_permitted` with `details.grant` naming that parent, whether or not the parent is registered.

**Reason:** adding a parent can prevent replacement or deletion of that parent, so establishing the relationship requires write permission on it.

**Tests:** `compliance/type-evolution.test.ts › refuses a registration naming a parent the key may not write, and takes it once the map reaches the parent`, `› holds a replacement that changes the parent to the key's reach, and leaves one that keeps its parent`, `› asks write on a parent nothing registered, before saying it is unknown`, `› asks write on a core parent the server does not ship`, `compliance/type-dependency-permissions.test.ts › requires target write permission for new dependencies but permits retained dependencies`.

### `types/compatible-with-reach`

If an otherwise valid `POST /types` or an otherwise permitted `PUT /types/{id}` names a non-platform `compatible_with` target absent from the type's stored `compatible_with` and the key's type map does not grant write on that target, then the server MUST answer `403 type_not_permitted` with `details.grant` naming that target.

**Reason:** a new compatibility claim can prevent replacement or deletion of its target, so establishing the claim requires write permission on it.

**Tests:** `compliance/type-dependency-permissions.test.ts › requires target write permission for new dependencies but permits retained dependencies`, `› permits connector label and optional-field updates retaining %s without target write permission`.

### `types/parent-kept`

When a replacement retains its stored `parent` or a target in its stored `compatible_with`, the server MUST NOT require target write permission for retaining that relationship.

**Reason:** existing relationships remain valid after a target grant is narrowed, so connectors can continue updating their own types.

**Tests:** `compliance/type-evolution.test.ts › holds a replacement that changes the parent to the key's reach, and leaves one that keeps its parent`, `compliance/type-dependency-permissions.test.ts › requires target write permission for new dependencies but permits retained dependencies`, `› permits connector label and optional-field updates retaining %s without target write permission`.

### `types/parent-shipped`

The server MUST NOT ask write on a parent that is a platform type, shipped or retired.

**Reason:** no credential can delete a platform type through `/types`, and connectors subtype them.

**Tests:** `compliance/type-evolution.test.ts › exempts platform-shipped parents`.

## Moving a type's items

A type's identifier never changes. Renaming a type is registering the new one and moving its items to it with `POST /types/{id}/move`, then deleting the old one.

### `types/move`

When a key whose type map grants write on both types sends `POST /types/{id}/move` naming a registered `to`, the server MUST queue a bulk-action job that gives every item of exactly that type that the key's source filter shows, in any state, the type `to`, and leaves each item in its state.

**Reason:** an item in the trash or the archive still names the type it was written against, and a move that left it behind would keep the old type in use. An item the source filter hides is one the key may not reach.

**Tests:** `compliance/type-move.test.ts › moves every item of the type in any state, keeping a binned one in the bin`, `› moves only the items the key's source filter shows, and says others remain without counting them`.

### `types/move-subtypes`

When `POST /types/{id}/move` names a type that other types name as their `parent`, the server MUST leave the items of those subtypes in their own types, and keep the type beside `to` in a folder's or view's `query.types`.

**Reason:** a subtype is its parent, and a query naming the parent still reaches the subtypes' items through it.

**Tests:** `compliance/type-move.test.ts › moves the items of a parent type, leaving its subtypes' items and keeping the folder holding them`.

### `types/move-properties`

When `POST /types/{id}/move` names `properties`, the server MUST merge them into each item as it moves, as `PATCH /items/{id}` merges them.

**Tests:** `compliance/type-move.test.ts › moves what the new type accepts, rewrites no setting, and a second run finishes`.

### `types/move-dry-run`

When `POST /types/{id}/move` names `dry_run: true`, the server MUST answer `200` with the IDs of the items it would move, the folder, view and webhook settings that name the type, and the keys and apps whose type map names it, and write nothing.

**Tests:** `compliance/type-move.test.ts › writes nothing on a dry run, and the same move run for real writes`, `› lists the keys whose type map names the type, leaves them as they are, and a delete goes past them`.

### `types/move-target`

If `POST /types/{id}/move` names a `to` that is malformed or that names the type itself, then the server MUST answer `400 validation_error`, and if it names a type nothing registered, `400 unknown_type`.

**Tests:** `compliance/type-move.test.ts › refuses a move to a type that isn't there, to a malformed one and to the type itself`.

### `types/move-source`

If `POST /types/{id}/move` names a type nothing registered, then the server MUST answer `404 type_not_found`, and if it names a platform type, shipped or retired, `403 core_type_immutable`.

**Tests:** `compliance/type-move.test.ts › refuses a move to a type that isn't there, to a malformed one and to the type itself`.

### `types/move-permission`

If the key sending `POST /types/{id}/move` lacks write on the type or on `to` in its type map, then the server MUST answer `403 type_not_permitted` and move nothing.

**Tests:** `compliance/type-move.test.ts › refuses a key without write on both types`.

### `types/move-settings`

When no item of the type remains once a type move's job has run, the server MUST, in one transaction, rewrite to name `to` instead: a folder's `query.types`, `defaults.type` and `first_placement` key, a view's `query.types`, each `type eq` and `type neq` term naming the type in a folder's or view's `query.filter`, and a webhook's `type_filter` that is exactly the type.

**Reason:** a folder, view or webhook naming a type no item holds anymore would hold nothing, and the person who made it meant the items, not the identifier.

**Tests:** `compliance/type-move.test.ts › rewrites the folders, views and webhooks that name the type once every item has moved`, `› writes nothing on a dry run, and the same move run for real writes`.

### `types/move-webhook-pattern`

The server MUST NOT change a webhook whose `type_filter` is a pattern, such as `acme.*`, when it moves a type's items.

**Tests:** `compliance/type-move.test.ts › rewrites the folders, views and webhooks that name the type once every item has moved`.

### `types/move-errors`

If a type move's job leaves an item it selected unmoved, then the server MUST count it in the job's `result.errored` and report it in `result.errors` among the first 100 such items.

**Tests:** `compliance/type-move.test.ts › moves what the new type accepts, rewrites no setting, and a second run finishes`, `› lists the first 100 items a move left and counts every one`.

### `types/move-remaining`

When a type move's job finishes, the server MUST set `result.remaining` to how many items of the type, in any state, the key's source filter shows, and `result.remaining_hidden` to whether an item of the type that the filter hides remains.

**Reason:** an item the job refused, one written while it ran and one the key can't see all keep the settings from being rewritten, and the caller must learn which without being told what it may not see.

**Tests:** `compliance/type-move.test.ts › moves what the new type accepts, rewrites no setting, and a second run finishes`, `› moves only the items the key's source filter shows, and says others remain without counting them`, `compliance/bulk-job-holds.test.ts › counts an item of the old type written while it runs as remaining, and rewrites no setting`.

### `types/move-partial`

If an item of the type remains once a type move's job has run, then the server MUST set `result.settings_rewritten` to `false` and rewrite no setting.

**Reason:** settings rewritten while items of the old type remain would stop showing those items.

**Tests:** `compliance/type-move.test.ts › moves what the new type accepts, rewrites no setting, and a second run finishes`, `› moves only the items the key's source filter shows, and says others remain without counting them`, `compliance/bulk-job-holds.test.ts › counts an item of the old type written while it runs as remaining, and rewrites no setting`.

### `types/move-rerun`

When a later `POST /types/{id}/move` names the same type, the server MUST move the items an earlier move left and then rewrite the settings as `types/move-settings` says.

**Tests:** `compliance/type-move.test.ts › moves what the new type accepts, rewrites no setting, and a second run finishes`.

### `types/move-blocked`

If a folder, view or webhook setting names the type in a way a move can't rewrite, then the server MUST answer `POST /types/{id}/move`, dry run or not, `409 type_move_blocked` with `details.settings` naming each, with `reason` `filter_term` for a `query.filter` term on `type` whose answer would change and that isn't a `type eq` or `type neq` naming the type, or a `query.filter` that rewriting would make longer than a filter may be, `placement_conflict` for a `first_placement` that places the two types in different directories, or `subtypes` for a webhook's `type_filter` naming a type with subtypes, and move nothing.

**Tests:** `compliance/type-move.test.ts › refuses a move a setting would stop, naming each setting and moving nothing`, `› moves the items of a parent type, leaving its subtypes' items and keeping the folder holding them`, `› refuses a move that would make a filter longer than a filter may be`.

### `types/move-settings-authority`

If the key sending `POST /types/{id}/move` couldn't change a folder, view or webhook naming the type through that setting's own operation, then the server MUST answer `409 type_move_blocked` with that setting's `reason` `not_permitted`, and move nothing.

**Reason:** a move must not reach a setting its caller couldn't change directly: a folder or view takes write on `system.folder` or `system.view`, and a webhook takes `webhooks.manage` and the key or app that made it.

**Tests:** `compliance/type-move.test.ts › refuses a move naming a setting the key may not change, before moving anything`.

### `types/move-settings-ids`

When the server names a folder, view or webhook setting in a type move's answer, its job's `result.settings` or a `type_in_use` refusal, the server MUST give the setting's `id` only to a credential that may read it, and name any other setting by its `kind` and `field` alone, with `reason` `not_permitted` on a move: a folder to one whose type map grants read on `system.folder`, a view to one that grants read on `system.view`, and a webhook to the key or app that made it, holding `webhooks.manage`.

**Reason:** a setting's own operations hide it from a credential that may not read it, and a move or a delete must not tell that credential more.

**Tests:** `compliance/type-move.test.ts › names a setting the key may not read without its ID, on a move and a delete`.

### `types/move-cascade-mark`

When a type move gives an item in the bin the type `to`, the server MUST decide who may be told that item's ID in the cascade marks naming it, as `items/cascade-mark-names` says, by `to`.

**Reason:** the marks follow the item they name, and a key that may read only `to` may read the item.

**Tests:** `compliance/type-move.test.ts › names the new type for the rows a moved root took into the bin`.

### `types/move-grants`

The server MUST NOT change a key's or app's type map when it moves a type's items.

**Reason:** a type map is what the owner granted, and only the owner widens or narrows it.

**Tests:** `compliance/type-move.test.ts › lists the keys whose type map names the type, leaves them as they are, and a delete goes past them`.

## Deleting a type

### `types/delete`

When a key holding `schema.write` whose type map grants write on it sends `DELETE /types/{id}` for a type registered at run time that no item holds and no other type names as parent or compatibility target, the server MUST remove it.

**Tests:** `compliance/type-registry.test.ts › deletes a type with no items`.

### `types/delete-in-use`

If a key holding `schema.write` whose type map grants write on it sends `DELETE /types/{id}` without `force=true` for a type registered at run time that an item holds, in any state, or that a folder, view or webhook setting names as `types/move-settings` lists them, then the server MUST answer `409 type_in_use` with `details.item_count` and `details.settings`.

**Reason:** a delete never rewrites a setting. A setting naming a type that is gone holds nothing, so the caller moves the items, which rewrites the settings, or changes the settings first.

**Tests:** `compliance/type-registry.test.ts › rejects deleting a type that has items`, `› refuses to delete a type that has only an item in the bin`, `compliance/type-move.test.ts › refuses a delete while a folder, view or webhook names the type, and deletes it once none does`.

### `types/delete-grants`

The server MUST NOT refuse `DELETE /types/{id}` because a key's or app's type map names the type.

**Tests:** `compliance/type-move.test.ts › lists the keys whose type map names the type, leaves them as they are, and a delete goes past them`.

### `types/delete-subtypes`

If a key holding `schema.write` whose type map grants write on it sends `DELETE /types/{id}` for a type registered at run time that another type names as parent, then the server MUST answer `409 type_has_subtypes` with `details.subtype_ids`, with `force=true` or without, before any answer about its items.

**Tests:** `compliance/type-registry.test.ts › refuses deleting a parent while a subtype still declares it`, `› refuses force against a parent, ahead of the items it holds`.

### `types/delete-force`

When a key holding `schema.write` whose type map grants write on it sends `DELETE /types/{id}?force=true` for a type registered at run time that items hold or settings name but no other type names as parent or compatibility target, the server MUST remove the type and keep the items and the settings as they are.

**Tests:** `compliance/type-registry.test.ts › force-deletes a type that has items`, `› refuses a write to a row a forced delete left, until its type is registered again`, `compliance/type-move.test.ts › force-deletes a type a folder names, and leaves the folder as it is`.

### `types/delete-force-value`

If `DELETE /types/{id}` names a `force` that is neither `true` nor `false`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/type-registry.test.ts › refuses a force that is not true or false`.

### `types/delete-permission`

If a key without `schema.write` sends `DELETE /types/{id}`, then the server MUST answer `403 forbidden` with `details.required_scope` `schema.write`.

**Tests:** `compliance/type-evolution.test.ts › refuses the delete to a key without schema.write, force included`, `compliance/type-registry.test.ts › refuses both schema.write doors to a key without it, and declares the refusal`.

### `types/orphan-write`

While a type is unregistered, if a write would set the properties, tier, time or natural key of an item of it, on `POST /items`, `PATCH /items/{id}`, a `POST /items/bulk` entry or a bulk action, then the server MUST refuse it `unknown_type`.

**Tests:** `compliance/type-registry.test.ts › refuses a create of a type that was force-deleted under it`, `› refuses a write to a row a forced delete left, until its type is registered again`, `› refuses a bulk upsert and a bulk action onto a row a forced delete left`, `› refuses a change of tier or time to a row a forced delete left, singly and in bulk`.

### `types/orphan-kept-writable`

While a type is unregistered, the server MUST let an item of it have its tags, extensions and lifecycle state written.

**Reason:** a row nothing can describe can still be put away.

**Tests:** `compliance/type-registry.test.ts › keeps the tags, extensions and lifecycle of a row a forced delete left writable`, `compliance/restore-rows-shape.test.ts › restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`.

### `types/orphan-read`

While a type is unregistered, the server MUST return its items from `GET /items/{id}`, `GET /items`, `GET /search`, `GET /items/{id}/versions` and `GET /items/{id}/edges`.

**Reason:** a forced delete keeps the items (`types/delete-force`), and a row nothing can describe is still a row a person made. A row restored under an unregistered type is read the same way (`search-and-filters/restore-rows-orphan`).

**Tests:** `compliance/restore-rows-shape.test.ts › restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`.

### `types/orphan-reregistered`

When a type is registered again, the server MUST hold each later write to its items to the schema it is registered with.

**Tests:** `compliance/type-registry.test.ts › refuses a write to a row a forced delete left, until its type is registered again`.

### `types/delete-race`

When an item write races `DELETE /types/{id}`, the server MUST either count the item, refusing a delete without `force=true` `409 type_in_use`, or refuse the item `unknown_type`.

**Tests:** `compliance/write-order.test.ts › counts an item that lands before a waiting type deletion`, `› refuses an item whose type was deleted before its write starts`.

## Version policy

### `types/version-policy-values`

If a type's `version_policy` names a `recent_days`, `daily_snapshot_days`, `weekly_snapshot_days` or `max_versions` that is not a whole number of at least 1, then the server MUST answer `400 invalid_schema` naming it.

**Tests:** `compliance/version-policy.test.ts › refuses a number that is not a whole positive one, naming the field: %s`, `compliance/version-policy.test.ts › names the field on a replacement that breaks the version policy, and registers nothing on a create`.

### `types/version-policy-order`

If a type's `version_policy` names a window that ends sooner than an earlier one it names, in the order `recent_days`, `daily_snapshot_days`, `weekly_snapshot_days`, then the server MUST answer `400 invalid_schema` naming the window that ends too soon.

**Tests:** `compliance/version-policy.test.ts › refuses windows out of order, naming the one that ends too soon`, `› registers a policy of whole positive numbers in order`, `› refuses the same on a replacement and keeps the type as it was`, `compliance/version-policy.test.ts › names the field on a replacement that breaks the version policy, and registers nothing on a create`.

## Retention policy

A type's `retention_policy` sets how long the items it holds stay in the feed tier. Its one key, `feed_days`, is read by the `feed-expiry` job (`housekeeping/feed-expiry-window`).

### `types/retention-policy-values`

If a type's `retention_policy` names a `feed_days` that is neither `null` nor a whole number from 1 to 36500, or is itself not an object, then the server MUST answer `400 invalid_schema` naming it.

**Reason:** 36500 days, a hundred years, is the largest window an instance setting takes, and it keeps the date a job computes from it inside what a date can hold.

**Tests:** `compliance/retention-policy.test.ts › refuses a feed_days that is not a whole number of days from 1 to 36500 or null, naming the field`, `› accepts a window of 1 day, of 36500 days and null`.

### `types/retention-policy-merge`

When a type names a `retention_policy`, the server MUST store it and answer it on `GET /types/{id}` merged through the parent chain key by key, a `feed_days` the type names, `null` included, replacing its parents'.

**Reason:** a child that names `null` keeps its feed items although its parent expires them, and a type that names no `feed_days` takes its parent's.

**Tests:** `compliance/retention-policy.test.ts › reads back the window a parent declares, a child's own or null replacing it`, `› registers a policy on a child and answers it on a replacement`.

## Enforcement levers

`GET /config`, `PUT /config` and `PATCH /config` hold the instance's levers beside its retention settings.

### `types/config`

When a key holding `config.manage` sends `PUT /config`, the server MUST replace the configuration whole and answer it beside the instance's identity, as `GET /config` then reads it (`instance/config-takes-back-read`).

**Tests:** `compliance/schema-enforcement.test.ts › PUT replaces the configuration wholesale and GET reads it back`.

### `types/config-refused`

If `PUT /config` names a lever of the wrong shape, other than one missing a member it requires, or a key it does not know, then the server MUST answer `400 validation_error` and keep the configuration.

**Tests:** `compliance/schema-enforcement.test.ts › refuses a lever of the wrong shape`, `› refuses a configuration key it does not know, and keeps the configuration`.

### `types/config-lever-missing-field`

If `PUT /config` names `enforcement.strict_mode` without `types`, or `enforcement.source_allowlist` or `enforcement.source_filter` without `types` or `sources`, then the server MUST answer `400 missing_required_field` naming the missing member's path in `details.field`.

**Tests:** `compliance/instance-config.test.ts › names the field a lever lacks with missing_required_field, and keeps the configuration`.

### `types/config-permission`

If a key without `config.manage` sends `GET /config`, `PUT /config` or `PATCH /config`, then the server MUST answer `403 forbidden` with `details.required_scope` `config.manage`.

**Tests:** `compliance/schema-enforcement.test.ts › refuses all three doors to a key without config.manage`.

### `types/strict-mode`

Where the `enforcement.strict_mode` that holds for the writing key, its own override's if the override names one and else the instance's, names a type in `types`, the server MUST refuse a write of an item of exactly that type that names a property neither the type nor an ancestor declares, with `400 invalid_properties`.

**Tests:** `compliance/schema-enforcement.test.ts › strict-on rejects unknown property with invalid_properties`, `› default-off accepts unknown property on core.note write`, `› holds strict mode and the source allow-list to the type named, not its subtypes`, `› strict-on rejects the same unknown property through the bulk door, on both halves of an upsert`, `› strict-on rejects the same unknown property through the update door`, `› strict-on refuses the same unknown property per row of a bulk update_properties job`.

### `types/strict-mode-code`

When `enforcement.strict_mode` refuses a property that no type declares, the server MUST carry `details.code` of `unknown_property` beside the code `invalid_properties`.

**Tests:** `compliance/schema-enforcement.test.ts › strict-on rejects the same unknown property through the update door`, `› strict-on rejects the same unknown property arriving through the restore door`, `› strict-on refuses the same unknown property per row of a bulk update_properties job`.

### `types/strict-mode-declared`

Where `enforcement.strict_mode` names the type of a row, the server MUST take a patch that names only declared properties, whatever else the type requires.

**Reason:** the lever refuses an undeclared property and nothing else. A missing required property is the store's refusal and carries the store's reason, so a lever that read a patch as a complete set would refuse an ordinary update under a message naming the wrong cause. The lever judges the properties the caller sent and not the merge they land in, because a merge would freeze every row that already carries an undeclared property from before the lever was set.

**Tests:** `compliance/schema-enforcement.test.ts › takes a patch naming only declared properties, whatever else the type requires`.

### `types/strict-mode-off`

Where `enforcement.strict_mode` does not name the type of a row, the server MUST take a property that no type declares on `POST /items`, `POST /items/bulk` and `PATCH /items/{id}`, and serve it back.

**Tests:** `compliance/schema-enforcement.test.ts › default-off accepts unknown property on core.note write`, `› default-off accepts through the bulk and update doors as it does through the create door`.

### `types/strict-mode-job`

When a `POST /items/bulk-actions` job with `update_properties` writes a row, the server MUST ask `enforcement.strict_mode` as it stands then, for the credential that queued the job as that credential stands then.

**Reason:** every other operation asks when it writes, so a lever set while a job waits holds for it. A job whose queuing credential is gone writes nothing more (`items/job-credential-lost`).

**Tests:** `compliance/bulk-job-holds.test.ts › is asked of every row the job writes, as it stands then`, `› is asked for the credential as it stands then, so a key loosened while the job waits writes its rows`.

### `types/source-allowlist`

Where the `enforcement.source_allowlist` that holds for the writing key, its own override's if the override names one and else the instance's, names a type in `types`, if `POST /items` or a `POST /items/bulk` entry writes an item of exactly that type under a source the list does not name, then the server MUST refuse it `403 forbidden` with `details.type`, `details.source` and `details.allowed`.

**Tests:** `compliance/schema-enforcement.test.ts › rejects writes from non-listed source`, `› accepts writes from listed source`, `› asks it of every bulk entry, under the source the entry resolves to`, `› holds strict mode and the source allow-list to the type named, not its subtypes`.

### `types/source-filter`

Where the `enforcement.source_filter` that holds for the reading key, its own override's if the override names one and else the instance's, names types and sources, the server MUST leave out of every read that returns a set, a listing, search, export, stats and the tag counts among them, each item of a named type or a type under it whose source the filter does not name.

**Reason:** the event stream and webhook deliveries carry whole items too, and are held to the same filter by `events/source-filter-item` and `events/delivery-source-filter-item`.

**Tests:** `compliance/schema-enforcement.test.ts › narrows reads to listed sources`, `› narrows every read that returns a set, not just the list route`, `› narrows only the types the source filter names, and their subtypes`.

### `types/source-filter-missing-source`

The server MUST judge an item that carries no source, under a source filter, as an item whose source is `unknown`.

**Reason:** every read answers such an item's `source` as `unknown`, so a filter naming `unknown` names it.

**Tests:** `compliance/source-filter-missing-source.test.ts › is decided by the source filter as an item whose source is unknown`.

### `types/source-filter-by-id`

The server MUST NOT apply `enforcement.source_filter` to the item or edge a read by id names.

**Reason:** the filter narrows what a key's reads return, not whether a key can fetch a row it names, so what that row carries is narrowed as any read narrows it (`edges/read-source-filter`).

**Tests:** `compliance/schema-enforcement.test.ts › does not narrow a read by id`, `compliance/reach.test.ts › certifies a bulk read by id and answers listed for each item it returns, in order, false for a source-excluded one`, `compliance/edge-source-filter.test.ts › answers an edge by id whose source item the filter hides`.

## Shipped types

### `types/shipped`

The server MUST ship `core.bookmark`, `core.collection`, `core.entity`, `core.entity.person`, `core.entity.place`, `core.event`, `core.file`, `core.file.audio`, `core.file.image`, `core.file.video`, `core.file.webpage`, `core.highlight`, `core.media`, `core.media.album`, `core.media.article`, `core.media.book`, `core.media.episode`, `core.media.film`, `core.media.game`, `core.media.series`, `core.media.song`, `core.message`, `core.note` and `core.task`, each with fields and a label, and no other `core.*` type.

**Tests:** `compliance/types.test.ts › ships exactly the core types, each with fields and a label`, `compliance/type-registry.test.ts › lists registered types including core types`, `› gets a single type by type identifier`, `compliance/type-inheritance.test.ts › core entity/file/media subtypes resolve`, `compliance/type-label.test.ts › built-in types have labels`, `› get single type includes label`.

### `types/shipped-system`

The server MUST ship `system.connection`, `system.folder` and `system.view` and no other `system.*` type.

**Tests:** `compliance/system-types.test.ts › ships only the system types the server writes`, `› lists exactly the three system types the server writes`.

### `types/message`

The server MUST ship `core.message` requiring `from`, taking `to` as an optional list of identifiers in any format, and naming `body` its display body.

**Tests:** `compliance/core-message.test.ts › creates a message with body, from, and to`, `› creates with only the required from`, `› accepts participant identifiers in any format`, `› rejects a message missing from with invalid_properties naming it`, `› declares body as its display body field`, `› declares from, and not body, as required in the registry`.

### `types/collection`

The server MUST ship `core.collection` with no parent, declaring the `container` role, requiring `title` and taking `description`.

**Reason:** every other shipped container is a kind of media, so without it a person could gather notes, tasks or anything else into no collection.

**Tests:** `compliance/core-collection.test.ts › declares the container role, title required and description optional`, `› creates with only a title`, `› refuses a collection with no title, naming it`, `› holds items of any type through in-collection`.

### `types/body-optional`

The server MUST ship `core.note`, `core.media.article` and `core.message` with `body` declared and not required, so that a write to any of them without a `body` is accepted.

**Reason:** a note can be only a title, an article can be saved before its text is fetched, and a message can be only a photo or a file. A type requires only what it means nothing without.

**Tests:** `compliance/optional-body.test.ts › declares body as optional on core.note, core.media.article and core.message`, `› keeps the title of an article and the sender of a message required`, `› requires no field of a note`, `› creates with no properties at all`, `› creates with only a title, and takes a body later`, `› updates a note that has no body, leaving it without one`, `› creates through the bulk door`, `› still refuses a body of the wrong kind, naming it`, `› creates with only a title`, `› still refuses an article with no title, naming it`, `› creates with only a sender`, `› still refuses a message with no sender, naming it`.

### `types/article-doi`

The server MUST ship `core.media.article` with an optional `doi`, a `string` described as a Digital Object Identifier.

**Reason:** a DOI is how a paper or a journal article is cited, so an app that saves one can keep the identifier with it, as `core.media.book` keeps an `isbn`. The value is not checked for shape.

**Tests:** `compliance/field-rules.test.ts › lists doi as an optional string on core.media.article and keeps what an article writes`.

### `types/highlight`

The server MUST ship `core.highlight` requiring `text`, taking `note`, `color`, `start_location`, `end_location` and `locator_type`, and declaring no `highlighted_at`.

**Reason:** the moment a highlight was made is the item's own `occurred_at`.

**Tests:** `compliance/highlight.test.ts › creates with only the required text property`, `› rejects a highlight missing the required text property`, `› roundtrips all optional properties`, `› accepts an optional note alongside text`, `› accepts each locator_type variant`, `› the moment the highlight was made is the system occurred_at`, `› has no highlighted_at property on item or properties`.

### `types/entity`

The server MUST ship `core.entity` requiring `name`, with `core.entity.person` and `core.entity.place` under it adding fields of their own.

**Tests:** `compliance/entity-subtypes.test.ts › creates a generic entity with required name field`, `› rejects entity without required name with invalid_properties naming it`, `› creates a person entity with person-specific fields`, `› creates a place entity with place-specific fields`, `› person inherits all entity fields`, `› requires an entity's name on a person and a place too`.

### `types/entity-contact-lists`

The server MUST ship `core.entity` with `emails`, `phones` and `addresses` as `array` fields of `object` entries and with no `email`, `phone` or `place` field, where an `emails` entry requires an `email` member `value` and takes a `string` member `label`, a `phones` entry requires a `string` member `value` whose `format` is `phone` and takes a `string` member `label`, and an `addresses` entry takes `label`, `street_address`, `locality`, `region`, `postal_code` and `country`, each a `string`.

**Reason:** a person or an organization has more than one email address, phone number and postal address, and a `label` says which is which in the writer's own words, such as work or home. A write that names `email`, `phone` or `place` is kept as any undeclared property is (`types/strict-mode-off`).

**Tests:** `compliance/contact-lists.test.ts › declares emails, phones and addresses as lists of entries, and no email, phone or place`, `› takes a person with two emails, two phones and an address`, `› refuses %s, naming the entry and the member`, `› keeps an email the type no longer declares as an undeclared property`.

### `types/core-labels`

The server MUST ship `core.entity.person` with the plural `People`, `core.media` with `Media`, `core.media.series` with `Series` and `core.file.audio` with `Audio`, each `url` field of a shipped type with the label `URL`, `core.entity`'s `phones` with `Phone Numbers`, and `core.task`'s `due_at` with `Due`.

**Reason:** a label or plural made from a name reads badly where the name abbreviates a word, as `url` would make `Url`, or where the regular rule gets the word wrong, as `Person` would make `Persons`; Marfa names these itself so that an app need not, and names others of the kind too, such as `Image URL` and `MIME Type`.

**Tests:** `compliance/type-label.test.ts › ships labels and plurals where a core field's name or type's label reads badly`.

### `types/entity-main-entry`

When an item of `core.entity` or a type under it is written with entries in `emails`, `phones` or `addresses`, the server MUST answer the entries in the order they were written.

**Reason:** the first entry is the main one, as each field's description says, so an app shows it where only one value fits.

**Tests:** `compliance/contact-lists.test.ts › takes a person with two emails, two phones and an address`.

### `types/entity-contact-upgrade`

When the server updates a database under `instance/upgrade-in-place` from a schema version before 4, and an item of `core.entity` or a type under it holds `email`, `phone` or `place` as a string with a character other than white space and holds no `emails`, `phones` or `addresses` field for it, the server MUST replace the field with a one-entry list in `emails`, `phones` or `addresses`, holding the string as `value`, `value` or `street_address`, unless the type or an ancestor below `core.entity` declares the old or the new field itself or `types/entity-contact-upgrade-kept` applies.

**Reason:** the update keeps what an owner wrote under the fields the type no longer declares, in the shape it declares now. An item in the bin is updated too, so it comes back in that shape. A type registered through `POST /types` declares a field itself when its own fields hold it. A type Marfa ships holds the fields it inherits as well, so it declares a field itself when it holds the field and its parent does not, or holds it with another definition. Such a field means what that type says, not what `core.entity` said. A value the update cannot move stays where it was (`types/entity-contact-upgrade-kept`).

**Tests:** `compliance/contact-lists-upgrade.test.ts › moves a stored email, phone and place into one-entry lists`.

### `types/entity-contact-upgrade-empty`

When the server updates a database under `types/entity-contact-upgrade` and an item holds `email`, `phone` or `place` as an empty string, a string of only white space, or `null`, the server MUST remove the field and add no entry for it.

**Tests:** `compliance/contact-lists-upgrade.test.ts › removes an empty email and keeps a value it cannot move under its own field`.

### `types/entity-contact-upgrade-kept`

When the server updates a database under `types/entity-contact-upgrade` and an item holds `email`, `phone` or `place` as a value other than a string, as an `email` the `value` member refuses, when `emails` does not already hold an entry with that string, or beside the field it would move into, when that field does not already hold an entry with that string, the server MUST keep the value under its own field and leave the other field as it was.

**Reason:** the update never drops what it cannot move. The value stays where an owner or an agent can read it and move it by hand.

**Tests:** `compliance/contact-lists-upgrade.test.ts › removes an empty email and keeps a value it cannot move under its own field`.

### `types/entity-contact-upgrade-held`

When the server updates a database under `types/entity-contact-upgrade` and an item holds `email`, `phone` or `place` beside a list in `emails`, `phones` or `addresses` that already holds an entry whose `value` or `street_address` is that string, the server MUST remove the old field and leave the list as it was.

**Reason:** the value is already where the type declares it, and the version the item leaves keeps the old field.

**Tests:** `compliance/contact-lists-upgrade.test.ts › removes an email and a place their lists already hold, and leaves the lists as they were`.

### `types/entity-contact-upgrade-version`

When the server changes an item under `types/entity-contact-upgrade`, `types/entity-contact-upgrade-empty` or `types/entity-contact-upgrade-held`, the server MUST give it the next version, keep the version it held in its history, and record no writer for the new version.

**Reason:** a device that edits the item at its old version then meets an ordinary stale write, which the server merges against the version in the history (`versions/merge-stale`), rather than one with no ancestor (`versions/ancestor-none`).

**Tests:** `compliance/contact-lists-upgrade.test.ts › gives a changed item its next version, with the old one in its history and an item.updated event`.

### `types/entity-contact-upgrade-event`

When the server changes an item under `types/entity-contact-upgrade`, `types/entity-contact-upgrade-empty` or `types/entity-contact-upgrade-held`, the server MUST append an `item.updated` event carrying the changed item to the event stream.

**Reason:** devices and connectors catch up from the event stream, so without the event their copies would keep the old fields.

**Tests:** `compliance/contact-lists-upgrade.test.ts › gives a changed item its next version, with the old one in its history and an item.updated event`.

### `types/connection`

The server MUST ship `system.connection` with `kind` taking `app` alone, a description that names no connector, and none of `attached_device`, `feed_activity`, `last_error_at`, `last_sync_at`, `mapping_reapply_until`, `next_run_at`, `runtime_status`, `triggers`, `connector_id`, `credential_id`, `configuration`, `direction` and `mapping`, in its fields, its description or a row it serves.

**Tests:** `compliance/system-types.test.ts › declares app as the only system.connection kind`, `› ships none of the system.connection fields no door accepts`, `› serves no system.connection carrying a field the type no longer declares`.

## The platform registry

The registry rows of shipped types are the platform's. An instance upgraded past a build that shipped a type keeps its row as a retired platform type until an authorized caller removes it.

### `types/platform-drift`

When a caller with `instance.read` or direct owner or local authority sends `GET /platform-types/retired`, the server MUST list each retired platform type, a platform row the build no longer ships, with its `item_count`, `child_types` and whether it is `removable`.

**Tests:** `compliance/platform-types.test.ts › lists no retired platform types on an instance whose types match the build`, `compliance/retired-platform-types.test.ts › lists a retired platform type, and removes it once nothing holds it`.

### `types/platform-remove`

When a caller with `instance.maintain` or direct owner or local authority sends `DELETE /platform-types/{id}` for a retired platform type no item holds and no other type names as parent or compatibility target, the server MUST remove it and answer `200` with `removed: true`.

**Tests:** `compliance/retired-platform-types.test.ts › lists a retired platform type, and removes it once nothing holds it`.

### `types/platform-remove-audit`

When `DELETE /platform-types/{id}` removes a type, the server MUST record a `platform_type.removed` entry at `GET /audit` naming the type and the acting authority.

**Tests:** `compliance/retired-platform-types.test.ts › lists a retired platform type, and removes it once nothing holds it`.

### `types/platform-remove-refused`

If `DELETE /platform-types/{id}` names a type the build ships, a type registered at run time, or a retired platform type an item holds or a type names as parent or compatibility target, then the server MUST answer `409 conflict`.

**Tests:** `compliance/platform-types.test.ts › refuses to remove a type the build still ships`, `› answers 409 for a type registered at run time, which no platform row carries`, `compliance/retired-platform-types.test.ts › refuses to remove a retired type that items still carry`, `› refuses to remove a retired type another type inherits from`, `› keeps a retired compatibility target until its reader drops the claim`.

### `types/platform-remove-missing`

If `DELETE /platform-types/{id}` names an identifier no registry row carries, then the server MUST answer `404 type_not_found`.

**Tests:** `compliance/platform-types.test.ts › answers 404 for an identifier no platform row carries`.

### `types/platform-operator-only`

If a credential lacking `instance.read` sends `GET /platform-types/retired`, or one lacking `instance.maintain` sends `DELETE /platform-types/{id}`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/platform-types.test.ts › refuses removal without instance.maintain`, `› refuses the listing without instance.read and to no credential`.

## Normalizing a candidate

### `types/normalize-authenticated`

When an authenticated caller sends `POST /types/normalize`, the server MUST admit the request without requiring type or metadata write permissions.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`.

### `types/normalize-answer`

When a valid candidate is sent to `POST /types/normalize`, the server MUST return its canonical declared definition in `type`, the canonical declared registered definition in `registered_type` and the canonical registered definition resolved as on `GET /types/{id}`, with the author's icon and not the owner's (`types/icon-read`), in `resolved_type`, from one registry view.

**Reason:** a connector compares what it would register with what is registered without write authority, so both come from one view of the registry.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`, `compliance/type-icons.test.ts › normalizes on the author's side, with the author's icon in resolved_type`.

### `types/normalize-declared-only`

When the server answers `POST /types/normalize`, the server MUST NOT include in `type`, `registered_type` or `resolved_type` a `plural`, or a label of a field or of a member of a field's entries, that no type in the chain declares (`types/plural`, `types/label-write-back`).

**Reason:** normalize answers what the server would store for a declaration, and a made plural or label is never stored. `GET /types/{id}` answers the made ones for display; a comparison of the two would otherwise find a difference no author made.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`.

### `types/normalize-absent`

When a candidate's identifier is not registered, the server MUST return `null` for `registered_type` and `resolved_type` from `POST /types/normalize`.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`.

### `types/normalize-defaults`

When `POST /types/normalize` returns a definition, the server MUST make field defaults explicit as `required: false` and `searchable: true`, derive a missing label as on registration and use registration's default version of 0.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`.

### `types/normalize-declared-refinements`

When `POST /types/normalize` returns `type` or `registered_type`, the server MUST preserve the leaf's own inherited-field refinements, policies, roles and version without adding fields declared only by its ancestors.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`.

### `types/normalize-validation`

If a candidate sent to `POST /types/normalize` fails registration's schema or parent-chain validation, then the server MUST refuse it with the same validation status and code as registration.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`.

### `types/normalize-no-write`

When `POST /types/normalize` succeeds or is refused, the server MUST leave the type registry unchanged.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`.

### `types/normalize-no-audit`

When `POST /types/normalize` succeeds or is refused, the server MUST create no audit entry.

**Tests:** `compliance/connector-interfaces.test.ts › normalizes equivalent declarations without write authority and retains inherited refinements`.

### `types/normalize-cli`

When a caller runs `marfa types normalize` with a definition supplied by `--body`, `--file PATH` or `--file -`, the CLI MUST send the declared input to `POST /types/normalize` and return its answer.

**Tests:** `cli/doors.test.ts › normalizes an inline or stdin declaration with a read-only key and compares the registered definition`.

## The owner's icon for a type

The owner can choose the icon any type is shown by, a core or connector type among them, without replacing its definition. The choice sits beside the definition, so the author's icon stays the default and a replacement of the definition leaves the choice alone. It is made at `PUT /types/{id}/icon` and cleared at `DELETE /types/{id}/icon`.

### `types/icon-set`

When a caller allowed by `types/icon-who` sends `PUT /types/{id}/icon` with an `icon` that is an ID `types/icon-name` accepts, for a registered type, the server MUST keep it as the owner's icon for that type and answer `200` with the `type` as `GET /types/{id}` now answers it.

**Reason:** an owner tells types apart by their icons, and a core or connector type's author cannot know which icon its owner wants. A core type can't be replaced, and a connector writes its own types again when it starts, so a choice made in the definition would not last.

**Tests:** `compliance/type-icons.test.ts › sets the owner's icon for a type and reads it back`.

### `types/icon-clear`

When a caller allowed by `types/icon-who` sends `DELETE /types/{id}/icon` for a registered type, the server MUST remove the owner's icon for that type, whether or not one was set, and answer `200` with the `type` as `GET /types/{id}` now answers it.

**Reason:** clearing restores the author's default, and a clear that failed for a type with no choice would make the call unsafe to repeat.

**Tests:** `compliance/type-icons.test.ts › clears the owner's icon, and clearing again changes nothing`.

### `types/icon-read`

While the owner has an icon for a type, the server MUST answer it as that type's `display_hints.icon` on `GET /types/{id}`, in the listing at `GET /types` and in the answer to `PUT /types/{id}`, in place of the icon the type's definition names.

**Reason:** an app reads one icon and has no second field to consult, and a subtype that sets no icon of its own takes the owner's icon for its parent, as `types/read-display-hint` says for any hint; a device reads the same answer from its catalog (`device/catalog-icon`).

**Tests:** `compliance/type-icons.test.ts › answers the owner's icon in place of the author's, on the read, the list and a subtype`.

### `types/icon-kept`

When a caller replaces a type with `PUT /types/{id}`, the server MUST keep the owner's icon for that type apart from the stored definition.

**Reason:** the replacement never copies the owner's icon into the definition, so clearing it shows the author's own icon again. A connector writes its types again at each release; a choice it wiped would be lost at the next update.

**Tests:** `compliance/type-icons.test.ts › keeps the owner's icon through a replacement of the type`.

### `types/icon-write-back`

When the `display_hints.icon` a caller submits to `PUT /types/{id}` equals the owner's icon for that type, the server MUST store the icon the definition already had, or none if it had none.

**Reason:** a caller that reads a type and writes the answer back sends the owner's icon as if the author had chosen it; storing it would make clearing the owner's icon show a name the author never wrote, and `types/icon-kept` could not hold.

**Tests:** `compliance/type-icons.test.ts › does not bake the owner's icon into the definition when a read is written back`.

### `types/hint-write-back`

When the definition stored for a type sets none of a display hint (`title_field`, `body_field` or `icon`) and the value a caller submits for it to `PUT /types/{id}` equals the value `GET /types/{id}` answers for that hint, the server MUST store no value for that hint.

**Reason:** a caller that reads a subtype and writes the answer back sends every hint the subtype takes from an ancestor, and the owner's icon an ancestor shows, as if the subtype had chosen it; storing them would stop the subtype following its ancestor (`types/read-display-hint`), and clearing the owner's icon would leave the subtype showing it. A subtype that sets a hint to a value other than the one it reads as keeps it.

**Tests:** `compliance/type-icons.test.ts › does not freeze the hints a subtype inherits when its read is written back`, `compliance/type-icons.test.ts › keeps a hint a subtype sets differently from its parent when its read is written back`.

### `types/label-write-back`

When the definition stored for a type names no `plural`, or no `label` for a field or a member of a field's entries, and the value a caller submits for it to `PUT /types/{id}` equals the value `GET /types/{id}` answers for it, the server MUST store no value for it.

**Reason:** a caller that reads a type and writes the answer back sends every plural and label the server made (`types/plural`, `types/field-label`) as if the author had chosen it; storing them would stop the plural following a later change of label and a field following a label an ancestor names. A value other than the one the type reads as is kept. So an author cannot fix a plural or label that equals the one the type already reads as: it goes on following its label, name or ancestor, and to keep it through a later change, the author names it after that change.

**Tests:** `compliance/type-label.test.ts › does not freeze a made plural or field label when a read is written back`.

### `types/icon-refused`

If `PUT /types/{id}/icon` names an `icon` that `types/icon-name` refuses, then the server MUST answer `400 invalid_schema` naming the member `icon`.

**Reason:** the owner's choice is drawn from the same sets as the author's, so it can hold no icon an app cannot draw; a refused call leaves the icon the type had.

**Tests:** `compliance/type-icons.test.ts › refuses an icon outside the pinned sets and a type nothing registered, and keeps the earlier choice`.

### `types/icon-missing-type`

If `PUT /types/{id}/icon` or `DELETE /types/{id}/icon` names a type nothing registered, then the server MUST answer `404 type_not_found`.

**Reason:** an icon belongs to a registered type, so a choice for a name nothing holds would wait for an unrelated type to be registered.

**Tests:** `compliance/type-icons.test.ts › refuses an icon outside the pinned sets and a type nothing registered, and keeps the earlier choice`.

### `types/icon-who`

When the owner's session, a local process, or a key holding `schema.write` and write on the type in its type map sends `PUT /types/{id}/icon` or `DELETE /types/{id}/icon`, the server MUST allow the call.

**Reason:** the icon is a presentation choice made over the author's, and who may set or clear it is exactly who may replace the type; a key that may not change a type's definition may not change how the owner sees it.

**Tests:** `compliance/type-icons.test.ts › allows a key with schema.write on the type and refuses one without`.

### `types/icon-who-refused`

If a key without `schema.write`, or without write on the type in its type map, sends `PUT /types/{id}/icon` or `DELETE /types/{id}/icon`, then the server MUST answer `403` (`forbidden` for the missing permission, `type_not_permitted` for the missing write on the type) and leave the owner's icon as it was.

**Reason:** changing the icon is replacing how the owner sees the type, so it needs what replacing the type needs, and a key that is a connector's gets no more and no less than any other.

**Tests:** `compliance/type-icons.test.ts › allows a key with schema.write on the type and refuses one without`.

### `types/icon-deleted`

When `DELETE /types/{id}` removes a type, the server MUST discard the owner's icon for it.

**Reason:** a type later registered under the same identifier starts without one, because a stale choice would give an unrelated type the icon the owner chose for a type that no longer exists.

**Tests:** `compliance/type-icons.test.ts › discards the owner's icon with the type`.

### `types/icon-audit`

When `PUT /types/{id}/icon` or `DELETE /types/{id}/icon` succeeds, the server MUST record an audit entry with the action `type.icon.set` or `type.icon.clear` and the type's identifier as the resource.

**Reason:** a presentation choice made over an author's default is a change to the registry that the owner can later account for.

**Tests:** `compliance/type-icons.test.ts › records the owner's icon change in the audit log`.

## Item names

In these statements, whitespace is the ECMAScript `WhiteSpace` and `LineTerminator` characters, a line ends at CR LF, LF, CR, U+2028 or U+2029, and a control character is one in the Unicode general category `Cc`. So U+0085 is a control character and neither whitespace nor a line end, and U+FEFF is whitespace. The cases both implementations are held to are in `conformance/fixtures/item-display.json`.

### `types/item-name-fields`

When computing the name of an item that `types/item-name-part` does not name, the server MUST use the first property among its effective `display_hints.title_field`, `title`, `name`, effective `display_hints.body_field`, `body`, `text`, `filename`, `url` and `address`, in that order, whose value is a string that produces nonblank text by `types/item-name-markdown` and `types/item-name-text`.

**Reason:** Existing display hints, inherited as in `types/read-display-hint`, let a custom type choose its name without a second naming configuration; a file's existing `title` also holds its filename.

**Tests:** `compliance/item-summaries.test.ts › names every built-in and custom type with bounded plain text and fallback fields`, `› names every shared display case as a device does, and Untitled where a device answers no name`.

### `types/item-name-part`

When computing the name of an item that is the source of an edge of a `with-hosts` type and whose effective `display_hints.title_field`, `title` and `name` produce no nonblank text, the server MUST name it `<label> <host name>`, by `types/item-name-text`, from the edge type's `label` and the name by `types/item-name-fields` and `types/item-name-empty` of the target of the oldest such edge, by `created_at` and then `id`, whose target is out of the bin and of a type the credential may read.

**Reason:** a comment or an attached file is read beside its host, so "Comment on Plan" says what it is where its first line would not. With no such host, its own fields name it. A device names a part by the same rule (`device/item-name-part`).

**Tests:** `compliance/item-summaries.test.ts › names a part with no title after its oldest host out of the bin, at read time`, `› names every shared part case as a device does`, `compliance/mcp.test.ts › names a part after a host the caller may read, and never after one it may not`, `› names a part by the types the caller may read, whatever its edge access`, `› names a part in the bin after its host out of the bin, as the owner's bin does`, `› names a part after its oldest host when it has more hosts than an item read carries`.

### `types/item-name-text`

When a name field contains text, the server MUST trim its surrounding whitespace, take its first line, replace each control character with a space, collapse each run of whitespace to one space and trim the result, limited to 120 Unicode code points with the last point replaced by `…` when shortened.

**Reason:** A device names an item by the same rule (`device/item-name`), so the server and a device show one name for one item.

**Tests:** `compliance/item-summaries.test.ts › names every built-in and custom type with bounded plain text and fallback fields`, `› names every shared display case as a device does, and Untitled where a device answers no name`.

### `types/item-name-markdown`

When computing an item's name from its effective `display_hints.body_field`, `body` or `text`, the server MUST apply `types/item-name-text` to that property's value with its Markdown removed: each line that `device/item-preview-fence` or `device/item-preview-lines` removes left out, each line inside a fence kept as written, and each other line as `device/item-preview-prefixes` through `device/item-preview-unclosed` leave it.

**Reason:** A body is Markdown, so a note whose body starts `# Plan` is named `Plan`, and a body that is only Markdown syntax gives no name. The other name fields hold plain text and keep every character.

**Tests:** `compliance/item-summaries.test.ts › names every shared display case as a device does, and Untitled where a device answers no name`.

### `types/item-name-empty`

When no name candidate produces nonblank text, the server MUST return `Untitled` as the item's name.

**Tests:** `compliance/item-summaries.test.ts › names every built-in and custom type with bounded plain text and fallback fields`, `› names every shared display case as a device does, and Untitled where a device answers no name`.

### `types/delete-owner`

When a recent owner session or private local command sends `DELETE /types/{id}`, the server MUST apply the built-in type, existing-item, setting, subtype and compatibility-dependency checks before removing an unused custom type.

**Tests:** `compliance/owner-trash.test.ts › lets the owner remove only unused custom types`.

### `types/delete-owner-recent`

If the browser session sending `DELETE /types/{id}` signed in more than five minutes ago, then the server MUST answer `403 forbidden` and keep the type.

**Reason:** Removing a type changes what every app can store, so a browser left signed in, or a copied cookie, cannot do it without the password.

**Tests:** `compliance/recent-sign-in-consent.test.ts › refuses a session that signed in more than five minutes ago 403 and keeps the type, and a fresh session removes it`.

### `types/delete-owner-force`

If a direct owner or private local command sends `DELETE /types/{id}?force=true`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/owner-trash.test.ts › lets the owner remove only unused custom types`.

## Type provenance

### `types/creator-snapshot`

When a caller registers a type, the server MUST retain its canonical sign-in ID, kind and readable name in `provenance.created_by`, independently of the submitted definition and later replacements.

**Tests:** `compliance/types.test.ts › reports the creator after replacement and distinguishes built-in types`.

### `types/provenance-read`

When a caller reads or lists types, the server MUST return `provenance.origin` as `platform` for built-in types, `user` for registered types, or `unknown` for an unrecorded origin, with `created_by` set to `null` where no creator is recorded.

**Tests:** `compliance/types.test.ts › reports the creator after replacement and distinguishes built-in types`.

### `types/creator-archive`

When the server restores an accepted archive, the server MUST preserve a valid recorded type creator and leave an absent creator unknown, rather than attribute the type to the restoring sign-in.

**Tests:** `compliance/restore-archive.test.ts › preserves a recorded creator and leaves an absent creator unknown`.
