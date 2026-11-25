import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { Cli, requireBinary } from "./harness.js";

interface Tree {
  folder_id: string;
  under: string;
  direct_files: number;
  total_files: number;
  unreadable_placements: number;
  directories: {
    path: string;
    direct_files: number;
    all_files: number;
    has_directories: boolean;
  }[];
}

let server: FreshServer;
let local: Cli, key: Cli;
let folder: string;

beforeAll(async () => {
  server = await bootFreshServer("cli-folder-directories");
  const binary = requireBinary();
  local = new Cli(binary, server.apiUrl, undefined, server.controlSocket);
  key = new Cli(binary, server.apiUrl, server.workingKey);
  folder = (
    await key.json<{ item: { id: string } }>([
      "folders",
      "create",
      "--title",
      "Directories",
    ])
  ).item.id;
  for (const path of [
    "readme.md",
    "notes/one.md",
    "notes/2026/jan.md",
    "./A:notes/child/page.md",
    "-drafts/-sub/one.md",
  ]) {
    const note = await key.json<{ item: { id: string } }>([
      "items",
      "create",
      "--type",
      "core.note",
      "--prop",
      "title=Placed",
      "--prop",
      "body=Placed",
    ]);
    await key.json([
      "edges",
      "create",
      "--from-id",
      note.item.id,
      "--to-id",
      folder,
      "--type",
      "in-folder",
      "--properties",
      JSON.stringify({ path }),
    ]);
  }
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

it("lists a folder's directories one level at a time, and opens each by the path it was given", async () => {
  const top = await key.json<Tree>(["folders", "directories", folder]);
  expect(top.under).toBe("");
  expect(top.direct_files).toBe(1);
  expect(top.total_files).toBe(5);
  expect(top.unreadable_placements).toBe(0);
  expect(top.directories.map((d) => d.path)).toEqual([
    "-drafts",
    "A:notes",
    "notes",
  ]);
  for (const directory of top.directories) {
    const opened = await key.json<Tree>([
      "folders",
      "directories",
      folder,
      "--under",
      directory.path,
    ]);
    expect(opened.under).toBe(directory.path);
    expect(opened.directories.length).toBeGreaterThan(0);
  }
  const notes = await key.json<Tree>([
    "folders",
    "directories",
    folder,
    "--under",
    "notes",
  ]);
  expect(notes.direct_files).toBe(1);
  expect(notes.directories).toEqual([
    {
      path: "notes/2026",
      direct_files: 1,
      all_files: 1,
      has_directories: false,
    },
  ]);
});

it("reads through the private socket and says each directory in plain output", async () => {
  const viaSocket = await local.json<Tree>(["folders", "directories", folder]);
  expect(viaSocket.total_files).toBe(5);
  const plain = await key.run([
    "folders",
    "directories",
    folder,
    "--under",
    "notes",
  ]);
  expect(plain.code, plain.stderr).toBe(0);
  expect(plain.stdout).toContain(
    "1 file(s) directly at notes; 5 file(s) in the folder",
  );
  expect(plain.stdout).toContain("notes/2026: 1 file(s) directly, 1 in all");
});

it("refuses an under that leaves the folder, and a folder that is not one", async () => {
  const outside = await key.run([
    "folders",
    "directories",
    folder,
    "--under",
    "../x",
  ]);
  expect(outside.code).not.toBe(0);
  expect(outside.stderr).toContain("under");
  const missing = await key.run([
    "folders",
    "directories",
    "01920000-0000-7000-8000-000000000000",
  ]);
  expect(missing.code).not.toBe(0);
});
