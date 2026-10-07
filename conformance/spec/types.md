# Types

The registry of item types: identifiers, fields, inheritance, merge and version policies, and the instance's enforcement levers.

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

If a type identifier's first segment is `schema`, `keys`, `items`, `webhooks`, `config`, `audit`, `grants`, `content`, `metadata`, `edge`, `profile` or `space`, then the server MUST refuse it as `types/id-malformed` refuses an identifier the grammar refuses.

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

If a type declares a field named `id`, `type`, `state`, `tier`, `properties`, `created_at`, `updated_at`, `occurred_at`, `source`, `source_id`, `version`, `schema_version`, `capture_latitude`, `capture_longitude`, `trashed_by_cascade` or `trashed_with`, then the server MUST answer `400 property_shadows_field` naming each such field.

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

**Tests:** waiting on #1444.

### `types/label`

When `POST /types` or `PUT /types/{id}` names no `label`, or an empty one, the server MUST give the type one made from the last segment of its identifier, with each hyphen and underscore made a space and each word capitalized.

**Tests:** `compliance/type-label.test.ts › register custom type without label`, `› makes a label from the identifier when a replacement names none`.

### `types/label-kept`

When `POST /types` or `PUT /types/{id}` names a non-empty `label`, the server MUST store it and answer it on every read of the type.

**Tests:** `compliance/type-label.test.ts › register custom type with label`, `› label appears in type list`.

## Reading the registry

### `types/read`

When a credential sends `GET /types/{id}` for a registered type, the server MUST answer it with the fields, `version_policy` and `merge_policy` its parents give it merged beside its own.

**Tests:** `compliance/type-inheritance.test.ts › a child reads back with the parent's fields merged beside its own`, `compliance/types.test.ts › a runtime-registered custom child type inherits the parent's resolved merge_policy on GET`, `compliance/version-policy.test.ts › reads back field by field from the parent, a field the child declares overriding`.

### `types/list-declared-policy`

When `GET /types` lists a type, the server MUST answer the `version_policy` and `merge_policy` the type itself declares, and none it only inherits.

**Reason:** `GET /types/{id}` answers the policies a type is held to (`types/read`); the listing shows what each registration says.

**Tests:** `compliance/version-order.test.ts › lists the version_policy and merge_policy a type declares, and answers the resolved ones for the type itself`.

### `types/read-display-hints`

When a type declares no `display_hints`, the server MUST answer on `GET /types/{id}` those of its nearest ancestor that declares any, whole.

**Reason:** a type that names only a body hint gets no title hint from its parent, so a reader falls back to `title` (`device.md` 47).

**Tests:** `compliance/type-inheritance.test.ts › answers the display hints of the nearest type that declares any, whole`.

### `types/read-missing`

If `GET /types/{id}` or `DELETE /types/{id}` names an identifier nothing registered, or `PUT /types/{id}` names a well-formed one nothing registered, then the server MUST answer `404 type_not_found`, whatever the key's type map.

**Tests:** `compliance/types.test.ts › answers 404 for a type that is not registered`, `compliance/type-registry.test.ts › returns 404 for a non-existent type identifier`, `› answers 404 deleting a type identifier that was never registered`, `› answers 404 to a replacement of a type nothing registered, whatever the key's map`.

### `types/registry-open`

The server MUST answer `GET /types`, `GET /types/{id}` and `GET /edge-types` with the whole registry to every credential, whatever its type map and edge map reach.

**Reason:** a registered type and an unregistered one are already told apart, a schema holds no item data, and a device resolves an inherited field by walking `parent` (`device.md` 47).

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

The server MUST let a subtype add fields, redeclare an inherited field unchanged or with a new `description`, and make an inherited field required.

**Tests:** `compliance/type-inheritance.test.ts › accepts a child type that adds a field not present on the parent`, `› accepts a child that redeclares an inherited field without changing it`, `› lets a child tighten an inherited field to required, and refuses one that loosens it`.

### `types/child-shape`

If a type would give a field another `type`, `format`, `items_type`, `searchable`, `maxLength`, `maxItems` or `enum_values` than a type in its chain gives it, or make an inherited required field optional, then the server MUST answer `400 inheritance_violation` naming the field.

**Tests:** `compliance/type-inheritance.test.ts › rejects a child type that changes an inherited field shape (inheritance_violation)`, `› rejects a parent gaining a field whose shape differs from one its child declares`, `› lets a child tighten an inherited field to required, and refuses one that loosens it`, `› refuses a replacement of a child that changes an inherited field's shape`, `compliance/thumbnails.test.ts › refuses a parent gaining a thumbnail under a name its child declares as text, and takes one its child declares as a thumbnail`.

### `types/listing-subtree`

When a listing names a type, the server MUST answer the items of that type, of every type whose identifier begins with it and a dot, and of every type whose chain of `parent` reaches it.

**Tests:** `compliance/entity-subtypes.test.ts › querying core.entity returns all entity subtypes`, `› querying core.entity.person returns only persons`, `compliance/types.test.ts › selects a type filter's items by identifier and by declared parent alike`.

### `types/compatible-with`

When a type names `compatible_with`, the server MUST take it only where the type requires every field the target requires, its own or inherited, and every target field the type declares or inherits is readable as the target's: the same type, or `url`, `email`, `datetime`, `date`, `thumbnail` or `enum` where the target's is `string`, or `integer` where it is `number`; for an `array`, the same `items_type`; for an `enum`, values drawn from the target's; and, where both name a `format`, the same one.

**Tests:** `compliance/type-inheritance.test.ts › accepts compatible_with: core.note when fields satisfy the structural superset`, `› takes a compatible_with claim whose fields are readable as the target's, and refuses one that is not`.

### `types/compatible-with-refused`

If a type's `compatible_with` names a type nothing registered, or one the type is not compatible with, then the server MUST answer `422 compatible_with_violation`.

**Tests:** `compliance/type-inheritance.test.ts › rejects compatible_with target that does not exist`, `› rejects compatible_with when a required ancestor field is missing`, `› refuses a compatible_with claim whose target field the type declares in another shape, or optional where the target requires it`, `compliance/types.test.ts › refuses a replacement that breaks its compatible_with claim, as registration does`.

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

If a type names a field definition with an unknown `type` or `format`, an `enum` whose `enum_values` is missing or empty or holds a value that is not a string, an `array` with no `items_type`, or a `maxLength` or `maxItems` that is not a whole number of at least 1 or on a type it does not apply to, or the type names `states`, `default_state` or `transitions`, a `required` entry naming a field it does not declare, a role other than `container`, or a `display_hints` `title_field` or `body_field` naming a field neither it nor an ancestor declares, then the server MUST answer `400 invalid_schema` naming the member.

**Tests:** `compliance/field-types.test.ts › refuses a field definition the grammar does not take`.

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

When a `string` field names a `format` of `bcp47` or `iso3166`, the server MUST store the field as a `string` with that `format`.

**Tests:** `compliance/types.test.ts › keeps bcp47 and iso3166 as formats of a string, and refuses them on any other type`.

### `types/format-string-only-refused`

If a field of a type other than `string` names a `format` of `bcp47` or `iso3166`, then the server MUST answer `400 invalid_schema`.

**Tests:** `compliance/types.test.ts › keeps bcp47 and iso3166 as formats of a string, and refuses them on any other type`.

### `types/datetime-value`

When an item names a value for a `datetime` field, the server MUST take a `YYYY-MM-DD` calendar date, or such a date followed by `T`, `HH:MM`, `HH:MM:SS` or `HH:MM:SS` with a decimal fraction, and `Z` or a `±HH:MM` offset, with hours to 23 and minutes and seconds to 59.

**Reason:** a value keeps the precision its source gave it, and a device validates the same values offline as the server does online (`device.md` 57).

**Tests:** `compliance/field-types.test.ts › takes every datetime form and refuses one with no zone or an hour past 23`, `device/property-validation-live.test.ts › matches a real server's field decisions and keeps queued writes across a catalog change`.

### `types/datetime-refused`

If an item names a `datetime` value with a time and no zone, or outside the bounds `types/datetime-value` states, or a `datetime` or `date` value naming a day the calendar does not have, or a `date` value with a time, then the server MUST answer `400 invalid_properties` naming the field.

**Tests:** `compliance/field-types.test.ts › takes every datetime form and refuses one with no zone or an hour past 23`.

### `types/searchable-false`

When a field declares `searchable: false`, the server MUST leave its value out of full-text matches and answer it on the item.

**Tests:** `compliance/fts-searchable.test.ts › field with searchable:false is excluded from full-text matches`, `› content remains retrievable on the item even when not searchable`.

## Thumbnails

A `thumbnail` field holds a small image the writer supplies; what a value may be is `items/thumbnail-format`.

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

If `PUT /types/{id}` or `DELETE /types/{id}` names a platform type, shipped or drifted, then the server MUST answer `403 core_type_immutable`, before it asks about items, subtypes or the key's type map.

**Tests:** `compliance/type-registry.test.ts › refuses both schema.write doors a platform-shipped type, and declares that refusal too`, `› refuses a platform type before it asks about subtypes, items or the key's type map`, `compliance/platform-type-drift.test.ts › refuses a replacement and a delete of a drifted platform type through the type registry`.

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

When a key holding `metadata.types:write`, without `schema.write`, sends `PUT /types/{id}` for a type registered at run time its map grants write on, the server MUST take a replacement that only adds optional fields no stored item holds a value under, or changes the `label`, `description`, `display_hints`, `version` or a kept field's `description`.

**Reason:** each release of a connector adds fields, and these change no stored item and only how the type is presented.

**Tests:** `compliance/type-evolution.test.ts › adds an optional field and changes the label, description and display hints, with metadata.types:write alone`, `› admits a change to the version and to a kept field's description on metadata.types:write alone`.

### `types/evolve-held-name`

If a key holding `metadata.types:write` and not `schema.write` sends `PUT /types/{id}` for a type registered at run time its map grants write on, adding a field under a name an item of the type or of a type under it holds a value under, in any state, then the server MUST answer `403 forbidden`.

**Reason:** a removal leaves the values items hold, so adding a field under a held name would give those values a shape.

**Tests:** `compliance/type-evolution.test.ts › refuses a field whose name a stored row holds, in any lifecycle state, and lands it for a key with schema.write`, `› refuses a field whose name only a row of a subtype holds`, `› refuses bringing a removed field back, which would reshape the values rows still hold`.

### `types/evolve-schema-change`

If a key holding `metadata.types:write` and not `schema.write` sends `PUT /types/{id}` for a type registered at run time its map grants write on, changing anything `types/evolve-free` does not name, then the server MUST answer `403 forbidden`.

**Reason:** a removed field, a required one, a changed field shape, `parent`, `roles`, `link_field`, `version_policy`, `merge_policy` or `compatible_with` each acts beyond the type. Holding back whatever is not named free keeps a member added to the definition later from being opened to every connector's key.

**Tests:** `compliance/type-evolution.test.ts › refuses %s to a key without schema.write, naming it, and lands it for a key with schema.write`, `› refuses a change to compatible_with, a kept field's constraint, required or searchable to a key without schema.write, and lands it with it`, `› refuses a key on metadata.types:write alone a change of parent as a schema change`.

### `types/evolve-refusal-details`

When the server refuses a replacement under `types/evolve-held-name` or `types/evolve-schema-change`, the server MUST answer `details.required_scope` `schema.write` and `details.changes` listing, in sorted order, each member that needs it, a field as `fields.<name>`.

**Reason:** the client reads what to ask for, and which part of its replacement to split off.

**Tests:** `compliance/type-evolution.test.ts › refuses %s to a key without schema.write, naming it, and lands it for a key with schema.write`, `› lists every change that needs schema.write, sorted`.

### `types/evolve-schema-write`

When a key holding `schema.write` sends `PUT /types/{id}` for a type its map grants write on, the server MUST NOT refuse it under `types/evolve-held-name` or `types/evolve-schema-change`.

**Tests:** `compliance/type-evolution.test.ts › refuses %s to a key without schema.write, naming it, and lands it for a key with schema.write`, `› refuses a field whose name a stored row holds, in any lifecycle state, and lands it for a key with schema.write`.

## Naming a parent

### `types/parent-reach`

If `POST /types`, or a `PUT /types/{id}` from a key holding `schema.write` that changes the stored `parent`, names a parent, other than a platform type, the key's type map does not grant write on, then the server MUST answer `403 type_not_permitted` with `details.grant` naming the parent, whether or not the parent is registered.

**Reason:** a subtype stops its parent being deleted, so naming a parent is a write to it.

**Tests:** `compliance/type-evolution.test.ts › refuses a registration naming a parent the key may not write, and takes it once the map reaches the parent`, `› holds a replacement that changes the parent to the key's reach, and leaves one that keeps its parent`, `› asks write on a parent nothing registered, before saying it is unknown`, `› asks write on a core parent the server does not ship`.

### `types/parent-kept`

The server MUST NOT ask write on the parent of a replacement that keeps the stored `parent`.

**Tests:** `compliance/type-evolution.test.ts › holds a replacement that changes the parent to the key's reach, and leaves one that keeps its parent`.

### `types/parent-shipped`

The server MUST NOT ask write on a parent that is a platform type, shipped or drifted.

**Reason:** no credential can delete a platform type through `/types`, and connectors subtype them.

**Tests:** `compliance/type-evolution.test.ts › exempts platform-shipped parents`.

## Deleting a type

### `types/delete`

When a key holding `schema.write` whose type map grants write on it sends `DELETE /types/{id}` for a type registered at run time that no item holds and no type names as parent, the server MUST remove it.

**Tests:** `compliance/type-registry.test.ts › deletes a type with no items`.

### `types/delete-in-use`

If a key holding `schema.write` whose type map grants write on it sends `DELETE /types/{id}` without `force=true` for a type registered at run time that an item holds, in any state, then the server MUST answer `409 type_in_use`.

**Tests:** `compliance/type-registry.test.ts › rejects deleting a type that has items`, `› refuses to delete a type that has only an item in the bin`.

### `types/delete-subtypes`

If a key holding `schema.write` whose type map grants write on it sends `DELETE /types/{id}` for a type registered at run time that another type names as parent, then the server MUST answer `409 type_has_subtypes` with `details.subtype_ids`, with `force=true` or without, before any answer about its items.

**Tests:** `compliance/type-registry.test.ts › refuses deleting a parent while a subtype still declares it`, `› refuses force against a parent, ahead of the items it holds`.

### `types/delete-force`

When a key holding `schema.write` whose type map grants write on it sends `DELETE /types/{id}?force=true` for a type registered at run time that items hold, the server MUST remove the type and keep the items.

**Tests:** `compliance/type-registry.test.ts › force-deletes a type that has items`, `› refuses a write to a row a forced delete left, until its type is registered again`.

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

**Tests:** `compliance/type-registry.test.ts › keeps the tags, extensions and lifecycle of a row a forced delete left writable`.

### `types/orphan-reregistered`

When a type is registered again, the server MUST hold each later write to its items to the schema it is registered with.

**Tests:** `compliance/type-registry.test.ts › refuses a write to a row a forced delete left, until its type is registered again`.

### `types/delete-race`

When an item write races `DELETE /types/{id}`, the server MUST either count the item, refusing a delete without `force=true` `409 type_in_use`, or refuse the item `unknown_type`.

**Tests:** waiting on #1444.

## Version policy

### `types/version-policy-values`

If a type's `version_policy` names a `recent_days`, `daily_snapshot_days`, `weekly_snapshot_days` or `max_versions` that is not a whole number of at least 1, then the server MUST answer `400 invalid_schema` naming it.

**Tests:** `compliance/version-policy.test.ts › refuses a number that is not a whole positive one, naming the field: %s`, `compliance/version-policy.test.ts › names the field on a replacement that breaks the version policy, and registers nothing on a create`.

### `types/version-policy-order`

If a type's `version_policy` names a window that ends sooner than an earlier one it names, in the order `recent_days`, `daily_snapshot_days`, `weekly_snapshot_days`, then the server MUST answer `400 invalid_schema` naming the window that ends too soon.

**Tests:** `compliance/version-policy.test.ts › refuses windows out of order, naming the one that ends too soon`, `› registers a policy of whole positive numbers in order`, `› refuses the same on a replacement and keeps the type as it was`, `compliance/version-policy.test.ts › names the field on a replacement that breaks the version policy, and registers nothing on a create`.

## Enforcement levers

`GET /config` and `PUT /config` hold the instance's levers beside its retention settings.

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

If a key without `config.manage` sends `GET /config` or `PUT /config`, then the server MUST answer `403 forbidden` with `details.required_scope` `config.manage`.

**Tests:** `compliance/schema-enforcement.test.ts › refuses both doors to a key without config.manage`.

### `types/strict-mode`

Where the `enforcement.strict_mode` that holds for the writing key, its own override's if the override names one and else the instance's, names a type in `types`, the server MUST refuse a write of an item of exactly that type that names a property neither the type nor an ancestor declares, with `400 invalid_properties`.

**Tests:** `compliance/schema-enforcement.test.ts › strict-on rejects unknown property with invalid_properties`, `› default-off accepts unknown property on core.note write`, `› holds strict mode and the source allow-list to the type named, not its subtypes`.

### `types/source-allowlist`

Where the `enforcement.source_allowlist` that holds for the writing key, its own override's if the override names one and else the instance's, names a type in `types`, if `POST /items` or a `POST /items/bulk` entry writes an item of exactly that type under a source the list does not name, then the server MUST refuse it `403 forbidden` with `details.type`, `details.source` and `details.allowed`.

**Tests:** `compliance/schema-enforcement.test.ts › rejects writes from non-listed source`, `› accepts writes from listed source`, `› asks it of every bulk entry, under the source the entry resolves to`, `› holds strict mode and the source allow-list to the type named, not its subtypes`.

### `types/source-filter`

Where the `enforcement.source_filter` that holds for the reading key, its own override's if the override names one and else the instance's, names types and sources, the server MUST leave out of every read that returns a set, a listing, search, export, stats and the tag counts among them, each item of a named type or a type under it whose source the filter does not name.

**Tests:** `compliance/schema-enforcement.test.ts › narrows reads to listed sources`, `› narrows every read that returns a set, not just the list route`, `› narrows only the types the source filter names, and their subtypes`.

### `types/source-filter-by-id`

The server MUST NOT apply `enforcement.source_filter` to a read by id.

**Tests:** `compliance/schema-enforcement.test.ts › does not narrow a read by id`.

## Shipped types

### `types/shipped`

The server MUST ship `core.bookmark`, `core.entity`, `core.entity.person`, `core.entity.place`, `core.event`, `core.file`, `core.file.audio`, `core.file.image`, `core.file.video`, `core.highlight`, `core.media`, `core.media.album`, `core.media.article`, `core.media.book`, `core.media.episode`, `core.media.film`, `core.media.series`, `core.media.song`, `core.message`, `core.note` and `core.task`, each with fields and a label, and no other `core.*` type.

**Tests:** `compliance/types.test.ts › ships exactly the core types, each with fields and a label`, `compliance/type-registry.test.ts › lists registered types including core types`, `› gets a single type by type identifier`, `compliance/type-inheritance.test.ts › core entity/file/media subtypes resolve`, `compliance/type-label.test.ts › built-in types have labels`, `› get single type includes label`.

### `types/shipped-system`

The server MUST ship `system.connection` and `system.folder` and no other `system.*` type.

**Tests:** `compliance/system-types.test.ts › ships only the system types the server writes`, `› lists exactly the two system types the server writes`.

### `types/message`

The server MUST ship `core.message` requiring `body` and `from`, taking `to` as a list of identifiers in any format, and naming `body` its display body.

**Tests:** `compliance/core-message.test.ts › creates a message with body, from, and to`, `› creates with only the required body and from`, `› accepts participant identifiers in any format`, `› rejects a message missing from with invalid_properties naming it`, `› rejects a message missing body with invalid_properties naming it`, `› declares body as its display body field`, `› declares body and from as required in the registry`.

### `types/highlight`

The server MUST ship `core.highlight` requiring `text`, taking `note`, `color`, `start_location`, `end_location` and `locator_type`, and declaring no `highlighted_at`.

**Reason:** the moment a highlight was made is the item's own `occurred_at`.

**Tests:** `compliance/highlight.test.ts › creates with only the required text property`, `› rejects a highlight missing the required text property`, `› roundtrips all optional properties`, `› accepts an optional note alongside text`, `› accepts each locator_type variant`, `› the moment the highlight was made is the system occurred_at`, `› has no highlighted_at property on item or properties`.

### `types/entity`

The server MUST ship `core.entity` requiring `name`, with `core.entity.person` and `core.entity.place` under it adding fields of their own.

**Tests:** `compliance/entity-subtypes.test.ts › creates a generic entity with required name field`, `› rejects entity without required name with invalid_properties naming it`, `› creates a person entity with person-specific fields`, `› creates a place entity with place-specific fields`, `› person inherits all entity fields`, `› requires an entity's name on a person and a place too`.

### `types/connection`

The server MUST ship `system.connection` with `kind` taking `app` alone, a description that names no connector, and none of `attached_device`, `feed_activity`, `last_error_at`, `last_sync_at`, `mapping_reapply_until`, `next_run_at`, `runtime_status`, `triggers`, `connector_id`, `credential_id`, `configuration`, `direction` and `mapping`, in its fields, its description or a row it serves.

**Tests:** `compliance/system-types.test.ts › declares app as the only system.connection kind`, `› ships none of the system.connection fields no door accepts`, `› serves no system.connection carrying a field the type no longer declares`.

## The platform registry

The registry rows of shipped types are the platform's. An instance upgraded past a build that shipped a type keeps its row, drifted, until the operator removes it.

### `types/platform-drift`

When the operator key sends `GET /platform-types/drift`, the server MUST list each platform row the build no longer ships, with its `item_count`, `child_types` and whether it is `removable`.

**Tests:** `compliance/platform-types.test.ts › lists no drift on an instance whose platform types match the build`, `compliance/platform-type-drift.test.ts › lists a drifted platform type, and removes it once nothing holds it`.

### `types/platform-remove`

When the operator key sends `DELETE /platform-types/{id}` for a drifted type no item holds and no type names as parent, the server MUST remove it and answer `200` with `removed: true`.

**Tests:** `compliance/platform-type-drift.test.ts › lists a drifted platform type, and removes it once nothing holds it`.

### `types/platform-remove-audit`

When `DELETE /platform-types/{id}` removes a type, the server MUST record a `platform_type.removed` entry at `GET /audit` naming the type and the operator key.

**Tests:** `compliance/platform-type-drift.test.ts › lists a drifted platform type, and removes it once nothing holds it`.

### `types/platform-remove-refused`

If `DELETE /platform-types/{id}` names a type the build ships, a type registered at run time, or a drifted type an item holds or a type names as parent, then the server MUST answer `409 conflict`.

**Tests:** `compliance/platform-types.test.ts › refuses to remove a type the build still ships`, `› answers 409 for a type registered at run time, which no platform row carries`, `compliance/platform-type-drift.test.ts › refuses to remove a drifted type that items still carry`, `› refuses to remove a drifted type another type inherits from`.

### `types/platform-remove-missing`

If `DELETE /platform-types/{id}` names an identifier no registry row carries, then the server MUST answer `404 type_not_found`.

**Tests:** `compliance/platform-types.test.ts › answers 404 for an identifier no platform row carries`.

### `types/platform-operator-only`

If a credential other than the operator key sends `GET /platform-types/drift` or `DELETE /platform-types/{id}`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/platform-types.test.ts › refuses removal to a working key`, `› refuses the listing to a working key and to no credential`.
