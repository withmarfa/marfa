# Plugins

A plugin is what an owner adds to Marfa: types under `common.*` or a root of its own, the edge types they use and, optionally, a connector. It arrives as a bundle, one JSON file named `<name>.plugin.json`, which `POST /plugins` installs. The server makes no request of its own to fetch one: the CLI or an app fetches the bundle and sends it (`cli/plugins-install-name`).

A bundle sets `format` to 1 and identifies the plugin by its `name`, `title`, `description`, `mark`, `maker` and `version`. The `marfa` field names the oldest Marfa release it supports. The `types` array holds type definitions with their guidance, and `edge_types` holds edge type definitions. The optional `connector` object describes the plugin's connector: its source, its kinds, its settings, its sign-in and where it runs. `PluginBundle` and `PluginConnector` in `openapi.json` define each field.

`POST /plugins` judges a bundle in this order and answers the first refusal: the bundle's shape, its connector section included, a type under a reserved root, the Marfa release it needs, the caller's permission, a connector without `connectors.manage`, guidance an app sends, the version installed, a newer version's connector source, the connector's source held elsewhere, a type the plugin did not install, a clash with a type below, a parent outside the bundle the caller may not write, each type's definition, what a newer version narrows, and each edge type.

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

### `plugins/connector-setting-choices`

If a setting of a bundle's connector of `kind` `choice` gives no `choices`, or a setting of another `kind` gives `choices`, then the server MUST answer `400 validation_error` with `details.errors` naming the setting's `choices`.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing`.

### `plugins/connector-sign-in`

If a bundle's `connector.sign_in` names in `client_id_setting`, `client_secret_setting` or `token_setting` a setting the connector does not declare, or names in `client_secret_setting` or `token_setting` a setting whose `secret` is not `true`, then the server MUST answer `400 validation_error` with `details.errors` naming that field of `connector.sign_in`.

**Tests:** `compliance/plugin-connectors.test.ts › refuses 400 validation_error a connector section with an unknown key, no kinds, a kind type outside the bundle, a choice with no choices, a secret with a default or a sign-in naming an undeclared setting, naming each path and installing nothing`.

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

### `plugins/restore-connector-held`

If `POST /restore` would restore a plugin with a connector whose source another installed plugin's connector or a live key on the instance holds, then the server MUST answer `409 connector_source_held` with `details.source` and restore nothing.

**Tests:** `compliance/plugin-connectors.test.ts › restores a plugin with a connector with its record and no host or key`.

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

**Tests:** `compliance/connector-settings.test.ts › carries the settings in an archive, names each secret without its value, and after a restore onto another machine lists the secret unreadable, on the attention list and unset to the connector`.

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
