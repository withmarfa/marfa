# Folder sync reports

## Reports and access

### `folder-status/report`

When an authenticated sign-in that can read a `system.folder` submits a valid report to `PUT /folders/{id}/status`, the server MUST answer `200` with `accepted`, the latest stored `sequence`, and its `received_at`.

**Tests:** `compliance/folder-status.test.ts › groups multiple copies under their canonical sign-ins and counts current observations`.

### `folder-status/read-only-report`

When a sign-in holding only read on `system.folder` submits a valid report to `PUT /folders/{id}/status`, the server MUST accept its own report.

**Tests:** `compliance/folder-status.test.ts › allows a read-only follower to report and hides a folder from a credential that cannot read it`.

### `folder-status/own-sign-in`

When a sign-in reports to `PUT /folders/{id}/status`, the server MUST attribute the report to the same canonical browser-session, app-grant, or API-key identity used by the sign-in listing.

**Tests:** `compliance/folder-status.test.ts › groups multiple copies under their canonical sign-ins and counts current observations`, `› uses the browser session identity and makes its reports historical after logout or expiry`, `› uses the app grant identity across token refresh and retains history after grant revocation`.

### `folder-status/copy-identity`

When reports name the same folder and sign-in, the server MUST retain the latest report separately for each opaque `folder_store_id`.

**Tests:** `compliance/folder-status.test.ts › groups multiple copies under their canonical sign-ins and counts current observations`.

### `folder-status/hidden-folder`

When an authenticated caller that reads some type cannot read the `system.folder` named by `GET /folders/{id}/status` or `PUT /folders/{id}/status`, the server MUST answer `404 item_not_found`.

**Tests:** `compliance/folder-status.test.ts › allows a read-only follower to report and hides a folder from a credential that cannot read it`.

### `folder-status/credential-required`

When an unauthenticated caller asks for `GET /folders/{id}/status`, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.

### `folder-status/invalid-id`

When `GET /folders/{id}/status` names a malformed folder ID, the server MUST answer `400 invalid_id`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.

### `folder-status/missing-folder`

When `PUT /folders/{id}/status` names an ID that is not a `system.folder`, the server MUST answer `404 item_not_found`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.

### `folder-status/missing-field`

When `PUT /folders/{id}/status` omits a required report field, the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.

### `folder-status/privacy`

If `PUT /folders/{id}/status` names undeclared fields, caller identities, file paths, content, item IDs, hashes, or raw problem messages, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`.

### `folder-status/problem-codes`

If a report to `PUT /folders/{id}/status` names a problem code outside `conflict`, `refused`, `credential_refused`, `unreadable`, `held_file`, `unavailable`, `root_gone`, and `settings_invalid`, or repeats a code, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`.

### `folder-status/number-bounds`

If `PUT /folders/{id}/status` names a sequence outside the integers from 1 through 9007199254740991, or a count outside the integers from 0 through 9007199254740991, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folder-status.test.ts › rejects caller identities, file details, unknown codes, and unsafe counts without changing the report`.

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

### `folder-status/current-totals`

When `GET /folders/{id}/status` returns totals, the server MUST sum only reports whose canonical sign-ins still stand.

**Reason:** current means that the canonical sign-in still stands, not that the copy is online, recently seen, or still able to read the folder. Counts are last reported observations and can overlap across copies.

**Tests:** `compliance/folder-status.test.ts › retains revoked and expired key reports immediately as history and excludes them from totals`.

### `folder-status/historical`

When an API key is revoked or expires, the server MUST retain its latest folder-copy reports as `current: false`.

**Tests:** `compliance/folder-status.test.ts › retains revoked and expired key reports immediately as history and excludes them from totals`.

### `folder-status/browser-historical`

When an owner browser session ends or expires, the server MUST retain its latest folder-copy reports as `current: false`.

**Tests:** `compliance/folder-status.test.ts › uses the browser session identity and makes its reports historical after logout or expiry`.

### `folder-status/app-token-expiry`

While an app grant still stands, the server MUST keep its folder-copy reports current independently of a short-lived access token's expiry.

**Tests:** `compliance/folder-status.test.ts › uses the app grant identity across token refresh and retains history after grant revocation`.

### `folder-status/app-historical`

When an app grant is revoked, the server MUST retain its latest folder-copy reports as `current: false`.

**Tests:** `compliance/folder-status.test.ts › uses the app grant identity across token refresh and retains history after grant revocation`.

### `folder-status/local-report`

When a private local command submits `PUT /folders/{id}/status`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/folder-status.test.ts › allows a local command to read but refuses a report without a sign-in`.

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

### `folder-status/schema-refusal`

When an instance database has a schema without the folder-status table required by this build, the server MUST refuse to open it without changing the stored database.

**Tests:** `compliance/folder-status.test.ts › refuses an old schema without adding a health table or altering its database`.

## Operational persistence

### `folder-status/portable-archive`

When the server exports a portable item archive, the server MUST exclude operational folder-copy reports from that archive.

**Tests:** `compliance/folder-status.test.ts › keeps witnessed reports outside portable item archives`.

### `folder-status/read-none`

When a credential that reads no type asks for `GET /folders/{id}/status` or `PUT /folders/{id}/status`, the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/folder-status.test.ts › answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals`.
