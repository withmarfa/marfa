import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { Cli, CliContext, ItemEnvelope } from "./harness.js";

/**
 * A person names servers in `profiles.toml`, each with where its key comes
 * from, and picks one with `--profile` or `MARFA_PROFILE`. The profile
 * `demo` names the real server, with a key command that prints this file's
 * key; `example` names a listener of this file's own, which records each
 * request's bearer, so a scenario can see which key reached which server.
 */

let c: CliContext;
let dir: string;
let home: string;
let file: string;
let listener: Listener;
let base: Cli;

/** A key that belongs to no server, exported as a person might for another. */
const OUTSIDE_KEY = "marfa_k1_conformance_outside_key";
/** The key the listener's profile sends. */
const EXAMPLE_KEY = "marfa_k1_conformance_example_key";
/** What a failing key command prints on stdout, which no refusal may show. */
const PRINTED = "marfa_k1_conformance_printed_by_a_failure";

interface Entry {
  url: string;
  key_command?: string[];
}

/** One section a profile, as a person writes the file by hand. */
function toml(entries: Record<string, Entry>, extra = ""): string {
  const sections = Object.entries(entries).map(([name, entry]) => {
    const lines = [`[${name}]`, `url = ${JSON.stringify(entry.url)}`];
    if (entry.key_command !== undefined) {
      lines.push(`key_command = ${JSON.stringify(entry.key_command)}`);
    }
    return lines.join("\n");
  });
  return `# Servers for the conformance run.\n\n${sections.join("\n\n")}\n${extra}`;
}

function write(text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  rmSync(file, { force: true });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function profiles(more: Record<string, Entry> = {}): Record<string, Entry> {
  return {
    demo: {
      url: c.apiUrl,
      key_command: ["sh", "-c", 'printf "%s\\n" "$PROFILE_KEY"'],
    },
    example: {
      url: listener.url,
      key_command: ["printf", "%s", EXAMPLE_KEY],
    },
    ...more,
  };
}

/** Records every request and answers a 503 naming no contract. */
class Listener {
  readonly bearers: (string | undefined)[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<Listener> {
    const bearers: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      bearers.push(request.headers.authorization);
      request.resume();
      response.writeHead(503, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const listener = new Listener(server, `http://127.0.0.1:${String(port)}`);
    Object.assign(listener, { bearers });
    return listener;
  }

  clear(): void {
    this.bearers.splice(0);
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

beforeAll(async () => {
  c = await cliContext("profiles");
  listener = await Listener.start();
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-profiles-"));
  home = join(dir, "home");
  file =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Marfa", "profiles.toml")
      : join(home, ".config", "marfa", "profiles.toml");
  write(toml(profiles()));
  // The variables a person might have exported for another server; each
  // scenario says which of them it keeps.
  base = c.cli.withEnv({
    HOME: home,
    PROFILE_KEY: c.apiKey,
    MARFA_API_URL: listener.url,
    MARFA_API_KEY: OUTSIDE_KEY,
    MARFA_PROFILE: "",
  });
});

afterAll(async () => {
  await listener.close();
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

async function note(): Promise<string> {
  const created = await c.cli.json<ItemEnvelope>([
    "items",
    "create",
    "--type",
    "core.note",
    "--prop",
    `title=${unique("profile-note")}`,
    "--prop",
    "body=named by a profile",
  ]);
  trackItem(c.ctx, created.item.id);
  return created.item.id;
}

interface Whoami {
  server: string;
  profile: string | null;
  credential: { kind: string; from: string } | null;
}

describe("profiles", () => {
  it("takes the server and key from --profile, reading none of the variables", async () => {
    // Witness: the variables alone send their key to the listener.
    listener.clear();
    const outside = await base.run(["--json", "items", "get", "i1"]);
    expect(outside.code, outside.stderr).not.toBe(0);
    expect(listener.bearers).toContain(`Bearer ${OUTSIDE_KEY}`);

    listener.clear();
    const id = await note();
    const named = base.withEnv({ MARFA_PROFILE: "example" });
    const read = await named.json<ItemEnvelope>([
      "--profile",
      "demo",
      "items",
      "get",
      id,
    ]);
    expect(read.item.id).toBe(id);
    const who = await named.json<Whoami>(["--profile", "demo", "whoami"]);
    expect(who.server).toBe(new URL(c.apiUrl).origin);
    expect(who.profile).toBe("demo");
    expect(who.credential?.from).toBe("key_command");
    expect(who.credential?.kind).toBe("key");
    // Nothing reached the server the variables name, the profile's key least of all.
    expect(listener.bearers).toEqual([]);
  });

  it("refuses --profile beside --url or --key", async () => {
    listener.clear();
    for (const beside of [
      ["--url", listener.url],
      ["--key", OUTSIDE_KEY],
    ]) {
      const { code, envelope } = await base.refused([
        "--profile",
        "demo",
        ...beside,
        "items",
        "list",
      ]);
      expect(code, beside[0]).toBe(2);
      expect(envelope.error.code).toBe("usage");
    }
    expect(listener.bearers).toEqual([]);
  });

  it("reads no MARFA_PROFILE beside --url or --key", async () => {
    const id = await note();
    // A profile the file does not have, which would be refused if it were read.
    const missing = base.withEnv({ MARFA_PROFILE: "missing" });
    const missingWitness = await missing
      .withEnv({ MARFA_API_URL: "", MARFA_API_KEY: "" })
      .refused(["items", "get", id]);
    expect(missingWitness.code).toBe(2);
    expect(missingWitness.envelope.error.message).toContain("missing");

    const byUrl = await missing
      .withEnv({ MARFA_API_KEY: c.apiKey })
      .json<ItemEnvelope>(["--url", c.apiUrl, "items", "get", id]);
    expect(byUrl.item.id).toBe(id);
    const byKey = await missing
      .withEnv({ MARFA_API_URL: c.apiUrl })
      .json<ItemEnvelope>(["--key", c.apiKey, "items", "get", id]);
    expect(byKey.item.id).toBe(id);
  });

  it("refuses MARFA_PROFILE beside MARFA_API_URL or MARFA_API_KEY, sending nothing", async () => {
    const chosen = base.withEnv({ MARFA_PROFILE: "example" });
    listener.clear();
    for (const beside of [
      { MARFA_API_URL: listener.url, MARFA_API_KEY: "" },
      { MARFA_API_URL: "", MARFA_API_KEY: OUTSIDE_KEY },
      { MARFA_API_URL: listener.url, MARFA_API_KEY: OUTSIDE_KEY },
    ]) {
      const { code, envelope } = await chosen
        .withEnv(beside)
        .refused(["items", "get", "i1"]);
      expect(code, JSON.stringify(beside)).toBe(2);
      expect(envelope.error.code).toBe("usage");
      expect(envelope.error.message).toContain("MARFA_PROFILE");
    }
    expect(listener.bearers).toEqual([]);

    // Witness: alone, MARFA_PROFILE picks the profile and its key.
    await chosen
      .withEnv({ MARFA_API_URL: "", MARFA_API_KEY: "" })
      .run(["--json", "items", "get", "i1"]);
    expect(listener.bearers).toEqual([`Bearer ${EXAMPLE_KEY}`]);
  });

  it("sends a profile's server no key but the profile's", async () => {
    listener.clear();
    for (const env of [
      { MARFA_API_KEY: c.apiKey },
      { MARFA_API_KEY: OUTSIDE_KEY },
    ]) {
      const ran = await base
        .withEnv(env)
        .run(["--json", "--profile", "example", "items", "get", "i1"]);
      expect(ran.code, ran.stderr).not.toBe(0);
    }
    expect(listener.bearers.length).toBeGreaterThan(0);
    for (const bearer of listener.bearers) {
      expect(bearer).toBe(`Bearer ${EXAMPLE_KEY}`);
    }
  });

  it("runs the key command once in a run, as an argument list without a shell, with no standard input", async () => {
    const counter = join(dir, "key-command-runs");
    write(
      toml(
        profiles({
          counted: {
            url: c.apiUrl,
            key_command: [
              "sh",
              "-c",
              `echo ran >> '${counter}'; printf %s "$PROFILE_KEY"`,
            ],
          },
          literal: {
            url: listener.url,
            key_command: ["printf", "%s", "$PROFILE_KEY"],
          },
          reader: {
            url: c.apiUrl,
            key_command: [
              "sh",
              "-c",
              'if read -r line; then printf %s "$line"; else printf %s "$PROFILE_KEY"; fi',
            ],
          },
        }),
      ),
    );
    try {
      // A hydration sends the key on several requests.
      const store = join(dir, "counted.db");
      await base.json([
        "--profile",
        "counted",
        "device",
        "--db",
        store,
        "hydrate",
        "--types",
        "core.note",
        "--tier",
        "library",
      ]);
      expect(readFileSync(counter, "utf8")).toBe("ran\n");

      // No shell expands the variable, so the listener sees its name.
      listener.clear();
      await base.run(["--json", "--profile", "literal", "items", "get", "i1"]);
      expect(listener.bearers).toEqual(["Bearer $PROFILE_KEY"]);

      // What the CLI's standard input carries never reaches the key command.
      const id = await note();
      const read = await base.json<ItemEnvelope>(
        ["--profile", "reader", "items", "get", id],
        { stdin: "marfa_k1_conformance_typed_on_stdin\n" },
      );
      expect(read.item.id).toBe(id);
    } finally {
      write(toml(profiles()));
    }
  });

  it("refuses a key command that fails with key_command and exit 5, sending nothing and showing none of its output", async () => {
    const failing: Record<string, string[]> = {
      unfound: ["marfa-conformance-no-such-program"],
      failed: [
        "sh",
        "-c",
        `printf ${PRINTED}; echo the vault is locked >&2; exit 7`,
      ],
      killed: ["sh", "-c", `printf ${PRINTED}; kill -9 $$`],
      silent: ["true"],
      lines: ["printf", `${PRINTED}\\nsecond`],
      large: ["sh", "-c", "head -c 20000 /dev/zero | tr '\\0' a"],
      binary: ["printf", "\\377\\376"],
    };
    write(
      toml(
        profiles(
          Object.fromEntries(
            Object.entries(failing).map(([name, argv]) => [
              name,
              { url: listener.url, key_command: argv },
            ]),
          ),
        ),
      ),
    );
    try {
      listener.clear();
      for (const [name, argv] of Object.entries(failing)) {
        const ran = await base.run([
          "--json",
          "--profile",
          name,
          "items",
          "get",
          "i1",
        ]);
        expect(ran.code, `${name}: ${ran.stderr}`).toBe(5);
        expect(ran.stdout).toBe("");
        expect(ran.stderr).not.toContain(PRINTED);
        const envelope = JSON.parse(ran.stderr) as {
          error: { code: string; message: string };
        };
        expect(envelope.error.code, name).toBe("key_command");
        expect(envelope.error.message).toContain(`profile ${name}`);
        expect(envelope.error.message).toContain(`(${argv[0]!})`);
      }
      expect(listener.bearers).toEqual([]);

      // Witness: a key command that works reaches the same listener.
      await base.run(["--json", "--profile", "example", "items", "get", "i1"]);
      expect(listener.bearers).toEqual([`Bearer ${EXAMPLE_KEY}`]);
    } finally {
      write(toml(profiles()));
    }
  });

  it("refuses a profile file or folder others can write, or a field it does not know, never showing what the file holds", async () => {
    const id = await note();
    const marker = "marfa_k1_conformance_in_the_file";
    const marked = toml(
      profiles({
        marked: { url: c.apiUrl, key_command: ["printf", "%s", marker] },
      }),
    );
    const get = ["--profile", "demo", "items", "get", id];
    try {
      write(marked);
      chmodSync(file, 0o664);
      const group = await base.refused(get);
      expect(group.code).toBe(2);
      expect(group.envelope.error.code).toBe("usage");
      expect(group.envelope.error.message).toContain("chmod");
      expect(JSON.stringify(group.envelope)).not.toContain(marker);

      chmodSync(file, 0o600);
      chmodSync(dirname(file), 0o777);
      const folder = await base.refused(get);
      expect(folder.code).toBe(2);
      expect(folder.envelope.error.message).toContain("chmod");
      expect(JSON.stringify(folder.envelope)).not.toContain(marker);
      chmodSync(dirname(file), 0o700);

      write(
        toml(
          profiles(),
          `\n[typo]\nurl = "${c.apiUrl}"\nkey_comand = ["printf", "${marker}"]\n`,
        ),
      );
      const typo = await base.refused([
        "--profile",
        "typo",
        "items",
        "get",
        id,
      ]);
      expect(typo.code).toBe(2);
      expect(typo.envelope.error.code).toBe("usage");
      expect(typo.envelope.error.message).toContain("key_comand");
      expect(JSON.stringify(typo.envelope)).not.toContain(marker);

      // Witness: the same file, kept to its owner, is read.
      write(marked);
      const read = await base.json<ItemEnvelope>(get);
      expect(read.item.id).toBe(id);
    } finally {
      chmodSync(dirname(file), 0o700);
      write(toml(profiles()));
    }
  });

  it("names the server and profile on stderr before the first write, and nothing for a read or under --json", async () => {
    const origin = new URL(c.apiUrl).origin;
    const id = await note();
    const tag = (word: string) => ["items", "tag", id, word];

    const written = await base.run(["--profile", "demo", ...tag("profiled")]);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stderr).toBe(`marfa: writing to ${origin} (profile demo)\n`);

    const unprofiled = await c.cli.run(tag("unprofiled"));
    expect(unprofiled.code, unprofiled.stderr).toBe(0);
    expect(unprofiled.stderr).toBe(`marfa: writing to ${origin}\n`);

    // `items bulk-get` is a read sent as POST.
    for (const read of [
      ["items", "get", id],
      ["items", "bulk-get", id],
    ]) {
      const ran = await base.run(["--profile", "demo", ...read]);
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).not.toBe("");
      expect(ran.stderr, read.join(" ")).toBe("");
    }

    const quiet = await base.run([
      "--json",
      "--profile",
      "demo",
      ...tag("quiet"),
    ]);
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.stderr).toBe("");
  });

  it("refuses --profile and MARFA_PROFILE beside --socket, and --profile on server commands", async () => {
    const socket = join(dir, "no-such.sock");
    const flagged = await base.refused([
      "--socket",
      socket,
      "--profile",
      "demo",
      "items",
      "list",
    ]);
    expect(flagged.code).toBe(2);
    expect(flagged.envelope.error.code).toBe("usage");

    const exported = await base
      .withEnv({ MARFA_PROFILE: "demo", MARFA_API_URL: "", MARFA_API_KEY: "" })
      .refused(["--socket", socket, "items", "list"]);
    expect(exported.code).toBe(2);
    expect(exported.envelope.error.message).toContain("MARFA_PROFILE");

    const server = await base.refused([
      "--profile",
      "demo",
      "server",
      "status",
    ]);
    expect(server.code).toBe(2);
    expect(server.envelope.error.code).toBe("usage");
    expect(server.envelope.error.message).toContain("--profile");
  });

  it("refuses keychain commands for a profile whose key comes from a key command", async () => {
    for (const command of [
      ["login", "--no-browser"],
      ["logout"],
      ["keys", "keep"],
      ["keys", "forget"],
    ]) {
      const { code, envelope } = await base.refused(
        ["--profile", "demo", ...command],
        { stdin: `${c.apiKey}\n` },
      );
      expect(code, command.join(" ")).toBe(2);
      expect(envelope.error.code).toBe("usage");
      expect(envelope.error.message).toContain("key_command");
    }
  });
});
