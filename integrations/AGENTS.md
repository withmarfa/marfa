# integrations/

**This file is moving.** It goes with the integrations into their own repository, and it hasn't yet been reviewed against decisions made since it was written. Treat it as a record of how things worked here rather than as current guidance, and use the move to review, correct, and tighten it rather than carry it over unchanged.

Per-integration packages implementing the manifest contract from `@withmarfa/shared/integration-manifest.ts`. Each `<handle>/<name>` directory is a self-contained npm workspace, nested so the directory mirrors the manifest identifier; the runtime substrate loads them through the patterns below.

## Manifest contract

- **Every integration ships `src/manifest.ts`** exporting an `IntegrationManifest`. Sibling `src/manifest.test.ts` parses it through `IntegrationManifestSchema` so drift is caught at build time, not first install.
- **Schema source of truth** lives in `packages/shared/src/integration-manifest.ts`; valid fields are documented there in narrative comments.
- **`name` is `<handle>/<name>`** — dots name data, the slash names an installable, so an integration can never be mistaken for a type. Integrations from one upstream share a handle (`google/calendar`, `google/tasks`) and so reuse one OAuth credential. The platform's own live under `marfa/`. **The directory is the same two levels**, so the identifier is stated by the tree rather than merely habitual, and two publishers can each ship a `podcasts` without colliding.

## Handler shape

Three handler types, all imported from `@withmarfa/runtime-sdk`:

- **`registerScheduleHandler(handler)`** — invoked on the manifest's cron.
- **`registerItemEventHandler(handler)`** — invoked reactively on Marfa item events of the manifest's `target_types`.
- **`registerWebhookHandler(handler)`** — invoked on an inbound webhook to the connection's subscription URL, after the verification adapter passes.

All handlers receive a `ConnectionContext` first arg:

- **`ctx.marfa`** — connection-scoped client (stamps cycle metadata).
- **`ctx.cursor`** — per-connection state store (the `connection.runtime` reserved extension namespace under the hood).
- **`ctx.activity`** — typed emitter for `system.activity` rows. Severity `info` for steady-state, `action_required` for operator-resolvable issues, `error` for unrecoverable failures.
- **`ctx.echo`** — echo-suppression and lag-window helpers. Outbound writes go through `ctx.echo.trackOutboundWrite(external_id, hash)`; inbound reads check `ctx.echo.shouldSkipReactive(...)` before upserting to avoid echo loops.
- **`ctx.cycle`** — cycle-detection metadata for the request chain (`originating_connection_id`, `hop_count`). The reactive bridge filters self-events upstream, but defensive double-checking is expected.

Handler results: `{ ok: true }` for success, `{ ok: false, retry: boolean, reason: string }` for failure. `retry: true` reschedules via queue retry; `retry: false` acks but emits an `action_required` activity row.

### A run that changed nothing does not write a row

Every activity row is an item write: a transaction, a quota reservation, an index update and a published event. So the rule is that a run reports what it did, and a run that did nothing reports nothing.

- **A run that changed something always reports**, whatever triggered it.
- **A run that changed nothing reports only on a schedule trigger.** One row a day is a heartbeat a person can read. One row per upstream write is not, and an item-event trigger fires at whatever rate the space produces events.
- **Failures report where they happen**, separately from the summary, so a run that half worked says which half. A `catch` that falls back to a default without saying so is the shape this rule exists against: the run looks ordinary and behaves differently.
- **Liveness does not need a row.** The supervisor stamps a sync-success timestamp on the connection for schedule and manual dispatches, and the cursor records the run for any integration that keeps one. A webhook dispatch gets no stamp, so a webhook-only integration's run record is whatever it writes to its own cursor: `github-webhooks` keeps a delivery ring and writes it on every handled delivery, which is the pattern.

This is a convention rather than something the runtime enforces, and it exists because per-author discipline is what failed: one integration emitting on every reactive no-op accounted for 88% of every activity row on production, and retention only bounds how many exist at once rather than how many get written.

The in-tree fleet does not all follow it yet. Several inbound sweeps end with an unconditional counts row, and three webhook handlers report deliveries that built nothing, which is the closer match to the case above because a webhook fires per upstream write. Those are being corrected separately; the rule is what a new integration follows.

## Bidirectional handling

The manifest's `bidirectional_handling` block declares four primitives the substrate enforces, not the handler:

- **`echo_ttl_seconds`** — how long an outbound write counts as an "own write" for echo suppression.
- **`lag_window_seconds`** — how long after an outbound write to defer inbound reads of the same external id (stomp-race guard).
- **`tombstone_mapping`** — `state-trashed` (cascading external delete to Marfa trash), `prompt-user` (action_required activity), or `ignore`.
- **`partial_write_mode`** — `all-or-nothing` rolls back local optimism on any per-item failure; `accept-partial` commits what succeeded.

Handler code reads from `ctx.echo` (TTL + lag window) and from config; it does not re-implement these primitives.

## OAuth-backed integrations

Manifest declares `oauth_requirements: { <capability>: "proxy" | "leased" }`. Tokens bootstrap via the server's provider-agnostic `GET /oauth/callback` route, one fixed URL per deployment that every upstream registers; the handler never sees them. To call upstream, use `ctx.marfa.proxyRequest(method, path, body)` against the connection's proxy URL; the server stamps the bearer transparently and refreshes on 401.

To install:

1. Admin creates a `system.credential` of `kind: oauth_token` carrying the OAuth client config (authorize URL, token URL, client_id, encrypted client_secret) via `POST /credentials/oauth-provider`.
2. Install passes the credential id via `credential_ref` on `POST /connections/install`; multiple integrations of the same upstream share the credential row.
3. After install, `POST /connections/:id/oauth/start` returns the authorize URL to open in a browser, along with the redirect URI it sent, which is the value to register with the provider.
4. The provider's redirect lands on `/oauth/callback`, exchanges the code, and persists tokens encrypted under `SECRET_INFO.connectionOauthToken`.

## Token-backed integrations

Manifests whose upstream uses a static API token rather than an OAuth flow declare `token_requirements: { <capability>: "required" }` and bump `manifest_schema_version` to `1.1.0`. Current instances: Todoist, Readwise, Readwise Reader, Raindrop. Every API-key-based upstream lands here.

The substrate seam mirrors the OAuth one: the bearer lives on a `system.credential` row, referenced from the connection via `credential_ref`. Both kinds share the encryption domain (`connectionOauthToken`), the install path (`POST /connections/install`), and the proxy entry point (`POST /connections/:id/proxy/*`). Differences:

- **Credential kind** — `kind: "api_token"` instead of `kind: "oauth_token"`. Non-secret config lives under `api_token_config: { upstream_base_url }` (parallel to `oauth_provider_config`); the bearer lives under `secret_encrypted`.
- **Install path** — `POST /credentials/api-token` (body `{ label, upstream_base_url, api_token }`) instead of `/credentials/oauth-provider`. Same `requireSpaceAdmin` gate. Returns `{ credential_id }` for use as `credential_ref` on `POST /connections/install`.
- **No OAuth dance** — no authorize URL, no callback. The user supplies the bearer at install time; the connection is immediately usable.
- **Bearer stamped verbatim** — `ctx.marfa.proxyRequest(...)` reads the credential, decrypts the bearer, and sets `Authorization: Bearer <token>` on every upstream call. No proactive or reactive refresh.
- **401 to `action_required`** — when the upstream rejects the bearer, the proxy flips `runtime_status` to `reauth_required` and emits a `system.activity` of `severity: action_required` reading "Static API token rejected — reinstall connection with a fresh token". Static tokens have no refresh primitive; operator recovery is to mint a fresh credential via `POST /credentials/api-token` and reinstall.

To install end-to-end:

1. Admin calls `POST /credentials/api-token` with the upstream base URL and user-supplied bearer, returning `{ credential_id }`.
2. Admin calls `POST /connections/install` with `{ integration_id, credential_ref: credential_id }`, returning `{ connection_id }`. The connection is immediately active; no consent step.
3. Subsequent scheduled / reactive runs call `ctx.marfa.proxyRequest(...)`; the server stamps the bearer transparently.

## Runtime contract

Integrations run in-process on the server's integration runtime (Node + pg-boss + `worker_threads`; Postgres required). The runtime loads every integration that ships a built handler entry; there is one runtime, so there is nothing to declare compatibility with. An integration without a handler entry declares a surface a connection can install against and nothing to dispatch into, so the catalog carries it and the runtime skips it. **Something whose code has to run elsewhere is a client rather than an integration and does not belong in this directory at all** — its manifest lives in `packages/` and ships with the server build. Build invariants:

- **The handler entry is `src/local.ts` and the built entry is `dist/local.js`.** Both halves are the convention rather than a preference: the image build pairs them to catch an integration whose source is present and whose output is missing, and the suite reads the source half to decide whether an integration ships a handler at all. Emitting `dist/local.js` from a differently named source satisfies neither reader, and the two then disagree about what the integration is.
- `tsup.config.ts` emits `dist/local.js`, which the server's supervisor loads at boot.
- `@cloudflare/workers-types` remains a types-only devDependency: handler code types upstream responses through its generic `json<T>()` fetch typings. Nothing Cloudflare-specific runs; the runtime is Node.
- `@withmarfa/runtime-sdk` and `@withmarfa/shared` MUST stay external in every bundle that loads integrations alongside them; the handler `REGISTRY` and shared registries are module-singleton state.
- `pnpm --filter @withmarfa/server run smoke:worker-entry` guards both invariants at build time.

## In-tree integrations

**The server does not read this list, and it does not read any list.** It reads the directory: every `<handle>/<name>` directory holding a built entry and a valid manifest is an integration, and anything else is skipped with a reason. A directory prefixed with `.` or `_` is scaffolding and is skipped before that, at either level, which is why `_template` sits flat where a handle would go and never ships.

So this is documentation rather than a source of truth, kept because the one-line descriptions are the part a directory scan cannot produce. **It is checked against the directory**, so a new integration nobody wrote a line for fails the suite, and so does a bullet for something that no longer exists.

**What the hosted container image ships is a separate list, and that one is real.** `packages/server/installed-integrations.txt` declares which integrations the image installs into the runtime's directory, so a new integration is added there as well as here, with the marker `manifest-only` if it ships no handler. It changes nothing about how the runtime finds them, which has always been a directory read; it decides what the image puts in that directory. In this repository the two are held equal by the suite, so the declaration cannot yet ship fewer integrations than the tree holds. What it buys today is that the set is stated somewhere a person edits, rather than being whatever the build happened to find.

- **`_template`** — scaffold to copy when starting a new integration.
- **`google/calendar`** — bidirectional OAuth sync of events, to `google.calendar.event` or `core.event` depending on the family the connection selects.
- **`google/contacts`** — bidirectional OAuth sync to `google.contacts.contact`.
- **`google/drive`** — inbound OAuth sync to `google.drive.file`.
- **`google/tasks`** — bidirectional OAuth sync to `google.tasks.task`.
- **`google/youtube`** — inbound OAuth sync of channels, playlists and videos.
- **`marfa/github-webhooks`** — inbound webhook on a repo to `core.bookmark`.
- **`marfa/inbox`** — email capture via Cloudflare Email Routing.
- **`marfa/podcasts`** — scheduled poll of podcast RSS feeds to `marfa.podcast.show` and `marfa.podcast.episode`, joined by `in-collection` edges, or to `core.media.series` and `core.media.episode` when a connection selects the core family.
- **`marfa/rss-watcher`** — scheduled poll of a feed to `core.bookmark`.
- **`marfa/task-auto-archive`** — item-event automation on `core.task` items.
- **`raindrop/bookmarks`** — inbound token sync of bookmarks and collections.
- **`readwise/highlights`** — inbound token sync of highlights and their parent books, over the v2 export API.
- **`readwise/reader`** — bidirectional token sync of Reader documents, over the separate v3 documents API.
- **`todoist/tasks`** — bidirectional token sync over Todoist's Sync and REST APIs.

Per-integration `AGENTS.md` files (where present) carry upstream-specific gotchas: scope choices, dedup quirks, recurrence handling, channel renewal patterns.
