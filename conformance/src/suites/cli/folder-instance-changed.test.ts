import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY, everythingClient } from "../../utils/own-blob-server.js";
import { Cli, requireBinary } from "./harness.js";
import type { ItemEnvelope } from "./harness.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * A directory holding changes its server never received, after that server
 * was lost and a backup of it was restored into a new instance at the same
 * address.
 */

let origin: FreshServer | undefined;
let target: FreshServer | undefined;
let root: string;

beforeAll(async () => {
  origin = await bootFreshServer("cli-folder-instance-origin", DISK_ONLY);
  root = tempFolder("marfa-cli-folder-instance-");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await origin?.stop();
  await target?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface Listed {
  data: Array<{
    id: string;
    type: string;
    properties: { title?: string; body?: string };
  }>;
}

const note = (title: string, body: string): string =>
  `---\ntitle: ${title}\n---\n${body}\n`;

describe("a directory whose server is now another instance", () => {
  it("sends a directory's unsent changes to the instance a backup was restored into, with marfa commands alone and no item twice", async () => {
    const registry = join(root, "registry", "folders.json");
    const dir = join(root, "Home");
    const aside = join(root, "Home.before-restore");
    const binary = requireBinary();
    const first = new Cli(binary, origin!.apiUrl, origin!.workingKey).withEnv({
      MARFA_FOLDER_REGISTRY: registry,
    });

    const made = await first.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      "Home",
      "--query",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    const folder = made.item.id;
    await first.json(["folders", "add", dir, "--folder", folder, "--yes"]);
    writeFileSync(join(dir, "Packing list.md"), note("Packing list", "socks"));
    writeFileSync(join(dir, "Plan.md"), note("Plan", "first"));
    writeFileSync(join(dir, "Unchanged.md"), note("Unchanged", "as it was"));
    expect((await first.run(["folders", "push", dir])).code).toBe(0);
    const backup = await (await everythingClient(origin!)).exportArchive();
    expect(backup.status).toBe(200);
    const archive = join(root, "backup.tar");
    writeFileSync(archive, backup.data);

    // The server is lost before it hears of these changes.
    const port = new URL(origin!.apiUrl).port;
    await origin!.stop();
    origin = undefined;
    const packing = readFileSync(join(dir, "Packing list.md"), "utf8").replace(
      "socks",
      "socks\nboots",
    );
    writeFileSync(join(dir, "Packing list.md"), packing);
    writeFileSync(join(dir, "Plan.md"), "first\nand second\n");
    writeFileSync(join(dir, "New idea.md"), note("New idea", "brand new"));
    const unsent = await first.run(["folders", "push", dir]);
    expect(unsent.code, unsent.stderr).toBe(3);

    target = await bootFreshServer("cli-folder-instance-target", {
      ...DISK_ONLY,
      MARFA_PORT: port,
    });
    expect(target.apiUrl).toBe(first.url);
    const restored = await new Cli(binary, target.apiUrl, undefined)
      .viaSocket(target.controlSocket)
      .run(["restore", archive]);
    expect(restored.code, restored.stderr).toBe(0);
    const cli = new Cli(binary, target.apiUrl, target.workingKey).withEnv({
      MARFA_FOLDER_REGISTRY: registry,
    });

    const stopped = await cli.refused(["folders", "push", dir]);
    expect(JSON.stringify(stopped.envelope)).toContain("instance_changed");

    const removed = await cli.run(["folders", "remove", dir]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toMatch(/[1-9]\d* write\(s\) could not be sent/);
    expect(removed.stdout).toContain(`the changes stay in the files in ${dir}`);
    const command = `marfa folders add ${dir} --folder ${folder}`;
    expect(removed.stdout).toContain(command);
    expect(existsSync(join(dir, ".marfa"))).toBe(false);
    expect(readFileSync(join(dir, "Packing list.md"), "utf8")).toBe(packing);
    expect(readFileSync(join(dir, "Plan.md"), "utf8")).toBe(
      "first\nand second\n",
    );

    // The route the removal names.
    renameSync(dir, aside);
    await cli.json(["folders", "add", dir, "--folder", folder, "--yes"]);
    const written = await cli.run(["folders", "push", dir]);
    expect(written.code, written.stderr).toBe(0);
    for (const name of ["Packing list.md", "Plan.md", "New idea.md"]) {
      cpSync(join(aside, name), join(dir, name));
    }
    const sent = await cli.run(["folders", "push", dir]);
    expect(sent.code, sent.stderr).toBe(0);
    const settled = await cli.run(["folders", "push", dir]);
    expect(settled.code, settled.stderr).toBe(0);

    const items = await cli.json<Listed>([
      "items",
      "list",
      "--type",
      "core.note",
      "--limit",
      "100",
    ]);
    const titles = items.data.map((item) => item.properties.title).sort();
    expect(titles).toEqual(["New idea", "Packing list", "Plan", "Unchanged"]);
    const body = (title: string): string | undefined =>
      items.data.find((item) => item.properties.title === title)?.properties
        .body;
    expect(body("Packing list")).toContain("boots");
    expect(body("Plan")).toContain("and second");
    expect(body("New idea")).toContain("brand new");
    expect(
      readdirSync(dir)
        .filter((name) => name !== ".marfa")
        .sort(),
    ).toEqual(["New idea.md", "Packing list.md", "Plan.md", "Unchanged.md"]);
    const status = await cli.run(["folders", "status", dir]);
    expect(status.stdout).toContain("4 file(s) in step");
  });
});
