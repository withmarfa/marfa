import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  connectorBundle,
  connectorKey,
  connectorSection,
  fresh,
  linkedHost,
} from "../../utils/plugin-connector.js";
import { Cli, requireBinary } from "./harness.js";

/**
 * An owner sets a plugin connector's settings from the terminal: plain values
 * on the command line, each as its kind, and a secret only on standard input,
 * never printed. The server is this file's own, since plugins are the
 * instance's.
 */

let server: FreshServer;
let cli: Cli;
let owner: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("cli-connector-settings");
  const local = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
  const made = await local.createKey({
    label: "cli connector settings",
    source: `cli-connector-settings-owner-${fresh()}`,
    permissions: ["schema.write", "connectors.manage"],
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

async function installed(): Promise<string> {
  const name = `cli-settings-${fresh()}`;
  const root = name.replaceAll("-", "");
  const bundle = connectorBundle(name, root, name, {
    connector: connectorSection(`${root}.entry`, name, {
      settings: [
        { name: "feed_url", label: "Feed", kind: "text", required: true },
        {
          name: "every",
          label: "Every",
          kind: "number",
          default: 30,
          required: false,
        },
        {
          name: "pictures",
          label: "Pictures",
          kind: "boolean",
          required: false,
        },
        { name: "code", label: "Code", kind: "text", required: false },
        {
          name: "token",
          label: "Token",
          kind: "text",
          secret: true,
          required: true,
        },
      ],
    }),
  });
  const made = await owner.installPlugin(bundle);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return name;
}

type Entry = { name: string; value: unknown; set: boolean };

async function settingOf(name: string, setting: string): Promise<Entry> {
  const read = await owner.getConnectorSettings(name);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return (read.data.settings as Entry[]).find((held) => held.name === setting)!;
}

describe("a connector's settings from the terminal", () => {
  it("lists and sets a connector's settings, each value sent as its kind, and refuses a secret named with --set", async () => {
    const name = await installed();
    const listed = await cli.run(["plugins", "settings", name]);
    expect(listed.code, listed.stderr).toBe(0);
    for (const setting of ["feed_url", "every", "pictures", "code", "token"]) {
      expect(listed.stdout).toContain(setting);
    }
    expect(listed.stdout).toContain("30");

    const set = await cli.json<{ settings: Entry[] }>([
      "plugins",
      "settings",
      name,
      "--set",
      "feed_url=https://cli.example.test/feed?a=b",
      "--set",
      "every=12.5",
      "--set",
      "pictures=true",
      "--set",
      "code=0042",
    ]);
    expect(set.settings.find((held) => held.name === "every")?.value).toBe(
      12.5,
    );
    expect(await settingOf(name, "feed_url")).toMatchObject({
      value: "https://cli.example.test/feed?a=b",
      set: true,
    });
    expect((await settingOf(name, "pictures")).value).toBe(true);
    // Text stays text, though it reads as a number.
    expect((await settingOf(name, "code")).value).toBe("0042");

    const wrongKind = await cli.refused([
      "plugins",
      "settings",
      name,
      "--set",
      "every=often",
    ]);
    expect(wrongKind.code).toBe(2);
    expect((await settingOf(name, "every")).value).toBe(12.5);

    const secret = `argument-${randomUUID()}`;
    const named = await cli.run([
      "--json",
      "plugins",
      "settings",
      name,
      "--set",
      `token=${secret}`,
    ]);
    expect(named.code).toBe(2);
    const envelope = JSON.parse(named.stderr.trim().split("\n").at(-1)!) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("usage");
    expect(envelope.error.message).toContain("marfa plugins secret");
    expect(named.stdout + named.stderr).not.toContain(secret);
    expect((await settingOf(name, "token")).set).toBe(false);
  });

  it("sets a secret from standard input without printing it, clears it with --clear, and refuses one given as an argument", async () => {
    const name = await installed();
    const secret = `stdin-${randomUUID()}`;
    const argued = await cli.run([
      "--json",
      "plugins",
      "secret",
      name,
      "token",
      secret,
    ]);
    expect(argued.code).toBe(2);
    expect(argued.stdout + argued.stderr).not.toContain(secret);
    expect((await settingOf(name, "token")).set).toBe(false);

    const set = await cli.run(["plugins", "secret", name, "token"], {
      stdin: `${secret}\n`,
    });
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout + set.stderr).not.toContain(secret);
    expect(await settingOf(name, "token")).toMatchObject({
      value: null,
      set: true,
    });
    const listed = await cli.run(["--json", "plugins", "settings", name]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout + listed.stderr).not.toContain(secret);

    // The connector reads the value as typed, without the line ending.
    const host = await linkedHost(server, owner, `cli ${fresh()}`);
    expect((await owner.assignConnector(name, host.id)).status).toBe(200);
    const connector = await connectorKey(server, host, name);
    const registered = await connector.client.registerConnector({ name });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const own = await connector.client.readOwnConnectorSettings(
      registered.data.id,
    );
    expect(own.status, JSON.stringify(own.error)).toBe(200);
    expect(
      (own.data.settings as Entry[]).find((held) => held.name === "token")
        ?.value,
    ).toBe(secret);

    const cleared = await cli.run(
      ["plugins", "secret", name, "token", "--clear"],
      {
        stdin: "never read\n",
      },
    );
    expect(cleared.code, cleared.stderr).toBe(0);
    expect((await settingOf(name, "token")).set).toBe(false);
  });
});
