import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  answers,
  copyItemEvent,
  copyReplay,
  edgeEvent,
  edgesPage,
  refusal,
  wireEdge,
  wireItem,
  writeAnswers,
  type WireEdgeOptions,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { SseFrame } from "../../device/scripted-server.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import {
  folderHarness,
  hashOf,
  scriptBlob,
  type FolderHarness,
} from "./harness.js";

let folder: FolderHarness | undefined;
afterEach(async () => {
  delete process.env.MARFA_TEST_FAULT;
  await folder?.stop();
  folder = undefined;
});
const id = (n: number) =>
  `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number, title: string, body = "body\n"): WireItemOptions => ({
  id: id(n),
  properties: { title, body },
});
const read = (name: string) => readFileSync(join(folder!.dir, name), "utf8");
const put = (name: string, text: string) => {
  mkdirSync(join(folder!.dir, name, ".."), { recursive: true });
  writeFileSync(join(folder!.dir, name), text);
};

async function seed(
  items: WireItemOptions[],
  edges: WireEdgeOptions[] = [],
  settings?: FolderSettings,
  paths: Record<string, string> = {},
) {
  const rows: Record<string, { item: WireItemOptions }[]> = {};
  for (const item of items)
    (rows[(item.type ?? "core.note").split(".").slice(0, 2).join(".")] ??=
      []).push({ item });
  const whole: Record<string, WireEdgeOptions[]> = {};
  for (const edge of edges)
    (whole[edge.edge_type ?? "references"] ??= []).push(edge);
  const frames: SseFrame[] = [];
  folder = await folderHarness("extra-c", {
    rows,
    edges: whole,
    settings,
    hydrate: false,
    events: [
      (request) =>
        copyReplay(
          String(frames.length + 1),
          frames.filter(
            (frame) =>
              Number(frame.id) > Number(request.headers["last-event-id"] ?? 0),
          ),
        ),
    ],
  });
  for (const [item, path] of Object.entries(paths))
    edges.push({
      id: id(800 + edges.length),
      source_id: item,
      target_id: folder.settings.id,
      edge_type: "in-folder",
      properties: { path },
    });
  const refresh = () => {
    for (const item of items) {
      const drawn: Record<string, { data: unknown[]; next_cursor: null }> = {};
      for (const edge of edges.filter((edge) => edge.source_id === item.id))
        (drawn[edge.edge_type ?? "references"] ??= {
          data: [],
          next_cursor: null,
        }).data.push(wireEdge(edge));
      item.edges = drawn;
    }
  };
  refresh();
  folder.server.copyAnswer("GET", /^\/items\/[^/]+$/, (request) => {
    const item = items.find((item) => request.pathname === `/items/${item.id}`);
    return item
      ? answers.updated(wireItem(item))
      : refusal(404, "item_not_found", "Item not found");
  });
  folder.server.copyAnswer("GET", /^\/items\/[^/]+\/edges$/, (request) =>
    edgesPage(
      edges
        .filter((edge) => edge.source_id === request.pathname.split("/")[2])
        .map(wireEdge),
    ),
  );
  folder.server.copyAnswer("GET", /^\/edges\/[^/]+$/, (request) => {
    const edge = edges.find((edge) => request.pathname === `/edges/${edge.id}`);
    return edge
      ? writeAnswers.edge(edge)
      : refusal(404, "edge_not_found", "Edge not found");
  });
  expect((await folder.folder.hydrate()).ok).toBe(true);
  return { frames, refresh };
}
async function queue() {
  const result = await folder!.folder.device().queue();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}
async function scan() {
  const result = await folder!.folder.scan();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}
async function pull() {
  const result = await folder!.folder.pull();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

describe("folder contract edge and identity boundaries", () => {
  it("keeps a shared edge target pinned until the last owning file releases it", async () => {
    const target = { ...note(3, "Target"), type: "core.bookmark" };
    await seed(
      [note(1, "One"), note(2, "Two"), target],
      [
        {
          id: id(101),
          source_id: id(1),
          target_id: id(3),
          edge_type: "references",
        },
        {
          id: id(102),
          source_id: id(2),
          target_id: id(3),
          edge_type: "references",
        },
      ],
    );
    await pull();
    const pinned = async () => {
      const status = await folder!.folder.device().status();
      return status.ok ? status.value.pinned : [];
    };
    expect(await pinned()).toContain(id(3));
    for (const name of ["One.md", "Two.md"]) {
      put(
        name,
        read(name).replace(/references:\n {2}- "\[\[Target\]\]"\n/, ""),
      );
      await scan();
      await pull();
      expect(await pinned()).toEqual(
        name === "One.md"
          ? expect.arrayContaining([id(3)])
          : expect.not.arrayContaining([id(3)]),
      );
    }
    expect(
      (await queue())
        .filter((write) => write.kind === "delete_edge")
        .map((write) => write.edge_id)
        .sort(),
    ).toEqual([id(101), id(102)]);
  });

  it("writes no line for a binary edge writer with no reverse name", async () => {
    const bytes = Buffer.from("image bytes\n");
    await seed(
      [
        note(1, "Host"),
        note(2, "Witness"),
        {
          id: id(3),
          type: "core.file",
          properties: { title: "photo.png", blob_ref: hashOf(bytes) },
        },
      ],
      [
        {
          id: id(101),
          source_id: id(3),
          target_id: id(1),
          edge_type: "references",
        },
        {
          id: id(102),
          source_id: id(2),
          target_id: id(1),
          edge_type: "references",
        },
      ],
      { search: { types: ["core.note", "core.file"] } },
    );
    scriptBlob(folder!.server, bytes);
    await pull();
    expect(read("Witness.md")).toContain('"[[Host]]"');
    expect(read("Host.md")).not.toContain("references:");
    expect(readFileSync(join(folder!.dir, "photo.png"))).toEqual(bytes);
  });

  it("resolves decorated IDs, frontmatter headings and equivalent names to one target", async () => {
    await seed([note(1, "Café")]);
    await pull();
    for (const [name, target] of [
      ["Alias", `${id(1)}|Shown`],
      ["Heading", `${id(1)}#Part`],
      ["Title", "Café#Part"],
    ])
      put(`${name}.md`, `---\nreferences: "[[${target}]]"\n---\nbody\n`);
    put(
      "Variants.md",
      `---\nreferences:\n  - "[[café]]"\n  - "[[CAFÉ]]"\n  - "[[${id(1)}]]"\n---\nbody\n`,
    );
    folder!.server.answer(
      "POST",
      "/items",
      refusal(503, "service_unavailable", "At rest"),
    );
    folder!.server.answer(
      "POST",
      "/edges",
      refusal(503, "service_unavailable", "At rest"),
    );
    const pushed = await folder!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.flagged).toEqual([]);
    const references = (await queue()).filter(
      (write) => write.kind === "create_edge" && write.target_id === id(1),
    );
    expect(references).toHaveLength(4);
    expect(read("Title.md")).toContain('"[[Café#Part]]"');
    expect(read("Alias.md")).toContain(`"[[${id(1)}|Shown]]"`);
  });

  it("leaves an invalid bare edge line untouched while a valid link queues its edge", async () => {
    await seed([note(1, "Target")]);
    await pull();
    put("Bare.md", "---\nreferences: Target\n---\nbody\n");
    put("Valid.md", `---\nreferences: "[[${id(1)}]]"\n---\nbody\n`);
    const before = read("Bare.md");
    const report = await scan();
    expect(report.flagged.map((entry) => [entry.path, entry.flag])).toEqual([
      ["Bare.md", "edges"],
    ]);
    expect(read("Bare.md")).toBe(before);
    expect(
      (await queue()).filter(
        (write) => write.kind === "create_edge" && write.target_id === id(1),
      ),
    ).toHaveLength(1);
  });

  it("resolves a held line when its trashed target is restored", async () => {
    const target = { ...note(1, "Target"), state: "trashed" };
    const { frames } = await seed([target]);
    put("Host.md", `---\nreferences: "[[${id(1)}]]"\n---\nbody\n`);
    const before = read("Host.md");
    expect((await scan()).flagged.map((entry) => entry.flag)).toContain(
      "edges",
    );
    expect(
      (await queue()).filter(
        (write) => write.kind === "create_edge" && write.target_id === id(1),
      ),
    ).toEqual([]);
    target.state = "active";
    target.version = 2;
    frames.push(copyItemEvent("2", "item.restored", wireItem(target)));
    expect((await folder!.folder.device().catchUp()).ok).toBe(true);
    expect((await scan()).flagged).toEqual([]);
    expect(
      (await queue()).filter(
        (write) => write.kind === "create_edge" && write.target_id === id(1),
      ),
    ).toHaveLength(1);
    expect(read("Host.md")).toBe(before);
  });

  it("ignores a body link to its own item while linking another item", async () => {
    await seed([note(1, "Self"), note(2, "Other")]);
    await pull();
    put(
      "Self.md",
      read("Self.md").replace("body\n", `[[${id(1)}]] [[${id(2)}]]\n`),
    );
    const report = await scan();
    expect(report.flagged).toEqual([]);
    const links = (await queue()).filter(
      (write) => write.kind === "create_edge" && write.item_id === id(1),
    );
    expect(links.map((write) => write.target_id)).toEqual([
      folder!.settings.id,
      id(2),
    ]);
  });

  it("uses path order when copied IDs have the same birth time and no binding", async () => {
    await seed([note(1, "Original")]);
    const body = `---\nmarfa_id: ${id(1)}\n---\nbody\n`;
    put("z.md", body);
    linkSync(join(folder!.dir, "z.md"), join(folder!.dir, "a.md"));
    expect(statSync(join(folder!.dir, "z.md")).birthtimeMs).toBe(
      statSync(join(folder!.dir, "a.md")).birthtimeMs,
    );
    const report = await scan();
    expect(report.created).toBe(1);
    const status = await folder!.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "a.md")?.item_id,
    ).toBe(id(1));
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "z.md")?.item_id,
    ).not.toBe(id(1));
  });

  it("keeps a copied file's own binding after it moves while its old ID has a keeper", async () => {
    await seed([note(1, "Original")]);
    await pull();
    copyFileSync(
      join(folder!.dir, "Original.md"),
      join(folder!.dir, "Copy.md"),
    );
    expect((await scan()).created).toBe(1);
    const first = await folder!.folder.status();
    if (!first.ok) throw new Error(first.refusal.raw);
    const copy = first.value.files.find(
      (file) => file.path === "Copy.md",
    )!.item_id;
    expect(copy).not.toBe(id(1));
    renameSync(join(folder!.dir, "Copy.md"), join(folder!.dir, "Moved.md"));
    const next = await scan();
    expect(next.created).toBe(0);
    const status = await folder!.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Moved.md")?.item_id,
    ).toBe(copy);
  });

  it("keeps the old path's replacement as the item after a copy-and-delete move", async () => {
    await seed([note(1, "Original")]);
    await pull();
    copyFileSync(
      join(folder!.dir, "Original.md"),
      join(folder!.dir, "Moved.md"),
    );
    rmSync(join(folder!.dir, "Original.md"));
    put("Original.md", "replacement body\n");
    expect((await scan()).created).toBe(1);
    const status = await folder!.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Original.md")?.item_id,
    ).toBe(id(1));
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Moved.md")?.item_id,
    ).not.toBe(id(1));
  });

  it("makes a raw file with different bytes at an unbound placement a new item", async () => {
    await seed([note(1, "Held"), note(2, "Witness")], [], undefined, {
      [id(1)]: "Held.txt",
      [id(2)]: "Witness.txt",
    });
    put("Held.txt", "different\n");
    put("Witness.txt", "body\n");
    expect((await scan()).created).toBe(1);
    const status = await folder!.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Witness.txt")?.item_id,
    ).toBe(id(2));
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Held.txt")?.item_id,
    ).not.toBe(id(1));
    expect(read("Held.txt")).toBe("different\n");
  });
});

describe("folder placement and file publication boundaries", () => {
  it("orders equal-time placement collisions by edge ID", async () => {
    const edges: WireEdgeOptions[] = [];
    await seed([note(1, "First"), note(2, "Second")], edges, undefined, {
      [id(2)]: "Shared.md",
      [id(1)]: "Shared.md",
    });
    const report = await pull();
    expect([report.written, report.beside]).toEqual([2, 1]);
    expect(read("Shared.md")).toContain(`marfa_id: ${id(2)}`);
    expect(read("Shared (2).md")).toContain(`marfa_id: ${id(1)}`);
  });

  it("keeps an unplaced file at its checked-out path instead of its title", async () => {
    await seed([note(1, "Title")]);
    put("Kept.md", `---\nmarfa_id: ${id(1)}\ntitle: Title\n---\nbody\n`);
    await scan();
    const placements = (await queue()).filter(
      (write) =>
        write.kind === "create_edge" && write.target_id === folder!.settings.id,
    );
    expect(placements).toHaveLength(1);
    expect((await folder!.folder.device().withdraw(placements[0].id)).ok).toBe(
      true,
    );
    const report = await pull();
    expect(report.unwritten).toBe(0);
    expect(read("Kept.md")).toContain(id(1));
    expect(existsSync(join(folder!.dir, "Title.md"))).toBe(false);
  });

  it("leaves both files intact when their remote placements swap", async () => {
    const edges: WireEdgeOptions[] = [];
    const { frames } = await seed(
      [note(1, "One"), note(2, "Two")],
      edges,
      undefined,
      { [id(1)]: "One.md", [id(2)]: "Two.md" },
    );
    await pull();
    const before = [read("One.md"), read("Two.md")];
    for (const [at, path] of ["Two.md", "One.md"].entries())
      frames.push(
        edgeEvent(
          String(at + 2),
          "edge.updated",
          wireEdge({ ...edges[at], version: 2, properties: { path } }),
        ),
      );
    expect((await folder!.folder.device().catchUp()).ok).toBe(true);
    const report = await pull();
    expect(report.unwritten).toBe(2);
    expect(report.flagged.map((entry) => entry.item).sort()).toEqual([
      id(1),
      id(2),
    ]);
    expect([read("One.md"), read("Two.md")]).toEqual(before);
  });

  it("keeps the old file when publishing a move fails and leaves emptied directories after success", async () => {
    const edges: WireEdgeOptions[] = [];
    const { frames } = await seed([note(1, "Moved")], edges, undefined, {
      [id(1)]: "Old/Moved.md",
    });
    await pull();
    const before = read("Old/Moved.md");
    const identity = statSync(join(folder!.dir, "Old/Moved.md")).ino;
    frames.push(
      edgeEvent(
        "2",
        "edge.updated",
        wireEdge({
          ...edges[0],
          version: 2,
          properties: { path: "New/Moved.md" },
        }),
      ),
    );
    expect((await folder!.folder.device().catchUp()).ok).toBe(true);
    process.env.MARFA_TEST_FAULT = "sync-failure=Moved.md";
    const failed = await pull();
    delete process.env.MARFA_TEST_FAULT;
    expect(failed.unwritten).toBe(1);
    expect(read("Old/Moved.md")).toBe(before);
    expect(statSync(join(folder!.dir, "Old/Moved.md")).ino).toBe(identity);
    expect(existsSync(join(folder!.dir, "New/Moved.md"))).toBe(false);
    const success = await pull();
    expect(success.moved).toBe(1);
    expect(read("New/Moved.md")).toContain(id(1));
    expect(existsSync(join(folder!.dir, "Old/Moved.md"))).toBe(false);
    expect(statSync(join(folder!.dir, "Old")).isDirectory()).toBe(true);
  });

  it("preserves a replaced file's permission bits", async () => {
    const row = note(1, "Mode");
    const { frames } = await seed([row]);
    await pull();
    chmodSync(join(folder!.dir, "Mode.md"), 0o600);
    frames.push(
      copyItemEvent(
        "2",
        "item.updated",
        wireItem({
          ...row,
          version: 2,
          properties: { title: "Mode", body: "changed\n" },
        }),
      ),
    );
    expect((await folder!.folder.device().catchUp()).ok).toBe(true);
    expect((await pull()).rewritten).toBe(1);
    expect(read("Mode.md")).toContain("changed");
    expect(statSync(join(folder!.dir, "Mode.md")).mode & 0o777).toBe(0o600);
  });

  it("retains temporary files owned by a live process while cleaning an abandoned one", async () => {
    await seed([note(1, "Witness")]);
    await pull();
    const live = `.marfa-${String(process.pid)}-1.tmp`;
    const dead = ".marfa-2147483647-1.tmp";
    put(live, "live bytes\n");
    put(dead, "abandoned bytes\n");
    const report = await scan();
    expect(report.created).toBe(0);
    expect(read(live)).toBe("live bytes\n");
    expect(existsSync(join(folder!.dir, dead))).toBe(false);
  });

  it("fails an unsupported no-replace publication safely and succeeds once it is available", async () => {
    await seed([note(1, "Blocked"), note(2, "Witness")]);
    process.env.MARFA_TEST_FAULT = "rename-new-unsupported=Blocked.md";
    const failed = await pull();
    delete process.env.MARFA_TEST_FAULT;
    expect([failed.unwritten, failed.written]).toEqual([1, 1]);
    expect(failed.flagged.map((entry) => [entry.path, entry.flag])).toEqual([
      ["Blocked.md", "unwritten"],
    ]);
    expect(existsSync(join(folder!.dir, "Blocked.md"))).toBe(false);
    expect(read("Witness.md")).toContain(id(2));
    expect(
      readdirSync(folder!.dir).filter(
        (name) => name.startsWith(".marfa-") && name.endsWith(".tmp"),
      ),
    ).toEqual([]);
    const scanned = await scan();
    expect([scanned.created, scanned.updated, scanned.deleted]).toEqual([
      0, 0, 0,
    ]);
    expect((await pull()).written).toBe(1);
    expect(read("Blocked.md")).toContain(id(1));
    expect((await scan()).created).toBe(0);
  });
});

describe("body links and attachment presentation", () => {
  it("ignores embeds in list fences and indented code while reading a normal list paragraph", async () => {
    const bytes = Buffer.from("image\n");
    const names = ["live.png", "fenced.png", "indented.png", "quoted.png"];
    await seed(
      [
        note(1, "Host"),
        ...names.map((title, at): WireItemOptions => ({
          id: id(at + 2),
          type: "core.file",
          properties: { title, blob_ref: hashOf(bytes) },
        })),
      ],
      [],
      { search: { types: ["core.note", "core.file"] } },
    );
    scriptBlob(folder!.server, bytes);
    await pull();
    const body =
      "- ordinary ![](live.png)\n\n- list code:\n\n  ```\n  ![](fenced.png)\n  ```\n\nOutside the list.\n\n    ![](indented.png)\n\n> ```\n> ![](quoted.png)\n> ```\n";
    put("Host.md", read("Host.md").replace("body\n", body));
    expect((await scan()).embeds).toEqual([]);
    const attached = (await queue()).filter(
      (write) => write.kind === "create_edge" && write.target_id === id(1),
    );
    expect(attached.map((write) => write.item_id)).toEqual([id(2)]);
  });

  it("removes a redundant attachment line when the host body already embeds its file", async () => {
    const bytes = Buffer.from("image\n");
    const image: WireItemOptions = {
      id: id(2),
      type: "core.file",
      properties: { title: "pic.png", blob_ref: hashOf(bytes) },
    };
    const host = note(1, "Host", "![](pic.png)\n");
    const { frames } = await seed(
      [host, image],
      [
        {
          id: id(101),
          source_id: id(2),
          target_id: id(1),
          edge_type: "attached-to",
        },
      ],
      { search: { types: ["core.note", "core.file"] } },
    );
    scriptBlob(folder!.server, bytes);
    await pull();
    put(
      "Host.md",
      read("Host.md").replace("---\n", '---\nhas-attachment: "[[pic.png]]"\n'),
    );
    await scan();
    frames.push(
      copyItemEvent(
        "2",
        "item.updated",
        wireItem({
          ...host,
          version: 2,
          properties: { ...host.properties, body: "![](pic.png)\nchanged\n" },
        }),
      ),
    );
    expect((await folder!.folder.device().catchUp()).ok).toBe(true);
    await pull();
    expect(read("Host.md")).toContain("changed");
    expect(read("Host.md")).not.toContain("has-attachment:");
    expect(
      (await queue()).filter(
        (write) => write.kind === "create_edge" && write.target_id === id(1),
      ),
    ).toEqual([]);
  });
});

describe("folder credential and upload boundaries", () => {
  it("accepts a non-key credential when the current-key door answers forbidden", async () => {
    folder = await folderHarness("extra-c-not-key", {
      key: [refusal(403, "forbidden", "The credential is not an API key")],
      hydrate: false,
    });
    expect(
      folder.server.requests.filter(
        (request) => request.pathname === "/keys/current",
      ),
    ).toHaveLength(1);
    expect(existsSync(join(folder.dir, ".marfa"))).toBe(true);
  });

  it("sends an embedded file to the server for its upload limit decision", async () => {
    const bytes = Buffer.alloc(1024 * 1024, 0x61);
    await seed([note(1, "Host", "![](large.bin)\n")], [], undefined, {
      [id(1)]: "Host.md",
    });
    await pull();
    writeFileSync(join(folder!.dir, "large.bin"), bytes);
    folder!.server.answer(
      "POST",
      "/blobs",
      refusal(413, "request_too_large", "Upload exceeds this server's limit"),
    );
    const pushed = await folder!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const uploads = folder!.server.requests.filter(
      (request) => request.pathname === "/blobs" && request.method === "POST",
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0].raw).toEqual(bytes);
    expect(
      pushed.value.drain.verdicts.some(
        (verdict) => verdict.verdict === "refused",
      ),
    ).toBe(true);
    expect(readFileSync(join(folder!.dir, "large.bin"))).toEqual(bytes);
  });
});

describe("folder catalog refresh boundaries", () => {
  it("reads the edge catalog at add, hydration and catch-up", async () => {
    folder = await folderHarness("extra-c-catalog", { hydrate: false });
    const reads = () =>
      folder!.server.requests.filter(
        (request) => request.pathname === "/edge-types",
      ).length;
    const added = reads();
    expect(added).toBeGreaterThan(0);
    expect((await folder.folder.hydrate()).ok).toBe(true);
    const hydrated = reads();
    expect(hydrated).toBeGreaterThan(added);
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    expect(reads()).toBeGreaterThan(hydrated);
  });
});

describe("binary placement identity", () => {
  it("makes a binary file with different bytes at an unbound placement a new item", async () => {
    const bytes = Buffer.from("expected bytes\n");
    const items = [1, 2].map((number): WireItemOptions => ({
      id: id(number),
      type: "core.file",
      properties: {
        title: `File${String(number)}.bin`,
        blob_ref: hashOf(bytes),
      },
    }));
    await seed(
      items,
      [],
      { search: { types: ["core.file"] } },
      { [id(1)]: "Different.bin", [id(2)]: "Witness.bin" },
    );
    put("Different.bin", "different bytes\n");
    writeFileSync(join(folder!.dir, "Witness.bin"), bytes);
    expect((await scan()).created).toBe(1);
    const status = await folder!.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Witness.bin")?.item_id,
    ).toBe(id(2));
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Different.bin")
          ?.item_id,
    ).not.toBe(id(1));
    expect(read("Different.bin")).toBe("different bytes\n");
  });
});
