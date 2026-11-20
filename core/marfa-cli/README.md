# The `marfa` command line

`marfa` is Marfa from the command line: every operation of one instance, a working copy of a slice of it under `marfa device`, and folders that hold a slice as files under `marfa folders`.

- **Commands, options and exit codes:** `marfa --help`, and the same text in [COMMANDS.md](COMMANDS.md), which is generated from it. `marfa operations` maps each published operation to its command, but `GET /oauth/authorize`, which an app opens in a person's browser.
- **What the binary does:** the contract states it, in `conformance/spec/cli.md` (requests, profiles, credentials, output and telemetry), `device.md` (the working copy), `queue-and-verdicts.md` (the queue and its drain) and the `folder-` chapters (folders, the watch and syncing from login).
- **What it sends to a collector:** [core/TELEMETRY.md](../TELEMETRY.md).
- **What a program on the machine can read:** the [record of folder watches](FOLDER-WATCH-RECORD.md), and the server's [folder health reports](FOLDER-HEALTH.md).

This page holds the rest: the limits and timings the contract leaves to the binary, and how to run it unattended.

## Run it unattended

An agent, a script or a test runs `marfa` with no keychain prompt and no person at the screen.

- Set both `MARFA_API_URL` and `MARFA_API_KEY`. A command then reads and writes no keychain.
- Or set `MARFA_NO_KEYCHAIN=1` (also `true`, `yes` or `on`), or pass `--no-keychain`, to turn the keychain off for the run. `keys keep`, `keys forget`, `login` and `logout` then refuse with a usage error that says how to pass a key instead.
- Let a secrets manager supply the variables, as in `op run -- marfa items list` or `infisical run -- marfa items list`, or name a profile whose `key_command` prints the key.
- On macOS, `MARFA_KEYCHAIN` names a keychain file to use instead of the person's, and refuses every prompt.
- `MARFA_AUTOSTART_ROOT` names a directory that stands in for the home directory for `folders autostart`: the agent is written below it, and the command runs the `launchctl` or `systemctl` in its `bin`, never the system's. The device fixtures use it with a fake service manager, so no test installs a login agent.

## Check a folder of type definitions

`marfa types check FOLDER` judges the item type definitions in a folder with the rules a server applies when it registers a type, so a repository that keeps type files can run it in CI. It needs no server, key or keychain and sends nothing. `marfa-rules` holds the judgement (`schema::check_type_files`, built on the `validate_type` call the server makes), and the command only reads the folder and prints.

- **What it reads:** each `*.json` file directly in the folder, as the body `marfa types register --file` sends. The file is named `<id>.json`. A subfolder, a file whose name starts with a dot and a file with any other extension are left alone. A name ending in `.JSON` is read, and refused because its name differs from `<id>.json`. Edge types are not checked.
- **What it judges against:** the types the build ships and the folder's own types, each type after its parent. A parent that is neither shipped nor in the folder is reported as missing, even where an instance holds a type of that name.
- **What it reports:** every problem in every file, each with the file, the path in the definition and the code and message a server gives. The codes `file_unreadable`, `file_name_mismatch`, `parent_refused` and `compatible_with_refused` are the command's own. A type whose parent is missing, in a loop or refused is reported with that reason alone, and is not judged further.
- **Exit codes:** 0 when every file passes, 1 when a file is refused or the folder holds no `*.json` file, and 2 when the path is not a folder. With `--json`, standard output holds `{ok, checked, refused, files}` and a refusal's error envelope goes to standard error as for any command.
- **What it cannot judge:** a server also decides from what an instance holds. The command does not check that the type's `id` is free (`409 type_exists`), that the key may register it (`403 forbidden`, `403 type_not_permitted`, the `metadata.types:write` and `schema.write` permissions and the key's type map), that the key reaches the `parent` and each `compatible_with` target that is not a platform type, that the body is within the instance's request-size setting, or that a type the instance already holds is compatible with it.

## Limits and timings

| What                                                                   | Limit                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| An answer to begin, and then to be read                                | 90 seconds each, which an operation that works before it answers needs                                                                               |
| A streamed answer, such as `events`                                    | Fails after 45 seconds of silence                                                                                                                    |
| `marfa docs`                                                           | 10 seconds to connect, then 30 seconds each for the answer to begin and to be read                                                                   |
| A profile's `key_command`                                              | 60 seconds; a refusal quotes the last line of its standard error, up to 200 characters                                                               |
| A command that works a folder another process holds                    | Asks it to let go and waits up to 10 seconds, then is refused with `reading_handle`                                                                  |
| A watch that let a folder go                                           | Tries to take it back every second                                                                                                                   |
| A `folders watch` pass that has not finished after Ctrl-C or `SIGTERM` | Left behind after 2 seconds, and the watch ends; what it had not finished stays queued or on disk                                                    |
| `folders watch` with no directory: the registry                        | Read again every 2 seconds                                                                                                                           |
| A listed folder that cannot be opened                                  | Tried again every 5 seconds                                                                                                                          |
| Listed folders whose directories cannot be found                       | Reported together once the set has stayed the same for 2 seconds; each looked for again after 5 seconds, then at a wait that doubles up to 5 minutes |
| A folder whose watch ended                                             | Tried again after 60 seconds                                                                                                                         |
| A folder whose server answers as another Marfa instance                | Not watched; tried again once its key, its server or its `.marfa/folder.yaml` changes, or once an hourly read of the server's root finds the folder's own instance |
| A watch's passes that keep failing                                     | Spaced by a wait that starts at 1 second and doubles up to 5 minutes; a change on disk, a server change or the server answering again ends the wait  |
| The watch's log                                                        | Checked for size every 10 seconds                                                                                                                    |

## Syncing folders from login

`marfa folders autostart on`, `off` and `status` manage the agent that runs `folders watch` at login, as `folder-setup.md` states. These details are the binary's own:

- **Restart:** the launchd agent sets `KeepAlive` with `SuccessfulExit` false and `ThrottleInterval` 30; the systemd unit sets `Restart=on-failure` and `RestartSec=30`.
- **A failed `on`:** an `on` that failed before the service manager took the new agent is taken up by the next `on`. launchd's old agent is unloaded before the file changes, and systemd's `NeedDaemonReload` shows a unit whose file changed since it was read.
- **A busy watch:** a watch that starts more than 60 passes within a minute writes one line to its log saying how many, at most once a minute. A folder at rest starts almost none.
- **A stopped watch:** when Ctrl-C or `SIGTERM` stops the watch, the last line it writes to its log names the signal and the time in UTC, and the process that sent the signal where the system reports one, as `2026-10-29T12:00:00Z folders watch stopped by SIGTERM, sent by process 4821`. A stop at the `--for` limit writes none.
- **An agent from an earlier build:** `status` says when the installed agent differs from what `on` writes now, and that running `on` again with the same options replaces it. `--json` reports it as `outdated`.
- **Another program:** a menu-bar app or any other program reads the [record of folder watches](FOLDER-WATCH-RECORD.md) and turns syncing from login on or off with this command, rather than running a second watch.
