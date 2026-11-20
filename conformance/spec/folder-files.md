# Files on disk

A folder is a directory bound to a `system.folder` item, with a working copy and a queue. The device and queue rules also apply (`device.md`, `queue-and-verdicts.md`).

This chapter holds what a file on disk is to a folder: its identity and placement, how a folder writes, recovers and deletes files, how it treats paths and links, and how it takes in another folder's file.

## File identity

### `folder-files/markdown-extensions`

When a file with a `.md` or `.markdown` extension in any letter case is not bound to a file item, a device MUST read its Markdown metadata.

**Tests:** `device/folders-identity.test.ts › reads the id of a Markdown file whatever the case of its extension`, `device/folders-placement.test.ts › reads a new note written where a moved file item was as a note`.

### `folder-files/id-rename`

When a Markdown file moves with its `marfa_id` line intact and no stronger binding identifies another item, a device MUST retain the named item.

**Tests:** `device/folders-identity.test.ts › follows a rename by the id the file carries, and sends no edit of the item for it`.

### `folder-files/id-missing-binding`

When a bound file is saved without its `marfa_id` line, a device MUST retain its item by its existing identity or path binding.

**Tests:** `device/folders-identity.test.ts › keeps the item when a save drops the id line`, `device/folders-identity.test.ts › keeps a binding for every file after a swap that also edits both`.

### `folder-files/id-minted`

When an unbound document has no usable item ID, a device MUST create it under a newly minted ID without a natural key or version.

**Tests:** `device/folders-identity.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folder-files/id-after-create`

When a document's create lands and its bytes have not changed since scan, a device MUST write the accepted `marfa_id` into the file.

**Tests:** `device/folders-identity.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folder-files/id-before-create`

While a document's create is unanswered, a device MUST preserve its existing file bytes.

**Tests:** `device/folders-identity.test.ts › creates a file under the device's id and writes the id back once it lands`.

### `folder-files/id-concurrent-save`

When a file changes after scan, a device MUST preserve the later save rather than writing metadata over it.

**Tests:** `device/folders-identity.test.ts › does not write back into a file changed since its scan`.

### `folder-files/id-not-property`

When a device sends a document create or edit, a device MUST omit `marfa_id` from the item properties.

**Tests:** `device/folders-identity.test.ts › keeps its id line out of what it sends the server`.

### `folder-files/id-removal-no-edit`

When a save only removes `marfa_id`, a device MUST NOT send an item edit.

**Tests:** `device/folders-identity.test.ts › sends nothing for a save that only drops the id line`.

### `folder-files/id-removal-restored`

When a save only removes `marfa_id`, a device MUST restore the ID line at the next pull.

**Tests:** `device/folders-identity.test.ts › sends nothing for a save that only drops the id line`.

### `folder-files/id-checkout`

When an unbound Markdown file names an existing document in the copy, a device MUST send its changes to that item rather than creating another.

**Tests:** `device/folders-identity.test.ts › sends a checked-out file's edits to the item its id names, and nothing for one in step`.

### `folder-files/id-vacated-path`

When a renamed file leaves its old path to a newly created file in the same scan, a device MUST create a separate item for the new file.

**Tests:** `device/folders-identity.test.ts › does not write a new file's body onto the item whose name it took`.

### `folder-files/atomic-editor-save`

When an editor replaces a bound file at the same path, a device MUST treat its changed content as an edit of the same item.

**Tests:** `device/folders-identity.test.ts › keeps an agent's whole-file rewrite the same item`.

### `folder-files/atomic-editor-unchanged`

When an editor replaces a bound file with equivalent content at the same path, a device MUST NOT create or edit an item for the replacement.

**Tests:** `device/folders-identity.test.ts › keeps an unchanged rewrite the same item`.

### `folder-files/atomic-editor-follow`

When an editor replaces a bound file at the same path and then renames it, a device MUST follow the replacement as the same item.

**Tests:** `device/folders-identity.test.ts › keeps an unchanged rewrite the same item`.

### `folder-files/copy-binding-precedence`

When files in one folder claim the same item ID, a device MUST prefer the file identified by the existing binding.

**Tests:** `device/folders-identity.test.ts › keeps the id with the file its binding names`, `device/folders-identity.test.ts › keeps the id with the original an editor saved without its line, over a copy carrying it`.

### `folder-files/copy-older-precedence`

When unbound files claim the same item ID and have distinct birth times, a device MUST prefer the file with the earlier birth time.

**Tests:** `device/folders-identity.test.ts › keeps the id with the older of two unbound files that carry it`.

### `folder-files/copy-new-item`

When a file copies another file's item ID, a device MUST create a separate item for the copy under a fresh ID, unless it is an old buffer of that item's file as `folder-documents/moved-save-taken` says.

**Tests:** `device/folders-identity.test.ts › makes a copy a new item with a fresh id`, `device/folders-placement.test.ts › makes a later copy at the old name a new item, and leaves the note as it was`.

### `folder-files/copy-write-id`

When a copied document's create lands, a device MUST write the fresh ID into the copy.

**Tests:** `device/folders-identity.test.ts › makes a copy a new item with a fresh id`.

### `folder-files/copy-binding-kept`

While a copy still carries its original's ID line after its own create lands, a device MUST retain the copy's own binding even if the original file disappears.

**Tests:** `device/folders-identity.test.ts › keeps a copy its own item once the original goes, before its id line is rewritten`.

### `folder-files/id-unknown-new`

When an unbound document names an ID absent from the copy, a device MUST replace that ID with a fresh document ID on creation.

**Tests:** `device/folders-identity.test.ts › gives a fresh id to a file whose id names nothing`.

### `folder-files/id-system-ignored`

When an unbound document names a `system.*` item as its ID, a device MUST create a separate document item.

**Tests:** `device/folders-identity.test.ts › reads no id from a file naming the folder's own settings`.

### `folder-files/id-file-item-ignored`

When an unbound document names a file item as its ID, a device MUST create a separate document item.

**Tests:** `device/folders-identity.test.ts › reads no id from a .txt file or from a document naming a file item`.

### `folder-files/raw-text-body`

When a file with a `.txt` extension in any letter case is not bound to a file item, a device MUST treat its complete text as the document body without reading or writing frontmatter.

**Tests:** `device/folders-identity.test.ts › reads a .txt file that opens with a --- block as a body`, `device/folders-identity.test.ts › reads a .txt file whatever the case of its extension`, `device/folders-identity.test.ts › follows a rename by device, inode and birth time`.

### `folder-files/identity-rename`

When a file's unique filesystem identity survives a rename, a device MUST retain the same item.

**Tests:** `device/folders-identity.test.ts › follows a rename by device, inode and birth time`.

### `folder-files/identity-unusable`

When an unbound file has no unique usable filesystem identity, a device MUST treat it as new rather than infer a rename from another missing file.

**Tests:** `device/folders-identity.test.ts › treats a file with no usable identity as new rather than guessing`.

### `folder-files/identity-admitted-files`

When deciding whether file identities are unique, a device MUST consider only files the folder admits.

**Tests:** `device/folders-identity.test.ts › resolves identity over the files it holds, not every file in the tree`.

### `folder-files/identity-equivalent-save`

When a bound file is replaced with the same bytes and then renamed, a device MUST retain its item.

**Tests:** `device/folders-identity.test.ts › follows the rename of a file saved again with the same bytes`.

### `folder-files/identity-unread-rename`

When a renamed bound file has empty or unreadable bytes, a device MUST retain its item at the renamed path.

**Tests:** `device/folders-placement.test.ts › keeps a renamed file's item while its bytes are %s`.

### `folder-files/identity-unread-replacement`

When an unreadable renamed file leaves a replacement at its previous path, a device MUST preserve the renamed file's ownership of its item.

**Tests:** `device/folders-placement.test.ts › keeps unread rename ownership over a replacement at the old path: %s`.

### `folder-files/identity-placement-bytes`

When an unbound raw-text or file-item file matches the path and rendered bytes of an otherwise unbound item held by the query, or of an otherwise unbound file item attached to a document the query holds whose file in the directory embeds that path, a device MUST bind it to that item.

**Reason:** A pull writes the attachments of the documents a folder holds even when its query holds no file type, so a folder added again over such a file holds it as the item it was, not as a new item beside a second copy. Before a folder's first pull, its copy holds no such attachment, so the device reads it from the server before it binds the file, whether or not the first sync was planned before it was confirmed.

**Tests:** `device/folders-placement.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders-placement.test.ts › takes back an empty text file rendered from a missing body`, `device/folders-frontmatter.test.ts › takes each back as its own item by placement and bytes, and plans and sends nothing`, `device/folders-frontmatter.test.ts › takes back the file a note embeds when the add confirms its first sync at once`, `device/folders-frontmatter.test.ts › sends as new a file whose bytes changed while it was away, or that holds the bytes of a file placed elsewhere, and loses neither item's bytes`.

### `folder-files/identity-placement-unread-attachment`

If a device's read of an item attached to a document the query holds fails for a reason other than that the server does not hold the item, will not show it or ends the drain, and that document's file in the directory embeds the path of an unbound file, then a device MUST hold that file, flagged `waiting`, without making an item of it.

**Reason:** The item may be the file's own, and a pull writes it beside a new item as a second copy. Each scan that meets the file reads the item again, so the file is bound to it once the read succeeds, and the scan goes on with every other file meanwhile. A failure that ends the drain ends the scan instead, since it is no one file's and the push after the scan would meet it too: a refused credential, which ends the copy, a renewal of the credential that fails other than by an environmental failure, no sign-in or no keychain, a redirect, an answer naming another contract, a full store, an expired copy, a working copy that changed during the scan, a stream cut short, or a stopped run. An environmental failure, such as no network or a renewal that cannot reach its keychain, holds the file.

**Tests:** `device/folders-frontmatter.test.ts › holds a file a note embeds while the item attached there cannot be read, sends the rest, and takes it back once it can`.

### `folder-files/identity-takeback-search`

When a file matches the old placement and bytes of an item the query no longer holds, and no document the query holds whose file in the directory embeds that path has that item attached, a device MUST create a new item for that file.

**Tests:** `device/folders-placement.test.ts › takes back by placement and bytes only an item its query holds`.

### `folder-files/identity-takeback-peer`

When another folder has taken in an item, a device MUST NOT take back that item for a copy at its former placement.

**Tests:** `device/folders-one-mac.test.ts › takes no file back by its bytes for an item another folder on the Mac took in`.

### `folder-files/watch-file-equivalence`

When equivalent new files are present at startup or arrive while watching, a device MUST create equivalent item types and content.

**Tests:** `device/folders-identity.test.ts › binds the same file to the same item whether it was present at start or arrived while running`.

### `folder-files/copy-birth-tie`

When unbound files claim one item ID and their birth times are equal, a device MUST give the item to the first file in path order.

**Tests:** `device/folders-contract-extra-c.test.ts › uses path order when copied IDs have the same birth time and no binding`.

### `folder-files/copy-identity-binding`

While another file keeps the ID carried in a copy's text, a device MUST retain the copy's own item when its binding identifies it at a new path.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps a copied file's own binding after it moves while its old ID has a keeper`.

### `folder-files/copy-delete-path-kept`

When a file is copied elsewhere and deleted from its bound path before a replacement appears there ahead of the next scan, a device MUST keep the replacement at the bound path as that item.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps the old path's replacement as the item after a copy-and-delete move`.

### `folder-files/identity-placement-different`

When an unbound raw-text or binary file at an item's placement contains different bytes from that item, a device MUST treat the file as a new item.

**Tests:** `device/folders-contract-extra-c.test.ts › makes a raw file with different bytes at an unbound placement a new item`, `device/folders-contract-extra-c.test.ts › makes a binary file with different bytes at an unbound placement a new item`.

## Placement

### `folder-files/placement-path`

When an item has an `in-folder` edge to the folder, a device MUST place its file at the edge's root-relative `path`.

**Tests:** `device/folders-placement.test.ts › places an item where its in-folder edge says, on every Mac`.

### `folder-files/placement-edge-type`

When another edge points to the folder's item, a device MUST NOT treat it as placement.

**Tests:** `device/folders-placement.test.ts › reads no other edge to the folder as a placement`.

### `folder-files/placement-remote-move`

When another device changes an item's placement path, a device MUST move the file to that path at the next pull.

**Tests:** `device/folders-placement.test.ts › places an item where its in-folder edge says, on every Mac`.

### `folder-files/placement-first-type`

When a newly encountered item has no placement, a device MUST derive its path from its title under the most specific first-placement type or ancestor, or the root if none matches.

**Tests:** `device/folders-placement.test.ts › places a new item from elsewhere under its type's first placement`, `device/folders-placement.test.ts › places a new item under the most specific first placement naming its type`.

### `folder-files/placement-create`

When a device gives an unplaced item a file, a device MUST create the item's `in-folder` edge with that path.

**Tests:** `device/folders-placement.test.ts › places a new item from elsewhere under its type's first placement`, `device/folders-placement.test.ts › writes the in-folder edge for a file made in the folder`, `device/folders-placement.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`.

### `folder-files/placement-checkout`

When a checked-out document is first bound, a device MUST place its item where the file sits.

**Tests:** `device/folders-placement.test.ts › places a checked-out file where it sits`.

### `folder-files/placement-rename-only`

When a file is moved or renamed without a content change, a device MUST send only its placement change, unless it is a Markdown document whose new name is not in step with its title (`folder-documents/rename-title`) or a file item whose title is its old file name.

**Tests:** `device/folders-placement.test.ts › sends only the placement for a move under the same name`, `› sends only the placement for a rename of a document that is not Markdown`.

### `folder-files/placement-not-document`

When a device renders a file, a device MUST omit its `in-folder` edge from frontmatter and body links.

**Reason:** the `in-folder` edge type's `written_from` is `none` (`folder-documents/edge-written-nowhere`), since a file's place is where it sits.

**Tests:** `device/folders-placement.test.ts › writes the in-folder edge for a file made in the folder`.

### `folder-files/placement-give-way-duplicate`

When another device's existing placement causes this device's placement create to be refused as a duplicate, a device MUST follow the accepted placement.

**Tests:** `device/folders-placement.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/fidelity.test.ts › matches the refusal of a second placement of one item in one folder`.

### `folder-files/placement-give-way-stale`

When another device's accepted placement causes this device's move to be refused as stale, a device MUST follow the accepted placement.

**Tests:** `device/folders-placement.test.ts › follows another Mac's move of the same file, giving its own way`, `› settles two Macs that rename one note's file for one new title`.

### `folder-files/placement-give-way-count`

When a device gives way to another device's placement, a device MUST count the result as `gave_way`.

**Tests:** `device/folders-placement.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/folders-placement.test.ts › follows another Mac's move of the same file, giving its own way`.

### `folder-files/placement-give-way-queue`

When a device gives way to another device's placement, a device MUST remove its obsolete refused or blocked placement writes from the queue.

**Tests:** `device/folders-placement.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `device/folders-placement.test.ts › follows another Mac's move of the same file, giving its own way`.

### `folder-files/placement-give-way-later`

When a folder drains while its queue holds one of its placement writes that the server answered as stale or refused as a duplicate, a device MUST give way to the server's placement in that drain, whichever drain the answer came in, unless that drain found the server unable to answer or was stopped by a refused credential, an earlier give-way read in that drain met an environmental failure, or a watch waits to read for that write again (`folder-files/placement-give-way-watch-throttled`).

**Reason:** a give-way whose read failed is finished by a later drain that can read the server, so the copy does not keep showing a move the server answered as stale. Against a server that is failing, each further read would wait out its own timeout.

**Tests:** `device/folders-placement.test.ts › finishes giving way at a later drain when the read it gives way from fails`, `› keeps a move it cannot give way from while the read is refused %i, and fails no drain`, `› follows the placement another Mac made first, and leaves no refusal behind`.

### `folder-files/placement-give-way-read-fails`

If the read a device gives way from fails with an environmental failure or is refused, then a device MUST keep the placement write in the queue as the server answered it, and the working copy as it was.

**Reason:** only a read of the server's placement says where the file goes. A read refused `403` or `404` can be answered once the key or the item changes, so the write stays where the person can see it, withdraw it (`queue-and-verdicts/withdraw-takes-out`) or discard it, and a later drain reads again (`folder-files/placement-give-way-later`).

**Tests:** `device/folders-placement.test.ts › finishes giving way at a later drain when the read it gives way from fails`, `› keeps a move it cannot give way from while the read is refused %i, and fails no drain`.

### `folder-files/placement-give-way-drain-goes-on`

If the read a device gives way from fails with an environmental failure or is refused, then a device MUST complete the folder's drain and report every verdict it reached.

**Reason:** one placement the server cannot or will not let it read does not stop the rest of the folder from syncing.

**Tests:** `device/folders-placement.test.ts › finishes giving way at a later drain when the read it gives way from fails`, `› keeps a move it cannot give way from while the read is refused %i, and fails no drain`.

### `folder-files/placement-give-way-newer-kept`

When a device gives way from moves of an `in-folder` edge that the server answered as stale, a device MUST keep in the queue each write to that edge queued after the last of those moves.

**Reason:** a move made after the copy heard of the other machine's placement is based on it, and is the person's latest word on where the file goes.

**Tests:** `device/folders-placement.test.ts › keeps a move made after the one it gives way from`.

### `folder-files/placement-give-way-watch`

While a watch holds a placement write whose give-way read failed, a device MUST read for it again at most once a minute.

**Reason:** a watch drains at every pass, and a pass can start every second while changes wait, so a read refused for good, made again at each drain, would spend the key's rate limit. The exact threshold needs a fixture-controlled clock.

**Tests:** `device/binding-folders-placement.test.ts › suppresses a failed give-way reread before sixty seconds and reads again afterwards`.

### `folder-files/placement-give-way-watch-throttled`

While a watch holds a placement write whose give-way read failed, a device MUST suppress repeated reads for it across successive passes.

**Tests:** `device/folders-placement.test.ts › reads for a placement it could not give way from again at most once a minute while watching`.

### `folder-files/placement-newer-copy`

When a device gives way to another machine's placement, a device MUST retain a newer placement already held in its working copy instead of replacing it with the older placement read from the server.

**Tests:** `device/folders-placement.test.ts › follows a move it heard of after the read it gives way from`.

### `folder-files/placement-give-way-atomic`

When a device gives way to another machine's placement, a device MUST expose the server's placement and withdrawal of its own placement writes as one change to the working copy.

**Reason:** A concurrent caller must not observe the withdrawn local move without the placement that replaces it.

**Tests:** `device/binding-folders-placement.test.ts › exposes the accepted placement and withdrawal together while a reader observes the transaction`.

### `folder-files/placement-forget-unchanged`

When a placement read during giving way finds an edge missing from the server, a device MUST remove that edge from its working copy only if the edge has not changed in the copy since the read began.

**Tests:** `device/binding-folders-placement.test.ts › forgets a missing placement only if the copy has not changed since the read began (%s)`.

### `folder-files/placement-collision-order`

When several items claim one path, a device MUST rank existing placements by creation time and then edge ID, ahead of unplaced items.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders-placement.test.ts › gives a contested path to a placed item before an unplaced one, and to a file already there before a new one`, `device/folders-placement.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`, `device/folders-contract-extra-c.test.ts › orders equal-time placement collisions by edge ID`.

### `folder-files/placement-collision-number`

When an item cannot keep a contested path, a device MUST use the first available numbered sibling name after removing any existing number suffix.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders-placement.test.ts › counts the free number past a file on disk, a path another item is placed at, and its own file`.

### `folder-files/placement-collision-free`

When choosing a numbered sibling path, a device MUST exclude paths occupied by other files or reserved by other placements while allowing the item's own file.

**Tests:** `device/folders-placement.test.ts › counts the free number past a file on disk, a path another item is placed at, and its own file`.

### `folder-files/placement-collision-count`

When a pull assigns a numbered sibling path, a device MUST count the item as `beside`.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders-placement.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`.

### `folder-files/placement-collision-write`

When a pull assigns a numbered sibling path, a device MUST move the item's placement edge to that path.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders-placement.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`.

### `folder-files/placement-settles`

When devices have received the same accepted placements and settled path conflicts, a device MUST stop sending unchanged placements.

**Tests:** `device/folders-placement.test.ts › gives a path two Macs made a file at to the item placed there first, the same on every Mac`, `› settles two Macs that rename one note's file for one new title`.

### `folder-files/placement-outside`

When a placement is excluded by the folder lists, is inside a package, contains `..` or escapes through a symbolic link, a device MUST count it `outside`.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`, `device/folders.test.ts › does not walk into a package`.

### `folder-files/placement-outside-no-write`

When a placement is excluded by the folder lists, contains `..`, or escapes through a symbolic link, a device MUST NOT write the file at that path.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`.

### `folder-files/placement-outside-edge-kept`

When a placement is outside the paths the folder writes, a device MUST leave the edge's path unchanged.

**Tests:** `device/folders-placement.test.ts › places a file whose placement another item holds beside it, and writes none where its placement is unsafe`.

### `folder-files/placement-unsuited`

When a placement extension would change a document into a non-document or a file item into another MIME type, a device MUST count it `unsuited`.

**Tests:** `device/folders-placement.test.ts › writes no file where its placement would make it another kind of file`.

### `folder-files/placement-unsuited-no-write`

When a placement would make a file another kind of item, a device MUST NOT write the file at that path.

**Tests:** `device/folders-placement.test.ts › writes no file where its placement would make it another kind of file`.

### `folder-files/placement-filesystem-failure`

When the filesystem refuses a placement, a device MUST count the affected item `unwritten`.

**Tests:** `device/folders-placement.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folder-files/placement-filesystem-keeps`

When the filesystem refuses a placement, a device MUST retain the file at its previous path.

**Tests:** `device/folders-placement.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folder-files/placement-filesystem-continues`

When the filesystem refuses one placement, a device MUST continue processing other files.

**Tests:** `device/folders-placement.test.ts › skips a placement the filesystem refuses, and keeps the file where it was`.

### `folder-files/placement-refusal-no-repeat`

While a refused placement's path, settings, key ID, grant, and prior placement remain unchanged, a device MUST NOT resend that placement.

**Tests:** `device/folders-placement.test.ts › sends a placement the server refused once, until the settings or the key change`, `device/folders-placement.test.ts › takes a key it could not read when a placement was refused as unchanged, and does not send the placement again`.

### `folder-files/placement-refusal-new-path`

When a file moves after its placement was refused, a device MUST try the new path.

**Tests:** `device/folders-placement.test.ts › sends a placement the server refused once, until the settings or the key change`.

### `folder-files/placement-key-push`

When a push holds a refused placement, a device MUST reread the key's current grant before deciding whether to retry.

**Tests:** `device/folders-placement.test.ts › sends a refused placement again once the key's grant is restored, and not while the key cannot be read`.

### `folder-files/placement-key-watch`

While a watch holds refused placements, a device MUST limit key rereads, including failed reads, to at most once per minute.

**Reason:** The exact one-minute threshold needs a fixture-controlled clock; real-time watch fixtures prove suppression between passes and eventual recovery.

**Tests:** `device/binding-folders-placement.test.ts › suppresses a refused placement's key reread before sixty seconds and reads again afterwards, including failed reads (%s)`.

### `folder-files/placement-grant-restored`

When a watch observes that the placement grant has been restored, a device MUST retry the refused placement.

**Tests:** `device/folders-placement.test.ts › sends a refused placement again while watching, once the key's grant is restored, reading the key at most once a minute`.

### `folder-files/placement-key-unreadable`

When the key cannot be read, a device MUST treat it as unchanged for retrying refused placements.

**Tests:** `device/folders-placement.test.ts › sends a refused placement again once the key's grant is restored, and not while the key cannot be read`, `device/folders-placement.test.ts › takes a key it could not read when a placement was refused as unchanged, and does not send the placement again`.

### `folder-files/placement-refusal-cleared`

When a later placement for an item lands, a device MUST release that item's earlier placement refusal.

**Tests:** `device/folders-placement.test.ts › follows another Mac's move of an item whose move it was refused`, `device/folders-placement.test.ts › sends a refused move again once a later placement of the item lands`.

### `folder-files/purged-placement-refusal`

When a refused placement belongs to an item no longer held in the working copy, a device MUST stop reporting that placement as refused.

**Tests:** `device/folders-identity.test.ts › lets go of a refused placement once its item is purged`.

### `folder-files/placement-refused-file-kept`

While a file's placement move is refused, a device MUST leave the file at the person's chosen path.

**Tests:** `device/folders-placement.test.ts › keeps a file where the person moved it when the server refuses the move`.

### `folder-files/placement-unplaced-count`

When a pull holds refused placements, a device MUST report their count as `unplaced`.

**Tests:** `device/folders-placement.test.ts › sends a placement the server refused once, until the settings or the key change`.

### `folder-files/placement-watch-notice`

While a refused-placement count is unchanged, the CLI MUST NOT repeat its watch notice for each eventful pass.

**Tests:** `device/folders-placement.test.ts › says the placements it holds back once while watching`.

### `folder-files/placement-add-permission`

If a key lacks `edge.in-folder:write`, then the CLI MUST refuse `folders add` naming that permission.

**Tests:** `device/folders-placement.test.ts › names the permission a key without in-folder write lacks, when it is added`, `device/fidelity.test.ts › matches the key a folder asks about when it is added`.

### `folder-files/placement-add-cleanup`

When `folders add` is refused for lacking placement permission, a device MUST remove every directory and file it created for the failed add.

**Tests:** `device/folders-placement.test.ts › names the permission a key without in-folder write lacks, when it is added`.

### `folder-files/placement-add-cleanup-keeps`

When `folders add` is refused for lacking placement permission, a device MUST keep every directory and file that existed before the add.

**Reason:** A directory being added often already holds the person's files, or the empty state directory that removing a folder leaves.

**Tests:** `device/folders-placement.test.ts › names the permission a key without in-folder write lacks, when it is added`.

### `folder-files/placement-not-membership`

When evaluating folder membership, a device MUST use the query independently of whether an item has a placement edge to the folder.

**Tests:** `device/folders-placement.test.ts › does not let placement decide what it holds`.

### `folder-files/placement-current-path`

When an item has a file bound in the folder but no placement edge, a device MUST keep that file at its current path.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps an unplaced file at its checked-out path instead of its title`.

### `folder-files/placement-swap-waits`

When two remote placements swap paths occupied by each other's files, a device MUST leave both files unchanged.

**Tests:** `device/folders-contract-extra-c.test.ts › leaves both files intact when their remote placements swap`.

### `folder-files/placement-swap-count`

When two remote placements swap paths occupied by each other's files, a device MUST count both items as `unwritten`.

**Tests:** `device/folders-contract-extra-c.test.ts › leaves both files intact when their remote placements swap`.

### `folder-files/placement-move-publish-first`

If writing a moved file at its new placement fails, then a device MUST leave the file whole with the bytes it had, at its previous path where the rename that moves it has not been made and at its new path where it has.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps the moved file whole when writing it at its new placement fails, and leaves emptied directories after success`, `device/folders-placement.test.ts › keeps a file at its old path, whole, when the rename that moves it is refused`.

### `folder-files/placement-empty-directories`

When a file moves to a new placement, a device MUST retain the directories emptied by that move.

**Tests:** `device/folders-contract-extra-c.test.ts › keeps the moved file whole when writing it at its new placement fails, and leaves emptied directories after success`.

### `folder-files/placement-add-non-key`

When `GET /keys/current` answers `403 forbidden` for a credential that is not a key, a device MUST allow folder addition without requiring a key's `in-folder` grant.

**Tests:** `device/folders-contract-extra-c.test.ts › accepts a non-key credential when the current-key door answers forbidden`.

### `folder-files/placement-key-watch-throttled`

When a watch cannot read the current key, a device MUST suppress repeated key requests across successive passes.

**Tests:** `device/folders-placement.test.ts › asks a key it could not read again at most once a minute while watching`.

## Ending a placement

### `folder-files/placement-end-departure`

When a file leaves a folder because its item was trashed or left the query's states, a device MUST delete that folder's `in-folder` edge for the item.

**Tests:** `device/folders-identity.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `device/folders-identity.test.ts › ends a folder's placement of an item that leaves by state, and places it again when it returns`, `device/folders.test.ts › lets a paused file whose item left by state go when the removal is put back, rather than journaling it again`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folder-files/placement-end-transfer`

When a file transfers to another folder on the machine and its original folder's query no longer holds its item, a device MUST delete the original folder's `in-folder` edge for the item.

**Tests:** `device/folders-one-mac.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `cli/folder.test.ts › ends a folder's placement of an item whose file another folder took in, and no sooner`.

### `folder-files/placement-end-delete`

When a scan sends a missing file's item deletion or finds its item already trashed, a device MUST delete that folder's `in-folder` edge for the item.

**Tests:** `device/folders-identity.test.ts › ends a folder's placement of an item whose file the person deleted`, `device/folders-contract-c-retry.test.ts › ends the placement of a missing file already trashed on another device`.

### `folder-files/placement-last-binding`

When a bound file moves or is renamed within its folder and its placement edge still exists, a device MUST update that `in-folder` edge rather than end it and create another.

**Reason:** A move changes the placement path without creating a new relationship.

**Tests:** `device/binding-folders-placement.test.ts › keeps the existing placement edge when its file moves, and ends it only when the file is deleted`.

### `folder-files/placement-end-retry`

If ending a departing file's placement fails locally, then a device MUST retain the file's binding so a later pass can retry ending the placement.

**Tests:** `device/folders-identity.test.ts › keeps the file and the placement where ending the placement fails, and ends it at the next push`, `device/folders-identity.test.ts › keeps the binding of a deleted file where ending its placement fails, and ends it at the next push`, `device/folders-one-mac.test.ts › leaves the binding of a file it let go where ending the placement fails, and the scan ends it past the grace`.

### `folder-files/placement-purge-no-delete`

When an item's purge removes its placement from the working copy, a device MUST NOT send a separate deletion of that placement.

**Tests:** `device/folders-identity.test.ts › sends nothing to end the placement of a purged item, which the purge took with it`.

### `folder-files/placement-held-transfer`

When a file moves to a folder that does not hold its item but its original folder's query still holds the item, a device MUST retain the original folder's placement.

**Tests:** `device/folders-one-mac.test.ts › keeps a folder's placement of an item it holds when its file is moved to a folder that does not`.

### `folder-files/placement-unmatched-kept`

While a folder retains an item's file as `unmatched`, a device MUST retain that folder's placement of the item.

**Tests:** `device/folders-identity.test.ts › keeps a folder's placement of an item whose file stays where it is`.

### `folder-files/placement-restore-new`

When a folder's query holds an item again after its placement ended, a device MUST place the item using the current first-placement setting or title as for a new item.

**Tests:** `device/folders-identity.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folder-files/placement-end-count`

When a pull queues the end of a placement, a device MUST count that end in the pull report's `ended` field.

**Tests:** `device/folders-one-mac.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `device/folders-identity.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`, `device/folders-identity.test.ts › ends a folder's placement of an item that leaves by state, and places it again when it returns`, `cli/folder.test.ts › ends a folder's placement of an item put in the bin, and places it again on restore`.

### `folder-files/placement-end-same-push`

When a folder sync's pull ends a placement, a device MUST send that end in the same sync unless `folder-sync/push-server-unavailable`, `folder-sync/push-credential-stopped` or `folder-sync/push-undelivered` prevents a further drain.

**Tests:** `device/folders-one-mac.test.ts › ends a folder's placement of an item whose file another folder took in or let go`, `device/folders-identity.test.ts › ends a folder's placement of an item that is trashed, and places it again on restore`.

### `folder-files/placement-end-already-gone`

When the server answers a placement's deletion with `edge_not_found`, a device MUST treat that placement as ended.

**Tests:** `device/folders-identity.test.ts › takes the end of a placement another machine ended first as done`.

### `folder-files/placement-end-refused-queue`

When the server refuses a placement's deletion for the key's grant, a device MUST retain the refused deletion in the queue.

**Tests:** `device/folders-identity.test.ts › asks once for the end of a placement the server refuses, and reports it`.

### `folder-files/placement-end-refused-once`

While a refused placement deletion remains in the queue, a device MUST NOT queue another deletion of the same placement.

**Tests:** `device/folders-identity.test.ts › asks once for the end of a placement the server refuses, and reports it`.

## File writes and recovery

### `folder-files/write-no-echo`

When a scan follows a device's own file write, a device MUST NOT treat that write as a user create or edit.

**Tests:** `device/folders-placement.test.ts › does not read its own writes back as changes`.

### `folder-files/write-whole`

When a device writes a document, file item, settings file or file transferred from another folder, a device MUST publish complete bytes or leave the previous file intact.

**Tests:** `device/folders-identity.test.ts › writes a file whole beside it and renames it over, so a failed write leaves the old one`, `device/folders-one-mac.test.ts › keeps a file a crash cut off taking in where it was, and journals no delete`, `device/folders-identity.test.ts › keeps its settings file its own when a crash cuts off writing it`, `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`.

### `folder-files/write-attributes`

When a device replaces an existing file, a device MUST retain its supported extended attributes.

**Tests:** `device/folders-identity.test.ts › writes a file whole beside it and renames it over, so a failed write leaves the old one`.

### `folder-files/write-crash-no-edit`

When a file write crashes before its new bytes land, a device MUST NOT send the previous file content as a user edit during recovery.

**Tests:** `device/folders-identity.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`, `device/folders-identity.test.ts › restores a styled file's agreement after a pull crashes before landing`.

### `folder-files/write-crash-new-no-delete`

When a new file write crashes before the file lands, a device MUST NOT journal that absent file as a user deletion.

**Tests:** `device/folders-identity.test.ts › journals no delete for a new file a crash cut off writing`.

### `folder-files/write-crash-status`

When a write crashes before replacing an unchanged existing file, the CLI MUST report that file as `in_step` during recovery.

**Tests:** `device/folders-identity.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`.

### `folder-files/write-crash-temporary-cleanup`

When a crashed writer is no longer running, a device MUST remove its abandoned temporary files at the next scan.

**Tests:** `device/folders-identity.test.ts › keeps a file a crash cut off writing as its own, and sends nothing for it`.

### `folder-files/write-crash-take-in`

When taking in another folder's file crashes before landing, a device MUST preserve the source file without journaling a deletion.

**Tests:** `device/folders-one-mac.test.ts › keeps a file a crash cut off taking in where it was, and journals no delete`.

### `folder-files/write-crash-settings`

When a settings-file write crashes before landing, a device MUST retain the old file as its own prior write rather than send it as an edit.

**Tests:** `device/folders-identity.test.ts › keeps its settings file its own when a crash cuts off writing it`.

### `folder-files/write-crash-move-kept`

When a pull's move of a file is cut off after the file is renamed and before the move is recorded, a device MUST NOT queue deletion of the item while its file is at the new path.

**Tests:** `device/folders-placement.test.ts › keeps the item when %s cuts off another Mac's move after the rename`.

### `folder-files/write-editor-race`

When a person changes a file before a pull's final check, a device MUST preserve that save instead of overwriting, removing, or letting go of the file.

**Tests:** `device/folders-identity.test.ts › leaves a file it would take away or rewrite where the person saved it meanwhile`, `device/folders-placement.test.ts › keeps a save made while a move writes the file, in the moved file`, `device/folders-one-mac.test.ts › leaves a file it let go where the person saved it meanwhile`.

### `folder-files/write-new-target-race`

When a file appears after an absent target was checked, a device MUST leave the appearing file untouched.

**Tests:** `device/folders-identity.test.ts › keeps a file that appears after an absent landing target was checked`.

### `folder-files/write-failure-binding`

When a replacement landing fails, a device MUST retain the previous item's binding and deletion journal at that path.

**Tests:** `device/folders-placement.test.ts › restores another item's binding and journal when a landing fails`.

### `folder-files/write-render-report`

When a document cannot be rendered safely, a device MUST report its path, item, and reason in `flagged`.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folder-files/write-render-continues`

When one document cannot be rendered safely, a device MUST continue writing other documents.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folder-files/write-settings-failure`

When a settings file cannot be written, a device MUST report `settings.unwritten`.

**Tests:** `device/folders-identity.test.ts › reports a settings file it cannot write, and goes on`.

### `folder-files/write-settings-continues`

When a settings file cannot be written, a device MUST continue the folder pass.

**Tests:** `device/folders-identity.test.ts › reports a settings file it cannot write, and goes on`.

### `folder-files/write-permissions`

When a device replaces an existing file, a device MUST retain its permission bits except where the item's executable property requires changing executable bits.

**Tests:** `device/folders-contract-extra-c.test.ts › preserves a replaced file's permission bits`.

### `folder-files/write-live-temporary`

While the process that owns a temporary publication file is running, a device MUST NOT remove that temporary file during scan cleanup.

**Tests:** `device/folders-contract-extra-c.test.ts › retains temporary files owned by a live process while cleaning an abandoned one`.

### `folder-files/write-no-replace-unavailable`

If atomic no-replace publication is unavailable for an absent target, then a device MUST fail that write without falling back to a replacing rename.

**Tests:** `device/folders-contract-extra-c.test.ts › fails an unsupported no-replace publication safely and succeeds once it is available`.

### `folder-files/write-no-replace-recovery`

When atomic no-replace publication becomes available after a failed write, a device MUST retry the file at a later pull.

**Tests:** `device/folders-contract-extra-c.test.ts › fails an unsupported no-replace publication safely and succeeds once it is available`.

### `folder-files/write-render-unwritten`

When a document cannot be rendered safely, a device MUST count it `unwritten`.

**Tests:** `cli/folder.test.ts › preserves %s edits and continues pulling another document`.

### `folder-files/write-read-only`

When an existing file is read-only, a device MUST leave it unchanged during a pull.

**Tests:** `device/folders-contract-a.test.ts › keeps a read-only document unchanged when another device changes its item`.

## Deletion, purges and missing directories

### `folder-files/delete-grace`

When a bound file disappears, a device MUST defer its item deletion for the five-second rename grace.

**Reason:** The exact grace boundary requires a fixture-controlled clock; real-time fixtures assert deferral and cancellation but not the threshold.

**Tests:** `device/binding-folders-clock.test.ts › defers a missing file until the five-second rename grace ends`.

### `folder-files/delete-grace-keeps-watch-awake`

While the rename grace of a missing file in a watched folder runs, a device MUST go on running passes until a pass has decided the file's deletion.

**Reason:** a pass that measures the grace once at its sweep and again at its end can pass the file over and then rest, so no pass decides the deletion until a file event or the next full pass.

**Tests:** `device/binding-folders-clock.test.ts › sends the delete of a file whose grace ends after the sweep passed it over, with no event to wake the watch`.

### `folder-files/delete-rename-cancels`

When a file returns at its own path or a new name within the rename grace, a device MUST cancel its journaled deletion.

**Tests:** `device/folders-placement.test.ts › takes the old path out of the journal when the file comes back under a new name`, `device/folders-placement.test.ts › takes a file out of the journal when it comes back under its own name`, `device/folders-placement.test.ts › defers a delete past the rename grace`.

### `folder-files/delete-remote-revives`

When another device changes a deleted item in content its file shows during the rename grace and no other registered folder holds the file's move, a device MUST restore the file from the changed item.

**Reason:** A file another folder holds as this one moved is the item's file there, and written back here it would read there as a copy (`folder-files/moved-not-revived`, `folder-files/uncertain-move-no-replacement`). A file whose move cannot be told yet comes back once no folder holds it (`folder-files/missing-file-changed-revives`). A file whose folders both hold its item is not a move (`folder-files/item-in-folders-delete`), so it is written back.

**Tests:** `device/folders-identity.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`, `device/folders-pass-writeback.test.ts › writes a remote change into a file in place, and brings back a file deleted after the scan once its delete is journaled`, `device/folders-one-mac.test.ts › still writes back a file deleted where both folders hold its item when another device changes it`, `device/folders-held-links.test.ts › writes back a deleted held file when another device changes its item inside the grace`.

### `folder-files/delete-revived-cancels`

When a deleted file is revived by a visible remote change, a device MUST cancel its journaled deletion.

**Tests:** `device/folders-identity.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`.

### `folder-files/delete-revived-count`

When a deleted file is revived by a visible remote change, a device MUST count it `revived`.

**Tests:** `device/folders-identity.test.ts › writes a deleted file back when another device changes its item inside the grace, and sends no delete`, `device/folders-one-mac.test.ts › writes back a file deleted while another folder could not be read, once that folder holds no copy, when another device changed its item inside the grace`.

### `folder-files/delete-unshown-change`

When a deleted item advances in version without changing content its file shows, a device MUST retain the journaled deletion.

**Tests:** `device/folders-identity.test.ts › sends a person's delete of a file whose item moved on elsewhere in nothing the file shows`, `device/folders-identity.test.ts › keeps a deleted raw-text file gone after a version step even when its body looks like YAML`.

### `folder-files/delete-before-first-write`

When a person deletes a bound file before a device first writes its `marfa_id` line into it, a device MUST retain the journaled deletion while the item has not changed in content the file showed.

**Reason:** The lines a device adds on its first write, such as `marfa_id`, `type` and `tier`, were never content the file showed, so their absence from the deleted file is no change made elsewhere.

**Tests:** `device/folders-pass-writeback.test.ts › does not write back a file deleted after the scan, and journals the delete`, `device/binding-folders-clock.test.ts › writes back no file deleted between a watch pass's scan and its pull, and sends its delete after the grace`.

### `folder-files/delete-of-found-render`

When a person deletes a bound file that a device found holding exactly its item's rendered bytes, a device MUST retain the journaled deletion while the item has not changed in content the file showed.

**Reason:** A folder added over files an earlier copy wrote binds them without writing them, so it holds no version line of its own for them. The file showed the version line its bytes carry, and its absence from what the device would write now is no change made elsewhere. A render over a file keeps its comments, empty properties and formatting, so the deletion is the person's own whatever of those the file held, and the item goes to the bin with its values.

**Tests:** `device/folders-identity.test.ts › trashes the item of a file it found as its item renders once the person deletes it`.

### `folder-files/missing-held-line-unchanged`

When a person deletes a bound file that a device holds because a name on one of its edge lines matched no item, matched more than one item, or could not be looked up, a device MUST retain the journaled deletion while the item has not changed in content the file showed, counting that line as unchanged while the item still has every edge the device last recorded for the line and names no item the line did not name.

**Reason:** The held name never reached the item, so its absence from what the device would write now is no change made elsewhere. Counted as one, the deletion could not stand and the file could not come back either, since a held file's bytes are the person's to mend, and the missing file would stay in the folder's record for good. An item made since under the held name does not count either, because the line never reached the item. An edge another device removed from the line, or a name it added, is a change made elsewhere, and the file comes back under `folder-files/missing-file-changed-revives` or `folder-files/delete-remote-revives`, written as the item renders, without the held name.

**Tests:** `device/folders-held-links.test.ts › trashes the item of a deleted file held for a parent no item is named for`, `› trashes the item of a deleted held file once an item of the held name appears`, `› writes back a deleted held file when another device removes an edge its held line made`, `› writes back a deleted held file when another device adds an edge to its held line`.

### `folder-files/missing-refused-edit-unchanged`

When a person deletes a bound file whose edit the server refused, a device MUST retain the journaled deletion while the item has not changed in content the file showed, counting the refused edit as unchanged while the item is still at the version the file showed and no other write of the device's to the item waits.

**Reason:** The refused edit never reached the item, and the device reads back the item in its place, so its absence from what the device would write now is no change made elsewhere. Counted as one, a pull would write the file back inside the grace and the person's delete of their own file would never stand. A refused edit spends no version, so a change another device makes to the item's properties moves its version and brings the file back under `folder-files/missing-file-changed-revives`. The server changes tags, state and edges without a version step, so they are still compared, a refused tag or state change aside. A write of the device's own that the server has not answered sits in the working copy at the version it was based on, so while one waits the whole item is compared.

**Tests:** `device/folders-held-links.test.ts › trashes the item of a deleted file whose edit the server refused`, `› writes back a deleted file whose edit the server refused when another device archives its item`.

### `folder-files/pull-missing-file-not-written`

If a folder pull reaches an item whose bound file is missing from a path the folder's lists take outside any nested folder, neither journaled as deleted nor put back by a restore of a paused removal, then a device MUST NOT write the item's file.

**Reason:** A file gone since the scan read it was moved or deleted by the person, and only the next scan can tell which. Written back, a moved file reads as its copy and becomes a second item, and a deleted one returns. Once the next scan journals a deletion, `folder-files/delete-remote-revives` and `folder-files/moved-not-revived` decide whether the file comes back; a restore asks for it back under `folder-guards/restore-disk-files`. No scan reaches a path the lists no longer take or one inside a nested folder, so nothing there would tell a move from a delete, and the item's file is written where the item wants it.

**Tests:** `device/folders-pass-writeback.test.ts › does not write back a file moved after the scan, and the next scan follows the move`, `› does not write back a file renamed with its title line after the scan, and keeps its item`, `› does not write back a file deleted after the scan, and journals the delete`, `› keeps the edit of a file moved and edited after the scan, and makes no second item`, `› writes back none of a burst of files moved and deleted after the scan`, `› writes a remote change into a file in place, and brings back a file deleted after the scan once its delete is journaled`, `› counts a file the pull wrote itself and deleted after the scan as unwritten, not unchanged`, `device/folders-one-mac.test.ts › does not write back a file moved to another folder between a pass's scan and its pull`, `device/binding-folders-clock.test.ts › writes back no file moved between a watch pass's scan and its pull, and follows the move on the next pass`, `› writes back no file deleted between a watch pass's scan and its pull, and sends its delete after the grace`, `device/folders.test.ts › holds the files of a directory it cannot read, and goes on with the rest`.

### `folder-files/pull-missing-file-unwritten-count`

When a folder pull does not write an item's file under `folder-files/pull-missing-file-not-written`, a device MUST count the item as `unwritten`.

**Tests:** `device/folders-pass-writeback.test.ts › does not write back a file moved after the scan, and the next scan follows the move`, `› does not write back a file deleted after the scan, and journals the delete`, `› writes back none of a burst of files moved and deleted after the scan`, `› counts a file the pull wrote itself and deleted after the scan as unwritten, not unchanged`, `device/folders-one-mac.test.ts › does not write back a file moved to another folder between a pass's scan and its pull`.

### `folder-files/pull-missing-file-moved-keeps-item`

When a bound file moves within a folder between a folder scan and the pull that follows it, a device MUST bind the moved file to the same item at the next scan.

**Tests:** `device/folders-pass-writeback.test.ts › does not write back a file moved after the scan, and the next scan follows the move`, `› does not write back a file renamed with its title line after the scan, and keeps its item`, `› keeps the edit of a file moved and edited after the scan, and makes no second item`, `› writes back none of a burst of files moved and deleted after the scan`, `device/binding-folders-clock.test.ts › writes back no file moved between a watch pass's scan and its pull, and follows the move on the next pass`.

### `folder-files/delete-path-reused`

When another item takes a deleted file's path, a device MUST retain the original item's journaled deletion.

**Tests:** `device/folders-placement.test.ts › keeps a person's journaled delete when another item is placed at its path`.

### `folder-files/delete-left-by-state`

When a locally deleted item leaves the folder query by state during the grace, a device MUST send its deletion after the grace.

**Tests:** `device/folders-identity.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folder-files/delete-already-trashed`

When a locally deleted item is already trashed, a device MUST NOT send another item deletion.

**Tests:** `device/folders-identity.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folder-files/delete-at-startup`

When a tracked file is absent at startup, a device MUST journal its deletion as it would a file removed while running.

**Tests:** `device/folders-placement.test.ts › journals a delete that happened while it was not running`.

### `folder-files/root-gone-no-delete`

While the folder directory is missing or replaced by another directory, a device MUST NOT trash its items because the original files cannot be read.

**Tests:** `device/folders-identity.test.ts › trashes nothing while its directory is gone, and says so`, `device/folders-identity.test.ts › reads, writes and trashes nothing in a copy put in its directory's place`.

### `folder-files/root-gone-watch`

While the folder directory is missing, the CLI MUST report that the directory cannot be found.

**Tests:** `device/folders-identity.test.ts › trashes nothing while its directory is gone, and says so`.

### `folder-files/root-gone-watch-continues`

While the folder directory is missing, the CLI MUST keep the watch running.

**Tests:** `device/folders-identity.test.ts › trashes nothing while its directory is gone, and says so`.

### `folder-files/root-return-watch`

When the folder directory returns, a device MUST resume the running watch's work.

**Tests:** `device/folders-identity.test.ts › trashes nothing while its directory is gone, and says so`.

### `folder-files/root-no-recreate`

When the root directory disappears during a pull, a device MUST NOT recreate it.

**Tests:** `device/folders-identity.test.ts › does not make its directory anew when it goes away during a pull`.

### `folder-files/root-write-count`

When the root directory disappears before a file write, a device MUST count the blocked write `unwritten`.

**Tests:** `device/folders-identity.test.ts › does not make its directory anew when it goes away during a pull`.

### `folder-files/walk-directory-gone`

When a directory disappears during the walk, a device MUST report it in `directories` with flag `gone`.

**Tests:** `device/folders-identity.test.ts › journals no missing file in a pass a directory went away from while it was walked`.

### `folder-files/walk-gone-no-journal`

When a folder inventory is incomplete because an entry cannot be read or identified, a device MUST NOT journal missing files from that incomplete inventory.

**Tests:** `device/folders-identity.test.ts › journals no missing file in a pass a directory went away from while it was walked`.

### `folder-files/root-gone-scan-report`

When a scan detects that the directory has been replaced since the folder was opened, a device MUST report the reason in `root_gone`.

**Tests:** `device/folders-contract-a.test.ts › reports root_gone and ignores a replacement directory while watching`.

### `folder-files/root-gone-no-replacement-edit`

While the opened folder's directory is replaced by a different directory, a device MUST NOT send item or settings edits read from that replacement.

**Tests:** `device/folders-contract-a.test.ts › reports root_gone and ignores a replacement directory while watching`.

### `folder-files/root-gone-no-replacement-write`

While the opened folder's directory is replaced by a different directory, a device MUST leave the replacement's files unchanged.

**Tests:** `device/folders-contract-a.test.ts › reports root_gone and ignores a replacement directory while watching`.

### `folder-files/root-gone-pull-report`

When a pull detects that the root directory disappeared or was replaced after the folder was opened, a device MUST report the reason in `root_gone`.

**Tests:** `device/binding-folders-placement.test.ts › reports root_gone when a retained folder's directory is replaced before its pull`.

### `folder-files/root-gone-command-refusal`

When the folder directory is missing, the CLI MUST refuse `folders status`, `folders confirm`, and `folders restore` with the reason.

**Tests:** `device/folders-contract-a.test.ts › refuses status and removal decisions while the folder directory is missing`.

### `folder-files/walk-gone-no-deletion`

When a folder inventory is incomplete because an entry cannot be read or identified, a device MUST defer already journaled item deletions until a complete walk succeeds.

**Tests:** `device/folders-contract-a.test.ts › sends no journaled deletion from an incomplete walk and resumes after a complete walk`, `device/folders-one-mac.test.ts › holds cross-directory moves and older deletions behind an unidentified %s`.

### `folder-files/walk-prior-directory-removal`

When a directory was deleted before a walk began, a device MUST journal its tracked files as missing.

**Tests:** `device/folders-contract-a.test.ts › journals files from a directory removed before the walk begins`.

### `folder-files/delete-trashed-status`

When a locally missing file's item has already been trashed elsewhere, the CLI MUST report that file as waiting on `scan` rather than `delete`.

**Tests:** `device/folders-contract-a.test.ts › reports a locally missing item already trashed elsewhere as waiting on scan`.

### `folder-files/delete-missing-not-pull-removal`

When a pull encounters files already deleted locally, a device MUST exclude those absent files from its `removed` and `kept` counts.

**Tests:** `device/folders-contract-a.test.ts › reports a locally missing item already trashed elsewhere as waiting on scan`.

### `folder-files/purged-file-remove`

When a catch-up has applied an item's purge, its file's path remains admitted, its bytes remain those the device wrote, and no large-removal pause applies (`folder-guards/pull-removal-paused`), a device MUST remove that file at the next pull where the filesystem permits removal.

**Tests:** `device/folders-identity.test.ts › removes a purged item's file where its bytes are the folder's own, and says so`.

### `folder-files/purged-file-count`

When a pull removes a purged item's file, a device MUST count that file in both `removed` and `purged`.

**Tests:** `device/folders-identity.test.ts › removes a purged item's file where its bytes are the folder's own, and says so`.

### `folder-files/purged-edit-preserve`

When a purged item's file has changed since the device last wrote it, a device MUST preserve that file during a pull.

**Tests:** `device/folders-identity.test.ts › keeps a purged item's file the person changed since the folder wrote it, and says so`.

### `folder-files/purged-edit-count`

When a pull preserves a purged item's changed file, a device MUST count that file as `kept`.

**Tests:** `device/folders-identity.test.ts › keeps a purged item's file the person changed since the folder wrote it, and says so`.

### `folder-files/purged-removal-report`

When `folders pull` or `folders watch` reports removed files, the CLI MUST distinguish files removed because their items were purged from files removed because their items were trashed or left by state.

**Tests:** `device/folders-identity.test.ts › says in words that a purged item's file was removed`, `device/folders-identity.test.ts › says while watching that a purged item's file was removed`.

## Paths, links and files

### `folder-files/placement-root-relative`

When a device reads a folder placement path, a device MUST resolve the path from the folder root after discarding leading separators, empty components and `.` components.

**Tests:** `device/folders-placement.test.ts › reads a placement path with a leading separator from the folder's root`.

### `folder-files/parent-component-refused`

When a folder placement contains a `..` component, a device MUST report the item as `outside` even when the path would return inside the folder.

**Tests:** `device/folders-contract-b.test.ts › refuses every parent component in a placement even when it climbs back inside`.

### `folder-files/parent-component-refused-file-unwritten`

When a folder placement contains a `..` component, a device MUST NOT write the item’s file even when the path would return inside the folder.

**Tests:** `device/folders-contract-b.test.ts › refuses every parent component in a placement even when it climbs back inside`.

### `folder-files/symlink-write-refused`

When a folder placement traverses a symbolic link, a device MUST report the item as `outside`.

**Tests:** `device/folders.test.ts › refuses to write a file outside the folder`.

### `folder-files/symlink-write-refused-target-preserved`

When a folder placement traverses a symbolic link, a device MUST NOT write through the link.

**Tests:** `device/folders.test.ts › refuses to write a file outside the folder`.

### `folder-files/symlink-scan-excluded`

When a folder scan encounters a symbolic link to a file or directory, a device MUST NOT admit that link.

**Tests:** `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`.

### `folder-files/symlink-not-traversed`

When a folder scan encounters a symbolic link to a file or directory, a device MUST NOT traverse the link’s target.

**Tests:** `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`.

### `folder-files/body-link-removal`

When a folder document removes a body link it previously carried and no frontmatter reference still names that item, a device MUST queue deletion of the corresponding `references` edge.

**Tests:** `device/folders.test.ts › takes the edge with a link the body no longer names`.

### `folder-files/unseen-reference-kept`

When a folder document is scanned before a `references` edge has ever appeared in its file, a device MUST NOT delete that edge because the file does not name it.

**Tests:** `device/folders.test.ts › keeps an edge the file never carried, whoever made it`.

### `folder-files/other-edge-kind-kept`

When a folder document removes a body link, a device MUST NOT delete an edge of a kind other than `references` merely because it connects the same items.

**Tests:** `device/folders.test.ts › keeps an edge of a kind it could not have made`.

### `folder-files/unresolved-removals-held`

While a folder document contains an unresolved body link, a device MUST defer every `references` edge removal from that document.

**Tests:** `device/folders.test.ts › removes no edge at all when a link in the body names nothing`, `device/folders-frontmatter.test.ts › reports missing body links and preserves removals until all links resolve`.

### `folder-files/deferred-removals-retried`

When every remaining body link in a folder document resolves after reference removals were deferred, a device MUST queue the deferred removals.

**Tests:** `device/folders.test.ts › removes no edge at all when a link in the body names nothing`, `device/folders.test.ts › remembers a link it stood down over, so a later removal still lands`, `device/folders-frontmatter.test.ts › reports missing body links and preserves removals until all links resolve`.

### `folder-files/body-reference-not-repeated`

When a folder pull renders a `references` edge already represented by a body link, a device MUST NOT repeat that reference in frontmatter.

**Tests:** `device/folders.test.ts › takes the edge with a link the body no longer names`.

### `folder-files/unowned-path-preserved`

When a folder pull encounters a file at an item’s placement whose bytes it cannot adopt as that unbound item’s rendered bytes, a device MUST leave the file untouched.

**Tests:** `device/folders.test.ts › does not write over a file it never wrote`.

### `folder-files/unowned-path-preserved-unwritten-count`

When a folder pull encounters a file at an item’s placement whose bytes it cannot adopt as that unbound item’s rendered bytes, a device MUST report the item as `unwritten`.

**Tests:** `device/folders.test.ts › does not write over a file it never wrote`.

### `folder-files/rendered-file-adopted`

When an unbound folder item’s placement already holds exactly its rendered bytes, a device MUST bind the existing file to that item.

**Tests:** `device/folders.test.ts › takes back a file of its own the mapping had lost`, `device/folders-placement.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders-placement.test.ts › takes back an empty text file rendered from a missing body`.

### `folder-files/rendered-file-adopted-bytes-unchanged`

When an unbound folder item’s placement already holds exactly its rendered bytes, a device MUST NOT rewrite the existing file.

**Tests:** `device/folders.test.ts › takes back a file of its own the mapping had lost`, `device/folders-placement.test.ts › takes back the files it holds by placement and bytes when it is added again over them`, `device/folders-placement.test.ts › takes back an empty text file rendered from a missing body`.

### `folder-files/unowned-file-admitted`

When a folder scan encounters an unbound file whose bytes differ from the item that wanted its path, a device MUST admit the file as a new item.

**Tests:** `device/folders.test.ts › does not write over a file it never wrote`.

### `folder-files/same-scan-link-resolution`

When files arriving in the same folder scan name one another in links or frontmatter edge lines, a device MUST resolve those names against all files admitted by that scan.

**Tests:** `device/folders.test.ts › makes an edge between two files that arrive together`.

### `folder-files/new-search-member`

When an item starts matching a folder’s query through a tag, property, state, edge or `beneath` change received by the copy, a device MUST write its file at the next pull.

**Tests:** `device/folders.test.ts › adds an item that starts to match`.

### `folder-files/departed-file-removed`

When an item is trashed or leaves the states held by a folder's query, its file is not held by a document that embeds it or that it is attached to (`folder-documents/embed-held`), its path remains admitted, its bytes remain those the device wrote, or those it found before it first wrote the file that are exactly what it would write for the item at the version line and state the file shows and whose frontmatter holds no comment, no second YAML document and no empty property the item does not hold, and no large-removal pause applies (`folder-guards/pull-removal-paused`), a device MUST remove that file at the next pull where the filesystem permits removal, except a file kept under `folder-files/new-file-outside-state-kept`.

**Reason:** A folder added over files an earlier copy wrote binds them without writing them, at the version line and state they were written at, which differ from the item's once the item changes in something no file shows or leaves the folder by its state. A render over a file keeps the file's comments, any YAML document after the first, empty properties and formatting, so a found file can match a render and still hold something the person added. A comment, a second document or an empty property is something the item does not hold, so a file with one is kept. Formatting alone, such as quoting, key order or spacing, is not told apart from the earlier copy's own: it can be lost when such a file is removed, while its values go to the bin with the item. A change to a file the device wrote is the person's, even a reformatting that a render would keep.

**Tests:** `device/folders-identity.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item that leaves by state`, `device/folders-identity.test.ts › removes the file of an item put in the bin that it found as its item renders, and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item put in the bin that it found as its item renders at an older version line, and brings it back on restore`, `device/folders-identity.test.ts › keeps the file of an item put in the bin that it found as its item renders with a comment the person added`, `device/folders-identity.test.ts › keeps the file of an item put in the bin that it found as its item renders with an empty property the person added`.

### `folder-files/departed-binding-released`

When a folder pull removes a departed item’s file, a device MUST release the file’s binding.

**Tests:** `device/folders-identity.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item that leaves by state`.

### `folder-files/departed-item-not-deleted`

When a folder pull removes a departed item’s file, a device MUST NOT queue deletion of the item.

**Tests:** `device/folders-identity.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item that leaves by state`.

### `folder-files/restored-file-written`

When a trashed item is restored into a folder’s query, a device MUST write its file at the next pull.

**Tests:** `device/folders-identity.test.ts › removes a trashed item's file and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item put in the bin that it found as its item renders, and brings it back on restore`, `device/folders-identity.test.ts › removes the file of an item put in the bin that it found as its item renders at an older version line, and brings it back on restore`.

### `folder-files/missing-departure-not-pulled`

When a departed folder item’s file is already missing from disk, a device MUST leave its deletion for the scan rather than count it as removed by the pull.

**Tests:** `device/folders-identity.test.ts › sends a person's journaled delete of an item that leaves by state, and none for one trashed elsewhere`.

### `folder-files/returned-file-journal-cleared`

When a folder pull removes a departed item’s file that returned after its deletion was journaled, a device MUST clear that journal entry.

**Tests:** `device/folders-identity.test.ts › takes away a file put back after its delete was journaled, once its item leaves by state, and sends no delete`.

### `folder-files/returned-item-not-deleted`

When a folder pull removes a departed item’s file that returned after its deletion was journaled, a device MUST NOT queue deletion of the item.

**Tests:** `device/folders-identity.test.ts › takes away a file put back after its delete was journaled, once its item leaves by state, and sends no delete`.

### `folder-files/departed-edited-file-kept`

When a departed folder item’s file contains bytes changed since the folder wrote it, a device MUST preserve the file.

**Tests:** `device/folders-identity.test.ts › keeps a file the person changed after its item left, and says so`, `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folder-files/departed-edited-file-kept-kept-count`

When a departed folder item’s file contains bytes changed since the folder wrote it, a device MUST count the file as `kept`.

**Tests:** `device/folders-identity.test.ts › keeps a file the person changed after its item left, and says so`, `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folder-files/departed-unreadable-file`

When a folder pull cannot read a departed item’s file to verify its bytes, a device MUST preserve the file.

**Tests:** `device/folders-identity.test.ts › holds the file of an item that leaves by state where it cannot be read, and does not call it kept`.

### `folder-files/departed-unreadable-file-unwritten-count`

When a folder pull cannot read a departed item’s file to verify its bytes, a device MUST count the item as `unwritten` rather than `kept`.

**Tests:** `device/folders-identity.test.ts › holds the file of an item that leaves by state where it cannot be read, and does not call it kept`.

### `folder-files/unmatched-file-kept`

When an item leaves a folder’s query for a reason other than its state or purge and no other folder takes its file, a device MUST retain the bound file.

**Tests:** `device/folders-identity.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders-identity.test.ts › keeps the file of an item a narrowed query leaves out, flagged, and sends its edits to it`, `device/folders-identity.test.ts › keeps the file of an item retyped out of its query elsewhere, flagged, and sends its edits to it`.

### `folder-files/unmatched-same-folder-kept`

When an item leaves a folder's query for a reason other than its state or purge and another registered directory that follows the same `system.folder` holds a file of the item, a device MUST retain the bound file unless a registered directory that follows another `system.folder` takes it.

**Reason:** A directory that follows the same folder is a second copy of it, with the same query, which it may not have read yet, so its file of the item is not the file taken by another folder (`folder-files/unmatched-file-kept`). Taking the kept file away is the person's to confirm (`folder-guards/unmatched-remove-file`). A directory whose store cannot be read is not known to follow another folder, so the file stays.

**Tests:** `device/folders-one-mac.test.ts › keeps a file as unmatched in both directories of one folder when its query narrows`, `› keeps a file as unmatched when its query narrows while the other directory of the folder cannot be read, and once it can`.

### `folder-files/new-file-outside-state-kept`

When a device creates an item from a new file of a folder, whether a document or a file's bytes, the state of the item at creation (the file's `state` line, or active where it has none) is not one of the states held by the folder's query, and no pull has since found the item in a state the query holds with no write to the item waiting to be sent (a queued write the server has not answered, or one that is blocked or dead, but not a refused one), a device MUST retain the file at every pull, whether its bytes are those the device wrote or not, unless the item is trashed or purged.

**Reason:** The item never entered the folder, so it did not leave it. After the create, the server can answer the create before the state change that follows it, which shows the item active for a moment. An item that leaves the query's states after being found in them is an existing member and still leaves with its file. The record ends at the first pull that finds the item in a held state with nothing waiting to be sent, whether the person edited the `state` line, another device changed the state, or the query changed to hold it, and when the item is unbound, trashed or purged. A copy that does not hold the item, as while a replaced store fills again, ends nothing, since it cannot say where the item stands. A rename of the file, or another device following the folder, changes nothing: the record belongs to the item, and a device that never wrote the file has nothing to remove.

**Tests:** `device/folders-identity.test.ts › keeps a new file whose state the query does not hold, and counts it unmatched`, `device/folders-identity.test.ts › keeps the file made for a file item outside the query's states`.

### `folder-files/new-file-outside-state-unmatched`

When a device retains a file under `folder-files/new-file-outside-state-kept`, a device MUST count the file as `unmatched` at each pull.

**Tests:** `device/folders-identity.test.ts › keeps a new file whose state the query does not hold, and counts it unmatched`, `device/folders-identity.test.ts › keeps the file made for a file item outside the query's states`.

### `folder-files/new-file-outside-state-not-rewritten`

When a device retains a file under `folder-files/new-file-outside-state-kept`, a device MUST NOT rewrite the file's bytes while the item is outside the query's states or has a write waiting to be sent.

**Reason:** The server answers a create before the state change that follows it, so the copy can show the item active for a moment. Rewriting then would drop the file's `state` line, and a later edit of the file would read as a move back to active.

**Tests:** `device/folders-identity.test.ts › keeps a new file whose state the query does not hold, and counts it unmatched`, `device/folders-identity.test.ts › keeps a new file whose item waits to be told its state, as the person wrote it, and does not rewrite it`.

### `folder-files/new-file-outside-state-removable`

When removal of unmatched files names a file retained under `folder-files/new-file-outside-state-kept`, a device MUST remove it as it removes any unmatched file, while its bytes are those the device last read or wrote and no write to its item waits, and end the record of the item.

**Reason:** The bytes of such a file are the person's, which the device never wrote, so the bytes it last read stand for what it wrote. The item keeps them.

**Tests:** `device/folders-unmatched.test.ts › takes away a new file whose item the query's states do not hold, as it takes any, and ends its record`.

### `folder-files/unmatched-file-kept-unmatched-count`

When an item leaves a folder’s query for a reason other than its state or purge and no other folder takes its file, a device MUST count the file as `unmatched`.

**Tests:** `device/folders-identity.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders-identity.test.ts › keeps the file of an item a narrowed query leaves out, flagged, and sends its edits to it`, `device/folders-identity.test.ts › keeps the file of an item retyped out of its query elsewhere, flagged, and sends its edits to it`.

### `folder-files/unmatched-file-edits`

When a bound folder file’s item no longer matches the query, a device MUST continue sending edits to that item.

**Tests:** `device/folders-identity.test.ts › keeps a file whose item no longer matches, flagged`, `device/folders-identity.test.ts › keeps the file of an item a narrowed query leaves out, flagged, and sends its edits to it`, `device/folders-identity.test.ts › keeps the file of an item retyped out of its query elsewhere, flagged, and sends its edits to it`.

### `folder-files/unmatched-file-updated`

When a bound unmatched folder item changes, a device MUST keep its existing file current under the same preservation rules as a query member’s file.

**Tests:** `device/folders-identity.test.ts › keeps an unmatched file current, so its second edit keeps another device's change`.

### `folder-files/replaced-binding-unpinned`

When another item takes a bound folder file’s path, a device MUST release the old item’s binding pin unless another file or edge still requires it.

**Tests:** `device/folders-identity.test.ts › lets go of the pin of an item whose file's path another item takes`.

### `folder-files/embedded-archive-kept`

When an embedded or attached file item becomes archived outside the folder’s query, a device MUST keep its file while a document in the folder still embeds it or it is still attached to one.

**Tests:** `device/folders-frontmatter.test.ts › sends an embedded file with its file`, `device/folders-frontmatter.test.ts › keeps an embedded file archived elsewhere where its query holds active items only`, `› is kept archived elsewhere while its document is held, where the query holds active items only`.

### `folder-files/binary-created`

When a nonempty non-document file is admitted by a folder’s query or an embed, a device MUST create a file item typed from its MIME type, or `core.file` where the held catalog holds no type for it, whose create waits for the bytes’ upload.

**Tests:** `device/folders-placement.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`, `device/folders-frontmatter.test.ts › sends an embedded file with its file`.

### `folder-files/binary-webpage`

When a nonempty file at an `.html`, `.htm` or `.xhtml` name, in any letter case, is admitted by a folder's query or an embed and the held catalog holds `core.file.webpage`, a device MUST create a file item of type `core.file.webpage`.

**Reason:** an agent that writes a page into a folder Marfa follows expects the page kept as a page, with no step of its own to type it.

**Tests:** `device/folders-placement.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`.

### `folder-files/binary-edited`

When the bytes of a bound file item change in a folder, a device MUST queue an upload followed by an item update naming the new bytes regardless of the file’s extension.

**Tests:** `device/folders-placement.test.ts › pushes a file that is not a document as a file item, its bytes uploaded first`, `device/folders-placement.test.ts › sends an edited file item named like a document as bytes`.

### `folder-files/binary-title-preserved`

When a bound folder file item is renamed and its title differs from its old file name, a device MUST retain the item’s title.

**Tests:** `device/folders-placement.test.ts › keeps a title somebody set when the file moves`.

### `folder-files/blob-file-written`

When a folder pull can obtain a file item’s bytes, a device MUST write those bytes as the file.

**Tests:** `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`.

### `folder-files/blob-absent`

When a folder pull cannot obtain a file item’s bytes for an environmental or local read failure, a device MUST report the item as `absent`.

**Tests:** `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders-placement.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folder-files/blob-absent-no-placeholder`

When a folder pull cannot obtain a file item’s bytes for an environmental or local read failure, a device MUST NOT write a placeholder file.

**Tests:** `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders-placement.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folder-files/blob-retry`

When a later folder pull can obtain bytes previously reported as absent, a device MUST retry writing the file.

**Tests:** `device/folders-placement.test.ts › writes a file item's bytes as its file, and reports them absent where it cannot fetch them`, `device/folders-placement.test.ts › keeps the file of an item whose new bytes cannot be had`, `device/folders-placement.test.ts › counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give`.

### `folder-files/old-blob-file-kept`

When a folder pull cannot obtain a file item’s changed bytes, a device MUST preserve the previous file’s bytes.

**Tests:** `device/folders-placement.test.ts › keeps the file of an item whose new bytes cannot be had`.

### `folder-files/blob-credential-refused`

When the server refuses the credential while a folder pull fetches file bytes, a device MUST fail the pull rather than count each file as absent.

**Tests:** `device/folders-placement.test.ts › ends a pull whose credential is refused, rather than counting each file absent`.

### `folder-files/blob-cache-released`

When a folder file holds its item’s bytes and no pending upload needs them, a device MUST release any duplicate copy of those bytes kept beside the working copy.

**Tests:** `device/folders-placement.test.ts › keeps no copy beside the store of bytes its file holds, and fetches them again when asked`.

### `folder-files/nonfile-blob-document`

When an item outside the file types carries `blob_ref`, a device MUST render it as a document rather than writing the referenced blob as its file.

**Tests:** `device/folders-placement.test.ts › writes an item carrying a blob_ref outside the file types as a document`.

### `folder-files/lost-item-file-kept`

When a folder file’s create is refused and the copy loses the item, a device MUST preserve the person’s file.

**Tests:** `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folder-files/lost-item-edit-retried`

When the person changes or moves a folder file whose item the copy no longer holds, a device MUST queue the file as a new item under a new device-minted ID.

**Tests:** `device/folders-identity.test.ts › queues a file whose item the copy lost again once it changes, and says so`, `device/folders-identity.test.ts › queues a file whose item the copy lost again once it moves`.

### `folder-files/lost-item-unchanged-held`

While a folder file whose item the copy no longer holds stays unchanged at its path, a device MUST report the file as lost.

**Tests:** `device/folders-identity.test.ts › queues a file whose item the copy lost again once it changes, and says so`, `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`, `device/folders.test.ts › pulls again after a rebuild at the drain after the pull, writing what the new reach holds and keeping a file it no longer reads`.

### `folder-files/lost-create-not-repeated`

While a folder file whose item the copy no longer holds stays unchanged at its path, a device MUST NOT queue another create.

**Tests:** `device/folders-identity.test.ts › queues a file whose item the copy lost again once it changes, and says so`, `device/folders-identity.test.ts › keeps a file the folder never wrote whose create was refused, inside one push`.

### `folder-files/lost-item-binding-ownership`

When a live file has taken a lost file’s former path, a device MUST preserve the live file’s binding.

**Tests:** `device/folders-identity.test.ts › keeps a live file's binding when it takes a lost file's old name`, `device/folders-identity.test.ts › keeps a live file's binding when it takes a lost file's old name, across a push`.

### `folder-files/lost-file-requeued`

When a live file has taken a lost file’s former path, a device MUST requeue the lost file as a new item.

**Tests:** `device/folders-identity.test.ts › keeps a live file's binding when it takes a lost file's old name`, `device/folders-identity.test.ts › keeps a live file's binding when it takes a lost file's old name, across a push`.

### `folder-files/lost-item-watch-notice`

While a folder file stays bound to an item the copy no longer holds, the CLI MUST say its lost-item watch notice only once.

**Tests:** `device/folders-identity.test.ts › says in words when a file is bound to an item that is gone, once while watching`.

### `folder-files/own-conflict-file-kept`

When a folder save conflicts with the same device’s earlier save, a device MUST preserve the file’s newer bytes rather than overwrite them with the item’s earlier value.

**Tests:** `device/folders-placement.test.ts › keeps a file whose newest save conflicted with its own earlier one, and sends it again`.

### `folder-files/own-conflict-retried`

When a folder file’s newer save was set aside against the same device’s earlier save, a device MUST submit the retained bytes at the next scan as an edit based on the item’s current version.

**Tests:** `device/folders-placement.test.ts › keeps a file whose newest save conflicted with its own earlier one, and sends it again`.

## Folder roots, linked paths and directory capability

### `folder-files/admitted-directory-capability`

When a folder directory is admitted, a device MUST retain that opened directory as the authority for traversal, reads, writes, publication, storage, and cleanup until the operation ends.

**Reason:** A pathname can name a replacement directory after admission.

**Tests:** `device/folders-contract-a.test.ts › ignores a replacement installed at %s`, `device/folders-contract-a.test.ts › leaves replacement state untouched when the root changes before its store opens`, `device/folders-contract-a.test.ts › ignores replacement settings installed immediately before their read`, `device/folders-contract-a.test.ts › leaves every replacement byte intact at %s`.

### `folder-files/directory-components-no-follow`

When opening a folder or any directory below it, a device MUST refuse a symbolic link at the folder's own directory entry, in every path component below it, and in every path component that a later `..` climbs back out of.

**Tests:** `device/folders-one-mac.test.ts › admits parent components without skipping a preceding symlink`, `device/folders-one-mac.test.ts › refuses a folder reached through a symlink and preserves its registry identity`, `device/folders-contract-b.test.ts › does not scan a symlinked file or directory even when included`, `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses a folder named through a link that a later parent component climbs back out of`.

### `folder-files/root-linked-ancestor-resolved`

When a folder is added through a path in which every symbolic link is a directory above the folder that no later `..` climbs back out of, and every directory that a `..` climbs back out of exists, a device MUST admit the folder at the path with those links resolved.

**Reason:** The directories above a folder are outside it and belong to the person, and the operating system links some of them, such as `/var` and `/tmp` on macOS.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`.

### `folder-files/linked-path-reaches-folder`

When a command other than an add or a removal names an existing folder by a path that the machine’s folder registry does not list, in which every symbolic link is a directory above the folder that no later `..` climbs back out of, every directory that a `..` climbs back out of exists, and no listed folder path reaches the same directory only through a symbolic link, a device MUST work the folder at the path with those links resolved.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`.

### `folder-files/ambiguous-path-refused`

If a command other than an add or a removal names a folder by a path that the machine’s folder registry does not list, and a listed folder path reaches the same directory only through a symbolic link, then a device MUST refuse the path with `invalid`.

**Reason:** The path could mean the folder at that directory or the listed folder whose directory the link replaced.

**Tests:** `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`.

### `folder-files/listed-link-refused`

If a symbolic link now stands in the path at which the machine’s folder registry lists a folder, then a device MUST refuse every command other than an add or a removal that names the folder by that path with `invalid`.

**Tests:** `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`.

### `folder-files/listed-link-refusal-names-other`

If a device refuses a path because a symbolic link now stands in the path at which the machine’s folder registry lists a folder, and that listed path now leads to the directory of another listed folder, then a device MUST name the other folder's listed path in the refusal's message.

**Reason:** The person can then tell that the directory the link leads to holds another folder, not the one the path names.

**Tests:** `cli/folder.test.ts › refuses every other spelling of a listed folder whose directory became a link, and removes nothing it leads to`, `cli/folder.test.ts › names the listed folder a link has replaced, and the other folder it leads to, when refusing its path`.

### `folder-files/listed-link-refusal-no-redirect`

If a device refuses a path because the path's own directory entry, or one that a later `..` climbs back out of, is a symbolic link, and a path at which the machine’s folder registry lists a folder reaches some directory only through a symbolic link, then a device MUST NOT give that directory, or a directory inside it, in the refusal's message as the one to name instead.

**Reason:** Where a link has replaced the listed folder's directory or a directory above it, the listed path, and any link or chain of links the person made to it or to a directory inside it, can lead to another folder's directory. A person following the advice would then work on that folder, such as by removing its state.

**Tests:** `cli/folder.test.ts › names the listed folder a link has replaced, and the other folder it leads to, when refusing its path`, `cli/folder.test.ts › never offers the directory a relinked listing now leads to when refusing a link to that listing`, `cli/folder.test.ts › never offers a folder inside the directory a relinked listing now leads to when refusing a link into that listing`.

### `folder-files/root-link-refused-invalid`

If a folder is named through a path with a symbolic link at the folder's own directory entry, in a path component below it, or in a path component that a later `..` climbs back out of, other than to remove the folder by the path at which the machine’s folder registry lists it, then a device MUST refuse the path with `invalid`.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses a folder named through a link that a later parent component climbs back out of`.

### `folder-files/root-link-refusal-named`

If a folder is named through a path with a symbolic link at the folder's own directory entry, in a path component below it, or in a path component that a later `..` climbs back out of, other than to remove the folder by the path at which the machine’s folder registry lists it, and no earlier `..` climbs back out of a directory that does not exist, then a device MUST name the first such link in the refusal's message.

**Tests:** `cli/folder.test.ts › adds a folder named through a linked directory where it resolves, and follows no link inside it`, `cli/folder.test.ts › refuses a folder named through a link that a later parent component climbs back out of`.

### `folder-files/root-missing-climb-refused`

If a folder is named through a path in which a `..` climbs back out of a directory that does not exist, then a device MUST refuse the path with `invalid`.

**Reason:** Such a path cannot be checked without creating the directory it climbs out of.

**Tests:** `cli/folder.test.ts › refuses a path that climbs out of a directory that does not exist, and makes nothing`.

### `folder-files/root-missing-climb-creates-nothing`

If a folder is named through a path in which a `..` climbs back out of a directory that does not exist, then a device MUST NOT create any directory on that path.

**Tests:** `cli/folder.test.ts › refuses a path that climbs out of a directory that does not exist, and makes nothing`.

### `folder-files/replacement-root-no-deletion`

While the admitted root or its state directory is absent or replaced, a device MUST suppress missing-file and deletion conclusions.

**Tests:** `device/folders-contract-a.test.ts › ignores a replacement installed at %s`, `device/folders-contract-a.test.ts › reports root_gone and ignores a replacement directory while watching`.

### `folder-files/cleanup-retains-empty-directories`

When a folder's removal deletes its administrative state, a device MUST clear the state's files through retained directories without removing the directory entries themselves.

**Reason:** Checking a child's identity and then removing its pathname cannot atomically exclude a replacement child. Empty administrative directories retain no folder state.

**Tests:** `device/folders-contract-a.test.ts › leaves every replacement byte intact at %s`, `device/folders.test.ts › is canceled by removing the folder, which leaves its files`.

### `folder-files/empty-state-not-nested-folder`

When a directory contains an empty `.marfa` directory without `core.sqlite`, a device MUST admit its eligible contents as ordinary folder contents.

**Tests:** `device/folders-contract-a.test.ts › admits contents beside empty administrative directories`.

### `folder-files/root-birth-identity-required`

When a folder root has no usable nonzero birth timestamp, a device MUST refuse admission before creating administrative state.

**Reason:** Reopening an entry by device and inode alone cannot exclude inode reuse after the original descriptor closes.

**Tests:** `device/folders-contract-a.test.ts › refuses a root with %s birth identity before creating administrative state`.

## Executable files, permissions and quarantine

### `folder-files/executable-created`

When a folder admits a file item on a volume preserving executable permissions, a device MUST set `executable: true` if its owner can execute it and omit the property otherwise.

**Tests:** `device/folders.test.ts › keeps a file's executable permission`, `compliance/types.test.ts › declares executable on core.file, which every file type inherits`.

### `folder-files/executable-updated`

When a bound file’s executable permission changes on a volume preserving permissions, a device MUST queue an update carrying the new `executable` value even if the file’s bytes do not change.

**Tests:** `device/folders.test.ts › keeps a file's executable permission`.

### `folder-files/executable-pulled`

Where a device has established that the volume preserves executable permissions and the filesystem permits the change, when a folder pull writes a file item or updates an unchanged scanned file's permission, a device MUST apply the item's executable value by adding execute bits wherever read bits are set or clearing all execute bits after any quarantine marking required by `folder-files/quarantine-download` or `folder-files/quarantine-in-place` succeeds.

**Tests:** `device/folders.test.ts › gives a pulled file the permission its item holds`, `device/folders-contract-b.test.ts › applies execute bits only where each read bit is set`.

### `folder-files/executable-owner-edit-kept`

When a bound file’s executable permission changes after the folder scan read it, a device MUST preserve the person’s permission through a pull for the next scan to send.

**Tests:** `device/folders.test.ts › gives a pulled file the permission its item holds`.

### `folder-files/permission-probe-failed`

Where a volume does not preserve executable permissions or the folder cannot establish that it does, a device MUST leave executable permissions unchanged on the item.

**Tests:** `device/folders-contract-b.test.ts › leaves executable permissions alone when its permission probe fails`, `device/folders-contract-b.test.ts › leaves file and item executable values alone on an exFAT volume`.

### `folder-files/permission-probe-failed-file-preserved`

Where a volume does not preserve executable permissions or the folder cannot establish that it does, a device MUST leave executable permissions unchanged on the file.

**Tests:** `device/folders-contract-b.test.ts › leaves executable permissions alone when its permission probe fails`, `device/folders-contract-b.test.ts › leaves file and item executable values alone on an exFAT volume`.

### `folder-files/permission-write-refused`

When the filesystem refuses a folder pull’s executable-permission change, a device MUST leave the file’s permissions as they are.

**Tests:** `device/folders-contract-b.test.ts › keeps a file's permissions when a permission change is refused and continues pulling`.

### `folder-files/permission-write-refused-pull-continues`

When the filesystem refuses a folder pull’s executable-permission change, a device MUST continue pulling other files.

**Tests:** `device/folders-contract-b.test.ts › keeps a file's permissions when a permission change is refused and continues pulling`.

### `folder-files/quarantine-in-place`

Where a device runs on macOS, when a folder pull makes an existing file runnable, a device MUST apply quarantine before enabling execution.

**Tests:** `device/folders-identity.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

### `folder-files/quarantine-failure-new-file`

Where a device runs on macOS, when quarantine marking fails for downloaded file bytes, a device MUST refuse to publish the file.

**Tests:** `device/folders-contract-b.test.ts › refuses a new downloaded file when quarantine marking fails and retries it`.

### `folder-files/quarantine-failure-unwritten`

Where a device runs on macOS, when quarantine marking fails for downloaded file bytes, a device MUST count the file as `unwritten`.

**Tests:** `device/folders-contract-b.test.ts › refuses a new downloaded file when quarantine marking fails and retries it`.

### `folder-files/quarantine-failure-existing-file`

Where a device runs on macOS, when quarantine marking fails before making an existing folder file runnable, a device MUST retain the file’s existing permissions.

**Tests:** `device/folders-contract-b.test.ts › keeps an existing file nonexecutable when quarantine marking fails`.

### `folder-files/quarantine-download`

Where a device runs on macOS, when a folder pull writes a file item from server bytes, a device MUST apply `com.apple.quarantine` before the file lands.

**Tests:** `device/folders-identity.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

### `folder-files/document-not-quarantined`

Where a device runs on macOS, when a folder pull renders a document, a device MUST NOT mark the document with download quarantine.

**Tests:** `device/folders-identity.test.ts › gives each file a pull writes from the server's bytes the quarantine mark on macOS`.

## Moved and missing files

### `folder-files/saved-back-binding`

When a file is saved back at a path whose binding remains after another folder took its file, a device MUST treat it as the bound item until that binding is released.

**Tests:** `device/folders-one-mac.test.ts › keeps a file saved back where another folder took the item's file from as the item's while its binding lasts`.

### `folder-files/moved-file-not-trashed`

When a missing folder file is found in another registered folder as the same file by identity, carried ID or unambiguous bytes, a device MUST release the missing file’s binding, unless `folder-files/moved-binding-kept` keeps it.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › finds a file moved into a dot-led directory the other folder includes`, `device/folders-one-mac.test.ts › follows a move by copy and delete, by id and by bytes`, `device/folders-one-mac.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders-one-mac.test.ts › does not trash a file moved to another folder and saved there anew`, `device/folders-one-mac.test.ts › does not trash an unmatched file moved by copy and delete into a folder that holds its item`, `device/folders-one-mac.test.ts › follows identical files moved by identity, and makes identical copies new items`, `device/folders-one-mac.test.ts › takes a file item at a document name moved to another folder as that item, and trashes it only where no folder holds it`, `device/folders-one-mac.test.ts › keeps one item when a file item both folders hold moves between them and the %s folder scans first`.

### `folder-files/moved-file-not-trashed-item-preserved`

When a missing folder file is found in another registered folder as the same file by identity, carried ID or unambiguous bytes, a device MUST NOT trash the item.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › finds a file moved into a dot-led directory the other folder includes`, `device/folders-one-mac.test.ts › follows a move by copy and delete, by id and by bytes`, `device/folders-one-mac.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders-one-mac.test.ts › does not trash a file moved to another folder and saved there anew`, `device/folders-one-mac.test.ts › does not trash an unmatched file moved by copy and delete into a folder that holds its item`, `device/folders-one-mac.test.ts › follows identical files moved by identity, and makes identical copies new items`, `device/folders-one-mac.test.ts › takes a file item at a document name moved to another folder as that item, and trashes it only where no folder holds it`, `device/folders-one-mac.test.ts › keeps one item when a file item both folders hold moves between them and the %s folder scans first`.

### `folder-files/moved-file-count`

When a scan releases a missing folder file’s binding because it found the file in another registered folder, a device MUST count the file as `moved_away`.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › follows a move by copy and delete, by id and by bytes`, `device/folders-one-mac.test.ts › takes a file item at a document name moved to another folder as that item, and trashes it only where no folder holds it`, `device/folders-one-mac.test.ts › keeps one item when a file item both folders hold moves between them and the %s folder scans first`.

### `folder-files/moved-carried-id-utf16`

When a file in another registered folder starts with a UTF-16 byte-order mark, or with a frontmatter fence encoded as UTF-16 and no mark, a device MUST read the file's carried ID as UTF-16 text.

**Reason:** An editor that saves a moved file again as UTF-16 changes both its identity and its bytes, so its carried ID is all that shows where it came from. Read as UTF-8, the move is taken for a deletion and the item is deleted on the server.

**Tests:** `device/folders-one-mac.test.ts › keeps a file moved to another folder and saved again as UTF-16`.

### `folder-files/peer-owned-bytes-not-move`

When another folder’s equal bytes belong to a different item, a device MUST NOT identify that file as the missing file’s move.

**Tests:** `device/folders-one-mac.test.ts › does not take another folder's file with the same bytes for a moved one`.

### `folder-files/both-folders-copy`

When two folder queries both hold an item and each folder has its own bound file, a device MUST NOT interpret either file as the other’s move.

**Tests:** `device/folders-one-mac.test.ts › tells a copy into another folder from a move`.

### `folder-files/missing-file-trashed`

When a missing folder file’s deletion grace expires, no other folder holds the moved file, no other file present in the same folder is bound to its item and `folder-files/missing-file-changed-revives` does not restore the file, a device MUST queue deletion of its item.

**Reason:** the files of one sweep are decided before any of them is trashed, so files deleted together are all trashed, whichever the sweep reaches first and whether they link one another. A link line in a file shows the note it names by title, and a note already trashed by the same sweep would otherwise read as a change made elsewhere.

**Tests:** `device/folders-one-mac.test.ts › trashes a missing file found in no folder on the Mac, and says so`, `device/folders-one-mac.test.ts › takes a file item at a document name moved to another folder as that item, and trashes it only where no folder holds it`, `device/folders-one-mac.test.ts › trashes an unchanged file item's missing file from a scan with no server, whose bytes it no longer holds`, `device/folders-placement.test.ts › keeps the item when %s cuts off another Mac's move after the rename`.

### `folder-files/missing-file-trashed-path-reported`

When a missing folder file’s deletion grace expires, no other folder holds the moved file, no other file present in the same folder is bound to its item and `folder-files/missing-file-changed-revives` does not restore the file, a device MUST name the path in the scan report’s `trashed`.

**Tests:** `device/folders-one-mac.test.ts › trashes a missing file found in no folder on the Mac, and says so`, `device/folders-one-mac.test.ts › takes a file item at a document name moved to another folder as that item, and trashes it only where no folder holds it`, `device/folders-one-mac.test.ts › trashes an unchanged file item's missing file from a scan with no server, whose bytes it no longer holds`.

### `folder-files/missing-file-changed-revives`

When a device finds a missing folder file in no other registered folder past its rename grace, or on confirming its paused removal, and another device has changed the file's item in content the file showed while the folder's query still holds the item, a device MUST restore the file from the changed item.

**Reason:** The change is newer than the person's deletion, which no other device has heard of yet, so it wins as it does inside the grace (`folder-files/delete-remote-revives`). A pull writes no file back while its move cannot be told (`folder-files/uncertain-move-no-replacement`), so a change made inside the grace may show only once the move is told. The device tells the change from its working copy alone, with no server and no held bytes, so a scan that reaches no server decides it too: a file item by whether its item still names the blob the folder last wrote or sent the file as, and a document by whether its item still shows what the folder last agreed. It decides on everything it read of the item, its version, tags and edges, and queues the deletion only while the working copy still holds exactly that, so a change heard while it decides is decided again rather than trashed with it.

**Tests:** `device/folders-one-mac.test.ts › writes back a file deleted while another folder could not be read, once that folder holds no copy, when another device changed its item inside the grace`, `device/folders-one-mac.test.ts › trashes no item of a confirmed removal that another device changed since its file went, and writes the file back`.

### `folder-files/missing-file-said`

When a missing folder file is trashed after no other folder holds it, the CLI MUST say that no folder on the machine holds the file.

**Tests:** `device/folders-one-mac.test.ts › trashes a missing file found in no folder on the Mac, and says so`.

### `folder-files/uncertain-move-deferred`

When a missing folder file could be in unreadable registered folders or several files elsewhere have its bytes, a device MUST defer its deletion.

**Tests:** `device/folders-one-mac.test.ts › holds a delete where several files in another folder have its bytes`, `device/folders-one-mac.test.ts › holds a delete while another folder cannot be read whole`, `device/folders-one-mac.test.ts › keeps an unreadable file moved to another folder before its next scan`, `device/folders-one-mac.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

### `folder-files/uncertain-move-deferred-unsure-reported`

When a missing folder file could be in unreadable registered folders or several files elsewhere have its bytes, a device MUST name the uncertainty in `unsure`.

**Tests:** `device/folders-one-mac.test.ts › holds a delete where several files in another folder have its bytes`, `device/folders-one-mac.test.ts › holds a delete while another folder cannot be read whole`, `device/folders-one-mac.test.ts › keeps an unreadable file moved to another folder before its next scan`, `device/folders-one-mac.test.ts › holds a delete while the registry cannot be read, and an add writes it afresh`.

### `folder-files/uncertain-move-no-replacement`

While a missing folder file could be in unreadable registered folders or among several files elsewhere with its bytes, a device MUST NOT write the file again.

**Reason:** written again here, the moved file would read as a copy there and become a new item. Within the rename grace, the grace sweep then tells a move from a deletion (`folder-files/uncertain-move-deferred`, `folder-files/missing-file-trashed`), and a pass looks for the file again (`folder-files/kept-file-looked-again`). A file found nowhere whose item changed elsewhere comes back then (`folder-files/missing-file-changed-revives`).

**Tests:** `device/folders-one-mac.test.ts › writes no file back for a held delete when another device changes its item`, `device/folders-one-mac.test.ts › writes back no file moved to a folder it cannot read when another device changes its item inside the grace`.

### `folder-files/kept-file-looked-again`

While a folder watch keeps a missing folder file's binding past the rename grace because it cannot tell where the file went, or because another folder has yet to take it, a device MUST look for the file in the other registered folders again no later than one minute after its last look, whatever the folder's full-pass interval.

**Reason:** a delete or a move whose direction was uncertain waited for the next full pass, which is ten minutes by default. Looking walks every other registered folder, so a quick pass looks only once a minute and a watch at rest wakes for it then, where a look at every pass would walk them each time.

**Tests:** `device/binding-folders-clock.test.ts › decides a delete it could not tell from a move in a quick pass once the registry can be read, with no full pass`.

### `folder-files/uncertain-move-not-text`

When another registered folder holds a file whose bytes can be read but are not UTF-8, a device MUST treat that folder's inventory as complete.

**Reason:** The file is held on its own (`folder-documents/unreadable-no-write`), so it is no doubt about where another folder's missing file went, and a deletion of a missing file that waited on it would wait for as long as the file stays.

**Tests:** `device/folders-one-mac.test.ts › confirms a large removal while another folder holds files that are not text`, `device/folders-one-mac.test.ts › holds a file that is not text on its own, and takes it in once it can be read`.

### `folder-files/moved-arrival-bytes`

When a file that carries no ID arrives from another folder whose missing-file binding of a file item uniquely identifies it by identity or bytes, a device MUST bind the arriving file to that file item.

**Reason:** a file item's file carries nothing that names its item, so only the other folder's binding can, whatever the file's name. A pull can place a file item at a document name (`.md`, `.markdown` or `.txt`).

**Tests:** `device/folders-one-mac.test.ts › takes a file item at a document name moved to another folder as that item, and trashes it only where no folder holds it`.

### `folder-files/moved-arrival-text-note`

When a file at a name other than `.md` or `.markdown` (in any letter case) arrives from another folder whose missing-file binding of a note uniquely identifies it by identity, or by the bytes of a note's file that was at a name other than `.md` or `.markdown`, a device MUST bind the arriving file to that note.

**Reason:** a note at a `.txt` name carries no ID line, so only its identity or its bytes follow it.

**Tests:** `device/folders-one-mac.test.ts › takes a file moved in by copy and delete by the bytes the folder it left bound`, `device/folders-one-mac.test.ts › follows identical files moved by identity, and makes identical copies new items`.

### `folder-files/moved-arrival-markdown-new`

When a file at a `.md` or `.markdown` name (in any letter case) that carries no ID arrives from another folder, where the file it left was a note bound by identity or bytes or a new note whose ID line was never written, a device MUST admit the arriving file as a new item.

**Reason:** a note's Markdown file carries its ID line, so a Markdown file without one is not that note's file. A `.txt` note moved to another folder as `.md` is a new item there. A new note moved before its ID line is written has no item bound to it, and the folder it left cannot name an item the arriving file belongs to, so the receiving folder admits it with every edit made before and after the move. What the folder it left does with the original item is stated apart (`folder-files/moved-new-note-original-trashed`, `folder-files/moved-new-note-original-written-back`). Every way tried to bind a file that has no ID line yet opened a worse failure than this second item.

**Tests:** `device/folders-one-mac.test.ts › makes a new item of a text note moved to another folder as Markdown, and keeps its words`, `device/folders-one-mac.test.ts › makes a second item of a new note moved before its id line is written, and keeps its edits`.

### `folder-files/moved-new-note-original-trashed`

When a folder has sent a new note as an item but has not written the file's ID line, the file moves to another registered folder, the folder it left finds the file in no folder past its deletion grace, and the item, rendered, holds nothing the file did not show, a device MUST queue deletion of the item in the folder it left.

**Reason:** the receiving folder admits the moved file as a new item (`folder-files/moved-arrival-markdown-new`), and no file carries the original's ID line except the receiving folder's own write of it, so the missing file is a deletion of what it showed (`folder-files/missing-file-trashed`). The original's words are in the new item. A file that begins with a header showing the properties the item holds, such as its `title`, shows all of it.

**Tests:** `cli/folder.test.ts › trashes the original item of a new note moved to another folder before its ID line, where the file showed what the item holds`.

### `folder-files/moved-new-note-original-written-back`

When a folder has sent a new note as an item but has not written the file's ID line, the file moves to another registered folder, the folder it left finds the file in no folder, and the item, rendered, holds a property the file did not show, a device MUST write the item's file again in the folder it left.

**Reason:** the receiving folder admits the moved file as a new item (`folder-files/moved-arrival-markdown-new`), so the missing file is read as the file of an item that holds more than it showed (`folder-files/missing-file-changed-revives`), not as a deletion of what the file showed. A file with a heading or plain text shows no `title`, and the item holds one the folder took from the file. Both folders then hold both items, each with the words it was sent with.

**Tests:** `cli/folder.test.ts › writes back the original item of a new note moved to another folder before its ID line, where the file showed less than the item holds (%s)`.

### `folder-files/moved-file-item-bytes`

When a file item's missing folder file has unambiguous bytes in a file that carries no ID in another registered folder, a device MUST identify that file as the missing file's move, whatever either file's name.

**Reason:** the folder that file is in takes it as the file item by those bytes (`folder-files/moved-arrival-bytes`), so a delete would trash the item that folder now holds. A note's missing Markdown file is still found only by its identity or its ID line.

**Tests:** `device/folders-one-mac.test.ts › takes a file item at a document name moved to another folder as that item, and trashes it only where no folder holds it`.

### `folder-files/moved-binding-kept`

While a missing folder file is found in another registered folder in a file that carries no ID and that folder would take as the item, that folder’s lists take it, it has not bound it, and it has no file of the item, a device MUST keep the missing file’s binding.

**Reason:** the other folder knows a file that carries no ID as the item only by this binding (`folder-files/moved-arrival-bytes`, `folder-files/moved-arrival-text-note`). Released before that folder scans, the binding cannot name the item there, and a folder whose query still holds the item writes its file again, so the moved file becomes a new item. A Markdown file without an ID line is a new item there (`folder-files/moved-arrival-markdown-new`), so its binding is not kept.

**Tests:** `device/folders-one-mac.test.ts › keeps one item when a file item both folders hold moves between them and the %s folder scans first`, `device/folders-one-mac.test.ts › follows a move by copy and delete, by id and by bytes`.

### `folder-files/moved-awaiting-peer`

While a scan keeps a missing folder file’s binding under `folder-files/moved-binding-kept`, a pull leaves a missing folder file unwritten under `folder-files/moved-not-revived`, or another registered folder holds a file that carries the ID of an item this folder has not bound and that folder has not bound the file, a device MUST count the item as `elsewhere`.

**Reason:** a watch pulls at every pass while an item counts as `elsewhere`, so past the rename grace it reads where the scan found the missing file instead of looking in the other folders itself. A quick pass keeps the last scan’s finding until a minute has passed since the last look, and a full pass looks again, so a watch releases the binding within a minute of the other folder binding the file, whatever the folder's full-pass interval (`folder-files/kept-file-looked-again`).

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › keeps one item when a file item both folders hold moves between them and the %s folder scans first`, `device/folders-one-mac.test.ts › follows a move by copy and delete, by id and by bytes`, `device/folders-one-mac.test.ts › makes no second item when another device changes a moved file's item inside the grace`.

### `folder-files/moved-awaiting-peer-no-replacement`

While a scan keeps a missing folder file’s binding under `folder-files/moved-binding-kept`, or another registered folder holds a file that carries the ID of an item this folder has not bound and that folder has not bound the file, a device MUST NOT write a replacement file.

**Reason:** written anew, the file would make the moved file read as a copy in the other folder.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › keeps one item when a file item both folders hold moves between them and the %s folder scans first`.

### `folder-files/moved-not-revived`

While a missing folder file is found in another registered folder, by its identity, by the ID it carries or as the one file there with its bytes, a device MUST NOT write the missing file again from another device's change.

**Reason:** written again, the file makes the moved file read as a copy in the folder it went to, which then admits it as a second item (`folder-files/cross-folder-copy`). The change still reaches the item, since the moved file merges it once that folder binds it. A file whose folders both hold its item, each with its own file, is not a move (`folder-files/item-in-folders-delete`), and is written back under `folder-files/delete-remote-revives`.

**Tests:** `device/folders-one-mac.test.ts › makes no second item when another device changes a moved file's item inside the grace`.

### `folder-files/move-keeps-item`

When a file bound to an item moves to another registered folder and that folder binds no other file to the item, a device MUST bind the moved file to that item, whether or not the receiving folder's query holds it, except where `folder-files/moved-arrival-markdown-new` or `folder-files/cross-folder-hidden-item` admits the file as a new item.

**Reason:** the person moved a file, not the note it carries. The folder the file left trashes the item only once no registered folder holds the file (`folder-files/missing-file-trashed`). A file whose ID is still in a file left in the first folder is a copy (`folder-files/cross-folder-copy`) and is not a move. An item the server will not show to the receiving folder cannot be bound there, so its file is a new item (`folder-files/cross-folder-hidden-item`).

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › keeps one item, and every edit made before and after the move, of a bound file moved to another folder`, `device/folders-one-mac.test.ts › tells a copy into another folder from a move`.

### `folder-files/move-no-second-item`

When a file bound to an item moves to another registered folder, a device MUST NOT admit the moved file as a new item, unless the receiving folder binds another file to the item, or `folder-files/moved-arrival-markdown-new` or `folder-files/cross-folder-hidden-item` admits it.

**Reason:** a second item would hold the person's words twice and leave the first to be trashed with the edits made since. A receiving folder that binds another file to the item holds a copy (`folder-files/cross-folder-copy`). A Markdown file that carries no ID line is no note's file, and its words are kept in the new item. An item the server will not show to the receiving folder is not there to hold the words, so the file becomes a new item.

**Tests:** `device/folders-one-mac.test.ts › keeps one item, and every edit made before and after the move, of a bound file moved to another folder`, `device/folders-one-mac.test.ts › makes no second item when another device changes a moved file's item inside the grace`.

### `folder-files/move-keeps-edits`

When a file bound to an item moves to another registered folder and the moved file stays bound to that item, a device MUST deliver to the item every edit made to the file before the move and every edit made to it after.

**Reason:** an edit read before the move reaches the item whether the move came before or after the scan that read it, and the receiving folder reads the edits made after. An edit the folder it left had queued and not yet sent is sent beside the receiving folder's own read of the same words from the same version, so the server keeps the later send as a conflicted copy of the item with the same words. No edit is lost, and the move itself makes no item. Where the moved file becomes a new item instead (`folder-files/moved-arrival-markdown-new`, `folder-files/cross-folder-hidden-item`), the edits go to the new item.

**Tests:** `device/folders-one-mac.test.ts › keeps one item, and every edit made before and after the move, of a bound file moved to another folder`, `device/folders-one-mac.test.ts › keeps an edit already queued in the folder a bound file left, and makes no item for the move`.

## Another folder's files

### `folder-files/cross-folder-copy`

When a file’s ID already appears in another folder and the receiving folder already binds that item or its query excludes the item, a device MUST admit the arriving file as a new item.

**Tests:** `device/folders-one-mac.test.ts › tells a copy into another folder from a move`.

### `folder-files/cross-folder-member-adopted`

When a file arrives with an ID held by the receiving folder’s query and that folder has no file for the item, a device MUST bind the arriving file to the existing item.

**Tests:** `device/folders-one-mac.test.ts › takes a copy into a folder that holds the item and has no file of it as the item's file`.

### `folder-files/cross-folder-item-read`

When a file arrives with an ID held only by another folder’s copy and no file elsewhere still carries it, a device MUST read and pin the item from the server before binding it as the same item.

**Tests:** `device/folders-one-mac.test.ts › does not trash a file moved to another folder`, `device/folders-one-mac.test.ts › gives a fresh id to a moved file whose item the server will not show, and pins one it shows`, `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folder-files/cross-folder-hidden-item`

When the server will not show the item named by a moved file’s ID, a device MUST admit the file as a new item.

**Tests:** `device/folders-one-mac.test.ts › gives a fresh id to a moved file whose item the server will not show, and pins one it shows`.

## Taking in another folder’s file

### `folder-files/copy-holds-bound`

Where a folder's copy has a query, a device MUST hold every item that a file of the folder is bound to, whether or not the query takes the item.

**Reason:** a scan of another folder on the same machine tells a file moved from this folder by whether this folder's copy holds the file's item.

**Tests:** `device/folders-copy-shrink.test.ts › keeps an item a file is bound to when an event takes it out of the query`, `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folder-files/narrowed-arrival-read`

Where a folder's copy has a query, when a scan finds a file whose `marfa_id` names an item the copy does not hold and the server holds that item for the folder's key, a device MUST send the file as an edit of that item, not as a new item.

**Reason:** a narrowed copy leaves out items the folder does not show, so a file restored from a backup, copied from another Mac or moved from a folder that is not registered can name an item the server holds. A new item would duplicate it under another id.

**Tests:** `device/folders-copy-shrink.test.ts › sends the file as an edit of the item its id names, not as a new item`, `› sends the same file as an edit from a copy that is not narrowed`.

### `folder-files/narrowed-arrival-read-batched`

Where a folder's copy has a query, when a scan finds several files whose `marfa_id` names an item the copy does not hold, a device MUST read those items together, at most 100 ids to each bulk read by id.

**Reason:** a folder restored from a backup can hold thousands of such files, and a read for each would make a pass as slow as thousands of requests in a row.

**Tests:** `device/folders-copy-shrink.test.ts › reads the ids a pass names together and asks again only once a file changes`.

### `folder-files/narrowed-arrival-read-once`

Where a folder's copy has a query, when the server has answered that it shows no item a file's `marfa_id` names, a device MUST NOT read that item again for the file until the file's bytes or its `marfa_id` change.

**Reason:** a file that waits unbound, held by the addition threshold say, is met by every pass, and reading its item again each time would repeat a request whose answer has not changed.

**Tests:** `device/folders-copy-shrink.test.ts › reads the ids a pass names together and asks again only once a file changes`.

### `folder-files/take-in-file`

When another registered folder no longer holds an item for a non-state reason and still holds only its own written file bytes, and the receiving folder’s query holds that item without a file, a device MUST take that file into its placement.

**Tests:** `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folder-files/take-in-file-taken-count`

When another registered folder no longer holds an item for a non-state reason and still holds only its own written file bytes, and the receiving folder’s query holds that item without a file, a device MUST count the file as `taken`.

**Tests:** `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folder-files/moved-unmatched-taken-back`

When a file moves into a registered folder whose query does not hold its item for a reason other than the item's state, the file is unchanged since the folder it left wrote it, and the query of the folder it left holds the item, a device MUST take the file back into the folder it left once the rename grace has passed.

**Reason:** the person moved a file, not the note, and the receiving folder keeps the file as `unmatched` (`folder-files/unmatched-file-kept`), so the item would show in no folder it belongs to. The folder it left holds the item without a file and takes the file as it takes one another folder let go (`folder-files/take-in-file`), so the item stays one item at one version, and trashes nothing (`folder-files/move-keeps-item`). A folder whose query leaves the item out by its state keeps the file, as it keeps a file of an item that left it by its state (`folder-files/take-in-file`).

**Tests:** `cli/folder.test.ts › takes a note's file back into the folder it left, and says so, when the folder it was moved into does not hold the note`, `cli/folder.test.ts › leaves a note's file in the folder it was moved into when that folder's query leaves the note out by its state`.

### `folder-files/moved-unmatched-taken-back-count`

When a device takes a file back into the folder it left under `folder-files/moved-unmatched-taken-back`, a device MUST count the file as `taken` in the pull report of that folder.

**Tests:** `cli/folder.test.ts › takes a note's file back into the folder it left, and says so, when the folder it was moved into does not hold the note`.

### `folder-files/take-in-edited-source-kept`

When another folder’s let-go file was edited since that folder last read it, a device MUST leave the source file for its own folder to send.

**Tests:** `device/folders-one-mac.test.ts › does not take in a let-go file edited since its folder last read it`.

### `folder-files/take-in-state-excluded`

When an item left another folder by state, a device MUST NOT take in that folder’s file as a non-state departure.

**Tests:** `device/folders-one-mac.test.ts › does not take in the file of an item that left its folder by state`.

### `folder-files/take-in-same-folder-excluded`

When a folder's query holds an item without a file, a device MUST NOT take in the file of the item that another registered directory following the same `system.folder` holds.

**Reason:** That directory's query is this folder's, perhaps not yet read there, so its file is its own copy of the item and was never let go. The folder writes a file of its own.

**Tests:** `device/folders-one-mac.test.ts › writes its own file, and takes none from the other directory of the folder, when a widened query brings an item back`.

### `folder-files/take-in-attachment-excluded`

When a document in another registered folder embeds an item or has it attached, that folder has a file of the document, and that folder's query still holds the document or the receiving folder's query does not, a device MUST NOT take in that folder's file of the item.

**Reason:** the file is the document's attachment there, whatever folder holds the item on its own, so taking it in would take it from beside its document.

**Tests:** `device/folders-one-mac.test.ts › keeps a file %s a note while another folder on the Mac holds the file, and writes nothing again`.

### `folder-files/take-in-attachment-with-document`

When a document moves from another registered folder's query into a folder's query, and the other folder has a file of an item the document embeds or has attached, a device MUST take in that file for the folder the document moved to, as it takes in the document's own file.

**Reason:** the other folder no longer writes the file once its document leaves, so a file written anew instead would leave the other folder's copy unmatched for good.

**Tests:** `device/folders-one-mac.test.ts › moves a note's attachment with the note to another notes folder when %s hears first`.

### `folder-files/take-in-destination-kept`

When a file appears at the destination before a move-in lands, a device MUST preserve the destination file.

**Tests:** `device/folders-one-mac.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folder-files/take-in-destination-kept-unwritten-count`

When a file appears at the destination before a move-in lands, a device MUST report the refused placement as `unwritten`.

**Tests:** `device/folders-one-mac.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folder-files/take-in-refused-source-kept`

When a move-in cannot land because its destination became occupied, a device MUST retain the source file at its original path.

**Tests:** `device/folders-one-mac.test.ts › keeps both files when a destination appears just before a move-in (%s)`.

### `folder-files/take-in-binding-kept`

When a move-in is refused because its destination became occupied, a device MUST preserve the destination’s previous binding through that pull’s departure cleanup.

**Tests:** `device/folders-one-mac.test.ts › keeps both files when a destination appears just before a move-in (%s)`, `device/folders-one-mac.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folder-files/take-in-journal-ownership`

When a folder adopts matching destination bytes or takes in another folder’s file, a device MUST clear the arriving item’s journal entry.

**Tests:** `device/folders-one-mac.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folder-files/take-in-previous-journal-kept`

When a folder adopts matching destination bytes or takes in another folder’s file, a device MUST preserve any previous owner’s deletion journal entry.

**Tests:** `device/folders-one-mac.test.ts › preserves ownership for an identical move destination ($mode, previous binding $previous)`.

### `folder-files/take-in-copy-fallback`

When a move-in fails across volumes or because a readable regular source has positively confirmed immutable protection, a device MUST try a copy with the same absent-target no-replace guarantee.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`, `device/folders-one-mac.test.ts › preserves a source across copy publication failures (%s)`.

### `folder-files/take-in-denial-no-fallback`

When a move-in fails with an ordinary permission denial and immutable protection is not confirmed, a device MUST refuse the move rather than copy the source.

**Tests:** `device/folders-one-mac.test.ts › refuses an ordinary source removal denial instead of copying`.

### `folder-files/take-in-copy-metadata`

When a move-in uses a copy, a device MUST preserve the source’s permissions and applicable extended attributes, including Finder tags and quarantine.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/take-in-copy-refusal`

When a move-in copy cannot preserve an attribute, verify the complete bytes or confirm unchanged regular-file identity before publication, a device MUST refuse publication.

**Tests:** `device/folders-one-mac.test.ts › preserves a source across copy publication failures (%s)`.

### `folder-files/take-in-copy-refusal-source-preserved`

When a move-in copy cannot preserve an attribute, verify the complete bytes or confirm unchanged regular-file identity before publication, a device MUST preserve the source.

**Tests:** `device/folders-one-mac.test.ts › preserves a source across copy publication failures (%s)`.

### `folder-files/take-in-copy-source-protection`

When a move-in uses a copy because the source is immutable, a device MUST leave the source’s protection unchanged.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/take-in-destination-unprotected`

When a move-in uses a copy because the source is immutable, a device MUST NOT apply immutable protection to the destination.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/take-in-source-retained`

When a successful move-in copy cannot remove its source, a device MUST leave the source’s binding and journal intact.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/retained-source-reported`

When a copied source remains in its original folder because removal is denied, a device MUST retain the file’s unmatched status.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/retained-source-reported-unwritten-count`

When a copied source remains in its original folder because removal is denied, a device MUST report the file as `unwritten`.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/retained-source-reported-bytes-preserved`

When a copied source remains in its original folder because removal is denied, a device MUST NOT rewrite the file.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/retained-source-later-removal`

When removal of a retained copied source becomes possible and its identity and bytes still belong to the original folder, a device MUST remove the source.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/retained-source-item-preserved`

When removal of a retained copied source becomes possible and its identity and bytes still belong to the original folder, a device MUST NOT trash the item.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/retained-source-edit-kept`

When the person edits a retained copied source before its removal becomes possible, a device MUST preserve the edit for that source folder to send.

**Tests:** `device/folders-one-mac.test.ts › takes in a readable source and preserves denied-removal ownership ($mode, $later)`.

### `folder-files/let-go-existing-peer`

When another registered folder already holds its own file for an item this folder no longer holds, a device MUST remove this folder’s unchanged owned file.

**Tests:** `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folder-files/let-go-existing-peer-let-go-count`

When another registered folder already holds its own file for an item this folder no longer holds, a device MUST count this folder’s file as `let_go`.

**Tests:** `device/folders-one-mac.test.ts › takes in a file another folder let go`.

### `folder-files/let-go-attachment-kept`

While a document in a folder embeds an item or has it attached, a device MUST NOT let go of that folder's file of the item because another registered folder holds its own file for the item.

**Reason:** the pull that lets the file go writes it again beside its document, so every pull would remove and write the same file.

**Tests:** `device/folders-one-mac.test.ts › keeps a file %s a note while another folder on the Mac holds the file, and writes nothing again`.

### `folder-files/let-go-attachment-with-document`

When this folder no longer holds an item or any document the item is attached to, and another registered folder's query holds a document the item is attached to and that folder has its own file of the item, a device MUST remove this folder's unchanged owned file of the item and count it as `let_go`.

**Reason:** the other folder writes the file beside the document it holds, so a file kept here would stay unmatched for good.

**Tests:** `device/folders-one-mac.test.ts › moves a note's attachment with the note to another notes folder when %s hears first`.

### `folder-files/unmatched-missing-not-rewritten`

When a bound unmatched file is missing from disk, a device MUST leave the missing file for the scan’s deletion journal rather than recreate it during a pull.

**Tests:** `device/folders-contract-b.test.ts › does not count a missing unmatched file as put back when restoring a removal`.

### `folder-files/item-in-folders-editable`

When two folder queries hold one item, a device MUST keep each folder’s bound file editable through that folder’s own queue.

**Tests:** `device/folders-one-mac.test.ts › keeps two folders' files for one item editable`.

### `folder-files/item-in-folders-delete`

When the person deletes either of two files whose folders both hold the item, a device MUST trash the item after the deletion grace rather than treat the other folder’s file as a move.

**Tests:** `device/folders-one-mac.test.ts › keeps two folders' files for one item editable`, `device/folders-one-mac.test.ts › trashes a file item deleted where both folders hold it`.
