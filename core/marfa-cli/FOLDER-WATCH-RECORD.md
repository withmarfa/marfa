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
          "problems": [{ "code": "conflict", "count": 2 }],
          "pending_uploads": 0,
          "pending_downloads": 0,
          "paused_removals": 0
        }
      ]
    }
  ]
}
```

- `processes` has one entry for each watch process on the machine: one for a `folders watch` of every folder, and one for each `folders watch DIR`. A watch rewrites only its own entry.
- `folders` lists the folders that process was asked to hold. A watch of every folder lists every folder the registry lists, and stops listing one the registry drops.
- `dir` is the folder's directory, and `folder` is its `system.folder` ID.
- `watching` is `true` once the folder is said to be watched. A folder tried again after it failed is said to be watched once its watch has lasted about 10 seconds, so until then `watching` stays `false` and `reason` stays as it was. For a folder a watch of every folder cannot watch, it is `false` and `reason` is the error code, such as `first_sync_waiting`, `unauthorized` or `io`. For a folder whose directory cannot be found, as a deleted directory or a volume that is away, `reason` is `missing`, which is no error code; `folders remove` takes such a folder off the list. The watch tries it again, and `reason` changes with the attempt. `reason` is `null` for a folder not yet tried. A folder that a command such as `folders confirm` asked for is `false` with `reason` `handed_over` from when either form of the watch lets it go, or a watch of every folder finds it asked for as it opens it, until the watch holds it again.
- `last_success_at`, `first_sync_waiting`, `problems`, `pending_uploads`, `pending_downloads` and `paused_removals` are the values of the folder's latest report to the server, as [Read remote folder health](FOLDER-HEALTH.md) describes them. `last_success_at` is `null` until a sync completes. They stay as last observed while a folder is not watched. Until this process has read a report for a folder, such as one it could not open, though another process may have saved one, all six are `null`, so `null` in `problems` means unknown and `[]` means none. The exception is a folder whose `reason` is `first_sync_waiting`, which shows `first_sync_waiting` as `true`.

The record holds no credential, no file name inside a folder and no item content. A folder's directory and its ID are the only names in it.

## Decide whether an entry is current

An entry is **current** when both hold:

1. `ended_at` is `null`.
2. `heartbeat_at` is no later than now, and less than three `heartbeat_interval_seconds` before now.

A running watch rewrites its entry at least once every `heartbeat_interval_seconds` (5), except while another process holds the record's lock. A beat that finds the record's lock held by another process is tried again at the next poll. Three intervals allow for that and for a slow write. A heartbeat that lies in the future, as after the clock was set back, is not current.

An entry that is not current describes a watch that has ended, or one that cannot write the record because another process keeps its lock:

- A watch that stops with Ctrl-C or `SIGTERM`, at the end of `--for` or because its watch failed sets `ended_at` and marks each of its folders `watching: false`. If another process holds the record's lock at that moment, the watch waits at most half a second for it, then ends and leaves `ended_at` unset, and the heartbeat rule shows it as ended.
- A watch that was killed, or whose machine lost power, cannot write. Its entry stays as it was, with `watching: true` and `ended_at: null`, and its `heartbeat_at` ages until it passes three intervals. Trust `watching` only for a current entry.

To be sure at once, check that `pid` still names a running process. The check can be wrong when the system reuses a process ID, so the heartbeat decides.

A folder is watched now when a current entry lists it with `watching: true`. When a `folders watch DIR` holds a folder, a watch of every folder lists it as not watched, so one folder can appear in two entries.

A watch that writes drops the entries of other processes whose `heartbeat_at` is an hour or more old, or later than now. A record with no entry for a folder means no watch has held it recently.

## When the record cannot be written

A watch that finds the record's lock held by another process for more than three `heartbeat_interval_seconds` says so once, and again only after a write has succeeded in between. A watch whose record cannot be written, such as when `folder-watch.json` is a directory or its directory is read-only, says so once and goes on syncing. It writes the record when it can again. A watch writes while it holds a lock on `folder-watch.lock`, beside the record, and it never waits on that lock: if another process holds it, the beat is tried again at the next poll, and no folder's watch waits.
