# Folder sync reports

## Reports and access

### `folder-status/report`

When an authenticated sign-in that can read a `system.folder` submits a valid report to `PUT /folders/{id}/status`, the server MUST answer `200` with `accepted`, the latest stored `sequence`, and its `received_at`.

**Reason:** the server stores and sums a report's counts and problem codes without judging them; what they mean is a device's to state, in `folder-sync/report-pending-uploads`, `folder-sync/report-pending-downloads`, `folder-sync/report-paused-removals`, `folder-sync/report-refused-files`, `folder-sync/report-held-files` and the statements beside them.

**Tests:** `compliance/folder-status.test.ts › groups multiple copies under their canonical sign-ins and counts current observations`.

### `folder-status/read-only-report`

When a sign-in holding only read on `system.folder` submits a valid report to `PUT /folders/{id}/status`, the server MUST accept its own report.

**Tests:** `compliance/folder-status.test.ts › allows a read-only follower to report and hides a folder from a credential that cannot read it`.

### `folder-status/own-sign-in`

When a sign-in reports to `PUT /folders/{id}/status`, the server MUST attribute the report to the same canonical app-grant or API-key identity used by the sign-in listing.

**Tests:** `compliance/folder-status.test.ts › groups multiple copies under their canonical sign-ins and counts current observations`, `› uses the app grant identity across token refresh and retains history after grant revocation`.

### `folder-status/copy-identity`

When reports name the same folder and sign-in, the server MUST retain the latest report separately for each opaque `folder_store_id`.

**Tests:** `compliance/folder-status.test.ts › groups multiple copies under their canonical sign-ins and counts current observations`.

### `folder-status/copy-limit`

When `PUT /folders/{id}/status` names a `folder_store_id` that the sign-in has no report for on that folder and the sign-in already holds 16 such reports, the server MUST, in the write that stores the new report, discard the sign-in's report for that folder with the oldest `received_at`, and the one with the greatest `folder_store_id` among reports with the same `received_at`.

**Reason:** a device that is reinstalled reports under a new copy ID, and a sign-in's oldest report is the one most likely to belong to a copy that no longer exists. The limit holds per sign-in and per folder, so another sign-in's reports and the same sign-in's reports on another folder do not count toward it.

**Tests:** `compliance/folder-status.test.ts › keeps 16 copies for each sign-in and folder, replacing the least recently reported copy with a 17th`, `› replaces, among copies reported at one instant, the one with the greatest copy ID`.

### `folder-status/copy-limit-held`

When `PUT /folders/{id}/status` names a `folder_store_id` that the sign-in already has a report for on that folder, the server MUST NOT discard any other report of that sign-in.

**Tests:** `compliance/folder-status.test.ts › keeps 16 copies for each sign-in and folder, replacing the least recently reported copy with a 17th`.

### `folder-status/hidden-folder`

When an authenticated caller that reads some type cannot read the `system.folder` named by `GET /folders/{id}/status` or `PUT /folders/{id}/status`, the server MUST answer `404 item_not_found`.

**Tests:** `compliance/folder-status.test.ts › allows a read-only follower to report and hides a folder from a credential that cannot read it`.

### `folder-status/credential-required`

When an unauthenticated caller asks for `GET /folders/{id}/status` or `PUT /folders/{id}/status`, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.

### `folder-status/invalid-id`

When `GET /folders/{id}/status`, or `PUT /folders/{id}/status` with a valid report, names a malformed folder ID, the server MUST answer `400 invalid_id`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.

### `folder-status/missing-folder`

When `GET /folders/{id}/status`, or `PUT /folders/{id}/status` with a valid report, names an ID that is not a `system.folder`, the server MUST answer `404 item_not_found` to a private local command and to a credential that reads some type.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`, `› answers item_not_found to a local command for an ID that holds no folder`.

### `folder-status/revoked-folder`

While a `system.folder` is `revoked`, the server MUST accept a valid report to `PUT /folders/{id}/status` from a sign-in that can read the folder.

**Reason:** a `system.*` item is `active` or `revoked` and never `trashed` (`items/system-lifecycle`), so this is the one state a folder leaves `active` for.

**Tests:** `compliance/folder-status.test.ts › keeps taking and answering reports for a revoked folder`.

### `folder-status/store-id-format`

If `PUT /folders/{id}/status` names a `folder_store_id` other than 1 through 128 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › takes a copy ID of 1 to 128 letters, digits, hyphens and underscores and refuses any other`.

### `folder-status/missing-field`

When `PUT /folders/{id}/status` omits a required report field, the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.

### `folder-status/privacy`

If `PUT /folders/{id}/status` names undeclared fields, caller identities, file paths, content, item IDs, hashes, or raw problem messages, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`.

### `folder-status/problem-codes`

If a report to `PUT /folders/{id}/status` names a problem code outside `conflict`, `refused`, `credential_refused`, `unreadable`, `held_file`, `unavailable`, `root_gone`, `settings_invalid`, `unwatched`, and `paused`, or repeats a code, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`, `› takes each of the ten problem codes once, and a sequence and counts at the largest whole number`.

### `folder-status/number-bounds`

If `PUT /folders/{id}/status` names a sequence outside the integers from 1 through 9007199254740991, or a count outside the integers from 0 through 9007199254740991, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`, `› takes each of the ten problem codes once, and a sequence and counts at the largest whole number`.

### `folder-status/last-success-time`

If `PUT /folders/{id}/status` names a `last_success_at` other than null or a real UTC instant with milliseconds in `YYYY-MM-DDTHH:mm:ss.sssZ` form, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`.

### `folder-status/retry-receipt`

When `PUT /folders/{id}/status` receives a sequence no greater than the stored sequence for the folder, sign-in, and copy, the server MUST answer `200` with `accepted: false`, the stored sequence, and the original receipt time.

**Tests:** `compliance/folder-status.test.ts › leaves newer reports and their receipt unchanged on equal and delayed retries`.

### `folder-status/retry-preserves`

When `PUT /folders/{id}/status` receives an equal or older sequence for the folder, sign-in, and copy, the server MUST leave the stored report unchanged.

**Tests:** `compliance/folder-status.test.ts › leaves newer reports and their receipt unchanged on equal and delayed retries`.

### `folder-status/replace`

When `PUT /folders/{id}/status` accepts a greater sequence for the folder, sign-in, and copy, the server MUST replace that copy's report with the supplied observations.

**Tests:** `compliance/folder-status.test.ts › leaves newer reports and their receipt unchanged on equal and delayed retries`.

### `folder-status/snapshot-standing`

When the server admits `GET /folders/{id}/status` or `PUT /folders/{id}/status` after the credential loses read access to the folder while retaining read on another type, the server MUST answer `404 item_not_found`.

**Tests:** `compliance/folder-status.test.ts › checks current folder read authority after writer admission`.

### `folder-status/read`

When an authenticated caller that can read a `system.folder` asks for `GET /folders/{id}/status`, the server MUST answer `200` with `folder_id`, reports grouped by canonical `sign_in`, each copy's receipt time and whole-second receipt age, and current totals.

**Reason:** `last_success_at` is the client's report of a fully successful sync; receipt time and age are measured by the server and do not establish online status or a complete live inventory.

**Tests:** `compliance/folder-status.test.ts › groups multiple copies under their canonical sign-ins and counts current observations`.

### `folder-status/sign-in-order`

When `GET /folders/{id}/status` answers, the server MUST order `sign_ins` by `sign_in.kind` as `app` then `key`, and within a kind by ascending `sign_in.id`.

**Tests:** `compliance/folder-status.test.ts › orders sign-ins by kind and ID and total problems as they first appear`.

### `folder-status/copy-order`

When `GET /folders/{id}/status` answers, the server MUST order each sign-in's `copies` by latest `received_at` first, and copies with the same `received_at` by ascending `folder_store_id`.

**Tests:** `compliance/folder-status.test.ts › orders copies by latest receipt, and copies received together by copy ID`.

### `folder-status/total-problem-order`

When `GET /folders/{id}/status` answers, the server MUST order `totals.problems` by where each code first appears among the `problems` of current sign-ins' copies, read in the order of `sign_ins` and `copies`.

**Tests:** `compliance/folder-status.test.ts › orders sign-ins by kind and ID and total problems as they first appear`.

### `folder-status/current-totals`

When `GET /folders/{id}/status` returns totals, the server MUST sum only reports whose canonical sign-ins still stand.

**Reason:** current means that the canonical sign-in still stands, not that the copy is online, recently seen, or still able to read the folder. Counts are last reported observations and can overlap across copies.

**Tests:** `compliance/folder-status.test.ts › retains revoked and expired key reports immediately as history and excludes them from totals`.

### `folder-status/historical`

While a revoked or expired API key's own record is kept, the server MUST retain its latest folder-copy reports as `current: false`.

**Tests:** `compliance/folder-status.test.ts › retains revoked and expired key reports immediately as history and excludes them from totals`.

### `folder-status/browser-session`

When a request to a folder operation carries an owner's browser session and no key or token, the server MUST answer `401 unauthorized`.

**Reason:** an owner's browser session reaches only the sign-in pages and their own posts. The owner reads and changes folders from the command line, by the private local command or by a key.

**Tests:** `compliance/folder-status.test.ts › ignores an owner's browser session on every folder door`.

### `folder-status/app-token-expiry`

While an app grant still stands, the server MUST keep its folder-copy reports current independently of a short-lived access token's expiry.

**Tests:** `compliance/folder-status.test.ts › uses the app grant identity across token refresh and retains history after grant revocation`.

### `folder-status/app-historical`

While a revoked app grant's own record is kept, the server MUST retain its latest folder-copy reports as `current: false`.

**Tests:** `compliance/folder-status.test.ts › uses the app grant identity across token refresh and retains history after grant revocation`.

### `folder-status/key-reports-removed`

When the `credential-cleanup` job removes a key, the server MUST remove that key's folder-copy reports.

**Reason:** a sign-in's reports are kept as history while its record is kept, and no longer; the reports of the other sign-ins stay.

**Tests:** `compliance/folder-status-retention.test.ts › removes a key's reports when the credential clean-up removes the key, and no other sign-in's`.

### `folder-status/app-reports-removed`

When the `credential-cleanup` job removes an app grant, the server MUST remove that grant's folder-copy reports.

**Tests:** `compliance/folder-status-retention.test.ts › removes an app grant's reports when the credential clean-up removes the grant`.

### `folder-status/local-report`

When a private local command submits a valid report to `PUT /folders/{id}/status` for a `system.folder`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/folder-status.test.ts › allows a local command to read but refuses a report without a sign-in`.

### `folder-status/local-report-order`

If a private local command's `PUT /folders/{id}/status` holds an invalid report, names a malformed ID, or names an ID that is not a `system.folder`, then the server MUST answer the `400` or `404 item_not_found` that refusal carries and not `403 forbidden`.

**Reason:** a local command learns a report or ID is wrong before it learns it has no sign-in to report under. The refusals are `folder-status/missing-field`, `folder-status/privacy`, `folder-status/invalid-id` and `folder-status/missing-folder`.

**Tests:** `compliance/folder-status.test.ts › refuses a local command's invalid report and missing folder before its lack of a sign-in`.

### `folder-status/local-read`

When a private local command asks for `GET /folders/{id}/status` on an existing folder, the server MUST answer `200` with its reports.

**Tests:** `compliance/folder-status.test.ts › allows a local command to read but refuses a report without a sign-in`.

### `folder-status/failed-report`

When a report replacement fails, the server MUST preserve the previous report and receipt time.

**Tests:** `compliance/folder-status.test.ts › rolls back a failed report replacement and preserves its previous receipt`.

### `folder-status/totals-bound`

When any aggregate count in `GET /folders/{id}/status` exceeds 9007199254740991, the server MUST cap that count at 9007199254740991 and return `totals.saturated: true`.

**Reason:** a capped total means at least the bound; per-copy counts remain exact.

**Tests:** `compliance/folder-status.test.ts › bounds aggregate totals without rounding a per-copy count`.

### `folder-status/physical-persistence`

When the instance restarts or is restored from a physical database backup, the server MUST retain the folder-copy reports and receipts held by that database image.

**Tests:** `compliance/folder-status.test.ts › retains reports through restart and restoring a physical database backup`.

## Operational persistence

### `folder-status/portable-archive`

When the server exports a portable item archive, the server MUST exclude operational folder-copy reports from that archive.

**Tests:** `compliance/folder-status-archive.test.ts › keeps witnessed reports outside portable item archives`.

### `folder-status/read-none`

When a credential that reads no type asks for `GET /folders/{id}/status` or `PUT /folders/{id}/status`, the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.

## Folder inventory

### `folder-status/inventory`

When a caller that reads `system.folder` asks for `GET /folders`, the server MUST return a page of active `system.folder` summaries, newest first, as `data` and `next_cursor`.

**Tests:** `compliance/folder-status.test.ts › lists active folder summaries with bounded pages, to the local command and a key that reads system.folder, and refuses a key that does not`, `› lists folders newest first under a trimmed, collapsed or placeholder title, to an app that reads system.folder too`.

### `folder-status/inventory-source-filter`

Where the source filter in force for a credential, its own or the instance's, names `system.folder`, when the credential asks for `GET /folders`, the server MUST list only the folders whose `source` the filter names, as `GET /items?type=system.folder` lists them.

**Tests:** `compliance/owner-tasks.test.ts › lists only the folders a credential's source filter admits, as the item listing does`.

### `folder-status/inventory-summary`

When `GET /folders` returns a folder summary, the server MUST include only `id`, `title`, and `created_at`.

**Reason:** the command line lists folders without exposing folder settings or the content of items they hold. Reported copies are read through `GET /folders/{id}/status`.

**Tests:** `compliance/folder-status.test.ts › lists active folder summaries with bounded pages, to the local command and a key that reads system.folder, and refuses a key that does not`, `› lists folders newest first under a trimmed, collapsed or placeholder title, to an app that reads system.folder too`.

### `folder-status/inventory-title`

When `GET /folders` returns a folder summary, the server MUST answer `title` as the stored title with surrounding whitespace removed and each inner run of whitespace collapsed to one space, or `Untitled folder` when no text is left.

**Tests:** `compliance/folder-status.test.ts › lists folders newest first under a trimmed, collapsed or placeholder title, to an app that reads system.folder too`.

### `folder-status/inventory-limit`

When a caller that reads `system.folder` asks for `GET /folders`, the server MUST answer at most `limit` folders, 50 when `limit` is absent.

**Tests:** `compliance/folder-status.test.ts › pages the folder inventory 50 at a time unless a limit from 1 to 200 is named`.

### `folder-status/inventory-limit-range`

If a caller that reads `system.folder` names a `limit` that is not a whole number of 1 to 200 on `GET /folders`, then the server MUST answer `400 validation_error` naming `limit`.

**Reason:** a `limit` above 200 is refused here, where `search-and-filters/limit-listing-capped` caps one on `GET /items`.

**Tests:** `compliance/folder-status.test.ts › pages the folder inventory 50 at a time unless a limit from 1 to 200 is named`, `compliance/page-limits.test.ts › $door refuses a limit of 0, a negative and a non-number, naming limit`, `› $door takes its largest page and refuses a limit past it or a fraction`.

### `folder-status/inventory-cursor`

When a caller that reads `system.folder` sends back the `next_cursor` of a page of `GET /folders`, the server MUST answer the page that follows it, so that walking to the end delivers every active folder exactly once.

**Reason:** this is `search-and-filters/cursor-continues` and `search-and-filters/cursor-last-page` for this listing, whose page has the shape `search-and-filters/page-envelope` gives every list.

**Tests:** `compliance/folder-status.test.ts › pages the folder inventory 50 at a time unless a limit from 1 to 200 is named`.

### `folder-status/inventory-cursor-invalid`

If a caller that reads `system.folder` sends `GET /folders` a `cursor` that is malformed or that another ordering issued, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › pages the folder inventory 50 at a time unless a limit from 1 to 200 is named`.

### `folder-status/inventory-authority`

If a credential that cannot read `system.folder` asks for `GET /folders`, then the server MUST answer `403 type_not_permitted`.

**Reason:** a folder summary is a `system.folder` item's title, so it is read as the item is.

**Tests:** `compliance/folder-status.test.ts › lists active folder summaries with bounded pages, to the local command and a key that reads system.folder, and refuses a key that does not`, `compliance/owner-tasks.test.ts › lists folders to a credential that reads system.folder, and refuses one that does not`.

### `folder-status/inventory-authentication`

When an unauthenticated caller asks for `GET /folders`, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/folder-status.test.ts › lists active folder summaries with bounded pages, to the local command and a key that reads system.folder, and refuses a key that does not`.

## Folder directories

### `folder-status/directories`

When a caller that reads `system.folder` and the `in-folder` edge type asks for `GET /folders/{id}/directories`, the server MUST answer `200` with `folder_id`, `under`, `direct_files`, `total_files`, `unreadable_placements` and `directories`, where each directory holds `path`, `direct_files`, `all_files` and `has_directories`.

**Reason:** a client shows a folder's directories and how many files each holds without reading every placed file. The answer names directories only, never a file.

**Tests:** `compliance/folder-directories.test.ts › lists the directories at a folder's top level with their direct and nested file counts and the folder's total`.

### `folder-status/directories-under`

When `GET /folders/{id}/directories` names `under`, the server MUST list the directories directly beneath that path, each as a path from the folder's root, and answer in `direct_files` the placed files directly at `under`.

**Reason:** the answer is one level of the tree, so a client opens a directory with one more request.

**Tests:** `compliance/folder-directories.test.ts › lists the directories directly under a path, and the files placed at the path itself`.

### `folder-status/directories-expand`

When `GET /folders/{id}/directories` lists a directory, the server MUST accept that directory's `path`, as listed, as `under`, and answer for it.

**Reason:** a client opens each directory with the `path` it was given. A stored path such as `./A:notes/a.md` places a directory called `A:notes`, and its name is only a name, not a drive.

**Tests:** `compliance/folder-directories.test.ts › expands every returned path as given`.

### `folder-status/directories-top`

When `GET /folders/{id}/directories` names no `under`, or an `under` that holds no name, the server MUST answer for the folder's top level, with `under` as the empty string.

**Tests:** `compliance/folder-directories.test.ts › reads a tidied under as a placement path is read, and answers the top level without one`.

### `folder-status/directories-tidy`

When `GET /folders/{id}/directories` names an `under` with a trailing slash, a repeated slash or a `.` name, the server MUST drop each empty and `.` name from it, answer for the path that is left, and give that path in `under`.

**Tests:** `compliance/folder-directories.test.ts › reads a tidied under as a placement path is read, and answers the top level without one`.

### `folder-status/directories-leaves`

If `GET /folders/{id}/directories` names an `under` that has a leading slash, a backslash, a `..` name or a NUL, that is over 1024 characters, or that is named twice, then the server MUST answer `400 validation_error` naming `under`.

**Reason:** no spelling of `under` reaches outside the folder. A first name that reads as a drive, such as `C:`, is a directory name and not refused (`folder-status/directories-expand`). Any other parameter is answered as every read answers it.

**Tests:** `compliance/folder-directories.test.ts › refuses an under that leaves the folder or is not a path`.

### `folder-status/directories-order`

When `GET /folders/{id}/directories` lists directories, the server MUST list them in the byte order of their paths.

**Tests:** `compliance/folder-directories.test.ts › lists the directories in the byte order of their paths`.

### `folder-status/directories-counts`

When `GET /folders/{id}/directories` lists a directory, the server MUST answer in `direct_files` the placed files whose path puts them directly in it, in `all_files` those in it and in every directory beneath it, and in `has_directories` whether any directory lies beneath it.

**Tests:** `compliance/folder-directories.test.ts › lists the directories at a folder's top level with their direct and nested file counts and the folder's total`, `› lists the directories directly under a path, and the files placed at the path itself`.

### `folder-status/directories-total`

When `GET /folders/{id}/directories` is answered, the server MUST answer in `total_files` every placed file the caller may count in the folder, whatever `under` is.

**Tests:** `compliance/folder-directories.test.ts › lists the directories directly under a path, and the files placed at the path itself`.

### `folder-status/directories-empty`

When `GET /folders/{id}/directories` names an `under` that no placed file lies at or beneath, the server MUST answer `200` with `direct_files` of `0` and no directories.

**Reason:** a folder keeps no list of its directories. A directory exists only while a file is placed in or beneath it, so a path with none is an empty one.

**Tests:** `compliance/folder-directories.test.ts › answers 200 and no directories for a path that holds no placed file`.

### `folder-status/directories-as-stored`

When `GET /folders/{id}/directories` matches a name, the server MUST match it as the placement stores it, with no Unicode normalization and no change of letter case.

**Reason:** the server can distinguish the names recorded on two placements even when a device's file system treats them as the same name.

**Tests:** `compliance/folder-directories.test.ts › matches names as stored, so Unicode forms and letter cases stay apart`.

### `folder-status/directories-archived`

When `GET /folders/{id}/directories` counts placed files, the server MUST count a file whose item is `archived`.

**Reason:** archiving an item can leave its placement in the folder. A device also applies the folder's query when deciding which files to write.

**Tests:** `compliance/folder-directories.test.ts › counts an archived item and leaves out an item in the bin`.

### `folder-status/directories-bin`

When `GET /folders/{id}/directories` counts placed files, the server MUST NOT count a file whose item is `trashed`.

**Reason:** a directory that only such files lie in is not listed, because a directory exists only while a counted file lies in or beneath it.

**Tests:** `compliance/folder-directories.test.ts › counts an archived item and leaves out an item in the bin`.

### `folder-status/directories-revoked`

While a `system.folder` is `revoked`, the server MUST answer `GET /folders/{id}/directories` from the placements the folder kept (`edges/folder-revoked-keeps`).

**Tests:** `compliance/folder-directories.test.ts › keeps answering for a revoked folder`.

### `folder-status/directories-reach`

When a credential asks for `GET /folders/{id}/directories`, the server MUST count only the placed files whose type and `source` the credential may read, as an edge listing for the credential lists only those edges (`edges/read-list-withheld`, `edges/read-source-filter`).

**Reason:** a count of the files a credential may not read would tell it that they exist.

**Tests:** `compliance/folder-directories.test.ts › counts only the files whose type and source the credential reads`.

### `folder-status/directories-edge-access`

If a credential that cannot read the `in-folder` edge type asks for `GET /folders/{id}/directories` on an existing folder it can read, then the server MUST answer `403 edge_type_not_permitted` naming `in-folder`.

**Reason:** the counts come from the folder's `in-folder` edges. `GET /folders/{id}/status` reads no edge and needs no such permission. The folder is judged first, so the same credential asking for a missing or unreadable folder gets `404 item_not_found` (`folder-status/directories-missing`, `folder-status/directories-hidden`) and learns nothing from the edge refusal.

**Tests:** `compliance/folder-directories.test.ts › refuses a key that cannot read the in-folder edge type`.

### `folder-status/directories-stored-path`

When `GET /folders/{id}/directories` counts a placed file, the server MUST read the `path` of its `in-folder` edge with each empty and `.` name dropped, the last name left being the file's, so that the file counts where a device places it (`folder-files/placement-path`).

**Reason:** an edge stores the `path` it was sent, such as `a//b.md` or `./c.md`, and a device places each at the tidy path.

**Tests:** `compliance/folder-directories.test.ts › counts a stored path with empty or dot names where a device places it`.

### `folder-status/directories-stored-path-text`

If the `path` of an `in-folder` edge is not a string, or is a string that a write of the edge would refuse, then the server MUST leave that edge out of `direct_files`, `total_files` and every directory it lists.

**Reason:** a write refuses a `path` that holds no name once its empty and `.` names are dropped, starts with `/`, holds a backslash or NUL, holds a `..` name, starts with a drive letter and a colon, or is over 1024 characters. A stored one is damaged and places no file. Were it listed, a client could be given a path, such as `..`, that `folder-status/directories-expand` and `folder-status/directories-leaves` refuse, and no other placement is lost by leaving it out.

**Tests:** `compliance/folder-directories.test.ts › leaves out a stored path that a write would refuse, and reports how many`.

### `folder-status/directories-unreadable`

When `GET /folders/{id}/directories` is answered, the server MUST answer in `unreadable_placements` the number of `in-folder` edges that `folder-status/directories-stored-path-text` leaves out, whose placed item the caller can read and is not in the bin, whatever `under` is, and `0` when there is none.

**Reason:** a caller learns that some files are not counted, so it need not trust a total that is quietly short. The number names no file or path, and it counts no placement of an item the caller cannot read, so it tells the caller nothing hidden.

**Tests:** `compliance/folder-directories.test.ts › leaves out a stored path that a write would refuse, and reports how many`, `› reports only the damaged placements the credential may read and leaves out those in the bin`.

### `folder-status/directories-credential`

When an unauthenticated caller asks for `GET /folders/{id}/directories`, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/folder-directories.test.ts › refuses as the status read refuses`.

### `folder-status/directories-invalid-id`

When `GET /folders/{id}/directories` names a malformed folder ID, the server MUST answer `400 invalid_id`.

**Tests:** `compliance/folder-directories.test.ts › refuses as the status read refuses`.

### `folder-status/directories-missing`

When `GET /folders/{id}/directories` names an ID that is not a `system.folder`, the server MUST answer `404 item_not_found`.

**Tests:** `compliance/folder-directories.test.ts › refuses as the status read refuses`.

### `folder-status/directories-hidden`

When a caller that reads some type cannot read the `system.folder` named by `GET /folders/{id}/directories`, the server MUST answer `404 item_not_found`, as `folder-status/hidden-folder` does for the status read.

**Reason:** a folder is not revealed to a caller that cannot read it.

**Tests:** `compliance/folder-directories.test.ts › refuses as the status read refuses`.

### `folder-status/directories-read-none`

When a credential that reads no type asks for `GET /folders/{id}/directories`, the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/folder-directories.test.ts › refuses as the status read refuses`.

### `folder-status/directories-local`

When a private local command asks for `GET /folders/{id}/directories`, the server MUST count every placed file of the folder that the instance's source filter admits, and apply no credential's type or source limits.

**Reason:** the private local command is the owner's, so it reads past any key's limits. The instance's source filter (`enforcement.source_filter`) holds for it as for every read, so a note the filter leaves out is not counted, as `items/owner-trash-source-filter` leaves it out of the bin.

**Tests:** `compliance/folder-directories.test.ts › reads the whole folder for the private local command`, `› applies the instance's source filter to the private local command`.
