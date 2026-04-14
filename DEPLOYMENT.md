# Deployment

Myme runs on a server via launchd. Both environments use the same server binary built from this monorepo.

## Environments

|          | Production              | Staging                  |
| -------- | ----------------------- | ------------------------ |
| Port     | 8600                    | 8601                     |
| Plist    | `com.myme.server.plist` | `com.myme.staging.plist` |
| Database | `myme`                  | `myme_staging`           |

Both use Postgres (localhost:5432), S3 blob storage, and `KeepAlive: true`. Configuration (env vars, ports, database URLs) is embedded in the launchd plist XML at `~/Library/LaunchAgents/`.

## Deploying

Both production and staging share the same code directory with different launchd plists. A single deploy updates both environments.

```bash
# Deploy latest main (restarts both production and staging)
./deploy.sh

# Rollback to previous SHA
./deploy.sh --rollback
```

The deploy script SSHs to the server, pulls from git, builds, writes a `version.json` with the git SHA, restarts both launchd services, and verifies both health endpoints.

### Prerequisites

1. **SSH access** — configure your `~/.ssh/config` with a host alias:
   ```
   Host atlas
     HostName <server-tailscale-ip>
     User <username>
   ```
2. **Git repo on the server** — clone the monorepo once:
   ```bash
   ssh atlas "git clone <repo-url> ~/Services/myme"
   ```
3. **pnpm** installed on the server

### Configuration

The deploy script uses these environment variables (all optional):

- `ATLAS_HOST` — SSH hostname/alias for the server (default: `atlas`). Override with `--host` flag or env var
- `SERVICE_DIR` — service directory on the server (default: `$HOME/Services/myme`)
- `REPO_BRANCH` — git branch to deploy (default: `main`)

## Service management

```bash
# Check health
ssh $ATLAS_HOST "curl -s http://localhost:8600/health"
ssh $ATLAS_HOST "curl -s http://localhost:8601/health"

# View logs
ssh $ATLAS_HOST "tail -50 ~/Services/myme/stderr.log"

# Verify running version
ssh $ATLAS_HOST "cat ~/Services/myme/version.json"

# Restart
ssh $ATLAS_HOST "launchctl unload ~/Library/LaunchAgents/com.myme.server.plist && sleep 1 && launchctl load ~/Library/LaunchAgents/com.myme.server.plist"
```

## Infrastructure setup

See the `ops/` directory for infrastructure setup guides:

- [Uptime Kuma](./ops/uptime-kuma.md) — health monitoring dashboard
- [Log rotation](./ops/log-rotation.md) — log file management
- [Caddy](./ops/caddy.md) — reverse proxy configuration
