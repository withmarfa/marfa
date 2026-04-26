# ADR: ElectricSQL host for `@mymehq/sync-client`

**Status:** Open — pending M0 spike outcome
**Author:** August Cayzer
**Date:** 2026-04-26
**Context:** [`feat/sync-client`](../../packages/sync-client/) (M0 of the build plan)

## Decision

To be filled in after M0 completes. Choices:

- **A. Electric on Atlas (macOS + Docker).** One Electric service per Postgres database (`:8603` for `myme_v0`, `:8604` for `myme_mock`), wrapped in launchd, pinned to a specific image tag. Co-located with the Myme server.
- **B. Electric on a Linux host (Fly.io / Hetzner / similar).** External managed or self-hosted Linux machine running Electric, exposed over Tailscale. Atlas's Postgres is reachable via Tailscale outbound. Adds an external dependency but lifts Electric onto its primary supported runtime.

## M0 spike outcome

> _Fill in after running [`infra/atlas/m0-probe.sh`](../../infra/atlas/m0-probe.sh) on Atlas._

| Check | Result |
|-------|--------|
| Container booted on first try | _yes / no_ |
| `wal_level = logical` Postgres restart accepted | _yes / no_ |
| `GET /v1/shape?table=items&offset=-1` returned a valid body | _yes / no_ |
| Live-mode handshake (`electric-handle` / `electric-offset` headers present) | _yes / no_ |
| Memory profile after 24 h soak | _e.g. 120 MB resident_ |
| Reconnects after forced container restart | _yes / no_ |
| Replication slot left clean (no orphaned slots) | _yes / no_ |
| Surprises / footguns | _free text_ |

## Decision

> _Choose A or B once the table above is filled. Record the rationale here so the rest of the plan can proceed._

## Consequences

If **A** (Atlas Docker): M1 proceeds as planned with launchd plists at `infra/atlas/launchd/`. The user applies them manually during a brief Postgres outage window for `wal_level = logical`.

If **B** (Linux host): M1 is rewritten to deploy Electric to the chosen Linux host. The Myme server's `ELECTRIC_URL` env var points at the remote service over Tailscale. Atlas-side launchd plists are dropped from the deliverable. Sync-client work (M4+) is unaffected — the proxy abstraction means the URL is the only client-visible difference.

## Notes

- Tag pinned for the spike: `electricsql/electric:1.5.1` (latest stable as of April 2026, verify before running).
- If the spike reveals Electric needs a feature that's only in canary/beta, raise it as a separate decision rather than running pre-release tags in production.
- The decision must be recorded before M1 begins; M2+ can run in parallel with M1 once the host is settled.
