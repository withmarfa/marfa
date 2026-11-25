import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { validatorFor, type OpenApiDocument } from "../../utils/openapi.js";
import { controlRequest } from "../../utils/control-request.js";

let server: FreshServer;
let document: OpenApiDocument;
let number = 0;

interface Directory {
  path: string;
  direct_files: number;
  all_files: number;
  has_directories: boolean;
}
interface Tree {
  folder_id: string;
  under: string;
  direct_files: number;
  total_files: number;
  directories: Directory[];
}

const NO_SUCH_ID = "01920000-0000-7000-8000-000000000000";
const SAMPLE = [
  "readme.md",
  "notes/one.md",
  "notes/two.md",
  "notes/2026/jan.md",
  "notes/2026/feb/a.md",
  "notes/2026/feb/b.md",
  "projects/plan.md",
  "projects/archive/old/deep/x.md",
];

beforeAll(async () => {
  server = await bootFreshServer("folder-directories");
  document = (await (
    await fetch(`${server.apiUrl}/openapi.json`)
  ).json()) as OpenApiDocument;
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function expectMatchesSchema(
  method: string,
  path: string,
  status: number,
  data: unknown,
) {
  const schema =
    document.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)]
      ?.content?.["application/json"]?.schema;
  expect(schema).toBeDefined();
  const validate = validatorFor(schema, document);
  expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
}

function call(
  method: string,
  path: string,
  body?: unknown,
  key = server.workingKey,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function folder(): Promise<string> {
  const r = await call("POST", "/folders", { title: "Directories" });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string } }).item.id;
}
async function item(
  type = "core.note",
  key = server.workingKey,
): Promise<string> {
  const r = await call(
    "POST",
    "/items",
    { type, properties: { body: "Placed", title: "Placed" } },
    key,
  );
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { item: { id: string } }).item.id;
}
async function placeItem(id: string, dir: string, path: string) {
  const r = await call("POST", "/edges", {
    from_id: id,
    to_id: dir,
    edge_type: "in-folder",
    properties: { path },
  });
  expect(r.status, await r.clone().text()).toBe(201);
}
async function place(dir: string, path: string): Promise<string> {
  const id = await item();
  await placeItem(id, dir, path);
  return id;
}
async function placeAll(dir: string, paths: string[]) {
  for (const path of paths) await place(dir, path);
}
async function key(
  type_permissions: Record<string, string>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  number++;
  const r = await call("POST", "/keys", {
    label: "Folder directories",
    source: `folder-directories-${number}`,
    permissions: [],
    type_permissions,
    edge_permissions: { "*": "read" },
    ...extra,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { key: string }).key;
}
async function tree(
  dir: string,
  query = "",
  bearer = server.workingKey,
): Promise<Tree> {
  const r = await call(
    "GET",
    `/folders/${dir}/directories${query}`,
    undefined,
    bearer,
  );
  expect(r.status, await r.clone().text()).toBe(200);
  const data = (await r.json()) as Tree;
  await expectMatchesSchema("GET", "/folders/{id}/directories", 200, data);
  return data;
}
function rows(data: Tree): [string, number, number, boolean][] {
  return data.directories.map((d) => [
    d.path,
    d.direct_files,
    d.all_files,
    d.has_directories,
  ]);
}

describe("GET /folders/{id}/directories", () => {
  it("lists the directories at a folder's top level with their direct and nested file counts and the folder's total", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    const top = await tree(dir);
    expect(top.folder_id).toBe(dir);
    expect(top.under).toBe("");
    expect(top.direct_files).toBe(1);
    expect(top.total_files).toBe(8);
    expect(rows(top)).toEqual([
      ["notes", 2, 5, true],
      ["projects", 1, 2, true],
    ]);
    expect(Object.keys(top.directories[0] ?? {}).sort()).toEqual([
      "all_files",
      "direct_files",
      "has_directories",
      "path",
    ]);
    expect(JSON.stringify(top)).not.toContain("plan.md");
    expect((await tree(await folder())).total_files).toBe(0);
  });

  it("lists the directories directly under a path, and the files placed at the path itself", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    const notes = await tree(dir, "?under=notes");
    expect(notes.under).toBe("notes");
    expect(notes.direct_files).toBe(2);
    expect(notes.total_files).toBe(8);
    expect(rows(notes)).toEqual([["notes/2026", 1, 3, true]]);
    const feb = await tree(dir, "?under=notes/2026/feb");
    expect(feb.direct_files).toBe(2);
    expect(rows(feb)).toEqual([]);
    const deep = await tree(dir, "?under=projects");
    expect(rows(deep)).toEqual([["projects/archive", 0, 1, true]]);
  });

  it("reads a tidied under as a placement path is read, and answers the top level without one", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    const plain = await tree(dir, "?under=notes");
    for (const spelling of [
      "notes/",
      "notes//",
      "./notes",
      "notes/.",
      "%2E/notes",
      "notes%2F",
    ]) {
      expect(await tree(dir, `?under=${spelling}`), spelling).toEqual(plain);
    }
    expect((await tree(dir, "?under=notes//2026//")).under).toBe("notes/2026");
    const top = await tree(dir);
    for (const spelling of ["", ".", "./", "./."]) {
      expect(await tree(dir, `?under=${spelling}`), spelling).toEqual(top);
    }
  });

  it("refuses an under that leaves the folder or is not a path", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    for (const spelling of [
      "/notes",
      "//notes",
      "..",
      "notes/..",
      "notes/../projects",
      "%2E%2E",
      "%2Fetc",
      "C:/notes",
      "C%3A",
      "notes%5Cone",
      "notes%00",
      "a".repeat(1025),
      "notes&under=projects",
      "notes&other=1",
    ]) {
      const r = await call(
        "GET",
        `/folders/${dir}/directories?under=${spelling}`,
      );
      expect(r.status, spelling).toBe(400);
      const refusal = (await r.json()) as { error: { code: string } };
      expect(refusal.error.code, spelling).toBe("validation_error");
    }
    const other = await call("GET", `/folders/${dir}/directories?depth=2`);
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("lists the directories in the byte order of their paths", async () => {
    const dir = await folder();
    await placeAll(dir, [
      "b/x.md",
      "B/x.md",
      "a/x.md",
      "_/x.md",
      "10/x.md",
      "9/x.md",
    ]);
    expect((await tree(dir)).directories.map((d) => d.path)).toEqual([
      "10",
      "9",
      "B",
      "_",
      "a",
      "b",
    ]);
  });

  it("answers 200 and no directories for a path that holds no placed file", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    for (const under of [
      "nothing",
      "notes/absent",
      "readme.md",
      "notes/one.md",
    ]) {
      const empty = await tree(dir, `?under=${encodeURIComponent(under)}`);
      expect(empty.directories, under).toEqual([]);
      expect(empty.direct_files, under).toBe(0);
      expect(empty.total_files, under).toBe(8);
    }
  });

  it("matches names as stored, so Unicode forms and letter cases stay apart", async () => {
    const dir = await folder();
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    await placeAll(dir, [
      `${nfc}/one.md`,
      `${nfd}/two.md`,
      `${nfd}/three.md`,
      "Cafe/four.md",
      "cafe/five.md",
    ]);
    const top = await tree(dir);
    expect(rows(top)).toEqual([
      ["Cafe", 1, 1, false],
      ["cafe", 1, 1, false],
      [nfd, 2, 2, false],
      [nfc, 1, 1, false],
    ]);
    expect(
      (await tree(dir, `?under=${encodeURIComponent(nfd)}`)).direct_files,
    ).toBe(2);
    expect(
      (await tree(dir, `?under=${encodeURIComponent(nfc)}`)).direct_files,
    ).toBe(1);
    expect((await tree(dir, "?under=CAFE")).direct_files).toBe(0);
  });

  it("counts a stored path with empty or dot names where a device places it", async () => {
    const dir = await folder();
    await placeAll(dir, [
      "a//b.md",
      "./c.md",
      "a/./b/x.md",
      "d/",
      "e/f/",
      "g/.//h//i.md",
      "a/tidy.md",
      "a/b/y.md",
    ]);
    const top = await tree(dir);
    expect(rows(top)).toEqual([
      ["a", 2, 4, true],
      ["e", 1, 1, false],
      ["g", 0, 1, true],
    ]);
    expect(top.direct_files).toBe(2);
    expect(top.total_files).toBe(8);
    expect(rows(await tree(dir, "?under=a"))).toEqual([["a/b", 2, 2, false]]);
    expect(rows(await tree(dir, "?under=g"))).toEqual([["g/h", 1, 1, false]]);
  });

  it("counts an archived item and leaves out an item in the bin", async () => {
    const dir = await folder();
    await place(dir, "live/a.md");
    const archived = await place(dir, "live/b.md");
    const binned = await place(dir, "live/c.md");
    const lone = await place(dir, "binned/d.md");
    const move = async (id: string, state: string) => {
      const r = await call("POST", `/items/${id}/transition`, { state });
      expect(r.status, await r.clone().text()).toBe(200);
    };
    const before = await tree(dir);
    expect(rows(before)).toEqual([
      ["binned", 1, 1, false],
      ["live", 3, 3, false],
    ]);
    await move(archived, "archived");
    await move(binned, "trashed");
    await move(lone, "trashed");
    const after = await tree(dir);
    expect(rows(after)).toEqual([["live", 2, 2, false]]);
    expect(after.total_files).toBe(2);
  });

  it("keeps answering for a revoked folder", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    const revoked = await call("POST", `/folders/${dir}/revoke`);
    expect(revoked.status).toBe(200);
    const top = await tree(dir);
    expect(top.total_files).toBe(8);
    expect(rows(top)).toEqual([
      ["notes", 2, 5, true],
      ["projects", 1, 2, true],
    ]);
  });

  it("counts only the files whose type and source the credential reads", async () => {
    const dir = await folder();
    await placeAll(dir, ["a/note.md", "a/b/note.md", "top.md"]);
    for (const path of ["a/task.md", "c/task.md"]) {
      await placeItem(await item("core.task"), dir, path);
    }
    const notesOnly = await key({
      "system.folder": "read",
      "core.note": "read",
    });
    const typed = await tree(dir, "", notesOnly);
    expect(rows(typed)).toEqual([["a", 1, 2, true]]);
    expect(typed.direct_files).toBe(1);
    expect(typed.total_files).toBe(3);
    expect((await tree(dir)).total_files).toBe(5);

    const shownSource = "folder-directories-shown";
    const shown = await key(
      { "*": "write" },
      { source: shownSource, edge_permissions: { "*": "write" } },
    );
    const hidden = await key(
      { "*": "write" },
      {
        source: "folder-directories-hidden",
        edge_permissions: { "*": "write" },
      },
    );
    const sourceDir = await folder();
    await placeItem(await item("core.note", shown), sourceDir, "a/shown.md");
    await placeItem(await item("core.note", shown), sourceDir, "a/b/shown.md");
    await placeItem(await item("core.note", hidden), sourceDir, "a/hidden.md");
    await placeItem(await item("core.note", hidden), sourceDir, "h/hidden.md");
    const filtered = await key(
      { "*": "read" },
      {
        enforcement_override: {
          source_filter: { types: ["core.note"], sources: [shownSource] },
        },
      },
    );
    const read = await tree(sourceDir, "", filtered);
    expect(rows(read)).toEqual([["a", 1, 2, true]]);
    expect(read.total_files).toBe(2);
    expect((await tree(sourceDir)).total_files).toBe(4);
  });

  it("refuses a key that cannot read the in-folder edge type", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    const blind = await key(
      { "*": "read" },
      { edge_permissions: { references: "read" } },
    );
    const refused = await call(
      "GET",
      `/folders/${dir}/directories`,
      undefined,
      blind,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "edge_type_not_permitted",
        details: { edge_type: "in-folder" },
      },
    });
    expect(
      (await call("GET", `/folders/${dir}/status`, undefined, blind)).status,
    ).toBe(200);
  });

  it("refuses as the status read refuses", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    const note = await item();
    const unauthorized = await fetch(
      `${server.apiUrl}/folders/${dir}/directories`,
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    const invalid = await call("GET", "/folders/not-an-id/directories");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_id" },
    });
    for (const target of [NO_SUCH_ID, note]) {
      const missing = await call("GET", `/folders/${target}/directories`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        error: { code: "item_not_found" },
      });
    }
    const noFolder = await key({ "core.note": "read" });
    const hidden = await call(
      "GET",
      `/folders/${dir}/directories`,
      undefined,
      noFolder,
    );
    const hiddenStatus = await call(
      "GET",
      `/folders/${dir}/status`,
      undefined,
      noFolder,
    );
    expect(hidden.status).toBe(404);
    expect(hiddenStatus.status).toBe(404);
    expect(await hidden.json()).toEqual(await hiddenStatus.json());
    const none = await key({});
    const forbidden = await call(
      "GET",
      `/folders/${dir}/directories`,
      undefined,
      none,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: "type_not_permitted" },
    });
  });

  it("reads the whole folder for the private local command", async () => {
    const dir = await folder();
    await placeAll(dir, SAMPLE);
    const local = await controlRequest(
      server.controlSocket,
      `/folders/${dir}/directories`,
    );
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({
      folder_id: dir,
      direct_files: 1,
      total_files: 8,
    });
    const missing = await controlRequest(
      server.controlSocket,
      `/folders/${NO_SUCH_ID}/directories`,
    );
    expect(missing.status).toBe(404);
  });
});
