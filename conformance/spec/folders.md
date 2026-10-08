# Folders

A folder is a directory bound to a `system.folder` item, with a working copy and a queue. The device and queue rules also apply (`device.md`, `queue-and-verdicts.md`).

## Binding and settings

### `folders/bind-folder`

When a directory is added as a folder, a device MUST bind it to the named `system.folder` using the settings read from that item.

**Tests:** `device/folders.test.ts › reads its settings from the system.folder it is bound to`.

### `folders/bind-live-folder`

If the named item is not a live `system.folder`, then the command MUST refuse `folders add`.

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

### `folders/settings-refused-bytes`

When a settings edit is refused, a device MUST preserve the edited file.

**Tests:** `device/folders-contract-a.test.ts › holds a settings edit refused with status %s without resending its text`.

### `folders/settings-refusal-report`

When a settings edit is refused, a device MUST report the reason in `settings.flagged`.

**Tests:** `device/folders.test.ts › keeps its settings in force and flags the file when an edit is refused`, `device/folders-contract-a.test.ts › holds a settings edit refused with status %s without resending its text`.

### `folders/settings-refusal-words`

When a push or pull reports a refused settings edit, the command MUST say that the edited settings are not in force.

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

If the key cannot read `system.folder`, then the command MUST refuse `folders add` naming `system.folder:read`.

**Tests:** `device/folders.test.ts › refuses to follow settings its key cannot read, naming the permission`.

### `folders/settings-readd-replaces`

When the same folder is added again to its directory, a device MUST replace the settings file with the settings in force, including over an unsent edit.

**Tests:** `device/folders-contract-a.test.ts › replaces an unsent settings edit when the same folder is added again`.

### `folders/settings-watch-refusal`

When a settings edit is refused during a watch, the command MUST say why the edited settings are not in force.

**Tests:** `device/folders-contract-a.test.ts › tells a watch why a settings edit is not in force`.

### `folders/settings-omission-advice`

When a current settings file omits a setting, a device MUST advise writing an empty list or map instead of removing the setting.

**Tests:** `device/folders-contract-a.test.ts › advises empty values when an edit removes a current setting`.

### `folders/settings-watch-slice-delay`

When the settings change to require another slice during a running watch, a device MUST defer hydration of that slice until the next push or watch restart.

**Tests:** `device/folders-contract-a.test.ts › hydrates a changed watch slice at the next push rather than during the watch`.

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

**Tests:** `device/folders.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folders/default-explicit-tags`

When a new document names tags explicitly, including an empty list, a device MUST use those tags instead of default tags.

**Tests:** `device/folders.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

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

When the command lists the machine's folders, a device MUST include every registered folder's directory and `system.folder` ID.

**Tests:** `device/folders.test.ts › lists the folders on the Mac in one registry`.

### `folders/empty-directory`

When a folder is added to an empty directory, a device MUST materialize the held items during pull.

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

### `folders/registry-store-identity`

When a folder is registered, a device MUST record its store identity beside its directory and folder ID in the machine registry.

**Tests:** `device/folders-contract-a.test.ts › records each folder's distinct store identity in the shared registry`.

## Document fields and presentation

### `folders/own-field-lines`

When a device reads a Markdown file, a device MUST interpret `type`, `tier`, `tags`, `state`, and `occurred_at` as the item's own fields rather than properties.

**Tests:** `device/folders.test.ts › reads type, tags, tier and state as the item's own`, `device/folders.test.ts › sets a new item's own time, from a date or from a date and time`.

### `folders/property-lines`

When a Markdown frontmatter line names neither an own field, metadata line, nor an edge type or reverse name, a device MUST carry it as a property, including undeclared and nested values.

**Tests:** `device/folders.test.ts › carries frontmatter to properties and the body to the body`.

### `folders/body-property`

When a device reads or writes a document, a device MUST use the type's resolved `body_field` as the body property, falling back to `body`.

**Tests:** `device/folders.test.ts › takes body and title from the type's display hints`, `device/folders.test.ts › takes the display hints of the nearest type that declares any, whole, as the server resolves them`.

### `folders/title-property`

When a device derives a document title from its filename or a filename from its title, a device MUST use the type's resolved `title_field`, falling back to `title`.

**Tests:** `device/folders.test.ts › takes body and title from the type's display hints`, `device/folders.test.ts › takes the display hints of the nearest type that declares any, whole, as the server resolves them`.

### `folders/body-over-line`

When a document has a frontmatter line for its current body property, a device MUST use the body in preference to that line, except during a retype to a different body property.

**Tests:** `device/folders.test.ts › carries frontmatter to properties and the body to the body`.

### `folders/uncarried-report`

When a held type declares properties reserved for document own fields, metadata, or edge lines, a device MUST list those type/property pairs in the pull's `uncarried` report.

**Tests:** `device/folders.test.ts › reports a type that declares a property no file can carry, and keeps it`.

### `folders/uncarried-preserve`

When a document is edited, a device MUST preserve item properties that cannot be carried as document properties.

**Tests:** `device/folders.test.ts › reports a type that declares a property no file can carry, and keeps it`.

### `folders/write-own-fields`

When a device renders a new Markdown file, a device MUST write `type` and `tier`, tags when present, and `state: archived` when the item is archived.

**Tests:** `device/folders.test.ts › reads type, tags, tier and state as the item's own`, `device/folders.test.ts › keeps an archived item's file with its state in the frontmatter`.

### `folders/own-field-order`

When a device renders a new Markdown file, a device MUST place own-field lines before the item properties, ordered `type`, `tier`, `tags`, `state`, and `occurred_at` for those present.

**Tests:** `device/folders.test.ts › keeps an archived item's file with its state in the frontmatter`, `device/folders-contract-a.test.ts › writes own fields in order before properties including an explicit time`.

### `folders/current-replaces-properties`

When a file names the copy's current item version, a device MUST send its properties as a replacement, clearing properties whose lines were removed.

**Tests:** `device/folders.test.ts › clears a property whose line was taken out of a versioned file`.

### `folders/current-after-own-write`

When a file's own edit lands before its version line is rewritten, a device MUST treat its next edit as current if the previously scanned content agrees with the item.

**Tests:** `device/folders.test.ts › sends a save right after its own edit lands as current`.

### `folders/current-after-unshown-change`

When the copy moves to a version that changes nothing shown by the file and no file edit waits, a device MUST treat the file's next own-field edit as current.

**Tests:** `device/folders.test.ts › takes an own-field change after a version step no file shows`.

### `folders/current-own-delta`

When a current file is saved, a device MUST send only own-field changes relative to the own-field lines it last wrote.

**Tests:** `device/folders.test.ts › takes an own-field change after a version step no file shows`, `device/folders.test.ts › sends nothing for a save that only reformats the frontmatter`.

### `folders/missing-tags-clears`

When a current file loses a `tags` line previously written by the device at that version, a device MUST remove those tags from the item.

**Tests:** `device/folders.test.ts › takes a versioned file's missing tags line as no tags, and a lineless file's as no change`.

### `folders/missing-state-active`

When a current file loses a `state: archived` line previously written by the device at that version, a device MUST restore the item to active.

**Tests:** `device/folders.test.ts › keeps an archived item's file with its state in the frontmatter`.

### `folders/unwritten-own-fields`

When a file omits own-field lines the device never wrote into it, a device MUST leave those own fields unchanged.

**Tests:** `device/folders.test.ts › reads a file the folder never wrote own lines into as leaving them as they are`, `device/folders.test.ts › takes a versioned file's missing tags line as no tags, and a lineless file's as no change`.

### `folders/behind-no-own-change`

When a file's version line is missing, ahead of the copy, or behind the copy for reasons other than its own accepted edit, a device MUST NOT send its own-field changes.

**Tests:** `device/folders.test.ts › sends no own-field change from an old buffer, and flags the lines it would have changed`, `device/folders.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folders/behind-flags-lines`

When a file behind the copy differs in own-field lines, a device MUST flag it `behind` naming the lines it did not send.

**Tests:** `device/folders.test.ts › sends no own-field change from an old buffer, and flags the lines it would have changed`, `device/folders.test.ts › sends no time from a file behind the item, and flags the line`.

### `folders/old-buffer-tags`

When an old buffer would reverse tags received from another device at the same item version, a device MUST NOT send that tag change.

**Tests:** `device/folders.test.ts › leaves a tag and an archive made elsewhere alone when an old buffer is saved`, `device/folders.test.ts › sends no tag change from an old buffer however many tag writes came at one version`.

### `folders/old-buffer-state`

When an old buffer would reverse an archive or restore received from another device, a device MUST NOT send that state change.

**Tests:** `device/folders.test.ts › leaves a tag and an archive made elsewhere alone when an old buffer is saved`, `device/folders.test.ts › does not re-archive from a buffer written before a restore elsewhere`, `device/folders.test.ts › does not re-archive from the buffer of an archive restored elsewhere`.

### `folders/own-tag-reversal`

When a person adds and then removes a tag through the same file at one item version, a device MUST send both changes.

**Tests:** `device/folders.test.ts › sends a tag the person adds and then takes out again at one version`.

### `folders/successive-saves`

When several property saves of one file are scanned before a drain, a device MUST preserve their order so the last save determines the resulting properties.

**Tests:** `device/folders.test.ts › keeps every save of three scanned before one drain`.

### `folders/presentation-no-write`

When a save changes only accepted presentation of a document's values, a device MUST NOT queue an item edit.

**Tests:** `device/folders.test.ts › sends nothing for a save that only reformats the frontmatter`, `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`.

### `folders/version-spelling`

When a document version line is a quoted integer or decimal spelling of a positive integer, a device MUST interpret it as that version.

**Tests:** `device/folders.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folders/time-normalization`

When a document names `occurred_at`, a device MUST interpret its date or date-and-time by the server's time rules, including UTC for a value without an offset.

**Tests:** `device/folders.test.ts › sets a new item's own time, from a date or from a date and time`, `cli/folder.test.ts › sets an item's own time from a file's occurred_at line, and writes it back as typed`.

### `folders/time-equivalent-no-write`

When a save only changes the spelling of an equivalent `occurred_at`, a device MUST NOT send an item edit for it.

**Tests:** `device/folders.test.ts › sends an edit of the line, and nothing for another spelling of the same time`, `device/folders.test.ts › follows a time changed elsewhere, and keeps a line in another spelling of the same time`.

### `folders/time-current-edit`

When a current file changes its `occurred_at` value, a device MUST send the changed item time outside `properties`.

**Tests:** `device/folders.test.ts › sends an edit of the line, and nothing for another spelling of the same time`.

### `folders/time-omitted-keeps`

When a file omits its `occurred_at` line, a device MUST leave the item's time unchanged.

**Tests:** `device/folders.test.ts › sends an edit of the line, and nothing for another spelling of the same time`.

### `folders/time-null-empty`

When a file has a null `occurred_at` line, a device MUST treat it as no requested time.

**Tests:** `device/folders.test.ts › takes a blank line as no time, and leaves it blank`.

### `folders/time-null-preserved`

When an item has no explicit time to render over a null `occurred_at` line, a device MUST preserve the blank line.

**Tests:** `device/folders.test.ts › takes a blank line as no time, and leaves it blank`.

### `folders/time-render`

When an item's time differs from its creation time or a file already carries `occurred_at`, a device MUST render the item's time in that line.

**Tests:** `device/folders.test.ts › writes the line for an item whose time is its own, and none for one never set`, `device/folders.test.ts › follows a time changed elsewhere, and keeps a line in another spelling of the same time`.

### `folders/time-invalid`

If an `occurred_at` line is non-text or cannot be read as a valid time, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders.test.ts › flags a line that is no time, and sends nothing for the file`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folders/own-field-validation`

If frontmatter names an empty or non-text type, a tier other than feed or library, a state other than active or archived, or a malformed tag value, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders.test.ts › reads own-field lines in each form a file can hold them`, `device/folders.test.ts › holds a file whose frontmatter does not parse`.

### `folders/tag-state-forms`

When a document uses comma-separated text or null for tags, or null for state, a device MUST interpret them respectively as the named tags, no tags, or active.

**Tests:** `device/folders.test.ts › reads own-field lines in each form a file can hold them`.

### `folders/preserve-source`

When a pull changes a document, a device MUST preserve unchanged frontmatter source, including order, comments, quoting, number spelling, collections, scalars, Unicode, and line endings.

**Tests:** `device/folders.test.ts › writes a person's frontmatter back in the order they wrote it`, `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`, `cli/folder.test.ts › keeps authored YAML bytes while first push adds metadata and a remote edit changes one value`.

### `folders/preserve-change-in-place`

When a pull changes document properties, a device MUST edit changed values in place, remove uncarried values, and append missing fields.

**Tests:** `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`, `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

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

### `folders/old-state-version-advance`

When an item advances to another version after a state change was flagged as indistinguishable from an old buffer, a device MUST accept an explicit state edit from the newly rendered current file.

**Tests:** `device/folders-contract-a.test.ts › allows a previously ambiguous state change after the item version advances`.

### `folders/body-property-line-no-flag`

When a document names its current body property in frontmatter as well as having body text, a device MUST use the body text without flagging that duplicate representation.

**Tests:** `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

## Document recognition and refused edits

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

**Tests:** `device/folders.test.ts › retypes an item whose frontmatter changes its type`.

### `folders/retype-new-body`

When retyping a document changes its body property, a device MUST use a nonempty frontmatter value for the new body property, or the document body if none is provided.

**Tests:** `device/folders.test.ts › keeps both body fields' text when a retype moves the body to another`.

### `folders/retype-old-body`

When retyping a document changes its body property, a device MUST preserve the old body property's text.

**Tests:** `device/folders.test.ts › keeps both body fields' text when a retype moves the body to another`.

### `folders/retype-unsuited`

If a document names an unknown type or a file type, then a device MUST refuse its creation or retype locally.

**Tests:** `device/folders.test.ts › refuses a type no document can be, before sending anything`.

### `folders/refused-edit-kept`

When the server refuses a document edit, tag change, or state change, a device MUST preserve the person's file.

**Tests:** `device/folders.test.ts › flags a refused retype and keeps the file`.

### `folders/refused-edit-report`

When a document write is refused, a device MUST flag the held file `refused` with the server's code and message.

**Tests:** `device/folders.test.ts › flags a refused retype and keeps the file`.

### `folders/refused-edit-follow`

When a held file is renamed, reformatted, or changed without replacing its refused change, a device MUST retain the refusal on that file.

**Tests:** `device/folders.test.ts › through a rename before the drain`, `device/folders.test.ts › through a rename after the refusal`, `device/folders.test.ts › through a save that only reformats it before the drain`, `device/folders.test.ts › through a later save that only adds a tag`, `device/folders.test.ts › through a later save that only edits the body, where a tag was refused`.

### `folders/refused-edit-no-repeat`

While a refused document remains unchanged, a device MUST NOT send the same change again.

**Tests:** `device/folders.test.ts › flags a refused retype and keeps the file`.

### `folders/refused-edit-replaced`

When a later save lands an edit replacing a refused edit, a device MUST release the file's refusal hold.

**Tests:** `device/folders.test.ts › lets a file go once a later save lands after a refused one`.

### `folders/refused-tag-mended`

When a file stops carrying a refused tag and its replacement tag lands, a device MUST clear the refused-tag hold.

**Tests:** `device/folders.test.ts › sends a mended tag from a file whose edit landed beside the refused one`.

### `folders/refused-edit-version`

When a document edit is refused, a device MUST base the next edit on the file's version unless an earlier accepted edit already consumed that version.

**Tests:** `device/folders.test.ts › sends a save after a refused edit as behind, keeping what another machine changed or added`, `device/folders.test.ts › keeps the line a landed edit spent when a later edit from the same buffer is refused`.

### `folders/refused-own-field-replaced`

When a later accepted change supersedes a refused change of the same tag or state, a device MUST release the file's refusal hold for that change.

**Tests:** `device/folders-contract-a.test.ts › releases a refused %s when a later change of it is accepted`.

## Unreadable documents

### `folders/unreadable-yaml`

If Markdown frontmatter is malformed, has a non-text key, duplicates a key, or uses a YAML merge key, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders.test.ts › holds a file whose frontmatter does not parse`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folders/unreadable-no-write`

While a document is unreadable, a device MUST NOT send an item create or edit for it.

**Tests:** `device/folders.test.ts › holds a file whose frontmatter does not parse`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folders/unreadable-preserve`

While a bound document is unreadable, a device MUST preserve its bytes during pull.

**Tests:** `device/folders.test.ts › holds a file whose frontmatter does not parse`.

### `folders/unreadable-report`

While a bound document is unreadable, a device MUST report its path and reason in the pull's `flagged` entries.

**Tests:** `device/folders.test.ts › holds a file whose frontmatter does not parse`.

### `folders/unreadable-rename`

When an unreadable document moves and its identity or readable `marfa_id` establishes the same item, a device MUST retain that item binding.

**Tests:** `device/folders.test.ts › holds a file whose frontmatter does not parse`, `device/folders.test.ts › keeps an unreadable file's item when it moves with no identity`.

### `folders/unreadable-repaired`

When an unreadable document is repaired, a device MUST process its edit normally.

**Tests:** `device/folders.test.ts › holds a file whose frontmatter does not parse`.

### `folders/encoding-flag`

If a document is not UTF-8 text or contains a NUL byte, then a device MUST flag it `encoding` with the reason.

**Tests:** `device/folders.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/encoding-no-send`

While a document is held for encoding, a device MUST NOT send its content.

**Tests:** `device/folders.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/encoding-preserve`

While a document is held for encoding, a device MUST preserve its bytes during pull.

**Tests:** `device/folders.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/encoding-status`

While a document is held for encoding, the command MUST list it as `held` in `folders status`.

**Tests:** `device/folders.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/encoding-repaired`

When a document is saved as UTF-8 without NUL bytes, a device MUST admit its content.

**Tests:** `device/folders.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folders/file-bytes-not-document`

When a non-document file contains bytes that are not valid UTF-8 or include NUL, a device MUST admit those bytes as a file item rather than apply document encoding restrictions.

**Tests:** `device/folders-contract-a.test.ts › applies default properties to documents but not file items`.

## Edge lines and name lookup

### `folders/edge-catalog-refresh`

When a changed file names a newly registered edge type and the server is reachable, a device MUST read the line as an edge rather than a property.

**Tests:** `device/folders.test.ts › learns an edge type the server registers, and reads its line as an edge`, `device/fidelity.test.ts › matches the edge types a working copy holds and a folder reads its frontmatter lines by`.

### `folders/edge-target-hydration`

When a new edge type is written at its target, a device MUST refresh the folder slice to hold that type whole at the next push.

**Tests:** `device/folders.test.ts › learns an edge type the server registers, and reads its line as an edge`.

### `folders/edge-title-outside-folder`

When a document writes an edge to a readable item outside the folder search, a device MUST render that target by title where the name is unambiguous.

**Tests:** `device/folders.test.ts › writes and reads back by title a link to an item with no file on this Mac`.

### `folders/edge-pin-held`

While at least one document line names an item outside the slice, a device MUST retain the pin it made for that item.

**Tests:** `device/folders.test.ts › holds a pin while a line names its row, and lets go only a pin it made`, `device/folders-contract-extra-c.test.ts › keeps a shared edge target pinned until the last owning file releases it`.

### `folders/edge-pin-release`

When no file binding or edge line requires an item pinned by the folder, a device MUST release the folder's pin.

**Tests:** `device/folders.test.ts › holds a pin while a line names its row, and lets go only a pin it made`, `device/folders-contract-extra-c.test.ts › keeps a shared edge target pinned until the last owning file releases it`.

### `folders/edge-pin-other-owner`

When an edge line is removed, a device MUST retain a pin for its target that the folder did not create.

**Tests:** `device/folders.test.ts › holds a pin while a line names its row, and lets go only a pin it made`.

### `folders/edge-writing-end`

When rendering an edge, a device MUST write its frontmatter line only at the end named by the edge type's `written_at`, using its forward name at the source or reverse name at the target.

**Tests:** `device/folders.test.ts › writes an edge in one file only`, `device/folders.test.ts › writes parent-of as child-of in the child`.

### `folders/edge-file-fallback`

When an edge's designated writing end cannot carry frontmatter, a device MUST write the edge at the other document end under its name there.

**Tests:** `device/folders.test.ts › writes attached-to in the attachment's file, and has-attachment in an image's host`.

### `folders/edge-unknown-writer`

When the copy cannot determine whether an edge's designated writing end carries frontmatter, a device MUST preserve a typed reverse line at the other end.

**Tests:** `device/folders.test.ts › keeps a typed has-attachment to an image the copy does not hold`.

### `folders/edge-title-format`

When a target has one unambiguous title that link syntax can represent, a device MUST render an edge target as `[[title]]`.

**Tests:** `device/folders.test.ts › writes an edge in one file only`.

### `folders/edge-id-format`

When a target title is ambiguous or cannot be represented in link syntax, a device MUST render the edge target as `[[id]]`.

**Tests:** `device/folders.test.ts › writes the id form where a name is repeated`, `device/folders.test.ts › writes by id a title a link cannot hold`.

### `folders/edge-id-read`

When an edge line names a readable item by ID, optionally followed by a heading or alias, a device MUST resolve that ID even if the item has no file in the folder.

**Tests:** `device/folders.test.ts › resolves a target written by id`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folders/edge-filename-read`

When an edge line uniquely names a bound file by filename, a device MUST resolve it to that file's item.

**Tests:** `device/folders.test.ts › resolves a name by its file's name, and keeps it as typed`.

### `folders/edge-alias`

When an edge line unambiguously names a target with an alias or heading, a device MUST resolve the name before `|` or `#`.

**Tests:** `device/folders.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folders/edge-deduplicate-target`

When several names in one edge line resolve to the same item, a device MUST treat them as one target.

**Tests:** `device/folders.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folders/edge-name-syntax-ambiguity`

If an edge-line target can resolve both as its full text and as a name with a heading or alias, then a device MUST flag the line `edges` instead of choosing a target.

**Tests:** `device/folders.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`.

### `folders/edge-name-unmatched`

If a typed edge target matches no readable item, then a device MUST flag the file `edges` with the unmatched name.

**Tests:** `device/folders.test.ts › flags an unmatched name and leaves it as typed`.

### `folders/edge-name-ambiguous`

If a typed edge target matches more than one readable item, then a device MUST flag the file `edges` with the ambiguity.

**Tests:** `device/folders.test.ts › flags an ambiguous name and leaves it as typed`, `device/fidelity.test.ts › matches the name lookup a folder asks the server for a typed name`.

### `folders/edge-name-kept`

When an edge line already resolves to its item, a device MUST preserve the typed target through a pull that rewrites the file.

**Tests:** `device/folders.test.ts › resolves a name by its file's name, and keeps it as typed`, `device/folders.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`.

### `folders/edge-new-namesake`

When another item takes an existing edge target's name, a device MUST retain the existing edge target.

**Tests:** `device/folders.test.ts › leaves an existing link unchanged when a same-named item appears`.

### `folders/edge-lookup-waits`

When name lookup cannot reach a server, a device MUST flag the unresolved edge name as waiting for lookup.

**Tests:** `device/folders.test.ts › waits for the server to resolve a name, and resolves it at the next pass that reaches it`.

### `folders/edge-lookup-retries`

When the server becomes reachable after a name lookup waited, a device MUST retry that lookup at the next scan.

**Tests:** `device/folders.test.ts › waits for the server to resolve a name, and resolves it at the next pass that reaches it`.

### `folders/edge-lookup-refused`

When the server refuses a name lookup, a device MUST flag only the affected file with the refusal.

**Tests:** `device/folders.test.ts › flags only the file whose name cannot be looked up, and goes on with the rest`.

### `folders/edge-lookup-no-repeat`

While a file with a refused name lookup is unchanged, a device MUST NOT repeat that lookup.

**Tests:** `device/folders.test.ts › flags only the file whose name cannot be looked up, and goes on with the rest`.

### `folders/edge-lookup-page-limit`

When the fifth lookup page for a title property and spelling says more matches follow, a device MUST flag the name as exceeding the five-page lookup limit.

**Tests:** `device/folders.test.ts › flags a name more common than the lookup reads`.

### `folders/edge-lookup-states`

When resolving an edge target by name, a device MUST consider archived items and exclude trashed items.

**Tests:** `device/folders.test.ts › counts an archived match only the server holds, and none in the bin`.

### `folders/edge-lookup-title-field`

When resolving an edge target by title, a device MUST match the property that its type uses as the title.

**Tests:** `device/folders.test.ts › matches a title only in the property its type keeps it in`.

### `folders/edge-line-removal`

When a document removes a previously rendered edge line, a device MUST delete the edge that line represented.

**Tests:** `device/folders.test.ts › removes the edge whose line was taken out`.

### `folders/edge-unshown-kept`

When an edge has arrived from elsewhere but has not appeared in the file, a device MUST preserve it when processing that file.

**Tests:** `device/folders.test.ts › flags a new target for an end whose edge the file never showed, and deletes nothing`.

### `folders/edge-line-invalid-keeps-type`

If an edge line has an unresolved target, names its own item, is at the wrong end, or exceeds its end's cardinality, then a device MUST leave that file's edges of that type unchanged.

**Tests:** `device/folders.test.ts › changes no edge of a type whose target it cannot resolve`, `device/folders.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`, `device/folders.test.ts › flags a line naming too many targets for its edge type, and changes nothing`, `device/folders.test.ts › flags an in-folder line and a line naming its own item`.

### `folders/edge-line-invalid-report`

If an edge line is invalid, then a device MUST flag the file `edges` with the reason.

**Tests:** `device/folders.test.ts › changes no edge of a type whose target it cannot resolve`, `device/folders.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`, `device/folders.test.ts › flags a line naming too many targets for its edge type, and changes nothing`, `device/folders.test.ts › flags an in-folder line and a line naming its own item`, `device/folders-contract-extra-c.test.ts › leaves an invalid bare edge line untouched while a valid link queues its edge`.

### `folders/edge-line-no-item-edit`

When a save changes only edge lines, a device MUST NOT send an item-property edit for those changes.

**Tests:** `device/folders.test.ts › removes the edge whose line was taken out`, `device/folders.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`.

### `folders/edge-replace-one`

When a line changes the target of an end that holds one edge, a device MUST move the existing edge's other end in one write.

**Tests:** `device/folders.test.ts › replaces a one-target edge's target in one step`, `device/fidelity.test.ts › matches the refusal of a second parent, a parent moved in one step, and each refusal of a move`.

### `folders/edge-replace-keeps-properties`

When a line moves an existing edge's other end, a device MUST preserve that edge's ID and properties.

**Tests:** `device/folders.test.ts › replaces a one-target edge's target in one step`.

### `folders/edge-replace-unshown-refused`

When a line names a new target but the existing edge at that end has not appeared in the file, a device MUST flag the file without changing the edge.

**Tests:** `device/folders.test.ts › flags a new target for an end whose edge the file never showed, and deletes nothing`.

### `folders/edge-delete-already-gone`

When an edge deletion is answered `edge_not_found`, a device MUST treat the requested removal as complete.

**Tests:** `device/folders.test.ts › takes a delete of an edge already gone as done`.

### `folders/edge-move-refused`

When the server refuses an edge move, a device MUST retain the old edge in its working copy.

**Tests:** `device/folders.test.ts › keeps the old edge where the replace is refused`.

### `folders/edge-move-refusal-holds`

When the server refuses an edge move, a device MUST hold the document with the server's refusal reason.

**Tests:** `device/folders.test.ts › keeps the old edge where the replace is refused`, `device/folders.test.ts › holds a file whose move a plain device drain saw refused`.

### `folders/edge-refusal-next-move`

When a later edit replaces a refused edge move, a device MUST move from the edge's last accepted position.

**Tests:** `device/folders.test.ts › keeps the old edge where the replace is refused`.

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

**Tests:** `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`, `device/folders.test.ts › lists under has-attachment only what the body does not embed`, `device/folders.test.ts › resolves body links by title and nested filename without repeating references on pull`.

### `folders/body-unlinked-edge-line`

When a `references` edge has no matching body link, a device MUST render it as a frontmatter line without changing the body.

**Tests:** `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`.

### `folders/body-link-name`

When a Markdown body link names an ID, title, filename, or bound file path with an optional extension, heading, or alias, a device MUST resolve the linked item by the same name rules as frontmatter edge lines.

**Tests:** `device/folders.test.ts › resolves body links by title and nested filename without repeating references on pull`, `device/folders.test.ts › reports ambiguous body links including whole names with heading or alias marks`.

### `folders/body-link-ambiguity`

When a body-link name is ambiguous, including between its full text and its heading or alias interpretation, a device MUST report the ambiguity without choosing a target.

**Tests:** `device/folders.test.ts › reports ambiguous body links including whole names with heading or alias marks`, `device/folders.test.ts › does not choose between existing references answering to the same body name`.

### `folders/body-code-comments`

When a body link occurs in Markdown code, an HTML comment, or an Obsidian `%%` comment, a device MUST treat it as text.

**Tests:** `device/folders.test.ts › ignores body links in code and comments while sending visible links`, `device/folders.test.ts › keeps visible references and removes code-only references with %s`.

### `folders/body-local-heading`

When a body link names only a heading in the same document, a device MUST ignore it for edge creation.

**Tests:** `device/folders.test.ts › resolves body links by title and nested filename without repeating references on pull`, `device/folders.test.ts › ignores body links in code and comments while sending visible links`.

### `folders/body-note-embed`

When a Markdown body embeds a document rather than a file item, a device MUST treat that embed as text.

**Tests:** `device/folders.test.ts › reads an embed of a note, even one with a dot in its name, as text`, `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`.

### `folders/body-lookup-retry`

When a body-link lookup cannot reach the server, a device MUST retry it at the next pass that reaches the server.

**Tests:** `device/folders.test.ts › waits for body link lookups and retries them when the server returns`.

### `folders/embed-edge`

When a Markdown body embeds a local file, a device MUST create an `attached-to` edge from the file item to the document item.

**Tests:** `device/folders.test.ts › sends an embedded file with its file`.

### `folders/embed-edge-removal`

When a document removes an embed, a device MUST delete that attachment edge.

**Tests:** `device/folders.test.ts › removes the edge when the embed is taken out`, `device/folders.test.ts › removes the edge of an embed taken out between two scans before a push`.

### `folders/embed-file-kept`

When a document removes an embed, a device MUST retain the embedded file on disk.

**Tests:** `device/folders.test.ts › removes the edge when the embed is taken out`.

### `folders/embed-markdown-only`

When a raw-text document contains embed syntax, a device MUST NOT create an attachment edge or materialize a file for that syntax.

**Tests:** `device/folders.test.ts › reads embeds in a Markdown body only, and none shown in code`, `device/folders.test.ts › writes no file a .txt file's text embeds`.

### `folders/embed-code-comments`

When embed syntax occurs in a code span, fenced code block, indented code block or comment, a device MUST treat it as text, including code nested inside lists or quotes.

**Tests:** `device/folders.test.ts › reads embeds in a Markdown body only, and none shown in code`, `device/folders-contract-extra-c.test.ts › ignores embeds in list fences and indented code while reading a normal list paragraph`.

### `folders/embed-path`

When a Markdown embed names a path, a device MUST resolve it relative to the embedding document's directory, or the folder root for a leading `/`.

**Tests:** `device/folders.test.ts › reads an embed's path as Obsidian reads one`.

### `folders/embed-path-escapes`

When resolving an embed path, a device MUST decode percent escapes and remove its query or fragment.

**Tests:** `device/folders.test.ts › reads an embed's path as Obsidian reads one`.

### `folders/embed-address`

When an embed names an address beginning with `https://`, `//`, or `#`, a device MUST NOT treat it as a local file.

**Tests:** `device/folders.test.ts › reads an embed's path as Obsidian reads one`.

### `folders/embed-path-case`

When an embed path differs only in case from the matching file, a device MUST retain the file's own spelling.

**Tests:** `device/folders.test.ts › reads an embed's path whatever its case, and keeps the file's own name`.

### `folders/embed-wiki-name`

When `![[name]]` names a file, a device MUST prefer the root-relative path, then a matching path suffix at a directory boundary ordered by the embedding directory, shallowest depth, and path.

**Tests:** `device/folders.test.ts › reads an embed by name as Obsidian resolves a name`.

### `folders/embed-upload`

When a document embeds an admissible file, a device MUST upload that file before creating its file item regardless of the search's admitted file types.

**Tests:** `device/folders.test.ts › sends an embedded file with its file`.

### `folders/embed-held`

While a document embeds a readable active or archived file item, a device MUST retain its file regardless of the folder search's type and state restrictions.

**Tests:** `device/folders.test.ts › sends an embedded file with its file`, `device/folders.test.ts › keeps an embedded file archived elsewhere where its search holds active items only`.

### `folders/embed-path-placement`

When a pull materializes a path embed, a device MUST place its file where the document's link names it.

**Tests:** `device/folders.test.ts › writes an embedded file where its link says`.

### `folders/embed-name-placement`

When a pull materializes a name embed, a device MUST use an existing matching placement or file path, otherwise place a bare name beside the embedding document or a name containing a directory at the folder root.

**Tests:** `device/folders.test.ts › writes an embedded file where its link says`, `device/folders.test.ts › writes a file embedded by name where its placement already answers to the name`, `device/folders.test.ts › writes a file embedded by name where another embed's path names it`.

### `folders/embed-placement-follows`

When an embed determines a file's path, a device MUST update that file's `in-folder` placement to the path.

**Tests:** `device/folders.test.ts › writes an embedded file where its link says`.

### `folders/embed-renamed`

When an embedded file is renamed so its old link no longer names it, a device MUST preserve the file's item and attachment edge at its new name.

**Tests:** `device/folders.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folders/embed-renamed-report`

When an embedded file is renamed so its old link no longer names it, a device MUST report the broken embed.

**Tests:** `device/folders.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folders/embed-unresolved-line`

When a renamed attachment no longer resolves from its body embed, a device MUST render its `has-attachment` line.

**Tests:** `device/folders.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folders/embed-attachment-hydration`

When a folder search admits document types, a device MUST hold `attached-to` edges whole.

**Tests:** `device/folders.test.ts › holds attachments whole only where its search holds a document`.

### `folders/embed-trashed-line`

When an embedded item is trashed or its ability to carry frontmatter is unknown, a device MUST NOT repeat its attachment edge under `has-attachment`.

**Tests:** `device/folders.test.ts › lists a trashed embedded file under has-attachment no more than a held one`.

### `folders/embed-outside`

When an embed path leads outside the folder, a device MUST report the embed in `embeds`.

**Tests:** `device/folders.test.ts › reports an embed pointing outside the folder`.

### `folders/embed-two-paths`

When one attachment is embedded at different paths, a device MUST write it at the first path in path order.

**Tests:** `device/folders.test.ts › writes an item embedded at two paths at the first, and reports the other`.

### `folders/embed-two-paths-report`

When one attachment is embedded at different paths, a device MUST report each embed naming another path.

**Tests:** `device/folders.test.ts › writes an item embedded at two paths at the first, and reports the other`.

### `folders/embed-unresolved-keeps-edges`

While an embed names a missing file or has an invalid raw-space path, a device MUST retain the document's existing attachment edges.

**Tests:** `device/folders.test.ts › removes no attachment while an embed names nothing, and removes it once none does`.

### `folders/embed-unreadable-target`

When an embed names no attachment the key can read, a device MUST report the embed.

**Tests:** `device/folders.test.ts › reports an embed of a file the key cannot read, and writes nothing for it`.

### `folders/embed-ambiguous-target`

When an embed name matches two attachments, a device MUST report the ambiguity.

**Tests:** `device/folders.test.ts › writes nothing for a name two attachments share, and says so`.

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

**Tests:** `device/folders.test.ts › reads the id of a Markdown file whatever the case of its extension`.

### `folders/id-rename`

When a Markdown file moves with its `marfa_id` line intact and no stronger binding identifies another item, a device MUST retain the named item.

**Tests:** `device/folders.test.ts › follows a rename by the id the file carries, and sends no edit of the item for it`.

### `folders/id-missing-binding`

When a bound file is saved without its `marfa_id` line, a device MUST retain its item by its existing identity or path binding.

**Tests:** `device/folders.test.ts › keeps the item when a save drops the id line`, `device/folders.test.ts › keeps a binding for every file after a swap that also edits both`.

### `folders/id-minted`

When an unbound document has no usable item ID, a device MUST create it under a newly minted ID without a natural key or version.

**Tests:** `device/folders.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folders/id-after-create`

When a document's create lands and its bytes have not changed since scan, a device MUST write the accepted `marfa_id` into the file.

**Tests:** `device/folders.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folders/id-before-create`

While a document's create is unanswered, a device MUST preserve its existing file bytes.

**Tests:** `device/folders.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folders/id-concurrent-save`

When a file changes after scan, a device MUST preserve the later save rather than writing metadata over it.

**Tests:** `device/folders.test.ts › does not write back into a file changed since its scan`.

### `folders/id-not-property`

When a device sends a document create or edit, a device MUST omit `marfa_id` from the item properties.

**Tests:** `device/folders.test.ts › keeps its id line out of what it sends the server`.

### `folders/id-removal-no-edit`

When a save only removes `marfa_id`, a device MUST NOT send an item edit.

**Tests:** `device/folders.test.ts › sends nothing for a save that only drops the id line`.

### `folders/id-removal-restored`

When a save only removes `marfa_id`, a device MUST restore the ID line at the next pull.

**Tests:** `device/folders.test.ts › sends nothing for a save that only drops the id line`.

### `folders/id-checkout`

When an unbound Markdown file names an existing document in the copy, a device MUST send its changes to that item rather than creating another.

**Tests:** `device/folders.test.ts › sends a checked-out file's edits to the item its id names, and nothing for one in step`.

### `folders/id-vacated-path`

When a renamed file leaves its old path to a newly created file in the same scan, a device MUST create a separate item for the new file.

**Tests:** `device/folders.test.ts › does not write a new file's body onto the item whose name it took`.

### `folders/atomic-editor-save`

When an editor replaces a bound file at the same path, a device MUST treat its changed content as an edit of the same item.

**Tests:** `device/folders.test.ts › keeps an agent's whole-file rewrite the same item`.

### `folders/atomic-editor-unchanged`

When an editor replaces a bound file with equivalent content at the same path, a device MUST NOT create or edit an item for the replacement.

**Tests:** `device/folders.test.ts › keeps an unchanged rewrite the same item`.

### `folders/atomic-editor-follow`

When an editor replaces a bound file at the same path and then renames it, a device MUST follow the replacement as the same item.

**Tests:** `device/folders.test.ts › keeps an unchanged rewrite the same item`.

### `folders/copy-binding-precedence`

When files in one folder claim the same item ID, a device MUST prefer the file identified by the existing binding.

**Tests:** `device/folders.test.ts › keeps the id with the file its binding names`, `device/folders.test.ts › keeps the id with the original an editor saved without its line, over a copy carrying it`.

### `folders/copy-older-precedence`

When unbound files claim the same item ID and have distinct birth times, a device MUST prefer the file with the earlier birth time.

**Tests:** `device/folders.test.ts › keeps the id with the older of two unbound files that carry it`.

### `folders/copy-new-item`

When a file copies another file's item ID, a device MUST create a separate item for the copy under a fresh ID.

**Tests:** `device/folders.test.ts › makes a copy a new item with a fresh id`.

### `folders/copy-write-id`

When a copied document's create lands, a device MUST write the fresh ID into the copy.

**Tests:** `device/folders.test.ts › makes a copy a new item with a fresh id`.

### `folders/copy-binding-kept`

While a copy still carries its original's ID line after its own create lands, a device MUST retain the copy's own binding even if the original file disappears.

**Tests:** `device/folders.test.ts › keeps a copy its own item once the original goes, before its id line is rewritten`.

### `folders/id-unknown-new`

When an unbound document names an ID absent from the copy, a device MUST replace that ID with a fresh document ID on creation.

**Tests:** `device/folders.test.ts › gives a fresh id to a file whose id names nothing`.

### `folders/id-system-ignored`

When an unbound document names a `system.*` item as its ID, a device MUST create a separate document item.

**Tests:** `device/folders.test.ts › reads no id from a file naming the folder's own settings`.

### `folders/id-file-item-ignored`

When an unbound document names a file item as its ID, a device MUST create a separate document item.

**Tests:** `device/folders.test.ts › reads no id from a .txt file or from a document naming a file item`.

### `folders/raw-text-body`

When a file has a `.txt` extension in any letter case, a device MUST treat its complete text as the document body without reading or writing frontmatter.

**Tests:** `device/folders.test.ts › reads a .txt file that opens with a --- block as a body`, `device/folders.test.ts › reads a .txt file whatever the case of its extension`, `device/folders.test.ts › follows a rename by device, inode and birth time`.

### `folders/identity-rename`

When a file's unique filesystem identity survives a rename, a device MUST retain the same item.

**Tests:** `device/folders.test.ts › follows a rename by device, inode and birth time`.

### `folders/identity-unusable`

When an unbound file has no unique usable filesystem identity, a device MUST treat it as new rather than infer a rename from another missing file.

**Tests:** `device/folders.test.ts › treats a file with no usable identity as new rather than guessing`.

### `folders/identity-admitted-files`

When deciding whether file identities are unique, a device MUST consider only files the folder admits.

**Tests:** `device/folders.test.ts › resolves identity over the files it holds, not every file in the tree`.

### `folders/identity-equivalent-save`

When a bound file is replaced with the same bytes and then renamed, a device MUST retain its item.

**Tests:** `device/folders.test.ts › follows the rename of a file saved again with the same bytes`.

### `folders/identity-unread-rename`

When a renamed bound file has empty or unreadable bytes, a device MUST retain its item at the renamed path.

**Tests:** `device/folders.test.ts › keeps a renamed file's item while its bytes are %s`.

### `folders/identity-unread-replacement`

When an unreadable renamed file leaves a replacement at its previous path, a device MUST preserve the renamed file's ownership of its item.

**Tests:** `device/folders.test.ts › keeps unread rename ownership over a replacement at the old path: %s`.

### `folders/identity-placement-bytes`

When an unbound raw-text or file-item file matches the path and rendered bytes of an otherwise unbound item held by the search, a device MUST bind it to that item.

**Tests:** `device/folders.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders.test.ts › takes back an empty text file rendered from a missing body`.

### `folders/identity-takeback-search`

When a file matches the old placement and bytes of an item the search no longer holds, a device MUST create a new item for that file.

**Tests:** `device/folders.test.ts › takes back by placement and bytes only an item its search holds`.

### `folders/identity-takeback-peer`

When another folder has taken in an item, a device MUST NOT take back that item for a copy at its former placement.

**Tests:** `device/folders.test.ts › takes no file back by its bytes for an item another folder on the Mac took in`.

### `folders/watch-file-equivalence`

When equivalent new files are present at startup or arrive while watching, a device MUST create equivalent item types and content.

**Tests:** `device/folders.test.ts › binds the same file to the same item whether it was present at start or arrived while running`.

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

**Tests:** `device/folders.test.ts › places an item where its in-folder edge says, on every Mac`.

### `folders/placement-edge-type`

When another edge points to the folder's item, a device MUST NOT treat it as placement.

**Tests:** `device/folders.test.ts › reads no other edge to the folder as a placement`.

### `folders/placement-remote-move`

When another device changes an item's placement path, a device MUST move the file to that path at the next pull.

**Tests:** `device/folders.test.ts › places an item where its in-folder edge says, on every Mac`.

### `folders/placement-first-type`

When a newly encountered item has no placement, a device MUST derive its path from its title under the most specific first-placement type or ancestor, or the root if none matches.

**Tests:** `device/folders.test.ts › places a new item from elsewhere under its type's first placement`, `device/folders.test.ts › places a new item under the most specific first placement naming its type`.

### `folders/placement-create`

When a device gives an unplaced item a file, a device MUST create the item's `in-folder` edge with that path.

**Tests:** `device/folders.test.ts › places a new item from elsewhere under its type's first placement`, `device/folders.test.ts › writes the in-folder edge for a file made in the folder`, `device/folders.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`.

### `folders/placement-checkout`

When a checked-out document is first bound, a device MUST place its item where the file sits.

**Tests:** `device/folders.test.ts › places a checked-out file where it sits`.

### `folders/placement-rename-only`

When a file is renamed without a content change, a device MUST send only its placement change.

**Tests:** `device/folders.test.ts › sends only the placement for a rename`.

### `folders/placement-not-document`

When a device renders a file, a device MUST omit its `in-folder` edge from frontmatter and body links.

**Tests:** `device/folders.test.ts › writes the in-folder edge for a file made in the folder`.

### `folders/placement-give-way-duplicate`

When another device's existing placement causes this device's placement create to be refused as a duplicate, a device MUST follow the accepted placement.

**Tests:** `device/folders.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/fidelity.test.ts › matches the refusal of a second placement of one item in one folder`.

### `folders/placement-give-way-stale`

When another device's accepted placement causes this device's move to be refused as stale, a device MUST follow the accepted placement.

**Tests:** `device/folders.test.ts › follows another Mac's move of the same file, giving its own way`.

### `folders/placement-give-way-count`

When a device gives way to another device's placement, a device MUST count the result as `gave_way`.

**Tests:** `device/folders.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/folders.test.ts › follows another Mac's move of the same file, giving its own way`.

### `folders/placement-give-way-queue`

When a device gives way to another device's placement, a device MUST remove its obsolete refused or blocked placement writes from the queue.

**Tests:** `device/folders.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/folders.test.ts › follows another Mac's move of the same file, giving its own way`.

### `folders/placement-collision-order`

When several items claim one path, a device MUST rank existing placements by creation time and then edge ID, ahead of unplaced items.

**Tests:** `device/folders.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders.test.ts › gives a contested path to a placed item before an unplaced one, and to a file already there before a new one`, `device/folders.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`, `device/folders-contract-extra-c.test.ts › orders equal-time placement collisions by edge ID`.

### `folders/placement-collision-number`

When an item cannot keep a contested path, a device MUST use the first available numbered sibling name after removing any existing number suffix.

**Tests:** `device/folders.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders.test.ts › counts the free number past a file on disk, a path another item is placed at, and its own file`.

### `folders/placement-collision-free`

When choosing a numbered sibling path, a device MUST exclude paths occupied by other files or reserved by other placements while allowing the item's own file.

**Tests:** `device/folders.test.ts › counts the free number past a file on disk, a path another item is placed at, and its own file`.

### `folders/placement-collision-count`

When a pull assigns a numbered sibling path, a device MUST count the item as `beside`.

**Tests:** `device/folders.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`.

### `folders/placement-collision-write`

When a pull assigns a numbered sibling path, a device MUST move the item's placement edge to that path.

**Tests:** `device/folders.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`.

### `folders/placement-settles`

When devices have received the same accepted placements and settled path conflicts, a device MUST stop sending unchanged placements.

**Tests:** `device/folders.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`.

### `folders/placement-outside`

When a placement is excluded by the folder lists, is inside a package, contains `..` or escapes through a symbolic link, a device MUST count it `outside`.

**Tests:** `device/folders.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders.test.ts › does not walk into a package`.

### `folders/placement-outside-edge-kept`

When a placement is outside the paths the folder writes, a device MUST leave the edge's path unchanged.

**Tests:** `device/folders.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`.

### `folders/placement-unsuited`

When a placement extension would change a document into a non-document or a file item into another MIME type, a device MUST count it `unsuited`.

**Tests:** `device/folders.test.ts › writes no file where its placement would make it another kind of file`.

### `folders/placement-filesystem-failure`

When the filesystem refuses a placement, a device MUST count the affected item `unwritten`.

**Tests:** `device/folders.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folders/placement-refusal-no-repeat`

While a refused placement's path, settings, key ID, grant, and prior placement remain unchanged, a device MUST NOT resend that placement.

**Tests:** `device/folders.test.ts › sends a placement the server refused once, until the settings or the key change`, `device/folders.test.ts › takes a key it could not read when a placement was refused as unchanged, and does not send the placement again`.

### `folders/placement-refusal-new-path`

When a file moves after its placement was refused, a device MUST try the new path.

**Tests:** `device/folders.test.ts › sends a placement the server refused once, until the settings or the key change`.

### `folders/placement-key-push`

When a push holds a refused placement, a device MUST reread the key's current grant before deciding whether to retry.

**Tests:** `device/folders.test.ts › sends a refused placement again once the key's grant is restored, and not while the key cannot be read`.

### `folders/placement-key-watch`

While a watch holds refused placements, a device MUST limit key rereads, including failed reads, to at most once per minute.

**Reason:** The exact one-minute threshold needs a fixture-controlled clock; real-time watch fixtures prove suppression between passes and eventual recovery.

**Tests:** waiting on #1890.

### `folders/placement-grant-restored`

When a watch observes that the placement grant has been restored, a device MUST retry the refused placement.

**Tests:** `device/folders.test.ts › sends a refused placement again while watching, once the key's grant is restored, reading the key at most once a minute`.

### `folders/placement-key-unreadable`

When the key cannot be read, a device MUST treat it as unchanged for retrying refused placements.

**Tests:** `device/folders.test.ts › sends a refused placement again once the key's grant is restored, and not while the key cannot be read`, `device/folders.test.ts › takes a key it could not read when a placement was refused as unchanged, and does not send the placement again`.

### `folders/placement-refusal-cleared`

When a later placement for an item lands, a device MUST release that item's earlier placement refusal.

**Tests:** `device/folders.test.ts › follows another Mac's move of an item whose move it was refused`, `device/folders.test.ts › sends a refused move again once a later placement of the item lands`.

### `folders/placement-refused-file-kept`

While a file's placement move is refused, a device MUST leave the file at the person's chosen path.

**Tests:** `device/folders.test.ts › keeps a file where the person moved it when the server refuses the move`.

### `folders/placement-unplaced-count`

When a pull holds refused placements, a device MUST report their count as `unplaced`.

**Tests:** `device/folders.test.ts › sends a placement the server refused once, until the settings or the key change`.

### `folders/placement-watch-notice`

While a refused-placement count is unchanged, the command MUST NOT repeat its watch notice for each eventful pass.

**Tests:** `device/folders.test.ts › says the placements it holds back once while watching`.

### `folders/placement-add-permission`

If a key lacks `edge.in-folder:write`, then the command MUST refuse `folders add` naming that permission.

**Tests:** `device/folders.test.ts › names the permission a key without in-folder write lacks, when it is added`, `device/fidelity.test.ts › matches the key a folder asks about when it is added`.

### `folders/placement-add-cleanup`

When `folders add` is refused for lacking placement permission, a device MUST remove the directory it created for the failed add.

**Tests:** `device/folders.test.ts › names the permission a key without in-folder write lacks, when it is added`.

### `folders/placement-not-membership`

When evaluating folder membership, a device MUST use the search independently of whether an item has a placement edge to the folder.

**Tests:** `device/folders.test.ts › does not let placement decide what it holds`.

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

When publishing a moved file at its new placement fails, a device MUST leave the old file intact at its previous path.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps the old file when publishing a move fails and leaves emptied directories after success`.

### `folders/placement-empty-directories`

When a file moves to a new placement, a device MUST retain the directories emptied by that move.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps the old file when publishing a move fails and leaves emptied directories after success`.

### `folders/placement-add-non-key`

When `GET /keys/current` answers `403 forbidden` for a credential that is not a key, a device MUST allow folder addition without requiring a key's `in-folder` grant.

**Tests:** `device/folders-contract-extra-c.test.ts › accepts a non-key credential when the current-key door answers forbidden`.

### `folders/placement-key-watch-throttled`

When a watch cannot read the current key, a device MUST continue watching without repeating that key request on every pass.

**Tests:** `device/folders.test.ts › asks a key it could not read again at most once a minute while watching`.

## File writes and recovery

### `folders/write-no-echo`

When a scan follows a device's own file write, a device MUST NOT treat that write as a user create or edit.

**Tests:** `device/folders.test.ts › does not read its own writes back as changes`.

### `folders/write-whole`

When a device writes a document, file item, settings file or file transferred from another folder, a device MUST publish complete bytes or leave the previous file intact.

**Tests:** `device/folders.test.ts › writes a file whole beside it and renames it over, so a failed write leaves the old one`, `device/folders.test.ts › keeps a file a crash cut off taking in where it was, and journals no delete`, `device/folders.test.ts › keeps its settings file its own when a crash cuts off writing it`, `device/folders.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`.

### `folders/write-attributes`

When a device replaces an existing file, a device MUST retain its supported extended attributes.

**Tests:** `device/folders.test.ts › writes a file whole beside it and renames it over, so a failed write leaves the old one`.

### `folders/write-crash-no-edit`

When a file write crashes before its new bytes land, a device MUST NOT send the previous file content as a user edit during recovery.

**Tests:** `device/folders.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`, `device/folders.test.ts › restores a styled file's agreement after a pull crashes before landing`.

### `folders/write-crash-new-no-delete`

When a new file write crashes before the file lands, a device MUST NOT journal that absent file as a user deletion.

**Tests:** `device/folders.test.ts › journals no delete for a new file a crash cut off writing`.

### `folders/write-crash-status`

When a write crashes before replacing an unchanged existing file, the command MUST report that file as `in_step` during recovery.

**Tests:** `device/folders.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`.

### `folders/write-crash-temporary-cleanup`

When a crashed writer is no longer running, a device MUST remove its abandoned temporary files at the next scan.

**Tests:** `device/folders.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`.

### `folders/write-crash-take-in`

When taking in another folder's file crashes before landing, a device MUST preserve the source file without journaling a deletion.

**Tests:** `device/folders.test.ts › keeps a file a crash cut off taking in where it was, and journals no delete`.

### `folders/write-crash-settings`

When a settings-file write crashes before landing, a device MUST retain the old file as its own prior write rather than send it as an edit.

**Tests:** `device/folders.test.ts › keeps its settings file its own when a crash cuts off writing it`.

### `folders/write-editor-race`

When a person changes a file before a pull's final check, a device MUST preserve that save instead of overwriting, removing, or letting go of the file.

**Tests:** `device/folders.test.ts › leaves a file it would take away or rewrite where the person saved it meanwhile`, `device/folders.test.ts › leaves the file a move would take away where the person saved it meanwhile`, `device/folders.test.ts › leaves a file it let go where the person saved it meanwhile`.

### `folders/write-new-target-race`

When a file appears after an absent target was checked, a device MUST leave the appearing file untouched.

**Tests:** `device/folders.test.ts › keeps a file that appears after an absent landing target was checked`.

### `folders/write-failure-binding`

When a replacement landing fails, a device MUST retain the previous item's binding and deletion journal at that path.

**Tests:** `device/folders.test.ts › restores another item's binding and journal when a landing fails`.

### `folders/write-render-report`

When a document cannot be rendered safely, a device MUST report its path, item, and reason in `flagged`.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/write-render-continues`

When one document cannot be rendered safely, a device MUST continue writing other documents.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folders/write-settings-failure`

When a settings file cannot be written, a device MUST report `settings.unwritten`.

**Tests:** `device/folders.test.ts › reports a settings file it cannot write, and goes on`.

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

## Deletion and missing directories

### `folders/delete-grace`

When a bound file disappears, a device MUST defer its item deletion for the five-second rename grace.

**Tests:** `device/folders.test.ts › defers a delete past the rename grace`.

### `folders/delete-rename-cancels`

When a file returns at its own path or a new name within the rename grace, a device MUST cancel its journaled deletion.

**Tests:** `device/folders.test.ts › takes the old path out of the journal when the file comes back under a new name`, `device/folders.test.ts › takes a file out of the journal when it comes back under its own name`, `device/folders.test.ts › defers a delete past the rename grace`.

### `folders/delete-remote-revives`

When another device changes a deleted item in content its file shows during the rename grace, a device MUST restore the file from the changed item.

**Tests:** `device/folders.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`.

### `folders/delete-revived-cancels`

When a deleted file is revived by a visible remote change, a device MUST cancel its journaled deletion.

**Tests:** `device/folders.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`.

### `folders/delete-revived-count`

When a deleted file is revived by a visible remote change, a device MUST count it `revived`.

**Tests:** `device/folders.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`.

### `folders/delete-unshown-change`

When a deleted item advances in version without changing content its file shows, a device MUST retain the journaled deletion.

**Tests:** `device/folders.test.ts › sends a person's delete of a file whose item moved on elsewhere in nothing the file shows`, `device/folders.test.ts › keeps a deleted raw-text file gone after a version step even when its body looks like YAML`.

### `folders/delete-path-reused`

When another item takes a deleted file's path, a device MUST retain the original item's journaled deletion.

**Tests:** `device/folders.test.ts › keeps a person's journaled delete when another item is placed at its path`.

### `folders/delete-left-by-state`

When a locally deleted item leaves the folder search by state during the grace, a device MUST send its deletion after the grace.

**Tests:** `device/folders.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folders/delete-already-trashed`

When a locally deleted item is already trashed, a device MUST NOT send another item deletion.

**Tests:** `device/folders.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folders/delete-at-startup`

When a tracked file is absent at startup, a device MUST journal its deletion as it would a file removed while running.

**Tests:** `device/folders.test.ts › journals a delete that happened while it was not running`.

### `folders/root-gone-no-delete`

While the folder directory is missing or replaced by another directory, a device MUST NOT trash its items because the original files cannot be read.

**Tests:** `device/folders.test.ts › trashes nothing while its directory is gone, and says so`, `device/folders.test.ts › reads, writes and trashes nothing in a copy put in its directory's place`.

### `folders/root-gone-watch`

While the folder directory is missing, the command MUST report that the directory cannot be found.

**Tests:** `device/folders.test.ts › trashes nothing while its directory is gone, and says so`.

### `folders/root-return-watch`

When the folder directory returns, a device MUST resume the running watch's work.

**Tests:** `device/folders.test.ts › trashes nothing while its directory is gone, and says so`.

### `folders/root-no-recreate`

When the root directory disappears during a pull, a device MUST NOT recreate it.

**Tests:** `device/folders.test.ts › does not make its directory anew when it goes away during a pull`.

### `folders/root-write-count`

When the root directory disappears before a file write, a device MUST count the blocked write `unwritten`.

**Tests:** `device/folders.test.ts › does not make its directory anew when it goes away during a pull`.

### `folders/walk-directory-gone`

When a directory disappears during the walk, a device MUST report it in `directories` with flag `gone`.

**Tests:** `device/folders.test.ts › journals no missing file in a pass a directory went away from while it was walked`.

### `folders/walk-gone-no-journal`

When a directory disappears during the walk, a device MUST NOT journal missing files from that incomplete walk.

**Tests:** `device/folders.test.ts › journals no missing file in a pass a directory went away from while it was walked`.

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

When the folder directory is missing, the command MUST refuse `folders status`, `folders confirm`, and `folders restore` with the reason.

**Tests:** `device/folders-contract-a.test.ts › refuses status and removal decisions while the folder directory is missing`.

### `folders/walk-gone-no-deletion`

When a directory disappears during a walk, a device MUST defer already journaled item deletions until a complete walk succeeds.

**Tests:** `device/folders-contract-a.test.ts › sends no journaled deletion from an incomplete walk and resumes after a complete walk`.

### `folders/walk-prior-directory-removal`

When a directory was deleted before a walk began, a device MUST journal its tracked files as missing.

**Tests:** `device/folders-contract-a.test.ts › journals files from a directory removed before the walk begins`.

### `folders/delete-trashed-status`

When a locally missing file's item has already been trashed elsewhere, the command MUST report that file as waiting on `scan` rather than `delete`.

**Tests:** `device/folders-contract-a.test.ts › reports a locally missing item already trashed elsewhere as waiting on scan`.

### `folders/delete-missing-not-pull-removal`

When a pull encounters files already deleted locally, a device MUST exclude those absent files from its `removed` and `kept` counts.

**Tests:** `device/folders-contract-a.test.ts › reports a locally missing item already trashed elsewhere as waiting on scan`.

## Document versions

### `folders/version-line`

When a pull writes a Markdown file, a device MUST write `marfa_version` naming the item version rendered.

**Tests:** `device/folders.test.ts › bases a stale file's edit on the version written in it`.

### `folders/version-stale-merge`

When a file names an older version not consumed by its accepted edits, a device MUST send the property edit as a merge based on that version, including a version the copy never held.

**Tests:** `device/folders.test.ts › bases a stale file's edit on the version written in it`, `device/folders.test.ts › merges a file whose line names a version the copy skipped against that line`, `device/folders.test.ts › merges a file behind the copy, clearing nothing its lines left out`.

### `folders/version-absent-merge`

When a document edit has no usable version line, a device MUST send its properties as a merge rather than a replacement.

**Tests:** `device/folders.test.ts › merges an edit from a file with no version line`, `device/folders.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folders/version-consumed`

When an earlier accepted edit consumed a file's version line, a device MUST base the next edit from that line on the copy's current version.

**Tests:** `device/folders.test.ts › bases a stale file's edit on the version written in it`, `device/folders.test.ts › keeps a line an edit spent spent after the pull rewrites it`.

### `folders/version-rewrite-waiting`

When a pull rewrites a file over its waiting edit and that edit later lands, a device MUST treat the rewritten line as consumed by the accepted edit.

**Tests:** `device/folders.test.ts › keeps the line a pull wrote over a waiting edit spent, once that edit lands`, `device/folders.test.ts › keeps a line spent where a pull writes the file over the edit that spent it`.

### `folders/version-rewrite-refused`

When a pull rewrites a file over a waiting edit that is then refused, a device MUST base the next edit from that rewritten file on its version line.

**Tests:** `device/folders.test.ts › takes back the line a pull wrote over a waiting edit when that edit is refused`.

### `folders/version-answered-unchanged`

When a pull writes a newer version line over a waiting edit that is then refused after an earlier edit was accepted or conflicted, a device MUST base the next edit from that newer buffer on its own version line.

**Tests:** `device/folders.test.ts › lifts no answered edit's line when a pull writes over a waiting one, a conflicted edit's included`.

### `folders/version-dead-unchanged`

When a pull writes a newer version line over a waiting edit that is then refused after an earlier edit died, a device MUST base the next edit from that newer buffer on its own version line.

**Tests:** `device/folders.test.ts › lifts no dead edit's line when a pull writes over a later waiting one`.

### `folders/version-external-write`

When a write queued outside the file lands after a pull rewrote the file over it, a device MUST base the next file edit on the copy's current version.

**Tests:** `device/folders.test.ts › keeps the line a pull wrote over an edit queued outside the file spent, once that edit lands`.

### `folders/version-dead-consumed`

When an edit dies after exhausting retries, a device MUST base another edit from that same buffer on the copy's current version.

**Tests:** `device/folders.test.ts › keeps a dead edit's line spent, since the server may have taken it`.

### `folders/version-dead-refused`

When a released dead edit is explicitly refused and no accepted edit has used its version line, a device MUST base the next edit from that buffer on the buffer's version line.

**Tests:** `device/folders.test.ts › takes back a dead edit's line once, released, the server refuses it`.

### `folders/version-only-save`

When a save changes only `marfa_version`, a device MUST NOT send an item edit.

**Tests:** `device/folders.test.ts › sends nothing for a save that changes only the version line`.

### `folders/version-ancestor-missing`

When the server no longer holds the file edit's ancestor version, a device MUST retry the edit as a property merge on the copy's current version.

**Tests:** `device/folders.test.ts › sends over a thinned version as a merge, and says so`.

### `folders/version-rebased-count`

When a folder edit is resent after its ancestor version is unavailable, a device MUST count that resend as `rebased`.

**Tests:** `device/folders.test.ts › sends over a thinned version as a merge, and says so`.

### `folders/version-rebased-words`

When a push or watch resends an edit because its ancestor version is unavailable, the command MUST say that it was resent on the version the copy holds.

**Tests:** `device/folders.test.ts › says in words that an edit went over a thinned version`, `device/folders.test.ts › says while watching that an edit went over a thinned version`.

### `folders/version-rebase-limit`

When an edit resent after an unavailable ancestor is blocked for another unavailable ancestor, a device MUST leave it blocked until another pass.

**Tests:** `device/folders.test.ts › stops at one resend where the server no longer holds the version the copy holds either`.

### `folders/version-only-pull`

When a remote version change alters nothing rendered in the file, a device MUST leave the file's bytes unchanged.

**Tests:** `device/folders.test.ts › does not rewrite a file for its version line alone`.

### `folders/version-own-edit-landed`

When the file's own edit lands and the file remains unchanged since scan, a device MUST update its version line to the accepted version.

**Tests:** `device/folders.test.ts › does not rewrite a file for its version line alone`, `device/folders.test.ts › writes the line into a file saved without one, once its edit lands`.

### `folders/version-own-edit-after-pull`

When a file's own edit lands after a pull wrote the file while it waited, a device MUST update the version line again to the accepted version.

**Tests:** `device/folders.test.ts › rewrites the line once its own edit lands, where a pull wrote the file while that edit waited`.

### `folders/version-unknown-base`

When a document has no version line or names a version ahead of the working copy, a device MUST base its property merge on the copy's current item version.

**Tests:** `device/folders-contract-a.test.ts › merges on the copy version when the file version line is %s`.

### `folders/version-not-property`

When a device sends a document edit, a device MUST omit `marfa_version` from item properties.

**Tests:** `device/folders-contract-a.test.ts › merges on the copy version when the file version line is %s`.

## Edge write recovery

### `folders/edge-move-gone-create`

When an edge move is answered that the edge is gone, a device MUST create the edge the document line now requests.

**Tests:** `device/folders.test.ts › makes the edge a line asks for where its move finds the edge deleted elsewhere`, `device/folders.test.ts › makes the edge a gone move's line asks for at the next drain, where the first one stops`.

### `folders/edge-move-waits-create`

When a line moves an edge to an item whose create is queued, a device MUST wait for that item create before sending the move.

**Tests:** `device/folders.test.ts › waits for the create of the item its line now names before it moves the edge`.

### `folders/edge-move-dead-keeps`

When an edge move dies after its retries, a device MUST retain the accepted server edge.

**Tests:** `device/folders.test.ts › leaves the server's edge whole where a move dies after its retries`.

### `folders/edge-create-refusal-holds`

When the server refuses an edge create from a document line, a device MUST report the refusal beside any unresolved-name flag for that file.

**Tests:** `device/folders.test.ts › holds a file whose line's edge is refused, and says it beside a name it cannot resolve`.

### `folders/body-missing-report`

When a body link resolves to no item, a device MUST flag its document with the link text and reason.

**Tests:** `device/folders.test.ts › reports missing body links and preserves removals until all links resolve`, `device/body-links-live.test.ts › resolves body links through real server lookup and keeps their removal after pull`.

### `folders/body-unresolved-keeps-edges`

While a body link is unresolved, a device MUST retain the document's existing references until every link resolves.

**Tests:** `device/folders.test.ts › reports missing body links and preserves removals until all links resolve`, `device/body-links-live.test.ts › resolves body links through real server lookup and keeps their removal after pull`.

### `folders/preserve-alias-values`

When a pull changes or removes a YAML anchor, a device MUST expand affected aliases as needed to preserve their intended values.

**Tests:** `device/folders-contract-a.test.ts › expands affected aliases and preserves untouched anchors when removal is %s`.

### `folders/preserve-unaffected-anchors`

When a pull changes one YAML anchor group, a device MUST preserve untouched anchor groups as written.

**Tests:** `device/folders-contract-a.test.ts › expands affected aliases and preserves untouched anchors when removal is %s`.

### `folders/write-read-only`

When an existing file is read-only, a device MUST leave it unchanged during a pull.

**Tests:** `device/folders-contract-a.test.ts › keeps a read-only document unchanged when another device changes its item`.

## Reports and continuation

### `folders/empty-directory-push`

When a file is edited in a newly added folder directory, a device MUST send that edit during push.

**Tests:** `device/folders.test.ts › hydrates into an empty directory and pushes without holding anything else`.

### `folders/placement-outside-no-write`

When a placement is excluded by the folder lists, contains `..`, or escapes through a symbolic link, a device MUST NOT write the file at that path.

**Tests:** `device/folders.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`.

### `folders/placement-unsuited-no-write`

When a placement would make a file another kind of item, a device MUST NOT write the file at that path.

**Tests:** `device/folders.test.ts › writes no file where its placement would make it another kind of file`.

### `folders/placement-filesystem-keeps`

When the filesystem refuses a placement, a device MUST retain the file at its previous path.

**Tests:** `device/folders.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folders/placement-filesystem-continues`

When the filesystem refuses one placement, a device MUST continue processing other files.

**Tests:** `device/folders.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folders/embed-outside-no-write`

When an embed path leads outside the folder, a device MUST NOT read or write the file it names.

**Tests:** `device/folders.test.ts › reports an embed pointing outside the folder`.

### `folders/embed-unreadable-no-write`

When an embed names no attachment the key can read, a device MUST NOT write a file for it.

**Tests:** `device/folders.test.ts › reports an embed of a file the key cannot read, and writes nothing for it`.

### `folders/embed-ambiguous-no-write`

When an embed name matches two attachments, a device MUST NOT write a file for it.

**Tests:** `device/folders.test.ts › writes nothing for a name two attachments share, and says so`.

### `folders/write-settings-continues`

When a settings file cannot be written, a device MUST continue the folder pass.

**Tests:** `device/folders.test.ts › reports a settings file it cannot write, and goes on`.

### `folders/root-gone-watch-continues`

While the folder directory is missing, the command MUST keep the watch running.

**Tests:** `device/folders.test.ts › trashes nothing while its directory is gone, and says so`.

## Lists and names

### `folders/include-empty`

When a folder’s include list is empty, a device MUST admit every path not excluded by dot-name rules, built-in lists or its ignore list.

**Tests:** `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`.

### `folders/include-negation`

When a negated include pattern matches an otherwise included folder path, a device MUST exclude that path from admission.

**Tests:** `device/folders-contract-b.test.ts › applies include negation, ignore precedence and case-normalized patterns`.

### `folders/invalid-pattern-refused`

When a folder’s include or ignore list contains an invalid gitignore pattern, a device MUST refuse admission using those settings.

**Tests:** `device/folders-contract-b.test.ts › refuses an invalid %s pattern before admission`.

### `folders/include-paths`

When a folder has a nonempty include list, a device MUST admit only paths whose name or an ancestor directory matches an included gitignore pattern relative to the folder root.

**Tests:** `device/folders.test.ts › takes only what its include list names`.

### `folders/ignore-paths`

When a folder path matches its ignore list, a device MUST exclude that path from admission even when the include list also matches it.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`, `device/folders-contract-b.test.ts › applies include negation, ignore precedence and case-normalized patterns`.

### `folders/include-dot-directories`

When a folder path has a dot-led directory component, a device MUST admit it only where a non-negated include pattern explicitly names every dot-led directory on its path.

**Tests:** `device/folders.test.ts › reaches a dot-led path its include list names`, `device/folders.test.ts › excludes a dot-led directory at any depth`, `device/folders.test.ts › writes nothing under a dot-led directory its walk does not enter`, `device/folders.test.ts › takes nothing under a dot-led directory a negated include line names`.

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

When a folder push or watch encounters a file excluded by a built-in secret pattern, the command MUST name the excluded file in words.

**Tests:** `device/folders.test.ts › never takes a secret whatever its lists say`, `device/folders.test.ts › says a refused secret in words once while watching`.

### `folders/secret-notice-once`

While a folder file remains excluded by a built-in secret pattern, the command MUST say its watch notice only once.

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

**Tests:** `device/folders.test.ts › does not walk into a package`.

### `folders/macos-package-scan-contents-excluded`

Where a device runs on macOS, when the operating system identifies a directory as a package by its type or Finder bundle bit, a device MUST NOT admit the directory’s contents.

**Tests:** `device/folders.test.ts › does not walk into a package`.

### `folders/package-pull`

When a folder placement falls inside a package, a device MUST count the item as `outside`.

**Tests:** `device/folders.test.ts › does not walk into a package`.

### `folders/package-pull-file-unwritten`

When a folder placement falls inside a package, a device MUST NOT write its file.

**Tests:** `device/folders.test.ts › does not walk into a package`.

### `folders/unreadable-directory`

When a folder scan cannot read a directory or an entry’s details, a device MUST report that directory as `unreadable`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders.test.ts › holds the files of a directory whose entries cannot be read`.

### `folders/unreadable-directory-scan-continues`

When a folder scan cannot read a directory or an entry’s details, a device MUST continue scanning other directories.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders.test.ts › holds the files of a directory whose entries cannot be read`.

### `folders/unreadable-bindings`

When a folder scan cannot reach a bound file inside an unreadable directory, a device MUST count it as `unreached`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders.test.ts › holds the files of a directory whose entries cannot be read`.

### `folders/unreadable-no-deletion`

When a folder scan cannot reach a bound file inside an unreadable directory, a device MUST NOT journal its deletion.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders.test.ts › holds the files of a directory whose entries cannot be read`.

### `folders/unreadable-pull`

When a folder pull cannot write a bound file inside an unreadable directory, a device MUST retain its binding.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`.

### `folders/unreadable-pull-unwritten-count`

When a folder pull cannot write a bound file inside an unreadable directory, a device MUST count the item as `unwritten`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`.

### `folders/name-comparison`

When a device compares folder paths, file names or titles, a device MUST treat names differing only in case or Unicode normalization as the same name.

**Tests:** `device/folders.test.ts › treats names differing only in case or Unicode form as one`, `device/folders-contract-b.test.ts › matches include names in NFC regardless of case and asks server names in both forms`, `device/folders-contract-b.test.ts › matches Unicode %s patterns with the folder name equivalence`.

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

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`, `device/folders.test.ts › sends an embedded file with its file`.

### `folders/binary-outside-search-skipped-count`

When an unbound non-document file has no type held by a folder’s search and no document embeds it, a device MUST count the file as `skipped`.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`, `device/folders.test.ts › sends an embedded file with its file`.

### `folders/embedded-outside-search`

When a document in a folder embeds a file outside the folder’s search, a device MUST admit that file as the document’s attachment.

**Tests:** `device/folders.test.ts › sends an embedded file with its file`, `device/folders.test.ts › writes an embedded file where its link says`, `device/folders.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folders/document-outside-search`

When a folder document names an admissible type outside the folder’s search, a device MUST create its item under that type.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`.

### `folders/new-file-only-members`

When an item outside a folder’s search has no bound file and no document embeds it, a device MUST NOT write a new file for the item.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`.

### `folders/outside-document-unmatched`

When a folder document’s accepted type is outside the folder’s search, a device MUST count its bound file as `unmatched` at the next pull.

**Tests:** `device/folders.test.ts › leaves a file outside its search alone`.

## Paths, links and files

### `folders/placement-root-relative`

When a device reads a folder placement path, a device MUST resolve the path from the folder root after discarding leading separators, empty components and `.` components.

**Tests:** `device/folders.test.ts › reads a placement path with a leading separator from the folder's root`.

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

**Tests:** `device/folders.test.ts › removes no edge at all when a link in the body names nothing`, `device/folders.test.ts › reports missing body links and preserves removals until all links resolve`.

### `folders/deferred-removals-retried`

When every remaining body link in a folder document resolves after reference removals were deferred, a device MUST queue the deferred removals.

**Tests:** `device/folders.test.ts › removes no edge at all when a link in the body names nothing`, `device/folders.test.ts › remembers a link it stood down over, so a later removal still lands`, `device/folders.test.ts › reports missing body links and preserves removals until all links resolve`.

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

**Tests:** `device/folders.test.ts › takes back a file of its own the mapping had lost`, `device/folders.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders.test.ts › takes back an empty text file rendered from a missing body`.

### `folders/rendered-file-adopted-bytes-unchanged`

When an unbound folder item’s placement already holds exactly its rendered bytes, a device MUST NOT rewrite the existing file.

**Tests:** `device/folders.test.ts › takes back a file of its own the mapping had lost`, `device/folders.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders.test.ts › takes back an empty text file rendered from a missing body`.

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

When an item is trashed or leaves the states held by a folder’s search, a device MUST remove its bound file at the next pull only where the file still has the bytes the folder wrote.

**Tests:** `device/folders.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders.test.ts › removes the file of an item that leaves by state`.

### `folders/departed-binding-released`

When a folder pull removes a departed item’s file, a device MUST release the file’s binding.

**Tests:** `device/folders.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders.test.ts › removes the file of an item that leaves by state`.

### `folders/departed-item-not-deleted`

When a folder pull removes a departed item’s file, a device MUST NOT queue deletion of the item.

**Tests:** `device/folders.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders.test.ts › removes the file of an item that leaves by state`.

### `folders/restored-file-written`

When a trashed item is restored into a folder’s search, a device MUST write its file at the next pull.

**Tests:** `device/folders.test.ts › removes a trashed item's file and brings it back on restore`.

### `folders/missing-departure-not-pulled`

When a departed folder item’s file is already missing from disk, a device MUST leave its deletion for the scan rather than count it as removed by the pull.

**Tests:** `device/folders.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folders/returned-file-journal-cleared`

When a folder pull removes a departed item’s file that returned after its deletion was journaled, a device MUST clear that journal entry.

**Tests:** `device/folders.test.ts › takes away a file put back after its delete was journaled, once its item leaves by state, and sends no delete`.

### `folders/returned-item-not-deleted`

When a folder pull removes a departed item’s file that returned after its deletion was journaled, a device MUST NOT queue deletion of the item.

**Tests:** `device/folders.test.ts › takes away a file put back after its delete was journaled, once its item leaves by state, and sends no delete`.

### `folders/departed-edited-file-kept`

When a departed folder item’s file contains bytes changed since the folder wrote it, a device MUST preserve the file.

**Tests:** `device/folders.test.ts › keeps a file the person changed after its item left, and says so`, `device/folders.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/departed-edited-file-kept-kept-count`

When a departed folder item’s file contains bytes changed since the folder wrote it, a device MUST count the file as `kept`.

**Tests:** `device/folders.test.ts › keeps a file the person changed after its item left, and says so`, `device/folders.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/departed-unreadable-file`

When a folder pull cannot read a departed item’s file to verify its bytes, a device MUST preserve the file.

**Tests:** `device/folders.test.ts › holds the file of an item that leaves by state where it cannot be read, and does not call it kept`.

### `folders/departed-unreadable-file-unwritten-count`

When a folder pull cannot read a departed item’s file to verify its bytes, a device MUST count the item as `unwritten` rather than `kept`.

**Tests:** `device/folders.test.ts › holds the file of an item that leaves by state where it cannot be read, and does not call it kept`.

### `folders/unmatched-file-kept`

When an item leaves a folder’s search for a reason other than its state or purge and no other folder takes its file, a device MUST retain the bound file.

**Tests:** `device/folders.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders.test.ts › keeps the file of an item a narrowed search leaves out, flagged, and sends its edits to it`, `device/folders.test.ts › keeps the file of an item retyped out of its search elsewhere, flagged, and sends its edits to it`.

### `folders/unmatched-file-kept-unmatched-count`

When an item leaves a folder’s search for a reason other than its state or purge and no other folder takes its file, a device MUST count the file as `unmatched`.

**Tests:** `device/folders.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders.test.ts › keeps the file of an item a narrowed search leaves out, flagged, and sends its edits to it`, `device/folders.test.ts › keeps the file of an item retyped out of its search elsewhere, flagged, and sends its edits to it`.

### `folders/unmatched-file-edits`

When a bound folder file’s item no longer matches the search, a device MUST continue sending edits to that item.

**Tests:** `device/folders.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders.test.ts › keeps the file of an item a narrowed search leaves out, flagged, and sends its edits to it`, `device/folders.test.ts › keeps the file of an item retyped out of its search elsewhere, flagged, and sends its edits to it`.

### `folders/unmatched-file-updated`

When a bound unmatched folder item changes, a device MUST keep its existing file current under the same preservation rules as a search member’s file.

**Tests:** `device/folders.test.ts › keeps an unmatched file current, so its second edit keeps another device's change`.

### `folders/replaced-binding-unpinned`

When another item takes a bound folder file’s path, a device MUST release the old item’s binding pin unless another file or edge still requires it.

**Tests:** `device/folders.test.ts › lets go of the pin of an item whose file's path another item takes`.

### `folders/embedded-archive-kept`

When an embedded file item becomes archived outside the folder’s search, a device MUST keep its file while a document still embeds it.

**Tests:** `device/folders.test.ts › sends an embedded file with its file`, `device/folders.test.ts › keeps an embedded file archived elsewhere where its search holds active items only`.

### `folders/binary-created`

When a nonempty non-document file is admitted by a folder’s search or an embed, a device MUST create a file item typed from its MIME type whose create waits for the bytes’ upload.

**Tests:** `device/folders.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`, `device/folders.test.ts › sends an embedded file with its file`.

### `folders/binary-edited`

When the bytes of a bound file item change in a folder, a device MUST queue an upload followed by an item update naming the new bytes regardless of the file’s extension.

**Tests:** `device/folders.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`, `device/folders.test.ts › sends an edited file item named like a document as bytes`.

### `folders/binary-title-preserved`

When a bound folder file item is renamed and its title differs from its old file name, a device MUST retain the item’s title.

**Tests:** `device/folders.test.ts › keeps a title somebody set when the file moves`.

### `folders/blob-file-written`

When a folder pull can obtain a file item’s bytes, a device MUST write those bytes as the file.

**Tests:** `device/folders.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`.

### `folders/blob-absent`

When a folder pull cannot obtain a file item’s bytes for an environmental or local read failure, a device MUST report the item as `absent`.

**Tests:** `device/folders.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folders/blob-absent-no-placeholder`

When a folder pull cannot obtain a file item’s bytes for an environmental or local read failure, a device MUST NOT write a placeholder file.

**Tests:** `device/folders.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folders/blob-retry`

When a later folder pull can obtain bytes previously reported as absent, a device MUST retry writing the file.

**Tests:** `device/folders.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders.test.ts › keeps the file of an item whose new bytes cannot be had`, `device/folders.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folders/old-blob-file-kept`

When a folder pull cannot obtain a file item’s changed bytes, a device MUST preserve the previous file’s bytes.

**Tests:** `device/folders.test.ts › keeps the file of an item whose new bytes cannot be had`.

### `folders/blob-credential-refused`

When the server refuses the credential while a folder pull fetches file bytes, a device MUST fail the pull rather than count each file as absent.

**Tests:** `device/folders.test.ts › ends a pull whose credential is refused, rather than counting each file absent`.

### `folders/blob-cache-released`

When a folder file holds its item’s bytes and no pending upload needs them, a device MUST release any duplicate copy of those bytes kept beside the working copy.

**Tests:** `device/folders.test.ts › keeps no copy beside the store of bytes its file holds, and fetches them again when asked`.

### `folders/nonfile-blob-document`

When an item outside the file types carries `blob_ref`, a device MUST render it as a document rather than writing the referenced blob as its file.

**Tests:** `device/folders.test.ts › writes an item carrying a blob_ref outside the file types as a document`.

### `folders/lost-row-file-kept`

When a folder file’s create is refused and the copy loses the row, a device MUST preserve the person’s file.

**Tests:** `device/folders.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/lost-row-edit-retried`

When the person changes or moves a folder file whose row the copy no longer holds, a device MUST queue the file as a new item under a new device-minted ID.

**Tests:** `device/folders.test.ts › queues a file whose row the copy lost again once it changes, and says so`, `device/folders.test.ts › queues a file whose row the copy lost again once it moves`.

### `folders/lost-row-unchanged-held`

While a folder file whose row the copy no longer holds stays unchanged at its path, a device MUST report the file as lost.

**Tests:** `device/folders.test.ts › queues a file whose row the copy lost again once it changes, and says so`, `device/folders.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/lost-create-not-repeated`

While a folder file whose row the copy no longer holds stays unchanged at its path, a device MUST NOT queue another create.

**Tests:** `device/folders.test.ts › queues a file whose row the copy lost again once it changes, and says so`, `device/folders.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folders/lost-row-binding-ownership`

When a live file has taken a lost file’s former path, a device MUST preserve the live file’s binding.

**Tests:** `device/folders.test.ts › keeps a live file's binding when it takes a lost file's old name`, `device/folders.test.ts › keeps a live file's binding when it takes a lost file's old name, across a push`.

### `folders/lost-file-requeued`

When a live file has taken a lost file’s former path, a device MUST requeue the lost file as a new item.

**Tests:** `device/folders.test.ts › keeps a live file's binding when it takes a lost file's old name`, `device/folders.test.ts › keeps a live file's binding when it takes a lost file's old name, across a push`.

### `folders/lost-row-watch-notice`

While a folder file stays bound to a row the copy no longer holds, the command MUST say its lost-row watch notice only once.

**Tests:** `device/folders.test.ts › says in words when a file is bound to an item that is gone, once while watching`.

### `folders/own-conflict-file-kept`

When a folder save conflicts with the same device’s earlier save, a device MUST preserve the file’s newer bytes rather than overwrite them with the item’s earlier value.

**Tests:** `device/folders.test.ts › keeps a file whose newest save conflicted with its own earlier one, and sends it again`.

### `folders/own-conflict-retried`

When a folder file’s newer save was set aside against the same device’s earlier save, a device MUST submit the retained bytes at the next scan as an edit based on the item’s current version.

**Tests:** `device/folders.test.ts › keeps a file whose newest save conflicted with its own earlier one, and sends it again`.

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

When a folder push’s catch-up fails environmentally, the command MUST report why catch-up failed.

**Tests:** `device/folders.test.ts › pulls at a push that cannot reach the server, and says the catch-up failed`.

### `folders/watch-unretryable-failure`

When a folder watch hydration receives an answer no retry can change, the command MUST end the watch.

**Tests:** `device/folders.test.ts › ends the watch and says so when its hydration meets an answer no retry changes`.

### `folders/watch-unretryable-failure-reason-said`

When a folder watch hydration receives an answer no retry can change, the command MUST report why server changes stopped reaching the folder.

**Tests:** `device/folders.test.ts › ends the watch and says so when its hydration meets an answer no retry changes`.

### `folders/registry-registers-folder`

When a folder is added, a device MUST list its resolved directory, followed `system.folder` and store identity in the machine’s folder registry.

**Tests:** `device/folders.test.ts › lists the folders on the Mac in one registry`, `device/folders.test.ts › lists a folder reached through a symlink once, and never as another`, `device/folders-contract-b.test.ts › registers the resolved directory, followed folder and store identity`.

### `folders/registry-independent-stores`

When several folders are registered on one machine, a device MUST keep each folder’s working copy and queue independent.

**Tests:** `device/folders.test.ts › keeps each folder's state and queue to itself`.

### `folders/registry-location`

A device MUST keep the folder registry at `MARFA_FOLDER_REGISTRY` when set, otherwise in `folders.json` under the machine’s application data directory.

**Tests:** `device/folders.test.ts › keeps its registry under the home by default`.

### `folders/registry-restored`

When a registered folder performs a pass after its registry entry disappears or its directory moves, a device MUST register the folder’s current directory again.

**Tests:** `device/folders.test.ts › lists a folder again where the registry lost it, a watch included`, `device/folders.test.ts › holds a delete for a pass when the registry it was listed in is gone, and lists itself again`.

### `folders/nested-folder-refused`

When adding a folder would enclose or fall inside another listed folder, a device MUST refuse the add.

**Tests:** `device/folders.test.ts › refuses a folder inside another, and walks past a folder inside it`.

### `folders/nested-folder-not-scanned`

When a folder scan encounters a directory holding another folder’s `.marfa/` state, a device MUST exclude that directory’s contents from admission.

**Tests:** `device/folders.test.ts › refuses a folder inside another, and walks past a folder inside it`, `device/folders.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folders/nested-bound-file-held`

When a bound file’s directory becomes another folder, a device MUST preserve the original binding.

**Tests:** `device/folders.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folders/nested-bound-file-held-unreached-count`

When a bound file’s directory becomes another folder, a device MUST count the file as `unreached`.

**Tests:** `device/folders.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folders/nested-no-deletion`

When a bound file’s directory becomes another folder, a device MUST NOT journal the file’s deletion.

**Tests:** `device/folders.test.ts › holds a bound file whose directory becomes a folder inside this one, and trashes nothing`.

### `folders/remove-waiting-refused`

When a confirmed folder has unanswered or blocked queued writes, a device MUST refuse to remove its state.

**Tests:** `device/folders.test.ts › refuses to remove a folder with a blocked write`.

### `folders/registry-one-directory`

When the same resolved directory is registered through another spelling or for another `system.folder`, a device MUST retain only its current registry entry.

**Tests:** `device/folders.test.ts › lists a folder reached through a symlink once, and never as another`, `device/folders.test.ts › lists a folder under the folder it follows now, once, and drops one whose state was removed`.

### `folders/registry-removed-state`

When a registry read finds a readable directory whose folder state was removed, a device MUST remove that directory’s registry entry.

**Tests:** `device/folders.test.ts › lists a folder under the folder it follows now, once, and drops one whose state was removed`.

### `folders/registry-missing-kept`

When a registry read finds a listed folder missing or unreadable, a device MUST retain its entry.

**Tests:** `device/folders.test.ts › holds a delete while a listed folder is missing, until it lists itself again`, `device/folders.test.ts › keeps a folder it cannot read listed, and holds a delete meanwhile`.

### `folders/registry-unreadable-deletes-held`

When the machine’s registry cannot be read or disappears during a folder pass, a device MUST defer deletion of missing files whose move cannot be ruled out.

**Tests:** `device/folders.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`, `device/folders.test.ts › holds a delete for a pass when the registry it was listed in is gone, and lists itself again`.

### `folders/registry-invalid-replaced-on-add`

When a folder is added and the registry’s existing contents cannot be parsed, a device MUST replace the registry with a valid entry for that folder.

**Tests:** `device/folders.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

### `folders/one-folder-worker`

While a process holds a folder for work, the command MUST refuse another working command on that folder with `reading_handle` before changing local or server state.

**Tests:** `device/folders.test.ts › refuses to remove a folder a watch holds`, `device/folders.test.ts › lets one process work a folder at a time, and answers its status beside it`.

### `folders/status-beside-watch`

While another process watches a folder, the command MUST answer `folders status` without acquiring the folder’s working handle.

**Tests:** `device/folders.test.ts › lets one process work a folder at a time, and answers its status beside it`.

### `folders/cross-folder-copy`

When a file’s ID already appears in another folder and the receiving folder already binds that item or its search excludes the item, a device MUST admit the arriving file as a new item.

**Tests:** `device/folders.test.ts › tells a copy into another folder from a move`.

### `folders/cross-folder-member-adopted`

When a file arrives with an ID held by the receiving folder’s search and that folder has no file for the item, a device MUST bind the arriving file to the existing item.

**Tests:** `device/folders.test.ts › takes a copy into a folder that holds the item and has no file of it as the item's file`.

### `folders/cross-folder-item-read`

When a file arrives with an ID held only by another folder’s copy and no file elsewhere still carries it, a device MUST read and pin the item from the server before binding it as the same item.

**Tests:** `device/folders.test.ts › does not trash a file moved to another folder`, `device/folders.test.ts › gives a fresh id to a moved file whose item the server will not show, and pins one it shows`, `device/folders.test.ts › takes in a file another folder let go`.

### `folders/cross-folder-hidden-item`

When the server will not show the item named by a moved file’s ID, a device MUST admit the file as a new item.

**Tests:** `device/folders.test.ts › gives a fresh id to a moved file whose item the server will not show, and pins one it shows`.

### `folders/saved-back-binding`

When a file is saved back at a path whose binding remains after another folder took its file, a device MUST treat it as the bound item until that binding is released.

**Tests:** `device/folders.test.ts › keeps a file saved back where another folder took the item's file from as the item's while its binding lasts`.

### `folders/moved-file-not-trashed`

When a missing folder file is found in another registered folder as the same file by identity, carried ID or unambiguous bytes, a device MUST release the missing file’s binding.

**Tests:** `device/folders.test.ts › does not trash a file moved to another folder`, `device/folders.test.ts › finds a file moved into a dot-led directory the other folder includes`, `device/folders.test.ts › follows a move by copy and delete, by id and by bytes`, `device/folders.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders.test.ts › does not trash a file moved to another folder and saved there anew`, `device/folders.test.ts › does not trash an unmatched file moved by copy and delete into a folder that holds its item`, `device/folders.test.ts › follows identical files moved by identity, and makes identical copies new items`.

### `folders/moved-file-not-trashed-item-preserved`

When a missing folder file is found in another registered folder as the same file by identity, carried ID or unambiguous bytes, a device MUST NOT trash the item.

**Tests:** `device/folders.test.ts › does not trash a file moved to another folder`, `device/folders.test.ts › finds a file moved into a dot-led directory the other folder includes`, `device/folders.test.ts › follows a move by copy and delete, by id and by bytes`, `device/folders.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders.test.ts › does not trash a file moved to another folder and saved there anew`, `device/folders.test.ts › does not trash an unmatched file moved by copy and delete into a folder that holds its item`, `device/folders.test.ts › follows identical files moved by identity, and makes identical copies new items`.

### `folders/moved-file-count`

When a scan identifies a missing folder file as moved to another registered folder, a device MUST count it as `moved_away`.

**Tests:** `device/folders.test.ts › does not trash a file moved to another folder`.

### `folders/peer-owned-bytes-not-move`

When another folder’s equal bytes belong to a different item, a device MUST NOT identify that file as the missing file’s move.

**Tests:** `device/folders.test.ts › does not take another folder's file with the same bytes for a moved one`.

### `folders/both-folders-copy`

When two folder searches both hold an item and each folder has its own bound file, a device MUST NOT interpret either file as the other’s move.

**Tests:** `device/folders.test.ts › tells a copy into another folder from a move`.

### `folders/missing-file-trashed`

When a missing folder file’s deletion grace expires and no other folder holds the moved file, a device MUST queue deletion of its item.

**Tests:** `device/folders.test.ts › trashes a missing file found in no folder on the Mac, and says so`.

### `folders/missing-file-trashed-path-reported`

When a missing folder file’s deletion grace expires and no other folder holds the moved file, a device MUST name the path in the scan report’s `trashed`.

**Tests:** `device/folders.test.ts › trashes a missing file found in no folder on the Mac, and says so`.

### `folders/missing-file-said`

When a missing folder file is trashed after no other folder holds it, the command MUST say that no folder on the machine holds the file.

**Tests:** `device/folders.test.ts › trashes a missing file found in no folder on the Mac, and says so`.

### `folders/uncertain-move-deferred`

When a missing folder file could be in unreadable registered folders or several files elsewhere have its bytes, a device MUST defer its deletion.

**Tests:** `device/folders.test.ts › holds a delete where several files in another folder have its bytes`, `device/folders.test.ts › holds a delete while another folder cannot be read whole`, `device/folders.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

### `folders/uncertain-move-deferred-unsure-reported`

When a missing folder file could be in unreadable registered folders or several files elsewhere have its bytes, a device MUST name the uncertainty in `unsure`.

**Tests:** `device/folders.test.ts › holds a delete where several files in another folder have its bytes`, `device/folders.test.ts › holds a delete while another folder cannot be read whole`, `device/folders.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

### `folders/moved-arrival-bytes`

When a non-document file arrives from another folder whose missing-file binding uniquely identifies it by identity or bytes, a device MUST bind the arriving file to the existing item.

**Tests:** `device/folders.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders.test.ts › follows identical files moved by identity, and makes identical copies new items`.

### `folders/moved-awaiting-peer`

When a folder item’s moved file is present in another folder but not bound there yet, a device MUST count the item as `elsewhere`.

**Tests:** `device/folders.test.ts › does not trash a file moved to another folder`.

### `folders/moved-awaiting-peer-no-replacement`

When a folder item’s moved file is present in another folder but not bound there yet, a device MUST NOT write a replacement file.

**Tests:** `device/folders.test.ts › does not trash a file moved to another folder`.

## Taking in another folder’s file

### `folders/take-in-file`

When another registered folder no longer holds an item for a non-state reason and still holds only its own written file bytes, and the receiving folder’s search holds that item without a file, a device MUST take that file into its placement.

**Tests:** `device/folders.test.ts › takes in a file another folder let go`.

### `folders/take-in-file-taken-count`

When another registered folder no longer holds an item for a non-state reason and still holds only its own written file bytes, and the receiving folder’s search holds that item without a file, a device MUST count the file as `taken`.

**Tests:** `device/folders.test.ts › takes in a file another folder let go`.

### `folders/take-in-edited-source-kept`

When another folder’s let-go file was edited since that folder last read it, a device MUST leave the source file for its own folder to send.

**Tests:** `device/folders.test.ts › does not take in a let-go file edited since its folder last read it`.

### `folders/take-in-state-excluded`

When an item left another folder by state, a device MUST NOT take in that folder’s file as a non-state departure.

**Tests:** `device/folders.test.ts › does not take in the file of an item that left its folder by state`.

### `folders/take-in-destination-kept`

When a file appears at the destination before a move-in lands, a device MUST preserve the destination file.

**Tests:** `device/folders.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folders/take-in-destination-kept-unwritten-count`

When a file appears at the destination before a move-in lands, a device MUST report the refused placement as `unwritten`.

**Tests:** `device/folders.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folders/take-in-refused-source-kept`

When a move-in cannot land because its destination became occupied, a device MUST retain the source file at its original path.

**Tests:** `device/folders.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folders/take-in-binding-kept`

When a move-in is refused because its destination became occupied, a device MUST preserve the destination’s previous binding through that pull’s departure cleanup.

**Tests:** `device/folders.test.ts › keeps both files when a destination appears just before a move-in (%s)`, `device/folders.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folders/take-in-journal-ownership`

When a folder adopts matching destination bytes or takes in another folder’s file, a device MUST clear the arriving item’s journal entry.

**Tests:** `device/folders.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folders/take-in-previous-journal-kept`

When a folder adopts matching destination bytes or takes in another folder’s file, a device MUST preserve any previous owner’s deletion journal entry.

**Tests:** `device/folders.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folders/take-in-copy-fallback`

When a move-in fails across volumes or because a readable regular source has positively confirmed immutable protection, a device MUST try a copy with the same absent-target no-replace guarantee.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`, `device/folders.test.ts › preserves a source across copy publication failures (%s)`.

### `folders/take-in-denial-no-fallback`

When a move-in fails with an ordinary permission denial and immutable protection is not confirmed, a device MUST refuse the move rather than copy the source.

**Tests:** `device/folders.test.ts › refuses an ordinary source removal denial instead of copying`.

### `folders/take-in-copy-metadata`

When a move-in uses a copy, a device MUST preserve the source’s permissions and applicable extended attributes, including Finder tags and quarantine.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/take-in-copy-refusal`

When a move-in copy cannot preserve an attribute, verify the complete bytes or confirm unchanged regular-file identity before publication, a device MUST refuse publication.

**Tests:** `device/folders.test.ts › preserves a source across copy publication failures (%s)`.

### `folders/take-in-copy-refusal-source-preserved`

When a move-in copy cannot preserve an attribute, verify the complete bytes or confirm unchanged regular-file identity before publication, a device MUST preserve the source.

**Tests:** `device/folders.test.ts › preserves a source across copy publication failures (%s)`.

### `folders/take-in-copy-source-protection`

When a move-in uses a copy because the source is immutable, a device MUST leave the source’s protection unchanged.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/take-in-destination-unprotected`

When a move-in uses a copy because the source is immutable, a device MUST NOT apply immutable protection to the destination.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/take-in-source-retained`

When a successful move-in copy cannot remove its source, a device MUST leave the source’s binding and journal intact.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-reported`

When a copied source remains in its original folder because removal is denied, a device MUST retain the file’s unmatched status.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-reported-unwritten-count`

When a copied source remains in its original folder because removal is denied, a device MUST report the file as `unwritten`.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-reported-bytes-preserved`

When a copied source remains in its original folder because removal is denied, a device MUST NOT rewrite the file.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-later-removal`

When removal of a retained copied source becomes possible and its identity and bytes still belong to the original folder, a device MUST remove the source.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-item-preserved`

When removal of a retained copied source becomes possible and its identity and bytes still belong to the original folder, a device MUST NOT trash the item.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/retained-source-edit-kept`

When the person edits a retained copied source before its removal becomes possible, a device MUST preserve the edit for that source folder to send.

**Tests:** `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/let-go-existing-peer`

When another registered folder already holds its own file for an item this folder no longer holds, a device MUST remove this folder’s unchanged owned file.

**Tests:** `device/folders.test.ts › takes in a file another folder let go`.

### `folders/let-go-existing-peer-let-go-count`

When another registered folder already holds its own file for an item this folder no longer holds, a device MUST count this folder’s file as `let_go`.

**Tests:** `device/folders.test.ts › takes in a file another folder let go`.

### `folders/unmatched-missing-not-rewritten`

When a bound unmatched file is missing from disk, a device MUST leave the missing file for the scan’s deletion journal rather than recreate it during a pull.

**Tests:** `device/folders-contract-b.test.ts › does not count a missing unmatched file as put back when restoring a removal`.

### `folders/two-folders-editable`

When two folder searches hold one item, a device MUST keep each folder’s bound file editable through that folder’s own queue.

**Tests:** `device/folders.test.ts › keeps two folders' files for one item editable`.

### `folders/two-folders-delete`

When the person deletes either of two files whose folders both hold the item, a device MUST trash the item after the deletion grace rather than treat the other folder’s file as a move.

**Tests:** `device/folders.test.ts › keeps two folders' files for one item editable`, `device/folders.test.ts › trashes a file item deleted where both folders hold it`.

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

**Tests:** `device/folders.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folders/confirm-moves-first-moved-count`

When a paused disk removal is confirmed, a device MUST count a file found moved as `moved`.

**Tests:** `device/folders.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folders/confirm-moves-first-item-preserved`

When a paused disk removal is confirmed, a device MUST NOT trash an item whose file was found moved.

**Tests:** `device/folders.test.ts › looks for a paused removal's files in the other folders before confirming it`.

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

**Tests:** `device/folders.test.ts › lets a paused removal go once confirmed, or puts it back`, `device/folders.test.ts › looks for a paused removal's files in the other folders before confirming it`.

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

When a folder push reports a paused disk or pull removal, the command MUST state the paused count and name `folders confirm` and `folders restore` as the ways to resolve it.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders-contract-b.test.ts › says a pull-side removal waits in push output with both ways to resolve it`.

### `folders/pause-watch-once`

While a paused folder removal remains unchanged, the command MUST say its watch notice only once.

**Tests:** `device/folders.test.ts › says a paused removal once while watching`.

### `folders/size-warning`

When a folder scan admits a new or edited document whose JSON-encoded text reaches 943718 bytes, a device MUST include a `size` warning naming that path and size.

**Tests:** `device/folders.test.ts › warns of a text near the limit`, `device/folders-contract-b.test.ts › warns at the exact JSON-encoded size boundary including escaped text`.

### `folders/size-warning-said`

When a folder push scans a document with a size warning, the command MUST say the path and warning in words.

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

When the command reads a folder’s status, the command MUST answer from the folder’s disk and local store without contacting the server.

**Tests:** `device/folders-contract-b.test.ts › reads status from disk and the held copy without contacting the server`.

### `folders/status-files`

When a device reads a folder’s status, a device MUST report each reached file and each bound file with its path, bound item ID when present, status and applicable waits or refusal reason.

**Tests:** `device/folders.test.ts › reports each file's status`.

### `folders/status-unreadable-document`

When a new folder document’s frontmatter cannot be parsed or names a refused own field, a device MUST report its status as `held` with flag `unreadable` before binding it.

**Tests:** `device/folders.test.ts › reports each file's status`.

### `folders/status-encoding`

When a new folder document is not UTF-8, a device MUST report its status as `held` with flag `encoding`.

**Tests:** `device/folders.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

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

When a folder pull writes a file item or updates an unchanged scanned file’s permission, a device MUST apply the item’s executable value by adding execute bits wherever read bits are set or clearing all execute bits.

**Tests:** `device/folders.test.ts › gives a pulled file the permission its item holds`, `device/folders-contract-b.test.ts › applies execute bits only where each read bit is set`.

### `folders/executable-owner-edit-kept`

When a bound file’s executable permission changes after the folder scan read it, a device MUST preserve the person’s permission through a pull for the next scan to send.

**Tests:** `device/folders.test.ts › gives a pulled file the permission its item holds`.

### `folders/permission-probe-failed`

Where a volume does not preserve executable permissions or the folder cannot establish that it does, a device MUST leave executable permissions unchanged on the item.

**Tests:** `device/folders-contract-b.test.ts › leaves executable permissions alone when its permission probe fails`.

### `folders/permission-probe-failed-file-preserved`

Where a volume does not preserve executable permissions or the folder cannot establish that it does, a device MUST leave executable permissions unchanged on the file.

**Tests:** `device/folders-contract-b.test.ts › leaves executable permissions alone when its permission probe fails`.

### `folders/permission-write-refused`

When the filesystem refuses a folder pull’s executable-permission change, a device MUST leave the file’s permissions as they are.

**Tests:** `device/folders-contract-b.test.ts › keeps a file's permissions when a permission change is refused and continues pulling`.

### `folders/permission-write-refused-pull-continues`

When the filesystem refuses a folder pull’s executable-permission change, a device MUST continue pulling other files.

**Tests:** `device/folders-contract-b.test.ts › keeps a file's permissions when a permission change is refused and continues pulling`.

### `folders/quarantine-in-place`

Where a device runs on macOS, when a folder pull makes an existing file runnable, a device MUST apply quarantine before enabling execution.

**Tests:** `device/folders.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

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

**Tests:** `device/folders.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

### `folders/document-not-quarantined`

Where a device runs on macOS, when a folder pull renders a document, a device MUST NOT mark the document with download quarantine.

**Tests:** `device/folders.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

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

**Tests:** `device/folders.test.ts › keeps the item of a renamed file that is still settling (replacement %s)`.

### `folders/settling-rename-identity-bytes-not-read`

When a non-document file is renamed while its bytes are still settling, a device MUST NOT read the changing bytes.

**Tests:** `device/folders.test.ts › keeps the item of a renamed file that is still settling (replacement %s)`.

### `folders/still-changing-notice`

While a folder file never settles enough for the watch to read it, the command MUST say once that the file is still changing and has not been sent.

**Tests:** `device/folders.test.ts › says once that a file which never stops changing has not been sent`.

### `folders/watch-answered-waiting`

When a folder watch reports a pass, the command MUST distinguish answered writes from writes still waiting.

**Tests:** `device/folders.test.ts › says once that a watch cannot reach the server, and once that it can again`.

### `folders/watch-unreachable-once`

When a folder watch loses or regains access to the server, the command MUST say the reachability change once without repeating it while unchanged.

**Tests:** `device/folders.test.ts › says once that a watch cannot reach the server, and once that it can again`.

### `folders/watch-hydration-notice`

While a folder watch retries an environmentally failed hydration, the command MUST say the failure once for that run of failures.

**Tests:** `device/folders.test.ts › keeps watching through a hydration that failed, and tries it again`.

### `folders/push-stopped-reason`

When a folder push’s drain stops, the command MUST say why it stopped.

**Tests:** `device/folders.test.ts › says why a push's drain stopped`.

### `folders/watch-credential-exit`

When a folder watch receives the server’s contract-named credential refusal, the command MUST end the watch with exit code 5.

**Tests:** `device/folders.test.ts › stops a watch whose credential is refused, with the credential's exit`.

### `folders/watch-credential-exit-reason-said`

When a folder watch receives the server’s contract-named credential refusal, the command MUST say that writes wait for a working credential.

**Tests:** `device/folders.test.ts › stops a watch whose credential is refused, with the credential's exit`.

### `folders/gateway-refusal-waited`

When a folder watch receives `401` without the server’s contract header, a device MUST retry as an environmental failure instead of treating the credential as refused.

**Tests:** `device/folders.test.ts › waits out a gateway refusing its key, naming no contract, without stopping`.

## Local refusals and first sync

### `folders/invalid-document-contained`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST retain the file’s bytes.

**Tests:** `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`.

### `folders/invalid-document-flagged`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST flag the local refusal.

**Tests:** `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`.

### `folders/invalid-document-scan-continues`

When a folder document fails local field validation or names a type absent from the held catalog, a device MUST continue scanning other files.

**Tests:** `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`.

### `folders/invalid-document-retried`

When a refused folder document is corrected or its type becomes available in the held catalog, a device MUST retry admission at a later scan.

**Tests:** `device/property-validation.test.ts › contains document refusals, preserves bytes through a rename and retries corrected files`, `device/property-validation.test.ts › retries unchanged document bytes after their destination type is registered`.

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

While a folder’s first sync waits, the command MUST refuse to start a watch with `first_sync_waiting`.

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

### `folders/first-sync-terminal-question`

When `folders add` has a nonempty first-sync plan at a terminal without `--yes` or `--json`, the command MUST ask for confirmation.

**Tests:** `device/folders-contract-b.test.ts › asks before first sync at a terminal and obeys %s`.

### `folders/first-sync-terminal-answer`

When `folders add` has a nonempty first-sync plan at a terminal without `--yes` or `--json`, the command MUST proceed only for `y` or `yes` without regard to case.

**Tests:** `device/folders-contract-b.test.ts › asks before first sync at a terminal and obeys %s`.

### `folders/first-sync-interrupted-confirmed`

When a confirmed folder’s sync is interrupted by a failed file landing, a device MUST keep first sync confirmed for the next attempt and for a later add over the same state.

**Tests:** `device/folders-contract-b.test.ts › keeps first sync confirmed after a failed landing and after adding the folder again`.

### `folders/first-sync-yes`

When `folders add` is given `--yes`, the command MUST confirm the folder’s first sync without asking for input.

**Tests:** `device/folders.test.ts › refuses a watch while it waits, and a script confirms it with --yes`.

### `folders/first-sync-confirm`

When `folders confirm` is given a waiting folder, the command MUST clear the first-sync wait.

**Tests:** `device/folders.test.ts › goes once it is confirmed, and does not ask again`, `device/folders-contract-b.test.ts › refuses restore while first sync waits and confirms without a server request`.

### `folders/first-sync-confirm-local-only`

When `folders confirm` is given a waiting folder, the command MUST NOT contact the server.

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

## Refused document names and settings

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

### `folders/settings-name-refusal`

If saved folder settings contain a refused default tag, a refused default property name or a filter comparison with `null`, then a device MUST refuse to read those settings.

**Tests:** `device/folder-names.test.ts › stops where it is told, naming the setting, and runs with a default it takes`, `device/folder-names.test.ts › says which setting, what is wrong with it and how to change it`.

### `folders/settings-name-guidance`

If saved folder settings contain a refused default tag, a refused default property name or a filter comparison with `null`, then a device MUST name the setting, explain the refusal and identify `marfa folders change` as the command that changes it.

**Tests:** `device/folder-names.test.ts › says which setting, what is wrong with it and how to change it`, `device/folders-contract-c.test.ts › names each refused default and explains how to change it`.

## Giving way to another machine's placement

### `folders/placement-newer-copy`

When a device gives way to another machine's placement, a device MUST retain a newer placement already held in its working copy instead of replacing it with the older placement read from the server.

**Tests:** `device/folders.test.ts › follows a move it heard of after the read it gives way from`.

### `folders/placement-give-way-atomic`

When a device gives way to another machine's placement, a device MUST expose the server's placement and withdrawal of its own placement writes as one change to the working copy.

**Reason:** A concurrent caller must not observe the withdrawn local move without the placement that replaces it.

**Tests:** waiting on #1890.

### `folders/placement-forget-unchanged`

When a placement read during giving way finds an edge missing from the server, a device MUST remove that edge from its working copy only if the edge has not changed in the copy since the read began.

**Tests:** waiting on #1890.

## Names made from titles

### `folders/title-separators`

When a device makes a file name from an item's title, a device MUST replace `/`, `\` and `:` with `-`.

**Tests:** `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folders/title-controls`

When a device makes a file name from an item's title, a device MUST replace each control character with a space.

**Tests:** `device/folders.test.ts › names a new item's file from its title, cut to the longest name a file system takes`, `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folders/title-trimming`

When a device makes a file name from a nonblank item title, a device MUST trim surrounding whitespace and leading dots, using `untitled` when that leaves an empty name.

**Tests:** `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folders/name-byte-limit`

When a generated file name would exceed 255 bytes of UTF-8, a device MUST shorten its stem at a character boundary to fit within 255 bytes, retaining any numbering suffix and an extension of at most 32 bytes including its dot.

**Tests:** `device/folders.test.ts › names a new item's file from its title, cut to the longest name a file system takes`, `device/folders-contract-c.test.ts › keeps a 32-byte extension whole and treats a longer ending as stem when fitting UTF-8 names`.

### `folders/name-long-ending`

When a generated file name has more than 32 bytes from its last dot to its end, a device MUST treat that ending as part of the stem when shortening the name.

**Tests:** `device/folders-contract-c.test.ts › keeps a 32-byte extension whole and treats a longer ending as stem when fitting UTF-8 names`.

## Items a pull does not write

### `folders/pull-flagged-items`

When a pull counts an item as `unwritten`, `outside`, `unsuited` or `absent`, a device MUST include the item's ID, intended path or retained file path, flag and reason in the pull report's `flagged` entries, using `retained` as the flag for a file it could not let go to another folder.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folders.test.ts › refuses to write a file outside the folder`, `device/folders.test.ts › does not write over a file it never wrote`, `device/folders.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`, `device/folders.test.ts › writes no file where its placement would make it another kind of file`, `device/folders.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folders/report-distinct-items`

When `folders push` or `folders watch` reports items held back by a pull, the command MUST report each item once, including separate entries for different items at the same path.

**Tests:** `device/folders.test.ts › names each item it holds back at a secret's name, two at one path as two`.

### `folders/elsewhere-unflagged`

When a pull counts an item as `elsewhere` because its file is moving to another folder on the machine, a device MUST NOT include the item in the pull report's `flagged` entries.

**Tests:** `device/folders.test.ts › does not trash a file moved to another folder`.

## A push that leaves a folder in step

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

## Conflict and watch reports

### `folders/conflict-file-report`

When `folders push` or a `folders watch` pass receives a `conflicted` verdict for an edit to a file in that folder, the command MUST name the file in its text output.

**Tests:** `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`, `cli/folder.test.ts › says a conflicted edit while watching, and where its text went`, `device/folders.test.ts › names the file a conflicted edit's text went to, in a push`, `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`.

### `folders/conflict-copy-file`

When `folders push` or `folders watch` reports a conflicted edit whose conflicted copy has a file in that folder, the command MUST name that file as the destination of the edit's text.

**Tests:** `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`, `cli/folder.test.ts › says a conflicted edit while watching, and where its text went`, `device/folders.test.ts › names the file a conflicted edit's text went to, in a push`.

### `folders/conflict-copy-pending`

When `folders push` or `folders watch` reports a conflicted edit whose conflicted copy has no file in that folder yet, the command MUST say that the copy is not a file in the folder yet.

**Tests:** `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`.

### `folders/conflict-copy-arrival`

When a `folders watch` pass writes a conflicted copy previously reported as having no file yet, the command MUST report the file that now holds the edit's text.

**Tests:** `device/folders.test.ts › says in a watch the file a conflicted copy became, once it is one`.

### `folders/conflict-report-once`

When `folders push` or `folders watch` has reported a conflicted write, the command MUST NOT report that verdict again.

**Tests:** `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`, `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`.

### `folders/conflict-other-item`

When a conflicted write belongs to an item with no file in the watched or pushed folder, the command MUST NOT report that conflict as the folder's.

**Tests:** `device/folders.test.ts › does not name a conflict on a write that is no file of the folder's, in a push`, `device/folders.test.ts › does not name a conflict on a write that is no file of the folder's, in a watch`.

### `folders/watch-grace-silent`

When a `folders watch` pass only waits for a journaled deletion's grace period to end, the command MUST produce no report for that pass.

**Tests:** `device/folders.test.ts › says nothing for passes that only wait out a delete's grace`.

### `folders/watch-notice-once`

When a `folders watch` pass reports new activity, the command MUST NOT repeat a standing notice unchanged since the preceding pass.

**Tests:** `device/folders.test.ts › says a refused secret once while a delete waits out its grace and other passes report`.

### `folders/watch-notice-change`

When a standing notice changes during `folders watch`, the command MUST report the changed notice in the pass that observes it.

**Tests:** `device/folders.test.ts › says a refused secret in words once while watching`.

## A pull whose working copy changes

### `folders/pull-gone-item-file`

If an item leaves the working copy before a pull writes its file, then a device MUST NOT write a file for that item.

**Tests:** `device/folders.test.ts › writes no file for a row purged while the pull writes it, and reads the copy again`.

### `folders/pull-gone-item-binding`

If an item leaves the working copy before a pull writes its file, then a device MUST NOT bind a file to that item.

**Tests:** `device/folders.test.ts › writes no file for a row purged while the pull writes it, and reads the copy again`.

### `folders/pull-gone-item-placement`

If an item leaves the working copy before a pull queues its placement, then a device MUST NOT queue a placement for that item.

**Tests:** `device/folders.test.ts › places nothing for a row purged before its placement is queued, and takes its file away at the next pull`.

### `folders/pull-gone-item-continue`

If an item leaves the working copy during a pull, then a device MUST continue the pull without failing solely because that item is gone.

**Tests:** `device/folders.test.ts › writes no file for a row purged while the pull writes it, and reads the copy again`, `device/folders.test.ts › places nothing for a row purged before its placement is queued, and takes its file away at the next pull`.

### `folders/pull-retry-copy`

When the working copy changes under a pull, a device MUST restart the pull from a fresh read of the copy, making at most three attempts in total.

**Tests:** `device/folders.test.ts › pulls again where the copy changes under the pull`, `device/folders-contract-c.test.ts › retries a changed copy three times in total and succeeds on the third stable read`.

### `folders/watch-copy-change-notice`

When the working copy keeps changing under consecutive `folders watch` passes, the command MUST report the condition once for that run of passes.

**Tests:** `device/folders.test.ts › goes on watching where the copy keeps changing under its pull, and says so once`.

### `folders/watch-copy-change-retry`

When a watch pass exhausts its pull attempts because the working copy keeps changing, a device MUST continue watching and retry the pull in the next pass.

**Tests:** `device/folders.test.ts › goes on watching where the copy keeps changing under its pull, and says so once`.

### `folders/purged-file-remove`

When a catch-up has applied an item's purge and its folder file still contains the bytes last written by the device, a device MUST remove that file at the next pull.

**Tests:** `device/folders.test.ts › removes a purged item's file where its bytes are the folder's own, and says so`.

### `folders/purged-file-count`

When a pull removes a purged item's file, a device MUST count that file in both `removed` and `purged`.

**Tests:** `device/folders.test.ts › removes a purged item's file where its bytes are the folder's own, and says so`.

### `folders/purged-edit-preserve`

When a purged item's file has changed since the device last wrote it, a device MUST preserve that file during a pull.

**Tests:** `device/folders.test.ts › keeps a purged item's file the person changed since the folder wrote it, and says so`.

### `folders/purged-edit-count`

When a pull preserves a purged item's changed file, a device MUST count that file as `kept`.

**Tests:** `device/folders.test.ts › keeps a purged item's file the person changed since the folder wrote it, and says so`.

### `folders/purged-removal-report`

When `folders pull` or `folders watch` reports removed files, the command MUST distinguish files removed because their items were purged from files removed because their items were trashed or left by state.

**Tests:** `device/folders.test.ts › says in words that a purged item's file was removed`, `device/folders.test.ts › says while watching that a purged item's file was removed`.

### `folders/purged-placement-refusal`

When a refused placement belongs to an item no longer held in the working copy, a device MUST stop reporting that placement as refused.

**Tests:** `device/folders.test.ts › lets go of a refused placement once its item is purged`.

### `folders/pull-retry-counts`

When a pull restarts after its working copy changes, a device MUST include completed file writes, rewrites, moves, revivals, placements, placement ends, removals, purged-file removals, transfers in and transfers out from earlier attempts in its final report.

**Tests:** `device/folders.test.ts › counts what an attempt wrote before the copy changed under it`, `device/folders-contract-c.test.ts › counts files and placements from before a restarted pull exactly once`, `device/folders-contract-c-retry.test.ts › retains rewrite and move counts across a restart`, `device/folders-contract-c-retry.test.ts › retains revival counts across a restart`, `device/folders-contract-c-retry.test.ts › retains removal, purge and placement-end counts across a restart`, `device/folders-contract-c-retry.test.ts › retains transfer-%s counts across a restart`.

## When a placement ends

### `folders/placement-end-departure`

When a file leaves a folder because its item was trashed or left the search's states, a device MUST delete that folder's `in-folder` edge for the item.

**Tests:** `device/folders.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `device/folders.test.ts › ends a folder's placement of an item that leaves by state, and places it again when it returns`, `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folders/placement-end-transfer`

When a file transfers to another folder on the machine and its original folder's search no longer holds its item, a device MUST delete the original folder's `in-folder` edge for the item.

**Tests:** `device/folders.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `cli/folder.test.ts › ends a folder's placement of an item whose file another folder took in, and no sooner`.

### `folders/placement-end-delete`

When a scan sends a missing file's item deletion or finds its item already trashed, a device MUST delete that folder's `in-folder` edge for the item.

**Tests:** `device/folders.test.ts › ends a folder's placement of an item whose file the person deleted`, `device/folders-contract-c-retry.test.ts › ends the placement of a missing file already trashed on another device`.

### `folders/placement-last-binding`

While another file in the folder remains bound to an item, a device MUST NOT end that folder's placement of the item.

**Tests:** waiting on #1890.

### `folders/placement-end-retry`

If ending a departing file's placement fails locally, then a device MUST retain the file's binding so a later pass can retry ending the placement.

**Tests:** `device/folders.test.ts › keeps the file and the placement where ending the placement fails, and ends it at the next push`, `device/folders.test.ts › keeps the binding of a deleted file where ending its placement fails, and ends it at the next push`, `device/folders.test.ts › leaves the binding of a file it let go where ending the placement fails, and the scan ends it past the grace`.

### `folders/placement-purge-no-delete`

When an item's purge removes its placement from the working copy, a device MUST NOT send a separate deletion of that placement.

**Tests:** `device/folders.test.ts › sends nothing to end the placement of a purged item, which the purge took with it`.

### `folders/placement-held-transfer`

When a file moves to a folder that does not hold its item but its original folder's search still holds the item, a device MUST retain the original folder's placement.

**Tests:** `device/folders.test.ts › keeps a folder's placement of an item it holds when its file is moved to a folder that does not`.

### `folders/placement-unmatched-kept`

While a folder retains an item's file as `unmatched`, a device MUST retain that folder's placement of the item.

**Tests:** `device/folders.test.ts › keeps a folder's placement of an item whose file stays where it is`.

### `folders/placement-restore-new`

When a folder's search holds an item again after its placement ended, a device MUST place the item using the current first-placement setting or title as for a new item.

**Tests:** `device/folders.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folders/placement-end-count`

When a pull queues the end of a placement, a device MUST count that end in the pull report's `ended` field.

**Tests:** `device/folders.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `device/folders.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `device/folders.test.ts › ends a folder's placement of an item that leaves by state, and places it again when it returns`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folders/placement-end-same-push`

When a folder sync's pull ends a placement, a device MUST send that end in the same sync unless `folders/push-server-unavailable`, `folders/push-credential-stopped` or `folders/push-undelivered` prevents a further drain.

**Tests:** `device/folders.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `device/folders.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`.

### `folders/placement-end-already-gone`

When the server answers a placement's deletion with `edge_not_found`, a device MUST treat that placement as ended.

**Tests:** `device/folders.test.ts › takes the end of a placement another machine ended first as done`.

### `folders/placement-end-refused-queue`

When the server refuses a placement's deletion for the key's grant, a device MUST retain the refused deletion in the queue.

**Tests:** `device/folders.test.ts › asks once for the end of a placement the server refuses, and reports it`.

### `folders/placement-end-refused-once`

While a refused placement deletion remains in the queue, a device MUST NOT queue another deletion of the same placement.

**Tests:** `device/folders.test.ts › asks once for the end of a placement the server refuses, and reports it`.

## What the real server cannot be made to produce

The list and the reason for each entry are in `device.md`; `device/fidelity.test.ts` checks every answer the real server can produce against the scripted server's.
