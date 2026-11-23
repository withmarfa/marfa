import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * `marfa items link` prints the address the server gives an item, or hands it
 * to the system's opener.
 *
 * The real server answers every item with both links, so a server that
 * answers one without them, or from an address other than the API's, is a
 * listener of this file's own.
 */

const UNKNOWN_ID = "01a1ff7f-a1a5-7568-9989-53778f0e85d9";

let c: CliContext;
let dir: string;
let contract: string;
const servers: Server[] = [];

beforeAll(async () => {
  c = await cliContext("item-link");
  dir = tempFolder("marfa-cli-item-link-");
  const current = await fetch(`${c.apiUrl}/keys/current`, {
    headers: { authorization: `Bearer ${c.apiKey}` },
  });
  contract = current.headers.get("x-marfa-contract") ?? "";
  expect(contract).not.toBe("");
});

afterAll(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await cleanup(c.ctx);
});

async function note(): Promise<string> {
  const created = await c.cli.json<ItemEnvelope>([
    "items",
    "create",
    "--type",
    "core.note",
    "--prop",
    `title=${unique("cli-link")}`,
  ]);
  trackItem(c.ctx, created.item.id);
  return created.item.id;
}

/** A server that answers every request with `item`, and the paths it was asked. */
async function serving(
  item: Record<string, unknown>,
): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    request.resume();
    response.writeHead(200, {
      "content-type": "application/json",
      "x-marfa-contract": contract,
    });
    response.end(JSON.stringify({ item }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    paths,
  };
}

/** A folder on `PATH` holding an opener that writes what it was given to a file. */
function opener(name: string, status: number): { path: string; seen: string } {
  const folder = join(dir, name);
  mkdirSync(folder);
  const seen = join(folder, "seen");
  for (const program of ["open", "xdg-open"]) {
    const file = join(folder, program);
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s' "$1" > '${seen}'\nexit ${String(status)}\n`,
    );
    chmodSync(file, 0o700);
  }
  return { path: folder, seen };
}

describe("an item's link from the terminal", () => {
  it("prints the web_url of an item alone on one line, from the sign-in address and not the API address", async () => {
    const id = await note();
    const read = await c.cli.json<{ item: { web_url: string } }>([
      "items",
      "get",
      id,
    ]);
    const printed = await c.cli.run(["items", "link", id]);
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toBe(`${read.item.web_url}\n`);
    expect(printed.stdout.endsWith(`/i/${id}\n`)).toBe(true);
    expect(printed.stderr).toBe("");

    const elsewhere = await serving({
      id,
      state: "active",
      web_url: `https://marfa.example/i/${id}`,
      app_url: `marfa://instance/${id}`,
    });
    const given = await c.cli.at(elsewhere.url).run(["items", "link", id]);
    expect(given.code, given.stderr).toBe(0);
    expect(given.stdout).toBe(`https://marfa.example/i/${id}\n`);
  });

  it("prints the app_url with --app", async () => {
    const id = await note();
    const read = await c.cli.json<{ item: { app_url: string } }>([
      "items",
      "get",
      id,
    ]);
    const printed = await c.cli.run(["items", "link", id, "--app"]);
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toBe(`${read.item.app_url}\n`);
    expect(printed.stdout.startsWith("marfa://")).toBe(true);
  });

  it("prints both links as one JSON object under --json", async () => {
    const id = await note();
    const read = await c.cli.json<{
      item: { web_url: string; app_url: string };
    }>(["items", "get", id]);
    const printed = await c.cli.json(["items", "link", id]);
    expect(printed).toEqual({
      web_url: read.item.web_url,
      app_url: read.item.app_url,
    });
  });

  it("prints the link of an item in the bin and says on standard error that it is in Recently Deleted", async () => {
    const id = await note();
    const active = await c.cli.run(["items", "link", id]);
    expect(active.stderr).not.toContain("Recently Deleted");
    await c.cli.json(["items", "trash", id]);
    const printed = await c.cli.run(["items", "link", id]);
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toBe(active.stdout);
    expect(printed.stderr).toContain("Recently Deleted");
  });

  it("refuses an id that is not a lowercase UUIDv7 before it sends a request", async () => {
    const listener = await serving({});
    for (const bad of ["x", UNKNOWN_ID.toUpperCase(), "../items"]) {
      const refused = await c.cli
        .at(listener.url)
        .refused(["items", "link", bad]);
      expect(refused.code).toBe(1);
      expect(refused.envelope.error.code).toBe("invalid");
    }
    expect(listener.paths).toEqual([]);

    // The witness: a well-formed id the same listener is asked for is sent.
    await c.cli.at(listener.url).run(["items", "link", UNKNOWN_ID]);
    expect(listener.paths).toHaveLength(1);
  });

  it("says what items get says of an id no item holds", async () => {
    const refused = await c.cli.refused(["items", "link", UNKNOWN_ID]);
    const got = await c.cli.refused(["items", "get", UNKNOWN_ID]);
    expect(refused.code).toBe(got.code);
    expect(refused.envelope.error.server?.code).toBe("item_not_found");
    expect(refused.envelope.error.server?.status).toBe(
      got.envelope.error.server?.status,
    );
  });

  it("says a server that answers an item with no link needs a newer release, and prints nothing", async () => {
    const id = await note();
    const old = await serving({ id, state: "active", type: "core.note" });
    for (const args of [[], ["--app"]]) {
      const outcome = await c.cli
        .at(old.url)
        .run(["items", "link", id, ...args]);
      expect(outcome.code).toBe(1);
      expect(outcome.stdout).toBe("");
      expect(outcome.stderr).toContain("newer release");
    }
    expect(old.paths).toHaveLength(2);
  });

  it("hands the web_url, or the app_url with --app, to the system's opener and prints nothing", async () => {
    const id = await note();
    const read = await c.cli.json<{
      item: { web_url: string; app_url: string };
    }>(["items", "get", id]);
    const web = opener("opens-web", 0);
    const opened = await c.cli
      .withEnv({ PATH: web.path })
      .run(["items", "link", id, "--open"]);
    expect(opened.code, opened.stderr).toBe(0);
    expect(opened.stdout).toBe("");
    expect(readFileSync(web.seen, "utf8")).toBe(read.item.web_url);

    const app = opener("opens-app", 0);
    const openedApp = await c.cli
      .withEnv({ PATH: app.path })
      .run(["items", "link", id, "--app", "--open"]);
    expect(openedApp.code, openedApp.stderr).toBe(0);
    expect(openedApp.stdout).toBe("");
    expect(readFileSync(app.seen, "utf8")).toBe(read.item.app_url);
  });

  it("prints the link and exits non-zero where no opener takes it", async () => {
    const id = await note();
    const printed = await c.cli.run(["items", "link", id]);
    const refusing = opener("opener-refuses", 1);
    const absent = join(dir, "no-opener");
    mkdirSync(absent);
    for (const path of [refusing.path, absent]) {
      const outcome = await c.cli
        .withEnv({ PATH: path })
        .run(["items", "link", id, "--open"]);
      expect(outcome.code).not.toBe(0);
      expect(outcome.stdout).toBe(printed.stdout);
      expect(outcome.stderr).toContain("could not open");
    }
    expect(readFileSync(refusing.seen, "utf8")).toBe(printed.stdout.trim());
  });
});
