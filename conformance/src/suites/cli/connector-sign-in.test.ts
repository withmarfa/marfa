import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  arriveAt,
  granted,
  runProvider,
  type Provider,
} from "../../utils/oauth-provider.js";
import {
  connectorBundle,
  connectorSection,
  fresh,
} from "../../utils/plugin-connector.js";
import { Cli, releaseHeld, requireBinary } from "./harness.js";

/**
 * An owner signs a plugin's connector in from the terminal: the command
 * prints the address to open in a browser, and with `--wait` stays until the
 * browser finishes the sign-in or it ends. A `sign-in-provider` fault points
 * the provider at one this file runs. The server is this file's own, since
 * plugins are the instance's.
 */

let server: FreshServer;
let provider: Provider;
let cli: Cli;
let owner: MarfaClient;

const TEN_MINUTES_MS = 10 * 60 * 1000;

beforeAll(async () => {
  [server, provider] = await Promise.all([
    bootFreshServer("cli-connector-sign-in"),
    runProvider(),
  ]);
  await server.setFault(`sign-in-provider=${provider.origin}`);
  const local = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
  const made = await local.createKey({
    label: "cli connector sign-in",
    source: `cli-connector-sign-in-owner-${fresh()}`,
    permissions: ["schema.write", "connectors.manage"],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  cli = new Cli(requireBinary(), server.apiUrl, made.data.key!);
  owner = new MarfaClient({ baseUrl: server.apiUrl, apiKey: made.data.key! });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  releaseHeld();
  await Promise.all([server?.stop(), provider?.close()]);
}, FRESH_SERVER_TIMEOUT_MS);

async function ready(): Promise<string> {
  const name = `cli-sign-in-${fresh()}`;
  const root = name.replaceAll("-", "");
  const bundle = connectorBundle(name, root, name, {
    connector: connectorSection(`${root}.entry`, name, {
      settings: [
        { name: "client_id", label: "ID", kind: "text", required: true },
        {
          name: "client_secret",
          label: "Secret",
          kind: "text",
          secret: true,
          required: true,
        },
        {
          name: "token",
          label: "Token",
          kind: "text",
          secret: true,
          required: false,
        },
      ],
      sign_in: {
        kind: "oauth2",
        provider: "google",
        scopes: ["openid"],
        client_id_setting: "client_id",
        client_secret_setting: "client_secret",
        token_setting: "token",
      },
    }),
  });
  const made = await owner.installPlugin(bundle);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const set = await owner.setConnectorSettings(name, {
    client_id: "an-id.apps.googleusercontent.com",
    client_secret: "a-secret",
  });
  expect(set.status, JSON.stringify(set.error)).toBe(200);
  return name;
}

type Held = {
  first: Promise<Record<string, unknown>>;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
};

/** Follows a held command: its first line of output, and how it ended. */
function follow(child: ChildProcess): Held {
  let stdout = "";
  let stderr = "";
  let sawFirst: (line: Record<string, unknown>) => void = () => {};
  const first = new Promise<Record<string, unknown>>((done) => {
    sawFirst = done;
  });
  child.stdout!.on("data", (part: Buffer) => {
    stdout += part.toString("utf8");
    const line = stdout.split("\n")[0];
    if (stdout.includes("\n") && line) {
      sawFirst(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.stderr!.on("data", (part: Buffer) => (stderr += part.toString("utf8")));
  const done = new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) =>
      child.on("close", (code) =>
        resolve({ code: code ?? -1, stdout, stderr }),
      ),
  );
  return { first, done };
}

describe("a connector's sign-in from the terminal", () => {
  it("prints the address to open, and with --wait exits 0 once the owner's browser finishes the sign-in", async () => {
    const name = await ready();
    const printed = await cli.run([
      "plugins",
      "sign-in",
      name,
      "--return-to",
      "/done",
    ]);
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toContain("Open this address in a browser");
    const shown = /https?:\/\/\S+/.exec(printed.stdout)?.[0] ?? "";
    expect(new URL(shown).searchParams.get("state")).toBeTruthy();
    expect(shown.startsWith(`${provider.origin}/authorize?`)).toBe(true);

    provider.answer = granted;
    const held = follow(cli.hold(["plugins", "sign-in", name, "--wait"]));
    const start = await held.first;
    const url = new URL(start.url as string);
    // The earlier start is replaced, so only this state finishes.
    const back = await arriveAt(server.apiUrl, {
      state: new URL(shown).searchParams.get("state")!,
      code: "c",
    });
    expect(back.status).toBe(400);
    const finished = await arriveAt(server.apiUrl, {
      state: url.searchParams.get("state")!,
      code: "c",
    });
    expect(finished.status).toBe(200);
    const ended = await held.done;
    expect(ended.code, ended.stderr).toBe(0);
    const last = JSON.parse(ended.stdout.trim().split("\n").at(-1)!) as {
      status: string;
    };
    expect(last.status).toBe("signed_in");
  });

  it("exits 1 with sign_in_ended when the sign-in it waits on expires", async () => {
    const name = await ready();
    const held = follow(cli.hold(["plugins", "sign-in", name, "--wait"]));
    await held.first;
    await server.advanceClock(TEN_MINUTES_MS + 1000);
    const ended = await held.done;
    expect(ended.code, ended.stdout).toBe(1);
    const envelope = JSON.parse(ended.stderr.trim().split("\n").at(-1)!) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe("sign_in_ended");
    expect((await owner.getConnectorSignIn(name)).data.status).toBe("expired");
  });

  it("exits 1 with sign_in_ended, naming its sign-in replaced, when a later start replaces the one it waits on", async () => {
    const name = await ready();
    provider.answer = granted;
    const held = follow(cli.hold(["plugins", "sign-in", name, "--wait"]));
    await held.first;
    const later = await owner.startConnectorSignIn(name);
    expect(later.status, JSON.stringify(later.error)).toBe(201);
    // The later sign-in finishes, which is not the one the command waits on.
    const finished = await arriveAt(server.apiUrl, {
      state: new URL(later.data.url as string).searchParams.get("state")!,
      code: "c",
    });
    expect(finished.status).toBe(200);
    expect((await owner.getConnectorSignIn(name)).data.status).toBe(
      "signed_in",
    );
    const ended = await held.done;
    expect(ended.code, ended.stdout).toBe(1);
    const envelope = JSON.parse(ended.stderr.trim().split("\n").at(-1)!) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("sign_in_ended");
    expect(envelope.error.message).toMatch(/replaced/);
  });
});
