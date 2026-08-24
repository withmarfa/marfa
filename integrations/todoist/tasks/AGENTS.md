# todoist

**This file is moving.** It goes with the integrations into their own
repository, and it hasn't yet been reviewed against decisions made since
it was written. Treat it as a record of how things worked here rather than
as current guidance, and use the move to review, correct, and tighten it
rather than carry it over unchanged.

Bidirectional sync between Todoist and Marfa. Uses the
**token-credential install seam** — no OAuth dance; the user's
Todoist API token is supplied at install via `POST /credentials/api-token`
and the proxy stamps it transparently.

## Identity

- Manifest name: **`todoist/tasks`** — namespace `todoist`, name
  `tasks`. The manifest schema enforces both segments, so a
  single-segment name like `todoist` fails validation. The namespace
  is the data this integration owns, which is what lets it declare
  `todoist.*` types; who wrote it is the separate `publisher` field.
- Target types: `core.task` AND `todoist.task`. The install pipeline
  grants the runtime credential write permission on both; new inbound
  items land as `todoist.task` by default for upstream fidelity.

## Token-credential install

```
POST /credentials/api-token
  { label, upstream_base_url: "https://api.todoist.com", api_token: "<user-token>" }
  → { credential_id }

POST /connections/install
  { integration_id, credential_ref: credential_id }
  → { connection_id }
```

The bearer is encrypted under the existing `connectionOauthToken` HKDF
domain (no new encryption-domain key). The proxy reads it at request
time and sets `Authorization: Bearer <token>` on every upstream call.
There is **no refresh** — on upstream 401 the proxy flips the
connection to `runtime_status: reauth_required` and emits a
`system.activity` of `action_required` reading "Static API token
rejected — reinstall connection with a fresh token".

## API choice — Sync API + REST

Two Todoist endpoints carry this integration:

- **Sync API (`POST /api/v1/sync`)** — incremental inbound + outbound
  creates. The `sync_token` field is a server-issued opaque watermark;
  sending `"*"` requests a full sync, the server's response value
  resumes incrementally on the next call.
- **REST API (`POST /api/v1/tasks/{id}`, `POST /api/v1/tasks/{id}/close`)** —
  outbound updates + closes (simpler than the equivalent Sync
  commands).

**Body encoding.** The Sync API takes
`application/x-www-form-urlencoded` request bodies with JSON-stringified
array values (`resource_types`, `commands`). The runtime-sdk's
`ConnectionClient.proxyRequestForm` does this directly; REST endpoints
use the standard JSON `proxyRequest`.

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  sync_token: string,                  // "*" sentinel on first run
  last_inbound_at: string | null,      // diagnostic
  mappings: Record<todoist_id, marfa_id>
}
```

## Deterministic temp_id + uuid idempotency

Outbound `item_add` commands carry two deterministic fields, both
derived from the Marfa item id:

- **`temp_id = SHA-256("marfa:temp_id:<marfa_item_id>")`** — the
  client-side placeholder Todoist resolves to a server-assigned id and
  returns in `temp_id_mapping`.
- **`uuid = SHA-256("marfa:command_uuid:<marfa_item_id>")`** —
  Todoist's per-command idempotency key. From the docs: "Todoist will
  not execute a command that has the same UUID as a previously
  executed command." Replays of the same command return the original
  result, including the same `temp_id_mapping`.

Result: a queue retry of the same outbound produces at most one
Todoist task per Marfa item id, regardless of how many retries fire.

## Description sentinel — belt-and-braces

The handler also injects `[marfa-id:<marfa_item_id>]` into the task's
`description` on outbound create. The deterministic uuid above is the
primary rail; the sentinel is a fallback for the rare case where a
Sync response is partially recoverable. On inbound, `stripSentinel`
removes the marker so the user sees clean task content.

## Echo suppression

`bidirectional_handling.echo_ttl_seconds: 120` — outbound writes are
remembered for 2 minutes. On inbound, `ctx.echo.shouldSkipReactive(id,
hash)` returns true for an item whose `(id, content_hash)` matches a
recent outbound — skipping prevents the obvious loop.

`lag_window_seconds: 600` — outbound writes within 10 minutes of a
recent same-id outbound are deferred with `retry=true` to avoid stomp
races.

## Webhooks — deferred

Todoist supports outbound webhooks (per-connection) but they require
a publicly-reachable URL. Out of scope for this round; the schedule
trigger is the only inbound rail. A future ticket can extend the
manifest with a `webhook` trigger + a verifier in
`@withmarfa/webhooks`.

## Validation

The local harness at `_local/validate-todoist.ts` drives the
production handler code against the real API for both directions.
