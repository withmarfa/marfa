# @withmarfa/shared

Wire types, runtime validation, error codes, ID utilities, and the type registry consumer. Imported by both server and SDK; the foundation everything else builds on.

Contents (`src/`):

- `types.ts` — every wire type that crosses the network. `Item`, `CreateItemInput`, `UpdateItemInput`, `ApiKey`, `SpaceConfig`, `User`, `Edge`, `EnforcementSettings`, `Tier`, `ItemState`. Source of truth — server schemas and SDK signatures derive from these. Wire-shape changes start here.
- `errors.ts` — `MarfaError` + the `ErrorCode` enum. Add new codes here; the HTTP status map at the bottom keeps the wire shape stable.
- `validation.ts` — pure shape validators that don't need the registry: `isValidId`, `isValidTimestamp`, `isValidTypeIdentifier` (dot-separated namespace grammar), `isValidHandle` (lowercase alphanumeric + hyphens, 3–32 chars, reserved-root check), `isValidEmail`, `isValidUrl`. Synchronous and side-effect-free.
- `ids.ts` — `generateId` (UUIDv7) and helpers.
- `type-registry.ts` — the in-memory `TYPE_REGISTRY` (seeded with `ALL_TYPES` + `ALL_INTEGRATION_TYPES` + `ALL_SYSTEM_TYPES` from `@withmarfa/types`); the family sets `SYSTEM_TYPE_IDS` / `INTEGRATION_TYPE_IDS`; namespace classifiers (`classifyNamespace`, `isCoreType`, `isSystemType`, etc.) plus `PLATFORM_TIERS`, the three tiers the platform owns, exported so the registration doors and the hydration helper read one set rather than three copies a new `NamespaceTier` member would leave silently wrong; `validateTypeSchema`, which binds space-scoped registry resolution onto the canonical validator in `@withmarfa/types` so the runtime and the in-tree codegen judge a schema identically; `validateProperties`; `validateTransition` (lifecycle gate, with system.\* override — keyed on the family-backed `SYSTEM_TYPE_IDS` **or** the `system.` namespace, so a seeded system type this build never compiled in still gets the bounded lifecycle); enforcement helpers (`resolveEnforcement`, `isTypeInStrictMode`, `getSourceAllowlist`, `getSourceFilter`).
- `hydrate-type-registry.ts` — `hydrateTypeRegistry`, which takes a `GET /types` payload and registers, through `registerTypeSchema`, every entry the platform map does not already hold, so a client validates a write locally by the rules the server applies. **The filter is membership of that map, not the namespace**: a reserved-namespace type this build does not ship is absent from the map and is registered like anything else, which is the case the paragraph below is about. It orders parents ahead of children, but only because the walk that finds a cycle or an unresolvable parent produces that order anyway: field resolution is lazy, so the registry it builds does not depend on the order. It re-validates nothing — the server already accepted these schemas, and a client on an older build refusing one would refuse the writes against it too.

  **It converges on the payload rather than accumulating**, so a type the listing no longer carries is unregistered and named in `removed`. A deletion reaches a client as an absence and never as a tombstone, so a hydration that only added left a deleted type valid locally for ever and queued writes the server then refused. That makes "pass the whole listing, not a slice" the contract rather than advice; it stays a precondition rather than a parameter because `GET /types` takes no filter, so the only other value such a parameter could carry is a supported spelling of the defect.

  A reserved-namespace type this build does not ship registers into the space overlay like any other payload entry and is named in `unshippedPlatform`. An instance's shipped vocabulary is seeded data, so a listing can carry platform types a client never compiled in, and the overlay is the only map a client may write — the platform map is global, and a space-scoped listing may not reach it.

  `unlistedPlatform` is the mirror, and the permissive direction: a platform type this build ships that the listing does not name. Nothing here can repair it, because the same global map that stops a listing writing into it stops a listing evicting from it — so the type goes on resolving locally, a write against it validates, and the server refuses the create as an unknown type. It is the same platform drift the server's `computePlatformDrift` (`packages/server/src/storage/platform-drift.ts`) reports against its own rows, measured the other way round: that one asks which shipped types an instance carries that its build no longer names, and no server can ask it of a client's build.

- `type-patterns.ts` — what a type pattern matches. `typeMatchesPattern`, `typeMatchesAnyPattern`, `subtreeWildcardRoot`, `typePatternToSql`, `typeSubtreeToSql`. Subtree wildcards are **parent-inclusive**: `core.media.*` covers `core.media`. Everything that resolves a `.*` pattern — permission maps, OAuth scopes, webhook filters, the storage layer's `allowed_types` — goes through here, because a pattern that means one thing at the auth gate and another in the query admits a caller and then hides its rows.

  Parent-inclusion cuts both ways, and the deny direction is the one that surprises people: `{"*": "write", "core.secret.*": "none"}` denies `core.secret` itself, because the longest-prefix winner for that identifier is now the `none` entry rather than the global grant. A permission map that means to fence off a subtree while leaving its root writable has to say so with an explicit entry for the root, which takes priority over every pattern.

  Two decompositions, because a bare identifier means opposite things on either side of the gate. `typePatternToSql` serves **permission grants**, where `core.note` grants that type and nothing under it — widening it would hand a narrowly-scoped credential a whole subtree. `typeSubtreeToSql` serves the **`?type=` read filter**, where `core.note` has always selected `core.note.private` too. Same input strings, opposite defaults; keep them apart.

- `diff-type-schemas.ts` — `diffTypeSchemas` classifies a registration diff as `noop | patch | minor | major`; `isValidVersionBump` encodes the integer-version semantics.
- `edge-registry.ts` — same shape as type-registry, for edge types.
- `scopes.ts` — OAuth scope grammar (`<type>:<verb>`, `edge.<type>:<verb>`, `metadata:<verb>`, the OIDC literals, the verb-less `space.<surface>` set, and the two content-category literals `content:read` / `content:write`); `parseScope`, `scopesToTypePermissions`, `hasSpacePermission`, etc. **`content` and `capability` are reserved roots claimed whole**, so nothing else under either parses. The content category is projected as a _complement_ — the global wildcard at the granted level, minus the family-backed `SYSTEM_TYPE_IDS`, with `marfa.*` clamped to read because the middleware refuses those writes from an OAuth token. That makes `scopesToTypePermissions` registry-dependent: on a server the set is seeded at boot, and elsewhere it resolves against the compiled shipped set, the same contract `typeMatchesPattern` has against `TYPE_REGISTRY`. `ParsedScope["kind"]` is a required discriminant, and every projection admits by naming the family it wants rather than skipping the ones it does not, so adding a family stops the package compiling until each site has classified it.
- `query-parser.ts` — the `?filter=` DSL parser used by `/items` and `/search`. `SYSTEM_FIELDS` lists the columns the parser knows (state, type, source, timestamp, created_at, updated_at, tier, device, version, id).

## Authoring rules

- **Wire types are TypeScript-first.** Add a field on `User` or `ApiKey` here, then propagate to server route schemas and SDK types. Don't add server-only fields directly to route schemas — surface them through the wire type so the SDK sees them.
- **No server-only logic.** This package is consumed by the SDK and runs in browsers, edge runtimes, etc. No `node:fs`, `node:crypto`, etc. — use `crypto.subtle` if hashing is needed.
- **No backwards-compat shims.** When a wire type changes, every consumer breaks at compile time and gets fixed in the same change. Don't keep both old and new field names alive.

## Build

`tsup` builds `dist/index.js` (ESM) and `dist/index.d.ts`. The post-build `inline-types-dts.mjs` script inlines `@withmarfa/types` declarations into the dist `.d.ts` so external SDK consumers don't need to install `@withmarfa/types` separately.

## Testing

Vitest, run from the monorepo root (`pnpm test`). Tests live alongside source as `*.test.ts`. Pure unit tests — no server, no DB.
