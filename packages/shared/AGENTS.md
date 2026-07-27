# @withmarfa/shared

Wire types, runtime validation, error codes, ID utilities, and the type registry consumer. Imported by both server and SDK; the foundation everything else builds on.

Contents (`src/`):

- `types.ts` — every wire type that crosses the network. `Item`, `CreateItemInput`, `UpdateItemInput`, `ApiKey`, `TenantConfig`, `User`, `Edge`, `EnforcementSettings`, `Tier`, `ItemState`. Source of truth — server schemas and SDK signatures derive from these. Wire-shape changes start here.
- `errors.ts` — `MarfaError` + the `ErrorCode` enum. Add new codes here; the HTTP status map at the bottom keeps the wire shape stable.
- `validation.ts` — pure shape validators that don't need the registry: `isValidId`, `isValidTimestamp`, `isValidTypeIdentifier` (dot-separated namespace grammar), `isValidHandle` (lowercase alphanumeric + hyphens, 3–32 chars, reserved-word check), `isValidEmail`, `isValidUrl`. Synchronous and side-effect-free.
- `ids.ts` — `generateId` (UUIDv7) and helpers.
- `type-registry.ts` — the in-memory `TYPE_REGISTRY` (seeded with `ALL_TYPES` + `ALL_CONNECTOR_TYPES` + `ALL_SYSTEM_TYPES` from `@withmarfa/types`); the family sets `SYSTEM_TYPE_IDS` / `CONNECTOR_TYPE_IDS`; namespace classifiers (`classifyNamespace`, `isCoreType`, `isSystemType`, etc.); `validateTypeSchema`, which binds tenant-scoped registry resolution onto the canonical validator in `@withmarfa/types` so the runtime and the in-tree codegen judge a schema identically; `validateProperties`; `validateTransition` (lifecycle gate, with system.\* override); enforcement helpers (`resolveEnforcement`, `isTypeInStrictMode`, `getSourceAllowlist`, `getSourceFilter`).
- `type-patterns.ts` — what a type pattern matches. `typeMatchesPattern`, `typeMatchesAnyPattern`, `subtreeWildcardRoot`, `typePatternToSql`, `typeSubtreeToSql`. Subtree wildcards are **parent-inclusive**: `core.media.*` covers `core.media`. Everything that resolves a `.*` pattern — permission maps, OAuth scopes, webhook filters, the storage layer's `allowed_types` — goes through here, because a pattern that means one thing at the auth gate and another in the query admits a caller and then hides its rows.

  Parent-inclusion cuts both ways, and the deny direction is the one that surprises people: `{"*": "write", "core.secret.*": "none"}` denies `core.secret` itself, because the longest-prefix winner for that identifier is now the `none` entry rather than the global grant. A permission map that means to fence off a subtree while leaving its root writable has to say so with an explicit entry for the root, which takes priority over every pattern.

  Two decompositions, because a bare identifier means opposite things on either side of the gate. `typePatternToSql` serves **permission grants**, where `core.note` grants that type and nothing under it — widening it would hand a narrowly-scoped credential a whole subtree. `typeSubtreeToSql` serves the **`?type=` read filter**, where `core.note` has always selected `core.note.private` too. Same input strings, opposite defaults; keep them apart.

- `diff-type-schemas.ts` — `diffTypeSchemas` classifies a registration diff as `noop | patch | minor | major`; `isValidVersionBump` encodes the integer-version semantics.
- `edge-registry.ts` — same shape as type-registry, for edge types.
- `scopes.ts` — OAuth scope grammar (`<type>:<verb>`, `edge.<type>:<verb>`, `metadata:<verb>`); `parseScope`, `scopesToTypePermissions`, etc.
- `query-parser.ts` — the `?filter=` DSL parser used by `/items` and `/search`. `SYSTEM_FIELDS` lists the columns the parser knows (state, type, source, timestamp, created_at, updated_at, tier, device, version, id).

## Authoring rules

- **Wire types are TypeScript-first.** Add a field on `User` or `ApiKey` here, then propagate to server route schemas and SDK types. Don't add server-only fields directly to route schemas — surface them through the wire type so the SDK sees them.
- **No server-only logic.** This package is consumed by the SDK and runs in browsers, edge runtimes, etc. No `node:fs`, `node:crypto`, etc. — use `crypto.subtle` if hashing is needed.
- **No backwards-compat shims.** When a wire type changes, every consumer breaks at compile time and gets fixed in the same change. Don't keep both old and new field names alive.

## Build

`tsup` builds `dist/index.js` (ESM) and `dist/index.d.ts`. The post-build `inline-types-dts.mjs` script inlines `@withmarfa/types` declarations into the dist `.d.ts` so external SDK consumers don't need to install `@withmarfa/types` separately.

## Testing

Vitest, run from the monorepo root (`pnpm test`). Tests live alongside source as `*.test.ts`. Pure unit tests — no server, no DB.
