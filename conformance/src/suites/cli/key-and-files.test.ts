import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cleanup,
  getOwnerClient,
  trackItem,
  trackKey,
  trackType,
  trackView,
} from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

let c: CliContext;
let dir: string;
let contract: string;
const servers: Server[] = [];

beforeAll(async () => {
  c = await cliContext("key-and-files");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-key-and-files-"));
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
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

interface Arrival {
  method: string;
  url: string;
  authorization: string | undefined;
  cookie: string | undefined;
  marfa: string[];
}

type Answer = (
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
) => void;

/** Records every request and CONNECT, and answers each as `answer` says. */
async function listen(
  bind: string,
  answer: Answer,
): Promise<{ arrivals: Arrival[]; port: number }> {
  const arrivals: Arrival[] = [];
  const server = createServer((request, response) => {
    arrivals.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      marfa: Object.keys(request.headers).filter((name) =>
        name.startsWith("x-marfa-"),
      ),
    });
    request.resume();
    answer(request, response);
  });
  server.on("connect", (request, socket) => {
    arrivals.push({
      method: "CONNECT",
      url: request.url ?? "",
      authorization: undefined,
      cookie: undefined,
      marfa: [],
    });
    socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, bind, resolve));
  return { arrivals, port: (server.address() as AddressInfo).port };
}

const unavailable: Answer = (_request, response) => {
  response.writeHead(503, { "content-type": "application/json" });
  response.end("{}");
};

function otherHost(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error(
    "this machine has no network address but loopback, so no address can stand for another host",
  );
}

describe("a request to a server on this machine", () => {
  it("never goes through a proxy the environment names, and one to another host does", async () => {
    const proxy = await listen("127.0.0.1", unavailable);
    const through = `http://127.0.0.1:${String(proxy.port)}`;
    const named = c.cli.withEnv({
      HTTP_PROXY: through,
      http_proxy: through,
      HTTPS_PROXY: through,
      ALL_PROXY: through,
      all_proxy: through,
    });

    const { port } = new URL(c.apiUrl);
    for (const host of ["127.0.0.1", "localhost"]) {
      const answered = await named
        .at(`http://${host}:${port}`)
        .json<{ id: string }>(["whoami"]);
      expect(answered, host).toBeTruthy();
    }
    expect(proxy.arrivals).toEqual([]);

    const elsewhere = await listen("0.0.0.0", unavailable);
    const outcome = await named
      .at(`http://${otherHost()}:${String(elsewhere.port)}`)
      .run(["--json", "whoami"]);
    expect(outcome.code).not.toBe(0);
    expect(proxy.arrivals.length).toBeGreaterThan(0);
    expect(elsewhere.arrivals).toEqual([]);
  });
});

describe("a key from MARFA_API_KEY", () => {
  it("goes only to the server MARFA_API_URL names, and a --url for another server refuses", async () => {
    const other = await listen("127.0.0.1", unavailable);
    const otherUrl = `http://127.0.0.1:${String(other.port)}`;

    const refused = await c.cli.refused(["--url", otherUrl, "whoami"]);
    expect(refused.code).toBe(2);
    expect(refused.envelope.error.code).toBe("usage");
    expect(refused.envelope.error.message).toContain("--key");
    expect(refused.envelope.error.message).toContain("MARFA_API_URL");
    expect(other.arrivals).toEqual([]);

    // The same server named twice is the pair it was exported as.
    const same = await c.cli.run(["--json", "--url", c.apiUrl, "whoami"]);
    expect(same.code, same.stderr).toBe(0);

    // The witness: an explicit key reaches the other server.
    const given = await c.cli.run([
      "--json",
      "--url",
      otherUrl,
      "--key",
      c.apiKey,
      "whoami",
    ]);
    expect(given.code).toBe(3);
    expect(other.arrivals.length).toBeGreaterThan(0);
  });
});

const BODY = Buffer.from("the bytes of a stored file\n");
const DIGEST = `sha256:${createHash("sha256").update(BODY).digest("hex")}`;

function files(): string[] {
  return readdirSync(dir).sort();
}

describe("a file the binary writes", () => {
  it("is readable by its owner alone whatever the umask, for an export and a download", async () => {
    const served = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-marfa-contract": contract,
      });
      response.end(BODY);
    });
    const server = c.cli.at(`http://127.0.0.1:${String(served.port)}`);
    const before = process.umask(0o022);
    try {
      const exported = join(dir, "items.ndjson");
      const made = await c.cli.run([
        "--json",
        "export",
        "--format",
        "ndjson",
        "--output",
        exported,
      ]);
      expect(made.code, made.stderr).toBe(0);
      expect(statSync(exported).mode & 0o777).toBe(0o600);

      const downloaded = join(dir, "stored.bin");
      const got = await server.run([
        "--json",
        "blobs",
        "download",
        DIGEST,
        "--output",
        downloaded,
      ]);
      expect(got.code, got.stderr).toBe(0);
      expect(readFileSync(downloaded)).toEqual(BODY);
      expect(statSync(downloaded).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(before);
    }
  });

  it("replaces the file at --output only when the download arrives whole and matches its digest", async () => {
    const target = join(dir, "kept.bin");
    writeFileSync(target, "the earlier file");
    const listing = files();

    const cut = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-marfa-contract": contract,
        "content-length": String(BODY.length),
      });
      response.write(BODY.subarray(0, 5));
      setTimeout(() => response.destroy(), 50);
    });
    const shortened = await c.cli
      .at(`http://127.0.0.1:${String(cut.port)}`)
      .run(["--json", "blobs", "download", DIGEST, "--output", target]);
    expect(shortened.code).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("the earlier file");
    expect(files()).toEqual(listing);

    const wrong = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-marfa-contract": contract,
      });
      response.end("not the file that was asked for");
    });
    const mismatched = await c.cli
      .at(`http://127.0.0.1:${String(wrong.port)}`)
      .run(["--json", "blobs", "download", DIGEST, "--output", target]);
    expect(mismatched.code).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("the earlier file");
    expect(files()).toEqual(listing);

    // The witness: the same download, whole and matching, replaces it.
    const whole = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-marfa-contract": contract,
      });
      response.end(BODY);
    });
    const replaced = await c.cli
      .at(`http://127.0.0.1:${String(whole.port)}`)
      .run(["--json", "blobs", "download", DIGEST, "--output", target]);
    expect(replaced.code, replaced.stderr).toBe(0);
    expect(readFileSync(target)).toEqual(BODY);
    expect(existsSync(target)).toBe(true);
  });
});

// Terminal sequences, a C1 control, and bidirectional overrides and isolates.
const HOSTILE =
  "\u001b]0;pwned\u0007\u001b]52;c;aGk=\u0007\u001b[2Kfake\u009b31m‮⁦⁩end";

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

describe("a listing of items", () => {
  it("prints no control or bidirectional character from a title, and --json is unchanged", async () => {
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--prop",
      `title=${HOSTILE}`,
      "--tag",
      "listing-escape",
    ]);
    trackItem(c.ctx, created.item.id);

    const listed = await c.cli.run([
      "items",
      "list",
      "--type",
      "core.note",
      "--all",
    ]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(created.item.id);
    expect(listed.stdout).not.toMatch(CONTROLS);
    expect(listed.stdout).toContain("fake");

    const json = await c.cli.json([
      "items",
      "list",
      "--type",
      "core.note",
      "--all",
    ]);
    expect(JSON.stringify(json)).toContain(
      JSON.stringify(HOSTILE).slice(1, -1),
    );
  });
});

describe("the overview and a device's copy of the views", () => {
  it("print no control or bidirectional character from a view's title", async () => {
    const made = await c.cli.json<{ item: { id: string } }>([
      "views",
      "create",
      "--title",
      HOSTILE,
      "--query",
      JSON.stringify({ filter: `source eq "${c.ctx.source}"` }),
    ]);
    trackView(c.ctx, made.item.id);

    const overview = await c.cli.run(["overview"]);
    expect(overview.code, overview.stderr).toBe(0);
    expect(overview.stdout).toContain(made.item.id);
    expect(overview.stdout).not.toMatch(CONTROLS);
    expect(overview.stdout).toContain("fake");

    const db = join(dir, "copy.sqlite");
    const hydrated = await c.cli.run([
      "device",
      "--db",
      db,
      "hydrate",
      "--types",
      "system.view",
      "--tier",
      "all",
    ]);
    expect(hydrated.code, hydrated.stderr).toBe(0);
    const listed = await c.cli.run(["device", "--db", db, "views", "list"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(made.item.id);
    expect(listed.stdout).not.toMatch(CONTROLS);
    expect(listed.stdout).toContain("fake");
  });
});

// A title that tries to start a line of its own, move to a column and colour
// what follows it.
const LAYOUT = "one\n  forged-row  forged view\tcolumn\u001b[1;31m";

/** No line starts as a row of its own, and nothing but the binary's own layout is a tab or an escape. */
function expectOneRow(text: string, id: string) {
  expect(text).not.toContain("\t");
  expect(text).not.toContain("\u001b");
  for (const line of text.split("\n")) {
    expect(line).not.toMatch(/^\s*forged-row/);
  }
  const rows = text.split("\n").filter((line) => line.includes(id));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("forged-row");
}

describe("stored text that is layout or colour", () => {
  it("stays on its own line, in its own column and uncoloured, in a list, the overview and a device's views", async () => {
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--prop",
      // A list shows the first line of a title.
      `title=${LAYOUT.replaceAll("\n", " ")}`,
      "--tag",
      "layout-escape",
    ]);
    trackItem(c.ctx, created.item.id);
    const listed = await c.cli.run([
      "items",
      "list",
      "--type",
      "core.note",
      "--all",
    ]);
    expect(listed.code, listed.stderr).toBe(0);
    expectOneRow(listed.stdout, created.item.id);

    const made = await c.cli.json<{ item: { id: string } }>([
      "views",
      "create",
      "--title",
      LAYOUT,
      "--query",
      JSON.stringify({ filter: `source eq "${c.ctx.source}"` }),
    ]);
    trackView(c.ctx, made.item.id);
    const overview = await c.cli.run(["overview"]);
    expect(overview.code, overview.stderr).toBe(0);
    expectOneRow(overview.stdout, made.item.id);

    const db = join(dir, "layout.sqlite");
    const hydrated = await c.cli.run([
      "device",
      "--db",
      db,
      "hydrate",
      "--types",
      "system.view",
      "--tier",
      "all",
    ]);
    expect(hydrated.code, hydrated.stderr).toBe(0);
    const views = await c.cli.run(["device", "--db", db, "views", "list"]);
    expect(views.code, views.stderr).toBe(0);
    expectOneRow(views.stdout, made.item.id);

    // The witness: the same text is what the server holds, so the lines
    // above are the binary's doing.
    const json = await c.cli.json(["overview"]);
    expect(JSON.stringify(json)).toContain("forged-row  forged view\\tcolumn");
  });
});

describe("stored names that differ only by a control character", () => {
  it("shows each as its own entry, with no control character on the terminal", async () => {
    const created = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--prop",
      "title=extension names",
    ]);
    trackItem(c.ctx, created.item.id);
    const body = {
      "a\nb": "the name with a real newline",
      "a\\u{a}b": "the name that spells the escape",
    };
    await c.cli.json([
      "extensions",
      "write",
      created.item.id,
      "app.review",
      "--body",
      JSON.stringify(body),
    ]);
    const got = await c.cli.run([
      "extensions",
      "get",
      created.item.id,
      "app.review",
    ]);
    expect(got.code, got.stderr).toBe(0);
    expect(got.stdout).not.toMatch(CONTROLS);
    expect(got.stdout).toContain("the name with a real newline");
    expect(got.stdout).toContain("the name that spells the escape");
  });
});

describe("a type move that is only asked what it would do", () => {
  it("says a key's label on the line of that key, however the label is written", async () => {
    const stem = unique("clilabel").replace(/-/g, "");
    const from = `user.${stem}a`;
    const to = `user.${stem}b`;
    for (const id of [from, to]) {
      await c.cli.json([
        "types",
        "register",
        "--body",
        JSON.stringify({ id, fields: { note: { type: "string" } } }),
      ]);
      trackType(c.ctx, id);
    }
    const label = `first\nwould move 99 items from ${from} to ${to}\u001b[2K${HOSTILE}`;
    const minted = await c.cli.json<{ id: string }>([
      "keys",
      "create",
      "--label",
      label,
      "--source",
      unique("cli-label"),
      "--type-permission",
      `${from}=read`,
    ]);
    trackKey(c.ctx, minted.id);
    const manager = await getOwnerClient().createKey({
      label: "type move manager",
      source: unique("cli-manager"),
      permissions: ["keys.manage", "schema.write"],
      type_permissions: { "*": "write" },
    });
    expect(manager.ok, JSON.stringify(manager.error)).toBe(true);
    trackKey(c.ctx, manager.data.id);
    const asManager = c.cli.as(manager.data.key);

    const outcome = await asManager.run([
      "types",
      "move",
      from,
      to,
      "--dry-run",
    ]);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.stdout).not.toMatch(CONTROLS);
    expect(outcome.stdout).toContain(minted.id);
    expect(outcome.stdout).toContain("first");
    const lines = outcome.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("would move"))).toHaveLength(
      1,
    );
    expect(lines.some((line) => line.startsWith("would move 99"))).toBe(false);

    // The witness: the server holds the label with its line break.
    const json = await asManager.json<{ grants: { label: string }[] }>([
      "types",
      "move",
      from,
      to,
      "--dry-run",
    ]);
    expect(json.grants.map((grant) => grant.label)).toContain(label);
  });
});

describe("a redirect from the docs site", () => {
  it("is sent through the proxy or not by where it goes, each time", async () => {
    const landed = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          pages: [
            {
              title: "Files",
              url: "https://docs.marfa.so/files",
              description: null,
              breadcrumbs: [],
            },
          ],
        }),
      );
    });
    const sentByProxy: string[] = [];
    const behind = createServer((request, response) => {
      sentByProxy.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(302, {
        location: `http://127.0.0.1:${String(landed.port)}/api/docs/topics`,
      });
      response.end();
    });
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      sentByProxy.push(`CONNECT ${request.url ?? ""}`);
      if (!(request.url ?? "").startsWith("docs.example.test")) {
        socket.destroy();
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      behind.emit("connection", socket);
    });
    servers.push(behind, proxy);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const through = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`;

    const outcome = await c.cli
      .withEnv({
        MARFA_DOCS_URL: "http://docs.example.test",
        HTTP_PROXY: through,
        http_proxy: through,
        HTTPS_PROXY: through,
        ALL_PROXY: through,
        all_proxy: through,
        NO_PROXY: "",
        no_proxy: "",
      })
      .run(["--json", "docs", "topics"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(JSON.parse(outcome.stdout).pages[0].title).toBe("Files");
    // The first request went through the proxy, so it was in use, and the
    // redirect to this machine did not.
    expect(sentByProxy).toEqual([
      "CONNECT docs.example.test:80",
      "GET /api/docs/topics",
    ]);
    expect(landed.arrivals.map((entry) => entry.url)).toEqual([
      "/api/docs/topics",
    ]);
  });

  it("leaves what names the caller behind when it goes to another host or port", async () => {
    const landed = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pages: [] }));
    });
    const { arrivals, port: first } = await listen(
      "127.0.0.1",
      (request, response) => {
        const to =
          request.url === "/api/docs/topics"
            ? `http://localhost:${String(landed.port)}/api/docs/topics`
            : "/";
        response.writeHead(302, { location: to });
        response.end();
      },
    );
    const outcome = await c.cli
      .withEnv({ MARFA_DOCS_URL: `http://127.0.0.1:${String(first)}` })
      .run(["--json", "docs", "topics"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(arrivals).toHaveLength(1);
    expect(landed.arrivals).toHaveLength(1);
    for (const arrival of [...arrivals, ...landed.arrivals]) {
      expect(arrival.authorization).toBeUndefined();
      expect(arrival.cookie).toBeUndefined();
      expect(arrival.marfa).toEqual([]);
    }
  });
});
