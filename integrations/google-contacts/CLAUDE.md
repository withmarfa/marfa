# google-contacts

Bidirectional sync between Google Contacts (People API) and Myme.
Third instance of the `google.*` publisher family. Schedule-only on
the inbound side because the People API does not publish a
`channels.watch` surface for the `connections` collection.

## Identity

- Manifest name: **`google.contacts`** (publisher `google`).
- Target types: `core.entity.person` AND `google.contacts.contact`.
  Default written type is `google.contacts.contact` (upstream
  fidelity); install-time configuration can switch to
  `core.entity.person` for cross-app interop, at the cost of dropping
  the per-channel email / phone / address arrays.

## OAuth scopes

One scope only, declared in `manifest.ts` as `RECOMMENDED_OAUTH_SCOPES`:

- `https://www.googleapis.com/auth/contacts` — read + write on the
  user's own `connections` collection.

`contacts.other.readonly` (the Other-Contacts collection — populated
by Google from inbound mail, etc.) is deliberately not requested. It's
a separate API surface that's read-only anyway and out of scope for
v1.

## People API specifics

Three operationally significant points the handler has to honour:

- **`syncToken` for incremental.** `people.connections.list?syncToken=...`
  returns mutations only. A `410` response means the token expired
  (typical at >7 days idle); handler resets the token and re-bootstraps
  with a full list on the next sweep.
- **`personFields` mask is mandatory on every read.** Pinned in the
  manifest as `PERSON_FIELDS` — names, nicknames, emails, phones,
  addresses, organisations, biographies, photos, birthdays, metadata.
- **etag-based optimistic concurrency on writes.** Every update PATCH
  carries the etag the handler last saw; stale etag returns 409, the
  handler refetches and reapplies once.

## Substrate gap — per-host `upstream_base_url`

[!] **People API is hosted at `people.googleapis.com`**, distinct from
Calendar / Tasks which live under `www.googleapis.com`. The current
substrate (`system.credential.upstream_base_url` is per-credential, not
per-call) does not support per-host overrides on a shared credential.
The integration ships expecting its connection's `credential_ref` to
point at a People-API-specific OAuth provider credential row —
`upstream_base_url: "https://people.googleapis.com"` — rather than
reusing the google.calendar / google.tasks shared row.

Operator setup (install-time):

1. `POST /credentials/oauth-provider` with the SAME Web client id +
   secret as the google.calendar shared credential, BUT with
   `upstream_base_url: "https://people.googleapis.com"` and
   `oauth_default_scope: "https://www.googleapis.com/auth/contacts"`.
2. Pass the resulting credential id as `credential_ref` on
   `POST /connections/install`.

A follow-on substrate ticket should add a per-connection
`upstream_base_url_override` on `connection.properties.configuration`
so the credential row truly can be shared across every google.\*
integration. That fix is out of T-237 scope.

## Configuration

Driven by `connection.properties.configuration`:

- `target_type: string` — `google.contacts.contact` (default) or
  `core.entity.person`.

No second-level scoping (Calendar's `selected_calendar_ids`, Tasks'
`selected_task_list_ids`) — every contact lives in the single
`connections` collection.

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  mappings: Record<resource_name, myme_id>,
  syncToken: string | null,
  last_inbound_at: string | null
}
```

`resource_name` is the People API id, format `people/c<digits>`.

## syncToken expiry → full re-list

When `connections.list` returns 410:

1. Drop the cached syncToken on the cursor.
2. Re-pass through the sweep loop with no syncToken (fresh full list).
3. The fresh list yields a new `nextSyncToken` that the next tick
   passes back for incremental.

The two-pass happens inside a single handler invocation — no
follow-up scheduled tick needed. The activity log emits
`syncToken-reset` so the operator can correlate.

## Idempotency-on-retry via clientData marker

People API does not accept a client-supplied id on `createContact`.
The retry-safe rail is a `clientData` entry:

```
clientData: [{ key: "myme-id", value: "<myme_item_id>" }]
```

`clientData` is a free-form per-person key/value list exposed in the
People app under "Connect with this contact" but unaffected by
normal user edits. On retry the handler scans `connections.list`
(bounded at 6 pages × 200 = 1200 contacts) for an existing person
carrying that marker before issuing a fresh insert. If found,
mapping is recorded without a duplicate; if not, fresh insert
proceeds.

## Tombstones

`connections.list` surfaces deletions as `metadata.deleted === true`.
Mapped Myme items transition to `trashed`; the mapping entry is
removed.

## Photo handling — reference only

`google.contacts.contact.photo_url` carries the People API photo URL
as a string. There is no blob ingest in v1 — the URL is enough for
display purposes and avoids R2 churn. T-238 (google.drive) is the
first integration to handle binary blobs end-to-end.

## Validation

The TS-harness validation log against the Oblix throwaway account
lives at the bottom of T-237 in the vault project. Use
`gog people --account oblix.cyzr@gmail.com --client oblix-gcp ...` /
`gog contacts ...` for data generation + read-back during validation.
