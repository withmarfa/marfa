# Setting up a folder

A folder is a directory bound to a `system.folder` item, with a working copy and a queue. The device and queue rules also apply (`device.md`, `queue-and-verdicts.md`).

This chapter holds how a folder is bound, set up, listed, handed to a command and synced from login. `device.md` lists the answers the scripted server gives that the real server cannot be made to give, and why; `device/fidelity.test.ts` checks every answer the real server can produce against the scripted server's.

## Binding and settings

### `folder-setup/bind-folder`

When a directory is added as a folder, a device MUST bind it to the named `system.folder` using the settings read from that item.

**Tests:** `device/folders.test.ts › reads its settings from the system.folder it is bound to`.

### `folder-setup/bind-live-folder`

If the named item is not a live `system.folder`, then the CLI MUST refuse `folders add`.

**Tests:** `device/folders.test.ts › refuses to follow an item that is not a live folder`.

### `folder-setup/settings-file`

When a directory is added as a folder, a device MUST write its settings as a YAML map in `.marfa/folder.yaml`, with `folder` naming the item and `version` naming the version read.

**Tests:** `device/folders.test.ts › writes its settings out as one file in .marfa/`.

### `folder-setup/settings-read-per-pass`

When another device changes the bound `system.folder`, a device MUST follow the changed settings at the next folder pass that receives them.

**Tests:** `device/folders.test.ts › takes settings changed on another device`.

### `folder-setup/settings-refresh-file`

When a pull receives changed settings and the settings file has no unsent edit, a device MUST rewrite `.marfa/folder.yaml` with those settings and their version.

**Tests:** `device/folders.test.ts › rewrites its settings file when the settings change elsewhere`.

### `folder-setup/settings-preserve-edit`

While `.marfa/folder.yaml` has an unsent edit, a device MUST NOT overwrite that edit with settings received from another device.

**Tests:** `device/folders.test.ts › does not write its settings file over the person's edit, and sends the edit`.

### `folder-setup/settings-send`

When a push or watch reads an edit of `.marfa/folder.yaml`, a device MUST send the changed settings through `PATCH /folders/{id}`.

**Tests:** `device/folders.test.ts › sends an edit to its settings file through the folder door`.

### `folder-setup/settings-version`

When a device sends an edit of `.marfa/folder.yaml`, a device MUST base the edit on the positive integral version its `version` line names, including quoted and decimal spellings of an integer.

**Tests:** `device/folders.test.ts › bases an edit of its settings file on the version written in it`.

### `folder-setup/settings-version-fallback`

If an edited settings file has no valid positive integral `version` line, then a device MUST base the edit on the version last written to that file.

**Tests:** `device/folders-contract-a.test.ts › uses the last written settings version when the file names no valid version`.

### `folder-setup/settings-current-delta`

When a settings file names the version last written to it, a device MUST send only settings that differ from that last write.

**Tests:** `device/folders.test.ts › sends an edit to its settings file through the folder door`.

### `folder-setup/settings-stale-whole`

When an edited settings file names another version and differs from the settings in force, a device MUST send every setting the file names.

**Tests:** `device/folders.test.ts › bases an edit of its settings file on the version written in it`, `device/folders.test.ts › rewrites a settings file whose edit changes no setting`.

### `folder-setup/settings-use-answer`

When the server accepts an edit of the settings file, a device MUST use the resulting settings for subsequent work in the same push.

**Tests:** `device/folders.test.ts › sends an edit to its settings file through the folder door`.

### `folder-setup/settings-invalid-hold`

If an edited settings file cannot be parsed, names another folder, or asks for unsupported settings, then a device MUST retain the settings in force.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folder-setup/settings-name-refusal`

If saved folder settings contain a refused default tag, a refused default property name or a filter comparison with `null`, then a device MUST refuse to read those settings.

**Tests:** `device/folder-names.test.ts › stops where it is told, naming the setting, and runs with a default it takes`, `device/folder-names.test.ts › says which setting, what is wrong with it and how to change it`.

### `folder-setup/settings-name-guidance`

If saved folder settings contain a refused default tag, a refused default property name or a filter comparison with `null`, then a device MUST name the setting, explain the refusal and identify `marfa folders update` as the command that changes it.

**Tests:** `device/folder-names.test.ts › says which setting, what is wrong with it and how to change it`, `device/folders-contract-c.test.ts › names each refused default and explains how to change it`.

### `folder-setup/settings-refused-bytes`

When a settings edit is refused, a device MUST preserve the edited file.

**Tests:** `device/folders-contract-a.test.ts › holds a settings edit refused with status %s without resending its text`.

### `folder-setup/settings-refusal-report`

When a settings edit is refused, a device MUST report the reason in `settings.flagged`.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`, `device/folders-contract-a.test.ts › holds a settings edit refused with status %s without resending its text`.

### `folder-setup/settings-refusal-words`

When a push or pull reports a refused settings edit, the CLI MUST say that the edited settings are not in force.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folder-setup/settings-refusal-no-repeat`

When the folder operation refuses a settings edit with `400`, `403`, `404`, `422`, or a `409` other than `instance_changed`, a device MUST NOT resend the same text.

**Reason:** `409 instance_changed` ends the call and expires the copy instead (`device/instance-changed-one-write`).

**Tests:** `device/folders-contract-a.test.ts › holds a settings edit refused with status %s without resending its text`.

### `folder-setup/settings-transient-retry`

When a settings edit receives a failing-server, rate-limit, or spent-credential answer, a device MUST retry the unchanged edit at the next push.

**Tests:** `device/folders-contract-a.test.ts › retries a settings edit after status %s`, `device/folders.test.ts › sends a settings edit the folder door could not take for now at the next push`.

### `folder-setup/settings-transient-report`

When a settings edit cannot be sent because of a failing-server, rate-limit, or spent-credential answer, a device MUST flag it as not sent yet.

**Tests:** `device/folders-contract-a.test.ts › retries a settings edit after status %s`.

### `folder-setup/settings-conflict-advice`

When the folder operation refuses a settings edit for a conflict, a device MUST advise deleting the file to recover the settings in force before editing again.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folder-setup/settings-restore-file`

When the settings file is deleted, a device MUST recreate it from the settings in force at the next push.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folder-setup/settings-equivalent-no-send`

When an edited settings file names exactly the settings in force, a device MUST NOT send a settings change for differences in presentation or version alone.

**Tests:** `device/folders.test.ts › rewrites a settings file whose edit changes no setting`.

### `folder-setup/settings-equivalent-rewrite`

When an edited settings file names exactly the settings in force, a device MUST rewrite the file from those settings.

**Tests:** `device/folders.test.ts › rewrites a settings file whose edit changes no setting`.

### `folder-setup/settings-current-omission`

When a current settings file omits a setting that the last write named, a device MUST refuse that edit.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folder-setup/settings-rehydrate`

When changed folder settings require another type or tier slice, or name other member states or another filter, a device MUST hydrate that slice at the next push.

**Tests:** `device/folders.test.ts › hydrates again where its changed settings ask for another slice`, `› takes settings changed on another device`, `device/folders-copy-shrink.test.ts › keeps every unsent write and changes no file when a changed query %s shrinks the copy`.

### `folder-setup/settings-read-permission`

If the key cannot read `system.folder`, then the CLI MUST refuse `folders add` naming `system.folder:read`.

**Tests:** `device/folders.test.ts › refuses to follow settings its key cannot read, naming the permission`.

### `folder-setup/settings-readd-replaces`

When the same folder is added again to its directory, a device MUST replace the settings file with the settings in force, including over an unsent edit.

**Tests:** `device/folders-contract-a.test.ts › replaces an unsent settings edit when the same folder is added again`.

### `folder-setup/settings-watch-refusal`

When a settings edit is refused during a watch, the CLI MUST say why the edited settings are not in force.

**Tests:** `device/folders-contract-a.test.ts › tells a watch why a settings edit is not in force`.

### `folder-setup/settings-omission-advice`

When a current settings file omits a setting, a device MUST advise writing an empty list or map instead of removing the setting.

**Tests:** `device/folders-contract-a.test.ts › advises empty values when an edit removes a current setting`.

### `folder-setup/settings-watch-refill`

When changed folder settings require another type or tier slice, or name other member states or another filter, during a running watch, a device MUST fetch the items that slice holds and write their files without the watch being restarted.

**Reason:** a watch started at login can run for days, and a person who widens a query expects its items to appear.

**Tests:** `device/folders-contract-a.test.ts › fetches what a widened query holds at the running watch's next pass`, `› says a widened query waits while the server cannot be reached, and fetches it once it answers`.

### `folder-setup/settings-watch-refill-waits`

If a running watch cannot fetch the items its changed folder settings require, then the CLI MUST say that the changed query waits and why.

**Tests:** `device/folders-contract-a.test.ts › says a widened query waits while the server cannot be reached, and fetches it once it answers`.

## Local refusals and first sync

### `folder-setup/invalid-document-contained`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST retain the file’s bytes.

**Tests:** `device/folders-frontmatter.test.ts › refuses an empty null property name before deciding a save is unchanged`, `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`, `device/property-validation.test.ts › flags a document whose list holds an element of the wrong type, keeps its bytes and takes it once mended`.

### `folder-setup/invalid-document-flagged`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST flag the local refusal.

**Tests:** `device/folders-frontmatter.test.ts › refuses an empty null property name before deciding a save is unchanged`, `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`, `device/property-validation.test.ts › flags a document whose list holds an element of the wrong type, keeps its bytes and takes it once mended`.

### `folder-setup/invalid-document-scan-continues`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST continue scanning other files.

**Tests:** `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`, `device/property-validation.test.ts › flags a document whose list holds an element of the wrong type, keeps its bytes and takes it once mended`.

### `folder-setup/invalid-document-retried`

When a refused folder document is corrected or its type becomes available in the held catalog, a device MUST retry admission at a later scan.

**Tests:** `device/folders-frontmatter.test.ts › refuses an empty null property name before deciding a save is unchanged`, `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`, `device/property-validation.test.ts › flags a document whose list holds an element of the wrong type, keeps its bytes and takes it once mended`.

### `folder-setup/refused-line-retried`

When a folder scan finds an unchanged frontmatter line whose edge the device refused before and the device would now take that edge, a device MUST queue the edge and clear the refusal.

**Reason:** what the device refused the edge for, such as an edge type's endpoint constraints or the other item's type, can change on another machine while the file stays as it was. A refusal the server gave stands until the file changes.

**Tests:** `device/folders-frontmatter.test.ts › queues a line the copy refused once the edge type admits it, the file unchanged`.

### `folder-setup/first-sync-waits`

When a folder is added without confirmation and has files to write or send, a device MUST hold its first sync for confirmation.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`.

### `folder-setup/first-sync-no-effects`

While a folder’s first sync waits for confirmation, a device MUST NOT write item files into the directory.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`.

### `folder-setup/first-sync-no-effects-writes-unsent`

While a folder’s first sync waits for confirmation, a device MUST NOT send queued writes to the server.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`.

### `folder-setup/first-sync-plan`

When a waiting folder’s first-sync plan is read, a device MUST report the counts `write`, `send`, `beside` and `left` from the current copy and directory.

**Reason:** `beside` counts a file written where a file the folder sends already is, and one of the two takes a number in its name; two names are the same path when they differ only in case or Unicode form, as the folder compares them. `left` counts an item whose file is not written because a file the folder does not send is at the path, which `folder-setup/first-sync-plan-left` says. `write` counts neither of the files `left` counts.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`, `device/folders.test.ts › writes beside a file already where an item's file would go, and says so`, `device/folders.test.ts › counts a file whose name differs from an item's only in case as a file written beside, not one left`, `device/folders.test.ts › counts a file whose name differs from an item's only in Unicode form as a file written beside, not one left`, `device/folders-frontmatter.test.ts › is counted in the first sync's plan`.

### `folder-setup/first-sync-plan-left`

When a waiting folder’s first-sync plan finds a file the folder does not send at the path an item's file would take, a device MUST count the item in `left` and in neither `write` nor `beside`.

**Reason:** a file the folder holds back is the person's to mend, so the first sync neither sends it nor writes over it, and adds no number to the item's name. Counting the item as written beside would promise a file that never appears.

**Tests:** `device/folders.test.ts › says it leaves a file it cannot send where an item's file would go, and writes no file there`.

### `folder-setup/first-sync-plan-writes-unsent`

When a waiting folder’s first-sync plan is read, a device MUST NOT send queued writes to the server.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`, `device/folders.test.ts › writes beside a file already where an item's file would go, and says so`.

### `folder-setup/first-sync-offline-plan`

When a waiting folder’s server is unreachable and the folder already holds a usable copy, a device MUST report its first-sync plan from that copy.

**Tests:** `device/folders.test.ts › reads the copy it already holds when the server is out of reach`.

### `folder-setup/first-sync-status`

While a folder’s first sync waits, a device MUST include its waiting state and last read plan in folder status.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`.

### `folder-setup/first-sync-watch-refused`

While a folder’s first sync waits, the CLI MUST refuse to start a watch with `first_sync_waiting`.

**Tests:** `device/folders.test.ts › refuses a watch while it waits, and a script confirms it with --yes`.

### `folder-setup/first-sync-drain-refused`

While a folder’s first sync waits, a device MUST refuse a drain through the folder’s device door with `first_sync_waiting`.

**Tests:** `device/folders.test.ts › refuses a drain by the folder's device door while it waits`.

### `folder-setup/first-sync-pull-refused`

While a folder’s first sync waits, a device MUST refuse a pull with `first_sync_waiting`.

**Tests:** `device/folders-contract-b.test.ts › refuses a pull during first sync and uses the directory as it stands after confirmation`.

### `folder-setup/first-sync-current-directory`

When a folder’s first sync is confirmed, a device MUST process the directory as it stands rather than execute an earlier plan’s file list.

**Tests:** `device/folders-contract-b.test.ts › refuses a pull during first sync and uses the directory as it stands after confirmation`.

### `folder-setup/first-sync-settings-refused`

While a folder’s first sync waits, a device MUST refuse submission of its settings-file edit with `first_sync_waiting`.

**Tests:** `device/binding-folders-placement.test.ts › refuses a settings-file submission while first sync waits, then submits the same edit once confirmed`.

### `folder-setup/first-sync-restore-refused`

While a folder’s first sync waits, a device MUST refuse restoration of removals with `first_sync_waiting`.

**Tests:** `device/folders-contract-b.test.ts › refuses restore while first sync waits and confirms without a server request`.

### `folder-setup/first-sync-unmatched-refused`

While a folder's first sync waits, a device MUST refuse removal of unmatched files with `first_sync_waiting`.

**Tests:** `device/folders-unmatched.test.ts › takes files away from a folder a watch holds, and is refused while the first sync waits`.

### `folder-setup/first-sync-terminal-question`

When `folders add` has a nonempty first-sync plan at a terminal without `--yes` or `--json`, the CLI MUST ask for confirmation.

**Tests:** `device/folders-contract-b.test.ts › asks before first sync at a terminal and obeys %s`.

### `folder-setup/first-sync-terminal-answer`

When `folders add` has a nonempty first-sync plan at a terminal without `--yes` or `--json`, the CLI MUST proceed only for `y` or `yes` without regard to case.

**Tests:** `device/folders-contract-b.test.ts › asks before first sync at a terminal and obeys %s`.

### `folder-setup/first-sync-interrupted-confirmed`

When a confirmed folder’s sync is interrupted by a failed file landing, a device MUST keep first sync confirmed for the next attempt and for a later add over the same state.

**Tests:** `device/folders-contract-b.test.ts › keeps first sync confirmed after a failed landing and after adding the folder again`.

### `folder-setup/first-sync-yes`

When `folders add` is given `--yes`, the CLI MUST confirm the folder’s first sync without asking for input.

**Tests:** `device/folders.test.ts › refuses a watch while it waits, and a script confirms it with --yes`.

### `folder-setup/first-sync-confirm`

When `folders confirm` is given a waiting folder, the CLI MUST clear the first-sync wait.

**Tests:** `device/folders.test.ts › goes once it is confirmed, and does not ask again`, `device/folders-contract-b.test.ts › refuses restore while first sync waits and confirms without a server request`.

### `folder-setup/first-sync-confirm-local-only`

When `folders confirm` is given a waiting folder, the CLI MUST NOT contact the server.

**Tests:** `device/folders.test.ts › goes once it is confirmed, and does not ask again`, `device/folders-contract-b.test.ts › refuses restore while first sync waits and confirms without a server request`.

### `folder-setup/first-sync-confirmation-kept`

When a confirmed folder syncs again or is added again over its own state, a device MUST keep the first sync confirmed.

**Tests:** `device/folders.test.ts › goes once it is confirmed, and does not ask again`.

### `folder-setup/first-sync-empty-confirmed`

When a waiting folder’s plan has no files to write, send or place beside another file, a device MUST confirm the first sync automatically.

**Tests:** `device/folders.test.ts › confirms itself where there is nothing to write, send or keep`.

### `folder-setup/first-sync-remove`

When a waiting folder is removed, a device MUST remove its state despite unsent queued writes.

**Tests:** `device/folders.test.ts › is canceled by removing the folder, which leaves its files`.

### `folder-setup/first-sync-remove-files-preserved`

When a waiting folder is removed, a device MUST leave its item files intact.

**Tests:** `device/folders.test.ts › is canceled by removing the folder, which leaves its files`.

### `folder-setup/first-sync-per-machine`

When machines follow the same `system.folder`, a device MUST keep each machine’s first-sync confirmation independently in that folder’s local state.

**Tests:** `device/folders.test.ts › asks of each machine's folder for itself`.

## A store another build made

A folder's store holds a copy of the server's items, the writes still to be sent, and the folder's record of its files: which file is which item, what the folder last read and wrote there, which files went missing, which writes and placements the server refused, and which items were purged. An answer the folder has yet to record is an answer a file's state still waits on, a write the server gave up on, or a write the server refused, unless it is the delete of an edge already gone, or an edit, a tag, a state change or an edge of an item a file in the folder is bound to, which the folder records against the file or its placements, or no longer needs once a later save is taken. Where the store holds no write still to be sent and no answer the folder has yet to record, a hydration brings the copy back and the record carried into the new store keeps each file where it was (`folder-setup/refused-store-record-kept`), so this build can replace a store that another build of the core made (`device/wrong-schema`) without losing anything.

### `folder-setup/refused-store-replaced`

While a device holds a folder's writer role, when it refuses the folder's store `wrong_schema` and the store names the folder, holds no write still to be sent, holds no answer the folder has yet to record, and holds a record of the folder's files that this build can read, a device MUST replace the store with one of this build's shape and go on with the command.

**Reason:** a release that changes the store's shape would otherwise leave every folder unusable until the person removed it and added it again.

**Tests:** `device/folders-refused-store-live.test.ts › replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused`, `› replaces a folder's refused store for a watch of the folder, and sends an edit`, `› watches every folder: replaces a refused store that holds nothing unsent, and leaves one that does`, `› replaces a refused store a running watch hands to a push, and the watch takes the new store back and sends an edit`, `› keeps a file deleted while its store was refused deleted, and sends the deletion`, `› takes away the file of a note put in the bin while its store was refused, and sends no new note`, `› sends an edit of a text file made while its store was refused to the item the file is`, `› keeps holding a file the server refused because its note is in the bin, and sends no new note`, `› keeps a first sync still waiting, and the server the store was filled from, when it replaces the store`.

### `folder-setup/refused-store-kept`

When a device replaces a folder's store, a device MUST keep the folder following the `system.folder` that the replaced store named.

**Tests:** `device/folders-refused-store-live.test.ts › replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused`.

### `folder-setup/refused-store-origin-kept`

When a device replaces a folder's store, a device MUST report in the new store the server origin that the replaced store reported.

**Reason:** a store that records its origin refuses another server (`device/origin-refused`), and the replaced store keeps that protection.

**Tests:** `device/folders-refused-store-live.test.ts › keeps a first sync still waiting, and the server the store was filled from, when it replaces the store`.

### `folder-setup/refused-store-first-sync-kept`

When a device replaces the store of a folder whose first sync waits to be confirmed, a device MUST keep the first sync waiting.

**Tests:** `device/folders-refused-store-live.test.ts › keeps a first sync still waiting, and the server the store was filled from, when it replaces the store`.

### `folder-setup/refused-store-no-first-sync`

When a device replaces the store of a folder whose first sync was confirmed, a device MUST NOT ask for a first sync again.

**Tests:** `device/folders-refused-store-live.test.ts › replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused`.

### `folder-setup/refused-store-files-kept`

When a device replaces a folder's store, a device MUST NOT change any file in the folder outside its state directory.

**Tests:** `device/folders-refused-store-live.test.ts › replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused`.

### `folder-setup/refused-store-matched`

When a device syncs a folder whose store it replaced, a device MUST send each file the folder had matched to an item as that item rather than as a new item.

**Tests:** `device/folders-refused-store-live.test.ts › replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused`, `› replaces a refused store a running watch hands to a push, and the watch takes the new store back and sends an edit`, `› sends an edit of a text file made while its store was refused to the item the file is`.

### `folder-setup/refused-store-edits-sent`

When a device syncs a folder whose store it replaced, a device MUST send each change made to the folder's files while the store was refused.

**Tests:** `device/folders-refused-store-live.test.ts › replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused`, `› replaces a folder's refused store for a watch of the folder, and sends an edit`, `› watches every folder: replaces a refused store that holds nothing unsent, and leaves one that does`, `› replaces a refused store a running watch hands to a push, and the watch takes the new store back and sends an edit`, `› sends an edit of a text file made while its store was refused to the item the file is`.

### `folder-setup/refused-store-record-kept`

When a device syncs a folder whose store it replaced, a device MUST send the deletion of each file found missing before the replacement rather than write the file again.

**Tests:** `device/folders-refused-store-live.test.ts › keeps a file deleted while its store was refused deleted, and sends the deletion`.

### `folder-setup/refused-store-bin-kept`

When a device syncs a folder whose store it replaced, a device MUST take away the unchanged file of each item put in the bin while the store was refused rather than send the file as a new item.

**Tests:** `device/folders-refused-store-live.test.ts › takes away the file of a note put in the bin while its store was refused, and sends no new note`.

### `folder-setup/refused-store-held-kept`

When a device syncs a folder whose store it replaced, a device MUST keep holding each file it held because the server refused its write, rather than send the file as a new item.

**Tests:** `device/folders-refused-store-live.test.ts › keeps holding a file the server refused because its note is in the bin, and sends no new note`.

### `folder-setup/refused-store-purge-kept`

When a device syncs a folder whose store it replaced, a device MUST report as waiting for removal the unchanged file of each item purged before the replacement, rather than as a file bound to an item the copy no longer holds.

**Reason:** a purged item is gone for good, so a hydration cannot bring back the record that it was purged.

**Tests:** `device/folders-identity.test.ts › takes away at confirm the file of an item purged before another build's store was replaced`.

### `folder-setup/refused-store-replaced-told`

When the CLI replaces a folder's store, the CLI MUST say on standard error which folder's store it replaced and why it refused the store.

**Tests:** `device/folders-refused-store-live.test.ts › replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused`, `› replaces a folder's refused store for a watch of the folder, and sends an edit`, `› watches every folder: replaces a refused store that holds nothing unsent, and leaves one that does`.

### `folder-setup/refused-store-replace-advice`

When a device refuses a folder's store `wrong_schema` without replacing it while `folder-setup/refused-store-replaced` would replace it for the folder's writer, a device MUST say that the folder's next push, pull, scan or watch replaces it.

**Reason:** `folders status` only reads, so it never replaces a store.

**Tests:** `device/folders-refused-store-live.test.ts › replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused`.

### `folder-setup/refused-store-unnamed`

When a device refuses `wrong_schema` a store in a folder's state directory that names no folder and holds no write still to be sent, a device MUST say to add the folder again rather than that a push, pull, scan or watch replaces it.

**Tests:** `device/folders-refused-store-live.test.ts › leaves a refused store that names no folder until the folder is added again, which replaces it`.

### `folder-setup/refused-store-unnamed-added`

When a device adds a folder whose store it refuses `wrong_schema`, and the store names no folder and holds no write still to be sent, a device MUST replace the store with one of this build's shape that names the folder added.

**Tests:** `device/folders-refused-store-live.test.ts › leaves a refused store that names no folder until the folder is added again, which replaces it`.

### `folder-setup/refused-store-unsent`

If a device refuses a folder's store `wrong_schema` and the store holds a write still to be sent or an answer the folder has yet to record, or its writes cannot be counted, then a device MUST refuse the command `wrong_schema` rather than replace the store.

**Reason:** only the build that made the store can send those writes or record those answers (`device/wrong-schema-no-delete`).

**Tests:** `device/folders-refused-store-live.test.ts › leaves a folder's store another build made, and the folder's files, while it holds writes the server has not taken`, `› leaves a folder's store another build made while it holds a delete the server gave up on that no file records, and the folder's files`, `› leaves a folder's store another build made whose unsent writes cannot be counted`.

### `folder-setup/refused-store-uncarried`

If a device refuses a folder's store `wrong_schema` and the store holds a record of the folder's files that this build cannot read, then a device MUST refuse the command `wrong_schema` rather than replace the store.

**Reason:** a replacement that left the record behind would write back files deleted while the store was refused and send files of items put in the bin as new items.

**Tests:** `device/folders-refused-store-live.test.ts › leaves a refused store whose record of its files is of another shape, and says to remove the folder with the build that made it`.

### `folder-setup/refused-store-unsent-kept`

When a device refuses a folder's store `wrong_schema` without replacing it, a device MUST leave the store's file and every file in the folder unchanged.

**Tests:** `device/folders-refused-store-live.test.ts › leaves a folder's store another build made, and the folder's files, while it holds writes the server has not taken`, `› leaves a folder's store another build made while it holds a delete the server gave up on that no file records, and the folder's files`, `› leaves a folder's store another build made whose unsent writes cannot be counted`, `› watches every folder: replaces a refused store that holds nothing unsent, and leaves one that does`, `› leaves a refused store that names no folder until the folder is added again, which replaces it`, `› leaves a refused store whose record of its files is of another shape, and says to remove the folder with the build that made it`.

### `folder-setup/refused-store-unsent-advice`

When a device refuses a folder's store `wrong_schema` because it holds a write still to be sent or an answer the folder has yet to record, a device MUST say to push the folder with the build that made the store.

**Tests:** `device/folders-refused-store-live.test.ts › leaves a folder's store another build made, and the folder's files, while it holds writes the server has not taken`, `› leaves a folder's store another build made while it holds a delete the server gave up on that no file records, and the folder's files`.

### `folder-setup/refused-store-unrecorded-advice`

When a device refuses a folder's store `wrong_schema` because it holds a write still to be sent or an answer the folder has yet to record, a device MUST say that a write the server refused or gave up on that a push leaves goes only when the folder is removed with the build that made the store and added again, and that a file whose deletion the server never took then comes back and must be deleted again.

**Reason:** a push sends no write the server refused or gave up on again, so the store goes on holding it, and this build cannot open the store to remove the folder.

**Tests:** `device/folders-refused-store-live.test.ts › leaves a folder's store another build made while it holds a delete the server gave up on that no file records, and the folder's files`.

### `folder-setup/refused-store-uncounted-advice`

When a device refuses a folder's store `wrong_schema` because its writes cannot be counted, a device MUST say to push the folder and remove it with the build that made the store, then add it again.

**Tests:** `device/folders-refused-store-live.test.ts › leaves a folder's store another build made whose unsent writes cannot be counted`.

### `folder-setup/refused-store-uncarried-advice`

When a device refuses a folder's store `wrong_schema` because it holds a record of the folder's files that this build cannot read, a device MUST say to remove the folder with the build that made the store, then add it again.

**Tests:** `device/folders-refused-store-live.test.ts › leaves a refused store whose record of its files is of another shape, and says to remove the folder with the build that made it`.

### `folder-setup/refused-store-watch-every`

When a watch of every folder refuses a folder's store `wrong_schema` without replacing it, a device MUST report that folder not watched, with the refusal, and go on watching the other folders.

**Tests:** `device/folders-refused-store-live.test.ts › watches every folder: replaces a refused store that holds nothing unsent, and leaves one that does`.

## Where a folder sits

A storage warning is one line on standard error that begins `marfa: warning: ` and names the cause. A folder is warned of when `folders add` makes it and when a watch starts on it, whether `folders watch` names the folder or watches every folder. The home directory is the one the operating system records for the user, or the one `HOME` names. Refusing such a folder is not a rule.

### `folder-setup/icloud-storage-warns`

When a folder is added, or a watch starts on a folder, whose directory is below `Library/Mobile Documents` in the home directory, the CLI MUST print a storage warning that names iCloud Drive.

**Reason:** iCloud Drive syncs those files itself, so a second program syncs the same files as Marfa and the two can overwrite each other’s changes or leave conflicting copies.

**Tests:** `device/folders-storage-warning.test.ts › warns once on standard error when it is added to iCloud Drive, and adds it all the same`, `› warns once on standard error when a watch starts on a folder in iCloud Drive, and watches all the same`, `› warns of a synced folder whose first sync waits only once its watch has started, after the first sync is confirmed`.

### `folder-setup/icloud-ubiquitous-warns`

When a folder is added, or a watch starts on a folder, whose directory is not below `Library/Mobile Documents` or `Library/CloudStorage` in the home directory and that macOS reports as ubiquitous (the URL resource key `isUbiquitousItem`), the CLI MUST print a storage warning that names iCloud Drive or another cloud service’s synced location.

**Reason:** With iCloud’s “Desktop & Documents” on, `Desktop` and `Documents` are real directories outside `Library/Mobile Documents` that iCloud Drive syncs. macOS reports every File Provider item as ubiquitous, so the key alone does not say which service syncs it.

**Tests:** none, closed in #2027: no CI runner has a signed-in iCloud account, and a fixture for it was judged not worth building.

### `folder-setup/cloud-storage-warns`

When a folder is added, or a watch starts on a folder, whose directory is below `Library/CloudStorage` in the home directory, the CLI MUST print a storage warning that names a cloud service’s synced location.

**Reason:** The File Provider services (such as Dropbox, OneDrive, Google Drive and Box) keep their files there and sync them themselves, with the same effect as iCloud Drive.

**Tests:** `device/folders-storage-warning.test.ts › warns once on standard error when it is added to a cloud service's synced location, and adds it all the same`, `› warns once on standard error when a watch starts on a folder in a cloud service's synced location, and watches all the same`.

### `folder-setup/network-storage-warns`

When a folder is added, or a watch starts on a folder, whose directory is on a file system that `statfs` reports as `smbfs`, `nfs`, `afpfs` or `webdav` on macOS, or as the NFS (0x6969), CIFS (0xFF534D42) or SMB2 (0xFE534D42) file system type on Linux, the CLI MUST print a storage warning that names the file system type and says that a change made from another computer may not be noticed.

**Reason:** A network file system may not send change notifications for what another computer writes.

**Tests:** none, closed in #2027: no CI runner has a network file system, and a fixture for one was judged not worth building.

### `folder-setup/git-tracked-warns`

When a folder is added whose directory is tracked by git, meaning the directory is in a git work tree and that work tree’s index holds a file in it, the CLI MUST print one line on standard error that begins `marfa: warning: ` and names git and the directory.

**Reason:** A checkout, reset or branch switch changes those files and Marfa syncs the changes, so git and Marfa both change the same files. A folder kept beside code is best put in a directory git ignores.

**Tests:** `device/folders-git-warning.test.ts › warns on standard error when git tracks the directory, and adds it all the same`, `› warns of a directory in a linked work tree, where .git is a file`, `› keeps standard output to its JSON document under --json`.

### `folder-setup/git-tracked-continues`

If the CLI prints the git warning, then the CLI MUST add the folder as it would a directory git does not track.

**Reason:** Someone who backs up through git is not stopped; the warning informs the person.

**Tests:** `device/folders-git-warning.test.ts › warns on standard error when git tracks the directory, and adds it all the same`.

### `folder-setup/git-untracked-silent`

While a folder’s directory is not tracked by git, whether it is ignored by git, holds no file in a git index, is outside every git work tree, or git cannot be run or answers with an error, the CLI MUST NOT print the git warning for it.

**Reason:** `.git` alone does not say a directory is tracked, and nothing git owns yet cannot be changed by a checkout. The warning only informs, so a missing or failing `git` never fails the add.

**Tests:** `device/folders-git-warning.test.ts › prints no warning for a directory that is ignored, untracked, or outside a repository`, `› prints no warning, and adds the folder, when git cannot be run`.

### `folder-setup/storage-warning-continues`

If the CLI prints a storage warning, then the CLI MUST add the folder or watch it as it would a directory elsewhere.

**Reason:** The warning informs the person; refusing such a folder is not a rule.

**Tests:** `device/folders-storage-warning.test.ts › warns once on standard error when it is added to iCloud Drive, and adds it all the same`, `› warns once on standard error when a watch starts on a folder in iCloud Drive, and watches all the same`.

### `folder-setup/storage-warning-once`

While a command runs, the CLI MUST NOT print a storage warning for the same folder more than once.

**Reason:** A watch of every folder starts a folder’s watch again after it ends or after the folder is listed again.

**Tests:** `device/folders-storage-warning.test.ts › warns once per synced folder, and not again when a folder is taken off the list and put back`.

### `folder-setup/storage-warning-elsewhere`

While a folder’s directory is not below `Library/Mobile Documents` or `Library/CloudStorage` in the home directory, is not one that macOS reports as ubiquitous, and is on none of the file systems that `folder-setup/network-storage-warns` names, the CLI MUST NOT print a storage warning for it.

**Tests:** `device/folders-storage-warning.test.ts › prints no warning when it is added or watched, where the same home warns of a synced one`, `› is not taken for a synced one by a name that only begins like a synced location`.

### `folder-setup/storage-warning-json`

Where `--json` is given, the CLI MUST print a storage warning on standard error and not in the JSON on standard output.

**Reason:** A program reading standard output gets only JSON, as it does when the CLI warns of a plain `http` address.

**Tests:** `device/folders-storage-warning.test.ts › keeps standard output to its JSON document under --json, with the warning a plain line on standard error`.

## The query a folder holds

### `folder-setup/copy-holds-query`

Where a folder's query names a filter that names no edge, backreference or part, an item to narrow beneath, or member states other than `active` and `archived`, a device MUST hydrate the folder's copy with a slice whose query is the folder's member states, filter and item to narrow beneath.

**Reason:** the copy then holds about the items the folder shows, so a folder of six files does not hold every note on the server.

**Tests:** `device/folders-copy-shrink.test.ts › hydrates only the items its query shows, with those in the bin and its conflicted copies`, `› hydrates only the item and everything beneath it, with its parent-of edges whole`.

### `folder-setup/copy-query-relational`

Where a folder's query filters by an edge, a backreference or a part, a device MUST hydrate the folder's copy without the query's filter, with the query's item to narrow beneath, and with its member states where they are other than `active` and `archived`.

**Reason:** the item listing cannot yet be narrowed by edges, so such a folder's copy holds every item of its types beneath the item it names, or every item of its types where it names none.

**Tests:** `device/folders-copy-shrink.test.ts › hydrates with the query's states alone a query that filters by an edge`.

### `folder-setup/copy-query-change-hydrates`

When a folder's copy holds a slice whose query differs from the one the folder's settings now ask for, including a copy filled with no query, a device MUST hydrate the copy at the folder's next pass.

**Reason:** a store an earlier build filled holds every item of its types and records no query, so its next pass shrinks it to what the folder shows.

**Tests:** `device/folders-copy-shrink.test.ts › keeps every unsent write and changes no file when a changed query %s shrinks the copy`.

### `folder-setup/copy-shrink-keeps-unsent`

When a device hydrates a folder's copy again, a device MUST keep every queued write with its verdict, the folder's record of its files, its journal, its pins and its paused removals.

**Reason:** a hydration removes items of the copy and nothing the person has not yet sent, so a push after it sends every unsent write.

**Tests:** `device/folders-copy-shrink.test.ts › keeps every unsent write and changes no file when a changed query %s shrinks the copy`, `› keeps every unsent write when a shrink stopped midway is resumed`.

### `folder-setup/copy-shrink-files-unchanged`

When a device hydrates a folder's copy again, a device MUST NOT change, add or remove a file of the folder during the hydration.

**Tests:** `device/folders-copy-shrink.test.ts › keeps every unsent write and changes no file when a changed query %s shrinks the copy`, `› keeps every unsent write when a shrink stopped midway is resumed`.

### `folder-setup/search-match`

When a folder evaluates membership, a device MUST apply its query types and their descendants, tier, state, and filters on tags, properties, and edges.

**Tests:** `device/folders.test.ts › holds exactly what its query matches`.

### `folder-setup/search-beneath`

When a folder query names `beneath`, a device MUST include the named item and its readable descendants reached through `parent-of`.

**Tests:** `device/folders-contract-a.test.ts › materializes only readable copy items reached by a beneath query`, `device/folders.test.ts › holds exactly what its query matches`.

### `folder-setup/beneath-file-one-pass`

When a folder's query names `beneath` as the path of a file the folder holds, a device MUST, in the sync that sends that file, replace the path in the folder's query with the id of the file's item and pull the items beneath it.

**Reason:** a project that is a file of the folder has no item until the folder sends it, so a folder narrowed beneath it is set up in one pass, with no stand-in item and no later change to the folder's settings. A file that already carries the id of a live item takes that item.

**Tests:** `device/folders-beneath-file-live.test.ts › sets up a folder beneath a project its own file names in one pass, and writes nothing from outside the project`, `device/folders-beneath-file-live.test.ts › sends a project file that has no item yet and names its item, holding nothing from outside until then`, `device/folders-beneath-file.test.ts › names the project's item once its file is sent, and pulls what lies beneath in the same pass`.

### `folder-setup/beneath-file-holds-nothing`

While a folder's query names `beneath` as a path whose file has no item the server holds, a device MUST NOT write a file for an item the server holds.

**Reason:** a copy narrowed beneath nothing would otherwise hold everything the rest of the query matches, which is what the narrowing is there to prevent.

**Tests:** `device/folders-beneath-file-live.test.ts › sets up a folder beneath a project its own file names in one pass, and writes nothing from outside the project`, `device/folders-beneath-file-live.test.ts › sends a project file that has no item yet and names its item, holding nothing from outside until then`, `device/folders-beneath-file.test.ts › holds nothing from the server while the change is not sent, and finishes at the next pass`.

### `folder-setup/beneath-file-missing-refused`

If a folder's query names `beneath` as a path that no file the folder sends is at, then a device MUST refuse the sync, naming the path.

**Reason:** a path the folder could never send would leave the folder holding nothing for good.

**Tests:** `device/folders-beneath-file-live.test.ts › refuses to set up a folder beneath a file that is not there, naming it, and changes nothing`, `device/folders-beneath-file.test.ts › refuses a first sync that names a file the folder does not have, writing and sending nothing`.

### `folder-setup/beneath-file-missing-changes-nothing`

If a device refuses a sync because the file its folder's query names in `beneath` is missing, then a device MUST NOT send a write or write a file.

**Tests:** `device/folders-beneath-file-live.test.ts › refuses to set up a folder beneath a file that is not there, naming it, and changes nothing`, `device/folders-beneath-file.test.ts › refuses a first sync that names a file the folder does not have, writing and sending nothing`.

### `folder-setup/beneath-file-path-match`

When a folder's query names `beneath` as a path, a device MUST take the file it holds at a path that differs only in case or Unicode form as the file the path names.

**Reason:** two names are the same path when they differ only in case or Unicode form, as the folder compares them everywhere else (`folder-setup/first-sync-plan`).

**Tests:** `device/folders-beneath-file.test.ts › takes the file the query names for the one the folder holds, as the folder compares paths`.

### `folder-setup/beneath-file-conflict-named`

When the folder door refuses a device's change of `query.beneath` with `409 version_conflict` and the folder's query now names an item, a device MUST NOT send another change.

**Tests:** `device/folders-beneath-file.test.ts › reads the folder again when %s between its read and its change`.

### `folder-setup/beneath-file-conflict-retried`

When the folder door refuses a device's change of `query.beneath` with `409 version_conflict` and the folder's query still names the path, a device MUST send the change again on the version it read after the refusal.

**Tests:** `device/folders-beneath-file.test.ts › reads the folder again when %s between its read and its change`.

### `folder-setup/beneath-file-resumed`

When a device could not send its change of `query.beneath` to the item of the file, a device MUST send it at the next sync, before it pulls anything.

**Reason:** a sync stopped between sending the file and changing the query leaves the path in the query, and the next sync finishes it.

**Tests:** `device/folders-beneath-file.test.ts › holds nothing from the server while the change is not sent, and finishes at the next pass`.

### `folder-setup/beneath-file-waits`

While a folder's query names `beneath` as a path whose file has no item, the CLI MUST report the path as `beneath_waiting` in the folder's status.

**Tests:** `device/folders-beneath-file.test.ts › holds nothing from the server while the change is not sent, and finishes at the next pass`.

### `folder-setup/search-default-types`

When a folder query names no types or names `*`, a device MUST admit every readable type except `system.*`.

**Tests:** `device/folders.test.ts › takes every type, and any default type, where its query names no type or the star`.

### `folder-setup/search-default-tier`

When a folder query names no tier, a device MUST use the `library` tier.

**Tests:** `device/folders.test.ts › holds exactly what its query matches`.

### `folder-setup/query-all-tiers`

When a folder's `query.tier` is `all`, a device MUST write eligible items matching the query from both the `library` and `feed` tiers as files.

**Tests:** `device/folders-query.test.ts › writes matching library and feed items with query tier all`.

### `folder-setup/query-tier-departure-kept`

When an item's tier or a folder's `query.tier` changes so that the item leaves the query's reach and no other folder takes its file, a device MUST keep its existing file as unmatched.

**Tests:** `device/folders-query.test.ts › keeps files and sends no item write when a query narrows from all to library`, `› keeps a file and sends no item write when its item leaves the query tier`.

### `folder-setup/query-tier-never-trashes`

When an item's tier or a folder's `query.tier` changes so that the item leaves the query's reach, a device MUST NOT delete or trash that item on the server because it left the query.

**Tests:** `device/folders-query.test.ts › keeps files and sends no item write when a query narrows from all to library`, `› keeps a file and sends no item write when its item leaves the query tier`.

### `folder-setup/search-default-states`

When a folder query names no states, a device MUST include active and archived items.

**Tests:** `device/folders.test.ts › holds archived items unless its query narrows state`.

### `folder-setup/search-refuse-unsupported`

If folder settings name an unknown setting, query member, defaults member, or removal-threshold member, a `backref` condition, an empty state list, a state other than active or archived, a query tier other than `library`, `feed` or `all`, or a `first_placement` directory the server refuses (`items/folder-setting-followable`), then a device MUST refuse to follow them.

**Tests:** `device/folders.test.ts › refuses a query condition it does not implement`.

### `folder-setup/search-edit-refused`

When a settings-file edit names a query the device cannot answer, a device MUST NOT send that edit.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folder-setup/query-settings-file-refusal`

If a settings-file edit names `search` or a query tier other than `library`, `feed` or `all`, then a device MUST flag the file with an error naming the refused key or tier.

**Tests:** `device/folders-query.test.ts › refuses an unsupported settings-file key or tier ($setting)`.

### `folder-setup/query-cli-flag`

The CLI MUST take the folder query through `--query` on `marfa folders create` and `marfa folders update`.

**Tests:** `device/folders-query.test.ts › names only --query in folders %s and refuses --search`.

### `folder-setup/query-cli-search-refused`

If `marfa folders create` or `marfa folders update` names `--search`, then the CLI MUST refuse it as an unexpected argument.

**Tests:** `device/folders-query.test.ts › names only --query in folders %s and refuses --search`.

## The machine's registry and removing a folder

### `folder-setup/registry-lists-folders`

When the CLI lists the machine's folders, a device MUST include every registered folder's directory and `system.folder` ID.

**Tests:** `device/folders-one-mac.test.ts › lists the folders on the Mac in one registry`.

### `folder-setup/registry-store-identity`

When a folder is registered, a device MUST record its store identity beside its directory and folder ID in the machine registry.

**Tests:** `device/folders-contract-a.test.ts › records each folder's distinct store identity in the shared registry`.

### `folder-setup/registry-registers-folder`

When a folder is added, a device MUST list its admitted absolute directory spelling, followed `system.folder` and store identity in the machine’s folder registry.

**Tests:** `device/folders-one-mac.test.ts › lists the folders on the Mac in one registry`, `device/folders-one-mac.test.ts › refuses a folder reached through a symlink and preserves its registry identity`, `device/folders-contract-b.test.ts › registers the resolved directory, followed folder and store identity`, `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`.

### `folder-setup/registry-independent-stores`

When several folders are registered on one machine, a device MUST keep each folder’s working copy and queue independent.

**Tests:** `device/folders.test.ts › keeps each folder's state and queue to itself`.

### `folder-setup/registry-location`

A device MUST keep the folder registry at `MARFA_FOLDER_REGISTRY` when set, otherwise in `folders.json` under the machine’s application data directory.

**Tests:** `device/folders-one-mac.test.ts › keeps its registry under the home by default`.

### `folder-setup/registry-restored`

When a registered folder performs a pass after its registry entry disappears or its directory moves, a device MUST register the folder’s current directory again.

**Tests:** `device/folders-one-mac.test.ts › lists a folder again where the registry lost it, a watch included`, `device/folders-one-mac.test.ts › holds a delete for a pass when the registry it was listed in is gone, and lists itself again`.

### `folder-setup/nested-folder-refused`

When adding a folder would enclose or fall inside another listed folder, a device MUST refuse the add.

**Tests:** `device/folders-one-mac.test.ts › refuses a folder inside another, and walks past a folder inside it`.

### `folder-setup/nested-folder-refused-any-spelling`

When adding a folder would enclose or fall inside another listed folder, a device MUST refuse the add however either folder's path is spelled, including in another letter case on a case-insensitive volume.

**Reason:** More than one spelling can reach one directory, so only the directories themselves show whether two folders would hold one another's files.

**Tests:** `cli/folder.test.ts › refuses a folder that holds a listed folder, or lies inside one, when its path is spelled in another case`.

### `folder-setup/nested-folder-not-scanned`

When a folder scan encounters a directory holding another folder’s `.marfa/core.sqlite` state, a device MUST exclude that directory’s contents from admission.

**Tests:** `device/folders-one-mac.test.ts › refuses a folder inside another, and walks past a folder inside it`, `device/folders-one-mac.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folder-setup/nested-bound-file-held`

When a bound file’s directory becomes another folder, a device MUST preserve the original binding.

**Tests:** `device/folders-one-mac.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folder-setup/nested-bound-file-held-unreached-count`

When a bound file’s directory becomes another folder, a device MUST count the file as `unreached`.

**Tests:** `device/folders-one-mac.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folder-setup/nested-no-deletion`

When a bound file’s directory becomes another folder, a device MUST NOT journal the file’s deletion.

**Tests:** `device/folders-one-mac.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folder-setup/remove-waiting-refused`

When a confirmed folder has unanswered or blocked queued writes, a device MUST refuse to remove its state.

**Tests:** `device/folders-one-mac.test.ts › refuses to remove a folder with a blocked write`.

### `folder-setup/registry-one-directory`

When the same admitted directory is registered through an equivalent absolute spelling or for another `system.folder`, a device MUST retain only its current registry entry.

**Tests:** `device/folders-one-mac.test.ts › refuses a folder reached through a symlink and preserves its registry identity`, `device/folders-one-mac.test.ts › lists a folder under the folder it follows now, once, and drops one whose state was removed`, `cli/folder.test.ts › lists a folder added again under another letter case once, in place of its old entry`.

### `folder-setup/remove-listed-acts-where-listed`

When a folder is removed by a path that names a listed entry, a device MUST delete folder state at that entry's directory only where that state's store identity is the one the machine’s folder registry lists for the entry.

**Reason:** After a folder is listed, a symbolic link or another folder can take its directory's place.

**Tests:** `cli/folder.test.ts › removes a listed folder whose directory became a link by its listing alone, and leaves the folder the link leads to`, `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`, `cli/folder.test.ts › takes a listed folder off the list without removing a folder moved into its place`.

### `folder-setup/listed-link-remove-unlists`

If a folder is removed by the path at which the machine’s folder registry lists it, and a symbolic link now stands in that path, then a device MUST take that entry off the registry.

**Tests:** `cli/folder.test.ts › removes a listed folder whose directory became a link by its listing alone, and leaves the folder the link leads to`, `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`.

### `folder-setup/remove-follows-only-listed-path`

If a folder is removed by a path that passes through a symbolic link and is not the path at which the machine’s folder registry lists a folder, then a device MUST refuse the removal with `invalid`.

**Reason:** A link above a folder can come to lead into another folder after the folder was listed, and only the listed path binds a removal to the folder the registry lists.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`, `cli/folder.test.ts › removes a listed folder whose directory became a link by its listing alone, and leaves the folder the link leads to`.

### `folder-setup/remove-link-refusal-names-listed`

If a removal is refused because its path passes through a symbolic link in a directory above the folder that no later `..` climbs back out of, and the path reaches a folder that the machine’s folder registry lists, then a device MUST name that folder's listed path in the refusal's message.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`.

### `folder-setup/remove-drops-store-entries`

When a folder's state is removed, a device MUST take every entry that lists that folder's store off the machine’s folder registry.

**Tests:** `cli/folder.test.ts › takes a moved folder's old entry off the list when it is removed at its new place`.

### `folder-setup/remove-deleted-reported`

When a removal deletes a folder's state, the CLI MUST report `removed` as `true` with the directory whose state was deleted.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › takes a moved folder's old entry off the list when it is removed at its new place`.

### `folder-setup/remove-unlisted-reported`

When a removal takes a registry entry off without deleting folder state, the CLI MUST report `removed` as `false` with the reason.

**Tests:** `cli/folder.test.ts › removes a listed folder whose directory became a link by its listing alone, and leaves the folder the link leads to`, `cli/folder.test.ts › takes a listed folder off the list without removing a folder moved into its place`.

### `folder-setup/remove-unlisted-names-other`

When a removal takes a listed entry off without deleting folder state because the state at the entry's directory has the store identity that the machine’s folder registry lists for another entry, the CLI MUST name that other entry's listed path in the reason.

**Tests:** `cli/folder.test.ts › takes a listed folder off the list without removing a folder moved into its place`.

### `folder-setup/registry-root-identity`

When a folder is registered, a device MUST record the identity of the directory it admitted beside its directory and folder ID in the machine registry.

**Reason:** The path alone cannot say whether the directory standing there is the one the folder was admitted at. The identity is an opaque value in each `folders list --json` entry, as `root`, which a program compares for equality and does not parse.

**Tests:** `device/folders-one-mac.test.ts › lists each folder with the identity of the directory it opened, and drops one that records none once its state is removed`.

### `folder-setup/registry-removed-state`

When a registry read finds that the directory at a listed folder’s path holds no folder state and is not known to differ from the directory the folder was admitted at, a device MUST remove that directory’s registry entry.

**Tests:** `device/folders-one-mac.test.ts › lists a folder under the folder it follows now, once, and drops one whose state was removed`, `device/folders-one-mac.test.ts › lists each folder with the identity of the directory it opened, and drops one that records none once its state is removed`.

### `folder-setup/registry-replaced-kept`

When a registry read finds that the directory at a listed folder’s path is not the directory the folder was admitted at, a device MUST retain the folder’s entry, whatever the directory at that path holds.

**Reason:** A restore or a sync tool can replace a folder’s directory with another, empty at first, and the original can return. The entry is how the folder resumes, and how another folder holds a delete for a file that moved into it.

**Tests:** `device/folders-one-mac.test.ts › keeps a folder listed in a listing when an empty directory stands where it was added`, `device/folders-one-mac.test.ts › keeps a folder listed when another folder is added and an empty directory stands where it was added`, `device/folders-one-mac.test.ts › keeps a folder listed, and a delete held, when an empty directory stands where it was added at a pass that looks for a moved file`, `device/folders-one-mac.test.ts › keeps a folder listed when another folder's state stands where it was added`.

### `folder-setup/registry-missing-kept`

When a registry read finds a listed folder missing or unreadable, a device MUST retain its entry.

**Reason:** A directory on a volume that is away cannot be found, as a deleted one cannot, and the entry is what lets another folder hold a delete for a file that may have moved into it.

**Tests:** `device/folders-one-mac.test.ts › holds a delete while a listed folder is missing, until it lists itself again`, `device/folders-one-mac.test.ts › keeps a folder it cannot read listed, and holds a delete meanwhile`, `device/folders-watch-every.test.ts › says in one line which listed folders cannot be found, keeps them listed, and keeps the others in step`.

### `folder-setup/registry-unreadable-deletes-held`

When the machine’s registry cannot be read or disappears during a folder pass, a device MUST defer deletion of missing files whose move cannot be ruled out.

**Tests:** `device/folders-one-mac.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`, `device/folders-one-mac.test.ts › holds a delete for a pass when the registry it was listed in is gone, and lists itself again`.

### `folder-setup/registry-invalid-replaced-on-add`

When a folder is added and the registry’s existing contents cannot be parsed, a device MUST replace the registry with a valid entry for that folder.

**Tests:** `device/folders-one-mac.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

## The record of folder watches

A watch process keeps a record of its folders in `folder-watch.json`, beside the machine’s folder registry, for any program on the machine to read. The file holds `version` (`1`) and `processes`, one entry for each watch process: its `pid`, `build_version`, `started_at`, `heartbeat_at`, `heartbeat_interval_seconds`, `ended_at`, and `folders`. Each folder lists its `dir`, its `system.folder` ID in `folder`, `watching`, `reason`, `last_success_at`, `first_sync_waiting`, `problems`, `pending_uploads`, `pending_downloads` and `paused_removals`. A watch takes a lock on `folder-watch.lock`, beside the file, to write it.

### `folder-setup/watch-record-location`

While `folders watch` runs, with or without a directory, the CLI MUST keep a JSON file named `folder-watch.json` in the directory that holds the machine’s folder registry.

**Reason:** A program on the machine reads what a watch is doing without opening a folder’s store, calling the server or running a command for each folder.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`, `device/folder-watch-record.test.ts › keeps the record of a watch of one folder, and marks the folder not watched when it is stopped`.

### `folder-setup/watch-record-folders`

While `folders watch` runs, a device MUST list in the record, in the entry of its process, each folder it was asked to watch: the folder at the named directory, or every folder the registry lists.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`, `device/folder-watch-record.test.ts › keeps the record of a watch of one folder, and marks the folder not watched when it is stopped`.

### `folder-setup/watch-record-watching`

While a folder is said to be watched, a device MUST set `watching` to `true` for that folder in the record and `reason` to `null`.

**Reason:** A folder tried again after it could not be watched is said to be watched once its watch has lasted, so the record keeps showing why it was not watched until then.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`, `device/folder-watch-record.test.ts › keeps the record of a watch of one folder, and marks the folder not watched when it is stopped`.

### `folder-setup/watch-record-unwatched`

While a folder that a watch of every folder lists is not said to be watched, and its directory can be found, a device MUST list it in the record with `watching` set to `false` and `reason` set to the code of the error that keeps it out.

**Reason:** A program showing folder syncing tells a folder that is failing from one that is not listed. The code is the one `folders watch` reports, and the record holds no message, which may name a path.

**Tests:** `device/folder-watch-record.test.ts › lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it`, `device/folder-watch-record.test.ts › lists the folder whose credential the server refused as not watched, with the problem the report carries`, `device/folders-handover.test.ts › says a folder it let go is held by another process once that process keeps it`.

### `folder-setup/watch-record-missing`

While the directory of a folder that a watch of every folder lists cannot be found, a device MUST list it in the record with `watching` set to `false` and `reason` set to `missing`.

**Reason:** A program showing folder syncing tells a folder whose directory is gone, or on a volume that is away, from one that fails, and can say all of them in one line.

**Tests:** `device/folders-watch-every.test.ts › says in one line which listed folders cannot be found, keeps them listed, and keeps the others in step`, `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folder-setup/watch-record-health`

While a device has read a folder’s latest report to the server, a device MUST set `last_success_at`, `first_sync_waiting`, `problems`, `pending_uploads`, `pending_downloads` and `paused_removals` for that folder in the record to the values of the folder’s latest report.

**Reason:** The record carries the report’s own values, so that a program reading it and the server never disagree about a folder. `last_success_at` is `null` until a sync completes, and `problems` holds the report’s closed set of codes with their counts.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`, `device/folder-watch-record.test.ts › lists the folder whose credential the server refused as not watched, with the problem the report carries`.

### `folder-setup/watch-record-health-unread`

While a device has not read a report to the server for a folder and the folder’s `reason` is not `first_sync_waiting`, a device MUST set `last_success_at`, `first_sync_waiting`, `problems`, `pending_uploads`, `pending_downloads` and `paused_removals` for that folder in the record to `null`.

**Reason:** A reader tells a folder with nothing to report from a folder whose report this process never read, such as one it could not open, though another process may have saved one. A folder whose `reason` is `first_sync_waiting` shows `first_sync_waiting` as `true`.

**Tests:** `device/folder-watch-record.test.ts › lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it`.

### `folder-setup/watch-record-processes`

While several watch processes run on one machine, a device MUST keep one entry in the record for each of them, with its own `pid`.

**Reason:** An entry left by an earlier process that had the same `pid` is replaced, so the `pid` names one entry.

**Tests:** `device/folder-watch-record.test.ts › lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it`, `device/folder-watch-record.test.ts › is never read half written, while two watches write it`, `device/folder-watch-record.test.ts › refreshes a running watch's heartbeat, and marks its folders not watched when it is stopped`.

### `folder-setup/watch-record-version`

While a watch process runs, a device MUST set `build_version` in the process’s entry in the record to the version of the build that runs it, as `marfa --version` prints it.

**Reason:** After an upgrade, a watch started earlier goes on running the build it was started with, and a program reading the record tells it from one on the build installed now.

**Tests:** `device/folders-new-build.test.ts › ends with exit status 3 once a link it was started through moves to a new build, naming both versions, and the next watch sends what it had not`.

### `folder-setup/watch-record-heartbeat`

While a watch process runs and no other process holds the lock on `folder-watch.lock`, a device MUST rewrite the process’s entry in the record, setting `heartbeat_at` to the time of the write, at least once every `heartbeat_interval_seconds`.

**Reason:** A reader decides that an entry is current when its `ended_at` is `null` and its `heartbeat_at` is no later than now and less than three `heartbeat_interval_seconds` before now. A process that was killed cannot say that it ended, so its heartbeat grows old instead.

**Tests:** `device/folder-watch-record.test.ts › refreshes a running watch's heartbeat, and marks its folders not watched when it is stopped`.

### `folder-setup/watch-record-stopped`

When a watch is stopped by an interrupt or by `SIGTERM`, a device MUST set `ended_at` in the process’s entry to the time it stopped and `watching` to `false` for each of the entry’s folders.

**Tests:** `device/folders-autostart.test.ts › ends on SIGTERM within three seconds with exit status 0, and marks its folders not watched`, `device/folder-watch-record.test.ts › refreshes a running watch's heartbeat, and marks its folders not watched when it is stopped`, `device/folder-watch-record.test.ts › keeps the record of a watch of one folder, and marks the folder not watched when it is stopped`.

### `folder-setup/watch-record-killed`

If a watch process is killed, then a device MUST leave that process’s entry in the record as it was until `folder-setup/watch-record-pruned` drops it.

**Reason:** A process that others replaced would show a dead watch as current. The entry keeps its last `heartbeat_at`, which a reader finds older than three `heartbeat_interval_seconds`.

**Tests:** `device/folder-watch-record.test.ts › leaves a killed watch's entry as it was, so that its heartbeat shows it ended`.

### `folder-setup/watch-record-pruned`

When a device writes the record, a device MUST drop each entry of another process whose `heartbeat_at` is an hour or more before now or is later than now.

**Reason:** The record does not keep every watch that ever ran, and a heartbeat that has not happened yet, as after the clock was set back, would otherwise show a watch as current.

**Tests:** `device/folder-watch-record.test.ts › drops the entries nothing has written to for an hour and any that is still to come, and keeps a recent one`.

### `folder-setup/watch-record-whole`

When a device writes the record, a device MUST replace the whole file in one step, keeping the entries of the other watch processes.

**Reason:** A reader never reads half a record, and two watch processes never lose each other’s entries.

**Tests:** `device/folder-watch-record.test.ts › is never read half written, while two watches write it`, `device/folder-watch-record.test.ts › lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it`.

### `folder-setup/watch-record-no-content`

A device MUST NOT write into the record a credential, the name of a file inside a folder, or an item’s content.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`.

### `folder-setup/watch-record-unwritable-said`

If the record cannot be written, then the CLI MUST say so once while the watch runs.

**Tests:** `device/folder-watch-record.test.ts › says once that the record cannot be written, and the watch goes on and writes it once it can`.

### `folder-setup/watch-record-unwritable-goes-on`

If the record cannot be written, then the CLI MUST keep the watch syncing.

**Tests:** `device/folder-watch-record.test.ts › says once that the record cannot be written, and the watch goes on and writes it once it can`.

### `folder-setup/watch-record-locked-syncs`

While another process holds the lock on `folder-watch.lock`, the CLI MUST keep every folder’s watch syncing.

**Reason:** No folder’s start, pass or sync waits on the record.

**Tests:** `device/folder-watch-record.test.ts › goes on syncing and ends on an interrupt while another process holds the record's lock`.

### `folder-setup/watch-record-locked-ends`

If another process holds the lock on `folder-watch.lock` when a watch is interrupted, then the CLI MUST end within three seconds.

**Tests:** `device/folder-watch-record.test.ts › goes on syncing and ends on an interrupt while another process holds the record's lock`.

### `folder-setup/watch-record-locked-said`

If another process has held the lock on `folder-watch.lock` for more than three `heartbeat_interval_seconds` while a watch runs, then the CLI MUST say so once, and again only after a write of the record has succeeded in between.

**Reason:** The watch goes on, but a reader finds its entry old and takes it as ended.

**Tests:** `device/folder-watch-record.test.ts › says once that another process has held the record's lock for long`.

### `folder-setup/watch-record-written-again`

When the record can be written again, a device MUST write it.

**Tests:** `device/folder-watch-record.test.ts › says once that the record cannot be written, and the watch goes on and writes it once it can`.

## Handing a folder to a command

One process works a folder at a time. A command that works a folder, such as `folders confirm`, `folders restore`, `folders remove`, `folders push` or `folders unmatched --remove`, asks a running `folders watch` for the folder, and the watch lets it go and takes it back. An app that works a folder through a binding asks in the same way, and a watch the app runs through a binding lets the folder go and takes it back.

### `folder-setup/handover-asked`

When a command that works a folder finds the folder held by a running `folders watch`, the CLI MUST work the folder once the watch lets it go.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`, `device/folders-unmatched.test.ts › takes files away from a folder a watch holds, and is refused while the first sync waits`, `device/folders-handover.test.ts › hands a folder a watch holds to folders add over it`.

### `folder-setup/handover-wait-refused`

If the process that holds a folder does not let it go within 10 seconds of a command asking for it, then the CLI MUST refuse the command with `reading_handle` before changing local or server state.

**Reason:** A watch that is suspended or stuck never lets go, and a command must not wait on it without end.

**Tests:** `device/folders-handover.test.ts › refuses a command once a suspended watch has not let the folder go in 10 seconds, and both go on once it resumes`.

### `folder-setup/writer-lock-unwritable`

If a folder's writer lock file cannot be written when a command works the folder, then the CLI MUST refuse the command `store` with exit 4, naming the lock file.

**Reason:** a lock file that cannot be written holds no lock, so a command that took the folder on it would leave a watch or another command free to take the folder too, and two processes would work one folder (`folder-setup/handover-asked`).

**Tests:** `device/folders-handover.test.ts › refuses a command that works the folder, and still reads it`.

### `folder-setup/status-lock-unwritable`

While a folder's writer lock file cannot be written, the CLI MUST report the folder's status.

**Reason:** a status reads the store and takes no lock, so a lock file it cannot write is no reason to hide where the folder stands.

**Tests:** `device/folders-handover.test.ts › refuses a command that works the folder, and still reads it`.

### `folder-setup/handover-request-unwritable`

If another process holds a folder and the request file a command asks it by cannot be written, then the CLI MUST refuse the command `store` with exit 4, naming the request file, once the wait of `folder-setup/handover-wait-refused` ends.

**Reason:** a request file that cannot be written holds no request, so the holder is never asked to let go. The command waits for a holder that ends on its own, and says why it could not ask when it stops waiting.

**Tests:** `device/folders-handover.test.ts › refuses a command that asks a watch for the folder once the request file cannot be written`.

### `folder-setup/handover-step-whole`

If a command asks a running `folders watch` for a folder while the watch's pass waits on the server's answer to a write, then the CLI MUST let the folder go only after that answer is taken in.

**Reason:** A write cut off mid-pass would be sent again, or its answer lost.

**Tests:** `device/folders-handover.test.ts › lets a folder go only once the write its pass is sending is answered`.

### `folder-setup/handover-others-go-on`

While a watch of every folder has let one folder go to a command, the CLI MUST keep the other folders it watches in step.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`.

### `folder-setup/handover-taken-back`

When a command a running `folders watch` let a folder go to ends and the folder is still there, the CLI MUST keep the folder in step again without a restart.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`, `device/folders-handover.test.ts › keeps watching a folder named through a linked parent after letting it go`, `device/folders-handover.test.ts › takes a folder back with the credential it began with, though the keychain cannot be read meanwhile`.

### `folder-setup/handover-removed-ends`

When a command that a `folders watch` of one directory let the folder go to removes the folder, the CLI MUST end that watch with exit code 0.

**Tests:** `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folder-setup/handover-unlisted-ends`

When a command that a running `folders watch` let a folder go to takes the folder off the machine’s folder registry, the CLI MUST end the watch of that folder and leave it off the registry.

**Tests:** `device/folders-handover.test.ts › keeps a folder off the list that the command took off it, ending its watch`.

### `folder-setup/handover-held-elsewhere`

If a folder that a running `folders watch` let go is held by another process, with no command asking for it, for longer than 10 seconds, then the CLI MUST report the folder once as not watched, with `watching` false and `code` `reading_handle` in `--json`.

**Reason:** Another watch or an app that takes the folder keeps it until it ends, so reporting the folder as let go to a command would hide why it is not synced.

**Tests:** `device/folders-handover.test.ts › says a folder it let go is held by another process once that process keeps it`, `device/folders-handover.test.ts › says a folder its own watch let go is held by another process once that process keeps it`.

### `folder-setup/handover-let-go-said`

When a running `folders watch` lets a folder go to a command, the CLI MUST report it once, with `watching` false and `code` `handed_over` in `--json`.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folder-setup/handover-taken-back-said`

When a running `folders watch` takes back a folder it let go to a command, the CLI MUST report it, with `watching` true and `taken_back` true in `--json`.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folder-setup/handover-ended-asker`

If a command that asked for a folder ends before the folder is let go, then the CLI MUST keep the watch of that folder in step.

**Reason:** A command killed while it waits must not leave the folder unsynced.

**Tests:** `device/folders-handover.test.ts › goes on syncing a folder whose asking command was killed before the watch let it go`.

### `folder-setup/handover-record-reason`

While a running `folders watch` has let a folder go to a command, a device MUST list that folder in the record of folder watches with `watching` set to `false` and `reason` set to `handed_over`.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folder-setup/handover-binding-asked`

Where an app works a folder through a binding, when a call that adds, syncs, confirms, restores or removes the folder finds it held by a running watch, a device MUST work the folder once the watch lets it go.

**Reason:** A watch that syncs every folder from login holds each of them, so a call that did not ask would be refused for as long as the watch runs.

**Tests:** `device/binding-folders-handover.test.ts › lets a watch go to %s and tells each handover once`.

### `folder-setup/handover-binding-refused`

If the process that holds a folder does not let it go within 10 seconds of a binding call asking for it, then a device MUST refuse the call with `reading_handle` before changing local or server state.

**Reason:** A watch that is suspended or stuck never lets go, and a call must not wait on it without end. The refusal names the folder, so an app can say which one.

**Tests:** `device/binding-folders-handover.test.ts › refuses an asking call at ten seconds without changing the held folder`.

### `folder-setup/handover-binding-lets-go`

When a command or a binding call asks for a folder that an app's watch through a binding holds, a device MUST let the folder go once the step of the watch's pass under way ends.

**Reason:** A write cut off mid-pass would be sent again, or its answer lost (`folder-setup/handover-step-whole`).

**Tests:** `device/binding-folders-handover.test.ts › finishes the scan step before letting the caller work the folder`.

### `folder-setup/handover-binding-let-go-told`

When an app's watch through a binding lets a folder go, a device MUST tell the app's listener once that it did.

**Reason:** An app that shows whether a folder is in step would show a folder it is not watching as watched. The Swift binding tells it as `HandedOver`.

**Tests:** `device/binding-folders-handover.test.ts › lets a watch go to %s and tells each handover once`.

### `folder-setup/handover-binding-taken-back`

When the command or call that an app's watch through a binding let a folder go to ends and the folder is still a folder on the registry, a device MUST keep the folder in step again without the app starting another watch.

**Tests:** `device/binding-folders-handover.test.ts › lets a watch go to %s and tells each handover once`.

### `folder-setup/handover-binding-back-told`

When an app's watch through a binding takes back a folder it let go, a device MUST tell the app's listener that it did.

**Reason:** The Swift binding tells it as `TakenBack`, in place of a second `Watching`.

**Tests:** `device/binding-folders-handover.test.ts › lets a watch go to %s and tells each handover once`.

### `folder-setup/handover-binding-gone-ends`

When the command or call that an app's watch through a binding let a folder go to removes the folder, or takes it off the registry, a device MUST end the watch.

**Reason:** There is no folder left to keep in step. The Swift binding tells `Removed` or `Unlisted` first, so an app can tell the end from its own stop.

**Tests:** `device/binding-folders-handover.test.ts › lets a watch go to %s and tells each handover once`, `device/binding-folders-handover.test.ts › ends after the recipient takes the folder off the registry`.

### `folder-setup/handover-binding-held-elsewhere`

If a folder that an app's watch through a binding let go is held by another process, with no command or call asking for it, for longer than 10 seconds, then a device MUST tell the app's listener once that another process holds it.

**Reason:** Another watch, or an app that takes the folder, keeps it until it ends, so a folder reported as let go to a call would hide why it is not synced. The Swift binding tells it as `HeldElsewhere`.

**Tests:** `device/binding-folders-handover.test.ts › reports another holder once at ten seconds and takes the folder back after it leaves`.

### `folder-setup/handover-binding-watch-refused`

While a process holds a folder, a device MUST refuse an app's watch of the folder through a binding with `reading_handle`.

**Reason:** A watch does not ask for a folder (`folder-setup/one-watch-per-folder`).

**Tests:** `device/binding-folders-handover.test.ts › refuses a second binding watch while the first holds the folder`.

### `folder-setup/one-watch-per-folder`

While a process holds a folder, the CLI MUST refuse `folders watch` of that folder with `reading_handle`.

**Reason:** A watch does not ask for a folder; two watches that asked would take one folder from each other in turn.

**Tests:** `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`, `device/folders-handover.test.ts › says a folder it let go is held by another process once that process keeps it`, `device/folders-handover.test.ts › says a folder its own watch let go is held by another process once that process keeps it`, `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

## Folder syncing from login

`folders autostart on`, `off` and `status` turn on, turn off and report syncing from login. On macOS the agent is a launchd property list named `so.marfa.folder-watch.plist` in `Library/LaunchAgents` under the home directory; on Linux it is a systemd user unit named `marfa-folder-watch.service` in `systemd/user` under the directory the XDG Base Directory Specification names for user configuration (`XDG_CONFIG_HOME`), or under `.config` in the home directory. Where `MARFA_AUTOSTART_ROOT` names a directory, that directory stands in for the home directory, and the CLI runs the `launchctl` or `systemctl` in its `bin` directory, so a fixture never reaches the person’s own service manager.

### `folder-setup/autostart-launchd-agent`

Where the platform is macOS, when `folders autostart on` runs, the CLI MUST write the agent’s property list in `Library/LaunchAgents` under the home directory and load it into the person’s `gui/<uid>` launchd domain.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-systemd-unit`

Where the platform is Linux, when `folders autostart on` runs, the CLI MUST write the agent’s unit in the person’s systemd user unit directory and enable and start it with `systemctl --user`.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-runs-watch`

When `folders autostart on` writes the agent, the CLI MUST make it run `folders watch` with no directory, with `--exit-on-new-build`, and with `--log` naming `folder-watch.log` beside the folder registry, by the absolute path the command was run by where that path leads to the `marfa` binary running it.

**Reason:** A path through a symbolic link, such as a package manager's, still leads to the binary after an upgrade replaces what the link leads to. With `--exit-on-new-build`, the watch the agent runs ends once an upgrade installs a new build there, and the service manager starts the new build (`folder-setup/watch-new-build-ends`).

**Tests:** `device/folders-autostart.test.ts › records the binary by the path it was run as, through a link`, `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`, `device/folders-autostart.test.ts › says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary`.

### `folder-setup/autostart-launchd-output`

Where the platform is macOS, when `folders autostart on` writes the agent, the CLI MUST set `StandardOutPath` and `StandardErrorPath` in the property list to a file named `folder-watch.launchd.log` in the directory of the log.

**Reason:** The watch redirects its own output to the log only once it has opened it, so an error before that, such as a log that cannot be opened, goes where launchd sends the process's output, and is lost if the agent names no file.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`, `› keeps an error the watch makes before it opens its log in the file launchd was given beside the log`.

### `folder-setup/autostart-launchd-output-private`

Where the platform is macOS, when `folders autostart on` writes the agent, the CLI MUST make the file `folder-setup/autostart-launchd-output` names, if it does not exist, readable and writable by its owner alone before launchd starts the watch.

**Reason:** The output names folders’ directories, as the log does (`folder-setup/watch-log-private`). launchd would make the file readable by others, and does not make the directory it lies in.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`, `› keeps an error the watch makes before it opens its log in the file launchd was given beside the log`.

### `folder-setup/autostart-systemd-output`

Where the platform is Linux, when `folders autostart on` writes the unit, the CLI MUST NOT set `StandardOutput` or `StandardError` in it.

**Reason:** systemd sends a service’s standard output to the journal and its standard error to the same place, unless the unit says otherwise, so an error before the watch opens its log is kept there (`journalctl --user -u marfa-folder-watch.service`).

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-status-launchd-output`

Where the platform is macOS, when `folders autostart status` finds an agent the command wrote, the CLI MUST report the file the agent gives the watch’s own output.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folder-setup/autostart-registry`

When `folders autostart on` writes the agent, the CLI MUST set `MARFA_FOLDER_REGISTRY` in the agent’s environment to the absolute path of the folder registry the command resolved.

**Reason:** The watch lists the folders that `folders list` lists from the person’s shell, whatever environment the service manager gives it.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-telemetry`

When `folders autostart on` writes the agent, the CLI MUST write each telemetry setting that is set and not empty in its own environment (`MARFA_POSTHOG_HOST`, `MARFA_POSTHOG_PROJECT_TOKEN`, `OTEL_SDK_DISABLED` and the `OTEL_*` settings the CLI reads to report) to a file named `folder-watch.env` beside the folder registry, readable and writable by its owner alone from the moment it exists.

**Reason:** A launchd agent and a systemd user unit do not inherit the shell’s environment, so a watch started at login would otherwise never send an exception report or a trace. A setting such as `OTEL_EXPORTER_OTLP_HEADERS` holds a credential, and the agent’s file is readable by others, so every setting goes in the one file that only the person can read.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-telemetry-named`

When `folders autostart on` writes the file `folder-setup/autostart-telemetry` names, the CLI MUST name that file in `MARFA_TELEMETRY_FILE` in the agent’s environment.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-telemetry-no-value`

When `folders autostart on` writes the agent, the CLI MUST NOT write the value of a telemetry setting into the agent.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-telemetry-read`

When `folders watch` starts and `MARFA_TELEMETRY_FILE` names a file, the CLI MUST read that file before it reads the telemetry settings, leaving a setting that is already set as it is.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-telemetry-follows`

When `folders autostart on` runs again, the CLI MUST make the file `folder-setup/autostart-telemetry` names hold the settings set in its environment then.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-telemetry-unset`

When `folders autostart on` runs again with no telemetry setting set in its environment, the CLI MUST leave the agent with no telemetry file, removing the file and the agent’s name for it.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-telemetry-restart`

When `folders autostart on` runs again and the file `folder-setup/autostart-telemetry` names changed, the CLI MUST start the watch again.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-telemetry-off`

When `folders autostart off` runs, the CLI MUST remove the file `folder-setup/autostart-telemetry` names.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-telemetry-said`

When `folders autostart on` finishes, the CLI MUST say which telemetry settings it carried, by name and never by value, or that it carried none.

**Tests:** `device/folders-autostart.test.ts › carries the telemetry settings of the shell that ran it into a file only the person can read, names them and no value, and follows the shell on each run`.

### `folder-setup/autostart-no-credential`

The CLI MUST NOT write into the agent a credential, a server address, a variable that names either, such as `MARFA_API_KEY` or `MARFA_API_URL`, or a variable that names a keychain file, such as `MARFA_KEYCHAIN`.

**Reason:** Each folder uses the server its copy came from and the credential the keychain keeps for that server, as a watch of every folder does, or the key file `folder-setup/autostart-key-file` names, whose path the agent holds and whose contents it does not.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`, `› writes the path of a key file into the agent and nothing from it, and says so in the status`.

### `folder-setup/autostart-key-file`

Where `folders autostart on` is given `--key-file` naming a file, the CLI MUST make the agent run `folders watch` with `--key-file` and the absolute path of that file before `--log`, and write no other part of the file into the agent.

**Reason:** A machine where nobody signs in has no keychain to unlock, so the watch takes the server and key from a file that only its owner can read. The agent holds the path alone, so a key that is rotated is read from the file when the watch next opens a folder.

**Tests:** `device/folders-autostart.test.ts › writes the path of a key file into the agent and nothing from it, and says so in the status`.

### `folder-setup/autostart-key-file-refused`

If the file named by `folders autostart on --key-file` or `folders watch --key-file` does not exist, is not a regular file, is a symbolic link, has more than one name, belongs to another user, can be read by its group or by others, lacks a `MARFA_API_URL` line or a `MARFA_API_KEY` line, holds an address that is not a server address, or lies inside a folder the folder registry lists, then the CLI MUST exit 1 with `invalid`, naming the file and the reason and printing no value from it.

**Reason:** A key readable by others is no safer than one on a command line, and a key file inside a folder, under any of its names, would be sent to the server as one of its files. Refusing in `on` finds the fault now and not at the next login.

**Tests:** `device/folders-autostart.test.ts › refuses a key file that others can read, a link, one that lacks a name and one inside a folder, naming the reason and writing nothing`.

### `folder-setup/autostart-key-file-unwritten`

If the file named by `folders autostart on --key-file` is refused under `folder-setup/autostart-key-file-refused`, then the CLI MUST write no agent.

**Reason:** An agent that names a file the watch cannot use would fail at every login.

**Tests:** `device/folders-autostart.test.ts › refuses a key file that others can read, a link, one that lacks a name and one inside a folder, naming the reason and writing nothing`.

### `folder-setup/watch-key-file`

While `folders watch` runs with `--key-file`, the CLI MUST use the address and key of the file for each folder whose copy records that server.

**Tests:** `device/folders-autostart.test.ts › keeps a folder in step from the agent with the key file`.

### `folder-setup/watch-key-file-reread`

While `folders watch` runs with `--key-file` over every folder, the CLI MUST read the file again each time it opens a folder.

**Reason:** A key that is rotated in the file is the one used at the next open, and a file that has become unsafe, or lies inside a folder added since, stops being used.

**Tests:** `device/folders-autostart.test.ts › reads the key file again when it opens a folder, and holds a folder back while the file is unsafe`.

### `folder-setup/watch-key-file-unsafe`

If the file no longer meets `folder-setup/autostart-key-file-refused` when `folders watch` opens a folder, then the CLI MUST report that folder as not watched, with the reason.

**Reason:** One folder or one fault stays contained: the other folders go on, and the folder is tried again.

**Tests:** `device/folders-autostart.test.ts › reads the key file again when it opens a folder, and holds a folder back while the file is unsafe`.

### `folder-setup/watch-key-file-no-keychain`

While `folders watch` runs with `--key-file`, the CLI MUST NOT read the keychain for any folder.

**Reason:** A setup that must never raise a keychain dialog has no use for one.

**Tests:** `device/folders-autostart.test.ts › reads the keychain for no folder with a key file, though it keeps a credential for the folder's server`.

### `folder-setup/watch-key-file-other-server`

While `folders watch` runs with `--key-file`, the CLI MUST NOT send the key of the file to a folder of another server.

**Reason:** One key cannot serve every folder's server.

**Tests:** `device/folders-autostart.test.ts › does not send a key file's key to a folder of another server`.

### `folder-setup/autostart-file-mode`

When `folders autostart on` writes the agent, the CLI MUST leave the file writable by its owner alone.

**Reason:** launchd refuses an agent that others can write.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-restart-policy`

When `folders autostart on` writes the agent, the CLI MUST set it to start the watch again only after the watch ends with a failure, and no sooner than 30 seconds after the watch last started.

**Reason:** A watch that fails at once, as with a binary that is gone, is not started again in a tight loop, and a watch a service manager stopped, which exits 0, stays stopped.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-launchd-priority`

Where the platform is macOS, when `folders autostart on` writes the agent, the CLI MUST set the agent’s `Nice` to 10 and its `LowPriorityIO` to true.

**Reason:** The watch lowers its CPU and I/O priority without privilege, as the systemd unit does under `folder-setup/autostart-systemd-priority`. Its threads also give way to foreground work through utility quality of service under `folder-setup/watch-utility-priority`.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-launchd-not-background`

Where the platform is macOS, when `folders autostart on` writes the agent, the CLI MUST NOT set the agent’s `ProcessType`.

**Reason:** A `Background` agent can starve the watch when every core is busy. Omitting the key uses launchd's `Standard` policy, which applies light CPU and I/O limits without the `Background` classification.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-systemd-priority`

Where the platform is Linux, when `folders autostart on` writes the agent, the CLI MUST set the unit’s `Nice` to 10, its `IOSchedulingClass` to `best-effort` and its `IOSchedulingPriority` to 7.

**Reason:** The watch lowers its CPU and I/O priority without privilege. The unit sets no `CPUWeight`, since a user manager does not always have the cpu controller delegated.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-at-login`

When `folders autostart on` writes the agent, the CLI MUST make the service manager start it when the person signs in: `RunAtLoad` true in the property list on macOS, and `WantedBy=default.target` in the unit on Linux.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-own-credential`

While the agent’s watch runs and the agent names no key file, a device MUST keep each folder in step with the credential the keychain keeps for that folder’s server.

**Tests:** `device/folders-autostart.test.ts › keeps a folder in step from the agent, with the credential the keychain keeps for the folder's server`.

### `folder-setup/autostart-on-said`

When `folders autostart on` completes, the CLI MUST report the agent’s file, the binary the agent runs, its log and the folder registry it reads.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/autostart-on-unchanged`

When `folders autostart on` runs while the agent it would write is installed and loaded, the CLI MUST leave the file unchanged and load nothing again.

**Tests:** `device/folders-autostart.test.ts › changes nothing when turned on again, and off removes the agent and stops its watch, twice over`.

### `folder-setup/autostart-on-replaces`

When `folders autostart on` runs while the installed agent differs from the one it would write, the CLI MUST replace the agent and start the watch again from it.

**Tests:** `device/folders-autostart.test.ts › says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary`.

### `folder-setup/autostart-on-after-failure`

When `folders autostart on` runs after an earlier `folders autostart on` failed before the service manager took the agent it wrote, the CLI MUST load that agent and start the watch from it.

**Reason:** The file on disk alone does not say which agent the service manager runs.

**Tests:** `device/folders-autostart.test.ts › starts the agent it wrote after a swap that failed, rather than saying it is unchanged`.

### `folder-setup/autostart-off`

When `folders autostart off` runs, the CLI MUST stop the agent’s watch and remove the agent’s file.

**Tests:** `device/folders-autostart.test.ts › changes nothing when turned on again, and off removes the agent and stops its watch, twice over`.

### `folder-setup/autostart-off-unchanged`

When `folders autostart off` runs while no agent is installed or loaded, the CLI MUST change nothing and succeed.

**Tests:** `device/folders-autostart.test.ts › changes nothing when turned on again, and off removes the agent and stops its watch, twice over`.

### `folder-setup/autostart-off-unreachable-removes`

If the service manager cannot be asked, or cannot stop the watch, when `folders autostart off` runs, then the CLI MUST still remove the agent’s file.

**Reason:** The watch then does not start at the next login.

**Tests:** `device/folders-autostart.test.ts › removes the agent it wrote though the service manager cannot be asked, and says what it could not do`.

### `folder-setup/autostart-off-unreachable-said`

If the service manager cannot be asked, or cannot stop the watch, when `folders autostart off` runs, then the CLI MUST exit with status 3 and say that it removed the agent’s file and could not stop the watch.

**Tests:** `device/folders-autostart.test.ts › removes the agent it wrote though the service manager cannot be asked, and says what it could not do`.

### `folder-setup/autostart-flags-refused`

If `folders autostart` is given `--url`, `--key` or `--profile`, then the CLI MUST refuse it with `usage` and write nothing.

**Tests:** `device/folders-autostart.test.ts › refuses --url, --key and --profile, and writes nothing`.

### `folder-setup/autostart-status`

When `folders autostart status` runs, the CLI MUST report whether the agent is installed, whether the service manager runs its watch and as which process, the binary the agent runs, where the watch logs, and the key file the agent names, or none.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`, `device/folders-autostart.test.ts › changes nothing when turned on again, and off removes the agent and stops its watch, twice over`, `› writes the path of a key file into the agent and nothing from it, and says so in the status`.

### `folder-setup/autostart-status-offline`

The CLI MUST answer `folders autostart status` with no server named and no credential it can read.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folder-setup/autostart-status-binary-other`

When `folders autostart status` runs while the agent runs a binary other than the one running the command, the CLI MUST say so.

**Tests:** `device/folders-autostart.test.ts › says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary`.

### `folder-setup/autostart-status-binary-gone`

When `folders autostart status` runs while the binary the agent runs no longer exists, the CLI MUST say so.

**Tests:** `device/folders-autostart.test.ts › says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary`.

### `folder-setup/autostart-status-record`

When `folders autostart status` runs while the agent’s watch runs, the CLI MUST report whether the record of folder watches holds a current entry for that watch’s process, and each folder of that entry with its `watching` and `reason`.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folder-setup/autostart-status-missing`

When `folders autostart status` finds folders in the current entry whose `reason` is `missing`, the CLI MUST report them in one line with their count.

**Reason:** A machine’s registry can list many folders whose directories were deleted long ago, and `folders remove` takes each off the list.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folder-setup/autostart-status-credential`

When `folders autostart status` finds a folder in the current entry not watched for `no_credential`, `no_keychain`, `unauthorized` or `signed_out`, the CLI MUST say that the watch has no credential it can use for that folder’s server.

**Reason:** On Linux the watch reads its keys from the Secret Service keychain, which must be unlocked at login for a watch started then. An agent that names a key file reads no keychain.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folder-setup/autostart-status-earlier-build`

When `folders autostart status` runs while the installed agent is one the command wrote but would not write now, the CLI MUST report that it differs from the one `folders autostart on` writes now, and that running `folders autostart on` again with the same options replaces it.

**Reason:** An agent written by an earlier build goes on running as it was written until `on` replaces it, so the settings a later build adds, such as those that lower its priority, reach it only then.

**Tests:** `device/folders-autostart.test.ts › says when the agent was written by an earlier marfa, and on replaces it`.

### `folder-setup/watch-new-build-ends`

Where `folders watch` runs with `--exit-on-new-build`, when the path the command was run by comes to lead to a file other than the one it led to at the start, and that file prints a marfa version for `--version`, the CLI MUST end with exit status 3 once the passes under way finish.

**Reason:** An upgrade installs a new build at the path the agent names, by moving a link, as Homebrew does, or by replacing the file, and a watch left running the old build goes on with it until the person logs out. The service manager starts the watch again only after a failure, so the watch ends with one, between passes, so that no change it was sending is cut off. A change it has not reached stays in the folder for the new build to send. A copy of the same version counts as a new build, since the watch cannot tell it from its own.

**Tests:** `device/folders-new-build.test.ts › ends with exit status 3 once a link it was started through moves to a new build, naming both versions, and the next watch sends what it had not`, `device/folders-new-build.test.ts › ends with exit status 3 for a new build only once the create under way is answered, as a watch of every folder that autostart runs, and the next watch sends what was made meanwhile, once`, `device/folders-new-build.test.ts › ends for a file replaced in place by a new build, as an install that writes the file does`, `device/folders-new-build.test.ts › says once that the path leads to no build, or to a file that is not one, and goes on syncing, and ends for a copy of its build but not for the build itself put back`.

### `folder-setup/watch-new-build-said`

Where `folders watch` runs with `--exit-on-new-build`, when it ends for a new build, the CLI MUST say first the version it runs and the version of the new build.

**Reason:** The log then shows why the watch ended and which build follows it, so an exit with a failure status is not taken for a fault.

**Tests:** `device/folders-new-build.test.ts › ends with exit status 3 once a link it was started through moves to a new build, naming both versions, and the next watch sends what it had not`.

### `folder-setup/watch-new-build-by-hand`

Where `folders watch` runs without `--exit-on-new-build`, when a new build is installed at the path the command was run by, the CLI MUST say once that it is installed, with its version and the version the watch runs, and go on watching.

**Reason:** A person who started the watch at a terminal decides when to start it again; a watch that ended by itself would leave their folders unsynced.

**Tests:** `device/folders-new-build.test.ts › says once that a new build is installed to a watch run by hand, and goes on syncing`.

### `folder-setup/watch-new-build-unusable`

When the path `folders watch` was run by leads to no file, or to a file that prints no marfa version for `--version`, the CLI MUST say so once for each file it leads to, and go on watching.

**Reason:** An uninstall, or an install that has not finished writing the file, must not end a watch the service manager would then start from nothing. The watch looks again, and ends once a build is there.

**Tests:** `device/folders-new-build.test.ts › says once that the path leads to no build, or to a file that is not one, and goes on syncing, and ends for a copy of its build but not for the build itself put back`.

### `folder-setup/watch-signed-out-exit`

When `folders watch` of one folder ends because the sign-in it uses has ended, the CLI MUST end with exit status 5 and name `marfa login` in its message.

**Reason:** Status 3 says the environment failed and a service manager starts the command again, which fails the same way until a person signs in. Status 5 is the status of a credential that no longer works, as `folders push` gives for the same cause.

**Tests:** `device/folders-watch-every.test.ts › ends with exit status 5, telling the person to sign in again, and sends nothing more`.

### `folder-setup/watch-every-signed-out-record`

When the sign-in a folder uses has ended during a watch of every folder, the CLI MUST set `reason` to `signed_out` for that folder in the record, and keep it there for as long as no credential is kept for the folder's server.

**Reason:** A program reading the record, such as `folders autostart status`, tells a folder that needs `marfa login` from one that fails for another reason, and the watch of the other folders goes on. Renewing the dead sign-in drops it from the keychain, and a reason that then changed to `no_credential` would print a second line for the one cause that a single `marfa login` solves.

**Tests:** `device/folders-watch-every.test.ts › records only that folder as signed out and goes on with the others, with the watch staying up`, `device/folders-watch-every.test.ts › keeps telling the sign-in ended while no credential is kept, through every retry`.

### `folder-setup/watch-every-signed-out-stays`

While the sign-in of a folder has ended, the CLI MUST keep the watch of every folder running.

**Reason:** A service manager starts a watch that ends with a failure again, and a watch that ended for a sign-in would be started again into the same refusal. With no folder left to watch it waits to be stopped, and ends then as `folder-setup/watch-terminate` says.

**Tests:** `device/folders-watch-every.test.ts › stays up with no folder left to watch, and ends with exit status 0 once stopped`.

### `folder-setup/watch-every-signed-out-others-go-on`

While the sign-in of a folder has ended, the CLI MUST keep the watch of each other folder running.

**Reason:** One folder's sign-in says nothing of the others, which may follow other servers.

**Tests:** `device/folders-watch-every.test.ts › records only that folder as signed out and goes on with the others, with the watch staying up`.

### `folder-setup/watch-every-signed-out-no-request`

While a folder's sign-in has ended, the CLI MUST NOT send the server a request with the credential that ended.

**Reason:** The server has refused it, and another request would only be refused again.

**Tests:** `device/folders-watch-every.test.ts › sends nothing with the credential that ended, however often it retries the folder`.

### `folder-setup/autostart-restart-on-credential`

When `login` or `keys keep` keeps a credential, and the agent `folders autostart on` wrote is installed and held by the service manager, was written without `--key-file`, and lists a folder that follows the credential's server or has none recorded yet, the CLI MUST ask the service manager to start the agent again.

**Reason:** The watch stops opening a folder with a credential that ended, and starts the folder again at once with the one kept since. An agent with a key file never reads the keychain, and a credential for another server reaches none of its folders, while a folder that has followed no server yet follows the one kept.

**Tests:** `device/folders-autostart.test.ts › starts the watch again when a credential is kept and the agent is installed, and does nothing where it is not`.

### `folder-setup/autostart-restart-not-installed`

When `login` or `keys keep` keeps a credential and no agent `folders autostart on` wrote is installed, the CLI MUST NOT call the service manager.

**Reason:** A person who never turned folder syncing on has no service for the command to touch.

**Tests:** `device/folders-autostart.test.ts › starts the watch again when a credential is kept and the agent is installed, and does nothing where it is not`.

### `folder-setup/autostart-restart-cannot-help`

When `login` or `keys keep` keeps a credential and the installed agent was written with `--key-file`, or lists no folder that follows the credential's server or has none recorded yet, the CLI MUST NOT ask the service manager to start the agent again.

**Reason:** Starting the watch again would end its folders' pending work for a credential it never reads or never uses.

**Tests:** `device/folders-autostart.test.ts › starts the watch again when a credential is kept and the agent is installed, and does nothing where it is not`.

### `folder-setup/watch-terminate`

When `folders watch` receives `SIGTERM`, the CLI MUST end within three seconds with exit status 0.

**Reason:** A service manager stops a watch with `SIGTERM`, and a watch that ends with a failure would be started again.

**Tests:** `device/folders-autostart.test.ts › ends on SIGTERM within three seconds with exit status 0, and marks its folders not watched`, `device/folders-new-build.test.ts › ends with exit status 0 for SIGTERM, though it ends with 3 for a new build`.

### `folder-setup/watch-terminate-telemetry`

Where telemetry is on, when `folders watch` receives `SIGTERM`, the CLI MUST end with exit status 0.

**Reason:** The thread that sends telemetry starts before the watch and may be the one that takes `SIGTERM`. The watch stops from whichever thread that is, and a signal lost there would leave the watch running until the service manager sends `SIGKILL`, which it reads as a failure.

**Tests:** `device/folders-autostart.test.ts › ends on SIGTERM with exit status 0 while it sends telemetry, too`.

### `folder-setup/watch-utility-priority`

While a folder watch runs on an Apple platform, a device MUST run the thread that calls the watch, the threads that keep a folder in step, which scan, send, pull and follow the server’s changes, and each thread those threads start at utility quality of service.

**Reason:** A watch is work the person did not ask for at that moment. Utility, not background, because a background thread can be deferred for far longer than the few seconds an edit may wait to reach the server, as in Low Power Mode. A thread started from a thread at utility is at the default class unless it is set. The core puts a calling thread back to the class it had once the watch ends, since the caller goes on to other work; no device command or binding calls the watch on a thread that goes on, so the core's own tests hold that.

**Tests:** `device/folders-autostart.test.ts › runs the threads of a folder watch, and the threads they start, at utility quality of service`.

### `folder-setup/watch-log`

Where `folders watch` is given `--log` with a file, the CLI MUST write the watch’s standard output and standard error to that file in place of its own.

**Tests:** `device/folders-autostart.test.ts › moves a log of 1 MiB or more aside as the watch starts, and writes to a fresh one`, `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folder-setup/watch-log-private`

Where `folders watch` is given `--log` with a file it makes, the CLI MUST make that file readable and writable by its owner alone.

**Reason:** The log names folders’ directories.

**Tests:** `device/folders-autostart.test.ts › moves a log of 1 MiB or more aside as the watch starts, and writes to a fresh one`.

### `folder-setup/watch-log-start-full`

When `folders watch` starts with `--log` naming a file that holds 1 MiB or more, the CLI MUST move that file to the same name with `.1` added, replacing any file there, before it writes.

**Tests:** `device/folders-autostart.test.ts › moves a log of 1 MiB or more aside as the watch starts, and writes to a fresh one`.

### `folder-setup/watch-log-running-full`

While `folders watch` runs with `--log`, when its file reaches 1 MiB, the CLI MUST move that file to the same name with `.1` added within 30 seconds and go on writing to a new file of the first name.

**Tests:** `device/folders-autostart.test.ts › moves the log aside once it reaches 1 MiB while the watch runs`.

### `folder-setup/watch-launchd-log-start-full`

When `folders watch` starts with `--log` naming a file, and a file named `folder-watch.launchd.log` in the same directory holds 1 MiB or more, the CLI MUST move that file to the same name with `.1` added, replacing any file there, and leave an empty file at the name, readable and writable by its owner alone, before it opens the log.

**Reason:** A watch that cannot open its log is started again by the service manager, and each start adds its error to the file launchd gives the watch's output (`folder-setup/autostart-launchd-output`). launchd makes a file it finds missing readable by others (`folder-setup/autostart-launchd-output-private`), and the output names folders' directories. The start that moves the file aside already holds the file it opened, so what that start printed before the watch attached lands in the `.1` file, not the new one.

**Tests:** `device/folders-autostart.test.ts › moves the file launchd gave the watch aside as the watch starts when it holds 1 MiB or more`.

### `folder-setup/watch-log-stopped`

When `folders watch` with `--log` naming a file is stopped by an interrupt or by `SIGTERM`, the CLI MUST write as the last line of that file a line that names the signal and the time the watch stopped, in UTC in ISO 8601 form to the second.

**Reason:** A watch stopped by `SIGTERM` exits with status 0 (`folder-setup/watch-terminate`), so the service manager does not start it again and nothing else shows that it ended. The person finds out only when edits stop reaching the server.

**Tests:** `device/folders-autostart.test.ts › writes the signal, its sender and the time as the last line of its log`.

### `folder-setup/watch-log-stopped-sender`

Where the platform reports the process that sent the signal that stopped `folders watch` with `--log`, the CLI MUST name that process’s id in the line `folder-setup/watch-log-stopped` writes.

**Reason:** A signal sent by another process, such as a service manager or a script, is told from one the person sent. Where the platform reports none, the line names no process, since a guess would send the person to the wrong one.

**Tests:** `device/folders-autostart.test.ts › writes the signal, its sender and the time as the last line of its log`.

### `folder-setup/watch-log-stopped-in-pass`

While a sync pass waits on the server, when `SIGTERM` stops `folders watch` with `--log`, the CLI MUST write the line `folder-setup/watch-log-stopped` describes before it ends.

**Reason:** A request to the server that has not answered holds the pass, and a watch that ends while it waits would end before it wrote the line. The time it has to end in is `folder-setup/watch-terminate`'s.

**Tests:** `device/folders-autostart.test.ts › writes the stop line, and ends within three seconds with exit status 0, when SIGTERM comes during a pass that waits on the server`.

### `folder-setup/watch-log-stopped-moved`

When a signal stops `folders watch` after it moved the log aside while it ran (`folder-setup/watch-log-running-full`), the CLI MUST write the line `folder-setup/watch-log-stopped` describes to the file at the log’s name.

**Tests:** `device/folders-autostart.test.ts › writes the stop line to the fresh log after the file reached 1 MiB while the watch ran`.
