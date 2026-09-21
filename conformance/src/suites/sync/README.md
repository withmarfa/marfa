# sync

The server's half of the write contract, checked over HTTP.

A device keeps a local store, writes to it first and reconciles with the
server afterwards. Some of the rules that make that safe are the device's and
some are the server's; this project checks the server's. The device's are
`spec/device.md`, `spec/queue-and-verdicts.md` and `spec/folders.md`, asserted
by `src/suites/device/`.

Run it with `pnpm test:sync`, or as part of `pnpm test:conformance`.

## Why the probes read behavior rather than a status

**The server drops query keys it does not declare and answers 200.** A query
key it has never heard of returns the same rows as no filter at all, and so does a
filter parameter it does not implement, while a filter it does implement
returns zero rows for an impossible bound. Nothing in the status, the headers
or the body separates "this filter matched everything" from "this filter does
not exist". So a status probe is a false-positive machine for every rule that
turns on a query parameter: it reports `present` for a parameter that provably
does nothing, and the red that follows describes a missing feature as though
it were a regression.

Where a probe does read a status, the thing under test is a **refusal the
server must produce** rather than an acceptance it might silently drop.
`stateAny` is the clean case, and `capabilities.ts` says so at the probe: `state`
is a declared parameter with a closed set of values, so an unsupported value is
refused rather than ignored, and the control is a meaningless state that proves
the endpoint refuses at all. `serverSideMerge` decides on a status too, and
`updatedAfter` and `edgeUpdatedAfter` fall back to one when the control key is
refused. Read the probe rather than counting them.

**The idempotency door has three answers, not two.** A repeat under a key is
_honored_, _ignored_, or _reuse-refused_. The refusal — `422
idempotency_key_reused` to a key sent with a different request — is the
cleanest evidence available, because the confounders cannot reach it: a
natural-key match and a content dedupe both collapse writes that are _the
same_, and this refusal fires on writes that _differ_. So `idempotencyKeys`
sends a different-bodied pair, checks the replay half with a byte-identical
repeat, and sends the same content under a fresh key as a third leg — if that
collapses, the door dedupes on content and the probe throws rather than
reporting a rule it could not see. A server that reads keys and does not
refuse the reuse still reports `present`, with the deviation named in the
evidence: whether the refusal is the _right_ behavior is a test's assertion
rather than a probe's verdict. The `Idempotency-Replayed` header is asserted
by `idempotency.test.ts` and recorded beside the verdict rather than deciding
it.

**Every probe is three-valued and the third value is a red.** A probe that
cannot tell present from absent throws `IndeterminateProbe` rather than
degrading to `absent`, because an `absent` it did not earn names the server
for something the probe never looked at. An earned `absent` is a red too.
Each probe carries a control that proves it discriminates: a probe reading the
wrong key out of the listing envelope reports `absent` against every server,
and the control is what turns that into a red about the probe.

Probes run once per test file rather than once per run, because a vitest file
gets its own module registry.

## Documented gaps

A rule whose precondition cannot be constructed over HTTP is written up here
rather than left as a `.todo`: a `.todo` means the harness is missing, and
these mean the server offers no way to reach the state.

- **`ancestor_unavailable`.** The refusal fires when a merge cannot find the
  base version's snapshot because thinning has removed it. Thinning is a
  scheduled job with windows from server configuration, and no route runs it,
  deletes a version snapshot, or ages a caller's base version. Covered by the
  server's own tests under `packages/server`.
- **Retention beyond the event-log window.** The window is configuration
  (`MARFA_EVENT_LOG_RETENTION_HOURS`), and an event is retired by a sweep on
  the server's clock, so the re-import path cannot be reached by a black-box
  run. The in-window path is covered here; the prune is a device rule.
- **Blob eviction and the offline read cache.** Local to a device's store.
  The server has no half.

## What a new test owes

Everything in the repository's contributing rules, plus these.

- **A control that fails when the observation would pass for the wrong
  reason.** Every assertion in this project is about a silence: a filter that
  matched everything, an event that never came, a stream that was not
  listening. Each has an innocent explanation, and a test that cannot rule it
  out is asserting nothing. Write the control first.
- **A wait is on a frame the server sends either way.** Waiting on the frame
  that may never arrive means the runner's budget expires and reports
  `Test timed out` — the file, and nothing else. Wait on the control the
  subscription delivers regardless, drain what follows, then assert.
- **An absence is settled by a later frame, never by a quiet window.** A fixed
  window cannot tell "nothing more is coming" from "not yet". Write a sentinel
  row after the one under test and wait for the sentinel's own event. **The
  proof holds only between frames of the same kind**, because item events and
  edge events reach a subscriber through independent pipelines and their
  relative order is not a guarantee the stream makes.
- **No hand-rolled deadline.** A `while (cond && Date.now() < deadline)`
  followed by an assertion on `cond` takes the timeout away from the runner
  and re-emits it as a logic failure. Wait on the runner's budget, and pass
  `context.signal` into the stream helpers so an abort can name what it was
  waiting for.
