# google-contacts

**This file is moving.** It goes with the integrations into their own
repository, and it hasn't yet been reviewed against decisions made since
it was written. Treat it as a record of how things worked here rather than
as current guidance, and use the move to review, correct, and tighten it
rather than carry it over unchanged.

Bidirectional sync between Google Contacts (People API) and Marfa. In
the `google` namespace. Schedule-only on the inbound side because the
People API does not publish a `channels.watch` surface for the
`connections` collection.

## Identity

- Manifest name: **`google/contacts`** — namespace `google`, name
  `contacts`.
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

Three operationally significant points the handler has to honor:

- **`syncToken` for incremental.** `people.connections.list?syncToken=...`
  returns mutations only. A `410` response means the token expired
  (typical at >7 days idle); handler resets the token and re-bootstraps
  with a full list on the next sweep.
- **`personFields` mask is mandatory on every read.** Pinned in the
  manifest as `PERSON_FIELDS` — names, nicknames, emails, phones,
  addresses, organizations, biographies, photos, birthdays, metadata.
- **etag-based optimistic concurrency on writes.** Every update PATCH
  carries the etag the handler last saw; stale etag returns 409, the
  handler refetches and reapplies once.

## Per-connection upstream_base_url override

**People API is hosted at `people.googleapis.com`**, distinct from
Calendar / Tasks / Drive which live under `www.googleapis.com`. The
`connection.properties.configuration.upstream_base_url_override` field
is a per-connection knob the connection-proxy consults before falling
back to the credential's `upstream_base_url`. Multiple google.\*
integrations can share one OAuth credential row while targeting
different upstream hosts.

Operator setup (install-time):

1. Reuse the existing google.\* shared `system.credential` row via
   `credential_ref` on `POST /connections/install`. No second
   credential, no parallel OAuth dance.
2. Pass `configuration: { upstream_base_url_override: "https://people.googleapis.com" }`
   on the same install body. The proxy uses the override on every
   subsequent `POST /connections/:id/proxy/*` call.

Malformed overrides fail loud with `422 oauth_proxy_upstream_invalid`
rather than silently falling back — a misconfigured connection should
surface clearly.

## Configuration

Driven by `connection.properties.configuration`:

- `write_family: string` — `google` (default,
  `google.contacts.contact`) or `core` (`core.entity.person`), declared
  through the manifest's `write_families`.

No second-level scoping (Calendar's `selected_calendar_ids`, Tasks'
`selected_task_list_ids`) — every contact lives in the single
`connections` collection.

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  mappings: Record<resource_name, marfa_id>,
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
clientData: [{ key: "marfa-id", value: "<marfa_item_id>" }]
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
Mapped Marfa items transition to `trashed`; the mapping entry is
removed.

## Photo handling — reference only

`google.contacts.contact.photo_url` carries the People API photo URL
as a string. There is no blob ingest in v1 — the URL is enough for
display purposes and avoids R2 churn. The `google/drive` integration
is the first to handle binary blobs end-to-end.

## Validation

Validate end-to-end against a throwaway Google test account: use
the Google People / Contacts API (via the Google Cloud client of
your choice) to generate data and read it back, then confirm items
round-trip through the integration.
