# Archives

An archive is the tar file that `GET /export?format=archive` writes and `POST /restore` reads. The statements on archives describe archive version 2 (`archive/archive-version`), and a restore reads version 1 as `archive/restore-version-one` says. An archive that holds a new entry, a new line file or a new field that a restore must read is a later version, because a restore skips an entry, a field or a line kind it does not know (`archive/restore-unread-entry`, `archive/restore-unknown-field`, `archive/restore-unknown-line-kind`) and an older build would restore such an archive without it.

## What an archive is

### `archive/id-in-archive`

When a credential that may export sends `GET /export?format=archive`, the server MUST write into the archive's `manifest.json` an `instance_id` equal to the one the root answers.

**Reason:** the manifest is a file nothing echoes back, so an export that wrote another name, or none, would go unnoticed at every other operation.

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`.

### `archive/archive-version`

When a credential that may export sends `GET /export?format=archive`, the server MUST write the archive's `manifest.json` with a `version` of 2.

**Reason:** the version is the one marker of the archive's layout, and a restore reads every version up to its own build's and refuses a later one (`archive/restore-version`). A field or a line kind added within a version is optional to a reader of that version (`archive/archive-version-additions`): a restore skips a field it does not read and a line kind it does not know, and names the kind (`archive/restore-unknown-field`, `archive/restore-unknown-line-kind`). An archive with a new entry, line file or field that a restore must read is a new version, because an older build would skip what it does not know.

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`.

### `archive/archive-format`

When a credential that may export sends `GET /export?format=archive`, the server MUST write the archive's `manifest.json` with a `format` of `marfa-archive`.

**Reason:** a restore knows an archive by its format before it reads its version, and refuses a manifest without one, which only releases before 0.0.72 wrote (`archive/restore-format`).

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`, `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`.

### `archive/archive-written-by`

When a credential that may export sends `GET /export?format=archive`, the server MUST write the archive's `manifest.json` with a `written_by` of `marfa-server` and the version of the build, separated by a space.

**Reason:** a restore that refuses an archive with no format, or at a later version, names the build that wrote it, and only the manifest says which build that was.

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`.

### `archive/archive-media-type`

When `GET /export` names `format=archive`, the server MUST answer a tar archive with `Content-Type: application/x-tar`.

**Reason:** the line files inside are compressed and the blobs are mostly compressed already, so compressing the whole archive again costs time for nothing.

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`.

### `archive/archive-entries`

The server MUST write an archive's entries in this order: `manifest.json`, then the gzip-compressed line files `files.ndjson.gz`, `instance.ndjson.gz`, `items.ndjson.gz`, `versions.ndjson.gz`, `edges.ndjson.gz` and `rows.ndjson.gz`, then an uncompressed `blobs/<hex>` entry for each file that `files.ndjson.gz` names as `carried`.

**Reason:** the manifest comes first, so a reader knows what the archive holds before it reads the rest. The files come next, so a reader knows each file's type and size before its bytes, and finds every file a backup names without reading the items. The registrations come before the item, version, edge and row lines, and the items before their versions, so a restore can check each line as it arrives.

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`.

### `archive/archive-entry-names`

The server MUST name no entry of an archive with a colon, naming the `blobs/` entry of a file with the hex of its hash, without the `sha256:` prefix.

**Reason:** a colon is not a character a file name may hold on Windows, so an archive named with one cannot be extracted there. The hash in `files.ndjson.gz` keeps its prefix, and a restore reads the entry as that hash.

**Tests:** `compliance/restore-says.test.ts › names no entry of an archive with a colon, so each extracts on Windows`.

### `archive/archive-manifest`

The server MUST write into the manifest of an archive its `version`, its `format`, its `written_by`, a `created_at` instant, and in `file_count`, `item_count`, `version_count`, `edge_count`, `row_count`, `blob_count`, `type_count`, `edge_type_count`, `type_icon_count`, `source_count`, `setting_count`, `enforcement_count`, `connector_state_count`, `connector_agreement_count` and `app_vendor_count` the number of each kind of entry or line the archive holds.

**Reason:** `archive/archive-version`, `archive/archive-format`, `archive/archive-written-by` and `archive/id-in-archive` state the version, the format, the writing build and the instance's name in the manifest, and a restore checks every count against what it read (`archive/restore-line-counts`).

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`, `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

## What an archive carries, and what a restore takes from it

An export names the items a credential may read and the edges between them, and a restore takes them back. Each rule here says what an archive carries or what a restore does with it.

### `archive/export-without-files`

When `GET /export?format=archive` names `files=false`, the server MUST carry no `blobs/<hex>` entry, count none in `blob_count`, and name in `files.ndjson.gz` as `not_carried` each file the archive would otherwise have carried.

**Reason:** a person who wants a copy of their items, and not the often far larger files they name, can take one, and a restore of it reports in `blobs_missing` the files the instance it restores into does not hold.

**Tests:** `compliance/export.test.ts › leaves out the bytes of files and names them as not carried when it names files=false`.

### `archive/archive-same-selection`

When `GET /export?format=archive` names the filters of an NDJSON export, the server MUST select the items that export selects.

**Tests:** `compliance/export.test.ts › carries every item it holds, the bin included, when it names state=any, on both formats`, `› carries only the items in the bin when it names state=trashed, on both formats`, `› refuses a bound that is not an instant, on both output formats`.

### `archive/archive-files`

The server MUST write in the `files.ndjson.gz` of an archive one line for each file the archive names, in ascending order of `hash`, as an object holding the file's `hash`, its `mime_type`, its `size_bytes` and its `state`: `carried` for a file whose bytes the archive carries, `lost` for a file of a backup that no attached store gave whole, and `not_carried` for any other.

**Reason:** a manifest that listed every file would grow with the instance's files past what one line may hold (`archive/archive-line-cap`), so each file has its own line.

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`.

### `archive/archive-missing-blobs`

When an archive would carry a blob of which no attached store holds a copy that the copy record records, at the blob's whole size, the server MUST name the blob in `files.ndjson.gz` as `not_carried` with its MIME type and its size in bytes.

**Reason:** one lost file costs the backup that file and not the rest of the instance, and `files.ndjson.gz`, which a reader reads before the items, says which file the archive lacks. The bytes a struck or dropped copy leaves in its store are not the blob's (`stores/no-bytes-not-found`).

**Tests:** `compliance/export-missing-blob.test.ts › names a blob whose file has left the disk as not carried, and carries the rest`, `› names a blob whose struck copy is the only one as not carried, and answers a whole archive`.

### `archive/archive-missing-unrecorded`

When an item that `GET /export?format=archive` carries is of `core.file` or a type that inherits from it, in its current version or a snapshot the archive carries, and its `blob_ref` is a whole `sha256:` hash that the instance holds no blob of and that the caller may read, the server MUST name the hash in `files.ndjson.gz` as `not_carried` with a `mime_type` and a `size_bytes` of `null`.

**Reason:** a blob that a restore answered missing keeps being named by every later backup, with no record of it standing in for bytes the instance does not hold. Its type and size are not known, so they are not given.

**Tests:** `compliance/export-missing-blob.test.ts › names as not carried in a later archive a file's blob that a restore answered missing`.

### `archive/archive-missing-unreadable`

When an item that `GET /export?format=archive` carries is of `core.file` or a type that inherits from it, in its current version or a snapshot the archive carries, and its `blob_ref` is a whole `sha256:` hash that the credential requesting the archive could not read through the blob operations, the server MUST name the hash in `files.ndjson.gz` as `not_carried` with a `mime_type` and a `size_bytes` of `null`.

**Reason:** an archive written by a credential lacking `blobs.manage` leaves out the bytes of a file that only an earlier version names (`archive/archive-history-bytes`), and naming them tells a reader, a restore and `marfa export` that the archive lacks that file. The type and size are not given, and the hash is named whether or not the instance holds the blob, so the archive says no more of the blob than the blob operations do (`blobs/read-unreadable`).

**Tests:** `compliance/archive-history.test.ts › carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and names as not carried only a file's it could not`.

### `archive/archive-missing-only-blobs`

The server MUST NOT name in `files.ndjson.gz` a hash that the instance holds no blob of and that no carried file's `blob_ref` names.

**Reason:** a run of hex in an item's text, or in any other property, may be anything, such as a checksum someone noted down. Only the instance's own record, or a file's `blob_ref`, makes it a blob.

**Tests:** `compliance/export-missing-blob.test.ts › names as not carried in a later archive a file's blob that a restore answered missing`.

### `archive/archive-unreadable-only-files`

The server MUST NOT name in `files.ndjson.gz` a hash that the credential requesting the archive could not read through the blob operations and that no carried file's `blob_ref` names.

**Reason:** only the instance's record makes such a hash a blob, so naming it would tell the credential whether the instance holds bytes that the blob operations answer as unknown (`blobs/read-unreadable`). An archive written by such a credential can therefore lack, without naming it, a blob that a hash outside a file's `blob_ref` refers to. An export by the owner, or by a credential holding `blobs.manage`, reads every blob.

**Tests:** `compliance/archive-history.test.ts › carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and names as not carried only a file's it could not`.

### `archive/archive-missing-not-carried`

When the `files.ndjson.gz` of an archive names a file as `not_carried` or `lost`, the server MUST NOT count it in `blob_count` or carry a `blobs/<hex>` entry for it.

**Tests:** `compliance/export-missing-blob.test.ts › names a blob whose file has left the disk as not carried, and carries the rest`.

### `archive/archive-blob-any-store`

When one attached store's recorded copy of a blob that an archive carries is missing or not as long as the blob, and another attached store holds a recorded copy whole, the server MUST carry the blob's bytes from that other store.

**Tests:** `compliance/export-missing-blob.test.ts › carries a blob whose disk file is gone from the object store's copy`.

### `archive/archive-bytes-verified`

If the bytes `GET /export?format=archive` reads for a blob do not hash to the blob's name, then the server MUST end the response with an error and not with a clean end.

**Reason:** the line that names the blob as carried has already been sent, so the archive is cut short rather than carrying other bytes under the blob's name. The bytes are checked as they are sent rather than before, because checking first would read every blob twice on every export.

**Tests:** `compliance/export-missing-blob.test.ts › ends the response with an error when a copy's bytes do not hash to the blob's name, and strikes the copy`.

### `archive/archive-bytes-struck`

If the bytes `GET /export?format=archive` reads from a store's copy of a blob are as long as the blob and do not hash to its name, and the copy still does not hash to the name when the server reads it again, then the server MUST remove that copy from the copies `GET /blobs/{hash}/copies` lists.

**Reason:** the next export then reads the blob from another store that holds it, or names it as `not_carried`, as it does once `blob-integrity` has struck the copy. The first read is not held against a replacement of the copy, so the copy is read again before it is removed: a copy put right in between is kept.

**Tests:** `compliance/export-missing-blob.test.ts › ends the response with an error when a copy's bytes do not hash to the blob's name, and strikes the copy`, `› keeps a copy that hashes to the blob's name when the export reads it again, though its first read did not`.

### `archive/archive-read-fault-kept`

If a read of a blob's copy by `GET /export?format=archive` fails or ends before the blob's size, then the server MUST NOT strike the copy for it.

**Reason:** a read that goes wrong says nothing of the bytes the store holds.

**Tests:** `compliance/export-missing-blob.test.ts › strikes no copy when a read of a blob's bytes fails`, `› strikes no copy when a read of a blob's bytes ends short`.

### `archive/archive-blob-gone`

If a blob that the `files.ndjson.gz` of `GET /export?format=archive` names as `carried` has no record, or no recorded copy that a store holds whole, when its entry is due, then the server MUST end the response with an error and not with a clean end.

**Reason:** the line that names the blob as carried has already been sent, so an archive that left the entry out would claim a file it does not hold.

**Tests:** `compliance/export-missing-blob.test.ts › ends the response with an error when a listed blob's file goes before its entry is written`.

### `archive/archive-store-unavailable`

If a store fails, or does not answer within 15 seconds, while the server checks a copy of a blob that `GET /export?format=archive` would carry, and no other attached store holds a recorded copy of the blob whole, then the server MUST answer `503 blob_store_unavailable`.

**Reason:** a store that cannot answer is no evidence that the copy is gone, so the blob is not named as `not_carried`. A copy that another store holds whole is carried from there. The checks are made before the response begins, so the refusal is an ordinary answer and not a stream cut short.

**Tests:** `compliance/export-missing-blob.test.ts › answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob`.

### `archive/archive-only`

The server MUST hold nothing in an archive but `manifest.json`, `files.ndjson.gz`, `instance.ndjson.gz`, `items.ndjson.gz`, `versions.ndjson.gz`, `edges.ndjson.gz`, `rows.ndjson.gz` and the `blobs/` entries.

**Reason:** an archive carries no credential, so no key, session, grant, passkey, connector registration, webhook subscription, inbound endpoint or `marfa.secrets`, no audit log or event log, and no tombstone or runtime record, such as a run, a hold, a delivery, a folder report or a bulk job, though an instance holds them. A restore means setting up sign-in again.

**Tests:** `compliance/export.test.ts › holds nothing in an archive but its manifest, line files and blobs, and carries no webhook`.

### `archive/archive-types`

The server MUST carry in the `instance.ndjson.gz` of an archive a `type` line for every type, and an `edge_type` line for every edge type, registered on the instance beside the ones the build ships, whatever the selection and whatever the credential may read.

**Reason:** the registrations are the instance's own and not the selected items', so a restore into a new instance gets the types its items need.

**Tests:** `compliance/export.test.ts › carries every registered type and edge type in an archive, whatever its selection and credential reach`.

### `archive/archive-type-guidance`

The server MUST carry the `guidance` of a type in the `type` line of an archive.

**Reason:** guidance is part of the type's definition, so a backup that left it out would lose it on a move to a new instance.

**Tests:** `compliance/type-guidance-restore.test.ts › carries a type's guidance and status word descriptions through an export and a restore into a new instance`.

### `archive/archive-type-icons`

The server MUST carry in the `instance.ndjson.gz` of an archive one `type_icon` line, holding the `type_id` and the `icon`, for each icon the owner has chosen for a type, and count them in the manifest's `type_icon_count`.

**Reason:** the owner's icons are kept beside the definitions and not in them (`types/icon-kept`), so an archive that carried only definitions would lose every choice on a move to a new instance.

**Tests:** `compliance/type-icons.test.ts › carries the owner's icons in an archive and adds back those the instance lacks, replacing none`.

### `archive/restore-type-icons`

When `POST /restore` reads a `type_icon` line, the server MUST set that icon for the type only if the instance has no owner icon for it, count each icon set in `type_icons_added` and each icon left in `type_icons_skipped`, and replace no owner icon the instance already has.

**Reason:** a restore keeps each icon the instance already holds and sets one only where there is none, and an icon the owner chose here since the export is newer than the archive's.

**Tests:** `compliance/type-icons.test.ts › carries the owner's icons in an archive and adds back those the instance lacks, replacing none`.

### `archive/restore-type-icons-skipped`

If a `type_icon` line of an archive names an icon that `types/icon-name` refuses, then the server MUST skip that line, set no icon for the type, and count it in `type_icons_skipped` and under `unknown_icon` in `type_icons_skipped_reasons`; an icon skipped because the instance has an owner icon for the type is counted under `already_set`.

**Reason:** an archive made by a build that pins other sets or versions holds a well-formed line this instance cannot draw, and one such line must not keep an owner from restoring everything else, as an edge a restore cannot place is skipped and counted instead of refusing the archive (`archive/restore-edge-skips`). The rule covers `type_icon` lines only: an archived type definition is held to the same check as a registered one, so a definition whose `display_hints.icon` `types/icon-name` refuses, a bare name among them, refuses the archive. Until the first public release an archive is read only by the build that wrote it, so no archive from before icons were Iconify IDs is expected to restore.

**Tests:** `compliance/type-icons.test.ts › skips and counts an icon outside the pinned sets, and refuses a line that names no type or no icon string, writing nothing`.

### `archive/restore-type-icons-refused`

If a `type_icon` line of an archive is not an object holding a `type_id` and a string `icon`, or names a type that neither the archive nor the instance registers, then the server MUST answer `POST /restore` with `400 invalid_schema` and write nothing.

**Reason:** a line that is damaged, or an icon for a type nothing registers (`types/icon-missing-type`), is a fault in the archive and not a difference of release, and a restore checks every line before it writes any.

**Tests:** `compliance/type-icons.test.ts › skips and counts an icon outside the pinned sets, and refuses a line that names no type or no icon string, writing nothing`.

### `archive/archive-sources`

The server MUST carry in the `instance.ndjson.gz` of an archive one `source` line, holding the `source` code and its `name` and `mark` or `null` for each, for every source with a name or mark set in a backup and, in an export, for each such source of the items the archive carries, and count them in the manifest's `source_count`.

**Reason:** a source's name and mark are kept beside its items and not in them, so an archive that carried only items would lose them on a move to a new instance.

**Tests:** `compliance/source-names.test.ts › carries a named source in an archive and adds it back where the instance names none, replacing none`.

### `archive/restore-sources`

When `POST /restore` reads a `source` line, the server MUST set that name and mark on the source only if the instance has neither set on it, count each source set in `sources_added` and each line left in `sources_skipped`, and replace no name or mark the instance already has.

**Reason:** a restore keeps each name and mark the instance already holds and sets them only where there are none, and a name set here since the export is newer than the archive's.

**Tests:** `compliance/source-names.test.ts › carries a named source in an archive and adds it back where the instance names none, replacing none`.

### `archive/restore-sources-app`

When `POST /restore` reads a `source` line whose code starts with `oauth:`, the server MUST set the name and mark on that code with `restored:` before it, the code the restore gives the items of that source.

**Reason:** a restored item keeps no app's authority (`keys-and-oauth/claims-reserved`), so its source's name follows it to the restored code.

**Tests:** `compliance/source-names.test.ts › skips and counts a mark outside the pinned sets, and refuses a damaged source line, writing nothing`.

### `archive/restore-sources-shared-code`

If two `source` lines of an archive land on one code once `archive/restore-sources-app` has mapped them, then the server MUST keep the line that already carries that code, whatever the order of the lines, skip the other, and count it in `sources_skipped` and under `duplicate_code` in `sources_skipped_reasons`.

**Reason:** an instance can name both an app's source and the restored code it maps to, and an archive of it has to restore, not be refused.

**Tests:** `compliance/source-names.test.ts › restores the line that carries the code when two land on one`.

### `archive/restore-sources-skipped`

If a `source` line of an archive names a `mark` that `types/icon-name` refuses, then the server MUST skip that line, set nothing on the source, and count it in `sources_skipped` and under `unknown_mark` in `sources_skipped_reasons`; a line skipped because the instance has a name or mark set on the source is counted under `already_set`.

**Reason:** an archive made by a build that pins other icon sets holds a well-formed mark this instance cannot draw, as `archive/restore-type-icons-skipped` says of a type's icon.

**Tests:** `compliance/source-names.test.ts › skips and counts a mark outside the pinned sets, and refuses a damaged source line, writing nothing`.

### `archive/restore-sources-refused`

If a `source` line of an archive is not an object, holds a `source` code that `keys-and-oauth/source-code-length` refuses, as it stands or once `archive/restore-sources-app` has mapped it, holds neither a `name` nor a `mark`, holds a `name` that `PATCH /sources/{source}` could not store as it stands, or holds a `mark` that is not a string, then the server MUST answer `POST /restore` with `400 invalid_schema` and write nothing.

**Tests:** `compliance/source-names.test.ts › skips and counts a mark outside the pinned sets, and refuses a damaged source line, writing nothing`.

### `archive/archive-settings`

When the credential requesting `GET /export?format=archive` holds `config.manage`, the server MUST carry in `instance.ndjson.gz` one `setting` line, holding the setting's `key` and its `value`, for each setting stored on the instance apart from a secret and those that describe this machine: `sign_in_address`, `addresses`, `backup_path`, the `object_store_` settings, `allow_private_addresses`, `otel_service_name` and `otel_resource_attributes`.

**Reason:** an owner's settings are their own choices, and a restore that reset them would change the instance without saying so. The addresses name where this instance answers and the destination where it keeps copies and backups, which a move changes, and whether the server may send to private addresses depends on the network around the machine. The instance's name is its own to set again, so no `setting` line carries it.

**Tests:** `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`, `compliance/restore-says.test.ts › restores each enforcement setting an instance lacks, an empty block included, keeps each it has, and does not carry the name`.

### `archive/archive-secret-named`

When the credential requesting `GET /export?format=archive` holds `config.manage`, the server MUST carry in `instance.ndjson.gz` one `setting` line holding the `key` and `secret` `true`, and no `value`, for each secret setting stored on the instance other than `object_store_secret_access_key`.

**Reason:** an archive leaves the machine, and the key that seals a secret never does, so the line says only that the secret was set, for a restore to report (`archive/restore-secrets-to-set`). The object store's secret belongs to this machine as the store's other settings do, so a restore onto another machine does not ask for it.

**Tests:** `compliance/secret-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown`.

### `archive/restore-secrets-to-set`

When `POST /restore` reads a `setting` line naming a secret setting for which the instance holds no value it can open, the server MUST name the setting's key in `secrets_to_set`.

**Reason:** the owner learns from the restore's answer which secrets to set again on this machine, and the attention list keeps saying so until they are (`instance/attention-secret-to-set`). A restore never fails for them.

**Tests:** `compliance/secret-settings.test.ts › is reported on a restore, and on the attention list, when the archive's instance had it set and this one holds no value it can read`.

### `archive/archive-enforcement`

When the credential requesting `GET /export?format=archive` holds `config.manage` and the instance stores enforcement settings, the server MUST carry in `instance.ndjson.gz` one `enforcement` line holding the strict mode, the source allowlist and the source filter as `/config` reads them.

**Reason:** strict mode and the source lists are what keeps a restored instance from taking writes the original refused, so a move that dropped them would open it.

**Tests:** `compliance/restore-says.test.ts › restores each enforcement setting an instance lacks, an empty block included, keeps each it has, and does not carry the name`.

### `archive/archive-enforcement-unreadable`

If the enforcement settings the instance stores do not read, then the server MUST answer `GET /export?format=archive` with `409 enforcement_unreadable` and send no archive.

**Reason:** unreadable enforcement settings hold every key closed (and name themselves on `GET /health`), so a key's archive would hold no items and a restore of it would import nothing, which a move by export would not notice. The owner sets the settings again and exports again.

**Tests:** `compliance/restore-says.test.ts › refuses an export while the enforcement settings do not read, and a backup holds the items and names them`.

### `archive/backup-enforcement-unreadable`

If the enforcement settings the instance stores do not read, then the server MUST take a backup with every item and no `enforcement` line, naming `enforcement` in the manifest's `unreadable`.

**Reason:** a backup is the server's own and reads every item whatever the settings say, so it goes on. Its manifest says what it left out, so a restore can say so.

**Tests:** `compliance/restore-says.test.ts › refuses an export while the enforcement settings do not read, and a backup holds the items and names them`.

### `archive/archive-manifest-unreadable`

If an archive leaves out no line because it did not read, then the server MUST NOT write `unreadable` into its manifest.

**Reason:** `unreadable` names only what an archive left out (`archive/archive-enforcement-unreadable`), so an archive that holds everything carries no such list.

**Tests:** `compliance/restore-says.test.ts › refuses an export while the enforcement settings do not read, and a backup holds the items and names them`.

### `archive/restore-enforcement`

When `POST /restore` reads an `enforcement` line, the server MUST store each of its settings (`strict_mode`, `source_allowlist`, `source_filter`) that the instance does not store, keep each that it does, and name each stored setting in `enforcement_added` and each kept one in `enforcement_skipped`.

**Reason:** a restore keeps each enforcement setting the instance stores and stores only the rest (`archive/restore-settings`). An empty enforcement block holds no setting, so each archived one is added to it. Enforcement settings the instance stores that do not read keep every archived one out, since what they hold is not known.

**Tests:** `compliance/restore-says.test.ts › restores each enforcement setting an instance lacks, an empty block included, keeps each it has, and does not carry the name`.

### `archive/restore-settings`

When `POST /restore` reads a `setting` line, the server MUST store that setting only where the instance has none stored, and replace no setting the instance has.

**Reason:** a restore keeps each setting row the instance holds and stores only those it lacks, and a setting chosen here since the export is newer than the archive's.

**Tests:** `compliance/export-instance-lines.test.ts › restores the settings, connector state and agreements the instance lacks, and replaces none it holds`, `compliance/restore-settings-permission.test.ts › stores an archive's settings for an app that holds config.manage as well`.

### `archive/restore-settings-together`

If the settings that `POST /restore` would store, judged with the instance's own, break a rule that `/config` applies across settings (`instance/live-policy-validation`), then the server MUST refuse the archive with the `400 validation_error` and `details.errors` that `/config` answers for them, and store nothing.

**Reason:** a restore is not a way to hold settings that the configuration door would refuse, such as version windows out of order.

**Tests:** `compliance/export-instance-lines.test.ts › refuses settings the instance cannot hold together, answering as /config does, and stores none`.

### `archive/restore-reporting-without-receiver`

When `POST /restore` reads a `setting` line that turns `heartbeat_enabled` or `error_reporting_enabled` on where the server has no receiver for it, the server MUST restore the archive and name the key in `settings_without_receiver`.

**Reason:** the heartbeat and error reporting are on by default, so an archive that records them on asks for what the instance already holds, and a server with no receiver sends nothing either way. A restore that refused for them would make a backup of one server unusable on another.

**Tests:** `compliance/restore-says.test.ts › restores a reporting setting that is turned on where no receiver is set, names it, and still refuses turning it on again from off`.

### `archive/restore-setting-twice`

If the `instance.ndjson.gz` of an archive carries more than one `setting` line for the same key, then the server MUST answer `400 validation_error`.

**Reason:** two values for one setting have no single meaning, and the restore would otherwise count both as stored.

**Tests:** `compliance/export-instance-lines.test.ts › refuses an archive that carries one setting twice, and stores neither value`.

### `archive/restore-setting-unknown`

When `POST /restore` reads a `setting` line that names a setting this instance does not have, the server MUST leave the line out and name its key in `settings_dropped`.

**Reason:** an archive from before a setting was removed or renamed still restores, and the owner is told what it did not carry over instead of finding a setting silently reset.

**Tests:** `compliance/export-instance-lines.test.ts › leaves out a setting the instance does not have, names it, and restores the rest`.

### `archive/restore-setting-machine`

If the `instance.ndjson.gz` of an archive carries a `setting` line for `sign_in_address`, `addresses`, `backup_path`, an `object_store_` setting, `allow_private_addresses`, `otel_service_name` or `otel_resource_attributes`, then the server MUST answer `400 validation_error` naming the key and store nothing of the archive.

**Reason:** these settings describe the destination machine and its network. Marfa omits them when it writes an archive (`archive/archive-settings`).

**Tests:** `compliance/restore-settings-permission.test.ts › refuses an archive carrying a setting that describes this machine, even to an app holding config.manage, and writes nothing, where the archive without it restores`.

### `archive/restore-settings-permission`

If an app's access token that `keys-and-oauth/step-up-recent` admits to `POST /restore` or `POST /backups/{instance_id}/{name}/restore`, and that does not hold `config.manage`, sends that restore for an archive that would store a setting, a secret to set again or an enforcement setting the instance does not store, then the server MUST answer `403 forbidden` with `details.required_scope` `config.manage` and `details.settings` naming each setting the archive would store, with `enforcement` for the enforcement settings.

**Reason:** adding a setting requires the same permission as changing it at `/config`. This applies to the instance's own backup if a setting has been removed since the backup was taken. A token without `backups.manage` is refused first (`keys-and-oauth/step-up-permission-first`), and one whose sign-in is not recent is challenged first (`keys-and-oauth/step-up-challenge`).

**Tests:** `compliance/restore-settings-permission.test.ts › refuses an app without config.manage an archive that would store a setting, writing no item, file or setting, where the same archive without it restores`, `› refuses an app without config.manage an archive whose only instance line is an enforcement setting, which an app holding it restores`, `› refuses an app without config.manage an archive naming a secret the instance would ask to be set again, which an app holding it restores`, `› holds a backup restore to the same rule: it restores while the instance stores the backup's settings, and needs config.manage once one is gone`.

### `archive/restore-settings-permission-unwritten`

When the server refuses a restore under `archive/restore-settings-permission`, the server MUST write none of the archive's items, files and settings.

**Tests:** `compliance/restore-settings-permission.test.ts › refuses an app without config.manage an archive that would store a setting, writing no item, file or setting, where the same archive without it restores`, `› refuses an app without config.manage an archive whose only instance line is an enforcement setting, which an app holding it restores`, `› refuses an app without config.manage an archive naming a secret the instance would ask to be set again, which an app holding it restores`, `› judges a restore's settings after every write accepted before it began, and places no file when it refuses`, `› holds a backup restore to the same rule: it restores while the instance stores the backup's settings, and needs config.manage once one is gone`.

### `archive/restore-settings-after-writes`

When the server judges whether a restore would store a setting under `archive/restore-settings-permission`, the server MUST judge it on the stored settings after every write the server accepted before the restore began has committed.

**Reason:** a change at `/config` that the server accepted before the restore began counts, even when it had not yet committed when the restore began.

**Tests:** `compliance/restore-settings-permission.test.ts › judges a restore's settings after every write accepted before it began, and places no file when it refuses`.

### `archive/restore-settings-permission-none`

When an app's access token that `keys-and-oauth/step-up-recent` admits to `POST /restore` or `POST /backups/{instance_id}/{name}/restore`, and that does not hold `config.manage`, sends that restore for an archive whose settings the instance already stores or this server does not have, the server MUST restore the archive as it would for a token that also holds `config.manage`.

**Reason:** such an archive stores no setting, so `archive/restore-settings-permission` does not hold it back.

**Tests:** `compliance/restore-settings-permission.test.ts › refuses an app without config.manage an archive that would store a setting, writing no item, file or setting, where the same archive without it restores`, `› restores for an app without config.manage an archive whose every setting the instance already stores, and changes none`, `› restores for an app without config.manage an archive whose only setting this server does not have, and names it as dropped`, `› holds a backup restore to the same rule: it restores while the instance stores the backup's settings, and needs config.manage once one is gone`.

### `archive/archive-connector-state`

When the credential requesting `GET /export?format=archive` holds `connectors.manage`, the server MUST carry in `instance.ndjson.gz` one `connector_state` line, holding the `source` and its `state` document, for each source with a connector state document.

**Reason:** the state is what a connector has agreed with the instance about its source, and without it a restored instance has every connector import everything again. A connector's registration belongs to its key and stays out.

**Tests:** `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

### `archive/archive-app-vendors`

When a credential sends `GET /export?format=archive`, the server MUST write an `app_vendor` line in `instance.ndjson.gz` for each vendor an app or the owner holds where the credential reads the vendor's wildcard `app.<vendor>.*` or a type then registered under it, both when the export selects the line and when it sends it, with its `vendor`, `client_id` (`null` while the owner holds it) and `claimed_at`, and count them in the manifest's `app_vendor_count`.

**Reason:** a type map entry for the bare name `app.<vendor>` is no wildcard and names no type under it, so it neither carries a binding nor masks a wildcard that reads the vendor. At send, the types registered then decide, so a binding whose only readable type was removed meanwhile is not sent.

**Tests:** `compliance/app-vendors.test.ts › carries each vendor binding to a credential that reads the vendor, and none to one that does not`, `› decides a binding on the vendor's wildcard, never on an entry for the bare namespace`, `› ends an export whose credential reads no type under a vendor by the time it sends the vendor's binding`.

### `archive/restore-app-vendor`

When the local command sends `POST /restore` with an `app_vendor` line for a vendor no one holds on the instance, the server MUST give the vendor to the `client_id` the line names, or hold it for the owner where that is `null`, and count it in `app_vendors_added`.

**Tests:** `compliance/app-vendors.test.ts › restores a binding for a vendor no app holds, and skips one for a vendor an app holds`.

### `archive/restore-app-vendor-held`

When `POST /restore` reads an `app_vendor` line for a vendor an app or the owner holds on the instance, the server MUST leave the vendor with whoever holds it and count the line in `app_vendors_skipped`.

**Reason:** a restore never takes an app's machinery from the app that holds it.

**Tests:** `compliance/app-vendors.test.ts › restores a binding for a vendor no app holds, and skips one for a vendor an app holds`.

### `archive/restore-vendor-from-types`

When `POST /restore` leaves a vendor no one holds with a type under it, the server MUST give the vendor to an app where every type under it carries a `created_by` naming that app's grant or a key minted through that app and the instance knows the app, and otherwise hold the vendor for the owner.

**Reason:** an archive of version 1 carries no `app_vendor` line, and an owner's archive carries none for a vendor no one held, so a restore gives each vendor to the one app that made all its types, as an upgraded database does. Where the owner made a type under it, or several apps, or an app the instance no longer knows, no order of making says whose machinery it is, and an app that claimed it first would reach what the owner keeps there, so the owner gives it (`keys-and-oauth/app-vendor-move`).

**Tests:** `compliance/app-vendors.test.ts › restores a version 1 archive, giving a vendor no one holds to the one app that made its types`, `› holds a vendor two apps made types under for the owner, refuses it to either app, and gives it to the app the owner names`, `› holds for the owner a vendor whose types only the owner made, from an archive of either version, and refuses it to an app`.

### `archive/restore-app-vendor-by-app`

When an app's sign-in sends `POST /restore`, the server MUST write no `app_vendor` line the archive carries, count each in `app_vendors_skipped`, and hold for the owner each vendor no one holds with a type under it.

**Reason:** giving a vendor to an app is the owner's to approve (`keys-and-oauth/app-vendor-move-owner-only`), and an archive an app sends could name any app. A key is refused a restore whatever it holds (`keys-and-oauth/step-up-key-refused`), so an app's sign-in and the local command are the only credentials that restore.

**Tests:** `compliance/app-vendors.test.ts › writes no vendor binding from a restore an app sends, and holds the vendors of its types for the owner`.

### `archive/restore-app-vendor-type-held`

If an app's sign-in sends `POST /restore` with a type the instance does not register under an `app.<vendor>` namespace another app or the owner holds, then the server MUST answer `403 forbidden` with `details.namespace` naming `app.<vendor>`, and restore nothing.

**Reason:** a restore registers a type under a held vendor only where registering it directly would (`types/app-vendor-claimed-refused`), whether the archive is sent or is a named backup.

**Tests:** `compliance/app-vendors.test.ts › refuses an app's restore a type under a vendor the owner or another app holds`.

### `archive/restore-app-vendor-invalid`

If an `app_vendor` line in `instance.ndjson.gz` lacks a `vendor` that is an `app.<vendor>` namespace, a `client_id` that is a non-empty string or `null`, or a `claimed_at` that is an RFC 3339 instant without a leap second, then the server MUST answer `400 validation_error` naming the line and, in `details.field`, the field, and restore nothing.

**Reason:** Marfa stores an instant as milliseconds since 1970, which has no second 60, so a `claimed_at` inside a leap second (RFC 3339 section 5.7) is refused rather than moved to another instant.

**Tests:** `compliance/app-vendors.test.ts › refuses an app_vendor line whose client_id is empty or whose claimed_at is no instant`, `› refuses a claimed_at inside a leap second with 400 naming the field`.

### `archive/restore-app-vendor-time`

When `POST /restore` writes an `app_vendor` line whose `claimed_at` is an RFC 3339 instant without a leap second in any form, with or without fractional seconds and with `Z` or a numeric offset, the server MUST store the vendor's `claimed_at` as that instant in UTC with milliseconds, as `GET /app-vendors` then answers it.

**Tests:** `compliance/app-vendors.test.ts › restores a claimed_at in any RFC 3339 form and keeps it as the instant`.

### `archive/restore-connector-state`

When `POST /restore` reads a `connector_state` line, the server MUST store that state document only where the instance holds none for the source, and replace none it holds.

**Tests:** `compliance/export-instance-lines.test.ts › restores the settings, connector state and agreements the instance lacks, and replaces none it holds`.

### `archive/archive-connector-agreements`

When the credential requesting `GET /export?format=archive` holds `connectors.manage`, the server MUST carry in `instance.ndjson.gz` one `connector_agreement` line, holding the `source`, the `item_id`, `waiting` and the `record`, for each connector agreement whose item the archive carries.

**Reason:** an agreement pairs an item with a record outside, so it travels with the item and not without it.

**Tests:** `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

### `archive/restore-connector-agreements`

When `POST /restore` reads a `connector_agreement` line whose item the instance holds once the archive's items are written, the server MUST store that agreement only where the instance holds none for the source and the item, and replace none it holds.

**Tests:** `compliance/export-instance-lines.test.ts › restores the settings, connector state and agreements the instance lacks, and replaces none it holds`.

### `archive/archive-no-webhooks`

The server MUST NOT carry a webhook subscription in an archive.

**Reason:** a subscription belongs to the key or app that made it, and neither travels in an archive (`archive/archive-only`), so a restored subscription would belong to nothing. The owner makes it again after a restore.

**Tests:** `compliance/export.test.ts › holds nothing in an archive but its manifest, line files and blobs, and carries no webhook`, `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

### `archive/archive-no-cloud-link`

The server MUST NOT carry a link to Marfa Cloud, or any of its secrets, in an archive.

**Reason:** a link belongs to the instance that made it, and a backup is an archive, so an instance restored elsewhere would otherwise take over the first one's name. The owner links the restored instance again.

**Tests:** `compliance/cloud-link.test.ts › puts no secret of a link in an answer, an event, the audit log or an archive`.

### `archive/archive-no-inbound`

The server MUST NOT carry an inbound endpoint, an inbound address or an inbound delivery in an archive.

**Reason:** an inbound address is a credential (`inbound-webhooks/endpoint-path-redacted`), and it belongs to the connector's registration, which stays out (`archive/archive-connector-state`). A restored address would let a sender post to an instance that holds no connector for it.

**Tests:** `compliance/export-no-inbound.test.ts › carries the connector's state and none of its endpoint, address or deliveries`.

### `archive/archive-history`

When `GET /export?format=archive` carries an item, the server MUST carry with it every stored snapshot below the item's current version that `archive/archive-history-reach` admits, however many pages of history they fill.

**Reason:** one page of history is not complete history.

**Tests:** `compliance/archive-history.test.ts › carries every stored snapshot below an item's version, across more than one page of history`.

### `archive/archive-history-lines`

When `GET /export?format=archive` carries a snapshot, the server MUST write it as its own line of `versions.ndjson.gz`, naming its item in `item_id`, with the lines in the order of their items in `items.ndjson.gz` and, for one item, in ascending order of version.

**Reason:** an item that carried its history on its own line would grow that line with every edit, past what one line may hold (`archive/archive-line-cap`). In this order a restore judges each version against the item it has already read (`archive/restore-history-order`).

**Tests:** `compliance/archive-history.test.ts › puts each snapshot on its own line of versions.ndjson.gz, in the order of its item and then of its version`.

### `archive/archive-history-reach`

When an archive requested by a credential carries a snapshot, the server MUST carry it only if that credential may read the type that snapshot had.

**Reason:** a current grant on a type does not grant access to an item's earlier type.

**Tests:** `compliance/archive-history.test.ts › carries only the snapshots the exporting key may read under the type each had`.

### `archive/archive-history-bytes`

When a snapshot in an archive requested by a credential names a blob, the server MUST carry the blob's bytes if and only if that credential could read the blob through the blob operations.

**Reason:** a historical reference keeps bytes from orphan collection but does not grant read permission (`blobs/lend-earlier-version`).

**Tests:** `compliance/archive-history.test.ts › carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and names as not carried only a file's it could not`.

### `archive/archive-selection-read`

The server MUST read every item, edge, registration and record an archive carries from one snapshot of the instance, and count in its manifest exactly the items, edges and rows its line files hold.

**Reason:** one snapshot is one committed state, so no write can make the items and edges an archive carries disagree with each other, and the selection is read whole before the first byte is sent, because the manifest comes first and a tar header carries each entry's size.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › counts every item the archive holds in its manifest when the headers arrive`.

### `archive/archive-item-as-read`

When an item is written after the selection read of `GET /export?format=archive` has begun, the server MUST carry the item as it stood before that write.

**Reason:** the archive's selection is one snapshot, taken before its headers are sent.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › carries an item as it stood when the export read it, whatever is written to it after the headers`.

### `archive/archive-no-later-item`

When an item is created after the selection read of `GET /export?format=archive` has begun, the server MUST NOT carry it.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › does not carry an item created after the headers arrived`.

### `archive/archive-edge-before`

When an edge between two carried items exists when the selection read of `GET /export?format=archive` begins, the server MUST carry the edge.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › carries an edge created before the export began, and not one created after its headers arrived`.

### `archive/archive-no-later-edge`

When an edge is created after the selection read of `GET /export?format=archive` has begun, the server MUST NOT carry it.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › carries an edge created before the export began, and not one created after its headers arrived`.

### `archive/archive-restorable`

When `GET /export?format=archive` returns a complete archive, the server MUST ensure that the archive passes `POST /restore` validation into an empty store running the same build, without skipping any carried item or edge.

**Reason:** `schema.write` permits replacements that leave an earlier item that a restore refuses, such as a type that becomes an event while an item holds a rule no calendar read can unfold (`types/evolve-schema-write`), so the export checks every item and edge it carries with the restore's own checks. The guarantee excludes destination conflicts and the destination's own settings; missing blobs keep their declared missing status.

**Tests:** `compliance/export-write-order.test.ts › restores an archive as its selection stood when read, whatever lands while it is read`, `› restores a custom type retyped away and deleted between archive pages`.

### `archive/archive-items-shape-free`

When `GET /export?format=archive` selects an item that is not of a `core` or `system` type that this build ships, the server MUST NOT refuse the export because the item lacks a field its type requires, holds a value its type's field does not accept, or is of a type that is not registered.

**Reason:** the export checks the selection with the restore's checks (`archive/archive-restorable`), and a restore takes such an item (`archive/restore-items-shape-free`, `archive/restore-items-orphan`). A type gains a required field while its items stand (`types/field-gained`), and a forced delete leaves the items of a type (`types/delete-force`), so an instance that refused to export them could not be backed up.

**Tests:** `compliance/restore-items-shape.test.ts › restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`, `› restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`.

### `archive/archive-edges-unregistered`

When `GET /export?format=archive` selects an edge whose edge type is not registered, the server MUST NOT refuse the export because the edge type is not registered.

**Reason:** the export checks the selection with the restore's checks (`archive/archive-restorable`), and a restore takes such an edge (`archive/restore-edges-unregistered`). A forced delete leaves the edges of an edge type (`edges/types-delete-force-keeps`), so an instance that refused to export them could not be backed up.

**Tests:** `compliance/restore-edges-unregistered.test.ts › keeps the edge as the archive holds it, reads it as the origin does, and restores its own export again`.

### `archive/archive-edges-end-unregistered`

When `GET /export?format=archive` selects an edge with an end that is an item of a type that is not registered, the server MUST NOT refuse the export because the edge type's `from_type_constraints` or `to_type_constraints` do not admit that end.

**Reason:** the export checks the selection with the restore's checks (`archive/archive-restorable`), and a restore takes such an edge (`archive/restore-edges-end-unregistered`). A forced delete leaves the items of a type and the edges between them (`types/delete-force`), so an instance that refused to export them could not be backed up.

**Tests:** `compliance/restore-edges-constraint-types.test.ts › keeps an edge whose from constraint names the deleted type, and still refuses a registered end the constraint does not admit`, `› keeps an edge whose to constraint names the deleted type`, `› judges a constraint that lists a registered and a deleted type by the endpoint: an end of the deleted type is kept, and an end of a registered type must be one the list names`.

### `archive/archive-entries-refused`

If an item or an edge of the selection of `GET /export?format=archive` is one a restore would refuse or skip, then the server MUST answer `409 export_entry_unrestorable` without sending archive bytes, with `details.entry` naming it by its `kind`, `id`, `type` and `field` and the `code` that restore refuses it with or the reason restore skips it for.

**Reason:** the fault is in the instance's own data, such as an item that a type's replacement schema no longer accepts, so the owner needs the item named to correct it.

**Tests:** `compliance/export-entries-refused.test.ts › answers 409 naming the entry, and exports once the entry is corrected`.

### `archive/archive-line-cap`

If an item, an earlier version of an item or an edge of the selection of `GET /export?format=archive` would take more than 67108864 bytes on its archive line, then the server MUST answer `409 export_entry_unrestorable` without sending archive bytes, with `details.entry` naming the item or edge by its `kind` and `id`, and naming an earlier version in `field` as `versions.<version>`.

**Reason:** a restore reads no line longer than 67108864 bytes (`archive/restore-text-cap`). An archive that held a longer line would be refused by every restore, and the owner would learn it only when they needed the archive. `max_bulk_request_bytes` may be at most half this size ("Stored settings" in `instance.md`), so an item or edge written through the bulk operations fits on its line.

**Tests:** `compliance/archive-line-cap.test.ts › refuses an export and a backup whose item line is past the limit, naming the item`, `› refuses an export whose version line is past the limit, naming the item and the version`.

### `archive/archive-spool-ended`

When a `GET /export?format=archive` response ends, whether the archive was read whole or the client left, the server MUST leave nothing of the export on disk.

**Reason:** the export keeps what it has read in the `tmp` folder of the disk store, and a copy of the instance's content that nobody will read must not stay there.

**Tests:** `compliance/export-spool.test.ts › leaves nothing in the spool once the whole archive has been read`, `› leaves nothing in the spool once the client has left`.

### `archive/archive-spool-fault`

If the selection read, the check of its lines or the sending of `GET /export?format=archive` fails, then the server MUST leave nothing of the export on disk.

**Tests:** `compliance/export-faults.test.ts › is answered with an error, not an archive, and leaves nothing of the export on disk`.

### `archive/archive-spool-start`

When the process starts, the server MUST remove whatever an export that a stopped process was writing left on disk.

**Reason:** a process that is stopped during an export cannot remove its own copy.

**Tests:** `compliance/export-spool.test.ts › keeps the spool of an export a stopped process was writing until the next start, and then clears it`.

### `archive/archive-spool-reserve`

Where an instance keeps a reserve of free space, if the files that a `GET /export?format=archive` writes before its first byte would leave less free on the volume that holds the disk store's folder than the reserve, then the server MUST answer `507 insufficient_storage` without sending archive bytes.

**Reason:** the export keeps what it has read in the disk store's `tmp` folder, and the shipped image puts the database on the same volume, so the export of a large instance could take the room every other write needs (`blobs/upload-reserve`).

**Tests:** `compliance/export-reserve.test.ts › is refused 507 insufficient_storage before any archive byte, naming the reserve and the room, and leaves nothing on disk`, `› is sent whole while the volume has room beside the reserve, which is the witness for the refusal below`.

### `archive/archive-failed-read`

If a read fails after the body of `GET /export?format=archive` has begun, then the server MUST end the response with an error and not with a clean end.

**Reason:** the status and headers are sent before the first byte, so the failure shows only as a connection cut short and a tar with no end, which is an archive that nobody mistakes for a complete one.

**Tests:** `compliance/export-faults.test.ts › ends the response with an error, so the archive is cut short and cannot be taken for a whole one, and leaves nothing on disk`.

### `archive/archive-selection-key`

If the key that a `GET /export?format=archive` request was admitted on is revoked before the response begins, then the server MUST answer `401 unauthorized` without sending archive bytes.

**Reason:** the export reads and checks the whole selection before its first byte, and the answer is the one the next request on the key gets.

**Tests:** `compliance/export-credential.test.ts › is refused 401 when its key is revoked while the selection is read`.

### `archive/secrets-not-exported`

When the server writes an archive export, the server MUST NOT include `marfa.secrets` in it.

**Reason:** an export is meant to be shared and restored elsewhere, and the secrets belong to the instance that made them.

**Tests:** `compliance/hook-free-server.test.ts › leaves marfa.secrets out of an export, whether the file was generated or the secrets came from the environment`.

## Restoring an archive

`POST /restore` takes an archive that `GET /export?format=archive` wrote, from a caller that `keys-and-oauth/step-up-recent` or `keys-and-oauth/step-up-socket` admits, and answers counts of what it wrote and skipped.

### `archive/restore-roundtrip`

When a caller the operation admits sends `POST /restore` with an archive that `GET /export?format=archive` wrote, the server MUST answer `200` with the counts of what it restored.

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`.

### `archive/restore-counts`

When `POST /restore` succeeds, the server MUST carry the counts `imported`, `duplicates`, `edges_imported`, `edges_skipped`, `edges_skipped_reasons`, `blobs_imported`, `types_registered`, `types_skipped`, `edge_types_registered`, `edge_types_skipped`, `type_icons_added`, `type_icons_skipped`, `type_icons_skipped_reasons`, `sources_added`, `sources_skipped`, `sources_skipped_reasons`, `settings_added`, `settings_skipped`, `settings_dropped`, `secrets_to_set`, `connector_states_added`, `connector_states_skipped`, `connector_agreements_added`, `connector_agreements_skipped`, `app_vendors_added`, `app_vendors_skipped`, `rows_imported` and `rows_skipped`, each for the kind of thing it counts, and the lists `enforcement_added` and `enforcement_skipped`, each naming the enforcement settings it counts.

**Tests:** `compliance/restore-archive.test.ts › answers the restore result fields on the first restore and on a repeat`.

### `archive/restore-not-restored`

When `POST /restore` succeeds, the server MUST answer in `not_restored` one entry, holding a `kind` and a `message`, for each of what an archive leaves out: `sign_in`, `keys`, `apps`, `webhooks`, `inbound_endpoints`, `connector_keys`, `addresses`, `name` and `logs`, in that order.

**Reason:** an archive holds no credential, webhook, endpoint or log, and not the instance's name or addresses (`archive/archive-only`), so after a move the owner signs in, makes keys, approves apps, makes webhooks and endpoints again and gives each sender the new address of an endpoint, and the answer says so where the owner reads the outcome.

**Tests:** `compliance/restore-says.test.ts › restores each enforcement setting an instance lacks, an empty block included, keeps each it has, and does not carry the name`, `compliance/restore-archive.test.ts › answers the restore result fields on the first restore and on a repeat`.

### `archive/restore-not-restored-unreadable`

When `POST /restore` succeeds with an archive whose manifest names `enforcement` in `unreadable`, the server MUST answer in `not_restored`, after the entries `archive/restore-not-restored` names, an entry whose `kind` is `enforcement`.

**Reason:** the archive does not hold the enforcement settings of the instance that wrote it, so the owner sets strict mode and the source lists again, and the answer says so where the owner reads the outcome.

**Tests:** `compliance/restore-says.test.ts › refuses an export while the enforcement settings do not read, and a backup holds the items and names them`.

### `archive/restore-not-restored-telemetry`

When `POST /restore` names in `secrets_to_set` an OTLP endpoint, an OTLP header setting, `posthog_host` or `posthog_project_token`, the server MUST answer in `not_restored`, after the entries `archive/restore-not-restored` names, an entry whose `kind` is `telemetry` and whose `message` names each of them.

**Reason:** an archive names these secrets without their values (`archive/archive-secret-named`), so what they send stays off until the owner sets them again, and the answer says so where the owner reads the outcome.

**Tests:** `compliance/telemetry-settings.test.ts › restore with telemetry off and say so, and send again once the settings are set again, with no restart`.

### `archive/restore-previous-instance`

When `POST /restore` succeeds with an archive whose manifest names an `instance_id` other than this instance's, the server MUST answer in `previous_instance` that `instance_id`.

**Reason:** a restore into a new instance leaves the old instance's backups in the backup destination, where they cost room and are taken for current ones, and only the old instance's ID names them.

**Tests:** `compliance/restore-says.test.ts › names the old instance's folders in the backup folder after a restore into another instance, never as safe to delete, and nothing after a restore into the same one`, `compliance/restore-says.test.ts › names the old instance and no place for it where the instance has no backup destination`.

### `archive/restore-previous-folder`

Where `backup_path` is set, when `POST /restore` answers `previous_instance`, the server MUST answer `folder` in its `destination` and the folders `backups/<instance id>`, `backup-parts/<instance id>` and `files/<instance id>` of the backup folder in `kept_by_previous_instance`.

**Reason:** the backup folder keeps each instance's backups, their parts and its copy of each file in folders of that instance's own (`instance/backup-folder-file`, `instance/backup-part-named`).

**Tests:** `compliance/restore-says.test.ts › names the old instance's folders in the backup folder after a restore into another instance, never as safe to delete, and nothing after a restore into the same one`.

### `archive/restore-previous-bucket`

Where `object_store_bucket` is set, when `POST /restore` answers `previous_instance`, the server MUST answer `bucket` in its `destination` and only `<object_store_prefix>/backups/<instance id>` and `<object_store_prefix>/backup-parts/<instance id>` in `kept_by_previous_instance`.

**Reason:** the object store keeps every instance's file copies under `<object_store_prefix>/blobs/`, shared with this instance, so no file copy belongs to the old instance alone.

**Tests:** `compliance/backups.test.ts › restores a named backup into a fresh server on the same bucket, files included`.

### `archive/restore-previous-nowhere`

Where neither `object_store_bucket` nor `backup_path` is set, when `POST /restore` answers `previous_instance`, the server MUST answer `null` in its `destination` and no path in `kept_by_previous_instance`.

**Reason:** an instance with no backup destination does not know where the old instance kept its backups.

**Tests:** `compliance/restore-says.test.ts › names the old instance and no place for it where the instance has no backup destination`.

### `archive/restore-previous-not-safe`

When `POST /restore` answers `previous_instance`, the server MUST say in its `message` that what the old instance keeps may be deleted only once that instance no longer runs and nothing else restores from it.

**Reason:** an archive's `instance_id` says only which instance wrote it. That instance may still run, sharing the backup destination, or another instance may restore its backups again, so no answer can know that its backups are unused.

**Tests:** `compliance/restore-says.test.ts › names the old instance's folders in the backup folder after a restore into another instance, never as safe to delete, and nothing after a restore into the same one`, `compliance/backups.test.ts › restores a named backup into a fresh server on the same bucket, files included`, `compliance/restore-says.test.ts › names the old instance and no place for it where the instance has no backup destination`.

### `archive/restore-own-archive-no-previous`

When `POST /restore` succeeds with an archive whose manifest names this instance's own `instance_id`, the server MUST NOT answer `previous_instance`.

**Reason:** the backups of the instance restoring are the ones in use, and an answer that named them as another instance's would invite their loss.

**Tests:** `compliance/restore-says.test.ts › names the old instance's folders in the backup folder after a restore into another instance, never as safe to delete, and nothing after a restore into the same one`.

### `archive/restore-blobs-missing`

When `POST /restore` succeeds, the server MUST answer in `blobs_missing` the hash of each file that the archive's `files.ndjson.gz` names, that no entry of the archive carries bytes hashing to, that no attached store of the instance holds a recorded copy of at its recorded size, and that the object store does not hold under its name (`archive/restore-blob-from-store`).

**Reason:** an archive that lacks a file says so on the restore rather than restoring as though it were complete. Uploading the bytes again through `POST /blobs` restores the file.

**Tests:** `compliance/export-missing-blob.test.ts › answers in blobs_missing a blob the archive names and lacks, and none the instance holds`, `› answers in blobs_missing a blob the archive lists as carried and carries no bytes for`, `compliance/restore-from-store.test.ts › answers in blobs_missing a file the object store does not hold`, `› answers nothing in blobs_missing on an instance that holds every file the archive names`.

### `archive/restore-blob-from-store`

When `POST /restore` reads an archive that names a blob it does not carry and that no attached store holds a recorded copy of, if the attached object store holds an object under the blob's name whose bytes hash to it and that names that store as its writer, then the server MUST record that object as the store's copy of the blob.

**Reason:** a backup or an archive exported with `files=false` leaves the files where the instance kept them, so a new instance started on the same bucket gets them back by restoring the archive. The bytes are read and checked before the copy is recorded, so an object that is not the blob is never served as it.

**Tests:** `compliance/restore-from-store.test.ts › takes each file from the object store it was kept in, checked against its name, and records the copy`.

### `archive/restore-store-unavailable`

If a store fails, or does not answer within 15 seconds, while `POST /restore` checks whether the instance holds a blob that the archive names and does not carry, and no other attached store holds a recorded copy of the blob whole, then the server MUST answer `503 blob_store_unavailable`.

**Reason:** a store that cannot answer is no evidence that the instance lacks the blob, so the restore does not answer it in `blobs_missing`.

**Tests:** `compliance/export-missing-blob.test.ts › answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob`, `› restores an archive lacking a blob that the object store holds whole while the disk cannot be read for it`, `compliance/restore-from-store.test.ts › takes each file from the object store it was kept in, checked against its name, and records the copy`.

### `archive/restore-store-unfinished`

While a write or a deletion of a blob's bytes that the server stopped waiting for has neither been answered by its store nor given up by the server, if `POST /restore` names that blob in its archive, then the server MUST answer `503 blob_store_unavailable`.

**Reason:** on the disk, where a restore lands a blob's bytes, a late deletion could remove the bytes the restore would register, and waiting would hang the request on a store that may never answer. The caller still holds the archive and can send it again.

**Tests:** `compliance/blob-store-silent.test.ts › leaves the deletion queued, skips the blob in later runs without waiting, refuses an upload and a restore of its bytes, and keeps the copy made once the delete ends`.

### `archive/restore-store-unavailable-unwritten`

When `POST /restore` answers `503 blob_store_unavailable`, the server MUST NOT write any item, type registration or blob of the archive.

**Tests:** `compliance/export-missing-blob.test.ts › answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob`.

### `archive/restore-edge-skips`

When `POST /restore` skips an edge, the server MUST count it in `edges_skipped_reasons` under exactly one of these reasons: `already_present` when the instance already holds the edge, `endpoint_missing` when, once the archive's items are written, the instance holds no item under an endpoint's id, in the bin or out of it, `malformed` when the line does not give both endpoints and the edge type as strings, and otherwise the error code that `POST /edges` would answer for the edge, other than `edge_type_not_found`, which a restore does not give (`archive/restore-edges-unregistered`).

**Reason:** a restore judges each edge as `POST /edges` does, except where `archive/restore-edges-bin`, `archive/restore-edges-unregistered`, `archive/restore-edges-end-unregistered` and `edges/properties-restore-kept` say otherwise and for an `in-folder` edge to a revoked folder, which it keeps as the folder kept it (`edges/folder-revoked-keeps`). It skips an edge it refuses rather than refusing the archive.

**Tests:** `compliance/restore-archive.test.ts › answers the restore result fields on the first restore and on a repeat`, `› counts an edge that POST /edges would refuse under the code of its refusal, and keeps one whose type nothing registers`, `compliance/archive-scalars.test.ts › refuses an invalid edge version even when its endpoint is missing`.

### `archive/restore-items-kept`

When `POST /restore` writes an item, the server MUST keep its id, its tags and its extensions.

**Tests:** `compliance/export-roundtrip.test.ts › reconstructs items with their ids, tags, and extensions`.

### `archive/restore-edges-kept`

When `POST /restore` writes the edges between restored items, the server MUST keep them in both directions.

**Tests:** `compliance/export-roundtrip.test.ts › reconstructs edges between restored items, in both directions`.

### `archive/restore-edges-bin`

When `POST /restore` reads an edge whose endpoint is an item in the bin, the server MUST NOT skip the edge for that endpoint.

**Reason:** an export that names `state=any` carries the bin (`search-and-filters/export-state-any`), and an edge stays while its item is in the bin (`edges/list-bin`), and for someone moving to a new instance the archive is the only copy of that edge. `POST /edges` still refuses a new edge to an item in the bin (`edges/create-end-in-bin`).

**Tests:** `compliance/export-roundtrip.test.ts › reconstructs the edges of an item in the bin, in both directions`.

### `archive/restore-duplicate`

When an archived item holds an id or a natural key that an item on the instance already holds, or a link that an item of its type already holds, the server MUST count it in `duplicates`.

**Reason:** a link is one item's within its type (`items/link-taken`).

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`, `› answers the restore result fields on the first restore and on a repeat`, `compliance/links.test.ts › counts an archived item whose link another item holds as a duplicate`.

### `archive/restore-duplicate-kept`

When `POST /restore` counts an archived item as a duplicate, the server MUST leave the existing item's properties, tags, extensions and history as they are.

**Reason:** replaying a backup must not overwrite work made since the backup.

**Tests:** `compliance/archive-history.test.ts › leaves an existing item, its tags, its extensions and its history alone when the archive's copy is a duplicate`.

### `archive/restore-link-held`

If an archive registers a type with a `link_field` in which two items that a forced delete left share a value, then the server MUST answer `409 link_taken`.

**Reason:** a type that an archive registers is held to its `link_field` as `POST /types` holds one (`types/link-gained`).

**Tests:** `compliance/links.test.ts › stops a restore registering a link the items a forced delete left share`.

### `archive/restore-common-types`

When a restore reads an archive whose types include one under `common`, the server MUST restore it.

**Reason:** an archive is the owner's own data, and `POST /types` refuses a new `common.*` type only because installing a plugin is the way to add one (`types/id-reserved-common`).

**Tests:** `compliance/restore-archive.test.ts › restores although POST /types refuses a new one`.

### `archive/restore-types-any-order`

When an otherwise valid archive carries a set of registrations accepted through the server's registration and replacement routes, the server MUST restore those registrations into an empty store regardless of their order in the archive.

**Reason:** an exported backup remains restorable when its registrations refer to each other, including display hints, links, merge policies and tables that name inherited fields.

**Tests:** `compliance/restore-types-any-order.test.ts › round-trips accepted registrations into an empty store (reversed: %s)`, `compliance/type-tables.test.ts › restores a subtype whose type line restates a table of its parent (reversed: %s)`.

### `archive/restore-type-compatible-with-dropped`

When an archive registers a type whose definition carries `compatible_with`, the server MUST restore the type without that key.

**Reason:** an archive written by a release through 0.0.89, still version 1, may hold a key Marfa no longer reads, and refusing it as an unread key (`archive/restore-type-unknown-key`) would keep an owner from restoring a backup the server itself wrote.

**Tests:** `compliance/restore-types-any-order.test.ts › restores a type of an older archive that carries compatible_with, without the key`.

### `archive/restore-type-guidance`

When a caller holding `schema.write` or local authority sends `POST /restore` for an archive with a `type` line of a type outside `app.*` that carries guidance, and the instance does not hold the type, the server MUST register the type with that guidance.

**Reason:** a type the instance already holds the same way is skipped, and one it holds differently is a conflict (`archive/restore-type-conflict`), so a restore registers only a type the instance lacks.

**Tests:** `compliance/type-guidance-restore.test.ts › carries a type's guidance and status word descriptions through an export and a restore into a new instance`.

### `archive/restore-type-guidance-app`

If `POST /restore` reads a `type` line of an `app.*` type that carries non-empty `guidance`, then the server MUST answer `400 invalid_schema` with `details.errors` naming `guidance`.

**Reason:** archives follow the same restriction on guidance as `types/guidance-app-refused`, and a restore judges every `type` line before it judges what the caller may set, so a caller without `schema.write` is answered `400`, not `403`.

**Tests:** `compliance/type-guidance-restore.test.ts › answers 400 invalid_schema naming guidance for an archive that gives an app type guidance`, `› answers 400 invalid_schema rather than 403 to an app without schema.write for an archive that gives an app type guidance`.

### `archive/restore-type-guidance-app-no-write`

If `POST /restore` reads a `type` line of an `app.*` type that carries non-empty `guidance`, then the server MUST NOT register any type of the archive.

**Tests:** `compliance/type-guidance-restore.test.ts › writes no type of an archive that gives an app type guidance, though the archive without that guidance writes them`.

### `archive/restore-type-guidance-permission`

If a caller without `schema.write` or local authority sends `POST /restore` for an archive with a `type` line of a type outside `app.*` that carries non-empty `guidance`, and the instance does not hold the type, and the restore refuses no line of the archive first (`archive/restore-type-guidance-app`, `archive/restore-type-conflict`), then the server MUST answer `403 forbidden` with `details.required_scope` `schema.write` and `details.changes` listing `guidance`.

**Reason:** a restore registers types as `POST /types` does, and guidance tells agents how to fill a type (`types/guidance-register-permission`), so an app holding `backups.manage` alone could otherwise plant instructions that every agent reads. A type the instance holds the same way is skipped and needs no permission.

**Tests:** `compliance/type-guidance-restore.test.ts › answers 403 forbidden naming schema.write and guidance to an app holding backups.manage without schema.write`.

### `archive/restore-type-guidance-denied-no-write`

If a caller without `schema.write` or local authority sends `POST /restore` for an archive with a `type` line of a type outside `app.*` that carries non-empty `guidance`, and the instance does not hold the type, then the server MUST NOT register any type of the archive.

**Tests:** `compliance/type-guidance-restore.test.ts › writes no type of an archive that carries guidance for an app without schema.write, though the owner restores it`.

### `archive/restore-type-guidance-denied-no-blob`

If a caller without `schema.write` or local authority sends `POST /restore` for an archive with a `type` line of a type outside `app.*` that carries non-empty `guidance`, and the instance does not hold the type, then the server MUST NOT place any blob bytes the archive carries.

**Reason:** the refusal is decided before any bytes are placed, so a refused restore leaves nothing on disk for a cleanup to remove.

**Tests:** `compliance/type-guidance-restore.test.ts › places no blob bytes of an archive that carries guidance for an app without schema.write, though the owner places them`.

### `archive/restore-type-guidance-conflict-first`

If a caller without `schema.write` or local authority sends `POST /restore` for an archive that carries guidance for a type outside `app.*` and registers a type the instance holds differently, then the server MUST answer `409 conflict` and not `403 forbidden`.

**Tests:** `compliance/type-guidance-restore.test.ts › answers 409 conflict rather than 403 to an app without schema.write for an archive that registers a type the instance holds differently`.

### `archive/restore-type-empty-text`

When `POST /restore` registers a type from a `type` line whose `guidance` is an empty string, or whose status word has a `description` that is an empty string, the server MUST register the type without that text.

**Reason:** an empty `guidance` means none (`types/guidance-empty`), and a registration keeps no empty status word description. A type the instance holds the same way, with that text left out, is skipped.

**Tests:** `compliance/type-guidance-restore.test.ts › registers a type with no guidance and no status word description where the archive holds them empty`.

### `archive/restore-type-text-limits`

When `POST /restore` registers a type from a `type` line whose `description`, a field's or member's `description`, a status word's `description` or `guidance` is longer than a registration takes, the server MUST register the type with that text unchanged.

**Reason:** a type stored before the limits existed (`types/description-limit`) stays in a backup and restores, and its next replacement brings it within (`types/limits-replace-stored`). A guidance over the limit still needs `schema.write` (`archive/restore-type-guidance-permission`).

**Tests:** `compliance/type-guidance-restore.test.ts › reads a type stored over the limits as it is, and refuses a replacement that keeps the text until it is within`.

### `archive/restore-type-conflict`

If an archive registers a type or an edge type that the instance holds differently, then the server MUST answer `409 conflict` naming each in `details.conflicting_ids`.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive that registers a type or an edge type this instance holds differently, naming each, and writes nothing`.

### `archive/restore-core-edge-type`

If an archive carries a core edge type, then the server MUST answer `409 conflict`.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive that carries a core edge type with 409 conflict`.

### `archive/restore-type-unknown-key`

If an archive registers a type with a key `types/unknown-key` refuses, except `compatible_with` as specified by `archive/restore-type-compatible-with-dropped`, or an edge type with a key `edges/types-register-unknown-key` refuses, then the server MUST answer `400 invalid_schema` with `details.errors` naming the path of each such key.

**Reason:** an archive is held to what the registration doors take, so a registration they would refuse cannot come in by restore.

**Tests:** `compliance/restore-archive.test.ts › refuses a type and an edge type that carry one, naming its path, and restores the same archive without it`.

### `archive/restore-nothing`

When `POST /restore` takes an archive that carries no item, the server MUST answer `200` with `imported` of 0.

**Reason:** an archive of nothing is not an empty body, and its members are present and empty, which `archive/restore-members` tells from missing.

**Tests:** `compliance/restore-archive.test.ts › refuses an empty body, and takes an archive of nothing`.

### `archive/restore-empty-body`

If the body of `POST /restore` is empty, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/restore-archive.test.ts › refuses an empty body, and takes an archive of nothing`.

### `archive/restore-members`

If an archive lacks `manifest.json`, `files.ndjson.gz`, `instance.ndjson.gz`, `items.ndjson.gz`, `versions.ndjson.gz`, `edges.ndjson.gz` or `rows.ndjson.gz`, then the server MUST answer `400 validation_error` naming each missing entry in the message and in `details.entries`.

**Reason:** an export writes all seven even when it holds no item (`archive/archive-entries`), so a missing entry is a damaged archive or a file that is no archive, and an archive of nothing is told from it by its entries being empty (`archive/restore-nothing`). Without the check a restore answers `200` with counts of zero for a file it never read.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive without %s, naming it, and writes nothing`, `› refuses a tar that is no archive, naming every member it lacks`.

### `archive/restore-not-archive`

If the body of `POST /restore` is not a tar, or a line file in it is not a gzip stream or its compressed stream breaks partway, then the server MUST answer `400 validation_error`.

**Reason:** a damaged backup is an ordinary input and not a fault in the server.

**Tests:** `compliance/restore-archive.test.ts › refuses a body that is not a tar, or whose line file breaks partway, and goes on serving`.

### `archive/restore-keeps-serving`

When the server refuses a body of `POST /restore` that it cannot read, the server MUST go on answering other requests.

**Reason:** the process is every client's server, and a file that one operator sends must not stop it.

**Tests:** `compliance/restore-archive.test.ts › refuses a body that is not a tar, or whose line file breaks partway, and goes on serving`.

### `archive/restore-format`

If the `manifest.json` of an archive holds no `format`, then the server MUST answer `400 validation_error` with a message naming the archive's `written_by` and saying that its `manifest.json` names no format.

**Reason:** only releases before 0.0.72 wrote a manifest with no format, and they laid out its entries in a way this build does not read, so the message names the build that can read it.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive with no format, another format or a later version, naming the build that wrote it`.

### `archive/restore-format-other`

If the `manifest.json` of an archive names a `format` other than `marfa-archive`, then the server MUST answer `400 validation_error` naming the format.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive with no format, another format or a later version, naming the build that wrote it`.

### `archive/restore-version`

If the `manifest.json` of an archive names a `version` greater than the archive version its build writes (`archive/archive-version`), then the server MUST answer `400 validation_error` with a message naming the archive's `version`, its `written_by` and the latest version the build reads.

**Reason:** a build reads every archive version up to its own, so an archive of a later version is for a later build, and the message says which build wrote it.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive with no format, another format or a later version, naming the build that wrote it`.

### `archive/restore-version-one`

When `POST /restore` reads an archive at version 1, the server MUST read its manifest without `plugin_count` or `app_vendor_count` and register a `type` line whose `provenance.origin` is `user` or missing as a type with the origin `registered`.

**Reason:** version 1 named every registered type `user` and carried no plugin and no vendor binding, so an older backup still restores.

**Tests:** `compliance/plugins.test.ts › restores a version 1 archive whose type names the origin user as registered`.

### `archive/restore-type-origin`

If `POST /restore` reads an archive at version 2 with a `type` line whose `provenance.origin` is missing, is not text, is neither `registered` nor `plugin`, or is `plugin` without a `provenance.plugin` naming a plugin `name` and `version`, whose `provenance.plugin` is not `null` while `provenance.origin` is `registered`, or whose `provenance.created_by` is missing or is neither `null` nor a sign-in's `kind` (`browser`, `app`, `key` or `local`), `id` and `name`, then the server MUST answer `400 validation_error` and register no type of the archive.

**Reason:** a restored type is read back as `types/provenance-read` says, so it holds only a provenance that answer's schema allows, never one that loses a field it was given. A type may name a plugin no `plugin` line holds: removing a plugin keeps its types and their provenance (`plugins/remove-keeps-types`).

**Tests:** `compliance/plugins.test.ts › refuses a version 2 archive whose type names the origin user`, `› refuses a type whose origin or creator is mistyped, missing, outside the sign-in kinds or at odds with its plugin`.

### `archive/restore-plugin-line`

If `POST /restore` reads a `plugin` line whose `bundle` `POST /plugins` would refuse for its shape or for the definition of a type or an edge type it holds, whose `name` or `version` differs from its bundle's, whose `edge_types` is not a list naming each edge type of its bundle and each name once, whose `edge_types` names an empty string, a string that is not an edge type id or an edge type Marfa ships, whose `installed_at` or `updated_at` is not a time in the form the server writes, whose `installed_by` is neither `null` nor a sign-in's `kind` (`browser`, `app`, `key` or `local`), `id` and `name`, or whose `fingerprint` is not a SHA-256 in lowercase hexadecimal, then the server MUST answer `400 validation_error` naming the line and keep no record of the archive.

**Reason:** a restored record is answered by `GET /plugins/{name}`, so it holds only what that answer's schema allows. A plugin may have brought an edge type the owner has since deleted, so `edge_types` is history and need not name an edge type the instance holds now, but no plugin can have brought a name that is no edge type id or one Marfa ships.

**Tests:** `compliance/plugins.test.ts › refuses a plugin line whose times, installer, edge types, fingerprint or bundle definitions are not ones the server writes or installs`.

### `archive/restore-plugin-history`

When `POST /restore` reads a `plugin` line whose `bundle` is well formed, the server MUST keep the install record whether or not the instance or the archive holds a parent that a type of the bundle names.

**Reason:** a stored bundle is history. The owner may delete a plugin's types and the types they name as parents, and the export that follows must restore as it was written, so a restore judges each definition of the bundle on its own and never against what the instance holds now.

**Tests:** `compliance/plugins.test.ts › restores an export taken after the owner deleted the types a plugin's stored bundle names as parents`.

### `archive/restore-plugin-type-root`

If `POST /restore` reads a `type` line whose `provenance.origin` is `plugin` and whose `id` sits under `core`, `system`, `marfa`, `app` or `user`, then the server MUST answer `400 validation_error` and register no type of the archive.

**Reason:** installing refuses a plugin's type under those roots (`plugins/install-reserved-root`), so no archive written by a server holds one, and a restored type is read back as `origin: plugin` only when a plugin could have registered it.

**Tests:** `compliance/plugins.test.ts › refuses a type from a plugin under a root no plugin registers, which it restores under common`.

### `archive/export-plugins`

When a credential that may export sends `GET /export?format=archive`, the server MUST write a `plugin` line in `instance.ndjson.gz` for each installed plugin, holding its `name`, `version`, `bundle`, `edge_types` naming every edge type any installed version brought, `fingerprint`, `installed_at`, `installed_by` and `updated_at`, counted in the manifest's `plugin_count`.

**Tests:** `compliance/plugins.test.ts › keeps plugin provenance and the install record through an export and a restore`, `› keeps reporting an edge type a newer version omits, through an export, a restore and the removal`.

### `archive/export-plugin-provenance`

When a credential that may export sends `GET /export?format=archive`, the server MUST write the `type` line of each type a plugin installed with `provenance.origin` `plugin` and `provenance.plugin` naming the plugin's `name` and `version`.

**Tests:** `compliance/plugins.test.ts › keeps plugin provenance and the install record through an export and a restore`.

### `archive/restore-plugins`

When `POST /restore` reads a `plugin` line for a plugin the instance has no record of, the server MUST keep the install record as the line holds it, and count it in `plugins_added`.

**Tests:** `compliance/plugins.test.ts › keeps plugin provenance and the install record through an export and a restore`.

### `archive/restore-plugin-provenance`

When `POST /restore` registers a `type` line whose `provenance.origin` is `plugin`, the server MUST register the type with the plugin `name` and `version` the line names.

**Tests:** `compliance/plugins.test.ts › keeps plugin provenance and the install record through an export and a restore`.

### `archive/archive-version-additions`

When a restore reads an archive that lacks a field or a line kind added to the archive's version after the first build that wrote that version, the server MUST restore the archive without it.

**Reason:** a field or a line kind added within a version is optional to a reader of that version. An older build of the same version skips what it does not know (`archive/restore-unknown-field`, `archive/restore-unknown-line-kind`), and a newer build restores an archive written before the addition. What a restore must read comes only with a later version (`archive/archive-version`).

**Tests:** waiting on #2978.

### `archive/restore-manifest`

If the `manifest.json` of an archive is missing `version`, `written_by`, `file_count`, `item_count`, `version_count`, `edge_count`, `row_count`, `blob_count`, `type_count`, `edge_type_count`, `type_icon_count`, `source_count`, `setting_count`, `enforcement_count`, `connector_state_count`, `connector_agreement_count` or, at version 2, `plugin_count` and `app_vendor_count`, or mistypes them, `version` holding a whole number from 1, each count a non-negative integer and `written_by` a string, then the server MUST answer `400 validation_error` naming each field in the message and in `details.errors` as a `path`.

**Reason:** a later version is free to lay out its fields differently, so a manifest naming one is refused for its version (`archive/restore-version`) and not its shape.

**Tests:** `compliance/restore-archive.test.ts › refuses a manifest missing or mistyping a field the restore reads, naming the field, and writes nothing`, `compliance/app-vendors.test.ts › refuses a version 2 manifest that leaves out, mistypes or miscounts app_vendor_count`.

### `archive/restore-manifest-created`

When `POST /restore` reads an archive whose `manifest.json` carries no `created_at`, the server MUST restore the archive as it restores one that carries one.

**Reason:** the restore reads no time from the manifest, so an archive built by hand or by a writer that left the instant out holds the same items.

**Tests:** `compliance/restore-archive.test.ts › restores an archive whose manifest carries no created_at`.

### `archive/restore-files`

If a line of the `files.ndjson.gz` of an archive is not an object holding a `sha256:` `hash`, a `state` of `carried`, `not_carried` or `lost`, a string `mime_type` and a non-negative integer `size_bytes`, either of which may be `null` for a file whose state is not `carried`, then the server MUST answer `400 validation_error` naming the line in `details.line` and the field in `details.field`.

**Tests:** `compliance/restore-archive.test.ts › refuses a files.ndjson.gz line missing or mistyping a field, naming the line and the field, and writes nothing`.

### `archive/restore-files-once`

If two lines of the `files.ndjson.gz` of an archive name the same `hash`, then the server MUST answer `400 validation_error` naming the hash.

**Reason:** a file has one type, one size and one state, so an archive that gives two cannot say which holds.

**Tests:** `compliance/restore-archive.test.ts › refuses a files.ndjson.gz line missing or mistyping a field, naming the line and the field, and writes nothing`.

### `archive/restore-line-counts`

If a count in an archive's manifest is not the number it counts, being the lines of `files.ndjson.gz`, `items.ndjson.gz`, `versions.ndjson.gz`, `edges.ndjson.gz` or `rows.ndjson.gz` for `file_count`, `item_count`, `version_count`, `edge_count` or `row_count`, the lines of each kind in `instance.ndjson.gz` for the ten other `_count` fields that name a kind of line, or the `blobs/` entries for `blob_count`, then the server MUST answer `400 validation_error` naming the count in `details.field`.

**Reason:** the manifest says what the archive holds before a reader reads the rest (`archive/archive-entries`), so an archive that holds other than it says was cut or changed after the export, and a restore that took it would restore less than was exported without saying so.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive whose %s is not the number of lines its file holds, and writes nothing`, `› refuses a version 2 archive whose %s is not the number of lines it holds, and writes nothing`, `› refuses an archive whose manifest counts more than the archive carries, however it was cut`, `compliance/app-vendors.test.ts › refuses a version 2 manifest that leaves out, mistypes or miscounts app_vendor_count`.

### `archive/restore-item-fields`

If an item line of an archive lacks `id`, `version`, `created_at`, `updated_at`, `last_activity_at`, `occurred_at`, `state` or `properties` in its `item`, then the server MUST answer `400 validation_error` naming the line in `details.line` and the field in `details.field`, and write nothing.

**Reason:** an export writes all of them for every item, so a line without one is damaged, and a restore that filled in a version or a date would write a history the instance never had.

**Tests:** `compliance/restore-archive.test.ts › refuses an item line lacking %s, naming the line and the field, and writes nothing`.

### `archive/restore-state`

If an archive records an item in a state that its type's lifecycle cannot produce, such as `revoked` for a canonical type, `trashed` for a `system.*` type or a value that is no state, then the server MUST answer `400 validation_error` naming the item.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive recording a state the type's lifecycle cannot produce, and writes nothing`.

### `archive/restore-cascade-marks`

If an item line of an archive records `trashed_by_cascade` as other than `true`, records it on an item that is not in the bin, records `trashed_with` as other than the ID of another item, or records `trashed_with` without `trashed_by_cascade`, then the server MUST answer `400 validation_error` naming the line in `details.line`, the item in `details.item_id` and the field in `details.field`, and write nothing.

**Reason:** an export writes `trashed_with` only beside `trashed_by_cascade`, and both only on an item a cascade took into the bin. An export may leave out the item `trashed_with` names, so a name the archive does not hold is not refused (`items/restore-archive-marks-unheld`).

**Tests:** `compliance/restore-cascade-marks.test.ts › refuses an item line whose %s is %j, %s, naming the line and the field, and writes nothing`.

### `archive/restore-state-kept`

When `POST /restore` takes a canonical item in a state that its lifecycle contains, the server MUST write the item in the state recorded.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive recording a state the type's lifecycle cannot produce, and writes nothing`.

### `archive/restore-source`

When restoring an item whose `source`, after trimming whitespace and ignoring case, starts with `oauth:`, the server MUST store `restored:` followed by the exact archived source.

**Reason:** An archive carries history but no app credentials. A restored source cannot belong to a credential (`keys-and-oauth/claims-reserved`), so a later app sign-in cannot overwrite the archived item's natural key.

**Tests:** `compliance/restore-archive.test.ts › rewrites app sources exactly and accepts previously restored sources`, `compliance/version-writers-archive.test.ts › restores app-written items twice with their writers and separate natural keys`.

### `archive/restore-source-again`

When restoring an item whose `source` starts with `restored:`, the server MUST preserve that source unchanged.

**Tests:** `compliance/restore-archive.test.ts › rewrites app sources exactly and accepts previously restored sources`, `compliance/version-writers-archive.test.ts › restores app-written items twice with their writers and separate natural keys`.

### `archive/restore-app-connection`

When restoring a `system.connection` item whose `kind` property is `app`, the server MUST set its current `status` property to `revoked`.

**Reason:** A restored app connection records past access, not a live grant. Its other fields and archived version writers remain part of that history (`versions/writer-restore`).

**Tests:** `compliance/version-writers-archive.test.ts › marks restored app connections inactive without changing their recorded fields`.

### `archive/restore-scalars`

If an archive records a `version` of an item or an edge that is not a whole number from 1 to 9007199254740991, or a `tier` of an item that is not `library` or `feed`, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/archive-scalars.test.ts › refuses invalid $field=$value before writing the archive`.

### `archive/restore-text`

If the `manifest.json` of an archive, or a line the restore reads from its `files.ndjson.gz`, `instance.ndjson.gz`, `items.ndjson.gz`, `versions.ndjson.gz`, `edges.ndjson.gz` or `rows.ndjson.gz`, holds a string or an object key with a surrogate escape that has no partner, then the server MUST answer `400 validation_error` naming the entry or the line and the JSON pointer of the text, and write nothing.

**Reason:** a restore is not a way to plant text the write doors refuse (`items/json-text-well-formed`).

**Tests:** `compliance/well-formed-text.test.ts › refuses a %s that holds a surrogate escape with no partner, naming the line and where, and takes a pair there`.

### `archive/restore-scalars-held`

When an archive records an invalid `version` or `tier` for an item that the instance already holds, or for an edge whose endpoint is missing, the server MUST still refuse the archive.

**Tests:** `compliance/archive-scalars.test.ts › refuses invalid %s even when the item already exists`, `› refuses an invalid edge version even when its endpoint is missing`.

### `archive/restore-scalars-kept`

When `POST /restore` writes an item or an edge, the server MUST keep the `version` and the item's `tier` that the archive records, and write `library` where it records no tier and `1` for an edge that records no version.

**Reason:** zero can be a write precondition but is never a stored version (`versions/create-claim-none`), and resetting a version can make an old write precondition match unrelated content.

**Tests:** `compliance/archive-scalars.test.ts › restores $name without changing their meaning`.

### `archive/restore-dates`

If an archive records a `created_at` or `updated_at` of an item or an edge, or a `last_activity_at` of an item, that is not an instant, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/archive-history.test.ts › refuses an archive whose %s is malformed, and writes the item ahead of it nowhere`, `› refuses an edge whose date is malformed even when an endpoint is missing`.

### `archive/restore-dates-utc`

When `POST /restore` writes an item, the server MUST write its `created_at` and `updated_at`, and the `created_at` and `occurred_at` of each snapshot in its history, as the instants they name, in UTC to the millisecond.

**Reason:** canonical UTC values remain comparable with the filters and cursors of a listing, and with the dates of the versions the instance writes itself.

**Tests:** `compliance/archive-history.test.ts › writes an item's dates in UTC to the millisecond`, `compliance/restore-archive.test.ts › writes a snapshot's dates in UTC to the millisecond`.

### `archive/restore-history-shape`

If a line of the `versions.ndjson.gz` of an archive is not an object with an item ID in `item_id`, a whole number from 1 to 9007199254740991 in `version`, a valid snapshot ID, object properties, a type identifier, a `library` or `feed` tier, `created_at` and `occurred_at` instants, and a `source_id` that is a string or null, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/archive-history.test.ts › refuses an archive whose %s is malformed, and writes the item ahead of it nowhere`.

### `archive/restore-history-version`

If a line of the `versions.ndjson.gz` of an archive holds a `version` that is not below the version of the item it names in `item_id`, then the server MUST answer `400 validation_error` naming the line and the item.

**Tests:** `compliance/archive-history.test.ts › refuses an archive whose %s is malformed, and writes the item ahead of it nowhere`.

### `archive/restore-history-item`

If a line of the `versions.ndjson.gz` of an archive names in `item_id` an item that the archive's `items.ndjson.gz` does not hold, then the server MUST answer `400 validation_error` naming the line and the item.

**Tests:** `compliance/archive-history.test.ts › refuses an archive whose %s is malformed, and writes the item ahead of it nowhere`.

### `archive/restore-history-order`

If a line of the `versions.ndjson.gz` of an archive does not come after the line before it, in the order the items it names are held in `items.ndjson.gz` and then in ascending `version`, then the server MUST answer `400 validation_error` naming the line and the item.

**Reason:** an export writes the versions in this order, so a restore checks each line against the one before it as it arrives, and a version that repeats another of the same item is refused with the rest.

**Tests:** `compliance/archive-history.test.ts › refuses an archive whose %s is malformed, and writes the item ahead of it nowhere`.

### `archive/restore-history-id`

If a line of the `versions.ndjson.gz` of an archive holds a snapshot ID that another of its lines holds, of the same item or another, then the server MUST answer `400 validation_error` naming the line and the item.

**Tests:** `compliance/archive-history.test.ts › refuses an archive whose %s is malformed, and writes the item ahead of it nowhere`.

### `archive/restore-malformed-held`

When an archive records a malformed date or history for an item that the instance already holds, the server MUST still refuse the archive.

**Tests:** `compliance/archive-history.test.ts › refuses a malformed date or history even when the item is one the instance already holds`.

### `archive/restore-history-exact`

When `POST /restore` writes an item's history, the server MUST keep each snapshot's `id`, `item_id`, `version`, `properties`, `type`, `tier`, `occurred_at`, `source_id` and `created_at`, with its dates as the instants they name (`archive/restore-dates-utc`).

**Tests:** `compliance/archive-history.test.ts › restores each snapshot field for field into an instance that has never seen the item`.

### `archive/restore-history-shape-free`

The server MUST NOT hold a restored snapshot's properties to the current shape of its type.

**Reason:** changing a type's schema does not rewrite the past.

**Tests:** `compliance/archive-history.test.ts › restores a snapshot the type's current shape would refuse, as it was`.

### `archive/restore-items-shape-free`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships, the server MUST NOT refuse it because its properties lack a field its type requires or hold a value its type's field does not accept.

**Reason:** a type gains a required field while its items stand (`types/field-gained`), so an archive that an export wrote can hold an item that its type no longer accepts, and an export that the same build cannot restore is not a usable backup (`archive/restore-no-count-limit`). The current items are held to the shape they had as a snapshot's properties are (`archive/restore-history-shape-free`). A `core` or `system` type that this build ships is read by the server's own code and cannot be deleted or replaced, so its items keep to it. A property that no type declares is still refused where strict mode names the type (`archive/restore-strict`), an event's schedule and a task's `recurrence` are still judged (`occurrences/schedule-unreadable`), and so are the `columns` of an item of a type below `core.table` (`tables/own-restore-columns`).

**Tests:** `compliance/restore-items-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`.

### `archive/restore-items-properties-kept`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships, the server MUST store its properties as the archive holds them.

**Reason:** the properties are the person's own, and a restore that rewrote them to a shape the type has now would change the backup it restores.

**Tests:** `compliance/restore-items-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`, `› restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`.

### `archive/restore-schema-version-kept`

When `POST /restore` writes an item, the server MUST store the `schema_version` that the archive records for it.

**Reason:** `schema_version` is the `version` the item's type had when the item was created, and Marfa never changes it. Stamping the type's present version on an item written under an earlier one would say the item has a field it lacks.

**Tests:** `compliance/restore-items-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`.

### `archive/restore-items-orphan`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships and whose type is not registered once the archive's own types are, the server MUST store the item under that type.

**Reason:** a forced delete removes a type and keeps its items (`types/delete-force`), and an export carries them without the type. The item is restored as such an item stands: its properties, tier, time and natural key refuse a write until a type is registered (`types/orphan-write`), and it is read, listed and searched (`types/orphan-read`) and has its tags, extensions and lifecycle state written (`types/orphan-kept-writable`) as it was. A type registered again holds its later writes (`types/orphan-reregistered`).

**Tests:** `compliance/restore-items-shape.test.ts › restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`.

### `archive/restore-item-line`

If a line of the `items.ndjson.gz` of an archive holds no `item` object, then the server MUST answer `400 validation_error` naming the line in `details.line`.

**Reason:** a line that names no item is an archive that no instance wrote, and skipping it would leave it counted nowhere in the answer.

**Tests:** `compliance/restore-archive.test.ts › refuses an item line that holds no item, naming its line, and writes nothing`.

### `archive/restore-item-type`

If an archived item's `type` is missing or is not a type identifier, then the server MUST answer `400 validation_error` naming the item's ID in the message.

**Reason:** a forced delete leaves an item under an identifier a type was registered with (`archive/restore-items-orphan`), so an identifier that none could have been is an archive that no instance wrote.

**Tests:** `compliance/restore-archive.test.ts › refuses an item whose type is no identifier or whose properties are no object, and writes nothing`.

### `archive/restore-item-properties`

If an archived item's `properties` are present and are not an object, then the server MUST answer `400 invalid_properties` naming the item's ID in the message.

**Reason:** a restore that took them would store an item whose properties no read can return as an object.

**Tests:** `compliance/restore-archive.test.ts › refuses an item whose type is no identifier or whose properties are no object, and writes nothing`.

### `archive/restore-edges-unregistered`

When `POST /restore` writes an edge whose edge type is not registered once the archive's own edge types are, the server MUST store the edge under that edge type, as the archive holds it.

**Reason:** a forced delete removes an edge type and keeps its edges (`edges/types-delete-force-keeps`), and an export carries them without the edge type. The edge is restored as such an edge stands: it is read like any other (`edges/orphan-read`), it neither cascades a delete nor blocks one (`edges/orphan-delete`, `edges/orphan-delete-unblocked`), and it is announced like every restored edge (`archive/restore-announced`). `POST /edges` still names a registered edge type (`edges/create-type-unknown`).

**Tests:** `compliance/restore-edges-unregistered.test.ts › keeps the edge as the archive holds it, reads it as the origin does, and restores its own export again`, `compliance/restore-archive.test.ts › counts an edge that POST /edges would refuse under the code of its refusal, and keeps one whose type nothing registers`.

### `archive/restore-edges-unregistered-judged`

When `POST /restore` meets an edge whose edge type is not registered once the archive's own edge types are, the server MUST skip it, under the reason that `archive/restore-edge-skips` gives, where an endpoint is missing, an edge already holds its ID or its triple, or it runs from an item to itself.

**Reason:** with no edge type there is no constraint, cardinality or property schema to hold the edge to, and every edge type with a cycle check is shipped, so these are the refusals that need no edge type. An edge whose edge type the archive registers, or that is shipped, is judged by it.

**Tests:** `compliance/restore-edges-unregistered.test.ts › judges an edge of an unregistered type by what needs no edge type, still holds a registered one to its constraints, and refuses an edge whose type is no identifier`.

### `archive/restore-edge-type`

If an archived edge's `edge_type` is a string that is not an edge-type identifier, then the server MUST answer `400 validation_error` naming the edge's ID in the message.

**Reason:** a forced delete leaves an edge under an identifier an edge type was registered with (`archive/restore-edges-unregistered`), so an identifier that none could have been is an archive that no instance wrote. A line that gives the edge type as no string is skipped as `malformed` (`archive/restore-edge-skips`).

**Tests:** `compliance/restore-edges-unregistered.test.ts › judges an edge of an unregistered type by what needs no edge type, still holds a registered one to its constraints, and refuses an edge whose type is no identifier`.

### `archive/restore-edge-id`

If an archived edge carries an `id` that is not a UUIDv7 in lowercase, then the server MUST answer `400 validation_error` naming `id` in `details.field`.

**Reason:** an edge stored under such an ID could not be read or deleted by it, and one whose ID the restore replaced would be written again by every later restore of the same archive.

**Tests:** `compliance/restore-archive.test.ts › refuses an edge whose ID is not a lowercase UUIDv7, and writes nothing`.

### `archive/restore-edges-end-unregistered`

When `POST /restore` meets an edge with an end that is an item of a type that is not registered once the archive's own types are, the server MUST NOT refuse the edge because the edge type's `from_type_constraints` or `to_type_constraints` do not admit that end.

**Reason:** a forced delete removes a type and keeps its items and the edges between them (`types/delete-force`), and the type's parent and roles go with it, so no entry in the list, whether it names a registered type or not, can be judged against the end. `POST /edges` still refuses such an end (`edges/endpoint-unregistered`), and every other refusal of a restored edge is unchanged (`archive/restore-edge-skips`).

**Tests:** `compliance/restore-edges-constraint-types.test.ts › keeps an edge whose from constraint names the deleted type, and still refuses a registered end the constraint does not admit`, `› keeps an edge whose to constraint names the deleted type`, `› judges a constraint that lists a registered and a deleted type by the endpoint: an end of the deleted type is kept, and an end of a registered type must be one the list names`, `› restores an older archive whose item type is not registered, keeping the edge its constraint named the type for`.

### `archive/restore-edges-end-registered`

When `POST /restore` meets an edge with an end that is an item of a registered type, the server MUST judge that end against the edge type's constraint list as `POST /edges` does, whether or not the list also names a type that is not registered.

**Reason:** a type that other types name as parent cannot be deleted (`types/delete-subtypes`), so every ancestor of a registered type is registered, and an entry naming a type that is not registered admits no registered type.

**Tests:** `compliance/restore-edges-constraint-types.test.ts › keeps an edge whose from constraint names the deleted type, and still refuses a registered end the constraint does not admit`, `› judges a constraint that lists a registered and a deleted type by the endpoint: an end of the deleted type is kept, and an end of a registered type must be one the list names`.

### `archive/restore-snapshot-held`

If an archive records a snapshot ID that existing history already holds, then the server MUST answer `409 conflict`.

**Reason:** a history collision is not a duplicate current item and cannot overwrite another item's past.

**Tests:** `compliance/archive-history.test.ts › refuses a snapshot ID the instance's history already holds, answering 409 and leaving that history as it was`.

### `archive/restore-strict`

Where `enforcement.strict_mode` names the type of an archived item that the restore would write, if the item sets a property that no type declares, then the server MUST answer `400 invalid_properties`.

**Reason:** a restore is not a way to plant an item that `POST /items` would refuse. An item whose ID, natural key or link the instance already holds is counted in `duplicates` and written nowhere, so the lever has nothing to judge. `types/strict-mode` states the lever and `types/strict-mode-code` the code it carries.

**Tests:** `compliance/schema-enforcement.test.ts › strict-on rejects the same unknown property arriving through the restore door`, `› strict-on counts a restored item the instance already holds as a duplicate`.

### `archive/restore-strict-off`

Where `enforcement.strict_mode` does not name the type of an archived item, the server MUST take a property that no type declares and serve it back.

**Tests:** `compliance/schema-enforcement.test.ts › default-off accepts through the restore door as it does through the create door`.

### `archive/restore-blob-size`

Where the volume has room for an archive beside the instance's reserve (`blobs/restore-reserve`), the server MUST restore it even when it is larger than the request cap that every JSON body sits under.

**Reason:** the body streams to disk as an upload's does, so an archive that carries a blob larger than the cap restores.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`, `compliance/adversarial.test.ts › refuses a request over the body cap with request_too_large`.

### `archive/restore-duration`

While a part of the body of `POST /restore` arrives at least once in every 60 seconds, the server MUST NOT end the request for the time the body takes.

**Reason:** an archive has no size cap (`archive/restore-blob-size`), so a large one over a slow link outlasts any fixed request deadline. The limit on a body that stops arriving is `archive/restore-idle`.

**Tests:** `compliance/upload-timing.test.ts › restores an archive whose body takes 66 seconds to arrive, a part at a time`.

### `archive/restore-idle`

If no byte of the body of `POST /restore` arrives for 60 seconds, then the server MUST answer `408 request_timeout`.

**Reason:** a sender that has gone quiet would otherwise hold its request and the bytes it has sent for ever. The time counts the server's wait for the sender, not the time it takes to write what has arrived.

**Tests:** `compliance/upload-timing.test.ts › ends a restore with 408 request_timeout, writes nothing and removes what it spooled`.

### `archive/restore-refused-read`

When the server refuses `POST /restore` after it has started to read the body, the server MUST read the rest of the body, until it ends or no byte arrives for 60 seconds, before it answers.

**Reason:** a client that is still sending reads no answer until its body is sent, so a server that stopped reading would leave it with a broken connection in place of the refusal.

**Tests:** `compliance/restore-archive.test.ts › reads the rest of a large body and answers the refusal, to the owner, and answers a working key before the body`.

### `archive/restore-refused-early`

When the server refuses `POST /restore` before it has started to read the body, the server MUST answer with `Connection: close` within 2 seconds, after reading at most `max_request_bytes` of the body.

**Reason:** a caller the operation refuses has proved nothing, so the server reads no more of what it sends than a client already sending a small archive has in flight, which lets that client hear the refusal instead of a reset. A client that sent `Expect: 100-continue`, as `marfa restore` does, has sent no body, and the server reads none.

**Tests:** `compliance/restore-archive.test.ts › answers a caller with no credential within two seconds and closes the connection while it keeps sending`, `› reads the rest of a large body and answers the refusal, to the owner, and answers a working key before the body`.

### `archive/restore-idle-unwritten`

When the server answers `POST /restore` with `408 request_timeout`, the server MUST NOT write any item, type registration or blob of the archive.

**Tests:** `compliance/upload-timing.test.ts › ends a restore with 408 request_timeout, writes nothing and removes what it spooled`.

### `archive/restore-blob-bytes`

When `POST /restore` takes a blob that the archive carries, the server MUST answer its bytes on `GET /blobs/{hash}` byte for byte, under the type that the archive's `files.ndjson.gz` names.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`.

### `archive/restore-blob-type`

If the `files.ndjson.gz` of an archive names for a blob a `mime_type` that is empty or holds a character outside printable ASCII, then the server MUST keep the blob under `application/octet-stream`.

**Reason:** a blob's type is served as a response header and sent to an object store as one, and a header carries only printable ASCII. An upload names its type in a header, so only a restore can bring such a type, and a blob kept under it could be neither served nor copied to another store.

**Tests:** `compliance/restore-archive.test.ts › keeps a blob whose files.ndjson.gz line names a type no header can carry under application/octet-stream`.

### `archive/restore-blob-held`

When an archive carries a blob that the disk store holds a recorded copy of whole, the server MUST keep that copy and not write the blob's bytes again.

**Reason:** content addressing means the copy is already those bytes, and another request can be reading it while the restore runs.

**Tests:** `compliance/restore-faults.test.ts › keeps the copy the disk holds and writes the bytes no second time`, `› replaces a disk copy that has rotted at the same size with the bytes the archive carries`.

### `archive/restore-blob-hash`

When an entry of an archive holds bytes that do not hash to its name, the server MUST leave the entry out and not count it in `blobs_imported`.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`.

### `archive/restore-unread-entry`

When an archive carries an entry under a name that the restore does not read, or a `blobs/` entry after its line files for a file that its `files.ndjson.gz` does not name as `carried`, the server MUST restore the rest of the archive and leave the entry unread.

**Reason:** an archive is a file that anyone can hand an operator, and a small compressed entry can expand to more memory than the server has. A tar tool adds entries of its own, such as `._` files on a Mac. An entry that a restore must read comes only with a later archive version, which a restore refuses (`archive/restore-version`), so an entry this build does not know is one it may skip.

**Tests:** `compliance/restore-archive.test.ts › steps past an entry it does not read`, `› skips an entry it does not know, names it in entries_skipped, and restores the rest`.

### `archive/restore-entries-skipped`

When a restore leaves an entry of an archive unread under `archive/restore-unread-entry`, the server MUST name the entry in the `entries_skipped` list of its `200` answer, in the order the archive holds the entries.

**Reason:** an operator who restores an archive learns from the answer that the archive held something this build did not read, such as the entry of a later Marfa, rather than finding it missing later.

**Tests:** `compliance/restore-archive.test.ts › skips an entry it does not know, names it in entries_skipped, and restores the rest`, `› refuses a tar that is no archive, naming every member it lacks`.

### `archive/restore-unknown-line-kind`

When a line of the `instance.ndjson.gz` of an archive is an object holding none of `type`, `edge_type`, `type_icon`, `source`, `setting`, `connector_state` and `connector_agreement`, and some key other than `provenance`, the server MUST skip the line and restore the rest of the archive.

**Reason:** a later build of the same archive version may add a kind of line, which is optional to a reader of that version (`archive/archive-version-additions`). The manifest's counts name only the seven kinds, so such a line is in none of them (`archive/restore-line-counts`).

**Tests:** `compliance/restore-archive.test.ts › skips an instance line of a kind it does not know, names the kind in line_kinds_skipped, and restores the rest`.

### `archive/restore-line-kinds-skipped`

When a restore skips a line under `archive/restore-unknown-line-kind`, the server MUST name each key of the line other than `provenance` in the `line_kinds_skipped` list of its `200` answer, each name once, in the order the archive first holds it.

**Reason:** an operator learns from the answer that the archive held something this build did not read, as `entries_skipped` tells them of an entry (`archive/restore-entries-skipped`).

**Tests:** `compliance/restore-archive.test.ts › skips an instance line of a kind it does not know, names the kind in line_kinds_skipped, and restores the rest`.

### `archive/restore-unknown-field`

When the manifest or a line of an archive carries a field that no statement on archives names, outside an item's `properties` and a type's or edge type's definition, the server MUST restore the archive as it restores the same archive without that field.

**Reason:** a later build of the same archive version may add a field, which is optional to a reader of that version (`archive/archive-version-additions`). A type's or edge type's definition is a registration and is held to the registration rules (`archive/restore-type-unknown-key`).

**Tests:** `compliance/restore-archive.test.ts › restores an archive whose manifest and lines carry fields it does not read as it restores one without them`.

### `archive/restore-text-cap`

If the `manifest.json`, or a line of any line file of an archive, is larger than 64 MiB, then the server MUST answer `400 validation_error` naming the entry.

**Reason:** the restore parses each of these whole, so this limit bounds the memory a restore takes. The line files are otherwise read a line at a time, so an archive of any number of items, versions, files or registrations restores. The writer holds every line it writes to the same limit (`archive/archive-line-cap`).

**Tests:** `compliance/restore-archive.test.ts › refuses a line longer than 64 MiB, and writes nothing`, `› refuses rows.ndjson.gz carried twice, and a row line longer than 64 MiB, and writes nothing`.

### `archive/restore-entry-twice`

If an archive carries `manifest.json`, `files.ndjson.gz`, `instance.ndjson.gz`, `items.ndjson.gz`, `versions.ndjson.gz`, `edges.ndjson.gz`, `rows.ndjson.gz` or a `blobs/` entry more than once, then the server MUST answer `400 validation_error` naming the entry.

**Reason:** a repeated entry has no single meaning, and reading both would let a later copy add lines that the first never listed.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive carrying an entry twice, and writes nothing`, `› refuses rows.ndjson.gz carried twice, and a row line longer than 64 MiB, and writes nothing`.

### `archive/restore-entry-order`

If an archive carries `manifest.json`, `files.ndjson.gz`, `instance.ndjson.gz`, `items.ndjson.gz`, `versions.ndjson.gz`, `edges.ndjson.gz`, `rows.ndjson.gz` and its `blobs/` entries in an order other than that one, then the server MUST answer `400 validation_error` naming the first entry out of order in `details.entry`.

**Reason:** a restore checks each line against the lines before it, and each blob against the `files.ndjson.gz` line that names it, so an entry out of order cannot be checked. A blob read before the file list would otherwise be left out with no word of why.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive whose entries are out of order, naming the first, and writes nothing`.

### `archive/restore-item-once`

If two lines of the `items.ndjson.gz` of an archive hold the same item `id`, then the server MUST answer `400 validation_error` naming the ID in `details.item_id`.

**Reason:** a restore judges each version line against the item it belongs to (`archive/restore-history-version`), so an item held twice has no one version to judge its history by.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive that carries an item on two lines, naming the item, and writes nothing`.

### `archive/restore-registration-twice`

If the `instance.ndjson.gz` of an archive registers the same type ID, or the same edge-type ID, on more than one line, then the server MUST answer `400 validation_error`.

**Reason:** two registrations of one ID have no single meaning, as two icons for one type have none.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive that registers a type or an edge type twice, and writes nothing`.

### `archive/restore-no-count-limit`

When the server restores an archive that the same build wrote, the server MUST take its counts of items, edges, types and edge types without a limit of its own.

**Reason:** an export that the same build cannot restore is not a usable backup.

**Tests:** `compliance/archive-limits.test.ts › restores an archive of more than 5,000 items, 20,000 edges, 200 types and 200 edge types, as one the same build wrote`.

### `archive/restore-item-at-cap`

When an archived item's properties, those of one of its earlier versions, or an archived edge's properties are exactly as large as the largest body the bulk write operations take, the server MUST restore the item or edge.

**Tests:** `compliance/archive-limits.test.ts › takes %s of exactly the bulk write cap and refuses one byte more, 413 naming the line and the field, and writes nothing`.

### `archive/restore-item-over-cap`

If an archived item's properties, those of one of its earlier versions, or an archived edge's properties are larger than the largest body the bulk write operations take, then the server MUST answer `413 request_too_large` naming the line and the field in `details`.

**Reason:** a restore is not a way to plant an item that the write operations would refuse, and the cap is the largest bulk body (`items/bulk-body-cap`).

**Tests:** `compliance/archive-limits.test.ts › takes %s of exactly the bulk write cap and refuses one byte more, 413 naming the line and the field, and writes nothing`.

### `archive/restore-refused-nothing`

If the server refuses an archive, then the server MUST leave no item, history, type, edge type, blob, event or audit record that the restore wrote.

**Reason:** the registrations, the blob bytes and the items commit together or not at all, so an owner who gives up on a restore does not hold types or items they did not ask for and can run the same restore again.

**Tests:** `compliance/restore-archive.test.ts › leaves no item, type, edge type, blob, event or audit record behind when a later item is refused`, `compliance/archive-scalars.test.ts › refuses invalid $field=$value before writing the archive`, `compliance/archive-history.test.ts › refuses a snapshot ID the instance's history already holds, answering 409 and leaving that history as it was`.

### `archive/restore-failed-nothing`

If a write fails while the server restores an archive, then the server MUST leave no item, type, edge type, event or audit record that the restore wrote.

**Tests:** `compliance/restore-faults.test.ts › leaves no item, type, edge type, event or audit record when a write fails ($fault), the next blob-integrity run removes the bytes it placed, and it restores whole when tried again`.

### `archive/restore-failed-blobs`

If a write fails while the server restores an archive, then the server MUST queue for deletion the blob bytes the restore placed that no item names, so that `blob-integrity` and `blob-orphans` runs remove them.

**Reason:** the bytes are placed before the transaction opens and stay unrecorded and queued for deletion, so nothing serves them, and clean-up removes only what no record names.

**Tests:** `compliance/restore-faults.test.ts › leaves no item, type, edge type, event or audit record when a write fails ($fault), the next blob-integrity run removes the bytes it placed, and it restores whole when tried again`.

### `archive/restore-stopped-nothing`

If the process stops while the server restores an archive, then the server MUST leave no item, type, edge type, event or audit record that the restore wrote, and remove the blob bytes it placed that no item names.

**Reason:** the bytes are written before the transaction opens, which nothing can roll back, so the copy cleanup of `blob-replicate` and `blob-integrity` removes them.

**Tests:** `compliance/restore-faults.test.ts › leaves no item, type, edge type, event or audit record when the process stops while it writes, and the next copy cleanup removes the bytes it placed`.

### `archive/restore-announced`

When a restore commits, the server MUST announce the items it wrote on the event stream.

**Tests:** `compliance/restore-archive.test.ts › leaves no item, type, edge type, blob, event or audit record behind when a later item is refused`.

### `archive/restore-announced-order`

When a restore commits, the server MUST tell subscribers about its events in event-log order, ahead of the events of any write committed after it.

**Reason:** a subscriber that received a later event first would move its cursor past events it never saw (`events/live-no-repeat`).

**Tests:** `compliance/restore-concurrent.test.ts › tells subscribers about its events in log order, ahead of the events of any write committed after it`.

### `archive/restore-hidden`

While a restore writes, the server MUST NOT show its items, registrations or events to other requests.

**Reason:** a reader that saw part of a restore would see items that a failed restore then takes away.

**Tests:** `compliance/restore-faults.test.ts › shows other requests none of its items, registrations, blobs or events until it commits`.

### `archive/restore-writers-refused`

While a restore runs, from when it begins to place the archive's files until it commits or fails, when any other request has to write, the server MUST answer that request `503 write_contention` with `details.reason` `restore_running`, within one second of the request arriving.

**Reason:** the restore holds the write lock until it commits, which can take a minute at 250,000 items, and the files it carries until then. A write that reached the lock or a file after the restore began would wait for all of it. A write that waited out the five-second write wait first would spend that wait on each retry and learn nothing about the cause. A device retries any `5xx` without counting it against the write (`queue-and-verdicts/environmental-uncounted`), so the code stays the one it retries.

**Tests:** `compliance/restore-faults.test.ts › refuses each kind of write at once, naming the restore, while reads and the restore itself go on`, `compliance/restore-faults.test.ts › refuses an upload of bytes the restore carries at once, rather than waiting for the restore`, `compliance/restore-faults.test.ts › refuses a write at once while the restore places its files, before its own write starts`, `› takes writes and uploads while the archive is still arriving, and refuses a write at once once the restore writes`, `› refuses a housekeeping run asked for while the restore runs, at once and naming the restore`, `› refuses an upload that finishes a queued deletion of its bytes while the restore runs, at once and naming the restore`, `› refuses a backup asked for while the restore runs, at once and naming the restore`, `compliance/restore-concurrent.test.ts › answers each write 201 or 503 restore_running, and keeps every item it answered 201`.

### `archive/restore-writers-retry-after`

While a restore runs, when the server answers a write `503 write_contention` with `details.reason` `restore_running`, the server MUST carry a `Retry-After` of 5 seconds, and the same number in `details.retry_after_seconds`.

**Reason:** the server cannot tell how long a restore will run, so it states no estimate. Each refusal is answered at once, so five seconds costs a client about ten of them across a restore of 250,000 items, and a restore of a few thousand items ends within one.

**Tests:** `compliance/restore-faults.test.ts › refuses each kind of write at once, naming the restore, while reads and the restore itself go on`.

### `archive/restore-writers-nothing-written`

If the server refuses a write because a restore runs, then the server MUST write nothing for that request.

**Reason:** a caller that retries the refused write then cannot make it twice, and a write answered with success during or around a restore is never missing afterwards.

**Tests:** `compliance/restore-faults.test.ts › refuses each kind of write at once, naming the restore, while reads and the restore itself go on`, `compliance/restore-concurrent.test.ts › answers each write 201 or 503 restore_running, and keeps every item it answered 201`.

### `archive/restore-readers-served`

While a restore runs, the server MUST answer a read of the items without waiting for the restore.

**Tests:** `compliance/restore-faults.test.ts › refuses each kind of write at once, naming the restore, while reads and the restore itself go on`.

### `archive/restore-bytes-kept`

When the server removes the blob bytes of a restore that did not commit, the server MUST NOT remove bytes that a committed item names.

**Reason:** content addressing means that a committed item can name the same bytes the restore placed.

**Tests:** `compliance/restore-faults.test.ts › keeps the bytes a committed item names, and removes those no item names`, `› refuses an upload of bytes the failed restore placed while it runs, and keeps that upload sent again`.
