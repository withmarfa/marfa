# Run the Marfa server

The Marfa server is one program, `marfa-server`. It keeps its data in a SQLite database and a folder of files, and it listens on one port. The `marfa` command line installs, starts, stops, upgrades and claims it.

This page covers a server on a Mac or a Linux machine, natively or in Docker, and the release image on its own. To run Marfa on Railway, see [Create a personal Marfa instance on Railway](railway.md).

## Install the programs

Each release has one archive per platform, `marfa-<version>-<platform>.tar.gz`, where `<platform>` is `darwin-arm64`, `linux-x86_64` or `linux-aarch64`. An archive holds `marfa`, `marfa-server` and `NOTICES.txt`, the licenses of what the programs contain. Intel Macs aren't supported.

`scripts/install.sh` downloads the archive for your machine, checks it against the release's checksum file, and installs both programs side by side, in `~/.local/bin` unless `MARFA_INSTALL_DIR` names another folder. `MARFA_VERSION` chooses a release; without it, the script installs the latest.

```bash
curl -fsSL https://raw.githubusercontent.com/withmarfa/marfa/main/scripts/install.sh | sh
```

The two programs must be the same release. `marfa` finds `marfa-server` only beside itself.

## Install the server

```bash
marfa server install
```

By default the command runs the server as a service of your machine, without Docker:

- **macOS:** a launchd agent named `so.marfa.server.<name>`, started when you sign in. Run the command as the person who uses the server, not with `sudo`. The server's output goes to `~/Library/Logs/Marfa`.
- **Linux:** a systemd user service named `marfa-<name>.service`, with lingering turned on so it starts at boot. Run as root, the command installs a system service that runs under a `marfa` account instead.

The command asks how you reach the server, writes the settings, starts the service, and prints a link that claims the server. Running it again changes only what isn't already as you asked, and never the secrets or the runtime.

The install lives in one folder: `~/marfa-server`, or `/var/lib/marfa-server` for root on Linux. Choose another with `--dir`; the folder's path plus `/data/control/marfa.sock` must be 100 bytes or fewer.

| Path                      | What it holds                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marfa.env`               | The server's settings, including its two secrets, `MARFA_KEY_SALT` and `MARFA_AUTH_SECRET`. Only you can read it. **Keep a copy outside the folder:** the server refuses its data without the salt, and rejects every key if the salt differs. |
| `.env`                    | What the `marfa server` commands record about the install: its name, release, port and how you reach it. It holds no secret, and the server doesn't read it.                                                                                   |
| `data/marfa.db`           | The database.                                                                                                                                                                                                                                  |
| `data/blobs/`             | The files.                                                                                                                                                                                                                                     |
| `data/control/marfa.sock` | The private socket that the claim and recovery commands use.                                                                                                                                                                                   |

The folder decides the port, the listen address, and the paths of the data and the socket, so a `marfa.env` that sets one of them is refused. The server listens on `127.0.0.1`, on port 8600 or the next free port; choose a port with `--port`. To have a secrets manager write `marfa.env`, use `--external-settings`; the command then only checks the file.

### Choose how you reach the server

The server doesn't terminate TLS: it answers plain HTTP on its port. `--access` says what provides HTTPS in front of it, and so which caller addresses the server believes.

| `--access`   | How you reach the server                                                                                           | What the install sets for proxy trust                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `local`      | Only this machine, at `http://localhost`.                                                                          | Nothing.                                                                                              |
| `tailscale`  | Devices on your tailnet, through Tailscale Serve, at this machine's `ts.net` name.                                 | `MARFA_TRUSTED_PROXY_CIDRS` is the loopback range.                                                    |
| `cloudflare` | Anywhere, through a Cloudflare Tunnel on this machine, at your own address. Needs `--address`.                     | `MARFA_TRUSTED_PROXY_HEADER=CF-Connecting-IP`, and `MARFA_TRUSTED_PROXY_CIDRS` is the loopback range. |
| `proxy`      | Anywhere, through a reverse proxy on this machine, such as Caddy or nginx, at your own address. Needs `--address`. | `MARFA_TRUSTED_PROXY_CIDRS` is the loopback range.                                                    |

For `cloudflare` and `proxy`, point the tunnel or proxy at `http://127.0.0.1:<port>`; the command prints the address. For `tailscale`, the command sets up Tailscale Serve, which needs Tailscale installed and signed in, with MagicDNS and HTTPS certificates turned on. `--https-port` changes the port Tailscale serves on from 443.

A passkey is bound to the address the owner signs in at, so that address must be the exact HTTPS address people use, including the port when it isn't 443. The install sets it from `--address` or from Tailscale. `http://localhost` is a secure context, so passkeys also work on the machine that runs the server.

### Run the server in Docker

`marfa server install --docker` runs the release image `ghcr.io/withmarfa/marfa-server` instead, for the same release as your `marfa`; choose another with `--release`. The install folder then holds a `compose.yaml` that is the same for every install, and the data lives in the Docker volume `<name>-data`. The container is named `<name>`, restarts unless you stop it, and publishes its port on `127.0.0.1` only. For proxy trust, the command makes a Docker network of its own, `<name>-net`, and trusts only that network's gateway, the address a tunnel or proxy on the host connects to the container from. Another container on the network isn't trusted. Docker Desktop and OrbStack forward a container's connection to `host.docker.internal` through the gateway too, so on a Mac a container that connects to the published port that way is trusted.

An install keeps its runtime. To change it, export the data and restore it into a new install.

## Manage the server

- `marfa server status` shows whether the server runs, its release and address, and whether it has an owner. When it isn't running, it shows its last log.
- `marfa server start` starts the server, and `marfa server stop` stops it, keeping the service, the data and the settings.
- `marfa server run` runs the server in the foreground. The service runs this.
- `marfa server upgrade` moves the server to a newer release. See [Upgrade](#upgrade).
- `marfa server uninstall` removes the service. See [Remove the server](#remove-the-server).

Each takes `--dir` when the install isn't in the default folder, and `marfa server <command> --help` lists its options.

## Claim the server

`marfa server install` prints a link that claims the server. Open it within five minutes, and choose the owner's email and password. The link works once; run the command again for a new one.

For a server you run another way, use the private socket, under the same operating system account as the server. For a native install, the socket is `data/control/marfa.sock` in the install folder; in the container, it's `/data/control/marfa.sock`.

```bash
marfa --socket <socket> setup open --address https://marfa.example.com --no-browser
```

Open the link it prints. `--address` sets the address people sign in at before the link is made; it doesn't move the address of a server that already has an owner. To finish in the terminal instead, run `setup claim --address <address> --email owner@example.com`, which asks for the password at a hidden prompt. For the container, run the command with `docker exec <container> marfa ...`, adding `-it` for `setup claim`.

Creating or changing a key, approving an app and restoring an archive need a sign-in within the last five minutes. If yours is older, the page asks you to confirm it's you with your password or a passkey.

## Recover the owner

Under the same operating system account as the server, run the following and enter the new password at the hidden prompt:

```bash
marfa --socket <socket> owner recover
```

Recovery changes the owner's password and ends browser sessions. Keys and approved apps keep working. To supply the password without a prompt, use `owner recover --stdin` with a JSON object that holds `password`. If the server can't start but you need the socket, start it with `MARFA_CONTROL_ONLY=true`, which opens the private socket and nothing else.

## Upgrade

Before you upgrade, note the release you run (`marfa server status` shows it) and keep an export or a backup from it.

- **Native:** install the newer release of both programs, for example with `scripts/install.sh`, then run `marfa server upgrade`. The command restarts the service on the installed programs, and refuses a release older than the one the install records.
- **Docker:** run `marfa server upgrade --release <version>`. Without `--release`, it moves to the release of your `marfa`.

When the new release's database schema is newer than the database's, the server updates the database in place at its first start, in one transaction, so a failure or a stop partway leaves it as it was. A release with the same schema changes nothing. Before it changes a database that holds data, the server copies it to `marfa.db.before-upgrade` beside it (in `data/` for a native install, in `/data` in the container), and its log records the copy's path. The copy replaces the one from any earlier upgrade, so it takes you back one upgrade only; delete it once you won't go back.

The copy needs as much free disk as the data in the database, plus the disk reserve (the `disk_reserve_bytes` setting, 128 MiB unless you set another). If less is free, or the copy can't be written, the server changes nothing and exits with status 1, and the service manager or Docker starts it again, to the same refusal, until there's room.

The server also refuses a database that a newer release wrote, and one whose schema matches none it knows. It changes nothing, says in its log why and what to do, and exits with status 78. `marfa server run` then stays up and idle, so nothing starts the server again into the same refusal. Read the reason with `marfa server status`, or `docker logs <name>`. A refused update leaves the database as the earlier release left it, so to go back:

- **Native:** run `marfa server stop`, install the earlier release again, then run `marfa server start`.
- **Docker:** set `MARFA_RELEASE` back to the earlier release in the install folder's `.env`, then run `marfa server start`.

To go back after an update that succeeded, use the copy:

1. Run `marfa server stop`.
1. Delete `marfa.db-wal` and `marfa.db-shm`. SQLite applies a log it finds beside a database file, even one that belongs to a newer state.
1. Replace `marfa.db` with `marfa.db.before-upgrade`.
1. Return to the earlier release as for a refused update, above.

Writes made since the update aren't in the copy. In a Docker install the files are in the volume `<name>-data`, and the image has no shell: make the change from another container that mounts the volume, and leave the files owned by user 65532.

## Remove the server

```bash
marfa server uninstall
```

The command removes the service and keeps the data, the settings and the secrets, so `marfa server install` brings the same server back. Add `--delete-data` to remove the data and `marfa.env` as well. This can't be undone.

## Run the release image yourself

Every release publishes `ghcr.io/withmarfa/marfa-server:<version>` for `linux/amd64` and `linux/arm64`. Use the version, never `latest`, so that a restart doesn't change the build under your database. The image holds the release's own static `marfa-server` and `marfa` on a base with no shell, and runs as user 65532, not root.

```bash
docker run --name marfa -d -p 127.0.0.1:8600:8600 -v marfa-data:/data \
  ghcr.io/withmarfa/marfa-server:<version>
```

- **Publish the port on `127.0.0.1`.** A bare `-p 8600:8600` is open to every network the machine is on. Put a proxy or tunnel on the machine in front of it.
- **Publish another host port, and leave `MARFA_PORT` alone.** The image's health check runs `marfa status` against port 8600 inside the container. For port 9000 on the host, use `-p 127.0.0.1:9000:8600`.
- **A folder mounted at `/data` must be writable by user 65532 and readable by no other account** (`chown 65532 <folder>` and `chmod 700 <folder>`), or run the container as the folder's owner with `--user`. The server writes the database and the files readable by other accounts on the host, so the folder is what keeps them private. A named volume works as it is.
- **Secrets:** on a first start without `MARFA_KEY_SALT` and `MARFA_AUTH_SECRET`, the server makes them and keeps them in `/data/marfa.secrets`, readable by its user alone. Keep that file with the data. A database without its salt is refused.

The image sets `MARFA_LISTEN_HOST`, `MARFA_PORT`, `MARFA_DATABASE_PATH`, `MARFA_BLOB_PATH` and `MARFA_CONTROL_SOCKET`; [Settings](#settings) gives the values. To pass more settings, use `-e` or `--env-file`.

## Build the programs and the image yourself

To run code that isn't a release, build the programs for a target: `aarch64-apple-darwin`, `aarch64-unknown-linux-musl` or `x86_64-unknown-linux-musl`. The script needs the tools that `core/marfa-enrichment/native/release.sh <target> --needs` lists, and Docker for the Linux targets:

```bash
MARFA_NATIVE_ROOT=<folder> scripts/release/build-programs.sh <target>
```

`<folder>` holds downloads and work, and the result is in `<folder>/out/<target>/`: `marfa`, `marfa-server` and `NOTICES.txt`. A build from the repository reports version `0.0.0`.

To build the image from those programs, put the output of the two Linux targets in a build context as `amd64/` (`x86_64-unknown-linux-musl`) and `arm64/` (`aarch64-unknown-linux-musl`), then run:

```bash
docker buildx build --load -f deploy/Dockerfile --platform linux/amd64 \
  --build-arg VERSION=0.0.0 -t marfa-server <context>
scripts/check-image.sh marfa-server 0.0.0
```

`scripts/check-image.sh` boots the image on a fresh volume with a read-only root file system and checks that it becomes healthy, runs as a user that isn't root, keeps what it makes on the volume, stops cleanly, and is the same instance when started again.

## Settings

The server reads its start-only settings from its environment when it starts. The table lists the ones you're most likely to set or meet; the full list, with every allowed value, is the table under "Start-only settings" in [`conformance/spec/instance.md`](../conformance/spec/instance.md#start-only-settings). None is required: a first start makes the two secrets when you don't set them. The server's other settings, such as `disk_reserve_bytes`, are stored in the database. A value outside its rule stops the server with a message that names the setting.

| Name                         | Default in the program                   | Set by the image           | What it does                                                                                                                                                             |
| ---------------------------- | ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MARFA_PORT`                 | `8600`                                   | `8600`                     | The port the server listens on.                                                                                                                                          |
| `MARFA_LISTEN_HOST`          | All interfaces                           | `0.0.0.0`                  | The address the server listens on. A native install sets `127.0.0.1`.                                                                                                    |
| `MARFA_DATABASE_PATH`        | `./data/marfa.db`                        | `/data/marfa.db`           | Where the database is.                                                                                                                                                   |
| `MARFA_BLOB_PATH`            | `./data/blobs`                           | `/data/blobs`              | Where the server keeps files.                                                                                                                                            |
| `MARFA_CONTROL_SOCKET`       | `control/marfa.sock` beside the database | `/data/control/marfa.sock` | The private socket: an absolute path of 103 bytes or fewer, with no symbolic link in it.                                                                                 |
| `MARFA_KEY_SALT`             | Made on a first start                    | Not set                    | The secret keys are stored under. Changing it ends every key.                                                                                                            |
| `MARFA_AUTH_SECRET`          | Made on a first start                    | Not set                    | The secret sign-in is signed with, at least 32 characters. Changing it ends every session.                                                                               |
| `MARFA_TRUSTED_PROXY_CIDRS`  | Not set                                  | Not set                    | Comma-separated ranges of the proxies whose `X-Forwarded-For` the server believes.                                                                                       |
| `MARFA_TRUSTED_PROXY_HEADER` | Not set                                  | Not set                    | A header the edge in front overwrites with the caller's address, such as `CF-Connecting-IP`. The server believes it only from the ranges in `MARFA_TRUSTED_PROXY_CIDRS`. |
| `MARFA_BACKUP_PATH`          | Not set                                  | Not set                    | An existing folder, outside the data, that the server backs itself up to.                                                                                                |
| `S3_BUCKET`                  | Not set                                  | Not set                    | An S3-compatible bucket for the files and the backups, with the other `S3_*` settings.                                                                                   |
| `MARFA_CONTROL_ONLY`         | `false`                                  | Not set                    | Opens the private socket and nothing else, for [recovery](#recover-the-owner).                                                                                           |

- Set `MARFA_TRUSTED_PROXY_HEADER` together with `MARFA_TRUSTED_PROXY_CIDRS`, naming the ranges the edge connects from, such as `127.0.0.0/8,::1/128` for a tunnel to a native server on the same machine. The server refuses to start with the header alone. With neither proxy setting, the server ignores `X-Forwarded-For`.
- Set `MARFA_BACKUP_PATH`, an absolute path, or `S3_BUCKET`, not both. With neither, the server keeps no backup.
- Serve an object store from a different site from your instance's address: a link to a file in the store is safe only because the store serves it from its own origin.
- `OTEL_EXPORTER_OTLP_ENDPOINT` sets where an OpenTelemetry receiver is, `MARFA_POSTHOG_HOST` with `MARFA_POSTHOG_PROJECT_TOKEN` sets where exception reports go, and `OTEL_SDK_DISABLED=true` turns telemetry off.
