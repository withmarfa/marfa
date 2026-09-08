# @withmarfa/server

The Hono HTTP server exposing the Marfa API. Private package, never published; deployments build from source.

**This file carries what fails silently.** A change that breaks something loudly is caught by the type checker, a test or a failing boot, and needs no note here. What follows is the set of invariants whose violation looks like success: a green health check over a broken instance, a passing suite that never ran, a query that quietly widens past a space. The layout, the routes, the request context and the environment are all readable from the code and the docs site, and are deliberately not restated.

## Schema changes

Migrations are hand-written SQL plus a journal entry. There is no generator: the runtime migrator reads `meta/_journal.json` and the `.sql` files and nothing else.

1. Edit the Drizzle schema (`storage/{pg,sqlite}/schema.ts`) so the ORM matches what the migration creates.
2. Write `drizzle/{pg,sqlite}/NNNN_short_slug.sql`, numbered one past the latest journal entry. Prefer a lossless ALTER, UPDATE, ALTER over DROP and ADD.
3. Add the journal entry: copy the previous entry's shape, bump `idx`, stamp `when` with current epoch millis.
4. Regenerate the bootstrap blocks with `pnpm --filter @withmarfa/server run schema-sql:generate` (the Postgres half needs Docker).
5. Run `pnpm test:fresh-sqlite` and `pnpm test:pg`.

Three silent failures live in that procedure.

- **`when` is the only field the migrator reads, and it compares against a high-water mark rather than a set.** An entry stamped at or below any stamp before it is skipped permanently on every database that already ran that one, while passing every fresh-database job, because an empty database has nothing to compare against. Two migration-bearing branches open at once is the shape that produces it, and renumbering during a rebase does not fix it: re-stamp `when` before merging the second. `storage/migration-journal-order.test.ts` is the guard, and it is a test rather than a workflow because a fresh migrate is green under any ordering at all.
- **SQLite's migrator silently drops statements after the first `;` without `--> statement-breakpoint`.** The `sqlite-migrations-lint` job catches it.
- **Never hand-edit a `schema-sql.generated.ts`.** The next regen overwrites it; the freshness job catches the drift.

**Migrate-then-deploy.** The server does not migrate on boot; the deploy applies migrations before the stack rolls. When a change needs ordering thought, the tolerant side ships first and the tolerant side is always the code: a migration lands in one step and holds no opinion about what it meets. Tightening a constraint means the code stops producing violating rows in an earlier deploy; a shape the running build cannot read means expand and contract.

## Routes

- **Every new route ships a sibling `*.test.ts`** covering at minimum the auth gate and the happy path.
- **The OpenAPI spec is generated, never hand-edited.** `openapi-published.ts` reflects `createApp` once per `AUTH_MODE` and unions the documents, because a route group mounted under one mode is invisible to a single-mode reflection. Adding a mode fails to compile until it is listed in `AUTH_MODE_COVERAGE`.
- **`GET /events` is the exception and it is a trap.** SSE cannot be described by `createRoute`, so its OpenAPI entry is hand-written in `EXTRA_PATHS` in `openapi-finalize.ts`. Nothing regenerates it and the freshness job compares against a generator that will happily reproduce a stale entry forever, so a change to what the stream sends changes that block too.

## Authorization

Every credential, key or sign-in alike, carries one permission set: the content maps plus the space permissions. **No door admits on who the caller is.** Data doors check content permissions, space doors check space permissions, and a credential's set can never exceed its creator's set at the moment of creation. The model and its reasoning are in the vault; what belongs here is what goes wrong.

- **One invariant bounds every minting path**, stated once in `auth/mint-ceiling.ts`: no path may issue a credential whose authority exceeds, on any axis, the authority that authorized the mint. `routes/credential-mint-doors.test.ts` fails when a new way of asking appears without a door row or a named exclusion. Add a door, add a row.
- **A space-less credential is not a narrow one, it is the operator tier.** The RLS wrapper skips a space-less caller and the storage layer drops its space predicate, so anything that mints without naming a space yields a credential that reads every space. `assertMintableSpaceScope` refuses at the mint and again at install, gated on `authMode` because nothing carries a space in `keys` mode.
- **Space-scoped lookups must stay fenced, and the fence is not transitive.** A bare `items.get(id)` against a space-scoped type silently widens to "any space". Thread the caller's `space_id` into every downstream call, even when an upstream lookup already established it.
- **Platform-scoped catalog reads opt in, and pair the widening with a type check.** `includePlatformScoped: true` flips the clause from `space_id = $spaceId` to `(space_id = $spaceId OR space_id IS NULL)`; the type check on the result (`item?.type === "system.<expected>"`) is the authoritative gate and the widening is only the lookup mechanic. Never widen by default. This is a rule rather than a roster: enumerating the call sites rotted once already.

## Postgres RLS

Defense in depth beneath the application-layer space scoping, on by default (`MARFA_RLS_ENFORCE`), skipped entirely on SQLite. The per-request middleware wraps each space-bounded request in a transaction that sets the role and the space GUC; the migrations carry the policies. Two things are load-bearing and neither is visible in the policy DDL.

- **Plain `ENABLE`, never `FORCE`.** The sign-up provisioning hook and the bearer middleware both touch `users` on the unwrapped owner connection with no space GUC set, and `FORCE` would policy-check them against an empty GUC and strand every new sign-up. Plain `ENABLE` keeps the owner exempt.
- **Two tables are deliberately unpoliced and one is deliberately excluded.** `settings` is genuinely instance-scoped with no space key. `oauth_device_codes` has no space link before consent, so a policy would hide pending codes and break the device flow. `rate_limit_windows` has no space column and is accessed pre-RLS. `storage/pg/rls-ungated-tables.test.ts` is the regression guard, and its job is to make a future table's omission deliberate.

## Streaming, pooling and locks

The failures in this area share one shape: the wrong connection, from the wrong pool, on the wrong endpoint, producing a symptom somewhere else entirely.

- **A lock's connection must come from a pool the locked work never queries**, whatever the endpoint topology. Violating it deadlocks at exactly pool size rather than under load, so it passes every test that does not exceed the pool.
- **Session-level state needs a real session, which a transaction-mode pooler is not.** `SET ROLE` issued outside a transaction lands on whichever backend served that statement and is inherited by later, unrelated queries; the matching reset need not reach the same backend. So streaming RLS reserves from a direct endpoint, and advisory locks take the transaction-scoped form (`pg_advisory_xact_lock`) rather than the session-scoped one.
- **Set is not the same as direct.** The plausible misconfiguration is `MARFA_DATABASE_URL_DIRECT` pointing back at the pooled endpoint: it passes every presence check, builds a genuinely distinct pool, logs itself as direct, and still poisons owner reads for the life of a stream. Both guards compare host **and** port through `isSamePgEndpoint`; host alone would reject the standard self-hosted topology of a pooler beside Postgres on one machine.
- **The symptom appears in the auth surfaces, not in the stream.** Better Auth reads `auth_session` as the owner, `auth_session` carries no grant to the application role, and the read fails with `42501`, so every signed-in surface flaps while a stream is open. Reaching for the stream when someone reports flapping sign-in is the whole point of writing this down.
- **Cleanup runs a scoped reset, not `DISCARD ALL`.** postgres.js caches prepared-statement names client-side and reuses them across reservations, so dropping them server-side without a client-side invalidation surfaces as `prepared statement does not exist` on whatever next touches the recycled connection. Policies read the GUC at execute time, so the cache is value-agnostic and the scoped reset matches the actual invariant. If the reset fails the connection is destroyed rather than returned.
- **A dispatch holds its slot for tens of seconds, not milliseconds.** Budget it like a stream rather than like a job tick when sizing anything against the pool.

## The change stream

- **Every stream announces its position as its first frame, and that frame carries no SSE `id:`.** The absent id is the load-bearing half: a resuming client is sent this frame before its backlog, and both `EventSource` and this repository's own subscriber treat `id:` as the cursor to resume from, so one here would move the client past exactly the events it reconnected for.
- **The cursor is a position in one ascending sequence and the filters select a subset of it, never a different order of it.** So the announced head is the unfiltered head; a filtered head would sit behind rows the client had already been shown. This is the opposite of the listing cursors on `/items` and `/edges`, where `updated_after` switches the ordering and a cursor from one is refused under the other.
- **An unknown filter value is refused rather than ignored.** The stream once accepted any string and matched nothing with it, which reaches the client as a 200 and an empty stream, the one filter failure a client cannot tell from a quiet space. The same applies to `?edges=`: an ignored value opens a stream carrying everything while the caller believes it opted out.

## Connections and runtime credentials

Runtime credentials are machine-minted per dispatch, so `api_keys` grows with traffic unless something retires them.

- **`connections/manifest-permissions.ts` is the only translation from a manifest to permissions**, and a connection whose manifest cannot be resolved mints fail-closed. Minting wide on a resolution failure would hand out the whole space.
- **`direction` is not an access level.** It describes flow relative to the upstream service, so `read` means pull from upstream and write into Marfa, and every inbound integration needs write on its target types. The narrowing that matters is the type set, not the level. Do not "fix" this into a read/write split without a manifest field that expresses a read-only ceiling.
- **Item provenance is the Connection's, not the credential's.** `item_source` is derived from the manifest and fixed for the credential's lifetime, and every item write prefers it over `source`. `source` rotates on every mint while upsert identity is `(source, source_id)`, so stamping it made `findBySourceId` look under a source no row carried and forked the integration's corpus on every refresh, with both writes succeeding.
- **A credential speaks only for its own Connection.** A `system.activity` write whose claimed `connection_id` is not the writer's binding is refused, before and after any property merge. The reserved-namespace carve-out admits the type and says nothing about whose activity a row claims to be.
- **An update is authorized against the target row, never against the request's claim.** Three write doors resolve an existing row by id or by natural key and then ignore the request's `type` entirely, so authorizing the claim checked a type nothing was being written to. `routes/item-write-doors.test.ts` holds every door and fails on a new one that is in neither the table nor a named exclusion.
- **`bulk-actions` narrows rather than refusing**, because it takes a filter rather than a list of rows and `system.activity` sits in every runtime credential's type filter. Failing an action over thousands of legitimate rows for one unreachable row is the worse trade.
- **Mint serializes against uninstall**, and every mint re-reads Connection state inside the lock. A state read taken before the lock is a snapshot of a decision the uninstall pipeline may already have overturned.
- **A mint rides the caller's transaction; a lifecycle pipeline brackets from its own.** The bracketing shape takes its connection before `fn` runs and `fn` then needs the pool again, so concurrent callers each hold a slot waiting for a slot nobody can release, on a queue with no bound. It does not need contention to happen, and minting runs on every dispatch. The bracketing lock therefore holds its connection on a pool of its own, on the app connection string rather than the session-mode one, so both shapes contend for the same key on the same database.
- **TTL must exceed the dispatch bound.** The local substrate has no working refresh, so a 401 mid-dispatch is terminal. The default TTL is derived from the dispatch job expiry rather than chosen; shortening it silently kills long backfills.
- **A dispatch that exhausts its retries degrades `/health` to a count and nothing more**, because the admin listing over the same rows spans every space and `/health` is unauthenticated. The row goes at seven days whether or not anyone was told, so an untouched alert resolving itself is a reason to act on it rather than a reason not to raise it.

## OAuth

The Better Auth OAuth Provider plugin carries the protocol surface; the endpoints and their RFCs are on the docs site. What is ours, and what is easy to break:

- **A grant is two records** and an approval writes both halves. Liveness is `status` alone.
- **A code is spent by its issuance**, and revocation reaches the device codes, so the token step refuses a grant that is not live.
- **A refresh token is written only when the approved scopes carry `offline_access`.**
- **Initiation checks its ceilings and refuses rather than narrows**, and the stored client row is caught up first, because refusing is only defensible against a current ceiling. A client's stored scope ceiling is written once at registration and would otherwise age out of the platform as the type registry moves: the widening takes what was requested rather than the whole bundle union, admits only scopes the bundles publish, and never shrinks.
- **The redirect URI is never taken from the caller.** One callback URI per deployment.

## Server-rendered pages

Every page the server hands a person shares one voice, one layout and one stylesheet.

- **Say the thing once.** A heading names what happened; the line under it says what to do, and if there is nothing to do, do not invent an instruction. No filler: a sentence equally true on a different page is carrying nothing.
- **Name the situation, not the mechanism.** A person has permissions, not scopes; an app, not a client; a connection, not a credential. Raw identifiers belong behind a disclosure if anywhere, and an identifier nobody would quote back to you is decoration.
- **A status code is part of a sentence or it is absent.** Address the reader, and do not apologise.
- **No em dashes**, in page copy and code comments alike.
- **One layout, one stylesheet.** `one-auth-layout.test.ts` fails a route module that builds its own document envelope or carries its own styles, with a short allowlist that must name a reason. Two hand-written copies of the design system drifted invisibly once, each carrying a comment saying it was kept in sync by hand. Email templates are exempt, because a linked stylesheet is stripped by most mail clients.

**The UI Viewer is where the words get checked.** `pnpm --filter @withmarfa/server ui:viewer` renders every page in every state with no database, importing the real renderers so the preview is what ships. Adding a surface means exporting the renderer, adding a fixture variant per state a person can actually land on including the failures, and letting the coverage guard fail the build when a renderer has no fixture.

- **Every page belongs there, not just the pretty ones.** The states nobody has seen are the ones that ship broken: an invalid-scope page was first seen on production, and a configuration form shipped for months with two unstyled classes.
- **Snapshots are the copy review.** Structural tests do not see words; the consent screen once told people an app could reach their bookmarks, files and media when it had asked for none, with fifty-eight green tests. Read the diff before rebaselining, because reading it is the point.

## Reserved extension namespaces

`connection.runtime` holds per-Connection runtime state and `connection.runtime.idempotency` holds the inbound-delivery dedupe window. Both are writable only by the connection's own runtime credential. **They are separate namespaces because the writers are different**, the dispatch loop and the webhook receipt route, which runs on the HTTP thread outside the dispatch lock. Keeping them apart is what stops a receipt and a dispatch overwriting each other.

## Enrichment and the integrations runtime

- **Enrichment is state-driven, never event-driven.** A sweeper finds candidates from `enrichment_state`; nothing enqueues on write. `enrichment_state` carries no grant to the application role and so is not policed by RLS.
- **The OCR seam exists so tests never touch the network**, and `EXTRACTOR_VERSION` is the re-extraction switch.
- **The runtime requires Postgres**, so SQLite deployments run without integrations. Dispatch serializes per Connection.
- **The dispatch fixture is a workspace package, not a test file.** The image builds it by name in its own step, which is the only place the staging path is exercised before a deploy.

## Tests

- **Postgres suites use the template-database pattern** for isolation. `test:pg` boots a throwaway `postgres:17` plus a transaction-mode PgBouncer on a per-run network, both named after the invoking shell's PID with kernel-assigned ports, so concurrent worktrees cannot clobber each other.
- **The pooler is not optional decoration.** The transaction-mode tests were gated on an environment variable nothing set and had never run anywhere: a suite reporting green while a body of tests inside it never executed. They need two clients landing on the same backend, which `default_pool_size = 1` produces and a plain Postgres cannot.
- **The pooler suites pin the premise as well as the guard**, building the rejected shape by hand and asserting the app pool really does go unreadable. A direct-endpoint suite passes under the broken shape, which is why the pooler one exists.
