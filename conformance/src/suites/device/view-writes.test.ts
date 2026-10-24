import { expect, it } from "vitest";
import { answers, typeCatalog, wireItem } from "../../device/marfa-answers.js";
import { scriptHydration, startBindingHarness } from "./harness.js";
import type { Outcome } from "../../device/protocol.js";

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

it("returns an accepted change when its read-back fails, leaving refresh to a later read", async () => {
  const harness = await startBindingHarness("view-write-readback");
  const { server, device } = harness;
  try {
    const id = "01a00000-0000-7000-8000-00000000face";
    const settings = {
      title: "Before",
      sort: [{ by: "title", direction: "asc" }],
    };
    const row = { id, type: "system.view", properties: settings };
    scriptHydration(server, {
      head: "1",
      rows: { "system.view": [{ item: row }] },
      catalog: typeCatalog([{ id: "system.view", version: 0, fields: {} }]),
    });
    value(await device.hydrate(["system.view"], "all"));
    const before = value(await device.call("view", id));
    const changed = {
      ...row,
      properties: { ...settings, title: "After" },
      version: 2,
    };
    server.answer("PATCH", `/views/${id}`, answers.updated(wireItem(changed)));
    let readable = false;
    server.copyAnswer("GET", `/items/${id}`, () =>
      readable ? answers.updated(wireItem(changed)) : { kind: "drop" },
    );
    const accepted = value(
      await device.call("changeView", id, { title: "After" }, 1),
    );
    expect(accepted).toMatchObject({
      id,
      version: 2,
      settings: changed.properties,
    });
    expect(value(await device.call("view", id))).toEqual(before);
    expect(value(await device.queue())).toEqual([]);

    // The witness: with read-back available the same accepted answer is held.
    readable = true;
    value(await device.call("changeView", id, { title: "After" }, 1));
    expect(value(await device.call("view", id))).toEqual(accepted);
  } finally {
    await harness.stop();
  }
});
