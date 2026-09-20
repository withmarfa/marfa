# Specification

What the fixtures assert, written down. Each area file states behavior in numbered statements and cites, for each, the fixture that asserts it as `file › test title`. Nothing here is a proposal, and nothing is renamed.

The specification has two halves.

**The server's half** states the server's behavior over HTTP, and the server is the source: where it contradicts its own OpenAPI document, the statement says so and `findings.md` carries the detail.

- `items.md`: items, their lifecycle, bulk doors, metadata, tags and extensions.
- `types.md`: the type registry, its grammar, inheritance and enforcement levers.
- `edges.md`: edges, edge types, hydration and traversal.
- `versions.md`: versions, snapshots, the two 409 envelopes and server-side merge.
- `blobs.md`: uploads, downloads and the presigned-URL door.
- `events.md`: the event stream, its frames and filters, and outbound webhooks.
- `search-and-filters.md`: search, export, occurrences and the query grammar every listing shares.
- `keys-and-oauth.md`: keys, permissions, the operator key and the OAuth provider.
- `instance.md`: what one deployment says about itself, and the identity it answers to.
- `errors.md`: the error envelope and every code the fixtures produce.
- `coverage.md`: every published operation with its fixture and status.
- `findings.md`: where the server contradicts its own document, for the server's maintainers.

**The device's half** states what a client with a local working copy and a queue does. There is no server to be the source for it, so these chapters are the source, and an implementation that disagrees with them is wrong.

- `device.md`: the working copy, the slice, hydration, catch-up, and what a device may never do locally.
- `queue-and-verdicts.md`: the queue, the version on every write, the six verdicts, and which failures retry.
- `folders.md`: a directory on a machine as a device, and the rules that hold there.

## How to read a statement

A statement is a sentence about observable behavior, followed by its citations. A citation names a file under `src/suites/` and a test title in it, and the cited test asserts what the statement says: the same status, the same code, the same field, the same bound. A statement with no citation does not belong here. `src/utils/spec-citations.test.ts` fails when a citation names a file or title that does not exist, and `src/suites/device/corpus.decision.test.ts` fails when a device statement carries no citation at all.

**A device citation may name a fixture the binary cannot satisfy yet.** The device half was written before the write path it describes, so most of `queue-and-verdicts.md` and all of `folders.md` cite fixtures that are waiting on it. `src/suites/device/pending.ts` carries two registers, each entry naming the statement its fixture will assert. `PENDING` is the one milestone one empties, and its reaching empty is that milestone's gate; `PENDING_BEYOND_MILESTONE` holds what a later milestone covers, with the reason traveling with the entry, so the first list cannot reach empty by relabeling. `corpus.decision.test.ts` holds both to exactly the fixtures that skip and holds the second to exactly the entries a decision named, and a fixture whose assertions are written runs and must fail, so the run goes red the day the device satisfies it. Until then, a device statement is written down and reached by a fixture, and only the ones outside both registers are asserted today.

## What the fixtures run against

The server's half runs against one locally booted server on SQLite, one dataset. Each fixture file mints its own key through the provisioning key with a `source` unique to the file, and every row it writes is stamped with that source. The operator-only doors run as the operator key.

The device's half runs against a scripted server the fixture controls, because the verdicts a device has to reach include failures the real server cannot be asked for: a dropped connection, a server at rest, a spent credential, a retry ceiling. Each device chapter lists what the real server cannot produce and why, and `src/suites/device/fidelity.test.ts` asserts that every answer the scripted server gives which the real server _can_ produce matches the real one's.

## Outside the fixtures

- Enrichment and OCR are switched off for a run; no statement covers what the sweeper does to a file item after the fact.
- Rate limiting is switched off for a run. `/keys` and `/keys/{id}` share a fixed limit of 200 requests a minute per credential that no configuration raises, and a run that mints and revokes one key per file exceeds it; nothing is asserted about `429 rate_limited`.
- The boot mint. A fresh instance mints its first key once through `POST /keys` with the one-time secret printed in its boot log as the bearer token; the answer is one key, the operator key, which is also what the suite provisions with. `scripts/marfa-server.ts` performs it and `src/utils/target.test.ts` pins how the answer is read; no fixture repeats it, because the secret is consumed by the first mint.
