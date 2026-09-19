# Folders

A folder is a device surface: a directory on a machine that holds a slice as files. It is a working copy and a queue like any other device (`device.md`, `queue-and-verdicts.md`) with a filesystem as its face, and every statement in those chapters holds here too.

## What a folder is

1. A folder is a view on a slice — a type list, tags or a filter — with defaults for what a new file becomes: its type, its tier and any properties the type requires that a file cannot carry. `device/folders.test.ts › is a view on a slice with defaults for a new file`.
2. A machine holds several folders, each a different slice, and they are independent: one folder's state, journal and queue are its own. `device/folders.test.ts › keeps each folder's state and queue to itself`.
3. A folder in a container is the same thing: hydrate, work in files, push, discard the container. Nothing about a folder depends on the directory outliving the work. `device/folders.test.ts › hydrates into an empty directory and pushes without holding anything else`.

## Files and items

4. A file in the folder is an item on the server and an item in the slice is a file in the folder. `device/folders.test.ts › makes a file an item and an item a file`.
5. Frontmatter becomes properties and the body is the body. A property the type does not declare travels as a property; nothing a file carries is dropped on the way in (`device.md` 23), and **the folder does not reorder a file's own fields**. What the server does with the order it is sent is the server's, and is not stated anywhere (`findings.md`); the rule here is that the folder adds no reordering of its own. `device/folders.test.ts › carries frontmatter to properties and the body to the body`, `› writes a person's frontmatter back in the order they wrote it`.
6. **Frontmatter is only what a file opens with and delimits as frontmatter.** A body that opens with a horizontal rule is a body. Reading it as frontmatter loses the first paragraph and then writes the loss back to the server, which is silent data loss in both directions. `device/folders.test.ts › treats a body opening with a horizontal rule as a body`.
7. Links in the body become edges, and the edges of an item appear as links. An edge the folder cannot express as a link is kept on the item rather than dropped. `device/folders.test.ts › carries links to edges and edges to links`.

## Identity

8. **Rename identity is fail-closed.** A file is the same file across a rename when its device, inode and birth time match; a zero birth time yields no identity, and an identity two files share yields none. **No identity means a new item, never a guess.** Identity is resolved over the files the folder holds, so a file it never touches cannot take one away. `device/folders.test.ts › follows a rename by device, inode and birth time`, `› treats a file with no usable identity as new rather than guessing`, `› resolves identity over the files it holds, not every file in the tree`.
9. **The initial scan and the live watcher use one identity rule.** The same bytes arriving while the folder is running and the same bytes present when it starts must reach the same item; two rules turn one file into two items depending on when it appeared. `device/folders.test.ts › binds the same file to the same item whether it was present at start or arrived while running`.
10. **Two devices enrolled separately share a natural key for the same file.** The same file in the same place on two machines is one item, whatever credential each machine holds. A key that differs per credential makes every file two items and neither machine can say why. The server stamps `source` from the credential and scopes the natural key by it (`items.md` 4, 5), so as the server stands this rule cannot be satisfied through `(source, source_id)` alone; `findings.md` 9 carries it. `device/folders.test.ts › binds one file to one item across two separately enrolled devices`.
11. A folder writes the item's id into the file as its own identity record. That record is the folder's, not the natural key: a file that has lost it, or never had it, is still the same item when the natural key matches, and a file carrying one that names an item the server does not hold is treated as having none. It is the folder's record and not the item's, so it is not sent: a copied file would otherwise carry the id of the item it was copied from onto a new one. `device/folders.test.ts › keeps the item id in the file as a record, and does not depend on it for identity`, `› keeps its own identity record out of what it sends the server`.12. A rename on the server moves the file in the folder, and the next scan does not re-assert the old name. `device/folders.test.ts › moves the file when the item is renamed on the server`.

## Writing

13. **A folder create carries the version it is based on**, where the general contract leaves a version optional on a create (`queue-and-verdicts.md` 2), and a folder create with no version is refused before it is sent. A folder create lands on an existing row whenever the natural key already names one, so a version-less one is an update that read nothing. A version-less create onto an existing row is an overwrite of whatever is there, which is how a second machine's stale copy replaces newer server content with nothing reporting it. `device/folders.test.ts › refuses a create that carries no version`, `› does not overwrite newer server content from a stale folder`.
14. **Echo suppression has no gap.** A write the folder made to its own files never comes back as a change. Every write the folder makes is either announced to the watcher before it happens or lands under a path the watcher does not watch. `device/folders.test.ts › does not read its own writes back as changes`.
15. Deletes are journaled and deferred: a file that disappears is recorded, and the delete is sent after the grace that separates a delete from the first half of a rename. `device/folders.test.ts › defers a delete past the rename grace`.
16. **A delete made while the folder was not running is recovered when it starts.** A tracked file that is absent at startup is journaled the same way one that vanished while watching is. `device/folders.test.ts › journals a delete that happened while it was not running`.

## What a folder does not watch

17. A dot-led directory is excluded, at any depth. `device/folders.test.ts › excludes a dot-led directory at any depth`.
18. `.marfa/` inside the folder is the folder's own state — its mapping, its journal, its queue — and is never watched and never pushed. `device/folders.test.ts › keeps its own state in .marfa and never pushes it`.
19. A file of a type outside the folder's slice is not pushed, and an item outside the slice does not become a file. `device/folders.test.ts › leaves a file outside the slice alone`.

## What a folder will not write

20. **A folder writes only inside itself.** Every component of the path is a plain name: no `..`, no separator leading out, and no symlink anywhere on the way. A path that fails this is reported and not written. A link pointing out of the folder loses the file, and one pointing back in is worse — the write lands on another item's file and truncates it — and the folder's own walk descends neither. `device/folders.test.ts › refuses to write a file outside the folder`.
21. **A link the file used to carry and no longer does takes its edge with it**, where that edge is the folder's own kind. An edge the folder has never written into the file is not a link anybody removed — it arrived from somewhere else and no pull has rendered it yet, and a scan always runs before a pull — so it stays. So does an edge of a kind the folder could not have made. And a body carrying a link that resolves to nothing stands the whole removal down, because a link that names nothing and a link that has gone are the same absence. `device/folders.test.ts › takes the edge with a link the body no longer names`, `› keeps an edge the file never carried, whoever made it`, `› keeps an edge of a kind it could not have made`.
22. **A pull does not write over a file the folder did not write.** `folders pull` runs no scan of its own, so a file that appeared since the last one is a file nothing has queued: writing an item over it loses what is there with no queue row and no line in the report. It is reported and left alone, and the next scan pushes it. `device/folders.test.ts › does not write over a file it never wrote`.

## What the real server cannot be made to produce

The list and the reason for each entry are in `device.md`; `device/fidelity.test.ts` checks every answer the real server can produce against the scripted server's.
