import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, trackType } from "../../utils/setup.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { cliContext, type CliContext } from "./harness.js";

/**
 * An owner installs a plugin from the terminal: from a bundle file, from a
 * source folder, and by name from a release this file serves itself, never
 * from the plugins repository.
 */

let c: CliContext;
let root: string;

interface Plugin {
  name: string;
  version: string;
  outcome?: string;
  types: string[];
  fingerprint: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(name: string): Record<string, unknown> {
  return {
    name,
    title: "Terminal plugin",
    description: "A plugin the terminal installs.",
    mark: "lucide:terminal",
    maker: "Marfa",
    marfa: "0.0.1",
  };
}

function definition(id: string): Record<string, unknown> {
  return {
    id,
    description: "A thing the terminal installs.",
    fields: { title: { type: "string" } },
  };
}

function bundleOf(name: string, id: string, version: string) {
  return {
    format: 1,
    ...manifest(name),
    version,
    types: [definition(id)],
    edge_types: [],
  };
}

/** A source folder holding `plugin.json` and one type with its guidance. */
function sourceFolder(name: string, id: string): string {
  const folder = join(tempFolder("marfa-plugin-source-"), name);
  mkdirSync(join(folder, "types"), { recursive: true });
  writeFileSync(join(folder, "plugin.json"), JSON.stringify(manifest(name)));
  writeFileSync(
    join(folder, "types", `${id}.json`),
    JSON.stringify(definition(id)),
  );
  writeFileSync(join(folder, "types", `${id}.md`), "Use it for things.\n");
  return folder;
}

interface Asked {
  path: string;
  headers: IncomingHttpHeaders;
}

/** A release on a local port serving `files` by name, keeping what it was asked. */
async function release(
  files: Record<string, string>,
): Promise<{ url: string; asked: Asked[]; server: Server }> {
  const asked: Asked[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    asked.push({ path, headers: request.headers });
    const body = files[path.replace(/^\/download\//, "")];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/download`, asked, server };
}

beforeAll(async () => {
  c = await cliContext("plugins");
  root = c.ctx.runId;
});

afterAll(async () => {
  for (const name of [`${root}-file`, `${root}-folder`, `${root}-named`]) {
    await c.cli.run(["plugins", "remove", name]);
  }
  await cleanup(c.ctx);
});

describe("plugins from the terminal", () => {
  it("installs a plugin from a bundle file and from a source folder, and lists, reads and removes it", async () => {
    const fileType = `${root}.file-thing`;
    const folderType = `${root}.folder-thing`;
    trackType(c.ctx, fileType);
    trackType(c.ctx, folderType);
    const file = join(tempFolder("marfa-plugin-bundle-"), "file.plugin.json");
    // Spacing JSON.stringify would not write, so a body sent as re-serialized JSON differs.
    const written = `${JSON.stringify(bundleOf(`${root}-file`, fileType, "1.0.0"), null, 3)}\n\n`;
    writeFileSync(file, written);
    const fromFile = await c.cli.json<Plugin>(["plugins", "install", file]);
    expect(fromFile).toMatchObject({
      name: `${root}-file`,
      version: "1.0.0",
      outcome: "installed",
      types: [fileType],
    });
    expect(fromFile.fingerprint).toBe(sha256(readFileSync(file)));
    const folder = sourceFolder(`${root}-folder`, folderType);
    const output = tempFolder("marfa-plugin-built-");
    await c.cli.json([
      "plugins",
      "bundle",
      folder,
      "--version",
      "2.1.0",
      "--output",
      output,
    ]);
    const built = sha256(
      readFileSync(join(output, `${root}-folder.plugin.json`)),
    );
    const installing = await c.cli.run([
      "--json",
      "plugins",
      "install",
      folder,
      "--version",
      "2.1.0",
    ]);
    expect(installing.code, installing.stderr).toBe(0);
    const fromFolder = JSON.parse(installing.stdout) as Plugin;
    expect(fromFolder).toMatchObject({ version: "2.1.0", types: [folderType] });
    expect(fromFolder.fingerprint).toBe(built);
    expect(installing.stderr).toContain(built);
    const read = await c.cli.json<{ guidance?: string; provenance: unknown }>([
      "types",
      "get",
      folderType,
    ]);
    expect(read.guidance).toBe("Use it for things.");
    expect(read.provenance).toMatchObject({
      origin: "plugin",
      plugin: { name: `${root}-folder`, version: "2.1.0" },
    });
    const listed = await c.cli.json<{ data: Plugin[] }>(["plugins", "list"]);
    expect(listed.data.map((held) => held.name)).toEqual(
      expect.arrayContaining([`${root}-file`, `${root}-folder`]),
    );
    const got = await c.cli.json<Plugin>(["plugins", "get", `${root}-file`]);
    expect(got.version).toBe("1.0.0");
    const removed = await c.cli.json<{ kept: { types: string[] } }>([
      "plugins",
      "remove",
      `${root}-file`,
    ]);
    expect(removed.kept.types).toEqual([fileType]);
    const gone = await c.cli.refused(["plugins", "get", `${root}-file`]);
    expect(gone.code).toBe(1);
    expect(gone.envelope.error.code).toBe("not_found");
    expect(
      (await c.cli.json<{ id: string }>(["types", "get", fileType])).id,
    ).toBe(fileType);
  });

  it("installs a plugin by name from a release's index, checking its SHA-256, and sends no credential", async () => {
    const name = `${root}-named`;
    const id = `${root}.named-thing`;
    trackType(c.ctx, id);
    const bundle = `${JSON.stringify(bundleOf(name, id, "3.0.0"), null, 1)}\n`;
    const digest = createHash("sha256").update(bundle).digest("hex");
    const index = JSON.stringify({
      format: 1,
      plugins: [
        {
          ...manifest(name),
          version: "3.0.0",
          has_connector: false,
          bundle: `${name}.plugin.json`,
          sha256: digest,
        },
      ],
    });
    const served = await release({
      "plugins.json": index,
      [`${name}.plugin.json`]: bundle,
    });
    try {
      const installed = await c.cli
        .withEnv({ MARFA_PLUGINS_URL: served.url })
        .json<Plugin>(["plugins", "install", name]);
      expect(installed).toMatchObject({ name, version: "3.0.0", types: [id] });
      expect(installed.fingerprint).toBe(digest);
      expect(served.asked.map((asked) => asked.path)).toEqual([
        "/download/plugins.json",
        `/download/${name}.plugin.json`,
      ]);
      for (const asked of served.asked) {
        expect(asked.headers.authorization).toBeUndefined();
        expect(asked.headers.cookie).toBeUndefined();
      }
    } finally {
      served.server.close();
    }
  });

  it("refuses a plugins address carrying a user name or password before it fetches, printing and sending neither", async () => {
    const name = `${root}-credentialed`;
    const id = `${root}.credentialed-thing`;
    trackType(c.ctx, id);
    const bundle = JSON.stringify(bundleOf(name, id, "1.0.0"));
    const served = await release({
      "plugins.json": JSON.stringify({
        format: 1,
        plugins: [
          {
            ...manifest(name),
            version: "1.0.0",
            has_connector: false,
            bundle: `${name}.plugin.json`,
            sha256: createHash("sha256").update(bundle).digest("hex"),
          },
        ],
      }),
      [`${name}.plugin.json`]: bundle,
    });
    const secret = "hunter2-plugins-secret";
    try {
      const carrying = served.url.replace(
        "http://",
        `http://reader:${secret}@`,
      );
      const refused = await c.cli
        .withEnv({ MARFA_PLUGINS_URL: carrying })
        .run(["--json", "plugins", "install", name]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("user name or password");
      expect(refused.stderr + refused.stdout).not.toContain(secret);
      expect(served.asked).toEqual([]);
      const malformed = await c.cli
        .withEnv({ MARFA_PLUGINS_URL: `http://reader:${secret}@[not-a-host` })
        .run(["--json", "plugins", "install", name]);
      expect(malformed.code).not.toBe(0);
      expect(malformed.stderr).toContain("MARFA_PLUGINS_URL");
      expect(malformed.stderr + malformed.stdout).not.toContain(secret);
      // The witness: the same release without the user info installs.
      const installed = await c.cli
        .withEnv({ MARFA_PLUGINS_URL: served.url })
        .json<Plugin>(["plugins", "install", name]);
      expect(installed).toMatchObject({ name, version: "1.0.0" });
      expect(served.asked).toHaveLength(2);
    } finally {
      served.server.close();
      await c.cli.run(["plugins", "remove", name]);
    }
  });

  it("refuses a bundle whose SHA-256 is not the one the index lists, exiting 3 with plugins_unreachable and installing nothing", async () => {
    const name = `${root}-tampered`;
    const id = `${root}.tampered-thing`;
    const bundle = JSON.stringify(bundleOf(name, id, "1.0.0"));
    const served = await release({
      "plugins.json": JSON.stringify({
        format: 1,
        plugins: [
          {
            ...manifest(name),
            version: "1.0.0",
            has_connector: false,
            bundle: `${name}.plugin.json`,
            sha256: "0".repeat(64),
          },
        ],
      }),
      [`${name}.plugin.json`]: bundle,
    });
    try {
      const refused = await c.cli
        .withEnv({ MARFA_PLUGINS_URL: served.url })
        .refused(["plugins", "install", name]);
      expect(refused.code).toBe(3);
      expect(refused.envelope.error.code).toBe("plugins_unreachable");
      expect(refused.envelope.error.message).toContain("SHA-256");
    } finally {
      served.server.close();
    }
    const missing = await c.cli.refused(["plugins", "get", name]);
    expect(missing.envelope.error.code).toBe("not_found");
  });
});
