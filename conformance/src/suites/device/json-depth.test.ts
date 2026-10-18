import { afterEach, expect, it } from "vitest";
import { hydratedHarness, type Harness } from "./harness.js";
import type { Outcome } from "../../device/protocol.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

function body(depth: number, shape: "arrays" | "objects" | "mixed") {
  let nested: unknown = '[{"quoted":"\\\""}]'.repeat(80);
  for (let level = 1; level < depth; level++) {
    nested =
      shape === "arrays" || (shape === "mixed" && level % 2 === 0)
        ? [nested]
        : { nested };
  }
  return { body: "depth witness", nested };
}

it("accepts 64 containers and refuses 65 without changing the queue or held rows", async () => {
  for (const shape of ["arrays", "objects", "mixed"] as const) {
    harness = await hydratedHarness(`depth-${shape}`, {
      rows: { "core.note": [{ item: { id: "held", version: 3 } }] },
    });
    const { device, server } = harness;
    const edge =
      value(
        await device.createEdge({
          source: "held",
          target: "other",
          type: "references",
          properties: { witness: "edge" },
        }),
      ).edge_id ?? "";
    const doors = [
      {
        name: "item create",
        wrapper: 1,
        write: (properties: Record<string, unknown>) =>
          device.create({ type: "core.note", properties }),
      },
      {
        name: "item update",
        wrapper: 1,
        write: (properties: Record<string, unknown>) =>
          device.update("held", { properties, version: 3 }),
      },
      {
        name: "edge create",
        wrapper: 1,
        write: (properties: Record<string, unknown>) =>
          device.createEdge({
            source: "held",
            target: "other",
            type: "references",
            properties,
          }),
      },
      {
        name: "edge update",
        wrapper: 1,
        write: (properties: Record<string, unknown>) =>
          device.updateEdge(edge, { properties, version: 0 }),
      },
      {
        name: "extension write",
        wrapper: 0,
        write: (properties: Record<string, unknown>) =>
          device.writeExtension("held", "app.depth", properties),
      },
    ];
    const reads = server.requests.length;
    for (const door of doors) {
      const beforeWitness = value(await device.queue()).length;
      const accepted = body(64 - door.wrapper, shape);
      value(await door.write(accepted));
      expect(value(await device.queue()).length, door.name).toBe(
        beforeWitness + 1,
      );
      const queued = value(await device.queue()).at(-1);
      expect(
        door.wrapper === 0
          ? queued?.body
          : (queued?.body as { properties: unknown }).properties,
        door.name,
      ).toEqual(accepted);
      const before = {
        queue: value(await device.queue()),
        items: value(await device.list()),
        edges: value(await device.edgesFrom("held")),
      };
      const refused = await door.write(body(65 - door.wrapper, shape));
      expect(refused.ok, `${door.name}: ${JSON.stringify(refused)}`).toBe(
        false,
      );
      if (!refused.ok)
        expect(refused.refusal.code, refused.refusal.raw).toBe("invalid");
      expect(value(await device.queue()), door.name).toEqual(before.queue);
      expect(value(await device.list()), door.name).toEqual(before.items);
      expect(value(await device.edgesFrom("held")), door.name).toEqual(
        before.edges,
      );
    }
    expect(server.requests.length, "local writes reached the server").toBe(
      reads,
    );
    await harness.stop();
    harness = undefined;
  }
});
