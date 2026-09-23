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
export const PENDING: Readonly<Record<string, string>> = {};

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
    "device.md 29 — the device has no thumbnail at all: no shipped type carries thumbnail bytes, nothing under core/ names one, and the local row holds an item's properties alone, so there is nothing for hydration to carry and nothing for a read to answer with",
  "working-copy.test.ts › says the bytes are absent rather than the item":
    "device.md 30 — the device has no door that reads a blob: upload_blob is the one queued kind the drain refuses to address and no local read takes a hash, so nothing can be asked for bytes and there is no answer to hold to absent bytes rather than an absent item",
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
 * which is what keeps a satisfied statement from sitting skipped forever.
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
