# The contract

The rules Marfa must keep. Its readers are mostly agents that build Marfa or build on it, and that search it for the rule they need rather than read it through. Each rule is a statement that names the fixtures under `src/suites/` that assert it.

The docs explain Marfa to people. This folder only says what Marfa does.

This file is the standard every chapter is written to. `src/utils/spec-form.test.ts` checks what a machine can check, and review checks the rest.

## The chapters

The contract has two halves.

**The server's half** says what the server answers over HTTP. The server is the source. Where the server contradicts its own OpenAPI document, the statement says so, and `findings.md` holds the detail.

- `items.md`: items, their lifecycle, bulk writes, metadata, tags and extensions, the folder operation that writes `system.folder`, and links and the tombstones a purge leaves.
- `types.md`: the type registry, its grammar, inheritance, enforcement levers and a type's link.
- `edges.md`: edges, edge types, hydration and traversal.
- `versions.md`: versions, snapshots, the 409 envelopes and server-side merge.
- `read-views.md`: the copy stream, conditional reads, and the read view that certifies what a working copy holds.
- `blobs.md`: uploads, downloads, ranges and the blob link.
- `stores.md`: where a blob's bytes live, the location log, and the rules that keep them.
- `housekeeping.md`: the jobs the server runs on itself.
- `connectors.md`: a process outside the server that registers under its key, heartbeats, reports its runs, holds its registration, and keeps its state and agreements on the instance.
- `inbound-webhooks.md`: a connector's webhook endpoints, the operation a sender posts to, and the deliveries a connector reads and marks handled.
- `events.md`: the event stream, its frames and filters, and outbound webhooks.
- `search-and-filters.md`: the query grammar every listing shares, search, the counts, the lookup by link, natural key or id, export and restore.
- `occurrences.md`: how `GET /occurrences` unfolds a series across zones and clock changes, what a window includes, and what a write may store as a schedule.
- `keys-and-oauth.md`: keys, permissions, the operator key and the OAuth provider.
- `instance.md`: what an instance says about itself, and the identity it answers to.
- `errors.md`: the error envelope and every code the server sends.
- `coverage.md`: every published operation, with its fixture and status.
- `findings.md`: where the server contradicts its own document.

**The device's half** says what a device does: a client with a local working copy and a queue. No server is the source for it, so these chapters are. An implementation that disagrees with them is wrong.

- `device.md`: the working copy, the slice, hydration, catch-up, and what a device never does locally.
- `queue-and-verdicts.md`: the queue, the version on every write, the six verdicts, and which failures retry.
- `folders.md`: a directory on a machine as a device, and the rules that hold there.

## How a statement is written

```markdown
### `housekeeping/run-unknown-name`

When the operator key asks to run a name the server runs no job under, the server MUST answer `404 housekeeping_job_not_found`.

**Reason:** optional, when the rule does not explain itself.

**Tests:** `compliance/housekeeping.test.ts › answers 404 for a name the instance does not run, where a listed one runs`.
```

A statement has four parts, in this order:

1. A level-3 heading that holds only its ID.
2. The rule.
3. An optional reason.
4. Its tests.

Statements sit under `##` headings that group them. A `##` section may open with a short introduction, which states no rule.

### The rule

- **One sentence, one requirement.** A rule says one thing the subject does or never does. A list of fields in one answer is one requirement. A status and a separate side effect are two.
- **Self-contained.** A rule reads correctly on its own, found by a search, without the statements around it. It names what it means in full, and points at another statement only by ID.
- **Keywords.** The key words MUST and MUST NOT are to be interpreted as described in BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals. A rule holds exactly one of them. The contract uses no other BCP 14 keyword, because a rule that may or may not hold cannot be tested.
- **Pattern.** Each rule follows one of the EARS patterns:

  | Pattern               | Form                         |
  | --------------------- | ---------------------------- |
  | Always                | The server MUST …            |
  | On an event           | When …, the server MUST …    |
  | In a state            | While …, the server MUST …   |
  | With a feature        | Where …, the server MUST …   |
  | On something unwanted | If …, then the server MUST … |

  A rule may combine a feature or a state with an event or an unwanted condition: "Where enrichment is on, if …, then the server MUST …".

- **Subject.** The subject is the server, a device or the command:
  - **The server** is any implementation of the server's half.
  - **A device** is the engine every native client embeds (`core/`). A rule about a device holds for every app built on it, through the Swift package or the Node module, and for the `marfa` command.
  - **The command** is the `marfa` command, for what only it does.
- **Observable.** A rule says what a client, a sender or an owner can see: a status, a code, a field, a stored value, a file on disk. It never says how the server does it. A transaction or a lock appears only as the effect a client can see.

### The reason

A reason says why the rule exists, in one or two sentences, so that an agent changing the code knows the behavior is meant and what it protects. It holds no requirement and no test. Leave it out when the rule explains itself.

### The tests

- **Tests** names each fixture that asserts the rule, as `` `<project>/<file>.test.ts › <test title>` ``. A citation that continues the same file is written `` `› <test title>` ``.
- **A cited fixture asserts what the rule says:** the same status, the same code, the same field, the same bound. `src/utils/spec-citations.test.ts` fails when a cited file or title does not exist.
- **A rule no fixture can assert yet** says `**Tests:** waiting on #<issue>.`, naming the open issue that makes it testable.
- **Never the server's own tests.** A rule never cites tests under `packages/server/src`. The contract judges any server, so only fixtures that reach a server from outside prove it.

## IDs

- **Every statement has an ID,** `<chapter>/<name>`, such as `housekeeping/run-unknown-name`. The chapter is the file's name without `.md`. The name is lowercase words and numbers joined by hyphens, starts with a word, and is at most 40 characters.
- **An ID is a name, not a summary.** It is never changed to follow a change in wording.
- **An ID is never given to a different rule.** When a statement is removed, its ID goes with it.
- **A reference is the ID in code font,** in a chapter, a code comment or a document: `` `housekeeping/run-unknown-name` ``. The ID is also the statement's heading, so a link reaches it.

### Chapters still numbered

Chapters move to this form one at a time. Until a chapter moves, its statements are numbered and cited as `` `folders.md` 5 ``.

When a chapter moves, `scripts/spec-ids.ts` moves every reference from its old numbers to its IDs. It stops and asks wherever one old statement became several. A numbered reference into a chapter that has moved fails `spec-citations.test.ts`.

## Words

- The words are the ones in `GLOSSARY.md`, in American English.
- Nothing but rules. A section may open with a sentence or two of context; no prose restates a rule or explains Marfa.
- No em dashes.
- No history: a chapter says what holds now, never what changed or what was removed.

## What the fixtures run against

**The server's half** runs against one locally booted server on SQLite, with one dataset:

- Each fixture file mints its own key with a `source` unique to the file.
- Every row a file writes carries that source, or one built from it that the file's own keys claim.
- The operator-only operations run as the operator key.

**The device's half** runs against a scripted server the fixture controls. A device must reach verdicts for failures the real server cannot be asked for, such as a dropped connection, a server at rest, a spent credential or a retry ceiling.

Each device chapter lists what the real server cannot produce, and why. `src/suites/device/fidelity.test.ts` asserts that every scripted answer the real server can also give matches the real one.

## Outside the fixtures

- **Enrichment and OCR are off for a run.** The enrichment statements in `housekeeping.md` are asserted by fixtures that each boot a server of their own with enrichment on.
- **Rate limiting is off for a run.** A run mints and revokes one key per file, which would spend the key operations' allowance. That allowance, and what a caller past it is told, is `keys-and-oauth.md` 33, asserted against a server booted with the limiter on. No statement covers the caps on other paths.
- **The boot mint.** A fresh instance mints its first key, the operator key, once, through `POST /keys`, with the one-time secret its boot log prints as the bearer token.
  - `scripts/marfa-server.ts` performs it, and `src/utils/target.test.ts` pins how the answer is read.
  - No fixture repeats it, because the first mint uses up the secret.
  - A boot mint naming `sources` is refused `403 forbidden`, and the secret still mints afterwards. `packages/server/src/routes/keys.test.ts` asserts it.
