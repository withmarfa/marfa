import { describe, it, expect, afterEach } from "vitest";
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
});

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

describe("a write that keeps meeting an environmental failure", () => {
  it("sets the write aside as failing_alone once the server takes the writes behind it, and sends them", async () => {
    const {
      harness: own,
      upload,
      edited,
      noted,
    } = await stuckUpload("stuck-aside");
    const first = await drainOnce(own);
    const second = await drainOnce(own);
    // The pass ends at the write, as it does for an outage: nothing behind it
    // is sent while the streak is short of the test.
    expect(
      [first.undelivered, second.undelivered],
      "a drain that met an environmental failure did not leave the writes undelivered",
    ).toEqual([3, 3]);
    expect(
      requestsTo(own, "PATCH", `/items/${HELD.id}`).length +
        requestsTo(own, "POST", "/items").length,
      "the pass went on past the write while the streak was short of the test",
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

    const third = await drainOnce(own);
    expect(
      third.verdicts.map((verdict) => [
        verdict.id,
        verdict.verdict,
        verdict.reason,
      ]),
      "the third drain did not report the write set aside, or did not send the writes behind it",
    ).toEqual([
      [upload.id, "blocked", "failing_alone"],
      [edited.id, "accepted", null],
      [noted.id, "accepted", null],
    ]);
    expect(
      [third.unavailable, third.undelivered, third.answered],
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
    // The witness: the write behind it went in this drain, and the write
    // set aside was sent once more than before, not again after.
    expect(requestsTo(own, "POST", "/blobs")).toHaveLength(3);
    const sentBefore = own.server.requests.length;
    const fourth = await drainOnce(own);
    expect(
      [fourth.undelivered, fourth.unavailable],
      "a write set aside was sent again by the next drain",
    ).toEqual([0, null]);
    expect(own.server.requests.length).toBe(sentBefore);
  });

  it("shows what a write set aside last met, bounded, in the queue", async () => {
    const { harness: own, upload } = await stuckUpload("stuck-shows");
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
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
    expect(row?.environmental_streak).toBe(3);
  });

  it("keeps only the start of a long body, and nothing of one made of control characters", async () => {
    const { harness: own, upload } = await stuckUpload("stuck-bounded");
    const long = `<html>${"word ".repeat(2000)}</html>`;
    let body: Answer = gateway(413, long);
    own.server.answer("POST", "/blobs", () => body);
    // The route is already scripted by the fixture; a drain consults the
    // first responder, so replace what it answers from the outside.
    own.server.answer("POST", "/blobs", () => body);
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
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
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
    const row = (await queueOf(own)).find((write) => write.id === upload.id);
    expect(
      [row?.verdict, row?.reason, row?.last_failure],
      "a body that is not text was kept as text",
    ).toEqual(["blocked", "failing_alone", { status: 413, text: null }]);
  });

  it("sends a write set aside again when it is released, under the streak counted afresh", async () => {
    const { harness: own, upload, mend } = await stuckUpload("stuck-release");
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
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
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
    mend();
    const released = await own.device.release({ reason: "failing_alone" });
    expect(released.ok && released.value, JSON.stringify(released)).toBe(1);
    expect(
      (await queueOf(own)).find((write) => write.id === upload.id)?.verdict,
    ).toBeNull();
  });

  it("withdraws a write set aside, and sends nothing for it after", async () => {
    const { harness: own, upload } = await stuckUpload("stuck-withdraw");
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
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
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
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
    expect(requestsTo(own, "POST", "/blobs")).toHaveLength(3);
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
    await drainOnce(own);
    await drainOnce(own);
    const third = await drainOnce(own);
    expect(
      third.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
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
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
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
    for (let drain = 0; drain < 5; drain += 1) {
      const report = await drainOnce(own);
      expect(report.answered).toBe(0);
    }
    expect(
      (await queueOf(own)).map((row) => row.verdict),
      "a short outage set a write aside",
    ).toEqual([null, null]);
    down = false;
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
            : otherUp
              ? createdAs(request)
              : gateway(502, "<html>bad gateway</html>"),
      ],
    });
    for (let drain = 0; drain < 5; drain += 1) await drainOnce(own);
    const waiting = await queueOf(own);
    expect(
      waiting.map((row) => row.verdict),
      "a write was set aside though the write sent to test it failed as well",
    ).toEqual([null, null]);
    expect(
      waiting.map((row) => row.environmental_streak),
      "a failure met by the write sent to test, or by the write tested, was not counted",
    ).toEqual([5, 3]);
    otherUp = true;
    const report = await drainOnce(own);
    expect(
      report.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
      "the write behind was not sent, or the write was not set aside once the other was taken",
    ).toEqual([
      [stuck.id, "blocked"],
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
    await drainOnce(own);
    await drainOnce(own);
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
      "a refused credential left a write set aside or the run of the write it met standing",
    ).toEqual([
      [stuck.id, "blocked", "credential_refused", 2],
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
    for (let drain = 0; drain < 3; drain += 1) await drainOnce(own);
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
async function stuckUploads(label: string, uploads: number) {
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
  own.server.answer("POST", "/blobs", bodyLimit);
  scripted(own.server, { create: [createdAs] });
  return { harness: own, stuck, noted };
}

function writesOf(requests: RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.pathname}`);
}

describe("writes that each fail alone, and the write behind them", () => {
  it("sets two stuck uploads aside together once a note behind them lands, in the fifth drain", async () => {
    const { harness: own, stuck, noted } = await stuckUploads("two-stuck", 2);
    const sent: string[][] = [];
    const landed: Array<string | null> = [];
    for (let drain = 1; drain <= 5; drain += 1) {
      const seen = await drainSeen(own);
      sent.push(writesOf(seen.requests));
      landed.push(
        seen.report.verdicts.find((verdict) => verdict.id === noted.id)
          ?.verdict ?? null,
      );
    }
    const upload = "POST /blobs";
    expect(
      sent,
      "the drains did not send what the rule says: the first upload alone twice, then it and the second as its test, then the note as the test of both",
    ).toEqual([
      [upload],
      [upload],
      [upload, upload],
      [upload, upload],
      [upload, upload, "POST /items"],
    ]);
    expect(
      landed,
      "the note was taken in a drain other than the fifth, or never",
    ).toEqual([null, null, null, null, "accepted"]);
    const queue = await queueOf(own);
    expect(
      queue.map((row) => [row.id, row.verdict, row.reason, row.refusals]),
      "the two uploads were not both set aside, or the note was not taken",
    ).toEqual([
      [stuck[0]?.id, "blocked", "failing_alone", 0],
      [stuck[1]?.id, "blocked", "failing_alone", 0],
      [noted.id, "accepted", null, 0],
    ]);
    expect(
      queue.slice(0, 2).map((row) => row.last_failure?.status),
      "the queue does not say what each upload last met",
    ).toEqual([413, 413]);
    // Nothing is sent for either of them after.
    const again = await drainSeen(own);
    expect(again.requests).toEqual([]);
  });

  it("sets three stuck uploads aside together once a note behind them lands, in the seventh drain", async () => {
    const { harness: own, stuck, noted } = await stuckUploads("three-stuck", 3);
    const upload = "POST /blobs";
    const sent: string[][] = [];
    for (let drain = 1; drain <= 7; drain += 1) {
      sent.push(writesOf((await drainSeen(own)).requests));
    }
    expect(sent).toEqual([
      [upload],
      [upload],
      [upload, upload],
      [upload, upload],
      [upload, upload, upload],
      [upload, upload, upload],
      [upload, upload, upload, "POST /items"],
    ]);
    expect(
      (await queueOf(own)).map((row) => [row.id, row.verdict, row.reason]),
      "three stuck uploads were not all set aside together by the note that landed",
    ).toEqual([
      [stuck[0]?.id, "blocked", "failing_alone"],
      [stuck[1]?.id, "blocked", "failing_alone"],
      [stuck[2]?.id, "blocked", "failing_alone"],
      [noted.id, "accepted", null],
    ]);
  });

  it("leaves a note behind four stuck uploads unsent, and sets nothing aside, because a drain tests with three writes at most", async () => {
    const { harness: own, stuck, noted } = await stuckUploads("four-stuck", 4);
    const upload = "POST /blobs";
    const sent: string[][] = [];
    for (let drain = 1; drain <= 12; drain += 1) {
      sent.push(writesOf((await drainSeen(own)).requests));
    }
    expect(
      sent,
      "a drain sent more than the write tested and three writes to test it with, or fewer than the rule allows",
    ).toEqual([
      [upload],
      [upload],
      [upload, upload],
      [upload, upload],
      [upload, upload, upload],
      [upload, upload, upload],
      ...Array.from({ length: 6 }, () => [upload, upload, upload, upload]),
    ]);
    const queue = await queueOf(own);
    expect(
      queue.map((row) => [row.id, row.verdict, row.environmental_streak]),
      "the cap set an upload aside, or sent the note, though no write the server answers was sent",
    ).toEqual([
      [stuck[0]?.id, null, 12],
      [stuck[1]?.id, null, 10],
      [stuck[2]?.id, null, 8],
      [stuck[3]?.id, null, 6],
      [noted.id, null, 0],
    ]);
    expect(requestsTo(own, "POST", "/items")).toHaveLength(0);

    // The witness is the test above: with one stuck upload fewer, the same
    // note lands in the seventh drain.
  });

  it("sends at most four requests a drain, and sets nothing aside, in an outage that fails ten queued writes", async () => {
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
    const counts: number[] = [];
    for (let drain = 1; drain <= 16; drain += 1) {
      const seen = await drainSeen(own);
      counts.push(writesOf(seen.requests).length);
      expect(
        seen.report.answered,
        "a drain against a gateway that failed every write reported an answer",
      ).toBe(0);
    }
    expect(
      Math.max(...counts),
      "an outage cost more than the first write and the three that test it",
    ).toBe(4);
    expect(
      counts,
      "the requests a drain sent did not grow by one write at a time to the cap and stay there",
    ).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
    expect(
      (await queueOf(own)).map((row) => [row.verdict, row.refusals]),
      "an outage set a write aside or counted a refusal",
    ).toEqual(Array.from({ length: 10 }, () => [null, 0]));

    // The witness: when the gateway recovers, every write goes in one drain.
    down = false;
    const back = await drainOnce(own);
    expect(back.answered).toBe(10);
    expect(
      (await queueOf(own)).map((row) => [
        row.verdict,
        row.environmental_streak,
      ]),
    ).toEqual(Array.from({ length: 10 }, () => ["accepted", 0]));
  });

  it("ends the pass at a write sent to test them that the server limits, adding nothing to its streak", async () => {
    harness = await hydratedHarness("stuck-test-limited", { rows: held() });
    const own = harness;
    const stuck = await note(own, "stuck");
    const limited = await note(own, "limited");
    const behind = await note(own, "behind");
    let limit = true;
    scripted(own.server, {
      create: [
        (request) =>
          titleOf(request) === "stuck"
            ? gateway(502, "<html>bad gateway</html>")
            : titleOf(request) === "limited" && limit
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
      const seen = await drainSeen(own);
      sent.push(writesOf(seen.requests));
      if (drain >= 3) expect(seen.report.retry_after_seconds).toBe(7);
    }
    expect(
      sent.map((requests) => requests.length),
      "a write sent to test that the server limited did not end the pass, or was not sent",
    ).toEqual([1, 1, 2, 2, 2, 2]);
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

    // The witness: once the server stops limiting, the same writes are
    // tested, and the stuck write is set aside.
    limit = false;
    const report = await drainOnce(own);
    expect(
      report.verdicts.map((verdict) => [verdict.id, verdict.verdict]),
    ).toEqual([
      [stuck.id, "blocked"],
      [limited.id, "accepted"],
      [behind.id, "accepted"],
    ]);
  });

  it("never sends a write that waits on the second stuck upload to test them, and holds it", async () => {
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
    for (let drain = 1; drain <= 5; drain += 1) {
      sent.push(writesOf((await drainSeen(own)).requests));
    }
    expect(
      sent.at(-1),
      "the fifth drain sent the file item or the edge that wait on the second upload, or not the note",
    ).toEqual(["POST /blobs", "POST /blobs", "POST /items"]);
    expect(
      titleOf(requestsTo(own, "POST", "/items")[0] as RecordedRequest),
      "the one write that tested the uploads was not the independent note",
    ).toBe("independent");
    expect(requestsTo(own, "POST", "/items")).toHaveLength(1);
    expect(requestsTo(own, "POST", "/edges")).toHaveLength(0);
    expect(
      (await queueOf(own)).map((row) => [row.kind, row.verdict, row.reason]),
    ).toEqual([
      ["upload_blob", "blocked", "failing_alone"],
      ["upload_blob", "blocked", "failing_alone"],
      ["create_item", "blocked", "awaiting_dependency"],
      ["create_edge", "blocked", "awaiting_dependency"],
      ["create_item", "accepted", null],
    ]);
    expect((await queueOf(own))[4]?.id).toBe(independent.id);
  });
});
