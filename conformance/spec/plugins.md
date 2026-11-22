# Plugins

A plugin is what an owner adds to Marfa: types under `common.*` or a root of its own, the edge types they use and, optionally, a connector. It arrives as a bundle, one JSON file named `<name>.plugin.json`, which `POST /plugins` installs. The server makes no request of its own to fetch one: the CLI or an app fetches the bundle and sends it (`cli/plugins-install-name`).

A bundle sets `format` to 1 and identifies the plugin by its `name`, `title`, `description`, `mark`, `maker` and `version`. The `marfa` field names the oldest Marfa release it supports. The `types` array holds type definitions with their guidance, and `edge_types` holds edge type definitions. The optional `connector` object describes the plugin's connector: its source, its kinds, its settings, its sign-in and where it runs. `PluginBundle` and `PluginConnector` in `openapi.json` define each field.

`POST /plugins` judges a bundle in this order and answers the first refusal: the bundle's shape, its connector section included, a type under a reserved root, the Marfa release it needs, the caller's permission, a connector without `connectors.manage`, guidance an app sends, the version installed, a newer version's connector source, the connector's source held elsewhere, a type the plugin did not install, a clash with a type below, a parent outside the bundle the caller may not write, each type's definition, what a newer version narrows, each edge type, and each kind's `default_mapping` against the types as installed.

## Installing

### `plugins/install-created`

When a caller holding `schema.write` and write on every type and edge type of a bundle sends `POST /plugins` with a plugin not installed, the server MUST answer `201` with the plugin's `name`, `version`, `title`, `description`, `mark`, `maker`, `marfa`, `types`, `edge_types`, `connector`, `connector_host`, `fingerprint`, `installed_at`, `installed_by`, `updated_at` and `outcome` `installed`.

**Tests:** `compliance/plugins.test.ts › installs a bundle and answers 201 with the plugin, its types and its edge types`.

### `plugins/install-one-write`

If `POST /plugins` would refuse any type or edge type of a bundle, then the server MUST register none of the bundle's types and edge types and keep no install record.

**Reason:** a plugin's types name each other, so half a plugin is a plugin that does not work.

**Tests:** `compliance/plugins.test.ts › registers neither type of a bundle whose second type is refused, though the bundle without it installs`.

### `plugins/install-type-refused`

If `POST /plugins` sends a bundle with a type `POST /types` would refuse for its definition, then the server MUST answer with the status and code that registration answers, with `details.type_id` naming the type.

**Reason:** installing uses the rules of registration, which the CLI shares (`cli/plugins-check-judges`). The types of one bundle are judged together, so they may name each other in any order.

**Tests:** `compliance/plugins.test.ts › registers neither type of a bundle whose second type is refused, though the bundle without it installs`, `› refuses 409 conflict a bundle whose edge type redefines a shipped one, and 400 missing_required_field a type with no fields, as registration does`.

### `plugins/install-unknown-key`

If `POST /plugins` sends a bundle with a top-level key outside `format`, `name`, `title`, `description`, `mark`, `maker`, `marfa`, `version`, `types`, `edge_types` and `connector`, then the server MUST answer `400 validation_error` with `details.errors` naming the key.

**Tests:** `compliance/plugins.test.ts › refuses 400 validation_error a bundle with a key it does not hold, a missing field or another format`.

### `plugins/install-shape`

If `POST /plugins` sends a bundle that lacks a field `plugins/install-unknown-key` lists other than `connector`, names a `format` other than 1, or gives a field another shape than `PluginBundle` in `openapi.json`, then the server MUST answer `400 validation_error` with `details.errors` naming each field.

**Tests:** `compliance/plugins.test.ts › refuses 400 validation_error a bundle with a key it does not hold, a missing field or another format`.

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

If a caller whose edge map does not grant write on the `id` or the `reverse_name` of an edge type of the bundle, or on the reverse name of an edge type the instance holds under that `id`, sends `POST /plugins`, then the server MUST answer `403 edge_type_not_permitted`.

**Reason:** `POST /edge-types` checks both names of an edge type (`edges/types-register-id`), and installing registers edge types as it does.

**Tests:** `compliance/plugins.test.ts › refuses 403 a key without schema.write, one without write on a type of the bundle, and one without write on an edge type`, `› refuses 403 a key without write on an edge type's reverse name, as registering the edge type does`, `› refuses 403 the same or an older version to a key without write on an edge type's stored reverse name`.

### `plugins/install-parent-reach`

If a bundle gives a type a parent outside the bundle that Marfa does not ship and that is not under `common`, and the caller's type map does not grant write on that parent, then the server MUST answer `403 type_not_permitted`.

**Reason:** a plugin's type may build on a common type another plugin installed with no write on it, since installing already takes the owner's schema permission; a parent the owner made stays theirs, as `types/parent-reach` holds for registration.

**Tests:** `compliance/plugins.test.ts › installs a type under another plugin's common type with no write on it, and refuses one under an owner's type`.

### `plugins/install-type-exists`

If a bundle holds a type the instance holds that the same plugin did not install, then the server MUST answer `409 type_exists` with `details.type_id` naming it.

**Tests:** `compliance/plugins.test.ts › refuses 409 type_exists a bundle with a type the plugin did not install`.

### `plugins/install-provenance`

When `POST /plugins` installs or updates a type, the server MUST record the plugin's `name` and `version` as the type's provenance, which a read answers as `types/provenance-read` says.

**Tests:** `compliance/plugins.test.ts › reads a type a plugin installed with origin plugin, naming the plugin and its version`, `› takes a version that adds a field and an enum value, and reads the new version on its types`.

### `plugins/install-guidance`

When a caller that is neither an app's access token, a key an app made nor a key of unknown maker (`keys-and-oauth/unknown-maker`) sends `POST /plugins` with a type whose definition carries `guidance`, the server MUST store the guidance as the bundle gives it.

**Reason:** installing a plugin is the owner's way to give a type guidance, besides writing it directly (`types/guidance-app-made`).

**Tests:** `compliance/plugins.test.ts › reads a type a plugin installed with origin plugin, naming the plugin and its version`.

### `plugins/install-guidance-app`

If an app's access token, a key an app made or a key of unknown maker (`keys-and-oauth/unknown-maker`) sends `POST /plugins` with a bundle whose types carry `guidance`, or a later version that would change or remove a type's `guidance`, then the server MUST answer `403 forbidden` with `details.changes` listing `guidance` and write nothing.

**Reason:** installing is an owner action, and an app may not write guidance by any door (`types/guidance-app-made`). The same app installs the same plugin without guidance.

**Tests:** `compliance/plugins.test.ts › refuses 403 an app installing a plugin whose types carry guidance, and installs the same plugin without it`, `› refuses an app's newer version that would remove guidance the owner's install wrote`, `› refuses guidance to an owner's key an app minted, on registration and on install, and takes both without it`.

### `plugins/install-connector-permission`

If a caller without `connectors.manage` sends `POST /plugins` with a bundle that has a `connector` object, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage`, and write nothing.

**Reason:** a connector reaches outside the instance on the owner's behalf, which `connectors.manage` grants; installing types alone keeps needing `schema.write`. Any credential holding both may install it.

**Tests:** `compliance/plugins.test.ts › refuses 403 a bundle with a connector to a key without connectors.manage, which installs the same bundle without one, and takes it with both, recording the SHA-256 of the bytes sent`.

### `plugins/install-fingerprint`

When `POST /plugins` installs or updates a plugin, the server MUST record as its `fingerprint` the SHA-256 of the request body's bytes as received, in lowercase hexadecimal, and answer it as `fingerprint` from `POST /plugins`, `GET /plugins` and `GET /plugins/{name}`.

**Reason:** a connector host checks later that the bundle it runs is the one installed. The digest is of the bytes the server received, so it equals another digest only of the same bytes.

**Tests:** `compliance/plugins.test.ts › refuses 403 a bundle with a connector to a key without connectors.manage, which installs the same bundle without one, and takes it with both, recording the SHA-256 of the bytes sent`, `› keeps plugin provenance and the install record through an export and a restore`.

### `plugins/install-edge-types`

When `POST /plugins` installs a bundle, the server MUST register each of its edge types the instance does not hold, keep one the instance holds alike, and widen one that differs only by taking more types at its ends.

**Tests:** `compliance/plugins.test.ts › installs a bundle and answers 201 with the plugin, its types and its edge types`.

### `plugins/install-edge-conflict`

If a bundle holds an edge type that Marfa ships, one whose `id` or `reverse_name` another edge type holds as a name, or one the instance holds that differs beyond the types its ends take, its `label` and `reverse_label` included, then the server MUST answer `409 conflict` with `details.edge_type` naming it.

**Reason:** a plugin names its edge types plainly, and the plugins repository keeps those names from clashing; an edge type registered in another shape, or under other labels, is someone else's.

**Tests:** `compliance/plugins.test.ts › refuses 409 conflict an edge type the instance holds in another shape`, `› refuses 409 conflict a bundle whose edge type redefines a shipped one, and 400 missing_required_field a type with no fields, as registration does`, `› refuses 409 conflict a bundle that changes the label of an edge type another source registered, and takes it with the labels as registered`.

### `plugins/install-edge-refused`

If a bundle holds an edge type `POST /edge-types` would refuse for its definition, such as an identifier outside the edge type grammar or a key it does not read, then the server MUST answer with the status and code that registration answers, with `details.edge_type` naming it.

**Reason:** installing, registration and `marfa plugins check` judge an edge type by the same rules (`cli/plugins-check-judges`).

**Tests:** `device/plugins-check.test.ts › refuses an edge type that redefines a shipped one, or names a shipped edge as its reverse, as installing does`.

## A plugin's connector

A plugin's connector is described by the bundle's `connector` object and recorded when the plugin is installed. Its `source` is the source the connector writes under, which belongs to the plugin from then on: one source has one connector.

### `plugins/connector-shape`

If `POST /plugins` sends a bundle whose `connector` object lacks a field `PluginConnector` in `openapi.json` requires, holds a key it does not define at any level, or gives a field another shape than it defines, then the server MUST answer `400 validation_error` with `details.errors` naming the path of each, such as `connector.kinds` or `connector.runs.where`.

**Reason:** a field the server does not read is one a connector host would act on without the owner's knowing, so a later field is a change to the contract, not something a bundle adds.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing`.

### `plugins/connector-source`

If a bundle's `connector.source` has Unicode `White_Space` at either end, is empty, is longer than 200 characters, is `.` or `..`, or, ignoring case, starts with `oauth:`, `restored:` or `connector-host:`, then the server MUST answer `400 validation_error` with `details.errors` naming `connector.source`.

**Reason:** the connector's key holds the source as its own, so it follows the rules a key's source follows (`keys-and-oauth/claims-reserved`).

**Tests:** `compliance/plugin-connectors.test.ts › refuses a source a key could not hold, two kinds or settings of one name, and a default that does not fit its kind`.

### `plugins/connector-kind-type`

If a kind in a bundle's `connector.kinds` names as its `type` an identifier that is not the `id` of one of the bundle's `types`, then the server MUST answer `400 validation_error` with `details.errors` naming the kind's `type`.

**Reason:** a kind is what the connector brings, written as the plugin's own type; a type the plugin does not bring is mapped to, not brought.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing`.

### `plugins/connector-names-unique`

If two kinds of a bundle's connector share a `name`, or two of its settings share a `name`, then the server MUST answer `400 validation_error` with `details.errors` naming the second.

**Tests:** `compliance/plugin-connectors.test.ts › refuses a source a key could not hold, two kinds or settings of one name, and a default that does not fit its kind`.

### `plugins/connector-setting-default`

If a setting of a bundle's connector gives a `default` that is not of its `kind`, is not one of its `choices`, or is given for a setting whose `secret` is `true`, then the server MUST answer `400 validation_error` with `details.errors` naming the setting's `default`.

**Reason:** a secret is set by the owner and never shipped in a bundle, which anyone can read.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing`, `› refuses a source a key could not hold, two kinds or settings of one name, and a default that does not fit its kind`.

### `plugins/connector-setting-secret-text`

If a setting of a bundle's connector whose `secret` is `true` has a `kind` other than `text`, then the server MUST answer `400 validation_error` with `details.errors` naming the setting's `secret`.

**Reason:** a secret is a credential the owner pastes in, which the command line reads as text from standard input (`cli/plugins-secret-stdin`), so a secret of another kind could never be set.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a secret setting of a kind other than text, naming its secret, and installs the same setting as text`.

### `plugins/connector-setting-choices`

If a setting of a bundle's connector of `kind` `choice` gives no `choices`, or a setting of another `kind` gives `choices`, then the server MUST answer `400 validation_error` with `details.errors` naming the setting's `choices`.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing`.

### `plugins/connector-sign-in`

If a bundle's `connector.sign_in` names in `client_id_setting`, `client_secret_setting` or `token_setting` a setting the connector does not declare, or names in `client_secret_setting` or `token_setting` a setting whose `secret` is not `true`, then the server MUST answer `400 validation_error` with `details.errors` naming that field of `connector.sign_in`.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing`.

### `plugins/connector-default-mapping`

If a kind in a bundle's `connector.kinds` gives a `default_mapping` that holds a member other than `tier`, `status_overrides` and `fields`, or that `PUT /plugins/{name}/connector/mapping` would refuse as the kind's entry with its own type as `target_type`, then the server MUST answer `400 validation_error` with `details.errors` naming each fault as a `path` under `connector.kinds.<index>.default_mapping`.

**Reason:** a default lands a kind on its own type, where the key's type map alone decides what the connector writes (`plugins/reach-own-types`). A default the server takes is the one it answers, gives tiers by and reaches by, so the three never disagree.

**Tests:** `compliance/connector-mapping.test.ts › refuses at install a default_mapping that names a target type, enabled or a member a kind's mapping does not hold, or a field its own type refuses, naming each path`.

### `plugins/connector-refused-nothing`

If `POST /plugins` refuses a bundle for its connector section, then the server MUST register none of its types and keep no install record.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing`.

### `plugins/connector-kept`

When `POST /plugins` installs a bundle with a `connector` object, the server MUST answer the object as the bundle gives it as `connector` from `POST /plugins`, `GET /plugins` and `GET /plugins/{name}`.

**Tests:** `compliance/plugin-connectors.test.ts › installs a bundle with a well-formed connector, keeps the section as sent and records the connector with no host`.

### `plugins/connector-recorded`

When `POST /plugins` installs a plugin with a connector, the server MUST record the connector with no host, so that the plugin reads `connector_host` `null` and no connector host lists it.

**Tests:** `compliance/plugin-connectors.test.ts › installs a bundle with a well-formed connector, keeps the section as sent and records the connector with no host`.

### `plugins/connector-host-field`

The server MUST answer a plugin's `connector_host` as the `id` of the connector host its connector is assigned to, or `null` for a plugin with no connector or a connector assigned to no host.

**Tests:** `compliance/plugin-connectors.test.ts › installs a bundle with a well-formed connector, keeps the section as sent and records the connector with no host`, `compliance/connector-hosts.test.ts › answers a host only the connectors assigned to it, and records when it was last seen`.

### `plugins/connector-source-plugin`

If `POST /plugins` sends a bundle whose `connector.source` is the source of another installed plugin's connector, and the plugin is not installed or its installed version has no connector, then the server MUST answer `409 connector_source_held` with `details.source` and `details.plugin` naming the plugin that holds it.

**Reason:** a source is where a connector keeps its state and writes its items, so two connectors under one source would write over each other.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 409 connector_source_held a second plugin with the same source, naming the plugin that holds it`.

### `plugins/connector-source-registered`

If `POST /plugins` sends a bundle whose `connector.source` a connector registration has as its source, and the plugin is not installed or its installed version has no connector, then the server MUST answer `409 connector_source_held` with `details.source` and `details.connector_id` naming the registration.

**Reason:** the owner removes the registration with `DELETE /connectors/{id}`, which keeps the source's state and agreements (`connectors/delete-keeps-state`) for the plugin's connector to take up.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 409 connector_source_held a source a live key holds, naming its registration, and installs once the registration is gone`.

### `plugins/connector-source-key`

If `POST /plugins` sends a bundle whose `connector.source` a live key holds as its own source or claims, no connector registration has that source, and the plugin is not installed or its installed version has no connector, then the server MUST answer `409 connector_source_held` with `details.source` and `details.key_id` naming the oldest such key.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 409 connector_source_held a source a live key holds, naming its registration, and installs once the registration is gone`.

### `plugins/connector-source-same`

If `POST /plugins` sends a later version of an installed plugin with a connector whose `connector.source` differs from the installed version's, or that has no `connector`, then the server MUST answer `409 plugin_narrows` with `details.changes` holding an entry whose `path` is `connector.source` or `connector`, and write nothing.

**Reason:** the source holds the connector's state, items and key, so a newer version keeps it, as it keeps every published type.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 409 plugin_narrows a newer version that changes the connector's source or drops the connector, and takes one that keeps it`.

### `plugins/connector-update-keeps`

When `POST /plugins` updates a plugin whose connector keeps its source, the server MUST keep the connector's host and the key its host minted.

**Tests:** `compliance/connector-hosts.test.ts › keeps a connector's host and key through a newer version of its plugin`.

## A newer version

### `plugins/update-same-version`

When `POST /plugins` sends a bundle of the version of the plugin installed, the server MUST answer `200` with the installed plugin and `outcome` `unchanged`, and write nothing.

**Tests:** `compliance/plugins.test.ts › answers 200 unchanged to the same version again, and 409 plugin_version_older to an older one`.

### `plugins/update-older`

If `POST /plugins` sends a bundle of an earlier version than the plugin installed, then the server MUST answer `409 plugin_version_older` with `details.installed` and `details.version`.

**Tests:** `compliance/plugins.test.ts › answers 200 unchanged to the same version again, and 409 plugin_version_older to an older one`.

### `plugins/update-only-adds`

If `POST /plugins` sends a later version of an installed plugin that, compared with the bundle of the version installed or with the type as stored, would remove a field, a list member, a status word, an enum value, a table or a column, move a status word to another group, change a field's, member's or column's kind, lower a limit or raise a minimum anywhere, take fewer types at an item field or column, make a field, member or column required or add one as required, change a type's parent, or leave out a type the version installed published, then the server MUST answer `409 plugin_narrows` with `details.changes` naming each `type` and `path`, and write nothing.

**Reason:** an app or another plugin builds on a published type, so a newer version only adds. A field is required when the type's `required` list names it or the field sets `required`, so moving the requirement between the two narrows nothing. The version installed is what was published, so a type it held stays refused to drop even after the owner deletes it. The owner can still change a type with `PUT /types/{id}`, and installing protects that change too by comparing with the type as stored.

**Tests:** `compliance/plugins.test.ts › refuses 409 plugin_narrows a version that drops a field or a type, naming each, and keeps the type as installed`, `› refuses 409 plugin_narrows a version that adds a required field, makes a list member required, lowers a table column's limit or moves a status word to another group`, `› refuses 409 plugin_narrows a version that drops a type the owner already deleted, naming it`, `› takes a version that moves a requirement from the type's required list to the field`.

### `plugins/update-adds`

When `POST /plugins` sends a later version of an installed plugin that only adds optional fields, list members, columns, status words or enum values to its types, widens a limit, or adds types, the server MUST answer `200` with `outcome` `updated` and replace each type with the bundle's.

**Reason:** a status word or an enum value is a schema change beyond `types/evolve-free`, and installing already holds `schema.write`, the owner's permission for it.

**Tests:** `compliance/plugins.test.ts › takes a version that adds a field and an enum value, and reads the new version on its types`, `› takes a version that adds a field, a status word, an enum value and an optional list member`.

### `plugins/update-child-clash`

If a later version of an installed plugin would give a type a field or a status word that a type below it, outside the bundle, declares in another shape (`types/child-shape`, `types/status-word-redeclared`), and that type below did not already conflict so, then the server MUST answer `409 plugin_child_conflict` with a message naming each such type and `details.conflicts` holding, for each field, its `type`, `field`, `attribute`, `inherited_from` naming the type above that declares the field or the status word, `inherited` and `declared`, and write nothing.

**Reason:** an owner extends a plugin's type with a child of their own, and an update must not leave that child in conflict. The entry has the shape of `types/conflict-listed` with the child named, so the owner changes or removes the field on the child and installs again.

**Tests:** `compliance/plugins.test.ts › refuses 409 plugin_child_conflict a version that gives a field an owner's child declares in another shape, naming the child`, `› names the type that declared a status word when a newer version adds it to a type two generations above an owner's type that declares it`.

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

When a caller holding `schema.write` sends `DELETE /plugins/{name}`, the server MUST remove the plugin's install record, keep every type and edge type it installed with their items, edges and provenance, and answer `200` with `removed` naming its `name` and `version` and `kept` listing the `types` from the plugin and the `edge_types` any of its installed versions brought that the instance holds.

**Reason:** removing a plugin never deletes a type. The owner deletes one with `DELETE /types/{id}`, refused while items or a child type hold it, as for any type, so an edge type or type the owner already deleted is not listed.

**Tests:** `compliance/plugins.test.ts › removes a plugin's record and keeps its types, which keep their provenance, saying what it removed and kept`, `› reports as kept only the edge types the instance still holds`, `› keeps reporting an edge type a newer version omits, through an export, a restore and the removal`.

### `plugins/remove-permission`

If a caller without `schema.write` sends `DELETE /plugins/{name}`, then the server MUST answer `403 forbidden` with `details.required_scope` `schema.write` and keep the plugin.

**Tests:** `compliance/plugins.test.ts › removes a plugin's record and keeps its types, which keep their provenance, saying what it removed and kept`.

### `plugins/remove-connector-permission`

If a caller without `connectors.manage` sends `DELETE /plugins/{name}` for a plugin with a connector, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage` and keep the plugin.

**Reason:** removing the plugin stops its connector, which `connectors.manage` administers. A caller with `schema.write` alone removes a plugin with no connector.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 403 removing a plugin with a connector to a key without connectors.manage, and keeps it`.

### `plugins/remove-connector-key`

When the server removes a plugin with a connector, the server MUST revoke the key its connector host minted for the connector in the same write.

**Tests:** `compliance/plugin-connectors.test.ts › removes a plugin's connector: revokes its key, removes its registration and record, keeps its types, items, state and agreements, and says which`.

### `plugins/remove-connector-registration`

When the server removes a plugin with a connector, the server MUST delete in the same write every connector registration whose source is the connector's, as `DELETE /connectors/{id}` deletes one, with its runs, its hold and its inbound endpoints.

**Tests:** `compliance/plugin-connectors.test.ts › removes a plugin's connector: revokes its key, removes its registration and record, keeps its types, items, state and agreements, and says which`.

### `plugins/remove-connector-keeps`

When the server removes a plugin with a connector, the server MUST keep the state document and the agreements of the connector's source and the items written under it.

**Reason:** they belong to the source, as `connectors/delete-keeps-state` keeps them, so the plugin installed again takes them up.

**Tests:** `compliance/plugin-connectors.test.ts › removes a plugin's connector: revokes its key, removes its registration and record, keeps its types, items, state and agreements, and says which`.

### `plugins/remove-connector-answer`

When the server removes a plugin with a connector, the server MUST answer `removed.connector` with its `source`, the `key_id` of the key it revoked or `null`, and `registrations` listing the `id` of each registration it deleted, and `kept.connector` with its `source`, `state` saying whether the source keeps a state document and `agreements` counting its agreements.

**Reason:** an app's removal sheet shows what goes and what stays.

**Tests:** `compliance/plugin-connectors.test.ts › removes a plugin's connector: revokes its key, removes its registration and record, keeps its types, items, state and agreements, and says which`.

### `plugins/remove-no-connector`

When the server removes a plugin with no connector, the server MUST answer `removed.connector` and `kept.connector` as `null`.

**Tests:** `compliance/plugins.test.ts › removes a plugin's record and keeps its types, which keep their provenance, saying what it removed and kept`.

## Archive

### `plugins/restore-connector`

When `POST /restore` restores a plugin with a connector that the instance does not hold, the server MUST record its connector with no host and no key.

**Reason:** a host, its link and every key it holds belong to the machine and the instance they were made on, so none travels in an archive.

**Tests:** `compliance/plugin-connectors.test.ts › restores a plugin with a connector with its record and no host or key`.

### `plugins/restore-default-mapping`

If `POST /restore` would restore a plugin whose connector names a `default_mapping` that `plugins/connector-default-mapping` refuses, judged against the types as restored, then the server MUST answer `400 validation_error` with `details.entry` `instance.ndjson.gz` and `details.line` naming the plugin's line, and restore nothing.

**Reason:** a restored plugin's default is the mapping its connector's key reaches by until the owner saves one, so it is judged as installing judges it.

**Tests:** `compliance/connector-mapping.test.ts › refuses a restore whose plugin's default_mapping installing would refuse, naming its line, and restores nothing`.

### `plugins/restore-connector-held`

If `POST /restore` would restore a plugin with a connector whose source another installed plugin's connector or a live key on the instance holds, then the server MUST answer `409 connector_source_held` with `details.source` and restore nothing.

**Tests:** `compliance/plugin-connectors.test.ts › restores a plugin with a connector with its record and no host or key`.

### `plugins/restore-connector-permission`

If an app's access token that `keys-and-oauth/step-up-recent` admits to `POST /restore` or `POST /backups/{instance_id}/{name}/restore`, and that does not hold `connectors.manage`, sends that restore for an archive that would keep the install record of a plugin with a connector the instance has no record of, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage` and `details.plugins` naming each such plugin.

**Reason:** installing a plugin with a connector needs `connectors.manage` (`plugins/install-connector-permission`), and a restore is not a way around it.

**Tests:** `compliance/connector-settings.test.ts › refuses an app without connectors.manage an archive that would restore a plugin with a connector, writing nothing, which an app holding it restores`.

### `plugins/restore-connector-permission-unwritten`

When the server refuses a restore under `plugins/restore-connector-permission` or `archive/restore-connector-settings-permission`, the server MUST write none of the archive's items, files, plugins and settings.

**Tests:** `compliance/connector-settings.test.ts › refuses an app without connectors.manage an archive that would restore a plugin with a connector, writing nothing, which an app holding it restores`, `› refuses an app without connectors.manage an archive that would store a connector's settings and a secret to set again, writing nothing, which an app holding it restores`.

## Connector hosts

A connector host is one machine that runs connectors. The owner makes a host and links it once with a one-time link; the host then holds a key of its own and mints a key for each connector assigned to it. Every door in this section but `POST /connector-hosts/redeem` and the two under `/connector-hosts/self` needs `connectors.manage`.

The doors judge in this order and answer the first refusal. `POST /connector-hosts`: the caller's permission, then the body. `GET /connector-hosts/{id}`, `POST /connector-hosts/{id}/link` and `DELETE /connector-hosts/{id}`: the caller's permission, then the host. `PUT /plugins/{name}/connector`: the caller's permission, the body, the plugin, its connector, then the host. `POST /connector-hosts/redeem`: the rate limit, the instance `X-Marfa-Instance-Id` names, the body, then the code. `GET /connector-hosts/self` and `POST /connector-hosts/self/connectors/{plugin}/key`: the credential, then the plugin.

### `plugins/host-create`

When a caller holding `connectors.manage` sends `POST /connector-hosts` with a `name`, the server MUST answer `201` with `host`, holding the host as `plugins/host-read` gives it, and the one-time link as `link`, `code` and `expires_at`.

**Tests:** `compliance/connector-hosts.test.ts › makes a host and a one-time link that answers the code once, in the link's fragment, for 15 minutes`.

### `plugins/host-name`

If `POST /connector-hosts` names no `name`, or a `name` that is not text of 1 to 100 characters once trimmed, then the server MUST answer `400 validation_error` with `details.errors` naming `name`.

**Tests:** `compliance/connector-hosts.test.ts › makes a host and a one-time link that answers the code once, in the link's fragment, for 15 minutes`.

### `plugins/host-permission`

If a caller without `connectors.manage` sends `POST /connector-hosts`, `GET /connector-hosts`, `GET /connector-hosts/{id}`, `POST /connector-hosts/{id}/link`, `DELETE /connector-hosts/{id}` or `PUT /plugins/{name}/connector`, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage` and change nothing.

**Tests:** `compliance/connector-hosts.test.ts › refuses 403 every host door to a key without connectors.manage`.

### `plugins/host-not-found`

If a caller sends `GET /connector-hosts/{id}`, `POST /connector-hosts/{id}/link` or `DELETE /connector-hosts/{id}` for an id no connector host has, or `PUT /plugins/{name}/connector` naming such an id as `host`, then the server MUST answer `404 connector_host_not_found`.

**Tests:** `compliance/connector-hosts.test.ts › lists and reads hosts with their connectors, and answers 404 connector_host_not_found for one that does not exist`, `› refuses 404 assigning a plugin with no connector or a host that does not exist`.

### `plugins/host-read`

When a caller holding `connectors.manage` sends `GET /connector-hosts/{id}`, the server MUST answer `200` with the host's `id`, `name`, `created_at`, `updated_at`, `last_seen_at`, `linked` saying whether it holds a live key, `link_expires_at` naming when its unredeemed link ends or `null`, and `connectors` listing each assigned plugin's `plugin`, `version` and `key_minted`.

**Tests:** `compliance/connector-hosts.test.ts › lists and reads hosts with their connectors, and answers 404 connector_host_not_found for one that does not exist`.

### `plugins/host-list`

When a caller holding `connectors.manage` sends `GET /connector-hosts`, the server MUST answer `200` with `data` holding every host as `plugins/host-read` gives it, oldest first, and `next_cursor` `null`.

**Tests:** `compliance/connector-hosts.test.ts › lists and reads hosts with their connectors, and answers 404 connector_host_not_found for one that does not exist`.

### `plugins/host-last-seen`

When a host's key sends `GET /connector-hosts/self`, the server MUST record the time as the host's `last_seen_at`.

**Tests:** `compliance/connector-hosts.test.ts › answers a host only the connectors assigned to it, and records when it was last seen`.

## One-time links

### `plugins/link-form`

When the server answers a one-time link, the server MUST answer `link` as the origin of the instance's sign-in address followed by `/connect#` and the `code`.

**Reason:** a fragment reaches no server, so the code is in no access log of a proxy the link passes. The host program reads the instance and the code from the link, or the CLI builds it from the `code`.

**Tests:** `compliance/connector-hosts.test.ts › makes a host and a one-time link that answers the code once, in the link's fragment, for 15 minutes`.

### `plugins/link-life`

When the server makes a one-time link, the server MUST answer `expires_at` 15 minutes after it made the link.

**Tests:** `compliance/connector-hosts.test.ts › makes a host and a one-time link that answers the code once, in the link's fragment, for 15 minutes`.

### `plugins/link-answered-once`

The server MUST NOT answer a one-time link's `code` again in any answer after the one that made the link.

**Reason:** the server keeps only a digest of the code.

**Tests:** `compliance/connector-hosts.test.ts › makes a host and a one-time link that answers the code once, in the link's fragment, for 15 minutes`.

### `plugins/link-fresh`

When a caller holding `connectors.manage` sends `POST /connector-hosts/{id}/link`, the server MUST answer `200` with `host` and a new one-time link as `link`, `code` and `expires_at`.

**Reason:** a fresh link moves a host to a new machine.

**Tests:** `compliance/connector-hosts.test.ts › revokes the host's old key when a fresh link is redeemed`.

### `plugins/link-replaces`

When the server makes a one-time link for a host, the server MUST end the host's unredeemed link, so that its code redeems nothing.

**Tests:** `compliance/connector-hosts.test.ts › answers 404 connector_link_not_found to an expired code, a code whose host was removed, a replaced code and a made-up one, and mints nothing`.

### `plugins/redeem`

When a request with no credential sends `POST /connector-hosts/redeem` with the `code` of a one-time link that has not ended, the server MUST answer `201` with `host` holding the host's `id` and `name`, the host's new key as `key` and its id as `key_id`.

**Tests:** `compliance/connector-hosts.test.ts › redeems a link once, minting a key that holds connectors.host alone, and answers 404 connector_link_not_found to a second use and nothing else minted`.

### `plugins/redeem-once`

If `POST /connector-hosts/redeem` sends the code of a link already redeemed, then the server MUST answer `404 connector_link_not_found`.

**Tests:** `compliance/connector-hosts.test.ts › redeems a link once, minting a key that holds connectors.host alone, and answers 404 connector_link_not_found to a second use and nothing else minted`.

### `plugins/redeem-refused`

If `POST /connector-hosts/redeem` sends a code past its `expires_at`, the code of a link whose host was removed or that a fresh link replaced, or a code the server never made, then the server MUST answer `404 connector_link_not_found`.

**Reason:** one answer for every code that does not redeem, so a guess learns nothing of the codes the server made.

**Tests:** `compliance/connector-hosts.test.ts › answers 404 connector_link_not_found to an expired code, a code whose host was removed, a replaced code and a made-up one, and mints nothing`.

### `plugins/redeem-refused-nothing`

If the server refuses `POST /connector-hosts/redeem`, then the server MUST mint no key and leave every host as it was.

**Tests:** `compliance/connector-hosts.test.ts › redeems a link once, minting a key that holds connectors.host alone, and answers 404 connector_link_not_found to a second use and nothing else minted`, `› answers 404 connector_link_not_found to an expired code, a code whose host was removed, a replaced code and a made-up one, and mints nothing`.

### `plugins/redeem-body`

If `POST /connector-hosts/redeem` names no `code`, or a `code` that is not text, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-hosts.test.ts › answers 404 connector_link_not_found to an expired code, a code whose host was removed, a replaced code and a made-up one, and mints nothing`.

### `plugins/redeem-replaces-key`

When `POST /connector-hosts/redeem` redeems a link for a host that holds a live key, the server MUST revoke that key in the same write.

**Tests:** `compliance/connector-hosts.test.ts › revokes the host's old key when a fresh link is redeemed`.

### `plugins/redeem-rate`

Where the limiter is on, when the requests to `POST /connector-hosts/redeem` from one address pass 10 within 15 minutes, the server MUST answer each further request in that window `429 rate_limited`.

**Reason:** the door takes no credential, so it is held to the caller's address as the device grant's code lookup is.

**Tests:** `compliance/connector-hosts.test.ts › refuses 429 rate_limited redemptions from one address past ten in fifteen minutes`.

## A host's key

### `plugins/host-key-holds`

When `POST /connector-hosts/redeem` mints a host's key, the server MUST give it the permission `connectors.host` alone, no entry in any map, no claimed source, and as its own source `connector-host:` followed by the host's `id`.

**Reason:** the key reaches only its own host's doors, and the source names the host where a key is listed.

**Tests:** `compliance/connector-hosts.test.ts › redeems a link once, minting a key that holds connectors.host alone, and answers 404 connector_link_not_found to a second use and nothing else minted`.

### `plugins/host-key-only-own-doors`

If a host's key sends a request to an operation other than `GET /connector-hosts/self` and `POST /connector-hosts/self/connectors/{plugin}/key`, then the server MUST answer `401 unauthorized`, as to a request with no credential.

**Reason:** a host is a machine the owner may not watch, so its key cannot act as the owner or an app, whatever a door's own rule would allow. Every other door takes it for no credential, as a door group that does not take a credential does.

**Tests:** `compliance/connector-hosts.test.ts › refuses the host's key 401 on every door but its own, and its own doors 403 to every other credential`.

### `plugins/host-doors-host-only`

If a credential other than a host's key sends `GET /connector-hosts/self` or `POST /connector-hosts/self/connectors/{plugin}/key`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/connector-hosts.test.ts › refuses the host's key 401 on every door but its own, and its own doors 403 to every other credential`.

### `plugins/host-self`

When a host's key sends `GET /connector-hosts/self`, the server MUST answer `200` with the host's `id` and `name`, and `connectors` listing, for each plugin whose connector is assigned to the host, its `plugin`, `version`, `fingerprint`, its connector section as `connector`, `registration_id` naming the registration the connector's current key made or `null`, and `key_minted`.

**Tests:** `compliance/connector-hosts.test.ts › answers a host only the connectors assigned to it, and records when it was last seen`.

### `plugins/host-mint`

When a host's key sends `POST /connector-hosts/self/connectors/{plugin}/key` for a plugin whose connector is assigned to the host, the server MUST answer `201` with `plugin`, the new key as `key`, its id as `key_id` and its `source`.

**Tests:** `compliance/connector-hosts.test.ts › mints a connector key with the manifest's source and write on its kinds' types, which registers itself and writes its types`.

### `plugins/host-mint-holds`

When the server mints a connector's key for its host, the server MUST give the key the connector's `source` as its own source, no permission, write on the type of each of the connector's kinds and no other entry in any map, no claimed source, and `default_tier` `feed`.

**Reason:** the key holds what a connector's own key held when it registered itself, and its types are already installed by the plugin.

**Tests:** `compliance/connector-hosts.test.ts › mints a connector key with the manifest's source and write on its kinds' types, which registers itself and writes its types`.

### `plugins/host-mint-revokes`

When the server mints a connector's key for its host, the server MUST revoke in the same write the key it minted for that connector before.

**Reason:** the source is unique among live keys, and the new key registers itself as `connectors/register-successor` says.

**Tests:** `compliance/connector-hosts.test.ts › revokes the connector key a host minted when it mints again, and when the connector moves to another host or is unassigned`.

### `plugins/host-mint-unassigned`

If a host's key sends `POST /connector-hosts/self/connectors/{plugin}/key` for a plugin that is not installed or whose connector is not assigned to the host, then the server MUST answer `404 plugin_not_found` and mint nothing.

**Tests:** `compliance/connector-hosts.test.ts › answers 404 plugin_not_found to a host minting for a plugin not assigned to it`.

## Assigning a connector

### `plugins/assign`

When a caller holding `connectors.manage` sends `PUT /plugins/{name}/connector` with `host` naming a connector host's `id`, or `null`, the server MUST assign the plugin's connector to that host, or to none, and answer `200` with `plugin`, `source`, `host` and `key_minted`.

**Tests:** `compliance/connector-hosts.test.ts › answers a host only the connectors assigned to it, and records when it was last seen`.

### `plugins/assign-revokes`

When `PUT /plugins/{name}/connector` moves a connector to another host or to none, the server MUST revoke in the same write the key its former host minted for it.

**Tests:** `compliance/connector-hosts.test.ts › revokes the connector key a host minted when it mints again, and when the connector moves to another host or is unassigned`.

### `plugins/assign-same`

When `PUT /plugins/{name}/connector` names the host the connector is already assigned to, the server MUST keep the key that host minted for it.

**Tests:** `compliance/connector-hosts.test.ts › revokes the connector key a host minted when it mints again, and when the connector moves to another host or is unassigned`.

### `plugins/assign-no-connector`

If a caller sends `PUT /plugins/{name}/connector` for an installed plugin with no connector, then the server MUST answer `404 connector_not_found` with `details.plugin`.

**Tests:** `compliance/connector-hosts.test.ts › refuses 404 assigning a plugin with no connector or a host that does not exist`.

### `plugins/assign-body`

If `PUT /plugins/{name}/connector` names no `host`, or a `host` that is neither text nor `null`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-hosts.test.ts › refuses 404 assigning a plugin with no connector or a host that does not exist`.

## A connector's settings

Each setting a plugin's connector section declares holds the value the owner sets, or its `default` while none is set. A secret setting's value is sealed, never answered to the owner, and read only by the connector's own key (`connectors/settings-read`).

`GET /plugins/{name}/connector/settings` judges the caller's permission, the plugin, then its connector. `PATCH /plugins/{name}/connector/settings` judges the caller's permission, the body, the plugin, its connector, then each setting the body names.

### `plugins/settings-list`

When a caller holding `connectors.manage` sends `GET /plugins/{name}/connector/settings` for a plugin with a connector, the server MUST answer `200` with `plugin`, `settings` holding an entry for each setting the connector declares, in the order it declares them, with its `name`, `label`, `kind`, `choices`, `secret`, `required`, `default`, `value`, `set` and `unreadable`, and `missing`.

**Tests:** `compliance/connector-settings.test.ts › lists each declared setting with its default, sets values of each kind, clears one with null, and names a required setting with no value as missing`.

### `plugins/settings-value`

When the server answers a setting of a plugin's connector that is not secret, the server MUST answer `value` as the value set for it, or its `default` while none is set, and `set` saying whether a value is set.

**Tests:** `compliance/connector-settings.test.ts › lists each declared setting with its default, sets values of each kind, clears one with null, and names a required setting with no value as missing`.

### `plugins/settings-secret-listed`

When the server answers a secret setting of a plugin's connector to `GET /plugins/{name}/connector/settings` or `PATCH /plugins/{name}/connector/settings`, the server MUST answer `value` and `default` as `null`, and `set` saying whether a value the server can open is set.

**Tests:** `compliance/connector-settings.test.ts › lists each declared setting with its default, sets values of each kind, clears one with null, and names a required setting with no value as missing`.

### `plugins/settings-missing`

When the server answers the settings of a plugin's connector, the server MUST answer `missing` naming each setting whose `required` is `true` that has no value set it can read and no `default`, in the order the connector declares them.

**Reason:** a connector told a required setting is missing says so to its owner rather than run without it.

**Tests:** `compliance/connector-settings.test.ts › lists each declared setting with its default, sets values of each kind, clears one with null, and names a required setting with no value as missing`.

### `plugins/settings-set`

When a caller holding `connectors.manage` sends `PATCH /plugins/{name}/connector/settings` with an object whose keys name settings the plugin's connector declares, the server MUST store each value the object gives and answer `200` as `plugins/settings-list` says.

**Tests:** `compliance/connector-settings.test.ts › lists each declared setting with its default, sets values of each kind, clears one with null, and names a required setting with no value as missing`.

### `plugins/settings-clear`

When `PATCH /plugins/{name}/connector/settings` gives `null` for a setting, the server MUST remove the value set for it, so that the setting answers `set` `false`, whether or not it is required.

**Tests:** `compliance/connector-settings.test.ts › lists each declared setting with its default, sets values of each kind, clears one with null, and names a required setting with no value as missing`.

### `plugins/settings-unknown`

If `PATCH /plugins/{name}/connector/settings` names a setting the plugin's connector does not declare, then the server MUST answer `400 validation_error` with `details.errors` holding an entry whose `path` is each such name.

**Tests:** `compliance/connector-settings.test.ts › refuses 400 validation_error an unknown setting, a value of another kind, a choice outside its choices and a padded secret, naming each setting and storing nothing`.

### `plugins/settings-kind`

If `PATCH /plugins/{name}/connector/settings` gives a setting a value other than `null` that does not fit its `kind`, being for `text` other than text of 1 to 4096 characters, for `number` other than a number, for `boolean` other than `true` or `false`, and for `choice` other than one of its `choices`, then the server MUST answer `400 validation_error` with `details.errors` holding an entry whose `path` is the setting's name.

**Tests:** `compliance/connector-settings.test.ts › refuses 400 validation_error an unknown setting, a value of another kind, a choice outside its choices and a padded secret, naming each setting and storing nothing`.

### `plugins/settings-secret-padded`

If `PATCH /plugins/{name}/connector/settings` gives a secret setting text with Unicode `White_Space` at either end, then the server MUST answer `400 validation_error` with `details.errors` holding an entry whose `path` is the setting's name.

**Reason:** a secret is used as written, so white space a paste carried would make it fail at the service, far from where it was set.

**Tests:** `compliance/connector-settings.test.ts › refuses 400 validation_error an unknown setting, a value of another kind, a choice outside its choices and a padded secret, naming each setting and storing nothing`.

### `plugins/settings-body`

If `PATCH /plugins/{name}/connector/settings` sends a body that is not a JSON object, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-settings.test.ts › refuses 400 validation_error an unknown setting, a value of another kind, a choice outside its choices and a padded secret, naming each setting and storing nothing`.

### `plugins/settings-refused-nothing`

If the server refuses `PATCH /plugins/{name}/connector/settings`, then the server MUST store none of the values the body gives.

**Tests:** `compliance/connector-settings.test.ts › refuses 400 validation_error an unknown setting, a value of another kind, a choice outside its choices and a padded secret, naming each setting and storing nothing`.

### `plugins/settings-permission`

If a caller without `connectors.manage` sends `GET /plugins/{name}/connector/settings` or `PATCH /plugins/{name}/connector/settings`, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage`.

**Tests:** `compliance/connector-settings.test.ts › refuses 403 the settings doors to a key without connectors.manage, and 404 a plugin not installed or with no connector`.

### `plugins/settings-no-plugin`

If a caller sends `GET /plugins/{name}/connector/settings` or `PATCH /plugins/{name}/connector/settings` for a plugin that is not installed, then the server MUST answer `404 plugin_not_found`.

**Tests:** `compliance/connector-settings.test.ts › refuses 403 the settings doors to a key without connectors.manage, and 404 a plugin not installed or with no connector`.

### `plugins/settings-no-connector`

If a caller sends `GET /plugins/{name}/connector/settings` or `PATCH /plugins/{name}/connector/settings` for an installed plugin with no connector, then the server MUST answer `404 connector_not_found` with `details.plugin`.

**Tests:** `compliance/connector-settings.test.ts › refuses 403 the settings doors to a key without connectors.manage, and 404 a plugin not installed or with no connector`.

### `plugins/settings-audited`

When the server stores a `PATCH /plugins/{name}/connector/settings` that names a setting, the server MUST record one `connector.settings_change` audit entry against the plugin's name whose `details.settings` names each setting the write set or cleared.

**Tests:** `compliance/connector-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds a connector's secret, where a setting that is no secret is shown`.

### `plugins/settings-update-keeps`

When `POST /plugins` updates a plugin with a connector, the server MUST keep the value set for each setting the newer version declares with the same `kind` and `secret` and, for a `choice`, among its `choices`, and remove every other value set.

**Reason:** a value kept under a setting that changed its kind or secrecy would reach the connector as something it no longer is.

**Tests:** `compliance/connector-settings.test.ts › keeps through a newer version each value whose setting keeps its kind and secrecy, and drops the rest`.

### `plugins/settings-removed`

When the server removes a plugin with a connector, the server MUST remove every value set for its connector's settings in the same write, so that the plugin installed again answers each setting `set` `false`.

**Tests:** `compliance/connector-settings.test.ts › removes every setting and secret with the plugin, so the plugin installed again starts with none`.

## A connector's secrets

### `plugins/secret-sealed`

The server MUST NOT write the value of a secret setting of a plugin's connector into its database file other than sealed with the settings key it keeps in `marfa.settings.key` beside the database.

**Tests:** `compliance/connector-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds a connector's secret, where a setting that is no secret is shown`.

### `plugins/secret-bound`

If the value stored for a secret setting of a plugin's connector was sealed for another setting, for another plugin's connector, or for the connector of an earlier install of the plugin, then the server MUST answer the setting with `set` `false` and `unreadable` `true`.

**Reason:** a sealed value is bound to the setting it was set for and to the one install of the connector, so a copy of the database edited by hand cannot move a secret to a connector the owner did not give it to.

**Tests:** `compliance/connector-settings.test.ts › does not open a sealed value copied to another setting's row or to another plugin's connector`.

### `plugins/secret-unreadable`

If the server cannot open the value stored for a secret setting of a plugin's connector with its settings key, then the server MUST answer the setting's entry in `GET /plugins/{name}/connector/settings` with `set` `false` and `unreadable` `true`.

**Reason:** the value came from another machine, or the key was lost, and a secret the server cannot read is never reported as set. The row stays, so a key put back opens it again.

**Tests:** `compliance/connector-settings.test.ts › carries the settings in an archive, names each secret without its value, and after a restore onto another machine lists the secret unreadable, on the attention list and unset to the connector`, `› does not open a sealed value copied to another setting's row or to another plugin's connector`.

### `plugins/attention-secret-to-set`

While a secret setting of a plugin's connector holds a stored value the server cannot open, when `GET /attention` completes its checks, the server MUST include one entry of kind `setting` whose `reference` is the plugin's name, `/`, and the setting's name.

**Tests:** `compliance/connector-settings.test.ts › carries the settings in an archive, names each secret without its value, and after a restore onto another machine lists the secret unreadable, on the attention list and unset to the connector`, `› lists every other entry when the record or settings of one plugin's connector do not read, the unreadable secret of a connector that reads among them`.

### `plugins/attention-connector-unread`

If the server cannot read the record or the declared settings of one plugin's connector when `GET /attention` runs its checks, then the server MUST leave that connector's settings out of the entries and include every other entry its checks find.

**Reason:** one record that a hand edit or a fault left unreadable does not hide what else needs the owner.

**Tests:** `compliance/connector-settings.test.ts › lists every other entry when the record or settings of one plugin's connector do not read, the unreadable secret of a connector that reads among them`.

## A connector's sign-in

A plugin's connector whose section declares `sign_in` gets its refresh token through the owner's browser. `POST /plugins/{name}/connector/sign-in` answers the provider's authorization address, the provider sends the browser back to `GET /connect/oauth/callback`, and the server exchanges the code at the provider's token address and seals the refresh token into the setting `token_setting` names. The client ID and client secret are the owner's own, held in the settings `client_id_setting` and `client_secret_setting` name. The one provider is `google`, whose authorization address is `https://accounts.google.com/o/oauth2/v2/auth` and whose token address is `https://oauth2.googleapis.com/token`. A sign-in is pending from its start until a callback ends it, a later start replaces it, or ten minutes pass. Each start answers an `id` naming its sign-in, so a caller that waits can tell its own sign-in from a later one. A sign-in that fails records one outcome word saying why, which the owner and an app read in the audit entry and the status; no text the provider wrote is kept or shown.

`POST /plugins/{name}/connector/sign-in` judges the caller's permission, the body, the plugin, its connector, its `sign_in`, then the client settings. `GET /plugins/{name}/connector/sign-in` judges the caller's permission, the plugin, its connector, then its `sign_in`.

### `plugins/sign-in-start`

When a caller holding `connectors.manage` sends `POST /plugins/{name}/connector/sign-in` for a plugin whose connector declares `sign_in`, and the settings `client_id_setting` and `client_secret_setting` name hold values the server can read, the server MUST answer `201` with `id`, `url`, and `expires_at` ten minutes after the start.

**Tests:** `compliance/connector-sign-in.test.ts › starts a sign-in answering the provider's address with every parameter, a state and an S256 challenge, ten minutes to finish`.

### `plugins/sign-in-url`

When the server answers `POST /plugins/{name}/connector/sign-in` with `201`, the server MUST answer `url` as the provider's authorization address with the query parameters `client_id` holding the value of the setting `client_id_setting` names, `redirect_uri` holding the origin of the server's sign-in address followed by `/connect/oauth/callback`, `response_type` `code`, `scope` holding the `scopes` of `sign_in` separated by spaces, `state`, `code_challenge`, `code_challenge_method` `S256`, `access_type` `offline` and `prompt` `consent`.

**Reason:** `access_type` `offline` and `prompt` `consent` make Google answer a refresh token at every sign-in, not only the first.

**Tests:** `compliance/connector-sign-in.test.ts › starts a sign-in answering the provider's address with every parameter, a state and an S256 challenge, ten minutes to finish`.

### `plugins/sign-in-google-address`

Where the server was built without test hooks, the server MUST answer the `url` of a sign-in whose `provider` is `google` at `https://accounts.google.com/o/oauth2/v2/auth`.

**Reason:** no setting, request or fault moves a provider's addresses, so the owner's browser and client secret go only to the provider.

**Tests:** `compliance/hook-free-server.test.ts › starts a connector's sign-in at Google's own authorization address, where a hooked server's fault names another`.

### `plugins/sign-in-not-declared`

If a caller sends `POST /plugins/{name}/connector/sign-in` or `GET /plugins/{name}/connector/sign-in` for a plugin whose connector declares no `sign_in`, then the server MUST answer `409 connector_sign_in_not_declared` with `details.plugin`.

**Tests:** `compliance/connector-sign-in.test.ts › refuses 409 a start while the client ID or secret is unset, naming each, and for a connector that declares no sign-in`.

### `plugins/sign-in-settings-missing`

If a caller sends `POST /plugins/{name}/connector/sign-in` while the setting `client_id_setting` or `client_secret_setting` names holds no value the server can read, then the server MUST answer `409 connector_sign_in_settings_missing` with `details.settings` naming each such setting.

**Tests:** `compliance/connector-sign-in.test.ts › refuses 409 a start while the client ID or secret is unset, naming each, and for a connector that declares no sign-in`.

### `plugins/sign-in-return-to`

If the body of `POST /plugins/{name}/connector/sign-in` gives a `return_to` that is not text of 1 to 2048 characters naming a path, an address on the origin of the server's sign-in address, or a redirect URI as `plugins/sign-in-return-to-app` allows, then the server MUST answer `400 validation_error` with `details.errors` holding an entry whose `path` is `return_to`.

**Reason:** the callback sends the owner's browser to `return_to` with no credential, so it goes nowhere but the server's own pages and the calling app.

**Tests:** `compliance/connector-sign-in.test.ts › refuses 400 a return_to off the server's own address and a body that is not an object, 403 a key without connectors.manage, and 404 a plugin not installed or with no connector`, `› accepts as return_to a redirect URI the calling app's own OAuth client registered, and refuses another app's, an unregistered one, and one from a caller that is no app`.

### `plugins/sign-in-return-to-app`

When an app's OAuth access token sends `POST /plugins/{name}/connector/sign-in` with a `return_to` equal, character for character, to one of the redirect URIs that app's OAuth client registered, the server MUST accept that `return_to`.

**Reason:** a native app signs in through the system's web authentication sheet, which ends only on the app's own registered address, such as a private-use scheme.

**Tests:** `compliance/connector-sign-in.test.ts › accepts as return_to a redirect URI the calling app's own OAuth client registered, and refuses another app's, an unregistered one, and one from a caller that is no app`.

### `plugins/sign-in-body`

If `POST /plugins/{name}/connector/sign-in` sends a body that is not a JSON object, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/connector-sign-in.test.ts › refuses 400 a return_to off the server's own address and a body that is not an object, 403 a key without connectors.manage, and 404 a plugin not installed or with no connector`.

### `plugins/sign-in-permission`

If a caller without `connectors.manage` sends `POST /plugins/{name}/connector/sign-in` or `GET /plugins/{name}/connector/sign-in`, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage`.

**Tests:** `compliance/connector-sign-in.test.ts › refuses 400 a return_to off the server's own address and a body that is not an object, 403 a key without connectors.manage, and 404 a plugin not installed or with no connector`.

### `plugins/sign-in-no-plugin`

If a caller sends `POST /plugins/{name}/connector/sign-in` or `GET /plugins/{name}/connector/sign-in` for a plugin that is not installed, then the server MUST answer `404 plugin_not_found`.

**Tests:** `compliance/connector-sign-in.test.ts › refuses 400 a return_to off the server's own address and a body that is not an object, 403 a key without connectors.manage, and 404 a plugin not installed or with no connector`.

### `plugins/sign-in-no-connector`

If a caller sends `POST /plugins/{name}/connector/sign-in` or `GET /plugins/{name}/connector/sign-in` for an installed plugin with no connector, then the server MUST answer `404 connector_not_found` with `details.plugin`.

**Tests:** `compliance/connector-sign-in.test.ts › refuses 400 a return_to off the server's own address and a body that is not an object, 403 a key without connectors.manage, and 404 a plugin not installed or with no connector`.

### `plugins/sign-in-replaces`

When the server answers `POST /plugins/{name}/connector/sign-in` with `201` for a plugin with a pending sign-in, the server MUST end the earlier sign-in, so that a callback with its `state` is answered as `plugins/sign-in-state-unknown` says.

**Tests:** `compliance/connector-sign-in.test.ts › finishes nothing for a wrong, replayed, expired or replaced state, showing each the page that says the sign-in did not finish, storing nothing and asking the provider nothing`.

### `plugins/sign-in-status`

When a caller holding `connectors.manage` sends `GET /plugins/{name}/connector/sign-in` for a plugin whose connector declares `sign_in`, the server MUST answer `200` with `plugin`, `status`, `reason`, and the `id`, `started_at`, `expires_at`, and `ended_at` of the latest sign-in started for the plugin's connector, each `null` when no sign-in was started, `id` as its start answered it.

**Tests:** `compliance/connector-sign-in.test.ts › answers the latest sign-in's status: none, pending, signed in, failed and expired`.

### `plugins/sign-in-status-words`

When the server answers `GET /plugins/{name}/connector/sign-in`, the server MUST answer `status` as `none` when no sign-in was started for the plugin's connector, `pending` while the latest is pending, `signed_in` once its callback stored the refresh token, `expired` once its ten minutes passed with no callback ending it, and `failed` once it ended any other way.

**Reason:** an app or the command line waiting on the owner's browser reads here whether this sign-in finished, which a token already set from an earlier sign-in cannot tell it.

**Tests:** `compliance/connector-sign-in.test.ts › answers the latest sign-in's status: none, pending, signed in, failed and expired`.

### `plugins/sign-in-status-reason`

When the server answers `GET /plugins/{name}/connector/sign-in` with `status` `failed`, the server MUST answer `reason` as the outcome word the sign-in's `connector.sign_in_failed` audit entry records, and as `null` for every other `status`.

**Reason:** the owner and an app tell a wrong client secret from a provider that did not answer without reading the audit log.

**Tests:** `compliance/connector-sign-in.test.ts › answers the latest sign-in's status: none, pending, signed in, failed and expired`, `› records the provider's own word for each of the six token errors of RFC 6749, keeping none of the provider's text`.

### `plugins/sign-in-exchange`

When a browser sends `GET /connect/oauth/callback` with the `state` of a pending sign-in and a `code`, the server MUST send the provider's token address one `POST` with the form fields `grant_type` `authorization_code`, `code`, `redirect_uri` as the start's `url` gave it, `client_id`, `client_secret` and `code_verifier`, whose SHA-256 in unpadded base64url is the start's `code_challenge`.

**Tests:** `compliance/connector-sign-in.test.ts › finishes at the callback: the provider gets the code, the verifier, the client ID and secret, the refresh token is sealed into the token setting, and the browser goes back to return_to with signed_in`.

### `plugins/sign-in-token-stored`

When the provider answers the token request `200` with a JSON object whose `refresh_token` is text, the server MUST store that text as the value of the secret setting `token_setting` names.

**Tests:** `compliance/connector-sign-in.test.ts › finishes at the callback: the provider gets the code, the verifier, the client ID and secret, the refresh token is sealed into the token setting, and the browser goes back to return_to with signed_in`.

### `plugins/sign-in-return`

When the server stores the refresh token of a sign-in started with `return_to`, the server MUST answer the callback `303` with `Location` holding the `return_to` with the query parameter `signed_in` holding the plugin's name.

**Tests:** `compliance/connector-sign-in.test.ts › finishes at the callback: the provider gets the code, the verifier, the client ID and secret, the refresh token is sealed into the token setting, and the browser goes back to return_to with signed_in`.

### `plugins/sign-in-finished-page`

When the server stores the refresh token of a sign-in started with no `return_to`, the server MUST answer the callback `200` with an HTML page.

**Tests:** `compliance/connector-sign-in.test.ts › shows a page saying the owner can return to their app when the sign-in gave no return_to`.

### `plugins/sign-in-ended`

When the server answers `GET /connect/oauth/callback` with the `state` of a pending sign-in, the server MUST end that sign-in, so that a later callback with the same `state` is answered as `plugins/sign-in-state-unknown` says.

**Tests:** `compliance/connector-sign-in.test.ts › finishes nothing for a wrong, replayed, expired or replaced state, showing each the page that says the sign-in did not finish, storing nothing and asking the provider nothing`, `› ends the sign-in on an error from the provider, showing the page that says it did not finish and storing nothing`.

### `plugins/sign-in-state-unknown`

If a browser sends `GET /connect/oauth/callback` whose `state` names no pending sign-in, being missing, one no start answered, one a callback already ended, one a later start replaced, or one whose ten minutes have passed, then the server MUST answer `400` with an HTML page.

**Tests:** `compliance/connector-sign-in.test.ts › finishes nothing for a wrong, replayed, expired or replaced state, showing each the page that says the sign-in did not finish, storing nothing and asking the provider nothing`.

### `plugins/sign-in-provider-error`

If a browser sends `GET /connect/oauth/callback` with the `state` of a pending sign-in and an `error`, or with no `code`, then the server MUST answer `400` with an HTML page.

**Tests:** `compliance/connector-sign-in.test.ts › ends the sign-in on an error from the provider, showing the page that says it did not finish and storing nothing`.

### `plugins/sign-in-token-refused`

If the provider answers the token request other than `200` with a JSON object whose `refresh_token` is text the token setting takes, then the server MUST answer the callback `502` with an HTML page.

**Tests:** `compliance/connector-sign-in.test.ts › stores nothing when the provider answers without a refresh token, and shows a page saying the sign-in failed`.

### `plugins/sign-in-provider-slow`

If the provider's token address does not answer the token request within 15 seconds, then the server MUST answer the callback `502` with an HTML page.

**Reason:** an owner whose browser waits on a provider that never answers is told so, and the sign-in ends rather than hang.

**Tests:** `compliance/connector-sign-in.test.ts › ends the sign-in as failed when the provider does not answer within the bound`.

### `plugins/sign-in-unfinished-nothing`

If the server answers `GET /connect/oauth/callback` other than as `plugins/sign-in-return` or `plugins/sign-in-finished-page` says, then the server MUST NOT change the value of any setting.

**Tests:** `compliance/connector-sign-in.test.ts › finishes nothing for a wrong, replayed, expired or replaced state, showing each the page that says the sign-in did not finish, storing nothing and asking the provider nothing`, `› ends the sign-in on an error from the provider, showing the page that says it did not finish and storing nothing`, `› stores nothing when the provider answers without a refresh token, and shows a page saying the sign-in failed`, `› ends the sign-in as failed when the provider does not answer within the bound`.

### `plugins/sign-in-only-request`

The server MUST NOT send a request to a provider's address other than the token request `plugins/sign-in-exchange` says.

**Reason:** the token request leaves the owner's machine only because the owner started a sign-in, and nothing else does.

**Tests:** `compliance/connector-sign-in.test.ts › starts a sign-in answering the provider's address with every parameter, a state and an S256 challenge, ten minutes to finish`, `› finishes nothing for a wrong, replayed, expired or replaced state, showing each the page that says the sign-in did not finish, storing nothing and asking the provider nothing`.

### `plugins/sign-in-page-own`

When the server answers `GET /connect/oauth/callback` with an HTML page, the server MUST send a `Content-Security-Policy` whose `default-src` is `'none'` and that names no other origin.

**Reason:** the page's address holds the code the provider sent, and nothing on it loads from anywhere else.

**Tests:** `compliance/connector-sign-in.test.ts › answers each of its pages with nothing from another origin`.

### `plugins/sign-in-not-shown`

The server MUST NOT include the code a provider sent, a token the provider answered or the client secret in any answer, page, `Location` or refusal.

**Tests:** `compliance/connector-sign-in.test.ts › shows the code, the tokens and the client secret nowhere: no answer, page, redirect, audit entry or log line, where the connector's own key reads the refresh token`.

### `plugins/sign-in-not-logged`

The server MUST NOT write the code a provider sent, a token the provider answered or the client secret to its log or its standard error.

**Tests:** `compliance/connector-sign-in.test.ts › shows the code, the tokens and the client secret nowhere: no answer, page, redirect, audit entry or log line, where the connector's own key reads the refresh token`.

### `plugins/sign-in-not-audited`

The server MUST NOT include the code a provider sent, a token the provider answered or the client secret in an audit entry.

**Tests:** `compliance/connector-sign-in.test.ts › shows the code, the tokens and the client secret nowhere: no answer, page, redirect, audit entry or log line, where the connector's own key reads the refresh token`.

### `plugins/sign-in-audited`

When the server answers `POST /plugins/{name}/connector/sign-in` with `201`, the server MUST record one `connector.sign_in` audit entry against the plugin's name.

**Tests:** `compliance/connector-sign-in.test.ts › audits the start and the end of each sign-in against the plugin's name`.

### `plugins/sign-in-end-audited`

When the server ends a pending sign-in at its callback, the server MUST record one audit entry against the plugin's name, `connector.signed_in` when it stored the refresh token and `connector.sign_in_failed` otherwise.

**Tests:** `compliance/connector-sign-in.test.ts › audits the start and the end of each sign-in against the plugin's name`.

### `plugins/sign-in-failed-outcome`

When the server records `connector.sign_in_failed`, the server MUST record in `details.outcome` the one outcome word that a statement from `plugins/sign-in-outcome-token-error` to `plugins/sign-in-outcome-changed` names for how the sign-in failed.

**Tests:** `compliance/connector-sign-in.test.ts › records the provider's own word for each of the six token errors of RFC 6749, keeping none of the provider's text`.

### `plugins/sign-in-outcome-token-error`

When the provider answers the token request with a status other than `200` and a JSON object whose `error` is `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, or `invalid_scope`, the server MUST record that `error` as the outcome.

**Reason:** RFC 6749 section 5.2 fixes these words, so each says why the provider refused without carrying text the provider wrote. `invalid_client` tells the owner the client ID or secret is wrong.

**Tests:** `compliance/connector-sign-in.test.ts › records the provider's own word for each of the six token errors of RFC 6749, keeping none of the provider's text`.

### `plugins/sign-in-outcome-status`

When the provider answers the token request with a status other than `200` and no `error` that `plugins/sign-in-outcome-token-error` names, the server MUST record `status_` followed by that status as the outcome.

**Tests:** `compliance/connector-sign-in.test.ts › records status_ and the status for a refusal with no token error it names`.

### `plugins/sign-in-outcome-timeout`

If the provider does not answer the token request within the bound `plugins/sign-in-provider-slow` states, then the server MUST record `timeout` as the outcome.

**Tests:** `compliance/connector-sign-in.test.ts › ends the sign-in as failed when the provider does not answer within the bound`.

### `plugins/sign-in-outcome-unreachable`

If the server cannot connect to the provider's token address, then the server MUST record `unreachable` as the outcome.

**Tests:** `compliance/connector-sign-in.test.ts › records unreachable when nothing answers at the provider's token address`.

### `plugins/sign-in-outcome-no-refresh-token`

When the provider answers the token request `200` with a JSON object that has no `refresh_token`, the server MUST record `no_refresh_token` as the outcome.

**Tests:** `compliance/connector-sign-in.test.ts › stores nothing when the provider answers without a refresh token, and shows a page saying the sign-in failed`.

### `plugins/sign-in-outcome-unreadable`

When the provider answers the token request `200` with a body that is not a JSON object of at most 64 KiB, or with a `refresh_token` that is not text the token setting takes, the server MUST record `unreadable_answer` as the outcome.

**Tests:** `compliance/connector-sign-in.test.ts › stores nothing when the provider answers without a refresh token, and shows a page saying the sign-in failed`.

### `plugins/sign-in-outcome-browser-error`

When a browser sends `GET /connect/oauth/callback` with the `state` of a pending sign-in and an `error` that is `invalid_request`, `unauthorized_client`, `access_denied`, `unsupported_response_type`, `invalid_scope`, `server_error`, or `temporarily_unavailable`, the server MUST record that `error` as the outcome.

**Reason:** RFC 6749 section 4.1.2.1 fixes these words. `access_denied` tells the owner they declined at the provider.

**Tests:** `compliance/connector-sign-in.test.ts › ends the sign-in on an error from the provider, showing the page that says it did not finish and storing nothing`.

### `plugins/sign-in-outcome-browser-other`

When a browser sends `GET /connect/oauth/callback` with the `state` of a pending sign-in and an `error` that `plugins/sign-in-outcome-browser-error` does not name, the server MUST record `provider_error` as the outcome.

**Tests:** `compliance/connector-sign-in.test.ts › ends the sign-in on an error from the provider, showing the page that says it did not finish and storing nothing`.

### `plugins/sign-in-outcome-no-code`

When a browser sends `GET /connect/oauth/callback` with the `state` of a pending sign-in and neither an `error` nor a `code`, the server MUST record `no_code` as the outcome.

**Tests:** `compliance/connector-sign-in.test.ts › ends the sign-in on an error from the provider, showing the page that says it did not finish and storing nothing`.

### `plugins/sign-in-outcome-changed`

When a browser sends `GET /connect/oauth/callback` with the `state` and a `code` of a pending sign-in whose plugin's connector no longer declares `sign_in`, whose client ID or client secret setting no longer holds a value the server can read, or whose plugin was installed again since the start, the server MUST record `changed_since_start` as the outcome.

**Tests:** `compliance/connector-sign-in.test.ts › records changed_since_start when the client secret was cleared between the start and the callback`.

### `plugins/sign-in-provider-text`

The server MUST NOT include text the provider sent in an answer, a page, a `Location`, an audit entry, or its log, other than an outcome word a statement from `plugins/sign-in-outcome-token-error` to `plugins/sign-in-outcome-changed` names.

**Reason:** a provider's `error_description` and its other text are the provider's to write, so the owner reads only words Marfa fixes.

**Tests:** `compliance/connector-sign-in.test.ts › records the provider's own word for each of the six token errors of RFC 6749, keeping none of the provider's text`, `› ends the sign-in on an error from the provider, showing the page that says it did not finish and storing nothing`, `› shows the code, the tokens and the client secret nowhere: no answer, page, redirect, audit entry or log line, where the connector's own key reads the refresh token`.

### `plugins/sign-in-removed`

When the server removes a plugin with a pending sign-in, the server MUST end the sign-in, so that a callback with its `state` is answered as `plugins/sign-in-state-unknown` says.

**Tests:** `compliance/connector-sign-in.test.ts › ends a pending sign-in with its plugin's removal, and carries none in an archive`.

### `plugins/sign-in-not-archived`

The server MUST NOT put a sign-in, its `state` or its PKCE verifier in an archive or a backup.

**Reason:** a pending sign-in holds what would finish it, and a restore onto another machine starts its own.

**Tests:** `compliance/connector-sign-in.test.ts › ends a pending sign-in with its plugin's removal, and carries none in an archive`.

### `plugins/sign-in-callback-limit`

Where the limiter is on, when the requests to `GET /connect/oauth/callback` from one address pass 10 within 15 minutes, the server MUST answer each further request in that window `429 rate_limited`.

**Tests:** `compliance/connector-sign-in.test.ts › refuses 429 rate_limited callbacks from one address past ten in fifteen minutes`.

## Removing a host

### `plugins/host-remove`

When a caller holding `connectors.manage` sends `DELETE /connector-hosts/{id}`, the server MUST remove the host and its link and answer `200` with `removed` holding its `id` and `name`, `revoked_keys` counting the keys it revoked and `unassigned` listing the plugins whose connectors it unassigned.

**Tests:** `compliance/connector-hosts.test.ts › removes a host: revokes its key and every connector key it minted, and unassigns its connectors`.

### `plugins/host-remove-keys`

When the server removes a connector host, the server MUST revoke in the same write the host's key and every live key the host minted for a connector.

**Tests:** `compliance/connector-hosts.test.ts › removes a host: revokes its key and every connector key it minted, and unassigns its connectors`.

### `plugins/host-remove-unassigns`

When the server removes a connector host, the server MUST leave each connector assigned to it assigned to no host.

**Tests:** `compliance/connector-hosts.test.ts › removes a host: revokes its key and every connector key it minted, and unassigns its connectors`.

## Audit

### `plugins/host-audited`

When the server makes, links, removes or redeems a link for a connector host, the server MUST record a `connector_host.create`, `connector_host.link`, `connector_host.remove` or `connector_host.redeem` audit entry against the host's id.

**Tests:** `compliance/connector-hosts.test.ts › audits making, linking, redeeming and removing a host, assigning a connector and minting its key`.

### `plugins/assign-audited`

When the server assigns a plugin's connector, the server MUST record a `plugin.connector_assign` audit entry against the plugin's name whose `details` name the `host` or `null`.

**Tests:** `compliance/connector-hosts.test.ts › audits making, linking, redeeming and removing a host, assigning a connector and minting its key`.

### `plugins/mint-audited`

When the server mints a connector's key for its host, the server MUST record a `connector.key_mint` audit entry against the plugin's name whose `details` name the host and the new key's `key_id`.

**Tests:** `compliance/connector-hosts.test.ts › audits making, linking, redeeming and removing a host, assigning a connector and minting its key`.

### `plugins/host-secrets-kept`

The server MUST NOT write a one-time link's code, a host's key or a connector's key into an audit entry, a log line or a refusal.

**Tests:** `compliance/connector-hosts.test.ts › keeps every link code, host key and connector key out of audit entries, the log and refusals`.

## A connector's mapping

A plugin's `connector` object names its `source` and its `kinds`. Each kind has a `name`, its own `type` (one of the bundle's types), a `direction` (`in`, `out` or `both`) and, optionally, a `default_mapping`: an object with any of `tier`, `status_overrides` and `fields` of one kind's entry below (`plugins/connector-default-mapping`). A plugin's connector key is a live key whose own `source` is the source the server recorded for an installed plugin's connector (`plugins/connector-recorded`), which one plugin alone holds (`plugins/connector-source-plugin`).

The mapping is the owner's choice of what each kind brings: `{ version, kinds, rewrites }`, where `kinds` holds one entry per kind of the connector, `{ enabled, target_type, tier, status_overrides, fields }`. `fields` is keyed by a field of `target_type`, each `{ "from": <field of the kind's own type> }`, `{ "fixed": <value> }` or `{ "template": <Jinja text> }`. `status_overrides` maps a status word of the kind's own type to a status word of `target_type`. The connector applies the mapping as it writes; the server stores it, judges it and decides from it what the connector's key may write.

### `plugins/mapping-read`

When a caller holding `connectors.manage`, or the plugin's connector key, sends `GET /plugins/{name}/connector/mapping` for an installed plugin with a `connector`, the server MUST answer `200` with `version`, `kinds` holding one entry for each kind the plugin's `connector` names, each with `enabled`, `target_type`, `tier`, `status_overrides` and `fields`, and `rewrites`.

**Reason:** the connector reads its mapping as it runs, and an app draws the owner's mapping page from the same answer.

**Tests:** `compliance/connector-mapping.test.ts › answers the default mapping to connectors.manage and to the connector's own key, and 403 to another key`.

### `plugins/mapping-default`

While no mapping has been saved for a plugin, the server MUST answer `GET /plugins/{name}/connector/mapping` with `version` `0` and each kind's entry holding `enabled` `true`, `target_type` the kind's own type, and each member its `default_mapping` names, and otherwise `tier` `feed`, `status_overrides` `{}` and `fields` holding `{ "from": <field> }` for each field `target_type` declares that the kind's own type also declares.

**Reason:** a new connector starts at the feed under its own types, as the plugin's author meant it, until the owner chooses otherwise.

**Tests:** `compliance/connector-mapping.test.ts › answers the default mapping to connectors.manage and to the connector's own key, and 403 to another key`.

### `plugins/mapping-kinds-from-plugin`

When the server answers or judges a mapping, the server MUST hold an entry for each kind the installed plugin's `connector` names and none for a kind it does not name, giving a kind no saved entry holds its default entry (`plugins/mapping-default`).

**Reason:** a newer version of the plugin may add a kind; the owner's choices for the kinds it keeps stand.

**Tests:** `compliance/connector-mapping.test.ts › saves a mapping that fills a required field with a fixed value, and fills a kind it leaves out with its default`.

### `plugins/mapping-read-permission`

If a caller that neither holds `connectors.manage` nor is the plugin's connector key sends `GET /plugins/{name}/connector/mapping`, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage`.

**Tests:** `compliance/connector-mapping.test.ts › answers the default mapping to connectors.manage and to the connector's own key, and 403 to another key`.

### `plugins/mapping-not-found`

If a caller holding `connectors.manage` sends a request under `/plugins/{name}/connector/` for a name no installed plugin has, then the server MUST answer `404 plugin_not_found`, and for an installed plugin whose bundle holds no `connector` object naming a `source` and `kinds` as this section describes, `404 plugin_connector_not_found`.

**Reason:** a stored `connector` object that does not read is no connector to map.

**Tests:** `compliance/connector-mapping.test.ts › answers 404 plugin_not_found for a plugin not installed and 404 plugin_connector_not_found for one with no connector`.

### `plugins/mapping-save`

When a caller holding `connectors.manage` sends `PUT /plugins/{name}/connector/mapping` with `version` equal to the mapping's current `version` and `kinds` the server takes, the server MUST store the mapping at the next `version` and answer `200` with it as `plugins/mapping-read` gives it.

**Tests:** `compliance/connector-mapping.test.ts › saves a mapping that fills a required field with a fixed value, and fills a kind it leaves out with its default`.

### `plugins/mapping-save-defaults`

When `PUT /plugins/{name}/connector/mapping` leaves out a kind, or a member of a kind's entry, the server MUST store that kind or member as its default (`plugins/mapping-default`) gives it.

**Tests:** `compliance/connector-mapping.test.ts › saves a mapping that fills a required field with a fixed value, and fills a kind it leaves out with its default`.

### `plugins/mapping-stale`

If `PUT /plugins/{name}/connector/mapping` names a `version` other than the mapping's current `version`, then the server MUST answer `409 connector_mapping_stale` with `details.version` holding the current `version`, and store nothing.

**Reason:** two apps editing one mapping would otherwise lose the first one's change without a word.

**Tests:** `compliance/connector-mapping.test.ts › refuses 409 connector_mapping_stale a save naming a version that is no longer current`.

### `plugins/mapping-save-permission`

If a caller without `connectors.manage` sends `PUT /plugins/{name}/connector/mapping`, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage`, and store nothing.

**Reason:** the connector reads its mapping but never sets it; the owner's choice is the owner's.

**Tests:** `compliance/connector-mapping.test.ts › refuses 403 a save from the connector's own key and from a key without connectors.manage`.

### `plugins/mapping-shape`

If `PUT /plugins/{name}/connector/mapping` sends a body that is not an object holding `version` as a whole number and `kinds` as an object, a member other than `version` and `kinds`, a kind's entry that is not an object or holds a member other than `enabled`, `target_type`, `tier`, `status_overrides` and `fields`, an `enabled` that is not a boolean, a `target_type` that is not text, a `tier` other than `feed` or `library`, a `status_overrides` that is not an object of text, or a field entry that is not an object holding exactly one of `from` as text, `fixed` or `template` as text, then the server MUST answer `400 validation_error` with `details.errors` naming the `path` of each.

**Tests:** `compliance/connector-mapping.test.ts › refuses 400 validation_error a mapping whose shape is wrong, naming each path`.

### `plugins/mapping-unknown-kind`

If `PUT /plugins/{name}/connector/mapping` names in `kinds` a kind the plugin's `connector` does not name, then the server MUST answer `400 validation_error` with `details.errors` naming `kinds.<kind>`.

**Tests:** `compliance/connector-mapping.test.ts › refuses 400 validation_error a mapping whose shape is wrong, naming each path`.

### `plugins/mapping-target-type`

If `PUT /plugins/{name}/connector/mapping` gives an enabled kind a `target_type` that names no registered type, that sits under `system`, or that the caller's type map does not grant write on, then the server MUST answer `400 validation_error` with `details.errors` naming `kinds.<kind>.target_type`.

**Reason:** a mapping gives the connector's key write on its target type for the connector's own items (`plugins/reach-target-own-source`), so no caller hands on a write it does not hold.

**Tests:** `compliance/connector-mapping.test.ts › refuses a target type that is not registered, is a system type or that the caller may not write`.

### `plugins/mapping-required-field`

If `PUT /plugins/{name}/connector/mapping` gives an enabled kind a `target_type` with a required field that no entry in its `fields` fills with `from`, `fixed` or, for a field of type `string`, `template`, then the server MUST answer `400 validation_error` with `details.errors` naming `kinds.<kind>.fields.<field>`.

**Reason:** the connector could not write an item the target type takes. The owner fills such a field with a fixed value.

**Tests:** `compliance/connector-mapping.test.ts › refuses a mapping that leaves a required field of the target type unfilled, naming the field`, `› saves a mapping that fills a required field with a fixed value, and fills a kind it leaves out with its default`.

### `plugins/mapping-field-unknown`

If `PUT /plugins/{name}/connector/mapping` names in an enabled kind's `fields` a field its `target_type` does not declare, then the server MUST answer `400 validation_error` with `details.errors` naming `kinds.<kind>.fields.<field>`.

**Tests:** `compliance/connector-mapping.test.ts › refuses a from naming no field of the kind's own type, a fixed value the field refuses, a template on a field that is not text and an unknown field`.

### `plugins/mapping-from-unknown`

If an entry of an enabled kind's `fields` holds a `from` naming a field the kind's own type does not declare, then the server MUST answer `400 validation_error` with `details.errors` naming `kinds.<kind>.fields.<field>.from`.

**Tests:** `compliance/connector-mapping.test.ts › refuses a from naming no field of the kind's own type, a fixed value the field refuses, a template on a field that is not text and an unknown field`.

### `plugins/mapping-fixed-fit`

If an entry of an enabled kind's `fields` holds a `fixed` value that the target field would refuse in an item of `target_type`, then the server MUST answer `400 validation_error` with `details.errors` naming `kinds.<kind>.fields.<field>.fixed`.

**Tests:** `compliance/connector-mapping.test.ts › refuses a from naming no field of the kind's own type, a fixed value the field refuses, a template on a field that is not text and an unknown field`.

### `plugins/mapping-template-text`

If an entry of an enabled kind's `fields` holds a `template` for a target field whose type is not `string`, then the server MUST answer `400 validation_error` with `details.errors` naming `kinds.<kind>.fields.<field>.template`.

**Reason:** a template renders text. The server stores it and never renders it: the connector does, as it writes.

**Tests:** `compliance/connector-mapping.test.ts › refuses a from naming no field of the kind's own type, a fixed value the field refuses, a template on a field that is not text and an unknown field`.

### `plugins/mapping-status-override`

If an enabled kind's `status_overrides` names a word that the kind's own type does not declare as a status word, or maps a word to one that `target_type` does not declare as a status word, then the server MUST answer `400 validation_error` with `details.errors` naming `kinds.<kind>.status_overrides.<word>`.

**Reason:** status words map through their group, and an override replaces that for one word, into any group the target type holds.

**Tests:** `compliance/connector-mapping.test.ts › refuses a status override naming a word either type does not declare`.

### `plugins/mapping-disabled-shape`

When `PUT /plugins/{name}/connector/mapping` holds a kind with `enabled` `false`, the server MUST judge that kind's entry only by `plugins/mapping-shape`.

**Reason:** a kind that brings nothing gives no reach, so a target type deleted since it was chosen does not stop the owner saving the rest. Turning the kind on again is a save, judged whole.

**Tests:** `compliance/connector-mapping.test.ts › saves a disabled kind whose target type is not registered, and refuses the same kind enabled`.

### `plugins/mapping-judged-committed`

When the server judges `PUT /plugins/{name}/connector/mapping`, the server MUST judge it against the types and the caller's grants as they stand in the write that stores it.

**Reason:** a type changed between the read and the save is judged as it now is.

**Tests:** `compliance/connector-mapping.test.ts › judges a save against a type changed after the mapping was read`.

### `plugins/mapping-keeps-items`

When the server stores a mapping, the server MUST change no stored item.

**Reason:** a changed mapping applies to what the connector writes next; existing items change only when the owner asks for a rewrite (`plugins/rewrite-request`).

**Tests:** `compliance/connector-mapping.test.ts › counts exactly the items under the connector's source on a kind's target type, and changes no item on a save or a rewrite`.

### `plugins/mapping-audit`

When the server stores a mapping, the server MUST write one audit entry with the action `connector.mapping_change`, the resource the plugin's name and details holding only the mapping's `version`.

**Tests:** `compliance/connector-mapping.test.ts › saves a mapping that fills a required field with a fixed value, and fills a kind it leaves out with its default`.

### `plugins/mapping-removed`

When `DELETE /plugins/{name}` removes a plugin, the server MUST remove its saved mapping and any rewrite it asked for, so that installing it again answers the default mapping at `version` `0` with no `rewrites`.

**Tests:** `compliance/connector-mapping.test.ts › removes the mapping with the plugin, and answers the default once it is installed again`.

## What a connector's key may write

### `plugins/reach-target-own-source`

While a plugin's connector key's mapping holds an enabled kind whose `target_type` is none of its connector's kinds' own types and its type map does not grant write on, when the key creates an item of that type under its own source, or writes an item of that type whose `source` is its own source through any door that writes an item, the server MUST take the write as it would were that type granted write in its type map.

**Reason:** a connector mapped onto a type the owner chose writes there only what it brought. The reach is read from the mapping each time, never copied into the key's type map, so the two cannot disagree.

**Tests:** `compliance/connector-reach.test.ts › creates, updates, tags, links, fills the table of, trashes, restores and purges its own items on its mapped target type`, `› leaves the owner's child, comment and attachment on its item where they are through its trash, restore and purge, and carries its own`.

### `plugins/reach-own-types`

When a plugin's connector key reads or writes an item of one of its connector's kinds' own types, the server MUST decide it by the key's type map alone, whatever the mapping holds.

**Reason:** every kind lands on its own type until the owner maps it elsewhere, so a mapping that granted its own types would hand a key the plugin's whole namespace whatever its type map says.

**Tests:** `compliance/connector-reach.test.ts › writes a kind's own type only as its type map allows, whatever the mapping`.

### `plugins/reach-cascade`

When a plugin's connector key moves an item to the bin, restores it from the bin or purges it, the server MUST carry with it no item the key could not itself write through that door, and no item the cascade reaches only through one, leaving each where it is.

**Reason:** a cascade follows edges the owner made too, such as their child of the connector's item or their comment on it. The owner's items do not go with the connector's, whichever door it uses and whatever type they are. The server decides it on the items as they stand in the write that moves them.

**Tests:** `compliance/connector-reach.test.ts › leaves the owner's child, comment and attachment on its item where they are through its trash, restore and purge, and carries its own`.

### `plugins/reach-fail-closed`

If the stored `connector` object of the plugin whose connector holds a plugin's connector key's source, or that plugin's stored mapping, does not read, then the server MUST answer the key as a plugin's connector key whose mapping holds no enabled kind.

**Reason:** the mapping only widens what a connector's key writes, and the cascade rule (`plugins/reach-cascade`) only narrows it. A stored value that does not read widens nothing and lifts no protection, so the key writes no more than its type map allows, and its trash, restore and purge still leave the owner's items where they are.

**Tests:** `compliance/connector-reach.test.ts › keeps the key a plugin connector key when its stored connector does not read: its trash leaves the owner's child, and it writes no target type`, `› keeps the key a plugin connector key when its stored mapping does not read: its trash leaves the owner's child, and it writes no target type`.

### `plugins/reach-target-other-source`

While a plugin's connector key holds no write on a type in its type map, when the key reads or writes an item of that type whose `source` is not its own, through any door, the server MUST answer as it answers a key whose type map does not reach that type.

**Reason:** a mapping onto a type that also holds the owner's items never opens those items to the connector. Each door answers as it does for a type the key cannot reach, so the connector learns nothing of the owner's items.

**Tests:** `compliance/connector-reach.test.ts › answers an owner's item of the target type as one the key cannot reach on every door, where the same call on its own item succeeds`.

### `plugins/reach-create-own-source`

If a plugin's connector key creates an item of an enabled kind's `target_type` that its type map does not grant write on, naming as `source` one it claims rather than its own, then the server MUST answer `403 type_not_permitted`.

**Reason:** a claimed source holds other writers' items; the mapping's reach is for the connector's own.

**Tests:** `compliance/connector-reach.test.ts › answers an owner's item of the target type as one the key cannot reach on every door, where the same call on its own item succeeds`.

### `plugins/reach-read-own`

While a plugin's connector key's mapping holds an enabled kind whose `target_type` its type map does not grant read on, when the key sends `GET /items/{id}` or `POST /items/lookup` for an item of that type whose `source` is its own, the server MUST answer it as it would were that type granted read in its type map.

**Reason:** a connector reads its own items back to update them. A listing, a search, the event stream and an export answer the type as the key's type map reaches it.

**Tests:** `compliance/connector-reach.test.ts › creates, updates, tags, links, fills the table of, trashes, restores and purges its own items on its mapped target type`.

### `plugins/reach-disabled`

When a saved mapping turns a kind off or moves it to another `target_type`, the server MUST answer every later write of the plugin's connector key to the former target type as `plugins/reach-target-own-source` does not hold for it.

**Tests:** `compliance/connector-reach.test.ts › refuses the target type once the kind is off or moved, and takes it again once it is back`.

### `plugins/reach-committed`

When a plugin's connector key writes an item, the server MUST decide the key's reach on the mapping as it stands in the write that commits the item.

**Reason:** a mapping saved while a write waits on the writer decides that write.

**Tests:** `compliance/connector-reach.test.ts › decides a write held on the writer by the mapping saved while it waited`.

### `plugins/reach-not-in-map`

When the server answers a plugin's connector key, the server MUST answer its `type_permissions` as stored, with no entry for a mapping's target type.

**Tests:** `compliance/connector-reach.test.ts › creates, updates, tags, links, fills the table of, trashes, restores and purges its own items on its mapped target type`.

## Rewriting existing items

### `plugins/rewrite-count`

When a caller holding `connectors.manage` sends `POST /plugins/{name}/connector/mapping/rewrite` with `dry_run` `true`, the server MUST answer `200` with `dry_run` `true`, the mapping's `version` and `kinds` holding, for each kind the request names or, with none named, each enabled kind, its `target_type` and the `count` of items outside the bin of that type whose `source` is the connector's source, and store nothing.

**Reason:** the owner sees how many items a rewrite would touch before asking for it.

**Tests:** `compliance/connector-mapping.test.ts › counts exactly the items under the connector's source on a kind's target type, and changes no item on a save or a rewrite`.

### `plugins/rewrite-request`

When a caller holding `connectors.manage` sends `POST /plugins/{name}/connector/mapping/rewrite` without `dry_run` `true`, the server MUST store a new rewrite request under a `number` higher than any it gave a rewrite request before, holding the mapping's `version`, the kinds counted as `plugins/rewrite-count` counts them and the time it was asked, and answer `200` with the counts, `dry_run` `false` and the `number`.

**Reason:** the connector rewrites its items; the server never transforms one. A number is never given again, so a connector that finishes an older request never clears a newer one.

**Tests:** `compliance/connector-mapping.test.ts › stores each rewrite request under its own number, which the connector clears one at a time, and refuses another key clearing one`.

### `plugins/rewrite-pending`

While the connector has not cleared a rewrite request, the server MUST answer it in `rewrites` in `GET /plugins/{name}/connector/mapping`, with its `number`, `version`, `kinds` and `requested_at`, ordered by `number`.

**Reason:** the owner may ask again before the connector runs; each request stands until the connector carries it out.

**Tests:** `compliance/connector-mapping.test.ts › stores each rewrite request under its own number, which the connector clears one at a time, and refuses another key clearing one`.

### `plugins/rewrite-unknown-kind`

If `POST /plugins/{name}/connector/mapping/rewrite` names in `kinds` a kind the plugin's `connector` does not name, or sends `dry_run` that is not a boolean or `kinds` that is not a list of text, then the server MUST answer `400 validation_error` with `details.errors` naming each `path`.

**Tests:** `compliance/connector-mapping.test.ts › stores each rewrite request under its own number, which the connector clears one at a time, and refuses another key clearing one`.

### `plugins/rewrite-permission`

If a caller without `connectors.manage` sends `POST /plugins/{name}/connector/mapping/rewrite`, then the server MUST answer `403 forbidden` with `details.required_scope` `connectors.manage`.

**Tests:** `compliance/connector-mapping.test.ts › stores each rewrite request under its own number, which the connector clears one at a time, and refuses another key clearing one`.

### `plugins/rewrite-done`

When the plugin's connector key, or local authority, sends `POST /plugins/{name}/connector/mapping/rewrite/done` with the `number` of a rewrite request the mapping holds, the server MUST clear that request alone and answer `200` with `rewrites` holding the requests still waiting; with a `number` no request holds, the same answer.

**Tests:** `compliance/connector-mapping.test.ts › stores each rewrite request under its own number, which the connector clears one at a time, and refuses another key clearing one`.

### `plugins/rewrite-done-shape`

If `POST /plugins/{name}/connector/mapping/rewrite/done` sends a body that does not hold `number` as a whole number from 1, or holds another member, then the server MUST answer `400 validation_error` with `details.errors` naming each `path`, and clear nothing.

**Tests:** `compliance/connector-mapping.test.ts › stores each rewrite request under its own number, which the connector clears one at a time, and refuses another key clearing one`.

### `plugins/rewrite-done-key`

If a caller other than the plugin's connector key or local authority sends `POST /plugins/{name}/connector/mapping/rewrite/done`, then the server MUST answer `403 forbidden` and keep the request.

**Tests:** `compliance/connector-mapping.test.ts › stores each rewrite request under its own number, which the connector clears one at a time, and refuses another key clearing one`.
