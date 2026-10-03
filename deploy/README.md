# Deploying the server

The container recipe here runs the server with its database streamed off-site and its blobs replicated to the same bucket, so an instance can be rebuilt from the bucket alone. `conformance/scripts/restore-drill.ts` is the proof: it boots an instance, writes to it, restores a second from the bucket and compares the two to the byte, and the `restore-drill` job in `ci.yml` runs it against a local object store on every pull request that can affect it and every push to `main`.

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

**The bucket must be on a different site from the instance.** A blob link the object store signs serves the bytes from the bucket's own host, as a download of the blob's recorded type, but a signed link cannot carry the sandbox policy or `nosniff` the instance's own blob answers do (`conformance/spec/blobs.md` 25). Its safety rests on that host being another site: an endpoint under the instance's own domain (say the instance at `marfa.example.com` and the bucket at `files.example.com`) would let an uploaded HTML or SVG blob run as a page of the same site if a browser rendered it.

Plus what any instance needs, which the image's `NODE_ENV=production` makes the server refuse to boot without: `API_KEY_SALT` and `MARFA_AUTH_SECRET`, each generated with `openssl rand -hex 32` (a short, predictable or placeholder value is refused), and `MARFA_AUTH_BASE_URL`, the public URL clients reach the instance at. Set `PORT` when `8600` is not wanted. Every setting the server reads is defined, with its bounds and default, by the settings schema in `packages/server/src/config.ts`, and `.env.example` at the repository root lists each by name; a value outside its bounds stops the server with a message naming the setting. Values live in the deployment's own secret store, never in a file here.

## Building and running

From the repository root:

```bash
docker build -f deploy/Dockerfile --build-arg VERSION_SHA=$(git rev-parse HEAD) -t marfa-server .
docker run --rm -p 8600:8600 -v marfa-data:/data --env-file <your env> marfa-server
```

Without `S3_BUCKET` the container runs the server alone and says so in its log: nothing is streamed and no object store is attached. That is a local trial, not a deployment.

## Backing up the machine

Litestream and the bucket are the recovery path that needs no care. If you also back up the machine the instance runs on, with Time Machine, a host's disk snapshots or a file-copying tool, back up two things:

- **The data directory**, which is the volume mounted at `/data` in the image. It holds the database (`SQLITE_PATH`), the log beside it named `marfa.db-wal` that holds writes not yet moved into the database, and the blob folder (`BLOB_PATH`). Nothing else on the machine belongs to the instance. The OCR model cache under the directory is downloaded again when it is missing and can be left out.
- **The two secrets**, `API_KEY_SALT` and `MARFA_AUTH_SECRET`, in the deployment's secret store. They are not in the data directory. The database holds a hash of each key made with `API_KEY_SALT`, so a restore without it holds every key and accepts none, and without `MARFA_AUTH_SECRET` every signed-in session ends.

How the copy is taken decides whether it restores. These restore to a working instance with every write the instance had acknowledged before the copy began:

| How the copy is taken                                                                                                        | Why it is safe                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A snapshot of the volume or filesystem, including a Time Machine backup of an APFS volume and a host's disk snapshot         | It is an image of the directory at one instant. SQLite recovers from the log as it does after a crash, and every acknowledged write was synced to the disk before the instance answered. |
| Stopping the instance, copying the directory, then starting it                                                               | A stop moves every write into the database file. Copy `marfa.db-wal` as well when it is there, because a replicator that holds the log can leave writes in it.                           |
| Copying the files one after another while the instance runs, with a read transaction held on the database for the whole copy | The log is not restarted while a reader is on it. Hold the transaction, copy the database file, then the log, then the blob folder, then release it.                                     |

Copying the files one after another while the instance runs, with no reader held, does not restore. A checkpoint between reading the database file and reading the log leaves a database that either will not open or has lost the writes between the two. Nothing the server does can prevent this, because the copying tool runs outside it. Copy the database file and the log before the blob folder: an upload's file is written before the row that names it, so every blob a copied row names is then in the copy. A file in the copy that no row names is removed by the `blob-orphans` job.

To hold the transaction on a machine that has the `sqlite3` command and reaches the same file system the instance writes to:

```bash
sqlite3 /data/marfa.db "BEGIN; SELECT count(*) FROM sqlite_master;" ".shell cp /data/marfa.db /data/marfa.db-wal /backup/" ".shell cp -R /data/blobs /backup/" "COMMIT;"
```

Restore from any of these like this:

1. Stop the instance.
2. Put the copied database file, the log (when the copy has one) and the blob folder where `SQLITE_PATH` and `BLOB_PATH` name. Do not restore a `marfa.db-shm` file, which is rebuilt at start.
3. Start the instance with the same `API_KEY_SALT` and `MARFA_AUTH_SECRET` as before, and read `GET /health`.

The instance applies the log at start. A copy's integrity can be checked first with `sqlite3 marfa.db "PRAGMA integrity_check"`, which answers `ok`.

`GET /export` and `POST /admin/restore-archive` move data between machines and between builds that share a schema. They are not a machine backup. `conformance/spec/instance.md` states what a restore promises.

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
