# google-tasks

Bidirectional sync between Google Tasks and Marfa. Second instance of
the `google.*` publisher family; shares the OAuth provider credential
established for `google.calendar` via `credential_ref`.

## Identity

- Manifest name: **`google.tasks`** (publisher `google`, identifier `tasks`).
- Target types: `core.task` AND `google.tasks.task`. The install
  pipeline grants the runtime credential write permission on both; the
  user picks at install which is actually written (default
  `google.tasks.task` for upstream fidelity; `core.task` for cross-app
  interop).

## OAuth scopes

One scope only, declared in `manifest.ts` as `RECOMMENDED_OAUTH_SCOPES`:

- `https://www.googleapis.com/auth/tasks` — read + write all task lists
  and tasks under the connected account.

Google does **not** publish a narrower read-write scope. `tasks.readonly`
would block outbound writes; there is no `tasks.write` scope.

## Tasks API differences from Calendar

Three operationally significant differences shape this integration:

- **No `syncToken`.** Calendar's `events.list` accepts an opaque
  `syncToken` that the next call passes back for incremental sync.
  Tasks' `tasks.list` does not — incremental is driven by
  `updatedMin` (ISO timestamp). The handler persists a per-task-list
  watermark and passes it on every poll.
- **No `channels.watch` / push notifications.** The Tasks API has no
  Pub/Sub surface for task changes. The 10-minute schedule trigger is
  the only inbound rail; there is no `webhook` trigger on the manifest
  and no webhook handler.
- **No client-supplied IDs on `tasks.insert`.** Calendar accepts a
  client `id` (T-020 deterministic-id idempotency). Tasks rejects it
  — Google assigns the id server-side. The idempotency rail here is a
  sentinel string injected into `notes`
  (`[marfa-id:<marfa_item_id>]`); on a handler retry the handler scans
  the target list for an existing task carrying the sentinel before
  issuing a fresh insert.

## Configuration

Driven by `connection.properties.configuration` (optional — sensible
defaults when absent):

- `selected_task_list_ids: string[]` — restrict inbound polling to
  this allowlist. Empty / unset → live discovery on every sweep via
  `tasklists.list` (cheap, capped to a few dozen lists per account).
- `default_write_task_list_id: string` — new outbound tasks land
  here. Default `@default` (the Tasks API's alias for the user's
  primary list).
- `target_type: string` — `google.tasks.task` (default) or
  `core.task`.

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  mappings: Record<task_id, marfa_id>,
  mapping_lists: Record<task_id, task_list_id>,
  per_list: Record<task_list_id, {
    updated_min: string | null,        // ISO timestamp
    last_inbound_at: string | null
  }>,
  last_inbound_at: string | null
}
```

`mapping_lists` is mandatory — every cursor carries it. Calendar's
`mapping_calendars` is the analog.

## Watermark advance

After each per-list sweep, the watermark advances to:

```
max(seen_updated) - WATERMARK_GUARD_MS
```

The one-second guard is the clock-skew window for the public API;
edits landing in the same millisecond as the boundary aren't missed
on the next sweep. On a sweep with zero tasks, the watermark stamps
`now - WATERMARK_GUARD_MS` so subsequent polls don't re-scan from
epoch.

## Idempotency-on-retry via sentinel

Outbound new-task POST injects `[marfa-id:<itemId>]` into `notes`. On
retry (handler crashes between Tasks insert and cursor write):

1. `findExistingByMarfaIdSentinel` scans the target list for an
   existing task whose notes contain the sentinel.
2. If found → record the mapping idempotently, no fresh insert.
3. If not found → fresh insert proceeds.

Bounded at 4 pages × 100 = 400 tasks before giving up; above
realistic personal task list cardinality. The strip on inbound
(`stripSentinel`) removes the marker line(s) so the round-trip
notes value matches what the user sees on the Tasks app.

## Tombstones

`showDeleted=true` is passed on every list call so deletions surface
as `task.deleted === true`. Mapped Marfa items transition to
`trashed`; the mapping entry is removed.

## Validation

Validate end-to-end against a throwaway Google test account: use
the Google Tasks API (via the Google Cloud client of your choice)
to generate data and read it back, then confirm items round-trip
through the integration.
