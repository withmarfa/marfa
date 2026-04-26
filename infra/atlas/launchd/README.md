# Atlas launchd templates for `@mymehq/sync-client`

Two launchd jobs run ElectricSQL on Atlas, one per Postgres database:

- `com.myme.electric.v0` — Electric in front of `myme_v0` (active service), exposes :8603.
- `com.myme.electric.mock` — Electric in front of `myme_mock` (conformance), exposes :8604.

The Myme server's `/sync/shapes/:family` proxy is the only thing that should reach these endpoints from the public internet. Atlas firewalls or Tailscale ACLs should keep ports `:8603`/`:8604` private.

## Prerequisites

1. **`wal_level = logical` on both Postgres instances.** This is a server-level setting; changing it requires a Postgres restart. Schedule a brief outage window per database.

   ```bash
   # check current setting
   psql -d myme_v0 -c "SHOW wal_level;"
   # if it's not 'logical', edit postgresql.conf, set wal_level = logical,
   # then restart postgres. Repeat for myme_mock.
   ```

2. **Run the publication migration.** From inside this repo:

   ```bash
   pnpm --filter @mymehq/server run migrate
   ```

   This adds the `myme_electric_pub` publication (covers `items`, `edges`, `metadata`) to the active database. Idempotent. Repeat for the mock instance via the appropriate `DATABASE_URL`.

3. **Docker available on Atlas.** OrbStack or Docker Desktop. The same daemon `test:pg` uses.

## Install

The agent commits these plist templates to the repo. **You apply them on Atlas manually:**

```bash
# 1. Substitute the DB password
cd /path/to/myme/infra/atlas/launchd
sed "s/REPLACE_WITH_DB_PASS/$YOUR_DB_PASS/" com.myme.electric.v0.plist \
  > ~/Library/LaunchAgents/com.myme.electric.v0.plist
sed "s/REPLACE_WITH_DB_PASS/$YOUR_DB_PASS/" com.myme.electric.mock.plist \
  > ~/Library/LaunchAgents/com.myme.electric.mock.plist

# 2. Load
launchctl load -w ~/Library/LaunchAgents/com.myme.electric.v0.plist
launchctl load -w ~/Library/LaunchAgents/com.myme.electric.mock.plist

# 3. Verify
curl -sf http://localhost:8603/v1/shape?table=items&offset=-1 | head -c 200
curl -sf http://localhost:8604/v1/shape?table=items&offset=-1 | head -c 200
```

Add monitoring in uptime-kuma for both ports.

## Atlas redeploy snippet

Add to `~/aic-local/Dev/MymeHQ/.claude/CLAUDE.md` under *Atlas redeploy — after server changes*:

```bash
launchctl kickstart -k gui/$(id -u)/com.myme.electric.v0
launchctl kickstart -k gui/$(id -u)/com.myme.electric.mock
```

(The agent does not modify that file directly — workspace-level CLAUDE.md is user-curated. Apply by hand.)

## Bumping the Electric image

The plists pin `electricsql/electric:1.5.1`. To bump:

1. Open a PR that updates the tag in both plists.
2. Test the new tag against `myme_mock` first via the M0 probe script.
3. Merge, then `launchctl kickstart -k` both jobs.

Never use `:latest` in production.

## Tearing down

```bash
launchctl unload -w ~/Library/LaunchAgents/com.myme.electric.v0.plist
launchctl unload -w ~/Library/LaunchAgents/com.myme.electric.mock.plist
docker rm -f myme-electric-v0 myme-electric-mock 2>/dev/null || true
```

The Postgres `myme_electric_pub` publication is left in place; it's harmless when no Electric service is consuming it. Drop it manually if needed:

```sql
DROP PUBLICATION IF EXISTS myme_electric_pub;
```
