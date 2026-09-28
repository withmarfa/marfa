import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem, trackKey } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext } from "./harness.js";

/**
 * A CLI process writing on a key's behalf, registered as a connector. The
 * key is the identity: its heartbeat, run, hold and state are its own, not even the operator's.
 */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("connectors");
});

afterAll(async () => {
  await cleanup(c.ctx);
});

interface Connector {
  id: string;
  key_id: string;
  source: string;
  name: string;
  description: string | null;
  last_heartbeat_at: string | null;
  last_run: { outcome: string } | null;
}

describe("connectors from the terminal", () => {
  it("registers, heartbeats, reports a run, and is removed by the operator", async () => {
    // A key of the connector's own, so the file's key is not the one
    // registered and the operator's refusal below is not a self-refusal.
    const minted = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "connector",
      "--source",
      unique("cli-connector"),
      "--type-permission",
      "core.note=write",
    ]);
    trackKey(c.ctx, minted.id);
    const connector = c.cli.as(minted.key);

    const name = unique("cli-connector");
    const registered = await connector.json<Connector>([
      "connectors",
      "register",
      "--name",
      name,
      "--description",
      "reads a mailbox",
    ]);
    expect(registered.name).toBe(name);
    expect(registered.description).toBe("reads a mailbox");
    expect(registered.key_id).toBe(minted.id);
    expect(registered.last_heartbeat_at).toBeNull();
    expect(registered.last_run).toBeNull();

    // The same key registering again is the same connector, renamed.
    const renamed = await connector.json<Connector>([
      "connectors",
      "register",
      "--name",
      `${name}-renamed`,
    ]);
    expect(renamed.id).toBe(registered.id);
    expect(renamed.name).toBe(`${name}-renamed`);

    const listed = await c.operator.json<{ data: Connector[] }>([
      "connectors",
      "list",
    ]);
    expect(listed.data.map((row) => row.id)).toContain(registered.id);
    const read = await c.cli.json<Connector>([
      "connectors",
      "get",
      registered.id,
    ]);
    expect(read.name).toBe(`${name}-renamed`);

    const beat = await connector.json<{ last_heartbeat_at: string }>([
      "connectors",
      "heartbeat",
      registered.id,
    ]);
    expect(beat.last_heartbeat_at).toMatch(/^\d{4}-/);
    const notItsOwn = await c.operator.refused([
      "connectors",
      "heartbeat",
      registered.id,
    ]);
    expect(notItsOwn.code).toBe(1);
    expect(notItsOwn.envelope.error.server?.status).toBe(403);

    const run = await connector.json<{ id: string; outcome: string }>([
      "connectors",
      "report",
      registered.id,
      "--outcome",
      "failed",
      "--started-at",
      "2026-09-21T10:00:00Z",
      "--finished-at",
      "2026-09-21T10:01:00Z",
      "--error",
      "the mailbox refused",
    ]);
    expect(run.outcome).toBe("failed");
    const second = await connector.json<{ id: string; outcome: string }>([
      "connectors",
      "report",
      registered.id,
      "--outcome",
      "succeeded",
      "--started-at",
      "2026-09-21T11:00:00Z",
      "--finished-at",
      "2026-09-21T11:01:00Z",
      "--summary",
      "read the mailbox",
    ]);
    const runs = await c.cli.json<{
      data: Array<{ id: string; outcome: string; error: string | null }>;
    }>(["connectors", "runs", registered.id, "--limit", "5"]);
    expect(runs.data.map((row) => row.id)).toEqual([second.id, run.id]);
    expect(runs.data[1]?.error).toBe("the mailbox refused");
    const one = await c.cli.json<{ data: Array<{ id: string }> }>([
      "connectors",
      "runs",
      registered.id,
      "--limit",
      "1",
    ]);
    expect(one.data.map((row) => row.id)).toEqual([second.id]);
    const after = await c.cli.json<Connector>([
      "connectors",
      "get",
      registered.id,
    ]);
    expect(after.last_heartbeat_at).toBe(beat.last_heartbeat_at);
    expect(after.last_run?.outcome).toBe("succeeded");

    await c.operator.json(["connectors", "delete", registered.id]);
    const gone = await c.cli.refused(["connectors", "get", registered.id]);
    expect(gone.envelope.error.code).toBe("not_found");
    expect(gone.envelope.error.server?.code).toBe("connector_not_found");
  });

  it("makes an endpoint, reads what arrived at it a page at a time, marks it handled, and retires it", async () => {
    const minted = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "inbound",
      "--source",
      unique("cli-inbound"),
      "--type-permission",
      "core.note=write",
    ]);
    trackKey(c.ctx, minted.id);
    const connector = c.cli.as(minted.key);
    const registered = await connector.json<Connector>([
      "connectors",
      "register",
      "--name",
      unique("cli-inbound"),
    ]);

    const made = await connector.json<{
      id: string;
      path: string;
      url: string;
      duplicate_header: string | null;
    }>([
      "connectors",
      "endpoints",
      "create",
      registered.id,
      "--label",
      "sender",
      "--duplicate-header",
      "X-Delivery",
    ]);
    expect(made.duplicate_header).toBe("x-delivery");
    expect(made.url).toBe(`${c.apiUrl.replace(/\/$/, "")}${made.path}`);

    for (let i = 0; i < 2; i++) {
      const sent = await fetch(made.url, {
        method: "POST",
        headers: { "X-Delivery": "d-1" },
        body: "from the sender",
      });
      expect(sent.status).toBe(202);
    }

    interface Page {
      data: { id: string; duplicate_of: { id: string } | null }[];
      next_cursor: string | null;
    }
    const first = await connector.json<Page>([
      "connectors",
      "deliveries",
      "list",
      registered.id,
      "--limit",
      "1",
    ]);
    expect(first.data).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const rest = await connector.json<Page>([
      "connectors",
      "deliveries",
      "list",
      registered.id,
      "--limit",
      "1",
      "--cursor",
      first.next_cursor ?? "",
    ]);
    const [original] = first.data;
    const [repeat] = rest.data;
    if (original === undefined || repeat === undefined) {
      throw new Error("the two deliveries were not both listed");
    }
    expect(repeat.duplicate_of?.id).toBe(original.id);

    const body = await connector.run([
      "connectors",
      "deliveries",
      "body",
      registered.id,
      original.id,
    ]);
    expect(body.code).toBe(0);
    expect(body.stdout).toBe("from the sender");

    const handled = await connector.json<{ data: { outcome: string }[] }>([
      "connectors",
      "deliveries",
      "handle",
      registered.id,
      original.id,
      repeat.id,
      "--outcome",
      "processed",
    ]);
    expect(handled.data.map((row) => row.outcome)).toEqual([
      "processed",
      "processed",
    ]);
    const waiting = await connector.json<Page>([
      "connectors",
      "deliveries",
      "list",
      registered.id,
    ]);
    expect(waiting.data).toEqual([]);
    const notItsOwn = await c.operator.refused([
      "connectors",
      "deliveries",
      "list",
      registered.id,
    ]);
    expect(notItsOwn.envelope.error.server?.status).toBe(403);

    const listed = await connector.json<{ data: { path: string }[] }>([
      "connectors",
      "endpoints",
      "list",
      registered.id,
    ]);
    expect(listed.data.map((row) => row.path)).toEqual([
      `/inbound/****${made.path.slice(-4)}`,
    ]);
    const retired = await c.operator.json<{ retired_at: string | null }>([
      "connectors",
      "endpoints",
      "retire",
      registered.id,
      made.id,
    ]);
    expect(retired.retired_at).not.toBeNull();
    expect(
      (await fetch(made.url, { method: "POST", body: "late" })).status,
    ).toBe(404);

    await c.operator.json(["connectors", "delete", registered.id]);
  });

  it("holds its registration, keeps its state and agreements, and the operator clears them", async () => {
    const minted = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "keeper",
      "--source",
      unique("cli-keeper"),
      "--type-permission",
      "core.note=write",
    ]);
    trackKey(c.ctx, minted.id);
    const connector = c.cli.as(minted.key);
    const registered = await connector.json<Connector>([
      "connectors",
      "register",
      "--name",
      unique("cli-keeper"),
    ]);

    const held = await connector.json<{ expires_at: string }>([
      "connectors",
      "hold",
      registered.id,
      "--process",
      "first",
    ]);
    expect(held.expires_at).toMatch(/^\d{4}-/);
    const taken = await connector.refused([
      "connectors",
      "hold",
      registered.id,
      "--process",
      "second",
    ]);
    expect(taken.envelope.error.server?.status).toBe(409);
    expect(taken.envelope.error.server?.code).toBe("connector_held");

    const state = await connector.json<{
      state: unknown;
      updated_at: string | null;
    }>([
      "connectors",
      "state",
      "put",
      registered.id,
      "--process",
      "first",
      "--body",
      '{"cursor":"c1"}',
    ]);
    expect(state.state).toEqual({ cursor: "c1" });
    expect(
      await connector.json(["connectors", "state", "get", registered.id]),
    ).toEqual(state);

    const note = await c.cli.json<{ item: { id: string } }>([
      "items",
      "create",
      "--type",
      "core.note",
      "--prop",
      "body=agreed from the terminal",
    ]);
    trackItem(c.ctx, note.item.id);
    const written = await connector.json<{
      written: number;
      cleared: number;
      skipped: string[];
    }>([
      "connectors",
      "agreements",
      "write",
      registered.id,
      "--process",
      "first",
      "--body",
      JSON.stringify({
        set: [{ item_id: note.item.id, waiting: true, record: { etag: "e1" } }],
      }),
    ]);
    expect(written).toEqual({ written: 1, cleared: 0, skipped: [] });
    const found = await connector.json<{ data: { item_id: string }[] }>([
      "connectors",
      "agreements",
      "find",
      registered.id,
      note.item.id,
    ]);
    expect(found.data.map((row) => row.item_id)).toEqual([note.item.id]);
    const waiting = await connector.json<{ data: { item_id: string }[] }>([
      "connectors",
      "agreements",
      "list",
      registered.id,
      "--waiting",
      "true",
      "--limit",
      "10",
    ]);
    expect(waiting.data.map((row) => row.item_id)).toEqual([note.item.id]);

    await connector.json([
      "connectors",
      "release",
      registered.id,
      "--process",
      "first",
    ]);
    // Released, so the other process takes it.
    await connector.json([
      "connectors",
      "hold",
      registered.id,
      "--process",
      "second",
    ]);

    const notItsOwn = await c.operator.refused([
      "connectors",
      "state",
      "get",
      registered.id,
    ]);
    expect(notItsOwn.envelope.error.server?.status).toBe(403);
    await c.operator.json(["connectors", "state", "clear", registered.id]);
    expect(
      await connector.json(["connectors", "state", "get", registered.id]),
    ).toEqual({ state: {}, updated_at: null });
    const none = await connector.json<{ data: unknown[] }>([
      "connectors",
      "agreements",
      "find",
      registered.id,
      note.item.id,
    ]);
    expect(none.data).toEqual([]);

    await c.operator.json(["connectors", "delete", registered.id]);
  });
});
