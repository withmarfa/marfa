# Views

A view is a saved list of items, held as a `system.view` item and shared by every app: its `query` says which items it lists, and its `sort` and `group` say in what order and how they group. How an app shows the items is the app's own, so a view holds no layout. A view is written only through `/views` and read through the item operations. The view operations never answer the items a view lists.

## Writing a view

### `views/create`

When a key sends `POST /views` with a `title`, the server MUST answer `201` with an `item` of type `system.view` at `version` 1, `active`, whose properties are the settings as sent, and its `metadata`.

**Tests:** `compliance/views.test.ts › creates a view as a system.view with its query, sort and group, read back through the item doors`.

### `views/settings`

The server MUST take as a view's settings `title`, `query` with `types`, `tier`, `state`, `filter` and `beneath`, `sort` and `group`, and no other key.

**Tests:** `compliance/views.test.ts › creates a view as a system.view with its query, sort and group, read back through the item doors`, `› refuses a key a view setting does not declare, naming its path from the body, on a create and on a change`.

### `views/sort-and-group`

The server MUST take as a view's `sort` a list of at most 10 keys of `by` and `direction`, and as its `group` a `by`, and optionally a `bucket`, an `order` and a `hidden` list.

**Tests:** `compliance/views.test.ts › creates a view as a system.view with its query, sort and group, read back through the item doors`, `› takes a sort and a group on a date, an edge and a property, and refuses none of them`, `› refuses a malformed setting %j with %s naming %s, on a create and on a change`.

### `views/field`

The server MUST take as a sort `by` and a `group.by` an own field (`title`, `created_at`, `updated_at`, `occurred_at`, `type`, `state`, `tier` or `tags`) or `properties.<name>`, and as a `group.by` also `edge[<type>]` or `backref[<type>]` for a registered edge type.

**Tests:** `compliance/views.test.ts › takes a sort and a group on a date, an edge and a property, and refuses none of them`, `› refuses a malformed setting %j with %s naming %s, on a create and on a change`.

### `views/filter-terms`

The server MUST take as a view's `query.filter` any expression the listing grammar takes, including an `edge` term, a `backref` term and a `source` term.

**Reason:** a view of one folder's items is a `filter` of `edge[in-folder] eq "<folder id>"`, the same expression a listing takes.

**Tests:** `compliance/views.test.ts › takes a view of one folder's items, of one source and of items nothing points at`.

### `views/announced`

When a key creates or changes a view, the server MUST announce `item.created` or `item.updated` for it.

**Tests:** `compliance/views.test.ts › publishes a view's create and change as item events, and its delete as item.purged`.

## Refusing a setting

### `views/setting-checked`

If a view setting is malformed, other than by a key it does not declare or a part it requires, then the server MUST answer `400`, naming the setting in `details.errors[0].path`, before it writes anything.

**Tests:** `compliance/views.test.ts › refuses a malformed setting %j with %s naming %s, on a create and on a change`.

### `views/setting-invalid`

If a field a view's `sort` or `group` names is outside `views/field`, a `sort` holds more than 10 keys or a `direction` other than `asc` or `desc`, a `group.bucket` is not `day`, `week`, `month` or `year` or is set on a field that is not a date field, or the `query` names a malformed or `system.*` type identifier, a `filter` the listing grammar refuses, a `beneath` that is not an item id, a `tier` other than `library`, `feed` or `all`, or a `state` other than `active` or `archived`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/views.test.ts › refuses a malformed setting %j with %s naming %s, on a create and on a change`.

### `views/setting-unknown-type`

If `query.types` names a well-formed type identifier nothing registered, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/views.test.ts › refuses a malformed setting %j with %s naming %s, on a create and on a change`.

### `views/setting-missing`

If `POST /views` carries no `title`, then the server MUST answer `400 missing_required_field` naming `title` in `details.field`.

**Tests:** `compliance/views.test.ts › refuses a create missing its title with missing_required_field naming title`.

### `views/setting-undeclared`

If a request to `POST /views` or `PATCH /views/{id}` carries a key that its body, its `query`, one of its `sort` keys or its `group` does not declare, then the server MUST answer `400 validation_error` naming each such key in `details.unknown_body_fields` by its path from the body, such as `owner`, `layouts` or `sort.0.nulls`.

**Reason:** a view holds no layout, so a body that carries one is refused rather than dropped.

**Tests:** `compliance/views.test.ts › refuses a key a view setting does not declare, naming its path from the body, on a create and on a change`.

## Changing a view

### `views/change`

When `PATCH /views/{id}` names the `version` an active view holds and one or more settings, the server MUST replace each setting named whole and advance the version.

**Tests:** `compliance/views.test.ts › changes a view at its version, merges a stale change to another setting, and refuses one to the same`.

### `views/change-stale`

When `PATCH /views/{id}` names a version an active view no longer holds and changes only settings nobody changed since, the server MUST apply it.

**Tests:** `compliance/views.test.ts › changes a view at its version, merges a stale change to another setting, and refuses one to the same`.

### `views/change-conflict`

If `PATCH /views/{id}` names a version an active view no longer holds and changes a setting changed since, then the server MUST answer `409 version_conflict` with `conflicting_fields` naming each such setting.

**Tests:** `compliance/views.test.ts › changes a view at its version, merges a stale change to another setting, and refuses one to the same`.

### `views/change-refused`

If `PATCH /views/{id}` names no `version`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/views.test.ts › refuses a change naming no version or no setting, and a change or delete of an id that is not a view`.

### `views/change-empty`

If `PATCH /views/{id}` names no setting, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/views.test.ts › refuses a change naming no version or no setting, and a change or delete of an id that is not a view`.

### `views/change-revoked`

If a valid `PATCH /views/{id}` names a revoked view, then the server MUST answer `400 invalid_transition`.

**Tests:** `compliance/views.test.ts › refuses to change a view revoked by its parent's deletion`.

### `views/change-revoked-unchanged`

If `PATCH /views/{id}` is refused because the view is revoked, then the server MUST leave the view unchanged.

**Tests:** `compliance/views.test.ts › refuses to change a view revoked by its parent's deletion`.

### `views/not-found`

If `PATCH /views/{id}` or `DELETE /views/{id}` names an id that holds no `system.view`, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/views.test.ts › refuses a change naming no version or no setting, and a change or delete of an id that is not a view`, `› deletes a view at once, and a deleted view is no longer readable or changed`.

## Deleting a view

### `views/parent-deleted`

When deleting a parent item cascades through `parent-of` to an active view, the server MUST move the view to `revoked`.

**Tests:** `compliance/views.test.ts › deletes a view revoked by its parent's deletion`, `› refuses to change a view revoked by its parent's deletion`.

### `views/delete`

When a key sends `DELETE /views/{id}` for an active or revoked view, the server MUST answer `200` with `ok: true` and remove the view at once, with no trash, so that `GET /items/{id}` answers `404 item_not_found` and no listing holds it.

**Tests:** `compliance/views.test.ts › deletes a view at once, and a deleted view is no longer readable or changed`, `› deletes a view revoked by its parent's deletion`.

### `views/delete-announced`

When a key deletes a view, the server MUST announce `item.purged` for it, and neither `item.deleted` nor `item.state_changed`.

**Reason:** `item.deleted` means a move to the trash, which a working copy keeps; `item.purged` tells every working copy to drop the view.

**Tests:** `compliance/views.test.ts › publishes a view's create and change as item events, and its delete as item.purged`.

## Who may read and write a view

### `views/grant`

If a key whose type map does not grant write on `system.view` creates, changes or deletes a view, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/views.test.ts › admits a key minted with write on system.view alone, and refuses one whose map does not grant it`.

### `views/read`

The server MUST answer a view through `GET /items/{id}` and a listing naming `system.view` to a key with read on `system.view`.

**Tests:** `compliance/views.test.ts › creates a view as a system.view with its query, sort and group, read back through the item doors`, `› reads a view through the item doors only with read on system.view`.

### `views/read-hidden`

If a key without read on `system.view` sends `GET /items/{id}` for a view, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/views.test.ts › reads a view through the item doors only with read on system.view`.
