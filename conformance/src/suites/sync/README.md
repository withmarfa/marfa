# sync

The server's half of the sync contract, checked over HTTP.

A durable Marfa client keeps a local store, writes to it first and reconciles with the server afterwards. Some of the rules that make that safe are the client's to keep and some are the server's, and this project checks the server's. Two independent engines are being built to the same contract, so a server rule that quietly stops holding is a rule two engines then disagree about with nothing to say which is right.

Run it with `pnpm test:sync`, or as part of `pnpm test:conformance`.

## Why the probes read behavior rather than a status

**The server drops query keys it does not declare and answers 200.** Measured against a fifty-row listing: a key the server has never heard of returns the same fifty rows as no filter at all, and so does a filter parameter the server does not implement, while a filter it does implement returns zero rows for an impossible bound. Nothing in the status, the headers or the body separates "this filter matched everything" from "this filter does not exist".

So a status probe is a false-positive machine for every rule that turns on a query parameter. It reports `present` for a parameter that provably does nothing, the suite then runs the test, and the red that follows describes a missing feature as though it were a regression — a bisect through a server that never had the thing. **If you are about to simplify these probes into status checks: the check you want is already there as the control leg, and deleting the rest deletes the part that works.**

Three probes do read a status, and all three do it for the same narrow reason: the thing under test is a **refusal the server must produce**, not an acceptance it might silently drop.

- `stateAny` — `state` is a declared parameter with a closed set of values, so an unsupported value is refused rather than ignored. The control is a meaningless state, which proves the endpoint refuses at all.
- `renamedTimeFilters` — the rule _is_ that the old name is refused. A dropped parameter and a working one both answer 200, so 200 reads as `absent` either way and there is nothing for the silence to hide. The control is an undeclared key, and what it establishes depends on how the door answers it. See below.
- `idempotencyKeys` — a key names one request, so a key sent with a _different_ request is a caller bug and is refused with `422 idempotency_key_reused`. Only a server that read the key and stored a digest of the request against it can produce that refusal, which is what makes it the discriminator. See below.

### When a control cannot be a control

A nonsense-key control settles a question only on a door that ignores the key, and `renamedTimeFilters` is the shape worth recognizing.

The control exists to show that a 400 on `since` is about **that name** rather than about the endpoint refusing unknown input generally, and it can only show that where the door answers 200 to a key it has never heard of. A door that refuses every undeclared key refuses the control too, and a 400 on `since` is then the answer it gives any unknown name. A probe that required the control to answer 200 would throw against that door, and the throw is not local: the verdict is taken in `beforeAll`, so one broken premise takes every file that probes with it red at once.

**The probe reads the refusal rather than counting it.** The two refusals are different statements and each says which it is in `details`: the rename names what replaced the old filter (`renamed_from` / `use`), the general one names what it did not recognize (`unknown_parameters`). Neither the status nor the message can separate them — the general refusal lists every parameter the door accepts, `timestamp_after` among them, so a substring check reports the rename against a server that has never heard of it.

**The ignoring door is covered rather than replaced.** A door that still ignores undeclared keys is checked as before, because a refusal of `since` there can only be about that name. Which branch runs is decided by the control's own status, so one probe covers both doors and neither is a special case.

### The three answers on the idempotency door

**The door has three answers, not two.** A repeat under a key is _honored_ (answered from the store), _ignored_ (written again as a new row), or _reuse-refused_ (the key names a different request than the one it was minted for). A probe that allows only the first two — two creates under one key with deliberately **different** bodies, a repeated id read as proof the key was honored — throws against a server that refuses the reuse, which is to say against a server that implements the rule. The reasoning behind the different bodies is sound on its own terms: two _identical_ creates can collapse for reasons that have nothing to do with the key, so distinct bodies remove that confounder.

**The refusal is the thing to read.** It is not an obstacle to probing; it is the cleanest evidence available, because the confounders cannot reach it. A natural-key match and a content dedupe both collapse writes that are _the same_, and this refusal fires on writes that _differ_ — a keyless server has nothing to refuse. So the probe sends the different-bodied pair on purpose and reads the refusal as proof the key was read, then checks the replay half separately with a byte-identical repeat, which is what an offline queue actually resends. The old confounder returns with the identical pair, so a third leg sends the same content under a fresh key and requires a new row; if that collapses, the door dedupes on content and the probe throws rather than reporting a rule it could not see.

**A server that reads keys but does not refuse a reuse still reports `present`,** with the deviation named in the evidence. Whether the refusal is the _right_ behavior is a test's assertion, not a probe's verdict.

**The `Idempotency-Replayed` response header is asserted, and is not the probe's discriminator.** The server sends it on a replayed response and `idempotency.test.ts` asserts it. The probe decides on the reuse refusal, which alone separates the three answers the door can give, and records the header beside its verdict.

**Every probe is three-valued and the third value is a red.** A probe that cannot tell present from absent throws `IndeterminateProbe` rather than degrading to `absent`, because an `absent` it did not earn names the server for something the probe never managed to look at. An earned `absent` is a red too: `requireRule` fails the test that needs the rule and repeats the probe's evidence, because the referee has one target and every rule below is required of it.

Each probe carries a control that proves it discriminates. That is not ceremony: a probe reading the wrong key out of the listing envelope reports `absent` against every server, including one that implements the parameter, and the control is what turns that into a red about the probe rather than a permanent verdict about the server.

The probes run once per test file rather than once per run, because a vitest file gets its own module registry. The rows they create belong to whichever file wrote them and are torn down with it.

## The mapping

**Rules are cited by name, never by number.** A number here would be this file's own invention, and a reader could not resolve it back to anything.

### What the server guarantees

Every rule the server owes, and where it is checked. The probe column names the evidence carried for that rule; a rule with no probe is asserted directly.

| Rule                                               | Checked by                                                                                                                                                                                                                                                              | Probe                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A client names its own rows                        | `identity.test.ts` — item and edge, asserted on the event rather than on the create response; `acknowledged.test.ts` — a create resent under the same id is answered with the stored row and announces nothing                                                          | —                                                             |
| A write names the version it read                  | `edge-version.test.ts`; the item half is `correctness/item-versioning.test.ts`                                                                                                                                                                                          | `edgeVersion`                                                 |
| Fields that do not collide merge on their own      | `conflict.test.ts` — keep-both in one write. The 409 envelope and the merge itself are `correctness/merge-policy.test.ts`                                                                                                                                               | `serverSideMerge`                                             |
| An event is published after its write commits      | `post-commit.test.ts` — a write that fails inside the transaction announces nothing; `replay.test.ts` — a bulk write sent with fan-out off still reaches the log                                                                                                        | —                                                             |
| A replay is what a live subscriber would have seen | `replay.test.ts` (the type filter resolves the same subtree as the live stream; `Last-Event-ID` is honored); `stream-contract.test.ts` (the announced cursor resumes; a filtered stream still carries edges); `deletions.test.ts` (a cascaded edge delete, and a purge) | `announcedCursor`, `edgeEventsUnderFilter`, `itemPurgedEvent` |
| An aged-out cursor says so                         | `compliance/catchup-too-old.test.ts` for the terminal event; the re-import it demands needs every lifecycle state in one pass, which is `catchup.test.ts`                                                                                                               | `stateAny`                                                    |
| A modification time moves when the item changes    | `catchup.test.ts` (a tag write moves `updated_at`, and the same tag is read back through the boundary); `time-filters.test.ts` (the catch-up covers edges; a renamed filter is refused on the read door and on the bulk-action door)                                    | `updatedAfter`, `edgeUpdatedAfter`, `renamedTimeFilters`      |
| The type graph travels                             | `compliance/type-registry.test.ts`                                                                                                                                                                                                                                      | —                                                             |

### What a client keeps

Sixteen rules are a client's own, and the server can be asked about six of them — the other ten are properties of a local store and there is nothing to point an HTTP request at.

| Rule                                          | The server half, and where it is checked                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Ids are minted by the client                  | "A client names its own rows" above                                                                                                          |
| Events apply in log order, gated by version   | the payload has to carry a version to compare (`edge-version.test.ts`), and a rolled-back write must not produce one (`post-commit.test.ts`) |
| Hydration subscribes first, then reads        | the stream has to say where it starts (`stream-contract.test.ts`)                                                                            |
| A stale cursor means re-import, not reconnect | `compliance/catchup-too-old.test.ts`, and the `state=any` read in `catchup.test.ts`                                                          |
| The type graph is local                       | the registry payload, `compliance/type-registry.test.ts`                                                                                     |
| Blobs queue with their bytes                  | ordinary blob upload and download, `correctness/blob-correctness.test.ts`                                                                    |

### Idempotency keys, and the rule they are not

`idempotency.test.ts` covers an `Idempotency-Key` on the create and update doors: the key, the doors, the `Idempotency-Replayed` marker, the recorded 409, the reuse and in-flight refusals, the lease and the retention window. "The header is optional on all of them" is the caller's choice to send a key, not the server's choice to implement one, so a conforming target is not entitled to skip it.

The acknowledged repeat in `acknowledged.test.ts` is the other guarantee for a resent write. The two are easy to confuse and are not the same rule: one collapses a retry by a header the caller invents, the other by the row id the caller already minted.

## Documented gaps

A rule whose precondition cannot be constructed over HTTP is written up here rather than left as a `.todo`. The two are different things and the difference is worth keeping: a `.todo` means the harness is missing, and these mean the server offers no way to reach the state.

- **`ancestor_unavailable`, under "failures are classified, and the classification is closed".** The refusal fires when a three-way merge cannot find the base version's snapshot because the snapshot has been thinned. Thinning is a scheduled background job whose windows come from server configuration — a `recent_days` measured in days and a hard cap on the number of versions kept — and there is no route that runs it, no route that deletes a version snapshot, and no way for a client to make its own base version old. So the precondition is unreachable from outside the server whatever the suite does. The behavior is covered by the server's own tests under `packages/server`, against a store the test controls.
- **Retention beyond the event-log window, under "a stale cursor means re-import, not reconnect".** Deletions reach a client that was away either as an event inside the retention window or through the re-import prune beyond it. The window is server configuration measured in days, so the second path cannot be reached by a black-box run. The first is covered here; the prune is a client rule.
- **Blob eviction and the offline read cache, under "blobs queue with their bytes".** Entirely local to a client's store. The server has no half.

## What a new test owes

Everything in the repository's contributing rules, plus two that are specific here.

- **A control that fails when the observation would pass for the wrong reason.** Every assertion in this project is about a silence: a filter that matched everything, an event that never came, a stream that was not listening. Each of those has an innocent explanation, and a test that cannot rule the innocent explanation out is asserting nothing. Write the control first.
- **A wait is on a frame the server sends either way.** Every case here is about a frame that may never arrive, and waiting on that frame means the runner's budget expires and reports `Test timed out` — the file, and nothing else. Wait on the control the subscription delivers regardless, drain what follows, then assert, and the failure names what was missing in about a second.
- **An absence is settled by a later frame, never by a quiet window.** Half the assertions here are that some frame did _not_ arrive, and a fixed window cannot tell "nothing more is coming" from "not yet" — so it turns a busy target into a defect report, or worse, hides the frame it was looking for. Write a sentinel row after the one under test and wait for the sentinel's own event: the runner owns the deadline, and a sentinel that has arrived is proof that anything published ahead of it has arrived too. **The proof holds only between frames of the same kind**, because item events and edge events reach a subscriber through independent pipelines and their relative order is not a guarantee the stream makes. Two places have no sentinel available and say so where they sit: both ask whether edge frames reach a type-filtered stream at all, so a sentinel edge would be withheld by exactly the server they exist to catch.
- **No hand-rolled deadline.** A `while (cond && Date.now() < deadline)` followed by an assertion on `cond` takes the timeout away from the runner and re-emits it as a logic failure: no elapsed figure, no budget named, and the next reader studies a diff that is fine. Wait on the runner's budget, and pass `context.signal` into the stream helpers so an abort can name what it was waiting for.
