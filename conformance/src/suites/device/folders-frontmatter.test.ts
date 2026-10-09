import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  answers,
  edgeEvent,
  edgeType,
  copyHeadRead,
  copyItemEvent,
  itemsPage,
  copyLiveReplay,
  refusal,
  copyReplay,
  SCRIPTED_EDGE_TYPES,
  wireEdge,
  wireItem,
  SCRIPTED_TYPES,
  wireType,
} from "../../device/marfa-answers.js";
import { acceptUploads, folderHarness, hashOf, scriptBlob } from "./harness.js";
import { CliFolder, type FolderSettings } from "../../device/cli-adapter.js";
import { FolderDoor } from "../../device/folder-door.js";
import type { FolderHarness } from "./harness.js";
import type { Answer, Responder } from "../../device/scripted-server.js";
import type {
  WireEdgeOptions,
  WireItemOptions,
} from "../../device/marfa-answers.js";
import {
  EdgeDoor,
  bodyOf,
  edit,
  frontOf,
  heldEdges,
  put,
  read,
  scriptFolderWrites,
  sentCreates,
  sentEdgeWrites,
  sentTitles,
  sentUpdates,
  withoutPlacements,
} from "./folders.shared.js";

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await second?.stop();
  harness = undefined;
  second = undefined;
});

/** A row the hydration serves, with the edges it draws hydrated onto it. */
function edgeRows(
  items: WireItemOptions[],
  edges: WireEdgeOptions[],
): Record<string, Array<{ item: WireItemOptions }>> {
  const rows: Record<string, Array<{ item: WireItemOptions }>> = {};
  for (const item of items) {
    const drawn: Record<string, { data: unknown[]; next_cursor: null }> = {};
    for (const edge of edges.filter((held) => held.source_id === item.id)) {
      const type = edge.edge_type ?? "references";
      (drawn[type] ??= { data: [], next_cursor: null }).data.push(
        wireEdge(edge),
      );
    }
    // Under the type a hydration asks for, whose subtree it holds.
    const asked = (item.type ?? "core.note").split(".").slice(0, 2).join(".");
    (rows[asked] ??= []).push({
      item: { ...item, edges: drawn },
    });
  }
  return rows;
}

/** A note titled `title`, its body the title. */
function titled(
  id: string,
  title: string,
  type = "core.note",
): WireItemOptions {
  return { id, type, properties: { title, body: `${title}\n` } };
}

/** A folder whose server holds `items` and `edges` wherever the real one
 *  would serve them: on the source's row, listed whole, and at the edge door. */
async function edgeHarness(
  label: string,
  items: WireItemOptions[],
  edges: WireEdgeOptions[],
  options: {
    settings?: FolderSettings;
    events?: Responder[];
    lookup?: (text: string) => Answer | undefined;
    /** Handed the item door, for a fixture that answers one of its writes. */
    door?: (door: FolderDoor) => void;
  } = {},
): Promise<{ harness: FolderHarness; door: EdgeDoor }> {
  const whole = (type: string) =>
    edges.filter((edge) => edge.edge_type === type);
  const made = await folderHarness(label, {
    settings: options.settings,
    rows: edgeRows(items, edges),
    edges: {
      "parent-of": whole("parent-of"),
      "attached-to": whole("attached-to"),
    },
    events: options.events,
    lookup: options.lookup,
  });
  const door = new EdgeDoor();
  for (const edge of edges) door.hold(edge);
  scriptFolderWrites(made, { edges: door, door: options.door });
  return { harness: made, door };
}

describe("edges in frontmatter", () => {
  const project = "01a00000-0000-7000-8000-00000000e101";
  const child = "01a00000-0000-7000-8000-00000000e102";
  const other = "01a00000-0000-7000-8000-00000000e103";
  const alpha = "01a00000-0000-7000-8000-00000000e104";
  const beta = "01a00000-0000-7000-8000-00000000e105";
  const gamma = "01a00000-0000-7000-8000-00000000e106";
  const third = "01a00000-0000-7000-8000-00000000e10a";

  it("writes an edge in one file only", async () => {
    const made = await edgeHarness(
      "folder-edge-one-file",
      [titled(alpha, "Alpha"), titled(beta, "Beta")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e1",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      frontOf(harness, "Alpha.md"),
      "the edge is not a line in its source's frontmatter",
    ).toContain('about:\n  - "[[Beta]]"');
    expect(
      bodyOf(harness, "Alpha.md"),
      "the edge was written into the body as well as, or instead of, the frontmatter",
    ).not.toContain("[[Beta]]");
    expect(
      read(harness, "Beta.md"),
      "the edge was written in its target's file too, so one edge is in two files",
    ).not.toContain("Alpha");

    // Read back, both files change nothing.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
  });

  it("writes parent-of as child-of in the child", async () => {
    const made = await edgeHarness(
      "folder-edge-child-of",
      [titled(project, "Project"), titled(child, "Child")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e2",
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
        },
      ],
    );
    harness = made.harness;
    expect(
      [
        ...new Set(
          harness.server.requests
            .filter((request) => request.pathname === "/edges")
            .map((request) => request.query.get("edge_type")),
        ),
      ],
      "the copy held whole an edge type that neither a child's file nor a host's embeds need",
    ).toEqual(["attached-to", "parent-of"]);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      frontOf(harness, "Child.md"),
      "the child's file does not name its parent under the reverse name",
    ).toContain('child-of: "[[Project]]"');
    expect(
      read(harness, "Project.md"),
      "the parent's file lists its child, so a parent-of edge is written at the end its type does not name",
    ).not.toMatch(/parent-of|\[\[Child\]\]/);

    // A new child's file names its parent the same way.
    put(harness, "Second.md", '---\nchild-of: "[[Project]]"\n---\nanother\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [created] = sentCreates(harness);
    expect(
      sentEdgeWrites(harness),
      "a child-of line did not become the parent's parent-of edge",
    ).toEqual([`create ${project} parent-of ${String(created?.id)}`]);
  });

  it("writes attached-to in the attachment's file, and has-attachment in an image's host", async () => {
    const host = "01a00000-0000-7000-8000-00000000e111";
    const log = "01a00000-0000-7000-8000-00000000e112";
    const image = "01a00000-0000-7000-8000-00000000e113";
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2,
    ]);
    const made = await edgeHarness(
      "folder-edge-attachments",
      [
        titled(host, "Host"),
        titled(log, "Log"),
        {
          id: image,
          type: "core.file.image",
          properties: {
            title: "picture.png",
            blob_ref: hashOf(bytes),
            mime_type: "image/png",
          },
        },
      ],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e3",
          source_id: log,
          target_id: host,
          edge_type: "attached-to",
        },
        {
          id: "01a00000-0000-7000-8000-00000000e1e4",
          source_id: image,
          target_id: host,
          edge_type: "attached-to",
        },
      ],
      {
        settings: {
          search: { types: ["core.note", "core.file"] },
          defaults: { type: "core.note" },
        },
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, bytes);
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      frontOf(harness, "Log.md"),
      "an attachment that carries frontmatter does not say what it is attached to",
    ).toContain('attached-to:\n  - "[[Host]]"');
    expect(
      frontOf(harness, "Host.md"),
      "the host of an image does not name it, so an attachment that cannot carry frontmatter is written nowhere",
    ).toContain('has-attachment:\n  - "[[picture.png]]"');
    expect(
      read(harness, "Host.md"),
      "the host names an attachment whose own file already writes the edge",
    ).not.toContain("Log");
  });

  it("resolves a target written by id", async () => {
    // A bookmark this folder of notes does not hold, so only its id, which
    // the server answers for, names it.
    const made = await edgeHarness(
      "folder-edge-by-id",
      [titled(alpha, "Alpha"), titled(gamma, "Kept", "core.bookmark")],
      [],
    );
    harness = made.harness;
    put(harness, "New.md", `---\nabout: "[[${gamma}]]"\n---\nnew\n`);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [created] = sentCreates(harness);
    expect(
      sentEdgeWrites(harness),
      "a line naming its target by id made no edge to it",
    ).toEqual([`create ${String(created?.id)} about ${gamma}`]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
  });

  it("writes the id form where a name is repeated", async () => {
    const twin = "01a00000-0000-7000-8000-00000000e107";
    const made = await edgeHarness(
      "folder-edge-id-form",
      [titled(alpha, "Alpha"), titled(beta, "Same"), titled(twin, "Same")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e5",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      frontOf(harness, "Alpha.md"),
      "a target whose title another item shares was written by that title, which names two items",
    ).toContain(`about:\n  - "[[${beta}]]"`);

    // And it reads back as the item it names.
    edit(harness, "Alpha.md", "Alpha\n", "Alpha, edited\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
  });

  it("removes the edge whose line was taken out", async () => {
    const edge = "01a00000-0000-7000-8000-00000000e1e6";
    const made = await edgeHarness(
      "folder-edge-line-removed",
      [titled(alpha, "Alpha"), titled(beta, "Beta"), titled(gamma, "Gamma")],
      [
        { id: edge, source_id: alpha, target_id: beta, edge_type: "about" },
        {
          id: "01a00000-0000-7000-8000-00000000e1e7",
          source_id: alpha,
          target_id: gamma,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    edit(harness, "Alpha.md", '  - "[[Beta]]"\n', "");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "taking a line out left its edge, or took another with it",
    ).toEqual([`delete ${edge}`]);
    expect(heldEdges(made.door)).toEqual([`${alpha} about ${gamma}`]);
    expect(
      sentUpdates(harness),
      "a line taken out was sent as an edit of the item, when it changes only an edge",
    ).toEqual([]);
  });

  it("changes no edge of a type whose target it cannot resolve", async () => {
    const edge = "01a00000-0000-7000-8000-00000000e1e8";
    const made = await edgeHarness(
      "folder-edge-stand-down",
      [titled(alpha, "Alpha"), titled(beta, "Beta"), titled(gamma, "Gamma")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e9",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
        { id: edge, source_id: alpha, target_id: gamma, edge_type: "about" },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    // Gamma taken out beside a name that matches nothing, and a line of
    // another type that does resolve.
    edit(
      harness,
      "Alpha.md",
      /about:\n(?: {2}- .*\n)+/,
      'about:\n  - "[[Beta]]"\n  - "[[Nowhere]]"\nreferences: "[[Beta]]"\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a name that resolves to nothing was not flagged",
    ).toEqual([["Alpha.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("[[Nowhere]]");
    expect(
      sentEdgeWrites(harness),
      "an edge type with a name it cannot resolve changed anyway, or a type beside it did not",
    ).toEqual([`create ${alpha} references ${beta}`]);
    expect(
      read(harness, "Alpha.md"),
      "the pull wrote over a file whose line it could not resolve",
    ).toContain("[[Nowhere]]");

    // The witness: without the name, the same removal lands.
    edit(harness, "Alpha.md", '  - "[[Nowhere]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness).at(-1)).toBe(`delete ${edge}`);
  });

  it("writes and reads back by title a link to an item with no file on this Mac", async () => {
    // A bookmark a folder of notes does not hold: it has no file here.
    const made = await edgeHarness(
      "folder-edge-no-file",
      [
        titled(alpha, "Alpha"),
        titled(gamma, "Kept elsewhere", "core.bookmark"),
      ],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1ea",
          source_id: alpha,
          target_id: gamma,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(existsSync(join(harness.dir, "Kept elsewhere.md"))).toBe(false);
    expect(
      frontOf(harness, "Alpha.md"),
      "an edge to an item with no file on this Mac was not written, or not by its title",
    ).toContain('about:\n  - "[[Kept elsewhere]]"');

    edit(harness, "Alpha.md", "Alpha\n", "Alpha, edited\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "a line naming its target by title did not read back as that target",
    ).toEqual([]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
  });

  it("flags an ambiguous name and leaves it as typed", async () => {
    // One Twin in this folder and one only the server holds: the copy alone
    // would read the name as the first.
    const twin = "01a00000-0000-7000-8000-00000000e108";
    const made = await edgeHarness(
      "folder-edge-ambiguous",
      [titled(beta, "Twin"), titled(twin, "twin", "core.bookmark")],
      [],
    );
    harness = made.harness;
    const text = '---\nabout: "[[Twin]]"\n---\nwhich one\n';
    put(harness, "New.md", text);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a name two items answer to was not flagged",
    ).toEqual([["New.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("more than one");
    expect(
      sentEdgeWrites(harness),
      "a name two items answer to was guessed",
    ).toEqual([]);
    expect(read(harness, "New.md"), "the file was not left as typed").toBe(
      text,
    );
    expect(
      harness.server.requests.some(
        (request) =>
          request.pathname === "/items" &&
          (request.query.get("filter") ?? "").includes('contains "Twin"'),
      ),
      "the server was not asked for the name",
    ).toBe(true);

    // The witness: the id form names one of the two, and the edge is made.
    edit(harness, "New.md", "[[Twin]]", `[[${twin}]]`);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${String(sentCreates(harness)[0]?.id)} about ${twin}`,
    ]);
  });

  it("flags an unmatched name and leaves it as typed", async () => {
    const made = await edgeHarness(
      "folder-edge-unmatched",
      [titled(alpha, "Alpha")],
      [],
    );
    harness = made.harness;
    const text = '---\nabout: "[[Nobody]]"\n---\nnamed\n';
    put(harness, "New.md", text);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a name nothing answers to was not flagged",
    ).toEqual([["New.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("matches no item");
    expect(sentEdgeWrites(harness)).toEqual([]);
    expect(read(harness, "New.md"), "the file was not left as typed").toBe(
      text,
    );

    // The witness: a name that matches makes the edge.
    edit(harness, "New.md", "[[Nobody]]", "[[Alpha]]");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${String(sentCreates(harness)[0]?.id)} about ${alpha}`,
    ]);
  });

  it("leaves an existing link unchanged when a same-named item appears", async () => {
    const newcomer = "01a00000-0000-7000-8000-00000000e109";
    let appeared: Record<string, unknown> = {};
    const made = await edgeHarness(
      "folder-edge-stable",
      [titled(alpha, "Alpha"), titled(beta, "Beta")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1eb",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
      ],
      {
        events: [
          (): Answer =>
            copyReplay("2", [copyItemEvent("2", "item.created", appeared)]),
          copyHeadRead("3"),
        ],
      },
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(frontOf(harness, "Alpha.md")).toContain('about:\n  - "[[Beta]]"');

    // Another Beta arrives; then the person edits the file naming the first.
    appeared = wireItem(titled(newcomer, "Beta"));
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      existsSync(join(harness.dir, "Beta (2).md")),
      "the second Beta never reached the folder, so nothing here shares the name",
    ).toBe(true);
    edit(harness, "Alpha.md", "Alpha\n", "Alpha, edited\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentEdgeWrites(harness),
      "an edge moved because another item took its target's name",
    ).toEqual([]);
    expect(pushed.value.scan.flagged).toEqual([]);
    expect(
      frontOf(harness, "Alpha.md"),
      "a line that still names its item was not left as typed",
    ).toContain('about:\n  - "[[Beta]]"');
  });

  it("flags a reverse-named edge stated at the wrong end, and changes nothing", async () => {
    const made = await edgeHarness(
      "folder-edge-wrong-end",
      [titled(project, "Project"), titled(child, "Child")],
      [],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    const childBefore = read(harness, "Child.md");
    edit(
      harness,
      "Project.md",
      /marfa_id:/,
      'parent-of: "[[Child]]"\nmarfa_id:',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a parent-of line in the parent's file was not flagged",
    ).toEqual([["Project.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("child-of");
    expect(
      sentEdgeWrites(harness),
      "a line at the wrong end made an edge",
    ).toEqual([]);
    expect(sentUpdates(harness)).toEqual([]);
    expect(
      read(harness, "Child.md"),
      "the other end's file was rewritten for a line it does not carry",
    ).toBe(childBefore);

    // The witness: the same edge, stated at its end, is made.
    edit(
      harness,
      "Child.md",
      /marfa_id:/,
      'child-of: "[[Project]]"\nmarfa_id:',
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${project} parent-of ${child}`,
    ]);
  });

  it("learns an edge type the server registers, and reads its line as an edge", async () => {
    let registered = false;
    let later = false;
    const catalog = (): Answer => ({
      kind: "json",
      status: 200,
      body: {
        data: [
          ...SCRIPTED_EDGE_TYPES,
          ...(registered
            ? [
                edgeType("cites"),
                edgeType("mentor-of", {
                  cardinality: "one-to-many",
                  reverse_name: "mentored-by",
                  written_at: "target",
                }),
              ]
            : []),
          ...(later
            ? [
                edgeType("sponsor-of", {
                  cardinality: "one-to-many",
                  reverse_name: "sponsored-by",
                  written_at: "target",
                }),
              ]
            : []),
        ],
        next_cursor: null,
      },
    });
    harness = await folderHarness("folder-edge-registered", {
      rows: edgeRows([titled(alpha, "Alpha"), titled(beta, "Beta")], []),
      edgeTypes: catalog,
    });
    const door = new EdgeDoor();
    scriptFolderWrites(harness, { edges: door });
    expect((await harness.folder.pull()).ok).toBe(true);

    // Registered after the folder read its list.
    registered = true;
    put(harness, "New.md", '---\ncites: "[[Beta]]"\n---\nciting\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const [created] = sentCreates(harness);
    expect(
      Object.keys((created?.properties ?? {}) as Record<string, unknown>),
      "a line for a type the server registered went up as a property",
    ).not.toContain("cites");
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${String(created?.id)} cites ${beta}`,
    ]);
    expect(
      pushed.value.catch_up.hydrated,
      "a type written at its target, registered since, did not bring a hydration that holds it whole",
    ).not.toBeNull();
    expect(
      harness.server.requests.some(
        (request) =>
          request.pathname === "/edges" &&
          request.query.get("edge_type") === "mentor-of",
      ),
    ).toBe(true);

    // Registered with no file changed: the catch-up reads it, and holds it.
    later = true;
    const quiet = await harness.folder.push();
    expect(quiet.ok, JSON.stringify(quiet)).toBe(true);
    if (!quiet.ok) return;
    expect(
      quiet.value.catch_up.hydrated,
      "a type registered while no file changed was never read",
    ).not.toBeNull();
  });

  it("flags only the file whose name cannot be looked up, and goes on with the rest", async () => {
    const back = "01a00000-0000-7000-8000-00000000e10b";
    harness = await folderHarness("folder-edge-lookup-fails", {
      rows: edgeRows(
        [titled(alpha, "Alpha"), titled(back, "Back\\", "core.bookmark")],
        [],
      ),
      lookup: (text) =>
        text === "Denied"
          ? refusal(403, "forbidden", "This key may not list here")
          : undefined,
    });
    scriptFolderWrites(harness);
    // YAML reads `\\` in a quoted string as one backslash.
    put(harness, "One.md", '---\nabout: "[[Back\\\\]]"\n---\none\n');
    put(harness, "Two.md", '---\nabout: "[[Alpha]]"\n---\ntwo\n');
    put(harness, "Three.md", '---\nabout: "[[Denied]]"\n---\nthree\n');
    const pushed = await harness.folder.push();
    expect(
      pushed.ok,
      `a lookup the server could not answer ended the push: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    if (!pushed.ok) return;
    const id = (title: string) =>
      String(
        sentCreates(harness!).find(
          (sent) =>
            (sent.properties as Record<string, unknown>).title === title,
        )?.id,
      );
    expect(sentEdgeWrites(harness).sort()).toEqual(
      [
        `create ${id("One")} about ${back}`,
        `create ${id("Two")} about ${alpha}`,
      ].sort(),
    );
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
    ).toEqual([["Three.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("forbidden");
    expect(
      frontOf(harness, "Two.md"),
      "a line that made its edge was erased by the pull",
    ).toContain("[[Alpha]]");

    // A refusal is an answer: it is not asked again until the file changes.
    const asked = () =>
      harness!.server.requests.filter((request) =>
        (request.query.get("filter") ?? "").includes('"Denied"'),
      ).length;
    const before = asked();
    expect((await harness.folder.push()).ok).toBe(true);
    expect(asked()).toBe(before);
  });

  it("flags a new target for an end whose edge the file never showed, and deletes nothing", async () => {
    const parentEdge = {
      id: "01a00000-0000-7000-8000-00000000e1ed",
      source_id: project,
      target_id: child,
      edge_type: "parent-of",
    };
    harness = await folderHarness("folder-edge-unshown", {
      rows: edgeRows(
        [titled(project, "One"), titled(other, "Two"), titled(child, "Child")],
        [],
      ),
      events: [
        (): Answer =>
          copyReplay("2", [
            edgeEvent("2", "edge.created", wireEdge(parentEdge)),
          ]),
        copyHeadRead("3"),
      ],
    });
    const door = new EdgeDoor();
    scriptFolderWrites(harness, { edges: door });
    expect((await harness.folder.pull()).ok).toBe(true);
    // Another machine gives the child a parent; no pull has shown it.
    door.hold(parentEdge);
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    edit(harness, "Child.md", /marfa_id:/, 'child-of: "[[Two]]"\nmarfa_id:');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a second parent was not flagged",
    ).toEqual([["Child.md", "edges"]]);
    expect(
      sentEdgeWrites(harness),
      "a parent the file never showed was replaced unseen",
    ).toEqual([]);
    expect(heldEdges(door)).toEqual([`${project} parent-of ${child}`]);

    // The witness: once the file shows the parent, the same change replaces it.
    edit(harness, "Child.md", 'child-of: "[[Two]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(frontOf(harness, "Child.md")).toContain('child-of: "[[One]]"');
    edit(harness, "Child.md", "[[One]]", "[[Two]]");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(door)).toEqual([`${other} parent-of ${child}`]);
  });

  it("keeps a typed has-attachment to an image the copy does not hold", async () => {
    const image = "01a00000-0000-7000-8000-00000000e10c";
    const made = await edgeHarness(
      "folder-edge-typed-attachment",
      [
        titled(alpha, "Host"),
        {
          id: image,
          type: "core.file.image",
          properties: {
            title: "picture.png",
            blob_ref: hashOf(Buffer.from("a picture")),
            mime_type: "image/png",
          },
        },
      ],
      [],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    edit(
      harness,
      "Host.md",
      /marfa_id:/,
      'has-attachment: "[[picture.png]]"\nmarfa_id:',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(heldEdges(made.door)).toEqual([`${image} attached-to ${alpha}`]);
    expect(
      frontOf(harness, "Host.md"),
      "the pull erased a line whose edge it made, so the edge is shown in no file",
    ).toContain("has-attachment");
    expect(existsSync(join(harness.dir, "picture.png"))).toBe(false);
  });

  it("resolves a name by its file's name, and keeps it as typed", async () => {
    const made = await edgeHarness(
      "folder-edge-file-name",
      [titled(alpha, "Alpha")],
      [],
    );
    harness = made.harness;
    put(harness, "notes/g-file.md", "---\ntitle: Different\n---\nnamed so\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const target = String(sentCreates(harness)[0]?.id);
    put(harness, "New.md", '---\nabout: "[[g-file]]"\n---\nby its file\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "a name matching a file here, and no title, was not read as that file's item",
    ).toEqual([
      `create ${String(sentCreates(harness)[1]?.id)} about ${target}`,
    ]);
    expect(
      frontOf(harness, "New.md"),
      "the pull wrote the target's title over the file name the person typed",
    ).toContain('"[[g-file]]"');
  });

  it("resolves body links by title and nested filename without repeating references on pull", async () => {
    const made = await edgeHarness("folder-body-names", [], []);
    harness = made.harness;
    put(
      harness,
      "projects/file-name.md",
      "---\ntitle: A different title\n---\ntarget\n",
    );
    put(
      harness,
      "Source.md",
      "---\ntitle: Source\n---\n[[file-name#Heading|shown]] [[A different title]] [[projects/file-name.md#Heading]] [[#local]]\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.flagged).toEqual([]);
    const creates = sentCreates(harness);
    const target = String(
      creates.find(
        (row) =>
          (row.properties as Record<string, unknown>).title ===
          "A different title",
      )?.id,
    );
    const source = String(
      creates.find(
        (row) => (row.properties as Record<string, unknown>).title === "Source",
      )?.id,
    );
    expect(heldEdges(made.door)).toEqual([`${source} references ${target}`]);
    expect(frontOf(harness, "Source.md")).not.toContain("references:");
    expect(bodyOf(harness, "Source.md")).toContain(
      "[[file-name#Heading|shown]]",
    );
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(frontOf(harness, "Source.md")).not.toContain("references:");
    edit(harness, "Source.md", bodyOf(harness, "Source.md"), "links removed\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(made.door)).toEqual([]);
  });

  it("reports missing body links and preserves removals until all links resolve", async () => {
    const made = await edgeHarness(
      "folder-body-missing",
      [titled(alpha, "Alpha"), titled(beta, "Beta")],
      [],
    );
    harness = made.harness;
    put(harness, "Source.md", "---\ntitle: Source\n---\n[[Alpha]] [[Beta]]\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(made.door)).toHaveLength(2);
    edit(harness, "Source.md", "[[Alpha]] [[Beta]]", "[[Alpha]] [[Nowhere]]");
    const missing = await harness.folder.push();
    expect(missing.ok, JSON.stringify(missing)).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.scan.flagged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "Source.md",
          flag: "edges",
          reason: expect.stringContaining(
            "[[Nowhere]] in its body matches no item",
          ),
        }),
      ]),
    );
    expect(heldEdges(made.door)).toHaveLength(2);
    expect(bodyOf(harness, "Source.md")).toContain("[[Nowhere]]");
    edit(harness, "Source.md", " [[Nowhere]]", "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(made.door)).toEqual([
      `${String(sentCreates(harness)[0]?.id)} references ${alpha}`,
    ]);
  });

  it("ignores body links in code and comments while sending visible links", async () => {
    const made = await edgeHarness(
      "folder-body-code",
      [titled(alpha, "Alpha"), titled(beta, "Beta")],
      [],
    );
    harness = made.harness;
    put(harness, "Source.md", "---\ntitle: Source\n---\n[[Alpha]] [[Beta]]\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(made.door)).toHaveLength(2);
    edit(
      harness,
      "Source.md",
      "[[Alpha]] [[Beta]]",
      "[[Alpha]] `[[Beta]]` <!-- [[Beta]] --> %% [[Beta]] %%\n```md\n[[Beta]]\n```\n~~~\n[[Beta]]\n~~~\n[[#local]]",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.flagged).toEqual([]);
    expect(heldEdges(made.door)).toEqual([
      `${String(sentCreates(harness)[0]?.id)} references ${alpha}`,
    ]);
    expect(frontOf(harness, "Source.md")).not.toContain("references:");
  });

  it.each([
    ["inline triple backticks", "```literal```\n[[Alpha]] `[[Beta]]`\n"],
    ["multiline code spans", "`first\n[[Beta]]\nlast`\n[[Alpha]]\n"],
    ["quoted fences", "> ```\n> [[Beta]]\n> ```\n\n[[Alpha]]\n"],
  ])(
    "keeps visible references and removes code-only references with %s",
    async (_name, body) => {
      const made = await edgeHarness(
        "folder-body-code-boundary",
        [titled(alpha, "Alpha"), titled(beta, "Beta")],
        [],
      );
      harness = made.harness;
      put(
        harness,
        "Source.md",
        "---\ntitle: Source\n---\n[[Alpha]] [[Beta]]\n",
      );
      expect((await harness.folder.push()).ok).toBe(true);
      expect(heldEdges(made.door)).toHaveLength(2);
      edit(harness, "Source.md", "[[Alpha]] [[Beta]]\n", body);
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (!pushed.ok) return;
      expect(pushed.value.scan.flagged).toEqual([]);
      expect(heldEdges(made.door)).toEqual([
        `${String(sentCreates(harness)[0]?.id)} references ${alpha}`,
      ]);
      expect(bodyOf(harness, "Source.md")).toBe(body);
    },
  );

  it("reports ambiguous body links including whole names with heading or alias marks", async () => {
    const made = await edgeHarness(
      "folder-body-ambiguous",
      [
        titled(alpha, "Shared"),
        titled(beta, "Shared"),
        titled(gamma, "C"),
        titled(third, "C# notes"),
        titled(project, "C|shown"),
      ],
      [],
    );
    harness = made.harness;
    put(
      harness,
      "Source.md",
      "---\ntitle: Source\n---\n[[Shared]] [[C# notes]] [[C|shown]]\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const reason =
      pushed.value.scan.flagged.find((row) => row.path === "Source.md")
        ?.reason ?? "";
    for (const raw of ["Shared", "C# notes", "C|shown"])
      expect(reason).toContain(
        `[[${raw}]] in its body matches more than one item`,
      );
    expect(sentEdgeWrites(harness)).toEqual([]);
    edit(
      harness,
      "Source.md",
      "[[Shared]] [[C# notes]] [[C|shown]]",
      `[[${alpha}]] [[${third}#Heading]]`,
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(made.door)).toHaveLength(2);
  });

  it("waits for body link lookups and retries them when the server returns", async () => {
    const made = await edgeHarness(
      "folder-body-waits",
      [titled(alpha, "Only on server", "core.bookmark")],
      [],
    );
    harness = made.harness;
    put(
      harness,
      "Source.md",
      "---\ntitle: Source\n---\n[[Only on server#Heading|shown]]\n",
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok && scanned.value.flagged[0]?.reason).toContain(
      "once the server can be asked",
    );
    await harness.server.offline();
    const offline = await harness.folder.push();
    await harness.server.online();
    expect(offline.ok, JSON.stringify(offline)).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
    const online = await harness.folder.push();
    expect(online.ok, JSON.stringify(online)).toBe(true);
    expect(heldEdges(made.door)).toEqual([
      `${String(sentCreates(harness)[0]?.id)} references ${alpha}`,
    ]);
    expect(frontOf(harness, "Source.md")).not.toContain("references:");
    edit(harness, "Source.md", "[[Only on server#Heading|shown]]", "gone");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(made.door)).toEqual([]);
  });

  it("does not choose between existing references answering to the same body name", async () => {
    const made = await edgeHarness(
      "folder-body-existing-ambiguous",
      [titled(alpha, "Alpha"), titled(beta, "Shared"), titled(gamma, "Shared")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1a1",
          source_id: alpha,
          target_id: beta,
          edge_type: "references",
        },
        {
          id: "01a00000-0000-7000-8000-00000000e1a2",
          source_id: alpha,
          target_id: gamma,
          edge_type: "references",
        },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(heldEdges(made.door)).toHaveLength(2);
    edit(harness, "Alpha.md", /references:[\s\S]*?(?=marfa_id:)/, "");
    edit(harness, "Alpha.md", "\n---\nAlpha\n", "\n---\n[[Shared]]\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.find((row) => row.path === "Alpha.md")?.reason,
      JSON.stringify(pushed),
    ).toContain("matches more than one item");
    expect(heldEdges(made.door)).toHaveLength(2);
  });

  it("flags a name more common than the lookup reads", async () => {
    let page = 0;
    harness = await folderHarness("folder-edge-common", {
      rows: edgeRows([titled(alpha, "Alpha")], []),
      lookup: (text) => {
        if (text !== "Common") return undefined;
        page += 1;
        return itemsPage([{ item: wireItem(titled(gamma, "Common one")) }], {
          nextCursor: `page-${String(page)}`,
        });
      },
    });
    scriptFolderWrites(harness);
    put(harness, "New.md", '---\nabout: "[[Common]]"\n---\nso common\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.flagged[0]?.reason).toContain("more than 5 pages");
    // Five pages for each property a title lives in: `title` and `text`.
    expect(page, "the lookup read past its cap").toBe(10);
    expect(sentEdgeWrites(harness)).toEqual([]);
  });

  it("counts an archived match only the server holds, and none in the bin", async () => {
    const filed = "01a00000-0000-7000-8000-00000000e10d";
    const binned = "01a00000-0000-7000-8000-00000000e10e";
    const made = await edgeHarness(
      "folder-edge-states",
      [
        titled(alpha, "Alpha"),
        { ...titled(filed, "Filed away", "core.bookmark"), state: "archived" },
        { ...titled(binned, "Binned", "core.bookmark"), state: "trashed" },
      ],
      [],
    );
    harness = made.harness;
    put(harness, "One.md", '---\nabout: "[[Filed away]]"\n---\none\n');
    put(harness, "Two.md", '---\nabout: "[[Binned]]"\n---\ntwo\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentEdgeWrites(harness),
      "an archived item only the server holds was not found, or one in the bin was",
    ).toEqual([`create ${String(sentCreates(harness)[0]?.id)} about ${filed}`]);
    expect(pushed.value.scan.flagged.map((file) => file.path)).toEqual([
      "Two.md",
    ]);
  });

  it("matches a title only in the property its type keeps it in", async () => {
    const highlight = "01a00000-0000-7000-8000-00000000e10f";
    const made = await edgeHarness(
      "folder-edge-title-field",
      [
        titled(beta, "Solo"),
        {
          id: highlight,
          type: "core.highlight",
          properties: { text: "a passage", title: "Solo", note: "n" },
        },
      ],
      [],
    );
    harness = made.harness;
    put(harness, "New.md", '---\nabout: "[[Solo]]"\n---\nwhich\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "a property named title on a type whose title lives elsewhere was read as its title",
    ).toEqual([`create ${String(sentCreates(harness)[0]?.id)} about ${beta}`]);
  });

  it("waits for the server to resolve a name, and resolves it at the next pass that reaches it", async () => {
    const made = await edgeHarness(
      "folder-edge-waits",
      [titled(alpha, "Alpha")],
      [],
    );
    harness = made.harness;
    put(harness, "New.md", '---\nabout: "[[Alpha]]"\n---\nsoon\n');
    const scanned = await harness.folder.scan();
    expect(scanned.ok && scanned.value.flagged[0]?.reason).toContain(
      "once the server can be asked",
    );
    await harness.server.offline();
    const offline = await harness.folder.push();
    await harness.server.online();
    expect(offline.ok, JSON.stringify(offline)).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
    const online = await harness.folder.push();
    expect(online.ok, JSON.stringify(online)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "a name that waited for the server was never asked again",
    ).toEqual([`create ${String(sentCreates(harness)[0]?.id)} about ${alpha}`]);
  });

  it("writes by id a title a link cannot hold", async () => {
    const made = await edgeHarness(
      "folder-edge-unlinkable",
      [titled(alpha, "Alpha"), titled(beta, "C# notes")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1f1",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      frontOf(harness, "Alpha.md"),
      "a title a link reads otherwise was written as a link",
    ).toContain(`"[[${beta}]]"`);
  });

  it("flags an in-folder line and a line naming its own item", async () => {
    const made = await edgeHarness(
      "folder-edge-own-item",
      [titled(alpha, "Alpha")],
      [],
    );
    harness = made.harness;
    put(
      harness,
      "New.md",
      '---\nin-folder: "[[Alpha]]"\nabout: "[[New]]"\n---\nitself\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const reason = pushed.value.scan.flagged[0]?.reason ?? "";
    expect(reason).toContain("in-folder line is not read");
    expect(reason).toContain("names this file's own item");
    expect(sentEdgeWrites(harness)).toEqual([]);
  });

  it("holds a file whose line's edge is refused, and says it beside a name it cannot resolve", async () => {
    const made = await edgeHarness(
      "folder-edge-both-flags",
      [titled(alpha, "Alpha"), titled(beta, "Beta")],
      [],
    );
    harness = made.harness;
    made.door.placing = (edge) =>
      edge.edge_type === "about"
        ? answers.edgePermissionDenied("about")
        : undefined;
    put(
      harness,
      "New.md",
      '---\nabout: "[[Beta]]"\nreferences: "[[Nowhere]]"\n---\ntwo ways\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.pull?.flagged
        .filter((file) => file.path === "New.md")
        .map((file) => file.flag)
        .sort(),
      "a refused edge, beside a name that resolves to nothing, was not both said",
    ).toEqual(["edges", "refused"]);
  });

  it("holds a pin while a line names its row, and lets go only a pin it made", async () => {
    const kept = "01a00000-0000-7000-8000-00000000e110";
    const manual = "01a00000-0000-7000-8000-00000000e111";
    let archived: Record<string, unknown> = {};
    const made = await edgeHarness(
      "folder-edge-pins",
      [
        titled(alpha, "Alpha"),
        titled(beta, "Beta"),
        titled(kept, "Kept", "core.bookmark"),
        titled(manual, "Manual", "core.bookmark"),
      ],
      [alpha, kept, manual, beta].slice(1).map((target, at) => ({
        id: `01a00000-0000-7000-8000-00000000e1f${String(at + 2)}`,
        source_id: alpha,
        target_id: target,
        edge_type: "about",
      })),
      {
        settings: { search: { types: ["core.note"], state: ["active"] } },
        events: [
          (): Answer =>
            copyReplay("2", [copyItemEvent("2", "item.updated", archived)]),
          copyHeadRead("3"),
        ],
      },
    );
    harness = made.harness;
    const device = harness.folder.device();
    expect((await device.pin(manual)).ok).toBe(true);
    expect((await harness.folder.pull()).ok).toBe(true);
    const pinned = async () => {
      const status = await device.status();
      return status.ok ? status.value.pinned : [];
    };
    expect(await pinned()).toEqual(expect.arrayContaining([kept, manual]));

    // Beta leaves by state and its file goes: Alpha's line still holds it.
    archived = wireItem({ ...titled(beta, "Beta"), state: "archived" });
    expect((await harness.folder.push()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "Beta.md"))).toBe(false);
    expect(
      await pinned(),
      "the binding took a pin a line still holds",
    ).toContain(beta);

    // Taking the lines out lets the folder's own pin go, and no other.
    edit(harness, "Alpha.md", '  - "[[Kept]]"\n', "");
    edit(harness, "Alpha.md", '  - "[[Manual]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    const after = await pinned();
    expect(after, "a pin no line holds was kept").not.toContain(kept);
    expect(after, "a line let go of a pin somebody else made").toContain(
      manual,
    );
  });

  it("keeps a typed alias as typed, and flags a name that reads two ways", async () => {
    const hash = "01a00000-0000-7000-8000-00000000e112";
    const made = await edgeHarness(
      "folder-edge-alias",
      [
        titled(alpha, "Alpha"),
        titled(beta, "Beta"),
        titled(gamma, "C"),
        titled(hash, "C# notes"),
      ],
      [],
    );
    harness = made.harness;
    put(harness, "One.md", '---\nabout: "[[Beta|the beta]]"\n---\none\n');
    put(harness, "Two.md", '---\nabout: "[[C# notes]]"\n---\ntwo\n');
    put(
      harness,
      "Three.md",
      `---\nchild-of:\n  - "[[Alpha]]"\n  - "[[${alpha}]]"\n---\nthree\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const id = (title: string) =>
      String(
        sentCreates(harness!).find(
          (sent) =>
            (sent.properties as Record<string, unknown>).title === title,
        )?.id,
      );
    expect(sentEdgeWrites(harness).sort()).toEqual(
      [
        `create ${id("One")} about ${beta}`,
        `create ${alpha} parent-of ${id("Three")}`,
      ].sort(),
    );
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a name read two ways was guessed",
    ).toEqual([["Two.md", "edges"]]);
    expect(
      frontOf(harness, "One.md"),
      "the pull rewrote the alias the person typed",
    ).toContain('"[[Beta|the beta]]"');
  });

  it("takes a delete of an edge already gone as done", async () => {
    const gone = "01a00000-0000-7000-8000-00000000e1f6";
    const made = await edgeHarness(
      "folder-edge-gone",
      [titled(alpha, "Alpha"), titled(beta, "Beta"), titled(gamma, "Gamma")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1f5",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
        { id: gone, source_id: alpha, target_id: gamma, edge_type: "about" },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    // Another machine took the same line out first.
    made.door.edges.delete(gone);
    edit(harness, "Alpha.md", '  - "[[Gamma]]"\n', "");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([`delete ${gone}`]);
    expect(
      pushed.ok && pushed.value.pull?.flagged,
      "a delete of an edge already gone held its file for good",
    ).toEqual([]);
  });

  it("replaces a one-target edge's target in one step", async () => {
    const parentEdge = "01a00000-0000-7000-8000-00000000e1ec";
    const threadEdge = "01a00000-0000-7000-8000-00000000e1ee";
    const made = await edgeHarness(
      "folder-edge-replace",
      [
        titled(project, "One"),
        titled(other, "Two"),
        titled(child, "Child"),
        titled(alpha, "Alpha"),
        titled(beta, "Beta"),
      ],
      [
        {
          id: parentEdge,
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
          properties: { since: "spring" },
        },
        {
          id: threadEdge,
          source_id: child,
          target_id: alpha,
          edge_type: "in-thread",
        },
      ],
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(frontOf(harness, "Child.md")).toContain('in-thread: "[[Alpha]]"');

    // The child's end holds one parent, so its other end, the parent, moves.
    edit(harness, "Child.md", "[[One]]", "[[Two]]");
    // The message's end holds one thread, so the thread moves.
    edit(harness, "Child.md", "[[Alpha]]", "[[Beta]]");
    const moved = await harness.folder.push();
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    expect(
      sentEdgeWrites(harness).sort(),
      "the replacement was not sent as one write moving the edge's other end",
    ).toEqual(
      [
        `move ${parentEdge} source ${other}`,
        `move ${threadEdge} target ${beta}`,
      ].sort(),
    );
    expect(heldEdges(door)).toEqual(
      [`${other} parent-of ${child}`, `${child} in-thread ${beta}`].sort(),
    );
    expect(
      door.edges.get(parentEdge)?.properties,
      "the edge moved lost the properties it carried",
    ).toEqual({ since: "spring" });
    const parentsAt = (held: string[]) =>
      held.filter((edge) => edge.endsWith(` parent-of ${child}`)).length;
    expect(
      door.history.map(parentsAt),
      "the server held the child with no parent, or two, between writes",
    ).toEqual(door.history.map(() => 1));
    expect(
      moved.value.pull?.flagged,
      "a replacement taken by the server held its file",
    ).toEqual([]);
    expect(frontOf(harness, "Child.md")).toContain('child-of: "[[Two]]"');

    // The witness: the door's history sees an end emptied where a write empties it.
    edit(harness, "Child.md", 'child-of: "[[Two]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toContain(`delete ${parentEdge}`);
    expect(door.history.map(parentsAt).at(-1)).toBe(0);
  });

  it("keeps the old edge where the replace is refused", async () => {
    const parentEdge = "01a00000-0000-7000-8000-00000000e1f7";
    const threadEdge = "01a00000-0000-7000-8000-00000000e1fc";
    const made = await edgeHarness(
      "folder-edge-replace-refused",
      [
        titled(project, "One"),
        titled(other, "Two"),
        titled(third, "Three"),
        titled(child, "Child"),
        titled(alpha, "Alpha"),
        titled(beta, "Beta"),
        titled(gamma, "Gamma"),
      ],
      [
        {
          id: parentEdge,
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
        },
        {
          id: threadEdge,
          source_id: child,
          target_id: alpha,
          edge_type: "in-thread",
        },
      ],
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);

    // The child's parent moves at the source end, its thread at the target end.
    door.placing = (edge) =>
      (edge.edge_type === "parent-of" && edge.source_id === other) ||
      (edge.edge_type === "in-thread" && edge.target_id === beta)
        ? answers.edgePermissionDenied(edge.edge_type)
        : undefined;
    edit(harness, "Child.md", "[[One]]", "[[Two]]");
    edit(harness, "Child.md", "[[Alpha]]", "[[Beta]]");
    const refused = await harness.folder.push();
    expect(refused.ok, JSON.stringify(refused)).toBe(true);
    if (!refused.ok) return;
    expect(sentEdgeWrites(harness).sort()).toEqual(
      [
        `move ${parentEdge} source ${other}`,
        `move ${threadEdge} target ${beta}`,
      ].sort(),
    );
    expect(
      heldEdges(door),
      "a refused move left the child without the edge it had",
    ).toEqual(
      [`${project} parent-of ${child}`, `${child} in-thread ${alpha}`].sort(),
    );
    expect(
      refused.value.pull?.flagged.map((file) => [file.path, file.flag]),
      "the file whose line was refused was not flagged",
    ).toEqual([["Child.md", "refused"]]);
    expect(refused.value.pull?.flagged[0]?.reason).toContain(
      "edge_permission_denied",
    );
    expect(read(harness, "Child.md")).toContain('child-of: "[[Two]]"');
    const local = await harness.folder.device().text(["edges", "to", child]);
    expect(
      local.ok && local.value,
      "the copy kept the refused parent rather than the one the server holds",
    ).toContain(project);

    // The witness that the record names each old edge again: the next change
    // moves each from there, in one step, and the file is held no longer.
    door.placing = undefined;
    edit(harness, "Child.md", "[[Two]]", "[[Three]]");
    edit(harness, "Child.md", "[[Beta]]", "[[Gamma]]");
    const next = await harness.folder.push();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (!next.ok) return;
    expect(sentEdgeWrites(harness).slice(2).sort()).toEqual(
      [
        `move ${parentEdge} source ${third}`,
        `move ${threadEdge} target ${gamma}`,
      ].sort(),
    );
    expect(heldEdges(door)).toEqual(
      [`${third} parent-of ${child}`, `${child} in-thread ${gamma}`].sort(),
    );
    expect(next.value.pull?.flagged).toEqual([]);
  });

  it("holds a file whose move a plain device drain saw refused", async () => {
    const parentEdge = "01a00000-0000-7000-8000-00000000e1f8";
    const made = await edgeHarness(
      "folder-edge-replace-device-drain",
      [
        titled(project, "One"),
        titled(other, "Two"),
        titled(third, "Three"),
        titled(child, "Child"),
      ],
      [
        {
          id: parentEdge,
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
        },
      ],
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);

    door.placing = (edge) =>
      edge.edge_type === "parent-of" && edge.source_id === other
        ? answers.edgePermissionDenied("parent-of")
        : undefined;
    // By id, which a scan with no server resolves from the copy.
    edit(harness, "Child.md", "[[One]]", `[[${other}]]`);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);
    // The witness: the plain drain sent the move and the server refused it.
    expect(sentEdgeWrites(harness)).toEqual([
      `move ${parentEdge} source ${other}`,
    ]);
    expect(heldEdges(door)).toEqual([`${project} parent-of ${child}`]);

    const next = await harness.folder.push();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (!next.ok) return;
    expect(
      next.value.pull?.flagged.map((file) => [file.path, file.flag]),
      "a move refused under a plain device drain never held its file",
    ).toEqual([["Child.md", "refused"]]);

    // The record names the old edge again, so the next change moves it from there.
    door.placing = undefined;
    edit(harness, "Child.md", `[[${other}]]`, "[[Three]]");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness).at(-1)).toBe(
      `move ${parentEdge} source ${third}`,
    );
    expect(heldEdges(door)).toEqual([`${third} parent-of ${child}`]);
  });

  it("makes the edge a line asks for where its move finds the edge deleted elsewhere", async () => {
    const parentEdge = "01a00000-0000-7000-8000-00000000e1f9";
    const made = await edgeHarness(
      "folder-edge-replace-gone",
      [titled(project, "One"), titled(other, "Two"), titled(child, "Child")],
      [
        {
          id: parentEdge,
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
          properties: { since: "spring" },
        },
      ],
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);

    // Another machine deletes the edge before this one's move reaches it.
    door.edges.delete(parentEdge);
    edit(harness, "Child.md", "[[One]]", "[[Two]]");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witness: the move was sent and answered that the edge is gone.
    expect(sentEdgeWrites(harness)[0]).toBe(
      `move ${parentEdge} source ${other}`,
    );
    expect(
      heldEdges(door),
      "the child was left with no parent though its line names one",
    ).toEqual([`${other} parent-of ${child}`]);
    expect(
      [...door.edges.values()].find((edge) => edge.edge_type === "parent-of")
        ?.properties,
      "the edge made in the deleted one's place lost the properties the copy held",
    ).toEqual({ since: "spring" });
    expect(pushed.value.pull?.flagged).toEqual([]);
  });

  it("makes the edge a gone move's line asks for at the next drain, where the first one stops", async () => {
    const parentEdge = "01a00000-0000-7000-8000-00000000e1fb";
    const made = await edgeHarness(
      "folder-edge-replace-gone-stopped",
      [
        titled(project, "One"),
        titled(other, "Two"),
        titled(child, "Child"),
        titled(alpha, "Alpha"),
        titled(beta, "Beta"),
      ],
      [
        {
          id: parentEdge,
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
        },
      ],
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);

    // Another machine deletes the edge; a plain device drain sends the move.
    door.edges.delete(parentEdge);
    edit(harness, "Child.md", "[[One]]", `[[${other}]]`);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `move ${parentEdge} source ${other}`,
    ]);

    // The next folder drain stops at a credential the server refuses.
    door.placing = (edge) =>
      edge.edge_type === "in-thread"
        ? refusal(401, "unauthorized", "no credential")
        : undefined;
    edit(harness, "Alpha.md", /marfa_id:/, 'in-thread: "[[Beta]]"\nmarfa_id:');
    const stopped = await harness.folder.push();
    expect(
      stopped.ok && stopped.value.drain.stopped,
      "the drain did not stop",
    ).toBeTruthy();
    expect(heldEdges(door)).toEqual([]);

    // The credential is back.
    door.placing = undefined;
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      heldEdges(door),
      `a drain that stopped lost the edge the line asks for; sent ${JSON.stringify(sentEdgeWrites(harness))}`,
    ).toContain(`${other} parent-of ${child}`);
  });

  it("waits for the create of the item its line now names before it moves the edge", async () => {
    const parentEdge = "01a00000-0000-7000-8000-00000000e1fd";
    let refusedOnce = false;
    const made = await edgeHarness(
      "folder-edge-replace-new-parent",
      [titled(project, "One"), titled(child, "Child")],
      [
        {
          id: parentEdge,
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
        },
      ],
      {
        // The new parent's create is answered with nothing a device can read,
        // once, so it is still to be taken when the move is next in line.
        door: (items) => {
          const create = items.create.bind(items);
          items.create = (sent) => {
            if (!refusedOnce && sent.properties?.title === "Fresh") {
              refusedOnce = true;
              return {
                answer: { kind: "json", status: 200, body: "not json at all" },
              };
            }
            return create(sent);
          };
        },
      },
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);

    // Scanned without a drain, so the move is queued behind a create not yet sent.
    put(harness, "Fresh.md", "The new parent.\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    const queued = await harness.folder.device().queue();
    const fresh = queued.ok
      ? queued.value.filter((row) => row.kind === "create_item").at(-1)?.item_id
      : undefined;
    expect(fresh, "the scan queued no create for the new file").toBeDefined();
    edit(harness, "Child.md", "[[One]]", `[[${String(fresh)}]]`);
    expect((await harness.folder.scan()).ok).toBe(true);
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await harness.folder.push()).ok).toBe(true);
    }
    // The witness: the create was refused once, so the move had a chance to overtake it.
    expect(refusedOnce).toBe(true);
    expect(
      heldEdges(door),
      "the move went before the create of the parent it names, and was refused",
    ).toEqual([`${fresh} parent-of ${child}`]);
  });

  it("leaves the server's edge whole where a move dies after its retries", async () => {
    const parentEdge = "01a00000-0000-7000-8000-00000000e1fa";
    const made = await edgeHarness(
      "folder-edge-replace-dead",
      [titled(project, "One"), titled(other, "Two"), titled(child, "Child")],
      [
        {
          id: parentEdge,
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
        },
      ],
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);

    door.placing = (edge) =>
      edge.edge_type === "parent-of" && edge.source_id === other
        ? { kind: "json", status: 200, body: "not json at all" }
        : undefined;
    edit(harness, "Child.md", "[[One]]", "[[Two]]");
    const verdicts: string[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (pushed.ok) {
        verdicts.push(
          ...pushed.value.drain.verdicts
            .filter((entry) => entry.kind === "update_edge")
            .map((entry) => String(entry.verdict)),
        );
      }
    }
    // The witness: every retry sent the same move, until it died.
    expect(verdicts).toContain("dead");
    expect(new Set(sentEdgeWrites(harness))).toEqual(
      new Set([`move ${parentEdge} source ${other}`]),
    );
    expect(
      heldEdges(door),
      "a move that died left the server's edge anywhere but whole at one end",
    ).toEqual([`${project} parent-of ${child}`]);
  });

  it("flags a line naming too many targets for its edge type, and changes nothing", async () => {
    const made = await edgeHarness(
      "folder-edge-too-many",
      [titled(project, "One"), titled(other, "Two"), titled(child, "Child")],
      [],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    edit(
      harness,
      "Child.md",
      /marfa_id:/,
      'child-of:\n  - "[[One]]"\n  - "[[Two]]"\nmarfa_id:',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a child-of line naming two parents was not flagged",
    ).toEqual([["Child.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("one at most");
    expect(
      sentEdgeWrites(harness),
      "a line naming more targets than its end holds made an edge",
    ).toEqual([]);

    // The witness: one parent is made.
    edit(harness, "Child.md", '  - "[[Two]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${project} parent-of ${child}`,
    ]);
  });
});

/** The tag writes the folder sent, as `add <id> <tag>` and `remove <id> <tag>`. */
function sentTags(harness: FolderHarness): string[] {
  return harness.server.requests.flatMap((request) => {
    const [, items, id, tags, tag] = request.pathname.split("/");
    if (items !== "items" || tags !== "tags") return [];
    if (request.method === "POST") {
      const sent = JSON.parse(request.body) as { tags: string[] };
      return sent.tags.map((named) => `add ${id} ${named}`);
    }
    return request.method === "DELETE"
      ? [`remove ${id} ${decodeURIComponent(tag ?? "")}`]
      : [];
  });
}

/** The lifecycle moves the folder sent, as `<id> <state>`. */
function sentTransitions(harness: FolderHarness): string[] {
  return harness.server.requests
    .filter(
      (request) =>
        request.method === "POST" && request.pathname.endsWith("/transition"),
    )
    .map(
      (request) =>
        `${request.pathname.split("/").at(-2)} ${String((JSON.parse(request.body) as { state: string }).state)}`,
    );
}

describe("embedded files", () => {
  const host = "01a00000-0000-7000-8000-00000000e201";
  const pic = "01a00000-0000-7000-8000-00000000e202";
  const chart = "01a00000-0000-7000-8000-00000000e203";
  const scan = "01a00000-0000-7000-8000-00000000e204";
  const other = "01a00000-0000-7000-8000-00000000e205";
  const png = (last: number): Buffer =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, last]);

  /** A file item the server holds, named by its title. */
  function fileRow(id: string, title: string, bytes: Buffer): WireItemOptions {
    return {
      id,
      type: "core.file.image",
      properties: { title, blob_ref: hashOf(bytes), mime_type: "image/png" },
    };
  }

  /** An `attached-to` edge from a file to the note that embeds it. */
  function attached(id: string, file: string, to: string): WireEdgeOptions {
    return { id, source_id: file, target_id: to, edge_type: "attached-to" };
  }

  /** The item the folder created for a file, by the title it sent. */
  function createdFor(harness: FolderHarness, title: string): string {
    const sent = sentCreates(harness).find(
      (create) =>
        (create.properties as Record<string, unknown>).title === title,
    );
    return String(sent?.id);
  }

  /**
   * A folder whose server already places `items` where another machine put
   * them, each row carrying its placement and the attachments it draws.
   */
  async function placedEmbeds(
    label: string,
    items: WireItemOptions[],
    attachments: WireEdgeOptions[],
    paths: Record<string, string>,
    types: string[] = ["core.note", "core.file"],
  ): Promise<{
    harness: FolderHarness;
    door: EdgeDoor;
    placements: Record<string, string>;
  }> {
    const door = new EdgeDoor();
    const rows: Record<string, Array<{ item: WireItemOptions }>> = {};
    for (const item of items) {
      const asked = (item.type ?? "core.note").split(".").slice(0, 2).join(".");
      (rows[asked] ??= []).push({ item });
    }
    const made = await folderHarness(label, {
      settings: { search: { types } },
      rows,
      edges: { "attached-to": attachments },
      hydrate: false,
      events: [door.stream()],
    });
    for (const edge of attachments) door.hold(edge);
    const placements: Record<string, string> = {};
    for (const [id, path] of Object.entries(paths)) {
      const edge: WireEdgeOptions = {
        id: randomUUID(),
        source_id: id,
        target_id: made.settings.id,
        edge_type: "in-folder",
        properties: { path },
      };
      door.hold(edge);
      placements[id] = edge.id;
    }
    for (const item of items) {
      const drawn: Record<string, { data: unknown[]; next_cursor: null }> = {};
      for (const edge of door.edges.values()) {
        if (edge.source_id !== item.id) continue;
        (drawn[edge.edge_type ?? "references"] ??= {
          data: [],
          next_cursor: null,
        }).data.push(wireEdge(edge));
      }
      item.edges = drawn;
    }
    scriptFolderWrites(made, { edges: door });
    const hydrated = await made.folder.hydrate();
    if (!hydrated.ok) {
      await made.stop();
      throw new Error(
        `the fixture could not hydrate: ${JSON.stringify(hydrated)}`,
      );
    }
    return { harness: made, door, placements };
  }

  it("sends an embedded file with its file", async () => {
    // A folder of notes, whose search holds no file type.
    harness = await folderHarness("folder-embed-push");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    mkdirSync(join(harness.dir, "img"), { recursive: true });
    writeFileSync(join(harness.dir, "img", "pic.png"), png(1));
    mkdirSync(join(harness.dir, "charts"), { recursive: true });
    writeFileSync(join(harness.dir, "charts", "chart.png"), png(2));
    // Beside them and embedded by nothing, so left alone as before.
    writeFileSync(join(harness.dir, "loose.png"), png(3));
    put(
      harness,
      "Note.md",
      "---\ntitle: Note\n---\na picture ![](img/pic.png) and a chart ![[chart.png|300]]\n",
    );
    // Lists the picture without showing it, so a line is written here.
    put(
      harness,
      "Other.md",
      '---\ntitle: Other\nhas-attachment: "[[pic.png]]"\n---\nabout it\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "an embedded file was not sent with the note that embeds it, or a file nothing embeds was sent",
    ).toEqual(["Note", "Other", "chart.png", "pic.png"]);
    expect(pushed.value.scan.skipped).toBe(1);
    const note = createdFor(harness, "Note");
    const picId = createdFor(harness, "pic.png");
    const chartId = createdFor(harness, "chart.png");
    expect(
      sentCreates(harness).find((create) => create.id === picId)?.type,
      "the embedded file did not go as a file item",
    ).toBe("core.file.image");
    expect(
      heldEdges(edges),
      "an embed did not become its file's attached-to edge to the note",
    ).toEqual(
      [
        `${picId} attached-to ${note}`,
        `${chartId} attached-to ${note}`,
        `${picId} attached-to ${createdFor(harness, "Other")}`,
      ].sort(),
    );
    const order = harness.server.requests
      .filter((request) => request.method === "POST")
      .map((request) =>
        request.pathname === "/items"
          ? `/items ${String((JSON.parse(request.body) as { properties: { title?: string } }).properties.title)}`
          : request.pathname,
      );
    expect(
      order.indexOf("/blobs"),
      "the embedded file's item went out before its bytes",
    ).toBeLessThan(order.indexOf("/items pic.png"));
    expect(
      pushed.value.pull?.unmatched,
      "an embedded file outside the search was flagged as an item the folder no longer holds",
    ).toBe(0);
    expect(
      frontOf(harness, "Other.md"),
      "a has-attachment line was not written at all, so its absence below says nothing",
    ).toContain("has-attachment");
    expect(
      read(harness, "Note.md"),
      "the note repeats in a line an attachment its body already shows",
    ).not.toContain("has-attachment");

    // Read back, the files change nothing.
    const writes = sentEdgeWrites(harness).length;
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toHaveLength(writes);

    // Embedded no longer, the chart's file is one the folder no longer holds.
    edit(harness, "Note.md", " and a chart ![[chart.png|300]]", "");
    const dropped = await harness.folder.push();
    expect(dropped.ok, JSON.stringify(dropped)).toBe(true);
    expect(
      dropped.ok && dropped.value.pull?.unmatched,
      "a file no longer embedded was not counted, so the count of none above says nothing",
    ).toBe(1);
  });

  it("writes an embedded file where its link says", async () => {
    const made = await edgeHarness(
      "folder-embed-pull",
      [
        {
          id: host,
          properties: {
            title: "Host",
            body: "a picture ![](img/pic.png), a chart ![[chart.png]], a logo ![[art/logo.png]] and ![](../../away.png)\n",
          },
        },
        fileRow(pic, "pic.png", png(1)),
        fileRow(chart, "chart.png", png(2)),
        fileRow(scan, "logo.png", png(3)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2e1", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2e2", chart, host),
        attached("01a00000-0000-7000-8000-00000000e2e9", scan, host),
      ],
      {
        settings: {
          search: { types: ["core.note"] },
          first_placement: { "core.note": "notes" },
        },
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    scriptBlob(harness.server, png(2));
    scriptBlob(harness.server, png(3));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(existsSync(join(harness.dir, "notes", "Host.md"))).toBe(true);
    expect(
      readFileSync(join(harness.dir, "art", "logo.png")),
      "a file embedded by a name carrying a directory was not written from the folder's root",
    ).toEqual(png(3));

    expect(
      readFileSync(join(harness.dir, "notes", "img", "pic.png")),
      "an embedded file was not written at its path read from the note that embeds it",
    ).toEqual(png(1));
    expect(
      readFileSync(join(harness.dir, "notes", "chart.png")),
      "a file embedded by name was not written beside the note that embeds it",
    ).toEqual(png(2));
    expect(
      pulled.value.embeds,
      "an embed was reported that names its file, or the one leading out was not",
    ).toEqual([
      expect.objectContaining({
        path: "notes/Host.md",
        reason: expect.stringContaining(
          "![](../../away.png) leads out",
        ) as unknown,
      }),
    ]);
    // The placements the pull wrote go at the next drain.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      made.door.placements(harness.settings.id),
      "an embedded file's placement is not the path its link says",
    ).toEqual(
      new Map([
        [host, "notes/Host.md"],
        [pic, "notes/img/pic.png"],
        [chart, "notes/chart.png"],
        [scan, "art/logo.png"],
      ]),
    );

    // Moved where a name still finds it, a file embedded by name stays; one
    // embedded by path goes back where its link says, its placement with it.
    mkdirSync(join(harness.dir, "charts"));
    renameSync(
      join(harness.dir, "notes", "chart.png"),
      join(harness.dir, "charts", "chart.png"),
    );
    renameSync(
      join(harness.dir, "notes", "img", "pic.png"),
      join(harness.dir, "notes", "pic.png"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(existsSync(join(harness.dir, "charts", "chart.png"))).toBe(true);
    expect(existsSync(join(harness.dir, "notes", "chart.png"))).toBe(false);
    expect(
      existsSync(join(harness.dir, "notes", "img", "pic.png")),
      "a file embedded by path was left where its link no longer finds it",
    ).toBe(true);
    expect(existsSync(join(harness.dir, "notes", "pic.png"))).toBe(false);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(made.door.placements(harness.settings.id)).toEqual(
      new Map([
        [host, "notes/Host.md"],
        [pic, "notes/img/pic.png"],
        [chart, "charts/chart.png"],
        [scan, "art/logo.png"],
      ]),
    );
    expect(
      heldEdges(made.door),
      "moving an embedded file changed an edge",
    ).toEqual(
      [
        `${chart} attached-to ${host}`,
        `${pic} attached-to ${host}`,
        `${scan} attached-to ${host}`,
      ].sort(),
    );
  });

  it("reports an embed pointing outside the folder", async () => {
    harness = await folderHarness("folder-embed-outside");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    // A real file there, so only the folder's rule keeps it from being sent.
    writeFileSync(join(harness.dir, "..", "away.png"), png(1));
    writeFileSync(join(harness.dir, "near.png"), png(2));
    writeFileSync(join(harness.dir, "far.png"), png(3));
    put(
      harness,
      "Note.md",
      "---\ntitle: Note\n---\n![](../away.png) beside ![](near.png) and ![](far.png)\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "a file outside the folder was sent, or the ones inside were not",
    ).toEqual(["Note", "far.png", "near.png"]);
    expect(
      pushed.value.scan.embeds,
      "an embed leading out of the folder was not reported",
    ).toEqual([
      expect.objectContaining({
        path: "Note.md",
        flag: "embed",
        reason: expect.stringContaining("![](../away.png)") as unknown,
      }),
    ]);
    // It names no file here that could be one taken out, so it holds back
    // no removal.
    const note = createdFor(harness, "Note");
    edit(harness, "Note.md", " and ![](far.png)", "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      heldEdges(edges),
      "an embed leading out of the folder held back the removal of another",
    ).toEqual([`${createdFor(harness, "near.png")} attached-to ${note}`]);

    // Pulled on another machine, the file is not written out there either.
    const elsewhere = await edgeHarness(
      "folder-embed-outside-pull",
      [
        {
          id: host,
          properties: {
            title: "Host",
            body: "![](../away.png) beside ![](near.png)\n",
          },
        },
        fileRow(pic, "away.png", png(1)),
        fileRow(chart, "near.png", png(2)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2e3", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2e4", chart, host),
      ],
    ).then((made) => made.harness);
    second = elsewhere;
    scriptBlob(elsewhere.server, png(1));
    scriptBlob(elsewhere.server, png(2));
    const pulled = await elsewhere.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      readFileSync(join(elsewhere.dir, "near.png")),
      "the pull wrote no embedded file at all, so the one below is absent for nothing",
    ).toEqual(png(2));
    expect(existsSync(join(elsewhere.dir, "..", "away.png"))).toBe(false);
    expect(existsSync(join(elsewhere.dir, "away.png"))).toBe(false);
    expect(
      pulled.value.embeds,
      "a pull did not report an embed leading out of the folder",
    ).toEqual([
      expect.objectContaining({
        path: "Host.md",
        flag: "embed",
        reason: expect.stringContaining("![](../away.png)") as unknown,
      }),
    ]);
  });

  it("writes an item embedded at two paths at the first, and reports the other", async () => {
    const made = await edgeHarness(
      "folder-embed-two-paths",
      [
        {
          id: host,
          properties: { title: "First", body: "![](img/pic.png)\n" },
        },
        {
          id: other,
          properties: { title: "Second", body: "![](art/pic.png)\n" },
        },
        fileRow(pic, "pic.png", png(1)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2e5", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2e6", pic, other),
      ],
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      readFileSync(join(harness.dir, "art", "pic.png")),
      "an item embedded at two paths was not written at the first in path order",
    ).toEqual(png(1));
    expect(
      existsSync(join(harness.dir, "img", "pic.png")),
      "an item embedded at two paths was written twice, as two files of one item",
    ).toBe(false);
    expect(
      pulled.value.embeds,
      "the link naming the other path was not reported",
    ).toEqual([
      expect.objectContaining({
        path: "First.md",
        flag: "embed",
        reason: expect.stringContaining("art/pic.png") as unknown,
      }),
    ]);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(made.door.placements(harness.settings.id).get(pic)).toBe(
      "art/pic.png",
    );
  });

  it("removes the edge when the embed is taken out", async () => {
    harness = await folderHarness("folder-embed-removed");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    put(
      harness,
      "Note.md",
      "---\ntitle: Note\n---\nfirst ![](a.png) and more\n![[b.png]]\nthe end\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);
    const note = createdFor(harness, "Note");
    const a = createdFor(harness, "a.png");
    const b = createdFor(harness, "b.png");
    expect(
      heldEdges(edges),
      "an embed made no edge, so there is nothing for taking it out to remove",
    ).toEqual([`${a} attached-to ${note}`, `${b} attached-to ${note}`].sort());

    // The embed taken out of its line, and a line holding one taken out.
    edit(harness, "Note.md", " ![](a.png)", "");
    const once = await harness.folder.push();
    expect(once.ok, JSON.stringify(once)).toBe(true);
    expect(
      heldEdges(edges),
      "the edge stayed when its embed was taken out of the body",
    ).toEqual([`${b} attached-to ${note}`]);
    edit(harness, "Note.md", "![[b.png]]\n", "");
    const twice = await harness.folder.push();
    expect(twice.ok, JSON.stringify(twice)).toBe(true);
    expect(
      heldEdges(edges),
      "the edge stayed when the line holding its embed was taken out",
    ).toEqual([]);
    expect(
      existsSync(join(harness.dir, "b.png")),
      "the file an embed named went with the embed",
    ).toBe(true);
  });

  it("removes no attachment while an embed names nothing, and removes it once none does", async () => {
    harness = await folderHarness("folder-embed-stand-down");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    // Beside the embed that names it with a raw space, so only the space
    // keeps it from being read.
    writeFileSync(join(harness.dir, "raw x.png"), png(3));
    writeFileSync(join(harness.dir, "empty.png"), Buffer.alloc(0));
    put(harness, "Note.md", "---\ntitle: Note\n---\n![](a.png)\n![](b.png)\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const note = createdFor(harness, "Note");
    const a = createdFor(harness, "a.png");
    const b = createdFor(harness, "b.png");
    expect(heldEdges(edges)).toEqual(
      [`${a} attached-to ${note}`, `${b} attached-to ${note}`].sort(),
    );
    const deletes = async (): Promise<number> => {
      const queued = await harness!.folder.device().queue();
      if (!queued.ok) throw new Error(JSON.stringify(queued));
      return withoutPlacements(harness!, queued.value).filter(
        (row) => row.kind === "delete_edge",
      ).length;
    };

    // One embed taken out while another names no file: an embed gone and an
    // embed that names nothing look the same, so nothing is removed.
    edit(harness, "Note.md", "![](a.png)\n![](b.png)", "![](gone.png)");
    const gone = await harness.folder.scan();
    expect(gone.ok, JSON.stringify(gone)).toBe(true);
    if (!gone.ok) return;
    expect(
      await deletes(),
      "an attachment was removed while an embed in the same file named nothing",
    ).toBe(0);
    expect(
      gone.value.embeds,
      "an embed holding back removals was not reported, with its file and its text",
    ).toEqual([
      expect.objectContaining({
        path: "Note.md",
        flag: "embed",
        reason: expect.stringContaining(
          "![](gone.png) names no file",
        ) as unknown,
      }),
    ]);

    // A raw space ends a Markdown path, so it names no file either.
    edit(harness, "Note.md", "![](gone.png)", "![](raw x.png)");
    const spaced = await harness.folder.scan();
    expect(spaced.ok, JSON.stringify(spaced)).toBe(true);
    if (!spaced.ok) return;
    expect(
      await deletes(),
      "an attachment was removed while an embed with a raw space named nothing",
    ).toBe(0);
    expect(spaced.value.embeds).toEqual([
      expect.objectContaining({
        path: "Note.md",
        reason: expect.stringContaining(
          "![](raw x.png) has a raw space",
        ) as unknown,
      }),
    ]);
    expect(
      sentTitles(harness),
      "a file named by an embed with a raw space was sent",
    ).not.toContain("raw x.png");

    // An empty file is never sent, so an embed of it names no file sent.
    edit(harness, "Note.md", "![](raw x.png)", "![](empty.png)");
    const empty = await harness.folder.scan();
    expect(empty.ok, JSON.stringify(empty)).toBe(true);
    if (!empty.ok) return;
    expect(
      await deletes(),
      "an attachment was removed while an embed of an empty file named nothing sent",
    ).toBe(0);
    expect(empty.value.embeds).toEqual([
      expect.objectContaining({
        path: "Note.md",
        reason: expect.stringContaining(
          "![](empty.png) names no file",
        ) as unknown,
      }),
    ]);

    // Once it names a file again, the removal the file held back lands.
    edit(harness, "Note.md", "![](empty.png)", "![](b.png)");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      await deletes(),
      "no removal was queued at all, so the one held back above is absent for nothing",
    ).toBe(1);
    expect(
      heldEdges(edges),
      "the removal held back while an embed named nothing never landed",
    ).toEqual([`${b} attached-to ${note}`]);
  });

  it("lists under has-attachment only what the body does not embed", async () => {
    const made = await edgeHarness(
      "folder-embed-has-attachment",
      [
        {
          id: host,
          properties: { title: "Host", body: "shown ![](pic.png)\n" },
        },
        fileRow(pic, "pic.png", png(1)),
        fileRow(scan, "scan.png", png(2)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2e7", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2e8", scan, host),
      ],
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      frontOf(harness, "Host.md"),
      "an attachment the body does not embed is not listed, so its edge is shown in no file",
    ).toContain('has-attachment:\n  - "[[scan.png]]"');
    expect(
      frontOf(harness, "Host.md"),
      "an attachment the body embeds is listed under has-attachment too, so one edge is said twice",
    ).not.toContain("pic.png");
    expect(existsSync(join(harness.dir, "pic.png"))).toBe(true);
    expect(
      existsSync(join(harness.dir, "scan.png")),
      "an attachment nothing embeds was written as a file",
    ).toBe(false);

    // Read back, nothing changes; the line taken out removes only its edge.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
    edit(
      harness,
      "Host.md",
      /has-attachment:\n {2}- "\[\[scan\.png\]\]"\n/,
      "",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(heldEdges(made.door)).toEqual([`${pic} attached-to ${host}`]);
  });

  it("reads an embed of a note, even one with a dot in its name, as text", async () => {
    harness = await folderHarness("folder-embed-dotted-note");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    put(harness, "Dr. Smith.md", "---\ntitle: Dr. Smith\n---\na person\n");
    // A `.txt` file here is a document, so its embed is a note's too.
    put(harness, "plain.txt", "a text file\n");
    put(
      harness,
      "Note.md",
      "---\ntitle: Note\n---\n![](a.png)\n![](b.png)\n![[Dr. Smith]] ![[v1.2 plan]] ![[2024.05.01]] ![](Dr.%20Smith.md) ![](Other Note.md) ![](plain.txt) ![](../away.png)\n",
    );
    const first = await harness.folder.push();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    const note = createdFor(harness, "Note");
    const b = createdFor(harness, "b.png");
    expect(heldEdges(edges)).toHaveLength(2);
    // Only the embed leading out, which is reported, so the notes are not.
    const outside = [
      expect.objectContaining({
        path: "Note.md",
        reason: expect.stringContaining(
          "![](../away.png) leads out",
        ) as unknown,
      }),
    ];
    expect(
      first.value.scan.embeds,
      "an embed of a note was read as an embed of a file that names nothing",
    ).toEqual(outside);
    expect(
      first.value.pull?.embeds,
      "a pull read an embed of a note as an embed of a file",
    ).toEqual(outside);

    edit(harness, "Note.md", "![](a.png)\n", "");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      heldEdges(edges),
      "an embed of a note with a dot in its name held back the removal of a taken-out embed",
    ).toEqual([`${b} attached-to ${note}`]);
  });

  it("reads embeds in a Markdown body only, and none shown in code", async () => {
    harness = await folderHarness("folder-embed-code");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    for (const [name, last] of [
      ["a.png", 1],
      ["fenced.png", 2],
      ["inline.png", 3],
      ["plain.png", 4],
    ] as const) {
      writeFileSync(join(harness.dir, name), png(last));
    }
    put(
      harness,
      "Note.md",
      [
        "---\ntitle: Note\n---",
        "![](a.png) ![](../away.png)",
        "```md\n![](fenced.png) ![](../hidden.png)\n```",
        "write `![[inline.png]]` to show one",
        "````\n```\n![](long.png)\n````",
        "%% ![](obsidian.png) %% and <!-- ![](html.png)",
        "--> after",
        "",
      ].join("\n"),
    );
    for (const [name, last] of [
      ["long.png", 5],
      ["obsidian.png", 6],
      ["html.png", 7],
    ] as const) {
      writeFileSync(join(harness.dir, name), png(last));
    }
    put(harness, "plain.txt", "![](plain.png)\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "an embed shown in code, or one in a file that is not Markdown, sent its file",
    ).toEqual(["Note", "a.png", "plain"]);
    expect(heldEdges(edges)).toEqual([
      `${createdFor(harness, "a.png")} attached-to ${createdFor(harness, "Note")}`,
    ]);
    expect(
      pushed.value.scan.embeds,
      "an embed in code was reported, or the one outside code was not",
    ).toEqual([
      expect.objectContaining({
        path: "Note.md",
        reason: expect.stringContaining(
          "![](../away.png) leads out",
        ) as unknown,
      }),
    ]);
  });

  it("reads an embed's path as Obsidian reads one", async () => {
    harness = await folderHarness("folder-embed-paths");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    const files: Array<[string, number]> = [
      ["my image.png", 1],
      ["img/query.png", 2],
      ["img/rooted.png", 3],
      ["sub/near.png", 4],
      ["far.png", 5],
      ["sub/x.png", 6],
    ];
    for (const [name, last] of files) {
      mkdirSync(join(harness.dir, name, ".."), { recursive: true });
      writeFileSync(join(harness.dir, name), png(last));
    }
    put(
      harness,
      "sub/Note.md",
      [
        "---\ntitle: Note\n---",
        "![](../my%20image.png)",
        "![](../img/query.png?v=2)",
        "![](/img/rooted.png#part)",
        "![[./near.png]]",
        "![[../far.png]]",
        // Addresses, never a file here, though a file of the name is.
        "![](https://example.com/x.png) ![](//cdn.example.com/x.png) ![](#x.png)",
        "![](../../away.png)",
        "",
      ].join("\n"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "an embed's path was not read as Obsidian reads it, or an address was read as a file here",
    ).toEqual([
      "Note",
      "far.png",
      "my image.png",
      "near.png",
      "query.png",
      "rooted.png",
    ]);
    expect(heldEdges(edges)).toHaveLength(5);
    expect(
      pushed.value.scan.embeds,
      "a path read as Obsidian reads it was reported, or the one leading out was not",
    ).toEqual([
      expect.objectContaining({
        path: "sub/Note.md",
        reason: expect.stringContaining(
          "![](../../away.png) leads out",
        ) as unknown,
      }),
    ]);
  });

  it("reads an embed by name as Obsidian resolves a name", async () => {
    harness = await folderHarness("folder-embed-names");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    // Deeper but first in path order, then two as shallow as each other.
    const files: Array<[string, number]> = [
      ["a/z/pic.png", 1],
      ["b/pic.png", 2],
      ["notes/pic.png", 3],
      ["a/b/pic.png", 4],
      // Ends in `z/pic.png` but not at a directory's edge.
      ["bz/pic.png", 5],
    ];
    for (const [name, last] of files) {
      mkdirSync(join(harness.dir, name, ".."), { recursive: true });
      writeFileSync(join(harness.dir, name), png(last));
    }
    put(harness, "notes/Near.md", "---\ntitle: Near\n---\n![[pic.png]]\n");
    put(harness, "x/Far.md", "---\ntitle: Far\n---\n![[pic.png]]\n");
    put(harness, "x/Deep.md", "---\ntitle: Deep\n---\n![[z/pic.png]]\n");
    // The path from the root over the file beside the note.
    put(harness, "a/b/Rooted.md", "---\ntitle: Rooted\n---\n![[b/pic.png]]\n");
    // A name matches at a directory's edge, and whatever its case.
    put(harness, "x/Edge.md", "---\ntitle: Edge\n---\n![[c.png]]\n");
    put(harness, "x/Case.md", "---\ntitle: Case\n---\n![[PIC.PNG]]\n");
    // Two attachments of one name, each read by the path it is bound at.
    put(
      harness,
      "x/Both.md",
      "---\ntitle: Both\n---\n![](../a/z/pic.png) ![](../b/pic.png)\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const edge = [
      expect.objectContaining({
        path: "x/Edge.md",
        reason: expect.stringContaining("![[c.png]] names no") as unknown,
      }),
    ];
    expect(
      pushed.value.scan.embeds,
      "a name was read as matching inside a file's name",
    ).toEqual(edge);
    expect(
      pushed.value.pull?.embeds,
      "a path embed was not read as the attachment bound at its path",
    ).toEqual(edge);
    const at = new Map(
      [...edges.placements(harness.settings.id)].map(([id, path]) => [
        String(path),
        id,
      ]),
    );
    expect(heldEdges(edges)).toEqual(
      [
        `${at.get("notes/pic.png")} attached-to ${createdFor(harness, "Near")}`,
        `${at.get("b/pic.png")} attached-to ${createdFor(harness, "Far")}`,
        `${at.get("a/z/pic.png")} attached-to ${createdFor(harness, "Deep")}`,
        `${at.get("b/pic.png")} attached-to ${createdFor(harness, "Rooted")}`,
        `${at.get("b/pic.png")} attached-to ${createdFor(harness, "Case")}`,
        `${at.get("a/z/pic.png")} attached-to ${createdFor(harness, "Both")}`,
        `${at.get("b/pic.png")} attached-to ${createdFor(harness, "Both")}`,
      ].sort(),
    );
  });

  it("writes a file embedded by name where its placement already answers to the name", async () => {
    // Placed by another machine: the note in notes/, its chart in charts/,
    // and its logo under a name the embed does not answer to.
    const made = await placedEmbeds(
      "folder-embed-named-placed",
      [
        {
          id: host,
          properties: {
            title: "Host",
            body: "a chart ![[chart.png]] and a logo ![[logo.png]]\n",
          },
        },
        fileRow(chart, "chart.png", png(2)),
        fileRow(scan, "logo.png", png(3)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2ea", chart, host),
        attached("01a00000-0000-7000-8000-00000000e2ed", scan, host),
      ],
      {
        [host]: "notes/Host.md",
        [chart]: "charts/chart.png",
        [scan]: "art/other.png",
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, png(2));
    scriptBlob(harness.server, png(3));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      readFileSync(join(harness.dir, "charts", "chart.png")),
      "a file embedded by name was not written where its placement already answers to the name",
    ).toEqual(png(2));
    expect(existsSync(join(harness.dir, "notes", "chart.png"))).toBe(false);
    expect(
      readFileSync(join(harness.dir, "notes", "logo.png")),
      "a placement the name does not answer to was taken for it",
    ).toEqual(png(3));
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      harness.server.requests
        .filter(
          (request) =>
            request.pathname.startsWith("/edges") && request.method !== "GET",
        )
        .map((request) => `${request.method} ${request.pathname}`),
      "a fresh machine moved a placement the name answers to, or not the one it does not",
    ).toEqual([`PATCH /edges/${made.placements[scan] ?? ""}`]);
    expect(made.door.placements(harness.settings.id)).toEqual(
      new Map([
        [host, "notes/Host.md"],
        [chart, "charts/chart.png"],
        [scan, "notes/logo.png"],
      ]),
    );
  });

  it("writes a file embedded by name where another embed's path names it", async () => {
    // A fresh machine: nothing placed, nothing bound.
    const made = await placedEmbeds(
      "folder-embed-named-path",
      [
        {
          id: host,
          properties: { title: "One", body: "a logo ![](sub/logo.png)\n" },
        },
        {
          id: other,
          properties: { title: "Two", body: "the same ![[logo.png]]\n" },
        },
        fileRow(scan, "logo.png", png(4)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2f1", scan, host),
        attached("01a00000-0000-7000-8000-00000000e2f2", scan, other),
      ],
      {},
    );
    harness = made.harness;
    scriptBlob(harness.server, png(4));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(readFileSync(join(harness.dir, "sub", "logo.png"))).toEqual(png(4));
    expect(
      existsSync(join(harness.dir, "logo.png")),
      "a name another embed's path answers to was written beside its note",
    ).toBe(false);
    expect(pulled.value.embeds).toEqual([]);
  });

  it("follows an embedded file renamed away from its link, and says the link names nothing", async () => {
    harness = await folderHarness("folder-embed-renamed");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    put(harness, "Note.md", "---\ntitle: Note\n---\n![](a.png)\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const before = heldEdges(edges);
    expect(before).toHaveLength(1);

    renameSync(join(harness.dir, "a.png"), join(harness.dir, "renamed.png"));
    const renamed = await harness.folder.push();
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.scan.renamed).toBe(1);
    expect(existsSync(join(harness.dir, "renamed.png"))).toBe(true);
    expect(
      existsSync(join(harness.dir, "a.png")),
      "a file renamed away from its link was moved back",
    ).toBe(false);
    expect(heldEdges(edges), "the rename changed an edge").toEqual(before);
    expect(
      renamed.value.pull?.embeds,
      "a link that no longer names its file was not reported",
    ).toEqual([
      expect.objectContaining({
        path: "Note.md",
        flag: "embed",
        reason: expect.stringContaining(
          "![](a.png) names no attachment",
        ) as unknown,
      }),
    ]);
    expect(
      (
        parseYaml(frontOf(harness, "Note.md").slice(4, -4)) as Record<
          string,
          unknown
        >
      )["has-attachment"],
      "an attachment the body no longer shows is not listed",
    ).toEqual(["[[renamed.png]]"]);
    expect(renamed.value.pull?.unmatched).toBe(1);

    // The link mended, the body shows it again.
    edit(harness, "Note.md", "![](a.png)", "![](renamed.png)");
    const mended = await harness.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    if (!mended.ok) return;
    expect(mended.value.pull?.embeds).toEqual([]);
    expect(mended.value.pull?.unmatched).toBe(0);
    expect(frontOf(harness, "Note.md")).not.toContain("has-attachment");
    expect(heldEdges(edges)).toEqual(before);
    expect(sentTitles(harness)).toEqual(["Note", "a.png"]);
  });

  it("reports an embed of a file the key cannot read, and writes nothing for it", async () => {
    const secret = "01a00000-0000-7000-8000-00000000e2ff";
    const made = await edgeHarness(
      "folder-embed-unreadable",
      [
        {
          id: host,
          properties: {
            title: "Host",
            body: "![](shown.png) ![](secret.png)\n",
          },
        },
        fileRow(pic, "shown.png", png(1)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2eb", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2ec", secret, host),
      ],
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      readFileSync(join(harness.dir, "shown.png")),
      "the pull wrote no embedded file at all, so the one below is absent for nothing",
    ).toEqual(png(1));
    expect(existsSync(join(harness.dir, "secret.png"))).toBe(false);
    expect(
      pulled.value.embeds,
      "an embed of a file the key cannot read was not reported",
    ).toEqual([
      expect.objectContaining({
        path: "Host.md",
        flag: "embed",
        reason: expect.stringContaining(
          "![](secret.png) names no attachment",
        ) as unknown,
      }),
    ]);
  });

  it("holds attachments whole only where its search holds a document", async () => {
    const wholeTypes = (made: FolderHarness): Array<string | null> => [
      ...new Set(
        made.server.requests
          .filter((request) => request.pathname === "/edges")
          .map((request) => request.query.get("edge_type")),
      ),
    ];
    harness = await folderHarness("folder-embed-whole-notes");
    expect(
      wholeTypes(harness),
      "a folder of notes did not hold attached-to whole, so the check below is about nothing",
    ).toContain("attached-to");
    second = await folderHarness("folder-embed-whole-files", {
      settings: { search: { types: ["core.file"] } },
    });
    expect(
      wholeTypes(second),
      "a folder of files alone, which embeds nothing, held every attachment whole",
    ).not.toContain("attached-to");
    const every = await folderHarness("folder-embed-whole-every", {
      settings: { search: {} },
    });
    try {
      expect(
        wholeTypes(every),
        "a search naming no type, which holds notes, did not hold attachments whole",
      ).toContain("attached-to");
    } finally {
      await every.stop();
    }
  });

  it("keeps an embedded file archived elsewhere where its search holds active items only", async () => {
    const gone = "01a00000-0000-7000-8000-00000000e2f1";
    const picRow = fileRow(pic, "pic.png", png(1));
    const goneRow: WireItemOptions = {
      id: gone,
      properties: { title: "Gone", body: "archived too\n" },
    };
    const made = await edgeHarness(
      "folder-embed-archived",
      [
        { id: host, properties: { title: "Host", body: "![](pic.png)\n" } },
        goneRow,
        picRow,
      ],
      [attached("01a00000-0000-7000-8000-00000000e2f2", pic, host)],
      {
        settings: { search: { types: ["core.note"], state: ["active"] } },
        events: [
          copyReplay("3", [
            copyItemEvent(
              "2",
              "item.state_changed",
              wireItem({ ...picRow, state: "archived" }),
            ),
            copyItemEvent(
              "3",
              "item.state_changed",
              wireItem({ ...goneRow, state: "archived" }),
            ),
          ]),
        ],
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "pic.png"))).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(
      caught.ok ? caught.value.applied : 0,
      "the archives never reached the copy",
    ).toBe(2);
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      [pulled.value.removed, existsSync(join(harness.dir, "Gone.md"))],
      "a note archived beside it kept its file, so the one below is kept for nothing",
    ).toEqual([1, false]);
    expect(
      readFileSync(join(harness.dir, "pic.png")),
      "a file the note still embeds was taken away because it was archived",
    ).toEqual(png(1));
    expect(pulled.value.unmatched).toBe(0);
  });

  it("lists a trashed embedded file under has-attachment no more than a held one", async () => {
    const picRow = fileRow(pic, "pic.png", png(1));
    const made = await edgeHarness(
      "folder-embed-trashed",
      [
        { id: host, properties: { title: "Host", body: "![](pic.png)\n" } },
        picRow,
      ],
      [attached("01a00000-0000-7000-8000-00000000e2f3", pic, host)],
      {
        events: [
          copyReplay("2", [
            copyItemEvent(
              "2",
              "item.deleted",
              wireItem({ ...picRow, state: "trashed" }),
            ),
          ]),
        ],
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    expect((await harness.folder.pull()).ok).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      [pulled.value.removed, existsSync(join(harness.dir, "pic.png"))],
      "the trash never reached the folder, so what the note says below is about nothing",
    ).toEqual([1, false]);
    expect(
      frontOf(harness, "Host.md"),
      "an embedded file in the bin was listed under has-attachment beside its embed",
    ).not.toContain("has-attachment");
  });

  it("reads an embed's path whatever its case, and keeps the file's own name", async () => {
    harness = await folderHarness("folder-embed-case");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "t10.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    put(harness, "Note.md", "---\ntitle: Note\n---\n![](T10.PNG) ![](b.png)\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const note = createdFor(harness, "Note");
    const t10 = createdFor(harness, "t10.png");
    expect(
      heldEdges(edges),
      "an embed differing from its file only in case named nothing",
    ).toEqual(
      [
        `${t10} attached-to ${note}`,
        `${createdFor(harness, "b.png")} attached-to ${note}`,
      ].sort(),
    );
    expect(pushed.value.scan.embeds).toHaveLength(0);
    edit(harness, "Note.md", " ![](b.png)", "");
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(
      heldEdges(edges),
      "an embed differing from its file in case held back a removal",
    ).toEqual([`${t10} attached-to ${note}`]);
    expect(again.value.pull?.unwritten).toBe(0);
    expect(
      readdirSync(harness.dir)
        .filter((name) => name.endsWith(".png"))
        .sort(),
      "the pull wrote the file under the link's case beside its own",
    ).toEqual(["b.png", "t10.png"]);

    // A fresh machine writes it under its own name too.
    const fresh = await placedEmbeds(
      "folder-embed-case-fresh",
      [
        { id: host, properties: { title: "Host", body: "![](T10.PNG)\n" } },
        fileRow(pic, "t10.png", png(1)),
      ],
      [attached("01a00000-0000-7000-8000-00000000e2f4", pic, host)],
      { [host]: "Host.md", [pic]: "t10.png" },
    );
    const elsewhere = fresh.harness;
    second = elsewhere;
    scriptBlob(elsewhere.server, png(1));
    expect((await elsewhere.folder.pull()).ok).toBe(true);
    expect(
      readdirSync(elsewhere.dir)
        .filter((name) => !name.startsWith("."))
        .sort(),
      "a fresh machine wrote the file under the link's case",
    ).toEqual(["Host.md", "t10.png"]);
  });

  it("writes nothing for a name two attachments share, and says so", async () => {
    const twin = "01a00000-0000-7000-8000-00000000e2f5";
    const made = await edgeHarness(
      "folder-embed-shared-name",
      [
        {
          id: host,
          properties: { title: "Host", body: "![[dup.png]] ![[one.png]]\n" },
        },
        fileRow(pic, "dup.png", png(1)),
        fileRow(twin, "dup.png", png(2)),
        fileRow(chart, "one.png", png(3)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2f6", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2f7", twin, host),
        attached("01a00000-0000-7000-8000-00000000e2f8", chart, host),
      ],
    );
    harness = made.harness;
    for (const last of [1, 2, 3]) scriptBlob(harness.server, png(last));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      readFileSync(join(harness.dir, "one.png")),
      "the pull wrote no embedded file at all, so the one below is absent for nothing",
    ).toEqual(png(3));
    expect(
      existsSync(join(harness.dir, "dup.png")),
      "a name two attachments share was read as one of them",
    ).toBe(false);
    expect(pulled.value.embeds).toEqual([
      expect.objectContaining({
        path: "Host.md",
        reason: expect.stringContaining(
          "![[dup.png]] names no attachment",
        ) as unknown,
      }),
    ]);
  });

  it("writes no file a .txt file's text embeds", async () => {
    const plain = "01a00000-0000-7000-8000-00000000e2f9";
    const made = await placedEmbeds(
      "folder-embed-txt-pull",
      [
        { id: host, properties: { title: "Shown", body: "![](y.png)\n" } },
        { id: plain, properties: { title: "Plain", body: "![](x.png)\n" } },
        fileRow(pic, "y.png", png(1)),
        fileRow(chart, "x.png", png(2)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2fa", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2fb", chart, plain),
      ],
      { [host]: "Shown.md", [plain]: "Plain.txt" },
      ["core.note"],
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    scriptBlob(harness.server, png(2));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(read(harness, "Plain.txt")).toBe("![](x.png)\n");
    expect(
      readFileSync(join(harness.dir, "y.png")),
      "a Markdown file's embed wrote nothing, so the absence below says nothing",
    ).toEqual(png(1));
    expect(
      existsSync(join(harness.dir, "x.png")),
      "a .txt file's text was read as embedding a file",
    ).toBe(false);
  });

  it("removes the edge of an embed taken out between two scans before a push", async () => {
    harness = await folderHarness("folder-embed-two-scans");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    put(harness, "Note.md", "---\ntitle: Note\n---\n![](a.png)\n![](b.png)\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    edit(harness, "Note.md", "![](a.png)\n", "");
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      heldEdges(edges),
      "an embed taken out before any pull left its edge, since the scan kept no record of it",
    ).toEqual([
      `${createdFor(harness, "b.png")} attached-to ${createdFor(harness, "Note")}`,
    ]);
  });
});

describe("what frontmatter says", () => {
  it("reads type, tags, tier and state as the item's own", async () => {
    const id = "01a00000-0000-7000-8000-0000000013a1";
    harness = await folderHarness("folder-own-fields", {
      settings: {
        search: { types: ["core.note", "core.bookmark"] },
        defaults: { tags: ["inbox"] },
      },
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Held", body: "held\n" } },
            tags: ["old", "kept"],
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);

    // A pull writes them as lines of their own, the type and tier always and
    // the tags where there are any.
    const held = read(harness, "Held.md");
    expect(held).toMatch(/^type: core\.note$/m);
    expect(held).toMatch(/^tier: library$/m);
    expect(held).toContain("tags:\n  - kept\n  - old\n");
    expect(held, "an active item's file said its state").not.toMatch(
      /^state:/m,
    );

    // A new file names its own, and one naming none takes the defaults'.
    put(
      harness,
      "Saved.md",
      '---\ntype: core.bookmark\ntier: library\ntags: [read-later, web]\nstate: archived\nchild-of: "[[Held]]"\nurl: https://example.com\n---\nA page.\n',
    );
    put(harness, "Plain.md", "---\nurl: https://example.org\n---\nA note.\n");
    // A file already bound trades one tag for another.
    writeFileSync(
      join(harness.dir, "Held.md"),
      held.replace("  - old\n", "  - new\n"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);

    const creates = sentCreates(harness);
    const saved = creates.find(
      (sent) => (sent.properties as Record<string, unknown>).title === "Saved",
    );
    const plain = creates.find(
      (sent) => (sent.properties as Record<string, unknown>).title === "Plain",
    );
    expect(
      [saved?.type, saved?.tier],
      "the file's type or tier was not the item's, so the frontmatter says one thing and the item is another",
    ).toEqual(["core.bookmark", "library"]);
    expect(
      saved?.properties,
      "an own field travelled as a property, where every later pull writes it twice and a search never finds it",
    ).toEqual({
      url: "https://example.com",
      body: "A page.\n",
      title: "Saved",
    });
    expect(plain?.type, "a file naming no type took none of the defaults").toBe(
      "core.note",
    );
    const [savedId, plainId] = [String(saved?.id), String(plain?.id)];
    expect(
      sentTags(harness).sort(),
      "the tags a file names were not the item's, or a file naming its own tags took the defaults' as well, or a bound file's tag change went nowhere",
    ).toEqual(
      [
        `add ${savedId} read-later`,
        `add ${savedId} web`,
        `add ${plainId} inbox`,
        `add ${id} new`,
        `remove ${id} old`,
      ].sort(),
    );
    expect(
      sentTransitions(harness),
      "a file naming its state archived made an active item",
    ).toEqual([`${savedId} archived`]);
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id),
      "a change of tags alone went as an edit of the item's properties",
    ).toEqual([]);
    expect(rows.get(id)?.properties).toEqual({ title: "Held", body: "held\n" });
  });

  it("clears a property whose line was taken out of a versioned file", async () => {
    const id = "01a00000-0000-7000-8000-0000000013b1";
    harness = await folderHarness("folder-clears-a-line", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: {
                title: "Status",
                body: "the text\n",
                status: "draft",
                language: "en",
              },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Status.md");
    // The witness: a versioned file carrying the line to take out.
    expect(written).toMatch(/^status: draft$/m);
    expect(written).toMatch(/^marfa_version: 1$/m);

    writeFileSync(
      join(harness.dir, "Status.md"),
      written.replace("status: draft\n", ""),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(
      edit?.body.properties_mode,
      "a versioned file's edit was merged, so a line taken out of it clears nothing",
    ).toBe("replace");
    expect(
      rows.get(id)?.properties,
      "the property whose line was taken out is still on the item, and the next pull writes it back",
    ).toEqual({ title: "Status", body: "the text\n", language: "en" });
    expect(read(harness, "Status.md")).not.toMatch(/^status:/m);
  });

  it("merges an edit from a file with no version line", async () => {
    const id = "01a00000-0000-7000-8000-0000000013c1";
    harness = await folderHarness("folder-merges-a-lineless-file", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: {
                title: "Loose",
                body: "as it was\n",
                status: "draft",
              },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    // An editor that keeps no version line, and no status line either.
    writeFileSync(
      join(harness.dir, "Loose.md"),
      read(harness, "Loose.md")
        .replace(/^marfa_version: \d+\n/m, "")
        .replace("status: draft\n", "")
        .replace("as it was", "edited"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(edit, "the edit was not sent").toBeDefined();
    expect(
      edit?.body.properties_mode,
      "a file with no version line was sent as the item's whole properties, clearing every line its editor happened not to keep",
    ).toBeUndefined();
    expect(rows.get(id)?.properties).toEqual({
      title: "Loose",
      body: "edited\n",
      status: "draft",
    });
  });

  it("takes body and title from the type's display hints", async () => {
    const event = "01a00000-0000-7000-8000-0000000013d1";
    const highlight = "01a00000-0000-7000-8000-0000000013d2";
    harness = await folderHarness("folder-display-hints", {
      settings: { search: { types: ["core.event", "core.highlight"] } },
      rows: {
        "core.event": [
          {
            item: {
              id: event,
              type: "core.event",
              properties: {
                title: "Launch",
                description: "Doors at six.\n",
                starts_at: "2026-10-01T18:00:00.000Z",
              },
            },
          },
        ],
        "core.highlight": [
          {
            item: {
              id: highlight,
              type: "core.highlight",
              properties: {
                text: "A line worth keeping",
                note: "Why it matters.\n",
              },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const launch = read(harness, "Launch.md");
    expect(launch, "an event's description was not its file's body").toMatch(
      /\n---\nDoors at six\.\n$/,
    );
    expect(launch).not.toMatch(/^description:/m);
    expect(
      read(harness, "A line worth keeping.md"),
      "a highlight's file was not named by its text or its body was not its note",
    ).toMatch(/\n---\nWhy it matters\.\n$/);

    put(
      harness,
      "Party.md",
      "---\nstarts_at: 2026-10-02T18:00:00.000Z\n---\nBring food.\n",
    );
    put(
      harness,
      "Quote.md",
      "---\ntype: core.highlight\n---\nWorth a second read.\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const creates = sentCreates(harness);
    expect(
      creates.map((sent) => [sent.type, sent.properties]),
      "a file's body or name went to a fixed property rather than the one its type names",
    ).toEqual([
      [
        "core.event",
        {
          starts_at: "2026-10-02T18:00:00.000Z",
          description: "Bring food.\n",
          title: "Party",
        },
      ],
      ["core.highlight", { note: "Worth a second read.\n", text: "Quote" }],
    ]);
  });

  it("takes the display hints of the nearest type that declares any, whole, as the server resolves them", async () => {
    // A subtype naming only a body inherits no title from its parent: the
    // server's read of the type answers the subtype's block alone
    // (`types/read-display-hints`), so the folder falls back to `title`
    // (`device/catalog-type-read`).
    harness = await folderHarness("folder-partial-hints", {
      settings: { search: { types: ["user.quote"] } },
      catalog: {
        kind: "json",
        status: 200,
        body: {
          data: [
            ...SCRIPTED_TYPES,
            {
              id: "user.quote",
              parent: "core.highlight",
              label: "quote",
              version: 0,
              fields: { comment: { type: "string" } },
              display_hints: { body_field: "comment" },
            },
          ],
          next_cursor: null,
        },
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    put(
      harness,
      "Saying.md",
      "---\ntype: user.quote\ntext: Quoted\n---\nWorth it.\n",
    );
    // The witness: the parent's own hints still name its title.
    put(harness, "Line.md", "---\ntype: core.highlight\n---\nKept.\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentCreates(harness).map((sent) => [sent.type, sent.properties]),
      "a subtype naming only its body took its title field from its parent's hints, which the server's read of the type does not",
    ).toEqual([
      ["core.highlight", { note: "Kept.\n", text: "Line" }],
      [
        "user.quote",
        { comment: "Worth it.\n", text: "Quoted", title: "Saying" },
      ],
    ]);
  });

  it("reports a type that declares a property no file can carry, and keeps it", async () => {
    const id = "01a00000-0000-7000-8000-0000000013e1";
    harness = await folderHarness("folder-uncarried-property", {
      settings: { search: { types: ["user.ticket"] } },
      catalog: {
        kind: "json",
        status: 200,
        body: {
          data: [
            ...SCRIPTED_TYPES,
            wireType("user.ticket", {
              bodyField: "body",
              fields: {
                title: { type: "string" },
                body: { type: "string" },
                state: { type: "string" },
                "parent-of": { type: "string" },
              },
            }),
          ],
          next_cursor: null,
        },
      },
      rows: {
        "user.ticket": [
          {
            item: {
              id,
              type: "user.ticket",
              properties: { title: "Ticket", body: "to do\n", state: "open" },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.uncarried,
      "a property a file reads as the item's own field or an edge went unreported, so it silently never appears in a file",
    ).toEqual([
      { type: "user.ticket", property: "parent-of" },
      { type: "user.ticket", property: "state" },
    ]);
    const written = read(harness, "Ticket.md");
    expect(
      written,
      "the property was written as a line the next read takes as the item's state",
    ).not.toMatch(/^state:/m);

    // An edit of a versioned file leaves it on the item: no file carries it,
    // so no line was taken out.
    writeFileSync(
      join(harness.dir, "Ticket.md"),
      written.replace("to do", "done"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(rows.get(id)?.properties).toEqual({
      title: "Ticket",
      body: "done\n",
      state: "open",
    });
  });

  it("retypes an item whose frontmatter changes its type", async () => {
    const id = "01a00000-0000-7000-8000-0000000013f1";
    harness = await folderHarness("folder-retype", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Link", body: "a page\n" } } },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "Link.md"),
      read(harness, "Link.md").replace(
        "type: core.note",
        "type: core.bookmark",
      ),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(
      [edit?.body.type, edit?.body.retype],
      "the type line did not move the item, so the frontmatter names one type and the item is another",
    ).toEqual(["core.bookmark", true]);
    expect(
      (edit?.body.properties as Record<string, unknown> | undefined)?.type,
      "the type travelled as a property",
    ).toBeUndefined();
    expect(rows.get(id)?.type).toBe("core.bookmark");
    expect(read(harness, "Link.md")).toMatch(/^type: core\.bookmark$/m);
  });

  it("flags a refused retype and keeps the file", async () => {
    const id = "01a00000-0000-7000-8000-000000001401";
    const tagged = "01a00000-0000-7000-8000-000000001402";
    const shelving = "01a00000-0000-7000-8000-000000001403";
    harness = await folderHarness("folder-retype-refused", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Link", body: "a page\n" } } },
          {
            item: { id: tagged, properties: { title: "Tagged", body: "t\n" } },
          },
          {
            item: {
              id: shelving,
              properties: { title: "Shelving", body: "s\n" },
            },
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
      tagging: (request) =>
        request.pathname.includes(tagged)
          ? refusal(403, "type_not_permitted", "No tags here")
          : undefined,
    });
    const update = door!.update.bind(door!);
    door!.update = ((...args: Parameters<FolderDoor["update"]>) =>
      args[1].retype === true
        ? refusal(
            403,
            "type_not_permitted",
            "This credential may not write core.bookmark",
          )
        : update(...args)) as FolderDoor["update"];
    door!.transition = () =>
      refusal(400, "invalid_transition", "Not from here");
    expect((await harness.folder.pull()).ok).toBe(true);
    const retyped = read(harness, "Link.md")
      .replace("type: core.note", "type: core.bookmark")
      .replace("a page", "a page, bookmarked");
    writeFileSync(join(harness.dir, "Link.md"), retyped);
    // Any other write from a file the server refuses holds it the same way.
    const tagging = read(harness, "Tagged.md").replace(
      "tier: library\n",
      "tier: library\ntags:\n  - secret\n",
    );
    writeFileSync(join(harness.dir, "Tagged.md"), tagging);
    const shelved = read(harness, "Shelving.md").replace(
      "tier: library\n",
      "tier: library\nstate: archived\n",
    );
    writeFileSync(join(harness.dir, "Shelving.md"), shelved);

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id).length,
      "the retype never reached the server, so nothing here was refused",
    ).toBe(1);
    expect(rows.get(id)?.type).toBe("core.note");
    expect(
      read(harness, "Link.md"),
      "the pull wrote the item over the person's retype, so what they wrote is gone and nothing says why",
    ).toBe(retyped);
    expect(
      pushed.value.pull?.flagged,
      "the file was kept without saying why",
    ).toEqual([
      expect.objectContaining({
        path: "Link.md",
        flag: "refused",
        reason:
          "type_not_permitted: This credential may not write core.bookmark",
      }),
      expect.objectContaining({ path: "Shelving.md", flag: "refused" }),
      expect.objectContaining({ path: "Tagged.md", flag: "refused" }),
    ]);
    expect(read(harness, "Tagged.md")).toBe(tagging);
    expect(read(harness, "Shelving.md")).toBe(shelved);

    // Not sent again while the file stays as it is.
    const again = await harness.folder.push();
    expect(again.ok).toBe(true);
    expect(sentUpdates(harness).filter((sent) => sent.id === id).length).toBe(
      1,
    );
    expect(read(harness, "Link.md")).toBe(retyped);
  });

  it("holds a file whose frontmatter does not parse", async () => {
    const id = "01a00000-0000-7000-8000-000000001411";
    harness = await folderHarness("folder-unreadable-frontmatter", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Held", body: "as it was\n" } } },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Held.md");
    const broken = written
      .replace("title: Held", "title: [Held")
      .replace("as it was", "edited");
    writeFileSync(join(harness.dir, "Held.md"), broken);
    put(harness, "New.md", "---\ntitle: New\n  bad: indent\n---\nbody\n");
    put(harness, "Tier.md", "---\ntitle: Tier\ntier: attic\n---\nbody\n");
    put(
      harness,
      "Merged.md",
      "---\nbase: &b {x: 1}\nmerged:\n  <<: *b\n---\nbody\n",
    );
    put(harness, "Keyed.md", "---\n1: one\n---\nbody\n");
    // Empty text is neither a tag nor a state, so these are held; only YAML's
    // null means none.
    put(
      harness,
      "EmptyTags.md",
      '---\ntitle: EmptyTags\ntags: ""\n---\nbody\n',
    );
    put(
      harness,
      "EmptyState.md",
      '---\ntitle: EmptyState\nstate: ""\n---\nbody\n',
    );
    // The witness: a new file that parses, in the same push, is sent.
    put(harness, "Readable.md", "---\ntitle: Readable\n---\nbody\n");

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [sentUpdates(harness).length, sentTitles(harness)],
      "frontmatter that does not parse was sent, its lines as body text or its fields lost",
    ).toEqual([0, ["Readable"]]);
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
    ).toEqual([
      ["EmptyState.md", "unreadable"],
      ["EmptyTags.md", "unreadable"],
      ["Held.md", "unreadable"],
      ["Keyed.md", "unreadable"],
      ["Merged.md", "unreadable"],
      ["New.md", "unreadable"],
      ["Tier.md", "unreadable"],
    ]);
    expect(
      pushed.value.scan.flagged.find((file) => file.path === "Tier.md")?.reason,
    ).toContain("attic");
    // Every pull says so while the file is held, with the reason.
    const pulled = await harness.folder.pull();
    expect(pulled.ok && pulled.value.flagged).toEqual([
      expect.objectContaining({
        path: "Held.md",
        flag: "unreadable",
        reason: expect.any(String) as unknown,
      }),
    ]);
    expect(
      read(harness, "Held.md"),
      "the pull wrote the item over the person's unreadable file",
    ).toBe(broken);
    expect(rows.get(id)?.properties.body).toBe("as it was\n");

    // Moved while unreadable, it is still that item's file; the witness is
    // a readable file taken out in the same pass, which is missing.
    renameSync(join(harness.dir, "Held.md"), join(harness.dir, "Moved.md"));
    rmSync(join(harness.dir, "Readable.md"));
    const moved = await harness.folder.push();
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.scan.missing).toBe(1);
    expect(sentUpdates(harness)).toEqual([]);

    // Mended, it is sent.
    writeFileSync(
      join(harness.dir, "Moved.md"),
      broken.replace("title: [Held", "title: Held"),
    );
    const mended = await harness.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    // The witness to every absent update above: once it parses, it is sent.
    expect(sentUpdates(harness).map((sent) => sent.id)).toEqual([id]);
    expect(rows.get(id)?.properties.body).toBe("edited\n");
    expect(
      mended.ok && mended.value.pull?.flagged,
      "a mended file stayed flagged",
    ).toEqual([]);
    expect(
      read(harness, "Moved.md"),
      "the pull did not write the mended file again",
    ).toMatch(/^marfa_version: 2$/m);
  });

  it("sends no own-field change from an old buffer, and flags the lines it would have changed", async () => {
    const id = "01a00000-0000-7000-8000-000000001431";
    const moved = {
      id,
      version: 2,
      type: "core.bookmark",
      properties: { title: "Link", body: "as read\n" },
    };
    harness = await folderHarness("folder-own-fields-stale", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Link", body: "as read\n" } },
            tags: ["a"],
          },
        ],
      },
      events: [
        copyLiveReplay("2", [
          copyItemEvent("2", "item.updated", wireItem(moved), {
            tags: ["a", "b"],
          }),
        ]),
      ],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Link.md");
    // Another machine retypes it and tags it meanwhile.
    door!.update(id, {
      properties: {},
      type: "core.bookmark",
      retype: true,
      version: 1,
    });
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the pull wrote the other machine's type and tag out.
    expect(read(harness, "Link.md")).toMatch(/^type: core\.bookmark$/m);
    expect(read(harness, "Link.md")).toContain("  - b\n");

    // An editor that never reloaded saves its old buffer, with an edit.
    put(harness, "Link.md", held.replace("as read", "my edit"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "the old buffer's own-field lines went unsent without a word",
    ).toEqual([["Link.md", "behind"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toMatch(/type, tags/);
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(
      edit?.body.version,
      "the edit went on a version it was not made against",
    ).toBe(1);
    expect(
      edit?.body.retype,
      "the old buffer's type line moved the item back over the other machine's retype",
    ).toBeUndefined();
    expect(
      sentTags(harness),
      "the old buffer took away a tag another machine added, which it never saw",
    ).toEqual([]);
    expect(rows.get(id)).toMatchObject({
      type: "core.bookmark",
      properties: { title: "Link", body: "my edit\n" },
    });
  });

  it("keeps an archived item's file with its state in the frontmatter", async () => {
    const archived = "01a00000-0000-7000-8000-000000001421";
    const active = "01a00000-0000-7000-8000-000000001422";
    harness = await folderHarness("folder-archived-state", {
      rows: {
        "core.note": [
          {
            item: {
              id: archived,
              state: "archived",
              properties: { title: "Shelved", body: "old\n" },
            },
            tags: ["kept"],
          },
          {
            item: {
              id: active,
              properties: { title: "Current", body: "new\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const shelved = read(harness, "Shelved.md");
    expect(
      shelved,
      "an archived item's file does not say so, so an edit of it cannot tell an archived item from an active one",
    ).toMatch(/^state: archived$/m);
    expect(
      [...shelved.matchAll(/^([a-z_]+):/gm)].map((found) => found[1]),
      "the item's own fields were not written first, in their order",
    ).toEqual([
      "type",
      "tier",
      "tags",
      "state",
      "title",
      "marfa_id",
      "marfa_version",
    ]);
    expect(read(harness, "Current.md")).not.toMatch(/^state:/m);

    // Taking the line out restores it, and writing it archives the other.
    writeFileSync(
      join(harness.dir, "Shelved.md"),
      shelved.replace("state: archived\n", ""),
    );
    writeFileSync(
      join(harness.dir, "Current.md"),
      read(harness, "Current.md").replace(
        "tier: library\n",
        "tier: library\nstate: archived\n",
      ),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentTransitions(harness).sort()).toEqual(
      [`${archived} active`, `${active} archived`].sort(),
    );
    expect(
      existsSync(join(harness.dir, "Current.md")),
      "the file of an item archived from it went",
    ).toBe(true);
    expect(read(harness, "Current.md")).toMatch(/^state: archived$/m);
  });

  it("keeps every save of three scanned before one drain", async () => {
    const id = "01a00000-0000-7000-8000-000000001441";
    harness = await folderHarness("folder-three-saves", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Three", body: "one\n" } } },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Three.md");
    // Each save scanned on its own, so three whole edits wait together.
    for (const text of [
      written.replace("one\n", "two\n"),
      written
        .replace("one\n", "two\n")
        .replace("title: Three\n", "title: Three\nlang: fr\n"),
      written
        .replace("one\n", "three\n")
        .replace("title: Three\n", "title: Three\nlang: fr\n"),
    ]) {
      put(harness, "Three.md", text);
      expect((await harness.folder.scan()).ok).toBe(true);
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id).length,
      "the three saves did not go as three edits, so nothing here moved one onto another",
    ).toBe(3);
    expect(
      rows.get(id)?.properties,
      "a later save moved onto an earlier one's answer undid a line the person wrote",
    ).toEqual({ title: "Three", body: "three\n", lang: "fr" });
    expect(read(harness, "Three.md")).toMatch(/^lang: fr$/m);
  });

  it("leaves a tag and an archive made elsewhere alone when an old buffer is saved", async () => {
    const id = "01a00000-0000-7000-8000-000000001451";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-old-buffer-tags", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Kept", body: "as read\n" } },
            tags: ["a"],
          },
        ],
      },
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Kept.md");
    // Another machine tags it and archives it, neither a version step.
    const row = door!.rows.get(id)!;
    door!.rows.set(id, { ...row, tags: ["a", "b"] });
    edges.logItem(
      "metadata.changed",
      answers.updated(door!.wire(id), ["a", "b"]),
    );
    edges.logItem("item.state_changed", door!.transition(id, "archived"));
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the pull wrote the tag and the state out at one version.
    const rewritten = read(harness, "Kept.md");
    expect(rewritten).toContain("  - b\n");
    expect(rewritten).toMatch(/^state: archived$/m);
    expect(rewritten).toMatch(/^marfa_version: 1$/m);

    put(harness, "Kept.md", held.replace("as read", "my edit"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id).length,
      "the old buffer's edit never went, so nothing here was read against it",
    ).toBe(1);
    expect(
      sentTags(harness),
      "the old buffer took away a tag another machine added, which it never saw",
    ).toEqual([]);
    expect(
      sentTransitions(harness),
      "the old buffer brought back an item another machine archived",
    ).toEqual([]);
    expect(door!.rows.get(id)?.properties.body).toBe("my edit\n");
    expect(
      pushed.ok && pushed.value.scan.flagged.map((file) => file.reason),
      "the old buffer's own-field lines went unsent without a word",
    ).toEqual([expect.stringMatching(/tag b, state not sent/)]);
  });

  it("keeps both body fields' text when a retype moves the body to another", async () => {
    const bookmark = "01a00000-0000-7000-8000-000000001471";
    const event = "01a00000-0000-7000-8000-000000001472";
    const plain = "01a00000-0000-7000-8000-000000001473";
    harness = await folderHarness("folder-retype-body-fields", {
      settings: {
        search: { types: ["core.note", "core.bookmark", "core.event"] },
      },
      rows: {
        "core.bookmark": [
          {
            item: {
              id: bookmark,
              type: "core.bookmark",
              properties: {
                title: "Mark",
                description: "what the page says",
                body: "my notes\n",
              },
            },
          },
        ],
        "core.event": [
          {
            item: {
              id: event,
              type: "core.event",
              properties: {
                title: "Meet",
                description: "the details\n",
                body: "an old note",
              },
            },
          },
        ],
        "core.note": [
          {
            item: { id: plain, properties: { title: "Plain", body: "text\n" } },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    for (const [name, from, to] of [
      ["Mark.md", "core.bookmark", "core.event"],
      ["Meet.md", "core.event", "core.note"],
      ["Plain.md", "core.note", "core.event"],
    ]) {
      writeFileSync(
        join(harness.dir, name),
        read(harness, name).replace(`type: ${from}`, `type: ${to}`),
      );
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      [rows.get(bookmark)?.type, rows.get(event)?.type],
      "the retypes did not land, so nothing here moved a body",
    ).toEqual(["core.event", "core.note"]);
    expect(
      rows.get(bookmark)?.properties,
      "the file's body went over the line the new type keeps its body in, or left the old body field",
    ).toEqual({
      title: "Mark",
      description: "what the page says",
      body: "my notes\n",
    });
    expect(
      rows.get(event)?.properties,
      "the file's body went over the line the new type keeps its body in, or left the old body field",
    ).toEqual({
      title: "Meet",
      description: "the details\n",
      body: "an old note",
    });
    expect(
      rows.get(plain)?.properties,
      "with no line of its own, the new body field did not take the body",
    ).toEqual({ title: "Plain", body: "text\n", description: "text\n" });
  });

  it("reads a file the folder never wrote own lines into as leaving them as they are", async () => {
    const id = "01a00000-0000-7000-8000-000000001481";
    const named = "01a00000-0000-7000-8000-000000001482";
    harness = await folderHarness("folder-own-lines-unwritten", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          {
            item: {
              id,
              state: "archived",
              properties: { title: "Older", body: "as it was\n" },
            },
            tags: ["a"],
          },
          { item: { id: named, properties: { title: "Named", body: "n\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    // A file written before its folder wrote own lines, with a version line
    // and none of them.
    put(
      harness,
      "Older.md",
      `---\ntitle: Older\nmarfa_id: ${id}\nmarfa_version: 1\n---\nedited\n`,
    );
    // One that names its own fields sends them, as a current file does.
    put(
      harness,
      "Named.md",
      `---\ntype: core.bookmark\ntags: [fresh]\ntitle: Named\nmarfa_id: ${named}\nmarfa_version: 1\n---\nn\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id).length,
      "the edit was not sent, so nothing here was read",
    ).toBe(1);
    expect(
      [sentTags(harness), sentTransitions(harness)],
      "lines the file never carried took the item's tags away or brought it back from the archive",
    ).toEqual([[`add ${named} fresh`], []]);
    expect(
      sentUpdates(harness).find((sent) => sent.id === named)?.body.retype,
      "a current file's type line, never written by this folder, did not retype",
    ).toBe(true);
  });

  it("reads own-field lines in each form a file can hold them", async () => {
    const shelved = "01a00000-0000-7000-8000-0000000014d1";
    const trashing = "01a00000-0000-7000-8000-0000000014d2";
    harness = await folderHarness("folder-own-forms", {
      rows: {
        "core.note": [
          {
            item: {
              id: shelved,
              state: "archived",
              properties: { title: "Shelved", body: "s\n" },
            },
          },
          {
            item: { id: trashing, properties: { title: "Trash", body: "t\n" } },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    put(harness, "One.md", "---\ntags: solo\n---\nbody\n");
    put(harness, "Commas.md", "---\ntags: x, y\n---\nbody\n");
    put(harness, "None.md", "---\ntags:\n---\nbody\n");
    for (const [name, line] of [
      ["Shape.md", "tags: {a: 1}"],
      ["Number.md", "tags: [1]"],
      ["Untyped.md", "type:"],
    ]) {
      put(harness, name!, `---\n${line}\n---\nbody\n`);
    }
    writeFileSync(
      join(harness.dir, "Shelved.md"),
      read(harness, "Shelved.md").replace("state: archived", "state:"),
    );
    writeFileSync(
      join(harness.dir, "Trash.md"),
      read(harness, "Trash.md").replace(
        "tier: library\n",
        "tier: library\nstate: trashed\n",
      ),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const byTitle = new Map(
      sentCreates(harness).map((sent) => [
        String((sent.properties as Record<string, unknown>).title),
        String(sent.id),
      ]),
    );
    expect(
      sentTags(harness).sort(),
      "a tags line of one tag, of tags separated by commas, or empty was misread",
    ).toEqual(
      [
        `add ${byTitle.get("One")} solo`,
        `add ${byTitle.get("Commas")} x`,
        `add ${byTitle.get("Commas")} y`,
      ].sort(),
    );
    expect(
      sentTransitions(harness),
      "an empty state line did not bring the item back to active, or a trashed state line moved the item",
    ).toEqual([`${shelved} active`]);
    expect(
      harness.server.requests.filter((request) =>
        request.pathname.endsWith("/restore"),
      ),
      "a state line naming the bin restored or trashed something",
    ).toEqual([]);
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]).sort(),
    ).toEqual(
      [
        ["Number.md", "unreadable"],
        ["Shape.md", "unreadable"],
        ["Trash.md", "unreadable"],
        ["Untyped.md", "unreadable"],
      ].sort(),
    );
  });

  describe("an occurred_at line", () => {
    /** The creates a push sent, by title. */
    function createdBy(
      harness: FolderHarness,
    ): Map<string, Record<string, unknown>> {
      return new Map(
        sentCreates(harness).map((sent) => [
          String((sent.properties as Record<string, unknown>).title),
          sent,
        ]),
      );
    }

    it("sets a new item's own time, from a date or from a date and time", async () => {
      harness = await folderHarness("folder-occurred-at-create");
      scriptFolderWrites(harness);
      put(
        harness,
        "Day.md",
        "---\noccurred_at: 2026-10-06 # the day\n---\nd\n",
      );
      put(
        harness,
        "Moment.md",
        "---\noccurred_at: 2026-10-06T09:30:00+01:00\n---\nm\n",
      );
      put(
        harness,
        "Quoted.md",
        '---\noccurred_at: "2026-10-06T09:30:00"\n---\nq\n',
      );
      put(harness, "Plain.md", "---\ntitle: Plain\n---\np\n");
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      const created = createdBy(harness);
      expect(
        created.get("Day")?.occurred_at,
        "a date line did not set the item's own time",
      ).toBe("2026-10-06T00:00:00.000Z");
      expect(created.get("Moment")?.occurred_at).toBe(
        "2026-10-06T08:30:00.000Z",
      );
      expect(
        created.get("Quoted")?.occurred_at,
        "a date and time with no offset is read as UTC",
      ).toBe("2026-10-06T09:30:00.000Z");
      expect(
        "occurred_at" in (created.get("Plain") ?? {}),
        "a file with no line gave the item a time of its own",
      ).toBe(false);
      for (const sent of created.values()) {
        expect(
          (sent.properties as Record<string, unknown>).occurred_at,
          "the line was also sent as a property, which no type declares",
        ).toBeUndefined();
      }
      // Read back as the text the person wrote, comment and all, and none
      // written into the file that carried none.
      expect(read(harness, "Day.md")).toContain(
        "occurred_at: 2026-10-06 # the day\n",
      );
      expect(read(harness, "Moment.md")).toContain(
        "occurred_at: 2026-10-06T09:30:00+01:00\n",
      );
      expect(read(harness, "Plain.md")).not.toContain("occurred_at");
    });

    it("flags a line that is no time, and sends nothing for the file", async () => {
      harness = await folderHarness("folder-occurred-at-unreadable");
      scriptFolderWrites(harness);
      for (const [name, line] of [
        ["Words.md", "occurred_at: yesterday"],
        ["Month.md", "occurred_at: 2026-13-45"],
        ["Number.md", "occurred_at: 20261006"],
        ["List.md", "occurred_at: [2026-10-06]"],
      ]) {
        put(harness, name!, `---\ntitle: ${name}\n${line}\n---\nbody\n`);
      }
      put(
        harness,
        "Fine.md",
        "---\ntitle: Fine\noccurred_at: 2026-10-06\n---\nok\n",
      );
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (!pushed.ok) return;
      expect(
        pushed.value.scan.flagged.map((file) => [file.path, file.flag]).sort(),
      ).toEqual(
        ["List.md", "Month.md", "Number.md", "Words.md"].map((name) => [
          name,
          "unreadable",
        ]),
      );
      expect(
        [...createdBy(harness).keys()],
        "a file whose occurred_at is no time was sent, as an item with a bad property or with the wrong time",
      ).toEqual(["Fine"]);
    });

    it("takes a blank line as no time, and leaves it blank", async () => {
      harness = await folderHarness("folder-occurred-at-blank");
      scriptFolderWrites(harness);
      put(harness, "Blank.md", "---\ntitle: Blank\noccurred_at:\n---\nb\n");
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (!pushed.ok) return;
      expect(
        pushed.value.scan.flagged,
        "a template's empty date was flagged unreadable",
      ).toEqual([]);
      const [sent] = sentCreates(harness);
      expect((sent?.properties as Record<string, unknown>).title).toBe("Blank");
      expect("occurred_at" in (sent ?? {})).toBe(false);
      expect(
        (sent?.properties as Record<string, unknown>).occurred_at,
        "a blank line was sent as a property",
      ).toBeUndefined();
      expect(read(harness, "Blank.md")).toContain("occurred_at:\n");
      expect(sentUpdates(harness)).toEqual([]);
    });

    it("writes the line for an item whose time is its own, and none for one never set", async () => {
      const set = {
        id: "01a00000-0000-7000-8000-000000001801",
        created_at: "2026-09-01T10:00:00.000Z",
        occurred_at: "2026-10-06T00:00:00.000Z",
        properties: { title: "Set", body: "s\n" },
      };
      const never = {
        id: "01a00000-0000-7000-8000-000000001802",
        created_at: "2026-09-01T10:00:00.000Z",
        occurred_at: "2026-09-01T10:00:00.000Z",
        properties: { title: "Never", body: "n\n" },
      };
      harness = await folderHarness("folder-occurred-at-pull", {
        rows: { "core.note": [{ item: set }, { item: never }] },
      });
      scriptFolderWrites(harness);
      expect((await harness.folder.pull()).ok).toBe(true);
      expect(
        read(harness, "Set.md"),
        "an item with a time of its own was written without it",
      ).toContain('occurred_at: "2026-10-06T00:00:00.000Z"\n');
      expect(
        read(harness, "Never.md"),
        "an item whose time was never set was given a line, which the next save would send back as a time of its own",
      ).not.toContain("occurred_at");
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        [sentUpdates(harness), sentCreates(harness)],
        "a file the pull wrote was sent back as an edit",
      ).toEqual([[], []]);
    });

    it("follows a time changed elsewhere, and keeps a line in another spelling of the same time", async () => {
      const item = {
        id: "01a00000-0000-7000-8000-000000001804",
        created_at: "2026-09-01T10:00:00.000Z",
        occurred_at: "2026-10-06T00:00:00.000Z",
        properties: { title: "Moving", body: "m\n" },
      };
      harness = await folderHarness("folder-occurred-at-follows", {
        rows: { "core.note": [{ item }] },
        events: [
          copyReplay("2", [
            copyItemEvent(
              "2",
              "item.updated",
              wireItem({
                ...item,
                version: 2,
                occurred_at: "2026-10-09T12:00:00.000Z",
              }),
            ),
          ]),
        ],
      });
      scriptFolderWrites(harness);
      expect((await harness.folder.pull()).ok).toBe(true);
      // Typed in another spelling of the same time, then moved elsewhere.
      writeFileSync(
        join(harness.dir, "Moving.md"),
        read(harness, "Moving.md").replace(
          'occurred_at: "2026-10-06T00:00:00.000Z"',
          "occurred_at: 2026-10-06 # when it happened",
        ),
      );
      expect((await harness.folder.scan()).ok).toBe(true);
      expect(sentUpdates(harness)).toEqual([]);
      expect((await harness.folder.device().catchUp()).ok).toBe(true);
      expect((await harness.folder.pull()).ok).toBe(true);
      expect(
        read(harness, "Moving.md"),
        "a time changed elsewhere was not written over the line",
      ).toContain('occurred_at: "2026-10-09T12:00:00.000Z" # when it happened');
      expect((await harness.folder.scan()).ok).toBe(true);
      expect(
        sentUpdates(harness),
        "the pull's own write was sent back",
      ).toEqual([]);
    });

    it("sends an edit of the line, and nothing for another spelling of the same time", async () => {
      harness = await folderHarness("folder-occurred-at-edit");
      scriptFolderWrites(harness);
      put(
        harness,
        "Day.md",
        "---\ntitle: Day\noccurred_at: 2026-10-06\n---\nd\n",
      );
      expect((await harness.folder.push()).ok).toBe(true);
      expect(sentUpdates(harness)).toEqual([]);

      // The same instant, written another way: a reformatting.
      writeFileSync(
        join(harness.dir, "Day.md"),
        read(harness, "Day.md").replace(
          "occurred_at: 2026-10-06",
          "occurred_at: 2026-10-06T01:00:00+01:00",
        ),
      );
      expect((await harness.folder.push()).ok).toBe(true);
      expect(
        sentUpdates(harness),
        "another spelling of the item's time was sent as an edit",
      ).toEqual([]);

      writeFileSync(
        join(harness.dir, "Day.md"),
        read(harness, "Day.md").replace(
          "occurred_at: 2026-10-06T01:00:00+01:00",
          "occurred_at: 2026-10-07",
        ),
      );
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      const [sent] = sentUpdates(harness);
      expect(
        sent?.body.occurred_at,
        "an edit of the line did not move the item's time",
      ).toBe("2026-10-07T00:00:00.000Z");
      expect(
        (sent?.body.properties as Record<string, unknown>).occurred_at,
        "the edited line was sent as a property too",
      ).toBeUndefined();
      expect(read(harness, "Day.md")).toContain("occurred_at: 2026-10-07\n");

      // A line taken out sets nothing and clears nothing: an item has no
      // time to fall back to but the one it holds.
      writeFileSync(
        join(harness.dir, "Day.md"),
        read(harness, "Day.md").replace("occurred_at: 2026-10-07\n", ""),
      );
      expect((await harness.folder.push()).ok).toBe(true);
      expect(
        sentUpdates(harness).length,
        "a line taken out was sent as an edit",
      ).toBe(1);
    });

    it("sends no time from a file behind the item, and flags the line", async () => {
      const item = {
        id: "01a00000-0000-7000-8000-000000001803",
        created_at: "2026-09-01T10:00:00.000Z",
        occurred_at: "2026-10-06T00:00:00.000Z",
        properties: { title: "Behind", body: "b\n" },
      };
      harness = await folderHarness("folder-occurred-at-behind", {
        rows: { "core.note": [{ item }] },
        events: [
          copyReplay("2", [
            copyItemEvent(
              "2",
              "item.updated",
              wireItem({
                ...item,
                version: 2,
                occurred_at: "2026-10-09T00:00:00.000Z",
                properties: { title: "Behind", body: "b\nmore\n" },
              }),
            ),
          ]),
        ],
      });
      scriptFolderWrites(harness);
      expect((await harness.folder.pull()).ok).toBe(true);
      const old = read(harness, "Behind.md");
      expect((await harness.folder.device().catchUp()).ok).toBe(true);
      // An old buffer, saved over the version another machine moved on.
      writeFileSync(
        join(harness.dir, "Behind.md"),
        old.replace(
          'occurred_at: "2026-10-06T00:00:00.000Z"',
          "occurred_at: 2026-10-01",
        ),
      );
      const scanned = await harness.folder.scan();
      expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
      if (!scanned.ok) return;
      expect(
        scanned.value.flagged.map((file) => [file.path, file.flag]),
        "an old buffer's time was sent, or went unsaid",
      ).toEqual([["Behind.md", "behind"]]);
      expect(scanned.value.flagged[0]?.reason).toContain("occurred_at");
      expect(sentUpdates(harness)).toEqual([]);
    });
  });

  it("sends nothing for a save that only reformats the frontmatter", async () => {
    const id = "01a00000-0000-7000-8000-0000000014e1";
    harness = await folderHarness("folder-reformat", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "b\n", status: "s" } },
            tags: ["a"],
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const lines = read(harness, "T.md").split("\n");
    const end = lines.indexOf("---", 1);
    const front = lines.slice(1, end);
    const own = (line: string) => /^(type|tier|tags|  - )/.test(line);
    writeFileSync(
      join(harness.dir, "T.md"),
      [
        "---",
        ...front
          .filter((line) => !own(line))
          .map((line) => line.replace("title: T", 'title: "T"')),
        ...front.filter(own),
        ...lines.slice(end),
      ].join("\n"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      [sentUpdates(harness), sentTags(harness)],
      "a save that only moved and quoted lines sent an edit",
    ).toEqual([[], []]);
  });

  it("sends a tag the person adds and then takes out again at one version", async () => {
    const id = "01a00000-0000-7000-8000-0000000014f1";
    harness = await folderHarness("folder-tag-add-remove", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "b\n" } },
            tags: ["a"],
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "T.md");
    writeFileSync(
      join(harness.dir, "T.md"),
      written.replace("  - a\n", "  - a\n  - x\n"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    writeFileSync(join(harness.dir, "T.md"), written);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTags(harness),
      "the person's own tag, added and taken out at one version, was not taken out",
    ).toEqual([`add ${id} x`, `remove ${id} x`]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
  });

  it("does not re-archive from a buffer written before a restore elsewhere", async () => {
    const id = "01a00000-0000-7000-8000-000000001501";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-restore-elsewhere", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "T", body: "as read\n" } } },
        ],
      },
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const oldest = read(harness, "T.md");
    edges.logItem("item.state_changed", door!.transition(id, "archived"));
    expect((await harness.folder.push()).ok).toBe(true);
    const archivedBuffer = read(harness, "T.md");
    expect(archivedBuffer).toMatch(/^state: archived$/m);
    edges.logItem("item.state_changed", door!.transition(id, "active"));
    expect((await harness.folder.push()).ok).toBe(true);
    // A buffer of each write saved over the file, one after the other.
    put(harness, "T.md", oldest.replace("as read", "edit one"));
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "T.md", archivedBuffer.replace("as read", "edit two"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTransitions(harness),
      "a buffer written before the restore archived the item again",
    ).toEqual([]);
    expect(door!.rows.get(id)?.state).toBe("active");
    expect(
      pushed.ok && pushed.value.scan.flagged.map((file) => file.flag),
    ).toEqual(["behind"]);
  });

  it("sends no tag change from an old buffer however many tag writes came at one version", async () => {
    const id = "01a00000-0000-7000-8000-000000001511";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-many-tag-writes", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "as read\n" } },
            tags: ["a"],
          },
        ],
      },
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "T.md");
    const tags = ["a"];
    for (let n = 1; n <= 9; n += 1) {
      tags.push(`c${n}`);
      const row = door!.rows.get(id)!;
      door!.rows.set(id, { ...row, tags: [...tags] });
      edges.logItem(
        "metadata.changed",
        answers.updated(door!.wire(id), [...tags]),
      );
      expect((await harness.folder.push()).ok).toBe(true);
    }
    put(harness, "T.md", held.replace("as read", "my edit"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTags(harness),
      "an old buffer took away tags another machine added at its version",
    ).toEqual([]);
    expect(door!.rows.get(id)?.tags).toEqual(tags);
  });

  it("reads a quoted version line as the version, and a removed one as no version", async () => {
    const quoted = "01a00000-0000-7000-8000-000000001521";
    const removed = "01a00000-0000-7000-8000-000000001522";
    const decimal = "01a00000-0000-7000-8000-000000001523";
    const ahead = "01a00000-0000-7000-8000-000000001524";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-quoted-version", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          {
            item: { id: quoted, properties: { title: "Q", body: "as read\n" } },
          },
          {
            item: {
              id: removed,
              properties: { title: "R", body: "as read\n" },
            },
          },
          {
            item: {
              id: decimal,
              properties: { title: "D", body: "as read\n" },
            },
          },
          {
            item: { id: ahead, properties: { title: "A", body: "as read\n" } },
          },
        ],
      },
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const buffers = {
      "Q.md": read(harness, "Q.md").replace(
        /^marfa_version: (\d+)$/m,
        'marfa_version: "$1"',
      ),
      "R.md": read(harness, "R.md").replace(/^marfa_version: \d+\n/m, ""),
    };
    const own = {
      "D.md": read(harness, "D.md").replace(
        /^marfa_version: (\d+)$/m,
        "marfa_version: $1.0",
      ),
      "A.md": read(harness, "A.md")
        .replace(/^marfa_version: \d+$/m, "marfa_version: 7")
        .replace("type: core.note", "type: core.bookmark"),
    };
    for (const id of [quoted, removed]) {
      edges.logItem(
        "item.updated",
        door!.update(id, {
          properties: {},
          type: "core.bookmark",
          retype: true,
          version: 1,
        }),
      );
    }
    expect((await harness.folder.push()).ok).toBe(true);
    for (const [name, text] of Object.entries({ ...buffers, ...own })) {
      put(harness, name, text.replace("as read", "my edit"));
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).filter((sent) => sent.body.retype === true),
      "an old buffer whose version line was quoted or taken out moved the item back to the type it showed",
    ).toEqual([]);
    expect([rows.get(quoted)?.type, rows.get(removed)?.type]).toEqual([
      "core.bookmark",
      "core.bookmark",
    ]);
    expect(
      sentUpdates(harness).find((sent) => sent.id === quoted)?.body.version,
      "a quoted version line was not read as the version the edit was based on",
    ).toBe(1);
    expect(
      sentUpdates(harness).find((sent) => sent.id === decimal)?.body
        .properties_mode,
      "a version line written 1.0 was not read as the version the copy holds",
    ).toBe("replace");
    expect(
      pushed.ok &&
        pushed.value.scan.flagged.find((file) => file.path === "A.md")?.reason,
      "a line ahead of the copy was not said to be one",
    ).toMatch(/names a version this copy does not hold/);
  });

  it("lets a file go once a later save lands after a refused one", async () => {
    const id = "01a00000-0000-7000-8000-000000001531";
    harness = await folderHarness("folder-refused-then-landed", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          { item: { id, properties: { title: "T", body: "as read\n" } } },
        ],
      },
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    const update = door!.update.bind(door!);
    door!.update = ((...args: Parameters<FolderDoor["update"]>) =>
      args[1].retype === true && args[1].type === "core.bookmark"
        ? refusal(403, "type_not_permitted", "no bookmarks")
        : update(...args)) as FolderDoor["update"];
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "T.md");
    put(
      harness,
      "T.md",
      written.replace("type: core.note", "type: core.bookmark"),
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    put(harness, "T.md", written.replace("as read", "my edit"));
    expect((await harness.folder.scan()).ok).toBe(true);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      pushed.ok && pushed.value.drain.verdicts.map((entry) => entry.verdict),
      "the first save was not refused, so nothing here is held",
    ).toContain("refused");
    expect(
      pushed.ok && pushed.value.pull?.flagged,
      "the file stayed held for a save its person had already replaced",
    ).toEqual([]);
    expect(door!.rows.get(id)?.properties.body).toBe("my edit\n");
    expect(read(harness, "T.md")).toMatch(/^marfa_version: 2$/m);
  });

  describe("a refused change holds its file", () => {
    const refusingStatus = (made: FolderDoor): void => {
      const update = made.update.bind(made);
      made.update = ((...args: Parameters<FolderDoor["update"]>) =>
        (args[1].properties as Record<string, unknown> | undefined)?.status ===
        "bad"
          ? refusal(422, "validation_failed", "status is draft or done")
          : update(...args)) as FolderDoor["update"];
    };
    async function refused(
      label: string,
      tags: string[] = [],
    ): Promise<{ id: string; bad: string; door: FolderDoor }> {
      const id = "01a00000-0000-7000-8000-000000001541";
      harness = await folderHarness(label, {
        rows: {
          "core.note": [
            {
              item: {
                id,
                properties: { title: "T", body: "as read\n", status: "draft" },
              },
              tags,
            },
          ],
        },
      });
      let door: FolderDoor | undefined;
      scriptFolderWrites(harness, {
        door: (made) => {
          door = made;
          refusingStatus(made);
        },
        tagging: (request) =>
          request.method === "POST" && request.body.includes("forbidden")
            ? refusal(422, "validation_failed", "no such tag")
            : undefined,
      });
      expect((await harness.folder.pull()).ok).toBe(true);
      const bad = read(harness, "T.md").replace("status: draft", "status: bad");
      put(harness, "T.md", bad);
      expect((await harness.folder.scan()).ok).toBe(true);
      return { id, bad, door: door! };
    }
    const heldAs = (pushed: Awaited<ReturnType<CliFolder["push"]>>) =>
      pushed.ok
        ? pushed.value.pull?.flagged.map((file) => [file.path, file.flag])
        : [];

    it("through a rename before the drain", async () => {
      const { bad } = await refused("folder-refused-renamed-before");
      renameSync(join(harness!.dir, "T.md"), join(harness!.dir, "Renamed.md"));
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        heldAs(pushed),
        "a rename cut the file off from its refused edit",
      ).toEqual([["Renamed.md", "refused"]]);
      expect(read(harness!, "Renamed.md")).toBe(bad);
    });

    it("through a save that only reformats it before the drain", async () => {
      const { bad } = await refused("folder-refused-reformatted");
      const reformatted = bad.replace("title: T", 'title: "T"');
      put(harness!, "T.md", reformatted);
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        heldAs(pushed),
        "a reformat cut the file off from its refused edit",
      ).toEqual([["T.md", "refused"]]);
      expect(read(harness!, "T.md")).toBe(reformatted);
    });

    it("through a later save that only adds a tag", async () => {
      const { bad } = await refused("folder-refused-then-tag", ["a"]);
      const tagged = bad.replace("  - a\n", "  - a\n  - t\n");
      put(harness!, "T.md", tagged);
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        heldAs(pushed),
        "a tag that landed let go of a refused property it does not touch",
      ).toEqual([["T.md", "refused"]]);
      expect(read(harness!, "T.md")).toBe(tagged);
    });

    it("through a later save that only edits the body, where a tag was refused", async () => {
      const id = "01a00000-0000-7000-8000-000000001542";
      harness = await folderHarness("folder-refused-tag-then-body", {
        rows: {
          "core.note": [
            {
              item: { id, properties: { title: "T", body: "as read\n" } },
              tags: ["a"],
            },
          ],
        },
      });
      scriptFolderWrites(harness, {
        tagging: (request) =>
          request.method === "POST" && request.body.includes("forbidden")
            ? refusal(422, "validation_failed", "no such tag")
            : undefined,
      });
      expect((await harness.folder.pull()).ok).toBe(true);
      const tagged = read(harness, "T.md").replace(
        "  - a\n",
        "  - a\n  - forbidden\n",
      );
      put(harness, "T.md", tagged);
      expect((await harness.folder.scan()).ok).toBe(true);
      const edited = tagged.replace("as read", "second save");
      put(harness, "T.md", edited);
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        heldAs(pushed),
        "a body edit that landed let go of a refused tag it does not touch",
      ).toEqual([["T.md", "refused"]]);
      expect(read(harness, "T.md")).toBe(edited);
    });

    it("through a rename after the refusal", async () => {
      const { bad } = await refused("folder-refused-renamed-after");
      expect(heldAs(await harness!.folder.push())).toEqual([
        ["T.md", "refused"],
      ]);
      renameSync(join(harness!.dir, "T.md"), join(harness!.dir, "Renamed.md"));
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(heldAs(pushed), "a rename let go of the refused edit").toEqual([
        ["Renamed.md", "refused"],
      ]);
      expect(read(harness!, "Renamed.md")).toBe(bad);
    });
  });

  it("sends a mended tag from a file whose edit landed beside the refused one", async () => {
    const id = "01a00000-0000-7000-8000-000000001551";
    harness = await folderHarness("folder-refused-tag-mended", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "as read\n" } },
            tags: ["a"],
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
      tagging: (request) =>
        request.method === "POST" && request.body.includes("forbidden")
          ? refusal(422, "validation_failed", "no such tag")
          : undefined,
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const first = read(harness, "T.md")
      .replace("  - a\n", "  - a\n  - forbidden\n")
      .replace("as read", "edited");
    put(harness, "T.md", first);
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "T.md", first.replace("forbidden", "good"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      door!.rows.get(id)?.tags,
      "the mended tag went unsent, the file read as behind although its body edit landed",
    ).toEqual(["a", "good"]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
    expect(pushed.ok && pushed.value.pull?.flagged).toEqual([]);
  });

  it("sends a save right after its own edit lands as current", async () => {
    const id = "01a00000-0000-7000-8000-000000001561";
    harness = await folderHarness("folder-save-after-landing", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: { title: "T", body: "as read\n", lang: "en" },
            },
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const one = read(harness, "T.md").replace("as read", "one");
    put(harness, "T.md", one);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);
    // Saved again before any pull has written the new line.
    put(harness, "T.md", one.replace("lang: en\n", ""));
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      door!.rows.get(id)?.properties,
      "a line taken out right after the file's own edit landed was not cleared",
    ).toEqual({ title: "T", body: "one\n" });
  });

  it("takes an own-field change after a version step no file shows", async () => {
    const id = "01a00000-0000-7000-8000-000000001571";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-invisible-step", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "as read\n" } },
            tags: ["a"],
          },
        ],
      },
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    // An edit whose values the file already shows: the version moves, and
    // the file is not written again for its line alone (`folders/version-only-pull`).
    edges.logItem(
      "item.updated",
      door!.update(id, { properties: { title: "T" }, version: 1 }),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    const shown = read(harness, "T.md");
    expect(shown).toMatch(/^marfa_version: 1$/m);
    put(harness, "T.md", shown.replace("  - a\n", "  - a\n  - n\n"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTags(harness),
      "the person's tag, in a file only its line kept from current, was flagged behind rather than sent",
    ).toEqual([`add ${id} n`]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
  });

  it("does not re-archive from the buffer of an archive restored elsewhere", async () => {
    const id = "01a00000-0000-7000-8000-000000001581";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-restored-single-buffer", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "T", body: "as read\n" } } },
        ],
      },
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    edges.logItem("item.state_changed", door!.transition(id, "archived"));
    expect((await harness.folder.push()).ok).toBe(true);
    const archived = read(harness, "T.md");
    expect(archived).toMatch(/^state: archived$/m);
    edges.logItem("item.state_changed", door!.transition(id, "active"));
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "T.md", archived.replace("as read", "edit"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTransitions(harness),
      "the one buffer, written while the item was archived, archived it again after a restore elsewhere",
    ).toEqual([]);
    expect(door!.rows.get(id)?.state).toBe("active");
  });

  it("keeps an unreadable file's item when it moves with no identity", async () => {
    const id = "01a00000-0000-7000-8000-0000000014a1";
    harness = await folderHarness("folder-unreadable-no-identity", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Held", body: "as it was\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "Held.md"),
      read(harness, "Held.md").replace("title: Held", "title: [Held"),
    );
    // A hard link leaves both paths with no identity of their own.
    linkSync(join(harness.dir, "Held.md"), join(harness.dir, "Linked.md"));
    renameSync(join(harness.dir, "Held.md"), join(harness.dir, "Moved.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.missing,
      "the moved file lost its item, whose delete is now journaled",
    ).toBe(0);
    expect(scanned.value.flagged.map((file) => file.path).sort()).toEqual([
      "Linked.md",
      "Moved.md",
    ]);
  });

  it("refuses a type no document can be, before sending anything", async () => {
    const id = "01a00000-0000-7000-8000-0000000014b1";
    harness = await folderHarness("folder-type-unsuited", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Typed", body: "text\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const typed = read(harness, "Typed.md").replace(
      "type: core.note",
      "type: user.nothing",
    );
    writeFileSync(join(harness.dir, "Typed.md"), typed);
    put(harness, "Bytes.md", "---\ntype: core.file\n---\nnot bytes\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [sentUpdates(harness).length, sentCreates(harness).length],
      "a type no document can be was sent",
    ).toEqual([0, 0]);
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
    ).toEqual([
      ["Bytes.md", "refused"],
      ["Typed.md", "refused"],
    ]);
    expect(read(harness, "Typed.md")).toBe(typed);
  });

  it("takes a versioned file's missing tags line as no tags, and a lineless file's as no change", async () => {
    const versioned = "01a00000-0000-7000-8000-0000000014c1";
    const lineless = "01a00000-0000-7000-8000-0000000014c2";
    harness = await folderHarness("folder-missing-tags-line", {
      rows: {
        "core.note": [
          {
            item: { id: versioned, properties: { title: "V", body: "v\n" } },
            tags: ["a"],
          },
          {
            item: { id: lineless, properties: { title: "L", body: "l\n" } },
            tags: ["a"],
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "V.md"),
      read(harness, "V.md").replace("tags:\n  - a\n", ""),
    );
    writeFileSync(
      join(harness.dir, "L.md"),
      read(harness, "L.md")
        .replace("tags:\n  - a\n", "")
        .replace(/^marfa_version: \d+\n/m, "")
        .replace("l\n", "edited\n"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      sentTags(harness),
      "a versioned file's tags line taken out left the tag, or a file with no version line took one away",
    ).toEqual([`remove ${versioned} a`]);
  });
});
