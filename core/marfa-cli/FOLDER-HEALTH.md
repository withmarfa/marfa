# Read remote folder health

Run `marfa folders health FOLDER_ID` to read the server's latest reports from the sign-ins and local copies following a folder. The command needs read access to the folder's `system.folder` item. Add `--json` for the complete response.

Each local directory has its own opaque folder store ID. Two directories can follow the same folder through the same sign-in and still report separately. The server records the canonical sign-in that submitted each report.

A receipt time and its age describe when the server received a report. They do not establish whether a copy is reachable now. Ended sign-ins retain readable historical reports and do not contribute to current totals. The command prints "at least" when the server reports saturated totals.

## What a report means

- `last_success_at` is the last confirmed complete sync that reached the server, finished catching up and pulling, and had no pending files, paused removals, or blocking problems. It remains unchanged after an offline scan or incomplete sync. A watch uses its existing event follow as catch-up evidence.
- `pending_uploads` counts distinct files with local changes waiting to be scanned or sent, rather than queued operations.
- `pending_downloads` counts known files whose latest completed pull could not materialize them. A failed pull preserves the previous observation. The count does not describe server changes a disconnected copy has not seen.
- `paused_removals` counts paused removals from disk and from the server separately from conflicts.
- `first_sync_waiting` says that the person has not confirmed the initial content sync.
- `problems` contains current counts under a closed set of safe codes. A conflict counts while a local conflicted copy remains tagged `conflicted-copy` and linked through `derived-from`; keeping its bytes after resolving that marker does not keep the count.

Reports contain no local paths, file contents, item IDs, hashes, or raw error messages.

## Delivery

`folders push` makes a bounded reporting attempt after its content work. `folders watch` sends reports independently of content passes, on meaningful changes and its regular full pass. A reporting failure does not stop content sync or clear a content problem.

The local store keeps the newest pending report and its sequence before sending it. A restart retains that report. New observations replace older pending observations; a retry sends the exact payload captured for that attempt. An obsolete receipt cannot remove a newer pending report. A copy restored from an older backup refreshes its local observation and allocates a sequence above the server's last receipt.

Reporting uses the already confirmed server origin and the credential content sync currently holds. It does not initiate credential renewal; a refused report waits for content sync to renew the credential. The remote `folders health` command uses the CLI's usual renewal behavior.

Attaching a directory retains the existing requirement to write `in-folder` placements. An already bound copy can report with read access to the folder, including when a content write is refused.
