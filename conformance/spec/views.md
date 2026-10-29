# Views

A view is a saved list of items, held as a `system.view` item and shared by every app: its `query` says which items it lists, and its `sort` and `group` say in what order and how they group. How an app shows the items is the app's own, so a view holds no layout. A view is written only through `/views` and read through the item operations. `GET /views/{id}/items` answers the items a view lists.

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

### `views/group-clear`

When `PATCH /views/{id}` names the `version` an active view holds and `group` as `null`, the server MUST remove the view's `group`, leave every other setting as held and advance the version.

**Reason:** a change replaces the settings it names, and a setting left out stays, so `null` is the one way to say a view has no grouping. A clear is a change to the `group` setting alone, so `views/change-stale` and `views/change-conflict` hold for it as for any setting: a stale clear applies where nobody changed the `group` since, and collides on `group` where somebody did. A stale clear of a `group` that the named version did not hold changes nothing, and the answer shows the `group` that stands.

**Tests:** `compliance/views.test.ts › clears a view's group with null, leaving every other setting as held, and takes a stale clear only where the group is unchanged`.

### `views/null-refused`

If a request carries `null` for a setting other than `group` on `PATCH /views/{id}`, or for any setting on `POST /views`, then the server MUST answer `400 validation_error` naming the setting in `details.errors[0].path`.

**Tests:** `compliance/views.test.ts › refuses null for every setting but a change's group`.

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

## Reading what a view lists

### `views/items`

When a key sends `GET /views/{id}/items` for a view it can read, the server MUST answer `200` with a page of the items the view lists.

**Reason:** an app with no working copy reads a saved list from the server, in the order the view names.

**Tests:** `compliance/views-items.test.ts › lists the newest occurrence first when the view names no sort, and answers a page the document declares`.

### `views/items-query`

The server MUST list in a view the items that match its `query`: the named `types` with their subtypes, the named `state` (active and archived when absent), the named `tier` (both when absent), and the `filter`.

**Tests:** `compliance/views-items.test.ts › lists active and archived items by default, and the states a view names`, `› lists the types a view names with their subtypes, and narrows by its filter`, `› sorts by type, state, tier and tags`.

### `views/items-system`

The server MUST NOT list an item of a `system.*` type in a view.

**Reason:** a view of every item lists what a person keeps, not the records the server keeps for itself.

**Tests:** `compliance/views-items.test.ts › never lists a system item, though the view's own query would reach one`.

### `views/items-beneath`

Where a view names `query.beneath`, the server MUST list that item and every item under it by `parent-of` at any depth, each once.

**Tests:** `compliance/views-items.test.ts › lists the item beneath and everything under it by parent-of, at any depth`.

### `views/items-beneath-state`

Where a view names `query.beneath`, the server MUST NOT list a trashed item.

**Tests:** `compliance/views-items.test.ts › leaves out a trashed item beneath and a trashed item itself, and lists nothing beneath an item that does not exist`.

### `views/items-beneath-missing`

If a view names a `query.beneath` that is no item, then the server MUST answer `200` with an empty page.

**Tests:** `compliance/views-items.test.ts › leaves out a trashed item beneath and a trashed item itself, and lists nothing beneath an item that does not exist`.

### `views/items-order`

The server MUST list a view's items by its `sort` keys in turn, first key first, and by the newest `occurred_at` first when the view has no sort.

**Tests:** `compliance/views-items.test.ts › lists the newest occurrence first when the view names no sort, and answers a page the document declares`, `› sorts by type, state, tier and tags`, `› orders by every key in turn, up to ten, and pages through a tie on the leading keys`.

### `views/items-order-title`

Where a view sorts by `title`, the server MUST order each item by the field its type names as its title field, or by `title` where the type names none.

**Reason:** the title a person sees is the field the type names, so the order matches what the screen shows.

**Tests:** `compliance/views-items.test.ts › sorts by title, naming each type's own title field, with an untitled item last in either direction`, `› sorts by a title field a type registered at runtime names`.

### `views/items-order-missing`

Where a view sorts by a field an item does not hold, the server MUST list that item after every item that holds it, in either direction.

**Tests:** `compliance/views-items.test.ts › sorts by title, naming each type's own title field, with an untitled item last in either direction`, `› sorts by a property, numbers by value and an item without the property last in either direction`, `› sorts by type, state, tier and tags`.

### `views/items-order-ties`

Where items tie on every sort key, the server MUST list them by ascending ID, or by the direction of the key when the view sorts by one timestamp alone.

**Tests:** `compliance/views-items.test.ts › breaks a tie by the item's ID, and a tie on the one timestamp key in that key's direction`, `› orders by every key in turn, up to ten, and pages through a tie on the leading keys`.

### `views/items-limit`

The server MUST answer a page of at most `limit` items, 50 when `limit` is absent.

**Tests:** `compliance/views-items.test.ts › answers 50 items without a limit and refuses a limit above 200 or below 1`.

### `views/items-limit-range`

If a key sends a `limit` below 1 or above 200, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/views-items.test.ts › answers 50 items without a limit and refuses a limit above 200 or below 1`.

### `views/items-cursor`

When a key sends the `next_cursor` of a page as `cursor`, the server MUST answer the items that follow that page in the view's order, with none repeated and none left out.

**Tests:** `compliance/views-items.test.ts › pages in the view's order with a cursor, whatever the limit, with no item twice and none missed`, `› orders by every key in turn, up to ten, and pages through a tie on the leading keys`.

### `views/items-cursor-foreign`

If a key sends a `cursor` that another view, another ordering or no listing issued, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/views-items.test.ts › refuses a cursor from another view, another ordering or no listing at all`.

### `views/items-readable`

The server MUST NOT list in a view an item of a type the key cannot read.

**Reason:** a saved view never widens what a key reads.

**Tests:** `compliance/views-items.test.ts › leaves out the types a key cannot read, and walks beneath only through items it can read`, `› lists nothing for a key that reads the view but no item, and refuses a key that reads no type`.

### `views/items-beneath-readable`

Where a view names `query.beneath`, the server MUST NOT reach an item through one the key cannot read.

**Reason:** an item under an unreadable one would show that the unreadable one has children.

**Tests:** `compliance/views-items.test.ts › leaves out the types a key cannot read, and walks beneath only through items it can read`.

### `views/items-edge-read`

If a view names `query.beneath` and the key cannot read `parent-of` edges, then the server MUST answer `403 edge_permission_denied`.

**Tests:** `compliance/views-items.test.ts › refuses a view that goes beneath an item to a key that cannot read parent-of edges`.

### `views/items-no-type`

If a key reads no type, then the server MUST answer `GET /views/{id}/items` with `403 type_not_permitted`.

**Tests:** `compliance/views-items.test.ts › lists nothing for a key that reads the view but no item, and refuses a key that reads no type`.

### `views/items-not-found`

If no view the key can read has the ID, then the server MUST answer `GET /views/{id}/items` with `404 item_not_found`.

**Reason:** an item that is not a view and a view the key cannot read answer as an ID nothing holds, as `views/not-found` and `views/read-hidden` do.

**Tests:** `compliance/views-items.test.ts › answers 404 for a view the key cannot read, an item that is not a view and an ID nothing holds`.

### `views/items-revoked`

If a view is revoked, then the server MUST answer `GET /views/{id}/items` with `400 invalid_transition`.

**Tests:** `compliance/views-items.test.ts › refuses a listing of a view whose parent was deleted`.

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
