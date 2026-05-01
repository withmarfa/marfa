import { describe, it, expect, vi } from "vitest";
import { createActivitySink } from "./activity.js";
import type { ConnectionClient, CreateItemInput } from "./connection-client.js";

function makeClientStub(): {
  client: ConnectionClient;
  calls: CreateItemInput[];
} {
  const calls: CreateItemInput[] = [];
  const client = {
    createItem: vi.fn((input: CreateItemInput) => {
      calls.push(input);
      return Promise.resolve({ id: "act_1", type: "system.activity" });
    }),
  } as unknown as ConnectionClient;
  return { client, calls };
}

describe("createActivitySink", () => {
  it("emits a system.activity item with severity + summary + connection_id", async () => {
    const { client, calls } = makeClientStub();
    const sink = createActivitySink(client, "conn_1");
    await sink.emit({
      severity: "info",
      summary: "Imported 12 issues from GitHub",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: "system.activity",
      properties: {
        connection_id: "conn_1",
        severity: "info",
        summary: "Imported 12 issues from GitHub",
      },
    });
  });

  it("includes detail when supplied, omits when not", async () => {
    const { client, calls } = makeClientStub();
    const sink = createActivitySink(client, "conn_2");
    await sink.emit({
      severity: "error",
      summary: "GitHub returned 500",
      detail: { url: "https://api.github.com/issues", status: 500 },
    });
    expect(calls[0]!.properties).toMatchObject({
      detail: { url: "https://api.github.com/issues", status: 500 },
    });
  });

  it("supports the four severities", async () => {
    const { client, calls } = makeClientStub();
    const sink = createActivitySink(client, "conn_3");
    await sink.emit({ severity: "info", summary: "i" });
    await sink.emit({ severity: "warning", summary: "w" });
    await sink.emit({ severity: "error", summary: "e" });
    await sink.emit({ severity: "action_required", summary: "a" });
    expect(
      calls.map((c) => (c.properties as { severity: string }).severity),
    ).toEqual(["info", "warning", "error", "action_required"]);
  });
});
