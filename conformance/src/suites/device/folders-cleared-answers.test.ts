import { afterEach, describe, expect, it } from "vitest";
import { refusal } from "../../device/marfa-answers.js";
import type { FolderDoor } from "../../device/folder-door.js";
import { folderHarness, type FolderHarness } from "./harness.js";
import { edit, idIn, put, scriptFolderWrites } from "./folders.shared.js";

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
  it("clears the writes it recorded at its next drain, and keeps a refused edit's words and every refusal it shows", async () => {
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
    const before = await harness.folder.device().queue();
    expect(before.ok, JSON.stringify(before)).toBe(true);
    expect(
      before.ok && before.value.filter((write) => write.verdict === "accepted"),
      "the witness: the last push's answers stay until the next drain",
    ).not.toEqual([]);

    const quiet = await harness.folder.push();
    expect(quiet.ok, JSON.stringify(quiet)).toBe(true);
    const after = await harness.folder.device().queue();
    expect(after.ok, JSON.stringify(after)).toBe(true);
    const left = after.ok ? after.value : [];
    expect(
      left.filter((write) => write.verdict !== "refused"),
      "a write the folder recorded stayed in its queue",
    ).toEqual([]);
    expect(
      left.map((write) => [write.kind, write.item_id]),
      "only the refused edit, which carries the person's words, stays",
    ).toEqual([["update_item", refusedId]]);

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
