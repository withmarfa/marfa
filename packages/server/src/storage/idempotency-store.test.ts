/**
 * The store under the idempotency middleware, and the one property about
 * it that no request can show: that its rows go away.
 *
 * Anything that grows on every write needs an owner in code. This one has
 * no sweeper of its own — it rides the event-log retention sweep, which
 * already resolves the effective window and already holds a cluster lock. The behavioral half is below; the structural half reads
 * `index.ts`, because "there is no second sweeper" is a claim about what
 * is absent and a running server cannot be asked it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateId } from "@withmarfa/shared";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IdempotencyClaim, IdempotencyRecord } from "./interface.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const HOUR = 3_600_000;

async function seed(opts: { key: string; ageHours: number }): Promise<string> {
  const id = generateId();
  const claim = await ctx.storage.idempotency.claim({
    id,
    idempotency_key: opts.key,
    fingerprint: "f",
    created_at: new Date(Date.now() - opts.ageHours * HOUR).toISOString(),
  });
  expect(claim.claimed).toBe(true);
  return id;
}

describe("cleanup", () => {
  it("deletes what is past the window and keeps what is not", async () => {
    const old = `old-${generateId()}`;
    const fresh = `fresh-${generateId()}`;
    await seed({ key: old, ageHours: 200 });
    await seed({ key: fresh, ageHours: 1 });

    const deleted = await ctx.storage.idempotency.cleanup(168);
    expect(deleted).toBeGreaterThanOrEqual(1);

    // The discriminator: a sweep that deleted everything, or nothing,
    // would satisfy a one-sided assertion.
    const oldClaim = await ctx.storage.idempotency.claim({
      id: generateId(),
      idempotency_key: old,
      fingerprint: "f",
      created_at: new Date().toISOString(),
    });
    expect(oldClaim.claimed).toBe(true);

    const freshClaim = await ctx.storage.idempotency.claim({
      id: generateId(),
      idempotency_key: fresh,
      fingerprint: "f",
      created_at: new Date().toISOString(),
    });
    expect(freshClaim.claimed).toBe(false);
  });
});

describe("claim", () => {
  it("hands the second caller the row the first holds", async () => {
    const key = `claimed-${generateId()}`;
    const first = await ctx.storage.idempotency.claim({
      id: generateId(),
      idempotency_key: key,
      fingerprint: "one",
      created_at: new Date().toISOString(),
    });
    expect(first.claimed).toBe(true);

    const second = await ctx.storage.idempotency.claim({
      id: generateId(),
      idempotency_key: key,
      fingerprint: "two",
      created_at: new Date().toISOString(),
    });
    expect(second.claimed).toBe(false);
    if (second.claimed) throw new Error("unreachable");
    // Not merely "did not claim": the row that beat it has to come back,
    // because the third outcome — lost the INSERT and found nobody — is
    // also `claimed: false` and means something else entirely.
    expect(second.held).not.toBeNull();
    if (second.held === null) throw new Error("unreachable");
    expect(second.held.fingerprint).toBe("one");
    expect(second.held.state).toBe("in_flight");
  });

  it("admits exactly one takeover of an abandoned claim", async () => {
    // The compare-and-swap under the lease. Two callers meeting one
    // abandoned claim read the same `created_at`; only the first UPDATE
    // can match it.
    const key = `abandoned-${generateId()}`;
    const heldSince = new Date(Date.now() - 10 * 60_000).toISOString();
    const id = generateId();
    await ctx.storage.idempotency.claim({
      id,
      idempotency_key: key,
      fingerprint: "dead",
      created_at: heldSince,
    });

    const now = new Date().toISOString();
    const results = await Promise.all([
      ctx.storage.idempotency.takeOverExpiredClaim({
        id,
        fingerprint: "a",
        heldSince,
        now,
      }),
      ctx.storage.idempotency.takeOverExpiredClaim({
        id,
        fingerprint: "b",
        heldSince,
        now,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("reports a holder that vanished under it rather than claiming a row it never inserted", async () => {
    // The window this closes: an arrival loses the INSERT to a real
    // holder, and that holder is deleted before the follow-up read — a
    // `release()` after a 5xx, or the retention sweep, landing between the
    // two statements.
    //
    // **Only the timing of the delete is arranged.** The conflict is real,
    // the delete is a real `release()` of a real row, the read is the
    // store's own, and no branch of `claim` is stubbed. What cannot be
    // done from outside is the interleaving itself: it has to land inside
    // a single `claim()` call, and nothing in the harness can suspend one
    // mid-method, so the deleting caller is driven from the seam between
    // the two statements instead of from a second connection. Running two
    // callers concurrently and hoping to hit a two-statement gap would be
    // a test that passes by not reproducing anything.
    const key = `vanished-${generateId()}`;
    const holderId = generateId();
    const holderSince = new Date().toISOString();
    const first = await ctx.storage.idempotency.claim({
      id: holderId,
      idempotency_key: key,
      fingerprint: "one",
      created_at: holderSince,
    });
    expect(first.claimed).toBe(true);

    const store = ctx.storage.idempotency;
    const seam = store as unknown as {
      find(key: string): Promise<IdempotencyRecord | null>;
    };
    const realFind = seam.find.bind(store);
    let released = false;
    seam.find = async (k) => {
      await store.release(holderId, holderSince);
      released = true;
      return realFind(k);
    };

    const secondId = generateId();
    let second: IdempotencyClaim;
    try {
      second = await store.claim({
        id: secondId,
        idempotency_key: key,
        fingerprint: "two",
        created_at: new Date().toISOString(),
      });
    } finally {
      // Unshadow, so the prototype method serves every later case in this
      // file. A leaked stub here would quietly re-point the whole suite.
      delete (seam as { find?: unknown }).find;
    }

    // The delete really happened, so the rest of this is measuring the
    // window rather than an empty table.
    expect(released).toBe(true);

    expect(second.claimed).toBe(false);
    if (second.claimed) throw new Error("unreachable");
    expect(second.held).toBeNull();

    // And why it matters, measured rather than argued. Reporting
    // `claimed: true` here — which is what the first version of this did —
    // hands back a record id no row carries, so the outcome the caller
    // goes on to record is recorded against nothing and the next repeat of
    // the key writes for real.
    const recorded = await store.complete({
      id: secondId,
      heldSince: new Date().toISOString(),
      response_status: 201,
      response_content_type: "application/json",
      response_body: "{}",
      completed_at: new Date().toISOString(),
    });
    expect(recorded).toBe(false);
  });

  it("reports a completed outcome as recorded when the row is really there", async () => {
    // The other side of the assertion above. A `complete` that always
    // answered false would satisfy it while telling the caller nothing,
    // and the warning it drives would then fire on every write.
    const key = `completed-${generateId()}`;
    const id = generateId();
    const heldSince = new Date().toISOString();
    await ctx.storage.idempotency.claim({
      id,
      idempotency_key: key,
      fingerprint: "f",
      created_at: heldSince,
    });
    expect(
      await ctx.storage.idempotency.complete({
        id,
        heldSince,
        response_status: 201,
        response_content_type: "application/json",
        response_body: "{}",
        completed_at: new Date().toISOString(),
      }),
    ).toBe(true);
  });
});

/**
 * A takeover swaps the row in place and keeps its id, so an id names a row
 * and not a holder. Both later writes to that row are therefore fenced on
 * the `created_at` the caller took, and these are the two ways a displaced
 * writer would otherwise reach into a live claim it no longer owns.
 */
describe("a displaced writer cannot touch the claim that replaced it", () => {
  /** A stale claim, taken over by a second writer. Returns both fences. */
  async function displaced(prefix: string) {
    const key = `${prefix}-${generateId()}`;
    const id = generateId();
    // Past the middleware's lease, so a takeover is the legitimate move.
    const staleSince = new Date(Date.now() - 10 * 60_000).toISOString();
    await ctx.storage.idempotency.claim({
      id,
      idempotency_key: key,
      fingerprint: "slow-writer",
      created_at: staleSince,
    });

    const takenAt = new Date().toISOString();
    expect(
      await ctx.storage.idempotency.takeOverExpiredClaim({
        id,
        fingerprint: "taker",
        heldSince: staleSince,
        now: takenAt,
      }),
    ).toBe(true);

    return { key, id, staleSince, takenAt };
  }

  it("does not delete it on a 5xx release", async () => {
    // The sequence: A overruns its lease, B takes the claim over and is
    // writing, then A fails with a 5xx and releases. Unfenced, A's release
    // destroys B's live claim — B then records nothing and the next repeat
    // of the key writes for real, which is three writes for one logical
    // request. The two preconditions correlate: a saturated box produces
    // both the overrun and the 5xx.
    const { key, id, staleSince, takenAt } = await displaced("released");

    expect(await ctx.storage.idempotency.release(id, staleSince)).toBe(false);

    // The claim is still there and still B's, which is the whole point —
    // asserted by asking the store rather than by trusting the boolean.
    const probe = await ctx.storage.idempotency.claim({
      id: generateId(),
      idempotency_key: key,
      fingerprint: "third-arrival",
      created_at: new Date().toISOString(),
    });
    expect(probe.claimed).toBe(false);
    if (probe.claimed) throw new Error("unreachable");
    expect(probe.held).not.toBeNull();
    if (probe.held === null) throw new Error("unreachable");
    expect(probe.held.fingerprint).toBe("taker");
    expect(probe.held.created_at).toBe(takenAt);

    // And the holder can still give its own claim up, so the fence refuses
    // the displaced writer rather than freezing the row.
    expect(await ctx.storage.idempotency.release(id, takenAt)).toBe(true);
  });

  it("does not overwrite it when the displaced writer finishes", async () => {
    // The milder half of the same gap. A finishes late and completes;
    // unfenced, A's body lands on B's claim and is replayed to a third
    // arrival as the answer to a write B is still performing.
    const { key, id, staleSince, takenAt } = await displaced("overwritten");

    expect(
      await ctx.storage.idempotency.complete({
        id,
        heldSince: staleSince,
        response_status: 201,
        response_content_type: "application/json",
        response_body: '{"from":"the displaced writer"}',
        completed_at: new Date().toISOString(),
      }),
    ).toBe(false);

    // Still in flight under the taker's fence — not completed, and
    // carrying none of the displaced writer's body.
    const probe = await ctx.storage.idempotency.claim({
      id: generateId(),
      idempotency_key: key,
      fingerprint: "third-arrival",
      created_at: new Date().toISOString(),
    });
    expect(probe.claimed).toBe(false);
    if (probe.claimed) throw new Error("unreachable");
    expect(probe.held).not.toBeNull();
    if (probe.held === null) throw new Error("unreachable");
    expect(probe.held.state).toBe("in_flight");
    expect(probe.held.response_body).toBeNull();

    // The holder's own completion still lands, so this fences the wrong
    // writer rather than every writer.
    expect(
      await ctx.storage.idempotency.complete({
        id,
        heldSince: takenAt,
        response_status: 201,
        response_content_type: "application/json",
        response_body: '{"from":"the taker"}',
        completed_at: new Date().toISOString(),
      }),
    ).toBe(true);
  });
});

/**
 * Every write to a claim row is fenced, or is listed here with a reason.
 *
 * The defect this exists for was a rule kept at one door and not its
 * sibling: the takeover was a proper compare-and-swap on `created_at`, and
 * `release` and `complete` matched on id alone — so a writer displaced past
 * its lease could delete or overwrite the claim of the writer that had
 * replaced it. A takeover swaps in place and keeps the row id, which is
 * what makes an id a row rather than a holder, and nothing about the shape
 * of an unfenced `WHERE` looks wrong on its own.
 *
 * **The first version of this guard matched a vocabulary rather than
 * writers, and that is the failure it now exists twice to avoid.** It
 * anchored each match on the nearest preceding `async <name>(`, so
 * `takeOverExpiredClaim` was labeled `claim` and never appeared under its
 * own name — an exemption naming it would have exempted nothing, and one
 * naming `claim` would have silently exempted the takeover, with the
 * anti-dead-configuration check passing either way because both names
 * exist in the file. It also read whole statements rather than the `where`,
 * so a writer naming the column in a `set` or a `returning` would have
 * passed unfenced, and it could not see a hoisted `where` at all.
 *
 * So the source is parsed into methods by name and each method's `where` is
 * read on its own. What the guard reports is now the same set of things the
 * store actually does.
 */
describe("every writer of a claim row is fenced", () => {
  /**
   * Every method that touches the table, and what it does there.
   *
   * Asserted as an exact set, so a writer that disappears fails as loudly
   * as one that appears. A floor would tolerate the first.
   */
  const EXPECTED_METHODS: Record<string, string> = {
    claim: "creates",
    takeOverExpiredClaim: "mutates",
    complete: "mutates",
    release: "mutates",
    cleanup: "mutates",
    find: "reads",
  };

  /**
   * Mutating methods deliberately not fenced on an exact `created_at`,
   * each with the reason. Keyed on the real method name.
   */
  const UNFENCED: Record<string, string> = {
    cleanup:
      "The retention sweep, whose criterion IS age: it deletes on " +
      "`lt(created_at, cutoff)` rather than matching a holder. A claim it " +
      "could reach would have to be older than the whole retention window " +
      "while the lease is 60s, and a takeover moves `created_at` forward, " +
      "so it cannot delete a live claim.",
  };

  /** The store's source with comments stripped, so prose cannot be read
   *  as code. */
  function storeSource(): string {
    return readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "sqlite/idempotency-store.ts",
      ),
      "utf-8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
  }

  /** The balanced span starting at `open`, which must be a bracket. */
  function spanFrom(source: string, open: number, pair: [string, string]) {
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === pair[0]) depth += 1;
      else if (source[i] === pair[1]) {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    return "";
  }

  /**
   * Method name to method body, by brace matching rather than by proximity.
   *
   * Proximity is what produced the mislabeling this replaces: a regex
   * spanning from one `async` to a call site lands wherever the lazy match
   * stops, which is not necessarily inside that method at all.
   */
  function methodsOf(source: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of source.matchAll(
      /\n {2}(?:private |public |protected )?async (\w+)\s*\(/g,
    )) {
      const name = m[1];
      if (name === undefined) continue;
      const paramsAt = m.index + m[0].length - 1;
      const params = spanFrom(source, paramsAt, ["(", ")"]);
      const bodyAt = source.indexOf("{", paramsAt + params.length);
      if (bodyAt === -1) continue;
      out.set(name, spanFrom(source, bodyAt, ["{", "}"]));
    }
    return out;
  }

  /**
   * What a method does to the table, or `null` if it does not touch it.
   *
   * **Fails closed.** A method that names the table and matches none of the
   * shapes below — a raw `sql` execute, an aliased binding, anything not
   * thought of here — is `unrecognized` rather than absent, so it appears
   * in the roster and fails there. Returning `null` for it was the version
   * of this that let a writer spelled differently pass unseen, which is
   * the same defect as the mislabeling, one level up.
   *
   * These stores address one table, so a write call inside them is a write
   * to it; the call does not have to name the table for this to hold.
   */
  function operationOf(
    body: string,
  ): "creates" | "mutates" | "reads" | "unrecognized" | null {
    if (!/idempotencyRecords|idempotency_records/.test(body)) return null;
    if (body.includes(".select(")) return "reads";
    if (/\.(update|delete)\(|onConflictDoUpdate/.test(body)) return "mutates";
    if (body.includes(".insert(")) return "creates";
    return "unrecognized";
  }

  /**
   * The `where` argument alone, resolving a one-level hoisted binding.
   *
   * Scoped rather than read off the whole statement: a column named in a
   * `set` or a `returning` is not a fence, and reading the statement whole
   * cannot tell the difference. `cleanup` hoists its predicate, so a guard
   * that only understood the inline form would report a fenced writer in
   * that style as unfenced and invite a wrong exemption.
   */
  function whereOf(body: string): string {
    const at = body.indexOf(".where(");
    if (at === -1) return "";
    const span = spanFrom(body, at + ".where".length, ["(", ")"]);
    const arg = span.slice(1, -1).trim();
    if (!/^\w+$/.test(arg)) return arg;
    const hoisted = new RegExp(`const\\s+${arg}\\s*=\\s*([\\s\\S]*?);`).exec(
      body,
    );
    return hoisted?.[1] ?? arg;
  }

  it("touches the table in known ways only", () => {
    const found = new Map<string, string>();
    for (const [name, body] of methodsOf(storeSource())) {
      const op = operationOf(body);
      if (op !== null) found.set(name, op);
    }
    // An exact set in both directions. A new writer spelled some other way
    // lands here rather than passing unseen, and a writer that vanishes
    // fails rather than shrinking the guard's own input.
    expect(Object.fromEntries([...found].sort())).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_METHODS).sort()),
    );
  });

  it("fences the where of every mutating method", () => {
    const methods = methodsOf(storeSource());
    const unfenced: string[] = [];
    for (const [name, body] of methods) {
      if (operationOf(body) !== "mutates") continue;
      if (name in UNFENCED) continue;
      if (!whereOf(body).includes("eq(idempotencyRecords.created_at")) {
        unfenced.push(name);
      }
    }
    expect(
      unfenced.sort(),
      "A write to a claim row that does not match on created_at can land " +
        "on a row this caller no longer holds. Fence it, or add it to " +
        "UNFENCED with the reason it cannot.",
    ).toEqual([]);
  });

  it("holds every excuse to a method that really mutates", () => {
    // An excuse naming a method that does not exist, or one that never
    // writes, is dead configuration — and the shape it rots into is one
    // that silently exempts something it was never written for. That is
    // exactly what the mislabeled version of this guard did.
    for (const method of Object.keys(UNFENCED)) {
      const body = methodsOf(storeSource()).get(method);
      expect(
        body,
        `UNFENCED names ${method}, absent from the store`,
      ).toBeDefined();
      expect(
        operationOf(body ?? ""),
        `UNFENCED names ${method}, which does not mutate`,
      ).toBe("mutates");
    }
  });

  it("gives a reason for every method it leaves unfenced", () => {
    for (const [method, because] of Object.entries(UNFENCED)) {
      expect(because.length, `${method} carries no reason`).toBeGreaterThan(40);
    }
  });

  it("reads the where rather than the statement around it", () => {
    // The guard's own reader, proved on shapes rather than on the store —
    // the store is one sample and would agree with a reader that was wrong
    // in ways it happens not to exercise.
    expect(whereOf(".where(eq(t.id, x))")).toBe("eq(t.id, x)");
    // A hoisted predicate is the form `cleanup` uses.
    expect(whereOf("const w = and(a, b);\n.where(w)")).toBe("and(a, b)");
    // A column named outside the where is not a fence.
    expect(whereOf(".set({ created_at: x }).where(eq(t.id, y))")).not.toContain(
      "created_at",
    );
  });
});

describe("retention has one owner", () => {
  const indexTs = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts"),
    "utf-8",
  );

  it("sweeps from inside the event-log cleanup job", () => {
    // Read from the source because the property is about which job the
    // call sits in, and both jobs delete rows on the same cadence — a
    // behavioral test cannot tell one from the other.
    const start = indexTs.indexOf('name: "event-log-cleanup"');
    const job = indexTs.slice(start, indexTs.indexOf('name: "audit-cleanup"'));
    expect(start).toBeGreaterThan(-1);
    expect(job).toContain("storage.idempotency.cleanup(retention)");
  });

  it("is swept from nowhere else", () => {
    // A second sweeper would work, keep its own window, and drift from
    // this one silently. The count is the assertion.
    const calls = indexTs.match(/storage\.idempotency\.cleanup/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("registers no scheduled job of its own", () => {
    expect(indexTs).not.toContain("idempotency-cleanup");
  });
});
