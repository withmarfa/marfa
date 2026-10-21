# Deploying the server

The container recipe here runs the server with its database streamed off-site and its blobs replicated to the same bucket, so an instance can be rebuilt from the bucket alone. `conformance/scripts/restore-drill.ts` is the proof: it boots an instance, writes to it, restores a second from the bucket and compares the two to the byte, and the `restore-drill` job in `ci.yml` runs it against a local object store on every pull request that can affect it and every push to `main`.

## What runs in the container

- **The server**, `node dist/index.js`, on SQLite at `SQLITE_PATH` with its disk store at `BLOB_PATH`. Both sit on the volume mounted at `/data`. On Railway the disk store is a volume, not the container's filesystem: a redeploy keeps it, and the bucket holds a second copy of every blob regardless.
- **The CLI**, included at `/usr/local/bin/marfa`, for private setup, key administration and owner recovery. The image defaults to `/data/control/marfa.sock`.
- **Litestream** (`litestream.yml`), a sidecar in the same container. It keeps the database replica at `<S3_PREFIX>/db` in the bucket. `entrypoint.sh` restores the database from that replica when the volume holds none, then runs the server under `litestream replicate -exec`, which streams every committed page to the bucket within a second and takes a snapshot every hour. A day of snapshots is kept, and Litestream removes older ones itself, because the bucket has no lifecycle rules.
- **The blob folder is the server's own housekeeping.** Litestream carries the database only. The `blob-replicate` housekeeping job (listed at `GET /housekeeping`) gives the object store a copy of every blob the disk holds, woken by each upload and otherwise on `MARFA_BLOB_REPLICATE_INTERVAL_MS`; `blob-integrity` checks the copies and replication replaces one that is missing or corrupt. `conformance/spec/stores.md` states the rules.

## The names it needs

The seven names the server reads for its object store are the seven the sidecar reads, from the same environment, so the two cannot name different buckets or prefixes:

| Name                   | Read by                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_BUCKET`            | the server, Litestream                                                                                                                |
| `S3_REGION`            | the server, Litestream (`us-east-1` when unset, which the entrypoint spells out)                                                      |
| `S3_ENDPOINT`          | the server, Litestream                                                                                                                |
| `S3_ACCESS_KEY_ID`     | the server, Litestream                                                                                                                |
| `S3_SECRET_ACCESS_KEY` | the server, Litestream                                                                                                                |
| `S3_FORCE_PATH_STYLE`  | the server, Litestream (path style with an endpoint and virtual hosting without one when unset, which the entrypoint spells out)      |
| `S3_PREFIX`            | the server, Litestream (default `blobs`): the instance keeps everything in the bucket under it, the database replica at `<prefix>/db` |
| `SQLITE_PATH`          | the server, Litestream (`/data/marfa.db` in the image)                                                                                |
| `BLOB_PATH`            | the server (`/data/blobs` in the image)                                                                                               |

**Each instance that shares a bucket needs its own `S3_PREFIX`.** The instance keeps its blobs and its database replica under its prefix, so instances with different prefixes never read or write each other's replica, and a fresh volume restores only the replica under its own prefix. Two instances with the same prefix write one replica, and a fresh volume of either one starts on whichever database was replicated last. A prefix keeps the instances' replicas apart, not their data: each instance holds credentials for the whole bucket, so share a bucket only between instances of one owner. The prefix is segments of letters, digits, `.`, `_` and `-` joined by `/`, such as `trial/blobs`; a `/` at either end is dropped, so `trial/` and `trial` are the same prefix. `instance/replica-under-prefix`, `instance/replica-restores-own` and `instance/replica-other-prefix` in `conformance/spec/instance.md` state the rules.

**The bucket must be on a different site from the instance.** A blob link the object store signs serves the bytes from the bucket's own host, as a download of the blob's recorded type, but a signed link cannot carry the sandbox policy or `nosniff` the instance's own blob answers do (`blobs/download-sandbox` and `blobs/download-nosniff` in `conformance/spec/blobs.md`). Its safety rests on that host being another site: an endpoint under the instance's own domain (say the instance at `marfa.example.com` and the bucket at `files.example.com`) would let an uploaded HTML or SVG blob run as a page of the same site if a browser rendered it.

Plus what any instance needs, which the image's `NODE_ENV=production` makes the server refuse to boot without: `API_KEY_SALT` and `MARFA_AUTH_SECRET`, each generated with `openssl rand -hex 32` (a short, predictable or placeholder value is refused), and `MARFA_AUTH_BASE_URL`, the public URL clients reach the instance at. Set `PORT` when `8600` is not wanted. Every setting the server reads is defined, with its bounds and default, by the settings schema in `packages/server/src/config.ts`, and `.env.example` at the repository root lists each by name; a value outside its bounds stops the server with a message naming the setting. Values live in the deployment's own secret store, never in a file here.

## Running the published image

Every release publishes the server image to `ghcr.io/withmarfa/marfa-server`, for `linux/amd64` and `linux/arm64`, under its version (such as `0.0.14`) and under `latest`. Pull the version you want, not `latest`, so that a restart never changes the build, and so that the old and the new build of an upgrade can each be named:

```bash
docker pull ghcr.io/withmarfa/marfa-server:<version>
docker run --name marfa -d -p 127.0.0.1:8600:8600 -v marfa-data:/data --env-file <your-env-file> ghcr.io/withmarfa/marfa-server:<version>
```

`-p 127.0.0.1:8600:8600` publishes the port on the loopback address only. Docker publishes a bare `-p 8600:8600` on every network interface, and on Linux it does so past the host's firewall rules, so the instance would be open to the whole network. Put a reverse proxy or a tunnel on the same machine in front of the loopback port, and set `MARFA_AUTH_BASE_URL` to the address people reach it at.

The image reports which release it is: `GET /` answers it as `release` beside `version`, which is the commit the image was built from, and `marfa status` shows both. The `marfa` inside the image reports the same release.

`release.yml` builds the image on a runner of each platform, boots it through its entrypoint with `scripts/check-image.sh`, and pushes it only for a tag. After tagging, it pulls the image signed out and boots it again before the release is made public.

## Building the image yourself

To run code that is not a release, build from the repository root:

```bash
docker build -f deploy/Dockerfile --build-arg VERSION_SHA=$(git rev-parse HEAD) -t marfa-server .
docker run --name marfa -d -p 127.0.0.1:8600:8600 -v marfa-data:/data --env-file <your-env-file> marfa-server
```

A build without `VERSION_RELEASE` names no release: `GET /` answers `version` and no `release`, and the `marfa` inside reports `0.0.0`. Only a release build sets it.

`ci.yml` builds this image and boots it through its entrypoint on every pull request that can affect it, and on every push to `main` (`scripts/check-image.sh`): it becomes healthy, reports the commit it was built from, stops with status `0` inside ten seconds, and on a database another build wrote stays up and unhealthy. That run uses no bucket, so the Litestream half is the restore drill's.

Without `S3_BUCKET` the container runs the server alone and says so in its log: nothing is streamed and no object store is attached. That is a local trial, not a deployment.

## Claiming the instance

Open `/setup` at the instance's public URL and enter the setup code printed in its log. Choose the owner's email and password. The claim signs you in and goes on to add a passkey, name the instance and connect something. Setup closes when the claim commits; deleting or revoking ordinary keys never reopens it.

The image includes the CLI. To create a single-use browser setup link from the running container:

```bash
docker exec marfa marfa --socket /data/control/marfa.sock setup open --no-browser
```

Open the printed link in your browser. To finish setup in the terminal instead:

```bash
docker exec -it marfa marfa --socket /data/control/marfa.sock setup claim --email owner@example.com
```

The password prompt is hidden. For automation, use `docker exec -i` with `setup claim --stdin` and supply a JSON object containing `email`, `password` and optional `name` through standard input. Never put passwords or setup codes in command-line arguments. `setup code` replaces the setup code and invalidates earlier setup sessions; a process restart also replaces it while the instance is unclaimed.

After signing in, open `/auth/owner/keys` for API keys, `/auth/owner/connectors` for connectors, and `/auth/owner/export` to export or restore your data. Creating, changing, or revoking a key, disconnecting an app, approving an app for anything beyond reading, and restoring an archive require a sign-in within the last five minutes. If yours is older, the page asks you to confirm it's you with your password or a passkey and then carries on with the change. A restore is judged when it starts, so a long upload is not refused for finishing after the five minutes; the server ends an upload only when no bytes arrive for `MARFA_UPLOAD_IDLE_TIMEOUT_MS`, 60 seconds unless set. The private socket provides the same machine authority without an API key. Ordinary keys and OAuth tokens use explicit [permissions](../GLOSSARY.md#permissions); even a credential with all twelve permissions cannot claim machine authority or recover the owner.

## Recovering the owner

Run this under the same operating-system account as the server:

```bash
docker exec -it marfa marfa --socket /data/control/marfa.sock owner recover
```

Enter the replacement password at the hidden prompt, or use `owner recover --stdin` with a JSON object containing `password`. Recovery changes the existing owner's password and revokes browser sessions. Ordinary keys and approved app access remain in force.

If public HTTP cannot start but the process is still running, the private socket remains available. If the server is stopped, start only the control listener against the same volume and secrets, from the image the instance runs (`<image>`):

```bash
docker stop marfa
docker run -d --name marfa-recovery -v marfa-data:/data \
  --env-file <your-env-file> <image> control-only
docker exec -it marfa-recovery marfa --socket /data/control/marfa.sock owner recover
docker stop marfa-recovery
docker rm marfa-recovery
docker start marfa
```

This recovery process opens no public listener and runs no background jobs. Its HTTP health check is expected to fail. Outside a container, set `MARFA_CONTROL_ONLY=true` for the normal server entry point and use the same database, secrets and socket path.

The server creates the socket directory with mode `0700` and the socket with mode `0600`. The directory must belong to the server account; unsafe ownership, permissions, symlinks or access ACLs prevent startup. Linux requires `getfacl`, supplied by the image's `acl` package. Use an absolute normalized socket path without symlink components, no longer than 103 bytes. `--socket` rejects ordinary URL or credential selection and never falls back to HTTP.

A clean shutdown removes its socket. After a crash, the server replaces a stale control socket when a connection is refused. A live listener or a non-socket file at that path is left intact and prevents startup. A probe timeout or another connection error also prevents startup without removing the path. The listener holds a reservation on a private `<socket-path>.lock` file through startup and shutdown cleanup, so a second process cannot replace its socket while it closes. The file stays on disk after shutdown. Do not remove it while a server is running or starting. A process crash releases the lock automatically. Keep the same account and volume ownership when starting recovery.

## Watching the instance

The image's health check reads `GET /health`, which answers without a credential. It marks the container unhealthy when the answer is `503`, which is when a component is `down`:

| Component        | What it probes                                                    | `down` when                                                         | `degraded` when                                                 |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `database`       | Reads a row.                                                      | The database refuses the read.                                      | It gives no answer within two seconds, as a held database does. |
| `database_write` | Commits one write, at most once every ten seconds.                | The database refuses the write, as a full or read-only volume does. | It commits nothing within two seconds.                          |
| `disk`           | Measures the room on the volume of the database and of the blobs. | Less than 1 MiB is available.                                       | Less than 64 MiB is available, or the room could not be read.   |
| `blob_storage`   | Asks the disk store for a blob.                                   | The disk store refuses, or its folder or marker is gone.            | It gives no answer within two seconds.                          |

A `degraded` instance still answers `200`, because it is still serving. A caller with no credential gets each component's status and no error text. A credential with `instance.read`, or direct owner or local authority, gets the text too, which is the database's or the operating system's own words and can carry paths. `conformance/spec/instance.md` states the rules.

## Sending telemetry to a collector

One setting turns telemetry on: `OTEL_EXPORTER_OTLP_ENDPOINT`, the base URL of an OpenTelemetry (OTLP over HTTP) receiver. With it set, the server exports its traces to `v1/traces` and its logs to `v1/logs` under that URL. With it unset, the server exports nothing and does not load the telemetry SDK. There is no second switch.

| Name                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                            | The base URL of the receiver. Setting it turns telemetry on.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `OTEL_EXPORTER_OTLP_HEADERS`                                             | Headers sent with every export, as `key=value` pairs with percent-encoded values, such as `Authorization=Bearer%20<token>`.                                                                                                                                                                                                                                                                                                                                    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | The full URL for one signal, used as written, when the receiver does not follow the `v1/traces` and `v1/logs` paths. The base setting must also be set.                                                                                                                                                                                                                                                                                                        |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS`   | Headers for one signal, which override `OTEL_EXPORTER_OTLP_HEADERS`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `OTEL_SERVICE_NAME`                                                      | The service name on exported telemetry (`marfa-server` by default). It takes precedence over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`.                                                                                                                                                                                                                                                                                                                   |
| `OTEL_RESOURCE_ATTRIBUTES`                                               | Attributes added to everything exported, as `key=value` pairs with percent-encoded values, such as `deployment.environment=staging` to mark a test instance. One named here replaces the server's own of the same name. Every export also names the instance by `service.instance.id`, the `instance_id` that `GET /` answers, so instances sending to one project can be told apart.                                                                          |
| `MARFA_OTEL_SAMPLE_RATIO`                                                | The share of traces exported (`0.05` by default). A trace that contains an error is exported whatever this says, with the spans that ended before the error and every span after it. To keep memory bounded, the server holds at most 500 spans for one trace, 10,000 spans in all, 1,000 traces that have not yet shown an error, and any one trace for 5 minutes. Past a limit the span that failed is still exported, but the rest of its trace may not be. |

A request's trace has a span for the request and, below it, a span for each storage call the request made, named for the store and the method, such as `items.list`, and for each transaction and read snapshot. A span's name and attributes never include an item's content, a key, a credential or a statement, and the same redaction applies to every span as to every log record. The trace and the request's log lines share the request ID, in the `marfa.request_id` attribute on the span and the `request_id` attribute on each log record, and the log records carry the trace ID. Background jobs make no spans.

**Exception reports are separate.** PostHog's error tracking groups exceptions that PostHog's own client sends, and its documentation describes no way for OTLP logs or traces to become error-tracking issues. To have unhandled errors reach it, set `MARFA_POSTHOG_HOST` and `MARFA_POSTHOG_PROJECT_TOKEN` together, and also `OTEL_EXPORTER_OTLP_ENDPOINT`: the server refuses to start with either of the pair and no endpoint, or with one of the pair alone.

To send everything to PostHog Cloud, set `OTEL_EXPORTER_OTLP_ENDPOINT` to `https://us.i.posthog.com/i` (or `https://eu.i.posthog.com/i`), `OTEL_EXPORTER_OTLP_HEADERS` to `Authorization=Bearer%20` followed by the project token, `MARFA_POSTHOG_HOST` to the same host without `/i`, and `MARFA_POSTHOG_PROJECT_TOKEN` to the project token. PostHog serves traces at `/i/v1/traces` and logs at `/i/v1/logs`, so the base ends in `/i`.

## Stopping the instance

A stop is `SIGTERM`, which `docker stop` sends and which a container runtime follows with `SIGKILL` after ten seconds by default. The server finishes inside that:

1. It tells every open event stream the instance is stopping, with a closing `stream_incomplete` frame whose `reason` is `server_stopping`. A client reconnects from the cursor in the frame, to the instance once it is back.
2. In the same step it stops taking requests, and waits at most two seconds for those in flight, and at most four seconds for the bulk action and the housekeeping runs in flight, the webhook deliveries among them. A delivery still running when the wait ends is retried after the next start.
3. It closes the database, which moves every write out of the log into the database file unless another connection holds the log, as Litestream does and as a copy's read transaction does, in which case the writes stay in the log and the next start applies them, and flushes its telemetry.

The worst case is under eight seconds, and a stop that completes exits `0`. A stop that does not, because the server or the database would not close in time, exits `1` with a warning in the log naming the step.

## Upgrading

Until the first public release, nothing upgrades a database in place. A build whose database schema differs from your instance's refuses to start on it, changes nothing in the file, and says so in its log. Whether a build's schema differs is not something you can read off its version, so treat each new build as one that might. The build that wrote the file can still read it, so going back to that build brings the instance back. A file this build began creating and did not finish, such as one left by a first start that was stopped partway, holds no data; the next start creates the tables it lacks and opens it. A file that lacks tables and holds data was written by another build, and is refused as one.

To carry your data into a new build:

1. With the running build, take an export: `GET /export?format=archive`, with an ordinary credential whose read maps cover everything to export. Note the build's release, which `GET /` answers as `release`: its image, `ghcr.io/withmarfa/marfa-server:<release>`, stays available under that tag, and runs beside the new one on its own volume and port.
2. Start the new build on a fresh file and an empty blob folder. In the container, that is a new volume. With a bucket, the entrypoint restores the replica under the instance's `S3_PREFIX` onto an empty volume. Under the old instance's prefix that replica is the old build's database, which the new build refuses, so give the new instance a prefix of its own, such as `v2/blobs`, or a new bucket.
3. Claim the new instance, sign in as its owner, and restore the archive at `/auth/owner/export`. Alternatively, send `POST /restore` through its private socket.

Until the first public release an archive is read only by the build that wrote it, so the restore in step 3 can refuse the archive. Keep the export and the old build until the restore has answered. `search-and-filters/restore-version` in `conformance/spec/search-and-filters.md` states that promise.

The restore writes the whole archive in one transaction, so a restore that is refused, fails or is interrupted leaves no rows or types, and you can run it again. Blob bytes an interrupted restore placed are removed by the copy cleanup that the `blob-integrity` and `blob-replicate` housekeeping jobs run, a batch at a time: by default `blob-replicate` removes up to 100 each minute. While the restore runs, `GET /health` answers and reports `database_write` as `degraded`, and a request that writes waits for the restore and is refused with `503 write_contention` after five seconds. With rate limiting on, which is the default, that is every request sent with a key or a token, so let the restore answer before you connect clients. The rules under Restore in `conformance/spec/search-and-filters.md` state the restore's limits.

The export reads the whole selection before it sends the first byte, so the response to a large instance starts after a wait. While it runs, it keeps what it has read in the `tmp` folder inside the blob folder, about as much as the archive's text members take uncompressed, and removes it when the response ends. A server that stops during an export leaves the files until its next start, which clears the folder. The export is not a copy of the instance at one instant: a row that is written while it runs is carried as it stood when the export read it. An item created after the export began is not carried. An edge is carried if it was created before the export read its first page of edges and both its items are in the archive, so an edge created while the export read the items is carried, and one created after that is not. Stop your clients before you export if the archive must hold every write. If the server fails after it has started sending, it ends the connection early, so an archive that does not unpack is an incomplete one. The rules under Export in `conformance/spec/search-and-filters.md` state the export's limits.

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

Restore from any of these like this. **If the bucket is still live and holds writes newer than the copy, read [Restore a backup that is older than the bucket](#restore-a-backup-that-is-older-than-the-bucket) first.** These steps start the copy on the bucket's own prefix, which makes the copy the bucket's newest copy of the database.

1. Stop the instance.
2. Put the copied database file, the log (when the copy has one) and the blob folder where `SQLITE_PATH` and `BLOB_PATH` name. Do not restore a `marfa.db-shm` file, which is rebuilt at start.
3. Start the instance with the same `API_KEY_SALT` and `MARFA_AUTH_SECRET` as before, and read `GET /health`.

The instance applies the log at start. A copy's integrity can be checked first with `sqlite3 marfa.db "PRAGMA integrity_check"`, which answers `ok`.

`GET /export` and `POST /restore` move data between machines and between builds that share a schema. They are not a machine backup. `conformance/spec/instance.md` states what a restore promises.

## Restore a backup that is older than the bucket

A machine backup or a Railway volume backup is older than the bucket's copy of the database, which Litestream updates every second (`sync-interval: 1s` in `litestream.yml`). **If you start an older copy with the bucket's current `S3_PREFIX`, the copy becomes the bucket's newest copy of the database.** Litestream logs `detected database behind replica`, carries on, and uploads the copy's later transactions on top of the replica. A restore from the bucket then returns the copy plus the writes made after you started it. The writes made between the backup and the restore stay in the bucket only at earlier transaction points, which Litestream's own retention removes in time.

A point-in-time restore of the bucket onto the same prefix does the same thing, because the restored file is also behind the replica.

Going back to an older state loses the later writes from the instance, as you intend. The steps in this section also keep them in the bucket. They give the restored instance a new prefix, so the old prefix is left as it was and nothing writes to it.

### Start a backup under a new prefix

1. Note the instance's current `S3_PREFIX`. It is `blobs` when you have not set one.
2. Stop the instance.
3. Choose a new prefix that no instance has used, such as `restored/blobs`. [The names it needs](#the-names-it-needs) gives the rules for a prefix.
4. Put the copied database file, the log (when the copy has one) and the blob folder where `SQLITE_PATH` and `BLOB_PATH` name. Do not restore a `marfa.db-shm` file.
5. Set `S3_PREFIX` to the new prefix. Leave the bucket, its credentials, `API_KEY_SALT` and `MARFA_AUTH_SECRET` as they were.
6. Start the instance. In its log, check that the `replicating to` line shows `path=` followed by the new prefix and `/db`, such as `path=restored/blobs/db`, and that no `detected database behind replica` line appears. Then read `GET /health`.

On Railway, make the same change through the dashboard: see [Restore a volume backup](railway.md#restore-a-volume-backup).

### Go back to a point in time using the bucket

Use this when you have no copy of the volume, or the moment you want is not in one. It keeps the instance's own blob folder.

1. Stop the instance.
2. Restore the database from the bucket's current prefix to a file, as in [Restoring by hand](#restoring-by-hand), with `-o` and `-timestamp`. Check the file with `sqlite3 restored.db "PRAGMA integrity_check"`.
3. In the data directory, delete `marfa.db`, `marfa.db-wal` and `marfa.db-shm`, then move `restored.db` to `SQLITE_PATH`. Leave the blob folder.
4. Choose and set a new `S3_PREFIX`, start the instance and check its log, as in steps 3, 5 and 6 above.

### What the steps leave behind

- **The new prefix is now the instance's.** Every later recovery, including a fresh volume and [Restoring by hand](#restoring-by-hand), uses the new prefix. The `blob-replicate` job copies the blobs the disk holds to the new prefix. `GET /blobs/stores` lists the old prefix's object store as detached, because the configuration no longer names it.
- **Files saved after the backup are not in the restored instance.** The restored database has no record of them. Their bytes are in the old prefix only when `blob-replicate` had copied them there before the old instance stopped, because it copies a blob after the upload and not during it. A blob it had not yet copied is only on the old volume. The server keeps a blob in the bucket as one object named `<prefix>/<sha-256 hex>`, beside a `<prefix>/.marfa-store` object that names the store, and it finds a blob through the locations recorded in its database. It never looks under another prefix, so these files do not come back by themselves. They are not lost while you keep the old prefix and the old volume: the prefix holds the database that names them and the bytes it received.
- **The old prefix holds the newer history.** To read it, start a second instance on an empty volume with `S3_PREFIX` set to the old prefix, the same bucket and credentials, the same `API_KEY_SALT` and `MARFA_AUTH_SECRET` as the original (without them its keys and sessions do not work), and its own port and address. It restores the old prefix's latest database and serves its blobs from there. Then download the files you need from it and upload them to the restored instance. A running server does more than serve: it replicates to the old prefix, delivers the webhooks the old database still has pending, and runs its housekeeping on the old history. Stop it once you have the files, and never run it at the same time as another instance on that prefix. The items that name those files stay in the second instance's database, and this guide gives no step for bringing them into the restored one. It gives no step for copying objects between prefixes either, because neither has been run against the server.
- **Nothing removes the old prefix.** Delete its objects yourself, from the bucket, when you no longer need that history.

## Restoring by hand

A restore is a Litestream command against the same configuration and environment, which reads the replica at `<S3_PREFIX>/db` in `S3_BUCKET`. Litestream expands an unset name to nothing, so set `S3_PREFIX` to the instance's prefix, without a `/` at either end, even when it is the default `blobs`. To the latest replicated state:

```bash
S3_PREFIX=blobs litestream restore -config deploy/litestream.yml -o restored.db -integrity-check full "$SQLITE_PATH"
```

To a point in time:

```bash
S3_PREFIX=blobs litestream restore -config deploy/litestream.yml -o restored.db -timestamp 2026-09-21T10:00:00Z "$SQLITE_PATH"
```

Replace `blobs` with the instance's own prefix when it has another.

How fine a point can be named depends on its age. Litestream keeps every one-second sync for five minutes, then compacts them into longer segments (thirty seconds, five minutes, an hour), so a moment in the last five minutes is restorable to the second and an older one to the segment that contains it, back as far as the day of snapshots kept. The drill restores to a moment a few seconds old and asserts the item count it wrote before that moment.

Then boot a server on the restored file with the same bucket and prefix and an empty blob folder. That is right for the latest state. A file older than the bucket's newest copy needs a new prefix instead; see [Restore a backup that is older than the bucket](#restore-a-backup-that-is-older-than-the-bucket). The folder is a new disk store, so the log claims nothing for it; `blob-replicate` brings every blob the log names back to it from the object store, on its next run or when asked through `POST /housekeeping/blob-replicate/run`, and `GET /blobs/{hash}` serves from the object store meanwhile. The restored database carries the owner claim and ordinary credentials, so setup stays closed.

## What a point-in-time restore can and cannot promise

The database reaches the bucket within a second of each commit; a blob reaches it when replication next runs, which an upload wakes but which is otherwise `MARFA_BLOB_REPLICATE_INTERVAL_MS` apart. A restore to a moment between the two can name a blob the bucket does not yet hold, and `GET /blobs/{hash}` answers `404` for it until a copy arrives from somewhere. Restoring to the latest state, or to a moment older than the replication cadence, has no such gap. This is documented rather than closed: closing it means writing through to the bucket on every upload, which is not what a scheduled replication is.
