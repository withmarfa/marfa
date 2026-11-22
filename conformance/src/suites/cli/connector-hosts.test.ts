import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { connectorBundle, fresh } from "../../utils/plugin-connector.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { Cli, requireBinary } from "./harness.js";

/**
 * An owner runs a plugin's connector from the terminal: makes a connector
 * host and its one-time link, installs a plugin onto it, moves its connector
 * and removes the plugin. Hosts are the instance's, so the server is this
 * file's own.
 */

let server: FreshServer;
let cli: Cli;
let owner: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("cli-connector-hosts");
  const local = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
  const made = await local.createKey({
    label: "cli connector hosts",
    source: `cli-connector-hosts-owner-${fresh()}`,
    permissions: ["schema.write", "connectors.manage", "keys.manage"],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  cli = new Cli(requireBinary(), server.apiUrl, made.data.key!);
  owner = new MarfaClient({ baseUrl: server.apiUrl, apiKey: made.data.key! });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function bundleFile(name: string): string {
  const root = name.replaceAll("-", "");
  const file = join(
    tempFolder("marfa-connector-bundle-"),
    `${name}.plugin.json`,
  );
  writeFileSync(file, JSON.stringify(connectorBundle(name, root, name)));
  return file;
}

async function removeEveryHost(): Promise<void> {
  const listed = await owner.listConnectorHosts();
  for (const host of listed.data.data) {
    await owner.removeConnectorHost(host.id);
  }
}

describe("connector hosts from the terminal", () => {
  it("makes, lists, reads, links and removes a host, printing its one-time link", async () => {
    await removeEveryHost();
    const name = `Studio ${fresh()}`;
    const added = await cli.run(["hosts", "add", name]);
    expect(added.code, added.stderr).toBe(0);
    const link = added.stdout.match(/\S+\/connect#\S+/)?.[0];
    expect(link, added.stdout).toBeDefined();
    const json = await cli.run(["--json", "hosts", "list"]);
    expect(json.code, json.stderr).toBe(0);
    const hosts = JSON.parse(json.stdout) as {
      data: { id: string; name: string }[];
    };
    const id = hosts.data.find((host) => host.name === name)?.id;
    expect(id).toBeDefined();
    // By name, as by ID.
    const read = await cli.run(["--json", "hosts", "get", name]);
    expect(read.code, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout).id).toBe(id);
    const relinked = await cli.run(["hosts", "link", name]);
    expect(relinked.code, relinked.stderr).toBe(0);
    const fresh_link = relinked.stdout.match(/\S+\/connect#\S+/)?.[0];
    expect(fresh_link).toBeDefined();
    expect(fresh_link).not.toBe(link);
    const code = fresh_link!.split("#")[1]!;
    expect((await owner.redeemConnectorLink({ code })).status).toBe(201);
    const unknown = await cli.run(["hosts", "get", "no such host"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("no connector host is named");
    const removed = await cli.run(["hosts", "remove", id!]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("revoked 1 key");
    expect((await owner.getConnectorHost(id!)).status).toBe(404);
  });

  it("installs a plugin with a connector onto a host with --host, and names the one host it could use without it", async () => {
    await removeEveryHost();
    const only = `Only ${fresh()}`;
    expect((await cli.run(["hosts", "add", only])).code).toBe(0);
    const unassigned = `unassigned-${fresh()}`;
    const named = await cli.run(["plugins", "install", bundleFile(unassigned)]);
    expect(named.code, named.stderr).toBe(0);
    expect(named.stdout).toContain(`host ${only} could run it`);
    expect((await owner.getPlugin(unassigned)).data.connector_host).toBeNull();

    const second = `Second ${fresh()}`;
    expect((await cli.run(["hosts", "add", second])).code).toBe(0);
    const assigned = `assigned-${fresh()}`;
    const onto = await cli.run([
      "plugins",
      "install",
      bundleFile(assigned),
      "--host",
      second,
    ]);
    expect(onto.code, onto.stderr).toBe(0);
    expect(onto.stdout).toContain(`its connector runs on host ${second}`);
    const hosts = await owner.listConnectorHosts();
    const secondId = hosts.data.data.find((host) => host.name === second)?.id;
    expect((await owner.getPlugin(assigned)).data.connector_host).toBe(
      secondId,
    );
    // With two hosts, it names none.
    const another = `another-${fresh()}`;
    const neither = await cli.run(["plugins", "install", bundleFile(another)]);
    expect(neither.code, neither.stderr).toBe(0);
    expect(neither.stdout).not.toContain("could run it");
    expect(neither.stdout).toContain("runs on no host yet");
  });

  it("assigns a connector to a host and to none, and says what removing its plugin stops and keeps", async () => {
    const host = `Assigning ${fresh()}`;
    expect((await cli.run(["hosts", "add", host])).code).toBe(0);
    const name = `moving-${fresh()}`;
    expect((await cli.run(["plugins", "install", bundleFile(name)])).code).toBe(
      0,
    );
    const onto = await cli.run(["plugins", "assign", name, "--host", host]);
    expect(onto.code, onto.stderr).toBe(0);
    expect(onto.stdout).toContain(`${name}'s connector runs on host`);
    const off = await cli.run(["plugins", "assign", name, "--none"]);
    expect(off.code, off.stderr).toBe(0);
    expect(off.stdout).toContain(`${name}'s connector runs on no host`);
    const neither = await cli.run(["plugins", "assign", name]);
    expect(neither.code).not.toBe(0);
    const removed = await cli.run(["plugins", "remove", name]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("its connector stopped");
    expect(removed.stdout).toContain(`source ${name} keeps`);
  });
});
