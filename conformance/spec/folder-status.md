# Folder sync reports

## Reports and access

### `folder-status/report`

When an authenticated sign-in that can read a `system.folder` submits a valid report to `PUT /folders/{id}/status`, the server MUST answer `200` with `accepted`, the latest stored `sequence`, and its `received_at`.

**Reason:** the server stores and sums a report's counts and problem codes without judging them; what they mean is a device's to state, in `folders/report-pending-uploads`, `folders/report-pending-downloads`, `folders/report-paused-removals`, `folders/report-refused-files`, `folders/report-held-files` and the statements beside them.

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

If a report to `PUT /folders/{id}/status` names a problem code outside `conflict`, `refused`, `credential_refused`, `unreadable`, `held_file`, `unavailable`, `root_gone`, and `settings_invalid`, or repeats a code, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`, `› takes each of the eight problem codes once, and a sequence and counts at the largest whole number`.

### `folder-status/number-bounds`

If `PUT /folders/{id}/status` names a sequence outside the integers from 1 through 9007199254740991, or a count outside the integers from 0 through 9007199254740991, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`, `› takes each of the eight problem codes once, and a sequence and counts at the largest whole number`.

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

When the `revoked-key-reap` job removes a key, the server MUST remove that key's folder-copy reports.

**Reason:** a sign-in's reports are kept as history while its record is kept, and no longer; the reports of the other sign-ins stay.

**Tests:** `compliance/folder-status-retention.test.ts › removes a key's reports when the reap removes the key, and no other sign-in's`.

### `folder-status/app-reports-removed`

When the `revoked-grant-purge` job removes an app grant, the server MUST remove that grant's folder-copy reports.

**Tests:** `compliance/folder-status-retention.test.ts › removes an app grant's reports when the purge removes the grant`.

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

When a private local command asks for `GET /folders`, the server MUST return a page of active `system.folder` summaries, newest first, as `data` and `next_cursor`.

**Tests:** `compliance/folder-status.test.ts › lists active folder summaries for the local command with bounded pages, and refuses every other caller`, `› lists folders newest first under a trimmed, collapsed or placeholder title, and refuses an app's token`.

### `folder-status/inventory-summary`

When `GET /folders` returns a folder summary, the server MUST include only `id`, `title`, and `created_at`.

**Reason:** the command line lists folders without exposing folder settings or the content of items they hold. Reported copies are read through `GET /folders/{id}/status`.

**Tests:** `compliance/folder-status.test.ts › lists active folder summaries for the local command with bounded pages, and refuses every other caller`, `› lists folders newest first under a trimmed, collapsed or placeholder title, and refuses an app's token`.

### `folder-status/inventory-title`

When `GET /folders` returns a folder summary, the server MUST answer `title` as the stored title with surrounding whitespace removed and each inner run of whitespace collapsed to one space, or `Untitled folder` when no text is left.

**Tests:** `compliance/folder-status.test.ts › lists folders newest first under a trimmed, collapsed or placeholder title, and refuses an app's token`.

### `folder-status/inventory-limit`

When a private local command asks for `GET /folders`, the server MUST answer at most `limit` folders, 50 when `limit` is absent.

**Tests:** `compliance/folder-status.test.ts › pages the folder inventory 50 at a time unless a limit from 1 to 200 is named`.

### `folder-status/inventory-limit-range`

If a private local command names a `limit` that is not a whole number of 1 to 200 on `GET /folders`, then the server MUST answer `400 validation_error` naming `limit`.

**Reason:** a `limit` above 200 is refused here, where `search-and-filters/limit-listing-capped` caps one on `GET /items`.

**Tests:** `compliance/folder-status.test.ts › pages the folder inventory 50 at a time unless a limit from 1 to 200 is named`, `compliance/page-limits.test.ts › $door refuses a limit of 0, a negative and a non-number, naming limit`, `› $door takes its largest page and refuses a limit past it or a fraction`.

### `folder-status/inventory-cursor`

When a private local command sends back the `next_cursor` of a page of `GET /folders`, the server MUST answer the page that follows it, so that walking to the end delivers every active folder exactly once.

**Reason:** this is `search-and-filters/cursor-continues` and `search-and-filters/cursor-last-page` for this listing, whose page has the shape `search-and-filters/page-envelope` gives every list.

**Tests:** `compliance/folder-status.test.ts › pages the folder inventory 50 at a time unless a limit from 1 to 200 is named`.

### `folder-status/inventory-cursor-invalid`

If a private local command sends `GET /folders` a `cursor` that is malformed or that another ordering issued, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › pages the folder inventory 50 at a time unless a limit from 1 to 200 is named`.

### `folder-status/inventory-authority`

When an API key or delegated token asks for `GET /folders`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/folder-status.test.ts › lists active folder summaries for the local command with bounded pages, and refuses every other caller`, `› lists folders newest first under a trimmed, collapsed or placeholder title, and refuses an app's token`.

### `folder-status/inventory-authentication`

When an unauthenticated caller asks for `GET /folders`, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/folder-status.test.ts › lists active folder summaries for the local command with bounded pages, and refuses every other caller`.
