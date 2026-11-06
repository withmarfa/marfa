import { afterEach, describe, expect, it } from "vitest";
import { answers, refusal } from "../../device/marfa-answers.js";
import type { FolderDoor } from "../../device/folder-door.js";
import { folderHarness, type FolderHarness } from "./harness.js";
import {
  EdgeDoor,
  edit,
  idIn,
  put,
  read,
  scriptFolderWrites,
  sentEdgeWrites,
} from "./folders.shared.js";

/**
 * A folder takes the writes the server answered out of its queue once it has
 * recorded what it needs from them, so a folder that has sent many edits
 * holds no more than the writes still to be answered and those it keeps.
 */

let harness: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("a folder's answered writes", () => {
  it("clears the writes it recorded as its next drain begins, and keeps a refused edit's words and every refusal it shows", async () => {
    harness = await folderHarness("folder-clears-answered");
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
      tagging: (request) =>
        request.method === "POST"
          ? refusal(400, "validation_error", "Not a tag this server takes")
          : undefined,
    });
    put(harness, "Edited.md", "edited\n");
    put(harness, "Refused.md", "refused\n");
    put(harness, "Tagged.md", "tagged\n");
    const added = await harness.folder.push();
    expect(added.ok, JSON.stringify(added)).toBe(true);
    const refusedId = idIn(harness, "Refused.md");
    const update = door!.update.bind(door!);
    door!.update = ((...args: Parameters<FolderDoor["update"]>) =>
      args[0] === refusedId
        ? refusal(400, "validation_error", "Not words this server takes")
        : update(...args)) as FolderDoor["update"];

    for (let edit = 0; edit < 5; edit += 1) {
      put(harness, "Edited.md", `edited ${edit}\n`);
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    }
    put(harness, "Edited.md", "edited last\n");
    put(harness, "Refused.md", "refused words\n");
    edit(
      harness,
      "Tagged.md",
      "tier: library\n",
      "tier: library\ntags:\n  - refused\n",
    );
    const refused = await harness.folder.push();
    expect(refused.ok, JSON.stringify(refused)).toBe(true);
    const answered = await harness.folder.device().queue();
    expect(answered.ok, JSON.stringify(answered)).toBe(true);
    expect(
      answered.ok &&
        answered.value.filter((write) => write.verdict === "accepted"),
      "the witness: a push's answers stay until the next drain begins",
    ).not.toEqual([]);

    put(harness, "Edited.md", "edited again\n");
    const next = await harness.folder.push();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    const queued = await harness.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    const left = queued.ok ? queued.value : [];
    const editedId = idIn(harness, "Edited.md");
    expect(
      left.map((write) => [write.kind, write.item_id, write.verdict]),
      "only the last push's edit and the refused edit, which carries the person's words, stay",
    ).toEqual([
      ["update_item", refusedId, "refused"],
      ["update_item", editedId, "accepted"],
    ]);

    // A push with nothing to send clears the last push's answer too.
    const quiet = await harness.folder.push();
    expect(quiet.ok, JSON.stringify(quiet)).toBe(true);
    const after = await harness.folder.device().queue();
    expect(
      after.ok &&
        after.value.map((write) => [write.kind, write.item_id, write.verdict]),
    ).toEqual([["update_item", refusedId, "refused"]]);

    const status = await harness.folder.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    const flagged = new Map(
      (status.ok ? status.value.files : []).map((file) => [
        file.path,
        [file.flag, file.reason],
      ]),
    );
    expect(flagged.get("Refused.md")?.[0]).toBe("refused");
    expect(flagged.get("Refused.md")?.[1]).toContain("validation_error");
    expect(flagged.get("Tagged.md")?.[0]).toBe("refused");
    expect(flagged.get("Tagged.md")?.[1]).toContain("validation_error");
  });
});

describe("a folder's refused edge creates", () => {
  /** A folder of two notes, its first naming nothing yet. */
  async function twoNotes(label: string) {
    const edges = new EdgeDoor();
    harness = await folderHarness(label, { events: [edges.stream()] });
    scriptFolderWrites(harness, { edges });
    const made = harness;
    put(made, "Source.md", "source\n");
    put(made, "Target.md", "target\n");
    const added = await made.folder.push();
    expect(added.ok, JSON.stringify(added)).toBe(true);
    const target = idIn(made, "Target.md") ?? "";
    edges.placing = (edge) =>
      edge.edge_type === "about"
        ? answers.edgeCardinality({ target_id: target, edge_type: "about" })
        : undefined;
    return { made, edges, source: idIn(made, "Source.md") ?? "", target };
  }

  async function refused(made: FolderHarness) {
    const queued = await made.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    return (queued.ok ? queued.value : []).filter(
      (write) => write.kind === "create_edge" && write.verdict === "refused",
    );
  }

  async function statusOf(made: FolderHarness, path: string) {
    const status = await made.folder.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    const file = (status.ok ? status.value.files : []).find(
      (entry) => entry.path === path,
    );
    if (file === undefined) throw new Error(`no status for ${path}`);
    return file;
  }

  it("takes out a refused edge create once the server has given the copy its edge, moving nothing else", async () => {
    const { made, edges, source, target } = await twoNotes(
      "folder-refused-edge-satisfied",
    );
    edit(made, "Source.md", /marfa_id:/, `about: "[[${target}]]"\nmarfa_id:`);
    expect((await made.folder.push()).ok).toBe(true);
    expect(await refused(made)).toHaveLength(1);
    expect((await statusOf(made, "Source.md")).flag).toBe("refused");

    // The file stops naming it, so no file shows the refusal.
    edit(made, "Source.md", `about: "[[${target}]]"\n`, "");
    expect((await made.folder.push()).ok).toBe(true);
    expect((await statusOf(made, "Source.md")).flag).toBeUndefined();
    expect((await made.folder.push()).ok).toBe(true);
    expect(
      await refused(made),
      "the witness: it stays while the copy does not hold the edge",
    ).toHaveLength(1);

    // Another machine makes the edge, which the next push reads.
    edges.placing = undefined;
    edges.create({
      id: "01a00000-0000-7000-8000-0000000e0001",
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect((await made.folder.push()).ok).toBe(true);
    const sent = sentEdgeWrites(made);
    const before = await statusOf(made, "Source.md");
    expect(before.status).toBe("in_step");
    const text = read(made, "Source.md");
    const held = await made.folder.device().edgesFrom(source);
    expect(
      held.ok && held.value.filter((edge) => edge.edge_type === "about"),
      "the witness: the copy holds the edge",
    ).toMatchObject([{ target_id: target, version: 1 }]);

    expect(
      await refused(made),
      "the witness: it goes as a drain begins, not as the edge arrives",
    ).toHaveLength(1);

    const quiet = await made.folder.push();
    expect(quiet.ok, JSON.stringify(quiet)).toBe(true);
    expect(await refused(made)).toEqual([]);
    expect(await statusOf(made, "Source.md")).toEqual(before);
    expect(read(made, "Source.md")).toBe(text);
    expect(sentEdgeWrites(made), "it sent no edge write").toEqual(sent);
    const after = await made.folder.device().edgesFrom(source);
    expect(after).toEqual(held);
  });

  it("holds one refused edge create of a line however often its file is saved, and the file keeps its reason", async () => {
    const { made, source, target } = await twoNotes(
      "folder-refused-edge-repeated",
    );
    edit(made, "Source.md", /marfa_id:/, `about: "[[${target}]]"\nmarfa_id:`);
    expect((await made.folder.push()).ok).toBe(true);
    const [first] = await refused(made);
    expect(first).toBeDefined();

    for (const words of ["again", "and again"]) {
      edit(made, "Source.md", /source|again/, words);
      expect((await made.folder.push()).ok).toBe(true);
    }

    expect(
      sentEdgeWrites(made),
      "the witness: each save sent its own create",
    ).toEqual(Array(3).fill(`create ${source} about ${target}`));
    const left = await refused(made);
    expect(left).toHaveLength(1);
    expect(left[0]?.id).not.toBe(first?.id);
    const file = await statusOf(made, "Source.md");
    expect(file.flag).toBe("refused");
    expect(file.reason).toContain("edge_constraint_violation");
  });
});
