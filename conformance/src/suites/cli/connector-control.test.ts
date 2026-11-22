import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  connectorKey,
  fresh,
  installed,
  local,
} from "../../utils/connector-plugin.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { Cli, requireBinary } from "./harness.js";

/**
 * An owner pauses a plugin's connector, resumes it, asks it to run now and
 * asks it for a mapping preview from the terminal, while this file plays the
 * connector. The server is this file's own, since plugins are the instance's.
 */

let server: FreshServer;
let cli: Cli;
let owner: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("cli-connector-control");
  const made = await local(server).createKey({
    label: "cli connector control",
    source: `cli-control-owner-${fresh()}`,
    permissions: ["schema.write", "connectors.manage"],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    metadata_permissions: { "*": "write" },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  cli = new Cli(requireBinary(), server.apiUrl, made.data.key!);
  owner = new MarfaClient({ baseUrl: server.apiUrl, apiKey: made.data.key! });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

type State = {
  plugin: string;
  paused: boolean;
  run_requested_at: string | null;
};
type Preview = {
  id: string;
  status: string;
  result: unknown;
  mapping: Record<string, unknown> | null;
};

/** The first pending preview of the plugin, as its connector finds it. */
async function pendingOf(own: MarfaClient, name: string): Promise<Preview> {
  for (;;) {
    const listed = await own.listMappingPreviews(name, "pending");
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    const first = listed.data.data[0] as Preview | undefined;
    if (first !== undefined) return first;
    await sleep(100);
  }
}

describe("a connector's pause, run and preview from the terminal", () => {
  it("pauses, resumes and runs a connector now, and shows what the owner chose", async () => {
    const plugin = await installed(owner);
    const asked = await cli.json<State>(["plugins", "run", plugin.name]);
    expect(asked.plugin).toBe(plugin.name);
    expect(asked.paused).toBe(false);
    expect(typeof asked.run_requested_at).toBe("string");
    expect(await cli.json<State>(["plugins", "status", plugin.name])).toEqual(
      asked,
    );

    const paused = await cli.json<State>(["plugins", "pause", plugin.name]);
    expect(paused).toMatchObject({ paused: true, run_requested_at: null });
    const refused = await cli.refused(["plugins", "run", plugin.name]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.server?.code).toBe("connector_paused");

    const resumed = await cli.json<State>(["plugins", "resume", plugin.name]);
    expect(resumed.paused).toBe(false);
    expect((await owner.getConnectorControl(plugin.name)).data.paused).toBe(
      false,
    );
    const said = await cli.run(["plugins", "status", plugin.name]);
    expect(said.code, said.stderr).toBe(0);
    expect(said.stdout).toContain(plugin.name);
  });

  it("asks for a mapping preview with a draft from a YAML file, and with --wait prints the connector's answer or refuses its failure", async () => {
    const plugin = await installed(owner);
    const { client: own } = await connectorKey(server, plugin);
    const draft = join(tempFolder("marfa-preview-draft-"), "draft.yaml");
    writeFileSync(draft, "tier: library\n");

    const asked = await cli.json<Preview>([
      "plugins",
      "mapping",
      "preview",
      plugin.name,
      "--kind",
      "issue",
      "--file",
      draft,
    ]);
    expect(asked.status).toBe("pending");
    expect(asked.mapping).toMatchObject({ tier: "library" });
    const first = await own.answerMappingPreview(plugin.name, asked.id, {
      error: "Cleared before the next.",
    });
    expect(first.status, JSON.stringify(first.error)).toBe(200);

    const rendered = { title: "Rendered in the connector" };
    const waiting = cli.json<Preview>([
      "plugins",
      "mapping",
      "preview",
      plugin.name,
      "--kind",
      "issue",
      "--wait",
    ]);
    const pending = await pendingOf(own, plugin.name);
    expect(pending.mapping).toBeNull();
    const answered = await own.answerMappingPreview(plugin.name, pending.id, {
      result: rendered,
    });
    expect(answered.status, JSON.stringify(answered.error)).toBe(200);
    const ready = await waiting;
    expect(ready).toMatchObject({
      id: pending.id,
      status: "ready",
      result: rendered,
    });

    const failing = cli.refused([
      "plugins",
      "mapping",
      "preview",
      plugin.name,
      "--kind",
      "comment",
      "--wait",
    ]);
    const next = await pendingOf(own, plugin.name);
    expect(
      (
        await own.answerMappingPreview(plugin.name, next.id, {
          error: "No comment to render.",
        })
      ).status,
    ).toBe(200);
    const failed = await failing;
    expect(failed.code).toBe(1);
    expect(failed.envelope.error.code).toBe("preview_ended");
    expect(failed.envelope.error.message).toContain("No comment to render.");
  });
});
