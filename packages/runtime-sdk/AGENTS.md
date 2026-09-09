# @withmarfa/runtime-sdk

The SDK an Integration is written against: handler registration, per-Connection state, the connection-scoped client, echo suppression, and the dispatch glue the server's runtime calls into. **Published**, because an Integration outside this repository cannot depend on a workspace reference.

**The breaking-change posture is the server's.** This package describes what the server's runtime will call and what it guarantees while doing so, so its major version tracks that contract rather than its own internals: a change that makes an existing handler stop compiling or stop behaving is a break, shipped as at least a minor with a commit footer naming it (the published-surface check states the rule and why it is not a major), and everything else is not. It stays in this repository for the same reason, versioned in lockstep with the server that implements it.

## The resumption contract

A scheduled sweep returns `SweepResult`, not `HandlerResult`. `done` is required, so a handler that has not finished has to say so and cannot be mistaken for one that has. Webhook and item-event handlers are unchanged: a delivery and an item event have nothing to continue.

A dispatch is bounded. `ctx.budget.shouldYield` is what a page loop polls, and `ctx.budget.signal` is what a `fetch` should be given, so a call in flight at the deadline is not what carries the run past it.

**Four words, used precisely, because the design turns on the differences:**

- **watermark** is how far a _finished_ sweep got, in the provider's own domain key space. Durable, committed as the sweep runs, and where a fresh sweep starts. Never an offset: "item 4,300" means nothing once the provider inserts something.
- **checkpoint** is where _this slice_ stopped. It lives in the queue payload rather than the cursor, so a redelivered slice is deterministic and an unrelated dispatch running in the gap cannot read it.
- **signpost** is the upper bound, frozen before the first page and held for the whole chain. Without one, a provider that keeps writing can feed a sweep forever and it never reaches an end it can report. An entry added mid-chain is next chain's problem.
- **sweep id** is a correlation identity for one chain, handed to the author for idempotency keys and compared by the runtime, so a straggler from an abandoned chain is discarded rather than appended to a chain nothing is tracking.

**`sweep()` does not carry a provider page token across a slice boundary unless the author opts in.** A token valid for hours and one valid for five minutes have the same type signature, and a slice boundary can be minutes wide. An expired token produces an error the author sees; one the provider silently reinterprets produces a sweep that skips records and reports success. The default re-derives from the watermark, which costs at most one re-fetched page and cannot skip. Opt in per integration, once, having read the provider's documentation on token lifetime.

**Chains are bounded and abandoning one is cheap.** The supervisor stops a chain that exceeds its slice or wall-clock ceiling and records it where an operator can see it. Recovery is automatic, because the watermark is committed per page, and that is what buys the right to make the ceilings aggressive.

## Authoring rules

- **Module singleton, and both packages must be externalized.** This package and `@withmarfa/shared` must be marked external in any bundle that loads integrations alongside them. The handler registry here and the type, edge and schema caches there are module-level state, and a duplicate across the bundle boundary makes the dispatch lookup silently miss. `pnpm --filter @withmarfa/server run smoke:worker-entry` is the build-time tripwire.
- **No `console.log`.** Handlers emit through `system.activity`, severity-tagged, via the activity helpers; the substrate aggregates and persists.
- **Echo suppression is not probabilistic.** It is a plain key-value record with an expiry, keyed per external id, so there are no false positives to reason about.
