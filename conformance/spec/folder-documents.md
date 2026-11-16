# What a document is

A folder is a directory bound to a `system.folder` item, with a working copy and a queue. The device and queue rules also apply (`device.md`, `queue-and-verdicts.md`).

This chapter holds which files a folder admits as documents, how a document's fields, name, title, versions, edge lines and links are read and written, and what a folder does with a file it cannot read.

## What a folder admits, and file names

### `folder-documents/include-empty`

When a folder’s include list is empty, a device MUST admit every path not excluded by dot-name rules, built-in lists or its ignore list.

**Tests:** `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`.

### `folder-documents/include-negation`

When the last applicable include pattern for a folder path is negated, a device MUST exclude that path from admission.

**Tests:** `device/folders-contract-b.test.ts › applies include negation, ignore precedence and case-normalized patterns`.

### `folder-documents/list-pattern-order`

When several patterns in one include or ignore list match the same path, a device MUST use the last matching pattern's inclusion or exclusion, including matches through equivalent Unicode names.

**Tests:** `device/folder-patterns.test.ts › resolves %s negations in line order across original and equivalent names`.

### `folder-documents/list-path-before-parent`

When an include or ignore pattern matches a file's path directly, a device MUST use that match before considering a pattern matching an ancestor directory.

**Tests:** `device/folder-patterns.test.ts › resolves an equivalent file pattern before a matching parent pattern`.

### `folder-documents/pattern-not-folder-root`

A device MUST NOT take or leave out a file at a folder's top level because an include or ignore pattern matches the folder's own directory.

**Reason:** git reads a list the same way, so a line that names only directories, such as `*/`, neither takes nor leaves out a top-level file. A bound file that such a line stops taking is kept, as `folder-documents/excluded-binding-kept` says.

**Tests:** `device/folders.test.ts › keeps a bound file at the top that a line naming only directories does not take`.

### `folder-documents/pattern-one-character`

When an include or ignore pattern holds a `?` or a bracket class, a device MUST match each against exactly one character of the path, whatever the character's length in bytes.

**Reason:** a device compares a pattern with the path as it compares names. A literal character in the pattern matches a character of the path when the two have the same case fold, so `É` matches `é` and `S` matches `ſ`, and a `?` or a class takes one character of the path as written, so `É?.md` leaves out `éß.md`. A pattern also matches when its whole case-folded text matches the whole case-folded path, so `STRASSE.md` matches `Straße.md`.

**Tests:** `device/folder-patterns.test.ts › matches a class or a ? against one character outside ASCII in %s patterns`.

### `folder-documents/invalid-pattern-refused`

When a folder’s include or ignore list contains an invalid gitignore pattern, a device MUST refuse admission using those settings.

**Tests:** `device/folders-contract-b.test.ts › refuses an invalid %s pattern before admission`.

### `folder-documents/include-paths`

When a folder has a nonempty include list, a device MUST admit only paths whose name or an ancestor directory matches an included gitignore pattern relative to the folder root.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folder-patterns.test.ts › keeps the members of the %s range in include patterns`, `device/folder-patterns.test.ts › preserves wildcard matches alongside Unicode equivalence in %s patterns`.

### `folder-documents/ignore-paths`

When a folder path matches its ignore list, a device MUST exclude that path from admission even when the include list also matches it.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`, `device/folders-contract-b.test.ts › applies include negation, ignore precedence and case-normalized patterns`, `device/folder-patterns.test.ts › keeps the members of the %s range in ignore patterns`, `device/folder-patterns.test.ts › preserves wildcard matches alongside Unicode equivalence in %s patterns`.

### `folder-documents/include-dot-directories`

When a folder path has a dot-led directory component, a device MUST admit it only where a non-negated include pattern explicitly names every dot-led directory on its path.

**Tests:** `device/folders.test.ts › reaches a dot-led path its include list names`, `device/folders.test.ts › excludes a dot-led directory at any depth`, `device/folders.test.ts › writes nothing under a dot-led directory its walk does not enter`, `device/folders.test.ts › takes nothing under a dot-led directory a negated include line names`, `device/folder-patterns.test.ts › keeps the members of the %s range when entering dot directories`.

### `folder-documents/builtin-machine-names`

A device MUST exclude `.DS_Store`, `Thumbs.db`, `._*`, `.Spotlight-V100`, `.Trashes`, `Icon` followed by a carriage return and `desktop.ini` from folder admission regardless of the configured lists.

**Tests:** `device/folders-contract-b.test.ts › keeps every built-in machine, temporary and secret name outside admission`.

### `folder-documents/builtin-temporary-names`

A device MUST exclude `*.swp`, `*~`, `.#*`, `#*#`, `~$*`, `*.tmp`, `.~lock.*#`, `*___jb_tmp___`, `*___jb_old___`, `*.crdownload`, `*.crswap`, `*.part` and `*.download` from folder admission regardless of the configured lists.

**Tests:** `device/folders.test.ts › never takes an editor's or a download's temporary file`, `device/folders-contract-b.test.ts › keeps every built-in machine, temporary and secret name outside admission`.

### `folder-documents/builtin-secret-names`

A device MUST exclude `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`, `credentials`, `*credentials.json` and `credentials.db` from folder admission regardless of the configured lists.

**Tests:** `device/folders.test.ts › never takes a secret whatever its lists say`, `device/folders-contract-b.test.ts › keeps every built-in machine, temporary and secret name outside admission`.

### `folder-documents/secrets-reported`

When a folder scan encounters a file excluded by a built-in secret pattern in a directory it walks, a device MUST name the file in the scan report’s `secrets`.

**Tests:** `device/folders.test.ts › never takes a secret whatever its lists say`.

### `folder-documents/secrets-said`

When a folder push or watch encounters a file excluded by a built-in secret pattern, the CLI MUST name the excluded file in words.

**Tests:** `device/folders.test.ts › never takes a secret whatever its lists say`, `device/folders.test.ts › says a refused secret in words once while watching`.

### `folder-documents/secret-notice-once`

While a folder file remains excluded by a built-in secret pattern, the CLI MUST say its watch notice only once.

**Tests:** `device/folders.test.ts › says a refused secret in words once while watching`, `device/folders.test.ts › says a refused secret once while a delete waits out its grace and other passes report`.

### `folder-documents/pull-outside-lists`

When a folder pull would write a path excluded by the folder’s lists, a device MUST report the item as `outside`.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folders.test.ts › writes nothing under a dot-led directory its walk does not enter`.

### `folder-documents/pull-outside-lists-file-unwritten`

When a folder pull would write a path excluded by the folder’s lists, a device MUST NOT write the item’s file.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folders.test.ts › writes nothing under a dot-led directory its walk does not enter`.

### `folder-documents/excluded-binding-kept`

When a folder’s lists stop admitting a bound file, a device MUST retain its binding.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folder-documents/excluded-no-deletion`

When a folder’s lists stop admitting a bound file, a device MUST NOT journal its deletion.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folder-documents/excluded-binding-kept-edits-unsent`

When a folder’s lists stop admitting a bound file, a device MUST NOT send its edits.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folder-documents/excluded-scan-count`

When a folder’s lists stop admitting a bound file, a device MUST count the file as `unreached` in the scan report.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folder-documents/excluded-pull-preserved`

When a folder’s lists stop admitting a bound file, a device MUST leave its bytes untouched during a pull.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folder-documents/included-again`

When a folder’s lists admit a previously excluded bound file again, a device MUST send its intervening edit to the same item.

**Tests:** `device/folders.test.ts › ignores what its ignore list names`.

### `folder-documents/package-scan`

When a folder scan encounters a directory ending in `.app`, `.bundle`, `.pages`, `.numbers`, `.key`, `.photoslibrary`, `.xcodeproj` or `.rtfd` without regard to case, a device MUST report the directory as `package`.

**Tests:** `device/folders.test.ts › does not walk into a package`, `device/folders-contract-b.test.ts › reports every built-in package extension without scanning its contents`.

### `folder-documents/package-scan-contents-excluded`

When a folder scan encounters a directory ending in `.app`, `.bundle`, `.pages`, `.numbers`, `.key`, `.photoslibrary`, `.xcodeproj` or `.rtfd` without regard to case, a device MUST NOT admit the directory’s contents.

**Tests:** `device/folders.test.ts › does not walk into a package`, `device/folders-contract-b.test.ts › reports every built-in package extension without scanning its contents`.

### `folder-documents/macos-package-scan`

Where a device runs on macOS, when the operating system identifies a directory as a package by its type or Finder bundle bit, a device MUST report the directory as `package`.

**Tests:** `device/folders.test.ts › excludes a directory only while its Finder bundle bit is set`.

### `folder-documents/macos-package-scan-contents-excluded`

Where a device runs on macOS, when the operating system identifies a directory as a package by its type or Finder bundle bit, a device MUST NOT admit the directory’s contents.

**Tests:** `device/folders.test.ts › excludes a directory only while its Finder bundle bit is set`.

### `folder-documents/package-pull`

When a folder placement falls inside a package, a device MUST count the item as `outside`.

**Tests:** `device/folders.test.ts › does not walk into a package`.

### `folder-documents/package-pull-file-unwritten`

When a folder placement falls inside a package, a device MUST NOT write its file.

**Tests:** `device/folders.test.ts › does not walk into a package`.

### `folder-documents/unreadable-directory`

When a folder scan cannot read a directory or an entry’s details, a device MUST report that directory as `unreadable`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders-identity.test.ts › holds the files of a directory whose entries cannot be read`.

### `folder-documents/unreadable-directory-scan-continues`

When a folder scan cannot read a directory or an entry’s details, a device MUST continue scanning other directories.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders-identity.test.ts › holds the files of a directory whose entries cannot be read`.

### `folder-documents/unreadable-bindings`

When a folder scan cannot reach a bound file inside an unreadable directory, a device MUST count it as `unreached`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders-identity.test.ts › holds the files of a directory whose entries cannot be read`.

### `folder-documents/unreadable-no-deletion`

When a folder scan cannot reach a bound file inside an unreadable directory, a device MUST NOT journal its deletion.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`, `device/folders-identity.test.ts › holds the files of a directory whose entries cannot be read`.

### `folder-documents/unreadable-pull`

When a folder pull cannot write a bound file inside an unreadable directory, a device MUST retain its binding.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`.

### `folder-documents/unreadable-pull-unwritten-count`

When a folder pull cannot write a bound file inside an unreadable directory, a device MUST count the item as `unwritten`.

**Tests:** `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`.

### `folder-documents/title-separators`

When a device makes a file name from an item's title, a device MUST replace `/`, `\` and `:` with `-`.

**Tests:** `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folder-documents/title-controls`

When a device makes a file name from an item's title, a device MUST replace each control character with a space.

**Tests:** `device/folders-placement.test.ts › names a new item's file from its title, cut to the longest name a file system takes`, `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folder-documents/title-trimming`

When a device makes a file name from a nonblank item title, a device MUST trim surrounding whitespace and leading dots, using `untitled` when that leaves an empty name.

**Tests:** `device/folders-contract-c.test.ts › replaces separators and controls, trims hidden names, and names a dot-only title untitled`.

### `folder-documents/name-byte-limit`

When a generated file name would exceed 255 bytes of UTF-8, a device MUST shorten its stem at a character boundary to fit within 255 bytes, retaining any numbering suffix and an extension of at most 32 bytes including its dot.

**Tests:** `device/folders-placement.test.ts › names a new item's file from its title, cut to the longest name a file system takes`, `device/folders-contract-c.test.ts › keeps a 32-byte extension whole and treats a longer ending as stem when fitting UTF-8 names`.

### `folder-documents/name-long-ending`

When a generated file name has more than 32 bytes from its last dot to its end, a device MUST treat that ending as part of the stem when shortening the name.

**Tests:** `device/folders-contract-c.test.ts › keeps a 32-byte extension whole and treats a longer ending as stem when fitting UTF-8 names`.

### `folder-documents/name-comparison`

When a device compares folder paths, file names or titles, a device MUST treat two names as the same name where they are equal after each is put in normalization form NFC, has Unicode full case folding applied with no locale rule, and is put in NFC again.

**Reason:** a case-insensitive file system such as APFS compares names by full case folding, so two names the device kept apart could be one file on disk, and the second item would never be written.

**Tests:** `device/folders.test.ts › treats names differing only in case or Unicode form as one`, `device/folders-contract-b.test.ts › matches include names in NFC regardless of case and asks the server for a name once, in the form typed`, `device/folders-contract-b.test.ts › matches Unicode %s patterns with the folder name equivalence`, `device/folder-patterns.test.ts › matches escaped brackets and Unicode literals without turning them into classes`, `device/folder-patterns.test.ts › folds Unicode literals with an escape on the $position`.

### `folder-documents/same-name-scan-choice`

When distinct folder files have paths equal without regard to case or Unicode normalization, a device MUST admit the already-bound path or otherwise the first path in order.

**Tests:** `device/folders-contract-b.test.ts › chooses a bound path before path order when names compare equal`.

### `folder-documents/same-name-scan-choice-other-paths-held`

When distinct folder files have paths equal without regard to case or Unicode normalization, a device MUST hold the other paths with flag `name` until renamed.

**Tests:** `device/folders-contract-b.test.ts › chooses a bound path before path order when names compare equal`.

### `folder-documents/same-name-beside`

When two folder items are placed at names equal without regard to case or Unicode normalization, a device MUST place the later item beside the earlier one under a numbered name.

**Tests:** `device/folders.test.ts › treats names differing only in case or Unicode form as one`.

### `folder-documents/case-rename-unsent`

When a folder file is renamed only in case or Unicode normalization, a device MUST NOT queue a placement change for that rename.

**Tests:** `device/folders-contract-b.test.ts › does not send a placement for an equivalent rename to %s`.

### `folder-documents/lookup-any-normalization`

When a folder asks the server to resolve a title, a device MUST ask for the name once, as typed.

**Reason:** the server compares by a folded title key (`items/titles-fold`), so a device that asked once for each Unicode form, or for each spelling of the case, would send the server more requests than names without finding any more.

**Tests:** `device/folders-contract-b.test.ts › matches include names in NFC regardless of case and asks the server for a name once, in the form typed`.

### `folder-documents/state-not-admitted`

A device MUST exclude every file under a folder’s `.marfa/` state directory from item admission regardless of the include list.

**Tests:** `device/folders.test.ts › keeps its own state in .marfa and never pushes it`.

### `folder-documents/watched-settings`

When `.marfa/folder.yaml` changes during a folder watch, a device MUST submit the settings edit through the folder operation at its next pass.

**Tests:** `device/folders.test.ts › sends an edit to its settings file through the folder door`.

### `folder-documents/binary-outside-search`

When an unbound non-document file has no type held by a folder’s query and no document embeds it, a device MUST leave the file unsent.

**Tests:** `device/folders.test.ts › leaves a file outside its query alone`, `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folder-documents/binary-outside-search-skipped-count`

When an unbound non-document file has no type held by a folder’s query and no document embeds it, a device MUST count the file as `skipped`.

**Tests:** `device/folders.test.ts › leaves a file outside its query alone`, `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folder-documents/embedded-outside-search`

When a document in a folder embeds a file outside the folder’s query, or a file outside the query is attached to the document, a device MUST admit that file as the document’s attachment.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`, `› references an embedded file, and attaches it only where the query does not hold it`, `device/folders-frontmatter.test.ts › writes an embedded file where its link says`, `device/folders-frontmatter.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`, `› is written beside its document, and its has-attachment line reads back as the same edge`.

### `folder-documents/document-outside-search`

When a folder document names an admissible type outside the folder’s query, a device MUST create its item under that type.

**Tests:** `device/folders.test.ts › leaves a file outside its query alone`.

### `folder-documents/new-file-only-members`

When an item outside a folder’s query has no bound file, no document in the folder embeds it, and it is attached to no document in the folder, a device MUST NOT write a new file for the item.

**Tests:** `device/folders.test.ts › leaves a file outside its query alone`, `device/folders-frontmatter.test.ts › is written beside its document, and its has-attachment line reads back as the same edge`.

### `folder-documents/outside-document-unmatched`

When a folder document’s accepted type is outside the folder’s query, a device MUST count its bound file as `unmatched` at the next pull.

**Tests:** `device/folders.test.ts › leaves a file outside its query alone`.

## Document fields and presentation

### `folder-documents/own-field-lines`

When a device reads a Markdown file, a device MUST interpret a `type` line holding a type identifier (`types/id-grammar`), and the `tier`, `tags`, `state`, and `occurred_at` lines, as the item's own fields rather than properties.

**Tests:** `device/folders-frontmatter.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-frontmatter.test.ts › sets a new item's own time, from a date or from a date and time`.

### `folder-documents/property-lines`

When a Markdown frontmatter line names neither an own field, metadata line, nor an edge type or reverse name, a device MUST carry it as a property, including undeclared and nested values.

**Tests:** `device/folders.test.ts › carries frontmatter to properties and the body to the body`.

### `folder-documents/body-property`

When a device reads or writes a document, a device MUST use the type's resolved `body_field` as the body property, falling back to `body`.

**Tests:** `device/folders-frontmatter.test.ts › takes body and title from the type's display hints`, `device/folders-frontmatter.test.ts › takes each display hint from the nearest type that sets it, as the server resolves them`.

### `folder-documents/title-property`

When a device derives a document title from its filename or a filename from its title, a device MUST use the type's resolved `title_field`, falling back to `title`.

**Tests:** `device/folders-frontmatter.test.ts › takes body and title from the type's display hints`, `device/folders-frontmatter.test.ts › takes each display hint from the nearest type that sets it, as the server resolves them`.

### `folder-documents/body-over-line`

When a document has a frontmatter line for its current body property, a device MUST use the body in preference to that line, except during a retype to a different body property.

**Tests:** `device/folders.test.ts › carries frontmatter to properties and the body to the body`.

### `folder-documents/uncarried-report`

When a held type declares properties reserved for document own fields, metadata, or edge lines, a device MUST list those type/property pairs in the pull's `uncarried` report.

**Tests:** `device/folders-frontmatter.test.ts › reports a type that declares a property no file can carry, and keeps it`.

### `folder-documents/uncarried-preserve`

When a document is edited, a device MUST preserve item properties that cannot be carried as document properties, except a `type` property that the document's `type` line replaces with a value that is not a type identifier (`folder-documents/foreign-type-property`).

**Reason:** an app can set a `type` property that names a type, which no file can show, but a word the person writes on the line is their edit of it and wins.

**Tests:** `device/folders-frontmatter.test.ts › reports a type that declares a property no file can carry, and keeps it`, `device/folders-frontmatter.test.ts › replaces an app's type property with the word the person writes on the line`.

### `folder-documents/write-own-fields`

When a device renders a new Markdown file, a device MUST write `type` and `tier`, tags when present, and `state: archived` when the item is archived.

**Tests:** `device/folders-frontmatter.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-frontmatter.test.ts › keeps an archived item's file with its state in the frontmatter`.

### `folder-documents/own-field-order`

When a device renders a new Markdown file, a device MUST place own-field lines before the item properties, ordered `type`, `tier`, `tags`, `state`, and `occurred_at` for those present.

**Tests:** `device/folders-frontmatter.test.ts › keeps an archived item's file with its state in the frontmatter`, `device/folders-contract-a.test.ts › writes own fields in order before properties including an explicit time`.

### `folder-documents/current-replaces-properties`

When a file names the copy's current item version, a device MUST send its properties as a replacement, clearing properties whose lines were removed.

**Tests:** `device/folders-frontmatter.test.ts › clears a property whose line was taken out of a versioned file`.

### `folder-documents/current-after-own-write`

When a file's own edit lands before its version line is rewritten, a device MUST treat its next edit as current if the previously scanned content agrees with the item.

**Tests:** `device/folders-frontmatter.test.ts › sends a save right after its own edit lands as current`.

### `folder-documents/current-after-unshown-change`

When the copy moves to a version that changes nothing shown by the file and no file edit waits, a device MUST treat the file's next own-field edit as current.

**Tests:** `device/folders-frontmatter.test.ts › takes an own-field change after a version step no file shows`.

### `folder-documents/current-own-delta`

When a current file is saved, a device MUST send only own-field changes relative to the own-field lines it last wrote.

**Tests:** `device/folders-frontmatter.test.ts › takes an own-field change after a version step no file shows`, `device/folders-frontmatter.test.ts › sends nothing for a save that only reformats the frontmatter`.

### `folder-documents/missing-tags-clears`

When a current file loses a `tags` line previously written by the device at that version, a device MUST remove those tags from the item.

**Tests:** `device/folders-frontmatter.test.ts › takes a versioned file's missing tags line as no tags, and a lineless file's as no change`.

### `folder-documents/missing-state-active`

When a current file loses a `state: archived` line previously written by the device at that version, a device MUST restore the item to active.

**Tests:** `device/folders-frontmatter.test.ts › keeps an archived item's file with its state in the frontmatter`.

### `folder-documents/unwritten-own-fields`

When a file omits own-field lines the device never wrote into it, a device MUST leave those own fields unchanged.

**Tests:** `device/folders-frontmatter.test.ts › reads a file the folder never wrote own lines into as leaving them as they are`, `device/folders-frontmatter.test.ts › takes a versioned file's missing tags line as no tags, and a lineless file's as no change`.

### `folder-documents/behind-no-own-change`

When a file's version line is missing, ahead of the copy, or behind the copy for reasons other than its own accepted edit, a device MUST NOT send its own-field changes.

**Tests:** `device/folders-frontmatter.test.ts › sends no own-field change from an old buffer, and flags the lines it would have changed`, `device/folders-frontmatter.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folder-documents/behind-flags-lines`

When a file behind the copy differs in own-field lines, a device MUST flag it `behind` naming the lines it did not send.

**Tests:** `device/folders-frontmatter.test.ts › sends no own-field change from an old buffer, and flags the lines it would have changed`, `device/folders-frontmatter.test.ts › sends no time from a file behind the item, and flags the line`.

### `folder-documents/old-buffer-tags`

When an old buffer would reverse tags received from another device at the same item version, a device MUST NOT send that tag change.

**Tests:** `device/folders-frontmatter.test.ts › leaves a tag and an archive made elsewhere alone when an old buffer is saved`, `device/folders-frontmatter.test.ts › sends no tag change from an old buffer however many tag writes came at one version`.

### `folder-documents/old-buffer-state`

When an old buffer would reverse an archive or restore received from another device, a device MUST NOT send that state change.

**Tests:** `device/folders-frontmatter.test.ts › leaves a tag and an archive made elsewhere alone when an old buffer is saved`, `device/folders-frontmatter.test.ts › does not re-archive from a buffer written before a restore elsewhere`, `device/folders-frontmatter.test.ts › does not re-archive from the buffer of an archive restored elsewhere`.

### `folder-documents/own-tag-reversal`

When a person adds and then removes a tag through the same file at one item version, a device MUST send both changes.

**Tests:** `device/folders-frontmatter.test.ts › sends a tag the person adds and then takes out again at one version`.

### `folder-documents/successive-saves`

When several property saves of one file are scanned before a drain, a device MUST preserve their order so the last save determines the resulting properties.

**Tests:** `device/folders-frontmatter.test.ts › keeps every save of three scanned before one drain`.

### `folder-documents/presentation-no-write`

When a save changes only accepted presentation of a document's values, a device MUST NOT queue an item edit.

**Tests:** `device/folders-frontmatter.test.ts › sends nothing for a save that only reformats the frontmatter`, `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`.

### `folder-documents/version-spelling`

When a document version line is a quoted integer or decimal spelling of a positive integer, a device MUST interpret it as that version.

**Tests:** `device/folders-frontmatter.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folder-documents/time-normalization`

When a document names `occurred_at`, a device MUST read a date alone as its midnight in UTC and any other value as an RFC 3339 date-time (`items/occurred-at-form`).

**Tests:** `device/folders-frontmatter.test.ts › sets a new item's own time, from a date or from a date and time`, `cli/folder.test.ts › sets an item's own time from a file's occurred_at line, and writes it back as typed`.

### `folder-documents/time-equivalent-no-write`

When a save only changes the spelling of an equivalent `occurred_at`, a device MUST NOT send an item edit for it.

**Tests:** `device/folders-frontmatter.test.ts › sends an edit of the line, and nothing for another spelling of the same time`, `device/folders-frontmatter.test.ts › follows a time changed elsewhere, and keeps a line in another spelling of the same time`.

### `folder-documents/time-current-edit`

When a current file changes its `occurred_at` value, a device MUST send the changed item time outside `properties`.

**Tests:** `device/folders-frontmatter.test.ts › sends an edit of the line, and nothing for another spelling of the same time`.

### `folder-documents/time-omitted-keeps`

When a file omits its `occurred_at` line, a device MUST leave the item's time unchanged.

**Tests:** `device/folders-frontmatter.test.ts › sends an edit of the line, and nothing for another spelling of the same time`.

### `folder-documents/time-null-empty`

When a file has a null `occurred_at` line, a device MUST treat it as no requested time.

**Tests:** `device/folders-frontmatter.test.ts › takes a blank line as no time, and leaves it blank`.

### `folder-documents/time-null-preserved`

When an item has no explicit time to render over a null `occurred_at` line, a device MUST preserve the blank line.

**Tests:** `device/folders-frontmatter.test.ts › takes a blank line as no time, and leaves it blank`.

### `folder-documents/time-render`

When an item's time differs from its creation time or a file already carries a non-null `occurred_at` value, a device MUST render the item's time in that line.

**Tests:** `device/folders-frontmatter.test.ts › writes the line for an item whose time is its own, and none for one never set`, `device/folders-frontmatter.test.ts › follows a time changed elsewhere, and keeps a line in another spelling of the same time`.

### `folder-documents/time-invalid`

If a non-null `occurred_at` value in a document not bound to a file item is not text or cannot be read as a valid time, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders-frontmatter.test.ts › flags a line that is no time, and sends nothing for the file`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folder-documents/own-field-validation`

If the frontmatter of a document not bound to a file item names a tier other than feed or library, a non-null state other than active or archived, or a malformed tag value, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders-frontmatter.test.ts › reads own-field lines in each form a file can hold them`, `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`.

### `folder-documents/tag-state-forms`

When a document uses comma-separated text or null for tags, or null for state, a device MUST interpret them respectively as the named tags, no tags, or active.

**Tests:** `device/folders-frontmatter.test.ts › reads own-field lines in each form a file can hold them`.

### `folder-documents/preserve-source`

When a pull changes a document, a device MUST preserve unchanged frontmatter source, including order, comments, quoting, number spelling, collections, scalars, Unicode, and line endings.

**Tests:** `device/folders.test.ts › writes a person's frontmatter back in the order they wrote it`, `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`, `cli/folder.test.ts › keeps authored YAML bytes while first push adds metadata and a remote edit changes one value`.

### `folder-documents/preserve-change-in-place`

When a pull changes document properties, a device MUST edit changed values in place, remove uncarried non-null values, and append missing fields.

**Tests:** `device/folders.test.ts › preserves frontmatter bytes through metadata, remote edits and presentation-only saves`, `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folder-documents/preserve-null-property`

When an existing document carries a null property line spelled as `key:`, `key: null`, or `key: ~`, and the item carries no value for that property, a device MUST preserve that line's bytes, including whitespace and comments.

**Tests:** `device/folders-frontmatter.test.ts › keeps empty property lines through pushes, pulls and later clears`.

### `folder-documents/preserve-null-property-scope`

When a property has no line in an existing document and no value on the item, a device MUST NOT add a null line for it.

**Tests:** `device/folders-frontmatter.test.ts › keeps empty property lines through pushes, pulls and later clears`.

### `folder-documents/preserve-children`

When a pull changes a mapping or sequence, a device MUST preserve unchanged child source, including children moved within a sequence.

**Tests:** `cli/folder.test.ts › keeps authored YAML bytes while first push adds metadata and a remote edit changes one value`.

### `folder-documents/preserve-safe-render`

If frontmatter cannot be rendered with the intended values, then a device MUST leave the file unchanged.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folder-documents/preserve-leading-space`

When a pull removes the first frontmatter property, a device MUST remove newly leading blank lines that would prevent the opening fence being recognized as frontmatter.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folder-documents/preserve-sequence-indent`

When a pull replaces an unindented block sequence with a scalar or flow collection, a device MUST indent the replacement under its key.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folder-documents/own-fields-appended`

When an existing document lacks required own-field lines, a device MUST append those lines without moving the document's existing fields.

**Tests:** `device/folders-contract-a.test.ts › expands affected aliases and preserves untouched anchors when removal is %s`.

### `folder-documents/behind-fields-restored`

When a behind file carries old own-field values, a device MUST write the item's current own-field values during the next pull.

**Tests:** `device/folders-contract-a.test.ts › writes current own fields over a behind file without sending the old fields`.

### `folder-documents/old-tag-version-advance`

When an item advances to another version after a tag change was flagged as indistinguishable from an old buffer, a device MUST accept an explicit tag edit from the newly rendered current file.

**Tests:** `device/folders-contract-a.test.ts › allows a previously ambiguous tag change after the item version advances`.

### `folder-documents/successive-state-saves`

When several state changes are scanned from one file version before a drain, a device MUST queue them in save order.

**Tests:** `device/folders-contract-a.test.ts › queues successive state changes from one version in save order`.

### `folder-documents/preserve-moved-alias`

When a pull moves an alias before its anchor, a device MUST expand the alias as needed to retain its intended value.

**Tests:** `device/folders-contract-a.test.ts › expands an alias moved before its anchor while preserving other anchor groups`.

### `folder-documents/preserve-alias-values`

When a pull changes or removes a YAML anchor, a device MUST expand affected aliases as needed to preserve their intended values.

**Tests:** `device/folders-contract-a.test.ts › expands affected aliases and preserves untouched anchors when removal is %s`.

### `folder-documents/preserve-unaffected-anchors`

When a pull changes one YAML anchor group, a device MUST preserve untouched anchor groups as written.

**Tests:** `device/folders-contract-a.test.ts › expands affected aliases and preserves untouched anchors when removal is %s`.

### `folder-documents/old-state-version-advance`

When an item advances to another version after a state change was flagged as indistinguishable from an old buffer, a device MUST accept an explicit state edit from the newly rendered current file.

**Tests:** `device/folders-contract-a.test.ts › allows a previously ambiguous state change after the item version advances`.

### `folder-documents/body-property-line-no-flag`

When a document names its current body property in frontmatter as well as having body text, a device MUST use the body text without flagging that duplicate representation.

**Tests:** `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

## Defaults for a new document

### `folder-documents/default-document-type`

When a new document has no `type` line, or one holding no type identifier (`folder-documents/foreign-type-property`), a device MUST choose its type from the defaults, then the query's first non-file type, then `core.note`.

**Tests:** `device/folders.test.ts › makes a new document the query's first type that is not a file type`, `device/folders-frontmatter.test.ts › makes the note the folder's default type and keeps the line's value as a property`, `device/folders.test.ts › takes every type, and any default type, where its query names no type or the star`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folder-documents/default-document-tier`

When a new document has no `tier` line, a device MUST use the defaults' tier or, if absent, the query's tier, using `library` when the query's tier is `all` or absent.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`, `device/folders-query.test.ts › uses defaults tier or library for new documents and file items with query tier all (%s)`.

### `folder-documents/default-properties`

When a new document omits a property named by the defaults, a device MUST fill that property from the defaults except for the body property.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folder-documents/default-tags`

When a new document omits its `tags` line, a device MUST use the default tags.

**Tests:** `device/folders-frontmatter.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folder-documents/default-explicit-tags`

When a new document names tags explicitly, including an empty list, a device MUST use those tags instead of default tags.

**Tests:** `device/folders-frontmatter.test.ts › reads type, tags, tier and state as the item's own`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folder-documents/default-body`

When a new document is created, a device MUST use its body for the type's body property instead of a default body.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folder-documents/default-title`

When a new document omits its title property, a device MUST prefer a default title over the filename.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`, `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folder-documents/default-explicit-title`

When a new document names its title property, a device MUST use that value instead of a default title.

**Tests:** `device/folders-contract-a.test.ts › uses core.note without a type default and preserves explicit empty tags and titles`.

### `folder-documents/default-edges`

When a new document or file item has no line for an edge type named by the defaults, a device MUST create the default edge from the new item to the named item, except `parent-of`, which runs from the named item to the new item.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folder-documents/default-edge-refused-held`

If the device or the server refuses an edge that the defaults ask for on a new document or file item, then a device MUST flag that file `default_edge_refused`, in the folder's status and in the scan that refused the edge, with a reason that names the edge type, the other item and the way out: writing that line in a document's file, or, for a file item, making the edge in an app or taking it out of the folder's defaults.

**Reason:** the flag is not `refused`, which is a change the person made that was refused and leaves the file held. A default edge is written in no line of the file, so without a record against the file the refusal appears only in the report of the scan that made it, and the file reads as in step. A file item has no lines to write, so the way out the reason names is the one its file can take. The refusal holds no other file, and a pull still writes the item's changes into the file, since nothing the person wrote in the file was refused.

**Tests:** `device/folders-default-refused.test.ts › shows a default the copy refused for a document and a file, and makes it once the edge type admits it, the files unchanged`, `device/folders-default-refused.test.ts › keeps a default the server refused, sends it again only after the file changes, and applies it once it is accepted`.

### `folder-documents/default-edge-refused-told-sent`

When the CLI answers `folders scan` or `folders push` in plain text for a pass that refused a folder default edge, the CLI MUST say of each file flagged `default_edge_refused` that the file is sent and that the folder's default edge was not applied, counting it apart from the files held or not sent.

**Reason:** the file is in step and nothing the person wrote in it was refused, so the line for a held file would tell a person that work is unsent when it is not.

**Tests:** `device/folders-default-refused.test.ts › tells a person in the plain text of the push that made it that a file with a refused default is sent`.

### `folder-documents/default-edge-retried`

While a file holds a default edge that the device refused and the defaults still name it, a device MUST judge the edge again at each scan and, where the device would now take it, queue the edge and clear the refusal.

**Reason:** what the device refused the edge for, such as the edge type's endpoint constraints or the state of the other item, can change on another machine while the file stays as it was.

**Tests:** `device/folders-default-refused.test.ts › shows a default the copy refused for a document and a file, and makes it once the edge type admits it, the files unchanged`.

### `folder-documents/default-edge-server-kept`

While a file holds a default edge that the server refused, a device MUST NOT send that edge again before a later save of the file.

**Reason:** the server's answer to the same write does not change by itself, so asking at each scan would repeat a refusal without end. A later save sends it once more, and a new refusal is held the same way.

**Tests:** `device/folders-default-refused.test.ts › keeps a default the server refused, sends it again only after the file changes, and applies it once it is accepted`.

### `folder-documents/default-edge-cleared`

When a default edge's write is accepted, a document's file writes a line of the edge's type, the defaults stop naming the edge, the device holds the edge, or the file's item is gone or in the bin, a device MUST clear the file's refusal of that default edge.

**Reason:** a file item has no lines, so only a document's file clears a refusal by writing one. An edge the person made in an app and the device pulled is the edge the default asked for: sending it again would draw a refusal as a duplicate and show the file refused for an edge it has.

**Tests:** `device/folders-default-refused.test.ts › shows a default the copy refused for a document and a file, and makes it once the edge type admits it, the files unchanged`, `device/folders-default-refused.test.ts › keeps a default the server refused, sends it again only after the file changes, and applies it once it is accepted`, `device/folders-default-refused.test.ts › clears when the person writes the line, and when the defaults stop naming the edge`, `device/folders-default-refused.test.ts › clears a default the person made as an edge themselves, for a document and a file`, `device/folders-default-refused.test.ts › clears when the file's item is in the bin`.

### `folder-documents/default-edit-unchanged`

When a bound file is edited, a device MUST NOT fill its omitted values from the folder defaults.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`.

### `folder-documents/default-search-refusal`

If the defaults name a type or tier the folder query excludes, then a device MUST refuse to follow those defaults.

**Tests:** `device/folders.test.ts › refuses defaults its query would not hold`.

## Defaults for a new file item

### `folder-documents/default-file-properties`

When a new file item is created from file bytes, a device MUST omit the folder defaults' document properties.

**Tests:** `device/folders-contract-a.test.ts › applies default properties to documents but not file items`.

### `folder-documents/default-file-tags`

When a new file item is created from file bytes, a device MUST apply the folder's default tags.

**Tests:** `device/folders-contract-a.test.ts › applies default properties to documents but not file items`.

### `folder-documents/default-file-tier`

When a device creates a new file item, a device MUST use the folder defaults' tier or, if absent, the query's tier, using `library` when the query's tier is `all` or absent.

**Tests:** `device/folders.test.ts › fills a new file's blanks from its defaults, never an edit's`, `device/folders-query.test.ts › uses defaults tier or library for new documents and file items with query tier all (%s)`.

## Document recognition and refusals

### `folder-documents/frontmatter-fences`

When a Markdown file opens with an incomplete fence, a fence followed by a blank line, or a fence pair holding a list or text, a device MUST read that text as body.

**Tests:** `device/folders.test.ts › treats a body opening with a horizontal rule as a body`, `device/folders.test.ts › treats a fence pair holding a list or one line as a body`, `device/folders-contract-a.test.ts › reads incomplete fences as body and an empty fence pair as empty frontmatter`.

### `folder-documents/frontmatter-empty`

When a Markdown file opens with an empty fence pair, a device MUST read it as empty frontmatter.

**Tests:** `device/folders-contract-a.test.ts › reads incomplete fences as body and an empty fence pair as empty frontmatter`.

### `folder-documents/bom-read`

When a UTF-8 document opens with a byte-order mark, a device MUST read past the mark.

**Tests:** `device/folders.test.ts › reads past a byte-order mark and writes the file back without it`.

### `folder-documents/bom-write`

When a device rewrites a Markdown document that opened with a byte-order mark, a device MUST omit the mark.

**Tests:** `device/folders.test.ts › reads past a byte-order mark and writes the file back without it`.

### `folder-documents/retype-current`

When a current document changes its `type` line to another document type, a device MUST send the item edit with the new type and `retype: true`.

**Tests:** `device/folders-frontmatter.test.ts › retypes an item whose frontmatter changes its type`, `device/folders-frontmatter.test.ts › retypes the item when the line comes to name a type, and drops the property`.

### `folder-documents/retype-new-body`

When retyping a document changes its body property, a device MUST use a nonempty frontmatter value for the new body property, or the document body if none is provided.

**Tests:** `device/folders-frontmatter.test.ts › keeps both body fields' text when a retype moves the body to another`.

### `folder-documents/retype-old-body`

When retyping a document changes its body property, a device MUST preserve the old body property's text.

**Tests:** `device/folders-frontmatter.test.ts › keeps both body fields' text when a retype moves the body to another`.

### `folder-documents/retype-unsuited`

If a document's `type` line holds a type identifier the copy does not hold, a `system.*` type or a file type, then a device MUST refuse its creation or retype locally.

**Reason:** an identifier is a type someone meant, such as a mistyped `core.notes`, so making the document another type would hide the mistake.

**Tests:** `device/folders-frontmatter.test.ts › refuses a type no document can be, before sending anything`, `device/folders-frontmatter.test.ts › reads every value the grammar refuses as a property, and still refuses a type the copy does not hold`.

### `folder-documents/foreign-type-property`

When a document's `type` line holds a value that is not a type identifier (`types/id-grammar`), a device MUST carry that value as the item property `type` and leave the item's type unchanged.

**Reason:** other note apps write their own words in a `type` line, such as `type: reference`. No such value can ever name a Marfa type, so holding the file would hold every note those apps made, and dropping the value would lose what the person wrote. The value replaces a `type` property an app set (`folder-documents/uncarried-preserve`).

**Tests:** `device/folders-frontmatter.test.ts › makes the note the folder's default type and keeps the line's value as a property`, `› changes only the property when the line comes to hold another word`, `› replaces an app's type property with the word the person writes on the line`, `› clears the property and keeps the type when the line is taken out`, `› reads every value the grammar refuses as a property, and still refuses a type the copy does not hold`.

### `folder-documents/foreign-type-write`

When a device writes a document whose item carries a `type` property that is not a type identifier (`types/id-grammar`), a device MUST write that property's value as the `type` line in place of the item's type.

**Reason:** the file reads back as the person wrote it on every machine, and the next scan finds no edit in it.

**Tests:** `device/folders-frontmatter.test.ts › makes the note the folder's default type and keeps the line's value as a property`, `› sends nothing on the scan after the file is written back`, `› writes the same file on a second machine`, `› reads every value the grammar refuses as a property, and still refuses a type the copy does not hold`.

### `folder-documents/foreign-type-empty`

When a device writes a document whose `type` line is empty and whose item carries no `type` property, a device MUST keep the line empty.

**Reason:** a save that replaces every property drops a null one (`items/update-null-replace`), so the empty line can have nothing on the item to be written back from, and filling it in would change a file the person did not edit.

**Tests:** `device/folders-frontmatter.test.ts › reads every value the grammar refuses as a property, and still refuses a type the copy does not hold`.

### `folder-documents/refused-edit-kept`

When the server refuses a document edit, tag change, or state change, a device MUST preserve the person's file.

**Tests:** `device/folders-frontmatter.test.ts › flags a refused retype and keeps the file`.

### `folder-documents/refused-edit-report`

When a document write is refused, a device MUST flag the held file `refused` with the server's code and message.

**Tests:** `device/folders-frontmatter.test.ts › flags a refused retype and keeps the file`.

### `folder-documents/refused-edit-follow`

When a held file is renamed, reformatted, or changed without replacing its refused change, a device MUST retain the refusal on that file.

**Tests:** `device/folders-frontmatter.test.ts › through a rename before the drain`, `device/folders-frontmatter.test.ts › through a rename after the refusal`, `device/folders-frontmatter.test.ts › through a save that only reformats it before the drain`, `device/folders-frontmatter.test.ts › through a later save that only adds a tag`, `device/folders-frontmatter.test.ts › through a later save that only edits the body, where a tag was refused`.

### `folder-documents/refused-edit-no-repeat`

While a refused document remains unchanged, a device MUST NOT send the same change again.

**Tests:** `device/folders-frontmatter.test.ts › flags a refused retype and keeps the file`.

### `folder-documents/refused-edit-replaced`

When a later save lands an edit replacing a refused edit, a device MUST release the file's refusal hold.

**Tests:** `device/folders-frontmatter.test.ts › lets a file go once a later save lands after a refused one`.

### `folder-documents/refused-tag-mended`

When a file stops carrying a refused tag and its replacement tag lands, a device MUST clear the refused-tag hold.

**Tests:** `device/folders-frontmatter.test.ts › sends a mended tag from a file whose edit landed beside the refused one`.

### `folder-documents/refused-edit-version`

When a document edit is refused, a device MUST base the next edit on the file's version unless an earlier accepted edit already consumed that version.

**Tests:** `device/folders-placement.test.ts › sends a save after a refused edit as behind, keeping what another machine changed or added`, `device/folders-placement.test.ts › keeps the line a landed edit spent when a later edit from the same buffer is refused`.

### `folder-documents/refused-own-field-replaced`

When a later accepted change supersedes a refused change of the same tag or state, a device MUST release the file's refusal hold for that change.

**Tests:** `device/folders-contract-a.test.ts › releases a refused %s when a later change of it is accepted`.

### `folder-documents/document-name-refusal`

If a document contains a tag or property name the server refuses, or would exceed the item's tag limit, then a device MUST report the file's path and the refusal reason.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`, `device/folder-names.test.ts › queues nothing of an edit whose added tag is refused, and the edit once the tag is dropped`, `device/folder-names.test.ts › is flagged with its reason and queues nothing of it, while a swap on a full item and the files after it are saved`.

### `folder-documents/document-name-preserve`

If a document contains a tag or property name the server refuses, or would exceed the item's tag limit, then a device MUST preserve the file's bytes.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`.

### `folder-documents/document-name-no-writes`

If a document contains a tag or property name the server refuses, or would exceed the item's tag limit, then a device MUST NOT queue any write from that file.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`, `device/folder-names.test.ts › queues nothing of an edit whose added tag is refused, and the edit once the tag is dropped`, `device/folder-names.test.ts › is flagged with its reason and queues nothing of it, while a swap on a full item and the files after it are saved`.

### `folder-documents/document-name-continue`

When a scan refuses a document's tag or property name or tag count, a device MUST continue scanning the other files.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`, `device/folder-names.test.ts › is flagged with its reason and queues nothing of it, while a swap on a full item and the files after it are saved`.

### `folder-documents/document-name-retry`

When a document's refused tag or property name or tag count is corrected, a device MUST accept the corrected file at the next scan.

**Tests:** `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`, `device/folder-names.test.ts › queues nothing of an edit whose added tag is refused, and the edit once the tag is dropped`.

## Unreadable documents

### `folder-documents/unreadable-yaml`

If the Markdown frontmatter of a document not bound to a file item is malformed, has a non-text key, duplicates a key, or uses a YAML merge key, then a device MUST flag the file `unreadable`.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folder-documents/unreadable-no-write`

While a document is unreadable, a device MUST NOT send an item create or edit for it.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`, `device/folders-contract-a.test.ts › holds duplicate YAML keys and empty or out-of-range dates while admitting a valid date`.

### `folder-documents/unreadable-preserve`

While a bound document is unreadable, a device MUST preserve its bytes during pull.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`.

### `folder-documents/unreadable-report`

While a bound document is unreadable, a device MUST report its path and reason in the pull's `flagged` entries.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`.

### `folder-documents/unreadable-rename`

When an unreadable document moves and its identity or readable `marfa_id` establishes the same item, a device MUST retain that item binding.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`, `device/folders-frontmatter.test.ts › keeps an unreadable file's item when it moves with no identity`.

### `folder-documents/unreadable-repaired`

When an unreadable document is repaired, a device MUST process its edit normally.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose frontmatter does not parse`.

### `folder-documents/encoding-flag`

If a document not bound to a file item is not UTF-8 text or contains a NUL byte, then a device MUST flag it `encoding` with the reason.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folder-documents/encoding-no-send`

While a document is held for encoding, a device MUST NOT send its content.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folder-documents/encoding-preserve`

While a document is held for encoding, a device MUST preserve its bytes during pull.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folder-documents/encoding-status`

While a document is held for encoding, the CLI MUST list it as `held` in `folders status`.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folder-documents/encoding-repaired`

When a document is saved as UTF-8 without NUL bytes, a device MUST admit its content.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folder-documents/file-bytes-not-document`

When a non-document file contains bytes that are not valid UTF-8 or include NUL, a device MUST admit those bytes as a file item rather than apply document encoding restrictions.

**Tests:** `device/folders-contract-a.test.ts › applies default properties to documents but not file items`.

### `folder-documents/file-item-doc-name-sent`

When the bytes of a non-empty file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) change and the file is bound to a file item, a device MUST send those bytes as the file item's content whatever they hold.

**Reason:** the item's kind, not the file's name, says how its bytes are read, and a pull can place a file item at a document name. Frontmatter that does not parse and bytes that are not UTF-8 are then the file item's own content.

**Tests:** `device/folders-placement.test.ts › sends a file item pulled to a document name as its bytes, whatever they hold, named %s`.

### `folder-documents/file-item-doc-name-unflagged`

When a scan finds a file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) bound to a file item, a device MUST NOT flag the file `unreadable` or `encoding`.

**Reason:** a flag holds a document whose text the device cannot read, and a file item's bytes are not read as text. A document not bound to a file item, a new file included, is still held by `folder-documents/unreadable-yaml` and `folder-documents/encoding-flag`.

**Tests:** `device/folders-placement.test.ts › sends a file item pulled to a document name as its bytes, whatever they hold, named %s`.

### `folder-documents/file-item-doc-name-emptied`

When a file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) bound to a file item is empty, a device MUST leave the item's bytes as they were until the file holds bytes.

**Reason:** the server holds no empty blob, and an editor empties a file before it writes it.

**Tests:** `device/folders-placement.test.ts › waits for a file item emptied at a document name, and still sends the rest, named %s`.

### `folder-documents/file-item-doc-name-emptied-scan`

When a file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) bound to a file item is empty, a device MUST send the other files of the same scan.

**Reason:** one file waiting for its bytes fails no pass. An emptied document is still sent as an empty document.

**Tests:** `device/folders-placement.test.ts › waits for a file item emptied at a document name, and still sends the rest, named %s`.

### `folder-documents/file-item-doc-name-moved-out`

When a file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) that is the file of a file item is renamed to a name of no type the folder's query holds, a device MUST keep the file item bound to the file at its new name.

**Reason:** a file item's file is followed whatever the query says, and its kind comes from its item, not from the name it had.

**Tests:** `device/folders-placement.test.ts › follows a file item moved %s to a name its query holds no type for`.

### `folder-documents/file-item-doc-name-replaced`

When a file that names a note's item ID replaces the file of a file item at a Markdown name (`.md` or `.markdown`, in any letter case) and no other file in the folder is that note's, a device MUST keep the file bound to that note.

**Reason:** the file's item ID, not the file it replaced, says whose file it is, in a plain scan and in a folder watch's pass alike. A device that judged the file by the item bound at its path would send the note as the file item's bytes and lose the note. While the note's own file is still in the folder, the new file is a copy of it and stays the file item's. A `.txt` file carries no ID line (`folder-files/raw-text-body`), so it never names a note and stays the file item's.

**Tests:** `device/folders-placement.test.ts › keeps a note whose file replaces a file item's at a document name, named %s`.

## Document versions

### `folder-documents/version-line`

When a pull writes a Markdown file, a device MUST write `marfa_version` naming the item version rendered.

**Tests:** `device/folders-placement.test.ts › bases a stale file's edit on the version written in it`.

### `folder-documents/version-stale-merge`

When a file names an older version not consumed by its accepted edits, a device MUST send the property edit as a merge based on that version, including a version the copy never held.

**Tests:** `device/folders-placement.test.ts › bases a stale file's edit on the version written in it`, `device/folders-placement.test.ts › merges a file whose line names a version the copy skipped against that line`, `device/folders-placement.test.ts › merges a file behind the copy, clearing nothing its lines left out`.

### `folder-documents/version-absent-merge`

When a document edit has no usable version line, a device MUST send its properties as a merge rather than a replacement.

**Tests:** `device/folders-frontmatter.test.ts › merges an edit from a file with no version line`, `device/folders-frontmatter.test.ts › reads a quoted version line as the version, and a removed one as no version`.

### `folder-documents/version-consumed`

When an earlier accepted edit consumed a file's version line, a device MUST base the next edit from that line on the copy's current version.

**Tests:** `device/folders-placement.test.ts › bases a stale file's edit on the version written in it`, `device/folders-placement.test.ts › keeps a line an edit spent spent after the pull rewrites it`.

### `folder-documents/version-rewrite-waiting`

When a pull rewrites a file over its waiting edit and that edit later lands, a device MUST treat the rewritten line as consumed by the accepted edit.

**Tests:** `device/folders-placement.test.ts › keeps the line a pull wrote over a waiting edit spent, once that edit lands`, `device/folders-placement.test.ts › keeps a line spent where a pull writes the file over the edit that spent it`.

### `folder-documents/version-rewrite-refused`

When a pull rewrites a file over a waiting edit that is then refused, a device MUST base the next edit from that rewritten file on its version line.

**Tests:** `device/folders-placement.test.ts › takes back the line a pull wrote over a waiting edit when that edit is refused`.

### `folder-documents/version-answered-unchanged`

When a pull writes a newer version line over a waiting edit that is then refused after an earlier edit was accepted or conflicted, a device MUST base the next edit from that newer buffer on its own version line.

**Tests:** `device/folders-placement.test.ts › lifts no answered edit's line when a pull writes over a waiting one, a conflicted edit's included`.

### `folder-documents/version-dead-unchanged`

When a pull writes a newer version line over a waiting edit that is then refused after an earlier edit died, a device MUST base the next edit from that newer buffer on its own version line.

**Tests:** `device/folders-placement.test.ts › lifts no dead edit's line when a pull writes over a later waiting one`.

### `folder-documents/version-external-write`

When a write queued outside the file lands after a pull rewrote the file over it, a device MUST base the next file edit on the copy's current version.

**Tests:** `device/folders-placement.test.ts › keeps the line a pull wrote over an edit queued outside the file spent, once that edit lands`.

### `folder-documents/version-dead-consumed`

When an edit dies after exhausting retries, a device MUST base another edit from that same buffer on the copy's current version.

**Tests:** `device/folders-placement.test.ts › keeps a dead edit's line spent, since the server may have taken it`.

### `folder-documents/version-dead-refused`

When a released dead edit is explicitly refused and no accepted edit has used its version line, a device MUST base the next edit from that buffer on the buffer's version line.

**Tests:** `device/folders-placement.test.ts › takes back a dead edit's line once, released, the server refuses it`.

### `folder-documents/version-only-save`

When a save changes only `marfa_version`, a device MUST NOT send an item edit.

**Tests:** `device/folders-placement.test.ts › sends nothing for a save that changes only the version line`.

### `folder-documents/version-ancestor-missing`

When the server no longer holds the file edit's ancestor version, a device MUST retry the edit as a property merge on the copy's current version.

**Tests:** `device/folders-placement.test.ts › sends over a thinned version as a merge, and says so`.

### `folder-documents/version-rebased-count`

When a folder edit is resent after its ancestor version is unavailable, a device MUST count that resend as `rebased`.

**Tests:** `device/folders-placement.test.ts › sends over a thinned version as a merge, and says so`.

### `folder-documents/version-rebased-words`

When a push or watch resends an edit because its ancestor version is unavailable, the CLI MUST say that it was resent on the version the copy holds.

**Tests:** `device/folders-placement.test.ts › says in words that an edit went over a thinned version`, `device/folders-placement.test.ts › says while watching that an edit went over a thinned version`.

### `folder-documents/version-rebase-limit`

When an edit resent after an unavailable ancestor is blocked for another unavailable ancestor, a device MUST leave it blocked until another pass.

**Tests:** `device/folders-placement.test.ts › stops at one resend where the server no longer holds the version the copy holds either`.

### `folder-documents/version-only-pull`

When a remote version change alters nothing rendered in the file, a device MUST leave the file's bytes unchanged.

**Tests:** `device/folders-placement.test.ts › does not rewrite a file for its version line alone`.

### `folder-documents/version-own-edit-landed`

When the file's own edit lands and the file remains unchanged since scan, a device MUST update its version line to the accepted version.

**Tests:** `device/folders-placement.test.ts › does not rewrite a file for its version line alone`, `device/folders-placement.test.ts › writes the line into a file saved without one, once its edit lands`.

### `folder-documents/version-own-edit-after-pull`

When a file's own edit lands after a pull wrote the file while it waited, a device MUST update the version line again to the accepted version.

**Tests:** `device/folders-placement.test.ts › rewrites the line once its own edit lands, where a pull wrote the file while that edit waited`.

### `folder-documents/version-unknown-base`

When a document has no version line or names a version ahead of the working copy, a device MUST base its property merge on the copy's current item version.

**Tests:** `device/folders-contract-a.test.ts › merges on the copy version when the file version line is %s`.

### `folder-documents/version-not-property`

When a device sends a document edit, a device MUST omit `marfa_version` from item properties.

**Tests:** `device/folders-contract-a.test.ts › merges on the copy version when the file version line is %s`.

## A document's name and its title

A Markdown document's file name and its item's title name one note. A file item keeps its title as `folder-files/binary-title-preserved` says.

### `folder-documents/title-in-step`

When a device compares a Markdown document's file name with a title, a device MUST count them in step only where the title is not blank and the name, compared as `folder-documents/name-comparison` says, is the one the device makes from the title with the file's extension, or that name numbered as `folder-files/placement-collision-number` numbers it.

**Reason:** a title that cannot be a file name as written, such as one holding `/` or `:`, is in step with the name made from it, so renaming the file to that name changes nothing, and a name in another Unicode form, as macOS can give, never reads as a change.

**Tests:** `device/folders-placement.test.ts › counts a name in another case, Unicode form or cleaned spelling as the title's`, `› sends no title for a rename to a name the title already makes, and the new name's for any other`, `› numbers the name a new title makes where another file has it`.

### `folder-documents/rename-title`

When a person renames a Markdown document's file to a name not in step with the document's title, as its title line shows it or else as its item holds it, a device MUST send the new name without its extension as the item's title.

**Reason:** links resolve by a title or by a file name (`folder-documents/edge-filename-read`, `folder-documents/edge-lookup-title-field`), so a note whose name and title differ answers to two names.

**Tests:** `device/folders-placement.test.ts › sends a renamed note's new name as its title, and rewrites only its title line`, `› sends a rename and an edit of the body made in one pass together`, `› sends a renamed note's title alone where its file shows no title line`, `› sends no title for a rename to a name the title already makes, and the new name's for any other`, `› sends a title typed in the line, then the new name's, when a rename and a line edit come in one pass`.

### `folder-documents/rename-typed-title-first`

When a person renames a Markdown document's file and, in the same save, changes its title line from the title the file last showed to another nonblank title not in step with the new name, a device MUST send the line's title before the new name's title.

**Reason:** both titles are the person's, so the item's history holds each, and the name's, the later, is the one the item keeps.

**Tests:** `device/folders-placement.test.ts › sends a title typed in the line, then the new name's, when a rename and a line edit come in one pass`.

### `folder-documents/rename-title-line`

When a device sends a renamed Markdown document's new name as its title outside a send-only run and the file, still holding the bytes the device read, has a title line, a device MUST rewrite that line to the new title and keep every other byte of the file.

**Tests:** `device/folders-placement.test.ts › sends a renamed note's new name as its title, and rewrites only its title line`.

### `folder-documents/rename-title-wins`

When a person renames a Markdown document's file after its item's title changed elsewhere and before the device next syncs the folder, a device MUST send the new name as the item's title on the version the file last showed.

**Reason:** the rename is the later write. The server settles the two titles by the title property's merge policy (`types/merge-policy`, `versions/auto-resolved`), so where that is last-writer-wins, as it is for every type Marfa ships, the item takes the file's name, and the title it had stays in its history.

**Tests:** `device/folders-placement.test.ts › keeps a person's rename over a title changed in Marfa before it synced, heard of first: %s`, `› sends a renamed note's title alone on the version its file last showed`.

### `folder-documents/title-renames-file`

When a pull finds that a bound Markdown document's item title changed to a nonblank title its file name is not in step with, and the name was in step with the title the file last showed or that title was blank, a device MUST rename the file within its directory to the name the device makes from the new title.

**Tests:** `device/folders-placement.test.ts › renames a note's file when its title changes in Marfa`, `› keeps the name when the title is made blank, and takes the next title's`.

### `folder-documents/title-line-renames`

When the server takes a title a person typed in a bound Markdown document's title line, where the file's name is not in step with that title and was in step with the title the line showed before or that title was blank, a device MUST rename the file within its directory to the name the device makes from the new title.

**Reason:** another Mac hears of the edit as a title changed in Marfa and renames its file (`folder-documents/title-renames-file`), so the Mac where the edit was made renames its own.

**Tests:** `device/folders-placement.test.ts › renames a note's file when its title line is changed in the file`.

### `folder-documents/title-line-refused-kept`

If the server refuses the edit that carries a title typed in a document's title line, then a device MUST NOT move the item's placement or the file for that title.

**Reason:** a placement moved for a title the item never took would leave every Mac's file named after a title the item does not have.

**Tests:** `device/folders-placement.test.ts › keeps a note's name and placement when the server refuses its edited title line`.

### `folder-documents/title-rename-answered`

While a document's item has a write this copy has not had answered, a device MUST NOT rename its file to follow its item's title.

**Reason:** the title the copy shows until then is one the server may still refuse.

**Tests:** `device/folders-placement.test.ts › renames a note's file when its title line is changed in the file`.

### `folder-documents/title-rename-placement`

When a device renames a file to follow its item's title, a device MUST move the item's placement to the new path.

**Tests:** `device/folders-placement.test.ts › renames a note's file when its title changes in Marfa`, `› renames a note's file when its title line is changed in the file`.

### `folder-documents/title-rename-refused-placement`

If the rename that follows an item's title is refused, then a device MUST leave the item's placement at the path its file keeps.

**Tests:** `device/folders-placement.test.ts › keeps the placement at the old name when the rename for a new title is refused`.

### `folder-documents/title-rename-refused-once`

When the file system refuses the rename that follows an item's title, a device MUST NOT try that rename again while the folder stays open and the item's title and placement are unchanged.

**Reason:** a volume that refuses such renames refuses them every time, and each try moves the placement and back, which a watch would repeat at every pass.

**Tests:** `device/folders-placement.test.ts › asks a volume that refused the rename for a new title once, not at every pass of a watch`.

### `folder-documents/title-rename-numbered`

When the name the device makes from a document's new title is taken by another file or by another item's placement, a device MUST rename the file to the first free name numbered as `folder-files/placement-collision-number` numbers it.

**Tests:** `device/folders-placement.test.ts › numbers the name a new title makes where another file has it`.

### `folder-documents/title-rename-outside`

If the name the device makes from a document's new title is a path the folder does not write at, then a device MUST NOT rename the file.

**Reason:** the file goes on being written under the name it has, rather than left unwritten at a path the folder's lists leave out.

**Tests:** `device/folders-placement.test.ts › keeps the name of a note whose new title names a path the folder leaves out`.

### `folder-documents/title-blank-keeps-name`

When a Markdown document's item title changes to a blank title, a device MUST NOT rename its file.

**Tests:** `device/folders-placement.test.ts › keeps the name when the title is made blank, and takes the next title's`.

### `folder-documents/title-drift-kept`

If a bound Markdown document's file name is not in step with the nonblank title the file last showed, then a device MUST NOT rename the file when its item's title changes.

**Reason:** a name that already differs from the title is one the device cannot tell from a choice, so only a rename by the person, which sets the title (`folder-documents/rename-title`), brings the two back in step.

**Tests:** `device/folders-placement.test.ts › keeps the name of a note whose name was not its title`.

### `folder-documents/title-held-not-renamed`

While a device holds a bound document's change unsent, a device MUST NOT rename its file to follow its item's title.

**Tests:** `device/folders-placement.test.ts › keeps the name of a file it holds for a refused change, and renames it once the change is taken`.

### `folder-documents/move-by-rename`

When a pull moves a bound file whose bytes are still the ones it is bound to, a device MUST move it with a rename that replaces nothing, and its item's placement with it, before writing new bytes over it.

**Reason:** an editor holding the file follows a rename, where it would lose a file written anew and deleted at its old path.

**Tests:** `device/folders-placement.test.ts › moves a note's file by a rename when its title changes, so an editor holding it follows`, `› moves a file by a rename when another Mac moves its placement`.

### `folder-documents/moved-save-taken`

When a file appears at the path a pull last moved an item's file away from, carrying that item's ID and a version line no newer than the item's version when the pull moved it, while the item's file holds no change the device has not read and is neither held nor refused, and the run is not a send-only run, a device MUST put the file in the item's file's place, replacing nothing, and send it as a save of an old copy of that file.

**Reason:** it is an editor's save of the buffer it held before the move, and as a new item it would be a second note holding the person's edit.

**Tests:** `device/folders-placement.test.ts › takes an old buffer saved where another Mac moved the file from as a save of its note, never a new item`, `device/folders-placement.test.ts › takes an old buffer saved at the name a retitle moved its file from as a stale save of its note`, `device/folders-placement.test.ts › leaves an old buffer saved where another Mac moved the file from where it is in a send-only run, and takes it in the push after`.

### `folder-documents/moved-save-held`

When a file appears at the path a pull last moved an item's file away from, carrying that item's ID and a version line no newer than the item's version when the pull moved it, while the item's file holds a change the device has not read, or one it holds unsent or refused, a device MUST hold the file, flagged `waiting`, without making an item of it, until the person changes or removes that file.

**Reason:** the person decides which of the two to keep, however the item's file changes meanwhile.

**Tests:** `device/folders-placement.test.ts › holds an old buffer saved at the old name while the moved file holds an edit of its own, and makes no new item`, `› holds an old buffer saved at the old name while the moved file holds a refused edit, and keeps that edit`, `› holds an old buffer until the person changes that file, whatever the moved file does`, `› holds an old buffer through a send-only run while the moved file holds an edit of its own, and makes no new item in the push after`.

### `folder-documents/moved-save-race`

If an item's file is saved while a device puts an old buffer in its place, then a device MUST keep that save in the item's file and hold the old buffer, flagged `waiting`.

**Tests:** `device/folders-placement.test.ts › keeps a save made to the moved file while an old buffer is taken over it`.

### `folder-documents/moved-save-kept-beside`

If another file takes an item's file's path while a device puts an old buffer in its place, and the item's file was saved meanwhile, then a device MUST move that save to the first free numbered name beside the path, as `folder-files/placement-collision-number` numbers it.

**Reason:** the save is the person's, and a name the folder treats as its own scratch would lose it.

**Tests:** `device/folders-placement.test.ts › keeps a save made to the moved file under a numbered name where another file took its path meanwhile`.

### `folder-documents/moved-save-not-missing`

When a device puts an old buffer in an item's file's place, a device MUST NOT count the item's file missing.

**Tests:** `device/folders-placement.test.ts › counts nothing missing when it finishes taking an old buffer after a crash`.

### `folder-documents/moved-save-ends`

When a person edits or moves the file a pull moved, a device MUST treat a later file at the path it was moved from as `folder-files/copy-new-item` says.

**Reason:** a file made there after the person worked on the moved file is the person's own, not an old buffer of it.

**Tests:** `device/folders-placement.test.ts › makes an old buffer saved at the old name a new item once the moved file was edited`.

## Edge lines and name lookup

### `folder-documents/edge-catalog-refresh`

When a changed file names a newly registered edge type and the server is reachable, a device MUST read the line as an edge rather than a property.

**Tests:** `device/folders-frontmatter.test.ts › learns an edge type the server registers, and reads its line as an edge`, `device/fidelity.test.ts › matches the edge types a working copy holds and a folder reads its frontmatter lines by`.

### `folder-documents/edge-target-hydration`

When a new edge type is written from its to end, a device MUST refresh the folder slice to hold that type whole at the next push.

**Tests:** `device/folders-frontmatter.test.ts › learns an edge type the server registers, and reads its line as an edge`.

### `folder-documents/edge-title-outside-folder`

When a document writes an edge to a readable item outside the folder query, a device MUST render that to item by title where the name is unambiguous.

**Tests:** `device/folders-frontmatter.test.ts › writes and reads back by title a link to an item with no file on this Mac`.

### `folder-documents/edge-pin-held`

While at least one document line names an item outside the slice, a device MUST retain the pin it made for that item.

**Tests:** `device/folders-frontmatter.test.ts › holds a pin while a line names its item, and lets go only a pin it made`, `device/folders-contract-extra-c.test.ts › keeps a shared edge target pinned until the last owning file releases it`.

### `folder-documents/edge-pin-release`

When no file binding or edge line requires an item pinned by the folder, a device MUST release the folder's pin, unless a pinned create was answered with the item after an edge line pinned it (`device/pin-create-lasts`).

**Tests:** `device/folders-frontmatter.test.ts › holds a pin while a line names its item, and lets go only a pin it made`, `device/folders-contract-extra-c.test.ts › keeps a shared edge target pinned until the last owning file releases it`.

### `folder-documents/edge-pin-other-owner`

When an edge line is removed, a device MUST retain a pin for its to item that the folder did not create.

**Tests:** `device/folders-frontmatter.test.ts › holds a pin while a line names its item, and lets go only a pin it made`.

### `folder-documents/edge-writing-end`

When rendering an edge whose type's `written_from` is `from` or `to`, a device MUST write its frontmatter line only at that end, using its forward name at the from item or reverse name at the to item.

**Tests:** `device/folders-frontmatter.test.ts › writes an edge in one file only`, `device/folders-frontmatter.test.ts › writes parent-of as child-of in the child`.

### `folder-documents/edge-written-nowhere`

When rendering an edge whose type's `written_from` is `none`, a device MUST write no frontmatter line or body link for it, at either end.

**Reason:** no file writes such an edge, and the server keeps it. `in-folder` is one, since a file's place is where it sits.

**Tests:** `device/folders-frontmatter.test.ts › writes an edge of a type no file writes in no file, and flags a line naming it`.

### `folder-documents/edge-unwritten-line-flagged`

If a document has a frontmatter line named for an edge type whose `written_from` is `none`, then a device MUST flag the document and send no edge write for the line.

**Tests:** `device/folders-frontmatter.test.ts › writes an edge of a type no file writes in no file, and flags a line naming it`, `› flags an in-folder line and a line naming its own item`.

### `folder-documents/edge-file-fallback`

When an edge's designated writing end cannot carry frontmatter, a device MUST write the edge at the other document end under its name there.

**Tests:** `device/folders-frontmatter.test.ts › writes attached-to in the attachment's file, and has-attachment in an image's host`, `› is written beside its document, and its has-attachment line reads back as the same edge`.

### `folder-documents/edge-unknown-writer`

When the copy cannot determine whether an edge's designated writing end carries frontmatter, a device MUST preserve a typed reverse line at the other end.

**Tests:** `device/folders-frontmatter.test.ts › keeps a typed has-attachment to an image the copy does not hold`.

### `folder-documents/edge-title-format`

When a to item has a title that link syntax can represent and that no other item the folder's copy holds shares, a device MUST render an edge to item as `[[title]]`.

**Tests:** `device/folders-frontmatter.test.ts › writes an edge in one file only`.

### `folder-documents/edge-id-format`

When a to item title is ambiguous or cannot be represented in link syntax, a device MUST render the edge to item as `[[id]]`.

**Tests:** `device/folders-frontmatter.test.ts › writes the id form where a name is repeated`, `device/folders-frontmatter.test.ts › writes by id a title a link cannot hold`.

### `folder-documents/edge-id-read`

When an edge line names a readable item by ID, optionally followed by a heading or alias, a device MUST resolve that ID even if the item has no file in the folder.

**Tests:** `device/folders-frontmatter.test.ts › resolves a target written by id`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folder-documents/edge-filename-read`

When an edge line uniquely names a bound file by filename, a device MUST resolve it to that file's item.

**Tests:** `device/folders-frontmatter.test.ts › resolves a name by its file's name, and keeps it as typed`.

### `folder-documents/edge-alias`

When an edge line unambiguously names a to item with an alias or heading, a device MUST resolve the name before `|` or `#`.

**Tests:** `device/folders-frontmatter.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folder-documents/edge-deduplicate-target`

When several names in one edge line resolve to the same item, a device MUST treat them as one to item.

**Tests:** `device/folders-frontmatter.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`, `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folder-documents/edge-name-syntax-ambiguity`

If an edge-line to item resolves as its full text to one item and as a name with a heading or alias to a different item, then a device MUST flag the line `edges` instead of choosing a to item.

**Tests:** `device/folders-frontmatter.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`.

### `folder-documents/edge-name-unmatched`

If a typed edge to item matches no readable item, then a device MUST flag the file `edges` with the unmatched name.

**Tests:** `device/folders-frontmatter.test.ts › flags an unmatched name and leaves it as typed`.

### `folder-documents/edge-name-ambiguous`

If a typed edge to item matches more than one readable item, then a device MUST flag the file `edges` with the ambiguity.

**Tests:** `device/folders-frontmatter.test.ts › flags an ambiguous name and leaves it as typed`, `device/fidelity.test.ts › matches the title lookup a folder asks the server for typed names`.

### `folder-documents/edge-name-kept`

When an edge line already resolves to its item, a device MUST preserve the typed to item through a pull that rewrites the file.

**Tests:** `device/folders-frontmatter.test.ts › resolves a name by its file's name, and keeps it as typed`, `device/folders-frontmatter.test.ts › keeps a typed alias as typed, and flags a name that reads two ways`.

### `folder-documents/edge-new-namesake`

When another item takes an existing edge to item's name, a device MUST retain the existing edge to item.

**Tests:** `device/folders-frontmatter.test.ts › leaves an existing link unchanged when a same-named item appears`, `device/folders-retitled-links.test.ts › keeps naming the item when another takes its old title`.

### `folder-documents/edge-lookup-waits`

When name lookup cannot reach a server, a device MUST flag the unresolved edge name as waiting for lookup.

**Tests:** `device/folders-frontmatter.test.ts › waits for the server to resolve a name, and resolves it at the next pass that reaches it`.

### `folder-documents/edge-lookup-retries`

When the server becomes reachable after a name lookup waited, a device MUST retry that lookup at the next scan.

**Tests:** `device/folders-frontmatter.test.ts › waits for the server to resolve a name, and resolves it at the next pass that reaches it`.

### `folder-documents/edge-lookup-refused`

If the server refuses a name lookup that carried one name, other than by answering it as a route it does not have (HTTP 404 or 405), then a device MUST flag each file naming that name with the refusal.

**Reason:** only a refusal of a call that carried one name says which name was refused, and a missing route refuses the call whatever the number of names it carried, which `folder-documents/edge-lookup-call-refused` covers.

**Tests:** `device/folders-held-links.test.ts › does not ask again for a name a lookup of it alone was refused, and the file stays flagged with the refusal`.

### `folder-documents/edge-lookup-no-repeat`

While a file naming a name flagged under `folder-documents/edge-lookup-refused` is unchanged, a device MUST NOT repeat that lookup.

**Tests:** `device/folders-held-links.test.ts › does not ask again for a name a lookup of it alone was refused, and the file stays flagged with the refusal`.

### `folder-documents/edge-lookup-call-refused`

If the server refuses a name lookup that carried more than one name, or answers a name lookup that carried any number of names, one included, as a route it does not have (HTTP 404 or 405), then a device MUST flag each file naming a name that call carried as waiting for lookup.

**Reason:** a refusal of the call as a whole names none of its names, and a server older than the title lookup refuses every call, so the refusal says nothing about any one name.

**Tests:** `device/folders-frontmatter.test.ts › leaves the names a lookup refused as a whole carried waiting, says why once, and asks for them again at the next push`, `device/folders-held-links.test.ts › holds the links a server without the title lookup left waiting, says so once, and resolves them once it has one, the files unedited`, `device/folders-held-links.test.ts › holds the one link a server without the title lookup refused, as the call's refusal and not the name's`.

### `folder-documents/edge-lookup-call-retried`

When a scan follows one in which the server refused a name lookup under `folder-documents/edge-lookup-call-refused`, a device MUST look up the names that call carried again, whether or not the files naming them changed.

**Reason:** the condition that refused the call, such as a server not yet upgraded, can clear with no change to the folder.

**Tests:** `device/folders-frontmatter.test.ts › leaves the names a lookup refused as a whole carried waiting, says why once, and asks for them again at the next push`, `device/folders-held-links.test.ts › holds the links a server without the title lookup left waiting, says so once, and resolves them once it has one, the files unedited`.

### `folder-documents/edge-lookup-call-told`

When the server refuses a name lookup under `folder-documents/edge-lookup-call-refused`, a device MUST report the refusal once for the folder's scan rather than in each flagged file's reason.

**Reason:** the refusal is a standing condition of the server, not of any file, and a folder of thousands of linked notes would repeat it in each.

**Tests:** `device/folders-frontmatter.test.ts › leaves the names a lookup refused as a whole carried waiting, says why once, and asks for them again at the next push`, `device/folders-held-links.test.ts › holds the links a server without the title lookup left waiting, says so once, and resolves them once it has one, the files unedited`, `device/binding-folders-lookup.test.ts › tells an app why links by name wait when the server has no title lookup, and no longer once it has`.

### `folder-documents/create-before-links`

When a scan finds a new file whose edge lines or body links name a to item it cannot resolve, a device MUST create the file's item.

**Reason:** A document that links to one written later would otherwise wait on it, and two documents that link each other, written in separate passes, could never both be made.

**Tests:** `device/folders-held-links.test.ts › resolves a body link once its target is created on this machine, and asks nothing while the folder is quiet`, `› creates and links two new documents that link each other in one pass`, `› creates and links two documents that link each other, A.md written a pass before B.md`, `› creates and links two documents that link each other, B.md written a pass before A.md`.

### `folder-documents/edge-held-retried`

When the working copy has changed since a file was flagged `edges` because a name matched no item or more than one item, a device MUST look that name up again at the next scan, after every item that scan creates.

**Reason:** The item the name means may since have been created on this device, pulled in from another, or one of two namesakes moved to the bin. The working copy changes with every write sent or taken in, local or pulled.

**Tests:** `device/folders-held-links.test.ts › resolves a body link once its target is created on this machine, and asks nothing while the folder is quiet`, `› resolves a link once its target, created on another device, is pulled in`, `› creates and links two documents that link each other, A.md written a pass before B.md`, `› creates and links two documents that link each other, B.md written a pass before A.md`, `› never guesses between two items of one name, and resolves once one goes to the bin`.

### `folder-documents/edge-held-quiet`

While a file flagged `edges` because a name matched no item or more than one item is unchanged and the working copy has not changed since the flag, a device MUST NOT look that name up again.

**Reason:** A watch runs a full pass once each full-pass interval, and a lookup on every pass would ask the server about each held name that often for nothing.

**Tests:** `device/folders-held-links.test.ts › resolves a body link once its target is created on this machine, and asks nothing while the folder is quiet`.

### `folder-documents/edge-held-created`

When a held edge name resolves to one item other than the file's own, a device MUST create the edge, unless `folder-documents/edge-line-invalid-keeps-type` leaves the file's edges of that type at that end unchanged, that end holds one edge at most and already holds one, or the device refuses the edge.

**Reason:** At such an end, `folder-documents/edge-replace-one` moves an edge the file showed in one write, and `folder-documents/edge-replace-unshown-refused` flags a file that never showed the edge, so neither creates a second edge. A body link that comes to name its own document makes no edge (`folder-documents/body-self-link`).

**Tests:** `device/folders-held-links.test.ts › resolves a body link once its target is created on this machine, and asks nothing while the folder is quiet`, `› resolves a link once its target, created on another device, is pulled in`, `› never guesses between two items of one name, and resolves once one goes to the bin`, `› holds a link as waiting while the server is out of reach, and resolves it once it answers`, `› holds the links a server without the title lookup left waiting, says so once, and resolves them once it has one, the files unedited`, `device/folders-frontmatter.test.ts › writes no edge of a line while one of its names matches no item, and every edge once it does`, `› writes no edge of a line while a lookup of one of its names waits, out of reach or refused as a call, and every edge once it answers`, `› writes no edge of a child-of line beside an unmatched name, nor once that name makes it two parents`, `› moves a shown parent to a held name once it resolves, and creates no edge`, `› flags a held name that resolves at an end whose edge the file never showed, and writes nothing`, `› flags a held name that resolves to an edge the device refuses, and writes nothing`.

### `folder-documents/edge-held-cleared`

When a held edge name resolves to one item and no line or link of the file, that name's own line included, gives a reason to flag it, a device MUST clear the file's `edges` flag.

**Reason:** A line can still hold the file after one of its names resolves: another of its names may match nothing, or the name may take the line past its end's cardinality.

**Tests:** `device/folders-held-links.test.ts › resolves a body link once its target is created on this machine, and asks nothing while the folder is quiet`, `› resolves a link once its target, created on another device, is pulled in`, `› never guesses between two items of one name, and resolves once one goes to the bin`, `› holds a link as waiting while the server is out of reach, and resolves it once it answers`, `› holds the links a server without the title lookup left waiting, says so once, and resolves them once it has one, the files unedited`, `device/folders-frontmatter.test.ts › writes no edge of a line while one of its names matches no item, and every edge once it does`, `› writes no edge of a line while a lookup of one of its names waits, out of reach or refused as a call, and every edge once it answers`, `› writes no edge of a child-of line beside an unmatched name, nor once that name makes it two parents`, `› keeps a file flagged for the names of a line still held once one of them resolves, and clears it with the last`.

### `folder-documents/edge-held-never-guessed`

If a held edge name still matches more than one item when it is looked up again, then a device MUST NOT create an edge for that name.

**Tests:** `device/folders-held-links.test.ts › never guesses between two items of one name, and resolves once one goes to the bin`.

### `folder-documents/edge-lookup-list-limit`

If the server says more items are titled a name than it lists, then a device MUST flag the name as matching more than one item.

**Reason:** the server lists at most 20 items for a name, so more than that are titled alike, and no one of them is the item wanted.

**Tests:** `device/folders-frontmatter.test.ts › flags a name more common than the lookup lists as matching more than one item`.

### `folder-documents/lookup-batched`

When a scan resolves the names its files' links and lines type, a device MUST ask the server for them in calls of at most 200 distinct names, each name once.

**Reason:** a request for each name takes time that grows with the names a folder links, and a folder of ten thousand notes links more names than a server can answer one at a time in a useful while.

**Tests:** `device/folders-held-links.test.ts › asks the server for the names of a scan in calls of 200, each distinct name once`.

### `folder-documents/lookup-held-ambiguous`

If the copy holds two or more items under a name, then a device MUST flag the name as matching more than one item without asking the server for it.

**Reason:** what the server holds can only add to the items, so no answer could make the name name one.

**Tests:** `device/folders-held-links.test.ts › leaves a name the copy holds under two items out of the lookup, and asks the rest`, `device/folders-held-links.test.ts › never guesses between two items of one name, and resolves once one goes to the bin`.

### `folder-documents/edge-lookup-states`

When resolving an edge to item by name, a device MUST consider archived items and exclude trashed items.

**Tests:** `device/folders-frontmatter.test.ts › counts an archived match only the server holds, and none in the bin`.

### `folder-documents/edge-lookup-title-field`

When resolving an edge to item by title, a device MUST match the property that its type uses as the title.

**Tests:** `device/folders-frontmatter.test.ts › matches a title only in the property its type keeps it in`.

### `folder-documents/edge-line-removal`

When a document removes a previously rendered edge line, a device MUST delete the edge that line represented.

**Tests:** `device/folders-frontmatter.test.ts › removes the edge whose line was taken out`.

### `folder-documents/edge-unshown-kept`

When an edge has arrived from elsewhere but has not appeared in the file, a device MUST preserve it when processing that file.

**Tests:** `device/folders-frontmatter.test.ts › flags a new target for an end whose edge the file never showed, and deletes nothing`.

### `folder-documents/edge-line-invalid-keeps-type`

If an edge line has an unresolved to item, names its own item, is at the wrong end, exceeds its end's cardinality, or holds a value not written as `[[name]]`, then a device MUST leave that file's edges of that type at that end unchanged.

**Tests:** `device/folders-frontmatter.test.ts › writes no edge of a body link beside a references line not written as a name, and the edge once the line is gone`, `device/folders-frontmatter.test.ts › changes no edge of a type whose target it cannot resolve`, `device/folders-frontmatter.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`, `device/folders-frontmatter.test.ts › flags a line naming too many targets for its edge type, and changes nothing`, `device/folders-frontmatter.test.ts › flags an in-folder line and a line naming its own item`, `device/folders-frontmatter.test.ts › writes no edge of a child-of line beside an unmatched name, nor once that name makes it two parents`, `› writes the edge of a child-of line beside a held parent-of line in the same file`.

### `folder-documents/edge-line-held-whole`

If a name on an edge line does not name exactly one existing edge of that line's type at that end, and it matches no readable item, matches more than one readable item, or could not be looked up, then a device MUST NOT create an edge for any other name on that line.

**Reason:** The file is already flagged, so the person can see what holds the line. Writing part of a line would leave what the line owns unclear. A name that names one existing edge holds nothing back, as it keeps naming that edge's item whatever else takes the name (`folder-documents/edge-new-namesake`).

**Tests:** `device/folders-frontmatter.test.ts › writes no edge of a line while one of its names matches no item, and every edge once it does`, `› writes no edge of a line while one of its names matches two items, and every edge once it names one`, `› writes no edge of a line while a lookup of one of its names waits, out of reach or refused as a call, and every edge once it answers`, `› writes no edge of a line while the lookup of one of its names is refused, and every edge once it is answered`, `› writes no edge of a child-of line beside an unmatched name, nor once that name makes it two parents`, `› creates an edge beside a name that already names one of the line's edges, though another item took that name`, `› writes no edge of a line naming two of its edges by one name, and the edge once it names them apart`, `device/folders-retitled-links.test.ts › reads a line's old name as its edge while the file keeps that name, and holds the line once nothing answers to it`.

### `folder-documents/edge-line-invalid-report`

If an edge line is invalid, then a device MUST flag the file `edges` with the reason.

**Tests:** `device/folders-frontmatter.test.ts › changes no edge of a type whose target it cannot resolve`, `device/folders-frontmatter.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`, `device/folders-frontmatter.test.ts › flags a line naming too many targets for its edge type, and changes nothing`, `device/folders-frontmatter.test.ts › flags an in-folder line and a line naming its own item`, `device/folders-contract-extra-c.test.ts › leaves an invalid bare edge line untouched while a valid link queues its edge`.

### `folder-documents/edge-line-no-item-edit`

When a save changes only edge lines, a device MUST NOT send an item-property edit for those changes.

**Tests:** `device/folders-frontmatter.test.ts › removes the edge whose line was taken out`, `device/folders-frontmatter.test.ts › flags a reverse-named edge stated at the wrong end, and changes nothing`.

### `folder-documents/edge-replace-one`

When a line changes the to item of an end that holds one edge, a device MUST move the existing edge's other end in one write.

**Tests:** `device/folders-frontmatter.test.ts › replaces a one-target edge's target in one step`, `device/fidelity.test.ts › matches the refusal of a second parent, a parent moved in one step, and each refusal of a move`.

### `folder-documents/edge-replace-keeps-properties`

When a line moves an existing edge's other end, a device MUST preserve that edge's ID and properties.

**Tests:** `device/folders-frontmatter.test.ts › replaces a one-target edge's target in one step`.

### `folder-documents/edge-replace-unshown-refused`

When a line names a new to item but the existing edge at that end has not appeared in the file, a device MUST flag the file.

**Tests:** `device/folders-frontmatter.test.ts › flags a new target for an end whose edge the file never showed, and deletes nothing`.

### `folder-documents/edge-replace-unshown-kept`

When a line names a new to item but the existing edge at that end has not appeared in the file, a device MUST leave that edge unchanged.

**Tests:** `device/folders-frontmatter.test.ts › flags a new target for an end whose edge the file never showed, and deletes nothing`.

### `folder-documents/edge-delete-already-gone`

When an edge deletion is answered `edge_not_found`, a device MUST treat the requested removal as complete.

**Tests:** `device/folders-frontmatter.test.ts › takes a delete of an edge already gone as done`.

### `folder-documents/edge-move-refused`

When the server refuses an edge move, a device MUST retain the old edge in its working copy.

**Tests:** `device/folders-frontmatter.test.ts › keeps the old edge where the replace is refused`.

### `folder-documents/edge-move-refusal-holds`

When the server refuses an edge move, a device MUST hold the document with the server's refusal reason.

**Tests:** `device/folders-frontmatter.test.ts › keeps the old edge where the replace is refused`, `device/folders-frontmatter.test.ts › holds a file whose move a plain device drain saw refused`.

### `folder-documents/edge-refusal-next-move`

When a later edit replaces a refused edge move, a device MUST move from the edge's last accepted position.

**Tests:** `device/folders-frontmatter.test.ts › keeps the old edge where the replace is refused`.

### `folder-documents/edge-move-gone-create`

When an edge move is answered that the edge is gone, a device MUST create the edge the document line now requests.

**Tests:** `device/folders-frontmatter.test.ts › makes the edge a line asks for where its move finds the edge deleted elsewhere`, `device/folders-frontmatter.test.ts › makes the edge a gone move's line asks for at the next drain, where the first one stops`.

### `folder-documents/edge-move-gone-properties`

When an edge move is answered that the edge is gone, a device MUST preserve the former edge's properties in the replacement edge it creates for the document line.

**Tests:** `device/folders-frontmatter.test.ts › makes the edge a line asks for where its move finds the edge deleted elsewhere`.

### `folder-documents/edge-move-waits-create`

When a line moves an edge to an item whose create is queued, a device MUST wait for that item create before sending the move.

**Tests:** `device/folders-frontmatter.test.ts › waits for the create of the item its line now names before it moves the edge`.

### `folder-documents/edge-move-dead-keeps`

When an edge move dies after its retries, a device MUST retain the accepted server edge.

**Tests:** `device/folders-frontmatter.test.ts › leaves the server's edge whole where a move dies after its retries`.

### `folder-documents/edge-create-refusal-holds`

When the server refuses an edge create from a document line, a device MUST report the refusal beside any unresolved-name flag for that file.

**Tests:** `device/folders-frontmatter.test.ts › holds a file whose line's edge is refused, and says it beside a name it cannot resolve`.

### `folder-documents/edge-catalog-boundaries`

When a folder is added, hydrated or caught up, a device MUST read the current edge-type catalog.

**Tests:** `device/folders-contract-extra-c.test.ts › reads the edge catalog at add, hydration and catch-up`.

### `folder-documents/edge-no-writable-name`

When an edge's writing end cannot carry frontmatter and the edge type has no name from the other end, a device MUST write that edge in no file.

**Tests:** `device/folders-contract-extra-c.test.ts › writes no line for a binary edge writer with no reverse name`.

### `folder-documents/edge-name-normalization`

When an edge-line name uniquely matches a to item by title or filename, a device MUST resolve the to item without regard to case or Unicode normalization form.

**Reason:** The server's lookup compares case over ASCII; the device resolves and deduplicates the candidates using its name comparison.

**Tests:** `device/folders-contract-extra-c.test.ts › resolves decorated IDs, frontmatter headings and equivalent names to one target`.

### `folder-documents/edge-restored-target`

When a line held because its to item was trashed names that item after its restoration reaches the working copy, a device MUST resolve the line at the next scan.

**Tests:** `device/folders-contract-extra-c.test.ts › resolves a held line when its trashed target is restored`.

## Body links and embedded files

### `folder-documents/body-reference`

When a Markdown body links to another item, a device MUST create a `references` edge from the document item to the linked item, unless `folder-documents/edge-line-invalid-keeps-type` leaves the document's outgoing `references` edges unchanged.

**Reason:** A held `references` line stands down every change to that type at that end, and a body link's edge is one. The edge is created once the line resolves.

**Tests:** `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`, `device/folders-frontmatter.test.ts › writes no edge of a body link while the references line beside it is held, and both once the line resolves`.

### `folder-documents/body-edge-not-repeated`

When a Markdown body already represents a `references` edge as a link or an embed, or an `attached-to` edge as an embed of a file the folder's query does not hold, a device MUST NOT repeat it as a frontmatter edge line.

**Tests:** `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`, `device/folders-frontmatter.test.ts › lists under has-attachment only what the body does not embed`, `device/folders-frontmatter.test.ts › resolves body links by title and nested filename without repeating references on pull`.

### `folder-documents/body-unlinked-edge-line`

When a `references` edge has no matching body link, a device MUST render it as a frontmatter line without changing the body.

**Tests:** `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`.

### `folder-documents/body-link-name`

When a Markdown body link names an ID, title, filename, or bound file path with an optional extension, heading, or alias, a device MUST resolve the linked item by the same name rules as frontmatter edge lines.

**Tests:** `device/folders-frontmatter.test.ts › resolves body links by title and nested filename without repeating references on pull`, `device/folders-frontmatter.test.ts › reports ambiguous body links including whole names with heading or alias marks`.

### `folder-documents/body-link-ambiguity`

When a body-link name is ambiguous, including between its full text and its heading or alias interpretation, a device MUST report the ambiguity without choosing a target.

**Tests:** `device/folders-frontmatter.test.ts › reports ambiguous body links including whole names with heading or alias marks`, `device/folders-frontmatter.test.ts › does not choose between existing references answering to the same body name`.

### `folder-documents/body-code-comments`

When a body link occurs in Markdown code, an HTML comment, or an Obsidian `%%` comment, a device MUST treat it as text.

**Tests:** `device/folders-frontmatter.test.ts › ignores body links in code and comments while sending visible links`, `device/folders-frontmatter.test.ts › keeps visible references and removes code-only references with %s`.

### `folder-documents/body-local-heading`

When a body link names only a heading in the same document, a device MUST ignore it for edge creation.

**Tests:** `device/folders-frontmatter.test.ts › resolves body links by title and nested filename without repeating references on pull`, `device/folders-frontmatter.test.ts › ignores body links in code and comments while sending visible links`.

### `folder-documents/body-note-embed`

When a Markdown body embeds a document rather than a file item, a device MUST treat that embed as text.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed of a note, even one with a dot in its name, as text`, `device/folders.test.ts › carries body links to edges, and an edge no link names to a line`.

### `folder-documents/body-lookup-retry`

When a body-link lookup cannot reach the server, a device MUST retry it at the next pass that reaches the server.

**Tests:** `device/folders-frontmatter.test.ts › waits for body link lookups and retries them when the server returns`.

### `folder-documents/body-missing-report`

When a body link resolves to no item, a device MUST flag its document with the link text and reason.

**Tests:** `device/folders-frontmatter.test.ts › reports missing body links and preserves removals until all links resolve`, `device/body-links-live.test.ts › resolves body links through real server lookup and keeps their removal after pull`.

### `folder-documents/body-unresolved-keeps-edges`

While a body link is unresolved, a device MUST retain the document's existing references until every link resolves.

**Tests:** `device/folders-frontmatter.test.ts › reports missing body links and preserves removals until all links resolve`, `device/body-links-live.test.ts › resolves body links through real server lookup and keeps their removal after pull`.

### `folder-documents/body-link-retitled`

When a pull finds that a wiki link in a document's body names, by a title or a file name, an item the device's record of the body resolves it to, and that name no longer answers to the item, a device MUST rewrite only the name part of the link in the document's file to the item's current title, or to its ID where `folder-documents/body-link-retitled-id` applies, keeping the link's heading, block reference, and alias, and leaving links by ID, Markdown links, embeds, links in code or comments, and frontmatter lines unchanged.

**Reason:** a person who retitles a note expects the links to it to follow, as Obsidian rewrites them. Without the rewrite the body keeps a name that the next reader, or another app, resolves to nothing or to another item. Only the name changes, so the link still shows what the person wrote. The device sends the rewritten body as an update conditioned on the exact version it read (`versions/exact-match`), so where two folders or two Macs rewrite the same document, one rewrite lands and the others take its answer.

**Tests:** `device/folders-retitled-links.test.ts › names the item by its new title, its alias and heading kept, code, embeds and frontmatter lines left alone`, `› names the item by its new title where its file here was renamed`, `› is rewritten once where %s`.

### `folder-documents/body-link-retitled-edit`

If a document's file differs from what the folder last wrote or read, or the document's update was refused or answered with a conflict at the version the rewrite would send from, then a device MUST NOT rewrite the document's links for `folder-documents/body-link-retitled` until the folder has read and sent the file's bytes or holds a newer version of the document.

**Reason:** the person's bytes are theirs. A rewrite made over an edit the folder has not read yet would replace it, and a rewrite the server refused or that lost to another write would otherwise be sent again at every pull. A rewrite that loses is dropped without a report, since the document keeps the winner's body.

**Tests:** `device/folders-retitled-links.test.ts › keeps an edit the person made and rewrites the links of what they wrote`, `› is rewritten once where %s`.

### `folder-documents/body-link-retitled-waits`

While the server has not accepted an item's new title, or a write of the document or of the linked item waits unanswered in the device's queue, a device MUST NOT rewrite the document's links to that item for `folder-documents/body-link-retitled`.

**Reason:** a title the server refuses is not the item's title, so a rewrite to it would name nothing. A write still waiting may change the body or the title the rewrite reads.

**Tests:** `device/folders-retitled-links.test.ts › rewrites nothing for a title the server refuses`, `› waits while a write of the linking document is unanswered, and rewrites it once answered`.

### `folder-documents/body-link-retitled-id`

When the item's current title is empty, is not a name a wiki link can hold, or answers to another item too, a device MUST rewrite the link for `folder-documents/body-link-retitled` to name the item by its ID, with an alias of the text the link showed.

**Reason:** a title that names two items would make the link ambiguous (`folder-documents/body-link-ambiguity`). The ID names the item alone, and the alias keeps what the reader sees.

**Tests:** `device/folders-retitled-links.test.ts › names the item by its id where its new title names another item too`.

### `folder-documents/body-link-retitled-reparsed`

If a document's body, with its links renamed to the items' titles for `folder-documents/body-link-retitled`, would not read as the same links in the same order naming the items meant, with the same embeds and the same cells in each table row, then a device MUST rename those links to the items' IDs as `folder-documents/body-link-retitled-id` does.

**Reason:** a title can hold characters that change how the text around the link reads. A title with a backtick or `<!--` opens a code span or a comment that hides the links after it, so the next scan would end their `references` edges. An ID holds none of these characters.

**Tests:** `device/folders-retitled-links.test.ts › names the item by its id where its new title would open %s over the text after the link`.

### `folder-documents/body-link-retitled-unparsed`

If a document's body, with its links renamed to the items' IDs for `folder-documents/body-link-retitled-id`, would not read as the same links in the same order naming the items meant, with the same embeds and the same cells in each table row, then a device MUST NOT rewrite the document's links.

**Reason:** a rewrite that changes what the body links to, embeds or lays out in a table changes what the person wrote. A link by ID that had no alias gains one behind a bare bar, which in a table row, a table in a blockquote or callout included, would end the cell, so such a document keeps its old links.

**Tests:** `device/folders-retitled-links.test.ts › leaves a document alone where a link by id would sit in a table row`.

### `folder-documents/body-link-retitled-table-pipe`

When rewriting a link in a table cell for `folder-documents/body-link-retitled`, a device MUST keep each `\|` in the link.

**Reason:** a rewrite replaces the name alone. A bare bar would end the cell and split the table, and a link outside a table has no `\|` to keep, so it keeps what it had.

**Tests:** `device/folders-retitled-links.test.ts › keeps the escaped pipe of a link in a cell of %s when it renames the link`.

### `folder-documents/body-link-retitled-behind`

If a rewrite of a document's links for `folder-documents/body-link-retitled` is answered `version_conflict`, then a device MUST send each write queued behind the rewrite as it would have sent it had the rewrite never been queued.

**Reason:** the rewrite is the device's own, and the person never made it. Their edit made while it waited is theirs, so it is never refused, dropped or held because the rewrite lost to another writer.

**Tests:** `device/folders-retitled-links.test.ts › lands an edit the person made behind a rewrite another machine beat`.

### `folder-documents/body-link-retitled-unflagged`

While a document's `references` edge to an item stands and the device's record of the body resolves a link to that item, a device MUST resolve the link to that item, without flagging it as missing or ambiguous, even where its name no longer answers to it or answers to another item.

**Reason:** a link waiting for its rewrite, or one the person's edit keeps, still means the item it meant. Flagging it, or moving its edge to a newcomer with the old name, would report or change what the person did not.

**Tests:** `device/folders-retitled-links.test.ts › waits while a write of the linking document is unanswered, and rewrites it once answered`, `› keeps naming the item when another takes its old title`.

### `folder-documents/embed-edge`

When a Markdown body embeds a local file, a device MUST create a `references` edge from the document item to the file item, unless `folder-documents/edge-line-invalid-keeps-type` leaves the document's outgoing `references` edges unchanged.

**Reason:** the embed is how the body says which file it shows, as a link says which item it names. Showing a file is not owning it, so an edit to the body never decides whether a file goes to the bin with its document.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`, `› references an embedded file, and attaches it only where the query does not hold it`, `› writes no reference of an embed while the references line beside it is held, and the reference once the line resolves`.

### `folder-documents/embed-edge-outside`

When a Markdown body comes to embed a local file the folder's query does not hold, a device MUST create an `attached-to` edge from the file item to the document item, whether or not a link in the body already names the file.

**Reason:** a file outside the query is in the folder only as a document's part (`folder-documents/embedded-outside-search`), and a folder of notes keeps its pictures beside them. A file the query holds is the folder's own, and only its `has-attachment` line attaches it. An embed already in the body when its attachment is taken away elsewhere does not attach the file again. A link to the file is no embed of it, so the folder keeps a document's embeds apart from its links in its record of the document.

**Tests:** `device/folders-frontmatter.test.ts › references an embedded file, and attaches it only where the query does not hold it`, `› sends an embedded file with its file`.

### `folder-documents/embed-attachment-line-kept`

While a document's body embeds a file the folder's query holds and that file is attached to the document, a device MUST render the attachment in the document's `has-attachment` line.

**Reason:** the embed makes only a reference to such a file, so the line is what says the file is part of the document, and a file without it would read back as taking the attachment away.

**Tests:** `device/folders-frontmatter.test.ts › keeps a has-attachment line for a file the query holds and the body embeds`, `device/folders-contract-extra-c.test.ts › keeps an attachment line for a file the query holds when the host body also embeds it`.

### `folder-documents/embed-edge-removal`

When a document removes an embed, a device MUST delete that embed's `references` edge.

**Tests:** `device/folders-frontmatter.test.ts › removes only the reference when the embed is taken out`, `device/folders-frontmatter.test.ts › removes the reference of an embed taken out between two scans before a push`.

### `folder-documents/embed-removal-keeps-attachment`

When a document removes an embed, a device MUST NOT delete the embedded file's `attached-to` edge to the document.

**Reason:** whether the file is part of the document is the attachment's to say, not the body's, so the file stays attached and a `has-attachment` line shows it (`folder-documents/attachment-line`).

**Tests:** `device/folders-frontmatter.test.ts › removes only the reference when the embed is taken out`, `› removes the reference of an embed taken out between two scans before a push`, `› sends an embedded file with its file`.

### `folder-documents/embed-rederived`

When a folder has not read its files since its device came to read an embed as a `references` edge, a device MUST read every document in the folder that embeds a file again once, at the next scan, whether or not the file changed.

**Reason:** an embed once made the file's `attached-to` edge instead, and the folder's record of each document says so. A folder added afresh reads its documents again too: its first pull records each document it writes as read, and a body written under the earlier rule has no reference until it is read. Reading once brings each document to this rule, and the folder reads no unchanged document again after it.

**Tests:** `device/folders-frontmatter.test.ts › reads its embeds again once, and keeps only an outside file's attachment the earlier rule made`, `› references the files a document already embeds when the folder is added afresh`.

### `folder-documents/embed-rederived-attachment`

When a folder reads a document again for `folder-documents/embed-rederived`, a device MUST delete each `attached-to` edge from a file item to the document item where the folder's query holds the file, the document's body embeds the file, the document has no `has-attachment` line naming the file, and the folder's record of the document names the edge.

**Reason:** under `folder-documents/embed-edge-outside` an embed attaches only a file outside the query, so a file the query holds that only an embed attached was never the document's part. The earlier rule recorded such an edge as the document's own, whoever made it, so no record tells an edge the embed made from one a person or an app made: the read corrects every such edge once. It deletes only the edge, and both items stay.

**Tests:** `device/folders-frontmatter.test.ts › reads its embeds again once, and keeps only an outside file's attachment the earlier rule made`.

### `folder-documents/embed-rederived-outside-kept`

When a folder reads a document again for `folder-documents/embed-rederived`, a device MUST NOT delete the `attached-to` edge that an embed made to a file the folder's query does not hold.

**Reason:** the embed still attaches such a file (`folder-documents/embed-edge-outside`).

**Tests:** `device/folders-frontmatter.test.ts › reads its embeds again once, and keeps only an outside file's attachment the earlier rule made`.

### `folder-documents/embed-file-kept`

When a document removes an embed, or a `has-attachment` line, a device MUST retain the attached file on disk.

**Tests:** `device/folders-frontmatter.test.ts › removes only the reference when the embed is taken out`, `› lists under has-attachment only what the body does not embed`.

### `folder-documents/embed-markdown-only`

When a raw-text document contains embed syntax, a device MUST NOT create an edge for that syntax.

**Tests:** `device/folders-frontmatter.test.ts › reads embeds in a Markdown body only, and none shown in code`, `device/folders-frontmatter.test.ts › writes no file a .txt file's text embeds`.

### `folder-documents/embed-file-item-bytes`

When a file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) is the file of a file item and its bytes contain embed syntax, a device MUST NOT treat that syntax as an embed.

**Reason:** a file item's bytes are not read as text, and a pull can place a file item at a document name or a person can rename one to it. A file that only that syntax names stays unsent, as `folder-documents/binary-outside-search` says.

**Tests:** `device/folders-placement.test.ts › follows no embed in a file item's bytes at a document name, and still a note's, named %s`.

### `folder-documents/embed-raw-no-file`

When a raw-text document contains embed syntax, a device MUST NOT materialize a file for that syntax.

**Tests:** `device/folders-frontmatter.test.ts › writes no file a .txt file's text embeds`.

### `folder-documents/embed-code-comments`

When embed syntax occurs in a code span, fenced code block, indented code block or comment, a device MUST treat it as text, including code nested inside lists or quotes.

**Tests:** `device/folders-frontmatter.test.ts › reads embeds in a Markdown body only, and none shown in code`, `device/folders-contract-extra-c.test.ts › ignores embeds in list fences and indented code while reading a normal list paragraph`.

### `folder-documents/embed-path`

When a Markdown embed names a path, a device MUST resolve it relative to the embedding document's directory, or the folder root for a leading `/`.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path as Obsidian reads one`.

### `folder-documents/embed-path-escapes`

When resolving an embed path, a device MUST read it in the order `device/embed-path-markdown-escape` gives: backslash escapes, then the cut at the first `?` or `#`, then percent escapes.

**Reason:** a Markdown editor escapes an underscore in a file name as `\_`, and a folder's embed reads the same path as a working copy's body does.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path as Obsidian reads one`.

### `folder-documents/embed-table-pipe`

When an embed in a document's body sits inside a table cell, a device MUST read its name as `device/embed-table-pipe` reads it.

**Reason:** a folder's embed reads the same body text as a working copy's.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path as Obsidian reads one`.

### `folder-documents/link-table-pipe`

When a link in a document's body sits inside a table cell, a device MUST read it as `device/link-table-pipe` reads it.

**Reason:** a folder's link reads the same body text as a working copy's.

**Tests:** `device/folders-frontmatter.test.ts › links the item a table cell link names, and holds one that names nothing under that name`, `device/folders-frontmatter.test.ts › reads a link's backslash as text outside a table`.

### `folder-documents/embed-address`

When an embed names an address beginning with `https://`, `//`, or `#`, a device MUST NOT treat it as a local file.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path as Obsidian reads one`.

### `folder-documents/embed-path-case`

When an embed path differs only in case from the matching file, a device MUST retain the file's own spelling.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed's path whatever its case, and keeps the file's own name`.

### `folder-documents/embed-wiki-name`

When `![[name]]` names a file, a device MUST prefer the root-relative path, then a matching path suffix at a directory boundary ordered by the embedding directory, shallowest depth, and path.

**Tests:** `device/folders-frontmatter.test.ts › reads an embed by name as Obsidian resolves a name`.

### `folder-documents/embed-upload`

When a document embeds an admissible file, a device MUST upload that file before creating its file item regardless of the query's admitted file types.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folder-documents/embed-held`

While a document in a folder embeds a readable active or archived file item, or such an item is attached to the document, a device MUST retain the item's file regardless of the folder query's type and state restrictions.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`, `device/folders-frontmatter.test.ts › keeps an embedded file archived elsewhere where its query holds active items only`, `› is kept archived elsewhere while its document is held, where the query holds active items only`.

### `folder-documents/embed-path-placement`

When a pull materializes a path embed, a device MUST place its file where the document's link names it.

**Tests:** `device/folders-frontmatter.test.ts › writes an embedded file where its link says`.

### `folder-documents/embed-name-placement`

When a pull materializes a name embed, a device MUST use an existing matching placement or file path, otherwise place a bare name beside the embedding document or a name containing a directory at the folder root.

**Tests:** `device/folders-frontmatter.test.ts › writes an embedded file where its link says`, `device/folders-frontmatter.test.ts › writes a file embedded by name where its placement already answers to the name`, `device/folders-frontmatter.test.ts › writes a file embedded by name where another embed's path names it`.

### `folder-documents/embed-placement-follows`

When an embed determines a file's path, a device MUST update that file's `in-folder` placement to the path.

**Tests:** `device/folders-frontmatter.test.ts › writes an embedded file where its link says`.

### `folder-documents/embed-renamed`

When an embedded file is renamed so its old link no longer names it, a device MUST preserve the file's item and its `references` and `attached-to` edges at its new name.

**Tests:** `device/folders-frontmatter.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folder-documents/embed-renamed-report`

When an embedded file is renamed so its old link no longer names it, a device MUST report the broken embed.

**Tests:** `device/folders-frontmatter.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folder-documents/embed-unresolved-line`

When a renamed attachment no longer resolves from its body embed, a device MUST render its `has-attachment` line.

**Tests:** `device/folders-frontmatter.test.ts › follows an embedded file renamed away from its link, and says the link names nothing`.

### `folder-documents/embed-attachment-hydration`

When a folder query admits document types, a device MUST hold `attached-to` edges whole.

**Tests:** `device/folders-frontmatter.test.ts › holds attachments whole only where its query holds a document`.

### `folder-documents/embed-trashed-line`

When an embedded item is trashed or its ability to carry frontmatter is unknown, a device MUST NOT repeat its attachment edge under `has-attachment`.

**Tests:** `device/folders-frontmatter.test.ts › lists a trashed embedded file under has-attachment no more than a held one`.

### `folder-documents/embed-outside`

When an embed path leads outside the folder, a device MUST report the embed in `embeds`.

**Tests:** `device/folders-frontmatter.test.ts › reports an embed pointing outside the folder`.

### `folder-documents/embed-outside-no-write`

When an embed path leads outside the folder, a device MUST NOT read or write the file it names.

**Tests:** `device/folders-frontmatter.test.ts › reports an embed pointing outside the folder`.

### `folder-documents/embed-several-paths`

When one attachment is embedded at different paths, a device MUST write it at the first path in path order.

**Tests:** `device/folders-frontmatter.test.ts › writes an item embedded at two paths at the first, and reports the other`.

### `folder-documents/embed-several-paths-report`

When one attachment is embedded at different paths, a device MUST report each embed naming another path.

**Tests:** `device/folders-frontmatter.test.ts › writes an item embedded at two paths at the first, and reports the other`.

### `folder-documents/embed-unresolved-keeps-edges`

While an embed names a missing file or has an invalid raw-space path, a device MUST retain the document's existing `references` edges.

**Tests:** `device/folders-frontmatter.test.ts › removes no reference while an embed names nothing, and removes it once none does`.

### `folder-documents/embed-unreadable-target`

When an embed names no attachment the key can read, a device MUST report the embed.

**Tests:** `device/folders-frontmatter.test.ts › reports an embed of a file the key cannot read, and writes nothing for it`.

### `folder-documents/embed-unreadable-no-write`

When an embed names no attachment the key can read, a device MUST NOT write a file for it.

**Tests:** `device/folders-frontmatter.test.ts › reports an embed of a file the key cannot read, and writes nothing for it`.

### `folder-documents/embed-ambiguous-target`

When an embed name matches two attachments, a device MUST report the ambiguity.

**Tests:** `device/folders-frontmatter.test.ts › reads a name two attachments share as neither, and says so`.

### `folder-documents/embed-ambiguous-no-write`

When an embed name matches two attachments, a device MUST NOT place either attachment's file by that embed.

**Tests:** `device/folders-frontmatter.test.ts › reads a name two attachments share as neither, and says so`.

### `folder-documents/body-self-link`

When a body link names its own document item, a device MUST NOT create an edge for that link.

**Tests:** `device/folders-contract-extra-c.test.ts › ignores a body link to its own item while linking another item`.

### `folder-documents/embed-list-paragraph`

When an embed occurs in an ordinary Markdown list paragraph, a device MUST resolve it as an embed despite the list indentation.

**Tests:** `device/folders-contract-extra-c.test.ts › ignores embeds in list fences and indented code while reading a normal list paragraph`.

### `folder-documents/embed-duplicate-line`

When a pull rewrites a document whose body embeds an attachment the folder's query does not hold, also named in its `has-attachment` line, a device MUST omit that duplicate attachment from the line.

**Tests:** `device/folders-frontmatter.test.ts › lists under has-attachment only what the body does not embed`, `› sends an embedded file with its file`.

### `folder-documents/embed-upload-size`

When an embedded file needs uploading, a device MUST leave its size-limit decision to the server's upload operation.

**Tests:** `device/folders-contract-extra-c.test.ts › sends an embedded file to the server for its upload limit decision`.

### `folder-documents/attachment-beside`

When a pull writes a document that a readable active or archived file item is attached to, no document in the folder embeds that file, and the folder's query does not hold it, a device MUST write the file in the directory of a document it is attached to.

**Reason:** a file attached to an item is part of that item, so a folder that holds the item holds its files too, wherever the body shows them or not.

**Tests:** `device/folders-frontmatter.test.ts › is written beside its document, and its has-attachment line reads back as the same edge`, `› reports an embed pointing outside the folder`, `› writes no file a .txt file's text embeds`.

### `folder-documents/attachment-line`

While a document's attachment is written beside the document and the body embeds it nowhere, a device MUST render the attachment in the document's `has-attachment` line.

**Tests:** `device/folders-frontmatter.test.ts › is written beside its document, and its has-attachment line reads back as the same edge`, `› reports an embed pointing outside the folder`, `› removes only the reference when the embed is taken out`.

### `folder-documents/attachment-name`

When a pull writes a file attached to documents in a folder, which no document there embeds and the folder's query does not hold, and the file has no path in the folder yet, a device MUST name it from its item's title, numbered beside any other file the pull places at that name without regard to case or Unicode normalization (`folder-files/placement-collision-number`).

**Tests:** `device/folders-frontmatter.test.ts › is written under a number where another attachment of its document has its name, whatever the case`, `› reads a name two attachments share as neither, and says so`.

### `folder-documents/attachment-stays`

While a file attached to documents in a folder, which no document there embeds and the folder's query does not hold, is in the directory of one of those documents, a device MUST leave it at its path.

**Tests:** `device/folders-frontmatter.test.ts › follows its document to another directory, and goes back beside it when moved away`.

### `folder-documents/attachment-follows`

When a file attached to documents in a folder, which no document there embeds and the folder's query does not hold, is in the directory of none of those documents, or has no path in the folder yet, a device MUST write it in the directory of the first of those documents in path order.

**Reason:** an attachment that no embed places has its document as its only anchor, so it follows the document, and a file moved away from it goes back, as a file an embed places by path does.

**Tests:** `device/folders-frontmatter.test.ts › follows its document to another directory, and goes back beside it when moved away`, `› is written once, beside the first of its documents in path order, and the other is reported`.

### `folder-documents/attachment-written-once`

When a pull writes a file attached to documents in more than one directory of a folder, which no document there embeds and the folder's query does not hold, a device MUST write one copy of it.

**Tests:** `device/folders-frontmatter.test.ts › is written once, beside the first of its documents in path order, and the other is reported`.

### `folder-documents/attachment-written-once-report`

When a pull writes a file attached to documents in more than one directory of a folder, which no document there embeds and the folder's query does not hold, a device MUST report each of those documents outside the directory the file is written in, in `embeds` with the flag `attachment`.

**Tests:** `device/folders-frontmatter.test.ts › is written once, beside the first of its documents in path order, and the other is reported`.

### `folder-documents/attachment-unread-held`

If a pull's read of an item attached to a document the folder writes fails for a reason other than that the server does not hold the item, will not show it or ends the drain, then a device MUST write every other file of the pull.

**Reason:** One bad item stays contained: a server that answers one attachment with a conflict or an invalid request must not stop every later pull of the folder, and the files of every other item still reach the directory. A failure that ends the drain ends the pull instead, since it is no one item's: a refused credential, which ends the copy, a renewal of the credential that fails other than by an environmental failure, no sign-in or no keychain, a redirect, an answer naming another contract, a full store, an expired copy, a stream cut short, or a stopped run. An environmental failure leaves the item unread for the next pull.

**Tests:** `device/folders-frontmatter.test.ts › writes the other files, reports the attachment and asks for it again, when its read is %s`.

### `folder-documents/attachment-unread-reported`

If a pull does not write an attached item's file because the read of the item failed for a reason other than that the server does not hold it or will not show it, an environmental failure or one that ends the drain, then a device MUST report the document the item is attached to in `embeds` with the flag `attachment`, naming the item and the reason.

**Tests:** `device/folders-frontmatter.test.ts › writes the other files, reports the attachment and asks for it again, when its read is %s`.

### `folder-documents/attachment-unread-asked-again`

If a pull did not write an attached item's file because the read of the item failed, then a device MUST read the item again at the next pull.

**Reason:** A pull records an item it has read as held, and one it could not read is recorded as nothing, so it is not taken as done.

**Tests:** `device/folders-frontmatter.test.ts › writes the other files, reports the attachment and asks for it again, when its read is %s`.

### `folder-documents/attachment-embedded-once`

When a document comes to embed an attachment whose file is already written beside it, a device MUST keep that one file and write no second copy.

**Tests:** `device/folders-frontmatter.test.ts › is not written again once its document embeds it`.

### `folder-documents/attachment-edge-gone-kept`

When the last `attached-to` edge from a written attachment to a document in the folder is deleted, and the folder's query does not hold the attachment, a device MUST keep its file and count it `unmatched`.

**Tests:** `device/folders-frontmatter.test.ts › stays as a file the folder no longer holds when its edge is taken away elsewhere`, `› lists under has-attachment only what the body does not embed`.

### `folder-documents/attachment-departs`

When every document a written attachment is attached to is trashed or leaves the states held by the folder's query, and the query does not hold the attachment, a device MUST remove the attachment's file under the conditions of `folder-files/departed-file-removed`.

**Tests:** `device/folders-frontmatter.test.ts › leaves with its document, unless the query holds it on its own`, `› counts toward a large removal when it leaves with its document`.

### `folder-documents/attachment-member-stays`

When a document leaves a folder and the folder's query holds a file attached to it, a device MUST keep that file.

**Tests:** `device/folders-frontmatter.test.ts › leaves with its document, unless the query holds it on its own`.

### `folder-documents/attachment-deleted`

When a person deletes the file a pull wrote for an attachment, a device MUST trash the attachment's item once the rename grace (`folder-files/delete-grace`) ends.

**Tests:** `device/folders-frontmatter.test.ts › is trashed once its grace runs out when its file is deleted, and not written again`.

### `folder-documents/attachment-absent`

If a pull cannot fetch an attachment's bytes, then a device MUST report the attachment as `absent` and continue the pull.

**Tests:** `device/folders-frontmatter.test.ts › is reported absent where its bytes cannot be had, and the pass goes on`.
