import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  copyItemEvent,
  edgeType,
  refusal,
  SCRIPTED_EDGE_TYPES,
  wireItem,
} from "../../device/marfa-answers.js";
import { acceptUploads, folderHarness } from "./harness.js";
import {
  EdgeDoor,
  edit,
  idIn,
  put,
  scriptFolderWrites,
} from "./folders.shared.js";
import type { FolderHarness } from "./harness.js";
import type { Answer, RecordedRequest } from "../../device/scripted-server.js";
import type { WireItemOptions } from "../../device/marfa-answers.js";

let harness: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const beta = "01a00000-0000-7000-8000-00000000d01b";
const shelf = "01a00000-0000-7000-8000-00000000d01c";
const BINARY = "photo.png";

function titled(
  id: string,
  title: string,
  type = "core.note",
): WireItemOptions {
  return { id, type, properties: { title, body: `${title}\n` } };
}

/** A folder of notes and files whose defaults draw `shelved-in` to Beta, a
 *  note, which the edge type refuses until it is widened. */
async function defaultsHarness(
  label: string,
  options: { constraint?: () => string[]; edges?: EdgeDoor } = {},
) {
  const edges = options.edges ?? new EdgeDoor();
  const constraint = options.constraint ?? (() => ["*"]);
  const made = await folderHarness(label, {
    events: [edges.stream()],
    settings: {
      query: { types: ["core.note", "core.file"] },
      defaults: { edges: { "shelved-in": [beta] } },
    },
    rows: {
      "core.note": [
        { item: titled(beta, "Beta") },
        { item: titled(shelf, "Shelf", "core.collection") },
      ],
    },
    edgeTypes: (): Answer => ({
      kind: "json",
      status: 200,
      body: {
        data: [
          ...SCRIPTED_EDGE_TYPES,
          edgeType("shelved-in", { target_type_constraints: constraint() }),
        ],
        next_cursor: null,
      },
    }),
  });
  scriptFolderWrites(made, { edges });
  acceptUploads(made.server);
  expect((await made.folder.pull()).ok).toBe(true);
  return { made, edges };
}

function shelvedWrites(h: FolderHarness): number {
  return h.server.requests.filter(
    (request: RecordedRequest) =>
      request.method === "POST" &&
      request.pathname === "/edges" &&
      (JSON.parse(request.body) as { edge_type?: string }).edge_type ===
        "shelved-in",
  ).length;
}

async function statusOf(h: FolderHarness, path: string) {
  const status = await h.folder.status();
  expect(status.ok, JSON.stringify(status)).toBe(true);
  if (!status.ok) throw new Error("no status");
  const file = status.value.files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`no status for ${path}`);
  return file;
}

describe("folders: a refused default edge", () => {
  it("shows a default the copy refused for a document and a file, and makes it once the edge type admits it, the files unchanged", async () => {
    let widened = false;
    const built = await defaultsHarness("folder-default-refused-copy", {
      constraint: () => (widened ? ["*"] : ["core.collection"]),
    });
    harness = built.made;
    // A file that writes its own line is no blank, so it is refused nothing.
    put(
      harness,
      "Own.md",
      `---\ntitle: Own\nshelved-in: "[[Shelf]]"\n---\nown\n`,
    );
    put(harness, "Plain.md", "---\ntitle: Plain\n---\nplain\n");
    put(harness, BINARY, "not really a picture");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);

    for (const path of ["Plain.md", BINARY]) {
      const file = await statusOf(harness, path);
      expect(file.flag, `${path}: ${JSON.stringify(file)}`).toBe("refused");
      expect(file.reason).toContain("edge_constraint_violation");
      expect(file.reason).toContain("shelved-in");
      expect(file.reason).toContain(beta);
      // A document's file can write the line; a file item has no lines.
      expect(file.reason).toContain(
        path === BINARY
          ? "make that edge in an app"
          : "write that line in the file",
      );
      if (path === BINARY) expect(file.reason).not.toContain("in the file");
    }
    // The witness: the file that wrote its own line is held for nothing.
    expect((await statusOf(harness, "Own.md")).flag).toBeUndefined();
    // Asked again each scan, still refused, and sent nothing.
    expect((await harness.folder.push()).ok).toBe(true);
    expect((await statusOf(harness, "Plain.md")).flag).toBe("refused");
    expect(shelvedWrites(harness)).toBe(1);

    const bytes = (path: string) =>
      readFileSync(join(harness!.dir, path), "utf8");
    const before = [bytes("Plain.md"), bytes(BINARY)];
    widened = true;
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    for (const path of ["Plain.md", BINARY]) {
      expect(
        (await statusOf(harness, path)).flag,
        `${path} stayed refused after the edge type admitted the default`,
      ).toBeUndefined();
    }
    expect(shelvedWrites(harness)).toBe(3);
    // The folder writes the edge as a line, and nothing else of either file moves.
    expect(bytes("Plain.md")).toBe(
      before[0]?.replace("---\nplain", `shelved-in: ["[[Beta]]"]\n---\nplain`),
    );
    expect(bytes(BINARY)).toBe(before[1]);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(shelvedWrites(harness)).toBe(3);
  });

  it("lists a refused default in the plain text of the folder's status, which stays in step", async () => {
    const built = await defaultsHarness("folder-default-refused-text", {
      constraint: () => ["core.collection"],
    });
    harness = built.made;
    put(
      harness,
      "Own.md",
      `---\ntitle: Own\nshelved-in: "[[Shelf]]"\n---\nown\n`,
    );
    put(harness, "Plain.md", "---\ntitle: Plain\n---\nplain\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const file = await statusOf(harness, "Plain.md");
    expect(file.status).toBe("in_step");
    expect(file.flag).toBe("refused");
    const text = await harness.folder
      .device()
      .rootText(["folders", "status", harness.dir]);
    expect(text.ok, JSON.stringify(text)).toBe(true);
    if (!text.ok) return;
    const lines = text.value.split("\n");
    expect(lines[0]).toMatch(/file\(s\) in step$/);
    const listed = lines.filter((line) => line.startsWith("Plain.md:"));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain("in step");
    expect(listed[0]).toContain("edge_constraint_violation");
    expect(listed[0]).toContain("shelved-in");
    // The witness: a file with nothing to say is not listed.
    expect(lines.some((line) => line.startsWith("Own.md"))).toBe(false);
  });

  it("keeps a default the server refused, sends it again only after the file changes, and applies it once it is accepted", async () => {
    let refusing = true;
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      refusing && edge.edge_type === "shelved-in"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    const built = await defaultsHarness("folder-default-refused-server", {
      edges,
    });
    harness = built.made;
    put(harness, "Plain.md", "---\ntitle: Plain\n---\nplain\n");
    put(harness, BINARY, "not really a picture");
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the server was asked for both and refused both.
    expect(shelvedWrites(harness)).toBe(2);
    for (const path of ["Plain.md", BINARY]) {
      const file = await statusOf(harness, path);
      expect(file.flag, `${path}: ${JSON.stringify(file)}`).toBe("refused");
      expect(file.reason).toContain("edge_permission_denied");
      expect(file.reason).toContain("shelved-in");
    }

    // Nothing changed: the refusal is not sent again.
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await harness.folder.push()).ok).toBe(true);
    }
    expect(shelvedWrites(harness)).toBe(2);
    expect((await statusOf(harness, "Plain.md")).flag).toBe("refused");

    // The server would take it now, but only a changed file asks again.
    refusing = false;
    edit(harness, "Plain.md", "plain\n", "plain, edited\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(shelvedWrites(harness)).toBe(3);
    expect((await statusOf(harness, "Plain.md")).flag).toBeUndefined();
    expect((await statusOf(harness, BINARY)).flag).toBe("refused");
    expect(
      [...edges.edges.values()].filter(
        (edge) => edge.edge_type === "shelved-in",
      ).length,
      "the accepted default never reached the server",
    ).toBe(1);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(shelvedWrites(harness)).toBe(3);
  });

  it("clears when the person writes the line, and when the defaults stop naming the edge", async () => {
    const built = await defaultsHarness("folder-default-refused-cleared", {
      constraint: () => ["core.collection"],
    });
    harness = built.made;
    put(harness, "Line.md", "---\ntitle: Line\n---\nline\n");
    put(harness, "Settings.md", "---\ntitle: Settings\n---\nsettings\n");
    expect((await harness.folder.push()).ok).toBe(true);
    for (const path of ["Line.md", "Settings.md"]) {
      expect((await statusOf(harness, path)).flag).toBe("refused");
    }

    edit(
      harness,
      "Line.md",
      "title: Line\n",
      'title: Line\nshelved-in: "[[Shelf]]"\n',
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      (await statusOf(harness, "Line.md")).flag,
      "a default stayed refused after the file wrote its own line",
    ).toBeUndefined();
    expect((await statusOf(harness, "Settings.md")).flag).toBe("refused");

    harness.settings.settings = {
      ...harness.settings.settings,
      defaults: { edges: {} },
    };
    harness.settings.version = 2;
    expect((await harness.folder.hydrate()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      (await statusOf(harness, "Settings.md")).flag,
      "a default stayed refused after the defaults stopped naming it",
    ).toBeUndefined();
  });

  it("clears a default the person made as an edge themselves, for a document and a file", async () => {
    let refusing = true;
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      refusing && edge.edge_type === "shelved-in"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    const built = await defaultsHarness("folder-default-refused-made", {
      edges,
    });
    harness = built.made;
    put(harness, "Plain.md", "---\ntitle: Plain\n---\nplain\n");
    put(harness, BINARY, "not really a picture");
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness is the previous test: an edited file asks again, and a file
    // that is not edited stays refused, where no edge exists.
    expect(shelvedWrites(harness)).toBe(2);
    const sources = harness.server.requests
      .filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/edges" &&
          (JSON.parse(request.body) as { edge_type?: string }).edge_type ===
            "shelved-in",
      )
      .map(
        (request) =>
          (JSON.parse(request.body) as { source_id: string }).source_id,
      );
    expect(sources).toHaveLength(2);

    refusing = false;
    for (const [index, source] of sources.entries()) {
      const made = edges.create({
        id: `01a00000-0000-7000-8000-00000000e0${String(index)}0`,
        source_id: source,
        target_id: beta,
        edge_type: "shelved-in",
      });
      expect(made.kind === "json" && made.status, JSON.stringify(made)).toBe(
        201,
      );
    }
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    edit(harness, "Plain.md", "plain\n", "plain, edited\n");
    expect((await harness.folder.push()).ok).toBe(true);
    for (const path of ["Plain.md", BINARY]) {
      expect(
        (await statusOf(harness, path)).flag,
        `${path} stayed refused for an edge it already has`,
      ).toBeUndefined();
    }
    expect(
      shelvedWrites(harness),
      "a second create was sent for an edge the copy holds",
    ).toBe(2);
  });

  it("clears when the file's item is in the bin", async () => {
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      edge.edge_type === "shelved-in"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    const built = await defaultsHarness("folder-default-refused-binned", {
      edges,
    });
    harness = built.made;
    put(harness, "Plain.md", "---\ntitle: Plain\n---\nplain\n");
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the refusal stands while the item is not in the bin.
    expect((await statusOf(harness, "Plain.md")).flag).toBe("refused");
    const id = idIn(harness, "Plain.md");
    expect(id).toBeDefined();
    edges.events.push(
      copyItemEvent(
        String(edges.events.length + 2),
        "item.deleted",
        wireItem({
          id: id!,
          type: "core.note",
          properties: { title: "Plain", body: "plain\n" },
          state: "trashed",
          version: 2,
        }),
      ),
    );
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    const status = await harness.folder.status();
    expect(status.ok).toBe(true);
    expect(
      status.ok && status.value.files.find((file) => file.path === "Plain.md"),
      "a binned item's file still shows its default as refused",
    ).toBeUndefined();
  });
});
