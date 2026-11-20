# How much a pass does, and when

A folder is a `system.folder` item on the instance, with its settings, query and ID. A directory is a place on a machine's disk that follows a folder, with a working copy and a queue. A statement about what a device does on disk says directory; one about what the instance holds says folder. The device and queue rules also apply (`device.md`, `queue-and-verdicts.md`).

This chapter holds what a quick pass and a full pass of a folder watch read and render, how often a full pass runs, what a watch does for a part of a directory it cannot watch, and how long a watch waits for a file to settle.

## What a pass reads and renders

### `folder-speed/watch-unchanged-unread`

When a watch scans a bound file whose identity, size, modification time and executable permission remain unchanged, with no held or lost-item condition requiring a read, a device MUST omit reading that file on a quick pass.

**Tests:** `device/folders.test.ts › does not reread an unchanged file`.

### `folder-speed/full-pass-reads`

When a folder scan or push performs a full pass, a device MUST read a file whose bytes changed even if its size and modification time did not.

**Tests:** `device/folders.test.ts › finds a missed change on its full pass`.

### `folder-speed/quick-copy-original-read`

When a quick folder scan reads a file carrying the ID of an otherwise skipped file, a device MUST read the original too before distinguishing the copy.

**Tests:** `device/folders.test.ts › tells a copy from its unread original on a quick pass`.

### `folder-speed/scan-read-race-retried`

When a file changes while a watch scan reads it, a device MUST read it again at a subsequent pass rather than treat the concurrent save as already scanned.

**Tests:** `device/binding-folders-clock.test.ts › reads a save made during a scan on a subsequent pass`.

### `folder-speed/watch-periodic-full-pass`

While a folder watch runs, a device MUST perform a full scan at its first pass and at the first pass after the folder's full-pass interval since the previous full scan.

**Reason:** A full scan reads every file, to find a change the system did not report.

**Tests:** `device/binding-folders-clock.test.ts › performs a full first pass and the first pass past $named`.

### `folder-speed/watch-full-pass-interval-default`

Where a folder's settings name no `full_pass_interval_seconds`, a device MUST use 600 seconds as the folder's full-pass interval.

**Tests:** `device/binding-folders-clock.test.ts › performs a full first pass and the first pass past $named`.

### `folder-speed/watch-full-pass-interval-own`

Where a folder's settings name `full_pass_interval_seconds`, a device MUST use that many seconds as that folder's full-pass interval.

**Reason:** A watch of every folder runs one watch per folder, and each keeps the interval its own folder names.

**Tests:** `device/binding-folders-clock.test.ts › performs a full first pass and the first pass past $named`, `device/binding-folders-clock.test.ts › keeps each folder's own interval where two folders of one machine are watched at once`.

### `folder-speed/watch-full-pass-interval-followed`

When a running folder watch follows changed settings that name another `full_pass_interval_seconds`, a device MUST apply the new interval from the next pass, counted from the previous full scan, without the watch being restarted.

**Tests:** `device/binding-folders-clock.test.ts › takes an interval edited in the settings file at the next pass of the running watch`.

### `folder-speed/full-pass-interval-refused`

If folder settings name a `full_pass_interval_seconds` that is not a whole number of seconds from 60 to 86400, then a device MUST refuse to follow them.

**Tests:** `device/folders.test.ts › refuses a query condition it does not implement`.

### `folder-speed/watch-quiet-pass-unrendered`

When a quick or full pass of a folder watch finds no file changed on disk and sends or takes in no write, while the working copy and the folder's record of its files are as they were when the watch's previous pull began, that pull wrote, moved or removed no file and left none unwritten or waiting on another folder, every path where a symbolic link, a package or another folder kept that pull from writing is still kept so for the same reason, and `folder-speed/watch-hourly-full-render` does not apply, a device MUST NOT render any file.

**Reason:** a pass can start every second while a folder changes, and a pull renders every file the folder holds to compare it with the disk, so a watch on a quiet folder of hundreds of files would spend the processor on rendering what it already wrote.

**Tests:** `device/binding-folders-clock.test.ts › renders no file on a quick or full pass of a quiet folder, and renders one after an edit`.

### `folder-speed/watch-pull-renders-reached`

When a folder watch's pull follows an earlier pull of the same watch that ran to its end, while the working copy's generation and the folder's settings are as they were when that earlier pull began, no more than 4,096 items changed since then, and `folder-speed/watch-hourly-full-render` does not apply, a device MUST NOT render the file of an item that the earlier pull found or left as the item renders, unless one of the following changed after that earlier pull began: the item, its tags or pins, its writes waiting to be sent, one of its edges, an item at the other end of one of its edges other than a placement in a folder, the folder's record of a file of the item or of such an item, an item that answers to a name the item or such an item answers to, or the types the working copy holds.

**Reason:** a file renders from its item, the item's edges, the items at their other ends, the names those items answer to, the types and the folder's own record of the file, so a pull that renders every file to find the few a change reaches spends the processor on a folder of hundreds of files each time one note changes.

**Tests:** `device/binding-folders-clock.test.ts › renders only the file an edit changes, and every file once an hour`.

### `folder-speed/watch-hourly-full-render`

When an hour has passed since a folder watch's pull last rendered every file, a device MUST run a pull at the watch's next pass and render every file in it, even where the pass finds nothing changed.

**Reason:** the choice of `folder-speed/watch-pull-renders-reached` follows what a file renders from, and a full render at least once an hour finds and rewrites a file whose source that choice missed.

**Tests:** `device/binding-folders-clock.test.ts › renders only the file an edit changes, and every file once an hour`, `device/binding-folders-clock.test.ts › rewrites at the hourly render a file the choice of files to render left out`.

## Looking at what a watch cannot watch

A watch that cannot register some directories with the system has no event for a change in them, so it looks at their files itself.

### `folder-speed/unwatched-look`

While a watch cannot register some directories beneath a folder's directory, a device MUST look at the files beneath those directories again before the folder's full-pass interval has passed.

**Reason:** A change there is otherwise found only by the full pass, which by default runs every 600 seconds. A device looks every 30 seconds, or every full-pass interval where that is shorter.

**Tests:** `device/folders-unwatched.test.ts › finds a change in a directory it cannot watch at its own interval, reading none of the files it can watch`.

### `folder-speed/unwatched-look-scope`

When a watch looks at the directories it cannot register, a device MUST read only files beneath those directories, and files that events name.

**Reason:** The cost of looking grows with the part that cannot be watched, not with the folder.

**Tests:** `device/folders-unwatched.test.ts › finds a change in a directory it cannot watch at its own interval, reading none of the files it can watch`.

### `folder-speed/unwatched-look-paced`

While a watch cannot register some directories and no event arrives, a device MUST NOT start a pass to look at them before the interval of its look has passed.

**Reason:** A watch with nothing to do uses almost no processor time, so a directory that cannot be watched does not make the watch wake on its own at every tick. A debug build lets a fixture set the interval.

**Tests:** `device/folders-unwatched.test.ts › does not look at a directory it cannot watch before its interval while nothing else changes`.

## How long a watch waits for a file to settle

### `folder-speed/busy-watch-progress`

While a directory receives changes more frequently than its settle window, a device MUST continue watch passes that send other files.

**Tests:** `device/folders.test.ts › keeps syncing both ways while a file changes twice a second`, `device/folders.test.ts › sends a file being copied in only once it stops changing, while every other file goes on`.

### `folder-speed/busy-watch-progress-server-changes`

While a folder receives changes more frequently than its settle window, a device MUST continue watch passes that apply server changes.

**Tests:** `device/folders.test.ts › keeps syncing both ways while a file changes twice a second`, `device/folders.test.ts › sends a file being copied in only once it stops changing, while every other file goes on`.

### `folder-speed/watch-settle-ceiling`

While a change the folder takes is waiting, when five seconds have elapsed since a folder watch’s previous pass ended, a device MUST start the next pass at its next wake without waiting for the folder to settle.

**Tests:** `device/binding-folders-clock.test.ts › starts a pass after five seconds even while filesystem changes keep arriving`.

### `folder-speed/binary-waits-for-settle`

When a non-document file changes within the folder watch’s 250-millisecond settle window, a device MUST defer reading its bytes until a later pass after it settles.

**Tests:** `device/folders.test.ts › sends a file being copied in only once it stops changing, while every other file goes on`.

### `folder-speed/file-item-doc-name-settle`

When a file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) that is the file of a file item changes within the folder watch's 250-millisecond settle window, a device MUST defer sending its bytes until a later pass after it settles.

**Reason:** a file item's file is copied or downloaded as any file that is not a document is, whatever its name, and a half-written file sent is a half-written item.

**Tests:** `device/folders-placement.test.ts › waits for a file item at a document name to stop changing, while every other file goes on, named %s`.

### `folder-speed/settle-measured-at-read`

When a device decides whether a file it read has settled, a device MUST measure the time the file was unchanged up to that read, not up to any later point in the pass.

**Reason:** a pass waits on the server and on its own work between reading a file and sending it, so time measured up to the decision makes a file still being written look settled, and its half-written bytes are sent.

**Tests:** `device/folders-placement.test.ts › waits for a file item at a document name to stop changing however long the server takes to answer, named %s`.

### `folder-speed/settling-rename-identity`

When a non-document file is renamed while its bytes are still settling, a device MUST preserve the file’s item identity at its renamed path.

**Tests:** `device/folders-placement.test.ts › keeps the item of a renamed file that is still settling (replacement %s)`.

### `folder-speed/settling-rename-identity-bytes-not-read`

When a non-document file is renamed while its bytes are still settling, a device MUST NOT read the changing bytes.

**Tests:** `device/folders-placement.test.ts › keeps the item of a renamed file that is still settling (replacement %s)`.

### `folder-speed/still-changing-notice`

While a file never settles enough for the watch to read it, the CLI MUST say once that the file is still changing and has not been sent.

**Tests:** `device/folders.test.ts › says once that a file which never stops changing has not been sent`.
