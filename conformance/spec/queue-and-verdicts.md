# The queue and its verdicts

A device does not write to the server directly. It writes to its working copy, queues the write, and drains the queue when it can. Every queued write is answered with one verdict from a closed set, and the verdict says what became of the write and what the device may do next.

`device.md` states the working copy the queue writes into. The server behavior a verdict is read from is `versions.md`, `items.md` and `errors.md`.

## The queue

1. The queue is persisted and ordered. A write survives the process that made it, and a drain sends writes in the order they were queued. `device/queue.test.ts › sends queued writes in the order they were queued`, `› keeps the queue across a restart`.
2. **Every write carries the version it read.** It is required on an update: an update queued without one is refused before it is sent, because a version-less update is a write that overwrites whatever it finds. It is optional on a create, and a create that carries one is conditional on it. `device/queue.test.ts › refuses an update queued with no version`, `› sends a create with the version it was based on`.
3. Every queued write carries an idempotency key, minted when the write is queued and never changed. A retry re-sends the same key, so a write whose answer the device never saw is answered from the server's record rather than written a second time. `device/queue.test.ts › retries under the key it was queued with, and is answered from the record rather than written twice`.
4. **A write waits for the write it depends on.** An update, a delete or an edge write naming a row whose create has not been answered is held rather than sent, because the server has no such row and would refuse it. `device/queue.test.ts › holds a write whose create has not been answered`.
5. A device sends `conflict=auto` on every update. It resolves nothing itself (`device.md` 19); the flag is how the server is asked to resolve within its own transaction rather than refusing and leaving two writes where one is atomic. `device/queue.test.ts › sends every update with the server asked to resolve`.
6. A drain reports the verdict of every write it sent, and the queue reports what it still holds with each row's verdict and reason. `device/queue.test.ts › reports a verdict for every write it sent`.

## The verdicts

7. Every answered write takes exactly one of six verdicts, and the set is closed: `accepted`, `merged`, `conflicted`, `refused`, `blocked`, `dead`. An answer a device cannot classify is a defect in the device, not a seventh verdict. `device/verdicts.test.ts › answers every write with one of the six verdicts`.
8. **`accepted`** — the server took the write and the row it returned is the row the device expected. The working copy adopts the returned row, including the version and the fields the server stamps. `device/verdicts.test.ts › accepted: adopts the row the server returned`.
9. **`merged`** — the server took the write and changed it. Either the row it returned differs from the one the device expected, or it reports a resolution that named no conflicted copy. The device adopts the returned row whole and does not send again; the difference is the merge, not a failure to apply. `device/verdicts.test.ts › merged: adopts the server's row when it differs from the one it expected`, `› merged: reports a resolution that named no conflicted copy`.
10. **`conflicted`** — the server took the write and wrote the losing value to a sibling of the same type tagged `conflicted-copy`, because the type's policy for that field is to keep both. The verdict names the sibling, which is the only place its id appears. The working copy adopts the returned row and holds the sibling as an ordinary item of the slice. `device/verdicts.test.ts › conflicted: names the sibling the server wrote`.
11. **`refused`** — the server refused the write for a reason no retry changes. The verdict carries the server's code verbatim. It is terminal: the write is not sent again, and the working copy is reconciled back to what the server holds. `device/verdicts.test.ts › refused: carries the server's code and is not sent again`.
12. **`blocked`** — the write has stopped until something outside the queue changes. It carries one reason from the closed set in the next section. It is not a failure and not counted toward the ceiling; the drain passes over it and the queue reports it. `device/verdicts.test.ts › blocked: is passed over by a drain and reported with its reason`.
13. **`dead`** — a failure that a retry could have cleared was answered the same way until the ceiling was reached. Terminal until the row is released. `device/verdicts.test.ts › dead: is terminal once the ceiling is reached`.
14. A verdict is reported, never acted on. A device meeting `conflicted`, `blocked` or `refused` does not write a resolution of its own; it reports the verdict, the server's envelope and the row it holds, and stops (`device.md` 19, 21). `device/verdicts.test.ts › reports a conflict rather than resolving it`.
15. A refused create refuses the writes that were waiting on it, and their reason names the write that was refused. Nothing that depended on a row the server never accepted is sent. `device/verdicts.test.ts › refuses the writes that were waiting on a create the server refused`.

## Which failures retry, and which do not

The split is the whole of the classification, and it is closed. A device that retries the wrong class either loops on a refusal it will always get or strands a good write behind a network that came back.

16. **An environmental failure retries without limit and is never counted.** A dropped connection, a refused connection, a read that timed out, any `5xx` and a `429` are statements about the environment rather than about the write, and every one of them clears without anybody doing anything. Counting them would strand a valid write behind an outage and then need a person to release it. `device/classification.test.ts › retries an environmental failure past the ceiling without counting it`, `› retries a 5xx and a 429 without counting them`.
17. **A contract failure does not retry.** A `400`, a `403` and a `404` are `refused` on the first answer, because the same request sent again is the same request. `device/classification.test.ts › refuses a contract failure on the first answer`.
18. **A `401` blocks the whole queue with the reason `credential_refused`.** It is the one refusal that looks environmental and is not: it clears only when a person replaces the credential. Every queued write carries the same credential, so every one of them parks together and the drain stops rather than working through a queue none of which can succeed. `device/classification.test.ts › blocks the whole queue on a refused credential, and stops the drain`.
19. **`422 idempotency_key_reused` blocks that write with the reason `key_spent`**, on the first refusal. The key has been answered for a different body, so it is the key that is spent rather than the write; retrying would spend the ceiling on refusals that are all the same refusal and then park the row under a reason naming the wrong cause. Re-sending the same key cannot clear it. `device/classification.test.ts › blocks a spent key on the first refusal rather than spending the ceiling`.
20. **`409 ancestor_unavailable` blocks that write with the reason `ancestor_unavailable`.** The server no longer holds a snapshot of the version the write names, so the same write re-sent is refused identically however often anyone sends it. The envelope carries the version the server does hold, and settling means rebasing on it — which is a new write, not this one. `device/classification.test.ts › blocks a write whose base version the server no longer holds`.
21. **`409 version_conflict` on a write already sent with the server asked to resolve blocks that write with the reason `conflict_unresolved`.** The server declined to resolve it, and a device may not resolve it either (`device.md` 21). `device/classification.test.ts › blocks a conflict the server declined to resolve`.
22. A write held for a dependency carries the reason `awaiting_dependency`, and it is released by the dependency being answered rather than by anything a caller does. `device/classification.test.ts › releases a held write when its dependency is answered`.
23. **The ceiling is five refusals, counted as refusals and not as attempts.** A device that could not ask has not been refused, so a week offline does not exhaust it. It is a number this contract fixes; it is not configuration. `device/classification.test.ts › counts refusals rather than attempts, so a long outage does not exhaust the ceiling`, `› reaches the ceiling on the fifth refusal`.
24. The blocked reasons are a closed set: `credential_refused`, `key_spent`, `ancestor_unavailable`, `conflict_unresolved`, `awaiting_dependency`. `device/classification.test.ts › reports one of the five blocked reasons and no other`.

## Offline, reconnect and re-hydration

25. A device that cannot reach the server queues writes and reports them as queued. Nothing is lost and nothing is retried in a loop that a caller has to stop. `device/queue.test.ts › queues writes while the server is unreachable`.
26. On reconnect the queue drains in order, and a write queued before the outage is answered before one queued during it. `device/queue.test.ts › drains in order on reconnect`.
27. **A re-hydration leaves the queue intact.** An aged-out cursor clears the working copy and pulls the slice again (`device.md` 16), and a queue cleared with it would silently drop writes a caller had been told were queued. `device/queue.test.ts › keeps the queue through a re-hydration`.
28. A row the device wrote and has not yet had answered is visible to a local read, and is reconciled to the server's row when the verdict arrives. `device/queue.test.ts › shows an unanswered local write to a local read`.

## What the real server cannot be made to produce

The list and the reason for each entry are in `device.md`; `device/fidelity.test.ts` checks every answer the real server can produce against the scripted server's.
