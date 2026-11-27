import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { Cli, CliContext, ItemEnvelope, Outcome } from "./harness.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * `items add` and `items attach` hash a regular file and ask which items hold
 * those bytes before they upload the path. A forwarding server in front of the
 * real one shows which requests the binary sent and in what order, and answers
 * the lookup the way a server without it would.
 */

let c: CliContext;
let dir: string;
let front: Server;
let frontCli: Cli;
let failingFront: Server;
let failingCli: Cli;
let invalidFronts: Server[];
let invalidClis: Cli[];
let pageFront: Server;
let pageCli: Cli;
const seen: string[] = [];

/** What a forwarding server does with `POST /items/blobs`: pass it on, or
 *  answer it itself. `page` answers the holders in `pageAnswer`. */
type Lookup =
  | "pass"
  | "no-route"
  | "empty-item"
  | "items-object"
  | "missing-title"
  | "two-entries"
  | "page";

/** The page a `page` lookup answers, so one server can believe a full page and
 *  then contradict it. */
let pageAnswer: { count: number; more: boolean } = { count: 20, more: true };

/** The contract the booted server names. A success without it is not read. */
let contract = "";

/** Run when the lookup reaches the forwarding server `front`, with the number
 *  of lookups it has had: the moment a file is replaced under a check. */
let onLookup: ((count: number) => void) | undefined;
let lookups = 0;

/** A success the CLI will read: the contract header, or the body is refused unread. */
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "x-marfa-contract": contract,
  });
  res.end(JSON.stringify(body));
}

/** A server on a local port that forwards every request to `upstream`, and
 *  answers `POST /items/blobs` itself as `lookup` says. */
async function forwarding(
  upstream: string,
  lookup: Lookup,
  record: string[] = seen,
): Promise<Server> {
  const server = createServer((req, res) => {
    record.push(`${req.method ?? ""} ${req.url ?? ""}`);
    if (lookup !== "pass" && req.url === "/items/blobs") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          hashes: string[];
        };
        if (lookup === "no-route") {
          reply(res, 404, {
            error: { code: "not_found", message: "no route" },
          });
          return;
        }
        const hash = body.hashes[0];
        if (lookup === "page") {
          const items = Array.from({ length: pageAnswer.count }, (_, n) => ({
            id: `i${String(n)}`,
            type: "core.file",
            title: "T",
          }));
          reply(res, 200, {
            data: [{ hash, items, more: pageAnswer.more }],
          });
          return;
        }
        if (lookup === "missing-title") {
          reply(res, 200, {
            data: [{ hash, items: [{ id: "i", type: "t" }], more: false }],
          });
          return;
        }
        if (lookup === "two-entries") {
          reply(res, 200, {
            data: [
              {
                hash,
                items: [{ id: "a", type: "t", title: "A" }],
                more: false,
              },
              {
                hash,
                items: [{ id: "b", type: "t", title: "B" }],
                more: false,
              },
            ],
          });
          return;
        }
        const items = lookup === "empty-item" ? [{}] : { id: "x", type: "t" };
        reply(res, 200, { data: [{ hash, items, more: false }] });
      });
      return;
    }
    if (req.url === "/items/blobs" && onLookup !== undefined) {
      lookups += 1;
      onLookup(lookups);
    }
    const target = new URL(req.url ?? "/", upstream);
    const forwarded = httpRequest(
      target,
      {
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    req.pipe(forwarded);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

const addressOf = (server: Server) =>
  `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

beforeAll(async () => {
  c = await cliContext("duplicate-file");
  const current = await fetch(`${c.apiUrl}/keys/current`, {
    headers: { authorization: `Bearer ${c.apiKey}` },
  });
  contract = current.headers.get("x-marfa-contract") ?? "";
  expect(contract).not.toBe("");
  dir = tempFolder("marfa-cli-duplicate-");
  front = await forwarding(c.apiUrl, "pass");
  failingFront = await forwarding(c.apiUrl, "no-route");
  invalidFronts = [
    await forwarding(c.apiUrl, "empty-item"),
    await forwarding(c.apiUrl, "items-object"),
    await forwarding(c.apiUrl, "missing-title"),
    await forwarding(c.apiUrl, "two-entries"),
  ];
  pageFront = await forwarding(c.apiUrl, "page");
  frontCli = c.cli.at(addressOf(front));
  failingCli = c.cli.at(addressOf(failingFront));
  invalidClis = invalidFronts.map((server) => c.cli.at(addressOf(server)));
  pageCli = c.cli.at(addressOf(pageFront));
});

afterAll(async () => {
  onLookup = undefined;
  front.close();
  failingFront.close();
  for (const server of invalidFronts) server.close();
  pageFront.close();
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

interface Held {
  data: { hash: string; items: { id: string }[]; more: boolean }[];
}

/** A file of bytes no other run sends, and the hash the server names them by. */
function newFile(name: string): { path: string; hash: string } {
  const path = join(dir, `${randomUUID()}-${name}`);
  const bytes = Buffer.from(`duplicate-file ${randomUUID()}`);
  writeFileSync(path, bytes);
  return {
    path,
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/** What replaces the bytes at `path`, as a person saving over a file does:
 *  written beside it and renamed over it, so a reader that has the old file
 *  open keeps the old bytes. Answers the new hash. */
function replaceBytes(path: string, text: string): string {
  const bytes = Buffer.from(text);
  writeFileSync(`${path}.new`, bytes);
  renameSync(`${path}.new`, path);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Writes `text` into the open file, the same inode, so a reader of that
 *  file sees the new bytes. Answers their hash. */
function writeInto(path: string, text: string): string {
  const bytes = Buffer.from(text);
  writeFileSync(path, bytes);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Every item that holds `hash`, tracked so the file's cleanup removes it. */
async function holders(hash: string): Promise<string[]> {
  const answer = await c.cli.json<Held>(["items", "blobs", hash]);
  const ids = answer.data[0]?.items.map((item) => item.id) ?? [];
  for (const id of ids) trackItem(c.ctx, id);
  return ids;
}

/** What the binary said on standard error, but for the line it writes before
 *  every write to say where the write goes. */
function notes(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("marfa: writing to "));
}

/** The posts the binary sent since `mark`, in order. */
function sentSince(mark: number): string[] {
  return seen.slice(mark).filter((line) => line.startsWith("POST "));
}

/** A fifo holding `text`. The writer blocks until something opens the fifo. */
function fifoOf(
  name: string,
  text: string,
): { path: string; writer: ChildProcess } {
  const path = join(dir, `${randomUUID()}-${name}`);
  execFileSync("mkfifo", [path]);
  const writer = spawn(
    "sh",
    ["-c", 'printf \'%s\' "$1" > "$2"', "fifo", text, path],
    { stdio: "ignore" },
  );
  return { path, writer };
}

function writerDone(writer: ChildProcess): Promise<void> {
  if (writer.exitCode === 0) return Promise.resolve();
  if (writer.exitCode !== null) {
    return Promise.reject(
      new Error(`fifo writer exited ${String(writer.exitCode)}`),
    );
  }
  return new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`fifo writer exited ${String(code)}`));
    });
  });
}

describe("adding a file an item already holds", () => {
  it("adds a file no item holds without a word, after asking which items hold its hash", async () => {
    const { path, hash } = newFile("fresh.txt");
    const mark = seen.length;
    const outcome = await frontCli.run(["--json", "items", "add", path]);
    expect(outcome.code, outcome.stderr).toBe(0);
    const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
      duplicates?: unknown;
    };
    trackItem(c.ctx, answer.item.id);
    expect(sentSince(mark)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);
    expect(await holders(hash)).toEqual([answer.item.id]);

    // The same path, once an item holds it, produces the warning and duplicates.
    const again = await frontCli.run(["--json", "items", "add", path]);
    expect(again.code, again.stderr).toBe(0);
    const matched = JSON.parse(again.stdout) as ItemEnvelope & {
      duplicates: { items: { id: string }[] };
    };
    trackItem(c.ctx, matched.item.id);
    expect(notes(again.stderr)).toHaveLength(1);
    expect(again.stderr).toContain("already in Marfa");
    expect(matched.duplicates.items.map((item) => item.id)).toContain(
      answer.item.id,
    );

    // That was producible, so the first add's silence is the check finding nothing.
    expect(notes(outcome.stderr)).toEqual([]);
    expect(answer.duplicates).toBeUndefined();
  });

  it("adds a file an item holds where no terminal can be asked, names the match on standard error and carries it under duplicates", async () => {
    const { path, hash } = newFile("twice.txt");
    const first = await c.cli.json<ItemEnvelope>(["items", "add", path]);
    trackItem(c.ctx, first.item.id);
    const outcome = await c.cli.run(["--json", "items", "add", path]);
    expect(outcome.code, outcome.stderr).toBe(0);
    const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
      duplicates: { items: { id: string; type: string }[]; more: boolean };
    };
    trackItem(c.ctx, answer.item.id);
    expect(answer.item.id).not.toBe(first.item.id);
    expect(answer.duplicates.items.map((item) => item.id)).toEqual([
      first.item.id,
    ]);
    expect(answer.duplicates.items[0]?.type).toBe("core.file");
    expect(answer.duplicates.more).toBe(false);
    expect(notes(outcome.stderr)).toHaveLength(1);
    expect(outcome.stderr).toContain(first.item.id);
    // The same, with no --json: standard input is no terminal either.
    const plain = await c.cli.run(["items", "add", path]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(notes(plain.stderr)).toHaveLength(1);
    expect(plain.stderr).toContain(first.item.id);
    expect(await holders(hash)).toHaveLength(3);
  });

  it("asks at a terminal, names each match and adds the file on yes", async () => {
    const { path, hash } = newFile("asked.txt");
    const first = await c.cli.json<ItemEnvelope>(["items", "add", path]);
    trackItem(c.ctx, first.item.id);
    const title = first.item.properties.title;
    expect(typeof title).toBe("string");
    const outcome = await c.cli.runAtTerminal(["items", "add", path], "y");
    expect(outcome.code, outcome.stdout).toBe(0);
    expect(outcome.stdout).toContain(
      `${String(title)} (core.file, ${first.item.id})`,
    );
    expect(outcome.stdout).toContain("Add it anyway? [y/N]");
    expect(outcome.stdout).toContain("added");
    expect(await holders(hash)).toHaveLength(2);
  });

  it("adds nothing at a terminal on anything but yes, and reports the item that holds the file", async () => {
    // The witness: the same command, answered yes, reaches the upload.
    const agreed = newFile("declined-yes.txt");
    const agreedFirst = await c.cli.json<ItemEnvelope>([
      "items",
      "add",
      agreed.path,
    ]);
    trackItem(c.ctx, agreedFirst.item.id);
    const yesMark = seen.length;
    const yes = await frontCli.runAtTerminal(
      ["items", "add", agreed.path],
      "y",
    );
    expect(yes.code, yes.stdout).toBe(0);
    expect(sentSince(yesMark)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);
    expect(await holders(agreed.hash)).toHaveLength(2);

    const { path, hash } = newFile("declined.txt");
    const first = await c.cli.json<ItemEnvelope>(["items", "add", path]);
    trackItem(c.ctx, first.item.id);
    for (const answer of ["n", "", "maybe"]) {
      const mark = seen.length;
      const outcome = await frontCli.runAtTerminal(
        ["items", "add", path],
        answer,
      );
      expect(outcome.code, outcome.stdout).toBe(0);
      expect(outcome.stdout).toContain("Add it anyway? [y/N]");
      expect(outcome.stdout).toContain("not added");
      expect(outcome.stdout).toContain(
        "same contents as this one when it was checked",
      );
      expect(outcome.stdout.split(first.item.id).length).toBeGreaterThan(2);
      expect(sentSince(mark)).toEqual(["POST /items/blobs"]);
    }
    expect(await holders(hash)).toEqual([first.item.id]);
  });

  it("adds nothing under --if-duplicate skip and reports the item that holds the file, and adds a file no item holds", async () => {
    // The witness: a file no item holds, under the same flag, is uploaded.
    const other = newFile("not-held.txt");
    const witness = seen.length;
    const added = await frontCli.json<ItemEnvelope>([
      "items",
      "add",
      "--if-duplicate",
      "skip",
      other.path,
    ]);
    trackItem(c.ctx, added.item.id);
    expect(sentSince(witness)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);
    expect(await holders(other.hash)).toEqual([added.item.id]);

    const { path, hash } = newFile("skipped.txt");
    const first = await c.cli.json<ItemEnvelope>(["items", "add", path]);
    trackItem(c.ctx, first.item.id);
    const mark = seen.length;
    const skipped = await frontCli.run([
      "--json",
      "items",
      "add",
      "--if-duplicate",
      "skip",
      path,
    ]);
    expect(skipped.code, skipped.stderr).toBe(0);
    const held = JSON.parse(skipped.stdout) as {
      added: boolean;
      duplicates: { items: { id: string }[] };
    };
    expect(held.added).toBe(false);
    expect(held.duplicates.items.map((item) => item.id)).toEqual([
      first.item.id,
    ]);
    const plain = await frontCli.run([
      "items",
      "add",
      "--if-duplicate",
      "skip",
      path,
    ]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toContain(first.item.id);
    expect(plain.stdout).toContain(
      "same contents as this one when it was checked",
    );
    expect(sentSince(mark)).toEqual(["POST /items/blobs", "POST /items/blobs"]);
    expect(await holders(hash)).toEqual([first.item.id]);
  });

  it("adds under --if-duplicate add without asking which items hold the file", async () => {
    const recorded: string[] = [];
    const own = await forwarding(c.apiUrl, "pass", recorded);
    const posts = (from: number) =>
      recorded.slice(from).filter((line) => line.startsWith("POST "));
    try {
      const cli = c.cli.at(addressOf(own));
      const { path, hash } = newFile("chosen.txt");
      // This recorder sees a default run ask before the add run is judged.
      const witness = await cli.run(["--json", "items", "add", path]);
      expect(witness.code, witness.stderr).toBe(0);
      const first = JSON.parse(witness.stdout) as ItemEnvelope;
      trackItem(c.ctx, first.item.id);
      expect(posts(0)).toEqual([
        "POST /items/blobs",
        "POST /blobs",
        "POST /items",
      ]);

      const mark = recorded.length;
      const outcome = await cli.run([
        "--json",
        "items",
        "add",
        "--if-duplicate",
        "add",
        path,
      ]);
      expect(outcome.code, outcome.stderr).toBe(0);
      expect(notes(outcome.stderr)).toEqual([]);
      const answer = JSON.parse(outcome.stdout) as ItemEnvelope;
      trackItem(c.ctx, answer.item.id);
      expect(posts(mark)).toEqual(["POST /blobs", "POST /items"]);
      expect(await holders(hash)).toHaveLength(2);
    } finally {
      own.close();
    }
  });

  it("adds the file and says the check could not be made when the lookup fails", async () => {
    const { path, hash } = newFile("unchecked.txt");
    for (const mode of ["ask", "skip"]) {
      const first = await c.cli.json<ItemEnvelope>([
        "items",
        "add",
        "--if-duplicate",
        "add",
        path,
      ]);
      trackItem(c.ctx, first.item.id);
      const outcome = await failingCli.run([
        "--json",
        "items",
        "add",
        "--if-duplicate",
        mode,
        path,
      ]);
      expect(outcome.code, outcome.stderr).toBe(0);
      const answer = JSON.parse(outcome.stdout) as ItemEnvelope;
      trackItem(c.ctx, answer.item.id);
      expect(notes(outcome.stderr)).toHaveLength(1);
      expect(outcome.stderr).toContain("could not check");
    }
    expect(await holders(hash)).toHaveLength(4);
  });

  it("checks an attached file the same way, and attaches nothing when skipped", async () => {
    const note = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-duplicate"), body: "b" }),
    ]);
    trackItem(c.ctx, note.item.id);
    // The witness: with no terminal to ask, a file the lookup matches attaches.
    const fresh = newFile("attach-fresh.txt");
    const freshHolder = await c.cli.json<ItemEnvelope>([
      "items",
      "add",
      fresh.path,
    ]);
    trackItem(c.ctx, freshHolder.item.id);
    const witness = seen.length;
    const attached = await frontCli.run([
      "--json",
      "items",
      "attach",
      note.item.id,
      fresh.path,
    ]);
    expect(attached.code, attached.stderr).toBe(0);
    expect(attached.stderr).toContain(freshHolder.item.id);
    expect(sentSince(witness)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
      "POST /edges",
    ]);
    const answer = JSON.parse(attached.stdout) as ItemEnvelope;
    trackItem(c.ctx, answer.item.id);
    const linked = await c.cli.json<{ data: unknown[] }>([
      "items",
      "backrefs",
      note.item.id,
      "--type",
      "attached-to",
    ]);
    expect(linked.data).toHaveLength(1);

    const { path, hash } = newFile("attached.txt");
    const first = await c.cli.json<ItemEnvelope>(["items", "add", path]);
    trackItem(c.ctx, first.item.id);
    const mark = seen.length;
    const skipped = await frontCli.run([
      "--json",
      "items",
      "attach",
      "--if-duplicate",
      "skip",
      note.item.id,
      path,
    ]);
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain(first.item.id);
    expect(sentSince(mark)).toEqual(["POST /items/blobs"]);
    const backrefs = await c.cli.json<{ data: unknown[] }>([
      "items",
      "backrefs",
      note.item.id,
      "--type",
      "attached-to",
    ]);
    expect(backrefs.data).toHaveLength(1);
    expect(await holders(hash)).toEqual([first.item.id]);
  });

  it("treats an answer that is not a whole lookup as a failed lookup, and adds the file", async () => {
    for (const cli of invalidClis) {
      const { path, hash } = newFile("invalid.txt");
      const first = await c.cli.json<ItemEnvelope>([
        "items",
        "add",
        "--if-duplicate",
        "add",
        path,
      ]);
      trackItem(c.ctx, first.item.id);
      const outcome = await cli.run([
        "--json",
        "items",
        "add",
        "--if-duplicate",
        "skip",
        path,
      ]);
      expect(outcome.code, outcome.stderr).toBe(0);
      const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
        duplicates?: unknown;
      };
      trackItem(c.ctx, answer.item.id);
      expect(answer.duplicates).toBeUndefined();
      expect(notes(outcome.stderr)).toHaveLength(1);
      expect(outcome.stderr).toContain("could not check");
      expect(await holders(hash)).toHaveLength(2);
    }
  });

  it("believes a full page of holders and treats a contradictory more as a failed lookup", async () => {
    pageAnswer = { count: 20, more: true };
    const full = newFile("full-page.txt");
    const believedMark = seen.length;
    const believed = await pageCli.run([
      "--json",
      "items",
      "add",
      "--if-duplicate",
      "skip",
      full.path,
    ]);
    expect(believed.code, believed.stderr).toBe(0);
    const held = JSON.parse(believed.stdout) as {
      added: boolean;
      duplicates: { items: unknown[]; more: boolean };
    };
    expect(held.added).toBe(false);
    expect(held.duplicates.items).toHaveLength(20);
    expect(held.duplicates.more).toBe(true);
    expect(notes(believed.stderr)).toEqual([]);
    expect(sentSince(believedMark)).toEqual(["POST /items/blobs"]);

    for (const answer of [
      { count: 1, more: true },
      { count: 21, more: false },
    ]) {
      pageAnswer = answer;
      const { path, hash } = newFile("contradiction.txt");
      const mark = seen.length;
      const outcome = await pageCli.run([
        "--json",
        "items",
        "add",
        "--if-duplicate",
        "skip",
        path,
      ]);
      expect(outcome.code, outcome.stderr).toBe(0);
      const added = JSON.parse(outcome.stdout) as ItemEnvelope & {
        duplicates?: unknown;
      };
      trackItem(c.ctx, added.item.id);
      expect(added.duplicates).toBeUndefined();
      expect(notes(outcome.stderr)).toHaveLength(1);
      expect(outcome.stderr).toContain("could not check");
      expect(sentSince(mark)).toEqual([
        "POST /items/blobs",
        "POST /blobs",
        "POST /items",
      ]);
      expect(await holders(hash)).toEqual([added.item.id]);
    }
  });

  it("skips a held file when its path is replaced during the lookup, and uploads nothing", async () => {
    const fresh = newFile("replaced-fresh.txt");
    const witness = seen.length;
    const added = await frontCli.json<ItemEnvelope>([
      "items",
      "add",
      "--if-duplicate",
      "skip",
      fresh.path,
    ]);
    trackItem(c.ctx, added.item.id);
    expect(sentSince(witness)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);

    const { path, hash } = newFile("replaced.txt");
    const first = await c.cli.json<ItemEnvelope>(["items", "add", path]);
    trackItem(c.ctx, first.item.id);
    let replacement = "";
    onLookup = (count) => {
      if (count === 1) replacement = replaceBytes(path, `new ${randomUUID()}`);
    };
    const mark = seen.length;
    const outcome = await frontCli.run([
      "--json",
      "items",
      "add",
      "--if-duplicate",
      "skip",
      path,
    ]);
    onLookup = undefined;
    lookups = 0;
    expect(outcome.code, outcome.stderr).toBe(0);
    const answer = JSON.parse(outcome.stdout) as { added: boolean };
    expect(answer.added).toBe(false);
    expect(sentSince(mark)).toEqual(["POST /items/blobs"]);
    expect(await holders(hash)).toEqual([first.item.id]);
    expect(await holders(replacement)).toEqual([]);
  });

  it("adds the bytes a replaced path holds after the lookup, and skips a held file whose path is replaced", async () => {
    const note = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-duplicate"), body: "b" }),
    ]);
    trackItem(c.ctx, note.item.id);
    const { path, hash } = newFile("replaced-attach.txt");
    let replacement = "";
    onLookup = (count) => {
      if (count === 1) replacement = replaceBytes(path, `new ${randomUUID()}`);
    };
    const mark = seen.length;
    const outcome = await frontCli.run([
      "--json",
      "items",
      "attach",
      note.item.id,
      path,
    ]);
    onLookup = undefined;
    lookups = 0;
    expect(outcome.code, outcome.stderr).toBe(0);
    const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
      duplicates?: unknown;
    };
    trackItem(c.ctx, answer.item.id);
    expect(answer.duplicates).toBeUndefined();
    expect(notes(outcome.stderr)).toHaveLength(1);
    expect(outcome.stderr).toContain("changed while it was being checked");
    expect(outcome.stderr).not.toContain("already in Marfa");
    expect(sentSince(mark)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
      "POST /edges",
    ]);
    expect(await holders(hash)).toEqual([]);
    expect(await holders(replacement)).toEqual([answer.item.id]);

    const second = newFile("replaced-attach-held.txt");
    const holder = await c.cli.json<ItemEnvelope>([
      "items",
      "add",
      second.path,
    ]);
    trackItem(c.ctx, holder.item.id);
    let again = "";
    onLookup = (count) => {
      if (count === 1)
        again = replaceBytes(second.path, `again ${randomUUID()}`);
    };
    const after = seen.length;
    const skipped = await frontCli.run([
      "--json",
      "items",
      "attach",
      "--if-duplicate",
      "skip",
      note.item.id,
      second.path,
    ]);
    onLookup = undefined;
    lookups = 0;
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(sentSince(after)).toEqual(["POST /items/blobs"]);
    expect(await holders(second.hash)).toEqual([holder.item.id]);
    expect(await holders(again)).toEqual([]);
  });

  it("adds a file that changes while it is checked, and still adds one whose new bytes are already held", async () => {
    // The control reaches item creation through the same rewrite, with bytes nobody holds.
    const fresh = newFile("changing.txt");
    let replacement = "";
    onLookup = (count) => {
      if (count === 1)
        replacement = writeInto(fresh.path, `new ${randomUUID()}`);
    };
    const controlMark = seen.length;
    let control: Outcome;
    try {
      control = await frontCli.run([
        "--json",
        "items",
        "add",
        "--if-duplicate",
        "skip",
        fresh.path,
      ]);
    } finally {
      onLookup = undefined;
      lookups = 0;
    }
    expect(control.code, control.stderr).toBe(0);
    const created = JSON.parse(control.stdout) as ItemEnvelope & {
      duplicates?: unknown;
    };
    trackItem(c.ctx, created.item.id);
    expect(created.duplicates).toBeUndefined();
    expect(notes(control.stderr)).toHaveLength(1);
    expect(control.stderr).toContain("changed while it was being checked");
    expect(control.stderr).not.toContain("already in Marfa");
    expect(sentSince(controlMark)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);
    expect(await holders(fresh.hash)).toEqual([]);
    expect(await holders(replacement)).toEqual([created.item.id]);

    const heldText = `held ${randomUUID()}`;
    const heldPath = join(dir, `${randomUUID()}-already.txt`);
    writeFileSync(heldPath, heldText);
    const heldHash = `sha256:${createHash("sha256").update(heldText).digest("hex")}`;
    const holder = await c.cli.json<ItemEnvelope>([
      "items",
      "add",
      "--if-duplicate",
      "add",
      heldPath,
    ]);
    trackItem(c.ctx, holder.item.id);

    const changing = newFile("rewritten.txt");
    onLookup = (count) => {
      if (count === 1) writeInto(changing.path, heldText);
    };
    const mark = seen.length;
    let outcome: Outcome;
    try {
      outcome = await frontCli.run([
        "--json",
        "items",
        "add",
        "--if-duplicate",
        "skip",
        changing.path,
      ]);
    } finally {
      onLookup = undefined;
      lookups = 0;
    }
    expect(outcome.code, outcome.stderr).toBe(0);
    const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
      added?: boolean;
      duplicates?: unknown;
    };
    trackItem(c.ctx, answer.item.id);
    expect(answer.item.id).not.toBe(holder.item.id);
    expect(answer.duplicates).toBeUndefined();
    expect(answer.added).toBeUndefined();
    expect(notes(outcome.stderr)).toHaveLength(1);
    expect(outcome.stderr).toContain("changed while it was being checked");
    expect(outcome.stderr).not.toContain("already in Marfa");
    expect(sentSince(mark)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);
    const holding = await holders(heldHash);
    expect(holding).toHaveLength(2);
    expect(holding).toContain(holder.item.id);
    expect(holding).toContain(answer.item.id);

    const plainFile = newFile("rewritten-plain.txt");
    onLookup = (count) => {
      if (count === 1) writeInto(plainFile.path, heldText);
    };
    let plain: Outcome;
    try {
      plain = await frontCli.run([
        "items",
        "add",
        "--if-duplicate",
        "skip",
        plainFile.path,
      ]);
    } finally {
      onLookup = undefined;
      lookups = 0;
    }
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toMatch(/^added /);
    expect(plain.stdout).not.toContain("not added");
    expect(notes(plain.stderr)).toHaveLength(1);
    expect(plain.stderr).toContain("changed while it was being checked");
    expect(plain.stderr).not.toContain("already in Marfa");
    expect(await holders(heldHash)).toHaveLength(3);
  });

  it("adds a stream without checking it, and adds one under --if-duplicate add without a warning", async () => {
    const regular = newFile("regular-before-stream.txt");
    const witness = seen.length;
    const added = await frontCli.json<ItemEnvelope>([
      "items",
      "add",
      regular.path,
    ]);
    trackItem(c.ctx, added.item.id);
    expect(sentSince(witness)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);

    for (const mode of ["ask", "skip"]) {
      const text = `stream ${mode} ${randomUUID()}`;
      const pipe = fifoOf("pipe", text);
      const hash = `sha256:${createHash("sha256").update(text).digest("hex")}`;
      try {
        const mark = seen.length;
        const outcome = await frontCli.run([
          "--json",
          "items",
          "add",
          "--if-duplicate",
          mode,
          pipe.path,
        ]);
        await writerDone(pipe.writer);
        expect(outcome.code, outcome.stderr).toBe(0);
        const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
          duplicates?: unknown;
        };
        trackItem(c.ctx, answer.item.id);
        expect(answer.duplicates).toBeUndefined();
        expect(notes(outcome.stderr)).toHaveLength(1);
        expect(outcome.stderr).toContain("a stream cannot be checked");
        expect(sentSince(mark)).toEqual(["POST /blobs", "POST /items"]);
        expect(await holders(hash)).toEqual([answer.item.id]);
      } finally {
        if (pipe.writer.exitCode === null) pipe.writer.kill();
      }
    }

    const silentText = `silent ${randomUUID()}`;
    const silent = fifoOf("silent", silentText);
    const silentHash = `sha256:${createHash("sha256").update(silentText).digest("hex")}`;
    try {
      const mark = seen.length;
      const outcome = await frontCli.run([
        "--json",
        "items",
        "add",
        "--if-duplicate",
        "add",
        silent.path,
      ]);
      await writerDone(silent.writer);
      expect(outcome.code, outcome.stderr).toBe(0);
      const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
        duplicates?: unknown;
      };
      trackItem(c.ctx, answer.item.id);
      expect(answer.duplicates).toBeUndefined();
      expect(notes(outcome.stderr)).toEqual([]);
      expect(sentSince(mark)).toEqual(["POST /blobs", "POST /items"]);
      expect(await holders(silentHash)).toEqual([answer.item.id]);
    } finally {
      if (silent.writer.exitCode === null) silent.writer.kill();
    }
  });

  it("adds redirected standard input from a file without checking it, for ask and skip, and adds it under --if-duplicate add without a warning", async () => {
    const regular = newFile("regular-before-stdin.txt");
    const witness = seen.length;
    const added = await frontCli.json<ItemEnvelope>([
      "items",
      "add",
      regular.path,
    ]);
    trackItem(c.ctx, added.item.id);
    expect(sentSince(witness)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);

    // Skip of bytes already held must still add: a check would see the match and add nothing.
    const held = newFile("stdin-held.txt");
    const seeded = await c.cli.json<ItemEnvelope>([
      "items",
      "add",
      "--if-duplicate",
      "add",
      held.path,
    ]);
    trackItem(c.ctx, seeded.item.id);

    for (const mode of ["ask", "skip"] as const) {
      const file = mode === "skip" ? held : newFile(`stdin-${mode}.txt`);
      const mark = seen.length;
      const outcome = await frontCli.run(
        ["--json", "items", "add", "--if-duplicate", mode, "/dev/stdin"],
        { stdinPath: file.path },
      );
      expect(outcome.code, outcome.stderr).toBe(0);
      const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
        added?: boolean;
        duplicates?: unknown;
      };
      trackItem(c.ctx, answer.item.id);
      expect(answer.duplicates).toBeUndefined();
      expect(answer.added).toBeUndefined();
      expect(notes(outcome.stderr)).toHaveLength(1);
      expect(outcome.stderr).toContain("a stream cannot be checked");
      expect(sentSince(mark)).toEqual(["POST /blobs", "POST /items"]);
      expect(await holders(file.hash)).toContain(answer.item.id);
    }
    expect(await holders(held.hash)).toHaveLength(2);

    const silent = newFile("stdin-add.txt");
    const mark = seen.length;
    const outcome = await frontCli.run(
      ["--json", "items", "add", "--if-duplicate", "add", "/dev/stdin"],
      { stdinPath: silent.path },
    );
    expect(outcome.code, outcome.stderr).toBe(0);
    const answer = JSON.parse(outcome.stdout) as ItemEnvelope & {
      duplicates?: unknown;
    };
    trackItem(c.ctx, answer.item.id);
    expect(answer.duplicates).toBeUndefined();
    expect(notes(outcome.stderr)).toEqual([]);
    expect(sentSince(mark)).toEqual(["POST /blobs", "POST /items"]);
    expect(await holders(silent.hash)).toEqual([answer.item.id]);
  });

  it("prints a file name or an item title that holds a newline or an escape sequence without either", async () => {
    const path = join(dir, `${randomUUID()}-a\nb\u001b[2Jc.txt`);
    const hash = replaceBytes(path, `named ${randomUUID()}`);
    const first = await c.cli.json<ItemEnvelope>([
      "items",
      "add",
      "--if-duplicate",
      "add",
      path,
    ]);
    trackItem(c.ctx, first.item.id);
    expect(String(first.item.properties.title)).toContain("\n");
    expect(String(first.item.properties.title)).toContain("\u001b");
    const plain = await c.cli.run(["items", "add", path]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(notes(plain.stderr)).toHaveLength(1);
    expect(plain.stderr).not.toContain("\u001b");
    expect(plain.stdout).not.toContain("\u001b");
    const skipped = await c.cli.run([
      "items",
      "add",
      "--if-duplicate",
      "skip",
      path,
    ]);
    expect(skipped.code, skipped.stderr).toBe(0);
    // One line for the file and one for each of the two items that hold it.
    expect(skipped.stdout.split("\n").filter((l) => l !== "")).toHaveLength(3);
    expect(skipped.stdout).not.toContain("\u001b");
    expect(skipped.stdout).toContain("\\u{1b}");
    expect(skipped.stdout).toContain("\\u{a}");
    const asked = await c.cli.runAtTerminal(["items", "add", path], "n");
    expect(asked.stdout).not.toContain("\u001b");
    expect(asked.stdout).toContain("\\u{1b}");
    expect(asked.stdout).toContain("is already in Marfa:");
    expect(await holders(hash)).toHaveLength(2);
  });

  it("fails on a file it cannot read, naming the file, before any upload", async () => {
    const readable = newFile("readable-before-missing.txt");
    const witness = seen.length;
    const added = await frontCli.json<ItemEnvelope>([
      "items",
      "add",
      readable.path,
    ]);
    trackItem(c.ctx, added.item.id);
    expect(sentSince(witness)).toEqual([
      "POST /items/blobs",
      "POST /blobs",
      "POST /items",
    ]);

    const missing = join(dir, "never-written.txt");
    const mark = seen.length;
    const outcome = await frontCli.run(["--json", "items", "add", missing]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain("never-written.txt");
    expect(sentSince(mark)).toEqual([]);

    const folder = join(dir, `not-a-file-${randomUUID()}`);
    mkdirSync(folder);
    for (const mode of [undefined, "add"] as const) {
      const args = ["--json", "items", "add"];
      if (mode !== undefined) args.push("--if-duplicate", mode);
      args.push(folder);
      const at = seen.length;
      const refused = await frontCli.run(args);
      expect(refused.code, refused.stderr).not.toBe(0);
      expect(refused.stderr).toContain("not-a-file-");
      expect(sentSince(at)).toEqual([]);
    }
  });
});
