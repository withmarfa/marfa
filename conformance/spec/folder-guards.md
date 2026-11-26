# What a folder holds back

A folder is a `system.folder` item on the instance, with its settings, query and ID. A directory is a place on a machine's disk that follows a folder, with a working copy and a queue. A statement about what a device does on disk says directory; one about what the instance holds says folder. The device and queue rules also apply (`device.md`, `queue-and-verdicts.md`).

This chapter holds what a folder holds back until a person confirms: removals and additions, over-limit files, files outside the query, and what status reports about them.

## Removing unmatched files

An unmatched file is one a folder keeps because its item left the query for a reason other than its state or purge (`folder-files/unmatched-file-kept`), or because the item was made from it outside the query's states (`folder-files/new-file-outside-state-kept`).

### `folder-guards/unmatched-list`

When `folders unmatched` is run, the CLI MUST list each unmatched file with its path and its item's ID.

**Tests:** `device/folders-unmatched.test.ts › lists them, and says which removing would keep`.

### `folder-guards/unmatched-list-kept`

When `folders unmatched` lists an unmatched file that removal would keep, the CLI MUST state in `kept` why removal would keep it.

**Tests:** `device/folders-unmatched.test.ts › lists them, and says which removing would keep`, `device/folders-unmatched.test.ts › keeps a file as the folder wrote it while a write to its item waits to be sent, and removes it once sent`.

### `folder-guards/unmatched-list-beside-watch`

While another process watches a folder, the CLI MUST answer `folders unmatched` without `--remove` without acquiring the folder's working handle.

**Reason:** like `folders status`, listing reads the store and changes nothing.

**Tests:** `device/folders-unmatched.test.ts › lists beside a running watch, which holds the folder`.

### `folder-guards/unmatched-remove-terminal-question`

When `folders unmatched --remove` is run at a terminal without `--yes` or `--json`, the CLI MUST ask for confirmation before it removes a file.

**Tests:** `device/folders-unmatched.test.ts › asks at a terminal before removing, and obeys %s`.

### `folder-guards/unmatched-remove-terminal-answer`

When `folders unmatched --remove` asks for confirmation at a terminal, the CLI MUST remove files only for the answer `y` or `yes` without regard to case.

**Tests:** `device/folders-unmatched.test.ts › asks at a terminal before removing, and obeys %s`.

### `folder-guards/unmatched-remove-yes`

When `folders unmatched --remove` is given `--yes`, the CLI MUST remove the files it may without asking for input.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › refuses to remove anything without a terminal and without --yes`.

### `folder-guards/unmatched-remove-no-terminal`

If `folders unmatched --remove` is run with neither a terminal nor `--yes`, then the CLI MUST refuse with `usage`.

**Reason:** a script that has not said `--yes` has not agreed.

**Tests:** `device/folders-unmatched.test.ts › refuses to remove anything without a terminal and without --yes`.

### `folder-guards/unmatched-remove-no-terminal-kept`

If `folders unmatched --remove` is refused for lack of a terminal and `--yes`, then a device MUST NOT remove a file or queue the end of a placement.

**Tests:** `device/folders-unmatched.test.ts › refuses to remove anything without a terminal and without --yes`.

### `folder-guards/unmatched-remove-file`

When removal of an unmatched file is confirmed and the file may be removed, a device MUST delete the file from the directory.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › asks at a terminal before removing, and obeys %s`, `device/folders-unmatched.test.ts › removes through a binding the unmatched files it may, and keeps the rest and says why`.

### `folder-guards/unmatched-remove-placement`

When removal of an unmatched file is confirmed and the file is removed, a device MUST queue the deletion of the folder's `in-folder` edge for the file's item.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › removes through a binding the unmatched files it may, and keeps the rest and says why`.

### `folder-guards/unmatched-remove-item-unchanged`

When removal of an unmatched file is confirmed and the file is removed, a device MUST NOT queue a write to the file's item.

**Reason:** removing the file ends the folder's placement of the item and nothing else; the item stays in Marfa as it was.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`.

### `folder-guards/unmatched-remove-edited-kept`

When an unmatched file holds bytes other than those the device last wrote, a device MUST keep the file when asked to remove unmatched files.

**Reason:** the bytes are the person's.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › goes on with the rest where a file was deleted or changed by hand while it asked`, `device/folders-unmatched.test.ts › keeps a file saved just as its removal reached it, and the next push places it again`, `device/folders-unmatched.test.ts › removes through a binding the unmatched files it may, and keeps the rest and says why`.

### `folder-guards/unmatched-remove-waiting-kept`

While the item of an unmatched file has a write waiting to be sent, a device MUST keep the file when asked to remove unmatched files.

**Reason:** removing the file would end its placement while an edit of it is still on its way.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › keeps a file as the folder wrote it while a write to its item waits to be sent, and removes it once sent`.

### `folder-guards/unmatched-remove-kept-reported`

When an unmatched file named for removal is kept, a device MUST report the file with its reason in `kept`.

**Tests:** `device/folders-unmatched.test.ts › removes the files it may with --yes, ends their placements, and keeps the rest and says why`, `device/folders-unmatched.test.ts › goes on with the rest where a file was deleted or changed by hand while it asked`, `device/folders-unmatched.test.ts › keeps a file saved just as its removal reached it, and the next push places it again`, `device/folders-unmatched.test.ts › removes through a binding the unmatched files it may, and keeps the rest and says why`.

### `folder-guards/unmatched-remove-stopped`

If removal of an unmatched file stops or fails before it ends, as when the process is killed or the file system refuses a step, then a device MUST NOT queue the deletion of the file's item.

**Reason:** a removal that stops or fails after the file left the directory leaves the store binding a file that is gone, which a scan would otherwise read as the person deleting it. A device that finds such a file gone from the directory it removed the file from at its next scan ends the binding instead, and one that finds it still there as it was keeps the binding. A person's delete in that gap reads the same way, so the item is kept, which loses nothing.

**Tests:** `device/folders-unmatched.test.ts › never deletes the item of a file whose removal stopped at %s, as it does one deleted by hand`, `› never deletes the item of a file whose removal failed after the file left its path, as it does one deleted by hand`.

### `folder-guards/unmatched-remove-stopped-held`

If a device cannot tell at a scan whether the file of a stopped removal is still at its path, as when a directory on the path is a symbolic link, another file is there, or the directory at the path is not shown to be the one the removal recorded, then a device MUST report the file as `held` in `folders status`, with the reason.

**Tests:** `device/folders-unmatched.test.ts › holds the binding of a file whose removal stopped where another file took its path, and never deletes its item`, `› holds the binding of a file whose removal stopped while another directory has its directory's name, and keeps it once the directory is back`, `› lists a file held for a stopped removal with why, and never takes it away`.

### `folder-guards/unmatched-remove-stopped-unsent`

While a device cannot tell whether the file of a stopped removal is still at its path, a device MUST NOT send what is at the path or queue the deletion of the file's item.

**Reason:** the file may still exist where the device cannot see it, so sending what is at the path or deleting the item could lose it.

**Tests:** `device/folders-unmatched.test.ts › holds the binding of a file whose removal stopped where another file took its path, and never deletes its item`.

### `folder-guards/unmatched-remove-replaced-held`

If another file takes the path of an unmatched file while a device removes it, as when an editor saves by writing a new file and renaming it over the old one, then a device MUST keep the file's binding until no file is at its path.

**Reason:** the file at the path is not the one the removal checked, so ending the binding would let a later delete of that file read as a delete of the item. A device decides on the file's device, inode and birth time, read through the directory it opened for the removal, in the step that would end the binding.

**Tests:** `device/folders-unmatched.test.ts › keeps the binding of a file an editor replaced as its removal went, and never deletes its item once it is gone`.

### `folder-guards/unmatched-remove-replaced-status`

If another file takes the path of an unmatched file while a device removes it, then a device MUST report the file as `held` in `folders status` until no file is at its path.

**Tests:** `device/folders-unmatched.test.ts › keeps the binding of a file an editor replaced as its removal went, and never deletes its item once it is gone`, `› never removes a file put at the path after its removal was recorded, and holds it`.

### `folder-guards/unmatched-remove-replaced-kept`

If another file takes the path of an unmatched file after a device records the file's removal and before the file leaves its path, then a device MUST NOT remove the file that took the path.

**Reason:** the device judges the file it removes by its device, inode and birth time, read from the descriptor it holds open until the file is gone, so a file with the same bytes under another identity is never taken for the one recorded.

**Tests:** `device/folders-unmatched.test.ts › never removes a file put at the path after its removal was recorded, and holds it`.

### `folder-guards/unmatched-remove-stopped-identity`

When a device decides whether the file at the path of a stopped removal is the file it removed, a device MUST take the file as another file unless its device, inode and, where both the record and the file system have one, birth time match the record.

**Reason:** a file system reuses an inode once its file is gone, so a new file can carry the inode the record names. A file on another device is another file, even where the volume was only mounted again. Where either side has no birth time, a match on device and inode alone never ends the removal: it holds the file as `folder-guards/unmatched-remove-stopped-held` says.

**Tests:** `device/folders-unmatched.test.ts › judges the file at a stopped removal's path by its birth time too, which is %s`, `› holds the binding of a file whose removal stopped where another file took its path, and never deletes its item`.

### `folder-guards/unmatched-remove-stopped-directory`

If a device cannot show that the directory at the path of a stopped removal's file is the directory the removal recorded, by its device, inode and birth time, then a device MUST keep the file's binding.

**Reason:** the file may be in a directory that moved, so an empty path in the directory at its name says nothing about it. A directory that was moved aside, replaced by another, or has no birth time to compare is not shown to be the one recorded. Where the record does not read, only the directory itself, which holds the store the record is in, is shown to be the one the removal ran in.

**Tests:** `device/folders-unmatched.test.ts › holds the binding of a file whose removal stopped while another directory has its directory's name, and keeps it once the directory is back`.

### `folder-guards/unmatched-remove-stopped-before-read`

If a scan reads the path of a stopped removal before a device settles the removal's record, then a device MUST NOT queue a write of the file's item from what that read found.

**Reason:** a scan that read another file at the path before recovery decided on it could send what it read as an edit of the item once the file the removal took was back.

**Tests:** `device/folders-unmatched.test.ts › sends nothing a scan read at the path of a stopped removal once the file it removed is back`.

### `folder-guards/unmatched-remove-stopped-listed`

While a device holds the binding of a file for a stopped removal, a device MUST list the file in `folders unmatched` with the reason it holds it.

**Reason:** the person needs to see each file a stopped removal holds and what settles it.

**Tests:** `device/folders-unmatched.test.ts › lists a file held for a stopped removal with why, and never takes it away`, `› holds the binding of a file whose removal stopped while another directory has its directory's name, and keeps it once the directory is back`, `› lists a stopped removal whose record it cannot read once its file is gone, and ends it with --remove, keeping the item`.

### `folder-guards/unmatched-remove-stopped-never-taken`

When the owner confirms `folders unmatched --remove`, or an app removes unmatched files through a binding, a device MUST NOT take away a file whose binding it holds for a stopped removal.

**Reason:** only the removal's own record settles such a file, so another removal never decides on whatever file is at the path now.

**Tests:** `device/folders-unmatched.test.ts › lists a file held for a stopped removal with why, and never takes it away`.

### `folder-guards/unmatched-remove-stopped-unread-ended`

When the owner confirms `folders unmatched --remove`, or an app removes unmatched files through a binding, for a file whose stopped removal's record a device cannot read, where the file's path is directly in the directory and no file is at it, a device MUST end the file's binding.

**Reason:** no scan can end such a record, because it names no item to check the binding against. The directory itself holds the store the record is in, so it is the one the removal ran in, and an empty path there shows the file is gone. The device reports the file in `settled`.

**Tests:** `device/folders-unmatched.test.ts › lists a stopped removal whose record it cannot read once its file is gone, and ends it with --remove, keeping the item`.

### `folder-guards/unmatched-remove-stopped-unread-item`

When a device ends the binding of a file whose stopped removal's record it cannot read, a device MUST NOT queue a write to the file's item.

**Tests:** `device/folders-unmatched.test.ts › lists a stopped removal whose record it cannot read once its file is gone, and ends it with --remove, keeping the item`.

### `folder-guards/unmatched-remove-gone-kept`

If an unmatched file is missing from the directory when its removal is reached, then a device MUST report the file in `kept`.

**Reason:** a missing file is the scan's to settle (`folder-files/unmatched-missing-not-rewritten`).

**Tests:** `device/folders-unmatched.test.ts › goes on with the rest where a file was deleted or changed by hand while it asked`.

### `folder-guards/unmatched-remove-gone-continues`

If an unmatched file is missing from the directory or has changed when its removal is reached, then a device MUST go on to remove the other files named.

**Tests:** `device/folders-unmatched.test.ts › goes on with the rest where a file was deleted or changed by hand while it asked`.

## Paused removals, size and status

### `folder-guards/removal-threshold`

When a folder assesses a large removal, a device MUST pause it only when its file count exceeds both `removal_threshold.files` and `removal_threshold.fraction` of bound files, defaulting to 10 and 0.25, or exceeds `removal_threshold.ceiling`, defaulting to 100.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders.test.ts › follows the settings' removal threshold`, `device/folders-contract-b.test.ts › pauses only past both default removal thresholds ($missing of $total)`, `› pauses a pass that removes more than 100 files whatever their share, judging each pass alone`.

### `folder-guards/removal-ceiling`

When a folder assesses a large removal whose file count exceeds `removal_threshold.ceiling`, defaulting to 100, a device MUST pause it, whatever share of bound files it is.

**Reason:** in a large directory a quarter is hundreds of files, too many to lose without being asked.

**Tests:** `device/folders-contract-b.test.ts › pauses a pass that removes more than 100 files whatever their share, judging each pass alone`.

### `folder-guards/removal-judged-per-pass`

When a folder assesses a large removal, a device MUST judge only the files that pass removes, counting none whose deletions an earlier pass sent, whichever of `removal_threshold.files`, `removal_threshold.fraction` and `removal_threshold.ceiling` it judges them against.

**Reason:** a folder whose person removes a few files at a time is no folder losing many at once, so a guard that added passes together would pause every removal once enough had been sent.

**Tests:** `device/folders-contract-b.test.ts › pauses a pass that removes more than 100 files whatever their share, judging each pass alone`, `› pauses nothing where two passes each remove files under the default thresholds, though together they pass them`.

### `folder-guards/disk-removal-paused`

When files missing from a directory exceed the large-removal threshold, including files still inside the grace period, a device MUST count the missing files as `paused`.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders.test.ts › says a paused removal once while watching`.

### `folder-guards/disk-removal-paused-deletions-unsent`

When files missing from a directory exceed the large-removal threshold, including files still inside the grace period, a device MUST NOT send their deletions.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders.test.ts › says a paused removal once while watching`.

### `folder-guards/pull-removal-paused`

When owned files in a directory eligible for removal after their items depart exceed the large-removal threshold, a device MUST retain those files.

**Tests:** `device/folders.test.ts › pauses a large removal from another device`, `device/folders-contract-b.test.ts › confirms a paused pull removal of %s items`, `device/folders-frontmatter.test.ts › counts toward a large removal when it leaves with its document`.

### `folder-guards/pull-removal-paused-paused-count`

When owned files in a directory eligible for removal after their items depart exceed the large-removal threshold, a device MUST count those files as `paused`.

**Tests:** `device/folders.test.ts › pauses a large removal from another device`, `device/folders-contract-b.test.ts › confirms a paused pull removal of %s items`, `device/folders-frontmatter.test.ts › counts toward a large removal when it leaves with its document`.

### `folder-guards/confirm-moves-first`

When a paused disk removal is confirmed, a device MUST check other directories on the machine for each missing file.

**Tests:** `device/folders-one-mac.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folder-guards/confirm-moves-first-moved-count`

When a paused disk removal is confirmed, a device MUST count a file found moved as `moved`.

**Tests:** `device/folders-one-mac.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folder-guards/confirm-moves-first-item-preserved`

When a paused disk removal is confirmed, a device MUST NOT trash an item whose file was found moved.

**Tests:** `device/folders-one-mac.test.ts › looks for a paused removal's files in the other folders before confirming it`.

### `folder-guards/confirm-returned-file`

When a missing file returns before its paused removal is confirmed, a device MUST leave that file’s item undeleted.

**Tests:** `device/folders-contract-b.test.ts › does not confirm a paused deletion for a file put back since the pause`.

### `folder-guards/confirm-renamed-file`

When a missing file returns to its directory under another name before its paused removal is confirmed, a device MUST keep the file's item bound to the returned file.

**Reason:** a confirmation lets go only of what a fresh scan of the whole directory finds under no name, as an ordinary removal does, so a rename stays a rename and the item keeps its ID.

**Tests:** `device/folders-contract-b.test.ts › keeps the item of a paused removal's file that returned under another name`.

### `folder-guards/confirm-carried-file`

When a missing file returns to its folder before its paused removal is confirmed, under a name the folder holds for a clash with another file's name or does not send, and that is not the file's own name followed by a suffix, a device MUST leave the file's item undeleted.

**Reason:** a confirmation lets go only of what no file in the folder carries, so a returned file the scan does not read keeps its item, its history and its links.

**Tests:** `device/folders-contract-b.test.ts › keeps the item of a paused removal's file that returned under a name another file holds`, `› keeps the item of a paused removal's file that returned under a name the folder does not send`.

### `folder-guards/confirm-unread-folder`

If a paused disk removal is confirmed while part of the directory cannot be read, then a device MUST leave each missing file's item undeleted.

**Reason:** an unread directory can hold the file under any name.

**Tests:** `device/folders-contract-b.test.ts › keeps a paused removal unsure while part of the folder cannot be read`.

### `folder-guards/confirm-unread-folder-unsure-count`

If a paused disk removal is confirmed while part of the directory cannot be read, then a device MUST report each missing file in `unsure`.

**Tests:** `device/folders-contract-b.test.ts › keeps a paused removal unsure while part of the folder cannot be read`.

### `folder-guards/confirm-unread-path`

If a paused disk removal is confirmed while a missing file's path cannot be read, then a device MUST leave that file's item undeleted.

**Reason:** a path that cannot be checked is not proof that the file is gone.

**Tests:** `device/folders-contract-b.test.ts › keeps a paused removal unsure while a missing file's path cannot be read`.

### `folder-guards/confirm-unread-path-unsure-count`

If a paused disk removal is confirmed while a missing file's path cannot be read, then a device MUST report that file in `unsure`.

**Tests:** `device/folders-contract-b.test.ts › keeps a paused removal unsure while a missing file's path cannot be read`.

### `folder-guards/confirm-unread-path-held`

If a paused disk removal is confirmed while a missing file's path cannot be read, and the device has found the file missing for at least the rename grace, then a device MUST hold the file for the person (`folder-files/missing-file-held`).

**Reason:** the confirm is the person's answer to the pause, so no later scan asks again, and a file left neither deleted nor held would be lost from view. Before that, the removal stays paused instead (`folder-guards/confirm-in-grace`).

**Tests:** `device/folders-contract-b.test.ts › keeps a paused removal unsure while a missing file's path cannot be read`, `device/folders-one-mac.test.ts › keeps a confirmed removal held as unsure while the file's own directory cannot be read`.

### `folder-guards/confirm-unread-folder-paused`

If a paused disk removal is confirmed while part of the directory cannot be read and the missing file's path can be read, then a device MUST keep the removal of that file paused.

**Reason:** the unread part may hold the file under another name, so the confirm decides nothing, and the removal stays in view as one to confirm again once the directory can be read.

**Tests:** `device/folders-contract-b.test.ts › keeps a paused removal unsure while part of the folder cannot be read`, `device/folders-one-mac.test.ts › keeps a confirmed removal held as unsure while the file's own directory cannot be read`.

### `folder-guards/confirm-in-grace`

If a paused disk removal is confirmed before the device has found a missing file missing for the rename grace, then a device MUST keep that file's removal paused and report the file in `unsure`, whether or not the file's path can be read.

**Reason:** a confirm decides each file as the sweep past the grace would (`folder-files/delete-grace`), and inside the grace a move into another folder may not have been read there yet. A path that cannot be read gives no more reason to decide the file early. A pass that cannot read the path does not count toward the grace, because the file may have come back and gone again unseen (`folder-files/missing-file-held-unread-pass`), so a second confirm while the path still cannot be read keeps the removal paused too. A later confirm or scan decides it once the grace is over.

**Tests:** `device/folders-one-mac.test.ts › keeps a removal confirmed inside the rename grace paused, and lets it go once the grace is over`, `device/folders-one-mac.test.ts › keeps a confirmed removal paused inside the rename grace while the file's own directory cannot be read`.

### `folder-guards/confirm-uncertain-file`

When a paused disk removal is confirmed but an unavailable peer directory prevents ruling out a move, a device MUST leave the file’s item undeleted.

**Tests:** `device/folders-contract-b.test.ts › keeps confirmed missing files unsure while another registered folder is unavailable`.

### `folder-guards/confirm-uncertain-file-unsure-count`

When a paused disk removal is confirmed but an unavailable peer directory prevents ruling out a move, a device MUST report the file in `unsure`.

**Tests:** `device/folders-contract-b.test.ts › keeps confirmed missing files unsure while another registered folder is unavailable`.

### `folder-guards/confirm-deletes-queued`

When a paused disk removal is confirmed after reading the whole directory and a missing file's path, the file went missing at least the rename grace ago, it is found under no name in the directory or in any other directory on the machine, `folder-files/missing-file-changed-revives` does not restore the file, and `folder-files/missing-file-held` does not hold it, a device MUST queue deletion of the item for the next push.

**Tests:** `device/folders.test.ts › lets a paused removal go once confirmed, or puts it back`, `device/folders-one-mac.test.ts › keeps a removal confirmed inside the rename grace paused, and lets it go once the grace is over`.

### `folder-guards/confirm-pull-removes`

When a paused pull removal is confirmed and the files still contain their directory’s written bytes, a device MUST remove the departed files.

**Tests:** `device/folders-contract-b.test.ts › confirms a paused pull removal of %s items`.

### `folder-guards/confirm-pull-removes-removed-count`

When a paused pull removal is confirmed and the files still contain their directory’s written bytes, a device MUST count the departed files as `removed`.

**Tests:** `device/folders-contract-b.test.ts › confirms a paused pull removal of %s items`.

### `folder-guards/confirm-pull-refused-reported`

When a paused pull removal is confirmed and the volume refuses a departed file's safe removal, a device MUST report that file in `refused` with the reason.

**Tests:** `device/folders-contract-b.test.ts › reports a paused pull removal the volume refused, and keeps it paused`.

### `folder-guards/confirm-pull-refused-paused`

When a paused pull removal is confirmed and the volume refuses a departed file's safe removal, a device MUST keep that file's removal paused.

**Tests:** `device/folders-contract-b.test.ts › reports a paused pull removal the volume refused, and keeps it paused`.

### `folder-guards/restore-disk-files`

When a paused disk removal is restored and the missing files’ items still match the folder’s query, a device MUST write the missing files back from the held copy.

**Tests:** `device/folders.test.ts › lets a paused removal go once confirmed, or puts it back`.

### `folder-guards/restore-disk-attachments`

When a paused disk removal is restored and a missing file's item is outside the folder's query but a document the folder holds embeds it or has it attached, a device MUST write the missing file back from the held copy and count it as `put_back`, unless every such document is outside the query and its own file is among the missing files.

**Reason:** a pull writes such a file with its document, so restoring the document alone would leave the file for the next scan to trash. A document outside the query stays deleted, as `folder-guards/restore-unmatched-count` says, so its attachment goes with it rather than stay unmatched for good.

**Tests:** `device/folders-frontmatter.test.ts › is put back with its document when a paused removal is restored, %s`, `› is not put back when a paused removal is restored with an unmatched document that stays deleted`.

### `folder-guards/restore-disk-files-put-back-count`

When a paused disk removal is restored and the missing files’ items still match the folder’s query, a device MUST count as `put_back` each missing file the restore wrote back.

**Tests:** `device/folders.test.ts › lets a paused removal go once confirmed, or puts it back`, `› counts as put back only the files a restore wrote, and keeps the item of one it could not`.

### `folder-guards/restore-not-written-listed`

If a paused disk removal is restored and a missing file whose item still matches the folder’s query cannot be written back, such as one whose bytes cannot be fetched, then a device MUST list that file in `not_written_back` with the reason, rather than count it as `put_back`.

**Tests:** `device/folders.test.ts › counts as put back only the files a restore wrote, and keeps the item of one it could not`, `› does not count as put back a file somebody else's file stands in for`.

### `folder-guards/restore-written-by-binding`

When a device decides whether a restore wrote a missing file back, a device MUST count the file as written if and only if the pull bound the file's item to bytes it wrote, at the file's path or at the path the item moved to.

**Reason:** a file at the old path can be somebody else's, and a file the pull wrote where another device moved it is still the file put back.

**Tests:** `device/folders.test.ts › does not count as put back a file somebody else's file stands in for`, `device/folders-placement.test.ts › counts as put back a file a restore wrote where another Mac moved it while the removal waited`.

### `folder-guards/restore-not-written-flag`

When a device lists a file in `not_written_back`, a device MUST give it the flag and reason the pull flagged its item with, else those the pull flagged its path with while naming no item, or `unwritten` where the pull flagged neither.

**Tests:** `device/folders.test.ts › does not count as put back a file somebody else's file stands in for`.

### `folder-guards/restore-not-written-kept`

If a paused disk removal is restored and a missing file cannot be written back, then a device MUST NOT delete that file’s item at a later push.

**Reason:** the person asked for the files back, so a file still missing is one the device has not yet written, not one the person deleted.

**Tests:** `device/folders.test.ts › counts as put back only the files a restore wrote, and keeps the item of one it could not`.

### `folder-guards/restore-not-written-retried`

When a pull after a restore can fetch the bytes of a missing file the restore could not write back, a device MUST write that file.

**Tests:** `device/folders.test.ts › counts as put back only the files a restore wrote, and keeps the item of one it could not`.

### `folder-guards/restore-departed-binding`

When a paused disk removal is restored and a missing file’s item is absent or outside the query’s states, a device MUST release that file’s binding.

**Tests:** `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`.

### `folder-guards/restore-departed-binding-not-put-back`

When a paused disk removal is restored and a missing file’s item is absent or outside the query’s states, a device MUST NOT count that missing file as put back.

**Tests:** `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`.

### `folder-guards/restore-departed-binding-item-preserved`

When a paused disk removal is restored and a missing file’s item is absent or outside the query’s states, a device MUST NOT delete that missing file’s item.

**Tests:** `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`.

### `folder-guards/restore-unmatched-count`

When a paused disk removal is restored and a missing file’s item left the query for a non-state reason and no document the folder holds embeds it or has it attached, a device MUST leave the missing file for normal deletion handling.

**Tests:** `device/folders-contract-b.test.ts › does not count a missing unmatched file as put back when restoring a removal`.

### `folder-guards/restore-unmatched-count-not-put-back`

When a paused disk removal is restored and a missing file’s item left the query for a non-state reason and no document the folder holds embeds it or has it attached, a device MUST NOT count the missing file as put back.

**Tests:** `device/folders-contract-b.test.ts › does not count a missing unmatched file as put back when restoring a removal`.

### `folder-guards/restore-embedded-departure`

When restoring a disk removal releases an archived file’s old binding but a held document still embeds that file or has it attached, a device MUST write the file anew.

**Tests:** `device/folders-contract-b.test.ts › writes an archived %s file anew without counting it as put back`.

### `folder-guards/restore-embedded-not-put-back`

When restoring a disk removal releases an archived file’s old binding but a held document still embeds that file or has it attached, a device MUST NOT count the newly written file as put back.

**Tests:** `device/folders-contract-b.test.ts › writes an archived %s file anew without counting it as put back`.

### `folder-guards/restore-pull-items`

When a paused pull removal is restored, a device MUST queue the transition from the state it read to active for a trashed item or to a state the folder query holds for another departed item, provided the item still has the state the device read.

**Tests:** `device/folders-contract-b.test.ts › restores a paused pull removal of %s items into a held state`, `› keeps the server's newer state when a queued folder restore reaches it after an archive`.

### `folder-guards/pause-said`

When a folder push reports a paused disk or pull removal, the CLI MUST state the paused count and name `folders confirm` and `folders restore` as the ways to resolve it.

**Tests:** `device/folders.test.ts › pauses a large removal made on disk`, `device/folders-contract-b.test.ts › says a pull-side removal waits in push output with both ways to resolve it`.

### `folder-guards/pause-watch-once`

While a paused folder removal remains unchanged, the CLI MUST say its watch notice only once.

**Tests:** `device/folders.test.ts › says a paused removal once while watching`.

### `folder-guards/size-warning`

When a folder scan admits a new or edited document whose JSON-encoded text reaches nine tenths of the server's limit, or 943718 bytes where the root has named none, a device MUST include a `size` warning naming that path and size.

**Tests:** `device/folders.test.ts › warns of a text near the limit`, `device/folders-contract-b.test.ts › warns at the exact JSON-encoded size boundary including escaped text`, `device/pages.test.ts › warns of a text near a limit the root names, not the default`.

### `folder-guards/size-warning-said`

When a folder push scans a document with a size warning, the CLI MUST say the path and warning in words.

**Tests:** `device/folders.test.ts › warns of a text near the limit`.

### `folder-guards/refused-create-said`

While a file is held under `folder-files/lost-item-unchanged-held` and the queue keeps the server's refusal of its create, a device MUST name that refusal in the reason `folders status` gives.

**Reason:** "bound to an item this copy no longer holds" does not tell a person that the server refused the file, or why.

**Tests:** `device/folders-contract-b.test.ts › preserves a document after a request-too-large %s refusal`.

### `folder-guards/over-limit-held`

If a file's write is larger than the server's limit (`queue-and-verdicts/request-over-limit-unsent`), then a device MUST report the file as `refused`, with a reason naming the size of its request and the limit.

**Tests:** `cli/request-size.test.ts › holds a file past the limit, sends none of it and delivers what is beside it`.

### `folder-guards/over-limit-said`

When a folder push holds a file under `folder-guards/over-limit-held`, the CLI MUST say the path and the reason in words.

**Tests:** `cli/request-size.test.ts › holds a file past the limit, sends none of it and delivers what is beside it`.

### `folder-guards/over-limit-shrunk`

When a file held under `folder-guards/over-limit-held` changes to fit the server's limit, a device MUST send it.

**Tests:** `cli/request-size.test.ts › sends a held file once it fits, whether it was a create or an edit`.

### `folder-guards/over-limit-edit-keeps-others`

When a device sends an edit of a file once held under `folder-guards/over-limit-held`, a device MUST send it on the version the file was read at.

**Reason:** the server then merges it, as any stale edit, so a change made elsewhere while the file was held is not overwritten.

**Tests:** `cli/request-size.test.ts › keeps an edit made elsewhere while an edit of the file was held`.

### `folder-guards/over-limit-root-read`

While a folder holds a file under `folder-guards/over-limit-held`, a device MUST read the root before each scan.

**Reason:** a held file leaves nothing to send, and a drain with nothing to send reads the root at most once (`queue-and-verdicts/request-limit-refused-read`), so without this read a raised limit would go unseen.

**Tests:** `cli/request-size.test.ts › lets a held file go once the server takes it, with no edit`.

### `folder-guards/over-limit-raised`

When the server's limit rises to fit a file held under `folder-guards/over-limit-held`, a device MUST send the file with no change to it.

**Tests:** `cli/request-size.test.ts › lets a held file go once the server takes it, with no edit`.

### `folder-guards/over-limit-later-save`

When the server answers a later save of a file held under `folder-guards/over-limit-held`, a device MUST NOT report the file as held for its size.

**Reason:** the later save carries the whole file, so the bytes the hold was for are no longer the file's. An answer to an earlier save says nothing of the bytes the file holds now, and the hold stands.

**Tests:** `device/pages.test.ts › ends a hold for size once a later save of the file is answered`, `› keeps a hold for size where an earlier save is what was answered`.

### `folder-guards/request-too-large-bytes-kept`

When the server refuses a folder document create or edit with `413 request_too_large`, a device MUST retain the document’s bytes.

**Tests:** `device/folders-contract-b.test.ts › preserves a document after a request-too-large %s refusal`.

### `folder-guards/request-too-large-edit-held`

When the server refuses a folder document edit with `413 request_too_large`, a device MUST report its file as held with the refusal.

**Tests:** `device/folders-contract-b.test.ts › preserves a document after a request-too-large %s refusal`.

### `folder-guards/request-too-large-create-lost`

When the server refuses a folder document create with `413 request_too_large` and the copy forgets the item, a device MUST hold its file under `folder-files/lost-item-unchanged-held` until the person changes or moves it.

**Tests:** `device/folders-contract-b.test.ts › preserves a document after a request-too-large %s refusal`.

### `folder-guards/size-status-warning`

When a folder status reads a document that would have the warning `folder-guards/size-warning` names, a device MUST include its size warning in the file’s status.

**Tests:** `device/folders.test.ts › warns of a text near the limit`.

### `folder-guards/status-local`

When the CLI reads a folder’s status, the CLI MUST answer from the directory’s disk and local store without contacting the server.

**Tests:** `device/folders-contract-b.test.ts › reads status from disk and the held copy without contacting the server`.

### `folder-guards/status-files`

When a device reads a folder’s status, a device MUST report each reached file and each bound file with its path, bound item ID when present, status and applicable waits or refusal reason.

**Tests:** `device/folders.test.ts › reports each file's status`.

### `folder-guards/status-unreadable-document`

When a new folder document’s frontmatter cannot be parsed or names a refused own field, a device MUST report its status as `held` with flag `unreadable` before binding it.

**Tests:** `device/folders.test.ts › reports each file's status`.

### `folder-guards/status-refused-document`

When the folder's scan holds a new document because the type it names is no type a document can be, or because the copy would refuse it as a new item, a device MUST report the document's status as `held` with flag `refused` and the reason, before binding it.

**Reason:** a status of `waiting` says the file will be sent, and a document the scan holds is not sent until the person changes it.

**Tests:** `device/folders.test.ts › reports each file's status`.

### `folder-guards/status-encoding`

When a new folder document is not UTF-8, a device MUST report its status as `held` with flag `encoding`.

**Tests:** `device/folders-identity.test.ts › holds a document that is not UTF-8, and never sends or rewrites it`.

### `folder-guards/status-file-item-doc-name`

When a device reads a folder's status and a file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) is the file of a file item and names no note's item ID, a device MUST NOT report it as `held` for what its bytes hold.

**Reason:** the status says what the next scan does, and the scan sends a file item's bytes whatever they hold (`folder-documents/file-item-doc-name-sent`). The file is the file item's when it is bound to one, or when the scan would bind it to one by its file identity, before any scan has followed a rename. A new document that is not UTF-8 is still reported by `folder-guards/status-encoding`. A file that names a note's item ID is read as that note's file, because the status does not settle which of two files wins a note; the scan does.

**Tests:** `device/folders-placement.test.ts › reports a file item at a document name by its item, not by its bytes`.

### `folder-guards/status-file-item-doc-name-size`

When a device reads a folder's status and a file at a document name (`.md`, `.markdown` or `.txt`, in any letter case) is the file of a file item, a device MUST NOT report a size warning for it.

**Reason:** a file item's bytes go up outside the request whose size the warning measures.

**Tests:** `device/folders-placement.test.ts › reports a file item at a document name by its item, not by its bytes`.

### `folder-guards/status-outside`

When a non-document file has no type held by the folder query, a device MUST report its status as `outside`.

**Reason:** this `outside` names a file the folder does not take. It is not the pull report's `outside` count, which `folder-documents/pull-outside-lists` and `folder-files/placement-outside` say is an item whose path the folder does not write to.

**Tests:** `device/folders-contract-b.test.ts › reads status from disk and the held copy without contacting the server`.

### `folder-guards/status-paused-counts`

When a device reads a folder’s status, a device MUST report paused disk and pull removals separately.

**Tests:** `device/folders.test.ts › pauses a large removal from another device`, `device/folders-contract-b.test.ts › pauses only past both default removal thresholds ($missing of $total)`.

### `folder-guards/status-unreached`

When the folder’s lists exclude a bound file, a device MUST report its status as `unreached`.

**Tests:** `device/folders-contract-b.test.ts › reports a bound file as unreached when settings exclude it`.

### `folder-guards/status-paused-purged`

When a purged folder item’s file is retained by the large-removal pause, a device MUST report its status with the `removal` flag and a reason identifying the purge as irreversible.

**Tests:** `device/folders-contract-b.test.ts › reports purged paused files without promising that restore can recover their items`.

### `folder-guards/status-catalog-consistent`

When item and edge catalogs refresh during a folder status read, a device MUST use one consistent catalog revision for that status.

**Tests:** `device/binding-folders-placement.test.ts › uses the item and edge catalogs from one revision while a refresh commits between their reads`.

### `folder-guards/status-lists-flagged-files`

When the CLI answers `folders status` in plain text, the CLI MUST list each file that carries a flag, a reason or a warning, whatever its status, with that reason or warning.

**Reason:** a file whose default edge was refused stays in step and carries the refusal only as a flag and reason, so a list of the files that are not in step hid what the JSON reported. The count of files in step is the count by status, and a listed file in step is still counted in it.

**Tests:** `device/folders-default-refused.test.ts › lists a refused default in the plain text of the folder's status, which stays in step`.

## Paused additions

### `folder-guards/addition-threshold`

When a scan finds new files that would create items, a device MUST pause them only when their count exceeds both `addition_threshold.files` and `addition_threshold.fraction` of the directory's bound files, defaulting to 50 and 0.25.

**Reason:** A person who drops a handful of files into a directory means to; one who drops thousands may have chosen the wrong directory.

**Tests:** `device/folders-additions.test.ts › is held past both default halves of the threshold and sent at them`.

### `folder-guards/addition-threshold-empty-folder`

Where a folder holds no bound files after its first sync, a device MUST judge a drop of new files by its count alone against `addition_threshold.files`.

**Tests:** `device/folders-additions.test.ts › is judged by its count alone in a folder that holds no files`.

### `folder-guards/addition-counts`

A device MUST count towards `addition_threshold` only the new files a scan would send as new items.

**Tests:** `device/folders-additions.test.ts › does not count the edits and renames of bound files`.

### `folder-guards/addition-counts-edits`

A device MUST NOT count the edits and renames of bound files towards `addition_threshold`.

**Tests:** `device/folders-additions.test.ts › does not count the edits and renames of bound files`.

### `folder-guards/addition-run`

When new files arrive across scans, a device MUST count the new files it sent in the last ten minutes together with those the scan finds, so that a drop copied in slowly is held once it passes the threshold.

**Reason:** A scan that counted only its own files would let a slow copy through in small pieces; a count of every file since the folder was last quiet would hold a person who saves a note every few minutes.

**Tests:** `device/folders-additions.test.ts › is counted across pushes when it arrives a few files at a time`, `device/binding-folders-additions.test.ts › holds a large copy that arrives in two bursts with an edit's scan between`.

### `folder-guards/addition-run-ends`

A device MUST NOT count a new file it sent more than ten minutes before the scan, or in a minute after the scan's own, which a clock set back leaves behind.

**Tests:** `device/binding-folders-additions.test.ts › never holds a note saved every four minutes, however many there are`, `device/binding-folders-additions.test.ts › sends the same two bursts when they are more than ten minutes apart`.

### `folder-guards/first-sync-not-counted`

A device MUST NOT count the files of a folder's first sync towards `addition_threshold`; the first sync waits for confirmation by `folder-setup/first-sync-waits`.

**Tests:** `device/folders-additions.test.ts › is not counted in the first sync, whatever its size`.

### `folder-guards/addition-paused`

When new files exceed the addition threshold, a device MUST NOT send them.

**Tests:** `device/folders-additions.test.ts › is held, named apart from a removal in status, and its files stay on the disk`.

### `folder-guards/addition-paused-kept`

While new files are paused, a device MUST leave them on the disk.

**Tests:** `device/folders-additions.test.ts › is held, named apart from a removal in status, and its files stay on the disk`.

### `folder-guards/addition-paused-report`

While new files are paused, a device MUST count them as `paused_additions` in the scan report.

**Tests:** `device/folders-additions.test.ts › is held, named apart from a removal in status, and its files stay on the disk`.

### `folder-guards/addition-paused-status`

While new files are paused, a device MUST report each as a `held` file with the `addition` flag.

**Tests:** `device/folders-additions.test.ts › is held, named apart from a removal in status, and its files stay on the disk`.

### `folder-guards/addition-paused-status-count`

While new files are paused, a device MUST report their count as `paused.additions`.

**Tests:** `device/folders-additions.test.ts › is held, named apart from a removal in status, and its files stay on the disk`.

### `folder-guards/addition-paused-text`

While new files are paused, a device MUST say so in its text, apart from a paused removal.

**Tests:** `device/folders-additions.test.ts › is held, named apart from a removal in status, and its files stay on the disk`.

### `folder-guards/addition-paused-edits-go`

While new files are paused, a device MUST go on sending the edits of files it already holds.

**Tests:** `device/folders-additions.test.ts › does not hold the edit of a bound file made in the same scan`.

### `folder-guards/addition-confirm`

When a person confirms a folder with paused additions, a device MUST queue the paused files as new items and send them with the next push.

**Tests:** `device/folders-additions.test.ts › is sent once confirmed, and not held again`.

### `folder-guards/addition-confirm-count`

When a person confirms a folder with paused additions, a device MUST report as `added` the number of paused files the confirmation released.

**Reason:** A watch can take the release before the confirming command's own scan does, so the count is of the files released and not of the items that scan makes.

**Tests:** `device/folders-additions.test.ts › is sent once confirmed, and not held again`.

### `folder-guards/addition-confirm-later`

A device MUST count the new files that arrive after a confirmation against `addition_threshold` as it would any others.

**Tests:** `device/folders-additions.test.ts › is counted anew for the files that arrive after a confirm`.

### `folder-guards/addition-confirm-flag`

When a push is told to confirm additions, a device MUST send every new file the scan finds, however many.

**Reason:** A script that no one attends has no one to run `folders confirm`.

**Tests:** `device/folders-additions.test.ts › is sent by a push told to confirm additions`.

### `folder-guards/addition-pause-stands`

While new files are paused, a device MUST keep them paused until a person confirms them, deletes them, or raises `addition_threshold` so that the paused files, counted with the new files sent in the last ten minutes when the pause began, no longer exceed it.

**Reason:** A pause waits for the person. The window of sent files empties with time, so a pause judged afresh at each scan would release itself once ten minutes passed.

**Tests:** `device/binding-folders-additions.test.ts › keeps a paused burst held after the window empties, and sends it once confirmed`, `device/folders-additions.test.ts › is released when the threshold is raised past it`.

### `folder-guards/addition-pause-joins`

While new files are paused, a device MUST pause the new files that arrive, however few.

**Tests:** `device/binding-folders-additions.test.ts › keeps a paused burst held after the window empties, and sends it once confirmed`.

### `folder-guards/addition-clears`

When every file of a paused addition is deleted, a device MUST release the pause at the next scan, including one that finds a new file, without sending the deleted files.

**Reason:** The pause is the list of held files in the directory's store, so it survives a crash and needs no record that a person must clear.

**Tests:** `device/folders-additions.test.ts › is let go of when the files are deleted`.

### `folder-guards/addition-clears-raised`

When the threshold is raised so that the paused files, counted with the new files sent in the last ten minutes when the pause began, no longer exceed it, a device MUST release the pause at the next scan.

**Tests:** `device/folders-additions.test.ts › is released when the threshold is raised past it`.

### `folder-guards/addition-watch`

While new files are paused, a device MUST say so once in a watch over the folder.

**Tests:** `device/folders-additions.test.ts › says it once, keeps watching, keeps sending edits and never fails`.

### `folder-guards/addition-watch-goes-on`

While new files are paused, a device MUST go on sending edits in a watch over the folder.

**Tests:** `device/folders-additions.test.ts › says it once, keeps watching, keeps sending edits and never fails`, `device/folders-additions.test.ts › goes on with the other folders when one of the folders it watches pauses`.

## Holding new files outside the query

### `folder-guards/outside-query-default-send`

Where a folder's `outside_query` is absent or `send`, a device MUST send a new file whose item the folder's query would not hold, as it sends any other new file.

**Tests:** `device/folders-outside-query.test.ts › is sent, as it always was, unless the folder holds it`.

### `folder-guards/outside-query-held`

Where a folder's `outside_query` is `hold`, a device MUST NOT send a new file whose item the folder's query would not hold.

**Reason:** A new file has no item. A file bound to an item, or moved in from another directory on the machine, is not new, and `folder-files/unmatched-file-kept` governs it. The query is judged on the item the file would become: its type, tier, state, tags and `filter`, the properties its bytes give a file item, and `beneath`, by the edges the folder's `defaults.edges` would give the item and the edge lines the file's frontmatter writes, each name resolved as the create resolves it. A line whose name resolves to no item adds no edge.

**Tests:** `device/folders-outside-query.test.ts › is held unsent and unwritten, shown in status and listed as unmatched`.

### `folder-guards/outside-query-unwritten`

While a new file is held outside the query, a device MUST NOT write to it, including a `marfa_id` line.

**Tests:** `device/folders-outside-query.test.ts › is held unsent and unwritten, shown in status and listed as unmatched`.

### `folder-guards/outside-query-report`

While new files are held outside the query, a device MUST count them as `held_outside` in the scan report.

**Tests:** `device/folders-outside-query.test.ts › is held unsent and unwritten, shown in status and listed as unmatched`.

### `folder-guards/outside-query-status`

While a new file is held outside the query, a device MUST report it as a `held` file with the `outside_query` flag and no item, and count it as `paused.outside_query`.

**Reason:** The flag differs from `addition` and from a paused removal, so each shows what is waiting and why.

**Tests:** `device/folders-outside-query.test.ts › is held unsent and unwritten, shown in status and listed as unmatched`.

### `folder-guards/outside-query-text`

While new files are held outside the query, a device MUST say so in its text, apart from a paused addition.

**Tests:** `device/folders-outside-query.test.ts › is held unsent and unwritten, shown in status and listed as unmatched`.

### `folder-guards/outside-query-unmatched`

While a new file is held outside the query, a device MUST list it in the unmatched files with the reason it is held and no item.

**Tests:** `device/folders-outside-query.test.ts › is held unsent and unwritten, shown in status and listed as unmatched`.

### `folder-guards/outside-query-not-removed`

While a new file is held outside the query, the CLI MUST NOT delete it on `folders unmatched --remove`.

**Tests:** `device/folders-outside-query.test.ts › is held unsent and unwritten, shown in status and listed as unmatched`.

### `folder-guards/outside-query-matches`

When a file held outside the query is edited so that its item would be held by the query, a device MUST send it as a new item at the next scan.

**Tests:** `device/folders-outside-query.test.ts › is sent once its content matches the query`.

### `folder-guards/outside-query-setting-send`

When a folder's `outside_query` changes to `send`, a device MUST send the new files it held outside the query at the next scan.

**Tests:** `device/folders-outside-query.test.ts › is sent once the folder's setting goes back to send`.

### `folder-guards/outside-query-not-counted`

A device MUST NOT count a new file held outside the query towards `addition_threshold`.

**Tests:** `device/folders-outside-query.test.ts › is not counted towards the addition threshold`, `device/binding-folders-additions.test.ts › is held, shown in status and not counted towards the addition threshold`.

### `folder-guards/outside-query-binding`

Where a device is a binding, a device MUST report the held files as `heldOutside` in a scan and as `paused.outsideQuery` in a status.

**Tests:** `device/binding-folders-additions.test.ts › is held, shown in status and not counted towards the addition threshold`.
