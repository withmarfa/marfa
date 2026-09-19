import { basename } from "node:path";

/**
 * Statements the device cannot satisfy yet, each with the statement it will
 * assert when it can.
 *
 * A pending fixture is not a hole in the contract. The chapters state what a
 * device does, the corpus reaches every statement, and this file is the list
 * of the ones the binary has not grown the behavior for. The guard in
 * `corpus.decision.test.ts` holds the list to exactly the tests that skip, so
 * a statement cannot quietly stop being asserted and the list cannot quietly
 * stop shrinking. **Milestone one is reached when this list is empty.**
 *
 * What milestone one does not cover lives in `PENDING_BEYOND_MILESTONE`
 * instead, so emptying this one is a claim about work rather than about
 * bookkeeping. Moving an entry between the two is a decision, and the guard
 * holds the second list to exactly the entries that decision named.
 */
export const PENDING: Readonly<Record<string, string>> = {
  "working-copy.test.ts › gives a second opener a reading handle that refuses writes":
    "device.md 3",
  "working-copy.test.ts › refuses a read before any hydration": "device.md 4",
  "catch-up.test.ts › skips an event older than the row it holds and still advances the cursor":
    "device.md 13",
  "local-refusals.test.ts › refuses to merge two values for one field":
    "device.md 19",
  "local-refusals.test.ts › refuses to advance a version of its own accord":
    "device.md 20",
  "local-refusals.test.ts › refuses to resolve a conflict it was refused":
    "device.md 21",
  "local-refusals.test.ts › refuses a local create whose tags and edges it cannot queue":
    "device.md 22",
  "local-refusals.test.ts › refuses an update carrying a field it cannot send":
    "device.md 23",
  "local-refusals.test.ts › refuses a write from a reading handle":
    "device.md 26",
  "local-refusals.test.ts › refuses a local purge": "device.md 25",
  "queue.test.ts › sends queued writes in the order they were queued":
    "queue-and-verdicts.md 1",
  "queue.test.ts › keeps the queue across a restart": "queue-and-verdicts.md 1",
  "queue.test.ts › refuses an update queued with no version":
    "queue-and-verdicts.md 2",
  "queue.test.ts › sends a create with the version it was based on":
    "queue-and-verdicts.md 2",
  "queue.test.ts › retries under the key it was queued with, and is answered from the record rather than written twice":
    "queue-and-verdicts.md 3",
  "queue.test.ts › holds a write whose create has not been answered":
    "queue-and-verdicts.md 4",
  "queue.test.ts › sends every update with the server asked to resolve":
    "queue-and-verdicts.md 5",
  "queue.test.ts › reports a verdict for every write it sent":
    "queue-and-verdicts.md 6",
  "queue.test.ts › queues writes while the server is unreachable":
    "queue-and-verdicts.md 28",
  "queue.test.ts › drains in order on reconnect": "queue-and-verdicts.md 29",
  "queue.test.ts › keeps the queue through a re-hydration":
    "queue-and-verdicts.md 30",
  "queue.test.ts › shows an unanswered local write to a local read":
    "queue-and-verdicts.md 31",
  "queue.test.ts › holds one kind per write, from the closed set":
    "queue-and-verdicts.md 32",
  "queue.test.ts › queues an edge, a tag and an extension as writes of their own":
    "queue-and-verdicts.md 33",
  "verdicts.test.ts › answers every write with one of the six verdicts":
    "queue-and-verdicts.md 7",
  "verdicts.test.ts › tells the three successful verdicts apart by the resolution the answer carries":
    "queue-and-verdicts.md 8",
  "verdicts.test.ts › accepted: adopts the row the server returned":
    "queue-and-verdicts.md 9",
  "verdicts.test.ts › accepted: takes an upsert and a replayed repeat as accepted":
    "queue-and-verdicts.md 9",
  "verdicts.test.ts › merged: adopts the row a resolution returned":
    "queue-and-verdicts.md 10",
  "verdicts.test.ts › conflicted: names the sibling the server wrote":
    "queue-and-verdicts.md 11",
  "verdicts.test.ts › refused: carries the server's code and is not sent again":
    "queue-and-verdicts.md 12",
  "verdicts.test.ts › blocked: is passed over by a drain and reported with its reason":
    "queue-and-verdicts.md 13",
  "verdicts.test.ts › dead: is terminal once the ceiling is reached":
    "queue-and-verdicts.md 14",
  "verdicts.test.ts › reports a conflict rather than resolving it":
    "queue-and-verdicts.md 15",
  "verdicts.test.ts › refuses the writes that were waiting on a create the server refused":
    "queue-and-verdicts.md 16",
  "verdicts.test.ts › answers about whole fields, never about part of one":
    "queue-and-verdicts.md 34",
  "classification.test.ts › retries an environmental failure past the ceiling without counting it":
    "queue-and-verdicts.md 17",
  "classification.test.ts › retries a 5xx and a 429 without counting them":
    "queue-and-verdicts.md 17",
  "classification.test.ts › refuses a contract failure on the first answer":
    "queue-and-verdicts.md 18",
  "classification.test.ts › retries an answer it cannot read, and counts it":
    "queue-and-verdicts.md 19",
  "classification.test.ts › retries a key the server reports in flight, and counts it":
    "queue-and-verdicts.md 19",
  "classification.test.ts › blocks the whole queue on a refused credential, and stops the drain":
    "queue-and-verdicts.md 20",
  "classification.test.ts › blocks a spent key on the first refusal rather than spending the ceiling":
    "queue-and-verdicts.md 21",
  "classification.test.ts › blocks a write whose base version the server no longer holds":
    "queue-and-verdicts.md 22",
  "classification.test.ts › blocks a conflict the server declined to resolve":
    "queue-and-verdicts.md 23",
  "classification.test.ts › releases a held write when its dependency is answered":
    "queue-and-verdicts.md 24",
  "classification.test.ts › counts refusals rather than attempts, so a long outage does not exhaust the ceiling":
    "queue-and-verdicts.md 25",
  "classification.test.ts › reaches the ceiling on the fifth refusal":
    "queue-and-verdicts.md 25",
  "classification.test.ts › reports one of the five blocked reasons and no other":
    "queue-and-verdicts.md 26",
  "classification.test.ts › sends a released row again under a fresh key":
    "queue-and-verdicts.md 27",
  "folders.test.ts › is a view on a slice with defaults for a new file":
    "folders.md 1",
  "folders.test.ts › keeps each folder's state and queue to itself":
    "folders.md 2",
  "folders.test.ts › hydrates into an empty directory and pushes without holding anything else":
    "folders.md 3",
  "folders.test.ts › makes a file an item and an item a file": "folders.md 4",
  "folders.test.ts › carries frontmatter to properties and the body to the body":
    "folders.md 5",
  "folders.test.ts › treats a body opening with a horizontal rule as a body":
    "folders.md 6",
  "folders.test.ts › carries links to edges and edges to links": "folders.md 7",
  "folders.test.ts › follows a rename by device, inode and birth time":
    "folders.md 8",
  "folders.test.ts › treats a file with no usable identity as new rather than guessing":
    "folders.md 8",
  "folders.test.ts › binds the same file to the same item whether it was present at start or arrived while running":
    "folders.md 9",
  "folders.test.ts › binds one file to one item across two separately enrolled devices":
    "folders.md 10",
  "folders.test.ts › keeps the item id in the file as a record, and does not depend on it for identity":
    "folders.md 11",
  "folders.test.ts › moves the file when the item is renamed on the server":
    "folders.md 12",
  "folders.test.ts › refuses a create that carries no version": "folders.md 13",
  "folders.test.ts › does not overwrite newer server content from a stale folder":
    "folders.md 13",
  "folders.test.ts › does not read its own writes back as changes":
    "folders.md 14",
  "folders.test.ts › defers a delete past the rename grace": "folders.md 15",
  "folders.test.ts › journals a delete that happened while it was not running":
    "folders.md 16",
  "folders.test.ts › excludes a dot-led directory at any depth":
    "folders.md 17",
  "folders.test.ts › keeps its own state in .marfa and never pushes it":
    "folders.md 18",
  "folders.test.ts › leaves a file outside the slice alone": "folders.md 19",
};

/**
 * Statements a later milestone satisfies, with the reason each is out of
 * this one.
 *
 * `PENDING` is the list milestone one empties, and an entry here is not
 * waiting on the same work — it is waiting on a milestone that has not
 * started. Keeping the two apart is what stops the first list reaching empty
 * because something was relabeled. The reason travels with the entry rather
 * than sitting in a comment beside it, and `corpus.decision.test.ts` holds
 * this map to a literal copy of itself, so moving an entry here means
 * editing the register and the guard in one change. That is a tripwire
 * rather than a proof — nothing in the repository records the decision —
 * and a tripwire is what makes the move loud enough to be reviewed.
 */
export const PENDING_BEYOND_MILESTONE: Readonly<Record<string, string>> = {
  "working-copy.test.ts › holds the thumbnail an item carries":
    "device.md 29 — blob work is outside milestone one",
  "working-copy.test.ts › says the bytes are absent rather than the item":
    "device.md 30 — blob work is outside milestone one",
};

/**
 * Both registers as one map: every mechanism below reads this, and so does
 * the guard. A fixture does not care which list holds it; only the milestone
 * does, and the guard reads the registers apart for that one question alone.
 *
 * One union rather than one per reader, because a register added later and
 * folded in here is then honored and checked by the same value. Two copies
 * would let a third list skip fixtures the guard could not see.
 */
export const ALL_PENDING: Readonly<Record<string, string>> = {
  ...PENDING,
  ...PENDING_BEYOND_MILESTONE,
};

/**
 * A pending fixture whose assertions are written.
 *
 * It runs. While the statement is on the list the body has to fail, and the
 * run goes red the day it stops failing, asking for the entry to be removed —
 * which is what keeps a satisfied statement from sitting skipped for ever.
 * Off the list it is an ordinary assertion.
 */
export async function pendingUntilItPasses(
  context: Skippable,
  body: () => Promise<void>,
): Promise<void> {
  const key = pendingKeyOf(context);
  const statement = ALL_PENDING[key];
  if (statement === undefined) {
    await body();
    return;
  }
  try {
    await body();
  } catch (error) {
    // Only an assertion tells us the device could not do the thing. A spawn
    // that failed, a stale binary, a port already taken: each of those throws
    // too, and reading one as "still pending" is how a broken harness reports
    // itself as a device that is merely behind.
    if (!isAssertion(error)) throw error;
    return;
  }
  throw new Error(
    `this fixture now passes, so ${statement} is satisfied: remove "${key}" from the register that holds it, in the same pull request that made it pass.`,
  );
}

function isAssertion(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const thrown = error as { name?: unknown; matcherResult?: unknown };
  return thrown.matcherResult !== undefined || thrown.name === "AssertionError";
}

interface Skippable {
  skip: (note: string) => void;
  task: { name: string; file: { name: string } };
}

export function pendingKeyOf(context: Skippable): string {
  return `${basename(context.task.file.name)} › ${context.task.name}`;
}

/**
 * Stops a test that names a statement the binary cannot satisfy yet, saying
 * which statement it is. `context.skip` rather than `it.skip`, so the title
 * stays a literal the citation checker can resolve.
 */
export function skipIfPending(context: Skippable): void {
  const key = pendingKeyOf(context);
  const statement = ALL_PENDING[key];
  if (statement !== undefined) {
    context.skip(`pending: the device cannot satisfy ${statement} yet`);
  }
}

/**
 * The body of a fixture whose statement the device cannot reach yet.
 *
 * It throws rather than passing. A shell that asserted nothing would go green
 * the moment its entry left the register, and the statement it cites would then
 * be cited by a test that checks nothing — which is the one failure mode a
 * pending list is supposed to make impossible.
 */
export function notWrittenYet(subject: string): never {
  throw new Error(
    `this fixture has no body: it asserts a statement about ${subject}, and the device cannot reach it yet. Write the body in the pull request that removes its entry from the register.`,
  );
}
