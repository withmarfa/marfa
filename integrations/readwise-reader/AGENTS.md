# readwise-reader

Bidirectional sync with Readwise Reader. Uses the token-credential
install seam with a non-default `auth_scheme`.

## Identity

- Manifest name: **`readwise.reader`** (publisher `readwise`,
  identifier `reader`).
- Target type: `readwise.document`, and only that. The item-event
  trigger delivers every item event in the space, so the type gate is
  the handler's job.
- Direction: **`both`**.

## Reader is not Readwise Highlights

The sibling `readwise` integration polls `/api/v2/export/` for
highlights and the books they came from. This one polls `/api/v3/list/`
for Reader documents. Different API version, different objects,
different rate buckets, and the only documented bridge between them is
`external_id` on a v2 book, which is set only for books that came from
Reader in the first place.

They share a publisher and can share one `api_token` credential, since
both live under `readwise.io`. Nothing else is shared, and neither can
be derived from the other.

## Auth scheme — `Token`, not `Bearer`

Readwise's API requires `Authorization: Token <key>` and rejects
Bearer. The credential is minted via:

```
POST /credentials/api-token {
  label: "Readwise Reader — <env>",
  upstream_base_url: "https://readwise.io",
  api_token: "<user-token>",
  auth_scheme: "Token"
}
```

## What gets mirrored, and what does not

Reader's list endpoint returns the whole library in one stream. Three
kinds of thing come back that this integration deliberately drops:

- **Highlights and notes**, which Reader models as documents carrying a
  `parent_id`. They are already mirrored as `readwise.highlight` by the
  sibling integration, so importing them here would give one underlying
  object two homes.
- **Feed items**, unless `include_feed` is configured on. A feed is a
  subscription firehose; in a real library it outnumbers saved
  documents by roughly ten to one, and mirroring it unasked buries
  everything the person actually saved.
- **Nothing else.** Every other parent document is in scope.

## Seven API behaviours that are not in the documentation

Each was established against a live account, and each changes the code.

- **Suppressing the HTML cleaner makes an author mandatory.** A save
  carrying `should_clean_html: false` is refused unless **both** `author`
  and `title` are present:

  ```
  400 The fields 'author' and 'title' are required when you don't use
      should_clean_html
  ```

  An author is optional on a Reader document and on this type, so the
  flag is never sent. Omitting it accepts a save with neither field.
  This one reached staging before it was caught, because the probe that
  established the fabricated-URL path happened to supply an author.

- **Re-saving a known URL is inert.** `POST /save/` on a URL Reader
  already holds returns **200** with the existing document id and
  mutates nothing — not the title, not the location, not the tags.
  Adopting an existing document is therefore save-then-update, and
  treating the save as a write would silently do nothing.
- **`PATCH /update/` returns `{id, url}` only**, not the updated
  document. The echo hash cannot come from the write response, so it
  comes from a read-back.
- **An unacceptable location is coerced, not refused.** Saving with
  `location: "shortlist"` returns **201** and stores `new`. There is no
  error to catch, so writes send a location only from the set Reader
  honours, and read back what actually landed.
- **`count` is what remains from the current cursor, not a total.** It
  decrements page by page. Reading it as a library size is correct only
  on the first page.
- **`DELETE` is permanent.** The document goes immediately, and saving
  the same URL afterwards mints a new id rather than restoring the old
  one. Restoring a trashed Marfa item therefore produces a _new_
  upstream document, which is intended and worth knowing.
- **`image_url` can hold an empty string.** Passing it through fails
  validation on the wrong field, so an empty value is treated as unset.

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  updated_after: string,                  // ISO watermark
  page_cursor: string | null,             // set while a sweep is parked
  doc_mappings: Record<reader_id, marfa_id>,
  last_inbound_at: string | null          // diagnostic
}
```

**The watermark only advances when a sweep reaches the end of the
stream.** Reads are the scarce budget — twenty requests a minute
against fifty for writes — so a sweep drains at most fifteen pages and
then parks its page cursor for the next tick. Advancing the watermark
on a parked sweep would permanently skip everything past the point it
stopped.

A 429 parks rather than retrying. A queue retry arrives inside the same
rate-limit window and spends the budget the next tick needs.

**The cursor is written after every page, not once at the end of the
drain.** This is the difference between a backfill that finishes and one
that does not, and it was learned the hard way. Against a library of
several thousand documents a sweep does not survive to the end of its
drain — it is killed partway — and a cursor written only after the loop
takes every page of progress down with it. The next sweep then restarts
from the last _completed_ sweep, so the import creeps forward a fraction
at a time and can appear to stall entirely.

**The watermark is the one thing the per-page checkpoint does not
move.** It advances only when a sweep both reached the end of the stream
and wrote every document it saw. A document that failed to write holds
it: stepping over that document strands it permanently, because nothing
fetches it again unless it changes upstream.

## Writes go a page at a time

The inbound sweep collects a page's in-scope documents and writes them
with a single `bulkUpsertItems` call rather than one request per
document. At six hundred documents and several seconds a write, a
request per document is more work than a sweep is allowed to do.

The batch is best-effort (`atomic: false`) on purpose. One malformed
upstream record should be reported on its own, not roll back the
ninety-nine documents beside it that were fine.

Resolution is the natural key `(source, source_id)`, with `source_id`
set to Reader's document id. The handler no longer consults its own
mapping table before writing, which is what makes a mapping lost to a
dying sweep harmless: the server resolves the document to the same item
either way, so a re-run updates rather than duplicating.

`doc_mappings` therefore serves the outbound path only — Marfa item id
back to Reader document id. It grows with the mirrored library, and at
roughly seventy bytes an entry a library in the low thousands is the
point at which its size wants revisiting.

## Outbound idempotency is the URL

Reader deduplicates saves on URL, which does the whole job Todoist
needs a deterministic `temp_id` and command uuid for: a redelivered
event saves the same URL and lands on the same document.

Items with no source of their own get
`https://marfa.invalid/items/<item_id>` — deterministic, so retries
agree, and non-resolvable by RFC 2606, so nothing can be fetched from
it and no real document can collide with it. Body HTML is supplied
alongside, because Reader would otherwise try to fetch a host that does
not exist and store an empty document.

That fabricated URL is not written back onto the Marfa item on the next
inbound sweep. It exists to satisfy Reader's dedupe, and putting a
deliberately unresolvable address in front of the person who created
the item would be worse than omitting it.

## Echo suppression, and why the lag window is not on the write path

`echo_ttl_seconds: 120`, `lag_window_seconds: 600`.

The outbound handler does **not** check `inLagWindow`. Deferring an
outbound write there loses it: the window is ten minutes, the queue
allows six retries, and the retries are exhausted long before the
window closes, so the message dead-letters with nothing surfaced to
anyone. Measured against a live account, a document trashed shortly
after being created was still present twenty minutes later.

The lag window is a read-side guard, and its contract in the runtime
SDK says so — it exists to stop an inbound sweep reading a stale
upstream and stomping an item that just changed. An outbound write
carries the item's current state, so applying it late is harmless and
applying it never is not. The inbound direction stays guarded by
`shouldSkipReactive`, which is a different call.

The hash covers the fields a round-trip can touch and is always
computed from a document **Reader returned**, never from one this code
composed. That is what makes the silent location coercion harmless: if
Reader rewrote the write, the hash records what Reader stored, and the
sweep that follows recognises it. Hashing the intended value instead
would leave the sweep seeing an unfamiliar document and writing the
item again, which is the loop echo suppression exists to stop.

## Upstream deletes are not detected

The v3 API exposes no deletion signal: nothing in the list response
marks a document deleted, no tombstone is returned, and the webhook
catalogue has no delete event. A document removed in Reader leaves its
Marfa mirror in place indefinitely.

`tombstone_mapping` is `ignore` because that is the truth. Detecting
upstream deletes needs a full sweep of every known id against a
twenty-per-minute budget, which is a different piece of work from
keeping a watermark.

## Configuration

- **`include_feed`** (boolean, default `false`) — mirror feed documents
  as well as saved ones.
