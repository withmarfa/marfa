# Deploying the server

The container recipe here runs the server with its database streamed off-site and its blobs replicated to the same bucket, so an instance can be rebuilt from the bucket alone. `conformance/scripts/restore-drill.ts` is the proof: it boots an instance, writes to it, restores a second from the bucket and compares the two to the byte, and the `restore-drill` job in `ci.yml` runs it against a local object store on every pull request.

## What runs in the container

- **The server**, `node dist/index.js`, on SQLite at `SQLITE_PATH` with its disk store at `BLOB_PATH`. Both sit on the volume mounted at `/data`. On Railway the disk store is a volume, not the container's filesystem: a redeploy keeps it, and the bucket holds a second copy of every blob regardless.
- **Litestream** (`litestream.yml`), a sidecar in the same container. `entrypoint.sh` restores the database from the bucket when the volume holds none, then runs the server under `litestream replicate -exec`, which streams every committed page to the bucket within a second and takes a snapshot every hour. A day of snapshots is kept, and Litestream removes older ones itself, because the bucket has no lifecycle rules.
- **The blob folder is the server's own housekeeping.** Litestream carries the database only. The `blob-replicate` housekeeping job (listed at `GET /housekeeping`) gives the object store a copy of every blob the disk holds, woken by each upload and otherwise on `MARFA_BLOB_REPLICATE_INTERVAL_MS`; `blob-integrity` checks the copies and replication replaces one that is missing or corrupt. `conformance/spec/stores.md` states the rules.

## The names it needs

The six the server reads for its object store are the six the sidecar reads, from the same environment, so the two cannot name different buckets:

| Name                   | Read by                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `S3_BUCKET`            | the server, Litestream                                                                                                           |
| `S3_REGION`            | the server, Litestream (`us-east-1` when unset, which the entrypoint spells out)                                                 |
| `S3_ENDPOINT`          | the server, Litestream                                                                                                           |
| `S3_ACCESS_KEY_ID`     | the server, Litestream                                                                                                           |
| `S3_SECRET_ACCESS_KEY` | the server, Litestream                                                                                                           |
| `S3_FORCE_PATH_STYLE`  | the server, Litestream (path style with an endpoint and virtual hosting without one when unset, which the entrypoint spells out) |
| `S3_PREFIX`            | the server (default `blobs`); the database replica sits under `db/` beside it                                                    |
| `SQLITE_PATH`          | the server, Litestream (`/data/marfa.db` in the image)                                                                           |
| `BLOB_PATH`            | the server (`/data/blobs` in the image)                                                                                          |

Plus what any instance needs: `API_KEY_SALT` and `MARFA_AUTH_SECRET`, which the image's `NODE_ENV=production` makes the server refuse to boot without, `MARFA_AUTH_BASE_URL`, and `PORT` when `8600` is not wanted. `.env.example` at the repository root carries the rest by name; values live in the deployment's own secret store, never in a file here.

## Building and running

From the repository root:

```bash
docker build -f deploy/Dockerfile --build-arg VERSION_SHA=$(git rev-parse HEAD) -t marfa-server .
docker run --rm -p 8600:8600 -v marfa-data:/data --env-file <your env> marfa-server
```

Without `S3_BUCKET` the container runs the server alone and says so in its log: nothing is streamed and no object store is attached. That is a local trial, not a deployment.

## Restoring by hand

A restore is a Litestream command against the same configuration and environment. To the latest replicated state:

```bash
litestream restore -config deploy/litestream.yml -o restored.db -integrity-check full "$SQLITE_PATH"
```

To a point in time:

```bash
litestream restore -config deploy/litestream.yml -o restored.db -timestamp 2026-09-21T10:00:00Z "$SQLITE_PATH"
```

How fine a point can be named depends on its age. Litestream keeps every one-second sync for five minutes, then compacts them into longer segments (thirty seconds, five minutes, an hour), so a moment in the last five minutes is restorable to the second and an older one to the segment that contains it, back as far as the day of snapshots kept. The drill restores to a moment a few seconds old and asserts the item count it wrote before that moment.

Then boot a server on the restored file with the same bucket and an empty blob folder. The folder is a new disk store, so the log claims nothing for it; `blob-replicate` brings every blob the log names back to it from the object store, on its next run or when asked through `POST /housekeeping/blob-replicate/run`, and `GET /blobs/{hash}` serves from the object store meanwhile. The restored database carries the instance's keys, so no new bootstrap is minted.

## What a point-in-time restore can and cannot promise

The database reaches the bucket within a second of each commit; a blob reaches it when replication next runs, which an upload wakes but which is otherwise `MARFA_BLOB_REPLICATE_INTERVAL_MS` apart. A restore to a moment between the two can name a blob the bucket does not yet hold, and `GET /blobs/{hash}` answers `404` for it until a copy arrives from somewhere. Restoring to the latest state, or to a moment older than the replication cadence, has no such gap. This is documented rather than closed: closing it means writing through to the bucket on every upload, which is not what a scheduled replication is.
