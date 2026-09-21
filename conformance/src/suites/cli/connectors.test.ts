import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackKey } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext } from "./harness.js";

/**
 * A process that writes on a key's behalf, from the terminal: it registers
 * its key as a connector, says it is alive, reports a run, and the operator
 * sees every registration and removes one. The key is the identity, so the
 * heartbeat and the run report are the connector's own key's and nobody
 * else's, the operator's included.
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
    const runs = await c.cli.json<{
      data: Array<{ id: string; outcome: string; error: string | null }>;
    }>(["connectors", "runs", registered.id, "--limit", "5"]);
    expect(runs.data.map((row) => row.id)).toContain(run.id);
    expect(runs.data[0]?.error).toBe("the mailbox refused");
    const after = await c.cli.json<Connector>([
      "connectors",
      "get",
      registered.id,
    ]);
    expect(after.last_heartbeat_at).toBe(beat.last_heartbeat_at);
    expect(after.last_run?.outcome).toBe("failed");

    await c.operator.json(["connectors", "delete", registered.id]);
    const gone = await c.cli.refused(["connectors", "get", registered.id]);
    expect(gone.envelope.error.code).toBe("not_found");
    expect(gone.envelope.error.server?.code).toBe("connector_not_found");
  });
});
