# Deployment

Myme runs on Atlas (Mac Mini M4 Pro) via launchd. Both environments use the same server binary at `~/Services/myme/packages/server/dist/index.js`.

## Environments

|           | Production              | Staging                    |
| --------- | ----------------------- | -------------------------- |
| Port      | 8600                    | 8601                       |
| Plist     | `com.myme.server.plist` | `com.myme.staging.plist`   |
| Database  | `myme`                  | `myme_staging`             |
| Logs      | `~/Services/myme/`      | `~/Services/myme-staging/` |
| Tailscale | `100.127.105.110:8600`  | `100.127.105.110:8601`     |

Both use Postgres (via `myme` user on localhost:5432), S3 blob storage (`myme-blobs` bucket in eu-west-2), and `KeepAlive: true`.

## Deploying new code

From the local dev machine:

```bash
# 1. Build
cd ~/aic-local/Dev/MymeHQ/myme
pnpm build

# 2. Sync to Atlas
rsync -avz --delete --exclude=node_modules --exclude=.git ./ aic-atlas:~/Services/myme/

# 3. Install deps on Atlas (if lockfile changed)
ssh aic-atlas "cd ~/Services/myme && pnpm install --frozen-lockfile"

# 4. Restart the service
ssh aic-atlas "launchctl unload ~/Library/LaunchAgents/com.myme.server.plist; sleep 1; launchctl load ~/Library/LaunchAgents/com.myme.server.plist"

# 5. Verify
curl http://100.127.105.110:8600/health
```

For staging, replace `com.myme.server.plist` with `com.myme.staging.plist` and port 8600 with 8601.

## Plist locations

Both plist files live at `~/Library/LaunchAgents/` on Atlas. Config (env vars, ports, database URLs) is embedded in the plist XML. Do not restart via nohup or PM2.

## Service management

```bash
# Check if running
ssh aic-atlas "curl -s http://localhost:8600/health"
ssh aic-atlas "curl -s http://localhost:8601/health"

# View logs
ssh aic-atlas "tail -50 ~/Services/myme/stderr.log"
ssh aic-atlas "tail -50 ~/Services/myme-staging/stderr.log"

# Restart
ssh aic-atlas "launchctl unload ~/Library/LaunchAgents/com.myme.server.plist; sleep 1; launchctl load ~/Library/LaunchAgents/com.myme.server.plist"
```
