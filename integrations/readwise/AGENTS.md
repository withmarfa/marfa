# readwise

**This file is moving.** It goes with the integrations into their own
repository, and it hasn't yet been reviewed against decisions made since
it was written. Treat it as a record of how things worked here rather than
as current guidance, and use the move to review, correct, and tighten it
rather than carry it over unchanged.

Inbound-only sync of Readwise highlights + parent books. Uses the
token-credential install seam with a non-default `auth_scheme`.

## Identity

- Manifest name: **`readwise/highlights`** (publisher `readwise`,
  identifier `highlights`). The schema requires publisher-namespaced
  grammar; `readwise` alone would fail.
- Target types: `readwise.highlight` + `readwise.book` (one parent
  book per highlight, linked by `parent-of` edge).
- Direction: **`read`** — inbound only. The manifest declares no
  `item-event` trigger; the handler issues only GET requests against
  Readwise.

## Auth scheme — `Token`, not `Bearer`

Readwise's REST API requires `Authorization: Token <key>` and rejects
Bearer. The credential is minted via:

```
POST /credentials/api-token {
  label: "Readwise — <env>",
  upstream_base_url: "https://readwise.io",
  api_token: "<user-token>",
  auth_scheme: "Token"
}
```

The substrate reads `api_token_config.auth_scheme` at proxy
read-time and stamps the correct header. Default is `Bearer`; this
integration's install MUST pass `"Token"`.

## API choice — Export API only

Readwise has two parallel APIs:

- **Highlights API** (`/api/v2/highlights/`, `/api/v2/books/`) — slow,
  paginated per-resource. Not used.
- **Export API** (`/api/v2/export/`) — fast, returns books with their
  highlights nested in one response per page. **Used here.**

`updatedAfter` is the watermark; `pageCursor` is the pagination
primitive. Rate limit: 240 req/min per token (generous, but we
advance the cursor in batches).

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  updated_after: string,                         // ISO timestamp
  book_mappings: Record<user_book_id, marfa_id>,
  highlight_mappings: Record<highlight_id, marfa_id>,
  last_inbound_at: string | null
}
```

First-run `updated_after` is `"1970-01-01T00:00:00Z"` so the initial
sweep pulls everything. Subsequent runs advance the watermark to the
sweep's start time.

## Edges — parent-of book → highlight

Books are the parent; highlights are children. On highlight create,
the handler issues `POST /edges { source_id: bookMarfaId, target_id:
highlightMarfaId, edge_type: "parent-of" }`. The manifest grants
`parent-of: write` to the runtime credential.

The edge is only created on first write — subsequent updates to the
same highlight (when Readwise's `updated_at` advances) don't re-issue
the edge create.

## Read-only constraint

The handler issues only GET requests against Readwise. No DELETE, no
PUT, no POST. `tombstone_mapping: "ignore"` on the manifest means
Readwise-side deletes don't propagate to Marfa trash (the handler
skips `is_deleted: true` rows on inbound). The `system.activity`
summary line carries the literal string `"no destructive operations
performed against the live Readwise account"` for operator visibility.

If a future ticket adds outbound capability, that's a separate
manifest direction (`write` or `both`) + handler change.

## Reader vs Highlights

Readwise's **Reader** product is a separate API (`/reader_api/`) and
this integration does not consume it. A `readwise/reader` integration
under the same publisher is a follow-on if Reader access is needed.

## Validation

The harness at `_local/validate-readwise.ts` (gitignored) drives the
production handler against the user's real Readwise account using
only GET operations. Validation asserts: ≥1 book + ≥1 highlight land in Marfa; cursor
advances; second sweep is a near-no-op (only items genuinely updated
in the interval); `no destructive operations performed against the
live Readwise account` surfaces in the activity summary.
