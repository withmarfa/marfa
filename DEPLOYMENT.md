# Deployment

Myme runs on Atlas via launchd. Two instances share one source tree with separate launchd plists; a single deploy rebuilds once and restarts both.

## Environments

|                | Active                                     | Conformance mock                             |
| -------------- | ------------------------------------------ | -------------------------------------------- |
| Port           | 8602                                       | 8601                                         |
| Launchd label  | `com.myme.v0`                              | `com.myme.mock`                              |
| Postgres DB    | `myme_v0`                                  | `myme_mock`                                  |
| Plist location | `~/Library/LaunchAgents/com.myme.v0.plist` | `~/Library/LaunchAgents/com.myme.mock.plist` |
| Working dir    | `~/Services/myme-v0` (shared with mock)    | `~/Services/myme-v0` (shared with active)    |
| Logs           | `~/Services/myme-v0/logs/`                 | `~/Services/myme-mock/logs/`                 |

Both instances use Postgres on `localhost:5432`, S3 blob storage, and `KeepAlive: true`. Configuration (env vars, ports, database URLs) is embedded in each plist XML.

`:8600 com.myme.server` is a legacy instance. It is historical only, not targeted by this deploy flow, and not to be relied on for any product work.

## Deploying

Both services share one source tree at `~/Services/myme-v0/`. A single deploy rebuilds it and restarts both.

```bash
# Deploy latest main — restarts both active and mock
./deploy.sh

# Rollback to the SHA recorded as `previous_sha` in version.json
./deploy.sh --rollback

# Override SSH host alias
./deploy.sh --host <hostname>
```

The script SSHs to Atlas, pulls `main`, runs `pnpm install --frozen-lockfile && pnpm build`, runs `pnpm --filter @mymehq/server migrate` against both databases (`myme_v0` and `myme_mock`), writes `version.json` (current SHA + previous SHA + timestamp), restarts both launchd services, and verifies each health endpoint. Migrations are forward-only — the `--rollback` path reverts the source SHA but does not undo schema changes; if a rollback needs to undo a migration, that's a manual operator decision.

### Prerequisites

1. **SSH access** — the default host alias is `aic-atlas`. Configure in `~/.ssh/config`:
   ```
   Host aic-atlas
     HostName <tailscale-hostname-or-ip>
     User <your-user>
   ```
2. **Source tree on Atlas** — clone once:
   ```bash
   ssh aic-atlas "git clone <repo-url> ~/Services/myme-v0"
   ```
3. **pnpm** installed on Atlas (via fnm / nvm / Homebrew).

### Configuration

All optional, all environment-overridable:

- `ATLAS_HOST` — SSH alias (default: `aic-atlas`). Also settable via `--host`.
- `SERVICE_DIR` — source tree on Atlas (default: `$HOME/Services/myme-v0`).
- `REPO_BRANCH` — branch to deploy (default: `main`).

## Service management

```bash
# Health
ssh aic-atlas "curl -s http://localhost:8602/health"    # active
ssh aic-atlas "curl -s http://localhost:8601/health"    # mock

# Logs
ssh aic-atlas "tail -50 ~/Services/myme-v0/logs/stderr.log"    # active
ssh aic-atlas "tail -50 ~/Services/myme-mock/logs/stderr.log"  # mock

# Version
ssh aic-atlas "cat ~/Services/myme-v0/version.json"

# Manual restart (active)
ssh aic-atlas "launchctl unload ~/Library/LaunchAgents/com.myme.v0.plist && sleep 1 && launchctl load ~/Library/LaunchAgents/com.myme.v0.plist"

# Manual restart (mock)
ssh aic-atlas "launchctl unload ~/Library/LaunchAgents/com.myme.mock.plist && sleep 1 && launchctl load ~/Library/LaunchAgents/com.myme.mock.plist"
```

## Infrastructure setup

See the `ops/` directory for infrastructure setup guides:

- [Uptime Kuma](./ops/uptime-kuma.md) — health monitoring dashboard
- [Log rotation](./ops/log-rotation.md) — log file management
- [Caddy](./ops/caddy.md) — reverse proxy configuration
