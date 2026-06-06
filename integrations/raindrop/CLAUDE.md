# raindrop

Inbound-only sync of Raindrop bookmarks + collections. Uses the
token-credential install seam. Raindrop's REST API accepts
`Authorization: Bearer <key>` (the default `auth_scheme`), so no
`auth_scheme` override is needed at install time.

## Identity

- Manifest name: **`raindrop.bookmarks`** (publisher `raindrop`).
- Target types: `raindrop.raindrop` + `raindrop.collection`.
- Direction: `read` — inbound only.

## Token + scheme

Test Token from Raindrop's developer settings is the install
credential. Long-lived; no expiry. Raindrop's REST API accepts
`Authorization: Bearer <token>` for both Test Tokens and OAuth
tokens — the substrate's default scheme works.

If OAuth support is added, the client_id + client_secret can be folded
into a `kind: oauth_token` credential alongside the Test Token path.
For now, Test Token only.

## Sentinel ids

- Collection `0` = "all except trash" — used for the raindrops sweep
  (`GET /rest/v1/raindrops/0`).
- Collection `-1` = "unsorted" (default collection for new
  raindrops).
- Collection `-99` = "trash".

The integration polls every real collection via /collections + /collections/childrens, plus the raindrops sweep against id `0` for
content.

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  last_created_at: string | null,
  raindrop_mappings: Record<raindrop_id, marfa_id>,
  collection_mappings: Record<collection_id, marfa_id>,
  last_collection_sweep_at: string | null,
  last_inbound_at: string | null
}
```

`last_created_at` watermark is on `created`, not `lastUpdate` — the
upstream's `sort` only accepts `-created`, so edits to old items
aren't caught on subsequent sweeps. This is a known limitation; a
future pass can fold in a per-id `lastUpdate` check.

## Field renames

Two property names collide with Item's first-class wire fields and
are renamed in the type schema:

- Raindrop's `source` → not used (collections don't have it; raindrops
  use `domain` instead).
- Raindrop's `type` (enum: link/article/image/video/document/audio) →
  `raindrop_type` on `raindrop.raindrop`. The Item table's `type`
  column is the type identifier itself; can't be shadowed by a
  property.

## Edges — nested collections + raindrop → collection

Two edge patterns, both `parent-of`:

1. **Nested collection**: parent collection → child collection.
   Built in the collections-sweep second pass after all collection
   mappings are recorded.
2. **Raindrop → containing collection**: the collection is the
   parent. Built on first raindrop write.

Both flow through `ctx.marfa.createEdge`.
Duplicate edges return 409 / no-op from the substrate; the handler
swallows those silently.

## Non-destructive validation

The harness asserts:

- **Pre-flight invariant** — `GET /rest/v1/raindrops/0?search=#marfa-validation`
  returns zero items. Otherwise stale test data from a prior run
  exists and the harness aborts.
- **CREATE only against synthetic data** — a `Marfa Validation`
  collection + raindrops tagged `marfa-validation`. Every created id
  is recorded in a `DESTRUCTIVE_OK` allowlist (`Set<string>`).
- **DELETE gated** — every DELETE checks the id against the allowlist;
  any unrecognised id throws and aborts the run.
- **Read-only on existing data** — no PUT / PATCH / DELETE against
  raindrops or collections the harness didn't create.

The handler itself issues only GETs against Raindrop. The CREATE +
DELETE operations are confined to the harness's setup + teardown
phases and are clearly gated.
