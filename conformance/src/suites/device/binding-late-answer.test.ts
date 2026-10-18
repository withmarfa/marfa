import { describe, it, expect, afterEach, vi } from "vitest";
import type { BindingHarness } from "./harness.js";
import {
  HELD,
  bindingHarness,
  createsSent,
  queueNotes,
  servedBy,
  takeCreates,
  untilHeld,
  untilReached,
} from "./binding.shared.js";
import {
  answers,
  copyHeadRead,
  copyReplay,
} from "../../device/marfa-answers.js";
import { BUILT_FOR } from "../../device/scripted-server.js";

/**
 * An answer that arrives after the call it was for has gone on without it.
 * The command ends a call before another can begin, because it holds the
 * working copy for as long as the call runs; a binding runs the next call on
 * the copy while the first still waits on the server, which is where an
 * answer can come late.
 */

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("an answer that comes late", () => {
  it("lets a late answer neither expire nor change a copy a hydration has begun to replace since the request was made", async () => {
    const instance = { now: "instance-before" };
    const followed = await bindingHarness("binding-late-answer", {
      instance: () => instance.now,
    });
    harness = followed;
    const { server, device, events } = followed;
    const before = await device.status();
    expect(before.ok && before.value.instanceId).toBe("instance-before");
    await queueNotes(device, "waiting");
    takeCreates(server);

    // A drain asks the root which instance it is writing to before it sends.
    // The answer is held, and says what the root said before the server was
    // replaced.
    let lateRoot: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      lateRoot = resolve;
    });
    let asked = 0;
    server.answer("GET", "/", () => {
      asked += 1;
      return asked === 1
        ? {
            kind: "gated",
            until: answered,
            then: answers.root(Number(BUILT_FOR), "instance-before"),
          }
        : answers.root(Number(BUILT_FOR), instance.now);
    });

    const drain = device.drain();
    await vi.waitFor(() => {
      expect(asked, "the drain did not ask which instance it is").toBe(1);
    });

    // The server is now another instance, and a hydration begins to replace
    // the copy from it.
    instance.now = "instance-after";
    events.set(
      servedBy("instance-after", copyHeadRead("10")),
      servedBy("instance-after", copyReplay("10", [])),
      HELD,
    );
    await device.hooks.hold("hydration-replacing");
    const hydration = device.hydrate(["core.note"], "library");
    await untilHeld(device, "hydration-replacing");
    const replacing = await device.status();
    expect(
      replacing.ok && [replacing.value.hydration, replacing.value.instanceId],
      "the hydration had not begun to replace the copy",
    ).toEqual(["in_progress", "instance-after"]);

    // The answer comes now.
    lateRoot();
    const late = await drain;
    expect(
      late.ok ? "ended" : late.refusal.code,
      "a drain whose answer came after the copy was replaced went on, or expired the copy",
    ).not.toBe("copy_expired");
    expect(
      createsSent(server),
      "a write was sent on the strength of an answer about a copy that is gone",
    ).toEqual([]);
    const during = await device.status();
    expect(
      during.ok && [during.value.hydration, during.value.instanceId],
      "the late answer changed the copy being built",
    ).toEqual(["in_progress", "instance-after"]);

    await device.hooks.release("hydration-replacing");
    const built = await hydration;
    expect(
      built.ok ? "built" : built.refusal.code,
      "the late answer expired the copy the hydration was building",
    ).toBe("built");
    const after = await device.status();
    expect(after.ok && [after.value.hydration, after.value.instanceId]).toEqual(
      ["complete", "instance-after"],
    );
  });
});

describe("the answer to a write a stopped drain left in flight", () => {
  it("records no answer to a write a stopped drain left in flight when it arrives after the drain has ended, and records the server's answer once the next drain sends the write again under its key", async () => {
    const followed = await bindingHarness("binding-stop-late-answer");
    harness = followed;
    const { server, device } = followed;
    const [queued] = await queueNotes(device, "in flight");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    takeCreates(server, (take) => [
      (request) => ({ kind: "gated", until: gate, then: take(request) }),
    ]);

    const stop = await device.newStop();
    const drain = device.drain(stop);
    await vi.waitFor(() => {
      expect(createsSent(server)).toEqual([queued]);
    });
    await stop.raise();
    const stopped = await drain;
    expect(
      stopped.ok ? "ended" : stopped.refusal.code,
      "a stopped drain waited on the write it had in flight",
    ).toBe("canceled");

    // The server answers now, with the drain gone.
    release();
    await untilReached(device, "answer-dropped");
    const left = await device.queue();
    expect(
      left.ok &&
        left.value.map((row) => [row.verdict, row.answer, row.refusals]),
      "the answer to a write a stopped drain had in flight was recorded after the drain ended",
    ).toEqual([[undefined, undefined, 0]]);

    // The witness: the next drain sends it again, under the key it had, and
    // records the answer.
    const next = await device.drain();
    expect(next.ok && next.value.answered, JSON.stringify(next)).toBe(1);
    const sent = server.requests.filter(
      (request) => request.method === "POST" && request.pathname === "/items",
    );
    expect(sent.map((request) => request.headers["idempotency-key"])).toEqual([
      sent[0]?.headers["idempotency-key"],
      sent[0]?.headers["idempotency-key"],
    ]);
    expect(sent[0]?.headers["idempotency-key"]).toBeTruthy();
    const queue = await device.queue();
    expect(queue.ok && queue.value.map((row) => row.verdict)).toEqual([
      { verdict: "accepted" },
    ]);
  });
});
