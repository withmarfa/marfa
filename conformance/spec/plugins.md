# Plugins

A plugin is what an owner adds to Marfa: types under `common.*` or a root of its own, the edge types they use and, optionally, a connector. It arrives as a bundle, one JSON file named `<name>.plugin.json`, which `POST /plugins` installs. The server makes no request of its own to fetch one: the CLI or an app fetches the bundle and sends it (`cli/plugins-install-name`).

A bundle holds `format`, which is 1,, the plugin's identity (`name`, `title`, `description`, `mark`, `maker` and `marfa`, the oldest Marfa release it works with), its `version`, `types` (each a definition as `POST /types` takes it, with its `guidance`), `edge_types` (each as `POST /edge-types` takes it) and an optional `connector` object, which the server keeps with the install record and does not read. `openapi.json` gives each field's shape as `PluginBundle`.

`POST /plugins` judges a bundle in this order and answers the first refusal: the bundle's shape, a type under a reserved root, the Marfa release it needs, the caller's permission, the version installed, a type the plugin did not install, each type's definition, what a newer version narrows, a clash with a type below, and each edge type.

## Installing

### `plugins/install-created`

When a caller holding `schema.write` and write on every type and edge type of a bundle sends `POST /plugins` with a plugin not installed, the server MUST answer `201` with the plugin's `name`, `version`, `title`, `description`, `mark`, `maker`, `marfa`, `types`, `edge_types`, `connector`, `installed_at`, `installed_by`, `updated_at` and `outcome` `installed`.

**Tests:** `compliance/plugins.test.ts › installs a bundle and answers 201 with the plugin, its types and its edge types`.

### `plugins/install-one-write`

If `POST /plugins` would refuse any type or edge type of a bundle, then the server MUST register none of the bundle's types and edge types and keep no install record.

**Reason:** a plugin's types name each other, so half a plugin is a plugin that does not work.

**Tests:** `compliance/plugins.test.ts › registers neither type of a bundle whose second type is refused, though the bundle without it installs`.

### `plugins/install-type-refused`

If `POST /plugins` sends a bundle with a type `POST /types` would refuse for its definition, then the server MUST answer with the status and code that registration answers, with `details.type_id` naming the type.

**Reason:** installing uses the rules of registration, which the CLI shares (`cli/plugins-check-judges`). The types of one bundle are judged together, so they may name each other in any order.

**Tests:** `compliance/plugins.test.ts › registers neither type of a bundle whose second type is refused, though the bundle without it installs`.

### `plugins/install-unknown-key`

If `POST /plugins` sends a bundle with a top-level key outside `format`, `name`, `title`, `description`, `mark`, `maker`, `marfa`, `version`, `types`, `edge_types` and `connector`, then the server MUST answer `400 validation_error` with `details.errors` naming the key.

**Tests:** `compliance/plugins.test.ts › refuses 400 validation_error a bundle with a key it does not hold, a missing field or another format, and keeps a connector object as it is`.

### `plugins/install-shape`

If `POST /plugins` sends a bundle that lacks a field `plugins/install-unknown-key` lists other than `connector`, names a `format` other than 1, or gives a field another shape than `PluginBundle` in `openapi.json`, then the server MUST answer `400 validation_error` with `details.errors` naming each field.

**Tests:** `compliance/plugins.test.ts › refuses 400 validation_error a bundle with a key it does not hold, a missing field or another format, and keeps a connector object as it is`.

### `plugins/install-connector-kept`

When `POST /plugins` installs a bundle with a `connector` object, the server MUST keep the object as the bundle gives it and answer it as `connector`, whatever it holds.

**Reason:** the connector part of a plugin is defined and acted on elsewhere; installing only keeps it.

**Tests:** `compliance/plugins.test.ts › refuses 400 validation_error a bundle with a key it does not hold, a missing field or another format, and keeps a connector object as it is`.

### `plugins/install-reserved-root`

If `POST /plugins` sends a bundle with a type whose identifier starts `core`, `system`, `marfa`, `app` or `user`, then the server MUST answer `403 forbidden` with `details.namespace` naming that root.

**Reason:** `core`, `system` and `marfa` are Marfa's, `app` holds an app's hidden machinery and `user` the owner's own types. A plugin's types sit under `common` or a root of its own.

**Tests:** `compliance/plugins.test.ts › refuses 403 forbidden a bundle with a type under a root kept for Marfa, apps or the owner, naming the namespace`, `› answers the first refusal in order: the bundle's shape before a reserved root, and a reserved root before the permission`.

### `plugins/install-newer-marfa`

While the server runs a release other than `0.0.0`, if `POST /plugins` sends a bundle whose `marfa` is a later release than the server's, then the server MUST answer `409 plugin_needs_newer_server` with `details.marfa` and `details.server`.

**Tests:** waiting on #3421.

### `plugins/install-development-any`

While the server runs the release `0.0.0`, a development build, when `POST /plugins` sends a bundle with any `marfa`, the server MUST install the bundle as it would one whose `marfa` it runs.

**Tests:** `compliance/plugins.test.ts › installs a bundle that names any Marfa on a development build`.

### `plugins/install-permission`

If a caller without `schema.write` sends `POST /plugins`, then the server MUST answer `403 forbidden` with `details.required_scope` `schema.write`.

**Reason:** installing registers and changes types and their guidance, as an owner does, so it takes the owner's schema permission.

**Tests:** `compliance/plugins.test.ts › refuses 403 a key without schema.write, one without write on a type of the bundle, and one without write on an edge type`, `› answers the first refusal in order: the bundle's shape before a reserved root, and a reserved root before the permission`.

### `plugins/install-type-write`

If a caller whose type map does not grant write on a type of the bundle sends `POST /plugins`, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/plugins.test.ts › refuses 403 a key without schema.write, one without write on a type of the bundle, and one without write on an edge type`.

### `plugins/install-edge-write`

If a caller whose edge map does not grant write on an edge type of the bundle sends `POST /plugins`, then the server MUST answer `403 edge_type_not_permitted`.

**Tests:** `compliance/plugins.test.ts › refuses 403 a key without schema.write, one without write on a type of the bundle, and one without write on an edge type`.

### `plugins/install-parent-reach`

If a bundle gives a type a parent outside the bundle that Marfa does not ship and that is not under `common`, and the caller's type map does not grant write on that parent, then the server MUST answer `403 type_not_permitted`.

**Reason:** a plugin's type may build on a common type another plugin installed with no write on it, since installing already takes the owner's schema permission; a parent the owner made stays theirs, as `types/parent-reach` holds for registration.

**Tests:** `compliance/plugins.test.ts › installs a type under another plugin's common type with no write on it, and refuses one under an owner's type`.

### `plugins/install-type-exists`

If a bundle holds a type the instance holds that the same plugin did not install, then the server MUST answer `409 type_exists` with `details.type_id` naming it.

**Tests:** `compliance/plugins.test.ts › refuses 409 type_exists a bundle with a type the plugin did not install`.

### `plugins/install-provenance`

When `POST /plugins` installs or updates a type, the server MUST record the plugin's `name` and `version` as the type's provenance, which a read answers as `types/provenance-read` says.

**Tests:** `compliance/plugins.test.ts › reads a type a plugin installed with origin plugin, naming the plugin and its version`, `› takes a version that adds a field, a status word and an enum value, and reads the new version on its types`.

### `plugins/install-guidance`

When `POST /plugins` installs a type whose definition carries `guidance`, the server MUST store the guidance as the bundle gives it, whichever credential that holds the install's permission sends it.

**Reason:** installing a plugin is how guidance reaches a type, besides the owner (`types/guidance-app-made`).

**Tests:** `compliance/plugins.test.ts › reads a type a plugin installed with origin plugin, naming the plugin and its version`, `› lets an app holding schema.write install a plugin whose types carry guidance`.

### `plugins/install-edge-types`

When `POST /plugins` installs a bundle, the server MUST register each of its edge types the instance does not hold, keep one the instance holds alike, and widen one that differs only by taking more types at its ends.

**Tests:** `compliance/plugins.test.ts › installs a bundle and answers 201 with the plugin, its types and its edge types`.

### `plugins/install-edge-conflict`

If a bundle holds an edge type that Marfa ships, or one the instance holds that differs beyond the types its ends take, then the server MUST answer `409 conflict` with `details.edge_type` naming it.

**Reason:** a plugin names its edge types plainly, and the plugins repository keeps those names from clashing; an edge type registered in another shape is someone else's.

**Tests:** `compliance/plugins.test.ts › refuses 409 conflict an edge type the instance holds in another shape`.

## A newer version

### `plugins/update-same-version`

When `POST /plugins` sends a bundle of the version of the plugin installed, the server MUST answer `200` with the installed plugin and `outcome` `unchanged`, and write nothing.

**Tests:** `compliance/plugins.test.ts › answers 200 unchanged to the same version again, and 409 plugin_version_older to an older one`.

### `plugins/update-older`

If `POST /plugins` sends a bundle of an earlier version than the plugin installed, then the server MUST answer `409 plugin_version_older` with `details.installed` and `details.version`.

**Tests:** `compliance/plugins.test.ts › answers 200 unchanged to the same version again, and 409 plugin_version_older to an older one`.

### `plugins/update-only-adds`

If `POST /plugins` sends a later version of an installed plugin that would remove from a type it installed a field, a status word, an enum value, a table or a column, change a field's kind, lower a limit, raise a minimum, make a field required, change the type's parent, or leave out a type it installed, then the server MUST answer `409 plugin_narrows` with `details.changes` naming each `type` and `path`, and write nothing.

**Reason:** an app or another plugin builds on a published type, so a newer version only adds. The owner can still change the type with `PUT /types/{id}`; installing compares with the type as it is stored.

**Tests:** `compliance/plugins.test.ts › refuses 409 plugin_narrows a version that drops a field or a type, naming each, and keeps the type as installed`.

### `plugins/update-adds`

When `POST /plugins` sends a later version of an installed plugin that only adds fields, status words or enum values to its types, or adds types, the server MUST answer `200` with `outcome` `updated` and replace each type with the bundle's.

**Reason:** a status word or an enum value is a schema change beyond `types/evolve-free`, and installing already holds `schema.write`, the owner's permission for it.

**Tests:** `compliance/plugins.test.ts › takes a version that adds a field, a status word and an enum value, and reads the new version on its types`.

### `plugins/update-child-clash`

If a later version of an installed plugin would give a type a field or a status word that a type below it, outside the bundle, declares in another shape (`types/child-shape`, `types/status-word-redeclared`), then the server MUST answer `409 plugin_child_conflict` with a message naming each such type and `details.conflicts` holding, for each field, its `type`, `field`, `attribute`, `inherited_from`, `inherited` and `declared`, and write nothing.

**Reason:** an owner extends a plugin's type with a child of their own, and an update must not leave that child in conflict. The entry has the shape of `types/conflict-listed` with the child named, so the owner changes or removes the field on the child and installs again.

**Tests:** `compliance/plugins.test.ts › refuses 409 plugin_child_conflict a version that gives a field an owner's child declares in another shape, naming the child`.

## Reading and removing

### `plugins/list`

When a caller sends `GET /plugins`, the server MUST answer `200` with `data` holding each installed plugin by name, as `plugins/install-created` gives it without `outcome`, and `next_cursor` `null`.

**Tests:** `compliance/plugins.test.ts › lists and reads installed plugins, and answers 404 plugin_not_found for one not installed`.

### `plugins/get`

When a caller sends `GET /plugins/{name}` for an installed plugin, the server MUST answer `200` with the plugin as `plugins/list` gives it.

**Tests:** `compliance/plugins.test.ts › lists and reads installed plugins, and answers 404 plugin_not_found for one not installed`.

### `plugins/not-found`

If a caller sends `GET /plugins/{name}` or `DELETE /plugins/{name}` for a name no installed plugin has, then the server MUST answer `404 plugin_not_found`.

**Tests:** `compliance/plugins.test.ts › lists and reads installed plugins, and answers 404 plugin_not_found for one not installed`, `› removes a plugin's record and keeps its types, which keep their provenance, saying what it removed and kept`.

### `plugins/remove-keeps-types`

When a caller holding `schema.write` sends `DELETE /plugins/{name}`, the server MUST remove the plugin's install record, keep every type and edge type it installed with their items, edges and provenance, and answer `200` with `removed` naming its `name` and `version` and `kept` listing the `types` and `edge_types` that stay.

**Reason:** removing a plugin never deletes a type. The owner deletes one with `DELETE /types/{id}`, refused while items or a child type hold it, as for any type.

**Tests:** `compliance/plugins.test.ts › removes a plugin's record and keeps its types, which keep their provenance, saying what it removed and kept`.

### `plugins/remove-permission`

If a caller without `schema.write` sends `DELETE /plugins/{name}`, then the server MUST answer `403 forbidden` with `details.required_scope` `schema.write` and keep the plugin.

**Tests:** `compliance/plugins.test.ts › removes a plugin's record and keeps its types, which keep their provenance, saying what it removed and kept`.
