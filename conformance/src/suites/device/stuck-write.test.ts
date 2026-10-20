import { rmSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  refusal,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import type { DrainReport, QueuedWrite } from "../../device/protocol.js";
import type { Answer } from "../../device/scripted-server.js";
import type { RecordedRequest } from "../../device/scripted-server.js";
import {
  fileOf,
  hashOf,
  hydratedHarness,
  scriptWrites,
  type Harness,
  type ScriptedWrites,
} from "./harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  delete process.env.MARFA_TEST_FAULT;
});

/**
 * The store's clock, moved to `minutes` ahead of the real one by the debug
 * build's `clock-offset` fault, for every command that follows. A write is a
 * suspect only once its streak began five minutes ago, and no fixture waits
 * that long. A negative step is a clock that went backward.
 */
function clockAt(minutes: number): void {
  process.env.MARFA_TEST_FAULT = `clock-offset=${Math.round(minutes * 60_000)}`;
}

/**
 * "A write that keeps meeting an environmental failure."
 *
 * The device cannot tell a server that is down from a gateway that refuses
 * one particular write in the same words, so a write the gateway refuses
 * would end every pass at itself for good. These fixtures drive that case
 * with the answers a real proxy gives, and the outages and rate limits that
 * must never be mistaken for it.
 */

const HELD = { id: "01a00000-0000-7000-8000-00000000000a", version: 3 };

const HTML_413 =
  "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n" +
  "<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n" +
  "<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";

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

/** What a gateway in front of the server answers, naming no contract. */
function gateway(status: number, text: string): Answer {
  return {
    kind: "json",
    status,
    contract: null,
    body: null,
    raw: text,
    headers: { "Content-Type": "text/html" },
  };
}

/** `POST /blobs` taking the bytes it is sent. */
function takeUpload(request: RecordedRequest): Answer {
  return writeAnswers.uploaded(
    hashOf(request.raw),
    request.headers["content-type"] ?? "",
    request.raw.length,
  );
}

function createdAs(request: RecordedRequest): Answer {
  const sent = JSON.parse(request.body) as {
    id: string;
    properties?: Record<string, unknown>;
  };
  return answers.created(
    wireItem({ id: sent.id, properties: sent.properties }),
  );
}

function titleOf(request: RecordedRequest): string {
  const sent = JSON.parse(request.body) as {
    properties?: { title?: string };
  };
  return sent.properties?.title ?? "";
}

/** The read that settles a write the server took. */
function readBack(request: RecordedRequest): Answer {
  return answers.updated(
    wireItem({
      id: request.pathname.split("/")[2],
      version: HELD.version + 1,
      properties: { title: "edited", body: "held" },
    }),
  );
}

function scripted(server: Harness["server"], writes: ScriptedWrites): void {
  scriptWrites(server, { read: [readBack], ...writes });
}

/** The edit's answer, and the read that settles it. */
function editLands(harness: Harness): void {
  scriptWrites(harness.server, {
    update: [
      answers.updated(
        wireItem({
          id: HELD.id,
          version: HELD.version + 1,
          properties: { title: "edited", body: "held" },
        }),
      ),
    ],
    read: [
      (request) =>
        answers.updated(
          wireItem({
            id: request.pathname.split("/")[2],
            version: HELD.version + 1,
            properties: { title: "edited", body: "held" },
          }),
        ),
    ],
  });
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

async function drainOnce(harness: Harness): Promise<DrainReport> {
  const drained = await harness.device.drain();
  expect(
    drained.ok,
    `a drain refused rather than reporting: ${JSON.stringify(drained)}`,
  ).toBe(true);
  if (!drained.ok) throw new Error("unreachable: the assertion above threw");
  return drained.value;
}

async function note(harness: Harness, title: string): Promise<QueuedWrite> {
  const queued = await harness.device.create({
    type: "core.note",
    properties: { title, body: title },
  });
  expect(queued.ok, JSON.stringify(queued)).toBe(true);
  if (!queued.ok) throw new Error("unreachable: the assertion above threw");
  return queued.value;
}

async function edit(harness: Harness): Promise<QueuedWrite> {
  const queued = await harness.device.update(HELD.id, {
    properties: { title: "edited" },
    version: HELD.version,
  });
  expect(queued.ok, JSON.stringify(queued)).toBe(true);
  if (!queued.ok) throw new Error("unreachable: the assertion above threw");
  return queued.value;
}

function requestsTo(harness: Harness, method: string, pathname: string) {
  return harness.server.requests.filter(
    (request) => request.method === method && request.pathname === pathname,
  );
}

/**
 * An upload a gateway refuses with a `413` naming no contract, an edit to a
 * row, and a new note behind it, which is the queue the issue was found in.
 */
async function stuckUpload(label: string) {
  const own = await hydratedHarness(label, { rows: held() });
  harness = own;
  const upload = await own.device.putBlob(
    fileOf("big.bin", "bytes the gateway will not take\n"),
    "application/octet-stream",
  );
  expect(upload.ok, JSON.stringify(upload)).toBe(true);
  if (!upload.ok) throw new Error("unreachable: the assertion above threw");
  const edited = await edit(own);
  const noted = await note(own, "behind the upload");
  let refused = true;
  own.server.answer("POST", "/blobs", (request) =>
    refused ? gateway(413, HTML_413) : takeUpload(request),
  );
  editLands(own);
  scripted(own.server, {
    create: [createdAs],
    read: [
      (request) =>
        answers.updated(
          wireItem({
            id: request.pathname.split("/")[2],
            version: HELD.version + 1,
            properties: { title: "edited", body: "held" },
          }),
        ),
    ],
  });
  return {
    harness: own,
    upload: upload.value,
    edited,
    noted,
    mend: () => {
      refused = false;
    },
  };
}

/**
 * Three drains close together, which bring a write's streak to three with
 * the failure minutes old at most, then a drain six minutes on, which is the
 * first that can make it a suspect (`queue-and-verdicts/stuck-write-suspect`).
 * `from` is the minute the first of the three is at.
 */
async function reachSuspect(own: Harness, from = 0): Promise<DrainReport> {
  clockAt(from);
  for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
  clockAt(from + 6);
  return drainOnce(own);
}

describe("a write that keeps meeting an environmental failure", () => {
  it("sets the write aside as failing_alone only five minutes on, once the server takes the write behind it and it fails again", async () => {
    const {
      harness: own,
      upload,
      edited,
      noted,
    } = await stuckUpload("stuck-aside");
    const first = await drainOnce(own);
    const second = await drainOnce(own);
    // The pass ends at the write, as it does for an outage: nothing behind it
    // is sent while the streak is short of three.
    expect(
      [first.undelivered, second.undelivered],
      "a drain that met an environmental failure did not leave the writes undelivered",
    ).toEqual([3, 3]);
    expect(
      requestsTo(own, "PATCH", `/items/${HELD.id}`).length +
        requestsTo(own, "POST", "/items").length,
      "the pass went on past the write while the streak was short of three",
    ).toBe(0);
    expect(requestsTo(own, "POST", "/blobs")).toHaveLength(2);
    expect(
      (await queueOf(own)).map((row) => [row.verdict, row.refusals]),
      "an environmental failure was given a verdict or counted as a refusal",
    ).toEqual([
      [null, 0],
      [null, 0],
      [null, 0],
    ]);

    // The third drain brings the streak to three, and the failure is
    // seconds old: not yet a suspect, so the pass ends as before.
    const third = await drainOnce(own);
    expect(
      [third.undelivered, third.verdicts.map((verdict) => verdict.verdict)],
      "a streak of three, with the failure seconds old, made the write a suspect",
    ).toEqual([3, [null]]);
    expect(requestsTo(own, "POST", "/blobs")).toHaveLength(3);
    clockAt(4);
    const fourth = await drainOnce(own);
    expect(
      [fourth.undelivered, fourth.verdicts.map((verdict) => verdict.verdict)],
      "a failure four minutes old made the write a suspect",
    ).toEqual([3, [null]]);
    expect(requestsTo(own, "POST", "/blobs")).toHaveLength(4);

    // Six minutes on it is one: the write behind it is sent, and once it
    // has landed the suspect is sent again, meets the failure again, and is
    // set aside.
    clockAt(6);
    const seen = await drainSeen(own);
    expect(
      writesOf(seen.requests),
      "the drain did not send the suspect, the write that tests it, and the suspect again, then the rest of the queue",
    ).toEqual([UPLOAD, `PATCH /items/${HELD.id}`, UPLOAD, CREATE]);
    expect(
      seen.report.verdicts.map((verdict) => [
        verdict.id,
        verdict.verdict,
        verdict.reason,
      ]),
      "the drain did not report the write set aside, or did not send the writes behind it",
    ).toEqual([
      [upload.id, "blocked", "failing_alone"],
      [edited.id, "accepted", null],
      [noted.id, "accepted", null],
    ]);
    expect(
      [seen.report.unavailable, seen.report.undelivered, seen.report.answered],
      "the drain that set a write aside still reported the server unavailable",
    ).toEqual([null, 0, 3]);
    const queue = await queueOf(own);
    expect(
      queue.map((row) => [row.id, row.verdict, row.reason, row.refusals]),
    ).toEqual([
      [upload.id, "blocked", "failing_alone", 0],
      [edited.id, "accepted", null, 0],
      [noted.id, "accepted", null, 0],
    ]);
    // The streak counts the drain the suspect met the failure in once: the
    // send again in the same drain adds nothing.
    expect(queue[0]?.environmental_streak).toBe(5);
    expect(requestsTo(own, "POST", "/blobs")).toHaveLength(6);
    const sentBefore = own.server.requests.length;
    const after = await drainOnce(own);
    expect(
      [after.undelivered, after.unavailable],
      "a write set aside was sent again by the next drain",
    ).toEqual([0, null]);
    expect(own.server.requests.length).toBe(sentBefore);
  });

  it("shows what a write set aside last met, bounded, in the queue", async () => {
    const { harness: own, upload } = await stuckUpload("stuck-shows");
    await reachSuspect(own);
    const row = (await queueOf(own)).find((write) => write.id === upload.id);
    expect(
      row?.last_failure,
      "the queue does not say what the write set aside met",
    ).toEqual({
      status: 413,
      text: expect.stringContaining("413 Request Entity Too Large"),
    });
    expect(row?.last_failure?.text, "the page was kept as markup").not.toMatch(
      /[\r\n]/,
    );
    expect(row?.environmental_streak).toBe(4);
  });

  it("keeps only the start of a long body, and nothing of one made of control characters", async () => {
    const { harness: own, upload } = await stuckUpload("stuck-bounded");
    const long = `<html>${"word ".repeat(2000)}</html>`;
    let body: Answer = gateway(413, long);
    own.server.answer("POST", "/blobs", () => body);
    // The route is already scripted by the fixture; a drain consults the
    // first responder, so replace what it answers from the outside.
    own.server.answer("POST", "/blobs", () => body);
    await reachSuspect(own);
    const text = (await queueOf(own)).find((write) => write.id === upload.id)
      ?.last_failure?.text;
    expect(text?.startsWith("<html>word word")).toBe(true);
    expect(
      text?.length,
      "the whole of a long page was kept in the queue",
    ).toBeLessThanOrEqual(300);

    // The same write released, then met with a body that is no text.
    const released = await own.device.release({ id: upload.id });
    expect(released.ok && released.value).toBe(1);
    body = gateway(413, "\u0000\u0001\u0002 not a page");
    // Another write to test it with, as the first round had.
    await note(own, "second round");
    await reachSuspect(own, 20);
    const row = (await queueOf(own)).find((write) => write.id === upload.id);
    expect(
      [row?.verdict, row?.reason, row?.last_failure],
      "a body that is not text was kept as text",
    ).toEqual(["blocked", "failing_alone", { status: 413, text: null }]);
  });

  it("sends a write set aside again when it is released, under the streak counted afresh", async () => {
    const { harness: own, upload, mend } = await stuckUpload("stuck-release");
    await reachSuspect(own);
    expect(
      (await queueOf(own)).find((write) => write.id === upload.id)?.reason,
    ).toBe("failing_alone");

    mend();
    const released = await own.device.release({ id: upload.id });
    expect(released.ok && released.value).toBe(1);
    const row = (await queueOf(own)).find((write) => write.id === upload.id);
    expect(
      [row?.verdict, row?.environmental_streak, row?.last_failure],
      "a release left the streak or the last failure of a write it took back",
    ).toEqual([null, 0, null]);
    const report = await drainOnce(own);
    expect(
      report.verdicts.map((verdict) => verdict.verdict),
      "the write released was not sent again",
    ).toEqual(["accepted"]);
  });

  it("releases a write set aside by its reason", async () => {
    const { harness: own, upload, mend } = await stuckUpload("stuck-reason");
    await reachSuspect(own);
    mend();
    const released = await own.device.release({ reason: "failing_alone" });
    expect(released.ok && released.value, JSON.stringify(released)).toBe(1);
    expect(
      (await queueOf(own)).find((write) => write.id === upload.id)?.verdict,
    ).toBeNull();
  });

  it("withdraws a write set aside, and sends nothing for it after", async () => {
    const { harness: own, upload } = await stuckUpload("stuck-withdraw");
    await reachSuspect(own);
    const withdrawn = await own.device.withdraw(upload.id);
    expect(withdrawn.ok, JSON.stringify(withdrawn)).toBe(true);
    expect(
      withdrawn.ok && withdrawn.value,
      "a write set aside as failing_alone was not withdrawn, so only a release could take it from the queue",
    ).toBe(true);
    expect(
      (await queueOf(own)).map((write) => write.id),
      "the withdrawn write is still queued",
    ).not.toContain(upload.id);
    const sent = requestsTo(own, "POST", "/blobs").length;
    await drainOnce(own);
    expect(requestsTo(own, "POST", "/blobs")).toHaveLength(sent);
  });

  it("does not take a write set aside back at the start of a drain", async () => {
    const { harness: own, upload, mend } = await stuckUpload("stuck-stays");
    await reachSuspect(own);
    // The server would take it now, and it is still not sent: only a person
    // releases it.
    mend();
    await note(own, "later");
    await drainOnce(own);
    await drainOnce(own);
    expect(
      (await queueOf(own)).find((write) => write.id === upload.id)?.reason,
      "a drain took a write set aside back without a release",
    ).toBe("failing_alone");
    expect(requestsTo(own, "POST", "/blobs")).toHaveLength(5);
  });

  it("sets aside a create the server answers with a 500 it names its contract for", async () => {
    harness = await hydratedHarness("stuck-create", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    const edited = await edit(own);
    const noted = await note(own, "behind");
    scripted(own.server, {
      create: [
        (request) =>
          titleOf(request) === "stuck"
            ? refusal(500, "internal_error", "the server failed")
            : createdAs(request),
      ],
      read: [
        (request) =>
          answers.updated(
            wireItem({
              id: request.pathname.split("/")[2],
              version: HELD.version + 1,
              properties: { title: "edited", body: "held" },
            }),
          ),
      ],
      update: [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: HELD.version + 1,
            properties: { title: "edited", body: "held" },
          }),
        ),
      ],
    });
    const fourth = await reachSuspect(own);
    expect(
      fourth.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
      "a create the server fails every time still held the writes behind it",
    ).toEqual([
      [stuck.id, "blocked"],
      [edited.id, "accepted"],
      [noted.id, "accepted"],
    ]);
    const row = (await queueOf(own)).find((write) => write.id === stuck.id);
    expect(row?.reason).toBe("failing_alone");
    expect(row?.last_failure?.status).toBe(500);
    // A release sends it again, under a fresh key.
    const keyBefore = row?.idempotency_key;
    expect((await own.device.release({ id: stuck.id })).ok).toBe(true);
    expect(
      (await queueOf(own)).find((write) => write.id === stuck.id)
        ?.idempotency_key,
    ).not.toBe(keyBefore);
  });

  it("shows a write whose connection dies every time as having had no answer", async () => {
    harness = await hydratedHarness("stuck-no-answer", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    const noted = await note(own, "behind");
    scripted(own.server, {
      create: [
        (request) =>
          titleOf(request) === "stuck" ? { kind: "drop" } : createdAs(request),
      ],
    });
    await reachSuspect(own);
    const queue = await queueOf(own);
    expect(queue.map((row) => [row.id, row.verdict, row.reason])).toEqual([
      [stuck.id, "blocked", "failing_alone"],
      [noted.id, "accepted", null],
    ]);
    expect(
      queue[0]?.last_failure,
      "a write nothing answered was shown with an answer",
    ).toEqual({ status: null, text: null });
  });
});

describe("what is not a write failing alone", () => {
  it("sets nothing aside in an outage that fails every write, however long it lasts", async () => {
    harness = await hydratedHarness("stuck-outage", { rows: held() });
    const own = harness;
    await note(own, "first");
    await note(own, "second");
    await note(own, "third");
    scripted(own.server, { create: [createdAs] });
    await own.server.offline();
    for (let drain = 0; drain < 8; drain += 1) {
      const report = await drainOnce(own);
      expect(
        [report.answered, report.unavailable === null],
        "a drain against a server that could not be reached reported an answer, or no outage",
      ).toEqual([0, false]);
    }
    const queue = await queueOf(own);
    expect(
      queue.map((row) => [row.verdict, row.refusals]),
      "a long outage set a write aside or counted a refusal",
    ).toEqual([
      [null, 0],
      [null, 0],
      [null, 0],
    ]);
    expect(
      queue.map((row) => row.environmental_streak),
      "an outage counted toward setting a write aside",
    ).toEqual([0, 0, 0]);
    // The witness: when the server returns, all three go in one drain.
    await own.server.online();
    const back = await drainOnce(own);
    expect(back.answered).toBe(3);
    expect(back.undelivered).toBe(0);
  });

  it("sets nothing aside while a server fails every write for a few drains and then recovers", async () => {
    harness = await hydratedHarness("stuck-short", { rows: held() });
    const own = harness;
    await note(own, "first");
    await note(own, "second");
    let down = true;
    scripted(own.server, {
      create: [
        (request) =>
          down ? refusal(503, "unavailable", "restarting") : createdAs(request),
      ],
    });
    // Five drains a minute apart: the streak is five, and the first failure
    // four minutes old.
    for (let drain = 0; drain < 5; drain += 1) {
      clockAt(drain);
      const report = await drainOnce(own);
      expect(report.answered).toBe(0);
    }
    expect(
      (await queueOf(own)).map((row) => [
        row.verdict,
        row.environmental_streak,
      ]),
      "a short outage set a write aside, or did not count its drains",
    ).toEqual([
      [null, 5],
      [null, 0],
    ]);
    down = false;
    clockAt(5);
    const back = await drainOnce(own);
    expect(
      back.verdicts.map((verdict) => verdict.verdict),
      "the writes did not land when the server came back",
    ).toEqual(["accepted", "accepted"]);
    expect(
      (await queueOf(own)).map((row) => row.environmental_streak),
      "the run of a write that landed was not set back to nothing",
    ).toEqual([0, 0]);
  });

  it("sets nothing aside while the server limits requests, and sends nothing behind the write", async () => {
    harness = await hydratedHarness("stuck-limited", { rows: held() });
    const own = harness;
    const first = await note(own, "first");
    await note(own, "second");
    scripted(own.server, {
      create: [
        {
          kind: "json",
          status: 429,
          body: { error: { code: "rate_limited", message: "slow down" } },
          headers: { "Retry-After": "7" },
        },
      ],
    });
    for (let drain = 0; drain < 6; drain += 1) {
      const report = await drainOnce(own);
      expect(report.retry_after_seconds).toBe(7);
    }
    const queue = await queueOf(own);
    expect(
      requestsTo(own, "POST", "/items"),
      "the pass went on past a write the server limited",
    ).toHaveLength(6);
    expect(queue.map((row) => row.verdict)).toEqual([null, null]);
    expect(
      queue.map((row) => row.environmental_streak),
      "a rate limit counted toward setting a write aside",
    ).toEqual([0, 0]);
    expect(queue[0]?.id).toBe(first.id);
    expect(
      queue.map((row) => row.last_failure?.status ?? null),
      "the queue does not show the rate limit the write last met",
    ).toEqual([429, null]);
  });

  it("shows a 429 as the last answer a write met, without adding to its streak, and a failure after it in its place", async () => {
    harness = await hydratedHarness("stuck-429-shown", { rows: held() });
    const own = harness;
    const queued = await own.device.putBlob(
      fileOf("big.bin", "bytes the gateway will not take\n"),
      "application/octet-stream",
    );
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    const upload = queued.value;
    let limited = false;
    own.server.answer("POST", "/blobs", () =>
      limited
        ? {
            kind: "json",
            status: 429,
            body: { error: { code: "rate_limited", message: "slow down" } },
            headers: { "Retry-After": "7" },
          }
        : gateway(413, HTML_413),
    );
    await drainOnce(own);
    await drainOnce(own);
    const state = async () => {
      const row = (await queueOf(own)).find((write) => write.id === upload.id);
      return [row?.environmental_streak, row?.last_failure?.status];
    };
    expect(await state()).toEqual([2, 413]);
    limited = true;
    await drainOnce(own);
    expect(
      await state(),
      "the queue still showed the failure before the rate limit, or the rate limit counted in the streak",
    ).toEqual([2, 429]);
    limited = false;
    await drainOnce(own);
    expect(await state()).toEqual([3, 413]);
  });

  it("sets the write aside only when the write sent to test it was not itself met by a failure", async () => {
    harness = await hydratedHarness("stuck-both", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    const other = await note(own, "other");
    let otherUp = false;
    scripted(own.server, {
      create: [
        (request) =>
          titleOf(request) === "stuck"
            ? gateway(502, "<html>bad gateway</html>")
            : titleOf(request) === "other" && !otherUp
              ? gateway(502, "<html>bad gateway</html>")
              : createdAs(request),
      ],
    });
    // Two minutes apart: the suspect from the fourth drain, six minutes on.
    for (let drain = 0; drain < 5; drain += 1) {
      clockAt(drain * 2);
      await drainOnce(own);
    }
    const waiting = await queueOf(own);
    expect(
      waiting.map((row) => row.verdict),
      "a write was set aside though the write sent to test it failed as well",
    ).toEqual([null, null]);
    expect(
      waiting.map((row) => row.environmental_streak),
      "a failure met by the write sent to test, or by the write tested, was not counted",
    ).toEqual([5, 2]);

    // A write behind it that has not met the failure is the test, since it
    // was sent least recently. Once that one lands, the first is sent again,
    // meets the failure again, and is set aside; the drain goes on.
    otherUp = true;
    const fresh = await note(own, "fresh");
    clockAt(10);
    const report = await drainOnce(own);
    expect(
      report.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
      "the write at the threshold was sent to test, or was set aside though the server takes it",
    ).toEqual([
      [stuck.id, "blocked"],
      [fresh.id, "accepted"],
      [other.id, "accepted"],
    ]);
  });
});

describe("the write sent to test a write that fails", () => {
  it("parks the queue on a refused credential the test meets, and sets nothing aside", async () => {
    harness = await hydratedHarness("stuck-credential", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    const other = await note(own, "other");
    scripted(own.server, {
      create: [
        (request) =>
          titleOf(request) === "stuck"
            ? gateway(502, "<html>bad gateway</html>")
            : refusal(401, "unauthorized", "this key was revoked"),
      ],
    });
    clockAt(0);
    await drainOnce(own);
    await drainOnce(own);
    clockAt(6);
    const third = await drainOnce(own);
    expect(
      third.stopped,
      "a credential refused on the write sent to test did not stop the drain",
    ).not.toBeNull();
    expect(
      (await queueOf(own)).map((row) => [
        row.id,
        row.verdict,
        row.reason,
        row.environmental_streak,
      ]),
      "a refused credential left a write set aside, or did not leave the run of the write it met as it was",
    ).toEqual([
      [stuck.id, "blocked", "credential_refused", 3],
      [other.id, "blocked", "credential_refused", 0],
    ]);
  });

  it("never depends on that write, so the writes waiting on an upload stay waiting", async () => {
    harness = await hydratedHarness("stuck-dependants", { rows: held() });
    const own = harness;
    const attached = await own.device.attach(
      HELD.id,
      fileOf("big.bin", "bytes the gateway will not take\n"),
      { mimeType: "application/octet-stream" },
    );
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    const chain = (await queueOf(own)).map((row) => row.kind);
    expect(chain.slice(0, 3)).toEqual([
      "upload_blob",
      "create_item",
      "create_edge",
    ]);
    const independent = await note(own, "independent");
    own.server.answer("POST", "/blobs", () => gateway(413, HTML_413));
    scripted(own.server, {
      create: [createdAs],
      read: [
        (request) =>
          answers.updated(
            wireItem({ id: request.pathname.split("/")[2], properties: {} }),
          ),
      ],
      edges: [refusal(500, "internal_error", "an edge must not be sent")],
    });
    await reachSuspect(own);
    const queue = await queueOf(own);
    expect(
      queue.map((row) => [row.kind, row.verdict, row.reason]),
      "a write that waits on the upload was sent to test it, or was not held behind it",
    ).toEqual([
      ["upload_blob", "blocked", "failing_alone"],
      ["create_item", "blocked", "awaiting_dependency"],
      ["create_edge", "blocked", "awaiting_dependency"],
      ["create_item", "accepted", null],
    ]);
    expect(queue[3]?.id).toBe(independent.id);
    expect(
      requestsTo(own, "POST", "/items"),
      "the file item that waits on the upload was sent",
    ).toHaveLength(1);
    expect(requestsTo(own, "POST", "/edges")).toHaveLength(0);

    // Withdrawn, the upload takes with it the writes that waited on it. The
    // edge it waited on was never made, which the read before the withdraw
    // finds.
    own.server.copyAnswer(
      "GET",
      /^\/edges\/[^/]+$/,
      refusal(404, "edge_not_found", "Edge not found"),
    );
    const withdrawn = await own.device.withdraw(queue[0]?.id ?? "");
    expect(withdrawn.ok && withdrawn.value, JSON.stringify(withdrawn)).toBe(
      true,
    );
    expect(
      (await queueOf(own)).map((row) => [row.kind, row.verdict]),
      "the writes that waited on a withdrawn upload were left waiting for a write that is gone",
    ).toEqual([
      ["create_item", "refused"],
      ["create_edge", "refused"],
      ["create_item", "accepted"],
    ]);
  });

  it("leaves the write queued, and the pass ending as before, where no other write could go", async () => {
    harness = await hydratedHarness("stuck-alone-in-queue", { rows: held() });
    const own = harness;
    const upload = await own.device.putBlob(
      fileOf("big.bin", "bytes the gateway will not take\n"),
    );
    expect(upload.ok).toBe(true);
    if (!upload.ok) return;
    own.server.answer("POST", "/blobs", () => gateway(413, HTML_413));
    for (let drain = 0; drain < 6; drain += 1) {
      clockAt(drain * 2);
      const report = await drainOnce(own);
      expect(
        [report.answered, report.undelivered, report.unavailable === null],
        "a drain with nothing else to send reported something other than a write left undelivered",
      ).toEqual([0, 1, false]);
    }
    const row = (await queueOf(own))[0];
    expect(
      [row?.verdict, row?.refusals],
      "the only write in the queue was set aside with nothing to compare it against",
    ).toEqual([null, 0]);

    // The witness: the moment another write can go, the test is made.
    scripted(own.server, { create: [createdAs] });
    const noted = await note(own, "now there is another");
    clockAt(12);
    const report = await drainOnce(own);
    expect(
      report.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
    ).toEqual([
      [upload.value.id, "blocked"],
      [noted.id, "accepted"],
    ]);
  });
});

/** What a drain sent: the report, and the requests the server saw during it. */
async function drainSeen(harness: Harness) {
  const before = harness.server.requests.length;
  const report = await drainOnce(harness);
  return { report, requests: harness.server.requests.slice(before) };
}

/** A proxy with a body limit: it refuses an upload over a few bytes with an HTML 413. */
function bodyLimit(request: RecordedRequest): Answer {
  return request.raw.length > 20 ? gateway(413, HTML_413) : takeUpload(request);
}

/**
 * `uploads` large files a proxy refuses, then a note behind them. Which of
 * them the issue's queue is: a write that fails alone, and one that does not.
 */
async function stuckUploads(
  label: string,
  uploads: number,
  down: () => boolean = () => false,
) {
  const own = await hydratedHarness(label, { rows: held() });
  harness = own;
  const stuck: QueuedWrite[] = [];
  for (let index = 1; index <= uploads; index += 1) {
    const queued = await own.device.putBlob(
      fileOf(
        `big-${index}.bin`,
        `bytes the proxy will not take, file ${index}\n`,
      ),
      "application/octet-stream",
    );
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) throw new Error("unreachable: the assertion above threw");
    stuck.push(queued.value);
  }
  const noted = await note(own, "behind the uploads");
  const outage = () => gateway(502, "<html>bad gateway</html>");
  own.server.answer("POST", "/blobs", (request) =>
    down() ? outage() : bodyLimit(request),
  );
  scripted(own.server, {
    create: [(request) => (down() ? outage() : createdAs(request))],
  });
  return { harness: own, stuck, noted };
}

function writesOf(requests: RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.pathname}`);
}

/** What each write sent was: `upload 2` for the second big file, or a note's title. */
function labelsOf(requests: RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.method !== "GET")
    .map((request) =>
      request.pathname === "/blobs"
        ? `upload ${/file (\d+)/.exec(request.raw.toString())?.[1] ?? "?"}`
        : titleOf(request),
    );
}

const UPLOAD = "POST /blobs";
const CREATE = "POST /items";

describe("writes that each fail alone, and the write behind them", () => {
  // Stuck uploads, each refused by the proxy, and a note behind them, with
  // the drains two minutes apart. The first upload is a suspect from the
  // fourth drain, when its streak is four and began six minutes ago. Each
  // drain from then sends it and, as its test, the write sent least
  // recently, one never sent first: the other uploads in turn, then the note.
  // The note is the test in drain `uploads + 3`: it lands, the first upload is
  // sent again and fails again, and is set aside, and the pass goes on.
  async function stuckUploadsThenNote(uploads: number) {
    const {
      harness: own,
      stuck,
      noted,
    } = await stuckUploads(`stuck-${uploads}`, uploads);
    const landing = uploads + 3;
    const sent: string[][] = [];
    const labels: string[][] = [];
    const noteLanded: Array<string | null> = [];
    let landingReport: DrainReport | undefined;
    for (let drain = 1; drain <= landing; drain += 1) {
      clockAt((drain - 1) * 2);
      const seen = await drainSeen(own);
      sent.push(writesOf(seen.requests));
      labels.push(labelsOf(seen.requests));
      noteLanded.push(
        seen.report.verdicts.find((verdict) => verdict.id === noted.id)
          ?.verdict ?? null,
      );
      if (drain === landing) landingReport = seen.report;
    }
    expect(
      sent.slice(0, landing - 1),
      "a drain before the note landed sent more than the first upload and one write to test it with, or sent a test before the first upload had failed for five minutes",
    ).toEqual(
      Array.from({ length: landing - 1 }, (_, drain) =>
        drain < 3 ? [UPLOAD] : [UPLOAD, UPLOAD],
      ),
    );
    expect(
      sent.at(-1),
      "the drain the note is the test in did not send the first upload, the note, the first upload again, then the second upload",
    ).toEqual([UPLOAD, CREATE, UPLOAD, UPLOAD]);
    expect(
      labels,
      "the writes did not take their turns at being the test, the one sent least recently each time and one never sent first",
    ).toEqual([
      ["upload 1"],
      ["upload 1"],
      ["upload 1"],
      ...Array.from({ length: uploads - 1 }, (_, turn) => [
        "upload 1",
        `upload ${turn + 2}`,
      ]),
      ["upload 1", "behind the uploads", "upload 1", "upload 2"],
    ]);
    expect(
      noteLanded,
      `the note was taken in a drain other than the ${landing}th, or never`,
    ).toEqual([...Array(landing - 1).fill(null), "accepted"]);
    expect(
      landingReport?.verdicts
        .filter((verdict) => verdict.verdict !== null)
        .map((verdict) => [verdict.id, verdict.verdict, verdict.reason]),
    ).toEqual([
      [stuck[0]?.id, "blocked", "failing_alone"],
      [noted.id, "accepted", null],
    ]);
    const queue = await queueOf(own);
    expect(
      queue.map((row) => [row.id, row.verdict, row.reason, row.refusals]),
      "the first upload was not set aside, or the note was not taken, or an upload that had not met the failure three times was set aside",
    ).toEqual([
      [stuck[0]?.id, "blocked", "failing_alone", 0],
      ...stuck.slice(1).map((upload) => [upload.id, null, null, 0]),
      [noted.id, "accepted", null, 0],
    ]);
    expect(
      queue.slice(0, uploads).map((row) => row.last_failure?.status),
      "the queue does not say what each upload last met",
    ).toEqual(Array(uploads).fill(413));
    expect(
      queue.map((row) => row.environmental_streak),
      "each upload was not counted once for each time it was sent and failed",
    ).toEqual([landing, 2, ...Array(Math.max(uploads - 2, 0)).fill(1), 0]);
    // The first upload is sent no more.
    for (let drain = 0; drain < 3; drain += 1) {
      clockAt((landing + drain) * 2);
      const after = await drainSeen(own);
      expect(
        labelsOf(after.requests),
        "a drain after the first upload was set aside sent it again, or sent more than the head and one write to test it with",
      ).not.toContain("upload 1");
      expect(writesOf(after.requests).length).toBeLessThanOrEqual(2);
    }
  }

  it("sets the first of 2 stuck uploads aside in the 5th drain, when the note behind them lands", () =>
    stuckUploadsThenNote(2));
  it("sets the first of 3 stuck uploads aside in the 6th drain, when the note behind them lands", () =>
    stuckUploadsThenNote(3));
  it("sets the first of 4 stuck uploads aside in the 7th drain, when the note behind them lands", () =>
    stuckUploadsThenNote(4));
  it("sets the first of 6 stuck uploads aside in the 9th drain, when the note behind them lands", () =>
    stuckUploadsThenNote(6));

  it("leaves the uploads behind the first queued, two requests a drain, and sets one more aside for each note that lands behind them", async () => {
    const { harness: own } = await stuckUploads("stuck-leftover", 4);
    for (let drain = 1; drain <= 7; drain += 1) {
      clockAt((drain - 1) * 2);
      await drainOnce(own);
    }
    expect(
      (await queueOf(own)).map((row) => row.reason),
      "only the first upload was set aside when the note landed",
    ).toEqual(["failing_alone", null, null, null, null]);
    // Nothing is queued that could test the rest, so they wait; every
    // upload meets the failure again until each has met it in three drains.
    const counts: number[] = [];
    let minute = 12;
    for (let drain = 8; drain <= 24; drain += 1) {
      minute = (drain - 1) * 2;
      clockAt(minute);
      counts.push(writesOf((await drainSeen(own)).requests).length);
      if (
        (await queueOf(own))
          .slice(1, 4)
          .every((row) => row.environmental_streak >= 3)
      )
        break;
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
    expect(
      (await queueOf(own)).slice(1, 4).map((row) => row.verdict),
      "an upload was set aside with no write that landed in the drain",
    ).toEqual([null, null, null]);

    // A note that lands is the test of the next upload, which is sent again
    // and set aside. The one after it is a suspect too, with no write left to
    // test it, so it waits for the next note.
    clockAt(minute + 2);
    const later = await note(own, "later");
    const seen = await drainSeen(own);
    expect(
      labelsOf(seen.requests),
      "the note did not test the first upload left, or the upload after it was set aside with no write to test it",
    ).toEqual(["upload 2", "later", "upload 2", "upload 3", "upload 4"]);
    expect(
      (await queueOf(own)).map((row) => [row.reason, row.verdict]),
      "a note that landed did not set exactly one more upload aside",
    ).toEqual([
      ["failing_alone", "blocked"],
      ["failing_alone", "blocked"],
      [null, null],
      [null, null],
      [null, "accepted"],
      [null, "accepted"],
    ]);
    expect((await queueOf(own))[5]?.id).toBe(later.id);

    clockAt(minute + 4);
    await note(own, "later still");
    expect(
      labelsOf((await drainSeen(own)).requests),
      "the next note did not test the next upload left",
    ).toEqual(["upload 3", "later still", "upload 3", "upload 4"]);
    expect(
      (await queueOf(own)).map((row) => row.reason),
      "the next note did not set exactly one more upload aside",
    ).toEqual([
      "failing_alone",
      "failing_alone",
      "failing_alone",
      null,
      null,
      null,
      null,
    ]);
  });

  it("sends at most two requests a drain, and sets nothing aside, in an outage that fails ten queued writes", async () => {
    harness = await hydratedHarness("ten-outage", { rows: held() });
    const own = harness;
    for (let index = 1; index <= 10; index += 1)
      await note(own, `note ${index}`);
    let down = true;
    scripted(own.server, {
      create: [
        (request) =>
          down ? gateway(502, "<html>bad gateway</html>") : createdAs(request),
      ],
    });
    const labels: string[][] = [];
    for (let drain = 1; drain <= 20; drain += 1) {
      // Three drains close together, then a minute apart from six minutes on.
      clockAt(drain <= 3 ? 0 : 6 + (drain - 4));
      const seen = await drainSeen(own);
      labels.push(labelsOf(seen.requests));
      expect(
        seen.report.answered,
        "a drain against a gateway that failed every write reported an answer",
      ).toBe(0);
    }
    expect(
      labels.map((sent) => sent.length),
      "an outage cost more than the first write and one to test it with, or less in the first two drains",
    ).toEqual([1, 1, 1, ...Array(17).fill(2)]);
    expect(
      labels.slice(3).map((sent) => sent[1]),
      "the test was not the write sent least recently, a write never sent first, in queue order",
    ).toEqual([
      ...Array.from({ length: 9 }, (_, turn) => `note ${turn + 2}`),
      ...Array.from({ length: 8 }, (_, turn) => `note ${turn + 2}`),
    ]);
    expect(
      (await queueOf(own)).map((row) => [row.verdict, row.refusals]),
      "an outage set a write aside or counted a refusal",
    ).toEqual(Array.from({ length: 10 }, () => [null, 0]));
    expect(
      (await queueOf(own)).map((row) => row.environmental_streak),
      "the writes did not take turns at being the test",
    ).toEqual([20, ...Array(8).fill(2), 1]);

    // The witness: when the gateway recovers, every write goes in one drain.
    down = false;
    clockAt(40);
    const back = await drainOnce(own);
    expect(back.answered).toBe(10);
    expect(
      (await queueOf(own)).map((row) => [
        row.verdict,
        row.environmental_streak,
      ]),
    ).toEqual(Array.from({ length: 10 }, () => ["accepted", 0]));
  });

  it("sends two requests a drain in an outage once every queued write has met the failure in three drains, and still sets nothing aside", async () => {
    harness = await hydratedHarness("three-outage", { rows: held() });
    const own = harness;
    for (let index = 1; index <= 3; index += 1)
      await note(own, `note ${index}`);
    let down = true;
    scripted(own.server, {
      create: [
        (request) =>
          down ? gateway(502, "<html>bad gateway</html>") : createdAs(request),
      ],
    });
    const counts: number[] = [];
    for (let drain = 1; drain <= 12; drain += 1) {
      clockAt(drain <= 3 ? 0 : 6 + (drain - 4));
      counts.push(writesOf((await drainSeen(own)).requests).length);
    }
    expect(counts).toEqual([1, 1, 1, ...Array(9).fill(2)]);
    expect(
      (await queueOf(own)).map((row) => [
        row.verdict,
        row.environmental_streak,
      ]),
      "a write was set aside in an outage",
    ).toEqual([
      [null, 12],
      [null, 5],
      [null, 4],
    ]);
    down = false;
    clockAt(40);
    const back = await drainOnce(own);
    expect(back.answered).toBe(3);
  });

  it("ends the pass at a write sent to test them that the server limits, adding nothing to its streak", async () => {
    harness = await hydratedHarness("stuck-test-limited", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    const limited = await note(own, "limited");
    const behind = await note(own, "behind");
    // The server limits every write but the one a gateway refuses.
    let limit = true;
    scripted(own.server, {
      create: [
        (request) =>
          titleOf(request) === "stuck"
            ? gateway(502, "<html>bad gateway</html>")
            : limit
              ? {
                  kind: "json",
                  status: 429,
                  body: {
                    error: { code: "rate_limited", message: "slow down" },
                  },
                  headers: { "Retry-After": "7" },
                }
              : createdAs(request),
      ],
    });
    const sent: string[][] = [];
    for (let drain = 1; drain <= 6; drain += 1) {
      clockAt(drain <= 3 ? 0 : 6 + (drain - 4));
      const seen = await drainSeen(own);
      sent.push(labelsOf(seen.requests));
      if (drain >= 4) expect(seen.report.retry_after_seconds).toBe(7);
    }
    expect(
      sent.map((requests) => requests.length),
      "a write sent to test that the server limited did not end the pass, or was not sent",
    ).toEqual([1, 1, 1, 2, 2, 2]);
    expect(
      sent.slice(3).map((requests) => requests[1]),
      "a write the server limited was tested again before the write never sent",
    ).toEqual(["limited", "behind", "limited"]);
    expect(
      (await queueOf(own)).map((row) => [
        row.id,
        row.verdict,
        row.environmental_streak,
      ]),
      "a rate limit added to a streak, or the write behind was sent",
    ).toEqual([
      [stuck.id, null, 6],
      [limited.id, null, 0],
      [behind.id, null, 0],
    ]);

    // The witness: once the server stops limiting, the write sent least
    // recently is the test, which lands, and the stuck write is set aside.
    limit = false;
    clockAt(20);
    const report = await drainOnce(own);
    expect(
      report.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
    ).toEqual([
      [stuck.id, "blocked"],
      [behind.id, "accepted"],
      [limited.id, "accepted"],
    ]);
  });

  it("never sends a write that waits on the second stuck upload to test it, and holds it once the second upload is set aside", async () => {
    harness = await hydratedHarness("second-dependants", { rows: held() });
    const own = harness;
    const first = await own.device.putBlob(
      fileOf("big-1.bin", "bytes the proxy will not take, file 1\n"),
      "application/octet-stream",
    );
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    const attached = await own.device.attach(
      HELD.id,
      fileOf("big-2.bin", "bytes the proxy will not take, file 2\n"),
      { mimeType: "application/octet-stream" },
    );
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    const independent = await note(own, "independent");
    expect((await queueOf(own)).map((row) => row.kind)).toEqual([
      "upload_blob",
      "upload_blob",
      "create_item",
      "create_edge",
      "create_item",
    ]);
    own.server.answer("POST", "/blobs", bodyLimit);
    scripted(own.server, {
      create: [createdAs],
      edges: [refusal(500, "internal_error", "an edge must not be sent")],
    });
    const sent: string[][] = [];
    for (let drain = 1; drain <= 7; drain += 1) {
      clockAt(drain <= 3 ? 0 : 6 + (drain - 4));
      sent.push(labelsOf((await drainSeen(own)).requests));
    }
    expect(
      sent,
      "a drain sent the file item or the edge that wait on the second upload, or tested with anything but the second upload and then the independent note",
    ).toEqual([
      ["upload 1"],
      ["upload 1"],
      ["upload 1"],
      ["upload 1", "upload 2"],
      ["upload 1", "independent", "upload 1", "upload 2"],
      ["upload 2"],
      ["upload 2"],
    ]);
    expect(requestsTo(own, "POST", "/items")).toHaveLength(1);
    expect(requestsTo(own, "POST", "/edges")).toHaveLength(0);
    expect(
      (await queueOf(own)).map((row) => [row.kind, row.verdict, row.reason]),
      "the second upload was set aside with no write left to test it, or the writes waiting on it were not held",
    ).toEqual([
      ["upload_blob", "blocked", "failing_alone"],
      ["upload_blob", null, null],
      ["create_item", "blocked", "awaiting_dependency"],
      ["create_edge", "blocked", "awaiting_dependency"],
      ["create_item", "accepted", null],
    ]);

    // Another independent note is the test of the second upload, which the
    // file item and the edge then wait behind, unsent.
    clockAt(20);
    const later = await note(own, "later");
    const last = await drainSeen(own);
    expect(labelsOf(last.requests)).toEqual(["upload 2", "later", "upload 2"]);
    expect(requestsTo(own, "POST", "/edges")).toHaveLength(0);
    const queue = await queueOf(own);
    expect(queue.map((row) => [row.kind, row.verdict, row.reason])).toEqual([
      ["upload_blob", "blocked", "failing_alone"],
      ["upload_blob", "blocked", "failing_alone"],
      ["create_item", "blocked", "awaiting_dependency"],
      ["create_edge", "blocked", "awaiting_dependency"],
      ["create_item", "accepted", null],
      ["create_item", "accepted", null],
    ]);
    expect([queue[4]?.id, queue[5]?.id]).toEqual([independent.id, later.id]);
  });
});

describe("writes that all met the failure in an outage, and one that is stuck", () => {
  // A gateway answers `502` to every write for a while, so every queued write
  // reaches a streak of three or more, the first long enough ago. It then
  // recovers for everything but the uploads, which its body limit still
  // refuses. The test is the write sent least recently, whatever its streak,
  // so the note is reached, and the first upload, which fails again after it,
  // is set aside.
  async function afterAnOutage(uploads: number) {
    let down = true;
    const {
      harness: own,
      stuck,
      noted,
    } = await stuckUploads(`outage-${uploads}`, uploads, () => down);
    let drains = 0;
    const tick = () => clockAt(drains++ * 2);
    const outage: number[] = [];
    for (let drain = 1; drain <= 40; drain += 1) {
      tick();
      outage.push(writesOf((await drainSeen(own)).requests).length);
      if (
        (await queueOf(own)).every(
          (row) => row.environmental_streak >= 3 && row.verdict === null,
        )
      )
        break;
    }
    expect(
      (await queueOf(own)).every(
        (row) => row.verdict === null && row.environmental_streak >= 3,
      ),
      "the outage did not bring every queued write to a streak of three or more without setting one aside",
    ).toBe(true);
    expect(
      Math.max(...outage),
      "an outage sent more than the first write and one to test it with",
    ).toBeLessThanOrEqual(2);

    // The gateway recovers for notes and still refuses the uploads.
    down = false;
    const sentBefore = own.server.requests.length;
    let landedIn = 0;
    const before: number[] = [];
    for (let drain = 1; drain <= uploads; drain += 1) {
      tick();
      const seen = await drainSeen(own);
      if (seen.report.verdicts.some((v) => v.id === noted.id && v.verdict)) {
        landedIn = drain;
        break;
      }
      before.push(writesOf(seen.requests).length);
    }
    expect(
      landedIn,
      `the note did not land within ${uploads} drain(s) of the outage ending`,
    ).toBeGreaterThan(0);
    expect(
      before,
      "a drain after the outage sent more than the first upload and one write to test it with, before the note landed",
    ).toEqual(Array(landedIn - 1).fill(2));
    const queue = await queueOf(own);
    expect(
      queue.map((row) => [row.id, row.verdict, row.reason]),
      "the first upload was not set aside once the note landed, or the note was not taken, or an upload that has not been sent again was set aside",
    ).toEqual([
      [stuck[0]?.id, "blocked", "failing_alone"],
      ...stuck.slice(1).map((upload) => [upload.id, null, null]),
      [noted.id, "accepted", null],
    ]);
    expect(queue[0]?.last_failure?.status).toBe(413);
    // Nothing is sent for it after.
    expect(own.server.requests.length).toBeGreaterThan(sentBefore);
    tick();
    const after = await drainSeen(own);
    expect(labelsOf(after.requests)).not.toContain("upload 1");
    expect(writesOf(after.requests).length).toBeLessThanOrEqual(2);
  }

  it("takes the note behind one stuck upload, and sets the upload aside, though the note has met the failure three times", () =>
    afterAnOutage(1));
  it("takes the note behind four stuck uploads within four drains, and sets the first aside", () =>
    afterAnOutage(4));
});

/** Exit status of a command that left work undone. */
const UNFINISHED = 3;

const BAD_GATEWAY = "<html>bad gateway</html>";

describe("a write the server takes again before it is set aside", () => {
  it("sets nothing aside when the outage ends between the suspect and the write sent to test it", async () => {
    harness = await hydratedHarness("suspect-outage-ends", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    const test = await note(own, "test");
    let down = true;
    let ending = false;
    scripted(own.server, {
      create: [
        (request) => {
          if (down) {
            // The outage ends as the suspect fails, before its test is sent.
            if (ending && titleOf(request) === "stuck") down = false;
            return gateway(502, BAD_GATEWAY);
          }
          return createdAs(request);
        },
      ],
    });
    clockAt(0);
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
    ending = true;
    clockAt(6);
    const seen = await drainSeen(own);
    expect(
      labelsOf(seen.requests),
      "the drain did not send the suspect, the write that tests it, then the suspect again",
    ).toEqual(["stuck", "test", "stuck"]);
    expect(
      seen.report.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
      "a write the server took once the outage ended was set aside, or reported twice",
    ).toEqual([
      [stuck.id, "accepted"],
      [test.id, "accepted"],
    ]);
    expect(
      (await queueOf(own)).map((row) => [
        row.verdict,
        row.reason,
        row.environmental_streak,
      ]),
    ).toEqual([
      ["accepted", null, 0],
      ["accepted", null, 0],
    ]);
  });

  it("sets nothing aside for a single failure in a drain where an earlier write was answered", async () => {
    harness = await hydratedHarness("suspect-after-landing", { rows: held() });
    const own = harness;
    // Answered every time, but not with a verdict: it stays queued, so each
    // drain has the server answering a write ahead of the one that fails.
    const ahead = await note(own, "ahead");
    const stuck = await note(own, "stuck");
    const behind = await note(own, "behind");
    let sends = 0;
    scripted(own.server, {
      create: [
        (request) => {
          if (titleOf(request) === "ahead")
            return refusal(
              409,
              "idempotency_key_in_flight",
              "still being worked",
            );
          if (titleOf(request) === "stuck") {
            sends += 1;
            // Three failures, then the server takes it.
            if (sends <= 3) return gateway(502, BAD_GATEWAY);
          }
          return createdAs(request);
        },
      ],
    });
    clockAt(0);
    await drainOnce(own);
    await drainOnce(own);
    clockAt(6);
    const third = await drainOnce(own);
    expect(
      third.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
      "the write was set aside after one more failure, though the server took the write behind it and then took it",
    ).toEqual([
      [ahead.id, null],
      [stuck.id, "accepted"],
      [behind.id, "accepted"],
    ]);
    expect(
      (await queueOf(own)).map((row) => [row.verdict, row.reason]),
    ).toEqual([
      [null, null],
      ["accepted", null],
      ["accepted", null],
    ]);
  });

  it("sets nothing aside for a gateway that flaps for two minutes, however many drains it fails", async () => {
    harness = await hydratedHarness("suspect-flapping", { rows: held() });
    const own = harness;
    const first = await note(own, "first");
    const second = await note(own, "second");
    // The first write fails in three drains running, and from then on the
    // gateway answers every other request.
    let sent = 0;
    scripted(own.server, {
      create: [
        (request) => {
          sent += 1;
          return sent <= 3 || sent % 2 === 1
            ? gateway(502, BAD_GATEWAY)
            : createdAs(request);
        },
      ],
    });
    const blocked: string[] = [];
    // Ten seconds apart: twelve drains are two minutes.
    for (let drain = 1; drain <= 12; drain += 1) {
      clockAt(drain / 6);
      const report = await drainOnce(own);
      for (const verdict of report.verdicts)
        if (verdict.verdict === "blocked") blocked.push(verdict.id);
      if (drain === 3) {
        expect(
          (await queueOf(own))[0]?.environmental_streak,
          "the first write did not stand at a streak of three after three drains",
        ).toBe(3);
      }
    }
    expect(
      blocked,
      "a write was set aside by a gateway that failed it for two minutes",
    ).toEqual([]);
    expect(
      (await queueOf(own)).map((row) => [row.id, row.verdict, row.reason]),
    ).toEqual([
      [first.id, "accepted", null],
      [second.id, "accepted", null],
    ]);
  });

  it("sets nothing aside when the server limits requests as the suspect is sent again, and shows that as its last answer", async () => {
    harness = await hydratedHarness("suspect-resend-limited", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    const test = await note(own, "test");
    let sends = 0;
    scripted(own.server, {
      create: [
        (request) => {
          if (titleOf(request) !== "stuck") return createdAs(request);
          sends += 1;
          // Four failures bring it to a suspect, and the fifth send, after
          // the test landed, is told to wait.
          if (sends === 5)
            return {
              kind: "json",
              status: 429,
              body: { error: { code: "rate_limited", message: "slow down" } },
              headers: { "Retry-After": "7" },
            };
          return sends < 5 ? gateway(502, BAD_GATEWAY) : createdAs(request);
        },
      ],
    });
    clockAt(0);
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
    clockAt(6);
    const seen = await drainSeen(own);
    expect(
      labelsOf(seen.requests),
      "the drain did not send the suspect, the write that tests it, then the suspect again",
    ).toEqual(["stuck", "test", "stuck"]);
    expect(seen.report.retry_after_seconds).toBe(7);
    expect(
      (await queueOf(own)).map((row) => [
        row.id,
        row.verdict,
        row.environmental_streak,
        row.last_failure?.status ?? null,
      ]),
      "the suspect was set aside on a rate limit, or the rate limit counted in its streak, or the queue did not show it",
    ).toEqual([
      [stuck.id, null, 4, 429],
      [test.id, "accepted", 0, null],
    ]);
  });

  it("keeps the streak of a suspect when the drain is stopped while the write sent to test it is in flight", async () => {
    harness = await hydratedHarness("suspect-stopped", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    await note(own, "test");
    let release = (): void => {};
    const until = new Promise<void>((resolve) => (release = resolve));
    scripted(own.server, {
      create: [
        (request) =>
          titleOf(request) === "stuck"
            ? gateway(502, BAD_GATEWAY)
            : // Held for longer than anyone waits, as a server can.
              { kind: "gated", until, then: createdAs(request) },
      ],
    });
    clockAt(0);
    await drainOnce(own);
    await drainOnce(own);
    clockAt(6);
    const draining = own.device.hold(["drain"]);
    try {
      await vi.waitFor(
        () => {
          expect(
            requestsTo(own, "POST", "/items").filter(
              (request) => titleOf(request) === "test",
            ),
            draining.stderr,
          ).toHaveLength(1);
        },
        { timeout: 10_000, interval: 25 },
      );
      draining.interrupt();
      await draining.exited();
      expect(draining.exitCode(), draining.stderr).toBe(UNFINISHED);
      expect(JSON.parse(draining.stderr).error.code).toBe("canceled");
    } finally {
      release();
      await draining.stop();
    }
    const row = (await queueOf(own)).find((write) => write.id === stuck.id);
    expect(
      [row?.verdict, row?.environmental_streak, row?.last_failure?.status],
      "the suspect's streak was lost with the stop, or the stop set it aside",
    ).toEqual([null, 3, 502]);
  });

  it("goes on to the next write when the one chosen to test has no bytes to send, and sends one test to the server", async () => {
    harness = await hydratedHarness("suspect-test-gone", { rows: held() });
    const own = harness;
    const bytes = (label: string) => `bytes of ${label}\n`;
    const upload = async (label: string) => {
      const queued = await own.device.putBlob(
        fileOf(`${label}.bin`, bytes(label)),
        "application/octet-stream",
      );
      expect(queued.ok, JSON.stringify(queued)).toBe(true);
      if (!queued.ok) throw new Error("unreachable: the assertion above threw");
      return queued.value;
    };
    const stuck = await upload("stuck");
    const gone = await upload("gone");
    const tests = await note(own, "test");
    rmSync(
      `${own.device.store}.blobs/${(gone.blob ?? "").slice("sha256:".length)}`,
    );
    own.server.answer("POST", "/blobs", (request) =>
      request.raw.toString().startsWith("bytes of stuck")
        ? gateway(413, HTML_413)
        : takeUpload(request),
    );
    scripted(own.server, { create: [createdAs] });
    clockAt(0);
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
    clockAt(6);
    const seen = await drainSeen(own);
    expect(
      seen.report.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
      "the write with no bytes held up the test, or the suspect was not set aside",
    ).toEqual([
      [stuck.id, "blocked"],
      [gone.id, "refused"],
      [tests.id, "accepted"],
    ]);
    expect(
      requestsTo(own, "POST", "/items").map(titleOf),
      "more than one write was sent to test",
    ).toEqual(["test"]);
    expect(
      requestsTo(own, "POST", "/blobs").map((request) =>
        request.raw.toString(),
      ),
      "bytes the device does not hold were sent, or the suspect was not sent again",
    ).toEqual(Array(5).fill(bytes("stuck")));
  });

  it("keeps the test moving through the queue when the clock is set back", async () => {
    harness = await hydratedHarness("suspect-clock-back", { rows: held() });
    const own = harness;
    for (let index = 1; index <= 4; index += 1)
      await note(own, `note ${index}`);
    scripted(own.server, {
      create: [() => gateway(502, BAD_GATEWAY)],
    });
    clockAt(0);
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
    // Ten minutes on, then five minutes back: the sends in the later stretch
    // carry earlier times than those before it. The run of the write at the
    // head began again at the first failure after the clock went back, so it
    // is tested again only once that run is five minutes old.
    const tested: string[] = [];
    for (const minutes of [10, 10, 5, 5, 5, 11, 11, 11]) {
      clockAt(minutes);
      tested.push(labelsOf((await drainSeen(own)).requests)[1] ?? "none");
    }
    expect(
      tested,
      "a clock set back made the test stick to one write instead of moving through the queue, or did not delay the next test",
    ).toEqual([
      "note 2",
      "note 3",
      "none",
      "none",
      "none",
      "note 4",
      "note 2",
      "note 3",
    ]);
  });
});

describe("a run of failures that is not one run", () => {
  /** The drains of one stuck upload with a note behind it, one at each of these minutes. */
  async function drainsAt(label: string, minutes: number[]) {
    const stuck = await stuckUpload(label);
    const seen: Awaited<ReturnType<typeof drainSeen>>[] = [];
    for (const minute of minutes) {
      clockAt(minute);
      seen.push(await drainSeen(stuck.harness));
    }
    return { ...stuck, seen };
  }

  it("starts the run again for a failure more than fifteen minutes after the last, so a write that failed once and went unsent for an hour is not set aside", async () => {
    // One failure, then an hour unsent, then two drains seconds apart. Counted
    // from the first failure it would be a streak of three five minutes old,
    // and the note behind would test it.
    const { harness: own, seen } = await drainsAt("run-hour", [0, 60, 60]);
    expect(
      seen.map((one) => writesOf(one.requests)),
      "a write that failed an hour before was tested after two failures seconds apart",
    ).toEqual([[UPLOAD], [UPLOAD], [UPLOAD]]);
    expect(
      (await queueOf(own)).map((row) => [
        row.verdict,
        row.environmental_streak,
      ]),
      "the failure an hour old was kept in the streak",
    ).toEqual([
      [null, 2],
      [null, 0],
      [null, 0],
    ]);
  });

  it("sets the write aside when no gap between its failures is more than fifteen minutes, though it never met three in five minutes", async () => {
    // The witness for the case above: the same queue and failures, the gaps
    // under fifteen minutes.
    const {
      harness: own,
      upload,
      seen,
    } = await drainsAt("run-gaps", [0, 14, 28]);
    expect(
      seen.map((one) => writesOf(one.requests)),
      "a run with gaps under fifteen minutes did not reach a suspect after five minutes",
    ).toEqual([
      [UPLOAD],
      [UPLOAD],
      [UPLOAD, `PATCH /items/${HELD.id}`, UPLOAD, CREATE],
    ]);
    expect(
      (await queueOf(own))[0],
      "the write was not set aside",
    ).toMatchObject({
      id: upload.id,
      verdict: "blocked",
      reason: "failing_alone",
    });
  });

  it("starts the run again at the first failure more than fifteen minutes after the last, however often it happens", async () => {
    const { harness: own, seen } = await drainsAt(
      "run-sixteen",
      [0, 16, 32, 48, 64, 80],
    );
    expect(
      seen.map((one) => writesOf(one.requests)),
      "a gap of sixteen minutes kept the run",
    ).toEqual(Array(6).fill([UPLOAD]));
    expect(
      (await queueOf(own)).map((row) => row.verdict),
      "a write failing every sixteen minutes was set aside",
    ).toEqual([null, null, null]);
  });

  it("starts the run again when the first failure was met with the clock far ahead, so a suspect is reached within the usual five minutes", async () => {
    const stuck = await stuckUpload("run-clock-ahead");
    const { harness: own, upload } = stuck;
    // The first failure with the clock a day ahead: it is later than any
    // time the clock now reads.
    clockAt(24 * 60);
    await drainOnce(own);
    clockAt(0);
    for (let drain = 0; drain < 3; drain += 1) {
      expect(
        writesOf((await drainSeen(own)).requests),
        "a failure from a clock ahead held the queue",
      ).toEqual([UPLOAD]);
    }
    clockAt(4);
    expect(
      writesOf((await drainSeen(own)).requests),
      "a write was tested before its run was five minutes old",
    ).toEqual([UPLOAD]);
    clockAt(6);
    const reached = await drainSeen(own);
    expect(
      writesOf(reached.requests),
      "a start ahead of the clock held the queue until the clock caught up",
    ).toEqual([UPLOAD, `PATCH /items/${HELD.id}`, UPLOAD, CREATE]);
    expect(
      (await queueOf(own))[0],
      "the write was not set aside",
    ).toMatchObject({
      id: upload.id,
      verdict: "blocked",
      reason: "failing_alone",
    });
  });
});

describe("a write sent to test that cannot be sent", () => {
  it("ends the pass with nothing set aside, and sends no other write to test the same suspect", async () => {
    harness = await hydratedHarness("test-unsendable", { rows: held() });
    const own = harness;
    const upload = async (label: string, mime: string) => {
      const queued = await own.device.putBlob(
        fileOf(`${label}.bin`, `bytes of ${label}\n`),
        mime,
      );
      expect(queued.ok, JSON.stringify(queued)).toBe(true);
      if (!queued.ok) throw new Error("unreachable: the assertion above threw");
      return queued.value;
    };
    const stuck = await upload("stuck", "application/octet-stream");
    // A MIME type no header can carry, so the request is never made.
    const unsendable = await upload("unsendable", "text/plain\ninvalid");
    const tests = await note(own, "test");
    own.server.answer("POST", "/blobs", (request) =>
      request.raw.toString().startsWith("bytes of stuck")
        ? gateway(413, HTML_413)
        : takeUpload(request),
    );
    scripted(own.server, { create: [createdAs] });
    clockAt(0);
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
    clockAt(6);
    const seen = await drainSeen(own);
    expect(
      writesOf(seen.requests),
      "a second write was sent to test the suspect after the first could not be sent",
    ).toEqual([UPLOAD]);
    expect(
      (await queueOf(own)).map((row) => [
        row.id,
        row.verdict,
        row.reason,
        row.refusals,
      ]),
      "the suspect was set aside, the write behind was answered, or the write that could not be made was not counted",
    ).toEqual([
      [stuck.id, null, null, 0],
      [unsendable.id, null, null, 1],
      [tests.id, null, null, 0],
    ]);
    expect(
      seen.report.unavailable,
      "the pass did not say it ended",
    ).not.toBeNull();
  });
});
