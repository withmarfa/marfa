# @withmarfa/shared

Wire types, runtime validation, error codes, ID utilities, the type and edge registries, the scope grammar and the `?filter=` parser. Imported by the server and the SDK alike, so it runs in browsers and edge runtimes.

## Authoring rules

- **Wire types are TypeScript-first.** Add a field on `User` or `ApiKey` here, then propagate to the server's route schemas and the SDK. A server-only field added directly to a route schema is invisible to the SDK.
- **No server-only logic.** No `node:fs`, no `node:crypto`; reach for `crypto.subtle`.
- **No backwards-compat shims.** A wire-type change breaks every consumer at compile time and they are fixed in the same change. Do not keep old and new field names alive together.

## Type patterns

Everything that resolves a `.*` pattern goes through `type-patterns.ts`: permission maps, OAuth scopes, webhook filters and the storage layer's `allowed_types`. That is because a pattern meaning one thing at the auth gate and another in the query admits a caller and then hides its rows.

- **Subtree wildcards are parent-inclusive.** `core.media.*` covers `core.media`.
- **The deny direction is the one that surprises people.** `{"*": "write", "core.secret.*": "none"}` denies `core.secret` itself, because the longest-prefix winner for that identifier is the `none` entry. Fencing a subtree while leaving its root writable needs an explicit entry for the root.
- **Two decompositions, because a bare identifier means opposite things either side of the gate.** `typePatternToSql` serves permission grants, where `core.note` grants that type and nothing under it, since widening would hand a narrow credential a whole subtree. `typeSubtreeToSql` serves the `?type=` read filter, where `core.note` has always selected `core.note.private` too. Same input strings, opposite defaults; keep them apart.

## Hydrating a client's registry

`hydrateTypeRegistry` takes a `GET /types` payload and registers what the platform map does not already hold, so a client validates a write locally by the rules the server applies.

- **It converges on the payload rather than accumulating.** A deletion reaches a client as an absence and never as a tombstone, so a hydration that only added left a deleted type valid locally for ever and queued writes the server then refused. Pass the whole listing, never a slice: that is the contract rather than advice, and it stays a precondition rather than a parameter because `GET /types` takes no filter, so the only other value such a parameter could carry is a supported spelling of the defect.
- **The filter is membership of the platform map, not the namespace.** A reserved-namespace type this build does not ship is absent from that map and registers into the space overlay like anything else. The overlay is the only map a client may write.
- **`unlistedPlatform` is the permissive mirror and nothing here can repair it.** A platform type this build ships that the listing does not name goes on resolving locally, so a write against it validates and the server refuses the create as an unknown type.

## Scopes

The grammar is `<type>:<verb>`, `edge.<type>:<verb>`, `metadata[.<subresource>]:<verb>`, the verb-less OIDC literals, `space.<surface>`, and the two content-category literals.

**`content` and `space` are reserved roots claimed whole**, so nothing else under either parses. The content category is projected as a complement, the global wildcard at the granted level minus the system types, with `marfa.*` clamped to read, which makes the projection registry-dependent. `ParsedScope["kind"]` is a required discriminant and every projection admits by naming the family it wants rather than skipping the ones it does not, so adding a family stops the package compiling until each site has classified it.

## Build and test

`tsup` emits ESM plus declarations; a post-build step inlines the `@withmarfa/types` declarations so external consumers need only this package. Tests are pure units alongside the source, run from the repository root.
