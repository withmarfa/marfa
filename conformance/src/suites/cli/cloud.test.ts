import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import { fakeCloud, type FakeCloud } from "../../utils/fake-cloud.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { signIn } from "../../utils/signed-in.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { waitFor } from "../../utils/wait.js";
import { Cli, once, releaseHeld, requireBinary } from "./harness.js";

/**
 * Linking the instance to Marfa Cloud from the terminal (`cloud link`,
 * `cloud status` and `cloud unlink`), against a fake of Marfa Cloud's link
 * API on loopback.
 *
 * **On a server of each test's own.** An instance holds one link, and a link
 * can move the sign-in address and end the sessions of the server it is on, so
 * every test boots a server and a fake Cloud of its own.
 *
 * The browser the binary opens is a program on the `PATH` that writes the
 * page it was given to a file, so a test sees whether a page was opened and
 * which, and no browser starts.
 */

/** What `cloud link` says first about the service. */
const ALPHA_NOTICE =
  "Marfa Cloud is in alpha: it may change, and may sometimes be unavailable. Your data stays on this machine.";

const clouds: FakeCloud[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  releaseHeld();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(clouds.splice(0).map((cloud) => cloud.close()));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

/** A server and its Cloud, the binary under a key, and the binary on the private socket. */
interface Rig {
  server: FreshServer;
  cloud: FakeCloud;
  key: Cli;
  local: Cli;
  /** The pages the binary opened, in order. */
  opened(): string[];
  /** The link as the server reads it. */
  status(): Promise<any>;
  /** Starts a link directly, as an app would, answering the link. */
  start(body: unknown): Promise<any>;
  /** The sign-in address the server holds now. */
  address(): Promise<string | undefined>;
  /** Waits until the link reads as `wanted` says. */
  until(what: string, wanted: (status: any) => boolean): Promise<any>;
  /** Signs the owner in, so a session exists for a move to end. */
  signIn(): Promise<string>;
}

async function rig(
  label: string,
  settings: Record<string, string> = {},
): Promise<Rig> {
  const cloud = await fakeCloud();
  clouds.push(cloud);
  const server = await bootFreshServer(label, {
    MARFA_CLOUD_URL: cloud.url,
    ...settings,
  });
  cleanups.push(() => server.stop());

  const bin = tempFolder("cl-open-");
  const marker = join(bin, "opened");
  for (const opener of ["open", "xdg-open"]) {
    const path = join(bin, opener);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${marker}'\n`);
    chmodSync(path, 0o755);
  }
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
  const binary = requireBinary();
  const key = new Cli(binary, server.apiUrl, server.managementKey).withEnv(env);
  const local = new Cli(
    binary,
    server.apiUrl,
    undefined,
    server.controlSocket,
  ).withEnv(env);

  const read = async () => {
    const answer = await fetch(`${server.apiUrl}/cloud/link`, {
      headers: { Authorization: `Bearer ${server.managementKey}` },
    });
    expect(answer.status).toBe(200);
    return answer.json();
  };
  return {
    server,
    cloud,
    key,
    local,
    opened: () =>
      existsSync(marker)
        ? readFileSync(marker, "utf8").split("\n").filter(Boolean)
        : [],
    status: read,
    start: async (body) => {
      const answer = await fetch(`${server.apiUrl}/cloud/link`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server.managementKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(answer.status).toBe(201);
      return answer.json();
    },
    address: async () => {
      const answer = await controlRequest(server.controlSocket, "/config");
      expect(answer.status).toBe(200);
      return answer.body.sign_in_address as string | undefined;
    },
    until: (what, wanted) =>
      waitFor(
        what,
        async () => {
          const link = await read();
          return wanted(link) ? link : undefined;
        },
        30_000,
        200,
      ),
    signIn: () => signIn(server, new URL(server.apiUrl).origin),
  };
}

/** A long-running `marfa` and what it has printed. */
class Held {
  stdout = "";
  stderr = "";
  readonly closed: Promise<number | null>;

  constructor(readonly child: ChildProcess) {
    child.stdout!.on("data", (chunk: Buffer) => {
      this.stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.closed = once(child, "close");
  }

  /** The `index`th JSON line printed, once its line is whole. */
  record(index: number): Promise<any> {
    return waitFor(
      `record ${String(index)} of the command`,
      async () => {
        const lines = this.stdout.split("\n").slice(0, -1);
        const line = lines[index];
        return line === undefined ? undefined : JSON.parse(line);
      },
      30_000,
    );
  }

  /** Waits until what the command printed holds `text`. */
  says(text: string): Promise<true> {
    return waitFor(
      `the command to say ${text}`,
      async () =>
        this.stdout.includes(text) || this.stderr.includes(text)
          ? true
          : undefined,
      30_000,
    );
  }
}

/** Runs `cloud link` under `cli`, printing JSON unless `json` is false. */
function link(cli: Cli, args: string[] = [], json = true): Held {
  return new Held(cli.hold(["cloud", "link", ...args], { json }));
}

/** The last line of standard error, which a refusal's envelope is. */
function envelope(held: Held): any {
  return JSON.parse(held.stderr.trim().split("\n").at(-1)!);
}

async function opens(server: FreshServer, cookie: string): Promise<number> {
  const answer = await fetch(`${server.apiUrl}/owner/passkeys`, {
    headers: { cookie },
  });
  await answer.body?.cancel();
  return answer.status;
}

describe("cloud status", () => {
  it(
    "reads the link in every state, prints it plainly naming the service as alpha, and under --json prints the server's answer unchanged",
    async () => {
      const r = await rig("cli-cloud-status");
      expect(await r.key.json(["cloud", "status"])).toEqual({
        state: "not_linked",
      });
      const none = await r.key.run(["cloud", "status"]);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain("Not linked to Marfa Cloud (alpha).");

      const started = await r.start({ sign_in_address: "keep" });
      expect(await r.key.json(["cloud", "status"])).toEqual(await r.status());
      const waiting = await r.key.run(["cloud", "status"]);
      expect(waiting.code).toBe(0);
      expect(waiting.stdout).toContain("Marfa Cloud (alpha)");
      expect(waiting.stdout).toContain(started.linking.user_code);
      expect(waiting.stdout).toContain(started.linking.approval_url);

      r.cloud.approve();
      const made = await r.until("the link", (s) => s.state === "linked");
      expect(await r.key.json(["cloud", "status"])).toEqual(made);
      const linked = await r.key.run(["cloud", "status"]);
      expect(linked.code).toBe(0);
      expect(linked.stdout).toContain(
        `Linked to Marfa Cloud (alpha) as ${String(made.name)}.`,
      );
      expect(linked.stdout).toContain(made.address);

      await r.key.run(["cloud", "unlink"]);
      await r.start({ sign_in_address: "keep" });
      r.cloud.deny();
      const failed = await r.until("the denial", (s) => s.state === "failed");
      expect(await r.key.json(["cloud", "status"])).toEqual(failed);
      const refused = await r.key.run(["cloud", "status"]);
      expect(refused.code).toBe(0);
      expect(refused.stdout).toContain(
        "The link to Marfa Cloud (alpha) failed",
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "says why the connector cannot run, and what to do while another program holds the tunnel's port",
    async () => {
      const r = await rig("cli-cloud-status-connector", {
        MARFA_CLOUDFLARED: join(tempFolder("cl-none-"), "cloudflared"),
      });
      const started = await r.start({ sign_in_address: "keep" });
      const free = await r.key.run(["cloud", "status"]);
      expect(free.stdout).toContain(started.linking.user_code);
      expect(free.stdout).not.toContain("Another program holds the port");

      const port = r.cloud.latest().originPort;
      const other = createServer((_, response) => response.end("other"));
      await r.server.restart(async () => {
        await new Promise<void>((resolve, reject) => {
          other.once("error", reject);
          other.listen(port, "127.0.0.1", resolve);
        });
      });
      // The server comes back at another address.
      const key = r.key.at(r.server.apiUrl);
      try {
        await r.until(
          "the port to read as taken",
          (s) => s.state === "linking" && s.linking.port_taken === true,
        );
        const linking = await key.run(["cloud", "status"]);
        expect(linking.code, linking.stderr).toBe(0);
        expect(linking.stdout).toContain(
          "Another program holds the port on 127.0.0.1 that Marfa Cloud reaches this instance at. Free that port, or run `marfa cloud unlink` and link again for another port.",
        );

        r.cloud.approve();
        await r.until(
          "the connector to fail for the taken port",
          (s) =>
            s.state === "linked" &&
            s.connector.state === "failed" &&
            s.connector.reason === "port_taken",
        );
        const taken = await key.run(["cloud", "status"]);
        expect(taken.code, taken.stderr).toBe(0);
        expect(taken.stdout).toMatch(
          /Connector: failed since \S+: another program holds the port on 127\.0\.0\.1 that Marfa Cloud reaches this instance at\. Free that port, or run `marfa cloud unlink` and link again for another port\./,
        );
      } finally {
        await new Promise((resolve) => other.close(resolve));
      }

      await r.until(
        "the connector to fail for want of a program",
        (s) =>
          s.state === "linked" &&
          s.connector.state === "failed" &&
          s.connector.reason === "missing",
      );
      const missing = await key.run(["cloud", "status"]);
      expect(missing.stdout).toMatch(
        /Connector: failed since \S+: no connector program can be run/,
      );
      expect(missing.stdout).not.toContain("Free that port");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("cloud link", () => {
  it(
    "starts a link to move the sign-in address, prints the code and the page, opens nothing, waits through the server's reads until it is approved, and leaves the move waiting with the command that makes it",
    async () => {
      const r = await rig("cli-cloud-key");
      const run = link(r.key);
      const pending = await run.record(0);
      const started = r.cloud.latest();
      expect(pending).toMatchObject({
        state: "linking",
        linking: {
          user_code: started.userCode,
          approval_url: started.approvalUrl,
        },
        sign_in_address: { state: "waiting" },
      });
      // Several reads of the link go by with the command still waiting.
      await r.cloud.waitFor("/link/poll", 3);
      expect(run.child.exitCode).toBeNull();

      r.cloud.approve();
      const made = await run.record(1);
      expect(await run.closed).toBe(0);
      expect(made).toMatchObject({
        state: "linked",
        name: started.name,
        sign_in_address: {
          state: "waiting",
          next_step: {
            command: `marfa config set sign_in_address ${String(made.address)} --confirm-address-change`,
          },
        },
      });
      expect(run.stdout.split("\n").filter(Boolean)).toHaveLength(2);
      // A key's page is printed and never opened; the socket's is opened below.
      expect(r.opened()).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the sign-in address with --keep-sign-in-address, says plainly what to approve and check, and ends once the link is made",
    async () => {
      const r = await rig("cli-cloud-keep");
      const run = link(r.key, ["--keep-sign-in-address"], false);
      const started = await waitFor("the link to start", async () =>
        r.cloud.links.at(-1),
      );
      await run.says(started.userCode);
      expect(run.stdout).toContain(ALPHA_NOTICE);
      expect(run.stdout.indexOf(ALPHA_NOTICE)).toBeLessThan(
        run.stdout.indexOf(started.userCode),
      );
      expect(run.stdout).toContain(started.approvalUrl);
      expect(run.stdout).toMatch(/code on that page must read/i);
      expect(run.stdout).toMatch(/only if the code matches/i);
      expect((await r.status()).sign_in_address.state).toBe("kept");

      r.cloud.approve();
      expect(await run.closed).toBe(0);
      expect(run.stdout).toContain("Linked to Marfa Cloud (alpha) as");
      expect(run.stdout).toContain("kept as");
      expect((await r.status()).sign_in_address.state).toBe("kept");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "under --json prints the code, the page and what to check on standard error, and leaves standard output the server's answer",
    async () => {
      const r = await rig("cli-cloud-json-says");
      const run = link(r.key, ["--keep-sign-in-address"]);
      const pending = await run.record(0);
      await run.says("Waiting for approval");
      expect(run.stderr).toContain(pending.linking.user_code);
      expect(run.stderr).toContain(pending.linking.approval_url);
      expect(run.stderr).toMatch(/only if the code matches/i);
      expect(run.stderr).toMatch(/code on that page must read/i);
      expect(run.stderr).toContain(ALPHA_NOTICE);
      expect(run.stderr.indexOf(ALPHA_NOTICE)).toBeLessThan(
        run.stderr.indexOf(pending.linking.user_code),
      );

      r.cloud.approve();
      expect(await run.closed).toBe(0);
      const lines = run.stdout.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual(pending);
      expect(JSON.parse(lines[1]!)).toEqual(await r.status());
      expect(run.stdout).not.toMatch(/only if the code matches/i);
      expect(run.stdout).not.toMatch(/alpha/i);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "opens the approval page and moves the sign-in address when it reaches the server through the private socket, as the confirmation allowed",
    async () => {
      const r = await rig("cli-cloud-socket");
      const before = await r.address();
      const cookie = await r.signIn();
      // The witness: the session opens until the move.
      expect(await opens(r.server, cookie)).toBe(200);

      const run = link(r.local, ["--confirm-address-change"]);
      const pending = await run.record(0);
      expect(pending.sign_in_address.state).toBe("pending");
      const started = r.cloud.latest();
      await waitFor("the page to be opened", async () =>
        r.opened().length > 0 ? true : undefined,
      );
      expect(r.opened()).toEqual([started.approvalUrl]);

      r.cloud.approve();
      const made = await run.record(1);
      expect(await run.closed).toBe(0);
      expect(made.state).toBe("linked");
      expect(made.sign_in_address).toMatchObject({
        state: "moved",
        address: made.address,
      });
      expect(await r.address()).toBe(made.address);
      expect(made.address).not.toBe(before);
      expect(await opens(r.server, cookie)).toBe(401);
      expect(r.opened()).toEqual([started.approvalUrl]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "exits 1 with cloud_link_failed naming why when the link is refused on the approval page or expires",
    async () => {
      const r = await rig("cli-cloud-failed");
      const denied = link(r.key);
      await denied.record(0);
      r.cloud.deny();
      expect(await denied.closed).toBe(1);
      expect(envelope(denied)).toMatchObject({
        error: {
          code: "cloud_link_failed",
          message: expect.stringContaining("refused on the approval page"),
        },
        exit: 1,
      });
      expect(await denied.record(1)).toMatchObject({
        state: "failed",
        failure: { reason: "denied" },
      });

      // A failed link does not hold the next one back.
      const expired = link(r.key);
      await expired.record(0);
      expect(r.cloud.links).toHaveLength(2);
      r.cloud.expire();
      expect(await expired.closed).toBe(1);
      expect(envelope(expired).error).toMatchObject({
        code: "cloud_link_failed",
        message: expect.stringContaining("expired"),
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "leaves a link pending when Ctrl-C ends it with 130, waits on the pending link when run again, starts no other, and refuses a link that is already made",
    async () => {
      const r = await rig("cli-cloud-resume");
      const first = link(r.key);
      const pending = await first.record(0);
      // Ctrl-C is taken once the command says it waits.
      await first.says("Waiting for approval");
      first.child.kill("SIGINT");
      expect(await first.closed).toBe(130);
      expect(first.stderr).toContain("stays pending");
      expect(first.stderr).toContain("marfa cloud link");
      expect((await r.status()).state).toBe("linking");
      expect(r.cloud.links).toHaveLength(1);

      const second = link(r.key);
      const resumed = await second.record(0);
      expect(resumed.linking.user_code).toBe(pending.linking.user_code);
      expect(r.cloud.links).toHaveLength(1);
      r.cloud.approve();
      expect(await second.closed).toBe(0);
      expect((await second.record(1)).state).toBe("linked");

      const again = await r.key.refused(["cloud", "link"]);
      expect(again.code).toBe(1);
      expect(again.envelope.error.code).toBe("invalid");
      expect(again.envelope.error.message).toContain("already linked");
      expect(r.cloud.links).toHaveLength(1);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a move that needs confirming when it has no terminal, names the consequences and the flags, and starts nothing",
    async () => {
      const r = await rig("cli-cloud-unconfirmed");
      await r.signIn();
      const refused = await r.local.refused(["cloud", "link"]);
      expect(refused.code).toBe(1);
      expect(refused.envelope.error.server?.code).toBe(
        "sign_in_address_change_unconfirmed",
      );
      const details = refused.envelope.error.server?.details as {
        consequences: { code: string; sentence: string }[];
      };
      expect(details.consequences.length).toBeGreaterThan(0);

      const plain = await r.local.run(["cloud", "link"]);
      expect(plain.code).toBe(1);
      expect(plain.stderr).toContain(details.consequences[0]!.sentence);
      expect(plain.stderr).toContain("--confirm-address-change");
      expect(plain.stderr).toContain("--keep-sign-in-address");
      expect(r.cloud.requests).toEqual([]);
      expect((await r.status()).state).toBe("not_linked");

      // The witness: the same instance links once told to keep the address.
      const kept = link(r.local, ["--keep-sign-in-address"]);
      expect((await kept.record(0)).state).toBe("linking");
      r.cloud.approve();
      expect(await kept.closed).toBe(0);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "asks at a terminal before moving the sign-in address, and starts nothing on a no",
    async () => {
      const r = await rig("cli-cloud-asks");
      await r.signIn();
      const refused = await controlRequest(
        r.server.controlSocket,
        "/cloud/link",
        { method: "POST", body: { sign_in_address: "move" } },
      );
      expect(refused.status).toBe(409);
      const held = refused.body as {
        error: { details: { consequences: { sentence: string }[] } };
      };
      const sentence = held.error.details.consequences[0]!.sentence;

      const no = await r.local.runAtTerminal(["cloud", "link"], "n");
      expect(no.code).toBe(1);
      expect(no.stdout).toContain(sentence);
      expect(no.stdout).toContain("[y/N]");
      expect(no.stdout).toContain("--keep-sign-in-address");
      expect(r.cloud.requests).toEqual([]);
      expect((await r.status()).state).toBe("not_linked");

      // The witness: a yes at the same question starts the link and moves the address.
      const yes = r.local.runAtTerminal(["cloud", "link"], "y");
      await r.cloud.waitFor("/link/start");
      r.cloud.approve();
      const answered = await yes;
      expect(answered.code, answered.stdout).toBe(0);
      expect(answered.stdout).toContain("Linked to Marfa Cloud (alpha) as");
      expect((await r.status()).sign_in_address.state).toBe("moved");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("cloud unlink", () => {
  it(
    "unlinks, says whether Marfa Cloud was told, cancels a link waiting for approval and answers when nothing is linked",
    async () => {
      const r = await rig("cli-cloud-unlink");
      const nothing = await r.key.run(["cloud", "unlink"]);
      expect(nothing.code).toBe(0);
      expect(nothing.stdout).toContain("Nothing was linked.");
      expect(r.cloud.requests).toEqual([]);

      const keeping = async () => {
        const run = link(r.key, ["--keep-sign-in-address"]);
        await run.record(0);
        r.cloud.approve();
        expect(await run.closed).toBe(0);
      };
      await keeping();
      expect(await r.key.json(["cloud", "unlink"])).toEqual({
        state: "not_linked",
        service_told: true,
      });
      expect(r.cloud.latest().unlinked).toBe(true);
      expect((await r.status()).state).toBe("not_linked");

      await keeping();
      r.cloud.down();
      const untold = await r.key.run(["cloud", "unlink"]);
      expect(untold.code).toBe(0);
      expect(untold.stdout).toContain("Unlinked from Marfa Cloud");
      expect(untold.stdout).toContain("could not be told");
      expect((await r.status()).state).toBe("not_linked");
      r.cloud.up();

      await r.start({ sign_in_address: "keep" });
      const cancelled = await r.key.run(["cloud", "unlink"]);
      expect(cancelled.code).toBe(0);
      expect(cancelled.stdout).toContain(
        "Cancelled the link that was waiting for approval.",
      );
      expect((await r.status()).state).toBe("not_linked");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "puts back the sign-in address only on confirmation, asks at a terminal, and refuses a key",
    async () => {
      const r = await rig("cli-cloud-put-back");
      const before = await r.address();
      await r.signIn();
      const run = link(r.local, ["--confirm-address-change"]);
      await run.record(0);
      r.cloud.approve();
      const made = await run.record(1);
      expect(await run.closed).toBe(0);
      expect(made.sign_in_address.state).toBe("moved");

      // A key cannot put the address back, and nothing changes.
      const byKey = await r.key.refused([
        "cloud",
        "unlink",
        "--confirm-address-change",
      ]);
      expect(byKey.code).toBe(1);
      expect(byKey.envelope.error.server?.code).toBe("app_sign_in_required");

      const held = await r.local.refused(["cloud", "unlink"]);
      expect(held.code).toBe(1);
      expect(held.envelope.error.server?.code).toBe(
        "sign_in_address_change_unconfirmed",
      );
      const plain = await r.local.run(["cloud", "unlink"]);
      expect(plain.code).toBe(1);
      expect(plain.stderr).toContain("--confirm-address-change");

      const no = await r.local.runAtTerminal(["cloud", "unlink"], "n");
      expect(no.code).toBe(1);
      expect(no.stdout).toContain("[y/N]");
      expect((await r.status()).state).toBe("linked");
      expect(await r.address()).toBe(made.address);
      expect(r.cloud.latest().unlinked).toBe(false);

      const put = await r.local.run([
        "cloud",
        "unlink",
        "--confirm-address-change",
      ]);
      expect(put.code, put.stderr).toBe(0);
      expect(put.stdout).toContain("sign-in address is put back");
      expect(await r.address()).toBe(before);
      expect(r.cloud.latest().unlinked).toBe(true);
      expect((await r.status()).state).toBe("not_linked");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
