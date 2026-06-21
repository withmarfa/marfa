# @withmarfa/shared

Wire types, runtime validation, error codes, ID utilities, and the type registry consumer. Imported by both server and SDK; the foundation everything else builds on.

Contents (`src/`):

- `types.ts` — every wire type that crosses the network. `Item`, `CreateItemInput`, `UpdateItemInput`, `ApiKey`, `TenantConfig`, `User`, `Edge`, `EnforcementSettings`, `Tier`, `ItemState`. Source of truth — server schemas and SDK signatures derive from these. Wire-shape changes start here.
- `errors.ts` — `MarfaError` + the `ErrorCode` enum. Add new codes here; the HTTP status map at the bottom keeps the wire shape stable.
- `validation.ts` — pure shape validators that don't need the registry: `isValidId`, `isValidTimestamp`, `isValidTypeIdentifier` (dot-separated namespace grammar), `isValidHandle` (lowercase alphanumeric + hyphens, 3–32 chars, reserved-word check), `isValidEmail`, `isValidUrl`. Synchronous and side-effect-free.
- `ids.ts` — `generateId` (UUIDv7) and helpers.
- `type-registry.ts` — the in-memory `TYPE_REGISTRY` (seeded with `ALL_TYPES` + `ALL_SYSTEM_TYPES` from `@withmarfa/types`); namespace classifiers (`classifyNamespace`, `isCoreType`, `isSystemType`, etc.); `validateTypeSchema` (registration validation incl. inheritance and `compatible_with` checks); `validateProperties`; `validateTransition` (lifecycle gate, with system.\* override); enforcement helpers (`resolveEnforcement`, `isTypeInStrictMode`, `getSourceAllowlist`, `getSourceFilter`).
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
