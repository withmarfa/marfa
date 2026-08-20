import { describe, expect, it, vi } from "vitest";
import { createMappingResolver } from "./mapping.js";
import type { ConnectionClient } from "./connection-client.js";
import type { ActivitySink } from "./activity.js";

const MAPPING = {
  version: 1,
  rules: [
    {
      when: { path: "kind", op: "equals", value: "article" },
      target_type: "user.reading_log",
      assign: { title: { path: "title" } },
    },
  ],
  otherwise: "skip",
};

function clientWith(mapping: unknown): {
  client: ConnectionClient;
  getItem: ReturnType<typeof vi.fn>;
} {
  const getItem = vi.fn().mockResolvedValue({
    id: "conn-1",
    type: "system.connection",
    properties: { kind: "integration", mapping },
  });
  return { client: { getItem } as unknown as ConnectionClient, getItem };
}

function sink(): { emitted: unknown[]; activity: ActivitySink } {
  const emitted: unknown[] = [];
  return {
    emitted,
    activity: {
      emit: (input: unknown) => {
        emitted.push(input);
        return Promise.resolve();
      },
    },
  };
}

describe("createMappingResolver", () => {
  it("routes matches, skips the rest, and reads the connection once", async () => {
    const { client, getItem } = clientWith(MAPPING);
    const resolver = createMappingResolver(client, "conn-1");

    const routed = await resolver.resolve({ kind: "article", title: "A" });
    expect(routed).toEqual({
      kind: "user",
      input: { type: "user.reading_log", properties: { title: "A" } },
    });
    const skipped = await resolver.resolve({ kind: "podcast" });
    expect(skipped).toEqual({ kind: "skip" });
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it("answers family for a connection with no mapping, costing one read", async () => {
    const resolver = createMappingResolver(
      clientWith(undefined).client,
      "conn-1",
    );
    expect(await resolver.resolve({ kind: "article" })).toEqual({
      kind: "family",
    });
  });

  it("treats an unparseable stored mapping as absent rather than failing the run", async () => {
    const resolver = createMappingResolver(
      clientWith({ version: 99, rules: "nope" }).client,
      "conn-1",
    );
    expect(await resolver.resolve({ kind: "article" })).toEqual({
      kind: "family",
    });
  });

  it("flushes deliberate skips as one summary row, then resets", async () => {
    const resolver = createMappingResolver(
      clientWith(MAPPING).client,
      "conn-1",
    );
    await resolver.resolve({ kind: "podcast" });
    await resolver.resolve({ kind: "video" });
    const { emitted, activity } = sink();
    await resolver.flushSkipSummary(activity);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      severity: "info",
      detail: { skipped: 2 },
    });
    await resolver.flushSkipSummary(activity);
    expect(emitted).toHaveLength(1);
  });
});
