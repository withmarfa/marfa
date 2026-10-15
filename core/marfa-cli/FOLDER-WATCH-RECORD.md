# Read the record of folder watches

A running `marfa folders watch`, of one folder or of every folder, keeps a record of its folders in `folder-watch.json`. It sits in the directory that holds the machine's folder registry (`folders.json`): in `Library/Application Support/Marfa` under the home directory on macOS, in `$XDG_DATA_HOME/marfa` or `.local/share/marfa` under the home directory elsewhere, and beside the file `MARFA_FOLDER_REGISTRY` names where it is set.

Any program on the machine can read the record. It needs no folder's store, no credential and no network. Parse the whole file for each read: a watch replaces it in one step, so a read never finds half of one.

For `marfa folders health`, which reads what the server was told, see [Read remote folder health](FOLDER-HEALTH.md). The record is the local view: whether a watch runs, and what it last reported.

## The shape

```json
{
  "version": 1,
  "processes": [
    {
      "pid": 4821,
      "started_at": "2026-10-15T09:00:00.000Z",
      "heartbeat_at": "2026-10-15T09:20:35.120Z",
      "heartbeat_interval_seconds": 5,
      "ended_at": null,
      "folders": [
        {
          "dir": "/path/to/notes",
          "folder": "0199a1c2-7d3e-7a10-8c55-3f2b6e9d4a01",
          "watching": true,
          "reason": null,
          "last_success_at": "2026-10-15T09:20:31.004Z",
          "first_sync_waiting": false,
          "problems": [{ "code": "conflict", "count": 2 }]
        }
      ]
    }
  ]
}
```

- `processes` has one entry for each watch process on the machine: one for a `folders watch` of every folder, and one for each `folders watch DIR`. A watch rewrites only its own entry.
- `folders` lists the folders that process was asked to hold. A watch of every folder lists every folder the registry lists, and stops listing one the registry drops.
- `dir` is the folder's directory, and `folder` is its `system.folder` ID.
- `watching` is `true` while the folder's watch runs. For a folder a watch of every folder cannot watch, it is `false` and `reason` is the error code, such as `first_sync_waiting`, `unauthorized` or `io`. The watch tries it again, and `reason` changes with the attempt. `reason` is `null` for a folder not yet tried.
- `last_success_at`, `first_sync_waiting` and `problems` are the values of the folder's latest report to the server, as [Read remote folder health](FOLDER-HEALTH.md) describes them. `last_success_at` is `null` until a sync completes. They stay as last observed while a folder is not watched. A folder whose first sync waits shows `first_sync_waiting` as `true` from the start.

The record holds no credential, no file name inside a folder and no item content. A folder's directory and its ID are the only names in it.

## Decide whether an entry is current

An entry is **current** when both hold:

1. `ended_at` is `null`.
2. `heartbeat_at` is less than three `heartbeat_interval_seconds` before now.

A running watch rewrites its entry about every `heartbeat_interval_seconds` (5). Three intervals allow for a late or slow write.

An entry that is not current describes a watch that has ended:

- A watch that stops with Ctrl-C, at the end of `--for` or because its watch failed sets `ended_at` and marks each of its folders `watching: false`.
- A watch that was killed, or whose machine lost power, cannot write. Its entry stays as it was, with `watching: true` and `ended_at: null`, and its `heartbeat_at` ages until it passes three intervals. Trust `watching` only for a current entry.

To be sure at once, check that `pid` still names a running process. The check can be wrong when the system reuses a process ID, so the heartbeat decides.

A folder is watched now when a current entry lists it with `watching: true`. When a `folders watch DIR` holds a folder, a watch of every folder lists it as not watched, so one folder can appear in two entries.

A watch removes the entries that nothing has written to for an hour when it writes. A record with no entry for a folder means no watch has held it recently.

## When the record cannot be written

A watch whose record cannot be written, such as when `folder-watch.json` is a directory or its directory is read-only, says so once and goes on syncing. It writes the record when it can again.
