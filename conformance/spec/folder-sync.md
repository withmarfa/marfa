# Keeping in step

A folder is a `system.folder` item on the instance, with its settings, query and ID. A directory is a place on a machine's disk that follows a folder, with a working copy and a queue. A statement about what a device does on disk says directory; one about what the instance holds says folder. The device and queue rules also apply (`device.md`, `queue-and-verdicts.md`).

This chapter holds how a watch or a command keeps a folder in step with the server: keeping up, pulls and pushes, watching every folder, and the reports a folder sends.

## Keeping up

### `folder-sync/push-catches-up`

When a folder sync finishes its drain, a device MUST catch up the working copy before pulling its files.

**Tests:** `device/folders.test.ts › takes another device's change at the next push, without a hydration`.

### `folder-sync/watch-follows`

While a folder watch runs, a device MUST apply server changes to the working copy without a full hydration while the cursor remains valid.

**Tests:** `device/folders.test.ts › takes another device's change while watching, without a hydration`.

### `folder-sync/watch-follows-files-written`

While a folder watch runs, a device MUST write the received server changes at a subsequent pass.

**Tests:** `device/folders.test.ts › takes another device's change while watching, without a hydration`.

### `folder-sync/expired-folder-hydrates`

When a folder’s cursor has aged out of the server log, a device MUST hydrate a fresh copy before continuing its push or watch.

**Tests:** `device/folders.test.ts › hydrates again at a push whose cursor the log has aged past`, `device/folders.test.ts › hydrates again while watching when the log ages past its cursor`.

### `folder-sync/watch-awaits-first-hydration`

While a folder's copy has not completed its first hydration, a device MUST NOT end a watch of the folder because the copy does not hold the folder's `system.folder` item.

**Reason:** `folders add` with `--yes` hydrates nothing, so a watch's first passes can meet a copy that does not yet hold the folder's `system.folder` item, which is a hydration still to come and not a folder the key cannot read. Writing no file meanwhile is `folder-sync/pull-waits-for-whole-copy`.

**Tests:** `device/folders.test.ts › waits for the first hydration instead of ending on a copy without the folder's settings`.

### `folder-sync/pull-waits-for-whole-copy`

While a hydration of a folder's copy has started and not completed, or the folder's copy is stale, a device MUST refuse a pull of the folder `hydration_incomplete`, writing and removing no file.

**Reason:** a copy still filling answers its reads from the items it has been given (`device/read-partial-answers`), and an item it has not been given yet is not an item the server deleted; a stale copy (`device/read-stale-answers`) holds items the server may since have changed or deleted, and a file written from one would overwrite a newer one.

**Tests:** `device/folders.test.ts › keeps every file through a hydration that stopped part way, and pulls nothing from its copy`.

### `folder-sync/reach-changed-push-rebuilds`

When any drain of a folder push or a send-only run, the drain after the push's pull included, ends `copy_expired` with the reason `reach_changed`, a device MUST hydrate the copy again and drain once more in the same run, sending each write still waiting once and reporting the verdict of every write that either drain settled.

**Reason:** A key that is replaced or narrowed changes the reach the copy was built under (`device/reach-changed`), and a run that stopped there would leave every write behind it waiting for no cause the person can act on. The rebuild reads under the new reach, so nothing the new key cannot read stays in the copy. A verdict the first drain settled is final in the queue, and a report without it would tell the person that a refused write was taken.

**Tests:** `device/folders.test.ts › builds the copy again and delivers every waiting write in the same $run`, `device/folders.test.ts › reports a refusal from before the reach changed with the writes sent after the rebuild`, `device/folders.test.ts › builds the copy again where the drain after the pull meets the changed reach, and finishes the push`, `device/folders.test.ts › reports a placement refused where its own read meets the changed reach, and does not send it again`.

### `folder-sync/reach-changed-push-pulls-again`

When the drain after a folder push's pull hydrates the copy again under `folder-sync/reach-changed-push-rebuilds`, a device MUST pull once more in the same run, and drain once more where that pull queued the placement of a file it wrote.

**Reason:** The first pull wrote the directory out from the copy built under the old reach. Pulling from the rebuilt copy writes what the new reach holds in the same push, rather than leaving it for the next one. A file bound to an item the new key cannot read is not removed by that pull; the next scan reports it as lost (`folder-files/lost-item-unchanged-held`).

**Tests:** `device/folders.test.ts › pulls again after a rebuild at the drain after the pull, writing what the new reach holds and keeping a file it no longer reads`.

### `folder-sync/reach-changed-push-once`

If a drain of a folder push or a send-only run that has already rebuilt its copy for a changed reach also ends `copy_expired` with the reason `reach_changed`, then a device MUST end the run `copy_expired` without hydrating again, keeping the writes still waiting.

**Reason:** A reach that changes again at once is changing under the run, and rebuilding without end would spend the key's rate limit and never finish.

**Tests:** `device/folders.test.ts › builds the copy again only once in a push, and ends it copy_expired where the reach changes again`.

### `folder-sync/reach-changed-rebuild-fails`

If the hydration a folder push takes for a changed reach fails, then the CLI MUST end the push with that hydration's own error and exit code, keeping the writes still waiting for the next push.

**Reason:** The person acts on why the rebuild failed, such as a server that cannot be reached, not on the changed reach the rebuild was answering.

**Tests:** `device/folders.test.ts › ends the push with the rebuild's own failure, keeping the writes for the next push`.

### `folder-sync/reach-changed-watch-rebuilds`

When a folder watch's drain ends `copy_expired` with the reason `reach_changed`, a device MUST hydrate the copy again and send the writes still waiting without ending the watch.

**Tests:** `device/folders.test.ts › builds the copy again while watching and delivers every waiting write, still watching`.

### `folder-sync/failed-hydration-retried`

When a folder push previously failed to hydrate a usable copy, a device MUST retry hydration at the next push.

**Tests:** `device/folders.test.ts › hydrates at the next push after one whose hydration failed`.

### `folder-sync/watch-hydration-retry`

When a folder watch hydration fails environmentally, a device MUST retry hydration after a delay.

**Tests:** `device/folders.test.ts › keeps watching through a hydration that failed, and tries it again`, `device/folders.test.ts › waits out a rate limit's Retry-After before hydrating again while watching`.

### `folder-sync/watch-retry-delay`

When a folder watch repeatedly fails to hydrate environmentally, a device MUST double its retry delay from one second up to thirty seconds, except for a longer `Retry-After` delay capped at 300 seconds.

**Tests:** `device/binding-folders-retry.test.ts › retries folder hydration at $name on the manual clock`.

### `folder-sync/catchup-failure-pull`

When a folder push’s catch-up fails environmentally but its copy remains usable, a device MUST pull from the held copy.

**Tests:** `device/folders.test.ts › pulls at a push that cannot reach the server, and says the catch-up failed`.

### `folder-sync/catchup-failure-said`

When a folder push’s catch-up fails environmentally, the CLI MUST report why catch-up failed.

**Tests:** `device/folders.test.ts › pulls at a push that cannot reach the server, and says the catch-up failed`.

### `folder-sync/watch-unretryable-failure`

When a folder watch hydration receives an answer no retry can change, the CLI MUST end the watch.

**Tests:** `device/folders.test.ts › ends the watch and says so when its hydration meets an answer no retry changes`.

### `folder-sync/watch-unretryable-failure-reason-said`

When a folder watch hydration receives an answer no retry can change, the CLI MUST report why server changes stopped reaching the directory.

**Tests:** `device/folders.test.ts › ends the watch and says so when its hydration meets an answer no retry changes`.

## Watching every folder

A watch of every folder is `folders watch` run with no directory.

### `folder-sync/watch-every-listed`

When `folders watch` names no directory, the CLI MUST keep every folder that the machine’s folder registry lists in step, in one process.

**Tests:** `device/folders-watch-every.test.ts › keeps every listed folder in step in one process, naming the folder on every line`.

### `folder-sync/watch-every-names-folder`

While `folders watch` runs with no directory, the CLI MUST name the folder’s directory on every line it reports about one folder.

**Tests:** `device/folders-watch-every.test.ts › keeps every listed folder in step in one process, naming the folder on every line`, `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

### `folder-sync/watch-every-own-server`

When a watch of every folder opens a folder whose working copy records the server it was hydrated from, a device MUST keep that folder in step with that server.

**Reason:** Folders on one machine can follow different servers.

**Tests:** `device/folders-watch-every.test.ts › keeps each folder with its own server and credential, and one server down stops only its folder`.

### `folder-sync/watch-every-key-kept-apart`

When a watch of every folder opens a folder whose working copy records a server other than the one the command names, the CLI MUST NOT send that server the credential named for the command.

**Reason:** A key or token is for the server it was named for, and another server could use it.

**Tests:** `device/folders-watch-every.test.ts › keeps each folder with its own server and credential, and one server down stops only its folder`.

### `folder-sync/watch-every-unwatchable-said`

If a folder that the machine’s folder registry lists cannot be watched for a reason other than that its directory cannot be found, then the CLI MUST report the folder’s directory and why once for as long as the reason stays the same.

**Tests:** `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

### `folder-sync/watch-every-others-go-on`

If a watch of every folder cannot watch one listed folder, or that folder’s watch ends, then a device MUST keep the other listed folders in step.

**Tests:** `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`, `device/folders-watch-every.test.ts › ends only the watch of a folder whose credential the server refuses`, `device/folders-watch-every.test.ts › keeps each folder with its own server and credential, and one server down stops only its folder`.

### `folder-sync/watch-every-missing-said`

When a watch of every folder finds that the directories of one or more listed folders cannot be found, the CLI MUST report those directories together in one line, once for as long as no other listed folder’s directory joins them.

**Reason:** A machine’s registry can list many folders whose directories were deleted long ago, and a watch started at every login would otherwise report each of them at every start. The folders stay listed under `folder-setup/registry-missing-kept`, so a person removes one with `folders remove`.

**Tests:** `device/folders-watch-every.test.ts › says in one line which listed folders cannot be found, keeps them listed, and keeps the others in step`, `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

### `folder-sync/watch-every-tried-again`

While a watch of every folder cannot watch a listed folder, a device MUST try the folder again and watch it once it can be watched.

**Tests:** `device/folders-watch-every.test.ts › says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be`.

### `folder-sync/watch-every-root-returns`

When the directory a listed folder was admitted at returns to its path during a watch of every folder, a device MUST keep the folder in step without the folder being added again.

**Tests:** `device/folders-watch-every.test.ts › takes a folder up again once the directory it was added at returns after an empty one stood in its place`.

### `folder-sync/watch-every-credential-refused`

If the server refuses one folder’s credential during a watch of every folder, then the CLI MUST end that folder’s watch without ending the command.

**Tests:** `device/folders-watch-every.test.ts › ends only the watch of a folder whose credential the server refuses`.

### `folder-sync/watch-every-joins`

When the machine’s folder registry comes to list a folder while a watch of every folder runs, a device MUST keep that folder in step without a restart.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folder-sync/watch-every-leaves`

When the machine’s folder registry stops listing a folder while a watch of every folder runs, a device MUST let go of that folder while it keeps the other folders in step.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folder-sync/watch-every-leaves-said`

When a watch of every folder lets go of a folder the machine’s folder registry no longer lists, the CLI MUST report that folder’s directory as no longer listed.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folder-sync/watch-every-registry-unread`

If the machine’s folder registry cannot be read while a watch of every folder runs, then a device MUST keep the folders it watches in step.

**Tests:** `device/folders-watch-every.test.ts › goes on with the folders it watches while the registry cannot be read`.

### `folder-sync/watch-every-none-waits`

While the machine’s folder registry lists no folder, the CLI MUST keep a watch of every folder running.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folder-sync/watch-every-none-said`

When a watch of every folder finds that the machine’s folder registry lists no folder, the CLI MUST say once that no folder is listed.

**Tests:** `device/folders-watch-every.test.ts › waits while no folder is listed, takes up a folder added, and lets go of one removed`.

### `folder-sync/watch-every-interrupt`

If a watch of every folder is interrupted while a folder’s pass waits on a server that does not answer, then the CLI MUST end within three seconds.

**Tests:** `device/folders-watch-every.test.ts › ends soon after an interrupt while a pass waits on the server, keeping the edit it was sending`.

### `folder-sync/watch-every-interrupt-queued`

If a watch of every folder is interrupted before the server answers a folder’s write, then a device MUST keep that write queued for the folder’s next sync.

**Tests:** `device/folders-watch-every.test.ts › ends soon after an interrupt while a pass waits on the server, keeping the edit it was sending`.

## Status beside a watch

### `folder-sync/status-beside-watch`

While another process watches a folder, the CLI MUST answer `folders status` without acquiring the folder’s working handle.

**Tests:** `device/folders-handover.test.ts › hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed`.

### `folder-sync/status-watch-other-build`

When `folders status` runs while a current entry in the record of folder watches lists the folder as watched and that entry’s `build_version` differs from the CLI’s own version or is absent, the CLI MUST report `watch_other_build` with the entry’s `pid`, its `build_version` and the CLI’s own version in `this_version`.

**Reason:** A person who upgraded sees that the watch of the folder still runs the earlier build.

**Tests:** `device/folders-new-build.test.ts › says in the folder's status that its watch runs another build`.

### `folder-sync/status-watch-same-build`

When `folders status` runs and no current entry in the record of folder watches lists the folder as watched with a `build_version` other than the CLI’s own version, or with none, the CLI MUST report `watch_other_build` as `null`.

**Reason:** a program reading the status tells a watch on this build from one on another without testing whether the key is present.

**Tests:** `device/folders-new-build.test.ts › says in the folder's status that its watch runs another build`.

## Pausing a directory's sync

A person pauses one directory, not the folder it follows, with `folders pause` and lets it go on with `folders resume`. The pause lives in the directory's own state on that computer, so another computer that follows the same folder is not paused.

### `folder-sync/pause-command`

When `folders pause` names a directory that follows a folder whose sync runs, the CLI MUST pause the directory's sync, keep the pause in the directory's own state on that computer, and report `paused` as `true` and `changed` as `true`.

**Reason:** The pause is not on the instance, so it pauses one computer's directory and leaves every other directory that follows the folder as it is.

**Tests:** `device/folders-pause.test.ts › is paused and resumed by a command that says so, and says that nothing changed when the directory was already as asked`, `device/folders-pause.test.ts › shows in its status and in the list of folders, and reports to the server that its sync is paused`.

### `folder-sync/pause-already`

When `folders pause` names a directory whose sync is paused, the CLI MUST report `paused` as `true` and `changed` as `false` and change nothing.

**Tests:** `device/folders-pause.test.ts › is paused and resumed by a command that says so, and says that nothing changed when the directory was already as asked`.

### `folder-sync/resume-command`

When `folders resume` names a directory whose sync is paused, the CLI MUST let the directory's sync go on and report `paused` as `false` and `changed` as `true`.

**Tests:** `device/folders-pause.test.ts › is paused and resumed by a command that says so, and says that nothing changed when the directory was already as asked`, `device/folders-pause.test.ts › shows in its status and in the list of folders, and reports to the server that its sync is paused`.

### `folder-sync/resume-not-paused`

When `folders resume` names a directory whose sync is not paused, the CLI MUST report `paused` as `false` and `changed` as `false` and change nothing.

**Tests:** `device/folders-pause.test.ts › is paused and resumed by a command that says so, and says that nothing changed when the directory was already as asked`.

### `folder-sync/pause-sync-refused`

While a directory's sync is paused, the CLI MUST refuse `folders push`, with or without `--send-only`, and `folders pull` for that directory with the error code `sync_paused`, naming `folders resume`.

**Reason:** A command a person types for a paused directory would otherwise undo the pause without saying so.

**Tests:** `device/folders-pause.test.ts › refuses a push, a send-only push and a pull, naming resume, and leaves the directory and the server as they were`.

### `folder-sync/pause-nothing-changes`

While a directory's sync is paused, a device MUST NOT write a file into the directory, change what the directory's store keeps of its files, or send a change to the directory's files to the server for it.

**Reason:** A pause must change nothing, so that what the person resumes is the directory as it stood.

**Tests:** `device/folders-pause.test.ts › refuses a push, a send-only push and a pull, naming resume, and leaves the directory and the server as they were`.

### `folder-sync/pause-watch-refused`

While a directory's sync is paused, a device MUST refuse a watch of that directory, naming `folders resume`.

**Tests:** `device/folders-pause.test.ts › refuses a watch of the directory, naming resume, and watches it again once resumed`, `device/binding-folders-handover.test.ts › refuses a watch of a directory that is paused before it begins`.

### `folder-sync/pause-running-watch-stays`

While a directory's sync is paused after a watch of that directory has started, a device MUST keep the watch running, say that the directory is paused, and watch the directory again once it is resumed.

**Reason:** A pause is a person's choice for a while, so it does not end the watch they would have to start again.

**Tests:** `device/folders-pause.test.ts › keeps a running watch of the directory going while it is paused, says so, and syncs a change once it is resumed`, `device/binding-folders-handover.test.ts › keeps a running watch of the directory going while it is paused, says so, and syncs a change once it is resumed`.

### `folder-sync/pause-watch-skipped`

While a directory's sync is paused, a device MUST NOT watch the directory in a watch of every folder, whether the watch started before or after the pause.

**Reason:** The watch skips the directory and keeps watching every other.

**Tests:** `device/folder-watch-record.test.ts › lists a folder whose sync is paused as not watched and paused, keeps it so across a restart of the watch, and watches it once it is resumed`.

### `folder-sync/pause-survives-restart`

While a directory's sync is paused, a device MUST leave the directory paused when a watch of it ends and another starts.

**Reason:** The pause is kept in the directory's own state, so it lasts through the end of a watch, a restart of the computer and a login that starts the watch again.

**Tests:** `device/folder-watch-record.test.ts › lists a folder whose sync is paused as not watched and paused, keeps it so across a restart of the watch, and watches it once it is resumed`.

### `folder-sync/resume-watch-takes`

When a paused directory is resumed, a device MUST watch the directory in a watch of every folder.

**Tests:** `device/folder-watch-record.test.ts › lists a folder whose sync is paused as not watched and paused, keeps it so across a restart of the watch, and watches it once it is resumed`, `device/folders-pause.test.ts › refuses a watch of the directory, naming resume, and watches it again once resumed`.

### `folder-sync/resume-catches-up`

When a paused directory is resumed, a device MUST send at the directory's next sync what changed in the directory while it was paused, and write what changed on the server while it was paused.

**Reason:** The sync is the one a watch that starts again makes, so a file changed on both sides is a conflict as it is at any other time.

**Tests:** `device/folders-pause.test.ts › sends on resume what changed in the directory and writes what changed on the server while it was paused`.

### `folder-sync/pause-status`

While a directory's sync is paused, the CLI MUST report `sync_paused` as `true` in the answer of `folders status`.

**Tests:** `device/folders-pause.test.ts › shows in its status and in the list of folders, and reports to the server that its sync is paused`.

### `folder-sync/pause-status-words`

While a directory's sync is paused, the CLI MUST say in the text of `folders status` that the sync is paused.

**Tests:** `device/folders-pause.test.ts › shows in its status and in the list of folders, and reports to the server that its sync is paused`.

### `folder-sync/pause-list`

While a directory's sync is paused, the CLI MUST report `paused` as `true` for the directory in the answer of `folders list`.

**Tests:** `device/folders-pause.test.ts › shows in its status and in the list of folders, and reports to the server that its sync is paused`.

### `folder-sync/pause-reported`

While a directory's sync is paused, a device MUST report `paused` with a count of 1 among the problems of the folder's report to the server.

**Reason:** A person or an app reading the folder's health from the server tells a folder that is paused from one that has stopped syncing.

**Tests:** `device/folders-pause.test.ts › shows in its status and in the list of folders, and reports to the server that its sync is paused`.

### `folder-sync/pause-last-success`

When a directory's sync is paused, a device MUST NOT change the `last_success_at` its reports carry.

**Reason:** A pause is not a sync, so it does not say the directory is in step.

**Tests:** `device/folders-pause.test.ts › does not move the last success a report carries`.

## A part of a directory a watch cannot watch

On some systems a watch registers each directory with the system one by one, and the system refuses once its limit is reached. The directories refused have no event for a change in them.

### `folder-sync/unwatched-reported`

While a watch cannot register some directories beneath a folder's directory with the system, a device MUST report `unwatched` among the problems of the folder's report to the server, with the number of those directories as its count.

**Reason:** A report that a folder is in step says nothing about a change in a directory nothing watches.

**Tests:** `device/folders-unwatched.test.ts › reports each directory it cannot watch, says so in the folder's status, and stops once it can watch them`.

### `folder-sync/unwatched-cleared`

When a watch has registered every directory beneath a folder's directory, a device MUST report no `unwatched` problem for the folder.

**Tests:** `device/folders-unwatched.test.ts › reports each directory it cannot watch, says so in the folder's status, and stops once it can watch them`.

### `folder-sync/unwatched-status`

While a watch cannot register some directories beneath a folder's directory, the CLI MUST report the number of them as `unwatched` in the answer of `folders status`.

**Tests:** `device/folders-unwatched.test.ts › reports each directory it cannot watch, says so in the folder's status, and stops once it can watch them`.

### `folder-sync/unwatched-status-words`

While a watch cannot register some directories beneath a folder's directory, the CLI MUST say in the text of `folders status` that they cannot be watched.

**Reason:** a person reading that the files are in step would take a change in those directories to be in step too.

**Tests:** `device/folders-unwatched.test.ts › reports each directory it cannot watch, says so in the folder's status, and stops once it can watch them`.

## Folders kept apart, and first writes

### `folder-sync/independent-folders`

When files in different directories are scanned, a device MUST keep each directory's queued writes separate.

**Tests:** `device/folders.test.ts › keeps each folder's state and queue to itself`.

### `folder-sync/empty-directory`

When a folder is added to an empty directory, a device MUST materialize the held items during pull.

**Tests:** `device/folders.test.ts › hydrates into an empty directory and pushes without holding anything else`.

### `folder-sync/empty-directory-push`

When a file is edited in a newly added directory, a device MUST send that edit during push.

**Tests:** `device/folders.test.ts › hydrates into an empty directory and pushes without holding anything else`.

### `folder-sync/item-to-file`

When a pull meets an item held by the folder query and eligible for writing, a device MUST write the item as a file.

**Tests:** `device/folders.test.ts › makes a file an item and an item a file`.

### `folder-sync/file-to-item`

When a push meets an admissible new file, a device MUST create its item on the server.

**Tests:** `device/folders.test.ts › makes a file an item and an item a file`.

## Pulls and pushes

### `folder-sync/pull-gone-item-file`

If an item leaves the working copy before a pull writes its file, then a device MUST NOT write a file for that item.

**Tests:** `device/folders-identity.test.ts › writes no file for an item purged while the pull writes it, and reads the copy again`.

### `folder-sync/pull-gone-item-binding`

If an item leaves the working copy before a pull writes its file, then a device MUST NOT bind a file to that item.

**Tests:** `device/folders-identity.test.ts › writes no file for an item purged while the pull writes it, and reads the copy again`.

### `folder-sync/pull-gone-item-placement`

If an item leaves the working copy before a pull queues its placement, then a device MUST NOT queue a placement for that item.

**Tests:** `device/folders-identity.test.ts › places nothing for an item purged before its placement is queued, and takes its file away at the next pull`.

### `folder-sync/pull-gone-item-continue`

If an item leaves the working copy during a pull, then a device MUST continue the pull without failing solely because that item is gone.

**Tests:** `device/folders-identity.test.ts › writes no file for an item purged while the pull writes it, and reads the copy again`, `device/folders-identity.test.ts › places nothing for an item purged before its placement is queued, and takes its file away at the next pull`.

### `folder-sync/pull-retry-copy`

When the working copy changes under a pull, a device MUST restart the pull from a fresh read of the copy, making at most three attempts in total.

**Tests:** `device/folders-identity.test.ts › pulls again where the copy changes under the pull`, `device/folders-contract-c.test.ts › retries a changed copy three times in total and succeeds on the third stable read`.

### `folder-sync/pull-retry-counts`

When a pull restarts after its working copy changes, a device MUST include completed file writes, rewrites, moves, revivals, placements, placement ends, removals, purged-file removals, transfers in and transfers out from earlier attempts in its final report.

**Tests:** `device/folders-identity.test.ts › counts what an attempt wrote before the copy changed under it`, `device/folders-contract-c.test.ts › counts files and placements from before a restarted pull exactly once`, `device/folders-contract-c-retry.test.ts › retains rewrite and move counts across a restart`, `device/folders-contract-c-retry.test.ts › retains revival counts across a restart`, `device/folders-contract-c-retry.test.ts › retains removal, purge and placement-end counts across a restart`, `device/folders-contract-c-retry.test.ts › retains transfer-%s counts across a restart`.

### `folder-sync/watch-copy-change-notice`

When the working copy keeps changing under consecutive `folders watch` passes, the CLI MUST report the condition once for that run of passes.

**Tests:** `device/folders-identity.test.ts › goes on watching where the copy keeps changing under its pull, and says so once`.

### `folder-sync/watch-copy-change-retry`

When a watch pass exhausts its pull attempts because the working copy keeps changing, a device MUST continue watching and retry the pull in the next pass.

**Tests:** `device/folders-identity.test.ts › goes on watching where the copy keeps changing under its pull, and says so once`.

### `folder-sync/watch-store-busy-notice`

If another program's writes to a directory's store keep a `folders watch` from writing to the store, then the CLI MUST report the condition once for each run of failures.

**Tests:** `device/store-busy-live.test.ts › says once that another program kept the watch's follow from writing to the folder's store, goes on watching and takes the server's next change`, `› says once that another program kept a watch's pass from writing to the folder's store, goes on watching and sends the edit`.

### `folder-sync/watch-store-busy-delay`

While another program's writes keep a folder watch's follow from writing to the directory's store, a device MUST double its delay before each next follow from one second up to thirty seconds.

**Tests:** `device/store-busy-live.test.ts › says once that another program kept the watch's follow from writing to the folder's store, goes on watching and takes the server's next change`.

### `folder-sync/watch-store-busy-retry`

If another program's writes to a directory's store keep a folder watch from writing to the store, then a device MUST continue watching and make the write again from fresh reads.

**Tests:** `device/store-busy-live.test.ts › says once that another program kept the watch's follow from writing to the folder's store, goes on watching and takes the server's next change`, `› says once that another program kept a watch's pass from writing to the folder's store, goes on watching and sends the edit`.

### `folder-sync/pull-flagged-items`

When a pull counts an item as `unwritten`, `outside`, `unsuited` or `absent`, a device MUST include the item's ID, intended path or retained file path, flag and reason in the pull report's `flagged` entries, using `retained` as the flag for a file it could not let go to another directory.

**Tests:** `device/folders.test.ts › takes only what its include list names`, `device/folders.test.ts › refuses to write a file outside the folder`, `device/folders.test.ts › does not write over a file it never wrote`, `device/folders-placement.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`, `device/folders-placement.test.ts › writes no file where its placement would make it another kind of file`, `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-sync/pull-carried-flagged`

While a file in the directory that the scan holds for a clash with another file's name, or does not send, and whose name is not the missing file's name followed by a suffix, carries the missing file's identity or the ID of its item, when a pull runs, a device MUST include the item's ID, the missing file's path, the flag `carried` and a reason that names the carrying file in the pull report's `flagged` entries.

**Reason:** the pull writes no second file for the item, and a flag such as `unwritten` would count it as a pending download (`folder-sync/report-pending-downloads`) and as a held file.

**Tests:** `device/folders-contract-b.test.ts › flags a pull's item with the file that carries it, as no download`, `› holds a new file at the path of a file the folder does not send, and sends it once that file has a name the folder sends`.

### `folder-sync/report-distinct-items`

When `folders push` or `folders watch` reports items held back by a pull, the CLI MUST report each item once, including separate entries for different items at the same path.

**Tests:** `device/folders.test.ts › names each item it holds back at a secret's name, two at one path as two`.

### `folder-sync/elsewhere-unflagged`

When a pull counts an item as `elsewhere` because its file is moving to another directory on the machine, a device MUST NOT include the item in the pull report's `flagged` entries.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`.

### `folder-sync/push-send-placement`

When a folder sync writes a file whose placement is not on the server, a device MUST send that placement in the same sync unless `folder-sync/push-server-unavailable`, `folder-sync/push-credential-stopped` or `folder-sync/push-undelivered` prevents a further drain.

**Tests:** `cli/folder.test.ts › is in step after the one push that writes its files`, `cli/folder.test.ts › is in step after the push that runs a confirmed first sync`, `device/folders.test.ts › sends the placement of each file a push writes in the push, and counts it`.

### `folder-sync/push-count-placement`

When a folder sync sends a placement after its pull, a device MUST include that placement in the sync report's count of answered writes.

**Tests:** `cli/folder.test.ts › is in step after the one push that writes its files`, `device/folders.test.ts › sends the placement of each file a push writes in the push, and counts it`.

### `folder-sync/push-server-unavailable`

If a folder sync's catch-up fails environmentally or its first drain reports the server unavailable, then a device MUST NOT drain again after that sync's pull.

**Tests:** `device/folders.test.ts › leaves the placements of the files a push wrote waiting where it could not reach the server, and sends them at the next push`, `device/folders.test.ts › leaves the placements waiting where the server fails them as the push sends them, and sends them at the next push`.

### `folder-sync/push-credential-stopped`

If a folder sync's first drain stops because the server refuses the credential, then a device MUST NOT drain again after that sync's pull.

**Tests:** `device/folders.test.ts › does not drain again after a push whose first drain a refused credential stopped`.

### `folder-sync/push-undelivered`

If a folder sync's first drain leaves a write undelivered, then a device MUST NOT drain again after that sync's pull.

**Tests:** `device/folders.test.ts › does not drain again after a push whose first drain left a write undelivered`, `device/folders.test.ts › leaves the writes a rate limit refused for the next push, without waiting`.

### `folder-sync/push-rate-limit-no-wait`

If a folder sync's drain leaves a write undelivered and reports `retry_after_seconds`, then a device MUST end the sync without waiting for that time, and keep the write queued.

**Reason:** A sync holds the folder's writer for as long as it runs, so a sync that waited out the server would keep every other command from the folder for a time the server sets, and could not be interrupted. The caller, or a watch, tries again.

**Tests:** `device/folders.test.ts › leaves the writes a rate limit refused for the next push, without waiting`.

### `folder-sync/push-rate-limit-no-wait-send-only`

If a send-only run's drain leaves a write undelivered and reports `retry_after_seconds`, then a device MUST end the run without waiting for that time, and keep the write queued.

**Tests:** `device/folders-send-only.test.ts › leaves the write a rate limit refused for the next run, without waiting`.

### `folder-sync/watch-rate-limit-pause`

When a folder watch's pass leaves a write undelivered and its drain reports `retry_after_seconds`, a device MUST NOT start another pass of that watch until that time has passed.

**Reason:** A write sent before the time has passed is refused again, and spends the key's rate limit.

**Tests:** `device/folders.test.ts › sends again when the Retry-After a rate limit named is over, without waiting for a change`.

### `folder-sync/watch-rate-limit-handover`

When a folder watch takes back a folder it let go to a command, a device MUST NOT start a pass of that folder before the time named by the `retry_after_seconds` of the most recent drain of that folder that left a write undelivered, whether the watch or the command drained, unless a later drain of the folder has had writes answered with no `retry_after_seconds`.

**Reason:** A hand-over does not reset the server's rate limit, so a watch that forgot the time would send at once and be refused again (`folder-sync/watch-rate-limit-pause`).

**Tests:** `device/folders-handover.test.ts › keeps the server's wait across handing a folder over from $name`.

### `folder-sync/watch-rate-limit-says`

When a folder watch's pass leaves a write undelivered because the server answered `429`, or the server answers the watch's changes stream `429`, the CLI MUST say that the server is limiting requests and, where the server named a `Retry-After`, for how many seconds the watch waits.

**Reason:** a `503` or another answer can name a `Retry-After` too, and the server is then not limiting requests, so a person told it is looks at the key's request count where the cause is the server.

**Tests:** `device/folders.test.ts › sends again when the Retry-After a rate limit named is over, without waiting for a change`, `› says the server is limiting requests, not that it cannot be reached, when its changes stream is limited`, `› does not say the server is limiting requests when it answers 503 with a Retry-After`.

### `folder-sync/watch-rate-limit-not-unreachable`

When the server limits requests to a folder watch, the CLI MUST NOT say that it cannot reach the server.

**Reason:** the server answered, so reach is not lost, and a person told otherwise looks for a network fault where the cause is the key's own request count.

**Tests:** `device/folders.test.ts › sends again when the Retry-After a rate limit named is over, without waiting for a change`, `› says the server is limiting requests, not that it cannot be reached, when its changes stream is limited`.

### `folder-sync/push-exit-undelivered`

When a folder push ends with its drain reporting `unavailable` or a write `undelivered`, and no refused credential stopped it, the CLI MUST exit 3.

**Reason:** A script or a person cannot tell a push that sent everything from one that left writes queued by its summary alone.

**Tests:** `device/folders.test.ts › ends 3 and says so while a rate limit leaves writes undelivered, and counts them waiting`, `device/folders.test.ts › does not drain again after a push whose first drain left a write undelivered`.

### `folder-sync/push-exit-send-only`

When a send-only run ends with its drain reporting `unavailable` or a write `undelivered`, and no refused credential stopped it, the CLI MUST exit 3.

**Tests:** `device/folders-send-only.test.ts › keeps its writes queued where the server cannot be reached, and sends them at the next run`.

### `folder-sync/push-exit-credential`

When a folder push or a send-only run ends with its drain stopped by a refused credential, the CLI MUST exit 5.

**Tests:** `device/folders.test.ts › does not drain again after a push whose first drain a refused credential stopped`.

### `folder-sync/push-exit-catchup-failed`

When a folder push's catch-up fails environmentally, the CLI MUST exit 3.

**Tests:** `device/folders.test.ts › pulls at a push that cannot reach the server, and says the catch-up failed`.

### `folder-sync/scan-waiting`

When a folder scan finds a file whose bytes are as they were bound and whose write the server has not answered, a device MUST count it in the report's `waiting` and not in `unchanged`.

**Reason:** A file whose write the server never took is not agreed with the server, and a summary that called it unchanged hides the writes still to send.

**Tests:** `device/folders.test.ts › ends 3 and says so while a rate limit leaves writes undelivered, and counts them waiting`, `device/binding-folders-clock.test.ts › counts a file whose create the server has not answered waiting, and unchanged once it has`.

### `folder-sync/scan-waiting-not-dead`

When a folder scan finds a file whose bytes are as they were bound and whose only unanswered write is dead, a device MUST count it in `unchanged` and not in `waiting`.

**Reason:** A dead write is not sent again unless someone releases it, so nothing waits to be delivered.

**Tests:** `device/folders.test.ts › counts a file whose create died unchanged, not waiting`.

### `folder-sync/scan-waiting-said`

When a folder scan counts a file `waiting`, the CLI MUST say how many in its text report.

**Tests:** `device/folders.test.ts › ends 3 and says so while a rate limit leaves writes undelivered, and counts them waiting`.

### `folder-sync/not-a-folder-refused`

If a folder command that works a folder is given a directory no folder follows, then the CLI MUST refuse it `invalid` with exit 1, and work nothing.

**Reason:** A script that runs `folders push` on a path it believes is a folder must be able to tell that nothing was sent.

**Tests:** `device/folders.test.ts › ends every command on a directory that is not a folder with the refused exit`.

### `folder-sync/push-placement-retry`

When a folder sync leaves placements queued after its pull and a later sync can deliver them, a device MUST send those placements in the later sync.

**Tests:** `device/folders.test.ts › leaves the placements of the files a push wrote waiting where it could not reach the server, and sends them at the next push`, `device/folders.test.ts › leaves the placements waiting where the server fails them as the push sends them, and sends them at the next push`, `device/folders.test.ts › does not drain again after a push whose first drain left a write undelivered`.

### `folder-sync/push-placement-verdict`

When the server refuses a placement sent after a folder sync's pull, a device MUST include that refusal among the sync report's verdicts.

**Tests:** `device/folders.test.ts › reports a placement the server refuses in the push's second drain, and does not send it again`.

### `folder-sync/push-placement-withheld`

While the key, saved folder settings and placement used by a refused placement write remain unchanged, a device MUST NOT send that placement write again.

**Tests:** `device/folders.test.ts › reports a placement the server refuses in the push's second drain, and does not send it again`.

### `folder-sync/clears-recorded-answers`

When a folder's drain begins, a device MUST take out of the folder's queue each write that clearing the answered writes takes out (`queue-and-verdicts/clear-answered`, `queue-and-verdicts/clear-withdrawn-leftovers`), other than a write whose answer a file's record still waits on or a link rewrite the folder has yet to settle.

**Reason:** a folder sends a write for each edit it reads. Kept after the folder had recorded its answer, every write it ever sent stayed in the queue, and every drain read them all, so a quiet folder cost more with each edit. An answered write is laid over no item of the working copy, so taking it out changes nothing a pull reads, and a quiet folder stays quiet (`folder-speed/watch-pull-renders-reached`).

**Tests:** `device/folders-cleared-answers.test.ts › clears the writes it recorded as its next drain begins, and keeps a refused edit's words and every refusal it shows`.

### `folder-sync/clears-satisfied-edge-refusal`

When a folder's drain begins and the working copy holds, as the server last gave it, an edge with the from item, to item and type of an edge create the server refused and with every property that create carried, a device MUST take that create out of the folder's queue, other than a placement, a create another write depends on or follows, a create whose answer a file's record or a link rewrite still waits on, a create with a receipt or a read still owed, or a create whose refusal a file still shows.

**Reason:** a refused write otherwise leaves only by `queue-and-verdicts/discard-refused`, which a watch's hold on the store refuses, and no file shows this one, so it would stay for good asking for what the server already holds. An item of the copy's own, at version 0, or with a write waiting on it is no proof of what the server holds.

**Tests:** `device/folders-cleared-answers.test.ts › takes out a refused edge create once the server has given the copy its edge, moving nothing else`.

### `folder-sync/clears-repeated-edge-refusal`

When a folder's drain begins and the folder's queue holds an edge create the server refused and a later create of the same from item, to item and type that carries every property the earlier one carried and that is unanswered, `blocked` or refused by the server, a device MUST take the earlier create out of the folder's queue, other than a placement, a create another write depends on or follows, a create whose answer a file's record or a link rewrite still waits on, or a create with a receipt or a read still owed.

**Reason:** a refusal the server gave stands until the file changes (`folder-setup/refused-line-retried`), and where the copy does not hold what the server refused it for, such as an edge from an item outside the directory, each save of the file queues the line's edge again under a new id, so without this the queue grows by one create with each save for as long as the refusal stands. The later create carries all the earlier one did. A file's flag and its reason are in the file's record and not in the create, so the file shows the refusal as it did.

**Tests:** `device/folders-cleared-answers.test.ts › holds one refused edge create of a line however often its file is saved, and the file keeps its reason`.

### `folder-sync/conflict-file-report`

When `folders push` or a `folders watch` pass receives a `conflicted` verdict for an edit to a file in that directory, the CLI MUST name the file in its text output.

**Tests:** `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`, `cli/folder.test.ts › says a conflicted edit while watching, and where its text went`, `device/folders.test.ts › names the file a conflicted edit's text went to, in a push`, `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`.

### `folder-sync/conflict-copy-file`

When `folders push` or `folders watch` reports a conflicted edit whose conflicted copy has a file in that directory, the CLI MUST name that file as the destination of the edit's text.

**Tests:** `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`, `cli/folder.test.ts › says a conflicted edit while watching, and where its text went`, `device/folders.test.ts › names the file a conflicted edit's text went to, in a push`.

### `folder-sync/conflict-copy-pending`

When `folders push` or `folders watch` reports a conflicted edit whose conflicted copy has no file in that directory yet, the CLI MUST say that the copy is not a file in the directory yet.

**Tests:** `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`.

### `folder-sync/conflict-copy-arrival`

When a `folders watch` pass writes a conflicted copy previously reported as having no file yet, the CLI MUST report the file that now holds the edit's text.

**Tests:** `device/folders.test.ts › says in a watch the file a conflicted copy became, once it is one`.

### `folder-sync/conflict-report-once`

When `folders push` or `folders watch` has reported a conflicted write, the CLI MUST NOT report that verdict again.

**Tests:** `device/folders.test.ts › says a conflicted edit while watching, and that its copy is not a file yet`, `cli/folder.test.ts › names a conflicted edit and the file its text went to, in words`.

### `folder-sync/conflict-other-item`

When a conflicted write belongs to an item with no file in the watched or pushed directory, the CLI MUST NOT report that conflict as the directory's.

**Tests:** `device/folders.test.ts › does not name a conflict on a write that is no file of the folder's, in a push`, `device/folders.test.ts › does not name a conflict on a write that is no file of the folder's, in a watch`.

## Sending without pulling

A send-only run is `folders push --send-only`.

### `folder-sync/send-only-scans-and-sends`

When `folders push` is given `--send-only`, the CLI MUST send the writes that a scan of the directory queues.

**Reason:** a person who adds files or edits them while away can send them without the server's items arriving in the directory.

**Tests:** `device/folders-send-only.test.ts › sends a file made here and writes no file into the directory, where a push writes the server's item`, `device/folders-send-only.test.ts › keeps its writes queued where the server cannot be reached, and sends them at the next run`.

### `folder-sync/send-only-writes-no-file`

When `folders push` is given `--send-only`, the CLI MUST NOT write a file into the directory outside its `.marfa` state directory.

**Tests:** `device/folders-send-only.test.ts › sends a file made here and writes no file into the directory, where a push writes the server's item`, `device/folders-send-only.test.ts › hydrates a copy that never was first, which writes no file, and then sends`, `device/folders-placement.test.ts › sends a renamed note's new name as its title in a send-only run, which leaves the file's bytes, and a push after it rewrites the title line`, `device/folders-placement.test.ts › leaves an old buffer saved where another Mac moved the file from where it is in a send-only run, and takes it in the push after`.

### `folder-sync/send-only-removes-no-file`

When `folders push` is given `--send-only`, the CLI MUST NOT remove a file from the directory.

**Tests:** `device/folders-send-only.test.ts › removes no file whose item has left, where a push removes it`, `device/folders-placement.test.ts › leaves the temporary file a crashed pull left in a send-only run, and removes it in the push after`.

### `folder-sync/send-only-report-sent`

When `folders push --send-only` finishes, the CLI MUST report the writes it sent in the `drain` of its JSON report.

**Tests:** `device/folders-send-only.test.ts › says what it sent and that it did not pull, in JSON and in words`.

### `folder-sync/send-only-report-not-pulled`

When `folders push --send-only` finishes, the CLI MUST report `pulled` as `false` in its JSON report.

**Tests:** `device/folders-send-only.test.ts › says what it sent and that it did not pull, in JSON and in words`.

### `folder-sync/send-only-report-words`

When `folders push --send-only` finishes, the CLI MUST say in its text report that nothing was pulled.

**Tests:** `device/folders-send-only.test.ts › says what it sent and that it did not pull, in JSON and in words`.

### `folder-sync/send-only-later-push-pulls`

When a `folders push` without `--send-only` follows a send-only run, the CLI MUST write the files of the items that run left unpulled.

**Tests:** `device/folders-send-only.test.ts › leaves what it did not pull for the next push`.

### `folder-sync/send-only-rename-line-follows`

Where a renamed Markdown document's title line is as a send-only run left it and its file is not held, when a `folders push` without `--send-only` follows that run, which sent the document's new name as its title, the CLI MUST rewrite the title line to the item's title.

**Reason:** a send-only run leaves every byte of the file, so the line still shows the old title until a run that writes files. Until then the line is no edit of the title, whatever title the item holds, and a title the person types in the line is theirs.

**Tests:** `device/folders-placement.test.ts › sends a renamed note's new name as its title in a send-only run, which leaves the file's bytes, and a push after it rewrites the title line`, `› keeps the new name's title through every save made after a send-only run that sent it, before a push writes the title line`, `› keeps a title changed elsewhere after a send-only run that sent the new name's, through a body edit`, `› keeps a title changed back to the old one after a send-only run that sent the new name's, through a body edit`, `› keeps a title another Mac set before this copy heard of it, through a body edit in a second send-only run`, `› sends a title typed in the line after a send-only run that sent the new name's, and keeps it`, `› keeps the new name's title where the body is edited after a send-only run that sent it`.

### `folder-sync/send-only-hydrates`

When a folder's copy has not hydrated, the CLI MUST hydrate it before `folders push --send-only` sends.

**Reason:** a drain on a copy that has not hydrated is refused with `no_cursor`; hydrating writes only the directory's store, never an item's file.

**Tests:** `device/folders-send-only.test.ts › hydrates a copy that never was first, which writes no file, and then sends`.

### `folder-sync/send-only-first-sync-refused`

While a folder's first sync waits for confirmation, the CLI MUST refuse `folders push --send-only` with `first_sync_waiting`.

**Tests:** `device/folders-send-only.test.ts › is refused while the first sync waits, before it sends anything`.

### `folder-sync/send-only-first-sync-nothing-sent`

While a folder's first sync waits for confirmation, the CLI MUST NOT send a write to the server when `folders push --send-only` is run.

**Tests:** `device/folders-send-only.test.ts › is refused while the first sync waits, before it sends anything`.

### `folder-sync/send-only-offline-queued`

If the server cannot be reached, then the CLI MUST keep the folder's unsent writes queued when `folders push --send-only` is run.

**Tests:** `device/folders-send-only.test.ts › keeps its writes queued where the server cannot be reached, and sends them at the next run`.

### `folder-sync/send-only-offline-reported`

If the server cannot be reached, then the CLI MUST report the writes it could not deliver in `drain.undelivered` when `folders push --send-only` is run.

**Tests:** `device/folders-send-only.test.ts › keeps its writes queued where the server cannot be reached, and sends them at the next run`.

## What a watch tells the person

### `folder-sync/watch-answered-waiting`

When a folder watch reports a pass, the CLI MUST distinguish answered writes from writes still waiting.

**Tests:** `device/folders.test.ts › says once that a watch cannot reach the server, and once that it can again`.

### `folder-sync/watch-unreachable-once`

When a folder watch loses or regains access to the server, the CLI MUST say the reachability change once without repeating it while unchanged.

**Tests:** `device/folders.test.ts › says once that a watch cannot reach the server, and once that it can again`.

### `folder-sync/watch-reachability-details`

When a folder watch reports that its server cannot be reached, the CLI MUST identify the server and the reason in that notice.

**Tests:** `device/folders.test.ts › says once that a watch cannot reach the server, and once that it can again`, `device/folders.test.ts › waits out a gateway refusing its key, naming no contract, without stopping`.

### `folder-sync/watch-hydration-notice`

While a folder watch retries an environmentally failed hydration, the CLI MUST say the failure once for that run of failures.

**Tests:** `device/folders.test.ts › keeps watching through a hydration that failed, and tries it again`.

### `folder-sync/push-stopped-reason`

When a folder push’s drain stops, the CLI MUST say why it stopped.

**Tests:** `device/folders.test.ts › says why a push's drain stopped`.

### `folder-sync/watch-stopped-reason`

When a folder watch's drain has a new or changed stop reason, the CLI MUST say why it stopped.

**Tests:** `device/folders.test.ts › stops a watch whose credential is refused, with the credential's exit`.

### `folder-sync/watch-credential-exit`

When a folder watch receives the server’s contract-named credential refusal, the CLI MUST end the watch with exit code 5.

**Tests:** `device/folders.test.ts › stops a watch whose credential is refused, with the credential's exit`.

### `folder-sync/watch-credential-exit-reason-said`

When a folder watch receives the server’s contract-named credential refusal, the CLI MUST say that changes not yet sent wait for a working credential.

**Tests:** `device/folders.test.ts › stops a watch whose credential is refused, with the credential's exit`.

### `folder-sync/gateway-refusal-waited`

When a folder watch receives `401` without the server’s contract header, a device MUST retry as an environmental failure instead of treating the credential as refused.

**Tests:** `device/folders.test.ts › waits out a gateway refusing its key, naming no contract, without stopping`.

### `folder-sync/watch-grace-silent`

When a `folders watch` pass only waits for a journaled deletion's grace period to end, the CLI MUST produce no report for that pass.

**Tests:** `device/folders.test.ts › says nothing for passes that only wait out a delete's grace`.

### `folder-sync/watch-notice-once`

When a `folders watch` pass reports new activity, the CLI MUST NOT repeat a standing notice unchanged since the preceding pass.

**Tests:** `device/folders.test.ts › says a refused secret once while a delete waits out its grace and other passes report`, `device/folders.test.ts › says a refused title lookup once while another notice changes and other passes report`.

### `folder-sync/watch-notice-change`

When a standing notice changes during `folders watch`, the CLI MUST report the changed notice in the pass that observes it.

**Tests:** `device/folders.test.ts › says a refused secret in words once while watching`.

## Remote sync reports

### `folder-sync/report-copy`

When a device reports a folder's sync health to `PUT /folders/{id}/status`, a device MUST name the existing opaque folder-store identity of that local copy as `folder_store_id`.

**Tests:** `device/folder-health.test.ts › reports a confirmed complete sync using the registry's opaque copy identity`.

### `folder-sync/report-fields`

When a device reports a folder's sync health, a device MUST send only `folder_store_id`, `sequence`, `last_success_at`, `pending_uploads`, `pending_downloads`, `paused_removals`, `first_sync_waiting`, and the safe problem counts accepted by `folder-status/problem-codes`.

**Tests:** `device/folder-health.test.ts › reports a confirmed complete sync using the registry's opaque copy identity`.

### `folder-sync/report-pending-uploads`

While a folder inventory is complete, a device MUST report as `pending_uploads` the number of files `folders status` lists as `waiting`.

**Tests:** `device/folder-health.test.ts › counts the files its status shows waiting as pending uploads`, `› counts no problem for a file whose item is already in the bin`.

### `folder-sync/report-pending-downloads`

When a pull completes, a device MUST report as `pending_downloads`, until a later pull completes, the number of distinct items that pull flagged `unwritten`, `absent`, `outside` or `unsuited`.

**Tests:** `device/folder-health.test.ts › counts what the last pull could not write as pending downloads and held files, until a later pull writes it`, `device/folders-placement.test.ts › reports each item a pull could not write as one pending download, and as a held file unless its bytes were absent`.

### `folder-sync/report-paused-removals`

A device MUST report as `paused_removals` the sum of the `disk` and `pull` counts of `paused` in `folders status`.

**Tests:** `device/folder-health.test.ts › counts the removals a large removal holds on disk or from a pull as paused removals and no problem`.

### `folder-sync/report-refused-files`

When `folders status` flags a file `refused` or `default_edge_refused`, a device MUST count that file in its report under `refused`.

**Tests:** `device/folder-health.test.ts › counts a file the server refused under refused`, `device/folders-default-refused.test.ts › shows a default the copy refused for a document and a file, and makes it once the edge type admits it, the files unchanged`.

### `folder-sync/report-unreadable-files`

When `folders status` flags a file `encoding` or `unreadable` and the file does not lie beneath a directory flagged `unreadable`, a device MUST count that file in its report under `unreadable`.

**Reason:** a file beneath an unreadable directory is counted through the directory, by `folder-sync/report-unreadable-once`.

**Tests:** `device/folder-health.test.ts › counts a file flagged encoding or unreadable under unreadable`.

### `folder-sync/report-held-files`

When `folders status` flags a file with a flag other than `removal`, `query`, `gone`, `refused`, `default_edge_refused`, `credential_refused`, `encoding` or `unreadable`, a device MUST count that file in its report under `held_file`.

**Reason:** a file held for any cause the other statements do not name is one the person still has to act on. The fixtures below witness `empty`, `addition`, `outside_query`, `edges` and `dead`; `name`, `lost` and `lists` have none.

**Tests:** `device/folder-health.test.ts › counts an empty file as a held file, and a file the query leaves alone as no problem`, `› keeps dead file effects current until an accepted replacement, survives clear and restart, and restores them on release`, `device/folders-additions.test.ts › is held, named apart from a removal in status, and its files stay on the disk`, `device/folders-outside-query.test.ts › is held unsent and unwritten, shown in status and listed as unmatched`, `device/folders-held-links.test.ts › resolves a body link once its target is created on this machine, and asks nothing while the folder is quiet`.

### `folder-sync/report-unproblematic-files`

When `folders status` flags a file `removal`, `query` or `gone`, a device MUST NOT count that file in its report under any problem code.

**Reason:** a removal held back is counted by `folder-sync/report-paused-removals`, a file the query leaves alone is not a fault, and a file whose item is already in the bin only waits for a scan to let it go.

**Tests:** `device/folder-health.test.ts › counts the removals a large removal holds on disk or from a pull as paused removals and no problem`, `› counts an empty file as a held file, and a file the query leaves alone as no problem`, `› counts no problem for a file whose item is already in the bin`.

### `folder-sync/report-unreadable-once`

While a file flagged `unreadable` lies beneath a directory flagged `unreadable`, a device MUST count the directory and not the file under `unreadable`.

**Tests:** `device/folder-health.test.ts › counts a file in an unreadable directory only through the directory`.

### `folder-sync/report-pull-problems`

When a pull completes, a device MUST count under `held_file`, until a later pull completes, each distinct item that pull flagged `unwritten`, `outside` or `unsuited`.

**Tests:** `device/folder-health.test.ts › counts what the last pull could not write as pending downloads and held files, until a later pull writes it`, `device/folders-placement.test.ts › reports each item a pull could not write as one pending download, and as a held file unless its bytes were absent`.

### `folder-sync/report-conflicts`

A device MUST report under `conflict` the number of items outside the bin that are tagged `conflicted-copy` and are the from item of a `derived-from` edge with a bound file's item at either end.

**Tests:** `device/folder-health.test.ts › counts a tagged copy derived from a bound file as a conflict, whichever end holds the file, and neither one in the bin nor one without the tag`, `› counts no conflict for a tagged copy derived from an item when neither has a file`.

### `folder-sync/report-credential-refused`

If the server answers a write from a folder with `401 unauthorized`, then a device MUST report `credential_refused` with a count of 1, however many files that holds back.

**Reason:** a refused key is one fault of the whole folder, not one problem for each file it holds back.

**Tests:** `device/folder-health.test.ts › counts one credential_refused however many files a refused key holds back`.

### `folder-sync/report-unavailable`

If the server cannot be reached, or answers a read of a folder's changes with `403`, `429` or a `5xx`, then a device MUST report `unavailable` with a count of 1.

**Reason:** a `403` on a read is a grant that may not read, which `folder-sync/report-credential-refused` does not cover. `folder-sync/health-hydrating` withholds this report while a copy that answers `hydration_incomplete` fills.

**Tests:** `device/folder-health.test.ts › does not advance last full success after an offline push with an empty queue`, `› reports unavailable while the server answers a read %s`, `› reports unavailable, and not credential_refused, for a read the server answers 403`.

### `folder-sync/report-root-gone`

When a pass reports `root_gone`, a device MUST report the problem `root_gone` with a count of 1.

**Tests:** `device/folder-health.test.ts › counts one root_gone when another directory has taken the folder's place`, `› counts one root_gone when another directory has taken the folder's place as a pull writes`.

### `folder-sync/report-settings-invalid`

While a device cannot use or cannot write a folder's settings file and the folder's first sync is not waiting, a device MUST report `settings_invalid` with a count of 1.

**Tests:** `device/folder-health.test.ts › counts one settings_invalid while the settings file is refused`, `› counts one settings_invalid while a pull cannot write the settings file, and none once it can`, `› counts no settings_invalid for a refused settings file while the first sync waits`.

### `folder-sync/report-full-success`

When a confirmed folder sync completes with a complete readable inventory and without pending uploads, pending downloads, paused removals, first-sync waiting, or current problems, a device MUST report its completion time in `last_success_at`.

**Tests:** `device/folder-health.test.ts › reports a confirmed complete sync using the registry's opaque copy identity`.

### `folder-sync/report-unreadable-inventory`

When a folder scan cannot read a directory, a device MUST include that directory in its `unreadable` problem count independently of whether any file beneath it is bound.

**Tests:** `device/folder-health.test.ts › reports an unreadable unbound directory as incomplete inventory and clears it after readable recovery`.

### `folder-sync/report-incomplete-counts`

While a folder inventory is incomplete, a device MUST preserve its previously observed pending-upload count unless newly observed pending work increases it.

**Reason:** a readable scan is needed to recompute the count, because hidden files may have changed.

**Tests:** `device/folder-health.test.ts › preserves a nonzero known upload count while an unreadable inventory hides unbound files`.

### `folder-sync/report-dead-work`

While a bound file has unresolved effects from a dead queued write, a device MUST include that file in its pending-upload count.

**Reason:** the queue's retry ceiling does not make the held content synchronized; superseded effects follow `queue-and-verdicts/dead-covered-effects`.

**Tests:** `device/folder-health.test.ts › keeps dead file effects current until an accepted replacement, survives clear and restart, and restores them on release`.

### `folder-sync/report-first-waiting`

While a folder's first sync awaits confirmation, a device MUST report `first_sync_waiting: true`.

**Tests:** `device/folder-health.test.ts › reports first-sync waiting without claiming a successful content pass`.

### `folder-sync/report-success-none`

While no fully successful folder sync has completed, a device MUST report `last_success_at: null`.

**Tests:** `device/folder-health.test.ts › reports first-sync waiting without claiming a successful content pass`.

### `folder-sync/report-send-only`

When `folders push --send-only` finishes, a device MUST NOT advance `last_success_at`.

**Reason:** a run that caught up with nothing and pulled nothing is not a complete sync.

**Tests:** `device/folder-health.test.ts › does not report a send-only run as a full success, where a push that pulls does`.

### `folder-sync/report-independent`

If delivery of a folder-health report fails, then a device MUST preserve the successful outcome of the content sync independently of that failure.

**Tests:** `device/folder-health.test.ts › preserves successful content sync when reporting fails and coalesces across CLI restarts`, `device/contract.test.ts › rejects a health receipt on another contract without stopping content or learning its sequence floor`.

### `folder-sync/report-coalesces`

When a device produces newer folder-health observations while reporting is unavailable, a device MUST retain its latest unsent observations across process restarts for a later reporting attempt.

**Tests:** `device/folder-health.test.ts › preserves successful content sync when reporting fails and coalesces across CLI restarts`.

### `folder-sync/report-sequence`

When a device produces a newer report for the same folder copy and sign-in, a device MUST send a sequence greater than the previous report's sequence.

**Tests:** `device/folder-health.test.ts › preserves successful content sync when reporting fails and coalesces across CLI restarts`.

### `folder-sync/report-distinct-copies`

When two local directories follow the same folder under the same sign-in, a device MUST report them under distinct existing folder-store identities.

**Tests:** `device/folder-health.test.ts › distinguishes two directories following the same folder and sign-in`.

### `folder-sync/report-offline-success`

When a folder content pass cannot contact the server, a device MUST preserve its last fully successful sync time independently of whether the local write queue is empty.

**Tests:** `device/folder-health.test.ts › does not advance last full success after an offline push with an empty queue`.

### `folder-sync/report-sequence-recovery`

When a folder-health receipt reports a stored sequence at least as high as the device's rejected report, a device MUST publish its newest local observations under a greater sequence.

**Reason:** a restored local backup can be behind the report already held by the server.

**Tests:** `device/folder-health.test.ts › refreshes the newest local observation above a restored backup sequence`.

### `folder-sync/health-hydrating`

While a folder's copy hydrates, a device MUST NOT report `settings_invalid` or `unavailable` for the folder because the copy answers `hydration_incomplete`.

**Reason:** a copy that is still filling has not yet said anything about the folder's settings or the server, and a person or an app reading the report would be told something is wrong when nothing is. Settings that cannot be read still report, and so does a hydration whose latest attempt failed because the server could not be reached or answered a timeout, a rate limit or a `5xx`: the folder reports `unavailable` while that attempt's failure stands, and nothing once a retry is under way and filling. A full disk or a local read or write that fails is not `unavailable`.

**Tests:** `device/folder-watch-record.test.ts › shows no problem for a folder whose first hydration is under way`, `› shows the folder unavailable while its first hydration keeps failing`.
