# ADR: ElectricSQL host for `@mymehq/sync-client`

**Status:** Decided — Option A (Atlas Docker)
**Author:** August Cayzer
**Date:** 2026-04-26
**Context:** [`feat/sync-client`](../../packages/sync-client/) (M0 of the build plan)

## Decision

**Option A — Electric on Atlas (macOS + Docker).** One Electric service per Postgres database (`:8603` for `myme_v0`, `:8604` for `myme_mock`), wrapped in launchd, pinned to `electricsql/electric:1.5.1`. Co-located with the Myme server. Tailscale fronts both endpoints; the Myme server's `/sync/shapes/:family` proxy is the only public path in.

## M0 spike outcome (2026-04-26)

| Check | Result |
|-------|--------|
| Container booted on first try | yes (after prereqs applied — see footguns) |
| `wal_level = logical` Postgres restart accepted | yes; both Myme servers (`:8601`, `:8602`) recovered cleanly within seconds |
| `GET /v1/shape?table=items&offset=-1` returned a valid body | yes — full schema introspection (18 columns) and seeded `core.note` rows streamed |
| Live-mode handshake (`electric-handle` / `electric-offset` headers present) | yes — `electric-handle: 103257328-…`, `electric-offset: 0_0`, `electric-has-data: true` |
| Memory profile at idle | **270 MB RSS** per container after boot. Two services running 24/7 ≈ **540 MB** sustained on Atlas |
| Replication slot accounting | clean — `electric_slot_default` (`pgoutput`, `logical`, `active`) created on connect; no orphans after teardown |
| Surprises / footguns | three (see below) |

## Footguns surfaced

These weren't in the original plan and are now folded into the launchd install README:

1. **`myme` Postgres role needs `REPLICATION` attribute.** Electric uses logical replication; without `REPLICATION` it errors with `42501 insufficient_privilege ... permission denied to start WAL sender`. Granted via superuser: `ALTER ROLE myme WITH REPLICATION`.
2. **`listen_addresses = '*'` (or at least Docker-bridge-reachable).** Default Homebrew Postgres binds to localhost only, which is unreachable from the Docker bridge network even with `host.docker.internal`. Set `listen_addresses = '*'` and rely on `pg_hba.conf` to scope access.
3. **`pg_hba.conf` Docker-bridge rules.** Need both `host all myme <docker-subnet> trust` and `host replication myme <docker-subnet> trust`. Atlas's Docker bridge is `192.168.215.0/24`. Trust auth is consistent with the existing posture (Tailscale-fronted, no public exposure).

The probe script also has a pipeline bug (`tee` after `head -c` triggers `EPIPE`); fixed in the same commit as this ADR.

## Consequences

- M1 proceeds as planned. Launchd plists at `infra/atlas/launchd/` install cleanly with the README updates above.
- The 540 MB sustained memory cost is acceptable on Atlas (M4 Pro, 24 GB RAM). Worth monitoring as data grows; revisit if RSS exceeds ~1 GB per instance.
- Telemetry: Electric phones home anonymously by default. Disable per-instance with `ELECTRIC_USAGE_REPORTING=false` in the plist if desired. Not disabled in v1 — telemetry surface is benign and helps the upstream project.
- `ELECTRIC_INSECURE=true` is set on both services. Safe because Atlas-internal traffic never leaves Tailscale; the Myme server's `/sync/shapes/:family` proxy is the only consumer. Reconsider if Electric is ever exposed beyond Tailscale.

## Notes

- Pinned tag: `electricsql/electric:1.5.1`. Bump deliberately; don't track `:latest`.
- Replication slots are created on first shape subscription. They're held until Electric tears down. If Electric is removed, drop slots manually: `SELECT pg_drop_replication_slot('electric_slot_default');`.
