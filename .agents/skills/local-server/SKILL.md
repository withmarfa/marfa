---
name: local-server
description: Boot a throwaway Marfa server on this machine, claim it and make a key, with core/scripts/server-up.sh or the private socket. Use to try a change against a real server, run the core's live tests, sign in to the server's pages by hand, or claim and recover a server started another way.
---

# Run a throwaway Marfa server locally

`core/scripts/server-up.sh` boots the release `marfa-server` on `127.0.0.1` with a fresh database, claims it through its private socket, makes a working key, and prints the variables to use it. Nothing it makes outlives `core/scripts/server-down.sh` unless you ask it to.

## Boot a server

1. Build the release server, from `core/`:

   ```sh
   cargo build --release -p marfa-server
   ```

   The script boots `core/target/release/marfa-server`, or the program `MARFA_SERVER_BIN` names, and refuses to start without one. It honors `CARGO_TARGET_DIR`.

2. Boot it, from the repository root. Assign the output, then evaluate it: `eval "$(…)"` of a failed boot's empty output succeeds.

   ```sh
   env_text="$(core/scripts/server-up.sh)" && eval "${env_text}"
   ```

   Output: these variables in your shell.

   - `MARFA_TEST_URL`: the server's address, on a port the system assigns unless `MARFA_PORT` names one.
   - `MARFA_TEST_KEY`: a working key with all twelve permissions, write on every type, edge, extension and metadata entry, and read on the owner's profile.
   - `MARFA_TEST_SOCKET`: the private socket.
   - `MARFA_TEST_OWNER_EMAIL` and `MARFA_TEST_OWNER_PASSWORD`: the throwaway owner, from `core/scripts/test-owner.example.env`.
   - `MARFA_SERVER_ENV`, `MARFA_SERVER_PID` and `MARFA_SERVER_STATE`: what `server-down.sh` reads.

   Options, set before the boot:

   - `MARFA_SERVER_ENV`: where the env file goes. Set it to clean up after a failed boot, since the default location is printed only on success.
   - `MARFA_SERVER_KEEP`: a directory that a later boot reuses, with the same port, data, key and owner. `server-down.sh` leaves it in place.

   On a failure the script prints the server's log with the setup code hidden, stops the server and exits 1.

## Use it

- Run the command line against it with both variables set, so it reads and writes no keychain. Build it first with `cargo build -p marfa-cli` under `core/`.

  ```sh
  MARFA_API_URL="$MARFA_TEST_URL" MARFA_API_KEY="$MARFA_TEST_KEY" core/target/debug/marfa status
  ```

  Never run `marfa login` or `marfa keys keep` against this server from an agent or a test: both write to the login keychain.

- Sign in as the owner at `$MARFA_TEST_URL/auth/sign-in` with the owner's email and password.
- Make another key through the private socket, with the same binary (`marfa` below). `--socket` refuses `--url`, `--key`, `--profile`, `MARFA_API_URL`, `MARFA_API_KEY` and `MARFA_PROFILE`, so leave them unset.

  ```sh
  marfa --socket "$MARFA_TEST_SOCKET" keys create --label laptop --source laptop \
    --type-permission '*=write' --edge-permission '*=write' \
    --metadata-permission '*=write' --extension-permission '*=write' \
    --profile-permission '*=read'
  ```

  Output: the key on the first line, shown once. With `--json`, the key is the `key` field. The key holds exactly the maps and permissions the flags name; add `--permission` for each permission it needs. `marfa keys create --help` lists the flags.

## Stop it

```sh
core/scripts/server-down.sh
```

It reads `MARFA_SERVER_ENV`, or the env file you pass it, stops the server and its children, and removes the socket's directory and the state directory, unless the boot used `MARFA_SERVER_KEEP`.

## Claim or recover a server started another way

Run each command as the server's operating-system account, through its private socket. The socket is `MARFA_CONTROL_SOCKET`, or `control/marfa.sock` beside the database by default. `--socket` uses no keychain and never falls back to HTTP.

- Claim it:

  ```sh
  marfa --socket "$MARFA_CONTROL_SOCKET" setup claim --email owner@example.com
  ```

  It asks for the password at a hidden prompt. For automation, add `--stdin` and send a JSON object with `email`, `password` and an optional `name`. Never pass a secret as an argument.

- Or hand the claim to a browser: `marfa --socket "$MARFA_CONTROL_SOCKET" setup open` opens a single-use link; `--no-browser` prints it instead.
- Claim from another machine: `marfa --url https://marfa.example.com setup claim --email owner@example.com` asks for the password and the setup code; its `--stdin` JSON also needs `code`.
- Recover the owner's password: `marfa --socket "$MARFA_CONTROL_SOCKET" owner recover`, or with `--stdin` and a JSON object with `password`. It ends the owner's browser sessions.
- When the public HTTP listener cannot start, set `MARFA_CONTROL_ONLY=true` to run only the private listener against the configured database. Stop a running listener, or choose another socket path, first.
