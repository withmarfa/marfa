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

`ci.yml` builds this image and boots it through its entrypoint on every pull request that can affect it, and on every push to `main` (`scripts/check-image.sh`): it becomes healthy, reports the commit it was built from, stops with status `0` inside ten seconds, and on a database another build wrote stays up and unhealthy. That run uses no bucket, so the Litestream half is the restore drill's.

Without `S3_BUCKET` the container runs the server alone and says so in its log: nothing is streamed and no object store is attached. That is a local trial, not a deployment.

## Watching the instance

The image's health check reads `GET /health`, which answers without a credential. It marks the container unhealthy when the answer is `503`, which is when a component is `down`:

| Component        | What it probes                                                    | `down` when                                                         | `degraded` when                                                 |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `database`       | Reads a row.                                                      | The database refuses the read.                                      | It gives no answer within two seconds, as a held database does. |
| `database_write` | Commits one write, at most once every ten seconds.                | The database refuses the write, as a full or read-only volume does. | It commits nothing within two seconds.                          |
| `disk`           | Measures the room on the volume of the database and of the blobs. | Less than 1 MiB is available.                                       | Less than 64 MiB is available, or the room could not be read.   |
| `blob_storage`   | Asks the disk store for a blob.                                   | The disk store refuses.                                             | It gives no answer within two seconds.                          |

A `degraded` instance still answers `200`, because it is still serving. A caller with no credential gets each component's status and no error text. The operator key gets the text too, which is the database's or the operating system's own words and can carry paths. `conformance/spec/instance.md` states the rules.

## Stopping the instance

A stop is `SIGTERM`, which `docker stop` sends and which a container runtime follows with `SIGKILL` after ten seconds by default. The server finishes inside that:

1. It tells every open event stream the instance is stopping, with a closing `stream_incomplete` frame whose `reason` is `server_stopping`. A client reconnects from the cursor in the frame, to the instance once it is back.
2. In the same step it stops taking requests, and waits at most two seconds for those in flight, and at most four seconds for the bulk action and the housekeeping runs in flight, the webhook deliveries among them. A delivery still running when the wait ends is retried after the next start.
3. It closes the database, which moves every write out of the log into the database file unless another connection holds the log, as Litestream does and as a copy's read transaction does, in which case the writes stay in the log and the next start applies them, and flushes its telemetry.

The worst case is under eight seconds, and a stop that completes exits `0`. A stop that does not, because the server or the database would not close in time, exits `1` with a warning in the log naming the step.

## Upgrading

Until the first public release, nothing upgrades a database in place. A build whose database schema differs from your instance's refuses to start on it, changes nothing in the file, and says so in its log. Whether a build's schema differs is not something you can read off its version, so treat each new build as one that might. The build that wrote the file can still read it, so going back to that build brings the instance back.

To carry your data into a new build:

1. With the running build, take an export: `GET /export?format=archive`, with the operator key.
2. Start the new build on a fresh file and an empty blob folder. In the container, that is a new volume. With a bucket, the entrypoint restores the last replica onto an empty volume, and that replica is the old build's database, which the new build refuses, so give the new instance a new bucket.
3. Restore the archive: `POST /admin/restore-archive`, with the operator key.

Until the first public release an archive is read only by the build that wrote it, so the restore in step 3 can refuse the archive. Keep the export and the old build until the restore has answered. `conformance/spec/search-and-filters.md` 27 states that promise.

The restore writes the whole archive in one transaction, so a restore that is refused, fails or is interrupted leaves no rows or types, and you can run it again. Blob bytes an interrupted restore placed are removed by the copy cleanup that the `blob-integrity` and `blob-replicate` housekeeping jobs run, a batch at a time: by default `blob-replicate` removes up to 100 each minute. While the restore runs, `GET /health` answers and reports `database_write` as `degraded`, and a request that writes waits for the restore and is refused with `503 write_contention` after five seconds. With rate limiting on, which is the default, that is every request sent with a key or a token, so let the restore answer before you connect clients. `conformance/spec/search-and-filters.md` 60 to 75 state the restore's limits.

The export reads the whole selection before it sends the first byte, so the response to a large instance starts after a wait. While it runs, it keeps what it has read in the `tmp` folder inside the blob folder, about as much as the archive's text members take uncompressed, and removes it when the response ends. A server that stops during an export leaves the files until its next start, which clears the folder. The export is not a copy of the instance at one instant: a row that is written while it runs is carried as it stood when the export read it. An item created after the export began is not carried. An edge is carried if it was created before the export read its first page of edges and both its items are in the archive, so an edge created while the export read the items is carried, and one created after that is not. Stop your clients before you export if the archive must hold every write. If the server fails after it has started sending, it ends the connection early, so an archive that does not unpack is an incomplete one. `conformance/spec/search-and-filters.md` 76 to 86 state the export's limits.

When the container's server refuses a database, the container stays running and unhealthy with the server's message in its log, rather than stopping. A container that stopped would be started again by its restart policy and refuse again, in a loop. Stop the container to remove it, or point it at another volume. A server that stops for any other reason ends the container with the server's own exit status, and a restart policy may start it again.

The release notes open with the same warning.

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
