# Folders

A folder is a directory bound to a `system.folder` item, with a working copy and a queue. The device and queue rules also apply (`device.md`, `queue-and-verdicts.md`).

`device.md` lists the answers the scripted server gives that the real server cannot be made to give, and why; `device/fidelity.test.ts` checks every answer the real server can produce against the scripted server's.

## Binding and settings

### `folders/bind-folder`

When a directory is added as a folder, a device MUST bind it to the named `system.folder` using the settings read from that item.

**Tests:** `device/folders.test.ts › reads its settings from the system.folder it is bound to`.

### `folders/bind-live-folder`

If the named item is not a live `system.folder`, then the CLI MUST refuse `folders add`.

**Tests:** `device/folders.test.ts › refuses to follow an item that is not a live folder`.

### `folders/settings-file`

When a directory is added as a folder, a device MUST write its settings as a YAML map in `.marfa/folder.yaml`, with `folder` naming the item and `version` naming the version read.

**Tests:** `device/folders.test.ts › writes its settings out as one file in .marfa/`.

### `folders/settings-read-per-pass`

When another device changes the bound `system.folder`, a device MUST follow the changed settings at the next folder pass that receives them.

**Tests:** `device/folders.test.ts › takes settings changed on another device`.

### `folders/settings-refresh-file`

When a pull receives changed settings and the settings file has no unsent edit, a device MUST rewrite `.marfa/folder.yaml` with those settings and their version.

**Tests:** `device/folders.test.ts › rewrites its settings file when the settings change elsewhere`.

### `folders/settings-preserve-edit`

While `.marfa/folder.yaml` has an unsent edit, a device MUST NOT overwrite that edit with settings received from another device.

**Tests:** `device/folders.test.ts › does not write its settings file over the person's edit, and sends the edit`.

### `folders/settings-send`

When a push or watch reads an edit of `.marfa/folder.yaml`, a device MUST send the changed settings through `PATCH /folders/{id}`.

**Tests:** `device/folders.test.ts › sends an edit to its settings file through the folder door`.

### `folders/settings-version`

When a device sends an edit of `.marfa/folder.yaml`, a device MUST base the edit on the positive integral version its `version` line names, including quoted and decimal spellings of an integer.

**Tests:** `device/folders.test.ts › bases an edit of its settings file on the version written in it`.

### `folders/settings-version-fallback`

If an edited settings file has no valid positive integral `version` line, then a device MUST base the edit on the version last written to that file.

**Tests:** `device/folders-contract-a.test.ts › uses the last written settings version when the file names no valid version`.

### `folders/settings-current-delta`

When a settings file names the version last written to it, a device MUST send only settings that differ from that last write.

**Tests:** `device/folders.test.ts › sends an edit to its settings file through the folder door`.

### `folders/settings-stale-whole`

When an edited settings file names another version and differs from the settings in force, a device MUST send every setting the file names.

**Tests:** `device/folders.test.ts › bases an edit of its settings file on the version written in it`, `device/folders.test.ts › rewrites a settings file whose edit changes no setting`.

### `folders/settings-use-answer`

When the server accepts an edit of the settings file, a device MUST use the resulting settings for subsequent work in the same push.

**Tests:** `device/folders.test.ts › sends an edit to its settings file through the folder door`.

### `folders/settings-invalid-hold`

If an edited settings file cannot be parsed, names another folder, or asks for unsupported settings, then a device MUST retain the settings in force.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folders/settings-name-refusal`

If saved folder settings contain a refused default tag, a refused default property name or a filter comparison with `null`, then a device MUST refuse to read those settings.

**Tests:** `device/folder-names.test.ts › stops where it is told, naming the setting, and runs with a default it takes`, `device/folder-names.test.ts › says which setting, what is wrong with it and how to change it`.

### `folders/settings-name-guidance`

If saved folder settings contain a refused default tag, a refused default property name or a filter comparison with `null`, then a device MUST name the setting, explain the refusal and identify `marfa folders change` as the command that changes it.

**Tests:** `device/folder-names.test.ts › says which setting, what is wrong with it and how to change it`, `device/folders-contract-c.test.ts › names each refused default and explains how to change it`.

### `folders/settings-refused-bytes`

When a settings edit is refused, a device MUST preserve the edited file.

**Tests:** `device/folders-contract-a.test.ts › holds a settings edit refused with status %s without resending its text`.

### `folders/settings-refusal-report`

When a settings edit is refused, a device MUST report the reason in `settings.flagged`.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`, `device/folders-contract-a.test.ts › holds a settings edit refused with status %s without resending its text`.

### `folders/settings-refusal-words`

When a push or pull reports a refused settings edit, the CLI MUST say that the edited settings are not in force.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folders/settings-refusal-no-repeat`

When the folder operation refuses a settings edit with `400`, `403`, `404`, `409`, or `422`, a device MUST NOT resend the same text.

**Tests:** `device/folders-contract-a.test.ts › holds a settings edit refused with status %s without resending its text`.

### `folders/settings-transient-retry`

When a settings edit receives a failing-server, rate-limit, or spent-credential answer, a device MUST retry the unchanged edit at the next push.

**Tests:** `device/folders-contract-a.test.ts › retries a settings edit after status %s`, `device/folders.test.ts › sends a settings edit the folder door could not take for now at the next push`.

### `folders/settings-transient-report`

When a settings edit cannot be sent because of a failing-server, rate-limit, or spent-credential answer, a device MUST flag it as not sent yet.

**Tests:** `device/folders-contract-a.test.ts › retries a settings edit after status %s`.

### `folders/settings-conflict-advice`

When the folder operation refuses a settings edit for a conflict, a device MUST advise deleting the file to recover the settings in force before editing again.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folders/settings-restore-file`

When the settings file is deleted, a device MUST recreate it from the settings in force at the next push.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folders/settings-equivalent-no-send`

When an edited settings file names exactly the settings in force, a device MUST NOT send a settings change for differences in presentation or version alone.

**Tests:** `device/folders.test.ts › rewrites a settings file whose edit changes no setting`.

### `folders/settings-equivalent-rewrite`

When an edited settings file names exactly the settings in force, a device MUST rewrite the file from those settings.

**Tests:** `device/folders.test.ts › rewrites a settings file whose edit changes no setting`.

### `folders/settings-current-omission`

When a current settings file omits a setting that the last write named, a device MUST refuse that edit.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folders/settings-rehydrate`

When changed folder settings require another type or tier slice, a device MUST hydrate that slice at the next push.

**Tests:** `device/folders.test.ts › hydrates again where its changed settings ask for another slice`.

### `folders/settings-read-permission`

If the key cannot read `system.folder`, then the CLI MUST refuse `folders add` naming `system.folder:read`.

**Tests:** `device/folders.test.ts › refuses to follow settings its key cannot read, naming the permission`.

### `folders/settings-readd-replaces`

When the same folder is added again to its directory, a device MUST replace the settings file with the settings in force, including over an unsent edit.

**Tests:** `device/folders-contract-a.test.ts › replaces an unsent settings edit when the same folder is added again`.

### `folders/settings-watch-refusal`

When a settings edit is refused during a watch, the CLI MUST say why the edited settings are not in force.

**Tests:** `device/folders-contract-a.test.ts › tells a watch why a settings edit is not in force`.

### `folders/settings-omission-advice`

When a current settings file omits a setting, a device MUST advise writing an empty list or map instead of removing the setting.

**Tests:** `device/folders-contract-a.test.ts › advises empty values when an edit removes a current setting`.

### `folders/settings-watch-slice-delay`

When the settings change to require another slice during a running watch, a device MUST defer hydration of that slice until the next push or watch restart.

**Tests:** `device/folders-contract-a.test.ts › hydrates a changed watch slice at the next push rather than during the watch`.

## Local refusals and first sync

### `folders/invalid-document-contained`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST retain the file’s bytes.

**Tests:** `device/folders-frontmatter.test.ts › refuses an empty null property name before deciding a save is unchanged`, `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`.

### `folders/invalid-document-flagged`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST flag the local refusal.

**Tests:** `device/folders-frontmatter.test.ts › refuses an empty null property name before deciding a save is unchanged`, `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`.

### `folders/invalid-document-scan-continues`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST continue scanning other files.

**Tests:** `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`.

### `folders/invalid-document-retried`

When a refused folder document is corrected or its type becomes available in the held catalog, a device MUST retry admission at a later scan.

**Tests:** `device/folders-frontmatter.test.ts › refuses an empty null property name before deciding a save is unchanged`, `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`.

### `folders/first-sync-waits`

When a folder is added without confirmation and has files to write or send, a device MUST hold its first sync for confirmation.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`.

### `folders/first-sync-no-effects`

While a folder’s first sync waits for confirmation, a device MUST NOT write item files into the directory.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`.

### `folders/first-sync-no-effects-writes-unsent`

While a folder’s first sync waits for confirmation, a device MUST NOT send queued writes to the server.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`.

### `folders/first-sync-plan`

When a waiting folder’s first-sync plan is read, a device MUST report the counts `write`, `send` and `beside` from the current copy and directory.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`, `device/folders.test.ts › writes beside a file already where an item's file would go, and says so`.

### `folders/first-sync-plan-writes-unsent`

When a waiting folder’s first-sync plan is read, a device MUST NOT send queued writes to the server.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`, `device/folders.test.ts › writes beside a file already where an item's file would go, and says so`.

### `folders/first-sync-offline-plan`

When a waiting folder’s server is unreachable and the folder already holds a usable copy, a device MUST report its first-sync plan from that copy.

**Tests:** `device/folders.test.ts › reads the copy it already holds when the server is out of reach`.

### `folders/first-sync-status`

While a folder’s first sync waits, a device MUST include its waiting state and last read plan in folder status.

**Tests:** `device/folders.test.ts › says what it will do when the folder is added, and sends and writes nothing`.

### `folders/first-sync-watch-refused`

While a folder’s first sync waits, the CLI MUST refuse to start a watch with `first_sync_waiting`.

**Tests:** `device/folders.test.ts › refuses a watch while it waits, and a script confirms it with --yes`.

### `folders/first-sync-drain-refused`

While a folder’s first sync waits, a device MUST refuse a drain through the folder’s device door with `first_sync_waiting`.

**Tests:** `device/folders.test.ts › refuses a drain by the folder's device door while it waits`.

### `folders/first-sync-pull-refused`

While a folder’s first sync waits, a device MUST refuse a pull with `first_sync_waiting`.

**Tests:** `device/folders-contract-b.test.ts › refuses a pull during first sync and uses the directory as it stands after confirmation`.

### `folders/first-sync-current-directory`

When a folder’s first sync is confirmed, a device MUST process the directory as it stands rather than execute an earlier plan’s file list.

**Tests:** `device/folders-contract-b.test.ts › refuses a pull during first sync and uses the directory as it stands after confirmation`.

### `folders/first-sync-settings-refused`

While a folder’s first sync waits, a device MUST refuse submission of its settings-file edit with `first_sync_waiting`.

**Tests:** waiting on #1890.

### `folders/first-sync-restore-refused`

While a folder’s first sync waits, a device MUST refuse restoration of removals with `first_sync_waiting`.

**Tests:** `device/folders-contract-b.test.ts › refuses restore while first sync waits and confirms without a server request`.

### `folders/first-sync-unmatched-refused`

While a folder's first sync waits, a device MUST refuse removal of unmatched files with `first_sync_waiting`.

**Tests:** `device/folders-unmatched.test.ts › takes files away from a folder a watch holds, and is refused while the first sync waits`.

### `folders/first-sync-terminal-question`

When `folders add` has a nonempty first-sync plan at a terminal without `--yes` or `--json`, the CLI MUST ask for confirmation.

**Tests:** `device/folders-contract-b.test.ts › asks before first sync at a terminal and obeys %s`.

### `folders/first-sync-terminal-answer`

When `folders add` has a nonempty first-sync plan at a terminal without `--yes` or `--json`, the CLI MUST proceed only for `y` or `yes` without regard to case.

**Tests:** `device/folders-contract-b.test.ts › asks before first sync at a terminal and obeys %s`.

### `folders/first-sync-interrupted-confirmed`

When a confirmed folder’s sync is interrupted by a failed file landing, a device MUST keep first sync confirmed for the next attempt and for a later add over the same state.

**Tests:** `device/folders-contract-b.test.ts › keeps first sync confirmed after a failed landing and after adding the folder again`.

### `folders/first-sync-yes`

When `folders add` is given `--yes`, the CLI MUST confirm the folder’s first sync without asking for input.

**Tests:** `device/folders.test.ts › refuses a watch while it waits, and a script confirms it with --yes`.

### `folders/first-sync-confirm`

When `folders confirm` is given a waiting folder, the CLI MUST clear the first-sync wait.

**Tests:** `device/folders.test.ts › goes once it is confirmed, and does not ask again`, `device/folders-contract-b.test.ts › refuses restore while first sync waits and confirms without a server request`.

### `folders/first-sync-confirm-local-only`

When `folders confirm` is given a waiting folder, the CLI MUST NOT contact the server.

**Tests:** `device/folders.test.ts › goes once it is confirmed, and does not ask again`, `device/folders-contract-b.test.ts › refuses restore while first sync waits and confirms without a server request`.

### `folders/first-sync-confirmation-kept`

When a confirmed folder syncs again or is added again over its own state, a device MUST keep the first sync confirmed.

**Tests:** `device/folders.test.ts › goes once it is confirmed, and does not ask again`.

### `folders/first-sync-empty-confirmed`

When a waiting folder’s plan has no files to write, send or place beside another file, a device MUST confirm the first sync automatically.

**Tests:** `device/folders.test.ts › confirms itself where there is nothing to write, send or keep`.

### `folders/first-sync-remove`

When a waiting folder is removed, a device MUST remove its state despite unsent queued writes.

**Tests:** `device/folders.test.ts › is canceled by removing the folder, which leaves its files`.

### `folders/first-sync-remove-files-preserved`

When a waiting folder is removed, a device MUST leave its item files intact.

**Tests:** `device/folders.test.ts › is canceled by removing the folder, which leaves its files`.

### `folders/first-sync-per-machine`

When machines follow the same `system.folder`, a device MUST keep each machine’s first-sync confirmation independently in that folder’s local state.

**Tests:** `device/folders.test.ts › asks of each machine's folder for itself`.

## Search and defaults

### `folders/search-match`

When a folder evaluates membership, a device MUST apply its search types and their descendants, tier, state, and filters on tags, properties, and edges.

**Tests:** `device/folders.test.ts › holds exactly what its search matches`.

### `folders/search-beneath`

When a folder search names `beneath`, a device MUST include the named item and its readable descendants reached through `parent-of`.

**Tests:** `device/folders-contract-a.test.ts › materializes only readable copy rows reached by a beneath search`, `device/folders.test.ts › holds exactly what its search matches`.

### `folders/search-default-types`

When a folder search names no types, a device MUST admit every readable type except `system.*`.

**Tests:** `device/folders.test.ts › takes every type, and any default type, where its search names no type`.

### `folders/search-default-tier`

When a folder search names no tier, a device MUST use the `library` tier.

**Tests:** `device/folders.test.ts › holds exactly what its search matches`.

### `folders/search-default-states`

When a folder search names no states, a device MUST include active and archived items.

**Tests:** `device/folders.test.ts › holds archived items unless its search narrows state`.

### `folders/search-refuse-unsupported`

If folder settings name an unknown setting, search member, defaults member, or removal-threshold member, a `backref` condition, an empty state list, or a state other than active or archived, then a device MUST refuse to follow them.

**Tests:** `device/folders.test.ts › refuses a search condition it does not implement`.

### `folders/search-edit-refused`

When a settings-file edit names a search the device cannot answer, a device MUST NOT send that edit.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`.

### `folders/default-document-type`

When a new document has no `type` line, a device MUST choose its type from the defaults, then the search's first non-file type, then `core.note`.

**Tests:** `device/folders.test.ts › makes a new document the search's first type that is not a file type`, `device/folders.test.ts › takes every type, and any default type, where its search names no type`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folders/default-document-tier`

When a new document has no `tier` line, a device MUST use the defaults' tier or, if absent, the search's tier.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folders/default-properties`

When a new document omits a property named by the defaults, a device MUST fill that property from the defaults except for the body property.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folders/default-tags`

When a new document omits its `tags` line, a device MUST use the default tags.

**Tests:** `device/folders-frontmatter.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folders/default-explicit-tags`

When a new document names tags explicitly, including an empty list, a device MUST use those tags instead of default tags.

**Tests:** `device/folders-frontmatter.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folders/default-body`

When a new document is created, a device MUST use its body for the type's body property instead of a default body.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folders/default-title`

When a new document omits its title property, a device MUST prefer a default title over the filename.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folders/default-explicit-title`

When a new document names its title property, a device MUST use that value instead of a default title.

**Tests:** `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folders/default-edges`

When a new document or file item has no line for an edge type named by the defaults, a device MUST create the default edge from the new item to the named item, except `parent-of`, which runs from the named item to the new item.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folders/default-edit-unchanged`

When a bound file is edited, a device MUST NOT fill its omitted values from the folder defaults.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folders/default-search-refusal`

If the defaults name a type or tier the folder search excludes, then a device MUST refuse to follow those defaults.

**Tests:** `device/folders.test.ts › refuses defaults its search would not hold`.

### `folders/independent-folders`

When files in different folders are scanned, a device MUST keep each folder's queued writes separate.

**Tests:** `device/folders.test.ts › keeps each folder's state and queue to itself`.

### `folders/registry-lists-folders`

When the CLI lists the machine's folders, a device MUST include every registered folder's directory and `system.folder` ID.

**Tests:** `device/folders-one-mac.test.ts › lists the folders on the Mac in one registry`.

### `folders/empty-directory`

When a folder is added to an empty directory, a device MUST materialize the held items during pull.

**Tests:** `device/folders.test.ts › hydrates into an empty directory and pushes without holding anything else`.

### `folders/empty-directory-push`

When a file is edited in a newly added folder directory, a device MUST send that edit during push.

**Tests:** `device/folders.test.ts › hydrates into an empty directory and pushes without holding anything else`.

### `folders/item-to-file`

When a pull meets an item held by the folder search and eligible for writing, a device MUST write the item as a file.

**Tests:** `device/folders.test.ts › makes a file an item and an item a file`.

### `folders/file-to-item`

When a push meets an admissible new file, a device MUST create its item on the server.

**Tests:** `device/folders.test.ts › makes a file an item and an item a file`.

### `folders/default-file-properties`

When a new file item is created from file bytes, a device MUST omit the folder defaults' document properties.

**Tests:** `device/folders-contract-a.test.ts › applies default properties to documents but not file items`.

### `folders/default-file-tags`

When a new file item is created from file bytes, a device MUST apply the folder's default tags.

**Tests:** `device/folders-contract-a.test.ts › applies default properties to documents but not file items`.

### `folders/default-file-tier`

When a device creates a new file item, a device MUST use the folder defaults' tier or, if absent, the search's tier.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folders/registry-store-identity`

When a folder is registered, a device MUST record its store identity beside its directory and folder ID in the machine registry.

**Tests:** `device/folders-contract-a.test.ts › records each folder's distinct store identity in the shared registry`.

## What a folder admits, and file names

### `folders/include-empty`

When a folder’s include list is empty, a device MUST admit every path not excluded by dot-name rules, built-in lists or its ignore list.

**Tests:** `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`.

### `folders/include-negation`

When the last applicable include pattern for a folder path is negated, a device MUST exclude that path from admission.

**Tests:** `device/folders-contract-b.test.ts › applies include negation, ignore precedence and case-normalized patterns`.

### `folders/list-pattern-order`

When several patterns in one include or ignore list match the same path, a device MUST use the last matching pattern's inclusion or exclusion, including matches through equivalent Unicode names.

**Tests:** `device/folder-patterns.test.ts › resolves %s negations in line order across original and equivalent names`.

### `folders/list-path-before-parent`

When an include or ignore pattern matches a file's path directly, a device MUST use that match before considering a pattern matching an ancestor directory.

**Tests:** `device/folder-patterns.test.ts › resolves an equivalent file pattern before a matching parent pattern`.

### `folders/pattern-not-folder-root`

A device MUST NOT take or leave out a file at a folder's top level because an include or ignore pattern matches the folder's own directory.

**Reason:** git reads a list the same way, so a line that names only directories, such as `*/`, neither takes nor leaves out a top-level file. A bound file that such a line stops taking is kept, as `folders/excluded-binding-kept` says.

**Tests:** `device/folders.test.ts › keeps a bound file at the top that a line naming only directories does not take`.

### `folders/pattern-one-character`

When an include or ignore pattern holds a `?` or a bracket class, a device MUST match each against exactly one character of the path, whatever the character's length in bytes.

**Tests:** `device/folder-patterns.test.ts › matches a class or a ? against one character outside ASCII in %s patterns`.

### `folders/invalid-pattern-refused`

When a folder’s include or ignore list contains an invalid gitignore pattern, a device MUST refuse admission using those settings.

**Tests:** `device/folders-contract-b.test.ts › refuses an invalid %s pattern before admission`.

### `folders/include-paths`

When a folder has a nonempty include list, a device MUST admit only paths whose name or an ancestor directory matches an included gitignore pattern relative to the folder root.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folder-patterns.test.ts › keeps the members of the %s range in include patterns`, `device/folder-patterns.test.ts › preserves wildcard matches alongside Unicode equivalence in %s patterns`.

### `folders/ignore-paths`

When a folder path matches its ignore list, a device MUST exclude that path from admission even when the include list also matches it.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`, `device/folders-contract-b.test.ts › applies include negation, ignore precedence and case-normalized patterns`, `device/folder-patterns.test.ts › keeps the members of the %s range in ignore patterns`, `device/folder-patterns.test.ts › preserves wildcard matches alongside Unicode equivalence in %s patterns`.

### `folders/include-dot-directories`

When a folder path has a dot-led directory component, a device MUST admit it only where a non-negated include pattern explicitly names every dot-led directory on its path.

**Tests:** `device/folders.test.ts › reaches a dot-led path its include list names`, `device/folders.test.ts › excludes a dot-led directory at any depth`, `device/folders.test.ts › writes nothing under a dot-led directory its walk does not enter`, `device/folders.test.ts › takes nothing under a dot-led directory a negated include line names`, `device/folder-patterns.test.ts › keeps the members of the %s range when entering dot directories`.

### `folders/builtin-machine-names`

A device MUST exclude `.DS_Store`, `Thumbs.db`, `._*`, `.Spotlight-V100`, `.Trashes`, `Icon` followed by a carriage return and `desktop.ini` from folder admission regardless of the configured lists.

**Tests:** `device/folders-contract-b.test.ts › keeps every built-in machine, temporary and secret name outside admission`.

### `folders/builtin-temporary-names`

A device MUST exclude `*.swp`, `*~`, `.#*`, `#*#`, `~$*`, `*.tmp`, `.~lock.*#`, `*___jb_tmp___`, `*___jb_old___`, `*.crdownload`, `*.crswap`, `*.part` and `*.download` from folder admission regardless of the configured lists.

**Tests:** `device/folders.test.ts › never takes an editor's or a download's temporary file`, `device/folders-contract-b.test.ts › keeps every built-in machine, temporary and secret name outside admission`.

### `folders/builtin-secret-names`

A device MUST exclude `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`, `credentials`, `*credentials.json` and `credentials.db` from folder admission regardless of the configured lists.

**Tests:** `device/folders.test.ts › never takes a secret whatever its lists say`, `device/folders-contract-b.test.ts › keeps every built-in machine, temporary and secret name outside admission`.

### `folders/secrets-reported`

When a folder scan encounters a file excluded by a built-in secret pattern in a directory it walks, a device MUST name the file in the scan report’s `secrets`.

**Tests:** `device/folders.test.ts › never takes a secret whatever its lists say`.

### `folders/secrets-said`

When a folder push or watch encounters a file excluded by a built-in secret pattern, the CLI MUST name the excluded file in words.

**Tests:** `device/folders.test.ts › never takes a secret whatever its lists say`, `device/folders.test.ts › says a refused secret in words once while watching`.

### `folders/secret-notice-once`

While a folder file remains excluded by a built-in secret pattern, the CLI MUST say its watch notice only once.

**Tests:** `device/folders.test.ts › says a refused secret in words once while watching`, `device/folders.test.ts › says a refused secret once while a delete waits out its grace and other passes report`.

### `folders/pull-outside-lists`

When a folder pull would write a path excluded by the folder’s lists, a device MUST report the item as `outside`.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folders.test.ts › writes nothing under a dot-led directory its walk does not enter`.

### `folders/pull-outside-lists-file-unwritten`

When a folder pull would write a path excluded by the folder’s lists, a device MUST NOT write the item’s file.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folders.test.ts › writes nothing under a dot-led directory its walk does not enter`.

### `folders/excluded-binding-kept`

When a folder’s lists stop admitting a bound file, a device MUST retain its binding.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folders/excluded-no-deletion`

When a folder’s lists stop admitting a bound file, a device MUST NOT journal its deletion.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folders/excluded-binding-kept-edits-unsent`

When a folder’s lists stop admitting a bound file, a device MUST NOT send its edits.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folders/excluded-scan-count`

When a folder’s lists stop admitting a bound file, a device MUST count the file as `unreached` in the scan report.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folders/excluded-pull-preserved`

When a folder’s lists stop admitting a bound file, a device MUST leave its bytes untouched during a pull.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folders/included-again`

When a folder’s lists admit a previously excluded bound file again, a device MUST send its intervening edit to the same item.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folders/package-scan`

When a folder scan encounters a directory ending in `.app`, `.bundle`, `.pages`, `.numbers`, `.key`, `.photoslibrary`, `.xcodeproj` or `.rtfd` without regard to case, a device MUST report the directory as `package`.

**Tests:** `device/folders.test.ts › does not walk into a package`, `device/folders-contract-b.test.ts › reports every built-in package extension without scanning its contents`.

### `folders/package-scan-contents-excluded`

When a folder scan encounters a directory ending in `.app`, `.bundle`, `.pages`, `.numbers`, `.key`, `.photoslibrary`, `.xcodeproj` or `.rtfd` without regard to case, a device MUST NOT admit the directory’s contents.

**Tests:** `device/folders.test.ts › does not walk into a package`, `device/folders-contract-b.test.ts › reports every built-in package extension without scanning its contents`.

### `folders/macos-package-scan`

Where a device runs on macOS, when the operating system identifies a directory as a package by its type or Finder bundle bit, a device MUST report the directory as `package`.

**Tests:** `device/folders.test.ts › excludes a directory only while its Finder bundle bit is set`.

### `folders/macos-package-scan-contents-excluded`

Where a device runs on macOS, when the operating system identifies a directory as a package by its type or Finder bundle bit, a device MUST NOT admit the directory’s contents.

**Tests:** `device/folders.test.ts › excludes a directory only while its Finder bundle bit is set`.

### `folders/package-pull`

When a folder placement falls inside a package, a device MUST count the item as `outside`.

**Tests:** `device/folders.test.ts › does not walk into a package`.

### `folders/package-pull-file-unwritten`

When a folder placement falls inside a package, a device MUST NOT write its file.

**Tests:** `device/folders.test.ts › does not walk into a package`.

### `folders/unreadable-directory`

When a folder scan cannot read a directory or an entry’s details, a device MUST report that directory as `unreadable`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders-identity.test.ts › holds the files of a directory whose entries cannot be read`.

### `folders/unreadable-directory-scan-continues`

When a folder scan cannot read a directory or an entry’s details, a device MUST continue scanning other directories.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders-identity.test.ts › holds the files of a directory whose entries cannot be read`.

### `folders/unreadable-bindings`

When a folder scan cannot reach a bound file inside an unreadable directory, a device MUST count it as `unreached`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders-identity.test.ts › holds the files of a directory whose entries cannot be read`.

### `folders/unreadable-no-deletion`

When a folder scan cannot reach a bound file inside an unreadable directory, a device MUST NOT journal its deletion.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders-identity.test.ts › holds the files of a directory whose entries cannot be read`.

### `folders/unreadable-pull`

When a folder pull cannot write a bound file inside an unreadable directory, a device MUST retain its binding.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`.

### `folders/unreadable-pull-unwritten-count`

When a folder pull cannot write a bound file inside an unreadable directory, a device MUST count the item as `unwritten`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`.

### `folders/title-separators`

When a device makes a file name from an item's title, a device MUST replace `/`, `\` and `:` with `-`.

**Tests:** `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folders/title-controls`

When a device makes a file name from an item's title, a device MUST replace each control character with a space.

**Tests:** `device/folders-placement.test.ts › names a new item's file from its title, cut to the longest name a file system takes`, `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folders/title-trimming`

When a device makes a file name from a nonblank item title, a device MUST trim surrounding whitespace and leading dots, using `untitled` when that leaves an empty name.

**Tests:** `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folders/name-byte-limit`

When a generated file name would exceed 255 bytes of UTF-8, a device MUST shorten its stem at a character boundary to fit within 255 bytes, retaining any numbering suffix and an extension of at most 32 bytes including its dot.

**Tests:** `device/folders-placement.test.ts › names a new item's file from its title, cut to the longest name a file system takes`, `device/folders-contract-c.test.ts › keeps a 32-byte extension whole and treats a longer ending as stem when fitting UTF-8 names`.

### `folders/name-long-ending`

When a generated file name has more than 32 bytes from its last dot to its end, a device MUST treat that ending as part of the stem when shortening the name.

**Tests:** `device/folders-contract-c.test.ts › keeps a 32-byte extension whole and treats a longer ending as stem when fitting UTF-8 names`.

### `folders/name-comparison`

When a device compares folder paths, file names or titles, a device MUST treat names differing only in case or Unicode normalization as the same name.

**Tests:** `device/folders.test.ts › treats names differing only in case or Unicode form as one`, `device/folders-contract-b.test.ts › matches include names in NFC regardless of case and asks server names in both forms`, `device/folders-contract-b.test.ts › matches Unicode %s patterns with the folder name equivalence`, `device/folder-patterns.test.ts › matches escaped brackets and Unicode literals without turning them into classes`, `device/folder-patterns.test.ts › folds Unicode literals with an escape on the $position`.

### `folders/same-name-scan-choice`

When distinct folder files have paths equal without regard to case or Unicode normalization, a device MUST admit the already-bound path or otherwise the first path in order.

**Tests:** `device/folders-contract-b.test.ts › chooses a bound path before path order when names compare equal`.

### `folders/same-name-scan-choice-other-paths-held`

When distinct folder files have paths equal without regard to case or Unicode normalization, a device MUST hold the other paths with flag `name` until renamed.

**Tests:** `device/folders-contract-b.test.ts › chooses a bound path before path order when names compare equal`.

### `folders/same-name-beside`

When two folder items are placed at names equal without regard to case or Unicode normalization, a device MUST place the later item beside the earlier one under a numbered name.

**Tests:** `device/folders.test.ts › treats names differing only in case or Unicode form as one`.

### `folders/case-rename-unsent`

When a folder file is renamed only in case or Unicode normalization, a device MUST NOT queue a placement change for that rename.

**Tests:** `device/folders-contract-b.test.ts › does not send a placement for an equivalent rename to %s`.

### `folders/lookup-both-normalizations`

When a folder asks the server to resolve a title whose NFC and NFD forms differ, a device MUST look up both forms.

**Tests:** `device/folders-contract-b.test.ts › matches include names in NFC regardless of case and asks server names in both forms`.

### `folders/state-not-admitted`

A device MUST exclude every file under a folder’s `.marfa/` state directory from item admission regardless of the include list.

**Tests:** `device/folders.test.ts › keeps its own state in .marfa and never pushes it`.

### `folders/watched-settings`

When `.marfa/folder.yaml` changes during a folder watch, a device MUST submit the settings edit through the folder operation at its next pass.

**Tests:** `device/folders.test.ts › sends an edit to its settings file through the folder door`.

### `folders/binary-outside-search`

When an unbound non-document file has no type held by a folder’s search and no document embeds it, a device MUST leave the file unsent.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`, `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folders/binary-outside-search-skipped-count`

When an unbound non-document file has no type held by a folder’s search and no document embeds it, a device MUST count the file as `skipped`.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`, `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folders/embedded-outside-search`

When a document in a folder embeds a file outside the folder’s search, a device MUST admit that file as the document’s attachment.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`, `device/folders-frontmatter.test.ts › writes an embedded file where its link says`, `device/folders-frontmatter.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folders/document-outside-search`

When a folder document names an admissible type outside the folder’s search, a device MUST create its item under that type.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`.

### `folders/new-file-only-members`

When an item outside a folder’s search has no bound file and no document embeds it, a device MUST NOT write a new file for the item.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`.

### `folders/outside-document-unmatched`

When a folder document’s accepted type is outside the folder’s search, a device MUST count its bound file as `unmatched` at the next pull.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`.

## Document fields and presentation

### `folders/own-field-lines`

When a device reads a Markdown file, a device MUST interpret `type`, `tier`, `tags`, `state`, and `occurred_at` as the item's own fields rather than properties.

**Tests:** `device/folders-frontmatter.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-frontmatter.test.ts › sets a new item's own time, from a date or from a date and time`.

### `folders/property-lines`

When a Markdown frontmatter line names neither an own field, metadata line, nor an edge type or reverse name, a device MUST carry it as a property, including undeclared and nested values.

**Tests:** `device/folders.test.ts › carries frontmatter to properties and the body to the body`.

### `folders/body-property`

When a device reads or writes a document, a device MUST use the type's resolved `body_field` as the body property, falling back to `body`.

**Tests:** `device/folders-frontmatter.test.ts › takes body and title from the type's display hints`, `device/folders-frontmatter.test.ts › takes the display hints of the nearest type that declares any, whole, as the server resolves them`.

### `folders/title-property`

When a device derives a document title from its filename or a filename from its title, a device MUST use the type's resolved `title_field`, falling back to `title`.

**Tests:** `device/folders-frontmatter.test.ts › takes body and title from the type's display hints`, `device/folders-frontmatter.test.ts › takes the display hints of the nearest type that declares any, whole, as the server resolves them`.

### `folders/body-over-line`

When a document has a frontmatter line for its current body property, a device MUST use the body in preference to that line, except during a retype to a different body property.

**Tests:** `device/folders.test.ts › carries frontmatter to properties and the body to the body`.

### `folders/uncarried-report`

When a held type declares properties reserved for document own fields, metadata, or edge lines, a device MUST list those type/property pairs in the pull's `uncarried` report.

**Tests:** `device/folders-frontmatter.test.ts › reports a type that declares a property no file can carry, and keeps it`.

### `folders/uncarried-preserve`

When a document is edited, a device MUST preserve item properties that cannot be carried as document properties.

**Tests:** `device/folders-frontmatter.test.ts › reports a type that declares a property no file can carry, and keeps it`.

### `folders/write-own-fields`

When a device renders a new Markdown file, a device MUST write `type` and `tier`, tags when present, and `state: archived` when the item is archived.

**Tests:** `device/folders-frontmatter.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-frontmatter.test.ts › keeps an archived item's file with its state in the frontmatter`.

### `folders/own-field-order`

When a device renders a new Markdown file, a device MUST place own-field lines before the item properties, ordered `type`, `tier`, `tags`, `state`, and `occurred_at` for those present.

**Tests:** `device/folders-frontmatter.test.ts › keeps an archived item's file with its state in the frontmatter`, `device/folders-contract-a.test.ts › writes own fields in order before properties including an explicit time`.

### `folders/current-replaces-properties`

When a file names the copy's current item version, a device MUST send its properties as a replacement, clearing properties whose lines were removed.

**Tests:** `device/folders-frontmatter.test.ts › clears a property whose line was taken out of a versioned file`.

### `folders/current-after-own-write`

When a file's own edit lands before its version line is rewritten, a device MUST treat its next edit as current if the previously scanned content agrees with the item.

**Tests:** `device/folders-frontmatter.test.ts › sends a save right after its own edit lands as current`.

### `folders/current-after-unshown-change`

When the copy moves to a version that changes nothing shown by the file and no file edit waits, a device MUST treat the file's next own-field edit as current.

**Tests:** `device/folders-frontmatter.test.ts › takes an own-field change after a version step no file shows`.

### `folders/current-own-delta`

When a current file is saved, a device MUST send only own-field changes relative to the own-field lines it last wrote.

**Tests:** `device/folders-frontmatter.test.ts › takes an own-field change after a version step no file shows`, `device/folders-frontmatter.test.ts › sends nothing for a save that only reformats the frontmatter`.

### `folders/missing-tags-clears`

When a current file loses a `tags` line previously written by the device at that version, a device MUST remove those tags from the item.

**Tests:** `device/folders-frontmatter.test.ts › takes a versioned file's missing tags line as no tags, and a lineless file's as no change`.

### `folders/missing-state-active`

When a current file loses a `state: archived` line previously written by the device at that version, a device MUST restore the item to active.

**Tests:** `device/folders-frontmatter.test.ts › keeps an archived item's file with its state in the frontmatter`.

### `folders/unwritten-own-fields`

When a file omits own-field lines the device never wrote into it, a device MUST leave those own fields unchanged.

**Tests:** `device/folders-frontmatter.test.ts › reads a file the folder never wrote own lines into as leaving them as they are`, `device/folders-frontmatter.test.ts › takes a versioned file's missing tags line as no tags, and a lineless file's as no change`.

### `folders/behind-no-own-change`

When a file's version line is missing, ahead of the copy, or behind the copy for reasons other than its own accepted edit, a device MUST NOT send its own-field changes.

**Tests:** `device/folders-frontmatter.test.ts › sends no own-field change from an old buffer, and flags the lines it would have changed`, `device/folders-frontmatter.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folders/behind-flags-lines`

When a file behind the copy differs in own-field lines, a device MUST flag it `behind` naming the lines it did not send.

**Tests:** `device/folders-frontmatter.test.ts › sends no own-field change from an old buffer, and flags the lines it would have changed`, `device/folders-frontmatter.test.ts › sends no time from a file behind the item, and flags the line`.

### `folders/old-buffer-tags`

When an old buffer would reverse tags received from another device at the same item version, a device MUST NOT send that tag change.

**Tests:** `device/folders-frontmatter.test.ts › leaves a tag and an archive made elsewhere alone when an old buffer is saved`, `device/folders-frontmatter.test.ts › sends no tag change from an old buffer however many tag writes came at one version`.

### `folders/old-buffer-state`

When an old buffer would reverse an archive or restore received from another device, a device MUST NOT send that state change.

**Tests:** `device/folders-frontmatter.test.ts › leaves a tag and an archive made elsewhere alone when an old buffer is saved`, `device/folders-frontmatter.test.ts › does not re-archive from a buffer written before a restore elsewhere`, `device/folders-frontmatter.test.ts › does not re-archive from the buffer of an archive restored elsewhere`.

### `folders/own-tag-reversal`

When a person adds and then removes a tag through the same file at one item version, a device MUST send both changes.

**Tests:** `device/folders-frontmatter.test.ts › sends a tag the person adds and then takes out again at one version`.

### `folders/successive-saves`

When several property saves of one file are scanned before a drain, a device MUST preserve their order so the last save determines the resulting properties.

**Tests:** `device/folders-frontmatter.test.ts › keeps every save of three scanned before one drain`.

### `folders/presentation-no-write`

When a save changes only accepted presentation of a document's values, a device MUST NOT queue an item edit.

**Tests:** `device/folders-frontmatter.test.ts › sends nothing for a save that only reformats the frontmatter`, `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`.

### `folders/version-spelling`

When a document version line is a quoted integer or decimal spelling of a positive integer, a device MUST interpret it as that version.

**Tests:** `device/folders-frontmatter.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folders/time-normalization`

When a document names `occurred_at`, a device MUST interpret its date or date-and-time by the server's time rules, including UTC for a value without an offset.

**Tests:** `device/folders-frontmatter.test.ts › sets a new item's own time, from a date or from a date and time`, `cli/folder.test.ts › sets an item's own time from a file's occurred_at line, and writes it back as typed`.

### `folders/time-equivalent-no-write`

When a save only changes the spelling of an equivalent `occurred_at`, a device MUST NOT send an item edit for it.

**Tests:** `device/folders-frontmatter.test.ts › sends an edit of the line, and nothing for another spelling of the same time`, `device/folders-frontmatter.test.ts › follows a time changed elsewhere, and keeps a line in another spelling of the same time`.

### `folders/time-current-edit`

When a current file changes its `occurred_at` value, a device MUST send the changed item time outside `properties`.

**Tests:** `device/folders-frontmatter.test.ts › sends an edit of the line, and nothing for another spelling of the same time`.

### `folders/time-omitted-keeps`

When a file omits its `occurred_at` line, a device MUST leave the item's time unchanged.

**Tests:** `device/folders-frontmatter.test.ts › sends an edit of the line, and nothing for another spelling of the same time`.

### `folders/time-null-empty`

When a file has a null `occurred_at` line, a device MUST treat it as no requested time.

**Tests:** `device/folders-frontmatter.test.ts › takes a blank line as no time, and leaves it blank`.

### `folders/time-null-preserved`

When an item has no explicit time to render over a null `occurred_at` line, a device MUST preserve the blank line.

**Tests:** `device/folders-frontmatter.test.ts › takes a blank line as no time, and leaves it blank`.

### `folders/time-render`

When an item's time differs from its creation time or a file already carries a non-null `occurred_at` value, a device MUST render the item's time in that line.

**Tests:** `device/folders-frontmatter.test.ts › writes the line for an item whose time is its own, and none for one never set`, `device/folders-frontmatter.test.ts › follows a time changed elsewhere, and keeps a line in another spelling of the same time`.

### `folders/time-invalid`

If a non-null `occurred_at` value is not text or cannot be read as a valid time, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders-frontmatter.test.ts › flags a line that is no time, and sends nothing for the file`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folders/own-field-validation`

If frontmatter names an empty or non-text type, a tier other than feed or library, a non-null state other than active or archived, or a malformed tag value, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders-frontmatter.test.ts › reads own-field lines in each form a file can hold them`, `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`.

### `folders/tag-state-forms`

When a document uses comma-separated text or null for tags, or null for state, a device MUST interpret them respectively as the named tags, no tags, or active.

**Tests:** `device/folders-frontmatter.test.ts › reads own-field lines in each form a file can hold them`.

### `folders/preserve-source`

When a pull changes a document, a device MUST preserve unchanged frontmatter source, including order, comments, quoting, number spelling, collections, scalars, Unicode, and line endings.

**Tests:** `device/folders.test.ts › writes a person's frontmatter back in the order they wrote it`, `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`, `cli/folder.test.ts › keeps authored YAML bytes while first push adds metadata and a remote edit changes one value`.

### `folders/preserve-change-in-place`

When a pull changes document properties, a device MUST edit changed values in place, remove uncarried non-null values, and append missing fields.

**Tests:** `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`, `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/preserve-null-property`

When an existing document carries a null property line spelled as `key:`, `key: null`, or `key: ~`, and the item carries no value for that property, a device MUST preserve that line's bytes, including whitespace and comments.

**Tests:** `device/folders-frontmatter.test.ts › keeps empty property lines through pushes, pulls and later clears`.

### `folders/preserve-null-property-scope`

When a property has no line in an existing document and no value on the item, a device MUST NOT add a null line for it.

**Tests:** `device/folders-frontmatter.test.ts › keeps empty property lines through pushes, pulls and later clears`.

### `folders/preserve-children`

When a pull changes a mapping or sequence, a device MUST preserve unchanged child source, including children moved within a sequence.

**Tests:** `cli/folder.test.ts › keeps authored YAML bytes while first push adds metadata and a remote edit changes one value`.

### `folders/preserve-safe-render`

If frontmatter cannot be rendered with the intended values, then a device MUST leave the file unchanged.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/preserve-leading-space`

When a pull removes the first frontmatter property, a device MUST remove newly leading blank lines that would prevent the opening fence being recognized as frontmatter.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/preserve-sequence-indent`

When a pull replaces an unindented block sequence with a scalar or flow collection, a device MUST indent the replacement under its key.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/own-fields-appended`

When an existing document lacks required own-field lines, a device MUST append those lines without moving the document's existing fields.

**Tests:** `device/folders-contract-a.test.ts › expands affected aliases and preserves untouched anchors when removal is %s`.

### `folders/behind-fields-restored`

When a behind file carries old own-field values, a device MUST write the item's current own-field values during the next pull.

**Tests:** `device/folders-contract-a.test.ts › writes current own fields over a behind file without sending the old fields`.

### `folders/old-tag-version-advance`

When an item advances to another version after a tag change was flagged as indistinguishable from an old buffer, a device MUST accept an explicit tag edit from the newly rendered current file.

**Tests:** `device/folders-contract-a.test.ts › allows a previously ambiguous tag change after the item version advances`.

### `folders/successive-state-saves`

When several state changes are scanned from one file version before a drain, a device MUST queue them in save order.

**Tests:** `device/folders-contract-a.test.ts › queues successive state changes from one version in save order`.

### `folders/preserve-moved-alias`

When a pull moves an alias before its anchor, a device MUST expand the alias as needed to retain its intended value.

**Tests:** `device/folders-contract-a.test.ts › expands an alias moved before its anchor while preserving other anchor groups`.

### `folders/preserve-alias-values`

When a pull changes or removes a YAML anchor, a device MUST expand affected aliases as needed to preserve their intended values.

**Tests:** `device/folders-contract-a.test.ts › expands affected aliases and preserves untouched anchors when removal is %s`.

### `folders/preserve-unaffected-anchors`

When a pull changes one YAML anchor group, a device MUST preserve untouched anchor groups as written.

**Tests:** `device/folders-contract-a.test.ts › expands affected aliases and preserves untouched anchors when removal is %s`.

### `folders/old-state-version-advance`

When an item advances to another version after a state change was flagged as indistinguishable from an old buffer, a device MUST accept an explicit state edit from the newly rendered current file.

**Tests:** `device/folders-contract-a.test.ts › allows a previously ambiguous state change after the item version advances`.

### `folders/body-property-line-no-flag`

When a document names its current body property in frontmatter as well as having body text, a device MUST use the body text without flagging that duplicate representation.

**Tests:** `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

## Document recognition and refusals

### `folders/frontmatter-fences`

When a Markdown file opens with an incomplete fence, a fence followed by a blank line, or a fence pair holding a list or text, a device MUST read that text as body.

**Tests:** `device/folders.test.ts › treats a body opening with a horizontal rule as a body`, `device/folders.test.ts › treats a fence pair holding a list or one line as a body`, `device/folders-contract-a.test.ts › reads incomplete fences as body and an empty fence pair as empty frontmatter`.

### `folders/frontmatter-empty`

When a Markdown file opens with an empty fence pair, a device MUST read it as empty frontmatter.

**Tests:** `device/folders-contract-a.test.ts › reads incomplete fences as body and an empty fence pair as empty frontmatter`.

### `folders/bom-read`

When a UTF-8 document opens with a byte-order mark, a device MUST read past the mark.

**Tests:** `device/folders.test.ts › reads past a byte-order mark and writes the file back without it`.

### `folders/bom-write`

When a device rewrites a Markdown document that opened with a byte-order mark, a device MUST omit the mark.

**Tests:** `device/folders.test.ts › reads past a byte-order mark and writes the file back without it`.

### `folders/retype-current`

When a current document changes its `type` line to another document type, a device MUST send the item edit with the new type and `retype: true`.

**Tests:** `device/folders-frontmatter.test.ts › retypes an item whose frontmatter changes its type`.

### `folders/retype-new-body`

When retyping a document changes its body property, a device MUST use a nonempty frontmatter value for the new body property, or the document body if none is provided.

**Tests:** `device/folders-frontmatter.test.ts › keeps both body fields' text when a retype moves the body to another`.

### `folders/retype-old-body`

When retyping a document changes its body property, a device MUST preserve the old body property's text.

**Tests:** `device/folders-frontmatter.test.ts › keeps both body fields' text when a retype moves the body to another`.

### `folders/retype-unsuited`

If a document names an unknown type, a `system.*` type or a file type, then a device MUST refuse its creation or retype locally.

**Tests:** `device/folders-frontmatter.test.ts › refuses a type no document can be, before sending anything`.

### `folders/refused-edit-kept`

When the server refuses a document edit, tag change, or state change, a device MUST preserve the person's file.

**Tests:** `device/folders-frontmatter.test.ts › flags a refused retype and keeps the file`.

### `folders/refused-edit-report`

When a document write is refused, a device MUST flag the held file `refused` with the server's code and message.

**Tests:** `device/folders-frontmatter.test.ts › flags a refused retype and keeps the file`.

### `folders/refused-edit-follow`

When a held file is renamed, reformatted, or changed without replacing its refused change, a device MUST retain the refusal on that file.

**Tests:** `device/folders-frontmatter.test.ts › through a rename before the drain`, `device/folders-frontmatter.test.ts › through a rename after the refusal`, `device/folders-frontmatter.test.ts › through a save that only reformats it before the drain`, `device/folders-frontmatter.test.ts › through a later save that only adds a tag`, `device/folders-frontmatter.test.ts › through a later save that only edits the body, where a tag was refused`.

### `folders/refused-edit-no-repeat`

While a refused document remains unchanged, a device MUST NOT send the same change again.

**Tests:** `device/folders-frontmatter.test.ts › flags a refused retype and keeps the file`.

### `folders/refused-edit-replaced`

When a later save lands an edit replacing a refused edit, a device MUST release the file's refusal hold.

**Tests:** `device/folders-frontmatter.test.ts › lets a file go once a later save lands after a refused one`.

### `folders/refused-tag-mended`

When a file stops carrying a refused tag and its replacement tag lands, a device MUST clear the refused-tag hold.

**Tests:** `device/folders-frontmatter.test.ts › sends a mended tag from a file whose edit landed beside the refused one`.

### `folders/refused-edit-version`

When a document edit is refused, a device MUST base the next edit on the file's version unless an earlier accepted edit already consumed that version.

**Tests:** `device/folders-placement.test.ts › sends a save after a refused edit as behind, keeping what another machine changed or added`, `device/folders-placement.test.ts › keeps the line a landed edit spent when a later edit from the same buffer is refused`.

### `folders/refused-own-field-replaced`

When a later accepted change supersedes a refused change of the same tag or state, a device MUST release the file's refusal hold for that change.

**Tests:** `device/folders-contract-a.test.ts › releases a refused %s when a later change of it is accepted`.

### `folders/document-name-refusal`

If a document contains a tag or property name the server refuses, or would exceed the item's tag limit, then a device MUST report the file's path and the refusal reason.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`, `device/folder-names.test.ts › queues nothing of an edit whose added tag is refused, and the edit once the tag is dropped`, `device/folder-names.test.ts › is flagged with its reason and queues nothing of it, while a swap on a full item and the files after it are saved`.

### `folders/document-name-preserve`

If a document contains a tag or property name the server refuses, or would exceed the item's tag limit, then a device MUST preserve the file's bytes.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`.

### `folders/document-name-no-writes`

If a document contains a tag or property name the server refuses, or would exceed the item's tag limit, then a device MUST NOT queue any write from that file.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`, `device/folder-names.test.ts › queues nothing of an edit whose added tag is refused, and the edit once the tag is dropped`, `device/folder-names.test.ts › is flagged with its reason and queues nothing of it, while a swap on a full item and the files after it are saved`.

### `folders/document-name-continue`

When a scan refuses a document's tag or property name or tag count, a device MUST continue scanning the other files.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`, `device/folder-names.test.ts › is flagged with its reason and queues nothing of it, while a swap on a full item and the files after it are saved`.

### `folders/document-name-retry`

When a document's refused tag or property name or tag count is corrected, a device MUST accept the corrected file at the next scan.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`, `device/folder-names.test.ts › queues nothing of an edit whose added tag is refused, and the edit once the tag is dropped`.

## Unreadable documents

### `folders/unreadable-yaml`

If Markdown frontmatter is malformed, has a non-text key, duplicates a key, or uses a YAML merge key, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folders/unreadable-no-write`

While a document is unreadable, a device MUST NOT send an item create or edit for it.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folders/unreadable-preserve`

While a bound document is unreadable, a device MUST preserve its bytes during pull.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`.

### `folders/unreadable-report`

While a bound document is unreadable, a device MUST report its path and reason in the pull's `flagged` entries.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`.

### `folders/unreadable-rename`

When an unreadable document moves and its identity or readable `marfa_id` establishes the same item, a device MUST retain that item binding.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`, `device/folders-frontmatter.test.ts › keeps an unreadable file's item when it moves with no identity`.

### `folders/unreadable-repaired`

When an unreadable document is repaired, a device MUST process its edit normally.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`.

### `folders/encoding-flag`

If a document is not UTF-8 text or contains a NUL byte, then a device MUST flag it `encoding` with the reason.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/encoding-no-send`

While a document is held for encoding, a device MUST NOT send its content.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/encoding-preserve`

While a document is held for encoding, a device MUST preserve its bytes during pull.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/encoding-status`

While a document is held for encoding, the CLI MUST list it as `held` in `folders status`.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/encoding-repaired`

When a document is saved as UTF-8 without NUL bytes, a device MUST admit its content.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/file-bytes-not-document`

When a non-document file contains bytes that are not valid UTF-8 or include NUL, a device MUST admit those bytes as a file item rather than apply document encoding restrictions.

**Tests:** `device/folders-contract-a.test.ts › applies default properties to documents but not file items`.

## Document versions

### `folders/version-line`

When a pull writes a Markdown file, a device MUST write `marfa_version` naming the item version rendered.

**Tests:** `device/folders-placement.test.ts › bases a stale file's edit on the version written in it`.

### `folders/version-stale-merge`

When a file names an older version not consumed by its accepted edits, a device MUST send the property edit as a merge based on that version, including a version the copy never held.

**Tests:** `device/folders-placement.test.ts › bases a stale file's edit on the version written in it`, `device/folders-placement.test.ts › merges a file whose line names a version the copy skipped against that line`, `device/folders-placement.test.ts › merges a file behind the copy, clearing nothing its lines left out`.

### `folders/version-absent-merge`

When a document edit has no usable version line, a device MUST send its properties as a merge rather than a replacement.

**Tests:** `device/folders-frontmatter.test.ts › merges an edit from a file with no version line`, `device/folders-frontmatter.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folders/version-consumed`

When an earlier accepted edit consumed a file's version line, a device MUST base the next edit from that line on the copy's current version.

**Tests:** `device/folders-placement.test.ts › bases a stale file's edit on the version written in it`, `device/folders-placement.test.ts › keeps a line an edit spent spent after the pull rewrites it`.

### `folders/version-rewrite-waiting`

When a pull rewrites a file over its waiting edit and that edit later lands, a device MUST treat the rewritten line as consumed by the accepted edit.

**Tests:** `device/folders-placement.test.ts › keeps the line a pull wrote over a waiting edit spent, once that edit lands`, `device/folders-placement.test.ts › keeps a line spent where a pull writes the file over the edit that spent it`.

### `folders/version-rewrite-refused`

When a pull rewrites a file over a waiting edit that is then refused, a device MUST base the next edit from that rewritten file on its version line.

**Tests:** `device/folders-placement.test.ts › takes back the line a pull wrote over a waiting edit when that edit is refused`.

### `folders/version-answered-unchanged`

When a pull writes a newer version line over a waiting edit that is then refused after an earlier edit was accepted or conflicted, a device MUST base the next edit from that newer buffer on its own version line.

**Tests:** `device/folders-placement.test.ts › lifts no answered edit's line when a pull writes over a waiting one, a conflicted edit's included`.

### `folders/version-dead-unchanged`

When a pull writes a newer version line over a waiting edit that is then refused after an earlier edit died, a device MUST base the next edit from that newer buffer on its own version line.

**Tests:** `device/folders-placement.test.ts › lifts no dead edit's line when a pull writes over a later waiting one`.

### `folders/version-external-write`

When a write queued outside the file lands after a pull rewrote the file over it, a device MUST base the next file edit on the copy's current version.

**Tests:** `device/folders-placement.test.ts › keeps the line a pull wrote over an edit queued outside the file spent, once that edit lands`.

### `folders/version-dead-consumed`

When an edit dies after exhausting retries, a device MUST base another edit from that same buffer on the copy's current version.

**Tests:** `device/folders-placement.test.ts › keeps a dead edit's line spent, since the server may have taken it`.

### `folders/version-dead-refused`

When a released dead edit is explicitly refused and no accepted edit has used its version line, a device MUST base the next edit from that buffer on the buffer's version line.

**Tests:** `device/folders-placement.test.ts › takes back a dead edit's line once, released, the server refuses it`.

### `folders/version-only-save`

When a save changes only `marfa_version`, a device MUST NOT send an item edit.

**Tests:** `device/folders-placement.test.ts › sends nothing for a save that changes only the version line`.

### `folders/version-ancestor-missing`

When the server no longer holds the file edit's ancestor version, a device MUST retry the edit as a property merge on the copy's current version.

**Tests:** `device/folders-placement.test.ts › sends over a thinned version as a merge, and says so`.

### `folders/version-rebased-count`

When a folder edit is resent after its ancestor version is unavailable, a device MUST count that resend as `rebased`.

**Tests:** `device/folders-placement.test.ts › sends over a thinned version as a merge, and says so`.

### `folders/version-rebased-words`

When a push or watch resends an edit because its ancestor version is unavailable, the CLI MUST say that it was resent on the version the copy holds.

**Tests:** `device/folders-placement.test.ts › says in words that an edit went over a thinned version`, `device/folders-placement.test.ts › says while watching that an edit went over a thinned version`.

### `folders/version-rebase-limit`

When an edit resent after an unavailable ancestor is blocked for another unavailable ancestor, a device MUST leave it blocked until another pass.

**Tests:** `device/folders-placement.test.ts › stops at one resend where the server no longer holds the version the copy holds either`.

### `folders/version-only-pull`

When a remote version change alters nothing rendered in the file, a device MUST leave the file's bytes unchanged.

**Tests:** `device/folders-placement.test.ts › does not rewrite a file for its version line alone`.

### `folders/version-own-edit-landed`

When the file's own edit lands and the file remains unchanged since scan, a device MUST update its version line to the accepted version.

**Tests:** `device/folders-placement.test.ts › does not rewrite a file for its version line alone`, `device/folders-placement.test.ts › writes the line into a file saved without one, once its edit lands`.

### `folders/version-own-edit-after-pull`

When a file's own edit lands after a pull wrote the file while it waited, a device MUST update the version line again to the accepted version.

**Tests:** `device/folders-placement.test.ts › rewrites the line once its own edit lands, where a pull wrote the file while that edit waited`.

### `folders/version-unknown-base`

When a document has no version line or names a version ahead of the working copy, a device MUST base its property merge on the copy's current item version.

**Tests:** `device/folders-contract-a.test.ts › merges on the copy version when the file version line is %s`.

### `folders/version-not-property`

When a device sends a document edit, a device MUST omit `marfa_version` from item properties.

**Tests:** `device/folders-contract-a.test.ts › merges on the copy version when the file version line is %s`.

## Edge lines and name lookup

### `folders/edge-catalog-refresh`

When a changed file names a newly registered edge type and the server is reachable, a device MUST read the line as an edge rather than a property.

**Tests:** `device/folders-frontmatter.test.ts › learns an edge type the server registers, and reads its line as an edge`, `device/fidelity.test.ts › matches the edge types a working copy holds and a folder reads its frontmatter lines by`.

### `folders/edge-target-hydration`

When a new edge type is written at its target, a device MUST refresh the folder slice to hold that type whole at the next push.

**Tests:** `device/folders-frontmatter.test.ts › learns an edge type the server registers, and reads its line as an edge`.

### `folders/edge-title-outside-folder`

When a document writes an edge to a readable item outside the folder search, a device MUST render that target by title where the name is unambiguous.

**Tests:** `device/folders-frontmatter.test.ts › writes and reads back by title a link to an item with no file on this Mac`.

### `folders/edge-pin-held`

While at least one document line names an item outside the slice, a device MUST retain the pin it made for that item.

**Tests:** `device/folders-frontmatter.test.ts › holds a pin while a line names its row, and lets go only a pin it made`, `device/folders-contract-extra-c.test.ts › keeps a shared edge target pinned until the last owning file releases it`.

### `folders/edge-pin-release`

When no file binding or edge line requires an item pinned by the folder, a device MUST release the folder's pin, unless a pinned create was answered with the item after an edge line pinned it (`device/pin-create-lasts`).

**Tests:** `device/folders-frontmatter.test.ts › holds a pin while a line names its row, and lets go only a pin it made`, `device/folders-contract-extra-c.test.ts › keeps a shared edge target pinned until the last owning file releases it`.

### `folders/edge-pin-other-owner`

When an edge line is removed, a device MUST retain a pin for its target that the folder did not create.

**Tests:** `device/folders-frontmatter.test.ts › holds a pin while a line names its row, and lets go only a pin it made`.

### `folders/edge-writing-end`

When rendering an edge, a device MUST write its frontmatter line only at the end named by the edge type's `written_at`, using its forward name at the source or reverse name at the target.

**Tests:** `device/folders-frontmatter.test.ts › writes an edge in one file only`, `device/folders-frontmatter.test.ts › writes parent-of as child-of in the child`.

### `folders/edge-file-fallback`

When an edge's designated writing end cannot carry frontmatter, a device MUST write the edge at the other document end under its name there.

**Tests:** `device/folders-frontmatter.test.ts › writes attached-to in the attachment's file, and has-attachment in an image's host`.

### `folders/edge-unknown-writer`

When the copy cannot determine whether an edge's designated writing end carries frontmatter, a device MUST preserve a typed reverse line at the other end.

**Tests:** `device/folders-frontmatter.test.ts › keeps a typed has-attachment to an image the copy does not hold`.

### `folders/edge-title-format`

When a target has one unambiguous title that link syntax can represent, a device MUST render an edge target as `[[title]]`.

**Tests:** `device/folders-frontmatter.test.ts › writes an edge in one file only`.

### `folders/edge-id-format`

When a target title is ambiguous or cannot be represented in link syntax, a device MUST render the edge target as `[[id]]`.

**Tests:** `device/folders-frontmatter.test.ts › writes the id form where a name is repeated`, `device/folders-frontmatter.test.ts › writes by id a title a link cannot hold`.

### `folders/edge-id-read`

When an edge line names a readable item by ID, optionally followed by a heading or alias, a device MUST resolve that ID even if the item has no file in the folder.

**Tests:** `device/folders-frontmatter.test.ts › resolves a target written by id`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folders/edge-filename-read`

When an edge line uniquely names a bound file by filename, a device MUST resolve it to that file's item.

**Tests:** `device/folders-frontmatter.test.ts › resolves a name by its file's name, and keeps it as typed`.

### `folders/edge-alias`

When an edge line unambiguously names a target with an alias or heading, a device MUST resolve the name before `|` or `#`.

**Tests:** `device/folders-frontmatter.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folders/edge-deduplicate-target`

When several names in one edge line resolve to the same item, a device MUST treat them as one target.

**Tests:** `device/folders-frontmatter.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folders/edge-name-syntax-ambiguity`

If an edge-line target resolves as its full text to one item and as a name with a heading or alias to a different item, then a device MUST flag the line `edges` instead of choosing a target.

**Tests:** `device/folders-frontmatter.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`.

### `folders/edge-name-unmatched`

If a typed edge target matches no readable item, then a device MUST flag the file `edges` with the unmatched name.

**Tests:** `device/folders-frontmatter.test.ts › flags an unmatched name and leaves it as typed`.

### `folders/edge-name-ambiguous`

If a typed edge target matches more than one readable item, then a device MUST flag the file `edges` with the ambiguity.

**Tests:** `device/folders-frontmatter.test.ts › flags an ambiguous name and leaves it as typed`, `device/fidelity.test.ts › matches the name lookup a folder asks the server for a typed name`.

### `folders/edge-name-kept`

When an edge line already resolves to its item, a device MUST preserve the typed target through a pull that rewrites the file.

**Tests:** `device/folders-frontmatter.test.ts › resolves a name by its file's name, and keeps it as typed`, `device/folders-frontmatter.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`.

### `folders/edge-new-namesake`

When another item takes an existing edge target's name, a device MUST retain the existing edge target.

**Tests:** `device/folders-frontmatter.test.ts › leaves an existing link unchanged when a same-named item appears`.

### `folders/edge-lookup-waits`

When name lookup cannot reach a server, a device MUST flag the unresolved edge name as waiting for lookup.

**Tests:** `device/folders-frontmatter.test.ts › waits for the server to resolve a name, and resolves it at the next pass that reaches it`.

### `folders/edge-lookup-retries`

When the server becomes reachable after a name lookup waited, a device MUST retry that lookup at the next scan.

**Tests:** `device/folders-frontmatter.test.ts › waits for the server to resolve a name, and resolves it at the next pass that reaches it`.

### `folders/edge-lookup-refused`

When the server refuses a name lookup, a device MUST flag only the affected file with the refusal.

**Tests:** `device/folders-frontmatter.test.ts › flags only the file whose name cannot be looked up, and goes on with the rest`.

### `folders/edge-lookup-no-repeat`

While a file with a refused name lookup is unchanged, a device MUST NOT repeat that lookup.

**Tests:** `device/folders-frontmatter.test.ts › flags only the file whose name cannot be looked up, and goes on with the rest`.

### `folders/edge-lookup-page-limit`

When the fifth lookup page for a title property and spelling says more matches follow, a device MUST flag the name as exceeding the five-page lookup limit.

**Tests:** `device/folders-frontmatter.test.ts › flags a name more common than the lookup reads`.

### `folders/edge-lookup-states`

When resolving an edge target by name, a device MUST consider archived items and exclude trashed items.

**Tests:** `device/folders-frontmatter.test.ts › counts an archived match only the server holds, and none in the bin`.

### `folders/edge-lookup-title-field`

When resolving an edge target by title, a device MUST match the property that its type uses as the title.

**Tests:** `device/folders-frontmatter.test.ts › matches a title only in the property its type keeps it in`.

### `folders/edge-line-removal`

When a document removes a previously rendered edge line, a device MUST delete the edge that line represented.

**Tests:** `device/folders-frontmatter.test.ts › removes the edge whose line was taken out`.

### `folders/edge-unshown-kept`

When an edge has arrived from elsewhere but has not appeared in the file, a device MUST preserve it when processing that file.

**Tests:** `device/folders-frontmatter.test.ts › flags a new target for an end whose edge the file never showed, and deletes nothing`.

### `folders/edge-line-invalid-keeps-type`

If an edge line has an unresolved target, names its own item, is at the wrong end, or exceeds its end's cardinality, then a device MUST leave that file's edges of that type unchanged.

**Tests:** `device/folders-frontmatter.test.ts › changes no edge of a type whose target it cannot resolve`, `device/folders-frontmatter.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`, `device/folders-frontmatter.test.ts › flags a line naming too many targets for its edge type, and changes nothing`, `device/folders-frontmatter.test.ts › flags an in-folder line and a line naming its own item`.

### `folders/edge-line-invalid-report`

If an edge line is invalid, then a device MUST flag the file `edges` with the reason.

**Tests:** `device/folders-frontmatter.test.ts › changes no edge of a type whose target it cannot resolve`, `device/folders-frontmatter.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`, `device/folders-frontmatter.test.ts › flags a line naming too many targets for its edge type, and changes nothing`, `device/folders-frontmatter.test.ts › flags an in-folder line and a line naming its own item`, `device/folders-contract-extra-c.test.ts › leaves an invalid bare edge line untouched while a valid link queues its edge`.

### `folders/edge-line-no-item-edit`

When a save changes only edge lines, a device MUST NOT send an item-property edit for those changes.

**Tests:** `device/folders-frontmatter.test.ts › removes the edge whose line was taken out`, `device/folders-frontmatter.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`.

### `folders/edge-replace-one`

When a line changes the target of an end that holds one edge, a device MUST move the existing edge's other end in one write.

**Tests:** `device/folders-frontmatter.test.ts › replaces a one-target edge's target in one step`, `device/fidelity.test.ts › matches the refusal of a second parent, a parent moved in one step, and each refusal of a move`.

### `folders/edge-replace-keeps-properties`

When a line moves an existing edge's other end, a device MUST preserve that edge's ID and properties.

**Tests:** `device/folders-frontmatter.test.ts › replaces a one-target edge's target in one step`.

### `folders/edge-replace-unshown-refused`

When a line names a new target but the existing edge at that end has not appeared in the file, a device MUST flag the file.

**Tests:** `device/folders-frontmatter.test.ts › flags a new target for an end whose edge the file never showed, and deletes nothing`.

### `folders/edge-replace-unshown-kept`

When a line names a new target but the existing edge at that end has not appeared in the file, a device MUST leave that edge unchanged.

**Tests:** `device/folders-frontmatter.test.ts › flags a new target for an end whose edge the file never showed, and deletes nothing`.

### `folders/edge-delete-already-gone`

When an edge deletion is answered `edge_not_found`, a device MUST treat the requested removal as complete.

**Tests:** `device/folders-frontmatter.test.ts › takes a delete of an edge already gone as done`.

### `folders/edge-move-refused`

When the server refuses an edge move, a device MUST retain the old edge in its working copy.

**Tests:** `device/folders-frontmatter.test.ts › keeps the old edge where the replace is refused`.

### `folders/edge-move-refusal-holds`

When the server refuses an edge move, a device MUST hold the document with the server's refusal reason.

**Tests:** `device/folders-frontmatter.test.ts › keeps the old edge where the replace is refused`, `device/folders-frontmatter.test.ts › holds a file whose move a plain device drain saw refused`.

### `folders/edge-refusal-next-move`

When a later edit replaces a refused edge move, a device MUST move from the edge's last accepted position.

**Tests:** `device/folders-frontmatter.test.ts › keeps the old edge where the replace is refused`.

### `folders/edge-move-gone-create`

When an edge move is answered that the edge is gone, a device MUST create the edge the document line now requests.

**Tests:** `device/folders-frontmatter.test.ts › makes the edge a line asks for where its move finds the edge deleted elsewhere`, `device/folders-frontmatter.test.ts › makes the edge a gone move's line asks for at the next drain, where the first one stops`.

### `folders/edge-move-gone-properties`

When an edge move is answered that the edge is gone, a device MUST preserve the former edge's properties in the replacement edge it creates for the document line.

**Tests:** `device/folders-frontmatter.test.ts › makes the edge a line asks for where its move finds the edge deleted elsewhere`.

### `folders/edge-move-waits-create`

When a line moves an edge to an item whose create is queued, a device MUST wait for that item create before sending the move.

**Tests:** `device/folders-frontmatter.test.ts › waits for the create of the item its line now names before it moves the edge`.

### `folders/edge-move-dead-keeps`

When an edge move dies after its retries, a device MUST retain the accepted server edge.

**Tests:** `device/folders-frontmatter.test.ts › leaves the server's edge whole where a move dies after its retries`.

### `folders/edge-create-refusal-holds`

When the server refuses an edge create from a document line, a device MUST report the refusal beside any unresolved-name flag for that file.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose line's edge is refused, and says it beside a name it cannot resolve`.

### `folders/edge-catalog-boundaries`

When a folder is added, hydrated or caught up, a device MUST read the current edge-type catalog.

**Tests:** `device/folders-contract-extra-c.test.ts › reads the edge catalog at add, hydration and catch-up`.

### `folders/edge-no-writable-name`

When an edge's writing end cannot carry frontmatter and the edge type has no name from the other end, a device MUST write that edge in no file.

**Tests:** `device/folders-contract-extra-c.test.ts › writes no line for a binary edge writer with no reverse name`.

### `folders/edge-name-normalization`

When an edge-line name uniquely matches a target by title or filename, a device MUST resolve the target without regard to case or Unicode normalization form.

**Reason:** The server's lookup compares case over ASCII; the device resolves and deduplicates the candidates using its name comparison.

**Tests:** `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folders/edge-restored-target`

When a line held because its target was trashed names that target after its restoration reaches the working copy, a device MUST resolve the line at the next scan.

**Tests:** `device/folders-contract-extra-c.test.ts › resolves a held line when its trashed target is restored`.

## Body links and embedded files

### `folders/body-reference`

When a Markdown body links to another item, a device MUST create a `references` edge from the document item to the linked item.

**Tests:** `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`.

### `folders/body-edge-not-repeated`

When a Markdown body already represents an edge as a link or embed, a device MUST NOT repeat it as a frontmatter edge line.

**Tests:** `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`, `device/folders-frontmatter.test.ts › lists under has-attachment only what the body does not embed`, `device/folders-frontmatter.test.ts › resolves body links by title and nested filename without repeating references on pull`.

### `folders/body-unlinked-edge-line`

When a `references` edge has no matching body link, a device MUST render it as a frontmatter line without changing the body.

**Tests:** `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`.

### `folders/body-link-name`

When a Markdown body link names an ID, title, filename, or bound file path with an optional extension, heading, or alias, a device MUST resolve the linked item by the same name rules as frontmatter edge lines.

**Tests:** `device/folders-frontmatter.test.ts › resolves body links by title and nested filename without repeating references on pull`, `device/folders-frontmatter.test.ts › reports ambiguous body links including whole names with heading or alias marks`.

### `folders/body-link-ambiguity`

When a body-link name is ambiguous, including between its full text and its heading or alias interpretation, a device MUST report the ambiguity without choosing a target.

**Tests:** `device/folders-frontmatter.test.ts › reports ambiguous body links including whole names with heading or alias marks`, `device/folders-frontmatter.test.ts › does not choose between existing references answering to the same body name`.

### `folders/body-code-comments`

When a body link occurs in Markdown code, an HTML comment, or an Obsidian `%%` comment, a device MUST treat it as text.

**Tests:** `device/folders-frontmatter.test.ts › ignores body links in code and comments while sending visible links`, `device/folders-frontmatter.test.ts › keeps visible references and removes code-only references with %s`.

### `folders/body-local-heading`

When a body link names only a heading in the same document, a device MUST ignore it for edge creation.

**Tests:** `device/folders-frontmatter.test.ts › resolves body links by title and nested filename without repeating references on pull`, `device/folders-frontmatter.test.ts › ignores body links in code and comments while sending visible links`.

### `folders/body-note-embed`

When a Markdown body embeds a document rather than a file item, a device MUST treat that embed as text.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed of a note, even one with a dot in its name, as text`, `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`.

### `folders/body-lookup-retry`

When a body-link lookup cannot reach the server, a device MUST retry it at the next pass that reaches the server.

**Tests:** `device/folders-frontmatter.test.ts › waits for body link lookups and retries them when the server returns`.

### `folders/body-missing-report`

When a body link resolves to no item, a device MUST flag its document with the link text and reason.

**Tests:** `device/folders-frontmatter.test.ts › reports missing body links and preserves removals until all links resolve`, `device/body-links-live.test.ts › resolves body links through real server lookup and keeps their removal after pull`.

### `folders/body-unresolved-keeps-edges`

While a body link is unresolved, a device MUST retain the document's existing references until every link resolves.

**Tests:** `device/folders-frontmatter.test.ts › reports missing body links and preserves removals until all links resolve`, `device/body-links-live.test.ts › resolves body links through real server lookup and keeps their removal after pull`.

### `folders/embed-edge`

When a Markdown body embeds a local file, a device MUST create an `attached-to` edge from the file item to the document item.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folders/embed-edge-removal`

When a document removes an embed, a device MUST delete that attachment edge.

**Tests:** `device/folders-frontmatter.test.ts › removes the edge when the embed is taken out`, `device/folders-frontmatter.test.ts › removes the edge of an embed taken out between two scans before a push`.

### `folders/embed-file-kept`

When a document removes an embed, a device MUST retain the embedded file on disk.

**Tests:** `device/folders-frontmatter.test.ts › removes the edge when the embed is taken out`.

### `folders/embed-markdown-only`

When a raw-text document contains embed syntax, a device MUST NOT create an attachment edge for that syntax.

**Tests:** `device/folders-frontmatter.test.ts › reads embeds in a Markdown body only, and none shown in code`, `device/folders-frontmatter.test.ts › writes no file a .txt file's text embeds`.

### `folders/embed-raw-no-file`

When a raw-text document contains embed syntax, a device MUST NOT materialize a file for that syntax.

**Tests:** `device/folders-frontmatter.test.ts › writes no file a .txt file's text embeds`.

### `folders/embed-code-comments`

When embed syntax occurs in a code span, fenced code block, indented code block or comment, a device MUST treat it as text, including code nested inside lists or quotes.

**Tests:** `device/folders-frontmatter.test.ts › reads embeds in a Markdown body only, and none shown in code`, `device/folders-contract-extra-c.test.ts › ignores embeds in list fences and indented code while reading a normal list paragraph`.

### `folders/embed-path`

When a Markdown embed names a path, a device MUST resolve it relative to the embedding document's directory, or the folder root for a leading `/`.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path as Obsidian reads one`.

### `folders/embed-path-escapes`

When resolving an embed path, a device MUST decode percent escapes and remove its query or fragment.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path as Obsidian reads one`.

### `folders/embed-address`

When an embed names an address beginning with `https://`, `//`, or `#`, a device MUST NOT treat it as a local file.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path as Obsidian reads one`.

### `folders/embed-path-case`

When an embed path differs only in case from the matching file, a device MUST retain the file's own spelling.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path whatever its case, and keeps the file's own name`.

### `folders/embed-wiki-name`

When `![[name]]` names a file, a device MUST prefer the root-relative path, then a matching path suffix at a directory boundary ordered by the embedding directory, shallowest depth, and path.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed by name as Obsidian resolves a name`.

### `folders/embed-upload`

When a document embeds an admissible file, a device MUST upload that file before creating its file item regardless of the search's admitted file types.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folders/embed-held`

While a document embeds a readable active or archived file item, a device MUST retain its file regardless of the folder search's type and state restrictions.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`, `device/folders-frontmatter.test.ts › keeps an embedded file archived elsewhere where its search holds active items only`.

### `folders/embed-path-placement`

When a pull materializes a path embed, a device MUST place its file where the document's link names it.

**Tests:** `device/folders-frontmatter.test.ts › writes an embedded file where its link says`.

### `folders/embed-name-placement`

When a pull materializes a name embed, a device MUST use an existing matching placement or file path, otherwise place a bare name beside the embedding document or a name containing a directory at the folder root.

**Tests:** `device/folders-frontmatter.test.ts › writes an embedded file where its link says`, `device/folders-frontmatter.test.ts › writes a file embedded by name where its placement already answers to the name`, `device/folders-frontmatter.test.ts › writes a file embedded by name where another embed's path names it`.

### `folders/embed-placement-follows`

When an embed determines a file's path, a device MUST update that file's `in-folder` placement to the path.

**Tests:** `device/folders-frontmatter.test.ts › writes an embedded file where its link says`.

### `folders/embed-renamed`

When an embedded file is renamed so its old link no longer names it, a device MUST preserve the file's item and attachment edge at its new name.

**Tests:** `device/folders-frontmatter.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folders/embed-renamed-report`

When an embedded file is renamed so its old link no longer names it, a device MUST report the broken embed.

**Tests:** `device/folders-frontmatter.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folders/embed-unresolved-line`

When a renamed attachment no longer resolves from its body embed, a device MUST render its `has-attachment` line.

**Tests:** `device/folders-frontmatter.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folders/embed-attachment-hydration`

When a folder search admits document types, a device MUST hold `attached-to` edges whole.

**Tests:** `device/folders-frontmatter.test.ts › holds attachments whole only where its search holds a document`.

### `folders/embed-trashed-line`

When an embedded item is trashed or its ability to carry frontmatter is unknown, a device MUST NOT repeat its attachment edge under `has-attachment`.

**Tests:** `device/folders-frontmatter.test.ts › lists a trashed embedded file under has-attachment no more than a held one`.

### `folders/embed-outside`

When an embed path leads outside the folder, a device MUST report the embed in `embeds`.

**Tests:** `device/folders-frontmatter.test.ts › reports an embed pointing outside the folder`.

### `folders/embed-outside-no-write`

When an embed path leads outside the folder, a device MUST NOT read or write the file it names.

**Tests:** `device/folders-frontmatter.test.ts › reports an embed pointing outside the folder`.

### `folders/embed-two-paths`

When one attachment is embedded at different paths, a device MUST write it at the first path in path order.

**Tests:** `device/folders-frontmatter.test.ts › writes an item embedded at two paths at the first, and reports the other`.

### `folders/embed-two-paths-report`

When one attachment is embedded at different paths, a device MUST report each embed naming another path.

**Tests:** `device/folders-frontmatter.test.ts › writes an item embedded at two paths at the first, and reports the other`.

### `folders/embed-unresolved-keeps-edges`

While an embed names a missing file or has an invalid raw-space path, a device MUST retain the document's existing attachment edges.

**Tests:** `device/folders-frontmatter.test.ts › removes no attachment while an embed names nothing, and removes it once none does`.

### `folders/embed-unreadable-target`

When an embed names no attachment the key can read, a device MUST report the embed.

**Tests:** `device/folders-frontmatter.test.ts › reports an embed of a file the key cannot read, and writes nothing for it`.

### `folders/embed-unreadable-no-write`

When an embed names no attachment the key can read, a device MUST NOT write a file for it.

**Tests:** `device/folders-frontmatter.test.ts › reports an embed of a file the key cannot read, and writes nothing for it`.

### `folders/embed-ambiguous-target`

When an embed name matches two attachments, a device MUST report the ambiguity.

**Tests:** `device/folders-frontmatter.test.ts › writes nothing for a name two attachments share, and says so`.

### `folders/embed-ambiguous-no-write`

When an embed name matches two attachments, a device MUST NOT write a file for it.

**Tests:** `device/folders-frontmatter.test.ts › writes nothing for a name two attachments share, and says so`.

### `folders/body-self-link`

When a body link names its own document item, a device MUST NOT create an edge for that link.

**Tests:** `device/folders-contract-extra-c.test.ts › ignores a body link to its own item while linking another item`.

### `folders/embed-list-paragraph`

When an embed occurs in an ordinary Markdown list paragraph, a device MUST resolve it as an embed despite the list indentation.

**Tests:** `device/folders-contract-extra-c.test.ts › ignores embeds in list fences and indented code while reading a normal list paragraph`.

### `folders/embed-duplicate-line`

When a pull rewrites a document whose body embeds an attachment also named in its `has-attachment` line, a device MUST omit that duplicate attachment from the line.

**Tests:** `device/folders-contract-extra-c.test.ts › removes a redundant attachment line when the host body already embeds its file`.

### `folders/embed-upload-size`

When an embedded file needs uploading, a device MUST leave its size-limit decision to the server's upload operation.

**Tests:** `device/folders-contract-extra-c.test.ts › sends an embedded file to the server for its upload limit decision`.

## File identity

### `folders/markdown-extensions`

When a file has a `.md` or `.markdown` extension in any letter case, a device MUST read its Markdown metadata.

**Tests:** `device/folders-identity.test.ts › reads the id of a Markdown file whatever the case of its extension`.

### `folders/id-rename`

When a Markdown file moves with its `marfa_id` line intact and no stronger binding identifies another item, a device MUST retain the named item.

**Tests:** `device/folders-identity.test.ts › follows a rename by the id the file carries, and sends no edit of the item for it`.

### `folders/id-missing-binding`

When a bound file is saved without its `marfa_id` line, a device MUST retain its item by its existing identity or path binding.

**Tests:** `device/folders-identity.test.ts › keeps the item when a save drops the id line`, `device/folders-identity.test.ts › keeps a binding for every file after a swap that also edits both`.

### `folders/id-minted`

When an unbound document has no usable item ID, a device MUST create it under a newly minted ID without a natural key or version.

**Tests:** `device/folders-identity.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folders/id-after-create`

When a document's create lands and its bytes have not changed since scan, a device MUST write the accepted `marfa_id` into the file.

**Tests:** `device/folders-identity.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folders/id-before-create`

While a document's create is unanswered, a device MUST preserve its existing file bytes.

**Tests:** `device/folders-identity.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folders/id-concurrent-save`

When a file changes after scan, a device MUST preserve the later save rather than writing metadata over it.

**Tests:** `device/folders-identity.test.ts › does not write back into a file changed since its scan`.

### `folders/id-not-property`

When a device sends a document create or edit, a device MUST omit `marfa_id` from the item properties.

**Tests:** `device/folders-identity.test.ts › keeps its id line out of what it sends the server`.

### `folders/id-removal-no-edit`

When a save only removes `marfa_id`, a device MUST NOT send an item edit.

**Tests:** `device/folders-identity.test.ts › sends nothing for a save that only drops the id line`.

### `folders/id-removal-restored`

When a save only removes `marfa_id`, a device MUST restore the ID line at the next pull.

**Tests:** `device/folders-identity.test.ts › sends nothing for a save that only drops the id line`.

### `folders/id-checkout`

When an unbound Markdown file names an existing document in the copy, a device MUST send its changes to that item rather than creating another.

**Tests:** `device/folders-identity.test.ts › sends a checked-out file's edits to the item its id names, and nothing for one in step`.

### `folders/id-vacated-path`

When a renamed file leaves its old path to a newly created file in the same scan, a device MUST create a separate item for the new file.

**Tests:** `device/folders-identity.test.ts › does not write a new file's body onto the item whose name it took`.

### `folders/atomic-editor-save`

When an editor replaces a bound file at the same path, a device MUST treat its changed content as an edit of the same item.

**Tests:** `device/folders-identity.test.ts › keeps an agent's whole-file rewrite the same item`.

### `folders/atomic-editor-unchanged`

When an editor replaces a bound file with equivalent content at the same path, a device MUST NOT create or edit an item for the replacement.

**Tests:** `device/folders-identity.test.ts › keeps an unchanged rewrite the same item`.

### `folders/atomic-editor-follow`

When an editor replaces a bound file at the same path and then renames it, a device MUST follow the replacement as the same item.

**Tests:** `device/folders-identity.test.ts › keeps an unchanged rewrite the same item`.

### `folders/copy-binding-precedence`

When files in one folder claim the same item ID, a device MUST prefer the file identified by the existing binding.

**Tests:** `device/folders-identity.test.ts › keeps the id with the file its binding names`, `device/folders-identity.test.ts › keeps the id with the original an editor saved without its line, over a copy carrying it`.

### `folders/copy-older-precedence`

When unbound files claim the same item ID and have distinct birth times, a device MUST prefer the file with the earlier birth time.

**Tests:** `device/folders-identity.test.ts › keeps the id with the older of two unbound files that carry it`.

### `folders/copy-new-item`

When a file copies another file's item ID, a device MUST create a separate item for the copy under a fresh ID, unless it is an old buffer of that item's file as `folders/moved-save-taken` says.

**Tests:** `device/folders-identity.test.ts › makes a copy a new item with a fresh id`, `device/folders-placement.test.ts › makes a later copy at the old name a new item, and leaves the note as it was`.

### `folders/copy-write-id`

When a copied document's create lands, a device MUST write the fresh ID into the copy.

**Tests:** `device/folders-identity.test.ts › makes a copy a new item with a fresh id`.

### `folders/copy-binding-kept`

While a copy still carries its original's ID line after its own create lands, a device MUST retain the copy's own binding even if the original file disappears.

**Tests:** `device/folders-identity.test.ts › keeps a copy its own item once the original goes, before its id line is rewritten`.

### `folders/id-unknown-new`

When an unbound document names an ID absent from the copy, a device MUST replace that ID with a fresh document ID on creation.

**Tests:** `device/folders-identity.test.ts › gives a fresh id to a file whose id names nothing`.

### `folders/id-system-ignored`

When an unbound document names a `system.*` item as its ID, a device MUST create a separate document item.

**Tests:** `device/folders-identity.test.ts › reads no id from a file naming the folder's own settings`.

### `folders/id-file-item-ignored`

When an unbound document names a file item as its ID, a device MUST create a separate document item.

**Tests:** `device/folders-identity.test.ts › reads no id from a .txt file or from a document naming a file item`.

### `folders/raw-text-body`

When a file has a `.txt` extension in any letter case, a device MUST treat its complete text as the document body without reading or writing frontmatter.

**Tests:** `device/folders-identity.test.ts › reads a .txt file that opens with a --- block as a body`, `device/folders-identity.test.ts › reads a .txt file whatever the case of its extension`, `device/folders-identity.test.ts › follows a rename by device, inode and birth time`.

### `folders/identity-rename`

When a file's unique filesystem identity survives a rename, a device MUST retain the same item.

**Tests:** `device/folders-identity.test.ts › follows a rename by device, inode and birth time`.

### `folders/identity-unusable`

When an unbound file has no unique usable filesystem identity, a device MUST treat it as new rather than infer a rename from another missing file.

**Tests:** `device/folders-identity.test.ts › treats a file with no usable identity as new rather than guessing`.

### `folders/identity-admitted-files`

When deciding whether file identities are unique, a device MUST consider only files the folder admits.

**Tests:** `device/folders-identity.test.ts › resolves identity over the files it holds, not every file in the tree`.

### `folders/identity-equivalent-save`

When a bound file is replaced with the same bytes and then renamed, a device MUST retain its item.

**Tests:** `device/folders-identity.test.ts › follows the rename of a file saved again with the same bytes`.

### `folders/identity-unread-rename`

When a renamed bound file has empty or unreadable bytes, a device MUST retain its item at the renamed path.

**Tests:** `device/folders-placement.test.ts › keeps a renamed file's item while its bytes are %s`.

### `folders/identity-unread-replacement`

When an unreadable renamed file leaves a replacement at its previous path, a device MUST preserve the renamed file's ownership of its item.

**Tests:** `device/folders-placement.test.ts › keeps unread rename ownership over a replacement at the old path: %s`.

### `folders/identity-placement-bytes`

When an unbound raw-text or file-item file matches the path and rendered bytes of an otherwise unbound item held by the search, a device MUST bind it to that item.

**Tests:** `device/folders-placement.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders-placement.test.ts › takes back an empty text file rendered from a missing body`.

### `folders/identity-takeback-search`

When a file matches the old placement and bytes of an item the search no longer holds, a device MUST create a new item for that file.

**Tests:** `device/folders-placement.test.ts › takes back by placement and bytes only an item its search holds`.

### `folders/identity-takeback-peer`

When another folder has taken in an item, a device MUST NOT take back that item for a copy at its former placement.

**Tests:** `device/folders-one-mac.test.ts › takes no file back by its bytes for an item another folder on the Mac took in`.

### `folders/watch-file-equivalence`

When equivalent new files are present at startup or arrive while watching, a device MUST create equivalent item types and content.

**Tests:** `device/folders-identity.test.ts › binds the same file to the same item whether it was present at start or arrived while running`.

### `folders/copy-birth-tie`

When unbound files claim one item ID and their birth times are equal, a device MUST give the item to the first file in path order.

**Tests:** `device/folders-contract-extra-c.test.ts › uses path order when copied IDs have the same birth time and no binding`.

### `folders/copy-identity-binding`

While another file keeps the ID carried in a copy's text, a device MUST retain the copy's own item when its binding identifies it at a new path.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps a copied file's own binding after it moves while its old ID has a keeper`.

### `folders/copy-delete-path-kept`

When a file is copied elsewhere and deleted from its bound path before a replacement appears there ahead of the next scan, a device MUST keep the replacement at the bound path as that item.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps the old path's replacement as the item after a copy-and-delete move`.

### `folders/identity-placement-different`

When an unbound raw-text or binary file at an item's placement contains different bytes from that item, a device MUST treat the file as a new item.

**Tests:** `device/folders-contract-extra-c.test.ts › makes a raw file with different bytes at an unbound placement a new item`, `device/folders-contract-extra-c.test.ts › makes a binary file with different bytes at an unbound placement a new item`.

## Placement

### `folders/placement-path`

When an item has an `in-folder` edge to the folder, a device MUST place its file at the edge's root-relative `path`.

**Tests:** `device/folders-placement.test.ts › places an item where its in-folder edge says, on every Mac`.

### `folders/placement-edge-type`

When another edge points to the folder's item, a device MUST NOT treat it as placement.

**Tests:** `device/folders-placement.test.ts › reads no other edge to the folder as a placement`.

### `folders/placement-remote-move`

When another device changes an item's placement path, a device MUST move the file to that path at the next pull.

**Tests:** `device/folders-placement.test.ts › places an item where its in-folder edge says, on every Mac`.

### `folders/placement-first-type`

When a newly encountered item has no placement, a device MUST derive its path from its title under the most specific first-placement type or ancestor, or the root if none matches.

**Tests:** `device/folders-placement.test.ts › places a new item from elsewhere under its type's first placement`, `device/folders-placement.test.ts › places a new item under the most specific first placement naming its type`.

### `folders/placement-create`

When a device gives an unplaced item a file, a device MUST create the item's `in-folder` edge with that path.

**Tests:** `device/folders-placement.test.ts › places a new item from elsewhere under its type's first placement`, `device/folders-placement.test.ts › writes the in-folder edge for a file made in the folder`, `device/folders-placement.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`.

### `folders/placement-checkout`

When a checked-out document is first bound, a device MUST place its item where the file sits.

**Tests:** `device/folders-placement.test.ts › places a checked-out file where it sits`.

### `folders/placement-rename-only`

When a file is moved or renamed without a content change, a device MUST send only its placement change, unless it is a Markdown document whose new name is not in step with its title (`folders/rename-title`) or a file item whose title is its old file name.

**Tests:** `device/folders-placement.test.ts › sends only the placement for a move under the same name`, `› sends only the placement for a rename of a document that is not Markdown`.

### `folders/placement-not-document`

When a device renders a file, a device MUST omit its `in-folder` edge from frontmatter and body links.

**Tests:** `device/folders-placement.test.ts › writes the in-folder edge for a file made in the folder`.

### `folders/placement-give-way-duplicate`

When another device's existing placement causes this device's placement create to be refused as a duplicate, a device MUST follow the accepted placement.

**Tests:** `device/folders-placement.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/fidelity.test.ts › matches the refusal of a second placement of one item in one folder`.

### `folders/placement-give-way-stale`

When another device's accepted placement causes this device's move to be refused as stale, a device MUST follow the accepted placement.

**Tests:** `device/folders-placement.test.ts › follows another Mac's move of the same file, giving its own way`, `› settles two Macs that rename one note's file for one new title`.

### `folders/placement-give-way-count`

When a device gives way to another device's placement, a device MUST count the result as `gave_way`.

**Tests:** `device/folders-placement.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/folders-placement.test.ts › follows another Mac's move of the same file, giving its own way`.

### `folders/placement-give-way-queue`

When a device gives way to another device's placement, a device MUST remove its obsolete refused or blocked placement writes from the queue.

**Tests:** `device/folders-placement.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/folders-placement.test.ts › follows another Mac's move of the same file, giving its own way`.

### `folders/placement-give-way-later`

When a folder drains while its queue holds one of its placement writes that the server answered as stale or refused as a duplicate, a device MUST give way to the server's placement in that drain, whichever drain the answer came in, unless that drain found the server unable to answer or was stopped by a refused credential, an earlier give-way read in that drain met an environmental failure, or a watch waits to read for that write again (`folders/placement-give-way-watch-throttled`).

**Reason:** a give-way whose read failed is finished by a later drain that can read the server, so the copy does not keep showing a move the server answered as stale. Against a server that is failing, each further read would wait out its own timeout.

**Tests:** `device/folders-placement.test.ts › finishes giving way at a later drain when the read it gives way from fails`, `› keeps a move it cannot give way from while the read is refused %i, and fails no drain`, `› follows the placement another Mac made first, and leaves no refusal behind`.

### `folders/placement-give-way-read-fails`

If the read a device gives way from fails with an environmental failure or is refused, then a device MUST keep the placement write in the queue as the server answered it, and the working copy as it was.

**Reason:** only a read of the server's placement says where the file goes. A read refused `403` or `404` can be answered once the key or the item changes, so the write stays where the person can see it, withdraw it (`queue-and-verdicts/withdraw-takes-out`) or discard it, and a later drain reads again (`folders/placement-give-way-later`).

**Tests:** `device/folders-placement.test.ts › finishes giving way at a later drain when the read it gives way from fails`, `› keeps a move it cannot give way from while the read is refused %i, and fails no drain`.

### `folders/placement-give-way-drain-goes-on`

If the read a device gives way from fails with an environmental failure or is refused, then a device MUST complete the folder's drain and report every verdict it reached.

**Reason:** one placement the server cannot or will not let it read does not stop the rest of the folder from syncing.

**Tests:** `device/folders-placement.test.ts › finishes giving way at a later drain when the read it gives way from fails`, `› keeps a move it cannot give way from while the read is refused %i, and fails no drain`.

### `folders/placement-give-way-newer-kept`

When a device gives way from moves of an `in-folder` edge that the server answered as stale, a device MUST keep in the queue each write to that edge queued after the last of those moves.

**Reason:** a move made after the copy heard of the other machine's placement is based on it, and is the person's latest word on where the file goes.

**Tests:** `device/folders-placement.test.ts › keeps a move made after the one it gives way from`.

### `folders/placement-give-way-watch`

While a watch holds a placement write whose give-way read failed, a device MUST read for it again at most once a minute.

**Reason:** a watch drains every second, and a read refused for good, made again at each drain, would spend the key's rate limit. The exact threshold needs a fixture-controlled clock.

**Tests:** waiting on #1890.

### `folders/placement-give-way-watch-throttled`

While a watch holds a placement write whose give-way read failed, a device MUST suppress repeated reads for it across successive passes.

**Tests:** `device/folders-placement.test.ts › reads for a placement it could not give way from again at most once a minute while watching`.

### `folders/placement-newer-copy`

When a device gives way to another machine's placement, a device MUST retain a newer placement already held in its working copy instead of replacing it with the older placement read from the server.

**Tests:** `device/folders-placement.test.ts › follows a move it heard of after the read it gives way from`.

### `folders/placement-give-way-atomic`

When a device gives way to another machine's placement, a device MUST expose the server's placement and withdrawal of its own placement writes as one change to the working copy.

**Reason:** A concurrent caller must not observe the withdrawn local move without the placement that replaces it.

**Tests:** waiting on #1890.

### `folders/placement-forget-unchanged`

When a placement read during giving way finds an edge missing from the server, a device MUST remove that edge from its working copy only if the edge has not changed in the copy since the read began.

**Tests:** waiting on #1890.

### `folders/placement-collision-order`

When several items claim one path, a device MUST rank existing placements by creation time and then edge ID, ahead of unplaced items.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders-placement.test.ts › gives a contested path to a placed item before an unplaced one, and to a file already there before a new one`, `device/folders-placement.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`, `device/folders-contract-extra-c.test.ts › orders equal-time placement collisions by edge ID`.

### `folders/placement-collision-number`

When an item cannot keep a contested path, a device MUST use the first available numbered sibling name after removing any existing number suffix.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders-placement.test.ts › counts the free number past a file on disk, a path another item is placed at, and its own file`.

### `folders/placement-collision-free`

When choosing a numbered sibling path, a device MUST exclude paths occupied by other files or reserved by other placements while allowing the item's own file.

**Tests:** `device/folders-placement.test.ts › counts the free number past a file on disk, a path another item is placed at, and its own file`.

### `folders/placement-collision-count`

When a pull assigns a numbered sibling path, a device MUST count the item as `beside`.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders-placement.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`.

### `folders/placement-collision-write`

When a pull assigns a numbered sibling path, a device MUST move the item's placement edge to that path.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders-placement.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`.

### `folders/placement-settles`

When devices have received the same accepted placements and settled path conflicts, a device MUST stop sending unchanged placements.

**Tests:** `device/folders-placement.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`, `› settles two Macs that rename one note's file for one new title`.

### `folders/placement-outside`

When a placement is excluded by the folder lists, is inside a package, contains `..` or escapes through a symbolic link, a device MUST count it `outside`.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders.test.ts › does not walk into a package`.

### `folders/placement-outside-no-write`

When a placement is excluded by the folder lists, contains `..`, or escapes through a symbolic link, a device MUST NOT write the file at that path.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`.

### `folders/placement-outside-edge-kept`

When a placement is outside the paths the folder writes, a device MUST leave the edge's path unchanged.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`.

### `folders/placement-unsuited`

When a placement extension would change a document into a non-document or a file item into another MIME type, a device MUST count it `unsuited`.

**Tests:** `device/folders-placement.test.ts › writes no file where its placement would make it another kind of file`.

### `folders/placement-unsuited-no-write`

When a placement would make a file another kind of item, a device MUST NOT write the file at that path.

**Tests:** `device/folders-placement.test.ts › writes no file where its placement would make it another kind of file`.

### `folders/placement-filesystem-failure`

When the filesystem refuses a placement, a device MUST count the affected item `unwritten`.

**Tests:** `device/folders-placement.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folders/placement-filesystem-keeps`

When the filesystem refuses a placement, a device MUST retain the file at its previous path.

**Tests:** `device/folders-placement.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folders/placement-filesystem-continues`

When the filesystem refuses one placement, a device MUST continue processing other files.

**Tests:** `device/folders-placement.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folders/placement-refusal-no-repeat`

While a refused placement's path, settings, key ID, grant, and prior placement remain unchanged, a device MUST NOT resend that placement.

**Tests:** `device/folders-placement.test.ts › sends a placement the server refused once, until the settings or the key change`, `device/folders-placement.test.ts › takes a key it could not read when a placement was refused as unchanged, and does not send the placement again`.

### `folders/placement-refusal-new-path`

When a file moves after its placement was refused, a device MUST try the new path.

**Tests:** `device/folders-placement.test.ts › sends a placement the server refused once, until the settings or the key change`.

### `folders/placement-key-push`

When a push holds a refused placement, a device MUST reread the key's current grant before deciding whether to retry.

**Tests:** `device/folders-placement.test.ts › sends a refused placement again once the key's grant is restored, and not while the key cannot be read`.

### `folders/placement-key-watch`

While a watch holds refused placements, a device MUST limit key rereads, including failed reads, to at most once per minute.

**Reason:** The exact one-minute threshold needs a fixture-controlled clock; real-time watch fixtures prove suppression between passes and eventual recovery.

**Tests:** waiting on #1890.

### `folders/placement-grant-restored`

When a watch observes that the placement grant has been restored, a device MUST retry the refused placement.

**Tests:** `device/folders-placement.test.ts › sends a refused placement again while watching, once the key's grant is restored, reading the key at most once a minute`.

### `folders/placement-key-unreadable`

When the key cannot be read, a device MUST treat it as unchanged for retrying refused placements.

**Tests:** `device/folders-placement.test.ts › sends a refused placement again once the key's grant is restored, and not while the key cannot be read`, `device/folders-placement.test.ts › takes a key it could not read when a placement was refused as unchanged, and does not send the placement again`.

### `folders/placement-refusal-cleared`

When a later placement for an item lands, a device MUST release that item's earlier placement refusal.

**Tests:** `device/folders-placement.test.ts › follows another Mac's move of an item whose move it was refused`, `device/folders-placement.test.ts › sends a refused move again once a later placement of the item lands`.

### `folders/purged-placement-refusal`

When a refused placement belongs to an item no longer held in the working copy, a device MUST stop reporting that placement as refused.

**Tests:** `device/folders-identity.test.ts › lets go of a refused placement once its item is purged`.

### `folders/placement-refused-file-kept`

While a file's placement move is refused, a device MUST leave the file at the person's chosen path.

**Tests:** `device/folders-placement.test.ts › keeps a file where the person moved it when the server refuses the move`.

### `folders/placement-unplaced-count`

When a pull holds refused placements, a device MUST report their count as `unplaced`.

**Tests:** `device/folders-placement.test.ts › sends a placement the server refused once, until the settings or the key change`.

### `folders/placement-watch-notice`

While a refused-placement count is unchanged, the CLI MUST NOT repeat its watch notice for each eventful pass.

**Tests:** `device/folders-placement.test.ts › says the placements it holds back once while watching`.

### `folders/placement-add-permission`

If a key lacks `edge.in-folder:write`, then the CLI MUST refuse `folders add` naming that permission.

**Tests:** `device/folders-placement.test.ts › names the permission a key without in-folder write lacks, when it is added`, `device/fidelity.test.ts › matches the key a folder asks about when it is added`.

### `folders/placement-add-cleanup`

When `folders add` is refused for lacking placement permission, a device MUST remove every directory and file it created for the failed add.

**Tests:** `device/folders-placement.test.ts › names the permission a key without in-folder write lacks, when it is added`.

### `folders/placement-add-cleanup-keeps`

When `folders add` is refused for lacking placement permission, a device MUST keep every directory and file that existed before the add.

**Reason:** A directory being added often already holds the person's files, or the empty state directory that removing a folder leaves.

**Tests:** `device/folders-placement.test.ts › names the permission a key without in-folder write lacks, when it is added`.

### `folders/placement-not-membership`

When evaluating folder membership, a device MUST use the search independently of whether an item has a placement edge to the folder.

**Tests:** `device/folders-placement.test.ts › does not let placement decide what it holds`.

### `folders/placement-current-path`

When an item has a file bound in the folder but no placement edge, a device MUST keep that file at its current path.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps an unplaced file at its checked-out path instead of its title`.

### `folders/placement-swap-waits`

When two remote placements swap paths occupied by each other's files, a device MUST leave both files unchanged.

**Tests:** `device/folders-contract-extra-c.test.ts › leaves both files intact when their remote placements swap`.

### `folders/placement-swap-count`

When two remote placements swap paths occupied by each other's files, a device MUST count both items as `unwritten`.

**Tests:** `device/folders-contract-extra-c.test.ts › leaves both files intact when their remote placements swap`.

### `folders/placement-move-publish-first`

If writing a moved file at its new placement fails, then a device MUST leave the file whole with the bytes it had, at its previous path where the rename that moves it has not been made and at its new path where it has.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps the moved file whole when writing it at its new placement fails, and leaves emptied directories after success`, `device/folders-placement.test.ts › keeps a file at its old path, whole, when the rename that moves it is refused`.

### `folders/placement-empty-directories`

When a file moves to a new placement, a device MUST retain the directories emptied by that move.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps the moved file whole when writing it at its new placement fails, and leaves emptied directories after success`.

### `folders/placement-add-non-key`

When `GET /keys/current` answers `403 forbidden` for a credential that is not a key, a device MUST allow folder addition without requiring a key's `in-folder` grant.

**Tests:** `device/folders-contract-extra-c.test.ts › accepts a non-key credential when the current-key door answers forbidden`.

### `folders/placement-key-watch-throttled`

When a watch cannot read the current key, a device MUST suppress repeated key requests across successive passes.

**Tests:** `device/folders-placement.test.ts › asks a key it could not read again at most once a minute while watching`.

## A document's name and its title

A Markdown document's file name and its item's title name one note. A file item keeps its title as `folders/binary-title-preserved` says.

### `folders/title-in-step`

When a device compares a Markdown document's file name with a title, a device MUST count them in step only where the title is not blank and the name, compared as `folders/name-comparison` says, is the one the device makes from the title with the file's extension, or that name numbered as `folders/placement-collision-number` numbers it.

**Reason:** a title that cannot be a file name as written, such as one holding `/` or `:`, is in step with the name made from it, so renaming the file to that name changes nothing, and a name in another Unicode form, as macOS can give, never reads as a change.

**Tests:** `device/folders-placement.test.ts › counts a name in another case, Unicode form or cleaned spelling as the title's`, `› sends no title for a rename to a name the title already makes, and the new name's for any other`, `› numbers the name a new title makes where another file has it`.

### `folders/rename-title`

When a person renames a Markdown document's file to a name not in step with the document's title, as its title line shows it or else as its item holds it, a device MUST send the new name without its extension as the item's title.

**Reason:** links resolve by a title or by a file name (`folders/edge-filename-read`, `folders/edge-lookup-title-field`), so a note whose name and title differ answers to two names.

**Tests:** `device/folders-placement.test.ts › sends a renamed note's new name as its title, and rewrites only its title line`, `› sends a rename and an edit of the body made in one pass together`, `› sends a renamed note's title alone where its file shows no title line`, `› sends no title for a rename to a name the title already makes, and the new name's for any other`, `› sends a title typed in the line, then the new name's, when a rename and a line edit come in one pass`.

### `folders/rename-typed-title-first`

When a person renames a Markdown document's file and, in the same save, changes its title line from the title the file last showed to another nonblank title not in step with the new name, a device MUST send the line's title before the new name's title.

**Reason:** both titles are the person's, so the item's history holds each, and the name's, the later, is the one the item keeps.

**Tests:** `device/folders-placement.test.ts › sends a title typed in the line, then the new name's, when a rename and a line edit come in one pass`.

### `folders/rename-title-line`

When a device sends a renamed Markdown document's new name as its title and the file, still holding the bytes the device read, has a title line, a device MUST rewrite that line to the new title and keep every other byte of the file.

**Tests:** `device/folders-placement.test.ts › sends a renamed note's new name as its title, and rewrites only its title line`.

### `folders/rename-title-wins`

When a person renames a Markdown document's file after its item's title changed elsewhere and before the device next syncs the folder, a device MUST send the new name as the item's title on the version the file last showed.

**Reason:** the rename is the later write. The server settles the two titles by the title property's merge policy (`types/merge-policy`, `versions/auto-resolved`), so where that is last-writer-wins, as it is for every type Marfa ships, the item takes the file's name, and the title it had stays in its history.

**Tests:** `device/folders-placement.test.ts › keeps a person's rename over a title changed in Marfa before it synced, heard of first: %s`, `› sends a renamed note's title alone on the version its file last showed`.

### `folders/title-renames-file`

When a pull finds that a bound Markdown document's item title changed to a nonblank title its file name is not in step with, and the name was in step with the title the file last showed or that title was blank, a device MUST rename the file within its directory to the name the device makes from the new title.

**Tests:** `device/folders-placement.test.ts › renames a note's file when its title changes in Marfa`, `› keeps the name when the title is made blank, and takes the next title's`.

### `folders/title-line-renames`

When the server takes a title a person typed in a bound Markdown document's title line, where the file's name is not in step with that title and was in step with the title the line showed before or that title was blank, a device MUST rename the file within its directory to the name the device makes from the new title.

**Reason:** another Mac hears of the edit as a title changed in Marfa and renames its file (`folders/title-renames-file`), so the Mac where the edit was made renames its own.

**Tests:** `device/folders-placement.test.ts › renames a note's file when its title line is changed in the file`.

### `folders/title-line-refused-kept`

If the server refuses the edit that carries a title typed in a document's title line, then a device MUST NOT move the item's placement or the file for that title.

**Reason:** a placement moved for a title the item never took would leave every Mac's file named after a title the item does not have.

**Tests:** `device/folders-placement.test.ts › keeps a note's name and placement when the server refuses its edited title line`.

### `folders/title-rename-answered`

While a document's item has a write this copy has not had answered, a device MUST NOT rename its file to follow its item's title.

**Reason:** the title the copy shows until then is one the server may still refuse.

**Tests:** `device/folders-placement.test.ts › renames a note's file when its title line is changed in the file`.

### `folders/title-rename-placement`

When a device renames a file to follow its item's title, a device MUST move the item's placement to the new path.

**Tests:** `device/folders-placement.test.ts › renames a note's file when its title changes in Marfa`, `› renames a note's file when its title line is changed in the file`.

### `folders/title-rename-refused-placement`

If the rename that follows an item's title is refused, then a device MUST leave the item's placement at the path its file keeps.

**Tests:** `device/folders-placement.test.ts › keeps the placement at the old name when the rename for a new title is refused`.

### `folders/title-rename-refused-once`

When the file system refuses the rename that follows an item's title, a device MUST NOT try that rename again while the folder stays open and the item's title and placement are unchanged.

**Reason:** a volume that refuses such renames refuses them every time, and each try moves the placement and back, which a watch would repeat at every pass.

**Tests:** `device/folders-placement.test.ts › asks a volume that refused the rename for a new title once, not at every pass of a watch`.

### `folders/title-rename-numbered`

When the name the device makes from a document's new title is taken by another file or by another item's placement, a device MUST rename the file to the first free name numbered as `folders/placement-collision-number` numbers it.

**Tests:** `device/folders-placement.test.ts › numbers the name a new title makes where another file has it`.

### `folders/title-rename-outside`

If the name the device makes from a document's new title is a path the folder does not write at, then a device MUST NOT rename the file.

**Reason:** the file goes on being written under the name it has, rather than left unwritten at a path the folder's lists leave out.

**Tests:** `device/folders-placement.test.ts › keeps the name of a note whose new title names a path the folder leaves out`.

### `folders/title-blank-keeps-name`

When a Markdown document's item title changes to a blank title, a device MUST NOT rename its file.

**Tests:** `device/folders-placement.test.ts › keeps the name when the title is made blank, and takes the next title's`.

### `folders/title-drift-kept`

If a bound Markdown document's file name is not in step with the nonblank title the file last showed, then a device MUST NOT rename the file when its item's title changes.

**Reason:** a name that already differs from the title is one the device cannot tell from a choice, so only a rename by the person, which sets the title (`folders/rename-title`), brings the two back in step.

**Tests:** `device/folders-placement.test.ts › keeps the name of a note whose name was not its title`.

### `folders/title-held-not-renamed`

While a device holds a bound document's change unsent, a device MUST NOT rename its file to follow its item's title.

**Tests:** `device/folders-placement.test.ts › keeps the name of a file it holds for a refused change, and renames it once the change is taken`.

### `folders/move-by-rename`

When a pull moves a bound file whose bytes are still the ones it is bound to, a device MUST move it with a rename that replaces nothing, and its item's placement with it, before writing new bytes over it.

**Reason:** an editor holding the file follows a rename, where it would lose a file written anew and deleted at its old path.

**Tests:** `device/folders-placement.test.ts › moves a note's file by a rename when its title changes, so an editor holding it follows`, `› moves a file by a rename when another Mac moves its placement`.

### `folders/moved-save-taken`

When a file appears at the path a pull last moved an item's file away from, carrying that item's ID and a version line no newer than the item's version when the pull moved it, while the item's file holds no change the device has not read and is neither held nor refused, a device MUST put the file in the item's file's place, replacing nothing, and send it as a save of an old copy of that file.

**Reason:** it is an editor's save of the buffer it held before the move, and as a new item it would be a second note holding the person's edit.

**Tests:** `device/folders-placement.test.ts › takes an old buffer saved where another Mac moved the file from as a save of its note, never a new item`, `device/folders-placement.test.ts › takes an old buffer saved at the name a retitle moved its file from as a stale save of its note`.

### `folders/moved-save-held`

When a file appears at the path a pull last moved an item's file away from, carrying that item's ID and a version line no newer than the item's version when the pull moved it, while the item's file holds a change the device has not read, or one it holds unsent or refused, a device MUST hold the file, flagged `waiting`, without making an item of it, until the person changes or removes that file.

**Reason:** the person decides which of the two to keep, however the item's file changes meanwhile.

**Tests:** `device/folders-placement.test.ts › holds an old buffer saved at the old name while the moved file holds an edit of its own, and makes no new item`, `› holds an old buffer saved at the old name while the moved file holds a refused edit, and keeps that edit`, `› holds an old buffer until the person changes that file, whatever the moved file does`.

### `folders/moved-save-race`

If an item's file is saved while a device puts an old buffer in its place, then a device MUST keep that save in the item's file and hold the old buffer, flagged `waiting`.

**Tests:** `device/folders-placement.test.ts › keeps a save made to the moved file while an old buffer is taken over it`.

### `folders/moved-save-kept-beside`

If another file takes an item's file's path while a device puts an old buffer in its place, and the item's file was saved meanwhile, then a device MUST move that save to the first free numbered name beside the path, as `folders/placement-collision-number` numbers it.

**Reason:** the save is the person's, and a name the folder treats as its own scratch would lose it.

**Tests:** `device/folders-placement.test.ts › keeps a save made to the moved file under a numbered name where another file took its path meanwhile`.

### `folders/moved-save-not-missing`

When a device puts an old buffer in an item's file's place, a device MUST NOT count the item's file missing.

**Tests:** `device/folders-placement.test.ts › counts nothing missing when it finishes taking an old buffer after a crash`.

### `folders/moved-save-ends`

When a person edits or moves the file a pull moved, a device MUST treat a later file at the path it was moved from as `folders/copy-new-item` says.

**Reason:** a file made there after the person worked on the moved file is the person's own, not an old buffer of it.

**Tests:** `device/folders-placement.test.ts › makes an old buffer saved at the old name a new item once the moved file was edited`.

## Ending a placement

### `folders/placement-end-departure`

When a file leaves a folder because its item was trashed or left the search's states, a device MUST delete that folder's `in-folder` edge for the item.

**Tests:** `device/folders-identity.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `device/folders-identity.test.ts › ends a folder's placement of an item that leaves by state, and places it again when it returns`, `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folders/placement-end-transfer`

When a file transfers to another folder on the machine and its original folder's search no longer holds its item, a device MUST delete the original folder's `in-folder` edge for the item.

**Tests:** `device/folders-one-mac.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `cli/folder.test.ts › ends a folder's placement of an item whose file another folder took in, and no sooner`.

### `folders/placement-end-delete`

When a scan sends a missing file's item deletion or finds its item already trashed, a device MUST delete that folder's `in-folder` edge for the item.

**Tests:** `device/folders-identity.test.ts › ends a folder's placement of an item whose file the person deleted`, `device/folders-contract-c-retry.test.ts › ends the placement of a missing file already trashed on another device`.

### `folders/placement-last-binding`

While another file in the folder remains bound to an item, a device MUST NOT end that folder's placement of the item.

**Tests:** waiting on #1890.

### `folders/placement-end-retry`

If ending a departing file's placement fails locally, then a device MUST retain the file's binding so a later pass can retry ending the placement.

**Tests:** `device/folders-identity.test.ts › keeps the file and the placement where ending the placement fails, and ends it at the next push`, `device/folders-identity.test.ts › keeps the binding of a deleted file where ending its placement fails, and ends it at the next push`, `device/folders-one-mac.test.ts › leaves the binding of a file it let go where ending the placement fails, and the scan ends it past the grace`.

### `folders/placement-purge-no-delete`

When an item's purge removes its placement from the working copy, a device MUST NOT send a separate deletion of that placement.

**Tests:** `device/folders-identity.test.ts › sends nothing to end the placement of a purged item, which the purge took with it`.

### `folders/placement-held-transfer`

When a file moves to a folder that does not hold its item but its original folder's search still holds the item, a device MUST retain the original folder's placement.

**Tests:** `device/folders-one-mac.test.ts › keeps a folder's placement of an item it holds when its file is moved to a folder that does not`.

### `folders/placement-unmatched-kept`

While a folder retains an item's file as `unmatched`, a device MUST retain that folder's placement of the item.

**Tests:** `device/folders-identity.test.ts › keeps a folder's placement of an item whose file stays where it is`.

### `folders/placement-restore-new`

When a folder's search holds an item again after its placement ended, a device MUST place the item using the current first-placement setting or title as for a new item.

**Tests:** `device/folders-identity.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folders/placement-end-count`

When a pull queues the end of a placement, a device MUST count that end in the pull report's `ended` field.

**Tests:** `device/folders-one-mac.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `device/folders-identity.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `device/folders-identity.test.ts › ends a folder's placement of an item that leaves by state, and places it again when it returns`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folders/placement-end-same-push`

When a folder sync's pull ends a placement, a device MUST send that end in the same sync unless `folders/push-server-unavailable`, `folders/push-credential-stopped` or `folders/push-undelivered` prevents a further drain.

**Tests:** `device/folders-one-mac.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `device/folders-identity.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`.

### `folders/placement-end-already-gone`

When the server answers a placement's deletion with `edge_not_found`, a device MUST treat that placement as ended.

**Tests:** `device/folders-identity.test.ts › takes the end of a placement another machine ended first as done`.

### `folders/placement-end-refused-queue`

When the server refuses a placement's deletion for the key's grant, a device MUST retain the refused deletion in the queue.

**Tests:** `device/folders-identity.test.ts › asks once for the end of a placement the server refuses, and reports it`.

### `folders/placement-end-refused-once`

While a refused placement deletion remains in the queue, a device MUST NOT queue another deletion of the same placement.

**Tests:** `device/folders-identity.test.ts › asks once for the end of a placement the server refuses, and reports it`.

## File writes and recovery

### `folders/write-no-echo`

When a scan follows a device's own file write, a device MUST NOT treat that write as a user create or edit.

**Tests:** `device/folders-placement.test.ts › does not read its own writes back as changes`.

### `folders/write-whole`

When a device writes a document, file item, settings file or file transferred from another folder, a device MUST publish complete bytes or leave the previous file intact.

**Tests:** `device/folders-identity.test.ts › writes a file whole beside it and renames it over, so a failed write leaves the old one`, `device/folders-one-mac.test.ts › keeps a file a crash cut off taking in where it was, and journals no delete`, `device/folders-identity.test.ts › keeps its settings file its own when a crash cuts off writing it`, `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`.

### `folders/write-attributes`

When a device replaces an existing file, a device MUST retain its supported extended attributes.

**Tests:** `device/folders-identity.test.ts › writes a file whole beside it and renames it over, so a failed write leaves the old one`.

### `folders/write-crash-no-edit`

When a file write crashes before its new bytes land, a device MUST NOT send the previous file content as a user edit during recovery.

**Tests:** `device/folders-identity.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`, `device/folders-identity.test.ts › restores a styled file's agreement after a pull crashes before landing`.

### `folders/write-crash-new-no-delete`

When a new file write crashes before the file lands, a device MUST NOT journal that absent file as a user deletion.

**Tests:** `device/folders-identity.test.ts › journals no delete for a new file a crash cut off writing`.

### `folders/write-crash-status`

When a write crashes before replacing an unchanged existing file, the CLI MUST report that file as `in_step` during recovery.

**Tests:** `device/folders-identity.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`.

### `folders/write-crash-temporary-cleanup`

When a crashed writer is no longer running, a device MUST remove its abandoned temporary files at the next scan.

**Tests:** `device/folders-identity.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`.

### `folders/write-crash-take-in`

When taking in another folder's file crashes before landing, a device MUST preserve the source file without journaling a deletion.

**Tests:** `device/folders-one-mac.test.ts › keeps a file a crash cut off taking in where it was, and journals no delete`.

### `folders/write-crash-settings`

When a settings-file write crashes before landing, a device MUST retain the old file as its own prior write rather than send it as an edit.

**Tests:** `device/folders-identity.test.ts › keeps its settings file its own when a crash cuts off writing it`.

### `folders/write-editor-race`

When a person changes a file before a pull's final check, a device MUST preserve that save instead of overwriting, removing, or letting go of the file.

**Tests:** `device/folders-identity.test.ts › leaves a file it would take away or rewrite where the person saved it meanwhile`, `device/folders-placement.test.ts › keeps a save made while a move writes the file, in the moved file`, `device/folders-one-mac.test.ts › leaves a file it let go where the person saved it meanwhile`.

### `folders/write-new-target-race`

When a file appears after an absent target was checked, a device MUST leave the appearing file untouched.

**Tests:** `device/folders-identity.test.ts › keeps a file that appears after an absent landing target was checked`.

### `folders/write-failure-binding`

When a replacement landing fails, a device MUST retain the previous item's binding and deletion journal at that path.

**Tests:** `device/folders-placement.test.ts › restores another item's binding and journal when a landing fails`.

### `folders/write-render-report`

When a document cannot be rendered safely, a device MUST report its path, item, and reason in `flagged`.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/write-render-continues`

When one document cannot be rendered safely, a device MUST continue writing other documents.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/write-settings-failure`

When a settings file cannot be written, a device MUST report `settings.unwritten`.

**Tests:** `device/folders-identity.test.ts › reports a settings file it cannot write, and goes on`.

### `folders/write-settings-continues`

When a settings file cannot be written, a device MUST continue the folder pass.

**Tests:** `device/folders-identity.test.ts › reports a settings file it cannot write, and goes on`.

### `folders/write-permissions`

When a device replaces an existing file, a device MUST retain its permission bits except where the item's executable property requires changing executable bits.

**Tests:** `device/folders-contract-extra-c.test.ts › preserves a replaced file's permission bits`.

### `folders/write-live-temporary`

While the process that owns a temporary publication file is running, a device MUST NOT remove that temporary file during scan cleanup.

**Tests:** `device/folders-contract-extra-c.test.ts › retains temporary files owned by a live process while cleaning an abandoned one`.

### `folders/write-no-replace-unavailable`

If atomic no-replace publication is unavailable for an absent target, then a device MUST fail that write without falling back to a replacing rename.

**Tests:** `device/folders-contract-extra-c.test.ts › fails an unsupported no-replace publication safely and succeeds once it is available`.

### `folders/write-no-replace-recovery`

When atomic no-replace publication becomes available after a failed write, a device MUST retry the file at a later pull.

**Tests:** `device/folders-contract-extra-c.test.ts › fails an unsupported no-replace publication safely and succeeds once it is available`.

### `folders/write-render-unwritten`

When a document cannot be rendered safely, a device MUST count it `unwritten`.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/write-read-only`

When an existing file is read-only, a device MUST leave it unchanged during a pull.

**Tests:** `device/folders-contract-a.test.ts › keeps a read-only document unchanged when another device changes its item`.

## Deletion, purges and missing directories

### `folders/delete-grace`

When a bound file disappears, a device MUST defer its item deletion for the five-second rename grace.

**Reason:** The exact grace boundary requires a fixture-controlled clock; real-time fixtures assert deferral and cancellation but not the threshold.

**Tests:** waiting on #1890.

### `folders/delete-rename-cancels`

When a file returns at its own path or a new name within the rename grace, a device MUST cancel its journaled deletion.

**Tests:** `device/folders-placement.test.ts › takes the old path out of the journal when the file comes back under a new name`, `device/folders-placement.test.ts › takes a file out of the journal when it comes back under its own name`, `device/folders-placement.test.ts › defers a delete past the rename grace`.

### `folders/delete-remote-revives`

When another device changes a deleted item in content its file shows during the rename grace, a device MUST restore the file from the changed item.

**Tests:** `device/folders-identity.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`.

### `folders/delete-revived-cancels`

When a deleted file is revived by a visible remote change, a device MUST cancel its journaled deletion.

**Tests:** `device/folders-identity.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`.

### `folders/delete-revived-count`

When a deleted file is revived by a visible remote change, a device MUST count it `revived`.

**Tests:** `device/folders-identity.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`.

### `folders/delete-unshown-change`

When a deleted item advances in version without changing content its file shows, a device MUST retain the journaled deletion.

**Tests:** `device/folders-identity.test.ts › sends a person's delete of a file whose item moved on elsewhere in nothing the file shows`, `device/folders-identity.test.ts › keeps a deleted raw-text file gone after a version step even when its body looks like YAML`.

### `folders/delete-path-reused`

When another item takes a deleted file's path, a device MUST retain the original item's journaled deletion.

**Tests:** `device/folders-placement.test.ts › keeps a person's journaled delete when another item is placed at its path`.

### `folders/delete-left-by-state`

When a locally deleted item leaves the folder search by state during the grace, a device MUST send its deletion after the grace.

**Tests:** `device/folders-identity.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folders/delete-already-trashed`

When a locally deleted item is already trashed, a device MUST NOT send another item deletion.

**Tests:** `device/folders-identity.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folders/delete-at-startup`

When a tracked file is absent at startup, a device MUST journal its deletion as it would a file removed while running.

**Tests:** `device/folders-placement.test.ts › journals a delete that happened while it was not running`.

### `folders/root-gone-no-delete`

While the folder directory is missing or replaced by another directory, a device MUST NOT trash its items because the original files cannot be read.

**Tests:** `device/folders-identity.test.ts › trashes nothing while its directory is gone, and says so`, `device/folders-identity.test.ts › reads, writes and trashes nothing in a copy put in its directory's place`.

### `folders/root-gone-watch`

While the folder directory is missing, the CLI MUST report that the directory cannot be found.

**Tests:** `device/folders-identity.test.ts › trashes nothing while its directory is gone, and says so`.

### `folders/root-gone-watch-continues`

While the folder directory is missing, the CLI MUST keep the watch running.

**Tests:** `device/folders-identity.test.ts › trashes nothing while its directory is gone, and says so`.

### `folders/root-return-watch`

When the folder directory returns, a device MUST resume the running watch's work.

**Tests:** `device/folders-identity.test.ts › trashes nothing while its directory is gone, and says so`.

### `folders/root-no-recreate`

When the root directory disappears during a pull, a device MUST NOT recreate it.

**Tests:** `device/folders-identity.test.ts › does not make its directory anew when it goes away during a pull`.

### `folders/root-write-count`

When the root directory disappears before a file write, a device MUST count the blocked write `unwritten`.

**Tests:** `device/folders-identity.test.ts › does not make its directory anew when it goes away during a pull`.

### `folders/walk-directory-gone`

When a directory disappears during the walk, a device MUST report it in `directories` with flag `gone`.

**Tests:** `device/folders-identity.test.ts › journals no missing file in a pass a directory went away from while it was walked`.

### `folders/walk-gone-no-journal`

When a folder inventory is incomplete because an entry cannot be read or identified, a device MUST NOT journal missing files from that incomplete inventory.

**Tests:** `device/folders-identity.test.ts › journals no missing file in a pass a directory went away from while it was walked`.

### `folders/root-gone-scan-report`

When a scan detects that the directory has been replaced since the folder was opened, a device MUST report the reason in `root_gone`.

**Tests:** `device/folders-contract-a.test.ts › reports root_gone and ignores a replacement directory while watching`.

### `folders/root-gone-no-replacement-edit`

While the opened folder's directory is replaced by a different directory, a device MUST NOT send item or settings edits read from that replacement.

**Tests:** `device/folders-contract-a.test.ts › reports root_gone and ignores a replacement directory while watching`.

### `folders/root-gone-no-replacement-write`

While the opened folder's directory is replaced by a different directory, a device MUST leave the replacement's files unchanged.

**Tests:** `device/folders-contract-a.test.ts › reports root_gone and ignores a replacement directory while watching`.

### `folders/root-gone-pull-report`

When a pull detects that the root directory disappeared or was replaced after the folder was opened, a device MUST report the reason in `root_gone`.

**Tests:** waiting on #1890.

### `folders/root-gone-command-refusal`

When the folder directory is missing, the CLI MUST refuse `folders status`, `folders confirm`, and `folders restore` with the reason.

**Tests:** `device/folders-contract-a.test.ts › refuses status and removal decisions while the folder directory is missing`.

### `folders/walk-gone-no-deletion`

When a folder inventory is incomplete because an entry cannot be read or identified, a device MUST defer already journaled item deletions until a complete walk succeeds.

**Tests:** `device/folders-contract-a.test.ts › sends no journaled deletion from an incomplete walk and resumes after a complete walk`, `device/folders-one-mac.test.ts › holds cross-directory moves and older deletions behind an unidentified %s`.

### `folders/walk-prior-directory-removal`

When a directory was deleted before a walk began, a device MUST journal its tracked files as missing.

**Tests:** `device/folders-contract-a.test.ts › journals files from a directory removed before the walk begins`.

### `folders/delete-trashed-status`

When a locally missing file's item has already been trashed elsewhere, the CLI MUST report that file as waiting on `scan` rather than `delete`.

**Tests:** `device/folders-contract-a.test.ts › reports a locally missing item already trashed elsewhere as waiting on scan`.

### `folders/delete-missing-not-pull-removal`

When a pull encounters files already deleted locally, a device MUST exclude those absent files from its `removed` and `kept` counts.

**Tests:** `device/folders-contract-a.test.ts › reports a locally missing item already trashed elsewhere as waiting on scan`.

### `folders/purged-file-remove`

When a catch-up has applied an item's purge, its file's path remains admitted, its bytes remain those the device wrote, and no large-removal pause applies (`folders/pull-removal-paused`), a device MUST remove that file at the next pull where the filesystem permits removal.

**Tests:** `device/folders-identity.test.ts › removes a purged item's file where its bytes are the folder's own, and says so`.

### `folders/purged-file-count`

When a pull removes a purged item's file, a device MUST count that file in both `removed` and `purged`.

**Tests:** `device/folders-identity.test.ts › removes a purged item's file where its bytes are the folder's own, and says so`.

### `folders/purged-edit-preserve`

When a purged item's file has changed since the device last wrote it, a device MUST preserve that file during a pull.

**Tests:** `device/folders-identity.test.ts › keeps a purged item's file the person changed since the folder wrote it, and says so`.

### `folders/purged-edit-count`

When a pull preserves a purged item's changed file, a device MUST count that file as `kept`.

**Tests:** `device/folders-identity.test.ts › keeps a purged item's file the person changed since the folder wrote it, and says so`.

### `folders/purged-removal-report`

When `folders pull` or `folders watch` reports removed files, the CLI MUST distinguish files removed because their items were purged from files removed because their items were trashed or left by state.

**Tests:** `device/folders-identity.test.ts › says in words that a purged item's file was removed`, `device/folders-identity.test.ts › says while watching that a purged item's file was removed`.

## Paths, links and files

### `folders/placement-root-relative`

When a device reads a folder placement path, a device MUST resolve the path from the folder root after discarding leading separators, empty components and `.` components.

**Tests:** `device/folders-placement.test.ts › reads a placement path with a leading separator from the folder's root`.

### `folders/parent-component-refused`

When a folder placement contains a `..` component, a device MUST report the item as `outside` even when the path would return inside the folder.

**Tests:** `device/folders-contract-b.test.ts › refuses every parent component in a placement even when it climbs back inside`.

### `folders/parent-component-refused-file-unwritten`

When a folder placement contains a `..` component, a device MUST NOT write the item’s file even when the path would return inside the folder.

**Tests:** `device/folders-contract-b.test.ts › refuses every parent component in a placement even when it climbs back inside`.

### `folders/symlink-write-refused`

When a folder placement traverses a symbolic link, a device MUST report the item as `outside`.

**Tests:** `device/folders.test.ts › refuses to write a file outside the folder`.

### `folders/symlink-write-refused-target-preserved`

When a folder placement traverses a symbolic link, a device MUST NOT write through the link.

**Tests:** `device/folders.test.ts › refuses to write a file outside the folder`.

### `folders/symlink-scan-excluded`

When a folder scan encounters a symbolic link to a file or directory, a device MUST NOT admit that link.

**Tests:** `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`.

### `folders/symlink-not-traversed`

When a folder scan encounters a symbolic link to a file or directory, a device MUST NOT traverse the link’s target.

**Tests:** `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`.

### `folders/body-link-removal`

When a folder document removes a body link it previously carried and no frontmatter reference still names that item, a device MUST queue deletion of the corresponding `references` edge.

**Tests:** `device/folders.test.ts › takes the edge with a link the body no longer names`.

### `folders/unseen-reference-kept`

When a folder document is scanned before a `references` edge has ever appeared in its file, a device MUST NOT delete that edge because the file does not name it.

**Tests:** `device/folders.test.ts › keeps an edge the file never carried, whoever made it`.

### `folders/other-edge-kind-kept`

When a folder document removes a body link, a device MUST NOT delete an edge of a kind other than `references` merely because it connects the same items.

**Tests:** `device/folders.test.ts › keeps an edge of a kind it could not have made`.

### `folders/unresolved-removals-held`

While a folder document contains an unresolved body link, a device MUST defer every `references` edge removal from that document.

**Tests:** `device/folders.test.ts › removes no edge at all when a link in the body names nothing`, `device/folders-frontmatter.test.ts › reports missing body links and preserves removals until all links resolve`.

### `folders/deferred-removals-retried`

When every remaining body link in a folder document resolves after reference removals were deferred, a device MUST queue the deferred removals.

**Tests:** `device/folders.test.ts › removes no edge at all when a link in the body names nothing`, `device/folders.test.ts › remembers a link it stood down over, so a later removal still lands`, `device/folders-frontmatter.test.ts › reports missing body links and preserves removals until all links resolve`.

### `folders/body-reference-not-repeated`

When a folder pull renders a `references` edge already represented by a body link, a device MUST NOT repeat that reference in frontmatter.

**Tests:** `device/folders.test.ts › takes the edge with a link the body no longer names`.

### `folders/unowned-path-preserved`

When a folder pull encounters a file at an item’s placement whose bytes it cannot adopt as that unbound item’s rendered bytes, a device MUST leave the file untouched.

**Tests:** `device/folders.test.ts › does not write over a file it never wrote`.

### `folders/unowned-path-preserved-unwritten-count`

When a folder pull encounters a file at an item’s placement whose bytes it cannot adopt as that unbound item’s rendered bytes, a device MUST report the item as `unwritten`.

**Tests:** `device/folders.test.ts › does not write over a file it never wrote`.

### `folders/rendered-file-adopted`

When an unbound folder item’s placement already holds exactly its rendered bytes, a device MUST bind the existing file to that item.

**Tests:** `device/folders.test.ts › takes back a file of its own the mapping had lost`, `device/folders-placement.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders-placement.test.ts › takes back an empty text file rendered from a missing body`.

### `folders/rendered-file-adopted-bytes-unchanged`

When an unbound folder item’s placement already holds exactly its rendered bytes, a device MUST NOT rewrite the existing file.

**Tests:** `device/folders.test.ts › takes back a file of its own the mapping had lost`, `device/folders-placement.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders-placement.test.ts › takes back an empty text file rendered from a missing body`.

### `folders/unowned-file-admitted`

When a folder scan encounters an unbound file whose bytes differ from the item that wanted its path, a device MUST admit the file as a new item.

**Tests:** `device/folders.test.ts › does not write over a file it never wrote`.

### `folders/same-scan-link-resolution`

When files arriving in the same folder scan name one another in links or frontmatter edge lines, a device MUST resolve those names against all files admitted by that scan.

**Tests:** `device/folders.test.ts › makes an edge between two files that arrive together`.

### `folders/new-search-member`

When an item starts matching a folder’s search through a tag, property, state, edge or `beneath` change received by the copy, a device MUST write its file at the next pull.

**Tests:** `device/folders.test.ts › adds an item that starts to match`.

### `folders/departed-file-removed`

When an item is trashed or leaves the states held by a folder's search, its file is not required by an embedding document, its path remains admitted, its bytes remain those the device wrote, and no large-removal pause applies (`folders/pull-removal-paused`), a device MUST remove that file at the next pull where the filesystem permits removal.

**Tests:** `device/folders-identity.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item that leaves by state`.

### `folders/departed-binding-released`

When a folder pull removes a departed item’s file, a device MUST release the file’s binding.

**Tests:** `device/folders-identity.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item that leaves by state`.

### `folders/departed-item-not-deleted`

When a folder pull removes a departed item’s file, a device MUST NOT queue deletion of the item.

**Tests:** `device/folders-identity.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item that leaves by state`.

### `folders/restored-file-written`

When a trashed item is restored into a folder’s search, a device MUST write its file at the next pull.

**Tests:** `device/folders-identity.test.ts › removes a trashed item's file and brings it back on restore`.

### `folders/missing-departure-not-pulled`

When a departed folder item’s file is already missing from disk, a device MUST leave its deletion for the scan rather than count it as removed by the pull.

**Tests:** `device/folders-identity.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folders/returned-file-journal-cleared`

When a folder pull removes a departed item’s file that returned after its deletion was journaled, a device MUST clear that journal entry.

**Tests:** `device/folders-identity.test.ts › takes away a file put back after its delete was journaled, once its item leaves by state, and sends no delete`.

### `folders/returned-item-not-deleted`

When a folder pull removes a departed item’s file that returned after its deletion was journaled, a device MUST NOT queue deletion of the item.

**Tests:** `device/folders-identity.test.ts › takes away a file put back after its delete was journaled, once its item leaves by state, and sends no delete`.

### `folders/departed-edited-file-kept`

When a departed folder item’s file contains bytes changed since the folder wrote it, a device MUST preserve the file.

**Tests:** `device/folders-identity.test.ts › keeps a file the person changed after its item left, and says so`, `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/departed-edited-file-kept-kept-count`

When a departed folder item’s file contains bytes changed since the folder wrote it, a device MUST count the file as `kept`.

**Tests:** `device/folders-identity.test.ts › keeps a file the person changed after its item left, and says so`, `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/departed-unreadable-file`

When a folder pull cannot read a departed item’s file to verify its bytes, a device MUST preserve the file.

**Tests:** `device/folders-identity.test.ts › holds the file of an item that leaves by state where it cannot be read, and does not call it kept`.

### `folders/departed-unreadable-file-unwritten-count`

When a folder pull cannot read a departed item’s file to verify its bytes, a device MUST count the item as `unwritten` rather than `kept`.

**Tests:** `device/folders-identity.test.ts › holds the file of an item that leaves by state where it cannot be read, and does not call it kept`.

### `folders/unmatched-file-kept`

When an item leaves a folder’s search for a reason other than its state or purge and no other folder takes its file, a device MUST retain the bound file.

**Tests:** `device/folders-identity.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders-identity.test.ts › keeps the file of an item a narrowed search leaves out, flagged, and sends its edits to it`, `device/folders-identity.test.ts › keeps the file of an item retyped out of its search elsewhere, flagged, and sends its edits to it`.

### `folders/unmatched-file-kept-unmatched-count`

When an item leaves a folder’s search for a reason other than its state or purge and no other folder takes its file, a device MUST count the file as `unmatched`.

**Tests:** `device/folders-identity.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders-identity.test.ts › keeps the file of an item a narrowed search leaves out, flagged, and sends its edits to it`, `device/folders-identity.test.ts › keeps the file of an item retyped out of its search elsewhere, flagged, and sends its edits to it`.

### `folders/unmatched-file-edits`

When a bound folder file’s item no longer matches the search, a device MUST continue sending edits to that item.

**Tests:** `device/folders-identity.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders-identity.test.ts › keeps the file of an item a narrowed search leaves out, flagged, and sends its edits to it`, `device/folders-identity.test.ts › keeps the file of an item retyped out of its search elsewhere, flagged, and sends its edits to it`.

### `folders/unmatched-file-updated`

When a bound unmatched folder item changes, a device MUST keep its existing file current under the same preservation rules as a search member’s file.

**Tests:** `device/folders-identity.test.ts › keeps an unmatched file current, so its second edit keeps another device's change`.

### `folders/replaced-binding-unpinned`

When another item takes a bound folder file’s path, a device MUST release the old item’s binding pin unless another file or edge still requires it.

**Tests:** `device/folders-identity.test.ts › lets go of the pin of an item whose file's path another item takes`.

### `folders/embedded-archive-kept`

When an embedded file item becomes archived outside the folder’s search, a device MUST keep its file while a document still embeds it.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`, `device/folders-frontmatter.test.ts › keeps an embedded file archived elsewhere where its search holds active items only`.

### `folders/binary-created`

When a nonempty non-document file is admitted by a folder’s search or an embed, a device MUST create a file item typed from its MIME type whose create waits for the bytes’ upload.

**Tests:** `device/folders-placement.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`, `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folders/binary-edited`

When the bytes of a bound file item change in a folder, a device MUST queue an upload followed by an item update naming the new bytes regardless of the file’s extension.

**Tests:** `device/folders-placement.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`, `device/folders-placement.test.ts › sends an edited file item named like a document as bytes`.

### `folders/binary-title-preserved`

When a bound folder file item is renamed and its title differs from its old file name, a device MUST retain the item’s title.

**Tests:** `device/folders-placement.test.ts › keeps a title somebody set when the file moves`.

### `folders/blob-file-written`

When a folder pull can obtain a file item’s bytes, a device MUST write those bytes as the file.

**Tests:** `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`.

### `folders/blob-absent`

When a folder pull cannot obtain a file item’s bytes for an environmental or local read failure, a device MUST report the item as `absent`.

**Tests:** `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders-placement.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folders/blob-absent-no-placeholder`

When a folder pull cannot obtain a file item’s bytes for an environmental or local read failure, a device MUST NOT write a placeholder file.

**Tests:** `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders-placement.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folders/blob-retry`

When a later folder pull can obtain bytes previously reported as absent, a device MUST retry writing the file.

**Tests:** `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders-placement.test.ts › keeps the file of an item whose new bytes cannot be had`, `device/folders-placement.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folders/old-blob-file-kept`

When a folder pull cannot obtain a file item’s changed bytes, a device MUST preserve the previous file’s bytes.

**Tests:** `device/folders-placement.test.ts › keeps the file of an item whose new bytes cannot be had`.

### `folders/blob-credential-refused`

When the server refuses the credential while a folder pull fetches file bytes, a device MUST fail the pull rather than count each file as absent.

**Tests:** `device/folders-placement.test.ts › ends a pull whose credential is refused, rather than counting each file absent`.

### `folders/blob-cache-released`

When a folder file holds its item’s bytes and no pending upload needs them, a device MUST release any duplicate copy of those bytes kept beside the working copy.

**Tests:** `device/folders-placement.test.ts › keeps no copy beside the store of bytes its file holds, and fetches them again when asked`.

### `folders/nonfile-blob-document`

When an item outside the file types carries `blob_ref`, a device MUST render it as a document rather than writing the referenced blob as its file.

**Tests:** `device/folders-placement.test.ts › writes an item carrying a blob_ref outside the file types as a document`.

### `folders/lost-row-file-kept`

When a folder file’s create is refused and the copy loses the row, a device MUST preserve the person’s file.

**Tests:** `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/lost-row-edit-retried`

When the person changes or moves a folder file whose row the copy no longer holds, a device MUST queue the file as a new item under a new device-minted ID.

**Tests:** `device/folders-identity.test.ts › queues a file whose row the copy lost again once it changes, and says so`, `device/folders-identity.test.ts › queues a file whose row the copy lost again once it moves`.

### `folders/lost-row-unchanged-held`

While a folder file whose row the copy no longer holds stays unchanged at its path, a device MUST report the file as lost.

**Tests:** `device/folders-identity.test.ts › queues a file whose row the copy lost again once it changes, and says so`, `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/lost-create-not-repeated`

While a folder file whose row the copy no longer holds stays unchanged at its path, a device MUST NOT queue another create.

**Tests:** `device/folders-identity.test.ts › queues a file whose row the copy lost again once it changes, and says so`, `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/lost-row-binding-ownership`

When a live file has taken a lost file’s former path, a device MUST preserve the live file’s binding.

**Tests:** `device/folders-identity.test.ts › keeps a live file's binding when it takes a lost file's old name`, `device/folders-identity.test.ts › keeps a live file's binding when it takes a lost file's old name, across a push`.

### `folders/lost-file-requeued`

When a live file has taken a lost file’s former path, a device MUST requeue the lost file as a new item.

**Tests:** `device/folders-identity.test.ts › keeps a live file's binding when it takes a lost file's old name`, `device/folders-identity.test.ts › keeps a live file's binding when it takes a lost file's old name, across a push`.

### `folders/lost-row-watch-notice`

While a folder file stays bound to a row the copy no longer holds, the CLI MUST say its lost-row watch notice only once.

**Tests:** `device/folders-identity.test.ts › says in words when a file is bound to an item that is gone, once while watching`.

### `folders/own-conflict-file-kept`

When a folder save conflicts with the same device’s earlier save, a device MUST preserve the file’s newer bytes rather than overwrite them with the item’s earlier value.

**Tests:** `device/folders-placement.test.ts › keeps a file whose newest save conflicted with its own earlier one, and sends it again`.

### `folders/own-conflict-retried`

When a folder file’s newer save was set aside against the same device’s earlier save, a device MUST submit the retained bytes at the next scan as an edit based on the item’s current version.

**Tests:** `device/folders-placement.test.ts › keeps a file whose newest save conflicted with its own earlier one, and sends it again`.

## Keeping up and other folders

### `folders/push-catches-up`

When a folder sync finishes its drain, a device MUST catch up the working copy before pulling its files.

**Tests:** `device/folders.test.ts › takes another device's change at the next push, without a hydration`.

### `folders/watch-follows`

While a folder watch runs, a device MUST apply server changes to the working copy without a full hydration while the cursor remains valid.

**Tests:** `device/folders.test.ts › takes another device's change while watching, without a hydration`.

### `folders/watch-follows-files-written`

While a folder watch runs, a device MUST write the received server changes at a subsequent pass.

**Tests:** `device/folders.test.ts › takes another device's change while watching, without a hydration`.

### `folders/expired-folder-hydrates`

When a folder’s cursor has aged out of the server log, a device MUST hydrate a fresh copy before continuing its push or watch.

**Tests:** `device/folders.test.ts › hydrates again at a push whose cursor the log has aged past`, `device/folders.test.ts › hydrates again while watching when the log ages past its cursor`.

### `folders/failed-hydration-retried`

When a folder push previously failed to hydrate a usable copy, a device MUST retry hydration at the next push.

**Tests:** `device/folders.test.ts › hydrates at the next push after one whose hydration failed`.

### `folders/watch-hydration-retry`

When a folder watch hydration fails environmentally, a device MUST retry hydration after a delay.

**Tests:** `device/folders.test.ts › keeps watching through a hydration that failed, and tries it again`, `device/folders.test.ts › waits out a rate limit's Retry-After before hydrating again while watching`.

### `folders/watch-retry-delay`

When a folder watch repeatedly fails to hydrate environmentally, a device MUST double its retry delay from one second up to thirty seconds, except for a longer `Retry-After` delay capped at 300 seconds.

**Tests:** waiting on #1890.

### `folders/catchup-failure-pull`

When a folder push’s catch-up fails environmentally but its copy remains usable, a device MUST pull from the held copy.

**Tests:** `device/folders.test.ts › pulls at a push that cannot reach the server, and says the catch-up failed`.

### `folders/catchup-failure-said`

When a folder push’s catch-up fails environmentally, the CLI MUST report why catch-up failed.

**Tests:** `device/folders.test.ts › pulls at a push that cannot reach the server, and says the catch-up failed`.

### `folders/watch-unretryable-failure`

When a folder watch hydration receives an answer no retry can change, the CLI MUST end the watch.

**Tests:** `device/folders.test.ts › ends the watch and says so when its hydration meets an answer no retry changes`.

### `folders/watch-unretryable-failure-reason-said`

When a folder watch hydration receives an answer no retry can change, the CLI MUST report why server changes stopped reaching the folder.

**Tests:** `device/folders.test.ts › ends the watch and says so when its hydration meets an answer no retry changes`.

### `folders/registry-registers-folder`

When a folder is added, a device MUST list its admitted absolute directory spelling, followed `system.folder` and store identity in the machine’s folder registry.

**Tests:** `device/folders-one-mac.test.ts › lists the folders on the Mac in one registry`, `device/folders-one-mac.test.ts › refuses a folder reached through a symlink and preserves its registry identity`, `device/folders-contract-b.test.ts › registers the resolved directory, followed folder and store identity`, `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`.

### `folders/registry-independent-stores`

When several folders are registered on one machine, a device MUST keep each folder’s working copy and queue independent.

**Tests:** `device/folders.test.ts › keeps each folder's state and queue to itself`.

### `folders/registry-location`

A device MUST keep the folder registry at `MARFA_FOLDER_REGISTRY` when set, otherwise in `folders.json` under the machine’s application data directory.

**Tests:** `device/folders-one-mac.test.ts › keeps its registry under the home by default`.

### `folders/registry-restored`

When a registered folder performs a pass after its registry entry disappears or its directory moves, a device MUST register the folder’s current directory again.

**Tests:** `device/folders-one-mac.test.ts › lists a folder again where the registry lost it, a watch included`, `device/folders-one-mac.test.ts › holds a delete for a pass when the registry it was listed in is gone, and lists itself again`.

### `folders/nested-folder-refused`

When adding a folder would enclose or fall inside another listed folder, a device MUST refuse the add.

**Tests:** `device/folders-one-mac.test.ts › refuses a folder inside another, and walks past a folder inside it`.

### `folders/nested-folder-refused-any-spelling`

When adding a folder would enclose or fall inside another listed folder, a device MUST refuse the add however either folder's path is spelled, including in another letter case on a case-insensitive volume.

**Reason:** More than one spelling can reach one directory, so only the directories themselves show whether two folders would hold one another's files.

**Tests:** `cli/folder.test.ts › refuses a folder that holds a listed folder, or lies inside one, when its path is spelled in another case`.

### `folders/nested-folder-not-scanned`

When a folder scan encounters a directory holding another folder’s `.marfa/core.sqlite` state, a device MUST exclude that directory’s contents from admission.

**Tests:** `device/folders-one-mac.test.ts › refuses a folder inside another, and walks past a folder inside it`, `device/folders-one-mac.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folders/nested-bound-file-held`

When a bound file’s directory becomes another folder, a device MUST preserve the original binding.

**Tests:** `device/folders-one-mac.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folders/nested-bound-file-held-unreached-count`

When a bound file’s directory becomes another folder, a device MUST count the file as `unreached`.

**Tests:** `device/folders-one-mac.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folders/nested-no-deletion`

When a bound file’s directory becomes another folder, a device MUST NOT journal the file’s deletion.

**Tests:** `device/folders-one-mac.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folders/remove-waiting-refused`

When a confirmed folder has unanswered or blocked queued writes, a device MUST refuse to remove its state.

**Tests:** `device/folders-one-mac.test.ts › refuses to remove a folder with a blocked write`.

### `folders/registry-one-directory`

When the same admitted directory is registered through an equivalent absolute spelling or for another `system.folder`, a device MUST retain only its current registry entry.

**Tests:** `device/folders-one-mac.test.ts › refuses a folder reached through a symlink and preserves its registry identity`, `device/folders-one-mac.test.ts › lists a folder under the folder it follows now, once, and drops one whose state was removed`, `cli/folder.test.ts › lists a folder added again under another letter case once, in place of its old entry`.

### `folders/remove-listed-acts-where-listed`

When a folder is removed by a path that names a listed entry, a device MUST delete folder state at that entry's directory only where that state's store identity is the one the machine’s folder registry lists for the entry.

**Reason:** After a folder is listed, a symbolic link or another folder can take its directory's place.

**Tests:** `cli/folder.test.ts › removes a listed folder whose directory became a link by its listing alone, and leaves the folder the link leads to`, `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`, `cli/folder.test.ts › takes a listed folder off the list without removing a folder moved into its place`.

### `folders/listed-link-remove-unlists`

If a folder is removed by the path at which the machine’s folder registry lists it, and a symbolic link now stands in that path, then a device MUST take that entry off the registry.

**Tests:** `cli/folder.test.ts › removes a listed folder whose directory became a link by its listing alone, and leaves the folder the link leads to`, `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`.

### `folders/remove-follows-only-listed-path`

If a folder is removed by a path that passes through a symbolic link and is not the path at which the machine’s folder registry lists a folder, then a device MUST refuse the removal with `invalid`.

**Reason:** A link above a folder can come to lead into another folder after the folder was listed, and only the listed path binds a removal to the folder the registry lists.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`, `cli/folder.test.ts › removes a listed folder whose directory became a link by its listing alone, and leaves the folder the link leads to`.

### `folders/remove-link-refusal-names-listed`

If a removal is refused because its path passes through a symbolic link in a directory above the folder that no later `..` climbs back out of, and the path reaches a folder that the machine’s folder registry lists, then a device MUST name that folder's listed path in the refusal's message.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`.

### `folders/remove-drops-store-entries`

When a folder's state is removed, a device MUST take every entry that lists that folder's store off the machine’s folder registry.

**Tests:** `cli/folder.test.ts › takes a moved folder's old entry off the list when it is removed at its new place`.

### `folders/remove-deleted-reported`

When a removal deletes a folder's state, the CLI MUST report `removed` as `true` with the directory whose state was deleted.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › takes a moved folder's old entry off the list when it is removed at its new place`.

### `folders/remove-unlisted-reported`

When a removal takes a registry entry off without deleting folder state, the CLI MUST report `removed` as `false` with the reason.

**Tests:** `cli/folder.test.ts › removes a listed folder whose directory became a link by its listing alone, and leaves the folder the link leads to`, `cli/folder.test.ts › takes a listed folder off the list without removing a folder moved into its place`.

### `folders/remove-unlisted-names-other`

When a removal takes a listed entry off without deleting folder state because the state at the entry's directory has the store identity that the machine’s folder registry lists for another entry, the CLI MUST name that other entry's listed path in the reason.

**Tests:** `cli/folder.test.ts › takes a listed folder off the list without removing a folder moved into its place`.

### `folders/registry-removed-state`

When a registry read finds a readable directory whose folder state was removed, a device MUST remove that directory’s registry entry.

**Tests:** `device/folders-one-mac.test.ts › lists a folder under the folder it follows now, once, and drops one whose state was removed`.

### `folders/registry-missing-kept`

When a registry read finds a listed folder missing or unreadable, a device MUST retain its entry.

**Reason:** A directory on a volume that is away cannot be found, as a deleted one cannot, and the entry is what lets another folder hold a delete for a file that may have moved into it.

**Tests:** `device/folders-one-mac.test.ts › holds a delete while a listed folder is missing, until it lists itself again`, `device/folders-one-mac.test.ts › keeps a folder it cannot read listed, and holds a delete meanwhile`, `device/folders-watch-every.test.ts › says in one line which listed folders cannot be found, keeps them listed, and keeps the others in step`.

### `folders/registry-unreadable-deletes-held`

When the machine’s registry cannot be read or disappears during a folder pass, a device MUST defer deletion of missing files whose move cannot be ruled out.

**Tests:** `device/folders-one-mac.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`, `device/folders-one-mac.test.ts › holds a delete for a pass when the registry it was listed in is gone, and lists itself again`.

### `folders/registry-invalid-replaced-on-add`

When a folder is added and the registry’s existing contents cannot be parsed, a device MUST replace the registry with a valid entry for that folder.

**Tests:** `device/folders-one-mac.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

### `folders/status-beside-watch`

While another process watches a folder, the CLI MUST answer `folders status` without acquiring the folder’s working handle.

**Tests:** `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folders/cross-folder-copy`

When a file’s ID already appears in another folder and the receiving folder already binds that item or its search excludes the item, a device MUST admit the arriving file as a new item.

**Tests:** `device/folders-one-mac.test.ts › tells a copy into another folder from a move`.

### `folders/cross-folder-member-adopted`

When a file arrives with an ID held by the receiving folder’s search and that folder has no file for the item, a device MUST bind the arriving file to the existing item.

**Tests:** `device/folders-one-mac.test.ts › takes a copy into a folder that holds the item and has no file of it as the item's file`.

### `folders/cross-folder-item-read`

When a file arrives with an ID held only by another folder’s copy and no file elsewhere still carries it, a device MUST read and pin the item from the server before binding it as the same item.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › gives a fresh id to a moved file whose item the server will not show, and pins one it shows`, `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folders/cross-folder-hidden-item`

When the server will not show the item named by a moved file’s ID, a device MUST admit the file as a new item.

**Tests:** `device/folders-one-mac.test.ts › gives a fresh id to a moved file whose item the server will not show, and pins one it shows`.

### `folders/saved-back-binding`

When a file is saved back at a path whose binding remains after another folder took its file, a device MUST treat it as the bound item until that binding is released.

**Tests:** `device/folders-one-mac.test.ts › keeps a file saved back where another folder took the item's file from as the item's while its binding lasts`.

### `folders/moved-file-not-trashed`

When a missing folder file is found in another registered folder as the same file by identity, carried ID or unambiguous bytes, a device MUST release the missing file’s binding.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › finds a file moved into a dot-led directory the other folder includes`, `device/folders-one-mac.test.ts › follows a move by copy and delete, by id and by bytes`, `device/folders-one-mac.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders-one-mac.test.ts › does not trash a file moved to another folder and saved there anew`, `device/folders-one-mac.test.ts › does not trash an unmatched file moved by copy and delete into a folder that holds its item`, `device/folders-one-mac.test.ts › follows identical files moved by identity, and makes identical copies new items`.

### `folders/moved-file-not-trashed-item-preserved`

When a missing folder file is found in another registered folder as the same file by identity, carried ID or unambiguous bytes, a device MUST NOT trash the item.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › finds a file moved into a dot-led directory the other folder includes`, `device/folders-one-mac.test.ts › follows a move by copy and delete, by id and by bytes`, `device/folders-one-mac.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders-one-mac.test.ts › does not trash a file moved to another folder and saved there anew`, `device/folders-one-mac.test.ts › does not trash an unmatched file moved by copy and delete into a folder that holds its item`, `device/folders-one-mac.test.ts › follows identical files moved by identity, and makes identical copies new items`.

### `folders/moved-file-count`

When a scan identifies a missing folder file as moved to another registered folder, a device MUST count it as `moved_away`.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`.

### `folders/peer-owned-bytes-not-move`

When another folder’s equal bytes belong to a different item, a device MUST NOT identify that file as the missing file’s move.

**Tests:** `device/folders-one-mac.test.ts › does not take another folder's file with the same bytes for a moved one`.

### `folders/both-folders-copy`

When two folder searches both hold an item and each folder has its own bound file, a device MUST NOT interpret either file as the other’s move.

**Tests:** `device/folders-one-mac.test.ts › tells a copy into another folder from a move`.

### `folders/missing-file-trashed`

When a missing folder file’s deletion grace expires and no other folder holds the moved file, a device MUST queue deletion of its item.

**Tests:** `device/folders-one-mac.test.ts › trashes a missing file found in no folder on the Mac, and says so`.

### `folders/missing-file-trashed-path-reported`

When a missing folder file’s deletion grace expires and no other folder holds the moved file, a device MUST name the path in the scan report’s `trashed`.

**Tests:** `device/folders-one-mac.test.ts › trashes a missing file found in no folder on the Mac, and says so`.

### `folders/missing-file-said`

When a missing folder file is trashed after no other folder holds it, the CLI MUST say that no folder on the machine holds the file.

**Tests:** `device/folders-one-mac.test.ts › trashes a missing file found in no folder on the Mac, and says so`.

### `folders/uncertain-move-deferred`

When a missing folder file could be in unreadable registered folders or several files elsewhere have its bytes, a device MUST defer its deletion.

**Tests:** `device/folders-one-mac.test.ts › holds a delete where several files in another folder have its bytes`, `device/folders-one-mac.test.ts › holds a delete while another folder cannot be read whole`, `device/folders-one-mac.test.ts › keeps an unreadable file moved to another folder before its next scan`, `device/folders-one-mac.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

### `folders/uncertain-move-deferred-unsure-reported`

When a missing folder file could be in unreadable registered folders or several files elsewhere have its bytes, a device MUST name the uncertainty in `unsure`.

**Tests:** `device/folders-one-mac.test.ts › holds a delete where several files in another folder have its bytes`, `device/folders-one-mac.test.ts › holds a delete while another folder cannot be read whole`, `device/folders-one-mac.test.ts › keeps an unreadable file moved to another folder before its next scan`, `device/folders-one-mac.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

### `folders/moved-arrival-bytes`

When a non-document file arrives from another folder whose missing-file binding uniquely identifies it by identity or bytes, a device MUST bind the arriving file to the existing item.

**Tests:** `device/folders-one-mac.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders-one-mac.test.ts › follows identical files moved by identity, and makes identical copies new items`.

### `folders/moved-awaiting-peer`

When a folder item’s moved file is present in another folder but not bound there yet, a device MUST count the item as `elsewhere`.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`.

### `folders/moved-awaiting-peer-no-replacement`

When a folder item’s moved file is present in another folder but not bound there yet, a device MUST NOT write a replacement file.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`.

## Watching every folder

A watch of every folder is `folders watch` run with no directory.

### `folders/watch-every-listed`

When `folders watch` names no directory, the CLI MUST keep every folder that the machine’s folder registry lists in step, in one process.

**Tests:** `device/folders-watch-every.test.ts › keeps every listed folder in step in one process, naming the folder on every line`.

### `folders/watch-every-names-folder`

While `folders watch` runs with no directory, the CLI MUST name the folder’s directory on every line it reports about one folder.

**Tests:** `device/folders-watch-every.test.ts › keeps every listed folder in step in one process, naming the folder on every line`, `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

### `folders/watch-every-own-server`

When a watch of every folder opens a folder whose working copy records the server it was hydrated from, a device MUST keep that folder in step with that server.

**Reason:** Folders on one machine can follow different servers.

**Tests:** `device/folders-watch-every.test.ts › keeps each folder with its own server and credential, and one server down stops only its folder`.

### `folders/watch-every-key-kept-apart`

When a watch of every folder opens a folder whose working copy records a server other than the one the command names, the CLI MUST NOT send that server the credential named for the command.

**Reason:** A key or token is for the server it was named for, and another server could use it.

**Tests:** `device/folders-watch-every.test.ts › keeps each folder with its own server and credential, and one server down stops only its folder`.

### `folders/watch-every-unwatchable-said`

If a folder that the machine’s folder registry lists cannot be watched for a reason other than that its directory cannot be found, then the CLI MUST report the folder’s directory and why once for as long as the reason stays the same.

**Tests:** `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

### `folders/watch-every-others-go-on`

If a watch of every folder cannot watch one listed folder, or that folder’s watch ends, then a device MUST keep the other listed folders in step.

**Tests:** `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`, `device/folders-watch-every.test.ts › ends only the watch of a folder whose credential the server refuses`, `device/folders-watch-every.test.ts › keeps each folder with its own server and credential, and one server down stops only its folder`.

### `folders/watch-every-missing-said`

When a watch of every folder finds that the directories of one or more listed folders cannot be found, the CLI MUST report those directories together in one line, once for as long as no other listed folder’s directory joins them.

**Reason:** A machine’s registry can list many folders whose directories were deleted long ago, and a watch started at every login would otherwise report each of them at every start. The folders stay listed under `folders/registry-missing-kept`, so a person removes one with `folders remove`.

**Tests:** `device/folders-watch-every.test.ts › says in one line which listed folders cannot be found, keeps them listed, and keeps the others in step`, `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

### `folders/watch-every-tried-again`

While a watch of every folder cannot watch a listed folder, a device MUST try the folder again and watch it once it can be watched.

**Tests:** `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

### `folders/watch-every-credential-refused`

If the server refuses one folder’s credential during a watch of every folder, then the CLI MUST end that folder’s watch without ending the command.

**Tests:** `device/folders-watch-every.test.ts › ends only the watch of a folder whose credential the server refuses`.

### `folders/watch-every-joins`

When the machine’s folder registry comes to list a folder while a watch of every folder runs, a device MUST keep that folder in step without a restart.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folders/watch-every-leaves`

When the machine’s folder registry stops listing a folder while a watch of every folder runs, a device MUST let go of that folder while it keeps the other folders in step.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folders/watch-every-leaves-said`

When a watch of every folder lets go of a folder the machine’s folder registry no longer lists, the CLI MUST report that folder’s directory as no longer listed.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folders/watch-every-registry-unread`

If the machine’s folder registry cannot be read while a watch of every folder runs, then a device MUST keep the folders it watches in step.

**Tests:** `device/folders-watch-every.test.ts › goes on with the folders it watches while the registry cannot be read`.

### `folders/watch-every-none-waits`

While the machine’s folder registry lists no folder, the CLI MUST keep a watch of every folder running.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folders/watch-every-none-said`

When a watch of every folder finds that the machine’s folder registry lists no folder, the CLI MUST say once that no folder is listed.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folders/watch-every-interrupt`

If a watch of every folder is interrupted while a folder’s pass waits on a server that does not answer, then the CLI MUST end within three seconds.

**Tests:** `device/folders-watch-every.test.ts › ends soon after an interrupt while a pass waits on the server, keeping the edit it was sending`.

### `folders/watch-every-interrupt-queued`

If a watch of every folder is interrupted before the server answers a folder’s write, then a device MUST keep that write queued for the folder’s next sync.

**Tests:** `device/folders-watch-every.test.ts › ends soon after an interrupt while a pass waits on the server, keeping the edit it was sending`.

## The record of folder watches

A watch process keeps a record of its folders in `folder-watch.json`, beside the machine’s folder registry, for any program on the machine to read. The file holds `version` (`1`) and `processes`, one entry for each watch process: its `pid`, `started_at`, `heartbeat_at`, `heartbeat_interval_seconds`, `ended_at`, and `folders`. Each folder lists its `dir`, its `system.folder` ID in `folder`, `watching`, `reason`, `last_success_at`, `first_sync_waiting`, `problems`, `pending_uploads`, `pending_downloads` and `paused_removals`. A watch takes a lock on `folder-watch.lock`, beside the file, to write it.

### `folders/watch-record-location`

While `folders watch` runs, with or without a directory, the CLI MUST keep a JSON file named `folder-watch.json` in the directory that holds the machine’s folder registry.

**Reason:** A program on the machine reads what a watch is doing without opening a folder’s store, calling the server or running a command for each folder.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`, `device/folder-watch-record.test.ts › keeps the record of a watch of one folder, and marks the folder not watched when it is stopped`.

### `folders/watch-record-folders`

While `folders watch` runs, a device MUST list in the record, in the entry of its process, each folder it was asked to watch: the folder at the named directory, or every folder the registry lists.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`, `device/folder-watch-record.test.ts › keeps the record of a watch of one folder, and marks the folder not watched when it is stopped`.

### `folders/watch-record-watching`

While a folder is said to be watched, a device MUST set `watching` to `true` for that folder in the record and `reason` to `null`.

**Reason:** A folder tried again after it could not be watched is said to be watched once its watch has lasted, so the record keeps showing why it was not watched until then.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`, `device/folder-watch-record.test.ts › keeps the record of a watch of one folder, and marks the folder not watched when it is stopped`.

### `folders/watch-record-unwatched`

While a folder that a watch of every folder lists is not said to be watched, and its directory can be found, a device MUST list it in the record with `watching` set to `false` and `reason` set to the code of the error that keeps it out.

**Reason:** A program showing folder syncing tells a folder that is failing from one that is not listed. The code is the one `folders watch` reports, and the record holds no message, which may name a path.

**Tests:** `device/folder-watch-record.test.ts › lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it`, `device/folder-watch-record.test.ts › lists the folder whose credential the server refused as not watched, with the problem the report carries`, `device/folders-handover.test.ts › says a folder it let go is held by another process once that process keeps it`.

### `folders/watch-record-missing`

While the directory of a folder that a watch of every folder lists cannot be found, a device MUST list it in the record with `watching` set to `false` and `reason` set to `missing`.

**Reason:** A program showing folder syncing tells a folder whose directory is gone, or on a volume that is away, from one that fails, and can say all of them in one line.

**Tests:** `device/folders-watch-every.test.ts › says in one line which listed folders cannot be found, keeps them listed, and keeps the others in step`, `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folders/watch-record-health`

While a device has read a folder’s latest report to the server, a device MUST set `last_success_at`, `first_sync_waiting`, `problems`, `pending_uploads`, `pending_downloads` and `paused_removals` for that folder in the record to the values of the folder’s latest report.

**Reason:** The record carries the report’s own values, so that a program reading it and the server never disagree about a folder. `last_success_at` is `null` until a sync completes, and `problems` holds the report’s closed set of codes with their counts.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`, `device/folder-watch-record.test.ts › lists the folder whose credential the server refused as not watched, with the problem the report carries`.

### `folders/watch-record-health-unread`

While a device has not read a report to the server for a folder and the folder’s `reason` is not `first_sync_waiting`, a device MUST set `last_success_at`, `first_sync_waiting`, `problems`, `pending_uploads`, `pending_downloads` and `paused_removals` for that folder in the record to `null`.

**Reason:** A reader tells a folder with nothing to report from a folder whose report this process never read, such as one it could not open, though another process may have saved one. A folder whose `reason` is `first_sync_waiting` shows `first_sync_waiting` as `true`.

**Tests:** `device/folder-watch-record.test.ts › lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it`.

### `folders/watch-record-processes`

While several watch processes run on one machine, a device MUST keep one entry in the record for each of them, with its own `pid`.

**Reason:** An entry left by an earlier process that had the same `pid` is replaced, so the `pid` names one entry.

**Tests:** `device/folder-watch-record.test.ts › lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it`, `device/folder-watch-record.test.ts › is never read half written, while two watches write it`, `device/folder-watch-record.test.ts › refreshes a running watch's heartbeat, and marks its folders not watched when it is stopped`.

### `folders/watch-record-heartbeat`

While a watch process runs and no other process holds the lock on `folder-watch.lock`, a device MUST rewrite the process’s entry in the record, setting `heartbeat_at` to the time of the write, at least once every `heartbeat_interval_seconds`.

**Reason:** A reader decides that an entry is current when its `ended_at` is `null` and its `heartbeat_at` is no later than now and less than three `heartbeat_interval_seconds` before now. A process that was killed cannot say that it ended, so its heartbeat grows old instead.

**Tests:** `device/folder-watch-record.test.ts › refreshes a running watch's heartbeat, and marks its folders not watched when it is stopped`.

### `folders/watch-record-stopped`

When a watch is stopped by an interrupt or by `SIGTERM`, a device MUST set `ended_at` in the process’s entry to the time it stopped and `watching` to `false` for each of the entry’s folders.

**Tests:** `device/folders-autostart.test.ts › ends on SIGTERM within three seconds with exit status 0, and marks its folders not watched`, `device/folder-watch-record.test.ts › refreshes a running watch's heartbeat, and marks its folders not watched when it is stopped`, `device/folder-watch-record.test.ts › keeps the record of a watch of one folder, and marks the folder not watched when it is stopped`.

### `folders/watch-record-killed`

If a watch process is killed, then a device MUST leave that process’s entry in the record as it was until `folders/watch-record-pruned` drops it.

**Reason:** A process that others replaced would show a dead watch as current. The entry keeps its last `heartbeat_at`, which a reader finds older than three `heartbeat_interval_seconds`.

**Tests:** `device/folder-watch-record.test.ts › leaves a killed watch's entry as it was, so that its heartbeat shows it ended`.

### `folders/watch-record-pruned`

When a device writes the record, a device MUST drop each entry of another process whose `heartbeat_at` is an hour or more before now or is later than now.

**Reason:** The record does not keep every watch that ever ran, and a heartbeat that has not happened yet, as after the clock was set back, would otherwise show a watch as current.

**Tests:** `device/folder-watch-record.test.ts › drops the entries nothing has written to for an hour and any that is still to come, and keeps a recent one`.

### `folders/watch-record-whole`

When a device writes the record, a device MUST replace the whole file in one step, keeping the entries of the other watch processes.

**Reason:** A reader never reads half a record, and two watch processes never lose each other’s entries.

**Tests:** `device/folder-watch-record.test.ts › is never read half written, while two watches write it`, `device/folder-watch-record.test.ts › lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it`.

### `folders/watch-record-no-content`

A device MUST NOT write into the record a credential, the name of a file inside a folder, or an item’s content.

**Tests:** `device/folder-watch-record.test.ts › lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder`.

### `folders/watch-record-unwritable-said`

If the record cannot be written, then the CLI MUST say so once while the watch runs.

**Tests:** `device/folder-watch-record.test.ts › says once that the record cannot be written, and the watch goes on and writes it once it can`.

### `folders/watch-record-unwritable-goes-on`

If the record cannot be written, then the CLI MUST keep the watch syncing.

**Tests:** `device/folder-watch-record.test.ts › says once that the record cannot be written, and the watch goes on and writes it once it can`.

### `folders/watch-record-locked-syncs`

While another process holds the lock on `folder-watch.lock`, the CLI MUST keep every folder’s watch syncing.

**Reason:** No folder’s start, pass or sync waits on the record.

**Tests:** `device/folder-watch-record.test.ts › goes on syncing and ends on an interrupt while another process holds the record's lock`.

### `folders/watch-record-locked-ends`

If another process holds the lock on `folder-watch.lock` when a watch is interrupted, then the CLI MUST end within three seconds.

**Tests:** `device/folder-watch-record.test.ts › goes on syncing and ends on an interrupt while another process holds the record's lock`.

### `folders/watch-record-locked-said`

If another process has held the lock on `folder-watch.lock` for more than three `heartbeat_interval_seconds` while a watch runs, then the CLI MUST say so once, and again only after a write of the record has succeeded in between.

**Reason:** The watch goes on, but a reader finds its entry old and takes it as ended.

**Tests:** `device/folder-watch-record.test.ts › says once that another process has held the record's lock for long`.

### `folders/watch-record-written-again`

When the record can be written again, a device MUST write it.

**Tests:** `device/folder-watch-record.test.ts › says once that the record cannot be written, and the watch goes on and writes it once it can`.

## Handing a folder to a command

One process works a folder at a time. A command that works a folder, such as `folders confirm`, `folders restore`, `folders remove`, `folders push` or `folders unmatched --remove`, asks a running `folders watch` for the folder, and the watch lets it go and takes it back.

### `folders/handover-asked`

When a command that works a folder finds the folder held by a running `folders watch`, the CLI MUST work the folder once the watch lets it go.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`, `device/folders-unmatched.test.ts › takes files away from a folder a watch holds, and is refused while the first sync waits`, `device/folders-handover.test.ts › hands a folder a watch holds to folders add over it`.

### `folders/handover-wait-refused`

If the process that holds a folder does not let it go within 10 seconds of a command asking for it, then the CLI MUST refuse the command with `reading_handle` before changing local or server state.

**Reason:** A watch that is suspended or stuck never lets go, and a command must not wait on it without end.

**Tests:** `device/folders-handover.test.ts › refuses a command once a suspended watch has not let the folder go in 10 seconds, and both go on once it resumes`.

### `folders/handover-step-whole`

If a command asks a running `folders watch` for a folder while the watch's pass waits on the server's answer to a write, then the CLI MUST let the folder go only after that answer is taken in.

**Reason:** A write cut off mid-pass would be sent again, or its answer lost.

**Tests:** `device/folders-handover.test.ts › lets a folder go only once the write its pass is sending is answered`.

### `folders/handover-others-go-on`

While a watch of every folder has let one folder go to a command, the CLI MUST keep the other folders it watches in step.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`.

### `folders/handover-taken-back`

When a command a running `folders watch` let a folder go to ends and the folder is still there, the CLI MUST keep the folder in step again without a restart.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`, `device/folders-handover.test.ts › keeps watching a folder named through a linked parent after letting it go`, `device/folders-handover.test.ts › takes a folder back with the credential it began with, though the keychain cannot be read meanwhile`.

### `folders/handover-removed-ends`

When a command that a `folders watch` of one directory let the folder go to removes the folder, the CLI MUST end that watch with exit code 0.

**Tests:** `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folders/handover-unlisted-ends`

When a command that a running `folders watch` let a folder go to takes the folder off the machine’s folder registry, the CLI MUST end the watch of that folder and leave it off the registry.

**Tests:** `device/folders-handover.test.ts › keeps a folder off the list that the command took off it, ending its watch`.

### `folders/handover-held-elsewhere`

If a folder that a running `folders watch` let go is held by another process, with no command asking for it, for longer than 10 seconds, then the CLI MUST report the folder once as not watched, with `watching` false and `code` `reading_handle` in `--json`.

**Reason:** Another watch or an app that takes the folder keeps it until it ends, so reporting the folder as let go to a command would hide why it is not synced.

**Tests:** `device/folders-handover.test.ts › says a folder it let go is held by another process once that process keeps it`, `device/folders-handover.test.ts › says a folder its own watch let go is held by another process once that process keeps it`.

### `folders/handover-let-go-said`

When a running `folders watch` lets a folder go to a command, the CLI MUST report it once, with `watching` false and `code` `handed_over` in `--json`.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folders/handover-taken-back-said`

When a running `folders watch` takes back a folder it let go to a command, the CLI MUST report it, with `watching` true and `taken_back` true in `--json`.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folders/handover-ended-asker`

If a command that asked for a folder ends before the folder is let go, then the CLI MUST keep the watch of that folder in step.

**Reason:** A command killed while it waits must not leave the folder unsynced.

**Tests:** `device/folders-handover.test.ts › goes on syncing a folder whose asking command was killed before the watch let it go`.

### `folders/handover-record-reason`

While a running `folders watch` has let a folder go to a command, a device MUST list that folder in the record of folder watches with `watching` set to `false` and `reason` set to `handed_over`.

**Tests:** `device/folders-handover.test.ts › hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back`, `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folders/one-watch-per-folder`

While a process holds a folder, the CLI MUST refuse `folders watch` of that folder with `reading_handle`.

**Reason:** A watch does not ask for a folder; two watches that asked would take one folder from each other in turn.

**Tests:** `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`, `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

## Folder syncing from login

`folders autostart on`, `off` and `status` turn on, turn off and report syncing from login. On macOS the agent is a launchd property list named `so.marfa.folder-watch.plist` in `Library/LaunchAgents` under the home directory; on Linux it is a systemd user unit named `marfa-folder-watch.service` in `systemd/user` under the directory the XDG Base Directory Specification names for user configuration, which `XDG_CONFIG_HOME` holds, or under `.config` in the home directory where it is unset or empty. Where `MARFA_AUTOSTART_ROOT` names a directory, that directory stands in for the home directory, `XDG_CONFIG_HOME` is not read, and the CLI runs the `launchctl` or `systemctl` in its `bin` directory, so a fixture never reaches the person’s own service manager.

### `folders/autostart-launchd-agent`

Where the platform is macOS, when `folders autostart on` runs, the CLI MUST write the agent’s property list in `Library/LaunchAgents` under the home directory and load it into the person’s `gui/<uid>` launchd domain.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folders/autostart-systemd-unit`

Where the platform is Linux, when `folders autostart on` runs, the CLI MUST write the agent’s unit in the person’s systemd user unit directory and enable and start it with `systemctl --user`.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folders/autostart-runs-watch`

When `folders autostart on` writes the agent, the CLI MUST make it run `folders watch` with no directory and with `--log` naming `folder-watch.log` beside the folder registry, by the absolute path the command was run by where that path leads to the `marfa` binary running it.

**Reason:** A path through a symbolic link, such as a package manager's, still leads to the binary after an upgrade replaces what the link leads to.

**Tests:** `device/folders-autostart.test.ts › records the binary by the path it was run as, through a link`, `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`, `device/folders-autostart.test.ts › says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary`.

### `folders/autostart-registry`

When `folders autostart on` writes the agent, the CLI MUST set `MARFA_FOLDER_REGISTRY` in the agent’s environment to the absolute path of the folder registry the command resolved.

**Reason:** The watch lists the folders that `folders list` lists from the person’s shell, whatever environment the service manager gives it.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folders/autostart-no-credential`

The CLI MUST NOT write into the agent a credential, a server address, a variable that names either, such as `MARFA_API_KEY` or `MARFA_API_URL`, or a variable that names a keychain file, such as `MARFA_KEYCHAIN`.

**Reason:** Each folder uses the server its copy came from and the credential the keychain keeps for that server, as a watch of every folder does.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folders/autostart-file-mode`

When `folders autostart on` writes the agent, the CLI MUST leave the file writable by its owner alone.

**Reason:** launchd refuses an agent that others can write.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folders/autostart-restart-policy`

When `folders autostart on` writes the agent, the CLI MUST set it to start the watch again only after the watch ends with a failure, and no sooner than 30 seconds after the watch last started.

**Reason:** A watch that fails at once, as with a binary that is gone, is not started again in a tight loop, and a watch a service manager stopped, which exits 0, stays stopped.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folders/autostart-at-login`

Where folder syncing from login is on, when the person signs in, a device MUST keep every listed folder in step with no terminal open.

**Tests:** waiting on #2032.

### `folders/autostart-own-credential`

While the agent’s watch runs, a device MUST keep each folder in step with the credential the keychain keeps for that folder’s server.

**Tests:** `device/folders-autostart.test.ts › keeps a folder in step from the agent, with the credential the keychain keeps for the folder's server`.

### `folders/autostart-on-said`

When `folders autostart on` completes, the CLI MUST report the agent’s file, the binary the agent runs, its log and the folder registry it reads.

**Tests:** `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folders/autostart-on-unchanged`

When `folders autostart on` runs while the agent it would write is installed and loaded, the CLI MUST leave the file unchanged and load nothing again.

**Tests:** `device/folders-autostart.test.ts › changes nothing when turned on again, and off removes the agent and stops its watch, twice over`.

### `folders/autostart-on-replaces`

When `folders autostart on` runs while the installed agent differs from the one it would write, the CLI MUST replace the agent and start the watch again from it.

**Tests:** `device/folders-autostart.test.ts › says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary`.

### `folders/autostart-on-after-failure`

When `folders autostart on` runs after an earlier `folders autostart on` failed before the service manager took the agent it wrote, the CLI MUST load that agent and start the watch from it.

**Reason:** The file on disk alone does not say which agent the service manager runs.

**Tests:** `device/folders-autostart.test.ts › starts the agent it wrote after a swap that failed, rather than saying it is unchanged`.

### `folders/autostart-off`

When `folders autostart off` runs, the CLI MUST stop the agent’s watch and remove the agent’s file.

**Tests:** `device/folders-autostart.test.ts › changes nothing when turned on again, and off removes the agent and stops its watch, twice over`.

### `folders/autostart-off-unchanged`

When `folders autostart off` runs while no agent is installed or loaded, the CLI MUST change nothing and succeed.

**Tests:** `device/folders-autostart.test.ts › changes nothing when turned on again, and off removes the agent and stops its watch, twice over`.

### `folders/autostart-off-unreachable-removes`

If the service manager cannot be asked, or cannot stop the watch, when `folders autostart off` runs, then the CLI MUST still remove the agent’s file.

**Reason:** The watch then does not start at the next login.

**Tests:** `device/folders-autostart.test.ts › removes the agent it wrote though the service manager cannot be asked, and says what it could not do`.

### `folders/autostart-off-unreachable-said`

If the service manager cannot be asked, or cannot stop the watch, when `folders autostart off` runs, then the CLI MUST exit with status 3 and say that it removed the agent’s file and could not stop the watch.

**Tests:** `device/folders-autostart.test.ts › removes the agent it wrote though the service manager cannot be asked, and says what it could not do`.

### `folders/autostart-flags-refused`

If `folders autostart` is given `--url` or `--key`, then the CLI MUST refuse it with `usage` and write nothing.

**Tests:** `device/folders-autostart.test.ts › refuses --url and --key, and writes nothing`.

### `folders/autostart-status`

When `folders autostart status` runs, the CLI MUST report whether the agent is installed, whether the service manager runs its watch and as which process, the binary the agent runs, and where the watch logs.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`, `device/folders-autostart.test.ts › changes nothing when turned on again, and off removes the agent and stops its watch, twice over`.

### `folders/autostart-status-offline`

The CLI MUST answer `folders autostart status` with no server named and no credential it can read.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folders/autostart-status-binary-other`

When `folders autostart status` runs while the agent runs a binary other than the one running the command, the CLI MUST say so.

**Tests:** `device/folders-autostart.test.ts › says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary`.

### `folders/autostart-status-binary-gone`

When `folders autostart status` runs while the binary the agent runs no longer exists, the CLI MUST say so.

**Tests:** `device/folders-autostart.test.ts › says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary`.

### `folders/autostart-status-record`

When `folders autostart status` runs while the agent’s watch runs, the CLI MUST report whether the record of folder watches holds a current entry for that watch’s process, and each folder of that entry with its `watching` and `reason`.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folders/autostart-status-missing`

When `folders autostart status` finds folders in the current entry whose `reason` is `missing`, the CLI MUST report them in one line with their count.

**Reason:** A machine’s registry can list many folders whose directories were deleted long ago, and `folders remove` takes each off the list.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folders/autostart-status-credential`

When `folders autostart status` finds a folder in the current entry not watched for `no_credential`, `no_keychain`, `unauthorized` or `signed_out`, the CLI MUST say that the watch has no credential it can use for that folder’s server.

**Reason:** On Linux the watch reads its keys from the Secret Service keychain, which must be unlocked at login for a watch started then.

**Tests:** `device/folders-autostart.test.ts › says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own`.

### `folders/watch-terminate`

When `folders watch` receives `SIGTERM`, the CLI MUST end within three seconds with exit status 0.

**Reason:** A service manager stops a watch with `SIGTERM`, and a watch that ends with a failure would be started again.

**Tests:** `device/folders-autostart.test.ts › ends on SIGTERM within three seconds with exit status 0, and marks its folders not watched`.

### `folders/watch-terminate-telemetry`

Where telemetry is on, when `folders watch` receives `SIGTERM`, the CLI MUST end with exit status 0.

**Reason:** The thread that sends telemetry starts before the watch, and `SIGTERM` reaching it would end the process at once, which a service manager reads as a failure.

**Tests:** `device/folders-autostart.test.ts › ends on SIGTERM with exit status 0 while it sends telemetry, too`.

### `folders/watch-log`

Where `folders watch` is given `--log` with a file, the CLI MUST write the watch’s standard output and standard error to that file in place of its own.

**Tests:** `device/folders-autostart.test.ts › moves a log of 1 MiB or more aside as the watch starts, and writes to a fresh one`, `device/folders-autostart.test.ts › writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it`.

### `folders/watch-log-private`

Where `folders watch` is given `--log` with a file it makes, the CLI MUST make that file readable and writable by its owner alone.

**Reason:** The log names folders’ directories.

**Tests:** `device/folders-autostart.test.ts › moves a log of 1 MiB or more aside as the watch starts, and writes to a fresh one`.

### `folders/watch-log-start-full`

When `folders watch` starts with `--log` naming a file that holds 1 MiB or more, the CLI MUST move that file to the same name with `.1` added, replacing any file there, before it writes.

**Tests:** `device/folders-autostart.test.ts › moves a log of 1 MiB or more aside as the watch starts, and writes to a fresh one`.

### `folders/watch-log-running-full`

While `folders watch` runs with `--log`, when its file reaches 1 MiB, the CLI MUST move that file to the same name with `.1` added within 30 seconds and go on writing to a new file of the first name.

**Tests:** `device/folders-autostart.test.ts › moves the log aside once it reaches 1 MiB while the watch runs`.

## Taking in another folder’s file

### `folders/take-in-file`

When another registered folder no longer holds an item for a non-state reason and still holds only its own written file bytes, and the receiving folder’s search holds that item without a file, a device MUST take that file into its placement.

**Tests:** `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folders/take-in-file-taken-count`

When another registered folder no longer holds an item for a non-state reason and still holds only its own written file bytes, and the receiving folder’s search holds that item without a file, a device MUST count the file as `taken`.

**Tests:** `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folders/take-in-edited-source-kept`

When another folder’s let-go file was edited since that folder last read it, a device MUST leave the source file for its own folder to send.

**Tests:** `device/folders-one-mac.test.ts › does not take in a let-go file edited since its folder last read it`.

### `folders/take-in-state-excluded`

When an item left another folder by state, a device MUST NOT take in that folder’s file as a non-state departure.

**Tests:** `device/folders-one-mac.test.ts › does not take in the file of an item that left its folder by state`.

### `folders/take-in-destination-kept`

When a file appears at the destination before a move-in lands, a device MUST preserve the destination file.

**Tests:** `device/folders-one-mac.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folders/take-in-destination-kept-unwritten-count`

When a file appears at the destination before a move-in lands, a device MUST report the refused placement as `unwritten`.

**Tests:** `device/folders-one-mac.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folders/take-in-refused-source-kept`

When a move-in cannot land because its destination became occupied, a device MUST retain the source file at its original path.

**Tests:** `device/folders-one-mac.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folders/take-in-binding-kept`

When a move-in is refused because its destination became occupied, a device MUST preserve the destination’s previous binding through that pull’s departure cleanup.

**Tests:** `device/folders-one-mac.test.ts › keeps both files when a destination appears just before a move-in (%s)`, `device/folders-one-mac.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folders/take-in-journal-ownership`

When a folder adopts matching destination bytes or takes in another folder’s file, a device MUST clear the arriving item’s journal entry.

**Tests:** `device/folders-one-mac.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folders/take-in-previous-journal-kept`

When a folder adopts matching destination bytes or takes in another folder’s file, a device MUST preserve any previous owner’s deletion journal entry.

**Tests:** `device/folders-one-mac.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folders/take-in-copy-fallback`

When a move-in fails across volumes or because a readable regular source has positively confirmed immutable protection, a device MUST try a copy with the same absent-target no-replace guarantee.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`, `device/folders-one-mac.test.ts › preserves a source across copy publication failures (%s)`.

### `folders/take-in-denial-no-fallback`

When a move-in fails with an ordinary permission denial and immutable protection is not confirmed, a device MUST refuse the move rather than copy the source.

**Tests:** `device/folders-one-mac.test.ts › refuses an ordinary source removal denial instead of copying`.

### `folders/take-in-copy-metadata`

When a move-in uses a copy, a device MUST preserve the source’s permissions and applicable extended attributes, including Finder tags and quarantine.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/take-in-copy-refusal`

When a move-in copy cannot preserve an attribute, verify the complete bytes or confirm unchanged regular-file identity before publication, a device MUST refuse publication.

**Tests:** `device/folders-one-mac.test.ts › preserves a source across copy publication failures (%s)`.

### `folders/take-in-copy-refusal-source-preserved`

When a move-in copy cannot preserve an attribute, verify the complete bytes or confirm unchanged regular-file identity before publication, a device MUST preserve the source.

**Tests:** `device/folders-one-mac.test.ts › preserves a source across copy publication failures (%s)`.

### `folders/take-in-copy-source-protection`

When a move-in uses a copy because the source is immutable, a device MUST leave the source’s protection unchanged.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/take-in-destination-unprotected`

When a move-in uses a copy because the source is immutable, a device MUST NOT apply immutable protection to the destination.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/take-in-source-retained`

When a successful move-in copy cannot remove its source, a device MUST leave the source’s binding and journal intact.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-reported`

When a copied source remains in its original folder because removal is denied, a device MUST retain the file’s unmatched status.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-reported-unwritten-count`

When a copied source remains in its original folder because removal is denied, a device MUST report the file as `unwritten`.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-reported-bytes-preserved`

When a copied source remains in its original folder because removal is denied, a device MUST NOT rewrite the file.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-later-removal`

When removal of a retained copied source becomes possible and its identity and bytes still belong to the original folder, a device MUST remove the source.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-item-preserved`

When removal of a retained copied source becomes possible and its identity and bytes still belong to the original folder, a device MUST NOT trash the item.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-edit-kept`

When the person edits a retained copied source before its removal becomes possible, a device MUST preserve the edit for that source folder to send.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/let-go-existing-peer`

When another registered folder already holds its own file for an item this folder no longer holds, a device MUST remove this folder’s unchanged owned file.

**Tests:** `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folders/let-go-existing-peer-let-go-count`

When another registered folder already holds its own file for an item this folder no longer holds, a device MUST count this folder’s file as `let_go`.

**Tests:** `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folders/unmatched-missing-not-rewritten`

When a bound unmatched file is missing from disk, a device MUST leave the missing file for the scan’s deletion journal rather than recreate it during a pull.

**Tests:** `device/folders-contract-b.test.ts › does not count a missing unmatched file as put back when restoring a removal`.

### `folders/two-folders-editable`

When two folder searches hold one item, a device MUST keep each folder’s bound file editable through that folder’s own queue.

**Tests:** `device/folders-one-mac.test.ts › keeps two folders' files for one item editable`.

### `folders/two-folders-delete`

When the person deletes either of two files whose folders both hold the item, a device MUST trash the item after the deletion grace rather than treat the other folder’s file as a move.

**Tests:** `device/folders-one-mac.test.ts › keeps two folders' files for one item editable`, `device/folders-one-mac.test.ts › trashes a file item deleted where both folders hold it`.

## Pulls and pushes

### `folders/pull-gone-item-file`

If an item leaves the working copy before a pull writes its file, then a device MUST NOT write a file for that item.

**Tests:** `device/folders-identity.test.ts › writes no file for a row purged while the pull writes it, and reads the copy again`.

### `folders/pull-gone-item-binding`

If an item leaves the working copy before a pull writes its file, then a device MUST NOT bind a file to that item.

**Tests:** `device/folders-identity.test.ts › writes no file for a row purged while the pull writes it, and reads the copy again`.

### `folders/pull-gone-item-placement`

If an item leaves the working copy before a pull queues its placement, then a device MUST NOT queue a placement for that item.

**Tests:** `device/folders-identity.test.ts › places nothing for a row purged before its placement is queued, and takes its file away at the next pull`.

### `folders/pull-gone-item-continue`

If an item leaves the working copy during a pull, then a device MUST continue the pull without failing solely because that item is gone.

**Tests:** `device/folders-identity.test.ts › writes no file for a row purged while the pull writes it, and reads the copy again`, `device/folders-identity.test.ts › places nothing for a row purged before its placement is queued, and takes its file away at the next pull`.

### `folders/pull-retry-copy`

When the working copy changes under a pull, a device MUST restart the pull from a fresh read of the copy, making at most three attempts in total.

**Tests:** `device/folders-identity.test.ts › pulls again where the copy changes under the pull`, `device/folders-contract-c.test.ts › retries a changed copy three times in total and succeeds on the third stable read`.

### `folders/pull-retry-counts`

When a pull restarts after its working copy changes, a device MUST include completed file writes, rewrites, moves, revivals, placements, placement ends, removals, purged-file removals, transfers in and transfers out from earlier attempts in its final report.

**Tests:** `device/folders-identity.test.ts › counts what an attempt wrote before the copy changed under it`, `device/folders-contract-c.test.ts › counts files and placements from before a restarted pull exactly once`, `device/folders-contract-c-retry.test.ts › retains rewrite and move counts across a restart`, `device/folders-contract-c-retry.test.ts › retains revival counts across a restart`, `device/folders-contract-c-retry.test.ts › retains removal, purge and placement-end counts across a restart`, `device/folders-contract-c-retry.test.ts › retains transfer-%s counts across a restart`.

### `folders/watch-copy-change-notice`

When the working copy keeps changing under consecutive `folders watch` passes, the CLI MUST report the condition once for that run of passes.

**Tests:** `device/folders-identity.test.ts › goes on watching where the copy keeps changing under its pull, and says so once`.

### `folders/watch-copy-change-retry`

When a watch pass exhausts its pull attempts because the working copy keeps changing, a device MUST continue watching and retry the pull in the next pass.

**Tests:** `device/folders-identity.test.ts › goes on watching where the copy keeps changing under its pull, and says so once`.

### `folders/pull-flagged-items`

When a pull counts an item as `unwritten`, `outside`, `unsuited` or `absent`, a device MUST include the item's ID, intended path or retained file path, flag and reason in the pull report's `flagged` entries, using `retained` as the flag for a file it could not let go to another folder.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folders.test.ts › refuses to write a file outside the folder`, `device/folders.test.ts › does not write over a file it never wrote`, `device/folders-placement.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`, `device/folders-placement.test.ts › writes no file where its placement would make it another kind of file`, `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/report-distinct-items`

When `folders push` or `folders watch` reports items held back by a pull, the CLI MUST report each item once, including separate entries for different items at the same path.

**Tests:** `device/folders.test.ts › names each item it holds back at a secret's name, two at one path as two`.

### `folders/elsewhere-unflagged`

When a pull counts an item as `elsewhere` because its file is moving to another folder on the machine, a device MUST NOT include the item in the pull report's `flagged` entries.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`.

### `folders/push-send-placement`

When a folder sync writes a file whose placement is not on the server, a device MUST send that placement in the same sync unless `folders/push-server-unavailable`, `folders/push-credential-stopped` or `folders/push-undelivered` prevents a further drain.

**Tests:** `cli/folder.test.ts › is in step after the one push that writes its files`, `cli/folder.test.ts › is in step after the push that runs a confirmed first sync`, `device/folders.test.ts › sends the placement of each file a push writes in the push, and counts it`.

### `folders/push-count-placement`

When a folder sync sends a placement after its pull, a device MUST include that placement in the sync report's count of answered writes.

**Tests:** `cli/folder.test.ts › is in step after the one push that writes its files`, `device/folders.test.ts › sends the placement of each file a push writes in the push, and counts it`.

### `folders/push-server-unavailable`

If a folder sync's catch-up fails environmentally or its first drain reports the server unavailable, then a device MUST NOT drain again after that sync's pull.

**Tests:** `device/folders.test.ts › leaves the placements of the files a push wrote waiting where it could not reach the server, and sends them at the next push`, `device/folders.test.ts › leaves the placements waiting where the server fails them as the push sends them, and sends them at the next push`.

### `folders/push-credential-stopped`

If a folder sync's first drain stops because the server refuses the credential, then a device MUST NOT drain again after that sync's pull.

**Tests:** `device/folders.test.ts › does not drain again after a push whose first drain a refused credential stopped`.

### `folders/push-undelivered`

If a folder sync's first drain leaves a write undelivered, then a device MUST NOT drain again after that sync's pull.

**Tests:** `device/folders.test.ts › does not drain again after a push whose first drain left a write undelivered`.

### `folders/push-placement-retry`

When a folder sync leaves placements queued after its pull and a later sync can deliver them, a device MUST send those placements in the later sync.

**Tests:** `device/folders.test.ts › leaves the placements of the files a push wrote waiting where it could not reach the server, and sends them at the next push`, `device/folders.test.ts › leaves the placements waiting where the server fails them as the push sends them, and sends them at the next push`, `device/folders.test.ts › does not drain again after a push whose first drain left a write undelivered`.

### `folders/push-placement-verdict`

When the server refuses a placement sent after a folder sync's pull, a device MUST include that refusal among the sync report's verdicts.

**Tests:** `device/folders.test.ts › reports a placement the server refuses in the push's second drain, and does not send it again`.

### `folders/push-placement-withheld`

While the key, saved folder settings and placement used by a refused placement write remain unchanged, a device MUST NOT send that placement write again.

**Tests:** `device/folders.test.ts › reports a placement the server refuses in the push's second drain, and does not send it again`.

### `folders/conflict-file-report`

When `folders push` or a `folders watch` pass receives a `conflicted` verdict for an edit to a file in that folder, the CLI MUST name the file in its text output.

**Tests:** `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`, `cli/folder.test.ts › says a conflicted edit while watching, and where its text went`, `device/folders.test.ts › names the file a conflicted edit's text went to, in a push`, `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`.

### `folders/conflict-copy-file`

When `folders push` or `folders watch` reports a conflicted edit whose conflicted copy has a file in that folder, the CLI MUST name that file as the destination of the edit's text.

**Tests:** `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`, `cli/folder.test.ts › says a conflicted edit while watching, and where its text went`, `device/folders.test.ts › names the file a conflicted edit's text went to, in a push`.

### `folders/conflict-copy-pending`

When `folders push` or `folders watch` reports a conflicted edit whose conflicted copy has no file in that folder yet, the CLI MUST say that the copy is not a file in the folder yet.

**Tests:** `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`.

### `folders/conflict-copy-arrival`

When a `folders watch` pass writes a conflicted copy previously reported as having no file yet, the CLI MUST report the file that now holds the edit's text.

**Tests:** `device/folders.test.ts › says in a watch the file a conflicted copy became, once it is one`.

### `folders/conflict-report-once`

When `folders push` or `folders watch` has reported a conflicted write, the CLI MUST NOT report that verdict again.

**Tests:** `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`, `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`.

### `folders/conflict-other-item`

When a conflicted write belongs to an item with no file in the watched or pushed folder, the CLI MUST NOT report that conflict as the folder's.

**Tests:** `device/folders.test.ts › does not name a conflict on a write that is no file of the folder's, in a push`, `device/folders.test.ts › does not name a conflict on a write that is no file of the folder's, in a watch`.

## Sending without pulling

A send-only run is `folders push --send-only`.

### `folders/send-only-scans-and-sends`

When `folders push` is given `--send-only`, the CLI MUST send the writes that a scan of the folder queues.

**Reason:** a person who adds files or edits them while away can send them without the server's items arriving in the directory.

**Tests:** `device/folders-send-only.test.ts › sends a file made here and writes no file into the directory, where a push writes the server's item`, `device/folders-send-only.test.ts › keeps its writes queued where the server cannot be reached, and sends them at the next run`.

### `folders/send-only-writes-no-file`

When `folders push` is given `--send-only`, the CLI MUST NOT write a file into the folder's directory outside its `.marfa` state directory.

**Tests:** `device/folders-send-only.test.ts › sends a file made here and writes no file into the directory, where a push writes the server's item`, `device/folders-send-only.test.ts › hydrates a copy that never was first, which writes no file, and then sends`.

### `folders/send-only-removes-no-file`

When `folders push` is given `--send-only`, the CLI MUST NOT remove a file from the folder's directory.

**Tests:** `device/folders-send-only.test.ts › removes no file whose item has left, where a push removes it`.

### `folders/send-only-report-sent`

When `folders push --send-only` finishes, the CLI MUST report the writes it sent in the `drain` of its JSON report.

**Tests:** `device/folders-send-only.test.ts › says what it sent and that it did not pull, in JSON and in words`.

### `folders/send-only-report-not-pulled`

When `folders push --send-only` finishes, the CLI MUST report `pulled` as `false` in its JSON report.

**Tests:** `device/folders-send-only.test.ts › says what it sent and that it did not pull, in JSON and in words`.

### `folders/send-only-report-words`

When `folders push --send-only` finishes, the CLI MUST say in its text report that nothing was pulled.

**Tests:** `device/folders-send-only.test.ts › says what it sent and that it did not pull, in JSON and in words`.

### `folders/send-only-later-push-pulls`

When a `folders push` without `--send-only` follows a send-only run, the CLI MUST write the files of the items that run left unpulled.

**Tests:** `device/folders-send-only.test.ts › leaves what it did not pull for the next push`.

### `folders/send-only-hydrates`

When a folder's copy has not hydrated, the CLI MUST hydrate it before `folders push --send-only` sends.

**Reason:** a drain on a copy that has not hydrated is refused with `no_cursor`; hydrating writes only the folder's store, never an item's file.

**Tests:** `device/folders-send-only.test.ts › hydrates a copy that never was first, which writes no file, and then sends`.

### `folders/send-only-first-sync-refused`

While a folder's first sync waits for confirmation, the CLI MUST refuse `folders push --send-only` with `first_sync_waiting`.

**Tests:** `device/folders-send-only.test.ts › is refused while the first sync waits, before it sends anything`.

### `folders/send-only-first-sync-nothing-sent`

While a folder's first sync waits for confirmation, the CLI MUST NOT send a write to the server when `folders push --send-only` is run.

**Tests:** `device/folders-send-only.test.ts › is refused while the first sync waits, before it sends anything`.

### `folders/send-only-offline-queued`

If the server cannot be reached, then the CLI MUST keep the folder's unsent writes queued when `folders push --send-only` is run.

**Tests:** `device/folders-send-only.test.ts › keeps its writes queued where the server cannot be reached, and sends them at the next run`.

### `folders/send-only-offline-reported`

If the server cannot be reached, then the CLI MUST report the writes it could not deliver in `drain.undelivered` when `folders push --send-only` is run.

**Tests:** `device/folders-send-only.test.ts › keeps its writes queued where the server cannot be reached, and sends them at the next run`.

## Removing unmatched files

An unmatched file is one a folder keeps because its item left the search for a reason other than its state or purge (`folders/unmatched-file-kept`).

### `folders/unmatched-list`

When `folders unmatched` is run, the CLI MUST list each unmatched file with its path and its item's ID.

**Tests:** `device/folders-unmatched.test.ts › lists them, and says which removing would keep`.

### `folders/unmatched-list-kept`

When `folders unmatched` lists an unmatched file that removal would keep, the CLI MUST state in `kept` why removal would keep it.

**Tests:** `device/folders-unmatched.test.ts › lists them, and says which removing would keep`, `device/folders-unmatched.test.ts › keeps a file as the folder wrote it while a write to its item waits to be sent, and removes it once sent`.

### `folders/unmatched-list-beside-watch`

While another process watches a folder, the CLI MUST answer `folders unmatched` without `--remove` without acquiring the folder's working handle.

**Reason:** like `folders status`, listing reads the store and changes nothing.

**Tests:** `device/folders-unmatched.test.ts › lists beside a running watch, which holds the folder`.

### `folders/unmatched-remove-terminal-question`

When `folders unmatched --remove` is run at a terminal without `--yes` or `--json`, the CLI MUST ask for confirmation before it removes a file.

**Tests:** `device/folders-unmatched.test.ts › asks at a terminal before removing, and obeys %s`.

### `folders/unmatched-remove-terminal-answer`

When `folders unmatched --remove` asks for confirmation at a terminal, the CLI MUST remove files only for the answer `y` or `yes` without regard to case.

**Tests:** `device/folders-unmatched.test.ts › asks at a terminal before removing, and obeys %s`.

### `folders/unmatched-remove-yes`

When `folders unmatched --remove` is given `--yes`, the CLI MUST remove the files it may without asking for input.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › refuses to remove anything without a terminal and without --yes`.

### `folders/unmatched-remove-no-terminal`

If `folders unmatched --remove` is run with neither a terminal nor `--yes`, then the CLI MUST refuse with `usage`.

**Reason:** a script that has not said `--yes` has not agreed.

**Tests:** `device/folders-unmatched.test.ts › refuses to remove anything without a terminal and without --yes`.

### `folders/unmatched-remove-no-terminal-kept`

If `folders unmatched --remove` is refused for lack of a terminal and `--yes`, then a device MUST NOT remove a file or queue the end of a placement.

**Tests:** `device/folders-unmatched.test.ts › refuses to remove anything without a terminal and without --yes`.

### `folders/unmatched-remove-file`

When removal of an unmatched file is confirmed and the file may be removed, a device MUST delete the file from the directory.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › asks at a terminal before removing, and obeys %s`.

### `folders/unmatched-remove-placement`

When removal of an unmatched file is confirmed and the file is removed, a device MUST queue the deletion of the folder's `in-folder` edge for the file's item.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`.

### `folders/unmatched-remove-item-unchanged`

When removal of an unmatched file is confirmed and the file is removed, a device MUST NOT queue a write to the file's item.

**Reason:** removing the file ends the folder's placement of the item and nothing else; the item stays in Marfa as it was.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`.

### `folders/unmatched-remove-edited-kept`

When an unmatched file holds bytes other than those the device last wrote, a device MUST keep the file when asked to remove unmatched files.

**Reason:** the bytes are the person's.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › goes on with the rest where a file was deleted or changed by hand while it asked`, `device/folders-unmatched.test.ts › keeps a file saved just as its removal reached it, and the next push places it again`.

### `folders/unmatched-remove-waiting-kept`

While the item of an unmatched file has a write waiting to be sent, a device MUST keep the file when asked to remove unmatched files.

**Reason:** removing the file would end its placement while an edit of it is still on its way.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › keeps a file as the folder wrote it while a write to its item waits to be sent, and removes it once sent`.

### `folders/unmatched-remove-kept-reported`

When an unmatched file named for removal is kept, a device MUST report the file with its reason in `kept`.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › goes on with the rest where a file was deleted or changed by hand while it asked`, `device/folders-unmatched.test.ts › keeps a file saved just as its removal reached it, and the next push places it again`.

### `folders/unmatched-remove-gone-kept`

If an unmatched file is missing from the directory when its removal is reached, then a device MUST report the file in `kept`.

**Reason:** a missing file is the scan's to settle (`folders/unmatched-missing-not-rewritten`).

**Tests:** `device/folders-unmatched.test.ts › goes on with the rest where a file was deleted or changed by hand while it asked`.

### `folders/unmatched-remove-gone-continues`

If an unmatched file is missing from the directory or has changed when its removal is reached, then a device MUST go on to remove the other files named.

**Tests:** `device/folders-unmatched.test.ts › goes on with the rest where a file was deleted or changed by hand while it asked`.

## Paused removals, size and status

### `folders/removal-threshold`

When a folder assesses a large removal, a device MUST pause it only when its file count exceeds both `removal_threshold.files` and `removal_threshold.fraction` of bound files, defaulting to 10 and 0.25.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders.test.ts › follows the settings' removal threshold`, `device/folders-contract-b.test.ts › pauses only past both default removal thresholds ($missing of $total)`.

### `folders/disk-removal-paused`

When missing folder files exceed the large-removal threshold, including files still inside the grace period, a device MUST count the missing files as `paused`.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders.test.ts › says a paused removal once while watching`.

### `folders/disk-removal-paused-deletions-unsent`

When missing folder files exceed the large-removal threshold, including files still inside the grace period, a device MUST NOT send their deletions.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders.test.ts › says a paused removal once while watching`.

### `folders/pull-removal-paused`

When owned folder files eligible for removal after their items depart exceed the large-removal threshold, a device MUST retain those files.

**Tests:** `device/folders.test.ts › pauses a large removal from another device`, `device/folders-contract-b.test.ts › confirms a paused pull removal of %s items`.

### `folders/pull-removal-paused-paused-count`

When owned folder files eligible for removal after their items depart exceed the large-removal threshold, a device MUST count those files as `paused`.

**Tests:** `device/folders.test.ts › pauses a large removal from another device`, `device/folders-contract-b.test.ts › confirms a paused pull removal of %s items`.

### `folders/confirm-moves-first`

When a paused disk removal is confirmed, a device MUST check other folders for each missing file.

**Tests:** `device/folders-one-mac.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folders/confirm-moves-first-moved-count`

When a paused disk removal is confirmed, a device MUST count a file found moved as `moved`.

**Tests:** `device/folders-one-mac.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folders/confirm-moves-first-item-preserved`

When a paused disk removal is confirmed, a device MUST NOT trash an item whose file was found moved.

**Tests:** `device/folders-one-mac.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folders/confirm-returned-file`

When a missing file returns before its paused removal is confirmed, a device MUST leave that file’s item undeleted.

**Tests:** `device/folders-contract-b.test.ts › does not confirm a paused deletion for a file put back since the pause`.

### `folders/confirm-uncertain-file`

When a paused disk removal is confirmed but an unavailable peer folder prevents ruling out a move, a device MUST leave the file’s item undeleted.

**Tests:** `device/folders-contract-b.test.ts › keeps confirmed missing files unsure while another registered folder is unavailable`.

### `folders/confirm-uncertain-file-unsure-count`

When a paused disk removal is confirmed but an unavailable peer folder prevents ruling out a move, a device MUST report the file in `unsure` for a later pass.

**Tests:** `device/folders-contract-b.test.ts › keeps confirmed missing files unsure while another registered folder is unavailable`.

### `folders/confirm-deletes-queued`

When a paused disk removal is confirmed and a missing file is found in no other folder, a device MUST queue deletion of the item for the next push.

**Tests:** `device/folders.test.ts › lets a paused removal go once confirmed, or puts it back`, `device/folders-one-mac.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folders/confirm-pull-removes`

When a paused pull removal is confirmed and the files still contain their folder’s written bytes, a device MUST remove the departed files.

**Tests:** `device/folders-contract-b.test.ts › confirms a paused pull removal of %s items`.

### `folders/confirm-pull-removes-removed-count`

When a paused pull removal is confirmed and the files still contain their folder’s written bytes, a device MUST count the departed files as `removed`.

**Tests:** `device/folders-contract-b.test.ts › confirms a paused pull removal of %s items`.

### `folders/restore-disk-files`

When a paused disk removal is restored and the missing files’ items still match the folder’s search, a device MUST write the missing files back from the held copy.

**Tests:** `device/folders.test.ts › lets a paused removal go once confirmed, or puts it back`.

### `folders/restore-disk-files-put-back-count`

When a paused disk removal is restored and the missing files’ items still match the folder’s search, a device MUST count the missing files as `put_back`.

**Tests:** `device/folders.test.ts › lets a paused removal go once confirmed, or puts it back`.

### `folders/restore-departed-binding`

When a paused disk removal is restored and a missing file’s item is absent or outside the search’s states, a device MUST release that file’s binding.

**Tests:** `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`.

### `folders/restore-departed-binding-not-put-back`

When a paused disk removal is restored and a missing file’s item is absent or outside the search’s states, a device MUST NOT count that missing file as put back.

**Tests:** `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`.

### `folders/restore-departed-binding-item-preserved`

When a paused disk removal is restored and a missing file’s item is absent or outside the search’s states, a device MUST NOT delete that missing file’s item.

**Tests:** `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`.

### `folders/restore-unmatched-count`

When a paused disk removal is restored and a missing file’s item left the search for a non-state reason, a device MUST leave the missing file for normal deletion handling.

**Tests:** `device/folders-contract-b.test.ts › does not count a missing unmatched file as put back when restoring a removal`.

### `folders/restore-unmatched-count-not-put-back`

When a paused disk removal is restored and a missing file’s item left the search for a non-state reason, a device MUST NOT count the missing file as put back.

**Tests:** `device/folders-contract-b.test.ts › does not count a missing unmatched file as put back when restoring a removal`.

### `folders/restore-embedded-departure`

When restoring a disk removal releases an archived file’s old binding but a held document still embeds that file, a device MUST write the embedded file anew.

**Tests:** `device/folders-contract-b.test.ts › writes an archived embedded file anew without counting it as put back`.

### `folders/restore-embedded-not-put-back`

When restoring a disk removal releases an archived file’s old binding but a held document still embeds that file, a device MUST NOT count the newly written embedded file as put back.

**Tests:** `device/folders-contract-b.test.ts › writes an archived embedded file anew without counting it as put back`.

### `folders/restore-pull-items`

When a paused pull removal is restored, a device MUST queue restoration of trashed items or transition departed items into a state the folder search holds.

**Tests:** `device/folders-contract-b.test.ts › restores a paused pull removal of %s items into a held state`.

### `folders/pause-said`

When a folder push reports a paused disk or pull removal, the CLI MUST state the paused count and name `folders confirm` and `folders restore` as the ways to resolve it.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders-contract-b.test.ts › says a pull-side removal waits in push output with both ways to resolve it`.

### `folders/pause-watch-once`

While a paused folder removal remains unchanged, the CLI MUST say its watch notice only once.

**Tests:** `device/folders.test.ts › says a paused removal once while watching`.

### `folders/size-warning`

When a folder scan admits a new or edited document whose JSON-encoded text reaches 943718 bytes, a device MUST include a `size` warning naming that path and size.

**Tests:** `device/folders.test.ts › warns of a text near the limit`, `device/folders-contract-b.test.ts › warns at the exact JSON-encoded size boundary including escaped text`.

### `folders/size-warning-said`

When a folder push scans a document with a size warning, the CLI MUST say the path and warning in words.

**Tests:** `device/folders.test.ts › warns of a text near the limit`.

### `folders/request-too-large-bytes-kept`

When the server refuses a folder document create or edit with `413 request_too_large`, a device MUST retain the document’s bytes.

**Tests:** `device/folders-contract-b.test.ts › preserves a document after a request-too-large %s refusal`.

### `folders/request-too-large-edit-held`

When the server refuses a folder document edit with `413 request_too_large`, a device MUST report its file as held with the refusal.

**Tests:** `device/folders-contract-b.test.ts › preserves a document after a request-too-large %s refusal`.

### `folders/request-too-large-create-lost`

When the server refuses a folder document create with `413 request_too_large` and the copy forgets the row, a device MUST hold its file under `folders/lost-row-unchanged-held` until the person changes or moves it.

**Tests:** `device/folders-contract-b.test.ts › preserves a document after a request-too-large %s refusal`.

### `folders/size-status-warning`

When a folder status reads a document near the fixed 1 MiB request limit, a device MUST include its size warning in the file’s status.

**Tests:** `device/folders.test.ts › warns of a text near the limit`.

### `folders/status-local`

When the CLI reads a folder’s status, the CLI MUST answer from the folder’s disk and local store without contacting the server.

**Tests:** `device/folders-contract-b.test.ts › reads status from disk and the held copy without contacting the server`.

### `folders/status-files`

When a device reads a folder’s status, a device MUST report each reached file and each bound file with its path, bound item ID when present, status and applicable waits or refusal reason.

**Tests:** `device/folders.test.ts › reports each file's status`.

### `folders/status-unreadable-document`

When a new folder document’s frontmatter cannot be parsed or names a refused own field, a device MUST report its status as `held` with flag `unreadable` before binding it.

**Tests:** `device/folders.test.ts › reports each file's status`.

### `folders/status-encoding`

When a new folder document is not UTF-8, a device MUST report its status as `held` with flag `encoding`.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/status-outside`

When a non-document file has no type held by the folder search, a device MUST report its status as `outside`.

**Tests:** `device/folders-contract-b.test.ts › reads status from disk and the held copy without contacting the server`.

### `folders/status-paused-counts`

When a device reads a folder’s status, a device MUST report paused disk and pull removals separately.

**Tests:** `device/folders.test.ts › pauses a large removal from another device`, `device/folders-contract-b.test.ts › pauses only past both default removal thresholds ($missing of $total)`.

### `folders/status-unreached`

When the folder’s lists exclude a bound file, a device MUST report its status as `unreached`.

**Tests:** `device/folders-contract-b.test.ts › reports a bound file as unreached when settings exclude it`.

### `folders/status-paused-purged`

When a purged folder item’s file is retained by the large-removal pause, a device MUST report its status with the `removal` flag and a reason identifying the purge as irreversible.

**Tests:** `device/folders-contract-b.test.ts › reports purged paused files without promising that restore can recover their items`.

### `folders/status-catalog-consistent`

When item and edge catalogs refresh during a folder status read, a device MUST use one consistent catalog revision for that status.

**Tests:** waiting on #1890.

## Watching and executable files

### `folders/watch-unchanged-unread`

When a watch scans a bound file whose identity, size, modification time and executable permission remain unchanged, with no held or lost-row condition requiring a read, a device MUST omit reading that file on a quick pass.

**Tests:** `device/folders.test.ts › does not reread an unchanged file`.

### `folders/full-pass-reads`

When a folder scan or push performs a full pass, a device MUST read a file whose bytes changed even if its size and modification time did not.

**Tests:** `device/folders.test.ts › finds a missed change on its full pass`.

### `folders/quick-copy-original-read`

When a quick folder scan reads a file carrying the ID of an otherwise skipped file, a device MUST read the original too before distinguishing the copy.

**Tests:** `device/folders.test.ts › tells a copy from its unread original on a quick pass`.

### `folders/scan-read-race-retried`

When a folder file changes while a watch scan reads it, a device MUST read it again at a subsequent pass rather than treat the concurrent save as already scanned.

**Tests:** waiting on #1890.

### `folders/watch-periodic-full-pass`

While a folder watch runs, a device MUST perform a full scan at its first pass and at the first pass after sixty seconds since the previous full scan.

**Tests:** waiting on #1890.

### `folders/executable-created`

When a folder admits a file item on a volume preserving executable permissions, a device MUST set `executable: true` if its owner can execute it and omit the property otherwise.

**Tests:** `device/folders.test.ts › keeps a file's executable permission`, `compliance/types.test.ts › declares executable on core.file, which every file type inherits`.

### `folders/executable-updated`

When a bound file’s executable permission changes on a volume preserving permissions, a device MUST queue an update carrying the new `executable` value even if the file’s bytes do not change.

**Tests:** `device/folders.test.ts › keeps a file's executable permission`.

### `folders/executable-pulled`

Where a device has established that the volume preserves executable permissions and the filesystem permits the change, when a folder pull writes a file item or updates an unchanged scanned file's permission, a device MUST apply the item's executable value by adding execute bits wherever read bits are set or clearing all execute bits after any quarantine marking required by `folders/quarantine-download` or `folders/quarantine-in-place` succeeds.

**Tests:** `device/folders.test.ts › gives a pulled file the permission its item holds`, `device/folders-contract-b.test.ts › applies execute bits only where each read bit is set`.

### `folders/executable-owner-edit-kept`

When a bound file’s executable permission changes after the folder scan read it, a device MUST preserve the person’s permission through a pull for the next scan to send.

**Tests:** `device/folders.test.ts › gives a pulled file the permission its item holds`.

### `folders/permission-probe-failed`

Where a volume does not preserve executable permissions or the folder cannot establish that it does, a device MUST leave executable permissions unchanged on the item.

**Tests:** `device/folders-contract-b.test.ts › leaves executable permissions alone when its permission probe fails`, `device/folders-contract-b.test.ts › leaves file and item executable values alone on an exFAT volume`.

### `folders/permission-probe-failed-file-preserved`

Where a volume does not preserve executable permissions or the folder cannot establish that it does, a device MUST leave executable permissions unchanged on the file.

**Tests:** `device/folders-contract-b.test.ts › leaves executable permissions alone when its permission probe fails`, `device/folders-contract-b.test.ts › leaves file and item executable values alone on an exFAT volume`.

### `folders/permission-write-refused`

When the filesystem refuses a folder pull’s executable-permission change, a device MUST leave the file’s permissions as they are.

**Tests:** `device/folders-contract-b.test.ts › keeps a file's permissions when a permission change is refused and continues pulling`.

### `folders/permission-write-refused-pull-continues`

When the filesystem refuses a folder pull’s executable-permission change, a device MUST continue pulling other files.

**Tests:** `device/folders-contract-b.test.ts › keeps a file's permissions when a permission change is refused and continues pulling`.

### `folders/quarantine-in-place`

Where a device runs on macOS, when a folder pull makes an existing file runnable, a device MUST apply quarantine before enabling execution.

**Tests:** `device/folders-identity.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

### `folders/quarantine-failure-new-file`

Where a device runs on macOS, when quarantine marking fails for downloaded file bytes, a device MUST refuse to publish the file.

**Tests:** `device/folders-contract-b.test.ts › refuses a new downloaded file when quarantine marking fails and retries it`.

### `folders/quarantine-failure-unwritten`

Where a device runs on macOS, when quarantine marking fails for downloaded file bytes, a device MUST count the file as `unwritten`.

**Tests:** `device/folders-contract-b.test.ts › refuses a new downloaded file when quarantine marking fails and retries it`.

### `folders/quarantine-failure-existing-file`

Where a device runs on macOS, when quarantine marking fails before making an existing folder file runnable, a device MUST retain the file’s existing permissions.

**Tests:** `device/folders-contract-b.test.ts › keeps an existing file nonexecutable when quarantine marking fails`.

### `folders/quarantine-download`

Where a device runs on macOS, when a folder pull writes a file item from server bytes, a device MUST apply `com.apple.quarantine` before the file lands.

**Tests:** `device/folders-identity.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

### `folders/document-not-quarantined`

Where a device runs on macOS, when a folder pull renders a document, a device MUST NOT mark the document with download quarantine.

**Tests:** `device/folders-identity.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

### `folders/busy-watch-progress`

While a folder receives changes more frequently than its settle window, a device MUST continue watch passes that send other files.

**Tests:** `device/folders.test.ts › keeps syncing both ways while a file changes twice a second`, `device/folders.test.ts › sends a file being copied in only once it stops changing, while every other file goes on`.

### `folders/busy-watch-progress-server-changes`

While a folder receives changes more frequently than its settle window, a device MUST continue watch passes that apply server changes.

**Tests:** `device/folders.test.ts › keeps syncing both ways while a file changes twice a second`, `device/folders.test.ts › sends a file being copied in only once it stops changing, while every other file goes on`.

### `folders/watch-settle-ceiling`

When five seconds have elapsed since a folder watch’s previous pass ended, a device MUST start the next pass at its next wake without waiting for the folder to settle.

**Tests:** waiting on #1890.

### `folders/binary-waits-for-settle`

When a non-document file changes within the folder watch’s 250-millisecond settle window, a device MUST defer reading its bytes until a later pass after it settles.

**Tests:** `device/folders.test.ts › sends a file being copied in only once it stops changing, while every other file goes on`.

### `folders/settling-rename-identity`

When a non-document file is renamed while its bytes are still settling, a device MUST preserve the file’s item identity at its renamed path.

**Tests:** `device/folders-placement.test.ts › keeps the item of a renamed file that is still settling (replacement %s)`.

### `folders/settling-rename-identity-bytes-not-read`

When a non-document file is renamed while its bytes are still settling, a device MUST NOT read the changing bytes.

**Tests:** `device/folders-placement.test.ts › keeps the item of a renamed file that is still settling (replacement %s)`.

### `folders/still-changing-notice`

While a folder file never settles enough for the watch to read it, the CLI MUST say once that the file is still changing and has not been sent.

**Tests:** `device/folders.test.ts › says once that a file which never stops changing has not been sent`.

### `folders/watch-answered-waiting`

When a folder watch reports a pass, the CLI MUST distinguish answered writes from writes still waiting.

**Tests:** `device/folders.test.ts › says once that a watch cannot reach the server, and once that it can again`.

### `folders/watch-unreachable-once`

When a folder watch loses or regains access to the server, the CLI MUST say the reachability change once without repeating it while unchanged.

**Tests:** `device/folders.test.ts › says once that a watch cannot reach the server, and once that it can again`.

### `folders/watch-reachability-details`

When a folder watch reports that its server cannot be reached, the CLI MUST identify the server and the reason in that notice.

**Tests:** `device/folders.test.ts › says once that a watch cannot reach the server, and once that it can again`, `device/folders.test.ts › waits out a gateway refusing its key, naming no contract, without stopping`.

### `folders/watch-hydration-notice`

While a folder watch retries an environmentally failed hydration, the CLI MUST say the failure once for that run of failures.

**Tests:** `device/folders.test.ts › keeps watching through a hydration that failed, and tries it again`.

### `folders/push-stopped-reason`

When a folder push’s drain stops, the CLI MUST say why it stopped.

**Tests:** `device/folders.test.ts › says why a push's drain stopped`.

### `folders/watch-stopped-reason`

When a folder watch's drain has a new or changed stop reason, the CLI MUST say why it stopped.

**Tests:** `device/folders.test.ts › stops a watch whose credential is refused, with the credential's exit`.

### `folders/watch-credential-exit`

When a folder watch receives the server’s contract-named credential refusal, the CLI MUST end the watch with exit code 5.

**Tests:** `device/folders.test.ts › stops a watch whose credential is refused, with the credential's exit`.

### `folders/watch-credential-exit-reason-said`

When a folder watch receives the server’s contract-named credential refusal, the CLI MUST say that writes wait for a working credential.

**Tests:** `device/folders.test.ts › stops a watch whose credential is refused, with the credential's exit`.

### `folders/gateway-refusal-waited`

When a folder watch receives `401` without the server’s contract header, a device MUST retry as an environmental failure instead of treating the credential as refused.

**Tests:** `device/folders.test.ts › waits out a gateway refusing its key, naming no contract, without stopping`.

### `folders/watch-grace-silent`

When a `folders watch` pass only waits for a journaled deletion's grace period to end, the CLI MUST produce no report for that pass.

**Tests:** `device/folders.test.ts › says nothing for passes that only wait out a delete's grace`.

### `folders/watch-notice-once`

When a `folders watch` pass reports new activity, the CLI MUST NOT repeat a standing notice unchanged since the preceding pass.

**Tests:** `device/folders.test.ts › says a refused secret once while a delete waits out its grace and other passes report`.

### `folders/watch-notice-change`

When a standing notice changes during `folders watch`, the CLI MUST report the changed notice in the pass that observes it.

**Tests:** `device/folders.test.ts › says a refused secret in words once while watching`.

### `folders/admitted-directory-capability`

When a folder directory is admitted, a device MUST retain that opened directory as the authority for traversal, reads, writes, publication, storage, and cleanup until the operation ends.

**Reason:** A pathname can name a replacement directory after admission.

**Tests:** `device/folders-contract-a.test.ts › ignores a replacement installed at %s`, `device/folders-contract-a.test.ts › leaves replacement state untouched when the root changes before its store opens`, `device/folders-contract-a.test.ts › ignores replacement settings installed immediately before their read`, `device/folders-contract-a.test.ts › leaves every replacement byte intact at %s`.

### `folders/directory-components-no-follow`

When opening a folder or any directory below it, a device MUST refuse a symbolic link at the folder's own directory entry, in every path component below it, and in every path component that a later `..` climbs back out of.

**Tests:** `device/folders-one-mac.test.ts › admits parent components without skipping a preceding symlink`, `device/folders-one-mac.test.ts › refuses a folder reached through a symlink and preserves its registry identity`, `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`, `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses a folder named through a link that a later parent component climbs back out of`.

### `folders/root-linked-ancestor-resolved`

When a folder is added through a path in which every symbolic link is a directory above the folder that no later `..` climbs back out of, and every directory that a `..` climbs back out of exists, a device MUST admit the folder at the path with those links resolved.

**Reason:** The directories above a folder are outside it and belong to the person, and the operating system links some of them, such as `/var` and `/tmp` on macOS.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`.

### `folders/linked-path-reaches-folder`

When a command other than an add or a removal names an existing folder by a path that the machine’s folder registry does not list, in which every symbolic link is a directory above the folder that no later `..` climbs back out of, every directory that a `..` climbs back out of exists, and no listed folder path reaches the same directory only through a symbolic link, a device MUST work the folder at the path with those links resolved.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`.

### `folders/ambiguous-path-refused`

If a command other than an add or a removal names a folder by a path that the machine’s folder registry does not list, and a listed folder path reaches the same directory only through a symbolic link, then a device MUST refuse the path with `invalid`.

**Reason:** The path could mean the folder at that directory or the listed folder whose directory the link replaced.

**Tests:** `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`.

### `folders/listed-link-refused`

If a symbolic link now stands in the path at which the machine’s folder registry lists a folder, then a device MUST refuse every command other than an add or a removal that names the folder by that path with `invalid`.

**Tests:** `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`.

### `folders/listed-link-refusal-names-other`

If a device refuses a path because a symbolic link now stands in the path at which the machine’s folder registry lists a folder, and that listed path now leads to the directory of another listed folder, then a device MUST name the other folder's listed path in the refusal's message.

**Reason:** The person can then tell that the directory the link leads to holds another folder, not the one the path names.

**Tests:** `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`, `cli/folder.test.ts › names the listed folder a link has replaced, and the other folder it leads to, when refusing its path`.

### `folders/listed-link-refusal-no-redirect`

If a device refuses a path because the path's own directory entry, or one that a later `..` climbs back out of, is a symbolic link, and a path at which the machine’s folder registry lists a folder reaches some directory only through a symbolic link, then a device MUST NOT give that directory, or a directory inside it, in the refusal's message as the one to name instead.

**Reason:** Where a link has replaced the listed folder's directory or a directory above it, the listed path, and any link or chain of links the person made to it or to a directory inside it, can lead to another folder's directory. A person following the advice would then work on that folder, such as by removing its state.

**Tests:** `cli/folder.test.ts › names the listed folder a link has replaced, and the other folder it leads to, when refusing its path`, `cli/folder.test.ts › never offers the directory a relinked listing now leads to when refusing a link to that listing`, `cli/folder.test.ts › never offers a folder inside the directory a relinked listing now leads to when refusing a link into that listing`.

### `folders/root-link-refused-invalid`

If a folder is named through a path with a symbolic link at the folder's own directory entry, in a path component below it, or in a path component that a later `..` climbs back out of, other than to remove the folder by the path at which the machine’s folder registry lists it, then a device MUST refuse the path with `invalid`.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses a folder named through a link that a later parent component climbs back out of`.

### `folders/root-link-refusal-named`

If a folder is named through a path with a symbolic link at the folder's own directory entry, in a path component below it, or in a path component that a later `..` climbs back out of, other than to remove the folder by the path at which the machine’s folder registry lists it, and no earlier `..` climbs back out of a directory that does not exist, then a device MUST name the first such link in the refusal's message.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses a folder named through a link that a later parent component climbs back out of`.

### `folders/root-missing-climb-refused`

If a folder is named through a path in which a `..` climbs back out of a directory that does not exist, then a device MUST refuse the path with `invalid`.

**Reason:** Such a path cannot be checked without creating the directory it climbs out of.

**Tests:** `cli/folder.test.ts › refuses a path that climbs out of a directory that does not exist, and makes nothing`.

### `folders/root-missing-climb-creates-nothing`

If a folder is named through a path in which a `..` climbs back out of a directory that does not exist, then a device MUST NOT create any directory on that path.

**Tests:** `cli/folder.test.ts › refuses a path that climbs out of a directory that does not exist, and makes nothing`.

### `folders/replacement-root-no-deletion`

While the admitted root or its state directory is absent or replaced, a device MUST suppress missing-file and deletion conclusions.

**Tests:** `device/folders-contract-a.test.ts › ignores a replacement installed at %s`, `device/folders-contract-a.test.ts › reports root_gone and ignores a replacement directory while watching`.

### `folders/cleanup-retains-empty-directories`

When a folder's removal deletes its administrative state, a device MUST clear the state's files through retained directories without removing the directory entries themselves.

**Reason:** Checking a child's identity and then removing its pathname cannot atomically exclude a replacement child. Empty administrative directories retain no folder state.

**Tests:** `device/folders-contract-a.test.ts › leaves every replacement byte intact at %s`, `device/folders.test.ts › is canceled by removing the folder, which leaves its files`.

### `folders/empty-state-not-nested-folder`

When a directory contains an empty `.marfa` directory without `core.sqlite`, a device MUST admit its eligible contents as ordinary folder contents.

**Tests:** `device/folders-contract-a.test.ts › admits contents beside empty administrative directories`.

### `folders/root-birth-identity-required`

When a folder root has no usable nonzero birth timestamp, a device MUST refuse admission before creating administrative state.

**Reason:** Reopening an entry by device and inode alone cannot exclude inode reuse after the original descriptor closes.

**Tests:** `device/folders-contract-a.test.ts › refuses a root with %s birth identity before creating administrative state`.

## Remote sync reports

### `folders/report-copy`

When a device reports a folder's sync health to `PUT /folders/{id}/status`, a device MUST name the existing opaque folder-store identity of that local copy as `folder_store_id`.

**Tests:** `device/folder-health.test.ts › reports a confirmed complete sync using the registry's opaque copy identity`.

### `folders/report-fields`

When a device reports a folder's sync health, a device MUST send only `folder_store_id`, `sequence`, `last_success_at`, `pending_uploads`, `pending_downloads`, `paused_removals`, `first_sync_waiting`, and the safe problem counts accepted by `folder-status/problem-codes`.

**Tests:** `device/folder-health.test.ts › reports a confirmed complete sync using the registry's opaque copy identity`.

### `folders/report-full-success`

When a confirmed folder sync completes with a complete readable inventory and without pending uploads, pending downloads, paused removals, first-sync waiting, or current problems, a device MUST report its completion time in `last_success_at`.

**Tests:** `device/folder-health.test.ts › reports a confirmed complete sync using the registry's opaque copy identity`.

### `folders/report-unreadable-inventory`

When a folder scan cannot read a directory, a device MUST include that directory in its `unreadable` problem count independently of whether any file beneath it is bound.

**Tests:** `device/folder-health.test.ts › reports an unreadable unbound directory as incomplete inventory and clears it after readable recovery`.

### `folders/report-incomplete-counts`

While a folder inventory is incomplete, a device MUST preserve its previously observed pending-upload count unless newly observed pending work increases it.

**Reason:** a readable scan is needed to recompute the count, because hidden files may have changed.

**Tests:** `device/folder-health.test.ts › preserves a nonzero known upload count while an unreadable inventory hides unbound files`.

### `folders/report-dead-work`

While a bound file has unresolved effects from a dead queued write, a device MUST include that file in its pending-upload count.

**Reason:** the queue's retry ceiling does not make the held content synchronized; superseded effects follow `queue-and-verdicts/dead-covered-effects`.

**Tests:** `device/folder-health.test.ts › keeps dead file effects current until an accepted replacement, survives clear and restart, and restores them on release`.

### `folders/report-first-waiting`

While a folder's first sync awaits confirmation, a device MUST report `first_sync_waiting: true`.

**Tests:** `device/folder-health.test.ts › reports first-sync waiting without claiming a successful content pass`.

### `folders/report-success-none`

While no fully successful folder sync has completed, a device MUST report `last_success_at: null`.

**Tests:** `device/folder-health.test.ts › reports first-sync waiting without claiming a successful content pass`.

### `folders/report-send-only`

When `folders push --send-only` finishes, a device MUST NOT advance `last_success_at`.

**Reason:** a run that caught up with nothing and pulled nothing is not a complete sync.

**Tests:** `device/folder-health.test.ts › does not report a send-only run as a full success, where a push that pulls does`.

### `folders/report-independent`

If delivery of a folder-health report fails, then a device MUST preserve the successful outcome of the content sync independently of that failure.

**Tests:** `device/folder-health.test.ts › preserves successful content sync when reporting fails and coalesces across CLI restarts`, `device/contract.test.ts › rejects a health receipt on another contract without stopping content or learning its sequence floor`.

### `folders/report-coalesces`

When a device produces newer folder-health observations while reporting is unavailable, a device MUST retain its latest unsent observations across process restarts for a later reporting attempt.

**Tests:** `device/folder-health.test.ts › preserves successful content sync when reporting fails and coalesces across CLI restarts`.

### `folders/report-sequence`

When a device produces a newer report for the same folder copy and sign-in, a device MUST send a sequence greater than the previous report's sequence.

**Tests:** `device/folder-health.test.ts › preserves successful content sync when reporting fails and coalesces across CLI restarts`.

### `folders/report-distinct-copies`

When two local directories follow the same folder under the same sign-in, a device MUST report them under distinct existing folder-store identities.

**Tests:** `device/folder-health.test.ts › distinguishes two directories following the same folder and sign-in`.

### `folders/report-offline-success`

When a folder content pass cannot contact the server, a device MUST preserve its last fully successful sync time independently of whether the local write queue is empty.

**Tests:** `device/folder-health.test.ts › does not advance last full success after an offline push with an empty queue`.

### `folders/report-sequence-recovery`

When a folder-health receipt reports a stored sequence at least as high as the device's rejected report, a device MUST publish its newest local observations under a greater sequence.

**Reason:** a restored local backup can be behind the report already held by the server.

**Tests:** `device/folder-health.test.ts › refreshes the newest local observation above a restored backup sequence`.

## Where a folder sits

A storage warning is one line on standard error that begins `marfa: warning: ` and names the cause. A folder is warned of when `folders add` makes it and when a watch starts on it, whether `folders watch` names the folder or watches every folder. The home directory is the one the operating system records for the user, or the one `HOME` names. Refusing such a folder is not a rule.

### `folders/icloud-storage-warns`

When a folder is added, or a watch starts on a folder, whose directory is below `Library/Mobile Documents` in the home directory, the CLI MUST print a storage warning that names iCloud Drive.

**Reason:** iCloud Drive syncs those files itself, so a second program syncs the same files as Marfa and the two can overwrite each other’s changes or leave conflicting copies.

**Tests:** `device/folders-storage-warning.test.ts › warns once on standard error when it is added to iCloud Drive, and adds it all the same`, `› warns once on standard error when a watch starts on a folder in iCloud Drive, and watches all the same`, `› warns of a synced folder whose first sync waits only once its watch has started, after the first sync is confirmed`.

### `folders/icloud-ubiquitous-warns`

When a folder is added, or a watch starts on a folder, whose directory is not below `Library/Mobile Documents` or `Library/CloudStorage` in the home directory and that macOS reports as ubiquitous (the URL resource key `isUbiquitousItem`), the CLI MUST print a storage warning that names iCloud Drive or another cloud service’s synced location.

**Reason:** With iCloud’s “Desktop & Documents” on, `Desktop` and `Documents` are real directories outside `Library/Mobile Documents` that iCloud Drive syncs. macOS reports every File Provider item as ubiquitous, so the key alone does not say which service syncs it.

**Tests:** waiting on #2027.

### `folders/cloud-storage-warns`

When a folder is added, or a watch starts on a folder, whose directory is below `Library/CloudStorage` in the home directory, the CLI MUST print a storage warning that names a cloud service’s synced location.

**Reason:** The File Provider services (such as Dropbox, OneDrive, Google Drive and Box) keep their files there and sync them themselves, with the same effect as iCloud Drive.

**Tests:** `device/folders-storage-warning.test.ts › warns once on standard error when it is added to a cloud service's synced location, and adds it all the same`, `› warns once on standard error when a watch starts on a folder in a cloud service's synced location, and watches all the same`.

### `folders/network-storage-warns`

When a folder is added, or a watch starts on a folder, whose directory is on a file system that `statfs` reports as `smbfs`, `nfs`, `afpfs` or `webdav` on macOS, or as the NFS (0x6969), CIFS (0xFF534D42) or SMB2 (0xFE534D42) file system type on Linux, the CLI MUST print a storage warning that names the file system type and says that a change made from another computer may not be noticed.

**Reason:** A network file system may not send change notifications for what another computer writes.

**Tests:** waiting on #2027.

### `folders/storage-warning-continues`

If the CLI prints a storage warning, then the CLI MUST add the folder or watch it as it would a directory elsewhere.

**Reason:** The warning informs the person; refusing such a folder is not a rule.

**Tests:** `device/folders-storage-warning.test.ts › warns once on standard error when it is added to iCloud Drive, and adds it all the same`, `› warns once on standard error when a watch starts on a folder in iCloud Drive, and watches all the same`.

### `folders/storage-warning-once`

While a command runs, the CLI MUST NOT print a storage warning for the same folder more than once.

**Reason:** A watch of every folder starts a folder’s watch again after it ends or after the folder is listed again.

**Tests:** `device/folders-storage-warning.test.ts › warns once per synced folder, and not again when a folder is taken off the list and put back`.

### `folders/storage-warning-elsewhere`

While a folder’s directory is not below `Library/Mobile Documents` or `Library/CloudStorage` in the home directory, is not one that macOS reports as ubiquitous, and is on none of the file systems that `folders/network-storage-warns` names, the CLI MUST NOT print a storage warning for it.

**Tests:** `device/folders-storage-warning.test.ts › prints no warning when it is added or watched, where the same home warns of a synced one`, `› is not taken for a synced one by a name that only begins like a synced location`.

### `folders/storage-warning-json`

Where `--json` is given, the CLI MUST print a storage warning on standard error and not in the JSON on standard output.

**Reason:** A program reading standard output gets only JSON, as it does when the CLI warns of a plain `http` address.

**Tests:** `device/folders-storage-warning.test.ts › keeps standard output to its JSON document under --json, with the warning a plain line on standard error`.
