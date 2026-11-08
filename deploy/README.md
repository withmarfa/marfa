# Run the Marfa server

The Marfa server is one program, `marfa-server`. It keeps its data in a SQLite database and a folder of files, and it listens on one port. The `marfa` command line installs it, starts and stops it, and claims it. This page covers installing the server on a Mac or Linux machine, running the release image in Docker, and reaching, claiming, upgrading and removing the server. To run Marfa on Railway, see [Create a personal Marfa instance on Railway](railway.md). Backups to a bucket are not covered here yet.

## Install the programs

Each release has one archive per platform, named `marfa-<version>-<platform>.tar.gz`, where `<platform>` is `darwin-arm64`, `linux-x86_64` or `linux-aarch64`. An archive holds `marfa`, `marfa-server` and `NOTICES.txt`, the licenses of what the programs contain. Intel Macs aren't supported.

`scripts/install.sh` downloads the archive for your machine, checks it against the release's checksum file, and installs `marfa` and `marfa-server` side by side:

```bash
curl -fsSL https://raw.githubusercontent.com/withmarfa/marfa/main/scripts/install.sh | sh
```

The two programs are released together and must be the same release. `marfa` finds `marfa-server` only beside itself.

## Install the server

```bash
marfa server install
```

By default the command runs the server as a service of your machine, without Docker:

- **macOS:** a launchd agent named `so.marfa.server.<name>`, started when you sign in. Run the command as the person who uses the server, not with `sudo`. The server's output goes to `~/Library/Logs/Marfa`.
- **Linux:** a systemd user service named `marfa-<name>.service` with lingering turned on, so it starts at boot. When you run the command as root, it installs a system service that runs under a `marfa` account instead. The server needs the `acl` package (`getfacl`) to check its private socket.

The command asks how you reach the server, writes the settings, starts the service, and prints a link that claims the server. [Claim the server](#claim-the-server) says what to do with the link. Running the command again changes only what isn't already as you asked, and never the secrets or the runtime.

The install lives in one folder: `~/marfa-server`, or `/var/lib/marfa-server` for root on Linux. Choose another with `--dir`; the path of the folder plus `/data/control/marfa.sock` must be 100 characters or fewer.

| Path                      | What it holds                                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marfa.env`               | The server's settings, including its two secrets, `API_KEY_SALT` and `MARFA_AUTH_SECRET`. Only you can read it. **Keep a copy outside the folder.** The server refuses data that it is started on without the secrets, or rejects every key if they differ. |
| `.env`                    | What the `marfa server` commands record about the install: its name, release, port and how you reach it. It holds no secret, and the server doesn't read it.                                                                                                |
| `data/marfa.db`           | The database.                                                                                                                                                                                                                                               |
| `data/blobs/`             | The files.                                                                                                                                                                                                                                                  |
| `data/control/marfa.sock` | The private socket that claim and recovery commands use.                                                                                                                                                                                                    |

The folder decides the port, the listen address, and the paths of the data and the socket. The server listens on `127.0.0.1`, on port 8600 or the next free port. Choose a port with `--port`. A `marfa.env` that sets one of these settings is refused. To have a secrets manager write `marfa.env`, use `--external-settings`; the command then only checks the file.

### Choose how you reach the server

`--access` says how people and devices reach the server. It also decides which caller addresses the server believes, because the server doesn't terminate TLS.

| `--access`   | How you reach the server                                                                                           | What the install sets for proxy trust        |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `local`      | Only this machine, at `http://localhost`.                                                                          | Nothing.                                     |
| `tailscale`  | Devices on your tailnet, through Tailscale Serve, at this machine's `ts.net` name.                                 | `TRUSTED_PROXY_CIDRS` is the loopback range. |
| `cloudflare` | Anywhere, through a Cloudflare Tunnel on this machine, at your own address. Needs `--address`.                     | `TRUSTED_PROXY_HEADER=CF-Connecting-IP`.     |
| `proxy`      | Anywhere, through a reverse proxy on this machine, such as Caddy or nginx, at your own address. Needs `--address`. | `TRUSTED_PROXY_CIDRS` is the loopback range. |

For `cloudflare` and `proxy`, point the tunnel or proxy at `http://127.0.0.1:<port>`; the command prints the address. For `tailscale`, the command sets up Tailscale Serve, which needs Tailscale installed and signed in with MagicDNS and HTTPS certificates turned on. `--https-port` changes the port Tailscale serves on from 443.

### Run the server in Docker

`marfa server install --docker` runs the release image `ghcr.io/withmarfa/marfa-server` in Docker instead, for the same release as your `marfa`. Choose another with `--release`. The install folder then holds a `compose.yaml` that is the same for every install, and the data lives in the Docker volume `<name>-data`. The container restarts unless you stop it, and publishes its port on `127.0.0.1` only. For proxy trust, the command makes a Docker network of its own, `<name>-net`, and trusts that network's range. An install keeps its runtime. To change it, export the data and restore it into a new install.

### Manage the server

| Command                  | What it does                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `marfa server status`    | Shows whether the server runs, its release and address, and whether it has an owner. When it isn't running, it shows its last log. |
| `marfa server start`     | Starts the server.                                                                                                                 |
| `marfa server stop`      | Stops the server and keeps the service, the data and the settings.                                                                 |
| `marfa server run`       | Runs the server in the foreground. The service runs this.                                                                          |
| `marfa server upgrade`   | Moves the server to a newer release. See [Upgrade](#upgrade).                                                                      |
| `marfa server uninstall` | Removes the service. See [Remove the server](#remove-the-server).                                                                  |

Each takes `--dir` when the install isn't in the default folder.

## Reach the server over HTTPS

The server doesn't terminate TLS. It answers plain HTTP on its port, so put something in front of it that provides HTTPS:

- **Tailscale Serve:** `marfa server install --access tailscale` sets it up. The address works on your tailnet only.
- **A Cloudflare Tunnel** or **a reverse proxy** such as Caddy, on the same machine, for an address on the internet.
- **A platform** that provides HTTPS, such as Railway.

`http://localhost` is a secure context, so passkeys work on the machine that runs the server without any of this.

A passkey is bound to the address the owner signs in at. Set that address to the exact HTTPS address people use, including the port when it isn't 443. The install sets it from `--address` or from Tailscale. When you set up the server another way, pass it to the claim command, as the next section shows. A passkey made at one address doesn't work at another.

## Claim the server

`marfa server install` claims the server for you: open the link it prints, which works once for five minutes, and choose the owner's email and password. Run the command again for a new link.

For a server you run another way, use the private socket. The commands run under the same operating system account as the server. For a native install, the socket is `data/control/marfa.sock` in the install folder; in the container, it's `/data/control/marfa.sock`:

```bash
marfa --socket <socket> setup open --address https://marfa.example.com --no-browser
```

Open the link it prints. `--address` sets the address people sign in at before the link is made. It doesn't move the address of a server that already has an owner, because that server keeps the address its owner signs in at. To finish in the terminal, use `setup claim --address <address> --email owner@example.com`; the password prompt is hidden. For the container, run the command with `docker exec <container> marfa ...`, adding `-it` for `setup claim`.

Creating or changing a key, approving an app, and restoring an archive need a sign-in within the last five minutes. If yours is older, the page asks you to confirm it's you with your password or a passkey.

## Recover the owner

Run this under the same operating system account as the server, and enter the new password at the hidden prompt:

```bash
marfa --socket <socket> owner recover
```

Recovery changes the owner's password and ends browser sessions. Keys and approved apps keep working. To supply the password without a prompt, use `owner recover --stdin` with a JSON object that holds `password`. If the server can't start but you need the socket, start the server with `MARFA_CONTROL_ONLY=true`, which opens the private socket and nothing else.

## Upgrade

For a native install, install the newer release of both programs first, then run:

```bash
marfa server upgrade
```

The command restarts the server on the installed programs and refuses an older release than the one installed. For a Docker install, run `marfa server upgrade --release <version>`; without `--release` it moves to the release of your `marfa`.

A newer build updates the database in place at its first start. When the database's schema is older, the server first checks that the disk has at least twice the size of the database and its log free, then copies the database to `marfa.db.schema-<from>-to-<to>.bak` beside it, and keeps the copy until you remove it. It updates in one transaction and checks the result before it commits. If a check fails or the server stops partway, the database stays as it was. A build whose schema is the same opens the database without copying it. The server's log names the copy.

The server stops with status 78 when it refuses the database. It refuses one that a newer build wrote, one whose tables match no build's, and an update that lacks disk space or fails its checks. It changes nothing in a refused database.

- **Native:** the service stays up and does nothing, so that it isn't started again into the same refusal. Read the reason with `marfa server status`. Install the release that wrote the database, then run `marfa server start`.
- **Docker:** the container exits with status 78, and Docker's restart policy starts it again. Read the reason with `docker logs <name>`, and stop it with `marfa server stop`.

To go back after a successful update, stop the server, delete `marfa.db-wal` and `marfa.db-shm`, replace `marfa.db` with the copy, and start the earlier release. Writes made since the update aren't in the copy. The copy is as large as the database. Delete it once you won't go back.

## Remove the server

```bash
marfa server uninstall
```

The command removes the service and keeps the data, the settings and the secrets, so `marfa server install` brings the same server back. Add `--delete-data` to remove the data and `marfa.env` as well. This can't be undone.

## Run the release image yourself

Every release publishes `ghcr.io/withmarfa/marfa-server:<version>` for `linux/amd64` and `linux/arm64`. Use the version, never `latest`, so that a restart doesn't change the build. The image holds the release's own static `marfa-server` and `marfa` on a base with no shell. It runs as user 65532, not root.

```bash
docker run --name marfa -d -p 127.0.0.1:8600:8600 -v marfa-data:/data \
  ghcr.io/withmarfa/marfa-server:<version>
```

- **Publish the port on `127.0.0.1`.** A bare `-p 8600:8600` is open to every network the machine is on. Put a proxy or tunnel on the machine in front of it.
- **Publish another host port, and leave `PORT` alone.** The image's health check runs `marfa status` against port 8600 inside the container. For port 9000 on the host, use `-p 127.0.0.1:9000:8600`.
- **A folder mounted at `/data` must be writable by user 65532,** or run the container as the folder's owner with `--user`. A named volume works as it is.
- **Secrets:** on a first start without `API_KEY_SALT` and `MARFA_AUTH_SECRET`, the server makes them and keeps them in `/data/marfa.secrets`, readable by its user alone. Keep that file with the data. A database without its secrets is refused.

The image sets `MARFA_LISTEN_HOST`, `PORT`, `SQLITE_PATH`, `BLOB_PATH` and `MARFA_CONTROL_SOCKET`; the table below gives the values. To pass more settings, use `-e` or `--env-file`.

## Build the programs and the image yourself

To run code that isn't a release, build the programs for a target. The target is `aarch64-apple-darwin`, `aarch64-unknown-linux-musl` or `x86_64-unknown-linux-musl`. The script needs the tools that `core/marfa-enrichment/native/release.sh <target> --needs` lists, and Docker for the Linux targets:

```bash
MARFA_NATIVE_ROOT=<folder> scripts/release/build-programs.sh <target>
```

`<folder>` holds downloads and work, and the first build of a target takes long. The result is in `<folder>/out/<target>/`: `marfa`, `marfa-server` and `NOTICES.txt`. A build from the repository reports version `0.0.0`.

To build the image from those programs, put the output of the two Linux targets in a build context as `amd64/` (`x86_64-unknown-linux-musl`) and `arm64/` (`aarch64-unknown-linux-musl`), then run:

```bash
docker buildx build -f deploy/Dockerfile --platform linux/amd64 \
  --build-arg VERSION=0.0.0 -t marfa-server <context>
scripts/check-image.sh marfa-server 0.0.0
```

`scripts/check-image.sh` boots the image on a fresh volume with a read-only root file system and checks that it becomes healthy, runs as a user that isn't root, keeps what it makes on the volume, stops with status 0 within ten seconds, and is the same instance when started again.

## Settings

The server reads these settings from its environment when it starts. None is required: a first start makes the two secrets when you don't set them. The server's other settings are stored in the database.

| Name                   | Default in the program                   | Set by the image           | What it does                                                                                                                                                                          |
| ---------------------- | ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `8600`                                   | `8600`                     | The port the server listens on.                                                                                                                                                       |
| `MARFA_LISTEN_HOST`    | All interfaces                           | `0.0.0.0`                  | The address the server listens on. A native install sets `127.0.0.1`.                                                                                                                 |
| `SQLITE_PATH`          | `./data/marfa.db`                        | `/data/marfa.db`           | Where the database is.                                                                                                                                                                |
| `BLOB_PATH`            | `./data/blobs`                           | `/data/blobs`              | Where the server keeps files.                                                                                                                                                         |
| `MARFA_CONTROL_SOCKET` | `control/marfa.sock` beside the database | `/data/control/marfa.sock` | Where the private socket is. Use an absolute path of 103 bytes or fewer, with no symbolic link in it.                                                                                 |
| `API_KEY_SALT`         | Made on a first start                    | Not set                    | The secret that keys are stored under. Changing it ends every key.                                                                                                                    |
| `MARFA_AUTH_SECRET`    | Made on a first start                    | Not set                    | The secret that sign-in is signed with, at least 32 characters. Changing it ends every browser session.                                                                               |
| `TRUSTED_PROXY_CIDRS`  | Not set                                  | Not set                    | Comma-separated ranges of the proxies whose `X-Forwarded-For` the server believes. Unset, the header is ignored.                                                                      |
| `TRUSTED_PROXY_HEADER` | Not set                                  | Not set                    | A header that the edge in front of the server overwrites with the caller's address, such as `CF-Connecting-IP`. Set it only when nothing reaches the server except through that edge. |
| `MARFA_CONTROL_ONLY`   | `false`                                  | Not set                    | Starts the private socket alone, for [recovery](#recover-the-owner).                                                                                                                  |

The `OTEL_EXPORTER_OTLP_*` names set where an OpenTelemetry receiver is, `MARFA_POSTHOG_HOST` with `MARFA_POSTHOG_PROJECT_TOKEN` set where exception reports go, and `OTEL_SDK_DISABLED=true` turns telemetry off. A value outside its rule stops the server with a message that names the setting.
