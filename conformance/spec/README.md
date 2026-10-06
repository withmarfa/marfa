# The contract

The rules Marfa must keep, written for the people and agents who build it or build against it. Each rule is a statement, and each statement names the fixtures under `src/suites/` that assert it. The docs explain Marfa to people; this folder says what Marfa does, and nothing else.

This file is the standard every chapter is written to. `src/utils/spec-form.test.ts` checks what can be checked by machine, and review checks the rest.

## The chapters

The contract has two halves.

**The server's half** states what the server answers over HTTP. The server is the source: where it contradicts its own OpenAPI document, the statement says so and `findings.md` carries the detail.

- `items.md`: items, their lifecycle, bulk writes, metadata, tags and extensions, the folder operation that writes `system.folder`, and links and the tombstones a purge leaves.
- `types.md`: the type registry, its grammar, inheritance, enforcement levers and a type's link.
- `edges.md`: edges, edge types, hydration and traversal.
- `versions.md`: versions, snapshots, the 409 envelopes and server-side merge.
- `read-views.md`: how a read view shapes the items an answer carries.
- `blobs.md`: uploads, downloads, ranges and the blob link.
- `stores.md`: where a blob's bytes live, the location log, and the rules that keep them.
- `housekeeping.md`: the jobs the server runs on itself, listed and run on demand.
- `connectors.md`: a process outside the server registering under its key, heartbeating, reporting its runs, holding its registration, and keeping its state and agreements on the instance.
- `inbound-webhooks.md`: a connector's webhook endpoints, the operation a sender posts to, and the deliveries a connector reads and marks handled.
- `events.md`: the event stream, its frames and filters, and outbound webhooks.
- `search-and-filters.md`: search, export, occurrences, the lookup by link, natural key or id, and the query grammar every listing shares.
- `occurrences.md`: how a recurring event unfolds into occurrences across zones and clock changes, what an occurrence window includes, and what a write may store as a rule.
- `keys-and-oauth.md`: keys, permissions, the operator key and the OAuth provider.
- `instance.md`: what one instance says about itself, and the identity it answers to.
- `errors.md`: the error envelope and every code the server sends.
- `coverage.md`: every published operation with its fixture and status.
- `findings.md`: where the server contradicts its own document.

**The device's half** states what a device does: a client with a local working copy and a queue. No server is the source for it, so these chapters are, and an implementation that disagrees with them is wrong.

- `device.md`: the working copy, the slice, hydration, catch-up, and what a device never does locally.
- `queue-and-verdicts.md`: the queue, the version on every write, the six verdicts, and which failures retry.
- `folders.md`: a directory on a machine as a device, and the rules that hold there.

## How a statement is written

```markdown
### `housekeeping/run-unknown-name`

When the operator key asks to run a name the server runs no job under, the server MUST answer `404 housekeeping_job_not_found`.

**Reason:** optional, when the rule is not obvious on its own.

**Tests:** `compliance/housekeeping.test.ts › answers 404 for a name the instance does not run, where a listed one runs`.
```

A statement is a level-3 heading holding only its ID, then the rule, then an optional reason, then its tests, in that order. Statements sit under `##` headings that group them, and a `##` section may open with plain paragraphs that introduce it. A paragraph outside a statement states no rule.

### The rule

- **One requirement.** A rule says one thing the subject does or never does. A list of fields in one answer is one requirement; a status and a separate side effect are two.
- **Keywords.** The key words MUST and MUST NOT are to be interpreted as described in BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals. A rule holds exactly one of them. The contract uses no other BCP 14 keyword, because a rule that may or may not hold cannot be tested.
- **Pattern.** Each rule follows one of the EARS patterns:

  | Pattern               | Form                         |
  | --------------------- | ---------------------------- |
  | Always                | The server MUST …            |
  | On an event           | When …, the server MUST …    |
  | In a state            | While …, the server MUST …   |
  | With a feature        | Where …, the server MUST …   |
  | On something unwanted | If …, then the server MUST … |

  A rule may combine a feature or a state with an event: "Where enrichment is on, if …, then the server MUST …".

- **Subject.** The subject is the server, a device or the command.
  - **The server** is any implementation of the server's half.
  - **A device** is the engine every native client embeds (`core/`), so a rule about a device holds for every app built on it, through the Swift package or the Node module, and for the `marfa` command.
  - **The command** is the `marfa` binary, for what only it does.
- **Observable.** A rule says what a client, a sender or an owner can see: a status, a code, a field, a stored value, a file on disk. It never says how the server does it. A transaction, a lock or a function is mentioned only where a client can see its effect, and then as the effect.

### The reason

A reason says why the rule exists, in one or two sentences. It holds no requirement and no test. Leave it out when the rule explains itself.

### The tests

- **Tests** names each fixture that asserts the rule, as `` `<project>/<file>.test.ts › <test title>` ``. A citation that continues the same file is written `` `› <test title>` ``. `src/utils/spec-citations.test.ts` fails when a file or title does not exist.
- A cited fixture asserts what the rule says: the same status, the same code, the same field, the same bound.
- **A rule no fixture can assert yet** says `**Tests:** waiting on #<issue>.`, naming the open issue that makes it testable. It never cites the server's own tests under `packages/server/src`. The contract judges any server, so it is proven only by fixtures that reach a server from outside.

## IDs

- **Every statement has an ID,** `<chapter>/<name>`: the chapter is the file's name without `.md`, and the name is lowercase words joined by hyphens, at most 40 characters, such as `housekeeping/run-unknown-name`.
- **An ID is a name, not a summary.** It is never changed to follow a change in wording.
- **An ID is never reused.** A statement that is removed, or replaced by others, moves to the `## Retired` list at the end of its chapter, with what replaced it:

  ```markdown
  ## Retired

  - `housekeeping/old-name`: replaced by `housekeeping/new-name`.
  - `housekeeping/other-name`: withdrawn.
  ```

  `scripts/check-spec-ids.ts` fails when an ID that was active or retired on `main` is neither.

- **A reference is the ID in code font,** in a chapter, a comment or a document: `` `housekeeping/run-unknown-name` ``. The ID is also the statement's heading, so a link reaches it.

### Chapters still numbered

Chapters move to this form one at a time. Until a chapter moves, its statements are numbered (`1.`, `2.`) and cited as `` `items.md` 5 ``. When a chapter moves, `spec-migrations/<chapter>.json` maps its old numbers to its IDs, `scripts/spec-ids.ts` moves every reference to them, and `spec-citations.test.ts` refuses a numbered reference into a chapter that has moved, naming the IDs that replaced it.

## Words

- The words are the ones in `GLOSSARY.md`, in American English.
- No em dashes.
- No history: a chapter says what holds now, never what changed or what was removed.

## What the fixtures run against

The server's half runs against one locally booted server on SQLite, one dataset. Each fixture file mints its own key through the provisioning key with a `source` unique to the file, and every row it writes is stamped with that source, or with one built from it that the file's own keys claim. The operator-only operations run as the operator key.

The device's half runs against a scripted server the fixture controls, because the verdicts a device has to reach include failures the real server cannot be asked for: a dropped connection, a server at rest, a spent credential, a retry ceiling. Each device chapter lists what the real server cannot produce and why, and `src/suites/device/fidelity.test.ts` asserts that every answer the scripted server gives which the real server can produce matches the real one's.

## Outside the fixtures

- Enrichment and OCR are off for a run. The enrichment statements in `housekeeping.md`, such as `housekeeping/enrichment-failure-counted` and `housekeeping/enrichment-image-by-type`, are asserted by fixtures that each boot a server of their own with enrichment on.
- Rate limiting is off for a run, because a run that mints and revokes one key per file would spend the key operations' allowance on its own setup. What that allowance is, and what a caller past it is told, is `keys-and-oauth.md` 33, asserted against a server booted with the limiter on. The caps on every other path group are the server's own numbers, and no statement covers them.
- The boot mint. A fresh instance mints its first key once, through `POST /keys`, with the one-time secret printed in its boot log as the bearer token. The answer is one key, the operator key, which is also what the suite provisions with. `scripts/marfa-server.ts` performs it and `src/utils/target.test.ts` pins how the answer is read. No fixture repeats it, because the first mint consumes the secret. A boot mint naming `sources` is refused `403 forbidden`, as a mint of any operator key is, and the secret still mints afterwards; `packages/server/src/routes/keys.test.ts` asserts it.
