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

/**
 * The three cases the resolver used to conflate.
 *
 * Before this, `load()` wrapped the connection read in a bare try/catch,
 * assigned `mapping = null` on any throw, and set its loaded flag BEFORE
 * the read. So a failed read was indistinguishable from never having
 * configured a mapping, and one transient blip was cached for the whole
 * dispatch: the user's routing stopped applying, every subsequent record
 * went to the family, and the run reported itself healthy.
 *
 * That is the shape of the defect this whole wave exists to remove, so
 * these are the tests that would have caught it.
 */
describe("createMappingResolver — when the mapping does not apply", () => {
  function failingClient(failures: number): {
    client: ConnectionClient;
    getItem: ReturnType<typeof vi.fn>;
  } {
    let calls = 0;
    const getItem = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls <= failures) return Promise.reject(new Error("pool exhausted"));
      return Promise.resolve({
        id: "conn-1",
        type: "system.connection",
        properties: { kind: "integration", mapping: MAPPING },
      });
    });
    return { client: { getItem } as unknown as ConnectionClient, getItem };
  }

  it("retries a failed read instead of caching it for the whole run", async () => {
    const { client, getItem } = failingClient(1);
    const resolver = createMappingResolver(client, "conn-1");

    // First record loses to the blip and takes the family.
    expect(await resolver.resolve({ kind: "article", title: "a" })).toEqual({
      kind: "family",
    });
    // The next one must retry rather than inherit the failure. This is
    // the assertion that fails against the original implementation.
    expect(await resolver.resolve({ kind: "article", title: "b" })).toEqual({
      kind: "user",
      input: { type: "user.reading_log", properties: { title: "b" } },
    });
    expect(getItem).toHaveBeenCalledTimes(2);
  });

  it("gives up after a bounded number of failures rather than reading per record", async () => {
    const { client, getItem } = failingClient(99);
    const resolver = createMappingResolver(client, "conn-1");
    for (let i = 0; i < 10; i++) {
      await resolver.resolve({ kind: "article", title: String(i) });
    }
    expect(getItem).toHaveBeenCalledTimes(3);
  });

  it("reports a read it could not complete, rather than looking like no mapping", async () => {
    const { client } = failingClient(99);
    const resolver = createMappingResolver(client, "conn-1");
    for (let i = 0; i < 5; i++) {
      await resolver.resolve({ kind: "article", title: String(i) });
    }
    const { emitted, activity } = sink();
    await resolver.flushSkipSummary(activity);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      severity: "action_required",
      detail: { reason: "mapping_unreadable", read_attempts: 3 },
    });
  });

  it("reports a stored mapping that will not parse", async () => {
    const { client } = clientWith({ version: 1, rules: "not-an-array" });
    const resolver = createMappingResolver(client, "conn-1");
    expect(await resolver.resolve({ kind: "article" })).toEqual({
      kind: "family",
    });

    const { emitted, activity } = sink();
    await resolver.flushSkipSummary(activity);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      severity: "action_required",
      detail: { reason: "mapping_unparseable" },
    });
  });

  it("says nothing at all when no mapping is configured", async () => {
    const { client } = clientWith(undefined);
    const resolver = createMappingResolver(client, "conn-1");
    expect(await resolver.resolve({ kind: "article" })).toEqual({
      kind: "family",
    });

    const { emitted, activity } = sink();
    await resolver.flushSkipSummary(activity);
    // The one genuinely silent case: the connection is doing exactly what
    // it was asked to. A row here would be noise on every unmapped run.
    expect(emitted).toEqual([]);
  });

  it("reports the degradation once, not once per flush", async () => {
    const { client } = clientWith({ version: 1, rules: "not-an-array" });
    const resolver = createMappingResolver(client, "conn-1");
    await resolver.resolve({ kind: "article" });

    const first = sink();
    await resolver.flushSkipSummary(first.activity);
    expect(first.emitted).toHaveLength(1);

    const second = sink();
    await resolver.flushSkipSummary(second.activity);
    expect(second.emitted).toEqual([]);
  });
});
