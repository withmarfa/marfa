import { describe, it, expect, afterEach } from "vitest";
import {
  answers,
  refusal,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import type { DrainReport, QueuedWrite } from "../../device/protocol.js";
import { hydratedHarness, scriptWrites } from "./harness.js";
import type { Harness, ScriptedWrites } from "./harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * "Which failures retry, and which do not."
 *
 * The split is the whole of the classification and it is closed. A device
 * that retries the wrong class either loops on a refusal it will always get
 * or strands a good write behind a network that came back — and both of those
 * are silent, because the queue looks the same either way.
 */

const HELD = { id: "01a00000-0000-7000-8000-00000000000a", version: 3 };

/** The five, as the contract names them (`queue-and-verdicts.md` 26). */
const BLOCKED_REASONS = [
  "credential_refused",
  "key_spent",
  "ancestor_unavailable",
  "conflict_unresolved",
  "awaiting_dependency",
] as const;

function held() {
  return {
    "core.note": [
      {
        item: {
          id: HELD.id,
          version: HELD.version,
          properties: { title: "held", body: "held" },
        },
      },
    ],
  };
}

/** The row the server holds, for a refusal to be reconciled against. */
function serverRow(): ScriptedWrites["read"] {
  return [
    answers.updated(
      wireItem({
        id: HELD.id,
        version: HELD.version,
        properties: { title: "held", body: "held" },
      }),
    ),
  ];
}

/** Queue one update to the held row, script the answers, and drain `times`. */
async function drainAgainst(
  harness: Harness,
  writes: ScriptedWrites,
  times = 1,
): Promise<DrainReport[]> {
  const edit = await harness.device.update(HELD.id, {
    properties: { title: "edited" },
    version: HELD.version,
  });
  expect(
    edit.ok,
    `the fixture could not queue the write it is about to drain: ${JSON.stringify(edit)}`,
  ).toBe(true);
  scriptWrites(harness.server, writes);
  const reports: DrainReport[] = [];
  for (let attempt = 0; attempt < times; attempt += 1) {
    const drained = await harness.device.drain();
    expect(
      drained.ok,
      `a drain refused rather than answering the write: ${JSON.stringify(drained)}`,
    ).toBe(true);
    if (drained.ok) reports.push(drained.value);
  }
  return reports;
}

async function queueOf(harness: Harness): Promise<QueuedWrite[]> {
  const queued = await harness.device.queue();
  expect(
    queued.ok,
    `the device refused to report its queue: ${JSON.stringify(queued)}`,
  ).toBe(true);
  if (!queued.ok) throw new Error("unreachable: the assertion above threw");
  return queued.value;
}

describe("an environmental failure retries and is never counted", () => {
  it("retries an environmental failure past the ceiling without counting it", async () => {
    harness = await hydratedHarness("class-environmental", { rows: held() });
    // Six attempts, one past the ceiling. A device that counted them would
    // have killed the write on the fifth.
    const reports = await drainAgainst(
      harness,
      { update: [{ kind: "drop" }] },
      6,
    );
    for (const report of reports) {
      expect(
        report.verdicts[0]?.refusals,
        "a dropped connection was counted against the write, so an outage longer than five drains kills a write that was never refused",
      ).toBe(0);
      expect(
        report.verdicts[0]?.verdict,
        "a write nobody answered was given a verdict, and a device that could not ask has not been refused",
      ).toBeNull();
    }
    const row = (await queueOf(harness))[0];
    expect(
      row?.verdict,
      "six attempts past a network that never came back killed the write, so recovering it needs a person",
    ).toBeNull();
    // The control: the attempts happened. Without it a device that stopped
    // sending after the first failure would satisfy everything above.
    expect(
      harness.server.requests.filter((request) => request.method === "PATCH")
        .length,
      "the drain stopped attempting, so the counts above are the counts of nothing",
    ).toBe(6);
    expect(
      reports.map((report) => [report.answered, report.undelivered]),
      "a write that met a dropped connection was counted as answered, or not as waiting",
    ).toEqual(Array.from({ length: 6 }, () => [0, 1]));
  });

  it("ends the pass at the first write the server cannot take, leaving the rest untried and uncounted", async () => {
    harness = await hydratedHarness("class-environmental-ends", {
      rows: held(),
    });
    const { server, device } = harness;
    for (const title of ["first", "second", "third"]) {
      const queued = await device.create({
        type: "core.note",
        properties: { title },
      });
      expect(queued.ok, JSON.stringify(queued)).toBe(true);
    }
    const took = (request: { body: string }) => {
      const sent = JSON.parse(request.body) as {
        id: string;
        properties: Record<string, unknown>;
      };
      return answers.created(
        wireItem({ id: sent.id, properties: sent.properties }),
      );
    };
    scriptWrites(server, {
      create: [
        { kind: "drop" },
        refusal(503, "unavailable", "busy"),
        {
          kind: "json",
          status: 429,
          body: { error: { code: "rate_limited", message: "slow down" } },
          headers: { "Retry-After": "9" },
        },
        took,
      ],
    });
    const creates = () =>
      server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ).length;

    const said: Array<string | null> = [];
    for (const expected of [1, 2, 3]) {
      const drained = await device.drain();
      expect(drained.ok, JSON.stringify(drained)).toBe(true);
      if (!drained.ok) return;
      expect(
        creates(),
        "a drain went on to the writes behind one the server could not take, so an unreachable server costs a timeout for every write in the queue",
      ).toBe(expected);
      expect(
        [drained.value.answered, drained.value.undelivered],
        "a drain that reached no server counted a write as answered, or did not say three wait",
      ).toEqual([0, 3]);
      said.push(drained.value.unavailable);
    }
    expect(said[0], "a drain that reached no server did not say so").toMatch(
      /could not be reached/,
    );
    expect(said[1]).toContain("503");
    expect(said[2]).toContain("429");
    const queue = await queueOf(harness);
    expect(
      queue.map((row) => [row.verdict, row.refusals]),
      "a write the server never took was given a verdict or counted",
    ).toEqual([
      [null, 0],
      [null, 0],
      [null, 0],
    ]);

    // The witness: once the server takes writes, all three go in one drain.
    const back = await device.drain();
    expect(back.ok && [back.value.answered, back.value.undelivered]).toEqual([
      3, 0,
    ]);
    expect(back.ok && back.value.unavailable).toBeNull();
    expect(creates()).toBe(6);
  });

  it("counts only the writes the server answered, and says why the rest were not delivered", async () => {
    harness = await hydratedHarness("class-counts", { rows: held() });
    const { server, device } = harness;
    for (const title of ["refused", "unsent"]) {
      expect(
        (await device.create({ type: "core.note", properties: { title } })).ok,
      ).toBe(true);
    }
    scriptWrites(server, {
      create: [
        refusal(400, "invalid_properties", "no such property"),
        { kind: "drop" },
      ],
      // A refused create is read back, and the server holds no such row.
      read: [refusal(404, "item_not_found", "no such item")],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    expect(
      {
        answered: drained.value.answered,
        undelivered: drained.value.undelivered,
      },
      "the report counted a write the server never answered, so an app shows offline as saved",
    ).toEqual({ answered: 1, undelivered: 1 });
    expect(drained.value.unavailable).toMatch(/could not be reached/);
    expect(drained.value.verdicts.map((verdict) => verdict.verdict)).toEqual([
      "refused",
      null,
    ]);
  });

  it.each([undefined, null])(
    "passes on the wait a read reconciling a refusal was asked for (contract %s)",
    async (contract) => {
      harness = await hydratedHarness("class-read-waits", { rows: held() });
      const { server, device } = harness;
      expect(
        (
          await device.update(HELD.id, {
            properties: { title: "edited" },
            version: HELD.version,
          })
        ).ok,
      ).toBe(true);
      scriptWrites(server, {
        update: [refusal(400, "invalid_properties", "not a title")],
        read: [
          {
            kind: "json",
            status: 429,
            contract,
            body: { error: { code: "rate_limited", message: "slow down" } },
            headers: { "Retry-After": "7" },
          },
        ],
      });
      const drained = await device.drain();
      expect(drained.ok, JSON.stringify(drained)).toBe(true);
      if (!drained.ok) return;
      expect(drained.value.unavailable).toMatch(/429|rate/);
      expect(
        drained.value.retry_after_seconds,
        "the wait the server asked for on the read was lost, so a caller asks again at once",
      ).toBe(7);
    },
  );

  it("counts the writes it settled without sending apart from those the server answered", async () => {
    harness = await hydratedHarness("class-unsent", { rows: held() });
    const { server, device } = harness;
    const created = await device.create({
      type: "core.note",
      properties: { title: "refused" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const edited = await device.update(created.value.item_id ?? "", {
      properties: { title: "behind it" },
      version: 0,
    });
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    scriptWrites(server, {
      create: [refusal(400, "invalid_properties", "no such property")],
      read: [refusal(404, "item_not_found", "no such item")],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    expect(
      {
        answered: drained.value.answered,
        unsent: drained.value.unsent,
        undelivered: drained.value.undelivered,
        held: drained.value.held,
      },
      "the report's counts did not account for every write the pass came to",
    ).toEqual({ answered: 1, unsent: 1, undelivered: 0, held: 0 });
    // The witness: the edit was refused by the drain, never sent.
    expect(
      server.requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(0);
  });

  it("ends the pass at a read the server cannot answer, sending nothing after it", async () => {
    harness = await hydratedHarness("class-read-ends", { rows: held() });
    const { server, device } = harness;
    const edit = await device.update(HELD.id, {
      properties: { title: "edited" },
      version: HELD.version,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    expect(
      (
        await device.create({
          type: "core.note",
          properties: { title: "behind" },
        })
      ).ok,
    ).toBe(true);
    scriptWrites(server, {
      update: [refusal(400, "invalid_properties", "not a title")],
      read: [{ kind: "drop" }, { kind: "drop" }, ...(serverRow() ?? [])],
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as { id: string };
          return answers.created(wireItem({ id: sent.id }));
        },
      ],
    });
    const creates = () =>
      server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ).length;

    const first = await device.drain();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(
      creates(),
      "the pass went on to the write behind a refusal whose read could not reach the server",
    ).toBe(0);
    expect(first.ok && [first.value.answered, first.value.undelivered]).toEqual(
      [1, 1],
    );
    expect(first.ok && first.value.unavailable).toMatch(/could not be reached/);

    // The read owed is tried first, and still cannot reach the server.
    const second = await device.drain();
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(
      creates(),
      "a drain sent a write when the read owed before it could not reach the server",
    ).toBe(0);
    expect(second.ok && second.value.unavailable).toMatch(
      /could not be reached/,
    );

    // The witness: once the read lands, the write behind it goes.
    const third = await device.drain();
    expect(third.ok && third.value.answered).toBe(1);
    expect(creates()).toBe(1);
  });

  it("retries a 5xx and a 429 without counting them", async () => {
    harness = await hydratedHarness("class-5xx", { rows: held() });
    const reports = await drainAgainst(
      harness,
      {
        update: [
          {
            kind: "json",
            status: 503,
            body: { error: { code: "unavailable" } },
          },
          {
            kind: "json",
            status: 429,
            body: { error: { code: "rate_limited" } },
            headers: { "Retry-After": "12" },
          },
          answers.updated(wireItem({ id: HELD.id, version: 4 })),
        ],
      },
      3,
    );
    expect(
      reports.slice(0, 2).map((report) => report.verdicts[0]?.refusals),
      "a 5xx or a 429 spent the ceiling, and both of them clear without anybody doing anything",
    ).toEqual([0, 0]);
    expect(
      reports[1]?.retry_after_seconds,
      "the server said how long to wait and the device did not pass it on, so a caller draining in a loop ignores it",
    ).toBe(12);
    // And the write lands once the server is back, which is the point of
    // not counting: nothing had to release it.
    expect(
      reports[2]?.verdicts[0]?.verdict,
      "a write that waited out an outage was not taken when the server returned, so the outage cost the write",
    ).toBe("accepted");
  });
});

describe("a contract failure does not retry", () => {
  it("refuses a contract failure on the first answer", async () => {
    harness = await hydratedHarness("class-contract", { rows: held() });
    const [first] = await drainAgainst(harness, {
      update: [refusal(400, "invalid_properties", "body is required")],
      read: serverRow(),
    });
    expect(
      first?.verdicts[0]?.verdict,
      "a 400 was retried, and the same request sent again is the same request: the device would spend the ceiling on identical refusals",
    ).toBe("refused");
    expect(first?.verdicts[0]?.reason).toBe("invalid_properties");

    const before = harness.server.requests.filter(
      (request) => request.method === "PATCH",
    ).length;
    expect((await harness.device.drain()).ok).toBe(true);
    expect(
      harness.server.requests.filter((request) => request.method === "PATCH")
        .length,
      "a refused write went out a second time",
    ).toBe(before);
  });
});

describe("the class that is neither retries and is counted", () => {
  it("counts a write whose answer the copy cannot take, and goes on to the next", async () => {
    harness = await hydratedHarness("class-local", { rows: held() });
    const { server, device } = harness;
    const edit = await device.update(HELD.id, {
      properties: { title: "edited" },
      version: HELD.version,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    expect(
      (
        await device.create({
          type: "core.note",
          properties: { title: "next" },
        })
      ).ok,
    ).toBe(true);
    // A state this build does not know: the server took the write, and the
    // copy cannot hold the row it answered.
    scriptWrites(server, {
      update: [
        answers.updated(wireItem({ id: HELD.id, version: 4, state: "frozen" })),
      ],
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as { id: string };
          return answers.created(wireItem({ id: sent.id }));
        },
      ],
    });
    const drained = await device.drain();
    expect(
      drained.ok,
      `a drain failed whole on an answer the copy could not take, so every write behind it waits on it for good: ${JSON.stringify(drained)}`,
    ).toBe(true);
    if (!drained.ok) return;
    const [update, create] = drained.value.verdicts;
    expect(
      [update?.verdict, update?.refusals],
      "a write whose answer the copy could not take was not counted, so it is retried forever",
    ).toEqual([null, 1]);
    expect(
      create?.verdict,
      "the write behind one the copy could not take was not sent",
    ).toBe("accepted");
  });

  it("retries an answer it cannot read, and counts it", async () => {
    harness = await hydratedHarness("class-unreadable", { rows: held() });
    const reports = await drainAgainst(
      harness,
      { update: [{ kind: "json", status: 200, body: "not an answer" }] },
      2,
    );
    expect(
      reports.map((report) => report.verdicts[0]?.refusals),
      "a success the device could not read was not counted, so `dead` is a verdict nothing reaches and the device retries forever",
    ).toEqual([1, 2]);
    expect(
      reports[0]?.verdicts[0]?.verdict,
      "an answer the device could not read was called accepted, so the copy reports a write the device cannot say the server took",
    ).toBeNull();
  });

  it("retries a key the server reports in flight, and counts it", async () => {
    harness = await hydratedHarness("class-in-flight", { rows: held() });
    const reports = await drainAgainst(
      harness,
      {
        update: [
          refusal(409, "idempotency_key_in_flight", "still answering"),
          refusal(409, "idempotency_key_in_flight", "still answering"),
          answers.updated(wireItem({ id: HELD.id, version: 4 })),
        ],
      },
      3,
    );
    expect(
      reports.slice(0, 2).map((report) => report.verdicts[0]?.refusals),
      "a key the server has not finished answering was not counted, so a write that will never settle retries forever",
    ).toEqual([1, 2]);
    // A 409 that is neither of the two blocking ones: the status alone does
    // not decide, and this is the case that says so.
    expect(
      reports[0]?.verdicts[0]?.verdict,
      "a key still in flight was blocked or refused, and a further attempt clears it",
    ).toBeNull();
    expect(
      reports[2]?.verdicts[0]?.verdict,
      "the write was not taken once the server finished with the key",
    ).toBe("accepted");
  });
});

describe("the three refusals that park a write", () => {
  it("blocks the whole queue on a refused credential, and stops the drain", async () => {
    harness = await hydratedHarness("class-401", { rows: held() });
    const first = await harness.device.update(HELD.id, {
      properties: { title: "one" },
      version: HELD.version,
    });
    const second = await harness.device.create({
      type: "core.note",
      properties: { title: "two", body: "two" },
    });
    const third = await harness.device.create({
      type: "core.note",
      properties: { title: "three", body: "three" },
    });
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    scriptWrites(harness.server, {
      update: [refusal(401, "unauthorized", "this key was revoked")],
      create: [answers.created(wireItem({ id: "unused" }))],
    });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;

    expect(
      drained.value.answered,
      "the drain worked through a queue every row of which carries the same refused credential, spending a request per row to be told the same thing",
    ).toBe(1);
    expect(
      drained.value.stopped,
      "the drain did not say why it stopped, so a caller sees a short pass and no reason",
    ).not.toBeNull();

    const queue = await queueOf(harness);
    expect(
      queue.map((row) => row.verdict),
      "a refused credential parked only the row that met it, and every other row carries the same credential",
    ).toEqual(["blocked", "blocked", "blocked"]);
    for (const row of queue) {
      expect(row.reason).toBe("credential_refused");
      expect(
        row.refusals,
        "a refused credential spent the ceiling, so a key left unreplaced for five drains kills the queue",
      ).toBe(0);
    }
  });

  it("blocks a spent key on the first refusal rather than spending the ceiling", async () => {
    harness = await hydratedHarness("class-key-spent", { rows: held() });
    const [first] = await drainAgainst(harness, {
      update: [
        refusal(422, "idempotency_key_reused", "answered for another body"),
      ],
    });
    expect(
      first?.verdicts[0]?.verdict,
      "a spent key was retried, and re-sending the same key cannot clear it: the ceiling would be spent on five identical refusals and the row parked under a reason naming the wrong cause",
    ).toBe("blocked");
    expect(first?.verdicts[0]?.reason).toBe("key_spent");
    expect(
      first?.verdicts[0]?.refusals,
      "the first refusal of a spent key was counted, and it is the key that is spent rather than the write",
    ).toBe(0);
  });

  it("blocks a write whose base version the server no longer holds", async () => {
    harness = await hydratedHarness("class-ancestor", { rows: held() });
    const [first] = await drainAgainst(harness, {
      update: [
        refusal(409, "ancestor_unavailable", "no snapshot of that version"),
      ],
    });
    expect(
      first?.verdicts[0]?.verdict,
      "a write naming a version the server cannot reconstruct was retried, and the same write re-sent is refused identically however often anyone sends it",
    ).toBe("blocked");
    expect(first?.verdicts[0]?.reason).toBe("ancestor_unavailable");
  });

  it("blocks a conflict the server declined to resolve", async () => {
    harness = await hydratedHarness("class-conflict", { rows: held() });
    const [first] = await drainAgainst(harness, {
      update: [refusal(409, "version_conflict", "the row moved under this")],
    });
    expect(
      first?.verdicts[0]?.verdict,
      "a conflict the server declined to resolve was retried or refused, and this device cannot settle it itself: it reports and stops",
    ).toBe("blocked");
    expect(first?.verdicts[0]?.reason).toBe("conflict_unresolved");
  });
});

describe("the ceiling, and releasing what it stopped", () => {
  it("counts refusals rather than attempts, so a long outage does not exhaust the ceiling", async () => {
    harness = await hydratedHarness("class-outage", { rows: held() });
    // Ten attempts nobody answered, then one counted refusal. The count is
    // one, not eleven: a device that could not ask has not been refused.
    const reports = await drainAgainst(
      harness,
      {
        update: [
          ...Array.from({ length: 10 }, () => ({ kind: "drop" }) as const),
          { kind: "json", status: 200, body: "not an answer" },
        ],
      },
      11,
    );
    expect(
      reports.map((report) => report.verdicts[0]?.refusals),
      "attempts were counted rather than refusals, so a week offline exhausts a ceiling that exists for failures the server actually gave",
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("reaches the ceiling on the fifth refusal", async () => {
    harness = await hydratedHarness("class-ceiling", { rows: held() });
    const reports = await drainAgainst(
      harness,
      { update: [{ kind: "json", status: 200, body: "not an answer" }] },
      6,
    );
    expect(
      reports.slice(0, 4).map((report) => report.verdicts[0]?.verdict),
      "the write died before the fifth refusal, so the ceiling is some number smaller than the one the contract fixes",
    ).toEqual([null, null, null, null]);
    expect(
      reports[4]?.verdicts[0]?.verdict,
      "the fifth refusal did not reach the ceiling, so the ceiling is some number larger than the one the contract fixes",
    ).toBe("dead");
    // The sixth drain does not send it at all, which is what terminal means.
    expect(
      reports[5]?.answered,
      "a dead write was sent again, so reaching the ceiling stopped nothing",
    ).toBe(0);
  });

  it("reports one of the five blocked reasons and no other", async () => {
    // Every answer that blocks, each in its own store, and the set of
    // reasons they produce compared against the five. Both directions: a
    // reason outside the five is a store no later build reads, and a reason
    // in the five that nothing produces is a promise the device cannot keep.
    const reached = new Set<string>();
    const blocking: ScriptedWrites[] = [
      { update: [refusal(401, "unauthorized", "revoked")] },
      { update: [refusal(422, "idempotency_key_reused", "spent")] },
      { update: [refusal(409, "ancestor_unavailable", "no snapshot")] },
      { update: [refusal(409, "version_conflict", "moved")] },
    ];
    for (const [index, writes] of blocking.entries()) {
      const own = await hydratedHarness(`class-reasons-${String(index)}`, {
        rows: held(),
      });
      try {
        const [report] = await drainAgainst(own, writes);
        const reason = report?.verdicts[0]?.reason;
        expect(
          reason,
          `a blocking answer produced no reason at all: ${JSON.stringify(report)}`,
        ).not.toBeNull();
        if (reason !== null && reason !== undefined) reached.add(reason);
      } finally {
        await own.stop();
      }
    }

    // The fifth comes from a dependency rather than from an answer, which
    // is why reading only the refusals would leave it looking unreachable.
    const waiting = await hydratedHarness("class-reasons-dependency", {
      rows: held(),
    });
    try {
      const created = await waiting.device.create({
        type: "core.note",
        properties: { title: "parent", body: "parent" },
      });
      expect(created.ok).toBe(true);
      if (created.ok) {
        const edit = await waiting.device.update(created.value.item_id ?? "a", {
          properties: { title: "child" },
          version: 0,
        });
        expect(edit.ok).toBe(true);
        scriptWrites(waiting.server, { create: [{ kind: "drop" }] });
        expect((await waiting.device.drain()).ok).toBe(true);
        const row = (await queueOf(waiting)).find(
          (row) => edit.ok && row.id === edit.value.id,
        );
        expect(row?.reason).not.toBeNull();
        if (row?.reason != null) reached.add(row.reason);
      }
    } finally {
      await waiting.stop();
    }

    expect(
      [...reached].sort(),
      "the reasons this device can reach are not the five the contract names: a reason outside them is one the store refuses to record, and one inside them that nothing produces is a promise nothing keeps",
    ).toEqual([...BLOCKED_REASONS].sort());
  });

  it("releases a held write when its dependency is answered", async () => {
    harness = await hydratedHarness("class-release-dependency", {
      rows: held(),
    });
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "parent", body: "parent" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.item_id ?? "a";
    const edit = await harness.device.update(id, {
      properties: { title: "child" },
      version: 0,
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;

    // Both answers before the first drain: a door with one answer left
    // repeats it, so an answer appended afterwards queues behind the one
    // still in play and reads as the device ignoring it.
    scriptWrites(harness.server, {
      create: [{ kind: "drop" }, answers.created(wireItem({ id, version: 1 }))],
      update: [answers.updated(wireItem({ id, version: 2 }))],
    });
    // The create fails to reach the server, so the update is held.
    expect((await harness.device.drain()).ok).toBe(true);
    expect(
      (await queueOf(harness)).find((row) => row.id === edit.value.id)?.reason,
      "the update was not held although the create it waits for never landed",
    ).toBe("awaiting_dependency");

    // Now the create is answered. Nothing releases the update: it is
    // released by the dependency being answered and by nothing a caller does.
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts.map((verdict) => verdict.verdict),
      "the held write was not released when its create was answered, so it waits for a caller who was never told to release it",
    ).toEqual(["accepted", "accepted"]);
    // And within one drain rather than needing a second, because the create
    // that released it was answered in this same pass.
    expect(
      drained.value.answered,
      "the create and the write it released did not both go in one pass, so every dependency costs an extra drain",
    ).toBe(2);
  });

  it("will not release a write the server itself refused, dependency or not", async () => {
    harness = await hydratedHarness("class-release-server-refusal", {
      rows: held(),
    });
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "parent", body: "parent" },
    });
    expect(
      created.ok,
      `the create was refused, so there is no dependency for the update to carry: ${JSON.stringify(created)}`,
    ).toBe(true);
    if (!created.ok) return;
    const id = created.value.item_id ?? "a";
    // The update names the create, so it carries a dependency — and is then
    // refused by the server on its own merits. The two facts together are
    // the case: a release that read the dependency alone would clear a
    // terminal refusal and send the write a second time.
    const edit = await harness.device.update(id, {
      properties: { title: "child" },
      version: 0,
    });
    expect(
      edit.ok,
      `the update was not queued, so nothing below is about a refused dependant: ${JSON.stringify(edit)}`,
    ).toBe(true);
    if (!edit.ok) return;

    scriptWrites(harness.server, {
      create: [answers.created(wireItem({ id, version: 1 }))],
      update: [refusal(400, "invalid_properties", "not a title")],
      // The refusal is reconciled, which reads the server's row back.
      read: [
        answers.updated(
          wireItem({
            id,
            version: 1,
            properties: { title: "parent", body: "parent" },
          }),
        ),
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);

    const row = (await queueOf(harness)).find((it) => it.id === edit.value.id);
    expect(
      row?.verdict,
      "the update was not refused by the server at all, so the release below is about the wrong row",
    ).toBe("refused");
    expect(
      row?.depends_on ?? [],
      "the refused update carries no dependency, so releasing it could not have been confused for the never-sent case this guards",
    ).not.toEqual([]);

    const released = await harness.device.release({ id: edit.value.id });
    expect(
      released.ok,
      `the release door errored rather than declining: ${JSON.stringify(released)}`,
    ).toBe(true);
    if (!released.ok) return;
    expect(
      released.value,
      "a write the server refused was released because it happened to carry a dependency, so a terminal refusal is sent again and content the caller watched disappear comes back",
    ).toBe(0);
    expect(
      (await queueOf(harness)).find((it) => it.id === edit.value.id)?.verdict,
      "the refused verdict was cleared, so the next drain sends a write the server already refused",
    ).toBe("refused");
  });

  it("sends a released row again under a fresh key", async () => {
    harness = await hydratedHarness("class-release-key", { rows: held() });
    const [first] = await drainAgainst(harness, {
      update: [
        refusal(422, "idempotency_key_reused", "answered for another body"),
        answers.updated(wireItem({ id: HELD.id, version: 4 })),
      ],
    });
    expect(first?.verdicts[0]?.verdict).toBe("blocked");
    const blocked = (await queueOf(harness))[0];
    expect(blocked).toBeDefined();
    if (blocked === undefined) return;

    const released = await harness.device.release({ id: blocked.id });
    expect(
      released.ok,
      `the device refused to release a blocked row: ${JSON.stringify(released)}`,
    ).toBe(true);
    if (!released.ok) return;
    expect(released.value).toBe(1);

    const after = (await queueOf(harness))[0];
    expect(
      after?.verdict,
      "a released row kept its verdict, so a drain still passes over it",
    ).toBeNull();
    expect(
      after?.idempotency_key,
      "a released row went back out under the key that was answered for another body, which is the same refusal that blocked it: releasing would mean nothing",
    ).not.toBe(blocked.idempotency_key);
    expect(
      after?.refusals,
      "a released row kept the refusals it had, so the next counted failure kills it at once",
    ).toBe(0);

    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts[0]?.verdict,
      "a released row was not sent again, so a release is a state change nothing acts on",
    ).toBe("accepted");
    const keys = harness.server.requests
      .filter((request) => request.method === "PATCH")
      .map((request) => request.headers["idempotency-key"]);
    expect(
      new Set(keys).size,
      "the two attempts went under one key, so the server answered the second from the record of the first",
    ).toBe(2);
  });

  it("releases by reason the rows blocked for it, and never a dead one", async () => {
    const DEAD = { id: "01a00000-0000-7000-8000-00000000000d", version: 2 };
    harness = await hydratedHarness("class-release-reason", {
      rows: {
        "core.note": [
          ...held()["core.note"],
          {
            item: {
              id: DEAD.id,
              version: DEAD.version,
              properties: { title: "dying", body: "dying" },
            },
          },
        ],
      },
    });
    const { device, server } = harness;
    for (const [id, version] of [
      [HELD.id, HELD.version],
      [DEAD.id, DEAD.version],
    ] as const) {
      const edit = await device.update(id, {
        properties: { title: "edited" },
        version,
      });
      expect(edit.ok, JSON.stringify(edit)).toBe(true);
    }
    // One row meets a spent key and is blocked on the first answer; the
    // other is answered unreadably until the ceiling kills it.
    scriptWrites(server, {
      update: [
        (request) =>
          request.pathname === `/items/${HELD.id}`
            ? refusal(
                422,
                "idempotency_key_reused",
                "answered for another body",
              )
            : { kind: "json", status: 200, body: "not an answer" },
      ],
    });
    for (let pass = 0; pass < 5; pass += 1) {
      expect((await device.drain()).ok).toBe(true);
    }
    const settled = await queueOf(harness);
    const settledOf = (id: string) => {
      const row = settled.find((queued) => queued.item_id === id);
      return [row?.verdict, row?.reason];
    };
    // The blocked row's reason is the witness that the queue reports the
    // column the dead row leaves empty.
    expect(
      [settledOf(HELD.id), settledOf(DEAD.id)],
      "the fixture did not reach one row blocked for a spent key and one dead one carrying no reason, so the release below is about neither",
    ).toEqual([
      ["blocked", "key_spent"],
      ["dead", null],
    ]);

    const released = await device.release({ reason: "key_spent" });
    expect(released.ok, JSON.stringify(released)).toBe(true);
    if (!released.ok) return;
    expect(
      released.value,
      "a release by reason took a row it does not name, and a dead write goes out again under a fresh key with nobody having asked for it",
    ).toBe(1);
    const after = await queueOf(harness);
    const now = (id: string) => after.find((row) => row.item_id === id);
    expect(now(HELD.id)?.verdict).toBeNull();
    expect(
      now(DEAD.id)?.verdict,
      "a release by reason released a dead write",
    ).toBe("dead");

    // The witness: the dead row is one a release takes, by its id.
    const dead = now(DEAD.id);
    expect(dead).toBeDefined();
    if (dead === undefined) return;
    const byId = await device.release({ id: dead.id });
    expect(byId.ok && byId.value).toBe(1);
  });

  it("blocks a create naming a source its key does not claim, and sends it once the key does", async () => {
    harness = await hydratedHarness("class-unclaimed-source", {
      rows: held(),
    });
    const { device, server } = harness;
    // The key claims `notes` only once this flips, as an operator granting
    // the claim would make it.
    let claimed = false;
    const minted = new Map<string, string>();
    scriptWrites(server, {
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            id?: string;
            source?: string;
            source_id?: string;
            properties: Record<string, unknown>;
          };
          if (sent.source === "notes" && !claimed) {
            return refusal(
              403,
              "forbidden",
              'This credential may not write under the source "notes".',
              { source: "notes" },
            );
          }
          // A refusal naming the source beside anything else is not the
          // claim refusal, which names the source and nothing more.
          if (sent.source === "wider") {
            return refusal(403, "forbidden", "Refused for another reason", {
              source: "wider",
              reason: "something else",
            });
          }
          // The allow-list's refusal: the same status and code, naming the
          // list beside the source (`types.md` 18).
          if (sent.source === "listed") {
            return refusal(
              403,
              "forbidden",
              'Source "listed" is not in the allow-list for type core.note',
              { type: "core.note", source: "listed", allowed: ["other"] },
            );
          }
          const key = sent.source_id ?? sent.id ?? "";
          const id =
            sent.id ??
            minted.get(key) ??
            `01a00000-0000-7000-8000-0000000000${String(10 + minted.size)}`;
          minted.set(key, id);
          return answers.created(
            wireItem({
              id,
              version: 1,
              properties: sent.properties,
              ...(sent.source === undefined ? {} : { source: sent.source }),
              ...(sent.source_id === undefined
                ? {}
                : { source_id: sent.source_id }),
            }),
          );
        },
      ],
      update: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            version: number;
            properties: Record<string, unknown>;
          };
          return answers.updated(
            wireItem({
              id: request.pathname.split("/").at(-1) ?? "",
              version: sent.version + 1,
              properties: sent.properties,
            }),
          );
        },
      ],
      read: [refusal(404, "item_not_found", "no such item")],
      edges: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            id?: string;
            source_id?: string;
            target_id?: string;
            version?: number;
          };
          return request.method === "POST"
            ? writeAnswers.edge({
                id: sent.id ?? "",
                source_id: sent.source_id ?? "",
                target_id: sent.target_id ?? "",
              })
            : writeAnswers.edge({
                id: request.pathname.split("/").at(-1) ?? "",
                source_id: minted.get("a.md") ?? "",
                target_id: HELD.id,
                version: (sent.version ?? 0) + 1,
              });
        },
      ],
    });

    const first = await device.create({
      type: "core.note",
      properties: { title: "a", body: "a" },
      source: "notes",
      sourceId: "a.md",
      version: 0,
    });
    const second = await device.create({
      type: "core.note",
      properties: { title: "b", body: "b" },
      source: "notes",
      sourceId: "b.md",
      version: 0,
    });
    const own = await device.create({
      type: "core.note",
      properties: { title: "own", body: "own" },
    });
    const listed = await device.create({
      type: "core.note",
      properties: { title: "listed", body: "listed" },
      source: "listed",
      sourceId: "listed.md",
      version: 0,
    });
    const wider = await device.create({
      type: "core.note",
      properties: { title: "wider", body: "wider" },
      source: "wider",
      sourceId: "wider.md",
      version: 0,
    });
    expect(wider.ok).toBe(true);
    expect(first.ok && second.ok && own.ok && listed.ok).toBe(true);
    if (!first.ok || !second.ok || !own.ok || !listed.ok) return;
    const local = first.value.item_id ?? "";
    const other = await device.update(HELD.id, {
      properties: { title: "held, edited" },
      version: HELD.version,
    });
    expect(other.ok).toBe(true);

    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    const verdictOf = (id: string) =>
      drained.value.verdicts.find((entry) => entry.id === id);
    expect(
      [verdictOf(first.value.id)?.verdict, verdictOf(first.value.id)?.reason],
      "a create refused for a claim its key does not hold was refused as a write, so a claim granted afterwards would send nothing",
    ).toEqual(["blocked", "credential_refused"]);
    expect(
      [verdictOf(second.value.id)?.verdict, verdictOf(second.value.id)?.reason],
      "a second create naming the same source was not stopped with the first",
    ).toEqual(["blocked", "credential_refused"]);
    expect(
      server.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/items" &&
          request.body.includes('"notes"'),
      ),
      "every create naming the unclaimed source went out, one refusal per create",
    ).toHaveLength(1);
    // Only that source: the rest of the queue carries on, and the drain does
    // not stop as it does for a refused credential.
    expect(verdictOf(own.value.id)?.verdict).toBe("accepted");
    expect(verdictOf(other.ok ? other.value.id : "")?.verdict).toBe("accepted");
    expect(drained.value.stopped).toBeNull();
    expect(
      [verdictOf(listed.value.id)?.verdict, verdictOf(listed.value.id)?.reason],
      "a source allow-list's refusal was read as a missing claim, which no claim granted can clear",
    ).toEqual(["refused", "forbidden"]);
    expect(
      [
        verdictOf(wider.ok ? wider.value.id : "")?.verdict,
        verdictOf(wider.ok ? wider.value.id : "")?.reason,
      ],
      "a refusal naming more than the source was read as a missing claim",
    ).toEqual(["refused", "forbidden"]);
    expect(
      drained.value.unclaimed_sources,
      "the drain did not say which source the key does not claim, and `credential_refused` alone reads as a key that no longer works",
    ).toEqual(["notes"]);

    // Nothing was reconciled away: the row the create was queued as is still
    // held, and an edit of it waits for the create rather than going to an id
    // the server does not hold.
    expect((await device.get(local)).ok).toBe(true);
    const edit = await device.update(local, {
      properties: { title: "a, edited" },
      version: 0,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    if (!edit.ok) return;
    expect(
      edit.value.depends_on,
      "an edit of a row whose create is blocked did not wait for it, so it goes out to an id the server never held and is refused",
    ).toEqual([first.value.id]);
    // An edge from that row waits for the create as well.
    const linked = await device.createEdge({
      source: local,
      target: HELD.id,
      type: "references",
    });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) return;
    expect(linked.value.depends_on).toEqual([first.value.id]);

    // Still unclaimed: one create finds that out, and nothing else is sent.
    const before = server.requests.length;
    const again = await device.drain();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      server.requests
        .slice(before)
        .map((request) => `${request.method} ${request.pathname}`)
        .filter((sent) => sent !== "GET /"),
    ).toEqual(["POST /items"]);
    // The edge's create is held behind the row's now, and an edit of the edge
    // waits for it in turn rather than going to an edge the server lacks.
    const reworded = await device.updateEdge(linked.value.edge_id ?? "", {
      properties: { note: "reworded" },
      version: 0,
    });
    expect(reworded.ok, JSON.stringify(reworded)).toBe(true);
    if (!reworded.ok) return;
    expect(
      reworded.value.depends_on,
      "an edit of an edge whose create is held did not wait for it",
    ).toEqual([linked.value.id]);

    // The key claims the source now. The next drain sends both creates and
    // the edit, on the version the create was answered with, with no release.
    claimed = true;
    const granted = await device.drain();
    expect(granted.ok, JSON.stringify(granted)).toBe(true);
    if (!granted.ok) return;
    const grantedOf = (id: string) =>
      granted.value.verdicts.find((entry) => entry.id === id)?.verdict;
    expect(
      [
        grantedOf(first.value.id),
        grantedOf(second.value.id),
        grantedOf(edit.value.id),
        grantedOf(linked.value.id),
        grantedOf(reworded.value.id),
      ],
      "a create blocked for a claim was not sent once the key claimed the source",
    ).toEqual(["accepted", "accepted", "accepted", "accepted", "accepted"]);
    expect(granted.value.unclaimed_sources).toEqual([]);
    const patch = server.requests
      .filter(
        (request) =>
          request.method === "PATCH" && request.pathname.startsWith("/items/"),
      )
      .at(-1);
    expect(patch?.pathname).toBe(`/items/${minted.get("a.md") ?? ""}`);
    expect(
      (JSON.parse(patch?.body ?? "{}") as { version?: number }).version,
    ).toBe(1);
  });
});

describe("withdrawing a write that can never be sent", () => {
  /** The row the server holds once another device has moved it on. */
  function movedOn(): ScriptedWrites["read"] {
    return [
      answers.updated(
        wireItem({
          id: HELD.id,
          version: HELD.version + 2,
          properties: { title: "theirs", body: "theirs" },
        }),
      ),
    ];
  }

  it("withdraws a write blocked ancestor_unavailable or conflict_unresolved, and puts the row back as the server holds it", async () => {
    for (const [reason, refused] of [
      [
        "ancestor_unavailable",
        refusal(409, "ancestor_unavailable", "no snapshot of that version"),
      ],
      [
        "conflict_unresolved",
        refusal(409, "version_conflict", "the row moved under this"),
      ],
    ] as const) {
      const own = await hydratedHarness(`class-withdraw-${reason}`, {
        rows: held(),
      });
      try {
        const [first] = await drainAgainst(own, {
          update: [refused],
          read: movedOn(),
        });
        expect(
          [first?.verdicts[0]?.verdict, first?.verdicts[0]?.reason],
          "the write was not blocked, so the withdraw below is about some other row",
        ).toEqual(["blocked", reason]);
        const blocked = (await queueOf(own))[0];
        if (blocked === undefined) throw new Error("the queue lost the row");
        // The witness: a blocked write is laid over the row (35), so the
        // copy shows the edit until something takes it away.
        const before = await own.device.get(HELD.id);
        expect(before.ok && before.value.properties.title).toBe("edited");

        const withdrawn = await own.device.withdraw(blocked.id);
        expect(withdrawn.ok, JSON.stringify(withdrawn)).toBe(true);
        if (!withdrawn.ok) return;
        expect(
          withdrawn.value,
          `a write blocked ${reason} was not withdrawn, so an app shows text the server will never take for as long as it runs`,
        ).toBe(true);
        expect(
          await queueOf(own),
          "the withdrawn write is still queued, so a release or a reason clearing sends it again to be refused the same way",
        ).toEqual([]);
        const after = await own.device.get(HELD.id);
        expect(after.ok).toBe(true);
        if (!after.ok) return;
        expect(
          [after.value.properties.title, after.value.version],
          "the copy still shows the withdrawn edit, or the version it was based on, rather than the row the server holds",
        ).toEqual(["theirs", HELD.version + 2]);

        const sent = own.server.requests.filter(
          (request) => request.method === "PATCH",
        ).length;
        expect((await own.device.drain()).ok).toBe(true);
        expect(
          own.server.requests.filter((request) => request.method === "PATCH")
            .length,
          "a drain after the withdraw sent the write again",
        ).toBe(sent);
      } finally {
        await own.stop();
      }
    }
  });

  it("lays a write still waiting back over the row a withdraw puts back", async () => {
    harness = await hydratedHarness("class-withdraw-lays-over", {
      rows: held(),
    });
    const { device, server } = harness;
    const [first] = await drainAgainst(harness, {
      update: [
        refusal(409, "ancestor_unavailable", "no snapshot of that version"),
        { kind: "drop" },
      ],
      read: movedOn(),
    });
    expect(first?.verdicts[0]?.reason).toBe("ancestor_unavailable");
    const blocked = (await queueOf(harness))[0];
    if (blocked === undefined) throw new Error("the queue lost the row");

    // A second edit, of another property, goes out and has no answer, so
    // it is still waiting when the first is withdrawn.
    const body = await device.update(HELD.id, {
      properties: { body: "mine" },
      version: HELD.version,
    });
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect((await device.drain()).ok).toBe(true);
    expect(
      (await queueOf(harness)).find((row) => row.id !== blocked.id)?.verdict,
      "the second edit was answered, so nothing below is about a write still waiting",
    ).toBeNull();

    const withdrawn = await device.withdraw(blocked.id);
    expect(withdrawn.ok && withdrawn.value, JSON.stringify(withdrawn)).toBe(
      true,
    );
    const after = await device.get(HELD.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.properties,
      "the row a withdraw put back dropped the edit still waiting, or kept the withdrawn one",
    ).toMatchObject({ title: "theirs", body: "mine" });
    expect(server.unmatchedRequests).toEqual([]);
  });

  it("will not withdraw a write that may yet land or be released", async () => {
    harness = await hydratedHarness("class-withdraw-refuses", {
      rows: held(),
    });
    const { device } = harness;
    const edit = await device.update(HELD.id, {
      properties: { title: "edited" },
      version: HELD.version,
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    scriptWrites(harness.server, {
      update: [
        refusal(422, "idempotency_key_reused", "answered for another body"),
        refusal(409, "ancestor_unavailable", "no snapshot of that version"),
      ],
      read: movedOn(),
    });

    const unanswered = await device.withdraw(edit.value.id);
    expect(unanswered.ok, JSON.stringify(unanswered)).toBe(true);
    expect(
      unanswered.ok && unanswered.value,
      "a write that has not been answered was withdrawn, and it may yet land",
    ).toBe(false);

    expect((await device.drain()).ok).toBe(true);
    expect((await queueOf(harness))[0]?.reason).toBe("key_spent");
    const spent = await device.withdraw(edit.value.id);
    expect(
      spent.ok && spent.value,
      "a write blocked for a spent key was withdrawn, and a release sends it under a fresh one",
    ).toBe(false);
    expect((await queueOf(harness))[0]?.reason).toBe("key_spent");

    const unknown = await device.withdraw("not-a-queued-write");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.refusal.code).toBe("not_found");

    // The witness: the same row, once blocked for a reason no sending
    // clears, is one a withdraw takes.
    const released = await device.release({ id: edit.value.id });
    expect(released.ok && released.value).toBe(1);
    expect((await device.drain()).ok).toBe(true);
    expect((await queueOf(harness))[0]?.reason).toBe("ancestor_unavailable");
    const taken = await device.withdraw(edit.value.id);
    expect(taken.ok && taken.value, JSON.stringify(taken)).toBe(true);
  });

  it("changes nothing when it cannot read the row back", async () => {
    harness = await hydratedHarness("class-withdraw-unread", {
      rows: held(),
    });
    const { device } = harness;
    const [first] = await drainAgainst(harness, {
      update: [
        refusal(409, "ancestor_unavailable", "no snapshot of that version"),
      ],
      read: [{ kind: "drop" }, ...(movedOn() ?? [])],
    });
    expect(first?.verdicts[0]?.reason).toBe("ancestor_unavailable");
    const blocked = (await queueOf(harness))[0];
    if (blocked === undefined) throw new Error("the queue lost the row");

    const failed = await device.withdraw(blocked.id);
    expect(
      failed.ok,
      "a withdraw that could not read the row back answered as though it had",
    ).toBe(false);
    expect(
      (await queueOf(harness)).map((row) => [row.id, row.reason]),
      "a withdraw that could not read the row back took the write out of the queue anyway",
    ).toEqual([[blocked.id, "ancestor_unavailable"]]);
    const kept = await device.get(HELD.id);
    expect(
      kept.ok && kept.value.properties.title,
      "a withdraw that could not read the row back changed the copy",
    ).toBe("edited");

    // The witness: the same withdraw, once the server answers, goes.
    const withdrawn = await device.withdraw(blocked.id);
    expect(withdrawn.ok && withdrawn.value, JSON.stringify(withdrawn)).toBe(
      true,
    );
  });

  /**
   * A create stopped on a row it cannot read (`queue-and-verdicts.md` 39),
   * with an edit of its row held for it.
   */
  async function createHeldFor(label: string): Promise<{
    harness: Harness;
    create: QueuedWrite;
    edit: QueuedWrite;
    local: string;
  }> {
    const own = await hydratedHarness(label, { rows: held() });
    const GONE = "01a00000-0000-7000-8000-0000000000c9";
    const created = await own.device.create({
      type: "core.note",
      properties: { title: "mine", body: "mine" },
      source: "notes",
      sourceId: "gone.md",
      version: 0,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable: the assertion above threw");
    const local = created.value.item_id ?? "";
    scriptWrites(own.server, {
      create: [
        answers.ancestorUnavailable(
          {
            id: GONE,
            version: 2,
            properties: { title: "gone" },
            tier: "library",
            occurred_at: "2026-01-01T00:00:00.000Z",
            source_id: "gone.md",
            type: "core.note",
          },
          0,
        ),
      ],
      // Neither the row the key resolved nor the one minted here is one
      // the server holds.
      read: [refusal(404, "item_not_found", "Item not found")],
    });
    expect((await own.device.drain()).ok).toBe(true);
    const edit = await own.device.update(local, {
      properties: { title: "mine, edited" },
      version: 0,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    if (!edit.ok) throw new Error("unreachable: the assertion above threw");
    expect((await own.device.drain()).ok).toBe(true);
    const queue = await queueOf(own);
    const create = queue.find((row) => row.id === created.value.id);
    const held_ = queue.find((row) => row.id === edit.value.id);
    expect(
      [create?.reason, held_?.depends_on],
      "the create was not blocked with the edit held for it, so nothing below is about a write held for a withdrawn one",
    ).toEqual(["ancestor_unavailable", [created.value.id]]);
    if (create === undefined || held_ === undefined)
      throw new Error("unreachable: the assertion above threw");
    return { harness: own, create, edit: held_, local };
  }

  it("refuses unsent the writes held for a withdrawn create, and never releases them", async () => {
    const setup = await createHeldFor("class-withdraw-held");
    harness = setup.harness;
    const { device, server } = harness;
    // The witness: before the withdraw, the minted row is held.
    expect((await device.get(setup.local)).ok).toBe(true);

    const withdrawn = await device.withdraw(setup.create.id);
    expect(withdrawn.ok && withdrawn.value, JSON.stringify(withdrawn)).toBe(
      true,
    );
    const queue = await queueOf(harness);
    expect(
      queue.map((row) => [row.id, row.verdict]),
      "the edit held for the withdrawn create was not refused, so it waits forever for a write the queue no longer holds",
    ).toEqual([[setup.edit.id, "refused"]]);
    expect(
      queue[0]?.reason,
      "the refusal does not name the withdrawn write it waited for",
    ).toBe("the create_item it waits for was withdrawn");
    const gone = await device.get(setup.local);
    expect(
      gone.ok,
      "the copy kept the row a withdrawn create minted, which exists nowhere",
    ).toBe(false);

    const released = await device.release({ id: setup.edit.id });
    expect(released.ok, JSON.stringify(released)).toBe(true);
    expect(
      released.ok && released.value,
      "a write refused for a withdrawn create was released, and it then waits for a write the queue no longer holds",
    ).toBe(0);
    expect((await device.drain()).ok).toBe(true);
    expect(
      server.requests.filter((request) => request.method === "PATCH"),
      "a write held for a withdrawn create was sent",
    ).toEqual([]);
  });

  it("clears with the answered rows those only a withdrawn write was keeping, but for one carrying content", async () => {
    const setup = await createHeldFor("class-withdraw-forget-held");
    harness = setup.harness;
    const { device } = harness;
    // The witness: before the withdraw, clearing keeps both, the blocked
    // create a caller may still release and the edit waiting on it.
    const kept = await device.forget();
    expect(kept.ok && kept.value, JSON.stringify(kept)).toBe(0);
    expect(await queueOf(harness)).toHaveLength(2);

    expect((await device.withdraw(setup.create.id)).ok).toBe(true);
    // The edit held for the create carries what a person wrote, so it stays
    // refused until it is discarded (`queue-and-verdicts.md` 47).
    const cleared = await device.forget();
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect(
      cleared.ok && cleared.value,
      "clearing took the edit refused for a withdrawn create, and the words it carried with it",
    ).toBe(0);
    expect(
      (await queueOf(harness)).map((row) => [row.id, row.verdict]),
    ).toEqual([[setup.edit.id, "refused"]]);
    const discarded = await device.discard(setup.edit.id);
    expect(discarded.ok && discarded.value, JSON.stringify(discarded)).toBe(
      true,
    );
    expect(await queueOf(harness)).toEqual([]);

    // And an answered create kept only by an edit of its row that was
    // blocked: clearing keeps it while the edit may be released, and clears
    // it once the edit is withdrawn.
    const answered = await hydratedHarness("class-withdraw-forget-answered", {
      rows: held(),
    });
    try {
      const created = await answered.device.create({
        type: "core.note",
        properties: { title: "parent", body: "parent" },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.item_id ?? "";
      const edit = await answered.device.update(id, {
        properties: { title: "child" },
        version: 0,
      });
      expect(edit.ok).toBe(true);
      if (!edit.ok) return;
      scriptWrites(answered.server, {
        create: [answers.created(wireItem({ id, version: 1 }))],
        update: [
          refusal(409, "ancestor_unavailable", "no snapshot of that version"),
        ],
        read: [
          answers.updated(
            wireItem({ id, version: 2, properties: { title: "theirs" } }),
          ),
        ],
      });
      expect((await answered.device.drain()).ok).toBe(true);
      expect(
        (await queueOf(answered)).map((row) => row.verdict),
        "the create was not answered with the edit of its row blocked behind it",
      ).toEqual(["accepted", "blocked"]);
      const before = await answered.device.forget();
      expect(
        before.ok && before.value,
        "clearing took the answered create a blocked edit depends on, so a release of that edit waits for a write that is gone",
      ).toBe(0);

      expect((await answered.device.withdraw(edit.value.id)).ok).toBe(true);
      const after = await answered.device.forget();
      expect(
        after.ok && after.value,
        "clearing kept the answered create after the only write keeping it was withdrawn",
      ).toBe(1);
      expect(await queueOf(answered)).toEqual([]);
    } finally {
      await answered.stop();
    }
  });
});
