# Deployment

Myme runs via launchd. Two instances share one source tree with separate launchd plists; a single deploy rebuilds once and restarts both.

## Environments

|                | Staging                                             | Conformance                                        |
| -------------- | --------------------------------------------------- | -------------------------------------------------- |
| Port           | 8602                                                | 8601                                               |
| Launchd label  | `so.myme.staging`                                   | `so.myme.conformance`                              |
| Postgres DB    | `myme_staging`                                      | `myme_conformance`                                 |
| Plist location | `~/Library/LaunchAgents/so.myme.staging.plist`      | `~/Library/LaunchAgents/so.myme.conformance.plist` |
| Working dir    | `~/Services/myme-staging` (shared with conformance) | `~/Services/myme-staging` (shared with staging)    |
| Logs           | `~/Services/myme-staging/logs/`                     | `~/Services/myme-conformance/logs/`                |

Both instances use Postgres on `localhost:5432`, S3 blob storage, and `KeepAlive: true`. Configuration (env vars, ports, database URLs) is embedded in each plist XML.

## Deploying

Both services share one source tree at `~/Services/myme-staging/`. A single deploy rebuilds it and restarts both.

```bash
# Deploy latest main — restarts both staging and conformance
./deploy.sh

# Rollback to the SHA recorded as `previous_sha` in version.json
./deploy.sh --rollback

# Override SSH host alias
./deploy.sh --host <hostname>
```

The script SSHs to the host, pulls `main`, runs `pnpm install --frozen-lockfile && pnpm build`, runs `pnpm --filter @mymehq/server migrate` against both databases (`myme_staging` and `myme_conformance`), writes `version.json` (current SHA + previous SHA + timestamp), restarts both launchd services, and verifies each health endpoint. Migrations are forward-only — the `--rollback` path reverts the source SHA but does not undo schema changes; if a rollback needs to undo a migration, that's a manual operator decision.

### Prerequisites

1. **SSH access** — the default host alias is `aic-atlas`. Configure in `~/.ssh/config`:
   ```
   Host aic-atlas
     HostName <hostname-or-ip>
     User <your-user>
   ```
2. **Source tree on the host** — clone once:
   ```bash
   ssh aic-atlas "git clone <repo-url> ~/Services/myme-staging"
   ```
3. **pnpm** installed on the host (via fnm / nvm / Homebrew).

### Configuration

All optional, all environment-overridable:

- `ATLAS_HOST` — SSH alias (default: `aic-atlas`). Also settable via `--host`.
- `SERVICE_DIR` — source tree (default: `$HOME/Services/myme-staging`).
- `REPO_BRANCH` — branch to deploy (default: `main`).
- `STAGING_DATABASE_URL` — Postgres URL for the staging instance.
- `CONFORMANCE_DATABASE_URL` — Postgres URL for the conformance instance.

## Service management

```bash
# Health
ssh aic-atlas "curl -s http://localhost:8602/health"    # staging
ssh aic-atlas "curl -s http://localhost:8601/health"    # conformance

# Logs
ssh aic-atlas "tail -50 ~/Services/myme-staging/logs/stderr.log"      # staging
ssh aic-atlas "tail -50 ~/Services/myme-conformance/logs/stderr.log"  # conformance

# Version
ssh aic-atlas "cat ~/Services/myme-staging/version.json"

# Manual restart (staging)
ssh aic-atlas "launchctl unload ~/Library/LaunchAgents/so.myme.staging.plist && sleep 1 && launchctl load ~/Library/LaunchAgents/so.myme.staging.plist"

# Manual restart (conformance)
ssh aic-atlas "launchctl unload ~/Library/LaunchAgents/so.myme.conformance.plist && sleep 1 && launchctl load ~/Library/LaunchAgents/so.myme.conformance.plist"
```

## Infrastructure setup

See the `ops/` directory for infrastructure setup guides:

- [Uptime Kuma](./ops/uptime-kuma.md) — health monitoring dashboard
- [Log rotation](./ops/log-rotation.md) — log file management
- [Caddy](./ops/caddy.md) — reverse proxy configuration
